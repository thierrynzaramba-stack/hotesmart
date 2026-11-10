// ═══════════════════════════════════════════════════════════════════════════
// HôteSmart — Cron DÉDIÉ au compte de charges (lot 2, le socle)
// Spec : docs/specs/spec-compte-de-charges.md §6, §7, §11 point 2
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠ UNE FOIS PAR JOUR (Q28, décision de Thierry du 9 novembre 2026 :
// « une fois par jour, et mise à jour quand un document est ajouté, supprimé
// ou modifié »). Ce qui suit un document se fait AU GESTE, pas ici : la
// lecture IA à la confirmation (`api/charges.js`), les totaux par le trigger
// `charges_resume_trg` à chaque écriture. Ce passage ne fait que le
// rattrapage, en trois tâches bornées et indépendantes, dans cet ordre :
//   1. effacer les ENVOIS jamais confirmés depuis plus de 24 h — la seule
//      exception à « on garde tout » (Q12, acceptée le 9 novembre 2026) ;
//   2. recalculer le résumé des totaux de chaque compte, pour la cohérence ;
//   3. relire les charges restées `a_lire` (panne de l'IA ou plafond du
//      jour au moment du geste).
// À vide : 2 lectures de `charges`, l'écriture de la mesure, 2 appels RPC
// (la liste des comptes), AUCUN appel à l'IA ni au stockage
// (`tests/cron-charges.test.js` le tient).
//
// ⚠ POURQUOI UN CRON À PART, et pas une tâche de plus dans `api/cron.js` :
// le cycle principal porte les codes d'accès, et sa limite de 60 s est déjà
// disputée. Une lecture IA prend plusieurs secondes ; elle n'a rien à y faire.
// Précédent : `api/cron-messages.js`.

const { createClient } = require('@supabase/supabase-js')
const crypto = require('node:crypto')
const { purgerEnvois, lireEnAttente, avecDelai } = require('../lib/charges')
const { lireDocument } = require('../lib/charges/lecture')
const { demarrerPassage } = require('../lib/metriques-cron')
const { ecrireLePassage, ECRITURE_MAX_MS } = require('../lib/cron-stats')

// Le mur de Vercel (`maxDuration` 60 s, vercel.json), et ce qu'on laisse
// pour la mesure et la réponse.
const MUR_MESURE_MS = 59000
// ⚠ LES BUDGETS BORNENT LE DÉPART D'UNE ÉTAPE, PAS SA FIN : la dernière
// lecture commencée peut durer le téléchargement (8 s) plus le délai de l'IA
// (`DELAI_IA_MS`, 20 s). 25 + 8 + 20 laisse de quoi écrire la mesure sous
// le mur.
const BUDGET_PURGE_MS = 8000
const BUDGET_LECTURES_MS = 25000
const BUDGET_RECALCUL_MS = 15000
const DELAI_RPC_MS = 8000
const COMPTES_PAR_PAGE = 200

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

/**
 * Recalcule le résumé de chaque compte, dans l'ordre des comptes, borné par
 * `echeance`.
 * ⚠ LE POINT DE DÉPART TOURNE : il est tiré au hasard à chaque passage, et
 * le parcours fait le tour (de `depart` à la fin, puis du début à `depart`).
 * Repartir toujours du premier compte recalculerait chaque nuit les mêmes, et
 * jamais la fin de la liste, dès que le budget ne suffit plus.
 * `depart: null` : un seul parcours, du premier au dernier.
 */
async function recalculerTousLesComptes (db, echeance, { depart = crypto.randomUUID() } = {}) {
  const rpc = async (nom, args) => {
    const reste = Math.max(1, Math.min(DELAI_RPC_MS, echeance - Date.now() + DELAI_RPC_MS))
    const r = await avecDelai(db.rpc(nom, args), reste)
    if (r && r.delai) throw new Error(`${nom} : delai depasse`)
    if (r && r.error) throw new Error(r.error.message)
    return (r && r.data) || []
  }
  let comptes = 0
  const tours = depart ? [[depart, null], [null, depart]] : [[null, null]]
  for (const [debut, borne] of tours) {
    let apres = debut
    for (;;) {
      if (Date.now() > echeance) return { comptes, complet: false }
      const data = await rpc('charges_comptes', { p_apres: apres, p_limite: COMPTES_PAR_PAGE })
      const ids = data.map(x => (typeof x === 'string' ? x : x.charges_comptes || x.user_id)).filter(Boolean)
      let fini = ids.length < COMPTES_PAR_PAGE
      for (const id of ids) {
        if (borne && id > borne) { fini = true; break }
        if (Date.now() > echeance) return { comptes, complet: false }
        await rpc('charges_recalculer_compte', { p_user: id })
        comptes++
      }
      if (fini) break
      apres = ids[ids.length - 1]
    }
  }
  return { comptes, complet: true }
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

  const bilan = { purges: 0, lues: 0, panne_ia: false, panne_stockage: false, plafonnes: 0, recalcul: null }

  // ⚠ CHAQUE TÂCHE A SON PROPRE `try` : une panne de l'une ne prive pas les
  // autres de leur passage.
  // ⚠ UNE TÂCHE QUI REND `ok: false` EST UNE ERREUR, PAS UN ZÉRO : sans ce
  // relais, une lecture de la file en panne passait pour « rien à faire ».
  try {
    const p = await chrono.mesure('purge_envois', () => purgerEnvois(supabase, { echeance: t0 + BUDGET_PURGE_MS }))
    bilan.purges = p.purges || 0
    if (!p.ok) results.errors.push({ tache: 'purge_envois', error: 'lecture des envois impossible' })
  } catch (e) { results.errors.push({ tache: 'purge_envois', error: e.message }) }

  // Le recalcul passe AVANT les lectures : la nuit personne n'attend de
  // formulaire, et placé après, il n'aurait que le temps qu'elles laissent.
  try {
    bilan.recalcul = await chrono.mesure('recalcul_resume', () =>
      recalculerTousLesComptes(supabase, Math.min(Date.now() + BUDGET_RECALCUL_MS, t0 + BUDGET_LECTURES_MS)))
    if (!bilan.recalcul.complet) results.errors.push({ tache: 'recalcul_resume', error: 'echeance atteinte, recalcul incomplet' })
  } catch (e) { results.errors.push({ tache: 'recalcul_resume', error: e.message }) }

  try {
    const l = await chrono.mesure('lectures', () => lireEnAttente(supabase, {
      lire: lireDocument, echeance: t0 + BUDGET_LECTURES_MS
    }))
    bilan.lues = l.lues || 0
    bilan.panne_ia = !!l.panne
    bilan.panne_stockage = !!l.panne_stockage
    bilan.plafonnes = l.plafonnes || 0
    if (!l.ok) results.errors.push({ tache: 'lectures', error: 'lecture de la file impossible' })
    if (l.panne_stockage) results.errors.push({ tache: 'lectures', error: 'stockage indisponible' })
  } catch (e) { results.errors.push({ tache: 'lectures', error: e.message }) }

  bilan.ms = Date.now() - t0
  console.log('[cron-charges] fin', JSON.stringify(bilan))
  await journaliserLePassage()
  // ⚠ 200 MÊME AVEC DES ERREURS, ET ELLES SONT DANS LE CORPS : un cron qui
  // rend 500 fait retenter Vercel, et le diagnostic se lit dans `errors`.
  return res.status(200).json({ ok: true, ...bilan, errors: results.errors })
}

module.exports.recalculerTousLesComptes = recalculerTousLesComptes
