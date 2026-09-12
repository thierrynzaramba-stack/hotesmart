// tests/indicateurs-yield.test.js
// LE DEFAUT QU'ILS EMPECHENT : un indicateur qui vaut « 0 » quand la verite
// est « je ne sais pas ». Un taux d'occupation a 0 % sur un bien ferme, un
// « -100 % » sur un logement qui n'existait pas l'an dernier : dans les deux
// cas le moteur suggererait de brader pour rattraper une perte imaginaire.
//
// Spec : docs/specs/spec-yieldflow-v1.md §6 (etape 3, lot 3.2)

const test = require('node:test')
const assert = require('node:assert')
const {
  calculerIndicateurs, comparerAN1, mediane, periodePrecedente,
  MOTIFS_NON_CALCULABLE, ESTIMABLES
} = require('../lib/yield/indicateurs')

// Un eclatement minimal, a la forme de ce que rend `eclater()`.
function ecl (nuits, { prix = 100, personnes = 2, vente = null, fiable = true, exclues = [] } = {}) {
  return {
    compte: true, personnes,
    date_vente: vente, date_vente_fiable: fiable,
    nuits: nuits.map(d => ({ date: d, prix, hors_reference: exclues.includes(d) }))
  }
}
const cap = (jours, extra = {}) => ({ calculable: true, jours_ouverts: jours, ...extra })

test('les indicateurs de base, sur un mois simple', () => {
  const r = calculerIndicateurs(
    [ecl(['2025-03-01', '2025-03-02'], { prix: 120, vente: '2025-02-01' })],
    { granularite: 'mois', capacites: new Map([['2025-03', cap(31)]]), capacitePersonnes: 2 })
  assert.equal(r.length, 1)
  const m = r[0]
  assert.equal(m.ca, 240)
  assert.equal(m.nuitees, 2)
  assert.equal(m.reservations, 1)
  assert.equal(m.prix_moyen, 120)
  assert.equal(m.taux_occupation, 0.0645, '2 nuitees sur 31 jours ouverts')
  assert.equal(m.revpar, 7.74, '240 € sur 31 jours')
  assert.equal(m.taux_occupation_personnes, 0.0645, '4 personnes-nuits sur 31 × 2')
  assert.equal(m.delai_median, 28, 'du 1er fevrier au 1er mars')
})

test('LE TEST QUI COMPTE : zero jour ouvert n est pas un TO de 0 %', () => {
  // ⚠ COLOMIERS, ferme volontairement a 100 %. « calculable » ne veut pas dire
  // « divisible » : un taux d'occupation n'y vaut pas 0 %, IL N'EXISTE PAS.
  // Diviser donnerait NaN ou Infinity, et un moteur qui affiche 0 %
  // d'occupation sur un bien ferme suggererait de brader.
  const r = calculerIndicateurs([ecl(['2025-03-01'])],
    { granularite: 'mois', capacites: new Map([['2025-03', cap(0)]]) })
  assert.equal(r[0].taux_occupation, null)
  assert.equal(r[0].revpar, null)
  assert.ok(r[0].non_calculable.includes(MOTIFS_NON_CALCULABLE.AUCUN_JOUR_OUVERT))
  assert.equal(r[0].jours_ouverts, 0, 'le chiffre est rendu, mais pas divise')
  assert.equal(r[0].ca, 100, 'le CA, lui, est bien mesure')
})

test('capacite non calculable : TO et RevPAR absents, CA intact', () => {
  const r = calculerIndicateurs([ecl(['2025-03-01'])], {
    granularite: 'mois',
    capacites: new Map([['2025-03', { calculable: false, raison: 'memoire_non_amorcee' }]])
  })
  assert.equal(r[0].taux_occupation, null)
  assert.equal(r[0].revpar, null)
  assert.ok(r[0].non_calculable.includes(MOTIFS_NON_CALCULABLE.CAPACITE))
  assert.equal(r[0].capacite_raison, 'memoire_non_amorcee', 'la raison remonte')
  assert.equal(r[0].ca, 100)
  assert.equal(r[0].nuitees, 1)
})

