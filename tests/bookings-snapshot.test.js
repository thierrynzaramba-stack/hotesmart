// tests/bookings-snapshot.test.js
// Lancement : npm test  (node --test, aucune dépendance externe)

const test = require('node:test')
const assert = require('node:assert')

const {
  STATUS,
  canonicalStatus,
  readStatus,
  isActiveStatus,
  fromBeds24,
  fromChannex,
  mergeSnapshot,
  saveBookingSnapshot
} = require('../lib/bookings-snapshot')

// ─── Mapping des statuts Beds24 ──────────────────────────────────────────────
test('statuts Beds24 -> canonique', () => {
  const cases = {
    new:       STATUS.CONFIRMED,
    confirmed: STATUS.CONFIRMED,
    request:   STATUS.REQUEST,
    inquiry:   STATUS.REQUEST,
    cancelled: STATUS.CANCELLED,
    black:     STATUS.BLOCKED
  }
  for (const [raw, expected] of Object.entries(cases)) {
    assert.strictEqual(canonicalStatus(raw, 'beds24'), expected, `beds24 "${raw}"`)
  }
})

test('statuts Beds24 : casse et espaces ignorés', () => {
  assert.strictEqual(canonicalStatus('  BLACK ', 'beds24'), STATUS.BLOCKED)
  assert.strictEqual(canonicalStatus('Cancelled', 'beds24'), STATUS.CANCELLED)
})

// ─── Mapping des statuts Channex ─────────────────────────────────────────────
test('statuts Channex -> canonique', () => {
  const cases = {
    new:       STATUS.CONFIRMED,
    modified:  STATUS.CONFIRMED,
    confirmed: STATUS.CONFIRMED,
    cancelled: STATUS.CANCELLED
  }
  for (const [raw, expected] of Object.entries(cases)) {
    assert.strictEqual(canonicalStatus(raw, 'channex'), expected, `channex "${raw}"`)
  }
})

test('"black" n\'existe pas chez Channex : pas de contamination entre providers', () => {
  // Channex ne connaît pas 'black' -> inconnu -> confirmed (avec warn).
  assert.strictEqual(canonicalStatus('black', 'channex'), STATUS.CONFIRMED)
  // Le même mot chez Beds24 est bien un blocage.
  assert.strictEqual(canonicalStatus('black', 'beds24'), STATUS.BLOCKED)
})

// ─── Cas limites ─────────────────────────────────────────────────────────────
test('statut vide ou absent -> confirmed (comportement historique)', () => {
  assert.strictEqual(canonicalStatus('', 'beds24'), STATUS.CONFIRMED)
  assert.strictEqual(canonicalStatus(null, 'channex'), STATUS.CONFIRMED)
  assert.strictEqual(canonicalStatus(undefined, 'beds24'), STATUS.CONFIRMED)
})

test('normalisation idempotente : un statut déjà canonique est inchangé', () => {
  for (const s of Object.values(STATUS)) {
    assert.strictEqual(canonicalStatus(s, 'beds24'), s)
    assert.strictEqual(canonicalStatus(s, 'channex'), s)
  }
})

test('statut inconnu -> confirmed (ne pas régresser le comportement actuel)', () => {
  assert.strictEqual(canonicalStatus('zzz_futur_statut', 'beds24'), STATUS.CONFIRMED)
  assert.strictEqual(canonicalStatus('zzz_futur_statut', 'inconnu'), STATUS.CONFIRMED)
})

// ─── Lecture des lignes écrites AVANT ce module (pas de backfill SQL) ────────
test('readStatus tolère les anciennes lignes au vocabulaire brut', () => {
  assert.strictEqual(readStatus({ status: 'black', provider: 'beds24' }), STATUS.BLOCKED)
  assert.strictEqual(readStatus({ status: 'modified', provider: 'channex' }), STATUS.CONFIRMED)
  // Ancienne ligne sans colonne provider : reste lisible.
  assert.strictEqual(readStatus({ status: 'cancelled' }), STATUS.CANCELLED)
  assert.strictEqual(readStatus({}), STATUS.CONFIRMED)
})

