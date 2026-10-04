// tests/progression-marche.test.js — les annees superposees et la progression
// du marche (pipeline de l'HISTORIQUE, spec §16.2 de
// docs/kb/chantier-nouveau-bien.md, lot G1).
//
// CE QU'ILS EMPECHENT :
//   - une annee PARTIELLE comptee comme complete ;
//   - une progression calculee sur des mois non comparables (absents d'un cote,
//     ou de moins de 30 annonces actives) ;
//   - une progression tiree de trop peu de mois (sous 9 : non calculable) ;
//   - un mois de moins de 30 annonces qui produirait un %.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const p = require('../lib/marche/progression-marche')
const { lireJson } = require('../lib/airroi/json')

const MARCHE60 = lireJson(fs.readFileSync(path.join(__dirname, 'fixtures', 'airroi', 'marche-60.json'), 'utf8'))

// Une serie synthetique : `n` mois a partir de `debut`, valeurs par fonction.
function serie (debut, n, f = () => ({})) {
  const out = []
  let [a, m] = debut.split('-').map(Number)
  for (let i = 0; i < n; i++) {
    const mois = `${a}-${String(m).padStart(2, '0')}`
    out.push({ mois, adr: 100, occupation: 0.5, revpar: 50, annonces: 200, couverture_partielle: false, ...f(i, mois) })
    m++; if (m > 12) { m = 1; a++ }
  }
  return out
}

test('LE TEST QUI COMPTE : sur les 60 mois reels, 2021 et 2026 sont PARTIELLES, les autres completes', () => {
  const r = p.progressionDuMarche(MARCHE60)
  assert.equal(r.statut, 'calcule')
  const etat = Object.fromEntries(r.annees.map(a => [a.annee, a.partielle]))
  assert.deepEqual(etat, { 2021: true, 2022: false, 2023: false, 2024: false, 2025: false, 2026: true })
  assert.equal(r.annees.find(a => a.annee === '2026').mois_mesures, 8)
  assert.ok(r.annees.find(a => a.annee === '2022').couverture_partielle, 'la couverture partielle connue reste signalee')
  for (const a of r.annees) assert.equal(a.mois.length, 12, 'douze cases, janvier a decembre')
})

test('LE TEST QUI COMPTE : aucun total ni moyenne ANNUELS ne sort — seulement les mois', () => {
  const r = p.progressionDuMarche(MARCHE60)
  for (const a of r.annees) {
    assert.deepEqual(Object.keys(a).sort(), ['annee', 'couverture_partielle', 'mois', 'mois_mesures', 'partielle'])
  }
})

test('progression reelle : 12 derniers mois glissants contre les 12 precedents', () => {
  const r = p.progressionDuMarche(MARCHE60).progression
  assert.equal(r.statut, 'calcule')
  assert.deepEqual(r.periode, { debut: '2025-09', fin: '2026-08' })
  assert.deepEqual(r.precedente, { debut: '2024-09', fin: '2025-08' })
  assert.equal(r.indicateurs.adr.pct, 8.3)
  assert.equal(r.indicateurs.occupation.pct, -9.7)
  assert.equal(r.indicateurs.revpar.pct, -1.4)
  assert.equal(r.indicateurs.annonces.pct, 11.3)
  for (const k of p.INDICATEURS) assert.equal(r.indicateurs[k].mois_comparables, 12)
})

test('la progression = rapport des MOYENNES des mois comparables, pas une moyenne de %', () => {
  // Annee 1 : 100 partout. Annee 2 : 100 sauf un mois a 220 → moyenne 110 → +10 %.
  const s = serie('2024-01', 24, i => ({ adr: i === 23 ? 220 : 100 }))
  assert.equal(p.progression(s).indicateurs.adr.pct, 10)
})

test('LE TEST QUI COMPTE : un mois de moins de 30 annonces, d un cote OU de l autre, sort du calcul', () => {
  // Le mois a 15 annonces porte un ADR enorme : s'il entrait, la progression exploserait.
  const recent = serie('2024-01', 24, i => (i === 20 ? { adr: 10000, annonces: 15 } : {}))
  const r1 = p.progression(recent).indicateurs.adr
  assert.equal(r1.pct, 0)
  assert.equal(r1.mois_comparables, 11)
  const ancien = serie('2024-01', 24, i => (i === 8 ? { adr: 1, annonces: 29 } : {}))
  const r2 = p.progression(ancien).indicateurs.adr
  assert.equal(r2.pct, 0)
  assert.equal(r2.mois_comparables, 11)
  // 30 annonces exactement : le mois compte.
  const juste = serie('2024-01', 24, i => (i === 20 ? { adr: 220, annonces: 30 } : {}))
  assert.equal(p.progression(juste).indicateurs.adr.mois_comparables, 12)
})

test('un mois absent d un cote sort du calcul, sans etre lu comme zero', () => {
  const s = serie('2024-01', 24, i => (i === 3 ? { adr: null } : {}))
  const r = p.progression(s).indicateurs.adr
  assert.equal(r.pct, 0)
  assert.equal(r.mois_comparables, 11)
})

