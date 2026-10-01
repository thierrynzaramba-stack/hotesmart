// tests/avis-reglages-prestataire.test.js
// api/avis.js — `prestataire-reglages` et `prestataire-reglages-maj`, servies a
// la fiche prestataire de l'app menage par l'action `avis.reglages_prestataire`
// (lot 5, 2 octobre 2026), et le module du coeur qui les appelle.
//
// Ce qui compte : une prestataire ne s'accorde pas le pouvoir de publier, un
// membre au perimetre partiel ne regle pas ce qui engage tous les biens, et un
// profil d'un autre compte n'est ni lu ni ecrit.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'cle-test'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const PROD = '11111111-1111-4111-8111-111111111111'
const AUTRE_COMPTE = '33333333-3333-4333-8333-333333333333'
const MEMBRE = '22222222-2222-4222-8222-222222222222'
const BIEN_A = { id: 'aa11bb22-cc33-4dd4-8ee5-ff6677889900', user_id: PROD, provider: 'channex', provider_property_id: 'ref-a' }

const PRESTA = { id: 'a1a1a1a1-1111-4111-8111-111111111111', account_user_id: PROD, access_mode: 'lien', first_name: 'Regina', eval_scope: null, eval_power: null, active: true }
const PRESTA_AILLEURS = { id: 'b2b2b2b2-2222-4222-8222-222222222222', account_user_id: AUTRE_COMPTE, access_mode: 'lien', first_name: 'Zoe', eval_scope: 'selon_grille', eval_power: 'valider', active: true }
const MEMBRE_DU_COMPTE = { id: 'c3c3c3c3-3333-4333-8333-333333333333', account_user_id: PROD, access_mode: 'compte', first_name: 'Amelie', eval_scope: null, eval_power: null, active: true }

const MODULES = ['../api/avis', '../lib/require-permission', '../lib/permissions', '../lib/cron-shared',
                 '../lib/avis/evaluations', '../lib/avis/publication', '../lib/avis/redaction', '../lib/avis/naissance']

// `appelant` : le profil de la session (null = le titulaire lui-meme).
function preparer ({ appelant = null, permissions = null, profils = [PRESTA, PRESTA_AILLEURS, MEMBRE_DU_COMPTE] } = {}) {
  const etat = { maj: [], profils: profils.map(p => ({ ...p })) }
  const user = appelant ? MEMBRE : PROD
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: user } }, error: null }) },
    from (nom) {
      const q = { f: {} }
      const chain = {
        select () { return chain }, eq (c, v) { q.f[c] = v; return chain },
        in () { return chain }, is () { return chain }, or () { return chain },
        order () { return chain }, limit () { return chain },
        update (row) { q.maj = row; return chain },
        maybeSingle: async () => { const r = rep(); return { data: (r.data || [])[0] || null, error: r.error } },
        single: async () => { const r = rep(); return { data: (r.data || [])[0] || null, error: r.error } },
        then (ok, ko) { return Promise.resolve(rep()).then(ok, ko) },
      }
      function rep () {
        if (nom === 'profiles') {
          // La session de l'appelant : `requirePermission` le cherche par compte + membre.
          if (q.f.member_user_id != null) {
            const ok = appelant && appelant.account_user_id === q.f.account_user_id && q.f.member_user_id === MEMBRE
            return { data: ok ? [{ ...appelant, member_user_id: MEMBRE, accepted_at: '2026-01-01' }] : [], error: null }
          }
          const cibles = etat.profils.filter(p => Object.entries(q.f).every(([c, v]) => p[c] === v))
          if (q.maj) {
            etat.maj.push({ filtres: { ...q.f }, row: q.maj })
            for (const p of cibles) Object.assign(p, q.maj)
          }
          return { data: cibles, error: null }
        }
        if (nom === 'profile_permissions') {
          return { data: appelant && permissions ? [{ ...permissions, profile_id: appelant.id }] : [], error: null }
        }
        if (nom === 'properties') return { data: [BIEN_A], error: null }
        return { data: [], error: null }
      }
      return chain
    },
  }
  const absShared = require.resolve(path.join(__dirname, '..', 'lib/cron-shared'))
  const mShared = new Module(absShared); mShared.exports = { supabase: client, anthropic: null }; mShared.loaded = true
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
  require.cache[absShared] = mShared
  return etat
}

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = () => {}
  return r
}
const lire = (profileId, entetes = {}) => ({ method: 'GET', query: { action: 'prestataire-reglages', profile_id: profileId }, body: null, headers: { authorization: 'Bearer j', ...entetes } })
const ecrire = (corps, entetes = {}) => ({ method: 'POST', query: { action: 'prestataire-reglages-maj' }, body: { action: 'prestataire-reglages-maj', ...corps }, headers: { authorization: 'Bearer j', ...entetes } })

