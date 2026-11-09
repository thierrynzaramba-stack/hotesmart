// ═══════════════════════════════════════════════════════════════════════════
// lib/charges.js — LE WRITER UNIQUE DU COMPTE DE CHARGES (lot 2, le socle)
// Spec : docs/specs/spec-compte-de-charges.md §5, §6, §7
//
// ⚠ AUCUN AUTRE CODE N'ÉCRIT `charges`, `charges_ota_supprimees` NI LE BUCKET
// `justificatifs`. L'endpoint (`api/charges.js`) et le cron dédié
// (`api/cron-charges.js`) appellent ces fonctions ; ils ne font pas de
// requête eux-mêmes sur ces tables.
//
// ⚠ LA CLÉ DE SERVICE NE CONNAÎT PAS LA RLS. Le seul cloisonnement entre
// comptes est celui qu'on écrit ici : CHAQUE requête porte `user_id = compte`,
// et toute charge, entité ou bien désigné par l'appelant est RÉSOLU EN BASE
// dans ce compte avant d'être touché (REVIEW.md règle 11).
//
// ⚠ LES TOTAUX NE S'ÉCRIVENT PAS ICI. Le trigger `charges_resume_trg`
// (migration 2026-11-09-compte-de-charges.sql) recalcule la cellule d'avant et
// celle d'après dans la MÊME transaction que l'écriture de la charge : un
// writer qui « oublierait » le résumé ne peut pas exister.
//
// Chaque fonction rend `{ ok: true, ... }` ou `{ ok: false, statut, code }` :
// `statut` est le code HTTP que l'endpoint doit rendre.
// ═══════════════════════════════════════════════════════════════════════════

const crypto = require('node:crypto')
const {
  BUCKET, TYPES, CLES_CATEGORIES, typeReel, centimesSaisis, dateValide,
  siretNormalise, texteCourt, proposerEntite, cleFournisseurNumero,
  jourParis, jourDeLaCharge
} = require('./charges/regles')

const MAX_TENTATIVES = 3
const DUREE_URL_CONSULTATION_S = 60
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const refus = (statut, code) => ({ ok: false, statut, code })
const panne = (code = 'panne') => refus(503, code)

// Les colonnes rendues à l'écran : jamais le chemin du fichier, qui ne sert
// qu'au serveur (l'écran consulte par une URL signée de courte durée).
const RENDU = 'id, statut, motif, origine, entite_juridique_id, bien_id, fournisseur_nom, ' +
  'fournisseur_siret, numero_facture, date_facture, jour, date_repli, montant_ht_cents, ' +
  'montant_tva_cents, montant_ttc_cents, categorie, signal, signal_tranche, groupe_doublon, ' +
  'tentatives_lecture, lecture_ia, cree_le, valide_le, booking_id'

// ─── Les lectures de l'entité (fil facturation) ─────────────────────────────
// ⚠ ELLES VIENNENT DE `lib/entites-juridiques.js`, ÉCRIT PAR LE FIL
// FACTURATION, qui n'est pas encore dans `main` au moment de ce lot : le
// chargement se fait à la demande, et un module absent est une PANNE (503),
// jamais une liste vide — « aucune entité » serait un fait faux.
function lecturesEntites (deps) {
  if (deps && deps.entites) return deps.entites
  try {
    return require('./entites-juridiques')
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') return null
    throw e
  }
}

async function entitesDuCompte (db, compte, deps) {
  const mod = lecturesEntites(deps)
  if (!mod || typeof mod.entitesDuCompte !== 'function') return { ok: false, motif: 'module_absent' }
  const r = await mod.entitesDuCompte(compte, { db })
  return r && r.ok ? r : { ok: false, motif: 'panne' }
}

async function entiteDuBien (db, compte, bienId, deps) {
  const mod = lecturesEntites(deps)
  if (!mod || typeof mod.entiteDuBien !== 'function') return { ok: false, motif: 'module_absent' }
  const r = await mod.entiteDuBien(compte, bienId, { db })
  return r && r.ok ? r : { ok: false, motif: 'panne' }
}

