// tests/messages-direct-api.test.js
// La lecture ETROITE du fil en direct : `GET /api/messages?direct=1`.
// Spec : docs/specs/spec-messages-fil-en-direct.md §3 et §6.
//
// ⚠ ON VERIFIE CE QUI SORT, comme tests/delegation-menages-messages.test.js :
// un filtre de perimetre absent ne casse rien de visible, il donne juste plus
// que prevu. Le double applique VRAIMENT `.eq`, `.gte`, `.or(col.in.(…))` et
// `.limit` — un filtre pose sur la mauvaise colonne rendrait autre chose.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

const PROD = '85e3a0ef-75bd-4c11-a3b7-e2811067dc36'
const MEMBRE = '18920ead-1111-2222-3333-444444444444'
const MODULES = ['../lib/require-permission', '../lib/permissions', '../lib/biens-vivants', '../api/messages']
const MIN = 60000
const il = (ms) => new Date(Date.now() - ms).toISOString()

// Deux fils : B1 sur le bien A (209413), B2 sur le bien B (169567).
const T1 = il(10 * MIN), T2 = il(5 * MIN), T3 = il(1 * MIN)
const LIGNES = [
  { user_id: PROD, booking_id: 'B1', property_id: '209413', sender: 'guest', direction: 'inbound', body: 'Bonjour', sent_at: T1, kind: 'message', origine: null },
  { user_id: PROD, booking_id: 'B1', property_id: '209413', sender: 'host', direction: 'outbound', body: 'Bienvenue', sent_at: T2, kind: 'message', origine: 'hote' },
  { user_id: PROD, booking_id: 'B2', property_id: '169567', sender: 'guest', direction: 'inbound', body: 'SECRET DE L AUTRE BIEN', sent_at: T3, kind: 'message', origine: null }
]
const TACHES = [
  { id: 't1', user_id: PROD, book_id: 'B1', property_id: '209413', status: 'pending_validation', suggested_reply: 'Proposition B1', created_at: T2 },
  { id: 't2', user_id: PROD, book_id: 'B2', property_id: '169567', status: 'pending_validation', suggested_reply: 'PROPOSITION SECRETE', created_at: T3 }
]

function preparer ({ membre = false, perimetre = ['209413'], lignes = LIGNES, taches = TACHES, archives = [] } = {}) {
  const etat = { lectures: [] }
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: membre ? MEMBRE : PROD } }, error: null }) },
    from (nom) {
      const q = { eq: {}, neq: {}, gte: {}, or: null, in: {}, not: [], ordre: null, limite: null }
      const passeOr = (ligne) => {
        if (!q.or) return true
        const m = q.or.match(/(\w+)\.in\.\(([^)]*)\)/)
        if (!m) throw new Error('double : filtre .or inattendu — ' + q.or)
        return m[2].split(',').includes(String(ligne[m[1]]))
      }
      const un = (r) => ({ data: Array.isArray(r.data) ? (r.data[0] || null) : r.data, error: r.error })
      const executer = () => {
        etat.lectures.push({ table: nom, ...q })
        if (nom === 'profiles') {
          const l = { id: 'p1', account_user_id: PROD, member_user_id: MEMBRE, is_owner: false, active: true, accepted_at: '2026-09-01' }
          return { data: [l], error: null }
        }
        if (nom === 'profile_permissions') {
          return { data: { profile_id: 'p1', property_scope: 'selected', property_ids: [], property_refs: perimetre,
            messages: 'read', reservations: 'read' }, error: null }
        }
        if (nom === 'properties') {
          return { data: archives.map(ref => ({ user_id: PROD, provider_property_id: ref, archive_le: '2026-11-01T00:00:00Z' })), error: null }
        }
        let rows = nom === 'messages' ? lignes : nom === 'agent_tasks' ? taches : []
        rows = rows.filter(r => Object.entries(q.eq).every(([k, v]) => String(r[k]) === String(v)))
          .filter(r => Object.entries(q.neq).every(([k, v]) => String(r[k]) !== String(v)))
          .filter(r => Object.entries(q.gte).every(([k, v]) => new Date(r[k]) >= new Date(v)))
          .filter(passeOr)
        if (q.ordre) {
          const [col, asc] = q.ordre
          rows = [...rows].sort((a, b) => (new Date(a[col]) - new Date(b[col])) * (asc ? 1 : -1))
        }
        if (q.limite != null) rows = rows.slice(0, q.limite)
        return { data: rows, error: null }
      }
      const c = {
        select () { return c },
        eq (k, v) { q.eq[k] = v; return c },
        gte (k, v) { q.gte[k] = v; return c },
        or (e) { q.or = e; return c },
        in (k, v) { q.in[k] = v; return c },
        not (k) { q.not.push(k); return c },
        is () { return c }, neq (k, v) { q.neq[k] = v; return c },
        order (col, o) { if (!q.ordre) q.ordre = [col, !o || o.ascending !== false]; return c },
        limit (n) { q.limite = n; return c },
        single: async () => un(executer()),
        maybeSingle: async () => un(executer()),
        then (ok, ko) { return Promise.resolve(executer()).then(ok, ko) }
      }
      return c
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
  return etat
}

