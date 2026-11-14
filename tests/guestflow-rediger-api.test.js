// tests/guestflow-rediger-api.test.js — `POST /api/guestflow-rediger`
// (spec docs/specs/spec-info-manquante-choix.md §3, étape 1).
//
// ⚠ CE QUE CES TESTS GARDENT, PAR ORDRE DE COÛT D'UNE ERREUR :
//  1. RIEN NE PART, RIEN N'EST ÉCRIT : le texte rédigé va dans la saisie de
//     l'hôte. Aucune écriture, sur aucune table — le double les compte.
//  2. LE PLAFOND DE L'HÔTE N'EST PAS CELUI DE L'AGENT (décision de Thierry du
//     10 novembre 2026) : jamais une ligne dans `guestflow_appels_ia`, sinon
//     trois clics arrêteraient l'agent sur le fil.
//  3. Les gardes de « Proposer une réponse » : droit d'écrire les messages,
//     réservation requise, clé sur la référence provider, kill switch.
//  4. Des choix pris sur d'anciennes questions ne partent jamais au modèle.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

const PROD = '85e3a0ef-75bd-4c11-a3b7-e2811067dc36'
const REF = '209413'
const BIEN = { id: 'aa11bb22-cc33-4dd4-8ee5-ff6677889900', user_id: PROD, name: 'La bulle', provider: 'channex', provider_property_id: REF }
const QUESTIONS = ['Puis-je venir avec un chien ?', 'Puis-je garer ma moto dans l’appartement ?']
const TACHE = {
  id: 'ti1', user_id: PROD, book_id: 'B1', property_id: REF, task_type: 'info_unknown', status: 'pending', summary: 'Chien et moto',
  sub_tasks: [{ question: QUESTIONS[0], suggested_reply: 'NOTE INTERNE' }, { question: QUESTIONS[1] }]
}
const MESSAGES = [
  { user_id: PROD, booking_id: 'B1', direction: 'inbound', kind: 'message', body: 'Can I come with my dog and park my motorbike inside?', sent_at: new Date(Date.now() - 600000).toISOString() },
  { user_id: PROD, booking_id: 'B1', direction: 'outbound', kind: 'auto', body: 'Bienvenue !', sent_at: new Date(Date.now() - 3600000).toISOString() }
]
const CHOIX = [{ question: QUESTIONS[0], reponse: 'oui' }, { question: QUESTIONS[1], reponse: 'autre', precision: 'garage a 200 m' }]
const MODULES = ['../api/guestflow-rediger', '../lib/require-permission', '../lib/cron-shared', '../lib/cron-classify', '../lib/balises', '../lib/guestflow/rediger']

function doubler (chemin, exports) {
  const abs = require.resolve(chemin)
  const m = new Module(abs); m.exports = exports; m.loaded = true
  require.cache[abs] = m
}