// Le jour de RÉCEPTION, à Paris : le repli quand la date de la facture manque.
// Toujours recalculé depuis `cree_le` — jamais depuis `jour`, qui peut porter
// une date de facture effacée depuis.
const jourDeReception = (c) => jourParis(c && c.cree_le ? new Date(c.cree_le) : new Date())

// ─── Lecture d'une charge DANS le compte ────────────────────────────────────
async function chargeDuCompte (db, compte, id, colonnes = '*') {
  if (!UUID_RE.test(String(id || ''))) return { ok: false, statut: 400, code: 'charge_non_designee' }
  const { data, error } = await db.from('charges').select(colonnes)
    .eq('id', id).eq('user_id', compte).maybeSingle()
  if (error) return panne()
  if (!data) return refus(404, 'charge_introuvable')
  return { ok: true, charge: data }
}

// ─── 1. Ouvrir un envoi : la ligne et l'URL d'envoi signée ──────────────────
/**
 * ⚠ C'EST LE SERVEUR QUI CHOISIT LE CHEMIN, et il l'enregistre AVANT de
 * délivrer l'URL : le navigateur ne renvoie jamais un chemin, il renvoie
 * l'`id` de la charge, résolu en base dans son compte.
 */
async function ouvrirEnvoi (db, { compte, type, octets, origine = 'fichier' }) {
  if (!TYPES[type]) return refus(400, 'type_refuse')
  const taille = Number(octets)
  if (!Number.isInteger(taille) || taille <= 0) return refus(400, 'taille_invalide')
  if (taille > TYPES[type].max) return refus(413, 'trop_gros')
  if (!['photo', 'fichier'].includes(origine)) return refus(400, 'origine_invalide')

  const id = crypto.randomUUID()
  const chemin = `${compte}/${id}`
  const { error } = await db.from('charges').insert({
    id, user_id: compte, statut: 'envoi', origine,
    justificatif_chemin: chemin, justificatif_type: type, justificatif_octets: taille,
    jour: jourParis()
  })
  if (error) return panne()

  const { data, error: eUrl } = await db.storage.from(BUCKET).createSignedUploadUrl(chemin)
  if (eUrl || !data || !data.signedUrl) {
    // Pas d'URL, pas d'envoi possible : la ligne ne sert à rien.
    await db.from('charges').delete().eq('id', id).eq('user_id', compte).eq('statut', 'envoi')
    return panne('stockage')
  }
  return { ok: true, id, url: data.signedUrl, jeton: data.token }
}

// ─── 2. Confirmer un envoi : relire le fichier dans le bucket ───────────────
async function telecharger (db, chemin) {
  const { data, error } = await db.storage.from(BUCKET).download(chemin)
  if (error || !data) return null
  return Buffer.from(await data.arrayBuffer())
}

async function effacerFichier (db, chemin) {
  if (!chemin) return
  try {
    const { error } = await db.storage.from(BUCKET).remove([chemin])
    if (error) console.error('[charges] fichier non efface', error.message)
  } catch (e) { console.error('[charges] fichier non efface', e && e.message) }
}

/**
 * Marque une charge comme doublon possible de la première qui porte la même
 * empreinte ou le même couple fournisseur + numéro (Q14). Jamais un refus.
 * Le groupe est désigné par sa PREMIÈRE charge (`groupe_doublon` vide).
 */
async function regrouperDoublon (db, compte, charge, premiere) {
  if (!premiere || premiere.id === charge.id) return
  const racine = premiere.groupe_doublon || premiere.id
  const { error } = await db.from('charges')
    .update({ groupe_doublon: racine, signal: 'doublon', signal_tranche: false })
    .eq('id', charge.id).eq('user_id', compte)
  if (error) { console.error('[charges] doublon non pose', error.message); return }
  if (!premiere.groupe_doublon && premiere.signal !== 'doublon') {
    await db.from('charges').update({ signal: 'doublon', signal_tranche: false })
      .eq('id', racine).eq('user_id', compte)
  }
}

