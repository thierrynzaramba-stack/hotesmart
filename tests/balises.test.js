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
// ⚠ L'INSTANT DE REFERENCE EST INJECTE, ET C'EST LA REGLE DU DEPOT : depuis que
// l'annee ne se dit que hors de l'annee en cours, `formatDate` LIT L'HORLOGE.
// Des dates figees sans temps injecte rendraient ces tests faux le
// 1er janvier 2027 — « lundi 2 novembre » deviendrait « lundi 2 novembre 2026 ».
const MAINTENANT = new Date('2026-11-03T12:00:00Z')

test('LE TEST QUI COMPTE : la base de connaissance passe AVANT le repli du provider', () => {
  const r = remplacerBalises('tel {telephone_hote}, adresse {adresse}', {
    reservation: RESA,
    connaissance: { telephone_hote: 'BASE-TEL', adresse: 'BASE-ADRESSE' },
    replis: { telephone_hote: 'PROVIDER-TEL', adresse: 'PROVIDER-ADRESSE' }
  })
  // ⚠ SAUF L'ADRESSE : une seule adresse, celle de la FICHE (décision de
  // Thierry du 8 novembre 2026). Une ligne `adresse` restée dans la base ne
  // passe plus devant celle que l'hôte corrige dans sa fiche.
  assert.equal(r.texte, 'tel BASE-TEL, adresse PROVIDER-ADRESSE')
  assert.deepEqual(r.manquants, [])
})

test('LE TEST QUI COMPTE : une adresse SEULEMENT dans la base est un MANQUE (la fiche fait foi)', () => {
  const r = remplacerBalises('adresse {adresse}', {
    reservation: RESA, connaissance: { adresse: 'BASE-ADRESSE' }, replis: {}
  })
  assert.equal(r.texte, 'adresse [ADRESSE]')
  assert.deepEqual(r.manquants, ['adresse'])
})

