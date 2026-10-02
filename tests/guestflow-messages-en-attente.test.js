// tests/guestflow-messages-en-attente.test.js
// Audit GuestFlow du 2 octobre 2026 — lot 1.
//
// Ce que la production a montre (60 jours, 103 reponses envoyees) :
//   - « où est la télécommande ? » puis « Merci beaucoup » → 🙏. Le prompt ne
//     portait que le DERNIER message ; la question etait perdue.
//   - « ?? » → 👍 ; une prolongation suivie de « je paierai avant 13h » → 👍.
//   - deux plaintes de depart sans aucune trace : une sortie IA illisible
//     faisait `return false`, sans tache, et le fil repassait a l'IA a chaque tick.
//   - 5 voyageurs etrangers ont recu du francais : aucune regle de langue.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'cle-test'

const test = require('node:test')
const assert = require('node:assert')

function fakeSupabase (tables) {
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
function charger ({ tables, messagesChannex, contenuIA, mode = 'test', messagesBeds24 = [] }) {
  const appelsIA = []; const alertes = []
  const anthropic = { messages: { create: async (req) => { appelsIA.push(req); return { content: contenuIA } } } }
  const stubs = {
    '../lib/cron-shared': {
      supabase: fakeSupabase(tables), anthropic,
      getPropertyMode: async () => mode, isAutomationPaused: async () => false,
      getSignatureForKey: () => '', SENDVIABEDS24_ENABLED: false
    },
    '../lib/cron-beds24': { fetchMessages: async () => messagesBeds24, fetchBookingsHistory: async () => [] },
    '../lib/alert-notify': { sendAlertNotifications: async (a) => { alertes.push(a) } },
    '../lib/record-message': { recordMessage: async () => ({ ok: true }) },
    '../lib/cles-migrees': { estCleMigree: async () => false },
    '../lib/channels': { getProvider: () => ({ getPropertyMessages: async () => messagesChannex,
      syncMessages: async () => {}, syncBookings: async () => {} }) }
  }
  const cible = require.resolve('../lib/cron-classify')
  delete require.cache[cible]
  for (const [k, ex] of Object.entries(stubs)) {
    const c = require.resolve(k)
    require.cache[c] = { id: c, filename: c, loaded: true, exports: ex }
  }
  const mod = require('../lib/cron-classify')
  delete require.cache[cible]
  return { mod, appelsIA, alertes }
}

const U = 'user-1', P = 'prop-uuid-1', B = 'booking-1'
// Temps injecte, pose par rapport a la borne de reprise du module.
const BORNE = charger({ tables: {}, messagesChannex: [], contenuIA: [] }).mod.REPRISE_DEPUIS.getTime()
const t = (min) => new Date(BORNE + 3600e3 + min * 60e3).toISOString()
const json = (o) => [{ type: 'text', text: JSON.stringify(o) }]
const tablesVides = () => ({ knowledge: [], bookings_snapshot: [], conversations: [], agent_tasks: [], agent_prompting: [] })
const nouveauBilan = () => ({ totalMessages: 0, totalTasks: 0, totalAutoReplies: 0, errors: [], properties: [] })
const bien = { id: P, name: 'La bulle', provider: 'channex' }

test('LE TEST QUI COMPTE : la question suivie d\'un « merci » est dans le prompt, pas seulement le merci', async () => {
  const messages = [
    { bookingId: B, sender: 'host', message: 'Voici vos codes.', time: t(0) },
    { bookingId: B, sender: 'guest', message: 'Où se situe la télécommande de la télévision ?', time: t(1) },
    { bookingId: B, sender: 'guest', message: 'Merci beaucoup', time: t(2) }
  ]
  const { mod, appelsIA } = charger({ tables: tablesVides(), messagesChannex: messages,
    contenuIA: json({ type: 'info_unknown', reason: 'x', auto_reply: null, sub_tasks: [] }) })
  await mod.processChannelPropertyMessages(U, bien, nouveauBilan())
  const prompt = appelsIA[0].messages[0].content
  const bloc = prompt.split('MESSAGES EN ATTENTE (à traiter ensemble) :')[1]
  assert.ok(bloc, 'le bloc des messages en attente existe')
  assert.ok(bloc.includes('télécommande'), 'la question est a traiter')
  assert.ok(bloc.includes('Merci beaucoup'), 'le merci aussi')
  assert.ok(!bloc.includes('Voici vos codes'), 'la reponse de l\'hote n\'est pas « en attente »')
})

test('LE TEST QUI COMPTE : un emoji propose sur une question en attente devient une tache, pas un envoi', async () => {
  const tables = tablesVides()
  const messages = [
    { bookingId: B, sender: 'guest', message: 'Je peux arriver vers 16h ?', time: t(1) },
    { bookingId: B, sender: 'guest', message: '??', time: t(30) }
  ]
  const { mod } = charger({ tables, messagesChannex: messages, mode: 'auto',
    contenuIA: json({ type: 'sympathy', reason: 'accuse', auto_reply: '👍', sub_tasks: [] }) })
  await mod.processChannelPropertyMessages(U, bien, nouveauBilan())
  assert.strictEqual(tables.agent_tasks.length, 1)
  assert.strictEqual(tables.agent_tasks[0].task_type, 'info_unknown')
  assert.strictEqual(tables.agent_tasks[0].status, 'pending')
  assert.ok(tables.agent_tasks[0].guest_message.includes('16h'), 'l\'hote lit toute l\'attente')
  assert.ok(!tables.conversations.some(c => c.agent_reply), 'rien n\'est parti au voyageur')
})

test('un pur accuse de reception garde son emoji', async () => {
  const tables = tablesVides()
  const messages = [{ bookingId: B, sender: 'guest', message: 'Bien reçu, merci !', time: t(1) }]
  const { mod } = charger({ tables, messagesChannex: messages,
    contenuIA: json({ type: 'sympathy', reason: 'accuse', auto_reply: '👍', sub_tasks: [] }) })
  await mod.processChannelPropertyMessages(U, bien, nouveauBilan())
  assert.strictEqual(tables.agent_tasks.length, 1)
  assert.strictEqual(tables.agent_tasks[0].status, 'pending_validation')
  assert.strictEqual(tables.agent_tasks[0].suggested_reply, '👍')
})

test('LE TEST QUI COMPTE : une sortie illisible devient une tache, et le fil ne repart pas a l\'IA', async () => {
  const tables = tablesVides()
  const messages = [{ bookingId: B, sender: 'guest', message: 'La literie sentait la transpiration.', time: t(1) }]
  const { mod, appelsIA } = charger({ tables, messagesChannex: messages,
    contenuIA: [{ type: 'text', text: 'Je pense que ce message est une plainte.' }] })
  const bilan = nouveauBilan()
  await mod.processChannelPropertyMessages(U, bien, bilan)
  assert.strictEqual(tables.agent_tasks.length, 1, 'le message ne disparait pas')
  assert.strictEqual(tables.agent_tasks[0].task_type, 'info_unknown')
  assert.ok(bilan.errors.some(e => e.context === 'classification_illisible'), 'et l\'echec se voit dans le bilan')
  await mod.processChannelPropertyMessages(U, bien, nouveauBilan())
  assert.strictEqual(appelsIA.length, 1, 'tick suivant : la tache ferme la garde, pas de second appel facture')
})

test('un type hors liste est traite comme une sortie illisible', async () => {
  const tables = tablesVides()
  const messages = [{ bookingId: B, sender: 'guest', message: 'Bonjour', time: t(1) }]
  const { mod } = charger({ tables, messagesChannex: messages,
    contenuIA: json({ type: 'autre', reason: 'x', auto_reply: 'Bonjour !', sub_tasks: [] }) })
  await mod.processChannelPropertyMessages(U, bien, nouveauBilan())
  assert.strictEqual(tables.agent_tasks.length, 1)
  assert.strictEqual(tables.agent_tasks[0].task_type, 'info_unknown')
})

test('le texte est lu dans le premier bloc `text`, meme apres un bloc thinking', async () => {
  const tables = tablesVides()
  const messages = [{ bookingId: B, sender: 'guest', message: 'Bien arrivés !', time: t(1) }]
  const { mod } = charger({ tables, messagesChannex: messages, contenuIA: [
    { type: 'thinking', thinking: '' },
    { type: 'text', text: 'Voici : ```json\n' + JSON.stringify({ type: 'sympathy', reason: 'x', auto_reply: '😊', sub_tasks: [] }) + '\n```' }
  ] })
  await mod.processChannelPropertyMessages(U, bien, nouveauBilan())
  assert.strictEqual(tables.agent_tasks[0].task_type, 'sympathy')
  assert.strictEqual(tables.agent_tasks[0].suggested_reply, '😊')
})

test('le prompt porte la regle de langue et ne contredit plus les consignes de l\'hote', async () => {
  const messages = [{ bookingId: B, sender: 'guest', message: 'Is there a parking?', time: t(1) }]
  const { mod, appelsIA } = charger({ tables: tablesVides(), messagesChannex: messages,
    contenuIA: json({ type: 'info_unknown', reason: 'x', auto_reply: null, sub_tasks: [] }) })
  await mod.processChannelPropertyMessages(U, bien, nouveauBilan())
  const prompt = appelsIA[0].messages[0].content
  assert.ok(/Réponds dans la langue des messages en attente/.test(prompt))
  assert.ok(!/Tutoie sauf si/.test(prompt), 'le tutoiement par defaut contredisait « Vouvoiement systématique »')
  assert.ok(/prolongation/.test(prompt) && /signalement/.test(prompt), 'les escalades obligatoires sont ecrites')
})


test('rien n\'attend apres la reponse de l\'hote (puis un message system Beds24) : aucun appel IA', async () => {
  const tables = tablesVides()
  const { mod, appelsIA } = charger({ tables, messagesChannex: [], contenuIA: json({ type: 'sympathy', reason: 'x', auto_reply: '👍', sub_tasks: [] }) })
  const fil = [
    { source: 'guest', message: 'Le linge est fourni ?', time: t(1) },
    { source: 'host', message: 'Oui, tout est fourni.', time: t(2) },
    { source: 'system', message: 'Booking modified', time: t(3) }
  ]
  const r = await mod.classifyAndHandle(U, 'cle', bien, B, 'Alex', '', '', '', fil, '', nouveauBilan())
  assert.strictEqual(r, false)
  assert.strictEqual(appelsIA.length, 0, 'une question deja repondue n\'est pas « en attente »')
  assert.strictEqual(tables.agent_tasks.length, 0)
})

test('un message system Beds24 ne clot pas l\'attente', async () => {
  const { mod, appelsIA } = charger({ tables: tablesVides(), messagesChannex: [],
    contenuIA: json({ type: 'info_unknown', reason: 'x', auto_reply: null, sub_tasks: [] }) })
  const fil = [
    { source: 'guest', message: 'Peut-on arriver à 14h ?', time: t(1) },
    { source: 'system', message: 'Booking modified', time: t(2) },
    { source: 'guest', message: 'Merci', time: t(3) }
  ]
  await mod.classifyAndHandle(U, 'cle', bien, B, 'Alex', '', '', '', fil, '', nouveauBilan())
  const bloc = appelsIA[0].messages[0].content.split('MESSAGES EN ATTENTE (à traiter ensemble) :')[1]
  assert.ok(bloc.includes('14h') && bloc.includes('Merci'))
})

// ─── M1 : anti-rejeu ────────────────────────────────────────────────────────
const tache = (o) => ({ id: 'T' + Math.random(), user_id: U, property_id: P, book_id: B, sub_tasks: [], ...o })

test('LE TEST QUI COMPTE : escalade en attente + nouveau message → UN appel, puis plus aucun ; l\'hote lit tout et est realerte', async () => {
  const tables = tablesVides()
  tables.agent_tasks.push(tache({ task_type: 'info_unknown', status: 'pending', guest_message: 'Le linge est fourni ?', created_at: t(2) }))
  const messages = [
    { bookingId: B, sender: 'guest', message: 'Le linge est fourni ?', time: t(1) },
    { bookingId: B, sender: 'guest', message: 'Et les serviettes ?', time: t(10) }
  ]
  const { mod, appelsIA, alertes } = charger({ tables, messagesChannex: messages,
    contenuIA: json({ type: 'info_unknown', reason: 'linge et serviettes', auto_reply: null, sub_tasks: [] }) })
  for (let i = 0; i < 3; i++) await mod.processChannelPropertyMessages(U, bien, nouveauBilan())
  assert.strictEqual(appelsIA.length, 1, 'un appel pour le nouveau message, pas un par tick')
  assert.strictEqual(tables.agent_tasks.length, 1, 'meme type : la tache est completee, pas doublee')
  assert.ok(tables.agent_tasks[0].guest_message.includes('serviettes'), 'le nouveau message est visible de l\'hote')
  assert.ok(tables.agent_tasks[0].guest_message.includes('linge'), 'sans perdre l\'ancien')
  assert.strictEqual(alertes.length, 1, 'l\'hote est realerte une fois')
})

test('LE TEST QUI COMPTE : un signalement urgent apres une escalade ouverte est classe, a sa tache, et alerte', async () => {
  // Constat de review : la premiere version de l'anti-rejeu ecrasait le nouveau
  // message dans l'ancienne tache, sans IA ni alerte — la fuite d'eau etait noyee.
  const tables = tablesVides()
  tables.agent_tasks.push(tache({ task_type: 'info_unknown', status: 'pending', guest_message: 'Le linge est fourni ?', created_at: t(2) }))
  const messages = [
    { bookingId: B, sender: 'guest', message: 'Le linge est fourni ?', time: t(1) },
    { bookingId: B, sender: 'guest', message: 'Fuite d\'eau sous l\'évier !', time: t(2000) }
  ]
  const { mod, appelsIA, alertes } = charger({ tables, messagesChannex: messages,
    contenuIA: json({ type: 'intervention', reason: 'fuite', auto_reply: null, sub_tasks: [] }) })
  await mod.processChannelPropertyMessages(U, bien, nouveauBilan())
  await mod.processChannelPropertyMessages(U, bien, nouveauBilan())
  assert.strictEqual(appelsIA.length, 1)
  const inter = tables.agent_tasks.filter(x => x.task_type === 'intervention')
  assert.strictEqual(inter.length, 1, 'le signalement a sa propre tache')
  assert.ok(inter[0].guest_message.includes('Fuite'))
  assert.strictEqual(alertes.length, 1)
  assert.strictEqual(alertes[0].type, 'intervention')
})

test('une proposition Mode Test perimee est ecartee, remplacee par UN seul appel', async () => {
  const tables = tablesVides()
  tables.agent_tasks.push(tache({ task_type: 'sympathy', status: 'pending_validation', suggested_reply: '👍', guest_message: 'Merci !', created_at: t(2) }))
  const messages = [
    { bookingId: B, sender: 'guest', message: 'Merci !', time: t(1) },
    { bookingId: B, sender: 'guest', message: 'Où est la télécommande ?', time: t(10) }
  ]
  const { mod, appelsIA } = charger({ tables, messagesChannex: messages,
    contenuIA: json({ type: 'info_unknown', reason: 'x', auto_reply: null, sub_tasks: [] }) })
  await mod.processChannelPropertyMessages(U, bien, nouveauBilan())
  await mod.processChannelPropertyMessages(U, bien, nouveauBilan())
  assert.strictEqual(appelsIA.length, 1, 'un appel pour le nouveau message, pas un par tick')
  assert.strictEqual(tables.agent_tasks[0].status, 'ignored', 'le 👍 perime ne peut plus etre valide')
  const actives = tables.agent_tasks.filter(x => ['pending', 'pending_validation'].includes(x.status))
  assert.strictEqual(actives.length, 1)
  assert.strictEqual(actives[0].task_type, 'info_unknown')
})

test('une escalade d\'un lot DEJA repondu par l\'hote ne bloque pas la tache du nouveau lot', async () => {
  const tables = tablesVides()
  tables.agent_tasks.push(tache({ task_type: 'info_unknown', status: 'pending', guest_message: 'Le linge ?', created_at: t(2) }))
  const messages = [
    { bookingId: B, sender: 'guest', message: 'Le linge ?', time: t(1) },
    { bookingId: B, sender: 'host', message: 'Oui, fourni.', time: t(5) },
    { bookingId: B, sender: 'guest', message: 'Peut-on partir à 14h ?', time: t(10) }
  ]
  const { mod, appelsIA } = charger({ tables, messagesChannex: messages,
    contenuIA: json({ type: 'info_unknown', reason: 'x', auto_reply: null, sub_tasks: [] }) })
  await mod.processChannelPropertyMessages(U, bien, nouveauBilan())
  await mod.processChannelPropertyMessages(U, bien, nouveauBilan())
  assert.strictEqual(appelsIA.length, 1, 'un appel, puis la nouvelle tache ferme la garde')
  assert.strictEqual(tables.agent_tasks.length, 2, 'la nouvelle question a sa tache')
  assert.ok(tables.agent_tasks[1].guest_message.includes('14h'))
  assert.strictEqual(tables.agent_tasks[0].guest_message, 'Le linge ?', 'l\'ancienne tache n\'est pas touchee')
})

// ─── M2 : un modele automatique n'est pas une reponse ───────────────────────
test('LE TEST QUI COMPTE : une question suivie d\'un modele automatique reste en attente et est traitee', async () => {
  const messages = [
    { bookingId: B, sender: 'guest', message: 'Peut-on arriver à 15h ?', time: t(1) },
    { bookingId: B, sender: 'auto', message: 'Rappel : arrivée à partir de 18h.', time: t(2) }
  ]
  const { mod, appelsIA } = charger({ tables: tablesVides(), messagesChannex: messages,
    contenuIA: json({ type: 'intervention', reason: 'x', auto_reply: null, sub_tasks: [] }) })
  await mod.processChannelPropertyMessages(U, bien, nouveauBilan())
  assert.strictEqual(appelsIA.length, 1, 'avant : le dernier message `host` (le modele) faisait taire le fil')
  const bloc = appelsIA[0].messages[0].content.split('MESSAGES EN ATTENTE (à traiter ensemble) :')[1]
  assert.ok(bloc.includes('15h'), 'la question est en attente')
})

test('une reponse de l\'agent (`ai`) vaut reponse : le fil se tait', async () => {
  const messages = [
    { bookingId: B, sender: 'guest', message: 'Merci !', time: t(1) },
    { bookingId: B, sender: 'ai', message: '👍', time: t(2) }
  ]
  const { mod, appelsIA } = charger({ tables: tablesVides(), messagesChannex: messages, contenuIA: [] })
  await mod.processChannelPropertyMessages(U, bien, nouveauBilan())
  assert.strictEqual(appelsIA.length, 0)
})

test('LE TEST QUI COMPTE : Beds24 — un modele parti de chez nous (signe GuestFlow) n\'est pas une reponse de l\'hote', async () => {
  // L'API Beds24 rend tout message sortant en `host`. Le cœur sait qu'il
  // vient d'un modele : on rapproche par reservation et par texte, signature otee.
  const tables = tablesVides()
  tables.messages = [{ user_id: U, property_id: '209', booking_id: '777', direction: 'outbound', sender: 'auto',
    body: 'Rappel : arrivée à partir de 18h.', created_at: t(2) }]
  const messagesBeds24 = [
    { bookingId: '777', source: 'guest', message: 'Peut-on arriver à 15h ?', time: t(1) },
    { bookingId: '777', source: 'host', message: 'Rappel :  arrivée à partir de 18h.\n\n— propulsé par GuestFlow', time: t(2) }
  ]
  const { mod, appelsIA } = charger({ tables, messagesChannex: [], messagesBeds24,
    contenuIA: json({ type: 'intervention', reason: 'x', auto_reply: null, sub_tasks: [] }) })
  await mod.processProperty(U, 'cle', { id: '209', name: 'Bien Beds24' }, nouveauBilan())
  assert.strictEqual(appelsIA.length, 1, 'la question n\'est pas tue par le modele')
  assert.ok(appelsIA[0].messages[0].content.includes('Message automatique (modèle)'))
})

test('Beds24 — une vraie reponse de l\'hote (absente du cœur) fait toujours taire le fil', async () => {
  const tables = tablesVides(); tables.messages = []
  const messagesBeds24 = [
    { bookingId: '777', source: 'guest', message: 'Peut-on arriver à 15h ?', time: t(1) },
    { bookingId: '777', source: 'host', message: 'Oui, sans souci.', time: t(2) }
  ]
  const { mod, appelsIA } = charger({ tables, messagesChannex: [], messagesBeds24, contenuIA: [] })
  await mod.processProperty(U, 'cle', { id: '209', name: 'Bien Beds24' }, nouveauBilan())
  assert.strictEqual(appelsIA.length, 0)
})

test('LE TEST QUI COMPTE : Mode Auto — la conversation [AUTO:] ecrite par le modele ne fait pas taire la question', async () => {
  // Constat de review (bloquant) : en Mode Auto, chaque modele envoye ecrit une
  // ligne `conversations` [AUTO: …] AVEC agent_reply. `hasNewerTaskOrConv` la
  // prenait pour une reponse : le correctif M2 ne servait a rien en auto.
  const tables = tablesVides()
  tables.conversations.push({ id: 'c1', user_id: U, property_id: P, book_id: B,
    guest_message: '[AUTO: j-1]', agent_reply: 'Rappel : arrivée à partir de 18h.', created_at: t(2) })
  const messages = [
    { bookingId: B, sender: 'guest', message: 'Peut-on arriver à 15h ?', time: t(1) },
    { bookingId: B, sender: 'auto', message: 'Rappel : arrivée à partir de 18h.', time: t(2) }
  ]
  const { mod, appelsIA } = charger({ tables, messagesChannex: messages,
    contenuIA: json({ type: 'intervention', reason: 'x', auto_reply: null, sub_tasks: [] }) })
  await mod.processChannelPropertyMessages(U, bien, nouveauBilan())
  assert.strictEqual(appelsIA.length, 1)
})

test('une vraie reponse enregistree en conversation fait toujours taire le fil', async () => {
  const tables = tablesVides()
  tables.conversations.push({ id: 'c1', user_id: U, property_id: P, book_id: B,
    guest_message: 'Peut-on arriver à 15h ?', agent_reply: 'Oui !', created_at: t(3) })
  const messages = [{ bookingId: B, sender: 'guest', message: 'Peut-on arriver à 15h ?', time: t(1) }]
  const { mod, appelsIA } = charger({ tables, messagesChannex: messages, contenuIA: [] })
  await mod.processChannelPropertyMessages(U, bien, nouveauBilan())
  assert.strictEqual(appelsIA.length, 0)
})
