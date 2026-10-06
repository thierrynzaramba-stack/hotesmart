// tests/v2-marche-aucune-ecriture-calendrier.test.js — LA GARANTIE DU PASSAGE EN
// PRODUCTION de la V2 marche (demande de Thierry, 6 octobre 2026) : les pages
// « marche » et « choisir vos comparables » AFFICHENT des prix, elles
// n'ECRIVENT jamais dans le calendrier et ne POUSSENT jamais un prix vers un
// canal.
//
// DEUX PREUVES :
//   1. LECTURE DU CODE — chaque fichier de code que la V2 apporte (la liste est
//      FIGEE ici : un fichier ajoute sans y figurer fait rougir le test) :
//      aucun ne charge un ecrivain du calendrier ou des prix, ni la couche des
//      canaux ; aucun ne nomme une table du calendrier ou des prix ; aucune page
//      n'appelle un endpoint qui ecrit au calendrier ou pilote les prix.
//   2. EXECUTION — la route des comparables, menee a travers TOUTES ses actions
//      (profil, chercher, plus, strategie, retenir, prix) avec un faux Supabase
//      qui journalise : elle n'ecrit que dans ses propres tables, et aucun module
//      d'ecriture du calendrier ou des canaux n'est charge en memoire.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const RACINE = path.join(__dirname, '..')
const lire = f => fs.readFileSync(path.join(RACINE, f), 'utf8')

// Le code que la V2 marche apporte en production (git diff main…branche, 6
// octobre 2026). `apps/yield/prix.html` est une page EXISTANTE : seul son bloc
// marche est neuf, il est controle a part.
const CODE_V2 = [
  'api/marche-comparables.js', 'api/marche-global.js', 'api/marche-temperature.js', 'api/yield-marche.js',
  'apps/yield/comparables.html', 'apps/yield/marche-global.html', 'apps/yield/marche-temperature.html', 'apps/yield/marche.html',
  'lib/airroi/client.js', 'lib/airroi/cout.js', 'lib/airroi/depot.js', 'lib/airroi/fixture-sure.js', 'lib/airroi/json.js',
  'lib/marche/activite.js', 'lib/marche/annonces-retirees.js', 'lib/marche/calendrier-marche.js', 'lib/marche/choix-comparables.js',
  'lib/marche/controle.js', 'lib/marche/critere.js', 'lib/marche/etude.js', 'lib/marche/explication.js', 'lib/marche/grille-marche.js',
  'lib/marche/marche-global.js', 'lib/marche/menage.js', 'lib/marche/pertinence.js', 'lib/marche/prix-depart.js', 'lib/marche/profil-bien.js',
  'lib/marche/progression-marche.js', 'lib/marche/saisons.js', 'lib/marche/temperature-airroi.js', 'shared/temperature-calendrier.js',
]

// Ce qui ECRIT au calendrier ou pousse des prix (modules et tables).
const MODULES_INTERDITS = [
  'calendrier-writer', 'channel-fullsync', 'channel-pricing', 'channel-availability', 'canal-calendrier', 'lib/channels', '/channels',
  'pilote-quotidien', 'pilote-tarifaire', 'prix-hote', 'fermetures', 'grille-hote', 'calendrier-pilotage', 'migration-ari', 'cron-channel',
]
const TABLES_INTERDITES = ['calendar_inventory', 'price_display_log', 'prix_hote', 'prix_hote_journal', 'grille_hote', 'grille_hote_journal', 'fermetures', 'write_locks', 'inventory_units', 'bookings_snapshot']
// Les endpoints qui ecrivent au calendrier ou pilotent les prix.
const ENDPOINTS_INTERDITS = ['/api/calendar', '/api/yield-pilote', '/api/yield-grille', '/api/yield-exceptions', '/api/channel-', '/api/beds24', '/api/disponibilites', '/api/reservation']

test('LE TEST QUI COMPTE (garantie prod) : la liste du code V2 est COMPLETE — un fichier ajoute sans controle fait rougir', () => {
  let diff = ''
  try { diff = execSync('git diff --name-only origin/main...HEAD -- api apps lib pages shared', { cwd: RACINE, encoding: 'utf8' }) } catch (e) { return }
  const apportes = diff.split('\n').filter(Boolean).filter(f => f !== 'apps/yield/prix.html' && fs.existsSync(path.join(RACINE, f)))
  for (const f of apportes) assert.ok(CODE_V2.includes(f), `${f} arrive en production sans controle : l'ajouter a CODE_V2`)
})

