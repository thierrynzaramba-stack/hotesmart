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

// Les mois 'AAAA-MM' de [debut, fin] : la pression de chacun, pour que le
// niveau recommande d'une nuit au-dela de la fenetre se calcule aussi.
function moisEntre (debut, fin) {
  const out = []
  let [a, m] = debut.slice(0, 7).split('-').map(Number)
  const [af, mf] = fin.slice(0, 7).split('-').map(Number)
  while (a < af || (a === af && m <= mf)) {
    out.push(`${a}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) { m = 1; a += 1 }
  }
  return out
}

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
  // ⚠ DEUX BORNES, ET C'EST VOULU (constat de review du 2c).
  //   - `finVue` : douze mois, comme le GET. Ce que la ligne PRENDRA, ses
  //     lignes sans nuit et le journal se lisent la : une ligne sur les
  //     vacances d'ete, posee en novembre sur une fenetre de trois mois,
  //     agit en juillet — la dire « sans nuit » serait faux.
  //   - `fin` : la fenetre de pilotage. Le COMPTE « N nuits vont changer de
  //     prix » ne regarde qu'elle, avec la matiere que le moteur y voit.
  const finVue = decalerAns(aujourdHui, 1)
  const fin = finPilote || finVue
  const ctx = await preparerContexte(supabase, bien, bien.user_id,
    { aujourdHui, debut: aujourdHui, fin, finContexte: finVue, mois: moisEntre(aujourdHui, finVue) })
  // ⚠ Sans la matiere, la resolution partirait sans vacances ni evenements, et
  // le compte dirait « 0 nuit » en silence : on refuse plutot.
  if (!ctx.materiauxPositions) throw new Error('simulerPositions : contexte sans materiauxPositions')
  const proposees = lignesApres(ctx.lignesPosition, operations)
  const positionsApres = positionsDuContexte({ ...ctx.materiauxPositions, lignes: proposees })
  const sansAucune = { ...ctx, positions: { parNuit: new Map(), sansNuit: [] } }

  // Les nuits que chaque ligne du geste prendrait, et ce que YieldFlow y
  // recommandait sans aucun reglage de position.
  const cles = new Set((operations || []).map(cleDePosition))
  const visees = new Map([...cles].map(k => [k, []]))
  const recommandes = new Map([...cles].map(k => [k, {}]))
  for (const [nuit, r] of positionsApres.parNuit) {
    if (nuit < aujourdHui || nuit > finVue) continue
    const k = r.ligne ? cleDePosition(r.ligne) : null
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
      if (nuit < aujourdHui || nuit > finVue || !r.ligne || cleDePosition(r.ligne) !== k) continue
      const s = prixDeLaNuit(sansAucune, nuit, { ouverte: true, vendue: false })
      if (s && s.niveau) recommandes.get(k)[nuit] = s.niveau
    }
  }
  const sansNuit = positionsApres.sansNuit
    .filter(x => x.ligne && cles.has(cleDePosition(x.ligne)))
    .map(x => ({ position: cleDePosition(x.ligne), cle: x.cle, occurrence: x.occurrence, motif: x.motif }))

  // Une ligne posee au-dela de la zone affichee agit quand meme : l'apercu le dit.
  const horsZone = (positionsApres.horsZone || [])
    .filter(x => x.ligne && cles.has(cleDePosition(x.ligne)))
    .map(x => ({ position: cleDePosition(x.ligne), cle: x.cle, occurrence: x.occurrence, largeur: x.largeur }))
  const neutre = { pilote: !!finPilote, nuits: 0, du: null, au: null, min: null, max: null, recommandes, visees, sans_nuit: sansNuit, hors_zone: horsZone }
  if (!finPilote) return neutre
  // ⚠ OUVERTURE INCONNUE : le moteur ne tarife rien — annoncer « N nuits vont
  // changer » serait faux (meme garde que la grille).
  if (ctx.ouvertureConnue === false) return { ...neutre, ouverture_inconnue: true }
  const fermetures = await fermeturesDuBien(supabase, bien.id, aujourdHui, fin)
  const prixHote = await prixHoteDuBien(supabase, bien.id, aujourdHui, fin)
  const lignes = [...ctx.parDate.values()].filter(l => l.date >= aujourdHui && l.date <= fin)
  // ⚠ LA MATIERE DU MOTEUR, PAS CELLE DE LA VUE. Le moteur lit son contexte
  // jusqu'a la fin de sa fenetre : un evenement qui commence apres n'existe
  // pas pour lui, ni son rayonnement (spec §8, limite au bord de la
  // fenetre). Le compte rejoue donc la resolution bornee a `fin`, avec les
  // seules periodes qu'il aurait lues — sinon il annoncerait des nuits que
  // le prochain passage ne changera pas.
  const m = ctx.materiauxPositions
  const commeLeMoteur = l => positionsDuContexte({ ...m, fin, lignes: l,
    vacances: (m.vacances || []).filter(v => v && v.date_debut <= fin),
    evenements: (m.evenements || []).filter(e => e && e.date_debut <= fin) })
  const avantMoteur = { ...ctx, positions: commeLeMoteur(ctx.lignesPosition) }
  const apresMoteur = { ...ctx, positions: commeLeMoteur(proposees) }
  const commun = { aujourdHui, fin, lignes, fermetures, prixHote, ouverts: ctx.ouverts }
  const pA = calculerPrix({ ...commun, prix: (d, o) => prixDeLaNuit(avantMoteur, d, o) })
  const pB = calculerPrix({ ...commun, prix: (d, o) => prixDeLaNuit(apresMoteur, d, o) })
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

module.exports = { simulerPositions, lignesApres, cleDePosition, moisEntre }
