// tests/revenus-mois.test.js — LES REVENUS D'UN MOIS, PAR BIEN
//
// Etape 4 du lot « Aujourd'hui V5 », spec §4. Ce que ces tests gardent n'est
// pas une addition : c'est le fait qu'AUCUN SEJOUR NE DISPARAISSE EN SILENCE.
//
// ⚠ UN TOTAL AUQUEL IL MANQUE UNE RESERVATION A L'AIR JUSTE. C'est le defaut
// le plus couteux du domaine, parce qu'il ne se voit pas : personne ne compte
// les reservations de tete pour verifier la somme d'un ecran. Chaque sejour
// entre donc soit dans un mois, soit dans un compteur de refus qui porte son
// motif — jamais nulle part.

const test = require('node:test')
const assert = require('node:assert/strict')
const { revenusDuMois, lireSejour, moisDe, fenetreDeLecture } = require('../lib/revenus/mois')
const { tableDesDelais } = require('../lib/revenus/versement')

const DELAIS = tableDesDelais([
  { canal: 'airbnb', base: 'arrivee', jours: 1 },
  { canal: 'booking', base: 'depart', jours: 1 },
  { canal: 'direct', base: 'reservation', jours: 3 }
])

// ⚠ DATES FIGEES, ET C'EST LA REGLE DU DEPOT : ce module N'APPELLE JAMAIS
// l'horloge — `aujourdHui` lui est INJECTE. « Dates relatives si le test lit
// l'horloge, dates figees s'il injecte le temps. » Une fixture relative ici
// rendrait les tests dependants du jour, pour un code qui ne l'est pas.
const AUJOURDHUI = '2026-11-15'

const airbnb = (id, bien, arr, dep, amount, fee = '12.00', extra = {}) => ({
  booking_id: id,
  property_id: bien,
  snapshot: { provider: 'channex', source: 'airbnb', status: 'new', arrival: arr, departure: dep, ...extra },
  raw: {
    amount,
    meta: { amount_type: 'Payout Amount' },
    notes: `Listing Cancellation Host Fee: ${fee}\n`,
    inserted_at: '2026-09-01T10:00:00Z'
  }
})

const booking = (id, bien, arr, dep, centimes) => ({
  booking_id: id,
  property_id: bien,
  snapshot: { provider: 'channex', source: 'bookingcom', status: 'new', arrival: arr, departure: dep },
  raw: {
    rooms: [{ meta: { price_details: { guest_view: { total: { amount: centimes, decimal_places: 2 } } } } }],
    inserted_at: '2026-09-01T10:00:00Z'
  }
})

test('LE TEST QUI COMPTE : un sejour est RANGE dans le mois de son VERSEMENT, pas de ses nuits', () => {
  // Decision explicite de Thierry du 24 octobre 2026 : « Le sejour compte au
  // mois de son versement (31 octobre → novembre), accepte. »
  // Arrivee le 31 octobre, Airbnb verse arrivee + 1 jour = 1er novembre.
  const r = revenusDuMois([airbnb('A', 'P1', '2026-10-31', '2026-11-02', '200.00', '6.00')],
    DELAIS, '2026-11', AUJOURDHUI)
  assert.equal(r.total.sejours, 1, 'le sejour d octobre doit compter en NOVEMBRE')
  assert.equal(r.total.total_cents, 20000)

  // Et il ne compte PAS en octobre — sinon il compterait deux fois.
  const oct = revenusDuMois([airbnb('A', 'P1', '2026-10-31', '2026-11-02', '200.00', '6.00')],
    DELAIS, '2026-10', AUJOURDHUI)
  assert.equal(oct.total.sejours, 0)
  assert.equal(oct.total.total_cents, 0)
})

test('LE TEST QUI COMPTE : « recu » et « a venir » se partagent le total, sans perte', () => {
  const r = revenusDuMois([
    airbnb('A', 'P1', '2026-11-05', '2026-11-08', '400.00'),  // verse le 06/11 -> RECU
    airbnb('B', 'P1', '2026-11-20', '2026-11-23', '300.00')   // verse le 21/11 -> A VENIR
  ], DELAIS, '2026-11', AUJOURDHUI)
  assert.equal(r.total.recu_cents, 40000)
  assert.equal(r.total.a_venir_cents, 30000)
  assert.equal(r.total.total_cents, 70000)
  assert.equal(r.total.recu_cents + r.total.a_venir_cents, r.total.total_cents,
    'un euro qui n est ni recu ni a venir est un euro perdu')
})

