// tests/endpoints-reglages-2.test.js
// Groupe 2 de l'etape 3 : les endpoints channel (mapping, airbnb, bcom) et la
// contrainte de destinataire d'alert-test.
//
// Chaque test verifie AUSSI le chemin autorise, pas seulement les refus : c'est
// ce qui manquait au groupe 1 et qui a laissé passer une regression.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'https://api.exemple'
process.env.CHANNEL_API_KEY  = process.env.CHANNEL_API_KEY  || 'cle-test'
process.env.CHANNEL_APP_BASE = process.env.CHANNEL_APP_BASE || 'https://app.exemple'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const PROD = 'compte-prod', MEMBRE = 'membre'
const BIEN = { id: '58001ed1-e194-498a-94b4-606eece8f33d', user_id: PROD, name: 'Colomiers',
               provider: 'channex', provider_property_id: '0544fd9a' }

function preparer({ user = MEMBRE, profil = null, permissions = null, biens = [BIEN], config = null, compteurTests = 0 }) {
  const etat = { ecritures: [] }
  const client = {
    auth: { getUser: async () => (user ? { data: { user: { id: user } }, error: null } : { data: null, error: { message: 'x' } }) },
    from(nom) {
      const q = {
        _f: {},
        select() { return q }, eq(c, v) { q._f[c] = v; return q }, or(e) { q._or = e; return q },
        in() { return q }, neq() { return q }, not() { return q }, is() { return q }, order() { return q }, limit() { return q },
        // Comptage de la limite de debit : `.select(…, {count}).eq().eq().gte()`
        gte() { return q },
        insert(r) { etat.ecritures.push({ table: nom, row: r }); return Promise.resolve({ error: null }) },
        upsert(r) { etat.ecritures.push({ table: nom, row: r }); return Promise.resolve({ error: null }) },
        update(r) { etat.ecritures.push({ table: nom, row: r }); return q },
        single: async () => rep(nom, q), maybeSingle: async () => rep(nom, q),
        then(r2, rj) { return Promise.resolve(rep(nom, q, true)).then(r2, rj) }
      }
      function rep(nom, q, tableau = false) {
        if (nom === 'properties') {
          const m = String(q._or || '').match(/id\.eq\.([^,]+),/)
          const v = m ? m[1] : (q._f.provider_property_id ?? q._f.id)
          const b = biens.find(x => x.id === v || x.provider_property_id === v) || null
          return { data: tableau ? (b ? [b] : []) : b, error: null }
        }
        if (nom === 'profiles') {
          const ok = profil && profil.account_user_id === q._f.account_user_id && profil.member_user_id === q._f.member_user_id
          return { data: ok ? profil : null, error: null }
        }
        if (nom === 'profile_permissions') return { data: permissions, error: null }
        if (nom === 'agent_alert_config') return { data: config ? { config } : null, error: null }
        // sms_logs : compteur de la limite de debit. 0 par defaut.
        if (nom === 'sms_logs') return { data: [], count: compteurTests, error: null }
        return { data: tableau ? [] : null, error: null }
      }
      return q
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of ['../lib/require-permission', '../api/alert-test', '../api/sms',
                     '../api/channel-mapping', '../api/channel-bcom', '../api/channel-bcom-write',
                     '../api/channel-bcom-activate', '../api/channel-airbnb-connect']) {
    try { delete require.cache[require.resolve(mod)] } catch {}
  }
  return etat
}

function reponse() {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = () => {}
  return r
}
const profilActif = (o = {}) => ({ id: 'p1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-09-01', ...o })
const perms = (o = {}) => ({ profile_id: 'p1', property_scope: 'all', property_ids: [], property_refs: [], ...o })
const req = (o = {}) => ({ method: 'GET', headers: { authorization: 'Bearer tok' }, query: {}, body: {}, ...o })

// ─── alert-test : RETIRÉ (PWA lot 2c-3, étape 4) ────────────────────────────
// Il était le bouton « Tester » des listes d'alertes, et ses tests gardaient
// sa contrainte « destinataire déjà configuré » (pas de relais par la clé
// plateforme). Les listes sont reprises en contacts prévenus, dont l'essai vit
// dans /api/push (une fois par adresse et par jour, dix par compte, tenu par la
// base — tests/notifications-contacts-ecran.test.js). L'endpoint répond 410 et
// n'envoie plus RIEN : c'est ce que ces tests gardent désormais, pour toute
// charge, configurée ou non — le relais qu'ils fermaient ne peut pas revenir.

const CONFIG = { '0544fd9a': { info_unknown: {
  sms_lines: 'Thierry : 06 12 34 56 78', email_lines: 'Thierry : hote@exemple.fr',
  sms_numbers: [], email_addresses: []
} } }

for (const [nom, corps] of [
  ['destinataire NON configuré', { channel: 'sms', to: '+33600000000' }],
  ['e-mail arbitraire', { channel: 'email', to: 'attaquant@ailleurs.fr' }],
  ['destinataire configuré', { channel: 'email', to: 'hote@exemple.fr' }],
  ['même numéro, autre format', { channel: 'sms', to: '+33612345678' }]
]) {
  test(`alert-test retiré : ${nom} -> 410, aucun envoi`, async () => {
    preparer({ user: PROD, config: CONFIG, compteurTests: 0 })
    const handler = require('../api/alert-test')
    const res = reponse()
    await handler(req({ method: 'POST', body: corps }), res)
    assert.strictEqual(res.code, 410)
    assert.match(String(res.body?.error || ''), /Réglages/)
  })
}

test('alert-test retiré : sans session, toujours 401 (la garde reste devant)', async () => {
  preparer({ user: PROD, config: CONFIG })
  const handler = require('../api/alert-test')
  const res = reponse()
  await handler(req({ method: 'POST', body: { channel: 'sms', to: '0612345678' }, headers: {} }), res)
  assert.strictEqual(res.code, 401)
})

// ─── endpoints channel : hors perimetre -> 403, dans le perimetre -> passe ──

const HORS = () => ({
  profil: profilActif(),
  permissions: perms({ reglages: 'write', property_scope: 'selected',
                       property_ids: ['autre-uuid'], property_refs: ['999999'] })
})
const DANS = () => ({
  profil: profilActif(),
  permissions: perms({ reglages: 'write', property_scope: 'selected',
                       property_ids: [BIEN.id], property_refs: [BIEN.provider_property_id] })
})

const CAS = [
  ['channel-mapping',        '../api/channel-mapping',        () => req({ query: { action: 'channels', property_id: BIEN.provider_property_id } })],
  ['channel-bcom',           '../api/channel-bcom',           () => req({ query: { action: 'our_options', property_id: BIEN.provider_property_id } })],
  ['channel-bcom-write',     '../api/channel-bcom-write',     () => req({ method: 'POST', query: { action: 'create', property_id: BIEN.provider_property_id, hotel_id: '1', room_type_code: '1', rate_plan_code: '1' } })],
  ['channel-airbnb-connect', '../api/channel-airbnb-connect', () => req({ method: 'POST', query: { action: 'create' }, body: { property_id: BIEN.id } })]
]

for (const [nom, mod, faireReq] of CAS) {
  test(`${nom} : bien HORS perimetre -> 403`, async () => {
    preparer(HORS())
    const handler = require(mod)
    const res = reponse()
    await handler(faireReq(), res)
    assert.strictEqual(res.code, 403, `${nom} doit refuser un bien hors perimetre`)
  })

  test(`${nom} : bien DANS le perimetre -> pas de refus de droits`, async () => {
    preparer(DANS())
    const handler = require(mod)
    const res = reponse()
    await handler(faireReq(), res)
    // L'appel externe echoue en test (pas de reseau) : on verifie seulement que
    // ce n'est ni un refus de droits, ni un « bien introuvable » — ce dernier
    // signalerait un identifiant mal resolu.
    assert.notStrictEqual(res.code, 403, `${nom} doit laisser passer un bien du perimetre`)
    assert.notStrictEqual(res.code, 404, `${nom} doit resoudre l'identifiant fourni`)
  })
}

// (Les deux tests de la limite de débit d'alert-test sont retirés avec lui :
// il n'y a plus d'envoi à borner. Voir l'en-tête de la section alert-test.)

// ⚠ Le test « la session Airbnb appartient au compte PROPRIETAIRE » a ete RETIRE :
// il etait INATTEIGNABLE. channel-airbnb-connect appelle le gestionnaire de
// canaux (resolveGroupId) AVANT son INSERT ; en test cet appel echoue, le
// handler retourne 500, et `etat.ecritures` ne contient jamais
// airbnb_connect_sessions. Le `if (session)` rendait l'assertion muette : le
// test passait sans rien verifier.
// Le rattachement de la session au compte proprietaire
// (channel-airbnb-connect.js, `user_id: compteBien`) reste donc NON COUVERT —
// il faudrait un double de `fetch`. Note comme dette plutot que masque par un
// test qui ne teste rien.
