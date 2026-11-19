// api/ecran/charges.js — L'APPEL D'ÉCRAN DE LA PAGE `/charges` (lot 3).
// Spec : docs/specs/spec-compte-de-charges.md §13.6 et §13.7.
//
// GET ?entite=<uuid>&periode=<année de début de l'exercice>
//   → la file « À traiter » (50 premières + nombre exact), la première page
//     de la liste DE L'ENTITÉ, les entités, les logements, les totaux de
//     l'exercice et les exercices proposés — en UN appel, lectures en
//     parallèle. Sans entité (ou `toutes`, des liens d'avant le lot 8a) : la
//     première entité active, par son nom (§14.21, décision 7 : plus de vue
//     « Toutes les entités »).
// GET …&curseur=<jour|id>
//   → la page suivante de la liste, seule (« Afficher plus »).
// GET ?mois=<YYYY-MM>&entite=<uuid>
//   → les factures du mois et la part de chacune, seules (clic sur un mois,
//     §14.21.2).
//
// ⚠ RÉSERVÉ AU TITULAIRE (Q9), LECTURE COMPRISE, ET REFUSÉ AVANT TOUTE
// LECTURE : `contexteDEcran` refuse sans session, il ne refuse pas un membre ;
// la garde explicite `estTitulaireDuCompte` le fait. Le menu qui cache
// l'entrée n'est qu'un confort (CLAUDE.md, « un masquage ne suffit jamais »).
//
// ⚠ LECTURE SEULE. Les gestes restent sur `POST /api/charges`.
// ⚠ L'EN-TÊTE PRIVÉ AVANT TOUT REFUS, y compris celui de méthode (dette 90),
// et le 405 avant la garde : un POST n'a pas à lire la session ni le profil.

const { createClient } = require('@supabase/supabase-js')
const { contexteDEcran, posterEnTetesPrives } = require('../../lib/require-permission')
const { estTitulaireDuCompte } = require('../../lib/permissions')
const { compterRequetes, requetesJusquIci } = require('../../lib/compte-requetes')
const ecran = require('../../lib/charges/ecran')

let client = null
const db = () => client || (client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY))

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

