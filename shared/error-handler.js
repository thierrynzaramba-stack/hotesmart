import { logger } from '/shared/logger.js'

// ═══════════════════════════════════════════════════════════════════════════
// LA BARRE D'ERREUR — ce que l'hôte voit quand quelque chose casse
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠ CE FICHIER A AFFICHÉ DES TRACES DE DÉVELOPPEUR EN PRODUCTION, sur les
// 23 pages qui l'appellent, et pendant des mois. `isDev` ne conditionnait que
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

const HOTES_DEV = ['localhost', '127.0.0.1']

// ⚠ ÉVALUÉE À L'APPEL, PAS AU CHARGEMENT. En constante de module, elle fige la
// décision avant que le test ait pu poser son URL — et surtout, elle rend la
// règle intestable autrement qu'en rechargeant le module.
const estDev = () => HOTES_DEV.includes(window.location.hostname)

// La phrase que l'hôte lit. Traduite si le moteur est là ; sinon le français,
// parce qu'une barre d'erreur ne doit pas dépendre d'un dictionnaire chargé.
const PHRASE_PAR_DEFAUT = 'Une erreur est survenue. Réessayez dans un instant.'
function phraseClaire () {
  try {
    const t = window.I18n && window.I18n.t && window.I18n.t('erreur.bandeau')
    // Le moteur rend la CLÉ quand elle manque : on ne l'affiche pas à l'écran.
    return t && t !== 'erreur.bandeau' ? t : PHRASE_PAR_DEFAUT
  } catch { return PHRASE_PAR_DEFAUT }
}

export function initErrorHandler() {
  // ⚠ LES JETONS DU THÈME, AVEC UN REPLI. Quatorze pages ne chargent aucune
  // feuille (marque blanche, app prestataire hors ligne) : un `var()` sans
  // repli y rendrait la barre invisible ou illisible.
  const bar = document.createElement('div')
  bar.id = 'hs-debug-bar'
  bar.setAttribute('role', 'status')
  bar.setAttribute('aria-live', 'polite')
  bar.style.cssText = `
    position: fixed; bottom: 0; left: 0; right: 0;
    background: var(--danger-soft, #FEF0EE); color: var(--danger, #B42318);
    border-top: 1px solid var(--danger, #B42318);
    font-family: inherit; font-size: 14px; line-height: 1.4;
    padding: 10px 16px; z-index: 9999;
    display: none; align-items: center;
    justify-content: space-between; gap: 12px;
  `
  bar.innerHTML = `
    <span id="hs-debug-msg"></span>
    <span id="hs-debug-close" role="button" tabindex="0" aria-label="Fermer" style="cursor:pointer;opacity:0.7;padding:0 4px">✕</span>
  `
  document.body.appendChild(bar)

  const fermer = () => { bar.style.display = 'none' }
  const croix = document.getElementById('hs-debug-close')
  croix.addEventListener('click', fermer)
  croix.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fermer() } })

  let minuteur = null
  window.addEventListener('hs:log', (e) => {
    const { level, source, message, data } = e.detail

    // ⚠ LA GARDE DE PRODUCTION, ET ELLE EST LA PREMIÈRE LIGNE. Tout ce qui
    // n'est pas une erreur s'arrête ici : rien n'est écrit dans la barre, donc
    // rien ne peut rester à l'écran par un chemin oublié plus bas.
    if (!estDev() && level !== 'ERROR') return

    const msg = document.getElementById('hs-debug-msg')
    if (estDev()) {
      const couleurs = { INFO: 'var(--ok, #0F7A4F)', WARN: 'var(--warn, #9A5B00)', ERROR: 'var(--danger, #B42318)' }
      const detail = data ? ` — ${JSON.stringify(data)}` : ''
      msg.innerHTML = `<span style="color:${couleurs[level] || 'inherit'}">[${level}]</span> ${source} → ${message}${detail}`
      bar.style.fontFamily = 'monospace'
      bar.style.fontSize = '11px'
    } else {
      // ⚠ `textContent`, PAS `innerHTML` : le message d'une erreur peut venir
      // d'une réponse serveur, et la barre n'est pas un endroit où exécuter ce
      // qu'elle contient. Et c'est une PHRASE, jamais la trace : celle-ci est
      // déjà dans la console, posée par `shared/logger.js`.
      msg.textContent = phraseClaire()
    }
    bar.style.display = 'flex'

    // En développement seulement : un INFO s'efface tout seul. En production,
    // on n'arrive ici que pour une ERREUR, et une erreur ne s'efface pas sans
    // que l'hôte l'ait lue — il a la croix.
    if (minuteur) { clearTimeout(minuteur); minuteur = null }
    if (level === 'INFO') minuteur = setTimeout(fermer, 5000)
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

export function handleApiError(source, error) {
  const message = error?.message || 'Erreur inconnue'
  logger.error(source, message, error)
  return message
}