test('LE TEST QUI COMPTE : le prix moyen ignore les nuits SANS prix', () => {
  // 74 reservations Beds24 reelles ont `price = 0`. Leurs nuits occupent le
  // logement — elles comptent au TO — mais les mettre au denominateur du prix
  // moyen le tirerait vers le bas sans qu'aucun chiffre ne paraisse faux.
  const r = calculerIndicateurs([
    ecl(['2025-03-01', '2025-03-02'], { prix: 100 }),
    { compte: true, personnes: 2, date_vente: null, date_vente_fiable: false,
      nuits: [{ date: '2025-03-03', prix: null, hors_reference: false }] }
  ], { granularite: 'mois', capacites: new Map([['2025-03', cap(31)]]) })
  const m = r[0]
  assert.equal(m.nuitees, 3, 'les trois nuits comptent au TO')
  assert.equal(m.nuits_a_prix_connu, 2)
  assert.equal(m.ca, 200)
  assert.equal(m.prix_moyen, 100, '200 ÷ 2, pas 200 ÷ 3')
  assert.notEqual(m.prix_moyen, 66.67)
})

test('LE TEST QUI COMPTE : les nuits hors reference restent au REALISE', () => {
  // Le realise dit ce qui s'est passe ; la reference dit ce qui est normal.
  // Une fermeture pour travaux appartient au premier, pas au second.
  const r = calculerIndicateurs(
    [ecl(['2025-03-01', '2025-03-02'], { prix: 100, exclues: ['2025-03-02'] })],
    { granularite: 'mois', capacites: new Map([['2025-03', cap(31)]]) })
  const m = r[0]
  assert.equal(m.ca, 200, 'le CA REEL comprend la nuit exclue')
  assert.equal(m.nuitees, 2)
  assert.equal(m.nuitees_hors_reference, 1, 'mais elle est comptee a part')
  assert.equal(m.ca_hors_reference, 100)
})

test('delai : MEDIANE, dates fiables seulement', () => {
  // ⚠ Une seule reservation prise dix-huit mois a l'avance tire la MOYENNE de
  // plusieurs semaines et fait croire a une clientele qui anticipe.
  const r = calculerIndicateurs([
    ecl(['2025-03-01'], { vente: '2025-02-27' }),           // 2 j
    ecl(['2025-03-05'], { vente: '2025-02-28' }),           // 5 j
    ecl(['2025-03-10'], { vente: '2023-09-01' }),           // 556 j : l aberrant
    ecl(['2025-03-15'], { vente: '2025-09-01', fiable: false }) // ignoree
  ], { granularite: 'mois', capacites: new Map([['2025-03', cap(31)]]) })
  assert.equal(r[0].delais_utilises, 3, 'la date non fiable est ecartee')
  assert.equal(r[0].delai_median, 5, 'la mediane resiste a l aberrant')
  assert.notEqual(r[0].delai_median, 187.67)
})

test('aucune date fiable : le delai est NON CALCULABLE, pas zero', () => {
  const r = calculerIndicateurs([ecl(['2025-03-01'], { vente: '2025-01-01', fiable: false })],
    { granularite: 'mois', capacites: new Map([['2025-03', cap(31)]]) })
  assert.equal(r[0].delai_median, null)
  assert.ok(r[0].non_calculable.includes(MOTIFS_NON_CALCULABLE.AUCUNE_DATE_FIABLE))
})

test('un sejour a cheval compte ses nuits dans CHAQUE mois, son delai dans UN seul', () => {
  const r = calculerIndicateurs(
    [ecl(['2025-03-30', '2025-03-31', '2025-04-01'], { prix: 90, vente: '2025-03-01' })],
    { granularite: 'mois', capacites: new Map([['2025-03', cap(31)], ['2025-04', cap(30)]]) })
  assert.equal(r[0].nuitees, 2)
  assert.equal(r[1].nuitees, 1)
  assert.equal(r[0].reservations, 1, 'la resa est comptee au mois de sa PREMIERE nuit')
  assert.equal(r[1].reservations, 0)
  assert.equal(r[1].delai_median, null, 'et son delai n y compte pas deux fois')
})

test('LE TEST QUI COMPTE : N-1 absent se DIT, il ne vaut pas -100 %', () => {
  // Un bien qui n'existait pas l'an dernier n'a pas fait 0 € : il n'a pas de
  // N-1. Afficher « -100 % » ferait croire a un effondrement.
  // Ici l'appelant n'a fourni QUE 2025 : le N-1 est hors du perimetre demande,
  // ce qui n'est pas la meme chose qu'un trou dans la donnee.
  const r = comparerAN1(calculerIndicateurs([ecl(['2025-03-01'], { prix: 100 })],
    { granularite: 'mois', capacites: new Map([['2025-03', cap(31)]]) }))
  const vs = r[0].vs_n1
  assert.equal(vs.periode_n1, '2024-03')
  assert.equal(vs.disponible, false)
  assert.equal(vs.ca.variation, null)
  assert.equal(vs.ca.ecart, null)
  assert.equal(vs.ca.non_calculable, 'n1_hors_perimetre')
  assert.equal(vs.ca.valeur, 100, 'la valeur de l annee en cours reste lisible')
})

