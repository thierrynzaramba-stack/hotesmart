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
  saveBookingSnapshot,
  saveBookingSnapshots
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

// ─── Aucun statut REEL ne doit passer par le fallback "inconnu" ──────────────
// Le fallback logge un warn : si 'new' y tombait, chaque nouvelle reservation
// polluerait les logs Vercel a chaque cycle cron.
// Listes officielles :
//   Beds24 v2  : new | confirmed | request | cancelled | black
//                (wiki.beds24.com, Category:Bookings)
//   Channex v1 : new | modified | cancelled
//                (docs.channex.io, Bookings Collection : "can be one of three values")
const BEDS24_REAL  = ['new', 'confirmed', 'request', 'cancelled', 'black']
const CHANNEX_REAL = ['new', 'modified', 'cancelled']

function captureWarns(fn) {
  const warns = []
  const original = console.warn
  console.warn = (...args) => warns.push(args.join(' '))
  try { fn() } finally { console.warn = original }
  return warns
}

test('Beds24 : aucun statut documente ne declenche le fallback (zero warn)', () => {
  const warns = captureWarns(() => {
    for (const raw of BEDS24_REAL) canonicalStatus(raw, 'beds24')
  })
  assert.deepStrictEqual(warns, [], `warns inattendus : ${warns.join(' | ')}`)
})

test('Channex : aucun statut documente ne declenche le fallback (zero warn)', () => {
  const warns = captureWarns(() => {
    for (const raw of CHANNEX_REAL) canonicalStatus(raw, 'channex')
  })
  assert.deepStrictEqual(warns, [], `warns inattendus : ${warns.join(' | ')}`)
})

test('le fallback logge bien un warn quand il sert vraiment', () => {
  const warns = captureWarns(() => canonicalStatus('statut_jamais_vu', 'beds24'))
  assert.strictEqual(warns.length, 1)
  assert.ok(warns[0].includes('statut_jamais_vu'))
})

test('mapping Beds24 complet et explicite (table de reference)', () => {
  assert.deepStrictEqual(
    BEDS24_REAL.map(s => [s, canonicalStatus(s, 'beds24')]),
    [
      ['new',       STATUS.CONFIRMED],
      ['confirmed', STATUS.CONFIRMED],
      ['request',   STATUS.REQUEST],
      ['cancelled', STATUS.CANCELLED],
      ['black',     STATUS.BLOCKED]
    ]
  )
})

test('mapping Channex complet et explicite (table de reference)', () => {
  assert.deepStrictEqual(
    CHANNEX_REAL.map(s => [s, canonicalStatus(s, 'channex')]),
    [
      ['new',       STATUS.CONFIRMED],
      ['modified',  STATUS.CONFIRMED],
      ['cancelled', STATUS.CANCELLED]
    ]
  )
})

