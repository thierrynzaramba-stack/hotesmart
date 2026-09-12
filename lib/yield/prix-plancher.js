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

// Message destine a l'hote, pas au log : il doit pouvoir agir en le lisant.
function messageRefus (raison, rateCents, plancher, nbDates) {
  const eur = (c) => (Number(c) / 100).toFixed(2).replace('.', ',')
  const combien = nbDates > 1 ? `${nbDates} nuits` : '1 nuit'
  if (raison === 'zero') {
    return `${combien} a 0 € n'ont PAS ete envoyees aux plateformes : un prix a zero `
      + `n'est pas applique par le canal, la nuit se serait vendue au tarif par defaut. `
      + `Ces dates sont fermees en attendant un prix.`
  }
  return `${combien} sous votre prix plancher (${eur(plancher)} €) n'ont PAS ete envoyees : `
    + `tarif ${eur(rateCents)} €. Ces dates sont fermees en attendant un prix.`
}

module.exports = {
  PLANCHER_GLOBAL_CENTIMES,
  plancherDuBien,
  tarifAcceptable,
  messageRefus
}
