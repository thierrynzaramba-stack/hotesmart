// tests/menages-fait-hote.test.js
// api/menages.js POST action `fait` / `defaire` — « ce ménage est fait »,
// depuis l'écran de l'HÔTE (écart D1 de docs/specs/inventaire-menages.md).
//
// ⚠ CE QUI EST EN JEU. C'est une SECONDE porte vers `menage_done`, la table
// que la PWA de la prestataire écrit en production. Trois fautes la rendraient
// dangereuse :
//   1. écrire sans garde de droit, de compte ou de périmètre — un membre
//      marquerait le ménage d'un bien qu'il n'a pas le droit de voir ;
//   2. accepter un ménage inexistant ou annulé — la ligne serait orpheline,
//      invisible et indélébile par l'écran ;
//   3. accepter un départ FUTUR — le ménage sortirait de la liste à traiter
//      et de la PWA sans avoir été fait.
//
// ⚠ DATES RELATIVES : ces tests lisent l'horloge (le serveur compare au jour
// courant à Paris), donc jamais de date figée — règle du dépôt.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const PROD = '11111111-1111-4111-8111-111111111111'
const MEMBRE = '22222222-2222-4222-8222-222222222222'
const BIEN = '209413'
const jour = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)
const HIER = jour(-1), PASSE = jour(-20), DEMAIN = jour(2)

function preparer ({ user = PROD, profil = null, permissions = null,
                     menage = { status: 'accepted' }, compteAttendu = PROD,
                     erreurMenage = null, dejaFait = false } = {}) {
  const etat = { ecrits: [], supprimes: [], statuts: [], requetes: [] }
  const client = {
    auth: { getUser: async () => (user ? { data: { user: { id: user } }, error: null }
                                       : { data: null, error: { message: 'x' } }) },
    from (table) {
      const a = { table, f: {} }
      etat.requetes.push(a)
      const chain = {
        select () { return chain },
        eq (c, v) { a.f[c] = v; return chain },
        in () { return chain }, not () { return chain }, order () { return chain },
        neq () { return chain }, gte () { return chain }, lte () { return chain },
        // ⚠ `limit` rend la CHAINE, pas une promesse : `defaireFait` enchaine
        // `.order().limit(1).maybeSingle()`. Un double qui coupe ici ferait
        // rougir le test sur sa propre faiblesse, pas sur le code.
        limit () { return chain },
        // ⚠ L'upsert HONORE l'idempotence : `dejaFait` rejoue le cas où la
        // prestataire a marqué entre-temps — la réponse ne doit pas dire que
        // la ligne est née de ce geste.
        upsert (row) {
          etat.ecrits.push(row)
          return { select: () => Promise.resolve({ data: dejaFait ? [] : [{ id: 'd1' }], error: null }) }
        },
        delete () {
          const f = {}
          const d = { eq: (c, v) => { f[c] = v; return d },
                      then: (ok) => { etat.supprimes.push(f); return Promise.resolve({ error: null }).then(ok) } }
          return d
        },
        update (row) {
          return { eq: () => ({ eq: () => { etat.statuts.push(row); return Promise.resolve({ error: null }) } }) }
        },
        maybeSingle () {
          if (table === 'profiles') return Promise.resolve({ data: profil, error: null })
          if (table === 'profile_permissions') return Promise.resolve({ data: permissions, error: null })
          if (table === 'menages') {
            // ⚠ LES FILTRES SONT HONORES : `.eq('user_id', …)` est la seule
            // garde inter-comptes de ce chemin pour un titulaire (dont le
            // périmètre vaut `null`). Un double complaisant la rendrait
            // invisible aux assertions.
            const bon = a.f.user_id === compteAttendu && String(a.f.property_id) === BIEN
            return Promise.resolve({ data: bon ? menage : null, error: erreurMenage })
          }
          if (table === 'menage_done') return Promise.resolve({ data: null, error: null })
          return Promise.resolve({ data: null, error: null })
        },
        then (ok) { return Promise.resolve({ data: [], error: null }).then(ok) }
      }
      return chain
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of ['../lib/require-permission', '../lib/permissions', '../api/menages',
                     '../lib/cleaning/menage-fait', '../lib/cron-property-status']) {
    try { delete require.cache[require.resolve(mod)] } catch {}
  }
  return { handler: require('../api/menages'), etat }
}

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  return r
}
const post = (body, entetes = {}) => ({ method: 'POST', query: {}, body,
  headers: { authorization: 'Bearer jeton', ...entetes } })
const corps = (o = {}) => ({ action: 'fait', property_id: BIEN, booking_id: 'b1',
                             departure_date: HIER, ...o })

// ─── Les droits ─────────────────────────────────────────────────────────────

