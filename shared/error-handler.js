import { logger } from '/shared/logger.js'

const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'

// ⚠ CAPTURER N'EST PAS AFFICHER. Les erreurs se capturent PARTOUT — elles
// alimentent `logger.getLogs()`, donc le diagnostic ; c'est la BANDE qui est
// réservée au développement.
//
// Vécu (17 octobre 2026, relevé des bugs de l'UI V5) : en production, la
// moindre erreur — un `/api` qui rend 404, une lecture refusée par la RLS, une
// erreur JS — peignait une bande noire à texte technique anglais en bas de
// l'écran (« [ERROR] Aujourdhui → yield jour »), qui restait jusqu'au clic sur
// la croix. Au téléphone elle passe PAR-DESSUS la barre de navigation
// (z-index 9999 contre 10 de `.bottombar`) : l'hôte perd ses cinq onglets
// jusqu'à ce qu'il pense à fermer un bandeau qu'il ne comprend pas. Seul le
// DÉTAIL JSON était conditionné par `isDev` ; l'affichage, lui, ne l'était pas.
export function initErrorHandler() {
  // Les deux captures d'abord : elles valent en production comme en local.
  window.addEventListener('error', (e) => {
    logger.error('Global', e.message, { file: e.filename, line: e.lineno })
  })
  window.addEventListener('unhandledrejection', (e) => {
    logger.error('Promise', e.reason?.message || String(e.reason))
  })

  // ⚠ LA SEULE PORTE DE LA BANDE, et elle est AVANT sa construction : en
  // production, aucun élément n'est créé, aucun écouteur `hs:log` n'est posé.
  if (!isDev) return

  // Barre de debug en bas de l'écran
  const bar = document.createElement('div')
  bar.id = 'hs-debug-bar'
  bar.style.cssText = `
    position: fixed; bottom: 0; left: 0; right: 0;
    background: #1a1a1a; color: #fff;
    font-family: monospace; font-size: 11px;
    padding: 6px 12px; z-index: 9999;
    display: none; align-items: center;
    justify-content: space-between; gap: 12px;
  `
  bar.innerHTML = `
    <span id="hs-debug-msg">—</span>
    <span id="hs-debug-close" style="cursor:pointer;opacity:0.6">✕</span>
  `
  document.body.appendChild(bar)

  document.getElementById('hs-debug-close').addEventListener('click', () => {
    bar.style.display = 'none'
  })

  // Écoute tous les logs
  window.addEventListener('hs:log', (e) => {
    const { level, source, message, data } = e.detail
    const colors = { INFO: '#1D9E75', WARN: '#BA7517', ERROR: '#E24B4A' }
    const msg = document.getElementById('hs-debug-msg')
    // `isDev` est déjà acquis ici : la bande n'existe pas ailleurs.
    const detail = data ? ` — ${JSON.stringify(data)}` : ''
    msg.innerHTML = `<span style="color:${colors[level]}">[${level}]</span> ${source} → ${message}${detail}`
    bar.style.display = 'flex'

    // Auto-masque après 5s pour INFO, reste visible pour ERROR
    if (level === 'INFO') {
      setTimeout(() => { bar.style.display = 'none' }, 5000)
    }
  })
}

export function handleApiError(source, error) {
  const message = error?.message || 'Erreur inconnue'
  logger.error(source, message, error)
  return message
}