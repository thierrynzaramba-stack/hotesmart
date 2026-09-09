// tests/migration-mode-prix.test.js
// ETAPE « qui gere les prix » — assistant de migration.
//
// Elle existe parce que `api/channel-property.js` refuse ce reglage a tout bien
// pas encore chez le canal : un bien en migration etait dans l'angle mort, et le
// seul recours aurait ete d'ecrire en base a la main.

const test = require('node:test')
const assert = require('node:assert')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'https://api.exemple'
process.env.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY || 'cle-test'

// ⚠ AVANT le require : `channel-fullsync` capture `supabase` a l'import.
let INVENTAIRE = []
const fauxCoeur = {
  from () { return fauxCoeur }, select () { return fauxCoeur }, eq () { return fauxCoeur },
  gte () { return fauxCoeur }, lte () { return fauxCoeur }, not () { return fauxCoeur },
  order () { return fauxCoeur },
  then (r) { return Promise.resolve({ data: INVENTAIRE, error: null }).then(r) }
}
require('../lib/cron-shared').supabase = fauxCoeur

const { changerModeDePrix, etatModeDePrix, raisonDeNePasChanger } = require('../lib/migration-mode-prix')

const EN_MIGRATION = {
  id: 'uuid-23', user_id: 'uuid-hote', name: 'coeur de vie 23', provider: 'beds24',
  provider_property_id: '169567', migration_target_property_id: 'chx-cible',
  provider_room_type_id: 'chx-rt', provider_rate_plan_id: 'chx-rp',
  capacity: 6, included_guests: 4, extra_guest_fee: 10, base_price: null,
  rate_sync_mode: 'keep'
}

// Faux Supabase : sert l'inventaire et les snapshots, et NOTE ce qu'on ecrit.
function fauxBase ({ inventaire = [], sejours = [] } = {}) {
  const ecrits = []
  const bornes = []
  let table = null
  const api = {
    from (t) { table = t; return api },
    select () { return api }, eq () { return api },
    gte (c, v) { bornes.push(v); return api },
    lte (c, v) { bornes.push(v); return api },
    not () { return api }, order () { return api },
    range: async () => ({ data: sejours, error: null }),
    limit: async () => ({ data: inventaire, error: null }),
    update (patch) { ecrits.push({ table, patch }); return { eq: async () => ({ error: null }) } },
    then (r) { return Promise.resolve({ data: inventaire, error: null }).then(r) }
  }
  return { api, ecrits, bornes }
}

const canaux = (n = 0) => async (m, chemin) => {
  if (chemin.startsWith('/channels')) {
    return { ok: true, status: 200, json: { data: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, attributes: { is_active: true } })) } }
  }
  return { ok: true, status: 200, json: { data: [{ id: 'task-1' }] } }
}

// ─── Les refus ──────────────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : hors migration, l etape refuse et renvoie au bon endroit', async () => {
  // Deux portes vers la meme colonne finiraient par se contredire.
  const vif = { ...EN_MIGRATION, provider: 'channex', provider_property_id: 'chx-cible' }
  const r = raisonDeNePasChanger(vif, 'managed')
  assert.equal(r.raison, 'pas_en_migration')
  assert.match(r.message, /reglages du bien/)
})

test('un mode inconnu est refuse en nommant les valeurs possibles', () => {
  const r = raisonDeNePasChanger(EN_MIGRATION, 'auto')
  assert.equal(r.raison, 'mode_invalide')
  assert.match(r.message, /keep/)
  assert.match(r.message, /managed/)
})

test('idempotence : deja dans ce mode', () => {
  assert.equal(raisonDeNePasChanger({ ...EN_MIGRATION, rate_sync_mode: 'managed' }, 'managed').raison,
    'deja_dans_ce_mode')
})

// ─── L'apercu ───────────────────────────────────────────────────────────────

test('dry run par defaut : rien n est ecrit, et l apercu dit ce qui partirait', async () => {
  INVENTAIRE = [{ date: '2026-09-09', rate: 109 }]
  const b = fauxBase({ inventaire: [{ date: '2026-09-09', rate: 109 }] })
  const r = await changerModeDePrix(b.api, EN_MIGRATION, 'managed', { appel: canaux(0) })
  assert.equal(r.dry_run, true)
  assert.equal(b.ecrits.length, 0, 'aucune ecriture en base')
  assert.equal(r.apercu.mode_demande, 'managed')
  assert.ok(r.apercu.ce_qui_partirait.dates_fermees_faute_de_prix > 0,
    'les dates sans prix partiraient fermees, et on le DIT')
})

