// tests/compte-courant.test.js
// Etape 5, socle : l'en-tete X-Compte et l'action `mes_comptes`.
//
// ⚠ CE QUI SE JOUE ICI. `X-Compte` vient du CLIENT. Il ne designe rien par
// lui-meme : il DEMANDE. Sans revalidation, poser un en-tete suffirait a
// travailler sur le compte de n'importe qui — la faille la plus grave que ce
// chantier pourrait introduire.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const PROD   = '85e3a0ef-75bd-4c11-a3b7-e2811067dc36'
const AUTRE  = '9f3c0000-3333-4444-9999-bbbbbbbbbbbb'
const MEMBRE = '18920ead-1111-2222-3333-444444444444'

const BIEN_PROD = { id: '58001ed1-e194-498a-94b4-606eece8f33d', user_id: PROD,
                    name: 'La bulle', provider: 'beds24', provider_property_id: '209413' }

const MODULES = ['../lib/require-permission', '../lib/permissions', '../api/membres']

// `liens` : lignes profiles reliant un membre a un compte.
function preparer ({ user = MEMBRE, liens = [], permissions = null, erreurProfiles = false } = {}) {
  const etat = { requetes: [] }
  const client = {
    auth: { getUser: async () => (user ? { data: { user: { id: user, email: 'x@y.fr' } }, error: null }
                                       : { data: null, error: { message: 'x' } }) },
    from (nom) {
      const q = {
        _f: {},
        select () { return q }, eq (c, v) { q._f[c] = v; return q },
        or (e) { q._or = e; return q }, in () { return q }, not () { return q },
        order () { return q }, limit () { return q },
        single: async () => rep(nom, q), maybeSingle: async () => rep(nom, q),
        then (ok, ko) { return Promise.resolve(rep(nom, q, true)).then(ok, ko) }
      }
      function rep (nom, q, tableau = false) {
        etat.requetes.push({ table: nom, filtres: { ...q._f } })
        if (nom === 'profiles') {
          if (erreurProfiles) return { data: null, error: { message: 'timeout' } }
          const rows = liens.filter(l =>
            (q._f.account_user_id == null || l.account_user_id === q._f.account_user_id) &&
            (q._f.member_user_id  == null || l.member_user_id  === q._f.member_user_id) &&
            (q._f.is_owner        == null || !!l.is_owner === q._f.is_owner))
          return { data: tableau ? rows : (rows[0] || null), error: null }
        }
        if (nom === 'profile_permissions') return { data: permissions, error: null }
        if (nom === 'properties') {
          // resoudreBien interroge `.or(id.eq.X,provider_property_id.eq.X)` pour
          // une valeur UUID : le double doit lire ce filtre, sinon il repond
          // « bien introuvable » et le test verifie autre chose que son intention.
          const m = String(q._or || '').match(/id\.eq\.([^,]+),provider_property_id\.eq\.(.+)/)
          const val = m ? m[1] : (q._f.id ?? q._f.provider_property_id)
          const ok = val === BIEN_PROD.id || val === BIEN_PROD.provider_property_id
          return { data: tableau ? (ok ? [BIEN_PROD] : []) : (ok ? BIEN_PROD : null), error: null }
        }
        return { data: tableau ? [] : null, error: null }
      }
      return q
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
  return etat
}

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = () => {}
  return r
}
const req = (compte, o = {}) => ({
  method: 'POST',
  headers: { authorization: 'Bearer tok', ...(compte ? { 'x-compte': compte } : {}) },
  query: {}, body: {}, ...o
})
const membreActif = (compte = PROD) => ({
  id: 'p1', account_user_id: compte, member_user_id: MEMBRE,
  is_owner: false, active: true, accepted_at: '2026-09-01', first_name: 'Test'
})
const droits = (o = {}) => ({ profile_id: 'p1', property_scope: 'all', property_ids: [], property_refs: [],
                              reservations: 'read', menages: 'read', prestataires: 'none', messages: 'none',
                              avis: 'none', reglages: 'none', facturation: 'none', equipe: 'none',
                              self_availability: 'none', self_view_reviews: false, ...o })

// ─── compteDemande : la revalidation, testee DIRECTEMENT ────────────────────
//
// ⚠ POURQUOI DIRECTEMENT, et pas seulement a travers requirePermission.
// J'ai d'abord ecrit ces cas au niveau de la garde complete, et ils passaient —
// mais pour la MAUVAISE RAISON : le refus venait de `niveauEffectif` (aucun
// profil sur le compte vise), pas de la revalidation de l'en-tete. Retirer
// entierement `compteDemande` ne faisait echouer aucun test.
//
// La revalidation est donc une DEFENSE EN PROFONDEUR, pas l'unique barriere —
// et c'est bien ainsi. Mais un test doit prouver ce qu'il pretend : ceux-ci
// appellent la fonction elle-meme.

test('compteDemande : sans en-tete -> le compte de l\'appelant', async () => {
  preparer({ liens: [] })
  const { compteDemande } = require('../lib/require-permission')
  const r = await compteDemande({ headers: {} }, MEMBRE)
  assert.deepStrictEqual(r, { compte: MEMBRE })
})

test('compteDemande : son propre compte -> accepte sans verification', async () => {
  const etat = preparer({ liens: [] })
  const { compteDemande } = require('../lib/require-permission')
  const r = await compteDemande({ headers: { 'x-compte': MEMBRE } }, MEMBRE)
  assert.deepStrictEqual(r, { compte: MEMBRE })
  assert.ok(!etat.requetes.some(q => q.table === 'profiles'), 'aucune lecture inutile')
})

test('compteDemande : membre ACTIF et accepte -> compte accorde', async () => {
  preparer({ liens: [membreActif()] })
  const { compteDemande } = require('../lib/require-permission')
  const r = await compteDemande({ headers: { 'x-compte': PROD } }, MEMBRE)
  assert.deepStrictEqual(r, { compte: PROD })
})

test('compteDemande : AUCUN lien avec ce compte -> refus', async () => {
  // ⚠ La faille que la fonction ferme : poser un en-tete ne suffit pas.
  preparer({ liens: [] })
  const { compteDemande } = require('../lib/require-permission')
  const r = await compteDemande({ headers: { 'x-compte': PROD } }, MEMBRE)
  assert.strictEqual(r.refus, true)
  assert.strictEqual(r.compte, undefined)
})

test('compteDemande : profil DESACTIVE -> refus', async () => {
  // C'est ce qui rend la desactivation immediate : un onglet deja ouvert garde
  // le compte en memoire, le serveur refuse quand meme.
  preparer({ liens: [{ ...membreActif(), active: false }] })
  const { compteDemande } = require('../lib/require-permission')
  const r = await compteDemande({ headers: { 'x-compte': PROD } }, MEMBRE)
  assert.strictEqual(r.refus, true)
})

test('compteDemande : invitation NON ACCEPTEE -> refus', async () => {
  preparer({ liens: [{ ...membreActif(), accepted_at: null }] })
  const { compteDemande } = require('../lib/require-permission')
  const r = await compteDemande({ headers: { 'x-compte': PROD } }, MEMBRE)
  assert.strictEqual(r.refus, true)
})

test('compteDemande : format invalide -> refus, aucune requete', async () => {
  const etat = preparer({ liens: [membreActif()] })
  const { compteDemande } = require('../lib/require-permission')
  const r = await compteDemande({ headers: { 'x-compte': "' or 1=1--" } }, MEMBRE)
  assert.strictEqual(r.refus, true)
  assert.ok(!etat.requetes.some(q => q.table === 'profiles'))
})

test('compteDemande : une PANNE de lecture n\'accorde pas le compte', async () => {
  // Une panne n'est pas une absence : elle ne doit ni accorder, ni se faire
  // passer pour un refus de droits.
  preparer({ liens: [membreActif()], erreurProfiles: true })
  const { compteDemande } = require('../lib/require-permission')
  const r = await compteDemande({ headers: { 'x-compte': PROD } }, MEMBRE)
  assert.strictEqual(r.erreur, true)
  assert.strictEqual(r.compte, undefined)
})

// ─── La garde complete ──────────────────────────────────────────────────────

test('X-Compte : un membre ACTIF obtient bien le compte demande', async () => {
  preparer({ liens: [membreActif()], permissions: droits() })
  const { requirePermission } = require('../lib/require-permission')
  const res = reponse()
  const g = await requirePermission(req(PROD), res, {
    domaine: 'reservations', niveau: 'read', compteDelegue: true })
  assert.strictEqual(g.ok, true)
  assert.strictEqual(g.accountUserId, PROD, 'le compte demande, pas celui de l\'appelant')
})

test('X-Compte : compte etranger -> 403 (deux barrieres, une seule suffit)', async () => {
  preparer({ liens: [] })
  const { requirePermission } = require('../lib/require-permission')
  const res = reponse()
  const g = await requirePermission(req(PROD), res, {
    domaine: 'reservations', niveau: 'read', compteDelegue: true })
  assert.strictEqual(g.ok, false)
  assert.strictEqual(res.code, 403)
})

test('SANS X-Compte : rien ne change — non-regression de l\'hote seul', async () => {
  preparer({ user: PROD, liens: [] })
  const { requirePermission } = require('../lib/require-permission')
  const res = reponse()
  const g = await requirePermission(req(null), res, { domaine: 'reservations', niveau: 'read' })
  assert.strictEqual(g.ok, true)
  assert.strictEqual(g.accountUserId, PROD)
})

test('LA RESSOURCE PRIME sur X-Compte', async () => {
  // ⚠ Un en-tete ne doit jamais contredire un bien ou une reservation : c'est la
  // regle « le compte cible vient de la ressource ».
  preparer({ user: PROD, liens: [membreActif(AUTRE)] })
  const { requirePermission } = require('../lib/require-permission')
  const res = reponse()
  const g = await requirePermission(req(AUTRE), res, {
    domaine: 'reservations', niveau: 'read', bien: BIEN_PROD.id, bienRequis: true,
    compteDelegue: true })
  assert.strictEqual(g.ok, true)
  assert.strictEqual(g.accountUserId, PROD, 'le compte vient du BIEN, pas de l\'en-tete')
})

test('X-Compte : les droits appliques sont ceux du compte VISE', async () => {
  preparer({ liens: [membreActif()], permissions: droits({ reservations: 'read' }) })
  const { requirePermission } = require('../lib/require-permission')
  const res = reponse()
  const ecriture = await requirePermission(req(PROD), res, {
    domaine: 'reservations', niveau: 'write', compteDelegue: true })
  assert.strictEqual(ecriture.ok, false, 'read ne donne pas write')
  assert.strictEqual(res.code, 403)
})

test('OPT-IN : sans `compteDelegue`, l\'en-tete est IGNORE', async () => {
  // ⚠ LA FAILLE QUE CE DEFAUT FERME. Honorer X-Compte partout faisait basculer
  // d'un coup tous les endpoints sans `bien` sur le compte du titulaire, y
  // compris ceux que personne n'a audites pour la delegation. Le pire :
  // api/serrures.js `saveConfig` fait `upsert({ user_id: accountUserId,
  // seam_api_key })` — un membre `reglages:write` aurait ECRASE LA CLE SEAM DU
  // TITULAIRE. Un endpoint ne devient delegable qu'apres avoir ete relu pour ca.
  preparer({ liens: [membreActif()], permissions: droits({ reglages: 'write' }) })
  const { requirePermission } = require('../lib/require-permission')
  const res = reponse()
  const g = await requirePermission(req(PROD), res, { domaine: 'reglages', niveau: 'write' })
  assert.strictEqual(g.ok, true, 'il agit sur SON compte, ou il est titulaire')
  assert.strictEqual(g.accountUserId, MEMBRE, 'l\'en-tete n\'a PAS bascule le compte')
})

test('OPT-IN : le defaut protege les endpoints non audites', async () => {
  // Meme scenario, domaine different : la protection ne depend pas du domaine.
  preparer({ liens: [membreActif()], permissions: droits({ messages: 'write' }) })
  const { requirePermission } = require('../lib/require-permission')
  const res = reponse()
  const g = await requirePermission(req(PROD), res, { domaine: 'messages', niveau: 'write' })
  assert.strictEqual(g.accountUserId, MEMBRE)
})

// ─── Le filtre de perimetre et le piege UUID ────────────────────────────────
//
// ⚠ Ces tests appellent l'ENDPOINT et inspectent le filtre qu'il emet. Une
// premiere version recopiait la logique de construction dans le test : elle
// passait quoi qu'il arrive, et n'aurait rien vu du bug.

function preparerChannelProperty ({ perimetre }) {
  const emis = { filtres: [] }
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: MEMBRE } }, error: null }) },
    from (nom) {
      const q = {
        _f: {},
        select () { return q }, eq (c, v) { q._f[c] = v; return q },
        or (e) { emis.filtres.push(e); return q },
        in () { return q }, not () { return q }, order () { return q }, limit () { return q },
        single: async () => rep(nom, q), maybeSingle: async () => rep(nom, q),
        then (ok, ko) { return Promise.resolve(rep(nom, q, true)).then(ok, ko) }
      }
      function rep (nom, q, tableau = false) {
        if (nom === 'profiles') {
          const ligne = { id: 'p1', account_user_id: PROD, member_user_id: MEMBRE,
                          is_owner: false, active: true, accepted_at: '2026-09-01' }
          return { data: tableau ? [ligne] : ligne, error: null }
        }
        if (nom === 'profile_permissions') {
          return { data: { profile_id: 'p1', property_scope: 'selected',
                           property_ids: perimetre.filter(r => r.includes('-')),
                           property_refs: perimetre.filter(r => !r.includes('-')),
                           reservations: 'read', menages: 'none', prestataires: 'none',
                           messages: 'none', avis: 'none', reglages: 'none',
                           facturation: 'none', equipe: 'none',
                           self_availability: 'none', self_view_reviews: false }, error: null }
        }
        if (nom === 'api_keys') return { data: null, error: null }
        return { data: tableau ? [] : null, error: null }
      }
      return q
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of [...MODULES, '../api/channel-property']) {
    try { delete require.cache[require.resolve(mod)] } catch {}
  }
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })
  return emis
}

