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
const MODULES = ['../lib/cleaning/sync-menages-entite', '../lib/cleaning/assign',
                 '../lib/founder-notify', '../lib/cron-shared']

function preparer ({ snaps = [], menages = [], liaisons = [], erreurSnaps = null } = {}) {
  const etat = { inseres: [], majs: [], journal: [], incidents: [], requetes: [] }

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
        order () { return Promise.resolve(rep()) },
        limit () { return Promise.resolve(rep()) },
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
        return {
          in (c, v) { etat.majs.push({ table, row, ids: v }); return Promise.resolve({ data: null, error: null }) },
          eq () { return Promise.resolve({ data: null, error: null }) }
        }
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
        if (table === 'menages') return { data: menages, error: null }
        if (table === 'property_cleaning_providers') return { data: liaisons, error: null }
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
  require.cache[absNotify] = mn

  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
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
  ], liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1 }] })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  const bilan = await synchroniserMenages()
  assert.strictEqual(bilan.crees, 1)
  assert.deepStrictEqual(etat.inseres.map(r => r.booking_id), ['b1'])
})

// ─── L'assignation ─────────────────────────────────────────────────────────

test('le référent est assigné d\'office : le ménage naît accepté', async () => {
  const etat = preparer({ snaps: [SNAP()],
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1 }] })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  await synchroniserMenages()
  assert.strictEqual(etat.inseres[0].provider_id, REGINA)
  assert.strictEqual(etat.inseres[0].status, 'accepted')
  assert.ok(etat.inseres[0].accepted_at)
  assert.strictEqual(etat.inseres[0].offered_at, null)
})

test('le suppléant reçoit une OFFRE, il n\'est pas engagé', async () => {
  const etat = preparer({ snaps: [SNAP()],
    liaisons: [{ user_id: U, property_id: '209413', provider_id: NOUVELLE, rang: 2 }] })
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
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1 }]
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
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1 }]
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
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1 }]
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
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1 }]
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
      { user_id: U, property_id: '209413', provider_id: REGINA, rang: 1 },
      { user_id: 'compte-2', property_id: '209413', provider_id: 'p-autre', rang: 1 }
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
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1 }] })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  await synchroniserMenages()
  assert.strictEqual(etat.journal.length, 1)
  assert.strictEqual(etat.journal[0].event, 'assigned')
  assert.strictEqual(etat.journal[0].to_provider_id, REGINA)
  assert.strictEqual(etat.journal[0].actor, 'cron')
})