test('valeurEffective suit le remplaceur (base, fiche, défaut ; l adresse, fiche seule)', () => {
  const { valeurEffective, replisDuBien } = require('../lib/balises')
  const replis = replisDuBien({ address: '12 rue X', checkin_time: '16:00' })
  assert.equal(valeurEffective('adresse', { adresse: 'BASE' }, replis), '12 rue X')
  assert.equal(valeurEffective('checkin', {}, replis), '16:00')
  assert.equal(valeurEffective('checkin', { checkin: '15:00' }, replis), '15:00')
  assert.equal(valeurEffective('checkout', {}, replis), '10:00')
  assert.equal(valeurEffective('wifi_nom', {}, replis), null)
  assert.equal(valeurEffective('prenom', {}, replis), null, 'une balise de la réservation n est pas une info du logement')
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

test('LE TEST QUI COMPTE : un code non resolu SE SIGNALE, et n entre pas dans les manquants', () => {
  // ⚠ CETTE DISTINCTION EST TOUT, et ma premiere version du lot 1b l'avait
  // ratee : `manquants` fait RETOURNER `null` a `generateAutoMessage`, et ce
  // `null` tombe AVANT la fourche auto/Test — donc la proposition que l'hote
  // complete a la main disparaissait elle aussi. Pour un code il n'existe
  // aucune autre issue : la base de connaissance ne porte pas `code_acces`, et
  // le moteur programme ne fournit jamais le code. Le drapeau separe permet a
  // l'appelant de refuser l'ENVOI en gardant la preparation.
  const sans = remplacerBalises('code {code_acces}', { reservation: RESA })
  assert.equal(sans.texte, `code ${UNRESOLVED_CODE}`)
  assert.equal(sans.codeNonResolu, true, 'le code absent se signale')
  assert.deepEqual(sans.manquants, [], 'mais il ne bloque PAS la generation')
  assert.ok(hasUnresolvedCode(sans.texte), 'et la garde de l envoi le voit')

  const avec = remplacerBalises('code {code_acces}', { reservation: RESA, codeAcces: '000000' })
  assert.equal(avec.texte, 'code 000000')
  assert.equal(avec.codeNonResolu, false)
  assert.ok(!hasUnresolvedCode(avec.texte))

  // Un texte qui ne demande pas le code ne le signale pas.
  assert.equal(remplacerBalises('Bonjour {prenom}', { reservation: RESA }).codeNonResolu, false)

  // ⚠ ET LE CODE N'A PAS DE « OU LE REMPLIR » : le gabarit de l'alerte des
  // manquants promet « le message repartira une fois l'information saisie » —
  // faux pour un code, qui ne se saisit nulle part. Il a son propre message.
  assert.equal(OU_REMPLIR.code_acces, undefined)
})

test('LE TEST QUI COMPTE : les deux sites d envoi consultent la garde du code', () => {
  // ⚠ UN TEST DE CABLAGE, ET JE LE DIS : aucun test du depot n'exerce
  // `checkAndSendTemplate` ni `processMessageTemplates` — ils demandent un
  // double complet de Supabase. L'EFFET de la garde (« le message est prepare,
  // l'envoi est refuse ») n'est donc pas mesure ; ce qui l'est, c'est que les
  // DEUX sites d'envoi la consultent, et que le message existe (teste par
  // effet dans tests/cron-messages-prenom.test.js). Dette notee dans la remise.
  // ⚠ COMMENTAIRES RETIRES — constat de review : la version d'avant lisait la
  // source BRUTE, donc commenter les deux lignes de garde laissait le compte a
  // 2 et la suite VERTE, la garde desactivee.
  const cron = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cron-messages.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
  const gardes = cron.match(/const codeARemplir = hasUnresolvedCode\(message\)/g) || []
  assert.equal(gardes.length, 2, 'les deux sites d envoi posent la garde')
  const fourches = cron.match(/if \(propMode === 'auto' && !codeARemplir\)/g) || []
  assert.equal(fourches.length, 2, 'et les deux fourches la consultent')
  // ⚠ ET L'ALERTE NE PART QUE SI UN ENVOI ALLAIT AVOIR LIEU — constat de
  // review : en mode Test rien ne partait, et une alerte inutile AVALE le
  // `message_non_envoye` d'un vrai defaut pendant une heure (anti-spam par
  // type et par bien).
  const alertes = cron.match(/if \(propMode === 'auto' && codeARemplir\) await prevenirCodeARemplir/g) || []
  assert.equal(alertes.length, 2, 'les deux alertes sont conditionnees a un envoi reel')
  // ⚠ L'ASSERTION SUR L'IMPORT A ETE RETIREE D'ICI — constat de review : elle
  // ne pouvait mordre que si les deux termes tombaient sur la MEME ligne, et le
  // test du format, dans ce meme fichier, couvre deja le cas plus largement
  // (`!/\bformatDate\b/` sur le fichier entier).
})

test('LE TEST QUI COMPTE : UN SEUL format de date, et il n est pas injectable', () => {
  // ⚠ CE TEST DISAIT L'INVERSE JUSQU'AU 3 NOVEMBRE 2026 : il gravait que les
  // deux chemins formatent differemment et que le format est INJECTE. Le lot 1
  // avait fait ce choix pour ne rien changer au texte recu par le voyageur ;
  // Thierry a tranche l'unification (lot 1b), confirmee dans sa fenetre parce
  // qu'elle CHANGE ce texte : les messages programmes rendaient
  // « 02 novembre 2026 », ils rendent « lundi 2 novembre ».
  const r = remplacerBalises('arrivee {arrivee}, depart {depart}',
    { reservation: RESA, maintenant: MAINTENANT })
  assert.equal(r.texte, 'arrivee lundi 2 novembre, depart mercredi 4 novembre')

  // ⚠ L'INJECTION A ETE RETIREE, PAS SEULEMENT INUTILISEE : un point
  // d'injection laisse en place permet de redivergier en une ligne, sans
  // conflit et sans test rouge. On EPROUVE qu'un appelant ne peut plus choisir.
  const force = remplacerBalises('arrivee {arrivee}', {
    reservation: RESA, maintenant: MAINTENANT, formatDate: () => 'FORMAT-IMPOSE'
  })
  assert.equal(force.texte, 'arrivee lundi 2 novembre',
    'aucun appelant ne doit pouvoir imposer son format')
  // ⚠ LE GREP IGNORE LES COMMENTAIRES — constat de review : sans ca, un
  // commentaire qui NOMME le parametre retire (« on n'accepte plus
  // ctx.formatDate ») rendrait ce test rouge pour rien.
  const sansCommentaires = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
  assert.ok(!/ctx\.formatDate/.test(sansCommentaires('lib/balises.js')),
    'le point d injection ne doit plus exister')
  // ⚠ ET ON REGARDE LE FICHIER ENTIER, pas une tranche delimitee par une
  // chaine magique : `cron.slice(…, indexOf('text = texte'))` rendait -1 au
  // premier renommage, et l'assertion restait verte a vide pour toujours.
  assert.ok(!/\bformatDate\b/.test(sansCommentaires('lib/cron-messages.js')),
    'cron-messages ne doit plus connaitre d autre formateur, nulle part')
})

test('LE TEST QUI COMPTE : l annee ne se dit QUE hors de l annee en cours', () => {
  // ⚠ DECISION DE THIERRY DU 3 NOVEMBRE 2026, et elle repare un defaut que la
  // mesure du lot 1b avait fait apparaitre : le format long ne portait AUCUNE
  // annee, donc une confirmation envoyee aujourd'hui pour novembre 2027 disait
  // « pour le mardi 2 novembre » sans dire laquelle — dans le message qui
  // CONFIRME une reservation. La porter toujours aurait alourdi les messages
  // du mois qui vient, qui sont l'immense majorite.
  const dans = (d) => remplacerBalises('x {arrivee}', { reservation: { arrivee: d }, maintenant: MAINTENANT }).texte
  assert.equal(dans('2026-11-02'), 'x lundi 2 novembre', 'meme annee : pas d annee')
  assert.equal(dans('2026-12-25'), 'x vendredi 25 décembre', 'decembre de cette annee non plus')
  assert.equal(dans('2027-11-02'), 'x mardi 2 novembre 2027', 'annee suivante : elle se dit')
  // ⚠ « 1er », PAS « 1 » — constat de review : « le 1 janvier » n'est pas du
  // francais, et ma premiere version de ce test FIGEAIT le defaut, sur le cas
  // precis qu'une confirmation de reservation affiche en clair.
  assert.equal(dans('2027-01-01'), 'x vendredi 1er janvier 2027', 'meme a un jour d ecart')
  // ⚠ ET DANS L'AUTRE SENS : un sejour passe porte son annee aussi. Un message
  // de depart relu en janvier ne doit pas faire croire a l'annee en cours.
  assert.equal(dans('2025-11-02'), 'x dimanche 2 novembre 2025', 'annee passee : elle se dit')

  // ⚠ ET L'INSTANT DE REFERENCE FAIT BIEN BASCULER LE RESULTAT : sans cette
  // assertion, les cinq precedentes resteraient vraies d'une fonction qui
  // ignorerait `maintenant` et comparerait a l'horloge reelle.
  const memeDate = '2027-11-02'
  assert.equal(remplacerBalises('x {arrivee}',
    { reservation: { arrivee: memeDate }, maintenant: new Date('2027-06-01T12:00:00Z') }).texte,
  'x mardi 2 novembre', 'vu depuis 2027, la meme date ne porte plus d annee')
})

test('LE TEST QUI COMPTE : l annee se decide en heure de PARIS, pas celle du serveur', () => {
  // ⚠ CONSTAT DE REVIEW, MESURE, et il mordait UNE HEURE PAR AN. Une date
  // ecrite « 2026-12-31 » est minuit UTC, les getters de `Date` sont LOCAUX, et
  // les fonctions Vercel tournent en UTC. A 23:30 UTC le 31 decembre, il est
  // deja le 1er janvier a Paris : l'ancienne version disait « jeudi
  // 31 décembre » sans annee, et « mardi 5 janvier 2027 » AVEC — les deux a
  // l'envers, dans le message qui confirme une reservation.
  const reveillon = new Date('2026-12-31T23:30:00Z')   // 00:30 le 1er janvier a Paris
  const dit = (d, ref) => remplacerBalises('x {arrivee}', { reservation: { arrivee: d }, maintenant: ref }).texte
  assert.equal(dit('2026-12-31', reveillon), 'x jeudi 31 décembre 2026',
    'vu de Paris on est en 2027 : l annee du sejour se dit')
  assert.equal(dit('2027-01-05', reveillon), 'x mardi 5 janvier',
    'et janvier 2027 est l annee EN COURS : elle ne se dit pas')

  // ⚠ ET LE RESULTAT NE DEPEND PLUS DU FUSEAU DU PROCESSUS. Mesure du
  // 3 novembre 2026 : sous `TZ=America/New_York`, l'ancienne version rendait
  // un JOUR faux en plus de l'annee. On ne peut pas changer `TZ` en cours de
  // test (l'`Intl` est deja construit), mais on peut EPROUVER que la fonction
  // n'utilise aucun getter local : sous n'importe quel fuseau, une date UTC du
  // 31 decembre a 23:00 reste le 31 decembre a Paris.
  assert.equal(dit('2026-12-31', new Date('2026-06-01T12:00:00Z')), 'x jeudi 31 décembre',
    'meme annee vue de juin 2026 : pas d annee')
})

test('LE TEST QUI COMPTE : la preuve se fait SOUS UTC, le fuseau de Vercel', () => {
  // ⚠ SANS CE TEST, LE GARDE-FOU EST VIDE SUR CETTE MACHINE, et je l'ai mesure :
  // la machine de developpement est a l'heure de Paris, donc les getters LOCAUX
  // y donnent le bon resultat. La mutation « retour aux getters locaux » rendait
  // ZERO rouge — un test qui ne peut pas voir le defaut qu'il pretend garder.
  // Le defaut, lui, ne vit que sous `TZ=UTC`, c'est-a-dire en production.
  // On lance donc un processus ENFANT avec ce fuseau : c'est la seule facon de
  // mesurer ici ce qui se passe la-bas.
  const { execFileSync } = require('node:child_process')
  const code = `
    const { formatDate } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'balises.js'))})
    const r = new Date('2026-12-31T23:30:00Z')
    console.log(JSON.stringify([formatDate('2026-12-31', r), formatDate('2027-01-05', r)]))
  `
  const sortie = execFileSync(process.execPath, ['-e', code],
    { env: { ...process.env, TZ: 'UTC' }, encoding: 'utf8' })
  const [reveillon, janvier] = JSON.parse(sortie)
  assert.equal(reveillon, 'jeudi 31 décembre 2026',
    'sous UTC aussi, il est le 1er janvier a Paris : l annee du sejour se dit')
  assert.equal(janvier, 'mardi 5 janvier',
    'et janvier 2027 est l annee en cours a Paris : elle ne se dit pas')
})

test('LE TEST QUI COMPTE : un instant de reference inutilisable retombe sur l horloge', () => {
  // ⚠ CONSTAT DE REVIEW : `maintenant == null` etait la seule garde. Un
  // horodatage en SECONDES est une date VALIDE (janvier 1970), donc l'annee se
  // disait sur TOUTES les dates, en silence, dans du texte qui part au
  // voyageur. Le JSDoc annoncait « number » sans preciser l'unite.
  const annee = new Date().getFullYear()
  const cetteAnnee = `${annee}-06-15`
  const dit = (ref) => remplacerBalises('x {arrivee}', { reservation: { arrivee: cetteAnnee }, maintenant: ref }).texte
  for (const faux of [1762000000, '', NaN, 0, 'hier', {}, -1]) {
    assert.ok(!dit(faux).includes(String(annee)),
      `un instant ${JSON.stringify(faux)} ne doit pas faire dire l annee en cours`)
  }
  // Contre-epreuve : un instant VALIDE d'une autre annee, lui, fait dire l annee.
  assert.ok(dit(new Date(`${annee - 2}-06-15T12:00:00Z`)).includes(String(annee)),
    'un instant valide d une autre annee la fait bien dire')
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
  // ⚠ LA POPULATION EST « CE QUI PEUT ENTRER DANS `manquants` », pas « ce qui
  // vient de la base » — constat de review. Les deux coincidaient jusqu'a ce
  // que le lot 1b fasse entrer un code d'origine `serrure`… avant de l'en
  // ressortir. On la DERIVE du comportement plutot que de l'origine : on
  // demande a la fonction, pour chaque balise, si elle finit dans `manquants`.
  const peutManquer = Object.keys(BALISES).filter(cle => {
    const r = remplacerBalises(`x {${cle}} y`, { reservation: {}, connaissance: {} })
    return r.manquants.includes(cle)
  })
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
