// tests/channel-events-avis.test.js
// Event `updated_review` sur le 2e webhook (api/channel-events.js).
//
// Ce webhook n'est PAS la source de vérité : le poll quotidien l'est. Il n'apporte
// que la fraîcheur. Deux propriétés comptent donc plus que tout : il écrit par le
// MÊME writer que le poll (donc mêmes gardes de cloisonnement, même idempotence),
// et il ne casse rien quand il reçoit autre chose que ce qu'il attend.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'https://api.exemple'
process.env.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY || 'cle-test'
process.env.CHANNEL_WEBHOOK_SECRET = 'secret-de-test'
// api/channel-events.js charge lib/billing.js, qui construit un client Stripe
// au chargement du module. Une valeur factice suffit : rien ne l'appelle ici.
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_factice'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const PROD = 'compte-prod'
const REF_CHANNEX = '0544fd9a-6579-44e7-b75e-19c63a2019ba'
const BIEN = { id: 'aa11bb22-cc33-4dd4-8ee5-ff6677889900', user_id: PROD,
               provider: 'channex', provider_property_id: REF_CHANNEX }

const MODULES = ['../api/channel-events', '../lib/cron-channel-reviews',
                 '../lib/cron-shared', '../lib/channels', '../lib/bookings-snapshot',
                 '../lib/billing']

function avisChannex (over = {}) {
  return {
    id: 'rev-9', type: 'review',
    attributes: {
      id: 'rev-9', ota: 'AirBNB', overall_score: 9,
      scores: [{ category: 'clean', score: 9 }],
      tags: [], content: 'Parfait', raw_content: { public_review: 'Parfait' },
      reply: {}, is_replied: false, is_hidden: false,
      ota_reservation_id: 'HMCODE1', received_at: '2026-08-30T18:29:33Z',
      expired_at: '2026-09-29T18:29:33Z', is_expired: false,
      updated_at: '2026-08-30T18:29:55Z', guest_name: 'Fanny D.',
      ...over
    },
    relationships: { property: { data: { id: REF_CHANNEX } } }
  }
}

// `biens` : ce que renvoie la table properties. Vide = bien non rattaché.
function preparer ({ biens = [BIEN], snapshots = [], fetchStub = null } = {}) {
  const etat = { ecritures: [], appels: [] }

  const client = {
    auth: { getUser: async () => ({ data: { user: { id: PROD } }, error: null }) },
    from (nom) {
      const q = {
        _f: {},
        select () { return q },
        eq (c, v) { q._f[c] = v; return q },
        is () { return q }, not () { return q }, order () { return q },
        limit () { return Promise.resolve(rep(nom, true)) },
        upsert (r, o) { etat.ecritures.push({ table: nom, row: r, opts: o }); return Promise.resolve({ error: null }) },
        update () { return q },
        maybeSingle: async () => rep(nom, false),
        then (ok, ko) { return Promise.resolve(rep(nom, true)).then(ok, ko) }
      }
      function rep (nom, tableau) {
        if (nom === 'properties') {
          const c = biens.filter(b =>
            (q._f.provider_property_id == null || b.provider_property_id === q._f.provider_property_id) &&
            (q._f.provider == null || b.provider === q._f.provider))
          return { data: tableau ? c : (c[0] || null), error: null }
        }
        if (nom === 'bookings_snapshot') {
          const rows = snapshots.filter(s => q._f.user_id == null || s.user_id === q._f.user_id)
          return { data: tableau ? rows : (rows[0] || null), error: null }
        }
        return { data: tableau ? [] : null, error: null }
      }
      return q
    }
  }

  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }

  globalThis.fetch = async (url, opts) => {
    etat.appels.push({ url: String(url), method: opts?.method || 'GET' })
    if (fetchStub) { const r = await fetchStub(String(url), opts); if (r) return r }
    return { ok: true, status: 200, text: async () => '{}' }
  }
  return etat
}

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = () => {}
  return r
}

function requete (body, secret = 'secret-de-test') {
  return { method: 'POST', headers: { 'x-channel-webhook-secret': secret }, body }
}

