// tests/labo-ia.test.js — le Labo IA (api/labo-ia.js, lib/labo-ia.js,
// lib/ia/openrouter.js). Doc : docs/kb/labo-ia.md.
//
// ⚠ CE QUE CES TESTS GARDENT, PAR ORDRE DE COÛT D'UNE ERREUR :
//  1. LE FONDATEUR SEUL : tout autre compte est refusé AVANT toute lecture et
//     avant tout appel au modèle (une clé OpenRouter se vide en dollars).
//  2. LE CLOISONNEMENT : un bien ou un séjour d'un autre compte (ou d'un autre
//     bien) donne 404, jamais sa base ni son fil — prouvé par des lignes
//     d'autres comptes PRÉSENTES dans le jeu d'essai et ABSENTES du texte
//     envoyé au modèle.
//  3. LA CLÉ ET LA DESTINATION : la clé ne part que vers l'adresse constante
//     d'OpenRouter, et ne revient jamais dans le journal ni dans une réponse.
//  4. LE COÛT : modèle hors catalogue refusé, appel trop cher refusé AVANT
//     envoi, plafond du jour en DOLLARS et en appels, échec facturé rendu avec
//     son coût, chaque tentative journalisée avec le coût FACTURÉ.
//  5. LES DONNÉES DES VOYAGEURS : `data_collection: deny` toujours ;
//     hébergeurs établis en Chine (liste d'OpenRouter) exclus au premier
//     essai ; relance sans l'exclusion seulement sur « aucun hébergeur », et
//     dite ; jamais sur notre propre erreur ; un hébergeur inconnu n'est pas
//     « hors Chine ».
//  6. RIEN N'EST ÉCRIT dans le produit : la seule écriture est le journal.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { baseEnregistreuse } = require('./outils/base-enregistreuse')

const FONDATEUR = '85e3a0ef-75bd-4c11-a3b7-e2811067dc36'
const AUTRE = '76dd9e9e-ec14-429f-a806-0deacb5f01e4'
const EMAIL = 'fondateur@exemple.test'
const BIEN = { id: 'aa11bb22-cc33-4dd4-8ee5-ff6677889900', user_id: FONDATEUR, name: 'La bulle', provider_property_id: '209413', archive_le: null }
const BIEN_AUTRE = { id: 'bb11bb22-cc33-4dd4-8ee5-ff6677889900', user_id: AUTRE, name: 'Chez un autre', provider_property_id: '999', archive_le: null }
const CLE = 'sk-or-v1-0123456789abcdef0123456789abcdef'
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF').toString('base64')
const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0]).toString('base64')
const HEIC = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0]).toString('base64')

// Le catalogue public d'OpenRouter (forme brute de GET /models).
const MODELE = (id, prompt, completion, { image = false, fichier = false, sortieMax = null } = {}) => ({
  id, name: id, created: 1, pricing: { prompt: String(prompt), completion: String(completion) },
  architecture: { input_modalities: ['text', ...(image ? ['image'] : []), ...(fichier ? ['file'] : [])], output_modalities: ['text'] },
  top_provider: sortieMax ? { max_completion_tokens: sortieMax } : {}
})
const CATALOGUE = {
  data: [
    MODELE('openai/gpt-x', 0.0000025, 0.00001, { image: true, fichier: true }),
    MODELE('moonshotai/kimi-x', 0.000002, 0.00001),
    MODELE('qwen/qwen-x', 0.0000004, 0.0000012),
    MODELE('google/gemini-x', 0.0000003, 0.0000025, { image: true, fichier: true, sortieMax: 1000 }),
    MODELE('openai/o-cher', 0.00015, 0.0006)
  ]
}
// La liste publique des hébergeurs (forme brute de GET /providers).
const HEBERGEURS = {
  data: [
    { slug: 'openai', name: 'OpenAI', headquarters: 'US', datacenters: ['US'] },
    { slug: 'deepinfra', name: 'DeepInfra', headquarters: 'US', datacenters: ['US'] },
    { slug: 'moonshotai', name: 'Moonshot AI', headquarters: 'CN', datacenters: ['CN'] },
    { slug: 'seed', name: 'Seed', headquarters: 'CN', datacenters: ['CN'] },
    { slug: 'streamlake', name: 'StreamLake', headquarters: 'CN' },
    { slug: 'hors-siege', name: 'Hors Siege', headquarters: 'SG', datacenters: ['SG', 'CN'] }
  ]
}

function doubler (chemin, exports) {
  const abs = require.resolve(chemin)
  const m = new Module(abs); m.exports = exports; m.loaded = true
  require.cache[abs] = m
}

