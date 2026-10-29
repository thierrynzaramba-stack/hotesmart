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
  // rien : `/api/cron-messages` tourne en `*/10`, et j'avais mis 2 minutes.
  const ota2 = fs.readFileSync(path.join(__dirname, '..', 'lib/envoi-ota.js'), 'utf8')
  const ms = /const VERROU_MS = (\d+) \* 60 \* 1000/.exec(ota2)
  assert.ok(ms, 'la duree de la tenue est lisible')
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'))
  const cm = (vercel.crons || []).find(c => String(c.path).includes('cron-messages'))
  assert.ok(cm, 'le cron des messages est declare')
  const minutes = Number(/\*\/(\d+)/.exec(cm.schedule)[1])
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
  for (const t of ['overbooking', 'message_ota_a_verifier', 'message_ota_abandon']) {
    assert.ok(bloc.includes(`'${t}'`), `${t} est servi au bandeau`)
  }
  assert.match(ecran, /\.in\('type', TYPES_ALARME\)/, 'par un `in`, pas un `eq`')
  assert.match(ecran, /\.is\('acquitted_at', null\)/, 'et seules les alarmes OUVERTES')
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
  for (const t of ['overbooking', 'message_ota_a_verifier', 'message_ota_abandon', 'message_ota_arret']) {
    assert.ok(affichees.includes(t), `${t} est dans l ensemble`)
  }
  // Et le filtre d'acquittement n'est plus un `eq` sur un seul type.
  const acq = lire('api/incidents-acquitter.js')
  assert.ok(!/\.eq\('type', 'overbooking'\)/.test(acq), 'plus aucun filtre sur un type unique')
  assert.equal((acq.match(/\.in\('type', TYPES_ACQUITTABLES\)/g) || []).length, 2,
    'et les DEUX requetes — lecture et ecriture — portent la liste')
})

test('LE TEST QUI COMPTE : un ARRET bloque definitivement, et n alerte qu une fois', () => {
  // ⚠ CONSTAT HAUT : `noterAbandonOta` ne faisait que REPORTER un incident.
  // Rien ne bloquait le message : au tick suivant le provider etait rappele,
  // l issue etait permanente a nouveau, et un NOUVEL incident insere —
  // ~144 appels et 144 incidents par jour jusqu a la fin du sejour. Et la regle
  // etait ecrite dix lignes plus haut, pour l e-mail.
  const ota = fs.readFileSync(path.join(__dirname, '..', 'lib/envoi-ota.js'), 'utf8')
  const porte = ota.split('async function peutTenterOta')[1].split('\n}\n')[0]
  // L arret est lu EN PREMIER : avant « a verifier », avant le plafond.
  const iArret = porte.indexOf('TYPE_ARRET_OTA')
  const iVerif = porte.indexOf('TYPE_AVERIF_OTA')
  const iPlafond = porte.indexOf('MAX_TENTATIVES_OTA')
  assert.ok(iArret > 0 && iArret < iVerif && iVerif < iPlafond,
    'arret, puis a verifier, puis le plafond')
  // Et SANS fenetre : sinon le message repart le lendemain.
  const ligne = porte.split('TYPE_ARRET_OTA')[1].split('\n')[0]
  assert.match(ligne, /\{ fenetre: false \}/, 'un arret n expire pas')
  // Les deux causes d arret le POSENT.
  const src2 = fs.readFileSync(path.join(__dirname, '..', 'lib/cron-messages.js'), 'utf8')
  const h = src2.split('async function envoyerEtJournaliser')[1]
    .split('async function processMessageTemplates')[0]
  const permanent = h.split('if (issue === ISSUE.PERMANENT) {')[1].split('\n  }\n')[0]
  assert.match(permanent, /noterArretOta/, 'une issue PERMANENTE arrete le message')
  const plafond = h.split("porte.motif === 'plafond'")[1].split('\n      }\n')[0]
  assert.match(plafond, /noterArretOta/, 'le plafond atteint aussi')
  // ⚠ L ORDRE COMPTE : l arret AVANT l alerte, sinon la porte ne le voit pas au
  // tick suivant et l alerte repart.
  assert.ok(plafond.indexOf('noterArretOta') < plafond.indexOf('noterAbandonOta'),
    'l arret est pose avant l alerte')
  assert.ok(permanent.indexOf('noterArretOta') < permanent.indexOf('noterAbandonOta'))
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
  for (const code of ['reponse_non_json', 'forme_inattendue', 'reponse_vide']) {
    assert.equal(classerEnvoiOta({ ok: false, status: 200, error: code }), ISSUE.INCERTAIN,
      `${code} met en doute, il ne rejoue pas`)
    // Meme en 4xx : un statut ne rachete pas une reponse qu on ne sait pas lire.
    assert.equal(classerEnvoiOta({ ok: false, status: 422, error: code }), ISSUE.INCERTAIN,
      `${code} en 422 non plus`)
  }
  // Et un code DU PROVIDER reste un refus, quel que soit le statut.
  assert.equal(classerEnvoiOta({ ok: false, status: 422, error: 'not_supported' }), ISSUE.REFUS)
  assert.equal(classerEnvoiOta({ ok: false, status: 200, error: 'http_too_many_requests' }), ISSUE.REFUS)
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
