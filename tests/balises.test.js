// tests/balises.test.js
//
// LE SEUL REMPLACEUR DE BALISES DU DEPOT (lot 1, « Base de connaissance V5 »).
//
// ⚠ CES TESTS APPELLENT LA FONCTION. Les quatre invariants repris de
// `tests/cron-messages-placeholders.test.js` y etaient verifies sur le TEXTE de
// `lib/cron-messages.js` (`assert.match(messages, /val\('adresse', …/)`), et le
// texte ne porte pas le flot de controle : ils seraient restes verts si la
// substitution avait cesse d'etre atteinte. Ils sont ici mesures par l'effet.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { remplacerBalises, BALISES, DE_LA_BASE, OU_REMPLIR,
        UNRESOLVED_CODE, hasUnresolvedCode, etiquetteDe } = require('../lib/balises')

const RESA = { prenom: 'Jean-Marie', nom: 'D.', arrivee: '2026-11-02',
               depart: '2026-11-04', logement: 'La bulle' }

test('LE TEST QUI COMPTE : la base de connaissance passe AVANT le repli du provider', () => {
  const r = remplacerBalises('tel {telephone_hote}, adresse {adresse}', {
    reservation: RESA,
    connaissance: { telephone_hote: 'BASE-TEL', adresse: 'BASE-ADRESSE' },
    replis: { telephone_hote: 'PROVIDER-TEL', adresse: 'PROVIDER-ADRESSE' }
  })
  assert.equal(r.texte, 'tel BASE-TEL, adresse BASE-ADRESSE')
  assert.deepEqual(r.manquants, [])
})

test('le repli du provider sert quand la base est muette, et le defaut en dernier', () => {
  const sansBase = remplacerBalises('tel {telephone_hote}, arrivee {checkin}', {
    reservation: RESA, connaissance: {},
    replis: { telephone_hote: 'PROVIDER-TEL', checkin: '16:00' }
  })
  assert.equal(sansBase.texte, 'tel PROVIDER-TEL, arrivee 16:00')
  const sansRien = remplacerBalises('arrivee {checkin}, depart {checkout}', {
    reservation: RESA, connaissance: {}
  })
  assert.equal(sansRien.texte, 'arrivee 18:00, depart 10:00',
    'les horaires ont un defaut raisonnable : ni marqueur, ni alerte')
  assert.deepEqual(sansRien.manquants, [])
})

test('LE TEST QUI COMPTE : une valeur absente laisse un MARQUEUR, jamais un blanc', () => {
  // « Appelez-moi au . » est un message casse que personne ne remarque ;
  // « [TÉLÉPHONE HÔTE] » se remarque tout de suite.
  const r = remplacerBalises('Appelez-moi au {telephone_hote}, {adresse}', {
    reservation: RESA, connaissance: {}
  })
  assert.match(r.texte, /\[TÉLÉPHONE HÔTE\]/)
  assert.match(r.texte, /\[ADRESSE\]/)
  assert.ok(!/au ,/.test(r.texte), 'jamais un blanc a la place de la valeur')
  assert.deepEqual(r.manquants.sort(), ['adresse', 'telephone_hote'])
})

test('LE TEST QUI COMPTE : on ne signale QUE les balises que le texte utilise', () => {
  // Sinon : un avertissement par message, par bien, toutes les 5 minutes — le
  // signal diagnostique devient du bruit permanent.
  const r = remplacerBalises('Bonjour {prenom}, a bientot.', { reservation: RESA, connaissance: {} })
  assert.equal(r.texte, 'Bonjour Jean-Marie, a bientot.')
  assert.deepEqual(r.manquants, [], 'aucune balise de la base n est utilisee ici')
})

