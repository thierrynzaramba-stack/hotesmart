// tests/disponibilites-visibilite.test.js
// api/disponibilites.js — le RÉGLAGE « ce qu'elle voit des ménages des autres »,
// posé sur la fiche de la prestataire (spec visibilite, 2 octobre 2026).
//
// ⚠ CE QUI EST EN JEU. Ce réglage ouvre à une prestataire la vue sur le travail
// de ses collègues. Il ne se pose que par l'hôte — OU un membre délégué avec le
// droit `prestataires: write` (exigence de Thierry), jamais par quelqu'un qui n'a
// que la lecture. Et chaque prestataire désignée se VÉRIFIE (profil `lien` de CE
// compte) : un identifiant venu du client ne s'utilise pas (REVIEW.md règle 11).

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const COMPTE = 'aaaa1111-1111-4111-8111-111111111111'
const MEMBRE = 'dddd4444-4444-4444-8444-444444444444'
const MARIE = 'bbbb2222-2222-4222-8222-222222222222'
const LOLA = 'cccc3333-3333-4333-8333-333333333333'
const MARC = 'eeee5555-5555-4555-8555-555555555555'
const ETRANGERE = 'ffff6666-6666-4666-8666-666666666666'
const EMPLOYE = '99997777-7777-4777-8777-777777777777'

const PROFILS = [
  { id: MARIE, account_user_id: COMPTE, access_mode: 'lien', first_name: 'Marie', active: true },
  { id: LOLA, account_user_id: COMPTE, access_mode: 'lien', first_name: 'Lola', active: true },
  { id: MARC, account_user_id: COMPTE, access_mode: 'lien', first_name: 'Marc', active: false },
  { id: ETRANGERE, account_user_id: 'autre-compte', access_mode: 'lien', first_name: 'Autre', active: true },
  // Un membre AVEC compte n'est pas une prestataire : on ne voit pas « ses ménages ».
  { id: EMPLOYE, account_user_id: COMPTE, access_mode: 'compte', first_name: 'Paul', active: true },
  // Le titulaire a lui aussi un profil, dont `member_user_id` est son compte.
  { id: 'profil-titulaire', account_user_id: COMPTE, member_user_id: COMPTE, access_mode: 'compte',
    is_owner: true, active: true, first_name: 'Thierry', last_name: 'Nzaramba' },
  // Le délégué lui-même, membre du compte.
  { id: 'profil-membre', account_user_id: COMPTE, member_user_id: MEMBRE, access_mode: 'compte',
    active: true, accepted_at: '2026-09-01T00:00:00Z', first_name: 'Délégué', last_name: 'Ménage' }
]

function preparer ({ appelant = COMPTE, droitsMembre = 'write', visibilite = null, erreurs = {} } = {}) {
  const etat = { ecritures: [] }
  const tables = {
    profiles: PROFILS,
    profile_permissions: [{ profile_id: 'profil-membre', prestataires: droitsMembre, property_scope: 'all' }],
    menage_visibilite: visibilite ? [{ user_id: COMPTE, profile_id: MARIE, ...visibilite }] : []
  }
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: appelant } }, error: null }) },
    from (table) {
      const conds = []
      const filtrer = () => (tables[table] || []).filter(l => conds.every(c =>
        c.op === 'eq' ? String(l[c.col]) === String(c.val)
          : c.op === 'in' ? c.val.map(String).includes(String(l[c.col])) : true))
      const rep = () => erreurs[table] ? { data: null, error: erreurs[table] } : { data: filtrer(), error: null }
      const chain = {
        select () { return chain },
        eq (col, val) { conds.push({ op: 'eq', col, val }); return chain },
        in (col, val) { conds.push({ op: 'in', col, val }); return chain },
        gte () { return chain }, order () { return chain },
        limit () { return Promise.resolve(rep()) },
        maybeSingle () { const r = rep(); return Promise.resolve({ data: r.data ? r.data[0] || null : null, error: r.error }) },
        upsert (row, opts) {
          etat.ecritures.push({ table, op: 'upsert', row, opts })
          return { select: () => ({ maybeSingle: () => Promise.resolve({ data: { ...row }, error: null }) }) }
        },
        then (ok, ko) { return Promise.resolve(rep()).then(ok, ko) }
      }
      return chain
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of ['../lib/require-permission', '../lib/permissions', '../api/disponibilites']) {
    try { delete require.cache[require.resolve(mod)] } catch {}
  }
  return { handler: require('../api/disponibilites'), etat }
}

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  return r
}
const entetes = delegue => ({ authorization: 'Bearer jeton', ...(delegue ? { 'x-compte': COMPTE } : {}) })
const regler = (body, delegue = false) => ({ method: 'POST', query: {}, headers: entetes(delegue),
  body: { provider_id: MARIE, action: 'reglerVisibilite', ...body } })