test('« hors perimetre » n est pas « absente » : deux causes, deux motifs', () => {
  // ⚠ RELEVE EN REVIEW. `comparerAN1` ne cherche le N-1 que dans le tableau
  // recu. Demander 2026 seul rend « periode_n1_absente » PARTOUT — le lecteur
  // conclut « le bien n'existait pas » alors que l'appelant n'a simplement pas
  // demande 2025. Le motif distingue desormais les deux causes.
  const r = comparerAN1(calculerIndicateurs([
    ecl(['2024-01-05'], { prix: 100 }),
    ecl(['2025-03-01'], { prix: 100 })
  ], { granularite: 'mois',
    capacites: new Map([['2024-01', cap(31)], ['2025-03', cap(31)]]) }))
  const m = r.find(x => x.periode === '2025-03')
  // 2024-01 est present, donc 2024-03 est DANS le perimetre : son absence est
  // un vrai trou de donnee, pas un perimetre trop etroit.
  assert.equal(m.vs_n1.periode_n1, '2024-03')
  assert.equal(m.vs_n1.ca.non_calculable, 'periode_n1_absente')
})

test('LE TEST QUI COMPTE : un mois ouvert sans vente vaut 0 %, pas rien', () => {
  // ⚠ RELEVE EN REVIEW. Les periodes ne naissaient que des eclatements : un
  // mois ouvert ou rien ne s'est vendu ne produisait AUCUNE ligne. Le taux
  // d'occupation de 0 % — le signal le plus fort d'un moteur de yield —
  // disparaissait, et en N-1 il devenait « le bien n'existait pas ».
  const r = calculerIndicateurs([ecl(['2025-03-01'], { prix: 100 })],
    { granularite: 'mois',
      capacites: new Map([['2025-02', cap(28)], ['2025-03', cap(31)]]) })
  const fev = r.find(x => x.periode === '2025-02')
  assert.ok(fev, 'le mois ouvert existe meme sans une seule vente')
  assert.equal(fev.nuitees, 0)
  assert.equal(fev.ca, 0)
  assert.equal(fev.taux_occupation, 0, 'zero pour cent, pas null')
  assert.equal(fev.revpar, 0)
  assert.equal(fev.prix_moyen, null, 'aucune nuit tarifee : pas de prix moyen')

  // Et le N-1 en beneficie : un fevrier vide reste comparable.
  const c = comparerAN1(calculerIndicateurs([ecl(['2025-03-01'], { prix: 100 })],
    { granularite: 'mois',
      capacites: new Map([['2024-03', cap(31)], ['2025-03', cap(31)]]) }))
  const m = c.find(x => x.periode === '2025-03')
  assert.equal(m.vs_n1.disponible, true, 'mars 2024 ouvert et vide est un N-1')
  assert.equal(m.vs_n1.ca.n1, 0)
  assert.equal(m.vs_n1.ca.ecart, 100)
})

test('N-1 present : ecart et variation', () => {
  const r = comparerAN1(calculerIndicateurs([
    ecl(['2024-03-01', '2024-03-02'], { prix: 100 }),
    ecl(['2025-03-01', '2025-03-02', '2025-03-03'], { prix: 100 })
  ], { granularite: 'mois', capacites: new Map([['2024-03', cap(31)], ['2025-03', cap(31)]]) }))
  const m2025 = r.find(x => x.periode === '2025-03')
  assert.equal(m2025.vs_n1.disponible, true)
  assert.equal(m2025.vs_n1.ca.n1, 200)
  assert.equal(m2025.vs_n1.ca.ecart, 100)
  assert.equal(m2025.vs_n1.ca.variation, 0.5, '+50 %')
  assert.equal(m2025.vs_n1.nuitees.ecart, 1)
})

