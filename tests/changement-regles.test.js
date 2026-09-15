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
  // Et sept jours cochés équivalent à aucune règle : même couverture, rien à dire.
  assert.strictEqual(
    resumerChangement({ avant: [], apres: [r([0, 1, 2, 3, 4, 5, 6])], prenom: 'L' }), null)
})

test('la CADENCE dit son SENS — les deux ne coûtent pas la même chose', async () => {
  // ⚠ La première version rendait le MÊME texte dans les deux sens. Or passer à
  // « une semaine sur deux » SUPPRIME la moitié de ses venues, et l'inverse les
  // double : l'hôte ne pouvait pas savoir lequel venait de se produire.
  const moins = resumerChangement({ avant: [r([6], 1)], apres: [r([6], 2)], prenom: 'Lola' })
  assert.match(moins.texte, /ne vient plus qu'une semaine sur 2/)
  assert.strictEqual(moins.cadenceReduite, true)

  const plus = resumerChangement({ avant: [r([6], 2)], apres: [r([6], 1)], prenom: 'Lola' })
  assert.match(plus.texte, /désormais toutes les semaines/)
  assert.ok(!plus.cadenceReduite)

  // Ni l'un ni l'autre n'annonce un jour perdu : les jours sont les mêmes.
  assert.deepStrictEqual(moins.perdus, [])
  assert.deepStrictEqual(plus.perdus, [])
})

test('AUCUNE RÈGLE VEUT DIRE « TOUS LES JOURS », et le message le dit dans ce sens', async () => {
  // ⚠ LE DÉFAUT QUE LA REVIEW A TROUVÉ, ET IL INVERSAIT LE SENS SUR LES DEUX
  // GESTES LES PLUS FRÉQUENTS. `estDisponible` rend `true` quand aucune règle
  // n'est active (étage 4 de la précédence), et la PWA le dit elle-même à la
  // prestataire. Compter un lot vide comme l'ensemble VIDE faisait lire à l'hôte
  // exactement l'inverse de ce qui venait de se passer.

  // 1. PREMIER RÉGLAGE — le parcours nominal, puisque aucune prestataire n'a de
  //    règle en production. Elle passe de « disponible 7/7 » à « le samedi » :
  //    c'est une perte de six jours, pas un gain d'un jour.
  const premier = resumerChangement({ avant: [], apres: [r([6])], prenom: 'Lola' })
  assert.deepStrictEqual(premier.perdus, [0, 1, 2, 3, 4, 5],
    'six jours perdus — et donc six jours de ménages proposés à reprendre')
  assert.match(premier.texte, /ne travaille plus/)

  // 2. TOUT DÉCOCHER — elle redevient disponible tous les jours.
  const vide = resumerChangement({ avant: [r([1, 2, 3])], apres: [], prenom: 'Lola' })
  assert.deepStrictEqual(vide.perdus, [], 'aucune perte : elle s\'ouvre, elle ne se ferme pas')
  assert.match(vide.texte, /disponible/)
})

test('des règles ILLISIBLES ne sont pas « aucune règle »', async () => {
  // ⚠ `regleCouvre` rend `null` sur une récurrence qu'on ne sait pas relire : le
  // moteur la compte et ne la fait couvrir presque rien. L'ensemble vide est
  // alors JUSTE — on distingue l'absence de LIGNE de l'absence de jour lisible.
  const out = resumerChangement({ avant: [{ jours: null }], apres: [r([1])], prenom: 'Lola' })
  assert.deepStrictEqual(out.perdus, [], 'elle ne couvrait rien de lisible')
  assert.deepStrictEqual(out.gagnes, [1])
})

test('une règle ILLISIBLE ne compte pour aucun jour', async () => {
  // `lireRrule` rend `jours: null` sur une récurrence qu'on ne sait pas relire.
  // La compter ferait dire n'importe quoi ; l'ignorer ne fait rien dire.
  assert.deepStrictEqual([...joursCouverts([{ jours: null }, r([1])])], [1])
})

test('sans prénom, la phrase reste correcte', async () => {
  const out = resumerChangement({ avant: [r([1, 6])], apres: [r([1])], prenom: null })
  assert.match(out.texte, /^Votre prestataire ne travaille plus le samedi/)
})

test('les jours hors bornes sont ignorés, ils ne font pas tomber le résumé', async () => {
  const out = resumerChangement({ avant: [{ jours: [1, 9, -1] }], apres: [{ jours: [1] }], prenom: 'L' })
  assert.strictEqual(out, null, 'seul le jour 1 compte, des deux côtés')
})
