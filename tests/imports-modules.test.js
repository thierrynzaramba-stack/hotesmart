// tests/imports-modules.test.js
// Chaque import nommé d'une page doit exister dans le module source.
//
// ⚠ POURQUOI CE TEST EXISTE. `pages/avis.html` faisait
// `import { apiCall } from '/shared/api-client.js'` — or ce fichier n'exporte
// QUE `api`, jamais `apiCall`. En production : « The requested module does not
// provide an export named 'apiCall' », module entier avorté, page morte.
//
// Les 629 tests étaient verts. `pages-ids` vérifie les `id` du DOM,
// `pages-identifiants` vérifie que les globals consommés sont exposés et que
// l'ordre d'exécution tient — aucun ne regarde les IMPORTS eux-mêmes. C'est le
// troisième angle mort de la même famille : le code JS d'une page n'est jamais
// exécuté par la suite de tests, donc seule une analyse statique peut l'attraper.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const racine = path.join(__dirname, '..')

// Toutes les pages HTML du produit.
function pagesHtml () {
  const out = []
  const explorer = (rel) => {
    let entrees
    try { entrees = fs.readdirSync(path.join(racine, rel), { withFileTypes: true }) }
    catch { return }
    for (const e of entrees) {
      const chemin = rel + '/' + e.name
      if (e.isDirectory()) explorer(chemin)
      else if (e.name.endsWith('.html')) out.push(chemin)
    }
  }
  explorer('pages'); explorer('apps')
  return out
}

// `import { a, b as c } from '/chemin.js'` -> { source, noms: ['a','b'] }
function importsNommes (src) {
  const out = []
  const re = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(src))) {
    const noms = m[1].split(',')
      .map(n => n.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean)
    out.push({ source: m[2], noms })
  }
  return out
}

// Noms exportés par un fichier : `export const x`, `export function x`,
// `export { x, y }`, `export default`.
function exportsDe (src) {
  const noms = new Set()
  for (const m of src.matchAll(/export\s+(?:const|let|var|function|class)\s+(\w+)/g)) noms.add(m[1])
  for (const m of src.matchAll(/export\s+async\s+function\s+(\w+)/g)) noms.add(m[1])
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(/\s+as\s+/)
      noms.add((t[1] || t[0]).trim())
    }
  }
  if (/export\s+default\b/.test(src)) noms.add('default')
  return noms
}

const PAGES = pagesHtml()

test('des pages HTML sont bien trouvées (sinon la découverte est cassée)', () => {
  assert.ok(PAGES.length >= 5, `pages trouvées : ${PAGES.length}`)
})

for (const page of PAGES) {
  const html = fs.readFileSync(path.join(racine, page), 'utf8')
  const imports = importsNommes(html).filter(i => i.source.startsWith('/'))
  if (!imports.length) continue

  test(`${page} : chaque import nommé existe dans son module`, () => {
    for (const imp of imports) {
      const fichier = path.join(racine, imp.source.replace(/^\//, ''))
      assert.ok(fs.existsSync(fichier),
        `${page} importe depuis ${imp.source}, qui n'existe pas`)
      const exportes = exportsDe(fs.readFileSync(fichier, 'utf8'))
      for (const nom of imp.noms) {
        assert.ok(exportes.has(nom),
          `${page} importe { ${nom} } depuis ${imp.source}, qui ne l'exporte pas. ` +
          `Exports disponibles : ${[...exportes].join(', ') || 'aucun'}. ` +
          `En production, le module entier avorte et la page est morte.`)
      }
    }
  })
}
