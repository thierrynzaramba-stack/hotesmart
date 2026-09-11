// tests/bien-neuf-nait-en-managed.test.js
//
// ⚠ LE PIEGE D'ONBOARDING QUE CE TEST FERME — 11 septembre 2026.
//
// Un logement cree dans HôteSmart naissait en `keep` : l'INSERT ne posait pas
// `rate_sync_mode`, donc le defaut de la base s'appliquait. L'hote n'avait
// jamais choisi ce mode, et l'ecran de creation ne le nomme nulle part — il
// n'apparait qu'APRES, sur la fiche du bien.
//
// LA DISPONIBILITE PART TOUJOURS (anti-surreservation, choix assume), LES
// TARIFS SEULEMENT EN `managed`. Les dates s'ouvraient donc a la vente au
// `base_price` du provisionnement pendant que la grille de l'hote restait dans
// le coeur, invisible des OTA.
//
// Mesure sur « Ofuro Futari » : 31 nuits vendables sur Airbnb a 199 € a plat —
// 14 sous-vendues (410 € de manque a gagner), 4 sur-vendues de 30 € pour le
// voyageur, et 13 sans aucun prix saisi au calendrier.
//
// ET `keep` N'A AUCUN SENS POUR UN BIEN CREE ICI. Constat de terrain de
// Thierry sur l'extranet Booking : des qu'un channel manager est lie, la
// plateforme REFUSE que l'hote edite ses tarifs (« modification obligatoire par
// le CM »). En `keep`, plus personne ne peut tarifer le logement — ni l'hote
// chez l'OTA, ni nous. Le prix du calendrier HôteSmart fait foi, toujours, des
// qu'un canal est actif.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const src = fs.readFileSync(path.join(__dirname, '..', 'api/channel-property.js'), 'utf8')

test('la creation d un bien pose rate_sync_mode = managed', () => {
  // L'INSERT est le seul endroit qui compte : laisser le defaut de la base
  // decider, c'est laisser un mode non choisi piloter le prix de vente.
  const i = src.indexOf("from('properties')\n        .insert({")
  assert.ok(i > 0, 'l INSERT de creation doit exister')
  const bloc = src.slice(i, i + 2600)
  assert.match(bloc, /rate_sync_mode: 'managed'/,
    "sans cette ligne le bien nait en `keep` et vend au base_price du provisionnement")
})

test('le mode pose est bien `managed`, pas `keep`', () => {
  const i = src.indexOf("from('properties')\n        .insert({")
  const bloc = src.slice(i, i + 2600)
  assert.ok(!/rate_sync_mode: 'keep'/.test(bloc),
    'un bien cree ici ne peut pas naitre dans un mode qui interdit de tarifer')
})

test('le prix de base reste exige a la creation', () => {
  // Il sert de prix plancher au rate plan provisionne ET il autorise
  // l'activation du canal (`lib/garde-activation.js`). Le passer a NULL par
  // defaut deplacerait le mur au lieu de l'enlever : aucun bien neuf ne
  // pourrait plus connecter d'OTA avant d'avoir une grille.
  assert.match(src, /Prix de base requis \(>0\)/,
    'la creation doit continuer d exiger un prix de base')
})

test('le parcours de MIGRATION garde le droit de poser `keep`', () => {
  // C'est son seul usage legitime : les prix vivent encore chez l'ancien
  // channel manager, le temps de la bascule.
  const mig = fs.readFileSync(path.join(__dirname, '..', 'lib/migration-mode-prix.js'), 'utf8')
  assert.match(mig, /const MODES = \['keep', 'managed'\]/,
    'l assistant de migration propose toujours les deux modes')
})
