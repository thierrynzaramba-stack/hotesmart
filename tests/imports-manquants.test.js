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

// ⚠ RECURSIF : voir la note des trois autres recensements du meme commit.
// `api/ecran/` est le premier sous-repertoire de `api/`, et un fichier non
// examine par ce test est un `require` manquant qui ne se voit qu'en
// production, au premier appel.
function fichiersJs (dossier) {
  const out = []
  for (const e of fs.readdirSync(dossier, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...fichiersJs(path.join(dossier, e.name)))
    else if (e.name.endsWith('.js')) out.push(path.join(dossier, e.name))
  }
  return out
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
    for (const m of src.matchAll(/(?:^|[,{]|\basync\s+)\s*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/gm)) {
      importes.add(m[1])
    }

    for (const [nom, proprios] of proprietaire) {
      if (importes.has(nom)) continue
      if (proprios.has(base)) continue                    // c'est lui qui l'exporte
      // appele comme fonction, et pas en tant que methode (`x.nom(`)
      const appel = new RegExp(`(^|[^\\w$.])${nom}\\s*\\(`, 'm')
      if (!appel.test(code)) continue
      // declare localement (fonction, const, let, var, parametre destructure) ?
      // ⚠ `)` EST DANS LA CLASSE DE FIN, ET IL N'Y ETAIT PAS : un PARAMETRE de
      // fonction est une declaration locale. `arriveesProches (conversations,
      // jourParis)` faisait signaler `jourParis` comme non importe, alors
      // qu'il est INJECTE — et que la fonction documente pourquoi.
      const declare = new RegExp(
        `(function\\s+${nom}\\b)|((?:const|let|var)\\s+${nom}\\b)|([{,(]\\s*${nom}\\s*[,}=:)])`, 'm')
      if (declare.test(code)) continue
      manquants.push(`${path.relative(RACINE, f)} appelle ${nom}() `
        + `sans l'importer (exporte par lib/${[...proprios].join(', lib/')})`)
    }
  }

  assert.deepStrictEqual(manquants, [],
    'identifiant(s) appele(s) sans import — ReferenceError garanti a l\'execution :\n  '
    + manquants.join('\n  '))
})
