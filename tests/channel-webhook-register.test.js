// tests/channel-webhook-register.test.js
// L'ACTION `register` DU WEBHOOK CERTIFIE — la seule partie de ce fichier qui
// agit au nom d'un utilisateur connecte, et la seule que ces tests touchent.
//
// LA FAILLE QU'ILS FERMENT, trouvee le 1er octobre 2026 :
// `callback_url` venait du CLIENT. Toute session Supabase valide — un membre
// delegue, un compte d'essai, sans aucun droit particulier — pouvait faire
// enregistrer chez le gestionnaire de canaux un webhook GLOBAL pointant chez
// elle. Le corps envoye au provider porte en clair `X-Channel-Webhook-Secret`
// et le bypass Vercel : l'appelant recevait les deux, puis chaque reservation
// et chaque message de TOUT LE PARC, et pouvait ensuite forger des events sur
// ce webhook-ci comme sur `api/channel-events.js`, qui partage la meme variable.
//
// ⚠ LE FICHIER VOISIN AVAIT DEJA PAYE CE CONSTAT DEUX FOIS, et sa lecon y est
// ecrite : « on ne valide pas une donnee client qui designe une ressource, on ne
// l'utilise pas ». Ce fichier-ci ne l'avait pas recue, et `profils-et-droits.md`
// l'avait explicitement mis « hors perimetre » du balayage des droits, au motif
// qu'« aucun n'agit au nom d'un utilisateur connecte » — ce qui etait faux
// precisement pour cette branche.
//
// ⚠ LA RECEPTION DES EVENTS N'EST PAS TOUCHEE, ni par le correctif ni par ces
// tests : c'est elle que la certification du gestionnaire eprouve.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'https://api.exemple'
process.env.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY || 'cle-test'
process.env.CHANNEL_WEBHOOK_SECRET = 'secret-de-webhook-pour-les-tests'
process.env.VERCEL_BYPASS_TOKEN = 'bypass-pour-les-tests'
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_factice'
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'cle-test'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const TITULAIRE = '11111111-1111-4111-8111-111111111111'
const MEMBRE = '22222222-2222-4222-8222-222222222222'
const HOTE_APP = 'hotesmart.vercel.app'
const URL_ATTENDUE = `https://${HOTE_APP}/api/channel-webhook`

const MODULES = ['../api/channel-webhook', '../lib/require-permission', '../lib/permissions',
                 '../lib/cron-shared', '../lib/channels', '../lib/bookings-snapshot',
                 '../lib/billing', '../lib/channel-availability', '../lib/record-message']

function preparer ({ user = TITULAIRE, profil = null, permissions = null,
                     webhooks = [], listeOk = true } = {}) {
  const etat = { appels: [] }

  const client = {
    auth: { getUser: async () => (user ? { data: { user: { id: user } }, error: null }
                                       : { data: null, error: { message: 'invalide' } }) },
    from (nom) {
      const q = {
        _f: {},
        select () { return q },
        eq (c, v) { q._f[c] = v; return q },
        in () { return q }, or () { return q }, is () { return q },
        not () { return q }, order () { return q }, limit () { return q },
        upsert () { return Promise.resolve({ error: null }) },
        update () { return q },
        insert () { return Promise.resolve({ error: null }) },
        maybeSingle: async () => ({ data: rep(), error: null }),
        single: async () => ({ data: rep(), error: null }),
        then (ok, ko) { return Promise.resolve({ data: rep() ? [rep()] : [], error: null }).then(ok, ko) },
      }
      function rep () {
        if (nom === 'profiles') {
          return profil && profil.account_user_id === q._f.account_user_id
            && profil.member_user_id === q._f.member_user_id ? profil : null
        }
        if (nom === 'profile_permissions') {
          return permissions && profil ? { ...permissions, profile_id: profil.id } : null
        }
        return null
      }
      return q
    },
  }

  // ⚠ LE DOUBLE DU PROVIDER ENREGISTRE TOUT CE QU'ON LUI ENVOIE — c'est tout
  // l'objet de ces tests : ce qui compte est le CORPS du POST, parce que c'est
  // lui qui porte le secret.
  globalThis.fetch = async (url, opts = {}) => {
    let corps = null
    try { corps = opts.body ? JSON.parse(opts.body) : null } catch { corps = opts.body }
    const methode = opts.method || 'GET'
    etat.appels.push({ url: String(url), methode, corps })
    // ⚠ LA LISTE DES WEBHOOKS EXISTANTS, que le code lit avant de creer. Sans
    // elle, aucun test ne pourrait distinguer une creation d'une mise a jour.
    if (String(url).endsWith('/webhooks') && methode === 'GET') {
      return { ok: listeOk, status: listeOk ? 200 : 500, headers: { get: () => null },
               text: async () => JSON.stringify(listeOk ? { data: webhooks } : { errors: { title: 'panne' } }) }
    }
    return {
      ok: true, status: 201,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        data: {
          id: 'webhook-cree',
          attributes: {
            callback_url: corps?.webhook?.callback_url,
            // Le provider RENVOIE les en-tetes, secret compris : c'est ce que
            // la reponse ne doit pas relayer.
            headers: corps?.webhook?.headers || {},
            request_params: corps?.webhook?.request_params || {},
          },
        },
      }),
    }
  }

  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
  return etat
}

