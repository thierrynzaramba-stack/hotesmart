const isDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'

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

  if (isDev) {
    const style = {
      INFO:  'color: #1D9E75; font-weight: 500',
      WARN:  'color: #BA7517; font-weight: 500',
      ERROR: 'color: #E24B4A; font-weight: 500'
    }
    console.log(`%c[${level}] ${source} → ${message}`, style[level], data || '')
  }

  window.dispatchEvent(new CustomEvent('hs:log', { detail: entry }))
}

export const logger = {
  info:  (source, message, data) => log(LEVELS.INFO,  source, message, data),
  warn:  (source, message, data) => log(LEVELS.WARN,  source, message, data),
  error: (source, message, data) => log(LEVELS.ERROR, source, message, data),
  getLogs: () => logs
}