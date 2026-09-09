// tests/channel-fullsync-sans-prix.test.js
// La FERMETURE CALCULEE d'une date sans prix (arbitrage du 8 septembre 2026,
// rendu apres le verdict de docs/specs/protocole-staging-tarifs.md).
//
// Ce que le staging a mesure : omettre `rate` NE FERME RIEN — la date reste
// vendable au prix par defaut du rate plan. Et `rate: 0` n'est pas applique.
// Seul `stop_sell` ferme.

const test = require('node:test')
const assert = require('node:assert')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'https://api.exemple'
process.env.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY || 'cle-test'

// ⚠ ORDRE DE CHARGEMENT CRITIQUE. `channel-fullsync` fait
// `const { supabase } = require('./cron-shared')` : il COPIE la reference au
// moment de son propre chargement. Remplacer `cron-shared.supabase` apres coup
// n'a donc aucun effet — le module garde le vrai client, sort sur le reseau et
// echoue. On pose le faux AVANT de charger `channel-fullsync`.
let INVENTAIRE = []
const fauxSupabase = {
  from () { return fauxSupabase }, select () { return fauxSupabase },
  eq () { return fauxSupabase }, gte () { return fauxSupabase },
  // Le stock est CALCULE : le writer lit aussi les sejours confirmes.
  range: async () => ({ data: SEJOURS, error: null }),
  lte () { return fauxSupabase }, order () { return fauxSupabase },
  then (r) { return Promise.resolve({ data: INVENTAIRE, error: null }).then(r) }
}
require('../lib/cron-shared').supabase = fauxSupabase
let SEJOURS = []

const { runFullSync } = require('../lib/channel-fullsync')

const BIEN = {
  id: 'uuid-bien', user_id: 'uuid-hote', name: 'Test', provider: 'channex',
  migration_target_property_id: null, inventory_units: 1,
  provider_property_id: 'prop-1', provider_room_type_id: 'rt-1', provider_rate_plan_id: 'rp-1',
  capacity: 4, included_guests: 4, extra_guest_fee: 0
}

// Capture les payloads envoyes vers le canal.
function harnais ({ inventaire = [], sejours = [] } = {}) {
  INVENTAIRE = inventaire
  SEJOURS = sejours
  const envois = []
  const vraiFetch = global.fetch
  global.fetch = async (url, opts) => {
    envois.push({ url: String(url), corps: opts && opts.body ? JSON.parse(opts.body) : null })
    return {
      ok: true, status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ data: [{ id: 'task-1' }] })
    }
  }
  return { envois, restore: () => { global.fetch = vraiFetch; INVENTAIRE = []; SEJOURS = [] } }
}

// ⚠ LES VALEURS SONT COALESCEES EN PLAGES : elles portent `date_from`/`date_to`,
// jamais `date`. Chercher par `date` ne trouve rien — et un test qui ne trouve
// rien passe pour un test qui ne verifie rien.
function restrictionsEnvoyees (envois) {
  const r = envois.find(e => e.url.includes('/restrictions'))
  return r ? r.corps.values : []
}

function plagePour (envois, date) {
  return restrictionsEnvoyees(envois).find(v => v.date_from <= date && date <= v.date_to)
}

test('une date SANS prix part FERMEE, et sans champ rate', async () => {
  const h = harnais({ inventaire: [] })      // aucun prix nulle part
  try {
    const out = await runFullSync({ ...BIEN, base_price: null })
    const vals = restrictionsEnvoyees(h.envois)
    assert.ok(vals.length > 0, 'des restrictions sont poussees')
    const v = vals[0]
    assert.equal(v.stop_sell, true, 'la date est FERMEE — omettre rate ne ferme rien')
    assert.equal(v.rate, undefined, 'aucun rate declare')
    assert.equal(v.rates, undefined, 'aucune grille declaree')
    assert.equal(v.max_stay, 0, 'les autres champs restent presents (etat complet)')
    assert.ok(out.warnings.some(w => /fermee\(s\) faute de prix/.test(w)), 'le comportement est DIT')
  } finally { h.restore() }
})

