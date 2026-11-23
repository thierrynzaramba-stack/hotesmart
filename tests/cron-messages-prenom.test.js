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

test('LE TEST QUI COMPTE (lot 1b) : un modele portant {code_acces} est PREPARE, pas jete', async () => {
  // ⚠ MA PREMIERE VERSION DU LOT 1B FAISAIT RENDRE `null` ICI, et c'etait une
  // REGRESSION trouvee en review : le `null` tombe avant la fourche auto/Test,
  // donc la proposition que l'hote relit et COMPLETE A LA MAIN disparaissait
  // aussi. Pour un code, c'est la seule issue : la base de connaissance ne
  // porte pas `code_acces`, et le moteur programme ne le fournit jamais.
  // La garde doit refuser l'ENVOI, pas la preparation — et c'est ce que mesure
  // ce test : le message EXISTE, marque, pret a etre complete.
  const { mod } = charger('texte ameliore')
  const m = await mod.generateAutoMessage(
    modele('Bonjour {prenom}, votre code est {code_acces}.'),
    { firstName: 'Carole', arrival: '2026-10-08', departure: '2026-10-10' },
    bien, 'Carole', {}, 'u1')
  assert.ok(m, 'le message est prepare : sans lui, l hote n a plus aucun chemin')
  assert.match(m, /\[CODE À INSÉRER\]/, 'et il porte le marqueur, que la garde d envoi reconnait')
  const { hasUnresolvedCode } = require('../lib/balises')
  assert.ok(hasUnresolvedCode(m), 'c est ce que le site d envoi consulte pour ne PAS envoyer')

  // ⚠ ET C'EST CE TEST QUI A TROUVE LE TROU : le double de l'IA rend « texte
  // ameliore », SANS marqueur. Sans la garde finale, le message perdait sa
  // marque en passant par Haiku, le site d'envoi ne voyait plus rien a bloquer,
  // et un message sans code serait parti au voyageur — par la porte meme que ce
  // lot ferme. C'est le drapeau du remplaceur qui fait foi, pas une relecture.
  assert.ok(!/texte ameliore/.test(m), 'l amelioration de l IA est ECARTEE quand elle efface le marqueur')
})

test('LE TEST QUI COMPTE : ce que l hote LIT quand un message est retenu faute de code', async () => {
  // ⚠ RIEN NE MESURAIT CETTE ALERTE — constat de review, et vider le corps de
  // la fonction laissait la suite verte. Or son `detail` est la SEULE chose que
  // l'hote voit : le message n'est pas parti, il attend, et personne d'autre ne
  // le lui dira.
  const { mod, incidents } = charger('texte ameliore')
  await mod.prevenirCodeARemplir('u1', bien,
    { event_type: 'arrival' },
    { firstName: 'Carole', lastName: 'X', arrival: '2026-10-08', departure: '2026-10-10' })
  assert.equal(incidents.length, 1)
  const d = incidents[0].detail
  assert.equal(incidents[0].type, 'message_non_envoye')
  assert.match(d, /NON ENVOYE/, 'ce qui s est passe')
  assert.match(d, /CODE D'ACCÈS/, 'l information en clair, pas sa cle technique')
  assert.match(d, /à valider/, 'ou le message attend')
  // ⚠ ET LA PHRASE QUI EVITE UNE ATTENTE INFINIE : la bascule a deja note
  // l'envoi dans `message_sent_log`, donc l'anti-doublon l'a compte. Un hote
  // qui corrige son modele et attend le cycle suivant attendrait pour toujours.
  assert.match(d, /ne repartira pas/, 'que CE message-ci ne reviendra pas')
  assert.ok(!/code_acces/.test(d), 'jamais le nom technique')
})

test('et la contre-epreuve : avec le code, l amelioration de l IA est GARDEE', async () => {
  // Sans elle, « on ecarte l IA » resterait vrai d un code qui ne manque pas,
  // et le lot aurait silencieusement supprime l amelioration pour tout le monde.
  const { mod } = charger('texte ameliore')
  const m = await mod.generateAutoMessage(
    modele('Bonjour {prenom}, bienvenue.'),
    { firstName: 'Carole', arrival: '2026-10-08', departure: '2026-10-10' },
    bien, 'Carole', {}, 'u1')
  assert.equal(m, 'texte ameliore')
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

test('le chemin de l alerte nomme le logement TEL QUEL, meme si son nom porte `$&`', async () => {
  // Review 2 du lot Accueil du voyageur, constat 4 : le remplacement par
  // fonction n'etait verifie que par une expression reguliere sur le source.
  // Avec `.replace(gabarit, nom)`, `$&` est un MOTIF : il redevient
  // « <nom du logement> » et l'hote lit un chemin qui ne mene nulle part.
  const { mod, incidents } = charger('texte ameliore')
  const m = await mod.generateAutoMessage(
    modele('Le wifi : {wifi_mdp}.'),
    { firstName: 'Carole', arrival: '2026-10-08', departure: '2026-10-10' },
    { id: 'p9', name: 'Gîte $& Co' }, 'Carole', {}, 'u1')
  assert.strictEqual(m, null)
  assert.equal(incidents.length, 1)
  assert.ok(incidents[0].detail.includes('Logements → Gîte $& Co → Accueil du voyageur'), incidents[0].detail)
})
