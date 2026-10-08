// tests/guestflow-boucle.test.js — incident du 8 octobre 2026 : l'agent
// GuestFlow reclassait 4 fils a CHAQUE cycle (48 appels IA par heure) jusqu'a
// epuiser le credit Anthropic, puis ecrivait un incident par appel en echec.
//   - une trace apres CHAQUE appel IA (pause, reponse vide, tache existante) :
//     pas de reclassement sans nouveau message du voyageur ;
//   - au plus 3 appels par fil sur 24 h, avec un incident par fil et par jour ;
//   - un delai croissant apres un echec (jamais rejoue a chaque cycle) ;
//   - un seul incident api_credit par heure.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'cle-test'

const test = require('node:test')
const assert = require('node:assert')

function fakeSupabase (tables, tablesEnPanne = []) {
  const filtre = (rows, f) => rows.filter(r => {
    switch (f.op) {
      case 'eq': return String(r[f.col]) === String(f.val)
      case 'in': return f.val.map(String).includes(String(r[f.col]))
      case 'is': return f.val === null ? r[f.col] == null : r[f.col] === f.val
      case 'not': return !(f.val === null ? r[f.col] == null : r[f.col] === f.val)
      case 'gte': return String(r[f.col]) >= String(f.val)
      default: throw new Error('filtre inconnu ' + f.op)
    }
  })
  return {
    from (table) {
      const q = { filtres: [], ordre: null, limite: null, mode: 'select', charge: null }
      const b = {
        select () { return b },
        eq (col, val) { q.filtres.push({ op: 'eq', col, val }); return b },
        in (col, val) { q.filtres.push({ op: 'in', col, val }); return b },
        is (col, val) { q.filtres.push({ op: 'is', col, val }); return b },
        not (col, op, val) { q.filtres.push({ op: 'not', col, val }); return b },
        gte (col, val) { q.filtres.push({ op: 'gte', col, val }); return b },
        update (row) { q.mode = 'update'; q.charge = row; return b },
        order (col, o) { q.ordre = { col, asc: !o || o.ascending !== false }; return b },
        limit (n) { q.limite = n; return b },
        insert (row) { q.mode = 'insert'; q.charge = row; return b },
        maybeSingle () { q.single = true; return b },
        then (res, rej) {
          try {
            if (tablesEnPanne.includes(table)) return res({ data: null, error: { message: 'panne simulee' } })
            if (q.mode === 'insert') {
              (tables[table] = tables[table] || []).push({ created_at: new Date().toISOString(), ...q.charge })
              return res({ data: null, error: null })
            }
            if (q.mode === 'update') {
              q.filtres.reduce(filtre, tables[table] || []).forEach(r => Object.assign(r, q.charge))
              return res({ data: null, error: null })
            }
            let rows = q.filtres.reduce(filtre, (tables[table] || []).slice())
            if (q.ordre) rows.sort((a, c) => (a[q.ordre.col] < c[q.ordre.col] ? -1 : 1) * (q.ordre.asc ? 1 : -1))
            if (q.limite != null) rows = rows.slice(0, q.limite)
            if (q.single) return res({ data: rows[0] || null, error: null })
            return res({ data: rows, error: null })
          } catch (e) { return rej(e) }
        }
      }
      return b
    }
  }
}

// `contenuIA` : le tableau `content` que rend l'API (permet un bloc thinking).

function charger ({ tables, messages, reponse, mode = 'test', pause = false, envoi = { ok: true, canal: 'ota' } }) {
  const appelsIA = []; const incidents = []; const alertes = []
  const anthropic = { messages: { create: async (req) => {
    appelsIA.push(req)
    if (reponse instanceof Error) throw reponse
    return { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: JSON.stringify(reponse) }] }
  } } }
  const stubs = {
    '../lib/cron-shared': { supabase: fakeSupabase(tables), anthropic, getPropertyMode: async () => mode,
      isAutomationPaused: async () => pause, getSignatureForKey: () => '', SENDVIABEDS24_ENABLED: false },
    '../lib/cron-beds24': { fetchMessages: async () => [], fetchBookingsHistory: async () => [] },
    '../lib/alert-notify': { sendAlertNotifications: async (a) => { alertes.push(a) } },
    '../lib/cron-messages': { sendGuestMessage: async () => envoi },
    '../lib/record-message': { recordMessage: async () => ({ ok: true }) },
    '../lib/cles-migrees': { estCleMigree: async () => false },
    '../lib/founder-notify': { reportIncident: async (type, o) => { incidents.push({ type, ...o }); (tables.automation_incidents = tables.automation_incidents || []).push({ type, 'detail->>booking_id': o.detail && o.detail.booking_id, created_at: new Date().toISOString() }) } },
    '../lib/channels': { getProvider: () => ({ getPropertyMessages: async () => messages, syncMessages: async () => {}, syncBookings: async () => {} }) },
  }
  for (const m of ['../lib/cron-classify', '../lib/guestflow-garde', '../lib/cron-messages']) delete require.cache[require.resolve(m)]
  for (const [k, ex] of Object.entries(stubs)) { const c = require.resolve(k); require.cache[c] = { id: c, filename: c, loaded: true, exports: ex } }
  const mod = require('../lib/cron-classify')
  return { mod, appelsIA, incidents, alertes }
}

