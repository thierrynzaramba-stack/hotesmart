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

// ⚠ Les commentaires sont neutralises DES DEUX COTES. Sans cela, un
// `// export function apiCall` dans le module source aurait masque le bug meme
// que ce test existe pour attraper — et un exemple de code dans un commentaire
// (ou dans pages/guide.html) aurait produit un faux positif. C'est la regle
// posee par le test des non delegables, elle vaut ici aussi.
function sansCommentaires (src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

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

// ⚠ Les modules JS aussi. `components/sidebar.js` importe `shared/config.js` :
// un nom absent la-dedans avorte la sidebar, donc la page qui l'importe — le
// meme mode de panne, et le try/catch autour de renderSidebar n'y peut RIEN,
// une resolution d'import ratee est une erreur de LIAISON, anterieure a toute
// execution.
function modulesJs () {
  const out = []
  for (const rel of ['shared', 'components']) {
    let entrees
    try { entrees = fs.readdirSync(path.join(racine, rel), { withFileTypes: true }) }
    catch { continue }
    for (const e of entrees) if (e.isFile() && e.name.endsWith('.js')) out.push(rel + '/' + e.name)
  }
  return out
}

// Couvre les quatre formes : nommee, par defaut, mixte, namespace.
// `import D, { a, b as c } from '…'` -> noms ['default','a','b'].
function importsDe (src) {
  const out = []
  const re = /import\s+([^'"]+?)\s+from\s*['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(src))) {
    const clause = m[1].trim()
    const noms = []
    // Partie nommee entre accolades.
    const accolades = clause.match(/\{([^}]*)\}/)
    if (accolades) {
      for (const n of accolades[1].split(',')) {
        const brut = n.trim().split(/\s+as\s+/)[0].trim()
        if (brut) noms.push(brut)
      }
    }
    // Partie par defaut : ce qui precede l'accolade ou la virgule.
    const avant = clause.split('{')[0].split(',')[0].trim()
    if (avant && !avant.startsWith('*')) noms.push('default')
    // `import * as x` : on ne verifie que l'existence du fichier.
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
  // `export let a, b` : la premiere regex ne capte que `a`.
  for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([\w,\s]+?)\s*=/g)) {
    for (const n of m[1].split(',')) if (n.trim()) noms.add(n.trim())
  }
  // `export * from './y.js'` : un baril re-exporte des noms qu'on ne peut pas
  // resoudre ici. On le SIGNALE plutot que d'echouer a tort — un test qui cne
  // dirait rien ferait passer un vrai import casse pour valide.
  if (/export\s*\*\s*from/.test(src)) noms.add('*reexport*')
  return noms
}

const CIBLES = [...pagesHtml(), ...modulesJs()]

test('des pages et des modules sont bien trouvés (sinon la découverte est cassée)', () => {
  assert.ok(CIBLES.length >= 15, `cibles trouvées : ${CIBLES.length}`)
  assert.ok(CIBLES.some(c => c.endsWith('.js')), 'les modules JS doivent être inclus')
})

for (const page of CIBLES) {
  const html = sansCommentaires(fs.readFileSync(path.join(racine, page), 'utf8'))
  // Chemins absolus ET relatifs : `components/sidebar.js` importe
  // `../shared/config.js`, qui échappait entièrement au test.
  const imports = importsDe(html).filter(i => i.source.startsWith('/') || i.source.startsWith('.'))
  if (!imports.length) continue

  test(`${page} : chaque import nommé existe dans son module`, () => {
    for (const imp of imports) {
      const fichier = imp.source.startsWith('/')
        ? path.join(racine, imp.source.replace(/^\//, ''))
        : path.resolve(path.dirname(path.join(racine, page)), imp.source)
      assert.ok(fs.existsSync(fichier),
        `${page} importe depuis ${imp.source}, qui n'existe pas`)
      const exportes = exportsDe(sansCommentaires(fs.readFileSync(fichier, 'utf8')))
      // Un fichier baril peut re-exporter n'importe quoi : on ne tranche pas.
      if (exportes.has('*reexport*')) continue
      for (const nom of imp.noms) {
        assert.ok(exportes.has(nom),
          `${page} importe { ${nom} } depuis ${imp.source}, qui ne l'exporte pas. ` +
          `Exports disponibles : ${[...exportes].join(', ') || 'aucun'}. ` +
          `En production, le module entier avorte et la page est morte.`)
      }
    }
  })
}