async function confirmerEnvoi (db, { compte, id }) {
  const lu = await chargeDuCompte(db, compte, id)
  if (!lu.ok) return lu
  const c = lu.charge
  if (c.statut !== 'envoi') return refus(409, 'deja_confirmee')

  const octets = await telecharger(db, c.justificatif_chemin)
  if (!octets) return refus(409, 'fichier_absent')
  const type = typeReel(octets)
  // ⚠ LE TYPE SE LIT DANS LE CONTENU, PAS DANS CE QUE LE NAVIGATEUR ANNONCE.
  if (!type || !TYPES[type] || octets.length > TYPES[type].max) {
    await effacerFichier(db, c.justificatif_chemin)
    await db.from('charges').delete().eq('id', c.id).eq('user_id', compte).eq('statut', 'envoi')
    return refus(415, !type ? 'type_refuse' : 'trop_gros')
  }
  const empreinte = crypto.createHash('sha256').update(octets).digest('hex')

  const { data: maj, error } = await db.from('charges').update({
    statut: 'a_lire', justificatif_type: type, justificatif_octets: octets.length,
    justificatif_empreinte: empreinte
  }).eq('id', c.id).eq('user_id', compte).eq('statut', 'envoi').select(RENDU).maybeSingle()
  if (error) return panne()
  if (!maj) return refus(409, 'deja_confirmee')

  const { data: memes } = await db.from('charges').select('id, groupe_doublon, signal')
    .eq('user_id', compte).eq('justificatif_empreinte', empreinte)
    .neq('id', c.id).neq('statut', 'envoi').order('cree_le', { ascending: true }).limit(1)
  if (memes && memes[0]) await regrouperDoublon(db, compte, maj, memes[0])

  return { ok: true, charge: maj, octets, type }
}

// ─── 3. Appliquer une lecture IA ────────────────────────────────────────────
/**
 * `resultat` : ce que rend `lireDocument`. Une PANNE ne compte pas ; un
 * ÉCHEC compte, et au troisième la charge passe `illisible` et n'est plus
 * relue — jamais une lecture facturée toutes les cinq minutes.
 */
async function appliquerLecture (db, { compte, id, resultat }, deps = {}) {
  if (!resultat || resultat.panne) return { ok: true, issue: 'panne' }
  const lu = await chargeDuCompte(db, compte, id, 'id, statut, tentatives_lecture, cree_le, groupe_doublon, signal')
  if (!lu.ok) return lu
  const c = lu.charge
  if (c.statut !== 'a_lire') return refus(409, 'pas_a_lire')

  if (!resultat.ok) {
    const tentatives = (c.tentatives_lecture || 0) + 1
    const champs = tentatives >= MAX_TENTATIVES
      ? { tentatives_lecture: tentatives, statut: 'illisible', motif: 'lecture_impossible' }
      : { tentatives_lecture: tentatives }
    const { error } = await db.from('charges').update(champs)
      .eq('id', c.id).eq('user_id', compte).eq('statut', 'a_lire')
    if (error) return panne()
    return { ok: true, issue: champs.statut || 'a_relire', tentatives }
  }

  const l = resultat.lu
  // L'entité PROPOSÉE (Q6) : rapprochée par le code, jamais choisie par l'IA.
  // Une entité illisible (panne, module absent) laisse le champ vide : la
  // proposition est un confort, la validation la redemandera.
  const ent = await entitesDuCompte(db, compte, deps)
  const entite = ent.ok ? proposerEntite(ent.entites, l) : null
  const { jour, date_repli } = jourDeLaCharge(l.date_facture, jourDeReception(c))
  const champs = {
    statut: 'a_verifier', motif: null,
    fournisseur_nom: l.fournisseur_nom, fournisseur_siret: l.fournisseur_siret,
    numero_facture: l.numero_facture, date_facture: l.date_facture,
    montant_ht_cents: l.montant_ht_cents, montant_tva_cents: l.montant_tva_cents,
    montant_ttc_cents: l.montant_ttc_cents, categorie: l.categorie,
    entite_juridique_id: entite, jour, date_repli,
    // ⚠ JAMAIS ÉCRASÉ PAR LA SAISIE : l'écart lu / validé mesure la précision.
    lecture_ia: { ...l, modele: resultat.modele || null, lu_le: new Date().toISOString() }
  }
  const { data, error } = await db.from('charges').update(champs)
    .eq('id', c.id).eq('user_id', compte).eq('statut', 'a_lire').select(RENDU).maybeSingle()
  if (error) return panne()
  if (!data) return refus(409, 'pas_a_lire')
  await signalerDoublonFournisseur(db, compte, data)
  return { ok: true, issue: 'a_verifier', charge: data }
}

