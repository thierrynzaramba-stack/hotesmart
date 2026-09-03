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
                     menage = { id: 'm1', provider_id: REGINA, offered_to: MARIE, status: 'accepted' },
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
            gt (c, v) { q.gt = { c, v }; return c2 },
            neq (c, v) { q.neq = { c, v }; return c2 },
            select () {
              etat.majs.push({ table, ...q })
              // ⚠ L'update est CONDITIONNEL : le double le simule. Sans cela,
              // retirer `.eq('status','offered')` du code ne casserait rien —
              // et c'est précisément la garde anti double affectation.
              // ⚠ LE DOUBLE APPLIQUE LA CONDITION. Rendre une valeur préréglée
              // laissait passer le retrait de `.eq('offered_to', …)` ou de la
              // garde d'expiration — c'est pourtant tout ce qui empêche une
              // double affectation. Vérifié : la mutation fait tomber ce test.
              const viseSonOffre = q.f.offered_to === undefined ||
                                   q.f.offered_to === (menage && menage.offered_to)
              // ⚠ `.neq('status','cancelled')` est HONORE : une PWA restée
              // ouverte sur un ménage dont la réservation a disparu ne doit pas
              // pouvoir le ressusciter avec un porteur.
              const pasAnnule = !q.neq || (menage && menage.status) !== q.neq.v
              const ok = majTouche && viseSonOffre && pasAnnule
              return Promise.resolve({ data: ok ? [{ id: 'm1' }] : [], error: erreurMaj })
            },
            then (ok) { etat.majs.push({ table, ...q }); return Promise.resolve({ error: erreurMaj }).then(ok) }
          }
          return c2
        },
        maybeSingle () {
          if (table === 'public_tokens') {
            return Promise.resolve({ data: a.f.token === TOKEN ? { user_id: U } : null, error: null })
          }
          // ⚠ LES FILTRES SONT HONORES. Un double qui rend la ligne quels que
          // soient les `.eq()` rend indétectables les deux gardes de
          // cloisonnement de ce chemin : retirer `.eq('pwa_token')` ou
          // `.eq('user_id')` laissait les 1029 tests au vert. Ce sont pourtant
          // elles qui empêchent un porteur de lien de se faire passer pour un
          // autre profil, et une acceptation de traverser les comptes.
          if (table === 'profiles') {
            const bon = a.f.account_user_id === U && a.f.pwa_token === TOKEN
            return Promise.resolve({ data: bon ? profil : null, error: null })
          }
          if (table === 'menages') {
            if (erreurMenage) return Promise.resolve({ data: null, error: erreurMenage })
            const bon = a.f.user_id === U &&
                        String(a.f.property_id) === '209413' &&
                        String(a.f.booking_id) === 'b1' &&
                        a.f.departure_date === '2026-09-05'
            return Promise.resolve({ data: bon ? menage : null, error: null })
          }
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
  // ⚠ Le canal HOTE, pas le canal fondateur. `reportIncident` alerte Thierry ;
  // `alertMenageRefuse` pose une tache in-app visible par l'hote et tente un
  // SMS/email. Le premier commit de ce lot promettait le second et appelait le
  // premier — le guide utilisateur affirmait « vous etes prevenu » pour rien.
  const absNotify = require.resolve(path.join(__dirname, '..', 'lib/alert-notify.js'))
  const mn = new Module(absNotify)
  mn.exports = { alertMenageRefuse: async (opts) => { etat.incidents.push(opts) } }
  mn.loaded = true
  require.cache[absNotify] = mn
  for (const mod of ['../api/menages-public', '../lib/stats-avis', '../lib/attribution-prestataire',
                     '../lib/cron-property-status', '../lib/founder-notify']) {
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

test('l\'acceptation est ATOMIQUE, et elle TRANSFÈRE', async () => {
  // ⚠ Tester l'état avant de l'écrire laisserait une fenêtre entre les deux :
  // l'hôte réassigne, ou l'offre expire, et deux personnes se croient engagées
  // sur le même ménage. La condition doit être posée par la base.
  // ⚠ Et c'est ICI, et seulement ici, que la responsabilité change de mains.
  const etat = preparer({})
  const handler = require('../api/menages-public')
  await handler(post('accepterMenage'), reponse())
  const maj = etat.majs[0]
  assert.strictEqual(maj.f.offered_to, MARIE, 'l\'update exige que l\'offre lui soit adressée')
  assert.ok(maj.gt && maj.gt.c === 'offer_expires_at', 'et qu\'elle ne soit pas expirée')
  assert.strictEqual(maj.row.provider_id, MARIE, 'le porteur devient elle')
  assert.strictEqual(maj.row.offered_to, null, 'et la proposition s\'efface')
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

test('refuser un ménage PORTÉ par la référente : il reste chez elle', async () => {
  // ⚠ LA RÈGLE DU 4 SEPTEMBRE. Un refus n'efface que la PROPOSITION, jamais le
  // porteur. Rien n'est découvert — la référente l'a toujours eu — donc rien
  // n'appelle une alerte. Avant, le refus mettait le ménage en `orphaned` et
  // laissait un logement sans personne alors qu'une référente le couvrait.
  const etat = preparer({})
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('refuserMenage'), res)
  assert.strictEqual(res.body.porte, true)
  assert.strictEqual(etat.majs[0].row.offered_to, null, 'la proposition s\'efface')
  assert.strictEqual(etat.majs[0].row.provider_id, undefined, 'le porteur n\'est pas touché')
  assert.strictEqual(etat.majs[0].row.status, undefined, 'le statut non plus')
})

test('un refus sur un ménage porté n\'ALERTE PAS', async () => {
  // Rien n'est découvert : alerter serait du bruit, et l'hôte finirait par ne
  // plus lire ces messages.
  const etat = preparer({})
  const handler = require('../api/menages-public')
  await handler(post('refuserMenage'), reponse())
  assert.strictEqual(etat.incidents.length, 0)
})

test('refuser un ménage que PERSONNE ne porte : orphaned, et l\'hôte est alerté', async () => {
  // Le seul cas grave : un bien sans référente. Là, un logement ne sera pas
  // préparé, et c'est à l'hôte de trancher.
  const etat = preparer({ menage: { id: 'm1', provider_id: null, offered_to: MARIE, status: 'offered' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('refuserMenage'), res)
  // ⚠ `porte` est la vraie information : le statut renvoyé était INVENTÉ quand
  // quelqu'un portait le ménage, puisque la base n'était pas touchée.
  assert.strictEqual(res.body.porte, false)
  assert.strictEqual(etat.majs[0].row.status, 'orphaned')
  assert.strictEqual(etat.majs[0].row.assigned_by, 'manual', 'décision humaine, verrouillée')
  assert.strictEqual(etat.incidents.length, 1)
  assert.strictEqual(etat.incidents[0].prenom, 'Marie', 'l\'hôte doit savoir QUI a refusé')
})

test('le refus est atomique : il ne touche que SA proposition', async () => {
  const etat = preparer({})
  const handler = require('../api/menages-public')
  await handler(post('refuserMenage'), reponse())
  assert.strictEqual(etat.majs[0].f.offered_to, MARIE)
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
  const etat = preparer({ menage: { id: 'm1', provider_id: REGINA, offered_to: 'p-tiers', status: 'accepted' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('accepterMenage'), res)
  assert.strictEqual(res.code, 409)
  assert.strictEqual(etat.majs[0].f.offered_to, MARIE, 'la condition porte SON identifiant')
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

// ─── Les deux gardes de cloisonnement ──────────────────────────────────────
// ⚠ Elles n'étaient couvertes par rien : le double rendait profil et ménage
// quels que soient les filtres posés. Les retirer laissait 1029 tests au vert.

test('le profil est résolu par SON jeton, sur SON compte', async () => {
  // Sans `.eq('pwa_token', token)`, un porteur de lien répondrait à une offre au
  // nom du premier profil venu du compte.
  const etat = preparer({})
  const handler = require('../api/menages-public')
  await handler(post('accepterMenage'), reponse())
  const q = etat.requetes.find(r => r.table === 'profiles')
  assert.strictEqual(q.f.pwa_token, TOKEN)
  assert.strictEqual(q.f.account_user_id, U)
})

test('le ménage est cherché SUR LE COMPTE du token', async () => {
  // Sans `.eq('user_id', userId)`, une acceptation traverserait les comptes :
  // `booking_id` et `provider_property_id` n'ont aucune unicité globale.
  const etat = preparer({})
  const handler = require('../api/menages-public')
  await handler(post('accepterMenage'), reponse())
  const q = etat.requetes.find(r => r.table === 'menages' && r.f.booking_id)
  assert.strictEqual(q.f.user_id, U)
})

test('accepter un ménage ANNULÉ est refusé', async () => {
  // Une PWA restée ouverte sur un ménage dont la réservation a disparu pouvait
  // le repasser en `accepted` avec un porteur — un ménage vivant pour une
  // réservation qui ne l'est plus.
  const etat = preparer({ menage: { id: 'm1', provider_id: null, offered_to: MARIE, status: 'cancelled' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('accepterMenage'), res)
  assert.strictEqual(res.code, 409)
  assert.strictEqual(etat.journal.length, 0)
})
