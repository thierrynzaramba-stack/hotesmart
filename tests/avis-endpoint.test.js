// tests/avis-endpoint.test.js
// api/avis.js — lecture des avis et saisie manuelle. Domaine `avis`.
//
// Ce qui compte ici : un membre `avis=none` ne voit RIEN, un membre limité à un
// bien ne voit que le sien, et une référence de bien venue du client ne désigne
// rien tant qu'elle n'a pas été confrontée au périmètre (REVIEW.md règle 11).

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'cle-test'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

// ⚠ DE VRAIS UUID. `compteDemande` refuse un X-Compte qui n'en est pas un :
// avec des identifiants fantaisistes, les tests de delegation renvoyaient 403
// pour un format invalide, et non parce que la garde avait fait son travail.
// Ils passaient donc tous — pour la mauvaise raison.
const PROD   = '11111111-1111-4111-8111-111111111111'
const MEMBRE = '22222222-2222-4222-8222-222222222222'
const REF_A = '0544fd9a-6579-44e7-b75e-19c63a2019ba'   // Colomiers, Channex
const REF_B = '209413'                                  // La bulle, Beds24
const BIEN_A = { id: 'aa11bb22-cc33-4dd4-8ee5-ff6677889900', user_id: PROD, name: 'Colomiers',
                 provider: 'channex', provider_property_id: REF_A }
const BIEN_B = { id: 'bb22cc33-dd44-4ee5-8ff6-001122334455', user_id: PROD, name: 'La bulle',
                 provider: 'beds24', provider_property_id: REF_B }

const MODULES = ['../api/avis', '../lib/require-permission', '../lib/permissions',
                 '../lib/cron-reviews-classify', '../lib/cron-shared']

function preparer ({ user = PROD, profil = null, permissions = null, avis = [], snapshots = [] } = {}) {
  const etat = { ecritures: [], requetes: [] }

  const client = {
    auth: { getUser: async () => (user ? { data: { user: { id: user } }, error: null }
                                       : { data: null, error: { message: 'x' } }) },
    from (nom) {
      const q = { _f: {}, _or: null, table: nom }
      etat.requetes.push(q)
      const chain = {
        select (c, opts) { q._count = opts?.count; return chain },
        eq (c, v) { q._f[c] = v; return chain },
        or (e) { q._or = e; return chain },
        gte () { return chain }, order () { return chain }, limit () { return chain },
        is () { return chain }, not () { return chain },
        insert (row) { etat.ecritures.push({ table: nom, row }); q._row = row
                       return { select: () => ({ single: async () => ({ data: { id: 'nouvel-avis' }, error: null }) }) } },
        update (row) { etat.ecritures.push({ table: nom, row }); return chain },
        maybeSingle: async () => { const r = await rep(); return { data: Array.isArray(r.data) ? (r.data[0] || null) : r.data, error: r.error } },
        single: async () => { const r = await rep(); return { data: Array.isArray(r.data) ? (r.data[0] || null) : r.data, error: r.error } },
        then (ok, ko) { return rep().then(ok, ko) }
      }
      function rep () {
        if (nom === 'properties') {
          let c = [BIEN_A, BIEN_B].filter(b =>
            (q._f.user_id == null || b.user_id === q._f.user_id) &&
            (q._f.provider_property_id == null || b.provider_property_id === q._f.provider_property_id))
          if (q._or) c = c.filter(b => String(q._or).includes(b.provider_property_id))
          return Promise.resolve({ data: c, error: null })
        }
        if (nom === 'ota_reviews') {
          if (q._count === 'exact') return Promise.resolve({ count: 1, error: null })
          let c = avis.filter(a =>
            (q._f.property_id_ref == null || a.property_id_ref === q._f.property_id_ref))
          if (q._or) c = c.filter(a => String(q._or).includes(a.property_id_ref))
          return Promise.resolve({ data: c, error: null })
        }
        if (nom === 'bookings_snapshot') {
          const c = snapshots.filter(s =>
            (q._f.user_id == null || s.user_id === q._f.user_id) &&
            (q._f.property_id == null || s.property_id === q._f.property_id) &&
            (q._f.booking_id == null || String(s.booking_id) === String(q._f.booking_id)))
          return Promise.resolve({ data: c, error: null })
        }
        if (nom === 'profiles') {
          const ok = profil && profil.account_user_id === q._f.account_user_id &&
                              profil.member_user_id === q._f.member_user_id
          return Promise.resolve({ data: ok ? [profil] : [], error: null })
        }
        if (nom === 'profile_permissions') return Promise.resolve({ data: permissions ? [permissions] : [], error: null })
        return Promise.resolve({ data: [], error: null })
      }
      return chain
    }
  }

  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '{}' })
  return etat
}

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = () => {}
  return r
}

