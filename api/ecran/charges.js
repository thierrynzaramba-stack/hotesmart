// api/ecran/charges.js — L'APPEL D'ÉCRAN DE LA PAGE `/charges` (lot 3).
// Spec : docs/specs/spec-compte-de-charges.md §13.6 et §13.7.
//
// GET ?entite=<uuid|toutes>&periode=<exercice|exercice_precedent|12_mois>
//   → la file « À traiter » (50 premières + nombre exact), la première page
//     de la liste, les entités, les logements et les totaux — en UN appel,
//     lectures en parallèle.
// GET …&curseur=<jour|id>
//   → la page suivante de la liste, seule (« Afficher plus »).
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

  // ── « Afficher plus » : la page suivante de la liste, seule ──────────────
  if (q.curseur != null && q.curseur !== '') {
    const c = ecran.lireCurseur(q.curseur)
    if (!c.ok) return res.status(400).json({ error: 'curseur_invalide' })
    const l = await ecran.liste(base, compte, c.curseur)
    timing()
    if (!l.ok) return res.status(503).json({ error: 'Lecture impossible' })
    return res.status(200).json({ liste: { lignes: l.lignes, suite: l.suite } })
  }

  // ── L'écran entier ────────────────────────────────────────────────────────
  const entiteDemandee = q.entite && q.entite !== 'toutes' ? String(q.entite) : null
  if (entiteDemandee && !UUID_RE.test(entiteDemandee)) return res.status(400).json({ error: 'entite_invalide' })
  const ej = deps.entites || require('../../lib/entites-juridiques')

  // Les entités d'abord : la période dépend du début d'exercice de celle
  // demandée. Les quatre autres lectures partent ensuite ENSEMBLE.
  const ent = await ej.entitesDuCompte(compte, { db: base })
  if (!ent.ok) { timing(); return res.status(503).json({ error: 'Lecture impossible' }) }
  const entites = ent.entites || []
  // ⚠ UNE ENTITÉ D'UN AUTRE COMPTE N'EXISTE PAS ICI : la liste vient du compte
  // de la garde, et `charges_totaux` filtre encore par compte.
  const entite = entiteDemandee ? entites.find(e => String(e.id) === entiteDemandee) : null
  if (entiteDemandee && !entite) return res.status(404).json({ error: 'entite_introuvable' })
  const periode = ecran.bornesPeriode({ periode: q.periode, entite })

  const [t, l, b, tot] = await Promise.all([
    ecran.aTraiter(base, compte),
    ecran.liste(base, compte, null),
    ecran.biens(base, compte, { entites: ej }),
    ecran.totaux(base, compte, { debut: periode.debut, fin: periode.fin, entiteId: entite ? entite.id : null })
  ])
  timing()
  // La file et la liste sont l'écran : sans elles, il n'y a rien à montrer.
  if (!t.ok || !l.ok) return res.status(503).json({ error: 'Lecture impossible' })
  return res.status(200).json({
    a_traiter: { lignes: t.lignes, nombre: t.nombre },
    liste: { lignes: l.lignes, suite: l.suite },
    entites: entites.map(e => ({ id: e.id, nom: e.nom, archivee: !!e.archivee_le, debut_exercice: e.debut_exercice || null })),
    // Les logements et les totaux sont des compléments : leur échec se DIT
    // (`null`, que la page affiche « indisponible »), il ne casse pas l'écran.
    biens: b.ok ? b.biens : null,
    biens_archives: b.ok ? b.archives : null,
    totaux: tot.ok ? { ...tot.totaux, entite: entite ? entite.id : null, periode: periode.periode, proposees: periode.proposees, debut: periode.debut, fin: periode.fin } : null,
    categories: ecran.ORDRE_CATEGORIES
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
