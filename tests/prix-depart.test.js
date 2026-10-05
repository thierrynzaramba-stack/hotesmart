// tests/prix-depart.test.js — les prix de depart d'un bien, niveau par niveau
// (spec §22.7 de docs/kb/chantier-nouveau-bien.md).
//
// CE QU'ILS EMPECHENT :
//   - un comparable qui ne suit pas le marche peserait autant qu'un autre ;
//   - un cran de prix faux ; une strategie mal appliquee ;
//   - une position (dessous / dessus) qui decalerait dans le mauvais sens ;
//   - un prix tire de moins de 3 comparables, ou d'un niveau trop peu mesure.
const test = require('node:test')
const assert = require('node:assert/strict')
const p = require('../lib/marche/prix-depart')

// Un marche synthetique : 40 jours par niveau, ecarts -6 / 0 / 4 / 9.
const ECARTS = { creux: -6, modere: 0, favorable: 4, pic: 9 }
const MARCHE = []
let d = Date.UTC(2026, 9, 1)
for (const niveau of Object.keys(ECARTS)) for (let i = 0; i < 40; i++, d += 86400000) MARCHE.push({ jour: new Date(d).toISOString().slice(0, 10), ecart: ECARTS[niveau], niveau })
// Un calendrier : le prix est une fonction du jour de marche.
const cal = (id, position, f, minNuits = 2) => ({ listing_id: id, position, jours: MARCHE.map(m => ({ date: m.jour, rate: f(m), min_nights: minNuits })) })
// Prix par niveau : base + pas * rang du niveau (0..3), donc un cran = pas.
const RANG = { creux: 0, modere: 1, favorable: 2, pic: 3 }
const etage = (base, pas) => m => base + pas * RANG[m.niveau]
const niv = (r, n) => r.niveaux.find(x => x.niveau === n)

test('LE TEST QUI COMPTE : la note de coherence — 1 si le prix suit le marche, 0 s il est fixe ou a contre-sens ; null sous 30 nuits', () => {
  const parJour = new Map(MARCHE.map(m => [m.jour, m]))
  assert.equal(p.noteCoherence(cal('a', 'equivalent', etage(100, 10)).jours, parJour), 1)
  assert.equal(p.noteCoherence(cal('b', 'equivalent', () => 120).jours, parJour), 0)
  assert.equal(p.noteCoherence(cal('c', 'equivalent', m => 200 - 10 * RANG[m.niveau]).jours, parJour), 0, 'a contre-sens : 0, jamais negatif')
  assert.equal(p.noteCoherence(cal('d', 'equivalent', etage(100, 10)).jours.slice(0, 29), parJour), null)
})

test('LE TEST QUI COMPTE : le cran = l ecart moyen d un niveau au suivant, pondere par les notes', () => {
  // Deux comparables qui suivent (cran 10 et 20) : cran 15.
  const r = p.prixDeDepart({ calendriers: [cal('1', 'equivalent', etage(100, 10)), cal('2', 'equivalent', etage(100, 20)), cal('3', 'equivalent', etage(100, 15))], marche: MARCHE, strategie: 'juste' })
  assert.equal(r.cran, 15)
  // Un comparable a prix fixe (cran 0) ne pese que 0,1 : le cran reste pres de 15.
  const r2 = p.prixDeDepart({ calendriers: [cal('1', 'equivalent', etage(100, 10)), cal('2', 'equivalent', etage(100, 20)), cal('3', 'equivalent', () => 150)], marche: MARCHE, strategie: 'juste' })
  assert.equal(r2.cran, 14, '(10 + 20 + 0 × 0,1) / 2,1 ≈ 14')
})

test('LE TEST QUI COMPTE : prix marche = moyenne PONDEREE, chaque prix decale d un demi-cran selon la position', () => {
  // Trois comparables a 100 au Creux, cran 10 ; positions dessous / equivalent / dessus.
  const cs = [cal('1', 'dessous', etage(100, 10)), cal('2', 'equivalent', etage(100, 10)), cal('3', 'dessus', etage(100, 10))]
  const r = p.prixDeDepart({ calendriers: cs, marche: MARCHE, strategie: 'juste' })
  assert.equal(r.cran, 10)
  assert.equal(niv(r, 'creux').prix, 100, '(95 + 100 + 105) / 3')
  // L'hote en dessous de tous : un demi-cran plus bas.
  const bas = p.prixDeDepart({ calendriers: cs.map(c => ({ ...c, position: 'dessous' })), marche: MARCHE, strategie: 'juste' })
  assert.equal(niv(bas, 'creux').prix, 95)
  const haut = p.prixDeDepart({ calendriers: cs.map(c => ({ ...c, position: 'dessus' })), marche: MARCHE, strategie: 'juste' })
  assert.equal(niv(haut, 'creux').prix, 105)
})

