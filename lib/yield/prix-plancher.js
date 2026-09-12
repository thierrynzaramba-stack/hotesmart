// lib/yield/prix-plancher.js
// DOC : docs/kb/prix-plancher.md (modif = MEME COMMIT)
//
// Garde-fou anti « nuit a 0 ». Fonction PURE : ni base, ni reseau.
//
// LE DEFAUT QU'ELLE FERME, SIGNALE PAR THIERRY LE 12 SEPTEMBRE 2026.
// Rien dans la chaine n'empechait un tarif absurde de partir aux OTA :
// `runFullSync` ne refuse QUE l'absence totale de prix (`prixEur === null`), et
// une valeur basse — 0, 1, 12 EUR — passait pour un prix valide.
//
// ⚠ ET `rate: 0` EST LE PIRE CAS, parce qu'il ne fait rien de visible.
// Le repo le documente deja : « Channex ne rejette pas 0, il l'ignore et garde
// le prix de la grille ». La nuit se vend donc au tarif par defaut du rate
// plan — un prix que l'hote n'a jamais choisi — sans qu'aucune erreur ne se
// declenche.
//
// ⚠ ON FERME, ON NE CORRIGE PAS.
// Remonter un prix au plancher inventerait un tarif que l'hote n'a pas decide,
// et le vendrait en son nom. Une nuit sous le plancher est traitee comme une
// nuit SANS PRIX : fermee, et signalee. C'est exactement le traitement que
// `runFullSync` reserve deja a `prixEur === null` (`fermeesSansPrix`), donc
// aucun mecanisme nouveau — seulement une condition de plus.

// Plancher global, en centimes. Volontairement bas : il n'est pas la pour
// imposer une politique tarifaire, seulement pour arreter l'absurde. Un hote
// qui vend a 25 EUR la nuit doit pouvoir le faire ; personne ne vend a 3 EUR
// par choix.
const PLANCHER_GLOBAL_CENTIMES = 1000   // 10 EUR

// Le plancher applicable a un bien, en centimes.
// ⚠ `prix_minimum` NON SELECTIONNE vaut `undefined`, pas 0 : sans ce soin, un
// appelant qui oublie la colonne ferait retomber tous ses biens sur le plancher
// global sans le savoir. On ne peut pas le detecter ici (undefined et null sont
// deux facons legitimes de dire « pas de plancher propre »), donc les
// appelants le documentent dans leur SELECT.
function plancherDuBien (bien) {
  const propre = Number(bien?.prix_minimum)
  return Number.isFinite(propre) && propre > 0 ? propre : PLANCHER_GLOBAL_CENTIMES
}

// Un tarif est-il poussable ? Rend { ok, raison, plancher }.
function tarifAcceptable (rateCents, bien) {
  const plancher = plancherDuBien(bien)
  const n = Number(rateCents)
  if (!Number.isFinite(n)) return { ok: false, raison: 'non_numerique', plancher }
  // `rate: 0` merite sa propre raison : c'est le cas que Channex ignore en
  // silence, donc celui qui se voit le moins et coute le plus.
  if (n === 0) return { ok: false, raison: 'zero', plancher }
  if (n < 0) return { ok: false, raison: 'negatif', plancher }
  if (n < plancher) return { ok: false, raison: 'sous_plancher', plancher }
  return { ok: true, raison: null, plancher }
}

// Message destine a l'HOTE, pas au log : il doit pouvoir agir en le lisant.
//
// ⚠ DEUX CONTEXTES, DEUX VERITES DIFFERENTES — corrige le 12 septembre 2026
// apres un cas reel. Le message annonçait « ces dates sont fermees » dans les
// deux cas. C'est vrai au full sync, FAUX au calendrier, ou l'on refuse la
// saisie sans rien ecrire ni fermer. Thierry a saisi 100 € sur un bien a
// 130 € de plancher : rien n'a ete enregistre — la garde a fonctionne — mais
// le message lui disait le contraire de ce qui s'etait passe.
//
// `contexte` : 'saisie' (refus, rien n'a bouge) | 'poussee' (date fermee).
function messageRefus (raison, rateCents, plancher, nbDates, contexte = 'saisie') {
  const eur = (c) => (Number(c) / 100).toFixed(2).replace('.', ',')
  const plural = nbDates > 1
  const combien = plural ? `${nbDates} nuits` : '1 nuit'
  const accord = plural ? 'sont' : 'est'

  const cause = raison === 'zero'
    ? `un prix a 0 € n'est pas applique par les plateformes : la nuit se serait `
      + `vendue au tarif par defaut de votre grille`
    : `le tarif ${eur(rateCents)} € est sous votre prix plancher de ${eur(plancher)} €`

  if (contexte === 'saisie') {
    // Rien n'a ete ecrit : le dire, sinon l'hote croit son prix enregistre.
    return `Prix NON enregistre — ${cause}. ${combien} ${accord} concernee${plural ? 's' : ''} : `
      + `votre tarif precedent reste en place. Corrigez le prix, ou baissez le `
      + `plancher dans la fiche du logement.`
  }
  return `${combien} ${accord} FERMEE${plural ? 'S' : ''} : ${cause}. Aucun prix n'est `
    + `parti aux plateformes. Corrigez le tarif dans le calendrier.`
}

module.exports = {
  PLANCHER_GLOBAL_CENTIMES,
  plancherDuBien,
  tarifAcceptable,
  messageRefus
}