async function signalerDoublonFournisseur (db, compte, charge) {
  if (charge.groupe_doublon || cleFournisseurNumero(charge) === null) return
  const { data } = await db.from('charges')
    .select('id, groupe_doublon, signal, fournisseur_nom, fournisseur_siret, numero_facture')
    .eq('user_id', compte).eq('numero_facture', charge.numero_facture)
    .neq('id', charge.id).not('statut', 'in', '(envoi,annulee,sans_facture)')
    .order('cree_le', { ascending: true }).limit(20)
  const cle = cleFournisseurNumero(charge)
  const premiere = (data || []).find(x => cleFournisseurNumero(x) === cle)
  if (premiere) await regrouperDoublon(db, compte, charge, premiere)
}

// ─── 4. Valider (ou corriger) une charge ────────────────────────────────────
/**
 * Les champs saisis par l'hôte. ⚠ L'ENTITÉ EST OBLIGATOIRE (D3, Q20) et doit
 * être une entité ACTIVE du compte ; le bien est facultatif (Q1) mais doit
 * relever de cette entité (Q18). Une commission de plateforme ne se modifie
 * pas à la main : elle se supprime (§7 bis).
 */
async function valider (db, { compte, valideur, id, champs }, deps = {}) {
  const lu = await chargeDuCompte(db, compte, id, 'id, statut, origine, cree_le, groupe_doublon')
  if (!lu.ok) return lu
  const c = lu.charge
  if (c.origine === 'ota') return refus(409, 'commission_automatique')
  if (!['a_verifier', 'validee', 'illisible'].includes(c.statut)) return refus(409, 'statut_non_validable')

  const s = champs || {}
  const categorie = String(s.categorie || '')
  if (!CLES_CATEGORIES.has(categorie)) return refus(400, 'categorie_invalide')
  const montants = {}
  for (const k of ['montant_ht_cents', 'montant_tva_cents', 'montant_ttc_cents']) {
    const v = centimesSaisis(s[k])
    if (v === undefined) return refus(400, 'montant_invalide')
    montants[k] = v
  }
  const dateFacture = s.date_facture == null || s.date_facture === '' ? null : dateValide(s.date_facture)
  if (s.date_facture && !dateFacture) return refus(400, 'date_invalide')
  const siret = s.fournisseur_siret == null || s.fournisseur_siret === '' ? null : siretNormalise(s.fournisseur_siret)
  if (s.fournisseur_siret && !siret) return refus(400, 'siret_invalide')

  // ── L'entité : une entité ACTIVE de CE compte ─────────────────────────────
  const entiteId = String(s.entite_juridique_id || '')
  if (!entiteId) return refus(409, 'entite_requise')
  const ent = await entitesDuCompte(db, compte, deps)
  if (!ent.ok) return panne(ent.motif === 'module_absent' ? 'entites_indisponibles' : 'panne')
  const entite = (ent.entites || []).find(e => String(e.id) === entiteId)
  if (!entite) return refus(403, 'entite_hors_compte')
  if (entite.archivee_le) return refus(409, 'entite_archivee')

  // ── Le bien : du compte, ET de cette entité (Q18) ─────────────────────────
  const bienId = s.bien_id == null || s.bien_id === '' ? null : String(s.bien_id)
  if (bienId) {
    if (!UUID_RE.test(bienId)) return refus(400, 'bien_invalide')
    const { data: bien, error: eB } = await db.from('properties').select('id')
      .eq('id', bienId).eq('user_id', compte).maybeSingle()
    if (eB) return panne()
    if (!bien) return refus(403, 'bien_hors_compte')
    const eb = await entiteDuBien(db, compte, bienId, deps)
    if (!eb.ok) return panne(eb.motif === 'module_absent' ? 'entites_indisponibles' : 'panne')
    // ⚠ DEPUIS D2 BIS, UN LOGEMENT SANS LIEN N'A PAS D'ENTITÉ — et ne relève
    // donc pas de celle choisie : « rattachez d'abord ce logement ».
    if (!eb.entite) return refus(409, 'bien_sans_entite')
    if (String(eb.entite.id) !== entiteId) return refus(409, 'bien_hors_entite')
  }

  const { jour, date_repli } = jourDeLaCharge(dateFacture, jourDeReception(c))
  const maj = {
    statut: 'validee', motif: null,
    fournisseur_nom: texteCourt(s.fournisseur_nom, 200), fournisseur_siret: siret,
    numero_facture: texteCourt(s.numero_facture, 100), date_facture: dateFacture,
    ...montants, categorie, entite_juridique_id: entiteId, bien_id: bienId,
    jour, date_repli, valide_le: new Date().toISOString(), valide_par: valideur
  }
  const { data, error } = await db.from('charges').update(maj)
    .eq('id', c.id).eq('user_id', compte).in('statut', ['a_verifier', 'validee', 'illisible'])
    .select(RENDU).maybeSingle()
  if (error) return panne()
  if (!data) return refus(409, 'statut_non_validable')
  await signalerDoublonFournisseur(db, compte, data)
  return { ok: true, charge: data }
}