test('LE TEST QUI COMPTE : le drapeau « estime » vit DANS la donnee', () => {
  // ⚠ EXIGENCE DE THIERRY : l'etape 4 ne doit pas POUVOIR afficher un estime
  // comme une mesure. Le drapeau ne peut donc pas vivre seulement dans
  // l'interface.
  const r = calculerIndicateurs([ecl(['2025-03-01'], { prix: 100 })], {
    granularite: 'mois', capacitePersonnes: 2,
    capacites: new Map([['2025-03', cap(31, { estimee: true, jours_estimes_ouverts: 31 })]])
  })
  assert.equal(r[0].capacite_estimee, true)
  assert.equal(r[0].jours_estimes_ouverts, 31)
  assert.ok(r[0].taux_occupation != null && r[0].revpar != null, 'et les valeurs sont bien calculees')

  // ⚠ SEULS LES INDICATEURS QUI DIVISENT PAR LES JOURS OUVERTS SONT ESTIMES.
  // Le CA, les nuitees et le prix moyen restent MESURES quoi qu'il arrive.
  assert.deepEqual(ESTIMABLES, ['taux_occupation', 'revpar', 'taux_occupation_personnes'])
  assert.ok(!ESTIMABLES.includes('ca'))
  assert.ok(!ESTIMABLES.includes('prix_moyen'))

  // Et la comparaison N-1 porte le drapeau sur ces seuls champs.
  const deux = comparerAN1(calculerIndicateurs([
    ecl(['2024-03-01'], { prix: 100 }), ecl(['2025-03-01'], { prix: 100 })
  ], { granularite: 'mois', capacitePersonnes: 2,
       capacites: new Map([
         ['2024-03', cap(31, { estimee: true, jours_estimes_ouverts: 31 })],
         ['2025-03', cap(31)]]) }))
  const m = deux.find(x => x.periode === '2025-03')
  assert.equal(m.vs_n1.taux_occupation.estimee, true, 'un N-1 estime rend la comparaison estimee')
  assert.equal(m.vs_n1.ca.estimee, undefined, 'le CA, lui, reste mesure')
})

test('occupation en personnes : non calculable sans capacite', () => {
  const r = calculerIndicateurs([ecl(['2025-03-01'])],
    { granularite: 'mois', capacites: new Map([['2025-03', cap(31)]]) })  // pas de capacitePersonnes
  assert.equal(r[0].taux_occupation_personnes, null)
  assert.ok(r[0].non_calculable.includes(MOTIFS_NON_CALCULABLE.CAPACITE_PERSONNES))
  assert.ok(r[0].taux_occupation != null, 'le TO en nuitees reste calculable')
})

test('granularites et periode precedente', () => {
  assert.equal(periodePrecedente('2025'), '2024')
  assert.equal(periodePrecedente('2025-03'), '2024-03')
  assert.equal(periodePrecedente('2025-03-15'), '2024-03-15')
  assert.equal(periodePrecedente('n importe quoi'), null)
  const annee = calculerIndicateurs([ecl(['2025-03-01', '2025-08-01'])],
    { granularite: 'annee', capacites: new Map([['2025', cap(365)]]) })
  assert.equal(annee.length, 1)
  assert.equal(annee[0].periode, '2025')
  assert.equal(annee[0].nuitees, 2)
})

test('mediane : pair, impair, vide', () => {
  assert.equal(mediane([5]), 5)
  assert.equal(mediane([1, 3]), 2)
  assert.equal(mediane([3, 1, 2]), 2, 'trie avant de mediane')
  assert.equal(mediane([]), null)
  assert.equal(mediane([NaN, 1, 3]), 2, 'les non-finis sont ecartes')
})

