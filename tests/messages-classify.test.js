// tests/messages-classify.test.js
// Détection des signalements de propreté dans les messages ENTRANTS.
//
// Le risque principal n'est pas de rater un signalement — le cron repassera.
// C'est d'en INVENTER un : une détection remonte à l'hôte, puis, une fois
// confirmée, à la prestataire. Ces tests portent donc sur ce qui ne doit
// jamais entrer en base.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'cle-test'

const test = require('node:test')
const assert = require('node:assert')

const { classerMessages, construirePrompt, lireReponse, versLigne, refDuMessage }
  = require('../lib/cron-messages-classify')

const TEXTE = 'Le ménage a pas été fait, il y a de la poussière et la cuvette est sale.'

// ─── Le prompt ──────────────────────────────────────────────────────────────
test('le prompt porte les quatre exclusions tirées des faux positifs réels', () => {
  // Chacune vient d'un message réel qu'un filtre naïf remontait à tort :
  // question sur les draps, politesse de départ, verre cassé, compliment.
  const p = construirePrompt('x')
  assert.match(p, /fournissez-vous draps/i, 'question sur l\'équipement')
  assert.match(p, /vide les poubelles/i, 'politesse de départ')
  assert.match(p, /objet casse|objet cassé/i, 'incident matériel')
  assert.match(p, /impeccable/i, 'compliment')
  assert.match(p, /PLUS FREQUENT/i, 'false doit être le défaut')
  assert.match(p, /MOT POUR MOT/, 'citation exacte exigée')
})

// ─── La réponse du modèle ───────────────────────────────────────────────────
test('lireReponse : un extrait que le voyageur n\'a pas écrit est refusé', () => {
  // Une reformulation serait montrée à l'hôte, puis à la prestataire, comme une
  // parole du voyageur.
  const r = lireReponse('{"signale":true,"extrait":"le logement etait sale","gravite":"gene"}', TEXTE)
  assert.strictEqual(r.signale, true)
  assert.strictEqual(r.extrait, null)
})

test('lireReponse : une citation exacte est conservée', () => {
  const r = lireReponse('{"signale":true,"extrait":"la cuvette est sale","gravite":"probleme"}', TEXTE)
  assert.strictEqual(r.extrait, 'la cuvette est sale')
  assert.strictEqual(r.gravite, 'probleme')
})

test('lireReponse : `signale` doit être un vrai booléen', () => {
  // "true" en chaîne, 1, ou l'absence du champ : rien ne doit passer pour une
  // détection.
  for (const brut of ['{"signale":"true"}', '{"signale":1}', '{"extrait":"x"}', '{}']) {
    assert.strictEqual(lireReponse(brut, TEXTE), null, brut)
  }
})

test('lireReponse : une gravité inventée est écartée sans invalider la détection', () => {
  const r = lireReponse('{"signale":true,"extrait":"la cuvette est sale","gravite":"catastrophe"}', TEXTE)
  assert.strictEqual(r.signale, true)
  assert.strictEqual(r.gravite, null)
})

test('lireReponse : JSON illisible ou enrobé', () => {
  assert.strictEqual(lireReponse('je pense que oui', TEXTE), null)
  assert.strictEqual(lireReponse(null, TEXTE), null)
  assert.strictEqual(lireReponse('```json\n{"signale":false}\n```', TEXTE).signale, false)
})

// ─── La ligne écrite ────────────────────────────────────────────────────────
const MSG = { id: 'aaaaaaaa-1111-4111-8111-111111111111', user_id: 'u1',
              body: TEXTE, sent_at: '2026-08-20T10:00:00Z', booking_id: '77', property_id: '209413' }
const BIEN = { id: 'uuid-bien', provider_property_id: '209413' }

