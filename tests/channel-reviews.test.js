// tests/channel-reviews.test.js
// Lancement : npm test  (node --test, aucune dépendance externe)
//
// Le poll des avis tourne en service key : la RLS ne le protège pas. Ces tests
// portent donc d'abord sur le CLOISONNEMENT (REVIEW.md règle 1), et sont écrits
// pour ÉCHOUER si on retirait un filtre user_id — pas seulement pour passer.

// lib/cron-shared.js cree un client Supabase AU CHARGEMENT du module. Des
// valeurs factices suffisent : le poll recoit son client par injection (deps),
// et aucune de ces fonctions n'ouvre de connexion reelle.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-key'
// Le module lit CHANNEL_* au chargement : sans elles, le poll est un no-op.
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'http://channel.test/api/v1'
process.env.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY || 'cle-de-test'

const test = require('node:test')
const assert = require('node:assert')

const {
  normaliserOta,
  extraireContenu,
  extraireScoreClean,
  versLigne,
  proprietaireDuBien,
  chargerIndexCompte,
  pollChannelReviews
} = require('../lib/cron-channel-reviews')

// ─── Normalisation de l'OTA ─────────────────────────────────────────────────
test('normaliserOta : les libellés réels de Channex', () => {
  assert.strictEqual(normaliserOta('AirBNB'), 'airbnb')
  assert.strictEqual(normaliserOta('BookingCom'), 'booking')
  assert.strictEqual(normaliserOta('  airbnb '), 'airbnb')
})

test('normaliserOta : une OTA inconnue reste reconnaissable, elle n\'est pas inventée', () => {
  // Le pire serait de la ranger sous 'airbnb' : les catégories de scores et le
  // découpage public/privé en dépendent.
  assert.strictEqual(normaliserOta('Expedia'), 'expedia')
  assert.strictEqual(normaliserOta(''), 'inconnu')
  assert.strictEqual(normaliserOta(null), 'inconnu')
})

// ─── Contenu public / privé ─────────────────────────────────────────────────
test('extraireContenu Airbnb : public_review et private_feedback séparés', () => {
  const c = extraireContenu(
    { public_review: 'Très bien', private_feedback: 'Le lit grince' }, 'airbnb', 'texte complet')
  assert.strictEqual(c.public, 'Très bien')
  assert.strictEqual(c.prive, 'Le lit grince')
})

test('extraireContenu Booking : tout est public, aucun retour privé', () => {
  const c = extraireContenu(
    { headline: 'Séjour agréable', positive: 'Propre', negative: 'Bruyant' }, 'booking', null)
  assert.strictEqual(c.prive, null, 'Booking n\'a pas de retour privé')
  assert.ok(c.public.includes('Propre') && c.public.includes('Bruyant'))
})

test('extraireContenu : raw_content vide -> on retombe sur content', () => {
  // Cas réel : un des deux avis Booking de la sonde a un raw_content vide.
  assert.strictEqual(extraireContenu({}, 'booking', 'de secours').public, 'de secours')
  assert.strictEqual(extraireContenu(null, 'airbnb', 'de secours').public, 'de secours')
})

test('extraireContenu : un feedback privé ne peut pas fuiter dans le public', () => {
  const c = extraireContenu({ private_feedback: 'confidentiel' }, 'airbnb', null)
  assert.strictEqual(c.public, null)
  assert.strictEqual(c.prive, 'confidentiel')
})

// ─── Score de propreté ──────────────────────────────────────────────────────
test('extraireScoreClean : catégorie clean des deux OTA', () => {
  assert.strictEqual(extraireScoreClean([{ category: 'accuracy', score: 10 }, { category: 'clean', score: 8 }]), 8)
  assert.strictEqual(extraireScoreClean([{ category: 'cleanliness', score: 7.5 }]), 7.5)
  assert.strictEqual(extraireScoreClean([{ category: 'value', score: 9 }]), null)
  assert.strictEqual(extraireScoreClean(null), null)
})