function reponse () {
  const r = { code: null, body: null }
  r.status = (c) => { r.code = c; return r }
  r.json = (b) => { r.body = b; return r }
  r.setHeader = () => {}
  return r
}

const requete = (body, entetes = {}) => ({
  method: 'POST',
  headers: { authorization: 'Bearer jeton', host: HOTE_APP, ...entetes },
  query: {}, body: { action: 'register', ...body },
})

// ─── La faille, fermée ──────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : une URL fournie par l’appelant n’est JAMAIS celle qui part', async () => {
  const etat = preparer({})
  const handler = require('../api/channel-webhook')
  const res = reponse()
  await handler(requete({ callback_url: 'https://chez-moi.example/voler' }), res)

  // Le serveur refuse l'ecart plutot que de l'ignorer : un « succes » sur une
  // cible qui n'est pas celle demandee tromperait l'appelant legitime.
  assert.strictEqual(res.code, 400)
  assert.match(res.body.error, /non conforme/)
  assert.strictEqual(res.body.attendu, URL_ATTENDUE)
  assert.strictEqual(etat.appels.length, 0, 'rien ne part chez le provider')
})

test('LE TEST QUI COMPTE : le secret ne peut pas etre livre a une URL etrangere', async () => {
  // La formulation qui compte : ce n'est pas « l URL est validee », c'est
  // « le secret ne sort pas ». On verifie donc les DEUX corps envoyes.
  const etat = preparer({})
  const handler = require('../api/channel-webhook')
  await handler(requete({ callback_url: 'https://chez-moi.example/voler' }), reponse())

  const fuite = etat.appels.find(a => JSON.stringify(a.corps || {}).includes(process.env.CHANNEL_WEBHOOK_SECRET))
  assert.strictEqual(fuite, undefined, 'aucun appel ne doit porter le secret vers une cible etrangere')
})

test('sans `callback_url`, l’action marche : la cible est celle du serveur', async () => {
  // L'ancienne version EXIGEAIT ce parametre. Le retirer est le bon defaut : le
  // serveur sait ou il est.
  const etat = preparer({})
  const handler = require('../api/channel-webhook')
  const res = reponse()
  await handler(requete({}), res)

  assert.strictEqual(res.code, 201)
  const post = etat.appels.find(a => a.methode === 'POST' && a.url.endsWith('/webhooks'))
  assert.ok(post, 'un enregistrement doit partir')
  assert.strictEqual(post.corps.webhook.callback_url, URL_ATTENDUE)
})

test('la cible conforme envoyee par le front est acceptee', async () => {
  const etat = preparer({})
  const handler = require('../api/channel-webhook')
  const res = reponse()
  await handler(requete({ callback_url: URL_ATTENDUE }), res)
  assert.strictEqual(res.code, 201)
})

test('LE TEST QUI COMPTE : un hote inconnu fait REFUSER l’action, il ne la detourne pas', async () => {
  // ⚠ CE TEST A CHANGE DE SENS, et c'est un constat CRITIQUE de review.
  // Il verifiait que la cible restait celle du serveur malgre un `Host` etranger.
  // Vrai, mais insuffisant : lancee depuis le projet STAGING, l'action creait dans
  // le compte de canal de staging un webhook pointant sur la PRODUCTION, portant
  // le secret de staging — 401 a chaque livraison, retries en boucle, et le secret
  // de staging jamais rote.
  //
  // Pire : le corps du PUT lisait `VERCEL_BYPASS_TOKEN` de l'environnement
  // d'EXECUTION. Lance depuis une preview, il ecrasait le `request_params {}` du
  // webhook de production par le jeton de bypass, que le gestionnaire aurait
  // ensuite ajoute en QUERY STRING a chaque livraison — donc dans les journaux
  // d'acces de production, en permanence. C'est la classe de fuite exacte que
  // cette livraison supprime par ailleurs.
  const etat = preparer({})
  const handler = require('../api/channel-webhook')
  const res = reponse()
  await handler(requete({}, { host: 'chez-moi.example' }), res)
  assert.strictEqual(res.code, 409)
  assert.match(res.body.reason, /Relancez depuis la production/)
  assert.strictEqual(etat.appels.length, 0, 'rien ne part chez le gestionnaire')
})

test('LE TEST QUI COMPTE : le bypass Vercel ne part JAMAIS dans la cible de production', async () => {
  // Il depend desormais de la CIBLE, pas de l'environnement d'execution. La cible
  // etant un domaine applicatif, qui n'est pas derriere le mur Vercel, les
  // parametres de requete sont vides — ce que le webhook de production porte
  // aujourd'hui.
  const etat = preparer({ webhooks: WEBHOOK_EXISTANT })
  const handler = require('../api/channel-webhook')
  await handler(requete({}), reponse())
  const put = etat.appels.find(a => a.methode === 'PUT')
  assert.deepStrictEqual(put.corps.webhook.request_params, {},
    'aucun parametre de requete sur une cible de production')
  assert.ok(!JSON.stringify(put.corps).includes(process.env.VERCEL_BYPASS_TOKEN),
    'le jeton de bypass ne doit pas partir')
})

