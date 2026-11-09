// api/factures-voyageur.js — les gestes de l'HÔTE sur la facture d'un voyageur
// (étape 2) : envoyer le lien du formulaire (porte 1, la fiche de réservation),
// et remplir le formulaire à la place du voyageur (Q12).
// Spec : docs/specs/spec-facture-voyageur.md §2, §4 bis, §5.3, §11.1
// KB   : docs/kb/facture-voyageur.md (modif = MEME COMMIT)
//
// POST { action: 'envoyer_lien', booking }
// POST { action: 'saisir', booking, destinataire }
//
// ⚠ LA RÉSERVATION DÉSIGNE LE COMPTE ET LE BIEN (règle 11) : la garde résout
// `booking` dans le cœur ; un `bien` envoyé par le client est ignoré. Une
// réservation d'un autre compte rend 404, hors du périmètre 403 — avant tout
// geste.
//
// ⚠ DEUX DROITS POUR ENVOYER LE LIEN (P1, Thierry, 8 nov. 2026, 22 h 03) :
// `reservations` ET `messages` en écriture, parce que le geste fait partir un
// message au voyageur. Remplir le formulaire à sa place n'envoie rien :
// `reservations` en écriture suffit (Q10).
//
// ⚠ BIEN ARCHIVÉ (P3) : aucune NOUVELLE demande. Une demande déjà en cours va au
// bout — l'hôte peut encore remplir son formulaire — mais aucun lien neuf ne
// part d'un bien archivé.
//
// ⚠ UNE RÉSERVATION ANNULÉE N'EST JAMAIS FACTURÉE (§2.7) : aucun geste.
//
// ⚠ L'ENVOI : le chemin serveur commun (`sendGuestMessage`, lib/cron-messages.js),
// qui route par la SOURCE de la réservation — messagerie du canal, e-mail pour
// une directe. Son issue est notée sur le jeton ; le fil n'affiche le message
// que s'il est LIVRÉ (`recordMessage`). Une réservation sans canal (Offline
// sans e-mail, P5) : rien ne part, et le lien revient à l'hôte pour qu'il le
// transmette lui-même.
//
// ⚠ LES EN-TÊTES PRIVÉS AVANT LE PREMIER REFUS, 405 compris (dette 90).

const { requirePermission, posterEnTetesPrives } = require('../lib/require-permission')
const { peutEcrire } = require('../lib/permissions')
const FV = require('../lib/factures-voyageur')
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const db = () => supabase

function corpsDe (req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body !== 'string' || !req.body) return {}
  try { return JSON.parse(req.body) } catch (e) { return null }
}

const CODES = {
  entree_invalide: 400, introuvable: 404, bien_introuvable: 409, bien_archive: 409,
  reservation_annulee: 409, verrouillee: 409, trop_rapproche: 429, panne: 503
}
function repondreRefus (res, motif, champ = null) {
  return res.status(CODES[motif] || 400).json({ error: motif, motif, champ })
}

// Le bien de la réservation : la garde a résolu la ligne `properties` (id,
// nom, provider) ; l'archivage se lit à part, une requête.
async function lireArchivage (base, bienId) {
  const { data, error } = await base.from('properties').select('archive_le').eq('id', bienId).maybeSingle()
  if (error) return { ok: false }
  return { ok: true, archive: !!(data && data.archive_le) }
}

// La langue du voyageur : le payload brut porte celle du client (l'en-tête de
// la garde ne lit que le snapshot).
async function lireBrut (base, compte, bookingId) {
  const { data, error } = await base.from('bookings_snapshot').select('raw')
    .eq('user_id', compte).eq('booking_id', String(bookingId)).maybeSingle()
  if (error) return { ok: false }
  return { ok: true, raw: data ? data.raw : null }
}

// L'issue d'un envoi, dans le vocabulaire du jeton.
function issueDe (envoi, { CANAL, classerEnvoiOta }) {
  if (envoi && envoi.ok === true) return 'livre'
  if (envoi && envoi.differe === true) return 'differe'
  if (envoi && envoi.canal === CANAL.AUCUN) return 'sans_canal'
  if (envoi && envoi.canal === CANAL.EMAIL) return envoi.permanent ? 'permanent' : 'refus'
  return classerEnvoiOta(envoi)
}

