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
// La regle est recopiee a l'identique depuis pages/login.html : ce test la fige.

const test = require('node:test')
const assert = require('node:assert')

const ORIGINE = 'https://hotesmart.vercel.app'

function destination (recherche, origine = ORIGINE) {
  const brut = new URLSearchParams(recherche).get('next')
  if (!brut) return '/pages/index.html'
  if (!brut.startsWith('/') || brut.startsWith('//') || brut.includes('\\')) {
    return '/pages/index.html'
  }
  try {
    const u = new URL(brut, origine)
    return u.origin === origine ? u.pathname + u.search : '/pages/index.html'
  } catch { return '/pages/index.html' }
}

test('sans next -> tableau de bord', () => {
  assert.strictEqual(destination(''), '/pages/index.html')
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
    assert.strictEqual(destination('?next=' + encodeURIComponent(mechant)), '/pages/index.html', mechant)
  }
})

test('REDIRECTION OUVERTE : le double slash vaut une URL absolue', () => {
  // `//faux-site.fr` est une URL relative au SCHEMA : le navigateur y voit
  // https://faux-site.fr. C'est le contournement classique d'un test qui se
  // contenterait de « commence par / ».
  assert.strictEqual(destination('?next=' + encodeURIComponent('//faux-site.fr/x')), '/pages/index.html')
  assert.strictEqual(destination('?next=' + encodeURIComponent('/\\faux-site.fr')), '/pages/index.html')
})

test('REDIRECTION OUVERTE : un backslash est refuse', () => {
  // Certains navigateurs traitent \ comme / dans une URL.
  assert.strictEqual(destination('?next=' + encodeURIComponent('/\\\\faux-site.fr')), '/pages/index.html')
})

test('une valeur vide ou absurde retombe sur le tableau de bord', () => {
  assert.strictEqual(destination('?next='), '/pages/index.html')
  assert.strictEqual(destination('?next=' + encodeURIComponent('pas-un-chemin')), '/pages/index.html')
})
