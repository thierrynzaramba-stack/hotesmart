import { logger } from '/shared/logger.js'

const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'

export function initErrorHandler() {
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
    const detail = isDev && data ? ` — ${JSON.stringify(data)}` : ''
    msg.innerHTML = `<span style="color:${colors[level]}">[${level}]</span> ${source} → ${message}${detail}`
    bar.style.display = 'flex'

    // Auto-masque après 5s pour INFO, reste visible pour ERROR
    if (level === 'INFO') {
      setTimeout(() => { bar.style.display = 'none' }, 5000)
    }
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