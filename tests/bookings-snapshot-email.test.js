// tests/bookings-snapshot-email.test.js
// Lancement : npm test  (node --test, aucune dependance externe)
//
// Etape 1 du chantier « canal e-mail pour les reservations directes » :
// docs/specs/spec-canal-email-resa-directe.md.
//
// LE COEUR PORTE L'ADRESSE DU VOYAGEUR. Les quatre cas exiges avant de passer
// au routage, tous calques sur des payloads REELS releves en base et chez le
// provider le 16 septembre 2026 :
//
//   1. Offline avec adresse      -> elle entre dans le snapshot
//   2. Offline sans adresse      -> rien n'entre, et rien n'est efface
//   3. Airbnb (`mail: null`)     -> rien n'entre
//   4. Booking.com (alias)       -> l'adresse entre, mais NE DECIDE RIEN
//
// ⚠ DATES RELATIVES, jamais figees : ces tests traversent `detectChange`, qui
// lit l'horloge par `sejourTermine`. Regle du depot — dates figees uniquement
// quand le test injecte le temps.

const test = require('node:test')
const assert = require('node:assert')

const {
  fromChannex,
  fromBeds24,
  emailOuRien,
  mergeSnapshot,
  empreinte,
  saveBookingSnapshot
} = require('../lib/bookings-snapshot')

// ─── Dates relatives ─────────────────────────────────────────────────────────
const jour = n => {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().split('T')[0]
}
const ARRIVEE = jour(20)
const DEPART  = jour(23)

// ─── Payloads reels (adresses remplacees, formes conservees) ─────────────────
// Releve : GET /bookings/c87f24ce… — `customer.mail` renseigne, `channel_id` nul.
const OFFLINE_AVEC_MAIL = {
  id: 'c87f24ce', status: 'new', ota_name: 'Offline', channel_id: null,
  arrival_date: ARRIVEE, departure_date: DEPART, currency: 'EUR', amount: '450.00',
  ota_reservation_code: 'HS-1789208565244-98XW6',
  occupancy: { adults: 2, children: 0 },
  customer: { name: 'Thierry', surname: 'Nzaramba', language: 'fr', phone: '+33600000000',
              mail: 'voyageur@exemple.test' }
}

// Releve : la reservation saisie a la main dans le calendrier. Le formulaire ne
// collecte pas l'adresse — Channex sert donc `mail: null`, explicitement.
const OFFLINE_SANS_MAIL = {
  id: '61415d10', status: 'new', ota_name: 'Offline', channel_id: null,
  arrival_date: ARRIVEE, departure_date: DEPART, currency: 'EUR', amount: '120.00',
  ota_reservation_code: 'HS-1789371872885-6Z673',
  occupancy: { adults: 1, children: 0 },
  customer: { name: 'thierry', surname: 'nzaramba', language: 'fr', phone: null, mail: null }
}

// Releve : Airbnb ne communique JAMAIS l'adresse reelle du voyageur.
const AIRBNB = {
  id: '512013a3', status: 'new', ota_name: 'AirBNB', channel_id: 'ch-airbnb',
  arrival_date: ARRIVEE, departure_date: DEPART, currency: 'EUR', amount: '380.00',
  ota_reservation_code: 'HMWHPETTJP',
  occupancy: { adults: 2, children: 0 },
  customer: { name: 'Christopher', surname: 'De Silva', language: 'en', mail: null }
}

// Releve : Booking.com sert un ALIAS de relais. C'est une adresse valide, qui
// delivre — et c'est exactement ce qui rend ce cas dangereux.
const BOOKING = {
  id: 'a2a77727', status: 'new', ota_name: 'BookingCom', channel_id: 'ch-booking',
  arrival_date: ARRIVEE, departure_date: DEPART, currency: 'EUR', amount: '210.00',
  ota_reservation_code: '5261285458',
  occupancy: { adults: 2, children: 0 },
  customer: { name: 'Avelina', surname: 'M', language: 'fr',
              mail: 'avelina.m5261285458@guest.booking.com' }
}

// ─── Cas 1 : Offline avec adresse ────────────────────────────────────────────
test('cas 1 — Offline avec adresse : elle entre dans le snapshot', () => {
  const s = fromChannex(OFFLINE_AVEC_MAIL)
  assert.strictEqual(s.guestEmail, 'voyageur@exemple.test')
  assert.strictEqual(s.source, 'Offline', 'la source reste le discriminant du routage')
})

// ─── Cas 2 : Offline sans adresse ────────────────────────────────────────────
test('cas 2 — Offline sans adresse : le champ reste absent, jamais null', () => {
  const s = fromChannex(OFFLINE_SANS_MAIL)
  assert.strictEqual(s.guestEmail, undefined,
    'null ecraserait une adresse connue au passage d\'une revision amputee')
  assert.strictEqual(s.source, 'Offline')
})

test('cas 2 bis — une revision sans adresse n\'efface pas celle deja connue', () => {
  const connu = fromChannex(OFFLINE_AVEC_MAIL)
  // Le feed Channex sert des revisions amputees : l'annulation a `rooms: []` et
  // dates nulles en est la preuve deja payee (lib/booking-changes.js).
  const ampute = fromChannex({ ...OFFLINE_SANS_MAIL, id: 'c87f24ce' })
  const fusion = mergeSnapshot(connu, ampute)
  assert.strictEqual(fusion.guestEmail, 'voyageur@exemple.test',
    'l\'adresse a laquelle on doit ecrire ne se perd pas sur une revision pauvre')
})

