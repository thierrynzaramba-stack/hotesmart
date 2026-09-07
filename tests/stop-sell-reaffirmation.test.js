// tests/stop-sell-reaffirmation.test.js
// Spec : docs/specs/spec-audit-stop-sell.md
//
// LE FAIT QUI FONDE CES TESTS : chez Channex, un POST /availability qui ne porte
// que le stock REMET stop_sell A FALSE sur les dates touchees. Mesure du
// 7 septembre 2026 en production — quatre nuits d'un bien volontairement ferme
// sont redevenues vendables sur Airbnb et Booking.com.
//
// Ce que ces tests defendent : toute poussee de stock RESTITUE l'intention
// memorisee (`calendar_inventory.stop_sell`), et elle la restitue APRES.

const test = require('node:test')
const assert = require('node:assert')
const Module = require('node:module')

process.env.SUPABASE_URL = 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = 'test'
process.env.CHANNEL_BASE_URL = 'https://api.exemple'
process.env.CHANNEL_API_KEY = 'cle-test'

// ─── Harnais ────────────────────────────────────────────────────────────────
const etat = { memoire: [], erreurMemoire: null, appels: [], reponses: {}, incidents: [], filtres: [] }

const fakeSupabase = {
  rpc: async () => ({ data: true, error: null }),   // claim gagne : on pousse
  from (table) {
    // ⚠ `eq` EST ENREGISTRE, pas ignore. `calendar_inventory.property_id` est
    // l'UUID de `properties` ; le `providerPropertyId` passe a cote est du TEXT.
    // Un mock qui avale `.eq()` laisserait la confusion des deux passer au vert.
    const q = {
      select: () => q, gte: () => q, lte: () => q, lt: () => q, delete: () => q,
      eq: (col, val) => { etat.filtres.push({ table, col, val }); return q },
      order: async () => ({ data: etat.memoire, error: etat.erreurMemoire })
    }
    return q
  }
}

// ⚠ `channel-availability` DESTRUCTURE reportIncident au chargement. Remplacer
// la propriete du module apres coup ne changerait donc rien : c'est la resolution
// du require qu'il faut intercepter.
const origLoad = Module._load
Module._load = function (requete) {
  if (requete === '@supabase/supabase-js') return { createClient: () => fakeSupabase }
  if (requete === './founder-notify') {
    return { reportIncident: async (type, opts) => { etat.incidents.push({ type, ...opts }) } }
  }
  return origLoad.apply(this, arguments)
}
const { pushAvailabilityOnce } = require('../lib/channel-availability')
Module._load = origLoad

global.fetch = async (url, init) => {
  const chemin = String(url).replace('https://api.exemple', '')
  etat.appels.push({ chemin, methode: init.method, corps: init.body ? JSON.parse(init.body) : null })
  const cle = Object.keys(etat.reponses).find(k => chemin.startsWith(k))
  const r = cle ? etat.reponses[cle] : { status: 200, json: { data: {} } }
  return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.json) }
}

const BIEN = {
  id: 'e14e25f6-168a-4826-80dd-ddbf78ac44c1',
  user_id: 'compte-1',
  inventory_type: 'whole',
  provider_room_type_id: 'room-1',
  provider_rate_plan_id: 'plan-1'
}
const PROP = '0544fd9a-6579-44e7-b75e-19c63a2019ba'

function reset (memoire = [], reponses = {}) {
  etat.memoire = memoire
  etat.erreurMemoire = null
  etat.appels = []
  etat.incidents = []
  etat.filtres = []
  etat.reponses = reponses
}
const posts = () => etat.appels.filter(a => a.methode === 'POST')
const chemins = () => posts().map(a => a.chemin)

// ─── Le test de non-regression ──────────────────────────────────────────────