test('extraireScoreClean : un score de 0 est une note, pas une absence', () => {
  assert.strictEqual(extraireScoreClean([{ category: 'clean', score: 0 }]), 0)
})

// ─── Construction de la ligne ───────────────────────────────────────────────
const AVIS_AIRBNB = {
  id: 'rev-1',
  attributes: {
    id: 'rev-1', ota: 'AirBNB', overall_score: 8,
    scores: [{ category: 'clean', score: 8 }, { category: 'value', score: 10 }],
    tags: ['guest_review_host_negative_unclear_instructions'],
    content: 'Public review:\r\nTrès agréable',
    raw_content: { public_review: 'Très agréable', private_feedback: 'Wifi faible' },
    reply: null, is_replied: false, is_hidden: false,
    ota_reservation_id: 'HM5WHSHYMQ',
    received_at: '2026-08-30T18:29:33.852000',
    expired_at: '2026-09-29T18:29:33.852000', is_expired: false,
    updated_at: '2026-08-30T18:29:55.464421',
    guest_name: 'Fanny D.', meta: { listing_id: '1246359231705217087' }
  },
  relationships: {
    property: { data: { id: 'prop-ref-1' } },
    channel:  { data: { id: 'chan-1' } },
    booking:  { data: { id: 'bk-uuid-1' } }
  }
}

test('versLigne : les notes sont stockées BRUTES, jamais converties', () => {
  // Chez Booking, un overall_score de 1 coexiste avec des catégories à 2.5 :
  // les deux échelles ne coïncident pas. Convertir à l'ingestion graverait
  // l'erreur dans le cœur, où elle serait irréversible.
  const l = versLigne(AVIS_AIRBNB, { userId: 'u1', propertyId: 'uuid-1', propertyRef: 'prop-ref-1' })
  assert.strictEqual(l.overall_score, 8)
  assert.strictEqual(l.score_clean, 8)
  assert.deepStrictEqual(l.scores, AVIS_AIRBNB.attributes.scores)
})

test('versLigne : le payload intégral est conservé dans raw', () => {
  const l = versLigne(AVIS_AIRBNB, { userId: 'u1', propertyId: 'uuid-1', propertyRef: 'prop-ref-1' })
  assert.deepStrictEqual(l.raw, AVIS_AIRBNB)
})

test('versLigne : provider_updated_at ne se confond pas avec notre updated_at', () => {
  const l = versLigne(AVIS_AIRBNB, { userId: 'u1', propertyId: 'uuid-1', propertyRef: 'prop-ref-1' })
  assert.strictEqual(l.provider_updated_at, '2026-08-30T18:29:55.464421')
  assert.ok(!('updated_at' in l), 'updated_at est posé par le trigger, pas par le poll')
})

test('versLigne : les trois identifiants de rattachement sont distincts', () => {
  const l = versLigne(AVIS_AIRBNB, { userId: 'u1', propertyId: 'uuid-1', propertyRef: 'prop-ref-1' })
  assert.strictEqual(l.ota_reservation_id, 'HM5WHSHYMQ')   // code OTA
  assert.strictEqual(l.provider_booking_id, 'bk-uuid-1')   // UUID booking Channex
  assert.strictEqual(l.booking_uid, undefined)             // résolu plus tard, contre le snapshot
})

test('versLigne : booléens absents -> false, jamais null (colonnes not null)', () => {
  const l = versLigne({ id: 'x', attributes: { id: 'x', ota: 'AirBNB' } }, { userId: 'u1', propertyId: 'p', propertyRef: 'r' })
  assert.strictEqual(l.is_replied, false)
  assert.strictEqual(l.is_hidden, false)
  assert.strictEqual(l.is_expired, false)
})