// ─── Ce que la garde `titulaire` protege, et ce qu'elle NE protege pas ──────
//
// ⚠ MESURE FAITE EN ECRIVANT CE TEST, et elle change la portee du correctif.
// `requirePermission({ domaine: 'titulaire' })` verifie que l'appelant est le
// titulaire du COMPTE CIBLE. Sans en-tete `X-Compte` valide, le compte cible est
// le SIEN : tout utilisateur connecte est donc titulaire, et passe.
//
// `api/diagnostic.js` le dit deja, mot pour mot, a propos de sa propre garde :
// « aucune ressource d'un compte client n'est designee, donc tout utilisateur
// authentifie est titulaire du compte cible (le sien) et passerait ».
//
// CE QUE CELA CHANGE, ET CE QUE CELA NE CHANGE PAS. La faille grave est fermee :
// l'URL etant construite par le serveur, le secret ne peut plus etre livre
// ailleurs, et c'est prouve plus haut. Le DOUBLON l'est aussi depuis la
// livraison 3, qui a donne a ce fichier la recherche-puis-`PUT` de son voisin.
//
// CE QUI RESTE OUVERT est donc plus etroit encore : tout utilisateur connecte
// franchit la garde et declenche une MISE A JOUR de la bonne cible avec le
// secret courant — sans fuite et sans doublon, mais sans droit particulier non
// plus. La garde centrale d'environnement est le chantier qui le fermera ; d'ici
// la, c'est nomme plutot que subi.
test('CE QUI RESTE OUVERT, ET C’EST MESURE : tout utilisateur connecte declenche l action', async () => {
  // ⚠ `domaine: 'titulaire'` NE PROTEGE PAS UNE RESSOURCE GLOBALE, et il a fallu
  // ecrire ce test pour s'en apercevoir. Deux raisons qui se cumulent :
  //
  //   1. sans l'option `compteDelegue`, l'en-tete `X-Compte` n'est pas honore :
  //      le compte cible est celui de l'appelant ;
  //   2. la garde verifie alors `userId === accountUserId` — vrai par
  //      construction pour qui agit sur son propre compte.
  //
  // `api/diagnostic.js` le dit deja, mot pour mot, a propos de sa propre garde :
  // « aucune ressource d'un compte client n'est designee, donc tout utilisateur
  // authentifie est titulaire du compte cible (le sien) et passerait ».
  //
  // ⚠ CE TEST A ETE DESARME UNE FOIS, et le constat vaut d'etre garde : sa
  // premiere version affirmait « le doublon reste ouvert, la consigne etait une
  // correction MINIMALE », et elle le prouvait par un `201`. La livraison 3 a
  // pris la decision inverse — recherche-puis-`PUT` — et le test est reste VERT,
  // parce que le double du provider rend une liste VIDE par defaut : il mesurait
  // une creation dans un monde sans webhook existant, c'est-a-dire jamais la
  // production. Un piege a loup qui se referme sur du vide ne dit rien.
  //
  // Il part donc maintenant de l'etat REEL de la production — un webhook deja
  // enregistre — et mesure les deux choses separement.
  const etat = preparer({ user: MEMBRE, webhooks: [
    { id: 'w-prod', attributes: { callback_url: URL_ATTENDUE, event_mask: 'booking;message' } },
  ] })
  const handler = require('../api/channel-webhook')
  const res = reponse()
  await handler(requete({}), res)

  // CE QUI RESTE OUVERT : un simple membre franchit la garde et declenche
  // l'action. C'est nomme, pas subi — la garde centrale d'environnement est le
  // chantier qui le fermera.
  assert.strictEqual(res.code, 200, 'aujourd hui il passe — a changer le jour ou la garde se resserre')

  // CE QUI EST FERME, ET QUI EST L'ESSENTIEL : il ne cree pas de doublon, et la
  // cible reste celle du serveur, donc le secret ne sort pas.
  assert.strictEqual(etat.appels.filter(a => a.methode === 'POST').length, 0,
    'plus aucune creation a l aveugle : la livraison 3 cherche puis met a jour')
  const put = etat.appels.find(a => a.methode === 'PUT')
  assert.ok(put, 'c est une mise a jour de l existant')
  assert.match(put.url, /w-prod$/)
  assert.strictEqual(put.corps.webhook.callback_url, URL_ATTENDUE)
})

test('sans session, rien ne part', async () => {
  const etat = preparer({ user: null })
  const handler = require('../api/channel-webhook')
  const res = reponse()
  await handler(requete({}), res)
  assert.strictEqual(res.code, 401)
  assert.strictEqual(etat.appels.length, 0)
})