test('LE TEST QUI COMPTE : le wifi vient de la BASE — le defaut que ce lot ferme', () => {
  // ⚠ C'EST LA DIVERGENCE QUI A JUSTIFIE LE LOT. `lib/cron-messages.js` posait
  // « [WIFI NOM] » EN TOUTES CIRCONSTANCES, sans jamais lire `knowledge`, et
  // sans compter la balise dans les manquants : le message partait donc au
  // voyageur avec le marqueur en clair. Latent en production (aucun des onze
  // modeles ne porte ces balises), reel des qu'un hote en ecrit un.
  const avec = remplacerBalises('wifi {wifi_nom} / {wifi_mdp}', {
    reservation: RESA, connaissance: { wifi_nom: 'RESEAU-TEST', wifi_mdp: 'SECRET-TEST' }
  })
  assert.equal(avec.texte, 'wifi RESEAU-TEST / SECRET-TEST')
  assert.deepEqual(avec.manquants, [])

  const sans = remplacerBalises('wifi {wifi_nom}', { reservation: RESA, connaissance: {} })
  assert.match(sans.texte, /\[WIFI NOM\]/)
  assert.deepEqual(sans.manquants, ['wifi_nom'],
    'une balise wifi sans valeur DOIT entrer dans les manquants, sinon le marqueur part au voyageur')
})

test('le prenom manquant donne une formule neutre, jamais « Voyageur » ni {prenom}', () => {
  const r = remplacerBalises('Bonjour {prenom}, bienvenue.', { reservation: { prenom: '' } })
  assert.equal(r.texte, 'Bonjour, bienvenue.')
  assert.ok(!/\{prenom\}/.test(r.texte))
  assert.ok(!/Voyageur/.test(r.texte))
})

test('une balise inconnue est RENDUE, pas avalee : l appelant decide', () => {
  const r = remplacerBalises('Bonjour {prenom}, {code_promo} et {autre chose}', { reservation: RESA })
  assert.deepEqual(r.inconnues.sort(), ['{autre chose}', '{code_promo}'])
  assert.deepEqual(r.manquants, [], 'une balise inconnue n est pas une valeur manquante')
})

test('LE TEST QUI COMPTE : le code d acces n entre JAMAIS dans les manquants', () => {
  // Son absence est NORMALE au moment ou un message programme est bati : la
  // serrure n'a pas encore genere le code. L'ajouter aux manquants ferait
  // refuser des modeles qui partent aujourd'hui (`menage_done` en production).
  // Sa garde est ailleurs, et elle est plus forte : `hasUnresolvedCode`.
  const sans = remplacerBalises('code {code_acces}', { reservation: RESA })
  assert.equal(sans.texte, `code ${UNRESOLVED_CODE}`)
  assert.deepEqual(sans.manquants, [])
  assert.ok(hasUnresolvedCode(sans.texte), 'la garde de l envoi, elle, le voit')
  const avec = remplacerBalises('code {code_acces}', { reservation: RESA, codeAcces: '000000' })
  assert.equal(avec.texte, 'code 000000')
  assert.ok(!hasUnresolvedCode(avec.texte))
})

test('le format de date est INJECTE : les deux chemins ne formatent pas pareil', () => {
  // Mesure du 3 novembre 2026 : le code d'acces rend « dimanche 2 novembre »,
  // les messages programmes « 02 novembre 2026 ». Imposer l'un des deux aurait
  // change le texte recu par le voyageur — ce lot promet « rien de visible ».
  // ⚠ Le 2 novembre 2026 est un LUNDI. La maquette validee ecrit « dimanche
  // 2 novembre » — c'est une maquette, pas un calendrier, et un test qui
  // recopierait sa phrase sans la verifier figerait son erreur.
  const defaut = remplacerBalises('arrivee {arrivee}', { reservation: RESA })
  assert.equal(defaut.texte, 'arrivee lundi 2 novembre')
  const autre = remplacerBalises('arrivee {arrivee}', {
    reservation: RESA, formatDate: () => '02 novembre 2026'
  })
  assert.equal(autre.texte, 'arrivee 02 novembre 2026')
})

