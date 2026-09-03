// tests/attribution-prestataire.test.js
// Qui a fait quel ménage — et surtout, quand on ne le sait PAS.
//
// ⚠ Le risque de ce module n'est pas de rater une attribution : c'est d'en
// inventer une. Un reproche qui tombe sur la mauvaise personne coûte plus cher
// qu'un reproche qui ne tombe sur personne. Ces tests fixent d'abord ce que le
// module doit REFUSER d'attribuer.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const { avisDuPrestataire, dateDeRattachement, dansLaPeriode } = require('../lib/attribution-prestataire')

const U = 'compte-1', P_REGINA = 'profil-regina', P_TIPH = 'profil-tiphaine'

// ─── La date qui situe l'avis ───────────────────────────────────────────────
test('dateDeRattachement : stay_end prime sur received_at', () => {
  // Un ménage précède le séjour ; l'avis peut tomber des semaines après. Se
  // fier à la date de l'avis rattacherait un séjour de juillet à la période
  // d'août.
  assert.strictEqual(dateDeRattachement({ stay_end: '2026-07-20', received_at: '2026-08-15T00:00:00Z' }), '2026-07-20')
})

test('dateDeRattachement : repli sur received_at quand le séjour est inconnu', () => {
  // 136 des 168 avis réels n'ont pas de séjour résolu. Approximation assumée.
  assert.strictEqual(dateDeRattachement({ stay_end: null, received_at: '2026-08-15T00:00:00Z' }), '2026-08-15')
  assert.strictEqual(dateDeRattachement({}), null)
})

test('dansLaPeriode : bornes INCLUSIVES', () => {
  const p = { debut: '2026-01-01', fin: '2026-07-31' }
  assert.strictEqual(dansLaPeriode('2026-07-31', p), true, 'le dernier jour compte')
  assert.strictEqual(dansLaPeriode('2026-08-01', p), false)
  assert.strictEqual(dansLaPeriode('2026-01-01', p), true)
  assert.strictEqual(dansLaPeriode('2025-12-31', p), false)
})

test('dansLaPeriode : une borne absente ne borne rien', () => {
  assert.strictEqual(dansLaPeriode('1999-01-01', { debut: null, fin: null }), true)
  assert.strictEqual(dansLaPeriode('2026-09-01', { debut: null, fin: '2026-07-31' }), false)
})

test('dansLaPeriode : un avis sans date n\'est JAMAIS attribué', () => {
  // Sans date, rien ne permet de dire s'il tombe dans la période. On ne devine
  // pas.
  assert.strictEqual(dansLaPeriode(null, { debut: null, fin: null }), false)
})

// ─── Le double ──────────────────────────────────────────────────────────────
function fauxClient (d = {}, journal = []) {
  const { profils = [], menages = [], periodes = [], avis = [] } = d
  return {
    from (table) {
      const a = { table, f: {}, ins: [] }
      journal.push(a)
      const chain = {
        select () { return chain },
        eq (c, v) { a.f[c] = v; return chain },
        not () { return chain },
        in (c, v) { a.ins.push({ c, v: (v || []).map(String) }); return chain },
        order () { return chain },
        limit () { return Promise.resolve(rep()) },
        maybeSingle () { const r = rep(); return Promise.resolve({ data: (r.data || [])[0] || null, error: r.error }) },
        then (r) { return Promise.resolve(rep()).then(r) }
      }
      function rep () {
        const filtre = (l) => Object.entries(a.f).every(([c, v]) =>
          c === 'statut' ? (l.statut || 'confirme') === v : String(l[c]) === String(v))
        const dansIn = (l) => a.ins.every(f => f.v.includes(String(l[f.c])))
        if (table === 'profiles') return { data: profils.filter(filtre), error: null }
        if (table === 'menage_events') return { data: menages.filter(filtre), error: null }
        if (table === 'prestataire_periodes') return { data: periodes.filter(filtre), error: null }
        if (table === 'ota_reviews') return { data: avis.filter(l => filtre(l) && dansIn(l)), error: null }
        return { data: [], error: null }
      }
      return chain
    }
  }
}

const REGINA = { id: P_REGINA, account_user_id: U, pwa_token: 'regina-x', active: true }
const TIPHAINE = { id: P_TIPH, account_user_id: U, pwa_token: null, active: false }

// ─── Ce qui ne doit PAS être attribué ───────────────────────────────────────
test('sans ménage NI période, une prestataire n\'a AUCUN avis', async () => {
  // Elle ne doit surtout pas hériter du ratio de l'hôte.
  const r = await avisDuPrestataire(fauxClient({
    profils: [REGINA],
    avis: [{ id: 'a1', user_id: U, property_id_ref: '209413', received_at: '2026-08-01T00:00:00Z' }]
  }), { userId: U, prestataireId: P_REGINA })
  assert.deepStrictEqual(r.ids, [])
})

test('le profil doit appartenir AU COMPTE', async () => {
  // Sans ce filtre, l'identifiant d'une prestataire d'un autre hôte rendrait
  // ses ménages (REVIEW.md règles 1 et 11).
  const journal = []
  const r = await avisDuPrestataire(fauxClient({
    profils: [{ ...REGINA, account_user_id: 'autre-compte' }]
  }, journal), { userId: U, prestataireId: P_REGINA })
  assert.deepStrictEqual(r.ids, [])
  assert.strictEqual(journal[0].f.account_user_id, U)
})

