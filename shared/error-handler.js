import { logger, estDev } from '/shared/logger.js'

// ═══════════════════════════════════════════════════════════════════════════
// LA BARRE D'ERREUR — ce que l'hôte voit quand quelque chose casse
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠ CE FICHIER A AFFICHÉ DES TRACES DE DÉVELOPPEUR EN PRODUCTION, sur les
// 22 écrans qui l'appellent, et pendant des mois. `isDev` ne conditionnait que
// le DÉTAIL du message : `bar.style.display = 'flex'` était inconditionnel.
// Un hôte voyait donc passer « [INFO] API → Réponse OK /api/logement » dans une
// barre noire en monospace — et, sur une erreur, une trace technique qui ne
// s'effaçait jamais. Constaté le 20 octobre 2026 sur une capture de staging.
//
// La règle, posée par Thierry le même jour :
//   · en production, AUCUN message INFO ni WARN n'atteint l'écran ;
//   · une ERREUR s'affiche, avec une phrase claire — pas un niveau, pas une
//     source, pas un objet JSON ;
//   · les traces restent dans la console du navigateur et dans les journaux du
//     serveur, là où on les lit pour diagnostiquer.
//
// ⚠ ET LE TEST QUI LE TIENT EST `tests/barre-erreur-prod.test.js` : il monte ce
// fichier sous un hostname de PRODUCTION et échoue si un INFO s'affiche.

// ⚠ CES STATUTS NE SONT PAS DES PANNES. Un 401 renvoie vers la connexion, un
// 403 est dit par l'écran qui l'a reçu, un 404 est souvent facultatif. Les
// afficher ajoutait une alarme rouge par-dessus une information déjà donnée.
const ATTENDUS = new Set([401, 403, 404])

// ⚠ `estDev` VIENT DE `shared/logger.js`, elle n'est pas recopiée ici : les
// deux fichiers décident de la même chose — l'un si la trace part en console,
// l'autre si elle s'affiche — et deux copies finiraient par diverger. Elle est
// évaluée À L'APPEL : en constante de module, elle fige la décision avant qu'un
// test ait pu poser son URL, ce qui rend la règle intestable.

// Un texte de la barre. Traduit si le moteur est là ; sinon le repli, parce
// qu'une barre d'erreur ne doit pas dépendre d'un dictionnaire chargé.
//
// ⚠ ET CE REPLI SERT SOUVENT (constat M1 de la revue) : seules cinq des
// vingt-deux pages qui appellent `initErrorHandler()` chargent
// `shared/i18n/i18n.js`. Sur les dix-sept autres — dont les quatorze `apps/` —
// `window.I18n` n'existe pas, et un hôte anglophone lit donc le français. Les
// clés anglaise et espagnole existent pour les cinq pages traduites, et pour
// celles qui le deviendront ; la dette est nommée dans le message du commit.
const REPLIS = {
  'erreur.bandeau': 'Une erreur est survenue. Réessayez dans un instant.',
  'erreur.fermer': 'Fermer'
}
function libelle (cle, repli) {
  try {
    const t = window.I18n && window.I18n.t && window.I18n.t(cle)
    // Le moteur rend la CLÉ quand elle manque : on ne l'affiche pas à l'écran.
    return t && t !== cle ? t : repli
  } catch { return repli }
}
const phraseClaire = () => libelle('erreur.bandeau', REPLIS['erreur.bandeau'])

// ⚠ LA BARRE NE RECOUVRE PAS LA NAVIGATION BASSE (constat G1c de la revue).
// `.bottombar` est en `position: fixed; bottom: 0` et haute d'environ 66 px :
// une barre d'erreur à `bottom: 0` masquait les libellés et la moitié des
// icônes des cinq entrées, sans limite de durée. On se pose AU-DESSUS d'elle
// quand elle est affichée — ce qui dépend de la largeur, donc se recalcule à
// chaque affichage et pas une fois pour toutes.
//
// `env(safe-area-inset-bottom)` dans tous les cas : sur un iPhone sans barre
// basse, le texte tombait sinon dans la zone de l'indicateur d'accueil.
function placer (bar) {
  let hauteurNav = 0
  try {
    const nav = document.querySelector('.bottombar')
    if (nav && nav.offsetParent !== null) hauteurNav = nav.getBoundingClientRect().height || 0
  } catch { hauteurNav = 0 }
  bar.style.bottom = basDeLaBarre(hauteurNav)
}

