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
const { calendrierDuMarche, saisonDuJour, formeMensuelle, lirePacing, lisser, ordonnerSaisons, comparerSaisons, rangDansSonRegime, RegimesMelanges } = require('../lib/marche/saisons')

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
  // Un rapport `null` ne se classe pas « le plus fort » (log de null = -∞).
  const fortes = c.ruptures.filter(r => r.rapport > 0)
    .sort((a, b) => Math.abs(Math.log(b.rapport)) - Math.abs(Math.log(a.rapport))).slice(0, 3).map(r => r.date).sort()
  assert.deepEqual(fortes, ['2026-12-19', '2027-01-02', '2027-03-06'])
  for (const d of fortes) assert.equal(parDate.get(d).datee_au_jour, true)
  // La liste ENTIERE, figee sur la fixture : aucune rupture parasite ne
  // s'ajoute sans que ce test le dise (review).
  assert.deepEqual(c.ruptures.map(r => r.date), ['2026-10-01', '2026-10-25', '2026-12-19', '2026-12-26', '2027-01-02',
    '2027-01-22', '2027-01-29', '2027-02-13', '2027-03-06', '2027-03-28'])
  // Aucune saison sous 5 jours, recalage compris.
  for (const x of c.saisons) assert.ok((Date.parse(x.fin) - Date.parse(x.debut)) / 86400000 + 1 >= 5, `${x.debut} → ${x.fin}`)
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
  // Le regime aussi, comme toute reponse (review) : un trou avant l'horizon est du pacing.
  for (const d of trou) assert.deepEqual(saisonDuJour(c, d), { jour: d, saison: null, motif: 'absent_du_pacing', regime: 'pacing' })
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
  // ⚠ REECRIT LE 24 SEPTEMBRE 2026 (regle 17) : la premiere version exigeait
  // « tres_forte » pour aout. Avec la mediane et le plancher d'amplitude
  // (Thierry), les douze mois ne se separent qu'en TROIS niveaux (basse
  // 0,87-1,13 ; moyenne 1,18-1,24 ; haute : fevrier 1,75, aout 1,55) : la plus
  // haute s'appelle « forte ». Ce qui compte : aout est dans la saison la plus
  // haute, avec fevrier.
  const douze = formeMensuelle(MARCHE60, { apres: '2026-09-01', jusqua: '2027-08-31' })
  const haute = douze.reduce((m, x) => Math.max(m, ['basse', 'moyenne', 'forte', 'tres_forte'].indexOf(x.saison)), -1)
  assert.equal(['basse', 'moyenne', 'forte', 'tres_forte'].indexOf(f.find(m => m.mois === '2027-08').saison), haute)
  assert.equal(douze.find(m => m.mois === '2027-02').saison, f.find(m => m.mois === '2027-08').saison)
  // La derniere annee a 0 : elle sort du calcul, et la forme est EXACTEMENT
  // celle des trois annees precedentes — pas une moyenne tiree par des zeros.
  const troue = { results: MARCHE60.results.map(l => (l.date >= '2025-09' ? { ...l, occupancy: { ...l.occupancy, avg: 0 } } : l)) }
  const avant = { results: MARCHE60.results.filter(l => l.date < '2025-09') }
  const g = formeMensuelle(troue, { apres: '2027-04-11', jusqua: '2027-08-31' })
  assert.deepEqual(g, formeMensuelle(avant, { apres: '2027-04-11', jusqua: '2027-08-31' }))
})

test('un trou SUR une rupture : aucune rupture ni borne de saison datee sur un jour absent', () => {
  // Deux trous : sur la montee de Noel, et en tete de fenetre — celui-ci
  // (trouve par balayage de tous les trous de 1 a 3 jours) faisait tomber une
  // borne de saison sur un jour absent quand les absents entraient dans
  // l'horizon.
  for (const t of [['2026-12-18', '2026-12-19', '2026-12-20'], ['2026-09-25', '2026-09-26', '2026-09-27']]) {
    const ct = calculer(sans(t))
    for (const r of ct.ruptures) assert.ok(!t.includes(r.date), `rupture sur un jour absent : ${r.date}`)
    for (const x of ct.saisons) assert.ok(!t.includes(x.debut) && !t.includes(x.fin), `borne sur un jour absent : ${x.debut} → ${x.fin}`)
  }
  const trou = ['2026-12-18', '2026-12-19', '2026-12-20']
  const c = calculer(sans(trou))
  // La montee de Noel reste vue, juste apres le trou.
  assert.ok(c.ruptures.some(r => r.sens === 'hausse' && r.date > '2026-12-20' && r.date <= '2026-12-26'))
  assert.equal(c.ruptures.find(r => r.date === '2027-01-02').sens, 'baisse')
})

test('un marche plat n a pas de saisons : non calculable, pas « tres forte » partout', () => {
  const plat = { results: PACING.results.map(x => ({ ...x, booked_count: 300, available_count: 700 })) }
  const c = calendrierDuMarche({ pacing: plat })
  assert.equal(c.statut, 'non_calculable')
  assert.match(c.motif, /marche plat/)
})

test('une date impossible ou aberrante n entre pas dans la fenetre', () => {
  const lu = lirePacing([{ date: '2026-02-30', booked_count: 1, available_count: 9 }, { date: '2026-03-01', booked_count: 1, available_count: 9 }])
  assert.deepEqual([...lu.jours.keys()], ['2026-03-01'])
  assert.equal(lu.ecartes[0].motif, 'date illisible')
  const loin = { results: [...PACING.results, { date: '2099-01-01', booked_count: 1, available_count: 9 }] }
  const c = calendrierDuMarche({ pacing: loin })
  assert.equal(c.statut, 'non_calculable')
  assert.match(c.motif, /fenetre du pacing incoherente/)
})

