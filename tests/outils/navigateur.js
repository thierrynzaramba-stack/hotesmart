// tests/outils/navigateur.js — un VRAI navigateur, pilote par CDP.
//
// ⚠ POURQUOI CET OUTIL EXISTE. Demande de Thierry du 29 octobre 2026, sur les
// fleches du rail des avis : « un VRAI clic sur la fleche doit charger les avis
// suivants. Ne mesure pas un defilement fait par programme. »
//
// Les deux autres bancs de ce depot (`courbe-bande-rendu`, `ibulle-rendu`)
// lancent chrome en `--dump-dom` : ils mesurent un rendu, ils ne GESTENT pas.
// Un `element.click()` ecrit dans la page n'est pas un clic non plus — il
// appelle le gestionnaire SANS passer par le test de recouvrement du
// navigateur, donc il reste vert sur un bouton couvert par une carte, place
// hors de l'ecran, ou neutralise par `pointer-events: none`.
// `Input.dispatchMouseEvent` envoie l'evenement aux COORDONNEES : c'est le
// navigateur qui decide quel element le recoit.
//
// ⚠ ET IL N'A AUCUNE DEPENDANCE : `fetch` et `WebSocket` sont dans Node 22+.
// Ajouter puppeteer pour trois appels serait payer une dette d'outillage pour
// un gain nul.

const { spawn } = require('node:child_process')

const CHROME = '/home/thierry/.cache/ms-playwright/chromium_headless_shell-1243'
  + '/chrome-headless-shell-linux64/chrome-headless-shell'
const LIBS = '/home/thierry/.cache/hotesmart-banc/libs/usr/lib/x86_64-linux-gnu'

/** Le navigateur de banc est-il installe ? Un test ne doit JAMAIS se taire. */
function navigateurPresent () { return require('node:fs').existsSync(CHROME) }

/**
 * Ouvre une page dans un vrai navigateur et rend un pilote.
 * @param {string} fichier chemin absolu du .html
 * @param {{largeur?: number, hauteur?: number}} [o]
 */