test('versLigne : le user_id vient du bien résolu, jamais du payload', () => {
  // Un payload provider ne doit à aucun moment pouvoir désigner le compte cible.
  const empoisonne = JSON.parse(JSON.stringify(AVIS_AIRBNB))
  empoisonne.attributes.user_id = 'compte-attaquant'
  const l = versLigne(empoisonne, { userId: 'u1', propertyId: 'uuid-1', propertyRef: 'prop-ref-1' })
  assert.strictEqual(l.user_id, 'u1')
})

// ─── Faux client Supabase qui ENREGISTRE les filtres ────────────────────────
// Enregistrer les filtres est le point clé : sans cela, un test peut passer
// alors que le filtre user_id a été retiré du code.
function fakeSupabase (tables = {}, journal = []) {
  return {
    from (table) {
      const appel = { table, filtres: [], op: null }
      journal.push(appel)
      const chain = {
        select () { appel.op = appel.op || 'select'; return this },
        eq (col, val) { appel.filtres.push([col, val]); return this },
        is (col, val) { appel.filtres.push(['is:' + col, val]); return this },
        not (col, op, val) { appel.filtres.push(['not:' + col, op, val]); return this },
        order () { return this },
        limit () { return Promise.resolve(tables[table] || { data: [], error: null }) },
        maybeSingle () { return Promise.resolve(tables[table] || { data: null, error: null }) },
        upsert (row, opts) { appel.op = 'upsert'; appel.row = row; appel.opts = opts; return Promise.resolve({ error: null }) },
        update (row) { appel.op = 'update'; appel.row = row; return this },
        then (r) { return Promise.resolve(tables[table] || { data: [], error: null }).then(r) }
      }
      return chain
    }
  }
}

// ─── Résolution du propriétaire ─────────────────────────────────────────────
test('proprietaireDuBien : bien inconnu -> absent (et surtout pas un compte au hasard)', async () => {
  const sb = fakeSupabase({ properties: { data: [], error: null } })
  assert.deepStrictEqual(await proprietaireDuBien(sb, 'inconnu'), { absent: true })
})

test('proprietaireDuBien : DEUX biens sur la même référence -> ambigu, pas absent', async () => {
  // provider_property_id n'a aucune contrainte d'unicité globale : deux hôtes
  // d'un même property manager portent la même référence. Deviner reviendrait à
  // écrire l'avis d'un hôte dans le compte d'un autre.
  const sb = fakeSupabase({ properties: { data: [{ user_id: 'a' }, { user_id: 'b' }], error: null } })
  const r = await proprietaireDuBien(sb, 'partagee')
  assert.strictEqual(r.ambigu, true)
  assert.strictEqual(r.owner, undefined)
})

test('proprietaireDuBien : deux lignes du MÊME compte ne sont pas une ambiguïté', async () => {
  // `properties` n'a aucune unicité sur (user_id, provider_property_id) et
  // api/channel-property.js crée par INSERT nu : un double envoi du formulaire
  // suffit à doubler la ligne. Traiter ce cas comme ambigu ferait perdre TOUS
  // les avis du bien, définitivement et en silence, le poll rejouant à
  // l'identique chaque jour.
  const sb = fakeSupabase({ properties: { data: [
    { id: 'a', user_id: 'u1', provider_property_id: 'ref-1' },
    { id: 'b', user_id: 'u1', provider_property_id: 'ref-1' }
  ], error: null } })
  const r = await proprietaireDuBien(sb, 'ref-1')
  assert.strictEqual(r.ambigu, undefined, 'un doublon interne au compte reste résolvable')
  assert.strictEqual(r.owner.user_id, 'u1')
})

test('proprietaireDuBien : une panne SQL n\'est pas une absence', async () => {
  const sb = fakeSupabase({ properties: { data: null, error: { message: 'boom' } } })
  const r = await proprietaireDuBien(sb, 'x')
  assert.strictEqual(r.erreur, true)
  assert.strictEqual(r.absent, undefined)
})

