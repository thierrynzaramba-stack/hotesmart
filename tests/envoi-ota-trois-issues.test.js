// tests/envoi-ota-trois-issues.test.js
//
// ⚠ LE CAS REEL, PAS SA VERSION CONFORTABLE — REGLE 8 DE REVIEW.md.
// Les formes de ce fichier sont celles MESUREES EN PRODUCTION le 29 octobre
// 2026, pas des formes enrichies qui emprunteraient le chemin facile :
//   · Channex refuse avec `{ errors: { code: 'http_too_many_requests' } }` —
//     c'est le code exact lu dans les cinq incidents de La bulle ;
//   · `sendViaBeds24` rend un refus applicatif SANS statut et SANS code, et un
//     `catch` reseau qui lui ressemble a s'y tromper. C'est en ecrivant ce
//     fichier que j'ai vu que mon classement rangeait le premier en INCERTAIN,
//     donc « plus jamais reessaye » ;
//   · `{ reason: 'missing_params' }` met son code dans `reason`, pas dans
//     `error`, et nulle part ailleurs.
//
// CE QUE LE DEFAUT A COUTE, et c'est ce que ces tests ferment : sur le canal
// OTA, `message_sent_log` etait ecrit AVANT l'envoi. C'est la garde
// anti-doublon : un refus du provider condamnait donc le message pour de bon,
// et le fil l'affichait comme parti. CINQ messages perdus en sept jours — un
// par echec, chacun condamne pour de bon — dont
// les consignes de securite du jacuzzi a un voyageur qui a passe deux nuits sur
// place, et l'annonce des codes d'acces a une voyageuse qui arrivait le
// lendemain.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// ⚠ AVANT LE `require` : `lib/envoi-ota.js` cree son client Supabase au
// chargement du module, comme tout le reste du depot. Sans ces deux lignes le
// fichier entier leve « supabaseUrl is required » et node:test rend « fail 1 »
// sans nommer un seul test — un rouge qui ne dit pas ce qui ne va pas.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'cle-de-test'

const { ISSUE, classerEnvoiOta, MAX_TENTATIVES_OTA, PALIERS_MIN,
  cleEchec, cleVerif } = require('../lib/envoi-ota')

// ── Les formes REELLES, telles que chaque provider les rend ────────────────

// Channex, le refus mesure cinq fois sur La bulle. Le statut est >= 400 : le
// partenaire a REPONDU, donc il n'a pas recu le message.
const CHANNEX_429 = {
  ok: false, canal: 'ota', status: 429,
  incertain: false, permanent: false,
  error: 'http_too_many_requests',
  raw: { errors: { code: 'http_too_many_requests', title: 'reponse 429 Too Many Requests' } }
}
// Channex, le `fetch` a LEVE : `channelCall` met `status: 0` et
// `errors.code = 'network_error'`. La requete a PU arriver et sa reponse se
// perdre — c'est la seule issue incertaine.
const CHANNEX_RESEAU = {
  ok: false, canal: 'ota', status: 0, incertain: true, permanent: false,
  error: 'network_error', raw: { errors: { code: 'network_error' } }
}
// Channex, faute de programmation (corps non serialisable, URL invalide).
const CHANNEX_APPEL = {
  ok: false, canal: 'ota', status: 0, incertain: false, permanent: true,
  error: 'call_error', raw: { errors: { code: 'call_error' } }
}
// ⚠ BEDS24 : LA FORME NUE. Aucun statut, aucun code — c'est exactement ce que
// `sendViaBeds24` rend sur un refus applicatif, et ce qui fait la difference
// avec son `catch`.
const BEDS24_REFUS = { ok: false, refus: true, canal: 'ota', error: [{ code: 1, message: 'refuse' }] }
const BEDS24_RESEAU = { ok: false, incertain: true, canal: 'ota', error: 'fetch failed' }
const BEDS24_PARAMS = { ok: false, reason: 'missing_params', canal: 'ota' }

test('LE TEST QUI COMPTE : le refus REEL de Channex est un REFUS, donc rejouable', () => {
  assert.equal(classerEnvoiOta(CHANNEX_429), ISSUE.REFUS)
})

test('LE TEST QUI COMPTE : une panne reseau est INCERTAINE, jamais un refus', () => {
  // Un renvoi a l'aveugle est la seule erreur irreversible ici : le voyageur
  // recevrait deux fois le meme message.
  assert.equal(classerEnvoiOta(CHANNEX_RESEAU), ISSUE.INCERTAIN)
  assert.equal(classerEnvoiOta(BEDS24_RESEAU), ISSUE.INCERTAIN)
})