// ─── Cas 3 : Airbnb ──────────────────────────────────────────────────────────
test('cas 3 — Airbnb : aucune adresse, et le champ reste absent', () => {
  const s = fromChannex(AIRBNB)
  assert.strictEqual(s.guestEmail, undefined)
  assert.strictEqual(s.source, 'AirBNB')
})

// ─── Cas 4 : Booking.com, l'alias qui ne doit rien decider ───────────────────
test('cas 4 — Booking.com : l\'alias entre dans le coeur', () => {
  const s = fromChannex(BOOKING)
  assert.strictEqual(s.guestEmail, 'avelina.m5261285458@guest.booking.com')
})

test('cas 4 bis — INVARIANT : une adresse presente ne suffit jamais a choisir l\'e-mail', () => {
  // Le piege que ce test existe pour fermer : « guestEmail est renseigne, donc
  // on envoie un e-mail » detournerait les reservations Booking.com hors de leur
  // messagerie OTA. Le snapshot ne porte AUCUN champ de decision de canal — seule
  // `source` distingue, et elle distingue bien.
  const offline = fromChannex(OFFLINE_AVEC_MAIL)
  const booking = fromChannex(BOOKING)

  assert.ok(offline.guestEmail && booking.guestEmail,
    'les deux portent une adresse : c\'est le point du test')
  assert.notStrictEqual(offline.source, booking.source,
    'seule la source les separe')
  assert.strictEqual(Object.keys(offline).some(k => /canal|channel|sendBy|via/i.test(k)), false,
    'aucun champ de canal dans le snapshot : la decision appartient a la couche d\'envoi')
})

// ─── Le pendant Beds24 ───────────────────────────────────────────────────────
test('Beds24 : l\'adresse se lit dans `email`, au premier niveau', () => {
  const s = fromBeds24({ id: 84489862, status: 'new', channel: 'direct',
    arrival: ARRIVEE, departure: DEPART, email: 'direct@exemple.test',
    firstName: 'Jean', lastName: 'Durand', price: 160 })
  assert.strictEqual(s.guestEmail, 'direct@exemple.test')
  assert.strictEqual(s.source, 'direct')
})

test('Beds24 : pas d\'adresse -> champ absent', () => {
  const s = fromBeds24({ id: 1, status: 'new', arrival: ARRIVEE, departure: DEPART })
  assert.strictEqual(s.guestEmail, undefined)
})

// ─── Le helper ───────────────────────────────────────────────────────────────
test('emailOuRien : trime, et ne rend jamais null', () => {
  assert.strictEqual(emailOuRien('  a@b.fr  '), 'a@b.fr')
  assert.strictEqual(emailOuRien(''), undefined)
  assert.strictEqual(emailOuRien('   '), undefined)
  assert.strictEqual(emailOuRien(null), undefined)
  assert.strictEqual(emailOuRien(undefined), undefined)
  assert.strictEqual(emailOuRien(42), undefined)
})

test('emailOuRien : une adresse mal formee PASSE — le coeur n\'est pas un validateur', () => {
  // Filtrer ici rendrait « pas d'adresse » et « adresse invalide » indistinguables
  // pour l'hote. C'est la couche d'envoi qui refuse, et qui le dit.
  assert.strictEqual(emailOuRien('pas-une-adresse'), 'pas-une-adresse')
})

// ─── L'adresse n'est PAS un declencheur d'evenement ──────────────────────────
// Elle n'est dans aucun des quatre champs de `DIFF_FIELDS`. Une adresse qui
// apparait ou qui change ne doit reveiller ni menage, ni code d'acces, ni
// message de bienvenue.
function fakeSupabase ({ existing, capture }) {
  capture.upserts = []
  capture.events  = []
  return {
    from () {
      const b = {
        select: () => b, eq: () => b, in: () => b, neq: () => b, limit: async () => ({ data: [], error: null }),
        maybeSingle: async () => ({ data: existing ? { snapshot: existing, property_id: 'PROP', raw_hash: null } : null }),
        upsert: async row => { capture.upserts.push(row); return { error: null } },
        insert: async row => { capture.events.push(row); return { error: null } }
      }
      return b
    }
  }
}

test('une adresse qui apparait n\'engendre AUCUN evenement', async () => {
  const existing = fromChannex({ ...OFFLINE_AVEC_MAIL, customer: { ...OFFLINE_AVEC_MAIL.customer, mail: null } })
  const capture = {}
  const r = await saveBookingSnapshot(fakeSupabase({ existing, capture }), {
    userId: 'U', bookingId: 'c87f24ce', propertyId: 'PROP', provider: 'channex',
    booking: OFFLINE_AVEC_MAIL
  })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.change, null, 'guestEmail n\'est pas un champ de DIFF_FIELDS')
  assert.strictEqual(capture.events.length, 0, 'aucun booking_change_event')
  assert.strictEqual(capture.upserts.length, 1, 'la ligne est bien avancee')
  assert.strictEqual(capture.upserts[0].snapshot.guestEmail, 'voyageur@exemple.test')
})

test('rejouer le meme payload ne reecrit rien (idempotence)', async () => {
  const existing = fromChannex(OFFLINE_AVEC_MAIL)
  const capture = {}
  const r = await saveBookingSnapshot(fakeSupabase({ existing, capture }), {
    userId: 'U', bookingId: 'c87f24ce', propertyId: 'PROP', provider: 'channex',
    booking: OFFLINE_AVEC_MAIL,
    existing, existingPropertyId: 'PROP', existingRawHash: empreinte(OFFLINE_AVEC_MAIL)
  })
  assert.strictEqual(r.inchange, true)
  assert.strictEqual(capture.upserts.length, 0)
  assert.strictEqual(capture.events.length, 0)
})
