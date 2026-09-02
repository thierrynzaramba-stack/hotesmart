// tests/membres-endpoint.test.js
// api/membres.js — page « Equipe et droits » (etape 4).
//
// COBAYE : le compte test, membre du compte prod avec `equipe = 'none'`. Il ne
// doit RIEN pouvoir faire sur cet endpoint — ni lire la liste des profils, ni
// modifier des droits. C'est le scenario de la section 7 de la spec.
//
// ⚠ `equipe` est NON DELEGABLE en ecriture : meme un membre a qui le titulaire
// aurait mis `equipe = 'write'` en base doit etre refuse. Ce n'est pas une
// hypothese d'ecole — c'est ce qui empeche un membre de s'auto-promouvoir.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const PROD = 'compte-prod', AUTRE = 'compte-autre', MEMBRE = 'membre', INVITE = 'invite'

const BIEN_A = { id: '58001ed1-e194-498a-94b4-606eece8f33d', user_id: PROD,
                 name: 'La bulle', provider_property_id: '209413' }
const BIEN_B = { id: '49b2d1f6-b8df-43ba-b636-fa4f73713c4b', user_id: PROD,
                 name: 'Coeur de vie', provider_property_id: '169567' }
const BIEN_TIERS = { id: '9f3c0000-3333-4444-9999-bbbbbbbbbbbb', user_id: AUTRE,
                     name: 'Chez un autre', provider_property_id: '999999' }
const BIENS = [BIEN_A, BIEN_B, BIEN_TIERS]

const OWNER = { id: 'p-owner', account_user_id: PROD, member_user_id: PROD, first_name: 'Thierry',
                access_mode: 'compte', is_owner: true, active: true, accepted_at: '2026-09-01',
                pwa_token: null, invite_token: null, invite_expires_at: null }
const REGINA = { id: 'p-regina', account_user_id: PROD, member_user_id: null, first_name: 'Régina',
                 access_mode: 'lien', is_owner: false, active: true, accepted_at: '2026-09-01',
                 pwa_token: 'jeton-regina', invite_token: null, invite_expires_at: null }
const TEST = { id: 'p-test', account_user_id: PROD, member_user_id: MEMBRE, first_name: 'Compte',
               last_name: 'de test', email: 'test@exemple.fr', access_mode: 'compte',
               is_owner: false, active: true, accepted_at: '2026-09-01',
               pwa_token: null, invite_token: null, invite_expires_at: null }

const MODULES = ['../lib/require-permission', '../lib/permissions', '../api/membres']

const DANS_7_JOURS = () => new Date(Date.now() + 6 * 86400000).toISOString()
const HIER = () => new Date(Date.now() - 86400000).toISOString()