test('LE TEST QUI COMPTE : un seul remplaceur dans le depot', () => {
  // ⚠ UN TEST DE TEXTE, ET C EST ASSUME : l invariant EST textuel — il n existe
  // qu une copie. L effet, lui, est mesure par les tests ci-dessus.
  const racine = path.join(__dirname, '..')
  const coupables = []
  // ⚠ LE PERIMETRE ET LES DEUX FORMES, et c'est un constat de review : il ne
  // balayait que `lib/` et `api/` — or la spec annonce `shared/balises.js` et
  // le lot 4 ecrit l'insertion cote front, donc la copie naitra justement la.
  // Et il ne reconnaissait qu'une seule forme, alors que l'idiome de
  // `balises.js` lui-meme est `new RegExp(\`\\{${cle}\\}\`)` : un
  // copier-coller de sa boucle serait passe vert.
  for (const dossier of ['lib', 'api', 'shared', 'pages', 'scripts', 'apps']) {
    const pile = [path.join(racine, dossier)]
    while (pile.length) {
      const d = pile.pop()
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) { pile.push(p); continue }
        if (!e.name.endsWith('.js') && !e.name.endsWith('.html')) continue
        if (p === path.join(racine, 'lib', 'balises.js')) continue
        // ⚠ LES TROIS FORMES DE COMMENTAIRE, HTML COMPRIS — constat de la
        // seconde review : sans `<!-- -->`, un exemple laisse dans une page
        // ferait crier au loup sur une copie qui n'existe pas.
        const net = fs.readFileSync(p, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .replace(/<!--[\s\S]*?-->/g, ' ')
          .replace(/^[ \t]*\/\/.*$/gm, ' ')
        for (const cle of Object.keys(BALISES)) {
          // ⚠ QUATRE FORMES, ET LA DERNIERE EST CELLE QUE CE LOT VIENT
          // D'INTRODUIRE — constat de la seconde review : mon garde-fou ne
          // voyait ni `pose(` (l'idiome de `balises.js` apres le correctif du
          // `$`), ni une cle CONSTRUITE (`\${cle}`), donc un copier-coller de
          // sa propre boucle serait passe vert.
          const litteral = new RegExp(`\\.replace\\(\\s*/\\\\?\\{${cle}\\\\?\\}`)
          const pose = new RegExp(`pose\\(\\s*\\w+\\s*,\\s*/\\\\?\\{${cle}\\\\?\\}`)
          const construit = new RegExp(`new RegExp\\([\`'"]\\\\*\\{${cle}`)
          if (litteral.test(net) || pose.test(net) || construit.test(net)) {
            coupables.push(`${path.relative(racine, p)} : {${cle}}`)
          }
        }
      }
    }
  }
  assert.deepEqual(coupables, [],
    'une seconde copie du remplacement est apparue — c est exactement ce que le lot 1 a ferme')
  // ⚠ ET LA BOUCLE GENERIQUE, celle qui ne cite aucune cle : c'est exactement
  // le bloc de `lib/balises.js`, et c'est lui qu'un lot futur recopiera.
  const generique = []
  for (const dossier of ['lib', 'api', 'shared', 'pages', 'scripts', 'apps']) {
    const pile = [path.join(racine, dossier)]
    while (pile.length) {
      const d = pile.pop()
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const q = path.join(d, e.name)
        if (e.isDirectory()) { pile.push(q); continue }
        if (!e.name.endsWith('.js') && !e.name.endsWith('.html')) continue
        if (q === path.join(racine, 'lib', 'balises.js')) continue
        const net = fs.readFileSync(q, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .replace(/<!--[\s\S]*?-->/g, ' ')
          .replace(/^[ \t]*\/\/.*$/gm, ' ')
        if (/new RegExp\(`\\\\\{\$\{\w+\}\\\\\}`/.test(net)) {
          generique.push(path.relative(racine, q))
        }
      }
    }
  }
  assert.deepEqual(generique, [],
    'la boucle de substitution de balises.js a ete recopiee ailleurs')
})

test('LE TEST QUI COMPTE : une valeur portant un $ arrive INTACTE chez le voyageur', () => {
  // ⚠ CONSTAT DE REVIEW, MESURE. Dans une CHAINE de remplacement, `$$`, `$&`,
  // ``$` `` et `$'` sont des motifs : « pa$$w0rd » devenait « pa$w0rd », et
  // « x$`y » recopiait le texte d'avant. Aucun de ces cas ne leve, aucun
  // n'entre dans `manquants` : le voyageur recevait un mot de passe faux, sans
  // la moindre garde. Et c'est le champ le plus susceptible de porter un `$`.
  for (const valeur of ['pa$$w0rd', 'ab$&cd', "x$`y", "z$'t", '$1euro']) {
    const r = remplacerBalises('wifi: {wifi_mdp}', { reservation: RESA, connaissance: { wifi_mdp: valeur } })
    assert.equal(r.texte, `wifi: ${valeur}`, `la valeur ${valeur} doit arriver intacte`)
  }
  // Et la meme regle vaut pour ce qui vient de la reservation.
  assert.equal(remplacerBalises('nom: {nom}', { reservation: { nom: 'A$$B' } }).texte, 'nom: A$$B')
  // ⚠ LE PRENOM, et il etait le SEUL oublie du premier correctif — constat de
  // la seconde review. C'est le champ le plus souvent substitue, et c'est du
  // texte libre venu de l'OTA.
  for (const v of ['C$`D', 'Jo$$ie', 'A$&B', "E$'F"]) {
    const r = remplacerBalises('Bonjour {prenom}, bienvenue', { reservation: { prenom: v } })
    assert.equal(r.texte, `Bonjour ${v}, bienvenue`, `le prenom ${v} doit arriver intact`)
    assert.deepEqual(r.inconnues, [], 'et il ne doit pas etre pris pour une variable inconnue')
  }
})