async function traiter (req, res, t0, deps) {
  posterEnTetesPrives(res)
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Méthode non autorisée' })
  }
  const garde = await contexteDEcran(req, res)
  if (!garde.ok) return
  // ⚠ AVANT TOUTE LECTURE : un refus posé après la lecture a déjà sorti les
  // données de la base.
  if (!estTitulaireDuCompte(garde.contexte)) {
    return res.status(403).json({ error: 'Réservé au titulaire du compte' })
  }
  const compte = garde.accountUserId
  const base = deps.db || db()
  const q = req.query || {}
  const timing = () => res.setHeader('Server-Timing', `total;dur=${Date.now() - t0};desc="${requetesJusquIci()} requêtes"`)

  const entiteDemandee = q.entite && q.entite !== 'toutes' ? String(q.entite) : null
  if (entiteDemandee && !UUID_RE.test(entiteDemandee)) return res.status(400).json({ error: 'entite_invalide' })

  // ── « Afficher plus » : la page suivante de la liste, seule ──────────────
  // La liste suit l'entité choisie : le curseur vient avec elle (§14.21).
  if (q.curseur != null && q.curseur !== '') {
    const c = ecran.lireCurseur(q.curseur)
    if (!c.ok) return res.status(400).json({ error: 'curseur_invalide' })
    const l = await ecran.liste(base, compte, c.curseur, entiteDemandee)
    timing()
    if (!l.ok) return res.status(503).json({ error: 'Lecture impossible' })
    return res.status(200).json({ liste: { lignes: l.lignes, suite: l.suite } })
  }

  const ej = deps.entites || require('../../lib/entites-juridiques')

  // ── Le détail d'un mois (§14.21.2), seul ──────────────────────────────────
  // ⚠ L'ENTITÉ EST VÉRIFIÉE AVANT : elle doit être du compte de la garde
  // (la fonction filtre encore par compte).
  if (q.mois != null && q.mois !== '') {
    if (!ecran.bornesMois(q.mois)) return res.status(400).json({ error: 'mois_invalide' })
    if (!entiteDemandee) return res.status(400).json({ error: 'entite_requise' })
    const ent = await ej.entitesDuCompte(compte, { db: base })
    if (!ent.ok) { timing(); return res.status(503).json({ error: 'Lecture impossible' }) }
    if (!(ent.entites || []).some(e => String(e.id) === entiteDemandee)) { timing(); return res.status(404).json({ error: 'entite_introuvable' }) }
    const d = await ecran.detailMois(base, compte, { mois: q.mois, entiteId: entiteDemandee })
    timing()
    if (!d.ok) return res.status(503).json({ error: 'Lecture impossible' })
    return res.status(200).json({ detail_mois: { mois: d.mois, debut: d.debut, fin: d.fin, entite: entiteDemandee, lignes: d.lignes } })
  }

  // ── L'écran entier ────────────────────────────────────────────────────────
  // Les entités d'abord : l'exercice dépend du début d'exercice de celle
  // demandée. Les six autres lectures partent ensuite ENSEMBLE.
  const ent = await ej.entitesDuCompte(compte, { db: base })
  if (!ent.ok) { timing(); return res.status(503).json({ error: 'Lecture impossible' }) }
  const entites = ent.entites || []
  // ⚠ UNE ENTITÉ D'UN AUTRE COMPTE N'EXISTE PAS ICI : la liste vient du compte
  // de la garde, et `charges_totaux` filtre encore par compte.
  let entite = entiteDemandee ? entites.find(e => String(e.id) === entiteDemandee) : null
  if (entiteDemandee && !entite) return res.status(404).json({ error: 'entite_introuvable' })
  // Sans entité demandée : la première entité ACTIVE par son nom, sinon la
  // première tout court (une entité archivée garde ses totaux).
  if (!entite && entites.length) {
    const parNom = [...entites].sort((x, y) => String(x.nom || '').localeCompare(String(y.nom || ''), 'fr'))
    entite = parNom.find(e => !e.archivee_le) || parNom[0]
  }
  const entiteId = entite ? entite.id : null
  // L'exercice LU vient de la demande seule ; les exercices PROPOSÉS, des
  // bornes du résumé : les deux lectures partent donc ensemble.
  const lu = ecran.bornesPeriode({ periode: q.periode, entite })
  // Un compte SANS entité n'a ni totaux ni crédits : rien à lire.
  const rien = Promise.resolve({ ok: true, vide: true })

  const [t, l, b, tot, cr, bo] = await Promise.all([
    ecran.aTraiter(base, compte),
    ecran.liste(base, compte, null, entiteId),
    ecran.biens(base, compte, { entites: ej }),
    entite ? ecran.totaux(base, compte, { debut: lu.debut, fin: lu.fin, entiteId }) : rien,
    entite ? ecran.credits(base, compte, { debut: lu.debut, fin: lu.fin, entiteId }) : rien,
    entite ? ecran.exercicesBornes(base, compte, entiteId) : rien
  ])
  const periode = ecran.bornesPeriode({ periode: q.periode, entite, bornes: bo.ok && !bo.vide ? bo.bornes : null })
  timing()
  // La file et la liste sont l'écran : sans elles, il n'y a rien à montrer.
  if (!t.ok || !l.ok) return res.status(503).json({ error: 'Lecture impossible' })
  return res.status(200).json({
    a_traiter: { lignes: t.lignes, nombre: t.nombre },
    liste: { lignes: l.lignes, suite: l.suite },
    entites: entites.map(e => ({ id: e.id, nom: e.nom, archivee: !!e.archivee_le, debut_exercice: e.debut_exercice || null })),
    entite: entiteId,
    // Les logements et les totaux sont des compléments : leur échec se DIT
    // (`null`, que la page affiche « indisponible »), il ne casse pas l'écran.
    biens: b.ok ? b.biens : null,
    biens_archives: b.ok ? b.archives : null,
    totaux: !entite
      ? { sans_entite: true }
      : (tot.ok
          ? { ...tot.totaux, entite: entiteId, periode: periode.periode, proposees: periode.proposees, debut: periode.debut, fin: periode.fin, debut_exercice: periode.debut_exercice, standard: periode.standard }
          : null),
    categories: ecran.ORDRE_CATEGORIES,
    // Les crédits et leurs échéances de l'exercice (§14.20) : un complément,
    // comme les totaux — `null` dit « indisponible », jamais « aucun crédit ».
    credits: !entite ? { liste: [], echeances: [], aujourdhui: null } : (cr.ok ? { liste: cr.credits, echeances: cr.echeances, aujourdhui: cr.aujourdhui } : null)
  })
}

async function handler (req, res, deps = {}) {
  const t0 = Date.now()
  try {
    await compterRequetes(() => traiter(req, res, t0, deps))
  } catch (e) {
    console.error('[ecran/charges] lecture echec:', e && e.message)
    if (!res.headersSent) return res.status(500).json({ error: 'Lecture impossible' })
  }
}

module.exports = (req, res) => handler(req, res)
module.exports.handler = handler
