// lib/archivage-conversations.js
//
// LOT 7 DU CHANTIER AVIS — l'archivage des conversations de la messagerie
// (spec docs/specs/spec-evaluation-voyageur.md §9).
//
// UNE fonction pure, qui dit si un fil est archive et pourquoi. Elle n'ecrit
// rien et ne lit rien : api/messages.js lui passe ce qu'il a deja.
//
// Les regles (conversations rattachees a une reservation) :
//   1. EPINGLEE → jamais archivee, quoi qu'il arrive ;
//   2. archivee A LA MAIN → archivee, jusqu'au prochain message ;
//   3. un desarchivage A LA MAIN protege des regles automatiques jusqu'au
//      prochain message ;
//   4. EVALUATION PUBLIEE (evenement `avis.evaluation_publiee` du journal du
//      coeur) → archivee, sauf message posterieur ;
//   5. DEPART PASSE DE 10 JOURS ET AUCUN MESSAGE DEPUIS 10 JOURS → archivee.
//      Tout nouveau message relance le compteur : la date de reference est
//      `max(depart, dernier message)`.
//
// ⚠ L'ARCHIVAGE NE TOUCHE QUE L'AFFICHAGE : agent IA, codes, modeles
// fonctionnent a l'identique sur un fil archive. Rien n'est supprime.
//
// ⚠ PAS DE CRON (spec §9) : l'etat se CALCULE a la lecture, a partir de ce que
// la messagerie lit deja (depart, dernier message) et de ce qu'elle stocke
// (epingle, archivage manuel). Aucun writer de plus dans le chemin d'ingestion
// des messages, qui est le plus sensible du produit.
//
// ⚠ LA MESSAGERIE NE LIT JAMAIS LES TABLES DES AVIS (spec §2 bis) : la
// publication lui arrive par le journal du coeur, `core_events`.

const JOURS_INACTIVITE = 10
const JOUR = 86400000

const instant = (v) => {
  if (!v) return null
  const t = Date.parse(String(v).length === 10 ? String(v) + 'T12:00:00Z' : String(v))
  return Number.isFinite(t) ? t : null
}

/**
 * @param {object} p
 * @param {string|null} p.depart           date de depart (YYYY-MM-DD) ou null
 * @param {string|null} p.dernierMessage   instant du dernier message, ou null
 * @param {boolean}     p.epinglee
 * @param {boolean}     p.archiveeManuellement
 * @param {string|null} p.archiveeLe       instant de l'archivage manuel
 * @param {string|null} p.desarchiveeLe    instant du dernier desarchivage manuel
 * @param {string|null} p.publieeLe        instant de la publication de l'evaluation
 * @param {number}      p.maintenant       ms
 * @returns {{ archivee: boolean, raison: 'manuel'|'evaluation_publiee'|'inactivite'|null }}
 */
function etatArchivage ({
  depart = null, dernierMessage = null, epinglee = false,
  archiveeManuellement = false, archiveeLe = null, desarchiveeLe = null,
  publieeLe = null, maintenant = Date.now(),
} = {}) {
  const non = { archivee: false, raison: null }
  if (epinglee) return non

  const msg = instant(dernierMessage)
  const apres = (t) => msg !== null && t !== null && msg > t   // un message posterieur

  // 2. A la main — jusqu'au prochain message.
  const archLe = instant(archiveeLe)
  if (archiveeManuellement && !(archLe !== null && apres(archLe))) {
    return { archivee: true, raison: 'manuel' }
  }

  // 3. Un desarchivage a la main protege, jusqu'au prochain message.
  const desLe = instant(desarchiveeLe)
  if (desLe !== null && !apres(desLe)) return non

  // 4. Evaluation publiee — sauf message posterieur.
  const pubLe = instant(publieeLe)
  if (pubLe !== null && !apres(pubLe) && pubLe <= maintenant) {
    return { archivee: true, raison: 'evaluation_publiee' }
  }

  // 5. Dix jours apres le depart ET apres le dernier message.
  const dep = instant(depart)
  if (dep === null) return non   // pas de sejour, pas de regle automatique
  const reference = Math.max(dep, msg ?? dep)
  if (maintenant > reference + JOURS_INACTIVITE * JOUR) return { archivee: true, raison: 'inactivite' }
  return non
}

module.exports = { etatArchivage, JOURS_INACTIVITE }