function preparer ({
  refuser = null, booking = { property_id: REF, snapshot: { firstName: 'Anna', lastName: 'K' } },
  bien = BIEN, pause = false, taches = [TACHE], appels = 0, erreurAppels = null,
  ia = async () => ({ model: 'claude-haiku', content: [{ type: 'text', text: '« Hello Anna, yes for the dog! »' }] })
} = {}) {
  const etat = { lectures: [], ecritures: [], gardes: [], prompts: [], contextes: [] }
  const client = {
    from (nom) {
      const q = { table: nom, eq: {}, gte: {}, limite: null, ordre: null }
      const ecrire = (op) => () => { etat.ecritures.push({ table: nom, op }); return chain }
      const executer = () => {
        etat.lectures.push(q)
        if (nom === 'ia_appels' && erreurAppels) return { data: null, error: erreurAppels }
        let rows = nom === 'properties' ? (bien ? [bien] : [])
          : nom === 'agent_tasks' ? taches
          : nom === 'messages' ? MESSAGES
          : nom === 'knowledge' ? [{ user_id: PROD, property_id: REF, type: 'faq', sujet: 'Parking', texte: 'Rue Voltaire' },
                                   { user_id: PROD, property_id: 'AUTRE', type: 'faq', sujet: 'SECRET', texte: 'AUTRE BIEN' }]
          : nom === 'ia_appels' ? Array.from({ length: appels }, (_, i) => ({ id: 'a' + i, fonction: 'guestflow_rediger', user_id: PROD, booking_id: 'B1', created_at: new Date().toISOString() }))
          : []
        rows = rows.filter(r => Object.entries(q.eq).every(([k, v]) => String(r[k]) === String(v)))
        if (q.limite != null) rows = rows.slice(0, q.limite)
        return { data: rows, error: null }
      }
      const chain = {
        select () { return chain },
        eq (k, v) { q.eq[k] = v; return chain },
        gte (k, v) { q.gte[k] = v; return chain },
        order (c, o) { q.ordre = [c, o]; return chain },
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
      etat.gardes.push(opts)
      if (refuser) { res.status(refuser).json({ error: 'refus' }); return { ok: false } }
      return { ok: true, accountUserId: PROD, booking, contexte: {} }
    }
  })
  const { contexteIA } = require('../lib/ia/journal')
  doubler('../lib/cron-shared', {
    isAutomationPaused: async (u, ref) => { etat.pauseLue = [u, ref]; return pause },
    anthropic: { messages: { create: async (demande) => {
      etat.prompts.push(demande.messages[0].content)
      etat.contextes.push({ ...contexteIA() })
      return ia(demande)
    } } }
  })
  doubler('../lib/cron-classify', {
    buildKnowledgeText: (k) => { etat.knowledge = k; return k.map(x => `${x.sujet} : ${x.texte}`).join('\n') },
    loadPromptingInstructions: async (u, ref) => { etat.consignesLues = [u, ref]; return { global: 'Signer Thierry', propertyOverride: '' } },
    modeleConfigure: () => 'claude-haiku',
    requeteClassification: (prompt, modele) => ({ model: modele, max_tokens: 1000, messages: [{ role: 'user', content: prompt }] })
  })
  doubler('../lib/balises', { replisDuBien: () => [] })
  return etat
}

function reponse () {
  const r = { code: null, body: null, entetes: {} }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = (k, v) => { r.entetes[k.toLowerCase()] = v }
  return r
}
async function appeler (body, method = 'POST') {
  const res = reponse()
  await require('../api/guestflow-rediger')({ method, body, query: {}, headers: { authorization: 'Bearer j' } }, res)
  return res
}
const choix = (x = {}) => ({ action: 'choix', bookingId: 'B1', tacheId: 'ti1', choix: CHOIX, ...x })

// ─── Rien ne part, rien n'est écrit ─────────────────────────────────────────

