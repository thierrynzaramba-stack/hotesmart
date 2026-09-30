// api/yield-grille.js — LA GRILLE FIXEE PAR L'HOTE (lot 4.6.7).
// Decisions de Thierry, 30 septembre 2026. Writer : lib/yield/grille-hote.js.
//
// GET  ?bien=<uuid>&niveau=<nom>&prix_centimes=<n>   -> ce que le geste ferait
// GET  ?bien=<uuid>&niveau=<nom>&retirer=1            -> idem, « au calcul »
//      { valide, message?, confirmation: { pilote, nuits, du, au, min, max }, grille }
// POST { bien, niveau, prix_centimes | retirer: true, confirme: { nuits } }
//
// ⚠ LES BORNES (decision 2) SE JUGENT SUR LA GRILLE QUI RESULTERAIT DU GESTE —
// niveaux fixes et calcules meles : strictement croissante, rien sous le prix
// minimum du logement (repli : le plancher global, lib/yield/prix-plancher.js).
// ⚠ LA CONFIRMATION (decision 4) : le POST exige le nombre de nuits que le GET
// a annonce, recalcule au moment du clic ; s'il a change, 409 et on redemande.
// ⚠ APRES UN GESTE SUR UN BIEN PILOTE, le repere quotidien du moteur est efface
// : les nouveaux prix partent au prochain passage du cron (5 minutes), pas le
// lendemain. Cet endpoint n'ecrit AUCUN prix au calendrier : c'est le moteur,
// par son canal, qui le fait.
// ⚠ DROIT `reglages` EN ECRITURE, comme `yield-pilote` : fixer un niveau change
// les prix de toute la fenetre — meme niveau de consequence qu'un prix.

const { createClient } = require('@supabase/supabase-js')
const { requirePermission } = require('../lib/require-permission')
const { NOMS, grilleHoteDuBien, validerGrille, fixerNiveau, remettreAuCalcul } = require('../lib/yield/grille-hote')
const { simulerGrille } = require('../lib/yield/simuler-grille')
const { plancherDuBien } = require('../lib/yield/prix-plancher')
const { pilotParYield } = require('../lib/pilote-tarifaire')
const { effacerMarqueur, jourParis } = require('../lib/ouverture-marqueur')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// Le geste demande, lu et borne. Rend { niveau, cents|null (retirer) } ou { erreur }.
function lireGeste (src) {
  const niveau = String(src.niveau || '').trim()
  if (!NOMS.includes(niveau)) return { erreur: 'Niveau inconnu.' }
  const retirer = src.retirer === true || src.retirer === '1' || src.retirer === 'true'
  if (retirer) return { niveau, cents: null }
  const cents = Number(src.prix_centimes)
  if (!Number.isInteger(cents) || cents <= 0 || cents > 10000000) return { erreur: 'Montant invalide.' }
  return { niveau, cents }
}

async function evaluer (bien, geste) {
  const actuels = await grilleHoteDuBien(supabase, bien.id)
  const proposes = new Map(actuels)
  if (geste.cents == null) proposes.delete(geste.niveau)
  else proposes.set(geste.niveau, { rate_cents: geste.cents })
  const sim = await simulerGrille(supabase, bien, actuels, proposes, jourParis(new Date()))
  if (!sim.grille) return { valide: false, message: 'La grille de ce logement n’est pas encore calculable : pas assez d’historique.', sim }
  const v = validerGrille(sim.grille, plancherDuBien(bien))
  return { valide: v.ok, message: v.ok ? null : v.message, code: v.ok ? null : v.code, sim }
}

module.exports = async (req, res) => {
  const body = req.body || {}
  const bienDemande = req.query.bien || body.bien
  if (!bienDemande) return res.status(400).json({ error: 'bien_requis' })
  const ecriture = req.method !== 'GET'
  if (ecriture && req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Methode non autorisee' }) }
  const garde = await requirePermission(req, res, {
    domaine: ecriture ? 'reglages' : 'reservations', niveau: ecriture ? 'write' : 'read', bien: bienDemande, bienRequis: true
  })
  if (!garde.ok) return
  const compte = garde.accountUserId
  // Le bien COMPLET (le moteur et le plancher en ont besoin), cloisonne.
  const { data: bien, error: eBien } = await supabase.from('properties').select('*')
    .eq('id', garde.bien.id).eq('user_id', compte).maybeSingle()
  if (eBien) return res.status(503).json({ error: 'Logement illisible pour le moment. Réessayez.' })
  if (!bien) return res.status(404).json({ error: 'Logement introuvable.' })

  const geste = lireGeste(ecriture ? body : req.query)
  if (geste.erreur) return res.status(400).json({ error: geste.erreur })

  let e
  try { e = await evaluer(bien, geste) } catch (err) {
    console.error('[yield-grille] simulation', bien.id, err.message)
    return res.status(503).json({ error: 'Le calcul de la grille a échoué : rien n’a changé. Réessayez.' })
  }
  const confirmation = { pilote: e.sim.pilote, nuits: e.sim.nuits, du: e.sim.du, au: e.sim.au, min: e.sim.min, max: e.sim.max }
  if (!ecriture) return res.status(200).json({ valide: e.valide, message: e.message, code: e.code, confirmation, grille: e.sim.grille })

  if (!e.valide) return res.status(400).json({ error: e.message, code: e.code })
  const c = body.confirme && typeof body.confirme === 'object' ? body.confirme : {}
  if (Number(c.nuits) !== e.sim.nuits) {
    return res.status(409).json({ error: 'Le nombre de nuits concernées a changé : confirmez à nouveau.', code: 'a_confirmer', confirmation })
  }
  const niveauCalcule = (e.sim.grille || []).find(n => n.nom === geste.niveau)
  const r = geste.cents == null
    ? await remettreAuCalcul(supabase, { userId: compte, propertyId: bien.id, niveau: geste.niveau })
    : await fixerNiveau(supabase, { userId: compte, propertyId: bien.id, niveau: geste.niveau, cents: geste.cents,
      recommandeCents: niveauCalcule && niveauCalcule.prix_calcule != null ? Math.round(niveauCalcule.prix_calcule * 100) : null })
  if (!r.ok) return res.status(503).json({ error: r.message, code: r.raison })
  // Les nouveaux prix partent au prochain passage (5 min), pas demain.
  if (pilotParYield(bien) && e.sim.nuits > 0) {
    const { error: eM } = await effacerMarqueur(supabase, bien.id)
    if (eM) console.error('[yield-grille] marqueur non efface', bien.id, eM.message)
  }
  console.log(`[yield-grille] ${bien.id} : ${geste.niveau} -> ${geste.cents == null ? 'au calcul' : geste.cents + ' c'} (${e.sim.nuits} nuit(s))`)
  return res.status(200).json({ ok: true, niveau: geste.niveau, fixe: geste.cents != null, confirmation, grille: e.sim.grille })
}
