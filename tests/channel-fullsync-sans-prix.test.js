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
  lte () { return fauxSupabase }, order () { return fauxSupabase },
  then (r) { return Promise.resolve({ data: INVENTAIRE, error: null }).then(r) }
}
require('../lib/cron-shared').supabase = fauxSupabase

const { runFullSync } = require('../lib/channel-fullsync')

const BIEN = {
  id: 'uuid-bien', user_id: 'uuid-hote', name: 'Test',
  provider_property_id: 'prop-1', provider_room_type_id: 'rt-1', provider_rate_plan_id: 'rp-1',
  capacity: 4, included_guests: 4, extra_guest_fee: 0
}

// Capture les payloads envoyes vers le canal.
function harnais ({ inventaire = [] } = {}) {
  INVENTAIRE = inventaire
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
  return { envois, restore: () => { global.fetch = vraiFetch; INVENTAIRE = [] } }
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
