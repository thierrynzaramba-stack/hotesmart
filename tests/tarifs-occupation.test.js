// tests/tarifs-occupation.test.js
// Le supplement par voyageur d'un logement vendu « par personne », et le renvoi
// des prix par date quand l'occupation change.
// Spec : docs/specs/spec-supplement-voyageur.md
//
// ⚠ LE CAS QUI A OUVERT LE LOT (20 novembre 2026). Le 23 : 6 voyageurs, 4
// inclus, 2 EUR de supplement, pas de prix de base. Les canaux ne lisent que
// l'occupation 6 : tout voyageur payait 89 EUR pour 85 EUR saisis. La fiche
// refusait d'y toucher (409 `grille_non_reconstructible`), et Channex interdit
// de changer le mode de vente d'un plan (422 mesure sur staging).

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CHANNEL_BASE_URL = 'https://canal.test/api/v1'
process.env.CHANNEL_API_KEY = 'cle-de-test'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')

const T = require('../lib/tarifs-occupation')
const { fenetrePoussee, JOURS_POUSSES } = require('../lib/channel-fullsync')

// La grille du plan de base du 23 telle que Channex la rend (montants en chaine).
const GRILLE_23 = [
  { occupancy: 6, rate: '94.00', is_primary: true },
  { occupancy: 5, rate: '92.00', is_primary: false },
  { occupancy: 4, rate: '90.00', is_primary: false },
  { occupancy: 3, rate: '90.00', is_primary: false },
  { occupancy: 2, rate: '90.00', is_primary: false },
  { occupancy: 1, rate: '90.00', is_primary: false }
]

// ─── Regles pures ──────────────────────────────────────────────────────────

test('le mode demande suit la regle de buildRatePlanOptions, au cas pres', () => {
  // Les deux doivent dire la meme chose : c'est la grille de la fiche qu'on
  // confronte au mode reel du plan. On execute la VRAIE fonction de l'endpoint.
  const src = fs.readFileSync(path.join(__dirname, '..', 'api/channel-property.js'), 'utf8')
  const debut = src.indexOf('function buildRatePlanOptions(')
  const fin = src.indexOf('\n}\n', debut) + 2
  assert.ok(debut > 0 && fin > debut, 'buildRatePlanOptions doit exister dans l endpoint')
  const ctx = {}
  vm.runInNewContext(src.slice(debut, fin) + '\nthis.f = buildRatePlanOptions', ctx)
  for (const fee of [null, undefined, 0, -1, 0.5, 2, 10]) {
    assert.equal(T.modeDeVenteDemande(fee), ctx.f(90, 4, fee, 6).sell_mode, `supplement ${fee}`)
  }
})

test('un plan par personne refuse une grille par logement, et dit quoi faire', () => {
  const r = T.refusModeDeVente('per_person', 'per_room', 6)
  assert.equal(r.http, 409)
  assert.equal(r.error, 'mode_de_vente_immuable')
  assert.match(r.message, /Voyageurs inclus/)
  assert.match(r.message, /\b6\b/, 'le nombre a saisir est dans la phrase')
})

test('un plan par logement refuse un supplement', () => {
  const r = T.refusModeDeVente('per_room', 'per_person', 4)
  assert.equal(r.error, 'mode_de_vente_immuable')
})

test('meme mode, ou mode inconnu : aucun refus', () => {
  assert.equal(T.refusModeDeVente('per_person', 'per_person', 6), null)
  assert.equal(T.refusModeDeVente('per_room', 'per_room', 6), null)
  assert.equal(T.refusModeDeVente(null, 'per_room', 6), null)
})

test('la base de la grille est la partie SANS supplement', () => {
  assert.equal(T.baseDeLaGrille(GRILLE_23, 4), 90, 'option a 4 voyageurs, pas la principale a 94')
  assert.equal(T.baseDeLaGrille(GRILLE_23, 6), 94)
  assert.equal(T.baseDeLaGrille(GRILLE_23, 9), 94, 'plus d inclus que d options : la plus haute')
})

test('plan par logement : la seule option fait la base', () => {
  assert.equal(T.baseDeLaGrille([{ occupancy: 6, rate: '120.00', is_primary: true }], 2), 120)
})

