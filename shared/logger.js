// ⚠ LA REGLE DU MODE DIAGNOSTIC NE VIT PAS ICI : elle est dans
// `shared/config.js`, avec la resolution d'environnement, et la bande de debug
// de `shared/error-handler.js` lit la MEME. Les deux s'allument ensemble.
import { MODE_DIAGNOSTIC } from '/shared/config.js'

const LEVELS = { INFO: 'INFO', WARN: 'WARN', ERROR: 'ERROR' }

// ⚠ LE JOURNAL EST BORNE. Il vit en memoire pour toute la duree de l'onglet et
// personne ne le vide : une erreur qui se repete — un rechargement en echec,
// une boucle de relance — le faisait croitre sans fin (constat 3 de la revue
// de f997bf5). On garde les DERNIERES lignes, ce sont elles qui expliquent.
const MAX_LIGNES = 200
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
  if (logs.length > MAX_LIGNES) logs.splice(0, logs.length - MAX_LIGNES)

  if (MODE_DIAGNOSTIC) {
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
  // Une COPIE : le journal ne se modifie pas depuis l'exterieur.
  getLogs: () => logs.slice()
}

// ⚠ UN JOURNAL QUE PERSONNE NE PEUT LIRE NE SERT A RIEN (constat 3 de la revue
// de f997bf5 : `getLogs` n'avait aucun appelant). En mode diagnostic SEULEMENT,
// il s'ouvre depuis la console du navigateur — `__hsLogs()`. En production,
// rien n'est pose sur `window` : les lignes continuent d'etre capturees, pour
// la remontee que ce depot n'a pas encore.
if (MODE_DIAGNOSTIC) window.__hsLogs = () => logs.slice()