const U = 'user-1', P = 'prop-1', B = 'booking-1'
const bien = { id: P, name: 'Ofuro Futari', provider: 'channex' }
const recent = (min) => new Date(Date.now() - min * 60e3).toISOString()
const tables = () => ({ knowledge: [], bookings_snapshot: [], conversations: [], agent_tasks: [], agent_prompting: [], guestflow_appels_ia: [], automation_incidents: [] })
const bilan = () => ({ totalMessages: 0, totalTasks: 0, totalAutoReplies: 0, errors: [], properties: [] })
const fil = (min = 30) => [{ bookingId: B, sender: 'guest', message: 'Merci pour tout !', time: recent(min) }]
const deuxCycles = async (o) => {
  const t = o.tables || tables()
  const a = charger({ ...o, tables: t }); await a.mod.processChannelPropertyMessages(U, bien, bilan())
  const b = charger({ ...o, tables: t }); await b.mod.processChannelPropertyMessages(U, bien, bilan())
  return { t, premier: a.appelsIA.length, second: b.appelsIA.length, incidents: [...a.incidents, ...b.incidents] }
}

test('LE TEST QUI COMPTE (vecu, Ofuro Futari en pause) : un bien en pause — UN appel, une trace, et plus rien au cycle suivant', async () => {
  const r = await deuxCycles({ messages: fil(), mode: 'auto', pause: true, reponse: { type: 'sympathy', reason: 'merci', auto_reply: 'Avec plaisir !', sub_tasks: [] } })
  assert.deepStrictEqual([r.premier, r.second], [1, 0])
  const trace = r.t.agent_tasks.find(x => x.status === 'ignored')
  assert.ok(trace, 'le lot est marque traite')
  assert.match(trace.summary, /Bien en pause/)
  assert.strictEqual(r.t.agent_tasks.filter(x => x.status !== 'ignored').length, 0, 'aucune action proposee a l hote')
})

test('LE TEST QUI COMPTE : une reponse automatique VIDE — une trace, pas de reclassement', async () => {
  const r = await deuxCycles({ messages: fil(), reponse: { type: 'sympathy', reason: 'rien a dire', auto_reply: null, sub_tasks: [] } })
  assert.deepStrictEqual([r.premier, r.second], [1, 0])
})

test('LE TEST QUI COMPTE : une proposition du meme type attend deja (Mode Test) — une trace, pas de reclassement', async () => {
  const t = tables()
  // « pending » (une proposition « pending_validation » serait remplacee avant l'appel : ce n'est pas le cas fautif).
  t.agent_tasks.push({ user_id: U, property_id: P, book_id: B, task_type: 'sympathy', status: 'pending', guest_message: 'autre lot', created_at: recent(120) })
  const r = await deuxCycles({ tables: t, messages: fil(), reponse: { type: 'sympathy', reason: 'merci', auto_reply: 'Avec plaisir !', sub_tasks: [] } })
  assert.deepStrictEqual([r.premier, r.second], [1, 0])
})

test('un NOUVEAU message du voyageur rouvre le fil : la trace ne fait pas taire l agent pour toujours', async () => {
  const t = tables()
  const r = await deuxCycles({ tables: t, messages: fil(30), mode: 'auto', pause: true, reponse: { type: 'sympathy', reason: 'merci', auto_reply: 'Ok', sub_tasks: [] } })
  assert.strictEqual(r.second, 0)
  const c = charger({ tables: t, messages: [...fil(30), { bookingId: B, sender: 'guest', message: 'Il y a une fuite sous l évier !', time: new Date(Date.now() + 60e3).toISOString() }],
    mode: 'auto', pause: true, reponse: { type: 'intervention', reason: 'fuite', auto_reply: null, sub_tasks: [] } })
  await c.mod.processChannelPropertyMessages(U, bien, bilan())
  assert.strictEqual(c.appelsIA.length, 1)
  assert.ok(t.agent_tasks.some(x => x.task_type === 'intervention' && x.status === 'pending'), 'en pause, l intervention arrive quand meme a l hote')
})

