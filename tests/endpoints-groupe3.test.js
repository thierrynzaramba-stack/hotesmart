// tests/endpoints-groupe3.test.js
// Groupe 3 de l'etape 3 : les endpoints qui touchent aux PRIX, aux DISPONIBILITES
// et aux MESSAGES VOYAGEURS.
//
//   calendar               ecrit tarifs / dispos, pousse vers les OTA
//   channel-rateplan       configure les tarifs derives par canal
//   beds24                 proxy Beds24 (lecture conversations + envoi)
//   channel-import-messages import d'historique
//   messages               collection : la RLS ne s'applique pas, la garde si
//
// Ici une erreur de perimetre ne fuit pas une donnee : elle publie un tarif ou
// ferme des dates sur le bien d'un autre compte, ou ecrit au voyageur d'autrui.
// Chaque refus est donc double d'un chemin PASSANT, pour qu'un 403 de trop se
// voie tout de suite.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'https://api.exemple'
process.env.CHANNEL_API_KEY  = process.env.CHANNEL_API_KEY  || 'cle-test'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const PROD = 'compte-prod', AUTRE = 'compte-autre', MEMBRE = 'membre'

const BIEN_A = { id: '58001ed1-e194-498a-94b4-606eece8f33d', user_id: PROD, name: 'La bulle',
                 provider: 'beds24', provider_property_id: '209413',
                 // extra_guest_fee volontairement NULL : c'est le cas ou la mise a
                 // zero se perdait.
                 included_guests: 4, extra_guest_fee: null }
const BIEN_B = { id: '7c2b0f11-2222-4444-8888-aaaaaaaaaaaa', user_id: PROD, name: 'Coeur de vie',
                 provider: 'beds24', provider_property_id: '169567' }
const BIEN_TIERS = { id: '9f3c0000-3333-4444-9999-bbbbbbbbbbbb', user_id: AUTRE, name: 'Chez un autre',
                     provider: 'beds24', provider_property_id: '999999' }
// ⚠ Un provider_property_id Channex EST un UUID : ce bien existe pour que la
// resolution par reference canal soit reellement exercee.
const BIEN_CHANNEX = { id: 'aa11bb22-cc33-4dd4-8ee5-ff6677889900', user_id: PROD, name: 'Colomiers',
                       provider: 'channex', provider_property_id: '0544fd9a-6579-44e7-b75e-19c63a2019ba' }
const BIENS = [BIEN_A, BIEN_B, BIEN_TIERS, BIEN_CHANNEX]

const MODULES = ['../lib/require-permission', '../lib/permissions', '../api/calendar',
                 '../api/channel-rateplan', '../api/beds24', '../api/messages',
                 '../api/channel-import-messages', '../lib/record-message', '../lib/channels']

