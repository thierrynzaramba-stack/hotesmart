// tests/endpoints-reglages.test.js
// Groupe 1 de l'etape 3 : les endpoints du domaine `reglages`.
// (beds24-setup n'est pas exerce ici : sa garde n'a aucune portee filtrante,
//  cf. le commentaire en tete du fichier — il n'y a rien a y verifier de plus
//  que la session, deja couverte par tests/require-permission.test.js.)
// Chaque endpoint est charge avec un double de Supabase : on verifie qu'il
// s'arrete sur la garde AVANT toute action (lecture, ecriture, appel externe).

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
// Sans ces variables, channel-connect et channel-token repondent 503 AVANT la
// garde : le test mesurerait l'absence de configuration, pas les droits.
process.env.CHANNEL_APP_BASE = process.env.CHANNEL_APP_BASE || 'https://app.exemple'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'https://api.exemple'
process.env.CHANNEL_API_KEY  = process.env.CHANNEL_API_KEY  || 'cle-test'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const PROD = 'compte-prod', MEMBRE = 'membre'
const BIEN = { id: '58001ed1-e194-498a-94b4-606eece8f33d', user_id: PROD, name: 'La bulle',
               provider: 'beds24', provider_property_id: '209413' }

// Double minimal, partage par tous les endpoints du groupe.
function preparer({ user = MEMBRE, profil = null, permissions = null, biens = [BIEN] }) {
  const etat = { ecritures: [], lectures: [] }
  const client = {
    auth: { getUser: async () => (user ? { data: { user: { id: user } }, error: null } : { data: null, error: { message: 'x' } }) },
    from(nom) {
      const q = {
        _f: {},
        select() { etat.lectures.push(nom); return q },
        eq(c, v) { q._f[c] = v; return q },
        or(e) { q._or = e; return q },
        is() { return q }, order() { return q }, limit() { return q },
        upsert(r) { etat.ecritures.push({ table: nom, row: r }); return Promise.resolve({ error: null }) },
        insert(r) { etat.ecritures.push({ table: nom, row: r }); return Promise.resolve({ error: null }) },
        update(r) { etat.ecritures.push({ table: nom, row: r }); return q },
        single: async () => reponseTable(nom, q),
        maybeSingle: async () => reponseTable(nom, q),
        then(res2, rej) { return Promise.resolve(reponseTable(nom, q, true)).then(res2, rej) }
      }
      function reponseTable(nom, q, tableau = false) {
        if (nom === 'properties') {
          const m = String(q._or || '').match(/id\.eq\.([^,]+),/)
          const v = m ? m[1] : (q._f.provider_property_id ?? q._f.id)
          const b = biens.find(x => x.id === v || x.provider_property_id === v) || null
          // maybeSingle() reel renvoie { data: null, error: null } quand rien ne
          // matche. Renvoyer une erreur ferait passer un futur test du chemin
          // « bien absent » par la branche 500, en le prenant pour la production.
          return { data: tableau ? (b ? [b] : []) : b, error: null }
        }
        if (nom === 'profiles') {
          const ok = profil && profil.account_user_id === q._f.account_user_id && profil.member_user_id === q._f.member_user_id
          return { data: ok ? profil : null, error: null }
        }
        if (nom === 'profile_permissions') return { data: permissions, error: null }
        return { data: tableau ? [] : null, error: null }
      }
      return q
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of ['../lib/require-permission', '../api/agent-config', '../api/alert-test',
                     '../api/channel-connect', '../api/channel-token']) {
    try { delete require.cache[require.resolve(mod)] } catch {}
  }
  return etat
}

function reponse() {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = () => {}
  r.end = () => r
  return r
}
const profilActif = (o = {}) => ({ id: 'p1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-09-01', ...o })
const perms = (o = {}) => ({ profile_id: 'p1', property_scope: 'all', property_ids: [], property_refs: [], ...o })
const req = (o = {}) => ({ method: 'GET', headers: { authorization: 'Bearer tok' }, query: {}, body: {}, ...o })

// ─── agent-config : l'usurpation par JWT non verifie ────────────────────────

test('agent-config : SANS ressource designee, l\'appelant agit sur SON compte', async () => {
  // ⚠ PORTEE A CONNAITRE. Cet endpoint ne designe aucun bien : le compte cible
  // est donc celui de l'appelant, dont il est titulaire par definition — il
  // passe, et c'est correct : il lit SA config d'alertes, pas celle d'un autre.
  // Le cloisonnement par domaine ne prendra effet ici qu'avec le selecteur de
  // compte (etape 5), qui rendra le compte cible explicite.
  preparer({ profil: profilActif(), permissions: perms({ menages: 'write' }) })
  const handler = require('../api/agent-config')
  const res = reponse()
  await handler(req(), res)
  assert.strictEqual(res.code, 200)
})

test('agent-config : session invalide -> 401, aucune ecriture', async () => {
  const etat = preparer({ user: null })
  const handler = require('../api/agent-config')
  const res = reponse()
  await handler(req({ method: 'POST', body: { config: { sms: true } } }), res)
  assert.strictEqual(res.code, 401)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('agent-config : un JWT FORGE ne passe plus (signature verifiee)', async () => {
  // L'ancien code lisait payload.sub sans verifier la signature : forger
  // `xxx.<sub de la cible>.yyy` suffisait. La garde appelle auth.getUser(), qui
  // valide — ici le double rend « session invalide ».
  const etat = preparer({ user: null })
  const handler = require('../api/agent-config')
  const res = reponse()
  const faux = Buffer.from(JSON.stringify({ sub: PROD })).toString('base64')
  await handler(req({ headers: { authorization: `Bearer entete.${faux}.signature` } }), res)
  assert.strictEqual(res.code, 401)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('agent-config : titulaire -> passe', async () => {
  preparer({ user: PROD })
  const handler = require('../api/agent-config')
  const res = reponse()
  await handler(req(), res)
  assert.strictEqual(res.code, 200)
})

// ─── alert-test : envoi reel ─────────────────────────────────────────────────

test('alert-test : session invalide -> 401, aucun envoi', async () => {
  // Meme portee qu'agent-config : sans ressource designee, la garde ne filtre
  // que la session. Le test utile ici est qu'aucun envoi ne part sans elle.
  preparer({ user: null })
  const handler = require('../api/alert-test')
  const res = reponse()
  await handler(req({ method: 'POST', body: { channel: 'sms', to: '+33600000000' } }), res)
  assert.strictEqual(res.code, 401)
})

// ─── channel-connect / channel-token : bien hors perimetre ──────────────────

test('channel-connect : bien HORS perimetre -> 403', async () => {
  preparer({
    profil: profilActif(),
    permissions: perms({ reglages: 'write', property_scope: 'selected', property_ids: ['autre'], property_refs: ['999'] })
  })
  const handler = require('../api/channel-connect')
  const res = reponse()
  await handler(req({ query: { property_id: '58001ed1-e194-498a-94b4-606eece8f33d' } }), res)
  assert.strictEqual(res.code, 403)
})

test('channel-connect : bien inexistant -> 404', async () => {
  preparer({ profil: profilActif(), permissions: perms({ reglages: 'write' }), biens: [] })
  const handler = require('../api/channel-connect')
  const res = reponse()
  await handler(req({ query: { property_id: '58001ed1-e194-498a-94b4-606eece8f33d' } }), res)
  assert.strictEqual(res.code, 404)
})

test('channel-token : bien HORS perimetre -> 403, aucun token delivre', async () => {
  preparer({
    profil: profilActif(),
    permissions: perms({ reglages: 'write', property_scope: 'selected', property_ids: ['autre'], property_refs: ['999'] })
  })
  const handler = require('../api/channel-token')
  const res = reponse()
  await handler(req({ method: 'POST', body: { property_id: '58001ed1-e194-498a-94b4-606eece8f33d' } }), res)
  assert.strictEqual(res.code, 403)
  assert.ok(!res.body?.token, 'aucun token dans la reponse')
})

test('channel-token : sans property_id -> 400', async () => {
  preparer({ user: PROD })
  const handler = require('../api/channel-token')
  const res = reponse()
  await handler(req({ method: 'POST', body: {} }), res)
  assert.strictEqual(res.code, 400)
})


// ─── LE CHEMIN PASSANT — celui qui manquait ─────────────────────────────────
// Toutes les assertions ci-dessus sont des REFUS. Un test qui ne verifie que des
// refus ne voit pas une regression sur le chemin autorise : c'est exactement
// ainsi que `.eq('id', <valeur brute du client>)` a survecu dans
// channel-connect, alors que le meme piege avait ete corrige la veille.

test('channel-connect : membre DELEGUE, bien dans le perimetre -> passe la garde', async () => {
  preparer({
    profil: profilActif(),
    permissions: perms({ reglages: 'write', property_scope: 'selected',
                         property_ids: [BIEN.id], property_refs: [BIEN.provider_property_id] })
  })
  const handler = require('../api/channel-connect')
  const res = reponse()
  await handler(req({ query: { property_id: BIEN.id } }), res)
  // Le bien de test n'est pas un bien channel -> 400 « pas gere par le
  // gestionnaire de canaux ». L'essentiel est que ce ne soit NI 403 (garde), NI
  // 500 (requete cassee par un identifiant non resolu).
  assert.notStrictEqual(res.code, 403, 'la delegation doit passer la garde')
  assert.notStrictEqual(res.code, 500, 'la requete ne doit pas casser sur le type uuid')
})

test('channel-connect : bien designe par son propId (non-UUID) -> pas de 500', async () => {
  // LA REGRESSION : la garde accepte un provider_property_id, mais le SELECT qui
  // suit filtre `id` (type uuid). Passer la valeur brute produisait
  // « invalid input syntax for type uuid » -> 500.
  preparer({ user: PROD })
  const handler = require('../api/channel-connect')
  const res = reponse()
  await handler(req({ query: { property_id: BIEN.provider_property_id } }), res)
  assert.notStrictEqual(res.code, 404, 'le propId doit etre resolu en UUID avant le SELECT')
  if (res.code === 500) {
    assert.match(String(res.body?.error || ''), /fetch|network|ECONN|Internal/i,
      'un 500 ne doit venir que de l\'appel externe, jamais du type uuid')
  }
})

test('channel-token : titulaire, bien resolu -> passe la garde', async () => {
  preparer({ user: PROD })
  const handler = require('../api/channel-token')
  const res = reponse()
  await handler(req({ method: 'POST', body: { property_id: BIEN.id } }), res)
  assert.notStrictEqual(res.code, 403)
  assert.notStrictEqual(res.code, 401)
})

test('channel-token : bien designe par son propId -> resolu, pas « introuvable »', async () => {
  // ⚠ Ce test ne peut PAS se contenter de « pas de 500 » : l'endpoint termine
  // par un vrai fetch vers le gestionnaire de canaux, qui echoue en test et
  // produit legitimement un 500. Le point verifie est que la RESOLUTION du bien
  // a abouti — un identifiant non resolu donnerait 404 « Bien introuvable », et
  // une valeur brute passee a `.eq('id', …)` casserait la requete.
  preparer({ user: PROD })
  const handler = require('../api/channel-token')
  const res = reponse()
  await handler(req({ method: 'POST', body: { property_id: BIEN.provider_property_id } }), res)
  assert.notStrictEqual(res.code, 404, 'le propId doit etre resolu en UUID avant le SELECT')
  assert.notStrictEqual(res.code, 403)
  if (res.code === 500) {
    assert.match(String(res.body?.error || ''), /fetch|network|ECONN|Internal/i,
      'un 500 ne doit venir que de l\'appel externe, jamais d\'une requete cassee')
  }
})
