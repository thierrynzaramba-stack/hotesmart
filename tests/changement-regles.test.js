// tests/changement-regles.test.js
// CE QU'ON DIT A L'HOTE QUAND ELLE CHANGE SES JOURS.
//
// ⚠ POURQUOI CE FICHIER EXISTE. Le 15 septembre 2026, la prestataire a reçu la
// main sur ses jours habituels depuis sa PWA. Cette décision ouvrait une dette :
// elle peut se retirer d'un jour sur lequel l'hôte compte, et rien ne l'en
// prévient. Le pendant obligatoire est testé ici — et c'est d'abord une
// question de MOTS : « règle #a4f2 désactivée » ne dit rien à personne.

const test = require('node:test')
const assert = require('node:assert')
const { resumerChangement, joursCouverts } = require('../lib/cleaning/changement-regles')

const r = (jours, cadence = 1) => ({ jours, cadence })

test('un jour PERDU se dit en clair, avec sa date', async () => {
  const out = resumerChangement({ avant: [r([1, 2, 6])], apres: [r([1, 2])],
                                  prenom: 'Lola', aPartirDe: '16 septembre 2026' })
  assert.strictEqual(out.texte, 'Lola ne travaille plus le samedi à partir du 16 septembre 2026.')
  assert.deepStrictEqual(out.perdus, [6])
})

test('plusieurs jours perdus se lisent comme une phrase, pas comme une liste', async () => {
  const out = resumerChangement({ avant: [r([1, 3, 6])], apres: [r([3])], prenom: 'Lola' })
  assert.match(out.texte, /ne travaille plus le lundi et le samedi/)
})

test('un jour GAGNÉ ne promet pas du travail', async () => {
  // ⚠ Deux filtres distincts décident : `weekdays` dit quels jours l'hôte lui
  // CONFIE un bien, la récurrence dit quels jours elle EST LÀ. Annoncer un
  // gain sans le dire ferait croire à l'hôte qu'elle est désormais candidate ce
  // jour-là — et à elle qu'elle aura du travail.
  const out = resumerChangement({ avant: [r([1])], apres: [r([1, 2])], prenom: 'Lola' })
  assert.match(out.texte, /disponible le mardi/)
  assert.match(out.texte, /ne lui confie aucun logement/)
})

test('la PERTE se dit AVANT le gain — c\'est elle qui demande un geste', async () => {
  const out = resumerChangement({ avant: [r([1, 6])], apres: [r([2])],
                                  prenom: 'Lola', aPartirDe: '16 septembre 2026' })
  assert.ok(out.texte.indexOf('ne travaille plus') < out.texte.indexOf('disponible'))
})

test('AUCUN changement réel : on se TAIT', async () => {
  // ⚠ L'écran renvoie tout le réglage à chaque geste : rouvrir l'onglet et
  // recocher le même jour produit une écriture sans changement. Alerter dessus
  // apprendrait à l'hôte à ignorer ces messages — et c'est celui-là qu'il ne
  // faut pas apprendre à ignorer.
  assert.strictEqual(resumerChangement({ avant: [r([1, 2])], apres: [r([2, 1])], prenom: 'L' }), null)
  assert.strictEqual(resumerChangement({ avant: [], apres: [], prenom: 'L' }), null)
})

test('la CADENCE seule qui bouge n\'annonce aucun jour perdu', async () => {
  // « Le samedi une semaine sur deux » devenu « le samedi toutes les semaines »
  // n'est pas une perte : l'hôte n'a rien à rattraper. L'annoncer comme un jour
  // perdu serait faux.
  const out = resumerChangement({ avant: [r([6], 2)], apres: [r([6], 1)], prenom: 'Lola' })
  assert.deepStrictEqual(out.perdus, [])
  assert.match(out.texte, /rythme/)
  assert.ok(!/ne travaille plus/.test(out.texte))
})

test('TOUT décocher se dit comme la perte de tous ses jours', async () => {
  // Le geste le plus lourd disponible dans sa PWA : zéro règle = disponible
  // tous les jours pour le moteur, et plus aucun jour habituel pour l'hôte.
  const out = resumerChangement({ avant: [r([1, 2, 3])], apres: [], prenom: 'Lola' })
  assert.deepStrictEqual(out.perdus, [1, 2, 3])
  assert.match(out.texte, /ne travaille plus le lundi, le mardi et le mercredi/)
})

test('une règle ILLISIBLE ne compte pour aucun jour', async () => {
  // `lireRrule` rend `jours: null` sur une récurrence qu'on ne sait pas relire.
  // La compter ferait dire n'importe quoi ; l'ignorer ne fait rien dire.
  assert.deepStrictEqual([...joursCouverts([{ jours: null }, r([1])])], [1])
})

test('sans prénom, la phrase reste correcte', async () => {
  const out = resumerChangement({ avant: [r([6])], apres: [], prenom: null })
  assert.match(out.texte, /^Votre prestataire ne travaille plus le samedi/)
})

test('les jours hors bornes sont ignorés, ils ne font pas tomber le résumé', async () => {
  const out = resumerChangement({ avant: [{ jours: [1, 9, -1] }], apres: [{ jours: [1] }], prenom: 'L' })
  assert.strictEqual(out, null, 'seul le jour 1 compte, des deux côtés')
})
