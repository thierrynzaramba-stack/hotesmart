// tests/barre-erreur-prod.test.js
// LA BARRE D'ERREUR EN PRODUCTION — ce que l'hôte voit, et ce qu'il ne voit pas.
//
// ⚠ CE FICHIER EXISTE PARCE QUE LE DÉFAUT A VÉCU DES MOIS EN PRODUCTION, sur
// les 23 pages qui appellent `initErrorHandler()`. `isDev` ne conditionnait que
// le DÉTAIL du message ; `bar.style.display = 'flex'` était inconditionnel. Un
// hôte voyait donc « [INFO] API → Réponse OK /api/logement » dans une barre
// noire en monospace, et une trace technique qui ne s'effaçait jamais sur une
// erreur. Rien ne le signalait : aucun test ne montait ce fichier.
//
// Les trois qui comptent :
//   1. en production, un INFO n'atteint JAMAIS l'écran ;
//   2. une ERREUR s'affiche, avec une phrase claire — pas un niveau, pas une
//      source, pas un objet JSON, pas de HTML exécuté ;
//   3. la trace reste en console, sinon on aurait retiré le symptôme ET la
//      capacité de diagnostiquer.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const racine = path.join(__dirname, '..')
const lire = (p) => fs.readFileSync(path.join(racine, p), 'utf8')

// On monte le VRAI fichier, pas une copie : seul l'import absolu de `logger`
// (que le navigateur résout et pas Node) est remplacé par un double qui
// enregistre ce qui part en console.
async function monter (hostname, { avecI18n = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: `https://${hostname}/logements` })
  const traces = []
  global.window = dom.window
  global.document = dom.window.document
  if (avecI18n) dom.window.I18n = { t: (k) => (k === 'erreur.bandeau' ? 'Une erreur est survenue. Réessayez dans un instant.' : k) }

  const source = lire('shared/error-handler.js')
    .replace(/^import \{ logger \} from '\/shared\/logger\.js'$/m,
      'const logger = { error: (s, m, d) => globalThis.__traces.push({ s, m, d }) }')
  globalThis.__traces = traces
  const mod = await import('data:text/javascript,' + encodeURIComponent(source))
  mod.initErrorHandler()

  const emettre = (level, source_, message, data = null) => {
    dom.window.dispatchEvent(new dom.window.CustomEvent('hs:log', {
      detail: { level, source: source_, message, data, timestamp: new Date().toISOString() }
    }))
  }
  const barre = () => dom.window.document.getElementById('hs-debug-bar')
  const visible = () => barre().style.display !== 'none'
  const texte = () => dom.window.document.getElementById('hs-debug-msg').textContent
  return { dom, emettre, barre, visible, texte, traces, mod }
}

test.afterEach(() => { delete global.window; delete global.document; delete globalThis.__traces })

test('LE TEST QUI COMPTE : en PRODUCTION, un INFO n atteint jamais l ecran', async () => {
  const p = await monter('hotesmart.vercel.app')
  assert.equal(p.visible(), false, 'la barre part masquee')
  p.emettre('INFO', 'API', 'Réponse OK /api/logement')
  assert.equal(p.visible(), false, 'c est exactement ce que l hote voyait : « [INFO] API → Réponse OK »')
  assert.equal(p.texte(), '', 'et rien n a meme ete ECRIT dans la barre')
  p.emettre('WARN', 'Canaux', 'relevé partiel')
  assert.equal(p.visible(), false, 'un avertissement technique n est pas pour l hote non plus')
})

test('LE TEST QUI COMPTE : en PRODUCTION, une ERREUR se dit — en une phrase claire', async () => {
  const p = await monter('hotesmart.vercel.app', { avecI18n: true })
  p.emettre('ERROR', 'Logements', 'TypeError: Cannot read properties of undefined', { status: 500 })
  assert.equal(p.visible(), true)
  const vu = p.texte()
  assert.equal(vu, 'Une erreur est survenue. Réessayez dans un instant.')
  // Ni le niveau, ni la source, ni le message technique, ni les donnees.
  for (const fuite of ['ERROR', 'Logements', 'TypeError', 'status', '500']) {
    assert.ok(!vu.includes(fuite), `« ${fuite} » ne doit pas atteindre l ecran`)
  }
})

test('en PRODUCTION sans dictionnaire charge, la phrase reste lisible — jamais une cle brute', async () => {
  const p = await monter('hotesmart.vercel.app')           // pas de window.I18n
  p.emettre('ERROR', 'X', 'boom')
  assert.match(p.texte(), /^Une erreur est survenue/)
  assert.ok(!p.texte().includes('erreur.bandeau'))
  // Et si le moteur est la mais la cle absente : il rend la CLE, on ne l affiche pas.
  const q = await monter('hotesmart.vercel.app')
  q.dom.window.I18n = { t: (k) => k }
  q.emettre('ERROR', 'X', 'boom')
  assert.ok(!q.texte().includes('erreur.bandeau'))
})

