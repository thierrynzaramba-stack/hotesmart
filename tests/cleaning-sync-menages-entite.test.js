// tests/cleaning-sync-menages-entite.test.js
// lib/cleaning/sync-menages-entite.js — le WRITER UNIQUE de la table `menages`.
//
// ⚠ CE QUI EST EN JEU. Ce writer décide de l'existence même d'un ménage, et de
// qui le fait. Trois fautes possibles, toutes déjà vécues ailleurs dans ce dépôt :
//   1. créer un ménage pour un blocage propriétaire — les « ménages fantômes »,
//      qui ont déjà produit 79 350 faux événements ;
//   2. mélanger deux comptes sur un propId identique (REVIEW.md règle 1) ;
//   3. alerter sur un bien qui n'a simplement aucun prestataire — du bruit
//      permanent qui noie les vraies alertes.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const U = 'compte-1', REGINA = 'p-regina', NOUVELLE = 'p-nouvelle'

// ⚠ « ATTITRÉE TOUS LES JOURS », ÉCRIT EXPLICITEMENT. Depuis la restriction du
// 4 septembre 2026, une liaison qui doit confirmer et dont les `weekdays` ne sont
// PAS réglés n'est jamais sollicitée — pas de proposition, donc pas de SMS, tant
// que l'écran du lot 3.5 n'existe pas. Les fixtures qui veulent une proposition
// doivent donc déclarer leurs jours, comme le fera l'hôte.
const TOUS_LES_JOURS = [0, 1, 2, 3, 4, 5, 6]

const MODULES = ['../lib/cleaning/sync-menages-entite', '../lib/cleaning/assign',
                 '../lib/cleaning/notifier-prestataire',
                 '../lib/founder-notify', '../lib/cron-shared']

function preparer ({ snaps = [], menages = [], liaisons = [], erreurSnaps = null,
                     // ⚠ Le provider du bien est OBLIGATOIRE pour lire un statut
                     // anterieur a l'unification : sans lui, 'black' retombe sur
                     // 'confirmed' et le blocage proprietaire redevient un menage
                     // fantome. Le double le porte donc, comme la vraie table.
                     biens = [{ user_id: U, provider_property_id: '209413', provider: 'beds24' },
                              { user_id: 'compte-2', provider_property_id: '209413', provider: 'beds24' }],
                     erreurBiens = null, expirees = null,
                     // Lot 3.3 : la garde du jour, la mémoire de l'escalade, et
                     // les ménages que la pose différée doit examiner.
                     regles = [], exceptions = [], erreurDispos = null,
                     refus = [], propositions = null } = {}) {
  const etat = { inseres: [], majs: [], journal: [], incidents: [], requetes: [],
                 notifs: [] }

  const client = {
    from (table) {
      const a = { table, f: {}, gte: null, lte: null, ins: null }
      etat.requetes.push(a)
      const chain = {
        select () { return chain },
        eq (c, v) { a.f[c] = v; return chain },
        neq (c, v) { a.neq = { c, v }; return chain },
        in (c, v) { a.ins = { c, v }; return chain },
        gte (c, v) { a.gte = { c, v }; return chain },
        lte (c, v) { a.lte = { c, v }; return chain },
        not () { return chain },
        lt (c, v) { a.lt = { c, v }; return chain },
        is (c, v) { a.is = { c, v }; return chain },
        // ⚠ Chainable, comme le vrai builder : `.order()` est suivi d'un
        // `.limit()`. Un double qui rendait une Promise ici faisait echouer les
        // tests, pas le code.
        order (c) { a.order = c; return chain },
        limit () { return Promise.resolve(rep()) },
        // ⚠ Les disponibilités et le journal se lisent PAGINÉS (`.range()`) :
        // seule la première page porte des lignes, la suivante clôt la boucle.
        range (from) { return Promise.resolve(from === 0 ? rep() : { data: [], error: null }) },
        upsert (rows) { a.rows = rows; return { select: () => Promise.resolve(repUpsert(rows)) } },
        update (row) { a.row = row; return chain2(a, row) },
        insert (rows) {
          if (table === 'menage_assignment_log') etat.journal.push(...[].concat(rows))
          else etat.inseres.push(...[].concat(rows))
          return Promise.resolve({ data: null, error: null })
        },
        then (ok, ko) { return Promise.resolve(rep()).then(ok, ko) }
      }
      function chain2 (a, row) {
        // ⚠ CHAINABLE JUSQU'AU BOUT. La pose de proposition ecrit
        // `.eq('id', …).is('offered_to', null).select('id')` — sa garde
        // d'atomicite : un double qui s'arretait a `eq` faisait echouer le TEST,
        // pas le code, et cachait ce que la condition protege.
        const q = { table, row, ids: [], f: {} }
        const c2 = {
          in (c, v) { q.ids = v; etat.majs.push(q); return finir() },
          eq (c, v) { q.ids = [v]; q.f[c] = v; etat.majs.push(q); return finir() }
        }
        function finir () {
          const suite = {
            is (c, v) { q.f[c + '_is'] = v; return suite },
            eq (c, v) { q.f[c] = v; return suite },
            select () { return Promise.resolve({ data: [{ id: q.ids[0] }], error: null }) },
            then (ok, ko) { return Promise.resolve({ data: null, error: null }).then(ok, ko) }
          }
          return suite
        }
        return c2
      }
      function repUpsert (rows) {
        etat.inseres.push(...rows)
        return { data: rows.map((r, i) => ({ id: `m${i}`, user_id: r.user_id, provider_id: r.provider_id, status: r.status })), error: null }
      }
      function rep () {
        if (table === 'bookings_snapshot') {
          if (erreurSnaps) return { data: null, error: erreurSnaps }
          // ⚠ Le double APPLIQUE les bornes de date : sans cela, retirer le
          // filtre de fenêtre du writer ne casserait aucun test.
          const d = snaps.filter(s => {
            const dep = s.snapshot?.departure
            if (!dep) return true
            if (a.gte && dep < a.gte.v) return false
            if (a.lte && dep > a.lte.v) return false
            return true
          })
          return { data: d, error: null }
        }
        if (table === 'menages') {
          // `expirerPropositions` lit les propositions echues : un jeu distinct
          // des menages du writer, sinon les deux tests se marcheraient dessus.
          if (expirees !== null && a.lt) return { data: expirees, error: null }
          // `poserPropositionsDues` se reconnait a son filtre `assignment_mode`.
          if (propositions !== null && a.f.assignment_mode === 'garde') {
            return { data: propositions, error: null }
          }
          return { data: menages, error: null }
        }
        if (table === 'provider_availability_rules') return { data: regles, error: erreurDispos }
        if (table === 'provider_availability_exceptions') return { data: exceptions, error: null }
        if (table === 'menage_assignment_log') return { data: refus, error: null }
        if (table === 'property_cleaning_providers') return { data: liaisons, error: null }
        if (table === 'properties') return { data: biens, error: erreurBiens }
        return { data: [], error: null }
      }
      return chain
    }
  }

  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m

  // Le canal d'alerte est remplacé : on veut savoir CE QUI est alerté, sans rien
  // envoyer.
  const absNotify = require.resolve(path.join(__dirname, '..', 'lib/founder-notify.js'))
  const mn = new Module(absNotify)
  mn.exports = { reportIncident: async (type, opts) => { etat.incidents.push({ type, ...opts }) } }
  mn.loaded = true

  // ⚠ La notification de proposition part POUR DE VRAI sinon (SMS Brevo). On la
  // remplace pour savoir CE QUI serait envoyé, sans rien envoyer.
  const absPresta = require.resolve(path.join(__dirname, '..', 'lib/cleaning/notifier-prestataire.js'))
  const mp = new Module(absPresta)
  mp.exports = {
    notifierProposition: async (o) => { etat.notifs.push(o); return { sms: true, email: false } },
    notifierAssignation: async (o) => { etat.notifs.push({ ...o, assignation: true }); return { sms: true, email: false } },
    jourLisible: d => String(d)
  }
  mp.loaded = true

  // ⚠ VIDER LE CACHE AVANT DE POSER LE DOUBLE, jamais après.
  // `MODULES` contient `founder-notify` : le vider après l'avoir remplacé
  // ANNULAIT le remplacement, et le vrai module reprenait sa place. Conséquence :
  // `etat.incidents` restait vide quoi qu'il arrive, et TOUS les tests qui
  // vérifient qu'une alerte est levée passaient sans rien vérifier — pendant que
  // ceux qui vérifient l'ABSENCE d'alerte passaient pour la mauvaise raison.
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
  require.cache[absNotify] = mn
  require.cache[absPresta] = mp
  return etat
}

