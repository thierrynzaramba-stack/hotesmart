// tests/reponse-prete-api.test.js — `POST /api/guestflow-rediger`, action
// `base` (étape 2, spec docs/specs/spec-info-manquante-choix.md §2 C et §3).
//
// ⚠ CE QUE CES TESTS GARDENT, PAR ORDRE DE COÛT D'UNE ERREUR :
//  1. RÉSERVÉ AU TITULAIRE, ET LE REFUS VIENT AVANT TOUTE LECTURE DE LA BASE :
//     la base est non délégable (dette 68) et la proposition en montre le
//     texte. Un masquage de la carte ne suffit jamais.
//  2. RIEN N'EST ÉCRIT : une proposition s'enregistre par le geste de l'hôte,
//     au writer unique de la base. Le double compte les écritures.
//  3. Le modèle ne reçoit ni la conversation, ni une réponse « Hors IA », ni la
//     base d'un autre logement.
//  4. Le plafond est celui de l'hôte (dix appels par conversation en 24 h).

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

const TITULAIRE = '85e3a0ef-75bd-4c11-a3b7-e2811067dc36'
const MEMBRE = '11111111-2222-4333-8444-555555555555'
const REF = '209413'
const BIEN = { id: 'aa11bb22-cc33-4dd4-8ee5-ff6677889900', user_id: TITULAIRE, name: 'La bulle', provider: 'channex', provider_property_id: REF }
const TACHE = {
  id: 'ti1', user_id: TITULAIRE, book_id: 'B1', property_id: REF, task_type: 'info_unknown', status: 'done', summary: 'Chien et moto',
  sub_tasks: [{ question: 'Puis-je venir avec un chien ?', suggested_reply: 'NOTE INTERNE' }, { question: 'Puis-je garer ma moto dans l’appartement ?' }]
}
const BASE = [
  { id: 1, user_id: TITULAIRE, property_id: REF, type: 'faq', key: 'Animaux', value: 'Les animaux ne sont pas acceptés.', lisible_par_ia: true },
  { id: 2, user_id: TITULAIRE, property_id: REF, type: 'faq', key: 'Code wifi', value: 'MOTDEPASSE-SECRET', lisible_par_ia: false },
  { id: 3, user_id: TITULAIRE, property_id: REF, type: 'fixed', key: 'wifi_nom', value: 'FAIT-PAS-UNE-REPONSE' },
  { id: 4, user_id: TITULAIRE, property_id: 'AUTRE', type: 'faq', key: 'Piscine', value: 'AUTRE-BIEN' }
]
const ENVOYE = 'Hello Anna! Yes, your dog is welcome. No motorbike inside, but there is a garage 200 m away.'
const MODULES = ['../api/guestflow-rediger', '../lib/require-permission', '../lib/cron-shared', '../lib/cron-classify', '../lib/balises', '../lib/guestflow/rediger', '../lib/guestflow/reponse-prete']

function doubler (chemin, exports) {
  const abs = require.resolve(chemin)
  const m = new Module(abs); m.exports = exports; m.loaded = true
  require.cache[abs] = m
}

