// tests/barre-erreur-prod.test.js
// LA BARRE D'ERREUR EN PRODUCTION — ce que l'hôte voit, et ce qu'il ne voit pas.
//
// ⚠ CE FICHIER EXISTE PARCE QUE LE DÉFAUT A VÉCU DES MOIS EN PRODUCTION, sur
// les 22 écrans qui appellent `initErrorHandler()`. `isDev` ne conditionnait que
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
async function monter (hostname, { avecI18n = false, avecNav = 0 } = {}) {
  const corps = avecNav ? `<nav class="bottombar" style="height:${avecNav}px"></nav>` : ''
  const dom = new JSDOM(`<!doctype html><html><body>${corps}</body></html>`, { url: `https://${hostname}/logements` })
  // ⚠ jsdom ne met pas en page : `getBoundingClientRect` rend 0 partout. On
  // pose la hauteur voulue, comme le navigateur la calculerait.
  if (avecNav) {
    const nav = dom.window.document.querySelector('.bottombar')
    nav.getBoundingClientRect = () => ({ height: avecNav })
    Object.defineProperty(nav, 'offsetParent', { get: () => dom.window.document.body })
  }
  const traces = []
  // ⚠ LES MINUTEURS SONT CAPTURES, PAS ATTENDUS : un test qui dort 15 secondes
  // ne serait pas lance, et un test qui lit la ligne de code ne mesure rien.
  // ⚠ LE PATCH NE DURE QUE L'EMISSION. Patcher `globalThis.setTimeout` pour
  // toute la vie du banc bloquait le lanceur de tests lui-meme : le premier
  // `await new Promise(r => setTimeout(r, 30))` d'un autre test ne se resolvait
  // jamais, et la suite tournait sans fin. On l'enveloppe donc autour du seul
  // dispatch, qui est l'endroit ou le module programme son masquage.
  const minuteurs = []
  global.window = dom.window
  global.document = dom.window.document
  // ⚠ UNE CHAÎNE DISTINCTE DU REPLI (constat M3 de la revue). Mon double
  // rendait EXACTEMENT `PHRASE_PAR_DEFAUT` : le test ne pouvait pas distinguer
  // « traduction appliquée » de « repli », et couper l'accès à I18n le laissait
  // vert. Prouvé par mutation.
  if (avecI18n) dom.window.I18n = { t: (k) => (k === 'erreur.bandeau' ? 'PHRASE TRADUITE.' : k === 'erreur.fermer' ? 'FERMER TRADUIT' : k) }

  // ⚠ LE VRAI `estDev` EST CHARGE, PAS SIMULE. Il vient de `shared/logger.js`,
  // et c'est lui qui decide si la barre affiche ou se tait : le remplacer par
  // une copie dans le test reviendrait a mesurer mon propre double sur la
  // question meme que ce fichier doit trancher. Seul `logger` est double, pour
  // observer les traces.
  globalThis.__traces = traces
  const vraiLogger = await import('data:text/javascript,' + encodeURIComponent(lire('shared/logger.js')))
  globalThis.__pont = {
    logger: { error: (s, m, d) => globalThis.__traces.push({ s, m, d }) },
    estDev: vraiLogger.estDev
  }
  const source = lire('shared/error-handler.js')
    .replace(/^import \{ logger, estDev \} from '\/shared\/logger\.js'$/m,
      'const { logger, estDev } = globalThis.__pont')
  // Un import non remplace ferait lever a l'import : on le dit tout de suite.
  assert.doesNotMatch(source, /^import .*logger\.js'/m, "l'import de logger.js doit etre remplace")
  const mod = await import('data:text/javascript,' + encodeURIComponent(source))
  mod.initErrorHandler()

  const emettre = (level, source_, message, data = null) => {
    const vraiSetTimeout = globalThis.setTimeout
    const vraiClear = globalThis.clearTimeout
    globalThis.setTimeout = (fn, delai) => { minuteurs.push({ fn, delai }); return minuteurs.length }
    globalThis.clearTimeout = () => {}
    try {
      dom.window.dispatchEvent(new dom.window.CustomEvent('hs:log', {
        detail: { level, source: source_, message, data, timestamp: new Date().toISOString() }
      }))
    } finally {
      globalThis.setTimeout = vraiSetTimeout
      globalThis.clearTimeout = vraiClear
    }
  }
  const barre = () => dom.window.document.getElementById('hs-debug-bar')
  const visible = () => barre().style.display !== 'none'
  const texte = () => dom.window.document.getElementById('hs-debug-msg').textContent
  return { dom, emettre, barre, visible, texte, traces, mod, minuteurs }
}

const RESTAURER = []
test.afterEach(() => {
  while (RESTAURER.length) RESTAURER.pop()()
  delete global.window; delete global.document; delete globalThis.__traces; delete globalThis.__pont
})

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
  assert.equal(vu, 'PHRASE TRADUITE.', 'la traduction est bien consultée, pas seulement le repli')
  assert.equal(p.dom.window.document.getElementById('hs-debug-close').getAttribute('aria-label'), 'FERMER TRADUIT',
    'le libellé de la croix est traduit lui aussi — pas un texte en dur')
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

test('LE TEST QUI COMPTE (M4) : la barre S EFFACE vraiment — on mesure le masquage, pas la ligne de code', async () => {
  // Mon test d avant assertait une REGEX SUR LE SOURCE : il verifiait que la
  // ligne existe, pas qu elle s execute. Prouve par mutation — un `return`
  // place juste apres l affichage laissait 10/10 verts avec l auto-masquage
  // mort. On capture donc le minuteur et on le declenche.
  const dev = await monter('127.0.0.1')
  dev.emettre('INFO', 'X', 'y')
  assert.equal(dev.visible(), true)
  assert.equal(dev.minuteurs.length, 1, 'un masquage a ete programme')
  assert.equal(dev.minuteurs[0].delai, 5000, 'un INFO de developpeur part en 5 s')
  dev.minuteurs[0].fn()
  assert.equal(dev.visible(), false, 'et il part VRAIMENT')

  // En production, une ERREUR part aussi — plus tard, et la croix reste.
  const prod = await monter('hotesmart.vercel.app')
  prod.emettre('ERROR', 'X', 'boom')
  assert.equal(prod.minuteurs[0].delai, 15000, 'assez pour etre lue, pas assez pour s installer')
  prod.minuteurs[0].fn()
  assert.equal(prod.visible(), false)
})

test('LE TEST QUI COMPTE (G1) : un 401, un 403 ou un 404 n allument RIEN en production', async () => {
  // `shared/api-client.js` journalise une erreur sur TOUTE reponse non-OK, deux
  // fois par appel echoue. Un 401 renvoie vers la connexion, un 403 est deja dit
  // par l ecran, un 404 est souvent facultatif : les afficher ajoutait une
  // alarme rouge par-dessus une information deja donnee — « deux messages pour
  // une panne ».
  const p = await monter('hotesmart.vercel.app')
  for (const status of [401, 403, 404]) {
    p.emettre('ERROR', 'API', 'Non autorisé', { endpoint: 'logement', status })
    assert.equal(p.visible(), false, `un ${status} ne doit pas allumer la barre`)
  }
  // Contre-epreuve : une vraie panne, elle, se dit.
  p.emettre('ERROR', 'API', 'Erreur serveur', { endpoint: 'logement', status: 503 })
  assert.equal(p.visible(), true)
  // Et une erreur sans statut (une exception JS) aussi.
  const q = await monter('hotesmart.vercel.app')
  q.emettre('ERROR', 'Global', 'TypeError')
  assert.equal(q.visible(), true)
})

test('LE TEST QUI COMPTE (G1c) : la barre ne RECOUVRE PAS la navigation basse', async () => {
  // `.bottombar` est en `position: fixed; bottom: 0`, haute d environ 66 px :
  // une barre d erreur a `bottom: 0` masquait les libelles et la moitie des
  // icones des cinq entrees.
  const p = await monter('hotesmart.vercel.app', { avecNav: 66 })
  p.emettre('ERROR', 'X', 'boom')
  assert.equal(p.barre().style.bottom, 'calc(66px + env(safe-area-inset-bottom))',
    `la barre doit se poser au-dessus de la nav : ${p.barre().style.bottom}`)
  // Sans nav affichee, elle revient en bas — mais jamais dans la zone de
  // l indicateur d accueil de l iPhone.
  const q = await monter('hotesmart.vercel.app')
  q.emettre('ERROR', 'X', 'boom')
  assert.equal(q.barre().style.bottom, 'calc(0px + env(safe-area-inset-bottom))')
  // Et la regle elle-meme, sans passer par jsdom : il refuse `env(x, y)` et
  // laisse alors l ancienne valeur en place — un test qui lirait le style
  // pourrait donc etre vert pour la mauvaise raison.
  assert.equal(p.mod.basDeLaBarre(0), 'calc(0px + env(safe-area-inset-bottom))')
  assert.equal(p.mod.basDeLaBarre(66.4), 'calc(66px + env(safe-area-inset-bottom))')
  assert.equal(p.mod.basDeLaBarre(null), 'calc(0px + env(safe-area-inset-bottom))')
  assert.equal(p.mod.basDeLaBarre(-5), 'calc(0px + env(safe-area-inset-bottom))')
})

test('LE TEST QUI COMPTE : la croix fait 44 px, la regle qui ne se negocie pas', async () => {
  const p = await monter('hotesmart.vercel.app')
  p.emettre('ERROR', 'X', 'boom')
  const croix = p.dom.window.document.getElementById('hs-debug-close')
  assert.match(croix.style.minWidth, /^44px$/)
  assert.match(croix.style.minHeight, /^44px$/)
})

test('LE TEST QUI COMPTE (SECURITE) : en DEVELOPPEMENT non plus, un message n est interprete comme du HTML', async () => {
  // La branche developpeur interpolait `source` et `message` dans `innerHTML`.
  // Ces chaines viennent d une reponse serveur, et `localhost` parle a la base
  // de PRODUCTION (shared/config.js) : c etait une injection dans une session
  // porteuse des identifiants de production.
  const p = await monter('localhost')
  p.emettre('ERROR', '<img src=x onerror=alert(1)>', '<script>alert(2)</script>', { x: '<b>y</b>' })
  const barre = p.barre()
  assert.equal(barre.querySelectorAll('img, script, b').length, 0)
  // Et le detail reste lisible, en TEXTE.
  assert.match(barre.textContent, /<img src=x onerror=alert\(1\)>/)
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

// ⚠ CE TEST NE COUVRAIT PAS LE CAS QU IL ANNONCAIT (constat M5 de la revue).
// Il ne lisait que les fichiers appelant DEJA `initErrorHandler()` : une page
// qui recopiait la barre et ecoutait `hs:log` sans l appeler passait au
// travers — prouve par mutation, 10/10 verts avec une page pirate. Et son
// perimetre excluait la racine, `public/` et `shared/`.
const chercher = (motif) => {
  const { execSync } = require('node:child_process')
  const sortie = execSync(
    `grep -rl ${JSON.stringify(motif)} --include=*.html --include=*.js . ` +
    `--exclude-dir=node_modules --exclude-dir=.git 2>/dev/null || true`,
    { encoding: 'utf8', cwd: racine }).trim()
  return (sortie ? sortie.split('\n') : []).map(f => f.replace(/^\.\//, '')).sort()
}

test('LE TEST QUI COMPTE (M5) : UN SEUL fichier peint la barre et ecoute les logs, dans TOUT le depot', async () => {
  // Deux surfaces d affichage, c est deux regles — et celle qu on vient de
  // poser ne vaudrait que pour l une des deux.
  assert.deepEqual(chercher('hs-debug-bar'), ['shared/error-handler.js', 'tests/barre-erreur-prod.test.js'],
    'seuls le module et son test connaissent la barre')
  // Ce fichier-ci cite le motif dans son propre texte : il est donc attendu.
  assert.deepEqual(chercher("addEventListener('hs:log'"),
    ['shared/error-handler.js', 'tests/barre-erreur-prod.test.js'],
    'un second ecouteur echapperait a la garde de production')
})

test('aucune page n est oubliee : toutes les appelantes passent par le module partage', async () => {
  const pages = chercher('initErrorHandler()').filter(f => !f.startsWith('tests/') && f !== 'shared/error-handler.js')
  // ⚠ UN PLANCHER, PAS UN COMPTE EXACT : 22 ecrans au 20 octobre 2026, et le
  // chiffre MONTE a chaque page V5 livree (la liste des logements l appellera).
  // Un compte exact rougirait a la prochaine page, pour rien ; un plancher
  // attrape ce qui compte — une page qui PERD l appel.
  assert.ok(pages.length >= 22, `${pages.length} ecrans appellent initErrorHandler (22 au 20 octobre 2026)`)
  for (const f of pages) {
    const src = fs.readFileSync(path.join(racine, f), 'utf8')
    assert.ok(/error-handler\.js/.test(src), `${f} doit importer le module partagé`)
  }
})