// `snapshots` : lignes bookings_snapshot { user_id, booking_id, property_id, snapshot }
function preparer ({ user = MEMBRE, profil = null, permissions = null,
                     snapshots = [], messages = [], fetchStub = null, erreurSnapshot = null,
                     erreurUpdateProperties = null } = {}) {
  const etat = { ecritures: [], filtresIn: [], appels: [] }

  const client = {
    auth: { getUser: async () => (user ? { data: { user: { id: user } }, error: null }
                                       : { data: null, error: { message: 'x' } }) },
    from (nom) {
      const q = {
        _f: {}, _in: null, _or: null,
        select () { return q },
        eq (c, v) { q._f[c] = v; return q },
        or (e) { q._or = e; return q },
        in (c, v) { q._in = { c, v }; etat.filtresIn.push({ table: nom, colonne: c, valeurs: v }); return q },
        neq () { return q }, not () { return q }, is () { return q },
        order () { return q }, limit () { return q }, gte () { return q }, lte () { return q },
        insert (r) { etat.ecritures.push({ table: nom, row: r }); return { select: () => ({ single: async () => ({ data: { id: 'q1' }, error: null }) }) } },
        upsert (r) { etat.ecritures.push({ table: nom, row: r }); return Promise.resolve({ error: null }) },
        update (r) {
          etat.ecritures.push({ table: nom, row: r })
          if (nom === 'properties' && erreurUpdateProperties) {
            const echec = { eq: () => echec, then: (ok) => Promise.resolve({ error: { message: erreurUpdateProperties } }).then(ok) }
            return echec
          }
          return q
        },
        single: async () => rep(nom, q), maybeSingle: async () => rep(nom, q),
        then (ok, ko) { return Promise.resolve(rep(nom, q, true)).then(ok, ko) }
      }
      function rep (nom, q, tableau = false) {
        if (nom === 'properties') {
          // ⚠ Le double reproduit le PIEGE REEL : `id` est de type uuid. Une
          // valeur non-UUID dans la branche `id.eq.` est une ERREUR Postgres, pas
          // un resultat vide — c'est ce qui avait casse l'envoi de SMS.
          if (q._or) {
            const m = String(q._or).match(/^id\.eq\.([^,]+),provider_property_id\.eq\.(.+)$/)
            assert.ok(m, 'filtre .or() inattendu : ' + q._or)
            assert.match(m[1], /^[0-9a-f]{8}-/i, 'un identifiant non-UUID ne doit JAMAIS atteindre id.eq')
            const b = BIENS.find(x => x.id === m[1] || x.provider_property_id === m[2]) || null
            return { data: b, error: null }
          }
          if (q._f.id != null) {
            assert.match(String(q._f.id), /^[0-9a-f]{8}-/i, '.eq(id) recoit un identifiant non-UUID')
          }
          // ⚠ Le double doit honorer `.in()` sur N'IMPORTE QUELLE colonne. Ne le
          // traiter que pour `id` faisait renvoyer tous les biens a la requete
          // par provider_property_id — un bien etranger serait passe inapercu.
          const cands = BIENS.filter(b =>
            (q._f.id == null || b.id === q._f.id) &&
            (q._f.provider_property_id == null || b.provider_property_id === q._f.provider_property_id) &&
            (q._f.user_id == null || b.user_id === q._f.user_id) &&
            (q._in == null || q._in.v.includes(b[q._in.c])))
          return { data: tableau ? cands : (cands[0] || null), error: null }
        }
        if (nom === 'profiles') {
          const ok = profil && profil.account_user_id === q._f.account_user_id &&
                              profil.member_user_id === q._f.member_user_id
          return { data: ok ? profil : null, error: null }
        }
        if (nom === 'profile_permissions') return { data: permissions, error: null }
        if (nom === 'bookings_snapshot') {
          if (erreurSnapshot) return { data: null, error: { message: erreurSnapshot } }
          const rows = snapshots.filter(s =>
            (q._f.booking_id == null || String(s.booking_id) === String(q._f.booking_id)) &&
            (q._f.user_id == null || s.user_id === q._f.user_id) &&
            (q._in == null || q._in.c !== 'property_id' || q._in.v.includes(s.property_id)))
          return { data: tableau ? rows : (rows[0] || null), error: null }
        }
        // ⚠ La cle n'existe QUE pour le compte de production. C'est ce qui rend
        // visible une bascule de compte indue : sans cle, l'endpoint repond 400.
        if (nom === 'api_keys') {
          return q._f.user_id === PROD
            ? { data: { api_key: 'cle-du-compte' }, error: null }
            : { data: null, error: { message: 'aucune ligne' } }
        }
        if (nom === 'messages') {
          const rows = messages.filter(m =>
            (q._in == null || q._in.c !== 'property_id' || q._in.v.includes(m.property_id)))
          return { data: tableau ? rows : (rows[0] || null), error: null }
        }
        if (nom === 'channel_sync_queue') return { data: tableau ? [] : null, error: null }
        if (nom === 'calendar_inventory') return { data: tableau ? [] : null, error: null }
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
    if (fetchStub) {
      const r = await fetchStub(String(url), opts)
      if (r) return r
    }
    return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '{}' }
  }
  return etat
}

// Double ou TOUTE lecture echoue : sert a verifier qu'une panne ne se deguise
// pas en refus de droits.
function preparerPanne () {
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: PROD } }, error: null }) },
    from () {
      const q = {
        select () { return q }, eq () { return q }, or () { return q }, in () { return q },
        order () { return q }, limit () { return q }, gte () { return q }, lte () { return q },
        single: async () => ({ data: null, error: { message: 'timeout' } }),
        maybeSingle: async () => ({ data: null, error: { message: 'timeout' } }),
        then (ok, ko) { return Promise.resolve({ data: null, error: { message: 'timeout' } }).then(ok, ko) }
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
  return r
}

const profilActif = (o = {}) => ({ id: 'p1', account_user_id: PROD, member_user_id: MEMBRE,
                                   active: true, accepted_at: '2026-09-01', ...o })
const perms = (o = {}) => ({ profile_id: 'p1', property_scope: 'all', property_ids: [], property_refs: [],
                             reservations: 'none', menages: 'none', prestataires: 'none', messages: 'none',
                             avis: 'none', reglages: 'none', facturation: 'none', equipe: 'none', ...o })
const req = (o = {}) => ({ method: 'GET', headers: { authorization: 'Bearer tok' }, query: {}, body: {}, ...o })

// ─── calendar : prix et disponibilites ───────────────────────────────────────

test('calendar GET : membre sans droit reservations -> 403', async () => {
  preparer({ profil: profilActif(), permissions: perms({ reservations: 'none' }) })
  const res = reponse()
  await require('../api/calendar')(req({ query: { property_ids: BIEN_A.id, start: '2026-09-01', end: '2026-09-30' } }), res)
  assert.strictEqual(res.code, 403)
})

test('calendar GET : titulaire -> passe', async () => {
  preparer({ user: PROD })
  const res = reponse()
  await require('../api/calendar')(req({ query: { property_ids: BIEN_A.id, start: '2026-09-01', end: '2026-09-30' } }), res)
  assert.strictEqual(res.code, 200)
})

test('calendar GET : un bien ETRANGER glisse dans la liste -> refus global', async () => {
  // Sans garde, loadOwnedProperties se contentait de filtrer : la requete
  // repondait 200 en ignorant l'intrus, sans jamais refuser l'appelant.
  preparer({ user: PROD })
  const res = reponse()
  await require('../api/calendar')(req({ query: { property_ids: `${BIEN_A.id},${BIEN_TIERS.id}`, start: '2026-09-01', end: '2026-09-30' } }), res)
  assert.ok(res.code === 403 || res.code === 404, `attendu 403/404, recu ${res.code}`)
})

test('calendar POST : membre reservations=read -> 403, AUCUNE ecriture', async () => {
  const etat = preparer({ profil: profilActif(), permissions: perms({ reservations: 'read' }) })
  const res = reponse()
  await require('../api/calendar')(req({ method: 'POST', body: {
    action: 'save', property_id: BIEN_A.id,
    segments: [{ date_from: '2026-09-10', date_to: '2026-09-12', rate: 1 }]
  } }), res)
  assert.strictEqual(res.code, 403)
  assert.deepStrictEqual(etat.ecritures, [], 'un tarif a ete ecrit malgre le refus')
})

test('calendar POST : bien HORS perimetre -> 403, AUCUNE ecriture', async () => {
  const etat = preparer({ profil: profilActif(),
    permissions: perms({ reservations: 'write', property_scope: 'selected',
                         property_ids: [BIEN_B.id], property_refs: [BIEN_B.provider_property_id] }) })
  const res = reponse()
  await require('../api/calendar')(req({ method: 'POST', body: {
    action: 'save', property_id: BIEN_A.id,
    segments: [{ date_from: '2026-09-10', date_to: '2026-09-12', rate: 1 }]
  } }), res)
  assert.strictEqual(res.code, 403)
  assert.deepStrictEqual(etat.ecritures, [])
})

test('calendar POST : property_id envoye en propId Beds24 -> resolu, jamais passe a .eq(id)', async () => {
  // Le double leve une assertion si un non-UUID atteint la colonne uuid.
  const etat = preparer({ user: PROD })
  const res = reponse()
  await require('../api/calendar')(req({ method: 'POST', body: {
    action: 'save', property_id: BIEN_A.provider_property_id,
    segments: [{ date_from: '2026-09-10', date_to: '2026-09-10', rate: 120 }]
  } }), res)
  assert.notStrictEqual(res.code, 403)
  assert.notStrictEqual(res.code, 404)
  const inv = etat.ecritures.filter(e => e.table === 'calendar_inventory')
  assert.ok(inv.length, 'aucune ecriture calendar_inventory')
  const lignes = [].concat(...inv.map(e => e.row))
  assert.ok(lignes.every(l => l.property_id === BIEN_A.id),
    'calendar_inventory doit porter l\'UUID resolu, pas la valeur client')
})

test('calendar GET : jeton invalide -> 401, meme quand aucun bien ne se resout', async () => {
  // ⚠ Regression introduite puis corrigee : sans identifiant resolvable, la garde
  // n'etait jamais atteinte et la requete repondait 200 sans session valide — et
  // la difference 200/401 revelait l'existence d'un bien.
  const etat = preparer({ user: null })
  const res = reponse()
  await require('../api/calendar')(req({ query: {
    property_ids: '00000000-0000-0000-0000-000000000000', start: '2026-09-01', end: '2026-09-30' } }), res)
  assert.strictEqual(res.code, 401)
  void etat
})

test('calendar : sans en-tete Authorization -> 401', async () => {
  preparer({ user: PROD })
  const res = reponse()
  await require('../api/calendar')({ method: 'GET', headers: {}, query: {
    property_ids: BIEN_A.id, start: '2026-09-01', end: '2026-09-30' }, body: {} }, res)
  assert.strictEqual(res.code, 401)
})

test('calendar GET : un provider_property_id Channex (qui EST un UUID) se resout', async () => {
  // La branche UUID n'interrogeait que `properties.id` : un bien channel designe
  // par sa reference canal donnait un calendrier blanc en 200, alors que le POST
  // sur le meme identifiant fonctionnait.
  preparer({ user: PROD })
  const res = reponse()
  await require('../api/calendar')(req({ query: {
    property_ids: BIEN_CHANNEX.provider_property_id, start: '2026-09-01', end: '2026-09-30' } }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.properties.length, 1)
  assert.strictEqual(res.body.properties[0].id, BIEN_CHANNEX.id)
})

test('calendar POST : perPerson exige AUSSI reglages/write', async () => {
  // Ces segments modifient la configuration du bien, pas le calendrier.
  const etat = preparer({ profil: profilActif(),
    permissions: perms({ reservations: 'write', reglages: 'none' }) })
  const res = reponse()
  await require('../api/calendar')(req({ method: 'POST', body: {
    action: 'save', property_id: BIEN_A.id,
    segments: [{ kind: 'perPerson', included: 2, extra_guest_fee: 15 }] } }), res)
  assert.strictEqual(res.code, 403)
  assert.deepStrictEqual(etat.ecritures.filter(e => e.table === 'properties'), [])
})

test('calendar POST : segments de dates seuls -> reglages non exige', async () => {
  const etat = preparer({ profil: profilActif(),
    permissions: perms({ reservations: 'write', reglages: 'none' }) })
  const res = reponse()
  await require('../api/calendar')(req({ method: 'POST', body: {
    action: 'save', property_id: BIEN_A.id,
    segments: [{ date_from: '2026-09-10', date_to: '2026-09-10', rate: 120 }] } }), res)
  assert.notStrictEqual(res.code, 403)
  assert.ok(etat.ecritures.some(e => e.table === 'calendar_inventory'))
})

test('garde : une PANNE de lecture donne 503, pas 404 ni 403', async () => {
  // ⚠ L'erreur Supabase etait avalee : un timeout rendait « bien introuvable »
  // (404) et « aucun droit » (403). Un incident de trente secondes faisait croire
  // aux hotes qu'ils avaient perdu leurs biens.
  const { requirePermission } = (() => {
    preparerPanne()
    return require('../lib/require-permission')
  })()
  const res = reponse()
  const g = await requirePermission(req(), res, {
    domaine: 'reservations', niveau: 'read', bien: BIEN_A.id, bienRequis: true })
  assert.strictEqual(g.ok, false)
  assert.strictEqual(res.code, 503)
})

test('calendar GET : erreur de lecture des reservations -> 500, jamais un calendrier libre', async () => {
  // Un calendrier affiche sans reservations invite a la surreservation.
  preparer({ user: PROD, erreurSnapshot: 'timeout' })
  const res = reponse()
  await require('../api/calendar')(req({ query: {
    property_ids: BIEN_A.id, start: '2026-09-01', end: '2026-09-30' } }), res)
  assert.strictEqual(res.code, 500)
})

test('calendar POST : mettre a 0 un champ NULL est bien enregistre', async () => {
  // ⚠ Number(null) === 0 : comparer par Number faisait disparaitre la mise a zero
  // d'un champ jusque-la NULL. L'hote lisait « enregistre » sans rien changer.
  const etat = preparer({ user: PROD })
  const res = reponse()
  await require('../api/calendar')(req({ method: 'POST', body: {
    action: 'save', property_id: BIEN_A.id,
    segments: [{ kind: 'perPerson', extra_guest_fee: 0 },
               { date_from: '2026-09-10', date_to: '2026-09-10', rate: 100 }] } }), res)
  const maj = etat.ecritures.find(e => e.table === 'properties')
  assert.ok(maj, 'la mise a zero doit produire une ecriture')
  assert.strictEqual(maj.row.extra_guest_fee, 0)
})

test('calendar POST : un segment de config INCHANGE n\'exige pas reglages', async () => {
  // Le front pousse perPerson des que l'onglet a ete affiche : le membre ne doit
  // pas perdre ses changements de tarifs pour autant.
  const etat = preparer({ profil: profilActif(),
    permissions: perms({ reservations: 'write', reglages: 'none' }) })
  const res = reponse()
  await require('../api/calendar')(req({ method: 'POST', body: {
    action: 'save', property_id: BIEN_A.id,
    segments: [{ kind: 'perPerson', included: BIEN_A.included_guests },
               { date_from: '2026-09-10', date_to: '2026-09-10', rate: 100 }] } }), res)
  assert.notStrictEqual(res.code, 403)
  assert.ok(etat.ecritures.some(e => e.table === 'calendar_inventory'),
    'les tarifs autorises doivent etre enregistres')
})

test('garde : une ligne mise en cache qui ne correspond PAS a la reference est ignoree', async () => {
  // ⚠ Le cache court-circuiterait la resolution : accountUserId et le perimetre
  // derivent du seul bienResolu. Passer la reference A et la ligne de B ferait
  // verifier les droits sur B.
  preparer({ user: PROD })
  const { requirePermission } = require('../lib/require-permission')
  const res = reponse()
  const g = await requirePermission(req(), res, {
    domaine: 'reservations', niveau: 'read',
    bien: BIEN_TIERS.provider_property_id,   // reference d'un AUTRE compte
    bienResolu: BIEN_A,                      // ligne d'un bien du compte appelant
    bienRequis: true
  })
  assert.strictEqual(g.ok, false, 'la ligne mise en cache ne doit pas primer sur la reference')
  assert.strictEqual(res.code, 403)
})

test('garde : une ligne mise en cache CONFORME evite la relecture', async () => {
  preparer({ user: PROD })
  const { requirePermission } = require('../lib/require-permission')
  const res = reponse()
  const g = await requirePermission(req(), res, {
    domaine: 'reservations', niveau: 'read',
    bien: BIEN_A.provider_property_id, bienResolu: BIEN_A, bienRequis: true
  })
  assert.strictEqual(g.ok, true)
  assert.strictEqual(g.bien.id, BIEN_A.id)
})

test('calendar POST : un echec de la config ne fait pas perdre les tarifs', async () => {
  // Les deux ecritures sont independantes : l'hote doit etre averti sans perdre
  // ce qui pouvait aboutir.
  const etat = preparer({ user: PROD, erreurUpdateProperties: 'contrainte' })
  const res = reponse()
  await require('../api/calendar')(req({ method: 'POST', body: {
    action: 'save', property_id: BIEN_A.id,
    segments: [{ kind: 'perPerson', extra_guest_fee: 12 },
               { date_from: '2026-09-10', date_to: '2026-09-10', rate: 100 }] } }), res)
  assert.strictEqual(res.code, 200)
  assert.ok(etat.ecritures.some(e => e.table === 'calendar_inventory'), 'les tarifs doivent etre ecrits')
  assert.ok((res.body.warnings || []).some(w => /configuration/.test(w)), 'l\'echec doit etre remonte')
})

test('calendar POST : config SEULE en echec -> 500', async () => {
  preparer({ user: PROD, erreurUpdateProperties: 'contrainte' })
  const res = reponse()
  await require('../api/calendar')(req({ method: 'POST', body: {
    action: 'save', property_id: BIEN_A.id,
    segments: [{ kind: 'perPerson', extra_guest_fee: 12 }] } }), res)
  assert.strictEqual(res.code, 500)
})

// ─── channel-rateplan : tarifs derives par canal ─────────────────────────────

test('channel-rateplan : membre reglages=none -> 403', async () => {
  preparer({ profil: profilActif(), permissions: perms({ reglages: 'none' }) })
  const res = reponse()
  await require('../api/channel-rateplan')(req({
    query: { action: 'set_rule', property_id: BIEN_A.provider_property_id, channel: 'booking' } }), res)
  assert.strictEqual(res.code, 403)
})

test('channel-rateplan : bien d\'un AUTRE compte -> 403', async () => {
  preparer({ user: PROD })
  const res = reponse()
  await require('../api/channel-rateplan')(req({
    query: { action: 'set_rule', property_id: BIEN_TIERS.provider_property_id, channel: 'booking' } }), res)
  assert.strictEqual(res.code, 403)
})

test('channel-rateplan : channel_id au format refuse -> 400 (garde et action alignees)', async () => {
  // La garde interrogeait /channels/<encode> et les actions /channels/<brut> :
  // un / ou un ? y designait deux ressources differentes.
  const etat = preparer({ user: PROD })
  const res = reponse()
  await require('../api/channel-rateplan')(req({ query: {
    action: 'remap', property_id: BIEN_A.provider_property_id, channel_id: 'abc/../autre' } }), res)
  assert.strictEqual(res.code, 400)
  assert.deepStrictEqual(etat.appels.filter(a => a.url.includes('/channels/')), [])
})

test('channel-rateplan : raw_channel exige un canal rattache au perimetre', async () => {
  // Le canal appartient au bien d'un autre compte : ses mappings ne doivent pas
  // sortir. Avant la garde, un channel_id suffisait.
  preparer({ user: PROD, fetchStub: async (url) => {
    if (url.includes('/channels/canal-tiers')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({
        data: { attributes: { properties: [BIEN_TIERS.provider_property_id], rate_plans: [] } } }) }
    }
    return null
  } })
  const res = reponse()
  await require('../api/channel-rateplan')(req({ query: { action: 'raw_channel', channel_id: 'canal-tiers' } }), res)
  assert.ok(res.code === 403 || res.code === 404, `attendu 403/404, recu ${res.code}`)
})

test('channel-rateplan remap : SON bien + le canal d\'un AUTRE compte -> 403, aucun PUT', () => {
  // Le trou que la garde par bien seule laissait entier : rebrancher le canal
  // Booking.com d'autrui sur ses propres tarifs.
  return (async () => {
    const etat = preparer({ user: PROD, fetchStub: async (url) => {
      if (url.includes('/channels/canal-tiers')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({
          data: { attributes: { properties: [BIEN_TIERS.provider_property_id], rate_plans: [] } } }) }
      }
      return null
    } })
    const res = reponse()
    await require('../api/channel-rateplan')(req({ query: {
      action: 'remap', property_id: BIEN_A.provider_property_id,
      channel_id: 'canal-tiers', dry_run: 'false' } }), res)
    assert.strictEqual(res.code, 403)
    assert.deepStrictEqual(etat.appels.filter(a => a.method === 'PUT'), [])
  })()
})

