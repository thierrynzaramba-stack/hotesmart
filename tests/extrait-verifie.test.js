// tests/extrait-verifie.test.js
// Un extrait est montré à l'hôte comme une parole du voyageur, puis — une fois
// confirmé — à la prestataire de ménage. Ces tests délimitent ce qui peut passer
// pour une citation et ce qui ne le peut pas.

const test = require('node:test')
const assert = require('node:assert')
const { extraitVerifie } = require('../lib/extrait-verifie')

test('citation exacte : retenue', () => {
  assert.strictEqual(extraitVerifie('la cuvette est sale', 'la cuvette est sale'), 'la cuvette est sale')
})

test('écart d\'ESPACES seulement : retenu, et c\'est le texte D\'ORIGINE qui sort', () => {
  // Cas réel du rattrapage : le message contient des espaces doubles et des
  // retours ligne, le modèle rend des espaces simples. Quatre extraits légitimes
  // sur cinq étaient rejetés pour ce seul motif.
  const texte = 'le ménage a  pas été fait ,\nil y a de la poussière'
  const r = extraitVerifie(texte, 'le ménage a pas été fait , il y a de la poussière')
  assert.ok(r, 'un écart d\'espaces ne doit pas invalider la citation')
  assert.ok(texte.includes(r), 'ce qui sort doit venir MOT POUR MOT du texte d\'origine')
  assert.notStrictEqual(r, 'le ménage a pas été fait , il y a de la poussière')
})

test('CONCATÉNATION de passages non contigus : rejetée', () => {
  // Cas réel : le modèle a soudé « miettes sur la table » et « les lits
  // n'étaient pas faits », qui sont séparés dans le message.
  const texte = 'miettes sur la table de la cuisine. Tout le reste allait. Les lits n\'étaient pas faits.'
  assert.strictEqual(extraitVerifie(texte, 'miettes sur la table de la cuisine. Les lits n\'étaient pas faits.'), null)
})

test('REFORMULATION : rejetée', () => {
  assert.strictEqual(extraitVerifie('c\'était pas propre propre', 'le logement était mal entretenu'), null)
})

test('un mot ajouté ou retiré : rejeté', () => {
  // La souplesse porte sur les espaces, jamais sur les mots.
  assert.strictEqual(extraitVerifie('la cuvette est sale', 'la cuvette est très sale'), null)
  assert.strictEqual(extraitVerifie('la cuvette est sale', 'la cuvette sale'), null)
})

test('entrées vides ou non textuelles', () => {
  assert.strictEqual(extraitVerifie('abc', ''), null)
  assert.strictEqual(extraitVerifie('abc', null), null)
  assert.strictEqual(extraitVerifie('abc', { x: 1 }), null)
  assert.strictEqual(extraitVerifie('', 'abc'), null)
})

test('caractères spéciaux : pas d\'injection de motif', () => {
  // Un extrait contenant des métacaractères ne doit ni faire planter la
  // construction du motif, ni matcher n'importe quoi.
  assert.strictEqual(extraitVerifie('prix (2 nuits) 100€', '.*'), null)
  assert.strictEqual(extraitVerifie('prix (2 nuits) 100€', 'prix (2 nuits)'), 'prix (2 nuits)')
})

test('la casse est tolérée, mais le texte rendu garde sa casse d\'origine', () => {
  const r = extraitVerifie('La Cuvette est sale', 'la cuvette est sale')
  assert.strictEqual(r, 'La Cuvette est sale')
})