test('proprietaireDuBien : la requête filtre sur le provider ET sur la référence', async () => {
  const journal = []
  const sb = fakeSupabase({ properties: { data: [{ user_id: 'u1' }], error: null } }, journal)
  await proprietaireDuBien(sb, 'ref-1')
  const cols = journal[0].filtres.map(f => f[0])
  assert.ok(cols.includes('provider'), 'sans filtre provider, un bien Beds24 de même id pourrait matcher')
  assert.ok(cols.includes('provider_property_id'))
})

// ─── Orchestration du poll ──────────────────────────────────────────────────
// Faux client multi-tables : chaque appel est journalisé avec sa table, ses
// filtres et son opération, pour pouvoir affirmer CE QUI a été écrit et OÙ.
function fauxClient (donnees = {}, journal = []) {
  return {
    from (table) {
      const appel = { table, filtres: [], op: 'select' }
      journal.push(appel)
      const resultat = () => Promise.resolve(donnees[table] || { data: [], error: null })
      const chain = {
        select () { return this },
        eq (c, v) { appel.filtres.push([c, v]); return this },
        is (c, v) { appel.filtres.push(['is:' + c, v]); return this },
        not (c, o, v) { appel.filtres.push(['not:' + c, o, v]); return this },
        order () { return this },
        limit () { return resultat() },
        maybeSingle () { return Promise.resolve({ data: (donnees[table] || {}).single ?? null, error: null }) },
        upsert (row, opts) { appel.op = 'upsert'; appel.row = row; appel.opts = opts; return Promise.resolve({ error: null }) },
        update (row) { appel.op = 'update'; appel.row = row; return this },
        then (r) { return resultat().then(r) }
      }
      return chain
    }
  }
}

function pageAvis (avis) {
  return async () => ({ ok: true, status: 200, json: { data: avis, meta: { limit: 100 } } })
}

test('poll : le marqueur est posé AVANT le travail, pas après', async () => {
  // Si le cycle de 60 s tuait l'invocation en cours de poll, un marqueur posé
  // à la fin ne serait jamais écrit : le poll repartirait à CHAQUE tick de
  // 5 min et mangerait le budget du reste du cron.
  const journal = []
  const sb = fauxClient({
    properties: { data: [{ id: 'uuid-1', user_id: 'u1', provider_property_id: 'prop-ref-1' }], error: null }
  }, journal)
  await pollChannelReviews(null, { supabase: sb, channelCall: pageAvis([AVIS_AIRBNB]), forcer: true })

  const idxMarqueur = journal.findIndex(a => a.table === 'cron_logs' && a.op === 'upsert')
  const idxEcriture = journal.findIndex(a => a.table === 'ota_reviews' && a.op === 'upsert')
  assert.ok(idxMarqueur >= 0, 'le marqueur doit être écrit')
  assert.ok(idxEcriture >= 0, 'l\'avis doit être écrit')
  assert.ok(idxMarqueur < idxEcriture, 'le marqueur doit précéder la première écriture d\'avis')
})

test('poll : respecte la cadence quotidienne', async () => {
  const sb = fauxClient({ cron_logs: { single: { last_run: new Date().toISOString() } } })
  const r = await pollChannelReviews(null, { supabase: sb, channelCall: pageAvis([AVIS_AIRBNB]) })
  assert.strictEqual(r.skipped, 'cadence')
})

test('poll : un avis dont le bien est INCONNU n\'est jamais écrit', async () => {
  // Une seule clé Channex voit les avis de TOUS les comptes de la plateforme.
  // Un bien non rattaché est un avis qui n'appartient à personne ici.
  const journal = []
  const sb = fauxClient({ properties: { data: [], error: null } }, journal)
  const bilan = await pollChannelReviews(null, { supabase: sb, channelCall: pageAvis([AVIS_AIRBNB]), forcer: true })
  assert.strictEqual(bilan.bien_inconnu, 1)
  assert.strictEqual(bilan.ecrits, 0)
  assert.ok(!journal.some(a => a.table === 'ota_reviews' && a.op === 'upsert'))
})

