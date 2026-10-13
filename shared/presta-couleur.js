// shared/presta-couleur.js — LA couleur d'une prestataire, une fois pour toutes.
//
// Règle affichée par les écrans : « une couleur STABLE par personne ». Elle ne
// tient que si le hash vit à UN endroit (CLAUDE.md : une règle partagée vit
// dans un module commun, jamais recopiée). Les pastels eux-mêmes sont des
// jetons de theme.css (--presta-1 … --presta-8) : ce module ne connaît que
// leur NOMBRE et leur nom, jamais un hexa.
//
// L'ancien garde.html porte encore sa propre copie (6 hexas locaux) : il
// disparaît à l'étape 4 du lot Ménages V5 avec sa page — on ne le convertit
// pas pour trois semaines de vie.

export const NB_PASTELS = 8

export function indexCouleur (id, n = NB_PASTELS) {
  let h = 0
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return (h % n) + 1
}

export function couleurDe (id) {
  return `var(--presta-${indexCouleur(id)})`
}
