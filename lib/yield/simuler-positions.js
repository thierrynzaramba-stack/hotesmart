// lib/yield/simuler-positions.js — CE QU'UN GESTE SUR LES REGLAGES DE POSITION
// CHANGERAIT, AVANT DE L'ENREGISTRER. Lot 2c « Ce qui fait bouger vos prix ».
// Spec : docs/specs/spec-yf-reglages-position.md §7.
//
// ⚠ LECTURE SEULE. Aucune ecriture, aucun appel au canal.
// ⚠ MEME REGLE QUE LA GRILLE (lib/yield/simuler-grille.js, decision 4 de
// Thierry du 30 septembre 2026 : « N nuits vont changer de prix ») : on rejoue
// LA MEME matiere (un seul `preparerContexte`) avec les lignes ACTUELLES puis
// avec les lignes PROPOSEES, et on ne compte que les nuits dont le prix differe
// entre les deux. La regle du prix est celle du moteur (`prixDeLaNuit`), et les
// nuits que `calculerPrix` saute — vendues, fermees, prix au ✎, sans ligne —
// ne sont jamais comptees.
//
// ⚠ CE QUE YIELDFLOW RECOMMANDAIT, NUIT PAR NUIT, AU MOMENT DU GESTE : le
// niveau que le moteur donnerait a la nuit SANS AUCUN reglage de position.
// C'est ce que le journal garde (`recommandes`), meme exigence que
// `grille_hote.recommended_rate_cents`.

const { preparerContexte, prixDeLaNuit } = require('./contexte-du-bien')
const { positionsDuContexte } = require('./positions')
const { calculerPrix } = require('../moteur-prix')
const { fermeturesDuBien } = require('../fermetures')
const { prixHoteDuBien } = require('../prix-hote')
const { finDeFenetre } = require('../pilote-tarifaire')

const nul = v => v === undefined || v === null || v === ''
const cleDePosition = p => [p.evenement, p.zone, nul(p.rang) ? '' : Number(p.rang), p.jour || '', p.nuit || ''].join('|')