function preparer ({ user = MEMBRE, profil = null, permissions = null,
                     profils = [OWNER, REGINA, TEST], tokensPwa = [{ id: 'pt1', token: 'jeton-regina' }],
                     erreurs = {} } = {}) {
  const etat = { ecritures: [], suppressions: [] }

  const client = {
    auth: { getUser: async () => (user ? { data: { user: { id: user, email: user + '@exemple.fr' } }, error: null }
                                       : { data: null, error: { message: 'x' } }) },
    from (nom) {
      const q = {
        _f: {}, _in: null, _or: null, _maj: null,
        select () { return q },
        eq (c, v) { q._f[c] = v; return q },
        or (e) { q._or = e; return q },
        in (c, v) { q._in = { c, v }; return q },
        not () { return q }, is () { return q }, order () { return q }, limit () { return q },
        insert (r) {
          etat.ecritures.push({ table: nom, action: 'insert', row: r })
          if (erreurs[nom + ':insert']) {
            const echec = { select: () => ({ single: async () => ({ data: null, error: { message: 'echec' } }) }) }
            return Object.assign(Promise.resolve({ error: { message: 'echec' } }), echec)
          }
          const cree = { ...(Array.isArray(r) ? r[0] : r), id: 'p-nouveau' }
          const ok = { select: () => ({ single: async () => ({ data: cree, error: null }) }) }
          return Object.assign(Promise.resolve({ data: cree, error: null }), ok)
        },
        update (r) {
          q._maj = r
          // ⚠ Reference VIVANTE, pas une copie : les `.eq()` sont chaines APRES
          // `.update()`, donc une copie prise ici serait toujours vide.
          etat.ecritures.push({ table: nom, action: 'update', row: r, filtres: q._f })
          if (erreurs[nom + ':update']) {
            return Object.assign(Promise.resolve({ error: { message: 'echec' } }),
              { eq: () => q, select: async () => ({ data: null, error: { message: 'echec' } }) })
          }
          return q
        },
        delete () {
          etat.suppressions.push({ table: nom, filtres: q._f })
          return Object.assign(Promise.resolve({ error: null }), { eq: (c, v) => { q._f[c] = v; return q } })
        },
        single: async () => rep(nom, q), maybeSingle: async () => rep(nom, q),
        then (ok, ko) { return Promise.resolve(rep(nom, q, true)).then(ok, ko) }
      }
      function rep (nom, q, tableau = false) {
        if (nom === 'properties') {
          if (q._f.id != null) assert.match(String(q._f.id), /^[0-9a-f]{8}-/i, '.eq(id) recoit un non-UUID')
          const rows = BIENS.filter(b =>
            (q._f.user_id == null || b.user_id === q._f.user_id) &&
            (q._f.id == null || b.id === q._f.id) &&
            (q._in == null || q._in.c !== 'id' || q._in.v.includes(b.id)))
          return { data: tableau ? rows : (rows[0] || null), error: null }
        }
        if (nom === 'profiles') {
          const rows = profils.filter(p =>
            (q._f.id == null || p.id === q._f.id) &&
            (q._f.account_user_id == null || p.account_user_id === q._f.account_user_id) &&
            (q._f.member_user_id === undefined || p.member_user_id === q._f.member_user_id) &&
            (q._f.invite_token == null || p.invite_token === q._f.invite_token) &&
            (q._f.is_owner == null || p.is_owner === q._f.is_owner))
          // `update(...).eq(...).select()` renvoie les lignes touchees.
          if (q._maj) return { data: rows.map(r => ({ id: r.id })), error: null }
          return { data: tableau ? rows : (rows[0] || null), error: null }
        }
        if (nom === 'profile_permissions') {
          if (q._f.profile_id === 'p-regina') {
            return { data: { property_scope: 'selected', property_ids: [BIEN_A.id, BIEN_B.id] }, error: null }
          }
          return { data: tableau ? [] : null, error: null }
        }
        if (nom === 'public_tokens') {
          const rows = tokensPwa.filter(t => q._f.token == null || t.token === q._f.token)
          return { data: tableau ? rows : (rows[0] || null), error: null }
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
const profilActif = (o = {}) => ({ id: 'p-test', account_user_id: PROD, member_user_id: MEMBRE,
                                   active: true, accepted_at: '2026-09-01', ...o })
const perms = (o = {}) => ({ profile_id: 'p-test', property_scope: 'all', property_ids: [], property_refs: [],
                             reservations: 'none', menages: 'none', prestataires: 'none', messages: 'none',
                             avis: 'none', reglages: 'none', facturation: 'none', equipe: 'none', ...o })
const req = (o = {}) => ({ method: 'POST', headers: { authorization: 'Bearer tok', host: 'hotesmart.vercel.app' },
                           query: {}, body: {}, ...o })
const droitsVides = () => ({ property_scope: 'all', property_ids: [], reservations: 'none', menages: 'none',
                             prestataires: 'none', messages: 'none', avis: 'none', reglages: 'none',
                             facturation: 'none', equipe: 'none', self_availability: 'none', self_view_reviews: true })

// ─── LE COBAYE : le compte test face au compte prod ─────────────────────────
//
// ⚠ CE QUE CES TESTS CONSTATENT, et qui demande d'etre lu avant d'etre juge :
// tant qu'il n'existe pas de selecteur de compte (etape 5), aucun identifiant de
// requete ne designe un compte. Le compte cible est donc celui de l'APPELANT, et
// un appelant est titulaire de son propre compte — `equipe` y vaut 'write' quoi
// qu'il y ait dans son profil sur un AUTRE compte.
//
// « equipe = none, tout est refuse » ne peut donc pas se verifier ainsi. Ce qui
// se verifie, et qui est la vraie question, c'est que le compte test ne touche
// RIEN du compte prod : toute action visant un profil de prod est refusee, et ce
// qu'il fait n'a d'effet que chez lui.

test('cobaye : lister ne montre QUE les profils de son propre compte', async () => {
  const etat = preparer({ user: MEMBRE, profil: profilActif(), permissions: perms({ equipe: 'none' }) })
  const res = reponse()
  await require('../api/membres')(req({ body: { action: 'list' } }), res)
  assert.strictEqual(res.code, 200)
  // Aucun profil du compte prod ne remonte : la requete est filtree sur MEMBRE.
  assert.deepStrictEqual(res.body.profils, [])
  assert.deepStrictEqual(etat.ecritures, [])
})

test('cobaye : modifier un profil du compte prod -> 404', async () => {
  const etat = preparer({ user: MEMBRE, profil: profilActif(), permissions: perms({ equipe: 'none' }) })
  const res = reponse()
  await require('../api/membres')(req({ body: {
    action: 'update', profile_id: 'p-regina', permissions: droitsVides() } }), res)
  assert.strictEqual(res.code, 404)
  assert.deepStrictEqual(etat.ecritures, [])
})

test('cobaye : desactiver un profil du compte prod -> 404', async () => {
  const etat = preparer({ user: MEMBRE, profil: profilActif(), permissions: perms({ equipe: 'none' }) })
  const res = reponse()
  await require('../api/membres')(req({ body: { action: 'deactivate', profile_id: 'p-regina' } }), res)
  assert.strictEqual(res.code, 404)
  assert.deepStrictEqual(etat.ecritures, [])
  assert.deepStrictEqual(etat.suppressions, [], 'le lien de Régina ne doit pas etre touche')
})

test('cobaye : regenerer le lien de Régina -> 404, son jeton intact', async () => {
  const etat = preparer({ user: MEMBRE, profil: profilActif(), permissions: perms({ equipe: 'none' }) })
  const res = reponse()
  await require('../api/membres')(req({ body: { action: 'regenerate', profile_id: 'p-regina' } }), res)
  assert.strictEqual(res.code, 404)
  assert.deepStrictEqual(etat.ecritures, [])
  assert.deepStrictEqual(etat.suppressions, [])
})

test('cobaye : lire le lien d\'un profil du compte prod -> 404', async () => {
  preparer({ user: MEMBRE, profil: profilActif(), permissions: perms({ equipe: 'none' }) })
  const res = reponse()
  await require('../api/membres')(req({ body: { action: 'lien', profile_id: 'p-regina' } }), res)
  assert.strictEqual(res.code, 404)
})

test('cobaye : ce qu\'il cree n\'atterrit QUE sur son propre compte', async () => {
  const etat = preparer({ user: MEMBRE, profil: profilActif(), permissions: perms({ equipe: 'none' }) })
  const res = reponse()
  await require('../api/membres')(req({ body: {
    action: 'create', first_name: 'Chez lui', email: 'x@y.fr', permissions: droitsVides() } }), res)
  const ins = etat.ecritures.find(e => e.table === 'profiles' && e.action === 'insert')
  if (ins) assert.strictEqual(ins.row.account_user_id, MEMBRE,
    'un profil cree par le compte test ne doit jamais porter le compte prod')
})

test('cobaye : rattacher un bien du compte prod a son profil -> refus', async () => {
  // ⚠ Le vrai risque : se donner acces a un bien de prod depuis son propre compte.
  const etat = preparer({ user: MEMBRE, profil: profilActif(), permissions: perms({ equipe: 'none' }) })
  const res = reponse()
  await require('../api/membres')(req({ body: {
    action: 'create', first_name: 'Complice', email: 'c@d.fr',
    permissions: { ...droitsVides(), property_scope: 'selected', property_ids: [BIEN_A.id] } } }), res)
  assert.strictEqual(res.code, 403)
  assert.deepStrictEqual(etat.ecritures, [])
})

test('AUTO-PROMOTION : equipe=write sur un AUTRE compte ne donne rien chez lui', async () => {
  // Le domaine est NON DELEGABLE : meme si 'write' se retrouvait en base sur le
  // compte prod, cela ne vaut pas pour agir sur prod — le compte cible reste
  // l'appelant, et prod lui reste ferme.
  const etat = preparer({ user: MEMBRE, profil: profilActif(), permissions: perms({ equipe: 'write' }) })
  const res = reponse()
  await require('../api/membres')(req({ body: {
    action: 'update', profile_id: 'p-owner', permissions: droitsVides() } }), res)
  assert.strictEqual(res.code, 404, 'le profil titulaire de prod lui est invisible')
  assert.deepStrictEqual(etat.ecritures, [])
})

// ─── Titulaire : le chemin passant ──────────────────────────────────────────

test('titulaire : la liste ne divulgue AUCUN jeton', async () => {
  // ⚠ Un jeton dans une liste finit dans un cache, un log, une capture d'ecran.
  // On expose son existence, jamais sa valeur — l'action `lien` la donne.
  preparer({ user: PROD })
  const res = reponse()
  await require('../api/membres')(req({ body: { action: 'list' } }), res)
  assert.strictEqual(res.code, 200)
  const brut = JSON.stringify(res.body)
  assert.ok(!brut.includes('jeton-regina'), 'le pwa_token ne doit pas sortir dans la liste')
  const regina = res.body.profils.find(p => p.id === 'p-regina')
  assert.strictEqual(regina.a_lien_pwa, true)
  assert.strictEqual(regina.statut, 'actif')
})

test('titulaire : creation d\'un acces par compte -> invitation en attente et lien', async () => {
  const etat = preparer({ user: PROD })
  const res = reponse()
  await require('../api/membres')(req({ body: {
    action: 'create', first_name: 'Nouvel', last_name: 'Employé', email: 'n@e.fr',
    access_mode: 'compte', permissions: { ...droitsVides(), reservations: 'read' } } }), res)
  assert.strictEqual(res.code, 200)
  assert.ok(res.body.lien.includes('/invitation?token='), res.body.lien)
  const ins = etat.ecritures.find(e => e.table === 'profiles' && e.action === 'insert')
  assert.ok(ins.row.invite_token, 'un jeton d\'invitation doit etre pose')
  assert.ok(ins.row.invite_expires_at, 'avec une expiration')
  assert.strictEqual(ins.row.member_user_id, null, 'personne n\'est rattache avant acceptation')
  assert.strictEqual(ins.row.is_owner, false)
})

test('titulaire : creation d\'un acces par lien -> public_tokens alimente', async () => {
  // Le prestataire a un lien qui ouvre sur rien si public_tokens n'est pas ecrit.
  const etat = preparer({ user: PROD })
  const res = reponse()
  await require('../api/membres')(req({ body: {
    action: 'create', first_name: 'Nouveau', access_mode: 'lien',
    permissions: { ...droitsVides(), property_scope: 'selected', property_ids: [BIEN_A.id],
                   self_availability: 'write' } } }), res)
  assert.strictEqual(res.code, 200)
  assert.ok(res.body.lien.includes('/apps/menages/?token='), res.body.lien)
  const pt = etat.ecritures.find(e => e.table === 'public_tokens')
  assert.ok(pt, 'public_tokens doit etre alimente')
  assert.deepStrictEqual(pt.row.property_ids, [BIEN_A.provider_property_id],
    'le perimetre PWA porte le provider_property_id, pas l\'UUID')
})

test('creation : un bien d\'un AUTRE compte est refuse', async () => {
  const etat = preparer({ user: PROD })
  const res = reponse()
  await require('../api/membres')(req({ body: {
    action: 'create', first_name: 'X', email: 'x@y.fr',
    permissions: { ...droitsVides(), property_scope: 'selected', property_ids: [BIEN_TIERS.id] } } }), res)
  assert.strictEqual(res.code, 403)
  assert.deepStrictEqual(etat.ecritures, [])
})

test('creation : facturation ou equipe en ecriture -> refus', async () => {
  for (const domaine of ['facturation', 'equipe']) {
    const etat = preparer({ user: PROD })
    const res = reponse()
    await require('../api/membres')(req({ body: {
      action: 'create', first_name: 'X', email: 'x@y.fr',
      permissions: { ...droitsVides(), [domaine]: 'write' } } }), res)
    assert.strictEqual(res.code, 400, domaine)
    assert.deepStrictEqual(etat.ecritures, [], domaine)
  }
})

test('creation : niveau inconnu -> refus', async () => {
  preparer({ user: PROD })
  const res = reponse()
  await require('../api/membres')(req({ body: {
    action: 'create', first_name: 'X', email: 'x@y.fr',
    permissions: { ...droitsVides(), reservations: 'admin' } } }), res)
  assert.strictEqual(res.code, 400)
})

test('creation : un acces par compte sans email est refuse', async () => {
  preparer({ user: PROD })
  const res = reponse()
  await require('../api/membres')(req({ body: {
    action: 'create', first_name: 'X', access_mode: 'compte', permissions: droitsVides() } }), res)
  assert.strictEqual(res.code, 400)
})

// ─── Le titulaire est intouchable ───────────────────────────────────────────

test('le profil du TITULAIRE n\'est pas modifiable', async () => {
  const etat = preparer({ user: PROD })
  const res = reponse()
  await require('../api/membres')(req({ body: {
    action: 'update', profile_id: 'p-owner', permissions: droitsVides() } }), res)
  assert.strictEqual(res.code, 403)
  assert.deepStrictEqual(etat.ecritures, [])
})

test('le profil du TITULAIRE ne peut pas etre desactive', async () => {
  const etat = preparer({ user: PROD })
  const res = reponse()
  await require('../api/membres')(req({ body: { action: 'deactivate', profile_id: 'p-owner' } }), res)
  assert.strictEqual(res.code, 403)
  assert.deepStrictEqual(etat.ecritures, [])
})

test('un profil d\'un AUTRE compte -> 404, pas 403', async () => {
  // Ne pas distinguer « n'existe pas » de « ne vous appartient pas ».
  preparer({ user: PROD, profils: [OWNER, { ...REGINA, id: 'p-ailleurs', account_user_id: AUTRE }] })
  const res = reponse()
  await require('../api/membres')(req({ body: {
    action: 'update', profile_id: 'p-ailleurs', permissions: droitsVides() } }), res)
  assert.strictEqual(res.code, 404)
})

// ─── Mode d'acces verrouille ────────────────────────────────────────────────

test('le mode d\'acces ne se change pas apres creation', async () => {
  const etat = preparer({ user: PROD })
  const res = reponse()
  await require('../api/membres')(req({ body: {
    action: 'update', profile_id: 'p-regina', access_mode: 'compte', permissions: droitsVides() } }), res)
  assert.strictEqual(res.code, 400)
  assert.match(res.body.error, /mode d’accès/)
  assert.deepStrictEqual(etat.ecritures, [])
})

// ─── Regeneration du lien de Regina ─────────────────────────────────────────

test('regeneration : le jeton de Régina change dans les DEUX tables', async () => {
  // ⚠ profiles.pwa_token et public_tokens.token : n'en changer qu'un donne un
  // lien affiche qui n'ouvre rien, ou un ancien lien qui ouvre encore.
  const etat = preparer({ user: PROD })
  const res = reponse()
  await require('../api/membres')(req({ body: { action: 'regenerate', profile_id: 'p-regina' } }), res)
  assert.strictEqual(res.code, 200)
  const majProfil = etat.ecritures.find(e => e.table === 'profiles' && e.action === 'update' && e.row.pwa_token)
  assert.ok(majProfil, 'profiles.pwa_token doit changer')
  assert.notStrictEqual(majProfil.row.pwa_token, 'jeton-regina')
  const majToken = etat.ecritures.find(e => e.table === 'public_tokens')
  assert.ok(majToken, 'public_tokens doit suivre')
  const suppr = etat.suppressions.find(s => s.table === 'public_tokens')
  assert.ok(suppr, 'l\'ancien jeton doit etre retire')
})

test('regeneration : rien n\'est regenere sans demande explicite', async () => {
  // Une simple modification de droits ne doit JAMAIS toucher au jeton : le lien
  // de Régina mourrait a chaque enregistrement.
  const etat = preparer({ user: PROD })
  const res = reponse()
  await require('../api/membres')(req({ body: {
    action: 'update', profile_id: 'p-regina',
    permissions: { ...droitsVides(), property_scope: 'selected', property_ids: [BIEN_A.id] } } }), res)
  assert.strictEqual(res.code, 200)
  assert.ok(!etat.ecritures.some(e => e.table === 'profiles' && e.row?.pwa_token),
    'le jeton ne doit pas bouger lors d\'un enregistrement de droits')
  assert.deepStrictEqual(etat.suppressions, [], 'aucun jeton retire')
})

test('desactivation d\'un profil LIEN : le jeton PWA est retire', async () => {
  // `active = false` ne suffit pas : la PWA n'interroge que public_tokens.
  const etat = preparer({ user: PROD })
  const res = reponse()
  await require('../api/membres')(req({ body: { action: 'deactivate', profile_id: 'p-regina' } }), res)
  assert.strictEqual(res.code, 200)
  assert.ok(etat.suppressions.some(s => s.table === 'public_tokens'),
    'le lien doit etre coupe immediatement')
})

// ─── Acceptation d'une invitation ───────────────────────────────────────────

const EN_ATTENTE = { id: 'p-attente', account_user_id: PROD, member_user_id: null, first_name: 'Invité',
                     email: 'invite@exemple.fr', access_mode: 'compte', is_owner: false, active: true,
                     accepted_at: null, pwa_token: null,
                     invite_token: 'jeton-valide', invite_expires_at: DANS_7_JOURS() }

test('acceptation : l\'invité rejoint le compte et le jeton est efface', async () => {
  const etat = preparer({ user: INVITE, profils: [OWNER, EN_ATTENTE] })
  const res = reponse()
  await require('../api/membres')(req({ body: { action: 'accept', token: 'jeton-valide' } }), res)
  assert.strictEqual(res.code, 200)
  const maj = etat.ecritures.find(e => e.table === 'profiles' && e.action === 'update')
  assert.strictEqual(maj.row.member_user_id, INVITE)
  assert.ok(maj.row.accepted_at)
  assert.strictEqual(maj.row.invite_token, null, 'le jeton ne survit pas a l\'acceptation')
  assert.strictEqual(maj.row.invite_expires_at, null)
  assert.strictEqual(maj.filtres.invite_token, 'jeton-valide',
    'l\'update doit filtrer sur le jeton : deux acceptations simultanees, une seule gagne')
})

test('acceptation : jeton inconnu -> 404, aucun rattachement', async () => {
  const etat = preparer({ user: INVITE, profils: [OWNER, EN_ATTENTE] })
  const res = reponse()
  await require('../api/membres')(req({ body: { action: 'accept', token: 'jeton-invente' } }), res)
  assert.strictEqual(res.code, 404)
  assert.deepStrictEqual(etat.ecritures, [])
})

test('acceptation : jeton EXPIRE -> 410, aucun rattachement', async () => {
  const etat = preparer({ user: INVITE,
    profils: [OWNER, { ...EN_ATTENTE, invite_expires_at: HIER() }] })
  const res = reponse()
  await require('../api/membres')(req({ body: { action: 'accept', token: 'jeton-valide' } }), res)
  assert.strictEqual(res.code, 410)
  assert.deepStrictEqual(etat.ecritures, [])
})

test('acceptation : profil desactive -> refus', async () => {
  preparer({ user: INVITE, profils: [OWNER, { ...EN_ATTENTE, active: false }] })
  const res = reponse()
  await require('../api/membres')(req({ body: { action: 'accept', token: 'jeton-valide' } }), res)
  assert.strictEqual(res.code, 403)
})

test('acceptation : le titulaire lui-meme -> refus explicite', async () => {
  preparer({ user: PROD, profils: [OWNER, EN_ATTENTE] })
  const res = reponse()
  await require('../api/membres')(req({ body: { action: 'accept', token: 'jeton-valide' } }), res)
  assert.strictEqual(res.code, 409)
})

test('acceptation : quelqu\'un deja membre du compte -> refus explicite', async () => {
  preparer({ user: MEMBRE, profils: [OWNER, TEST, EN_ATTENTE] })
  const res = reponse()
  await require('../api/membres')(req({ body: { action: 'accept', token: 'jeton-valide' } }), res)
  assert.strictEqual(res.code, 409)
})

test('acceptation : sans session -> 401', async () => {
  preparer({ user: null })
  const res = reponse()
  await require('../api/membres')(req({ body: { action: 'accept', token: 'jeton-valide' } }), res)
  assert.strictEqual(res.code, 401)
})

test('acceptation : le compte cible vient du JETON, jamais du corps de requete', async () => {
  // Un `account_user_id` fourni par le client est ignore : c'est le jeton qui
  // designe le compte.
  const etat = preparer({ user: INVITE, profils: [OWNER, EN_ATTENTE] })
  const res = reponse()
  await require('../api/membres')(req({ body: {
    action: 'accept', token: 'jeton-valide', account_user_id: AUTRE, profile_id: 'p-owner' } }), res)
  assert.strictEqual(res.code, 200)
  const maj = etat.ecritures.find(e => e.table === 'profiles' && e.action === 'update')
  assert.strictEqual(maj.filtres.id, 'p-attente', 'le profil vise vient du jeton')
})

// ─── Divers ─────────────────────────────────────────────────────────────────

test('action inconnue -> 400, avant toute lecture', async () => {
  const etat = preparer({ user: PROD })
  const res = reponse()
  await require('../api/membres')(req({ body: { action: 'nimporte' } }), res)
  assert.strictEqual(res.code, 400)
  assert.deepStrictEqual(etat.ecritures, [])
})

test('action heritee d\'Object.prototype -> 400', async () => {
  preparer({ user: PROD })
  const res = reponse()
  await require('../api/membres')(req({ body: { action: 'constructor' } }), res)
  assert.strictEqual(res.code, 400)
})

test('sans session -> 401', async () => {
  preparer({ user: null })
  const res = reponse()
  await require('../api/membres')(req({ body: { action: 'list' } }), res)
  assert.strictEqual(res.code, 401)
})