test('une poussee de stock est TOUJOURS suivie de la restitution du stop-sell', async () => {
  reset([
    { date: '2026-11-12', stop_sell: true },
    { date: '2026-11-13', stop_sell: true },
    { date: '2026-11-14', stop_sell: true }
  ], {
    '/restrictions?': { status: 200, json: { data: { 'plan-1': {
      '2026-11-12': { stop_sell: true }, '2026-11-13': { stop_sell: true }, '2026-11-14': { stop_sell: true }
    } } } }
  })

  await pushAvailabilityOnce(BIEN, PROP, '2026-11-12', '2026-11-15', 1, 'test')

  assert.deepStrictEqual(chemins(), ['/availability', '/restrictions'],
    'le stock part, puis l\'intention est restituee — jamais l\'inverse')

  assert.deepStrictEqual(
    etat.filtres.filter(f => f.table === 'calendar_inventory'),
    [{ table: 'calendar_inventory', col: 'property_id', val: BIEN.id }],
    'la memoire se lit sur l\'UUID du bien, jamais sur le propId provider'
  )

  const rest = posts()[1].corps.values
  assert.strictEqual(rest.length, 1, 'trois nuits de meme valeur = une seule plage')
  assert.deepStrictEqual(rest[0], {
    property_id: PROP, rate_plan_id: 'plan-1',
    date_from: '2026-11-12', date_to: '2026-11-14', stop_sell: true
  })
  assert.strictEqual(etat.incidents.length, 0)
})

test('ORDRE : /restrictions ne part jamais AVANT /availability', async () => {
  // Le POST /availability efface le stop_sell des dates qu'il touche. L'inverser,
  // c'est poser la fermeture puis l'effacer soi-meme dans la foulee.
  reset([{ date: '2026-11-12', stop_sell: true }], {
    '/restrictions?': { status: 200, json: { data: { 'plan-1': { '2026-11-12': { stop_sell: true } } } } }
  })
  await pushAvailabilityOnce(BIEN, PROP, '2026-11-12', '2026-11-13', 1, 'test')
  const i = chemins().indexOf('/availability'), j = chemins().indexOf('/restrictions')
  assert.ok(i >= 0 && j > i, `availability doit preceder restrictions (${chemins().join(' puis ')})`)
})

test('sans intention memorisee, RIEN n\'est pousse — on n\'en invente pas une', async () => {
  // Une date sans ligne en memoire n'a pas d'intention connue. Emettre
  // `stop_sell: false` y ecrirait une decision que l'hote n'a jamais prise.
  reset([])
  await pushAvailabilityOnce(BIEN, PROP, '2026-11-12', '2026-11-15', 1, 'test')
  assert.deepStrictEqual(chemins(), ['/availability'])
})

test('l\'intention memorisee est restituee TELLE QUELLE, ouverte comme fermee', async () => {
  reset([
    { date: '2026-11-12', stop_sell: true },
    { date: '2026-11-13', stop_sell: false },
    { date: '2026-11-14', stop_sell: true }
  ], {
    '/restrictions?': { status: 200, json: { data: { 'plan-1': {
      '2026-11-12': { stop_sell: true }, '2026-11-14': { stop_sell: true }
    } } } }
  })
  await pushAvailabilityOnce(BIEN, PROP, '2026-11-12', '2026-11-15', 1, 'test')
  const v = posts()[1].corps.values
  assert.strictEqual(v.length, 3, 'trois plages : la valeur change a chaque jour')
  assert.deepStrictEqual(v.map(x => x.stop_sell), [true, false, true])
})

test('memoire illisible : incident leve, jamais un silence', async () => {
  // Une lecture en erreur ne vaut pas « rien a restituer » : c'est exactement le
  // cas ou l'on rouvrirait des dates fermees sans le savoir.
  reset([])
  etat.erreurMemoire = { message: 'connexion perdue' }
  await pushAvailabilityOnce(BIEN, PROP, '2026-11-12', '2026-11-15', 1, 'test')
  assert.deepStrictEqual(chemins(), ['/availability'])
  assert.strictEqual(etat.incidents.length, 1)
  assert.strictEqual(etat.incidents[0].type, 'stop_sell_perdu')
})

test('echec de la restitution sur des dates FERMEES : incident', async () => {
  reset([{ date: '2026-11-12', stop_sell: true }], {
    '/restrictions': { status: 422, json: { errors: {} } }
  })
  await pushAvailabilityOnce(BIEN, PROP, '2026-11-12', '2026-11-13', 1, 'test')
  assert.strictEqual(etat.incidents.length, 1, 'des nuits sont vendables a tort : il faut crier')
  assert.ok(/vendables/i.test(etat.incidents[0].detail))
})

