// tests/endpoints-groupe4.test.js
// Groupe FINAL de l'etape 3 : les 7 derniers endpoints.
//
//   grok                 wrapper IA — n'avait AUCUNE authentification
//   serrures             codes d'acces Seam — repli sur la cle PLATEFORME
//   stripe               facturation, domaine non delegable
//   property-automation  kill switch par bien
//   simulate             simulation de message voyageur
//   extract-kb           base de connaissances
//   menages              planning menage de l'hote (collection)

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'cle-test'
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_x'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const PROD = 'compte-prod', AUTRE = 'compte-autre', MEMBRE = 'membre'

const BIEN_A = { id: '58001ed1-e194-498a-94b4-606eece8f33d', user_id: PROD, name: 'La bulle',
                 provider: 'beds24', provider_property_id: '209413', automation_paused: false }
const BIEN_TIERS = { id: '9f3c0000-3333-4444-9999-bbbbbbbbbbbb', user_id: AUTRE, name: 'Chez un autre',
                     provider: 'beds24', provider_property_id: '999999', automation_paused: false }
const BIENS = [BIEN_A, BIEN_TIERS]

const MODULES = ['../lib/require-permission', '../lib/permissions', '../lib/providers/seam',
                 '../api/grok', '../api/serrures', '../api/property-automation',
                 '../api/simulate', '../api/extract-kb', '../api/menages']

// `cleSeam` : ligne api_keys du compte PROD (null = compte sans cle configuree).
function preparer ({ user = MEMBRE, profil = null, permissions = null,
                     cleSeam = { seam_api_key: 'cle-du-compte', seam_enabled: true },
                     fetchStub = null } = {}) {
  const etat = { ecritures: [], appels: [], filtresOr: [] }

  const client = {
    auth: { getUser: async () => (user ? { data: { user: { id: user, email: user + '@exemple.fr' } }, error: null }
                                       : { data: null, error: { message: 'x' } }) },
    from (nom) {
      const q = {
        _f: {}, _in: null, _or: null,
        select () { return q },
        eq (c, v) { q._f[c] = v; return q },
        or (e) { q._or = e; etat.filtresOr.push({ table: nom, expression: e }); return q },
        in (c, v) { q._in = { c, v }; return q },
        neq () { return q }, not () { return q }, is () { return q },
        order () { return q }, limit () { return q }, gte () { return q }, lte () { return q },
        insert (r) { etat.ecritures.push({ table: nom, row: r }); return { select: () => ({ single: async () => ({ data: { id: 'x' }, error: null }) }) } },
        upsert (r) { etat.ecritures.push({ table: nom, row: r }); return Promise.resolve({ error: null }) },
        update (r) { etat.ecritures.push({ table: nom, row: r }); return q },
        delete () { etat.ecritures.push({ table: nom, row: 'DELETE' }); return q },
        single: async () => rep(nom, q), maybeSingle: async () => rep(nom, q),
        then (ok, ko) { return Promise.resolve(rep(nom, q, true)).then(ok, ko) }
      }
      function rep (nom, q, tableau = false) {
        if (nom === 'properties') {
          if (q._or && /^id\.eq\./.test(q._or)) {
            const m = String(q._or).match(/^id\.eq\.([^,]+),provider_property_id\.eq\.(.+)$/)
            assert.ok(m, 'filtre .or() inattendu : ' + q._or)
            assert.match(m[1], /^[0-9a-f]{8}-/i, 'un identifiant non-UUID ne doit JAMAIS atteindre id.eq')
            const b = BIENS.find(x => x.id === m[1] || x.provider_property_id === m[2]) || null
            return { data: b, error: null }
          }
          if (q._f.id != null) assert.match(String(q._f.id), /^[0-9a-f]{8}-/i, '.eq(id) recoit un non-UUID')
          const cands = BIENS.filter(b =>
            (q._f.id == null || b.id === q._f.id) &&
            (q._f.provider_property_id == null || b.provider_property_id === q._f.provider_property_id) &&
            (q._f.user_id == null || b.user_id === q._f.user_id))
          return { data: tableau ? cands : (cands[0] || null), error: null }
        }
        if (nom === 'profiles') {
          const ok = profil && profil.account_user_id === q._f.account_user_id &&
                              profil.member_user_id === q._f.member_user_id
          return { data: ok ? profil : null, error: null }
        }
        if (nom === 'profile_permissions') return { data: permissions, error: null }
        if (nom === 'api_keys') {
          return { data: q._f.user_id === PROD ? { api_key: 'beds24', ...(cleSeam || {}) } : null, error: null }
        }
        if (nom === 'accounts') return { data: null, error: null }
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
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }
  }
  return etat
}

// Double ou un provider_property_id est porte par DEUX comptes.
function preparerAmbigu () {
  const doublons = [BIEN_A, { ...BIEN_TIERS, provider_property_id: BIEN_A.provider_property_id }]
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: PROD } }, error: null }) },
    from () {
      const q = {
        select () { return q }, eq () { return q }, or () { return q }, in () { return q },
        order () { return q }, limit () { return q },
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        then (ok, ko) { return Promise.resolve({ data: doublons, error: null }).then(ok, ko) }
      }
      return q
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
}

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = () => {}
  r.end = () => r
  return r
}
const profilActif = (o = {}) => ({ id: 'p1', account_user_id: PROD, member_user_id: MEMBRE,
                                   active: true, accepted_at: '2026-09-01', ...o })