test('channel-rateplan remap_airbnb : canal etranger -> 403, aucun DELETE', async () => {
  const etat = preparer({ user: PROD, fetchStub: async (url) => {
    if (url.includes('/channels/canal-tiers')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({
        data: { attributes: { properties: [BIEN_TIERS.provider_property_id], rate_plans: [] } } }) }
    }
    return null
  } })
  const res = reponse()
  await require('../api/channel-rateplan')(req({ query: {
    action: 'remap_airbnb', property_id: BIEN_A.provider_property_id,
    channel_id: 'canal-tiers', dry_run: 'false' } }), res)
  assert.strictEqual(res.code, 403)
  assert.deepStrictEqual(etat.appels.filter(a => a.method === 'DELETE'), [])
})

test('channel-rateplan remap : canal DU bien -> passe la garde', async () => {
  const etat = preparer({ user: PROD, fetchStub: async (url) => {
    if (url.includes('/channels/canal-a')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({
        data: { attributes: { properties: [BIEN_A.provider_property_id], rate_plans: [] } } }) }
    }
    return null
  } })
  const res = reponse()
  await require('../api/channel-rateplan')(req({ query: {
    action: 'remap', property_id: BIEN_A.provider_property_id, channel_id: 'canal-a' } }), res)
  assert.notStrictEqual(res.code, 403, 'le canal du bien ne doit pas etre refuse')
  void etat
})

