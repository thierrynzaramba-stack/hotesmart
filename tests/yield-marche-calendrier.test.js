// tests/yield-marche-calendrier.test.js — la page « Le marché » (V2.3.4) et sa
// vue d'API : LECTURE SEULE, aucun ecran existant modifie, deux echelles.
//
// LES DEFAUTS QU'ILS EMPECHENT :
//   - une page qui ecrirait (POST, PUT, DELETE) ou appellerait AirROI ;
//   - une vue d'API qui lirait autre chose que marche_calendrier, ou exigerait
//     un logement pour un calendrier de MARCHE ;
//   - deux lignes du meme marche rendues ensemble (la plus recente seule) ;
//   - une page qui ne dirait pas en tete ce qu'elle est.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const RACINE = path.join(__dirname, '..')
const PAGE = fs.readFileSync(path.join(RACINE, 'apps', 'yield', 'marche.html'), 'utf8')

test('LE TEST QUI COMPTE : la page est en lecture seule — un seul GET, aucune ecriture, aucun appel AirROI', () => {
  const appels = [...PAGE.matchAll(/fetch\(\s*([^,)]+)/g)].map(m => m[1].trim())
  assert.deepEqual(appels, ["'/api/yield-marche?vue=calendrier'"])
  assert.ok(!/method\s*:/.test(PAGE), 'aucune methode autre que GET')
  assert.ok(!/api\.airroi/i.test(PAGE), 'aucun appel AirROI')
  assert.ok(!/supabase\.from\(/.test(PAGE), 'aucune lecture directe de la base')
})

test('LE TEST QUI COMPTE : la page dit en tete ce qu elle est — une estimation du marche, pas un prix, qui ne pilote rien', () => {
  const tete = PAGE.slice(PAGE.indexOf('id="mc-avertir"'), PAGE.indexOf('id="mc-choix"'))
  assert.match(tete, /Une estimation du marché, pas un prix/)
  assert.match(tete, /ne pilote rien/)
})

test('LE TEST QUI COMPTE : deux echelles, jamais une — deux palettes, deux libelles, aucun tri commun', () => {
  assert.match(PAGE, /Échelle du pacing/)
  assert.match(PAGE, /Échelle mensuelle — ne se compare pas à celle du pacing/)
  assert.match(PAGE, /\.p-basse[\s\S]*\.m-basse/)
  assert.ok(!/\.sort\(/.test(PAGE), 'aucun tri de saisons dans la page')
})

test('aucun ecran existant n est modifie par ce lot', () => {
  const { execSync } = require('child_process')
  const base = execSync('git merge-base HEAD origin/main', { cwd: RACINE }).toString().trim()
  const touches = execSync(`git diff --name-only ${base} -- apps pages components public shared`, { cwd: RACINE }).toString().split('\n').filter(Boolean)
  // Seuls la page neuve et le bloc marche de prix.html (V2.5, anterieur a ce lot) sont touches.
  assert.deepEqual(touches.filter(f => f !== 'apps/yield/marche.html' && f !== 'apps/yield/prix.html'), [])
})

test('LE TEST QUI COMPTE : la vue calendrier ne lit que marche_calendrier, sans logement, le plus recent par marche', async () => {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:1'
  process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'factice-non-secret'
  const cheminGarde = require.resolve(path.join(RACINE, 'lib', 'require-permission'))
  const vraie = require(cheminGarde)
  const gardes = []
  require.cache[cheminGarde].exports = { ...vraie, requirePermission: async (req, res, o) => { gardes.push(o); return { ok: true } } }
  const cheminSb = require.resolve('@supabase/supabase-js')
  const vraiSb = require(cheminSb)
  const tables = []
  const lignes = [
    { pays: 'France', region: 'Occitania', localite: 'Bagnères-de-Bigorre', capture_le: '2026-10-24', methode: 'b' },
    { pays: 'France', region: 'Occitania', localite: 'Bagnères-de-Bigorre', capture_le: '2026-09-24', methode: 'b' },
    { pays: 'France', region: 'Occitania', localite: 'Toulouse', capture_le: '2026-09-24', methode: 'b' }]
  const q = { select: () => q, order: () => q, limit: () => Promise.resolve({ data: lignes, error: null }) }
  require.cache[cheminSb].exports = { ...vraiSb, createClient: () => ({ from: t => { tables.push(t); return q } }) }
  delete require.cache[require.resolve(path.join(RACINE, 'api', 'yield-marche'))]
  const api = require(path.join(RACINE, 'api', 'yield-marche'))
  const corps = await new Promise((resolve, reject) => {
    const res = { status () { return res }, setHeader () {}, json: resolve }
    api({ method: 'GET', query: { vue: 'calendrier' }, headers: {} }, res)
    setTimeout(() => reject(new Error('pas de reponse')), 5000)
  })
  require.cache[cheminGarde].exports = vraie
  require.cache[cheminSb].exports = vraiSb
  assert.deepEqual(tables, ['marche_calendrier'])
  assert.deepEqual(gardes, [{ domaine: 'reservations', niveau: 'read' }], 'un marche n est pas un logement : aucun bien exige')
  assert.deepEqual(corps.marches.map(m => [m.localite, m.capture_le]), [['Bagnères-de-Bigorre', '2026-10-24'], ['Toulouse', '2026-09-24']])
})