const reqGet = (compte) => ({
  method: 'GET',
  headers: { authorization: 'Bearer tok', 'x-compte': compte },
  query: {}, body: {}
})

test('PERIMETRE : la branche id.in ne recoit QUE des UUID', async () => {
  // ⚠ LE PIEGE UUID, POUR LA TROISIEME FOIS DANS CE DEPOT. `properties.id` est
  // de type uuid : y passer « 209413 » fait echouer la requete ENTIERE en 22P02,
  // pas renvoyer zero ligne. Le membre voyait « Erreur de chargement des biens »
  // et croyait a une panne — et refsDuPerimetre melange DELIBEREMENT les deux
  // formes.
  const emis = preparerChannelProperty({ perimetre: [BIEN_PROD.id, '209413'] })
  const res = reponse()
  await require('../api/channel-property')(reqGet(PROD), res)

  const filtre = emis.filtres.find(f => f.includes('provider_property_id.in.'))
  assert.ok(filtre, 'un filtre de perimetre doit etre emis')
  const branche = filtre.match(/(?:^|,)id\.in\.\(([^)]*)\)/)
  if (branche) {
    for (const v of branche[1].split(',')) {
      assert.match(v, /^[0-9a-f]{8}-[0-9a-f]{4}-/i, `valeur non-UUID dans id.in : ${v}`)
    }
  }
  assert.ok(filtre.includes('209413'), 'la reference canal doit rester dans provider_property_id')
})

