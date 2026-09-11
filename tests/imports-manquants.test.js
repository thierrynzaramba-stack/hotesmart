// tests/imports-manquants.test.js
//
// ⚠ L'INCIDENT QUE CE TEST FERME — 10 au 11 septembre 2026, 24 h de panne
// TOTALE et SILENCIEUSE.
//
// Une garde `estCleMigree(...)` a ete posee en tete de `processMessageTemplates`
// SANS le `require` correspondant. `node -c` passe (la syntaxe est valide), les
// tests passaient (aucun n'appelait cette fonction), et en production chaque
// cycle levait un `ReferenceError: estCleMigree is not defined` — pour CHAQUE
// bien, des DEUX providers.
//
// L'erreur etait AVALEE par le `try/catch` par bien de `api/cron.js` et de
// `lib/cron-channel-props.js`. Le cron rendait donc HTTP 200 avec un rapport
// d'apparence normale, et sept lignes d'erreur que personne ne lisait.
//
// CE QUE CA A COUTE : plus aucun message automatique pendant 24 h ; et, parce
// que `processMessageTemplates` est le PREMIER appel du `try` de la boucle
// Channex, son throw emportait aussi `processChannelPropertyMessages`,
// `fetchChannelBookings` et `processArrivalCodes` — donc plus aucun code
// d'acces cree. Une voyageuse est arrivee devant une porte fermee.
//
// CE QUI EST DEFENDU ICI : qu'un fichier qui APPELLE une fonction exportee par
// un autre module de `lib/` l'IMPORTE. C'est un `no-undef` minimal et cible :
// le depot n'a pas d'eslint, et c'est precisement ce qu'un eslint aurait
// attrape en une seconde.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const RACINE = path.join(__dirname, '..')

// Les noms exportes par chaque module de lib/, lus dans le code (pas charges :
// charger un module cree des clients Supabase et des connexions).
function exportsDe (fichier) {
  const src = fs.readFileSync(fichier, 'utf8')
  const noms = new Set()
  // `module.exports = { a, b, c }` et `module.exports.x = ...`
  const bloc = src.match(/module\.exports\s*=\s*\{([^}]*)\}/s)
  if (bloc) {
    for (const brut of bloc[1].split(',')) {
      const m = brut.trim().match(/^([A-Za-z_$][\w$]*)\s*(?::|$)/)
      if (m) noms.add(m[1])
    }
  }
  for (const m of src.matchAll(/module\.exports\.([A-Za-z_$][\w$]*)\s*=/g)) noms.add(m[1])
  return noms
}

function fichiersJs (dossier) {
  return fs.readdirSync(dossier)
    .filter(f => f.endsWith('.js'))
    .map(f => path.join(dossier, f))
}

test('tout identifiant appele et exporte par un module de lib/ est importe', () => {
  const libDir = path.join(RACINE, 'lib')
  // Table : nom exporte -> modules qui l'exportent.
  const proprietaire = new Map()
  for (const f of fichiersJs(libDir)) {
    const base = path.basename(f, '.js')
    for (const nom of exportsDe(f)) {
      if (!proprietaire.has(nom)) proprietaire.set(nom, new Set())
      proprietaire.get(nom).add(base)
    }
  }

  const aExaminer = [...fichiersJs(libDir), ...fichiersJs(path.join(RACINE, 'api'))]
  const manquants = []

  for (const f of aExaminer) {
    const base = path.basename(f, '.js')
    const src = fs.readFileSync(f, 'utf8')
    // Sans les commentaires ni les chaines : un nom cite dans un commentaire
    // (ils sont nombreux et detailles ici) n'est pas un appel.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
      .replace(/'(?:\\.|[^'\\])*'/g, "''")
      .replace(/"(?:\\.|[^"\\])*"/g, '""')

    for (const [nom, proprios] of proprietaire) {
      if (proprios.has(base)) continue                    // c'est lui qui l'exporte
      // appele comme fonction, et pas en tant que methode (`x.nom(`)
      const appel = new RegExp(`(^|[^\\w$.])${nom}\\s*\\(`, 'm')
      if (!appel.test(code)) continue
      // declare localement (fonction, const, let, var, parametre destructure) ?
      const declare = new RegExp(
        `(function\\s+${nom}\\b)|((?:const|let|var)\\s+${nom}\\b)|([{,]\\s*${nom}\\s*[,}=:])`, 'm')
      if (declare.test(code)) continue
      manquants.push(`${path.relative(RACINE, f)} appelle ${nom}() `
        + `sans l'importer (exporte par lib/${[...proprios].join(', lib/')})`)
    }
  }

  assert.deepStrictEqual(manquants, [],
    'identifiant(s) appele(s) sans import — ReferenceError garanti a l\'execution :\n  '
    + manquants.join('\n  '))
})