async function ouvrir (fichier, o = {}) {
  const largeur = o.largeur || 1280
  const hauteur = o.hauteur || 900
  // ⚠ UN PROFIL PAR INSTANCE, ET CE N'EST PAS DU CONFORT. Sans
  // `--user-data-dir`, deux lancements se partagent le profil par defaut et le
  // second se RATTACHE au premier : la page demandee s'ouvre alors dans la
  // fenetre de l'autre, a SA taille. Mesure du 29 octobre 2026 : le test du
  // telephone passait seul (fleches `display: none` a 390 px) et echouait dans
  // la suite complete, ou il lisait `inline-block` — il mesurait la fenetre de
  // 1 280 px du test precedent. Un banc dont le resultat depend de ses voisins
  // ne mesure rien.
  const profil = require('node:fs').mkdtempSync(
    require('node:path').join(require('node:os').tmpdir(), 'cdp-profil-'))
  const proc = spawn(CHROME, ['--headless', '--no-sandbox', '--disable-gpu',
    '--allow-file-access-from-files', '--remote-debugging-port=0',
    `--user-data-dir=${profil}`, '--no-first-run', '--no-default-browser-check',
    `--window-size=${largeur},${hauteur}`, `file://${fichier}`],
  { env: { ...process.env, LD_LIBRARY_PATH: LIBS }, stdio: ['ignore', 'pipe', 'pipe'] })

  // Le port est annonce sur la sortie d'erreur, et il est TIRE AU SORT
  // (`--remote-debugging-port=0`) : deux tests qui tournent en parallele ne
  // doivent pas se disputer un port fixe.
  const url = await new Promise((res, rej) => {
    let buf = ''
    const minuteur = setTimeout(() => rej(new Error(
      `le navigateur n a pas annonce son websocket en 10 s : ${buf.slice(0, 300)}`)), 10000)
    proc.stderr.on('data', (d) => {
      buf += String(d)
      const m = buf.match(/ws:\/\/127\.0\.0\.1:(\d+)/)
      if (m) { clearTimeout(minuteur); res(m[0]) }
    })
    proc.on('exit', (c) => { clearTimeout(minuteur); rej(new Error(`le navigateur est sorti (code ${c})`)) })
  })
  const port = url.match(/:(\d+)/)[1]

  const cibles = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const cible = cibles.find(c => c.type === 'page')
  if (!cible) { proc.kill(); throw new Error('aucune page dans la liste des cibles CDP') }

  const ws = new WebSocket(cible.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('websocket CDP refuse')), { once: true })
  })

  let id = 0
  const envoyer = (method, params = {}) => new Promise((res, rej) => {
    const n = ++id
    const minuteur = setTimeout(() => rej(new Error(`CDP ${method} sans reponse en 10 s`)), 10000)
    const h = (e) => {
      const m = JSON.parse(e.data)
      if (m.id !== n) return
      clearTimeout(minuteur)
      ws.removeEventListener('message', h)
      if (m.error) rej(new Error(`CDP ${method} : ${m.error.message}`))
      else res(m.result)
    }
    ws.addEventListener('message', h)
    ws.send(JSON.stringify({ id: n, method, params }))
  })

  await envoyer('Page.enable')
  await envoyer('Runtime.enable')

  /** Evalue une expression dans la page et rend sa valeur. */
  const lire = async (expression) => {
    const r = await envoyer('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) {
      throw new Error(`la page a leve : ${r.exceptionDetails.exception
        ? r.exceptionDetails.exception.description : r.exceptionDetails.text}`)
    }
    return r.result.value
  }

  /**
   * UN VRAI CLIC, aux coordonnees du centre du selecteur. Si l'element est
   * absent, hors de l'ecran ou recouvert, le clic n'arrive pas a lui — et
   * c'est tout l'interet.
   */
  const cliquer = async (selecteur) => {
    const boite = await lire(`(() => {
      const n = document.querySelector(${JSON.stringify(selecteur)})
      if (!n) return null
      const r = n.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, l: r.width, h: r.height }
    })()`)
    if (!boite) throw new Error(`aucun element pour « ${selecteur} »`)
    if (boite.l < 1 || boite.h < 1) throw new Error(`« ${selecteur} » n a aucune surface (${boite.l}x${boite.h}) : un clic ne peut pas l atteindre`)
    const x = Math.round(boite.x)
    const y = Math.round(boite.y)
    // ⚠ QUI RECOIT VRAIMENT CE POINT ? On le demande au navigateur AVANT de
    // cliquer, et le test peut l'asserter : c'est la seule facon de distinguer
    // « le clic n'a rien fait » de « le clic est tombe sur autre chose ».
    const recu = await lire(`(() => {
      const n = document.elementFromPoint(${x}, ${y})
      if (!n) return '(rien)'
      const c = n.closest(${JSON.stringify(selecteur)})
      return c ? 'CIBLE' : (n.tagName.toLowerCase() + '.' + String(n.className || ''))
    })()`)
    await envoyer('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await envoyer('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    return { x, y, recu }
  }

  /**
   * Attend qu'une condition de la page devienne vraie. ⚠ INDISPENSABLE AVANT
   * TOUTE MESURE D'UNE PAGE A MODULE : un `<script type="module">` est DIFFERE,
   * donc une lecture faite juste apres l'ouverture tombe sur un DOM que le
   * module n'a pas encore rempli. Mesure du 29 octobre 2026 : le test du
   * telephone lisait un rail vide (`pret: false`, 0 carte) et accusait le CSS.
   */
  const attendre = async (expression, o = {}) => {
    const limite = Date.now() + (o.maxMs || 5000)
    for (;;) {
      if (await lire(`!!(${expression})`)) return true
      if (Date.now() > limite) {
        throw new Error(`la condition « ${expression} » est restee fausse pendant ${o.maxMs || 5000} ms`)
      }
      await lire('new Promise(r => setTimeout(r, 50))')
    }
  }

  /**
   * Attend qu'une valeur numerique de la page se POSE, apres un defilement
   * doux. ⚠ LE DELAI MINIMUM N'EST PAS DU CONFORT : sans lui, une boucle de
   * stabilite lit trois fois la valeur de DEPART avant que l'animation ait
   * commence, et conclut « pose a 0 ». C'est le faux rouge du 29 octobre 2026,
   * et son symetrique serait un faux vert si la valeur de depart etait la
   * valeur attendue.
   */
  const pose = (expression, o = {}) => lire(`new Promise((res) => {
    const lu = () => (${expression})
    const debut = Date.now()
    const minimum = ${o.minMs || 400}
    let dernier = null, stable = 0
    const t = setInterval(() => {
      const x = lu()
      if (x === dernier) stable++
      else { stable = 0; dernier = x }
      if (stable >= 3 && Date.now() - debut >= minimum) { clearInterval(t); res(x) }
    }, 50)
    setTimeout(() => { clearInterval(t); res(lu()) }, ${o.maxMs || 4000})
  })`)

  const fermer = () => {
    try { ws.close() } catch { /* deja ferme */ }
    proc.kill()
    try { require('node:fs').rmSync(profil, { recursive: true, force: true }) } catch { /* parti */ }
  }

  return { lire, cliquer, attendre, pose, fermer, envoyer }
}

module.exports = { ouvrir, navigateurPresent, CHROME }