test('LE TEST QUI COMPTE : choix -> le texte redige revient, et RIEN n est ecrit nulle part', async () => {
  const etat = preparer()
  const res = await appeler(choix())
  assert.equal(res.code, 200)
  assert.deepEqual(res.body, { ok: true, texte: 'Hello Anna, yes for the dog!' })
  assert.deepEqual(etat.ecritures, [], 'aucune ecriture, sur aucune table')
  assert.equal(etat.prompts.length, 1)
  const p = etat.prompts[0]
  assert.match(p, /Décision de l'hôte : OUI/)
  assert.match(p, /Décision de l'hôte : AUTRE — garage a 200 m/)
  assert.match(p, /Can I come with my dog/)
  assert.doesNotMatch(p, /Rue Voltaire/, 'la base de connaissance est entree dans le texte du modele')
  assert.match(p, /Signer Thierry/)
  assert.doesNotMatch(p, /NOTE INTERNE/, 'la note interne de la tache ne part pas au modele')
  assert.doesNotMatch(p, /SECRET/, 'les connaissances d un autre bien non plus')
})

test('LE TEST QUI COMPTE : le plafond de l hote ne touche JAMAIS celui de l agent', async () => {
  const etat = preparer()
  await appeler(choix())
  assert.ok(!etat.lectures.some(q => q.table === 'guestflow_appels_ia'), 'ni lu')
  assert.ok(!etat.ecritures.some(e => e.table === 'guestflow_appels_ia'), 'ni ecrit')
  const j = etat.lectures.find(q => q.table === 'ia_appels')
  assert.ok(j, 'le plafond se lit dans le journal ia_appels')
  assert.deepEqual(j.eq, { fonction: 'guestflow_rediger', user_id: PROD, booking_id: 'B1' })
  assert.ok(j.gte.created_at, 'sur une fenetre')
  assert.ok(Math.abs(Date.now() - 24 * 3600000 - new Date(j.gte.created_at).getTime()) < 60000, 'de 24 h')
})

test('l appel est etiquete au journal sous `guestflow_rediger`, compte, bien (reference) et sejour', async () => {
  const etat = preparer()
  await appeler(choix())
  assert.deepEqual(etat.contextes[0], { fonction: 'guestflow_rediger', userId: PROD, propertyId: REF, bookingId: 'B1' })
})

test('texte -> le brouillon de l hote, mis en forme ; rien d ecrit', async () => {
  const etat = preparer()
  const res = await appeler({ action: 'texte', bookingId: 'B1', brouillon: ' oui chien, non moto ' })
  assert.equal(res.code, 200)
  assert.equal(res.body.texte, 'Hello Anna, yes for the dog!')
  assert.match(etat.prompts[0], /BROUILLON DE L'HÔTE — le message dit ceci, et RIEN d'autre :\noui chien, non moto/)
  assert.deepEqual(etat.ecritures, [])
  assert.ok(!etat.lectures.some(q => q.table === 'agent_tasks'), 'le bouton IA ne lit aucune tache')
})

// ─── Gardes ─────────────────────────────────────────────────────────────────

test('la garde est celle de « Proposer » : messages en ecriture, reservation requise', async () => {
  const etat = preparer()
  await appeler(choix({ propertyId: BIEN.id }))
  assert.deepEqual(etat.gardes[0], { domaine: 'messages', niveau: 'write', booking: 'B1', bookingRequis: true, bien: BIEN.id })
})

test('LE TEST QUI COMPTE : garde refusee -> aucune lecture metier, aucun appel IA', async () => {
  const etat = preparer({ refuser: 403 })
  const res = await appeler(choix())
  assert.equal(res.code, 403)
  assert.equal(etat.lectures.length, 0)
  assert.equal(etat.prompts.length, 0)
  assert.equal(res.entetes['cache-control'], 'private, no-store')
})

test('aucune donnee de compte en cache : `private, no-store` avant le premier refus, le 405 compris', async () => {
  preparer()
  for (const [body, method, code] of [[{}, 'GET', 405], [{ action: 'x', bookingId: 'B1' }, 'POST', 400], [{ action: 'choix' }, 'POST', 400], [choix(), 'POST', 200]]) {
    const res = await appeler(body, method)
    assert.equal(res.code, code, JSON.stringify(body))
    assert.equal(res.entetes['cache-control'], 'private, no-store')
  }
})

test('Server-Timing porte le nombre de requetes', async () => {
  preparer()
  const res = await appeler(choix())
  assert.match(res.entetes['server-timing'] || '', /requêtes/)
})

test('bien introuvable -> 404 ; kill switch -> 409 en_pause, sans appel IA, lu sur la REFERENCE provider', async () => {
  let etat = preparer({ bien: null })
  assert.equal((await appeler(choix())).code, 404)
  assert.equal(etat.prompts.length, 0)
  etat = preparer({ pause: true })
  const res = await appeler(choix())
  assert.equal(res.code, 409)
  assert.equal(res.body.error, 'en_pause')
  assert.deepEqual(etat.pauseLue, [PROD, REF])
  assert.equal(etat.prompts.length, 0)
})

// ─── La tâche ───────────────────────────────────────────────────────────────

test('tache absente, d un autre sejour ou d un autre bien -> 404', async () => {
  preparer()
  assert.equal((await appeler(choix({ tacheId: 'inconnue' }))).code, 404)
  preparer({ taches: [{ ...TACHE, book_id: 'B2' }] })
  assert.equal((await appeler(choix())).code, 404)
  preparer({ taches: [{ ...TACHE, property_id: '169567' }] })
  assert.equal((await appeler(choix())).code, 404)
})

test('tache deja traitee -> 409 deja_traitee ; intervention ou tache systeme -> 409 sans_question ; jamais d appel IA', async () => {
  let etat = preparer({ taches: [{ ...TACHE, status: 'done' }] })
  let res = await appeler(choix())
  assert.equal(res.code, 409); assert.equal(res.body.error, 'deja_traitee')
  assert.equal(etat.prompts.length, 0)
  etat = preparer({ taches: [{ ...TACHE, task_type: 'intervention' }] })
  res = await appeler(choix())
  assert.equal(res.code, 409); assert.equal(res.body.error, 'sans_question')
  etat = preparer({ taches: [{ ...TACHE, summary: require('../lib/guestflow/rediger').MOTIF_ARRET }] })
  res = await appeler(choix())
  assert.equal(res.code, 409); assert.equal(res.body.error, 'sans_question')
  assert.equal(etat.prompts.length, 0)
})

test('LE TEST QUI COMPTE : des choix sur d ANCIENNES questions -> 409 questions_changees, rien au modele', async () => {
  const etat = preparer({ taches: [{ ...TACHE, sub_tasks: [{ question: 'Le linge est-il fourni ?' }, { question: 'Y a-t-il une baignoire ?' }] }] })
  const res = await appeler(choix())
  assert.equal(res.code, 409)
  assert.equal(res.body.error, 'questions_changees')
  assert.equal(etat.prompts.length, 0)
})

test('choix invalides et brouillon vide -> 400, sans appel IA', async () => {
  const etat = preparer()
  for (const body of [
    choix({ choix: [{ question: QUESTIONS[0], reponse: 'oui' }, { question: QUESTIONS[1], reponse: 'autre' }] }),
    choix({ choix: [{ question: QUESTIONS[0], reponse: 'peut-etre' }, { question: QUESTIONS[1], reponse: 'non' }] }),
    choix({ tacheId: '' }),
    { action: 'texte', bookingId: 'B1', brouillon: '   ' },
    { action: 'texte', bookingId: 'x'.repeat(201), brouillon: 'oui' }
  ]) {
    assert.equal((await appeler(body)).code, 400, JSON.stringify(body).slice(0, 80))
  }
  assert.equal(etat.prompts.length, 0)
})

// ─── Le plafond, et les pannes ──────────────────────────────────────────────

test('LE TEST QUI COMPTE : 10 redactions en 24 h sur ce fil -> 429 garde_ia, sans appel ; 9 -> passe', async () => {
  let etat = preparer({ appels: 10 })
  const res = await appeler(choix())
  assert.equal(res.code, 429)
  assert.equal(res.body.error, 'garde_ia')
  assert.match(res.body.message, /10 fois/)
  assert.equal(etat.prompts.length, 0)
  etat = preparer({ appels: 9 })
  assert.equal((await appeler(choix())).code, 200)
})

test('journal illisible -> 503, sans appel (on ne sait pas si le plafond est atteint)', async () => {
  const etat = preparer({ erreurAppels: { message: 'boom' } })
  assert.equal((await appeler(choix())).code, 503)
  assert.equal(etat.prompts.length, 0)
})

test('le modele echoue ou ne rend rien d utilisable -> 502 ia_indisponible, rien d ecrit', async () => {
  let etat = preparer({ ia: async () => { throw new Error('credit') } })
  let res = await appeler(choix())
  assert.equal(res.code, 502); assert.equal(res.body.error, 'ia_indisponible')
  assert.deepEqual(etat.ecritures, [])
  etat = preparer({ ia: async () => ({ content: [{ type: 'text', text: '   ' }] }) })
  res = await appeler(choix())
  assert.equal(res.code, 502)
  assert.deepEqual(etat.ecritures, [])
})

test('le fil donne au modele : les 30 plus RECENTS, lus dans le coeur pour ce sejour et ce compte', async () => {
  const etat = preparer()
  await appeler(choix())
  const m = etat.lectures.find(q => q.table === 'messages')
  assert.deepEqual(m.eq, { user_id: PROD, booking_id: 'B1' })
  assert.deepEqual(m.ordre, ['sent_at', { ascending: false }])
  assert.equal(m.limite, 30)
  // Recette du 12 novembre 2026 : la base de connaissance n'est plus lue —
  // le modele y avait pris un code de porte que personne n'avait demande.
  assert.ok(!etat.lectures.some(q => q.table === 'knowledge'), 'la base de connaissance est lue')
  assert.deepEqual(etat.consignesLues, [PROD, REF])
})
