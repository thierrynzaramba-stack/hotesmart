// lib/marche/critere.js — LE VERROU DE LA REGLE 19.
// Cadrage : docs/kb/chantier-nouveau-bien.md §5 regle 19.
//
// ⚠ LE CRITERE QUI AUTORISERA UN JOUR L'INTERRUPTEUR (V2.6) S'ECRIT ET SE DATE
// AVANT QU'ON LISE LE PREMIER RELEVE. Il est grave ici (texte + date) ET dans
// le KB (regle 19), dans le meme commit, tel que Thierry l'a fixe — sans
// commentaire.
const CRITERE_INTERRUPTEUR = {
  fixe_le: '2026-09-24',
  texte: `CRITÈRE DE L'INTERRUPTEUR V2.6 — fixé et daté le 24 septembre 2026, avant toute lecture d'un relevé (règle 19).
La grille marché ne peut piloter les prix d'un logement sans historique que si les quatre conditions suivantes sont réunies, lues sur grille_controle en comparant la grille marché à la grille mesurée 12 mois.
1. Accord sur les niveaux qui portent le plus de nuits : Base et Moyen, écart ≤ 1 pas d'arrondi (5 €) ; Haut, ≤ 2 pas (10 €). Très haut et Exceptionnel non contraignants — ils reposent par nature sur peu de ventes, et le plancher N-1 les corrige nuit par nuit.
2. Durée : quatre relevés mensuels consécutifs, tous conformes. Un seul relevé hors critère remet le compteur à zéro.
3. Couverture : au moins deux logements conformes, et pas deux du même type. La bulle est une niche jacuzzi, Cœur de vie 23 un T2 ordinaire : ces deux-là suffisent. Deux niches ne suffiraient pas.
4. Aucun relevé de la fenêtre marqué référence amincie ou mesure insuffisante.
Ce que ce critère ne prouve pas : il mesure la capacité de la méthode à retrouver une réponse connue, sur deux logements d'un seul marché, Bagnères. Il ne dit rien de Toulouse ni d'ailleurs.
Clause qui lui donne son sens : s'il n'est pas atteint, on ne le déplace pas. On dit pourquoi, on corrige la méthode, ou on accepte que la V2.6 n'ait pas lieu sur ce marché. Un critère assoupli après avoir vu les chiffres ne vaut rien.`
}

// ⚠ LE SECOND VERROU : L'ETAPE 3 A SA PLACE. Le critere est fixe, mais
// Thierry a demande (24 septembre 2026) qu'aucun ecart de `grille_controle` ne
// soit lu tant que l'etape 3 (la reunification) n'est pas en place — la
// grille marche deja codee a ete remise a son rang, apres le marche (V2.3) et
// l'ecran des comparables (V2.4). Graver le critere ne doit pas ouvrir
// l'affichage par accident : ce drapeau s'ouvre au lot de l'etape 3, sur
// decision de Thierry, et nulle part ailleurs.
const ETAPE_3_EN_PLACE = false

// Aucun ecart — ni aucun niveau de la grille marche, qui le donnerait par
// soustraction — ne sort de l'API tant que les DEUX verrous ne sont pas levés.
function relevesLisibles () {
  return !!(ETAPE_3_EN_PLACE && CRITERE_INTERRUPTEUR && CRITERE_INTERRUPTEUR.fixe_le && CRITERE_INTERRUPTEUR.texte)
}

module.exports = { CRITERE_INTERRUPTEUR, ETAPE_3_EN_PLACE, relevesLisibles }