test('channel-rateplan inspect : rate_plan_id d\'un AUTRE bien -> 403', async () => {
  preparer({ user: PROD, fetchStub: async (url) => {
    if (url.includes('/rate_plans/rp-tiers')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({
        data: { attributes: { title: 'secret', property_id: BIEN_TIERS.provider_property_id } } }) }
    }
    return null
  } })
  const res = reponse()
  await require('../api/channel-rateplan')(req({ query: {
    action: 'inspect', property_id: BIEN_A.provider_property_id, rate_plan_id: 'rp-tiers' } }), res)
  assert.strictEqual(res.code, 403)
})

// ─── beds24 : proxy conversations + envoi ────────────────────────────────────

test('beds24 getConversations : membre messages=none -> 403', async () => {
  preparer({ profil: profilActif(), permissions: perms({ messages: 'none' }) })
  const res = reponse()
  await require('../api/beds24')(req({ method: 'POST', body: { action: 'getConversations', propertyId: BIEN_A.provider_property_id } }), res)
  assert.strictEqual(res.code, 403)
})

test('beds24 getConversations : membre messages=read -> passe', async () => {
  preparer({ profil: profilActif(), permissions: perms({ messages: 'read' }) })
  const res = reponse()
  await require('../api/beds24')(req({ method: 'POST', body: { action: 'getConversations', propertyId: BIEN_A.provider_property_id } }), res)
  assert.notStrictEqual(res.code, 403)
})