const perms = (o = {}) => ({ profile_id: 'p1', property_scope: 'all', property_ids: [], property_refs: [],
                             reservations: 'none', menages: 'none', prestataires: 'none', messages: 'none',
                             avis: 'none', reglages: 'none', facturation: 'none', equipe: 'none', ...o })
const req = (o = {}) => ({ method: 'GET', headers: { authorization: 'Bearer tok' }, query: {}, body: {}, ...o })

// ─── grok : le relais IA etait grand ouvert ─────────────────────────────────

test('grok : SANS jeton -> 401, aucun appel a Claude', async () => {
  // ⚠ L'endpoint n'avait AUCUNE authentification : n'importe qui sur Internet
  // pouvait consommer la cle Claude de la plateforme.
  const etat = preparer({ user: null })
  const res = reponse()
  await require('../api/grok')({ method: 'POST', headers: {}, body: {
    messages: [{ role: 'user', content: 'salut' }] } }, res)
  assert.strictEqual(res.code, 401)
  assert.deepStrictEqual(etat.appels, [])
})

test('grok : jeton invalide -> 401', async () => {
  preparer({ user: null })
  const res = reponse()
  await require('../api/grok')(req({ method: 'POST', body: { messages: [{ role: 'user', content: 'x' }] } }), res)
  assert.strictEqual(res.code, 401)
})

test('grok : requete demesuree -> 400 (le cout par appel est borne)', async () => {
  preparer({ user: PROD })
  const res = reponse()
  await require('../api/grok')(req({ method: 'POST', body: {
    messages: [{ role: 'user', content: 'x'.repeat(250000) }] } }), res)
  assert.strictEqual(res.code, 400)
})

test('grok : messages absents -> 400', async () => {
  preparer({ user: PROD })
  const res = reponse()
  await require('../api/grok')(req({ method: 'POST', body: {} }), res)
  assert.strictEqual(res.code, 400)
})

// ─── serrures : le repli sur la cle plateforme ──────────────────────────────

test('seam : un compte SANS cle propre n\'emprunte PAS la cle plateforme', async () => {
  // ⚠ LA FUITE : `data?.seam_api_key || process.env.SEAM_API_KEY` faisait
  // partager un meme compte Seam a tous les hotes sans cle — devices/list leur
  // listait les serrures des uns et des autres, et access_codes/delete acceptait
  // n'importe quel code_id.
  process.env.SEAM_API_KEY = 'cle-plateforme'
  try {
    preparer({ user: PROD, cleSeam: { seam_api_key: null, seam_enabled: true } })
    const { getSeamKey } = require('../lib/providers/seam')
    assert.strictEqual(await getSeamKey(PROD), null)
  } finally { delete process.env.SEAM_API_KEY }
})

test('seam : la cle du compte est bien rendue quand elle existe', async () => {
  preparer({ user: PROD })
  const { getSeamKey } = require('../lib/providers/seam')
  assert.strictEqual(await getSeamKey(PROD), 'cle-du-compte')
})

test('seam : seam_enabled=false -> aucune cle', async () => {
  preparer({ user: PROD, cleSeam: { seam_api_key: 'cle-du-compte', seam_enabled: false } })
  const { getSeamKey } = require('../lib/providers/seam')
  assert.strictEqual(await getSeamKey(PROD), null)
})

test('serrures : compte sans cle -> 400, aucun appel a Seam', async () => {
  process.env.SEAM_API_KEY = 'cle-plateforme'
  try {
    const etat = preparer({ user: PROD, cleSeam: { seam_api_key: null, seam_enabled: true } })
    const res = reponse()
    await require('../api/serrures')(req({ query: { action: 'locks' } }), res)
    assert.strictEqual(res.code, 400)
    assert.deepStrictEqual(etat.appels.filter(a => a.url.includes('getseam')), [])
  } finally { delete process.env.SEAM_API_KEY }
})

