// ═══════════════════════════════════════════════════════════════════════════
// HôteSmart — Message builder partagé
// Remplace les placeholders d'un template par les valeurs reelles issues
// du booking, du code Seam genere et de la base de connaissance knowledge.
// Utilise par api/menages-public.js ET lib/cron-arrival-code.js pour
// garantir un format identique de message quelle que soit la source.
// ═══════════════════════════════════════════════════════════════════════════

function formatDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (isNaN(d)) return dateStr
  const jours = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']
  const mois  = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre']
  return `${jours[d.getDay()]} ${d.getDate()} ${mois[d.getMonth()]}`
}

function buildMessage(template, booking, guestName, seamCode, knowledge = {}) {
  let text = template.template_text || ''
  if (!text.trim()) return null

  // knowledge contient les valeurs fixed depuis la table knowledge.
  // Si une cle est absente/vide, on laisse le placeholder pour que l'hote
  // voie qu'il manque une info dans sa base de connaissance.
  const k = knowledge || {}
  const val = (key, fallback) => (k[key] && String(k[key]).trim()) ? k[key] : fallback

  return text
    .replace(/{prenom}/g,         booking.firstName || guestName)
    .replace(/{nom}/g,            booking.lastName  || '')
    .replace(/{arrivee}/g,        formatDate(booking.arrival))
    .replace(/{depart}/g,         formatDate(booking.departure))
    .replace(/{logement}/g,       booking.propName  || '')
    .replace(/{adresse}/g,        val('adresse', '[ADRESSE]'))
    .replace(/{checkin}/g,        val('checkin', booking.checkInStart || '18:00'))
    .replace(/{checkout}/g,       val('checkout', booking.checkOutEnd || '10:00'))
    .replace(/{code_acces}/g,     seamCode || '[CODE À INSÉRER]')
    .replace(/{wifi_nom}/g,       val('wifi_nom', '[WIFI NOM]'))
    .replace(/{wifi_mdp}/g,       val('wifi_mdp', '[WIFI MOT DE PASSE]'))
    .replace(/{telephone_hote}/g, val('telephone_hote', '[TÉLÉPHONE HÔTE]'))
}

module.exports = { buildMessage, formatDate }