// ─── La reponse ne relaie pas les secrets ───────────────────────────────────
test('LE TEST QUI COMPTE : la reponse rend les NOMS des en-tetes, jamais leurs valeurs', async () => {
  // Le provider renvoie le webhook complet, en-tetes comprises. Les relayer les
  // exposait dans l'onglet reseau, l'historique, un rapport de diagnostic
  // copie-colle. Masquer a l'affichage n'aurait rien change : le secret aurait
  // deja quitte le serveur.
  preparer({})
  const handler = require('../api/channel-webhook')
  const res = reponse()
  await handler(requete({}), res)

  const rendu = JSON.stringify(res.body)
  assert.ok(!rendu.includes(process.env.CHANNEL_WEBHOOK_SECRET), 'le secret ne sort pas')
  assert.ok(!rendu.includes(process.env.VERCEL_BYPASS_TOKEN), 'le bypass ne sort pas')
  // ⚠ LA STRUCTURE RESTE, LA VALEUR PART. Le masqueur balaie desormais par
  // VALEUR : on garde donc le NOM de l'en-tete a sa place, ce qui permet de
  // verifier qu'il est bien pose, et sa valeur est remplacee. L'ancienne version
  // rendait un tableau de noms — plus court a lire, mais elle ne savait traiter
  // qu'une seule forme de reponse (voir le bloc des huit formes, plus bas).
  assert.deepStrictEqual(Object.keys(res.body.data.attributes.headers), ['X-Channel-Webhook-Secret'])
  assert.strictEqual(res.body.data.attributes.headers['X-Channel-Webhook-Secret'], '***RETIRE***')
})

// ─── La reception, intouchee ────────────────────────────────────────────────
test('la reception refuse toujours un secret invalide, et ce correctif n’y a pas touche', async () => {
  preparer({})
  const handler = require('../api/channel-webhook')
  const res = reponse()
  await handler({
    method: 'POST', query: {},
    headers: { 'x-channel-webhook-secret': 'pas-le-bon', host: HOTE_APP },
    body: { event: 'booking', payload: { booking_id: 'b1' } },
  }, res)
  assert.strictEqual(res.code, 401)
})

test('et elle accepte le bon secret sans exiger de session', async () => {
  // C'est tout le point : le gestionnaire de canaux n'a pas de session. Exiger
  // un droit ici aurait casse la reception, donc la certification.
  preparer({ user: null })
  const handler = require('../api/channel-webhook')
  const res = reponse()
  await handler({
    method: 'POST', query: {},
    headers: { 'x-channel-webhook-secret': process.env.CHANNEL_WEBHOOK_SECRET, host: HOTE_APP },
    body: { event: 'inconnu', payload: {} },
  }, res)
  assert.notStrictEqual(res.code, 401, 'un secret valide ne doit pas etre refuse')
})

// ─── Le masqueur, sur toutes les formes que le provider peut rendre ──────────
// ⚠ POURQUOI CE BLOC EXISTE. La premiere version du masqueur etait PLATE : elle
// retirait `headers` et `request_params` a deux endroits precis. Une review l'a
// eprouvee sur huit formes plausibles — CINQ fuyaient. Et le test ne pouvait pas
// le voir : son double du provider produisait precisement la seule forme que le
// masqueur savait traiter. Vert par construction.
//
// Deux de ces formes ne sont pas speculatives : `{ raw }` est fabriquee par ce
// fichier des que le provider ne rend pas du JSON, et `{ data: [ … ] }` est la
// forme documentee de `/webhooks`, que `scripts/check-webhooks.js` attend deja.
const SECRET = process.env.CHANNEL_WEBHOOK_SECRET
const BYPASS = process.env.VERCEL_BYPASS_TOKEN

const FORMES = {
  'attributs (la forme du premier test)': { data: { id: 'w', attributes: { headers: { 'X-Channel-Webhook-Secret': SECRET }, request_params: { 'x-vercel-protection-bypass': BYPASS } } } },
  'a plat sous data': { data: { id: 'w', headers: { 'X-Channel-Webhook-Secret': SECRET } } },
  'une COLLECTION': { data: [{ id: 'w', attributes: { headers: { 'X-Channel-Webhook-Secret': SECRET } } }] },
  'une erreur qui recopie le corps': { errors: { detail: { webhook: { headers: { 'X-Channel-Webhook-Secret': SECRET } } } } },
  'un corps NON-JSON': { raw: `<html>erreur du proxy, en-tete recu : ${SECRET}</html>` },
  'un secret a la racine': { data: { id: 'w' }, headers: { 'X-Channel-Webhook-Secret': SECRET } },
  'un niveau de plus': { data: { attributes: { webhook: { headers: { 'X-Channel-Webhook-Secret': SECRET } } } } },
  'un document inclus': { data: { id: 'w' }, included: [{ attributes: { headers: { 'X-Channel-Webhook-Secret': SECRET } } }] },
}

