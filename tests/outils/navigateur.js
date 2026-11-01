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
  // ⚠ TOUT CHEMIN D'ECHEC TUE LE NAVIGATEUR (constat 5 de la revue de
  // fbb6baee). Trois sorties ne le faisaient pas — le delai de 10 s, l'echec de
  // `/json/list`, le refus du websocket — et un `ChildProcess` dont la sortie
  // est en tube GARDE LA BOUCLE D'EVENEMENTS REFERENCEE : sur une machine
  // chargee, le fichier de test ne rendait jamais la main et la suite entiere
  // restait suspendue. Un test qui ne rougit pas proprement est pire qu'un test
  // absent : il arrete la mesure au lieu de la rendre.
  const tuer = () => {
    try { proc.kill() } catch { /* deja parti */ }
    try { require('node:fs').rmSync(profil, { recursive: true, force: true }) } catch { /* deja parti */ }
  }
  let ouverture = false
  try {
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

  // ⚠ ON NE REND PAS LA MAIN AVANT QUE LE BON DOCUMENT SOIT LA.
  // `Page.enable` ne dit rien du chargement : il peut rester `about:blank` le
  // temps que la navigation vers le fichier se valide. Un test qui evalue a cet
  // instant lit une page vide, ou perd son contexte en pleine lecture.
  //
  // ⚠ ET ON ATTEND L'ETAT, PAS UNE DUREE : l'URL du document est celle
  // demandee ET `readyState` n'est plus `loading`. Sur une machine libre c'est
  // immediat ; sur une machine chargee l'attente s'allonge d'elle-meme. Le
  // plafond de 15 s est la borne au dela de laquelle on ECHOUE, pas un delai
  // qu'on subit.
  {
    const vise = `file://${fichier}`
    const limite = Date.now() + 15000
    for (;;) {
      let pret = false
      try {
        pret = await envoyer('Runtime.evaluate', {
          expression: `document.readyState !== 'loading' && location.href === ${JSON.stringify(vise)}`,
          returnByValue: true
        }).then((r) => r.result.value === true)
      } catch (e) {
        // Le contexte se detruit precisement parce que le document arrive :
        // c'est le cas qu'on attend, pas une panne.
        if (!/Execution context was destroyed/.test(e.message)) throw e
      }
      if (pret) break
      if (Date.now() > limite) {
        throw new Error(`le navigateur n a pas valide ${vise} en 15 s`)
      }
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  // ⚠ CETTE LIGNE EST ICI, ET PAS AVANT LE BLOC CI-DESSUS — releve en review.
  // Le `finally` de cette fonction ne tue le navigateur que `if (!ouverture)` :
  // posee plus haut, elle faisait FUIR le processus des que l'attente du
  // document levait (expiration, ou erreur autre qu'un contexte detruit). Et un
  // `ChildProcess` dont la sortie est en tube garde la boucle d'evenements
  // referencee : le fichier de test ne rend jamais la main et la suite entiere
  // reste SUSPENDUE. C'est le constat 5 de la revue de fbb6baee, rouvert par
  // mon correctif — et sur le chemin le plus probable, la machine chargee.
  // Transformer un rouge intermittent en suspension intermittente serait pire
  // que le defaut d'origine.
  ouverture = true

  /**
   * Evalue une expression dans la page et rend sa valeur.
   *
   * ⚠ ET ELLE REJOUE UNE FOIS SUR UN CONTEXTE DETRUIT. Chrome est lance avec
   * `file://...` EN LIGNE DE COMMANDE : le chargement commence pendant son
   * demarrage, et le contexte dans lequel on evalue peut etre celui d'avant la
   * validation du document. CDP rend alors « Execution context was destroyed »
   * — une erreur de TUYAU, pas une mesure. Mesure du 31 octobre 2026 : une
   * passe sur dix de la suite complete, a 566 ms, avant toute interaction, et
   * le test accusait l'interface.
   *
   * ⚠ UN SEUL REJEU, ET C'EST VOULU. Si le contexte se detruit DEUX fois, ce
   * n'est plus le demarrage : c'est la page qui navigue ou le rendu qui meurt,
   * et il faut le voir. Rejouer en boucle transformerait une panne en attente.
   */
  const lire = async (expression) => {
    let r
    try {
      r = await envoyer('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    } catch (e) {
      if (!/Execution context was destroyed/.test(e.message)) throw e
      r = await envoyer('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    }
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
    // ⚠ `??` ET NON `||`, MEME PIEGE QUE `pose` (constat 2 de la review) :
    // `0 || 5000` vaut 5000, donc un appelant qui demanderait « pas d'attente »
    // en recevrait cinq secondes, en silence. Personne ne passe 0 aujourd'hui ;
    // on ferme la porte avant qu'elle serve.
    const limite = Date.now() + (o.maxMs ?? 5000)
    for (;;) {
      if (await lire(`!!(${expression})`)) return true
      if (Date.now() > limite) {
        throw new Error(`la condition « ${expression} » est restee fausse pendant ${o.maxMs ?? 5000} ms`)
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
  // ⚠ LE MINIMUM SE LIT AVEC `??`, PAS AVEC `||` — releve en review, et le
  // defaut etait complet : `0 || 400` vaut 400, donc un appelant qui demandait
  // « aucun minimum » recevait les 400 ms quand meme, EN SILENCE, pendant que
  // son propre commentaire affirmait « plus aucun minimum ». Une affirmation
  // qui ne rougit jamais. Le commentaire ci-dessous vit HORS du gabarit :
  // l'ecrire dedans y aurait mis des backticks, qui cassent la chaine envoyee
  // a la page (mesure : `node --check` refuse le fichier).
  const pose = (expression, o = {}) => lire(`new Promise((res) => {
    const lu = () => (${expression})
    const debut = Date.now()
    const minimum = ${o.minMs ?? 400}
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
    tuer()
  }

  return { lire, cliquer, attendre, pose, fermer, envoyer }
  } finally {
    if (!ouverture) tuer()
  }
}

module.exports = { ouvrir, navigateurPresent, CHROME }
