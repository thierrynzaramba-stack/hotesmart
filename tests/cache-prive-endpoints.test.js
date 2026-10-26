// tests/cache-prive-endpoints.test.js
//
// ⚠ L'INTERDIT DE LA SPEC PERFORMANCE : « aucune donnee d'hote dans un cache
// partage ; Cache-Control private uniquement ».
//
// MESURE DU 22 OCTOBRE 2026 CONTRE LA PRODUCTION : sur les 49 endpoints qui
// appellent `requirePermission` ou `verifierSession`, UN SEUL posait un en-tete
// de cache (`api/logement.js`). Les 48 autres retombaient sur le defaut de
// Vercel, `public, max-age=0, must-revalidate`, verifie endpoint par endpoint
// en HTTPS.
//
// ⚠ CE N'ETAIT PAS UNE FUITE, ET C'EST POUR CA QU'IL FALLAIT LE FERMER AVANT
// D'AJOUTER LE MOINDRE CACHE. `max-age=0, must-revalidate` ne garde rien. Mais
// la directive dit `public` : elle AUTORISE un cache partage a stocker la
// reponse, et il ne manque qu'un `s-maxage` — ajoute un jour pour accelerer un
// ecran — pour qu'un CDN serve a un hote les chiffres d'un autre.
//
// ⚠ ET L'EN-TETE EST POSE DANS LA GARDE, PAS DANS LES ENDPOINTS. Un point
// unique ne peut pas etre oublie par le prochain endpoint qu'on ecrira — c'est
// le meme choix que l'enveloppe du client Anthropic dans `lib/cron-shared.js`.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const racine = path.join(__dirname, '..')
const { posterEnTetesPrives } = require('../lib/require-permission')

function fausseReponse () {
  const r = { entetes: {}, code: null, headersSent: false }
  r.setHeader = (k, v) => { r.entetes[String(k).toLowerCase()] = v; return r }
  r.status = (c) => { r.code = c; return r }
  r.json = () => { r.headersSent = true; return r }
  return r
}

test('LE TEST QUI COMPTE : la garde pose private, no-store et vary', () => {
  const res = fausseReponse()
  posterEnTetesPrives(res)
  assert.equal(res.entetes['cache-control'], 'private, no-store',
    'private : jamais public sur une donnee de compte')
  assert.equal(res.entetes.vary, 'authorization, x-compte',
    'la reponse depend du jeton ET du compte choisi par le selecteur')
})

test('la garde ne leve pas sur une reponse deja envoyee ni sur un objet nu', () => {
  // Deux appels de garde dans le meme endpoint (cas reel : verifierSession
  // puis requirePermission) : le second arrive apres un 401 eventuel.
  const res = fausseReponse()
  res.headersSent = true
  posterEnTetesPrives(res)
  assert.deepEqual(res.entetes, {}, 'aucun en-tete pose sur une reponse envoyee')
  posterEnTetesPrives(null)
  posterEnTetesPrives({})
  posterEnTetesPrives({ setHeader () { throw new Error('en-tete refuse') } })
})

