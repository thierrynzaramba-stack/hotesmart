// tests/migration-etapes.test.js
// L'assistant de migration : chaque etape sait dire son etat.
// Spec : docs/specs/spec-assistant-migration.md

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'

const { etatMigration, CHAMPS_FICHE } = require('../lib/migration-etapes')

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

// ─── 6. Le logement chez le nouveau provider ────────────────────────────────

const ETAPES_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib/migration-etapes.js'), 'utf8')
const PROV_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib/migration-provisionner.js'), 'utf8')
const GARDE_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib/garde-activation.js'), 'utf8')

// L'etape 6 ne lit que le bien : un faux client qui ne sert rien suffit.
const RIEN = () => faux({
  bookings_snapshot: [{ count: 1, error: null }, { count: 0, error: null }],
  property_snapshots: [{ data: { raw: {}, fetched_at: '2026-09-08' }, error: null }],
  calendar_inventory: [{ data: [{ date: '2026-09-10', rate: 120 }], error: null },
    { data: [{ date: '2026-09-10', rate: 120 }], error: null }]
})
const prov = (e) => e.etapes.find(x => x.id === 'provisionner_channex')

test('etape 6 : un bien non provisionne dit « a faire », avec son action', async () => {
  const e = await etatMigration(RIEN(), BIEN)
  assert.equal(prov(e).etat, 'a_faire')
  assert.equal(prov(e).action, 'provisionner_channex')
})

test('etape 6 : provisionne = fait, et l identifiant SOURCE est rappele intact', async () => {
  const e = await etatMigration(RIEN(), {
    ...BIEN, migration_target_property_id: 'chx-prop', migration_target_at: '2026-09-09T01:00:00Z',
    provider_room_type_id: 'chx-rt', provider_rate_plan_id: 'chx-rp'
  })
  assert.equal(prov(e).etat, 'fait')
  assert.match(prov(e).detail, /209413/, 'l identifiant source est nomme, donc verifiable')
})

test('etape 6 : une cible sans room type BLOQUE — la poussee ARI n aurait pas ou aller', async () => {
  const e = await etatMigration(RIEN(), {
    ...BIEN, migration_target_property_id: 'chx-prop', provider_room_type_id: null, provider_rate_plan_id: null
  })
  assert.equal(prov(e).etat, 'bloque')
  // Relancer le provisionnement se ferait refuser (`deja_provisionne`) : un
  // assistant qui propose le geste qui va echouer fait perdre le temps qu'il
  // pretend faire gagner.
  assert.equal(prov(e).action, null)
  assert.match(prov(e).detail, /a la main/i, 'il dit par quoi reprendre')
})

test('etape 6 : APRES le re-keying, elle reste « fait » — pas « sans objet »', async () => {
  // C'est le moment ou l'on veut verifier que la propriete cible est bien celle
  // attendue. Tester le provider avant la cible aurait efface cette reponse.
  const e = await etatMigration(RIEN(), {
    ...BIEN, provider: 'channex', migration_target_property_id: 'chx-prop',
    provider_room_type_id: 'chx-rt', provider_rate_plan_id: 'chx-rp'
  })
  assert.equal(prov(e).etat, 'fait')
  assert.match(prov(e).detail, /bascule est faite/i)
})

test('LE TEST QUI COMPTE : un bien deja chez la cible est « sans objet », jamais « a faire »', async () => {
  // Colomiers a des canaux ACTIFS. « a faire » inviterait a lancer une action
  // qui ecraserait ses `provider_room_type_id` / `provider_rate_plan_id` par ceux
  // d'une propriete neuve et vide : son ARI partirait ensuite dans le vide.
  const e = await etatMigration(RIEN(), { ...BIEN, provider: 'channex' })
  assert.equal(prov(e).etat, 'sans_objet')
  assert.equal(prov(e).action, null, 'aucune action proposee')
  // Et l etape ne compte ni au numerateur ni au denominateur.
  assert.equal(e.total, e.etapes.length - 1)
})

test('etape 6 : un type que la cible refuse BLOQUE, en nommant les types valides', async () => {
  const e = await etatMigration(RIEN(), { ...BIEN, property_type: 'townhome' })
  assert.equal(prov(e).etat, 'bloque')
  assert.match(prov(e).detail, /townhome/)
  assert.match(prov(e).detail, /apartment/, 'le motif dit QUOI FAIRE, pas seulement ce qui cloche')
})

// ─── Le piege des colonnes non selectionnees ────────────────────────────────

test('LE TEST QUI COMPTE : toute colonne lue par une etape est dans le SELECT de l endpoint', () => {
  // Piege paye trois fois sur ce chantier, et une quatrieme ici : sans
  // `migration_target_property_id` dans le SELECT, la garde d idempotence lisait
  // `undefined` — relancer le provisionnement creait une SECONDE propriete
  // Channex et ecrasait la premiere, devenue orpheline et muette.
  const cols = new Set(
    (SRC.match(/const COLS = ([\s\S]*?)\n\n/) || ['', ''])[1]
      .match(/[a-z_][a-z0-9_]*/g).filter(x => x !== 'const' && x !== 'COLS')
  )
  const lues = new Set()
  for (const src of [ETAPES_SRC, PROV_SRC]) {
    for (const m of src.matchAll(/\bbien\.([a-z_][a-z0-9_]*)/g)) lues.add(m[1])
  }
  // L'etape 5 lit le bien sous un AUTRE nom de variable (`prop`), dans un autre
  // fichier. Ne balayer que `bien.` laissait ce lecteur hors du filet.
  for (const m of GARDE_SRC.matchAll(/\bprop\.([a-z_][a-z0-9_]*)/g)) lues.add(m[1])
  // Et l'etape 3 lit ses colonnes DYNAMIQUEMENT (`bien[c]` sur CHAMPS_FICHE) :
  // aucun motif littéral ne les montre.
  for (const c of CHAMPS_FICHE) lues.add(c)
  const manquantes = [...lues].filter(c => !cols.has(c))
  assert.deepEqual(manquantes, [], `colonnes lues mais non selectionnees : ${manquantes.join(', ')}`)
})
