// tests/messages-sans-biens-archives.test.js
//
// Lot « filtre biens vivants », etape 4.3. Decision de Thierry du 6 novembre
// 2026 : « les biens archives ne doivent pas apparaitre sur les pages Bonjour,
// Calendrier et Messages car ils ne sont pas actifs ». Les conversations d'un
// bien archive ne sortent plus de `/api/messages` ; les messages restent en base.
//
// ⚠ LE DOUBLE DE `properties` APPLIQUE VRAIMENT `.in`, `.eq` et `.not(…, 'is',
// null)` : un filtre pose sur la mauvaise colonne, ou sans le compte, rendrait
// un autre ensemble de biens, et le test le verrait.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

const PROD = '11111111-1111-4111-8111-111111111111'
const AUTRE = '33333333-3333-4333-8333-333333333333'
const JOUR = 86400000
const RECENT = new Date(Date.now() - JOUR).toISOString()
const aujourdHuiParis = () => new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' }).format(new Date())
const MODULES = ['../api/messages', '../lib/require-permission', '../lib/permissions', '../lib/cron-shared', '../lib/cron-arrival-code', '../lib/biens-vivants']

const VIVANT = { user_id: PROD, provider_property_id: 'ref-a', archive_le: null }
const RANGE = { user_id: PROD, provider_property_id: 'ref-r', archive_le: '2026-11-03T10:00:00Z' }
const MSG = (booking_id, property_id) => ({ booking_id, property_id, provider: 'channex', sender: 'guest', direction: 'inbound', body: 'Bonjour', sent_at: RECENT, kind: 'message' })

function preparer ({ messages = [], snaps = [], properties = [], panneProperties = false } = {}) {
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: PROD } }, error: null }) },
    from (nom) {
      const q = { eq: {}, in: {}, not: [] }
      const executer = () => {
        if (nom === 'properties') {
          if (panneProperties) return { data: null, error: { message: 'panne reseau' } }
          const lignes = properties.filter(p =>
            Object.entries(q.eq).every(([k, v]) => p[k] === v) &&
            Object.entries(q.in).every(([k, v]) => v.includes(p[k])) &&
            q.not.every(k => (p[k] ?? null) !== null))
          return { data: lignes, error: null }
        }
        if (nom === 'messages') return { data: messages, error: null }
        if (nom === 'bookings_snapshot') return { data: snaps, error: null }
        return { data: [], error: null }
      }
      const c = {
        select () { return c },
        eq (k, v) { q.eq[k] = v; return c },
        in (k, v) { q.in[k] = v; return c },
        not (k, op, v) {
          if (op !== 'is' || v !== null) throw new Error('double : seul .not(…, "is", null) est simule')
          q.not.push(k); return c
        },
        gte () { return c }, neq () { return c }, or () { return c }, order () { return c }, limit () { return c },
        maybeSingle: async () => { const r = executer(); return { data: (r.data || [])[0] || null, error: r.error } },
        single: async () => { const r = executer(); return { data: (r.data || [])[0] || null, error: r.error } },
        then (ok, ko) { return Promise.resolve(executer()).then(ok, ko) }
      }
      return c
    }
  }
  const absShared = require.resolve(path.join(__dirname, '..', 'lib/cron-shared'))
  const mShared = new Module(absShared); mShared.exports = { supabase: client, anthropic: null }; mShared.loaded = true
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
  require.cache[absShared] = mShared
}

function reponse () { const r = { code: null, body: null }; r.status = c => { r.code = c; return r }; r.json = b => { r.body = b; return r }; r.setHeader = () => {}; return r }
const lire = (query = {}) => ({ method: 'GET', query, body: null, headers: { authorization: 'Bearer j' } })
async function appeler (r) { const res = reponse(); await require('../api/messages')(r, res); return res }
const ids = (res) => (res.body.conversations || []).map(c => c.bookId).sort()

test('LE TEST QUI COMPTE : les conversations d un bien ARCHIVE ne sortent plus de /api/messages', async () => {
  preparer({ messages: [MSG('BK-1', 'ref-a'), MSG('BK-2', 'ref-r')], properties: [VIVANT, RANGE] })
  const res = await appeler(lire())
  assert.equal(res.code, 200)
  assert.deepEqual(ids(res), ['BK-1'], 'la conversation du bien archive est encore rendue')
})

test('LE TEST QUI COMPTE : en pagination, une ARRIVEE du jour sur un bien archive n est pas rajoutee en tete', async () => {
  // La premiere page rajoute toujours les arrivees du jour et du lendemain :
  // c'est exactement le chemin par lequel un fil ecarte pourrait revenir.
  const auj = aujourdHuiParis()
  preparer({
    messages: [MSG('BK-1', 'ref-a'), MSG('BK-2', 'ref-r')],
    snaps: [{ booking_id: 'BK-2', snapshot: { arrival: auj, departure: auj, status: 'confirmed' } }],
    properties: [VIVANT, RANGE]
  })
  const res = await appeler(lire({ limit: '10' }))
  assert.equal(res.code, 200)
  assert.deepEqual(ids(res), ['BK-1'])
})

test('un bien archive chez un AUTRE compte, avec la meme cle provider, ne retire rien ici', async () => {
  // `provider_property_id` n'a aucune unicite globale : la cle est composite.
  preparer({
    messages: [MSG('BK-1', 'ref-a')],
    properties: [VIVANT, { user_id: AUTRE, provider_property_id: 'ref-a', archive_le: '2026-11-01T00:00:00Z' }]
  })
  const res = await appeler(lire())
  assert.deepEqual(ids(res), ['BK-1'])
})

test('lecture des biens en PANNE : rien n est retire, la messagerie reste servie', async () => {
  preparer({ messages: [MSG('BK-1', 'ref-a'), MSG('BK-2', 'ref-r')], properties: [VIVANT, RANGE], panneProperties: true })
  const res = await appeler(lire())
  assert.equal(res.code, 200)
  assert.deepEqual(ids(res), ['BK-1', 'BK-2'])
})
