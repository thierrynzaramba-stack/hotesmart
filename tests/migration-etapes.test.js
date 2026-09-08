// tests/migration-etapes.test.js
// L'assistant de migration : chaque etape sait dire son etat.
// Spec : docs/specs/spec-assistant-migration.md

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'

const { etatMigration } = require('../lib/migration-etapes')

// Faux client aussi pauvre que postgrest : rend { data, error }, ne throw pas.
// `reponses` est indexe par table ; chaque appel consomme la prochaine reponse.
function faux (reponses = {}) {
  let tableCourante = null
  const files = {}
  for (const [t, liste] of Object.entries(reponses)) files[t] = [...liste]
  const suivante = () => {
    const f = files[tableCourante]
    return (f && f.length) ? f.shift() : { data: [], error: null, count: 0 }
  }
  const api = {
    from (t) { tableCourante = t; return api },
    select () { return api }, eq () { return api }, gte () { return api },
    lte () { return api }, not () { return api }, is () { return api },
    order () { return api },
    limit: async () => suivante(),
    maybeSingle: async () => suivante(),
    then (r) { return Promise.resolve(suivante()).then(r) }
  }
  return api
}

const BIEN = {
  id: 'uuid-bien', user_id: 'uuid-hote', name: 'Test', provider: 'beds24',
  provider_property_id: '209413', capacity: 2, property_type: 'apartment',
  timezone: 'Europe/Paris', currency: 'EUR', base_price: null
}

test('un bien tout neuf : chaque etape dit ce qui manque, et quoi faire', async () => {
  const s = faux({
    bookings_snapshot: [{ count: 0, error: null }],
    property_snapshots: [{ data: null, error: null }],
    calendar_inventory: [{ data: [], error: null }, { data: [], error: null }]
  })
  const e = await etatMigration(s, { ...BIEN, capacity: null, property_type: null, timezone: null })

  const par = Object.fromEntries(e.etapes.map(x => [x.id, x]))
  assert.equal(par.rapatriement_reservations.etat, 'a_faire')
  assert.equal(par.rapatriement_fiche.etat, 'a_faire')
  assert.equal(par.fiche_unifiee.etat, 'a_faire')
  assert.match(par.fiche_unifiee.detail, /capacity/, 'les champs manquants sont NOMMES')
  assert.equal(par.amorcage_prix.etat, 'a_faire')
  assert.equal(par.garde_activation.etat, 'bloque')

  // « Non pret » sans motif envoie chercher au hasard.
  for (const x of e.etapes) {
    if (x.etat !== 'fait') assert.ok(x.detail && x.detail.length > 20, `${x.id} explique pourquoi`)
  }
})

test('des reservations sans payload brut ne comptent pas pour faites', async () => {
  // Un snapshot sans `raw` a perdu ce que le provider savait, et on ne le
  // retrouvera plus apres la deconnexion.
  const s = faux({
    bookings_snapshot: [{ count: 780, error: null }, { count: 12, error: null }],
    property_snapshots: [{ data: { raw: { a: 1 }, fetched_at: '2026-09-08' }, error: null }],
    calendar_inventory: [{ data: [{ date: '2026-09-10', rate: 120 }], error: null }, { data: [{ date: '2026-09-10', rate: 120 }], error: null }]
  })
  const e = await etatMigration(s, BIEN)
  const r = e.etapes.find(x => x.id === 'rapatriement_reservations')
  assert.equal(r.etat, 'a_faire')
  assert.match(r.detail, /12 sans payload brut/)
})

test('une panne de lecture BLOQUE, elle ne passe pas pour « rien a faire »', async () => {
  // postgrest ne throw pas : sans lire `error`, zero ligne et une base en panne
  // se ressemblent — et l'assistant dirait « a faire » sur un bien complet.
  const s = faux({
    bookings_snapshot: [{ count: null, error: { message: 'timeout' } }],
    property_snapshots: [{ data: null, error: { message: 'timeout' } }],
    calendar_inventory: [{ data: null, error: { message: 'timeout' } }, { data: null, error: { message: 'timeout' } }]
  })
  const e = await etatMigration(s, BIEN)
  assert.equal(e.etapes.find(x => x.id === 'rapatriement_reservations').etat, 'bloque')
  assert.equal(e.etapes.find(x => x.id === 'rapatriement_fiche').etat, 'bloque')
  assert.equal(e.etapes.find(x => x.id === 'amorcage_prix').etat, 'bloque')
})

test('un prix de base suffit a l etape prix, sans aucune date tarifee', async () => {
  const s = faux({
    bookings_snapshot: [{ count: 10, error: null }, { count: 0, error: null }],
    property_snapshots: [{ data: { raw: {}, fetched_at: '2026-09-08' }, error: null }],
    calendar_inventory: [{ data: [], error: null }, { data: [], error: null }]
  })
  const e = await etatMigration(s, { ...BIEN, base_price: 86 })
  const p = e.etapes.find(x => x.id === 'amorcage_prix')
  assert.equal(p.etat, 'fait')
  assert.match(p.detail, /86/)
})

// ─── Les garanties de forme (spec §2) ───────────────────────────────────────

const SRC = fs.readFileSync(path.join(__dirname, '..', 'api/migration.js'), 'utf8')

test('dry_run est le DEFAUT sur toute action', () => {
  assert.ok(/dry_run !== 'false'/.test(SRC), 'il faut dire explicitement false pour agir')
})

test('l endpoint est garde par requirePermission, en lecture ET en ecriture', () => {
  assert.ok(/domaine: 'reglages', niveau: 'read'/.test(SRC))
  assert.ok(/domaine: 'reglages', niveau: 'write'/.test(SRC))
})

test('l endpoint ne recalcule pas l etat : il lit lib/migration-etapes', () => {
  // Deux sources de verite finiraient par dire deux choses du meme bien.
  assert.ok(SRC.includes("require('../lib/migration-etapes')"))
})

test('une action non construite le DIT (501), elle ne fait pas semblant', () => {
  assert.ok(/action_non_construite/.test(SRC))
  assert.ok(/501/.test(SRC))
})
