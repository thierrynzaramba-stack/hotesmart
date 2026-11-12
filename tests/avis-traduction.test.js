// tests/avis-traduction.test.js — le writer unique des traductions d'avis
// (lib/avis/traduction.js ; spec avis-v5 spec-traduction-avis.md).
//
// ⚠ AUCUN APPEL REEL A L'IA : le client est injecte. Aucune date lue a
// l'horloge : le temps est injecte quand il compte.

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const T = require('../lib/avis/traduction')

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex')

// ─── L'empreinte ────────────────────────────────────────────────────────────
test('l’empreinte : md5 des trois textes joints par chr(31), un texte absent vaut chaîne vide', () => {
  assert.equal(T.empreinte('a', 'b', 'c'), md5('a\u001fb\u001fc'))
  assert.equal(T.empreinte(null, undefined, 'c'), md5('\u001f\u001fc'))
  assert.notEqual(T.empreinte('ab', '', ''), T.empreinte('a', 'b', ''), 'le séparateur distingue les champs')
})

test('l’empreinte d’un avis prend le public COMME L’ÉCRAN : content_public, sinon content', () => {
  assert.equal(T.empreinteAvis({ content_public: 'P', content: 'C', content_private: 'X', ai_clean_excerpt: 'E' }), T.empreinte('P', 'X', 'E'))
  assert.equal(T.empreinteAvis({ content_public: '', content: 'C' }), T.empreinte('C', null, null))
  assert.equal(T.empreinteAvis({ content_public: null, content: null }), T.empreinte(null, null, null))
})

// ─── Les champs envoyés ─────────────────────────────────────────────────────
test('seuls les champs non vides partent ; un champ trop long ne part PAS (jamais une traduction de texte coupé)', () => {
  assert.deepEqual(T.champsDe({ texte_public: 'Great stay', texte_prive: '   ', texte_extrait: null }), { public: 'Great stay' })
  const long = 'x'.repeat(T.MAX_CARACTERES + 1)
  assert.deepEqual(T.champsDe({ texte_public: long, texte_prive: 'Weak heating' }), { prive: 'Weak heating' })
  assert.deepEqual(T.champsDe({ texte_public: 'x'.repeat(T.MAX_CARACTERES) }).public.length, T.MAX_CARACTERES)
})

test('le plafond de réponse couvre trois versions, même d’un texte en idéogrammes', () => {
  // 400 caractères chinois ≈ 1 200 à 1 400 tokens de sortie (revue, constat 2).
  assert.ok(T.maxTokensPour({ public: '很'.repeat(400) }) >= 1400)
  assert.equal(T.maxTokensPour({ public: 'x'.repeat(T.MAX_CARACTERES), prive: 'x'.repeat(T.MAX_CARACTERES), extrait: 'x'.repeat(T.MAX_CARACTERES) }), T.MAX_TOKENS)
})

// ─── La réponse du modèle ───────────────────────────────────────────────────
const CHAMPS = { public: 'Very clean flat', prive: 'Le chauffage était faible' }
const BONNE = {
  public: { source: 'en', fr: 'Appartement très propre', es: 'Piso muy limpio' },
  prive: { source: 'fr', en: 'The heating was weak', es: 'La calefacción era débil' }
}

test('une réponse valide : chaque champ porte sa langue source et les versions des AUTRES langues', () => {
  const r = T.lireReponse(JSON.stringify(BONNE), CHAMPS)
  assert.equal(r.ok, true)
  assert.deepEqual(r.textes, BONNE)
})

test('une version dans la langue source est ignorée ; un bloc ```json est accepté', () => {
  const avecSource = { ...BONNE, prive: { ...BONNE.prive, fr: 'Le chauffage était faible' } }
  const r = T.lireReponse('```json\n' + JSON.stringify(avecSource) + '\n```', CHAMPS)
  assert.equal(r.ok, true)
  assert.equal('fr' in r.textes.prive, false)
})

