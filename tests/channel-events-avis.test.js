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
