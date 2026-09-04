// tests/menages-liaisons.test.js
// api/menages.js POST `liaisons` — qui intervient sur quel bien, et à quel rang.
//
// ⚠ CE QUE CET ENDPOINT DÉCIDE. Depuis le lot 3.3, ce n'est plus le rang qui
// tranche mais `requires_ack` — posé ICI à la création d'une liaison, faute de
// réglage dédié à l'écran (lot 3.5) — et la GARDE DU JOUR pour le rattrapage
// des ménages à venir. Se tromper de personne, c'est engager quelqu'un sans son
// accord — ou laisser un logement sans personne pour le préparer.
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

// ⚠ « ATTITRÉE TOUS LES JOURS », ÉCRIT EXPLICITEMENT. Depuis la restriction du
// 4 septembre 2026, une liaison qui doit confirmer et dont les `weekdays` ne sont
// PAS réglés n'est jamais sollicitée — pas de proposition, donc pas de SMS, tant
// que l'écran du lot 3.5 n'existe pas. Les fixtures qui veulent une proposition
// doivent donc déclarer leurs jours, comme le fera l'hôte.
const TOUS_LES_JOURS = [0, 1, 2, 3, 4, 5, 6]


function preparer ({ user = PROD, profil = null, permissions = null,
                     prestataire = { id: MARIE, first_name: 'Marie', active: true },
                     biens = [{ provider_property_id: '209413' }, { provider_property_id: '169567' }],
                     apres = [], erreurBiens = null,
                     profilsLien = [], tokens = [], erreurTokens = null,
                     aRattraper = [], rattrapables = [] } = {}) {
  const etat = { upserts: [], majs: [], requetes: [], journal: [], notifs: [] }
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
        gte () { return chain }, lte () { return chain }, or () { return chain },
        not (c, op, v) { a.not = { c, op, v }; return chain },
        order () { return chain },
        // Les disponibilités se lisent paginées : première page pleine, puis vide.
        range (from) { return Promise.resolve({ data: [], error: null }) },
        // ⚠ Le rattrapage LIT les ménages à reprendre avant de les écrire : un
        // double qui rendait toujours une liste vide ne testait plus rien.
        limit () {
          if (table === 'menages') return Promise.resolve({ data: aRattraper, error: null })
          return Promise.resolve({ data: [], error: null })
        },
        upsert (rows, opts) { etat.upserts.push({ table, rows, opts }); return Promise.resolve({ error: null }) },
        insert (rows) { etat.journal.push(...[].concat(rows)); return Promise.resolve({ error: null }) },
        update (row) {
          const q = { table, row, f: {}, not: null }
          const c2 = {
            eq (c, v) { q.f[c] = v; return c2 },
            in (c, v) { q.f[c + '_in'] = v; return c2 },
            is (c, v) { q.f[c + '_is'] = v; return c2 },
            gte (c, v) { q.f[c + '_gte'] = v; return c2 },
            not (c, op, v) { q.not = { c, op, v }; return c2 },
            // Le rattrapage immediat termine par `.select()` pour savoir ce
            // qu'il a touche : le double doit lui rendre des lignes.
            select () { etat.majs.push(q); return Promise.resolve({ data: rattrapables, error: null }) },
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
          // Le chemin GET : profils `lien` (annuaire) et jetons (rapprochement).
          if (table === 'profiles' && a.f.access_mode === 'lien') {
            return Promise.resolve({ data: profilsLien, error: null }).then(ok)
          }
          if (table === 'public_tokens') {
            return Promise.resolve({ data: erreurTokens ? null : tokens, error: erreurTokens }).then(ok)
          }
          if (table === 'bookings_snapshot' || table === 'menages') {
            return Promise.resolve({ data: [], error: null }).then(ok)
          }
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
  // ⚠ Le rattrapage NOTIFIE les propositions qu'il pose : sans ce double, un
  // test qui donnerait un téléphone à la fixture enverrait un vrai SMS.
  const absPresta = require.resolve(path.join(__dirname, '..', 'lib/cleaning/notifier-prestataire.js'))
  const mp = new Module(absPresta)
  mp.exports = {
    notifierProposition: async (o) => { etat.notifs.push(o); return { sms: true, email: false } },
    notifierAssignation: async (o) => { etat.notifs.push({ ...o, assignation: true }); return { sms: false, email: false } },
    jourLisible: d => String(d)
  }
  mp.loaded = true
  require.cache[absPresta] = mp
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

test('un bien qui garde quelqu\'un D\'OFFICE n\'est pas signalé', async () => {
  // ⚠ Le critère est `requires_ack`, plus le rang (§12.3) : un bien dont le
  // rang 1 doit confirmer n'a personne d'office, et l'ancien test le déclarait
  // pourtant couvert.
  const { handler } = preparer({ apres: [{ property_id: '209413', rang: 1, requires_ack: false }] })
  const res = reponse()
  await handler(post(CORPS), res)
  assert.deepStrictEqual(res.body.sans_referent, [])
})

test('un rang 1 qui DOIT CONFIRMER est signalé comme les autres', async () => {
  // Personne d'office sur ce bien : ses ménages y seront seulement proposés.
  const { handler } = preparer({ apres: [{ property_id: '209413', rang: 1, requires_ack: true, weekdays: TOUS_LES_JOURS }] })
  const res = reponse()
  await handler(post(CORPS), res)
  assert.deepStrictEqual(res.body.sans_referent, ['209413'])
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

// ─── Le rapprochement lien ↔ profil, et sa panne ───────────────────────────

test('la réponse porte `public_token_id`, jamais le jeton', async () => {
  // L'écran rapprochait les liens des profils par PRÉNOM : un accent, une casse,
  // un renommage ou un homonyme rompait le rapprochement. Le serveur le fait
  // maintenant par le jeton — mais le jeton lui-même ne doit pas sortir.
  const { handler } = preparer({
    profilsLien: [{ id: MARIE, first_name: 'Marie', active: true, pwa_token: 'jeton-secret' }],
    tokens: [{ id: 'pt-1', token: 'jeton-secret' }]
  })
  const res = reponse()
  await handler({ method: 'GET', query: {}, headers: { authorization: 'Bearer jeton' } }, res)
  assert.strictEqual(res.code, 200)
  const p = (res.body.prestataires || [])[0]
  assert.ok(p, 'un prestataire doit sortir')
  assert.strictEqual(p.public_token_id, 'pt-1')
  assert.ok(!JSON.stringify(res.body).includes('jeton-secret'), 'le jeton ne sort JAMAIS')
})

test('PANNE de rapprochement : la réponse le DIT', async () => {
  // ⚠ Ignorée, la panne dégradait vers le comportement dangereux : tous les
  // `public_token_id` à null, donc « lien seul » sur chaque carte, rangs non
  // modifiables, et « retirer » qui ne désactivait plus la personne — profil et
  // liaisons laissés actifs, des ménages attribués d'office à quelqu'un qui ne
  // les verra jamais.
  const { handler } = preparer({
    profilsLien: [{ id: MARIE, first_name: 'Marie', active: true, pwa_token: 'jeton-secret' }],
    erreurTokens: { message: 'timeout' }
  })
  const res = reponse()
  await handler({ method: 'GET', query: {}, headers: { authorization: 'Bearer jeton' } }, res)
  assert.strictEqual(res.body.rapprochement, 'indisponible')
})

test('sans panne, le rapprochement est annoncé sûr', async () => {
  const { handler } = preparer({
    profilsLien: [{ id: MARIE, first_name: 'Marie', active: true, pwa_token: 'jeton-secret' }],
    tokens: [{ id: 'pt-1', token: 'jeton-secret' }]
  })
  const res = reponse()
  await handler({ method: 'GET', query: {}, headers: { authorization: 'Bearer jeton' } }, res)
  assert.strictEqual(res.body.rapprochement, 'ok')
})

test('le rapprochement est cloisonné par compte', async () => {
  const { handler, etat } = preparer({
    profilsLien: [{ id: MARIE, first_name: 'Marie', active: true, pwa_token: 'jeton-secret' }],
    tokens: [{ id: 'pt-1', token: 'jeton-secret' }]
  })
  await handler({ method: 'GET', query: {}, headers: { authorization: 'Bearer jeton' } }, reponse())
  const q = etat.requetes.find(r => r.table === 'public_tokens')
  assert.ok(q, 'la lecture des jetons doit exister')
  assert.strictEqual(q.f.user_id, PROD)
})

// ─── Le rattrapage immédiat des ménages sans personne ──────────────────────
// ⚠ POURQUOI IL EXISTE. Le cron réévalue déjà les ménages `unassigned` à chaque
// cycle — mais jusqu'à cinq minutes plus tard, et rien à l'écran n'explique ce
// vide. Le premier test humain réel est tombé exactement dedans : une référente
// venait d'être posée, son planning était vide, et il fallait deviner qu'il
// suffisait d'attendre.

const MENAGE = (over = {}) => ({ id: 'm1', user_id: PROD, property_id: '209413',
                                 departure_date: '2099-09-05', ...over })

test('poser quelqu\'un D\'OFFICE rattrape les ménages À VENIR sans personne', async () => {
  const { handler, etat } = preparer({
    apres: [{ user_id: PROD, property_id: '209413', provider_id: MARIE, rang: 1, requires_ack: false }],
    aRattraper: [MENAGE(), MENAGE({ id: 'm2' })],
    rattrapables: [{ id: 'm1', user_id: PROD, departure_date: '2099-09-05' },
                   { id: 'm2', user_id: PROD, departure_date: '2099-09-05' }]
  })
  const res = reponse()
  await handler(post({ provider_id: MARIE, liaisons: [{ property_id: '209413', rang: 1 }] }), res)
  assert.strictEqual(res.body.rattrapes, 2)
  const maj = etat.majs.find(m => m.row && m.row.status === 'accepted')
  assert.ok(maj, 'les ménages doivent être assignés')
  assert.strictEqual(maj.row.provider_id, MARIE)
  assert.ok(maj.row.accepted_at, 'elle est engagée d\'office')
  assert.strictEqual(maj.row.assignment_mode, 'garde',
    'décidé par la garde du jour, jamais par le mode `priorite` d\'avant')
})

test('le rattrapage ne touche NI le passé, NI ce qui est déjà assigné', async () => {
  // ⚠ Réécrire le passé attribuerait à quelqu'un un travail qu'il n'a pas fait —
  // et l'attribution des remarques de propreté suit cette même assignation.
  // ⚠ Les mêmes conditions sont POSÉES DANS L'UPDATE : entre la lecture et
  // l'écriture, le cron a pu assigner ces ménages.
  const { handler, etat } = preparer({
    apres: [{ user_id: PROD, property_id: '209413', provider_id: MARIE, rang: 1, requires_ack: false }],
    aRattraper: [MENAGE()],
    rattrapables: [{ id: 'm1', user_id: PROD, departure_date: '2099-09-05' }]
  })
  await handler(post({ provider_id: MARIE, liaisons: [{ property_id: '209413', rang: 1 }] }), reponse())
  const lecture = etat.requetes.filter(r => r.table === 'menages').pop()
  assert.ok(lecture, 'les ménages à reprendre sont lus avant d\'être écrits')
  const maj = etat.majs.find(m => m.row && m.row.status === 'accepted')
  assert.strictEqual(maj.f.status, 'unassigned', 'seuls les ménages sans personne')
  assert.strictEqual(maj.f.provider_id_is, null, 'qui n\'ont vraiment personne')
  assert.strictEqual(maj.f.offered_to_is, null, 'et sur lesquels rien n\'est proposé')
})

test('un ménage REFUSÉ ou VERROUILLÉ n\'est pas rattrapé', async () => {
  // `orphaned` est un refus, `assigned_by='manual'` une décision de l'hôte. Ni
  // l'un ni l'autre ne se défait par un geste de configuration.
  // ⚠ `assigned_by` NULL doit PASSER : un ménage créé sans aucune liaison le
  // porte, et `.neq('assigned_by','manual')` l'aurait écarté — précisément le
  // cas que ce rattrapage existe pour traiter.
  const { handler, etat } = preparer({
    apres: [{ user_id: PROD, property_id: '209413', provider_id: MARIE, rang: 1, requires_ack: false }],
    aRattraper: [], rattrapables: []
  })
  await handler(post({ provider_id: MARIE, liaisons: [{ property_id: '209413', rang: 1 }] }), reponse())
  const source = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'api/menages.js'), 'utf8')
  assert.ok(source.includes("assigned_by.is.null,assigned_by.neq.manual"),
    'le filtre doit laisser passer `assigned_by` NULL et écarter les manuels')
  assert.ok(source.includes(".eq('status', 'unassigned')"),
    'et ne reprendre que les ménages sans personne — jamais un `orphaned`')
})

test('quelqu\'un qui DOIT CONFIRMER rattrape en « offered », pas en « accepted »', async () => {
  // ⚠ C'est `requires_ack`, pas le rang : un rang 1 qui doit confirmer reçoit
  // une proposition, et le ménage reste sans porteur en attendant sa réponse.
  const { handler, etat } = preparer({
    apres: [{ user_id: PROD, property_id: '209413', provider_id: MARIE, rang: 1, requires_ack: true, weekdays: TOUS_LES_JOURS }],
    // ⚠ Départ PROCHE : hors de la fenêtre de proposition, rien ne serait
    // proposé — une offre posée six mois à l'avance expirerait en 48 h.
    aRattraper: [MENAGE({ departure_date: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10) })],
    rattrapables: [{ id: 'm1', user_id: PROD, departure_date: '2026-09-05' }]
  })
  await handler(post({ provider_id: MARIE, liaisons: [{ property_id: '209413', rang: 1 }] }), reponse())
  const maj = etat.majs.find(m => m.row && (m.row.status === 'offered' || m.row.status === 'accepted'))
  assert.strictEqual(maj.row.status, 'offered')
  assert.strictEqual(maj.row.offered_to, MARIE)
  assert.ok(maj.row.offer_expires_at, 'une proposition sans échéance est refusée par la base')
  assert.strictEqual(maj.row.accepted_at, null)
})

test('la proposition posée par le rattrapage est NOTIFIÉE', async () => {
  // ⚠ Le cron ne repassera pas dessus — l'offre y est déjà posée — donc c'est
  // ici ou nulle part. Une proposition muette expire sans que la personne ait su
  // qu'on lui demandait quelque chose.
  const { handler, etat } = preparer({
    apres: [{ user_id: PROD, property_id: '209413', provider_id: MARIE, rang: 1, requires_ack: true, weekdays: TOUS_LES_JOURS }],
    aRattraper: [MENAGE({ departure_date: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10) })],
    rattrapables: [{ id: 'm1', user_id: PROD, departure_date: '2026-09-05' }]
  })
  await handler(post({ provider_id: MARIE, liaisons: [{ property_id: '209413', rang: 1 }] }), reponse())
  assert.strictEqual(etat.notifs.length, 1)
  assert.strictEqual(etat.notifs[0].providerId, MARIE)
  assert.ok(etat.notifs[0].expireLe, 'le délai de réponse est dans le message')
})

test('le SMS de proposition nomme LE BON bien', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW. Le groupe est indexé par (destination, échéance)
  // et PAS par bien : deux biens tombent dans le même groupe dès que la même
  // personne est retenue avec la même échéance — le cas nominal quand l'hôte lie
  // une prestataire à plusieurs biens d'un coup. Notifier avec le bien du premier
  // ménage du lot annonçait « Appartement A » pour un ménage de l'Appartement B.
  const proche = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10)
  const { handler, etat } = preparer({
    apres: [{ user_id: PROD, property_id: '209413', provider_id: MARIE, rang: 1, requires_ack: true, weekdays: TOUS_LES_JOURS },
            { user_id: PROD, property_id: '169567', provider_id: MARIE, rang: 1, requires_ack: true, weekdays: TOUS_LES_JOURS }],
    aRattraper: [MENAGE({ departure_date: proche }),
                 MENAGE({ id: 'm2', property_id: '169567', departure_date: proche })],
    rattrapables: [{ id: 'm1', user_id: PROD, property_id: '209413', departure_date: proche },
                   { id: 'm2', user_id: PROD, property_id: '169567', departure_date: proche }]
  })
  await handler(post({ provider_id: MARIE, liaisons: [
    { property_id: '209413', rang: 1 }, { property_id: '169567', rang: 1 }
  ] }), reponse())
  const biens = etat.notifs.map(n => n.propertyId).sort()
  assert.deepStrictEqual(biens, ['169567', '209413'],
    'chaque personne prévenue doit l\'être pour SON bien')
})

