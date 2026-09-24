// tests/saisons-marche.test.js — le QUAND du marche (V2.3.1) : saisons et
// ruptures datees, sur le pacing REEL de Bagneres capture le 24 septembre 2026
// (tests/fixtures/airroi/pacing-bagneres-2026-09-24.json, 342 jours).
//
// LES DEFAUTS QU'ILS EMPECHENT :
//   - des ruptures qui ne retombent pas sur celles mesurees le 22 septembre
//     (19 decembre, 2 janvier, 6 mars) — le signal que la methode est fausse ;
//   - une annee supposee pleine : la fenetre fait 342 jours et finit le
//     31 aout 2027 ; une date hors fenetre est une ABSENCE, pas un zero ;
//   - un trou dans le pacing lu comme zero nuit reservee ;
//   - l'eloignement pris pour une saison (octobre classe au-dessus de fevrier).
//
// CONTRE-EPREUVE (regle 19) : chaque test rejoue contre une mutation du module
// qui porte le defaut (compte rendu du lot) ; il doit rougir sur une VALEUR.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { calendrierDuMarche, saisonDuJour, formeMensuelle, lirePacing, lisser } = require('../lib/marche/saisons')

const FIX = path.join(__dirname, 'fixtures', 'airroi')
const PACING = JSON.parse(fs.readFileSync(path.join(FIX, 'pacing-bagneres-2026-09-24.json'), 'utf8'))
const MARCHE60 = JSON.parse(fs.readFileSync(path.join(FIX, 'marche-60.json'), 'utf8'))
const calculer = (pacing = PACING) => calendrierDuMarche({ pacing, marche60: MARCHE60 })
const sans = dates => ({ ...PACING, results: PACING.results.filter(x => !dates.includes(x.date)) })

test('LE TEST D OR : les ruptures du 22 septembre — 19 decembre, 2 janvier, 6 mars — au jour pres, et ce sont les trois plus fortes', () => {
  const c = calculer()
  assert.equal(c.statut, 'calcule')
  const parDate = new Map(c.ruptures.map(r => [r.date, r]))
  for (const [d, sens] of [['2026-12-19', 'hausse'], ['2027-01-02', 'baisse'], ['2027-03-06', 'baisse']]) {
    assert.ok(parDate.has(d), `rupture du ${d} retrouvee (ruptures : ${c.ruptures.map(r => r.date).join(', ')})`)
    assert.equal(parDate.get(d).sens, sens)
  }
  const fortes = [...c.ruptures].sort((a, b) => Math.abs(Math.log(b.rapport)) - Math.abs(Math.log(a.rapport))).slice(0, 3).map(r => r.date).sort()
  assert.deepEqual(fortes, ['2026-12-19', '2027-01-02', '2027-03-06'])
  // Les saisons qu'elles bornent : Noel et fevrier en tete, le creux d'avant Noel en bas.
  assert.equal(saisonDuJour(c, '2026-12-31').saison, 'tres_forte')
  assert.equal(saisonDuJour(c, '2027-02-20').saison, 'tres_forte')
  assert.equal(saisonDuJour(c, '2026-12-10').saison, 'basse')
  assert.equal(saisonDuJour(c, '2027-03-10').saison, 'moyenne', 'apres le 6 mars, la fin de saison de ski')
})

test('LE TEST QUI COMPTE : la fenetre fait 342 jours, pas 365 — une date hors fenetre est une ABSENCE, jamais un zero ni « basse »', () => {
  const c = calculer()
  assert.deepEqual([c.fenetre.debut, c.fenetre.fin, c.fenetre.jours], ['2026-09-24', '2027-08-31', 342])
  for (const d of ['2027-09-01', '2027-09-23', '2026-09-23']) {
    const s = saisonDuJour(c, d)
    assert.equal(s.saison, null, `${d} : aucune saison inventee`)
    assert.equal(s.motif, 'hors_fenetre')
  }
  // Dans la fenetre, au-dela de l'horizon : « non concluant », avec la forme
  // mensuelle — pas une saison du pacing.
  const juin = saisonDuJour(c, '2027-06-15')
  assert.equal(juin.saison, null)
  assert.equal(juin.motif, 'non_concluant')
  assert.equal(juin.forme_mensuelle.source, 'mensuel')
  // La derniere saison du pacing s'arrete a l'horizon, pas au 31 aout.
  assert.equal(c.saisons[c.saisons.length - 1].fin, c.horizon.fin)
})

