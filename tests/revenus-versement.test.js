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
  // ⚠ LES ESPACES AUTOUR, parce qu une saisie manuelle en met (mutation
  // survivante : retirer le `trim()` passait les 13 tests). Un canal réel qui
  // tombe dans « inconnu » est un revenu rangé dans aucun mois.
  // ⚠ ET CE SONT LES FORMES COURTES QUI LE PROUVENT. ' Airbnb ' survit sans
  // `trim()` — la reconnaissance par sous-chaîne le rattrape —, mais ' abb '
  // non : il est comparé en ÉGALITÉ. Mesuré : sans cette ligne, retirer le
  // `trim()` passait tous les tests.
  for (const [brut, attendu] of [
    [' Airbnb ', 'airbnb'], ['\tbooking.com\n', 'booking'], ['  direct  ', 'direct'],
    [' abb ', 'airbnb'], ['\tBDC\n', 'booking'], [' Offline ', 'direct']
  ]) {
    assert.equal(V.canalNormalise(brut), attendu, `${JSON.stringify(brut)} n est pas reconnu`)
  }
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
  // ⚠ J AI ÉCRIT ICI UNE AFFIRMATION FAUSSE, ET LA REVUE L A MESURÉE (26 octobre
  // 2026). J avais écrit que les trois implémentations — `setUTCDate`,
  // `+ n × 86 400 000` et un `setDate` en heure LOCALE — donnent toutes le même
  // jour dans ce module. C est vrai pour les deux premières : l arithmétique
  // part d un minuit UTC, et UTC n a pas d heure d été — 0 écart sur
  // 5 600 couples mesurés. C est FAUX pour la troisième : 469 écarts sur
  // 5 600, et sur les délais réels de la table (1 et 3 jours) il en reste 12,
  // dont un CHANGEMENT DE MOIS — « 2026-03-29 + 3 jours » vaut le 1er avril, et
  // une implémentation locale rend le 31 mars. Une réservation directe du
  // 29 mars compterait en mars au lieu d avril.
  //
  // Ma mesure n était pas fausse, elle était TROP ÉTROITE : j avais essayé deux
  // dates d octobre, pas une année de bascules. Les quatre fixtures que j avais
  // choisies sont exactement celles qu une implémentation locale survit.
  // Les deux lignes marquées ci-dessous la tuent, et c est à ça qu on voit
  // qu un test prouve son titre.
  //
  // Ce que ce test prouve donc : les bascules de MOIS, d ANNÉE, et l invariant
  // de FUSEAU — une arithmétique en heure locale rougit.
  for (const [arrivee, attendu] of [
    ['2026-10-31', '2026-11-01'],   // fin de mois
    ['2026-12-31', '2027-01-01'],   // fin d'année
    ['2026-10-24', '2026-10-25'],   // la nuit du changement d'heure (25 octobre)
    ['2027-03-27', '2027-03-28'],   // et celle du printemps
    // ⚠ LES DEUX QUI TUENT L ARITHMÉTIQUE LOCALE, mesurées par la revue :
    ['2027-03-28', '2027-03-29'],   // en local : 2027-03-28, soit le même jour
    ['2026-03-29', '2026-03-30']    // en local : 2026-03-29
  ]) {
    assert.equal(V.dateDeVersement({ canal: 'airbnb', arrivee }, DELAIS).jour, attendu)
  }
  // Et le cas qui change de MOIS — une réservation directe du 29 mars, versée
  // à +3 : le 1er avril. Une implémentation locale rend le 31 mars, donc mars.
  const auPrintemps = V.dateDeVersement({ canal: 'direct', reserve_le: '2026-03-29' }, DELAIS)
  assert.equal(auPrintemps.jour, '2026-04-01')
  assert.equal(V.moisDuVersement(auPrintemps.jour), '2026-04',
    'une arithmétique en heure locale rangerait ce versement en mars')
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

  // ⚠ ET UNE DATE RÉELLE ILLISIBLE SE DIT — ce test affirmait le contraire,
  // et c était le constat GRAVE de la revue du 26 octobre 2026. Je faisais
  // retomber le calcul sur la prévision « pour ne pas tomber », et le retour
  // devenait INDISCERNABLE d un séjour qui n a jamais eu de date Stripe.
  // Mesuré : un versement réel du 1er novembre, stocké comme un instant
  // (« 2026-11-01T08:30:00+00:00 », la forme la plus probable — un
  // `timestamptz` revient comme ça), s affichait en OCTOBRE, sans un signal.
  for (const abimee of ['bientôt', '2026-11-01T08:30:00Z', '2026-11-01T08:30:00+01:00',
    '2026-11-01 08:30:00', new Date('2026-11-01')]) {
    const v = V.dateDeVersement(SEJOUR({ versement_stripe: abimee }), DELAIS)
    assert.equal(v.jour, null, `${abimee} : la prévision a remplacé le fait en silence`)
    assert.equal(v.motif, 'versement_reel_illisible')
  }
  // ⚠ UN JOUR CIVIL EST EXIGÉ, PAS UN INSTANT, et ce n est pas de la rigidité :
  // convertir un instant en jour demande un FUSEAU, et ce module n en a pas.
  // « 00 h 30 le 1er novembre à Paris » est le 31 octobre en UTC : c est
  // l appelant qui sait lequel des deux compte, et le lui laisser est la seule
  // façon de ne pas choisir à sa place en silence.
  // Une absence, elle, reste une absence : on calcule la prévision.
  for (const vide of [null, undefined, '']) {
    const v = V.dateDeVersement(SEJOUR({ versement_stripe: vide }), DELAIS)
    assert.equal(v.source, 'delai', 'une date absente doit laisser la prévision travailler')
    assert.equal(v.jour, '2026-10-21')
  }

  // ⚠ « STRIPE D ABORD » EST LA RÈGLE DU MODULE, ET AUCUN TEST NE LA TENAIT
  // (mutation survivante, mesurée le 26 octobre 2026) : déplacer ce bloc APRÈS
  // le contrôle du canal passait les 13 tests. Un versement CONSTATÉ ne dépend
  // pas de savoir par quel canal la vente s est faite — c est un fait bancaire,
  // et un canal inconnu n a aucune raison de l effacer.
  const canalInconnuMaisPaye = V.dateDeVersement(
    { canal: 'expedia', arrivee: '2026-10-20', versement_stripe: '2026-11-01' }, DELAIS)
  assert.deepEqual(canalInconnuMaisPaye, { jour: '2026-11-01', source: 'stripe', motif: null },
    'un canal inconnu efface un versement RÉELLEMENT constaté')
  // Et sans règle de délai non plus : le fait n a pas besoin de la prévision.
  const sansRegleMaisPaye = V.dateDeVersement(SEJOUR({ versement_stripe: '2026-11-01' }), {})
  assert.equal(sansRegleMaisPaye.source, 'stripe')
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

