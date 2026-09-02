// tests/reviews-classify.test.js
// Classification de la propreté : règle déterministe d'abord, Haiku ensuite.
//
// L'enjeu de ces tests n'est pas « le modèle répond-il bien » — on ne teste pas
// un LLM. C'est : rien d'invérifiable n'entre en base. Un verdict hors des trois
// classes, un extrait que le voyageur n'a jamais écrit, un échec pris pour une
// réponse : chacun de ces cas finirait affiché à un prestataire.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'cle-test'

const test = require('node:test')
const assert = require('node:assert')

const {
  classerAvis, classerParRegle, texteVoyageur, lireReponse, construirePrompt
} = require('../lib/cron-reviews-classify')

// ─── Étage 1 : la règle ─────────────────────────────────────────────────────
test('règle : un tag de propreté positif tranche sans appel IA', () => {
  const r = classerParRegle({ ota: 'airbnb', tags: ['guest_review_host_positive_squeaky_clean_bathroom'] })
  assert.strictEqual(r.verdict, 'positif')
  assert.strictEqual(r.raison, 'tag_positif')
})

test('règle : les quatre tags de propreté réellement observés sont reconnus', () => {
  for (const t of ['guest_review_host_positive_squeaky_clean_bathroom',
                   'guest_review_host_positive_pristine_kitchen',
                   'guest_review_host_positive_spotless_furniture_and_linens',
                   'guest_review_host_positive_free_of_clutter']) {
    assert.strictEqual(classerParRegle({ ota: 'airbnb', tags: [t] })?.verdict, 'positif', t)
  }
})

test('règle : un tag négatif l\'emporte sur un tag positif', () => {
  // Un avis peut saluer la salle de bain et signaler une literie sale : c'est la
  // remarque qui intéresse le prestataire, pas le compliment.
  const r = classerParRegle({ ota: 'airbnb', tags: [
    'guest_review_host_positive_squeaky_clean_bathroom',
    'guest_review_host_negative_dirty_linens'
  ] })
  assert.strictEqual(r.verdict, 'remarque')
})

test('règle : cleanliness_other ne tranche RIEN et part à l\'étage 2', () => {
  // Ce tag dit « propreté » sans dire quoi : le prendre pour un compliment
  // classerait « positif » un avis qui se plaint.
  assert.strictEqual(classerParRegle({ ota: 'airbnb', tags: ['cleanliness_other'] }), null)
  // Même en présence d'un tag positif : l'ambiguïté doit gagner.
  assert.strictEqual(classerParRegle({ ota: 'airbnb', tags: [
    'cleanliness_other', 'guest_review_host_positive_pristine_kitchen'] }), null)
})

test('règle : un tag qui ne parle pas de propreté ne tranche pas', () => {
  assert.strictEqual(classerParRegle({ ota: 'airbnb', tags: ['guest_review_host_positive_peaceful'] }), null)
  assert.strictEqual(classerParRegle({ ota: 'airbnb', tags: ['guest_review_host_negative_noisy'] }), null)
})

// ─── L'asymétrie entre OTA, volontaire ──────────────────────────────────────
test('règle : le seuil de note s\'applique à Airbnb', () => {
  assert.strictEqual(classerParRegle({ ota: 'airbnb', tags: [], score_clean: 2.5 })?.verdict, 'remarque')
  assert.strictEqual(classerParRegle({ ota: 'airbnb', tags: [], score_clean: 6 })?.verdict, 'remarque')
  assert.strictEqual(classerParRegle({ ota: 'airbnb', tags: [], score_clean: 8 }), null)
})

test('règle : le seuil de note ne s\'applique PAS à Booking', () => {
  // Chez Booking les échelles ne coïncident pas : overall 1 avec catégories à
  // 2.5, overall 10 avec catégories à 7.5. Comme on stocke brut sans
  // normaliser, un seuil sur ces valeurs serait un pari. Le texte tranche.
  assert.strictEqual(classerParRegle({ ota: 'booking', tags: [], score_clean: 2.5 }), null)
  assert.strictEqual(classerParRegle({ ota: 'booking', tags: [], score_clean: 7.5 }), null)
})

test('règle : une note absente ne vaut pas une note basse', () => {
  assert.strictEqual(classerParRegle({ ota: 'airbnb', tags: [], score_clean: null }), null)
  assert.strictEqual(classerParRegle({ ota: 'airbnb', tags: [] }), null)
})

