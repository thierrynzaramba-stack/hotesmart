// tests/avis-cartes-endpoint.test.js — l'action `cartes` de api/avis.js (recette
// de Thierry du 7 octobre 2026) : une carte par sejour, trois sections, les
// compteurs sans les avis masques, et LES MEMES GARDES que `list` et
// `evaluations` (domaine avis, perimetre par bien, sejour sous `reservations`).
//
// ⚠ La route lit l'horloge : dates RELATIVES a aujourd'hui (regle du depot).

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'cle-test'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

const PROD = '11111111-1111-4111-8111-111111111111'
const MEMBRE = '22222222-2222-4222-8222-222222222222'
const TIERS = '33333333-3333-4333-8333-333333333333'
const REF_A = '0544fd9a-6579-44e7-b75e-19c63a2019ba'
const REF_B = '209413'
const BIEN_A = { id: 'aa11bb22-cc33-4dd4-8ee5-ff6677889900', user_id: PROD, name: 'Colomiers', provider: 'channex', provider_property_id: REF_A }
const BIEN_B = { id: 'bb22cc33-dd44-4ee5-8ff6-001122334455', user_id: PROD, name: 'La bulle', provider: 'beds24', provider_property_id: REF_B }
const MODULES = ['../api/avis', '../lib/require-permission', '../lib/permissions', '../lib/cron-reviews-classify', '../lib/cron-shared', '../lib/stats-avis']

const jour = n => new Date(Date.now() + n * 86400000).toISOString()
const j10 = n => jour(n).slice(0, 10)

function preparer ({ user = PROD, profil = null, permissions = null, avis = [], evaluations = [], snapshots = [], menages = [], prestataires = [] } = {}) {
  const etat = { requetes: [] }
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: user } }, error: null }) },
    from (nom) {
      const q = { table: nom, _f: {}, _ins: [], _neq: {} }
      etat.requetes.push(q)
      const chain = {
        select (c, o) { q._col = c; q._count = o && o.count; q._head = !!(o && o.head); return chain },
        eq (c, v) { q._f[c] = v; return chain },
        neq (c, v) { q._neq[c] = v; return chain },
        or (e) { q._or = e; return chain },
        gte (c, v) { q._gte = [c, v]; return chain },
        in (c, v) { q._ins.push([c, (v || []).map(String)]); return chain },
        is () { return chain }, not (c, op, v) { if (op === 'is' && v === null) q._nonNul = c; return chain },
        order () { return chain }, limit () { return chain },
        range (a, z) { q._range = [a, z]; return chain },
        maybeSingle: async () => { const r = await rep(); return { data: (r.data || [])[0] || null, error: r.error } },
        then (ok, ko) { return rep().then(ok, ko) },
      }
      const garde = (l) => Object.entries(q._f).every(([c, v]) => (c === 'statut' ? (l.statut || 'confirme') === v : c === 'is_hidden' ? (l.is_hidden === true) === v : String(l[c]) === String(v)))
        && q._ins.every(([c, vs]) => vs.includes(String(l[c])))
        && Object.entries(q._neq).every(([c, v]) => (c === 'statut' ? (l.statut || 'confirme') : l[c]) !== v)
        && (!q._gte || String(l[q._gte[0]] || '') >= String(q._gte[1]))
        && (!q._or || String(q._or).includes(String(l.property_id_ref || l.provider_property_id)))
        && (!q._nonNul || l[q._nonNul] != null)
      function rep () {
        let lignes
        if (nom === 'properties') lignes = [BIEN_A, BIEN_B]
        else if (nom === 'ota_reviews') lignes = avis.map(a => ({ ...a, cache: a.is_hidden === true ? true : a.is_hidden === false ? false : undefined }))
        else if (nom === 'guest_evaluations') lignes = evaluations
        else if (nom === 'bookings_snapshot') lignes = snapshots
        else if (nom === 'menages') lignes = menages
        else if (nom === 'profiles') {
          // Deux usages : la garde (profil du membre) et le nom des prestataires.
          if (q._ins.length) lignes = prestataires
          else lignes = profil && profil.account_user_id === q._f.account_user_id && profil.member_user_id === q._f.member_user_id ? [profil] : []
          if (!q._ins.length) return Promise.resolve({ data: lignes, error: null })
        } else if (nom === 'profile_permissions') {
          const table = [{ profile_id: 'profil-tiers', avis: 'write', property_scope: 'all' }]
          if (permissions && profil) table.push({ ...permissions, profile_id: profil.id })
          return Promise.resolve({ data: table.filter(r => q._f.profile_id == null || r.profile_id === q._f.profile_id), error: null })
        } else lignes = []
        let c = lignes.filter(garde)
        if (q._count === 'exact') return Promise.resolve({ data: q._head ? null : c, count: c.length, error: null })
        if (q._range) c = c.slice(q._range[0], q._range[1] + 1)
        return Promise.resolve({ data: c, error: null })
      }
      return chain
    },
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
  return etat
}
const reponse = () => { const r = { code: null, body: null }; r.status = c => { r.code = c; return r }; r.json = b => { r.body = b; return r }; r.setHeader = () => {}; return r }
const appeler = async (query, headers = {}) => {
  const res = reponse()
  await require('../api/avis')({ method: 'GET', query: { action: 'cartes', ...query }, body: null, headers: { authorization: 'Bearer jeton', ...headers } }, res)
  return res
}

