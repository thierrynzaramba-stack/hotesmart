// ═══════════════════════════════════════════════════════════════════════════
// HôteSmart — Cron DÉDIÉ au compte de charges (lot 2, le socle)
// Spec : docs/specs/spec-compte-de-charges.md §6, §7, §11 point 2
// ═══════════════════════════════════════════════════════════════════════════
//
// Toutes les 5 minutes, trois tâches, bornées et indépendantes :
//   1. effacer les ENVOIS jamais confirmés depuis plus de 24 h — la seule
//      exception à « on garde tout » (Q12, acceptée le 9 novembre 2026) ;
//   2. lire les charges `a_lire` (lectures interrompues par une panne, et
//      demain les pièces jointes reçues par e-mail, lot 5) ;
//   3. UNE FOIS PAR JOUR (le passage de 3 h à Paris), recalculer le résumé
//      des totaux de chaque compte, pour la cohérence : le trigger le tient à
//      jour à chaque écriture, ce passage rattrape ce qu'un incident aurait
//      laissé de travers.
//
// ⚠ POURQUOI UN CRON À PART, et pas une tâche de plus dans `api/cron.js` :
// le cycle principal porte les codes d'accès, et sa limite de 60 s est déjà
// disputée. Une lecture IA prend plusieurs secondes ; elle n'a rien à y faire.
// Précédent : `api/cron-messages.js`.

const { createClient } = require('@supabase/supabase-js')
const { purgerEnvois, lireEnAttente } = require('../lib/charges')
const { lireDocument } = require('../lib/charges/lecture')
const { demarrerPassage } = require('../lib/metriques-cron')
const { ecrireLePassage, ECRITURE_MAX_MS } = require('../lib/cron-stats')

// Le mur de Vercel (`maxDuration` 60 s, vercel.json), et ce qu'on laisse
// pour la mesure et la réponse.
const MUR_MESURE_MS = 59000
const BUDGET_LECTURES_MS = 35000
const BUDGET_RECALCUL_MS = 15000
const COMPTES_PAR_PAGE = 200

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

const HEURE_PARIS = new Intl.DateTimeFormat('fr-FR',
  { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false })
/** Le passage quotidien : celui qui tombe entre 3 h 00 et 3 h 04 à Paris. */
function estLePassageQuotidien (d = new Date()) {
  const [h, m] = HEURE_PARIS.format(d).split(':').map(Number)
  return h === 3 && m < 5
}

async function recalculerTousLesComptes (db, echeance) {
  let apres = null
  let comptes = 0
  for (;;) {
    if (Date.now() > echeance) return { comptes, complet: false }
    const { data, error } = await db.rpc('charges_comptes', { p_apres: apres, p_limite: COMPTES_PAR_PAGE })
    if (error) throw new Error(error.message)
    const ids = (data || []).map(x => (typeof x === 'string' ? x : x.charges_comptes || x.user_id)).filter(Boolean)
    for (const id of ids) {
      if (Date.now() > echeance) return { comptes, complet: false }
      const { error: e } = await db.rpc('charges_recalculer_compte', { p_user: id })
      if (e) throw new Error(e.message)
      comptes++
    }
    if (ids.length < COMPTES_PAR_PAGE) return { comptes, complet: true }
    apres = ids[ids.length - 1]
  }
}

module.exports = async function handler (req, res) {
  // ⚠ UN SECRET ABSENT NE DOIT PAS OUVRIR LA PORTE (même garde que
  // `api/cron-messages.js`) : sans elle, on comparerait à « Bearer undefined ».
  if (!process.env.CRON_SECRET) {
    console.error('[cron-charges] CRON_SECRET absent : endpoint ferme')
    return res.status(503).json({ error: 'Service non configuré' })
  }
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Non autorisé' })
  }

  const t0 = Date.now()
  const results = { errors: [] }
  const chrono = demarrerPassage({ cron: 'cron-charges', resultats: () => results })
  let mesureEcrite = false
  const journaliserLePassage = async () => {
    if (mesureEcrite) return
    mesureEcrite = true
    try {
      const detail = chrono.terminer()
      const reste = MUR_MESURE_MS - detail.duree_ms
      if (reste > 300) await ecrireLePassage(supabase, detail, { delaiMs: Math.min(ECRITURE_MAX_MS, reste) })
    } catch (e) { console.error('[cron-charges] mesure non journalisee :', e && e.message) }
  }

  const bilan = { purges: 0, lues: 0, panne_ia: false, recalcul: null }

  // ⚠ CHAQUE TÂCHE A SON PROPRE `try` : une panne de l'une ne prive pas les
  // autres de leur passage.
  try {
    const p = await chrono.mesure('purge_envois', () => purgerEnvois(supabase))
    bilan.purges = p.purges || 0
  } catch (e) { results.errors.push({ tache: 'purge_envois', error: e.message }) }

  try {
    const l = await chrono.mesure('lectures', () => lireEnAttente(supabase, {
      lire: lireDocument, echeance: t0 + BUDGET_LECTURES_MS
    }))
    bilan.lues = l.lues || 0
    bilan.panne_ia = !!l.panne
  } catch (e) { results.errors.push({ tache: 'lectures', error: e.message }) }

  if (estLePassageQuotidien()) {
    try {
      bilan.recalcul = await chrono.mesure('recalcul_resume', () =>
        recalculerTousLesComptes(supabase, Date.now() + BUDGET_RECALCUL_MS))
    } catch (e) { results.errors.push({ tache: 'recalcul_resume', error: e.message }) }
  }

  bilan.ms = Date.now() - t0
  console.log('[cron-charges] fin', JSON.stringify(bilan))
  await journaliserLePassage()
  // ⚠ 200 MÊME AVEC DES ERREURS, ET ELLES SONT DANS LE CORPS : un cron qui
  // rend 500 fait retenter Vercel, et le diagnostic se lit dans `errors`.
  return res.status(200).json({ ok: true, ...bilan, errors: results.errors })
}

module.exports.estLePassageQuotidien = estLePassageQuotidien
module.exports.recalculerTousLesComptes = recalculerTousLesComptes
