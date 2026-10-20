// tests/avis-echelle.test.js — L'ECHELLE DES NOTES, ramenee sur 5.
//
// Decision de Thierry du 20 octobre 2026 : « tout sur 5. Les notes Booking
// (/10) sont divisees par 2 avant la moyenne, ponderee par le nombre d'avis de
// chaque canal. Un arrondi a une decimale, jamais d'arrondi intermediaire. »
//
// Les trois qui comptent :
//   1. le test que Thierry a pose lui-meme : 10 Airbnb a 5 + 10 Booking a 8 => 4,5 ;
//   2. aucun arrondi intermediaire — 9,65/10 fait 4,8, pas 4,9 ;
//   3. un zero n'est pas une note : c'est l'objet d'avis vide.

const test = require('node:test')
const assert = require('node:assert/strict')
const E = require('../lib/avis/echelle')

const avis = (n, ota, overall_score) => Array.from({ length: n }, () => ({ ota, overall_score }))

test('LE TEST QUI COMPTE (Thierry, 20 octobre 2026) : 10 Airbnb a 5 etoiles + 10 Booking a 8 => 4,5 / 5', () => {
  // ⚠ LES NOTES SONT ECRITES COMME LA BASE LES PORTE. Airbnb note sur 5 etoiles
  // chez lui, mais livre la note DEJA ramenee sur 10 : « 5 etoiles » arrive a
  // 10. Mesure du 20 octobre 2026 sur les 702 avis de production : 563 notes
  // Airbnb sur 598 depassent 5, ce qui est impossible sur une echelle a 5, et
  // les categories d'un sejour parfait valent 10.
  const r = E.noteSur5Des([...avis(10, 'airbnb', 10), ...avis(10, 'booking', 8)])
  assert.equal(r.note_sur_5, 4.5)
  assert.equal(r.notes, 20)
})

test('la meme regle tient si une source livre VRAIMENT du /5', () => {
  // C'est la raison d'etre de la table : le jour ou une source en /5 arrive,
  // une ligne suffit et tous les ecrans suivent. Ici on l'eprouve par la
  // fonction de conversion elle-meme.
  assert.equal(E.surCinq(10, 'airbnb'), 5, '10 sur l echelle du coeur = 5 / 5')
  assert.equal(E.surCinq(8, 'booking'), 4, '8 / 10 = 4 / 5')
  assert.equal(E.surCinq(5, 'booking'), 2.5)
})

test('LE TEST QUI COMPTE : AUCUN ARRONDI INTERMEDIAIRE', () => {
  // Moyenne exacte sur 10 : 9,65. Arrondir d abord (9,7) puis diviser donne
  // 4,9 ; le calcul exact donne 4,825, donc 4,8.
  assert.equal(E.noteSur5Des([
    { ota: 'airbnb', overall_score: 9.5 },
    { ota: 'airbnb', overall_score: 9.8 },
    { ota: 'airbnb', overall_score: 9.65 }
  ]).note_sur_5, 4.8)
  // Un seul avis a 9,65 : meme raisonnement, meme resultat.
  assert.equal(E.noteSur5Des([{ ota: 'airbnb', overall_score: 9.65 }]).note_sur_5, 4.8)

  // ⚠ LE CAS QUI TRANCHE, et les deux precedents ne le faisaient pas : arrondir
  // CHAQUE note avant de sommer donne un autre chiffre. 9,9 et 9,7 valent 4,95
  // et 4,85 ; leur moyenne exacte est 4,90. Arrondies d'abord (5,0 et 4,9),
  // elles donnent 4,95, qui remonte a 5,0 — une note PARFAITE affichee sur deux
  // avis qui ne le sont pas.
  assert.equal(E.noteSur5Des([
    { ota: 'airbnb', overall_score: 9.9 },
    { ota: 'airbnb', overall_score: 9.7 }
  ]).note_sur_5, 4.9)
})

test('LA PONDERATION EST PAR AVIS — un canal a 300 avis pese 300', () => {
  // Moyenner les MOYENNES de chaque canal donnerait (5,0 + 2,5) / 2 = 3,75.
  // Ponderer par le nombre d avis : (5,0 x 10 + 2,5 x 1) / 11 = 4,77 => 4,8.
  assert.equal(E.noteSur5Des([...avis(10, 'airbnb', 10), ...avis(1, 'booking', 5)]).note_sur_5, 4.8)
})

