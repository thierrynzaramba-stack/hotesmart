// lib/guestflow/delais-contrat.js
// LE CONTRAT DES DELAIS GUESTFLOW, EN UN SEUL ENDROIT.
// Chantier « delai de reponse IA ». Spec : docs/specs/spec-delai-reponse-ia.md
//
// ⚠ POURQUOI CE MODULE EXISTE (constat de la revue du 27 octobre 2026). La
// borne etait ECRITE DEUX FOIS : dans le validateur de /api/agent-config, et
// recopiee a la main au point de lecture de lib/cron-shared.js. Le defaut n'est
// pas la duplication, c'est son SENS le jour ou elle derive : si la borne de
// l'endpoint monte (24 h -> 48 h), une valeur ACCEPTEE et stockee par le POST
// devient « hors contrat » a la lecture — `getPropertyMode` retombe sur `mode`
// et imprime une erreur a chaque passe de cron, pour chaque bien concerne.
// Un reglage enregistre cesserait de gouverner sans que rien ne rougisse.
//
// ⚠ AUCUNE DEPENDANCE : ni base, ni reseau. Les deux cotes l'importent, dont un
// endpoint HTTP et un module de cron.

// 24 h. Au-dela, le sejour a souvent commence et un envoi differe n'a plus
// d'objet.
const DELAI_MAX_MIN = 1440

/** Un nombre de minutes conforme au contrat : entier, de 0 a DELAI_MAX_MIN. */
function minutesValides (v) {
  return Number.isInteger(v) && v >= 0 && v <= DELAI_MAX_MIN
}

/**
 * La valeur de `reponse_ia` est-elle dans le contrat ?
 * `null` (validation manuelle) ET un nombre de minutes valide le sont.
 */
function reponseIaValide (v) {
  return v === null || minutesValides(v)
}

/** Un bloc `delais` lu en base a-t-il la FORME d'un objet exploitable ? */
function formeExploitable (d) {
  return !!d && typeof d === 'object' && !Array.isArray(d)
}

module.exports = { DELAI_MAX_MIN, minutesValides, reponseIaValide, formeExploitable }