test('un départ LOINTAIN n\'est pas proposé : le cron le fera à son heure', async () => {
  // ⚠ Une proposition expire en 48 h : posée à six mois, elle serait morte avant
  // le séjour, et la responsable du jour n'aurait plus jamais l'occasion de
  // prendre ce ménage.
  const { handler, etat } = preparer({
    apres: [{ user_id: PROD, property_id: '209413', provider_id: MARIE, rang: 1, requires_ack: true, weekdays: TOUS_LES_JOURS }],
    aRattraper: [MENAGE({ departure_date: '2099-09-05' })],
    rattrapables: [{ id: 'm1', user_id: PROD, departure_date: '2099-09-05' }]
  })
  const res = reponse()
  await handler(post({ provider_id: MARIE, liaisons: [{ property_id: '209413', rang: 1 }] }), res)
  assert.strictEqual(res.body.rattrapes, 0, 'rien à écrire : ni porteuse, ni proposition due')
  assert.strictEqual(etat.journal.length, 0)
})

test('le rattrapage vise QUI EST DE GARDE, pas l\'appelant', async () => {
  // Si quelqu'un d'autre est assigné d'office sur ce bien, c'est lui qui prend
  // les ménages — même si c'est la fiche d'une suppléante qu'on enregistre.
  const { handler, etat } = preparer({
    apres: [{ user_id: PROD, property_id: '209413', provider_id: 'p-regina', rang: 1, requires_ack: false },
            { user_id: PROD, property_id: '209413', provider_id: MARIE, rang: 2, requires_ack: true, weekdays: TOUS_LES_JOURS }],
    aRattraper: [MENAGE()],
    rattrapables: [{ id: 'm1', user_id: PROD, departure_date: '2099-09-05' }]
  })
  await handler(post({ provider_id: MARIE, liaisons: [{ property_id: '209413', rang: 2 }] }), reponse())
  const maj = etat.majs.find(m => m.row && m.row.provider_id)
  assert.strictEqual(maj.row.provider_id, 'p-regina')
  assert.strictEqual(maj.row.status, 'accepted')
})

