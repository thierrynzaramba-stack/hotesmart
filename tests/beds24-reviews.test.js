// tests/beds24-reviews.test.js
// Poll des avis Booking.com des biens Beds24.
//
// Les pièges de ce provider sont différents de Channex, et chacun de ces tests
// vient d'un fait mesuré sur les 93 avis réels du compte.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')

const { pollBeds24Reviews, extraireContenu, normaliserScores, extraireReponse, versIso, versLigne }
  = require('../lib/cron-beds24-reviews')

const BIEN = { id: 'uuid-bien', user_id: 'u1', provider_property_id: '209413' }
const AVIS = {
  review_id: 'PItY3gyvTnc',
  created_timestamp: '2026-06-19 12:34:53',
  last_change_timestamp: '2026-06-19 12:55:50',
  content: { headline: null, positive: 'Très propre', negative: null, language_code: 'fr' },
  reservation_id: 6539921682,
  scoring: { facilities: 7.5, comfort: 10, staff: null, value: 7.5, clean: 10, location: 10, review_score: 9 },
  reviewer: { name: 'Fabien', country_code: 'fr', is_genius: false },
  reply: null
}

// ─── `content` est un OBJET ─────────────────────────────────────────────────
test('extraireContenu : un objet, jamais « [object Object] »', () => {
  // Même piège que le `reply` de Channex, qui avait produit 68 réponses
  // fantômes « {} » en base.
  const c = extraireContenu({ headline: 'Séjour top', positive: 'Propre', negative: 'Bruyant', language_code: 'fr' })
  assert.ok(c.texte.includes('Propre') && c.texte.includes('Bruyant') && c.texte.includes('Séjour top'))
  assert.strictEqual(c.langue, 'fr')
})

test('extraireContenu : content null (29 avis sur 93)', () => {
  assert.deepStrictEqual(extraireContenu(null), { texte: null, langue: null })
  assert.strictEqual(extraireContenu({ headline: null, positive: null, negative: null }).texte, null)
})

test('extraireContenu : la langue est conservée', () => {
  // Des avis sont en espagnol. Le prompt porte une consigne explicite pour que
  // l'extrait ne soit pas traduit — sinon le contrôle de citation le rejetterait.
  assert.strictEqual(extraireContenu({ positive: 'ok', language_code: 'es' }).langue, 'es')
})

// ─── Les scores ─────────────────────────────────────────────────────────────
test('normaliserScores : format commun, review_score exclu', () => {
  const s = normaliserScores(AVIS.scoring)
  assert.ok(!s.some(x => x.category === 'review_score'), 'le score global n\'est pas une catégorie')
  assert.ok(s.some(x => x.category === 'clean' && x.score === 10))
  // `staff` vaut null sur cet avis : une catégorie sans note n'est pas une note.
  assert.ok(!s.some(x => x.category === 'staff'))
})

test('versLigne : les notes sont stockées BRUTES', () => {
  const l = versLigne(AVIS, BIEN)
  assert.strictEqual(l.overall_score, 9)
  assert.strictEqual(l.score_clean, 10)
})

test('versLigne : clean absent -> null, jamais 0', () => {
  // 4 avis sur 93 ont clean à null. Le confondre avec 0 déclencherait le seuil
  // et produirait une remarque sur un avis qui n'en contient pas.
  const l = versLigne({ ...AVIS, scoring: { review_score: 8, clean: null } }, BIEN)
  assert.strictEqual(l.score_clean, null)
})

// ─── Les horodatages ────────────────────────────────────────────────────────
test('versIso : « 2026-06-19 12:34:53 » est traité comme UTC', () => {
  // Beds24 rend un format ni ISO ni fuseau. Laisser le moteur deviner ferait
  // dépendre la date de la machine qui exécute le cron.
  assert.strictEqual(versIso('2026-06-19 12:34:53'), '2026-06-19T12:34:53.000Z')
  assert.strictEqual(versIso(''), null)
  assert.strictEqual(versIso('pas une date'), null)
  assert.strictEqual(versIso(null), null)
})

// ─── La ligne écrite ────────────────────────────────────────────────────────
test('versLigne : provider beds24, ota booking', () => {
  const l = versLigne(AVIS, BIEN)
  assert.strictEqual(l.provider, 'beds24')
  assert.strictEqual(l.ota, 'booking')
  assert.strictEqual(l.external_review_id, 'PItY3gyvTnc')
  assert.strictEqual(l.ota_reservation_id, '6539921682')
  assert.strictEqual(l.user_id, 'u1')
  assert.strictEqual(l.property_id, BIEN.id)
  assert.strictEqual(l.property_id_ref, '209413')
})

