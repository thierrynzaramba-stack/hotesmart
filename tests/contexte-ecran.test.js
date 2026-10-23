// tests/contexte-ecran.test.js
//
// `contexteDEcran` est la garde des endpoints `/api/ecran/*` du chantier
// performance. Un ecran traverse PLUSIEURS domaines — `/api/ecran/aujourdhui`
// affiche des reservations, des menages, des taches et des avis — donc
// `requirePermission`, qui verifie UN domaine et refuse en 403, ne peut pas
// lui servir : exiger `reservations` refuserait tout l'ecran a un membre qui
// n'a que `menages`.
//
// ⚠ C'EST LA SURFACE OU UNE ERREUR D'UNE LIGNE EST UNE FUITE INTER-COMPTES.
// Le chantier profils et droits a ferme DIX fuites, toutes nees d'une garde
// recopiee ou mal lue. Ce fichier eprouve les SEPT sorties de la fonction, pas
// son chemin heureux.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

const TITULAIRE = '85e3a0ef-75bd-4c11-a3b7-e2811067dc36'
const MEMBRE    = '18920ead-f936-4e26-b62e-9a5f52b5e657'
const AUTRE     = '9f3c0000-3333-4444-9999-bbbbbbbbbbbb'
const LA_BULLE  = '091d9abf-ff86-45ce-8123-3425e6f3900f'

// `profils` : lignes `profiles`. `droits` : la ligne `profile_permissions`.
function charger ({ user = MEMBRE, profils = [], droits = null, pannne = null } = {}) {
  const vu = { tables: [] }
  const client = {
    auth: {
      getUser: async () => (user
        ? { data: { user: { id: user, email: 'x@y.fr' } }, error: null }
        : { data: null, error: { message: 'jeton invalide' } })
    },
    from (nom) {
      const f = {}
      const q = {
        select () { return q },
        eq (c, v) { f[c] = String(v); return q },
        maybeSingle: async () => rendre(nom, f),
        then (ok, ko) { return Promise.resolve(rendre(nom, f)).then(ok, ko) }
      }
      return q
    }
  }
  function rendre (nom, f) {
    vu.tables.push(nom)
    if (pannne === nom) return { data: null, error: { message: 'timeout' } }
    if (nom === 'profiles') {
      const l = profils.find(p =>
        String(p.account_user_id) === f.account_user_id &&
        String(p.member_user_id) === f.member_user_id)
      return { data: l || null, error: null }
    }
    if (nom === 'profile_permissions') return { data: droits, error: null }
    return { data: null, error: null }
  }

  // ⚠ Le module de garde construit SON client au chargement : on remplace
  // `createClient` sur le SDK deja en cache, puis on le RESTAURE — supprimer
  // l'entree ferait recharger le vrai SDK au test suivant, avec une URL
  // locale injoignable.
  const absSdk = require.resolve('@supabase/supabase-js')
  require('@supabase/supabase-js')
  const vraiCreate = require.cache[absSdk].exports.createClient
  require.cache[absSdk].exports.createClient = () => client
  delete require.cache[require.resolve('../lib/require-permission')]
  delete require.cache[require.resolve('../lib/permissions')]
  const mod = require('../lib/require-permission')
  require.cache[absSdk].exports.createClient = vraiCreate
  return { mod, vu }
}

function fausseReponse () {
  const r = { entetes: {}, code: null, corps: null, headersSent: false }
  r.setHeader = (k, v) => { r.entetes[String(k).toLowerCase()] = v; return r }
  r.status = (c) => { r.code = c; return r }
  r.json = (b) => { r.corps = b; r.headersSent = true; return r }
  return r
}
const req = (entetes = {}) => ({ headers: { authorization: 'Bearer x', ...entetes } })

const PROFIL_BULLE = {
  id: 'p1', account_user_id: TITULAIRE, member_user_id: MEMBRE,
  active: true, accepted_at: '2026-10-01T00:00:00Z', is_owner: false
}
const DROITS_BULLE = {
  profile_id: 'p1', property_scope: 'selected',
  property_ids: [LA_BULLE], property_refs: [],
  reservations: 'read', menages: 'read', avis: 'none',
  prestataires: 'none', messages: 'none', reglages: 'none',
  facturation: 'none', equipe: 'none', self_availability: 'none', self_view_reviews: false
}

test('LE TEST QUI COMPTE : sans jeton, 401 — et l en-tete prive est deja pose', async () => {
  const { mod } = charger({ user: null })
  const res = fausseReponse()
  const r = await mod.contexteDEcran({ headers: {} }, res)
  assert.equal(r.ok, false)
  assert.equal(res.code, 401)
  assert.equal(res.entetes['cache-control'], 'private, no-store',
    'meme un refus parle du compte appelant')
})