test('beds24 : bien d\'un AUTRE compte -> refus avant tout appel Beds24', async () => {
  const etat = preparer({ user: PROD })
  const res = reponse()
  await require('../api/beds24')(req({ method: 'POST', body: { action: 'getMessages', propertyId: BIEN_TIERS.provider_property_id } }), res)
  assert.strictEqual(res.code, 403)
  assert.deepStrictEqual(etat.appels.filter(a => a.url.includes('beds24.com')), [])
})

test('beds24 sendMessage : reservation d\'un AUTRE compte -> 403, aucun envoi', async () => {
  const etat = preparer({ user: PROD, snapshots: [
    { user_id: AUTRE, booking_id: '55501', property_id: BIEN_TIERS.provider_property_id, snapshot: {} }
  ] })
  const res = reponse()
  await require('../api/beds24')(req({ method: 'POST', body: {
    action: 'sendMessage', bookingId: '55501', message: 'coucou', propertyId: BIEN_A.provider_property_id } }), res)
  assert.strictEqual(res.code, 403)
  assert.deepStrictEqual(etat.appels.filter(a => a.url.includes('/messages')), [])
})

test('beds24 sendMessage : la RESERVATION fait foi, le propertyId client est ignore', async () => {
  // Membre limite au bien B. Il passe propertyId=B mais un bookingId du bien A :
  // la garde doit voir A (via le snapshot) et refuser.
  const etat = preparer({
    profil: profilActif(),
    permissions: perms({ messages: 'write', property_scope: 'selected',
                         property_ids: [BIEN_B.id], property_refs: [BIEN_B.provider_property_id] }),
    snapshots: [{ user_id: PROD, booking_id: '77701', property_id: BIEN_A.provider_property_id, snapshot: {} }]
  })
  const res = reponse()
  await require('../api/beds24')(req({ method: 'POST', body: {
    action: 'sendMessage', bookingId: '77701', message: 'coucou', propertyId: BIEN_B.provider_property_id } }), res)
  assert.strictEqual(res.code, 403)
  assert.deepStrictEqual(etat.appels.filter(a => a.url.includes('/messages')), [])
})

test('beds24 sendMessage : reservation HORS snapshot -> Beds24 tranche, propId different = 403', async () => {
  // Chemin de repli (reservation trop ancienne pour le snapshot). Le client
  // presente le bien B ; Beds24 dit que la reservation est sur le bien A.
  const etat = preparer({ user: PROD, snapshots: [], fetchStub: async (url) => {
    if (url.includes('/bookings?id=')) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 88801, propertyId: BIEN_A.provider_property_id }] }) }
    }
    return null
  } })
  const res = reponse()
  await require('../api/beds24')(req({ method: 'POST', body: {
    action: 'sendMessage', bookingId: '88801', message: 'coucou', propertyId: BIEN_B.provider_property_id } }), res)
  assert.strictEqual(res.code, 403)
  assert.deepStrictEqual(etat.appels.filter(a => a.url.includes('/bookings/messages')), [],
    'aucun message ne doit partir quand Beds24 contredit le bien annonce')
})

