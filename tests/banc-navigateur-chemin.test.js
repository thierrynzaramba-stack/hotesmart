// tests/banc-navigateur-chemin.test.js
//
// LE NAVIGATEUR DE BANC SE TROUVE, SUR LE PC DE THIERRY COMME DANS LE CLOUD
// (5 novembre 2026, passage des sessions dans le cloud, decision de Thierry).
//
// Avant : le chemin `/home/thierry/.cache/ms-playwright/...` etait ecrit en dur
// dans trois fichiers, et dans le cloud les 14 tests de banc rendaient tous
// « navigateur de banc absent » — la suite n'y etait jamais a zero, donc la
// regle « un seul rouge = on s'arrete » n'y disait plus rien. La preuve de
// COMPORTEMENT est la suite elle-meme : ces 14 tests passent du rouge au vert
// dans le cloud, sans changer sur le PC.
//
// Ce fichier tient les trois invariants qu'un renommage pourrait casser en
// silence :
//   1. l'ordre des emplacements, et la revision EPINGLEE (un autre Chrome peut
//      calculer un autre rendu : on cherche le MEME binaire, pas « un Chrome ») ;
//   2. sans navigateur, le banc ne se tait pas : il rend un chemin absent et
//      un message qui dit ou il a cherche ;
//   3. il n'existe qu'UNE copie du chemin dans tests/.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const nav = require('./outils/navigateur.js')

const BINAIRE = path.join('chrome-headless-shell-linux64', 'chrome-headless-shell')

test('les emplacements essayes : PLAYWRIGHT_BROWSERS_PATH d abord, puis le cache de l utilisateur', () => {
  assert.equal(nav.REVISION, 'chromium_headless_shell-1243', 'la revision du banc est epinglee')
  assert.deepEqual(nav.cheminsCandidats({ PLAYWRIGHT_BROWSERS_PATH: '/opt/pw-browsers' }, '/home/claude'), [
    path.join('/opt/pw-browsers', nav.REVISION, BINAIRE),
    path.join('/home/claude/.cache/ms-playwright', nav.REVISION, BINAIRE)
  ])
  // Le PC de Thierry : pas de variable, le cache par defaut — le chemin d'avant.
  assert.deepEqual(nav.cheminsCandidats({}, '/home/thierry'), [
    '/home/thierry/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell'
  ])
  // Une valeur relative de la variable (convention Playwright `0`) est ignoree.
  assert.deepEqual(nav.cheminsCandidats({ PLAYWRIGHT_BROWSERS_PATH: '0' }, '/home/thierry'),
    nav.cheminsCandidats({}, '/home/thierry'))
})

test('LE TEST QUI COMPTE : le premier emplacement PRESENT gagne, et seulement lui', () => {
  const env = { PLAYWRIGHT_BROWSERS_PATH: '/opt/pw-browsers' }
  // Ecrits EN DUR (constat de review) : tires de `cheminsCandidats`, ils
  // suivraient une inversion de l'ordre au lieu de la voir.
  const cloud = '/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell'
  const cache = '/home/x/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell'
  assert.equal(nav.resoudreChrome(env, '/home/x', f => f === cache), cache, 'seul le cache existe')
  assert.equal(nav.resoudreChrome(env, '/home/x', f => f === cloud), cloud, 'seul le cloud existe')
  assert.equal(nav.resoudreChrome(env, '/home/x', () => true), cloud, 'les deux : ordre de la liste')
})

test('sans navigateur : on rend le premier chemin essaye, et le message dit ou on a cherche', () => {
  // Le « ne se tait pas » lui-meme est tenu par le test suivant, qui rougit
  // dans tout environnement ou le navigateur de banc manque.
  const env = { PLAYWRIGHT_BROWSERS_PATH: '/nulle/part' }
  const r = nav.resoudreChrome(env, '/nulle/maison', () => false)
  assert.equal(r, nav.cheminsCandidats(env, '/nulle/maison')[0], 'on rend le premier essaye, pour le message')
  const m = nav.messageAbsent('a mesurer X')
  assert.match(m, /le navigateur de banc est absent/)
  assert.match(m, /ne peut pas se taire/)
  for (const c of nav.cheminsCandidats()) assert.ok(m.includes(c), `le message doit citer ${c}`)
})