test('LE TEST QUI COMPTE : sur son PROPRE compte, titulaire sans profil a lire', async () => {
  const { mod, vu } = charger({ user: TITULAIRE })
  const res = fausseReponse()
  const r = await mod.contexteDEcran(req(), res)
  assert.equal(r.ok, true)
  assert.equal(r.accountUserId, TITULAIRE)
  assert.equal(r.contexte.profil, null, 'titulaire : aucun profil')
  assert.equal(r.contexte.permissions, null, 'et aucune permission — null veut dire TOUS les droits')
  assert.ok(!vu.tables.includes('profile_permissions'),
    'aucune lecture de droits sur son propre compte : ce serait deux requetes pour rien')
})

test('LE TEST QUI COMPTE : X-Compte au format refuse, 403 et rien de lu', async () => {
  const { mod, vu } = charger({ user: MEMBRE })
  const res = fausseReponse()
  const r = await mod.contexteDEcran(req({ 'x-compte': 'pas-un-uuid' }), res)
  assert.equal(r.ok, false)
  assert.equal(res.code, 403)
  assert.ok(!vu.tables.includes('profile_permissions'), 'le refus precede toute lecture de droits')
})

test('LE TEST QUI COMPTE : un compte ou l appelant n a PAS de profil, 403', async () => {
  // ⚠ Sans ce refus, `refsDuPerimetre` rendrait `[]` et un appelant qui lit mal
  // ce tableau vide verrait TOUT le compte. On ferme ici, une fois.
  const { mod } = charger({ user: MEMBRE, profils: [] })
  const res = fausseReponse()
  const r = await mod.contexteDEcran(req({ 'x-compte': AUTRE }), res)
  assert.equal(r.ok, false)
  assert.equal(res.code, 403)
})

test('LE TEST QUI COMPTE : un profil DESACTIVE n ouvre rien', async () => {
  const { mod } = charger({
    user: MEMBRE,
    profils: [{ ...PROFIL_BULLE, active: false }],
    droits: DROITS_BULLE
  })
  const res = fausseReponse()
  const r = await mod.contexteDEcran(req({ 'x-compte': TITULAIRE }), res)
  assert.equal(r.ok, false, 'la desactivation est immediate, y compris pour un onglet deja ouvert')
  assert.equal(res.code, 403)
})

test('LE TEST QUI COMPTE : une invitation NON ACCEPTEE n ouvre rien', async () => {
  const { mod } = charger({
    user: MEMBRE,
    profils: [{ ...PROFIL_BULLE, accepted_at: null }],
    droits: DROITS_BULLE
  })
  const res = fausseReponse()
  const r = await mod.contexteDEcran(req({ 'x-compte': TITULAIRE }), res)
  assert.equal(r.ok, false)
  assert.equal(res.code, 403)
})

test('LE TEST QUI COMPTE : une PANNE rend 503, jamais « aucun droit »', async () => {
  // Une lecture tombee qui se lirait « ce membre n a rien » afficherait un
  // ecran vide a quelqu un qui a des droits — et le ferait conclure a une
  // perte de donnees.
  const { mod } = charger({
    user: MEMBRE, profils: [PROFIL_BULLE], droits: DROITS_BULLE, pannne: 'profile_permissions'
  })
  const res = fausseReponse()
  const r = await mod.contexteDEcran(req({ 'x-compte': TITULAIRE }), res)
  assert.equal(r.ok, false)
  assert.equal(res.code, 503, 'une panne n est pas un refus de droits')
})

test('LE TEST QUI COMPTE : le membre restreint recoit SON perimetre, et lui seul', async () => {
  const { mod } = charger({ user: MEMBRE, profils: [PROFIL_BULLE], droits: DROITS_BULLE })
  const res = fausseReponse()
  const r = await mod.contexteDEcran(req({ 'x-compte': TITULAIRE }), res)
  assert.equal(r.ok, true)
  assert.equal(r.userId, MEMBRE)
  assert.equal(r.accountUserId, TITULAIRE, 'le compte VISE, pas celui de l appelant')

  const { refsDuPerimetre, peutLire } = require('../lib/permissions')
  assert.deepEqual(refsDuPerimetre(r.contexte), [LA_BULLE],
    'un seul bien dans le perimetre')
  assert.equal(peutLire(r.contexte, 'menages'), true)
  assert.equal(peutLire(r.contexte, 'reservations'), true)
  assert.equal(peutLire(r.contexte, 'avis'), false, 'avis: none — le bloc ne doit pas sortir')
  assert.equal(peutLire(r.contexte, 'reglages'), false)
})