test('beds24 sendMessage : reservation HORS snapshot, propId concordant -> envoi', async () => {
  const etat = preparer({ user: PROD, snapshots: [], fetchStub: async (url) => {
    if (url.includes('/bookings?id=')) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 88801, propertyId: BIEN_A.provider_property_id }] }) }
    }
    return null
  } })
  const res = reponse()
  await require('../api/beds24')(req({ method: 'POST', body: {
    action: 'sendMessage', bookingId: '88801', message: 'coucou', propertyId: BIEN_A.provider_property_id } }), res)
  assert.notStrictEqual(res.code, 403)
  assert.ok(etat.appels.some(a => a.url.includes('/bookings/messages') && a.method === 'POST'),
    'le chemin legitime doit envoyer')
})

test('beds24 getProperties : un propertyId dans le body n\'ouvre PAS le compte du proprietaire', async () => {
  // Le piege : le membre est limite au bien A mais getProperties n'a pas de
  // filtre de sortie. Prendre son propertyId en compte faisait basculer la garde
  // sur le compte proprietaire, charger SA cle Beds24, et renvoyer TOUS ses biens.
  const etat = preparer({
    profil: profilActif(),
    permissions: perms({ reglages: 'read', messages: 'read', property_scope: 'selected',
                         property_ids: [BIEN_A.id], property_refs: [BIEN_A.provider_property_id] })
  })
  const res = reponse()
  await require('../api/beds24')(req({ method: 'POST', body: {
    action: 'getProperties', propertyId: BIEN_A.provider_property_id } }), res)
  // Le compte cible reste celui de l'appelant : c'est SA cle qui est cherchee,
  // il n'en a pas, donc 400 — et surtout aucun appel a Beds24.
  assert.strictEqual(res.code, 400)
  assert.deepStrictEqual(etat.appels.filter(a => a.url.includes('beds24.com')), [],
    'la cle du proprietaire ne doit jamais servir a lister ses biens pour un membre')
})

test('beds24 sendMessage : Beds24 en panne -> 502, jamais un 403 trompeur', async () => {
  // Un 403 ferait croire a un probleme de droits et couperait le titulaire de sa
  // conversation. On distingue la panne du refus.
  const etat = preparer({ user: PROD, snapshots: [], fetchStub: async (url) => {
    if (url.includes('/bookings?id=')) return { ok: false, status: 503, json: async () => ({}) }
    return null
  } })
  const res = reponse()
  await require('../api/beds24')(req({ method: 'POST', body: {
    action: 'sendMessage', bookingId: '88801', message: 'coucou', propertyId: BIEN_A.provider_property_id } }), res)
  assert.strictEqual(res.code, 502)
  assert.deepStrictEqual(etat.appels.filter(a => a.url.includes('/bookings/messages')), [])
})

test('beds24 sendMessage : Beds24 ignore le filtre id -> 404, aucun envoi', async () => {
  const etat = preparer({ user: PROD, snapshots: [], fetchStub: async (url) => {
    if (url.includes('/bookings?id=')) {
      // Reservation ARBITRAIRE : le filtre n'a pas ete applique.
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 11111, propertyId: BIEN_A.provider_property_id }] }) }
    }
    return null
  } })
  const res = reponse()
  await require('../api/beds24')(req({ method: 'POST', body: {
    action: 'sendMessage', bookingId: '88801', message: 'coucou', propertyId: BIEN_A.provider_property_id } }), res)
  assert.strictEqual(res.code, 404)
  assert.deepStrictEqual(etat.appels.filter(a => a.url.includes('/bookings/messages')), [])
})

test('calendar GET : un identifiant INCONNU ne casse pas les autres biens', async () => {
  // Un bien supprime encore present dans la liste d'un client ne doit pas faire
  // echouer le calendrier entier.
  preparer({ user: PROD })
  const res = reponse()
  await require('../api/calendar')(req({ query: {
    property_ids: `${BIEN_A.id},11111111-2222-3333-4444-555555555555`,
    start: '2026-09-01', end: '2026-09-30' } }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.properties.length, 1)
})

test('calendar GET : liste au-dela du plafond -> 400 avant toute verification', async () => {
  const etat = preparer({ user: PROD })
  const res = reponse()
  const liste = Array.from({ length: 250 }, (_, i) => `11111${String(i).padStart(3, '0')}-2222-3333-4444-555555555555`)
  await require('../api/calendar')(req({ query: { property_ids: liste.join(','), start: '2026-09-01', end: '2026-09-30' } }), res)
  assert.strictEqual(res.code, 400)
  void etat
})

test('calendar GET : user_id ne ressort pas dans la reponse', async () => {
  preparer({ user: PROD })
  const res = reponse()
  await require('../api/calendar')(req({ query: { property_ids: BIEN_A.id, start: '2026-09-01', end: '2026-09-30' } }), res)
  assert.ok(res.body.properties.every(p => p.user_id === undefined))
})

test('beds24 : action heritee d\'Object.prototype -> 400, pas 500', async () => {
  preparer({ user: PROD })
  const res = reponse()
  await require('../api/beds24')(req({ method: 'POST', body: { action: 'constructor' } }), res)
  assert.strictEqual(res.code, 400)
})

test('beds24 sendMessage : jeton invalide -> 401 avant toute lecture en base', async () => {
  // resoudreBooking interrogeait la base, et son 409 repondait pre-auth.
  const etat = preparer({ user: null, snapshots: [
    { user_id: PROD, booking_id: '99', property_id: BIEN_A.provider_property_id, snapshot: {} },
    { user_id: AUTRE, booking_id: '99', property_id: BIEN_TIERS.provider_property_id, snapshot: {} }
  ] })
  const res = reponse()
  await require('../api/beds24')(req({ method: 'POST', body: {
    action: 'sendMessage', bookingId: '99', message: 'x' } }), res)
  assert.strictEqual(res.code, 401, 'un 409 ici serait un oracle sur l\'existence du booking')
  void etat
})

test('beds24 sendMessage : sans propertyId ni snapshot -> Beds24 designe le bien', async () => {
  // Le front n'a pas toujours de reference de bien (messages.property_id NULL) :
  // exiger le bien renvoyait 400 sur un envoi qui fonctionnait.
  const etat = preparer({ user: PROD, snapshots: [], fetchStub: async (url) => {
    if (url.includes('/bookings?id=')) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 88801, propertyId: BIEN_A.provider_property_id }] }) }
    }
    return null
  } })
  const res = reponse()
  await require('../api/beds24')(req({ method: 'POST', body: {
    action: 'sendMessage', bookingId: '88801', message: 'coucou', propertyId: null } }), res)
  assert.notStrictEqual(res.code, 400)
  assert.ok(etat.appels.some(a => a.url.includes('/bookings/messages') && a.method === 'POST'))
})

