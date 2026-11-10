// tests/messages-lien-facture-masque.test.js — le lien du formulaire de facture
// est CACHÉ par le serveur à qui n'a pas « réservations » en écriture.
// Décision de Thierry du 10 novembre 2026 (facture voyageur 2a, review 1, S1).
// Spec : docs/specs/spec-facture-voyageur.md §10 ter ; KB : docs/kb/facture-voyageur.md
//
// Le lien `/facture#<jeton>` est une CLÉ : il ouvre les coordonnées de
// facturation du voyageur et permet de les réécrire. Il vit dans la
// conversation (D3) ; un membre qui ne fait que LIRE les messages ne doit pas
// le recevoir de /api/messages (P2, Q10). Ce fichier APPELLE l'endpoint réel.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

const FV = require('../lib/factures-voyageur')

const A = '11111111-1111-4111-8111-111111111111'       // titulaire
const LECTEUR = '33333333-3333-4333-8333-333333333333' // messages: read, reservations: read
const ECRIVAIN = '44444444-4444-4444-8444-444444444444' // reservations: write
const AILLEURS = '55555555-5555-4555-8555-555555555555' // reservations: write, mais sur un AUTRE bien
const JETON = 'Q'.repeat(30) + '_-' + 'z'.repeat(11)
const LIEN = `https://hotesmart.vercel.app/facture#${JETON}`
const RECENT = new Date(Date.now() - 86400000).toISOString()
const TEXTE = FV.texteDuLien('fr', 'Léa', LIEN)

test('le masque : lien entier, sans schéma, point final hors du jeton ; le reste du texte intact', () => {
  assert.equal(FV.masquerLiensFacture(TEXTE),
    'Bonjour Léa, pour recevoir votre facture, merci de renseigner vos coordonnées de facturation ici : [lien de facture]. Votre facture sera disponible sur ce même lien après votre séjour.')
  assert.equal(FV.masquerLiensFacture(`voir hotesmart-staging.vercel.app/facture#${JETON} et /facture#${JETON}.`), 'voir hotesmart-staging.vercel.app[lien de facture] et [lien de facture].')
  assert.equal(FV.masquerLiensFacture('Bonjour, rien à cacher /facture#court'), 'Bonjour, rien à cacher /facture#court')
  assert.equal(FV.masquerLiensFacture(null), null)
  assert.ok(!FV.masquerLiensFacture(TEXTE).includes(JETON))
})

const PROFIL = (id, membre, perms) => ({
  p: { id, account_user_id: A, member_user_id: membre, active: true, accepted_at: '2026-10-01T00:00:00Z' },
  d: { profile_id: id, ...perms }
})
const PROFILS = [
  PROFIL('p-l', LECTEUR, { messages: 'read', reservations: 'read', property_scope: 'all' }),
  PROFIL('p-e', ECRIVAIN, { messages: 'read', reservations: 'write', property_scope: 'all' }),
  PROFIL('p-a', AILLEURS, { messages: 'read', reservations: 'write', property_scope: 'list', property_ids: [], property_refs: ['ref-b'] })
]
const MODULES = ['../api/messages', '../lib/require-permission', '../lib/permissions', '../lib/cron-shared', '../lib/cron-arrival-code', '../lib/biens-vivants', '../lib/factures-voyageur']

function preparer () {
  const jetons = { 'j-a': A, 'j-l': LECTEUR, 'j-e': ECRIVAIN, 'j-x': AILLEURS }
  const tables = {
    messages: [
      { booking_id: 'BK-1', property_id: 'ref-a', provider: 'channex', sender: 'host', direction: 'outbound', body: TEXTE, sent_at: RECENT, kind: 'message' },
      { booking_id: 'BK-1', property_id: 'ref-a', provider: 'channex', sender: 'guest', direction: 'inbound', body: 'Merci !', sent_at: RECENT, kind: 'message' }
    ],
    bookings_snapshot: [{ booking_id: 'BK-1', snapshot: { firstName: 'Léa', arrival: '2026-12-01', departure: '2026-12-04' } }],
    properties: [{ user_id: A, provider_property_id: 'ref-a', archive_le: null }],
    profiles: PROFILS.map(x => x.p),
    profile_permissions: PROFILS.map(x => x.d)
  }
  const client = {
    auth: { getUser: async (j) => (jetons[j] ? { data: { user: { id: jetons[j] } }, error: null } : { data: null, error: { message: 'x' } }) },
    from (nom) {
      const q = { eq: {} }
      const executer = () => {
        const lignes = (tables[nom] || []).filter(r => Object.entries(q.eq).every(([k, v]) => !(k in r) || String(r[k]) === String(v)))
        return { data: lignes, error: null }
      }
      const c = {
        select () { return c },
        eq (k, v) { q.eq[k] = v; return c },
        in () { return c }, not () { return c }, gte () { return c }, neq () { return c }, or () { return c },
        order () { return c }, limit () { return c },
        maybeSingle: async () => { const r = executer(); return { data: r.data[0] || null, error: null } },
        single: async () => { const r = executer(); return { data: r.data[0] || null, error: null } },
        then (ok, ko) { return Promise.resolve(executer()).then(ok, ko) }
      }
      return c
    }
  }
  const absShared = require.resolve(path.join(__dirname, '..', 'lib/cron-shared'))
  const mShared = new Module(absShared); mShared.exports = { supabase: client, anthropic: null }; mShared.loaded = true
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
  require.cache[absShared] = mShared
}

async function lister (jeton) {
  const res = { code: null, body: null }
  res.status = c => { res.code = c; return res }; res.json = b => { res.body = b; return res }; res.setHeader = () => {}
  const headers = { authorization: `Bearer ${jeton}` }
  if (jeton !== 'j-a') headers['x-compte'] = A
  await require('../api/messages')({ method: 'GET', query: {}, body: null, headers }, res)
  return res
}
const corps = (res) => res.body.conversations[0].messages.map(m => m.body)

test('LE TEST QUI COMPTE : un membre qui ne fait que LIRE ne reçoit pas le lien ; le titulaire, si', async () => {
  preparer()
  const lecteur = await lister('j-l')
  assert.equal(lecteur.code, 200, JSON.stringify(lecteur.body))
  assert.ok(!JSON.stringify(lecteur.body).includes(JETON), 'le jeton a quitté le serveur')
  assert.match(corps(lecteur)[0], /ici : \[lien de facture\]\. Votre facture/)
  assert.equal(corps(lecteur)[1], 'Merci !', 'le reste de la conversation intact')
  const titulaire = await lister('j-a')
  assert.ok(corps(titulaire)[0].includes(LIEN))
})

test('« réservations » en écriture sur CE bien voit le lien ; sur un autre bien seulement, non', async () => {
  preparer()
  assert.ok(corps(await lister('j-e'))[0].includes(LIEN))
  // AILLEURS n'a pas BK-1 dans son périmètre : la conversation ne lui parvient
  // pas (filtre SQL du périmètre, simulé ici par un double permissif) — et si
  // elle lui parvenait, le lien resterait caché.
  const x = await lister('j-x')
  assert.equal(x.code, 200)
  for (const conv of x.body.conversations || []) {
    for (const m of conv.messages) assert.ok(!m.body.includes(JETON))
  }
})