// ─── Le texte analysé ───────────────────────────────────────────────────────
test('texteVoyageur : la réponse de l\'hôte n\'est jamais analysée', () => {
  const t = texteVoyageur({ content_public: 'Très propre', reply: 'Merci beaucoup !' })
  assert.ok(t.includes('Très propre'))
  assert.ok(!t.includes('Merci beaucoup'), 'la réponse de l\'hôte fausserait le verdict')
})

test('texteVoyageur : le retour privé compte, il parle souvent des défauts', () => {
  const t = texteVoyageur({ content_public: 'Séjour agréable', content_private: 'La douche était sale' })
  assert.ok(t.includes('sale'))
})

// ─── La réponse du modèle : rien d'invérifiable n'entre en base ─────────────
const TEXTE = 'Logement impeccable, la salle de bain était nickel.'

test('lireReponse : un verdict hors des trois classes est rejeté', () => {
  // La colonne porte un CHECK : un verdict inventé ferait échouer l'update, et
  // l'avis reviendrait en boucle dans la file.
  assert.strictEqual(lireReponse('{"verdict":"tres_positif","extrait":null}', TEXTE), null)
  assert.strictEqual(lireReponse('{"verdict":"","extrait":null}', TEXTE), null)
})

test('lireReponse : un extrait que le voyageur n\'a pas écrit est refusé', () => {
  // Le pire cas : un modèle qui reformule. La phrase serait affichée au
  // prestataire comme une citation du voyageur.
  const r = lireReponse('{"verdict":"positif","extrait":"le logement etait tres bien tenu"}', TEXTE)
  assert.strictEqual(r.verdict, 'positif')
  assert.strictEqual(r.extrait, null, 'une reformulation ne doit pas passer pour une citation')
})

test('lireReponse : une citation exacte est conservée', () => {
  const r = lireReponse('{"verdict":"positif","extrait":"la salle de bain était nickel"}', TEXTE)
  assert.strictEqual(r.extrait, 'la salle de bain était nickel')
})

test('lireReponse : rien_signale ne peut pas porter d\'extrait', () => {
  const r = lireReponse('{"verdict":"rien_signale","extrait":"Logement impeccable"}', TEXTE)
  assert.strictEqual(r.extrait, null)
})

test('lireReponse : JSON invalide ou enrobé', () => {
  assert.strictEqual(lireReponse('je dirais que c\'est positif', TEXTE), null)
  assert.strictEqual(lireReponse('', TEXTE), null)
  assert.strictEqual(lireReponse(null, TEXTE), null)
  // Enrobage markdown : fréquent, et légitime.
  const r = lireReponse('```json\n{"verdict":"rien_signale","extrait":null}\n```', TEXTE)
  assert.strictEqual(r.verdict, 'rien_signale')
})

test('lireReponse : un extrait non textuel ne casse pas la lecture', () => {
  const r = lireReponse('{"verdict":"positif","extrait":{"x":1}}', TEXTE)
  assert.strictEqual(r.extrait, null)
})

test('le prompt pose rien_signale comme réponse par défaut', () => {
  // Sans cette consigne, un LLM trouve de la propreté partout : les 28 avis qui
  // n'en parlent pas deviendraient du bruit sur la fiche prestataire.
  const p = construirePrompt('x')
  assert.ok(p.includes('rien_signale'))
  assert.ok(/PLUS\s+FREQUENT/i.test(p), 'le défaut doit être explicite')
  assert.ok(p.includes('MOT POUR MOT'), 'la citation exacte doit être exigée')
})

// ─── Le passage ─────────────────────────────────────────────────────────────
function fauxClient (file = [], journal = []) {
  return {
    from (table) {
      const appel = { table, filtres: [], op: 'select' }
      journal.push(appel)
      const chain = {
        select () { return this },
        eq (c, v) { appel.filtres.push([c, v]); return this },
        is () { return this }, order () { return this },
        limit () { return Promise.resolve({ data: file, error: null }) },
        maybeSingle () { return Promise.resolve({ data: null, error: null }) },
        upsert () { appel.op = 'upsert'; return Promise.resolve({ error: null }) },
        update (row) { appel.op = 'update'; appel.row = row; return this },
        then (r) { return Promise.resolve({ data: file, error: null }).then(r) }
      }
      return chain
    }
  }
}

const AVIS_TAG = { id: 'a1', user_id: 'u1', ota: 'airbnb',
                   tags: ['guest_review_host_positive_pristine_kitchen'], content_public: 'Super' }
