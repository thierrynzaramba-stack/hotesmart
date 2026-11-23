// tests/pwa-nav.test.js
//
// Le branchement de l'appli installable dans shared/nav.js (PWA lot 1) :
// nav.js est l'en-tête commun DE FAIT des sept écrans V5 (il n'existe pas
// d'en-tête HTML partagé, et pages/ ne bouge pas pendant la refonte).
//
// Ce que ce test tient, en EXÉCUTANT nav.js dans jsdom :
//   - les balises manifest, theme-color, apple-mobile-web-app-* et
//     apple-touch-icon sont posées UNE fois, jamais doublées ;
//   - theme-color est lue dans la charte (contre-épreuve : une autre valeur
//     de --surface donne une autre balise) ;
//   - le service worker s'enregistre APRÈS le chargement, depuis nav.js, avec
//     la portée « / » et sans cache HTTP sur ses mises à jour ;
//   - aucune page n'enregistre de service worker en ligne ;
//   - aucun hexa dans les fichiers du lot.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')
const { variablesDeLaCharte } = require('../lib/pwa')

const RACINE = path.join(__dirname, '..')
const lire = (f) => fs.readFileSync(path.join(RACINE, f), 'utf8')
const NAV = lire('shared/nav.js')
const SURFACE = variablesDeLaCharte(lire('shared/theme.css'))['--surface']

function charger ({ surface = SURFACE, tete = '', avecSW = true, executions = 1 } = {}) {
  const enregistrements = []
  const dom = new JSDOM(`<!doctype html><html><head><style>:root{--surface:${surface}}</style>${tete}</head><body></body></html>`, {
    url: 'https://hotesmart.test/pages/aujourdhui',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  })
  const w = dom.window
  if (avecSW) {
    Object.defineProperty(w.navigator, 'serviceWorker', {
      value: { register: (...args) => { enregistrements.push(args); return Promise.resolve({}) } }
    })
  }
  for (let i = 0; i < executions; i++) w.eval(NAV)
  return { w, d: w.document, enregistrements }
}

const compter = (d, sel) => d.head.querySelectorAll(sel).length

test('LE TEST QUI COMPTE : les balises de l\'appli installable sont posées une fois', () => {
  const { d } = charger({ executions: 2 })
  const attendues = {
    'link[rel="manifest"]': ['href', '/manifest.webmanifest'],
    'link[rel="apple-touch-icon"]': ['href', '/apple-touch-icon.png'],
    'meta[name="mobile-web-app-capable"]': ['content', 'yes'],
    'meta[name="apple-mobile-web-app-capable"]': ['content', 'yes'],
    'meta[name="apple-mobile-web-app-status-bar-style"]': ['content', 'default'],
    'meta[name="apple-mobile-web-app-title"]': ['content', 'HôteSmart'],
    'meta[name="theme-color"]': ['content', SURFACE]
  }
  for (const [sel, [attr, val]] of Object.entries(attendues)) {
    assert.equal(compter(d, sel), 1, `${sel} : une fois, même nav.js exécuté deux fois`)
    assert.equal(d.head.querySelector(sel).getAttribute(attr), val, sel)
  }
  assert.equal(d.head.querySelector('link[rel="manifest"]').getAttribute('crossorigin'), 'use-credentials')
  // Le fichier de l'icône iPhone existe bien à l'adresse posée.
  assert.ok(fs.existsSync(path.join(RACINE, 'apple-touch-icon.png')))
})

