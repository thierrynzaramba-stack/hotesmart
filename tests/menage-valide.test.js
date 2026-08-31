// tests/menage-valide.test.js
// isMenageValidated : trouver le depart PRECEDENT d'un bien.
// Le code d'acces du voyageur suivant n'est envoye qu'apres validation du menage :
// rater ce depart precedent = envoyer le code sans attendre le menage.

// Plusieurs modules de la chaine creent un client Supabase AU CHARGEMENT
// (lib/record-message.js, lib/providers/seam.js). Des valeurs factices suffisent :
// toutes les lectures passent par le double de lib/cron-shared.js.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

function charger({ snapshots = [], tokens = [], statut = null }) {
  const req = { order: null, lte: null, limit: null }
  const table = (nom) => {
    const q = {
      select() { return q }, eq() { return q },
      lte(col, val) { req.lte = { col, val }; return q },
      order(col, opts) { req.order = { col, ...opts }; return q },
      limit(n) { req.limit = n; return Promise.resolve({ data: snapshots }) },
      maybeSingle: async () => ({ data: nom === 'property_status' ? statut : null }),
      then(res, rej) { return Promise.resolve({ data: nom === 'public_tokens' ? tokens : [] }).then(res, rej) }
    }
    return q
  }
  const abs = require.resolve(path.join(__dirname, '..', 'lib/cron-shared.js'))
  const m = new Module(abs)
  m.exports = { supabase: { from: table }, getPropertyMode: async () => 'auto', isAutomationPaused: async () => false }
  m.loaded = true
  require.cache[abs] = m

  delete require.cache[require.resolve('../lib/cron-arrival-code')]
  return { mod: require('../lib/cron-arrival-code'), req }
}

const snap = (departure, o = {}) => ({ snapshot: { provider: 'beds24', status: 'confirmed', departure, ...o } })

test('la requete trie par DATE DE DEPART, pas par updated_at', async () => {
  const { mod, req } = charger({ snapshots: [] })
  await mod.isMenageValidated('u1', '12345', { arrival: '2026-09-10', id: '77' }, 'beds24')
  assert.strictEqual(req.order.col, 'snapshot->>departure',
    'trier par updated_at ne marchait que tant que le cron reecrivait toutes les lignes')
  assert.strictEqual(req.order.ascending, false)
  assert.strictEqual(req.order.nullsFirst, false, 'les lignes sans depart ne doivent pas occuper le lot')
})

test('la requete borne les departs a la date d\'arrivee', async () => {
  const { mod, req } = charger({ snapshots: [] })
  await mod.isMenageValidated('u1', '12345', { arrival: '2026-09-10', id: '77' }, 'beds24')
  assert.deepStrictEqual(req.lte, { col: 'snapshot->>departure', val: '2026-09-10' })
})

test('aucun depart precedent -> premier voyageur, pas de menage requis', async () => {
  const { mod } = charger({ snapshots: [] })
  assert.strictEqual(await mod.isMenageValidated('u1', '12345', { arrival: '2026-09-10', id: '77' }, 'beds24'), true)
})

test('LE CAS PROTEGE : un depart precedent ancien bloque bien le code d\'acces', async () => {
  // Coeur de la correction. La resa terminee n'est plus reecrite par le cron ;
  // elle reste trouvee parce qu'on trie desormais sur sa DATE DE DEPART.
  // Un prestataire couvre le bien et aucun menage n'a ete valide -> on bloque.
  const { mod } = charger({
    snapshots: [snap('2026-09-08'), snap('2026-09-01'), snap('2026-08-15')],
    tokens: [{ property_ids: [] }],     // token « tous les biens »
    statut: { last_menage_at: null }
  })
  const r = await mod.isMenageValidated('u1', '12345', { arrival: '2026-09-10', id: '77' }, 'beds24')
  assert.strictEqual(r, false, 'depart precedent trouve + menage non valide -> code retenu')
})

test('sans depart precedent trouve, le code partirait sans attendre le menage', async () => {
  // Ce que produisait le tri par updated_at une fois les reecritures supprimees :
  // les resas terminees sortent du lot, plus de depart precedent, envoi immediat.
  const { mod } = charger({
    snapshots: [],                       // aucun depart precedent remonte
    tokens: [{ property_ids: [] }],
    statut: { last_menage_at: null }
  })
  assert.strictEqual(await mod.isMenageValidated('u1', '12345', { arrival: '2026-09-10', id: '77' }, 'beds24'), true)
})

test('menage valide APRES le depart precedent -> code libere', async () => {
  const { mod } = charger({
    snapshots: [snap('2026-09-08')],
    tokens: [{ property_ids: ['12345'] }],
    statut: { last_menage_at: '2026-09-09T10:00:00Z' }
  })
  assert.strictEqual(await mod.isMenageValidated('u1', '12345', { arrival: '2026-09-10', id: '77' }, 'beds24'), true)
})

test('menage valide AVANT le depart precedent -> code retenu', async () => {
  const { mod } = charger({
    snapshots: [snap('2026-09-08')],
    tokens: [{ property_ids: ['12345'] }],
    statut: { last_menage_at: '2026-09-05T10:00:00Z' }
  })
  assert.strictEqual(await mod.isMenageValidated('u1', '12345', { arrival: '2026-09-10', id: '77' }, 'beds24'), false)
})

test('aucun suivi menage sur le bien -> le code n\'est pas bloque', async () => {
  const { mod } = charger({
    snapshots: [snap('2026-09-08')],
    tokens: [],                          // aucun prestataire affecte
    statut: null
  })
  assert.strictEqual(await mod.isMenageValidated('u1', '12345', { arrival: '2026-09-10', id: '77' }, 'beds24'), true)
})

test('les sejours non actifs sont ignores dans la recherche', async () => {
  const { mod } = charger({
    snapshots: [snap('2026-09-08', { status: 'cancelled' }), snap('2026-09-07', { status: 'blocked' })]
  })
  assert.strictEqual(await mod.isMenageValidated('u1', '12345', { arrival: '2026-09-10', id: '77' }, 'beds24'), true,
    'une annulation ou un blocage ne compte pas comme sejour precedent')
})

test('lignes anterieures a l\'unification : le provider par defaut s\'applique', async () => {
  const { mod } = charger({
    snapshots: [{ snapshot: { status: 'black', departure: '2026-09-08' } }]   // legacy, sans provider
  })
  assert.strictEqual(await mod.isMenageValidated('u1', '12345', { arrival: '2026-09-10', id: '77' }, 'beds24'), true,
    'un blocage proprietaire legacy ne doit pas compter comme sejour precedent')
})

test('la reservation en cours ne se compte pas elle-meme', async () => {
  const { mod } = charger({ snapshots: [{ snapshot: { provider: 'beds24', status: 'confirmed', departure: '2026-09-10', id: '77' } }] })
  assert.strictEqual(await mod.isMenageValidated('u1', '12345', { arrival: '2026-09-10', id: '77' }, 'beds24'), true)
})
