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
const MSG = { id: 'aaaaaaaa-1111-4111-8111-111111111111', user_id: 'u1', direction: 'inbound',
              body: TEXTE, sent_at: '2026-08-20T10:00:00Z', created_at: '2026-08-20T10:00:00Z',
              booking_id: '77', property_id: '209413' }
const BIEN = { id: 'uuid-bien', user_id: 'u1', provider_property_id: '209413' }

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
// ⚠ Ce double HONORE ses filtres. Une premiere version renvoyait toujours la
// totalite des lignes : supprimer `.eq('user_id', msg.user_id)` du lookup des
// biens — le cloisonnement multi-comptes — ne faisait echouer AUCUN test.
// REVIEW.md §8 : un double de table porte toutes les cles de la vraie table.
function fauxClient (opts = {}) {
  const { messages = [], journal = [], biens = [BIEN], snapshots = [],
          curseur = null, echecsAvant = 0, erreurs = {} } = opts
  return {
    from (table) {
      const appel = { table, filtres: {}, listeFiltres: [], op: 'select' }
      journal.push(appel)
      const chain = {
        select () { return chain },
        eq (c, v) { appel.filtres[c] = v; appel.listeFiltres.push([c, v]); return chain },
        gt (c, v) { appel.gt = [c, v]; return chain },
        order () { return chain },
        limit () { return Promise.resolve(rep()) },
        maybeSingle () {
          if (table === 'cron_logs') {
            const estCurseur = appel.filtres.id === 'messages_classify_cursor'
            return Promise.resolve({
              data: estCurseur && curseur ? { last_run: curseur, total_messages: echecsAvant } : null,
              error: null
            })
          }
          const r = rep()
          return Promise.resolve({ data: (r.data || [])[0] || null, error: r.error })
        },
        upsert (row, o) { appel.op = 'upsert'; appel.row = row; appel.opts = o
                          return Promise.resolve({ error: erreurs[table] || null }) },
        update (row) { appel.op = 'update'; appel.row = row; return chain },
        then (r) { return Promise.resolve(rep()).then(r) }
      }
      function rep () {
        if (erreurs[table]) return { data: null, error: erreurs[table] }
        if (table === 'messages') {
          // `direction` et le curseur sont REELLEMENT appliques.
          return { data: messages.filter(m =>
            (appel.filtres.direction == null || m.direction === appel.filtres.direction) &&
            (!appel.gt || String(m[appel.gt[0]]) > String(appel.gt[1]))), error: null }
        }
        if (table === 'properties') {
          return { data: biens.filter(b =>
            (appel.filtres.user_id == null || b.user_id === appel.filtres.user_id) &&
            (appel.filtres.provider_property_id == null ||
             b.provider_property_id === appel.filtres.provider_property_id)), error: null }
        }
        if (table === 'bookings_snapshot') {
          return { data: snapshots.filter(s =>
            (appel.filtres.user_id == null || s.user_id === appel.filtres.user_id) &&
            (appel.filtres.booking_id == null ||
             String(s.booking_id) === String(appel.filtres.booking_id))), error: null }
        }
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
  await classerMessages(null, { supabase: fauxClient({ journal }), forcer: true, anthropic: IA('{}') })
  const lecture = journal.find(a => a.table === 'messages')
  assert.strictEqual(lecture.filtres.direction, 'inbound')
})

test('passage : le curseur porte sur created_at, pas sur sent_at', async () => {
  // created_at est la date d'INSERTION, monotone par construction : un message
  // ancien importé tardivement sera vu. Un curseur sur sent_at l'aurait sauté
  // définitivement.
  const journal = []
  await classerMessages(null, { supabase: fauxClient({ journal }), forcer: true, anthropic: IA('{}') })
  const lecture = journal.find(a => a.table === 'messages')
  assert.ok(lecture.gt && lecture.gt[0] === 'created_at', 'le curseur doit porter sur created_at')
})

test('passage : un message non signalant n\'écrit RIEN', async () => {
  const journal = []
  const bilan = await classerMessages(null, {
    supabase: fauxClient({ messages: [MSG], journal }),
    forcer: true, anthropic: IA('{"signale":false}')
  })
  assert.strictEqual(bilan.detectes, 0)
  assert.ok(!journal.some(a => a.table === 'ota_reviews' && a.op === 'upsert'))
})

test('passage : une détection écrit avec la contrainte d\'idempotence', async () => {
  const journal = []
  const bilan = await classerMessages(null, {
    supabase: fauxClient({ messages: [MSG], journal }),
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
    supabase: fauxClient({ messages: [MSG], journal, biens: [] }),
    forcer: true, anthropic: IA('{"signale":true,"extrait":null}')
  })
  assert.strictEqual(bilan.sans_bien, 1)
  assert.ok(!journal.some(a => a.table === 'ota_reviews' && a.op === 'upsert'))
})

test('passage : une panne IA n\'avance PAS le curseur', async () => {
  // L'avancer sauterait définitivement des messages jamais analysés.
  const journal = []
  const bilan = await classerMessages(null, {
    supabase: fauxClient({ messages: [MSG], journal }),
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
    supabase: fauxClient({ messages: [MSG], journal }),
    forcer: true, anthropic: IA('{"signale":false}')
  })
  const iMarq = journal.findIndex(a => a.table === 'cron_logs' && a.op === 'upsert')
  const iTrav = journal.findIndex(a => a.table === 'messages')
  assert.ok(iMarq >= 0 && iMarq < iTrav)
})

test('passage : la cadence horaire est respectée', async () => {
  const sb = fauxClient({})
  sb.from = ((orig) => (t) => {
    const c = orig(t)
    if (t === 'cron_logs') c.maybeSingle = async () => ({ data: { last_run: new Date().toISOString() }, error: null })
    return c
  })(sb.from)
  const r = await classerMessages(null, { supabase: sb })
  assert.strictEqual(r.skipped, 'cadence')
})

// ─── Le cloisonnement, réellement exercé ────────────────────────────────────
test('passage : le bien est cherché sur le compte DU MESSAGE', async () => {
  // Le select sur `messages` est global (service key) : c'est le lookup du bien
  // qui porte le cloisonnement. Sans son filtre user_id, une détection serait
  // rattachée au bien d'un autre compte portant la même référence provider —
  // rien n'interdit ce doublon en base.
  const journal = []
  const BIEN_TIERS = { id: 'uuid-tiers', user_id: 'u2', provider_property_id: '209413' }
  await classerMessages(null, {
    supabase: fauxClient({ messages: [MSG], journal, biens: [BIEN_TIERS, BIEN] }),
    forcer: true, anthropic: IA('{"signale":true,"extrait":"la cuvette est sale"}')
  })
  const ecr = journal.find(a => a.table === 'ota_reviews' && a.op === 'upsert')
  assert.ok(ecr, 'la détection doit être écrite')
  assert.strictEqual(ecr.row.property_id, BIEN.id, 'le bien du compte du message, pas celui du tiers')
  assert.strictEqual(ecr.row.user_id, 'u1')
})

test('passage : un message SORTANT n\'est jamais analysé', async () => {
  // Le double applique désormais vraiment le filtre : retirer `.eq('direction')`
  // du code ferait analyser nos propres réponses.
  let appels = 0
  const journal = []
  await classerMessages(null, {
    supabase: fauxClient({ messages: [{ ...MSG, direction: 'outbound' }], journal }),
    forcer: true,
    anthropic: { messages: { create: async () => { appels++; return { content: [{ text: '{"signale":false}' }] } } } }
  })
  assert.strictEqual(appels, 0)
})

// ─── L'écriture n'écrase pas la décision de l'hôte ──────────────────────────
test('passage : l\'écriture est en DO NOTHING, pas DO UPDATE', async () => {
  // versLigne pose toujours statut 'detecte'. Avec un upsert classique,
  // retraiter un message — ce qui arrive dès qu'un échec survient en milieu de
  // lot — repassait une détection confirmée en attente, et faisait réapparaître
  // une détection ignorée que l'hôte ne pouvait plus écarter.
  const journal = []
  await classerMessages(null, {
    supabase: fauxClient({ messages: [MSG], journal }),
    forcer: true, anthropic: IA('{"signale":true,"extrait":null}')
  })
  const ecr = journal.find(a => a.table === 'ota_reviews' && a.op === 'upsert')
  assert.strictEqual(ecr.opts.ignoreDuplicates, true,
    'une décision humaine déjà prise ne doit pas être écrasée par une relecture')
})

// ─── Ni gel, ni perte ───────────────────────────────────────────────────────
test('échec répété : le message finit par être sauté au lieu de geler la file', async () => {
  // Sans borne, un message que le modèle ne sait pas traiter — citation trop
  // longue tronquée par max_tokens, donc JSON invalide — rejouait le même lot
  // toutes les heures, et AUCUN message postérieur n'était jamais analysé.
  const journal = []
  const results = { errors: [] }
  const bilan = await classerMessages(results, {
    supabase: fauxClient({ messages: [MSG], journal, curseur: '2026-01-01T00:00:00Z', echecsAvant: 2 }),
    forcer: true, anthropic: IA('reponse illisible')
  })
  assert.strictEqual(bilan.ignores, 1)
  const cur = journal.filter(a => a.table === 'cron_logs' && a.op === 'upsert')
    .find(a => a.row.id === 'messages_classify_cursor')
  assert.strictEqual(cur.row.last_run, MSG.created_at, 'le curseur doit dépasser le message fautif')
  assert.strictEqual(cur.row.total_messages, 0, 'le compteur repart à zéro')
  assert.ok(results.errors.some(e => /ignore apres/.test(e.error)), 'et ça doit se voir')
})

test('premier échec : le curseur ne dépasse pas, mais le compteur monte', async () => {
  const journal = []
  await classerMessages(null, {
    supabase: fauxClient({ messages: [MSG], journal, curseur: '2026-01-01T00:00:00Z', echecsAvant: 0 }),
    forcer: true, anthropic: IA('illisible')
  })
  const cur = journal.filter(a => a.table === 'cron_logs' && a.op === 'upsert')
    .find(a => a.row.id === 'messages_classify_cursor')
  assert.strictEqual(cur, undefined, 'aucun message traité : le curseur ne bouge pas')
})

test('échec après un succès : le travail déjà fait n\'est pas jeté', async () => {
  // dernierTraite conservait `null` sur échec, donc le lot entier était rejoué —
  // c'est ce qui rouvrait la porte au retraitement.
  const M1 = { ...MSG, id: 'bbbbbbbb-1111-4111-8111-111111111111', created_at: '2026-08-20T09:00:00Z' }
  const M2 = { ...MSG, id: 'cccccccc-1111-4111-8111-111111111111', created_at: '2026-08-20T10:00:00Z' }
  let n = 0
  const journal = []
  await classerMessages(null, {
    supabase: fauxClient({ messages: [M1, M2], journal, curseur: '2026-01-01T00:00:00Z' }),
    forcer: true,
    anthropic: { messages: { create: async () => {
      n++
      return { content: [{ text: n === 1 ? '{"signale":false}' : 'illisible' }] }
    } } }
  })
  const cur = journal.filter(a => a.table === 'cron_logs' && a.op === 'upsert')
    .find(a => a.row.id === 'messages_classify_cursor')
  assert.strictEqual(cur.row.last_run, M1.created_at, 'le curseur va au dernier SUCCÈS')
  assert.strictEqual(cur.row.total_messages, 1, 'et le compteur d\'échecs monte')
})

test('panne DB sur le bien : ni détection perdue, ni curseur avancé', async () => {
  // Ignorer `error` faisait passer un 503 transitoire pour « bien inconnu » : la
  // détection était perdue définitivement.
  const journal = []
  const bilan = await classerMessages(null, {
    supabase: fauxClient({ messages: [MSG], journal, curseur: '2026-01-01T00:00:00Z',
                           erreurs: { properties: { message: 'timeout' } } }),
    forcer: true, anthropic: IA('{"signale":true,"extrait":null}')
  })
  assert.strictEqual(bilan.sans_bien, 0, 'une panne n\'est pas une absence')
  assert.strictEqual(bilan.erreurs, 1)
  const cur = journal.filter(a => a.table === 'cron_logs' && a.op === 'upsert')
    .find(a => a.row.id === 'messages_classify_cursor')
  assert.strictEqual(cur, undefined, 'le curseur ne doit pas dépasser')
})

test('un message sans bien rattachable se voit dans les erreurs du cycle', async () => {
  const results = { errors: [] }
  await classerMessages(results, {
    supabase: fauxClient({ messages: [MSG], biens: [] }),
    forcer: true, anthropic: IA('{"signale":true,"extrait":null}')
  })
  assert.ok(results.errors.some(e => /sans bien/.test(e.error)),
    'un compte dont les property_id ne résolvent jamais perdrait tout en silence')
})
