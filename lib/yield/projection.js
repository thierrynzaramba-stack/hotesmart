// lib/yield/projection.js — QUELLE NUIT L'ECRAN « PREDICTION DE PRIX » PROJETTE.
// Une projection est la suggestion calculee comme si la nuit etait ouverte :
// le prix auquel elle s'ouvrira, ou celui que YieldFlow proposerait. ECRAN
// SEULEMENT : le pilote (lib/pilote-quotidien.js, lib/nuits-du-moteur.js) ne
// lit jamais cette decision, rien n'est envoye.
//
// ⚠ POURQUOI UNE FONCTION A PART (review du 23 septembre 2026) : la regle vivait
// dans une ligne de l'endpoint, testee par une regex sur le TEXTE — un rouge de
// formatage, pas de comportement. Ici, une table de verite.
//
// ⚠ FONCTION PURE. Ni base, ni horloge.

/**
 * @param {Object} n
 *   - vendue           la nuit est vendue
 *   - delai            jours entre aujourd'hui et la nuit
 *   - ouverte          true | false | null (inconnu)
 *   - horsFenetre      au-dela de la fenetre du pilote
 *   - ouvertureConnue  la capacite est calculable
 *   - aUneLigne        la nuit a une ligne au calendrier
 *   - prixHote         prix pose par l'hote (✎) sur cette nuit, ou null
 */
function estProjection ({ vendue, delai, ouverte, horsFenetre, ouvertureConnue, aUneLigne, prixHote = null }) {
  if (vendue || !(delai >= 0)) return false
  // ⚠ LA NUIT FERMEE AUSSI (demande de Thierry, 23 septembre 2026) : un bien
  // ferme a la vente ne montrait AUCUN prix, impossible de verifier avant
  // d'ouvrir plus large. SAUF si l'hote y a pose son prix (✎) : a la
  // reouverture, c'est SON prix qui sera retenu — la ligne « votre prix »
  // garde son chiffre et son geste de retrait (review).
  if (ouverte === false) return prixHote == null
  return !!(horsFenetre || (ouvertureConnue && !aUneLigne))
}

/**
 * POURQUOI la nuit est projetee — l'ecran dit la bonne condition :
 *   'fenetre'        s'ouvrira seule quand la fenetre l'atteindra
 *   'fermeture'      couverte par une INDISPONIBILITE de l'hote : se leve dans
 *                    la fermeture elle-meme, pas en « rouvrant » la nuit (le
 *                    calendrier refuse de rouvrir une nuit couverte)
 *   'fermee'         fermee a la vente (stop_sell) : l'hote la rouvre au calendrier
 *   'fermee_inconnu' fermee, mais les fermetures de l'hote sont illisibles :
 *                    on ne sait pas laquelle des deux — texte neutre
 *   'non_renseignee' aucune ligne au calendrier
 */
function motifProjection ({ ouverte, horsFenetre, fermeeParLHote, fermeturesLisibles = true }) {
  if (horsFenetre && ouverte !== false) return 'fenetre'
  if (ouverte === false) {
    if (!fermeturesLisibles) return 'fermee_inconnu'
    return fermeeParLHote ? 'fermeture' : 'fermee'
  }
  return 'non_renseignee'
}

module.exports = { estProjection, motifProjection }