for (const [nom, forme] of Object.entries(FORMES)) {
  test(`LE TEST QUI COMPTE : aucun secret ne sort, forme « ${nom} »`, async () => {
    const etat = preparer({})
    // On remplace la reponse du provider par la forme a eprouver.
    const vraiFetch = globalThis.fetch
    globalThis.fetch = async (url, opts = {}) => {
      etat.appels.push({ url: String(url), methode: opts.method || 'GET' })
      return { ok: true, status: 201, headers: { get: () => null }, text: async () => JSON.stringify(forme) }
    }
    try {
      const handler = require('../api/channel-webhook')
      const res = reponse()
      await handler(requete({}), res)
      const rendu = JSON.stringify(res.body)
      assert.ok(!rendu.includes(SECRET), `le secret sort dans la forme « ${nom} » : ${rendu.slice(0, 200)}`)
      assert.ok(!rendu.includes(BYPASS), `le bypass sort dans la forme « ${nom} »`)
    } finally { globalThis.fetch = vraiFetch }
  })
}

test('et un tableau reste un TABLEAU apres masquage', async () => {
  // L'ancien masqueur destructurait un tableau : `{...reste}` en rendait un objet
  // a cles numeriques. La structure comptait autant que le secret.
  const etat = preparer({})
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async (url, opts = {}) => {
    etat.appels.push({ url: String(url) })
    return { ok: true, status: 201, headers: { get: () => null },
             text: async () => JSON.stringify({ data: [{ id: 'un' }, { id: 'deux' }] }) }
  }
  try {
    const handler = require('../api/channel-webhook')
    const res = reponse()
    await handler(requete({}), res)
    assert.ok(Array.isArray(res.body.data), `data devrait rester un tableau : ${JSON.stringify(res.body.data)}`)
    assert.strictEqual(res.body.data.length, 2)
  } finally { globalThis.fetch = vraiFetch }
})

// ─── La reception traverse son chemin, ou on le sait ────────────────────────
test('LE TEST QUI COMPTE : un event booking atteint la recherche du bien sans ReferenceError', async () => {
  // ⚠ CE TEST EXISTE PARCE QUE J'AI CASSE LA RECEPTION EN LA CORRIGEANT. Un
  // remplacement de bloc a emporte `require('../lib/bien-du-provider')`, dont la
  // reception se sert : une `ReferenceError` a la premiere reservation recue —
  // c'est-a-dire tout ce que le correctif pretendait ne pas toucher. Le fichier
  // se chargeait sans erreur : rien ne l'aurait dit avant la production.
  //
  // ⚠ DEUX VERSIONS DE CE TEST ONT ECHOUE A L'ATTRAPER, et c'est la lecon.
  //   1. Chercher les imports par expression reguliere : dix-neuf faux positifs,
  //      des mots pris dans les COMMENTAIRES. Exactement le piege que la review
  //      venait de me reprocher sur le balayage du cron.
  //   2. Envoyer un event booking avec un feed VIDE : le code sort avant
  //      d'atteindre la fonction, et la mutation passait au vert.
  // Il faut donc un feed qui porte UNE REVISION, pour que le chemin aille
  // jusqu'au bout. Verifie par mutation : sans l'import, ce test rougit.
  const etat = preparer({})
  const vraiFetch = globalThis.fetch
  let feedServi = false
  globalThis.fetch = async (url, opts = {}) => {
    etat.appels.push({ url: String(url), methode: opts.method || 'GET' })
    if (String(url).includes('/booking_revisions/feed')) {
      // Une seule revision, puis une page vide : le code s'arrete de lui-meme.
      const corps = feedServi ? { data: [] } : {
        data: [{ id: 'rev-1', attributes: { id: 'rev-1', property_id: 'ref-provider-1', status: 'new' } }],
        meta: { limit: 50 },
      }
      feedServi = true
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(corps) }
    }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: {} }) }
  }
  try {
    const handler = require('../api/channel-webhook')
    const res = reponse()
    await handler({
      method: 'POST', query: {},
      headers: { 'x-channel-webhook-secret': process.env.CHANNEL_WEBHOOK_SECRET, host: HOTE_APP },
      body: { event: 'booking', payload: { booking_id: 'BK-TEST' } },
    }, res)

    // Le chemin doit avoir ETE PARCOURU : le feed lu, donc la revision traitee,
    // donc la recherche du bien tentee. Sans cette assertion, un feed ignore
    // laisserait le test vert comme sa version precedente.
    assert.ok(etat.appels.some(a => a.url.includes('/booking_revisions/feed')),
      'le feed doit avoir ete lu')
    assert.ok(res.code !== null, 'la reception doit rendre une reponse, pas lever')
    assert.notStrictEqual(res.code, 401, 'le bon secret ne doit pas etre refuse')
    assert.notStrictEqual(res.code, 500, 'un identifiant manquant sortirait en 500 par le filet global')
  } finally { globalThis.fetch = vraiFetch }
})