test('LE TEST QUI COMPTE : le JOUR du versement est RECU, pas « a venir »', () => {
  // Airbnb verse arrivee + 1 : une arrivee le 14 se verse le 15, c'est-a-dire
  // aujourd'hui. Le ranger « a venir » ferait disparaitre une somme du « recu »
  // pendant 24 h, chaque jour, sur la ligne la plus fraiche de l'ecran.
  const r = revenusDuMois([airbnb('A', 'P1', '2026-11-14', '2026-11-16', '100.00')],
    DELAIS, '2026-11', AUJOURDHUI)
  assert.equal(r.total.recu_cents, 10000)
  assert.equal(r.total.a_venir_cents, 0)
})

test('LE TEST QUI COMPTE : la somme par bien egale le total, toujours', () => {
  const r = revenusDuMois([
    airbnb('A', 'P1', '2026-11-05', '2026-11-08', '400.00'),
    airbnb('B', 'P2', '2026-11-06', '2026-11-09', '250.00'),
    booking('C', 'P2', '2026-11-10', '2026-11-12', 50000),
    airbnb('D', 'P1', '2026-11-22', '2026-11-25', '300.00')
  ], DELAIS, '2026-11', AUJOURDHUI)
  const biens = Object.values(r.par_bien)
  assert.equal(biens.length, 2)
  for (const champ of ['sejours', 'recu_cents', 'a_venir_cents', 'total_cents', 'bruts']) {
    const somme = biens.reduce((t, b) => t + b[champ], 0)
    assert.equal(somme, r.total[champ], `${champ} : les biens somment ${somme}, le total dit ${r.total[champ]}`)
  }
})

test('LE TEST QUI COMPTE : un sejour ANNULE ne compte pas, et un DEMAPPED non plus', () => {
  // ⚠ LE `demapped` EST UN DOUBLON DE MIGRATION : la meme reservation existe en
  // Channex `confirmed`. Le compter doublerait le mois.
  const r = revenusDuMois([
    airbnb('A', 'P1', '2026-11-05', '2026-11-08', '400.00'),
    airbnb('B', 'P1', '2026-11-06', '2026-11-09', '999.00', '1.00', { status: 'cancelled' }),
    airbnb('C', 'P1', '2026-11-07', '2026-11-10', '888.00', '1.00', { status: 'demapped' })
  ], DELAIS, '2026-11', AUJOURDHUI)
  assert.equal(r.total.sejours, 1)
  assert.equal(r.total.total_cents, 40000, 'un sejour annule ou demappe est entre dans le total')
})

test('LE TEST QUI COMPTE : un BRUT entre dans le total, et il est COMPTE comme brut', () => {
  // La decision Q3 de Thierry : on affiche le brut quand la commission n'est
  // pas connue, et la ligne le dit. Donc le chiffre compte — ce qui change est
  // son etiquette, et le bloc doit pouvoir dire COMBIEN de lignes sont dans ce
  // cas.
  const r = revenusDuMois([
    airbnb('A', 'P1', '2026-11-05', '2026-11-08', '400.00'),
    booking('B', 'P1', '2026-11-10', '2026-11-12', 50000)
  ], DELAIS, '2026-11', AUJOURDHUI)
  assert.equal(r.total.sejours, 2)
  assert.equal(r.total.total_cents, 90000, 'le brut doit entrer dans le total')
  assert.equal(r.total.bruts, 1, 'le bloc ne peut pas dire « dont 1 brut » sans ce compteur')
})

test('LE TEST QUI COMPTE : un sejour sans MONTANT reste dans le mois, compte et nomme', () => {
  // Sa date de versement est connue, donc il appartient bien a ce mois. Ce qui
  // manque est le montant. Le sauter le ferait disparaitre ; l'ecran doit
  // pouvoir dire « 1 sejour dont le montant n est pas calculable ».
  const casse = airbnb('X', 'P1', '2026-11-05', '2026-11-08', '400.00')
  casse.raw.notes = 'Listing Cancellation Host Fee: 1.2.3\n'   // Host Fee illisible
  const r = revenusDuMois([airbnb('A', 'P1', '2026-11-06', '2026-11-09', '400.00'), casse],
    DELAIS, '2026-11', AUJOURDHUI)
  assert.equal(r.total.sejours, 2, 'le sejour sans montant a disparu du compte')
  assert.equal(r.total.total_cents, 40000, 'un montant non calculable ne doit pas valoir 0 dans la somme')
  assert.equal(r.total.refuses.montant, 1)
  assert.ok(Object.keys(r.total.motifs).length > 0, 'un refus sans motif n envoie chercher nulle part')
})