test('LE TEST QUI COMPTE (garantie prod) : aucun fichier V2 ne charge un ecrivain du calendrier, des prix ou des canaux', () => {
  for (const f of CODE_V2) {
    const src = lire(f)
    for (const m of src.matchAll(/require\(\s*['"`]([^'"`]+)['"`]\s*\)|import[^'"`]*['"`]([^'"`]+)['"`]/g)) {
      const cible = m[1] || m[2]
      for (const interdit of MODULES_INTERDITS) assert.ok(!cible.includes(interdit), `${f} charge ${cible}`)
    }
  }
})

test('LE TEST QUI COMPTE (garantie prod) : aucun fichier V2 ne nomme une table du calendrier ou des prix', () => {
  for (const f of CODE_V2) {
    const src = lire(f)
    for (const t of TABLES_INTERDITES) assert.ok(!new RegExp(`['"\`]${t}['"\`]`).test(src), `${f} nomme la table ${t}`)
  }
})

test('LE TEST QUI COMPTE (garantie prod) : aucune page V2 n appelle un endpoint qui ecrit au calendrier ou pilote les prix', () => {
  for (const f of CODE_V2.filter(x => x.endsWith('.html') || x.startsWith('shared/'))) {
    const src = lire(f)
    for (const e of ENDPOINTS_INTERDITS) assert.ok(!src.includes(`'${e}`) && !src.includes(`"${e}`) && !src.includes(`\`${e}`), `${f} appelle ${e}`)
  }
})

test('garantie prod : le bloc marche de l ecran Prix ne fait que LIRE /api/yield-marche (GET), et le dit', () => {
  const src = lire('apps/yield/prix.html')
  const i = src.indexOf('function blocMarche')
  assert.ok(i > 0)
  const bloc = src.slice(i, i + 6000)
  assert.match(bloc, /n’agit pas sur vos prix/)
  for (const m of bloc.matchAll(/fetch\(([^)]*)\)/g)) {
    assert.match(m[1], /\/api\/yield-marche/)
    assert.doesNotMatch(m[1], /method\s*:\s*['"](POST|PUT|PATCH|DELETE)/)
  }
})

test('LE TEST QUI COMPTE (garantie prod, EXECUTION) : la route des comparables, a travers toutes ses actions, n ecrit que dans ses tables — et ne charge aucun ecrivain', async () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:1'
  process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'factice-non-secret'
  const chemin = m => require.resolve(path.join(RACINE, m))
  const garde = require(chemin('lib/require-permission'))
  const sbMod = require.resolve('@supabase/supabase-js')
  const vraiSb = require(sbMod)
  const ecrits = new Set()
  const rpcs = new Set()
  const base = () => {
    const q = {
      select: () => q, eq: () => q, gte: () => q, in: () => q, filter: () => q, order: () => q, range: () => q, not: () => q,
      limit: () => Promise.resolve({ data: [], error: null }), maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (ok, ko) => Promise.resolve({ data: [], error: null }).then(ok, ko),
    }
    return q
  }
  const client = {
    rpc: async fn => { rpcs.add(fn); return { data: 'ok', error: null } },
    from: tb => {
      const q = base()
      for (const op of ['insert', 'upsert', 'update', 'delete']) q[op] = () => { ecrits.add(tb); const w = base(); w.select = () => Promise.resolve({ data: [], error: null }); return Object.assign(w, { then: (ok, ko) => Promise.resolve({ data: [], error: null }).then(ok, ko) }) }
      return q
    },
  }
  const avant = new Set(Object.keys(require.cache))
  require.cache[chemin('lib/require-permission')].exports = { ...garde, requirePermission: async () => ({ ok: true, userId: 'U', accountUserId: 'U', bien: { id: 'B' } }) }
  require.cache[sbMod].exports = { ...vraiSb, createClient: () => client }
  const fetchAvant = globalThis.fetch
  const reseau = []
  globalThis.fetch = async url => {
    reseau.push(String(url))
    return { ok: true, json: async () => ({ features: [{ geometry: { coordinates: [1.45, 43.6] }, properties: { label: '1 rue X 31000 Toulouse', score: 0.9, type: 'housenumber' } }] }) }
  }
  try {
    delete require.cache[chemin('api/marche-comparables')]
    const api = require(path.join(RACINE, 'api', 'marche-comparables'))
    const appeler = (method, body) => new Promise(resolve => {
      const res = { status () { return res }, setHeader () {}, json: resolve }
      Promise.resolve(api({ method, query: { property_id: 'B' }, body, headers: {} }, res)).then(() => resolve(null))
    })
    await appeler('GET', null)
    for (const body of [
      { action: 'profil', adresse: '1 rue X', voyageurs: 2, chambres: 1, pieces: 2, salles_de_bain: 1, equipements: ['spa'] },
      { action: 'chercher' }, { action: 'plus' }, { action: 'strategie', strategie: 'qualite', sejour_min: 2 },
      { action: 'retenir', choix: [] }, { action: 'prix' },
    ]) await appeler('POST', body)
  } finally {
    require.cache[chemin('lib/require-permission')].exports = garde
    require.cache[sbMod].exports = vraiSb
    globalThis.fetch = fetchAvant
    delete require.cache[chemin('api/marche-comparables')]
  }
  const permises = new Set(['bien_profil', 'comparables_retenus', 'airroi_cache', 'airroi_appels', 'airroi_annonces_retirees'])
  for (const t of ecrits) assert.ok(permises.has(t), `la route ecrit dans ${t}`)
  for (const fn of rpcs) assert.ok(['reserver_recherche_comparables', 'rendre_recherche_comparables'].includes(fn), `rpc ${fn}`)
  // Le reseau : le geocodage de l'adresse et AirROI, JAMAIS un canal (Channex, Beds24).
  for (const u of reseau) assert.ok(/^https:\/\/(api-adresse\.data\.gouv\.fr|api\.airroi\.com)\//.test(u), `appel reseau vers ${u}`)
  assert.ok(reseau.length > 0, 'le journal du reseau a bien servi (sinon le test ne prouverait rien)')
  assert.ok(ecrits.size > 0, 'le journal des ecritures a bien servi (sinon le test ne prouverait rien)')
  const charges = Object.keys(require.cache).filter(k => !avant.has(k))
  for (const k of charges) for (const interdit of ECRIVAINS) assert.ok(!k.includes(interdit), `la route a charge ${k}`)
})

// Les modules qui ECRIVENT au calendrier ou PARLENT aux canaux : jamais charges,
// meme indirectement. (`pilote-tarifaire` est a part, ci-dessous.)
const ECRIVAINS = MODULES_INTERDITS.filter(m => m !== 'pilote-tarifaire')

test('LE TEST QUI COMPTE (garantie prod) : aucune des 4 routes V2 ne charge, meme indirectement, un ecrivain du calendrier ou un module de canal', () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:1'
  process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'factice-non-secret'
  for (const a of ['marche-comparables', 'marche-global', 'marche-temperature', 'yield-marche']) {
    const avant = new Set(Object.keys(require.cache))
    const p = require.resolve(path.join(RACINE, 'api', a))
    delete require.cache[p]
    require(p)
    const charges = Object.keys(require.cache).filter(k => !avant.has(k) && !k.includes('node_modules'))
    for (const k of charges) for (const interdit of ECRIVAINS) assert.ok(!k.includes(interdit), `api/${a} charge ${path.relative(RACINE, k)}`)
  }
})

test('garantie prod : `pilote-tarifaire` n arrive que par la capacite, et SEULEMENT pour `finDeFenetre` (un calcul de date)', () => {
  const capacite = lire('lib/yield/capacite.js')
  const imports = [...capacite.matchAll(/const \{([^}]*)\} = require\('\.\.\/pilote-tarifaire'\)/g)].map(m => m[1].split(',').map(x => x.trim()).filter(Boolean))
  assert.deepEqual(imports, [['finDeFenetre']])
  const { finDeFenetre } = require(path.join(RACINE, 'lib', 'pilote-tarifaire'))
  assert.equal(typeof finDeFenetre, 'function')
})

test('passage en prod : le menu YieldFlow mene aux deux pages de la V2 (« pages accessibles », demande de Thierry)', () => {
  const menu = lire('components/sidebar.js')
  assert.match(menu, /href="\/apps\/yield\/marche-global">[\s\S]{0,120}Le marché global/)
  assert.match(menu, /href="\/apps\/yield\/comparables">[\s\S]{0,120}Choisir vos comparables/)
  assert.match(lire('apps/yield/marche-global.html'), /renderSidebar\('yield-marche-global'\)/)
  assert.match(lire('apps/yield/comparables.html'), /renderSidebar\('yield-comparables'\)/)
})
