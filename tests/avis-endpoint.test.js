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
        gte (c, v) { q._gte = { colonne: c, valeur: v }; return chain },
        order () { return chain }, limit () { return chain },
        neq (c, v) { q._neq = q._neq || {}; q._neq[c] = v; return chain },
        // ⚠ `in` et `gte` sont honores : le ratio en depend, et sans eux
        // supprimer le filtre de perimetre ou de periode ne casserait rien.
        in (c, v) { q._in = { colonne: c, valeurs: (v || []).map(String) }; return chain },
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
          // ⚠ `user_id` EST honore. Une premiere version de ce double l'ignorait :
          // supprimer `.eq('user_id', userId)` de l'endpoint — la defense
          // principale, la service key contournant la RLS — laissait les quatre
          // tests de lecture au vert. REVIEW.md §8 : un double de table porte
          // TOUTES les cles de la vraie table.
          // ⚠ `statut` et `neq` sont honores comme le reste : sans eux, retirer
          // le filtre des compteurs sur 'confirme' — donc faire compter des
          // detections non validees — ne ferait echouer aucun test.
          let c = avis.filter(a =>
            (q._f.user_id == null || a.user_id === q._f.user_id) &&
            (q._f.property_id_ref == null || a.property_id_ref === q._f.property_id_ref) &&
            (q._f.ai_clean_verdict == null || a.ai_clean_verdict === q._f.ai_clean_verdict) &&
            (q._f.statut == null || (a.statut || 'confirme') === q._f.statut) &&
            (q._f.id == null || a.id === q._f.id) &&
            (!q._in || (q._in.valeurs.includes(String(a[q._in.colonne])))) &&
            (!q._gte || String(a[q._gte.colonne] || '') >= String(q._gte.valeur)) &&
            (!q._neq || !q._neq.statut || (a.statut || 'confirme') !== q._neq.statut))
          if (q._or) c = c.filter(a => String(q._or).includes(a.property_id_ref))
          if (q._count === 'exact') return Promise.resolve({ count: c.length, error: null })
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
        if (nom === 'profile_permissions') {
          // ⚠ LA TABLE EST MODELISEE, pas seulement la ligne attendue.
          //
          // Tolerer l'absence de filtre (`profile_id == null` -> on renvoie
          // quand meme) ne suffit PAS : retirer `.eq('profile_id', profil.id)`
          // du vrai code laissait encore tous les tests au vert. En base, une
          // requete sans ce filtre rend la PREMIERE ligne venue — celle d'un
          // autre profil. On modelise donc une ligne LEURRE, tres permissive :
          // sans filtre, c'est elle qui sort, et les tests de refus echouent.
          const LEURRE = { profile_id: 'profil-tiers', avis: 'write', property_scope: 'all' }
          const table = [LEURRE]
          if (permissions && profil) table.push({ ...permissions, profile_id: profil.id })
          const c = table.filter(r => q._f.profile_id == null || r.profile_id === q._f.profile_id)
          return Promise.resolve({ data: c, error: null })
        }
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

