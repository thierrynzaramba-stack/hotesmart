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
// par defaut de la page (`/pages/index.html` -> `/pages/aujourdhui`) : les SIX
// tests d'alors sont restes VERTS, parce qu'ils interrogeaient la copie. Un
// test qui se compare a lui-meme ne fige rien. Il EXTRAIT donc la fonction de
// la page, et c'est elle qui est jugee.
//
// ⚠ ET EXTRAIRE LA FONCTION NE SUFFIT PAS : il faut aussi prouver qu'elle est
// APPELEE. Juger `destination()` en vase clos laisse passer le remplacement de
// `window.location.href = APRES_CONNEXION` par la valeur brute de `next` — la
// redirection ouverte revient, la fonction reste parfaite, et les tests restent
// verts. D'ou le test de CABLAGE ci-dessous.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const ORIGINE = 'https://hotesmart.vercel.app'
const PAGE = path.join(__dirname, '..', 'pages', 'login.html')
const DEFAUT = '/pages/aujourdhui'

// Extraction par comptage d'accolades : on prend la fonction telle qu'elle est
// ecrite dans la page, sans la reecrire.
//
// ⚠ CE QUE CETTE EXTRACTION NE SAIT PAS FAIRE. Le comptage ne tokenise ni les
// chaines, ni les commentaires, ni les gabarits : le jour ou `destination()`
// contiendra une accolade DANS une chaine, le corps rendu sera tronque. C'est
// assume — mais alors l'erreur doit NOMMER la cause, et surtout ne pas faire
// echouer le module entier sans designer un seul test. D'ou la resolution
// PARESSEUSE plus bas : jusqu'au 20 octobre 2026, l'extraction et ses asserts
// tournaient au CHARGEMENT du fichier, et node:test rapportait alors « le
// harnais est casse » la ou il fallait lire « le filtre de redirection ouverte
// n'est plus sous test ».
function sourceDeDestination () {
  const html = fs.readFileSync(PAGE, 'utf8')
  // Tolerant a l'espacement : `function destination()` comme `destination ()`.
  const m = /function\s+destination\s*\(\s*\)/.exec(html)
  assert.ok(m, 'pages/login.html ne declare plus `function destination ()`')
  const debut = m.index
  let profondeur = 0
  for (let j = html.indexOf('{', debut); j < html.length; j++) {
    if (html[j] === '{') profondeur++
    else if (html[j] === '}') { profondeur--; if (profondeur === 0) return html.slice(debut, j + 1) }
  }
  throw new Error('accolade fermante introuvable pour destination()')
}

// `location` est injecte : la fonction de la page lit `location.search` et
// `location.origin`, on ne touche a rien d'autre.
let _bati = null
function bati () {
  if (_bati) return _bati
  const src = sourceDeDestination()
  try { _bati = new Function('location', src + '\nreturn destination()') }
  catch (e) {
    throw new Error('destination() extraite de pages/login.html ne compile pas '
      + "(extraction par comptage d'accolades, voir l'en-tete) : " + e.message)
  }
  return _bati
}
const destination = (recherche, origine = ORIGINE) =>
  bati()({ search: recherche, origin: origine })

test('LE TEST QUI COMPTE : la fonction jugee est bien celle de la page', () => {
  // Si la page cesse de filtrer, ces deux marqueurs disparaissent et
  // l'extraction doit le dire plutot que de juger une fonction vide.
  const SOURCE = sourceDeDestination()
  assert.ok(SOURCE.includes("startsWith('//')"), 'le refus du double slash a disparu de la page')
  assert.ok(SOURCE.includes("includes('\\\\')"), 'le refus du backslash a disparu de la page')
})

test('LE TEST QUI COMPTE : toute navigation de la page passe par destination()', () => {
  // Le filtre ne protege que ce qui passe par lui. On releve TOUTES les
  // navigations du module de pages/login.html et on exige qu'aucune n'aille
  // ailleurs que vers la valeur calculee par `destination()`.
  const html = fs.readFileSync(PAGE, 'utf8')
  const module_ = html.slice(html.indexOf('<script type="module">'), html.lastIndexOf('</script>'))
  assert.match(module_, /const\s+APRES_CONNEXION\s*=\s*destination\s*\(\s*\)/,
    'APRES_CONNEXION ne vient plus de destination() : le filtre est contourne')
  const navigations = module_.match(/(?:window\.)?location\s*\.\s*(?:href|replace)\s*(?:=|\()[^\n]*/g) || []
  assert.ok(navigations.length >= 3,
    'moins de navigations que prevu dans pages/login.html : relire ce test, il ne mesure plus rien')
  for (const nav of navigations) {
    assert.ok(nav.includes('APRES_CONNEXION'),
      'une navigation de pages/login.html contourne destination() : ' + nav.trim())
  }
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