test('poll : un bien AMBIGU n\'est pas écrit au hasard dans l\'un des deux comptes', async () => {
  const journal = []
  const sb = fauxClient({
    properties: { data: [{ id: 'a', user_id: 'u1' }, { id: 'b', user_id: 'u2' }], error: null }
  }, journal)
  const bilan = await pollChannelReviews(null, { supabase: sb, channelCall: pageAvis([AVIS_AIRBNB]), forcer: true })
  assert.strictEqual(bilan.bien_ambigu, 1)
  assert.strictEqual(bilan.ecrits, 0)
  assert.ok(!journal.some(a => a.table === 'ota_reviews' && a.op === 'upsert'),
    'mieux vaut un avis manquant qu\'un avis chez le mauvais hôte')
})

test('poll : une panne SQL sur properties n\'écrit rien et ne compte pas comme inconnu', async () => {
  const sb = fauxClient({ properties: { data: null, error: { message: 'boom' } } })
  const bilan = await pollChannelReviews(null, { supabase: sb, channelCall: pageAvis([AVIS_AIRBNB]), forcer: true })
  assert.strictEqual(bilan.erreurs, 1)
  assert.strictEqual(bilan.ecrits, 0)
  assert.strictEqual(bilan.bien_inconnu, 0)
})

test('poll : l\'upsert est idempotent sur (user_id, provider, external_review_id)', async () => {
  const journal = []
  const sb = fauxClient({
    properties: { data: [{ id: 'uuid-1', user_id: 'u1', provider_property_id: 'prop-ref-1' }], error: null }
  }, journal)
  await pollChannelReviews(null, { supabase: sb, channelCall: pageAvis([AVIS_AIRBNB]), forcer: true })
  const ecriture = journal.find(a => a.table === 'ota_reviews' && a.op === 'upsert')
  assert.strictEqual(ecriture.opts.onConflict, 'user_id,provider,external_review_id')
  // L'ecriture se fait par lot : une requete par page, pas une par avis.
  assert.ok(Array.isArray(ecriture.row), 'les avis doivent partir en un seul upsert')
  assert.strictEqual(ecriture.row[0].user_id, 'u1')
  assert.strictEqual(ecriture.row[0].property_id, 'uuid-1')
  assert.strictEqual(ecriture.row[0].property_id_ref, 'prop-ref-1')
})

test('poll : la référence TEXT écrite est celle du bien en base, pas celle du payload', async () => {
  // property_id_ref porte le périmètre (can_read). La prendre dans le payload
  // laisserait le provider choisir sur quel périmètre l'avis atterrit.
  const journal = []
  const sb = fauxClient({
    properties: { data: [{ id: 'uuid-1', user_id: 'u1', provider_property_id: 'REF-EN-BASE' }], error: null }
  }, journal)
  await pollChannelReviews(null, { supabase: sb, channelCall: pageAvis([AVIS_AIRBNB]), forcer: true })
  const ecriture = journal.find(a => a.table === 'ota_reviews' && a.op === 'upsert')
  assert.strictEqual(ecriture.row[0].property_id_ref, 'REF-EN-BASE')
})

test('poll : un HTTP en échec n\'écrit aucun avis et se signale', async () => {
  const journal = []
  const sb = fauxClient({}, journal)
  const results = { errors: [] }
  const bilan = await pollChannelReviews(results, {
    supabase: sb, forcer: true,
    channelCall: async () => ({ ok: false, status: 401, json: {} })
  })
  assert.strictEqual(bilan.interrompu, 'http_401')
  assert.strictEqual(bilan.ecrits, 0)
  assert.strictEqual(results.errors.length, 1)
})

