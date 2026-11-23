// tests/code-incertain-traverse.test.js
// Dette 144, review 1, constat 4 : le lot s'appuie sur le drapeau `incertain`
// que posent Channex et Beds24 quand la connexion est coupee PENDANT l'envoi.
// Seul le chemin e-mail etait tenu par un test (canal-routage-envoi) : une
// reecriture qui perdait le drapeau sur le canal principal rouvrait la dette,
// suite verte.
//
// Ici, RIEN n'est double sur le chemin : `sendGuestMessage` (lib/cron-messages),
// `sendMessage` + `channelCall` (lib/channels/channex) et `sendViaBeds24`
// (lib/cron-beds24) sont les vrais. Seul `fetch` est remplace : il LEVE comme
// une socket coupee (undici : `TypeError: fetch failed`, cause ECONNRESET).
// Aucun appel ne sort de la machine.

const test = require('node:test')
const assert = require('node:assert')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'
// Valeurs de TEST, lues au chargement des modules : jamais une vraie cle.
process.env.CHANNEL_BASE_URL = 'https://channel.exemple.test/api/v1'
process.env.CHANNEL_API_KEY = 'cle-de-test'
process.env.CHANNEL_BACKOFF_MS = '0'
process.env.SENDVIABEDS24_ENABLED = 'true'

const fetchOrigine = global.fetch
const appels = []
global.fetch = async (url) => {
  appels.push(String(url))
  const e = new TypeError('fetch failed')
  e.cause = { code: 'ECONNRESET' }
  throw e
}
test.after(() => { global.fetch = fetchOrigine })

const { sendGuestMessage } = require('../lib/cron-messages')

test('LE TEST QUI COMPTE (dette 144) : Channex coupé pendant l envoi — `incertain` traverse sendGuestMessage', async () => {
  appels.length = 0
  const r = await sendGuestMessage(null, { id: 'b1', provider: 'channex', name: 'Bien' },
    { id: 'resa-airbnb', source: 'AirBNB', guestEmail: null }, 'Votre code : 1234',
    { userId: 'U', eventType: 'arrival_code' })
  assert.ok(appels.some(u => u.startsWith('https://channel.exemple.test/api/v1/bookings/resa-airbnb/messages')), appels.join(' | '))
  // Un POST ne se rejoue pas : un seul appel au canal.
  assert.strictEqual(appels.filter(u => u.includes('/bookings/resa-airbnb/messages')).length, 1)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.canal, 'ota')
  assert.strictEqual(r.incertain, true, 'sans lui, la tache redevient « impossible » et l agent dit NON ENVOYÉ')
  assert.notStrictEqual(r.permanent, true)
})

test('LE TEST QUI COMPTE (dette 144) : Beds24 coupé pendant l envoi — `incertain` traverse sendGuestMessage', async () => {
  appels.length = 0
  const r = await sendGuestMessage('cle-beds24-de-test', { id: '209413', provider: 'beds24', name: 'Bien' },
    { id: '12345', channel: 'airbnb', guestEmail: null }, 'Votre code : 1234',
    { userId: 'U', eventType: 'arrival_code' })
  assert.ok(appels.some(u => u === 'https://beds24.com/api/v2/bookings/messages'), appels.join(' | '))
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.canal, 'ota')
  assert.strictEqual(r.incertain, true, 'sans lui, la tache redevient « impossible » et l agent dit NON ENVOYÉ')
})