test('LE TEST QUI COMPTE (SECURITE) : le message d une erreur n est jamais interprete comme du HTML', async () => {
  // Un message d erreur peut venir d une reponse serveur. La barre n est pas un
  // endroit ou executer ce qu elle contient.
  const p = await monter('hotesmart.vercel.app')
  p.emettre('ERROR', '<img src=x onerror=alert(1)>', '<script>alert(2)</script>')
  assert.equal(p.dom.window.document.querySelectorAll('#hs-debug-bar img, #hs-debug-bar script').length, 0)
})

test('une ERREUR ne s efface pas toute seule : l hote la ferme', async () => {
  const p = await monter('hotesmart.vercel.app')
  p.emettre('ERROR', 'X', 'boom')
  assert.equal(p.visible(), true)
  await new Promise(r => setTimeout(r, 30))
  assert.equal(p.visible(), true, 'une erreur qui disparait avant d etre lue n a pas ete dite')
  p.dom.window.document.getElementById('hs-debug-close').dispatchEvent(new p.dom.window.Event('click'))
  assert.equal(p.visible(), false)
})

test('la croix se ferme aussi au CLAVIER', async () => {
  const p = await monter('hotesmart.vercel.app')
  p.emettre('ERROR', 'X', 'boom')
  const croix = p.dom.window.document.getElementById('hs-debug-close')
  assert.equal(croix.getAttribute('role'), 'button')
  assert.equal(croix.getAttribute('tabindex'), '0')
  croix.dispatchEvent(new p.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  assert.equal(p.visible(), false)
})

test('EN DEVELOPPEMENT, la barre garde tout : niveau, source, message et donnees', async () => {
  // Le but n est pas d aveugler le developpeur : c est l hote qu on protege.
  const p = await monter('localhost')
  p.emettre('INFO', 'API', 'Réponse OK /api/logement', { n: 3 })
  assert.equal(p.visible(), true)
  const html = p.dom.window.document.getElementById('hs-debug-msg').innerHTML
  assert.match(html, /INFO/)
  assert.match(html, /API/)
  assert.match(html, /Réponse OK/)
  assert.match(html, /"n":3/)
  assert.equal(p.barre().style.fontFamily, 'monospace')
})

test('EN DEVELOPPEMENT, un INFO s efface tout seul ; en PRODUCTION la question ne se pose pas', async () => {
  const dev = await monter('127.0.0.1')
  dev.emettre('INFO', 'X', 'y')
  assert.equal(dev.visible(), true)
  // Le minuteur est de 5 s : on verifie qu il EXISTE, pas qu on l attend.
  const source = lire('shared/error-handler.js')
  assert.match(source, /if \(level === 'INFO'\) minuteur = setTimeout\(fermer, 5000\)/)
})

test('LE TEST QUI COMPTE : la trace reste en CONSOLE en production, sinon on a aveugle le diagnostic', async () => {
  // `shared/logger.js` n ecrivait en console QUE en dev : retirer la barre sans
  // ce changement aurait supprime le symptome ET le moyen de diagnostiquer.
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://hotesmart.vercel.app/' })
  global.window = dom.window
  // ⚠ `CustomEvent` DOIT ETRE CELUI DE JSDOM : `logger.js` construit l evenement
  // avec le global, et jsdom refuse un Event d un autre realm. Le meme piege de
  // realm que `deepEqual` sur deux objets identiques.
  const vraiCE = global.CustomEvent
  global.CustomEvent = dom.window.CustomEvent
  const appels = []
  for (const canal of ['log', 'debug', 'warn', 'error']) {
    dom.window.console[canal] = (...a) => appels.push({ canal, a })
  }
  const vraiConsole = global.console
  global.console = dom.window.console
  try {
    const { logger } = await import('data:text/javascript,' + encodeURIComponent(lire('shared/logger.js')))
    logger.info('API', 'Réponse OK')
    logger.warn('Canaux', 'relevé partiel')
    logger.error('Logements', 'boom')
  } finally { global.console = vraiConsole; global.CustomEvent = vraiCE }
  assert.deepEqual(appels.map(x => x.canal), ['debug', 'warn', 'error'],
    'INFO en debug (masqué par défaut dans les DevTools), WARN et ERROR sur leurs canaux')
  assert.match(appels[0].a[0], /\[INFO\] API → Réponse OK/)
})

test('LE TEST QUI COMPTE : aucune page n est oubliee — les 23 appelantes passent par CE fichier', async () => {
  // Une page qui recopierait la barre echapperait a la garde.
  const { execSync } = require('node:child_process')
  const sortie = execSync(
    `grep -rl "initErrorHandler()" --include=*.html --include=*.js ${racine}/pages ${racine}/apps ${racine}/core ${racine}/components 2>/dev/null || true`,
    { encoding: 'utf8' }).trim()
  const pages = sortie ? sortie.split('\n') : []
  assert.ok(pages.length >= 20, `${pages.length} pages appellent initErrorHandler`)
  for (const f of pages) {
    const src = fs.readFileSync(f, 'utf8')
    assert.ok(/error-handler\.js/.test(src), `${path.basename(f)} doit importer le module partagé`)
    assert.ok(!/hs-debug-bar/.test(src), `${path.basename(f)} ne doit pas recopier la barre`)
  }
})
