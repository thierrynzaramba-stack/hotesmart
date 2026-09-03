// tests/menages-public-offre.test.js
// api/menages-public.js — répondre à une offre de ménage (spec §11.3).
//
// ⚠ CE QUI EST EN JEU. Le référent (rang 1) est assigné d'office : rien ne
// change pour Régina. Le suppléant, lui, reçoit une OFFRE — l'engager sans son
// accord reviendrait à disposer du temps de quelqu'un. Deux fautes possibles :
//   1. la double affectation, si deux acceptations se croisent, ou si une
//      acceptation croise une réassignation de l'hôte ;
//   2. la boucle du refus : rendre le ménage à qui vient de le refuser.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const U = 'compte-1', TOKEN = 'marie-x', MARIE = 'p-marie', REGINA = 'p-regina'

function preparer ({ profil = { id: MARIE, first_name: 'Marie', active: true },
                     menage = { id: 'm1', provider_id: MARIE, status: 'offered' },
                     majTouche = true, erreurMaj = null, erreurMenage = null } = {}) {
  const etat = { majs: [], journal: [], incidents: [], requetes: [] }
  const client = {
    from (table) {
      const a = { table, f: {}, cond: {} }
      etat.requetes.push(a)
      const chain = {
        select () { return chain },
        eq (c, v) { a.f[c] = v; return chain },
        neq () { return chain }, in () { return chain }, is () { return chain },
        gte () { return chain }, lte () { return chain }, not () { return chain },
        order () { return chain }, limit () { return Promise.resolve({ data: [], error: null }) },
        insert (rows) { etat.journal.push(...[].concat(rows)); return Promise.resolve({ error: null }) },
        update (row) {
          const q = { row, f: {} }
          const c2 = {
            eq (c, v) { q.f[c] = v; return c2 },
            select () {
              etat.majs.push({ table, ...q })
              // ⚠ L'update est CONDITIONNEL : le double le simule. Sans cela,
              // retirer `.eq('status','offered')` du code ne casserait rien —
              // et c'est précisément la garde anti double affectation.
              return Promise.resolve({ data: majTouche ? [{ id: 'm1' }] : [], error: erreurMaj })
            },
            then (ok) { etat.majs.push({ table, ...q }); return Promise.resolve({ error: erreurMaj }).then(ok) }
          }
          return c2
        },
        maybeSingle () {
          if (table === 'public_tokens') {
            return Promise.resolve({ data: a.f.token === TOKEN ? { user_id: U } : null, error: null })
          }
          if (table === 'profiles') return Promise.resolve({ data: profil, error: null })
          if (table === 'menages') return Promise.resolve({ data: menage, error: erreurMenage })
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
  const absNotify = require.resolve(path.join(__dirname, '..', 'lib/founder-notify.js'))
  const mn = new Module(absNotify)
  mn.exports = { reportIncident: async (type, opts) => { etat.incidents.push({ type, ...opts }) } }
  mn.loaded = true
  require.cache[absNotify] = mn
  for (const mod of ['../api/menages-public', '../lib/stats-avis', '../lib/attribution-prestataire',
                     '../lib/cron-property-status']) {
    try { delete require.cache[require.resolve(mod)] } catch {}
  }
  return etat
}

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = () => {}
  r.end = () => r
  return r
}
const post = (action, over = {}) => ({
  method: 'POST', query: { token: TOKEN }, headers: {},
  body: { action, booking_id: 'b1', property_id: '209413', departure_date: '2026-09-05', ...over }
})

// ─── L'acceptation ─────────────────────────────────────────────────────────

test('accepter une offre : le ménage passe à accepted, avec sa date', async () => {
  const etat = preparer({})
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('accepterMenage'), res)
  assert.strictEqual(res.body.status, 'accepted')
  assert.strictEqual(etat.majs[0].row.status, 'accepted')
  assert.ok(etat.majs[0].row.accepted_at)
})

test('l\'acceptation est ATOMIQUE : la condition est dans l\'update', async () => {
  // ⚠ Tester l'état avant de l'écrire laisserait une fenêtre entre les deux :
  // l'hôte réassigne, ou une autre candidate accepte, et deux personnes se
  // croient engagées sur le même ménage. La condition doit être posée par la
  // base, pas par le code.
  const etat = preparer({})
  const handler = require('../api/menages-public')
  await handler(post('accepterMenage'), reponse())
  const maj = etat.majs[0]
  assert.strictEqual(maj.f.status, 'offered', 'l\'update exige que l\'offre soit encore ouverte')
  assert.strictEqual(maj.f.provider_id, MARIE, 'et qu\'elle lui soit toujours adressée')
})

test('offre déjà prise : 409, et surtout PAS un succès', async () => {
  // Zéro ligne modifiée n'est pas une panne : c'est une course perdue. Lui
  // répondre « c'est bon » la ferait s'organiser autour d'un ménage qui ne lui
  // revient plus.
  const etat = preparer({ majTouche: false })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('accepterMenage'), res)
  assert.strictEqual(res.code, 409)
  assert.strictEqual(etat.journal.length, 0, 'et rien au journal')
})

test('chaque acceptation écrit UNE ligne de journal, au nom de la prestataire', async () => {
  const etat = preparer({})
  const handler = require('../api/menages-public')
  await handler(post('accepterMenage'), reponse())
  assert.strictEqual(etat.journal.length, 1)
  assert.strictEqual(etat.journal[0].event, 'accepted')
  assert.strictEqual(etat.journal[0].actor, 'provider')
  assert.strictEqual(etat.journal[0].to_provider_id, MARIE)
})

// ─── Le refus ──────────────────────────────────────────────────────────────

test('refuser : le ménage devient ORPHANED, pas unassigned', async () => {
  // ⚠ La distinction évite une boucle : `unassigned` serait réassigné à la même
  // personne au cycle suivant, qui refuserait encore. `orphaned` dit « quelqu'un
  // a refusé, il faut une décision humaine ».
  const etat = preparer({})
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('refuserMenage'), res)
  assert.strictEqual(res.body.status, 'orphaned')
  assert.strictEqual(etat.majs[0].row.status, 'orphaned')
  assert.strictEqual(etat.majs[0].row.provider_id, null)
})

