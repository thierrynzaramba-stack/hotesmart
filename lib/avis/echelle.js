// ═══════════════════════════════════════════════════════════════════════════
// L'ECHELLE DES NOTES — tout se ramene sur 5, une seule fois
// ═══════════════════════════════════════════════════════════════════════════
//
// Decision de Thierry, 20 octobre 2026 : « tout sur 5. Les notes Booking (/10)
// sont divisees par 2 avant la moyenne, ponderee par le nombre d'avis de chaque
// canal. Un arrondi a une decimale, jamais d'arrondi intermediaire. »
//
// ⚠ LE COEUR NE NORMALISE RIEN A L'INGESTION, et c'est voulu : la migration
// `2026-09-02-ota-reviews` le grave — « convertir ici graverait l'erreur dans le
// coeur ; la mise a l'echelle est un calcul d'app ». Ce fichier EST ce calcul,
// et il est le seul : deux conversions dans deux fichiers afficheraient deux
// notes differentes pour le meme logement.
//
// ⚠ CE QUE LA MESURE DIT, ET QUI N'EST PAS CE QU'ON CROIT. Releve du 20 octobre
// 2026 sur les 702 avis de production, en lecture seule :
//
//   channex/airbnb   598 notes, min 0, max 10, 563 au-dessus de 5
//   beds24/booking    94 notes, min 3, max 10,  90 au-dessus de 5
//   channex/booking    5 notes, min 1, max 10,   3 au-dessus de 5
//
// Airbnb note bien ses sejours sur 5 ETOILES, mais ce n'est pas ce qui arrive
// dans le coeur : le partenaire livre la note deja ramenee sur 10 (une categorie
// « clean » a 10 pour un sejour parfait, et 563 notes Airbnb sur 598 depassent
// 5 — impossible sur une echelle a 5). Les deux canaux sont donc stockes sur la
// MEME echelle, et « diviser Booking par 2 mais pas Airbnb » rendrait des notes
// Airbnb a 9,8 sur 5.
//
// La table ci-dessous existe quand meme, et c'est tout l'interet : le jour ou
// une source livre du /5 — un canal nouveau, un import, une saisie a la main —
// une ligne suffit, et TOUS les ecrans suivent. Sans elle, il faudrait retrouver
// chaque division par deux.
//
// ⚠ UNE SOURCE NE S'AJOUTE PAS ICI SANS AVOIR ETE MESUREE. Se tromper d'echelle
// divise ou double la note d'un logement — et personne ne le verra, parce que
// 4,9 comme 9,8 ont l'air d'une note.
//
// ⚠ LES CLES SONT CELLES QUE LE WRITER ECRIT, pas celles qu'on aimerait voir
// (constat m2 de la revue). `normaliserOta` de lib/cron-channel-reviews.js ne
// connait que `airbnb`, `bookingcom` et `booking.com` et laisse passer tout le
// reste en minuscules : « HomeAway » devient `homeaway`, JAMAIS `vrbo`. La clé
// `vrbo` seule ne matcherait donc rien le jour ou son echelle differerait — le
// mapping homeaway -> vrbo vit dans l'AUTRE `normaliserOta`
// (lib/canaux-du-bien.js), qui n'ecrit pas `ota_reviews`.
const ECHELLE_PAR_CANAL = {
  airbnb: 10,     // mesure du 20 octobre 2026 : 563 notes sur 598 depassent 5
  booking: 10,    // mesure du 20 octobre 2026 : categories en demi-points (7,5)
  expedia: 10,
  vrbo: 10,
  homeaway: 10
}

// ⚠ LE DEFAUT SUPPOSE L'ECHELLE DU COEUR. Un canal inconnu n'est pas une raison
// de faire disparaitre ses notes : on applique l'echelle que toutes les sources
// mesurees partagent, et la ligne ci-dessus dit quoi faire le jour ou une source
// en sort.
const ECHELLE_PAR_DEFAUT = 10

// ⚠ `table` EST INJECTABLE, ET C'EST UN BESOIN DE TEST REEL (constat M3 de la
// revue). Toutes les sources mesurees valent 10 aujourd'hui : tant que c'est le
// cas, AUCUN test ne peut distinguer cette fonction d'un `return 10`, et la
// mutation qui supprime la boucle reste verte. Avec une table injectee, la
// resolution par nom s'eprouve pour de bon.
function echelleDe (ota, table = ECHELLE_PAR_CANAL) {
  const cle = String(ota == null ? '' : ota).toLowerCase()
  for (const [nom, echelle] of Object.entries(table)) {
    if (cle.includes(nom)) return echelle
  }
  return ECHELLE_PAR_DEFAUT
}

// ⚠ UNE SOURCE HORS TABLE NE PASSE PLUS EN SILENCE (constat M2). Le commentaire
// ci-dessus dit « personne ne le verra » — c'etait vrai, et c'etait le defaut :
// une source n'arrive pas par cette table, elle arrive par le WRITER, qui
// accepte n'importe quel libelle. On le dit une fois par canal et par instance,
// assez pour qu'une alarme le remonte, pas assez pour inonder le journal.
const INCONNUS_SIGNALES = new Set()
function signalerSourceInconnue (ota, table) {
  const cle = String(ota == null ? '' : ota).toLowerCase()
  if (!cle || INCONNUS_SIGNALES.has(cle)) return
  if (Object.keys(table).some(nom => cle.includes(nom))) return
  INCONNUS_SIGNALES.add(cle)
  console.warn(`[avis/echelle] source « ${cle} » absente de la table : echelle supposee /${ECHELLE_PAR_DEFAUT}. A MESURER avant de s'y fier.`)
}

