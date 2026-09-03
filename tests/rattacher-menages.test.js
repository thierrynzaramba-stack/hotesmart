// tests/rattacher-menages.test.js
// Rattachement d'un avis au ménage qui a précédé le séjour.
//
// ⚠ Le risque n'est pas de rater un rattachement — le passage suivant retente.
// C'est d'en faire un FAUX : un reproche qui tombe sur la mauvaise femme de
// ménage. Ces tests fixent d'abord ce que le module doit REFUSER.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const { rattacherMenages } = require('../lib/cron-rattacher-menages')

const U = 'compte-1'
const AVIS = { id: 'a1', user_id: U, booking_uid: '77', property_id_ref: '209413' }

function fauxClient (d = {}, journal = []) {
  const { avis = [AVIS], menages = [], curseur = 0 } = d
  return {
    from (table) {
      const a = { table, f: {}, op: 'select' }
      journal.push(a)
      const chain = {
        select () { return chain },
        eq (c, v) { a.f[c] = v; return chain },
        is () { return chain }, not () { return chain }, order () { return chain },
        range (d1, f1) { a.range = [d1, f1]; return Promise.resolve({ data: avis, error: null }) },
        limit () { return Promise.resolve({ data: menages.filter(m =>
          Object.entries(a.f).every(([c, v]) => String(m[c]) === String(v))), error: null }) },
        maybeSingle () {
          if (table === 'cron_logs') return Promise.resolve({ data: { total_messages: curseur }, error: null })
          return Promise.resolve({ data: null, error: null })
        },
        upsert (row) { a.op = 'upsert'; a.row = row; return Promise.resolve({ error: null }) },
        update (row) { a.op = 'update'; a.row = row; return chain },
        then (r) { return Promise.resolve({ data: [], error: null }).then(r) }
      }
      return chain
    }
  }
}

const M = (o) => ({ id: 'm1', user_id: U, property_id: '209413', booking_id: '77', token: 'regina-x', ...o })

// ─── Ce qui ne doit PAS être rattaché ───────────────────────────────────────
test('DEUX prestataires notifiées : on ne devine pas laquelle a fait le ménage', async () => {
  const journal = []
  const b = await rattacherMenages(null, {
    supabase: fauxClient({ menages: [M(), M({ id: 'm2', token: 'tiphaine-y' })] }, journal),
    forcer: true
  })
  assert.strictEqual(b.sans_menage, 1)
  assert.strictEqual(b.rattaches, 0)
  assert.ok(!journal.some(j => j.table === 'ota_reviews' && j.op === 'update'))
})

test('aucun ménage : rien à rattacher', async () => {
  const b = await rattacherMenages(null, { supabase: fauxClient({ menages: [] }), forcer: true })
  assert.strictEqual(b.sans_menage, 1)
})

test('des lignes SANS token uniquement : rien n\'est rattaché', async () => {
  // Personne à désigner : `size === 0`.
  const b = await rattacherMenages(null, {
    supabase: fauxClient({ menages: [M({ token: null }), M({ id: 'm2', token: null })] }), forcer: true
  })
  assert.strictEqual(b.sans_menage, 1)
})

// ─── Ce qui doit l'être ─────────────────────────────────────────────────────
test('PLUSIEURS lignes, un seul token : c\'est la même personne, on rattache', async () => {
  // ⚠ Une réservation produit plusieurs menage_events : un par prestataire
  // notifiée, un par type d'événement (new / modified / cancelled), plus les
  // notes. Exiger « exactement une ligne » ne rattachait presque rien — mesuré :
  // 14 réservations sur 151 en ont plusieurs, et le cas à deux prestataires en
  // aurait systématiquement.
  const journal = []
  const b = await rattacherMenages(null, {
    supabase: fauxClient({ menages: [M(), M({ id: 'm2' }), M({ id: 'm3' })] }, journal),
    forcer: true
  })
  assert.strictEqual(b.rattaches, 1)
  const maj = journal.find(j => j.table === 'ota_reviews' && j.op === 'update')
  assert.strictEqual(maj.row.menage_event_id, 'm1')
})

test('lignes mixtes : on retient celle qui PORTE le token', async () => {
  // Prendre la plus ancienne pouvait désigner une ligne à token null : l'avis
  // aurait pointé un ménage que l'attribution — qui joint par token — n'aurait
  // jamais reconnu. Perdu, pas mal attribué, mais perdu.
  const journal = []
  await rattacherMenages(null, {
    supabase: fauxClient({ menages: [M({ id: 'm-null', token: null }), M({ id: 'm-vrai' })] }, journal),
    forcer: true
  })
  const maj = journal.find(j => j.table === 'ota_reviews' && j.op === 'update')
  assert.strictEqual(maj.row.menage_event_id, 'm-vrai')
})

test('le ménage est cherché sur le MÊME compte et le MÊME bien', async () => {
  // `booking_id` n'a aucune unicité globale : chercher par lui seul
  // rattacherait l'avis d'un hôte au ménage d'un autre (REVIEW.md règle 1).
  const journal = []
  await rattacherMenages(null, { supabase: fauxClient({ menages: [M()] }, journal), forcer: true })
  const lecture = journal.find(j => j.table === 'menage_events')
  assert.strictEqual(lecture.f.user_id, U)
  assert.strictEqual(lecture.f.property_id, '209413')
  assert.strictEqual(lecture.f.booking_id, '77')
})

// ─── La fenêtre glissante ───────────────────────────────────────────────────
test('le curseur est LU avant d\'être réécrit', async () => {
  // Le marqueur de cadence était upserté avec `total_messages: 0` AVANT la
  // lecture du curseur : `offset` valait toujours 0, la fenêtre ne glissait
  // jamais, et 200 avis non rattachables en tête bloquaient la file derrière.
  const journal = []
  await rattacherMenages(null, {
    supabase: fauxClient({ menages: [M()], curseur: 200 }, journal), forcer: true
  })
  const lecture = journal.find(j => j.table === 'ota_reviews' && j.range)
  assert.strictEqual(lecture.range[0], 200, 'la fenêtre doit repartir du curseur')
})

test('le curseur revient à zéro quand la file est épuisée', async () => {
  const journal = []
  await rattacherMenages(null, {
    supabase: fauxClient({ menages: [M()], curseur: 200 }, journal), forcer: true
  })
  const fin = journal.filter(j => j.table === 'cron_logs' && j.op === 'upsert').pop()
  assert.strictEqual(fin.row.total_messages, 0, 'lot incomplet : on repart du début')
})

test('le marqueur de cadence ne détruit pas le curseur', async () => {
  const journal = []
  await rattacherMenages(null, {
    supabase: fauxClient({ menages: [M()], curseur: 400 }, journal), forcer: true
  })
  const premier = journal.find(j => j.table === 'cron_logs' && j.op === 'upsert')
  assert.strictEqual(premier.row.total_messages, 400, 'le curseur est préservé')
})
