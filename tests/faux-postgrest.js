// tests/faux-postgrest.js — la sémantique PostgREST que les DOUBLES doivent honorer.
//
// ⚠ CE FICHIER N'EST PAS UN TEST (pas de `.test.js` : `npm test` ne le lance
// pas). C'est la seule implémentation des deux constructions que les doubles de
// `ota_reviews` ne savaient pas évaluer, et qu'ils DOIVENT évaluer depuis que
// `lib/attribution-prestataire.js` compte par filtres au lieu de rapatrier des
// identifiants (14 septembre 2026).
//
// ⚠ POURQUOI UN FICHIER PARTAGÉ plutôt qu'une copie par test.
// Trois fichiers de tests montent un double d'`ota_reviews`. Recopier un
// évaluateur dans chacun, c'est garantir qu'ils divergent : le jour où l'un
// devient plus permissif que la base, son test reste vert pendant que le code
// est faux — le faux vert que tout ce chantier passe son temps à fermer.
//
// ⚠ ET IL REFUSE CE QU'IL NE SAIT PAS ÉVALUER. Un double qui laisserait passer
// une expression `or()` inconnue rendrait le bornage par dates indétectable :
// on pourrait le casser sans qu'un test bronche. Deux formes seulement sont
// émises par `bornerParDate` ; toute autre lève, et c'est le but.

// ⚠ LES DEUX COLONNES N'ONT PAS LE MEME TYPE, ET CE DOUBLE DOIT LE SAVOIR.
// `stay_end` est un `date`, `received_at` un `timestamptz`. Une premiere version
// de ce fichier tronquait les DEUX a `slice(0,10)` avant de comparer : elle
// reproduisait la semantique de `dansLaPeriode` (date pure), pas celle de
// PostgREST. Consequence, relevee en review : le compteur excluait un avis recu
// le dernier jour a 18 h — `received_at <= '2026-08-31'` vaut
// `<= 2026-08-31 00:00:00` — pendant que la liste l'incluait, et AUCUN test ne
// pouvait le voir. Un double plus indulgent que la base est un faux vert, et
// c'est precisement ce que ce fichier existe pour empecher.
//
// On modelise donc chaque branche avec son type : `stay_end` en jour,
// `received_at` en INSTANT (UTC, comme Supabase le rend).
const JOUR = /^(\d{4})-(\d{2})-(\d{2})$/
const instantDe = v => Date.parse(JOUR.test(String(v)) ? String(v) + 'T00:00:00Z' : String(v))

// Les deux formes que `bornerParDate` produit, et elles seules.
const BORNE_HAUTE = /^and\(stay_end\.not\.is\.null,stay_end\.lte\.([^)]+)\),and\(stay_end\.is\.null,received_at\.lt\.([^)]+)\)$/
const BORNE_BASSE = /^and\(stay_end\.not\.is\.null,stay_end\.gte\.([^)]+)\),and\(stay_end\.is\.null,received_at\.gte\.([^)]+)\)$/
const A_UNE_DATE = 'stay_end.not.is.null,received_at.not.is.null'

function evaluerOr (ligne, expression) {
  const e = String(expression)

  const haute = BORNE_HAUTE.exec(e)
  if (haute) {
    // La branche suivie depend de la ligne, exactement comme le `or` SQL.
    if (ligne.stay_end) return String(ligne.stay_end).slice(0, 10) <= haute[1]
    if (!ligne.received_at) return false
    return instantDe(ligne.received_at) < instantDe(haute[2])   // `lt` lendemain
  }

  const basse = BORNE_BASSE.exec(e)
  if (basse) {
    if (ligne.stay_end) return String(ligne.stay_end).slice(0, 10) >= basse[1]
    if (!ligne.received_at) return false
    return instantDe(ligne.received_at) >= instantDe(basse[2])
  }

  // ⚠ Un avis SANS aucune date n'est dans aucune periode, meme non bornee :
  // `dansLaPeriode` rend `false` quand la date de rattachement est nulle.
  if (e === A_UNE_DATE) return !!(ligne.stay_end || ligne.received_at)

  throw new Error('faux-postgrest : expression or() non modelisee -> ' + e)
}

// L'embed `menage_events!inner(token)` : jointure INTERNE.
// ⚠ Un avis sans ménage rattaché SORT du lot — c'est ce que `!inner` veut dire,
// et c'est ce qui rend la voie 1 disjointe des avis attribués par période seule.
// ⚠ `user_id` EST HONORE LUI AUSSI. C'est la defense en profondeur de la voie 1 :
// un jeton n'a aucune unicite garantie entre comptes. Un double qui ignorerait ce
// filtre le rendrait supprimable sans qu'un test bronche.
function passeEmbed (ligne, filtres, evenements) {
  const jeton = filtres['menage_events.token']
  const compte = filtres['menage_events.user_id']
  if (jeton === undefined && compte === undefined) return true
  const ev = (evenements || []).find(e => e.id === ligne.menage_event_id)
  if (!ev) return false                       // `!inner` : pas de menage, pas de ligne
  if (jeton !== undefined && ev.token !== jeton) return false
  if (compte !== undefined && ev.user_id !== compte) return false
  return true
}

module.exports = { evaluerOr, passeEmbed }