test('une langue source hors fr/en/es : les TROIS versions sont exigées', () => {
  const champs = { public: 'Sehr sauber' }
  assert.equal(T.lireReponse(JSON.stringify({ public: { source: 'de', fr: 'Très propre', en: 'Very clean' } }), champs).motif, 'traduction_vide')
  assert.equal(T.lireReponse(JSON.stringify({ public: { source: 'de', fr: 'Très propre', en: 'Very clean', es: 'Muy limpio' } }), champs).ok, true)
})

test('⚠ RIEN N’EST ÉCRIT SANS ÊTRE VALIDE : chaque défaut refuse la réponse entière', () => {
  const cas = [
    ['pas du JSON', 'json_illisible'],
    [JSON.stringify([1, 2]), 'json_illisible'],
    [JSON.stringify({ ...BONNE, extrait: { source: 'en', fr: 'x', es: 'y' } }), 'champ_invente'],
    [JSON.stringify({ public: BONNE.public }), 'champ_manquant'],
    [JSON.stringify({ ...BONNE, public: { ...BONNE.public, source: 'english' } }), 'langue_illisible'],
    [JSON.stringify({ ...BONNE, public: { ...BONNE.public, de: 'Sehr sauber' } }), 'langue_inventee'],
    [JSON.stringify({ ...BONNE, public: { source: 'en', fr: '  ', es: 'Piso' } }), 'traduction_vide'],
    [JSON.stringify({ ...BONNE, public: { source: 'en', fr: 'x'.repeat(5000), es: 'Piso' } }), 'traduction_trop_longue']
  ]
  for (const [brut, motif] of cas) {
    const r = T.lireReponse(brut, CHAMPS)
    assert.equal(r.ok, false, motif)
    assert.equal(r.motif, motif)
  }
})

// ─── Un appel ───────────────────────────────────────────────────────────────
function fauxClient (reponse) {
  const appels = []
  return {
    appels,
    messages: {
      async create (args) {
        appels.push(args)
        if (reponse instanceof Error) throw reponse
        return { content: [{ text: typeof reponse === 'string' ? reponse : JSON.stringify(reponse) }] }
      }
    }
  }
}
const LIGNE = { id: 'r1', user_id: 'u1', property_id_ref: '209413', booking_uid: 'b1',
  texte_public: CHAMPS.public, texte_prive: CHAMPS.prive, texte_extrait: null, empreinte: 'E1', echecs: 0 }

test('UN appel par avis, au modèle Haiku, avec les seuls champs non vides', async () => {
  const client = fauxClient(BONNE)
  const r = await T.traduireLigne(LIGNE, { anthropic: client })
  assert.equal(r.ok, true)
  assert.equal(r.appel, true)
  assert.equal(client.appels.length, 1)
  assert.equal(client.appels[0].model, T.MODELE)
  const prompt = client.appels[0].messages[0].content
  assert.match(prompt, /Very clean flat/)
  assert.doesNotMatch(prompt, /"extrait":/, 'un champ vide ne part pas')
})

test('une erreur d’API est un échec, pas une exception ; et elle compte comme un appel', async () => {
  const r = await T.traduireLigne(LIGNE, { anthropic: fauxClient(new Error('overloaded')) })
  assert.equal(r.ok, false)
  assert.equal(r.motif, 'appel_en_echec')
  assert.equal(r.appel, true)
})

test('rien à traduire : aucun appel, et une RÉUSSITE vide (la ligne sort de la file jusqu’au prochain texte)', async () => {
  const client = fauxClient(BONNE)
  const r = await T.traduireLigne({ ...LIGNE, texte_public: '\t\n', texte_prive: null }, { anthropic: client })
  assert.equal(r.appel, false)
  assert.equal(r.ok, true)
  assert.deepEqual(r.textes, {})
  assert.equal(client.appels.length, 0)
})

