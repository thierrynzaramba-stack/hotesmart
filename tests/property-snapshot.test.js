// tests/property-snapshot.test.js
// Le writer unique de `property_snapshots` (etape 1B).
// Faux client Supabase : ces tests ne sortent jamais.

const test = require('node:test')
const assert = require('node:assert')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'

const { savePropertySnapshot } = require('../lib/property-snapshot')

// Faux aussi PAUVRE que la realite : il rend { data, error }, il ne throw pas.
// C'est la lecon du moteur de reservation — une garde qui ne lit pas `error`
// est du code mort, et un faux qui throw la cache.
function faux ({ existante = null, erreurLecture = null, erreurEcriture = null } = {}) {
  const journal = { upserts: [], updates: [] }
  const api = {
    from () { return api },
    select () { return api },
    eq () { return api },
    maybeSingle: async () => ({ data: existante, error: erreurLecture }),
    upsert: async (ligne, opts) => { journal.upserts.push({ ligne, opts }); return { error: erreurEcriture } },
    update (patch) { journal.updates.push(patch); return { eq: async () => ({ error: erreurEcriture }) } }
  }
  return { api, journal }
}

const RAW = { id: 209413, name: 'La bulle', roomTypes: [{ id: 1 }] }

test('une fiche neuve est ecrite, avec son empreinte', async () => {
  const f = faux()
  const r = await savePropertySnapshot(f.api, { userId: 'u', provider: 'beds24', propertyId: 209413, raw: RAW })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.change, true)
  const l = f.journal.upserts[0].ligne
  assert.strictEqual(l.property_id, '209413', 'propertyId force en TEXT')
  assert.ok(l.raw_hash && l.raw_hash.length === 64, 'empreinte sha256 posee')
  assert.deepStrictEqual(l.raw, RAW, 'payload conserve INTEGRAL')
  assert.strictEqual(f.journal.upserts[0].opts.onConflict, 'user_id,provider,property_id')
})

test('un contenu identique ne reecrit PAS le payload — seul fetched_at bouge', async () => {
  // La regle de bookings_snapshot, reprise telle quelle : updated_at = dernier
  // changement de CONTENU. Sans ca, « quand la fiche a-t-elle change ? » ment.
  const premier = faux()
  await savePropertySnapshot(premier.api, { userId: 'u', provider: 'beds24', propertyId: 209413, raw: RAW })
  const hash = premier.journal.upserts[0].ligne.raw_hash

  const f = faux({ existante: { id: 'x', raw_hash: hash } })
  const r = await savePropertySnapshot(f.api, { userId: 'u', provider: 'beds24', propertyId: 209413, raw: RAW })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.change, false, 'aucun changement annonce')
  assert.strictEqual(f.journal.upserts.length, 0, 'aucun upsert')
  assert.deepStrictEqual(Object.keys(f.journal.updates[0]), ['fetched_at'], 'seul fetched_at')
})

test('un contenu different reecrit et annonce le changement', async () => {
  const f = faux({ existante: { id: 'x', raw_hash: 'un-vieux-hash' } })
  const r = await savePropertySnapshot(f.api, { userId: 'u', provider: 'beds24', propertyId: 209413, raw: RAW })
  assert.strictEqual(r.change, true)
  assert.ok(f.journal.upserts[0].ligne.updated_at, 'updated_at pose sur un vrai changement')
})

test('un payload VIDE n\'ecrase jamais un brut connu', async () => {
  // Vecu Channex : une annulation a payload vide (regression 5f1777d). Le
  // provider peut rendre {} sans que rien ne soit casse chez lui.
  for (const vide of [null, undefined, {}, 'texte', 0]) {
    const f = faux({ existante: { id: 'x', raw_hash: 'h' } })
    const r = await savePropertySnapshot(f.api, { userId: 'u', provider: 'beds24', propertyId: 209413, raw: vide })
    assert.strictEqual(r.ok, false, `payload ${JSON.stringify(vide)} refuse`)
    assert.strictEqual(r.raison, 'payload_vide')
    assert.strictEqual(f.journal.upserts.length, 0, 'rien ecrit')
  }
})

test('une cle incomplete est refusee avant tout acces base', async () => {
  for (const manque of [{ userId: null }, { provider: null }, { propertyId: null }]) {
    const f = faux()
    const r = await savePropertySnapshot(f.api, {
      userId: 'u', provider: 'beds24', propertyId: 209413, raw: RAW, ...manque
    })
    assert.strictEqual(r.raison, 'cle_incomplete')
    assert.strictEqual(f.journal.upserts.length, 0)
  }
})

test('une erreur de LECTURE est lue, pas ignoree', async () => {
  // postgrest-js ne throw pas : sans lire `error`, on prendrait un echec de
  // lecture pour « aucune ligne » et on ecraserait un brut existant.
  const f = faux({ erreurLecture: { message: 'timeout' } })
  const r = await savePropertySnapshot(f.api, { userId: 'u', provider: 'beds24', propertyId: 209413, raw: RAW })
  assert.strictEqual(r.ok, false)
  assert.match(r.raison, /lecture/)
  assert.strictEqual(f.journal.upserts.length, 0, 'aucune ecriture apres une lecture douteuse')
})

test('une erreur d\'ECRITURE est rendue, pas avalee', async () => {
  const f = faux({ erreurEcriture: { message: 'rls' } })
  const r = await savePropertySnapshot(f.api, { userId: 'u', provider: 'beds24', propertyId: 209413, raw: RAW })
  assert.strictEqual(r.ok, false)
  assert.match(r.raison, /ecriture/)
})
