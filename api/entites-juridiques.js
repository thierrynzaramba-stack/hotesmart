// api/entites-juridiques.js — la fenêtre « Facturation » de la fiche d'un
// logement : l'entité juridique de CE logement, et ses gestes.
// Spec : docs/specs/spec-facture-voyageur.md §4 (D2 bis), §5.1, §5.2, §9
// KB   : docs/kb/entites-juridiques.md (modif = MEME COMMIT)
//
// ⚠ D2 BIS (Thierry, 9 nov. 2026, 12 h 08) : plus de page « Entités
// juridiques », plus d'entité par défaut. L'entité se choisit SUR LA FICHE DU
// LOGEMENT, dans une fenêtre : choisir, retirer de ce logement, créer (elle est
// alors choisie pour ce logement), modifier, régler la numérotation.
//
// ⚠ TOUT PASSE PAR LE LOGEMENT DÉSIGNÉ, lecture comme écriture : `?bien=` pour
// le GET, `property_uuid` pour chaque POST. Le compte cible vient de CE BIEN,
// résolu par le serveur (règle 11) — jamais de l'appelant ni de X-Compte. Une
// entité visée par `id` doit ensuite appartenir à ce compte (le writer filtre
// par `user_id`).
//
// ⚠ DOMAINE `facturation`, PAS `reglages`. La fiche du logement est gardée sur
// `reglages` ; un membre `reglages: write` y change le logement, mais PAS
// l'émetteur des factures (constat 4 de la relecture de la spec). D'où un
// endpoint à part. `facturation` ne se délègue pas en écriture (titulaire seul,
// lib/permissions.js NON_DELEGABLES) et se délègue en LECTURE, dans le
// périmètre du membre : un membre dont le périmètre n'a pas ce logement est
// refusé, même en lecture.
// ⚠ Et ce n'est pas un masquage : la fiche cache le bouton, le serveur refuse.
//
// ⚠ LES EN-TETES PRIVES AVANT LE PREMIER REFUS, 405 compris (dette 90).

const { requirePermission, posterEnTetesPrives } = require('../lib/require-permission')
const EJ = require('../lib/entites-juridiques')
const { createClient } = require('@supabase/supabase-js')

// Un client a soi, comme api/membres.js : `lib/cron-shared` chargerait aussi le
// SDK de l'IA pour rien, a chaque demarrage a froid de cette fonction.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const db = () => supabase

function corpsDe (req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body !== 'string' || !req.body) return {}
  try { return JSON.parse(req.body) } catch (e) { return null }
}

// Le code HTTP d'un refus du writer.
const CODES = { entree_invalide: 400, introuvable: 404, archivee: 409, suite_figee: 409, panne: 503 }
function repondreRefus (res, r) {
  return res.status(CODES[r.motif] || 400).json({ error: r.motif, motif: r.motif, champ: r.champ || null })
}

async function lireFenetre (req, res) {
  const t0 = Date.now()
  let requetes = 0
  const bien = req.query && req.query.bien != null ? String(req.query.bien).trim() : ''
  const garde = await requirePermission(req, res, { domaine: 'facturation', niveau: 'read', bien, bienRequis: true })
  if (!garde.ok) return
  const compte = garde.accountUserId
  const base = db()
  const compter = (p) => { requetes++; return p }

  const [ents, lien] = await Promise.all([
    compter(EJ.entitesDuCompte(compte, { db: base })),
    compter(EJ.lienDuBien(compte, garde.bien.id, { db: base }))
  ])
  if (!ents.ok || !lien.ok) return res.status(503).json({ error: 'panne', motif: 'panne' })

  // Les entités ACTIVES, plus celle du logement si elle est archivée : la
  // fenêtre doit dire « l'entité de ce logement est archivée, il ne facture
  // plus » (P4), sans proposer une archivée au choix.
  const entites = ents.entites.filter(e => !e.archivee_le || e.id === lien.entite_id)

  // La numérotation de l'année, pour chaque entité ACTIVE en numérotation
  // AUTOMATIQUE : en manuelle, l'hôte saisit chaque numéro à l'émission (Q5 bis).
  const auto = entites.filter(e => !e.archivee_le && e.numerotation_factures !== 'manuel')
  // Une suite coute 1 ou 2 requetes : c'est elle qui le dit (review 2, constat 2).
  const suites = await Promise.all(auto.map(e => EJ.numerotation(compte, e.id, { db: base })))
  requetes += suites.reduce((n, s) => n + (s.requetes || 0), 0)
  if (suites.some(s => !s.ok)) return res.status(503).json({ error: 'panne', motif: 'panne' })
  const numerotations = {}
  auto.forEach((e, i) => { numerotations[e.id] = suites[i].suite })

  res.setHeader('Server-Timing', `db;desc="${requetes} requêtes";dur=${Date.now() - t0}`)
  return res.status(200).json({
    titulaire: garde.userId === compte,
    bien: { id: garde.bien.id, nom: garde.bien.name || '', entite_id: lien.entite_id },
    entites,
    numerotations
  })
}

async function geste (req, res) {
  const corps = corpsDe(req)
  if (corps === null) return res.status(400).json({ error: 'corps_illisible', motif: 'entree_invalide' })
  const action = corps.action
  const actions = ['creer', 'modifier', 'rattacher', 'numerotation']
  if (!actions.includes(action)) return res.status(400).json({ error: 'action_inconnue', motif: 'entree_invalide' })

  // ⚠ CHAQUE GESTE DÉSIGNE LE LOGEMENT de la fenêtre : le compte vient de lui,
  // et `facturation` en écriture ne passe que pour son titulaire.
  const garde = await requirePermission(req, res, {
    domaine: 'facturation', niveau: 'write', bien: corps.property_uuid, bienRequis: true
  })
  if (!garde.ok) return
  const compte = garde.accountUserId
  const bienId = garde.bien.id
  const base = db()

  if (action === 'creer') {
    // Créée depuis la fenêtre d'un logement : elle est choisie pour lui.
    const cree = await EJ.creer(compte, corps.entite, { db: base })
    if (!cree.ok) return repondreRefus(res, cree)
    const lie = await EJ.rattacherBien(compte, bienId, cree.entite.id, { db: base })
    // ⚠ L'entité existe même si le rattachement échoue : on le dit, la
    // fenêtre relit et la montre dans la liste, non choisie.
    if (!lie.ok) return repondreRefus(res, lie)
    return res.status(200).json({ ok: true, entite: cree.entite, entite_id: lie.entite_id })
  }

  let r
  if (action === 'modifier') r = await EJ.modifier(compte, corps.id, corps.entite, { db: base })
  else if (action === 'rattacher') r = await EJ.rattacherBien(compte, bienId, corps.entite_id ?? null, { db: base })
  else r = await EJ.reglerNumerotation(compte, corps.id, corps.numerotation, { db: base })

  if (!r.ok) return repondreRefus(res, r)
  const { ok, ...reste } = r
  return res.status(200).json({ ok: true, ...reste })
}

module.exports = async function handler (req, res) {
  posterEnTetesPrives(res)
  if (req.method === 'GET') return lireFenetre(req, res)
  if (req.method === 'POST') return geste(req, res)
  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'Méthode non autorisée' })
}
