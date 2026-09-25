// tests/marche-global.test.js — le marche global (cadrage §14), indicateur 1 :
// le RevPAR du marche mois par mois, en quantiles, avec sa couverture.
//
// LES DEFAUTS QU'ILS EMPECHENT :
//   - un mois non mesure (0 chez AirROI) trace comme un zero ;
//   - la couverture partielle de 2021-2022 cachee ;
//   - la vue qui lirait le marche d'un autre client, ou paierait un appel ;
//   - une page qui ecrirait, ou tairait qu'elle n'est pas un prix.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { revparMensuel } = require('../lib/marche/marche-global')
const { cleCanonique } = require('../lib/airroi/client')

const RACINE = path.join(__dirname, '..')
const TEXTE60 = fs.readFileSync(path.join(__dirname, 'fixtures', 'airroi', 'marche-60.json'), 'utf8')
const MARCHE60 = JSON.parse(TEXTE60)

test('LE TEST QUI COMPTE : les 60 mois de Bagneres, quatre quantiles et la couverture reelle, tels que mesures', () => {
  const r = revparMensuel(MARCHE60)
  assert.equal(r.statut, 'calcule')
  assert.equal(r.mois.length, 60)
  assert.deepEqual([r.mois[0].mois, r.mois[59].mois], ['2021-09', '2026-08'])
  assert.deepEqual(r.mois[0], { mois: '2021-09', p25: 18.3, p50: 34.9, p75: 57.2, p90: 108.8, annonces: 432, couverture_partielle: true })
  assert.deepEqual(r.mois[59], { mois: '2026-08', p25: 19.6, p50: 39.8, p75: 61.9, p90: 92.3, annonces: 953, couverture_partielle: false })
  assert.deepEqual([...new Set(r.mois.filter(m => m.couverture_partielle).map(m => m.mois.slice(0, 4)))], ['2021', '2022'])
  assert.deepEqual(r.marche, { pays: 'France', region: 'Occitania', localite: 'Bagnères-de-Bigorre' })
})

test('LE TEST QUI COMPTE : une valeur 0 est une ABSENCE (null), jamais un zero trace ; mois en double et dates illisibles ecartes', () => {
  const troue = { results: [
    { date: '2025-01-01', revpar: { p25: 0, p50: 30, p75: 40, p90: 0 }, active_listings_count: 0 },
    { date: '2025-01-01', revpar: { p25: 1, p50: 1, p75: 1, p90: 1 } },
    { date: 'hier', revpar: {} },
    { date: '2025-02-01', revpar: { p25: 10, p50: 20, p75: 30, p90: 40 }, active_listings_count: 900 }] }
  const r = revparMensuel(troue)
  assert.deepEqual(r.mois[0], { mois: '2025-01', p25: null, p50: 30, p75: 40, p90: null, annonces: null, couverture_partielle: false })
  assert.deepEqual(r.ecartes.map(e => e.motif), ['mois en double', 'date illisible'])
  assert.equal(revparMensuel({ results: [] }).statut, 'non_calculable')
  assert.equal(revparMensuel({ results: [{ date: '2025-01-01', revpar: { p50: 0 } }] }).statut, 'non_calculable')
})

// ─── La vue d'API ───────────────────────────────────────────────────────────
function base (tables) {
  const lus = []
  return { lus, client: { from: t => {
    lus.push(t)
    let lignes = [...(tables[t] || [])]
    const q = { select: () => q, eq: (k, v) => { lus.push(`${t}.${k}=${v}`); lignes = lignes.filter(l => l[k] === v); return q },
      limit: n => Promise.resolve({ data: lignes.slice(0, n), error: null }) }
    return q
  } } }
}

async function appeler (query, tables, garde = { ok: true, bien: { id: 'BIEN-A' } }) {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:1'
  process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'factice-non-secret'
  const cheminGarde = require.resolve(path.join(RACINE, 'lib', 'require-permission'))
  const vraie = require(cheminGarde)
  const cheminSb = require.resolve('@supabase/supabase-js')
  const vraiSb = require(cheminSb)
  const gardes = []
  const b = base(tables)
  const vraiFetch = globalThis.fetch
  let appelsReseau = 0
  let minuterie
  try {
    globalThis.fetch = async () => { appelsReseau++; throw new Error('aucun appel reseau attendu') }
    require.cache[cheminGarde].exports = { ...vraie, requirePermission: async (req, res, o) => { gardes.push(o); return garde } }
    require.cache[cheminSb].exports = { ...vraiSb, createClient: () => b.client }
    delete require.cache[require.resolve(path.join(RACINE, 'api', 'marche-global'))]
    const api = require(path.join(RACINE, 'api', 'marche-global'))
    const reponse = await Promise.race([
      new Promise(resolve => {
        let code = 200
        const res = { status (c) { code = c; return res }, setHeader () {}, json: corps => resolve({ code, corps }) }
        Promise.resolve(api({ method: 'GET', query, headers: {} }, res)).then(() => resolve({ code, corps: null }))
      }),
      new Promise((resolve, reject) => { minuterie = setTimeout(() => reject(new Error('pas de reponse')), 5000) })
    ])
    return { ...reponse, gardes, lus: b.lus, appelsReseau }
  } finally {
    clearTimeout(minuterie)
    globalThis.fetch = vraiFetch
    require.cache[cheminGarde].exports = vraie
    require.cache[cheminSb].exports = vraiSb
  }
}

