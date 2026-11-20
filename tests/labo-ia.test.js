// tests/labo-ia.test.js — le Labo IA (api/labo-ia.js, lib/labo-ia.js,
// lib/ia/openrouter.js). Doc : docs/kb/labo-ia.md.
//
// ⚠ CE QUE CES TESTS GARDENT, PAR ORDRE DE COÛT D'UNE ERREUR :
//  1. LE FONDATEUR SEUL : tout autre compte est refusé AVANT toute lecture et
//     avant tout appel au modèle (une clé OpenRouter se vide en dollars).
//  2. LE CLOISONNEMENT : un bien ou un séjour d'un autre compte (ou d'un autre
//     bien) donne 404, jamais sa base ni son fil.
//  3. LA CLÉ ET LA DESTINATION : la clé ne part que vers l'adresse constante
//     d'OpenRouter, et ne revient jamais dans le journal ni dans une réponse.
//  4. LE JOURNAL : chaque tentative écrit sa ligne dans `ia_appels`, avec le
//     coût FACTURÉ par OpenRouter.
//  5. LES DONNÉES DES VOYAGEURS : `data_collection: deny` toujours ; hors de
//     Chine au premier essai ; la relance sans l'exclusion n'a lieu que sur
//     « aucun hébergeur », et elle se DIT.
//  6. RIEN N'EST ÉCRIT dans le produit : la seule écriture est le journal.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const { baseEnregistreuse } = require('./outils/base-enregistreuse')

const FONDATEUR = '85e3a0ef-75bd-4c11-a3b7-e2811067dc36'
const AUTRE = '76dd9e9e-ec14-429f-a806-0deacb5f01e4'
const EMAIL = 'fondateur@exemple.test'
const BIEN = { id: 'aa11bb22-cc33-4dd4-8ee5-ff6677889900', user_id: FONDATEUR, name: 'La bulle', provider_property_id: '209413', archive_le: null }
const BIEN_AUTRE = { id: 'bb11bb22-cc33-4dd4-8ee5-ff6677889900', user_id: AUTRE, name: 'Chez un autre', provider_property_id: '999', archive_le: null }
const CLE = 'sk-or-v1-0123456789abcdef0123456789abcdef'
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF').toString('base64')
const HEIC = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0]).toString('base64')

function doubler (chemin, exports) {
  const abs = require.resolve(chemin)
  const m = new Module(abs); m.exports = exports; m.loaded = true
  require.cache[abs] = m
}

// Une réponse OpenRouter réussie.
const REPONSE_OK = (texte = 'Oui, arrivée possible jusqu’à 23 h.') => ({
  id: 'gen-1', model: 'openai/gpt-x', provider: 'OpenAI',
  choices: [{ message: { role: 'assistant', content: texte }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 812, completion_tokens: 40, cost: 0.000731, completion_tokens_details: { reasoning_tokens: 0 }, prompt_tokens_details: { cached_tokens: 0 } }
})

/**
 * Appelle l'endpoint avec une base enregistreuse et un `fetch` enregistreur.
 * `lignes` : ce que la base rend, par table.
 */
async function appeler ({
  methode = 'GET', query = {}, corps = null, email = EMAIL, fondateur = EMAIL, cle = CLE,
  lignes = {}, compteAppels = 0, reponses = [REPONSE_OK()], statuts = [200]
} = {}) {
  const { client, requetes } = baseEnregistreuse((r) => {
    if (r.table === 'ia_appels' && r.op === 'select') return { data: null, error: null, count: compteAppels }
    if (r.op !== 'select') return { data: null, error: null }
    return { data: lignes[r.table] || [], error: null }
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
      return { ok: true, userId: FONDATEUR, accountUserId: FONDATEUR, email }
    }
  })
  doubler('../lib/cron-classify', {
    buildKnowledgeText: (k) => (k || []).map(x => `${x.key} : ${x.value}`).join('\n'),
    loadPromptingInstructions: async () => ({ global: 'Signer Thierry', propertyOverride: '' })
  })
  const appels = []
  const vraiFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    const i = appels.length
    appels.push({ url, opts, corps: opts && opts.body ? JSON.parse(opts.body) : null })
    const statut = statuts[Math.min(i, statuts.length - 1)]
    const json = reponses[Math.min(i, reponses.length - 1)]
    return { ok: statut >= 200 && statut < 300, status: statut, json: async () => json }
  }
  const avant = { cle: process.env.OPENROUTER_API_KEY, fondateur: process.env.FOUNDER_EMAIL }
  if (cle === null) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = cle
  if (fondateur === null) delete process.env.FOUNDER_EMAIL; else process.env.FOUNDER_EMAIL = fondateur

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
    await endpoint({ method: methode, headers: {}, query, body: corps }, res)
  } finally {
    require.cache[absSdk].exports.createClient = vraiCreate
    globalThis.fetch = vraiFetch
    if (avant.cle === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = avant.cle
    if (avant.fondateur === undefined) delete process.env.FOUNDER_EMAIL; else process.env.FOUNDER_EMAIL = avant.fondateur
    delete require.cache[abs]
    delete require.cache[require.resolve('../lib/require-permission')]
    delete require.cache[require.resolve('../lib/cron-classify')]
  }
  const ecritures = requetes.filter(r => r.op !== 'select')
  return { ...rep, requetes, ecritures, appels, gardes }
}

