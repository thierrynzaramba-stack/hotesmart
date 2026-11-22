// tests/demandes-mesure.test.js
// DETTE 129, LOT 1, ETAPE 0 — LA MESURE DES DEMANDES AIRBNB, EN LECTURE SEULE.
//
// Trois etages, du plus pur au plus branche :
//   1. lib/demandes/mesure.js : les nombres, a partir de donnees deja lues ;
//   2. lib/channels/channex.js listerFils / idsDesMessagesDuFil : la lecture
//      paginee chez le partenaire, et ses deux pieges (page courte, page ignoree) ;
//   3. api/diagnostic.js ?check=demandes : la garde AVANT tout appel au
//      partenaire, la lecture du coeur par curseur, et AUCUN texte de message
//      dans la reponse.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'https://api.exemple'
process.env.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY || 'cle-test'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const { filsADetailler, mesurer } = require('../lib/demandes/mesure')

// ─── 1. Les nombres ─────────────────────────────────────────────────────────

const fil = (id, extra = {}) => ({ id, ota: 'airbnb', titre: 'T' + id, booking: null, ferme: false, nbMessages: 2, derniere: '2026-11-10T10:00:00Z', ...extra })

test('filsADetailler : toutes les demandes, et seulement les fils avec réservation qui ont bougé depuis le plus ancien message sans réservation', () => {
  const fils = [
    fil('ancien-resa', { booking: 'b1', derniere: '2026-07-01T00:00:00Z' }),
    fil('recent-resa', { booking: 'b2', derniere: '2026-10-01T00:00:00Z' }),
    fil('vieille-demande', { derniere: '2026-01-01T00:00:00Z' }),
    fil('demande'),
  ]
  const r = filsADetailler(fils, { depuis: '2026-08-03T19:04:17+00:00' })
  assert.deepStrictEqual(r.choisis.map(f => f.id).sort(), ['demande', 'recent-resa', 'vieille-demande'])
  assert.strictEqual(r.tronque, false)
  // Les demandes passent d'abord : sous un plafond serre, ce sont elles qu'on garde.
  const serre = filsADetailler(fils, { depuis: '2026-08-03T19:04:17+00:00', max: 2 })
  assert.deepStrictEqual(serre.choisis.map(f => f.id), ['demande', 'vieille-demande'])
  assert.strictEqual(serre.tronque, true)
  assert.strictEqual(serre.candidats, 3)
})

test('filsADetailler : sans aucun message sans réservation chez nous, tous les fils sont candidats (rien ne permet d\'en écarter)', () => {
  const r = filsADetailler([fil('a', { booking: 'b', derniere: '2020-01-01T00:00:00Z' }), fil('b')], { depuis: null })
  assert.strictEqual(r.choisis.length, 2)
})

test('filsADetailler : un fil sans date est gardé (traité comme récent)', () => {
  const r = filsADetailler([fil('x', { booking: 'b', derniere: null })], { depuis: '2026-08-01T00:00:00Z' })
  assert.deepStrictEqual(r.choisis.map(f => f.id), ['x'])
})

test('mesurer : compte les demandes, les fils devenus réservations et les lignes rattachables', () => {
  const fils = [fil('d1'), fil('d2', { ferme: true }), fil('r1', { booking: 'B1' }), fil('r2', { booking: 'B2' })]
  const details = new Map([
    ['d1', { ok: true, complet: true, ids: ['m1', 'm2'] }],
    ['d2', { ok: true, complet: false, ids: ['m3'] }],
    ['r1', { ok: true, complet: true, ids: ['m4', 'm5'] }],
    ['r2', { ok: true, complet: true, ids: ['m9'] }],
  ])
  const lignes = [
    { provider_msg_id: 'm1', direction: 'inbound', sent_at: '2026-11-01T10:00:00+00:00', body: 'Bonjour' },
    { provider_msg_id: 'm2', direction: 'outbound', sent_at: '2026-11-01T11:00:00+00:00', body: 'Oui' },
    { provider_msg_id: 'm4', direction: 'inbound', sent_at: '2026-10-01T10:00:00+00:00', body: 'Dispo ?' },
    { provider_msg_id: 'inconnu', direction: 'inbound', sent_at: '2026-10-02T10:00:00+00:00', body: 'x' },
    // copies webhook : sans identifiant, ota nul
    { provider_msg_id: null, direction: 'inbound', sent_at: '2026-11-01T10:00:00.000Z', body: 'Bonjour' },
    { provider_msg_id: null, direction: 'inbound', sent_at: '2026-11-01T10:00:01Z', body: 'Bonjour' },
  ]
  const r = mesurer({ fils, details, lignes })
  assert.deepStrictEqual(r.fils, { total: 4, sans_resa: 2, avec_resa: 2, detail_incomplet: 1 })
  assert.strictEqual(r.demandes.length, 2)
  const d1 = r.demandes.find(d => d.fil === 'd1')
  assert.strictEqual(d1.messages_channex, 2)
  assert.strictEqual(d1.chez_nous_sans_resa, 2)
  assert.deepStrictEqual(r.devenues_resa, [{ fil: 'r1', booking: 'B1', ota: 'airbnb', chez_nous_sans_resa: 1 }])
  assert.deepStrictEqual(r.lignes_sans_resa, {
    total: 6, avec_id: 4, avec_id_rattachees: 3, avec_id_dans_une_demande: 2,
    // ⚠ la jumelle exige le MEME instant a la milliseconde : la copie a une
    // seconde d'ecart n'en est pas une (regle de recordMessage).
    copies_webhook: 2, copies_webhook_avec_jumelle: 1,
  })
})

