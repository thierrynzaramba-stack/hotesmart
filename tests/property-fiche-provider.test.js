// tests/property-fiche-provider.test.js
// `getPropertyRaw` cote Channex (etape 1B) — les deux defauts trouves en review.
// L'API est mockee par global.fetch : ces tests ne sortent jamais.

const test = require('node:test')
const assert = require('node:assert')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'https://api.exemple'
process.env.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY || 'cle-test'
process.env.CHANNEL_BACKOFF_MS = '1'   // 4 retries en dur sur 5xx : sans ca le test dure 30 s

const channex = require('../lib/channels/channex')

// Chaque appel rend la reponse dictee par la premiere regle qui matche l'URL.
function mock (regles) {
  const urls = []
  const vrai = global.fetch
  global.fetch = async (url) => {
    urls.push(String(url))
    const r = regles.find(x => String(url).includes(x.si))
    if (!r) return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: [] }) }
    return {
      ok: r.status ? r.status < 400 : true,
      status: r.status || 200,
      headers: { get: () => null },          // channelCall lit Retry-After sur erreur
      text: async () => JSON.stringify(r.corps ?? { data: [] })
    }
  }
  return { urls, restore: () => { global.fetch = vrai } }
}

const bien = { data: { id: 'p1', type: 'property', attributes: { title: 'Colomiers' } } }
const lot = (n, prefixe) => ({
  data: Array.from({ length: n }, (_, i) => ({ id: `${prefixe}${i}`, attributes: { title: `${prefixe}${i}` } })),
  meta: { total: n }
})

test('la fiche agrege property + room_types + rate_plans', async () => {
  const m = mock([
    { si: '/properties/', corps: bien },
    { si: '/room_types', corps: lot(1, 'rt') },
    { si: '/rate_plans', corps: lot(5, 'rp') }
  ])
  try {
    const f = await channex.getPropertyRaw({ propertyId: 'p1' })
    assert.strictEqual(f.title, 'Colomiers')
    assert.strictEqual(f.room_types.length, 1)
    assert.strictEqual(f.rate_plans.length, 5)
  } finally { m.restore() }
})

test('AU-DELA DE 10 rate_plans, rien n\'est tronque', async () => {
  // ⚠ LE TEST QUI COMPTE. Channex plafonne a 10 par defaut sans le dire. Un
  // bien qui depasse 10 plans tarifaires — un plan de base plus les derives par
  // canal, c'est vite atteint apres une migration OTA — verrait ses plans
  // coupes SANS que rien ne bouge : empreinte stable, fiche fausse pour
  // toujours. La troncature stable est pire que la bruyante.
  const m = mock([
    { si: '/properties/', corps: bien },
    { si: '/room_types', corps: lot(1, 'rt') },
    { si: '/rate_plans', corps: lot(37, 'rp') }
  ])
  try {
    const f = await channex.getPropertyRaw({ propertyId: 'p1' })
    assert.strictEqual(f.rate_plans.length, 37, 'les 37 plans sont la, pas 10')
    const appel = m.urls.find(u => u.includes('rate_plans'))
    assert.ok(appel.includes('pagination[limit]'), 'la pagination est demandee explicitement')
  } finally { m.restore() }
})

test('une fiche PARTIELLE n\'est jamais rendue : rate_plans en echec -> null', async () => {
  // Sans ca, l'objet ampute passait la garde `payload_vide` du writer et
  // ECRASAIT en base une fiche complete : brut perdu, updated_at qui ment,
  // raw_hash qui oscille d'un passage a l'autre.
  const m = mock([
    { si: '/properties/', corps: bien },
    { si: '/room_types', corps: lot(1, 'rt') },
    { si: '/rate_plans', status: 502, corps: { errors: 'boom' } }
  ])
  try {
    assert.strictEqual(await channex.getPropertyRaw({ propertyId: 'p1' }), null)
  } finally { m.restore() }
})

test('room_types en echec -> null aussi', async () => {
  const m = mock([
    { si: '/properties/', corps: bien },
    { si: '/room_types', status: 500, corps: { errors: 'boom' } },
    { si: '/rate_plans', corps: lot(2, 'rp') }
  ])
  try {
    assert.strictEqual(await channex.getPropertyRaw({ propertyId: 'p1' }), null)
  } finally { m.restore() }
})

test('la propriete elle-meme en echec -> null', async () => {
  const m = mock([{ si: '/properties/', status: 404, corps: { errors: 'inconnu' } }])
  try {
    assert.strictEqual(await channex.getPropertyRaw({ propertyId: 'p1' }), null)
  } finally { m.restore() }
})