const CLE_BAGNERES = cleCanonique('POST /markets/metrics/all', { market: { country: 'France', region: 'Occitania', locality: 'Bagnères-de-Bigorre' }, num_months: 60, currency: 'native' })
const CLE_TOULOUSE = cleCanonique('POST /markets/metrics/all', { market: { country: 'France', region: 'Occitania', locality: 'Toulouse' }, num_months: 60, currency: 'native' })
const TABLES = {
  marche_biens: [{ property_id: 'BIEN-A', pays: 'France', region: 'Occitania', localite: 'Bagnères-de-Bigorre' },
    { property_id: 'BIEN-T', pays: 'France', region: 'Occitania', localite: 'Toulouse' }],
  airroi_cache: [{ cle: CLE_BAGNERES, reponse: TEXTE60, recupere_le: '2026-09-23T00:00:00Z' },
    { cle: CLE_TOULOUSE, reponse: JSON.stringify({ market: {}, results: [{ date: '2026-01-01', revpar: { p50: 999 } }] }), recupere_le: '2026-09-23T00:00:00Z' }]
}

test('LE TEST QUI COMPTE (securite) : garde du logement, SEUL le marche de ce logement, sous la cle exacte du cache, aucun appel reseau', async () => {
  const sans = await appeler({}, TABLES)
  assert.equal(sans.code, 400)
  assert.deepEqual(sans.lus, [])
  const r = await appeler({ property_id: 'BIEN-A' }, TABLES)
  assert.deepEqual(r.gardes, [{ domaine: 'reservations', niveau: 'read', bien: 'BIEN-A', bienRequis: true }])
  assert.deepEqual(r.lus, ['marche_biens', 'marche_biens.property_id=BIEN-A', 'airroi_cache', `airroi_cache.cle=${CLE_BAGNERES}`])
  assert.equal(r.corps.etat, 'calcule')
  assert.equal(r.corps.revpar.mois.length, 60)
  assert.ok(!JSON.stringify(r.corps).includes('999'), 'jamais les chiffres d un autre marche')
  assert.equal(r.appelsReseau, 0)
})

test('sans lien : marche inconnu ; sans historique en cache : dit, avec le cout, sans rien payer ; garde refusee : rien n est lu', async () => {
  const inconnu = await appeler({ property_id: 'BIEN-Z' }, TABLES, { ok: true, bien: { id: 'BIEN-Z' } })
  assert.equal(inconnu.corps.etat, 'marche_inconnu')
  const vide = await appeler({ property_id: 'BIEN-A' }, { ...TABLES, airroi_cache: [] })
  assert.equal(vide.corps.etat, 'historique_absent')
  assert.match(vide.corps.motif, /0,50 \$, par un script, jamais depuis cet ecran/)
  assert.equal(vide.appelsReseau, 0)
  const refus = await appeler({ property_id: 'BIEN-A' }, TABLES, { ok: false })
  assert.deepEqual(refus.lus, [])
})

// ─── La page ────────────────────────────────────────────────────────────────
const PAGE = fs.readFileSync(path.join(RACINE, 'apps', 'yield', 'marche-global.html'), 'utf8')

test('LE TEST QUI COMPTE : la page est en lecture seule, dit en tete ce qu elle est, et porte les deux mentions', () => {
  const appels = [...PAGE.matchAll(/fetch\(\s*([`'"])([^`'"]*)/g)].map(m => m[2])
  assert.ok(appels.length >= 1)
  for (const u of appels) assert.ok(u.startsWith('/api/marche-global?property_id='), `appel inattendu : ${u}`)
  assert.ok(!/method\s*:/.test(PAGE))
  assert.deepEqual([...PAGE.matchAll(/supabase\.from\(\s*'([^']+)'/g)].map(m => m[1]), ['properties'])
  assert.ok(!/\.(insert|update|upsert|delete)\(/.test(PAGE))
  assert.match(PAGE, /Une estimation du marché, pas un prix/)
  assert.match(PAGE, /ne pilote rien/)
  assert.match(PAGE, /pas un prix pour votre logement/)
  assert.match(PAGE, /2021-2022 : couverture AirROI en cours de mise en place/)
  assert.match(PAGE, /Couverture réelle, mois par mois/)
})