async function envoyerLien (req, res, corps) {
  const t0 = Date.now()
  let requetes = 0
  const garde = await requirePermission(req, res, {
    domaine: 'reservations', niveau: 'write', booking: corps.booking, bookingRequis: true
  })
  if (!garde.ok) return
  const cible = { id: garde.bien ? garde.bien.id : null, ref: garde.booking.property_id }
  if (!peutEcrire(garde.contexte, 'messages', cible)) {
    return res.status(403).json({ error: 'Droits insuffisants', motif: 'droits_messages' })
  }
  if (!garde.bien) return repondreRefus(res, 'bien_introuvable')
  const compte = garde.accountUserId
  const bookingId = String(garde.booking.booking_id)
  const snap = garde.booking.snapshot || {}

  const { estAnnulationVoyageur } = require('../lib/bookings-snapshot-status')
  if (estAnnulationVoyageur(snap, garde.bien.provider)) return repondreRefus(res, 'reservation_annulee')

  const base = db()
  requetes += 2
  const [arch, brut] = await Promise.all([lireArchivage(base, garde.bien.id), lireBrut(base, compte, bookingId)])
  if (!arch.ok || !brut.ok) return repondreRefus(res, 'panne')
  if (arch.archive) return repondreRefus(res, 'bien_archive')

  const langue = FV.langueDeLaReservation({ snapshot: snap, raw: brut.raw })
  requetes++
  const ouvert = await FV.ouvrirLien(compte, {
    propertyUuid: garde.bien.id, bookingId, langue, porte: 'fiche',
    creePar: garde.userId, depart: snap.departure || null
  }, { db: base })
  if (!ouvert.ok) return repondreRefus(res, ouvert.motif, ouvert.champ)

  // ─── L'envoi, par le chemin commun ───
  const { CANAL, MOTIF, canalPour } = require('../lib/canal-voyageur')
  const { classerEnvoiOta } = require('../lib/envoi-ota')
  const { sendGuestMessage } = require('../lib/cron-messages')
  const message = FV.texteDuLien(langue, snap.firstName, ouvert.lien)
  const decision = canalPour({ id: bookingId, ...snap })

  let envoi
  if (decision.motif === MOTIF.PAS_D_EMAIL) {
    // Aucune destination : rien ne part (P5). Le lien revient à l'hôte.
    envoi = { ok: false, canal: CANAL.AUCUN, motif: decision.motif }
  } else {
    let beds24Key = null
    if (garde.bien.provider === 'beds24') {
      requetes++
      const { data: k, error: eK } = await base.from('api_keys').select('api_key').eq('user_id', compte).maybeSingle()
      if (eK) console.error('[factures-voyageur] cle Beds24 illisible', eK.message)
      beds24Key = k ? k.api_key : null
    }
    // ⚠ `sans_canal` PASSE QUAND MÊME, comme dans api/channel-message.js : le
    // normaliseur Channex écrit `source: 'direct'` pour une réservation sans
    // `ota_name`, que le filtre Beds24 classe « sans canal » alors que Channex
    // accepte le message. On passe alors l'IDENTIFIANT nu, que le chemin commun
    // route par le provider — c'est lui l'autorité.
    const reservation = decision.motif === MOTIF.SANS_CANAL ? bookingId : { id: bookingId, ...snap }
    try {
      envoi = await sendGuestMessage(beds24Key, garde.bien, reservation, message,
        { userId: compte, eventType: 'facture_lien' })
    } catch (e) {
      // L'appel a levé : le message est PEUT-ÊTRE parti. Jamais « refus ».
      console.error('[factures-voyageur] envoi en exception', e.message)
      envoi = { ok: false, incertain: true, error: e.message }
    }
  }
  const issue = issueDe(envoi, { CANAL, classerEnvoiOta })
  requetes++
  const note = await FV.noterEnvoi(compte, ouvert.jeton.id, { issue, motif: envoi && (envoi.error || envoi.motif) }, { db: base })
  if (!note.ok) console.error('[factures-voyageur] issue non notée sur le jeton', ouvert.jeton.id)

  if (issue === 'livre') {
    // Le fil de la conversation : seulement ce qui est LIVRÉ (lib/envoi-ota.js).
    const { recordMessage } = require('../lib/record-message')
    requetes++
    await recordMessage({
      userId: compte,
      provider: garde.bien.provider === 'beds24' ? 'beds24' : 'channex',
      propertyId: garde.booking.property_id,
      bookingId,
      direction: 'outbound',
      sender: 'host',
      body: message,
      providerMsgId: null,
      ota: null,
      sentAt: null,
      kind: 'message',
      ...(envoi.canal === CANAL.EMAIL ? { canal: 'email' } : {}),
      origine: 'hote'
    })
  }

  res.setHeader('Server-Timing', `db;desc="${requetes} requêtes";dur=${Date.now() - t0}`)
  return res.status(200).json({
    ok: true,
    demande: { id: ouvert.demande.id, statut: ouvert.demande.statut },
    envoi: issue,
    // Le lien EN CLAIR seulement quand le message n'est pas sûrement arrivé :
    // l'hôte le transmet lui-même (P5) — bouton « Copier ».
    lien: issue === 'livre' ? null : ouvert.lien
  })
}

