// lib/marche/critere.js — LE VERROU DE LA REGLE 19.
// Cadrage : docs/kb/chantier-nouveau-bien.md §5 regle 19.
//
// ⚠ LE CRITERE QUI AUTORISERA UN JOUR L'INTERRUPTEUR (V2.6) S'ECRIT ET SE DATE
// AVANT QU'ON LISE LE PREMIER RELEVE. Tant qu'il vaut `null`, aucun ecart —
// ni meme aucun niveau de la grille marche, qui le donnerait par soustraction
// — ne sort de l'API ni ne s'affiche. La table `grille_controle` se remplit ;
// personne ne la lit.
//
// Le jour ou Thierry fixe le critere : il se grave ICI (texte + date) ET dans
// le KB (regle 19), dans le meme commit, AVANT tout affichage.
const CRITERE_INTERRUPTEUR = null
// Exemple de forme, NON RETENU : { fixe_le: '2026-10-01', texte: 'trois mois
// de suite avec un ecart <= 5 € sur Moyen et Haut' }

function relevesLisibles () {
  return !!(CRITERE_INTERRUPTEUR && CRITERE_INTERRUPTEUR.fixe_le && CRITERE_INTERRUPTEUR.texte)
}

module.exports = { CRITERE_INTERRUPTEUR, relevesLisibles }
