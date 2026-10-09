// tests/taxe-sejour-writer.test.js — le writer unique de `taxes_sejour` et son
// branchement dans la couche sync (lib/bookings-snapshot.js) : la ligne suit la
// reservation, et son echec ne casse JAMAIS la synchro.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert/strict')
const { ecrireTaxeSejour, ecrireLot, _viderCache } = require('../lib/taxe-sejour/writer')
const { saveBookingSnapshot } = require('../lib/bookings-snapshot')
const PIECES = require('./fixtures/taxe-sejour/pieces-2026-10-09.json')

const BIEN = { id: '091d9abf-ff86-45ce-8123-3425e6f3900f' }
function base ({ upsertTaxe = async () => ({ error: null }), biens = [BIEN] } = {}) {
  const ecrit = { taxes: [], snapshots: [] }
  const sb = {
    from (table) {
      const b = {
        select: () => b, eq: () => b, neq: () => b, in: () => b,
        limit: async () => (table === 'properties' ? { data: biens, error: null } : { data: [], error: null }),
        maybeSingle: async () => ({ data: null }),
        insert: async () => ({ error: null }),
        upsert: async (row) => {
          if (table === 'taxes_sejour') { ecrit.taxes.push(row); return upsertTaxe(row) }
          ecrit.snapshots.push(row); return { error: null }
        },
      }
      return b
    },
  }
  return { sb, ecrit }
}
const P = PIECES.HMN4XPP3PH

test('LE TEST QUI COMPTE : une reservation ecrite par la couche sync ecrit sa ligne de taxe, avec l identite du bien', async () => {
  _viderCache()
  const { sb, ecrit } = base()
  const r = await saveBookingSnapshot(sb, { userId: 'U', bookingId: 'b1', propertyId: '0db6b39b', provider: 'channex', snapshot: P.snapshot, booking: P.raw })
  assert.equal(r.ok, true)
  assert.equal(ecrit.snapshots.length, 1)
  assert.equal(ecrit.taxes.length, 1)
  assert.deepEqual([ecrit.taxes[0].booking_id, ecrit.taxes[0].property_id, ecrit.taxes[0].property_uuid, ecrit.taxes[0].montant_cents],
    ['b1', '0db6b39b', BIEN.id, 259])
})

test('LE TEST QUI COMPTE : une taxe en echec ne casse pas la synchro (table absente, erreur, exception)', async () => {
  for (const upsertTaxe of [
    async () => ({ error: { message: 'relation "taxes_sejour" does not exist' } }),
    async () => ({ error: { message: 'connexion perdue' } }),
    async () => { throw new Error('reseau') },
  ]) {
    _viderCache()
    const { sb, ecrit } = base({ upsertTaxe })
    const r = await saveBookingSnapshot(sb, { userId: 'U', bookingId: 'b1', propertyId: 'p', provider: 'channex', snapshot: P.snapshot, booking: P.raw })
    assert.equal(r.ok, true, 'la reservation est ecrite')
    assert.equal(ecrit.snapshots.length, 1)
  }
})

test('sans payload brut, aucune ligne : on n ecrase pas une taxe connue par du vide', async () => {
  _viderCache()
  const { sb, ecrit } = base()
  const r = await saveBookingSnapshot(sb, { userId: 'U', bookingId: 'b1', propertyId: 'p', provider: 'channex', snapshot: P.snapshot })
  assert.equal(r.ok, true)
  assert.equal(ecrit.taxes.length, 0)
  assert.deepEqual(await ecrireTaxeSejour(sb, { userId: 'U', bookingId: 'b1', propertyId: 'p', snapshot: P.snapshot, raw: null }), { ok: false, raison: 'sans_raw' })
})

test('deux biens pour la meme cle (ou aucun) : l identite reste vide, on ne devine pas', async () => {
  _viderCache()
  const { sb, ecrit } = base({ biens: [BIEN, { id: 'autre' }] })
  await ecrireTaxeSejour(sb, { userId: 'U', bookingId: 'b1', propertyId: 'p', provider: 'channex', snapshot: P.snapshot, raw: P.raw })
  assert.equal(ecrit.taxes[0].property_uuid, null)
})

test('ecrireLot (rattrapage) s arrete a la premiere erreur et le dit', async () => {
  let n = 0
  const { sb } = base({ upsertTaxe: async () => (++n === 2 ? { error: { message: 'boom' } } : { error: null }) })
  const r = await ecrireLot(sb, Array.from({ length: 5 }, (_, i) => ({ booking_id: String(i) })), { paquet: 2 })
  assert.deepEqual(r, { ecrites: 2, erreur: 'boom' })
})

// ─── Revue de 049d3ed ───────────────────────────────────────────────────────
const { saveBookingSnapshots } = require('../lib/bookings-snapshot')

test('revue de 049d3ed (M4) : le chemin « raw seul rafraichi » ecrit aussi la taxe ; budget epuise : ni raw ni taxe', async () => {
  _viderCache()
  const existant = { ...P.snapshot }
  for (const [budget, attendu] of [[{ restant: 5 }, 1], [{ restant: 0 }, 0]]) {
    const { sb, ecrit } = base()
    sb.from = ((origine) => (table) => {
      const b = origine(table)
      b.update = () => ({ eq: () => ({ eq: async () => ({ error: null }) }) })
      return b
    })(sb.from.bind(sb))
    const r = await saveBookingSnapshot(sb, { userId: 'U', bookingId: 'b1', propertyId: 'p', provider: 'channex',
      snapshot: P.snapshot, booking: P.raw, existing: existant, existingPropertyId: 'p', existingRawHash: 'ancienne', budgetRaw: budget })
    assert.equal(r.inchange, true)
    assert.equal(ecrit.taxes.length, attendu, `budget ${budget.restant}`)
    if (attendu) assert.ok(ecrit.taxes[0].raw_hash && ecrit.taxes[0].raw_hash !== 'ancienne', 'l empreinte du payload lu')
  }
})

test('revue de 049d3ed (M1) : un LOT de reservations ecrit ses taxes en UN upsert, a la fin', async () => {
  _viderCache()
  const { sb, ecrit } = base()
  const appels = []
  const origine = sb.from.bind(sb)
  sb.from = (table) => {
    const b = origine(table)
    const up = b.upsert
    b.upsert = async (row) => { appels.push([table, Array.isArray(row) ? row.length : 1]); return up(row) }
    b.in = () => ({ then: (ok) => ok({ data: [], error: null }) })
    return b
  }
  const lot = ['b1', 'b2', 'b3'].map(id => ({ ...P.raw, id }))
  const out = await saveBookingSnapshots(sb, { userId: 'U', propertyId: 'p', provider: 'channex', bookings: lot, budgetRaw: { restant: 60 } })
  assert.equal(out.saved, 3)
  assert.deepEqual(appels.filter(([t]) => t === 'taxes_sejour'), [['taxes_sejour', 3]])
  assert.deepEqual(ecrit.taxes[0].map(l => l.booking_id), ['b1', 'b2', 'b3'])
})
