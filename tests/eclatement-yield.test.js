// tests/eclatement-yield.test.js
// LE SOCLE DE TOUT LE MOTEUR. Chaque indicateur de l'etape 3 — CA, RevPAR,
// nuitees, prix moyen, delai — se calcule sur ces nuits. Une erreur ici les
// fausse TOUS, du meme facteur, sans qu'aucun ne paraisse aberrant.
//
// ⚠ REGLE 8 : les cas sont ceux des DONNEES REELLES, valides avec Thierry le
// 12 septembre 2026 avant l'ecriture du code (« validation sur pieces »). Les
// payloads sont reduits aux champs que le module lit, et vides de toute donnee
// personnelle.

const test = require('node:test')
const assert = require('node:assert')
const {
  eclater, prixVoyageur, dateDeVente, construirePontDemapped,
  ventilationMensuelle, STATUTS_COMPTES, SEUIL_LONG_SEJOUR
} = require('../lib/yield/eclatement')

const r2 = v => (v == null ? null : Math.round(v * 100) / 100)

// ─── Les six pieces reelles ─────────────────────────────────────────────────
const PIECES = {
  beds24Airbnb: {
    booking_id: '81234567', user_id: 'u1', property_id: '1655ab32',
    snapshot: { provider: 'beds24', source: 'airbnb', status: 'confirmed',
      arrival: '2022-09-23', departure: '2022-09-25', amount: 129 },
    raw: { price: 129, bookingTime: '2022-09-05T10:12:00Z' }
  },
  beds24Booking: {
    booking_id: '81234568', user_id: 'u1', property_id: '1655ab32',
    snapshot: { provider: 'beds24', source: 'booking', status: 'confirmed',
      arrival: '2022-10-07', departure: '2022-10-09', amount: 234 },
    raw: { price: 234, bookingTime: '2022-09-05T11:00:00Z' }
  },
  channexAirbnb: {
    booking_id: 'c-1', user_id: 'u1', property_id: '0544fd9a',
    snapshot: { provider: 'channex', source: 'AirBNB', status: 'confirmed',
      arrival: '2026-08-13', departure: '2026-08-15', amount: 164.43 },
    raw: { amount: '164.43', meta: { amount_type: 'Payout Amount' },
      notes: 'Listing Base Price: 180.00\nListing Cancellation Host Fee: 37.57\n',
      inserted_at: '2026-07-31T09:00:00Z' }
  },
  channexBooking: {
    booking_id: 'c-2', user_id: 'u1', property_id: '0544fd9a',
    snapshot: { provider: 'channex', source: 'BookingCom', status: 'confirmed',
      arrival: '2026-08-08', departure: '2026-08-09', amount: 107.01 },
    raw: { amount: '107.01', inserted_at: '2026-08-08T07:00:00Z',
      rooms: [{ meta: { price_details: { guest_view: { total: { amount: '10701', decimal_places: 2 } } } } }] }
  },
  demapped: {
    booking_id: '83137395', user_id: 'u1', property_id: '1655ab32',
    snapshot: { provider: 'beds24', source: 'airbnb', status: 'demapped',
      arrival: '2026-09-16', departure: '2026-09-20', otaReservationCode: 'HMEA8PYCPM' },
    raw: { price: 485, bookingTime: '2026-03-02T14:00:00Z' }
  },
  jumelle: {
    booking_id: '99af35d0', user_id: 'u1', property_id: '1655ab32',
    snapshot: { provider: 'channex', source: 'AirBNB', status: 'confirmed',
      arrival: '2026-09-16', departure: '2026-09-20', amount: 394.78,
      otaReservationCode: 'HMEA8PYCPM' },
    raw: { amount: '394.78', meta: { amount_type: 'Payout Amount', is_imported: true },
      notes: 'Listing Base Price: 413.00\nListing Cancellation Host Fee: 90.22\n',
      inserted_at: '2026-09-10T18:00:00Z' }
  }
}