test("LE TEST QUI COMPTE : un délai ABSENT n'est pas un délai de zéro jour", () => {
  // ⚠ CONSTAT GRAVE DE LA REVUE DU 26 OCTOBRE 2026. `Number(null)` vaut 0, et
  // passait `Number.isInteger` : une colonne vide devenait un délai de ZÉRO
  // jour, muet. Mesuré : tout le canal décalé d un jour, donc chaque séjour à
  // cheval sur une fin de mois change de colonne — sur un relevé, c est un
  // mois entier qui ne tombe pas juste. `Number('')` vaut 0 aussi, et
  // `Number(true)` vaut 1 : un booléen devenait « un jour ».
  for (const jours of [null, '', true, false, {}, []]) {
    const t = V.tableDesDelais([{ canal: 'airbnb', base: 'arrivee', jours }])
    assert.deepEqual(t, {}, `jours = ${JSON.stringify(jours)} est accepté comme un délai`)
    const v = V.dateDeVersement({ canal: 'airbnb', arrivee: '2026-10-31' },
      { airbnb: { base: 'arrivee', jours } })
    assert.equal(v.jour, null, `jours = ${JSON.stringify(jours)} range un versement`)
    assert.equal(v.motif, 'delai_invalide')
  }
  // Et zéro reste permis quand il est ÉCRIT : un canal qui verse le jour même
  // existe, et c est une valeur, pas une absence.
  const zero = V.tableDesDelais([{ canal: 'airbnb', base: 'arrivee', jours: 0 }])
  assert.deepEqual(zero.airbnb, { base: 'arrivee', jours: 0, libelle: null })
})

