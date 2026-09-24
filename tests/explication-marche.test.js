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
const { expliquerMarche, causesDuJour, calendrierFrancais, jugerEcart } = require('../lib/marche/explication')

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
  // ⚠ REECRIT LE 24 SEPTEMBRE 2026 (regle 17) : zone de derniere minute
  // (24-26 sept.) exclue de la pente et du classement (Thierry). Le pic de fin janvier commence le 30 (et
  // non plus le 29) : 7 jours sur 14 couverts par la zone C, 50 % — il passe
  // TOUT JUSTE le seuil d'explication. La zone C ne part que le 6 fevrier.
  const fin = pic('2027-01-30')
  assert.equal(fin.part_expliquee, 0.5)
  assert.equal(fin.explique, true)
  assert.deepEqual(fin.causes.map(c => [c.nom, c.zones.join('')]), [["Vacances d'Hiver", 'C']])
})

test('LE TEST QUI COMPTE : le calendrier vient de la BASE, pas d un texte recopie — sans les vacances d hiver de la zone C, la fin janvier perd sa seule cause', () => {
  const sansC = VACANCES.filter(v => !(v.zone === 'C' && /Hiver/.test(v.nom)))
  const fin = expliquer(sansC).pics.find(p => p.debut === '2027-01-30')
  assert.equal(fin.part_expliquee, 0)
  assert.deepEqual(fin.causes, [])
  // Et un jour de vacances inventees devient explique.
  const invente = [...VACANCES, { zone: 'B', nom: 'Vacances inventees', date_debut: '2027-01-29', date_fin: '2027-02-05' }]
  assert.equal(expliquer(invente).pics.find(p => p.debut === '2027-01-30').part_expliquee, 1)
})

