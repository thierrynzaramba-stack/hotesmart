// tests/require-permission.test.js
// Garde de droits en tete d'endpoint. Les endpoints ecrivent en service key,
// qui contourne la RLS : ce helper est leur seule defense.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const PROD = 'compte-prod', AUTRE = 'compte-autre', MEMBRE = 'membre'
// Identifiants REALISTES : properties.id est un uuid Postgres, et
// provider_property_id un propId Beds24 numerique ou un UUID Channex. Un stub
// avec 'uuid-bulle' masquerait le piege du type uuid (cf. resoudreBien).
const BIEN_PROD  = { id: '58001ed1-e194-498a-94b4-606eece8f33d', user_id: PROD,  name: 'La bulle',   provider: 'beds24',  provider_property_id: '209413' }
const BIEN_AUTRE = { id: 'e14e25f6-0000-4000-8000-000000000001', user_id: AUTRE, name: 'Bien tiers', provider: 'channex', provider_property_id: '0544fd9a' }

function charger({ user = MEMBRE, biens = [BIEN_PROD, BIEN_AUTRE], profil = null, permissions = null }) {
  const client = {
    auth: { getUser: async () => (user ? { data: { user: { id: user } }, error: null } : { data: null, error: { message: 'invalide' } }) },
    from(nom) {
      const q = {
        _f: {},
        select() { return q },
        eq(c, v) { q._f[c] = v; return q },
        or(expr) { q._or = expr; return q },
        maybeSingle: async () => {
          if (nom === 'properties') {
            // Deux chemins : `.or(id.eq…,provider_property_id.eq…)` pour un UUID,
            // `.eq('provider_property_id', …)` sinon — la branche `id` ferait
            // echouer la requete sur une colonne de type uuid.
            const m = String(q._or || '').match(/id\.eq\.([^,]+),provider_property_id\.eq\.(.+)/)
            const v = m ? m[1] : q._f.provider_property_id
            if (v == null) return { data: null }
            return { data: biens.find(b => b.id === v || b.provider_property_id === v) || null }
          }
          if (nom === 'profiles') {
            if (!profil) return { data: null }
            const ok = profil.account_user_id === q._f.account_user_id && profil.member_user_id === q._f.member_user_id
            return { data: ok ? profil : null }
          }
          if (nom === 'profile_permissions') return { data: permissions }
          return { data: null }
        }
      }
      return q
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  delete require.cache[require.resolve('../lib/require-permission')]
  return require('../lib/require-permission')
}

const req = (h = { authorization: 'Bearer tok' }) => ({ headers: h, query: {} })
function reponse() {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  return r
}
const profilActif = (o = {}) => ({ id: 'p1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-09-01', ...o })
const perms = (o = {}) => ({ profile_id: 'p1', property_scope: 'all', property_ids: [], property_refs: [], ...o })

// ─── Session ─────────────────────────────────────────────────────────────────

test('sans token -> 401', async () => {
  const { requirePermission } = charger({})
  const res = reponse()
  const r = await requirePermission(req({}), res, { domaine: 'reglages' })
  assert.strictEqual(r.ok, false); assert.strictEqual(res.code, 401)
})

test('session invalide -> 401', async () => {
  const { requirePermission } = charger({ user: null })
  const res = reponse()
  await requirePermission(req(), res, { domaine: 'reglages' })
  assert.strictEqual(res.code, 401)
})

// ─── LE COMPTE CIBLE VIENT DE LA RESSOURCE ──────────────────────────────────

test('bien d\'un AUTRE compte -> 403, meme avec tous les droits sur le sien', async () => {
  // Le membre a « reglages=write » sur le compte PROD. Il demande un bien du
  // compte AUTRE : le compte cible devient AUTRE, ou il n'a aucun profil.
  const { requirePermission } = charger({
    profil: profilActif(), permissions: perms({ reglages: 'write' })
  })
  const res = reponse()
  const r = await requirePermission(req(), res, { domaine: 'reglages', bien: '0544fd9a' })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(res.code, 403)
})

test('bien inexistant -> 404, sans rien reveler', async () => {
  const { requirePermission } = charger({ profil: profilActif(), permissions: perms({ reglages: 'read' }) })
  const res = reponse()
  const r = await requirePermission(req(), res, { domaine: 'reglages', bien: 'nexiste-pas' })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(res.code, 404)
  assert.deepStrictEqual(Object.keys(res.body), ['error'])
})

test('bien requis mais absent -> 400', async () => {
  const { requirePermission } = charger({ profil: profilActif(), permissions: perms() })
  const res = reponse()
  await requirePermission(req(), res, { domaine: 'reglages', bien: '', bienRequis: true })
  assert.strictEqual(res.code, 400)
})

// ─── Domaine et niveau ───────────────────────────────────────────────────────

test('domaine autorise en lecture -> passe', async () => {
  const { requirePermission } = charger({ profil: profilActif(), permissions: perms({ reglages: 'read' }) })
  const res = reponse()
  const r = await requirePermission(req(), res, { domaine: 'reglages', bien: '209413' })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.accountUserId, PROD)
  assert.strictEqual(r.bien.provider_property_id, '209413')
})

test('lecture accordee mais ECRITURE demandee -> 403', async () => {
  const { requirePermission } = charger({ profil: profilActif(), permissions: perms({ reglages: 'read' }) })
  const res = reponse()
  const r = await requirePermission(req(), res, { domaine: 'reglages', niveau: 'write', bien: '209413' })
  assert.strictEqual(r.ok, false); assert.strictEqual(res.code, 403)
})

test('domaine non accorde -> 403', async () => {
  const { requirePermission } = charger({ profil: profilActif(), permissions: perms({ messages: 'write' }) })
  const res = reponse()
  await requirePermission(req(), res, { domaine: 'reglages', bien: '209413' })
  assert.strictEqual(res.code, 403)
})

test('aucun profil sur le compte cible -> 403', async () => {
  const { requirePermission } = charger({ profil: null, permissions: null })
  const res = reponse()
  await requirePermission(req(), res, { domaine: 'reglages', bien: '209413' })
  assert.strictEqual(res.code, 403)
})

test('profil inactif -> 403', async () => {
  const { requirePermission } = charger({ profil: profilActif({ active: false }), permissions: perms({ reglages: 'write' }) })
  const res = reponse()
  await requirePermission(req(), res, { domaine: 'reglages', bien: '209413' })
  assert.strictEqual(res.code, 403)
})

// ─── Perimetre ───────────────────────────────────────────────────────────────

test('bien HORS perimetre -> 403 (identifiant client revalide serveur)', async () => {
  const { requirePermission } = charger({
    profil: profilActif(),
    permissions: perms({ reglages: 'read', property_scope: 'selected', property_ids: ['un-autre'], property_refs: ['999'] })
  })
  const res = reponse()
  const r = await requirePermission(req(), res, { domaine: 'reglages', bien: '209413' })
  assert.strictEqual(r.ok, false); assert.strictEqual(res.code, 403)
})

test('bien DANS le perimetre, designe par son UUID ou par sa ref -> passe', async () => {
  for (const ref of ['58001ed1-e194-498a-94b4-606eece8f33d', '209413']) {
    const { requirePermission } = charger({
      profil: profilActif(),
      permissions: perms({ reglages: 'read', property_scope: 'selected', property_ids: ['58001ed1-e194-498a-94b4-606eece8f33d'], property_refs: ['209413'] })
    })
    const res = reponse()
    const r = await requirePermission(req(), res, { domaine: 'reglages', bien: ref })
    assert.strictEqual(r.ok, true, `designe par ${ref}`)
  }
})

// ─── Titulaire ───────────────────────────────────────────────────────────────

test('le TITULAIRE passe partout sur son compte, sans profil', async () => {
  const { requirePermission } = charger({ user: PROD, profil: null, permissions: null })
  const res = reponse()
  const r = await requirePermission(req(), res, { domaine: 'reglages', niveau: 'write', bien: '209413' })
  assert.strictEqual(r.ok, true)
})

test('domaine « titulaire » AVEC un bien : un membre est refuse, meme tout-droits', async () => {
  // Le compte cible vient du BIEN : le membre n'en est pas titulaire.
  const { requirePermission } = charger({
    profil: profilActif(), permissions: perms({ reglages: 'write', facturation: 'write' })
  })
  const res = reponse()
  const r = await requirePermission(req(), res, { domaine: 'titulaire', bien: '209413' })
  assert.strictEqual(r.ok, false); assert.strictEqual(res.code, 403)
})

test('domaine « titulaire » SANS bien ne filtre rien — portee a connaitre', async () => {
  // Sans ressource, le compte cible est celui de l'appelant : il en est
  // titulaire par definition. Ce mode ne protege donc une ressource GLOBALE
  // que si l'endpoint s'abstient par ailleurs de renvoyer les donnees d'autrui
  // (cf. api/diagnostic.js check=channel).
  const { requirePermission } = charger({ profil: profilActif(), permissions: perms() })
  const res = reponse()
  const r = await requirePermission(req(), res, { domaine: 'titulaire' })
  assert.strictEqual(r.ok, true, 'documente la portee reelle, ce n\'est pas une faille')
})

test('domaine « titulaire » : le titulaire passe', async () => {
  const { requirePermission } = charger({ user: PROD })
  const res = reponse()
  const r = await requirePermission(req(), res, { domaine: 'titulaire' })
  assert.strictEqual(r.ok, true)
})

test('domaine inconnu -> 500, jamais un passage silencieux', async () => {
  const { requirePermission } = charger({ user: PROD })
  const res = reponse()
  const r = await requirePermission(req(), res, { domaine: 'inexistant' })
  assert.strictEqual(r.ok, false); assert.strictEqual(res.code, 500)
})

// ─── Resolution par RESERVATION (cas api/channel-message.js) ────────────────
// Un bookingId venant du client ne doit pas permettre d'agir sur la reservation
// d'un autre compte : c'est la reservation qui designe le compte, pas l'appelant.

function chargerAvecBookings({ user = MEMBRE, bookings = [], biens = [BIEN_PROD, BIEN_AUTRE], profil = null, permissions = null }) {
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: user } }, error: null }) },
    from(nom) {
      const q = {
        _f: {},
        select() { return q },
        eq(c, v) { q._f[c] = v; return q },
        or(expr) { q._or = expr; return q },
        // bookings_snapshot est lu SANS maybeSingle (booking_id n'est unique que
        // par (user_id, booking_id)) : la requete est awaitee directement.
        then(res2, rej) {
          if (nom !== 'bookings_snapshot') return Promise.resolve({ data: [], error: null }).then(res2, rej)
          return Promise.resolve({ data: bookings.filter(b => b.booking_id === q._f.booking_id), error: null }).then(res2, rej)
        },
        maybeSingle: async () => {
          if (nom === 'properties') {
            // Deux chemins : `.or(id.eq…,provider_property_id.eq…)` pour un UUID,
            // `.eq('provider_property_id', …)` sinon — la branche `id` ferait
            // echouer la requete sur une colonne de type uuid.
            const m = String(q._or || '').match(/id\.eq\.([^,]+),provider_property_id\.eq\.(.+)/)
            const v = m ? m[1] : q._f.provider_property_id
            if (v == null) return { data: null }
            return { data: biens.find(b => b.id === v || b.provider_property_id === v) || null }
          }
          if (nom === 'profiles') {
            if (!profil) return { data: null }
            const ok = profil.account_user_id === q._f.account_user_id && profil.member_user_id === q._f.member_user_id
            return { data: ok ? profil : null }
          }
          if (nom === 'profile_permissions') return { data: permissions }
          return { data: null }
        }
      }
      return q
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  delete require.cache[require.resolve('../lib/require-permission')]
  return require('../lib/require-permission')
}