const filtre = (r, col) => (r.filtres.find(f => f[0] === 'eq' && f[1] === col) || [])[2]

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
    { methode: 'POST', corps: { action: 'question', modele: 'openai/gpt-x', bien: BIEN.id, question: 'Bonjour ?' } },
    { methode: 'POST', corps: { action: 'facture', modele: 'openai/gpt-x', fichier: PDF } }
  ]) {
    const r = await appeler({ ...req, email: 'hote@ailleurs.test', lignes: { properties: [BIEN] } })
    assert.equal(r.statut, 403, JSON.stringify(req))
    assert.equal(r.requetes.length, 0)
    assert.equal(r.appels.length, 0)
  }
})

test('FOUNDER_EMAIL absent : refus qui dit sa cause, sans lecture', async () => {
  const r = await appeler({ query: { action: 'biens' }, fondateur: null })
  assert.equal(r.statut, 403)
  assert.equal(r.charge.motif, 'FOUNDER_EMAIL absent de la configuration')
  assert.equal(r.requetes.length, 0)
})

test('la garde est celle du compte PROPRE (`titulaire` sans ressource) : un compte basculé est refusé par elle', async () => {
  const r = await appeler({ query: { action: 'biens' } })
  assert.equal(r.statut, 200)
  assert.deepEqual(r.gardes, [{ domaine: 'titulaire' }])
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
  assert.equal(filtre(q, 'user_id'), FONDATEUR)
  assert.ok(q.filtres.some(f => f[0] === 'is' && f[1] === 'archive_le' && f[2] === null))
})

test('LE TEST QUI COMPTE : un bien d’un autre compte -> 404, et ni base ni fil ni modèle', async () => {
  const r = await appeler({
    methode: 'POST',
    corps: { action: 'question', modele: 'openai/gpt-x', bien: BIEN_AUTRE.id, question: 'Code de la porte ?' },
    lignes: { properties: [BIEN_AUTRE], knowledge: [{ user_id: AUTRE, property_id: '999', key: 'code', value: '4242' }] }
  })
  assert.equal(r.statut, 404)
  assert.equal(r.appels.length, 0)
  assert.ok(!r.requetes.some(x => x.table === 'knowledge' || x.table === 'messages'))
})

test('un séjour d’un AUTRE bien du même compte -> 404, sans appel au modèle', async () => {
  const r = await appeler({
    methode: 'POST',
    corps: { action: 'question', modele: 'openai/gpt-x', bien: BIEN.id, booking: 'B9', question: 'Que répondre ?' },
    lignes: {
      properties: [BIEN],
      bookings_snapshot: [{ user_id: FONDATEUR, booking_id: 'B9', property_id: 'AUTRE-BIEN', snapshot: { firstName: 'Zoé' } }],
      messages: []
    }
  })
  assert.equal(r.statut, 404)
  assert.equal(r.appels.length, 0)
})