// ─── 5. Trancher un signal « Vérifier » ─────────────────────────────────────
/**
 * L'hôte garde. Pour un groupe de doublons, c'est TOUT le groupe qui est
 * tranché (la première et les autres) : sinon la première compterait seule
 * et la seconde resterait « à trancher » pour toujours.
 */
async function trancher (db, { compte, id }) {
  const lu = await chargeDuCompte(db, compte, id, 'id, signal, groupe_doublon')
  if (!lu.ok) return lu
  const c = lu.charge
  if (!c.signal) return refus(409, 'aucun_signal')
  if (c.signal === 'doublon') {
    const racine = c.groupe_doublon || c.id
    const a = await db.from('charges').update({ signal_tranche: true })
      .eq('user_id', compte).eq('groupe_doublon', racine)
    const b = await db.from('charges').update({ signal_tranche: true })
      .eq('user_id', compte).eq('id', racine)
    if (a.error || b.error) return panne()
    return { ok: true, groupe: racine }
  }
  const { error } = await db.from('charges').update({ signal_tranche: true })
    .eq('user_id', compte).eq('id', c.id)
  if (error) return panne()
  return { ok: true }
}

// ─── 6. Supprimer (Q11 : à tout moment, justificatif compris) ───────────────
/**
 * ⚠ L'ORDRE COMPTE. Pour une commission de plateforme, la trace de
 * suppression est écrite AVANT la ligne effacée : dans l'ordre inverse, une
 * panne entre les deux laisserait la matérialisation quotidienne la recréer.
 * Le fichier part en dernier : un fichier orphelin se voit et se rattrape,
 * une ligne sans fichier ment.
 */
