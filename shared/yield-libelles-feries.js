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
// Deux formes par férié, écrites à la main toutes les deux :
//   `nom`     — le nom courant SANS article, pour la ligne du férié ;
//   `article` — ce qui suit « Week-end » ou « Pont ».
//
// ⚠ ET LES DEUX DIFFÈRENT POUR LES TROIS MOBILES, par décision de Thierry du
// 2 novembre 2026 : la ligne du férié garde « Lundi de Pâques » (c'est son nom
// courant), tandis que le week-end dit « de Pâques » — on ne dit pas « le
// week-end du Lundi de Pâques ». L'un ne se dérive donc pas de l'autre, et
// c'est pourquoi les deux sont écrits.
export const LIBELLE_FERIE = {
  // Les huit à date fixe : leur date EST leur nom courant.
  // ⚠ APOSTROPHE DROITE DANS LA CLÉ, ET CE N'EST PAS UN DÉTAIL.
  // `lib/yield/jours-feries.js` pose 'Jour de l\'An' avec U+0027. Écrite en
  // apostrophe typographique (U+2019), la clé ne matchait JAMAIS, et le repli
  // rendait « Week-end — Jour de l'An » sans que rien ne rougisse. Trouvé en
  // confrontant la table aux noms du moteur, octet par octet.
  // La valeur AFFICHÉE, elle, garde la typographie juste : « de l’Ascension ».
  'Jour de l\'An': { nom: '1er janvier', article: 'du 1er janvier' },
  'Fête du Travail': { nom: '1er mai', article: 'du 1er mai' },
  'Victoire 1945': { nom: '8 mai', article: 'du 8 mai' },
  'Fête nationale': { nom: '14 juillet', article: 'du 14 juillet' },
  'Assomption': { nom: '15 août', article: 'du 15 août' },
  'Toussaint': { nom: '1er novembre', article: 'du 1er novembre' },
  'Armistice 1918': { nom: '11 novembre', article: 'du 11 novembre' },
  'Noël': { nom: '25 décembre', article: 'du 25 décembre' },
  // Les trois mobiles : pas de date. Leur nom courant EST leur nom, et seul
  // l'article perd le « Lundi ».
  'Lundi de Pâques': { nom: 'Lundi de Pâques', article: 'de Pâques' },
  'Ascension': { nom: 'Ascension', article: 'de l’Ascension' },
  'Lundi de Pentecôte': { nom: 'Lundi de Pentecôte', article: 'de la Pentecôte' }
}

/**
 * Compose un libellé à partir du nom INTERNE, qui peut en joindre plusieurs.
 *
 * ⚠⚠ LE NOM PEUT EN JOINDRE PLUSIEURS, ET C'EST LE CAS AUJOURD'HUI.
 * `lib/yield/reference.js` joint par « et » tous les fériés d'une même chaîne.
 * Mesuré sur la fenêtre servie le 2 novembre 2026 (→ 2027-11-02) :
 * « Ascension et Victoire 1945 », pour le week-end du 9 mai 2027. Récurrence
 * 2026-2045 : huit années, dont 2035 avec TROIS fériés joints.
 *
 * ⚠ TOUT OU RIEN : si une seule part est inconnue, on rend `null` et l'appelant
 * retombe sur le nom interne. Une phrase à moitié traduite — « de l’Ascension
 * et Machin 1999 » — serait pire qu'une phrase honnêtement non traduite, parce
 * qu'elle aurait l'air juste.
 */
function composer (nomInterne, champ, prefixe) {
  if (!nomInterne) return null
  const parts = String(nomInterne).split(' et ').map((p) => (LIBELLE_FERIE[p] || {})[champ])
  if (parts.some((x) => !x)) return null
  const suite = parts.join(' et ')
  return prefixe ? `${prefixe} ${suite}` : suite
}

/**
 * Le titre d'un week-end prolongé. Garde son repli : un férié inconnu, ou une
 * forme de jointure qui changerait, rend le nom tel quel précédé d'un tiret
 * cadratin — moins joli, mais ça ne ment pas et ça se voit.
 */
export function titreWeekEnd (nomInterne) {
  if (!nomInterne) return null
  return composer(nomInterne, 'article', 'Week-end') || `Week-end — ${nomInterne}`
}

/**
 * La ligne du FÉRIÉ lui-même : le nom courant, sans article.
 * ⚠ REND `null` SI LE NOM N'EST PAS UN FÉRIÉ, et c'est volontaire : l'appelant
 * garde alors son libellé intact. C'est ce qui protège les lignes de vacances
 * — « Vacances de la Toussaint — votre zone » n'est pas « Toussaint ».
 */
export function titreFerie (nomInterne) {
  return composer(nomInterne, 'nom', null)
}

/**
 * La ligne du PONT : « Pont » suivi de l'article de la table.
 * ⚠ REND `null` SI LE NOM N'EST PAS UN FÉRIÉ, comme ci-dessus.
 */
export function titrePont (nomInterne) {
  return composer(nomInterne, 'article', 'Pont')
}