test('LE TEST QUI COMPTE : le refus NU de Beds24 est un REFUS, pas un incertain', () => {
  // ⚠ C'EST LE CAS QUE MON PREMIER CLASSEMENT RATAIT. Sans statut et sans code,
  // il tombait dans le repli INCERTAIN — donc le message n'aurait PLUS JAMAIS
  // ete reessaye, et une ligne « a verifier » aurait attendu un humain pour un
  // refus ordinaire. La forme reelle n'a pas de statut : c'est tout l'objet de
  // la regle 8.
  assert.equal(classerEnvoiOta(BEDS24_REFUS), ISSUE.REFUS)
})

test('une faute de configuration est PERMANENTE, et son code est dans `reason`', () => {
  assert.equal(classerEnvoiOta(BEDS24_PARAMS), ISSUE.PERMANENT)
  assert.equal(classerEnvoiOta(CHANNEX_APPEL), ISSUE.PERMANENT)
})

test('un succes reste un succes, et un retour vide ne l est pas', () => {
  assert.equal(classerEnvoiOta({ ok: true }), ISSUE.LIVRE)
  // ⚠ LE REPLI EST L'INCERTAIN : un retour qu'on ne sait pas lire ne doit pas
  // autoriser un second envoi au voyageur.
  assert.equal(classerEnvoiOta({}), ISSUE.INCERTAIN)
  assert.equal(classerEnvoiOta(null), ISSUE.INCERTAIN)
  assert.equal(classerEnvoiOta(undefined), ISSUE.INCERTAIN)
})

test('un 2xx qui porte `errors` n est PAS une livraison', () => {
  // `channelCall` calcule `ok` sur le statut seul pour une ecriture ; le filet
  // vit dans `sendMessage`. Ici on verifie le classement du retour normalise.
  assert.equal(classerEnvoiOta({ ok: false, status: 200, error: 'http_too_many_requests' }), ISSUE.REFUS)
})

// ── Les paliers et le plafond ──────────────────────────────────────────────

test('LE TEST QUI COMPTE : les paliers croissent et tiennent dans la fenetre de 24 h', () => {
  // Le cron passe toutes les 5 minutes : sans palier, un refus consommerait les
  // cinq tentatives en vingt minutes et le plafond abandonnerait un message
  // qu'une limite de debit aurait laisse passer une heure plus tard.
  assert.equal(PALIERS_MIN.length, MAX_TENTATIVES_OTA + 1,
    'un palier par tentative, plus celui de la premiere')
  assert.equal(PALIERS_MIN[0], 0, 'la premiere tentative est immediate')
  for (let i = 2; i < PALIERS_MIN.length; i++) {
    assert.ok(PALIERS_MIN[i] > PALIERS_MIN[i - 1],
      `le palier ${i} est plus long que le precedent`)
  }
  const total = PALIERS_MIN.reduce((a, b) => a + b, 0)
  assert.ok(total < 24 * 60, `les ${MAX_TENTATIVES_OTA} tentatives tiennent dans 24 h (${total} min)`)
  assert.ok(total > 8 * 60, 'et elles s etalent sur plusieurs heures, pas sur vingt minutes')
})

test('les deux cles de comptage ne se confondent pas', () => {
  // Une seule cle pour les deux compteurs rendrait un refus bloquant comme une
  // incertitude, ou l'inverse.
  assert.notEqual(cleEchec('B', 'T'), cleVerif('B', 'T'))
  assert.match(cleEchec('B', 'T'), /^OTAKEY:B:T;$/)
  assert.match(cleVerif('B', 'T'), /^OTAVERIF:B:T;$/)
  // ⚠ ET AUCUNE CLE N'EST SOUS-CHAINE D'UNE AUTRE. La lecture est un
  // `ilike '%cle%'` : sans terminateur, le compteur d'un message compterait les
  // refus d'un autre des qu'un identifiant est le prefixe d'un second.
  assert.ok(!cleEchec('B', 'T2').includes(cleEchec('B', 'T')),
    'un identifiant prefixe d un autre ne collisionne pas')
  assert.ok(!cleVerif('B1', 'T').includes(cleVerif('B', 'T')))
})

