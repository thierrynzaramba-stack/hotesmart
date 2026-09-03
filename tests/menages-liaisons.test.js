// tests/menages-liaisons.test.js
// api/menages.js POST `liaisons` — qui intervient sur quel bien, et à quel rang.
//
// ⚠ CE QUE CET ENDPOINT DÉCIDE. Le rang ne décore pas : le rang 1 est assigné
// D'OFFICE (le ménage naît `accepted`), le rang 2+ reçoit une offre à confirmer.
// Se tromper de personne, c'est engager quelqu'un sans son accord — ou laisser
// un logement sans personne pour le préparer.
//
// Trois données viennent du client — le prestataire, les biens, les rangs — et
// aucune ne dit à quel compte elle appartient (REVIEW.md règle 11).

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const PROD = '11111111-1111-4111-8111-111111111111'
const MEMBRE = '22222222-2222-4222-8222-222222222222'
const MARIE = 'bbbb2222-2222-4222-8222-222222222222'

function preparer ({ user = PROD, profil = null, permissions = null,
                     prestataire = { id: MARIE, first_name: 'Marie', active: true },
                     biens = [{ provider_property_id: '209413' }, { provider_property_id: '169567' }],
                     apres = [], erreurBiens = null } = {}) {
  const etat = { upserts: [], majs: [], requetes: [] }
  const client = {
    auth: { getUser: async () => (user ? { data: { user: { id: user } }, error: null }
                                       : { data: null, error: { message: 'x' } }) },
    from (table) {
      const a = { table, f: {}, not: null }
      etat.requetes.push(a)
      const chain = {
        select () { return chain },
        eq (c, v) { a.f[c] = v; return chain },
        neq () { return chain }, in () { return chain }, is () { return chain },
        gte () { return chain }, lte () { return chain },
        not (c, op, v) { a.not = { c, op, v }; return chain },
        order () { return chain }, limit () { return Promise.resolve({ data: [], error: null }) },
        upsert (rows, opts) { etat.upserts.push({ table, rows, opts }); return Promise.resolve({ error: null }) },
        update (row) {
          const q = { table, row, f: {}, not: null }
          const c2 = {
            eq (c, v) { q.f[c] = v; return c2 },
            in (c, v) { q.f[c + '_in'] = v; return c2 },
            not (c, op, v) { q.not = { c, op, v }; return c2 },
            then (ok) { etat.majs.push(q); return Promise.resolve({ error: null }).then(ok) }
          }
          return c2
        },
        maybeSingle () {
          if (table === 'profiles') return Promise.resolve({ data: a.f.id ? prestataire : profil, error: null })
          if (table === 'profile_permissions') return Promise.resolve({ data: permissions, error: null })
          return Promise.resolve({ data: null, error: null })
        },
        then (ok) {
          // ⚠ LES FILTRES SONT HONORES. Sans cela, retirer `.eq('user_id')` de la
          // lecture des biens — la garde qui empeche de lier le bien d'un AUTRE
          // COMPTE — laissait les 15 tests au vert (REVIEW.md regles 1 et 8).
          if (table === 'properties') {
            if (erreurBiens) return Promise.resolve({ data: null, error: erreurBiens }).then(ok)
            const d = a.f.user_id === undefined || a.f.user_id === PROD ? biens : []
            return Promise.resolve({ data: d, error: a.f.user_id === undefined ? null : null }).then(ok)
          }
          if (table === 'property_cleaning_providers') {
            const d = a.f.user_id === undefined || a.f.user_id === PROD ? apres : []
            return Promise.resolve({ data: d, error: null }).then(ok)
          }
          return Promise.resolve({ data: [], error: null }).then(ok)
        }
      }
      return chain
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of ['../lib/require-permission', '../lib/permissions', '../api/menages']) {
    try { delete require.cache[require.resolve(mod)] } catch {}
  }
  return { handler: require('../api/menages'), etat }
}

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  return r
}
const post = (body, entetes = {}) => ({
  method: 'POST', query: {}, body: { action: 'liaisons', ...body },
  headers: { authorization: 'Bearer jeton', ...entetes }
})
const CORPS = { provider_id: MARIE, liaisons: [{ property_id: '209413', rang: 2 }] }

