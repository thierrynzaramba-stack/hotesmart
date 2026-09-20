// tests/garde-echo-conversation.test.js
// Incident du 20 septembre 2026 : « je peux venir avec mon chien ? » — recu par
// e-mail sur une resa Offline du 23, base de connaissance a jour (animaux non
// acceptes), bien en mode auto, cron vivant. Ni reponse, ni tache, ni log.
//
// CAUSE. Les webhooks entrants (Channex, e-mail) ecrivent une ligne
// `conversations` SANS `agent_reply` a la reception de chaque message du
// voyageur — un echo, date de la reception, donc toujours APRES l'instant du
// message. `hasNewerTaskOrConv` lisait « une conversation creee apres le
// dernier message guest » sans regarder si elle portait une reponse : l'echo
// passait pour un traitement, et le fil etait ecarte en silence. Pose le
// 20 aout sur le chemin Channex, la garde a rendu l'agent muet un mois entier :
// 0 reponse IA sur Channex en 45 jours.
//
// Ces tests portent sur les deux decisions du correctif :
//   - une conversation sans reponse ne vaut pas traitement ;
//   - la reouverture ne remonte pas le passe (borne de reprise).

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'cle-test'

const test = require('node:test')
const assert = require('node:assert')

// ─── Un faux Supabase qui FILTRE vraiment ───────────────────────────────────
// Un faux qui rendrait des lignes fixes ne prouverait rien : ce qu'on teste,
// c'est precisement quel filtre la garde applique. Il faut donc que `.not(...)`
// change le resultat.
function fakeSupabase (tables, journal) {
  const filtre = (rows, f) => rows.filter(r => {
    switch (f.op) {
      case 'eq': return String(r[f.col]) === String(f.val)
      case 'neq': return String(r[f.col]) !== String(f.val)
      case 'in': return f.val.map(String).includes(String(r[f.col]))
      case 'is': return f.val === null ? r[f.col] == null : r[f.col] === f.val
      case 'not': return !(f.val === null ? r[f.col] == null : r[f.col] === f.val)
      case 'gte': return String(r[f.col]) >= String(f.val)
      case 'lte': return String(r[f.col]) <= String(f.val)
      default: throw new Error('filtre inconnu ' + f.op)
    }
  })
  return {
    from (table) {
      const q = { table, filtres: [], ordre: null, limite: null, mode: 'select', charge: null }
      const b = {
        select () { return b },
        eq (col, val) { q.filtres.push({ op: 'eq', col, val }); return b },
        neq (col, val) { q.filtres.push({ op: 'neq', col, val }); return b },
        in (col, val) { q.filtres.push({ op: 'in', col, val }); return b },
        is (col, val) { q.filtres.push({ op: 'is', col, val }); return b },
        not (col, op, val) { assert.strictEqual(op, 'is', 'seul not(col, is, x) est simule'); q.filtres.push({ op: 'not', col, val }); return b },
        gte (col, val) { q.filtres.push({ op: 'gte', col, val }); return b },
        lte (col, val) { q.filtres.push({ op: 'lte', col, val }); return b },
        order (col, o) { q.ordre = { col, asc: !o || o.ascending !== false }; return b },
        limit (n) { q.limite = n; return b },
        insert (row) { q.mode = 'insert'; q.charge = row; return b },
        update (row) { q.mode = 'update'; q.charge = row; return b },
        maybeSingle () { q.single = true; return b },
        single () { q.single = true; return b },
        then (res, rej) {
          try {
            journal.push({ table, mode: q.mode, filtres: q.filtres.slice(), charge: q.charge })
            if (q.mode === 'insert') {
              (tables[table] = tables[table] || []).push(...(Array.isArray(q.charge) ? q.charge : [q.charge]))
              return res({ data: null, error: null })
            }
            if (q.mode === 'update') return res({ data: null, error: null })
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

// ─── Chargement isole du module, avec ses voisins neutralises ───────────────
function charger ({ tables, journal, messagesChannex, reponseIA }) {
  const appelsIA = []
  const anthropic = {
    messages: {
      create: async (req) => {
        appelsIA.push(req)
        return { content: [{ type: 'text', text: JSON.stringify(reponseIA) }] }
      }
    }
  }
  const stubs = {
    '../lib/cron-shared': {
      supabase: fakeSupabase(tables, journal), anthropic,
      getPropertyMode: async () => 'test', isAutomationPaused: async () => false,
      getSignatureForKey: () => '', SENDVIABEDS24_ENABLED: false
    },
    '../lib/cron-beds24': { fetchMessages: async () => [], fetchBookingsHistory: async () => [] },
    '../lib/alert-notify': { sendAlertNotifications: async () => {} },
    '../lib/record-message': { recordMessage: async () => ({ ok: true }) },
    '../lib/cles-migrees': { estCleMigree: async () => false },
    '../lib/channels': { getProvider: () => ({ getPropertyMessages: async () => messagesChannex }) }
  }
  // ⚠ LES STUBS RESTENT EN PLACE. `require('./channels')` est appele
  // PARESSEUSEMENT, a l'interieur de `processChannelPropertyMessages` : un stub
  // retire juste apres le chargement laisserait le vrai module — et son vrai
  // Supabase — repondre a l'appel. Chaque fichier de test tourne dans son propre
  // processus : rien ne fuit ailleurs.
  const cible = require.resolve('../lib/cron-classify')
  delete require.cache[cible]
  for (const [k, ex] of Object.entries(stubs)) {
    const c = require.resolve(k)
    require.cache[c] = { id: c, filename: c, loaded: true, exports: ex }
  }
  const mod = require('../lib/cron-classify')
  delete require.cache[cible]
  return { mod, appelsIA }
}

const U = 'user-1', P = 'prop-uuid-1', B = 'booking-1'
// ⚠ LE TEMPS EST INJECTE, PAS LU. Les fixtures se posent par rapport a la borne
// de reprise du module, jamais par rapport a l'horloge : un poste en retard, ou
// la minute qui suit la borne, ne doit pas faire passer « l'echo fait taire »
// pour « le passe est ferme ». Regle du depot : dates relatives si le test lit
// l'horloge, dates figees s'il injecte le temps.
const BORNE = mod0().REPRISE_DEPUIS.getTime()
const iso = (ms) => new Date(ms).toISOString()
const MSG = iso(BORNE + 3600 * 1000)          // une heure apres la borne
const APRES = iso(BORNE + 3600 * 1000 + 30e3) // 30 s apres le message
const AVANT = iso(BORNE + 3600 * 1000 - 30e3) // 30 s avant

// ─── La garde ───────────────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : l\'echo du voyageur (conversation sans reponse) ne vaut pas traitement', async () => {
  const tables = { agent_tasks: [], conversations: [
    { id: 'c1', user_id: U, book_id: B, property_id: P, agent_reply: null, created_at: APRES }
  ] }
  const { mod } = charger({ tables, journal: [], messagesChannex: [], reponseIA: {} })
  assert.strictEqual(await mod.hasNewerTaskOrConv(U, P, B, new Date(MSG)), false,
    'la ligne ecrite par le webhook a la reception n\'est pas une reponse')
})

test('une conversation AVEC reponse apres le message vaut traitement', async () => {
  const tables = { agent_tasks: [], conversations: [
    { id: 'c1', user_id: U, book_id: B, property_id: P, agent_reply: null, created_at: APRES },
    { id: 'c2', user_id: U, book_id: B, property_id: P, agent_reply: 'Non, desole.', created_at: APRES }
  ] }
  const { mod } = charger({ tables, journal: [], messagesChannex: [], reponseIA: {} })
  assert.strictEqual(await mod.hasNewerTaskOrConv(U, P, B, new Date(MSG)), true)
})

test('une reponse ANTERIEURE au message ne vaut pas traitement — le fil attend', async () => {
  const tables = { agent_tasks: [], conversations: [
    { id: 'c0', user_id: U, book_id: B, property_id: P, agent_reply: 'Bienvenue !', created_at: AVANT },
    { id: 'c1', user_id: U, book_id: B, property_id: P, agent_reply: null, created_at: APRES }
  ] }
  const { mod } = charger({ tables, journal: [], messagesChannex: [], reponseIA: {} })
  assert.strictEqual(await mod.hasNewerTaskOrConv(U, P, B, new Date(MSG)), false)
})

test('une tache `auto_message` (modele, code d\'acces) apres le message ne vaut pas traitement', async () => {
  // Constat de review : en Mode Test, processMessageTemplates depose une tache
  // `auto_message` a valider, dans le MEME cycle, juste avant la classification.
  // Elle parle du sejour, pas du fil : elle ne doit pas le faire taire.
  const tables = { conversations: [], agent_tasks: [
    { id: 't1', user_id: U, book_id: B, property_id: P, task_type: 'auto_message', status: 'pending_validation', created_at: APRES }
  ] }
  const { mod } = charger({ tables, journal: [], messagesChannex: [], reponseIA: {} })
  assert.strictEqual(await mod.hasNewerTaskOrConv(U, P, B, new Date(MSG)), false)
})

test('la reponse d\'un AUTRE compte sur la meme cle de bien ne fait pas taire ce fil', async () => {
  // Constat de review : la cle provider n'a aucune unicite globale. Le pre-scan
  // « derniere reponse par booking » lisait sans user_id ; il n'existe plus.
  const tables = { agent_tasks: [], conversations: [
    { id: 'c1', user_id: 'autre-compte', book_id: B, property_id: P, agent_reply: 'reponse ailleurs', created_at: APRES }
  ] }
  const { mod } = charger({ tables, journal: [], messagesChannex: [], reponseIA: {} })
  assert.strictEqual(await mod.hasNewerTaskOrConv(U, P, B, new Date(MSG)), false)
})

test('une tache de classification (quel que soit son statut) apres le message vaut traitement', async () => {
  const tables = { conversations: [], agent_tasks: [
    { id: 't1', user_id: U, book_id: B, property_id: P, task_type: 'info_unknown', status: 'ignored', created_at: APRES }
  ] }
  const { mod } = charger({ tables, journal: [], messagesChannex: [], reponseIA: {} })
  assert.strictEqual(await mod.hasNewerTaskOrConv(U, P, B, new Date(MSG)), true)
})

// ─── Le chemin Channex de bout en bout ──────────────────────────────────────
test('LE TEST QUI COMPTE : le scenario du 20 septembre — message + echo → l\'IA est appelee et une tache nait', async () => {
  const tables = {
    knowledge: [{ user_id: U, property_id: P, type: 'faq', key: 'Regles', value: 'Animaux non acceptes' }],
    bookings_snapshot: [{ property_id: P, booking_id: B, snapshot: { firstName: 'Thierry', arrival: '2026-12-01', departure: '2026-12-02', source: 'Offline' } }],
    conversations: [
      { id: 'c1', user_id: U, book_id: B, property_id: P, agent_reply: null, created_at: APRES, guest_message: 'je peux venir avec mon chien ?' }
    ],
    agent_tasks: [], agent_prompting: []
  }
  const messagesChannex = [
    { bookingId: B, sender: 'guest', message: 'je peux venir avec mon chien ?', time: MSG }
  ]
  const { mod, appelsIA } = charger({ tables, journal: [], messagesChannex,
    reponseIA: { type: 'info_known', reason: 'animaux refuses', auto_reply: 'Non, les animaux ne sont pas acceptes.', sub_tasks: [] } })
  const results = { totalMessages: 0, totalTasks: 0, totalAutoReplies: 0, errors: [], properties: [] }
  await mod.processChannelPropertyMessages(U, { id: P, name: 'Le 23', provider: 'channex' }, results)
  assert.strictEqual(appelsIA.length, 1, 'le fil est classifie, l\'echo ne le fait plus taire')
  // Mode test (stub getPropertyMode) : la reponse devient une proposition a valider.
  const taches = tables.agent_tasks
  assert.strictEqual(taches.length, 1)
  assert.strictEqual(taches[0].status, 'pending_validation')
  assert.strictEqual(taches[0].suggested_reply, 'Non, les animaux ne sont pas acceptes.')
  assert.deepStrictEqual(results.errors, [])
})

test('un fil deja repondu apres le dernier message du voyageur reste muet', async () => {
  const tables = {
    knowledge: [], bookings_snapshot: [], agent_tasks: [], agent_prompting: [],
    conversations: [
      { id: 'c1', user_id: U, book_id: B, property_id: P, agent_reply: null, created_at: APRES },
      { id: 'c2', user_id: U, book_id: B, property_id: P, agent_reply: 'reponse de l\'hote', created_at: APRES }
    ]
  }
  const messagesChannex = [{ bookingId: B, sender: 'guest', message: 'question', time: MSG }]
  const { mod, appelsIA } = charger({ tables, journal: [], messagesChannex, reponseIA: {} })
  const results = { totalMessages: 0, totalTasks: 0, totalAutoReplies: 0, errors: [], properties: [] }
  await mod.processChannelPropertyMessages(U, { id: P, name: 'Le 23', provider: 'channex' }, results)
  assert.strictEqual(appelsIA.length, 0)
})

// ─── La borne de reprise ────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : le passe est ferme — un message anterieur a la borne n\'est jamais classifie', async () => {
  const { mod, appelsIA } = charger({
    tables: { knowledge: [], bookings_snapshot: [], conversations: [], agent_tasks: [], agent_prompting: [] },
    journal: [], reponseIA: {},
    messagesChannex: [{ bookingId: B, sender: 'guest', message: 'je peux venir avec mon chien ?',
      time: new Date(mod0().REPRISE_DEPUIS.getTime() - 1000).toISOString() }]
  })
  const results = { totalMessages: 0, totalTasks: 0, totalAutoReplies: 0, errors: [], properties: [] }
  await mod.processChannelPropertyMessages(U, { id: P, name: 'Le 23', provider: 'channex' }, results)
  assert.strictEqual(appelsIA.length, 0, 'aucune reponse IA tardive sur un fil d\'avant le deploiement')
  // Ecarte, mais COMPTE : un fil ignore en silence est le defaut d'origine.
  assert.strictEqual(results.avantReprise, 1, 'l\'ecart est visible dans le bilan du cycle')
})

test('la borne est une vraie date, deja passee, et posterieure au message du 20 septembre 23:02', () => {
  const borne = mod0().REPRISE_DEPUIS
  assert.ok(Number.isFinite(borne.getTime()), 'une date invalide ne comparerait jamais : la borne serait muette')
  assert.ok(borne.getTime() <= Date.now(), 'une borne future ecarterait des messages neufs')
  assert.ok(borne > new Date('2026-09-20T21:02:35Z'), 'le message de l\'incident est traite a la main, pas par l\'agent')
})

// Charge le module une fois, sans scenario, pour lire sa constante.
function mod0 () {
  return charger({ tables: {}, journal: [], messagesChannex: [], reponseIA: {} }).mod
}