test('isActiveStatus : seul confirmed occupe le logement', () => {
  assert.strictEqual(isActiveStatus({ status: 'new', provider: 'beds24' }), true)
  assert.strictEqual(isActiveStatus({ status: 'black', provider: 'beds24' }), false)
  assert.strictEqual(isActiveStatus({ status: 'inquiry', provider: 'beds24' }), false)
  assert.strictEqual(isActiveStatus({ status: 'cancelled', provider: 'channex' }), false)
  assert.strictEqual(isActiveStatus({ status: 'modified', provider: 'channex' }), true)
})

// ─── Mappers ─────────────────────────────────────────────────────────────────
test('fromBeds24 : schéma complet, provider rempli, champs inconnus non écrasants', () => {
  const snap = fromBeds24({
    id: '123', status: 'black', arrival: '2026-09-01', departure: '2026-09-05',
    firstName: 'Jean', lastName: 'Dupont', numAdult: 2, numChild: 0,
    channel: 'airbnb', apiReference: 'HMSZMHHF2X'
  })
  assert.strictEqual(snap.provider, 'beds24')
  assert.strictEqual(snap.status, STATUS.BLOCKED)
  assert.strictEqual(snap.statusRaw, 'black')
  assert.strictEqual(snap.otaReservationCode, 'HMSZMHHF2X')
  assert.strictEqual(snap.source, 'airbnb')
  assert.strictEqual(snap.numChild, 0)
  // Non fournis par l'API Beds24 -> undefined, pour ne pas écraser en base.
  assert.strictEqual(snap.arrivalHour, undefined)
  assert.strictEqual(snap.amount, undefined)
  assert.strictEqual(snap.currency, undefined)
})

test('fromChannex : réservation et booking_revision donnent le même schéma', () => {
  const payload = {
    status: 'modified', arrival_date: '2026-09-01', departure_date: '2026-09-05',
    arrival_hour: '15:00', customer: { name: 'Marie', surname: 'Martin' },
    occupancy: { adults: 2, children: 1 }, ota_name: 'booking',
    ota_reservation_code: '2328423042', amount: '250.00', currency: 'EUR'
  }
  const snap = fromChannex(payload)
  assert.strictEqual(snap.provider, 'channex')
  assert.strictEqual(snap.status, STATUS.CONFIRMED)
  assert.strictEqual(snap.statusRaw, 'modified')
  assert.strictEqual(snap.firstName, 'Marie')
  assert.strictEqual(snap.otaReservationCode, '2328423042')
  assert.strictEqual(snap.arrivalHour, '15:00')
})

// ─── Merge non destructif (cœur de l'écart E3) ───────────────────────────────
test('mergeSnapshot : un champ non fourni ne remet jamais à null', () => {
  const previous = {
    provider: 'beds24', status: 'confirmed', arrival: '2026-09-01',
    arrivalHour: '16:00', amount: '250.00', currency: 'EUR',
    otaReservationCode: 'HMSZMHHF2X'
  }
  const merged = mergeSnapshot(previous, fromBeds24({
    status: 'confirmed', arrival: '2026-09-01', departure: '2026-09-05',
    apiReference: 'HMSZMHHF2X'
  }))
  assert.strictEqual(merged.arrivalHour, '16:00')
  assert.strictEqual(merged.amount, '250.00')
  assert.strictEqual(merged.currency, 'EUR')
  assert.strictEqual(merged.departure, '2026-09-05')
})

test('mergeSnapshot : un null explicite écrase (le provider sait qu\'il n\'y a rien)', () => {
  const merged = mergeSnapshot({ otaReservationCode: 'ANCIEN' }, { otaReservationCode: null })
  assert.strictEqual(merged.otaReservationCode, null)
})

test('mergeSnapshot : champs hors schéma déjà en base conservés', () => {
  const merged = mergeSnapshot({ champLegacy: 'x' }, { status: 'confirmed' })
  assert.strictEqual(merged.champLegacy, 'x')
  assert.strictEqual(merged.status, 'confirmed')
})

