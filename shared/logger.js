// ⚠ ÉVALUÉE À L'APPEL, comme dans `shared/error-handler.js` : en constante de
// module, elle fige la décision avant qu'un test ait pu poser son URL.
// ⚠ UNE SEULE DEFINITION, exportee. Elle etait recopiee dans
// `shared/error-handler.js` : deux copies divergent, et celle-ci decide si une
// trace part en console pendant que l'autre decide si elle s'affiche.
const HOTES_DEV = ['localhost', '127.0.0.1', '[::1]', '0.0.0.0']
export const estDev = () => HOTES_DEV.includes(window.location.hostname)

const LEVELS = { INFO: 'INFO', WARN: 'WARN', ERROR: 'ERROR' }

const logs = []

function log(level, source, message, data = null) {
  const entry = {
    level,
    source,
    message,
    data,
    timestamp: new Date().toISOString()
  }

  logs.push(entry)

  // ⚠ LA TRACE EXISTE AUSSI EN PRODUCTION, ET C'EST NEUF (décision de Thierry,
  // 20 octobre 2026 : « les traces restent dans la console et le serveur »).
  // Avant, `if (isDev)` faisait qu'en production RIEN n'était écrit en console :
  // la seule trace visible était la barre noire à l'écran de l'hôte — celle
  // qu'on vient de lui retirer. On aurait donc supprimé le symptôme ET la
  // capacité de diagnostiquer.
  //
  // ⚠ ET `console.debug` POUR LES INFO : les DevTools le classent en
  // « Verbose », masqué par défaut. La console reste lisible, et l'information
  // reste là pour qui la cherche. WARN et ERROR passent par leurs canaux, qui
  // portent la pile d'appel.
  if (estDev()) {
    const style = {
      INFO:  'color: #1D9E75; font-weight: 500',
      WARN:  'color: #BA7517; font-weight: 500',
      ERROR: 'color: #E24B4A; font-weight: 500'
    }
    console.log(`%c[${level}] ${source} → ${message}`, style[level], data || '')
  } else {
    const canal = { INFO: 'debug', WARN: 'warn', ERROR: 'error' }[level] || 'debug'
    console[canal](`[${level}] ${source} → ${message}`, data || '')
  }

  window.dispatchEvent(new CustomEvent('hs:log', { detail: entry }))
}

export const logger = {
  info:  (source, message, data) => log(LEVELS.INFO,  source, message, data),
  warn:  (source, message, data) => log(LEVELS.WARN,  source, message, data),
  error: (source, message, data) => log(LEVELS.ERROR, source, message, data),
  getLogs: () => logs
}