test('theme-color vient de la charte : contre-épreuve avec une autre --surface', () => {
  assert.match(SURFACE, /^#[0-9a-f]{3,6}$/i)
  const { d } = charger({ surface: '#123456' })
  assert.equal(d.head.querySelector('meta[name="theme-color"]').content, '#123456')
})

test('une balise que la page porte déjà n\'est pas doublée', () => {
  const { d } = charger({ tete: '<meta name="theme-color" content="red"><link rel="manifest" href="/autre.webmanifest">' })
  assert.equal(compter(d, 'meta[name="theme-color"]'), 1)
  assert.equal(d.head.querySelector('meta[name="theme-color"]').content, 'red')
  assert.equal(compter(d, 'link[rel="manifest"]'), 1)
})

test('LE TEST QUI COMPTE : le service worker s\'enregistre APRÈS le chargement, depuis nav.js', async () => {
  const { w, enregistrements } = charger()
  assert.equal(enregistrements.length, 0, 'pas pendant que la page se charge')
  w.dispatchEvent(new w.Event('load'))
  w.dispatchEvent(new w.Event('load'))
  assert.equal(enregistrements.length, 1, 'une fois, à la fin du chargement')
  // Objet né dans le royaume de jsdom : comparé par sa forme JSON.
  assert.equal(JSON.stringify(enregistrements[0]), JSON.stringify(['/sw.js', { scope: '/', updateViaCache: 'none' }]))
})

test('sans service worker dans le navigateur, nav.js ne lève pas', () => {
  assert.doesNotThrow(() => {
    const { w } = charger({ avecSW: false })
    w.dispatchEvent(new w.Event('load'))
  })
})

test('aucune page n\'enregistre un service worker en ligne', () => {
  // ⚠ MOTIF TEXTUEL, EN DERNIER RECOURS (REVIEW.md règle 20) : on ne peut pas
  // exécuter quarante pages. Il cherche l'appel `serviceWorker.register`, et
  // ne voit PAS un enregistrement construit autrement (alias, chaîne).
  // La seule exception est l'appli PRESTATAIRE, qui a son propre service
  // worker et sa propre portée (/apps/menages/).
  const fichiers = []
  const parcourir = (rel) => {
    for (const e of fs.readdirSync(path.join(RACINE, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name)
      if (e.isDirectory()) parcourir(r)
      else if (/\.(html|js)$/.test(e.name)) fichiers.push(r)
    }
  }
  for (const d of ['pages', 'apps', 'components', 'shared', 'public']) parcourir(d)
  fichiers.push('index.html')
  assert.ok(fichiers.length > 50, 'le balayage doit avoir des fichiers à examiner')
  const coupables = fichiers.filter(f => /serviceWorker\s*\.\s*register\s*\(/.test(lire(f))).sort()
  assert.deepEqual(coupables, ['apps/menages/public.html', 'shared/nav.js'])
  // Contre-épreuve : le motif reconnaît bien un enregistrement en ligne.
  assert.match('<script>navigator.serviceWorker.register("/sw.js")</script>', /serviceWorker\s*\.\s*register\s*\(/)
})

test('chaque écran V5 charge nav.js, et la page de démarrage en fait partie', () => {
  const v = JSON.parse(lire('vercel.json'))
  const dashboard = v.rewrites.find(r => r.source === '/dashboard')
  assert.equal(dashboard.destination, '/pages/aujourdhui', 'start_url /dashboard mène à l\'accueil V5')
  const ecrans = fs.readdirSync(path.join(RACINE, 'pages')).filter(f => f.endsWith('.html'))
    .filter(f => /class="bottombar"/.test(lire(`pages/${f}`)))
  assert.ok(ecrans.length >= 7, `les écrans V5 (barre du bas) : ${ecrans.join(', ')}`)
  assert.ok(ecrans.includes('aujourdhui.html'))
  for (const f of ecrans) assert.match(lire(`pages/${f}`), /<script src="\/shared\/nav\.js"><\/script>/, `${f} ne charge pas nav.js`)
})

test('aucun hexa dans les fichiers du lot (la charte vit dans theme.css)', () => {
  const HEXA = /#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/i
  const LOT = ['shared/nav.js', 'lib/pwa.js', 'api/pwa.js', 'shared/pwa/service-worker.js',
    'shared/pwa/hors-ligne.html', 'scripts/pwa-icones.js']
  for (const f of LOT) assert.doesNotMatch(lire(f), HEXA, `${f} porte un hexa`)
  // Contre-épreuve : le motif voit un hexa de six et de trois chiffres.
  assert.match('color: #FFFFFF;', HEXA)
  assert.match('color: #fff;', HEXA)
})