test('mesurer : une jumelle exige aussi la même direction et le même texte', () => {
  const t = '2026-11-01T10:00:00Z'
  const r = mesurer({ lignes: [
    { provider_msg_id: 'a', direction: 'outbound', sent_at: t, body: 'Ok' },
    { provider_msg_id: null, direction: 'inbound', sent_at: t, body: 'Ok' },
    { provider_msg_id: null, direction: 'outbound', sent_at: t, body: 'Ok !' },
  ] })
  assert.strictEqual(r.lignes_sans_resa.copies_webhook_avec_jumelle, 0)
})

test('mesurer : une demande non lue garde le compte du listing et le dit', () => {
  const r = mesurer({ fils: [fil('d', { nbMessages: 7 })], details: new Map() })
  assert.strictEqual(r.demandes[0].messages_channex, 7)
  assert.strictEqual(r.demandes[0].chez_nous_sans_resa, null)
  assert.strictEqual(r.demandes[0].lu, false)
})

test('mesurer : aucun texte de message ne sort', () => {
  const r = mesurer({
    fils: [fil('d1')],
    details: new Map([['d1', { ok: true, complet: true, ids: ['m1'] }]]),
    lignes: [{ provider_msg_id: 'm1', direction: 'inbound', sent_at: '2026-11-01T10:00:00Z', body: 'SECRET-VOYAGEUR' }],
  })
  assert.ok(!JSON.stringify(r).includes('SECRET-VOYAGEUR'))
})

// ─── 2. La lecture chez le partenaire ───────────────────────────────────────

function avecFetch (repondre, fn) {
  const avant = global.fetch
  const appels = []
  global.fetch = async (url) => {
    appels.push(String(url))
    const { status = 200, json } = repondre(String(url), appels.length)
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(json) }
  }
  return Promise.resolve(fn(appels)).finally(() => { global.fetch = avant })
}

function channexFrais () {
  delete require.cache[require.resolve('../lib/channels/channex')]
  return require('../lib/channels/channex')
}

const thread = (id, extra = {}) => ({
  id,
  attributes: { provider: 'Airbnb', title: 'Voyageur ' + id, is_closed: false, message_count: 3, last_message_received_at: '2026-11-10T10:00:00.000000', ...(extra.attributes || {}) },
  relationships: extra.booking ? { booking: { data: { id: extra.booking } } } : { property: { data: { id: 'P' } } },
})

test('listerFils : pagine jusqu\'à la page VIDE (pas la page courte), et normalise chaque fil', async () => {
  const ch = channexFrais()
  await avecFetch(url => {
    const page = Number(/pagination\[page\]=(\d+)/.exec(url)[1])
    if (page === 1) return { json: { data: [thread('t1'), thread('t2', { booking: 'B2' })] } }
    if (page === 2) return { json: { data: [thread('t3')] } }
    return { json: { data: [] } }
  }, async (appels) => {
    const r = await ch.listerFils({ propertyId: 'P' })
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.complet, true)
    assert.strictEqual(appels.length, 3)
    assert.ok(appels.every(u => u.includes('/message_threads?filter[property_id]=P')))
    assert.deepStrictEqual(r.fils.map(f => [f.id, f.booking]), [['t1', null], ['t2', 'B2'], ['t3', null]])
    assert.strictEqual(r.fils[0].ota, 'airbnb')
    assert.strictEqual(r.fils[0].titre, 'Voyageur t1')
    assert.strictEqual(r.fils[0].nbMessages, 3)
    // L'instant Channex sans fuseau est lu en UTC (enUTC).
    assert.ok(/Z$|\+00:00$/.test(r.fils[0].derniere), r.fils[0].derniere)
  })
})