test('versLigne : l\'ancrage de séjour est ABSENT, jamais à null', () => {
  // Il sera posé par le rattrapage commun sur ota_reservation_id. À null, il
  // écraserait une résolution obtenue plus tôt.
  const l = versLigne(AVIS, BIEN)
  assert.ok(!('booking_uid' in l))
  assert.ok(!('stay_start' in l))
})

test('versLigne : Booking.com n\'a pas de retour privé', () => {
  const l = versLigne(AVIS, BIEN)
  assert.strictEqual(l.content_private, undefined)
})

test('extraireReponse : un objet vide n\'est pas une réponse', () => {
  assert.strictEqual(extraireReponse({}), null)
  assert.strictEqual(extraireReponse(null), null)
  assert.strictEqual(extraireReponse({ reply: 'Merci !' }), 'Merci !')
  assert.strictEqual(extraireReponse('Merci'), 'Merci')
})

// ─── Le poll ────────────────────────────────────────────────────────────────
function fauxClient (opts = {}) {
  const { cles = [{ user_id: 'u1', api_key: 'jeton-u1' }], biens = [BIEN],
          journal = [], marqueur = null } = opts
  return {
    from (table) {
      const appel = { table, filtres: {}, op: 'select' }
      journal.push(appel)
      const chain = {
        select () { return chain },
        eq (c, v) { appel.filtres[c] = v; return chain },
        not () { return chain },
        maybeSingle () {
          return Promise.resolve({ data: table === 'cron_logs' ? marqueur : null, error: null })
        },
        upsert (row, o) { appel.op = 'upsert'; appel.row = row; appel.opts = o
                          return Promise.resolve({ error: null }) },
        then (r) {
          if (table === 'api_keys') return Promise.resolve({ data: cles, error: null }).then(r)
          if (table === 'properties') return Promise.resolve({
            data: biens.filter(b => appel.filtres.user_id == null || b.user_id === appel.filtres.user_id),
            error: null }).then(r)
          return Promise.resolve({ data: [], error: null }).then(r)
        }
      }
      return chain
    }
  }
}

const APPEL_OK = (avis) => async () => ({ ok: true, status: 200, json: { success: true, count: avis.length, data: avis } })

test('poll : le jeton utilisé est celui DU COMPTE du bien', async () => {
  // Contrairement à Channex (une clé plateforme), Beds24 a une clé par hôte.
  // Utiliser le mauvais jeton lirait les avis d'un autre compte.
  const vus = []
  await pollBeds24Reviews(null, {
    supabase: fauxClient({
      cles: [{ user_id: 'u1', api_key: 'jeton-u1' }, { user_id: 'u2', api_key: 'jeton-u2' }],
      biens: [BIEN, { id: 'b2', user_id: 'u2', provider_property_id: '169567' }]
    }),
    forcer: true,
    beds24Call: async (chemin, token) => { vus.push({ chemin, token }); return { ok: true, status: 200, json: { success: true, data: [] } } }
  })
  const u1 = vus.find(v => v.chemin.includes('209413'))
  const u2 = vus.find(v => v.chemin.includes('169567'))
  assert.strictEqual(u1.token, 'jeton-u1')
  assert.strictEqual(u2.token, 'jeton-u2')
})

test('poll : `from` est TOUJOURS présent dans l\'URL', async () => {
  // Sans lui, l'endpoint répond 400 quels que soient les autres paramètres.
  const vus = []
  await pollBeds24Reviews(null, {
    supabase: fauxClient({}), forcer: true,
    beds24Call: async (chemin) => { vus.push(chemin); return { ok: true, status: 200, json: { success: true, data: [] } } }
  })
  assert.ok(vus[0].includes('from='), vus[0])
  assert.ok(vus[0].includes('propertyId=209413'))
})

test('poll : premier passage -> historique complet ; ensuite -> fenêtre glissante', async () => {
  const vus = []
  const stub = async (chemin) => { vus.push(chemin); return { ok: true, status: 200, json: { success: true, data: [] } } }
  await pollBeds24Reviews(null, { supabase: fauxClient({}), forcer: true, beds24Call: stub })
  assert.ok(vus[0].includes('from=2023-01-01'), 'premier passage : tout l\'historique')

  vus.length = 0
  await pollBeds24Reviews(null, {
    supabase: fauxClient({ marqueur: { last_run: '2026-01-01T00:00:00Z' } }),
    forcer: true, beds24Call: stub
  })
  assert.ok(!vus[0].includes('2023-01-01'), 'ensuite : fenêtre glissante')
  assert.ok(vus[0].includes('from=20'))
})