test("LE TEST QUI COMPTE : deux lignes pour le même canal, et le mois dépendrait de l'ordre", () => {
  // ⚠ CONSTAT DE LA REVUE. La clé primaire porte le canal BRUT : `booking` et
  // `Booking.com` coexistent sans que la base s en plaigne. Le dernier lu
  // gagnait, et Postgres ne garantit aucun ordre sans `order by` — mesuré, le
  // même séjour versait en octobre OU en novembre selon l ordre des lignes.
  // Un mois décidé par un ordre de lignes est pire qu un refus : le refus se
  // voit, l autre non. On retire les DEUX, et le canal retombe sur
  // `delai_absent`, un motif que l écran sait dire.
  const collision = [
    { canal: 'booking', base: 'depart', jours: 1 },
    { canal: 'Booking.com', base: 'arrivee', jours: 30 }
  ]
  assert.deepEqual(V.tableDesDelais(collision), {})
  assert.deepEqual(V.tableDesDelais([...collision].reverse()), {},
    'le résultat dépend encore de l ordre des lignes')
  // Les autres canaux de la même lecture survivent : une collision sur l un
  // ne doit pas emporter les autres.
  const avecUnBon = V.tableDesDelais([...collision, { canal: 'airbnb', base: 'arrivee', jours: 1 }])
  assert.deepEqual(Object.keys(avecUnBon), ['airbnb'])
})

test("les orthographes que le reste du dépôt connaît déjà sont reconnues ici aussi", () => {
  // ⚠ CONSTAT DE LA REVUE : `shared/calendrier-resa.js` reconnaît `abb` et
  // `bdc`, pas ce module. Une réservation que l hôte VOIT au calendrier
  // étiquetée « Booking.com » avait donc son argent dans AUCUN mois.
  assert.equal(V.canalNormalise('abb'), 'airbnb')
  assert.equal(V.canalNormalise('BDC'), 'booking')
  // ⚠ ET LA RECONNAISSANCE RESTE STRICTE : `+ large` ferait tomber des libellés
  // voisins dans le mauvais canal, et un canal faux est un mois faux.
  assert.equal(V.canalNormalise('abba'), null, 'une sous-chaîne ne suffit pas pour `abb`')
  assert.equal(V.canalNormalise('bdcom'), null)
  assert.equal(V.canalNormalise('air'), null, '`air` n est pas Airbnb')
  assert.equal(V.canalNormalise('book'), null, '`book` n est pas Booking')
})

test('LE TEST QUI COMPTE : une ligne illisible est ÉCARTÉE, pas corrigée', () => {
  // Ces lignes viennent d une écriture manuelle (la table n a pas d écran).
  // Leur donner un repli rangerait des revenus dans un mois inventé ; le canal
  // tombe dans « délai absent », que l écran sait dire.
  // ⚠ L ORDRE DES DEUX LIGNES DE BOOKING COMPTE, et la revue l a mesuré : dans
  // ma première version la ligne abîmée venait AVANT la valide, donc une
  // implémentation qui CORRIGE la base au lieu de l écarter était écrasée
  // ensuite, et le test restait vert. La ligne abîmée vient maintenant APRÈS.
  // ⚠ Et comme deux lignes du même canal sont désormais une collision, la
  // ligne abîmée est écartée AVANT d en devenir une : écartée n est pas
  // présente.
  const t = V.tableDesDelais([
    { canal: 'airbnb', base: 'arrivee', jours: 1 },
    { canal: 'Booking.com', base: 'depart', jours: 2 },      // orthographe réelle
    { canal: 'booking', base: 'au depart', jours: 1 },       // base inconnue
    { canal: 'direct', base: 'reservation', jours: -3 },     // délai négatif
    { canal: 'expedia', base: 'arrivee', jours: 1 }          // canal inconnu
  ])
  assert.deepEqual(Object.keys(t).sort(), ['airbnb', 'booking'])
  assert.deepEqual(t.booking, { base: 'depart', jours: 2, libelle: null },
    'la ligne valide de Booking doit survivre à la ligne abîmée qui la suit')
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