test('listerFils : une page qui recommence par le même fil = pagination ignorée, on s\'arrête et on le DIT', async () => {
  const ch = channexFrais()
  await avecFetch(() => ({ json: { data: [thread('t1'), thread('t2')] } }), async (appels) => {
    const r = await ch.listerFils({ propertyId: 'P' })
    assert.strictEqual(r.ok, true)
    assert.strictEqual(r.complet, false)
    assert.strictEqual(appels.length, 2)
    assert.strictEqual(r.fils.length, 2)
  })
})

test('listerFils : 403 = application messages absente, nommée', async () => {
  const ch = channexFrais()
  await avecFetch(() => ({ status: 403, json: { errors: { code: 'forbidden' } } }), async () => {
    const r = await ch.listerFils({ propertyId: 'P' })
    assert.deepStrictEqual([r.ok, r.erreur, r.complet], [false, 'messages_app_absent', false])
  })
})

test('idsDesMessagesDuFil : rend les seuls identifiants, page par page, jusqu\'à la page vide', async () => {
  const ch = channexFrais()
  await avecFetch(url => {
    const page = Number(/pagination\[page\]=(\d+)/.exec(url)[1])
    if (page === 1) return { json: { data: [{ id: 'm1', attributes: { message: 'texte' } }, { id: 'm2' }] } }
    return { json: { data: [] } }
  }, async (appels) => {
    const r = await ch.idsDesMessagesDuFil('T1')
    assert.deepStrictEqual(r, { ok: true, ids: ['m1', 'm2'], complet: true })
    assert.ok(appels[0].includes('/message_threads/T1/messages?'))
  })
})

test('les deux lecteurs n\'émettent que des GET', async () => {
  const ch = channexFrais()
  const avant = global.fetch
  const methodes = []
  global.fetch = async (url, opts) => {
    methodes.push(opts && opts.method)
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: [] }) }
  }
  try {
    await ch.listerFils({ propertyId: 'P' })
    await ch.idsDesMessagesDuFil('T')
  } finally { global.fetch = avant }
  assert.ok(methodes.length > 0 && methodes.every(m => m === 'GET'), methodes.join(','))
})

// ─── 3. Le controle de diagnostic ───────────────────────────────────────────

const BIEN = { id: 'u-bien', user_id: 'compte-1', name: 'La bulle', provider: 'channex', provider_property_id: 'P' }

function lignesDuCoeur (n) {
  return Array.from({ length: n }, (_, i) => ({
    id: String(i).padStart(6, '0'),
    provider_msg_id: i < 2 ? 'm' + (i + 1) : null,
    direction: 'inbound',
    sent_at: '2026-09-01T10:00:00+00:00',
    body: 'TEXTE-PRIVE-' + i,
  }))
}