// Une réponse OpenRouter réussie.
const REPONSE_OK = (texte = 'Oui, arrivée possible jusqu’à 23 h.', provider = 'OpenAI') => ({
  id: 'gen-1', model: 'openai/gpt-x', provider,
  choices: [{ message: { role: 'assistant', content: texte }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 812, completion_tokens: 40, cost: 0.000731, completion_tokens_details: { reasoning_tokens: 0 }, prompt_tokens_details: { cached_tokens: 0 } }
})

const ilYA = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString()

/**
 * Appelle l'endpoint avec une base enregistreuse et un `fetch` enregistreur
 * qui sert le catalogue, la liste des hébergeurs, puis les réponses du modèle.
 * `journal` : les lignes de `ia_appels` déjà présentes (le double applique
 * `eq`, `in` et `gte` à cette table — règle 22).
 */
async function appeler ({
  methode = 'GET', query = {}, corps = null, email = EMAIL, fondateur = EMAIL, cle = CLE,
  compteBascule = false, lignes = {}, journal = [], reponses = [REPONSE_OK()], statuts = [200],
  catalogue = CATALOGUE, hebergeurs = HEBERGEURS, env = {}
} = {}) {
  const { client, requetes } = baseEnregistreuse((r) => {
    if (r.op !== 'select') return { data: null, error: null }
    if (r.table === 'ia_appels') {
      let rows = journal.slice()
      for (const f of r.filtres) {
        if (f[0] === 'in') rows = rows.filter(l => f[2].map(String).includes(String(l[f[1]])))
        if (f[0] === 'gte') rows = rows.filter(l => String(l[f[1]]) >= String(f[2]))
      }
      return { data: rows, error: null }
    }
    let rows = lignes[r.table] || []
    for (const f of r.filtres) if (f[0] === 'in') rows = rows.filter(l => !(f[1] in l) || f[2].map(String).includes(String(l[f[1]])))
    return { data: rows, error: null }
  })
  const absSdk = require.resolve('@supabase/supabase-js')
  require('@supabase/supabase-js')
  const vraiCreate = require.cache[absSdk].exports.createClient
  require.cache[absSdk].exports.createClient = () => client

  const gardes = []
  doubler('../lib/require-permission', {
    requirePermission: async (req, res, opts) => {
      gardes.push(opts)
      res.setHeader('Cache-Control', 'private, no-store')
      // Un compte basculé : le contexte désigne un AUTRE compte.
      return { ok: true, userId: FONDATEUR, accountUserId: compteBascule ? AUTRE : FONDATEUR, email }
    }
  })
  doubler('../lib/cron-classify', {
    buildKnowledgeText: (k) => (k || []).map(x => `${x.key} : ${x.value}`).join('\n'),
    loadPromptingInstructions: async () => ({ global: 'Signer Thierry', propertyOverride: '' })
  })
  const OR = require('../lib/ia/openrouter')
  OR._viderCache()
  const appels = []
  const publics = []
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    if (/\/models$/.test(url)) { publics.push(url); return { ok: true, status: 200, json: async () => catalogue } }
    if (/\/providers$/.test(url)) {
      publics.push(url)
      return hebergeurs ? { ok: true, status: 200, json: async () => hebergeurs } : { ok: false, status: 500, json: async () => ({}) }
    }
    const i = appels.length
    appels.push({ url, opts, corps: opts && opts.body ? JSON.parse(opts.body) : null })
    const statut = statuts[Math.min(i, statuts.length - 1)]
    const json = reponses[Math.min(i, reponses.length - 1)]
    return { ok: statut >= 200 && statut < 300, status: statut, json: async () => json }
  }
  const NOMS = ['OPENROUTER_API_KEY', 'FOUNDER_EMAIL', 'LABO_IA_PLAFOND_USD', 'LABO_IA_MAX_APPEL_USD']
  const avant = Object.fromEntries(NOMS.map(n => [n, process.env[n]]))
  const poser = (n, v) => { if (v === null || v === undefined) delete process.env[n]; else process.env[n] = v }
  poser('OPENROUTER_API_KEY', cle)
  poser('FOUNDER_EMAIL', fondateur)
  poser('LABO_IA_PLAFOND_USD', env.LABO_IA_PLAFOND_USD)
  poser('LABO_IA_MAX_APPEL_USD', env.LABO_IA_MAX_APPEL_USD)

  const abs = require.resolve('../api/labo-ia')
  delete require.cache[abs]
  const endpoint = require(abs)
  const rep = { statut: null, charge: null, entetes: {} }
  const res = {
    headersSent: false,
    setHeader (k, v) { rep.entetes[String(k).toLowerCase()] = v },
    status (s) { rep.statut = s; return res },
    json (c) { rep.charge = c; res.headersSent = true; return res }
  }
  try {
    await endpoint({ method: methode, headers: compteBascule ? { 'x-compte': AUTRE } : {}, query, body: corps }, res)
  } finally {
    require.cache[absSdk].exports.createClient = vraiCreate
    globalThis.fetch = vraiFetch
    for (const n of NOMS) poser(n, avant[n])
    delete require.cache[abs]
    delete require.cache[require.resolve('../lib/require-permission')]
    delete require.cache[require.resolve('../lib/cron-classify')]
  }
  const ecritures = requetes.filter(r => r.op !== 'select')
  return { ...rep, requetes, ecritures, appels, publics, gardes }
}

