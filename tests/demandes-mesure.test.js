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
  const fils = [fil('d1'), fil('d2', { ferme: true, nbMessages: 7 }), fil('r1', { booking: 'B1' }), fil('r2', { booking: 'B2' })]
  const details = new Map([
    ['d1', { ok: true, complet: true, ids: ['m1', 'm2'] }],
    ['d2', { ok: true, complet: false, ids: ['m3'] }],
    ['r1', { ok: true, complet: true, ids: ['m4', 'm5'] }],
    ['r2', { ok: true, complet: true, ids: ['m9'] }],
  ])
  const lignes = [
    { provider_msg_id: 'm1', direction: 'inbound', sent_at: '2026-11-01T10:00:00+00:00', body: 'Bonjour' },
    { provider_msg_id: 'm2', direction: 'outbound', sent_at: '2026-11-01T11:00:00+00:00', body: 'Oui' },
    { provider_msg_id: 'm3', direction: 'inbound', sent_at: '2026-11-02T11:00:00+00:00', body: 'Et ?' },
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
  assert.deepStrictEqual([d1.messages_channex, d1.chez_nous_sans_resa, d1.lu], [2, 2, true])
  assert.deepStrictEqual(r.devenues_resa, [{ fil: 'r1', booking: 'B1', ota: 'airbnb', chez_nous_sans_resa: 1, lu: true }])
  assert.deepStrictEqual(r.lignes_sans_resa, {
    total: 7, avec_id: 5, avec_id_rattachees: 4, avec_id_dans_une_demande: 3,
    // ⚠ la jumelle exige le MEME instant a la milliseconde : la copie a une
    // seconde d'ecart n'en est pas une (regle de recordMessage).
    copies_webhook: 2, copies_webhook_avec_jumelle: 1, dont_jumelle_avec_resa: 0,
  })
})

test('mesurer : un détail incomplet ou en échec n\'affirme rien — compte du listing, cœur inconnu, « lu » faux (review 1, J3)', () => {
  const fils = [fil('tronque', { nbMessages: 7 }), fil('echec', { nbMessages: 4 })]
  const details = new Map([
    ['tronque', { ok: true, complet: false, ids: ['m1'] }],
    ['echec', { ok: false, complet: false, ids: [] }],
  ])
  const r = mesurer({ fils, details, lignes: [{ provider_msg_id: 'm1', direction: 'inbound', sent_at: '2026-11-01T10:00:00Z', body: 'a' }] })
  assert.deepStrictEqual(r.demandes.map(d => [d.fil, d.messages_channex, d.chez_nous_sans_resa, d.lu]),
    [['tronque', 7, null, false], ['echec', 4, null, false]])
  assert.strictEqual(r.fils.detail_incomplet, 2)
})

