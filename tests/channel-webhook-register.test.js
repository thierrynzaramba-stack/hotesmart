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

function preparer ({ user = TITULAIRE, profil = null, permissions = null } = {}) {
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
    etat.appels.push({ url: String(url), methode: opts.method || 'GET', corps })
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

test('LE TEST QUI COMPTE : un hote inconnu ne choisit pas la cible non plus', async () => {
  // La cible se construit depuis une liste blanche, pas depuis l'en-tete `Host`.
  // Sans cela, un appel avec `Host: chez-moi.example` deplacerait le webhook.
  const etat = preparer({})
  const handler = require('../api/channel-webhook')
  await handler(requete({}, { host: 'chez-moi.example' }), reponse())
  const post = etat.appels.find(a => a.methode === 'POST')
  assert.strictEqual(post.corps.webhook.callback_url, URL_ATTENDUE)
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
// ailleurs, et c'est prouve plus haut. Ce qui reste ouvert est plus etroit :
// tout utilisateur connecte peut declencher un enregistrement vers LA BONNE
// cible — donc, au pire, creer un DOUBLON de webhook global, ce qui fait livrer
// chaque event deux fois et executer deux fois le mapping.
//
// Le fichier voisin a ferme ce cas en cherchant l'existant pour le mettre a jour
// (PUT) plutot qu'en creant a l'aveugle. Ce n'est PAS fait ici : la consigne
// etait une correction MINIMALE de l'action `register`. C'est une decision qui
// revient a Thierry, et elle est nommee plutot que subie.
test('CE QUI RESTE OUVERT, ET C’EST MESURE : tout utilisateur connecte passe la garde', async () => {
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
  // CE QUE LE CORRECTIF FERME QUAND MEME, et c'est l'essentiel : la cible etant
  // construite par le serveur, le secret ne peut plus etre livre ailleurs — les
  // deux tests du haut le prouvent. CE QUI RESTE : un utilisateur connecte peut
  // declencher un enregistrement vers la BONNE cible, donc au pire creer un
  // DOUBLON de webhook global, ce qui fait livrer chaque event deux fois et
  // executer deux fois le mapping.
  //
  // Le fichier voisin a ferme ce cas en cherchant l'existant pour le mettre a
  // jour (PUT) au lieu de creer a l'aveugle. Ce n'est pas fait ici : la consigne
  // etait une correction MINIMALE. Ce test rougira le jour ou la decision sera
  // prise, au lieu de laisser le cas passer inapercu.
  const etat = preparer({ user: MEMBRE })
  const handler = require('../api/channel-webhook')
  const res = reponse()
  await handler(requete({}), res)

  assert.strictEqual(res.code, 201, 'aujourd hui il passe — a changer si Thierry tranche')
  const post = etat.appels.find(a => a.methode === 'POST')
  assert.strictEqual(post.corps.webhook.callback_url, URL_ATTENDUE,
    'mais la cible reste celle du serveur : le secret ne sort pas')
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
  // Mais la structure reste lisible : on doit pouvoir verifier qu'un en-tete est
  // bien pose, sans en voir la valeur.
  assert.deepStrictEqual(res.body.data.attributes.headers, ['X-Channel-Webhook-Secret'])
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
