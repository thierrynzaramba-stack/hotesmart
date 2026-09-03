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

function preparer ({ snaps = [], menages = [], liaisons = [], erreurSnaps = null,
                     // ⚠ Le provider du bien est OBLIGATOIRE pour lire un statut
                     // anterieur a l'unification : sans lui, 'black' retombe sur
                     // 'confirmed' et le blocage proprietaire redevient un menage
                     // fantome. Le double le porte donc, comme la vraie table.
                     biens = [{ user_id: U, provider_property_id: '209413', provider: 'beds24' },
                              { user_id: 'compte-2', provider_property_id: '209413', provider: 'beds24' }],
                     erreurBiens = null } = {}) {
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
        not () { return chain },
        is (c, v) { a.is = { c, v }; return chain },
        // ⚠ Chainable, comme le vrai builder : `.order()` est suivi d'un
        // `.limit()`. Un double qui rendait une Promise ici faisait echouer les
        // tests, pas le code.
        order (c) { a.order = c; return chain },
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
          // ⚠ `eq` enregistre AUSSI. Le rattrapage d'assignation met a jour
          // ligne par ligne (`.eq('id', …)`) : un double qui ignorait ce chemin
          // rendait `etat.majs` vide, et le test ne voyait rien de ce que le
          // code venait d'ecrire.
          eq (c, v) { etat.majs.push({ table, row, ids: [v] }); return Promise.resolve({ data: null, error: null }) }
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
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1 }]
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
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1 }]
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
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1 }]
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
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1 }]
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
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1 }]
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
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1 }]
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
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1 }]
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
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1 }]
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
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1 }]
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
    liaisons: [{ user_id: U, property_id: '209413', provider_id: REGINA, rang: 1 }]
  })
  const { synchroniserMenages } = require('../lib/cleaning/sync-menages-entite')
  await synchroniserMenages()
  assert.strictEqual(etat.majs[0].row.provider_id, REGINA)
  assert.strictEqual(etat.majs[0].row.status, 'accepted')
})