test('versLigne : l\'identifiant vient de messages.id, pas de provider_msg_id', () => {
  // provider_msg_id n'est peuplé que sur 263 des 359 messages réels : l'utiliser
  // aurait produit des doublons ou des trous. messages.id est la clé primaire.
  const l = versLigne(MSG, BIEN, null, { signale: true, extrait: 'la cuvette est sale' })
  assert.strictEqual(l.external_review_id, 'msg:' + MSG.id)
  assert.strictEqual(l.source_message_id, MSG.id)
  assert.strictEqual(refDuMessage(MSG.id), 'msg:' + MSG.id)
})

test('versLigne : la détection naît en `detecte`, jamais confirmée d\'office', () => {
  const l = versLigne(MSG, BIEN, null, { signale: true, extrait: null })
  assert.strictEqual(l.statut, 'detecte')
  assert.strictEqual(l.source, 'message')
  assert.strictEqual(l.provider, 'manuel')
})

test('versLigne : la gravité va dans raw, pas dans une colonne', () => {
  const l = versLigne(MSG, BIEN, null, { signale: true, extrait: null, gravite: 'probleme' })
  assert.strictEqual(l.gravite, undefined, 'aucune colonne gravite')
  assert.strictEqual(l.raw.gravite, 'probleme')
  assert.strictEqual(l.raw.message_id, MSG.id)
})

test('versLigne : le séjour est dénormalisé quand il est connu', () => {
  const l = versLigne(MSG, BIEN, { booking_uid: '77', stay_start: '2026-08-18', stay_end: '2026-08-20' },
                      { signale: true, extrait: null })
  assert.strictEqual(l.booking_uid, '77')
  assert.strictEqual(l.stay_start, '2026-08-18')
})

test('versLigne : sans séjour, les colonnes d\'ancrage sont ABSENTES', () => {
  // Absentes et non à null : c'est ce qui protège une résolution obtenue plus
  // tard, la liste de colonnes d'un upsert étant déterminée par requête.
  const l = versLigne(MSG, BIEN, null, { signale: true, extrait: null })
  assert.ok(!('booking_uid' in l))
  assert.ok(!('stay_start' in l))
})

// ─── Le passage ─────────────────────────────────────────────────────────────
function fauxClient (messages = [], journal = [], biens = [BIEN], curseur = null) {
  return {
    from (table) {
      const appel = { table, filtres: [], op: 'select' }
      journal.push(appel)
      const chain = {
        select () { return chain },
        eq (c, v) { appel.filtres.push([c, v]); return chain },
        gt (c, v) { appel.gt = [c, v]; return chain },
        order () { return chain },
        limit () { return Promise.resolve(rep()) },
        maybeSingle () {
          if (table === 'cron_logs') {
            return Promise.resolve({ data: appel.filtres.some(([, v]) => v === 'messages_classify_cursor') && curseur ? { last_run: curseur } : null, error: null })
          }
          const r = rep(); return Promise.resolve({ data: (r.data || [])[0] || null, error: null })
        },
        upsert (row, o) { appel.op = 'upsert'; appel.row = row; appel.opts = o; return Promise.resolve({ error: null }) },
        update (row) { appel.op = 'update'; appel.row = row; return chain },
        then (r) { return Promise.resolve(rep()).then(r) }
      }
      function rep () {
        if (table === 'messages') return { data: messages, error: null }
        if (table === 'properties') return { data: biens, error: null }
        if (table === 'bookings_snapshot') return { data: [], error: null }
        return { data: [], error: null }
      }
      return chain
    }
  }
}

const IA = (reponse) => ({ messages: { create: async () => ({ content: [{ text: reponse }] }) } })

test('passage : seuls les messages ENTRANTS sont lus', async () => {
  // Analyser un message sortant produirait des détections sur nos propres mots.
  const journal = []
  await classerMessages(null, { supabase: fauxClient([], journal), forcer: true, anthropic: IA('{}') })
  const lecture = journal.find(a => a.table === 'messages')
  assert.ok(lecture.filtres.some(([c, v]) => c === 'direction' && v === 'inbound'))
})