test('LE TEST QUI COMPTE : un sejour sans DATE de versement n entre dans AUCUN mois', () => {
  // ⚠ ET IL NE DISPARAIT PAS POUR AUTANT. C'est la reponse a la question posee
  // a Thierry : sans date, il n'y a pas de mois a lui attribuer, donc on ne
  // l'invente pas — mais on le COMPTE a part, avec son motif, et l'ecran le dit.
  const inconnu = {
    booking_id: 'E',
    property_id: 'P1',
    snapshot: { provider: 'channex', source: 'expedia', status: 'new', arrival: '2026-11-15', departure: '2026-11-17' },
    raw: { amount: '100' }
  }
  const r = revenusDuMois([airbnb('A', 'P1', '2026-11-05', '2026-11-08', '400.00'), inconnu],
    DELAIS, '2026-11', AUJOURDHUI)
  assert.equal(r.total.sejours, 1, 'le sejour sans date ne doit pas entrer dans le mois')
  assert.equal(r.total.total_cents, 40000)
  assert.equal(r.hors_mois.sejours, 1, 'le sejour sans date a disparu de tous les compteurs')
  assert.equal(r.hors_mois.refuses.date, 1)
  assert.deepEqual(r.hors_mois.motifs, { canal_inconnu: 1 })
  // Et il ne compte dans aucun autre mois non plus.
  for (const m of ['2026-10', '2026-12', '2027-01']) {
    assert.equal(revenusDuMois([inconnu], DELAIS, m, AUJOURDHUI).total.sejours, 0, `il compte en ${m}`)
  }
})

test('LE TEST QUI COMPTE : une reservation IMPORTEE ne se verse pas a la date de MIGRATION', () => {
  // ⚠ LE CANAL DIRECT SE VERSE « reservation + 3 jours », et une reservation
  // importee porte dans `raw.inserted_at` la date de MIGRATION, pas sa date de
  // vente — mesure du depot, 11 jours de delai apparent contre 2 pour les
  // natives. La ranger au mois de la migration mettrait le revenu d un sejour
  // vendu l an dernier dans le mois ou nous avons bascule le bien.
  const importee = {
    booking_id: 'I',
    property_id: 'P1',
    snapshot: { provider: 'channex', source: 'offline', status: 'new', arrival: '2026-11-20', departure: '2026-11-23' },
    raw: { amount: '300.00', inserted_at: '2026-11-01T10:00:00Z', meta: { is_imported: true } }
  }
  const r = revenusDuMois([importee], DELAIS, '2026-11', AUJOURDHUI)
  assert.equal(r.total.sejours, 0, 'la date de migration a servi de date de vente')
  assert.equal(r.hors_mois.sejours, 1)
  assert.deepEqual(r.hors_mois.motifs, { date_de_vente_non_fiable: 1 },
    'le motif doit nommer la cause : « date manquante » enverrait chercher chez le provider')

  // La MEME reservation, native, se range normalement : reserve_le 01/11 + 3 j.
  const native = JSON.parse(JSON.stringify(importee))
  delete native.raw.meta.is_imported
  const n = revenusDuMois([native], DELAIS, '2026-11', AUJOURDHUI)
  assert.equal(n.total.sejours, 1)
  assert.equal(n.total.total_cents, 30000)
})