const BOOK_PROD  = { user_id: PROD,  booking_id: '77', property_id: '209413' }
const BOOK_AUTRE = { user_id: AUTRE, booking_id: '99', property_id: '0544fd9a' }

test('reservation d\'un AUTRE compte -> 403, meme avec messages=write sur le sien', async () => {
  const { requirePermission } = chargerAvecBookings({
    bookings: [BOOK_PROD, BOOK_AUTRE],
    profil: profilActif(), permissions: perms({ messages: 'write' })
  })
  const res = reponse()
  const r = await requirePermission(req(), res, { domaine: 'messages', niveau: 'write', booking: '99' })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(res.code, 403)
})

test('reservation du compte cible + droit -> passe, et resout le bien', async () => {
  const { requirePermission } = chargerAvecBookings({
    bookings: [BOOK_PROD], profil: profilActif(), permissions: perms({ messages: 'write' })
  })
  const res = reponse()
  const r = await requirePermission(req(), res, { domaine: 'messages', niveau: 'write', booking: '77' })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.accountUserId, PROD)
  assert.strictEqual(r.booking.property_id, '209413')
})

test('reservation inexistante -> 404', async () => {
  const { requirePermission } = chargerAvecBookings({ bookings: [], profil: profilActif(), permissions: perms({ messages: 'write' }) })
  const res = reponse()
  const r = await requirePermission(req(), res, { domaine: 'messages', niveau: 'write', booking: 'inconnu' })
  assert.strictEqual(r.ok, false); assert.strictEqual(res.code, 404)
})