function reponse () {
  const r = { code: null, body: null, entetes: {} }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = (k, v) => { r.entetes[k.toLowerCase()] = v }
  return r
}
const req = (query, { method = 'GET', compte = PROD } = {}) => ({
  method, query, body: null,
  headers: { authorization: 'Bearer j', ...(compte ? { 'x-compte': compte } : {}) }
})
async function appeler (query, opts) {
  const res = reponse()
  await require('../api/messages')(req(query, opts), res)
  return res
}

test('LE TEST QUI COMPTE : le fil ouvert ne rend QUE ce qui est neuf depuis `apres`, dans l ordre', async () => {
  preparer()
  const res = await appeler({ direct: '1', fil: 'B1', apres: T2 })
  assert.equal(res.code, 200)
  assert.deepEqual(res.body.messages.map(m => m.body), ['Bienvenue'], '>= apres : le message connu revient, rien d avant')
  assert.deepEqual(Object.keys(res.body.messages[0]).sort(), ['body', 'direction', 'kind', 'origine', 'sender', 'sent_at'])
  assert.deepEqual(res.body.taches.map(x => x.id), ['t1'])
  assert.equal(res.body.dernier, T3, 'le titulaire voit le dernier message de tout son compte, hors du fil ouvert')
  assert.equal(res.body.complet, true)
})

test('LE TEST QUI COMPTE : un membre limite au bien A n apprend RIEN du bien B — ni messages, ni propositions, ni l heure', async () => {
  preparer({ membre: true, perimetre: ['209413'] })
  const res = await appeler({ direct: '1', fil: 'B2', apres: il(60 * MIN) })
  assert.equal(res.code, 200)
  const brut = JSON.stringify(res.body)
  assert.ok(!brut.includes('SECRET'), 'un contenu du bien B est sorti : ' + brut)
  assert.deepEqual(res.body.messages, [])
  assert.deepEqual(res.body.taches, [])
  assert.equal(res.body.dernier, T2)
  // Sans fil, la seule chose rendue est l'heure du dernier message : celle du
  // bien B (T3, plus recente) ne doit pas sortir.
  const liste = await appeler({ direct: '1' })
  assert.deepEqual(liste.body, { dernier: T2 }, 'l instant du dernier message du bien B a fuite')
})

test('`dernier` est pris HORS du fil ouvert : un message dans le fil ne fait pas relire la liste', async () => {
  preparer()
  const res = await appeler({ direct: '1', fil: 'B2', apres: T1 })
  assert.equal(res.body.dernier, T2, 'le message de B2 lui-meme a compte')
})