test('LE TEST QUI COMPTE : la somme est en CENTIMES, et trente sejours ne derivent pas', () => {
  // ⚠ ADDITIONNER DES FLOTTANTS DERIVE. Deux ecrans qui somment dans un ordre
  // different ne tomberaient pas d'accord, et l'arrondi final afficherait un
  // centime de moins une fois sur deux.
  //
  // ⚠ ET LE MONTANT CHOISI EST 8,21 €, PAS 61,60 € — PARCE QUE 61,60 NE DERIVE
  // PAS. Ma premiere version de ce test utilisait 61,60 : mesure faite,
  // `61.60 * 100` vaut EXACTEMENT 6160 en binaire, donc retirer le
  // `Math.round` du module laissait ce test au VERT (contre-epreuve par
  // mutation : `fail 0`). Un test sur l'arithmetique flottante doit choisir une
  // valeur qui souffre, sinon il ne mesure rien — et il a l'air de mesurer.
  // Les valeurs qui derivent sur 30 additions, mesurees : 0,07 (210,00000000000003),
  // 1,15 (3449,9999999999995) et 8,21 (24630,000000000004).
  const lignes = []
  for (let i = 0; i < 30; i++) {
    lignes.push(airbnb(`A${i}`, 'P1', '2026-11-05', '2026-11-08', '8.21', '0.25'))
  }
  const r = revenusDuMois(lignes, DELAIS, '2026-11', AUJOURDHUI)
  assert.equal(r.total.total_cents, 30 * 821, 'la somme a derive')
  assert.ok(Number.isInteger(r.total.total_cents), 'un total en centimes doit etre entier')
  // Et la preuve que la valeur choisie souffre bien sans arrondi : si elle ne
  // souffrait pas, le test ci-dessus serait vert meme sans `Math.round`.
  const sansArrondi = Array.from({ length: 30 }, () => 8.21 * 100).reduce((a, b) => a + b, 0)
  assert.notEqual(sansArrondi, 30 * 821,
    '8,21 ne derive plus : choisir une autre valeur, sinon ce test ne mesure rien')
})

test('aucun appel ne leve, quelle que soit la forme de l entree', () => {
  // Un module de revenus qui leve fait disparaitre TOUT le bloc, pas une ligne.
  for (const lignes of [null, undefined, [], [null], [{}], [{ snapshot: null, raw: null }],
    'pas un tableau', 42, { 0: 'x' }]) {
    const r = revenusDuMois(lignes, DELAIS, '2026-11', AUJOURDHUI)
    assert.ok(r && r.total && r.par_bien && r.hors_mois)
    assert.equal(r.total.total_cents, 0)
  }
  // Et sans table de delais : tout tombe en « delai absent », rien ne leve.
  const r = revenusDuMois([airbnb('A', 'P1', '2026-11-05', '2026-11-08', '400.00')], {}, '2026-11', AUJOURDHUI)
  assert.equal(r.total.sejours, 0)
  assert.equal(r.hors_mois.refuses.date, 1)
  assert.deepEqual(r.hors_mois.motifs, { delai_absent: 1 })
})

test('`lireSejour` et `moisDe` tiennent leur contrat', () => {
  assert.equal(moisDe('2026-11-15'), '2026-11')
  assert.equal(moisDe('2026-11'), '2026-11')
  assert.equal(moisDe(''), null)
  assert.equal(moisDe(null), null)
  assert.equal(moisDe('pas une date'), null)
  // ⚠ ET LES DEUX FONCTIONS DU MODULE S'ACCORDENT SUR CE QU'EST UN MOIS.
  // `moisDe('2026-13-01')` rendait « 2026-13 » pendant que `fenetreDeLecture`
  // refusait ce mois : l'ecran pouvait demander une fenetre nulle pour un mois
  // que ce module venait de produire.
  for (const x of ['2026-13-01', '2026-00-05', '2026-13', '2026-00']) {
    assert.equal(moisDe(x), null, `moisDe accepte ${x}`)
    assert.equal(fenetreDeLecture(String(x).slice(0, 7), DELAIS), null, `fenetreDeLecture accepte ${x}`)
  }

  const s = lireSejour(airbnb('A', 'P1', '2026-11-05', '2026-11-08', '400.00'), DELAIS)
  assert.equal(s.compte, true)
  assert.equal(s.mois, '2026-11')
  assert.equal(s.montant.valeur, 400)
  assert.equal(s.montant.net, true)
  assert.equal(s.versement.jour, '2026-11-06')

  const annule = lireSejour(airbnb('B', 'P1', '2026-11-05', '2026-11-08', '400.00', '12.00', { status: 'cancelled' }), DELAIS)
  assert.equal(annule.compte, false)
  assert.equal(annule.statut, 'cancelled')
})

