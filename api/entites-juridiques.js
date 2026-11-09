// api/entites-juridiques.js — l'ecran « Entites juridiques » et ses gestes.
// Spec : docs/specs/spec-facture-voyageur.md §5.1, §5.2, §9
// KB   : docs/kb/entites-juridiques.md (modif = MEME COMMIT)
//
// UN ECRAN = UN ENDPOINT. Le GET rend tout ce que la page affiche, lu en
// parallele : les entites (archivees comprises), les biens du compte et leur
// entite, la numerotation de l'annee par entite.
//
// ⚠ DOMAINE `facturation`. Il ne se delegue PAS en ecriture (titulaire seul,
// lib/permissions.js NON_DELEGABLES) mais se delegue en LECTURE (`peutLire`).
// Les ecritures passent toutes par la garde `facturation` en `write` :
//   - avec `compteDelegue` pour les gestes sur une entite : un membre qui vise
//     le compte d'un autre par X-Compte est refuse par `peutEcrire` ; sans
//     X-Compte, il ne touche que son propre compte ;
//   - avec le BIEN pour le rattachement : le compte cible vient de la
//     ressource, jamais de l'appelant (regle 11).
// ⚠ Et ce n'est pas un masquage : la page cache les boutons, le serveur refuse.
//
// ⚠ LES EN-TETES PRIVES AVANT LE PREMIER REFUS, 405 compris (dette 90).

const { requirePermission, posterEnTetesPrives } = require('../lib/require-permission')
const { dansPerimetre } = require('../lib/permissions')
const { sansArchives } = require('../lib/biens-vivants')
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

async function lireEcran (req, res) {
  const t0 = Date.now()
  let requetes = 0
  const garde = await requirePermission(req, res, { domaine: 'facturation', niveau: 'read', compteDelegue: true })
  if (!garde.ok) return
  const compte = garde.accountUserId
  const base = db()
  const compter = (p) => { requetes++; return p }

  const [ents, liens, biens] = await Promise.all([
    compter(EJ.entitesDuCompte(compte, { db: base })),
    compter(EJ.liensDuCompte(compte, { db: base })),
    compter(sansArchives(base.from('properties').select('id, name, provider_property_id').eq('user_id', compte))
      .order('name', { ascending: true }))
  ])
  if (!ents.ok || !liens.ok || biens.error) {
    if (biens.error) console.error('[entites-juridiques] lecture des biens', biens.error.message)
    return res.status(503).json({ error: 'panne', motif: 'panne' })
  }

  // La numerotation de l'annee, pour chaque entite ACTIVE en numerotation
  // AUTOMATIQUE : une archivee n'emet plus, et en manuelle l'hote saisit
  // chaque numero a l'emission (Q5 bis) — il n'y a pas de suite a montrer.
  const actives = ents.entites.filter(e => !e.archivee_le && e.numerotation_factures !== 'manuel')
  // Une suite coute 1 ou 2 requetes : c'est elle qui le dit (review 2, constat 2).
  const suites = await Promise.all(actives.map(e => EJ.numerotation(compte, e.id, { db: base })))
  requetes += suites.reduce((n, s) => n + (s.requetes || 0), 0)
  if (suites.some(s => !s.ok)) return res.status(503).json({ error: 'panne', motif: 'panne' })
  const numerotations = {}
  actives.forEach((e, i) => { numerotations[e.id] = suites[i].suite })

  // Un membre ne voit que les biens de son perimetre.
  const lienDe = new Map(liens.liens.map(l => [String(l.property_uuid), String(l.entite_id)]))
  const visibles = (biens.data || [])
    .filter(b => dansPerimetre(garde.contexte, { id: b.id, ref: b.provider_property_id }))
    .map(b => ({ id: b.id, nom: b.name || '', entite_id: lienDe.get(String(b.id)) || null }))

  res.setHeader('Server-Timing', `db;desc="${requetes} requêtes";dur=${Date.now() - t0}`)
  return res.status(200).json({
    titulaire: garde.userId === compte,
    entites: ents.entites,
    biens: visibles,
    numerotations
  })
}

async function geste (req, res) {
  const corps = corpsDe(req)
  if (corps === null) return res.status(400).json({ error: 'corps_illisible', motif: 'entree_invalide' })
  const action = corps.action
  const actions = ['creer', 'modifier', 'archiver', 'defaut', 'rattacher', 'numerotation']
  if (!actions.includes(action)) return res.status(400).json({ error: 'action_inconnue', motif: 'entree_invalide' })

  // Le rattachement designe un BIEN : le compte vient de lui. Tout le reste
  // vise le compte choisi (X-Compte revalide), en ecriture `facturation`.
  const garde = action === 'rattacher'
    ? await requirePermission(req, res, { domaine: 'facturation', niveau: 'write', bien: corps.property_uuid, bienRequis: true })
    : await requirePermission(req, res, { domaine: 'facturation', niveau: 'write', compteDelegue: true })
  if (!garde.ok) return
  const compte = garde.accountUserId
  const base = db()

  let r
  if (action === 'creer') r = await EJ.creer(compte, corps.entite, { db: base })
  else if (action === 'modifier') r = await EJ.modifier(compte, corps.id, corps.entite, { db: base })
  else if (action === 'archiver') r = await EJ.archiver(compte, corps.id, { db: base })
  else if (action === 'defaut') r = await EJ.definirDefaut(compte, corps.id, { db: base })
  else if (action === 'rattacher') r = await EJ.rattacherBien(compte, garde.bien && garde.bien.id, corps.entite_id ?? null, { db: base })
  else r = await EJ.reglerNumerotation(compte, corps.id, corps.numerotation, { db: base })

  if (!r.ok) return repondreRefus(res, r)
  const { ok, ...reste } = r
  return res.status(200).json({ ok: true, ...reste })
}

module.exports = async function handler (req, res) {
  posterEnTetesPrives(res)
  if (req.method === 'GET') return lireEcran(req, res)
  if (req.method === 'POST') return geste(req, res)
  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'Méthode non autorisée' })
}