// ─── Les droits ────────────────────────────────────────────────────────────

test('sans session : 401', async () => {
  const { handler } = preparer({ user: null })
  const res = reponse()
  await handler(post(CORPS), res)
  assert.strictEqual(res.code, 401)
})

test('un membre `prestataires: none` ne peut pas régler les rangs', async () => {
  // Décider qui fait les ménages relève de `prestataires`, pas de `menages`.
  const { handler, etat } = preparer({
    user: MEMBRE,
    profil: { id: 'pr1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { prestataires: 'read', menages: 'write', property_scope: 'all' }
  })
  const res = reponse()
  await handler(post(CORPS, { 'x-compte': PROD }), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.upserts.length, 0)
})

// ─── Les trois données du client ───────────────────────────────────────────

test('le prestataire est vérifié SUR LE COMPTE et sur son mode d\'accès', async () => {
  // ⚠ Sans cela, on rattacherait le bien d'un hôte au prestataire d'un autre —
  // et les ménages, puis les remarques de propreté, suivraient.
  const { handler, etat } = preparer({})
  await handler(post(CORPS), reponse())
  const q = etat.requetes.find(r => r.table === 'profiles' && r.f.id)
  assert.strictEqual(q.f.account_user_id, PROD)
  assert.strictEqual(q.f.access_mode, 'lien')
})

test('un prestataire inconnu du compte est refusé', async () => {
  const { handler, etat } = preparer({ prestataire: null })
  const res = reponse()
  await handler(post(CORPS), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.upserts.length, 0)
})

test('un bien qui n\'est pas du compte est refusé', async () => {
  // La référence vient du corps de la requête : elle ne désigne rien tant
  // qu'elle n'a pas été confrontée aux biens du compte.
  const { handler, etat } = preparer({ biens: [{ provider_property_id: '169567' }] })
  const res = reponse()
  await handler(post(CORPS), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.upserts.length, 0)
})

test('un bien hors du PÉRIMÈTRE du membre est refusé', async () => {
  const { handler, etat } = preparer({
    user: MEMBRE,
    profil: { id: 'pr1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { prestataires: 'write', property_scope: 'selected',
                   property_ids: ['uuid-a'], property_refs: ['169567'] }
  })
  const res = reponse()
  await handler(post(CORPS, { 'x-compte': PROD }), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.upserts.length, 0)
})

test('un rang hors des bornes est refusé', async () => {
  // Un rang 0 ou négatif casserait le tri du moteur ; un rang absurde laisserait
  // croire à une hiérarchie qui n'existe pas.
  for (const rang of [0, -1, 1.5, 99, 'premier', null]) {
    const { handler, etat } = preparer({})
    const res = reponse()
    await handler(post({ provider_id: MARIE, liaisons: [{ property_id: '209413', rang }] }), res)
    assert.strictEqual(res.code, 400, String(rang))
    assert.strictEqual(etat.upserts.length, 0)
  }
})

// ─── Ce qui est écrit ──────────────────────────────────────────────────────

test('les liaisons voulues sont posées avec leur rang', async () => {
  const { handler, etat } = preparer({})
  await handler(post({ provider_id: MARIE, liaisons: [
    { property_id: '209413', rang: 1 }, { property_id: '169567', rang: 2 }
  ] }), reponse())
  const rows = etat.upserts[0].rows
  assert.deepStrictEqual(rows.map(r => [r.property_id, r.rang]), [['209413', 1], ['169567', 2]])
  assert.ok(rows.every(r => r.user_id === PROD && r.provider_id === MARIE && r.active === true))
})

test('les biens retirés sont DÉSACTIVÉS, pas supprimés', async () => {
  // ⚠ Une liaison supprimée emporterait la trace de qui intervenait sur ce bien,
  // alors que les ménages passés la référencent et que l'historique de qualité
  // s'appuie dessus.
  const { handler, etat } = preparer({})
  await handler(post(CORPS), reponse())
  const maj = etat.majs.find(m => m.table === 'property_cleaning_providers')
  assert.ok(maj, 'une désactivation doit avoir lieu')
  assert.strictEqual(maj.row.active, false)
  assert.strictEqual(maj.f.user_id, PROD)
  assert.strictEqual(maj.f.provider_id, MARIE)
  assert.ok(maj.not && maj.not.c === 'property_id', 'sauf les biens gardés')
})

test('aucun bien voulu : tout est désactivé, sans upsert', async () => {
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post({ provider_id: MARIE, liaisons: [] }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(etat.upserts.length, 0)
  const maj = etat.majs.find(m => m.table === 'property_cleaning_providers')
  assert.ok(maj && !maj.not, 'aucune exclusion : tout part')
})

// ─── L'avertissement, qui ne bloque pas ────────────────────────────────────

test('un bien sans référente est SIGNALÉ, et l\'écriture passe quand même', async () => {
  // ⚠ Avertir, pas bloquer : le refuser laisserait l'hôte sans issue le jour où
  // une prestataire s'en va.
  const { handler } = preparer({ apres: [{ property_id: '209413', rang: 2 }] })
  const res = reponse()
  await handler(post(CORPS), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.success, true)
  assert.deepStrictEqual(res.body.sans_referent, ['209413'])
})

test('un bien qui garde une référente n\'est pas signalé', async () => {
  const { handler } = preparer({ apres: [{ property_id: '209413', rang: 1 }] })
  const res = reponse()
  await handler(post(CORPS), res)
  assert.deepStrictEqual(res.body.sans_referent, [])
})

test('un bien SANS aucune liaison n\'est pas signalé non plus', async () => {
  // Il n'est pas géré par l'app ménage : le signaler serait du bruit permanent,
  // comme pour l'alerte du writer.
  const { handler } = preparer({ apres: [] })
  const res = reponse()
  await handler(post(CORPS), res)
  assert.deepStrictEqual(res.body.sans_referent, [])
})

// ─── Les entrées mal formées ───────────────────────────────────────────────

test('prestataire ou liaisons manquants : 400', async () => {
  for (const corps of [{}, { provider_id: MARIE }, { liaisons: [] }, { provider_id: MARIE, liaisons: 'tout' }]) {
    const { handler, etat } = preparer({})
    const res = reponse()
    await handler(post(corps), res)
    assert.strictEqual(res.code, 400, JSON.stringify(corps))
    assert.strictEqual(etat.upserts.length, 0)
  }
})

test('PANNE de lecture des biens : 503, aucune écriture', async () => {
  const { handler, etat } = preparer({ erreurBiens: { message: 'timeout' } })
  const res = reponse()
  await handler(post(CORPS), res)
  assert.strictEqual(res.code, 503)
  assert.strictEqual(etat.upserts.length, 0)
})

// ─── Les gardes de cloisonnement, et le périmètre en RETRAIT ───────────────

test('les biens du compte sont lus AVEC le filtre de compte', async () => {
  // ⚠ C'est la garde qui empêche de lier le bien d'un autre compte : sans elle,
  // `duCompte` contiendrait les références de toute la plateforme.
  const { handler, etat } = preparer({})
  await handler(post(CORPS), reponse())
  const q = etat.requetes.find(r => r.table === 'properties')
  assert.strictEqual(q.f.user_id, PROD)
})

test('la relecture des liaisons est filtrée par compte elle aussi', async () => {
  const { handler, etat } = preparer({})
  await handler(post(CORPS), reponse())
  const lectures = etat.requetes.filter(r => r.table === 'property_cleaning_providers')
  assert.ok(lectures.length, 'une relecture doit avoir lieu')
  assert.ok(lectures.every(q => q.f.user_id === undefined || q.f.user_id === PROD))
})

test('la désactivation NE SORT PAS du périmètre de l\'appelant', async () => {
  // ⚠ LA FAILLE QUE CE TEST FERME. Les biens ajoutés étaient confrontés au
  // périmètre, les biens RETIRÉS ne l'étaient pas : tout ce qui n'était pas dans
  // la liste envoyée était désactivé, hors périmètre compris. Un gestionnaire
  // limité au bien A retirait la référente des biens B et C — dont les prochains
  // ménages naissaient non assignés, et sans alerte.
  const { handler, etat } = preparer({
    user: MEMBRE,
    profil: { id: 'pr1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { prestataires: 'write', property_scope: 'selected',
                   property_ids: ['uuid-a'], property_refs: ['209413'] }
  })
  const res = reponse()
  await handler(post(CORPS, { 'x-compte': PROD }), res)
  assert.strictEqual(res.code, 200)
  const maj = etat.majs.find(m => m.table === 'property_cleaning_providers')
  assert.ok(maj, 'une désactivation a lieu')
  // ⚠ `refsDuPerimetre` rend l'UNION des UUID et des références (`property_ids`
  // + `property_refs`) : c'est son contrat, et le filtre le reprend tel quel.
  // L'UUID ne correspond à aucune ligne de `property_cleaning_providers`, dont
  // le `property_id` est du TEXT provider — il est inerte. Ce qui compte, c'est
  // que la référence du bien HORS périmètre (169567) ne soit pas là.
  assert.ok(maj.f.property_id_in, 'la désactivation doit être bornée')
  assert.ok(maj.f.property_id_in.includes('209413'))
  assert.ok(!maj.f.property_id_in.includes('169567'),
    'le bien hors périmètre ne doit pas pouvoir être désactivé')
})

test('le titulaire, lui, n\'est pas borné', async () => {
  // Contre-épreuve : sans périmètre, la désactivation doit couvrir tout le compte.
  const { handler, etat } = preparer({})
  await handler(post(CORPS), reponse())
  const maj = etat.majs.find(m => m.table === 'property_cleaning_providers')
  assert.strictEqual(maj.f.property_id_in, undefined)
})

test('un bien EN DOUBLE est refusé avant toute écriture', async () => {
  // ⚠ Deux lignes de même clé de conflit dans un seul upsert : Postgres refuse
  // (42P10), et l'endpoint rendait 500 APRÈS avoir désactivé les liaisons — la
  // prestataire perdait ses biens sans en récupérer aucun.
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post({ provider_id: MARIE, liaisons: [
    { property_id: '209413', rang: 1 }, { property_id: '209413', rang: 2 }
  ] }), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.majs.length, 0, 'rien ne doit être désactivé')
  assert.strictEqual(etat.upserts.length, 0)
})

test('une référence de bien mal formée est refusée', async () => {
  // Elle finit interpolée dans un filtre PostgREST.
  for (const ref of ['209413","169567', 'a b', 'x)', '', 'é'.repeat(2)]) {
    const { handler, etat } = preparer({})
    const res = reponse()
    await handler(post({ provider_id: MARIE, liaisons: [{ property_id: ref, rang: 2 }] }), res)
    assert.strictEqual(res.code, 400, JSON.stringify(ref))
    assert.strictEqual(etat.upserts.length, 0)
  }
})

test('l\'avertissement reste DANS le périmètre', async () => {
  const { handler } = preparer({
    user: MEMBRE,
    profil: { id: 'pr1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { prestataires: 'write', property_scope: 'selected',
                   property_ids: ['uuid-a'], property_refs: ['209413'] },
    apres: [{ property_id: '209413', rang: 2 }, { property_id: '169567', rang: 2 }]
  })
  const res = reponse()
  await handler(post(CORPS, { 'x-compte': PROD }), res)
  assert.deepStrictEqual(res.body.sans_referent, ['209413'],
    'le bien hors périmètre ne doit pas apparaître dans la réponse')
})
