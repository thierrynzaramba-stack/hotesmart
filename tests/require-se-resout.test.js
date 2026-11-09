// tests/require-se-resout.test.js — chaque `require` relatif existe-t-il ?
//
// ⚠ POURQUOI CE TEST EXISTE, ET IL VIENT D'UN DEFAUT DU 27 OCTOBRE 2026.
// `api/ecran/revenus-annee.js` importait `../../lib/contexte-ecran` et
// `../../lib/uuid` — deux fichiers qui n'existent pas. Les deux noms vivent
// dans `lib/require-permission.js`. Le fichier passait `node -c` sans broncher :
// il verifie la SYNTAXE, jamais la RESOLUTION. Le defaut ne serait sorti qu'au
// premier appel reel de l'endpoint, en production, sur un clic d'hote.
//
// C'est la huitieme forme de la meme famille dans ce depot : un instrument qui
// repond « oui » sans avoir regarde ce qu'on croyait lui demander.
// (Suggere par la session chef de file, qui a nomme la classe.)
//
// ⚠ CE QU'IL NE COUVRE PAS, ET IL FAUT LE DIRE : il resout le CHEMIN, pas les
// NOMS exportes. Un `require('../lib/vrai-module')` qui en tire un nom
// inexistant passe ici — le verifier demanderait de CHARGER chaque module, donc
// d'executer leurs effets de bord (clients Supabase, lecture d'env). Le prix
// serait une suite qui depend de l'environnement ; on s'arrete donc au chemin.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { sansCommentaires, fichiersJs } = require('./outils/source')

const racine = path.join(__dirname, '..')

// Seuls les chemins RELATIFS sont verifies : un paquet absent de `node_modules`
// casse a l'installation, bruyamment, pas en silence a l'execution.
const RELATIF = /\brequire\(\s*(['"])(\.[^'"]*)\1\s*\)/g

// ⚠ ON ECARTE LES `require` IMBRIQUES DANS UNE CHAINE, pas les chaines
// elles-memes : le chemin cherche EST dans une chaine. Deux fichiers du depot
// citent un `require` a l'interieur d'une assertion — `tests/price-log.test.js`
// verifie qu'un AUTRE fichier l'importe, et le temoin plus bas porte le chemin
// fautif du 27 octobre. Dans les deux cas la chaine est la PREUVE, pas le
// defaut.
//
// ⚠ ET LE JUGEMENT EST LIGNE PAR LIGNE, APRES UNE PREMIERE VERSION FAUSSE. Elle
// calculait les bornes des chaines sur le FICHIER entier : un litteral
// d'expression reguliere contenant des guillemets — comme `RELATIF` juste
// au-dessus — ouvrait une chaine fantome, et tout ce qui suivait etait mal
// juge. Distinguer une expression reguliere d'une division demande un
// analyseur. Sur une LIGNE, le compte des guillemets qui precedent suffit, et
// une desynchronisation ne peut pas se propager au reste du fichier.
const GUILLEMETS = /(?<!\\)["'`]/g

function requisRelatifs (src) {
  const out = []
  for (const ligne of sansCommentaires(src).split('\n')) {
    const re = new RegExp(RELATIF.source, 'g')
    let m
    while ((m = re.exec(ligne)) !== null) {
      const avant = ligne.slice(0, m.index).match(GUILLEMETS) || []
      // Un nombre IMPAIR de guillemets avant l'occurrence : elle est dedans.
      if (avant.length % 2 === 1) continue
      out.push(m[2])
    }
  }
  return out
}

test("LE TEST QUI COMPTE : chaque `require` relatif se resout", () => {
  const fichiers = []
  for (const d of ['api', 'lib', 'scripts', 'tests']) {
    const abs = path.join(racine, d)
    if (fs.existsSync(abs)) fichiers.push(...fichiersJs(abs, d))
  }
  // ⚠ UN RECENSEMENT QUI N'A RIEN LU DOIT ECHOUER : zero fichier rend zero
  // constat, donc un vert.
  assert.ok(fichiers.length > 50, `${fichiers.length} fichier(s) balaye(s)`)

  const casses = []
  let vus = 0
  for (const f of fichiers) {
    const abs = path.join(racine, f)
    const src = fs.readFileSync(abs, 'utf8')
    for (const chemin of requisRelatifs(src)) {
      vus++
      try {
        require.resolve(path.resolve(path.dirname(abs), chemin))
      } catch (e) {
        casses.push(`${f} : require('${chemin}') ne se resout pas`)
      }
    }
  }
  assert.ok(vus > 100, `${vus} require(s) relatif(s) repere(s) : le decoupage ne les voit plus`)
  assert.deepEqual(casses, [],
    'ces `require` designent un fichier qui n existe pas. `node -c` ne le dit pas :\n'
    + 'il verifie la syntaxe, jamais la resolution. Le defaut sortira au premier\n'
    + 'appel reel, en production.\n' + casses.join('\n'))
})

test('LE TEMOIN : le recensement attrape un chemin inexistant', () => {
  // Sans lui, un decoupage casse rendrait zero constat et passerait pour un vert.
  // ⚠ LE TEMOIN PORTE LE CHEMIN NU, pas une ligne qui le cite : une citation
  // est justement ce que le recensement doit ECARTER, et le temoin ci-dessous
  // s'en assure separement.
  assert.deepEqual(requisRelatifs("const { x } = require('../../lib/contexte-ecran')"),
    ['../../lib/contexte-ecran'], 'le decoupage ne voit pas un require relatif')
  assert.deepEqual(requisRelatifs('assert.ok(s.includes("require(\'./price-log\')"))'), [],
    'un require CITE dans une chaine est compte comme un import')
  let leve = false
  try { require.resolve(path.resolve(path.join(racine, 'api', 'ecran'), '../../lib/contexte-ecran')) }
  catch (e) { leve = true }
  assert.ok(leve, 'le chemin fautif du 27 octobre 2026 se resout : ce test ne prouve plus rien')

  // Et un chemin JUSTE ne doit pas l'alarmer.
  assert.doesNotThrow(
    () => require.resolve(path.resolve(path.join(racine, 'api', 'ecran'), '../../lib/require-permission')),
    'le chemin correct est signale : le recensement crie a tort')

  // ⚠ LES FORMES QUI NE SONT PAS DES CHEMINS LITTERAUX SONT IGNOREES, et c'est
  // voulu : `require(variable)` ne se resout pas a la lecture, et pretendre le
  // contraire ferait un faux positif que personne ne pourrait corriger.
  assert.deepEqual(requisRelatifs("require(chemin)\nrequire('@supabase/supabase-js')"), [],
    'une forme non litterale ou un paquet est comptee comme un chemin relatif')
})
