// ═══════════════════════════════════════════════════════════════════════════
// /api/ecran/connaissance — L'ÉCRAN DE LA BASE DE CONNAISSANCE (lot 3)
// Spec : docs/specs/spec-base-connaissance-v5.md
//
// ⚠ UN ÉCRAN = UN ENDPOINT (règle de performance de CLAUDE.md). Le volet de
// l'ordinateur et la page du téléphone sont le MÊME écran : ils appellent ce
// GET, une fois, et il rend tout — la liste des biens, les faits, les réponses
// prêtes, l'aperçu rempli pour un vrai voyageur. La page remplacée, elle,
// lisait Supabase depuis le navigateur, et la liste des biens passait par
// `/api/channel-property`, qui interroge le provider en direct.
//
// ⚠ ET L'ÉCRITURE NE PASSE PLUS PAR UN `delete` DE TOUT LE BIEN.
// `apps/agent-ai/knowledge.html` supprimait toutes les lignes du bien puis les
// réinsérait : `created_at` était perdu à chaque enregistrement, une panne
// entre les deux vidait la base du bien, et `verifie_le` — l'objet même de ce
// lot — n'aurait pas survécu à une sauvegarde. On écrit LIGNE À LIGNE :
//   · une RÉPONSE PRÊTE se modifie PAR SON `id`. Un `upsert` sur le sujet,
//     comme le faisait la première version de ce fichier, créait une seconde
//     ligne dès que l'hôte corrigeait le sujet — et écrasait en silence une
//     autre réponse qui portait déjà le sujet tapé ;
//   · un FAIT (« Infos du logement ») est identifié par sa clé : là, l'`upsert`
//     sur `user_id, property_id, type, key` est la bonne identité. Un fait
//     vidé est SUPPRIMÉ, comme le faisait la page remplacée (elle n'écrivait
//     jamais une valeur vide) : dix lecteurs lisent `knowledge`, et aucun ne
//     s'attend à une ligne `fixed` sans valeur.
//
// ⚠ TOUT L'ÉCRAN EST RÉSERVÉ AU TITULAIRE DU COMPTE, LECTURE COMPRISE. C'est
// le comportement de la page remplacée (non délégable, domaine `reglages` —
// tests/pages-non-delegables.test.js) et celui du tiroir de Messages qui
// l'accueille (dette 68). La base porte des mots de passe wifi et des codes
// d'immeuble : l'ouvrir à un membre délégué est une décision de droits, pas un
// effet de bord d'une refonte. La première version de ce fichier l'ouvrait en
// lecture aux membres ; ce n'était écrit dans aucune décision de Thierry.
// ═══════════════════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js')
const { contexteDEcran } = require('../../lib/require-permission')
const { estTitulaireDuCompte } = require('../../lib/permissions')
const { colonneAbsente } = require('../../lib/colonne-absente')
const { carte, faits } = require('../../lib/connaissance')
const { BALISES, etiquetteDe, remplacerBalises } = require('../../lib/balises')
const { isActiveStatus } = require('../../lib/bookings-snapshot-status')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// ⚠ PostgREST TRONQUE À 1000 LIGNES SANS ERREUR. `knowledge` dépassera ce seuil
// à quelques dizaines de biens : toute lecture se pagine par CURSEUR sur `id`.
const PAGE = 200
const COLONNES = 'id, type, key, value, created_at, verifie_le, lisible_par_ia'
const COLONNES_SANS_MIGRATION = 'id, type, key, value, created_at'
const RENDU = 'id, type, key, value, verifie_le, lisible_par_ia'

// Des bornes de taille, parce que ce texte part ensuite dans le contexte de
// l'IA à chaque message : une réponse de 50 Ko se paierait à chaque appel.
const MAX_SUJET = 200
const MAX_TEXTE = 4000
const MAX_FAIT = 1000
const MAX_CLE = 60

