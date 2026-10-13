// tests/pages-v5-identifiants.test.js
// AUCUNE FONCTION APPELÉE N'EST INCONNUE, sur les pages V5.
//
// ⚠ POURQUOI CE TEST EXISTE. Le 13 octobre 2026, la fiche ménage appelait
// `heureParis(...)` — une fonction supprimée d'un nettoyage précédent. La
// page se chargeait, le planning s'affichait, et le tiroir s'ouvrait VIDE au
// clic sur la pastille la plus fréquente (un ménage proposé) : `ReferenceError`
// levée pendant l'évaluation du gabarit, donc avant toute écriture dans le DOM.
// Rien ne rougissait : les tests de page font du grep de chaînes, les tests
// d'endpoint ne touchent pas au navigateur, et une capture d'écran de recette
// montrait une fiche… qui n'avait pas ce cas-là.
//
// Ce test ne remplace pas un test de rendu — il attrape la classe entière de
// défauts qu'un rendu partiel laisse passer : un identifiant qui n'existe pas.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const racine = path.join(__dirname, '..')
const lire = p => fs.readFileSync(path.join(racine, p), 'utf8')

// Ce que le navigateur fournit, ce que la page charge par <script>, et ce que
// le langage déclare. Tout le reste doit être déclaré ou importé DANS le module.
const FOURNIS = new Set([
  // globaux du navigateur et du langage
  'window', 'document', 'console', 'fetch', 'localStorage', 'sessionStorage',
  'navigator', 'location', 'history', 'alert', 'confirm', 'prompt',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
  'requestAnimationFrame', 'structuredClone', 'getComputedStyle', 'matchMedia',
  'Intl', 'Math', 'JSON', 'Date', 'Number', 'String', 'Boolean', 'Array',
  'Object', 'Set', 'Map', 'WeakMap', 'Promise', 'Error', 'RegExp', 'Symbol',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'URL', 'URLSearchParams',
  'FormData', 'Blob', 'FileReader', 'IntersectionObserver', 'ResizeObserver',
  'CustomEvent', 'Event', 'AbortController', 'BigInt',
  // chargés par <script> avant le module (voir l'en-tête de la page)
  'I18n', 'HSNav',
  // mots-clés et formes qui ressemblent à un appel
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await',
  'function', 'new', 'delete', 'void', 'in', 'of', 'do', 'else', 'case',
  'throw', 'yield', 'instanceof', 'constructor', 'super', 'this', 'async',
  // `$` : le raccourci querySelector des pages V5 (`const $ = …`). Les
  // frontières de mot de JavaScript ne le reconnaissent pas, il se déclare ici.
  '$'
])

function identifiantsManquants (html) {
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(html)
  assert.ok(m, 'le script de module est introuvable')
  // ⚠ ON LIT LA SOURCE BRUTE, SANS LA DÉCOUPER. Une première version retirait
  // commentaires et gabarits à la regex : les gabarits imbriqués (`${`…`}`)
  // la désynchronisaient et elle accusait une dizaine de fonctions qui
  // existaient. Un test qui crie pour rien est pire qu'inutile — on apprend à
  // l'ignorer, et le vrai défaut passe avec les autres.
  //
  // La question posée est donc volontairement MODESTE, mais sans faux
  // positif : « ce nom appelé apparaît-il quelque part comme déclaration ? ».
  // Elle ne dit rien des portées ; elle attrape ce qui n'existe NULLE PART —
  // exactement le cas `heureParis`.
  // ⚠ On neutralise les COMMENTAIRES et les chaînes simples : le dépôt
  // commente en français, et « (voir plus haut) » ou « la fiche (étape 3) »
  // ressemblent à des appels. Les gabarits, eux, restent intacts — y toucher
  // à la regex est ce qui avait désynchronisé la première version.
  const src = m[1]
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"\`])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
  const brut = m[1]
  const declare = (nom) => new RegExp(
    '(?:function|const|let|var|class)\\s+' + nom + '\\b' +   // déclaration
    '|\\b' + nom + '\\s*[:=]' +                              // propriété ou affectation
    '|import\\s*\\{[\\s\\S]*?\\b' + nom + '\\b[\\s\\S]*?\\}\\s*\\n?\\s*from' // import nommé, même sur plusieurs lignes
  ).test(brut)

  const appels = new Set()
  const reAppel = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g
  let a
  while ((a = reAppel.exec(src))) appels.add(a[2])
  return [...appels].filter(n => !FOURNIS.has(n) && !declare(n)).sort()
}

for (const page of ['pages/menages.html', 'pages/calendrier.html']) {
  test(`${page} : aucune fonction appelée n'est inconnue`, () => {
    const manquants = identifiantsManquants(lire(page))
    assert.deepEqual(manquants, [],
      'identifiants appelés mais ni déclarés ni importés : ' + manquants.join(', '))
  })
}
