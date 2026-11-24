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
// GET …&entite=sans
//   → « Sans entité juridique » (lot 5 bis, §14.25) : les factures d'un
//     logement qui n'a pas d'entité, sur l'année civile. Partout où une
//     entité est attendue, `sans` est accepté — et devient NULL à l'appel
//     des lectures du résumé, nulle part ailleurs.
// GET ?export=1&entite=<uuid>&periode=<AAAA>
//   → la liste d'export de l'exercice (lot 8d, §14.23) : les factures
//     enregistrées, sans le chemin de leur fichier, et le nombre de factures
//     encore à traiter. Un GESTE (« Télécharger l'exercice »), jamais au
//     chargement.
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
  const SANS = ecran.SANS_ENTITE
  if (entiteDemandee && entiteDemandee !== SANS && !UUID_RE.test(entiteDemandee)) return res.status(400).json({ error: 'entite_invalide' })
  const sansEntite = entiteDemandee === SANS

  // ── « Afficher plus » : la page suivante de la liste, seule ──────────────
  // La liste suit l'entité choisie : le curseur vient avec elle (§14.21).
  if (q.curseur != null && q.curseur !== '') {
    const c = ecran.lireCurseur(q.curseur)
    if (!c.ok) return res.status(400).json({ error: 'curseur_invalide' })
    // « Sans entité » : les logements RATTACHÉS sont écartés (lot 5 bis).
    let rattaches = []
    if (sansEntite) {
      const li = await (deps.entites || require('../../lib/entites-juridiques')).liensDuCompte(compte, { db: base })
      if (!li.ok) { timing(); return res.status(503).json({ error: 'Lecture impossible' }) }
      rattaches = (li.liens || []).map(x => x.property_uuid)
    }
    const l = await ecran.liste(base, compte, c.curseur, entiteDemandee, { rattaches })
    timing()
    if (!l.ok) return res.status(503).json({ error: 'Lecture impossible' })
    return res.status(200).json({ liste: { lignes: l.lignes, suite: l.suite } })
  }

  // ── « À traiter », la suite (lot 8c, dette 153) ─────────────────────────
  if (q.suite_a_traiter != null && q.suite_a_traiter !== '') {
    const c = ecran.lireCurseurArrivee(q.suite_a_traiter)
    if (!c.ok || !c.curseur) return res.status(400).json({ error: 'curseur_invalide' })
    const t = await ecran.aTraiter(base, compte, c.curseur)
    timing()
    if (!t.ok) return res.status(503).json({ error: 'Lecture impossible' })
    return res.status(200).json({ a_traiter: { lignes: t.lignes, suite: t.suite } })
  }

  // ── Le parcours « À vérifier », dans l'ordre de dépôt (lot 8c) ───────────
  if (q.parcours != null && q.parcours !== '') {
    const brut = q.parcours === 'debut' ? '' : q.parcours
    const c = ecran.lireCurseurArrivee(brut)
    if (!c.ok) return res.status(400).json({ error: 'curseur_invalide' })
    const v = await ecran.aVerifier(base, compte, c.curseur)
    timing()
    if (!v.ok) return res.status(503).json({ error: 'Lecture impossible' })
    return res.status(200).json({ parcours: { lignes: v.lignes, suite: v.suite, ...(v.nombre != null ? { nombre: v.nombre } : {}) } })
  }

  const ej = deps.entites || require('../../lib/entites-juridiques')

  // ── Le détail d'un mois (§14.21.2), seul ──────────────────────────────────
  // ⚠ L'ENTITÉ EST VÉRIFIÉE AVANT : elle doit être du compte de la garde
  // (la fonction filtre encore par compte).
  // ⚠ ET LE MOIS EST COUPÉ À L'EXERCICE DEMANDÉ (review 1, constat 1) : son
  // début d'exercice vient de l'entité RELUE ici, jamais de la requête.
  if (q.mois != null && q.mois !== '') {
    if (!ecran.bornesMois(q.mois)) return res.status(400).json({ error: 'mois_invalide' })
    if (!entiteDemandee) return res.status(400).json({ error: 'entite_requise' })
    if (!/^\d{4}$/.test(String(q.periode || ''))) return res.status(400).json({ error: 'periode_requise' })
    // « Sans entité » : l'année civile, aucune entité à relire.
    let entite = null
    if (!sansEntite) {
      const ent = await ej.entitesDuCompte(compte, { db: base })
      if (!ent.ok) { timing(); return res.status(503).json({ error: 'Lecture impossible' }) }
      entite = (ent.entites || []).find(e => String(e.id) === entiteDemandee)
      if (!entite) { timing(); return res.status(404).json({ error: 'entite_introuvable' }) }
    }
    const exercice = ecran.bornesPeriode({ periode: q.periode, entite })
    // Une année hors des bornes de lecture retombe sur l'exercice en cours :
    // ce ne serait plus celui demandé.
    if (exercice.periode !== String(q.periode)) { timing(); return res.status(400).json({ error: 'periode_invalide' }) }
    const plage = ecran.plageDuMois(q.mois, exercice)
    if (!plage) { timing(); return res.status(400).json({ error: 'mois_hors_exercice' }) }
    const d = await ecran.detailMois(base, compte, { debut: plage.debut, fin: plage.fin, entiteId: entiteDemandee })
    timing()
    if (!d.ok) return res.status(503).json({ error: 'Lecture impossible' })
    return res.status(200).json({ detail_mois: { mois: String(q.mois), periode: exercice.periode, debut: plage.debut, fin: plage.fin, partiel: plage.partiel, entite: entiteDemandee, lignes: d.lignes } })
  }

  // ── L'export d'un exercice (lot 8d, §14.23), seul ────────────────────────
  // Les mêmes gardes que le détail d'un mois : l'entité RELUE dans le compte,
  // l'exercice relu à partir d'elle, jamais de la requête.
  if (q.export != null && q.export !== '') {
    if (!entiteDemandee) return res.status(400).json({ error: 'entite_requise' })
    if (!/^\d{4}$/.test(String(q.periode || ''))) return res.status(400).json({ error: 'periode_requise' })
    let entite = null
    if (!sansEntite) {
      const ent = await ej.entitesDuCompte(compte, { db: base })
      if (!ent.ok) { timing(); return res.status(503).json({ error: 'Lecture impossible' }) }
      entite = (ent.entites || []).find(e => String(e.id) === entiteDemandee)
      if (!entite) { timing(); return res.status(404).json({ error: 'entite_introuvable' }) }
    }
    const exercice = ecran.bornesPeriode({ periode: q.periode, entite })
    if (exercice.periode !== String(q.periode)) { timing(); return res.status(400).json({ error: 'periode_invalide' }) }
    const [x, n] = await Promise.all([
      ecran.aExporter(base, compte, { debut: exercice.debut, fin: exercice.fin, entiteId: entiteDemandee }),
      ecran.nombreATraiter(base, compte)
    ])
    timing()
    if (x.trop) return res.status(413).json({ error: 'trop_de_factures', max: ecran.EXPORT_MAX })
    if (!x.ok || !n.ok) return res.status(503).json({ error: 'Lecture impossible' })
    return res.status(200).json({
      export: {
        // « Sans entité » n'a ni nom ni SIRET : la page écrit le sien.
        entite: sansEntite ? { id: SANS, nom: null, siret: null, sans: true } : { id: entite.id, nom: entite.nom, siret: entite.siret || null },
        periode: exercice.periode, debut: exercice.debut, fin: exercice.fin, standard: exercice.standard,
        lignes: x.lignes, a_traiter: n.nombre
      }
    })
  }

  // ── L'écran entier ────────────────────────────────────────────────────────
  // Les entités d'abord : l'exercice dépend du début d'exercice de celle
  // demandée. Avec elles, la présence d'un total « Sans entité » (lot 5 bis) :
  // un compte SANS entité ouvre dessus. Les six autres lectures partent
  // ensuite ENSEMBLE.
  // « Sans entité » DEMANDÉ : les logements rattachés, que la liste écarte
  // (un compte qui n'a aucune entité n'en a aucun : rien à lire).
  const [ent, pres, li] = await Promise.all([
    ej.entitesDuCompte(compte, { db: base }),
    ecran.sansEntitePresente(base, compte),
    sansEntite ? ej.liensDuCompte(compte, { db: base }) : Promise.resolve({ ok: true, liens: [] })
  ])
  if (!ent.ok || !li.ok) { timing(); return res.status(503).json({ error: 'Lecture impossible' }) }
  const entites = ent.entites || []
  // ⚠ UNE ENTITÉ D'UN AUTRE COMPTE N'EXISTE PAS ICI : la liste vient du compte
  // de la garde, et `charges_totaux` filtre encore par compte.
  let entite = entiteDemandee && !sansEntite ? entites.find(e => String(e.id) === entiteDemandee) : null
  if (entiteDemandee && !sansEntite && !entite) return res.status(404).json({ error: 'entite_introuvable' })
  // Sans entité demandée : la première entité ACTIVE par son nom, sinon la
  // première tout court (une entité archivée garde ses totaux) ; et un compte
  // qui n'en a aucune, « Sans entité » s'il y a de quoi l'afficher.
  if (!entite && !entiteDemandee && entites.length) {
    const parNom = [...entites].sort((x, y) => String(x.nom || '').localeCompare(String(y.nom || ''), 'fr'))
    entite = parNom.find(e => !e.archivee_le) || parNom[0]
  }
  const optionSans = Boolean(pres.ok && pres.oui)
  const vueSans = sansEntite || (!entite && !entiteDemandee && optionSans)
  // L'identifiant LU : l'entité, `sans`, ou rien (un compte sans entité ni
  // facture sans entité : la liste est alors celle de tout le compte).
  const entiteId = vueSans ? SANS : (entite ? entite.id : null)
  // L'exercice LU vient de la demande seule ; les exercices PROPOSÉS, des
  // bornes du résumé : les deux lectures partent donc ensemble. « Sans
  // entité » : l'année civile (`entite` nulle).
  const lu = ecran.bornesPeriode({ periode: q.periode, entite })
  // Un compte SANS entité n'a ni totaux ni crédits : rien à lire. « Sans
  // entité » a des totaux, et aucun crédit (un crédit a toujours son entité).
  const rien = Promise.resolve({ ok: true, vide: true })

  const [t, l, b, tot, cr, bo] = await Promise.all([
    ecran.aTraiter(base, compte),
    ecran.liste(base, compte, null, entiteId, { rattaches: (li.liens || []).map(x => x.property_uuid) }),
    ecran.biens(base, compte, { entites: ej }),
    entiteId ? ecran.totaux(base, compte, { debut: lu.debut, fin: lu.fin, entiteId }) : rien,
    entite && !vueSans ? ecran.credits(base, compte, { debut: lu.debut, fin: lu.fin, entiteId }) : rien,
    entiteId ? ecran.exercicesBornes(base, compte, entiteId) : rien
  ])
  const periode = ecran.bornesPeriode({ periode: q.periode, entite: vueSans ? null : entite, bornes: bo.ok && !bo.vide ? bo.bornes : null })
  timing()
  // La file et la liste sont l'écran : sans elles, il n'y a rien à montrer.
  if (!t.ok || !l.ok) return res.status(503).json({ error: 'Lecture impossible' })
  return res.status(200).json({
    a_traiter: { lignes: t.lignes, nombre: t.nombre, suite: t.suite },
    liste: { lignes: l.lignes, suite: l.suite },
    entites: entites.map(e => ({ id: e.id, nom: e.nom, archivee: !!e.archivee_le, debut_exercice: e.debut_exercice || null })),
    entite: entiteId,
    // Lot 5 bis : le choix « Sans entité juridique » est proposé (un total
    // existe, ou c'est lui qu'on lit). Un complément : son échec le cache.
    option_sans_entite: optionSans || vueSans,
    // Les logements et les totaux sont des compléments : leur échec se DIT
    // (`null`, que la page affiche « indisponible »), il ne casse pas l'écran.
    biens: b.ok ? b.biens : null,
    biens_archives: b.ok ? b.archives : null,
    totaux: !entiteId
      ? { sans_entite: true }
      : (tot.ok
          ? {
              ...tot.totaux, entite: entiteId, periode: periode.periode, proposees: periode.proposees, debut: periode.debut, fin: periode.fin, debut_exercice: periode.debut_exercice, standard: periode.standard,
              // Review 1, constat 7 : sans les bornes, seul l'exercice lu est
              // proposé — l'écran le DIT au lieu de laisser croire qu'il n'y en
              // a pas d'autre.
              exercices_indisponibles: !bo.ok
            }
          : null),
    categories: ecran.ORDRE_CATEGORIES,
    // Les crédits et leurs échéances de l'exercice (§14.20) : un complément,
    // comme les totaux — `null` dit « indisponible », jamais « aucun crédit ».
    credits: !entite || vueSans ? { liste: [], echeances: [], aujourdhui: null } : (cr.ok ? { liste: cr.credits, echeances: cr.echeances, aujourdhui: cr.aujourdhui } : null)
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
