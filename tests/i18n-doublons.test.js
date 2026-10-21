const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const C = require('../scripts/i18n-check.js')
const I18N = path.join(__dirname, '..', 'shared', 'i18n')
const SCRIPT = path.join(__dirname, '..', 'scripts', 'i18n-check.js')

// ⚠ LE TEST QUI COMPTE. `JSON.parse` ne leve pas sur une cle declaree deux
// fois : il garde la derniere. Tout controle qui parse est donc aveugle au
// doublon, et c'est exactement ce que faisait i18n-check.js.
test('LE TEST QUI COMPTE : une cle declaree deux fois est REFUSEE', () => {
  const d = C.doublonsDuFichier('{\n  "a.un": "x",\n  "a.deux": "y",\n  "a.un": "z"\n}')
  assert.deepEqual(d, ['a.un'])
})

test('la demonstration du piege : JSON.parse, lui, ne dit rien', () => {
  const texte = '{"a.un":"x","a.un":"z"}'
  assert.deepEqual(JSON.parse(texte), { 'a.un': 'z' })   // ni erreur, ni trace
  assert.deepEqual(C.doublonsDuFichier(texte), ['a.un'])
})

test('un fichier sain ne declare aucun doublon', () => {
  assert.deepEqual(C.doublonsDuFichier('{"a":"1","b":"2","c":"3"}'), [])
})

test('une VALEUR qui ressemble a une cle n est pas comptee', () => {
  // des deux-points, des guillemets echappes et des accolades DANS la valeur
  const texte = '{\n  "a": "il a dit \\"b\\": non",\n  "b": "{\\"c\\": 1}",\n  "c": "10:30"\n}'
  assert.deepEqual(C.doublonsDuFichier(texte), [])
  assert.deepEqual(C.lireLesCles(texte).cles, ['a', 'b', 'c'])
})

test('un doublon IMBRIQUE est trouve, et nomme par son chemin', () => {
  const texte = '{\n  "bloc": { "x": 1, "x": 2 },\n  "autre": { "x": 3 }\n}'
  assert.deepEqual(C.doublonsDuFichier(texte), ['bloc.x'])
})

// ⚠ CONSTAT DE LA REVUE. Quand la valeur du doublon est un OBJET, le
// sous-arbre de la premiere occurrence est jete par `JSON.parse`. Un lecteur
// qui compare des totaux bruts se croit alors en desaccord avec lui et REFUSE
// le fichier pour « illisible » — le refus tombe quand meme, mais le
// diagnostic designe la mauvaise cause, sur la forme exacte que produit un
// conflit de merge : une cle de SECTION redite.
test('LE TEST QUI COMPTE : un doublon dont la valeur est un OBJET se nomme, et ne fait pas crier a l illisible', () => {
  assert.deepEqual(C.doublonsDuFichier('{"a":{"x":1},"a":{"y":2}}'), ['a'])
  assert.deepEqual(C.doublonsDuFichier('{"a":{"b":{"c":1}},"a":{"d":2}}'), ['a'])
  assert.deepEqual(C.doublonsDuFichier('{"a":[{"b":1}],"a":[]}'), ['a'])
  assert.deepEqual(C.doublonsDuFichier('{"l":[1,2,3],"l":[4]}'), ['l'])
})

// ⚠ ET C'EST POURQUOI LE SOUS-ARBRE JETE SE TROUVE PAR LA STRUCTURE, PAS PAR
// LE CHEMIN. Nos cles sont PLATES ET CONTIENNENT DES POINTS : `a.x` n'est pas
// un enfant de `a`. Un lecteur qui jetterait « tout ce qui commence par a. »
// emporterait `a.x`, et le compte retomberait juste par compensation — un vert
// obtenu par deux erreurs.
test('LE TEST QUI COMPTE : une cle a POINT voisine du doublon n est pas emportee', () => {
  assert.deepEqual(C.doublonsDuFichier('{"a":1,"a.x":2,"a":3}'), ['a'])
  const lu = C.lireLesCles('{"a":1,"a.x":2,"a":3}')
  assert.deepEqual(lu.cles, ['a', 'a.x', 'a'])
  assert.deepEqual(lu.retenues, ['a.x', 'a'])        // ce que JSON.parse garde
})

test('la meme cle dans DEUX objets differents n est pas un doublon', () => {
  assert.deepEqual(C.doublonsDuFichier('{"a":{"x":1},"b":{"x":2}}'), [])
})

test('une cle dont le texte contient un point n est pas coupee en chemin', () => {
  assert.deepEqual(C.lireLesCles('{"nav.today":"Aujourd hui"}').cles, ['nav.today'])
})

test('une cle a guillemet echappe est lue telle quelle', () => {
  const texte = '{"a\\"b":"1","a\\"b":"2"}'
  assert.deepEqual(C.doublonsDuFichier(texte), ['a"b'])
})