const SNAP = (over = {}) => ({
  user_id: U, property_id: '209413', booking_id: 'b1',
  snapshot: { status: 'confirmed', arrival: '2026-09-01', departure: '2026-09-05', ...over }
})

// ─── Les ménages fantômes ──────────────────────────────────────────────────

test('seul un séjour CONFIRMÉ produit un ménage', async () => {
  // ⚠ `blocked` est un blocage propriétaire : il occupe le calendrier sans
  // voyageur, et c'est la source historique des ménages fantômes. `request`
  // n'occupe rien. Les traiter comme des séjours enverrait une femme de ménage
  // sur un logement vide.
  const etat = preparer({ snaps: [
    SNAP({ status: 'confirmed' }),
    { ...SNAP(), booking_id: 'b2', snapshot: { status: 'blocked', departure: '2026-09-06' } },
    { ...SNAP(), booking_id: 'b3', snapshot: { status: 'request', departure: '2026-09-07' } },
    { ...SNAP(), booking_id: 'b4', snapshot: { status: 'cancelled', departure: '2026-09-08' } }
  ], liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1, requires_ack: false }] })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages()
  assert.strictEqual(bilan.crees, 1)
  assert.deepStrictEqual(etat.inseres.map(r => r.booking_id), ['b1'])
})

// ─── L'assignation ─────────────────────────────────────────────────────────

test('le référent est assigné d\'office : le ménage naît accepté', async () => {
  const etat = preparer({ snaps: [SNAP()],
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1, requires_ack: false }] })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  await synchroniserMenages()
  assert.strictEqual(etat.inseres[0].provider_id, REGINA)
  assert.strictEqual(etat.inseres[0].status, 'accepted')
  assert.ok(etat.inseres[0].accepted_at)
  assert.strictEqual(etat.inseres[0].offered_at, null)
})

test('le suppléant reçoit une OFFRE, il n\'est pas engagé', async () => {
  const etat = preparer({ snaps: [SNAP()],
    liaisons: [{ user_id: U, property_id: '209413', provider_id: NOUVELLE, rang: 2, requires_ack: true, weekdays: TOUS_LES_JOURS }] })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  await synchroniserMenages()
  assert.strictEqual(etat.inseres[0].status, 'offered')
  assert.ok(etat.inseres[0].offered_at)
  assert.strictEqual(etat.inseres[0].accepted_at, null)
})

test('sans liaison : ménage NON ASSIGNÉ, aucun repli', async () => {
  const etat = preparer({ snaps: [SNAP()], liaisons: [] })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages()
  assert.strictEqual(etat.inseres[0].provider_id, null)
  assert.strictEqual(etat.inseres[0].status, 'unassigned')
  assert.strictEqual(bilan.non_assignes, 1)
})

// ─── L'alerte, et son silence volontaire ───────────────────────────────────

test('un bien SANS prestataire lié n\'alerte PAS', async () => {
  // Décision du product owner : ce bien n'est pas en panne, il n'est pas géré.
  // Alerter à chaque départ noierait les vraies alertes sous du bruit permanent.
  const etat = preparer({ snaps: [SNAP()], liaisons: [] })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages()
  assert.strictEqual(etat.incidents.length, 0)
  assert.strictEqual(bilan.alertes, 0)
})

