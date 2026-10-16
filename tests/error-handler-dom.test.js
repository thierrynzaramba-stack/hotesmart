// tests/error-handler-dom.test.js — LA BANDE DE DEBUG NE SORT PAS EN PRODUCTION.
//
// CE QU'ILS EMPÊCHENT :
//   - une bande noire à texte technique peinte chez l'hôte à la moindre erreur
//     d'API, de RLS ou de script — au téléphone elle recouvre la barre de
//     navigation (z-index 9999 contre 10 de `.bottombar`) ;
//   - l'excès inverse : couper la CAPTURE des erreurs en même temps que leur
//     affichage. Elles doivent continuer d'entrer dans `logger.getLogs()`,
//     sinon on se prive du diagnostic pour gagner un pixel.
//
// ⚠ ON EXÉCUTE LES VRAIS MODULES, pas une copie : `shared/logger.js` et
// `shared/error-handler.js` sont évalués ENSEMBLE dans une seule fenêtre (le
// second importe le premier ; seuls les mots `export`/`import` sont retirés
// pour les évaluer comme un script, motif de temperature-calendrier-dom).
//
// ⚠ AUCUNE DATE ICI : ce fichier ne lit pas l'horloge, il n'a donc pas à
// rougir tout seul dans un mois (règle du dépôt sur les dates figées).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { JSDOM, VirtualConsole } = require('jsdom')

const lire = (f) => fs.readFileSync(path.join(__dirname, '..', 'shared', f), 'utf8')
const CONFIG = lire('config.js')
const LOGGER = lire('logger.js')
const HANDLER = lire('error-handler.js')

// LES CINQ ADRESSES QUI COMPTENT. La règle est dans `shared/config.js`
// (`MODE_DIAGNOSTIC`) et vaut pour la console comme pour la bande.
const PROD = 'https://hotesmart.vercel.app/pages/aujourdhui'
const PREVIEW = 'https://hotesmart-git-ui-v5-bugs-equipe.vercel.app/pages/aujourdhui'
const PREVIEW_DEBUG = PREVIEW + '?debug=1'
const STAGING = 'https://hotesmart-staging.vercel.app/pages/aujourdhui'
const LOCAL = 'http://localhost:3000/pages/aujourdhui'
const LAN = 'http://192.168.1.24:3000/pages/aujourdhui'

function monter (url) {
  // Console muette : en développement, `logger` écrit dans celle de la page.
  // Sans ce silence, la sortie de la suite se remplit de ses lignes.
  const dom = new JSDOM('<!doctype html><html><body></body></html>',
    { url, runScripts: 'outside-only', virtualConsole: new VirtualConsole() })
  // ⚠ UN BLOC PAR MODULE, dans l'ordre des imports : config → logger →
  // error-handler. Le bloc rend à chacun sa portée lexicale, comme le ferait
  // le chargeur de modules du navigateur ; sans lui, deux `const` de même nom
  // dans une seule portée lèvent. `__pont` fait passer les seuls liens réels
  // entre eux — `MODE_DIAGNOSTIC` et `logger`.
  const nu = (src) => src.replace(/^export default .*$/gm, '')
    .replace(/^import .*$/gm, '').replace(/^export /gm, '')
  const source = 'var __pont = {}\n' +
    '{\n' + nu(CONFIG) + '\n__pont.MODE_DIAGNOSTIC = MODE_DIAGNOSTIC\n}\n' +
    '{\nconst MODE_DIAGNOSTIC = __pont.MODE_DIAGNOSTIC\n' + nu(LOGGER) + '\n__pont.logger = logger\n}\n' +
    '{\nconst MODE_DIAGNOSTIC = __pont.MODE_DIAGNOSTIC\nconst logger = __pont.logger\n' +
    nu(HANDLER) + '\n' +
    'window.__eh = { initErrorHandler, handleApiError, logger, MODE_DIAGNOSTIC }\n}'
  dom.window.eval(source)
  return { dom, win: dom.window, doc: dom.window.document, eh: dom.window.__eh }
}

const bande = (doc) => doc.getElementById('hs-debug-bar')

test('LE TEST QUI COMPTE : en production, une erreur ne peint aucune bande', () => {
  const { doc, eh } = monter(PROD)
  eh.initErrorHandler()
  eh.logger.error('Aujourdhui', 'yield jour', { status: 404 })
  assert.equal(bande(doc), null, 'aucune bande ne doit exister en production')
})