const AVIS_A = { id: 'r1', user_id: PROD, statut: 'confirme', ai_analyzed_at: '2026-08-30T01:00:00Z', property_id_ref: REF_A, ai_clean_verdict: 'positif', received_at: '2026-08-30T00:00:00Z' }
const AVIS_B = { id: 'r2', user_id: PROD, statut: 'confirme', ai_analyzed_at: '2026-08-20T01:00:00Z', property_id_ref: REF_B, ai_clean_verdict: 'remarque', received_at: '2026-08-20T00:00:00Z' }
// Avis d'un AUTRE compte : il ne doit jamais apparaitre, quel que soit le filtre.
const AVIS_TIERS = { id: 'r3', statut: 'confirme', ai_analyzed_at: '2026-08-25T01:00:00Z', user_id: '33333333-3333-4333-8333-333333333333',
                     property_id_ref: REF_A, ai_clean_verdict: 'remarque', received_at: '2026-08-25T00:00:00Z' }

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
    profil: { id: 'profil-1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
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
    profil: { id: 'profil-1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
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
    profil: { id: 'profil-1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
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
    profil: { id: 'profil-1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
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
    profil: { id: 'profil-1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
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
    profil: { id: 'profil-1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
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

// ─── Le cloisonnement par compte, réellement exercé ─────────────────────────
test('list : un avis d\'un AUTRE compte n\'apparaît jamais', async () => {
  // La service key contourne la RLS : `.eq('user_id', …)` est la seule défense.
  // Ce test échoue si on la retire — ce qui n'était pas le cas avant, le double
  // ignorant `user_id`.
  preparer({ avis: [AVIS_A, AVIS_B, AVIS_TIERS] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'list' }), res)
  assert.strictEqual(res.code, 200)
  assert.deepStrictEqual(res.body.avis.map(a => a.id).sort(), ['r1', 'r2'])
})

test('list : le ratio est cloisonné lui aussi', async () => {
  // Il compte les remarques : sans filtre de compte, il aurait inclus celle du
  // compte tiers et affiché un chiffre appartenant à quelqu'un d'autre.
  preparer({ avis: [AVIS_A, AVIS_B, AVIS_TIERS] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'list' }), res)
  assert.strictEqual(res.body.ratio.remarque, 1, 'seule la remarque du compte courant compte')
})

test('list : périmètre vide -> un ratio à zéro, pas un ratio absent', async () => {
  // La carte lirait `undefined` sinon. Et surtout : un périmètre vide doit
  // rendre ZÉRO, jamais les chiffres de tout le compte.
  preparer({
    user: MEMBRE, avis: [AVIS_A],
    profil: { id: 'profil-1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { avis: 'read', property_scope: 'some', property_ids: [], property_refs: [] }
  })
  const handler = require('../api/avis')
  const res = reponse()
  await handler({ ...req({ action: 'list' }), headers: { authorization: 'Bearer jeton', 'x-compte': PROD } }, res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.ratio.total, 0)
  assert.strictEqual(res.body.ratio.remarque, 0)
})

// ─── Saisie : les entrées malformées ne produisent pas de 500 ───────────────
test('create : une date au format valide mais impossible est refusée en 400', async () => {
  // '2026-13-45' passe le regex de forme ; new Date() rend Invalid Date et
  // .toISOString() lève un RangeError — 500 au lieu de 400, et l'appelant croit
  // à une panne serveur alors que c'est sa saisie.
  const etat = preparer({})
  const handler = require('../api/avis')
  for (const date of ['2026-13-45', '0000-00-00']) {
    const res = reponse()
    await handler(req({}, { action: 'create', bien: REF_A, texte: 'x', source: 'sms', date }, 'POST'), res)
    assert.strictEqual(res.code, 400, date)
  }
  assert.strictEqual(etat.ecritures.length, 0)
})

// ─── `sejours` expose des noms de voyageurs : il exige `write` ──────────────
test('sejours : un membre avis=read ne peut PAS lister les séjours', async () => {
  // Cette action renvoie le nom des voyageurs et leurs dates. En `read`, un
  // membre `avis: read` / `reservations: none` aurait obtenu la liste nominative
  // des occupants — une donnée que son profil lui refuse partout ailleurs. Un
  // domaine ne doit pas en ouvrir un autre.
  preparer({
    user: MEMBRE, snapshots: [{ user_id: PROD, property_id: REF_A, booking_id: 1, snapshot: { firstName: 'Jean' } }],
    profil: { id: 'profil-1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { avis: 'read', property_scope: 'all' }
  })
  const handler = require('../api/avis')
  const res = reponse()
  await handler({ ...req({ action: 'sejours', bien: REF_A }), headers: { authorization: 'Bearer jeton', 'x-compte': PROD } }, res)
  assert.strictEqual(res.code, 403)
})

test('sejours : un membre avis=write y a accès', async () => {
  // Contre-épreuve : la garde renforcée ne doit pas casser le formulaire.
  preparer({
    user: MEMBRE, snapshots: [{ user_id: PROD, property_id: REF_A, booking_id: 1, snapshot: { arrival: '2026-08-01' } }],
    profil: { id: 'profil-1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { avis: 'write', property_scope: 'all' }
  })
  const handler = require('../api/avis')
  const res = reponse()
  await handler({ ...req({ action: 'sejours', bien: REF_A }), headers: { authorization: 'Bearer jeton', 'x-compte': PROD } }, res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.sejours.length, 1)
})

// ─── Le domaine `avis` ne donne pas accès aux données de réservation ────────
test('list : ni le nom du voyageur ni ses dates de séjour ne sortent', async () => {
  // Fermer `sejours` et laisser la même donnée sortir par `list` ne ferme rien.
  // Le domaine `avis` donne accès au CONTENU des avis, pas à l'identité des
  // voyageurs ni à leurs séjours, qui relèvent de `reservations`.
  const CHAMPS_INTERDITS = ['guest_name', 'stay_start', 'stay_end', 'booking_uid',
                            'ota_reservation_id', 'content_private']
  const fs = require('node:fs')
  const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'api/avis.js'), 'utf8')
  const bloc = src.slice(src.indexOf('const CHAMPS = `'), src.indexOf('`', src.indexOf('const CHAMPS = `') + 16))
  for (const c of CHAMPS_INTERDITS) {
    assert.ok(!new RegExp('\\\\b' + c + '\\\\b').test(bloc),
      `${c} ne doit pas être renvoyé par la liste des avis`)
  }
})

test('list : chaque colonne renvoyée est bien affichée par la page', async () => {
  // La règle qui empêche la liste de regrossir : une colonne non rendue par
  // pages/avis.html n'a rien à y faire.
  const fs = require('node:fs'), pathm = require('node:path')
  const racine = pathm.join(__dirname, '..')
  const src = fs.readFileSync(pathm.join(racine, 'api/avis.js'), 'utf8')
  const page = fs.readFileSync(pathm.join(racine, 'pages/avis.html'), 'utf8')
  const debut = src.indexOf('const CHAMPS = `')
  const bloc = src.slice(debut + 16, src.indexOf('`', debut + 16))
  const colonnes = bloc.split(',').map(c => c.trim()).filter(Boolean)
  const exemptes = new Set(['id', 'property_id_ref'])  // clés techniques
  for (const c of colonnes) {
    if (exemptes.has(c)) continue
    assert.ok(page.includes(c), `${c} est renvoyée mais jamais affichée : exposition inutile`)
  }
})

test('create : une date qui n\'existe pas est refusée, pas reportée', async () => {
  // V8 REPORTE en silence : '2026-02-30' devient le 2 mars. Sans contrôle, une
  // date inexistante était acceptée et stockée décalée.
  const etat = preparer({})
  const handler = require('../api/avis')
  for (const date of ['2026-02-30', '2026-04-31']) {
    const res = reponse()
    await handler(req({}, { action: 'create', bien: REF_A, texte: 'x', source: 'sms', date }, 'POST'), res)
    assert.strictEqual(res.code, 400, date)
  }
  assert.strictEqual(etat.ecritures.length, 0)
})

test('create : une date réelle passe toujours', async () => {
  // Contre-épreuve : le contrôle ne doit pas refuser une date valide.
  const etat = preparer({})
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({}, { action: 'create', bien: REF_A, texte: 'x', source: 'sms', date: '2026-02-28' }, 'POST'), res)
  assert.strictEqual(res.code, 201)
  const ligne = etat.ecritures.find(e => e.table === 'ota_reviews' && e.row.provider === 'manuel').row
  assert.ok(ligne.received_at.startsWith('2026-02-28'))
})

// ─── Validation d'une détection ─────────────────────────────────────────────
const DETECTION = { id: '44444444-4444-4444-8444-444444444444', user_id: PROD,
                    statut: 'detecte', property_id_ref: REF_A,
                    ai_clean_verdict: 'remarque', received_at: '2026-08-29T00:00:00Z' }

function reqValider (id, statut, extra = {}) {
  return { method: 'POST', query: {}, body: { action: 'valider', id, statut },
           headers: { authorization: 'Bearer jeton', ...extra } }
}

test('valider : une détection passe en confirmé', async () => {
  const etat = preparer({ avis: [DETECTION] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqValider(DETECTION.id, 'confirme'), res)
  assert.strictEqual(res.code, 200)
  const maj = etat.ecritures.find(e => e.table === 'ota_reviews')
  assert.strictEqual(maj.row.statut, 'confirme')
})

test('valider : un membre avis=read ne peut PAS valider', async () => {
  // Confirmer une détection, c'est décider qu'un reproche remontera un jour à
  // la prestataire. C'est une écriture.
  const etat = preparer({
    user: MEMBRE, avis: [DETECTION],
    profil: { id: 'profil-1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { avis: 'read', property_scope: 'all' }
  })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqValider(DETECTION.id, 'confirme', { 'x-compte': PROD }), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('valider : une détection hors périmètre est refusée', async () => {
  // L'id vient du client : sans relecture, un membre validerait une détection
  // d'un bien qu'il n'a pas le droit de voir (REVIEW.md règle 11).
  const etat = preparer({
    user: MEMBRE, avis: [{ ...DETECTION, property_id_ref: REF_B }],
    profil: { id: 'profil-1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { avis: 'write', property_scope: 'some', property_ids: [BIEN_A.id], property_refs: [REF_A] }
  })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqValider(DETECTION.id, 'confirme', { 'x-compte': PROD }), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('valider : on ne revalide pas ce qui est déjà tranché', async () => {
  // Rouvrir une décision prise doit être un geste explicite, pas l'effet de bord
  // d'un double clic.
  const etat = preparer({ avis: [{ ...DETECTION, statut: 'confirme' }] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqValider(DETECTION.id, 'ignore'), res)
  assert.strictEqual(res.code, 409)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('valider : un statut inventé est refusé', async () => {
  const etat = preparer({ avis: [DETECTION] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqValider(DETECTION.id, 'supprime'), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('valider : un id qui n\'est pas un UUID est refusé sans requête', async () => {
  const etat = preparer({ avis: [DETECTION] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqValider('../../etc', 'confirme'), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.ecritures.length, 0)
})

// ─── Les compteurs ne comptent que les confirmés ────────────────────────────
test('list : une détection en attente ne compte pas dans les remarques', async () => {
  // La faire compter reviendrait à reprocher à la prestataire quelque chose que
  // l'hôte n'a pas validé.
  preparer({ avis: [DETECTION] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'list' }), res)
  assert.strictEqual(res.body.ratio.remarque, 0)
})

test('list : une détection en attente est bien VISIBLE dans la liste', async () => {
  // Elle ne compte pas, mais elle doit s'afficher : sinon l'hôte n'a aucun moyen
  // de la valider.
  preparer({ avis: [DETECTION] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'list' }), res)
  assert.strictEqual(res.body.avis.length, 1)
  assert.strictEqual(res.body.avis[0].statut, 'detecte')
})

test('list : une détection ignorée disparaît de la liste', async () => {
  preparer({ avis: [{ ...DETECTION, statut: 'ignore' }] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'list' }), res)
  assert.strictEqual(res.body.avis.length, 0)
})

// ─── Requalification d'un verdict ───────────────────────────────────────────
const AVIS_AUTO = { id: '55555555-5555-4555-8555-555555555555', user_id: PROD,
                    statut: 'confirme', property_id_ref: REF_A,
                    ai_clean_verdict: 'rien_signale', verdict_source: 'auto',
                    received_at: '2026-08-01T00:00:00Z' }

function reqRequalif (id, verdict, extra = {}) {
  return { method: 'POST', query: {}, body: { action: 'requalifier', id, verdict },
           headers: { authorization: 'Bearer jeton', ...extra } }
}

test('requalifier : le verdict change et devient HUMAIN', async () => {
  const etat = preparer({ avis: [AVIS_AUTO] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqRequalif(AVIS_AUTO.id, 'remarque'), res)
  assert.strictEqual(res.code, 200)
  const maj = etat.ecritures.find(e => e.table === 'ota_reviews')
  assert.strictEqual(maj.row.ai_clean_verdict, 'remarque')
  assert.strictEqual(maj.row.verdict_source, 'humain')
  assert.ok(maj.row.verdict_modifie_at, 'la date de correction est tracée')
})

test('requalifier : SEULES les colonnes de verdict sont écrites', async () => {
  // ⚠ LISTE BLANCHE, pas liste noire. La version précédente énumérait cinq
  // colonnes interdites : ajouter `content_private`, `reply` ou `statut: ignore`
  // à la charge utile passait au vert — or `statut: 'ignore'` fait littéralement
  // disparaître l'avis de la liste, c'est-à-dire l'effacement que ce lot
  // interdit. Une liste blanche ne se périme pas à l'ajout d'une colonne.
  const etat = preparer({ avis: [AVIS_AUTO] })
  const handler = require('../api/avis')
  await handler(reqRequalif(AVIS_AUTO.id, 'positif'), reponse())
  const maj = etat.ecritures.find(e => e.table === 'ota_reviews')
  assert.deepStrictEqual(Object.keys(maj.row).sort(), [
    'ai_analyzed_at', 'ai_clean_excerpt', 'ai_clean_verdict',
    'verdict_modifie_at', 'verdict_modifie_par', 'verdict_source'
  ], 'aucune autre colonne ne doit être touchée — surtout pas statut ni le contenu')
})

test('requalifier : l\'extrait du modèle est retiré, il ne colle plus au verdict', async () => {
  const etat = preparer({ avis: [AVIS_AUTO] })
  const handler = require('../api/avis')
  await handler(reqRequalif(AVIS_AUTO.id, 'rien_signale'), reponse())
  const maj = etat.ecritures.find(e => e.table === 'ota_reviews')
  assert.strictEqual(maj.row.ai_clean_excerpt, null)
})

test('requalifier : un membre avis=read ne peut pas corriger', async () => {
  const etat = preparer({
    user: MEMBRE, avis: [AVIS_AUTO],
    profil: { id: 'profil-1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { avis: 'read', property_scope: 'all' }
  })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqRequalif(AVIS_AUTO.id, 'positif', { 'x-compte': PROD }), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('requalifier : hors périmètre, refusé', async () => {
  const etat = preparer({
    user: MEMBRE, avis: [{ ...AVIS_AUTO, property_id_ref: REF_B }],
    profil: { id: 'profil-1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { avis: 'write', property_scope: 'some', property_ids: [BIEN_A.id], property_refs: [REF_A] }
  })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqRequalif(AVIS_AUTO.id, 'positif', { 'x-compte': PROD }), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('requalifier : un verdict inventé est refusé', async () => {
  // La colonne porte un CHECK : une valeur libre ferait échouer l'update.
  const etat = preparer({ avis: [AVIS_AUTO] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqRequalif(AVIS_AUTO.id, 'tres_sale'), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('requalifier : une DÉTECTION en attente ne se requalifie pas', async () => {
  // Elle se confirme ou s'ignore. Deux gestes pour la même décision se
  // contrediraient.
  const etat = preparer({ avis: [{ ...AVIS_AUTO, statut: 'detecte' }] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqRequalif(AVIS_AUTO.id, 'positif'), res)
  assert.strictEqual(res.code, 409)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('requalifier : un id qui n\'est pas un UUID est refusé sans requête', async () => {
  const etat = preparer({ avis: [AVIS_AUTO] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqRequalif('99', 'positif'), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.ecritures.length, 0)
})

// ─── Le cloisonnement par COMPTE de valider / requalifier ───────────────────
// ⚠ POURQUOI CES TESTS EXISTENT. Supprimer `.eq('user_id', userId)` de
// `requalifier` laissait 41 tests au vert. Or `refsDuPerimetre` renvoie `null`
// — donc AUCUNE vérification de périmètre — pour un titulaire et pour tout
// membre `property_scope: 'all'`. Sur ces profils, ce filtre est la SEULE
// défense, la service key contournant la RLS. Sans lui, n'importe quel compte
// avec `avis: write` requalifiait par simple UUID l'avis de n'importe quel hôte
// de la plateforme — et le gelait en `humain`.

const AVIS_TIERS_CONF = { id: '66666666-6666-4666-8666-666666666666',
                          user_id: '33333333-3333-4333-8333-333333333333',
                          statut: 'confirme', property_id_ref: REF_A,
                          ai_clean_verdict: 'positif', verdict_source: 'auto',
                          received_at: '2026-08-01T00:00:00Z' }

test('requalifier : l\'avis d\'un AUTRE compte est introuvable, jamais modifié', async () => {
  const etat = preparer({ avis: [AVIS_TIERS_CONF] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqRequalif(AVIS_TIERS_CONF.id, 'remarque'), res)
  assert.strictEqual(res.code, 404, 'la relecture doit être filtrée par user_id')
  assert.strictEqual(etat.ecritures.length, 0)
})

test('valider : la détection d\'un AUTRE compte est introuvable, jamais modifiée', async () => {
  // Même trou de couverture, antérieur à ce lot : `valider` ne l'avait pas non
  // plus.
  const etat = preparer({ avis: [{ ...AVIS_TIERS_CONF, statut: 'detecte' }] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqValider(AVIS_TIERS_CONF.id, 'confirme'), res)
  assert.strictEqual(res.code, 404)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('requalifier : une détection IGNORÉE ne se requalifie pas non plus', async () => {
  // Elle ne s'affiche plus : la requalifier modifierait le verdict d'une ligne
  // que personne ne voit, et la gèlerait en `humain`.
  const etat = preparer({ avis: [{ ...AVIS_AUTO, statut: 'ignore' }] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(reqRequalif(AVIS_AUTO.id, 'positif'), res)
  assert.strictEqual(res.code, 409)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('requalifier : ai_analyzed_at est posé si la réanalyse l\'avait effacé', async () => {
  // Sans ça, la ligne devenait MORTE : badge « Analyse en cours » à vie, plus de
  // sélecteur donc plus de correction possible, et la file ne la reprend jamais
  // puisqu'elle est `humain`.
  const etat = preparer({ avis: [{ ...AVIS_AUTO, ai_analyzed_at: null }] })
  const handler = require('../api/avis')
  await handler(reqRequalif(AVIS_AUTO.id, 'remarque'), reponse())
  const maj = etat.ecritures.find(e => e.table === 'ota_reviews')
  assert.ok(maj.row.ai_analyzed_at, 'un verdict humain EST une analyse')
})

test('list : un avis NON analysé n\'est ni positif ni remarque', async () => {
  // Il est compté à part. Le ranger d'office dans « rien signalé » ferait
  // croire que la question a été tranchée alors qu'on n'a pas encore regardé.
  preparer({ avis: [{ ...AVIS_A, ai_analyzed_at: null, ai_clean_verdict: null }] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'list' }), res)
  assert.strictEqual(res.body.ratio.total, 1)
  assert.strictEqual(res.body.ratio.non_analyses, 1)
  assert.strictEqual(res.body.ratio.positif, 0)
  assert.strictEqual(res.body.ratio.remarque, 0)
})

test('list : la période demandée est honorée', async () => {
  // Un avis hors fenêtre ne doit pas entrer dans le ratio.
  const vieux = { ...AVIS_A, id: 'r9', received_at: '2024-01-01T00:00:00Z',
                  ai_analyzed_at: '2024-01-01T01:00:00Z', ai_clean_verdict: 'positif' }
  preparer({ avis: [vieux] })
  const handler = require('../api/avis')
  const r30 = reponse(); await handler(req({ action: 'list', periode: '30j' }), r30)
  assert.strictEqual(r30.body.ratio.total, 0, 'hors des 30 jours')
  const rTout = reponse(); await handler(req({ action: 'list', periode: 'toujours' }), rTout)
  assert.strictEqual(rTout.body.ratio.total, 1, 'mais présent depuis toujours')
  assert.strictEqual(rTout.body.ratio.positif, 1)
})

test('list : une période inventée retombe sur le défaut, sans erreur', async () => {
  preparer({ avis: [AVIS_A] })
  const handler = require('../api/avis')
  const res = reponse()
  await handler(req({ action: 'list', periode: 'depuis-toujours-ou-presque' }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.ratio.periode, '30j')
})
