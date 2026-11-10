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
const AUTRE_COMPTE = '33333333-3333-4333-8333-333333333333'
const MODULES = ['../lib/require-permission', '../lib/permissions', '../lib/biens-vivants', '../api/messages']
const MIN = 60000
const il = (ms) => new Date(Date.now() - ms).toISOString()

// Deux fils : B1 sur le bien A (209413), B2 sur le bien B (169567).
// `sent_at` est l'instant du PROVIDER, `created_at` l'ordre d'INSERTION en
// base : ils ne vont pas dans le meme ordre (review 1, constat 3).
const T1 = il(10 * MIN), T2 = il(5 * MIN), T3 = il(1 * MIN)
const LIGNES = [
  { user_id: PROD, booking_id: 'B1', property_id: '209413', sender: 'guest', direction: 'inbound', body: 'Bonjour', sent_at: T1, created_at: T1, kind: 'message', origine: null },
  { user_id: PROD, booking_id: 'B1', property_id: '209413', sender: 'host', direction: 'outbound', body: 'Bienvenue', sent_at: T2, created_at: T2, kind: 'message', origine: 'hote' },
  { user_id: PROD, booking_id: 'B2', property_id: '169567', sender: 'guest', direction: 'inbound', body: 'SECRET DE L AUTRE BIEN', sent_at: T3, created_at: T3, kind: 'message', origine: null },
  // ⚠ UN AUTRE COMPTE, LE MEME `booking_id` (review 1, constat 4) : `fil` vient
  // du client, et un identifiant Beds24 est un nombre qu'on devine. Pour un
  // titulaire, `user_id` est la SEULE barriere.
  { user_id: AUTRE_COMPTE, booking_id: 'B1', property_id: '209413', sender: 'guest', direction: 'inbound', body: 'MESSAGE D UN AUTRE COMPTE', sent_at: il(30000), created_at: il(30000), kind: 'message', origine: null }
]
const TACHES = [
  { id: 't1', user_id: PROD, book_id: 'B1', property_id: '209413', status: 'pending_validation', suggested_reply: 'Proposition B1', created_at: T2 },
  { id: 't2', user_id: PROD, book_id: 'B2', property_id: '169567', status: 'pending_validation', suggested_reply: 'PROPOSITION SECRETE', created_at: T3 },
  { id: 't3', user_id: AUTRE_COMPTE, book_id: 'B1', property_id: '209413', status: 'pending_validation', suggested_reply: 'PROPOSITION D UN AUTRE COMPTE', created_at: T3 }
]