test('LE TEST QUI COMPTE : zero n est pas une note, c est l objet d avis VIDE', () => {
  // Mesure du 20 octobre 2026 : les 33 zeros d Airbnb sont exactement les 33
  // avis masques. Le jour ou Airbnb en revele un, il deviendrait visible a 0 —
  // et ferait tomber la note du logement sur rien.
  assert.equal(E.surCinq(0, 'airbnb'), null)
  assert.equal(E.noteSur5Des([{ ota: 'airbnb', overall_score: 10 }, { ota: 'airbnb', overall_score: 0 }]).note_sur_5, 5)
  assert.equal(E.noteSur5Des([{ ota: 'airbnb', overall_score: 10 }, { ota: 'airbnb', overall_score: 0 }]).notes, 1)
})

test('LE TEST QUI COMPTE : un avis SANS NOTE ne descend pas la note a zero', () => {
  // Si `noteSur5Des` comptait les avis sans note dans son diviseur, un logement
  // a 10 avis parfaits et 10 detections de messages afficherait 2,5 / 5.
  const r = E.noteSur5Des([...avis(10, 'airbnb', 10), ...avis(10, 'direct', null)])
  assert.equal(r.note_sur_5, 5)
  assert.equal(r.notes, 10, 'seuls les avis NOTES comptent dans le diviseur')
})

test('une note absente, vide ou illisible ne compte pas — et ne vaut jamais zero', () => {
  for (const v of [null, undefined, '', 'bien', NaN, -2]) {
    assert.equal(E.surCinq(v, 'airbnb'), null, `${String(v)} n est pas une note`)
  }
  assert.deepEqual(E.noteSur5Des([]), { note_sur_5: null, notes: 0 })
  assert.deepEqual(E.noteSur5Des(null), { note_sur_5: null, notes: 0 })
  assert.deepEqual(E.noteSur5Des([{ ota: 'direct', overall_score: null }]), { note_sur_5: null, notes: 0 },
    'un avis sans note n est pas un avis a 0 / 5')
})

test('LE TEST QUI COMPTE : la table des echelles correspond a la MESURE', () => {
  // Se tromper d echelle divise ou double la note d un logement, et personne ne
  // le verra : 4,9 comme 9,8 ont l air d une note. Ce test fige ce qui a ete
  // mesure le 20 octobre 2026 — l ajout d une source sans mesure le fera rougir.
  assert.deepEqual(E.ECHELLE_PAR_CANAL, { airbnb: 10, booking: 10, expedia: 10, vrbo: 10, homeaway: 10 })
  assert.equal(E.ECHELLE_PAR_DEFAUT, 10)
})

test('un canal inconnu prend l echelle du coeur, il ne fait pas disparaitre ses notes', () => {
  assert.equal(E.echelleDe('un-canal-de-demain'), 10)
  assert.equal(E.echelleDe(null), 10)
  assert.equal(E.surCinq(9, 'un-canal-de-demain'), 4.5)
})

test('le nom du canal se lit sans se soucier de la casse ni des variantes', () => {
  assert.equal(E.echelleDe('Airbnb'), 10)
  assert.equal(E.echelleDe('booking.com'), 10)
  assert.equal(E.echelleDe('BOOKING'), 10)
})

// ═══════════════════════════════════════════════════════════════════════════
// Les constats de la revue de c9fa086
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE (M1) : un EX AEQUO a .x5 s arrondit pareil, quel que soit le NOMBRE d avis', () => {
  // Le defaut mesure : toutes les notes a 9,7 font une moyenne exacte de 4,85,
  // et l arrondi flottant rendait 4,9 a n=1, 4,8 a n=20, 4,9 a n=100, 4,8 a
  // n=332. Autrement dit UN AVIS DE PLUS, identique aux autres, faisait bouger
  // la note de 0,1. La bulle a 332 notes.
  const notes = (n) => Array.from({ length: n }, () => ({ ota: 'airbnb', overall_score: 9.7 }))
  const vus = new Set()
  for (const n of [1, 2, 3, 5, 10, 20, 33, 50, 99, 100, 200, 332, 400, 1000, 5000]) {
    vus.add(E.noteSur5Des(notes(n)).note_sur_5)
  }
  assert.deepEqual([...vus], [4.9], `quatre bascules pour la meme moyenne : ${[...vus].join(', ')}`)
})