test('PIECE 1 et 2 — Beds24 : `price` est le prix voyageur, sur les deux canaux', () => {
  const a = eclater(PIECES.beds24Airbnb)
  assert.equal(a.nuits.length, 2)
  assert.equal(r2(a.prix_total), 129)
  assert.equal(r2(a.prix_par_nuit), 64.5)
  assert.deepEqual(a.nuits.map(n => n.date), ['2022-09-23', '2022-09-24'],
    'le jour de DEPART n est pas une nuit')

  const b = eclater(PIECES.beds24Booking)
  assert.equal(r2(b.prix_total), 234)
  assert.equal(r2(b.prix_par_nuit), 117)
})

test('LA PIECE QUI COMPTE — Channex/Airbnb : `amount` est un NET HOTE', () => {
  // ⚠ 22,85 % d'ecart. Lire `snapshot.amount` directement amputerait le CA
  // Airbnb de pres d'un quart, sans qu'aucun chiffre ne paraisse aberrant.
  const e = eclater(PIECES.channexAirbnb)
  assert.equal(r2(e.prix_total), 202, 'amount (164,43) + Host Fee (37,57)')
  assert.equal(r2(e.prix_par_nuit), 101)
  assert.notEqual(r2(e.prix_total), PIECES.channexAirbnb.snapshot.amount,
    'le prix voyageur n est PAS snapshot.amount')
  assert.ok(/amount \+ Host Fee/.test(e.source_prix))
})

test('le discriminant est `amount_type`, pas le nom du canal', () => {
  // « Payout Amount » est un reglage que NOUS posons : un canal repris
  // ailleurs peut servir un `amount` deja brut, et y ajouter la retenue
  // rendrait ~23 % AU-DESSUS du prix paye.
  const brut = JSON.parse(JSON.stringify(PIECES.channexAirbnb))
  brut.raw.meta.amount_type = 'Gross Amount'
  const e = eclater(brut)
  assert.equal(e.prix_total, null, 'on refuse plutot que de supposer')
  assert.match(e.ecarte, /amount_type inattendu/)
  assert.equal(e.nuits.length, 2, 'mais les nuitees comptent quand meme au TO')
})

test('PIECE 4 — Channex/Booking : guest_view.total, en centimes', () => {
  const e = eclater(PIECES.channexBooking)
  assert.equal(r2(e.prix_total), 107.01)
  assert.equal(e.nuits.length, 1)
})

test('LA PIECE QUI COMPTE — le pont demapped emprunte la date, jamais le montant', () => {
  // La jumelle Channex est IMPORTEE : son `inserted_at` vaut la date de
  // MIGRATION (10 septembre) et non de vente (2 mars). Six mois d'ecart, sur
  // la mesure meme que le « a date » existe pour produire.
  const { pont, refus } = construirePontDemapped([PIECES.demapped, PIECES.jumelle])
  assert.equal(refus.length, 0)
  assert.equal(pont.size, 1)

  const j = eclater(PIECES.jumelle, { pont })
  assert.equal(j.date_vente, '2026-03-02', 'la VRAIE date, empruntee a la demappee')
  assert.equal(j.date_vente_fiable, true)
  assert.match(j.date_vente_source, /pont demapped/)
  assert.equal(r2(j.prix_total), 485, 'le MONTANT reste celui de la jumelle')

  // Sans le pont, la date serait celle de la migration.
  const sansPont = eclater(PIECES.jumelle)
  assert.equal(sansPont.date_vente, '2026-09-10')
  assert.equal(sansPont.date_vente_fiable, false, 'et elle est marquee NON FIABLE')

  // La demappee elle-meme n est JAMAIS comptee.
  const d = eclater(PIECES.demapped, { pont })
  assert.equal(d.compte, false)
  assert.equal(d.nuits.length, 0)
  assert.match(d.ecarte, /hors liste blanche/)
})