// ─── Le cas nominal ─────────────────────────────────────────────────────────
test('updated_review : l\'avis est écrit par le writer commun', async () => {
  const etat = preparer({})
  const handler = require('../api/channel-events')
  const res = reponse()
  await handler(requete({ event: 'updated_review', payload: { data: avisChannex() } }), res)

  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.written, 1)
  const ecr = etat.ecritures.find(e => e.table === 'ota_reviews')
  assert.ok(ecr, 'la ligne doit être écrite')
  // MÊME contrainte que le poll : rejouer l'event est sans effet.
  assert.strictEqual(ecr.opts.onConflict, 'user_id,provider,external_review_id')
  const ligne = Array.isArray(ecr.row) ? ecr.row[0] : ecr.row
  assert.strictEqual(ligne.user_id, PROD)
  assert.strictEqual(ligne.property_id, BIEN.id)
  assert.strictEqual(ligne.property_id_ref, REF_CHANNEX)
  assert.strictEqual(ligne.external_review_id, 'rev-9')
  assert.strictEqual(ligne.provider, 'channex')
})

test('updated_review : la réponse de l\'hôte est actualisée sur la ligne existante', async () => {
  // Actualiser, c'est tout l'intérêt de ce webhook face au poll quotidien :
  // l'hôte répond, l'avis change, la ligne suit sans attendre le lendemain.
  const etat = preparer({})
  const handler = require('../api/channel-events')
  const res = reponse()
  await handler(requete({ event: 'updated_review', payload: {
    data: avisChannex({ reply: { reply: 'Merci de votre séjour' }, is_replied: true })
  } }), res)

  const ligne = etat.ecritures.find(e => e.table === 'ota_reviews').row[0]
  assert.strictEqual(ligne.reply, 'Merci de votre séjour')
  assert.strictEqual(ligne.is_replied, true)
})

test('updated_review : le séjour est dénormalisé quand la réservation est connue', async () => {
  const etat = preparer({ snapshots: [
    { user_id: PROD, booking_id: 321, snapshot: { otaReservationCode: 'HMCODE1', arrival: '2026-08-10', departure: '2026-08-14' } }
  ] })
  const handler = require('../api/channel-events')
  const res = reponse()
  await handler(requete({ event: 'updated_review', payload: { data: avisChannex() } }), res)

  assert.strictEqual(res.body.resolved, true)
  // upsertAvis normalise en lot : le webhook envoie un tableau d'un element.
  const ligne = etat.ecritures.find(e => e.table === 'ota_reviews').row[0]
  assert.strictEqual(ligne.booking_uid, '321')
  assert.strictEqual(ligne.stay_start, '2026-08-10')
})

// ─── Le payload qui ne porte qu'un identifiant ──────────────────────────────
test('updated_review : un payload réduit à un id déclenche la relecture provider', async () => {
  const etat = preparer({ fetchStub: async (url) => {
    if (url.includes('/reviews/rev-9')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: avisChannex() }) }
    }
    return null
  } })
  const handler = require('../api/channel-events')
  const res = reponse()
  await handler(requete({ event: 'updated_review', payload: { review_id: 'rev-9' } }), res)

  assert.ok(etat.appels.some(a => a.url.includes('/reviews/rev-9')), 'l\'avis doit être relu chez le provider')
  assert.strictEqual(res.body.written, 1)
})

test('updated_review : un avis illisible chez le provider ne fait pas échouer le webhook', async () => {
  // Un 500 ferait rejouer l'event par le provider ; le poll quotidien rattrape
  // de toute façon. On répond 200 en disant pourquoi.
  const etat = preparer({ fetchStub: async () => ({ ok: false, status: 404, text: async () => '{}' }) })
  const handler = require('../api/channel-events')
  const res = reponse()
  await handler(requete({ event: 'updated_review', payload: { review_id: 'inconnu' } }), res)

  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.reason, 'review_illisible')
  assert.strictEqual(etat.ecritures.filter(e => e.table === 'ota_reviews').length, 0)
})

test('updated_review : un payload sans avis ni identifiant n\'écrit rien', async () => {
  const etat = preparer({})
  const handler = require('../api/channel-events')
  const res = reponse()
  await handler(requete({ event: 'updated_review', payload: {} }), res)

  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.reason, 'review_sans_id')
  assert.strictEqual(etat.ecritures.filter(e => e.table === 'ota_reviews').length, 0)
})

