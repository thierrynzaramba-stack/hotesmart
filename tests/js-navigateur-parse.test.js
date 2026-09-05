// tests/js-navigateur-parse.test.js
// TOUT LE JAVASCRIPT SERVI AU NAVIGATEUR DOIT PARSER.
//
// ⚠ POURQUOI CE TEST EXISTE — incident du 5 septembre 2026, en production.
// Un commentaire posé DANS un template literal de `components/sidebar.js`
// contenait des accents graves autour d'un nom de variable :
//
//     subMenu = `
//       <!-- ⚠ Les cles `activePage` NE BOUGENT PAS -->
//                          ^ celui-ci FERME la chaine
//
// Le fichier ne parsait plus — « Uncaught SyntaxError: Unexpected identifier
// 'activePage' » — et `sidebar.js` étant partagé par toutes les pages, la
// NAVIGATION ÉTAIT CASSÉE PARTOUT. La suite de tests était au vert : elle
// n'exécutait ni ne parsait aucun fichier front. `npm test` disait que ce qu'on
// avait pensé à vérifier fonctionnait, pas que le code était correct — c'est
// exactement la mise en garde de CLAUDE.md, et il a fallu la production pour
// l'apprendre.
//
// ⚠ CE TEST NE VÉRIFIE QUE LA SYNTAXE. Un fichier qui parse peut être faux ;
// mais un fichier qui ne parse pas est mort à coup sûr, et sur un module partagé
// il emporte toutes les pages. C'est le filet le moins cher du dépôt.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const racine = path.join(__dirname, '..')
// Ce qui part au navigateur. `api/` et `lib/` sont du CommonJS serveur, couvert
// par `node -c` au moment du commit et par les tests d'endpoint.
const DOSSIERS_FRONT = ['components', 'shared', 'public', 'apps', 'pages']
const IGNORES = ['node_modules', '.git', 'sw.js']

function fichiers (dir, ext, out = []) {
  const abs = path.join(racine, dir)
  if (!fs.existsSync(abs)) return out
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (IGNORES.includes(e.name)) continue
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) fichiers(rel, ext, out)
    else if (e.name.endsWith(ext)) out.push(rel)
  }
  return out
}

// ⚠ ON PARSE EN MODULE ES. Le front est en `type="module"` et en `import` :
// `node --check` sur un `.js` suppose du CommonJS et accepterait un `import`
// mal placé, ou refuserait un `await` de haut niveau parfaitement valide.
// On écrit donc le source dans un `.mjs` temporaire, ce qui donne à Node la
// même grammaire que celle du navigateur.
function parseCommeModule (source, etiquette) {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'parse-')), 'x.mjs')
  fs.writeFileSync(tmp, source)
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' })
    return null
  } catch (e) {
    // Le message de Node porte le chemin temporaire : on le remplace par le vrai
    // fichier, sinon l'erreur est illisible pour qui la lit dans la CI.
    const msg = String(e.stderr || e.message).split('\n').slice(0, 6).join('\n')
    return msg.split(tmp).join(etiquette)
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true })
  }
}

// ─── Les fichiers .js du front ─────────────────────────────────────────────

const JS_FRONT = DOSSIERS_FRONT.flatMap(d => fichiers(d, '.js'))

test('il Y A des fichiers JS front à vérifier', () => {
  // ⚠ Un test qui ne trouve rien passe toujours. Sans cette garde, renommer un
  // dossier rendrait la suite verte en ne vérifiant plus rien — la faute que ce
  // fichier existe précisément pour empêcher.
  assert.ok(JS_FRONT.length >= 5, `seulement ${JS_FRONT.length} fichiers trouvés`)
  assert.ok(JS_FRONT.includes(path.join('components', 'sidebar.js')),
    'sidebar.js DOIT être couvert : c\'est lui qui a cassé la navigation')
})

for (const f of JS_FRONT) {
  test(`${f} parse`, () => {
    const erreur = parseCommeModule(fs.readFileSync(path.join(racine, f), 'utf8'), f)
    assert.strictEqual(erreur, null, `\n${erreur}`)
  })
}

// ─── Les blocs <script> écrits DANS les pages ──────────────────────────────
//
// ⚠ C'est là que vit le gros du JavaScript de ce dépôt, et un bloc inline casse
// sa page aussi sûrement qu'un fichier. On ignore les scripts EXTERNES (`src=`)
// — c'est le fichier qui est vérifié, pas la balise — et les scripts non JS
// (`type="application/ld+json"` et consorts).

const PAGES = DOSSIERS_FRONT.flatMap(d => fichiers(d, '.html'))
const BLOC = /<script\b([^>]*)>([\s\S]*?)<\/script>/g

test('il Y A des pages à vérifier', () => {
  assert.ok(PAGES.length >= 10, `seulement ${PAGES.length} pages trouvées`)
})

for (const page of PAGES) {
  const html = fs.readFileSync(path.join(racine, page), 'utf8')
  let m, i = 0
  while ((m = BLOC.exec(html)) !== null) {
    const attrs = m[1] || ''
    const source = m[2] || ''
    i++
    if (/\bsrc\s*=/.test(attrs)) continue
    const type = /type\s*=\s*["']([^"']+)["']/.exec(attrs)
    if (type && !/module|javascript/.test(type[1])) continue
    if (!source.trim()) continue
    const etiquette = `${page} (bloc <script> n°${i})`
    test(`${etiquette} parse`, () => {
      const erreur = parseCommeModule(source, etiquette)
      assert.strictEqual(erreur, null, `\n${erreur}`)
    })
  }
}

// ─── La faute exacte, nommée ───────────────────────────────────────────────

test('aucun accent grave DANS un template literal de sidebar.js', () => {
  // ⚠ Le parseur attrape déjà le cas, mais ce test-ci NOMME la faute : un
  // commentaire à l'intérieur d'une chaîne qui part au navigateur, avec des
  // accents graves dedans. Il dit quoi ne pas refaire, là où « SyntaxError »
  // laisse chercher.
  // ⚠ On extrait CHAQUE commentaire (non-greedy, donc borné au premier `-->`)
  // avant de chercher l'accent grave. Un motif qui cherche l'accent « quelque
  // part entre un `<!--` et un `-->` » traverse les commentaires voisins et
  // accuse le premier venu — ma première version signalait un commentaire
  // parfaitement sain vingt lignes plus haut.
  const src = fs.readFileSync(path.join(racine, 'components/sidebar.js'), 'utf8')
  const fautifs = (src.match(/<!--[\s\S]*?-->/g) || []).filter(c => c.includes('`'))
  assert.deepStrictEqual(fautifs, [],
    'un commentaire HTML contenant un accent grave ferme le template literal qui l\'entoure')
})
