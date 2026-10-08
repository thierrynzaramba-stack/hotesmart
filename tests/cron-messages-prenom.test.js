// tests/cron-messages-prenom.test.js — vecu du 8 octobre 2026 : « Bonjour
// {prenom} » est parti a deux voyageurs. L'amelioration par l'IA echouait
// (credit epuise) et le repli rendait le MODELE BRUT, avant substitution.
// Regles (decision de Thierry) : un prenom manquant donne une formule neutre
// (« Bonjour, »), et AUCUNE variable {…} ne part jamais au voyageur.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'cle-test'
const test = require('node:test')
const assert = require('node:assert')

function charger (ia) {
  const incidents = []
  const stub = (m, exports) => { const c = require.resolve(m); require.cache[c] = { id: c, filename: c, loaded: true, exports } }
  stub('../lib/cron-shared', {
    supabase: { from: () => ({}) },
    anthropic: { messages: { create: async () => { if (ia instanceof Error) throw ia; return { content: [{ text: ia }] } } } },
    getPropertyMode: async () => 'auto', isAutomationPaused: async () => false,
    formatDate: d => String(d || ''),
  })
  stub('../lib/founder-notify', { reportIncident: async (type, o) => { incidents.push({ type, ...o }) } })
  delete require.cache[require.resolve('../lib/cron-messages')]
  const mod = require('../lib/cron-messages')
  return { mod, incidents }
}
const credit = Object.assign(new Error('400 Your credit balance is too low'), { status: 400 })
const bien = { id: 'p1', name: 'La bulle' }
const modele = (t) => ({ event_type: 'arrival', template_text: t })

test('LE TEST QUI COMPTE (vecu du 8 octobre) : IA en panne — le texte SUBSTITUE part, jamais le modele brut', async () => {
  const { mod } = charger(credit)
  const m = await mod.generateAutoMessage(modele('Bonjour {prenom}, bienvenue au {logement} !'), { firstName: 'Carole', arrival: '2026-10-08', departure: '2026-10-10' }, bien, 'Carole X', {}, 'u1')
  assert.strictEqual(m, 'Bonjour Carole, bienvenue au La bulle !')
})

test('LE TEST QUI COMPTE : sans prenom, la formule est neutre — « Bonjour, », jamais {prenom} ni « Voyageur »', async () => {
  const { mod } = charger(credit)
  const m = await mod.generateAutoMessage(modele('Bonjour {prenom},\n\nLes codes d’accès vous seront envoyés.'), { firstName: '', arrival: '2026-10-08', departure: '2026-10-10' }, bien, 'Voyageur', {}, 'u1')
  assert.strictEqual(m, 'Bonjour,\n\nLes codes d’accès vous seront envoyés.')
})

test('une variable INCONNUE reste dans le modele : le message est RETENU, et l hote prevenu', async () => {
  const { mod, incidents } = charger('Bonjour Carole')
  const m = await mod.generateAutoMessage(modele('Bonjour {prenom}, votre {parking} est réservé.'), { firstName: 'Carole', arrival: '2026-10-08', departure: '2026-10-10' }, bien, 'Carole', {}, 'u1')
  assert.strictEqual(m, null)
  assert.deepStrictEqual(incidents.map(i => i.type), ['message_non_envoye'])
  assert.match(incidents[0].detail, /\{parking\}/)
})

test('une variable reintroduite par l IA ne part pas : le texte substitue la remplace', async () => {
  const { mod } = charger('Bonjour {prenom} ! Bienvenue.')
  const m = await mod.generateAutoMessage(modele('Bonjour {prenom}, bienvenue.'), { firstName: 'Carole', arrival: '2026-10-08', departure: '2026-10-10' }, bien, 'Carole', {}, 'u1')
  assert.strictEqual(m, 'Bonjour Carole, bienvenue.')
})