test('conversations : lues sur le compte ET la référence provider du bien (règle 10), « unknown » écarté', async () => {
  const r = await appeler({
    query: { action: 'conversations', bien: BIEN.id },
    lignes: {
      properties: [BIEN],
      messages: [
        { user_id: FONDATEUR, property_id: '209413', booking_id: 'B1', direction: 'inbound', sent_at: '2026-11-19T10:00:00Z' },
        { user_id: FONDATEUR, property_id: '209413', booking_id: 'unknown', direction: 'inbound', sent_at: '2026-11-18T10:00:00Z' },
        { user_id: FONDATEUR, property_id: '209413', booking_id: 'B1', direction: 'outbound', sent_at: '2026-11-17T10:00:00Z' }
      ],
      bookings_snapshot: [{ user_id: FONDATEUR, booking_id: 'B1', snapshot: { firstName: 'Anna', lastName: 'K', arrival: '2026-12-01', departure: '2026-12-04' } }]
    }
  })
  assert.equal(r.statut, 200)
  assert.deepEqual(r.charge.conversations.map(c => [c.bookingId, c.voyageur, c.messages, c.duVoyageur]), [['B1', 'Anna K', 2, 1]])
  const q = r.requetes.find(x => x.table === 'messages')
  assert.equal(filtre(q, 'user_id'), FONDATEUR)
  assert.equal(filtre(q, 'property_id'), '209413')
  const s = r.requetes.find(x => x.table === 'bookings_snapshot')
  assert.equal(filtre(s, 'user_id'), FONDATEUR)
})

// ─── 3 à 6. L'essai « question » ────────────────────────────────────────────

const LIGNES_QUESTION = {
  properties: [BIEN],
  knowledge: [{ user_id: FONDATEUR, property_id: '209413', key: 'Arrivée', value: 'à partir de 16 h, boîte à clé' }],
  bookings_snapshot: [{ user_id: FONDATEUR, booking_id: 'B1', property_id: '209413', snapshot: { firstName: 'Anna', arrival: '2026-12-01', departure: '2026-12-04' } }],
  messages: [
    { user_id: FONDATEUR, property_id: '209413', booking_id: 'B1', direction: 'inbound', kind: 'message', body: 'Can I arrive at 11pm?', sent_at: '2026-11-19T10:00:00Z' },
    { user_id: FONDATEUR, property_id: '209413', booking_id: 'B1', direction: 'outbound', kind: 'auto', body: 'Bienvenue !', sent_at: '2026-11-18T10:00:00Z' }
  ]
}