test('chaque ménage rattrapé laisse une trace au journal', async () => {
  const { handler, etat } = preparer({
    apres: [{ user_id: PROD, property_id: '209413', provider_id: MARIE, rang: 1, requires_ack: false }],
    aRattraper: [MENAGE(), MENAGE({ id: 'm2' })],
    rattrapables: [{ id: 'm1', user_id: PROD, departure_date: '2099-09-05' },
                   { id: 'm2', user_id: PROD, departure_date: '2099-09-05' }]
  })
  await handler(post({ provider_id: MARIE, liaisons: [{ property_id: '209413', rang: 1 }] }), reponse())
  const lignes = etat.journal.filter(l => l.event === 'assigned')
  assert.strictEqual(lignes.length, 2)
  assert.ok(lignes.every(l => l.actor === 'host'))
})

test('`requires_ack` est POSÉ à la création de la liaison', async () => {
  // ⚠ Il vaut `true` par défaut en base : sans cette écriture, une prestataire
  // que l'hôte vient de désigner comme référente ne portait plus rien d'office —
  // ses ménages lui étaient seulement PROPOSÉS, et restaient sans personne si
  // elle ne répondait pas.
  const { handler, etat } = preparer({})
  await handler(post({ provider_id: MARIE, liaisons: [
    { property_id: '209413', rang: 1 }, { property_id: '169567', rang: 2 }
  ] }), reponse())
  const up = etat.upserts.find(u => u.table === 'property_cleaning_providers')
  assert.strictEqual(up.rows.find(r => r.property_id === '209413').requires_ack, false)
  assert.strictEqual(up.rows.find(r => r.property_id === '169567').requires_ack, true)
})