test('LE TEST QUI COMPTE : un trou dans le pacing est une absence — Noel reste tres fort, le 2 janvier reste une rupture', () => {
  const trou = ['2026-12-27', '2026-12-28', '2026-12-29']
  const c = calculer(sans(trou))
  assert.deepEqual(c.fenetre.trous, trou)
  assert.equal(c.fenetre.jours, 339)
  for (const d of trou) assert.deepEqual(saisonDuJour(c, d), { jour: d, saison: null, motif: 'absent_du_pacing' })
  assert.equal(saisonDuJour(c, '2026-12-30').saison, 'tres_forte', 'le lissage ne compte pas les jours absents comme des zeros')
  // La valeur lissee elle-meme : la moyenne des SEULS jours presents autour du
  // 30 decembre (27-29 absents) — 283, 295, 274, 148 nuits : 250. Des zeros a
  // la place des absents donneraient 1000 / 7 = 142,9.
  const jours = lirePacing(sans(trou).results).jours
  assert.equal(lisser(jours, '2026-12-30', 'reservees'), 250)
  // Trop de jours absents dans la semaine : pas de moyenne sur un reste.
  const vide = lirePacing(sans(['2026-12-26', '2026-12-27', '2026-12-28', '2026-12-29']).results).jours
  assert.equal(lisser(vide, '2026-12-28', 'reservees'), null)
  assert.ok(c.ruptures.some(r => r.date === '2027-01-02'))
})

test('LE TEST QUI COMPTE : l eloignement n est pas une saison — octobre, tout proche, ne passe pas au-dessus des vacances de fevrier', () => {
  const c = calculer()
  // Brut, octobre (0,16) remplit plus que la mi-fevrier (0,14) : c'est la date proche.
  const brut = d => lirePacing(PACING.results).jours.get(d).remplissage
  assert.ok(brut('2026-10-05') > brut('2027-02-16'))
  assert.notEqual(saisonDuJour(c, '2026-10-05').saison, 'tres_forte')
  assert.equal(saisonDuJour(c, '2027-02-16').saison, 'tres_forte')
  assert.ok(c.eloignement.baisse_par_30_jours > 0.1 && c.eloignement.baisse_par_30_jours < 0.3, `pente mesuree : ${c.eloignement.baisse_par_30_jours}`)
})

test('l horizon se calcule sur les donnees : au-dela de 20 nuits par jour, pas avant', () => {
  const c = calculer()
  assert.equal(c.horizon.fin, '2027-04-11')
  assert.equal(c.horizon.jours, 200)
  assert.match(c.horizon.phrase, /Au-delà du 2027-04-11, moins de 20 nuits réservées par jour/)
  // Un marche ou rien n'atteint 20 nuits : pas de saison inventee.
  const mince = { results: PACING.results.map(x => ({ ...x, booked_count: 5 })) }
  const m = calendrierDuMarche({ pacing: mince })
  assert.equal(m.statut, 'non_calculable')
  assert.match(m.motif, /trop peu de reservations/)
  assert.equal(m.saisons, undefined)
})

test('un point illisible est ecarte AVEC son motif, jamais compte zero ; une date en double aussi', () => {
  const lu = lirePacing([
    { date: '2026-10-01', booked_count: 10, available_count: 90 },
    { date: '2026-10-02', booked_count: 'x', available_count: 90 },
    { date: '2026-10-01', booked_count: 50, available_count: 50 },
    { date: 'demain', booked_count: 1, available_count: 1 }])
  assert.equal(lu.jours.size, 1)
  assert.equal(lu.jours.get('2026-10-01').remplissage, 0.1, 'recalcule, pas le fill_rate arrondi')
  assert.deepEqual(lu.ecartes.map(e => e.motif), ['nuits reservees ou offertes illisibles', 'date en double', 'date illisible'])
})

test('la forme mensuelle : trois ans, et une occupation 0 est une ABSENCE (champ pas encore mesure), pas un creux', () => {
  const f = formeMensuelle(MARCHE60, { apres: '2027-04-11', jusqua: '2027-08-31' })
  assert.deepEqual(f.map(m => m.mois), ['2027-04', '2027-05', '2027-06', '2027-07', '2027-08'])
  assert.ok(f.every(m => m.annees === 3 && m.source === 'mensuel'))
  assert.equal(f.find(m => m.mois === '2027-08').saison, 'tres_forte')
  // La derniere annee a 0 : elle sort du calcul, et la forme est EXACTEMENT
  // celle des trois annees precedentes — pas une moyenne tiree par des zeros.
  const troue = { results: MARCHE60.results.map(l => (l.date >= '2025-09' ? { ...l, occupancy: { ...l.occupancy, avg: 0 } } : l)) }
  const avant = { results: MARCHE60.results.filter(l => l.date < '2025-09') }
  const g = formeMensuelle(troue, { apres: '2027-04-11', jusqua: '2027-08-31' })
  assert.deepEqual(g, formeMensuelle(avant, { apres: '2027-04-11', jusqua: '2027-08-31' }))
})
