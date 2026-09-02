// tests/pages-identifiants.test.js
// Les identifiants libres utilises par un script de page existent-ils ?
//
// ⚠ POURQUOI CE TEST EXISTE. J'ai ajoute `import { compteCourant } from …` dans
// le bloc `<script type="module">` de messagerie.html, alors que TOUS les usages
// sont dans le `<script>` CLASSIQUE juste en dessous — qui ne peut pas importer.
// Resultat : `ReferenceError: compteCourant is not defined` a la premiere
// lecture, et la messagerie ne s'affichait plus DU TOUT.
//
// Les 440 tests etaient verts : aucun ne charge le HTML. `pages-ids.test.js` ne
// verifie que les `id` du DOM, pas les identifiants JS. Ce test comble ce trou.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

// Pages dont le script principal est un script CLASSIQUE : il ne peut rien
// importer, donc tout ce qu'il utilise doit lui etre expose sur `window`.
// ⚠ pages/avis.html a la MEME structure : un <script type="module"> qui importe,
// et un <script> classique qui fait tout le travail. C'est exactement la
// configuration qui a tue la messagerie.
const PAGES = ['apps/agent-ai/messagerie.html', 'pages/avis.html']

// Helpers venus de shared/compte-courant.js, systematiquement en cause.
const HELPERS = ['compteCourant', 'peutEcrire', 'peutLire', 'enteteCompte', 'estTitulaire', 'apiCall']

function scripts (html) {
  const out = []
  for (const m of html.matchAll(/<script(\s+type="module")?>([\s\S]*?)<\/script>/g)) {
    out.push({ module: !!m[1], corps: m[2] })
  }
  return out
}

for (const page of PAGES) {
  test(`${page} : les helpers de compte sont exposes au script classique`, () => {
    const html = fs.readFileSync(path.join(__dirname, '..', page), 'utf8')
    const blocs = scripts(html)
    const modules = blocs.filter(b => b.module).map(b => b.corps).join('\n')
    const classiques = blocs.filter(b => !b.module).map(b => b.corps).join('\n')

    for (const h of HELPERS) {
      const utilise = new RegExp(`(^|[^.\\w])${h}\\s*\\(`).test(classiques)
      if (!utilise) continue
      // Utilise dans un script classique -> il doit etre pose sur window par un
      // module, sinon c'est un ReferenceError a l'execution.
      const expose = new RegExp(`window\\.${h}\\s*=`).test(modules)
      assert.ok(expose,
        `${h}() est appele dans le script classique de ${page} mais n'est jamais expose ` +
        `(un import dans le module ne suffit PAS : les deux scripts ne partagent pas leur portee)`)
    }
  })

  test(`${page} : ce qui est expose est bien importe`, () => {
    const html = fs.readFileSync(path.join(__dirname, '..', page), 'utf8')
    const modules = scripts(html).filter(b => b.module).map(b => b.corps).join('\n')
    for (const m of modules.matchAll(/window\.(\w+)\s*=\s*(\w+)\s*$/gm)) {
      const source = m[2]
      if (!HELPERS.includes(source)) continue
      assert.ok(new RegExp(`import\\s*\\{[^}]*\\b${source}\\b`).test(modules),
        `window.${m[1]} = ${source} mais ${source} n'est pas importe`)
    }
  })
}

test('les pages qui appellent l\'API en fetch brut posent X-Compte', () => {
  // ⚠ `shared/api-client.js` pose l'en-tete tout seul ; un `fetch` direct, non.
  // Sans lui, le serveur travaille sur le compte de l'appelant pendant que le
  // reste de la page lit le compte courant : l'ecran melange deux comptes.
  const cibles = [
    ['apps/menages/index.html', '/api/menages'],
    ['apps/agent-ai/messagerie.html', '/api/messages']
  ]
  for (const [page, endpoint] of cibles) {
    const html = fs.readFileSync(path.join(__dirname, '..', page), 'utf8')
    const i = html.indexOf(`fetch(\`${endpoint}`) >= 0
      ? html.indexOf(`fetch(\`${endpoint}`) : html.indexOf(`fetch('${endpoint}'`)
    assert.ok(i > 0, `appel a ${endpoint} introuvable dans ${page}`)
    const appel = html.slice(i, i + 400)
    assert.ok(appel.includes('enteteCompte()'),
      `${page} appelle ${endpoint} sans X-Compte : la delegation ne fonctionnera pas`)
  }
})

// ─── apiCall lève, il ne renvoie pas { error } ──────────────────────────────
test('pages/avis.html : chaque appel apiCall est protégé par un try', () => {
  // ⚠ `apiCall` LÈVE sur réponse non-ok (l'erreur porte `.status`). Traiter son
  // retour comme `{ error }` laissait l'exception remonter : page blanche au
  // premier 403 — c'est-à-dire le cas NORMAL d'un membre au périmètre restreint,
  // pas un cas limite.
  const html = fs.readFileSync(path.join(__dirname, '..', 'pages/avis.html'), 'utf8')
  const appels = [...html.matchAll(/apiCall\(/g)].length
  const essais = [...html.matchAll(/try\s*\{/g)].length
  assert.ok(appels >= 3, 'la page doit appeler apiCall')
  assert.ok(essais >= appels - 1,
    `${appels} appels apiCall pour seulement ${essais} try : un appel non protégé casse la page`)
})