async function appeler (r) {
  const handler = require('../api/avis')
  const res = reponse()
  await handler(r, res)
  return res
}

// ─── Le titulaire ───────────────────────────────────────────────────────────
test('le titulaire lit les reglages d’une prestataire ; une valeur absente se lit « aucun » / « soumettre »', async () => {
  preparer()
  const res = await appeler(lire(PRESTA.id))
  assert.strictEqual(res.code, 200)
  assert.deepStrictEqual(res.body, { ok: true, profile_id: PRESTA.id, eval_scope: 'aucun', eval_power: 'soumettre' })
})

test('le titulaire l’autorise : l’ecriture vise SON compte et une prestataire seulement', async () => {
  const etat = preparer()
  const res = await appeler(ecrire({ profile_id: PRESTA.id, eval_scope: 'selon_grille' }))
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.eval_scope, 'selon_grille')
  assert.strictEqual(etat.maj.length, 1)
  assert.deepStrictEqual(etat.maj[0].row, { eval_scope: 'selon_grille' }, 'aucune autre colonne ecrite')
  assert.deepStrictEqual(etat.maj[0].filtres, { id: PRESTA.id, account_user_id: PROD, access_mode: 'lien' })
})

test('LE TEST QUI COMPTE : une prestataire d’un AUTRE compte n’est ni lue ni ecrite (404)', async () => {
  const etat = preparer()
  const l = await appeler(lire(PRESTA_AILLEURS.id))
  assert.strictEqual(l.code, 404)
  const e = await appeler(ecrire({ profile_id: PRESTA_AILLEURS.id, eval_power: 'soumettre' }))
  assert.strictEqual(e.code, 404)
  assert.strictEqual(etat.maj.length, 0)
  assert.strictEqual(etat.profils.find(p => p.id === PRESTA_AILLEURS.id).eval_power, 'valider')
})

test('un membre du compte n’est pas une prestataire : ses droits ne se reglent pas ici (409)', async () => {
  const etat = preparer()
  const res = await appeler(ecrire({ profile_id: MEMBRE_DU_COMPTE.id, eval_power: 'valider' }))
  assert.strictEqual(res.code, 409)
  assert.strictEqual(res.body.motif, 'pas_une_prestataire')
  assert.strictEqual(etat.maj.length, 0)
})

test('une valeur inconnue est refusee avant toute ecriture (400)', async () => {
  const etat = preparer()
  const a = await appeler(ecrire({ profile_id: PRESTA.id, eval_scope: 'complet' }))
  const b = await appeler(ecrire({ profile_id: PRESTA.id, eval_power: 'tout' }))
  const c = await appeler(ecrire({ profile_id: PRESTA.id }))
  const d = await appeler(lire('pas-un-uuid'))
  assert.deepStrictEqual([a.code, b.code, c.code, d.code], [400, 400, 400, 400])
  // Le code seul ne prouve rien : une action inconnue rend aussi 400.
  assert.match(a.body.error, /Participation inconnue/)
  assert.match(b.body.error, /Pouvoir inconnu/)
  assert.match(c.body.error, /Aucun réglage/)
  assert.match(d.body.error, /Identifiant de prestataire invalide/)
  assert.strictEqual(etat.maj.length, 0)
})