// ─── Le doublon, ferme ──────────────────────────────────────────────────────
// ⚠ POURQUOI CE BLOC EXISTE. Un POST aveugle creait un webhook de plus a chaque
// appel, et rien ne limitait le nombre : chaque event declenchait alors autant de
// balayages COMPLETS du feed — jusqu'a dix pages et un acquittement par revision,
// en concurrence sur les memes lignes. Et c'est ce qui rendait la rotation du
// secret impossible par le code.
const WEBHOOK_EXISTANT = [{
  id: 'wh-certifie',
  attributes: { callback_url: URL_ATTENDUE, event_mask: 'booking;message' },
}]

test('LE TEST QUI COMPTE : un webhook existant est MIS A JOUR, pas double', async () => {
  const etat = preparer({ webhooks: WEBHOOK_EXISTANT })
  const handler = require('../api/channel-webhook')
  const res = reponse()
  await handler(requete({}), res)

  assert.strictEqual(res.code, 200, 'une mise a jour rend 200, une creation 201')
  assert.strictEqual(res.body.mis_a_jour, true)
  assert.strictEqual(res.body.cree, false)
  const put = etat.appels.find(a => a.methode === 'PUT')
  assert.ok(put, 'un PUT doit partir')
  assert.match(put.url, /\/webhooks\/wh-certifie$/)
  assert.ok(!etat.appels.some(a => a.methode === 'POST'), 'aucune creation')
})

test('LE TEST QUI COMPTE : la mise a jour renvoie le secret, sinon on le perdrait', async () => {
  // Si le gestionnaire REMPLACE l'objet au lieu de le fusionner, omettre
  // `headers` ferait perdre le secret partage — et toutes les livraisons
  // suivantes seraient rejetees en 401 par notre propre garde.
  const etat = preparer({ webhooks: WEBHOOK_EXISTANT })
  const handler = require('../api/channel-webhook')
  await handler(requete({}), reponse())
  const put = etat.appels.find(a => a.methode === 'PUT')
  assert.strictEqual(put.corps.webhook.headers['X-Channel-Webhook-Secret'], process.env.CHANNEL_WEBHOOK_SECRET)
  assert.strictEqual(put.corps.webhook.event_mask, 'booking;message', 'le masque ne doit pas se perdre')
})

test('sans webhook existant, on cree — et on le dit', async () => {
  const etat = preparer({ webhooks: [] })
  const handler = require('../api/channel-webhook')
  const res = reponse()
  await handler(requete({}), res)
  assert.strictEqual(res.code, 201)
  assert.strictEqual(res.body.cree, true)
  assert.ok(etat.appels.some(a => a.methode === 'POST'))
})

test('LE TEST QUI COMPTE : liste illisible, on ne cree RIEN a l’aveugle', async () => {
  const etat = preparer({ listeOk: false })
  const handler = require('../api/channel-webhook')
  const res = reponse()
  await handler(requete({}), res)
  assert.strictEqual(res.body.ok, false)
  assert.match(res.body.reason, /aveugle/)
  assert.ok(!etat.appels.some(a => a.methode === 'POST' || a.methode === 'PUT'),
    'ni creation ni mise a jour sans savoir ce qui existe')
})

test('un webhook trouve SANS identifiant ne tombe pas sur la creation', async () => {
  // Il tomberait sinon sur le POST, donc sur le doublon qu'on vient de fermer.
  const etat = preparer({ webhooks: [{ attributes: { callback_url: URL_ATTENDUE } }] })
  const handler = require('../api/channel-webhook')
  const res = reponse()
  await handler(requete({}), res)
  assert.strictEqual(res.body.ok, false)
  assert.match(res.body.reason, /identifiant est illisible/)
  assert.ok(!etat.appels.some(a => a.methode === 'POST'))
})

test('LE TEST QUI COMPTE : appele dix fois, il ne cree jamais un second webhook', async () => {
  // La mesure qui compte vraiment : le nombre n'est plus choisi par l'appelant.
  const webhooks = []
  const etat = preparer({ webhooks })
  const handler = require('../api/channel-webhook')
  for (let i = 0; i < 10; i++) {
    const res = reponse()
    await handler(requete({}), res)
    // Le double simule le gestionnaire : une creation ajoute le webhook a la liste.
    if (res.body && res.body.cree && !webhooks.length) {
      webhooks.push({ id: 'wh-1', attributes: { callback_url: URL_ATTENDUE, event_mask: 'booking;message' } })
    }
  }
  const creations = etat.appels.filter(a => a.methode === 'POST').length
  assert.strictEqual(creations, 1, `une seule creation attendue, ${creations} observee(s)`)
  assert.strictEqual(etat.appels.filter(a => a.methode === 'PUT').length, 9)
})

