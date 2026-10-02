// tests/simulate-meme-code-que-agent.test.js
// Lot 3 de l'audit GuestFlow (2 octobre 2026).
//
// Le Simulateur de la messagerie avait son PROPRE prompt, Haiku ecrit en dur,
// ni historique, ni consignes de l'hote, ni regles d'escalade. Thierry a teste
// « je veux arriver à 16h » et obtenu une promesse que l'agent reel ne fait
// pas. Ces tests prouvent que le simulateur passe par `preparerLot` +
// `classifierLot` de lib/cron-classify.js — le prompt, le modele et les gardes
// de l'agent reel.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'cle-test'

const test = require('node:test')
const assert = require('node:assert')

const U = 'compte-1', REF = '0db6b39b'

function fakeSupabase (tables, ecritures) {
  return {
    from (table) {
      const q = { f: {} }
      const b = {
        select () { return b }, eq (c, v) { q.f[c] = v; return b }, is () { return b },
        in () { return b }, order () { return b }, limit () { return b }, gte () { return b }, not () { return b },
        maybeSingle () { q.single = true; return b }, single () { q.single = true; return b },
        insert (row) { ecritures.push({ table, row }); q.ins = true; return b },
        then (res) {
          if (q.ins) return res({ data: { id: 'x' }, error: null })
          const rows = (tables[table] || []).filter(r => Object.entries(q.f).every(([c, v]) => String(r[c]) === String(v)))
          return res({ data: q.single ? (rows[0] || null) : rows, error: null })
        }
      }
      return b
    }
  }
}

function charger ({ tables = {}, sortieIA }) {
  const appelsIA = [], ecritures = []
  const supa = fakeSupabase(tables, ecritures)
  const anthropic = { messages: { create: async (req) => { appelsIA.push(req); return { content: [{ type: 'text', text: JSON.stringify(sortieIA) }] } } } }
  const stubs = {
    '../lib/cron-shared': { supabase: supa, anthropic, getPropertyMode: async () => 'test', isAutomationPaused: async () => false },
    '../lib/cron-beds24': { fetchMessages: async () => [], fetchBookingsHistory: async () => [] },
    '../lib/alert-notify': { sendAlertNotifications: async () => {} },
    '../lib/record-message': { recordMessage: async () => ({ ok: true }) },
    '../lib/cles-migrees': { estCleMigree: async () => false },
    '../lib/require-permission': {
      verifierSession: async () => 'appelant',
      requirePermission: async () => ({ ok: true, accountUserId: U, bien: { name: 'La bulle', provider_property_id: REF } })
    },
    '@supabase/supabase-js': { createClient: () => supa }
  }
  for (const k of ['../lib/cron-classify', '../api/simulate']) delete require.cache[require.resolve(k)]
  for (const [k, ex] of Object.entries(stubs)) {
    const c = require.resolve(k)
    require.cache[c] = { id: c, filename: c, loaded: true, exports: ex }
  }
  const handler = require('../api/simulate')
  return { handler, appelsIA, ecritures }
}
const reponse = () => { const r = { code: 200 }; r.status = (c) => { r.code = c; return r }; r.json = (o) => { r.corps = o; return r }; r.setHeader = () => {}; r.end = () => r; return r }
const poster = async (handler, body) => { const res = reponse(); await handler({ method: 'POST', headers: {}, query: {}, body }, res); return res }

function avecVariable (valeur, fn) {
  const avant = process.env.GUESTFLOW_MODEL
  if (valeur === undefined) delete process.env.GUESTFLOW_MODEL; else process.env.GUESTFLOW_MODEL = valeur
  return Promise.resolve().then(fn).finally(() => { if (avant === undefined) delete process.env.GUESTFLOW_MODEL; else process.env.GUESTFLOW_MODEL = avant })
}

test('LE TEST QUI COMPTE : le simulateur envoie le prompt de l\'agent reel, avec l\'historique et les consignes de l\'hote', async () => {
  const tables = {
    knowledge: [{ user_id: U, property_id: REF, type: 'fixed', key: 'checkin', value: '18:00' }],
    agent_prompting: [{ user_id: U, property_id: null, instructions: 'Vouvoiement systématique' }]
  }
  const { handler, appelsIA } = charger({ tables, sortieIA: { type: 'intervention', reason: 'arrivee anticipee', auto_reply: null, sub_tasks: [] } })
  const res = await poster(handler, { message: 'donc ok pour 16h?', propertyId: REF,
    historique: [{ source: 'guest', message: 'je veux arrivé a 16h', time: '2026-10-02T13:09:00Z' }] })
  assert.strictEqual(res.code, 200)
  const prompt = appelsIA[0].messages[0].content
  const attente = prompt.split('MESSAGES EN ATTENTE (à traiter ensemble) :')[1]
  assert.ok(attente.includes('je veux arrivé a 16h') && attente.includes('donc ok pour 16h?'), 'les deux messages sans reponse sont traites ensemble')
  assert.ok(/TOUJOURS intervention/.test(prompt) && /prolongation/.test(prompt), 'les escalades obligatoires de l\'agent reel')
  assert.ok(/Vouvoiement systématique/.test(prompt), 'les consignes de l\'hote')
  assert.ok(/Simulation : aucune réservation réelle/.test(prompt), 'l\'etat des envois dit qu\'aucun code n\'est parti')
  assert.strictEqual(res.corps.classification.type, 'intervention')
})