test('beds24 sendMessage : bien derive de Beds24 mais HORS perimetre -> 403', async () => {
  const etat = preparer({
    profil: profilActif(),
    permissions: perms({ messages: 'write', property_scope: 'selected',
                         property_ids: [BIEN_B.id], property_refs: [BIEN_B.provider_property_id] }),
    snapshots: [],
    fetchStub: async (url) => {
      if (url.includes('/bookings?id=')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 88801, propertyId: BIEN_A.provider_property_id }] }) }
      }
      return null
    }
  })
  const res = reponse()
  await require('../api/beds24')(req({ method: 'POST', body: {
    action: 'sendMessage', bookingId: '88801', message: 'coucou', propertyId: null } }), res)
  assert.ok(res.code === 400 || res.code === 403, `attendu 400/403, recu ${res.code}`)
  assert.deepStrictEqual(etat.appels.filter(a => a.url.includes('/bookings/messages')), [])
})

test('beds24 sendMessage : propertyId PRESENT mais non materialise -> Beds24 tranche, pas 404', async () => {
  // Le front joint toujours un propertyId. Un bien retire de `properties` dont
  // les conversations restent affichees ne doit pas casser la reponse au voyageur.
  const etat = preparer({ user: PROD, snapshots: [], fetchStub: async (url) => {
    if (url.includes('/bookings?id=')) {
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 88801, propertyId: BIEN_A.provider_property_id }] }) }
    }
    return null
  } })
  const res = reponse()
  await require('../api/beds24')(req({ method: 'POST', body: {
    action: 'sendMessage', bookingId: '88801', message: 'coucou', propertyId: '404040' } }), res)
  assert.notStrictEqual(res.code, 404)
  assert.ok(etat.appels.some(a => a.url.includes('/bookings/messages') && a.method === 'POST'),
    `code=${res.code} body=${JSON.stringify(res.body)} appels=${JSON.stringify(etat.appels)}`)
})

test('beds24 sendMessage : bien Beds24 non materialise -> le titulaire passe', async () => {
  const etat = preparer({ user: PROD, snapshots: [], fetchStub: async (url) => {
    if (url.includes('/bookings?id=')) {
      // propId inconnu de `properties` : rien a resoudre.
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 88801, propertyId: '777777' }] }) }
    }
    return null
  } })
  const res = reponse()
  await require('../api/beds24')(req({ method: 'POST', body: {
    action: 'sendMessage', bookingId: '88801', message: 'coucou', propertyId: null } }), res)
  assert.notStrictEqual(res.code, 403)
  assert.ok(etat.appels.some(a => a.url.includes('/bookings/messages') && a.method === 'POST'))
})

test('messages : erreur du SECOND select -> 500, sans detail PostgREST', async () => {
  // Avant : l'erreur du snapshot etait avalee et l'endpoint renvoyait toutes les
  // conversations « Voyageur », sans dates ni statut, sans erreur visible.
  const DETAIL = 'column bookings_snapshot.property_id does not exist'
  preparer({ user: PROD, erreurSnapshot: DETAIL, messages: [
    { booking_id: '1', property_id: BIEN_A.provider_property_id, provider: 'beds24',
      sender: 'guest', direction: 'inbound', body: 'a', sent_at: new Date().toISOString() }
  ] })
  const res = reponse()
  await require('../api/messages')(req({ method: 'GET' }), res)
  assert.strictEqual(res.code, 500)
  assert.ok(!JSON.stringify(res.body).includes('does not exist'),
    'le detail PostgREST ne doit pas sortir vers le navigateur')
})

// ─── messages : collection filtree par le perimetre ──────────────────────────

test('messages : le compte cible est celui de l\'appelant, jamais un autre', async () => {
  // ⚠ CE QUE CE TEST CONSTATE, et qui n'est PAS un oubli : l'endpoint n'a aucun
  // identifiant client, donc aucune ressource ne designe un autre compte. Un
  // membre invite ne voit donc pas la messagerie du compte auquel il appartient
  // — il voit la sienne, qui est vide. Le choix du compte est l'etape 5.
  // La garde et le filtre de perimetre sont cables des maintenant pour que cette
  // etape n'ait pas a repasser sur l'endpoint ; ils sont INERTES tant qu'il n'y a
  // pas de selecteur de compte, et refuser un membre serait faux : c'est SON
  // compte qu'il interroge, sur lequel il est titulaire.
  const etat = preparer({
    profil: profilActif(), permissions: perms({ messages: 'none' }),
    messages: [{ booking_id: '1', property_id: BIEN_A.provider_property_id, provider: 'beds24',
                 sender: 'guest', direction: 'inbound', body: 'a', sent_at: new Date().toISOString() }]
  })
  const res = reponse()
  await require('../api/messages')(req({ method: 'GET' }), res)
  assert.strictEqual(res.code, 200)
  // Le point qui compte : la requete porte sur l'appelant.
  assert.ok(!etat.filtresIn.some(f => f.table === 'messages' && f.colonne !== 'property_id'))
})