test('un refus ALERTE l\'hôte', async () => {
  // C'est le seul cas de ce lot où personne ne prend le relais automatiquement :
  // un ménage refusé et non repris est un logement qui ne sera pas préparé.
  const etat = preparer({})
  const handler = require('../api/menages-public')
  await handler(post('refuserMenage'), reponse())
  assert.strictEqual(etat.incidents.length, 1)
  assert.strictEqual(etat.incidents[0].type, 'menage_non_assigne')
  assert.strictEqual(etat.incidents[0].propertyId, '209413')
})

test('le refus est atomique lui aussi', async () => {
  const etat = preparer({})
  const handler = require('../api/menages-public')
  await handler(post('refuserMenage'), reponse())
  assert.strictEqual(etat.majs[0].f.status, 'offered')
  assert.strictEqual(etat.majs[0].f.provider_id, MARIE)
})

test('refuser une offre déjà retirée : 409, aucune alerte', async () => {
  const etat = preparer({ majTouche: false })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('refuserMenage'), res)
  assert.strictEqual(res.code, 409)
  assert.strictEqual(etat.incidents.length, 0, 'ne pas alerter sur un ménage qui n\'est plus à elle')
})

// ─── Qui peut répondre ─────────────────────────────────────────────────────

test('un lien SANS profil ne peut pas répondre à une offre', async () => {
  // Il ne porte aucune assignation : le laisser faire écrirait une acceptation
  // au nom de personne.
  const etat = preparer({ profil: null })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('accepterMenage'), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.majs.length, 0)
})

test('un profil DÉSACTIVÉ non plus', async () => {
  const etat = preparer({ profil: { id: MARIE, first_name: 'Marie', active: false } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('accepterMenage'), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.majs.length, 0)
})

test('on ne répond pas à l\'offre de quelqu\'un d\'autre', async () => {
  // La condition atomique s'en charge : l'update ne touche rien.
  const etat = preparer({ menage: { id: 'm1', provider_id: REGINA, status: 'offered' },
                          majTouche: false })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('accepterMenage'), res)
  assert.strictEqual(res.code, 409)
  assert.strictEqual(etat.majs[0].f.provider_id, MARIE, 'la condition porte SON identifiant')
})

// ─── Les entrées et les pannes ─────────────────────────────────────────────

test('champs manquants ou date invalide : 400, aucune écriture', async () => {
  for (const corps of [{ booking_id: null }, { departure_date: '05/09/2026' }]) {
    const etat = preparer({})
    const handler = require('../api/menages-public')
    const res = reponse()
    await handler(post('accepterMenage', corps), res)
    assert.strictEqual(res.code, 400, JSON.stringify(corps))
    assert.strictEqual(etat.majs.length, 0)
  }
})

test('ménage introuvable : 404, pas une acceptation dans le vide', async () => {
  const etat = preparer({ menage: null })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('accepterMenage'), res)
  assert.strictEqual(res.code, 404)
  assert.strictEqual(etat.majs.length, 0)
})

test('PANNE de lecture : 503, jamais un succès muet', async () => {
  const etat = preparer({ erreurMenage: { message: 'timeout' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('accepterMenage'), res)
  assert.strictEqual(res.code, 503)
  assert.strictEqual(etat.majs.length, 0)
})

test('PANNE d\'écriture : 503, et rien au journal', async () => {
  const etat = preparer({ erreurMaj: { message: 'timeout' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('accepterMenage'), res)
  assert.strictEqual(res.code, 503)
  assert.strictEqual(etat.journal.length, 0)
})
