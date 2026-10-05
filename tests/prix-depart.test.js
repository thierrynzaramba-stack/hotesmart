// tests/prix-depart.test.js — les prix de depart d'un bien en 8 cases, ancre ×
// forme (spec §22.11 de docs/kb/chantier-nouveau-bien.md, decisions de Thierry
// du 5 octobre 2026). Fonction pure : aucune base, aucun reseau ; `aujourdhui`
// est injecte (dates figees : le test n'a pas d'horloge).
//
// CE QU'ILS EMPECHENT (vecu du 5 octobre 2026) :
//   - un prix week-end qui DISPARAIT (cran de 1 a 3 €, « Moyen » sous « Base ») ;
//   - un hote compte deux fois parce qu'il a deux annonces ;
//   - une strategie qui recopie un seul bien ou sort du marche ;
//   - un ecart faible ou une montee ratee LISSES au lieu d'etre dits.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { lireJson } = require('../lib/airroi/json')
const P = require('../lib/marche/prix-depart')

const AUJ = '2026-10-05'
const jours = n => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${AUJ}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10))
const JOURS = jours(200)
const estWE = j => [5, 6].includes(new Date(`${j}T00:00:00Z`).getUTCDay())
// La saison du segment, CONTINUE (comme dans les vrais calendriers) : un sommet
// en fevrier, +30 % au plus. Une saison en marches d'escalier ferait des
// egalites aux seuils des quarts (voir le test des egalites).
const saison = j => 1 + 0.3 * Math.max(0, Math.cos((Date.parse(`${j}T00:00:00Z`) - Date.parse('2027-02-10T00:00:00Z')) / (86400000 * 365) * 2 * Math.PI))
// Une annonce synthetique : base × saison × prime week-end.
const annonce = (id, hote, base, { prime = 1.25, position = 'equivalent', plat = false } = {}) => ({
  listing_id: id, hote, position,
  jours: JOURS.map(j => ({ date: j, rate: Math.round(base * (plat ? 1 : saison(j)) * (estWE(j) ? prime : 1) * 100) / 100, min_nights: 2 })),
})
const cinq = (opts = {}) => [annonce('1', 'A', 80, opts), annonce('2', 'B', 110, opts), annonce('3', 'C', 130, opts), annonce('4', 'D', 150, opts), annonce('5', 'E', 200, opts)]
const caseDe = (r, n, t) => r.cases.find(c => c.niveau === n && c.type === t)

test('LE TEST QUI COMPTE (vecu, loft de recette, 5 octobre 2026) : les 8 cases, 7 hotes, le prix week-end garde, tout monte', () => {
  const f = lireJson(fs.readFileSync(path.join(__dirname, 'fixtures', 'airroi', 'prix-depart-loft-2026-10-05.json'), 'utf8'))
  const r = P.prixDeDepart({ calendriers: f.comparables, marche: [], strategie: 'qualite', aujourdhui: '2026-10-05' })
  assert.equal(r.statut, 'calcule')
  assert.deepEqual([r.comparables, r.hotes], [9, 7], '9 annonces, 7 hotes : Charles et Cassandra ne comptent qu une fois')
  assert.equal(r.niveaux_source, 'segment')
  assert.deepEqual(r.ancres, { agressif: 140, juste: 158, qualite: 165 })
  const attendu = { 'creux/semaine': [139, 157, 164], 'creux/weekend': [154, 173, 182], 'modere/semaine': [140, 158, 165], 'modere/weekend': [166, 187, 196],
    'favorable/semaine': [140, 158, 166], 'favorable/weekend': [170, 192, 201], 'pic/semaine': [150, 169, 177], 'pic/weekend': [179, 202, 211] }
  for (const c of r.cases) assert.deepEqual([c.strategies.agressif, c.strategies.juste, c.strategies.qualite], attendu[`${c.niveau}/${c.type}`], `${c.niveau}/${c.type}`)
  assert.deepEqual(r.alertes, [], 'tout monte')
  assert.deepEqual(r.serre, { agressif_juste: 18, juste_qualite: 7 }, 'le marche serre est DIT')
  // Le week-end garde sa prime a chaque niveau.
  for (const n of P.NIVEAUX) assert.ok(caseDe(r, n, 'weekend').prix - caseDe(r, n, 'semaine').prix >= 15, n)
})

