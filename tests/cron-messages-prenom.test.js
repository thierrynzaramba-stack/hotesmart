// tests/cron-messages-prenom.test.js — vecu du 8 octobre 2026 : « Bonjour
// {prenom} » est parti a deux voyageurs. L'amelioration par l'IA echouait
// (credit epuise) et le repli rendait le MODELE BRUT, avant substitution.
// Regles (decision de Thierry) : un prenom manquant donne une formule neutre
// (« Bonjour, »), et AUCUNE variable {…} ne part jamais au voyageur.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'cle-test'
const test = require('node:test')
const assert = require('node:assert')

function charger (ia) {
  const incidents = []; const appels = []
  const stub = (m, exports) => { const c = require.resolve(m); require.cache[c] = { id: c, filename: c, loaded: true, exports } }
  stub('../lib/cron-shared', {
    supabase: { from: () => ({}) },
    anthropic: { messages: { create: async () => { appels.push(1); if (ia instanceof Error) throw ia; return { content: [{ text: ia }] } } } },
    getPropertyMode: async () => 'auto', lireReglagesDuBien: async () => ({ mode: 'auto', delais: null }), isAutomationPaused: async () => false,
    formatDate: d => String(d || ''),
  })
  stub('../lib/founder-notify', { reportIncident: async (type, o) => { incidents.push({ type, ...o }) } })
  delete require.cache[require.resolve('../lib/cron-messages')]
  const mod = require('../lib/cron-messages')
  return { mod, incidents, appels }
}
const credit = Object.assign(new Error('400 Your credit balance is too low'), { status: 400 })
const bien = { id: 'p1', name: 'La bulle' }
const modele = (t) => ({ event_type: 'arrival', template_text: t })

test('LE TEST QUI COMPTE : une information MANQUANTE arrete l envoi, et previent l hote', async () => {
  // ⚠ CONSTAT DE LA SECONDE REVIEW DU LOT 1, ET IL ETAIT JUSTE : aucune
  // assertion du depot ne portait sur le `return null` qui suit
  // `prevenirManque`. Supprimer cette seule ligne laissait la suite VERTE et
  // envoyait « Appelez-moi au [TÉLÉPHONE HÔTE] » au voyageur — le message
  // passant en plus par Haiku, qui peut le reformuler. On mesure donc l ARRET,
  // pas seulement l alerte.
  const { mod, incidents, appels } = charger('texte ameliore')
  const m = await mod.generateAutoMessage(
    modele('Bonjour {prenom}, appelez-moi au {telephone_hote}.'),
    { firstName: 'Carole', arrival: '2026-10-08', departure: '2026-10-10' },
    bien, 'Carole', {}, 'u1')
  assert.strictEqual(m, null, 'rien ne part quand une information manque')
  assert.equal(appels.length, 0, 'et on ne paie pas Haiku pour un message qui ne partira pas')
  assert.equal(incidents.length, 1, 'l hote est prevenu une fois')
  assert.equal(incidents[0].type, 'message_non_envoye')
  assert.match(incidents[0].detail, /Téléphone/, 'l alerte nomme l information, pas sa cle technique')
  assert.ok(!/telephone_hote/.test(incidents[0].detail.split('A renseigner')[0]),
    'la cle technique ne doit pas etre ce que l hote lit en premier')
})