test('mergeSnapshot : previous absent (première écriture)', () => {
  const merged = mergeSnapshot(null, fromChannex({ status: 'new' }))
  assert.strictEqual(merged.provider, 'channex')
  assert.strictEqual(merged.status, STATUS.CONFIRMED)
})

test('le writer pauvre ne dégrade plus le writer riche (régression E3)', () => {
  // Écriture riche (lib/channels/beds24.js), puis passage du writer historiquement
  // pauvre (lib/cron-bookings.js) : les métadonnées OTA doivent survivre.
  const riche = fromBeds24({
    status: 'confirmed', arrival: '2026-09-01', departure: '2026-09-05',
    firstName: 'Jean', lastName: 'Dupont', numAdult: 2, numChild: 0,
    channel: 'airbnb', apiReference: 'HMSZMHHF2X'
  })
  const pauvre = fromBeds24({
    status: 'confirmed', arrival: '2026-09-01', departure: '2026-09-05',
    firstName: 'Jean', lastName: 'Dupont', numAdult: 2, numChild: 0
  })
  const merged = mergeSnapshot(riche, pauvre)
  assert.strictEqual(merged.provider, 'beds24')
  // apiReference absent du second appel -> mappé null (Beds24 dit "pas de code").
  // Le champ reste présent dans le schéma : pas de perte de colonne.
  assert.ok('otaReservationCode' in merged)
  assert.strictEqual(merged.status, STATUS.CONFIRMED)
})

// ─── Écriture (client Supabase simulé) ───────────────────────────────────────
function fakeSupabase({ existing = null, captureRef = {} } = {}) {
  return {
    from() {
      return {
        select() { return this },
        eq() { return this },
        maybeSingle: async () => ({ data: existing ? { snapshot: existing } : null }),
        upsert: async (row) => { captureRef.row = row; return { error: null } }
      }
    }
  }
}

test('saveBookingSnapshot : écrit le schéma unifié avec provider renseigné', async () => {
  const capture = {}
  const sb = fakeSupabase({ captureRef: capture })
  const res = await saveBookingSnapshot(sb, {
    userId: 'u1', bookingId: 77, propertyId: 12345, provider: 'beds24',
    booking: { status: 'new', arrival: '2026-09-01', departure: '2026-09-05' }
  })
  assert.strictEqual(res.ok, true)
  assert.strictEqual(capture.row.booking_id, '77')
  assert.strictEqual(capture.row.property_id, '12345')
  assert.strictEqual(capture.row.snapshot.provider, 'beds24')
  assert.strictEqual(capture.row.snapshot.status, STATUS.CONFIRMED)
})

test('saveBookingSnapshot : relit et merge l\'existant quand rien n\'est fourni', async () => {
  const capture = {}
  const sb = fakeSupabase({ existing: { amount: '250.00', currency: 'EUR' }, captureRef: capture })
  await saveBookingSnapshot(sb, {
    userId: 'u1', bookingId: 77, propertyId: 12345, provider: 'beds24',
    booking: { status: 'confirmed' }
  })
  assert.strictEqual(capture.row.snapshot.amount, '250.00')
  assert.strictEqual(capture.row.snapshot.currency, 'EUR')
})

test('saveBookingSnapshot : clés manquantes -> pas d\'écriture, pas d\'exception', async () => {
  const capture = {}
  const sb = fakeSupabase({ captureRef: capture })
  const res = await saveBookingSnapshot(sb, { userId: 'u1', provider: 'beds24', booking: {} })
  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.reason, 'missing_keys')
  assert.strictEqual(capture.row, undefined)
})

test('saveBookingSnapshot : provider inconnu -> échec propre, jamais de throw', async () => {
  const sb = fakeSupabase()
  const res = await saveBookingSnapshot(sb, {
    userId: 'u1', bookingId: 1, propertyId: 1, provider: 'smoobu', booking: {}
  })
  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.reason, 'exception')
})
