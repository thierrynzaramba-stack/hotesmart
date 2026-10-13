// tests/menages-note.test.js
// POST /api/menages action:'note' — LA NOTE POUR LA PRESTATAIRE.
//
// ⚠ LA FONCTION QUE LA V5 NE DEVAIT PAS PERDRE (inventaire E.1 : « oubliée
// par la spec et la maquette »). C'est le seul chemin par lequel l'hôte dit
// quelque chose à la personne qui entrera chez lui : « le code de la boîte a
// changé », « les poubelles sortent le mardi ».
//
// Trois fautes la rendraient nuisible :
//   1. annoncer « enregistrée » quand elle ne part pas — l'hôte croirait la
//      consigne transmise, et la prestataire ne la verrait jamais ;
//   2. laisser le CLIENT dicter le contenu du fil — un appel forgé écrirait
//      n'importe quel nom de voyageur dans l'écran de la prestataire ;
//   3. écrire sans garde de compte ou de périmètre.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const PROD = '11111111-1111-4111-8111-111111111111'
const MEMBRE = '22222222-2222-4222-8222-222222222222'
const BIEN = '209413'
const DEPART = '2026-10-10'

function preparer ({ user = PROD, profil = null, permissions = null,
                     menage = { status: 'accepted' },
                     jetons = [{ token: 'tok-r', property_ids: [] }],
                     erreurJetons = null, erreurEvents = null, erreurUpsert = null,
                     snapshot = { firstName: 'Sofia', lastName: 'Garcia', arrival: '2026-10-07' },
                     bien = { name: 'La bulle' } } = {}) {
  const etat = { notes: [], events: [], lectures: [] }
  const client = {
    auth: { getUser: async () => (user ? { data: { user: { id: user } }, error: null }
                                       : { data: null, error: { message: 'x' } }) },
    from (table) {
      const a = { table, f: {} }
      etat.lectures.push(a)
      const chain = {
        select () { return chain },
        eq (c, v) { a.f[c] = v; return chain },
        in () { return chain }, not () { return chain }, order () { return chain },
        neq () { return chain }, gte () { return chain }, lte () { return chain },
        limit () { return chain },
        range (from) { return Promise.resolve(from === 0 ? { data: [], error: null } : { data: [], error: null }) },
        upsert (row) { etat.notes.push(row); return Promise.resolve({ error: erreurUpsert }) },
        insert (rows) { etat.events.push(...[].concat(rows)); return Promise.resolve({ error: erreurEvents }) },
        maybeSingle () {
          if (table === 'profiles') return Promise.resolve({ data: profil, error: null })
          if (table === 'profile_permissions') return Promise.resolve({ data: permissions, error: null })
          if (table === 'menages') {
            // Les filtres sont HONORÉS : `.eq('user_id')` est la seule garde
            // inter-comptes pour un titulaire (son périmètre vaut `null`).
            const bon = a.f.user_id === PROD && String(a.f.property_id) === BIEN
            return Promise.resolve({ data: bon ? menage : null, error: null })
          }
          if (table === 'properties') return Promise.resolve({ data: bien, error: null })
          if (table === 'bookings_snapshot') return Promise.resolve({ data: { snapshot }, error: null })
          return Promise.resolve({ data: null, error: null })
        },
        then (ok) {
          if (table === 'public_tokens') {
            return Promise.resolve({ data: erreurJetons ? null : jetons, error: erreurJetons }).then(ok)
          }
          return Promise.resolve({ data: [], error: null }).then(ok)
        }
      }
      return chain
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of ['../lib/require-permission', '../lib/permissions', '../api/menages']) {
    try { delete require.cache[require.resolve(mod)] } catch {}
  }
  return { handler: require('../api/menages'), etat }
}

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  return r
}
const post = (body, entetes = {}) => ({ method: 'POST', query: {}, body,
  headers: { authorization: 'Bearer jeton', ...entetes } })
const corps = (o = {}) => ({ action: 'note', property_id: BIEN, booking_id: 'b1',
                             departure_date: DEPART, texte: 'Code porte : 4521', ...o })

// ─── Les droits ─────────────────────────────────────────────────────────────

test('sans session : 401, rien n\'est écrit', async () => {
  const { handler, etat } = preparer({ user: null })
  const res = reponse()
  await handler(post(corps()), res)
  assert.strictEqual(res.code, 401)
  assert.strictEqual(etat.notes.length, 0)
})

