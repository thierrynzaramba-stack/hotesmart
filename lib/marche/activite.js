// lib/marche/activite.js — UN BIEN DU MARCHE EST-IL REELLEMENT ACTIF ? (spec
// §22.10 de docs/kb/chantier-nouveau-bien.md, decision de Thierry du 5 octobre
// 2026). Aucun bien inactif n'est PROPOSE comme comparable.
//
// ⚠ FONCTION PURE : ni base, ni reseau, ni horloge. Elle lit les indicateurs
// que porte deja chaque fiche AirROI (`performance_metrics`), sans cout.
//
// Actif =
//   - logement entier ;
//   - au moins 30 nuits vendues sur 12 mois, OU au moins 10 sur 90 jours (une
//     annonce recente n'a pas encore 12 mois d'historique) ;
//   - au moins 1 nuit ouverte a la vente sur 90 jours (calendrier vivant).
// Un indicateur absent ou illisible = NON actif : l'absence de preuve
// d'activite n'est pas une activite.
//
// AirROI n'a pas de « OU » entre deux filtres : la requete demande
// `ttm_days_booked >= 10` (qui englobe les deux cas) et cette regle tranche.

const NUITS_12_MOIS = 30
const NUITS_90_JOURS = 10
const OUVERTES_90_JOURS = 1

const entier = v => (Number.isInteger(v) && v >= 0 ? v : null)

function estActive (fiche) {
  if (!fiche || typeof fiche !== 'object') return false
  if (!fiche.listing_info || fiche.listing_info.room_type !== 'entire_home') return false
  const p = fiche.performance_metrics
  if (!p || typeof p !== 'object') return false
  const n12 = entier(p.ttm_days_reserved)
  const n90 = entier(p.l90d_days_reserved)
  const ouvertes = entier(p.l90d_available_days)
  if (ouvertes === null || ouvertes < OUVERTES_90_JOURS) return false
  return (n12 !== null && n12 >= NUITS_12_MOIS) || (n90 !== null && n90 >= NUITS_90_JOURS)
}

const seulementActives = fiches => (Array.isArray(fiches) ? fiches.filter(estActive) : fiches)

module.exports = { estActive, seulementActives, NUITS_12_MOIS, NUITS_90_JOURS, OUVERTES_90_JOURS }