test('LE TEST QUI COMPTE : le verrou CLAIME, il n ecrase pas', () => {
  // ⚠ MUTATION QUI SURVIVAIT : remplacer `insert` par `upsert` rendait le
  // verrou inoffensif — il ne conflictue jamais, donc deux passes concurrentes
  // envoient toutes les deux. C'est la seule erreur irreversible de ce
  // mecanisme : un voyageur qui recoit deux fois le meme message.
  const ota = fs.readFileSync(path.join(__dirname, '..', 'lib/envoi-ota.js'), 'utf8')
  const tenir = ota.split('async function tenirEnvoi')[1].split('\n}\n')[0]
  assert.match(tenir, /\.from\('write_locks'\)\.insert\(/,
    'le verrou s obtient par un INSERT : le conflit de cle EST le signal')
  assert.ok(!/\.upsert\(/.test(tenir), 'jamais par un upsert, qui ne conflictue pas')
  // ⚠ UN CONFLIT N'EST PAS UNE PANNE, ET L'INVERSE NON PLUS (constat d'une
  // revue) : lire TOUTE erreur d'insert comme « un autre le tient » faisait
  // passer un tick en silence sur une panne de connexion. Le code `23505` est
  // la violation d'unicite de Postgres.
  assert.match(tenir, /error\.code === '23505'/, 'le conflit se reconnait a son code')
  assert.match(tenir, /conflit \? 'deja_tenu' : 'verrou_impossible'/,
    'et une panne qui n en est pas un empeche l envoi')
  const retours = [...tenir.matchAll(/return \{ ok: (true|false)/g)].map(m => m[1])
  assert.equal(retours.filter(x => x === 'true').length, 1,
    'un seul chemin autorise l envoi : celui ou la tenue est POSEE')
  // ⚠ ET ELLE DOIT SURVIVRE A L'INTERVALLE DU CRON, sinon elle ne protege de
  // rien (j'avais mis 2 minutes). ⚠ CE TEST NOMMAIT `/api/cron-messages`, ET
  // C'ETAIT LE MAUVAIS CRON : `processMessageTemplates` est appele par
  // `api/cron.js`, qui tourne en `*/5`. Mesurer l'intervalle du cron qu'on croit
  // concerne, c'est mesurer un nom. On prend donc le PLUS COURT des intervalles
  // declares : il majore tout cron qui pourrait atteindre ce chemin d'envoi,
  // aujourd'hui comme apres l'ajout d'un cron de plus.
  const ota2 = fs.readFileSync(path.join(__dirname, '..', 'lib/envoi-ota.js'), 'utf8')
  const ms = /const VERROU_MS = (\d+) \* 60 \* 1000/.exec(ota2)
  assert.ok(ms, 'la duree de la tenue est lisible')
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'))
  const cadences = (vercel.crons || [])
    .map(c => Number((/\*\/(\d+)/.exec(c.schedule) || [])[1]))
    .filter(Number.isFinite)
  assert.ok(cadences.length, 'au moins un cron periodique est declare')
  const minutes = Math.min(...cadences)
  assert.ok(Number(ms[1]) > minutes,
    `la tenue (${ms[1]} min) doit depasser l intervalle du cron (${minutes} min)`)
  // Et le jeton existe, sinon un trainard efface la tenue d un autre.
  assert.match(tenir, /const token = /, 'la tenue porte un jeton')
  assert.match(tenir, /token,/, 'ecrit en base')
  const relacher = ota2.split('async function relacherEnvoi')[1].split('\n}\n')[0]
  assert.match(relacher, /if \(token\) q = q\.eq\('token', token\)/,
    'et la liberation ne supprime que sa propre tenue')
  // Et la tenue expiree de CETTE cle est purgee avant : une fonction tuee en
  // plein vol ne bloque pas le message plus longtemps que le verrou.
  const iPurge = tenir.indexOf('.delete()')
  const iPose = tenir.indexOf('.insert(')
  assert.ok(iPurge > 0 && iPurge < iPose, 'la purge precede la pose')
})

test('LE TEST QUI COMPTE : un envoi reussi dont le journal rate est BLOQUE, pas rejoue', () => {
  // ⚠ MUTATION QUI SURVIVAIT, et defaut ANTERIEUR a ce correctif :
  // `noterEnvoi` hurle depuis septembre « LE MESSAGE PEUT REPARTIR AU PROCHAIN
  // TICK » sans que rien ne l empeche. Le message etait donc renvoye au
  // voyageur. On pose le blocage « a verifier », qui ne se rejoue jamais seul.
  const src2 = fs.readFileSync(path.join(__dirname, '..', 'lib/cron-messages.js'), 'utf8')
  const h = src2.split('async function envoyerEtJournaliser')[1]
    .split('async function processMessageTemplates')[0]
  const succes = h.split('if (sendRes?.ok) {')[1].split('\n  }\n')[0]
  assert.match(succes, /const note = await noterEnvoi\(/, 'le retour du journal est LU')
  assert.match(succes, /if \(note === false && estOta\) \{/, 'un journal inecrivable est vu')
  assert.match(succes, /noterAVerifierOta/, 'et il pose le blocage')
  assert.match(succes, /anti-doublon inecrivable/, 'en disant pourquoi')
})

// ── La structure du correctif, sur le fichier reel ─────────────────────────

const src = fs.readFileSync(path.join(__dirname, '..', 'lib/cron-messages.js'), 'utf8')
const helper = src.split('async function envoyerEtJournaliser')[1]
  .split('async function processMessageTemplates')[0]

test('LE TEST QUI COMPTE : une issue INCERTAINE ne rejoue RIEN et appelle un humain', () => {
  const bloc = helper.split(`if (issue === ISSUE.INCERTAIN) {`)[1].split('\n  }\n')[0]
  assert.match(bloc, /noterAVerifierOta/, 'elle pose la ligne « a verifier »')
  assert.ok(!/noterEnvoi/.test(bloc), 'elle n ecrit pas le journal')
  assert.ok(!/noterRefusOta/.test(bloc), 'et elle ne compte pas : il n y aura pas de rejeu')
  // Et l'incident porte de quoi trancher a la main : le voyageur et le TEXTE.
  const ota = fs.readFileSync(path.join(__dirname, '..', 'lib/envoi-ota.js'), 'utf8')
  const avis = ota.split('async function noterAVerifierOta')[1].split('\n}\n')[0]
  assert.match(avis, /threshold: 1/, 'elle alerte tout de suite')
  assert.match(avis, /voyageur/, 'elle nomme le voyageur')
  assert.match(avis, /extrait/, 'et elle porte le texte du message')
  // ⚠ UNE ALERTE SANS GESTE POSSIBLE NE SERT A RIEN (Thierry, 29 octobre 2026).
  // Elle doit nommer l'ECRAN et les pas, pas seulement constater.
  assert.match(avis, /NE REPARTIRA PAS SEUL/, 'elle dit qu aucun renvoi n aura lieu')
  assert.match(avis, /\/messages/, 'elle nomme l ecran ou agir')
  assert.match(avis, /Envoyer/, 'et le geste qui envoie')
  assert.match(avis, /l'acquitter\s*\`?\s*\+?\s*\`?\s*ne renvoie rien/,
    'et elle dit que l acquittement ne renvoie rien')
})

test('LE TEST QUI COMPTE : le blocage d une incertitude N EXPIRE PAS', () => {
  // ⚠ DEFAUT DE MON PROPRE CORRECTIF, trouve par la question de Thierry « ou et
  // comment je debloque un envoi incertain ? ». Je bornais les DEUX lectures a
  // 24 h : le blocage sautait donc tout seul au bout d une journee et le cron
  // renvoyait le message — le renvoi A L AVEUGLE que la decision interdit, et
  // le contraire exact de ce que l alerte promet. Le code dementait son texte.
  const ota = fs.readFileSync(path.join(__dirname, '..', 'lib/envoi-ota.js'), 'utf8')
  const porte = ota.split('async function peutTenterOta')[1].split('\n}\n')[0]
  const ligneVerif = porte.split('TYPE_AVERIF_OTA')[1].split('\n')[0]
  assert.match(ligneVerif, /\{ fenetre: false \}/,
    'la ligne « a verifier » se lit SANS fenetre : elle bloque tant qu elle existe')
  // Et le compteur de refus garde la sienne : un refus d hier ne doit pas peser.
  const ligneEchec = porte.split('lireLignes(TYPE_ECHEC_OTA')[1].split('\n')[0]
  assert.ok(!/fenetre: false/.test(ligneEchec), 'le compteur, lui, oublie au bout de 24 h')
  // La fenetre est bien appliquee par defaut.
  const lecture = ota.split('async function lireLignes')[1].split('\n}\n')[0]
  assert.match(lecture, /\{ fenetre = true \} = \{\}/, 'la fenetre est le defaut')
  assert.match(lecture, /if \(fenetre\) q = q\.gte\('created_at', depuis\)/,
    'et elle ne s applique que si on la demande')
})

test('LE TEST QUI COMPTE : les alarmes d envoi sont AFFICHEES, donc acquittables', () => {
  // ⚠ SANS CA, L ALERTE N EXISTE PAS POUR L HOTE. Le bandeau de /aujourdhui ne
  // servait que `overbooking` : une alerte d envoi etait ecrite en base, partait
  // par e-mail au fondateur, et restait INVISIBLE sur tous les ecrans — donc
  // impossible a acquitter, puisque le bouton n existe que sur une alarme
  // affichee. Une alerte que personne ne peut voir ni fermer est une ligne de
  // journal, pas une alerte.
  const ecran = fs.readFileSync(path.join(__dirname, '..', 'api/ecran/aujourdhui.js'), 'utf8')
  const bloc = ecran.split('TYPES_ALARME')[1].slice(0, 400)
  for (const t of ['overbooking', 'message_ota_a_verifier', 'message_ota_arret',
    'email_voyageur_abandon']) {
    assert.ok(bloc.includes(`'${t}'`), `${t} est servi au bandeau`)
  }
  // ⚠ ON MESURE LE MECANISME, PAS L ORTHOGRAPHE. Cette assertion citait
  // `.in('type', TYPES_ALARME)` au caractere ; la lecture a ete scindee en deux
  // familles (surreservation / envoi) et le filtre porte desormais le parametre
  // `types` — le test a rougi sur un refactor SANS defaut. Ce qui compte est
  // qu'on filtre par APPARTENANCE a une liste et jamais par egalite a un type
  // unique : c'est l'`eq('type', 'overbooking')` qui rendait l'alerte invisible.
  const lecture = ecran.split('const lireFamille')[1].slice(0, 600)
  assert.match(lecture, /\.in\('type', \w+\)/, 'par un `in`, pas un `eq`')
  assert.doesNotMatch(lecture, /\.eq\('type'/,
    'aucune egalite sur le type dans la lecture des alarmes')
  assert.match(ecran, /lireFamille\(TYPES_ALARME/,
    'et la liste des types atteint bien cette lecture')
  assert.match(lecture, /\.is\('acquitted_at', null\)/, 'et seules les alarmes OUVERTES')
})

test('LE TEST QUI COMPTE : la porte du rejeu est FERMEE par une incertitude', () => {
  const ota = fs.readFileSync(path.join(__dirname, '..', 'lib/envoi-ota.js'), 'utf8')
  const porte = ota.split('async function peutTenterOta')[1].split('\n}\n')[0]
  const iVerif = porte.indexOf('TYPE_AVERIF_OTA')
  const iPlafond = porte.indexOf('MAX_TENTATIVES_OTA')
  assert.ok(iVerif > 0 && iVerif < iPlafond,
    'l incertitude est lue AVANT le plafond : elle bloque quel que soit le compte')
  // ⚠ FAIL-SAFE DANS LE BON SENS : une panne de LECTURE laisse tenter, elle ne
  // condamne pas le message. Un message abandonne par une panne de lecture
  // serait le pire des deux maux.
  assert.match(porte, /motif: 'lecture_impossible'/)
  const retours = [...porte.matchAll(/return \{ ok: (true|false)/g)].map(m => m[1])
  assert.ok(retours.filter(x => x === 'true').length >= 3,
    'les deux pannes de lecture et le chemin nominal laissent tenter')
})

// ── Les constats HAUTS de la revue independante ────────────────────────────

test('LE TEST QUI COMPTE : une alarme AFFICHEE est ACQUITTABLE — les deux listes sont identiques', () => {
  // ⚠ CONSTAT HAUT, ET L'IRONIE DU LOT : j'avais rendu les alarmes d'envoi
  // visibles sur /aujourdhui en citant « impossible a acquitter » comme le
  // defaut a fermer — et `api/incidents-acquitter.js` filtrait toujours sur le
  // seul `overbooking`, en LECTURE comme en ECRITURE. Le POST du bouton rendait
  // 404, l'ecran basculait sur « Reessayer », et l'alarme restait pour
  // toujours. Le defaut etait DEPLACE d'un cran, pas ferme.
  //
  // Et mon test d'alors ne mesurait que l'affichage : le « donc acquittables »
  // de son nom n'etait verifie par rien.
  const lire = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
  const liste = (src, nom) => {
    // ⚠ LE TABLEAU EST SUR PLUSIEURS LIGNES : ma premiere lecture par regex
    // rougissait sur son propre echappement. On coupe entre les crochets.
    const i = src.indexOf('const ' + nom + ' = [')
    assert.ok(i > 0, nom + ' est lisible')
    const corps = src.slice(i, src.indexOf(']', i))
    return [...corps.matchAll(/'([a-z_]+)'/g)].map(x => x[1]).sort()
  }
  const affichees = liste(lire('api/ecran/aujourdhui.js'), 'TYPES_ALARME')
  const acquittables = liste(lire('api/incidents-acquitter.js'), 'TYPES_ACQUITTABLES')
  assert.deepEqual(affichees, acquittables,
    'tout type affiche au bandeau doit etre acquittable, et reciproquement')
  // ⚠ LA LISTE ATTENDUE EST CELLE DES TYPES QUI ALERTENT VRAIMENT — et on la
  // tire du CODE QUI LES POSE, pas d'une copie a la main. `message_ota_abandon`
  // a quitte l'ensemble avec la fonction qui le posait (il doublait l'arret) ;
  // `email_voyageur_abandon` y est entre, parce qu'il alerte en `threshold: 1`
  // et n'etait affiche nulle part.
  // ⚠ LA LISTE ATTENDUE SE DERIVE DU CODE QUI POSE LES ALARMES, pas d'une copie
  // a la main : `message_ota_abandon` a quitte l'ensemble avec la fonction qui
  // le posait (il doublait l'arret), et `email_voyageur_abandon` y est entre.
  // On exige donc que TOUT type pose par `lib/envoi-ota.js` en `threshold: 1`
  // soit affiche et acquittable — ainsi un type d'envoi ajoute demain ne peut
  // plus naitre invisible.
  const ota = lire('lib/envoi-ota.js')
  const constantes = Object.fromEntries(
    [...ota.matchAll(/^const (TYPE_\w+) = '([a-z_]+)'/gm)].map(m => [m[1], m[2]]))
  const reveillent = [...ota.matchAll(/reportIncident\(\s*(TYPE_\w+)\s*,\s*\{([^}]*)\}/g)]
    .filter(m => /threshold: 1\b/.test(m[2]))
    .map(m => constantes[m[1]])
  assert.ok(reveillent.length >= 2, 'les alarmes d envoi sont lisibles dans le module')
  for (const t of reveillent) {
    assert.ok(affichees.includes(t), `${t} reveille l hote, il doit etre affiche et acquittable`)
  }
  // ⚠ ET LE COTE E-MAIL, QUI EST LE MEME DEFAUT ROUVERT (constat d'une revue) :
  // `email_voyageur_abandon` alerte en `threshold: 1` depuis `cron-messages.js`
  // et n'etait dans aucune des deux listes.
  assert.match(lire('lib/cron-messages.js'), /reportIncident\('email_voyageur_abandon'/)
  assert.ok(affichees.includes('email_voyageur_abandon'),
    'l abandon d un e-mail voyageur doit etre affiche et acquittable')
  // ⚠ CE QUE CE TEST NE GARDE PAS, ET IL FAUT LE DIRE. En derivant cette liste
  // j'ai trouve que la MEME absence vaut pour une vingtaine d'autres types qui
  // reveillent l'hote avec un bien — `message_non_envoye` (« information
  // manquante », le plus proche de ce lot), `seam_failure`, `prix_sous_plancher`,
  // `menage_non_assigne`… Aucun n'apparait sur un ecran. Ce n'est pas un oubli
  // de ce lot : choisir lesquels meritent le bandeau est une decision produit,
  // elle est remontee a Thierry, et l'elargir ici noierait exactement l'ecran
  // qu'il demande de proteger.
  for (const t of ['overbooking', 'message_ota_a_verifier', 'message_ota_arret']) {
    assert.ok(affichees.includes(t), `${t} est dans l ensemble`)
  }
  assert.ok(!affichees.includes('message_ota_abandon'),
    'et le type qui doublait l arret a disparu des deux cotes')
  // Et le filtre d'acquittement n'est plus un `eq` sur un seul type.
  const acq = lire('api/incidents-acquitter.js')
  assert.ok(!/\.eq\('type', 'overbooking'\)/.test(acq), 'plus aucun filtre sur un type unique')
  assert.equal((acq.match(/\.in\('type', TYPES_ACQUITTABLES\)/g) || []).length, 2,
    'et les DEUX requetes — lecture et ecriture — portent la liste')
})

test('LE TEST QUI COMPTE : l arret est lu AVANT tout le reste, et sans fenetre', () => {
  // ⚠ CE QUE CE TEST NE MESURE PLUS, ET POURQUOI. Il verifiait que la source de
  // `cron-messages.js` CONTIENT `noterArretOta` dans la branche du plafond —
  // `plafond.indexOf('noterArretOta')`. Il est reste VERT alors que cette
  // branche etait devenue INATTEIGNABLE : une pre-porte en amont retournait
  // sans rien poser. Mesurer qu une ligne est ecrite n est pas mesurer qu elle
  // s execute. L effet se mesure maintenant en APPELANT la porte :
  // tests/porte-ota-execution.test.js. Ce qui reste ici est ce qui se lit
  // vraiment dans le texte : l ORDRE des lectures de la porte.
  const ota = fs.readFileSync(path.join(__dirname, '..', 'lib/envoi-ota.js'), 'utf8')
  const porte = ota.split('async function peutTenterOta')[1].split('\n}\n')[0]
  const iArret = porte.indexOf('TYPE_ARRET_OTA')
  const iVerif = porte.indexOf('TYPE_AVERIF_OTA')
  const iPlafond = porte.indexOf('MAX_TENTATIVES_OTA')
  assert.ok(iArret > 0 && iArret < iVerif && iVerif < iPlafond,
    'arret, puis a verifier, puis le plafond')
  // Et SANS fenetre : sinon le message repart le lendemain.
  const ligne = porte.split('TYPE_ARRET_OTA')[1].split('\n')[0]
  assert.match(ligne, /\{ fenetre: false \}/, 'un arret n expire pas')
  // ⚠ UN SEUL DECIDEUR. La porte est consultee par les deux moteurs AVANT la
  // generation ; en garder une copie dans `envoyerEtJournaliser` remettait la
  // decision en aval d un `return` deja pris — c est ce qui a rendu la branche
  // du plafond inatteignable — et coutait trois lectures Supabase de plus par
  // message.
  const src2 = fs.readFileSync(path.join(__dirname, '..', 'lib/cron-messages.js'), 'utf8')
  const h = src2.split('async function envoyerEtJournaliser')[1]
    .split('async function processMessageTemplates')[0]
  assert.ok(!h.includes('peutTenterOta') && !h.includes('porteOta('),
    'l envoi ne reinterroge pas la porte : un seul endroit decide')
  // Une issue PERMANENTE, elle, est connue APRES l appel au provider : c est le
  // seul arret que l envoi pose encore.
  const permanent = h.split('if (issue === ISSUE.PERMANENT) {')[1].split('\n  }\n')[0]
  assert.match(permanent, /noterArretOta/, 'une issue PERMANENTE arrete le message')
  // ⚠ ET UNE SEULE ALARME : `noterAbandonOta` doublait l arret sous un autre
  // type, donc deux cartes, deux SMS, deux e-mails pour un seul echec.
  assert.ok(!src2.includes('noterAbandonOta'), 'plus de seconde alarme')
  assert.ok(!ota.match(/^async function noterAbandonOta/m), 'ni de fonction pour la poser')
})

test('LE TEST QUI COMPTE : la porte ne ferme QUE le mode Auto, jamais la proposition', () => {
  // ⚠ CONSTAT D UNE REVUE INDEPENDANTE, VERIFIE. J avais place la porte du
  // rejeu AVANT `getPropertyMode`, pour economiser l appel payant a Haiku. Mais
  // en mode Test, le cron n ENVOIE rien : il depose une PROPOSITION que l hote
  // valide a la main. Une ligne d arret — posee parce que l envoi automatique a
  // echoue cinq fois — etouffait donc aussi la proposition, et retirait a l hote
  // le seul chemin qui lui restait pour envoyer ce message lui-meme. L alerte
  // lui disait « faites-le depuis /messages » pendant que le code lui en
  // supprimait le moyen.
  //
  // En mode Test il n y a pas d envoi, donc pas de rejeu a plafonner : la porte
  // n a rien a y faire. Elle se lit donc APRES le mode, et sous sa condition.
  const src2 = fs.readFileSync(path.join(__dirname, '..', 'lib/cron-messages.js'), 'utf8')
  for (const fonction of ['checkAndSendTemplate', 'triggerTemplates']) {
    const bloc = src2.split(`async function ${fonction}`)[1].split('\nasync function ')[0]
    const iMode = bloc.indexOf('getPropertyMode(')
    const iPorte = bloc.indexOf('porteOta(')
    assert.ok(iMode > 0 && iMode < iPorte,
      `${fonction} lit le mode du bien AVANT la porte`)
    // Et la porte est SOUS la condition du mode Auto, pas a cote.
    const avant = bloc.slice(0, iPorte)
    const condition = avant.slice(avant.lastIndexOf('if ('))
    assert.match(condition, /propMode === 'auto'/,
      `${fonction} ne ferme la porte qu en mode Auto`)
    // ⚠ ET UNE SEULE LECTURE DU MODE : la deplacer en avait laisse une seconde
    // plus bas, donc deux requetes pour la meme reponse.
    assert.equal((bloc.match(/getPropertyMode\(/g) || []).length, 1,
      `${fonction} ne lit le mode qu une fois`)
  }
})

test('LE TEST QUI COMPTE : la porte est franchie AVANT l appel payant a Haiku', () => {
  // ⚠ CONSTAT D UNE REVUE : `generateAutoMessage` est un appel Anthropic, et il
  // tournait AVANT la porte. Un message en palier, en plafond ou arrete payait
  // donc un appel toutes les dix minutes. Avant le correctif, le
  // `message_sent_log` ecrit avant l envoi court-circuitait des le second
  // tick — le correctif avait retire ce frein sans le remplacer.
  const src2 = fs.readFileSync(path.join(__dirname, '..', 'lib/cron-messages.js'), 'utf8')
  for (const fonction of ['checkAndSendTemplate', 'triggerTemplates']) {
    const bloc = src2.split(`async function ${fonction}`)[1].split('\nasync function ')[0]
    const iPorte = bloc.indexOf('porteOta(')
    const iHaiku = bloc.indexOf('generateAutoMessage(')
    assert.ok(iPorte > 0, `${fonction} franchit la porte`)
    assert.ok(iHaiku > 0, `${fonction} genere le message`)
    assert.ok(iPorte < iHaiku,
      `${fonction} : la porte precede l appel payant (porte ${iPorte}, Haiku ${iHaiku})`)
  }
})

test('les trois types neufs portent un LIBELLE, pas leur cle brute', () => {
  // `LABELS[type] || type` mettait « message_ota_a_verifier » en objet du SMS
  // et de l e-mail fondateur.
  const fn = fs.readFileSync(path.join(__dirname, '..', 'lib/founder-notify.js'), 'utf8')
  const i = fn.indexOf('const LABELS')
  assert.ok(i > 0, 'la table des libelles est lisible')
  const labels = fn.slice(i, fn.indexOf('\n}', i))
  for (const t of ['message_ota_a_verifier', 'message_ota_abandon', 'message_ota_arret']) {
    assert.ok(labels.includes(t), `${t} a son libelle`)
  }
  assert.match(labels, /ENVOI AU VOYAGEUR/, 'et le libelle dit de quoi il s agit')
})

test('LE TEST QUI COMPTE : « je n ai pas su lire la reponse » n est pas « il a refuse »', () => {
  // ⚠ CONSTAT D UNE REVUE, AFFINE ICI. Ces trois codes sont les NOTRES, poses
  // par `channelCall` quand le corps est illisible, vide ou de forme
  // inattendue : le provider a PU traiter le message et c est nous qui ne
  // comprenons pas sa reponse. Les classer refus les rejouait, donc un envoi en
  // DOUBLE au voyageur.
  //
  // ⚠ ET CE TEST FIGEAIT UN DEFAUT (regle 17 de REVIEW.md). Il exigeait
  // INCERTAIN meme en 422, sur ce raisonnement ecrit ici : « un statut ne
  // rachete pas une reponse qu on ne sait pas lire ». C est faux, et le cas
  // reel de la production le montre : un 429 dont le corps est une page HTML de
  // passerelle — la forme la plus banale d une limite de debit — tombait en
  // INCERTAIN, donc BLOQUE jusqu a un geste de l hote, alors que c est
  // exactement le cas qui merite un rejeu au palier suivant. La lisibilite du
  // CORPS ne dit rien de ce que le provider a fait du message ; le STATUT, lui,
  // le dit. Constat d une revue independante, verifie avant correction.
  for (const code of ['reponse_non_json', 'forme_inattendue', 'reponse_vide']) {
    assert.equal(classerEnvoiOta({ ok: false, status: 200, error: code }), ISSUE.INCERTAIN,
      `${code} en 2xx met en doute, il ne rejoue pas`)
    assert.equal(classerEnvoiOta({ ok: false, error: code }), ISSUE.INCERTAIN,
      `${code} sans statut non plus`)
    // ⚠ MAIS UN STATUT LU >= 400 TRANCHE : le provider a repondu, il n a pas
    // pris le message. C est le symptome du 29 octobre 2026, et il doit se
    // rejouer, pas se bloquer.
    assert.equal(classerEnvoiOta({ ok: false, status: 429, error: code }), ISSUE.REFUS,
      `${code} en 429 est un refus : il se rejoue au palier`)
    assert.equal(classerEnvoiOta({ ok: false, status: 422, error: code }), ISSUE.REFUS,
      `${code} en 422 aussi`)
    // ⚠ MAIS PAS UN 5xx NI UN 408, ET C EST UN CONSTAT DE LA TROISIEME REVUE.
    // J avais ecrit ici que « le plafond le borne » : il borne a CINQ doublons,
    // pas a zero. Un 502/503/504/408 au corps illisible est le timeout d une
    // passerelle : la requete a pu etre TRAITEE avant qu elle abandonne, donc
    // rejouer envoie le message une seconde fois au voyageur — la seule erreur
    // irreversible de tout ce mecanisme. Il reste donc INCERTAIN, comme avant
    // ce chantier.
    for (const st of [500, 502, 503, 504, 408]) {
      assert.equal(classerEnvoiOta({ ok: false, status: st, error: code }), ISSUE.INCERTAIN,
        `${code} en ${st} ne se rejoue pas : la requete a pu aboutir`)
    }
  }
  // Et un code DU PROVIDER reste un refus, quel que soit le statut — y compris
  // en 5xx : si le provider a su nous repondre, il a traite la requete et l a
  // refusee. C est la lisibilite du corps qui departage, pas le statut seul.
  assert.equal(classerEnvoiOta({ ok: false, status: 422, error: 'not_supported' }), ISSUE.REFUS)
  assert.equal(classerEnvoiOta({ ok: false, status: 200, error: 'http_too_many_requests' }), ISSUE.REFUS)
  assert.equal(classerEnvoiOta({ ok: false, status: 503, error: 'not_supported' }), ISSUE.REFUS)
  // ⚠ ET LE CAS DE LA PRODUCTION, NOMMEMENT : 429 au corps illisible, qui doit
  // se rejouer au palier et non se bloquer.
  assert.equal(classerEnvoiOta({ ok: false, status: 429, error: 'reponse_non_json' }), ISSUE.REFUS)
})

test('LE TEST QUI COMPTE : Beds24 lit son STATUT HTTP avant de lire son corps', () => {
  // ⚠ CONSTAT D UNE REVUE : seul `result.success === false` etait teste. Un 429
  // ou un 500 dont le corps ne porte pas ce champ passait donc pour un SUCCES,
  // et le message etait marque envoye sans avoir ete recu — le defaut meme que
  // ce chantier ferme, par une autre porte.
  const b24 = fs.readFileSync(path.join(__dirname, '..', 'lib/cron-beds24.js'), 'utf8')
  const envoi = b24.split('async function sendViaBeds24')[1].split('\n}\n')[0]
  const iStatut = envoi.indexOf('if (!r.ok)')
  const iCorps = envoi.indexOf('await r.json()')
  assert.ok(iStatut > 0, 'le statut est teste')
  assert.ok(iStatut < iCorps, 'et AVANT la lecture du corps')
  const bloc = envoi.slice(iStatut, iStatut + 300)
  assert.match(bloc, /refus: true/, 'un statut d echec est un REFUS, donc rejouable')
  assert.match(bloc, /status: r\.status/, 'et il porte son statut, pour le diagnostic')
})
