// tests/explication-marche.test.js — pourquoi le marche monte (V2.3.2) : chaque
// pic lu dans le calendrier de la V1, les evenements locaux POSSIBLES, l'ecart
// semaine / week-end. Sur le pacing reel de Bagneres (24 septembre 2026) et
// les vacances reellement en base (fixture lue en production, empreinte 5).
//
// LES DEFAUTS QU'ILS EMPECHENT :
//   - un pic attribue a un calendrier recopie (dates en dur) au lieu de celui
//     de la base ;
//   - l'ecart week-end mesure sur des nuits de vacances ou de ferie, ou resume
//     par nom de saison en melangeant des periodes proches et lointaines ;
//   - un evenement local ecrit quelque part — la V2 n'ecrit JAMAIS dans
//     yield_events (frontiere, cadrage §11).
//
// CONTRE-EPREUVE (regle 19) : mutations du module, compte rendu du lot.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { calendrierDuMarche } = require('../lib/marche/saisons')
const { expliquerMarche, causesDuJour, calendrierFrancais } = require('../lib/marche/explication')

const FIX = path.join(__dirname, 'fixtures')
const PACING = JSON.parse(fs.readFileSync(path.join(FIX, 'airroi', 'pacing-bagneres-2026-09-24.json'), 'utf8'))
const VACANCES = JSON.parse(fs.readFileSync(path.join(FIX, 'calendrier', 'vacances-2026-09-24.json'), 'utf8')).periodes
const CAL = calendrierDuMarche({ pacing: PACING })
const expliquer = (vacances = VACANCES) => expliquerMarche({ calendrier: CAL, pacing: PACING, vacances })