test('LE TEST QUI COMPTE : les deux gardes du pont', () => {
  // Garde 1 : MEME BIEN en plus du meme code.
  const ailleurs = JSON.parse(JSON.stringify(PIECES.jumelle))
  ailleurs.property_id = 'UN-AUTRE-BIEN'
  const { pont: p1 } = construirePontDemapped([PIECES.demapped, ailleurs])
  assert.equal(p1.size, 0, 'un meme code OTA sur DEUX biens n apparie rien')

  // Garde 2 : REFUS au-dela de deux lignes — on ne sait plus laquelle est la
  // jumelle de laquelle, et apparier au hasard donnerait une date fausse a une
  // vraie reservation.
  const troisieme = JSON.parse(JSON.stringify(PIECES.jumelle))
  troisieme.booking_id = 'c-3'
  const { pont: p2, refus } = construirePontDemapped([PIECES.demapped, PIECES.jumelle, troisieme])
  assert.equal(p2.size, 0)
  assert.equal(refus.length, 1)
  assert.equal(refus[0].lignes, 3)
})

test('liste BLANCHE : seul `confirmed` compte', () => {
  assert.deepEqual(STATUTS_COMPTES, ['confirmed'])
  for (const st of ['cancelled', 'blocked', 'request', 'demapped']) {
    const l = JSON.parse(JSON.stringify(PIECES.beds24Airbnb))
    l.snapshot.status = st
    const e = eclater(l)
    assert.equal(e.compte, false, st)
    assert.equal(e.nuits.length, 0, `${st} ne produit AUCUNE nuit`)
    assert.match(e.ecarte, new RegExp(st))
  }
})

test('une nuit SANS PRIX reste une nuitee occupee', () => {
  // 79 reservations Beds24 reelles ont `price = 0`. Elles occupent le
  // logement : elles comptent au taux d occupation, jamais au CA.
  const l = JSON.parse(JSON.stringify(PIECES.beds24Airbnb))
  l.raw.price = 0
  const e = eclater(l)
  assert.equal(e.compte, true)
  assert.equal(e.nuits.length, 2, 'les nuitees comptent')
  assert.equal(e.prix_total, null, 'le CA, non')
  assert.ok(e.nuits.every(n => n.prix === null))
  assert.match(e.ecarte, /prix non calculable/)
})

test('LE TEST QUI COMPTE : les nuits en exception sont MARQUEES, pas supprimees', () => {
  // Une nuit hors reference reste une nuit VENDUE : elle compte au realise, et
  // n est ecartee que du calcul de la REFERENCE. La supprimer ici la retirerait
  // aussi du CA reel — ce qui serait faux.
  const exclus = new Set(['2022-09-24'])
  const e = eclater(PIECES.beds24Airbnb, { joursExclus: exclus })
  assert.equal(e.nuits.length, 2, 'les DEUX nuits sont toujours la')
  assert.equal(r2(e.prix_total), 129, 'le CA reel est intact')
  assert.equal(e.nuits.find(n => n.date === '2022-09-23').hors_reference, false)
  assert.equal(e.nuits.find(n => n.date === '2022-09-24').hors_reference, true)
})

test('dates de vente : en JOURS, et le corrompu est marque non fiable', () => {
  // ⚠ EN JOURS, JAMAIS EN INSTANTS. Comparer un `bookingTime` horodate a un
  // `arrival` a minuit declarait « posterieures a l arrivee » les 162 ventes
  // du jour meme — le delai 0, 11 % de l historique, et precisement ce que la
  // courbe de pickup existe pour mesurer.
  const memeJour = JSON.parse(JSON.stringify(PIECES.beds24Airbnb))
  memeJour.raw.bookingTime = '2022-09-23T09:00:00Z'   // le matin de l arrivee
  const ok = dateDeVente(memeJour.snapshot, memeJour.raw)
  assert.equal(ok.valeur, '2022-09-23')
  assert.equal(ok.fiable, true, 'une vente le matin meme est un DELAI 0, pas une anomalie')

  const apres = JSON.parse(JSON.stringify(PIECES.beds24Airbnb))
  apres.raw.bookingTime = '2022-09-26T09:00:00Z'      // apres l arrivee
  const ko = dateDeVente(apres.snapshot, apres.raw)
  assert.equal(ko.fiable, false)
  assert.match(ko.raison, /posterieure a l arrivee/)
})