test('PERIMETRE : perimetre 100% references canal -> aucune branche id', async () => {
  const emis = preparerChannelProperty({ perimetre: ['209413', '169567'] })
  const res = reponse()
  await require('../api/channel-property')(reqGet(PROD), res)
  const filtre = emis.filtres.find(f => f.includes('provider_property_id.in.'))
  assert.ok(filtre)
  assert.ok(!/(?:^|,)id\.in\./.test(filtre),
    'aucune branche id quand le perimetre ne contient que des references canal')
})

// ─── mes_comptes ────────────────────────────────────────────────────────────

test('mes_comptes : un hote seul ne recoit QUE son compte', async () => {
  // Un seul compte -> pas de selecteur affiche. Non-regression absolue.
  preparer({ user: PROD, liens: [{ account_user_id: PROD, member_user_id: PROD, is_owner: true, first_name: 'Thierry' }] })
  const res = reponse()
  await require('../api/membres')(req(null, { body: { action: 'mes_comptes' } }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.comptes.length, 1)
  assert.strictEqual(res.body.comptes[0].titulaire, true)
})

test('mes_comptes : un membre recoit son compte ET celui ou il est invite', async () => {
  preparer({ user: MEMBRE, liens: [
    { account_user_id: MEMBRE, member_user_id: MEMBRE, is_owner: true, first_name: 'Test' },
    { account_user_id: PROD,   member_user_id: PROD,   is_owner: true, first_name: 'Thierry' },
    membreActif()
  ] })
  const res = reponse()
  await require('../api/membres')(req(null, { body: { action: 'mes_comptes' } }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.comptes.length, 2)
  assert.strictEqual(res.body.comptes[0].titulaire, true, 'son compte en tete')
  assert.strictEqual(res.body.comptes[1].user_id, PROD)
  assert.strictEqual(res.body.comptes[1].titulaire, false)
})

test('mes_comptes : un profil DESACTIVE n\'apparait pas', async () => {
  // ⚠ L'afficher donnerait un compte sur lequel TOUTES les requetes echouent.
  preparer({ user: MEMBRE, liens: [
    { account_user_id: MEMBRE, member_user_id: MEMBRE, is_owner: true, first_name: 'Test' },
    { ...membreActif(), active: false }
  ] })
  const res = reponse()
  await require('../api/membres')(req(null, { body: { action: 'mes_comptes' } }), res)
  assert.strictEqual(res.body.comptes.length, 1)
})

test('mes_comptes : une invitation en attente n\'apparait pas', async () => {
  preparer({ user: MEMBRE, liens: [
    { account_user_id: MEMBRE, member_user_id: MEMBRE, is_owner: true, first_name: 'Test' },
    { ...membreActif(), accepted_at: null }
  ] })
  const res = reponse()
  await require('../api/membres')(req(null, { body: { action: 'mes_comptes' } }), res)
  assert.strictEqual(res.body.comptes.length, 1)
})

test('mes_comptes : accessible SANS le domaine equipe', async () => {
  // La question n'est pas « peux-tu gerer une equipe » mais « de quels comptes
  // fais-tu partie ». Refuser priverait le membre du selecteur qui lui donne
  // acces au compte.
  preparer({ user: MEMBRE, permissions: droits({ equipe: 'none' }), liens: [
    { account_user_id: MEMBRE, member_user_id: MEMBRE, is_owner: true, first_name: 'Test' },
    membreActif()
  ] })
  const res = reponse()
  await require('../api/membres')(req(null, { body: { action: 'mes_comptes' } }), res)
  assert.strictEqual(res.code, 200)
})

test('mes_comptes : sans session -> 401', async () => {
  preparer({ user: null })
  const res = reponse()
  await require('../api/membres')(req(null, { body: { action: 'mes_comptes' } }), res)
  assert.strictEqual(res.code, 401)
})
