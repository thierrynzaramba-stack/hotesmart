// tests/invitation-redirection.test.js
// La destination post-connexion de pages/login.html.
//
// ⚠ POURQUOI CE TEST EXISTE. `next` vient de l'URL, donc du client. Accepter sa
// valeur telle quelle ferait de la page de connexion un TREMPLIN : un lien
// « /login?next=https://faux-site » renvoie l'hote, apres une connexion
// parfaitement reelle, sur une page qui lui redemande son mot de passe. C'est la
// redirection ouverte, et elle est d'autant plus credible ici que le parcours
// d'invitation apprend aux gens a suivre un lien qu'on leur a envoye.
//
// ⚠ ET POURQUOI IL NE RECOPIE PLUS LA FONCTION. Jusqu'au 20 octobre 2026, ce
// fichier portait sa PROPRE copie de `destination()`, « recopiee a l'identique
// depuis pages/login.html ». Le lot « accueil rapide » a change la destination
// par defaut de la page (`/pages/index.html` -> `/pages/aujourdhui`) : les sept
// tests sont restes VERTS, parce qu'ils interrogeaient la copie. Un test qui se
// compare a lui-meme ne fige rien. Il EXTRAIT donc la fonction de la page, et
// c'est elle qui est jugee.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const ORIGINE = 'https://hotesmart.vercel.app'
const PAGE = path.join(__dirname, '..', 'pages', 'login.html')
const DEFAUT = '/pages/aujourdhui'

// Extraction par comptage d'accolades : on prend la fonction telle qu'elle est
// ecrite dans la page, sans la reecrire.
function sourceDeDestination () {
  const html = fs.readFileSync(PAGE, 'utf8')
  const debut = html.indexOf('function destination ()')
  assert.notStrictEqual(debut, -1, 'pages/login.html ne declare plus `function destination ()`')
  let i = html.indexOf('{', debut)
  let profondeur = 0
  for (let j = i; j < html.length; j++) {
    if (html[j] === '{') profondeur++
    else if (html[j] === '}') { profondeur--; if (profondeur === 0) return html.slice(debut, j + 1) }
  }
  throw new Error('accolade fermante introuvable pour destination()')
}

const SOURCE = sourceDeDestination()

// `location` est injecte : la fonction de la page lit `location.search` et
// `location.origin`, on ne touche a rien d'autre.
const bati = new Function('location', SOURCE + '\nreturn destination()')
const destination = (recherche, origine = ORIGINE) =>
  bati({ search: recherche, origin: origine })

test('LE TEST QUI COMPTE : la fonction jugee est bien celle de la page', () => {
  // Si la page cesse de filtrer, ces deux marqueurs disparaissent et
  // l'extraction doit le dire plutot que de juger une fonction vide.
  assert.ok(SOURCE.includes("startsWith('//')"), 'le refus du double slash a disparu de la page')
  assert.ok(SOURCE.includes("includes('\\\\')"), 'le refus du backslash a disparu de la page')
})

test('sans next -> accueil de l application', () => {
  assert.strictEqual(destination(''), DEFAUT)
})

test('chemin interne -> conserve, avec sa query', () => {
  assert.strictEqual(
    destination('?next=' + encodeURIComponent('/invitation?token=abc123')),
    '/invitation?token=abc123')
})

test('REDIRECTION OUVERTE : une URL absolue est refusee', () => {
  for (const mechant of [
    'https://faux-site.fr/login',
    'http://faux-site.fr',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>'
  ]) {
    assert.strictEqual(destination('?next=' + encodeURIComponent(mechant)), DEFAUT, mechant)
  }
})

test('REDIRECTION OUVERTE : le double slash vaut une URL absolue', () => {
  // `//faux-site.fr` est une URL relative au SCHEMA : le navigateur y voit
  // https://faux-site.fr. C'est le contournement classique d'un test qui se
  // contenterait de « commence par / ».
  assert.strictEqual(destination('?next=' + encodeURIComponent('//faux-site.fr/x')), DEFAUT)
  assert.strictEqual(destination('?next=' + encodeURIComponent('/\\faux-site.fr')), DEFAUT)
})

test('REDIRECTION OUVERTE : un backslash est refuse', () => {
  // Certains navigateurs traitent \ comme / dans une URL.
  assert.strictEqual(destination('?next=' + encodeURIComponent('/\\\\faux-site.fr')), DEFAUT)
})

test('une valeur vide ou absurde retombe sur l accueil', () => {
  assert.strictEqual(destination('?next='), DEFAUT)
  assert.strictEqual(destination('?next=' + encodeURIComponent('pas-un-chemin')), DEFAUT)
})