test('poll : un avis sans review_id n\'est pas écrit', async () => {
  // L'unicité porte sur external_review_id : sans lui, pas d'idempotence.
  const journal = []
  const bilan = await pollBeds24Reviews(null, {
    supabase: fauxClient({ journal }), forcer: true,
    beds24Call: APPEL_OK([{ ...AVIS, review_id: null }])
  })
  assert.strictEqual(bilan.ecrits, 0)
  assert.strictEqual(bilan.erreurs, 1)
})

test('poll : une réponse en échec ne fait pas écrire, et se signale', async () => {
  const results = { errors: [] }
  const bilan = await pollBeds24Reviews(results, {
    supabase: fauxClient({}), forcer: true,
    beds24Call: async () => ({ ok: false, status: 400, json: { success: false } })
  })
  assert.strictEqual(bilan.ecrits, 0)
  assert.ok(results.errors.length >= 1)
})

test('poll : `success: false` avec un HTTP 200 est traité comme un échec', async () => {
  // Beds24 rend 200 avec success:false sur certaines erreurs — et 200 null sur
  // un chemin inexistant. Ne regarder que le statut HTTP masquerait les deux.
  const bilan = await pollBeds24Reviews(null, {
    supabase: fauxClient({}), forcer: true,
    beds24Call: async () => ({ ok: true, status: 200, json: { success: false, error: 'Invalid data' } })
  })
  assert.strictEqual(bilan.ecrits, 0)
  assert.strictEqual(bilan.erreurs, 1)
})

test('poll : la cadence quotidienne est respectée', async () => {
  const r = await pollBeds24Reviews(null, {
    supabase: fauxClient({ marqueur: { last_run: new Date().toISOString() } }),
    beds24Call: APPEL_OK([])
  })
  assert.strictEqual(r.skipped, 'cadence')
})

test('poll : le marqueur est posé AVANT le travail', async () => {
  const journal = []
  await pollBeds24Reviews(null, { supabase: fauxClient({ journal }), forcer: true, beds24Call: APPEL_OK([]) })
  const iMarq = journal.findIndex(a => a.table === 'cron_logs' && a.op === 'upsert')
  const iTrav = journal.findIndex(a => a.table === 'api_keys')
  assert.ok(iMarq >= 0 && iMarq < iTrav)
})

// ─── Le séjour est résolu À L'INGESTION ─────────────────────────────────────
test('poll : le booking_uid est résolu, pas remis à un rattrapage inexistant', async () => {
  // Une première version comptait sur « un rattrapage commun » qui n'existe
  // pas : la passe séparée a été retirée au lot 2. Résultat mesuré sur les
  // données réelles : 0 avis rattaché sur 93, alors que 17 l'étaient.
  const journal = []
  const sb = fauxClient({ journal })
  // bookings_snapshot : l'index du compte contient le code OTA de l'avis.
  const orig = sb.from.bind(sb)
  sb.from = (t) => {
    const c = orig(t)
    if (t === 'bookings_snapshot') {
      c.then = (r) => Promise.resolve({ data: [{ booking_id: 77,
        snapshot: { otaReservationCode: '6539921682', arrival: '2026-06-15', departure: '2026-06-18' } }],
        error: null }).then(r)
    }
    return c
  }
  const bilan = await pollBeds24Reviews(null, {
    supabase: sb, forcer: true, beds24Call: APPEL_OK([AVIS])
  })
  assert.strictEqual(bilan.resolus, 1, 'l\'avis doit être rattaché à son séjour')
  const ecr = journal.find(a => a.table === 'ota_reviews' && a.op === 'upsert')
  const ligne = (Array.isArray(ecr.row) ? ecr.row : [ecr.row])[0]
  assert.strictEqual(ligne.booking_uid, '77')
  assert.strictEqual(ligne.stay_start, '2026-06-15')
})

test('poll : un avis non résolu n\'emprunte pas les dates d\'un autre', async () => {
  const journal = []
  const bilan = await pollBeds24Reviews(null, {
    supabase: fauxClient({ journal }), forcer: true, beds24Call: APPEL_OK([AVIS])
  })
  assert.strictEqual(bilan.resolus, 0)
  const ecr = journal.find(a => a.table === 'ota_reviews' && a.op === 'upsert')
  const ligne = (Array.isArray(ecr.row) ? ecr.row : [ecr.row])[0]
  assert.ok(!('booking_uid' in ligne), 'absent, jamais à null')
})
