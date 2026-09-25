// tests/marche-global-frontiere.test.js — la FRONTIERE V2 pour le lot « marche
// global » (cadrage §14). Fichier NEUF : la page V2.3.4 et ses tests sont
// GELES (Thierry, 25 septembre 2026) — la garde de frontiere du lot gele reste
// dans tests/explication-marche.test.js, intouchee.
//
// CE QU'ELLE EMPECHE : un module du lot qui ecrirait dans une table de
// l'existant, un calcul « pur » qui toucherait la base, une vue qui lirait
// autre chose que des tables V2 (hors la garde du logement).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const RACINE = path.join(__dirname, '..')
const lire = f => fs.readFileSync(path.join(RACINE, f), 'utf8')
const INTERDITES = ['yield_events', 'yield_segment_reglages', 'calendar_inventory', 'price_display_log', 'prix_hote']
const V2 = new Set(['airroi_cache', 'airroi_appels', 'comparables_retenus', 'grille_controle', 'marche_calendrier', 'marche_biens'])

test('FRONTIERE : le calcul du marche global est pur — aucune base, sous aucune forme', () => {
  const src = lire('lib/marche/marche-global.js')
  for (const motif of [/\.from\(/, /\.rpc\(/, /createClient/, /require\([^)]*supabase/, /fetch\(/]) assert.ok(!motif.test(src), `marche-global.js : ${motif}`)
})

test('FRONTIERE : la vue ne lit que des tables V2, nommees en toutes lettres, et n ecrit rien', () => {
  const src = lire('api/marche-global.js')
  const tables = [...src.matchAll(/\.from\(\s*([^)]*)\)/g)].map(m => m[1].trim().replace(/^['"`]|['"`]$/g, ''))
  assert.deepEqual(tables, ['marche_biens', 'airroi_cache'])
  for (const t of tables) assert.ok(V2.has(t))
  assert.ok(!/\.(insert|update|upsert|delete|rpc)\(/.test(src), 'aucune ecriture')
  assert.ok(!/creerClient|fetch\(/.test(src), 'aucun appel AirROI depuis la vue')
})

test('FRONTIERE : les scripts du lot ne nomment aucune table de l existant', () => {
  for (const f of ['scripts/verser-fixture-marche.js', 'scripts/lier-bien-marche.js']) {
    const src = lire(f)
    for (const t of INTERDITES) assert.ok(!src.includes(t), `${f} nomme ${t}`)
  }
})
