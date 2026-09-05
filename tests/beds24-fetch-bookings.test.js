// tests/beds24-fetch-bookings.test.js
// Lancement : npm test  (node --test, aucune dependance externe)
//
// Couvre les deux defauts de fetch corriges dans lib/cron-beds24.js :
//   1. GET /bookings EXCLUT les annulations sans le dire -> une reservation
//      annulee disparaissait du fetch et son snapshot restait `confirmed`.
//   2. fetchBookingsHistory ne lisait que la premiere page (plafond API : 100).
//
// L'API Beds24 est mockee par global.fetch : ces tests ne sortent jamais.

const test = require('node:test')
const assert = require('node:assert')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'

const { fetchBookings, fetchBookingsHistory } = require('../lib/cron-beds24')

// Capture les URL appelees et rend les pages fournies, dans l'ordre.
function mockFetch(pages) {
  const urls = []
  const vraiFetch = global.fetch
  let i = 0
  global.fetch = async (url) => {
    urls.push(String(url))
    const body = pages[Math.min(i++, pages.length - 1)]
    return { json: async () => body }
  }
  return { urls, restore: () => { global.fetch = vraiFetch } }
}

const resa = (id, extra = {}) => ({ id, propertyId: 12345, status: 'new', arrival: '2026-09-10', ...extra })

// ─── 1. Les annulations ──────────────────────────────────────────────────────

test('fetchBookings : par defaut, AUCUN statut demande (comportement historique)', async () => {
  const m = mockFetch([{ success: true, data: [resa(1)] }])
  try {
    await fetchBookings('tok', 12345)
    assert.ok(!m.urls[0].includes('status='), 'aucun filtre de statut ajoute sans opt-in')
  } finally { m.restore() }
})

test('fetchBookings : includeCancelled demande les SIX statuts, cancelled compris', async () => {
  const m = mockFetch([{ success: true, data: [resa(1)] }])
  try {
    await fetchBookings('tok', 12345, { includeCancelled: true })
    const url = m.urls[0]
    for (const s of ['new', 'confirmed', 'request', 'inquiry', 'black', 'cancelled']) {
      assert.ok(url.includes(`status=${s}`), `statut ${s} demande`)
    }
  } finally { m.restore() }
})

test('fetchBookings : une annulee est bien RENDUE quand on la demande', async () => {
  // Cas reel : booking 92209790, annule, arrivee le 12 septembre. Sans l'option,
  // l'API ne le renvoie pas et le writer ne voit jamais l'annulation.
  const m = mockFetch([{ success: true, data: [resa(92209790, { status: 'cancelled' }), resa(1)] }])
  try {
    const out = await fetchBookings('tok', 12345, { includeCancelled: true })
    assert.strictEqual(out.length, 2)
    assert.ok(out.some(b => b.id === 92209790 && b.status === 'cancelled'))
  } finally { m.restore() }
})

test('fetchBookings : le filtre par bien reste applique (Beds24 ignore propId)', async () => {
  const m = mockFetch([{ success: true, data: [resa(1), { id: 2, propertyId: 99999, status: 'new' }] }])
  try {
    const out = await fetchBookings('tok', 12345, { includeCancelled: true })
    assert.deepStrictEqual(out.map(b => b.id), [1])
  } finally { m.restore() }
})

test('fetchBookings : la fenetre de dates est toujours posee', async () => {
  const m = mockFetch([{ success: true, data: [] }])
  try {
    await fetchBookings('tok', 12345, { daysBefore: 1, daysAfter: 90 })
    assert.ok(/arrivalFrom=\d{4}-\d{2}-\d{2}/.test(m.urls[0]))
    assert.ok(/arrivalTo=\d{4}-\d{2}-\d{2}/.test(m.urls[0]))
  } finally { m.restore() }
})

// ─── 2. La pagination de l'historique ───────────────────────────────────────

test('fetchBookingsHistory : suit nextPageExists et concatene les pages', async () => {
  const m = mockFetch([
    { success: true, data: [resa(1), resa(2)], pages: { nextPageExists: true } },
    { success: true, data: [resa(3)],          pages: { nextPageExists: true } },
    { success: true, data: [resa(4)],          pages: { nextPageExists: false } }
  ])
  try {
    const out = await fetchBookingsHistory('tok', 12345, 6)
    assert.deepStrictEqual(out.map(b => b.id), [1, 2, 3, 4], 'les 3 pages sont lues')
    assert.strictEqual(m.urls.length, 3)
    assert.ok(m.urls[0].includes('page=1') && m.urls[2].includes('page=3'))
  } finally { m.restore() }
})

