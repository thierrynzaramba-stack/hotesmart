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

// ⚠ RECURSIF, ET LE PARCOURS EST PARTAGE (`tests/outils/source.js`).
// `api/ecran/` est le premier sous-repertoire de `api/`, et un fichier non
// examine par ce test est un `require` manquant qui ne se voit qu'en
// production, au premier appel.
const { fichiersJs } = require('./outils/source')

test('tout identifiant appele et exporte par un module de lib/ est importe', () => {
  const libDir = path.join(RACINE, 'lib')
  // Table : nom exporte -> modules qui l'exportent.
  const proprietaire = new Map()
  // ⚠ LA CLE EST LE CHEMIN, PAS LE NOM DE FICHIER. En rendant le balayage
  // recursif, deux modules ont pris le meme nom de base : `lib/logement/lecture.js`
  // et `lib/taxe-sejour/lecture.js`. Avec une cle par BASENAME, chacun passait
  // pour « celui qui exporte » les noms de l'autre (`proprios.has(base)`), donc
  // un import manquant entre eux etait invisible — la seule collision
  // aujourd'hui, mais elle se multipliera a chaque sous-repertoire.
  for (const f of fichiersJs(libDir)) {
    const cle = path.relative(RACINE, f).replace(/\.js$/, '').split(path.sep).join('/')
    for (const nom of exportsDe(f)) {
      if (!proprietaire.has(nom)) proprietaire.set(nom, new Set())
      proprietaire.get(nom).add(cle)
    }
  }

  const aExaminer = [...fichiersJs(libDir), ...fichiersJs(path.join(RACINE, 'api'))]
  const manquants = []

  for (const f of aExaminer) {
    const base = path.relative(RACINE, f).replace(/\.js$/, '').split(path.sep).join('/')
    const src = fs.readFileSync(f, 'utf8')
    // Sans les commentaires ni les chaines : un nom cite dans un commentaire
    // (ils sont nombreux et detailles ici) n'est pas un appel.
    //
    // ⚠ LIMITE CONNUE : CE NETTOYEUR NE COMPREND PAS LES REGEX LITTERALES.
    // Une apostrophe dans une regex — `.replace(/'/g, '&#39;')`, tout a fait
    // legitime — ouvre une chaine aux yeux de la passe ci-dessous, qui avale
    // alors tout le code jusqu'a l'apostrophe suivante. Les declarations qui s'y
    // trouvaient disparaissent, et le test les signale comme « appelees sans
    // import ».
    //
    // Constate le 17 septembre 2026 sur `lib/email-voyageur.js` : sa fonction
    // locale `enveloppe()` etait invisible, et le test l'a confondue avec celle
    // que `lib/email-guestflow.js` exporte. Diagnostic : une demi-heure, pour un
    // faux positif.
    //
    // On ne corrige pas le nettoyeur — reconnaitre une regex litterale en regex
    // demande de savoir si un `/` divise ou ouvre un motif, ce qui suppose un
    // vrai analyseur. En cas de nouveau signalement, VERIFIER D'ABORD qu'il n'y
    // a pas une apostrophe de regex en amont dans le fichier.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
      .replace(/'(?:\\.|[^'\\])*'/g, "''")
      .replace(/"(?:\\.|[^"\\])*"/g, '""')

    // ⚠ LES NOMS IMPORTES SE LISENT SUR LA SOURCE SANS LES COMMENTAIRES, PAS
    // SUR LA SOURCE NETTOYEE DES CHAINES — ET C'EST LE CORRECTIF DE LA LIMITE
    // DECRITE CI-DESSUS. Le nettoyeur de chaines avale le code qui suit une
    // apostrophe de regex ; quand il emporte une LIGNE DE `require`, le test
    // signale comme « appele sans import » un nom parfaitement importe.
    // Mesure du 23 octobre 2026, en rendant le balayage recursif :
    // `lib/airroi/client.js` importe `tarif`, `jugerAppel` et `lireJson` a ses
    // lignes 42-43, et ces deux lignes avaient DISPARU de `code`. Idem pour
    // `api/avis.js`, dont `lireAvis` et `publierAvisVoyageur` sont des
    // METHODES d'objet.
    // ⚠ ET SUR LA SOURCE BRUTE, LIGNE PAR LIGNE — PAS MEME SUR LA SOURCE
    // PRIVEE DE SES COMMENTAIRES. Premiere tentative : je l'avais lue sans les
    // commentaires, en pensant que seul le nettoyeur de CHAINES etait fautif.
    // Mesure : les lignes 42-43 de `lib/airroi/client.js` manquaient encore —
    // un `/*` present dans une chaine en amont fait avaler par le depouilleur
    // de commentaires de bloc tout ce qui le suit jusqu'au `*/` suivant. Les
    // deux passes ont le meme defaut, pour la meme raison : aucune des deux
    // n'est un analyseur.
    // Une ligne de `require` est non ambigue dans la source BRUTE. On ecarte
    // seulement celle qui est elle-meme commentee — sinon un `require` mis en
    // commentaire masquerait un import reellement manquant.
    const lignes = src.split('\n')
    const importes = new Set()
    const noterNoms = (brut) => {
      for (const part of brut.split(',')) {
        const n = part.trim().match(/^([A-Za-z_$][\w$]*)/)
        if (n) importes.add(n[1])
      }
    }
    for (const ligne of lignes) {
      const m = ligne.match(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(/)
      if (!m) continue
      const avant = ligne.slice(0, m.index)
      if (/\/\/|\*/.test(avant)) continue      // la ligne est commentee
      noterNoms(m[1])
    }
    // Et les METHODES d'objet : `async nom (…) {` / `nom (…) {` dans un
    // litteral. `api/avis.js` definit `lireAvis` et `publierAvisVoyageur`
    // ainsi, et les appelle par `canal.lireAvis` — ce ne sont pas des appels
    // de fonction libre, donc pas des imports manquants.
    // ⚠ ET LA MEME PASSE COLLECTE LES PARAMETRES : ce qui suit un `(` dans une
    // SIGNATURE est une declaration locale, ce qui suit un `(` dans un APPEL
    // n'en est pas une. La distinction se fait sur le `{` qui suit la
    // parenthese fermante — pas sur la parenthese elle-meme.
    const parametres = new Set()
    const noterParams = (liste) => {
      for (const part of String(liste).split(',')) {
        const n = part.trim().match(/^\.{0,3}\s*([A-Za-z_$][\w$]*)/)
        if (n) parametres.add(n[1])
      }
    }
    for (const m of src.matchAll(/(?:^|[,{]|\basync\s+)\s*([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{/gm)) {
      importes.add(m[1])
      noterParams(m[2])
    }
    // Les fonctions flechees et les `function` classiques.
    for (const m of src.matchAll(/\bfunction\s*[A-Za-z_$][\w$]*\s*\(([^()]*)\)/g)) noterParams(m[1])
    for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) noterParams(m[1])
    for (const m of src.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/gm)) parametres.add(m[1])

    for (const [nom, proprios] of proprietaire) {
      if (importes.has(nom)) continue
      if (proprios.has(base)) continue                    // c'est lui qui l'exporte
      // appele comme fonction, et pas en tant que methode (`x.nom(`)
      const appel = new RegExp(`(^|[^\\w$.])${nom}\\s*\\(`, 'm')
      if (!appel.test(code)) continue
      // declare localement (fonction, const, let, var, parametre destructure) ?
      // ⚠ ET LE `(` A ETE RETIRE DE LA CLASSE — IL OUVRAIT UN TROU PROUVE.
      // J'avais ajoute `(` et `)` pour reconnaitre un PARAMETRE de fonction
      // (`arriveesProches (conversations, jourParis)`), qui est bien une
      // declaration locale. Mais la regex ne distingue pas une liste de
      // PARAMETRES d'une liste d'ARGUMENTS : `console.log(colonneAbsente)`
      // satisfaisait aussi `([{,(]\s*nom\s*[,}=:)])`. Mesure : retirer le
      // `require` de `colonneAbsente` dans `api/ecran/aujourdhui.js` faisait
      // rougir le test, et ajouter UNE ligne `if (false) console.log(colonneAbsente)`
      // le remettait au VERT. Le filet exemptait donc tout export de `lib/`
      // passe en argument nu — c'est-a-dire le cas le plus courant.
      // Les parametres se collectent donc explicitement, sur les SIGNATURES
      // (`parametres`, plus haut), et la classe revient a ce qu'elle etait.
      const declare = new RegExp(
        `(function\\s+${nom}\\b)|((?:const|let|var)\\s+${nom}\\b)|([{,]\\s*${nom}\\s*[,}=:])`, 'm')
      if (parametres.has(nom)) continue
      if (declare.test(code)) continue
      manquants.push(`${path.relative(RACINE, f)} appelle ${nom}() `
        + `sans l'importer (exporte par ${[...proprios].join(', ')})`)
    }
  }

  assert.deepStrictEqual(manquants, [],
    'identifiant(s) appele(s) sans import — ReferenceError garanti a l\'execution :\n  '
    + manquants.join('\n  '))
})