test('sans fil : la liste seule, et seulement l instant du dernier message', async () => {
  preparer()
  const res = await appeler({ direct: '1' })
  assert.equal(res.code, 200)
  assert.deepEqual(res.body, { dernier: T3 })
})

test('LE TEST QUI COMPTE : trois lectures avec un fil, une sans — et le perimetre sur chacune', async () => {
  const etat = preparer({ membre: true })
  await appeler({ direct: '1', fil: 'B1', apres: T1 })
  const metier = etat.lectures.filter(l => ['messages', 'agent_tasks'].includes(l.table))
  assert.equal(metier.length, 3, 'messages du fil, dernier du compte, propositions du fil')
  assert.ok(metier.every(l => /property_id\.in\.\(209413\)/.test(l.or || '')), 'une lecture sans filtre de perimetre')
  const etat2 = preparer()
  await appeler({ direct: '1' })
  assert.equal(etat2.lectures.filter(l => ['messages', 'agent_tasks', 'properties'].includes(l.table)).length, 1)
})

test('aucune donnee de compte en cache : `private, no-store` partout, le 405 compris, et Server-Timing compte les requetes', async () => {
  preparer()
  const res = await appeler({ direct: '1', fil: 'B1', apres: T1 })
  assert.equal(res.entetes['cache-control'], 'private, no-store')
  assert.match(res.entetes['server-timing'] || '', /^db;desc="\d+ requêtes";dur=\d+$/)
  const r405 = await appeler({}, { method: 'PUT' })
  assert.equal(r405.code, 405)
  assert.equal(r405.entetes['cache-control'], 'private, no-store', 'le 405 part sans en-tete de cache')
})

test('les entrees se verifient : `apres` invalide, fil trop long ou ligne du simulateur → 400', async () => {
  preparer()
  assert.equal((await appeler({ direct: '1', fil: 'B1', apres: 'hier' })).code, 400)
  assert.equal((await appeler({ direct: '1', fil: 'B1' })).code, 400)
  assert.equal((await appeler({ direct: '1', fil: 'x'.repeat(201), apres: T1 })).code, 400)
  assert.equal((await appeler({ direct: '1', fil: '__SIM_ENABLED__', apres: T1 })).code, 400)
})

test('une page restee ouverte longtemps ne relit pas plus de 7 jours, ni plus de 200 messages', async () => {
  const lignes = Array.from({ length: 205 }, (_, i) => ({
    user_id: PROD, booking_id: 'B1', property_id: '209413', sender: 'guest', direction: 'inbound',
    body: 'm' + i, sent_at: il((300 - i) * 1000), kind: 'message', origine: null
  }))
  const etat = preparer({ lignes })
  const res = await appeler({ direct: '1', fil: 'B1', apres: '2020-01-01T00:00:00Z' })
  assert.equal(res.code, 200)
  assert.equal(res.body.messages.length, 200)
  assert.equal(res.body.complet, false, 'une lecture coupee doit le dire')
  const lecture = etat.lectures.find(l => l.table === 'messages' && l.eq.booking_id === 'B1')
  assert.ok(new Date(lecture.gte.sent_at) >= new Date(Date.now() - 7 * 86400000 - 5000), 'la fenetre de 7 jours n est pas tenue')
})

test('un bien ARCHIVE ne sort plus de Messages, en direct non plus', async () => {
  preparer({ archives: ['209413'] })
  const res = await appeler({ direct: '1', fil: 'B1', apres: T1 })
  assert.equal(res.code, 200)
  assert.deepEqual(res.body.messages, [])
  assert.deepEqual(res.body.taches, [])
})

test('perimetre VIDE : la meme forme, vide — jamais tout le compte', async () => {
  preparer({ membre: true, perimetre: [] })
  const res = await appeler({ direct: '1', fil: 'B1', apres: T1 })
  assert.equal(res.code, 200)
  assert.deepEqual(res.body, { messages: [], taches: [], dernier: null, complet: true })
})