test('LE TEST QUI COMPTE : l apercu nomme les nuits DEJA VENDUES', async () => {
  // `calendar_inventory.avail` vaut NULL sur les biens amorces, et la poussee
  // traduit NULL par « disponible ». Une nuit vendue peut donc etre remise en
  // vente des qu'un canal existe. L'hote doit le voir avant de signer.
  const inventaire = [{ date: '2026-09-11', rate: 110 }, { date: '2026-09-13', rate: 89 }]
  INVENTAIRE = inventaire
  const b = fauxBase({ inventaire, sejours: [
    { booking_id: 'b1', snapshot: { arrival: '2026-09-11', departure: '2026-09-12', status: 'confirmed' } }
  ] })
  const r = await changerModeDePrix(b.api, EN_MIGRATION, 'managed', { appel: canaux(0) })
  assert.equal(r.apercu.nuits_vendues.total, 1)
  assert.deepEqual(r.apercu.nuits_vendues.dates, ['2026-09-11'])
  assert.match(r.apercu.nuits_vendues.avertissement, /DISPONIBLES/)
})

test('passer en « je garde mes prix » n envoie rien : pas d apercu de poussee', async () => {
  const b = fauxBase()
  const r = await changerModeDePrix(b.api, { ...EN_MIGRATION, rate_sync_mode: 'managed' }, 'keep',
    { appel: canaux(0) })
  assert.equal(r.ok, true)
  assert.equal(r.apercu.ce_qui_partirait, undefined)
  assert.match(r.apercu.effet, /Plus aucun tarif/)
})

// ─── Le geste ───────────────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : l execution n ecrit QUE le mode', async () => {
  // Cette etape ne touche ni le provider, ni les identifiants, ni le calendrier.
  INVENTAIRE = [{ date: '2026-09-09', rate: 109 }]
  const b = fauxBase({ inventaire: [{ date: '2026-09-09', rate: 109 }] })
  const r = await changerModeDePrix(b.api, EN_MIGRATION, 'managed', { dryRun: false, appel: canaux(0) })
  assert.equal(r.ok, true)
  assert.equal(b.ecrits.length, 1)
  assert.deepEqual(Object.keys(b.ecrits[0].patch), ['rate_sync_mode'])
  assert.equal(b.ecrits[0].patch.rate_sync_mode, 'managed')
  assert.equal(b.ecrits[0].table, 'properties')
})

test('le geste ne declenche AUCUNE poussee', async () => {
  INVENTAIRE = [{ date: '2026-09-09', rate: 109 }]
  const b = fauxBase({ inventaire: [{ date: '2026-09-09', rate: 109 }] })
  const vraiFetch = global.fetch
  let ecritures = 0
  global.fetch = async (url, opts) => {
    if (opts && opts.method && opts.method !== 'GET') ecritures++
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{"data":[]}' }
  }
  try {
    const r = await changerModeDePrix(b.api, EN_MIGRATION, 'managed', { dryRun: false })
    assert.equal(r.ok, true)
    assert.equal(ecritures, 0, 'aucune ecriture chez le provider')
    assert.match(r.note, /geste a part/)
  } finally { global.fetch = vraiFetch }
})

// ─── L'etat ─────────────────────────────────────────────────────────────────

test('l etat dit la consequence de rester en « keep »', () => {
  const e = etatModeDePrix(EN_MIGRATION)
  assert.equal(e.etat, 'a_faire')
  assert.match(e.message, /vendable nulle part/)
})

test('l etape est SANS OBJET pour un bien qui ne migre pas', () => {
  assert.equal(etatModeDePrix({ ...EN_MIGRATION, provider: 'channex', provider_property_id: 'chx-cible' }).etat,
    'sans_objet')
})

test('l etape « qui gere les prix » precede la poussee dans l assistant', () => {
  // Publier des tarifs suppose d'avoir choisi que HoteSmart les gere.
  const fs = require('node:fs'); const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/migration-etapes.js'), 'utf8')
  assert.ok(src.indexOf('etatModePrix(bien)') < src.indexOf('await etatPousseeAri(supabase, bien, opts)'))
})

// ─── L avertissement reproduit la REGLE de la poussee, pas une approximation ─