function preparer ({ membre = false, perimetre = ['209413'], lignes = LIGNES, taches = TACHES, archives = [] } = {}) {
  const etat = { lectures: [] }
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: membre ? MEMBRE : PROD } }, error: null }) },
    from (nom) {
      const q = { eq: {}, neq: {}, gte: {}, gt: {}, or: null, in: {}, not: [], ordre: null, limite: null }
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
          .filter(r => Object.entries(q.gt).every(([k, v]) => new Date(r[k]) > new Date(v)))
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
        gt (k, v) { q.gt[k] = v; return c },
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

test('LE TEST QUI COMPTE : le fil ouvert ne rend QUE ce qui a ete INSERE apres le curseur, dans l ordre', async () => {
  preparer()
  const res = await appeler({ direct: '1', fil: 'B1', depuis: T1 })
  assert.equal(res.code, 200)
  assert.deepEqual(res.body.messages.map(m => m.body), ['Bienvenue'], '> curseur : la ligne du curseur ne revient pas, rien d avant')
  assert.deepEqual(Object.keys(res.body.messages[0]).sort(), ['body', 'direction', 'kind', 'origine', 'sender', 'sent_at'])
  assert.deepEqual(res.body.taches.map(x => x.id), ['t1'])
  assert.equal(res.body.dernier, T3, 'le titulaire voit le dernier message de son compte, hors du fil ouvert')
  assert.equal(res.body.complet, true)
  assert.equal(res.body.curseur, T2, 'le curseur suit la derniere ligne rendue')
})

test('LE TEST QUI COMPTE : un message insere APRES la reponse de l hote, mais date d AVANT, est rendu', async () => {
  // Review 1, constat 3 : le webhook du voyageur arrive apres la reponse de
  // l'hote, avec un `sent_at` anterieur. Un curseur sur `sent_at` le sautait
  // pour toujours.
  const tardif = { user_id: PROD, booking_id: 'B1', property_id: '209413', sender: 'guest', direction: 'inbound',
    body: 'Je suis devant la porte', sent_at: il(6 * MIN), created_at: il(10000), kind: 'message', origine: null }
  preparer({ lignes: [...LIGNES, tardif] })
  const res = await appeler({ direct: '1', fil: 'B1', depuis: T2 })
  assert.deepEqual(res.body.messages.map(m => m.body), ['Je suis devant la porte'])
  assert.equal(res.body.curseur, tardif.created_at)
})

test('rien de neuf : aucun message, et le curseur ne bouge pas', async () => {
  preparer()
  const res = await appeler({ direct: '1', fil: 'B1', depuis: T2 })
  assert.deepEqual(res.body.messages, [])
  assert.equal(res.body.curseur, new Date(T2).toISOString())
})

test('LE TEST QUI COMPTE : le TITULAIRE d un autre compte qui devine le booking_id ne lit RIEN de ce compte-ci', async () => {
  // Review 1, constat 4 : retirer `.eq('user_id')` d'une des trois lectures
  // laissait les tests verts. Ici l'appelant est PROD : la ligne et la
  // proposition d'AUTRE_COMPTE, sur le meme B1, ne doivent pas sortir.
  preparer()
  const res = await appeler({ direct: '1', fil: 'B1', depuis: il(60 * MIN) })
  const brut = JSON.stringify(res.body)
  assert.ok(!brut.includes('AUTRE COMPTE'), 'une donnee d un autre compte est sortie : ' + brut)
  assert.deepEqual(res.body.messages.map(m => m.body), ['Bonjour', 'Bienvenue'])
  const liste = await appeler({ direct: '1' })
  assert.equal(liste.body.dernier, T3, 'l instant du dernier message d un autre compte a fuite')
})

test('LE TEST QUI COMPTE : un membre limite au bien A n apprend RIEN du bien B — ni messages, ni propositions, ni l heure', async () => {
  preparer({ membre: true, perimetre: ['209413'] })
  const res = await appeler({ direct: '1', fil: 'B2', depuis: il(60 * MIN) })
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
  const res = await appeler({ direct: '1', fil: 'B2', depuis: T1 })
  assert.equal(res.body.dernier, T2, 'le message de B2 lui-meme a compte')
})

test('sans fil : la liste seule, et seulement l instant du dernier message', async () => {
  preparer()
  const res = await appeler({ direct: '1' })
  assert.equal(res.code, 200)
  assert.deepEqual(res.body, { dernier: T3 })
})

test('LE TEST QUI COMPTE : trois lectures metier avec un fil, une sans — compte ET perimetre sur chacune', async () => {
  const etat = preparer({ membre: true })
  await appeler({ direct: '1', fil: 'B1', depuis: T1 })
  const metier = etat.lectures.filter(l => ['messages', 'agent_tasks'].includes(l.table))
  assert.equal(metier.length, 3, 'messages du fil, dernier du compte, propositions du fil')
  assert.ok(metier.every(l => /property_id\.in\.\(209413\)/.test(l.or || '')), 'une lecture sans filtre de perimetre')
  assert.ok(metier.every(l => l.eq.user_id === PROD), 'une lecture sans le compte cible')
  const etat2 = preparer()
  await appeler({ direct: '1' })
  assert.equal(etat2.lectures.filter(l => ['messages', 'agent_tasks', 'properties'].includes(l.table)).length, 1)
})

test('aucune donnee de compte en cache : `private, no-store` partout, le 405 et le 401 compris, et Server-Timing compte les requetes', async () => {
  preparer()
  const res = await appeler({ direct: '1', fil: 'B1', depuis: T1 })
  assert.equal(res.entetes['cache-control'], 'private, no-store')
  assert.match(res.entetes['server-timing'] || '', /^db;desc="\d+ requêtes";dur=\d+$/)
  const r405 = await appeler({}, { method: 'PUT' })
  assert.equal(r405.code, 405)
  assert.equal(r405.entetes['cache-control'], 'private, no-store', 'le 405 part sans en-tete de cache')
  const r401 = reponse()
  await require('../api/messages')({ method: 'GET', query: { direct: '1' }, body: null, headers: {} }, r401)
  assert.equal(r401.code, 401)
  assert.equal(r401.entetes['cache-control'], 'private, no-store', 'le 401 part sans en-tete de cache')
})

test('les entrees se verifient : curseur invalide ou absent, fil trop long, ligne du simulateur → 400', async () => {
  preparer()
  assert.equal((await appeler({ direct: '1', fil: 'B1', depuis: 'hier' })).code, 400)
  assert.equal((await appeler({ direct: '1', fil: 'B1' })).code, 400)
  assert.equal((await appeler({ direct: '1', fil: 'x'.repeat(201), depuis: T1 })).code, 400)
  assert.equal((await appeler({ direct: '1', fil: '__SIM_ENABLED__', depuis: T1 })).code, 400)
})

test('une page restee ouverte longtemps ne relit pas plus de 7 jours, ni plus de 200 messages — et reprend au 201e', async () => {
  const lignes = Array.from({ length: 205 }, (_, i) => ({
    user_id: PROD, booking_id: 'B1', property_id: '209413', sender: 'guest', direction: 'inbound',
    body: 'm' + i, sent_at: il((300 - i) * 1000), created_at: il((300 - i) * 1000), kind: 'message', origine: null
  }))
  const etat = preparer({ lignes })
  const res = await appeler({ direct: '1', fil: 'B1', depuis: '2020-01-01T00:00:00Z' })
  assert.equal(res.code, 200)
  assert.equal(res.body.messages.length, 200)
  assert.equal(res.body.complet, false, 'une lecture coupee doit le dire')
  const lecture = etat.lectures.find(l => l.table === 'messages' && l.eq.booking_id === 'B1')
  assert.ok(new Date(lecture.gt.created_at) >= new Date(Date.now() - 7 * 86400000 - 5000), 'la fenetre de 7 jours n est pas tenue')
  const suite = await appeler({ direct: '1', fil: 'B1', depuis: res.body.curseur })
  assert.deepEqual(suite.body.messages.map(m => m.body), ['m200', 'm201', 'm202', 'm203', 'm204'])
  assert.equal(suite.body.complet, true)
})

test('la colonne `origine` absente (migration pas encore posee) : la lecture se replie, elle ne tombe pas', async () => {
  preparer()
  // Le meme client que l'endpoint (le double rend toujours le meme objet).
  const vrai = require.cache[require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))].exports.createClient()
  const from = vrai.from.bind(vrai)
  let refus = 0
  vrai.from = (nom) => {
    const q = from(nom)
    if (nom !== 'messages') return q
    const select = q.select
    q.select = (colonnes) => {
      if (/origine/.test(colonnes || '')) {
        refus++
        const ko = { error: { message: 'column messages.origine does not exist' }, data: null }
        const chaine = new Proxy({}, { get: (_, k) => k === 'then' ? (ok, nok) => Promise.resolve(ko).then(ok, nok) : () => chaine })
        return chaine
      }
      return select(colonnes)
    }
    return q
  }
  const res = await appeler({ direct: '1', fil: 'B1', depuis: T1 })
  assert.equal(res.code, 200)
  assert.ok(refus >= 1, 'jeu d essai : la colonne doit avoir ete refusee')
  assert.deepEqual(res.body.messages.map(m => m.body), ['Bienvenue'])
})

test('un bien ARCHIVE ne sort plus de Messages, en direct non plus', async () => {
  preparer({ archives: ['209413'] })
  const res = await appeler({ direct: '1', fil: 'B1', depuis: T1 })
  assert.equal(res.code, 200)
  assert.deepEqual(res.body.messages, [])
  assert.deepEqual(res.body.taches, [])
})

test('perimetre VIDE : la meme forme, vide — jamais tout le compte', async () => {
  preparer({ membre: true, perimetre: [] })
  const res = await appeler({ direct: '1', fil: 'B1', depuis: T1 })
  assert.equal(res.code, 200)
  assert.deepEqual(res.body.messages, [])
  assert.deepEqual(res.body.taches, [])
  assert.equal(res.body.dernier, null)
})

test('la collection rend l instant de sa lecture (horloge serveur), point de depart du direct', async () => {
  preparer()
  const avant = Date.now()
  const res = await appeler({})
  assert.equal(res.code, 200)
  const t = new Date(res.body.lu_le).getTime()
  assert.ok(t >= avant - 1000 && t <= Date.now() + 1000, 'lu_le absent ou faux : ' + res.body.lu_le)
})
