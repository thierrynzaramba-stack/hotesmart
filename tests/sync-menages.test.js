// tests/sync-menages.test.js
// Consommateur menage : diffusion par prestataire, respect du type 'note' manuel.

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const inserts = []
function stubShared() {
  const abs = require.resolve(path.join(__dirname, '..', 'lib/cron-shared.js'))
  const m = new Module(abs)
  m.exports = {
    supabase: {
      from(nom) {
        return {
          insert: async (row) => { inserts.push({ table: nom, row }); return { error: null } },
          select() { return this }, in: async () => ({ data: [] })
        }
      }
    }
  }
  m.loaded = true
  require.cache[abs] = m
}
stubShared()
delete require.cache[require.resolve('../lib/cleaning/sync-menages')]
const { syncMenageEvent, tokensPourBien, TYPES_DIFFUSES } = require('../lib/cleaning/sync-menages')

const snapshot = { firstName: 'Jean', lastName: 'Dupont', arrival: '2026-09-01', departure: '2026-09-05', numAdult: 2, numChild: 0 }
const event = (o = {}) => ({ user_id: 'u1', booking_id: '77', property_id: '12345', type: 'new', changes: null, ...o })

test('ecrit un menage_event par prestataire concerne', async () => {
  inserts.length = 0
  const tokens = [
    { token: 'tA', property_ids: [], user_id: 'u1' },          // tous les biens
    { token: 'tB', property_ids: ['12345'], user_id: 'u1' },   // ce bien
    { token: 'tC', property_ids: ['99999'], user_id: 'u1' }    // un autre bien
  ]
  const r = await syncMenageEvent(event(), { snapshot, propertyName: 'Bien test', tokens })
  assert.strictEqual(r.written, 2)
  assert.deepStrictEqual(inserts.map(i => i.row.token).sort(), ['tA', 'tB'])
  assert.strictEqual(inserts[0].table, 'menage_events')
  assert.strictEqual(inserts[0].row.event_type, 'new')
  assert.strictEqual(inserts[0].row.event_data.guestName, 'Jean Dupont')
})

test('aucun prestataire affecte -> rien ecrit, ce n\'est pas une erreur', async () => {
  inserts.length = 0
  const r = await syncMenageEvent(event(), { snapshot, propertyName: 'x', tokens: [] })
  assert.strictEqual(r.written, 0)
  assert.strictEqual(r.reason, 'aucun_prestataire')
  assert.strictEqual(inserts.length, 0)
})

test('NOTE MANUELLE : le type note n\'est jamais produit ni touche ici', async () => {
  inserts.length = 0
  assert.ok(!TYPES_DIFFUSES.includes('note'))
  const r = await syncMenageEvent(event({ type: 'note' }), {
    snapshot, propertyName: 'x', tokens: [{ token: 'tA', property_ids: [], user_id: 'u1' }]
  })
  assert.strictEqual(r.written, 0)
  assert.strictEqual(inserts.length, 0, 'aucune ecriture pour un type hors perimetre')
})

test('changes n\'est joint que pour modified', async () => {
  const tokens = [{ token: 'tA', property_ids: [], user_id: 'u1' }]
  const changes = { arrival: { before: 'a', after: 'b' }, departure: null }

  inserts.length = 0
  await syncMenageEvent(event({ type: 'modified', changes }), { snapshot, propertyName: 'x', tokens })
  assert.deepStrictEqual(inserts[0].row.event_data.changes, changes)

  inserts.length = 0
  await syncMenageEvent(event({ type: 'new', changes }), { snapshot, propertyName: 'x', tokens })
  assert.strictEqual(inserts[0].row.event_data.changes, undefined)
})

test('les trois types diffuses sont bien new / modified / cancelled', () => {
  assert.deepStrictEqual([...TYPES_DIFFUSES].sort(), ['cancelled', 'modified', 'new'])
})

test('tokensPourBien : token global, token cible, token d\'un autre bien', () => {
  const tokens = [
    { token: 'global', property_ids: [] },
    { token: 'cible', property_ids: ['12345'] },
    { token: 'autre', property_ids: ['99999'] }
  ]
  assert.deepStrictEqual(tokensPourBien(tokens, '12345').map(t => t.token), ['global', 'cible'])
  assert.deepStrictEqual(tokensPourBien(tokens, 12345).map(t => t.token), ['global', 'cible'])
})

test('voyageur sans nom -> libelle par defaut', async () => {
  inserts.length = 0
  await syncMenageEvent(event(), {
    snapshot: { arrival: '2026-09-01' }, propertyName: 'x',
    tokens: [{ token: 'tA', property_ids: [], user_id: 'u1' }]
  })
  assert.strictEqual(inserts[0].row.event_data.guestName, 'Voyageur')
})

// ─── Isolation multi-comptes (fuite signalee par la revue) ──────────────────
// Le dispatcher traite un lot MULTI-COMPTES et charge les tokens de tous les
// hotes du lot. La PWA prestataire lit menage_events par TOKEN seul, et le
// dispatcher tourne en service key : le filtre user_id est la seule defense.

test('FUITE : un token « tous les biens » d\'un autre hote ne recoit rien', async () => {
  inserts.length = 0
  const tokens = [
    { token: 'tok_A', property_ids: [], user_id: 'u1' },   // hote A, tous ses biens
    { token: 'tok_B', property_ids: [], user_id: 'u2' }    // hote B, tous SES biens
  ]
  const r = await syncMenageEvent(event({ user_id: 'u1' }), { snapshot, propertyName: 'x', tokens })
  assert.strictEqual(r.written, 1)
  assert.deepStrictEqual(inserts.map(i => i.row.token), ['tok_A'])
  assert.ok(!inserts.some(i => i.row.token === 'tok_B'), 'aucun menage_event pour le prestataire de l\'autre hote')
})

test('FUITE : meme provider_property_id chez deux hotes -> pas de croisement', async () => {
  inserts.length = 0
  // Deux hotes d'un meme property manager Beds24 peuvent porter le propId '1'.
  const tokens = [
    { token: 'tok_A', property_ids: ['1'], user_id: 'u1' },
    { token: 'tok_B', property_ids: ['1'], user_id: 'u2' }
  ]
  await syncMenageEvent(event({ user_id: 'u2', property_id: '1' }), { snapshot, propertyName: 'x', tokens })
  assert.deepStrictEqual(inserts.map(i => i.row.token), ['tok_B'])
})

test('tokensPourBien : le filtre user_id prime sur le filtre bien', () => {
  const tokens = [
    { token: 'bon',     property_ids: [],      user_id: 'u1' },
    { token: 'mauvais', property_ids: [],      user_id: 'u2' },
    { token: 'cible',   property_ids: ['123'], user_id: 'u1' },
    { token: 'autreh',  property_ids: ['123'], user_id: 'u2' }
  ]
  assert.deepStrictEqual(tokensPourBien(tokens, '123', 'u1').map(t => t.token), ['bon', 'cible'])
  assert.deepStrictEqual(tokensPourBien(tokens, '123', 'u2').map(t => t.token), ['mauvais', 'autreh'])
  assert.deepStrictEqual(tokensPourBien(tokens, '123', 'inconnu'), [])
})