test('mesurer : la jumelle d\'une copie webhook peut être une ligne import AVEC réservation (review 1, J1)', () => {
  const t = '2026-11-01T10:00:00+00:00'
  const r = mesurer({
    lignes: [{ provider_msg_id: null, direction: 'inbound', sent_at: t, body: 'Je réserve !' }],
    importAvecResa: [{ provider_msg_id: 'm7', direction: 'inbound', sent_at: '2026-11-01T10:00:00.000Z', body: 'Je réserve !' }],
  })
  assert.strictEqual(r.lignes_sans_resa.copies_webhook_avec_jumelle, 1)
  assert.strictEqual(r.lignes_sans_resa.dont_jumelle_avec_resa, 1)
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

test('idsDesMessagesDuFil : rend les seuls identifiants, et va jusqu\'à la page VIDE même après une page courte (review 1, T1)', async () => {
  const ch = channexFrais()
  await avecFetch(url => {
    const page = Number(/pagination\[page\]=(\d+)/.exec(url)[1])
    // Page 1 COURTE (2 sur 100) : un lecteur qui s'arreterait la rendrait
    // `complet` sans avoir lu la page 2, ou est le troisieme message.
    if (page === 1) return { json: { data: [{ id: 'm1', attributes: { message: 'texte' } }, { id: 'm2' }] } }
    if (page === 2) return { json: { data: [{ id: 'm3' }] } }
    return { json: { data: [] } }
  }, async (appels) => {
    const r = await ch.idsDesMessagesDuFil('T1')
    assert.deepStrictEqual(r, { ok: true, ids: ['m1', 'm2', 'm3'], complet: true })
    assert.strictEqual(appels.length, 3)
    assert.ok(appels[0].includes('/message_threads/T1/messages?'))
  })
})

test('idsDesMessagesDuFil : pagination ignorée = arrêt et liste INCOMPLÈTE (review 1, T1)', async () => {
  const ch = channexFrais()
  await avecFetch(() => ({ json: { data: [{ id: 'm1' }, { id: 'm2' }] } }), async (appels) => {
    const r = await ch.idsDesMessagesDuFil('T1')
    assert.deepStrictEqual(r, { ok: true, ids: ['m1', 'm2'], complet: false })
    assert.strictEqual(appels.length, 2)
  })
})

test('les deux lecteurs ne comptent un identifiant qu\'une fois quand la liste glisse entre deux pages (review 1, J4)', async () => {
  const ch = channexFrais()
  await avecFetch(url => {
    const page = Number(/pagination\[page\]=(\d+)/.exec(url)[1])
    const fils = url.includes('/message_threads?')
    if (page === 1) return { json: { data: fils ? [thread('t1'), thread('t2')] : [{ id: 'm1' }, { id: 'm2' }] } }
    // Un element est arrive en tete : la page 2 recommence par l'ancien dernier.
    if (page === 2) return { json: { data: fils ? [thread('t2'), thread('t3')] : [{ id: 'm2' }, { id: 'm3' }] } }
    return { json: { data: [] } }
  }, async () => {
    const f = await ch.listerFils({ propertyId: 'P' })
    assert.deepStrictEqual(f.fils.map(x => x.id), ['t1', 't2', 't3'])
    const m = await ch.idsDesMessagesDuFil('T')
    assert.deepStrictEqual(m.ids, ['m1', 'm2', 'm3'])
  })
})

test('listerFils : un fil qui désigne un AUTRE bien est écarté et compté — la clé du partenaire est globale (review 1, S1)', async () => {
  const ch = channexFrais()
  const autre = { ...thread('etranger'), relationships: { property: { data: { id: 'AUTRE-BIEN' } } } }
  const sien = { ...thread('sien'), relationships: { property: { data: { id: 'P' } } } }
  await avecFetch(url => /pagination\[page\]=1&/.test(url) ? { json: { data: [sien, autre] } } : { json: { data: [] } }, async () => {
    const r = await ch.listerFils({ propertyId: 'P' })
    assert.deepStrictEqual(r.fils.map(f => f.id), ['sien'])
    assert.strictEqual(r.autres_biens, 1)
    assert.ok(!JSON.stringify(r).includes('Voyageur etranger'))
  })
})

test('listerFils : le dernier mouvement d\'un fil est le plus récent de ses trois instants (review 1, J2)', async () => {
  const ch = channexFrais()
  const th = thread('t', { attributes: {
    last_message_received_at: '2026-10-01T10:00:00.000000',
    updated_at: '2026-11-05T08:00:00.000000',
    last_message: { inserted_at: '2026-11-03T09:00:00.000000' },
  } })
  await avecFetch(url => /pagination\[page\]=1&/.test(url) ? { json: { data: [th] } } : { json: { data: [] } }, async () => {
    const r = await ch.listerFils({ propertyId: 'P' })
    assert.strictEqual(Date.parse(r.fils[0].derniere), Date.parse('2026-11-05T08:00:00Z'))
  })
})

test('les deux lecteurs s\'arrêtent à l\'échéance et se déclarent incomplets (review 1, C1)', async () => {
  const ch = channexFrais()
  await avecFetch(() => ({ json: { data: [thread('t1')] } }), async (appels) => {
    const passee = Date.now() - 1
    const f = await ch.listerFils({ propertyId: 'P', echeance: passee })
    assert.deepStrictEqual([f.ok, f.complet, f.interrompu], [true, false, true])
    const m = await ch.idsDesMessagesDuFil('T', { echeance: passee })
    assert.deepStrictEqual([m.ok, m.complet, m.interrompu], [true, false, true])
    assert.strictEqual(appels.length, 0)
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

const FONDATEUR = 'fondateur@exemple.fr'
// ⚠ L'IDENTIFIANT DEMANDE PAR LE CLIENT N'EST PAS LA CLE DU PARTENAIRE (review 1,
// T2) : avec la meme valeur des deux cotes, un code qui lirait la requete au
// lieu du bien resolu par la garde passerait.
const BIEN = { id: 'u-bien-uuid', user_id: 'compte-1', name: 'La bulle', provider: 'channex', provider_property_id: 'P-chx' }
const QUERY = { check: 'demandes', property_id: 'u-bien-uuid' }

const ligne = (id, extra = {}) => ({
  id, user_id: 'compte-1', property_id: 'P-chx', booking_id: null, provider_msg_id: null,
  direction: 'inbound', sent_at: '2026-09-01T10:00:00+00:00', body: 'TEXTE-PRIVE-' + id, ...extra,
})

function lignesDuCoeur (n) {
  return Array.from({ length: n }, (_, i) => ligne(String(i).padStart(6, '0'), { provider_msg_id: i < 2 ? 'm' + (i + 1) : null }))
}

// Le double APPLIQUE ses filtres (REVIEW.md regle 22) : une ligne d'un autre
// compte, d'un autre bien ou avec reservation ne doit pas compter.
function charger ({
  garde = { ok: true, bien: BIEN, email: FONDATEUR },
  fondateur = FONDATEUR,
  lignes = lignesDuCoeur(3),
  erreurCoeur = null,
  fils = [{ id: 'd1', booking: null, derniere: '2026-11-10T10:00:00Z' }, { id: 'r1', booking: 'B1', derniere: '2026-11-10T10:00:00Z' }],
  liste = null,
  ids = (id) => ({ ok: true, complet: true, ids: id === 'd1' ? ['m1'] : ['m2'] }),
  fiche = undefined,
} = {}) {
  process.env.FOUNDER_EMAIL = fondateur || ''
  const etat = { requetes: [], gardeArgs: null, appelsProvider: [], providerDemande: null }
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'x' } }, error: null }) },
    from (table) {
      const f = { table, preds: [], gt: null, limite: null, desc: [] }
      const q = {
        select () { return q },
        eq (c, v) { f.desc.push(['eq', c, v]); f.preds.push(l => l[c] === v); return q },
        is (c, v) { f.desc.push(['is', c, v]); f.preds.push(l => l[c] === v); return q },
        not (c, op, v) { f.desc.push(['not', c, op, v]); f.preds.push(l => l[c] !== v); return q },
        in (c, vals) { f.desc.push(['in', c, vals.length]); f.preds.push(l => vals.includes(l[c])); return q },
        order () { return q },
        gt (c, v) { f.gt = v; f.preds.push(l => l[c] > v); return q },
        limit (n) { f.limite = n; return q },
        then (ok, ko) {
          etat.requetes.push(f)
          if (erreurCoeur) return Promise.resolve({ data: null, error: { message: erreurCoeur } }).then(ok, ko)
          const rangs = lignes.filter(l => f.preds.every(p => p(l))).sort((a, b) => a.id < b.id ? -1 : 1).slice(0, f.limite || 1000)
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
  const filsNormalises = fils.map(x => ({ ota: 'airbnb', titre: 'T', ferme: false, nbMessages: 2, ...x }))
  const ficheParDefaut = {
    listerFils: async (ctx) => { etat.appelsProvider.push(['listerFils', ctx]); return liste || { ok: true, complet: true, autres_biens: 0, fils: filsNormalises } },
    idsDesMessagesDuFil: async (id, opts) => { etat.appelsProvider.push(['ids', id, opts]); return ids(id) },
  }
  remplacer(path.join(__dirname, '..', 'lib/channels/index.js'), {
    getProvider: (nom) => {
      etat.providerDemande = nom
      if (fiche !== undefined) return fiche
      return ficheParDefaut
    },
  })
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

async function appeler (opts = {}, query = QUERY) {
  const { handler, etat } = charger(opts)
  const res = reponse()
  await handler({ method: 'GET', query, headers: {} }, res)
  return { res, etat }
}

test('diagnostic demandes : la garde porte le domaine messages et le bien venu du client, et un refus n\'appelle PAS le partenaire', async () => {
  const { res, etat } = await appeler({ garde: { ok: false, code: 403 } }, { check: 'demandes', property_id: ' u-bien-uuid ' })
  assert.strictEqual(res.code, 403)
  assert.deepStrictEqual(etat.gardeArgs, { domaine: 'messages', niveau: 'read', bien: 'u-bien-uuid', bienRequis: true })
  assert.strictEqual(etat.appelsProvider.length, 0)
  assert.strictEqual(etat.requetes.length, 0)
})

test('diagnostic demandes : un paramètre répété ne fait pas planter avant la garde (review 1, M2)', async () => {
  const { res, etat } = await appeler({}, { check: 'demandes', property_id: ['u-bien-uuid', 'autre'] })
  assert.strictEqual(res.code, 200)
  assert.strictEqual(etat.gardeArgs.bien, 'u-bien-uuid')
})

test('diagnostic demandes : réservé au fondateur — un membre autorisé sur le bien est refusé en 403, sans un seul appel (review 1, S2)', async () => {
  const membre = await appeler({ garde: { ok: true, bien: BIEN, email: 'membre@exemple.fr' } })
  assert.strictEqual(membre.res.code, 403)
  assert.deepStrictEqual(membre.etat.appelsProvider, [])
  assert.strictEqual(membre.etat.requetes.length, 0)
  const sansConfig = await appeler({ fondateur: '' })
  assert.strictEqual(sansConfig.res.code, 403)
  assert.match(sansConfig.res.body.motif, /FOUNDER_EMAIL/)
  assert.deepStrictEqual(sansConfig.etat.appelsProvider, [])
})

test('diagnostic demandes : le provider vient du BIEN, et un provider sans fils est refusé en 400 sans appel ni nom de partenaire (review 1, M1)', async () => {
  const { res, etat } = await appeler({ garde: { ok: true, bien: { ...BIEN, provider: 'beds24' }, email: FONDATEUR }, fiche: { getReservations () {} } })
  assert.strictEqual(etat.providerDemande, 'beds24')
  assert.strictEqual(res.code, 400)
  assert.ok(!/channex/i.test(res.body.error))
  assert.strictEqual(etat.requetes.length, 0)
})

test('diagnostic demandes : tout passe par le bien RÉSOLU (clé partenaire), jamais par la valeur du client (review 1, T2)', async () => {
  const { res, etat } = await appeler()
  assert.strictEqual(res.code, 200, JSON.stringify(res.body))
  assert.strictEqual(etat.providerDemande, 'channex')
  const liste = etat.appelsProvider.find(a => a[0] === 'listerFils')
  assert.strictEqual(liste[1].propertyId, 'P-chx')
  assert.ok(Number.isFinite(liste[1].echeance))
  assert.strictEqual(res.body.bien, 'P-chx')
  for (const r of etat.requetes) {
    assert.ok(r.desc.some(d => d[0] === 'eq' && d[1] === 'property_id' && d[2] === 'P-chx'), JSON.stringify(r.desc))
    assert.ok(r.desc.some(d => d[0] === 'eq' && d[1] === 'user_id' && d[2] === 'compte-1'), JSON.stringify(r.desc))
  }
})

test('diagnostic demandes : lit le cœur PAR CURSEUR au-delà de 1000 lignes, et ne compte ni un autre compte, ni un autre bien, ni une ligne avec réservation (review 1, T4)', async () => {
  const lignes = [
    ...lignesDuCoeur(1500),
    ligne('zz-autre-compte', { user_id: 'compte-2' }),
    ligne('zz-autre-bien', { property_id: 'P-autre' }),
    ligne('zz-avec-resa', { booking_id: 'B9', provider_msg_id: 'm99' }),
  ]
  const { res, etat } = await appeler({ lignes })
  assert.strictEqual(res.code, 200, JSON.stringify(res.body))
  const lectures = etat.requetes.filter(r => r.desc.some(d => d[0] === 'is' && d[1] === 'booking_id'))
  assert.strictEqual(lectures.length, 2)
  assert.strictEqual(lectures[1].gt, '000999')
  assert.strictEqual(res.body.lignes_lues_completes, true)
  assert.strictEqual(res.body.lignes_sans_resa.total, 1500)
})

test('diagnostic demandes : la jumelle avec réservation est cherchée aux instants des copies webhook, sur le même compte et le même bien (review 1, J1)', async () => {
  const t = '2026-11-01T10:00:00+00:00'
  const lignes = [
    ligne('a1', { sent_at: t, body: 'Je réserve' }),
    ligne('a2', { sent_at: t, body: 'Je réserve', booking_id: 'B1', provider_msg_id: 'm7' }),
    // Meme instant, meme texte, mais un AUTRE compte : ne doit pas servir de jumelle.
    ligne('a3', { sent_at: '2026-11-02T10:00:00+00:00', body: 'Autre' }),
    ligne('a4', { sent_at: '2026-11-02T10:00:00+00:00', body: 'Autre', booking_id: 'B2', provider_msg_id: 'm8', user_id: 'compte-2' }),
  ]
  const { res } = await appeler({ lignes })
  assert.strictEqual(res.code, 200, JSON.stringify(res.body))
  assert.strictEqual(res.body.lignes_sans_resa.copies_webhook, 2)
  assert.strictEqual(res.body.lignes_sans_resa.copies_webhook_avec_jumelle, 1)
  assert.strictEqual(res.body.lignes_sans_resa.dont_jumelle_avec_resa, 1)
  assert.strictEqual(res.body.jumelles_lues_completes, true)
})

test('diagnostic demandes : un fil avec réservation qui n\'a pas bougé depuis le plus ancien message sans réservation n\'est pas lu (review 1, T3)', async () => {
  const lignes = [ligne('b1', { sent_at: '2026-10-05T10:00:00+00:00' }), ligne('b2', { sent_at: '2026-11-05T10:00:00+00:00' })]
  const fils = [
    { id: 'd1', booking: null, derniere: '2026-11-10T10:00:00Z' },
    { id: 'vieux', booking: 'B0', derniere: '2026-10-01T00:00:00Z' },
    { id: 'entre-deux', booking: 'B1', derniere: '2026-10-20T00:00:00Z' },
  ]
  const { res, etat } = await appeler({ lignes, fils })
  assert.strictEqual(res.code, 200, JSON.stringify(res.body))
  const lus = etat.appelsProvider.filter(a => a[0] === 'ids').map(a => a[1]).sort()
  // Le MINIMUM des instants borne la lecture : avec le maximum, « entre-deux » serait ecarte.
  assert.deepStrictEqual(lus, ['d1', 'entre-deux'])
  assert.deepStrictEqual(res.body.detail, { candidats: 2, lus: 2, tronque: false, interrompu: false })
})

test('diagnostic demandes : la réponse dit les demandes et les fils devenus réservations, sans aucun texte de message', async () => {
  const { res } = await appeler()
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.ok, true)
  assert.deepStrictEqual(res.body.fils, { total: 2, sans_resa: 1, avec_resa: 1, detail_incomplet: 0 })
  assert.strictEqual(res.body.demandes[0].chez_nous_sans_resa, 1)
  assert.deepStrictEqual(res.body.devenues_resa.map(d => d.fil), ['r1'])
  assert.strictEqual(res.body.fils_d_autres_biens_ecartes, 0)
  assert.ok(!JSON.stringify(res.body).includes('TEXTE-PRIVE'))
})

test('diagnostic demandes : le cœur illisible rend 503, la liste illisible chez le partenaire rend 502 — jamais un faux zéro', async () => {
  const coeur = await appeler({ erreurCoeur: 'panne' })
  assert.strictEqual(coeur.res.code, 503)
  assert.deepStrictEqual(coeur.etat.appelsProvider, [])
  const partenaire = await appeler({ liste: { ok: false, erreur: 'messages_app_absent', fils: [], complet: false } })
  assert.strictEqual(partenaire.res.code, 502)
  assert.strictEqual(partenaire.res.body.motif, 'messages_app_absent')
})

test('diagnostic demandes : un détail en échec est compté incomplet, une échéance atteinte se dit « interrompu »', async () => {
  const echec = await appeler({ ids: (id) => id === 'd1' ? { ok: false, erreur: 'HTTP 500', ids: [], complet: false } : { ok: true, complet: true, ids: [] } })
  assert.strictEqual(echec.res.body.fils.detail_incomplet, 1)
  assert.strictEqual(echec.res.body.demandes[0].lu, false)
  const coupe = await appeler({ ids: () => ({ ok: true, complet: false, interrompu: true, ids: [] }) })
  assert.strictEqual(coupe.res.body.detail.interrompu, true)
})

test('diagnostic demandes : au-delà de 60 fils à lire, la lecture est plafonnée et le dit', async () => {
  const fils = Array.from({ length: 65 }, (_, i) => ({ id: 'd' + i, booking: null, derniere: '2026-11-10T10:00:00Z' }))
  const { res, etat } = await appeler({ fils, ids: () => ({ ok: true, complet: true, ids: [] }) })
  assert.strictEqual(etat.appelsProvider.filter(a => a[0] === 'ids').length, 60)
  assert.deepStrictEqual(res.body.detail, { candidats: 65, lus: 60, tronque: true, interrompu: false })
})