test('une date AVEC prix part ouverte et tarifee', async () => {
  const h = harnais({ inventaire: [{ date: prochaine(0), rate: 120, avail: 1 }] })
  try {
    await runFullSync({ ...BIEN, base_price: null })
    const v = plagePour(h.envois, prochaine(0))
    assert.ok(v, 'la date tarifee est poussee')
    assert.equal(v.stop_sell, false, 'pas de fermeture calculee quand il y a un prix')
    assert.equal(v.rate, 12000, 'le prix part en cents')
  } finally { h.restore() }
})

test('un rate a 0 n est PAS un prix : la date est fermee, jamais vendue a 0', async () => {
  // Channex ignore `rate: 0` et garde le prix de la grille — mesure staging.
  // Pousser 0 vendait donc au tarif du rate plan, en silence.
  const h = harnais({ inventaire: [{ date: prochaine(0), rate: 0, avail: 1 }] })
  try {
    await runFullSync({ ...BIEN, base_price: null })
    const v = plagePour(h.envois, prochaine(0))
    assert.equal(v.stop_sell, true)
    assert.equal(v.rate, undefined, 'surtout pas un 0 qui serait ignore par Channex')
  } finally { h.restore() }
})

test('le prix de base sert de repli quand il existe', async () => {
  const h = harnais({ inventaire: [] })
  try {
    await runFullSync({ ...BIEN, base_price: 86 })
    const v = restrictionsEnvoyees(h.envois)[0]
    assert.equal(v.stop_sell, false, 'un bien avec prix de base ne ferme rien')
    assert.equal(v.rate, 8600)
  } finally { h.restore() }
})

// Le module pousse 500 jours a partir d'aujourd'hui : dates relatives, car il
// lit l'horloge (regle du depot).
//
// ⚠ EN HEURE LOCALE, comme `toLocalISO` du module — surtout pas `toISOString()`.
// Constate en direct le 8 septembre 2026 a 22 h UTC : il etait deja le 9 a
// Paris, `toISOString()` rendait « 2026-09-08 » quand le module poussait
// « 2026-09-09 », et le test ne trouvait plus la date qu'il venait de fournir.
// Un test qui ne trouve rien passe pour un test qui ne verifie rien.
function prochaine (n) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n)
  const p = x => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

test('APERCU : les memes 500 dates sont calculees, et RIEN ne part', async () => {
  // `dryRun` n'est pas un confort : c'est ce qui fait de la poussee une etape
  // d'assistant. Une seconde source de calcul « pour l'apercu » aurait fini par
  // montrer autre chose que ce qui part reellement.
  const h = harnais({ inventaire: [] })
  try {
    const out = await runFullSync({ ...BIEN, base_price: null }, { dryRun: true })
    assert.equal(h.envois.length, 0, 'aucun appel reseau')
    assert.equal(out.dry_run, true)
    assert.equal(out.pushed, false)
    assert.equal(out.days, 500)
    assert.equal(out.dates_fermees_faute_de_prix, 500, 'sans aucun prix, les 500 dates partiraient fermees')
    assert.equal(out.dates_tarifees, 0)
    assert.equal(out.cible, 'prop-1')
  } finally { h.restore() }
})

test('APERCU : la destination affichee est la propriete CIBLE pendant la migration', async () => {
  const h = harnais({ inventaire: [] })
  try {
    const out = await runFullSync({ ...BIEN, provider: 'beds24', provider_property_id: '209413',
      migration_target_property_id: 'chx-cible' }, { dryRun: true })
    assert.equal(out.cible, 'chx-cible')
  } finally { h.restore() }
})

test('un appelant qui oublie `provider` dans son SELECT est REFUSE, pas devine', async () => {
  const h = harnais({ inventaire: [] })
  try {
    const { provider, ...sansProvider } = BIEN
    await assert.rejects(() => runFullSync(sansProvider), /provider.*selectionnee/)
    // La destination depend de DEUX colonnes : l'autre est gardee pareil.
    const { migration_target_property_id, ...sansCible } = BIEN
    await assert.rejects(() => runFullSync(sansCible), /migration_target_property_id.*selectionnee/)
  } finally { h.restore() }
})

