// tests/pwa-hors-ligne.test.js
//
// La page hors-ligne de l'appli hôte (PWA lot 1) : shared/pwa/hors-ligne.html.
// Rendue dans jsdom avec le VRAI shared/i18n/i18n.js et les VRAIS
// dictionnaires, dans chacune des langues de langues.json — liste DÉRIVÉE,
// pas recopiée : une quatrième langue entrera dans ce test sans qu'on y pense.
//
// Ce que ce test tient :
//   - le titre « Vous êtes hors connexion » et le bouton « Réessayer » sont
//     traduits dans chaque langue, et rien n'est écrit en dur dans la page ;
//   - « Réessayer » recharge la page (donc la VRAIE page demandée : le service
//     worker sert la page hors-ligne à l'adresse d'origine) ;
//   - la page reste dans la charte : aucun hexa, rien que des var(--…), et
//     tout ce qu'elle charge est dans la liste positive du service worker.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM, VirtualConsole } = require('jsdom')

const RACINE = path.join(__dirname, '..')
const lire = (f) => fs.readFileSync(path.join(RACINE, f), 'utf8')
const HTML = lire('shared/pwa/hors-ligne.html')
const LANGUES = JSON.parse(lire('shared/i18n/langues.json')).map(l => l.code)

async function rendre (lang) {
  const erreurs = []
  const console = new VirtualConsole()
  console.on('jsdomError', e => erreurs.push(e.message))
  const dom = new JSDOM(HTML, { url: 'https://hotesmart.test/calendrier', runScripts: 'outside-only', virtualConsole: console })
  const w = dom.window
  // Le réseau de la page : les fichiers du dépôt, comme le service worker les sert.
  w.fetch = async (u) => {
    const p = new URL(u, w.location.href).pathname
    const f = path.join(RACINE, p)
    return { ok: fs.existsSync(f), json: async () => JSON.parse(fs.readFileSync(f, 'utf8')) }
  }
  w.localStorage.setItem('hs.lang', lang)
  w.eval(lire('shared/i18n/i18n.js'))
  const scripts = [...w.document.querySelectorAll('script:not([src])')]
  assert.equal(scripts.length, 1, 'un seul script en ligne attendu')
  w.eval(scripts[0].textContent)
  for (let i = 0; i < 50 && !w.document.querySelector('h1').textContent; i++) await new Promise(r => setTimeout(r, 10))
  return { w, d: w.document, erreurs }
}

test('les langues à vérifier viennent de langues.json', () => {
  assert.ok(LANGUES.length >= 3, `au moins fr, en, es (${LANGUES.join(', ')})`)
  for (const l of ['fr', 'en', 'es']) assert.ok(LANGUES.includes(l))
})

for (const lang of LANGUES) {
  test(`LE TEST QUI COMPTE : la page hors-ligne en ${lang}`, async () => {
    const dico = JSON.parse(lire(`shared/i18n/${lang}.json`))
    for (const cle of ['offline.title', 'offline.retry']) {
      assert.ok(typeof dico[cle] === 'string' && dico[cle].trim(), `${lang} : ${cle} manquante ou vide`)
    }
    const { d } = await rendre(lang)
    assert.equal(d.documentElement.lang, lang)
    assert.equal(d.querySelector('h1').textContent, dico['offline.title'])
    assert.equal(d.querySelector('[data-reessayer]').textContent, dico['offline.retry'])
    assert.equal(d.title, dico['offline.title'])
  })
}

test('« Réessayer » recharge la page demandée', async () => {
  const { d, erreurs } = await rendre('fr')
  d.querySelector('[data-reessayer]').click()
  // jsdom ne sait pas recharger : il le DIT, et c'est la trace du geste.
  assert.ok(erreurs.some(m => /navigation/i.test(m)), `aucun rechargement tenté (${erreurs.join(' | ')})`)
})

test('aucun texte en dur : tout texte visible porte une clé i18n', () => {
  const d = new JSDOM(HTML).window.document
  const textes = []
  const parcourir = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3 && c.textContent.trim() && !['SCRIPT', 'STYLE', 'TITLE'].includes(n.nodeName)) textes.push(c.textContent.trim())
      if (c.nodeType === 1) parcourir(c)
    }
  }
  parcourir(d.body)
  assert.deepEqual(textes, [])
  const cles = [...d.querySelectorAll('[data-i18n]')].map(e => e.dataset.i18n).sort()
  assert.deepEqual(cles, ['offline.retry', 'offline.title'])
  assert.equal(d.querySelector('img').getAttribute('alt'), '', 'le logo est décoratif')
})

test('dans la charte : aucun hexa, et tout ce qu\'elle charge est dans le hors-ligne du service worker', () => {
  const net = HTML.replace(/<!--[\s\S]*?-->/g, '')
  assert.doesNotMatch(net, /#[0-9a-f]{3,8}\b/i)
  const d = new JSDOM(HTML).window.document
  const charges = [
    ...[...d.querySelectorAll('link[rel="stylesheet"], link[rel="icon"]')].map(l => l.getAttribute('href')),
    ...[...d.querySelectorAll('script[src], img[src]')].map(e => e.getAttribute('src'))
  ]
  const sw = lire('shared/pwa/service-worker.js')
  const statiques = [...sw.match(/const STATIQUES = \[([\s\S]*?)\]/)[1].matchAll(/'([^']+)'/g)].map(m => m[1])
  const police = sw.match(/const POLICE = '([^']+)'/)[1]
  assert.ok(charges.length >= 5, 'le contrôle doit avoir des ressources à examiner')
  for (const c of charges) {
    assert.ok(statiques.includes(c) || c === police, `${c} n'est pas disponible hors ligne`)
  }
})