test('serrures : un membre n\'atteint PAS les serrures du compte auquel il appartient', async () => {
  // ⚠ CE QUE CE TEST CONSTATE, et qui n'est pas un oubli : l'endpoint ne porte
  // aucun identifiant de ressource, donc le compte cible est celui de l'appelant.
  // Un membre agit sur SON compte, qui n'a pas de cle Seam — il n'emprunte donc
  // jamais celle du titulaire. Le choix du compte est l'etape 5.
  const etat = preparer({ user: MEMBRE, profil: profilActif(), permissions: perms({ reglages: 'write' }) })
  const res = reponse()
  await require('../api/serrures')(req({ query: { action: 'locks' } }), res)
  assert.strictEqual(res.code, 400, 'aucune cle sur son propre compte')
  assert.deepStrictEqual(etat.appels.filter(a => a.url.includes('getseam')), [],
    'la cle du titulaire ne doit jamais servir a un membre')
})

test('serrures : deleteCode d\'un membre ne touche pas les codes du titulaire', async () => {
  const etat = preparer({ user: MEMBRE, profil: profilActif(), permissions: perms({ reservations: 'write' }) })
  const res = reponse()
  await require('../api/serrures')(req({ method: 'POST', body: { action: 'deleteCode', code_id: 'abc' } }), res)
  assert.strictEqual(res.code, 400)
  assert.deepStrictEqual(etat.appels.filter(a => a.url.includes('getseam')), [],
    'aucun appel Seam sans cle propre — c\'etait tout l\'enjeu du repli plateforme')
})

test('serrures : action inconnue -> 400', async () => {
  preparer({ user: PROD })
  const res = reponse()
  await require('../api/serrures')(req({ query: { action: 'nimporte' } }), res)
  assert.strictEqual(res.code, 400)
})

test('serrures : action heritee d\'Object.prototype -> 400', async () => {
  preparer({ user: PROD })
  const res = reponse()
  await require('../api/serrures')(req({ query: { action: 'constructor' } }), res)
  assert.strictEqual(res.code, 400)
})

test('serrures : saveConfig CREE la ligne quand elle n\'existe pas', async () => {
  // ⚠ `update` sur une ligne inexistante ne leve pas d'erreur : l'hote lisait
  // « enregistre » sans qu'aucune cle ne soit stockee. Mais refuser n'etait pas
  // la reponse : la ligne api_keys n'est creee que par beds24-setup et par sms,
  // donc un hote Channex sans SMS n'aurait JAMAIS pu enregistrer sa serrure.
  const etat = preparer({ user: AUTRE })   // aucune ligne api_keys pour ce compte
  const res = reponse()
  await require('../api/serrures')(req({ method: 'POST', body: { action: 'saveConfig', apiKey: 'x' } }), res)
  assert.strictEqual(res.code, 200)
  const ecr = etat.ecritures.find(e => e.table === 'api_keys')
  assert.ok(ecr, 'la ligne doit etre creee')
  assert.strictEqual(ecr.row.user_id, AUTRE, 'creee sur le compte de l\'appelant')
})

test('serrures : toggleConfig sans cle enregistree -> 409 (le front le lit)', async () => {
  preparer({ user: AUTRE })
  const res = reponse()
  await require('../api/serrures')(req({ method: 'POST', body: { action: 'toggleConfig', enabled: true } }), res)
  assert.strictEqual(res.code, 409)
})

test('garde : un provider_property_id porte par DEUX comptes -> 409, pas 503', async () => {
  // ⚠ `provider_property_id` n'est pas unique entre comptes. `.maybeSingle()`
  // echouait en PGRST116, transforme en 503 permanent : le kill switch et la
  // simulation devenaient inutilisables pour ces biens.
  preparerAmbigu()
  const { resoudreBien } = require('../lib/require-permission')
  const r = await resoudreBien('209413')
  assert.strictEqual(r.ambigu, true)
  assert.notStrictEqual(r.erreur, true, 'une ambiguite n\'est pas une panne')
})

// ─── property-automation : kill switch ──────────────────────────────────────

test('property-automation : bien d\'un AUTRE compte -> 403, aucune ecriture', async () => {
  const etat = preparer({ user: PROD })
  const res = reponse()
  await require('../api/property-automation')(req({ method: 'POST', body: {
    provider_property_id: BIEN_TIERS.provider_property_id, paused: true } }), res)
  assert.strictEqual(res.code, 403)
  assert.deepStrictEqual(etat.ecritures, [])
})

test('property-automation : membre sans droit reglages -> 403', async () => {
  const etat = preparer({ profil: profilActif(), permissions: perms({ reglages: 'read' }) })
  const res = reponse()
  await require('../api/property-automation')(req({ method: 'POST', body: {
    provider_property_id: BIEN_A.provider_property_id, paused: true } }), res)
  assert.strictEqual(res.code, 403)
  assert.deepStrictEqual(etat.ecritures, [])
})

