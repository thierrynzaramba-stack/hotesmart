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

// ⚠ « ATTITRÉE TOUS LES JOURS », ÉCRIT EXPLICITEMENT. Depuis la restriction du
// 4 septembre 2026, une liaison qui doit confirmer et dont les `weekdays` ne sont
// PAS réglés n'est jamais sollicitée — pas de proposition, donc pas de SMS, tant
// que l'écran du lot 3.5 n'existe pas. Les fixtures qui veulent une proposition
// doivent donc déclarer leurs jours, comme le fera l'hôte.
const TOUS_LES_JOURS = [0, 1, 2, 3, 4, 5, 6]


function preparer ({ profil = { id: MARIE, first_name: 'Marie', active: true },
                     menage = { id: 'm1', provider_id: REGINA, proposee_a: [MARIE], status: 'accepted' },
                     majTouche = true, erreurMaj = null, erreurMenage = null,
                     // Lot 3.3 : de quoi calculer la remplaçante du jour.
                     liaisons = [], regles = [], exceptions = [], refus = [],
                     erreurLiaisons = null,
                     // Ce que rend la relecture d'après une course perdue
                     // (`.eq('id', …)`) : la ligne telle qu'une collègue l'a laissée.
                     relu = null } = {}) {
  const etat = { majs: [], journal: [], incidents: [], requetes: [], notifs: [] }
  const client = {
    from (table) {
      const a = { table, f: {}, cond: {} }
      etat.requetes.push(a)
      const chain = {
        select () { return chain },
        eq (c, v) { a.f[c] = v; return chain },
        neq () { return chain }, in () { return chain }, is () { return chain },
        gte () { return chain }, lte () { return chain }, not () { return chain },
        order () { return chain },
        range (from) {
          if (from !== 0) return Promise.resolve({ data: [], error: null })
          if (table === 'property_cleaning_providers') {
            return Promise.resolve({ data: erreurLiaisons ? null : liaisons, error: erreurLiaisons })
          }
          if (table === 'provider_availability_rules') return Promise.resolve({ data: regles, error: null })
          if (table === 'provider_availability_exceptions') return Promise.resolve({ data: exceptions, error: null })
          if (table === 'menage_assignment_log') return Promise.resolve({ data: refus, error: null })
          return Promise.resolve({ data: [], error: null })
        },
        limit () {
          if (table === 'provider_availability_rules') return Promise.resolve({ data: regles, error: null })
          if (table === 'provider_availability_exceptions') return Promise.resolve({ data: exceptions, error: null })
          if (table === 'menage_assignment_log') return Promise.resolve({ data: refus, error: null })
          return Promise.resolve({ data: [], error: null })
        },
        insert (rows) { etat.journal.push(...[].concat(rows)); return Promise.resolve({ error: null }) },
        update (row) {
          const q = { row, f: {} }
          const c2 = {
            eq (c, v) { q.f[c] = v; return c2 },
            gt (c, v) { q.gt = { c, v }; return c2 },
            neq (c, v) { q.neq = { c, v }; return c2 },
            contains (c, v) { q.cs = v; return c2 },
            containedBy (c, v) { q.cd = v; return c2 },
            select () {
              etat.majs.push({ table, ...q })
              // ⚠ L'update est CONDITIONNEL : le double le simule. Sans cela,
              // retirer `.eq('status','offered')` du code ne casserait rien —
              // et c'est précisément la garde anti double affectation.
              // ⚠ LE DOUBLE APPLIQUE LA CONDITION. Rendre une valeur préréglée
              // laissait passer le retrait de `.eq('offered_to', …)` ou de la
              // garde d'expiration — c'est pourtant tout ce qui empêche une
              // double affectation. Vérifié : la mutation fait tomber ce test.
              // ⚠ LA CONDITION PORTE SUR LE TOUR (spec proposition-par-rang) :
              // `contains` = elle y est encore ; `containedBy` en plus = le tour
              // est exactement celui lu. Le double la rejoue comme PostgREST.
              const tour = (menage && menage.proposee_a) || []
              const viseSonOffre = (!q.cs || q.cs.every(x => tour.includes(x))) &&
                                   (!q.cd || tour.every(x => q.cd.includes(x)))
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
            if (a.f.id) return Promise.resolve({ data: a.f.id === 'm1' ? relu : null, error: null })
            const bon = a.f.user_id === U &&
                        String(a.f.property_id) === '209413' &&
                        String(a.f.booking_id) === 'b1' &&
                        a.f.departure_date === DEPART
            return Promise.resolve({ data: bon ? menage : null, error: null })
          }
          return Promise.resolve({ data: null, error: null })
        },
        then (ok) {
          // `chargerLiaisons` termine par `.order()` : c'est ici qu'elle atterrit.
          if (table === 'property_cleaning_providers') {
            return Promise.resolve({ data: erreurLiaisons ? null : liaisons,
                                     error: erreurLiaisons }).then(ok)
          }
          return Promise.resolve({ data: [], error: null }).then(ok)
        }
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
  // ⚠ Sans ce double, l'escalade enverrait un VRAI SMS depuis les tests.
  const absPresta = require.resolve(path.join(__dirname, '..', 'lib/cleaning/notifier-prestataire.js'))
  const mp = new Module(absPresta)
  mp.exports = {
    notifierProposition: async (o) => { etat.notifs.push(o); return { sms: true, email: false } },
    notifierAssignation: async () => ({ sms: false, email: false }),
    jourLisible: d => String(d)
  }
  mp.loaded = true
  require.cache[absPresta] = mp
  for (const mod of ['../api/menages-public', '../lib/stats-avis', '../lib/attribution-prestataire',
                     '../lib/cron-property-status', '../lib/founder-notify',
                     '../lib/cleaning/assign']) {
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
// ⚠ DATE RELATIVE. Un départ figé au 5 septembre 2026 est sorti de la fenêtre de
// proposition (J-1 .. J+7) le 7 septembre, et quatre tests d'escalade sont passés
// au rouge sans qu'une ligne de code ait bougé : l'endpoint lit l'horloge réelle.
const DEPART = (() => {
  const d = new Date()
  d.setDate(d.getDate() + 3)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})()

const post = (action, over = {}) => ({
  method: 'POST', query: { token: TOKEN }, headers: {},
  body: { action, booking_id: 'b1', property_id: '209413', departure_date: DEPART, ...over }
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
  assert.deepStrictEqual(maj.cs, [MARIE], 'l\'update exige qu\'elle soit encore dans le tour')
  assert.ok(maj.gt && maj.gt.c === 'offer_expires_at', 'et qu\'elle ne soit pas expirée')
  assert.strictEqual(maj.row.provider_id, MARIE, 'le porteur devient elle')
  assert.strictEqual(maj.row.proposee_a, null, 'et la proposition s\'efface')
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
  assert.strictEqual(etat.majs[0].row.proposee_a, null, 'la proposition s\'efface')
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
  const etat = preparer({ menage: { id: 'm1', provider_id: null, proposee_a: [MARIE], status: 'offered' } })
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
  assert.deepStrictEqual(etat.majs[0].cs, [MARIE])
  assert.deepStrictEqual(etat.majs[0].cd, [MARIE], 'et sur le tour exact lu')
})

// ─── L'ESCALADE APRÈS UN REFUS (lot 3.3, §12.4) ────────────────────────────

const TROISIEME = 'p-troisieme'
const LIAISONS_TROIS = [
  { user_id: U, property_id: '209413', provider_id: REGINA, rang: 1, requires_ack: false, active: true },
  { user_id: U, property_id: '209413', provider_id: MARIE, rang: 2, requires_ack: true, weekdays: TOUS_LES_JOURS, active: true },
  { user_id: U, property_id: '209413', provider_id: TROISIEME, rang: 3, requires_ack: true, weekdays: TOUS_LES_JOURS, active: true }
]

test('refuser : la REMPLAÇANTE du jour prend le relais, dans le même écrit', async () => {
  // ⚠ Calculée AVANT d'écrire et posée dans le MÊME update : la calculer après
  // laisserait le ménage sans proposition entre les deux écritures — et, quand
  // personne ne le porte, `orphaned` avec une alerte pour rien.
  const etat = preparer({ liaisons: LIAISONS_TROIS })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('refuserMenage'), res)
  assert.strictEqual(res.body.escalade, true)
  const maj = etat.majs.find(m => m.table === 'menages')
  assert.deepStrictEqual(maj.row.proposee_a, [TROISIEME])
  assert.ok(maj.row.offer_expires_at, 'une proposition sans échéance est refusée par la base')
  assert.deepStrictEqual(maj.cs, [MARIE], 'la condition reste atomique sur SA proposition')
  assert.strictEqual(etat.notifs.length, 1, 'une proposition muette expire sans que personne ne sache')
  assert.strictEqual(etat.notifs[0].providerId, TROISIEME)
})

test('l\'escalade laisse au journal le refus ET la nouvelle proposition', async () => {
  const etat = preparer({ liaisons: LIAISONS_TROIS })
  const handler = require('../api/menages-public')
  await handler(post('refuserMenage'), reponse())
  assert.ok(etat.journal.find(l => l.event === 'declined' && l.from_provider_id === MARIE))
  const offre = etat.journal.find(l => l.event === 'offered')
  assert.ok(offre && offre.to_provider_id === TROISIEME)
  assert.strictEqual(offre.actor, 'cron', 'ce n\'est pas celle qui refuse qui choisit sa remplaçante')
})

test('une escalade réussie N\'ALERTE PAS l\'hôte', async () => {
  // Quelqu'un vient d'être sollicité : rien n'est découvert. Si elle ne répond
  // pas, l'expiration reprendra la main — et alertera, la file étant épuisée.
  const etat = preparer({
    menage: { id: 'm1', provider_id: null, proposee_a: [MARIE], status: 'offered' },
    liaisons: [
      { user_id: U, property_id: '209413', provider_id: MARIE, rang: 1, requires_ack: true, weekdays: TOUS_LES_JOURS, active: true },
      { user_id: U, property_id: '209413', provider_id: TROISIEME, rang: 2, requires_ack: true, weekdays: TOUS_LES_JOURS, active: true }
    ]
  })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('refuserMenage'), res)
  assert.strictEqual(res.body.escalade, true)
  assert.strictEqual(etat.incidents.length, 0)
  const maj = etat.majs.find(m => m.table === 'menages')
  assert.strictEqual(maj.row.status, 'offered', 'personne ne porte : le statut le dit')
  assert.deepStrictEqual(maj.row.proposee_a, [TROISIEME])
})

test('personne d\'AUTRE : on retombe sur le modèle parallèle, sans boucle', async () => {
  // ⚠ La seule candidate qui doit confirmer vient de refuser : la file est
  // épuisée. Lui reproposer serait une boucle dont personne ne sortirait.
  const etat = preparer({ liaisons: [
    { user_id: U, property_id: '209413', provider_id: REGINA, rang: 1, requires_ack: false, active: true },
    { user_id: U, property_id: '209413', provider_id: MARIE, rang: 2, requires_ack: true, weekdays: TOUS_LES_JOURS, active: true }
  ] })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('refuserMenage'), res)
  assert.strictEqual(res.body.escalade, false)
  assert.strictEqual(res.body.porte, true)
  const maj = etat.majs.find(m => m.table === 'menages')
  assert.strictEqual(maj.row.proposee_a, null)
  assert.strictEqual(etat.notifs.length, 0)
})

test('qui a DÉJÀ refusé ce ménage n\'est pas resollicité', async () => {
  // La mémoire est le journal : `declined` et `expired`.
  const etat = preparer({
    liaisons: LIAISONS_TROIS,
    refus: [{ menage_id: 'm1', from_provider_id: TROISIEME, event: 'expired' }]
  })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('refuserMenage'), res)
  assert.strictEqual(res.body.escalade, false, 'la file est épuisée')
  assert.strictEqual(etat.majs.find(m => m.table === 'menages').row.proposee_a, null)
})

test('une PANNE du calcul de la remplaçante n\'empêche PAS le refus', async () => {
  // ⚠ Faire échouer un refus parce que le calcul est en panne obligerait la
  // prestataire à réessayer — ou, pire, la laisserait engagée. On retombe sur
  // le comportement du modèle parallèle.
  const etat = preparer({ liaisons: LIAISONS_TROIS, erreurLiaisons: { message: 'timeout' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('refuserMenage'), res)
  assert.strictEqual(res.body.success, true)
  assert.strictEqual(res.body.escalade, false)
  assert.strictEqual(etat.majs.find(m => m.table === 'menages').row.proposee_a, null)
})

test('la remplaçante n\'est JAMAIS la porteuse (contrainte `offre_pas_a_soi`)', async () => {
  // Si la garde du jour désignait la porteuse elle-même, l'update violerait
  // `menages_offre_pas_a_soi` — et le refus échouerait avec elle.
  const etat = preparer({
    menage: { id: 'm1', provider_id: TROISIEME, proposee_a: [MARIE], status: 'accepted' },
    liaisons: [
      { user_id: U, property_id: '209413', provider_id: MARIE, rang: 1, requires_ack: true, weekdays: TOUS_LES_JOURS, active: true },
      { user_id: U, property_id: '209413', provider_id: TROISIEME, rang: 2, requires_ack: true, weekdays: TOUS_LES_JOURS, active: true }
    ]
  })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('refuserMenage'), res)
  assert.strictEqual(res.body.escalade, false)
  assert.strictEqual(etat.majs.find(m => m.table === 'menages').row.proposee_a, null)
})

test('escalade sur un ménage SANS porteur : la candidate d\'office est posée', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW. `remplacanteApresRefus` ne retenait que
  // `choix.offeredTo` : sur un ménage que personne ne porte alors que la garde du
  // jour désigne quelqu'un d'office — l'hôte vient de la lier, ou son congé s'est
  // terminé — le refus écrivait `offered` avec `provider_id` toujours nul. La
  // candidate d'office ne le recevait jamais, et le writer sautait la ligne
  // puisqu'une proposition y est posée.
  const etat = preparer({
    menage: { id: 'm1', provider_id: null, proposee_a: [MARIE], status: 'offered' },
    liaisons: [
      { user_id: U, property_id: '209413', provider_id: MARIE, rang: 1, requires_ack: true, weekdays: TOUS_LES_JOURS, active: true },
      { user_id: U, property_id: '209413', provider_id: REGINA, rang: 2, requires_ack: false, active: true },
      { user_id: U, property_id: '209413', provider_id: TROISIEME, rang: 3, requires_ack: true, weekdays: TOUS_LES_JOURS, active: true }
    ]
  })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('refuserMenage'), res)
  const maj = etat.majs.find(m => m.table === 'menages')
  assert.strictEqual(maj.row.provider_id, REGINA, 'la porteuse d\'office prend la charge')
  assert.strictEqual(maj.row.status, 'accepted')
  assert.ok(maj.row.accepted_at)
  assert.deepStrictEqual(maj.row.proposee_a, [TROISIEME], 'et la suivante est sollicitée à côté')
})

test('SANS aucun jour réglé — l\'état réel de la prod — la porteuse est quand même posée', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW. `remplacanteApresRefus` sortait dès qu'il n'y
  // avait personne à SOLLICITER — or depuis la restriction sur les jours
  // attitrés, c'est le cas de TOUS les biens en production tant que l'écran du
  // lot 3.5 n'existe pas. Le repli sur la porteuse d'office était donc mort, et
  // le refus partait en `orphaned` + verrou `manual` : plus aucun chemin ne
  // reprend ce ménage — ni le writer, ni la pose différée, ni le rattrapage — et
  // le logement reste sans personne pour toujours, avec une candidate d'office
  // juste à côté.
  const etat = preparer({
    menage: { id: 'm1', provider_id: null, proposee_a: [MARIE], status: 'offered' },
    liaisons: [
      { user_id: U, property_id: '209413', provider_id: MARIE, rang: 1, weekdays: null, requires_ack: true, active: true },
      { user_id: U, property_id: '209413', provider_id: REGINA, rang: 2, weekdays: null, requires_ack: false, active: true }
    ]
  })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('refuserMenage'), res)
  const maj = etat.majs.find(m => m.table === 'menages')
  assert.strictEqual(maj.row.provider_id, REGINA, 'la personne de garde reprend le ménage')
  assert.strictEqual(maj.row.status, 'accepted')
  assert.strictEqual(maj.row.proposee_a, null, 'personne à solliciter : aucune offre posée')
  assert.notStrictEqual(maj.row.assigned_by, 'manual', 'et surtout : AUCUN verrou')
  assert.strictEqual(res.body.porte, true, 'quelqu\'un a la charge du ménage')
  assert.strictEqual(res.body.escalade, false, 'mais personne n\'a été sollicité')
  assert.strictEqual(etat.incidents.length, 0, 'donc aucune alerte : rien n\'est découvert')
  assert.ok(etat.journal.find(l => l.event === 'assigned' && l.to_provider_id === REGINA))
})