test('poll : le budget mur arrête le passage APRÈS avoir traité des avis', async () => {
  // L'ancienne version de ce test avançait l'horloge de 60 s à chaque appel :
  // la boucle sortait avant le premier appel HTTP (lus: 0), et le test passait
  // même en retirant la garde de budget interne à une page. Ici l'horloge ne
  // franchit l'échéance qu'une fois deux avis traités.
  let appels = 0
  const journal = []
  const sb = fauxClient({
    properties: { data: [{ id: 'uuid-1', user_id: 'u1', provider_property_id: 'prop-ref-1' }], error: null }
  }, journal)
  const results = { errors: [] }
  const bilan = await pollChannelReviews(results, {
    supabase: sb, forcer: true,
    // Appels : marqueur, échéance, tête de boucle, puis un par avis.
    // On laisse passer deux avis avant de franchir l'échéance.
    now: () => (appels++ < 5 ? 0 : 999999),
    channelCall: pageAvis([AVIS_AIRBNB, AVIS_AIRBNB, AVIS_AIRBNB])
  })
  assert.strictEqual(bilan.interrompu, 'budget')
  assert.ok(bilan.lus > 0, 'des avis doivent avoir été lus avant la coupure')
  assert.ok(bilan.lus < 3, 'la coupure doit intervenir avant la fin de la page')
  assert.strictEqual(results.errors.length, 1, 'une troncature ne doit jamais être silencieuse')
})

// ─── Index des codes OTA : la garde réellement utilisée en production ───────
test('chargerIndexCompte : la requête est filtrée par user_id (règle 1)', async () => {
  // C'est CE chemin que le poll exécute. Sans ce test, retirer le filtre
  // laissait les 522 tests au vert alors que la Map aurait été construite sur
  // tous les comptes, clé = code OTA seul — la collision de REVIEW.md règle 1.
  const journal = []
  const sb = fauxClient({
    bookings_snapshot: { data: [{ booking_id: 77, snapshot: { otaReservationCode: 'HM5W', arrival: '2026-08-01', departure: '2026-08-05' } }], error: null }
  }, journal)
  const index = await chargerIndexCompte(sb, 'u1')
  const appel = journal.find(a => a.table === 'bookings_snapshot')
  assert.ok(appel.filtres.some(([c, v]) => c === 'user_id' && v === 'u1'),
    'sans user_id, l\'index mélangerait les comptes')
  assert.strictEqual(index.get('HM5W').booking_uid, '77')
})

test('chargerIndexCompte : une panne SQL rend null, et non un index vide', async () => {
  // Un index vide se confondrait avec « aucune réservation » : tous les avis
  // passeraient non résolus sans que rien ne le signale.
  const sb = fauxClient({ bookings_snapshot: { data: null, error: { message: 'boom' } } })
  assert.strictEqual(await chargerIndexCompte(sb, 'u1'), null)
})

test('poll : le booking résolu dénormalise booking_uid ET les dates de séjour', async () => {
  // Le chemin de résolution réellement exécuté n'était couvert par aucun test :
  // bilan.resolus valait 0 partout, l'index étant systématiquement vide.
  const journal = []
  const sb = fauxClient({
    properties: { data: [{ id: 'uuid-1', user_id: 'u1', provider_property_id: 'prop-ref-1' }], error: null },
    bookings_snapshot: { data: [{ booking_id: 999, snapshot: { otaReservationCode: 'HM5WHSHYMQ', arrival: '2026-08-01', departure: '2026-08-05' } }], error: null }
  }, journal)
  const bilan = await pollChannelReviews(null, { supabase: sb, channelCall: pageAvis([AVIS_AIRBNB]), forcer: true })
  assert.strictEqual(bilan.resolus, 1)
  const ecriture = journal.find(a => a.table === 'ota_reviews' && a.op === 'upsert')
  const ligne = Array.isArray(ecriture.row) ? ecriture.row[0] : ecriture.row
  assert.strictEqual(ligne.booking_uid, '999')
  assert.strictEqual(ligne.stay_start, '2026-08-01')
  assert.strictEqual(ligne.stay_end, '2026-08-05')
})

