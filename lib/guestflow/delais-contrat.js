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

/**
 * Le delai de reponse IA d'un bien, lu depuis `lireReglagesDuBien`.
 *
 * Rend un objet qui DIT ce qu'il faut faire, parce que les trois cas se
 * confondent facilement et que deux d'entre eux valent `0` ou `null` :
 *   { differe: false, manuel: true  }  -> validation manuelle (ancien Mode Test)
 *   { differe: false, manuel: false }  -> immediat (ancien Mode Auto)
 *   { differe: true,  minutes: N    }  -> le brouillon attend N minutes
 *
 * ⚠ TOUT CE QUI SORT DU CONTRAT RETOMBE SUR `mode`, comme au point de lecture
 * de `getPropertyMode` — et pour la meme raison : le blob est un JSONB qu'aucune
 * contrainte de base ne borne.
 */
function delaiDeReponse (reglages) {
  const d = reglages && formeExploitable(reglages.delais) ? reglages.delais : null
  const v = d && 'reponse_ia' in d ? d.reponse_ia : undefined

  if (v === undefined || !reponseIaValide(v)) {
    // Repli sur le binaire historique.
    const manuel = !reglages || reglages.mode !== 'auto'
    return { differe: false, manuel, minutes: 0, motif: v === undefined ? 'sans_delai' : 'hors_contrat' }
  }
  if (v === null) return { differe: false, manuel: true, minutes: 0, motif: 'validation_manuelle' }
  if (v === 0) return { differe: false, manuel: false, minutes: 0, motif: 'immediat' }
  return { differe: true, manuel: false, minutes: v, motif: 'differe' }
}

/** L'echeance d'un brouillon, en ISO. `maintenant` est TOUJOURS injecte. */
function echeanceDeReponse (minutes, maintenant) {
  return new Date(maintenant + minutes * 60 * 1000).toISOString()
}

module.exports = {
  DELAI_MAX_MIN, minutesValides, reponseIaValide, formeExploitable,
  delaiDeReponse, echeanceDeReponse
}
