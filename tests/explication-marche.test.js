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
  assert.deepEqual(fevrier.causes.find(c => c.type === 'vacances').zones, ['A', 'B', 'C'])
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
  assert.deepEqual([periode('2026-10-01').ecart_prix_pct, periode('2026-10-25').ecart_prix_pct], [7.5, 6.5])
  assert.equal(periode('2026-10-01').distance_capture_jours, 7)
  // La Toussaint (17 oct - 1er nov, trois zones) est ecartee : 11 nuits de
  // semaine et 5 de week-end en octobre, pas 16 et 8.
  assert.deepEqual([periode('2026-10-01').nuits_semaine, periode('2026-10-01').nuits_week_end], [11, 5])
  assert.ok(periode('2026-10-01').remplissage_week_end > 0, 'le remplissage est montre a cote')
  // Les pics sont des vacances : aucune nuit hors vacances, et c'est dit.
  const noel = periode('2026-12-26')
  assert.equal(noel.ecart_prix_pct, null)
  assert.match(noel.motif, /non calculable/)
  // Une ligne par periode, aucune par nom de saison.
  assert.equal(e.ecart_semaine_week_end.length, CAL.saisons.length)
})

test('la couverture du calendrier se verifie : vacances en base jusqu au bout de l horizon, et un manque se dit', () => {
  assert.equal(expliquer().couverture_calendrier.complete, true)
  const court = VACANCES.filter(v => v.date_fin < '2027-01-01')
  const c = expliquer(court).couverture_calendrier
  assert.equal(c.complete, false)
  assert.ok(c.manque)
})

test('FRONTIERE V2 : aucun module V2 n ecrit dans une table de l existant', () => {
  const interdites = ['yield_events', 'yield_segment_reglages', 'calendar_inventory', 'price_display_log', 'prix_hote']
  const dossiers = ['lib/marche', 'lib/airroi'].map(d => path.join(__dirname, '..', d))
  for (const dossier of dossiers) {
    for (const f of fs.readdirSync(dossier).filter(x => x.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(dossier, f), 'utf8')
      for (const t of interdites) {
        assert.ok(!new RegExp(`from\\(\\s*['"\`]${t}['"\`]`).test(src), `${f} touche ${t}`)
      }
    }
  }
})
