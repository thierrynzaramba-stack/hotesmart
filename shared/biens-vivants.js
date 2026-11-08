// shared/biens-vivants.js — LE PENDANT CLIENT DE lib/biens-vivants.js
// DOC : docs/kb/coeur-de-donnees.md
//
// ⚠ POURQUOI DEUX MODULES. Le serveur est en CommonJS (`lib/`), le navigateur
// en modules ES (`shared/`) : un seul fichier ne peut pas servir les deux dans
// ce dépôt. Ce qui est partagé est donc la RÈGLE, pas le fichier — et
// `tests/biens-vivants-parite.test.js` refuse que les deux divergent sur le nom
// de la colonne, qui est la seule chose qu'ils ont en commun.
//
// ⚠ ET IL EXISTE PARCE QUE SIX ÉCRANS NE PASSENT PAS PAR UN ENDPOINT. Constat
// du 4 novembre 2026, en cherchant le point 7 de Thierry : les pages YieldFlow,
// la barre latérale et la messagerie lisent `properties` DIRECTEMENT depuis le
// navigateur, par Supabase et la RLS. Aucun filtre serveur ne peut les
// atteindre — sa consigne « un filtre partagé (serveur) » ne s'y applique pas
// telle quelle, et c'est le genre d'écart qu'il faut dire plutôt que contourner
// page par page.

export const COLONNE_ARCHIVE = 'archive_le'

// ⚠ MÊME GESTE QUE `sansArchives` CÔTÉ SERVEUR : on ENVELOPPE une chaîne déjà
// commencée par `.select()`, jamais le `.from()` seul — le client Supabase
// n'expose les filtres qu'après `select`.
//
// ⚠ ET ELLE LÈVE SUR AUTRE CHOSE QU'UNE CHAÎNE, comme sa sœur : un appel écrit
// à l'envers doit échouer bruyamment. Sinon il rend `undefined`, la page
// affiche « aucun logement », et personne ne sait pourquoi.
export function sansArchives (q) {
  if (!q || typeof q.is !== 'function') {
    throw new TypeError('sansArchives : chaîne Supabase attendue (pas de .is)')
  }
  return q.is(COLONNE_ARCHIVE, null)
}

// Un bien rendu par une lecture qui NE filtre pas — une table de
// correspondance, la fiche d'un bien précis — se juge avec ceci.
export const estArchive = (bien) => Boolean(bien && bien[COLONNE_ARCHIVE])