// ─── Cloisonnement : la garde du writer commun s'applique ───────────────────
test('updated_review : un avis dont le bien n\'est pas rattaché n\'est jamais écrit', async () => {
  // Une seule clé Channex voit les avis de TOUS les comptes de la plateforme.
  const etat = preparer({ biens: [] })
  const handler = require('../api/channel-events')
  const res = reponse()
  await handler(requete({ event: 'updated_review', payload: { data: avisChannex() } }), res)

  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.reason, 'ignored:bien_inconnu')
  assert.strictEqual(etat.ecritures.filter(e => e.table === 'ota_reviews').length, 0)
})

test('updated_review : deux comptes sur la même référence -> rien n\'est écrit', async () => {
  const etat = preparer({ biens: [
    { id: 'a', user_id: 'compte-a', provider: 'channex', provider_property_id: REF_CHANNEX },
    { id: 'b', user_id: 'compte-b', provider: 'channex', provider_property_id: REF_CHANNEX }
  ] })
  const handler = require('../api/channel-events')
  const res = reponse()
  await handler(requete({ event: 'updated_review', payload: { data: avisChannex() } }), res)

  assert.strictEqual(res.body.reason, 'ignored:bien_ambigu')
  assert.strictEqual(etat.ecritures.filter(e => e.table === 'ota_reviews').length, 0)
})

// ─── Ce qui n'est pas un avis ───────────────────────────────────────────────
test('un événement inconnu est ignoré sans erreur', async () => {
  const etat = preparer({})
  const handler = require('../api/channel-events')
  const res = reponse()
  await handler(requete({ event: 'un_event_que_personne_ne_connait', payload: { x: 1 } }), res)

  assert.strictEqual(res.code, 200, 'un event inconnu ne doit jamais faire échouer le webhook')
  assert.strictEqual(res.body.reason, 'ignored:un_event_que_personne_ne_connait')
  assert.strictEqual(etat.ecritures.length, 0)
})

test('updated_review ne déclenche PAS la chaîne de mapping des canaux', async () => {
  // La chaîne canal résout un canal, tire les réservations et importe les
  // messages : un avis ne doit rien avoir à faire là-dedans.
  const etat = preparer({})
  const handler = require('../api/channel-events')
  const res = reponse()
  await handler(requete({ event: 'updated_review', payload: { data: avisChannex() } }), res)

  assert.ok(!etat.appels.some(a => a.url.includes('/channels')), 'aucun appel canal ne doit partir')
  assert.strictEqual(etat.ecritures.filter(e => e.table === 'bookings_snapshot').length, 0)
})

test('le secret partagé garde aussi les avis', async () => {
  const etat = preparer({})
  const handler = require('../api/channel-events')
  const res = reponse()
  await handler(requete({ event: 'updated_review', payload: { data: avisChannex() } }, 'mauvais-secret'), res)

  assert.strictEqual(res.code, 401)
  assert.strictEqual(etat.ecritures.length, 0)
})

// ─── Enregistrement du webhook : la zone que la suite ne regardait pas ──────
// Le constat le plus grave de la review du lot 3 est tombé ici : `callback_url`
// vient du client, et rien ne validait la ressource visée par le PUT.

const URL_MOI = 'https://hotesmart.vercel.app/api/channel-events'
const URL_CERTIFIE = 'https://hotesmart.vercel.app/api/channel-webhook'

function webhooksExistants () {
  return { data: [
    { id: 'wh-certifie', attributes: { callback_url: URL_CERTIFIE, event_mask: 'booking;message' } },
    { id: 'wh-moi', attributes: { callback_url: URL_MOI, event_mask: 'new_channel;updated_channel;activate_channel' } }
  ] }
}

function preparerRegister ({ webhooks = webhooksExistants(), listeOk = true } = {}) {
  return preparer({ fetchStub: async (url, opts) => {
    const method = opts?.method || 'GET'
    if (url.endsWith('/webhooks') && method === 'GET') {
      return { ok: listeOk, status: listeOk ? 200 : 500, text: async () => JSON.stringify(listeOk ? webhooks : {}) }
    }
    if (url.includes('/webhooks/') && method === 'PUT') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { id: 'maj' } }) }
    }
    if (url.endsWith('/webhooks') && method === 'POST') {
      return { ok: true, status: 201, text: async () => JSON.stringify({ data: { id: 'cree' } }) }
    }
    return null
  } })
}