const filtre = (r, col) => (r.filtres.find(f => f[0] === 'eq' && f[1] === col) || [])[2]
const QUESTION = (extra = {}) => ({ action: 'question', modele: 'openai/gpt-x', bien: BIEN.id, question: 'Que lui répondre ?', ...extra })

// ─── 1. La porte ────────────────────────────────────────────────────────────

test('PUT -> 405, l’en-tête privé déjà posé, aucune requête', async () => {
  const r = await appeler({ methode: 'PUT' })
  assert.equal(r.statut, 405)
  assert.match(String(r.entetes['cache-control']), /private, no-store/)
  assert.equal(r.requetes.length, 0)
})

test('LE TEST QUI COMPTE : un compte qui n’est pas le fondateur est refusé AVANT toute lecture et tout appel', async () => {
  for (const req of [
    { methode: 'GET', query: { action: 'biens' } },
    { methode: 'POST', corps: QUESTION() },
    { methode: 'POST', corps: { action: 'facture', modele: 'openai/gpt-x', fichier: PDF } }
  ]) {
    const r = await appeler({ ...req, email: 'hote@ailleurs.test', lignes: { properties: [BIEN] } })
    assert.equal(r.statut, 403, JSON.stringify(req))
    assert.equal(r.requetes.length, 0)
    assert.equal(r.appels.length, 0)
    assert.equal(r.publics.length, 0)
  }
})

test('FOUNDER_EMAIL absent : refus qui dit sa cause, sans lecture', async () => {
  const r = await appeler({ query: { action: 'biens' }, fondateur: null })
  assert.equal(r.statut, 403)
  assert.equal(r.charge.motif, 'FOUNDER_EMAIL absent de la configuration')
  assert.equal(r.requetes.length, 0)
})

test('un compte basculé (X-Compte) ne change RIEN : les lectures restent celles du fondateur', async () => {
  const r = await appeler({ query: { action: 'biens' }, compteBascule: true, lignes: { properties: [BIEN, BIEN_AUTRE] } })
  assert.equal(r.statut, 200)
  assert.deepEqual(r.charge.biens, [{ id: BIEN.id, nom: 'La bulle' }])
  assert.equal(filtre(r.requetes.find(x => x.table === 'properties'), 'user_id'), FONDATEUR)
})

test('une action inconnue -> 400 sans requête', async () => {
  const r = await appeler({ query: { action: 'tout_effacer' } })
  assert.equal(r.statut, 400)
  assert.equal(r.requetes.length, 0)
})

// ─── 2. Le cloisonnement ────────────────────────────────────────────────────

test('biens : seulement ceux du fondateur, archives écartées', async () => {
  const r = await appeler({ query: { action: 'biens' }, lignes: { properties: [BIEN, BIEN_AUTRE] } })
  assert.equal(r.statut, 200)
  assert.deepEqual(r.charge.biens, [{ id: BIEN.id, nom: 'La bulle' }])
  const q = r.requetes.find(x => x.table === 'properties')
  assert.ok(q.filtres.some(f => f[0] === 'is' && f[1] === 'archive_le' && f[2] === null))
})

test('LE TEST QUI COMPTE : un bien d’un autre compte -> 404, et ni base ni fil ni modèle', async () => {
  const r = await appeler({
    methode: 'POST',
    corps: QUESTION({ bien: BIEN_AUTRE.id, question: 'Code de la porte ?' }),
    lignes: { properties: [BIEN_AUTRE], knowledge: [{ user_id: AUTRE, property_id: '999', key: 'code', value: '4242' }] }
  })
  assert.equal(r.statut, 404)
  assert.equal(r.appels.length, 0)
  assert.ok(!r.requetes.some(x => x.table === 'knowledge' || x.table === 'messages'))
})

test('un séjour d’un AUTRE bien du même compte -> 404, sans appel au modèle', async () => {
  const r = await appeler({
    methode: 'POST',
    corps: QUESTION({ booking: 'B9' }),
    lignes: {
      properties: [BIEN],
      bookings_snapshot: [{ user_id: FONDATEUR, booking_id: 'B9', property_id: 'AUTRE-BIEN', snapshot: { firstName: 'Zoé' } }],
      messages: []
    }
  })
  assert.equal(r.statut, 404)
  assert.equal(r.appels.length, 0)
})