// ─── Les appelants qui n'ont pas le droit ───────────────────────────────────
test('LE TEST QUI COMPTE : une prestataire ne s’accorde pas elle-meme le pouvoir de publier', async () => {
  const etat = preparer({ appelant: { ...PRESTA, eval_scope: 'selon_grille' }, permissions: { avis: 'write', property_scope: 'all' } })
  const res = await appeler(ecrire({ profile_id: PRESTA.id, eval_power: 'valider' }, { 'x-compte': PROD }))
  assert.strictEqual(res.code, 403)
  assert.strictEqual(res.body.motif, 'prestataire_appelante')
  assert.strictEqual(etat.maj.length, 0)
})

test('LE TEST QUI COMPTE : un membre au perimetre PARTIEL ne regle pas ce qui engage tous les biens', async () => {
  const etat = preparer({ appelant: MEMBRE_DU_COMPTE, permissions: { avis: 'write', property_scope: 'selected', property_ids: [BIEN_A.id] } })
  const res = await appeler(ecrire({ profile_id: PRESTA.id, eval_power: 'valider' }, { 'x-compte': PROD }))
  assert.strictEqual(res.code, 403)
  assert.strictEqual(res.body.motif, 'perimetre_partiel')
  assert.strictEqual(etat.maj.length, 0)
})

test('un membre au perimetre COMPLET avec avis:write regle, comme le titulaire', async () => {
  const etat = preparer({ appelant: MEMBRE_DU_COMPTE, permissions: { avis: 'write', property_scope: 'all' } })
  const res = await appeler(ecrire({ profile_id: PRESTA.id, eval_power: 'valider' }, { 'x-compte': PROD }))
  assert.strictEqual(res.code, 200)
  assert.strictEqual(etat.maj.length, 1)
})

test('un membre avis:read ne LIT meme pas ces reglages (l’action exige l’ecriture)', async () => {
  preparer({ appelant: MEMBRE_DU_COMPTE, permissions: { avis: 'read', property_scope: 'all' } })
  const res = await appeler(lire(PRESTA.id, { 'x-compte': PROD }))
  assert.strictEqual(res.code, 403)
})

// ─── Le module du coeur ─────────────────────────────────────────────────────
test('le module lit sans eval_*, ecrit avec, et rend un refus du serveur comme une DONNEE', async () => {
  const { demander } = await import('../core/avis/reglages-prestataire.js')
  const appels = []
  const ok = async (chemin, o = {}) => { appels.push({ chemin, ...o }); return { ok: true, profile_id: 'p', eval_scope: 'aucun', eval_power: 'soumettre' } }
  await demander({ profile_id: 'p' }, { deps: { appel: ok } })
  await demander({ profile_id: 'p', eval_scope: 'selon_grille' }, { deps: { appel: ok } })
  assert.match(appels[0].chemin, /action=prestataire-reglages&profile_id=p$/)
  assert.strictEqual(appels[0].methode, undefined)
  assert.strictEqual(appels[1].methode, 'POST')
  assert.deepStrictEqual(appels[1].corps, { action: 'prestataire-reglages-maj', profile_id: 'p', eval_scope: 'selon_grille' })

  const refus = async () => { const e = new Error('Les réglages…'); e.statut = 403; e.motif = 'perimetre_partiel'; throw e }
  const r = await demander({ profile_id: 'p', eval_power: 'valider' }, { deps: { appel: refus } })
  assert.deepStrictEqual(r, { ok: false, statut: 403, motif: 'perimetre_partiel', erreur: 'Les réglages…' })

  // Une panne reseau, elle, remonte : le bus dira « indisponible ».
  const panne = async () => { throw new Error('Failed to fetch') }
  await assert.rejects(() => demander({ profile_id: 'p' }, { deps: { appel: panne } }))
})

test('le manifeste livre l’action, sans « a venir »', async () => {
  const { default: m } = await import('../core/avis/manifest.js')
  const a = m.actions['avis.reglages_prestataire']
  assert.strictEqual(a.etat, undefined)
  assert.strictEqual(a.module, '/core/avis/reglages-prestataire.js')
  assert.deepStrictEqual(a.droit, { domaine: 'avis', niveau: 'write' })
})