function requeteRegister (callbackUrl) {
  return { method: 'POST', headers: { authorization: 'Bearer jeton' },
           body: { action: 'register', callback_url: callbackUrl } }
}

test('register : le webhook CERTIFIÉ ne peut pas être ciblé par une session quelconque', async () => {
  // Sans cette garde, n'importe quel hôte connecté réécrivait le masque du
  // webhook certifié : plus aucune réservation ni message voyageur en temps
  // réel, pour TOUS les hôtes Channex, avec une réponse « succès ». L'URL du
  // webhook certifié est publique (elle figure dans pages/diagnostic.html).
  const etat = preparerRegister({})
  const handler = require('../api/channel-events')
  const res = reponse()
  await handler(requeteRegister(URL_CERTIFIE), res)

  assert.strictEqual(res.code, 400)
  assert.ok(!etat.appels.some(a => a.method === 'PUT'),
    'aucun PUT ne doit partir vers un webhook qui n\'est pas le nôtre')
})

test('register : un webhook portant booking/message est refusé même s\'il passe l\'URL', async () => {
  // Filet redondant et voulu : si une URL changeait un jour et passait la
  // première garde, le masque existant trahit encore le webhook certifié.
  const etat = preparerRegister({ webhooks: { data: [
    { id: 'wh-piege', attributes: { callback_url: URL_MOI, event_mask: 'booking;message' } }
  ] } })
  const handler = require('../api/channel-events')
  const res = reponse()
  await handler(requeteRegister(URL_MOI), res)

  assert.strictEqual(res.code, 409)
  assert.ok(!etat.appels.some(a => a.method === 'PUT'))
})

test('register : le masque de NOTRE webhook est mis à jour, pas dupliqué', async () => {
  const etat = preparerRegister({})
  const handler = require('../api/channel-events')
  const res = reponse()
  await handler(requeteRegister(URL_MOI), res)

  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.updated, true)
  const put = etat.appels.find(a => a.method === 'PUT')
  assert.ok(put && put.url.includes('/webhooks/wh-moi'), 'le PUT doit viser NOTRE webhook')
  assert.ok(!etat.appels.some(a => a.method === 'POST' && a.url.endsWith('/webhooks')),
    'aucune création : elle produirait un doublon et une double livraison')
})

test('register : le PUT renvoie le secret partagé et les request_params', async () => {
  // Si le gestionnaire remplace l'objet au lieu de le fusionner, omettre les
  // headers ferait perdre le secret : toutes les livraisons suivantes seraient
  // rejetées en 401 par notre propre garde. Webhook mort, pas seulement masque
  // cassé.
  let corps = null
  const etat = preparer({ fetchStub: async (url, opts) => {
    const method = opts?.method || 'GET'
    if (url.endsWith('/webhooks') && method === 'GET') {
      return { ok: true, status: 200, text: async () => JSON.stringify(webhooksExistants()) }
    }
    if (method === 'PUT') {
      corps = JSON.parse(opts.body)
      return { ok: true, status: 200, text: async () => '{"data":{}}' }
    }
    return null
  } })
  const handler = require('../api/channel-events')
  await handler(requeteRegister(URL_MOI), reponse())

  assert.ok(corps.webhook.headers['X-Channel-Webhook-Secret'], 'le secret doit être renvoyé')
  assert.ok(corps.webhook.event_mask.includes('updated_review'))
  assert.ok(corps.webhook.event_mask.includes('activate_channel'), 'les events canal restent')
})

test('register : liste des webhooks illisible -> aucune création à l\'aveugle', async () => {
  // Créer sans savoir si le webhook existe produirait un doublon : chaque event
  // livré deux fois, donc runPostMapping exécuté deux fois.
  const etat = preparerRegister({ listeOk: false })
  const handler = require('../api/channel-events')
  const res = reponse()
  await handler(requeteRegister(URL_MOI), res)

  assert.strictEqual(res.body.ok, false)
  assert.ok(!etat.appels.some(a => a.method === 'POST' && a.url.endsWith('/webhooks')))
})

