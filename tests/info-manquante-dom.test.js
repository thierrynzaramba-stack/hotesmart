// tests/info-manquante-dom.test.js — la carte « Information manquante » et le
// bouton « IA », dans la VRAIE page (spec-info-manquante-choix.md, étape 1).
//
// Banc : tests/outils/banc-messages.js — le vrai module de pages/messages.html
// dans un vrai DOM, le réseau doublé au niveau de `fetch`.
//
// ⚠ CE QUE CES TESTS GARDENT, PAR ORDRE DE COÛT D'UNE ERREUR :
//  1. RIEN NE PART SANS « ENVOYER » : la rédaction remplit la saisie, jamais
//     un canal. Chaque test compte les appels d'envoi.
//  2. LE TEXTE D'UN VOYAGEUR NE VA PAS CHEZ UN AUTRE : une rédaction qui
//     revient après un changement de fil est jetée ; le texte rédigé est
//     marqué pour son fil.
//  3. La tâche se clôt APRÈS l'envoi réussi de la réponse née de la carte, et
//     seulement elle.

const test = require('node:test')
const assert = require('node:assert/strict')
const B = require('./outils/banc-messages')

const MIN = 60000
const il = (ms) => new Date(Date.now() - ms).toISOString()
const jour = (d) => new Date(Date.now() + d * 86400000).toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' })
const QUESTIONS = ['Puis-je venir avec un chien ?', 'Puis-je garer ma moto dans l’appartement ?']
const INFO = { id: 'ti1', book_id: 'B1', property_id: '209413', created_at: il(20 * MIN), maj: il(15 * MIN), questions: QUESTIONS }
const entrant = (body, sent_at) => ({ sender: 'guest', direction: 'inbound', body, sent_at, kind: 'message', origine: null })
const conv = (bookId, messages, extra = {}) => ({
  bookId, propertyId: '209413', provider: 'beds24', ota: 'Airbnb', platform: 'airbnb',
  guestName: 'Ana Lopez', firstNight: jour(0), lastNight: jour(3), status: 'confirmed',
  messages, lastTime: messages.length ? messages[messages.length - 1].sent_at : null, ...extra
})
const REDIGE = 'Hello Ana, yes for the dog! The motorbike: there is a garage 200 m away.'

function differe () {
  let resoudre
  const p = new Promise(r => { resoudre = r })
  return { p, resoudre }
}

function monter ({ conversations = [conv('B1', [entrant('Can I come with my dog?', il(25 * MIN))])], infos = [INFO],
  ecriture = true, repondre = () => ({}) } = {}) {
  const appels = []
  const banc = B.monter({ ecriture, appel: async (chemin, corps) => {
    appels.push({ chemin, corps })
    if (chemin.startsWith('/api/messages?direct=1')) return { messages: [], taches: [], infos, dernier: null, complet: true }
    return repondre(chemin, corps)
  } })
  // jsdom ne dit pas l'onglet « visible » : la relecture en direct n'en part
  // pas sans ça (même geste que tests/messages-direct-dom.test.js).
  Object.defineProperty(banc.doc, 'visibilityState', { configurable: true, get: () => 'visible' })
  const { msg } = banc
  msg.etat.conversations = conversations
  msg.etat.taches = []
  msg.indexerTaches()
  msg.etat.ouverte = 'B1'
  msg.etat.luLe = il(20000)
  msg.renderListe(); msg.renderFil()
  return {
    banc, msg, appels, doc: banc.doc,
    carte: () => banc.doc.querySelector('[data-list="fil"] [data-bind="info-carte"]'),
    zone: () => banc.doc.querySelector('[data-bind="texte"]'),
    redactions: () => appels.filter(a => a.chemin === '/api/guestflow-rediger'),
    envois: () => appels.filter(a => a.chemin === '/api/beds24' || a.chemin === '/api/channel-message'),
    clotures: () => appels.filter(a => a.chemin === '/api/messages' && a.corps && a.corps.action === 'info_traitee'),
    fermer: () => { banc.window.clearTimeout(msg.direct.minuteur); banc.fermer() }
  }
}
const cliquer = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }))
const choix = (v, i, r) => cliquer(v.carte().querySelector(`[data-info-choix="${i}"][data-info-reponse="${r}"]`))
const taper = (champ, texte) => { champ.value = texte; champ.dispatchEvent(new champ.ownerDocument.defaultView.Event('input', { bubbles: true })) }
const attendre = () => new Promise(r => setTimeout(r, 0))