function preparer ({
  appelant = TITULAIRE, pause = false, taches = [TACHE], base = BASE, appels = 0, sansColonne = false,
  booking = { property_id: REF, snapshot: { firstName: 'Anna', lastName: 'Lefèvre' } },
  ia = async () => ({ content: [{ type: 'text', text: JSON.stringify({ propositions: [
    { question: 1, action: 'modifier', ref: 1, texte: 'Les chiens sont acceptés ; les autres animaux, non.' },
    { question: 2, action: 'creer', sujet: 'Moto', texte: 'Pas de moto dans le logement ; un garage est à 200 m.' }
  ] }) }] })
} = {}) {
  const etat = { lectures: [], ecritures: [], prompts: [], contextes: [] }
  const client = {
    from (nom) {
      const q = { table: nom, eq: {}, gt: {}, limite: null, colonnes: null }
      const ecrire = (op) => () => { etat.ecritures.push({ table: nom, op }); return chain }
      const executer = () => {
        etat.lectures.push(q)
        if (nom === 'knowledge' && sansColonne && /lisible_par_ia/.test(q.colonnes)) {
          return { data: null, error: { code: '42703', message: 'column knowledge.lisible_par_ia does not exist' } }
        }
        let rows = nom === 'properties' ? [BIEN]
          : nom === 'agent_tasks' ? taches
          : nom === 'knowledge' ? base.map(r => sansColonne ? (({ lisible_par_ia, ...x }) => x)(r) : r)
          : nom === 'ia_appels' ? Array.from({ length: appels }, (_, i) => ({ id: 'a' + i, fonction: 'guestflow_rediger', user_id: TITULAIRE, booking_id: 'B1' }))
          : []
        rows = rows.filter(r => Object.entries(q.eq).every(([k, v]) => String(r[k]) === String(v)))
        rows = rows.filter(r => Object.entries(q.gt).every(([k, v]) => r[k] > v))
        if (nom === 'knowledge') rows = rows.slice().sort((a, b) => a.id - b.id)
        if (q.limite != null) rows = rows.slice(0, q.limite)
        return { data: rows, error: null }
      }
      const chain = {
        select (c) { q.colonnes = c; return chain },
        eq (k, v) { q.eq[k] = v; return chain },
        gt (k, v) { q.gt[k] = v; return chain },
        gte () { return chain },
        order () { return chain },
        limit (n) { q.limite = n; return chain },
        insert: ecrire('insert'), update: ecrire('update'), upsert: ecrire('upsert'), delete: ecrire('delete'),
        maybeSingle: async () => { const r = executer(); return { data: (r.data || [])[0] || null, error: r.error } },
        then (ok, ko) { return Promise.resolve(executer()).then(ok, ko) }
      }
      return chain
    }
  }
  doubler(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'), { createClient: () => client })
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
  doubler('../lib/require-permission', {
    requirePermission: async (req, res, opts) => {
      etat.garde = opts
      return { ok: true, userId: appelant, accountUserId: TITULAIRE, booking, contexte: { userId: appelant, accountUserId: TITULAIRE } }
    }
  })
  const { contexteIA } = require('../lib/ia/journal')
  doubler('../lib/cron-shared', {
    isAutomationPaused: async () => pause,
    anthropic: { messages: { create: async (demande) => {
      etat.prompts.push(demande.messages[0].content)
      etat.contextes.push({ ...contexteIA() })
      return ia(demande)
    } } }
  })
  doubler('../lib/cron-classify', {
    loadPromptingInstructions: async () => ({ global: '', propertyOverride: '' }),
    modeleConfigure: () => 'claude-haiku',
    requeteClassification: (prompt, modele) => ({ model: modele, max_tokens: 1000, messages: [{ role: 'user', content: prompt }] })
  })
  return etat
}

function reponse () {
  const r = { code: null, body: null, entetes: {} }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = (k, v) => { r.entetes[k.toLowerCase()] = v }
  return r
}
async function appeler (x = {}) {
  const res = reponse()
  await require('../api/guestflow-rediger')({ method: 'POST', body: { action: 'base', bookingId: 'B1', tacheId: 'ti1', envoye: ENVOYE, ...x }, query: {}, headers: {} }, res)
  return res
}
const lu = (etat, table) => etat.lectures.filter(q => q.table === table)

test('LE TEST QUI COMPTE : le titulaire reçoit les propositions vérifiées, et RIEN n est écrit', async () => {
  const etat = preparer()
  const res = await appeler()
  assert.equal(res.code, 200)
  assert.deepEqual(res.body, { ok: true, propositions: [
    { action: 'modifier', id: 1, sujet: 'Animaux', avant: 'Les animaux ne sont pas acceptés.', texte: 'Les chiens sont acceptés ; les autres animaux, non.' },
    { action: 'creer', sujet: 'Moto', texte: 'Pas de moto dans le logement ; un garage est à 200 m.' }
  ] })
  assert.deepEqual(etat.ecritures, [], 'aucune écriture : seul le geste de l hôte écrit, au writer de la base')
  assert.equal(res.entetes['cache-control'], 'private, no-store')
  assert.match(res.entetes['server-timing'], /requêtes/)
  // La garde : écrire les messages, sur la réservation désignée.
  assert.equal(etat.garde.domaine, 'messages')
  assert.equal(etat.garde.niveau, 'write')
  assert.equal(etat.garde.bookingRequis, true)
  // L'appel est tracé sous l'étiquette de l'hôte, jamais celle de l'agent.
  assert.equal(etat.contextes[0].fonction, 'guestflow_rediger')
})

test('LE TEST QUI COMPTE : un MEMBRE délégué est refusé en 403 AVANT toute lecture de la base ou de la tâche, et sans appel au modèle', async () => {
  const etat = preparer({ appelant: MEMBRE })
  const res = await appeler()
  assert.equal(res.code, 403)
  assert.equal(res.body.error, 'reserve_titulaire')
  assert.equal(lu(etat, 'knowledge').length, 0, 'la base a été lue avant le refus')
  assert.equal(lu(etat, 'agent_tasks').length, 0)
  assert.equal(etat.prompts.length, 0)
  assert.equal(res.entetes['cache-control'], 'private, no-store')
})

test('LE TEST QUI COMPTE : le modèle ne reçoit ni la conversation, ni une réponse Hors IA, ni un fait, ni la base d un autre logement, ni le nom du voyageur', async () => {
  const etat = preparer()
  await appeler()
  assert.equal(lu(etat, 'messages').length, 0, 'la conversation n est pas lue')
  const p = etat.prompts[0]
  assert.match(p, /Puis-je venir avec un chien \?/)
  assert.match(p, /Yes, your dog is welcome/)
  assert.match(p, /\[1\] Sujet : Animaux/)
  for (const interdit of [/MOTDEPASSE-SECRET/, /Code wifi/, /FAIT-PAS-UNE-REPONSE/, /AUTRE-BIEN/, /NOTE INTERNE/, /Lefèvre/, /Anna/]) {
    assert.doesNotMatch(p, interdit)
  }
  // Le prénom du texte envoyé (« Hello Anna! ») est remplacé, pas supprimé :
  // la phrase reste lisible (review 1, constat 1).
  assert.match(p, /Hello \[voyageur\]! Yes, your dog is welcome/)
  // La base est lue PAR CURSEUR, filtrée sur le compte, le logement et les réponses prêtes.
  const q = lu(etat, 'knowledge')[0]
  assert.deepEqual(q.eq, { user_id: TITULAIRE, property_id: REF, type: 'faq' })
})

test('une création sous le sujet d une réponse Hors IA est écartée ; une proposition qui nomme le voyageur aussi', async () => {
  preparer({ ia: async () => ({ content: [{ type: 'text', text: JSON.stringify({ propositions: [
    { action: 'creer', sujet: 'code wifi', texte: 'X' },
    { action: 'creer', sujet: 'Chien', texte: 'Le chien d Anna est le bienvenu.' },
    { action: 'creer', sujet: 'Moto', texte: 'Pas de moto.' }
  ] }) }] }) })
  const res = await appeler()
  assert.deepEqual(res.body.propositions.map(p => p.sujet), ['Moto'])
})

test('review 1, constat 3 : une réponse prête trop longue n est pas montrée (on ne peut pas la rendre entière) ; son sujet est réservé', async () => {
  const longue = { id: 5, user_id: TITULAIRE, property_id: REF, type: 'faq', key: 'Règlement', value: 'x'.repeat(1499) + ' caution de 100 euros', lisible_par_ia: true }
  const etat = preparer({ base: [...BASE, longue], ia: async () => ({ content: [{ type: 'text', text: JSON.stringify({ propositions: [
    { action: 'creer', sujet: 'règlement', texte: 'Le règlement tronqué.' },
    { action: 'modifier', ref: 2, texte: 'Hors de la liste.' }
  ] }) }] }) })
  const res = await appeler()
  assert.doesNotMatch(etat.prompts[0], /Sujet : Règlement/)
  assert.doesNotMatch(etat.prompts[0], /\[2\] Sujet/, 'seule la réponse courte est numérotée')
  assert.deepEqual(res.body.propositions, [])
})

test('review 1, constat 4 : la sortie a la place de rendre plusieurs textes complets ; une sortie coupée est un 502, pas un JSON tronqué lu', async () => {
  let demande
  // Un JSON qui se lit EN ENTIER, mais une sortie coupée : la dernière
  // proposition pourrait manquer, ou un texte « complet » être tronqué.
  preparer({ ia: async (d) => { demande = d; return { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"propositions":[{"action":"creer","sujet":"Moto","texte":"Pas de moto."}]}' }] } } })
  const res = await appeler()
  assert.ok(demande.max_tokens >= 4000, `max_tokens = ${demande.max_tokens}`)
  assert.equal(res.code, 502)
})

test('review 1, constat 11 : un membre sur un logement EN PAUSE reçoit 403, pas « en pause » — et rien n est lu', async () => {
  const etat = preparer({ appelant: MEMBRE, pause: true })
  const res = await appeler()
  assert.equal(res.code, 403)
  assert.equal(lu(etat, 'properties').length, 0)
})

test('review 1, constat 7 : une base de 150 réponses (plus d une page) se lit en entier, par curseur', async () => {
  const base = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, user_id: TITULAIRE, property_id: REF, type: 'faq', key: 'S' + i, value: 'v' + i, lisible_par_ia: true }))
  const etat = preparer({ base, ia: async () => ({ content: [{ type: 'text', text: '{"propositions":[]}' }] }) })
  const res = await appeler()
  assert.equal(res.code, 200)
  assert.equal(res.body.motif, undefined)
  assert.match(etat.prompts[0], /\[150\] Sujet : S149/)
  assert.equal(lu(etat, 'knowledge').length, 2, 'deux pages de 100')
})

test('review 1, constat 8 : une tâche d un AUTRE logement que la réservation, 404', async () => {
  preparer({ taches: [{ ...TACHE, property_id: '169567' }] })
  assert.equal((await appeler()).code, 404)
})

test('la migration de la base V5 absente : la lecture se fait sans la colonne, tout est lisible', async () => {
  const etat = preparer({ sansColonne: true })
  const res = await appeler()
  assert.equal(res.code, 200)
  assert.match(etat.prompts[0], /Sujet : Code wifi/, 'sans la colonne, rien n est Hors IA (valeur par défaut)')
})

test('une base trop grande pour être rapprochée en entier : aucune proposition, et pas d appel au modèle', async () => {
  const grande = Array.from({ length: 301 }, (_, i) => ({ id: i + 1, user_id: TITULAIRE, property_id: REF, type: 'faq', key: 'S' + i, value: 'v', lisible_par_ia: true }))
  const etat = preparer({ base: grande })
  const res = await appeler()
  assert.equal(res.code, 200)
  assert.deepEqual(res.body, { ok: true, propositions: [], motif: 'base_trop_grande' })
  assert.equal(etat.prompts.length, 0)
  assert.ok(lu(etat, 'knowledge').length >= 4, 'la lecture est paginée par curseur')
})

test('la tâche : close par l envoi, acceptée ; d un autre séjour, 404 ; une intervention, 409 sans_question', async () => {
  preparer({ taches: [{ ...TACHE, status: 'pending' }] })
  assert.equal((await appeler()).code, 200)
  preparer({ taches: [{ ...TACHE, book_id: 'B2' }] })
  assert.equal((await appeler()).code, 404)
  preparer({ taches: [{ ...TACHE, task_type: 'intervention' }] })
  const r = await appeler()
  assert.equal(r.code, 409)
  assert.equal(r.body.error, 'sans_question')
})

test('les entrées : texte envoyé vide ou tâche absente, 400 ; pause du bien, 409 ; plafond de l hôte, 429 sans appel', async () => {
  preparer()
  assert.equal((await appeler({ envoye: '  ' })).code, 400)
  preparer()
  assert.equal((await appeler({ tacheId: '' })).code, 400)
  let etat = preparer({ pause: true })
  assert.equal((await appeler()).code, 409)
  assert.equal(lu(etat, 'knowledge').length, 0)
  etat = preparer({ appels: 10 })
  const r = await appeler()
  assert.equal(r.code, 429)
  assert.equal(r.body.error, 'garde_ia')
  assert.equal(etat.prompts.length, 0)
})

test('le modèle répond sans JSON lisible, ou lève : 502, rien n est proposé', async () => {
  preparer({ ia: async () => ({ content: [{ type: 'text', text: 'Je ne sais pas.' }] }) })
  assert.equal((await appeler()).code, 502)
  preparer({ ia: async () => { throw new Error('panne') } })
  assert.equal((await appeler()).code, 502)
})