// ─── L'endpoint de rattrapage est parti ─────────────────────────────────────
// ⚠ CE BALAYAGE A D'ABORD ETE ECRIT PAR FORME, et c'etait la troisieme fois
// dans la journee qu'un balayage par forme se trompait. Il cherchait une
// variable issue de `req.query` comparee a `process.env.*` : il attrapait
// l'endpoint supprime et RIEN D'AUTRE. Onze ecritures du meme defaut lui
// echappaient — comparaison en ligne sans variable intermediaire,
// destructuration (`const { secret } = req.query`), passage par une fonction,
// `includes`, `startsWith`, comparaison a une valeur derivee du secret.
//
// La propriete qui compte n'est pas une forme, c'est un COMPORTEMENT : la
// valeur d'un parametre de query ne doit JAMAIS changer le sort d'une requete
// en portant un secret d'environnement. On appelle donc chaque endpoint DEUX
// fois — une fois avec le secret, une fois avec une valeur fausse — et on exige
// que les deux issues soient IDENTIQUES.
//
// Ce qui rend ce balayage juste la ou le precedent se trompait :
//   - `api/book-public.js` et `api/manifest.js` lisent bien un `token` de query,
//     mais il EST le droit d'acces, comme un lien de partage, et il ne vaut pas
//     le secret d'environnement : les deux appels echouent pareil, donc verts —
//     sans aucune liste d'exceptions a maintenir.
//   - un endpoint qui compare, de quelque maniere que ce soit, rend deux issues
//     differentes, et se voit.
const SENTINELLE = 'valeur-sentinelle-du-balayage-query-0123456789'
const CLES_DE_QUERY = ['secret', 'token', 'key', 'cron_secret', 'cle', 'auth', 'password']

async function issueAvec (fichier, valeur) {
  const chemin = `../api/${fichier.replace(/\.js$/, '')}`
  preparer({})
  const handler = require(chemin)
  if (typeof handler !== 'function') return 'pas-un-endpoint'
  const res = reponse()
  const query = {}
  for (const k of CLES_DE_QUERY) query[k] = valeur
  // Aucun en-tete d'autorisation : si l'issue change, elle ne peut venir que de
  // la query.
  await handler({ method: 'GET', body: {}, query, headers: { host: HOTE_APP } }, res)
  return res.code === null ? 'aucune-reponse' : String(res.code)
}