const AVIS_TEXTE = { id: 'a2', user_id: 'u1', ota: 'booking', tags: [],
                     content_public: 'Draps douteux à l\'arrivée' }

test('passage : un avis tranché par la règle ne consomme AUCUN appel IA', async () => {
  let appels = 0
  const journal = []
  const bilan = await classerAvis(null, {
    supabase: fauxClient([AVIS_TAG], journal), forcer: true,
    anthropic: { messages: { create: async () => { appels++; return {} } } }
  })
  assert.strictEqual(appels, 0, 'payer un LLM pour redire un tag Airbnb')
  assert.strictEqual(bilan.regle, 1)
  assert.strictEqual(bilan.positif, 1)
})

test('passage : un avis sans tag exploitable part à l\'IA', async () => {
  let vus = 0
  const bilan = await classerAvis(null, {
    supabase: fauxClient([AVIS_TEXTE]), forcer: true,
    anthropic: { messages: { create: async () => { vus++; return {
      content: [{ text: '{"verdict":"remarque","extrait":"Draps douteux"}' }] } } } }
  })
  assert.strictEqual(vus, 1)
  assert.strictEqual(bilan.ia, 1)
  assert.strictEqual(bilan.remarque, 1)
})

test('passage : l\'update est filtré par user_id (règle 1)', async () => {
  const journal = []
  await classerAvis(null, { supabase: fauxClient([AVIS_TAG], journal), forcer: true })
  const maj = journal.find(a => a.op === 'update')
  assert.ok(maj.filtres.some(([c, v]) => c === 'user_id' && v === 'u1'),
    'un update par id seul viole la règle 1 sur un traitement multi-comptes')
  assert.ok(maj.filtres.some(([c]) => c === 'id'))
})

test('passage : un échec IA ne pose PAS ai_analyzed_at', async () => {
  // Le poser sortirait l'avis de la file pour toujours : jamais classé, et
  // jamais réessayé.
  const journal = []
  const bilan = await classerAvis(null, {
    supabase: fauxClient([AVIS_TEXTE], journal), forcer: true,
    anthropic: { messages: { create: async () => { throw new Error('529 overloaded') } } }
  })
  assert.strictEqual(bilan.erreurs, 1)
  assert.ok(!journal.some(a => a.op === 'update'), 'aucune écriture sur échec')
})

test('passage : une réponse inexploitable du modèle ne pose pas ai_analyzed_at', async () => {
  const journal = []
  const bilan = await classerAvis(null, {
    supabase: fauxClient([AVIS_TEXTE], journal), forcer: true,
    anthropic: { messages: { create: async () => ({ content: [{ text: 'bonjour' }] }) } }
  })
  assert.strictEqual(bilan.erreurs, 1)
  assert.ok(!journal.some(a => a.op === 'update'))
})

test('passage : un avis sans tag ET sans texte est classé rien_signale, pas retenté', async () => {
  // Sinon il reviendrait dans la file à chaque passage, indéfiniment. Deux avis
  // sur 70 sont dans ce cas.
  const journal = []
  const bilan = await classerAvis(null, {
    supabase: fauxClient([{ id: 'a3', user_id: 'u1', ota: 'booking', tags: [] }], journal), forcer: true,
    anthropic: { messages: { create: async () => { throw new Error('ne doit pas être appelé') } } }
  })
  assert.strictEqual(bilan.sans_texte, 1)
  const maj = journal.find(a => a.op === 'update')
  assert.strictEqual(maj.row.ai_clean_verdict, 'rien_signale')
  assert.ok(maj.row.ai_analyzed_at, 'il doit sortir de la file')
})

test('passage : le marqueur de cadence est posé AVANT le travail', async () => {
  const journal = []
  await classerAvis(null, { supabase: fauxClient([AVIS_TAG], journal), forcer: true })
  const iMarqueur = journal.findIndex(a => a.table === 'cron_logs' && a.op === 'upsert')
  const iTravail = journal.findIndex(a => a.table === 'ota_reviews')
  assert.ok(iMarqueur >= 0 && iMarqueur < iTravail)
})

test('passage : la cadence quotidienne est respectée', async () => {
  const sb = fauxClient([])
  sb.from = ((orig) => (t) => {
    const c = orig(t)
    if (t === 'cron_logs') c.maybeSingle = async () => ({ data: { last_run: new Date().toISOString() }, error: null })
    return c
  })(sb.from)
  const r = await classerAvis(null, { supabase: sb })
  assert.strictEqual(r.skipped, 'cadence')
})