test('register : sans session, rien ne part', async () => {
  const etat = preparer({})
  const handler = require('../api/channel-events')
  const res = reponse()
  await handler({ method: 'POST', headers: {}, body: { action: 'register', callback_url: URL_MOI } }, res)

  assert.strictEqual(res.code, 401)
  assert.strictEqual(etat.appels.length, 0)
})

// ─── Le chemin d'exception, jamais exercé jusqu'ici ─────────────────────────
test('updated_review : une exception réseau ne produit PAS un 500', async () => {
  // Un 500 fait retenter le provider : boucle de rejeu, et reportIncident
  // réveille le canal fondateur pour une panne que le poll rattrape seul.
  const etat = preparer({ fetchStub: async () => { throw new Error('ECONNRESET') } })
  const handler = require('../api/channel-events')
  const res = reponse()
  await handler(requete({ event: 'updated_review', payload: { review_id: 'rev-9' } }), res)

  assert.strictEqual(res.code, 200, 'une coupure réseau ne doit pas déclencher de rejeu')
  assert.strictEqual(res.body.reason, 'review_exception')
  assert.strictEqual(etat.ecritures.filter(e => e.table === 'ota_reviews').length, 0)
})

// ─── La cible du webhook est construite par le serveur ──────────────────────
// Deuxième constat de sécurité, trouvé sur le correctif du premier : valider le
// seul CHEMIN du callback_url laissait l'hôte libre. Le corps envoyé au
// gestionnaire contient CHANNEL_WEBHOOK_SECRET et le bypass Vercel : livrer ce
// corps chez un hôte choisi par l'appelant, c'est lui donner les deux secrets —
// puis de quoi forger des events sur le webhook certifié.

const HOTES_REFUSES = [
  'https://evil.example.com/api/channel-events',            // hôte étranger, chemin valide
  'https://hotesmart.vercel.app.evil.com/api/channel-events', // sous-domaine trompeur
  'http://127.0.0.1:9/api/channel-events',                  // boucle locale
  'x/api/channel-events'                                    // même pas une URL
]

for (const url of HOTES_REFUSES) {
  test(`register : cible refusée, et aucun secret n'est envoyé — ${url.slice(0, 42)}`, async () => {
    const etat = preparerRegister({})
    const handler = require('../api/channel-events')
    const res = reponse()
    await handler(requeteRegister(url), res)

    assert.strictEqual(res.code, 400, 'le chemin seul ne suffit pas à valider une cible')
    assert.strictEqual(etat.appels.length, 0, 'aucun appel ne doit partir vers le gestionnaire')
  })
}

test('register : sans callback_url, le serveur détermine la cible et enregistre', async () => {
  // La donnée client n'est plus nécessaire : elle n'est plus utilisée.
  const etat = preparerRegister({})
  const handler = require('../api/channel-events')
  const res = reponse()
  await handler({ method: 'POST', headers: { authorization: 'Bearer jeton' },
                  body: { action: 'register' } }, res)

  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.updated, true)
  const put = etat.appels.find(a => a.method === 'PUT')
  assert.ok(put.url.includes('/webhooks/wh-moi'))
})

test('register : un webhook existant sans identifiant ne provoque pas de doublon', async () => {
  // Cette entrée sautait la garde du masque et tombait sur la création : deux
  // webhooks sur la même URL, donc chaque event livré deux fois.
  const etat = preparerRegister({ webhooks: { data: [
    { attributes: { callback_url: URL_MOI, event_mask: 'booking;message' } }
  ] } })
  const handler = require('../api/channel-events')
  const res = reponse()
  await handler(requeteRegister(URL_MOI), res)

  assert.strictEqual(res.body.ok, false)
  assert.ok(!etat.appels.some(a => a.method === 'POST' && a.url.endsWith('/webhooks')))
})

test('register : le filet booking/message ignore la casse', async () => {
  const etat = preparerRegister({ webhooks: { data: [
    { id: 'wh-x', attributes: { callback_url: URL_MOI, event_mask: 'BOOKING;MESSAGE' } }
  ] } })
  const handler = require('../api/channel-events')
  const res = reponse()
  await handler(requeteRegister(URL_MOI), res)

  assert.strictEqual(res.code, 409)
  assert.ok(!etat.appels.some(a => a.method === 'PUT'))
})