test('LE TEST QUI COMPTE (lot 1b) : un modele portant {code_acces} est RETENU, et l hote le lit', async () => {
  // ⚠ AVANT LE LOT 1B, CE MESSAGE PARTAIT AU VOYAGEUR avec « [CODE À INSÉRER] »
  // en clair, apres etre passe par Haiku : la seule garde du depot vivait sur
  // le chemin de la serrure. La garde est maintenant dans le remplaceur, donc
  // sur TOUS les chemins.
  //
  // ⚠ ET ON MESURE LA TRACE, PAS SEULEMENT LE REFUS. Un envoi degrade devient
  // un envoi RETENU, et un message retenu est un message que personne ne voit
  // partir : si le refus ne laissait qu'un `console.error`, l'hote ne saurait
  // jamais que son voyageur attend. C'est la famille de defaut que ce depot
  // connait — tout sort en logs, rien n'atteint l'ecran.
  const { mod, incidents, appels } = charger('texte ameliore')
  const m = await mod.generateAutoMessage(
    modele('Bonjour {prenom}, votre code est {code_acces}.'),
    { firstName: 'Carole', arrival: '2026-10-08', departure: '2026-10-10' },
    bien, 'Carole', {}, 'u1')
  assert.strictEqual(m, null, 'rien ne part sans le code')
  assert.equal(appels.length, 0, 'et on ne paie pas Haiku pour un message retenu')
  assert.equal(incidents.length, 1, 'l hote est prevenu')
  assert.match(incidents[0].detail, /Code d'accès/, 'l alerte NOMME l information')
  assert.match(incidents[0].detail, /serrure/, 'et dit ou se corrige le defaut : le modele')
  assert.ok(!/code_acces/.test(incidents[0].detail.split('A renseigner')[0]),
    'pas de nom technique dans ce que l hote lit en premier')
})

test('et le meme message part NORMALEMENT quand l information est la', async () => {
  // La contre-epreuve de l arret : sans elle, un test qui exige `null` reste
  // vert sur un code qui ne rend JAMAIS rien.
  const { mod } = charger('texte ameliore')
  const m = await mod.generateAutoMessage(
    modele('Bonjour {prenom}, appelez-moi au {telephone_hote}.'),
    { firstName: 'Carole', arrival: '2026-10-08', departure: '2026-10-10' },
    bien, 'Carole', { telephone_hote: 'NUMERO-DE-TEST' }, 'u1')
  assert.ok(m && m.length, 'le message part quand tout est renseigne')
})

test('LE TEST QUI COMPTE (vecu du 8 octobre) : IA en panne — le texte SUBSTITUE part, jamais le modele brut', async () => {
  const { mod } = charger(credit)
  const m = await mod.generateAutoMessage(modele('Bonjour {prenom}, bienvenue au {logement} !'), { firstName: 'Carole', arrival: '2026-10-08', departure: '2026-10-10' }, bien, 'Carole X', {}, 'u1')
  assert.strictEqual(m, 'Bonjour Carole, bienvenue au La bulle !')
})

test('LE TEST QUI COMPTE : sans prenom, la formule est neutre — « Bonjour, », jamais {prenom} ni « Voyageur »', async () => {
  const { mod } = charger(credit)
  const m = await mod.generateAutoMessage(modele('Bonjour {prenom},\n\nLes codes d’accès vous seront envoyés.'), { firstName: '', arrival: '2026-10-08', departure: '2026-10-10' }, bien, 'Voyageur', {}, 'u1')
  assert.strictEqual(m, 'Bonjour,\n\nLes codes d’accès vous seront envoyés.')
})

test('une variable INCONNUE reste dans le modele : le message est RETENU, et l hote prevenu', async () => {
  const { mod, incidents, appels } = charger('Bonjour Carole')
  const m = await mod.generateAutoMessage(modele('Bonjour {prenom}, votre {parking} est réservé.'), { firstName: 'Carole', arrival: '2026-10-08', departure: '2026-10-10' }, bien, 'Carole', {}, 'u1')
  assert.strictEqual(m, null)
  assert.deepStrictEqual(incidents.map(i => i.type), ['message_non_envoye'])
  assert.match(incidents[0].detail, /\{parking\}/)
  assert.match(incidents[0].detail, /A corriger dans GuestFlow → Messages/, 'on corrige le MODELE, pas la base de connaissance')
  assert.strictEqual(appels.length, 0, 'aucun appel IA paye pour un message retenu (revue de fbd316e)')
  // Accents, chiffres, espaces : retenus aussi.
  for (const v of ['{prénom}', '{code_acces2}', '{ prenom }']) {
    assert.strictEqual(await mod.generateAutoMessage(modele(`Bonjour ${v}`), { firstName: 'Carole' }, bien, 'Carole', {}, 'u1'), null, v)
  }
})

test('une variable reintroduite par l IA ne part pas : le texte substitue la remplace', async () => {
  const { mod } = charger('Bonjour {prenom} ! Bienvenue.')
  const m = await mod.generateAutoMessage(modele('Bonjour {prenom}, bienvenue.'), { firstName: 'Carole', arrival: '2026-10-08', departure: '2026-10-10' }, bien, 'Carole', {}, 'u1')
  assert.strictEqual(m, 'Bonjour Carole, bienvenue.')
})

test('revue de fbd316e : une erreur IMPREVUE n envoie rien et PREVIENT l hote (un evenement unique ne repasse pas)', async () => {
  const { mod, incidents } = charger('x')
  const m = await mod.generateAutoMessage(modele('Bonjour {prenom}'), null, bien, 'Carole', {}, 'u1')
  assert.strictEqual(m, null)
  assert.deepStrictEqual(incidents.map(i => i.type), ['message_non_envoye'])
  assert.match(incidents[0].detail, /erreur de preparation/)
})

test('prenom neutre, partout : en tete de ligne, en milieu de phrase, et le meme moteur pour les codes d acces', () => {
  const { prenomNeutre, buildMessage } = require('../lib/message-builder')
  assert.strictEqual(prenomNeutre('{prenom}, bienvenue !', ''), 'Bienvenue !')
  assert.strictEqual(prenomNeutre('Merci {prenom} pour tout', ''), 'Merci pour tout')
  assert.strictEqual(prenomNeutre('Bonjour {prenom},', 'Ana'), 'Bonjour Ana,')
  const t = buildMessage({ template_text: 'Bonjour {prenom}, votre code : {code_acces}' }, { firstName: '' }, 'Voyageur', '1234', {})
  assert.strictEqual(t, 'Bonjour, votre code : 1234', 'jamais « Bonjour Voyageur »')
})
