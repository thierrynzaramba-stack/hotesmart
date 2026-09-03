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
        // ⚠ `is`, `order` et `limit` sont ENREGISTRES, pas jetes. Une version
        // precedente de ce double les ignorait : supprimer la garde
        // `.is('ai_analyzed_at', null)` laissait la suite entierement au vert,
        // alors que sans elle toute la table serait reclassifiee chaque jour.
        is (c, v) { appel.is = [c, v]; return this },
        // ⚠ `neq` est honoré : sans lui, retirer l'exclusion des verdicts
        // humains de la file — donc laisser le modèle écraser une correction —
        // ne ferait échouer aucun test.
        neq (c, v) { appel.neq = appel.neq || {}; appel.neq[c] = v; return this },
        order (c, o) { appel.order = { colonne: c, ...o }; return this },
        limit (n) { appel.limit = n; return Promise.resolve({ data: file, error: null }) },
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

// ─── La forme de la requête de file : la garde centrale du design ───────────
test('file : seuls les avis NON analysés sont relus', async () => {
  // Sans cette garde, chaque passage reclassifierait toute la table : un appel
  // Haiku par avis et par jour, pour toujours.
  const journal = []
  await classerAvis(null, { supabase: fauxClient([AVIS_TAG], journal), forcer: true })
  const lecture = journal.find(a => a.table === 'ota_reviews' && a.op === 'select')
  assert.deepStrictEqual(lecture.is, ['ai_analyzed_at', null])
})

test('file : le lot est borné, et les avis sans date ne squattent pas la tête', async () => {
  // received_at est nullable et PostgreSQL trie DESC en NULLS FIRST : un avis
  // sans date resterait en tête à chaque passage. Combiné à un échec permanent,
  // il monopoliserait le premier slot indéfiniment.
  const journal = []
  await classerAvis(null, { supabase: fauxClient([AVIS_TAG], journal), forcer: true })
  const lecture = journal.find(a => a.table === 'ota_reviews' && a.op === 'select')
  assert.strictEqual(lecture.limit, 20, 'le lot doit rester borné')
  assert.strictEqual(lecture.order.colonne, 'received_at')
  assert.strictEqual(lecture.order.nullsFirst, false)
})

test('passage : le budget mur coupe et ne consomme pas tout le lot', async () => {
  // Aucun test n'exerçait le budget : le supprimer ne cassait rien. Ici
  // l'horloge franchit l'échéance après le premier avis.
  let t = 0
  const avis = [1, 2, 3].map(n => ({ ...AVIS_TAG, id: 'x' + n }))
  const journal = []
  const bilan = await classerAvis(null, {
    supabase: fauxClient(avis, journal), forcer: true,
    // marqueur, échéance, puis un appel par avis.
    now: () => (t++ < 3 ? 0 : 999999)
  })
  assert.strictEqual(bilan.interrompu, 'budget')
  assert.ok(bilan.lus < 3, 'la coupure doit intervenir avant la fin du lot')
})

test('passage : des avis non classés remontent dans les erreurs du cycle', async () => {
  // Un échec permanent (clé d'API expirée) serait sinon rejoué chaque jour sans
  // que personne ne le voie : le cycle afficherait un bilan sans erreur.
  const results = { errors: [] }
  await classerAvis(results, {
    supabase: fauxClient([AVIS_TEXTE]), forcer: true,
    anthropic: { messages: { create: async () => { throw new Error('401') } } }
  })
  assert.strictEqual(results.errors.length, 1)
  assert.match(results.errors[0].error, /non classes/)
})

// ─── La polarité des tags se lit, elle ne se devine pas ─────────────────────
test('règle : un tag POSITIF ne peut jamais produire une remarque', async () => {
  // « stainless » contient « stain », « smelling » contient « smell ». Deviner
  // la polarité depuis la racine transformait un tag élogieux en reproche de
  // propreté adressé au prestataire — sans extrait pour le vérifier.
  for (const t of ['guest_review_host_positive_stainless_steel_appliances',
                   'guest_review_host_positive_fresh_smelling_linens',
                   'guest_review_host_positive_moldings_beautiful']) {
    const r = classerParRegle({ ota: 'airbnb', tags: [t] })
    assert.notStrictEqual(r?.verdict, 'remarque', t)
  }
})

test('règle : un cleanliness_other NÉGATIF est une remarque, pas une ambiguïté', async () => {
  // Non reconnu, il partait à l'étage 2 ; sans texte à analyser, l'avis
  // finissait « rien_signale » alors que le voyageur avait explicitement coché
  // un problème de propreté. Irrécupérable sans remise à null manuelle.
  const r = classerParRegle({ ota: 'airbnb', tags: ['guest_review_host_negative_cleanliness_other'] })
  assert.strictEqual(r?.verdict, 'remarque')
})

test('texteVoyageur : le même texte n\'est pas envoyé deux fois au modèle', async () => {
  // content_public retombe sur content quand l'OTA ne fournit pas de champ
  // dédié : les deux portent alors la même phrase.
  const t = texteVoyageur({ content: 'Très propre', content_public: 'Très propre' })
  assert.strictEqual(t, 'Très propre')
})