test('LONG SEJOUR : marque, et ventile au prorata des nuits de chaque mois', () => {
  // ⚠ JAMAIS RENCONTRE EN DONNEES REELLES AU 12/09/2026.
  // Les 1 465 reservations du coeur ne contiennent AUCUN sejour de plus de
  // 24 nuits : ce cas est eprouve sur donnees CONSTRUITES uniquement. Le
  // premier sejour long reel doit declencher une verification de ce calcul
  // contre la facture du voyageur — et ce commentaire doit alors etre retire.
  const long = {
    booking_id: 'long-1', user_id: 'u1', property_id: 'p1',
    snapshot: { provider: 'beds24', source: 'direct', status: 'confirmed',
      arrival: '2026-01-20', departure: '2026-03-05' },   // 44 nuits sur 3 mois
    raw: { price: 4400, bookingTime: '2025-12-01T10:00:00Z' }
  }
  const e = eclater(long)
  assert.equal(e.nuits.length, 44)
  assert.equal(e.long_sejour, true, `au-dela de ${SEUIL_LONG_SEJOUR} nuits`)
  assert.equal(r2(e.prix_par_nuit), 100)

  const v = ventilationMensuelle(e)
  assert.deepEqual(v.map(m => m.mois), ['2026-01', '2026-02', '2026-03'])
  assert.equal(v[0].nuits, 12, 'du 20 au 31 janvier')
  assert.equal(v[1].nuits, 28, 'fevrier 2026 entier')
  assert.equal(v[2].nuits, 4, 'du 1er au 4 mars — le 5 est le depart')
  assert.equal(v.reduce((s, m) => s + m.nuits, 0), 44, 'aucune nuit perdue')
  assert.equal(r2(v.reduce((s, m) => s + m.prix, 0)), 4400, 'ni aucun euro')
  // Le CA ne verse PAS tout au mois d arrivee.
  assert.equal(r2(v[0].prix), 1200)
  assert.equal(r2(v[1].prix), 2800)
})

test('un sejour court n est pas marque long', () => {
  assert.equal(eclater(PIECES.beds24Airbnb).long_sejour, false)
})

