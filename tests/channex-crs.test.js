// tests/channex-crs.test.js
// Lancement : npm test  (node --test, aucune dependance externe)
//
// Primitive d'ecriture CRS (spec-reservation-manuelle.md §3). Les formes de
// payload testees ici sont celles VERIFIEES sur le staging le 6 septembre 2026 :
// chaque assertion correspond a un comportement mesure, pas suppose.

const test = require('node:test')
const assert = require('node:assert')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'https://exemple.invalid/api/v1'
process.env.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY || 'cle-test'
// Backoff a 0 : ce fichier ne doit pas dormir 15 s dans `npm test`.
process.env.CHANNEL_BACKOFF_MS = '0'

const { payloadCRS, OTA_DIRECT, createBooking, updateBooking, cancelBooking, installerCRS } =
  require('../lib/channels/channex')

const PID = 'prop-uuid'
const RESA = {
  roomTypeId: 'rt-uuid',
  ratePlanId: 'rp-uuid',
  arrival: '2026-10-12',
  departure: '2026-10-15',
  days: { '2026-10-12': '100.00', '2026-10-13': '100.00', '2026-10-14': '100.00' },
  amount: '300.00',
  customer: { name: 'Jean', surname: 'Testeur', mail: 'j@example.invalid', phone: '+33600000000' },
  occupancy: { adults: 2, children: 0, infants: 0 },
  meta: { source: 'hotesmart-manual', reference_interne: 'HS-42' },
  otaReservationCode: 'HS-TEST-001',
  currency: 'EUR'
}
const reseau = code => { const e = new Error('fetch failed'); e.cause = { code }; return e }

// Capture les appels sortants sans jamais sortir.
function mockFetch (reponses) {
  const appels = []
  const vrai = global.fetch
  let i = 0
  global.fetch = async (url, opts) => {
    appels.push({ url: String(url), method: opts.method, body: opts.body ? JSON.parse(opts.body) : null })
    const r = reponses[Math.min(i++, reponses.length - 1)]
    if (r instanceof Error) throw r
    return { ok: r.status < 300, status: r.status, headers: { get: () => null }, text: async () => JSON.stringify(r.body) }
  }
  return { appels, restore: () => { global.fetch = vrai } }
}

// ─── Forme du payload ───────────────────────────────────────────────────────

test('CRS : ota_name vaut « Offline », jamais un OTA emprunte', () => {
  assert.strictEqual(OTA_DIRECT, 'Offline')
  assert.strictEqual(payloadCRS(PID, RESA).booking.ota_name, 'Offline')
  // Mesure : Direct/Website/Manual/Channex sont refuses en « unknown provider ».
  // Emprunter BookingCom polluerait les statistiques par canal.
})

test('CRS : le payload porte les days NUIT PAR NUIT, sans la nuit de depart', () => {
  const b = payloadCRS(PID, RESA).booking
  assert.deepStrictEqual(Object.keys(b.rooms[0].days), ['2026-10-12', '2026-10-13', '2026-10-14'])
  assert.ok(!b.rooms[0].days['2026-10-15'], 'la borne de depart reste libre')
  assert.strictEqual(b.departure_date, '2026-10-15')
})

test('CRS : meta present -> transmis ; meta vide -> absent (pas de {})', () => {
  assert.deepStrictEqual(payloadCRS(PID, RESA).booking.meta, RESA.meta)
  assert.ok(!('meta' in payloadCRS(PID, { ...RESA, meta: {} }).booking))
  assert.ok(!('meta' in payloadCRS(PID, { ...RESA, meta: undefined }).booking))
})

test('CRS : l\'ANNULATION porte le payload COMPLET, days inclus', () => {
  // Mesure : un PUT d'annulation aux days partiels est rejete en 422
  // (« departure_date is not equal to maximum date + 1 day in rooms.days »).
  const b = payloadCRS(PID, RESA, 'cancelled').booking
  assert.strictEqual(b.status, 'cancelled')
  assert.strictEqual(Object.keys(b.rooms[0].days).length, 3)
  assert.strictEqual(b.arrival_date, '2026-10-12')
  assert.strictEqual(b.departure_date, '2026-10-15')
  assert.ok(b.customer && b.occupancy && b.amount)
})