test('LE TEST QUI COMPTE : un comparable qui ne suit pas le marche pese peu dans le prix marche', () => {
  // Deux suiveurs a 100 au Creux, un fixe a 200 : la moyenne ponderee reste pres de 100.
  const r = p.prixDeDepart({ calendriers: [cal('1', 'equivalent', etage(100, 10)), cal('2', 'equivalent', etage(100, 10)), cal('3', 'equivalent', () => 200)], marche: MARCHE, strategie: 'juste' })
  assert.equal(niv(r, 'creux').prix, 105, '(100 + 100 + 200 × 0,1) / 2,1 ≈ 104,8 → 105')
})

test('LE TEST QUI COMPTE : agressif = prix marche − un cran ; haut de gamme = le plus cher qui suit le marche + un cran', () => {
  const cs = [cal('1', 'equivalent', etage(100, 10)), cal('2', 'equivalent', etage(120, 10)), cal('3', 'equivalent', etage(110, 10)), cal('4', 'equivalent', () => 300)]
  const marcheR = p.prixDeDepart({ calendriers: cs, marche: MARCHE, strategie: 'juste' })
  const agr = p.prixDeDepart({ calendriers: cs, marche: MARCHE, strategie: 'agressif' })
  const hg = p.prixDeDepart({ calendriers: cs, marche: MARCHE, strategie: 'qualite' })
  assert.equal(marcheR.cran, 10)
  for (const n of ['creux', 'modere', 'favorable', 'pic']) {
    assert.ok(niv(agr, n).prix <= niv(marcheR, n).prix - 5, `${n} : agressif sous le marche`)
  }
  // Haut de gamme : le plus cher des SUIVEURS (120 au Creux) + 10, pas le fixe a 300.
  assert.equal(niv(hg, 'creux').prix, 130)
  assert.equal(niv(hg, 'pic').prix, 160)
  // Sans aucun suiveur, le plus cher de tous.
  const plats = p.prixDeDepart({ calendriers: [cal('1', 'equivalent', () => 100), cal('2', 'equivalent', () => 120), cal('3', 'equivalent', etage(110, 10))], marche: MARCHE, strategie: 'qualite' })
  // Seul le 3e suit : 110 + cran ; le cran pese les deux fixes a 0,1 :
  // (0 × 0,1 + 0 × 0,1 + 10 × 1) / 1,2 ≈ 8,3 → 118,3 → 120.
  assert.equal(plats.cran, 8)
  assert.equal(niv(plats, 'creux').prix, 120)
})

test('LE TEST QUI COMPTE : moins de 3 comparables avec un prix a un niveau — non calculable, avec son motif', () => {
  const cs = [cal('1', 'equivalent', etage(100, 10)), cal('2', 'equivalent', etage(100, 10)), cal('3', 'equivalent', etage(100, 10))]
  cs[2].jours = cs[2].jours.map(j => (MARCHE.find(m => m.jour === j.date).niveau === 'pic' ? { ...j, rate: null } : j))
  const r = p.prixDeDepart({ calendriers: cs, marche: MARCHE, strategie: 'juste' })
  assert.equal(niv(r, 'pic').statut, 'non_calculable')
  assert.match(niv(r, 'pic').motif, /2 comparables avec un prix à ce niveau \(il en faut 3\)/)
  assert.equal(niv(r, 'creux').statut, 'calcule')
})

test('un niveau ou un comparable a moins de 3 nuits ne compte pas pour lui ; un prix nul ou aberrant n est pas un prix', () => {
  const cs = [cal('1', 'equivalent', etage(100, 10)), cal('2', 'equivalent', etage(100, 10)), cal('3', 'equivalent', etage(100, 10))]
  cs[0].jours = cs[0].jours.map((j, i) => (i % 2 ? { ...j, rate: 0 } : i % 3 ? { ...j, rate: 'cher' } : j))
  const r = p.prixDeDepart({ calendriers: cs, marche: MARCHE, strategie: 'juste' })
  assert.equal(niv(r, 'creux').statut, 'calcule')
  assert.equal(niv(r, 'creux').prix, 100)
})

test('la fourchette du marche va du plus bas au plus haut prix des comparables a ce niveau ; arrondi aux 5 € superieurs', () => {
  const cs = [cal('1', 'equivalent', etage(91, 10)), cal('2', 'equivalent', etage(100, 10)), cal('3', 'equivalent', etage(117, 10))]
  const r = p.prixDeDepart({ calendriers: cs, marche: MARCHE, strategie: 'juste' })
  assert.deepEqual(niv(r, 'creux').fourchette, { bas: 91, haut: 117 })
  assert.equal(niv(r, 'creux').prix % 5, 0)
})