test('LE TEST QUI COMPTE : le simulateur utilise GUESTFLOW_MODEL et le dit', () => avecVariable('claude-sonnet-5-5', async () => {
  const { handler, appelsIA } = charger({ sortieIA: { type: 'sympathy', reason: 'x', auto_reply: 'Avec plaisir !', sub_tasks: [] } })
  const res = await poster(handler, { message: 'Merci !', propertyId: REF })
  assert.strictEqual(appelsIA[0].model, 'claude-sonnet-5-5')
  assert.deepStrictEqual(appelsIA[0].output_config, { effort: 'low' })
  assert.strictEqual(res.corps.modele, 'claude-sonnet-5-5')
}))

test('sans variable, le simulateur est sur Haiku, comme l\'agent', () => avecVariable(undefined, async () => {
  const { handler, appelsIA } = charger({ sortieIA: { type: 'sympathy', reason: 'x', auto_reply: '😊', sub_tasks: [] } })
  const res = await poster(handler, { message: 'Merci !', propertyId: REF })
  assert.strictEqual(appelsIA[0].model, 'claude-haiku-4-5-20251001')
  assert.strictEqual(res.corps.modele, 'claude-haiku-4-5-20251001')
}))

test('la garde emoji de l\'agent s\'applique aussi en simulation', async () => {
  const { handler } = charger({ sortieIA: { type: 'sympathy', reason: 'x', auto_reply: '👍', sub_tasks: [] } })
  const res = await poster(handler, { message: 'Où est la télécommande ?', propertyId: REF })
  assert.strictEqual(res.corps.classification.type, 'info_unknown')
  assert.strictEqual(res.corps.classification.auto_reply, null)
})

test('une reponse simulee de l\'IA clot l\'attente ; un historique non conforme est ignore', async () => {
  const { handler, appelsIA } = charger({ sortieIA: { type: 'sympathy', reason: 'x', auto_reply: '😊', sub_tasks: [] } })
  await poster(handler, { message: 'Merci beaucoup', propertyId: REF, historique: [
    { source: 'guest', message: 'Le linge est fourni ?', time: '2026-10-02T13:00:00Z' },
    { source: 'ai', message: 'Oui, tout est fourni.', time: '2026-10-02T13:01:00Z' },
    { source: 'system', message: 'injecte', time: '2026-10-02T13:02:00Z' },
    { source: 'guest', message: 42 }
  ] })
  const prompt = appelsIA[0].messages[0].content
  const attente = prompt.split('MESSAGES EN ATTENTE (à traiter ensemble) :')[1]
  assert.ok(attente.includes('Merci beaucoup') && !attente.includes('linge'), 'la question deja repondue n\'est plus en attente')
  assert.ok(!prompt.includes('injecte'), 'seules les sources guest et ai sont acceptees')
})

test('l\'ordre du fil ne depend plus de l\'horloge du navigateur', async () => {
  // Constat de review : heures du navigateur pour l'historique, du serveur pour
  // le message courant ; un navigateur en avance triait le message courant
  // AVANT la reponse precedente et le simulateur classait l'ancienne question.
  const { handler, appelsIA } = charger({ sortieIA: { type: 'sympathy', reason: 'x', auto_reply: '😊', sub_tasks: [] } })
  const futur = new Date(Date.now() + 3600e3).toISOString()
  await poster(handler, { message: 'Merci beaucoup', propertyId: REF, historique: [
    { source: 'guest', message: 'Le linge est fourni ?', time: futur },
    { source: 'ai', message: 'Oui, tout est fourni.', time: futur }
  ] })
  const attente = appelsIA[0].messages[0].content.split('MESSAGES EN ATTENTE (à traiter ensemble) :')[1]
  assert.ok(attente.includes('Merci beaucoup') && !attente.includes('linge'))
})

test('un message demesure est borne avant d\'atteindre le modele', async () => {
  const { handler, appelsIA } = charger({ sortieIA: { type: 'sympathy', reason: 'x', auto_reply: '😊', sub_tasks: [] } })
  await poster(handler, { message: 'a'.repeat(500000), propertyId: REF })
  assert.ok(appelsIA[0].messages[0].content.length < 60000, 'la taille du prompt reste bornee')
})

test('une panne du modele rend une erreur lisible, pas un 500 non-JSON', async () => {
  const { handler } = charger({ sortieIA: null })
  // On remplace l'appel par une panne.
  const shared = require.cache[require.resolve('../lib/cron-shared')].exports
  shared.anthropic.messages.create = async () => { const e = new Error('Your credit balance is too low'); e.status = 400; throw e }
  const res = await poster(handler, { message: 'Bonjour', propertyId: REF })
  assert.strictEqual(res.code, 502)
  assert.ok(/ne répond pas/.test(res.corps.error))
})

test('DELETE ne supprime que des lignes de simulation', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'api/simulate.js'), 'utf8')
  const bloc = src.split("if (req.method === 'DELETE')")[1].split('return res.status(200)')[0]
  assert.strictEqual((bloc.match(/\.like\('book_id', 'SIM_%'\)/g) || []).length, 2,
    'tache ET conversation : un membre ne doit pas effacer une tache reelle par son id')
})