test('ni porteuse ni personne à solliciter : là, le verrou et l\'alerte', async () => {
  const etat = preparer({
    menage: { id: 'm1', provider_id: null, proposee_a: [MARIE], status: 'offered' },
    liaisons: [
      { user_id: U, property_id: '209413', provider_id: MARIE, rang: 1, weekdays: null, requires_ack: true, active: true }
    ]
  })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('refuserMenage'), res)
  const maj = etat.majs.find(m => m.table === 'menages')
  assert.strictEqual(maj.row.status, 'orphaned')
  assert.strictEqual(maj.row.assigned_by, 'manual', 'une décision humaine est attendue')
  assert.strictEqual(res.body.porte, false)
  assert.strictEqual(etat.incidents.length, 1, 'l\'hôte doit trancher')
})

test('la PWA ne promet pas une alerte que le serveur n\'envoie pas', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW, même classe que le commit c6d0553. Le serveur
  // n'alerte l'hôte que si `!porte && !suivante` ; la PWA affichait « votre
  // employeur est prévenu » dès que `porte` était faux — donc aussi après une
  // escalade réussie, où personne n'a été prévenu.
  const front = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'apps/menages/public.html'), 'utf8')
  assert.ok(front.includes('data.escalade'),
    'le front doit lire `escalade` avant d\'annoncer une alerte')
  const i = front.indexOf('votre employeur est prévenu')
  assert.ok(i > 0 && front.lastIndexOf('data.escalade', i) > 0,
    'la promesse d\'alerte doit être le dernier cas, après `porte` et `escalade`')
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
  // au nom de personne. ⚠ 401 depuis la fermeture du pont de convergence : le
  // lien est invalide, pas seulement insuffisant pour ce geste.
  const etat = preparer({ profil: null })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('accepterMenage'), res)
  assert.strictEqual(res.code, 401)
  assert.strictEqual(etat.majs.length, 0)
})