test('PROMOUVOIR quelqu\'un en rang 1 la rend bien « d\'office »', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW. Conserver le `requires_ack` de toute liaison
  // existante rendait la promotion IMPOSSIBLE : échanger les rangs de deux
  // personnes ne changeait rien, la nouvelle rang 1 restait « à confirmer », et
  // aucun écran n'expose `requires_ack` pour corriger (lot 3.5).
  // Le rang envoyé est une INTENTION : quand il bouge, il retranche.
  const { handler, etat } = preparer({
    apres: [{ user_id: PROD, property_id: '209413', provider_id: MARIE, rang: 2, requires_ack: true, weekdays: TOUS_LES_JOURS }]
  })
  await handler(post({ provider_id: MARIE, liaisons: [{ property_id: '209413', rang: 1 }] }), reponse())
  const up = etat.upserts.find(u => u.table === 'property_cleaning_providers')
  assert.strictEqual(up.rows[0].requires_ack, false, 'promue : elle porte d\'office')
})

test('RÉTROGRADER quelqu\'un lui rend la confirmation', async () => {
  const { handler, etat } = preparer({
    apres: [{ user_id: PROD, property_id: '209413', provider_id: MARIE, rang: 1, requires_ack: false }]
  })
  await handler(post({ provider_id: MARIE, liaisons: [{ property_id: '209413', rang: 2 }] }), reponse())
  const up = etat.upserts.find(u => u.table === 'property_cleaning_providers')
  assert.strictEqual(up.rows[0].requires_ack, true)
})