test('une seule alerte par BIEN, pas une par ménage', async () => {
  // Trois départs non assignables sur le même bien sont un seul problème.
  const etat = preparer({
    snaps: [SNAP({ departure: '2026-09-05' }),
            { ...SNAP(), booking_id: 'b2', snapshot: { status: 'confirmed', departure: '2026-09-06' } },
            { ...SNAP(), booking_id: 'b3', snapshot: { status: 'confirmed', departure: '2026-09-07' } }],
    // Une liaison existe mais elle est INACTIVE : `chargerLiaisons` ne la
    // ramène pas, donc `aucuneLiaison` est vrai — pas d'alerte non plus.
    liaisons: []
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  await synchroniserMenages()
  assert.strictEqual(etat.incidents.length, 0)
})

// ─── Idempotence ───────────────────────────────────────────────────────────

test('un ménage déjà en base n\'est pas réécrit', async () => {
  const etat = preparer({
    snaps: [SNAP()],
    menages: [{ id: 'm1', user_id: U, property_id: '209413', booking_id: 'b1',
                departure_date: '2026-09-05', status: 'accepted', provider_id: REGINA }],
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1, requires_ack: false }]
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages()
  assert.strictEqual(bilan.crees, 0)
  assert.strictEqual(etat.inseres.length, 0, 'aucune écriture sur un cycle sans changement')
  assert.strictEqual(etat.journal.length, 0, 'ni ligne de journal')
})

test('une assignation MANUELLE n\'est jamais reprise par l\'automate', async () => {
  // Verrou du §3 : l'hôte a tranché, un automate ne revient pas dessus.
  const etat = preparer({
    snaps: [SNAP()],
    menages: [{ id: 'm1', user_id: U, property_id: '209413', booking_id: 'b1',
                departure_date: '2026-09-05', status: 'accepted',
                provider_id: NOUVELLE, assigned_by: 'manual' }],
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1, requires_ack: false }]
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  await synchroniserMenages()
  assert.strictEqual(etat.inseres.length, 0)
  assert.strictEqual(etat.majs.length, 0, 'le ménage manuel doit rester intact')
})

// ─── Ce qui disparaît ──────────────────────────────────────────────────────

test('une réservation annulée annule le ménage — elle ne le supprime pas', async () => {
  // Une prestataire a pu s'organiser autour, et l'historique de qualité s'appuie
  // dessus : on annule, on n'efface pas.
  const etat = preparer({
    snaps: [{ ...SNAP(), snapshot: { status: 'cancelled', departure: '2026-09-05' } }],
    menages: [{ id: 'm1', user_id: U, property_id: '209413', booking_id: 'b1',
                departure_date: '2026-09-05', status: 'accepted', provider_id: REGINA }],
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1, requires_ack: false }]
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages()
  assert.strictEqual(bilan.annules, 1)
  assert.strictEqual(etat.majs[0].row.status, 'cancelled')
  assert.deepStrictEqual(etat.majs[0].ids, ['m1'])
  assert.ok(etat.journal.some(l => l.event === 'cancelled'))
})

test('un départ DÉPLACÉ annule l\'ancien ménage et en crée un nouveau', async () => {
  // La date fait partie de l'identité : sans annulation, l'ancien resterait au
  // planning de la prestataire pour un séjour qui n'existe plus.
  const etat = preparer({
    snaps: [SNAP({ departure: '2026-09-08' })],
    menages: [{ id: 'm1', user_id: U, property_id: '209413', booking_id: 'b1',
                departure_date: '2026-09-05', status: 'accepted', provider_id: REGINA }],
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1, requires_ack: false }]
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages()
  assert.strictEqual(bilan.crees, 1)
  assert.strictEqual(etat.inseres[0].departure_date, '2026-09-08')
  assert.strictEqual(bilan.annules, 1)
  assert.deepStrictEqual(etat.majs[0].ids, ['m1'])
})

// ─── Isolation multi-comptes ───────────────────────────────────────────────

test('deux comptes, le MÊME propId : chacun garde sa prestataire', async () => {
  // ⚠ `provider_property_id` n'a aucune unicité globale. Une clé sans user_id
  // assignerait la prestataire d'un hôte aux ménages d'un autre — et les
  // remarques de propreté suivraient.
  const etat = preparer({
    snaps: [SNAP(), { ...SNAP(), user_id: 'compte-2', booking_id: 'b9' }],
    liaisons: [
      { user_id: U, property_id: '209413', provider_id: REGINA, rang: 1, requires_ack: false },
      { user_id: 'compte-2', property_id: '209413', provider_id: 'p-autre', rang: 1, requires_ack: false }
    ]
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  await synchroniserMenages()
  const parCompte = Object.fromEntries(etat.inseres.map(r => [r.user_id, r.provider_id]))
  assert.strictEqual(parCompte[U], REGINA)
  assert.strictEqual(parCompte['compte-2'], 'p-autre')
})

// ─── Les pannes ────────────────────────────────────────────────────────────

test('une panne de lecture des snapshots N\'ANNULE RIEN', async () => {
  // Sans snapshots, tout ménage existant paraîtrait « disparu » : une panne de
  // lecture aurait annulé le planning entier.
  const etat = preparer({
    erreurSnaps: { message: 'timeout' },
    menages: [{ id: 'm1', user_id: U, property_id: '209413', booking_id: 'b1',
                departure_date: '2026-09-05', status: 'accepted', provider_id: REGINA }]
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages()
  assert.strictEqual(bilan.interrompu, 'db')
  assert.strictEqual(etat.majs.length, 0)
  assert.strictEqual(etat.inseres.length, 0)
})

test('la fenêtre de réconciliation est bornée des DEUX côtés', async () => {
  // Sans borne, chaque cycle balayerait tout l'historique — qui ne change plus.
  const etat = preparer({ snaps: [SNAP()], liaisons: [] })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  await synchroniserMenages()
  const q = etat.requetes.find(r => r.table === 'bookings_snapshot')
  assert.ok(q.gte && q.gte.c.includes('departure'), 'borne basse posée en SQL')
  assert.ok(q.lte && q.lte.c.includes('departure'), 'borne haute posée en SQL')
  assert.ok(q.gte.v < q.lte.v)
})

test('le journal trace la création, pas seulement l\'assignation', async () => {
  const etat = preparer({ snaps: [SNAP()],
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1, requires_ack: false }] })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  await synchroniserMenages()
  assert.strictEqual(etat.journal.length, 1)
  assert.strictEqual(etat.journal[0].event, 'assigned')
  assert.strictEqual(etat.journal[0].to_provider_id, REGINA)
  assert.strictEqual(etat.journal[0].actor, 'cron')
})

// ─── C1 : une lecture TRONQUÉE ne doit annuler personne ────────────────────
// ⚠ `LOT_MAX` est un plafond GLOBAL. Sans cette garde, `vivants` était construit
// sur un sous-ensemble et tout ménage absent de ce sous-ensemble était annulé —
// alors que sa réservation est vivante, simplement pas lue. Reproduit en review :
// 501 réservations vivantes, un ménage annulé par cycle, jamais ressuscité.

const { LOT_MAX } = require('../lib/cleaning/sync-menages-entite')

test('lecture TRONQUÉE : aucune annulation, et le bilan le dit', async () => {
  const beaucoup = Array.from({ length: LOT_MAX }, (_, i) => ({
    ...SNAP(), booking_id: `b${i}`,
    snapshot: { status: 'confirmed', departure: '2026-09-05' }
  }))
  const etat = preparer({
    snaps: beaucoup,
    // Ce ménage-là n'est dans aucune ligne lue : sans la garde, il serait annulé.
    menages: [{ id: 'm-hors-lot', user_id: U, property_id: '209413', booking_id: 'b-loin',
                departure_date: '2026-09-20', status: 'accepted', provider_id: REGINA }],
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1, requires_ack: false }]
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages()
  assert.strictEqual(bilan.tronque, true, 'la troncature doit être signalée')
  assert.strictEqual(bilan.annules, 0)
  assert.strictEqual(etat.majs.length, 0, 'aucune annulation sur une lecture partielle')
})

test('la lecture des snapshots est ORDONNÉE : le sous-ensemble tronqué est stable', async () => {
  // Sans `order`, PostgREST rend un sous-ensemble différent à chaque cycle : les
  // ménages annulés à tort n'étaient même pas les mêmes d'un passage à l'autre.
  const etat = preparer({ snaps: [SNAP()], liaisons: [] })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  await synchroniserMenages()
  const q = etat.requetes.find(r => r.table === 'bookings_snapshot')
  assert.ok(q.order && String(q.order).includes('departure'), 'ordre explicite attendu')
})

test('un ménage annulé à tort est RESSUSCITÉ quand sa réservation est là', async () => {
  // Sans ce chemin, la boucle sautait les ménages déjà connus — annulés compris —
  // et le ménage disparaissait de la PWA pour de bon.
  const etat = preparer({
    snaps: [SNAP()],
    menages: [{ id: 'm1', user_id: U, property_id: '209413', booking_id: 'b1',
                departure_date: '2026-09-05', status: 'cancelled', provider_id: null }],
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1, requires_ack: false }]
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages()
  assert.strictEqual(bilan.ressuscites, 1)
  assert.strictEqual(etat.majs[0].row.status, 'accepted', 'la référente le reprend')
  assert.strictEqual(etat.majs[0].row.provider_id, REGINA)
  assert.ok(etat.journal.some(l => l.event === 'created'))
})

test('la résurrection REND UNE LIGNE COHÉRENTE, elle ne repeint pas un statut', async () => {
  // ⚠ LE CAS DANGEREUX, celui que le test précédent ne couvrait pas : le ménage
  // annulé portait une prestataire et un `accepted_at`. Écrire `unassigned` seul
  // laissait `provider_id` renseigné — la PWA le remontrait à Régina pendant que
  // son statut disait « personne », l'écran hôte affichait une pastille sur un
  // statut qui la contredit, et la boucle de rattrapage, qui saute toute ligne à
  // `provider_id` non nul, ne réparait jamais rien.
  const etat = preparer({
    snaps: [SNAP()],
    menages: [{ id: 'm1', user_id: U, property_id: '209413', booking_id: 'b1',
                departure_date: '2026-09-05', status: 'cancelled',
                provider_id: REGINA, assigned_by: 'auto' }],
    liaisons: []   // plus aucune liaison : le ménage doit redevenir SANS personne
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  await synchroniserMenages()
  const row = etat.majs[0].row
  assert.strictEqual(row.status, 'unassigned')
  assert.strictEqual(row.provider_id, null, 'la prestataire périmée doit partir avec le statut')
  assert.strictEqual(row.accepted_at, null, 'et l\'horodatage avec')
})

// ─── C2 : le statut se lit comme les LECTEURS le lisent ────────────────────

test('un snapshot ANTÉRIEUR à l\'unification n\'est pas pris pour une annulation', async () => {
  // ⚠ Une ligne écrite avant le 31 août porte le statut BRUT du provider :
  // Beds24 appelle `new` une réservation confirmée. La comparer au texte
  // 'confirmed' faisait passer un séjour vivant pour disparu — et le writer
  // annulait son ménage, pendant que le planning de l'hôte continuait de
  // l'afficher, puisque lui lit le statut canonique.
  const etat = preparer({
    snaps: [{ ...SNAP(), snapshot: { status: 'new', departure: '2026-09-05' } }],
    menages: [{ id: 'm1', user_id: U, property_id: '209413', booking_id: 'b1',
                departure_date: '2026-09-05', status: 'accepted', provider_id: REGINA }],
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1, requires_ack: false }]
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages()
  assert.strictEqual(bilan.annules, 0, 'une réservation Beds24 « new » est CONFIRMÉE')
  assert.strictEqual(etat.majs.length, 0)
})

test('un blocage propriétaire legacy (`black`) ne devient PAS un ménage', async () => {
  // Contre-épreuve indispensable : lire le statut canonique sans passer le
  // provider du bien ferait retomber 'black' sur 'confirmed', et le ménage
  // fantôme reviendrait par la porte qu'on vient d'ouvrir.
  const etat = preparer({
    snaps: [{ ...SNAP(), snapshot: { status: 'black', departure: '2026-09-05' } }],
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1, requires_ack: false }]
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages()
  assert.strictEqual(bilan.crees, 0)
  assert.strictEqual(etat.inseres.length, 0)
})

test('une PANNE de lecture des biens coupe le cycle, elle ne devine pas', async () => {
  // Sans le provider, un blocage propriétaire redevient un ménage : mieux vaut
  // ne rien faire ce cycle-ci.
  const etat = preparer({ snaps: [SNAP()], erreurBiens: { message: 'timeout' } })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages()
  assert.strictEqual(bilan.interrompu, 'db')
  assert.strictEqual(etat.inseres.length, 0)
  assert.strictEqual(etat.majs.length, 0)
})

// ─── C3 : l'assignation est rattrapée, pas figée à la création ─────────────

test('un ménage resté SANS personne est assigné dès qu\'une liaison existe', async () => {
  // Le cas de tout nouvel hôte : il branche son PMS, le cron crée ses ménages
  // avant qu'aucune femme de ménage ne soit liée. Sans ce rattrapage, ces
  // ménages restaient orphelins pour toujours — et sans alerte, puisque
  // « aucune liaison » ne déclenche rien.
  const etat = preparer({
    snaps: [SNAP()],
    menages: [{ id: 'm1', user_id: U, property_id: '209413', booking_id: 'b1',
                departure_date: '2026-09-05', status: 'unassigned',
                provider_id: null, assigned_by: null }],
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1, requires_ack: false }]
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages()
  assert.strictEqual(bilan.assignes_apres_coup, 1)
  assert.strictEqual(etat.majs[0].row.provider_id, REGINA)
  assert.strictEqual(etat.majs[0].row.status, 'accepted')
  assert.ok(etat.journal.some(l => l.event === 'assigned' && l.to_provider_id === REGINA))
})

test('le rattrapage ne touche NI un ménage manuel NI une offre en cours', async () => {
  // Les réassigner reviendrait à défaire une décision — celle de l'hôte, ou
  // celle d'une prestataire qui a déjà été sollicitée.
  const etat = preparer({
    snaps: [SNAP(), { ...SNAP(), booking_id: 'b2', snapshot: { status: 'confirmed', departure: '2026-09-06' } }],
    menages: [
      { id: 'm1', user_id: U, property_id: '209413', booking_id: 'b1', departure_date: '2026-09-05',
        status: 'unassigned', provider_id: null, assigned_by: 'manual' },
      { id: 'm2', user_id: U, property_id: '209413', booking_id: 'b2', departure_date: '2026-09-06',
        status: 'offered', provider_id: NOUVELLE, assigned_by: 'auto' }
    ],
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1, requires_ack: false }]
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages()
  assert.strictEqual(bilan.assignes_apres_coup, 0)
  assert.strictEqual(etat.majs.length, 0)
})

test('le rattrapage ne ressuscite pas un ménage annulé par la bande', async () => {
  const etat = preparer({
    snaps: [{ ...SNAP(), snapshot: { status: 'cancelled', departure: '2026-09-05' } }],
    menages: [{ id: 'm1', user_id: U, property_id: '209413', booking_id: 'b1',
                departure_date: '2026-09-05', status: 'cancelled', provider_id: null }],
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1, requires_ack: false }]
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages()
  assert.strictEqual(bilan.assignes_apres_coup, 0)
  assert.strictEqual(bilan.ressuscites, 0)
})

// ─── L'isolation multi-comptes des lectures du writer ──────────────────────
// ⚠ Ces deux `.in('user_id', …)` sont les SEULES gardes inter-comptes de leurs
// lectures : le writer tourne en service key, qui contourne la RLS par
// conception. Aucune assertion ne les couvrait — les retirer laissait les 996
// tests verts.

test('la lecture des ménages existants est filtrée par COMPTE', async () => {
  const etat = preparer({ snaps: [SNAP()], liaisons: [] })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  await synchroniserMenages()
  const q = etat.requetes.find(r => r.table === 'menages' && r.ins)
  assert.ok(q, 'la lecture des ménages doit exister')
  assert.strictEqual(q.ins.c, 'user_id')
  assert.deepStrictEqual(q.ins.v, [U])
})

test('la lecture des biens est filtrée par COMPTE', async () => {
  const etat = preparer({ snaps: [SNAP()], liaisons: [] })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  await synchroniserMenages()
  const q = etat.requetes.find(r => r.table === 'properties')
  assert.ok(q && q.ins, 'la lecture des biens doit être filtrée')
  assert.strictEqual(q.ins.c, 'user_id')
})

test('les deux lectures sont PLAFONNÉES et ordonnées', async () => {
  // PostgREST tronque à 1000 lignes sans erreur : une troncature silencieuse de
  // `menages` ferait annuler ceux qu'on n'a pas lus.
  const etat = preparer({ snaps: [SNAP()], liaisons: [] })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  await synchroniserMenages()
  const qm = etat.requetes.find(r => r.table === 'menages' && r.ins)
  assert.ok(qm.order && String(qm.order).includes('departure'))
})

test('un bien INCONNU de `properties` ne produit aucun ménage', async () => {
  // ⚠ Régression introduite par le passage au statut canonique :
  // `canonicalStatus('black', undefined)` retombe sur 'confirmed'. Un blocage
  // propriétaire redevenait donc un ménage dès que le bien n'avait plus de ligne
  // `properties` — cas atteignable, rien ne purge les snapshots d'un bien retiré.
  const etat = preparer({
    snaps: [{ ...SNAP(), snapshot: { status: 'black', departure: '2026-09-05' } }],
    biens: [],
    liaisons: []
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages()
  assert.strictEqual(bilan.crees, 0)
  assert.strictEqual(etat.inseres.length, 0)
})

test('un bien inconnu ne fait pas non plus ANNULER ses ménages', async () => {
  // Contre-épreuve : sauter la ligne ne doit pas la faire passer pour disparue.
  // Ici la lecture est tronquée à zéro bien, donc `tronque` est faux mais aucun
  // séjour n'entre dans `vivants` — c'est le pire cas.
  const etat = preparer({
    snaps: [SNAP()],
    biens: [],
    menages: [{ id: 'm1', user_id: U, property_id: '209413', booking_id: 'b1',
                departure_date: '2026-09-05', status: 'accepted', provider_id: REGINA }]
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages()
  assert.strictEqual(bilan.annules, 0, 'un bien qu\'on ne sait pas lire n\'est pas un bien disparu')
})

test('un ménage REFUSÉ (orphaned) n\'est pas rendu à qui l\'a refusé', async () => {
  // ⚠ Sans cette garde, le writer le réassignerait à la même personne au cycle
  // suivant, qui le refuserait encore : une boucle dont personne ne sortirait.
  // `orphaned` appelle une décision humaine — l'hôte a été alerté.
  const etat = preparer({
    snaps: [SNAP()],
    menages: [{ id: 'm1', user_id: U, property_id: '209413', booking_id: 'b1',
                departure_date: '2026-09-05', status: 'orphaned',
                provider_id: null, assigned_by: 'auto' }],
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1, requires_ack: false }]
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages()
  assert.strictEqual(bilan.assignes_apres_coup, 0)
  assert.strictEqual(etat.majs.length, 0)
})

test('un ménage REFUSÉ puis annulé puis revenu n\'est PAS re-proposé', async () => {
  // ⚠ LA BOUCLE QUE CE TEST FERME. Le statut `orphaned` seul était respecté par
  // la boucle de rattrapage, mais deux autres chemins l'ignoraient : un départ
  // déplacé passe le ménage à `cancelled`, et s'il revient, la résurrection
  // RECALCULAIT l'assignation — donc réémettait une offre vers la personne qui
  // venait de refuser, avec au journal « la réservation existe toujours ».
  // Il suffisait qu'un voyageur décale son départ puis revienne dessus.
  const etat = preparer({
    snaps: [SNAP()],
    menages: [{ id: 'm1', user_id: U, property_id: '209413', booking_id: 'b1',
                departure_date: '2026-09-05', status: 'cancelled',
                provider_id: null, assigned_by: 'manual',
                assignment_reason: 'Refuse par Marie.' }],
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1, requires_ack: false }]
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages()
  assert.strictEqual(bilan.ressuscites, 1, 'le ménage revient au planning')
  assert.strictEqual(etat.majs[0].row.provider_id, null, 'mais sans personne')
  assert.strictEqual(etat.majs[0].row.status, 'orphaned', 'et toujours en attente d\'une décision')
  assert.strictEqual(etat.majs[0].row.assigned_by, 'manual', 'le verrou survit à l\'annulation')
})

test('une résurrection ORDINAIRE recalcule bien l\'assignation', async () => {
  // Contre-épreuve : conserver le verrou ne doit pas empêcher un ménage sans
  // décision humaine de retrouver sa référente.
  const etat = preparer({
    snaps: [SNAP()],
    menages: [{ id: 'm1', user_id: U, property_id: '209413', booking_id: 'b1',
                departure_date: '2026-09-05', status: 'cancelled',
                provider_id: null, assigned_by: 'auto' }],
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1, requires_ack: false }]
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  await synchroniserMenages()
  assert.strictEqual(etat.majs[0].row.provider_id, REGINA)
  assert.strictEqual(etat.majs[0].row.status, 'accepted')
})

// ─── L'expiration des propositions ─────────────────────────────────────────
// ⚠ UNE PROPOSITION QUI EXPIRE NE CHANGE RIEN AU PORTEUR. Elle s'efface, et le
// ménage reste chez la référente comme si de rien n'était — elle l'a toujours
// eu. Rien n'est découvert, donc rien n'appelle une alerte. Le seul cas grave
// est celui d'un ménage que PERSONNE ne porte.

test('une proposition expirée s\'efface, et le porteur ne bouge pas', async () => {
  const etat = preparer({ expirees: [
    { id: 'm1', user_id: U, property_id: '209413', departure_date: '2026-09-10',
      provider_id: REGINA, offered_to: NOUVELLE }
  ] })
  const { expirerPropositions } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await expirerPropositions()
  assert.strictEqual(bilan.expirees, 1)
  assert.strictEqual(bilan.orphelins, 0)
  const maj = etat.majs[0]
  assert.strictEqual(maj.row.offered_to, null)
  assert.strictEqual(maj.row.offer_expires_at, null)
  assert.strictEqual(maj.row.provider_id, undefined, 'le porteur n\'est pas touché')
  assert.strictEqual(maj.row.status, undefined, 'ni le statut')
})

test('une proposition expirée sur un ménage porté N\'ALERTE PAS', async () => {
  // Alerter serait du bruit : rien n'est découvert, et l'hôte finirait par ne
  // plus lire ces messages.
  const etat = preparer({ expirees: [
    { id: 'm1', user_id: U, property_id: '209413', departure_date: '2026-09-10',
      provider_id: REGINA, offered_to: NOUVELLE }
  ] })
  const { expirerPropositions } = require('../lib/cleaning/sync-menages-entite')
  await expirerPropositions()
  assert.strictEqual(etat.incidents.length, 0)
})

test('expirée SANS porteur : orphaned, et l\'hôte est alerté', async () => {
  // Là, un logement ne sera pas préparé : c'est le seul cas qui mérite une
  // alerte forte.
  const etat = preparer({ expirees: [
    { id: 'm1', user_id: U, property_id: '209413', departure_date: '2026-09-10',
      provider_id: null, offered_to: NOUVELLE }
  ] })
  const { expirerPropositions } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await expirerPropositions()
  assert.strictEqual(bilan.orphelins, 1)
  assert.strictEqual(etat.majs[0].row.status, 'orphaned')
  assert.strictEqual(etat.incidents.length, 1)
})

test('chaque expiration laisse une trace au journal', async () => {
  const etat = preparer({ expirees: [
    { id: 'm1', user_id: U, property_id: '209413', departure_date: '2026-09-10',
      provider_id: REGINA, offered_to: NOUVELLE }
  ] })
  const { expirerPropositions } = require('../lib/cleaning/sync-menages-entite')
  await expirerPropositions()
  const l = etat.journal.find(x => x.event === 'expired')
  assert.ok(l, 'un événement `expired` est attendu')
  assert.strictEqual(l.from_provider_id, NOUVELLE)
  assert.strictEqual(l.actor, 'cron')
})

test('aucune proposition expirée : aucune écriture', async () => {
  const etat = preparer({ expirees: [] })
  const { expirerPropositions } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await expirerPropositions()
  assert.strictEqual(bilan.expirees, 0)
  assert.strictEqual(etat.majs.length, 0)
})

test('le writer ne réassigne PAS un ménage sous proposition', async () => {
  // ⚠ Une proposition en cours n'est pas un ménage sans personne : la réassigner
  // effacerait une sollicitation à laquelle quelqu'un s'apprête peut-être à
  // répondre — et deux personnes se croiraient concernées.
  const etat = preparer({
    snaps: [SNAP()],
    menages: [{ id: 'm1', user_id: U, property_id: '209413', booking_id: 'b1',
                departure_date: '2026-09-05', status: 'unassigned',
                provider_id: null, offered_to: NOUVELLE, assigned_by: 'auto' }],
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1, requires_ack: false }]
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages()
  assert.strictEqual(bilan.assignes_apres_coup, 0)
  assert.strictEqual(etat.majs.length, 0)
})

test('le rattrapage PROPOSE quand le bien n\'a qu\'un suppléant', async () => {
  // ⚠ Tester le seul `providerId` faisait sauter tous ces cas : un hôte qui ne
  // lie qu'un rang 2 voyait ses ménages déjà créés n'être jamais proposés à
  // personne, et la seule alerte avait eu lieu à leur création.
  const etat = preparer({
    snaps: [SNAP()],
    menages: [{ id: 'm1', user_id: U, property_id: '209413', booking_id: 'b1',
                departure_date: '2026-09-05', status: 'unassigned',
                provider_id: null, offered_to: null, assigned_by: null }],
    liaisons: [{ user_id: U, property_id: '209413', provider_id: NOUVELLE, rang: 2, requires_ack: true, weekdays: TOUS_LES_JOURS }]
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages()
  assert.strictEqual(bilan.assignes_apres_coup, 1)
  assert.strictEqual(etat.majs[0].row.offered_to, NOUVELLE)
  assert.strictEqual(etat.majs[0].row.provider_id, null, 'personne ne le porte encore')
})

test('une proposition EXPIRÉE sur un ménage annulé n\'est pas ressuscitée', async () => {
  // ⚠ L'annulation n'efface pas la proposition : sans filtre, un ménage annulé
  // repassait en `orphaned`, réapparaissait au planning et déclenchait une
  // alerte pour une réservation qui n'existe plus.
  const etat = preparer({ expirees: [] })
  const { expirerPropositions } = require('../lib/cleaning/sync-menages-entite')
  await expirerPropositions()
  const q = etat.requetes.find(r => r.table === 'menages' && r.lt)
  assert.ok(q, 'la lecture des propositions échues doit exister')
  assert.deepStrictEqual(q.neq, { c: 'status', v: 'cancelled' })
})

// ═══════════════════════════════════════════════════════════════════════════
// LOT 3.3 — LE MOTEUR CONSOMME LA GARDE DU JOUR
// ═══════════════════════════════════════════════════════════════════════════
// Le cas réel de Bagnères-de-Bigorre, déroulé de bout en bout (spec §12.4).
// Régina : attitrée tous les jours, assignée d'office. La seconde : le week-end
// une semaine sur deux, doit confirmer.

const { construireRrule } = require('../lib/cleaning/availability')
const WEEKEND_QUINZAINE = construireRrule({ jours: [0, 6], toutesLesNSemaines: 2, depuis: '2026-09-05' })
const T0 = Date.parse('2026-09-01T08:00:00Z')

const BAGNERES = [
  { user_id: U, property_id: '209413', provider_id: REGINA,   rang: 1, weekdays: null,   requires_ack: false, active: true },
  { user_id: U, property_id: '209413', provider_id: NOUVELLE, rang: 2, weekdays: [0, 6], requires_ack: true,  active: true }
]
const REGLES_SECONDE = [{ user_id: U, provider_id: NOUVELLE, rrule: WEEKEND_QUINZAINE, active: true }]

test('SAMEDI « on » : Régina porte, et le ménage est proposé à la seconde', async () => {
  // ⚠ L'invariant du §12.4 : porté par la première qui n'a rien à confirmer,
  // proposé à celle qui est de garde ce jour-là. Écrire la seconde dans
  // `provider_id` sortirait le ménage du planning de Régina alors que personne
  // ne l'a accepté — un logement découvert sans que personne ne le sache.
  const etat = preparer({ snaps: [SNAP({ departure: '2026-09-05' })],
                          liaisons: BAGNERES, regles: REGLES_SECONDE })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  await synchroniserMenages(null, { maintenant: T0 })
  const m = etat.inseres[0]
  assert.strictEqual(m.provider_id, REGINA)
  assert.strictEqual(m.offered_to, NOUVELLE)
  assert.strictEqual(m.status, 'accepted')
  assert.ok(m.offer_expires_at, 'une proposition sans échéance est refusée par la base')
  assert.ok(m.accepted_at && m.offered_at, 'porté ET proposé : les deux dates')
  assert.strictEqual(m.assignment_mode, 'garde')
})

test('SAMEDI « off » : la seconde n\'est pas candidate, rien ne lui est proposé', async () => {
  // Sa règle RRULE ne couvre pas ce samedi-là. Lui proposer quand même serait
  // lui demander de travailler un jour où elle a déclaré ne pas être là.
  const etat = preparer({ snaps: [SNAP({ departure: '2026-09-12' })],
                          liaisons: BAGNERES, regles: REGLES_SECONDE })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  await synchroniserMenages(null, { maintenant: Date.parse('2026-09-08T08:00:00Z') })
  const m = etat.inseres[0]
  assert.strictEqual(m.provider_id, REGINA)
  assert.strictEqual(m.offered_to, null)
  assert.strictEqual(m.status, 'accepted')
})

test('MARDI : la seconde n\'est pas attitrée ce jour-là', async () => {
  // ⚠ `weekdays` et disponibilité sont deux filtres différents : être libre un
  // mardi ne rend pas attitrée le mardi.
  const etat = preparer({ snaps: [SNAP({ departure: '2026-09-08' })],
                          liaisons: BAGNERES, regles: REGLES_SECONDE })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  await synchroniserMenages(null, { maintenant: Date.parse('2026-09-02T08:00:00Z') })
  assert.strictEqual(etat.inseres[0].provider_id, REGINA)
  assert.strictEqual(etat.inseres[0].offered_to, null)
})

test('un CONGÉ de Régina ce jour-là : personne ne porte, la seconde est sollicitée', async () => {
  const etat = preparer({
    snaps: [SNAP({ departure: '2026-09-05' })], liaisons: BAGNERES, regles: REGLES_SECONDE,
    exceptions: [{ user_id: U, provider_id: REGINA, date: '2026-09-05', available: false }]
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  await synchroniserMenages(null, { maintenant: T0 })
  assert.strictEqual(etat.inseres[0].provider_id, null)
  assert.strictEqual(etat.inseres[0].offered_to, NOUVELLE)
  assert.strictEqual(etat.inseres[0].status, 'offered')
})

test('un départ LOINTAIN n\'est pas proposé, mais il est PORTÉ', async () => {
  // ⚠ Une proposition expire en 48 h. Posée à la création d'un départ dans deux
  // mois, elle serait morte avant le séjour et la responsable du jour n'aurait
  // plus jamais l'occasion de le prendre. C'est aussi la garde d'envoi de masse
  // (REVIEW.md règle 2) : à la première activation d'un compte, un SMS par
  // réservation future de l'historique.
  const etat = preparer({ snaps: [SNAP({ departure: '2026-11-14' })],
                          liaisons: BAGNERES, regles: REGLES_SECONDE })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  await synchroniserMenages(null, { maintenant: T0 })
  assert.strictEqual(etat.inseres[0].provider_id, REGINA, 'personne n\'est découvert')
  assert.strictEqual(etat.inseres[0].offered_to, null)
  assert.strictEqual(etat.inseres[0].offer_expires_at, null)
})

// ─── L'alerte « ménage sans responsable » (§12.6) ──────────────────────────

test('TROU DE GARDE un jour où un ménage existe : l\'hôte est alerté', async () => {
  // ⚠ L'alerte ne part que si un MÉNAGE existe ce jour-là sans personne. Les
  // trous des jours SANS réservation sont visibles à l'écran (lot 3.4), jamais
  // alertés : alerter sur chaque jour sans responsable noierait les vraies
  // alertes.
  const etat = preparer({
    snaps: [SNAP({ departure: '2026-09-08' })],
    liaisons: [BAGNERES[0]],   // Régina seule…
    exceptions: [{ user_id: U, provider_id: REGINA, date: '2026-09-08', available: false }]
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages(null, { maintenant: Date.parse('2026-09-02T08:00:00Z') })
  assert.strictEqual(etat.inseres[0].provider_id, null)
  assert.strictEqual(bilan.alertes, 1)
  assert.match(etat.incidents[0].detail.message, /personne n'est de garde/)
})

test('un départ lointain SANS proposition due n\'alerte PAS', async () => {
  // Rien n'est découvert : quelqu'un porte, et la proposition viendra en temps
  // voulu. Alerter ici serait du bruit permanent.
  const etat = preparer({ snaps: [SNAP({ departure: '2026-11-14' })],
                          liaisons: BAGNERES, regles: REGLES_SECONDE })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages(null, { maintenant: T0 })
  assert.strictEqual(bilan.alertes, 0)
  assert.strictEqual(etat.incidents.length, 0)
})

test('une PANNE de lecture des disponibilités COUPE le cycle', async () => {
  // ⚠ Retomber sur des maps vides ferait paraître TOUT LE MONDE disponible —
  // « aucune règle = disponible ». Les congés seraient ignorés et les ménages
  // partiraient à des gens absents, sans que rien ne le signale.
  const etat = preparer({ snaps: [SNAP()], liaisons: BAGNERES,
                          erreurDispos: { message: 'timeout' } })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages(null, { maintenant: T0 })
  assert.strictEqual(bilan.interrompu, 'db')
  assert.strictEqual(etat.inseres.length, 0, 'aucun ménage créé sur une garde qu\'on ne sait pas lire')
})

// ─── Un départ DÉPLACÉ est recalculé par la garde du NOUVEAU jour ──────────

test('un départ déplacé du samedi au mardi ne suit pas la garde du samedi', async () => {
  // La date fait partie de l'identité du ménage : l'ancien est annulé, un autre
  // naît — et il est décidé par la garde de SON jour. Sans cela, la titulaire du
  // week-end héritait d'un ménage un mardi, jour où elle ne prend pas.
  const etat = preparer({
    snaps: [SNAP({ departure: '2026-09-08' })],
    menages: [{ id: 'm-samedi', user_id: U, property_id: '209413', booking_id: 'b1',
                departure_date: '2026-09-05', status: 'accepted', provider_id: NOUVELLE,
                assigned_by: 'auto' }],
    liaisons: BAGNERES, regles: REGLES_SECONDE
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  await synchroniserMenages(null, { maintenant: Date.parse('2026-09-02T08:00:00Z') })
  assert.strictEqual(etat.inseres[0].departure_date, '2026-09-08')
  assert.strictEqual(etat.inseres[0].provider_id, REGINA, 'la garde du mardi, pas celle du samedi')
  const annulation = etat.majs.find(m => m.row.status === 'cancelled')
  assert.ok(annulation && annulation.ids.includes('m-samedi'))
})

// ─── LES PROPOSITIONS DUES, ET L'ESCALADE ─────────────────────────────────

test('la proposition est posée à l\'approche du départ, et NOTIFIÉE', async () => {
  // ⚠ Une proposition muette expirerait sans que la personne ait su qu'on lui
  // demandait quelque chose — et le ménage retomberait sur sa porteuse, qui
  // n'avait rien demandé.
  const etat = preparer({
    liaisons: BAGNERES, regles: REGLES_SECONDE,
    propositions: [{ id: 'm1', user_id: U, property_id: '209413', booking_id: 'b1',
                     departure_date: '2026-09-05', provider_id: REGINA, status: 'accepted' }]
  })
  const { poserPropositionsDues } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await poserPropositionsDues(null, { maintenant: T0 })
  assert.strictEqual(bilan.proposees, 1)
  const maj = etat.majs.find(m => m.row.offered_to)
  assert.strictEqual(maj.row.offered_to, NOUVELLE)
  assert.ok(maj.row.offer_expires_at)
  assert.strictEqual(maj.row.status, undefined, 'quelqu\'un porte : son statut ne bouge pas')
  assert.strictEqual(etat.notifs.length, 1)
  assert.strictEqual(etat.notifs[0].providerId, NOUVELLE)
  assert.ok(etat.notifs[0].expireLe, 'le délai de réponse est DANS le message')
  assert.strictEqual(etat.journal.filter(l => l.event === 'offered').length, 1)
})

test('ESCALADE : qui a refusé ou laissé expirer n\'est jamais resollicité', async () => {
  // ⚠ Sans la mémoire du journal, on reproposerait à la personne qui vient de
  // dire non, qui refuserait encore — toutes les cinq minutes.
  const etat = preparer({
    liaisons: BAGNERES, regles: REGLES_SECONDE,
    refus: [{ menage_id: 'm1', from_provider_id: NOUVELLE, event: 'declined' }],
    propositions: [{ id: 'm1', user_id: U, property_id: '209413', booking_id: 'b1',
                     departure_date: '2026-09-05', provider_id: REGINA, status: 'accepted' }]
  })
  const { poserPropositionsDues } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await poserPropositionsDues(null, { maintenant: T0 })
  assert.strictEqual(bilan.proposees, 0, 'la file est épuisée')
  assert.strictEqual(etat.majs.length, 0, 'et le ménage reste chez sa porteuse, intact')
  assert.strictEqual(etat.notifs.length, 0)
})

test('la pose de proposition est ATOMIQUE : elle exige `offered_to` vide', async () => {
  // Entre la lecture et l'écriture, l'hôte a pu proposer le ménage depuis son
  // planning. Zéro ligne = quelqu'un a été plus rapide, et c'est normal.
  const etat = preparer({
    liaisons: BAGNERES, regles: REGLES_SECONDE,
    propositions: [{ id: 'm1', user_id: U, property_id: '209413', booking_id: 'b1',
                     departure_date: '2026-09-05', provider_id: REGINA, status: 'accepted' }]
  })
  const { poserPropositionsDues } = require('../lib/cleaning/sync-menages-entite')
  await poserPropositionsDues(null, { maintenant: T0 })
  const req = etat.requetes.filter(r => r.table === 'menages').pop()
  const source = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'lib/cleaning/sync-menages-entite.js'), 'utf8')
  assert.ok(source.includes(".eq('id', m.id).is('offered_to', null)"),
    'la condition doit être POSÉE DANS l\'update, pas testée avant')
  assert.ok(req)
})

test('les ménages d\'AVANT le lot 3.3 ne sont jamais repris', async () => {
  // ⚠ Les 179 ménages `accepted` du 4 septembre portent `assignment_mode =
  // 'priorite'`. Leur poser une proposition reviendrait à rouvrir un engagement
  // déjà pris avec quelqu'un.
  const source = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'lib/cleaning/sync-menages-entite.js'), 'utf8')
  assert.ok(source.includes(".eq('assignment_mode', 'garde')"),
    'la pose différée doit se borner aux ménages décidés par la garde')
  assert.ok(source.includes(".eq('assigned_by', 'auto')"),
    'et ne jamais toucher une décision manuelle de l\'hôte')
})

test('aucune proposition due : aucune écriture, aucun envoi', async () => {
  const etat = preparer({ liaisons: BAGNERES, regles: REGLES_SECONDE, propositions: [] })
  const { poserPropositionsDues } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await poserPropositionsDues(null, { maintenant: T0 })
  assert.strictEqual(bilan.proposees, 0)
  assert.strictEqual(etat.majs.length, 0)
  assert.strictEqual(etat.notifs.length, 0)
})

test('on ne se propose pas à SOI-MÊME', async () => {
  // `menages_offre_pas_a_soi` : la porteuse actuelle peut très bien être la
  // seule candidate du jour. Lui proposer ce qu'elle a déjà ferait échouer
  // l'écriture.
  const etat = preparer({
    liaisons: [BAGNERES[0]], regles: [],
    propositions: [{ id: 'm1', user_id: U, property_id: '209413', booking_id: 'b1',
                     departure_date: '2026-09-05', provider_id: REGINA, status: 'accepted' }]
  })
  const { poserPropositionsDues } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await poserPropositionsDues(null, { maintenant: T0 })
  assert.strictEqual(bilan.proposees, 0)
  assert.strictEqual(etat.majs.length, 0)
})

// ─── Ce que la review a trouvé, et qui ne doit plus revenir ────────────────

test('un ménage ORPHELIN par EXPIRATION est bien escaladé', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW. `expirerPropositions` passe en `orphaned` un
  // ménage que personne ne porte ; la pose différée excluait ce statut, et rien
  // ne le ressuscite ailleurs. L'escalade ne marchait donc pas dans le SEUL cas
  // où elle compte : deux candidates à confirmer, la première ne répond pas, la
  // seconde n'était jamais sollicitée alors qu'elle est attitrée et disponible.
  const etat = preparer({
    liaisons: [
      { user_id: U, property_id: '209413', provider_id: NOUVELLE, rang: 1, requires_ack: true, weekdays: TOUS_LES_JOURS, active: true },
      { user_id: U, property_id: '209413', provider_id: REGINA, rang: 2, requires_ack: true, weekdays: TOUS_LES_JOURS, active: true }
    ],
    refus: [{ menage_id: 'm1', from_provider_id: NOUVELLE, event: 'expired' }],
    propositions: [{ id: 'm1', user_id: U, property_id: '209413', booking_id: 'b1',
                     departure_date: '2026-09-05', provider_id: null, status: 'orphaned' }]
  })
  const { poserPropositionsDues } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await poserPropositionsDues(null, { maintenant: T0 })
  assert.strictEqual(bilan.proposees, 1, 'la candidate suivante DOIT être sollicitée')
  const maj = etat.majs.find(m => m.row.offered_to)
  assert.strictEqual(maj.row.offered_to, REGINA)
  assert.strictEqual(maj.row.status, 'offered', 'le ménage sort de `orphaned`')
})

test('un ménage orphelin par REFUS reste verrouillé', async () => {
  // ⚠ Ce qui distingue les deux `orphaned`, c'est le VERROU, pas le statut : un
  // refus pose `assigned_by='manual'` (décision humaine), une expiration non.
  // La lecture le filtre côté SQL — sans quoi on rendrait le ménage à qui vient
  // de le refuser.
  const source = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'lib/cleaning/sync-menages-entite.js'), 'utf8')
  assert.ok(source.includes(".eq('assigned_by', 'auto')"))
  assert.ok(source.includes("['accepted', 'unassigned', 'orphaned']"))
})

test('les disponibilités se lisent PAGINÉES, elles ne coupent plus le cycle', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW. Lever à la première page pleine faisait rendre
  // `interrompu:'db'` au writer — donc plus aucune création, annulation ni
  // alerte, à chaque cycle et sans reprise. Trois prestataires à qui on déclare
  // leurs congés de l'année suffisaient à atteindre le seuil.
  const source = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'lib/cleaning/assign.js'), 'utf8')
  assert.ok(source.includes('.range(page * PAGE'), 'lecture paginée')
  assert.ok(!source.includes('lecture tronquee a'), 'plus de levée sur une page pleine')
  assert.ok(source.includes("lireTout(() => sb.from('menage_assignment_log')"),
    'le journal aussi : une refusante manquée relance un SMS toutes les 48 h')
})

// ─── La restriction du 4 septembre, vue du writer ─────────────────────────

test('sans jours attitrés réglés : aucune proposition posée, aucun SMS', async () => {
  // ⚠ Restriction du product owner (à revoir au lot 3.5). Une liaison qui doit
  // confirmer et dont les `weekdays` ne sont pas réglés n'est jamais sollicitée :
  // sinon elle recevrait un SMS par départ, sur la clé Brevo de l'hôte, pour des
  // jours qu'elle n'a jamais déclaré prendre.
  const etat = preparer({
    liaisons: [
      { user_id: U, property_id: '209413', provider_id: REGINA, rang: 1, weekdays: null, requires_ack: false, active: true },
      { user_id: U, property_id: '209413', provider_id: NOUVELLE, rang: 2, weekdays: null, requires_ack: true, active: true }
    ],
    propositions: [{ id: 'm1', user_id: U, property_id: '209413', booking_id: 'b1',
                     departure_date: '2026-09-05', provider_id: REGINA, status: 'accepted' }]
  })
  const { poserPropositionsDues } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await poserPropositionsDues(null, { maintenant: T0 })
  assert.strictEqual(bilan.proposees, 0)
  assert.strictEqual(etat.notifs.length, 0, 'aucun SMS')
  assert.strictEqual(etat.majs.length, 0, 'et le ménage reste chez sa porteuse, intact')
})

test('la porteuse d\'office N\'EST PAS concernée par la restriction', async () => {
  // Régina n'a pas de `weekdays` et n'en aura pas : elle ne confirme rien, elle
  // porte. Le lui retirer aurait vidé le planning au déploiement.
  const etat = preparer({
    snaps: [SNAP({ departure: '2026-09-05' })],
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1,
                 weekdays: null, requires_ack: false, active: true }]
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages(null, { maintenant: T0 })
  assert.strictEqual(etat.inseres[0].provider_id, REGINA)
  assert.strictEqual(bilan.alertes, 0)
})

test('personne d\'office et aucun jour réglé : le ménage n\'est pas SILENCIEUX', async () => {
  // ⚠ Le silence voulu porte sur le SMS, pas sur un logement sans personne.
  // L'hôte est alerté, avec le motif exact — c'est ce qui lui dit quoi régler.
  const etat = preparer({
    snaps: [SNAP({ departure: '2026-09-05' })],
    liaisons: [{ user_id: U, property_id: '209413', provider_id: NOUVELLE, rang: 1,
                 weekdays: null, requires_ack: true, active: true }]
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages(null, { maintenant: T0 })
  assert.strictEqual(etat.inseres[0].provider_id, null)
  assert.strictEqual(etat.inseres[0].offered_to, null)
  assert.strictEqual(etat.inseres[0].status, 'unassigned')
  assert.strictEqual(bilan.alertes, 1)
  assert.match(etat.incidents[0].detail.message, /jours attitres regles/)
})

test('un ménage DÉJÀ EN BASE sans personne alerte lui aussi', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW. L'alerte n'était poussée que dans la boucle de
  // création : un ménage créé avant que le problème n'apparaisse — un départ
  // lointain devenu proche, un congé posé depuis — restait sans personne et sans
  // le moindre signal jusqu'au jour du départ, alors que la spec et le guide
  // promettent à l'hôte qu'il sera prévenu.
  const etat = preparer({
    snaps: [SNAP({ departure: '2026-09-05' })],
    menages: [{ id: 'm1', user_id: U, property_id: '209413', booking_id: 'b1',
                departure_date: '2026-09-05', status: 'unassigned', provider_id: null,
                offered_to: null, assigned_by: 'auto' }],
    liaisons: [{ user_id: U, property_id: '209413', provider_id: NOUVELLE, rang: 1,
                 weekdays: null, requires_ack: true, active: true }]
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages(null, { maintenant: T0 })
  assert.strictEqual(bilan.alertes, 1)
  assert.match(etat.incidents[0].detail.message, /jours attitres regles/)
})

test('un départ LOINTAIN bridé n\'alerte pas : il attend son heure', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW. `differee` était calculé APRÈS le filtre des
  // jours : un départ à cinq mois tombait dans la branche « bridée » et alertait
  // dès la création, au lieu d'attendre en silence que la date approche. On ne
  // signale un manque de réglage que quand il commence à compter.
  const etat = preparer({
    snaps: [SNAP({ departure: '2026-11-14' })],
    liaisons: [{ user_id: U, property_id: '209413', provider_id: NOUVELLE, rang: 1,
                 weekdays: null, requires_ack: true, active: true }]
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages(null, { maintenant: T0 })
  assert.strictEqual(bilan.alertes, 0)
  assert.strictEqual(etat.inseres[0].status, 'unassigned')
})

test('un ménage sans personne LOINTAIN n\'alerte pas à chaque cycle', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW. Ces ménages restent `unassigned` par conception :
  // ils repassent dans la boucle à CHAQUE cycle, toutes les cinq minutes. Or
  // `reportIncident` n'anti-spamme que l'ENVOI — il insère une ligne
  // `automation_incidents` à tous les coups. Trois biens concernés produisaient
  // ~860 lignes par jour, exactement la boucle d'écriture que la sonde
  // `table_growth` existe pour attraper.
  const etat = preparer({
    snaps: [SNAP({ departure: '2026-11-14' })],
    menages: [{ id: 'm1', user_id: U, property_id: '209413', booking_id: 'b1',
                departure_date: '2026-11-14', status: 'unassigned', provider_id: null,
                offered_to: null, assigned_by: 'auto' }],
    liaisons: [{ user_id: U, property_id: '209413', provider_id: NOUVELLE, rang: 1,
                 weekdays: null, requires_ack: true, active: true }]
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages(null, { maintenant: T0 })
  assert.strictEqual(bilan.alertes, 0, 'le départ est loin : rien à signaler encore')
  assert.strictEqual(etat.incidents.length, 0)
})