test('une grille sans montant ne fabrique pas de base', () => {
  assert.equal(T.baseDeLaGrille([], 4), null)
  assert.equal(T.baseDeLaGrille([{ occupancy: 6, rate: '0.00', is_primary: true }], 6), null)
  assert.equal(T.baseDeLaGrille(null, 4), null)
})

// ─── Renvoi des prix par date ───────────────────────────────────────────────

const BIEN_23 = { id: 'efe1daf1', base_price: null, prix_minimum: 5000 }

test('LE TEST QUI COMPTE : le 23 passe de 89 EUR a 85 EUR a l occupation 6', () => {
  const lignes = [{ date: '2026-12-02', rate: 85 }]
  const avant = T.valeursTarifs({ lignes, fenetre: ['2026-12-02'], bien: BIEN_23, propId: 'P', ratePlanId: 'R',
                                  capacite: 6, inclus: 4, supplement: 2 })
  const apres = T.valeursTarifs({ lignes, fenetre: ['2026-12-02'], bien: BIEN_23, propId: 'P', ratePlanId: 'R',
                                  capacite: 6, inclus: 6, supplement: 2 })
  const a6 = (v) => v.values[0].rates.find(r => r.occupancy === 6).rate
  assert.equal(a6(avant), 8900)
  assert.equal(a6(apres), 8500)
  assert.deepEqual(apres.values[0].rates.map(r => r.rate), [8500, 8500, 8500, 8500, 8500, 8500],
    'des rates[] PLATS : un rate seul ne mettrait a jour que l occupation principale')
})

test('le renvoi ne porte QUE des prix : ni fermeture, ni disponibilite, ni sejour', () => {
  const { values } = T.valeursTarifs({ lignes: [{ date: '2026-12-02', rate: 85 }], fenetre: ['2026-12-02'],
    bien: BIEN_23, propId: 'P', ratePlanId: 'R', capacite: 6, inclus: 6, supplement: 2 })
  assert.deepEqual(Object.keys(values[0]).sort(), ['date', 'property_id', 'rate_plan_id', 'rates'])
})

test('meme regle de prix que la poussee complete : sans prix, rien ; sous le plancher, rien', () => {
  const r = T.valeursTarifs({
    lignes: [{ date: 'a', rate: 85 }, { date: 'c', rate: 30 }, { date: 'd', rate: 0 }],
    fenetre: ['a', 'b', 'c', 'd'], bien: BIEN_23, propId: 'P', ratePlanId: 'R',
    capacite: 6, inclus: 6, supplement: 2
  })
  assert.deepEqual(r.values.map(v => v.date), ['a'])
  assert.deepEqual(r.ignorees, { sans_prix: 2, sous_plancher: 1 })
})

test('le prix de base sert les dates sans tarif, comme dans runFullSync', () => {
  const r = T.valeursTarifs({ lignes: [], fenetre: ['a'], bien: { ...BIEN_23, base_price: 100 },
    propId: 'P', ratePlanId: 'R', capacite: 6, inclus: 6, supplement: 2 })
  assert.equal(r.values[0].rates[0].rate, 10000)
})

test('sans supplement (plan par logement) : un rate seul', () => {
  const r = T.valeursTarifs({ lignes: [{ date: 'a', rate: 85 }], fenetre: ['a'], bien: BIEN_23,
    propId: 'P', ratePlanId: 'R', capacite: 6, inclus: 6, supplement: 0 })
  assert.equal(r.values[0].rate, 8500)
  assert.equal(r.values[0].rates, undefined)
})

test('la fenetre est celle de la poussee complete', () => {
  assert.equal(fenetrePoussee().length, JOURS_POUSSES)
})

test('une nuit fermee ou a stock nul n est pas une nuit affichee', () => {
  const r = T.valeursTarifs({
    lignes: [{ date: 'a', rate: 85 }, { date: 'b', rate: 85, stop_sell: true },
             { date: 'c', rate: 85, avail: 0 }, { date: 'd', rate: 85, avail: 1 }],
    fenetre: ['a', 'b', 'c', 'd', 'e'], bien: { ...BIEN_23, base_price: 100 }, propId: 'P', ratePlanId: 'R',
    capacite: 6, inclus: 6, supplement: 2
  })
  assert.deepEqual(r.values.map(v => v.date), ['a', 'b', 'c', 'd', 'e'], 'le prix part partout')
  assert.deepEqual(r.affichees, { a: 8500, d: 8500 }, 'sans ligne (e) : fermee a la poussee complete')
})

