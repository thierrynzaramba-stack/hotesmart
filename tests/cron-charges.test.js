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

test('⚠ Q28 : le cron des charges passe UNE FOIS PAR JOUR (décision de Thierry du 9 novembre 2026)', () => {
  const vercel = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'vercel.json'), 'utf8'))
  const crons = vercel.crons.filter(c => c.path === '/api/cron-charges')
  assert.equal(crons.length, 1)
  const [minute, heure, ...reste] = crons[0].schedule.split(' ')
  assert.match(minute, /^\d+$/, 'une minute fixe, pas */N')
  assert.match(heure, /^\d+$/, 'une heure fixe : une fois par jour')
  assert.deepEqual(reste, ['*', '*', '*'])
  assert.equal(vercel.functions['api/cron-charges.js'].maxDuration, 60)
})

test('le recalcul quotidien parcourt les comptes PAR CURSEUR, et s’arrête à l’échéance', async () => {
  const { recalculerTousLesComptes } = require('../api/cron-charges')
  const pages = [Array.from({ length: 200 }, (_, i) => `u${String(i).padStart(3, '0')}`), ['u900']]
  const { client, rpcs } = baseEnregistreuse(undefined, {
    rpc: (nom, args) => (nom === 'charges_comptes' ? { data: pages.shift() || [], error: null } : { data: 1, error: null })
  })
  const r = await recalculerTousLesComptes(client, Date.now() + 10000, { depart: null })
  assert.equal(r.comptes, 201)
  assert.equal(r.complet, true)
  const curseurs = rpcs.filter(x => x.nom === 'charges_comptes').map(x => x.args.p_apres)
  assert.deepEqual(curseurs, [null, 'u199'])
  const vide = baseEnregistreuse(undefined, { rpc: () => ({ data: ['a'], error: null }) })
  const arret = await recalculerTousLesComptes(vide.client, Date.now() - 1, { depart: null })
  assert.equal(arret.complet, false)
  assert.equal(vide.rpcs.length, 0)
})

test('⚠ une tâche qui rend `ok: false` est une ERREUR du passage, pas un zéro silencieux', async () => {
  const avant = process.env.CRON_SECRET
  process.env.CRON_SECRET = 'le-bon'
  const { client } = baseEnregistreuse()
  const absSdk = require.resolve('@supabase/supabase-js')
  require('@supabase/supabase-js')
  const vraiCreate = require.cache[absSdk].exports.createClient
  require.cache[absSdk].exports.createClient = () => client
  const absWriter = require.resolve('../lib/charges')
  require('../lib/charges')
  const vraiWriter = require.cache[absWriter].exports
  require.cache[absWriter].exports = Object.assign({}, vraiWriter, {
    purgerEnvois: async () => ({ ok: false, purges: 0 }),
    lireEnAttente: async () => ({ ok: true, lues: 0, panne_stockage: true })
  })
  const absCron = require.resolve('../api/cron-charges')
  delete require.cache[absCron]
  try {
    const handler = require('../api/cron-charges')
    const { rep, res } = reponse()
    await handler({ headers: { authorization: 'Bearer le-bon' } }, res)
    assert.equal(rep.statut, 200)
    const taches = rep.charge.errors.map(e => `${e.tache}:${e.error}`)
    assert.ok(taches.includes('purge_envois:lecture des envois impossible'), taches.join(' | '))
    assert.ok(taches.includes('lectures:stockage indisponible'), taches.join(' | '))
  } finally {
    require.cache[absSdk].exports.createClient = vraiCreate
    require.cache[absWriter].exports = vraiWriter
    delete require.cache[absCron]
    if (avant === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = avant
  }
})

test('⚠ un passage À VIDE : 2 lectures de `charges`, la mesure, 2 RPC — ZÉRO appel à l’IA, zéro au stockage', async () => {
  const avant = process.env.CRON_SECRET
  process.env.CRON_SECRET = 'le-bon'
  const b = baseEnregistreuse(() => ({ data: [], error: null }))
  const absSdk = require.resolve('@supabase/supabase-js')
  require('@supabase/supabase-js')
  const vraiCreate = require.cache[absSdk].exports.createClient
  require.cache[absSdk].exports.createClient = () => b.client
  const absLecture = require.resolve('../lib/charges/lecture')
  require('../lib/charges/lecture')
  const vraieLecture = require.cache[absLecture].exports
  let ia = 0
  require.cache[absLecture].exports = Object.assign({}, vraieLecture, { lireDocument: async () => { ia++; return { panne: true } } })
  const absCron = require.resolve('../api/cron-charges')
  delete require.cache[absCron]
  try {
    const handler = require('../api/cron-charges')
    const { rep, res } = reponse()
    await handler({ headers: { authorization: 'Bearer le-bon' } }, res)
    assert.equal(rep.statut, 200)
    assert.deepEqual(rep.charge.errors, [])
    assert.equal(ia, 0, 'rien à lire : aucun appel à l’IA')
    assert.equal(b.gestes.length, 0, 'aucun appel au stockage')
    const parTable = b.requetes.map(r => `${r.op} ${r.table}`).sort()
    assert.deepEqual(parTable, ['insert cron_stats', 'select charges', 'select charges'])
    assert.deepEqual(b.rpcs.map(x => x.nom), ['charges_comptes', 'charges_comptes'],
      'la liste des comptes, lue en deux tours (le départ tourne)')
    assert.ok(!b.requetes.some(r => r.table === 'ia_appels'), 'le plafond ne se lit que s’il y a quelque chose à lire')
  } finally {
    require.cache[absSdk].exports.createClient = vraiCreate
    require.cache[absLecture].exports = vraieLecture
    delete require.cache[absCron]
    if (avant === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = avant
  }
})

test('⚠ le recalcul part d’un point qui TOURNE et fait le tour : la fin de la liste n’est jamais oubliée', async () => {
  const { recalculerTousLesComptes } = require('../api/cron-charges')
  const tous = ['a1', 'b2', 'c3', 'd4', 'e5']
  const { client, rpcs } = baseEnregistreuse(undefined, {
    rpc: (nom, args) => {
      if (nom !== 'charges_comptes') return { data: 1, error: null }
      const suite = tous.filter(id => args.p_apres === null || id > args.p_apres)
      return { data: suite.slice(0, args.p_limite), error: null }
    }
  })
  const r = await recalculerTousLesComptes(client, Date.now() + 10000, { depart: 'c0' })
  assert.equal(r.complet, true)
  const faits = rpcs.filter(x => x.nom === 'charges_recalculer_compte').map(x => x.args.p_user)
  assert.deepEqual(faits, ['c3', 'd4', 'e5', 'a1', 'b2'], 'de `c0` à la fin, puis du début à `c0`, chacun une fois')
})