test('LE TEST QUI COMPTE : la fenetre de lecture SUIT les delais de la table', () => {
  // ⚠ UNE FENETRE FIGEE FERAIT DISPARAITRE DES SEJOURS EN SILENCE. Le CHECK de
  // `delais_versement` autorise `jours <= 180` : le jour ou un canal se verse a
  // 90 jours, une constante « un mois » laisserait ses sejours hors du total,
  // sans erreur et sans trou visible — juste un mois plus pauvre.
  const f3 = fenetreDeLecture('2026-11', DELAIS)
  assert.equal(f3.delai_max, 3)
  assert.equal(f3.jours_de_marge, 34, '31 jours de sejour + le delai le plus long')

  const avec90 = fenetreDeLecture('2026-11', { ...DELAIS, x: { base: 'depart', jours: 90 } })
  assert.equal(avec90.delai_max, 90)
  assert.equal(avec90.jours_de_marge, 121)
  assert.ok(avec90.debut < f3.debut, 'un delai plus long doit ELARGIR la fenetre')
  assert.ok(avec90.fin > f3.fin)
})

test("LE TEST QUI COMPTE : la fenetre DECLARE qu elle ne suffit pas pour la base `reservation`", () => {
  // ⚠ DEFAUT QUE J'AI TROUVE DANS MA PROPRE PREMIERE VERSION. Une reservation
  // precede son sejour de n'importe quelle duree : un sejour reserve le
  // 29 octobre 2026 pour une arrivee en JUILLET 2027 se verse le
  // 1er novembre 2026 — il compte donc en novembre, et son `arrival` est a huit
  // mois de toute fenetre raisonnable. Le borner sur `arrival` le ferait
  // disparaitre du total en silence.
  //
  // La fonction ne peut pas resoudre ca : elle le DECLARE, et l'appelant lit
  // sans borne de date. Une limite declaree est une limite ; une limite tue est
  // un defaut.
  const avecResa = fenetreDeLecture('2026-11', DELAIS)
  assert.equal(avecResa.bornable, false)
  assert.match(String(avecResa.motif), /RESERVATION/)

  const sansResa = fenetreDeLecture('2026-11', {
    airbnb: { base: 'arrivee', jours: 1 },
    booking: { base: 'depart', jours: 1 }
  })
  assert.equal(sansResa.bornable, true)
  assert.equal(sansResa.motif, null)

  // ET LE CAS REEL : le sejour lointain compte bien dans le mois du versement.
  // C'est ce que la fenetre non bornable permet de lire.
  const lointain = {
    booking_id: 'L',
    property_id: 'P1',
    snapshot: { provider: 'channex', source: 'offline', status: 'new', arrival: '2027-07-10', departure: '2027-07-17' },
    raw: { amount: '900.00', inserted_at: '2026-10-29T10:00:00Z' }
  }
  const r = revenusDuMois([lointain], DELAIS, '2026-11', AUJOURDHUI)
  assert.equal(r.total.sejours, 1, 'un sejour reserve le 29/10 se verse le 01/11 : il compte en NOVEMBRE')
  assert.equal(r.total.total_cents, 90000)
  // Et il ne compte PAS au mois de ses nuits.
  assert.equal(revenusDuMois([lointain], DELAIS, '2027-07', AUJOURDHUI).total.sejours, 0)
})

test('la fenetre tient sur les mois courts et les bascules d annee', () => {
  // Fevrier, et janvier qui remonte sur l'annee precedente : deux endroits ou
  // une arithmetique de dates se trompe d'un mois.
  const fev = fenetreDeLecture('2027-02', DELAIS)
  assert.equal(fev.debut, '2026-12-29')
  assert.equal(fev.fin, '2027-04-03')
  const jan = fenetreDeLecture('2027-01', DELAIS)
  assert.equal(jan.debut, '2026-11-28')
  assert.equal(jan.fin, '2027-03-06')
  // Decembre : la fin passe sur l'annee suivante.
  const dec = fenetreDeLecture('2026-12', DELAIS)
  assert.equal(dec.fin, '2027-02-03')
  // Et une entree qui n'est pas un mois rend `null`, jamais une fenetre inventee.
  for (const x of ['pas un mois', '2026-13', '2026', '', null, undefined, '2026-1']) {
    assert.equal(fenetreDeLecture(x, DELAIS), null, `${String(x)} rend une fenetre`)
  }
})