test('le module est PUR : ni base, ni reseau, ni provider', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib/yield/eclatement.js'), 'utf8')
  assert.ok(!/fetch\(|channelCall|createClient|supabase\./.test(src),
    'fonctions pures : c est ce qui permet de les eprouver sur les pieces reelles')
  assert.ok(!/\.insert\(|\.update\(|\.delete\(/.test(src), 'lecture seule')
  // Et il ne recopie pas le canon des statuts : il l importe.
  assert.ok(/require\('\.\.\/bookings-snapshot-status'\)/.test(src))
})

// ─── Les huit défauts trouvés en review, chacun avec son cas ────────────────

test('LE TEST QUI COMPTE : le statut se lit par readStatus, JAMAIS en brut', () => {
  // ⚠ REGLE GRAVEE DANS `lib/nuits-occupees.js`. Les lignes ecrites AVANT
  // l'unification portent le vocabulaire BRUT du provider. Un snapshot Beds24
  // `status: 'new'` SIGNIFIE CONFIRME : le lire en brut l'ecartait comme
  // « hors liste blanche », et la reservation disparaissait du CA ET des
  // nuitees, sans la moindre erreur.
  const brut = JSON.parse(JSON.stringify(PIECES.beds24Airbnb))
  brut.snapshot.status = 'new'
  const e = eclater(brut)
  assert.equal(e.compte, true, '« new » est un CONFIRME chez Beds24')
  assert.equal(e.nuits.length, 2)
  assert.equal(r2(e.prix_total), 129)
  assert.equal(e.statut, 'confirmed', 'le statut rendu est CANONIQUE')

  // `black` = blocage proprietaire : ecarte, mais reconnu comme tel.
  const bloc = JSON.parse(JSON.stringify(PIECES.beds24Airbnb))
  bloc.snapshot.status = 'black'
  assert.equal(eclater(bloc).statut, 'blocked')
})

test('LE TEST QUI COMPTE : un Host Fee illisible ne produit JAMAIS de NaN', () => {
  // ⚠ `Number('1.2.3')` rend NaN, et NaN n'est pas `null` : le chemin « prix
  // calculable » etait pris, chaque nuit valait NaN, et UNE SEULE ligne de ce
  // type rendait NaN le CA du mois et toute somme en aval. Un NaN ne se voit
  // pas — il se propage.
  for (const mauvais of ['1.2.3', '.', 'abc', '']) {
    const l = JSON.parse(JSON.stringify(PIECES.channexAirbnb))
    l.raw.notes = `Listing Cancellation Host Fee: ${mauvais}\n`
    const e = eclater(l)
    assert.equal(e.prix_total, null, `« ${mauvais} » doit etre refuse`)
    assert.ok(e.ecarte, 'et la raison est dite')
    assert.ok(e.nuits.every(n => n.prix === null), 'aucune nuit a NaN')
  }
  // Et la ventilation ne propage aucun NaN.
  const l = JSON.parse(JSON.stringify(PIECES.channexAirbnb))
  l.raw.notes = 'Listing Cancellation Host Fee: 1.2.3\n'
  const v = ventilationMensuelle(eclater(l))
  assert.ok(v.every(m => Number.isFinite(m.prix)), 'la ventilation reste finie')
  assert.equal(v[0].nuits_avec_prix, 0)
})

test('Beds24 direct a `price = 0` : le repli sur les charges s applique', () => {
  // La spec §9 le prevoit et le writer l'implemente deja. Sans lui, 5
  // reservations REELLES perdent leur CA alors que le montant est la.
  const l = {
    booking_id: 'd-1', user_id: 'u1', property_id: 'p1',
    snapshot: { provider: 'beds24', source: 'direct', status: 'confirmed',
      arrival: '2026-05-01', departure: '2026-05-03' },
    raw: { price: 0, commission: 0, bookingTime: '2026-04-01T10:00:00Z',
      invoiceItems: [{ type: 'charge', lineTotal: 150 }] }
  }
  const e = eclater(l)
  assert.equal(r2(e.prix_total), 150)
  assert.match(e.source_prix, /charges/)

  // ⚠ MAIS JAMAIS SUR UN CANAL OTA AVEC COMMISSION : la somme des charges y
  // vaut le NET HOTE, pas le total voyageur — ~19 % d'ecart invisible.
  const ota = JSON.parse(JSON.stringify(l))
  ota.snapshot.source = 'airbnb'
  ota.raw.commission = 25
  assert.equal(eclater(ota).prix_total, null, 'aucun repli hors saisie directe')
})

test('LE TEST QUI COMPTE : aucun repli silencieux sur `amount`', () => {
  // ⚠ SPEC §9 REGLE 2. La branche « offline » etait un attrape-tout :
  // n'importe quel `ota_name` inconnu (Expedia, VRBO…) y prenait `amount` pour
  // un prix voyageur. Si ce canal sert un net hote, c'est ~23 % sous le prix
  // paye, SANS SIGNAL.
  const inconnu = JSON.parse(JSON.stringify(PIECES.channexAirbnb))
  inconnu.snapshot.source = 'Expedia'
  const e = eclater(inconnu)
  assert.equal(e.prix_total, null, 'un canal non prevu echoue BRUYAMMENT')
  assert.match(e.ecarte, /canal non prevu/)

  // Et le routage est EXACT : « Direct Booking » ne doit pas tomber dans la
  // branche Booking.com.
  const piege = JSON.parse(JSON.stringify(PIECES.channexBooking))
  piege.snapshot.source = 'Direct Booking'
  assert.match(eclater(piege).ecarte, /canal non prevu/)

  // Offline, lui, reste legitime.
  const off = JSON.parse(JSON.stringify(PIECES.channexBooking))
  off.snapshot.source = 'Offline'
  off.raw.amount = '250'
  assert.equal(r2(eclater(off).prix_total), 250)
})

test('Booking multi-chambres : une somme PARTIELLE n est pas un prix', () => {
  // Sauter une chambre dont le `guest_view` est illisible rendait un total
  // ampute d'une chambre entiere, etiquete comme valide.
  const l = JSON.parse(JSON.stringify(PIECES.channexBooking))
  l.raw.rooms = [
    { meta: { price_details: { guest_view: { total: { amount: '10701', decimal_places: 2 } } } } },
    { meta: {} }   // seconde chambre illisible
  ]
  const e = eclater(l)
  assert.equal(e.prix_total, null, 'on refuse plutot que de compter une chambre sur deux')
  assert.match(e.ecarte, /guest_view illisible/)

  // Deux chambres lisibles : la somme des DEUX.
  l.raw.rooms[1] = { meta: { price_details: { guest_view: { total: { amount: '5000', decimal_places: 2 } } } } }
  assert.equal(r2(eclater(l).prix_total), 157.01)
})

test('`provider` absent : la ligne ne bascule pas dans la branche Channex', () => {
  // Les lignes ecrites avant l'unification n'ont AUCUN champ `provider` — c'est
  // la raison d'etre de `scripts/backfill-snapshot-provider.js`. Sans repli,
  // une telle ligne Beds24 perdait sa date de vente ET son CA.
  const l = JSON.parse(JSON.stringify(PIECES.beds24Airbnb))
  delete l.snapshot.provider
  const e = eclater(l, { defaultProvider: 'beds24' })
  assert.equal(r2(e.prix_total), 129)
  assert.equal(e.date_vente, '2022-09-05')
  assert.equal(e.date_vente_fiable, true)
})

test('la cle du pont porte le COMPTE, pas seulement le bien', () => {
  // `provider_property_id` n'a AUCUNE unicite globale : deux hotes d'un meme
  // property manager partagent l'espace de numerotation. Sans le compte, ils
  // melangent leurs lignes dans un meme groupe.
  const autreCompte = JSON.parse(JSON.stringify(PIECES.jumelle))
  autreCompte.user_id = 'u2'
  const { pont, refus } = construirePontDemapped([PIECES.demapped, PIECES.jumelle, autreCompte])
  assert.equal(refus.length, 0, 'aucun refus : ce sont DEUX groupes, pas un de trois')
  assert.equal(pont.size, 1, 'seule la jumelle du MEME compte est appariee')
  assert.ok(pont.has('u1|99af35d0'))
  assert.ok(!pont.has('u2|99af35d0'))
})

test('la ventilation compte les nuits DONT LE PRIX EST CONNU', () => {
  // 79 reservations Beds24 reelles ont `price = 0` : sans ce compteur,
  // `prix ÷ nuits` rend le prix moyen biaise vers le bas que le KB interdit,
  // et l agregat ne donne AUCUN moyen de s en garder.
  const sansPrix = JSON.parse(JSON.stringify(PIECES.beds24Airbnb))
  sansPrix.raw.price = 0
  const v = ventilationMensuelle(eclater(sansPrix))
  assert.equal(v[0].nuits, 2)
  assert.equal(v[0].nuits_avec_prix, 0, 'indiscernable autrement de « 2 nuits vendues 0 € »')
  assert.equal(v[0].prix, 0)

  const avecPrix = ventilationMensuelle(eclater(PIECES.beds24Airbnb))
  assert.equal(avecPrix[0].nuits_avec_prix, 2)
})
