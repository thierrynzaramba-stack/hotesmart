const test = require('node:test')
const assert = require('node:assert')
const { lignesCloses, lignesFutures, _interne } = require('../lib/marche/comparables-releves')

// ⚠ DATES FIGEES, PARCE QUE CE MODULE INJECTE LE TEMPS. `aujourdhui` est un
// parametre : aucune de ces fonctions ne lit l'horloge. Regle du depot —
// *dates relatives si le test lit l'horloge, dates figees s'il injecte le
// temps.* Des dates relatives ici rendraient les fenetres mouvantes.
const AUJ = '2026-10-15'

const mois = (m, revenue) => ({ date: `${m}-01`, revenue })
const jour = (d, available, rate) => ({ date: d, available, rate, min_nights: 2 })

test('LE TEST QUI COMPTE : le mois COURANT n est pas clos', () => {
  // Il bougera encore. L'inclure ferait entrer dans la bande du realise un
  // chiffre qui n'est pas final.
  const out = lignesCloses({ listingId: '1', aujourdhui: AUJ, mensuel: [mois('2026-10', 500), mois('2026-09', 400)] })
  const moisRendus = out.map(l => l.mois)
  assert.deepStrictEqual(moisRendus, ['2026-09-01'],
    `octobre 2026 est rendu comme clos alors qu il est en cours : ${JSON.stringify(moisRendus)}`)
})

test('LE TEST QUI COMPTE : un revenu absent rend `null` AVEC son motif, jamais 0', () => {
  // « Non calculable » n est jamais zero. Un montant nul sans motif devient un
  // zero des que quelqu un l additionne.
  const out = lignesCloses({ listingId: '1', aujourdhui: AUJ, mensuel: [mois('2026-09', null), mois('2026-08', undefined)] })
  assert.strictEqual(out.length, 2)
  for (const l of out) {
    assert.strictEqual(l.montant_estime_cents, null, 'un revenu absent est devenu un nombre')
    assert.ok(l.motif && l.motif.length > 3, `le motif manque : ${JSON.stringify(l)}`)
  }
})

test('LE TEST QUI COMPTE : les euros deviennent des CENTIMES', () => {
  const [l] = lignesCloses({ listingId: '1', aujourdhui: AUJ, mensuel: [mois('2026-09', 4006.5)] })
  assert.strictEqual(l.montant_estime_cents, 400650,
    `4006,50 € rendu ${l.montant_estime_cents} : l unite n est pas le centime`)
})

test('LE TEST QUI COMPTE : un champ `available` ABSENT ne compte pas comme occupe', () => {
  // ⚠ `!j.available` compterait `undefined` comme une nuit indisponible, et
  // gonflerait la bande sans que rien ne le dise. C est `=== false` qui tranche.
  const out = lignesFutures({
    listingId: '1', aujourdhui: AUJ,
    jours: [jour('2026-11-01', undefined, 100), jour('2026-11-02', false, 100), jour('2026-11-03', true, 100)]
  })
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].nuits_indisponibles, 1,
    `${out[0].nuits_indisponibles} nuits comptees indisponibles pour une seule a false`)
  assert.strictEqual(out[0].montant_affiche_cents, 10000)
  // Les trois jours ont ete MESURES, meme ceux qui sont disponibles.
  assert.strictEqual(out[0].nuits_mesurees, 3, 'la couverture du mois est fausse')
})

test('LE TEST QUI COMPTE : le PASSE du calendrier est ecarte', () => {
  // AirROI rend des jours deja ecoules. Les garder melangerait du passe non
  // clos a la bande du futur.
  const out = lignesFutures({
    listingId: '1', aujourdhui: AUJ,
    jours: [jour('2026-10-01', false, 100), jour('2026-10-20', false, 100)]
  })
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].nuits_mesurees, 1,
    'un jour anterieur a aujourd hui est entre dans le mois en cours')
})