const avisDe = (id, extra = {}) => ({ id, user_id: PROD, provider: 'channex', ota: 'airbnb', statut: 'confirme', property_id_ref: REF_A, content: 'Top', content_public: 'Top', overall_score: 10, ai_clean_verdict: 'positif', ai_analyzed_at: jour(-2), received_at: jour(-2), is_hidden: false, ...extra })
const MASQUE = avisDe('m', { is_hidden: true, overall_score: 0, content: null, content_public: null, booking_uid: 'u-masque' })
const EVAL = { id: 'e1', user_id: PROD, booking_uid: 'u-masque', property_id: BIEN_A.id, property_id_ref: REF_A, ota: 'airbnb', status: 'a_remplir', deadline_at: jour(5), published_at: null, public_text: null, ota_review_id: 'm', created_at: jour(-3) }
const SNAP = { user_id: PROD, booking_id: 'u-masque', property_id: REF_A, snapshot: { firstName: 'Angela', lastName: 'X', arrival: j10(-4), departure: j10(-3) } }

test('LE TEST QUI COMPTE (points A, C, E) : le titulaire — une carte par sejour, trois sections, et le masque ne compte ni au total ni a la moyenne', async () => {
  preparer({ avis: [avisDe('a1', { overall_score: 8 }), MASQUE, avisDe('vieux', { received_at: jour(-90), overall_score: 10 })], evaluations: [EVAL], snapshots: [SNAP] })
  const r = await appeler({ periode: 'toujours' })
  assert.equal(r.code, 200)
  assert.deepEqual(r.body.cartes.attente.map(c => c.cle), ['sejour:u-masque'])
  const c = r.body.cartes.attente[0]
  assert.equal(c.avis[0].masque, true)
  assert.equal(c.avis[0].note, null)
  assert.deepEqual(c.voyageur, { prenom: 'Angela', nom: 'X' })
  assert.deepEqual(r.body.cartes.recents.map(x => x.cle), ['avis:a1'])
  assert.equal(r.body.cartes.anciens, null, 'les anciens ne partent que sur demande')
  assert.equal(r.body.anciens_total, 1)
  assert.equal(r.body.stats.total, 2, 'le masque est hors du total')
  assert.equal(r.body.stats.moyenne, 9, 'moyenne de 8 et 10 : ni le 0 du masque')
  const avec = await appeler({ periode: 'toujours', anciens: '1' })
  assert.deepEqual(avec.body.cartes.anciens.map(x => x.cle), ['avis:vieux'])
})

test('SECURITE : un avis d un AUTRE compte n apparait jamais', async () => {
  preparer({ avis: [avisDe('a1'), avisDe('tiers', { user_id: TIERS })] })
  const r = await appeler({ anciens: '1' })
  const toutes = [...r.body.cartes.attente, ...r.body.cartes.recents, ...r.body.cartes.anciens]
  assert.deepEqual(toutes.map(c => c.cle), ['avis:a1'])
})

const membre = (permissions) => ({
  user: MEMBRE,
  profil: { id: 'profil-1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
  permissions,
})
const enTantQueMembre = q => appeler(q, { 'x-compte': PROD })

test('SECURITE : un membre limite a un bien ne voit que ses cartes ; l autre bien demande est REFUSE', async () => {
  preparer({ ...membre({ avis: 'read', reservations: 'read', property_scope: 'some', property_ids: [BIEN_A.id], property_refs: [REF_A] }),
    avis: [avisDe('a1'), avisDe('b1', { property_id_ref: REF_B, provider: 'beds24', ota: 'booking' })] })
  const r = await enTantQueMembre({ anciens: '1' })
  assert.equal(r.code, 200)
  assert.deepEqual([...r.body.cartes.recents, ...r.body.cartes.anciens].map(c => c.cle), ['avis:a1'])
  assert.deepEqual(r.body.biens.map(b => b.provider_property_id), [REF_A])
  assert.equal((await enTantQueMembre({ bien: REF_B })).code, 403)
})

test('SECURITE : un membre `avis: read` / `reservations: none` ne recoit ni le nom ni les dates du sejour d un avis seul', async () => {
  preparer({ ...membre({ avis: 'read', reservations: 'none', property_scope: 'all' }),
    avis: [avisDe('a1', { booking_uid: 'u1', guest_name: 'Fanny D.', stay_start: j10(-5), stay_end: j10(-3) })],
    snapshots: [{ user_id: PROD, booking_id: 'u1', property_id: REF_A, snapshot: { firstName: 'Fanny', lastName: 'D.', arrival: j10(-5), departure: j10(-3) } }] })
  const r = await enTantQueMembre({})
  assert.equal(r.code, 200)
  const c = r.body.cartes.recents[0]
  assert.equal(c.voyageur, null)
  assert.equal(c.depart, null)
  assert.ok(!JSON.stringify(r.body).includes('Fanny'), 'le nom ne sort nulle part')
  assert.ok(!JSON.stringify(r.body).includes(j10(-5)) && !JSON.stringify(r.body).includes(j10(-3)), 'ni les dates du sejour')
  assert.ok(!JSON.stringify(r.body).includes('u1'), 'ni l identifiant de la reservation')
})

test('SECURITE : un membre `avis: none` est refuse', async () => {
  preparer({ ...membre({ avis: 'none', property_scope: 'all' }), avis: [avisDe('a1')] })
  assert.equal((await enTantQueMembre({})).code, 403)
})

test('SECURITE : une EVALUATION d un autre bien n apparait pas chez un membre limite', async () => {
  preparer({ ...membre({ avis: 'read', reservations: 'read', property_scope: 'some', property_ids: [BIEN_A.id], property_refs: [REF_A] }),
    evaluations: [EVAL, { ...EVAL, id: 'e2', booking_uid: 'u-b', property_id: BIEN_B.id, property_id_ref: REF_B, ota_review_id: null }] })
  const r = await enTantQueMembre({ anciens: '1' })
  const toutes = [...r.body.cartes.attente, ...r.body.cartes.recents, ...r.body.cartes.anciens]
  assert.deepEqual(toutes.map(c => c.cle), ['sejour:u-masque'])
})
