// lib/cleaning/menage-perdants.js — QUI PERD un ménage, et est-il À VENIR ?
// PWA lot 3, étape 4 (spec docs/specs/spec-pwa-lot3-prestataires.md §5, §7.7,
// §7.8 ; KB docs/kb/pwa.md §13). Utilisé par le moteur (annulation,
// lib/cleaning/sync-menages-entite.js) et par les gestes de l'hôte
// (api/menages.js), qui préviennent celles qui perdent un ménage.
//
// ⚠ UN MODULE À PART, SANS DÉPENDANCE : les tests qui remplacent
// `notifier-prestataire` par un double n'emportent pas ces règles avec lui.

// Le jour de calendrier À PARIS d'un instant, en `AAAA-MM-JJ`.
function jourDeParis (instant) {
  return new Date(instant).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' })
}

// Celles qui ont un rôle sur ce ménage : sa porteuse, et celles à qui il est
// proposé (le tour `proposee_a`, et l'ancien champ `offered_to`).
function participants (m) {
  const ids = []
  if (m && m.provider_id) ids.push(String(m.provider_id))
  if (m && Array.isArray(m.proposee_a)) for (const x of m.proposee_a) if (x) ids.push(String(x))
  if (m && m.offered_to) ids.push(String(m.offered_to))
  return [...new Set(ids)]
}

// Qui PERD le ménage entre deux états : les participantes d'avant qui ne le
// sont plus après. Celle qui le reçoit ou le garde n'en fait jamais partie.
// Pour une annulation, `apres` est vide : toutes le perdent.
function perdants (avant, apres) {
  const restent = new Set(participants(apres))
  return participants(avant).filter(id => !restent.has(id))
}

// Un ménage À VENIR : départ aujourd'hui ou plus tard, à Paris. Un ménage passé,
// annulé ou retiré par une correction de l'historique, ne réveille personne.
function aVenir (departureDate, maintenant = Date.now()) {
  const d = String(departureDate || '')
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= jourDeParis(maintenant)
}

module.exports = { jourDeParis, participants, perdants, aVenir }