test('sans `menages: write` : 403', async () => {
  const { handler, etat } = preparer({
    user: MEMBRE,
    profil: { id: 'pr1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { menages: 'read', property_scope: 'all' }
  })
  const res = reponse()
  await handler(post(corps(), { 'x-compte': PROD }), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.notes.length, 0)
})

test('LE TEST QUI COMPTE : sans `prestataires: read`, la note est enregistrée mais NON TRANSMISE — et c\'est dit', async () => {
  // `public_tokens` est sous `prestataires: read`. Un membre qui ne l'a pas
  // écrit bien sa consigne, mais personne ne la lira : annoncer un succès
  // complet ferait croire à l'hôte que sa prestataire est prévenue.
  const { handler, etat } = preparer({
    user: MEMBRE,
    profil: { id: 'pr1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { menages: 'write', prestataires: 'none', property_scope: 'all' }
  })
  const res = reponse()
  await handler(post(corps(), { 'x-compte': PROD }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.transmise, false)
  assert.strictEqual(etat.notes.length, 1, 'la note EST enregistrée')
  assert.strictEqual(etat.events.length, 0, 'mais aucun événement n\'est créé')
})

test('un bien hors périmètre est refusé', async () => {
  const { handler, etat } = preparer({
    user: MEMBRE,
    profil: { id: 'pr1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { menages: 'write', prestataires: 'read', property_scope: 'selected', property_ids: ['999'] }
  })
  const res = reponse()
  await handler(post(corps(), { 'x-compte': PROD }), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.notes.length, 0)
})

// ─── Ce qui part dans le fil ────────────────────────────────────────────────

test('le contenu du fil vient du CŒUR, pas du corps de la requête', async () => {
  // Sans cela, un appel forgé écrirait n'importe quel nom de voyageur dans
  // l'écran de la prestataire.
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post(corps({ guestName: 'INJECTÉ', property_name: 'INJECTÉ' })), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.transmise, true)
  assert.strictEqual(etat.events.length, 1)
  const ev = etat.events[0]
  assert.strictEqual(ev.event_type, 'note')
  assert.strictEqual(ev.property_name, 'La bulle', 'le nom du bien vient de `properties`')
  assert.strictEqual(ev.event_data.guestName, 'Sofia Garcia', 'le voyageur vient du snapshot')
  assert.strictEqual(ev.event_data.comment, 'Code porte : 4521')
  assert.strictEqual(ev.user_id, PROD)
})

test('un jeton SANS biens couvre TOUS les biens (convention de public_tokens)', async () => {
  // La convention est l'inverse de `profile_permissions` : la confondre
  // priverait de la note les prestataires qui couvrent tout le parc.
  const { handler, etat } = preparer({ jetons: [{ token: 'tout', property_ids: [] },
                                                { token: 'autre', property_ids: ['999'] }] })
  const res = reponse()
  await handler(post(corps()), res)
  assert.strictEqual(etat.events.length, 1)
  assert.strictEqual(etat.events[0].token, 'tout', 'et seulement les jetons concernés')
})

test('une note VIDE efface sans notifier', async () => {
  // Annoncer « note de l'employeur » pour une consigne retirée serait un faux
  // événement dans son fil.
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post(corps({ texte: '   ' })), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(etat.notes.length, 1)
  assert.strictEqual(etat.notes[0].comment, '')
  assert.strictEqual(etat.events.length, 0)
})

// ─── Les refus et les pannes ────────────────────────────────────────────────

test('un ménage introuvable : 404, aucune note orpheline', async () => {
  const { handler, etat } = preparer({ menage: null })
  const res = reponse()
  await handler(post(corps({ property_id: 'inconnu' })), res)
  assert.strictEqual(res.code, 404)
  assert.strictEqual(etat.notes.length, 0)
})

test('une note trop longue est refusée avant toute écriture', async () => {
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post(corps({ texte: 'x'.repeat(2001) })), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.notes.length, 0)
})

test('une panne du FIL ne fait pas mentir sur la note : enregistrée, non transmise', async () => {
  const { handler, etat } = preparer({ erreurEvents: { message: 'boom' } })
  const res = reponse()
  await handler(post(corps()), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(etat.notes.length, 1)
  assert.strictEqual(res.body.transmise, false)
})

test('une panne de lecture des jetons : note enregistrée, transmission dite fausse', async () => {
  const { handler, etat } = preparer({ erreurJetons: { message: 'boom' } })
  const res = reponse()
  await handler(post(corps()), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(etat.notes.length, 1)
  assert.strictEqual(res.body.transmise, false)
})

test('une panne d\'écriture de la note : 500, et rien n\'est transmis', async () => {
  const { handler, etat } = preparer({ erreurUpsert: { message: 'boom' } })
  const res = reponse()
  await handler(post(corps()), res)
  assert.strictEqual(res.code, 500)
  assert.strictEqual(etat.events.length, 0)
})