test('sans prestataireId, rien n\'est attribué et aucune requête n\'est faite', async () => {
  const journal = []
  const r = await avisDuPrestataire(fauxClient({}, journal), { userId: U })
  assert.deepStrictEqual(r.ids, [])
  assert.strictEqual(journal.length, 0)
})

test('un avis HORS de la période déclarée n\'est pas attribué', async () => {
  // C'est la borne du 31 juillet : après, seul le ménage précis compte.
  const r = await avisDuPrestataire(fauxClient({
    profils: [TIPHAINE],
    periodes: [{ user_id: U, provider_id: P_TIPH, property_id_ref: 'COL', debut: null, fin: '2026-07-31' }],
    avis: [
      { id: 'avant', user_id: U, property_id_ref: 'COL', stay_end: '2026-07-15' },
      { id: 'apres', user_id: U, property_id_ref: 'COL', stay_end: '2026-08-10' }
    ]
  }), { userId: U, prestataireId: P_TIPH })
  assert.deepStrictEqual(r.ids, ['avant'])
})

test('un avis d\'un AUTRE bien n\'est pas attribué', async () => {
  const r = await avisDuPrestataire(fauxClient({
    profils: [TIPHAINE],
    periodes: [{ user_id: U, provider_id: P_TIPH, property_id_ref: 'COL', debut: null, fin: null }],
    avis: [{ id: 'x', user_id: U, property_id_ref: 'AUTRE', stay_end: '2026-07-15' }]
  }), { userId: U, prestataireId: P_TIPH })
  assert.deepStrictEqual(r.ids, [])
})

// ─── Les deux voies ─────────────────────────────────────────────────────────
test('voie 1 : le ménage précis attribue, même sans période', async () => {
  const r = await avisDuPrestataire(fauxClient({
    profils: [REGINA],
    menages: [{ id: 'm1', user_id: U, token: 'regina-x' }],
    avis: [{ id: 'a1', user_id: U, menage_event_id: 'm1', property_id_ref: '209413' }]
  }), { userId: U, prestataireId: P_REGINA })
  assert.deepStrictEqual(r.ids, ['a1'])
  assert.strictEqual(r.parMenage, 1)
  assert.strictEqual(r.parPeriode, 0)
})

test('une prestataire SANS token n\'a aucun ménage — et c\'est correct', async () => {
  // Identité d'attribution historique : elle ne travaille plus, elle n'a jamais
  // eu de lien PWA. Seules ses périodes déclarées comptent.
  const journal = []
  const r = await avisDuPrestataire(fauxClient({
    profils: [TIPHAINE],
    menages: [{ id: 'm1', user_id: U, token: 'regina-x' }],
    periodes: [{ user_id: U, provider_id: P_TIPH, property_id_ref: 'COL', debut: null, fin: null }],
    avis: [{ id: 'a1', user_id: U, property_id_ref: 'COL', stay_end: '2026-05-01' }]
  }, journal), { userId: U, prestataireId: P_TIPH })
  assert.deepStrictEqual(r.ids, ['a1'])
  assert.strictEqual(r.parPeriode, 1)
  assert.ok(!journal.some(j => j.table === 'menage_events'), 'aucune requête ménage sans token')
})

test('un avis pris par les DEUX voies n\'est compté qu\'une fois', async () => {
  // Et c'est le ménage précis qui prime : il est plus fiable qu'une période
  // déclarée.
  const r = await avisDuPrestataire(fauxClient({
    profils: [REGINA],
    menages: [{ id: 'm1', user_id: U, token: 'regina-x' }],
    periodes: [{ user_id: U, provider_id: P_REGINA, property_id_ref: '209413', debut: null, fin: null }],
    avis: [{ id: 'a1', user_id: U, menage_event_id: 'm1', property_id_ref: '209413', stay_end: '2026-05-01' }]
  }), { userId: U, prestataireId: P_REGINA })
  assert.deepStrictEqual(r.ids, ['a1'])
  assert.strictEqual(r.parMenage, 1)
  assert.strictEqual(r.parPeriode, 0, 'le ménage précis prime sur la période déclarée')
})

test('le repli received_at attribue quand le séjour est inconnu', async () => {
  const r = await avisDuPrestataire(fauxClient({
    profils: [TIPHAINE],
    periodes: [{ user_id: U, provider_id: P_TIPH, property_id_ref: 'COL', debut: null, fin: '2026-07-31' }],
    avis: [{ id: 'a1', user_id: U, property_id_ref: 'COL', stay_end: null, received_at: '2026-06-10T00:00:00Z' }]
  }), { userId: U, prestataireId: P_TIPH })
  assert.deepStrictEqual(r.ids, ['a1'])
})

test('les avis NON confirmés ne sont jamais attribués', async () => {
  const journal = []
  await avisDuPrestataire(fauxClient({
    profils: [TIPHAINE],
    periodes: [{ user_id: U, provider_id: P_TIPH, property_id_ref: 'COL', debut: null, fin: null }],
    avis: [{ id: 'a1', user_id: U, property_id_ref: 'COL', stay_end: '2026-05-01', statut: 'detecte' }]
  }, journal), { userId: U, prestataireId: P_TIPH })
  const lecture = journal.find(j => j.table === 'ota_reviews')
  assert.strictEqual(lecture.f.statut, 'confirme')
})

test('une panne se signale, elle ne rend pas « aucun avis »', async () => {
  const sb = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({
    maybeSingle: async () => ({ data: null, error: { message: 'timeout' } }) }) }) }) }) }
  const r = await avisDuPrestataire(sb, { userId: U, prestataireId: P_REGINA })
  assert.strictEqual(r.erreur, true)
})