test('un profil DÉSACTIVÉ non plus', async () => {
  const etat = preparer({ profil: { id: MARIE, first_name: 'Marie', active: false, access_mode: 'lien' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('accepterMenage'), res)
  assert.strictEqual(res.code, 401)
  assert.strictEqual(etat.majs.length, 0)
})

test('on ne répond pas à l\'offre de quelqu\'un d\'autre', async () => {
  // La condition atomique s'en charge : l'update ne touche rien.
  const etat = preparer({ menage: { id: 'm1', provider_id: REGINA, proposee_a: ['p-tiers'], status: 'accepted' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('accepterMenage'), res)
  assert.strictEqual(res.code, 409)
  assert.deepStrictEqual(etat.majs[0].cs, [MARIE], 'la condition porte SON identifiant')
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
  const etat = preparer({ menage: { id: 'm1', provider_id: null, proposee_a: [MARIE], status: 'cancelled' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('accepterMenage'), res)
  assert.strictEqual(res.code, 409)
  assert.strictEqual(etat.journal.length, 0)
})

// ─── LE TOUR D'UN RANG (spec proposition-par-rang, 2 octobre 2026) ─────────
// Marie et Lena sont au rang 1 et sollicitées EN MÊME TEMPS ; la troisième au
// rang 2 attend que tout le rang 1 ait répondu ou laissé expirer.
const LENA = 'p-lena'
const LIAISONS_RANG = [
  { user_id: U, property_id: '209413', provider_id: MARIE, rang: 1, requires_ack: true, weekdays: TOUS_LES_JOURS, active: true },
  { user_id: U, property_id: '209413', provider_id: LENA, rang: 1, requires_ack: true, weekdays: TOUS_LES_JOURS, active: true },
  { user_id: U, property_id: '209413', provider_id: TROISIEME, rang: 2, requires_ack: true, weekdays: TOUS_LES_JOURS, active: true },
  { user_id: U, property_id: '209413', provider_id: 'p-quatrieme', rang: 2, requires_ack: true, weekdays: TOUS_LES_JOURS, active: true }
]
const TOUR_DE_DEUX = { id: 'm1', provider_id: null, proposee_a: [MARIE, LENA], status: 'offered' }

test('rang de deux : la PREMIÈRE qui accepte l\'a, et les autres ne reçoivent aucun SMS', async () => {
  const etat = preparer({ menage: { ...TOUR_DE_DEUX }, liaisons: LIAISONS_RANG })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('accepterMenage'), res)
  assert.strictEqual(res.body.status, 'accepted')
  const maj = etat.majs.find(m => m.table === 'menages')
  assert.strictEqual(maj.row.provider_id, MARIE)
  assert.strictEqual(maj.row.proposee_a, null, 'le tour entier s\'efface : Lena ne voit plus la proposition')
  assert.deepStrictEqual(maj.cs, [MARIE], 'la condition : « je suis encore dans le tour »')
  assert.strictEqual(etat.notifs.length, 0, 'décision 4 : aucun SMS aux autres quand l\'une accepte')
})

test('rang de deux : la SECONDE qui accepte lit « Déjà pris par une collègue »', async () => {
  // Lena a accepté entre la lecture et l'écriture : le tour a été vidé, la
  // condition ne touche rien, et la relecture montre Lena en porteuse.
  const etat = preparer({ menage: { ...TOUR_DE_DEUX }, majTouche: false,
                          relu: { provider_id: LENA } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('accepterMenage'), res)
  assert.strictEqual(res.code, 409)
  assert.strictEqual(res.body.error, 'Déjà pris par une collègue.')
  assert.ok(!etat.journal.some(l => l.event === 'accepted'), 'une course perdue n\'écrit rien au journal')
})

test('un refus dans un rang de deux NE CLÔT PAS le tour : la collègue reste sollicitée', async () => {
  const etat = preparer({ menage: { ...TOUR_DE_DEUX }, liaisons: LIAISONS_RANG })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('refuserMenage'), res)
  assert.strictEqual(res.body.escalade, false)
  const maj = etat.majs.find(m => m.table === 'menages')
  assert.deepStrictEqual(maj.row.proposee_a, [LENA], 'elle seule est retirée')
  assert.strictEqual(maj.row.status, undefined, 'le statut ne bouge pas : le tour continue')
  assert.deepStrictEqual([...maj.cs].sort(), [LENA, MARIE].sort(), 'condition sur le tour EXACT lu')
  assert.deepStrictEqual([...maj.cd].sort(), [LENA, MARIE].sort())
  assert.strictEqual(etat.notifs.length, 0, 'le rang 2 n\'est pas sollicité')
  assert.strictEqual(etat.incidents.length, 0, 'décision 3 : un refus isolé n\'alerte pas l\'hôte')
  assert.ok(etat.journal.find(l => l.event === 'declined' && l.from_provider_id === MARIE))
})

test('la DERNIÈRE du tour refuse : le rang suivant est sollicité EN ENTIER', async () => {
  // Lena a déjà refusé (journal) : Marie est seule restante du rang 1.
  const etat = preparer({
    menage: { id: 'm1', provider_id: null, proposee_a: [MARIE], status: 'offered' },
    liaisons: LIAISONS_RANG,
    refus: [{ menage_id: 'm1', from_provider_id: LENA, event: 'declined' }]
  })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('refuserMenage'), res)
  assert.strictEqual(res.body.escalade, true)
  const maj = etat.majs.find(m => m.table === 'menages')
  assert.deepStrictEqual([...maj.row.proposee_a].sort(), [TROISIEME, 'p-quatrieme'].sort())
  assert.ok(!maj.row.proposee_a.includes(LENA), 'qui a déjà refusé n\'est jamais resollicitée')
  assert.deepStrictEqual(etat.notifs.map(n => n.providerId).sort(), [TROISIEME, 'p-quatrieme'].sort(),
    'chacune du rang 2 est prévenue')
  assert.strictEqual(etat.journal.filter(l => l.event === 'offered').length, 2, 'une ligne de journal par personne')
  assert.strictEqual(etat.incidents.length, 0)
})

test('refuser un tour où l\'on N\'EST PAS : 409, rien d\'écrit', async () => {
  const etat = preparer({ menage: { id: 'm1', provider_id: null, proposee_a: [LENA], status: 'offered' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('refuserMenage'), res)
  assert.strictEqual(res.code, 409)
  assert.strictEqual(etat.majs.length, 0)
})

test('course perdue contre l\'HÔTE, pas contre une collègue : « plus disponible », pas « collègue »', async () => {
  // Constat de review : l'hôte a assigné directement quelqu'un HORS du tour.
  preparer({ menage: { ...TOUR_DE_DEUX }, majTouche: false, relu: { provider_id: REGINA } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(post('accepterMenage'), res)
  assert.strictEqual(res.code, 409)
  assert.strictEqual(res.body.error, 'Cette offre n\'est plus disponible')
})

test('un refus partiel efface aussi l\'ancienne colonne : rien de périmé ne reste derrière', async () => {
  const etat = preparer({ menage: { ...TOUR_DE_DEUX, offered_to: MARIE }, liaisons: LIAISONS_RANG })
  const handler = require('../api/menages-public')
  await handler(post('refuserMenage'), reponse())
  const maj = etat.majs.find(m => m.table === 'menages')
  assert.strictEqual(maj.row.offered_to, null)
})
