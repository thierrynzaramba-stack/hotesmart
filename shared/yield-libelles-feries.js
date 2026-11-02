// shared/yield-libelles-feries.js
// LE NOM COURANT D'UN JOUR FÉRIÉ, POUR L'AFFICHAGE SEULEMENT.
//
// ⚠⚠ RIEN ICI NE TOUCHE AU MOTEUR, ET C'EST TOUT LE POINT. Le nom INTERNE
// d'un férié — « Armistice 1918 », posé par `lib/yield/jours-feries.js` — reste
// la clé du segment et de ses réglages. Un réglage déjà posé continue de
// s'appliquer, et aucune clé ne bouge en base. Cette table ne sert qu'à écrire
// une phrase lisible à l'écran.
//
// ⚠ POURQUOI CETTE TABLE EXISTE. « Week-end du Armistice 1918 » était affiché
// en recette le 1er novembre 2026 : faux en français, et le nom officiel d'un
// férié n'est pas ce qu'un hôte a en tête. Décision de Thierry du 2 novembre
// 2026 : correction à l'AFFICHAGE seulement, une table à un seul endroit.
//
// ⚠ ET LA TABLE PORTE L'ARTICLE, ÉCRIT À LA MAIN (sa décision, et elle est
// juste). Une règle d'élision automatique — « du » sauf devant voyelle — aurait
// rendu « Week-end du Pâques » et « Week-end du Pentecôte », qui sont faux
// autrement. Le français ne se calcule pas : il s'écrit.
//
// ⚠ LES TROIS FÉRIÉS MOBILES PERDENT LEUR « Lundi » : on dit « le week-end de
// Pâques », pas « le week-end du Lundi de Pâques ». Et ils n'ont pas de date
// fixe, donc pas de nom courant au sens où « Armistice 1918 » devient
// « 11 novembre ».

// Clé = le nom interne, tel que `lib/yield/jours-feries.js` le pose.
// Valeur = ce qui suit « Week-end », article compris.
export const LIBELLE_FERIE = {
  // Les huit à date fixe : leur date EST leur nom courant.
  // ⚠ APOSTROPHE DROITE DANS LA CLE, ET CE N'EST PAS UN DETAIL.
  // `lib/yield/jours-feries.js` pose 'Jour de l\'An' avec U+0027. Ecrite en
  // apostrophe typographique (U+2019), la cle ne matchait JAMAIS, et le repli
  // rendait « Week-end — Jour de l'An » sans que rien ne rougisse. Trouve en
  // confrontant la table aux noms du moteur, octet par octet.
  // La valeur AFFICHEE, elle, garde la typographie juste : « de l’Ascension ».
  'Jour de l\'An': 'du 1er janvier',
  'Fête du Travail': 'du 1er mai',
  'Victoire 1945': 'du 8 mai',
  'Fête nationale': 'du 14 juillet',
  'Assomption': 'du 15 août',
  'Toussaint': 'du 1er novembre',
  'Armistice 1918': 'du 11 novembre',
  'Noël': 'du 25 décembre',
  // Les trois mobiles : pas de date, et pas de « Lundi ».
  'Lundi de Pâques': 'de Pâques',
  'Ascension': 'de l’Ascension',
  'Lundi de Pentecôte': 'de la Pentecôte'
}

/**
 * Le titre d'un week-end prolongé, à partir du nom INTERNE du férié voisin.
 *
 * ⚠⚠ LE NOM PEUT EN JOINDRE PLUSIEURS, ET C'EST LE CAS AUJOURD'HUI.
 * `lib/yield/reference.js` joint par « et » tous les fériés d'une même chaîne :
 * `suite.filter(ferie).map(j => feries.get(j)).join(' et ')`. Cette clé
 * composée n'a par construction aucune entrée dans la table.
 *
 * Relevé en review le 2 novembre 2026, et MESURÉ sur la fenêtre servie ce
 * jour-là (2026-11-02 → 2027-11-02) : « Ascension et Victoire 1945 » y est,
 * pour le week-end du 9 mai 2027. J'avais décrit le repli comme une « sortie
 * de secours pour un férié inconnu » — il était emprunté DÈS MAINTENANT, et il
 * rendait « Week-end — Ascension et Victoire 1945 », c'est-à-dire exactement
 * les noms internes que ce lot existe pour écarter. Récurrence mesurée
 * 2026-2045 : 2027, 2029, 2030, 2032, 2035 (trois fériés), 2040, 2041, 2043.
 *
 * On découpe donc sur « et » et on compose chaque part : « de l’Ascension et
 * du 8 mai ». ⚠ ET SI UNE SEULE PART EST INCONNUE, TOUT RETOMBE SUR LE REPLI :
 * une phrase à moitié traduite — « de l’Ascension et Machin 1999 » — serait
 * pire qu'une phrase honnêtement non traduite, parce qu'elle aurait l'air juste.
 *
 * ⚠ LE REPLI RESTE, et il garde son rôle : un férié ajouté un jour, ou une
 * forme de jointure qui changerait. On rend le nom tel quel, précédé d'un tiret
 * cadratin : moins joli, mais ça ne ment pas et ça se voit.
 */
export function titreWeekEnd (nomInterne) {
  if (!nomInterne) return null
  const parts = String(nomInterne).split(' et ')
  const suites = parts.map((p) => LIBELLE_FERIE[p])
  if (suites.some((x) => !x)) return `Week-end — ${nomInterne}`
  return `Week-end ${suites.join(' et ')}`
}
