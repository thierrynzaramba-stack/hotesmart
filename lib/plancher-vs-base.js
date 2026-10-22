// lib/plancher-vs-base.js
// UNE SEULE RÈGLE : un prix plancher ne peut pas dépasser le prix de base.
//
// ⚠ EXTRAITE DE `api/channel-property.js` LE 22 OCTOBRE 2026, à la revue de
// l'étape 3 du lot Logements. Elle y vivait À L'INTÉRIEUR du `if (prix_minimum
// !== undefined)` : elle ne tournait donc que si le plancher était dans le
// corps de la requête.
//
// L'ancien écran envoyait les deux champs ENSEMBLE, d'une seule fenêtre, et la
// garde voyait toujours les deux. La fiche V5 les a séparés — le plancher
// s'enregistre seul à la sortie de case, le prix de base part par le bouton du
// bloc. BAISSER LE PRIX DE BASE SOUS UN PLANCHER EXISTANT passait donc : 200,
// grille reconstruite chez les plateformes, et 500 nuits fermées au full sync
// suivant. C'est l'incident que le commentaire d'origine raconte, atteint par
// l'autre bout.
//
// ⚠ LES DEUX VALEURS SONT EFFECTIVES, pas celles du corps : « ce que le bien
// vaudra après cette écriture », en prenant la valeur envoyée si elle l'est, et
// celle de la base sinon. C'est la seule façon de juger d'une écriture qui ne
// porte qu'un des deux champs.
//
// ⚠ ET LES UNITÉS NE SE MÉLANGENT PAS : le plancher est en CENTIMES (colonne
// `properties.prix_minimum`), le prix de base en EUROS. On compare en centimes.

const PLAFOND_CENTIMES = 10000000

function valeurEffective (envoye, enBase) {
  return envoye !== undefined ? envoye : enBase
}

// Rend `null` si la combinaison est acceptable, sinon le refus à servir tel
// quel. Un plancher absent, nul ou négatif ne déclenche rien : « pas de
// plancher propre » est une valeur légitime, et le code retombe sur le plancher
// global.
function refusPlancher ({ plancherCents, basePriceEuros }) {
  const plancher = Number(plancherCents)
  const base = Number(basePriceEuros)
  if (plancherCents == null || !Number.isFinite(plancher) || plancher <= 0) return null
  if (!Number.isFinite(base) || base <= 0) return null
  if (plancher <= Math.round(base * 100)) return null
  return {
    error: 'plancher_au_dessus_du_prix_de_base',
    message: `Le prix plancher (${(plancher / 100).toFixed(2)} €) depasse le prix de base `
      + `(${base.toFixed(2)} €) : toutes les nuits seraient fermees. `
      + `Baissez le plancher, ou montez le prix de base.`
  }
}

module.exports = { refusPlancher, valeurEffective, PLAFOND_CENTIMES }
