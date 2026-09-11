// tests/canon-statuts-non-recopie.test.js
// LE DEFAUT : un audit a declare « hors canon » 5 lignes parfaitement valides,
// parce qu'il portait sa propre copie de la liste des statuts.
//
// REVIEW.md regle 13 : une mesure qui DISQUALIFIE de la donnee se verifie deux
// fois — se tromper en jetant est silencieux. Le corollaire est testable : une
// liste de reference s'importe de sa source, elle ne se recopie pas.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const lire = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

const { ALL_STATUSES, STATUS } = require('../lib/bookings-snapshot-status')

test('le canon porte bien `demapped`, et il n est pas une annulation', () => {
  // ⚠ C'EST LE POINT QUI A ETE PERDU DE VUE.
  // `demapped` est entre au canon le 10 septembre 2026 a la demande explicite
  // de Thierry : melanger « le voyageur s'est decommande » et « nous avons
  // debranche ce logement d'un OTA » fausserait le taux d'annulation pour
  // toujours. Un mois plus tard, un audit le declarait « hors canon ».
  assert.ok(ALL_STATUSES.includes('demapped'), 'demapped est canonique')
  assert.equal(STATUS.DEMAPPED, 'demapped')
  assert.notEqual(STATUS.DEMAPPED, STATUS.CANCELLED,
    'et il reste distinct de cancelled : les stats d annulation comptent cancelled SEUL')
})

test('LE TEST QUI COMPTE : personne ne recopie le canon, tout le monde l importe', () => {
  // Une liste recopiee se perime en silence — puis c'est la DONNEE qu'on
  // accuse. On interdit donc l'enumeration en dur partout ou elle servirait a
  // juger une ligne.
  const COPIE = /['"]confirmed['"]\s*,\s*['"]cancelled['"]\s*,\s*['"]blocked['"]\s*,\s*['"]request['"]/

  const fichiers = [
    'scripts/audit-prix-voyageur.js',
    'lib/bookings-snapshot.js',
    'lib/booking-changes.js'
  ]
  for (const f of fichiers) {
    if (!fs.existsSync(path.join(__dirname, '..', f))) continue
    assert.ok(!COPIE.test(lire(f)),
      `${f} recopie le canon au lieu de l importer de bookings-snapshot-status`)
  }

  // Et l'audit, qui est celui qui s'est trompe, doit le lire explicitement.
  const audit = lire('scripts/audit-prix-voyageur.js')
  assert.ok(audit.includes("require('../lib/bookings-snapshot-status')"),
    'l audit importe la source de verite')
  assert.ok(/ALL_STATUSES\.includes/.test(audit),
    'et juge « hors canon » avec elle, jamais avec une liste locale')
})

test('le commentaire du writer ne paraphrase plus la liste', () => {
  // Un commentaire qui enumere le canon EST une copie : c'est celui-la qui a
  // egare l'audit. Il doit renvoyer vers la source, pas la reciter.
  const src = lire('lib/bookings-snapshot.js')
  assert.ok(src.includes('bookings-snapshot-status.js (ALL_STATUSES)'),
    'le writer renvoie vers la source de verite du canon')
})