function charger ({ garde = { ok: true, bien: BIEN }, lignes = lignesDuCoeur(3), fils = [thread('d1'), thread('r1', { booking: 'B1' })] } = {}) {
  const etat = { requetes: [], gardeArgs: null, appelsProvider: 0 }
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'x' } }, error: null }) },
    from (table) {
      const filtre = { table, eq: [], is: [], gt: null, limite: null }
      const q = {
        select () { return q },
        eq (c, v) { filtre.eq.push([c, v]); return q },
        is (c, v) { filtre.is.push([c, v]); return q },
        order () { return q },
        gt (c, v) { filtre.gt = v; return q },
        limit (n) { filtre.limite = n; return q },
        then (ok, ko) {
          etat.requetes.push(filtre)
          const rangs = lignes.filter(l => !filtre.gt || l.id > filtre.gt).slice(0, filtre.limite || 1000)
          return Promise.resolve({ data: rangs, error: null }).then(ok, ko)
        },
      }
      return q
    },
    rpc: async () => ({ data: [], error: null }),
  }
  const remplacer = (chemin, exports) => {
    const abs = require.resolve(chemin)
    const m = new Module(abs); m.exports = exports; m.loaded = true
    require.cache[abs] = m
  }
  remplacer(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'), { createClient: () => client })
  remplacer(path.join(__dirname, '..', 'lib/require-permission'), {
    requirePermission: async (req, res, args) => {
      etat.gardeArgs = args
      if (!garde.ok) { res.status(garde.code || 403).json({ error: 'refus' }); return { ok: false } }
      return garde
    },
  })
  const fiche = {
    listerFils: async () => { etat.appelsProvider++; return { ok: true, complet: true, fils: fils.map(t => ({ id: t.id, ota: 'airbnb', titre: 'T', booking: t.relationships?.booking?.data?.id || null, ferme: false, nbMessages: 2, derniere: '2026-11-10T10:00:00Z' })) } },
    idsDesMessagesDuFil: async (id) => { etat.appelsProvider++; return { ok: true, complet: true, ids: id === 'd1' ? ['m1'] : ['m2'] } },
  }
  remplacer(path.join(__dirname, '..', 'lib/channels/index.js'), { getProvider: () => fiche })
  delete require.cache[require.resolve('../api/diagnostic')]
  const handler = require('../api/diagnostic')
  return { handler, etat }
}

function reponse () {
  const r = { code: 200, body: null, entetes: {} }
  r.status = (c) => { r.code = c; return r }
  r.json = (b) => { r.body = b; return r }
  r.setHeader = (k, v) => { r.entetes[k.toLowerCase()] = v }
  return r
}

test('diagnostic demandes : la garde porte le domaine messages et le bien venu du client, et un refus n\'appelle PAS le partenaire', async () => {
  const { handler, etat } = charger({ garde: { ok: false, code: 403 } })
  const res = reponse()
  await handler({ method: 'GET', query: { check: 'demandes', property_id: ' P ' }, headers: {} }, res)
  assert.strictEqual(res.code, 403)
  assert.deepStrictEqual(etat.gardeArgs, { domaine: 'messages', niveau: 'read', bien: 'P', bienRequis: true })
  assert.strictEqual(etat.appelsProvider, 0)
  assert.strictEqual(etat.requetes.length, 0)
})

test('diagnostic demandes : un bien hors Channex est refusé en 400 sans appel', async () => {
  const { handler, etat } = charger({ garde: { ok: true, bien: { ...BIEN, provider: 'beds24' } } })
  const res = reponse()
  await handler({ method: 'GET', query: { check: 'demandes', property_id: 'P' }, headers: {} }, res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.appelsProvider, 0)
})

test('diagnostic demandes : lit le cœur PAR CURSEUR au-delà de 1000 lignes, filtré sur le compte, le bien et l\'absence de réservation', async () => {
  const { handler, etat } = charger({ lignes: lignesDuCoeur(1500) })
  const res = reponse()
  await handler({ method: 'GET', query: { check: 'demandes', property_id: 'P' }, headers: {} }, res)
  assert.strictEqual(res.code, 200, JSON.stringify(res.body))
  assert.strictEqual(etat.requetes.length, 2)
  assert.strictEqual(etat.requetes[1].gt, '000999')
  for (const r of etat.requetes) {
    assert.strictEqual(r.table, 'messages')
    assert.deepStrictEqual(r.eq, [['user_id', 'compte-1'], ['property_id', 'P']])
    assert.deepStrictEqual(r.is, [['booking_id', null]])
  }
  assert.strictEqual(res.body.lignes_lues_completes, true)
  assert.strictEqual(res.body.lignes_sans_resa.total, 1500)
})

test('diagnostic demandes : la réponse dit les demandes et les fils devenus réservations, sans aucun texte de message', async () => {
  const { handler } = charger()
  const res = reponse()
  await handler({ method: 'GET', query: { check: 'demandes', property_id: 'P' }, headers: {} }, res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.ok, true)
  assert.strictEqual(res.body.bien, 'P')
  assert.deepStrictEqual(res.body.fils, { total: 2, sans_resa: 1, avec_resa: 1, detail_incomplet: 0 })
  assert.strictEqual(res.body.demandes[0].chez_nous_sans_resa, 1)
  assert.deepStrictEqual(res.body.devenues_resa.map(d => d.fil), ['r1'])
  assert.deepStrictEqual(res.body.detail, { candidats: 2, lus: 2, tronque: false })
  assert.ok(!JSON.stringify(res.body).includes('TEXTE-PRIVE'))
})