test('reservation requise mais absente -> 400', async () => {
  const { requirePermission } = chargerAvecBookings({ profil: profilActif(), permissions: perms({ messages: 'write' }) })
  const res = reponse()
  await requirePermission(req(), res, { domaine: 'messages', niveau: 'write', booking: null, bookingRequis: true })
  assert.strictEqual(res.code, 400)
})

test('LA RESERVATION FAIT FOI : le bien fourni par le client est IGNORE', async () => {
  // Le contournement ferme : un membre limite au bien A passait `bien = A` pour
  // agir sur une reservation du bien B. La garde validait A, l'action portait
  // sur B — et recordMessage attribuait le message au mauvais fil.
  const { requirePermission } = chargerAvecBookings({
    bookings: [BOOK_PROD], profil: profilActif(), permissions: perms({ messages: 'write' })
  })
  const res = reponse()
  const r = await requirePermission(req(), res, {
    domaine: 'messages', niveau: 'write', booking: '77', bien: '0544fd9a'
  })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.booking.property_id, '209413', 'la cible vient de la reservation')
})

test('CONTOURNEMENT FERME : perimetre limite au bien A, reservation du bien B -> 403', async () => {
  const { requirePermission } = chargerAvecBookings({
    bookings: [{ user_id: PROD, booking_id: '88', property_id: '169567' }],
    profil: profilActif(),
    // Perimetre : le bien 209413 seulement. La reservation porte sur 169567.
    permissions: perms({ messages: 'write', property_scope: 'selected',
                         property_ids: ['58001ed1-e194-498a-94b4-606eece8f33d'], property_refs: ['209413'] })
  })
  const res = reponse()
  const r = await requirePermission(req(), res, {
    domaine: 'messages', niveau: 'write', booking: '88', bien: '209413'   // <- le client tente A
  })
  assert.strictEqual(r.ok, false, 'le bien client ne doit pas servir a passer la garde')
  assert.strictEqual(res.code, 403)
})