test('LE TEST QUI COMPTE : chaque pic lu dans le calendrier — Noel et fevrier par les vacances des trois zones, la fin janvier a moitie seulement', () => {
  const e = expliquer()
  const pic = d => e.pics.find(p => p.debut === d)
  const noel = pic('2026-12-26')
  assert.equal(noel.saison, 'tres_forte')
  assert.equal(noel.explique, true)
  assert.deepEqual(noel.causes[0], { type: 'vacances', nom: 'Vacances de Noël', zones: ['A', 'B', 'C'], jours: 7, part: 1 })
  const fevrier = pic('2027-02-13')
  assert.equal(fevrier.explique, true)
  // Zones DECALEES (C 6-21 fev., A 13-28, B 20 fev.-7 mars) : leur UNION
  // couvre les 21 jours du pic — pas les 16 de la seule zone A (review).
  assert.deepEqual(fevrier.causes.find(c => c.type === 'vacances'), { type: 'vacances', nom: "Vacances d'Hiver", zones: ['A', 'B', 'C'], jours: 21, part: 1 })
  assert.ok(fevrier.causes.some(c => c.type === 'date_commerciale' && c.nom === 'Saint-Valentin'))
  // 29 janvier - 12 fevrier : la zone C ne part que le 6 fevrier.
  const fin = pic('2027-01-29')
  assert.equal(fin.explique, false)
  assert.equal(fin.part_expliquee, 0.47)
  assert.deepEqual(fin.causes.map(c => [c.nom, c.zones.join('')]), [["Vacances d'Hiver", 'C']])
  assert.match(fin.phrase, /le calendrier n'explique que 47 % de ces jours/)
})

test('LE TEST QUI COMPTE : le calendrier vient de la BASE, pas d un texte recopie — sans les vacances d hiver de la zone C, la fin janvier perd sa seule cause', () => {
  const sansC = VACANCES.filter(v => !(v.zone === 'C' && /Hiver/.test(v.nom)))
  const fin = expliquer(sansC).pics.find(p => p.debut === '2027-01-29')
  assert.equal(fin.part_expliquee, 0)
  assert.deepEqual(fin.causes, [])
  // Et un jour de vacances inventees devient explique.
  const invente = [...VACANCES, { zone: 'B', nom: 'Vacances inventees', date_debut: '2027-01-29', date_fin: '2027-02-05' }]
  assert.equal(expliquer(invente).pics.find(p => p.debut === '2027-01-29').explique, true)
})

test('LE TEST QUI COMPTE : les evenements locaux possibles — une LISTE A LIRE, datee, rien d enregistre', () => {
  const e = expliquer()
  assert.deepEqual(e.evenements_possibles.map(x => [x.debut, x.fin, x.proche_de_la_capture]),
    [['2026-09-24', '2026-09-30', true], ['2027-01-29', '2027-02-05', false]])
  for (const x of e.evenements_possibles) {
    assert.equal(x.a_lire, true)
    assert.equal(x.regime, 'pacing')
    assert.match(x.phrase, /rien n'est enregistré/)
    // Un evenement possible n'a AUCUNE cause calendaire, jour par jour.
    const cal = calendrierFrancais(VACANCES, x.debut, x.fin)
    for (let d = x.debut; d <= x.fin; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) {
      assert.deepEqual(causesDuJour(d, cal), [], `${d} a une cause calendaire`)
    }
  }
  assert.match(e.evenements_possibles[0].phrase, /touchent la date de l’étude/)
  assert.equal(e.evenements_possibles[1].dans_un_pic.saison, 'forte')
})

test('LE TEST QUI COMPTE : l ecart semaine / week-end, periode par periode, hors vacances et feries — jamais un resume par nom de saison', () => {
  const e = expliquer()
  const periode = d => e.ecart_semaine_week_end.find(x => x.debut === d)
  // Pres de la capture : le week-end se vend plus cher.
  assert.deepEqual([periode('2026-10-01').ecart_prix_pct, periode('2026-10-25').ecart_prix_pct], [7.5, 8.5])
  // Les ponts et week-ends prolonges de l'Armistice (7-15 nov.) sont ecartes
  // comme les vacances et les feries (review) : 28 nuits de semaine et 10 de
  // week-end de fin octobre a mi-decembre, pas 33 et 13.
  assert.deepEqual([periode('2026-10-25').nuits_semaine, periode('2026-10-25').nuits_week_end], [28, 10])
  assert.equal(periode('2026-10-01').distance_capture_jours, 7)
  // La Toussaint (17 oct - 1er nov, trois zones) est ecartee : 11 nuits de
  // semaine et 5 de week-end en octobre, pas 16 et 8.
  assert.deepEqual([periode('2026-10-01').nuits_semaine, periode('2026-10-01').nuits_week_end], [11, 5])
  assert.ok(periode('2026-10-01').remplissage_week_end > 0, 'le remplissage est montre a cote')
  // Les pics sont des vacances : aucune nuit hors vacances, et c'est dit.
  const noel = periode('2026-12-26')
  assert.equal(noel.ecart_prix_pct, null)
  assert.match(noel.motif, /non calculable/)
  // Une ligne par periode, aucune par nom de saison : chaque ligne porte SES
  // dates, celles d'une saison du calendrier.
  assert.deepEqual(e.ecart_semaine_week_end.map(x => [x.debut, x.fin]), CAL.saisons.map(x => [x.debut, x.fin]))
})

test('la couverture du calendrier se verifie : vacances en base jusqu au bout de l horizon, et un manque se dit', () => {
  assert.equal(expliquer().couverture_calendrier.complete, true)
  const court = VACANCES.filter(v => v.date_fin < '2027-01-01')
  const c = expliquer(court).couverture_calendrier
  assert.equal(c.complete, false)
  assert.ok(c.manque)
})

test('FRONTIERE V2 : les modules purs ne touchent aucune base ; les autres, seulement les tables V2', () => {
  const racine = path.join(__dirname, '..')
  const lire = f => fs.readFileSync(path.join(racine, f), 'utf8')
  // Purs : aucun acces base, sous aucune forme (review : `.from(TABLE)`,
  // `.rpc(`, un client cree sur place).
  for (const f of ['lib/marche/saisons.js', 'lib/marche/explication.js', 'lib/marche/grille-marche.js']) {
    const src = lire(f)
    for (const motif of [/\.from\(/, /\.rpc\(/, /createClient/, /require\([^)]*supabase/]) assert.ok(!motif.test(src), `${f} : ${motif}`)
  }
  // Les autres : chaque `.from(` nomme en toutes lettres une table V2, et
  // aucun `.rpc(`. (Tous les fichiers de lib/marche et lib/airroi, sous-
  // dossiers compris.)
  const V2 = new Set(['airroi_cache', 'airroi_appels', 'comparables_retenus', 'grille_controle'])
  const fichiers = []
  const parcourir = d => { for (const x of fs.readdirSync(path.join(racine, d), { withFileTypes: true })) { const p = `${d}/${x.name}`; if (x.isDirectory()) parcourir(p); else if (p.endsWith('.js')) fichiers.push(p) } }
  parcourir('lib/marche'); parcourir('lib/airroi')
  for (const f of fichiers) {
    const src = lire(f)
    assert.ok(!/\.rpc\(/.test(src), `${f} : .rpc(`)
    for (const m of src.matchAll(/\.from\(\s*([^)]*)\)/g)) {
      const t = m[1].trim().replace(/^['"`]|['"`]$/g, '')
      assert.ok(V2.has(t), `${f} : .from(${m[1]}) — seules les tables V2, nommees en toutes lettres`)
    }
  }
})

test('un evenement ne chevauche jamais deux pics, et un pacing absent se dit', () => {
  // Sans les vacances de Noel, les deux pics contigus du 19 et du 26 decembre
  // perdent leur cause principale : leurs jours non expliques se suivent.
  const e = expliquer(VACANCES.filter(v => !/No[eë]l/.test(v.nom)))
  for (const x of e.evenements_possibles) {
    const pics = e.pics.filter(p => !(x.fin < p.debut || x.debut > p.fin))
    assert.ok(pics.length <= 1, `${x.debut} → ${x.fin} chevauche ${pics.length} pics`)
    if (pics.length) assert.deepEqual(x.dans_un_pic, { debut: pics[0].debut, fin: pics[0].fin, saison: pics[0].saison })
  }
  assert.ok(e.evenements_possibles.some(x => x.debut >= '2026-12-19' && x.fin <= '2026-12-25'))
  assert.ok(e.evenements_possibles.some(x => x.debut >= '2026-12-26' && x.fin <= '2027-01-01'))
  // Deux pics CONTIGUS sans aucune cause (marche synthetique, aucune
  // vacance) : sans la coupure au changement de pic, les jours du 2 au 6
  // novembre faisaient UN evenement a cheval sur « forte » et « tres forte ».
  const results = []
  for (let i = 0; i < 200; i++) {
    const r = Math.round(300 * Math.exp(-0.0075 * i) * [1, 1.6, 2.6, 1, 1][Math.floor(i / 20) % 5])
    results.push({ date: new Date(Date.UTC(2026, 8, 24 + i)).toISOString().slice(0, 10), booked_count: r, available_count: 1000 - r, booked_rate_avg: 100 })
  }
  const cs = calendrierDuMarche({ pacing: { results } })
  const es = expliquerMarche({ calendrier: cs, pacing: { results }, vacances: [] })
  assert.ok(es.pics.some(p => p.fin === '2026-11-04') && es.pics.some(p => p.debut === '2026-11-05'), 'deux pics contigus')
  for (const x of es.evenements_possibles) {
    assert.ok(es.pics.filter(p => !(x.fin < p.debut || x.debut > p.fin)).length <= 1, `${x.debut} → ${x.fin} chevauche deux pics`)
  }
  const sans = expliquerMarche({ calendrier: CAL, pacing: null, vacances: VACANCES })
  assert.equal(sans.statut, 'non_calculable')
  assert.match(sans.motif, /pacing absent/)
})