test('le week-end se mesure sur les NUITS du vendredi et du samedi (dette 30)', () => {
  assert.equal(P.typeDe('2026-10-09'), 'weekend', 'vendredi')
  assert.equal(P.typeDe('2026-10-10'), 'weekend', 'samedi')
  assert.equal(P.typeDe('2026-10-11'), 'semaine', 'dimanche soir : on repart lundi')
})

test('LE TEST QUI COMPTE : la prime week-end de chaque hote, mesuree contre SON propre prix, survit — et la saison du segment fait monter les niveaux', () => {
  const r = P.prixDeDepart({ calendriers: cinq(), marche: [], strategie: 'juste', aujourdhui: AUJ })
  assert.equal(r.statut, 'calcule')
  assert.equal(r.niveaux_source, 'segment')
  for (const n of P.NIVEAUX) {
    const se = caseDe(r, n, 'semaine')
    const we = caseDe(r, n, 'weekend')
    if (se.statut === 'calcule' && we.statut === 'calcule') assert.ok(Math.abs(we.forme / se.forme - 1.25) < 0.02, `${n} : prime 25 % gardee (${we.forme} / ${se.forme})`)
  }
  assert.ok(caseDe(r, 'pic', 'semaine').prix > caseDe(r, 'creux', 'semaine').prix, 'la saison monte')
  assert.deepEqual(r.alertes, [])
})

test('LE TEST QUI COMPTE : un hote = une voix — une seconde annonce du meme hote ne deplace pas les ancres', () => {
  const seul = P.prixDeDepart({ calendriers: cinq(), marche: [], strategie: 'juste', aujourdhui: AUJ })
  const double = P.prixDeDepart({ calendriers: [...cinq(), annonce('6', 'E', 200)], marche: [], strategie: 'juste', aujourdhui: AUJ })
  assert.deepEqual([double.hotes, double.comparables], [5, 6])
  assert.deepEqual(double.ancres, seul.ancres)
})

test('moins de 5 hotes independants : rien n est calcule, et c est dit', () => {
  const r = P.prixDeDepart({ calendriers: [...cinq().slice(0, 4), annonce('6', 'D', 160)], marche: [], strategie: 'juste', aujourdhui: AUJ })
  assert.equal(r.statut, 'non_calculable')
  assert.match(r.motif, /4 hôtes indépendants parmi vos comparables : il en faut au moins 5/)
})

test('les strategies se placent aux PERCENTILES 25 / 50 / 75 des ancres, jamais aux bords', () => {
  const r = P.prixDeDepart({ calendriers: cinq({ plat: true, prime: 1 }), marche: JOURS.map(j => ({ jour: j, niveau: 'modere' })), strategie: 'juste', aujourdhui: AUJ })
  // Ancres 80, 110, 130, 150, 200 : P25 = 110, P50 = 130, P75 = 150.
  assert.deepEqual(r.ancres, { agressif: 110, juste: 130, qualite: 150 })
})

test('les positions decalent l ancre d un quart de la largeur au plus', () => {
  const dessus = P.prixDeDepart({ calendriers: cinq({ plat: true, prime: 1, position: 'dessus' }), marche: JOURS.map(j => ({ jour: j, niveau: 'modere' })), strategie: 'juste', aujourdhui: AUJ })
  // Largeur des ancres 200 − 80 = 120 ; un quart : +30 €.
  assert.deepEqual(dessus.ancres, { agressif: 140, juste: 160, qualite: 180 })
  assert.equal(dessus.position, 1)
})

test('segment trop plat (moins de 10 %) : repli sur les niveaux du marche ; sans marche, non calculable', () => {
  const plats = cinq({ plat: true })
  const repli = P.prixDeDepart({ calendriers: plats, marche: JOURS.map(j => ({ jour: j, niveau: j.slice(5, 7) === '12' ? 'pic' : 'creux' })), strategie: 'juste', aujourdhui: AUJ })
  assert.equal(repli.niveaux_source, 'marche')
  assert.equal(caseDe(repli, 'pic', 'semaine').statut, 'calcule')
  const sans = P.prixDeDepart({ calendriers: plats, marche: [], strategie: 'juste', aujourdhui: AUJ })
  assert.equal(sans.statut, 'non_calculable')
  assert.match(sans.motif, /changent trop peu de prix/)
})