test('⚠ L’EXTRAIT A UNE BORNE SERRÉE : il ne peut pas porter une phrase entière du retour privé', () => {
  const champs = { extrait: 'very clean', prive: 'The heating was weak and the neighbours were noisy' }
  const fuite = { extrait: { source: 'en', fr: 'très propre — et le voisin a dit que le chauffage était faible et que les voisins étaient bruyants', es: 'muy limpio' },
    prive: { source: 'en', fr: 'Le chauffage était faible', es: 'La calefacción era débil' } }
  assert.equal(T.lireReponse(JSON.stringify(fuite), champs).motif, 'traduction_trop_longue')
  const juste = { ...fuite, extrait: { source: 'en', fr: 'très propre', es: 'muy limpio' } }
  assert.equal(T.lireReponse(JSON.stringify(juste), champs).ok, true)
})

test('⚠ un appel du cron porte sa durée maximale et AUCUNE relance ; le script, rien', async () => {
  const cron = fauxClient(BONNE)
  const opts = []
  const espion = { messages: { create: async (args, o) => { opts.push(o); return cron.messages.create(args) } } }
  await T.traduireLigne(LIGNE, { anthropic: espion, timeoutMs: 12345.6 })
  assert.deepEqual(opts[0], { timeout: 12345, maxRetries: 0 })
  await T.traduireLigne(LIGNE, { anthropic: espion })
  assert.equal(opts[1], undefined)
})

test('une réponse coupée au plafond se dit : « reponse_tronquee », pas « json_illisible »', async () => {
  const client = { messages: { create: async () => ({ stop_reason: 'max_tokens', content: [{ text: '{"public":{"source":"en","fr":"Appart' }] }) } }
  const r = await T.traduireLigne(LIGNE, { anthropic: client })
  assert.equal(r.ok, false)
  assert.equal(r.motif, 'reponse_tronquee')
  assert.equal(r.appel, true)
})

// ─── L'écriture ─────────────────────────────────────────────────────────────
function fauxSb (erreur = null) {
  const ecrits = []
  return { ecrits, from (table) { return { async upsert (payload, opts) { ecrits.push({ table, payload, opts }); return { error: erreur } } } } }
}

test('une réussite pose la traduction ET efface l’échec', async () => {
  const sb = fauxSb()
  const err = await T.ecrireResultat(sb, { ...LIGNE, echecs: 2 }, { ok: true, textes: BONNE }, { maintenant: Date.parse('2026-11-11T10:00:00Z') })
  assert.equal(err, null)
  const { table, payload, opts } = sb.ecrits[0]
  assert.equal(table, 'avis_traductions')
  assert.deepEqual(opts, { onConflict: 'review_id' })
  assert.deepEqual(payload, { review_id: 'r1', user_id: 'u1', empreinte: 'E1', textes: BONNE,
    traduit_le: '2026-11-11T10:00:00.000Z', echec_le: null, echec_empreinte: null, echecs: 0 })
})

test('les tentatives d’un lot sont notées en UNE écriture, sans toucher aux traductions', async () => {
  const sb = fauxSb()
  await T.noterTentatives(sb, [{ ...LIGNE, echecs: 0 }, { ...LIGNE, id: 'r2', empreinte: 'E2', echecs: 2 }], { maintenant: Date.parse('2026-11-11T10:00:00Z') })
  assert.equal(sb.ecrits.length, 1)
  assert.deepEqual(sb.ecrits[0].payload, [
    { review_id: 'r1', user_id: 'u1', echec_le: '2026-11-11T10:00:00.000Z', echec_empreinte: 'E1', echecs: 1 },
    { review_id: 'r2', user_id: 'u1', echec_le: '2026-11-11T10:00:00.000Z', echec_empreinte: 'E2', echecs: 3 }
  ])
  assert.equal(await T.noterTentatives(sb, []), null)
  assert.equal(sb.ecrits.length, 1, 'rien à noter : aucune écriture')
})

test('⚠ un échec ne touche PAS la dernière traduction réussie : ni textes ni empreinte dans le payload', async () => {
  const sb = fauxSb()
  await T.ecrireResultat(sb, { ...LIGNE, echecs: 2 }, { ok: false, motif: 'json_illisible' }, { maintenant: Date.parse('2026-11-11T10:00:00Z') })
  const { payload } = sb.ecrits[0]
  assert.equal('textes' in payload, false)
  assert.equal('empreinte' in payload, false)
  assert.deepEqual(payload, { review_id: 'r1', user_id: 'u1', echec_le: '2026-11-11T10:00:00.000Z', echec_empreinte: 'E1', echecs: 3 })
})

