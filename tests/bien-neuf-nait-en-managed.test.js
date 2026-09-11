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

// ═══════════════════════════════════════════════════════════════════════════
// `keep` EST RESTREINT ET RENOMME
// ═══════════════════════════════════════════════════════════════════════════
// ⚠ Le libelle « Je garde mes prix », etiquete « recommande pour demarrer »,
// promettait quelque chose que l'OTA interdit : des qu'un channel manager est
// lie, l'extranet refuse que l'hote edite ses tarifs. Le mode ne decrit pas une
// preference, mais un ETAT TRANSITOIRE de la bascule.

test('poser `keep` sur un bien a canal ACTIF est refuse, et explique pourquoi', () => {
  const i = src.indexOf("if (rate_sync_mode !== undefined)")
  assert.ok(i > 0)
  const bloc = src.slice(i, i + 2400)
  assert.match(bloc, /if \(rate_sync_mode === 'keep'\)/, 'le refus ne vise QUE `keep`')
  assert.match(bloc, /canauxActifsDuBien\(prop\)/)
  assert.match(bloc, /Votre bien est connecté à une plateforme/,
    "un refus muet renverrait l'hote a l'ecran sans qu'il comprenne")
  assert.match(bloc, /HôteSmart qui les envoie/,
    "le refus doit dire QUI tarife desormais, pas seulement que c'est refuse")
  assert.match(bloc, /res\.status\(409\)/)
})

test('une lecture des canaux en echec ne vaut PAS « aucun canal »', () => {
  // Sinon le refus serait contournable par une simple panne reseau — et il
  // existe precisement pour empecher un logement de se retrouver sans personne
  // pour le tarifer.
  const i = src.indexOf("if (rate_sync_mode !== undefined)")
  const bloc = src.slice(i, i + 2400)
  assert.match(bloc, /canauxActifs === null/)
  assert.match(bloc, /res\.status\(502\)/)
  const f = src.indexOf('async function canauxActifsDuBien')
  assert.ok(f > 0)
  assert.match(src.slice(f, f + 900), /if \(!r \|\| !r\.ok\) return null/)
  assert.match(src.slice(f, f + 900), /catch \(e\) \{[\s\S]*?return null/)
})

test('la garde lit `migration_target_property_id`, donc elle le SELECTIONNE', () => {
  // Une garde qui juge sur une colonne non selectionnee est une garde ouverte.
  // Un bien en cours de bascule porte ses canaux sous sa cle CIBLE.
  const f = src.indexOf('async function canauxActifsDuBien')
  assert.match(src.slice(f, f + 400), /migration_target_property_id/)
  const i = src.indexOf("// ===== PATCH : modification d'un bien =====")
  assert.match(src.slice(i, i + 2200), /\.select\('id, provider, provider_property_id, migration_target_property_id/)
})

test('le libelle dit ce qui EST, et nomme la consequence', () => {
  const mig = fs.readFileSync(path.join(__dirname, '..', 'lib/migration-mode-prix.js'), 'utf8')
  assert.match(mig, /keep: 'Prix encore gérés par votre ancien channel manager'/)
  assert.ok(!/Je garde mes prix/.test(mig), "l'ancien libelle promettait l'impossible")
  assert.match(mig, /CONSEQUENCE/, 'la consequence accompagne le libelle')
  assert.match(mig, /HôteSmart n..enverra aucun prix tant que ce mode est actif/,
    'la consequence doit etre ecrite, pas sous-entendue')
})

test("l ecran ne recommande plus `keep` pour demarrer", () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'pages/biens.html'), 'utf8')
  assert.ok(!/Je garde mes prix/.test(page), 'plus nulle part dans l ecran')
  assert.ok(!/recommandé pour démarrer/.test(page),
    "c'etait l'etiquette exacte du piege : le mode qui n'envoie aucun prix etait recommande")
  assert.match(page, /Prix encore gérés par votre ancien channel manager/)
  assert.match(page, /HôteSmart n'enverra aucun prix tant que ce mode est actif/)
  assert.match(page, /Aucun prix envoyé \(ancien channel manager\)/,
    'la fiche du bien doit dire l etat, pas un choix')
})