test('un repli est une CHAINE de replis : un blanc ne masque pas le suivant', () => {
  // ⚠ Constat de review : `property.checkInStart || property.checkin_time`
  // ecrasait le second des que le premier etait une chaine d'espaces.
  const r = remplacerBalises('arrivee {checkin}', {
    reservation: RESA, connaissance: {}, replis: { checkin: ['   ', '16:00'] }
  })
  assert.equal(r.texte, 'arrivee 16:00', 'le repli blanc est saute, pas pris')
  const vide = remplacerBalises('arrivee {checkin}', {
    reservation: RESA, connaissance: {}, replis: { checkin: ['  ', null] }
  })
  assert.equal(vide.texte, 'arrivee 18:00', 'tous blancs : le defaut')
  // ⚠ `0` ET `false` SE SAUTENT, comme le faisait `||` — constat de la seconde
  // review : sans ca, un provider posant `checkInStart: 0` pour « non regle »
  // affichait « 0 » comme heure d'arrivee.
  for (const faux of [0, false]) {
    const r = remplacerBalises('arrivee {checkin}', {
      reservation: RESA, connaissance: {}, replis: { checkin: [faux, '16:00'] }
    })
    assert.equal(r.texte, 'arrivee 16:00', `${JSON.stringify(faux)} doit etre saute`)
  }
})

test('LE TEST QUI COMPTE : toute balise pouvant manquer dit OU la remplir', () => {
  // ⚠ Constat de review : le wifi est entre dans les manquants avec ce lot, et
  // l'alerte envoyee a l'hote disait « A renseigner dans wifi_mdp » — un nom
  // technique. On exige donc la couverture pour TOUT ce qui peut y entrer.
  const peutManquer = DE_LA_BASE.filter(cle => !BALISES[cle].defaut)
  assert.ok(peutManquer.length >= 4, 'le test doit porter sur une vraie population')
  for (const cle of peutManquer) {
    assert.ok(OU_REMPLIR[cle], `${cle} peut entrer dans les manquants : il doit dire ou se remplir`)
    assert.ok(!/^[a-z_]+$/.test(OU_REMPLIR[cle]), `${cle} : « ou le remplir » ne doit pas etre le nom technique`)
  }
  // Et le chemin des messages programmes lit CETTE table, pas une copie.
  const cron = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cron-messages.js'), 'utf8')
  // ⚠ L'ASSERTION NE DOIT PAS DEPENDRE DE CE QU'ON IMPORTE EN PLUS : ma
  // premiere version citait la ligne entiere, et elle a rougi des que
  // `etiquetteDe` s'y est ajoute — un test qui casse sur un ajout legitime.
  assert.match(cron, /OU_REMPLIR: OU_RENSEIGNER/, 'la table vient de balises.js')
  assert.ok(!/const OU_RENSEIGNER = \{/.test(cron), 'une seconde table redivergerait')
})

test('chaque balise de la base dit OU la remplir, et porte une etiquette lisible', () => {
  // L ecran V5 montre l etiquette, jamais `{…}` ; l alerte « info manquante »
  // lit `OU_REMPLIR`. Les deux sont DERIVES de BALISES, jamais recopies.
  for (const cle of DE_LA_BASE) {
    assert.ok(OU_REMPLIR[cle], `${cle} doit dire ou se remplir`)
    assert.ok(etiquetteDe(cle) && etiquetteDe(cle) !== cle, `${cle} doit avoir une etiquette`)
    assert.ok(!/[{}]/.test(etiquetteDe(cle)), 'une etiquette ne montre jamais d accolades')
  }
})