function decalerAns (iso, n) {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCFullYear(d.getUTCFullYear() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * Les lignes APRES le geste. `operations` : [{ evenement, zone, rang, jour,
 * nuit, niveau }] — `niveau: null` retire la ligne, sinon la pose ou la remplace.
 */
function lignesApres (actuelles, operations) {
  const m = new Map((actuelles || []).map(l => [cleDePosition(l), { ...l }]))
  for (const o of operations || []) {
    const k = cleDePosition(o)
    if (o.niveau == null) { m.delete(k); continue }
    const avant = m.get(k)
    m.set(k, { ...(avant || {}), id: avant ? avant.id : `propose:${k}`, evenement: o.evenement, zone: o.zone,
      rang: nul(o.rang) ? null : Number(o.rang), jour: o.jour || null, nuit: o.nuit || null, niveau: o.niveau })
  }
  return [...m.values()]
}

/**
 * @param bien       ligne `properties` complete
 * @param operations le geste, deja valide par l'appelant
 * @param aujourdHui 'AAAA-MM-JJ' (Paris)
 * @returns {{ pilote, nuits, du, au, min, max, recommandes, visees, sans_nuit }}
 *   recommandes : Map cle de position -> { nuit: niveau } (pour le journal)
 *   visees      : Map cle de position -> [nuits] que la ligne prendrait
 *   sans_nuit   : les lignes PROPOSEES qui n'auraient aucune nuit
 *   `pilote: false` : bien non pilote, aucun prix du calendrier ne bouge.
 */
async function simulerPositions (supabase, bien, operations, aujourdHui) {
  const finPilote = finDeFenetre(bien, aujourdHui)
  // Un bien non pilote n'a pas de fenetre : les suggestions couvrent l'annee.
  const fin = finPilote || decalerAns(aujourdHui, 1)
  const ctx = await preparerContexte(supabase, bien, bien.user_id, { aujourdHui, debut: aujourdHui, fin })
  // ⚠ Sans la matiere, la resolution partirait sans vacances ni evenements, et
  // le compte dirait « 0 nuit » en silence : on refuse plutot.
  if (!ctx.materiauxPositions) throw new Error('simulerPositions : contexte sans materiauxPositions')
  const proposees = lignesApres(ctx.lignesPosition, operations)
  const positionsApres = positionsDuContexte({ ...ctx.materiauxPositions, lignes: proposees })
  const apres = { ...ctx, positions: positionsApres }
  const sansAucune = { ...ctx, positions: { parNuit: new Map(), sansNuit: [] } }

  // Les nuits que chaque ligne du geste prendrait, et ce que YieldFlow y
  // recommandait sans aucun reglage de position.
  const cles = new Set((operations || []).map(cleDePosition))
  const visees = new Map([...cles].map(k => [k, []]))
  const recommandes = new Map([...cles].map(k => [k, {}]))
  for (const [nuit, r] of positionsApres.parNuit) {
    if (nuit < aujourdHui || nuit > fin) continue
    const k = r.ligne ? cleDePosition({ ...r.ligne, evenement: r.ligne.evenement }) : null
    if (!k || !cles.has(k)) continue
    visees.get(k).push(nuit)
    const s = prixDeLaNuit(sansAucune, nuit, { ouverte: true, vendue: false })
    if (s && s.niveau) recommandes.get(k)[nuit] = s.niveau
  }
  // Une ligne retiree ne vise plus rien ; ce qu'elle tenait se recommande aussi.
  for (const o of operations || []) {
    if (o.niveau != null) continue
    const k = cleDePosition(o)
    for (const [nuit, r] of ctx.positions.parNuit) {
      if (nuit < aujourdHui || nuit > fin || !r.ligne || cleDePosition(r.ligne) !== k) continue
      const s = prixDeLaNuit(sansAucune, nuit, { ouverte: true, vendue: false })
      if (s && s.niveau) recommandes.get(k)[nuit] = s.niveau
    }
  }
  const sansNuit = positionsApres.sansNuit
    .filter(x => x.ligne && cles.has(cleDePosition(x.ligne)))
    .map(x => ({ position: cleDePosition(x.ligne), cle: x.cle, occurrence: x.occurrence, motif: x.motif }))

  const neutre = { pilote: !!finPilote, nuits: 0, du: null, au: null, min: null, max: null, recommandes, visees, sans_nuit: sansNuit }
  if (!finPilote) return neutre
  // ⚠ OUVERTURE INCONNUE : le moteur ne tarife rien — annoncer « N nuits vont
  // changer » serait faux (meme garde que la grille).
  if (ctx.ouvertureConnue === false) return { ...neutre, ouverture_inconnue: true }
  const fermetures = await fermeturesDuBien(supabase, bien.id, aujourdHui, fin)
  const prixHote = await prixHoteDuBien(supabase, bien.id, aujourdHui, fin)
  const lignes = [...ctx.parDate.values()].filter(l => l.date >= aujourdHui && l.date <= fin)
  const commun = { aujourdHui, fin, lignes, fermetures, prixHote, ouverts: ctx.ouverts }
  const pA = calculerPrix({ ...commun, prix: (d, o) => prixDeLaNuit(ctx, d, o) })
  const pB = calculerPrix({ ...commun, prix: (d, o) => prixDeLaNuit(apres, d, o) })
  const pose = p => {
    const m = new Map()
    for (const l of lignes) m.set(l.date, l.rate != null ? Math.round(Number(l.rate) * 100) : null)
    for (const c of p.changements) m.set(c.date, c.prix_centimes)
    return m
  }
  const a = pose(pA)
  const b = pose(pB)
  const changes = []
  for (const [d, v] of b) if (v !== a.get(d)) changes.push({ date: d, apres_centimes: v })
  changes.sort((x, y) => (x.date < y.date ? -1 : 1))
  const prix = changes.map(c => c.apres_centimes).filter(v => v != null)
  return { ...neutre, nuits: changes.length, du: changes[0]?.date || null, au: changes[changes.length - 1]?.date || null,
    min: prix.length ? Math.min(...prix) / 100 : null, max: prix.length ? Math.max(...prix) / 100 : null }
}

module.exports = { simulerPositions, lignesApres, cleDePosition }