test('un séjour qui n’existe que sur un AUTRE compte -> 404, sans appel', async () => {
  const r = await appeler({
    methode: 'POST',
    corps: QUESTION({ booking: 'B7' }),
    lignes: {
      properties: [BIEN],
      bookings_snapshot: [{ user_id: AUTRE, booking_id: 'B7', property_id: '209413', snapshot: { firstName: 'Intrus' } }],
      messages: [{ user_id: AUTRE, property_id: '209413', booking_id: 'B7', direction: 'inbound', kind: 'message', body: 'MESSAGE D UN AUTRE COMPTE', sent_at: '2026-11-19T10:00:00Z' }]
    }
  })
  assert.equal(r.statut, 404)
  assert.equal(r.appels.length, 0)
})

test('un bien sans référence provider -> 409, sans lecture de base ni appel', async () => {
  const r = await appeler({ methode: 'POST', corps: QUESTION(), lignes: { properties: [{ ...BIEN, provider_property_id: null }] } })
  assert.equal(r.statut, 409)
  assert.equal(r.charge.error, 'bien_sans_reference')
  assert.equal(r.appels.length, 0)
  assert.ok(!r.requetes.some(x => x.table === 'knowledge'))
})

test('conversations : lues sur le compte ET la référence provider du bien (règle 10), « unknown » écarté', async () => {
  const r = await appeler({
    query: { action: 'conversations', bien: BIEN.id },
    lignes: {
      properties: [BIEN],
      messages: [
        { user_id: FONDATEUR, property_id: '209413', booking_id: 'B1', direction: 'inbound', sent_at: '2026-11-19T10:00:00Z' },
        { user_id: FONDATEUR, property_id: '209413', booking_id: 'unknown', direction: 'inbound', sent_at: '2026-11-18T10:00:00Z' },
        { user_id: FONDATEUR, property_id: '209413', booking_id: 'B1', direction: 'outbound', sent_at: '2026-11-17T10:00:00Z' },
        { user_id: AUTRE, property_id: '209413', booking_id: 'B5', direction: 'inbound', sent_at: '2026-11-19T11:00:00Z' },
        { user_id: FONDATEUR, property_id: 'AUTRE-BIEN', booking_id: 'B6', direction: 'inbound', sent_at: '2026-11-19T12:00:00Z' }
      ],
      bookings_snapshot: [{ user_id: FONDATEUR, booking_id: 'B1', snapshot: { firstName: 'Anna', lastName: 'K', arrival: '2026-12-01', departure: '2026-12-04' } }]
    }
  })
  assert.equal(r.statut, 200)
  assert.deepEqual(r.charge.conversations.map(c => [c.bookingId, c.voyageur, c.messages, c.duVoyageur]), [['B1', 'Anna K', 2, 1]])
})

// ─── 3 à 6. L'essai « question » ────────────────────────────────────────────

const LIGNES_QUESTION = {
  properties: [BIEN],
  knowledge: [
    { user_id: FONDATEUR, property_id: '209413', key: 'Arrivée', value: 'à partir de 16 h, boîte à clé' },
    { user_id: AUTRE, property_id: '209413', key: 'Code', value: 'CODE-D-UN-AUTRE-COMPTE' },
    { user_id: FONDATEUR, property_id: 'AUTRE-BIEN', key: 'Code', value: 'CODE-D-UN-AUTRE-BIEN' }
  ],
  bookings_snapshot: [
    { user_id: FONDATEUR, booking_id: 'B1', property_id: '209413', snapshot: { firstName: 'Anna', arrival: '2026-12-01', departure: '2026-12-04' } },
    { user_id: AUTRE, booking_id: 'B1', property_id: '209413', snapshot: { firstName: 'VOYAGEUR-D-UN-AUTRE-COMPTE' } }
  ],
  messages: [
    { user_id: FONDATEUR, property_id: '209413', booking_id: 'B1', direction: 'inbound', kind: 'message', body: 'Can I arrive at 11pm?', sent_at: '2026-11-19T10:00:00Z' },
    { user_id: FONDATEUR, property_id: '209413', booking_id: 'B1', direction: 'outbound', kind: 'auto', body: 'Bienvenue !', sent_at: '2026-11-18T10:00:00Z' },
    { user_id: AUTRE, property_id: '209413', booking_id: 'B1', direction: 'inbound', kind: 'message', body: 'MESSAGE-D-UN-AUTRE-COMPTE', sent_at: '2026-11-19T11:00:00Z' },
    { user_id: FONDATEUR, property_id: 'AUTRE-BIEN', booking_id: 'B1', direction: 'inbound', kind: 'message', body: 'MESSAGE-D-UN-AUTRE-BIEN', sent_at: '2026-11-19T12:00:00Z' }
  ]
}