test('messages : titulaire -> aucun filtre de perimetre', async () => {
  const etat = preparer({ user: PROD, messages: [
    { booking_id: '1', property_id: BIEN_A.provider_property_id, provider: 'beds24', sender: 'guest', direction: 'inbound', body: 'a', sent_at: new Date().toISOString() }
  ] })
  const res = reponse()
  await require('../api/messages')(req({ method: 'GET' }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.conversations.length, 1)
  assert.ok(!etat.filtresIn.some(f => f.table === 'messages'), 'le titulaire ne doit pas etre filtre')
})

test('messages : session absente -> 401', async () => {
  preparer({ user: null })
  const res = reponse()
  await require('../api/messages')(req({ method: 'GET' }), res)
  assert.strictEqual(res.code, 401)
})

// ─── refsDuPerimetre : le filtre de collection, teste la ou il vit ───────────
// L'endpoint messages ne peut pas encore l'exercer (pas de selecteur de compte).
// Le tester ici evite de faire croire, par un vert d'endpoint, a une protection
// qui ne s'applique pas encore.

test('refsDuPerimetre : titulaire -> null (aucun filtre)', () => {
  const { refsDuPerimetre } = require('../lib/permissions')
  assert.strictEqual(refsDuPerimetre({ userId: PROD, accountUserId: PROD }), null)
})

test('refsDuPerimetre : perimetre all -> null', () => {
  const { refsDuPerimetre } = require('../lib/permissions')
  assert.strictEqual(refsDuPerimetre({
    userId: MEMBRE, accountUserId: PROD,
    profil: profilActif(), permissions: perms({ property_scope: 'all' })
  }), null)
})

test('refsDuPerimetre : perimetre selected -> UUID et refs melanges', () => {
  const { refsDuPerimetre } = require('../lib/permissions')
  const r = refsDuPerimetre({
    userId: MEMBRE, accountUserId: PROD, profil: profilActif(),
    permissions: perms({ property_scope: 'selected', property_ids: [BIEN_B.id],
                         property_refs: [BIEN_B.provider_property_id] })
  })
  assert.deepStrictEqual(r.sort(), [BIEN_B.id, BIEN_B.provider_property_id].sort())
})

test('refsDuPerimetre : profil revoque -> liste VIDE, jamais null', () => {
  // ⚠ Le piege : `null` signifie « aucun filtre », donc TOUT. Un membre revoque
  // qui obtiendrait null verrait l'integralite du compte.
  const { refsDuPerimetre } = require('../lib/permissions')
  assert.deepStrictEqual(refsDuPerimetre({
    userId: MEMBRE, accountUserId: PROD,
    profil: profilActif({ active: false }), permissions: perms({ property_scope: 'selected' })
  }), [])
  assert.deepStrictEqual(refsDuPerimetre({
    userId: MEMBRE, accountUserId: PROD, profil: null, permissions: null
  }), [])
})

test('filtrePerimetreSql : aucun perimetre -> null (aucun filtre)', () => {
  const { filtrePerimetreSql } = require('../lib/permissions')
  assert.strictEqual(filtrePerimetreSql(null), null)
})

test('filtrePerimetreSql : le cas NULL est EXCLU par defaut', () => {
  // ⚠ Divergence assumee d'avec in_scope : une conversation voyageur sans bien
  // rattache ne doit pas apparaitre a un membre limite a un autre bien.
  const { filtrePerimetreSql } = require('../lib/permissions')
  const f = filtrePerimetreSql([BIEN_B.id, BIEN_B.provider_property_id])
  assert.ok(!f.includes('is.null'), f)
  assert.ok(f.includes(BIEN_B.provider_property_id))
})

test('filtrePerimetreSql : le cas NULL s\'inclut sur demande explicite', () => {
  const { filtrePerimetreSql } = require('../lib/permissions')
  const f = filtrePerimetreSql([BIEN_B.id], 'property_id', true)
  assert.ok(f.startsWith('property_id.is.null,'), f)
})

test('filtrePerimetreSql : perimetre vide -> chaine vide (echec FERME)', () => {
  const { filtrePerimetreSql } = require('../lib/permissions')
  assert.strictEqual(filtrePerimetreSql([]), '')
})

test('filtrePerimetreSql : reference au format refuse -> ecartee, pas d\'injection', () => {
  // Une virgule ou une parenthese ajouterait des filtres a l'expression .or().
  // Elle est ECARTEE : les biens sains du membre restent visibles.
  const { filtrePerimetreSql } = require('../lib/permissions')
  const f = filtrePerimetreSql(['ok', 'a),user_id.neq.x,(b'])
  assert.strictEqual(f, 'property_id.in.(ok)')
  assert.strictEqual(filtrePerimetreSql(['a),user_id.neq.x,(b']), '',
    'aucune reference sure -> echec ferme')
  assert.ok(!filtrePerimetreSql(['ok', 'avec espace']).includes('espace'))
})

// ─── channel-import-messages ─────────────────────────────────────────────────

test('import-messages : membre messages=read -> 403 (l\'import ECRIT)', async () => {
  preparer({ profil: profilActif(), permissions: perms({ messages: 'read' }) })
  const res = reponse()
  await require('../api/channel-import-messages')(req({ method: 'POST', body: { property_id: BIEN_A.id } }), res)
  assert.strictEqual(res.code, 403)
})

test('import-messages : bien d\'un AUTRE compte -> 403', async () => {
  preparer({ user: PROD })
  const res = reponse()
  await require('../api/channel-import-messages')(req({ method: 'POST', body: { property_id: BIEN_TIERS.id } }), res)
  assert.strictEqual(res.code, 403)
})
