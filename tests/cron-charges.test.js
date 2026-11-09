// tests/cron-charges.test.js — le cron dédié du compte de charges
// (api/cron-charges.js ; spec §6, §7).

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert/strict')
const { baseEnregistreuse } = require('./outils/base-enregistreuse')

function reponse () {
  const rep = { statut: null, charge: null }
  const res = { status (s) { rep.statut = s; return res }, json (c) { rep.charge = c; return res }, setHeader () {} }
  return { rep, res }
}

test('⚠ sans CRON_SECRET, l’endpoint est FERMÉ (503), jamais comparé à « Bearer undefined »', async () => {
  const avant = process.env.CRON_SECRET
  delete process.env.CRON_SECRET
  try {
    const handler = require('../api/cron-charges')
    const { rep, res } = reponse()
    await handler({ headers: { authorization: 'Bearer undefined' } }, res)
    assert.equal(rep.statut, 503)
  } finally { if (avant !== undefined) process.env.CRON_SECRET = avant }
})

test('un mauvais secret -> 401', async () => {
  const avant = process.env.CRON_SECRET
  process.env.CRON_SECRET = 'le-bon'
  try {
    const handler = require('../api/cron-charges')
    const { rep, res } = reponse()
    await handler({ headers: { authorization: 'Bearer le-mauvais' } }, res)
    assert.equal(rep.statut, 401)
  } finally {
    if (avant === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = avant
  }
})

test('le passage quotidien est celui de 3 h 00 à 3 h 04, heure de Paris (hiver comme été)', () => {
  const { estLePassageQuotidien } = require('../api/cron-charges')
  assert.equal(estLePassageQuotidien(new Date('2026-11-10T02:02:00Z')), true, '3 h 02 à Paris en hiver')
  assert.equal(estLePassageQuotidien(new Date('2026-11-10T02:06:00Z')), false)
  assert.equal(estLePassageQuotidien(new Date('2026-11-10T03:02:00Z')), false, '4 h 02 à Paris')
  assert.equal(estLePassageQuotidien(new Date('2026-07-10T01:01:00Z')), true, '3 h 01 à Paris en été')
})

test('le recalcul quotidien parcourt les comptes PAR CURSEUR, et s’arrête à l’échéance', async () => {
  const { recalculerTousLesComptes } = require('../api/cron-charges')
  const pages = [Array.from({ length: 200 }, (_, i) => `u${String(i).padStart(3, '0')}`), ['u900']]
  const { client, rpcs } = baseEnregistreuse(undefined, {
    rpc: (nom, args) => (nom === 'charges_comptes' ? { data: pages.shift() || [], error: null } : { data: 1, error: null })
  })
  const r = await recalculerTousLesComptes(client, Date.now() + 10000)
  assert.equal(r.comptes, 201)
  assert.equal(r.complet, true)
  const curseurs = rpcs.filter(x => x.nom === 'charges_comptes').map(x => x.args.p_apres)
  assert.deepEqual(curseurs, [null, 'u199'])
  const vide = baseEnregistreuse(undefined, { rpc: () => ({ data: ['a'], error: null }) })
  const arret = await recalculerTousLesComptes(vide.client, Date.now() - 1)
  assert.equal(arret.complet, false)
  assert.equal(vide.rpcs.length, 0)
})