async function supprimer (db, { compte, id }) {
  const lu = await chargeDuCompte(db, compte, id, 'id, origine, booking_id, justificatif_chemin')
  if (!lu.ok) return lu
  const c = lu.charge
  if (c.origine === 'ota' && c.booking_id) {
    const { error } = await db.from('charges_ota_supprimees')
      .upsert({ user_id: compte, booking_id: String(c.booking_id) }, { onConflict: 'user_id,booking_id' })
    if (error) return panne()
  }
  const { data, error } = await db.from('charges').delete()
    .eq('id', c.id).eq('user_id', compte).select('id')
  if (error) return panne()
  if (!data || !data.length) return refus(404, 'charge_introuvable')
  await effacerFichier(db, c.justificatif_chemin)
  return { ok: true, supprime: c.id }
}

// ─── 7. Consulter le justificatif ───────────────────────────────────────────
async function urlConsultation (db, { compte, id }) {
  const lu = await chargeDuCompte(db, compte, id, 'id, statut, justificatif_chemin')
  if (!lu.ok) return lu
  const c = lu.charge
  if (!c.justificatif_chemin || c.statut === 'envoi') return refus(404, 'sans_justificatif')
  const { data, error } = await db.storage.from(BUCKET)
    .createSignedUrl(c.justificatif_chemin, DUREE_URL_CONSULTATION_S)
  if (error || !data || !data.signedUrl) return panne('stockage')
  return { ok: true, url: data.signedUrl, expire_dans_s: DUREE_URL_CONSULTATION_S }
}

// ─── 8. Le cron dédié ───────────────────────────────────────────────────────
/**
 * Seule exception à « on garde tout » (Q12, acceptée par Thierry le
 * 9 novembre 2026) : un ENVOI jamais confirmé — un fichier qui n'est pas une
 * charge — est effacé avec sa ligne après 24 h. Borné, idempotent.
 */
async function purgerEnvois (db, { maintenant = Date.now(), limite = 100 } = {}) {
  const avant = new Date(maintenant - 24 * 3600 * 1000).toISOString()
  const { data, error } = await db.from('charges').select('id, user_id, justificatif_chemin')
    .eq('statut', 'envoi').lt('cree_le', avant).order('cree_le', { ascending: true }).limit(limite)
  if (error) return { ok: false, purges: 0 }
  let purges = 0
  for (const c of data || []) {
    const { data: del, error: e } = await db.from('charges').delete()
      .eq('id', c.id).eq('user_id', c.user_id).eq('statut', 'envoi').select('id')
    if (e || !del || !del.length) continue
    await effacerFichier(db, c.justificatif_chemin)
    purges++
  }
  return { ok: true, purges }
}

/**
 * Les lectures en attente (`a_lire`) : les envois e-mail (lot 5) et les
 * lectures interrompues par une panne. Bornées par `echeance` ; une PANNE du
 * fournisseur d'IA ARRÊTE la passe sans rien compter.
 */
async function lireEnAttente (db, { lire, echeance, limite = 10 }, deps = {}) {
  const { data, error } = await db.from('charges')
    .select('id, user_id, justificatif_chemin, justificatif_type')
    .eq('statut', 'a_lire').order('cree_le', { ascending: true }).limit(limite)
  if (error) return { ok: false, lues: 0 }
  let lues = 0
  let pannes = 0
  for (const c of data || []) {
    if (Date.now() > echeance) break
    const octets = await telecharger(db, c.justificatif_chemin)
    const type = octets ? typeReel(octets) : null
    const resultat = octets && type
      ? await lire({ octets, type, compte: c.user_id })
      : { echec: true, motif: 'fichier_absent' }
    if (resultat && resultat.panne) { pannes++; break }
    await appliquerLecture(db, { compte: c.user_id, id: c.id, resultat }, deps)
    lues++
  }
  return { ok: true, lues, panne: pannes > 0 }
}

module.exports = {
  ouvrirEnvoi, confirmerEnvoi, appliquerLecture, valider, trancher, supprimer,
  urlConsultation, purgerEnvois, lireEnAttente,
  MAX_TENTATIVES, RENDU
}
