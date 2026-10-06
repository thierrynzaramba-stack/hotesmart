// api/yield-grille.js — LA GRILLE FIXEE PAR L'HOTE (lot 4.6.7).
// Decisions de Thierry, 30 septembre 2026. Writer : lib/yield/grille-hote.js.
//
// GET  ?bien=<uuid>&niveau=<nom>&prix_centimes=<n>   -> ce que le geste ferait
// GET  ?bien=<uuid>&niveau=<nom>&retirer=1            -> idem, « au calcul »
//      { valide, message?, confirmation: { pilote, nuits, du, au, min, max }, grille }
// POST { bien, niveau, prix_centimes | retirer: true, confirme: { nuits } }
//
// ⚠ LES BORNES (decision 2) : le niveau TOUCHE face a ses voisins et au prix
// minimum (`validerGeste`) — jamais une paire que l'hote n'a pas touchee ;
// « au calcul » n'est jamais refuse ; l'ordre tient ensuite a CHAQUE
// application (`appliquerGrilleHote`). Deux gestes concurrents : l'ordre des
// niveaux fixes est relu apres ecriture, le perdant est defait (409).
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
const { NOMS, grilleHoteDuBien, validerGeste, fixerNiveau, remettreAuCalcul } = require('../lib/yield/grille-hote')
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
  // ⚠ REMETTRE AU CALCUL N'EST JAMAIS REFUSE (review) — pas meme sur une
  // grille devenue non calculable : un montant fixe ne doit pas survivre en
  // base, inerte, pour se reappliquer des mois plus tard sans prevenir.
  if (geste.cents == null) return { valide: true, message: null, code: null, sim, actuels }
  if (!sim.grille) return { valide: false, message: 'La grille de ce logement n’est pas encore calculable : pas assez d’historique.', sim, actuels }
  // Le geste seul, face a ses voisins (review : jamais une paire non touchee).
  const v = validerGeste(sim.grille, geste, plancherDuBien(bien))
  return { valide: v.ok, message: v.ok ? null : v.message, code: v.ok ? null : v.code, sim, actuels }
}

// ⚠ DEUX GESTES CONCURRENTS (review) : chacun se valide contre la grille lue
// avant l'autre — Moyen 140 € et Haut 130 € passaient ensemble. Apres
// l'ecriture, on RELIT les niveaux fixes et on verifie leur ordre entre eux ;
// s'il est rompu, on defait CE geste (l'autre a gagne) et on redemande.
async function ordreDesFixes (bienId) {
  const fixes = await grilleHoteDuBien(supabase, bienId)
  const f = NOMS.map(n => fixes.get(n)).map((x, i) => x ? { nom: NOMS[i], c: x.rate_cents } : null).filter(Boolean)
  for (let i = 1; i < f.length; i++) if (!(f[i].c > f[i - 1].c)) return { ok: false, paire: `${f[i - 1].nom}/${f[i].nom}` }
  return { ok: true }
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
  const confirmation = { pilote: e.sim.pilote, nuits: e.sim.nuits, du: e.sim.du, au: e.sim.au, min: e.sim.min, max: e.sim.max, ...(e.sim.ouverture_inconnue ? { ouverture_inconnue: true } : {}) }
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
  if (!r.ok) return res.status(r.raison === 'conflit_compte' ? 409 : 503).json({ error: r.message, code: r.raison })
  if (geste.cents != null) {
    let o
    try { o = await ordreDesFixes(bien.id) } catch (err) { o = { ok: true } }
    if (!o.ok) {
      const avant = e.actuels.get(geste.niveau)
      const d = avant
        ? await fixerNiveau(supabase, { userId: compte, propertyId: bien.id, niveau: geste.niveau, cents: avant.rate_cents, recommandeCents: avant.recommended_rate_cents })
        : await remettreAuCalcul(supabase, { userId: compte, propertyId: bien.id, niveau: geste.niveau })
      if (!d.ok) console.error('[yield-grille] geste concurrent : annulation impossible', bien.id, geste.niveau)
      return res.status(409).json({ error: 'Un autre changement de la grille vient d’être enregistré : votre montant n’a pas été retenu. Vérifiez à nouveau.', code: 'grille_modifiee' })
    }
  }
  // Les nouveaux prix partent au prochain passage (5 min), pas demain — et si
  // le repere n'a pas pu etre efface, on le DIT (review : l'ecran promettait
  // « dans les 5 minutes » pour des prix qui partiraient le lendemain).
  let envoi = 'immediat'
  if (pilotParYield(bien) && e.sim.nuits > 0) {
    const { error: eM } = await effacerMarqueur(supabase, bien.id)
    if (eM) { console.error('[yield-grille] marqueur non efface', bien.id, eM.message); envoi = 'passage_quotidien' }
  }
  console.log(`[yield-grille] ${bien.id} : ${geste.niveau} -> ${geste.cents == null ? 'au calcul' : geste.cents + ' c'} (${e.sim.nuits} nuit(s))`)
  return res.status(200).json({ ok: true, niveau: geste.niveau, fixe: geste.cents != null, envoi, confirmation, grille: e.sim.grille })
}