test('LE TEST QUI COMPTE : la question part vers l’adresse CONSTANTE, avec la base, le fil, et `data_collection: deny` hors de Chine', async () => {
  const r = await appeler({
    methode: 'POST',
    corps: { action: 'question', modele: 'openai/gpt-x', bien: BIEN.id, booking: 'B1', question: 'Que lui répondre ?' },
    lignes: LIGNES_QUESTION
  })
  assert.equal(r.statut, 200, JSON.stringify(r.charge))
  assert.equal(r.appels.length, 1)
  const a = r.appels[0]
  assert.equal(a.url, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(a.opts.headers.Authorization, `Bearer ${CLE}`)
  assert.equal(a.corps.model, 'openai/gpt-x')
  assert.equal(a.corps.provider.data_collection, 'deny')
  assert.ok(a.corps.provider.ignore.includes('deepseek') && a.corps.provider.ignore.includes('moonshotai'))
  const systeme = a.corps.messages[0].content
  assert.match(systeme, /à partir de 16 h, boîte à clé/)
  assert.match(systeme, /\[VOYAGEUR\] Can I arrive at 11pm\?/)
  assert.match(systeme, /\[MESSAGE AUTOMATIQUE\] Bienvenue !\n\[VOYAGEUR\]/, 'le fil est remis à l’endroit')
  assert.match(systeme, /Signer Thierry/)
  assert.deepEqual(a.corps.messages[1], { role: 'user', content: 'Que lui répondre ?' })
  // Lectures cloisonnées : compte ET référence provider.
  for (const t of ['knowledge', 'messages']) {
    const q = r.requetes.find(x => x.table === t)
    assert.equal(filtre(q, 'user_id'), FONDATEUR, t)
    assert.equal(filtre(q, 'property_id'), '209413', t)
  }
  // La réponse : texte, coût FACTURÉ, hébergeur.
  assert.equal(r.charge.texte, 'Oui, arrivée possible jusqu’à 23 h.')
  assert.equal(r.charge.coutUsd, 0.000731)
  assert.equal(r.charge.hebergeur, 'OpenAI')
  assert.equal(r.charge.enChine, false)
  assert.equal(r.charge.restrictionLevee, false)
  assert.ok(!JSON.stringify(r.charge).includes(CLE), 'la clé ne revient jamais')
})

test('LE TEST QUI COMPTE : la SEULE écriture est la ligne du journal, avec le coût facturé et l’étiquette du labo', async () => {
  const r = await appeler({
    methode: 'POST',
    corps: { action: 'question', modele: 'openai/gpt-x', bien: BIEN.id, booking: 'B1', question: 'Que lui répondre ?' },
    lignes: LIGNES_QUESTION
  })
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
  const r = await appeler({ methode: 'POST', cle: null, corps: { action: 'question', modele: 'openai/gpt-x', bien: BIEN.id, question: 'Bonjour ?' }, lignes: LIGNES_QUESTION })
  assert.equal(r.statut, 503)
  assert.equal(r.charge.error, 'cle_absente')
  assert.equal(r.appels.length, 0)
  assert.equal(r.ecritures.length, 0)
})

test('plafond du jour atteint -> 429, sans appel', async () => {
  const r = await appeler({ methode: 'POST', compteAppels: 400, corps: { action: 'question', modele: 'openai/gpt-x', bien: BIEN.id, question: 'Bonjour ?' }, lignes: LIGNES_QUESTION })
  assert.equal(r.statut, 429)
  assert.equal(r.appels.length, 0)
  const q = r.requetes.find(x => x.table === 'ia_appels')
  assert.equal(filtre(q, 'user_id'), FONDATEUR)
})

test('un identifiant de modèle qui n’en est pas un (URL, chemin) -> 400, sans appel', async () => {
  for (const modele of ['https://evil.test/x', '../../etc', 'openai/gpt x', '']) {
    const r = await appeler({ methode: 'POST', corps: { action: 'question', modele, bien: BIEN.id, question: 'Bonjour ?' }, lignes: LIGNES_QUESTION })
    assert.equal(r.statut, 400, modele)
    assert.equal(r.appels.length, 0)
  }
})

test('« aucun hébergeur hors Chine » : relance SANS l’exclusion, et la réponse le dit', async () => {
  const r = await appeler({
    methode: 'POST',
    corps: { action: 'question', modele: 'moonshotai/kimi-x', bien: BIEN.id, question: 'Bonjour ?' },
    lignes: LIGNES_QUESTION,
    statuts: [404, 200],
    reponses: [{ error: { code: 404, message: 'No allowed providers are available for the selected model.' } }, { ...REPONSE_OK('Bonjour'), provider: 'Moonshot AI' }]
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

test('une panne ordinaire (« Provider returned error ») ne lève PAS l’exclusion', async () => {
  const r = await appeler({
    methode: 'POST',
    corps: { action: 'question', modele: 'qwen/qwen-x', bien: BIEN.id, question: 'Bonjour ?' },
    lignes: LIGNES_QUESTION,
    statuts: [400],
    reponses: [{ error: { code: 400, message: 'Provider returned error' } }]
  })
  assert.equal(r.statut, 502)
  assert.equal(r.appels.length, 1)
})

test('une erreur qui recopie la clé : masquée dans la réponse ET dans le journal', async () => {
  const r = await appeler({
    methode: 'POST',
    corps: { action: 'question', modele: 'openai/gpt-x', bien: BIEN.id, question: 'Bonjour ?' },
    lignes: LIGNES_QUESTION,
    statuts: [401],
    reponses: [{ error: { code: 401, message: `Invalid key ${CLE}` } }]
  })
  assert.equal(r.statut, 502)
  assert.ok(!JSON.stringify(r.charge).includes(CLE))
  assert.ok(!JSON.stringify(r.ecritures).includes(CLE))
  assert.match(r.charge.message, /<masque>/)
})

// ─── L'essai « facture » ────────────────────────────────────────────────────

test('facture : le PDF part avec la consigne du compte de charges, et la lecture revient normalisée', async () => {
  const json = JSON.stringify({ fournisseur_nom: 'EDF', numero_facture: 'F-12', date_facture: '2026-10-02', montant_ht: 100, montant_tva: 20, montant_ttc: 120, categorie: 'energie', type_document: 'facture' })
  const r = await appeler({ methode: 'POST', corps: { action: 'facture', modele: 'google/gemini-x', fichier: PDF }, reponses: [REPONSE_OK('Voici : ' + json)] })
  assert.equal(r.statut, 200, JSON.stringify(r.charge))
  const contenu = r.appels[0].corps.messages[0].content
  assert.equal(contenu[0].text, require('../lib/charges/lecture').CONSIGNE)
  assert.equal(contenu[1].type, 'file')
  assert.match(contenu[1].file.file_data, /^data:application\/pdf;base64,/)
  assert.equal(r.charge.lecture.ok, true)
  assert.equal(r.charge.lecture.lu.montant_ttc_cents, 12000)
  assert.equal(r.charge.lecture.lu.fournisseur_nom, 'EDF')
  assert.deepEqual(r.ecritures.map(e => [e.table, e.charge.fonction]), [['ia_appels', 'labo-ia-facture']])
  assert.equal(r.ecritures[0].charge.booking_id, null, 'une facture n’est pas un séjour')
})

test('facture : le type se lit dans les OCTETS — un HEIC est refusé, sans appel', async () => {
  const r = await appeler({ methode: 'POST', corps: { action: 'facture', modele: 'google/gemini-x', fichier: HEIC } })
  assert.equal(r.statut, 400)
  assert.equal(r.charge.error, 'type_non_pris')
  assert.equal(r.appels.length, 0)
})

// ─── Les règles pures ───────────────────────────────────────────────────────

test('catalogue : prix par million, routeurs, variantes gratuites et sorties non textuelles écartés', () => {
  const { reduireCatalogue } = require('../lib/ia/openrouter')
  const c = reduireCatalogue({
    data: [
      { id: 'openai/gpt-x', name: 'GPT X', created: 2, context_length: 128000, pricing: { prompt: '0.0000025', completion: '0.00001' }, architecture: { input_modalities: ['text', 'image', 'file'], output_modalities: ['text'] } },
      { id: 'openrouter/auto', name: 'Auto', pricing: { prompt: '-1', completion: '-1' } },
      { id: 'meta/llama:free', name: 'Free', pricing: { prompt: '0', completion: '0' } },
      { id: 'img/gen', name: 'Image', pricing: { prompt: '0.000001', completion: '0.000001' }, architecture: { output_modalities: ['image'] } },
      { id: 'deepseek/v4', name: 'DS', created: 3, pricing: { prompt: '0.0000003', completion: '0.0000012' }, architecture: { input_modalities: ['text'] } }
    ]
  })
  assert.deepEqual(c.map(m => m.id), ['deepseek/v4', 'openai/gpt-x'])
  const g = c.find(m => m.id === 'openai/gpt-x')
  assert.equal(g.entree, 2.5)
  assert.equal(g.sortie, 10)
  assert.equal(g.image, true)
  assert.equal(g.fichier, true)
})

test('hébergeur chinois : reconnu par son nom, inconnu = null (jamais « hors Chine » par défaut)', () => {
  const { estHebergeurChinois } = require('../lib/ia/openrouter')
  assert.equal(estHebergeurChinois('DeepSeek'), true)
  assert.equal(estHebergeurChinois('Moonshot AI'), true)
  assert.equal(estHebergeurChinois('Z.AI'), true)
  assert.equal(estHebergeurChinois('Google'), false)
  assert.equal(estHebergeurChinois(null), null)
})

test('fichier : trop lourd refusé avant décodage complet ; une image PNG passe', () => {
  const L = require('../lib/labo-ia')
  const gros = Buffer.alloc(L.MAX_OCTETS_FACTURE + 10, 1).toString('base64')
  assert.equal(L.validerFichier(gros).erreur, 'fichier_trop_lourd')
  const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0]).toString('base64')
  assert.equal(L.validerFichier('data:image/png;base64,' + png).type, 'image/png')
  assert.equal(L.validerFichier('pas du base64 !').erreur, 'fichier_illisible')
})

test('une lecture vide ou illisible est un échec, pas une facture à zéro', () => {
  const L = require('../lib/labo-ia')
  assert.deepEqual(L.lectureDeFacture('rien à lire'), { ok: false, motif: 'reponse_illisible' })
  assert.deepEqual(L.lectureDeFacture('{"fournisseur_nom": null, "montant_ttc": null}'), { ok: false, motif: 'rien_lu' })
})