// Un double minimal de supabase pour le journal : bookings_snapshot et
// price_display_log, lectures et ecritures enregistrees.
function supabaseJournal ({ vendues = [], courantes = [], erreurLecture = null } = {}) {
  const ecrit = { inserts: [], updates: [] }
  const client = {
    from (table) {
      const q = {
        select () { return q }, eq () { return q }, in () { return q }, is () { return q },
        order () { return q }, range () { return q },
        update (u) { ecrit.updates.push(u); return q },
        insert: async (rows) => { ecrit.inserts.push(...rows); return { error: null } },
        then (ok, ko) {
          let r
          if (table === 'bookings_snapshot') {
            r = { data: vendues.map((v, i) => ({ booking_id: 'b' + i,
              snapshot: { status: 'confirmed', arrival: v[0], departure: v[1] } })), error: null }
          } else if (table === 'price_display_log') {
            r = erreurLecture ? { data: null, error: { message: erreurLecture } } : { data: courantes, error: null }
          } else r = { data: [], error: null }
          return Promise.resolve(r).then(ok, ko)
        }
      }
      return q
    }
  }
  return { client, ecrit }
}

test('le journal n ecrit que les nuits affichees et non vendues', async () => {
  const s = supabaseJournal({ vendues: [['2026-12-03', '2026-12-04']] })
  const bilan = await T.journaliser({ supabase: s.client, userId: 'U', propertyId: 'UUID', providerPropertyId: 'PP', unites: 1 },
    { '2026-12-02': 8500, '2026-12-03': 8500 })
  assert.deepEqual(s.ecrit.inserts.map(l => [l.stay_date, l.rate, l.source]), [['2026-12-02', 8500, 'host']])
  assert.equal(s.ecrit.inserts[0].user_id, 'U')
  assert.equal(bilan.ouvertes, 1)
})

test('un renvoi au meme prix de base ne laisse aucune ligne', async () => {
  const s = supabaseJournal({ courantes: [{ id: 1, stay_date: '2026-12-02', rate: 8500 }] })
  const bilan = await T.journaliser({ supabase: s.client, userId: 'U', propertyId: 'UUID', providerPropertyId: 'PP', unites: 1 },
    { '2026-12-02': 8500 })
  assert.equal(s.ecrit.inserts.length, 0)
  assert.equal(bilan.inchangees, 1)
})

test('un journal en panne ne fait pas echouer le renvoi, et le dit', async () => {
  const s = supabaseJournal({ erreurLecture: 'timeout' })
  const c = canal()
  const erreurs = []
  const origine = console.error
  console.error = (...a) => erreurs.push(a.join(' '))
  try {
    const r = await T.appliquerOccupation({ ...BASE_APPLIQUER, appel: c.appel,
      lireInventaire: async () => [{ date: '2026-12-02', rate: 85 }], fenetre: ['2026-12-02'],
      journal: { supabase: s.client, userId: 'U', propertyId: 'UUID', providerPropertyId: 'PP', unites: 1 } })
    assert.equal(r.ok, true, 'le prix EST parti')
    assert.ok(r.journal && r.journal.erreur)
  } finally {
    console.error = origine
  }
  assert.ok(erreurs.some(e => /JOURNAL DES PRIX NON ECRIT/.test(e)))
})

// ─── Ecriture chez le canal ────────────────────────────────────────────────

function canal ({ echecs = {} } = {}) {
  const appels = []
  const appel = async (method, chemin, body) => {
    appels.push({ method, chemin, body })
    const cle = `${method} ${chemin}`
    if (echecs[cle] === 'leve') throw new Error('ECONNRESET')
    if (echecs[cle]) return { ok: false, status: echecs[cle], json: {} }
    return { ok: true, status: 200, json: { data: [{ id: 'tache' }] } }
  }
  return { appel, appels }
}