test('CRS : sans statut, aucun champ `status` n\'est envoye', () => {
  assert.ok(!('status' in payloadCRS(PID, RESA).booking))
})

test('CRS : occupancy par defaut et montants en chaine', () => {
  const b = payloadCRS(PID, { ...RESA, occupancy: {}, amount: 300 }).booking
  assert.deepStrictEqual(b.occupancy, { adults: 1, children: 0, infants: 0 })
  assert.strictEqual(b.amount, '300.00', 'Channex attend des chaines, a deux decimales')
  assert.strictEqual(b.rooms[0].amount, '300.00')
})

// ─── Verbes et routes ───────────────────────────────────────────────────────

test('CRS : create = POST /bookings, update = PUT, cancel = PUT + status', async () => {
  const m = mockFetch([{ status: 200, body: { data: { id: 'bk-1' } } }])
  try {
    const c = await createBooking(PID, RESA)
    assert.strictEqual(c.ok, true); assert.strictEqual(c.id, 'bk-1')
    assert.strictEqual(m.appels[0].method, 'POST')
    assert.ok(m.appels[0].url.endsWith('/bookings'))

    await updateBooking('bk-1', PID, RESA)
    assert.strictEqual(m.appels[1].method, 'PUT')
    assert.ok(m.appels[1].url.endsWith('/bookings/bk-1'))
    assert.ok(!('status' in m.appels[1].body.booking))

    await cancelBooking('bk-1', PID, RESA)
    assert.strictEqual(m.appels[2].method, 'PUT', 'PAS de DELETE : la route n\'existe pas (404 mesure)')
    assert.strictEqual(m.appels[2].body.booking.status, 'cancelled')
    assert.strictEqual(Object.keys(m.appels[2].body.booking.rooms[0].days).length, 3)
  } finally { m.restore() }
})

test('CRS : installerCRS pose l\'app booking_crs sur le bien', async () => {
  const m = mockFetch([{ status: 200, body: { data: { id: 'inst-1' } } }])
  try {
    await installerCRS(PID)
    assert.ok(m.appels[0].url.endsWith('/applications/install'))
    assert.deepStrictEqual(m.appels[0].body.application_installation,
      { property_id: PID, application_code: 'booking_crs' })
  } finally { m.restore() }
})

// ─── Les erreurs ne sont JAMAIS avalees ─────────────────────────────────────

test('CRS : une erreur 422 est remontee avec son detail, et loggee', async () => {
  const m = mockFetch([{ status: 422, body: { errors: { code: 'validation_error', details: { booking: { ota_name: ['unknown provider'] } } } } }])
  const cris = []
  const vraiErr = console.error
  console.error = (...a) => cris.push(a.join(' '))
  try {
    const r = await createBooking(PID, RESA)
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.status, 422)
    assert.ok(r.erreurs, 'le detail est rendu a l\'appelant')
    assert.strictEqual(r.id, undefined, 'aucun id inventé sur un echec')
    assert.strictEqual(cris.length, 1, 'et l\'echec est dit')
    assert.ok(cris[0].includes('createBooking'))
  } finally { console.error = vraiErr; m.restore() }
})

test('CRS : 403 (app booking_crs absente) remonte tel quel', async () => {
  const m = mockFetch([{ status: 403, body: { errors: { code: 'forbidden' } } }])
  const vraiErr = console.error; console.error = () => {}
  try {
    const r = await createBooking(PID, RESA)
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.status, 403)
  } finally { console.error = vraiErr; m.restore() }
})

// ─── Retries ────────────────────────────────────────────────────────────────