test('le module est PUR', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib/yield/indicateurs.js'), 'utf8')
  assert.ok(!/fetch\(|supabase|createClient/.test(src))
  assert.ok(!/\.insert\(|\.update\(/.test(src))
})

test('LE TEST QUI COMPTE : aucun occupant connu n est pas 0 % d occupation', () => {
  // ⚠ RELEVE EN REVIEW. Le writer du snapshot ecrit `numAdult ?? null` et
  // `occ.adults || null` : le nombre d'occupants MANQUE sur une part reelle de
  // l'historique. Diviser un numerateur vide par une capacite pleine rendait
  // « 0 % d'occupation en personnes » sur des nuits pourtant occupees — la
  // regle « calculable ≠ divisible » enfreinte sur le seul indicateur ou elle
  // ne l'etait pas encore.
  const r = calculerIndicateurs(
    [ecl(['2025-03-01', '2025-03-02'], { prix: 100, personnes: null })],
    { granularite: 'mois', capacites: new Map([['2025-03', cap(31)]]), capacitePersonnes: 4 })
  const m = r[0]
  assert.equal(m.taux_occupation_personnes, null, 'pas de zero : pas de reponse')
  assert.ok(m.non_calculable.includes(MOTIFS_NON_CALCULABLE.AUCUNE_DONNEE_PERSONNES))
  assert.equal(m.taux_occupation, 0.0645, 'le TO en nuits, lui, reste mesure')
  assert.equal(m.ca, 200, 'et le CA aussi')
})

test('occupants connus en PARTIE : le taux sort, mais il se declare ampute', () => {
  const r = calculerIndicateurs([
    ecl(['2025-03-01'], { prix: 100, personnes: 4 }),
    ecl(['2025-03-02'], { prix: 100, personnes: null })
  ], { granularite: 'mois', capacites: new Map([['2025-03', cap(31)]]), capacitePersonnes: 4 })
  const m = r[0]
  assert.ok(m.taux_occupation_personnes > 0, 'une nuit renseignee suffit a calculer')
  assert.equal(m.personnes_partielles, 1, 'et la nuit manquante est COMPTEE')
  assert.ok(m.non_calculable.some(x => x.endsWith('_partiel')))
})

test('LE TEST QUI COMPTE : un RevPAR sur CA ampute le DIT', () => {
  // ⚠ RELEVE EN REVIEW. `prix_moyen` avait ete protege du biais des nuits sans
  // prix (numerateur ET denominateur restreints), pas le RevPAR : il divisait
  // un CA partiel par une capacite complete. Sur la mesure de reference de
  // La bulle 2025 (315 nuitees dont 306 tarifees) il sous-estime d'environ
  // 3 %. Le chiffre reste juste — le CA reel est celui-la — mais il ne doit
  // pas se presenter comme complet.
  const r = calculerIndicateurs([
    ecl(['2025-03-01'], { prix: 100 }),
    ecl(['2025-03-02'], { prix: null })
  ], { granularite: 'mois', capacites: new Map([['2025-03', cap(31)]]) })
  const m = r[0]
  assert.equal(m.nuitees, 2)
  assert.equal(m.revpar, 3.23, '100 € sur 31 jours, et non 200')
  assert.ok(m.non_calculable.includes(MOTIFS_NON_CALCULABLE.REVPAR_PARTIEL))
  assert.equal(m.nuitees_sans_prix, 1)
  assert.equal(m.prix_moyen, 100, 'le prix moyen, lui, reste juste : il exclut les deux')
})

test('LE TEST QUI COMPTE : le numerateur suit le denominateur sur les exceptions', () => {
  // ⚠ RELEVE EN REVIEW DU LOT 3.3. `joursOuverts` retire du denominateur tout
  // jour couvert par une exception declaree par l'hote, mais les nuits vendues
  // ces jours-la restaient au numerateur : 3 nuits dont 2 en exception sur
  // 1 jour ouvert donnaient un taux d'occupation de 300 %, `calculable: true`,
  // sans le moindre motif. Exactement le « 182 % » que la capacite raconte
  // avoir corrige de son cote.
  const e = ecl(['2025-03-01', '2025-03-02', '2025-03-03'],
    { prix: 100, personnes: 2, exclues: ['2025-03-01', '2025-03-02'] })
  const r = calculerIndicateurs([e], { granularite: 'mois', capacitePersonnes: 2,
    capacites: new Map([['2025-03', cap(1)]]) })
  const m = r[0]
  assert.equal(m.taux_occupation, 1, '1 nuit de reference sur 1 jour ouvert')
  assert.ok(m.taux_occupation <= 1, 'JAMAIS plus de 100 %')
  assert.equal(m.revpar, 100, 'et le RevPAR sur le meme perimetre')
  assert.equal(m.taux_occupation_personnes, 1)

  // Le REALISE, lui, garde tout — exigence de Thierry au lot 3.2.
  assert.equal(m.nuitees, 3)
  assert.equal(m.ca, 300)
  assert.equal(m.nuitees_hors_reference, 2)
  assert.equal(m.nuitees_exclues_du_taux, 2, 'et le retrait est DIT')
  assert.equal(m.ca_exclu_du_revpar, 200)
})