test("'inquiry' : mapping defensif, non documente par Beds24", () => {
  // Absent de la doc Beds24 (qui utilise 'request'). Garde en filet : si l'API
  // en emettait un jour, il ne serait pas traite comme une reservation active.
  const warns = captureWarns(() => {
    assert.strictEqual(canonicalStatus('inquiry', 'beds24'), STATUS.REQUEST)
  })
  assert.deepStrictEqual(warns, [])
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

// ─── Provider par defaut : consommateurs de bookings BRUTS ───────────────────
// lib/cron-property-status.js (bookings Beds24 bruts) et lib/cron-arrival-code.js
// (source MIXTE : bruts Beds24 + snapshots channel) testaient en dur
// `status !== 'cancelled' && status !== 'black'`, ce qui laissait passer 'request'.

test('booking Beds24 brut (sans champ provider) : black et request non actifs', () => {
  // Un booking brut de l'API v2 n'a pas de champ `provider` : sans defaut, 'black'
  // serait inconnu et retomberait sur confirmed.
  assert.strictEqual(isActiveStatus({ status: 'black' }, 'beds24'), false)
  assert.strictEqual(isActiveStatus({ status: 'request' }, 'beds24'), false)
  assert.strictEqual(isActiveStatus({ status: 'cancelled' }, 'beds24'), false)
  assert.strictEqual(isActiveStatus({ status: 'new' }, 'beds24'), true)
  assert.strictEqual(isActiveStatus({ status: 'confirmed' }, 'beds24'), true)
})

test("regression : 'request' etait traite comme actif par l'ancien filtre en dur", () => {
  const ancienFiltre = b => b.status !== 'cancelled' && b.status !== 'black'
  const booking = { status: 'request' }
  assert.strictEqual(ancienFiltre(booking), true)              // ancien comportement
  assert.strictEqual(isActiveStatus(booking, 'beds24'), false) // corrige
})

test('source mixte : le provider du snapshot prime sur le defaut', () => {
  // Snapshot Channex traverse un consommateur dont la source brute est Beds24.
  const snapChannex = { status: 'modified', provider: 'channex' }
  const warns = []
  const original = console.warn
  console.warn = (...a) => warns.push(a.join(' '))
  try {
    assert.strictEqual(isActiveStatus(snapChannex, 'beds24'), true)
  } finally { console.warn = original }
  assert.deepStrictEqual(warns, [], 'aucun warn : le provider du snapshot est utilise')

  // Et un 'black' Beds24 reste un blocage meme si le defaut dit autre chose.
  assert.strictEqual(isActiveStatus({ status: 'black', provider: 'beds24' }, 'channex'), false)
})

test('sans defaut, le comportement precedent est inchange (retrocompat)', () => {
  assert.strictEqual(readStatus({ status: 'cancelled' }), STATUS.CANCELLED)
  assert.strictEqual(readStatus({ status: 'black', provider: 'beds24' }), STATUS.BLOCKED)
})

// ─── Lignes ANTERIEURES a l'unification (statut brut, sans champ provider) ───
// Cas signale par la revue : les 5 writers pre-unification n'ecrivaient pas de
// champ `provider`. Sans defaut fourni par l'appelant, canonicalStatus ne peut pas
// choisir la table de correspondance et retombe sur confirmed -> menage fantome.

test('ligne legacy Beds24 sans provider : le defaut est INDISPENSABLE', () => {
  const legacy = { status: 'black', arrival: '2026-09-01', departure: '2026-09-05' }

  // Sans defaut : le fallback la rend active (c'est le piege).
  assert.strictEqual(isActiveStatus(legacy), true)

  // Avec le provider du bien : blocage correctement reconnu.
  assert.strictEqual(readStatus(legacy, 'beds24'), STATUS.BLOCKED)
  assert.strictEqual(isActiveStatus(legacy, 'beds24'), false)
})

test('ligne legacy Beds24 : request et inquiry aussi ecartes avec le defaut', () => {
  assert.strictEqual(isActiveStatus({ status: 'request' }, 'beds24'), false)
  assert.strictEqual(isActiveStatus({ status: 'inquiry' }, 'beds24'), false)
})

test('ligne legacy Channex sans provider : statut brut lu correctement', () => {
  assert.strictEqual(readStatus({ status: 'modified' }, 'channex'), STATUS.CONFIRMED)
  assert.strictEqual(readStatus({ status: 'cancelled' }, 'channex'), STATUS.CANCELLED)
})

test('une ligne legacy reecrite par le writer devient auto-portante', () => {
  // Apres passage du cron, le snapshot porte provider + statut canonique : le
  // defaut n'est plus necessaire pour la lire correctement.
  const reecrite = fromBeds24({ status: 'black', arrival: '2026-09-01' })
  assert.strictEqual(reecrite.provider, 'beds24')
  assert.strictEqual(isActiveStatus(reecrite), false)
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

// ─── Ecriture par lot : une seule relecture, merge conserve ──────────────────
// Les boucles d'import (cron Beds24, activation d'un canal) relisaient la ligne
// booking par booking : 2N allers-retours Supabase par cycle.

function fakeBatchSupabase({ rows = [], failSelect = false } = {}) {
  const stats = { selects: 0, upserts: 0, upsertedRows: [] }
  const client = {
    from() {
      const q = {
        _op: null,
        select() { this._op = 'select'; return this },
        eq() { return this },
        in() { return this },
        maybeSingle: async () => { stats.selects++; return { data: null } },
        then: undefined,
        upsert: async (row) => { stats.upserts++; stats.upsertedRows.push(row); return { error: null } }
      }
      // `.select().eq().in()` est attendu (awaited) directement par le lot.
      q.then = (resolve, reject) => {
        stats.selects++
        const result = failSelect
          ? { data: null, error: { message: 'boom' } }
          : { data: rows, error: null }
        return Promise.resolve(result).then(resolve, reject)
      }
      return q
    }
  }
  return { client, stats }
}

test('saveBookingSnapshots : UNE relecture pour N bookings', async () => {
  const { client, stats } = fakeBatchSupabase({ rows: [] })
  const res = await saveBookingSnapshots(client, {
    userId: 'u1', propertyId: '12345', provider: 'beds24',
    bookings: [
      { id: 1, status: 'new' },
      { id: 2, status: 'confirmed' },
      { id: 3, status: 'black' }
    ]
  })
  assert.strictEqual(res.saved, 3)
  assert.strictEqual(stats.upserts, 3)
  assert.strictEqual(stats.selects, 1, `attendu 1 select, obtenu ${stats.selects}`)
})

test('saveBookingSnapshots : le merge non destructif est conserve', async () => {
  const { client, stats } = fakeBatchSupabase({
    rows: [{ booking_id: '1', snapshot: { amount: '250.00', currency: 'EUR' } }]
  })
  await saveBookingSnapshots(client, {
    userId: 'u1', propertyId: '12345', provider: 'beds24',
    bookings: [{ id: 1, status: 'confirmed', arrival: '2026-09-01' }]
  })
  const written = stats.upsertedRows[0].snapshot
  assert.strictEqual(written.amount, '250.00')   // non fourni par Beds24 -> preserve
  assert.strictEqual(written.currency, 'EUR')
  assert.strictEqual(written.status, STATUS.CONFIRMED)
})

test('saveBookingSnapshots : statuts canoniques appliques a tout le lot', async () => {
  const { client, stats } = fakeBatchSupabase({ rows: [] })
  await saveBookingSnapshots(client, {
    userId: 'u1', propertyId: '12345', provider: 'beds24',
    bookings: [{ id: 1, status: 'black' }, { id: 2, status: 'request' }]
  })
  const statuts = stats.upsertedRows.map(r => r.snapshot.status)
  assert.deepStrictEqual(statuts, [STATUS.BLOCKED, STATUS.REQUEST])
})

test('saveBookingSnapshots : relecture groupee en echec -> repli unitaire, pas d\'ecrasement', async () => {
  const { client, stats } = fakeBatchSupabase({ failSelect: true })
  const res = await saveBookingSnapshots(client, {
    userId: 'u1', propertyId: '12345', provider: 'beds24',
    bookings: [{ id: 1, status: 'new' }, { id: 2, status: 'new' }]
  })
  assert.strictEqual(res.saved, 2)
  // 1 select groupe en echec + 1 relecture unitaire par booking
  assert.strictEqual(stats.selects, 3)
})

test('saveBookingSnapshots : lot vide ou cles manquantes -> aucune ecriture', async () => {
  const { client, stats } = fakeBatchSupabase({ rows: [] })
  assert.strictEqual((await saveBookingSnapshots(client, { userId: 'u1', propertyId: 'p', bookings: [] })).saved, 0)
  assert.strictEqual((await saveBookingSnapshots(client, { bookings: [{ id: 1 }] })).saved, 0)
  assert.strictEqual((await saveBookingSnapshots(client, {})).saved, 0)
  assert.strictEqual(stats.upserts, 0)
})

test('saveBookingSnapshots : bookings sans id ignores', async () => {
  const { client, stats } = fakeBatchSupabase({ rows: [] })
  const res = await saveBookingSnapshots(client, {
    userId: 'u1', propertyId: '12345', provider: 'beds24',
    bookings: [{ id: 1, status: 'new' }, { status: 'new' }, null]
  })
  assert.strictEqual(res.saved, 1)
  assert.strictEqual(stats.upserts, 1)
})
