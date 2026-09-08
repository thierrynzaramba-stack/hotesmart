// lib/incident-facturation.js
// UNE PANNE DE FACTURATION N'EST PLUS SILENCIEUSE.
//
// Vecu du 8 septembre 2026 : le credit Anthropic s'est epuise. Toute l'IA du
// produit s'est arretee — classification des messages entrants, reponses
// suggerees, agent, extraction de base de connaissance — et RIEN ne le disait.
// L'erreur ne vivait que dans `cron_logs.errors`, un champ que personne ne
// regarde. Il a fallu qu'on tombe dessus en verifiant autre chose.
//
// Une panne de facturation n'est pas une erreur technique : c'est un service
// COUPE, qui le restera jusqu'a une action humaine. Elle doit reveiller.
//
// ⚠ ANTI-SPAM 1 PAR JOUR. Un credit epuise est le meme fait toute la journee :
// une alerte horaire ferait du bruit la ou une seule suffit, et le bruit finit
// par se faire ignorer — exactement ce qu'on veut eviter ici.

const UN_JOUR_MS = 24 * 3600 * 1000

// Les formulations que rendent les trois services quand le compte, et non la
// requete, est en cause. Volontairement LARGES : rater une panne coute plus
// cher qu'une alerte de trop, et l'anti-spam borne le cout de l'exces.
const MOTIFS = [
  /credit balance is too low/i,
  /insufficient (credit|funds|balance|quota)/i,
  /quota (exceeded|exhausted|depasse)/i,
  /billing (issue|problem|required)/i,
  /payment (required|failed)/i,
  /account (suspended|deactivated|blocked|disabled)/i,
  /compte (suspendu|desactive|bloque)/i,
  /plan (limit|expired)/i,
  /out of credits?/i,
  /subscription (expired|inactive)/i
]

// Codes HTTP qui signalent une cause de FACTURATION quand le corps le confirme.
// 402 est explicite. 401/403/429 sont ambigus (cle revoquee, droit manquant,
// simple debit) : ils ne comptent que si le texte le dit.
const CODES_EXPLICITES = new Set([402])

function texteDe (erreur) {
  if (!erreur) return ''
  if (typeof erreur === 'string') return erreur
  const bouts = [erreur.message, erreur.error?.message, erreur.body, erreur.detail]
  if (erreur.response && typeof erreur.response === 'object') bouts.push(erreur.response.message)
  try { bouts.push(JSON.stringify(erreur).slice(0, 2000)) } catch { /* circulaire */ }
  return bouts.filter(Boolean).join(' | ')
}

function statutDe (erreur) {
  if (!erreur || typeof erreur !== 'object') return null
  const n = Number(erreur.status ?? erreur.statusCode ?? erreur.response?.status)
  return Number.isFinite(n) ? n : null
}

// Cette erreur est-elle une panne de FACTURATION ? Rend `null` sinon.
function panneDeFacturation (erreur) {
  const texte = texteDe(erreur)
  const statut = statutDe(erreur)

  if (CODES_EXPLICITES.has(statut)) return { statut, extrait: extrait(texte) }
  // Hors 402, il faut que le texte le dise : un 401 peut n'etre qu'une cle
  // revoquee, et alerter « credit epuise » enverrait chercher au mauvais endroit.
  if (MOTIFS.some(m => m.test(texte))) return { statut, extrait: extrait(texte) }
  return null
}

// ⚠ N'EXPOSE JAMAIS DE SECRET. Les messages d'erreur des SDK recopient volontiers
// la cle fautive ; on ne garde qu'un extrait, nettoye.
function extrait (texte) {
  return String(texte)
    .replace(/\b(sk|rk|pk|whsec|xkeysib)[-_][A-Za-z0-9_\-]{6,}/g, '<masque>')
    .replace(/\s+/g, ' ')
    .slice(0, 300)
}

// Signale la panne si c'en est une. Rend `true` si un incident a ete ouvert.
// Fail-safe : ne throw JAMAIS — une alerte qui casse l'appelant serait pire que
// pas d'alerte du tout.
async function signalerSiPanneFacturation (service, erreur, contexte = {}) {
  try {
    const panne = panneDeFacturation(erreur)
    if (!panne) return false

    const { reportIncident } = require('./founder-notify')
    await reportIncident('api_credit', {
      userId: contexte.userId || null,
      propertyId: contexte.propertyId || null,
      propertyName: contexte.propertyName || null,
      threshold: 1,
      fenetreMs: UN_JOUR_MS,
      detail: `${service} est COUPE : ${panne.extrait || 'credit ou quota epuise'}`
        + (panne.statut ? ` (HTTP ${panne.statut})` : '')
        + `. Tant que ce n'est pas regle, les fonctions qui en dependent ne marchent plus.`
    })
    console.error(`[facturation] ${service} coupe — incident api_credit ouvert`)
    return true
  } catch (e) {
    console.error('[facturation] signalement impossible :', e.message)
    return false
  }
}

module.exports = { panneDeFacturation, signalerSiPanneFacturation, UN_JOUR_MS }
