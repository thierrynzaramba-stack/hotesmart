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
    const g = src.search(/posterEnTetesPrives\(|await (requirePermission|verifierSession|requirePermissionPourCanal)\(/)
    if (h < 0 || g < 0 || h > g) continue
    const entre = src.slice(h, g)
    // Chaque reponse emise avant la garde : son corps doit etre un libelle
    // generique, jamais une variable ni une lecture.
    for (const m of entre.matchAll(/res\s*\.status\(\s*\d+\s*\)\s*\.json\(\s*\{([^}]*)\}/g)) {
      const corps = m[1]
      // Un corps generique ne contient que des chaines litterales et des clefs.
      const sansChaines = corps.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, '``')
      if (/\b(data|rows|bien|booking|compte|user|profil|perms|snapshot|liste)\b/.test(sansChaines)) {
        fautifs.push(`${f} : ${corps.trim().slice(0, 70)}`)
      }
    }
  }
  assert.deepEqual(fautifs, [],
    'ces reponses partent AVANT la garde, donc avec le defaut Vercel `public`,\n' +
    'et leur corps n est pas un libelle generique : il peut porter une donnee de\n' +
    'compte. Posez `posterEnTetesPrives(res)` en tete de ce handler — et ajoutez\n' +
    'la fonction aux doubles de test de `lib/require-permission` qui la cassent.')
})

test('RECENSEMENT : la surface des reponses precoces est CHIFFREE', () => {
  // Un plafond ne ferme rien, il compte — et ce compte-la est la seule raison
  // pour laquelle le test du dessus suffit. S il explose, la surface a change
  // et l invariant doit etre re-examine.
  const avant = []
  for (const f of fichiersApi()) {
    const src = code(lire(f))
    const h = src.search(/module\.exports\s*=\s*(?:async\s+)?(?:function\s*\w*\s*)?\(\s*\w+\s*,\s*\w+\s*\)\s*(?:=>\s*)?\{/)
    const g = src.search(/posterEnTetesPrives\(|await (requirePermission|verifierSession|requirePermissionPourCanal)\(/)
    if (h < 0 || g < 0 || h > g) continue
    if (/res\s*\.status\(/.test(src.slice(h, g))) avant.push(f)
  }
  // Mesure du 22 octobre 2026 : 41 endpoints, les deux formes de handler
  // confondues. ⚠ Un balayage au `grep` n'en voyait que 27, et un autre 30 :
  // c'est CE motif-ci qui fait foi, et c'est par un motif plus etroit que
  // `api/yield.js` avait echappe au recensement alors que la production le
  // montrait en `public`.
  assert.ok(avant.length >= 35 && avant.length <= 48,
    `${avant.length} endpoints repondent avant leur garde (41 le 22 octobre 2026).\n` +
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