test('LE TEST QUI COMPTE : l effet du sejour minimum sur le prix — 1 nuit contre 2 ou plus, a partir de 2 comparables de chaque cote', () => {
  const cs = [cal('1', 'equivalent', etage(100, 10), 1), cal('2', 'equivalent', etage(110, 10), 1), cal('3', 'equivalent', etage(90, 10), 2), cal('4', 'equivalent', etage(80, 10), 3)]
  const r = p.prixDeDepart({ calendriers: cs, marche: MARCHE, strategie: 'juste' })
  assert.equal(r.sejour.statut, 'calcule')
  assert.ok(r.sejour.ecart_pct < 0, 'ici, imposer 2 nuits va avec un prix par nuit plus bas')
  const un = p.prixDeDepart({ calendriers: cs.slice(0, 3), marche: MARCHE, strategie: 'juste' })
  assert.equal(un.sejour.statut, 'non_calculable')
})

test('sans strategie, ou sans calendrier du marche : non calculable', () => {
  assert.equal(p.prixDeDepart({ calendriers: [], marche: MARCHE, strategie: 'luxe' }).statut, 'non_calculable')
  assert.match(p.prixDeDepart({ calendriers: [], marche: [], strategie: 'juste' }).motif, /calendrier du marché est absent/)
})

test('la liste des comparables ne porte que la note, la mention et la position (la fourchette et l effet du sejour minimum, eux, sont des montants — voulus, §22.7)', () => {
  const cs = [cal('1', 'dessous', etage(100, 10)), cal('2', 'equivalent', etage(100, 10)), cal('3', 'dessus', etage(100, 10))]
  const r = p.prixDeDepart({ calendriers: cs, marche: MARCHE, strategie: 'juste' })
  for (const c of r.comparables) assert.deepEqual(Object.keys(c).sort(), ['listing_id', 'mention', 'note', 'position'])
})

test('agressif retire EXACTEMENT un cran (pas 10 %) ; l arrondi est aux 5 € SUPERIEURS (pas au plus proche)', () => {
  // Marche a 200 au Creux, cran 10 : agressif 190 (10 % donnerait 180).
  const cs = [cal('1', 'equivalent', etage(200, 10)), cal('2', 'equivalent', etage(200, 10)), cal('3', 'equivalent', etage(200, 10))]
  assert.equal(niv(p.prixDeDepart({ calendriers: cs, marche: MARCHE, strategie: 'agressif' }), 'creux').prix, 190)
  // Moyenne 101 : arrondie a 105 (le plus proche donnerait 100).
  const ar = [cal('1', 'equivalent', etage(95, 10)), cal('2', 'equivalent', etage(100, 10)), cal('3', 'equivalent', etage(108, 10))]
  assert.equal(niv(p.prixDeDepart({ calendriers: ar, marche: MARCHE, strategie: 'juste' }), 'creux').prix, 105)
})

// ─── Constats de la review de f37b7da ───────────────────────────────────────
test('REVIEW (C1) : un cran nul ou negatif ne s applique pas — non calculable, avec son motif (sinon les strategies s inversent)', () => {
  const fixes = [cal('1', 'equivalent', () => 110), cal('2', 'equivalent', () => 110), cal('3', 'equivalent', () => 110)]
  const r = p.prixDeDepart({ calendriers: fixes, marche: MARCHE, strategie: 'agressif' })
  assert.ok(r.niveaux.every(n => n.statut === 'non_calculable'))
  assert.match(niv(r, 'creux').motif, /ne montent pas avec le marché/)
  const inverses = [1, 2, 3].map(i => cal(String(i), 'equivalent', m => 200 - 20 * RANG[m.niveau]))
  assert.equal(niv(p.prixDeDepart({ calendriers: inverses, marche: MARCHE, strategie: 'agressif' }), 'creux').statut, 'non_calculable')
})

test('REVIEW (C2) : l arrondi ignore l artefact de virgule flottante — 240 reste 240 ; un prix negatif n est pas un prix', () => {
  // Trois comparables a 240 au Creux, poids differents : 240,00000000000003 donnait 245.
  const cs = [cal('1', 'equivalent', etage(240, 10)), cal('2', 'equivalent', etage(240, 10)), cal('3', 'equivalent', etage(240, 10))]
  assert.equal(niv(p.prixDeDepart({ calendriers: cs, marche: MARCHE, strategie: 'juste' }), 'creux').prix, 240)
  const bas = [cal('1', 'equivalent', etage(2, 30)), cal('2', 'equivalent', etage(2, 30)), cal('3', 'equivalent', etage(2, 30))]
  assert.equal(niv(p.prixDeDepart({ calendriers: bas, marche: MARCHE, strategie: 'agressif' }), 'creux').statut, 'non_calculable')
})

test('RE-REVIEW : un prix agressif qui s arrondit a 0 € n est pas un prix', () => {
  // Marche au creux a 10,003 €, cran de 10 € : l'agressif brut vaut 0,003 €.
  const r = p.prixDeDepart({ calendriers: ['A', 'B', 'C'].map(id => cal(id, 'equivalent', etage(10.003, 10))), marche: MARCHE, strategie: 'agressif' })
  assert.equal(niv(r, 'creux').statut, 'non_calculable')
  assert.match(niv(r, 'creux').motif, /pas positif/)
  assert.equal(niv(r, 'modere').prix, 10, '10,003 € arrondi au centime')
})