test('echec de la restitution sur des dates OUVERTES : pas d\'incident', async () => {
  // Rien n'est en danger : l'intention etait « ouvert », le provider l'est deja.
  reset([{ date: '2026-11-12', stop_sell: false }], {
    '/restrictions': { status: 422, json: { errors: {} } }
  })
  await pushAvailabilityOnce(BIEN, PROP, '2026-11-12', '2026-11-13', 1, 'test')
  assert.strictEqual(etat.incidents.length, 0)
})

// ─── Retours de review ──────────────────────────────────────────────────────

test('stop_sell = NULL n\'est PAS une intention : rien n\'est pousse', async () => {
  // Une ligne creee par une simple edition de tarif ne porte que property_id et
  // date. La pousser en `false` inventerait une decision — et rouvrirait un bien
  // ferme hors HoteSmart au premier changement de prix.
  reset([
    { date: '2026-11-12', stop_sell: null },
    { date: '2026-11-13', stop_sell: null }
  ])
  await pushAvailabilityOnce(BIEN, PROP, '2026-11-12', '2026-11-14', 1, 'test')
  assert.deepStrictEqual(chemins(), ['/availability'])
})

test('les NULL sont ecartes, les decisions reelles passent quand meme', async () => {
  reset([
    { date: '2026-11-12', stop_sell: null },
    { date: '2026-11-13', stop_sell: true }
  ])
  await pushAvailabilityOnce(BIEN, PROP, '2026-11-12', '2026-11-14', 1, 'test')
  const v = posts()[1].corps.values
  assert.strictEqual(v.length, 1)
  assert.deepStrictEqual([v[0].date_from, v[0].date_to, v[0].stop_sell], ['2026-11-13', '2026-11-13', true])
})

test('la restitution suit la TENTATIVE : elle a lieu meme si /availability echoue', async () => {
  // `fetch` peut echouer APRES que le serveur a traite l'ecriture : un stop-sell
  // leve sans qu'on le sache est precisement l'incident a empecher.
  reset([{ date: '2026-11-12', stop_sell: true }], { '/availability': { status: 500, json: {} } })
  await pushAvailabilityOnce(BIEN, PROP, '2026-11-12', '2026-11-13', 1, 'test')
  assert.deepStrictEqual(chemins(), ['/availability', '/restrictions'])
})

test('bien sans rate_plan ET fermeture memorisee : incident, pas un simple log', async () => {
  // Le stock est deja parti et plus rien ne peut etre restitue. Se taire ici
  // serait le silence exact que le reste de la fonction refuse.
  reset([{ date: '2026-11-12', stop_sell: true }])
  await pushAvailabilityOnce({ ...BIEN, provider_rate_plan_id: null }, PROP, '2026-11-12', '2026-11-13', 1, 'test')
  assert.deepStrictEqual(chemins(), ['/availability'])
  assert.strictEqual(etat.incidents.length, 1)
  assert.strictEqual(etat.incidents[0].type, 'stop_sell_perdu')
})

test('AUCUNE relecture immediate : elle crierait a tort (ARI applique en differe)', async () => {
  // Le POST ARI rend un id de tache. Un GET dans la foulee lit l'etat d'AVANT et
  // declencherait une alerte fondateur a chaque fermeture legitime — l'anti-spam
  // masquerait ensuite la vraie. La verification est deliberee : audit-stop-sell.js.
  reset([{ date: '2026-11-12', stop_sell: true }])
  await pushAvailabilityOnce(BIEN, PROP, '2026-11-12', '2026-11-13', 1, 'test')
  assert.strictEqual(etat.appels.filter(a => a.methode === 'GET').length, 0)
  assert.strictEqual(etat.incidents.length, 0)
})

test('une exception ne remonte JAMAIS a l\'appelant (le cron acke apres)', async () => {
  // Sur le chemin du feed, `pollChannelFeed` acke la revision APRES ce retour :
  // une panne ici rejouerait la revision toutes les 5 min et bloquerait la page.
  reset([{ date: '2026-11-12', stop_sell: true }])
  const fetchOk = global.fetch
  let n = 0
  global.fetch = async (...a) => {
    n++
    if (n > 1) throw Object.assign(new Error('socket coupee'), { cause: { code: 'ECONNRESET' } })
    return fetchOk(...a)
  }
  await assert.doesNotReject(() => pushAvailabilityOnce(BIEN, PROP, '2026-11-12', '2026-11-13', 1, 'test'))
  global.fetch = fetchOk
})