test('CRS : un POST n\'est JAMAIS rejoue — un doublon vaut pire qu\'un echec', async () => {
  // `fetch` rejette aussi APRES traitement serveur : rejouer creerait une seconde
  // reservation sur les memes nuits, et Channex n'oppose aucune defense.
  const m = mockFetch([reseau('ECONNRESET'), { status: 200, body: { data: { id: 'bk-2' } } }])
  const vraiErr = console.error; console.error = () => {}
  try {
    const r = await createBooking(PID, RESA)
    assert.strictEqual(m.appels.length, 1, 'UN seul appel, pas de second POST')
    assert.strictEqual(r.ok, false, 'l\'echec est visible')
    assert.strictEqual(r.erreurs?.code, 'network_error')
  } finally { console.error = vraiErr; m.restore() }
})

test('CRS : un PUT, lui, est rejoue (idempotent)', async () => {
  const m = mockFetch([reseau('EAI_AGAIN'), { status: 200, body: { data: { id: 'bk-2' } } }])
  try {
    const r = await cancelBooking('bk-2', PID, RESA)
    assert.strictEqual(m.appels.length, 2, 'le second essai part')
    assert.strictEqual(r.ok, true)
  } finally { m.restore() }
})

test('CRS : une erreur NON reseau n\'est pas rejouee (env manquante, URL invalide)', async () => {
  // Sinon une variable d'environnement absente devient un timeout de fonction
  // de 15 s, et le log accuse le reseau.
  const m = mockFetch([new TypeError('Failed to parse URL from undefined/bookings')])
  const vraiErr = console.error; console.error = () => {}
  try {
    const r = await cancelBooking('bk-1', PID, RESA)
    assert.strictEqual(m.appels.length, 1, 'aucun rejeu')
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.erreurs?.code, 'call_error', 'pas « network_error » : la faute n\'est pas au reseau')
  } finally { console.error = vraiErr; m.restore() }
})

test('CRS : reseau mort sur un PUT -> ok:false, jamais d\'exception nue', async () => {
  const e = reseau('EAI_AGAIN')
  const m = mockFetch([e, e, e, e, e, e])
  const vraiErr = console.error; console.error = () => {}
  try {
    const r = await updateBooking('bk-1', PID, RESA)
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.status, 0)
    assert.strictEqual(r.erreurs?.code, 'network_error')
  } finally { console.error = vraiErr; m.restore() }
})

// ─── Champs obligatoires refuses localement ─────────────────────────────────

test('CRS : un champ obligatoire manquant est REFUSE ici, pas envoye au CRS', () => {
  // JSON.stringify supprime les cles undefined : un champ oublie disparaissait du
  // payload et revenait en 422 opaque — ou passait.
  for (const champ of ['roomTypeId', 'ratePlanId', 'arrival', 'departure', 'amount', 'currency', 'otaReservationCode']) {
    const incomplet = { ...RESA }; delete incomplet[champ]
    assert.throws(() => payloadCRS(PID, incomplet), new RegExp(champ), `${champ} doit etre exige`)
  }
  assert.throws(() => payloadCRS(PID, { ...RESA, days: {} }), /days/)
  assert.throws(() => payloadCRS(null, RESA), /propertyId/)
})

test('CRS : les montants sont valides et arrondis a deux decimales', () => {
  assert.throws(() => payloadCRS(PID, { ...RESA, amount: undefined }), /amount/)
  assert.throws(() => payloadCRS(PID, { ...RESA, amount: 'abc' }), /amount invalide/)
  assert.throws(() => payloadCRS(PID, { ...RESA, amount: -5 }), /amount invalide/)
  // Un total flottant ne doit pas partir en « 0.30000000000000004 ».
  assert.strictEqual(payloadCRS(PID, { ...RESA, amount: 0.1 + 0.2 }).booking.amount, '0.30')
  assert.strictEqual(payloadCRS(PID, RESA).booking.rooms[0].days['2026-10-12'], '100.00')
})

test('CRS : la devise n\'est jamais devinee', () => {
  // Un bien en GBP dont l'appelant oublie la devise creerait une resa au meme
  // montant numerique en EUR, sans aucun signal.
  assert.throws(() => payloadCRS(PID, { ...RESA, currency: undefined }), /currency/)
  assert.strictEqual(payloadCRS(PID, { ...RESA, currency: 'GBP' }).booking.currency, 'GBP')
})
