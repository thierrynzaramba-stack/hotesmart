// tests/book-webhook-claim.test.js
//
// ⚠ LE GARDE ANTI-SURRESERVATION, EPROUVE POUR DE VRAI.
//
// Il a d'abord ete « teste » par une lecture de source — un grep de
// `catch … return true` — et c'est precisement ce qui a laisse passer du CODE
// MORT : postgrest-js NE LEVE JAMAIS sans `.throwOnError()`, il convertit meme
// une panne fetch en `{ data: null, error }`. Le `catch` ne s'executait donc
// jamais, `!!null` valait `false`, et on concluait « aucune creation en vol ».
//
// CE QUE CA COUTAIT : la transition `paid -> refunded` est permise. Si l'hote
// remboursait PENDANT que le POST CRS etait en vol, les tenues etaient
// supprimees, le feed n'avait pas encore la reservation, le calendrier public
// revoyait les nuits libres — et un second voyageur pouvait les acheter.
// Channex ne s'y oppose pas (stock a -1).
//
// Un test qui lit du code ne voit pas ce qu'un test qui l'execute voit.

const test = require('node:test')
const assert = require('node:assert')
const Module = require('node:module')

process.env.SUPABASE_URL = 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = 'test'
process.env.BOOKING_STRIPE_SECRET_KEY = 'rk_test_x'

const etat = { reponse: { data: null, error: null } }

const origine = Module._load
Module._load = function (d) {
  if (d === '@supabase/supabase-js') {
    return { createClient: () => ({
      from: () => ({
        select: () => ({ eq: () => ({ gt: () => ({ maybeSingle: async () => etat.reponse }) }) })
      })
    }) }
  }
  if (d === 'stripe') return class { }
  return origine.apply(this, arguments)
}
const handler = require('../api/book-webhook')
Module._load = origine

const { claimActif } = handler

test('claim present -> une creation est en vol', async () => {
  etat.reponse = { data: { key: 'resa-crs:x' }, error: null }
  assert.equal(await claimActif('x'), true)
})

test('claim absent -> aucune creation en vol', async () => {
  etat.reponse = { data: null, error: null }
  assert.equal(await claimActif('x'), false)
})

test('ERREUR DE LECTURE -> on suppose qu une creation est en vol', async () => {
  // ⚠ LE CAS QUI COMPTE, et celui que le test par grep ne voyait pas.
  // postgrest-js rend `{ data: null, error }` — il ne leve pas. Sans lecture
  // explicite de `error`, on concluait « pas de creation » et on liberait les
  // tenues pendant le POST.
  etat.reponse = { data: null, error: { message: 'fetch failed' } }
  assert.equal(await claimActif('x'), true,
    'garder une tenue de trop coute une reservation ratee ; la lever de trop coute une surreservation')
})

test('une panne PostgREST (5xx) est traitee comme une erreur, pas comme une absence', async () => {
  etat.reponse = { data: null, error: { message: 'PGRST301', code: 'PGRST301' } }
  assert.equal(await claimActif('x'), true)
})

test('le handler expose bien son garde ET sa config', () => {
  // `module.exports = handler` remplace l objet : `config` et `claimActif`
  // doivent etre poses APRES, sinon ils disparaissent — et sans `config`,
  // Vercel parse le corps et TOUTE signature Stripe est rejetee.
  assert.equal(typeof handler, 'function')
  assert.deepEqual(handler.config, { api: { bodyParser: false } })
  assert.equal(typeof handler.claimActif, 'function')
})