test('LE TEST QUI COMPTE : aucune valeur de query ne vaut un secret d\'ENVIRONNEMENT', async () => {
  const fs = require('node:fs')
  const dossier = path.join(__dirname, '..', 'api')
  const fichiers = fs.readdirSync(dossier).filter(f => f.endsWith('.js'))

  // ⚠ SI LA LISTE SE VIDE, LE TEST NE PROUVE PLUS RIEN.
  assert.ok(fichiers.length >= 10,
    `le dossier api/ devrait porter au moins dix endpoints, ${fichiers.length} trouve(s) : `
    + 'ont-ils ete deplaces ?')

  const avant = process.env.CRON_SECRET
  process.env.CRON_SECRET = SENTINELLE
  const fautifs = []
  try {
    for (const f of fichiers) {
      try {
        const avecSecret = await issueAvec(f, SENTINELLE)
        const avecFaux = await issueAvec(f, 'valeur-manifestement-fausse')
        if (avecSecret !== avecFaux) {
          fautifs.push(`${f} (avec le secret : ${avecSecret}, avec une valeur fausse : ${avecFaux})`)
        }
      } catch (e) {
        // Inexaminable n'est pas sain : on le DIT.
        fautifs.push(`${f} (inexaminable : ${String(e.message).slice(0, 60)})`)
      }
    }
  } finally {
    if (avant === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = avant
  }
  assert.deepStrictEqual(fautifs, [],
    'chez ces endpoints, une valeur de query portant le secret d environnement change '
    + `l issue de la requete : ${fautifs.join(' | ')}`)
})

test('et la contre-epreuve : le balayage rougit sur l endpoint supprime, reecrit', async () => {
  // Sans elle, on ne saurait pas si le test ci-dessus passe parce que le defaut
  // est parti ou parce que la mesure ne distingue rien. On REMET le defaut, dans
  // une ecriture que l'ancien balayage par forme ne voyait PAS (destructuration
  // et comparaison en ligne), et on exige que celui-ci le voie.
  const fs = require('node:fs')
  const dossier = path.join(__dirname, '..', 'api')
  const temoin = '_temoin-balayage-query.js'
  const chemin = path.join(dossier, temoin)
  fs.writeFileSync(chemin, `
    module.exports = async function (req, res) {
      const { secret } = req.query || {}
      if (secret !== process.env.CRON_SECRET) return res.status(403).json({ error: 'Interdit' })
      return res.status(200).json({ ok: true })
    }
  `)
  const avant = process.env.CRON_SECRET
  process.env.CRON_SECRET = SENTINELLE
  try {
    const avecSecret = await issueAvec(temoin, SENTINELLE)
    const avecFaux = await issueAvec(temoin, 'valeur-manifestement-fausse')
    assert.strictEqual(avecSecret, '200')
    assert.strictEqual(avecFaux, '403')
    assert.notStrictEqual(avecSecret, avecFaux, 'le balayage doit voir cet ecart')
  } finally {
    if (avant === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = avant
    fs.unlinkSync(chemin)
  }
})

// ─── Ce que la rotation du secret exige de cette action ─────────────────────
// Constats de review du 1er octobre 2026. Ces trois-la ne mordent pas sur la
// faille fermee plus haut : ils mordent sur le GESTE SUIVANT, la rotation du
// secret, ou cette action est l'etape 5 du deroule.

test('LE TEST QUI COMPTE POUR LA ROTATION : les doublons restants sont COMPTES et DITS', async () => {
  // Pourquoi il compte : l'ancien code creait un webhook a CHAQUE appel, et son
  // bouton etait ouvert a tout compte connecte — l'etat probable de la prod est
  // donc plusieurs webhooks sur la meme URL. Mettre a jour le premier et se
  // taire ferait croire la rotation terminee, pendant que les autres livrent
  // les memes evenements avec l'ANCIEN secret, donc en 401 permanents.
  const etat = preparer({ webhooks: [
    { id: 'w-1', attributes: { callback_url: URL_ATTENDUE, event_mask: 'booking;message' } },
    { id: 'w-2', attributes: { callback_url: URL_ATTENDUE, event_mask: 'booking;message' } },
    { id: 'w-3', attributes: { callback_url: URL_ATTENDUE, event_mask: 'booking;message' } },
  ] })
  const handler = require('../api/channel-webhook')
  const res = reponse()
  await handler(requete({}), res)

  // La mise a jour porte sur le PREMIER, et les autres sont nommes.
  const put = etat.appels.find(a => a.methode === 'PUT')
  assert.ok(put, 'une mise a jour doit partir sur l existant')
  assert.match(put.url, /w-1$/)
  assert.deepStrictEqual(res.body.doublons_sur_cette_url, ['w-2', 'w-3'])
  assert.match(res.body.avertissement, /ANCIEN secret/)
})

test('un webhook du meme masque sous une AUTRE url est signale aussi', async () => {
  // La contre-epreuve du filet : une barre finale, un domaine propre, une URL de
  // recette suffisent a faire manquer l'egalite stricte. Celui-la garde l'ancien
  // secret sans apparaitre dans les doublons.
  const etat = preparer({ webhooks: [
    { id: 'w-1', attributes: { callback_url: URL_ATTENDUE, event_mask: 'booking;message' } },
    { id: 'w-vieux', attributes: { callback_url: URL_ATTENDUE + '/', event_mask: 'booking;message' } },
  ] })
  const handler = require('../api/channel-webhook')
  const res = reponse()
  await handler(requete({}), res)

  assert.deepStrictEqual(res.body.autres_webhooks_du_meme_masque,
    [{ id: 'w-vieux', url: URL_ATTENDUE + '/' }])
  assert.ok(!res.body.doublons_sur_cette_url, 'il n est pas sur la meme URL')
  assert.ok(etat.appels.find(a => a.methode === 'PUT'), 'la mise a jour a bien eu lieu')
})

test('CONTRE-EPREUVE : sans aucun autre webhook, la reponse ne porte AUCUN avertissement', async () => {
  // Sans ce cas, les deux tests du dessus passeraient aussi avec un code qui
  // crie au doublon tout le temps — et l'ecran de diagnostic resterait rouge
  // pour toujours.
  preparer({ webhooks: [{ id: 'w-1', attributes: { callback_url: URL_ATTENDUE, event_mask: 'booking;message' } }] })
  const handler = require('../api/channel-webhook')
  const res = reponse()
  await handler(requete({}), res)

  assert.strictEqual(res.body.doublons_sur_cette_url, undefined)
  assert.strictEqual(res.body.autres_webhooks_du_meme_masque, undefined)
  assert.strictEqual(res.body.avertissement, undefined)
  assert.strictEqual(res.body.ok, true)
  assert.strictEqual(res.body.updated, true)
})

test('une forme inattendue de liste ne declenche AUCUNE creation', async () => {
  // Constat de review : `data` non-tableau rendait `tous = []`, donc une
  // creation — exactement ce que la garde sur la liste illisible interdit.
  const etat = preparer({ webhooks: { id: 'w-1' } })
  const handler = require('../api/channel-webhook')
  const res = reponse()
  await handler(requete({}), res)

  assert.strictEqual(res.body.ok, false)
  assert.match(res.body.reason, /forme attendue/)
  assert.strictEqual(etat.appels.filter(a => a.methode === 'POST').length, 0,
    'aucune creation sur une liste illisible')
})

test('le succes porte `ok` et `registered`, comme le fichier voisin', async () => {
  // Pourquoi : `pages/diagnostic.html` lisait `res.ok` seul, donc peignait son
  // badge en vert sur les refus qui repondent 200 avec `ok:false`. Un contrat
  // asymetrique — `ok` dans l'echec, absent du succes — rend l'ecran incapable
  // de distinguer les deux.
  preparer({})
  const handler = require('../api/channel-webhook')
  const res = reponse()
  await handler(requete({}), res)

  assert.strictEqual(res.code, 201)
  assert.strictEqual(res.body.ok, true)
  assert.strictEqual(res.body.registered, true)
  assert.strictEqual(res.body.updated, false, 'une creation n est pas une mise a jour')
})