// Le jour à Paris, en AAAA-MM-JJ : le « voyageur suivant » d'un bien se lit
// sur le calendrier de l'hôte, pas sur celui du serveur (Vercel est en UTC).
const JOUR_PARIS = new Intl.DateTimeFormat('fr-CA',
  { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' })
const jourParis = (d = new Date()) => JOUR_PARIS.format(d)

async function lireEntrees (compte, ref, compteur, colonnes) {
  const acc = []
  let apres = null
  for (;;) {
    let q = supabase.from('knowledge').select(colonnes)
      .eq('user_id', compte).eq('property_id', String(ref))
      .order('id').limit(PAGE)
    if (apres != null) q = q.gt('id', apres)
    const { data, error } = await q
    compteur.n++
    if (error) return { erreur: error }
    acc.push(...(data || []))
    if (!data || data.length < PAGE) return { lignes: acc }
    apres = data[data.length - 1].id
  }
}

// ⚠ LA MIGRATION PEUT NE PAS ÊTRE PASSÉE, et l'écran doit alors marcher SANS
// les deux colonnes neuves plutôt que de refuser : c'est ce qui permet de
// déployer le code avant de coller le SQL en production.
async function entreesDuBien (compte, ref, compteur) {
  const r = await lireEntrees(compte, ref, compteur, COLONNES)
  if (!r.erreur) return { lignes: r.lignes, migration: true }
  if (!colonneAbsente(r.erreur)) throw new Error(r.erreur.message)
  const r2 = await lireEntrees(compte, ref, compteur, COLONNES_SANS_MIGRATION)
  if (r2.erreur) throw new Error(r2.erreur.message)
  return { lignes: r2.lignes, migration: false }
}

const versVoyageur = (ligne) => {
  const s = (ligne && ligne.snapshot) || {}
  return {
    resa: String(ligne.booking_id),
    prenom: s.firstName || '', nom: s.lastName || '',
    arrivee: s.arrival || null, depart: s.departure || null
  }
}

/**
 * Le voyageur de l'APERÇU : « rempli avec le vrai voyageur » (spec §3.3).
 * Celui du fil ouvert s'il est désigné et qu'il séjourne bien dans CE bien ;
 * sinon le prochain séjour actif du bien. Une panne de lecture rend `null` —
 * l'aperçu se fait alors sans voyageur, l'écran ne tombe pas pour un confort.
 * ⚠ ON NE REND QUE LE NOM ET LES DATES : le snapshot porte aussi l'e-mail et
 * le téléphone du voyageur, dont l'aperçu n'a aucun besoin.
 */
async function voyageurDuBien (compte, ref, resa, compteur) {
  const champs = 'booking_id, snapshot'
  if (resa) {
    const { data, error } = await supabase.from('bookings_snapshot').select(champs)
      .eq('user_id', compte).eq('property_id', String(ref)).eq('booking_id', String(resa))
      .limit(1)
    compteur.n++
    if (!error && data && data[0]) return versVoyageur(data[0])
  }
  const { data, error } = await supabase.from('bookings_snapshot').select(champs)
    .eq('user_id', compte).eq('property_id', String(ref))
    .gte('snapshot->>departure', jourParis())
    .order('snapshot->>arrival', { ascending: true })
    .limit(20)
  compteur.n++
  if (error) return null
  const actif = (data || []).find(x => isActiveStatus(x.snapshot || {}, (x.snapshot || {}).provider))
  return actif ? versVoyageur(actif) : null
}

// L'aperçu passe par LE remplaceur du dépôt (`lib/balises.js`), jamais par une
// copie : c'est l'objet du lot 1, et un aperçu calculé autrement mentirait sur
// ce que le voyageur recevra.
function apercu (texte, connaissance, voyageur, bien) {
  const v = voyageur || {}
  const r = remplacerBalises(texte, {
    reservation: { prenom: v.prenom, nom: v.nom, arrivee: v.arrivee, depart: v.depart, logement: bien.name },
    connaissance
  })
  return { texte: r.texte, manquants: r.manquants, codeNonResolu: r.codeNonResolu === true }
}

const faitsEnObjet = (lignes) => Object.fromEntries(
  (lignes || []).filter(l => l.type === 'fixed').map(l => [l.key, l.value]))

const voyageurPublic = (v) => (v ? { resa: v.resa, prenom: v.prenom, arrivee: v.arrivee } : null)

module.exports = async (req, res) => {
  const t0 = Date.now()
  const compteur = { n: 0 }
  const timing = () => res.setHeader('Server-Timing', `db;desc="${compteur.n} requêtes";dur=${Date.now() - t0}`)
  // L'en-tête privé est posé par la garde, AVANT tout refus — y compris le
  // refus de méthode (dette 90).
  const garde = await contexteDEcran(req, res)
  if (!garde.ok) return
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ error: 'Méthode non autorisée' })
  }
  const { accountUserId, contexte } = garde
  // ⚠ AVANT TOUTE LECTURE : un 403 posé après la lecture a déjà sorti les
  // données de la base.
  if (!estTitulaireDuCompte(contexte)) {
    return res.status(403).json({ error: 'Réservé au titulaire du compte' })
  }

  try {
    // ─── Les biens du compte, archivés exclus ───────────────────────────
    // ⚠ UN BIEN ARCHIVÉ N'APPARAÎT NULLE PART (règle de Thierry, 3 novembre
    // 2026) — et on ne règle pas les réponses d'un logement qui ne loue plus.
    const { data: tousLesBiens, error: eB } = await supabase.from('properties')
      .select('id, name, provider_property_id, photo_url')
      .eq('user_id', accountUserId).is('archive_le', null).order('name')
    compteur.n++
    if (eB) throw new Error(eB.message)
    const biens = (tousLesBiens || []).filter(p => p.provider_property_id)

    const corps = req.body || {}
    const demande = String((req.method === 'POST' ? corps.bien : req.query && req.query.bien) || '').trim()

    // ─── POST : enregistrer, supprimer, ou prévisualiser UNE entrée ─────
    if (req.method === 'POST') {
      // ⚠ LE BIEN EST OBLIGATOIRE EN ÉCRITURE. Retomber sur le premier bien du
      // compte, comme le fait la lecture, écrirait la réponse d'un logement
      // dans un AUTRE, sans un mot.
      if (!demande) return res.status(400).json({ error: 'Logement non désigné' })
      const choisi = biens.find(p => String(p.provider_property_id) === demande)
      if (!choisi) return res.status(403).json({ error: 'Logement hors de votre compte' })
      const ref = String(choisi.provider_property_id)
      const { action } = corps

      if (action === 'apercu') {
        const texte = String(corps.texte == null ? '' : corps.texte)
        if (texte.length > MAX_TEXTE) return res.status(400).json({ error: 'Texte trop long' })
        const [lu, voyageur] = await Promise.all([
          supabase.from('knowledge').select('key, value')
            .eq('user_id', accountUserId).eq('property_id', ref).eq('type', 'fixed')
            .then(r => { compteur.n++; return r }),
          voyageurDuBien(accountUserId, ref, corps.resa, compteur)
        ])
        if (lu.error) return res.status(500).json({ error: 'Lecture impossible' })
        const a = apercu(texte, faitsEnObjet((lu.data || []).map(l => ({ ...l, type: 'fixed' }))), voyageur, choisi)
        timing()
        return res.status(200).json({ ok: true, apercu: a, voyageur: voyageurPublic(voyageur) })
      }

      if (action === 'supprimer') {
        const id = corps.id
        if (id == null || id === '') return res.status(400).json({ error: 'Entrée non désignée' })
        const { data, error } = await supabase.from('knowledge').delete()
          .eq('id', id).eq('user_id', accountUserId).eq('property_id', ref)
          .select('id')
        compteur.n++
        if (error) return res.status(500).json({ error: 'Suppression impossible' })
        if (!data || !data.length) return res.status(404).json({ error: 'Entrée introuvable' })
        timing()
        return res.status(200).json({ ok: true, supprime: id })
      }

      if (action !== 'enregistrer') return res.status(400).json({ error: 'Action inconnue' })

      const lisible = corps.lisible_par_ia
      // ⚠ `verifie_le` EST POSÉE ICI, ET SEULEMENT ICI : c'est le geste de
      // l'hôte qui la pose. Une date posée par le système dirait « vérifié » de
      // ce que personne n'a relu — et le badge « À revoir » ne vaudrait rien.
      const maintenant = new Date().toISOString()
      const repondreErreur = (error) => {
        // ⚠ UNE ÉCRITURE NE REND PAS LA MÊME ERREUR QU'UNE LECTURE — constat de
        // review. Un `select` sur une colonne absente rend 42703 (Postgres) ;
        // un `insert`, `update` ou `upsert` qui la NOMME rend `PGRST204`
        // (« Could not find the '…' column … in the schema cache ») : PostgREST
        // refuse avant d'aller en base. Ne reconnaître que 42703 laissait
        // l'hôte devant un « Enregistrement impossible » au lieu du 503 qui dit
        // la vraie cause. Même lecture que `api/sms.js`.
        if (colonneAbsente(error) || /PGRST204|schema cache/i.test(`${error.code || ''} ${error.message || ''}`)) {
          return res.status(503).json({ error: 'migration_absente', message: 'Migration 2026-11-04-connaissance-v5 non appliquée' })
        }
        // 23505 : la contrainte d'unicité `user_id, property_id, type, key`.
        if (String(error.code || '') === '23505') {
          return res.status(409).json({ error: 'sujet_existe', message: 'Une réponse porte déjà ce sujet' })
        }
        console.error('[ecran/connaissance] ecriture', error.message)
        return res.status(500).json({ error: 'Enregistrement impossible' })
      }

      if (corps.type === 'fixed') {
        const cle = String(corps.key || '').trim()
        if (!cle || cle.length > MAX_CLE) return res.status(400).json({ error: 'Information non désignée' })
        const valeur = String(corps.value == null ? '' : corps.value).trim()
        if (valeur.length > MAX_FAIT) return res.status(400).json({ error: 'Valeur trop longue' })
        if (!valeur) {
          const { error } = await supabase.from('knowledge').delete()
            .eq('user_id', accountUserId).eq('property_id', ref).eq('type', 'fixed').eq('key', cle)
          compteur.n++
          if (error) return repondreErreur(error)
          timing()
          return res.status(200).json({ ok: true, vide: cle })
        }
        const ligne = { user_id: accountUserId, property_id: ref, type: 'fixed', key: cle, value: valeur, verifie_le: maintenant }
        if (lisible === true || lisible === false) ligne.lisible_par_ia = lisible
        const { data, error } = await supabase.from('knowledge')
          .upsert(ligne, { onConflict: 'user_id,property_id,type,key' })
          .select(RENDU).maybeSingle()
        compteur.n++
        if (error) return repondreErreur(error)
        timing()
        return res.status(200).json({ ok: true, entree: data })
      }

      // Une réponse prête.
      const sujet = String(corps.key || '').trim()
      if (!sujet) return res.status(400).json({ error: 'Le sujet est obligatoire' })
      if (sujet.length > MAX_SUJET) return res.status(400).json({ error: 'Sujet trop long' })
      const texte = String(corps.value == null ? '' : corps.value)
      if (!texte.trim()) return res.status(400).json({ error: 'Le message est vide' })
      if (texte.length > MAX_TEXTE) return res.status(400).json({ error: 'Message trop long' })
      const champs = { key: sujet, value: texte, verifie_le: maintenant }
      if (lisible === true || lisible === false) champs.lisible_par_ia = lisible

      if (corps.id != null && corps.id !== '') {
        const { data, error } = await supabase.from('knowledge').update(champs)
          .eq('id', corps.id).eq('user_id', accountUserId).eq('property_id', ref).eq('type', 'faq')
          .select(RENDU).maybeSingle()
        compteur.n++
        if (error) return repondreErreur(error)
        if (!data) return res.status(404).json({ error: 'Entrée introuvable' })
        timing()
        return res.status(200).json({ ok: true, entree: data })
      }
      const { data, error } = await supabase.from('knowledge')
        .insert({ user_id: accountUserId, property_id: ref, type: 'faq', ...champs })
        .select(RENDU).maybeSingle()
      compteur.n++
      if (error) return repondreErreur(error)
      timing()
      return res.status(200).json({ ok: true, entree: data })
    }

    // ─── GET : tout l'écran, en une fois ─────────────────────────────────
    const balises = Object.keys(BALISES).map(cle => ({
      cle, libelle: etiquetteDe(cle), origine: BALISES[cle].origine, marqueur: BALISES[cle].marqueur || null
    }))
    if (!biens.length) {
      timing()
      return res.status(200).json({ migration: true, biens: [], bien: null, faits: [], reponses: [], balises, voyageur: null })
    }
    const choisi = biens.find(p => String(p.provider_property_id) === demande) || biens[0]
    const ref = String(choisi.provider_property_id)

    // Les deux lectures sont INDÉPENDANTES : en parallèle (règle 1).
    const [{ lignes, migration }, voyageur] = await Promise.all([
      entreesDuBien(accountUserId, ref, compteur),
      voyageurDuBien(accountUserId, ref, req.query && req.query.resa, compteur)
    ])

    const connaissance = faitsEnObjet(lignes)
    const maintenant = Date.now()
    const reponses = lignes.filter(l => l.type !== 'fixed')
      .map(l => ({ ...carte(l, { connaissance, maintenant }), apercu: apercu(l.value, connaissance, voyageur, choisi).texte }))
      .sort((a, b) => a.sujet.localeCompare(b.sujet, 'fr'))

    timing()
    return res.status(200).json({
      migration,
      biens: biens.map(p => ({ ref: String(p.provider_property_id), nom: p.name, photo: p.photo_url || null })),
      bien: { ref, nom: choisi.name, photo: choisi.photo_url || null },
      faits: faits(lignes, { maintenant }),
      reponses,
      // ⚠ LES BALISES INSÉRABLES VIENNENT DU MODULE, JAMAIS RECOPIÉES DANS LA
      // PAGE : le jour où une balise change de libellé, elle change partout.
      balises,
      voyageur: voyageurPublic(voyageur)
    })
  } catch (e) {
    console.error('[ecran/connaissance]', e.message)
    return res.status(500).json({ error: 'Lecture impossible' })
  }
}

// Exposés pour les tests : ils appellent la règle au lieu de la recopier.
module.exports.jourParis = jourParis