test('LE TEST QUI COMPTE : un ECHEC de l IA (credit coupe) n est pas rejoue au cycle suivant — delai croissant, journalise', async () => {
  const credit = Object.assign(new Error('400 Your credit balance is too low to access the Anthropic API.'), { status: 400 })
  const r = await deuxCycles({ messages: fil(), reponse: credit })
  assert.deepStrictEqual([r.premier, r.second], [1, 0], 'le second cycle attend')
  assert.deepStrictEqual(r.t.guestflow_appels_ia.map(x => x.ok), [false])
  // Le delai passe (5 min apres un echec), un essai repart.
  r.t.guestflow_appels_ia[0].created_at = recent(6)
  const c = charger({ tables: r.t, messages: fil(), reponse: credit })
  await c.mod.processChannelPropertyMessages(U, bien, bilan())
  assert.strictEqual(c.appelsIA.length, 1)
})

test('LE TEST QUI COMPTE : au plus 3 appels par fil sur 24 h — au-dela, aucun appel, et UN incident par fil et par jour', async () => {
  const t = tables()
  for (const m of [300, 200, 100]) t.guestflow_appels_ia.push({ user_id: U, booking_id: B, ok: true, created_at: recent(m) })
  const r = await deuxCycles({ tables: t, messages: fil(5), reponse: { type: 'info_unknown', reason: 'x', auto_reply: null, sub_tasks: [] } })
  assert.deepStrictEqual([r.premier, r.second], [0, 0])
  assert.deepStrictEqual(r.incidents.map(i => i.type), ['guestflow_plafond'], 'un seul incident sur deux cycles')
  assert.strictEqual(r.incidents[0].detail.booking_id, B)
  // Revue de ecce019 (B2) : le message ne disparait pas — une tache VISIBLE, une seule.
  const visibles = r.t.agent_tasks.filter(x => x.status === 'pending')
  assert.strictEqual(visibles.length, 1)
  assert.match(visibles[0].summary, /L’agent IA s’est arrêté sur ce fil/)
})

test('le journal dit le modele REELLEMENT utilise', async () => {
  const r = await deuxCycles({ messages: fil(), reponse: { type: 'info_unknown', reason: 'x', auto_reply: null, sub_tasks: [] } })
  assert.deepStrictEqual(r.t.guestflow_appels_ia.map(x => [x.ok, x.modele]), [[true, 'claude-sonnet-5-5']])
})

test('garde-fou pur : le delai double a chaque echec, plafonne a 6 h ; un succes remet a zero', () => {
  const G = require('../lib/guestflow-garde')
  assert.deepStrictEqual([1, 2, 3, 4].map(G.delaiApresEchecs).map(ms => ms / 60e3), [5, 10, 20, 40])
  assert.strictEqual(G.delaiApresEchecs(20), G.DELAI_MAX_MS)
  const now = Date.now()
  assert.strictEqual(G.decider([{ ok: false, created_at: new Date(now - 60e3).toISOString() }], now).motif, 'attente_echec')
  assert.deepStrictEqual(G.decider([{ ok: true, created_at: new Date(now - 60e3).toISOString() }, { ok: false, created_at: new Date(now - 120e3).toISOString() }], now), { ok: true })
})

test('garde-fou : journal ABSENT (migration en retard) — l agent tourne et le dit UNE fois ; autre panne — aucun appel ce cycle', async () => {
  const G = require('../lib/guestflow-garde')
  const absent = { from: () => ({ select () { return this }, eq () { return this }, gte () { return this }, order () { return this }, limit: async () => ({ data: null, error: { message: 'relation "public.guestflow_appels_ia" does not exist' } }) }) }
  const res = { errors: [] }
  assert.strictEqual((await G.peutAppeler(absent, { userId: U, propertyId: P, bookingId: B, results: res })).ok, true)
  await G.peutAppeler(absent, { userId: U, propertyId: P, bookingId: 'b2', results: res })
  assert.strictEqual(res.errors.filter(e => e.context === 'guestflow_journal_absent').length, 1)
  const panne = { from: () => ({ select () { return this }, eq () { return this }, gte () { return this }, order () { return this }, limit: async () => ({ data: null, error: { message: 'connexion perdue' } }) }) }
  assert.deepStrictEqual(await G.peutAppeler(panne, { userId: U, propertyId: P, bookingId: B, results: { errors: [] } }), { ok: false, motif: 'lecture' })
})