test('meme booking_id sur DEUX comptes -> 409, jamais un choix arbitraire', async () => {
  // booking_id n'est unique que par (user_id, booking_id).
  const { requirePermission } = chargerAvecBookings({
    bookings: [BOOK_PROD, { user_id: AUTRE, booking_id: '77', property_id: '0544fd9a' }],
    profil: profilActif(), permissions: perms({ messages: 'write' })
  })
  const res = reponse()
  const r = await requirePermission(req(), res, { domaine: 'messages', niveau: 'write', booking: '77' })
  assert.strictEqual(r.ok, false); assert.strictEqual(res.code, 409)
})

test('reservation SANS bien rattache -> 409 (sinon le perimetre ne filtre rien)', async () => {
  const { requirePermission } = chargerAvecBookings({
    bookings: [{ user_id: PROD, booking_id: '77', property_id: null }],
    profil: profilActif(),
    permissions: perms({ messages: 'write', property_scope: 'selected', property_refs: ['209413'] })
  })
  const res = reponse()
  const r = await requirePermission(req(), res, { domaine: 'messages', niveau: 'write', booking: '77' })
  assert.strictEqual(r.ok, false); assert.strictEqual(res.code, 409)
})

test('bien de la reservation NON materialise -> passe, la reference TEXTE suffit', async () => {
  // Un snapshot peut porter un property_id absent de `properties` (bien supprime).
  // Bloquer serait une regression : l'envoi fonctionnait avant.
  const { requirePermission } = chargerAvecBookings({
    bookings: [{ user_id: PROD, booking_id: '77', property_id: 'disparu-42' }],
    biens: [],
    profil: profilActif(), permissions: perms({ messages: 'write' })
  })
  const res = reponse()
  const r = await requirePermission(req(), res, { domaine: 'messages', niveau: 'write', booking: '77' })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.bien, null)
})

test('identifiant de bien au format dangereux -> refuse (injection PostgREST)', async () => {
  // La valeur client est interpolee dans un filtre .or(...) : une virgule ou une
  // parenthese y injecterait des filtres supplementaires.
  const { requirePermission } = charger({ profil: profilActif(), permissions: perms({ reglages: 'read' }) })
  const res = reponse()
  const r = await requirePermission(req(), res, { domaine: 'reglages', bien: '209413,user_id.neq.0' })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(res.code, 404, 'refuse avant toute requete')
})

test('reservation hors perimetre -> 403', async () => {
  const { requirePermission } = chargerAvecBookings({
    bookings: [BOOK_PROD], profil: profilActif(),
    permissions: perms({ messages: 'write', property_scope: 'selected', property_ids: ['autre'], property_refs: ['999'] })
  })
  const res = reponse()
  const r = await requirePermission(req(), res, { domaine: 'messages', niveau: 'write', booking: '77' })
  assert.strictEqual(r.ok, false); assert.strictEqual(res.code, 403)
})
