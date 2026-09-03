// tests/menages-public-ecriture.test.js
// api/menages-public.js — `markDone` / `markUndone`, le côté ÉCRITURE de la PWA.
//
// ⚠ CE QUE CES TESTS FERMENT. Ces deux actions ne vérifiaient NI le périmètre du
// token, NI l'assignation : elles résolvaient le token en `user_id` puis
// écrivaient sur le `property_id` / `booking_id` fournis par le CLIENT. Un
// porteur de lien pouvait donc marquer fait — ou DÉFAIRE — le ménage de
// quelqu'un d'autre, sur n'importe quel bien du compte. `markUndone` ne
// regardait même pas `done_by_token`.
//
// C'est REVIEW.md règle 11 : une donnée client qui désigne une ressource ne se
// valide pas, elle ne s'utilise pas. Et c'était le côté resté ouvert pendant que
// la LECTURE, elle, venait d'être resserrée.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const U = 'compte-1', TOKEN = 'marie-x', REGINA = 'p-regina', MARIE = 'p-marie'
const HIER = (() => { const d = new Date(Date.now() - 86400000); return d.toISOString().slice(0, 10) })()

function preparer ({ profil = { id: MARIE, active: true },
                     menage = undefined, propertyIds = ['209413'],
                     erreurProfil = null, erreurMenage = null } = {}) {
  const etat = { ecritures: [], suppressions: [] }
  const client = {
    from (table) {
      const a = { table, f: {} }
      const chain = {
        select () { return chain },
        eq (c, v) { a.f[c] = v; return chain },
        neq () { return chain }, in () { return chain }, is () { return chain },
        gte () { return chain }, lte () { return chain }, not () { return chain },
        order () { return chain }, limit () { return Promise.resolve({ data: [], error: null }) },
        upsert (row) { etat.ecritures.push({ table, row }); return Promise.resolve({ error: null }) },
        delete () { return { eq: () => chain, then: (ok) => { etat.suppressions.push(a.f); return Promise.resolve({ error: null }).then(ok) } } },
        maybeSingle () {
          if (table === 'public_tokens') {
            return Promise.resolve({ data: a.f.token === TOKEN
              ? { user_id: U, property_ids: propertyIds } : null, error: null })
          }
          if (table === 'profiles') return Promise.resolve({ data: profil, error: erreurProfil })
          if (table === 'menages') return Promise.resolve({ data: menage === undefined ? null : menage, error: erreurMenage })
          return Promise.resolve({ data: null, error: null })
        },
        then (ok) { return Promise.resolve({ data: [], error: null }).then(ok) }
      }
      return chain
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  const absStatus = require.resolve(path.join(__dirname, '..', 'lib/cron-property-status.js'))
  const ms = new Module(absStatus); ms.exports = { markReady: async () => {} }; ms.loaded = true
  require.cache[absStatus] = ms
  for (const mod of ['../api/menages-public', '../lib/stats-avis', '../lib/attribution-prestataire']) {
    try { delete require.cache[require.resolve(mod)] } catch {}
  }
  return etat
}

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = () => {}
  r.end = () => r
  return r
}
const post = (action, over = {}) => ({
  method: 'POST', query: { token: TOKEN }, headers: {},
  body: { action, booking_id: 'b1', property_id: '209413', departure_date: HIER, ...over }
})

// ─── Le ménage de quelqu'un d'autre ────────────────────────────────────────

test('markDone : on ne marque PAS le ménage d\'une autre prestataire', async () => {
  const etat = preparer({ menage: { provider_id: REGINA, status: 'accepted' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('markDone'), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('markUndone : on ne DÉFAIT pas le travail d\'une autre', async () => {
  // Le plus dommageable des deux : effacer un « fait » que quelqu'un a posé.
  const etat = preparer({ menage: { provider_id: REGINA, status: 'accepted' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('markUndone'), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.suppressions.length, 0)
})

test('son propre ménage passe', async () => {
  const etat = preparer({ menage: { provider_id: MARIE, status: 'accepted' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('markDone'), res)
  assert.notStrictEqual(res.code, 403)
  assert.strictEqual(etat.ecritures.length, 1)
})

test('un ménage qui n\'est à personne passe aussi', async () => {
  // Un lien legacy sur un bien sans assignation doit continuer de fonctionner.
  const etat = preparer({ profil: null, menage: { provider_id: null, status: 'unassigned' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('markDone'), res)
  assert.notStrictEqual(res.code, 403)
  assert.strictEqual(etat.ecritures.length, 1)
})

// ─── Le repli quand aucun ménage n'existe encore ───────────────────────────

test('aucun ménage en base : on retombe sur le PÉRIMÈTRE du token', async () => {
  // La table vient d'être créée et le writer ne couvre que J−30/J+180 : refuser
  // ici casserait le rattrapage d'un ménage plus ancien, que la PWA permet
  // justement sur 14 jours en arrière.
  const etat = preparer({ menage: null, propertyIds: ['209413'] })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('markDone'), res)
  assert.notStrictEqual(res.code, 403)
  assert.strictEqual(etat.ecritures.length, 1)
})

test('aucun ménage en base, et le bien est HORS du périmètre : refusé', async () => {
  // Sans ce repli, le client choisissait son bien lui-même.
  const etat = preparer({ menage: null, propertyIds: ['999999'] })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('markDone'), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.ecritures.length, 0)
})

// ─── Les pannes coupent ────────────────────────────────────────────────────

test('PANNE de lecture du ménage : 503, jamais une écriture à l\'aveugle', async () => {
  const etat = preparer({ erreurMenage: { message: 'timeout' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('markDone'), res)
  assert.strictEqual(res.code, 503)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('PANNE de lecture du profil : 503 elle aussi', async () => {
  const etat = preparer({ erreurProfil: { message: 'timeout' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('markDone'), res)
  assert.strictEqual(res.code, 503)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('markDone sur un ménage encore PROPOSÉ est refusé par le serveur', async () => {
  // ⚠ La règle « on ne fait pas un ménage qu'on n'a pas accepté » n'existait que
  // dans le front : le serveur, lui, laissait passer. Une offre non répondue
  // n'engage personne — la marquer faite court-circuiterait la confirmation.
  const etat = preparer({ menage: { provider_id: null, offered_to: MARIE, status: 'unassigned' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('markDone'), res)
  assert.strictEqual(res.code, 403)
  assert.match(res.body.error, /Acceptez/)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('markUndone sur un ménage proposé est refusé lui aussi', async () => {
  const etat = preparer({ menage: { provider_id: null, offered_to: MARIE, status: 'unassigned' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('markUndone'), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.suppressions.length, 0)
})

test('une fois accepté, le même ménage passe', async () => {
  // Contre-épreuve : la garde ne doit pas bloquer le cas normal.
  const etat = preparer({ menage: { provider_id: MARIE, status: 'accepted' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('markDone'), res)
  assert.notStrictEqual(res.code, 403)
  assert.strictEqual(etat.ecritures.length, 1)
})

test('la PORTEUSE peut marquer fait même pendant une proposition', async () => {
  // ⚠ Le ménage reste le sien tant que personne n'a accepté : lui refuser
  // l'action reviendrait à lui retirer une responsabilité qu'elle a toujours.
  const etat = preparer({ menage: { provider_id: MARIE, offered_to: 'p-autre', status: 'accepted' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('markDone'), res)
  assert.notStrictEqual(res.code, 403)
  assert.strictEqual(etat.ecritures.length, 1)
})

test('une TIERCE ne peut pas toucher un ménage sous proposition', async () => {
  // ⚠ LA GARDE QUE CE TEST FERME. Elle testait `status === 'offered'`, en
  // supposant que proposition impliquait ce statut — le modèle parallèle casse
  // l'équivalence : une proposition posée sur un ménage `unassigned` laisse le
  // statut intact. Le ménage redevenait « à personne », et n'importe quelle
  // prestataire du compte pouvait le marquer fait, ou le DÉFAIRE.
  const etat = preparer({
    profil: { id: 'p-julie', active: true },
    menage: { provider_id: null, offered_to: MARIE, status: 'unassigned' }
  })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('markUndone'), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.suppressions.length, 0)
})
