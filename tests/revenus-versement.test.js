// tests/revenus-versement.test.js — QUAND L'ARGENT ARRIVE.
//
// Étape 3 du lot « Aujourd'hui V5 ». Le bloc « Revenus nets » range un séjour
// au mois de son VERSEMENT, pas au mois de ses nuits : c'est la règle qui
// décide dans quelle colonne un euro tombe, et elle est entièrement ici.
//
// Les quatre qui comptent :
//   1. les trois canaux ne partent pas du même événement — arrivée, départ,
//      réservation : une seule base pour tous rangerait des revenus dans le
//      mauvais mois sans que rien ne le dise ;
//   2. un séjour À CHEVAL sur deux mois compte au mois du versement, pas à
//      celui de ses nuits (décision de Thierry du 24 octobre 2026) ;
//   3. une date réellement constatée par Stripe bat toujours la prévision ;
//   4. ce qu'on ne sait pas rend `null` — jamais une date inventée, jamais un
//      « à venir » par défaut.

const test = require('node:test')
const assert = require('node:assert/strict')
const V = require('../lib/revenus/versement')

// Les trois règles décidées par Thierry, telles que la migration les sème.
const DELAIS = {
  airbnb: { base: 'arrivee', jours: 1 },
  booking: { base: 'depart', jours: 1 },
  direct: { base: 'reservation', jours: 3 }
}

const SEJOUR = (extra = {}) => ({
  canal: 'airbnb', reserve_le: '2026-09-15', arrivee: '2026-10-20', depart: '2026-10-24',
  ...extra
})

// ═══════════════════════════════════════════════════════════════════════════
// 1. Les trois canaux
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : chaque canal part de SON événement, pas d un événement commun', () => {
  // Airbnb paie à l'arrivée, Booking au départ, le direct à la réservation.
  // Le même séjour, vendu sur trois canaux, est donc versé trois jours
  // différents — et peut tomber dans trois mois différents.
  const a = V.dateDeVersement(SEJOUR({ canal: 'airbnb' }), DELAIS)
  assert.deepEqual(a, { jour: '2026-10-21', source: 'delai', motif: null }, 'arrivée + 1')

  const b = V.dateDeVersement(SEJOUR({ canal: 'booking' }), DELAIS)
  assert.deepEqual(b, { jour: '2026-10-25', source: 'delai', motif: null }, 'départ + 1')

  const d = V.dateDeVersement(SEJOUR({ canal: 'direct' }), DELAIS)
  assert.deepEqual(d, { jour: '2026-09-18', source: 'delai', motif: null }, 'réservation + 3')

  // ⚠ ET LA PREUVE QUE LA BASE COMPTE : les trois dates diffèrent sur le MÊME
  // séjour. Une base unique les ferait coïncider, et ce test resterait vert
  // si on ne les comparait pas entre elles.
  assert.equal(new Set([a.jour, b.jour, d.jour]).size, 3,
    'deux canaux versent le même jour : la base de calcul est ignorée')
})

test('le canal se reconnaît sous ses quatre orthographes', () => {
  // Les payloads portent `Airbnb`, `bookingcom`, `booking.com`, `Offline`.
  // Comparer la chaîne brute ferait tomber un canal RÉEL dans « inconnu »,
  // donc un revenu hors du total — et un total qui perd une réservation a
  // l'air juste.
  for (const [brut, attendu] of [
    ['Airbnb', 'airbnb'], ['airbnb', 'airbnb'],
    ['bookingcom', 'booking'], ['Booking.com', 'booking'],
    ['Offline', 'direct'], ['direct', 'direct'], ['hotesmart-manual', 'direct']
  ]) {
    assert.equal(V.canalNormalise(brut), attendu, `${brut} n est pas reconnu`)
  }
  assert.equal(V.canalNormalise('expedia'), null, 'un canal inconnu ne se devine pas')
  assert.equal(V.canalNormalise(''), null)
  assert.equal(V.canalNormalise(null), null)
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Le séjour à cheval sur deux mois
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : un séjour à cheval compte au mois du VERSEMENT', () => {
  // ⚠ LA CONSÉQUENCE QUE THIERRY A ACCEPTÉE EXPLICITEMENT (24 octobre 2026) :
  // un séjour qui arrive le 31 octobre est payé le 1er novembre, donc il ne
  // figure PAS dans « Revenus · Octobre ». C'est contre-intuitif, c'est assumé,
  // et c'est la seule règle qui donne un total stable : les nuits d'un séjour
  // se répartissent sur deux mois, son versement non.
  const aCheval = { canal: 'airbnb', arrivee: '2026-10-31', depart: '2026-11-04' }
  const v = V.dateDeVersement(aCheval, DELAIS)
  assert.equal(v.jour, '2026-11-01')
  assert.equal(V.moisDuVersement(v.jour), '2026-11',
    'le séjour est rangé en octobre : il compte au mois de son versement')

  // Le même séjour vendu sur Booking part du DÉPART : versé le 5 novembre,
  // donc novembre aussi — mais pour une autre raison, et quatre jours plus tard.
  const surBooking = V.dateDeVersement({ ...aCheval, canal: 'booking' }, DELAIS)
  assert.equal(surBooking.jour, '2026-11-05')

  // Et l'inverse : un séjour qui FINIT en novembre mais arrive fin octobre
  // compte en octobre chez Airbnb.
  const arriveeFinOctobre = V.dateDeVersement(
    { canal: 'airbnb', arrivee: '2026-10-29', depart: '2026-11-02' }, DELAIS)
  assert.equal(V.moisDuVersement(arriveeFinOctobre.jour), '2026-10')
})