test('jamais hors marche : le prix reste dans la fourchette de sa case', () => {
  const r = P.prixDeDepart({ calendriers: cinq({ position: 'dessus' }), marche: [], strategie: 'qualite', aujourdhui: AUJ })
  for (const c of r.cases.filter(x => x.statut === 'calcule')) for (const v of Object.values(c.strategies)) assert.ok(v >= c.fourchette.bas && v <= c.fourchette.haut, `${c.niveau}/${c.type}`)
})

test('LE TEST QUI COMPTE : une montee ratee est SIGNALEE, jamais lissee', () => {
  // Les hotes vendent leurs week-ends d'hiver MOINS cher que leurs semaines.
  const inverses = cinq().map(c => ({ ...c, jours: c.jours.map(n => ({ ...n, rate: estWE(n.date) && saison(n.date) > 1.2 ? n.rate * 0.6 : n.rate })) }))
  const r = P.prixDeDepart({ calendriers: inverses, marche: [], strategie: 'juste', aujourdhui: AUJ })
  assert.ok(r.alertes.some(a => a.type === 'weekend'), 'week-end sous la semaine : dit')
  const c = r.alertes.find(a => a.type === 'weekend')
  assert.equal(caseDe(r, c.niveau, 'weekend').strategies[c.strategie], c.prix, 'le prix affiche est le prix calcule, pas un prix retouche')
})

test('un marche serre (moins de 10 € entre deux strategies) est DIT', () => {
  const serres = [annonce('1', 'A', 100), annonce('2', 'B', 104), annonce('3', 'C', 106), annonce('4', 'D', 108), annonce('5', 'E', 112)]
  const r = P.prixDeDepart({ calendriers: serres, marche: [], strategie: 'juste', aujourdhui: AUJ })
  assert.ok(r.serre && r.serre.juste_qualite < 10)
  const large = P.prixDeDepart({ calendriers: cinq(), marche: [], strategie: 'juste', aujourdhui: AUJ })
  assert.equal(large.serre, null)
})

test('un hote a plus du double des autres dans TOUTES les cases est signale, jamais ecarte', () => {
  const r = P.prixDeDepart({ calendriers: [...cinq().slice(0, 4), annonce('5', 'E', 600)], marche: [], strategie: 'juste', aujourdhui: AUJ })
  assert.deepEqual(r.a_verifier, ['5'])
  assert.equal(r.hotes, 5, 'toujours compte')
})

test('seules les nuits des 6 prochains mois comptent — ni le passe, ni au-dela', () => {
  const loin = cinq().map(c => ({ ...c, jours: [...c.jours, { date: '2025-01-03', rate: 9999 }, { date: '2027-09-03', rate: 9999 }] }))
  const r = P.prixDeDepart({ calendriers: loin, marche: [], strategie: 'juste', aujourdhui: AUJ })
  const reference = P.prixDeDepart({ calendriers: cinq(), marche: [], strategie: 'juste', aujourdhui: AUJ })
  assert.deepEqual(r.cases, reference.cases)
})

test('strategie ou date absente : non calculable, jamais un prix', () => {
  assert.equal(P.prixDeDepart({ calendriers: cinq(), marche: [], strategie: null, aujourdhui: AUJ }).statut, 'non_calculable')
  assert.equal(P.prixDeDepart({ calendriers: cinq(), marche: [], strategie: 'juste', aujourdhui: null }).statut, 'non_calculable')
})

test('une saison en marches d escalier : un niveau vide est NON CALCULABLE, et dit — jamais rempli au hasard', () => {
  const marches = cinq().map(c => ({ ...c, jours: c.jours.map(n => ({ ...n, rate: Math.round(c.jours[0].rate / (estWE(c.jours[0].date) ? 1.25 : 1) * (['12', '01', '02', '03'].includes(n.date.slice(5, 7)) ? 1.2 : 1) * (estWE(n.date) ? 1.25 : 1) * 100) / 100 })) }))
  const r = P.prixDeDepart({ calendriers: marches, marche: [], strategie: 'juste', aujourdhui: AUJ })
  const vides = r.cases.filter(c => c.statut === 'non_calculable')
  assert.ok(vides.length > 0)
  assert.ok(vides.every(c => /hôte avec des prix dans cette case/.test(c.motif)))
})