// ─── Validation de Thierry du 24 septembre 2026 ─────────────────────────────

// Un pacing SYNTHETIQUE : l'eloignement de Bagneres (−0,75 %/jour) et des
// blocs de 20 jours a des niveaux choisis.
function synthetique (niveaux, bloc = 20) {
  const results = []
  for (let i = 0; i < 200; i++) {
    const d = new Date(Date.UTC(2026, 8, 24 + i)).toISOString().slice(0, 10)
    const r = Math.round(300 * Math.exp(-0.0075 * i) * niveaux[Math.floor(i / bloc) % niveaux.length])
    results.push({ date: d, booked_count: r, available_count: 1000 - r })
  }
  return { results }
}

test('LE TEST QUI COMPTE : plancher d amplitude — un marche mollement contraste sort deux ou trois saisons, jamais une « tres forte » inventee', () => {
  // Trois niveaux seulement, dont deux proches (×1,1) : les quantiles en
  // feraient quatre classes.
  const c = calendrierDuMarche({ pacing: synthetique([1.0, 1.1, 1.0, 1.35]) })
  assert.equal(c.statut, 'calcule')
  // Exactement deux saisons (review : « 2 ou 3 » laissait passer une version
  // qui ne fusionne qu'une fois).
  assert.deepEqual([...new Set(c.saisons.map(s => s.saison))].sort(), ['basse', 'forte'])
  assert.equal(saisonDuJour(c, '2026-12-03').saison, 'forte', 'les blocs a ×1,35 (jours 60 a 79) sont la saison haute')
  // Deux fusions EN CHAINE : 1,00 / 1,08 / 1,16 sont une seule saison, ×1,6 l'autre.
  const chaine = calendrierDuMarche({ pacing: synthetique([1.0, 1.08, 1.16, 1.6], 40) })
  assert.deepEqual([...new Set(chaine.saisons.map(s => s.saison))].sort(), ['basse', 'forte'])
  // Bagneres, lui, garde ses quatre saisons (×1,60, ×1,38, ×1,95).
  assert.equal(new Set(calculer().saisons.map(s => s.saison)).size, 4)
})

test('LE TEST QUI COMPTE : deux regimes, dits periode par periode — pacing jusqu a l horizon, forme mensuelle au-dela', () => {
  const c = calculer()
  assert.deepEqual(c.regimes.map(r => [r.debut, r.fin, r.regime]),
    [['2026-09-24', '2027-04-11', 'pacing'], ['2027-04-12', '2027-08-31', 'forme_mensuelle']])
  assert.ok(c.saisons.every(s => s.regime === 'pacing'))
  assert.ok(c.au_dela.every(m => m.regime === 'forme_mensuelle'))
  assert.equal(saisonDuJour(c, '2026-12-31').regime, 'pacing')
  assert.equal(saisonDuJour(c, '2027-07-14').regime, 'forme_mensuelle')
  assert.match(c.regimes[1].phrase, /pas de la demande de cette année/)
})

test('LE TEST QUI COMPTE : la forme mensuelle se lit sur la MEDIANE des mois homologues — une valeur aberrante ne la deplace pas', () => {
  const base = formeMensuelle(MARCHE60, { apres: '2027-04-11', jusqua: '2027-08-31' })
  // Le juillet le plus BAS des trois ans, triple : une saison exceptionnelle.
  // (Review : tripler le plus haut laissait la mediane tenir par egalite de
  // deux valeurs ; le plus bas ne la laisse tenir que par le RANG.)
  const juillets = MARCHE60.results.filter(l => l.date.slice(5, 7) === '07' && l.date >= '2023-09')
  const haut = juillets.reduce((m, l) => (l.occupancy.avg < m.occupancy.avg ? l : m))
  const aberrant = { results: MARCHE60.results.map(l => (l === haut ? { ...l, occupancy: { ...l.occupancy, avg: l.occupancy.avg * 3 } } : l)) }
  assert.deepEqual(formeMensuelle(aberrant, { apres: '2027-04-11', jusqua: '2027-08-31' }), base)
})

test('LE TEST QUI COMPTE : deux echelles, jamais une — aucun ordre, aucune comparaison entre une saison du pacing et une de la forme mensuelle', () => {
  const c = calculer()
  const melange = [...c.saisons, ...c.au_dela]
  assert.throws(() => ordonnerSaisons(melange), RegimesMelanges)
  const fevrier = c.saisons.find(s => s.debut === '2027-02-13')
  const aout = c.au_dela.find(m => m.mois === '2027-08')
  assert.throws(() => comparerSaisons(fevrier, aout), RegimesMelanges)
  assert.throws(() => comparerSaisons({ saison: 'forte' }, fevrier), RegimesMelanges, 'une saison sans regime n a pas de rang')
  assert.throws(() => rangDansSonRegime({ saison: 'forte' }), RegimesMelanges)
  assert.equal(rangDansSonRegime(fevrier), 3)
  // Dans un meme regime, l'ordre existe.
  assert.equal(ordonnerSaisons(c.saisons).pop().saison, 'tres_forte')
  assert.equal(ordonnerSaisons(c.au_dela).pop().mois, '2027-08')
})