const PLAN = { ok: true, mode: 'per_person', options: GRILLE_23 }
const GRILLE_PLATE = { sell_mode: 'per_person', options: [1, 2, 3, 4, 5, 6].map(o => ({ occupancy: o, rate: 9000, is_primary: o === 6 })) }
const BASE_APPLIQUER = {
  ratePlanId: 'R', planActuel: PLAN, grille: GRILLE_PLATE, renvoyer: true,
  lireInventaire: async () => [{ date: 'a', rate: 85 }, { date: 'b', rate: 95 }],
  fenetre: ['a', 'b'], bien: BIEN_23, propId: 'P', capacite: 6, inclus: 6, supplement: 2
}

test('grille puis prix, dans cet ordre, en un seul envoi de prix', async () => {
  const c = canal()
  const r = await T.appliquerOccupation({ ...BASE_APPLIQUER, appel: c.appel })
  assert.equal(r.ok, true)
  assert.equal(r.renvoyees, 2)
  assert.deepEqual(c.appels.map(a => `${a.method} ${a.chemin}`), ['PUT /rate_plans/R', 'POST /restrictions'])
  assert.equal(c.appels[1].body.values.length, 2)
})

test('sans renvoi demande (mode keep) : la grille seule', async () => {
  const c = canal()
  const r = await T.appliquerOccupation({ ...BASE_APPLIQUER, renvoyer: false, appel: c.appel })
  assert.equal(r.ok, true)
  assert.deepEqual(c.appels.map(a => a.method), ['PUT'])
})

test('LE DEMI-ETAT EST REFUSE : prix refuses -> grille d avant remise', async () => {
  const c = canal({ echecs: { 'POST /restrictions': 500 } })
  const r = await T.appliquerOccupation({ ...BASE_APPLIQUER, appel: c.appel })
  assert.equal(r.ok, false)
  assert.equal(r.http, 502)
  assert.equal(r.grille_remise, true)
  const remise = c.appels[2]
  assert.equal(`${remise.method} ${remise.chemin}`, 'PUT /rate_plans/R')
  assert.equal(remise.body.rate_plan.sell_mode, 'per_person')
  assert.deepEqual(remise.body.rate_plan.options.map(o => [o.occupancy, o.rate]),
    [[6, 9400], [5, 9200], [4, 9000], [3, 9000], [2, 9000], [1, 9000]], 'la grille relue, en centimes')
})

test('une coupure pendant l envoi des prix remet aussi la grille', async () => {
  const c = canal({ echecs: { 'POST /restrictions': 'leve' } })
  const r = await T.appliquerOccupation({ ...BASE_APPLIQUER, appel: c.appel })
  assert.equal(r.ok, false)
  assert.equal(r.grille_remise, true)
})

test('calendrier illisible : la grille est remise, aucun prix ne part', async () => {
  const c = canal()
  const r = await T.appliquerOccupation({ ...BASE_APPLIQUER, appel: c.appel,
    lireInventaire: async () => { throw new Error('timeout') } })
  assert.equal(r.ok, false)
  assert.ok(!c.appels.some(a => a.chemin === '/restrictions'))
  assert.equal(c.appels.filter(a => a.method === 'PUT').length, 2)
})

test('grille refusee : rien d autre ne part', async () => {
  const c = canal({ echecs: { 'PUT /rate_plans/R': 422 } })
  const r = await T.appliquerOccupation({ ...BASE_APPLIQUER, appel: c.appel })
  assert.equal(r.ok, false)
  assert.equal(c.appels.length, 1)
})

test('le plan illisible est un refus, pas une exception', async () => {
  const leve = await T.lirePlan(async () => { throw new Error('ECONNRESET') }, 'R')
  assert.equal(leve.ok, false)
  assert.equal(leve.http, 502)
  const vide = await T.lirePlan(async () => ({ ok: false, status: 404, json: {} }), 'R')
  assert.equal(vide.ok, false)
  const lu = await T.lirePlan(async () => ({ ok: true, json: { data: { attributes: { sell_mode: 'per_person', options: GRILLE_23 } } } }), 'R')
  assert.deepEqual([lu.ok, lu.mode, lu.options.length], [true, 'per_person', 6])
})