async function saisir (req, res, corps) {
  const t0 = Date.now()
  let requetes = 0
  const garde = await requirePermission(req, res, {
    domaine: 'reservations', niveau: 'write', booking: corps.booking, bookingRequis: true
  })
  if (!garde.ok) return
  if (!garde.bien) return repondreRefus(res, 'bien_introuvable')
  const v = FV.validerDestinataire(corps.destinataire)
  if (!v.ok) return repondreRefus(res, v.motif, v.champ)
  const compte = garde.accountUserId
  const bookingId = String(garde.booking.booking_id)
  const snap = garde.booking.snapshot || {}

  const { estAnnulationVoyageur } = require('../lib/bookings-snapshot-status')
  if (estAnnulationVoyageur(snap, garde.bien.provider)) return repondreRefus(res, 'reservation_annulee')

  const base = db()
  requetes += 2
  const [arch, active] = await Promise.all([lireArchivage(base, garde.bien.id), FV.demandeActive(compte, bookingId, { db: base })])
  if (!arch.ok || !active.ok) return repondreRefus(res, 'panne')
  // P3 : sur un bien archivé, seulement une demande DÉJÀ en cours.
  if (arch.archive && !active.demande) return repondreRefus(res, 'bien_archive')

  let demande = active.demande
  if (!demande) {
    requetes += 2
    const brut = await lireBrut(base, compte, bookingId)
    if (!brut.ok) return repondreRefus(res, 'panne')
    const ouverte = await FV.ouvrirDemande(compte, {
      propertyUuid: garde.bien.id, bookingId,
      langue: FV.langueDeLaReservation({ snapshot: snap, raw: brut.raw }), creePar: garde.userId
    }, { db: base })
    if (!ouverte.ok) return repondreRefus(res, ouverte.motif)
    demande = ouverte.demande
  }
  requetes++
  const r = await FV.enregistrerDestinataire(compte, demande.id, v.dest,
    { saisiPar: 'hote', saisiParUser: garde.userId }, { db: base })
  if (!r.ok) return repondreRefus(res, r.motif)
  res.setHeader('Server-Timing', `db;desc="${requetes} requêtes";dur=${Date.now() - t0}`)
  return res.status(200).json({
    ok: true,
    demande: { id: demande.id, statut: demande.statut === 'lien_envoye' ? 'formulaire_rempli' : demande.statut }
  })
}

module.exports = async function handler (req, res) {
  posterEnTetesPrives(res)
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Méthode non autorisée' })
  }
  const corps = corpsDe(req)
  if (corps == null) return repondreRefus(res, 'entree_invalide')
  try {
    if (corps.action === 'envoyer_lien') return await envoyerLien(req, res, corps)
    if (corps.action === 'saisir') return await saisir(req, res, corps)
    return repondreRefus(res, 'entree_invalide', 'action')
  } catch (e) {
    console.error('[factures-voyageur] exception', e.message)
    if (!res.headersSent) return res.status(500).json({ error: 'erreur', motif: 'erreur' })
  }
}

module.exports._interne = { issueDe }