test('property-automation : bien non materialise -> 409 explicite, pas 404', async () => {
  // Le message dit a l'hote d'attendre le cron ; un 404 lui laisserait croire a
  // une erreur de sa part.
  preparer({ user: PROD })
  const res = reponse()
  await require('../api/property-automation')(req({ method: 'POST', body: {
    provider_property_id: '777777', paused: true } }), res)
  assert.strictEqual(res.code, 409)
})

test('property-automation : titulaire -> bascule acceptee', async () => {
  const etat = preparer({ user: PROD })
  const res = reponse()
  await require('../api/property-automation')(req({ method: 'POST', body: {
    provider_property_id: BIEN_A.provider_property_id, paused: true } }), res)
  assert.notStrictEqual(res.code, 403)
  assert.ok(etat.ecritures.some(e => e.table === 'properties' && e.row.automation_paused === true))
})

test('property-automation : sans jeton -> 401', async () => {
  preparer({ user: null })
  const res = reponse()
  await require('../api/property-automation')({ method: 'GET', headers: {}, query: {}, body: {} }, res)
  assert.strictEqual(res.code, 401)
})

// ─── simulate ───────────────────────────────────────────────────────────────

test('simulate : bien d\'un AUTRE compte -> 403, aucune ecriture', async () => {
  const etat = preparer({ user: PROD })
  const res = reponse()
  await require('../api/simulate')(req({ method: 'POST', body: {
    message: 'bonjour', propertyId: BIEN_TIERS.provider_property_id } }), res)
  assert.strictEqual(res.code, 403)
  assert.deepStrictEqual(etat.ecritures, [])
})

test('simulate : membre sans droit messages -> 403', async () => {
  preparer({ profil: profilActif(), permissions: perms({ messages: 'read' }) })
  const res = reponse()
  await require('../api/simulate')(req({ method: 'POST', body: {
    message: 'bonjour', propertyId: BIEN_A.provider_property_id } }), res)
  assert.strictEqual(res.code, 403)
})

test('simulate : sans jeton -> 401', async () => {
  preparer({ user: null })
  const res = reponse()
  await require('../api/simulate')({ method: 'POST', headers: {}, query: {}, body: {
    message: 'x', propertyId: BIEN_A.id } }, res)
  assert.strictEqual(res.code, 401)
})

// ─── extract-kb ─────────────────────────────────────────────────────────────

test('extract-kb : un membre travaille sur SON compte, pas celui du titulaire', async () => {
  // Meme portee que serrures : sans identifiant de ressource, le compte cible est
  // l'appelant. Sa cle Beds24 n'existe pas -> 400, et rien n'est ecrit.
  const etat = preparer({ user: MEMBRE, profil: profilActif(), permissions: perms({ reglages: 'write' }) })
  const res = reponse()
  await require('../api/extract-kb')(req({ method: 'POST', body: {} }), res)
  assert.strictEqual(res.code, 400)
  assert.deepStrictEqual(etat.ecritures, [])
})

test('extract-kb : sans jeton -> 401', async () => {
  preparer({ user: null })
  const res = reponse()
  await require('../api/extract-kb')({ method: 'POST', headers: {}, query: {}, body: {} }, res)
  assert.strictEqual(res.code, 401)
})

// ─── menages ────────────────────────────────────────────────────────────────

test('menages : un membre ne voit pas le planning du compte auquel il appartient', async () => {
  // Collection : compte cible = appelant. Il n'a aucun bien, donc planning vide —
  // conséquence fonctionnelle assumee jusqu'a l'etape 5, pas une fuite.
  preparer({ user: MEMBRE, profil: profilActif(), permissions: perms({ menages: 'write' }) })
  const res = reponse()
  await require('../api/menages')(req({ method: 'GET' }), res)
  assert.strictEqual(res.code, 200)
  assert.deepStrictEqual(res.body.properties, [])
  assert.deepStrictEqual(res.body.bookings, [])
})

test('menages : titulaire -> 200, aucun filtre de perimetre', async () => {
  const etat = preparer({ user: PROD })
  const res = reponse()
  await require('../api/menages')(req({ method: 'GET' }), res)
  assert.strictEqual(res.code, 200)
  assert.ok(!etat.filtresOr.some(f => f.table === 'properties' && /provider_property_id\.in/.test(f.expression)),
    'le titulaire ne doit pas etre filtre')
})

test('menages : sans jeton -> 401', async () => {
  preparer({ user: null })
  const res = reponse()
  await require('../api/menages')({ method: 'GET', headers: {}, query: {}, body: {} }, res)
  assert.strictEqual(res.code, 401)
})
