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

// `coalesce(stay_end, received_at)` — la date de rattachement d'un avis.
// ⚠ `stay_end` d'abord : un ménage précède le séjour, l'avis peut tomber des
// semaines après. Même règle que `dateDeRattachement` du lib.
function dateDeRattachement (ligne) {
  return ligne.stay_end || ligne.received_at || null
}

// Les deux formes que `bornerParDate` produit, et elles seules.
const BORNE = /^and\(stay_end\.not\.is\.null,stay_end\.(lte|gte)\.([^)]+)\),and\(stay_end\.is\.null,received_at\.\1\.\2\)$/
const A_UNE_DATE = 'stay_end.not.is.null,received_at.not.is.null'

function evaluerOr (ligne, expression) {
  const borne = BORNE.exec(String(expression))
  if (borne) {
    const d = dateDeRattachement(ligne)
    if (!d) return false
    const v = String(d).slice(0, 10)
    return borne[1] === 'lte' ? v <= borne[2] : v >= borne[2]
  }
  // ⚠ Un avis SANS aucune date n'est dans aucune période, même non bornée :
  // `dansLaPeriode` rend `false` quand la date de rattachement est nulle.
  if (String(expression) === A_UNE_DATE) return dateDeRattachement(ligne) != null
  throw new Error('faux-postgrest : expression or() non modélisée -> ' + expression)
}

// L'embed `menage_events!inner(token)` : jointure INTERNE.
// ⚠ Un avis sans ménage rattaché SORT du lot — c'est ce que `!inner` veut dire,
// et c'est ce qui rend la voie 1 disjointe des avis attribués par période seule.
function passeEmbed (ligne, filtres, evenements) {
  const attendu = filtres['menage_events.token']
  if (attendu === undefined) return true
  const ev = (evenements || []).find(e => e.id === ligne.menage_event_id)
  return !!ev && ev.token === attendu
}

module.exports = { evaluerOr, passeEmbed, dateDeRattachement }
