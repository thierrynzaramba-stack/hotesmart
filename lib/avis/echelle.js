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
const ECHELLE_PAR_CANAL = {
  airbnb: 10,     // mesure du 20 octobre 2026 : 563 notes sur 598 depassent 5
  booking: 10,    // mesure du 20 octobre 2026 : categories en demi-points (7,5)
  expedia: 10,
  vrbo: 10
}

// ⚠ LE DEFAUT SUPPOSE L'ECHELLE DU COEUR. Un canal inconnu n'est pas une raison
// de faire disparaitre ses notes : on applique l'echelle que toutes les sources
// mesurees partagent, et la ligne ci-dessus dit quoi faire le jour ou une source
// en sort.
const ECHELLE_PAR_DEFAUT = 10

function echelleDe (ota) {
  const cle = String(ota == null ? '' : ota).toLowerCase()
  for (const [nom, echelle] of Object.entries(ECHELLE_PAR_CANAL)) {
    if (cle.includes(nom)) return echelle
  }
  return ECHELLE_PAR_DEFAUT
}

// Une note, ramenee sur 5. `null` si elle n'est pas exploitable — JAMAIS zero :
// un avis sans note n'est pas un avis a 0/5.
//
// ⚠ `> 0` ET PAS « non nul » : zero n'est une note chez aucun canal. Booking
// part de 1, Airbnb de 1 etoile (soit 2 sur l'echelle du coeur). Un zero est
// l'objet d'avis VIDE que le partenaire a ouvert sans que le voyageur ecrive —
// mesure du 20 octobre : les 33 zeros d'Airbnb sont exactement les 33 avis
// masques. Le compter ferait descendre la note d'un logement sur rien.
function surCinq (note, ota) {
  const v = Number(note)
  if (!Number.isFinite(v) || v <= 0) return null
  return (v / echelleDe(ota)) * 5
}

const arrondi1 = (x) => Math.round(x * 10) / 10

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
function noteSur5Des (lignes) {
  let somme = 0
  let n = 0
  for (const l of lignes || []) {
    const v = surCinq(l && l.overall_score, l && l.ota)
    if (v == null) continue
    somme += v
    n++
  }
  return { note_sur_5: n ? arrondi1(somme / n) : null, notes: n }
}

module.exports = { surCinq, noteSur5Des, echelleDe, arrondi1, ECHELLE_PAR_CANAL, ECHELLE_PAR_DEFAUT }
