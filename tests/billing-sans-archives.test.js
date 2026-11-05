// tests/billing-sans-archives.test.js
//
// Lot « filtre biens vivants », reste 1 : la FACTURATION. Decision de Thierry :
// « la liste exclut les archives ». Un bien archive ne compte plus dans la
// quantite de l'abonnement, meme s'il a ete active un jour (`active_at` garde,
// c'est l'historique de facturation : `lib/logement/archive.js` n'y touche pas).
//
// ⚠ LE DOUBLE DE SUPABASE FILTRE VRAIMENT. Il ne se contente pas d'enregistrer
// les appels : il applique `.eq`, `.not(…, 'is', null)` et `.is(…, null)` a de
// vraies lignes et rend le COMPTE. Un test qui verifierait seulement « `.is` a ete
// appele » passerait aussi pour un filtre pose sur la mauvaise colonne.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_pour_les_tests'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

const COMPTE = 'compte-1'
const AUTRE = 'compte-2'
const ARCHIVE_LE = '2026-11-03T10:00:00Z'

function stub (abs, exports) {
  const m = new Module(abs); m.exports = exports; m.loaded = true
  require.cache[abs] = m
}

function client (tables) {
  const ecritures = []
  return {
    ecritures,
    from (table) {
      const filtres = []
      let maj = null
      const lignes = () => (tables[table] || []).filter(r => filtres.every(f => f(r)))
      const chain = {
        select () { return chain },
        update (v) { maj = v; return chain },
        eq (c, v) { filtres.push(r => r[c] === v); return chain },
        not (c, op, v) {
          if (op !== 'is') throw new Error('double : seul .not(…, "is", …) est simule')
          filtres.push(r => (r[c] ?? null) !== v); return chain
        },
        is (c, v) { filtres.push(r => (r[c] ?? null) === v); return chain },
        async maybeSingle () { return { data: lignes()[0] || null, error: null } },
        then (ok, ko) {
          if (maj) { ecritures.push({ table, maj, lignes: lignes().length }); return Promise.resolve({ error: null }).then(ok, ko) }
          return Promise.resolve({ count: lignes().length, error: null }).then(ok, ko)
        }
      }
      return chain
    }
  }
}

function charger ({ properties, accounts = [], quantiteActuelle = 0 }) {
  const sb = client({ properties, accounts })
  const stripeAppels = []
  class StripeDouble {
    constructor () {
      this.prices = { list: async () => ({ data: [{ id: 'price_1' }] }) }
      this.subscriptions = {
        retrieve: async id => ({ id, items: { data: [{ id: 'si_1', quantity: quantiteActuelle }] } }),
        update: async (id, params) => { stripeAppels.push({ id, params }); return { id } }
      }
    }
  }
  const lib = path.join(__dirname, '..', 'lib')
  stub(require.resolve(path.join(lib, 'cron-shared')), { supabase: sb })
  stub(require.resolve('stripe', { paths: [lib] }), StripeDouble)
  delete require.cache[require.resolve(path.join(lib, 'billing'))]
  return { billing: require(path.join(lib, 'billing')), sb, stripeAppels }
}

const PARC = [
  { id: 'a', user_id: COMPTE, active_at: '2026-06-01T00:00:00Z', archive_le: null },
  { id: 'b', user_id: COMPTE, active_at: '2026-06-01T00:00:00Z', archive_le: ARCHIVE_LE },
  { id: 'c', user_id: COMPTE, active_at: null, archive_le: null },
  { id: 'd', user_id: AUTRE, active_at: '2026-06-01T00:00:00Z', archive_le: null }
]

test('LE TEST QUI COMPTE : un bien ARCHIVE ne compte plus dans les biens facturables', async () => {
  const { billing } = charger({ properties: PARC })
  assert.equal(await billing.countActiveProperties(COMPTE), 1,
    'le bien archive (active un jour) est encore compte : il serait facture apres son archivage')
})

test('un bien jamais active ne compte pas, archive ou non, et le compte voisin non plus', async () => {
  const { billing } = charger({ properties: [
    ...PARC,
    { id: 'e', user_id: COMPTE, active_at: null, archive_le: ARCHIVE_LE }
  ] })
  assert.equal(await billing.countActiveProperties(COMPTE), 1)
  assert.equal(await billing.countActiveProperties(AUTRE), 1)
})

test("LE TEST QUI COMPTE : l'abonnement descend a la quantite des biens VIVANTS, sans remboursement", async () => {
  const { billing, sb, stripeAppels } = charger({
    properties: PARC,
    accounts: [{ user_id: COMPTE, is_beta: false, stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' }],
    quantiteActuelle: 2
  })
  const r = await billing.syncAccountBilling(COMPTE)
  assert.equal(r.error, undefined, 'la synchro a echoue : ' + r.error)
  assert.deepEqual(r, { qty: 1, updated: true, direction: 'down' })
  assert.equal(stripeAppels.length, 1)
  assert.deepEqual(stripeAppels[0].params, {
    items: [{ id: 'si_1', quantity: 1 }], proration_behavior: 'none'
  })
  assert.deepEqual(sb.ecritures, [{ table: 'accounts', maj: { sub_quantity: 1 }, lignes: 1 }])
})

test("le DERNIER bien archive : l'abonnement s'arrete en fin de periode", async () => {
  const { billing, stripeAppels } = charger({
    properties: [{ id: 'b', user_id: COMPTE, active_at: '2026-06-01T00:00:00Z', archive_le: ARCHIVE_LE }],
    accounts: [{ user_id: COMPTE, is_beta: false, stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1' }],
    quantiteActuelle: 1
  })
  const r = await billing.syncAccountBilling(COMPTE)
  assert.deepEqual(r, { qty: 0 })
  assert.deepEqual(stripeAppels, [{ id: 'sub_1', params: { cancel_at_period_end: true } }])
})