test('le fichier sur UNE SEULE LIGNE est lu comme les autres', () => {
  assert.deepEqual(C.doublonsDuFichier('{"a":"1","b":"2","a":"3"}'), ['a'])
})

// ⚠ UN LECTEUR QUI N A RIEN VU DOIT ECHOUER, PAS RENDRE « AUCUN DOUBLON ».
// C'est la lecon de feedback-verificateur-faux-vert : un verificateur qui rend
// vert parce qu'il n'a rien lu est pire qu'absent.
test('LE TEST QUI COMPTE : un lecteur qui compte moins que JSON.parse REFUSE', () => {
  const aveugle = () => ({ cles: [], doublons: [], retenues: [] })
  assert.throws(() => C.doublonsDuFichier('{"a":1,"b":2}', aveugle), /JSON\.parse en compte 2/)
  // et le vrai lecteur, sur le meme texte, ne refuse pas
  assert.deepEqual(C.doublonsDuFichier('{"a":1,"b":2}'), [])
})

test('un lecteur qui compte TROP refuse aussi', () => {
  const bavard = () => ({ cles: ['a', 'b', 'c'], doublons: [], retenues: ['a', 'b', 'c'] })
  assert.throws(() => C.doublonsDuFichier('{"a":1,"b":2}', bavard), /vu 3 clé/)
})

test('un lecteur qui ne rend pas `retenues` est refuse, pas pris pour vide', () => {
  assert.throws(() => C.doublonsDuFichier('{"a":1}', () => ({ cles: ['a'], doublons: [] })),
    /ne rend pas .retenues./)
})

test('compterLesCles descend dans les objets ET les tableaux', () => {
  assert.equal(C.compterLesCles({ a: 1, b: { c: 2 } }), 3)
  assert.equal(C.compterLesCles({ a: [{ b: 1 }, { c: 2 }] }), 3)
})

// ⚠ LE TEST QUI COMPTE : le refus doit arriver jusqu'au CODE DE SORTIE, sinon
// un commit passe quand meme. On eprouve le script entier sur un faux dossier.
test('LE TEST QUI COMPTE : le script SORT EN 1 sur un doublon', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  fs.writeFileSync(path.join(d, 'langues.json'), JSON.stringify([{ code: 'fr' }, { code: 'en' }]))
  fs.writeFileSync(path.join(d, 'fr.json'), '{"a":"1","b":"2"}')
  fs.writeFileSync(path.join(d, 'en.json'), '{\n "a": "1",\n "b": "2",\n "a": "3"\n}')
  assert.equal(C.controler(d), true)
  fs.writeFileSync(path.join(d, 'en.json'), '{"a":"1","b":"2"}')
  assert.equal(C.controler(d), false)
})

test('le script reel sort en 0 et rend compte des trois langues', () => {
  const sortie = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  for (const code of ['fr', 'en', 'es']) assert.match(sortie, new RegExp(`✓ ${code} :`))
})

// La reference elle-meme n'etait PAS controlee : l'ancien script faisait
// `if (code === 'fr') continue` avant toute lecture.
test('LE TEST QUI COMPTE : le francais est controle, lui aussi', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  fs.writeFileSync(path.join(d, 'langues.json'), JSON.stringify([{ code: 'fr' }, { code: 'en' }]))
  fs.writeFileSync(path.join(d, 'fr.json'), '{\n "a": "1",\n "a": "2"\n}')
  fs.writeFileSync(path.join(d, 'en.json'), '{"a":"1"}')
  assert.equal(C.controler(d), true)
})

test('LE TEST QUI COMPTE : aucun doublon dans les trois fichiers REELS', () => {
  for (const code of ['fr', 'en', 'es']) {
    const texte = fs.readFileSync(path.join(I18N, `${code}.json`), 'utf8')
    assert.deepEqual(C.doublonsDuFichier(texte), [], `${code}.json`)
    // non-vacuite : le lecteur a bien vu un fichier de traductions
    assert.ok(C.lireLesCles(texte).cles.length > 500, `${code}.json : trop peu de cles lues`)
  }
})

// ⚠ L'ANCIEN SCRIPT NE POUVAIT PAS ETRE EPROUVE : il n'exportait rien et
// appelait `process.exit` AU CHARGEMENT. Un `require` depuis un test tuait le
// processus, et `node --test` rendait alors « 1 test, 1 pass » sur le fichier
// entier — un vert sur rien du tout. La garde `require.main === module` est
// donc une condition de l'eprouvabilite, pas un detail de forme.
test('LE TEST QUI COMPTE : charger le script n EXECUTE PAS le controle', () => {
  const sortie = execFileSync(process.execPath,
    ['-e', `require(${JSON.stringify(SCRIPT)})`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(sortie, '', 'le simple chargement a imprime quelque chose')
})