const lire = (delegue = false) => ({ method: 'GET', query: { provider_id: MARIE }, headers: entetes(delegue) })
const upserts = etat => etat.ecritures.filter(e => e.table === 'menage_visibilite' && e.op === 'upsert')

test('l\'HÔTE règle la visibilité : une ligne pour CE compte et CETTE prestataire, signée', async () => {
  const { handler, etat } = preparer()
  const res = reponse()
  await handler(regler({ par_bien: true, profils_vus: [LOLA] }), res)
  assert.strictEqual(res.code, 200)
  const u = upserts(etat)
  assert.strictEqual(u.length, 1)
  assert.strictEqual(u[0].row.user_id, COMPTE)
  assert.strictEqual(u[0].row.profile_id, MARIE)
  assert.strictEqual(u[0].row.par_bien, true)
  assert.deepStrictEqual(u[0].row.profils_vus, [LOLA])
  assert.strictEqual(u[0].row.updated_by, COMPTE)
  assert.strictEqual(u[0].opts.onConflict, 'user_id,profile_id')
})

test('un DÉLÉGUÉ avec `prestataires: write` la règle comme l\'hôte', async () => {
  const { handler, etat } = preparer({ appelant: MEMBRE, droitsMembre: 'write' })
  const res = reponse()
  await handler(regler({ par_bien: false, profils_vus: [LOLA] }, true), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(upserts(etat)[0].row.user_id, COMPTE, 'écrit dans le compte qu\'il sert')
  assert.strictEqual(upserts(etat)[0].row.updated_by, MEMBRE, 'et la trace dit que c\'est lui')
})

test('un délégué en LECTURE seule ne la règle pas (403), et rien ne s\'écrit', async () => {
  const { handler, etat } = preparer({ appelant: MEMBRE, droitsMembre: 'read' })
  const res = reponse()
  await handler(regler({ par_bien: true, profils_vus: [] }, true), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(upserts(etat).length, 0)
})

test('une prestataire d\'un AUTRE compte, ou un membre à compte, ne se désigne pas (400)', async () => {
  for (const id of [ETRANGERE, EMPLOYE, 'pas-un-uuid']) {
    const { handler, etat } = preparer()
    const res = reponse()
    await handler(regler({ par_bien: false, profils_vus: [id] }), res)
    assert.strictEqual(res.code, 400, id)
    assert.strictEqual(upserts(etat).length, 0, id)
  }
})

test('elle-même, trop de monde, ou un réglage mal formé : 400, rien ne s\'écrit', async () => {
  const trop = Array.from({ length: 21 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`)
  for (const body of [{ par_bien: false, profils_vus: [MARIE] },
                      { par_bien: false, profils_vus: trop },
                      { par_bien: 'oui', profils_vus: [] },
                      { par_bien: true, profils_vus: LOLA },
                      { par_bien: true }]) {
    const { handler, etat } = preparer()
    const res = reponse()
    await handler(regler(body), res)
    assert.strictEqual(res.code, 400, JSON.stringify(body).slice(0, 60))
    assert.strictEqual(upserts(etat).length, 0)
  }
})

test('une prestataire DÉSACTIVÉE peut rester désignée (ses ménages ne sortent plus, côté lecture)', async () => {
  const { handler, etat } = preparer()
  const res = reponse()
  await handler(regler({ par_bien: false, profils_vus: [MARC] }), res)
  assert.strictEqual(res.code, 200)
  assert.deepStrictEqual(upserts(etat)[0].row.profils_vus, [MARC])
})

test('la fiche relit le réglage : rien par défaut, la ligne sinon', async () => {
  let r = reponse()
  await preparer().handler(lire(), r)
  assert.strictEqual(r.code, 200)
  assert.deepStrictEqual(r.body.visibilite, { par_bien: false, profils_vus: [], regle_le: null, regle_par: null })
  r = reponse()
  await preparer({ visibilite: { par_bien: true, profils_vus: [LOLA], updated_at: '2026-10-02T01:00:00Z' } }).handler(lire(), r)
  assert.deepStrictEqual(r.body.visibilite, { par_bien: true, profils_vus: [LOLA], regle_le: '2026-10-02T01:00:00Z',
                                              regle_par: null })
})

test('une PANNE de lecture du réglage coupe la fiche (503) — on ne montre pas un faux « rien »', async () => {
  const r = reponse()
  await preparer({ erreurs: { menage_visibilite: { message: 'timeout' } } }).handler(lire(), r)
  assert.strictEqual(r.code, 503)
})

test('« Réglé le … PAR [nom] » : le titulaire comme le délégué sont nommés', async () => {
  for (const [qui, attendu] of [[COMPTE, 'Thierry Nzaramba'], [MEMBRE, 'Délégué Ménage']]) {
    const r = reponse()
    await preparer({ visibilite: { par_bien: true, profils_vus: [], updated_at: '2026-10-02T01:00:00Z', updated_by: qui } })
      .handler(lire(), r)
    assert.strictEqual(r.body.visibilite.regle_par, attendu)
  }
})
