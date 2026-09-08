// tests/bookings-snapshot-budget-raw.test.js
// Constat de review du 8 septembre 2026 : le budget de rafraichissement du `raw`
// n'etait partage par AUCUN appelant, donc chaque appel de saveBookingSnapshots
// repartait a 60. Avec deux alimentateurs Beds24 par bien dans le meme cycle */5,
// le plafond effectif etait 60 x call sites x biens d'UPDATE sequentiels — le
// depassement des 60 s de la fonction Vercel que ce budget pretend empecher.

const test = require('node:test')
const assert = require('node:assert')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'

const { budgetDuCycle, _reinitialiserBudget, RAW_PAR_CYCLE } = require('../lib/bookings-snapshot')

test('deux appels rapproches PARTAGENT le meme budget', () => {
  _reinitialiserBudget()
  const t = 1_000_000
  const a = budgetDuCycle(t)
  a.restant -= 10
  const b = budgetDuCycle(t + 5000)          // 5 s plus tard, meme cycle
  assert.strictEqual(b, a, 'le meme objet est rendu')
  assert.strictEqual(b.restant, RAW_PAR_CYCLE - 10, 'la consommation est vue par le second appelant')
})

test('le budget ne se recharge pas au fil du cycle, meme sur 60 s', () => {
  // Le pire cas reel : cron-bookings au debut du cycle, cron-classify a la fin.
  _reinitialiserBudget()
  const t = 2_000_000
  const a = budgetDuCycle(t)
  a.restant = 0
  const b = budgetDuCycle(t + 59_000)        // plafond Vercel : 60 s
  assert.strictEqual(b.restant, 0, 'epuise reste epuise dans le meme cycle')
})

test('un NOUVEAU cycle repart a plein budget', () => {
  _reinitialiserBudget()
  const t = 3_000_000
  budgetDuCycle(t).restant = 0
  const suivant = budgetDuCycle(t + 300_000) // periode du cron : 5 minutes
  assert.strictEqual(suivant.restant, RAW_PAR_CYCLE, 'le cycle suivant a son budget')
})

test('la frontiere est franche : 120 s partage, au-dela recharge', () => {
  _reinitialiserBudget()
  const t = 4_000_000
  budgetDuCycle(t).restant = 7
  assert.strictEqual(budgetDuCycle(t + 120_000).restant, 7, 'a 120 s pile, meme cycle')
  _reinitialiserBudget()
  budgetDuCycle(t).restant = 7
  assert.strictEqual(budgetDuCycle(t + 120_001).restant, RAW_PAR_CYCLE, 'au-dela, nouveau cycle')
})

test('un budget impose par l\'appelant n\'est pas ecrase (le backfill)', () => {
  // Le backfill tourne hors cron et ne doit pas etre borne par le budget du cron.
  _reinitialiserBudget()
  const propre = { restant: 5000 }
  assert.notStrictEqual(propre, budgetDuCycle(5_000_000), 'objets distincts')
  assert.strictEqual(propre.restant, 5000, 'intact')
})