test('la carte arrive par le fil en direct : une ligne par question, Oui / Non / Autre, et jamais une proposition', async () => {
  const v = monter()
  try {
    assert.equal(v.carte(), null, 'pas de carte avant la relecture')
    await v.msg.relireDirect()
    const carte = v.carte()
    assert.ok(carte, 'la carte est la')
    const lignes = [...carte.querySelectorAll('.info-carte__q')]
    assert.deepEqual(lignes.map(l => l.querySelector('span').textContent), QUESTIONS)
    for (const l of lignes) assert.deepEqual([...l.querySelectorAll('[data-info-reponse]')].map(b => b.textContent), ['Oui', 'Non', 'Autre'])
    assert.equal(v.doc.querySelector('[data-list="fil"] [data-envoyer-prop]'), null, 'une info manquante ne devient jamais une proposition')
    assert.equal(carte.querySelector('[data-info-rediger]').disabled, true, 'Rediger attend un choix par question')
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : Rediger -> le texte arrive dans la saisie, RIEN ne part, la question renvoyee est celle de la carte', async () => {
  const v = monter({ repondre: (chemin) => chemin === '/api/guestflow-rediger' ? { ok: true, texte: REDIGE } : {} })
  try {
    await v.msg.relireDirect()
    choix(v, 0, 'oui')
    choix(v, 1, 'autre')
    assert.equal(v.carte().querySelector('[data-info-rediger]').disabled, true, 'Autre sans precision')
    const champ = v.carte().querySelector('[data-info-precision="1"]')
    assert.ok(champ, 'Autre ouvre le champ de precision')
    taper(champ, 'garage a 200 m')
    assert.equal(v.carte().querySelector('[data-info-rediger]').disabled, false)
    cliquer(v.carte().querySelector('[data-info-rediger]'))
    await attendre(); await attendre()
    assert.equal(v.redactions().length, 1)
    assert.deepEqual(v.redactions()[0].corps, {
      action: 'choix', bookingId: 'B1', tacheId: 'ti1',
      choix: [{ question: QUESTIONS[0], reponse: 'oui' }, { question: QUESTIONS[1], reponse: 'autre', precision: 'garage a 200 m' }]
    })
    assert.equal(v.zone().value, REDIGE)
    assert.equal(v.envois().length, 0, 'un message est parti sans « Envoyer »')
    assert.equal(v.clotures().length, 0, 'la tache est close avant l envoi')
    assert.match(v.doc.querySelector('[data-bind="info-etat"]').textContent, /relisez-la, puis envoyez/)
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : l envoi de la reponse redigee clot la tache, APRES l envoi reussi, et la carte disparait', async () => {
  const v = monter({ repondre: (chemin) => chemin === '/api/guestflow-rediger' ? { ok: true, texte: REDIGE } : { ok: true } })
  try {
    await v.msg.relireDirect()
    choix(v, 0, 'oui'); choix(v, 1, 'non')
    cliquer(v.carte().querySelector('[data-info-rediger]'))
    await attendre(); await attendre()
    await v.msg.envoyer()
    await attendre(); await attendre()
    assert.equal(v.envois().length, 1, 'le message part par le chemin d envoi existant')
    assert.equal(v.envois()[0].corps.message, REDIGE)
    assert.deepEqual(v.clotures().map(a => a.corps), [{ action: 'info_traitee', task_id: 'ti1', maj: INFO.maj, booking_id: 'B1' }],
      'la cloture porte la VERSION de la tache sur laquelle l hote a tranche, et son sejour')
    const iEnvoi = v.appels.indexOf(v.envois()[0]), iCloture = v.appels.indexOf(v.clotures()[0])
    assert.ok(iEnvoi < iCloture, 'la cloture est partie avant l envoi')
    assert.equal(v.carte(), null, 'la carte reste apres la reponse')
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : un envoi qui echoue ne clot rien ; « Reessayer » reussi clot', async () => {
  let echouer = true
  const v = monter({ repondre: (chemin) => chemin === '/api/guestflow-rediger' ? { ok: true, texte: REDIGE }
    : chemin === '/api/beds24' && echouer ? { __statut: 502, __corps: { error: 'canal' } } : { ok: true } })
  try {
    await v.msg.relireDirect()
    choix(v, 0, 'oui'); choix(v, 1, 'non')
    cliquer(v.carte().querySelector('[data-info-rediger]'))
    await attendre(); await attendre()
    await v.msg.envoyer()
    await attendre(); await attendre()
    assert.equal(v.clotures().length, 0, 'un envoi en echec a clos la tache')
    echouer = false
    cliquer(v.doc.querySelector('[data-list="fil"] [data-reessayer]'))
    await attendre(); await attendre()
    assert.equal(v.clotures().length, 1)
  } finally { v.fermer() }
})

test('un message envoye SANS passer par la carte ne clot rien', async () => {
  const v = monter({ repondre: () => ({ ok: true }) })
  try {
    await v.msg.relireDirect()
    v.zone().value = 'Je regarde et je reviens vers vous'
    await v.msg.envoyer()
    await attendre(); await attendre()
    assert.equal(v.envois().length, 1)
    assert.equal(v.clotures().length, 0)
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : la redaction revient apres un changement de fil -> jetee, la saisie de l autre voyageur reste vide', async () => {
  const d = differe()
  const v = monter({
    conversations: [conv('B1', [entrant('Can I come with my dog?', il(25 * MIN))]), conv('B2', [entrant('Hola', il(30 * MIN))], { guestName: 'Marie' })],
    repondre: (chemin) => chemin === '/api/guestflow-rediger' ? d.p : {}
  })
  try {
    await v.msg.relireDirect()
    choix(v, 0, 'oui'); choix(v, 1, 'non')
    cliquer(v.carte().querySelector('[data-info-rediger]'))
    await attendre()
    v.msg.ouvrir('B2')
    d.resoudre({ ok: true, texte: REDIGE })
    await attendre(); await attendre()
    assert.equal(v.zone().value, '', 'le texte ecrit pour Ana est dans la saisie de Marie')
    await v.msg.envoyer()
    assert.equal(v.envois().length, 0)
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : le texte redige est marque pour son fil — changer de fil le retire, il ne part pas ailleurs', async () => {
  const v = monter({
    conversations: [conv('B1', [entrant('Can I come with my dog?', il(25 * MIN))]), conv('B2', [entrant('Hola', il(30 * MIN))], { guestName: 'Marie' })],
    repondre: (chemin) => chemin === '/api/guestflow-rediger' ? { ok: true, texte: REDIGE } : { ok: true }
  })
  try {
    await v.msg.relireDirect()
    choix(v, 0, 'oui'); choix(v, 1, 'non')
    cliquer(v.carte().querySelector('[data-info-rediger]'))
    await attendre(); await attendre()
    assert.equal(v.zone().value, REDIGE)
    v.msg.ouvrir('B2')
    assert.equal(v.zone().value, '', 'le texte d Ana a suivi chez Marie')
    // Et l'engagement reste au fil d'Ana : un envoi chez Marie ne clot rien.
    v.zone().value = 'Hola Marie'
    await v.msg.envoyer()
    await attendre(); await attendre()
    assert.equal(v.clotures().length, 0)
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : la saisie remplie pour un AUTRE voyageur pendant la redaction -> la reponse ne s y ajoute pas, rien ne part (review 1, constat 1)', async () => {
  const d = differe()
  const v = monter({
    conversations: [conv('B1', [entrant('Can I come with my dog?', il(25 * MIN))]), conv('B2', [entrant('Hola', il(30 * MIN))], { guestName: 'Marie' })],
    repondre: (chemin) => chemin === '/api/guestflow-rediger' ? d.p : { ok: true }
  })
  try {
    await v.msg.relireDirect()
    choix(v, 0, 'oui'); choix(v, 1, 'non')
    cliquer(v.carte().querySelector('[data-info-rediger]'))
    await attendre()
    // Chez Marie : « Utiliser » son wifi, puis une retouche ; retour chez Ana.
    // Le texte reste dans la saisie, marque pour Marie (rangerSaisieRemplie).
    v.msg.ouvrir('B2')
    v.zone().value = 'Bonjour Marie, WIFI DE MARIE : xyz'
    v.msg.etat.saisieRemplie = { bookId: 'B2', textes: ['WIFI DE MARIE : xyz'] }
    v.msg.ouvrir('B1')
    assert.equal(v.zone().value, 'Bonjour Marie, WIFI DE MARIE : xyz', 'jeu d essai : le texte de Marie reste, marque')
    d.resoudre({ ok: true, texte: REDIGE })
    await attendre(); await attendre()
    assert.equal(v.zone().value, 'Bonjour Marie, WIFI DE MARIE : xyz', 'la reponse d Ana s est ajoutee au texte de Marie')
    assert.equal(v.msg.etat.saisieRemplie.bookId, 'B2', 'la marque de Marie a ete reprise pour Ana')
    await v.msg.envoyer()
    await attendre()
    assert.equal(v.envois().length, 0, 'le wifi de Marie est parti chez Ana')
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : un texte TAPE (sans marque) chez un autre voyageur pendant la redaction -> la reponse est jetee, et on le dit (review 2, constat 1)', async () => {
  const d = differe()
  const v = monter({
    conversations: [conv('B1', [entrant('Can I come with my dog?', il(25 * MIN))]), conv('B2', [entrant('Hola', il(30 * MIN))], { guestName: 'Marie' })],
    repondre: (chemin) => chemin === '/api/guestflow-rediger' ? d.p : { ok: true }
  })
  try {
    await v.msg.relireDirect()
    choix(v, 0, 'oui'); choix(v, 1, 'non')
    cliquer(v.carte().querySelector('[data-info-rediger]'))
    await attendre()
    v.msg.ouvrir('B2')
    v.zone().value = 'Bonjour Marie, le code du portail est 4321'
    v.msg.ouvrir('B1')
    d.resoudre({ ok: true, texte: REDIGE })
    await attendre(); await attendre()
    assert.equal(v.zone().value, 'Bonjour Marie, le code du portail est 4321', 'la reponse d Ana a enrobe le texte de Marie')
    assert.notEqual(v.msg.etat.saisieRemplie && v.msg.etat.saisieRemplie.bookId, 'B1', 'le texte de Marie a pris la marque d Ana')
    assert.match(v.doc.querySelector('[data-bind="info-etat"]').textContent, /changé de conversation/)
    assert.equal(v.msg.etat.infoEngagee, undefined, 'l envoi suivant clorait la tache')
  } finally { v.fermer() }
})

test('un simple coup d oeil a un autre fil, saisie intacte, ne coute rien : la reponse arrive', async () => {
  const d = differe()
  const v = monter({
    conversations: [conv('B1', [entrant('Can I come with my dog?', il(25 * MIN))]), conv('B2', [entrant('Hola', il(30 * MIN))], { guestName: 'Marie' })],
    repondre: (chemin) => chemin === '/api/guestflow-rediger' ? d.p : { ok: true }
  })
  try {
    await v.msg.relireDirect()
    choix(v, 0, 'oui'); choix(v, 1, 'non')
    cliquer(v.carte().querySelector('[data-info-rediger]'))
    await attendre()
    v.msg.ouvrir('B2')
    v.msg.ouvrir('B1')
    d.resoudre({ ok: true, texte: REDIGE })
    await attendre(); await attendre()
    assert.equal(v.zone().value, REDIGE)
  } finally { v.fermer() }
})

test('« IA » : une frappe apres le retour dans le fil jette la version redigee, et on le dit (review 2, constat 5)', async () => {
  const d = differe()
  const v = monter({
    conversations: [conv('B1', [entrant('Can I come?', il(25 * MIN))]), conv('B2', [entrant('Hola', il(30 * MIN))], { guestName: 'Marie' })],
    repondre: (chemin) => chemin === '/api/guestflow-rediger' ? d.p : {}
  })
  try {
    v.zone().value = 'oui chien'
    const enCours = v.msg.redigerBrouillon()
    await attendre()
    v.msg.ouvrir('B2'); v.msg.ouvrir('B1')
    v.zone().value = 'oui chien, et le parking ?'
    d.resoudre({ ok: true, texte: REDIGE })
    await enCours
    assert.equal(v.zone().value, 'oui chien, et le parking ?')
    assert.match(v.doc.querySelector('[data-bind="info-etat"]').textContent, /changé de conversation/)
  } finally { v.fermer() }
})

test('« IA » : la saisie marquee pour un AUTRE fil au retour -> la version redigee ne s y pose pas (review 2, constat 3)', async () => {
  const d = differe()
  const v = monter({ repondre: (chemin) => chemin === '/api/guestflow-rediger' ? d.p : {} })
  try {
    v.zone().value = 'oui chien'
    const enCours = v.msg.redigerBrouillon()
    await attendre()
    // Le meme texte, mais marque pour Marie (chemin rare, garde de ceinture).
    v.msg.etat.saisieRemplie = { bookId: 'B2', textes: ['oui chien'] }
    d.resoudre({ ok: true, texte: REDIGE })
    await enCours
    assert.equal(v.zone().value, 'oui chien')
    assert.equal(v.msg.etat.saisieRemplie.bookId, 'B2')
  } finally { v.fermer() }
})

test('la reponse est partie mais la tache a change -> la cloture refusee se DIT dans le fil (review 2, constat 4)', async () => {
  const v = monter({ repondre: (chemin, corps) => chemin === '/api/guestflow-rediger' ? { ok: true, texte: REDIGE }
    : chemin === '/api/messages' && corps && corps.action === 'info_traitee' ? { __statut: 409, __corps: { error: 'questions_changees' } } : { ok: true } })
  try {
    await v.msg.relireDirect()
    choix(v, 0, 'oui'); choix(v, 1, 'non')
    cliquer(v.carte().querySelector('[data-info-rediger]'))
    await attendre(); await attendre()
    await v.msg.envoyer()
    await attendre(); await attendre(); await attendre()
    assert.equal(v.envois().length, 1)
    assert.match(v.doc.querySelector('[data-bind="info-etat"]').textContent, /reste dans « À valider »/)
    assert.equal(v.banc.journal.length, 0, 'un refus attendu a ete journalise comme une erreur')
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : une redaction trop longue est abandonnee — la page reste libre (review 1, constat 2)', async () => {
  const d = differe()
  const v = monter({ repondre: (chemin) => chemin === '/api/guestflow-rediger' ? d.p : {} })
  try {
    const vrai = v.banc.window.setTimeout
    // Le delai de 30 s, joue tout de suite ; les autres minuteurs, intacts.
    v.banc.window.setTimeout = (fn, ms, ...a) => ms === 30000 ? vrai(fn, 0, ...a) : vrai(fn, ms, ...a)
    v.zone().value = 'oui chien'
    await v.msg.redigerBrouillon()
    assert.equal(v.zone().readOnly, false, 'le champ reste fige')
    assert.equal(v.msg.etat.iaEnCours, null, 'la page reste bloquee')
    assert.equal(v.zone().value, 'oui chien')
    assert.match(v.doc.querySelector('[data-bind="info-etat"]').textContent, /n’a pas répondu/)
    d.resoudre({ ok: true, texte: REDIGE })
    await attendre(); await attendre()
    assert.equal(v.zone().value, 'oui chien', 'la reponse tardive a ecrase le texte')
  } finally { v.fermer() }
})

test('changer de fil pendant une redaction « IA » libere le champ de l autre fil', async () => {
  const d = differe()
  const v = monter({
    conversations: [conv('B1', [entrant('Can I come?', il(25 * MIN))]), conv('B2', [entrant('Hola', il(30 * MIN))], { guestName: 'Marie' })],
    repondre: (chemin) => chemin === '/api/guestflow-rediger' ? d.p : {}
  })
  try {
    v.zone().value = 'oui chien'
    const enCours = v.msg.redigerBrouillon()
    await attendre()
    assert.equal(v.zone().readOnly, true)
    v.msg.ouvrir('B2')
    assert.equal(v.zone().readOnly, false, 'Marie ne peut pas recevoir de reponse pendant la redaction pour Ana')
    d.resoudre({ ok: true, texte: REDIGE })
    await enCours
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : l hote a repondu depuis la tache -> pas de carte', async () => {
  const v = monter({ conversations: [conv('B1', [entrant('Can I come with my dog?', il(25 * MIN)),
    { sender: 'host', direction: 'outbound', body: 'Je regarde', sent_at: il(5 * MIN), kind: 'message', origine: 'hote' }])] })
  try {
    await v.msg.relireDirect()
    assert.equal(v.carte(), null)
  } finally { v.fermer() }
})

test('sans droit d ecriture : ni carte, ni bouton « IA »', async () => {
  const v = monter({ ecriture: false })
  try {
    await v.msg.relireDirect()
    assert.equal(v.carte(), null)
    v.zone().value = 'oui chien'
    v.msg.peindreSaisieIA()
    assert.equal(v.doc.querySelector('[data-bind="ia-rediger"]').hidden, true)
  } finally { v.fermer() }
})

test('kill switch : la carte le dit, « Rediger » reste inactif, aucun appel', async () => {
  const v = monter()
  try {
    v.msg.etat.pauses = { 209413: true }
    await v.msg.relireDirect()
    choix(v, 0, 'oui'); choix(v, 1, 'non')
    const btn = v.carte().querySelector('[data-info-rediger]')
    assert.equal(btn.disabled, true)
    assert.match(v.carte().textContent, /en pause/)
    cliquer(btn)
    await attendre()
    assert.equal(v.redactions().length, 0)
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : le cron a complete la tache (memes id, autres questions) -> les choix repartent de zero', async () => {
  const v = monter()
  try {
    await v.msg.relireDirect()
    choix(v, 0, 'oui'); choix(v, 1, 'non')
    assert.equal(v.carte().querySelector('[data-info-rediger]').disabled, false)
    // Le serveur rend la meme tache, completee.
    v.msg.etat.conversations[0].infos = [{ ...INFO, maj: il(MIN), questions: [QUESTIONS[0], 'Le linge est-il fourni ?'] }]
    v.msg.renderFil()
    assert.equal(v.carte().querySelector('[data-info-rediger]').disabled, true)
    assert.equal(v.carte().querySelectorAll('[aria-pressed="true"]').length, 0)
  } finally { v.fermer() }
})

test('refus « questions_changees » : la phrase, et la carte se relit ; « deja_traitee » : la carte s en va', async () => {
  let code = 'questions_changees'
  const v = monter({ repondre: (chemin) => chemin === '/api/guestflow-rediger' ? { __statut: 409, __corps: { error: code } } : {} })
  try {
    await v.msg.relireDirect()
    const avant = v.appels.filter(a => a.chemin.startsWith('/api/messages?direct=1')).length
    choix(v, 0, 'oui'); choix(v, 1, 'non')
    cliquer(v.carte().querySelector('[data-info-rediger]'))
    await attendre(); await attendre()
    assert.match(v.doc.querySelector('[data-bind="info-etat"]').textContent, /questions ont changé/)
    assert.ok(v.appels.filter(a => a.chemin.startsWith('/api/messages?direct=1')).length > avant, 'la carte n a pas ete relue')
    assert.equal(v.zone().value, '')
    code = 'deja_traitee'
    v.msg.etat.conversations[0].infos = [INFO]
    v.msg.renderFil()
    choix(v, 0, 'oui'); choix(v, 1, 'non')
    v.msg.direct.enCours = true // la relecture n a pas lieu : on observe le retrait local seul
    cliquer(v.carte().querySelector('[data-info-rediger]'))
    await attendre(); await attendre()
    assert.equal(v.carte(), null)
    assert.match(v.doc.querySelector('[data-bind="info-etat"]').textContent, /déjà été traitée/)
  } finally { v.fermer() }
})

// ─── Le bouton « IA » de la saisie ──────────────────────────────────────────

test('le bouton « IA » n apparait que si du texte est tape', async () => {
  const v = monter()
  try {
    const btn = v.doc.querySelector('[data-bind="ia-rediger"]')
    assert.equal(btn.hidden, true)
    v.zone().value = 'oui chien, non moto'
    v.msg.peindreSaisieIA()
    assert.equal(btn.hidden, false)
    v.zone().value = '   '
    v.msg.peindreSaisieIA()
    assert.equal(btn.hidden, true)
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : « IA » remplace le texte, RIEN ne part, « Annuler » rend le texte de l hote', async () => {
  const v = monter({ repondre: (chemin) => chemin === '/api/guestflow-rediger' ? { ok: true, texte: REDIGE } : {} })
  try {
    v.zone().value = 'oui chien, moto garage 200 m'
    await v.msg.redigerBrouillon()
    assert.deepEqual(v.redactions()[0].corps, { action: 'texte', bookingId: 'B1', brouillon: 'oui chien, moto garage 200 m' })
    assert.equal(v.zone().value, REDIGE)
    assert.equal(v.envois().length, 0)
    const annuler = v.doc.querySelector('[data-bind="ia-annuler"]')
    assert.equal(annuler.hidden, false)
    v.msg.annulerIA()
    assert.equal(v.zone().value, 'oui chien, moto garage 200 m')
    assert.equal(annuler.hidden, true)
  } finally { v.fermer() }
})

test('une retouche de la version redigee retire « Annuler » (il n ecraserait pas la retouche)', async () => {
  const v = monter({ repondre: (chemin) => chemin === '/api/guestflow-rediger' ? { ok: true, texte: REDIGE } : {} })
  try {
    v.zone().value = 'oui chien'
    await v.msg.redigerBrouillon()
    v.zone().value = REDIGE + ' Merci !'
    v.msg.peindreSaisieIA()
    assert.equal(v.doc.querySelector('[data-bind="ia-annuler"]').hidden, true)
    v.msg.annulerIA()
    assert.equal(v.zone().value, REDIGE + ' Merci !', 'Annuler a ecrase la retouche')
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : pendant la redaction le champ est fige ; une redaction revenue sur un autre fil est jetee', async () => {
  const d = differe()
  const v = monter({
    conversations: [conv('B1', [entrant('Can I come?', il(25 * MIN))]), conv('B2', [entrant('Hola', il(30 * MIN))], { guestName: 'Marie' })],
    repondre: (chemin) => chemin === '/api/guestflow-rediger' ? d.p : {}
  })
  try {
    v.zone().value = 'oui chien'
    const enCours = v.msg.redigerBrouillon()
    await attendre()
    assert.equal(v.zone().readOnly, true, 'le champ accepte la frappe pendant la redaction')
    v.msg.ouvrir('B2')
    d.resoudre({ ok: true, texte: REDIGE })
    await enCours
    assert.notEqual(v.zone().value, REDIGE, 'la version redigee pour Ana est dans le fil de Marie')
    assert.equal(v.zone().readOnly, false)
  } finally { v.fermer() }
})

test('« IA » refuse : la phrase du refus, le texte de l hote intact', async () => {
  const v = monter({ repondre: (chemin) => chemin === '/api/guestflow-rediger' ? { __statut: 429, __corps: { error: 'garde_ia' } } : {} })
  try {
    v.zone().value = 'oui chien'
    await v.msg.redigerBrouillon()
    assert.equal(v.zone().value, 'oui chien')
    assert.match(v.doc.querySelector('[data-bind="info-etat"]').textContent, /Trop de rédactions/)
  } finally { v.fermer() }
})