test('poll : un avis NON résolu n\'écrase pas une résolution déjà en base', async () => {
  // Les colonnes doivent être ABSENTES de la ligne, pas à null : PostgREST ne
  // met dans le DO UPDATE SET que les colonnes présentes.
  const journal = []
  const sb = fauxClient({
    properties: { data: [{ id: 'uuid-1', user_id: 'u1', provider_property_id: 'prop-ref-1' }], error: null },
    bookings_snapshot: { data: [], error: null }
  }, journal)
  await pollChannelReviews(null, { supabase: sb, channelCall: pageAvis([AVIS_AIRBNB]), forcer: true })
  const ecriture = journal.find(a => a.table === 'ota_reviews' && a.op === 'upsert')
  const ligne = Array.isArray(ecriture.row) ? ecriture.row[0] : ecriture.row
  assert.ok(!('booking_uid' in ligne), 'booking_uid à null détruirait la résolution de la veille')
  assert.ok(!('stay_start' in ligne))
})

// ─── Index des codes OTA ────────────────────────────────────────────────────
const { indexerSnapshots } = require('../lib/cron-channel-reviews')

test('indexerSnapshots : associe le code OTA aux dates de séjour', () => {
  const i = indexerSnapshots([
    { booking_id: 77, snapshot: { otaReservationCode: 'HM5W', arrival: '2026-08-01', departure: '2026-08-05' } }
  ])
  assert.deepStrictEqual(i.get('HM5W'), { booking_uid: '77', stay_start: '2026-08-01', stay_end: '2026-08-05' })
})

test('indexerSnapshots : un code porté par deux réservations est RETIRÉ, pas arbitré', () => {
  // Prendre la première ligne venue rattacherait l'avis au mauvais séjour et
  // écrirait de fausses dates dans le cœur, que rien ne viendrait corriger.
  const i = indexerSnapshots([
    { booking_id: 1, snapshot: { otaReservationCode: 'DOUBLON', arrival: '2026-01-01' } },
    { booking_id: 2, snapshot: { otaReservationCode: 'DOUBLON', arrival: '2026-05-05' } }
  ])
  assert.strictEqual(i.has('DOUBLON'), false)
})

test('indexerSnapshots : les snapshots sans code OTA sont ignorés (27 sur 182 en base)', () => {
  const i = indexerSnapshots([{ booking_id: 3, snapshot: { arrival: '2026-02-02' } }, { booking_id: 4, snapshot: null }])
  assert.strictEqual(i.size, 0)
})

// ─── Réponse de l'hôte ──────────────────────────────────────────────────────
const { extraireReponse } = require('../lib/cron-channel-reviews')

test('extraireReponse : un objet VIDE n\'est pas une réponse', () => {
  // Cas réel : Channex renvoie `reply: {}` sur 68 des 70 avis. Écrit tel quel
  // dans une colonne text, cela donnait la chaîne "{}" — une réponse fantôme.
  assert.strictEqual(extraireReponse({}), null)
  assert.strictEqual(extraireReponse(null), null)
  assert.strictEqual(extraireReponse(''), null)
})

test('extraireReponse : un vrai texte de réponse est conservé', () => {
  assert.strictEqual(extraireReponse('Merci de votre séjour'), 'Merci de votre séjour')
  assert.strictEqual(extraireReponse({ message: 'Merci !' }), 'Merci !')
})

test('extraireReponse : un objet sans aucun texte ne produit pas de réponse', () => {
  assert.strictEqual(extraireReponse({ id: 42, created_at: '2026-01-01' }), null)
  assert.strictEqual(extraireReponse({ message: '   ' }), null)
})

test('versLigne : la réponse fantôme ne peut pas revenir', () => {
  const avis = JSON.parse(JSON.stringify(AVIS_AIRBNB))
  avis.attributes.reply = {}
  const l = versLigne(avis, { userId: 'u1', propertyId: 'p', propertyRef: 'r' })
  assert.strictEqual(l.reply, null)
  assert.notStrictEqual(l.reply, '{}')
})
