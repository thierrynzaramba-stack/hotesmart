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
// ⚠ SEULES LES SOURCES REELLEMENT MESUREES Y FIGURENT. Ma premiere version
// listait aussi `expedia`, `vrbo` et `homeaway` « au cas ou ». Leur valeur
// egalant le defaut, leur SEUL effet etait d'eteindre l'alarme de source
// inconnue, c'est-a-dire de la desactiver pile pour les canaux pour lesquels
// elle a ete construite (constat m4 de la revue). Les retirer ne change aucun
// chiffre et rend l'alarme utile.
//
// ⚠ ET UNE CLE AJOUTEE ICI DOIT ETRE CELLE QUE LE WRITER ECRIT, pas celle qu'on
// aimerait voir. `normaliserOta` de lib/cron-channel-reviews.js ne connait que
// `airbnb`, `bookingcom` et `booking.com`, et laisse passer tout le reste en
// minuscules : « HomeAway » devient `homeaway`, JAMAIS `vrbo` — le mapping
// homeaway -> vrbo vit dans l'AUTRE `normaliserOta` (lib/canaux-du-bien.js),
// qui n'ecrit pas `ota_reviews`.
const ECHELLE_PAR_CANAL = {
  airbnb: 10,     // mesure du 20 octobre 2026 : 563 notes sur 598 depassent 5
  booking: 10     // mesure du 20 octobre 2026 : categories en demi-points (7,5)
}

// ⚠ IL N'Y A PLUS DE DEFAUT, ET C'EST LE CŒUR DE LA DETTE 76. Ma version d'avant
// supposait l'echelle du coeur pour un canal inconnu « pour ne pas faire
// disparaitre ses notes » — ce qui revenait a diviser par deux les notes d'un
// canal qui note sur 5. Une note fausse est pire qu'une note absente : elle a
// l'air d'une note.

// ⚠ `table` EST INJECTABLE, ET C'EST UN BESOIN DE TEST REEL (constat M3 de la
// revue). Toutes les sources mesurees valent 10 aujourd'hui : tant que c'est le
// cas, AUCUN test ne peut distinguer cette fonction d'un `return 10`, et la
// mutation qui supprime la boucle reste verte. Avec une table injectee, la
// resolution par nom s'eprouve pour de bon.
// ⚠ EGALITE EXACTE, ET PLUS UNE SOUS-CHAINE (dette 76, decision de Thierry du
// 20 octobre 2026). La reconnaissance par `includes` faisait qu'un canal dont
// le nom CONTIENT celui d'un canal connu heritait de son echelle : `bookingsync`
// prenait celle de `booking`. Et comme l'alarme de source inconnue utilisait le
// MEME test, elle ne se declenchait pas sur ces cas — la seule classe d'erreur
// contre laquelle elle avait ete construite passait donc en silence.
//
// ⚠ ET UNE SOURCE INCONNUE N'EST PLUS CONVERTIE DU TOUT. Elle rendait le defaut
// (/10), c'est-a-dire qu'elle DIVISAIT PAR DEUX une note dont personne ne
// connaissait l'echelle : Vrbo, HomeAway et Expedia notent sur 5, et leurs avis
// se seraient affiches a la moitie de leur valeur, sans un mot. Mieux vaut pas
// de note qu'une note fausse — c'est la regle de tout ce lot.
//
// Mesure du 20 octobre 2026 sur les 702 avis de production : les seules valeurs
// d'`ota` sont `airbnb` (600 lignes), `booking` (99) et `direct` (5, dont ZERO
// notee). Aucune note ne disparait donc aujourd'hui.
function echelleDe (ota, table = ECHELLE_PAR_CANAL) {
  const cle = String(ota == null ? '' : ota).trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(table, cle) ? table[cle] : null
}

// ⚠ UNE SOURCE HORS TABLE NE PASSE PLUS EN SILENCE (constat M2). Le commentaire
// ci-dessus dit « personne ne le verra » — c'etait vrai, et c'etait le defaut :
// une source n'arrive pas par cette table, elle arrive par le WRITER, qui
// accepte n'importe quel libelle. On le dit une fois par canal et par instance,
// assez pour qu'une alarme le remonte, pas assez pour inonder le journal.
// ⚠ UN `console.warn` NE REVEILLE PERSONNE — c'est la regle gravee en tete de
// `lib/canaux-du-bien.js`, et le registre la prescrivait deja pour cette dette :
// « correspondance exacte d'abord … ET `sonner()` a la place du console.warn ».
// La correspondance exacte est faite ; voici l'autre moitie.
//
// Pourquoi ce n'est pas `microSurCinq` qui sonne : elle est SYNCHRONE et tourne
// dans une boucle qui lit jusqu'a 50 000 lignes, quand `sonner()` est `async`.
// On ACCUMULE donc les sources rencontrees, et l'appelant — qui est `async` —
// sonne UNE FOIS en fin de passage, avec son alarme injectable.
//
// Et le silence coute plus cher depuis la dette 76 : la consequence d'une
// source hors table est passee de « note divisee par deux » (fausse, mais
// VISIBLE — un 2,4/5 se remarque) a « note absente » (juste, mais INVISIBLE :
// l'ecran se tait).
const INCONNUS_SIGNALES = new Set()
const INCONNUS_DU_PASSAGE = new Set()
function signalerSourceInconnue (ota) {
  const cle = String(ota == null ? '' : ota).trim().toLowerCase()
  INCONNUS_DU_PASSAGE.add(cle || '(vide)')
  if (INCONNUS_SIGNALES.has(cle)) return
  INCONNUS_SIGNALES.add(cle)
  console.warn(`[avis/echelle] source « ${cle || '(vide)'} » absente de la table : ses notes ne sont PAS converties. A MESURER puis ajouter.`)
}

/**
 * Sonne chez le fondateur si des sources hors table ont ete rencontrees, et
 * vide l'ardoise. A appeler en fin de lecture, par un appelant `async`.
 *
 * ⚠ `alarme` EST INJECTABLE, comme dans `lib/canaux-du-bien.js` : c'est la
 * seule facon de prouver qu'elle sonne ET qu'elle ne sonne pas.
 * @returns les sources signalees, pour que l'appelant puisse les journaliser.
 */
async function sonnerSourcesInconnues (alarme) {
  if (!INCONNUS_DU_PASSAGE.size) return []
  const sources = [...INCONNUS_DU_PASSAGE]
  INCONNUS_DU_PASSAGE.clear()
  try {
    const detail = {
      sources,
      effet: 'leurs notes ne sont pas converties, donc ne comptent dans aucune moyenne',
      geste: 'mesurer l echelle de la source, puis l ajouter a ECHELLE_PAR_CANAL (lib/avis/echelle.js)'
    }
    if (typeof alarme === 'function') await alarme('avis_echelle_inconnue', detail)
    else await require('../founder-notify').reportIncident('avis_echelle_inconnue', detail)
  } catch (e) {
    console.error('[avis/echelle] alarme non levee :', e.message)
  }
  return sources
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
  // ⚠ PAS D'ECHELLE, PAS DE CONVERSION — et on le DIT (dette 76). Supposer le
  // defaut reviendrait a diviser par deux une note sur 5 sans que personne le
  // voie : « 4,5 » afficherait « 2,3 ».
  const echelle = echelleDe(ota, table)
  if (echelle == null) { signalerSourceInconnue(ota); return null }
  const micro = Math.round((v * 5 * MICRO) / echelle)
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
  sonnerSourcesInconnues, MICRO, ECHELLE_PAR_CANAL
}