test('en production, la bande n’existe pas même après une erreur JS globale', () => {
  const { win, doc, eh } = monter(PROD)
  eh.initErrorHandler()
  win.dispatchEvent(new win.ErrorEvent('error', { message: 'boom', filename: 'x.js', lineno: 12 }))
  assert.equal(bande(doc), null)
})

test('CAPTURER N’EST PAS AFFICHER : en production l’erreur entre quand même au journal', () => {
  const { win, eh } = monter(PROD)
  eh.initErrorHandler()
  eh.logger.error('Aujourdhui', 'yield jour', { status: 404 })
  win.dispatchEvent(new win.ErrorEvent('error', { message: 'boom' }))
  const journal = eh.logger.getLogs()
  assert.equal(journal.length, 2, 'les deux erreurs sont journalisées')
  assert.equal(journal[0].message, 'yield jour')
  assert.equal(journal[1].source, 'Global')
})

test('une promesse rejetée est journalisée en production, sans rien peindre', () => {
  const { win, doc, eh } = monter(PROD)
  eh.initErrorHandler()
  const e = new win.Event('unhandledrejection')
  e.reason = new Error('rejet')
  win.dispatchEvent(e)
  assert.equal(bande(doc), null)
  assert.equal(eh.logger.getLogs().at(-1).source, 'Promise')
})

test('en local, la bande apparaît et porte le message — l’outil n’est pas perdu', () => {
  const { doc, eh } = monter(LOCAL)
  eh.initErrorHandler()
  assert.ok(bande(doc), 'la bande est construite en développement')
  assert.equal(bande(doc).style.display, 'none', 'et reste cachée tant que rien n’est arrivé')
  eh.logger.error('Aujourdhui', 'yield jour', { status: 404 })
  assert.equal(bande(doc).style.display, 'flex')
  const texte = doc.getElementById('hs-debug-msg').textContent
  assert.match(texte, /\[ERROR\] Aujourdhui → yield jour/)
  assert.match(texte, /404/, 'le détail JSON reste en développement')
})

test('LA RECETTE GARDE SON OUTIL : staging, le réseau local et ?debug=1 peignent la bande', () => {
  for (const url of [STAGING, LAN, PREVIEW_DEBUG]) {
    const { doc, eh } = monter(url)
    eh.initErrorHandler()
    eh.logger.error('Aujourdhui', 'yield jour', { status: 404 })
    assert.equal(bande(doc) && bande(doc).style.display, 'flex', `la bande manque sur ${url}`)
  }
})

test('une preview du projet de PRODUCTION reste muette sans la porte ?debug=1', () => {
  const { doc, eh } = monter(PREVIEW)
  eh.initErrorHandler()
  eh.logger.error('Aujourdhui', 'yield jour', { status: 404 })
  assert.equal(bande(doc), null, 'une preview sert la base de production : pas de bande par défaut')
})

test('le journal est borné : une erreur en boucle ne fait pas enfler la mémoire', () => {
  const { eh } = monter(PROD)
  eh.initErrorHandler()
  for (let i = 0; i < 500; i++) eh.logger.error('Boucle', 'tentative ' + i)
  const journal = eh.logger.getLogs()
  assert.equal(journal.length, 200, 'le journal garde 200 lignes au plus')
  assert.equal(journal.at(-1).message, 'tentative 499', 'et ce sont les DERNIÈRES, celles qui expliquent')
})

test('le journal n’est atteignable qu’en diagnostic, et il ne se modifie pas du dehors', () => {
  const { win: wp, eh: ep } = monter(PROD)
  ep.initErrorHandler()
  assert.equal(wp.__hsLogs, undefined, 'rien n’est posé sur window en production')

  const { win: wl, eh: el } = monter(LOCAL)
  el.initErrorHandler()
  el.logger.error('Aujourdhui', 'yield jour')
  assert.equal(wl.__hsLogs().length, 1, 'la console du navigateur peut lire le journal')
  el.logger.getLogs().push({ faux: true })
  assert.equal(el.logger.getLogs().length, 1, 'la copie rendue ne touche pas le journal')
})

test('handleApiError rend le message et journalise, des deux côtés', () => {
  for (const url of [PROD, LOCAL]) {
    const { eh } = monter(url)
    eh.initErrorHandler()
    assert.equal(eh.handleApiError('Calendrier', new Error('écriture refusée')), 'écriture refusée')
    assert.equal(eh.logger.getLogs().at(-1).source, 'Calendrier')
  }
})