test('le passage d un mois, d une année et du changement d heure donne le bon jour', () => {
  // ⚠ ET VOICI CE QUE CE TEST NE PROUVE PAS — je l ai mesuré avant de l écrire,
  // parce que le commentaire que j allais poser était faux. J allais écrire
  // que « + n × 86 400 000 » glisse d un jour deux fois par an, comme le dépôt
  // l a payé ailleurs. Ici, NON : `dateDeVersement` parse « YYYY-MM-DD » à
  // T00:00:00Z et reformate en UTC, donc l addition en millisecondes et
  // l arithmétique calendaire donnent le MÊME jour. Contre-épreuve : les trois
  // implémentations — `setUTCDate`, `+ n × 86 400 000`, et même un `setDate`
  // en heure LOCALE — passent toutes ces assertions sur cette machine
  // (Europe/Paris, décalage positif).
  //
  // Ce que ce test prouve donc vraiment : les bascules de MOIS et d ANNÉE, où
  // un découpage de chaîne se trompe. Et le motif de la règle du dépôt reste
  // entier pour le code qui déduit un jour LOCAL d un instant — ce n est pas
  // le cas ici, et c est pour ça que `ajouterJours` est importé de
  // `lib/moteur-reservation`, où l invariant est tenu et testé.
  for (const [arrivee, attendu] of [
    ['2026-10-31', '2026-11-01'],   // fin de mois
    ['2026-12-31', '2027-01-01'],   // fin d'année
    ['2026-10-24', '2026-10-25'],   // la nuit du changement d'heure (25 octobre)
    ['2027-03-27', '2027-03-28']    // et celle du printemps
  ]) {
    assert.equal(V.dateDeVersement({ canal: 'airbnb', arrivee }, DELAIS).jour, attendu)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. Stripe : le seul fait de tout ce module
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : une date Stripe RÉELLE bat la prévision, même d un autre mois', () => {
  // Rien dans le cœur ne constate un versement reçu — sauf Stripe. Préférer
  // notre estimation à ce que la banque a fait serait l inverse de la règle.
  const v = V.dateDeVersement(
    { canal: 'direct', reserve_le: '2026-09-15', versement_stripe: '2026-10-02' }, DELAIS)
  assert.deepEqual(v, { jour: '2026-10-02', source: 'stripe', motif: null })
  assert.equal(V.moisDuVersement(v.jour), '2026-10',
    'la prévision aurait dit septembre : le fait dit octobre')

  // Et elle bat la prévision sur TOUS les canaux, pas seulement le direct.
  const surAirbnb = V.dateDeVersement(SEJOUR({ versement_stripe: '2026-12-01' }), DELAIS)
  assert.equal(surAirbnb.source, 'stripe')
  assert.equal(surAirbnb.jour, '2026-12-01')

  // Une date Stripe ILLISIBLE ne fait pas tomber le calcul : on revient au délai.
  const abimee = V.dateDeVersement(SEJOUR({ versement_stripe: 'bientôt' }), DELAIS)
  assert.equal(abimee.source, 'delai')
  assert.equal(abimee.jour, '2026-10-21')
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. Ce qu'on ne sait pas
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : ce qu on ne sait pas rend `null`, jamais une date inventée', () => {
  const cas = [
    [{ canal: 'expedia', arrivee: '2026-10-20' }, 'canal_inconnu'],
    [{ canal: 'airbnb' }, 'date_manquante'],
    [{ canal: 'airbnb', arrivee: 'le 20' }, 'date_manquante'],
    [{ canal: 'booking', arrivee: '2026-10-20' }, 'date_manquante']  // Booking lit le DÉPART
  ]
  for (const [sejour, motif] of cas) {
    const v = V.dateDeVersement(sejour, DELAIS)
    assert.equal(v.jour, null, `${motif} : une date est inventée`)
    assert.equal(v.motif, motif)
  }
  // Un canal connu mais SANS règle en base : on refuse plutôt que de prendre
  // un défaut, qui rangerait le séjour dans un mois choisi par nous.
  const sansRegle = V.dateDeVersement(SEJOUR({ canal: 'booking' }), { airbnb: DELAIS.airbnb })
  assert.equal(sansRegle.motif, 'delai_absent')
  assert.equal(sansRegle.jour, null)
})

test('LE TEST QUI COMPTE : le jour du versement est REÇU, et `null` n est pas « à venir »', () => {
  // ⚠ Un versement daté d aujourd hui a eu lieu aujourd hui. Le ranger « à
  // venir » ferait disparaître une somme du « reçu » pendant 24 h, chaque
  // jour, sur la ligne la plus fraîche de l écran.
  assert.equal(V.estRecu('2026-10-25', '2026-10-25'), true, 'le jour même est reçu')
  assert.equal(V.estRecu('2026-10-24', '2026-10-25'), true)
  assert.equal(V.estRecu('2026-10-26', '2026-10-25'), false)
  // ⚠ ET L INCONNU N EST NI L UN NI L AUTRE. Le compter « à venir » le ferait
  // entrer dans un total, donc affirmer qu il arrivera.
  assert.equal(V.estRecu(null, '2026-10-25'), null)
  assert.equal(V.estRecu('2026-10-25', null), null)
  assert.equal(V.estRecu('bientôt', '2026-10-25'), null)
})

test('un mois ne se devine pas depuis une date illisible', () => {
  assert.equal(V.moisDuVersement('2026-10-21'), '2026-10')
  assert.equal(V.moisDuVersement(null), null)
  assert.equal(V.moisDuVersement('octobre'), null)
  assert.equal(V.moisDuVersement('2026-13-01'), null, 'un mois impossible n est pas un mois')
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. La table, telle qu'elle vient de la base
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : une ligne illisible est ÉCARTÉE, pas corrigée', () => {
  // Ces lignes viennent d une écriture manuelle (la table n a pas d écran).
  // Leur donner un repli rangerait des revenus dans un mois inventé ; le canal
  // tombe dans « délai absent », que l écran sait dire.
  const t = V.tableDesDelais([
    { canal: 'airbnb', base: 'arrivee', jours: 1 },
    { canal: 'booking', base: 'au depart', jours: 1 },      // base inconnue
    { canal: 'direct', base: 'reservation', jours: -3 },     // délai négatif
    { canal: 'expedia', base: 'arrivee', jours: 1 },         // canal inconnu
    { canal: 'Booking.com', base: 'depart', jours: 2 }       // orthographe réelle
  ])
  assert.deepEqual(Object.keys(t).sort(), ['airbnb', 'booking'])
  assert.deepEqual(t.booking, { base: 'depart', jours: 2, libelle: null },
    'la ligne valide de Booking doit survivre à la ligne abîmée')
  assert.equal(t.direct, undefined, 'un délai négatif ferait verser avant le séjour')
})

test('la migration sème exactement les trois règles décidées', () => {
  // ⚠ LE FICHIER DE MIGRATION EST LA SOURCE, et ce test le LIT — il ne récite
  // pas ce que j ai en tête. Si quelqu un change une valeur dans le SQL sans
  // changer la décision, les deux cessent de dire la même chose ici.
  const fs = require('node:fs')
  const path = require('node:path')
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '2026-10-25-delais-versement.sql'), 'utf8')
  for (const [canal, base, jours] of [
    ['airbnb', 'arrivee', 1], ['booking', 'depart', 1], ['direct', 'reservation', 3]
  ]) {
    assert.match(sql, new RegExp(`'${canal}'\\s*,\\s*'${base}'\\s*,\\s*${jours}`),
      `la migration ne sème plus ${canal} = ${base} + ${jours}`)
  }
  // Et les deux gardes de la table, qui empêchent une écriture manuelle de
  // ranger un revenu n importe où.
  assert.match(sql, /check \(base in \('arrivee', 'depart', 'reservation'\)\)/)
  assert.match(sql, /jours >= 0 and jours <= 180/)
})