test('revue de ecce019 (B2) : au plafond, un 4e message (« une fuite ! ») devient une tache VISIBLE et l hote est ALERTE ; les echecs ne comptent pas', async () => {
  const t = tables()
  for (const m of [300, 200, 100]) t.guestflow_appels_ia.push({ user_id: U, booking_id: B, ok: true, created_at: recent(m) })
  const c = charger({ tables: t, messages: [{ bookingId: B, sender: 'guest', message: 'Il y a une fuite d eau !', time: recent(2) }], reponse: { type: 'intervention', reason: 'x', auto_reply: null, sub_tasks: [] } })
  await c.mod.processChannelPropertyMessages(U, bien, bilan())
  assert.strictEqual(c.appelsIA.length, 0)
  assert.strictEqual(t.agent_tasks.filter(x => x.status === 'pending').length, 1)
  assert.strictEqual(c.alertes.length, 1, 'l hote est alerte')
  const G = require('../lib/guestflow-garde')
  const now = Date.now()
  const echecs = [1, 2, 3, 4].map(k => ({ ok: false, created_at: new Date(now - k * 3600e3).toISOString() }))
  assert.deepStrictEqual(G.decider(echecs, now), { ok: true }, '4 echecs vieux de plus de 6 h : pas de plafond, delai ecoule')
})

test('revue de ecce019 (B1) : un envoi en ECHEC en Mode Auto devient une proposition VISIBLE a renvoyer, et l incident part des le 1er echec', async () => {
  const r = await deuxCycles({ messages: fil(), mode: 'auto', envoi: { ok: false, error: 'HTTP 503' }, reponse: { type: 'sympathy', reason: 'merci', auto_reply: 'Avec plaisir !', sub_tasks: [] } })
  assert.deepStrictEqual([r.premier, r.second], [1, 0], 'pas de reclassement a chaque cycle')
  const p = r.t.agent_tasks.find(x => x.status === 'pending_validation')
  assert.ok(p, 'visible pour l hote')
  assert.strictEqual(p.suggested_reply, 'Avec plaisir !')
  assert.match(p.summary, /NON DÉLIVRÉE \(HTTP 503\)/)
  const inc = r.incidents.find(i => i.type === 'send_failure')
  assert.ok(inc && inc.threshold === 1)
})

test('revue de ecce019 (B3) : sous le plafond, une proposition en attente n est PAS ecartee (rien ne la remplacerait)', async () => {
  const t = tables()
  for (const m of [300, 200, 100]) t.guestflow_appels_ia.push({ user_id: U, booking_id: B, ok: true, created_at: recent(m) })
  t.agent_tasks.push({ id: 'prop-1', user_id: U, property_id: P, book_id: B, task_type: 'sympathy', status: 'pending_validation', guest_message: 'ancien lot', created_at: recent(200) })
  const c = charger({ tables: t, messages: fil(5), reponse: { type: 'sympathy', reason: 'x', auto_reply: 'ok', sub_tasks: [] } })
  await c.mod.processChannelPropertyMessages(U, bien, bilan())
  assert.strictEqual(t.agent_tasks.find(x => x.id === 'prop-1').status, 'pending_validation')
})

test('revue de ecce019 : la trace est DATEE du dernier message du lot — un message ecrit pendant l appel IA rouvre le fil', async () => {
  const t = tables()
  const c = charger({ tables: t, messages: fil(30), mode: 'auto', pause: true, reponse: { type: 'sympathy', reason: 'merci', auto_reply: 'Ok', sub_tasks: [] } })
  await c.mod.processChannelPropertyMessages(U, bien, bilan())
  const trace = t.agent_tasks.find(x => x.status === 'ignored')
  assert.ok(Math.abs(Date.parse(trace.created_at) - (Date.now() - 30 * 60e3)) < 5000, 'datee du dernier message du lot (il y a 30 min), pas de l insertion')
  // Un message ecrit 1 min APRES le lot (pendant l'appel) : le fil se rouvre.
  const d = charger({ tables: t, messages: [...fil(30), { bookingId: B, sender: 'guest', message: 'Et le parking ?', time: recent(29) }], mode: 'auto', pause: true, reponse: { type: 'info_unknown', reason: 'x', auto_reply: null, sub_tasks: [] } })
  await d.mod.processChannelPropertyMessages(U, bien, bilan())
  assert.strictEqual(d.appelsIA.length, 1)
})