const AVIS_A = { id: 'r1', property_id_ref: REF_A, ai_clean_verdict: 'positif', received_at: '2026-08-30T00:00:00Z' }
const AVIS_B = { id: 'r2', property_id_ref: REF_B, ai_clean_verdict: 'remarque', received_at: '2026-08-20T00:00:00Z' }

function req (query = {}, body = null, method = 'GET') {
  return { method, query, body, headers: { authorization: 'Bearer jeton' } }
}

// ─── Lecture ────────────────────────────────────────────────────────────────
test('list : le titulaire voit les avis de tous ses biens', async () => {
  preparer({ avis: [AVIS_A, AVIS_B] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'list' }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.avis.length, 2)
})

test('list : un membre avis=none est refusé', async () => {
  preparer({
    user: MEMBRE, avis: [AVIS_A],
    profil: { account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { avis: 'none', property_scope: 'all' }
  })
  const handler = require('../api/avis')
  const res = reponse()
  await handler({ ...req({ action: 'list' }), headers: { authorization: 'Bearer jeton', 'x-compte': PROD } }, res)
  assert.strictEqual(res.code, 403)
})

test('list : un membre limité à un bien ne voit que le sien', async () => {
  preparer({
    user: MEMBRE, avis: [AVIS_A, AVIS_B],
    profil: { account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { avis: 'read', property_scope: 'some', property_ids: [BIEN_A.id], property_refs: [REF_A] }
  })
  const handler = require('../api/avis')
  const res = reponse()
  await handler({ ...req({ action: 'list' }), headers: { authorization: 'Bearer jeton', 'x-compte': PROD } }, res)
  assert.strictEqual(res.code, 200)
  assert.deepStrictEqual(res.body.avis.map(a => a.property_id_ref), [REF_A])
})

test('list : demander un bien HORS périmètre est refusé, pas silencieusement vidé', async () => {
  // Sans cette garde, un membre limité à un bien lirait les avis d'un autre en
  // passant sa référence dans l'URL.
  preparer({
    user: MEMBRE, avis: [AVIS_A, AVIS_B],
    profil: { account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { avis: 'read', property_scope: 'some', property_ids: [BIEN_A.id], property_refs: [REF_A] }
  })
  const handler = require('../api/avis')
  const res = reponse()
  await handler({ ...req({ action: 'list', bien: REF_B }), headers: { authorization: 'Bearer jeton', 'x-compte': PROD } }, res)
  assert.strictEqual(res.code, 403)
})

// ─── Saisie manuelle ────────────────────────────────────────────────────────
test('create : un membre avis=read ne peut PAS saisir', async () => {
  const etat = preparer({
    user: MEMBRE,
    profil: { account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { avis: 'read', property_scope: 'all' }
  })
  const handler = require('../api/avis')
  const res = reponse()
  await handler({ ...req({}, { action: 'create', bien: REF_A, texte: 'Très propre', source: 'sms' }, 'POST'),
                  headers: { authorization: 'Bearer jeton', 'x-compte': PROD } }, res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('create : la ligne écrite porte provider manuel et la source', async () => {
  const etat = preparer({})
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({}, { action: 'create', bien: REF_A, texte: 'Très propre, merci', source: 'sms', date: '2026-08-20' }, 'POST'), res)
  assert.strictEqual(res.code, 201)
  const ligne = etat.ecritures.find(e => e.table === 'ota_reviews').row
  assert.strictEqual(ligne.provider, 'manuel')
  assert.strictEqual(ligne.source, 'sms')
  assert.strictEqual(ligne.user_id, PROD)
  assert.strictEqual(ligne.property_id, BIEN_A.id)
  assert.strictEqual(ligne.property_id_ref, REF_A)
  assert.ok(ligne.external_review_id && ligne.external_review_id.length >= 32, 'un UUID est généré')
  // Pas de scores OTA : c'est ce qui envoie la classification à l'étage 2.
  assert.strictEqual(ligne.overall_score, undefined)
  assert.strictEqual(ligne.tags, undefined)
})

test('create : deux saisies produisent deux identifiants distincts', async () => {
  // UUID et non empreinte du contenu : deux voyageurs peuvent dire la même
  // chose, une empreinte les confondrait.
  const etat = preparer({})
  const handler = require('../api/avis')
  for (let i = 0; i < 2; i++) {
    await handler(req({}, { action: 'create', bien: REF_A, texte: 'Parfait', source: 'oral' }, 'POST'), reponse())
  }
  const ids = etat.ecritures.filter(e => e.table === 'ota_reviews' && e.row.external_review_id)
    .map(e => e.row.external_review_id)
  assert.strictEqual(new Set(ids).size, 2)
})

test('create : un bien hors périmètre est refusé', async () => {
  const etat = preparer({
    user: MEMBRE,
    profil: { account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { avis: 'write', property_scope: 'some', property_ids: [BIEN_A.id], property_refs: [REF_A] }
  })
  const handler = require('../api/avis')
  const res = reponse()
  await handler({ ...req({}, { action: 'create', bien: REF_B, texte: 'x', source: 'sms' }, 'POST'),
                  headers: { authorization: 'Bearer jeton', 'x-compte': PROD } }, res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('create : un canal de réception inventé est refusé', async () => {
  // La colonne porte un CHECK : une valeur libre ferait échouer l'insert.
  const etat = preparer({})
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({}, { action: 'create', bien: REF_A, texte: 'x', source: 'pigeon' }, 'POST'), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('create : un texte vide est refusé', async () => {
  const etat = preparer({})
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({}, { action: 'create', bien: REF_A, texte: '   ', source: 'sms' }, 'POST'), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('create : le rattachement à un séjour dénormalise les dates', async () => {
  const etat = preparer({ snapshots: [
    { user_id: PROD, property_id: REF_A, booking_id: 321,
      snapshot: { arrival: '2026-08-10', departure: '2026-08-14' } }
  ] })
  const handler = require('../api/avis')
  await handler(req({}, { action: 'create', bien: REF_A, texte: 'Impeccable', source: 'email', booking_uid: '321' }, 'POST'), reponse())
  const ligne = etat.ecritures.find(e => e.table === 'ota_reviews' && e.row.provider === 'manuel').row
  assert.strictEqual(ligne.booking_uid, '321')
  assert.strictEqual(ligne.stay_start, '2026-08-10')
  assert.strictEqual(ligne.stay_end, '2026-08-14')
})

test('create : un séjour d\'un AUTRE bien ne rattache rien, et ne bloque pas', async () => {
  // L'avis est saisi sans ancrage plutôt que perdu — mais il n'emprunte pas les
  // dates d'un séjour qui ne le concerne pas.
  const etat = preparer({ snapshots: [
    { user_id: PROD, property_id: REF_B, booking_id: 999, snapshot: { arrival: '2026-01-01' } }
  ] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({}, { action: 'create', bien: REF_A, texte: 'Bien', source: 'sms', booking_uid: '999' }, 'POST'), res)
  assert.strictEqual(res.code, 201)
  const ligne = etat.ecritures.find(e => e.table === 'ota_reviews' && e.row.provider === 'manuel').row
  assert.strictEqual(ligne.booking_uid, undefined)
  assert.strictEqual(ligne.stay_start, undefined)
})

// ─── Séjours ────────────────────────────────────────────────────────────────
test('sejours : un bien hors périmètre est refusé', async () => {
  preparer({
    user: MEMBRE, snapshots: [{ user_id: PROD, property_id: REF_B, booking_id: 1, snapshot: {} }],
    profil: { account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { avis: 'read', property_scope: 'some', property_ids: [BIEN_A.id], property_refs: [REF_A] }
  })
  const handler = require('../api/avis')
  const res = reponse()
  await handler({ ...req({ action: 'sejours', bien: REF_B }), headers: { authorization: 'Bearer jeton', 'x-compte': PROD } }, res)
  assert.strictEqual(res.code, 403)
})

test('sejours : triés du plus récent au plus ancien', async () => {
  preparer({ snapshots: [
    { user_id: PROD, property_id: REF_A, booking_id: 1, snapshot: { arrival: '2026-01-05' } },
    { user_id: PROD, property_id: REF_A, booking_id: 2, snapshot: { arrival: '2026-08-05' } }
  ] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'sejours', bien: REF_A }), res)
  assert.deepStrictEqual(res.body.sejours.map(s => s.booking_uid), ['2', '1'])
})