// Une note, ramenee sur 5. `null` si elle n'est pas exploitable — JAMAIS zero :
// un avis sans note n'est pas un avis a 0/5.
//
// ⚠ `> 0` ET PAS « non nul » : zero n'est une note chez aucun canal. Booking
// part de 1, Airbnb de 1 etoile (soit 2 sur l'echelle du coeur). Un zero est
// l'objet d'avis VIDE que le partenaire a ouvert sans que le voyageur ecrive —
// mesure du 20 octobre : les 33 zeros d'Airbnb sont exactement les 33 avis
// masques. Le compter ferait descendre la note d'un logement sur rien.
function surCinq (note, ota, table = ECHELLE_PAR_CANAL) {
  const micro = microSurCinq(note, ota, table)
  return micro == null ? null : micro / MICRO
}

// ⚠ LE CALCUL SE FAIT EN ENTIERS, ET C'EST LE CONSTAT M1 DE LA REVUE. Avec des
// flottants, l'arrondi d'un ex aequo a .x5 depend du NOMBRE d'avis : mesure sur
// une population dont la moyenne exacte vaut 4,85 (toutes les notes a 9,7),
//
//     n=1 -> 4,9   n=10 -> 4,9   n=20 -> 4,8   n=100 -> 4,9   n=332 -> 4,8
//
// — quatre bascules pour la meme moyenne. `(9.7/10)*5` vaut 4.850000000000001
// et monte, tandis que l'accumulation sur 332 termes retombe sous 4,85 et
// descend. Autrement dit : UN AVIS DE PLUS, IDENTIQUE AUX AUTRES, pouvait faire
// bouger la note de 0,1. La bulle a 332 notes.
//
// En micro-unites entieres, la somme est exacte pour toute note multiple de
// 0,000002 — donc pour toutes les notes reelles, qui sont des multiples de 0,5
// (Booking descend a 7,5 sur ses categories). La regle de demi est alors
// explicite : AU PLUS PROCHE, ET LE DEMI VERS LE HAUT.
const MICRO = 1000000

function microSurCinq (note, ota, table = ECHELLE_PAR_CANAL) {
  const v = Number(note)
  if (!Number.isFinite(v) || v <= 0) return null
  signalerSourceInconnue(ota, table)
  const micro = Math.round((v * 5 * MICRO) / echelleDe(ota, table))
  // ⚠ UNE NOTE QUI DEPASSE 5 APRES CONVERSION DIT QUE L'ECHELLE EST FAUSSE, et
  // c'est le seul moment ou on peut s'en apercevoir. Afficher « 50,0 / 5 » ou,
  // pire, « 5,0 / 5 » apres l'avoir plafonnee, serait affirmer une note qu'on
  // ne connait pas. On ecarte la note : le logement affichera son nombre
  // d'avis, sans etoile, et le journal porte la cause.
  if (micro > 5 * MICRO) {
    console.warn(`[avis/echelle] note ${v} de « ${ota} » hors echelle apres conversion : ecartee.`)
    return null
  }
  return micro
}

// ⚠ L'ARRONDI, EN ENTIERS, DEMI VERS LE HAUT. `Math.round(x * 10) / 10` sur un
// flottant ne tient pas sa regle de demi (voir ci-dessus). Ici tout est entier :
// `somme * 10 / (n * MICRO)` est la moyenne en DIXIEMES, et on ajoute une
// demi-unite avant de tronquer.
function arrondiDixiemes (sommeMicro, n) {
  if (!n) return null
  return Math.floor((sommeMicro * 10 + (n * MICRO) / 2) / (n * MICRO)) / 10
}

// Garde pour les appelants qui arrondissent une valeur deja calculee.
const arrondi1 = (x) => arrondiDixiemes(Math.round(Number(x) * MICRO), 1)

/**
 * La note d'un ensemble d'avis, sur 5.
 *
 * ⚠ UN SEUL ARRONDI, A LA FIN (demande de Thierry). Chaque note est ramenee sur
 * 5 en flottant, on somme, on divise, et on arrondit UNE fois. Arrondir la
 * moyenne sur 10 puis la diviser par deux donne un autre chiffre : 9,65 devient
 * 9,7 puis 4,9, la ou le calcul exact donne 4,8. C'etait le defaut de la
 * premiere version.
 *
 * ⚠ LA PONDERATION PAR CANAL EST AUTOMATIQUE, et il ne faut surtout pas la
 * faire a la main : chaque avis pese 1 apres conversion, donc un canal qui
 * apporte 300 avis pese 300. Moyenner les MOYENNES de chaque canal donnerait le
 * meme poids a un canal de 300 avis et a un canal de 2.
 *
 * @param lignes  [{ ota, overall_score }]
 * @returns { note_sur_5, notes }  `note_sur_5` vaut `null` si aucune note.
 */
function noteSur5Des (lignes, { table = ECHELLE_PAR_CANAL } = {}) {
  let somme = 0
  let n = 0
  for (const l of lignes || []) {
    const micro = microSurCinq(l && l.overall_score, l && l.ota, table)
    if (micro == null) continue
    somme += micro
    n++
  }
  return { note_sur_5: n ? arrondiDixiemes(somme, n) : null, notes: n }
}

module.exports = {
  surCinq, noteSur5Des, echelleDe, arrondi1, arrondiDixiemes, microSurCinq,
  MICRO, ECHELLE_PAR_CANAL, ECHELLE_PAR_DEFAUT
}
