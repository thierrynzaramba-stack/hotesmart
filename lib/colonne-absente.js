// lib/colonne-absente.js
//
// « CETTE COLONNE N'EXISTE PAS ENCORE » SE DISTINGUE D'UNE PANNE.
//
// ⚠ POURQUOI CE FICHIER EXISTE. Dans ce depot, une migration se colle A LA MAIN
// par Thierry, apres le push : il y a donc TOUJOURS une fenetre pendant
// laquelle le code demande une colonne que la base n'a pas. Un `select` qui la
// nomme echoue alors EN ENTIER — PostgREST ne rend pas les autres colonnes, il
// rend 42703 — et l'appelant qui traite toute erreur de lecture en 503 coupe
// un ecran complet pour une colonne de confort.
//
// Vecu deux fois sur le meme lot : `pwa_vue_le` groupe avec `visibility_days`
// et `ratio_periode` (revue de ac28b1f : deux reglages existants perdus par une
// colonne neuve), puis `vu_le` dans la lecture des menages (revue de 20fb83d :
// la page de l'hote ET la page de chaque prestataire en 503).
//
// ⚠ CE PREDICAT NE SERT QU'A DEGRADER, JAMAIS A AVALER. Son appelant doit
// relire SANS la colonne et continuer avec un champ absent — pas rendre une
// liste vide, pas se taire sur une vraie panne. Une erreur qui n'est pas
// celle-ci reste une erreur.
function colonneAbsente (err) {
  if (!err) return false
  // `42703` = undefined_column cote Postgres. Le code est le signal sur ;
  // le message est le repli, parce que PostgREST ne le remonte pas toujours.
  if (String(err.code || '') === '42703') return true
  return /does not exist/i.test(String(err.message || '')) &&
         /column/i.test(String(err.message || ''))
}

module.exports = { colonneAbsente }