test('M1 : la regle de demi est AU PLUS PROCHE, LE DEMI VERS LE HAUT, et elle est ecrite', () => {
  const une = (note) => E.noteSur5Des([{ ota: 'airbnb', overall_score: note }]).note_sur_5
  assert.equal(une(9.7), 4.9, '4,85 monte')
  assert.equal(une(9.5), 4.8, '4,75 monte')
  assert.equal(une(9.3), 4.7, '4,65 monte')
  assert.equal(une(9.1), 4.6, '4,55 monte')
  // Et juste en dessous d un demi, on descend.
  assert.equal(E.noteSur5Des([{ ota: 'airbnb', overall_score: 9.699 }]).note_sur_5, 4.8)
})

test('M1 : la somme reste exacte sur un gros volume — 5 000 avis ne derivent pas', () => {
  const l = [
    ...Array.from({ length: 2500 }, () => ({ ota: 'airbnb', overall_score: 10 })),
    ...Array.from({ length: 2500 }, () => ({ ota: 'booking', overall_score: 7.5 }))
  ]
  // (5,0 + 3,75) / 2 = 4,375 -> 4,4 (le demi monte)
  assert.equal(E.noteSur5Des(l).note_sur_5, 4.4)
})

test('LE TEST QUI COMPTE (M2) : une note HORS ECHELLE est ecartee, jamais affichee ni plafonnee', () => {
  // Une source sur 100 non mesuree rendait « 50,0 / 5 ». La plafonner a 5
  // serait pire : on affirmerait une note parfaite qu on ne connait pas.
  assert.equal(E.surCinq(50, 'une-source-sur-100'), null)
  const r = E.noteSur5Des([{ ota: 'airbnb', overall_score: 10 }, { ota: 'une-source-sur-100', overall_score: 50 }])
  assert.equal(r.note_sur_5, 5)
  assert.equal(r.notes, 1, 'la note hors echelle ne compte pas dans le diviseur')
})

test('LE TEST QUI COMPTE (M3) : la resolution par NOM fonctionne — eprouvee par une table injectee', () => {
  // Toutes les sources mesurees valent 10 : tant que c est le cas, aucun test
  // ne peut distinguer `echelleDe` d un `return 10`, et la mutation qui
  // supprime la boucle reste verte. Avec une table injectee, elle rougit.
  const table = { airbnb: 5, booking: 10 }
  assert.equal(E.echelleDe('airbnb', table), 5)
  assert.equal(E.echelleDe('booking.com', table), 10)
  assert.equal(E.echelleDe('inconnu', table), 10, 'le defaut reste celui du coeur')
  assert.equal(E.surCinq(5, 'airbnb', table), 5, '5 / 5 sur une source en /5')
  assert.equal(E.surCinq(5, 'booking', table), 2.5, '5 / 10 sur une source en /10')
  // Et l enonce de Thierry, dans SA lecture : Airbnb vraiment sur 5.
  const r = E.noteSur5Des([
    ...Array.from({ length: 10 }, () => ({ ota: 'airbnb', overall_score: 5 })),
    ...Array.from({ length: 10 }, () => ({ ota: 'booking', overall_score: 8 }))
  ], { table })
  assert.equal(r.note_sur_5, 4.5, 'meme resultat que sur les donnees reelles')
})

test('m2 : la cle du canal est celle que le WRITER ecrit, pas celle qu on aimerait', () => {
  // `normaliserOta` de lib/cron-channel-reviews.js ne connait que airbnb,
  // bookingcom et booking.com, et laisse passer le reste en minuscules :
  // « HomeAway » devient `homeaway`, jamais `vrbo`.
  const table = { vrbo: 5, homeaway: 7 }
  assert.equal(E.echelleDe('homeaway', table), 7, 'c est `homeaway` qui arrive en base')
  assert.ok(Object.prototype.hasOwnProperty.call(E.ECHELLE_PAR_CANAL, 'homeaway'),
    'la table doit porter la cle reellement ecrite')
})