test('LE TEST QUI COMPTE : sous 9 mois comparables, non calculable avec son motif ; 9 suffisent', () => {
  const huit = serie('2024-01', 24, i => (i >= 12 && i < 16 ? { annonces: 10 } : {}))
  const r8 = p.progression(huit).indicateurs.adr
  assert.equal(r8.pct, null)
  assert.equal(r8.mois_comparables, 8)
  assert.match(r8.motif, /8 mois comparables sur 12 \(il en faut 9\)/)
  const neuf = serie('2024-01', 24, i => (i >= 12 && i < 15 ? { annonces: 10 } : {}))
  assert.equal(p.progression(neuf).indicateurs.adr.mois_comparables, 9)
  assert.equal(p.progression(neuf).indicateurs.adr.pct, 0)
})

test('moins de 24 mois d historique : non calculable', () => {
  const r = p.progression(serie('2024-01', 23))
  assert.equal(r.statut, 'non_calculable')
  assert.match(r.motif, /24 mois/)
})

test('la periode recente finit au dernier mois MESURE, pas a un mois vide en queue', () => {
  const s = serie('2024-01', 26, i => (i >= 24 ? { adr: null, occupation: null, revpar: null, annonces: null } : {}))
  assert.deepEqual(p.progression(s).periode, { debut: '2025-01', fin: '2025-12' })
})

test('mois par mois : 12 lignes, chacune contre le MEME mois un an avant ; peu d annonces = pas de %', () => {
  const s = serie('2024-01', 24, i => ({ adr: i < 12 ? 100 : 110, ...(i === 18 ? { annonces: 12 } : {}) }))
  const d = p.moisParMois(s)
  assert.equal(d.length, 12)
  assert.equal(d[0].mois, '2025-01')
  assert.equal(d[0].mois_precedent, '2024-01')
  assert.equal(d[0].adr.pct, 10)
  const faible = d.find(x => x.mois === '2025-07')
  assert.equal(faible.peu_annonces, true)
  assert.equal(faible.adr.pct, null, 'affiche, sans %')
  assert.equal(faible.adr.valeur, 110, 'la valeur reste montree')
})

test('les cases d une annee signalent le mois de peu d annonces, sans le retirer', () => {
  const s = serie('2024-01', 12, i => (i === 5 ? { annonces: 8 } : {}))
  const a = p.annees(s)[0]
  assert.equal(a.partielle, false)
  assert.equal(a.mois[5].peu_annonces, true)
  assert.equal(a.mois[5].adr, 100)
})

test('historique absent : non calculable, rien d invente', () => {
  const r = p.progressionDuMarche({})
  assert.equal(r.statut, 'non_calculable')
  assert.deepEqual(r.annees, [])
})

// ─── Constats de la review de bc2e023 ───────────────────────────────────────
const sans = (mois) => ({ ...MARCHE60, results: MARCHE60.results.filter(r => r.date.slice(0, 7) !== mois) })
const avecQueue = (ligne) => ({ ...MARCHE60, results: [...MARCHE60.results, ligne] })

test('REVIEW : un mois qui ne porte QUE le nombre d annonces n est pas mesure — la fenetre ne glisse pas, l annee reste partielle', () => {
  const r = p.progressionDuMarche(avecQueue({ date: '2026-09-01', active_listings_count: 900 }))
  assert.deepEqual(r.progression.periode, { debut: '2025-09', fin: '2026-08' })
  assert.equal(r.progression.indicateurs.annonces.pct, 11.3)
  assert.equal(r.annees.find(a => a.annee === '2026').mois_mesures, 8)
  assert.equal(r.mois_par_mois[11].mois, '2026-08')
})

test('REVIEW : un trou dans la reponse BRUTE garde l alignement (la serie est comblee) et sort le mois du calcul', () => {
  const r = p.progressionDuMarche(sans('2025-03'))
  assert.deepEqual(r.progression.periode, { debut: '2025-09', fin: '2026-08' })
  assert.deepEqual(r.progression.precedente, { debut: '2024-09', fin: '2025-08' })
  for (const k of p.INDICATEURS) assert.equal(r.progression.indicateurs[k].mois_comparables, 11, k)
})

test('REVIEW : un mois sans son mois de l an dernier dit « precedent absent », pas « peu d annonces »', () => {
  const r = p.progressionDuMarche(sans('2025-03'))
  const mars = r.mois_par_mois.find(m => m.mois === '2026-03')
  assert.equal(mars.precedent_absent, true)
  assert.equal(mars.peu_annonces, false)
  assert.equal(mars.adr.pct, null)
  const avril = r.mois_par_mois.find(m => m.mois === '2026-04')
  assert.equal(avril.precedent_absent, false)
  assert.equal(avril.peu_annonces, false)
  assert.equal(typeof avril.adr.pct, 'number')
})

test('REVIEW : des annonces absentes font sortir le mois de la progression des annonces aussi', () => {
  const s = serie('2024-01', 24, i => (i === 20 ? { annonces: null } : {}))
  assert.equal(p.progression(s).indicateurs.annonces.mois_comparables, 11)
})