test('une liaison EXISTANTE au MÊME rang garde son `requires_ack`', async () => {
  // ⚠ Une suppléante rodée passée d'office sans être promue rang 1 serait
  // écrasée à chaque enregistrement de la fiche, et personne ne comprendrait
  // pourquoi elle redemande confirmation.
  const { handler, etat } = preparer({
    apres: [{ user_id: PROD, property_id: '209413', provider_id: MARIE, rang: 2, requires_ack: false }]
  })
  await handler(post({ provider_id: MARIE, liaisons: [{ property_id: '209413', rang: 2 }] }), reponse())
  const up = etat.upserts.find(u => u.table === 'property_cleaning_providers')
  assert.strictEqual(up.rows[0].requires_ack, false,
    'rang inchangé : un réglage fin n\'est pas écrasé par un simple enregistrement')
})

test('retirer un bien ne rattrape rien', async () => {
  // Aucun `apres` sur ce bien : il n'y a personne à qui donner les ménages.
  const { handler, etat } = preparer({ apres: [], rattrapables: [{ id: 'm1', user_id: PROD }] })
  const res = reponse()
  await handler(post({ provider_id: MARIE, liaisons: [] }), res)
  assert.strictEqual(res.body.rattrapes, 0)
  assert.strictEqual(etat.journal.length, 0)
})