test('LE TEST QUI COMPTE : les DEUX gardes la posent, et avant tout refus', async () => {
  // ⚠ UN 401 PORTE AUSSI L'EN-TETE. Une reponse de refus parle du compte
  // appelant : la mettre dans un cache partage dirait a qui demande que ce
  // jeton-la est invalide.
  const { verifierSession, requirePermission } = require('../lib/require-permission')
  for (const [nom, appeler] of [
    ['verifierSession', (res) => verifierSession({ headers: {} }, res)],
    ['requirePermission', (res) => requirePermission({ headers: {} }, res, { domaine: 'reglages' })]
  ]) {
    const res = fausseReponse()
    await appeler(res)
    assert.equal(res.entetes['cache-control'], 'private, no-store',
      `${nom} doit poser l en-tete AVANT de repondre 401`)
    assert.equal(res.code, 401, `${nom} refuse bien sans jeton`)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// LE FILET : aucun endpoint ne doit reouvrir ce que la garde ferme
// ═══════════════════════════════════════════════════════════════════════════

// ⚠ RECURSIF, ET IL NE L'ETAIT PAS. Le lot (b) du chantier performance a cree
// le PREMIER sous-repertoire de `api/` — `api/ecran/`, qui est le domicile
// declare de tous les endpoints d'ecran des lots (c) et (d). Mesure du
// 23 octobre 2026 : 58 fichiers a plat, 59 en recursif, et le seul manquant
// etait `api/ecran/aujourdhui.js`. Il echappait donc a CE filet (l'interdit 1
// de la spec : aucune donnee d'hote dans un cache partage), aux deux
// recensements de garde, et au filet des lectures non bornees de
// `bookings_snapshot` — table qu'il lit.
// Trois autres fichiers portaient la meme cecite ; ils sont corriges dans le
// meme commit.
// Le parcours vit dans `tests/outils/source.js` : cinq copies du meme
// balayage recursif ont ete ecrites le meme jour dans cinq fichiers, et une
// sixieme aurait eu le meme angle mort que les cinq autres.
const { fichiersJs } = require('./outils/source')
function fichiersApi () {
  return fichiersJs(path.join(racine, 'api'), 'api')
}
const lire = (f) => fs.readFileSync(path.join(racine, f), 'utf8')
// Sans les commentaires : une mention dans une explication ne compte pas.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')

// ⚠ UNE EXEMPTION SE COMPTE, ELLE NE SE DECRIT PAS. La valeur est ce qu'on
// ATTEND de trouver : une de plus ou une de moins, et le test parle.
const PUBLIC_ATTENDU = {
  // Le manifeste PWA de l'app prestataire. Il porte le PRENOM de la
  // prestataire, donc une donnee de compte — mais il est cle sur le jeton
  // present dans l'URL, donc un cache partage ne peut pas servir le manifeste
  // de l'une a l'autre : la cle differe. Et un manifeste se recupere a
  // l'installation de l'application, ou les 300 s valent cher.
  // ⚠ CE QU'ON ACCEPTE EN L'EXEMPTANT, DIT PLUTOT QUE TAIT : une prestataire
  // desactivee garde son manifeste pendant cinq minutes.
  'api/manifest.js': 'public, max-age=300'
}

test('LE TEST QUI COMPTE : le recensement voit TOUT api/**/*.js, sous-repertoires compris', () => {
  // ⚠ CE TEST GARDE LE FILET LUI-MEME. Le lot (b) a cree `api/ecran/`, le
  // premier sous-repertoire de `api/`, et le balayage A PLAT ne le voyait pas :
  // 58 fichiers contre 59 (mesure du 23 octobre 2026). L'endpoint d'ecran
  // echappait donc a l'interdit 1 de la spec (aucune donnee d'hote dans un
  // cache partage), aux deux recensements de garde, et au filet des lectures
  // non bornees de `bookings_snapshot` — table qu'il lit.
  // `api/ecran/` est le domicile DECLARE de tous les endpoints d'ecran des
  // lots (c) et (d) : un filet aveugle a ce repertoire se vide a mesure que le
  // chantier avance, sans jamais casser.
  // ⚠ ET PAS CONTRE UNE DEUXIEME COPIE DU MEME PARCOURS — CE SERAIT UNE
  // TAUTOLOGIE : deux implementations identiques partagent leurs angles morts,
  // et le test resterait vert. On compare au SYSTEME DE FICHIERS par un autre
  // chemin (`fs.globSync`), et on exige en plus le fichier nomme.
  const parGlob = fs.globSync
    ? fs.globSync('**/*.js', { cwd: path.join(racine, 'api') }).map(f => `api/${f.split(path.sep).join('/')}`)
    : null
  const vus = fichiersApi()
  if (parGlob) {
    assert.deepEqual(vus.slice().sort(), parGlob.slice().sort(),
      'le recensement des endpoints ne voit pas les memes fichiers que le systeme')
  }
  // Le fichier NOMME : un balayage a plat le perd, et c'est le seul endpoint
  // d'ecran existant — donc le temoin de toute la famille a venir.
  assert.ok(vus.includes('api/ecran/aujourdhui.js'),
    "api/ecran/aujourdhui.js echappe au recensement : balayage a plat ?")
  assert.ok(vus.some(f => f.split('/').length > 2),
    'aucun endpoint en sous-repertoire : ce test ne prouve plus rien')
})

test('LE TEST QUI COMPTE : aucun endpoint ne pose un cache-control PUBLIC', () => {
  const fautifs = []
  for (const f of fichiersApi()) {
    const src = code(lire(f))
    // On cherche la VALEUR posee, pas le nom de l'en-tete : `s-maxage` et
    // `public` sont les deux formes qui ouvrent un cache partage.
    const m = src.match(/setHeader\(\s*['"]cache-control['"]\s*,\s*['"]([^'"]*)['"]/gi) || []
    for (const pose of m) {
      const v = (pose.match(/,\s*['"]([^'"]*)['"]/) || [])[1] || ''
      if (/\bpublic\b|s-maxage/i.test(v)) fautifs.push(`${f} : « ${v} »`)
    }
  }
  const attendus = Object.entries(PUBLIC_ATTENDU).map(([f, v]) => `${f} : « ${v} »`).sort()
  assert.deepEqual(fautifs.sort(), attendus,
    'un endpoint qui pose `public` ou `s-maxage` autorise un cache partage a garder\n' +
    'une donnee de compte. UN DE PLUS que PUBLIC_ATTENDU : nommez pourquoi il est\n' +
    'legitime, et ce qu on accepte en l exemptant, avant de l ajouter. UN DE MOINS :\n' +
    'il a ete corrige, retirez-le pour qu il soit protege.')
})

test('RECENSEMENT : tout endpoint a donnee de compte passe par une des deux gardes', () => {
  // ⚠ C'est cet invariant qui fait tenir le reste. L'en-tete vit dans les
  // gardes : un endpoint qui lirait une donnee de compte SANS garde n aurait ni
  // l en-tete, ni le controle de droits — et le premier defaut serait le second.
  // ⚠ ET IL NE DIT PAS « toutes ses reponses portent l en-tete » : un endpoint
  // peut refuser une methode AVANT d appeler sa garde. Cette surface est
  // comptee par le test suivant, pas supposee nulle (constat de review).
  // Les endpoints LEGITIMEMENT sans garde sont comptes ici, un par un.
  const SANS_GARDE_ATTENDU = fichiersApi().filter(f => {
    const src = code(lire(f))
    // ⚠ `contexteDEcran` EST UNE TROISIEME GARDE, ET LE DETECTEUR L'IGNORAIT.
    // C'est la garde des endpoints `/api/ecran/*` : un ecran traverse
    // plusieurs domaines, donc `requirePermission` — qui verifie UN domaine et
    // refuse en 403 — ne peut pas lui servir. Elle appelle `verifierSession` et
    // `posterEnTetesPrives` comme les deux autres.
    // Sans ce nom, rendre le recensement recursif aurait ajoute
    // `api/ecran/aujourdhui.js` a la liste des endpoints SANS garde — un FAUX
    // POSITIF, qui invite a lever le plafond au lieu d'apprendre le nom. C'est
    // la facon dont un filet se perd : non pas en cassant, mais en criant
    // faux.
    return !/requirePermission|verifierSession|requirePermissionPourCanal|contexteDEcran/.test(src)
  })
  // ⚠ LE PLAFOND SERRE SUR LA MESURE. Il etait a 12 pour 9 reels (mesure du
  // 23 octobre 2026, recensement RECURSIF) : trois endpoints sans garde
  // pouvaient atterrir en silence. Un plafond mou est un plafond qui ne sert
  // qu'une fois.
  assert.ok(SANS_GARDE_ATTENDU.length <= 9,
    `${SANS_GARDE_ATTENDU.length} endpoints sans garde :\n  ` + SANS_GARDE_ATTENDU.join('\n  ') +
    '\nUn de plus qu attendu : soit il est public par nature (webhook, cron, manifest,\n' +
    'page publique), soit il lui manque sa garde. Nommez-le avant de lever le plafond.')
  const avecGarde = fichiersApi().length - SANS_GARDE_ATTENDU.length
  assert.ok(avecGarde >= 45,
    `${avecGarde} endpoints gardes (49 le 22 octobre 2026) : si ce compte s effondre, ` +
    'ce n est pas la surface qui a disparu, c est le recensement')
})

// ─── Les constats de la review du 22 octobre 2026 ────────────────────────────

test('LE TEST QUI COMPTE : la garde de CANAL pose l en-tete avant ses quatre refus', async () => {
  // ⚠ CONSTAT DE REVIEW : « un point unique ne peut pas etre oublie » n est
  // vrai que si TOUTES les sorties passent par lui.
  // `requirePermissionPourCanal` refusait quatre fois — 400 `channel_id
  // requis`, 502 lecture canal, 404 canal introuvable, 403 canal rattache a un
  // autre bien — AVANT de deleguer a `requirePermission`, donc avant l en-tete.
  const { requirePermissionPourCanal } = require('../lib/require-permission')
  const res = fausseReponse()
  await requirePermissionPourCanal({ headers: {} }, res, { channelId: null })
  assert.equal(res.entetes['cache-control'], 'private, no-store',
    'le refus `channel_id requis` doit porter l en-tete comme les autres')
  assert.equal(res.code, 400, 'et c est bien le premier refus, avant toute lecture')
})

// ⚠ LA LISTE EST PAR REPONSE, PAS PAR FICHIER — et la premiere version de cette
// exemption etait par FICHIER, ce qui faisait du seul endpoint portant sa propre
// autorisation le seul que l'audit ne protegeait plus. Constat de la re-review,
// prouve par injection : un `select('*')` sur `api_keys` rendu en 200 AU-DESSUS
// du `if (!user) return 401` d'`api/sms.js` — donc la cle Brevo de tous les
// hotes, sans authentification — laissait la suite a 14 verts.
//
// `api/sms.js` ne passe par AUCUNE garde partagee : il resout `user` lui-meme
// (`supabase.auth.getUser`), borne chaque requete par `user_id`, et chacune de
// ses reponses a donnee de compte est derriere un `if (!user) return 401`
// (l.197, 227, 254, 273). L'autorisation est donc bien la, AVANT la donnee —
// c'est l'en-tete prive qui manquait, et il est pose a la main en tete du
// handler depuis le 22 octobre 2026.
//
// ⚠ ON NE L'EXEMPTE PAS EN ELARGISSANT LA SONDE A `auth.getUser(` : ce motif
// exempterait AUSSI, en silence, un futur endpoint qui appellerait `getUser`
// sans rien faire de son resultat. Une liste de REPONSES se relit ; un motif
// plus large ne se relit pas.
//
// Ces deux-la sont les SEULES reponses a donnee de compte emises avant une
// garde partagee, dans tout `api/`. Une de plus : un endpoint parle avant
// d'avoir verifie quoi que ce soit. Une de moins : `api/sms.js` a ete nettoye
// ou range sous une garde, et il faut la retirer d'ici pour qu'il soit protege
// comme les autres.
const AVANT_GARDE_ATTENDU = [
  // GET ?action=config — la configuration Brevo du proprietaire, derriere le 401 de la l.197.
  'api/sms.js : configured: !!data?.brevo_api_key,\n        enabled:    data?.brevo_ena',
  // GET — l'historique sms_logs, derriere le 401 de la l.254.
  'api/sms.js : logs: data'
]

test('LE TEST QUI COMPTE : ce qui repond AVANT la garde ne porte aucune donnee de compte', () => {
  // ⚠ L'INVARIANT EXACT, ET POURQUOI CE N'EST PAS « tous les endpoints posent
  // l'en-tete ».
  //
  // Verification HTTPS du 22 octobre 2026 demandee par Thierry, apres le merge
  // prod du lot (a) : 8 endpoints sur 12 rendaient `private, no-store`, et
  // QUATRE rendaient encore `public, max-age=0, must-revalidate` —
  // `/api/membres`, `/api/yield`, `/api/channel-property`,
  // `/api/guestflow-proposer`. Tous les quatre repondaient AVANT leur garde
  // (methode refusee, action inconnue, jeton absent).
  //
  // ⚠ J'AI D'ABORD VOULU POSER L'EN-TETE EN TETE DES 29 HANDLERS CONCERNES.
  // Mesure : 27 tests rouges d'un coup. TRENTE-SIX fichiers de test doublent
  // `lib/require-permission`, et ceux qui construisent un double PARTIEL
  // n'exportent pas la fonction — `posterEnTetesPrives is not a function`. Une
  // fonction que 29 handlers doivent appeler et que 36 doubles doivent fournir
  // n'est pas un « point unique » : c'est 29 couplages de plus. Correctif
  // defait.
  //
  // ⚠ ET DECLARER LES 49 ENDPOINTS DANS `vercel.json` AURAIT COUTE ~300 LIGNES
  // DE CONFIGURATION pour des corps d'erreur generiques. Un en-tete `public`
  // sur une reponse qui ne porte rien n'expose rien.
  //
  // L'INVARIANT QUI EST VRAI, ET QUE CE TEST TIENT : toute reponse qui porte
  // une donnee de compte passe par une garde, et la garde pose
  // `private, no-store`. Ce qui repond AVANT la garde ne porte que des corps
  // GENERIQUES — une methode, un parametre, un jeton. C'est verifiable, et
  // c'est ce qu'on verifie.
  const fautifs = []
  for (const f of fichiersApi()) {
    const src = code(lire(f))
    const h = src.search(/module\.exports\s*=\s*(?:async\s+)?(?:function\s*\w*\s*)?\(\s*\w+\s*,\s*\w+\s*\)\s*(?:=>\s*)?\{/)
    // ⚠ LA SONDE VISE LA GARDE SEULE, ET PAS `posterEnTetesPrives` — constat de
    // la review du 26 octobre 2026, sur le correctif de la dette 90 lui-meme.
    // Le recensement du dessous accepte les deux formes, parce que sortir du
    // COMPTAGE est justement ce qu'on attend d'un endpoint corrige. Ici c'est
    // l'inverse : si `g` tombe sur l'en-tete, la tranche `[h, g]` ne contient
    // plus aucun `res.status(...)`, l'endpoint quitte CET audit, et l'invariant
    // que tout ce fichier invoque pour ne PAS poser l'en-tete partout cesse de
    // le couvrir. Mesure : les cinq endpoints de la dette 90 en sortaient, donc
    // les fichiers hors audit passaient de 1 (`api/sms.js`) a 6 — et une
    // injection le prouve, pas une lecture : un `res.status(400).json({ error:
    // 'sonde', bien })` glisse avant la garde d'`api/yield.js` laissait la
    // suite a 14 verts. Ce n'est plus une question de cache a ce moment-la,
    // c'est une divulgation sans authentification.
    if (h < 0) continue
    // ⚠ ON CHERCHE A PARTIR DE `h`, PAS DANS TOUT LE FICHIER — constat de la
    // re-review, prouve par injection. Un appel de garde ecrit AVANT
    // `module.exports` (une fonction auxiliaire posee plus haut) donnait
    // `g < h`, donc `h > g`, donc `continue` : l'endpoint quittait l'audit SANS
    // UN MOT. Mesure : `api/messages.js` (garde l.196, handler l.377) et
    // `api/stripe.js` (garde l.285, handler l.438) en sortaient tous les deux —
    // et c'est exactement le defaut que ce commit existe pour fermer.
    const rel = src.slice(h).search(/await (requirePermission|verifierSession|requirePermissionPourCanal)\(|contexteDEcran\(/)
    if (rel < 0) continue
    const entre = src.slice(h, h + rel)
    // Chaque reponse emise avant la garde : son corps doit etre un libelle
    // generique, jamais une variable ni une lecture.
    for (const m of entre.matchAll(/res\s*\.status\(\s*\d+\s*\)\s*\.json\(\s*\{([^}]*)\}/g)) {
      const corps = m[1]
      // Un corps generique ne contient que des chaines litterales et des clefs.
      // ⚠ LES ECHAPPEMENTS COMPTENT — constat de la re-review. `/'[^']*'/`
      // s'arrete a l'apostrophe echappee : `error: 'Connectez d\'abord votre
      // compte Brevo'` devenait `''abord votre compte Brevo'`, et « compte »
      // survivait. Consequence double : l'audit criait au loup sur trois
      // libelles francais parfaitement generiques, ET la liste d'exemption
      // etait tenue pour utile par ces faux positifs.
      const sansChaines = corps
        .replace(/'(?:\\.|[^'\\])*'/g, "''")
        .replace(/"(?:\\.|[^"\\])*"/g, '""')
        .replace(/`(?:\\.|[^`\\])*`/g, '``')
      if (/\b(data|rows|bien|booking|compte|user|profil|perms|snapshot|liste)\b/.test(sansChaines)) {
        fautifs.push(`${f} : ${corps.trim().slice(0, 70)}`)
      }
    }
  }
  // ⚠ UNE EXEMPTION SE COMPTE, ELLE NE SE DECRIT PAS — et celle-ci est apparue
  // en recentrant la sonde sur la garde. `api/sms.js` ne passe par AUCUNE des
  // gardes partagees : il resout `user` lui-meme (`supabase.auth.getUser`),
  // borne chaque requete par `user_id`, et chacune de ses reponses a donnee de
  // compte est derriere un `if (!user) return 401` (l.197, 227, 254, 273).
  // L'autorisation est donc bien la, avant la donnee — c'est l'en-tete qui
  // manquait, et il est pose a la main en tete du handler depuis le 22 octobre.
  // ⚠ ON NE L'EXEMPTE PAS EN ELARGISSANT LA SONDE A `auth.getUser(`, et c'est
  // le choix qui compte : ce motif exempterait AUSSI, en silence, un futur
  // endpoint qui appellerait `getUser` sans rien faire de son resultat. Une
  // liste nommee se relit ; un motif plus large ne se relit pas.
  assert.deepEqual(fautifs.slice().sort(), AVANT_GARDE_ATTENDU.slice().sort(),
    'une reponse part AVANT toute verification d autorisation et son corps n est\n' +
    'pas un libelle generique : il peut porter une donnee de compte. Ce n est plus\n' +
    'une question de cache a ce moment-la, c est une DIVULGATION SANS\n' +
    'AUTHENTIFICATION. Deplacez la reponse SOUS la garde.\n' +
    'UNE DE PLUS que AVANT_GARDE_ATTENDU : nommez l autorisation qui la precede,\n' +
    'et ce qu on accepte en l exemptant, avant de l ajouter.\n' +
    'UNE DE MOINS : elle a ete corrigee — retirez-la de la liste pour que son\n' +
    'endpoint soit protege comme les autres.')
})

test('RECENSEMENT : la surface des reponses precoces est CHIFFREE', () => {
  // Un plafond ne ferme rien, il compte — et ce compte-la est la seule raison
  // pour laquelle le test du dessus suffit. S il explose, la surface a change
  // et l invariant doit etre re-examine.
  const avant = []
  for (const f of fichiersApi()) {
    const src = code(lire(f))
    const h = src.search(/module\.exports\s*=\s*(?:async\s+)?(?:function\s*\w*\s*)?\(\s*\w+\s*,\s*\w+\s*\)\s*(?:=>\s*)?\{/)
    if (h < 0) continue
    // Meme correction que l'audit du dessus : on cherche a partir de `h`.
    const rel = src.slice(h).search(/posterEnTetesPrives\(|await (requirePermission|verifierSession|requirePermissionPourCanal)\(/)
    if (rel < 0) continue
    if (/res\s*\.status\(/.test(src.slice(h, h + rel))) avant.push(f)
  }
  // Mesure du 22 octobre 2026 : 41 endpoints, les deux formes de handler
  // confondues. ⚠ Un balayage au `grep` n'en voyait que 27, et un autre 30 :
  // c'est CE motif-ci qui fait foi, et c'est par un motif plus etroit que
  // `api/yield.js` avait echappe au recensement alors que la production le
  // montrait en `public`.
  // ⚠ RE-ANCRE LE 26 OCTOBRE 2026, ET LE PLANCHER EST BAISSE EXPRES. La dette
  // 90 pose l'en-tete en tete de CINQ handlers, donc ils sortent de ce
  // comptage : 40 avant le correctif, 35 apres, mesure faite des deux cotes.
  // Le plancher etait a 35 — le correctif tombait pile dessus, et la
  // correction du SIXIEME endpoint aurait rougi ce test. Ce qu'il surveille
  // n'est pas la taille de la surface, c'est que le MOTIF voie encore quelque
  // chose : un recensement casse rend 0, pas 30.
  assert.ok(avant.length >= 28 && avant.length <= 48,
    `${avant.length} endpoints repondent avant leur garde (41 le 22 octobre 2026, ` +
    '35 le 26 apres la dette 90).\n' +
    'Si ce compte s effondre, ce n est pas la surface qui a disparu, c est le ' +
    'recensement.')
})

test('LE TEST QUI COMPTE : api/sms.js n ouvre plus CORS a tous les sites', () => {
  // ⚠ Le raisonnement est celui de `api/book-public.js`, qui le porte depuis
  // son ecriture : « La page est servie par le meme domaine : le navigateur n a
  // besoin d aucune permission croisee. `Access-Control-Allow-Origin: *`
  // laisserait n importe quel site lire le calendrier de n importe quel bien
  // depuis le navigateur de ses visiteurs. »
  // Recensement des appelants HTTP de /api/sms, 22 octobre 2026 : trois pages,
  // toutes sur notre domaine.
  const src = code(lire('api/sms.js'))
  assert.ok(!/Access-Control-Allow-Origin/.test(src),
    'api/sms.js rend une configuration Brevo et un historique sms_logs : il ne ' +
    'doit accorder aucune permission croisee')
  // Et l en-tete prive, lui, doit rester : c est l autre moitie du meme sujet.
  assert.match(src, /posterEnTetesPrives\(res\)/,
    'ses reponses portent des donnees de compte et ne passent pas par la garde ' +
    'partagee : l en-tete se pose a la main, en tete du handler')
})

test('RECENSEMENT : les endpoints qui ouvrent CORS a tous les sites sont COMPTES', () => {
  // ⚠ CINQ RESTENT, ET ILS ATTENDENT UNE DECISION DE THIERRY. Le raisonnement
  // de `book-public.js` leur vaut a tous — mais retirer CORS d un endpoint
  // change ce que peut faire une page d un autre domaine, et deux d entre eux
  // servent des parcours que je n ai pas eprouves (Stripe, l app prestataire).
  // On les COMPTE donc, au lieu de les decrire ou de les oublier.
  const ouverts = fichiersApi().filter(f => /Access-Control-Allow-Origin/.test(code(lire(f))))
  assert.deepEqual(ouverts.sort(), [
    'api/agent-config.js',      // authentifie — candidat
    'api/beds24-setup.js',      // authentifie — candidat
    'api/extract-kb.js',        // authentifie — candidat
    'api/menages-public.js',    // public PAR JETON : `*` laisse lire un planning a qui connait le jeton
    'api/stripe.js'             // a verifier : un webhook n applique pas CORS, une page de retour si
  ].sort(),
    'un de plus : justifiez pourquoi ce endpoint accorde une permission croisee.\n' +
    'un de moins : il a ete ferme, retirez-le pour qu il soit protege.')
})

// ═══════════════════════════════════════════════════════════════════════════
// DETTE 90 : UN 400 PORTE L'EN-TETE COMME UN 401
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠ CE QUE CES CINQ ENDPOINTS FAISAIENT, ET QUE LE FILET CI-DESSUS NE VOYAIT
// PAS. Les tests du dessus tiennent un invariant plus faible — « ce qui repond
// AVANT la garde ne porte aucune donnee de compte » — et ils le tiennent par
// LECTURE DE LA SOURCE. Ils etaient verts sur les cinq : les corps sont bien
// des libelles generiques (`bien_requis`, `methode_non_supportee`).
//
// Mesure du 26 octobre 2026, en appelant les handlers : ONZE reponses de refus,
// ZERO en-tete. `api/yield.js:123` (dette 90, relevee le 24 octobre sur staging
// ET sur la production `720d5f8`), et les quatre endpoints du marche entres en
// production le 26 octobre avec `6ecff8f` — `api/marche-comparables.js`,
// `api/marche-global.js`, `api/marche-temperature.js`, `api/yield-marche.js`
// (deux fois : le handler et la vue calendrier).
//
// ⚠ ET CE TEST APPELLE LE HANDLER, IL NE LIT PAS LA SOURCE. Un recensement par
// motif ne voit pas ce qu'un `res` recoit : c'est par un motif trop etroit que
// `api/yield.js` avait echappe au comptage du 22 octobre alors que la
// production le montrait en `public`. Le seul temoin qui ne mente pas est
// l'en-tete pose sur une vraie reponse.
//
// ⚠ POURQUOI CE N'EST PAS LE CORRECTIF DEFAIT DU 22 OCTOBRE. Ce jour-la, poser
// l'en-tete en tete des 29 handlers concernes avait rendu 27 rouges : les
// doubles PARTIELS de `lib/require-permission` n'exportent pas la fonction.
// Mesure refaite ici, endpoint par endpoint : les six fichiers de test qui
// doublent la garde pour ces cinq-la font tous `{ ...vraie, requirePermission }`
// — ils gardent donc `posterEnTetesPrives`. CINQ handlers, pas 29, et le cout
// est mesure au lieu d'etre suppose.

const CINQ_ENDPOINTS = [
  ['api/yield.js', 'yield', { property_id: '' }],
  ['api/marche-comparables.js', 'marche-comparables', {}],
  ['api/marche-global.js', 'marche-global', {}],
  ['api/marche-temperature.js', 'marche-temperature', {}],
  ['api/yield-marche.js', 'yield-marche', {}],
  // La vue calendrier de `yield-marche` est un SECOND refus, dans un
  // sous-handler : il n'est atteint que par le handler principal, donc une
  // seule pose le couvre — mais c'est ici qu'on le prouve, pas par lecture.
  ['api/yield-marche.js (vue=calendrier)', 'yield-marche', { vue: 'calendrier' }]
]

function appeler (nom, req) {
  const api = require(path.join(racine, 'api', `${nom}.js`))
  const res = fausseReponse()
  return Promise.resolve(api(req, res)).then(() => res)
}

test('LE TEST QUI COMPTE (dette 90) : le 400 « bien absent » porte private, no-store', async () => {
  for (const [libelle, nom, query] of CINQ_ENDPOINTS) {
    const res = await appeler(nom, { method: 'GET', headers: {}, query })
    assert.equal(res.code, 400, `${libelle} : sans bien, le refus attendu est 400`)
    assert.equal(res.entetes['cache-control'], 'private, no-store',
      `${libelle} : ce refus precede la garde, donc il partait en ` +
      '`public, max-age=0, must-revalidate` — posez `posterEnTetesPrives(res)` ' +
      'en tete du handler')
    assert.equal(res.entetes.vary, 'authorization, x-compte',
      `${libelle} : sans vary, un cache qui garderait quand meme la reponse la ` +
      'servirait au compte suivant')
  }
})

test('LE TEST QUI COMPTE (dette 90) : le 405 « methode » le porte aussi', async () => {
  // ⚠ LA DETTE 90 NE NOMMAIT QUE LE 400, et le 405 est le MEME defaut : il
  // precede la garde lui aussi. Le correctif qui se contenterait de deplacer
  // le 400 sous les en-tetes laisserait cette moitie ouverte.
  for (const [libelle, nom] of CINQ_ENDPOINTS) {
    const res = await appeler(nom, { method: 'DELETE', headers: {}, query: {} })
    assert.equal(res.code, 405, `${libelle} : une methode non prevue rend 405`)
    assert.equal(res.entetes['cache-control'], 'private, no-store',
      `${libelle} : le refus de methode precede la garde comme le 400`)
  }
})

test('LE TEST QUI COMPTE (dette 90) : le 401 et le 400 portent le MEME en-tete', async () => {
  // ⚠ C'EST L'INVARIANT DEMANDE : « private, no-store sur un 400 comme sur un
  // 401 ». Les deux refus sont mesures sur LE MEME endpoint et dans la MEME
  // suite, parce que c'est leur DIVERGENCE qui etait le defaut — le 401 (pose
  // par la garde) l'a toujours porte, le 400 (pose avant elle) jamais.
  // Aucun reseau : `requirePermission` rend 401 des l'absence de jeton, avant
  // tout appel Auth.
  for (const [libelle, nom, query] of CINQ_ENDPOINTS) {
    const sansBien = await appeler(nom, { method: 'GET', headers: {}, query })
    const sansJeton = await appeler(nom, { method: 'GET', headers: {},
      query: { ...query, property_id: 'un-bien-quelconque' } })
    assert.equal(sansBien.code, 400, `${libelle} : refus de validation`)
    assert.equal(sansJeton.code, 401, `${libelle} : refus de garde`)
    assert.equal(sansBien.entetes['cache-control'], sansJeton.entetes['cache-control'],
      `${libelle} : le refus de validation et le refus de garde doivent porter ` +
      'le meme en-tete de cache — leur divergence EST la dette 90')
    assert.equal(sansBien.entetes.vary, sansJeton.entetes.vary,
      `${libelle} : et le meme vary`)
  }
})