// ─── L'endpoint de la fiche, execute ───────────────────────────────────────

const COMPTE = '85e3a0ef-75bd-4c11-a3b7-e2811067dc36'
const PROP_23 = {
  id: 'efe1daf1-652c-4177-b29b-19f1db377c96', provider: 'channex',
  provider_property_id: '1655ab32-d339-413d-b8ff-b4ccbd2a7b66', migration_target_property_id: null,
  provider_room_type_id: 'rt-23', provider_rate_plan_id: 'ad0a594e-base',
  capacity: 6, base_price: null, prix_minimum: 5000, included_guests: 4, extra_guest_fee: 2,
  pilote_tarifaire: 'yieldflow', rate_sync_mode: 'managed'
}

function preparerEndpoint ({ prop = PROP_23, grille = GRILLE_23, echecs = {} } = {}) {
  const etat = { canal: [], updates: [], lectures: [], journal: [] }
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: COMPTE } }, error: null }) },
    from (table) {
      const q = {
        _t: table, _u: null,
        select () { return q }, eq () { return q }, gte () { return q }, lte () { return q },
        order () { return q }, is () { return q }, in () { return q }, or () { return q },
        range () { return q },
        insert: async (rows) => { etat.journal.push(...rows); return { error: null } },
        update (u) { q._u = u; return q },
        single: async () => {
          if (table === 'properties' && q._u) {
            etat.updates.push(q._u)
            return { data: { ...prop, ...q._u }, error: null }
          }
          if (table === 'properties') return { data: prop, error: null }
          return { data: null, error: null }
        },
        maybeSingle: async () => ({ data: null, error: null }),
        then (ok, ko) {
          etat.lectures.push(table)
          const data = table === 'calendar_inventory'
            ? fenetrePoussee().slice(0, 3).map(d => ({ date: d, rate: 85 }))
            : []
          return Promise.resolve({ data, error: null }).then(ok, ko)
        }
      }
      return q
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  delete require.cache[require.resolve('../api/channel-property')]
  const rp = require('../lib/require-permission')
  rp.requirePermission = async () => ({ ok: true, accountUserId: COMPTE, bien: { id: prop.id } })
  require('../lib/reponse-partenaire').surveillerReponse = async () => {}

  globalThis.fetch = async (url, opts = {}) => {
    const chemin = String(url).replace(process.env.CHANNEL_BASE_URL, '')
    const methode = opts.method || 'GET'
    etat.canal.push({ methode, chemin, body: opts.body ? JSON.parse(opts.body) : null })
    const statut = echecs[`${methode} ${chemin}`]
    const corps = (methode === 'GET' && chemin.startsWith('/rate_plans/'))
      ? { data: { attributes: { sell_mode: 'per_person', options: grille } } }
      : { data: [{ id: 'tache' }] }
    return { ok: !statut, status: statut || 200, text: async () => JSON.stringify(corps) }
  }
  return etat
}

function reponse () {
  const r = { statut: null, corps: null, entetes: {} }
  return Object.assign(r, {
    setHeader (k, v) { r.entetes[k] = v },
    status (s) { r.statut = s; return r },
    json (c) { r.corps = c; return r },
    end () { return r }
  })
}

async function patch (corps, opts) {
  const etat = preparerEndpoint(opts)
  const res = reponse()
  await require('../api/channel-property')({
    method: 'PATCH', headers: { authorization: 'Bearer tok' }, query: {},
    body: { property_id: PROP_23.id, ...corps }
  }, res)
  return { etat, res }
}