test('LE TEST QUI COMPTE : les jours sans cause calendaire francaise connue — une LISTE A LIRE, datee, rien d enregistre', () => {
  const e = expliquer()
  assert.ok(e.evenements_possibles.length > 0, 'une boucle vide ne prouverait rien')
  // ⚠ REECRIT LE 24 SEPTEMBRE 2026 (regle 17) : zone de derniere minute
  // (24-26 sept.) exclue de la pente et du classement (Thierry). Le 24-30 septembre n'est plus un pic ;
  // un pic « forte » faible (borne par deux TRANSITIONS, ×1,06 et ×1,13)
  // apparait du 2 au 11 octobre, sans cause calendaire francaise.
  assert.deepEqual(e.evenements_possibles.map(x => [x.debut, x.fin, x.proche_de_la_capture]),
    [['2026-10-02', '2026-10-11', false], ['2027-01-30', '2027-02-05', false]])
  // ⚠ Le 2 → 11 octobre (pic faiblement marque) reste STOCKE mais n'est pas a
  // lire (Thierry, 24 septembre 2026) : seul le 30 janv. → 5 fev. l'est.
  assert.deepEqual(e.evenements_possibles.filter(x => x.a_lire).map(x => x.debut), ['2027-01-30'])
  for (const x of e.evenements_possibles) {
    assert.equal(x.regime, 'pacing')
    assert.match(x.phrase, /rien n'est enregistré/)
    // Un evenement possible n'a AUCUNE cause calendaire, jour par jour.
    const cal = calendrierFrancais(VACANCES, x.debut, x.fin)
    for (let d = x.debut; d <= x.fin; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) {
      assert.deepEqual(causesDuJour(d, cal), [], `${d} a une cause calendaire`)
    }
  }
  assert.equal(e.evenements_possibles[1].dans_un_pic.saison, 'forte')
})

test('LE TEST QUI COMPTE : l ecart semaine / week-end, periode par periode, hors vacances et feries — jamais un resume par nom de saison', () => {
  const e = expliquer()
  const periode = d => e.ecart_semaine_week_end.find(x => x.debut === d)
  // ⚠ REECRIT LE 24 SEPTEMBRE 2026 (regle 17) : zone de derniere minute
  // (24-26 sept.) exclue de la pente et du classement (Thierry). Periodes : 2-11 oct. et 26 oct. - 18 dec.
  // Pres de la capture : le week-end se vend plus cher.
  assert.deepEqual([periode('2026-10-02').ecart_prix_pct, periode('2026-10-26').ecart_prix_pct], [7.1, 8.5])
  // Les ponts et week-ends prolonges de l'Armistice (7-15 nov.) sont ecartes
  // comme les vacances et les feries (review) : 28 nuits de semaine et 10 de
  // week-end de fin octobre a mi-decembre, pas 33 et 13.
  assert.deepEqual([periode('2026-10-26').nuits_semaine, periode('2026-10-26').nuits_week_end], [28, 10])
  assert.equal(periode('2026-10-02').distance_capture_jours, 8)
  // La Toussaint (17 oct - 1er nov) est ecartee : la periode du 12 au 25
  // octobre n'a plus qu'une date de week-end, et aucun chiffre.
  assert.equal(periode('2026-10-12').nuits_week_end, 1)
  assert.equal(periode('2026-10-12').ecart_prix_pct, null)
  assert.ok(periode('2026-10-02').remplissage_week_end > 0, 'le remplissage est montre a cote')
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
  const V2 = new Set(['airroi_cache', 'airroi_appels', 'comparables_retenus', 'grille_controle', 'marche_calendrier', 'marche_biens'])
  const fichiers = []
  const parcourir = d => { for (const x of fs.readdirSync(path.join(racine, d), { withFileTypes: true })) { const p = `${d}/${x.name}`; if (x.isDirectory()) parcourir(p); else if (p.endsWith('.js')) fichiers.push(p) } }
  parcourir('lib/marche'); parcourir('lib/airroi')
  // Les SCRIPTS V2 aussi (review) : ils lisent l'existant (empreinte,
  // vacances), jamais n'ecrivent dans une table interdite.
  const interdites = ['yield_events', 'yield_segment_reglages', 'calendar_inventory', 'price_display_log', 'prix_hote']
  for (const f of ['scripts/capturer-pacing.js', 'scripts/calculer-calendrier-marche.js', 'scripts/releve-controle-marche.js', 'scripts/verifier-airroi.js', 'scripts/verifier-migration-marche.js', 'scripts/lier-bien-marche.js']) {
    const src = lire(f)
    for (const t of interdites) assert.ok(!src.includes(t), `${f} nomme ${t}`)
  }
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

test('LE TEST QUI COMPTE : une periode a faible effectif ne produit AUCUN chiffre — janvier et mars (213 a 226 nuits de week-end reservees) sont non calculables', () => {
  const e = expliquer()
  const periode = d => e.ecart_semaine_week_end.find(x => x.debut === d)
  for (const d of ['2027-01-02', '2027-03-06']) {
    const p = periode(d)
    assert.equal(p.ecart_prix_pct, null, `${d} : aucun pourcentage (le code d'avant sortait -3,2 % et -3,7 %)`)
    assert.equal(p.remplissage_week_end, undefined, 'aucun chiffre du tout')
    assert.match(p.motif, /moins de 400 nuits réservées/)
  }
  // Octobre et novembre-decembre (734 et 610 nuits de week-end) : le chiffre
  // reste (periodes redecoupees par la zone de derniere minute, 24 septembre).
  assert.deepEqual([periode('2026-10-02').ecart_prix_pct, periode('2026-10-26').ecart_prix_pct], [7.1, 8.5])
  assert.deepEqual([periode('2026-10-02').nuits_reservees_week_end, periode('2026-10-26').nuits_reservees_week_end], [734, 610])
  // Aucun ecart negatif ne sort sur cette capture : ceux qui sortaient etaient du bruit.
  assert.ok(e.ecart_semaine_week_end.every(x => x.ecart_prix_pct == null || x.ecart_prix_pct > 0))
})

test('LE TEST QUI COMPTE : sans cause calendaire FRANCAISE connue — jamais « evenement local » affirme (marche frontalier)', () => {
  const e = expliquer()
  for (const x of e.evenements_possibles) {
    assert.match(x.phrase, /sans cause calendaire française connue/)
    assert.match(x.phrase, /vacances d’un pays voisin/)
    assert.equal(x.limite, 'calendrier_francais_seulement')
  }
  assert.match(e.pics.find(p => p.debut === '2026-10-02').phrase, /calendrier français connu/)
})

test('le seuil de l ecart a la limite : 400 nuits reservees calculent, 399 non — de chaque cote', () => {
  const jours = (k, n, prix) => Array.from({ length: k }, () => ({ prix, remplissage: 0.1, n }))
  // 4 dates de 100 nuits = 400 : calcule.
  assert.equal(jugerEcart(jours(4, 100, 100), jours(4, 100, 110)).ecart_prix_pct, 10)
  // 399 cote week-end : aucun chiffre.
  const we399 = [...jours(3, 100, 110), { prix: 110, remplissage: 0.1, n: 99 }]
  assert.equal(jugerEcart(jours(4, 100, 100), we399).ecart_prix_pct, null)
  // 399 cote SEMAINE (l'autre branche), avec 4 dates : aucun chiffre non plus.
  const se399 = [...jours(3, 100, 100), { prix: 100, remplissage: 0.1, n: 99 }]
  const r = jugerEcart(se399, jours(4, 100, 110))
  assert.equal(r.ecart_prix_pct, null)
  assert.equal(r.remplissage_semaine, undefined)
  assert.match(r.motif, /moins de 400 nuits réservées/)
  // 3 dates, meme avec beaucoup de nuits : aucun chiffre.
  assert.match(jugerEcart(jours(3, 500, 100), jours(4, 500, 110)).motif, /moins de 4 dates/)
})

test('un pic borne par deux transitions le DIT : saison faiblement marquee (2 → 11 octobre)', () => {
  const e = expliquer()
  const oct = e.pics.find(p => p.debut === '2026-10-02')
  assert.equal(oct.faiblement_marque, true)
  assert.match(oct.phrase, /Saison faiblement marquée : aucune rupture franche/)
  assert.equal(e.pics.find(p => p.debut === '2026-12-19').faiblement_marque, false)
})

test('la zone de derniere minute ne sert pas de voisin au surcroit, et un evenement proche de la capture le dit', () => {
  const dm = CAL.derniere_minute
  const e = expliquer()
  for (const x of e.evenements_possibles) assert.ok(x.debut > dm.fin, `evenement dans la zone : ${x.debut}`)
  // La branche « proche de la capture » (review : plus testee) — un pic sans
  // cause qui commence moins de 7 jours apres la capture.
  const results = []
  for (let i = 0; i < 200; i++) {
    const r = Math.round(300 * Math.exp(-0.0075 * i) * (i >= 4 && i < 16 ? 2.2 : (Math.floor(i / 20) % 2 ? 1.3 : 1)))
    results.push({ date: new Date(Date.UTC(2026, 8, 24 + i)).toISOString().slice(0, 10), booked_count: r, available_count: 1000 - r, booked_rate_avg: 100 })
  }
  const cs = calendrierDuMarche({ pacing: { results } })
  const es = expliquerMarche({ calendrier: cs, pacing: { results }, vacances: [] })
  const proche = es.evenements_possibles.find(x => x.proche_de_la_capture)
  assert.ok(proche, `aucun evenement proche : ${es.evenements_possibles.map(x => x.debut).join(', ')}`)
  assert.match(proche.phrase, /touchent la date de l’étude/)
})

test('LE TEST QUI COMPTE : un pic sans aucune rupture a ses bornes sort de la liste a lire — stocke, jamais affiche', () => {
  const e = expliquer()
  const oct = e.evenements_possibles.find(x => x.debut === '2026-10-02')
  assert.equal(oct.a_lire, false)
  assert.match(oct.motif_non_affiche, /aucune de ses frontières n’est une rupture/)
  const jan = e.evenements_possibles.find(x => x.debut === '2027-01-30')
  assert.equal(jan.a_lire, true, 'le pic de fin janvier entre par une rupture (×1,32)')
  assert.equal(jan.motif_non_affiche, null)
  // La page n'affiche que les evenements a lire.
  const page = fs.readFileSync(path.join(__dirname, '..', 'apps', 'yield', 'marche.html'), 'utf8')
  assert.match(page, /evenements_possibles \|\| \[\]\)\.filter\(e => e\.a_lire !== false\)/)
})