test('LE TEST QUI COMPTE : un bien a prix de base — toutes ses nuits vendues partiraient ouvertes', async () => {
  // Le cas manque par la premiere version : elle ne regardait que les dates
  // tarifees A L UNITE. Un bien qui n a qu un `base_price` en a zero — et
  // l apercu repondait « 0 nuit vendue » alors que la poussee tarife les 500
  // dates a ce prix et les ouvre toutes.
  const inventaire = [{ date: '2026-09-11', rate: null, avail: null }]
  INVENTAIRE = inventaire
  const b = fauxBase({ inventaire, sejours: [
    { booking_id: 'b1', snapshot: { arrival: '2026-09-11', departure: '2026-09-12', status: 'confirmed' } }
  ] })
  const r = await changerModeDePrix(b.api, { ...EN_MIGRATION, base_price: 86 }, 'managed',
    { appel: canaux(0) })
  assert.equal(r.apercu.nuits_vendues.total, 1)
  assert.deepEqual(r.apercu.nuits_vendues.dates, ['2026-09-11'])
})

test('une nuit que l hote a DEJA fermee n est pas signalee : la poussee enverra avail 0', async () => {
  // Crier a tort use l avertissement, et le jour ou il compte on ne le lit plus.
  const inventaire = [{ date: '2026-09-11', rate: 110, avail: 0 }]
  INVENTAIRE = inventaire
  const b = fauxBase({ inventaire, sejours: [
    { booking_id: 'b1', snapshot: { arrival: '2026-09-11', departure: '2026-09-12', status: 'confirmed' } }
  ] })
  const r = await changerModeDePrix(b.api, EN_MIGRATION, 'managed', { appel: canaux(0) })
  assert.equal(r.apercu.nuits_vendues.total, 0)
})

test('une nuit vendue SANS prix ne part pas vendable : elle n est pas signalee', async () => {
  // Sans prix, la date part en `stop_sell` — fermeture calculee. Elle est
  // annoncee disponible mais invendable : ce n est pas le risque decrit.
  const inventaire = [{ date: '2026-09-11', rate: null, avail: null }]
  INVENTAIRE = inventaire
  const b = fauxBase({ inventaire, sejours: [
    { booking_id: 'b1', snapshot: { arrival: '2026-09-11', departure: '2026-09-12', status: 'confirmed' } }
  ] })
  const r = await changerModeDePrix(b.api, EN_MIGRATION, 'managed', { appel: canaux(0) })
  assert.equal(r.apercu.nuits_vendues.total, 0)
})

test('l apercu inspecte la fenetre REELLEMENT poussee, pas une plus courte', async () => {
  // En inspecter moins, c est promettre sur ce qu on n a pas regarde : une
  // reservation a J+450 serait remise en vente sans que rien ne l ait dit.
  const { JOURS_POUSSES } = require('../lib/channel-fullsync')
  INVENTAIRE = []
  const b = fauxBase({ inventaire: [] })
  await changerModeDePrix(b.api, EN_MIGRATION, 'managed', { appel: canaux(0) })
  const attendu = new Date(); attendu.setHours(0, 0, 0, 0)
  attendu.setDate(attendu.getDate() + JOURS_POUSSES)
  const p = x => String(x).padStart(2, '0')
  const iso = `${attendu.getFullYear()}-${p(attendu.getMonth() + 1)}-${p(attendu.getDate())}`
  assert.ok(b.bornes.includes(iso), `la lecture va jusqu a J+${JOURS_POUSSES} (${iso})`)
})

test('un apercu impossible n empeche pas le geste : l ecriture n en depend pas', async () => {
  // `runFullSync` leve sur une simple erreur de lecture transitoire. Le reglage
  // d UNE colonne n a pas a en dependre.
  const casse = { from () { return casse }, select () { return casse }, eq () { return casse },
    gte () { return casse }, lte () { return casse }, not () { return casse }, order () { return casse },
    range: async () => ({ data: [], error: null }),
    limit: async () => ({ data: [], error: null }),
    update (patch) { casse.patch = patch; return { eq: async () => ({ error: null }) } },
    then (r) { return Promise.resolve({ data: null, error: { message: 'timeout' } }).then(r) } }
  const r = await changerModeDePrix(casse, EN_MIGRATION, 'managed', { dryRun: false, appel: canaux(0) })
  assert.equal(r.ok, true)
  assert.deepEqual(casse.patch, { rate_sync_mode: 'managed' })
})