// ─── Ce que l'écran sert ────────────────────────────────────────────────────
const AVIS = { content_public: CHAMPS.public, content: null, content_private: CHAMPS.prive, ai_clean_excerpt: null }
const TRAD = { empreinte: T.empreinteAvis(AVIS), textes: BONNE }

test('l’écran reçoit, par champ, la version de SA langue — rien pour un champ déjà dans sa langue', () => {
  assert.deepEqual(T.traductionPour(AVIS, TRAD, 'fr'), { public: { source: 'en', texte: 'Appartement très propre' } })
  assert.deepEqual(T.traductionPour(AVIS, TRAD, 'en'), { prive: { source: 'fr', texte: 'The heating was weak' } })
  assert.deepEqual(T.traductionPour(AVIS, TRAD, 'es'), {
    public: { source: 'en', texte: 'Piso muy limpio' }, prive: { source: 'fr', texte: 'La calefacción era débil' }
  })
})

test('⚠ une traduction PÉRIMÉE n’est jamais servie (le texte a changé depuis)', () => {
  assert.equal(T.traductionPour({ ...AVIS, content_private: 'Le chauffage était faible, et le Wi-Fi coupé' }, TRAD, 'en'), null)
  assert.equal(T.traductionPour({ ...AVIS, ai_clean_excerpt: 'Very clean' }, TRAD, 'fr'), null)
})

test('pas de traduction, langue inconnue, tout dans la langue de lecture : null', () => {
  assert.equal(T.traductionPour(AVIS, null, 'fr'), null)
  assert.equal(T.traductionPour(AVIS, TRAD, 'de'), null)
  const avisFr = { content_public: 'Très propre', content_private: null, ai_clean_excerpt: null }
  const tradFr = { empreinte: T.empreinteAvis(avisFr), textes: { public: { source: 'fr', en: 'Very clean', es: 'Muy limpio' } } }
  assert.equal(T.traductionPour(avisFr, tradFr, 'fr'), null)
})

// ─── La migration en attente ────────────────────────────────────────────────
test('migration absente : les CODES de table et de fonction, jamais une colonne', () => {
  for (const code of ['PGRST202', 'PGRST205', '42P01', '42883']) assert.equal(T.migrationAbsente({ code }), true, code)
  assert.equal(T.migrationAbsente({ code: '42703', message: 'column does not exist' }), false)
  assert.equal(T.migrationAbsente({ code: 'PGRST204' }), false)
  assert.equal(T.migrationAbsente({ message: 'function public.avis_a_traduire(integer, timestamp with time zone, timestamp with time zone) does not exist' }), true)
  assert.equal(T.migrationAbsente({ message: 'relation "public.autre" does not exist' }), false)
  assert.equal(T.migrationAbsente(null), false)
})

// ─── Aucun écran ne traduit (condition du chef de file, 11 novembre 2026) ───
test('⚠ LES ÉCRANS LISENT, ILS NE TRADUISENT JAMAIS : aucun n’appelle l’IA ni le traducteur', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const ecrans = ['api/avis.js', 'api/ecran/avis.js', 'api/garde.js', 'api/menages-public.js',
    'lib/avis/cartes.js', 'core/avis/cartes.js', 'shared/avis-traduction.js', 'pages/avis.html', 'pages/menages.html', 'apps/menages/public.html']
  for (const f of ecrans) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
    assert.doesNotMatch(src, /traduireLigne|cron-traduction-avis|traduireAvisDus|avis_a_traduire/, f)
  }
  // Et le module des écrans n'expose que la lecture : `traductionPour` ne fait
  // aucun appel (pas de client, pas de promesse).
  assert.equal(T.traductionPour.constructor.name, 'Function', 'synchrone')
})