test('LE GESTE DE RECETTE : « Voyageurs inclus » a 6 sur le 23, sans prix de base', async () => {
  const { etat, res } = await patch({ included_guests: 6 })
  assert.equal(res.statut, 200, JSON.stringify(res.corps))
  const ordre = etat.canal.map(a => `${a.methode} ${a.chemin}`)
  assert.deepEqual(ordre, ['GET /rate_plans/ad0a594e-base', 'PUT /rate_plans/ad0a594e-base', 'POST /restrictions'])
  const grille = etat.canal[1].body.rate_plan
  assert.equal(grille.sell_mode, 'per_person', 'le mode de vente ne change pas')
  assert.deepEqual(grille.options.map(o => o.rate), [9000, 9000, 9000, 9000, 9000, 9000],
    'grille plate, montant lu chez le canal (option a 4 voyageurs)')
  const values = etat.canal[2].body.values
  assert.equal(values.length, 3)
  for (const v of values) {
    assert.deepEqual(v.rates.map(r => r.rate), [8500, 8500, 8500, 8500, 8500, 8500])
    assert.equal(v.property_id, PROP_23.provider_property_id)
    assert.equal(v.stop_sell, undefined)
  }
  assert.equal(etat.updates.length, 1)
  assert.equal(etat.updates[0].included_guests, 6)
  assert.equal(etat.updates[0].base_price, null, 'aucun prix de base invente en base')
  assert.equal(res.corps.tarifs_renvoyes, 3)
  assert.equal(res.corps.note, undefined, 'la grille a ete reconstruite : pas de note d echec')
  assert.deepEqual(etat.journal.map(l => [l.rate, l.user_id, l.property_id]),
    [[8500, COMPTE, PROP_23.id], [8500, COMPTE, PROP_23.id], [8500, COMPTE, PROP_23.id]],
    'journal sur le compte de la garde et l UUID du bien')
})

test('supplement a 0 sur un plan par personne : refus clair, RIEN n est ecrit', async () => {
  const { etat, res } = await patch({ extra_guest_fee: 0 })
  assert.equal(res.statut, 409)
  assert.equal(res.corps.error, 'mode_de_vente_immuable')
  assert.deepEqual(etat.canal.map(a => a.methode), ['GET'])
  assert.equal(etat.updates.length, 0)
})

test('le defaut latent : meme AVEC un prix de base, supplement a 0 n atteint plus le canal', async () => {
  const { etat, res } = await patch({ extra_guest_fee: 0 }, { prop: { ...PROP_23, base_price: 85 } })
  assert.equal(res.statut, 409)
  assert.ok(!etat.canal.some(a => a.methode === 'PUT'))
})

test('prix refuses par le canal : 502, grille remise, base intacte', async () => {
  const { etat, res } = await patch({ included_guests: 6 }, { echecs: { 'POST /restrictions': 500 } })
  assert.equal(res.statut, 502)
  assert.equal(res.corps.error, 'tarifs_non_renvoyes')
  const puts = etat.canal.filter(a => a.methode === 'PUT')
  assert.equal(puts.length, 2)
  assert.deepEqual(puts[1].body.rate_plan.options.map(o => o.rate), [9400, 9200, 9000, 9000, 9000, 9000])
  assert.equal(etat.updates.length, 0)
})

test('la capacite reste refusee sans prix de base, avant tout appel au canal', async () => {
  const { etat, res } = await patch({ capacity: 5 })
  assert.equal(res.statut, 409)
  assert.equal(res.corps.error, 'grille_non_reconstructible')
  assert.equal(etat.canal.length, 0)
})

test('une grille sans montant chez le canal : refus, rien d ecrit', async () => {
  const { etat, res } = await patch({ included_guests: 6 },
    { grille: [{ occupancy: 6, rate: '0.00', is_primary: true }] })
  assert.equal(res.statut, 409)
  assert.equal(res.corps.error, 'grille_non_reconstructible')
  assert.ok(!etat.canal.some(a => a.methode !== 'GET'))
  assert.equal(etat.updates.length, 0)
})

test('en « je garde mes prix » : la grille suit, aucun prix ne part', async () => {
  const { etat, res } = await patch({ included_guests: 6 }, { prop: { ...PROP_23, rate_sync_mode: 'keep' } })
  assert.equal(res.statut, 200)
  assert.ok(!etat.canal.some(a => a.chemin === '/restrictions'))
  assert.equal(etat.updates.length, 1)
})

test('rien ne change dans l occupation : aucun renvoi de prix', async () => {
  const { etat, res } = await patch({ included_guests: 4 })
  assert.equal(res.statut, 200)
  assert.ok(!etat.canal.some(a => a.chemin === '/restrictions'))
})