test('passage : le curseur porte sur created_at, pas sur sent_at', async () => {
  // created_at est la date d'INSERTION, monotone par construction : un message
  // ancien importé tardivement sera vu. Un curseur sur sent_at l'aurait sauté
  // définitivement.
  const journal = []
  await classerMessages(null, { supabase: fauxClient([], journal), forcer: true, anthropic: IA('{}') })
  const lecture = journal.find(a => a.table === 'messages')
  assert.ok(lecture.gt && lecture.gt[0] === 'created_at', 'le curseur doit porter sur created_at')
})

test('passage : un message non signalant n\'écrit RIEN', async () => {
  const journal = []
  const bilan = await classerMessages(null, {
    supabase: fauxClient([{ ...MSG, created_at: '2026-08-20T10:00:00Z' }], journal),
    forcer: true, anthropic: IA('{"signale":false}')
  })
  assert.strictEqual(bilan.detectes, 0)
  assert.ok(!journal.some(a => a.table === 'ota_reviews' && a.op === 'upsert'))
})

test('passage : une détection écrit avec la contrainte d\'idempotence', async () => {
  const journal = []
  const bilan = await classerMessages(null, {
    supabase: fauxClient([{ ...MSG, created_at: '2026-08-20T10:00:00Z' }], journal),
    forcer: true, anthropic: IA('{"signale":true,"extrait":"la cuvette est sale","gravite":"gene"}')
  })
  assert.strictEqual(bilan.detectes, 1)
  assert.strictEqual(bilan.ecrits, 1)
  const ecr = journal.find(a => a.table === 'ota_reviews' && a.op === 'upsert')
  assert.strictEqual(ecr.opts.onConflict, 'user_id,provider,external_review_id')
  assert.strictEqual(ecr.row.statut, 'detecte')
})

test('passage : un bien introuvable n\'écrit pas la détection', async () => {
  const journal = []
  const bilan = await classerMessages(null, {
    supabase: fauxClient([{ ...MSG, created_at: '2026-08-20T10:00:00Z' }], journal, []),
    forcer: true, anthropic: IA('{"signale":true,"extrait":null}')
  })
  assert.strictEqual(bilan.sans_bien, 1)
  assert.ok(!journal.some(a => a.table === 'ota_reviews' && a.op === 'upsert'))
})

test('passage : une panne IA n\'avance PAS le curseur', async () => {
  // L'avancer sauterait définitivement des messages jamais analysés.
  const journal = []
  const bilan = await classerMessages(null, {
    supabase: fauxClient([{ ...MSG, created_at: '2026-08-20T10:00:00Z' }], journal),
    forcer: true,
    anthropic: { messages: { create: async () => { throw new Error('529') } } }
  })
  assert.strictEqual(bilan.erreurs, 1)
  const curseur = journal.find(a => a.table === 'cron_logs' && a.op === 'upsert' &&
                                    a.row && a.row.id === 'messages_classify_cursor')
  assert.strictEqual(curseur, undefined, 'le curseur ne doit pas avancer sur une panne')
})

test('passage : le marqueur de cadence est posé AVANT le travail', async () => {
  const journal = []
  await classerMessages(null, {
    supabase: fauxClient([{ ...MSG, created_at: '2026-08-20T10:00:00Z' }], journal),
    forcer: true, anthropic: IA('{"signale":false}')
  })
  const iMarq = journal.findIndex(a => a.table === 'cron_logs' && a.op === 'upsert')
  const iTrav = journal.findIndex(a => a.table === 'messages')
  assert.ok(iMarq >= 0 && iMarq < iTrav)
})

test('passage : la cadence horaire est respectée', async () => {
  const sb = fauxClient([])
  sb.from = ((orig) => (t) => {
    const c = orig(t)
    if (t === 'cron_logs') c.maybeSingle = async () => ({ data: { last_run: new Date().toISOString() }, error: null })
    return c
  })(sb.from)
  const r = await classerMessages(null, { supabase: sb })
  assert.strictEqual(r.skipped, 'cadence')
})