test('LE TEST QUI COMPTE : un mois TRONQUE se declare par sa couverture', () => {
  // Le calendrier porte ~360 jours : son dernier mois est coupe. Sans
  // `nuits_mesurees`, un mois couvert sur 3 jours se lit comme un mois creux.
  const out = lignesFutures({
    listingId: '1', aujourdhui: AUJ,
    jours: [jour('2027-09-01', false, 90), jour('2027-09-02', false, 90), jour('2027-09-03', true, 90)]
  })
  const sept = out.find(l => l.mois === '2027-09-01')
  assert.ok(sept, 'le mois tronque n est pas rendu')
  assert.strictEqual(sept.nuits_mesurees, 3,
    `couverture annoncee ${sept.nuits_mesurees} pour 3 jours fournis sur 30`)
  assert.ok(sept.nuits_mesurees < _interne.joursDuMois('2027-09'),
    'le test ne demontre rien : le mois fourni est complet')
})

test('LE TEST QUI COMPTE : zero nuit indisponible est un FAIT, pas une absence', () => {
  // C est le seul `0` legitime du module : le mois a ete mesure, il est vide.
  const out = lignesFutures({
    listingId: '1', aujourdhui: AUJ,
    jours: [jour('2026-12-01', true, 100), jour('2026-12-02', true, 100)]
  })
  assert.strictEqual(out[0].montant_affiche_cents, 0)
  assert.strictEqual(out[0].nuits_indisponibles, 0)
  assert.strictEqual(out[0].motif, null, 'un mois mesure et vide porte un motif : ce n est pas une absence')
})

test('LE TEST QUI COMPTE : un prix manquant sur une nuit occupee se DECLARE', () => {
  // La somme sous-estime. Le dire vaut mieux qu un chiffre dont personne ne
  // sait qu il est incomplet.
  const out = lignesFutures({
    listingId: '1', aujourdhui: AUJ,
    jours: [jour('2026-11-01', false, 100), jour('2026-11-02', false, 0), jour('2026-11-03', false, null)]
  })
  assert.strictEqual(out[0].nuits_indisponibles, 3)
  assert.strictEqual(out[0].montant_affiche_cents, 10000, 'un prix nul ou absent a ete somme')
  assert.match(String(out[0].motif), /2/, `le motif ne compte pas les deux nuits sans prix : « ${out[0].motif} »`)
})

test('LE TEST QUI COMPTE : les deux natures ne remplissent JAMAIS la meme colonne', () => {
  // Deux grandeurs differentes sous un meme nom finissent additionnees.
  const clos = lignesCloses({ listingId: '1', aujourdhui: AUJ, mensuel: [mois('2026-09', 400)] })[0]
  const futur = lignesFutures({ listingId: '1', aujourdhui: AUJ, jours: [jour('2026-11-01', false, 100)] })[0]
  assert.strictEqual(clos.nature, 'clos')
  assert.strictEqual(clos.montant_affiche_cents, null, 'un mois clos remplit la colonne du futur')
  assert.strictEqual(futur.nature, 'futur')
  assert.strictEqual(futur.montant_estime_cents, null, 'un mois futur remplit la colonne du passe')
  // Et aucune colonne ne s appelle « revenu » (regle de Thierry).
  for (const l of [clos, futur]) {
    for (const k of Object.keys(l)) {
      assert.ok(!/revenu/i.test(k), `la colonne « ${k} » s appelle revenu`)
    }
  }
})

test('LE TEST QUI COMPTE : un mois rendu DEUX FOIS ne produit qu une ligne', () => {
  // La cle d unicite le refuserait en base, mais un refus de contrainte est un
  // rapport illisible : on tranche avant d ecrire.
  const out = lignesCloses({ listingId: '1', aujourdhui: AUJ, mensuel: [mois('2026-09', 400), mois('2026-09', 999)] })
  assert.strictEqual(out.length, 1, 'le mois double a produit deux lignes')
  assert.strictEqual(out[0].montant_estime_cents, 40000, 'ce n est pas la premiere ligne qui a ete gardee')
})

test('RECENSEMENT : la profondeur borne les mois clos', () => {
  const vieux = Array.from({ length: 40 }, (_, i) => {
    let m = '2026-09'
    for (let k = 0; k < i; k++) m = _interne.moisPrecedent(m)
    return mois(m, 100)
  })
  const out = lignesCloses({ listingId: '1', aujourdhui: AUJ, mensuel: vieux })
  assert.strictEqual(out.length, _interne.PROFONDEUR_MOIS,
    `${out.length} mois rendus pour une profondeur de ${_interne.PROFONDEUR_MOIS}`)
})