test('fetchBookingsHistory : une seule page -> un seul appel', async () => {
  const m = mockFetch([{ success: true, data: [resa(1)], pages: { nextPageExists: false } }])
  try {
    const out = await fetchBookingsHistory('tok', 12345, 6)
    assert.strictEqual(out.length, 1)
    assert.strictEqual(m.urls.length, 1, 'pas d\'appel inutile')
  } finally { m.restore() }
})

test('fetchBookingsHistory : reponse sans bloc pages -> on s\'arrete (pas de boucle)', async () => {
  const m = mockFetch([{ success: true, data: [resa(1)] }])
  try {
    const out = await fetchBookingsHistory('tok', 12345, 6)
    assert.strictEqual(out.length, 1)
    assert.strictEqual(m.urls.length, 1)
  } finally { m.restore() }
})

test('fetchBookingsHistory : le plafond de pages borne le cout, sans boucle infinie', async () => {
  // L'API pretend toujours qu'une page suivante existe. Le plafond est bas
  // volontairement : ce fetch tourne a chaque cycle */5, par bien, et chaque page
  // coute 1,5 credit + un appel HTTP en serie dans un cycle deja pres du plafond
  // Vercel. 5 pages = 500 reservations sur six mois, tres au-dela du besoin reel.
  const m = mockFetch([{ success: true, data: [resa(1)], pages: { nextPageExists: true } }])
  try {
    const out = await fetchBookingsHistory('tok', 12345, 6)
    assert.strictEqual(m.urls.length, 5, 'plafond a 5 pages')
    assert.strictEqual(out.length, 5)
  } finally { m.restore() }
})

test('fetchBookingsHistory : un echec en cours de pagination rend les pages deja lues', async () => {
  const m = mockFetch([
    { success: true, data: [resa(1)], pages: { nextPageExists: true } },
    { success: false, errors: 'token expired' }
  ])
  try {
    const out = await fetchBookingsHistory('tok', 12345, 6)
    assert.deepStrictEqual(out.map(b => b.id), [1], 'ce qui est lu n\'est pas perdu')
  } finally { m.restore() }
})

test('fetchBookingsHistory : les annulations restent HORS de l\'historique de classification', async () => {
  const m = mockFetch([{ success: true, data: [resa(1)], pages: { nextPageExists: false } }])
  try {
    await fetchBookingsHistory('tok', 12345, 6)
    assert.ok(!m.urls[0].includes('status='), 'la classification rattache des sejours reels')
  } finally { m.restore() }
})

// ─── Les erreurs API ne passent pas en silence ──────────────────────────────

test('fetchBookings : une erreur API est LOGGEE, pas avalee', async () => {
  // Sans cela, detectBookingChanges passe une liste vide au writer : plus aucun
  // snapshot mis a jour, plus aucun changement detecte, et rien dans les logs.
  // D'autant plus important qu'on vient d'ajouter six parametres `status` a l'URL.
  const m = mockFetch([{ success: false, errors: 'invalid status parameter' }])
  const erreurs = []
  const vraiErr = console.error
  console.error = (...a) => erreurs.push(a.join(' '))
  try {
    const out = await fetchBookings('tok', 12345, { includeCancelled: true })
    assert.deepStrictEqual(out, [], 'fail-safe : le cron continue')
    assert.strictEqual(erreurs.length, 1, 'mais l\'echec est dit')
    assert.ok(erreurs[0].includes('fetchBookings') && erreurs[0].includes('12345'))
  } finally { console.error = vraiErr; m.restore() }
})

test('fetchBookingsHistory : un echec ne se deguise PAS en « plafond atteint »', async () => {
  // Deux troncatures differentes, deux messages differents : un warn « plafond »
  // sur un token expire envoie le diagnostic dans la mauvaise direction.
  const m = mockFetch([
    { success: true, data: [resa(1)], pages: { nextPageExists: true } },
    { success: false, errors: 'token expired' }
  ])
  const logs = []
  const vraiErr = console.error, vraiWarn = console.warn
  console.error = (...a) => logs.push('ERR ' + a.join(' '))
  console.warn  = (...a) => logs.push('WARN ' + a.join(' '))
  try {
    const out = await fetchBookingsHistory('tok', 12345, 6)
    assert.deepStrictEqual(out.map(b => b.id), [1])
    assert.strictEqual(logs.length, 1, 'un seul message, pas deux')
    assert.ok(logs[0].startsWith('ERR '), 'une erreur, pas un warn de plafond')
    assert.ok(!logs[0].includes('plafond'), 'ne parle pas de plafond')
  } finally { console.error = vraiErr; console.warn = vraiWarn; m.restore() }
})