test('sans session : 401, et rien n\'est écrit', async () => {
  const { handler, etat } = preparer({ user: null })
  const res = reponse()
  await handler(post(corps()), res)
  assert.strictEqual(res.code, 401)
  assert.strictEqual(etat.ecrits.length, 0)
})

test('sans `menages: write` : 403, et rien n\'est écrit', async () => {
  const { handler, etat } = preparer({
    user: MEMBRE,
    profil: { id: 'pr1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { menages: 'read', property_scope: 'all' }
  })
  const res = reponse()
  await handler(post(corps(), { 'x-compte': PROD }), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.ecrits.length, 0)
})

test('un bien HORS PÉRIMÈTRE est refusé — même avec le droit d\'écrire', async () => {
  // Le périmètre est la seule chose qui empêche un délégué de marquer le
  // ménage d'un bien qu'il ne voit pas : il se prouve, il ne se suppose pas.
  const { handler, etat } = preparer({
    user: MEMBRE,
    profil: { id: 'pr1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { menages: 'write', property_scope: 'selected', property_ids: ['999999'] }
  })
  const res = reponse()
  await handler(post(corps(), { 'x-compte': PROD }), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.ecrits.length, 0)
})

// ─── Le ménage visé ─────────────────────────────────────────────────────────

test('un ménage INTROUVABLE : 404, aucune ligne orpheline', async () => {
  const { handler, etat } = preparer({ menage: null })
  const res = reponse()
  await handler(post(corps({ property_id: 'inconnu' })), res)
  assert.strictEqual(res.code, 404)
  assert.strictEqual(etat.ecrits.length, 0)
})

test('un séjour ANNULÉ : 409', async () => {
  const { handler, etat } = preparer({ menage: { status: 'cancelled' } })
  const res = reponse()
  await handler(post(corps()), res)
  assert.strictEqual(res.code, 409)
  assert.strictEqual(etat.ecrits.length, 0)
})

test('LE TEST QUI COMPTE : un départ FUTUR est refusé, comme dans la PWA', async () => {
  // Sans cette garde, le ménage devenait « fait » : il sortait de la liste à
  // traiter, passait vert au planning, et disparaissait de la PWA de la
  // prestataire — sans avoir été fait, et sans moyen de revenir en arrière.
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post(corps({ departure_date: DEMAIN })), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.ecrits.length, 0)
})

// ─── L'écriture ─────────────────────────────────────────────────────────────

test('un ménage d\'hier est marqué : ligne écrite, SANS jeton, logement dit prêt', async () => {
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post(corps({ departure_date: HIER })), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(etat.ecrits.length, 1)
  const row = etat.ecrits[0]
  assert.strictEqual(row.user_id, PROD)
  assert.strictEqual(row.property_id, BIEN)
  assert.strictEqual(row.departure_date, HIER)
  assert.strictEqual(row.done_by_token, null,
    'l\'hôte ne porte pas de jeton : c\'est la trace qui le distingue de la prestataire')
  assert.strictEqual(res.body.insere, true, '« Annuler » n\'est offert que sur une vraie insertion')
})

test('un ménage ANCIEN est marqué, mais ne dit PAS « logement prêt »', async () => {
  // `markReady` écrit `status: ready` ET `current_booking_id: null` : c'est
  // « propre et libre, à l'instant ». Régulariser un ménage d'il y a trois
  // semaines l'annoncerait en plein séjour en cours.
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post(corps({ departure_date: PASSE })), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(etat.ecrits.length, 1)
  assert.ok(!etat.requetes.some(r => r.table === 'property_status'),
    'property_status n\'est pas touché pour un ménage ancien')
})

test('si la prestataire a marqué entre-temps, la réponse ne promet pas « Annuler »', async () => {
  // L'upsert est idempotent : il ne fait rien. Offrir « Annuler » ferait
  // supprimer à l'hôte la ligne de la prestataire — et sa trace avec.
  const { handler } = preparer({ dejaFait: true })
  const res = reponse()
  await handler(post(corps()), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.insere, false)
})

test('`defaire` supprime la ligne du bon compte, et accepte un départ futur', async () => {
  // Défaire doit rester possible même sur un ménage à venir : c'est la
  // sortie de secours d'un « fait » posé par erreur.
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post(corps({ action: 'defaire', departure_date: DEMAIN })), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(etat.supprimes.length, 1)
  assert.strictEqual(etat.supprimes[0].user_id, PROD)
  assert.strictEqual(etat.supprimes[0].property_id, BIEN)
})

test('une date mal formée est refusée avant toute lecture', async () => {
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post(corps({ departure_date: '12/10/2026' })), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.ecrits.length, 0)
})