test('LE TEST QUI COMPTE : la question part vers l’adresse CONSTANTE, avec la base et le fil DU BIEN, rien d’un autre compte ni d’un autre bien', async () => {
  const r = await appeler({ methode: 'POST', corps: QUESTION({ booking: 'B1' }), lignes: LIGNES_QUESTION })
  assert.equal(r.statut, 200, JSON.stringify(r.charge))
  assert.equal(r.appels.length, 1)
  const a = r.appels[0]
  assert.equal(a.url, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(a.opts.headers.Authorization, `Bearer ${CLE}`)
  assert.equal(a.corps.model, 'openai/gpt-x')
  const systeme = a.corps.messages[0].content
  assert.match(systeme, /à partir de 16 h, boîte à clé/)
  assert.match(systeme, /\[MESSAGE AUTOMATIQUE\] Bienvenue !\n\[VOYAGEUR\] Can I arrive at 11pm\?/, 'le fil est remis à l’endroit')
  assert.match(systeme, /SÉJOUR : Anna/)
  assert.match(systeme, /Signer Thierry/)
  for (const intrus of ['AUTRE-COMPTE', 'AUTRE-BIEN']) assert.ok(!systeme.includes(intrus), `rien de ${intrus} dans le texte envoyé`)
  assert.deepEqual(a.corps.messages[1], { role: 'user', content: 'Que lui répondre ?' })
  assert.equal(r.charge.texte, 'Oui, arrivée possible jusqu’à 23 h.')
  assert.equal(r.charge.coutUsd, 0.000731)
  assert.equal(r.charge.hebergeur, 'OpenAI')
  assert.equal(r.charge.enChine, false)
  assert.equal(r.charge.restrictionLevee, false)
  assert.ok(!JSON.stringify(r.charge).includes(CLE), 'la clé ne revient jamais')
})

test('LE TEST QUI COMPTE : `data_collection: deny`, et les hébergeurs établis en Chine — siège OU centre de données, lus chez OpenRouter — exclus', async () => {
  const r = await appeler({ methode: 'POST', corps: QUESTION(), lignes: LIGNES_QUESTION })
  const p = r.appels[0].corps.provider
  assert.equal(p.data_collection, 'deny')
  assert.deepEqual(p.ignore.slice().sort(), ['hors-siege', 'moonshotai', 'seed', 'streamlake'])
})

test('liste des hébergeurs illisible : on exclut le REPLI (jamais une exclusion vide)', async () => {
  const r = await appeler({ methode: 'POST', corps: QUESTION(), lignes: LIGNES_QUESTION, hebergeurs: null })
  const ignore = r.appels[0].corps.provider.ignore
  for (const s of ['deepseek', 'moonshotai', 'seed', 'streamlake', 'nex-agi']) assert.ok(ignore.includes(s), s)
  assert.ok(!ignore.includes('bytedance'), 'ByteDance s’appelle `seed` chez OpenRouter')
})

test('LE TEST QUI COMPTE : la SEULE écriture est la ligne du journal, avec le coût facturé et l’étiquette du labo', async () => {
  const r = await appeler({ methode: 'POST', corps: QUESTION({ booking: 'B1' }), lignes: LIGNES_QUESTION })
  assert.equal(r.statut, 200)
  assert.deepEqual(r.ecritures.map(e => [e.table, e.op]), [['ia_appels', 'insert']])
  const l = r.ecritures[0].charge
  assert.equal(l.fonction, 'labo-ia-question')
  assert.equal(l.user_id, FONDATEUR)
  assert.equal(l.property_id, '209413')
  assert.equal(l.booking_id, 'B1')
  assert.equal(l.input_tokens, 812)
  assert.equal(l.output_tokens, 40)
  assert.equal(l.cout_usd, 0.000731)
  assert.equal(l.ok, true)
  assert.ok(!JSON.stringify(l).includes('Can I arrive'), 'jamais le texte dans le journal')
})

test('clé absente -> 503 qui le dit, sans appel ni écriture', async () => {
  const r = await appeler({ methode: 'POST', cle: null, corps: QUESTION(), lignes: LIGNES_QUESTION })
  assert.equal(r.statut, 503)
  assert.equal(r.charge.error, 'cle_absente')
  assert.equal(r.appels.length, 0)
  assert.equal(r.ecritures.length, 0)
})

test('LE TEST QUI COMPTE : un modèle hors catalogue (`:online`, routeur, forme d’URL) -> 400, sans appel', async () => {
  for (const modele of ['openai/gpt-x:online', 'openrouter/auto', 'https://evil.test/x', '../../etc', 'openai/gpt x', '']) {
    const r = await appeler({ methode: 'POST', corps: QUESTION({ modele }), lignes: LIGNES_QUESTION })
    assert.equal(r.statut, 400, modele)
    assert.equal(r.appels.length, 0)
  }
})

test('LE TEST QUI COMPTE : un appel dont le coût MAXIMAL dépasse le plafond par appel est refusé AVANT envoi', async () => {
  const r = await appeler({ methode: 'POST', corps: QUESTION({ modele: 'openai/o-cher' }), lignes: LIGNES_QUESTION })
  assert.equal(r.statut, 400)
  assert.equal(r.charge.error, 'trop_cher')
  assert.ok(r.charge.coutMaxUsd > 0.5)
  assert.equal(r.appels.length, 0)
  // Le plafond se règle : relevé, l'appel part.
  const r2 = await appeler({ methode: 'POST', corps: QUESTION({ modele: 'openai/o-cher' }), lignes: LIGNES_QUESTION, env: { LABO_IA_MAX_APPEL_USD: '10' } })
  assert.equal(r2.statut, 200)
})

test('`max_tokens` : le voulu, borné par ce que l’hébergeur du modèle accepte', async () => {
  const r = await appeler({ methode: 'POST', corps: QUESTION({ modele: 'google/gemini-x' }), lignes: LIGNES_QUESTION })
  assert.equal(r.appels[0].corps.max_tokens, 1000)
  const r2 = await appeler({ methode: 'POST', corps: QUESTION(), lignes: LIGNES_QUESTION })
  assert.equal(r2.appels[0].corps.max_tokens, 6000)
})

test('plafond du jour en DOLLARS : la dépense FACTURÉE du labo sur 24 h, échecs compris -> 429 sans appel', async () => {
  const journal = [
    { user_id: FONDATEUR, fonction: 'labo-ia-question', created_at: ilYA(1), cout_usd: 3 },
    { user_id: FONDATEUR, fonction: 'labo-ia-facture', created_at: ilYA(2), cout_usd: 2.5, ok: false }
  ]
  const r = await appeler({ methode: 'POST', corps: QUESTION(), lignes: LIGNES_QUESTION, journal })
  assert.equal(r.statut, 429)
  assert.match(r.charge.message, /5,?\.?50|5\.50/)
  assert.equal(r.appels.length, 0)
})

test('plafond du jour : seuls les appels DU LABO, sur 24 h, DU COMPTE comptent', async () => {
  const journal = [
    // L'agent GuestFlow du même compte : ne bloque pas le labo.
    ...Array.from({ length: 450 }, () => ({ user_id: FONDATEUR, fonction: 'guestflow', created_at: ilYA(1), cout_usd: 1 })),
    // Le labo il y a deux jours : hors fenêtre.
    { user_id: FONDATEUR, fonction: 'labo-ia-question', created_at: ilYA(48), cout_usd: 50 },
    // Un autre compte : hors compte.
    { user_id: AUTRE, fonction: 'labo-ia-question', created_at: ilYA(1), cout_usd: 50 }
  ]
  const r = await appeler({ methode: 'POST', corps: QUESTION(), lignes: LIGNES_QUESTION, journal })
  assert.equal(r.statut, 200, JSON.stringify(r.charge))
})

test('plafond du jour en APPELS : 400 tentatives du labo en 24 h -> 429', async () => {
  const journal = Array.from({ length: 400 }, () => ({ user_id: FONDATEUR, fonction: 'labo-ia-question', created_at: ilYA(1), cout_usd: 0 }))
  const r = await appeler({ methode: 'POST', corps: QUESTION(), lignes: LIGNES_QUESTION, journal })
  assert.equal(r.statut, 429)
  assert.equal(r.appels.length, 0)
})

test('« aucun hébergeur hors Chine » : relance SANS l’exclusion, `deny` maintenu, et la réponse le dit', async () => {
  const r = await appeler({
    methode: 'POST',
    corps: QUESTION({ modele: 'moonshotai/kimi-x' }),
    lignes: LIGNES_QUESTION,
    statuts: [404, 200],
    reponses: [{ error: { code: 404, message: 'No allowed providers are available for the selected model.' } }, REPONSE_OK('Bonjour', 'Moonshot AI')]
  })
  assert.equal(r.statut, 200)
  assert.equal(r.appels.length, 2)
  assert.ok(Array.isArray(r.appels[0].corps.provider.ignore))
  assert.equal(r.appels[1].corps.provider.ignore, undefined)
  assert.equal(r.appels[1].corps.provider.data_collection, 'deny', 'la règle « pas d’entraînement » ne se lève jamais')
  assert.equal(r.charge.restrictionLevee, true)
  assert.equal(r.charge.enChine, true)
  assert.deepEqual(r.ecritures.map(e => e.charge.ok), [false, true], 'les deux tentatives sont journalisées')
})

test('LE TEST QUI COMPTE : un identifiant de NOTRE liste refusé par OpenRouter ne lève PAS l’exclusion — échec visible', async () => {
  const r = await appeler({
    methode: 'POST', corps: QUESTION({ modele: 'qwen/qwen-x' }), lignes: LIGNES_QUESTION,
    statuts: [400], reponses: [{ error: { code: 400, message: 'Invalid provider: seed' } }]
  })
  assert.equal(r.statut, 502)
  assert.equal(r.appels.length, 1)
  assert.equal(r.charge.motif, 'liste_hebergeurs_invalide')
})

test('une panne ordinaire (« Provider returned error ») ne lève PAS l’exclusion', async () => {
  const r = await appeler({
    methode: 'POST', corps: QUESTION({ modele: 'qwen/qwen-x' }), lignes: LIGNES_QUESTION,
    statuts: [400], reponses: [{ error: { code: 400, message: 'Provider returned error' } }]
  })
  assert.equal(r.statut, 502)
  assert.equal(r.appels.length, 1)
})

test('LE TEST QUI COMPTE : un échec FACTURÉ (limite de tokens, réponse vide) rend son coût et son motif', async () => {
  const r = await appeler({
    methode: 'POST', corps: QUESTION(), lignes: LIGNES_QUESTION,
    reponses: [{ model: 'openai/gpt-x', provider: 'OpenAI', choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { prompt_tokens: 900, completion_tokens: 6000, cost: 0.0275, completion_tokens_details: { reasoning_tokens: 6000 } } }]
  })
  assert.equal(r.statut, 502)
  assert.equal(r.charge.motif, 'limite_tokens')
  assert.equal(r.charge.coutUsd, 0.0275)
  assert.equal(r.charge.usage.raisonnement, 6000)
  assert.equal(r.ecritures[0].charge.cout_usd, 0.0275)
})

test('hébergeur inconnu de la liste : « pays inconnu » (null), jamais « hors Chine »', async () => {
  const r = await appeler({ methode: 'POST', corps: QUESTION(), lignes: LIGNES_QUESTION, reponses: [REPONSE_OK('ok', 'Nouvel Hebergeur')] })
  assert.equal(r.statut, 200)
  assert.equal(r.charge.enChine, null)
})

test('une erreur qui recopie la clé : masquée dans la réponse ET dans le journal', async () => {
  const r = await appeler({
    methode: 'POST', corps: QUESTION(), lignes: LIGNES_QUESTION,
    statuts: [401], reponses: [{ error: { code: 401, message: `Invalid key ${CLE}` } }]
  })
  assert.equal(r.statut, 502)
  assert.ok(!JSON.stringify(r.charge).includes(CLE))
  assert.ok(!JSON.stringify(r.ecritures).includes(CLE))
  assert.match(r.charge.message, /<masque>/)
})

test('un bien en migration : un séjour porté par la référence CIBLE est accepté', async () => {
  const enMigration = { ...BIEN, migration_target_property_id: 'CIBLE-1' }
  const r = await appeler({
    methode: 'POST', corps: QUESTION({ booking: 'B3' }),
    lignes: {
      properties: [enMigration], knowledge: [],
      bookings_snapshot: [{ user_id: FONDATEUR, booking_id: 'B3', property_id: 'CIBLE-1', snapshot: { firstName: 'Léa' } }],
      messages: [{ user_id: FONDATEUR, property_id: 'CIBLE-1', booking_id: 'B3', direction: 'inbound', kind: 'message', body: 'Bonjour', sent_at: '2026-11-19T10:00:00Z' }]
    }
  })
  assert.equal(r.statut, 200, JSON.stringify(r.charge))
  assert.match(r.appels[0].corps.messages[0].content, /\[VOYAGEUR\] Bonjour/)
})

// ─── L'essai « facture » ────────────────────────────────────────────────────

test('facture : le PDF part AVANT la consigne du compte de charges (même ordre que la production), et la lecture revient normalisée', async () => {
  const json = JSON.stringify({ fournisseur_nom: 'EDF', numero_facture: 'F-12', date_facture: '2026-10-02', montant_ht: 100, montant_tva: 20, montant_ttc: 120, categorie: 'energie', type_document: 'facture' })
  const r = await appeler({ methode: 'POST', corps: { action: 'facture', modele: 'google/gemini-x', fichier: PDF }, reponses: [REPONSE_OK('Voici : ' + json)] })
  assert.equal(r.statut, 200, JSON.stringify(r.charge))
  const contenu = r.appels[0].corps.messages[0].content
  assert.equal(contenu[0].type, 'file')
  assert.match(contenu[0].file.file_data, /^data:application\/pdf;base64,/)
  assert.equal(contenu[1].text, require('../lib/charges/lecture').CONSIGNE)
  assert.equal(r.charge.lecture.ok, true)
  assert.equal(r.charge.lecture.lu.montant_ttc_cents, 12000)
  assert.deepEqual(r.ecritures.map(e => [e.table, e.charge.fonction]), [['ia_appels', 'labo-ia-facture']])
  assert.equal(r.ecritures[0].charge.booking_id, null, 'une facture n’est pas un séjour')
})

test('facture : une image n’est pas envoyée à un modèle qui ne voit pas les images', async () => {
  const r = await appeler({ methode: 'POST', corps: { action: 'facture', modele: 'qwen/qwen-x', fichier: PNG } })
  assert.equal(r.statut, 400)
  assert.equal(r.charge.error, 'modele_sans_image')
  assert.equal(r.appels.length, 0)
})

test('facture : le type se lit dans les OCTETS — un HEIC est refusé, sans appel', async () => {
  const r = await appeler({ methode: 'POST', corps: { action: 'facture', modele: 'google/gemini-x', fichier: HEIC } })
  assert.equal(r.statut, 400)
  assert.equal(r.charge.error, 'type_non_pris')
  assert.equal(r.appels.length, 0)
})

// ─── Les règles pures ───────────────────────────────────────────────────────

test('catalogue : prix par million, borne de réponse, routeurs, variantes gratuites et sorties non textuelles écartés', () => {
  const { reduireCatalogue } = require('../lib/ia/openrouter')
  const c = reduireCatalogue({
    data: [
      { ...MODELE('openai/gpt-y', '0.0000025', '0.00001', { image: true, fichier: true, sortieMax: 16000 }), created: 2 },
      { id: 'openrouter/auto', name: 'Auto', pricing: { prompt: '-1', completion: '-1' } },
      { id: 'meta/llama:free', name: 'Free', pricing: { prompt: '0', completion: '0' } },
      { id: 'img/gen', name: 'Image', pricing: { prompt: '0.000001', completion: '0.000001' }, architecture: { output_modalities: ['image'] } },
      { ...MODELE('deepseek/v4', '0.0000003', '0.0000012'), created: 3 }
    ]
  })
  assert.deepEqual(c.map(m => m.id), ['deepseek/v4', 'openai/gpt-y'])
  const g = c.find(m => m.id === 'openai/gpt-y')
  assert.equal(g.entree, 2.5)
  assert.equal(g.sortie, 10)
  assert.equal(g.sortieMax, 16000)
  assert.equal(g.image, true)
  assert.equal(g.fichier, true)
})

test('hébergeurs : établi en Chine = siège OU centre de données ; un nom inconnu NON VIDE rend null', () => {
  const { reduireHebergeurs, estHebergeurChinois } = require('../lib/ia/openrouter')
  const h = reduireHebergeurs(HEBERGEURS)
  assert.equal(estHebergeurChinois('Seed', h), true)
  assert.equal(estHebergeurChinois('StreamLake', h), true)
  assert.equal(estHebergeurChinois('Hors Siege', h), true, 'centre de données en Chine')
  assert.equal(estHebergeurChinois('DeepInfra', h), false)
  assert.equal(estHebergeurChinois('Nouvel Hebergeur', h), null)
  assert.equal(estHebergeurChinois('Nex AGI'), true, 'repli : sans liste, un nom chinois connu')
  assert.equal(estHebergeurChinois('Google'), null, 'repli : sans liste, on ne sait pas — pas « hors Chine »')
  assert.equal(estHebergeurChinois(null), null)
})

test('CHAMPS_UTILES du labo = celui de la lecture de production (copie tenue)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'charges', 'lecture.js'), 'utf8')
  const m = source.match(/const CHAMPS_UTILES = (\[[\s\S]*?\])/)
  assert.ok(m, 'la constante existe dans lib/charges/lecture.js')
  const prod = JSON.parse(m[1].replace(/'/g, '"'))
  assert.deepEqual(require('../lib/labo-ia').CHAMPS_UTILES, prod)
})

test('fichier : trop lourd refusé avant décodage complet ; une image PNG passe', () => {
  const L = require('../lib/labo-ia')
  const gros = Buffer.alloc(L.MAX_OCTETS_FACTURE + 10, 1).toString('base64')
  assert.equal(L.validerFichier(gros).erreur, 'fichier_trop_lourd')
  assert.equal(L.validerFichier('data:image/png;base64,' + PNG).type, 'image/png')
  assert.equal(L.validerFichier('pas du base64 !').erreur, 'fichier_illisible')
})

test('une lecture vide ou illisible est un échec, pas une facture à zéro', () => {
  const L = require('../lib/labo-ia')
  assert.deepEqual(L.lectureDeFacture('rien à lire'), { ok: false, motif: 'reponse_illisible' })
  assert.deepEqual(L.lectureDeFacture('{"fournisseur_nom": null, "montant_ttc": null}'), { ok: false, motif: 'rien_lu' })
})

test('plafonds : réglables par l’environnement, un réglage illisible garde le défaut', () => {
  const L = require('../lib/labo-ia')
  assert.deepEqual(L.plafonds({}), { usdJour: 5, usdAppel: 0.5, appelsJour: 400 })
  assert.deepEqual(L.plafonds({ LABO_IA_PLAFOND_USD: '2,5', LABO_IA_MAX_APPEL_USD: 'abc' }), { usdJour: 2.5, usdAppel: 0.5, appelsJour: 400 })
})
