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
  // Le motif NOMME les bases fautives, pour qu'on sache laquelle retirer.
  assert.match(String(avecResa.motif), /depart ou reservation|reservation ou depart/)

  // ⚠ ET `depart` NE BORNE PAS DAVANTAGE — correction d'un constat de la review.
  // Ma premiere version ne refusait que `reservation`, en margeant de 31 jours
  // pour couvrir le depart. Mesure : un sejour Booking de 45 nuits (arrivee le
  // 20 septembre, depart le 4 novembre) se verse le 5 novembre, compte en
  // novembre, et son `arrival` tombe HORS de la fenetre — 4 500 € hors de toute
  // requete et de tout compteur. Aucune marge ne ferme ce trou : rien ne borne
  // la duree d'un sejour.
  const surDepart = fenetreDeLecture('2026-11', {
    airbnb: { base: 'arrivee', jours: 1 },
    booking: { base: 'depart', jours: 1 }
  })
  assert.equal(surDepart.bornable, false,
    'une base `depart` est declaree bornable : un long sejour sortirait de la fenetre')
  assert.match(String(surDepart.motif), /depart/)

  // Bornable seulement quand TOUS les canaux se versent sur l'ARRIVEE, qui est
  // la colonne qu'on borne : le decalage est alors le delai lui-meme.
  const sansResa = fenetreDeLecture('2026-11', {
    airbnb: { base: 'arrivee', jours: 1 },
    autre: { base: 'arrivee', jours: 5 }
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

test("LE TEST QUI COMPTE : l'argent d'un bien INCONNU est compte a part, jamais perdu", () => {
  // ⚠ CONSTAT GRAVE DE LA REVIEW DU 26 OCTOBRE 2026, mesure : 1 000 € d'ecart
  // MUET entre le bandeau et la somme des lignes affichees. `par_bien` est
  // groupe par `bookings_snapshot.property_id` ; l'ecran ne peint que les cles
  // qui correspondent a un `provider_property_id` de la liste des biens. Une
  // cle ORPHELINE entrait dans `total` et sortait de l'affichage SANS AUCUNE
  // RESERVE — alors que les montants et les dates non calculables ont chacun
  // leur compteur.
  //
  // Trois sources, toutes atteignables : `property_id` est NULLABLE dans le
  // schema, un re-keying ou une bascule de provider laisse l'historique sur
  // l'ancienne cle (cause racine deja au registre), et un bien supprime laisse
  // ses reservations.
  const connu = airbnb('A', '209413', '2026-11-05', '2026-11-08', '500.00', '15.00')
  const nul = airbnb('B', null, '2026-11-06', '2026-11-09', '500.00', '15.00')
  const disparu = airbnb('C', 'CLE-DISPARUE', '2026-11-07', '2026-11-10', '500.00', '15.00')

  const r = revenusDuMois([connu, nul, disparu], DELAIS, '2026-11', AUJOURDHUI, ['209413'])
  assert.equal(r.total.total_cents, 150000, 'le total doit porter TOUT l argent touche')
  assert.equal(r.hors_biens.sejours, 2, 'les sejours orphelins ne sont pas comptes')
  assert.equal(r.hors_biens.total_cents, 100000,
    'le montant hors biens connus n est pas chiffre : l ecart resterait muet')
  // Et l'invariant : total = ce qui est affichable + ce qui est hors biens.
  const affichable = r.par_bien['209413'].total_cents
  assert.equal(affichable + r.hors_biens.total_cents, r.total.total_cents,
    'un euro n est ni sur une ligne ni dans le compteur hors biens')
})

test("LE TEST QUI COMPTE : `refsConnues` a `null` veut dire « je ne sais pas », pas « aucune »", () => {
  // ⚠ UN APPELANT QUI NE PASSE PAS LA LISTE NE DOIT PAS VOIR TOUS SES REVENUS
  // DECLARES ORPHELINS. Le repli inverse — tout compter hors biens — ferait
  // afficher « 3 séjours rattachés à aucun de vos logements » sur un compte
  // parfaitement sain, et l'hote appellerait.
  const lignes = [airbnb('A', '209413', '2026-11-05', '2026-11-08', '500.00', '15.00')]
  for (const refs of [null, undefined, 'pas un tableau', 42]) {
    const r = revenusDuMois(lignes, DELAIS, '2026-11', AUJOURDHUI, refs)
    assert.equal(r.hors_biens.sejours, 0, `refs=${String(refs)} declare des orphelins a tort`)
    assert.equal(r.hors_biens.total_cents, 0)
  }
  // Et une liste VIDE est une information : aucun bien connu, donc tout est
  // orphelin. C'est different de `null`.
  const vide = revenusDuMois(lignes, DELAIS, '2026-11', AUJOURDHUI, [])
  assert.equal(vide.hors_biens.sejours, 1, 'une liste vide de biens connus ne compte rien hors biens')
})

test("LE TEST QUI COMPTE : un `aujourdHui` qui n'est pas un jour civil est REFUSE", () => {
  // ⚠ LA SOMME SE PERDAIT DES DEUX COTES (constat de la review). `estRecu` rend
  // `null` sur une date illisible, donc ni `recu_cents` ni `a_venir_cents`
  // n'etaient alimentes : l'ecran affichait « 229,88 € » en bandeau et
  // « Reçu 0,00 € · À venir 0,00 € ». Et mon commentaire jurait que la branche
  // `recu === null` existait « pour que la somme ne puisse pas se perdre ».
  //
  // Inerte depuis l'endpoint (`jourParis(0)` est toujours valide), mais la vue
  // ANNEE annoncee au reste du lot est exactement l'appelant futur que ce
  // commentaire pretendait couvrir.
  const lignes = [airbnb('A', 'P1', '2026-11-05', '2026-11-08', '229.88', '6.00')]
  for (const mauvais of [undefined, null, '', '15/11/2026', '2026-11', '2026-13-01', '2026-11-32', 42, {}]) {
    assert.equal(revenusDuMois(lignes, DELAIS, '2026-11', mauvais), null,
      `un aujourdHui ${JSON.stringify(mauvais)} rend un resultat au lieu de refuser`)
  }
  // Et avec un jour valide, l'invariant tient.
  const r = revenusDuMois(lignes, DELAIS, '2026-11', AUJOURDHUI)
  assert.equal(r.recu_cents, undefined)
  assert.equal(r.total.recu_cents + r.total.a_venir_cents, r.total.total_cents,
    'un euro qui n est ni recu ni a venir est un euro perdu')
})

test("LE TEST QUI COMPTE : un LONG sejour ne sort pas de la fenetre, meme bornee", () => {
  // ⚠ LE CAS QUE LA REVIEW A FABRIQUE, ET QUI COUTAIT 4 500 €. Un sejour
  // Booking de 45 nuits : arrivee le 20 septembre, depart le 4 novembre, verse
  // le 5 novembre. Il compte en novembre — et si la fenetre etait bornee sur
  // `arrival` avec 31 jours de marge, la requete ne l'aurait JAMAIS lu.
  const long = {
    booking_id: 'L', property_id: 'P1',
    snapshot: { provider: 'channex', source: 'bookingcom', status: 'new', arrival: '2026-09-20', departure: '2026-11-04' },
    raw: { rooms: [{ meta: { price_details: { guest_view: { total: { amount: 450000, decimal_places: 2 } } } } }], inserted_at: '2026-08-01T10:00:00Z' }
  }
  const r = revenusDuMois([long], DELAIS, '2026-11', AUJOURDHUI)
  assert.equal(r.total.sejours, 1, 'le sejour long ne compte pas au mois de son versement')
  assert.equal(r.total.total_cents, 450000)

  // ET LA GARDE : la fenetre refuse de se declarer bornable des qu'un canal se
  // verse sur le depart, donc l'appelant lit sans borne de date et le sejour
  // arrive jusqu'ici. C'est cette ligne qui empeche la perte.
  const f = fenetreDeLecture('2026-11', DELAIS)
  assert.equal(f.bornable, false)
  // Contre-epreuve : si elle se declarait bornable, l'arrivee serait exclue.
  assert.ok(long.snapshot.arrival < f.debut,
    'ce sejour ne sort plus de la fenetre : en choisir un plus long pour que ce test mesure')
})

test('LE TEST QUI COMPTE : un BLOCAGE n est pas un sejour, et l oracle le sait tout seul', () => {
  // ⚠ CONSTAT DE LA REVIEW DU LOT REVENUS, 26 octobre 2026. Ce module ne
  // connaissait pas `est_blocage` : c'est `scripts/verifier-parite-revenus.js`
  // qui retirait les blocages AVANT de l'appeler. L'oracle n'etait donc fidele
  // que grace a un pre-filtre vivant chez son appelant — et tout AUTRE appelant
  // comptait les 66 blocages mesures en production comme des sejours sans
  // montant. La vue ANNEE annoncee au reste du lot est exactement cet
  // appelant-la : elle n'aurait ete d'accord ni avec l'ecran ni avec le SQL.
  //
  // La regle (decision de Thierry, 27 octobre) : aucun nom de voyageur ET
  // `price` a ZERO — pas nul, zero — ET aucun montant calculable. Beds24 envoie
  // ses blocages comme des reservations confirmees a prix nul.
  const blocage = {
    booking_id: 'BLOC-1',
    property_id: 'P1',
    snapshot: { provider: 'beds24', source: 'direct', status: 'new',
                arrival: '2026-11-10', departure: '2026-11-12' },
    raw: { price: 0, bookingTime: '2026-11-01T10:00:00Z' }
  }
  const vide = revenusDuMois([blocage], DELAIS, '2026-11', AUJOURDHUI)
  assert.strictEqual(vide.total.sejours, 0,
    'un blocage est compte comme un sejour : l ecran annoncerait un sejour sans montant')
  assert.strictEqual(vide.total.refuses.montant, 0,
    'un blocage entre dans le compteur « montant non calculable »')
  assert.deepEqual(vide.par_bien, {}, 'un blocage cree une ligne de bien')

  // ⚠ ET LA CONTRE-EPREUVE : UN VRAI SEJOUR OFFERT RESTE UN SEJOUR. Un geste
  // commercial existe (prix zero, mais un voyageur nomme) : l'ecarter serait
  // perdre une nuit vendue. Les trois indices sont CUMULES, jamais seuls.
  const offert = {
    booking_id: 'OFFERT-1',
    property_id: 'P1',
    snapshot: { provider: 'beds24', source: 'direct', status: 'new',
                arrival: '2026-11-10', departure: '2026-11-12',
                guest_name: 'Camille Durand' },
    raw: { price: 0, bookingTime: '2026-11-01T10:00:00Z' }
  }
  const avec = revenusDuMois([offert], DELAIS, '2026-11', AUJOURDHUI)
  assert.strictEqual(avec.total.sejours, 1,
    'un sejour OFFERT a un voyageur nomme est pris pour un blocage : une nuit vendue disparait')

  // ⚠⚠ ET LA TROISIEME CONDITION : UN BLOCAGE N'A PAS DE REVENU. Elle est
  // gardee dans tests/revenus-derive.test.js pour `estUnBlocage` elle-meme ;
  // ce qui ne l'etait PAR RIEN, c'est que cet appelant lui passe la bonne
  // valeur. Mesure : remplacer `s.montant.valeur != null` par `false` dans ce
  // module ne faisait rougir aucun test, sur aucun des trois fichiers du
  // domaine.
  //
  // Le cas reel, mesure en production : CINQ des lignes qui portaient les deux
  // premiers indices avaient quand meme un MONTANT — `netDuSejour` somme les
  // `invoiceItems` quand `price` est nul, donc une saisie directe a zero avec
  // des charges facturees a un vrai prix. Les exclure ferait disparaitre leur
  // revenu du total.
  const charge = {
    booking_id: 'CHARGE-1',
    property_id: 'P1',
    snapshot: { provider: 'beds24', source: 'direct', status: 'new',
                arrival: '2026-11-10', departure: '2026-11-12' },
    raw: { price: 0, commission: 0, bookingTime: '2026-11-01T10:00:00Z',
           invoiceItems: [{ type: 'charge', lineTotal: 320 }] }
  }
  const avecCharge = revenusDuMois([charge], DELAIS, '2026-11', AUJOURDHUI)
  assert.strictEqual(avecCharge.total.sejours, 1,
    'une ligne sans nom et a `price` zero MAIS qui a rapporte 320 EUR est classee blocage : '
    + 'son revenu disparait du total')
  assert.strictEqual(avecCharge.total.total_cents, 32000,
    'le revenu de cette ligne n entre pas dans le total')
})