// ⚠ `env(…)` SANS REPLI, comme partout dans `shared/ui.css` (`.bottombar`,
// `.cal-flottante`, `.cal-toasts`). Le repli `env(x, 0px)` est pourtant la
// forme la plus sure en theorie — mais le depot a deja tranche, et deux formes
// pour la meme notion divergeraient. `calc()` enveloppe toujours, y compris
// sans nav : une valeur homogene se compare et se lit.
function basDeLaBarre (hauteurNav) {
  const h = Math.max(0, Math.round(Number(hauteurNav) || 0))
  return `calc(${h}px + env(safe-area-inset-bottom))`
}

export function initErrorHandler() {
  // ⚠ LES JETONS DU THÈME, AVEC UN REPLI. Quatorze pages ne chargent aucune
  // feuille (marque blanche, app prestataire hors ligne) : un `var()` sans
  // repli y rendrait la barre invisible ou illisible.
  const bar = document.createElement('div')
  bar.id = 'hs-debug-bar'
  bar.setAttribute('role', 'status')
  bar.setAttribute('aria-live', 'polite')
  // ⚠ L'ENCRE DU THÈME, PAS `--danger` (constat G2 de la revue). En mode
  // sombre, `shared/theme.css` redéfinit `--danger-soft` mais PAS `--danger` :
  // le texte tombait à 2,46:1 et la croix à 1,83:1, là où AA demande 4,5:1 pour
  // du 14 px. La croix — seule façon d'écarter la barre — en devenait
  // pratiquement invisible. On garde le fond d'alerte et on écrit avec l'encre
  // normale, qui suit le thème.
  bar.style.cssText = `
    position: fixed; left: 0; right: 0;
    bottom: calc(0px + env(safe-area-inset-bottom));
    background: var(--danger-soft, #FEF0EE); color: var(--ink, #1A1A1A);
    border-top: 1px solid var(--danger, #B42318);
    font-family: inherit; font-size: 14px; line-height: 1.4;
    padding: 10px 16px; z-index: 9999;
    display: none; align-items: center;
    justify-content: space-between; gap: 12px;
  `
  // ⚠ 44 px SOUS LE POUCE : `--control` vaut 44 px et la règle « ne se négocie
  // pas ». La croix faisait 22 × 20 px — sur la seule action de cette barre.
  // ⚠ Et son libellé est TRADUIT (le dépôt interdit un texte en dur), avec le
  // même repli que la phrase : une barre d'erreur ne dépend pas d'un
  // dictionnaire chargé.
  const msgEl = document.createElement('span')
  msgEl.id = 'hs-debug-msg'
  const croixEl = document.createElement('span')
  croixEl.id = 'hs-debug-close'
  croixEl.setAttribute('role', 'button')
  croixEl.setAttribute('tabindex', '0')
  croixEl.setAttribute('aria-label', libelle('erreur.fermer', 'Fermer'))
  croixEl.style.cssText = 'cursor:pointer;display:inline-flex;align-items:center;justify-content:center;'
    + 'min-width:44px;min-height:44px;margin:-10px -6px -10px 0;flex:none;font-size:16px'
  croixEl.textContent = '✕'
  bar.appendChild(msgEl)
  bar.appendChild(croixEl)
  document.body.appendChild(bar)

  const fermer = () => { bar.style.display = 'none' }
  const croix = croixEl
  croix.addEventListener('click', fermer)
  croix.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fermer() } })

  let minuteur = null
  window.addEventListener('hs:log', (e) => {
    // Un `hs:log` sans `detail` ne doit pas faire lever l'écouteur : il serait
    // alors mort pour tous les logs suivants.
    const { level, source, message, data } = (e && e.detail) || {}

    // ⚠ LA GARDE DE PRODUCTION, ET ELLE EST LA PREMIÈRE LIGNE. Tout ce qui
    // n'est pas une erreur s'arrête ici : rien n'est écrit dans la barre, donc
    // rien ne peut rester à l'écran par un chemin oublié plus bas.
    if (!estDev() && level !== 'ERROR') return

    // ⚠ ET TOUTES LES ERREURS NE SONT PAS DES PANNES (constat G1 de la revue).
    // `shared/api-client.js` journalise une erreur sur TOUTE réponse non-OK,
    // deux fois par appel échoué — y compris un 401 de session expirée (la page
    // renvoie vers la connexion), un 403 de garde de droits (l'écran dit déjà
    // « vous n'avez pas accès ») et un 404 facultatif. L'hôte lisait donc
    // l'information gérée dans son écran PLUS une barre rouge générique. C'est
    // le défaut nommé le 19 octobre : « l'hôte lisait deux messages pour une
    // panne ».
    if (!estDev() && ATTENDUS.has(Number(data && data.status))) return

    const msg = document.getElementById('hs-debug-msg')
    msg.textContent = ''
    if (estDev()) {
      // ⚠ CONSTRUIT PAR LE DOM, PAS PAR UNE CHAÎNE (constat de SÉCURITÉ de la
      // revue). `source` et `message` viennent d'une réponse serveur — un nom
      // de voyageur, un message du partenaire — et ma première version les
      // interpolait dans `innerHTML`. La branche production était protégée,
      // celle-ci non : mesuré, `<img src=x onerror=…>` s'injectait. Et
      // `localhost` parle à la base de PRODUCTION (shared/config.js), donc
      // c'était une injection dans une session porteuse des identifiants de
      // production.
      const couleurs = { INFO: 'var(--ok, #0F7A4F)', WARN: 'var(--warn, #9A5B00)', ERROR: 'var(--danger, #B42318)' }
      const niveau = document.createElement('span')
      niveau.style.color = couleurs[level] || 'inherit'
      niveau.textContent = `[${level}]`
      msg.appendChild(niveau)
      let detail = ''
      try { detail = data ? ` — ${JSON.stringify(data)}` : '' } catch { detail = ' — (données non sérialisables)' }
      msg.appendChild(document.createTextNode(` ${source} → ${message}${detail}`))
      bar.style.fontFamily = 'monospace'
      bar.style.fontSize = '11px'
    } else {
      // ⚠ UNE PHRASE, jamais la trace : celle-ci est déjà dans la console,
      // posée par `shared/logger.js`.
      msg.textContent = phraseClaire()
    }
    placer(bar)
    bar.style.display = 'flex'

    // ⚠ ELLE S'EFFACE, ET C'EST UN ÉCART ASSUMÉ. Ma première version la
    // laissait jusqu'au clic : mesuré par la revue, elle restait alors pour
    // toute la durée de la page — par-dessus la navigation basse du téléphone.
    // Une barre qui ne part jamais devient un meuble, et c'est exactement la
    // maladie qu'on vient de soigner. Un INFO de développeur part en 5 s, une
    // erreur en 15 — assez pour être lue, pas assez pour s'installer — et la
    // croix reste pour l'écarter tout de suite.
    if (minuteur) { clearTimeout(minuteur); minuteur = null }
    minuteur = setTimeout(fermer, level === 'INFO' ? 5000 : 15000)
  })

  // Capture les erreurs JS globales
  window.addEventListener('error', (e) => {
    logger.error('Global', e.message, { file: e.filename, line: e.lineno })
  })

  // Capture les promesses rejetées
  window.addEventListener('unhandledrejection', (e) => {
    logger.error('Promise', e.reason?.message || String(e.reason))
  })
}

// Exportee pour le test : la regle de placement se verifie sans dependre de la
// capacite de jsdom a analyser `env()`.
export { basDeLaBarre }

export function handleApiError(source, error) {
  const message = error?.message || 'Erreur inconnue'
  logger.error(source, message, error)
  return message
}