// ─── LE STOCK EST CALCULE, IL N'EST PAS LU ──────────────────────────────────
// Mesure du 9 septembre 2026 : 11 nuits VENDUES sur les deux biens de Bagneres
// repartaient annoncees disponibles a chaque poussee, parce que `avail` vaut
// NULL et que la regle traduisait NULL par « 1 place libre ». Chez Channex, qui
// decremente pourtant son stock a la confirmation, la poussee ECRASAIT sa
// decrementation.

const demain = (n) => {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n)
  const p = x => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function availPour (envois, date) {
  const a = envois.find(e => e.url.includes('/availability'))
  const v = (a ? a.corps.values : []).find(x => x.date_from <= date && date <= x.date_to)
  return v ? v.availability : undefined
}

test('LE TEST QUI COMPTE : une nuit VENDUE part fermee, meme si le coeur la dit libre', async () => {
  const h = harnais({
    inventaire: [{ date: demain(3), rate: 120, avail: null }],
    sejours: [{ booking_id: 'b1', snapshot: { arrival: demain(3), departure: demain(4), status: 'confirmed' } }]
  })
  try {
    const out = await runFullSync({ ...BIEN, base_price: null })
    assert.equal(availPour(h.envois, demain(3)), 0, 'la nuit vendue part a 0')
    assert.ok(out.warnings.some(w => /vendue/.test(w)), 'et le journal le DIT')
  } finally { h.restore() }
})

test('une nuit libre reste ouverte : le calcul plafonne, il n ouvre rien', async () => {
  const h = harnais({ inventaire: [{ date: demain(3), rate: 120, avail: null }], sejours: [] })
  try {
    await runFullSync({ ...BIEN, base_price: null })
    assert.equal(availPour(h.envois, demain(3)), 1)
  } finally { h.restore() }
})

test('une date sans ligne reste fermee — le stock calcule ne l ouvre pas', async () => {
  const h = harnais({ inventaire: [], sejours: [] })
  try {
    await runFullSync({ ...BIEN, base_price: null })
    assert.equal(availPour(h.envois, demain(10)), 0)
  } finally { h.restore() }
})

test('une nuit que l hote a fermee (avail 0) reste fermee', async () => {
  const h = harnais({ inventaire: [{ date: demain(3), rate: 120, avail: 0 }], sejours: [] })
  try {
    await runFullSync({ ...BIEN, base_price: null })
    assert.equal(availPour(h.envois, demain(3)), 0)
  } finally { h.restore() }
})

test('la nuit du DEPART se revend : elle n est pas occupee', async () => {
  const h = harnais({
    inventaire: [{ date: demain(3), rate: 120, avail: null }, { date: demain(4), rate: 120, avail: null }],
    sejours: [{ booking_id: 'b1', snapshot: { arrival: demain(3), departure: demain(4), status: 'confirmed' } }]
  })
  try {
    await runFullSync({ ...BIEN, base_price: null })
    assert.equal(availPour(h.envois, demain(3)), 0, 'la nuit du sejour est fermee')
    assert.equal(availPour(h.envois, demain(4)), 1, 'la nuit du depart reste vendable')
  } finally { h.restore() }
})

test('plusieurs unites : une vente en retire UNE, pas toutes', async () => {
  const h = harnais({
    inventaire: [{ date: demain(3), rate: 120, avail: null }],
    sejours: [{ booking_id: 'b1', snapshot: { arrival: demain(3), departure: demain(4), status: 'confirmed' } }]
  })
  try {
    await runFullSync({ ...BIEN, base_price: null, inventory_units: 3 })
    assert.equal(availPour(h.envois, demain(3)), 2)
  } finally { h.restore() }
})

test('un appelant qui oublie `inventory_units` est REFUSE : on ne devine pas un stock', async () => {
  const h = harnais({ inventaire: [] })
  try {
    const { inventory_units, ...sansUnites } = BIEN
    await assert.rejects(() => runFullSync(sansUnites), /inventory_units.*selectionnee/)
  } finally { h.restore() }
})