test('dans CET environnement, le navigateur de banc est trouve', () => {
  // Sur le PC de Thierry comme dans le cloud : un banc absent est un rouge,
  // jamais un saut. Ce test le dit en premier, avec la liste essayee.
  assert.ok(nav.navigateurPresent(), nav.messageAbsent('a dire ou est le navigateur de banc'))
  assert.ok(fs.statSync(nav.CHROME).isFile())
})

test('LD_LIBRARY_PATH : pose quand les bibliotheques du PC existent, intact sinon', () => {
  const env = { LD_LIBRARY_PATH: '/a/moi', AUTRE: '1' }
  // ⚠ LES DOUBLES REGARDENT LE CHEMIN QU'ON LEUR PASSE (constat de review du
  // 5 novembre 2026) : `() => true` / `() => false` laissaient verte la
  // mutation `existe(CHROME)` au lieu de `existe(libs)`, qui poserait dans le
  // cloud un LD_LIBRARY_PATH vers un dossier absent.
  const avec = nav.envNavigateur(env, f => f === '/libs', '/libs')
  assert.equal(avec.LD_LIBRARY_PATH, '/libs', 'le PC de Thierry : comme avant, le dossier de bibliotheques')
  assert.equal(avec.AUTRE, '1')
  const sans = nav.envNavigateur(env, f => f !== '/libs', '/libs')
  assert.equal(sans.LD_LIBRARY_PATH, '/a/moi', 'le cloud : l environnement herite, intact')
  assert.notEqual(sans, env, 'une copie, jamais l objet process.env lui-meme')
})

test('une seule copie du chemin du navigateur dans tests/', () => {
  // ⚠ MOTIF TEXTUEL, EN DERNIER RECOURS (REVIEW.md regle 20) : ce qu'on interdit
  // EST une copie de texte. Il voit le dossier `ms-playwright` et la revision
  // ecrits ailleurs que dans l'outil ; il ne voit PAS un chemin reconstruit
  // morceau par morceau sous d'autres noms.
  // ⚠ ET LE RETRAIT DES COMMENTAIRES IGNORE LES CHAINES (constat de review du
  // 5 novembre 2026), deux limites connues : une chaine comme 'api/*' suivie
  // plus loin d'un '*/' efface tout le texte entre les deux, donc une copie qui
  // s'y trouverait ; et un commentaire `//` en FIN de ligne n'est pas retire,
  // donc un `// ms-playwright` apres du code fait rougir sur un simple
  // commentaire.
  const MOTIF = /ms-playwright|chromium_headless_shell-\d+/
  const fichiers = []
  const parcourir = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) parcourir(p)
      else if (e.name.endsWith('.js')) fichiers.push(p)
    }
  }
  parcourir(__dirname)
  assert.ok(fichiers.length > 100, 'le balayage doit avoir des fichiers a examiner')
  const sansCommentaires = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
  const copies = fichiers
    .filter(f => MOTIF.test(sansCommentaires(fs.readFileSync(f, 'utf8'))))
    .map(f => path.relative(path.join(__dirname, '..'), f))
    .filter(f => f !== path.join('tests', 'outils', 'navigateur.js') && f !== path.join('tests', 'banc-navigateur-chemin.test.js'))
  assert.deepEqual(copies, [], 'le chemin du navigateur de banc vit dans tests/outils/navigateur.js, et nulle part ailleurs')
  // Contre-epreuve : le motif reconnait bien l'ancienne ecriture en dur.
  assert.match("const CHROME = '/home/thierry/.cache/ms-playwright/chromium_headless_shell-1243'", MOTIF)
})