test('le bilan porte le reste en file, seul signal d\'une boucle de réanalyse', async () => {
  // Si le trigger remettait des avis en file aussi vite qu'on les traite, le
  // bilan afficherait un travail normal. Ce compte, lui, ne descendrait pas :
  // la boucle se lit alors en comparant deux cycles.
  const journal = []
  const bilan = await classerAvis(null, { supabase: fauxClient([AVIS_TAG], journal), forcer: true })
  assert.ok('reste_en_file' in bilan, 'le bilan doit porter le reste en file')
  // Deux lectures de ota_reviews : la file de travail, puis le décompte.
  const lectures = journal.filter(a => a.table === 'ota_reviews' && a.op === 'select')
  assert.strictEqual(lectures.length, 2)
  assert.deepStrictEqual(lectures[1].is, ['ai_analyzed_at', null], 'le décompte porte sur la même file')
})

// ─── L'asymétrie du seuil porte sur le PROVIDER, pas sur l'OTA ──────────────
const { echelleFiable } = require('../lib/cron-reviews-classify')

test('seuil : appliqué à Beds24/Booking, dont l\'échelle est vérifiée cohérente', () => {
  // Mesuré sur 93 avis réels : review_score et catégories tous sur 10, et la
  // moyenne des catégories colle au score global (9 pour 9,2 ; 10 pour 10).
  assert.strictEqual(echelleFiable({ provider: 'beds24', ota: 'booking' }), true)
  const r = classerParRegle({ provider: 'beds24', ota: 'booking', tags: [], score_clean: 5 })
  assert.strictEqual(r?.verdict, 'remarque')
})

test('seuil : EXCLU pour Channex/Booking, dont l\'échelle ne coïncide pas', () => {
  // Mesuré : un overall_score de 1 avec toutes les catégories à 2.5, un overall
  // de 10 avec des catégories à 7.5. Le même avis Booking.com est cohérent
  // quand Beds24 le rend et incohérent quand Channex le rend : l'incohérence
  // vient du provider, pas de l'OTA — d'où une condition sur le provider.
  assert.strictEqual(echelleFiable({ provider: 'channex', ota: 'booking' }), false)
  assert.strictEqual(classerParRegle({ provider: 'channex', ota: 'booking', tags: [], score_clean: 2.5 }), null)
})

test('seuil : appliqué à Airbnb quel que soit le provider', () => {
  assert.strictEqual(echelleFiable({ provider: 'channex', ota: 'airbnb' }), true)
  assert.strictEqual(classerParRegle({ provider: 'channex', ota: 'airbnb', tags: [], score_clean: 6 })?.verdict, 'remarque')
})

test('seuil : une note absente ne déclenche rien, même échelle fiable', () => {
  // 4 avis Beds24 sur 93 ont clean à null. Le confondre avec 0 produirait une
  // remarque sur un avis qui n'en contient pas.
  assert.strictEqual(classerParRegle({ provider: 'beds24', ota: 'booking', tags: [], score_clean: null }), null)
  assert.strictEqual(classerParRegle({ provider: 'beds24', ota: 'booking', tags: [] }), null)
})

test('le prompt interdit de traduire l\'extrait', () => {
  // Des avis Beds24 sont en espagnol. Sans cette consigne, le modèle traduit
  // l'extrait et le contrôle de citation le rejette : verdict correct, citation
  // perdue — exactement le défaut qui coûtait 4 extraits sur 5.
  const p = construirePrompt('x')
  assert.match(p, /QUELLE QUE SOIT LA LANGUE/i)
  assert.match(p, /LANGUE D'ORIGINE/i)
  assert.match(p, /jamais traduit/i)
})

test('file : `provider` est lu, sinon le seuil de note ne s\'applique jamais', () => {
  // Défaut mesuré : `provider` manquait au select de la file, donc
  // echelleFiable() recevait undefined et trois avis Beds24 notés 2.5 et 5 en
  // propreté passaient pour « rien_signale ». Invisible en test unitaire —
  // seule la lecture du SQL réel l'attrape.
  const fs = require('node:fs'), pathm = require('node:path')
  const src = fs.readFileSync(pathm.join(__dirname, '..', 'lib/cron-reviews-classify.js'), 'utf8')
  const select = src.slice(src.indexOf(".select('id, user_id"), src.indexOf("')", src.indexOf(".select('id, user_id")))
  for (const col of ['provider', 'ota', 'tags', 'score_clean']) {
    assert.ok(select.includes(col), `la file doit lire ${col} : classerParRegle en dépend`)
  }
})

test('file : un verdict HUMAIN n\'est jamais repris par le modèle', () => {
  // Même logique que le DO NOTHING des détections : ce que le modèle dirait
  // d'une seconde lecture n'a aucune valeur face à une correction déjà faite.
  // Sans ce filtre, la correction de l'hôte aurait tenu jusqu'au prochain
  // changement de texte, puis aurait été silencieusement écrasée.
  const fs = require('node:fs'), pathm = require('node:path')
  const src = fs.readFileSync(pathm.join(__dirname, '..', 'lib/cron-reviews-classify.js'), 'utf8')
  assert.match(src, /\.neq\('verdict_source',\s*'humain'\)/,
    'la file doit exclure les verdicts humains')
})
