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
// ⚠ Ce double honore user_id sur `properties` ET sur `bookings_snapshot`, plus
// `provider`. Une version precedente ignorait les deux derniers : hisser l'index
// des codes OTA hors de la boucle des comptes — ce qui ferait rattacher l'avis
// d'un hote au sejour d'un autre — laissait toute la suite au vert.
// `snapshots` est indexe PAR COMPTE, comme la vraie table.
function fauxClient (opts = {}) {
  const { cles = [{ user_id: 'u1', api_key: 'jeton-u1' }], biens = [BIEN],
          journal = [], marqueur = null, marqueurs = null, snapshots = {} } = opts
  return {
    from (table) {
      const appel = { table, filtres: {}, op: 'select' }
      journal.push(appel)
      const chain = {
        select () { return chain },
        eq (c, v) { appel.filtres[c] = v; return chain },
        not () { return chain },
        maybeSingle () {
          if (table !== 'cron_logs') return Promise.resolve({ data: null, error: null })
          // `marqueurs` : un marqueur PAR compte, comme en base.
          if (marqueurs) return Promise.resolve({ data: marqueurs[appel.filtres.id] || null, error: null })
          return Promise.resolve({ data: marqueur, error: null })
        },
        upsert (row, o) { appel.op = 'upsert'; appel.row = row; appel.opts = o
                          return Promise.resolve({ error: null }) },
        then (r) {
          if (table === 'api_keys') return Promise.resolve({ data: cles, error: null }).then(r)
          if (table === 'properties') return Promise.resolve({
            data: biens.filter(b =>
              (appel.filtres.user_id == null || b.user_id === appel.filtres.user_id) &&
              (appel.filtres.provider == null || (b.provider || 'beds24') === appel.filtres.provider)),
            error: null }).then(r)
          if (table === 'bookings_snapshot') return Promise.resolve({
            data: snapshots[appel.filtres.user_id] || [], error: null }).then(r)
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
    supabase: fauxClient({ marqueurs: { 'beds24_reviews_poll:u1': { last_run: '2026-01-01T00:00:00Z' } } }),
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

test('poll : la cadence est PAR COMPTE, pas globale', async () => {
  // Un marqueur global affamait les derniers comptes et leur faisait perdre le
  // « premier passage » : ils auraient été lus un jour avec une fenêtre de
  // 400 jours au lieu de l'historique complet, perdant leurs avis plus anciens
  // en silence et définitivement.
  const vus = []
  const bilan = await pollBeds24Reviews(null, {
    supabase: fauxClient({
      cles: [{ user_id: 'u1', api_key: 'j1' }, { user_id: 'u2', api_key: 'j2' }],
      biens: [BIEN, { id: 'b2', user_id: 'u2', provider_property_id: '169567' }],
      // u1 vient d'être poll, u2 jamais.
      marqueurs: { 'beds24_reviews_poll:u1': { last_run: new Date().toISOString() } }
    }),
    beds24Call: async (chemin, token) => { vus.push({ chemin, token })
      return { ok: true, status: 200, json: { success: true, data: [] } } }
  })
  assert.strictEqual(bilan.sautes, 1, 'u1 est à jour, il est sauté')
  assert.strictEqual(bilan.comptes, 1, 'u2 est traité')
  assert.strictEqual(vus.length, 1)
  assert.strictEqual(vus[0].token, 'j2')
  assert.ok(vus[0].chemin.includes('from=2023-01-01'),
    'u2 n\'a jamais été poll : il garde SON premier passage, malgré celui de u1')
})

test('poll : le marqueur du compte est posé AVANT son travail', async () => {
  const journal = []
  await pollBeds24Reviews(null, { supabase: fauxClient({ journal }), forcer: true, beds24Call: APPEL_OK([]) })
  const iMarq = journal.findIndex(a => a.table === 'cron_logs' && a.op === 'upsert')
  const iBiens = journal.findIndex(a => a.table === 'properties')
  assert.ok(iMarq >= 0 && iMarq < iBiens, 'marqueur avant la lecture des biens du compte')
  const marq = journal.find(a => a.table === 'cron_logs' && a.op === 'upsert')
  assert.strictEqual(marq.row.id, 'beds24_reviews_poll:u1', 'un marqueur par compte')
})

// ─── Le séjour est résolu À L'INGESTION ─────────────────────────────────────
test('poll : le booking_uid est résolu, pas remis à un rattrapage inexistant', async () => {
  // Une première version comptait sur « un rattrapage commun » qui n'existe
  // pas : la passe séparée a été retirée au lot 2. Résultat mesuré sur les
  // données réelles : 0 avis rattaché sur 93, alors que 17 l'étaient.
  const journal = []
  const bilan = await pollBeds24Reviews(null, {
    supabase: fauxClient({ journal, snapshots: { u1: [{ booking_id: 77,
      snapshot: { otaReservationCode: '6539921682', arrival: '2026-06-15', departure: '2026-06-18' } }] } }),
    forcer: true, beds24Call: APPEL_OK([AVIS])
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

// ─── La portée de l'index des codes OTA ─────────────────────────────────────
test('poll : l\'index des séjours ne traverse JAMAIS les comptes', async () => {
  // Le point le plus dangereux du module. Deux hôtes peuvent porter le même
  // numéro de réservation Booking. Si l'index était chargé une seule fois pour
  // toute la boucle, l'avis du second serait écrit avec les dates du séjour du
  // premier — la collision exacte que décrit REVIEW.md règle 1.
  const journal = []
  const AVIS_U2 = { ...AVIS, review_id: 'autre-avis' }
  await pollBeds24Reviews(null, {
    supabase: fauxClient({
      cles: [{ user_id: 'u1', api_key: 'j1' }, { user_id: 'u2', api_key: 'j2' }],
      biens: [BIEN, { id: 'b2', user_id: 'u2', provider_property_id: '169567' }],
      // SEUL u1 a le séjour. u2 porte le même numéro de réservation côté avis.
      snapshots: { u1: [{ booking_id: 77, snapshot: {
        otaReservationCode: '6539921682', arrival: '2026-06-15', departure: '2026-06-18' } }] },
      journal
    }),
    forcer: true,
    beds24Call: async (chemin) => ({ ok: true, status: 200,
      json: { success: true, data: [chemin.includes('209413') ? AVIS : AVIS_U2] } })
  })
  const ecrits = journal.filter(a => a.table === 'ota_reviews' && a.op === 'upsert')
    .flatMap(a => Array.isArray(a.row) ? a.row : [a.row])
  const ligneU1 = ecrits.find(l => l.user_id === 'u1')
  const ligneU2 = ecrits.find(l => l.user_id === 'u2')
  assert.strictEqual(ligneU1.booking_uid, '77', 'u1 a bien son séjour')
  assert.ok(!('booking_uid' in ligneU2),
    'u2 ne doit PAS hériter du séjour de u1 malgré le même numéro de réservation')
})

test('poll : seuls les biens du provider beds24 sont interrogés', async () => {
  // Sans ce filtre, un bien Channex du même compte partirait dans une requête
  // Beds24 avec une référence qui n'y existe pas.
  const vus = []
  await pollBeds24Reviews(null, {
    supabase: fauxClient({ biens: [
      BIEN,
      { id: 'ch', user_id: 'u1', provider: 'channex', provider_property_id: '0544fd9a-1111' }
    ] }),
    forcer: true,
    beds24Call: async (chemin) => { vus.push(chemin); return { ok: true, status: 200, json: { success: true, data: [] } } }
  })
  assert.strictEqual(vus.length, 1)
  assert.ok(vus[0].includes('209413'))
})

// ─── Le budget ──────────────────────────────────────────────────────────────
test('poll : le budget mur coupe et la troncature se voit', async () => {
  // Aucun test n'exerçait le budget : retirer les deux gardes laissait la suite
  // au vert. Les deux modules frères ont ce test, celui-ci ne l'avait pas.
  let t = 0
  const results = { errors: [] }
  const bilan = await pollBeds24Reviews(results, {
    supabase: fauxClient({
      cles: [{ user_id: 'u1', api_key: 'j1' }, { user_id: 'u2', api_key: 'j2' }],
      biens: [BIEN, { id: 'b2', user_id: 'u2', provider_property_id: '169567' }]
    }),
    forcer: true,
    now: () => (t++ < 2 ? 0 : 999999),
    beds24Call: APPEL_OK([])
  })
  assert.strictEqual(bilan.interrompu, 'budget')
  assert.ok(results.errors.some(e => /tronque/.test(e.error)),
    'une troncature muette ressemble à un passage réussi')
})

// ─── Le lot mixte ───────────────────────────────────────────────────────────
test('poll : un lot MIXTE part en deux groupes homogènes', async () => {
  // Les clés absentes d'une ligne partent à NULL dans un upsert PostgREST :
  // mélanger une ligne avec ancrage et une sans écraserait l'ancrage de la
  // seconde. Le cas mixte n'était couvert par aucun test — les deux tests de
  // résolution n'avaient qu'un seul avis chacun.
  const journal = []
  const A1 = { ...AVIS, review_id: 'r1', reservation_id: 6539921682 }   // résolu
  const A2 = { ...AVIS, review_id: 'r2', reservation_id: 9999999999 }   // non résolu
  await pollBeds24Reviews(null, {
    supabase: fauxClient({ journal, snapshots: { u1: [{ booking_id: 77, snapshot: {
      otaReservationCode: '6539921682', arrival: '2026-06-15', departure: '2026-06-18' } }] } }),
    forcer: true, beds24Call: APPEL_OK([A1, A2])
  })
  const ecritures = journal.filter(a => a.table === 'ota_reviews' && a.op === 'upsert')
  assert.strictEqual(ecritures.length, 2, 'deux groupes, jamais un lot mixte')
  for (const e of ecritures) {
    const cles = e.row.map(l => 'booking_uid' in l)
    assert.ok(cles.every(v => v === cles[0]), 'chaque groupe est homogène en colonnes')
  }
})

// ─── Le réseau ──────────────────────────────────────────────────────────────
test('poll : une coupure réseau n\'interrompt pas les comptes suivants', async () => {
  // Sans try/catch, l'exception remontait hors du poll : le marqueur étant déjà
  // posé, aucune reprise avant 24 h, et les comptes suivants n'étaient pas
  // traités du tout.
  const vus = []
  const bilan = await pollBeds24Reviews(null, {
    supabase: fauxClient({
      cles: [{ user_id: 'u1', api_key: 'j1' }, { user_id: 'u2', api_key: 'j2' }],
      biens: [BIEN, { id: 'b2', user_id: 'u2', provider_property_id: '169567' }]
    }),
    forcer: true,
    beds24Call: async (chemin) => {
      vus.push(chemin)
      if (chemin.includes('209413')) throw new Error('ECONNRESET')
      return { ok: true, status: 200, json: { success: true, data: [] } }
    }
  })
  assert.strictEqual(vus.length, 2, 'le second compte doit être interrogé malgré la coupure du premier')
  assert.ok(bilan.erreurs >= 1)
})
