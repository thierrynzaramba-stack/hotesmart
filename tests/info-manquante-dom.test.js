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
  ecriture = true, titulaire = true, repondre = () => ({}) } = {}) {
  const appels = []
  const banc = B.monter({ ecriture, titulaire, appel: async (chemin, corps) => {
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
    // Les rédactions de l'étape 1 ; la proposition de base (étape 2) se compte à part.
    redactions: () => appels.filter(a => a.chemin === '/api/guestflow-rediger' && !(a.corps && a.corps.action === 'base')),
    propositionsBase: () => appels.filter(a => a.chemin === '/api/guestflow-rediger' && a.corps && a.corps.action === 'base'),
    ecrituresBase: () => appels.filter(a => a.chemin === '/api/ecran/connaissance'),
    carteBase: () => banc.doc.querySelector('[data-list="fil"] [data-bind="info-base"]'),
    envois: () => appels.filter(a => a.chemin === '/api/beds24' || a.chemin === '/api/channel-message'),
    clotures: () => appels.filter(a => a.chemin === '/api/messages' && a.corps && a.corps.action === 'info_traitee'),
    fermer: () => { banc.window.clearTimeout(msg.direct.minuteur); banc.fermer() }
  }
}
const cliquer = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }))
const choix = (v, i, r) => cliquer(v.carte().querySelector(`[data-info-choix="${i}"][data-info-reponse="${r}"]`))
const taper = (champ, texte) => { champ.value = texte; champ.dispatchEvent(new champ.ownerDocument.defaultView.Event('input', { bubbles: true })) }
// La saisie : son écouteur `input` est branché par `init()`, que ce banc
// n'appelle pas — on joue le même geste par la fonction qu'il appelle.
// ⚠ ET LA RÈGLE DE L'AUTRE ÉCOUTEUR `input` D'`init()` (review 2 de l'étape 2,
// constat F) : un champ vidé garde sa marque « vide » ; à la frappe suivante,
// un texte posé revenu la reprend, le texte de l'hôte l'abandonne. Sans elle,
// la marque restait et faisait passer un test pour une autre raison.
const taperSaisie = (v, texte) => {
  v.zone().value = texte
  const r = v.msg.etat.saisieRemplie
  if (r) {
    if (!texte.trim()) r.vide = true
    else if (r.vide) {
      if (r.textes.some(tx => String(texte).includes(tx))) r.vide = false
      else v.msg.etat.saisieRemplie = null
    }
  }
  v.msg.apresFrappeSaisie()
}
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
    assert.match(v.doc.querySelector('[data-bind="info-etat"]').textContent, /vérifiez-la ou videz-la/)
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
    assert.match(v.doc.querySelector('[data-bind="info-etat"]').textContent, /vérifiez-la ou videz-la/)
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

test('LE TEST QUI COMPTE : apres une redaction jetee, RELANCER est refuse tant que l hote n a pas touche la saisie (review 3, constat 1)', async () => {
  let d = differe()
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
    assert.equal(v.redactions().length, 1)
    // L'hote relance sans toucher la saisie : refuse, rien ne part au modele.
    d = differe()
    choix(v, 0, 'oui'); choix(v, 1, 'non')
    cliquer(v.carte().querySelector('[data-info-rediger]'))
    await attendre(); await attendre()
    assert.equal(v.redactions().length, 1, 'la relance a ajoute la reponse d Ana au texte de Marie')
    assert.equal(v.zone().value, 'Bonjour Marie, le code du portail est 4321')
    assert.match(v.doc.querySelector('[data-bind="info-etat"]').textContent, /vérifiez-la ou videz-la/)
    // L'hote vide la saisie : la relance passe.
    taperSaisie(v, '')
    cliquer(v.carte().querySelector('[data-info-rediger]'))
    d.resoudre({ ok: true, texte: REDIGE })
    await attendre(); await attendre()
    assert.equal(v.redactions().length, 2)
    assert.equal(v.zone().value, REDIGE)
  } finally { v.fermer() }
})

test('une saisie douteuse RETOUCHEE par l hote (il l a verifiee) -> la relance redevient permise', async () => {
  let d = differe()
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
    v.zone().value = 'Bonjour'
    v.msg.ouvrir('B1')
    d.resoudre({ ok: true, texte: REDIGE })
    await attendre(); await attendre()
    taperSaisie(v, 'Bonjour Ana,')
    d = differe()
    choix(v, 0, 'oui'); choix(v, 1, 'non')
    cliquer(v.carte().querySelector('[data-info-rediger]'))
    d.resoudre({ ok: true, texte: REDIGE })
    await attendre(); await attendre()
    assert.equal(v.redactions().length, 2)
    assert.equal(v.zone().value, 'Bonjour Ana,\n' + REDIGE)
  } finally { v.fermer() }
})

test('« IA » : une frappe dans LE MEME fil pendant la redaction n est pas douteuse — la relance reste permise', async () => {
  let d = differe()
  const v = monter({ repondre: (chemin) => chemin === '/api/guestflow-rediger' ? d.p : {} })
  try {
    v.zone().value = 'oui chien'
    const enCours = v.msg.redigerBrouillon()
    await attendre()
    v.zone().value = 'oui chien, et le parking ?'
    d.resoudre({ ok: true, texte: REDIGE })
    await enCours
    d = differe()
    const relance = v.msg.redigerBrouillon()
    await attendre()
    assert.equal(v.redactions().length, 2, 'la relance de son propre texte a ete refusee')
    d.resoudre({ ok: true, texte: REDIGE })
    await relance
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : quitter le fil d une reponse redigee — l envoi suivant ne clot plus la tache (review 3, constat 2)', async () => {
  const v = monter({
    conversations: [conv('B1', [entrant('Can I come with my dog?', il(25 * MIN))]), conv('B2', [entrant('Hola', il(30 * MIN))], { guestName: 'Marie' })],
    repondre: (chemin) => chemin === '/api/guestflow-rediger' ? { ok: true, texte: REDIGE } : { ok: true }
  })
  try {
    await v.msg.relireDirect()
    choix(v, 0, 'oui'); choix(v, 1, 'non')
    cliquer(v.carte().querySelector('[data-info-rediger]'))
    await attendre(); await attendre()
    v.msg.ouvrir('B2'); v.msg.ouvrir('B1')
    assert.equal(v.zone().value, '', 'jeu d essai : le texte redige est retire au changement de fil')
    v.zone().value = 'Je verifie et je reviens vers vous'
    await v.msg.envoyer()
    await attendre(); await attendre()
    assert.equal(v.envois().length, 1)
    assert.equal(v.clotures().length, 0, 'un « je reviens vers vous » a clos la question')
  } finally { v.fermer() }
})

test('saisie VIDEE apres la redaction -> l envoi suivant ne clot pas la tache', async () => {
  const v = monter({ repondre: (chemin) => chemin === '/api/guestflow-rediger' ? { ok: true, texte: REDIGE } : { ok: true } })
  try {
    await v.msg.relireDirect()
    choix(v, 0, 'oui'); choix(v, 1, 'non')
    cliquer(v.carte().querySelector('[data-info-rediger]'))
    await attendre(); await attendre()
    taperSaisie(v, '')
    v.zone().value = 'Je regarde'
    await v.msg.envoyer()
    await attendre(); await attendre()
    assert.equal(v.clotures().length, 0)
  } finally { v.fermer() }
})

test('la note d une redaction revenue pendant que l hote est AILLEURS : absente la-bas, presente au retour (review 3, constat 4)', async () => {
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
    const note = v.doc.querySelector('[data-bind="info-etat"]')
    assert.equal(note.hidden, true, 'la note d Ana s affiche chez Marie')
    v.msg.ouvrir('B1')
    assert.equal(note.hidden, false)
    assert.match(note.textContent, /vérifiez-la ou videz-la/)
  } finally { v.fermer() }
})

test('la cloture refusee pendant que l hote est AILLEURS : la note attend le fil d Ana (review 3, constat 4)', async () => {
  const cloture = differe()
  const v = monter({
    conversations: [conv('B1', [entrant('Can I come with my dog?', il(25 * MIN))]), conv('B2', [entrant('Hola', il(30 * MIN))], { guestName: 'Marie' })],
    repondre: (chemin, corps) => chemin === '/api/guestflow-rediger' ? { ok: true, texte: REDIGE }
      : chemin === '/api/messages' && corps && corps.action === 'info_traitee' ? cloture.p : { ok: true }
  })
  try {
    await v.msg.relireDirect()
    choix(v, 0, 'oui'); choix(v, 1, 'non')
    cliquer(v.carte().querySelector('[data-info-rediger]'))
    await attendre(); await attendre()
    await v.msg.envoyer()
    await attendre(); await attendre()
    v.msg.ouvrir('B2')
    cloture.resoudre({ __statut: 409, __corps: { error: 'questions_changees' } })
    await attendre(); await attendre(); await attendre()
    const note = v.doc.querySelector('[data-bind="info-etat"]')
    assert.equal(note.hidden, true, 'la note d Ana s affiche chez Marie')
    v.msg.ouvrir('B1')
    assert.equal(note.hidden, false)
    assert.match(note.textContent, /reste dans « À valider »/)
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

// ─── Étape 2 (spec §2 C) : retenir la réponse dans la base ───────────────────
// ⚠ CE QUE CES TESTS GARDENT : RIEN N'EST ÉCRIT SANS LE GESTE DE L'HÔTE (le
// writer de la base n'est appelé qu'au clic « Enregistrer »), la proposition
// n'est demandée qu'APRÈS un envoi réussi, et jamais pour un membre délégué.

const PROPOSITIONS = [
  { action: 'modifier', id: 7, sujet: 'Animaux', avant: 'Les animaux ne sont pas acceptés.', texte: 'Les chiens sont acceptés ; les autres animaux, non.' },
  { action: 'creer', sujet: 'Moto', texte: 'Pas de moto dans le logement ; un garage est à 200 m.' }
]
const reponsesBase = (extra = () => undefined) => (chemin, corps) => {
  const r = extra(chemin, corps)
  if (r !== undefined) return r
  if (chemin === '/api/guestflow-rediger') return corps.action === 'base' ? { ok: true, propositions: PROPOSITIONS } : { ok: true, texte: REDIGE }
  return { ok: true }
}
async function envoyerDepuisLaCarte (v) {
  await v.msg.relireDirect()
  choix(v, 0, 'oui'); choix(v, 1, 'non')
  cliquer(v.carte().querySelector('[data-info-rediger]'))
  await attendre(); await attendre()
  await v.msg.envoyer()
  await attendre(); await attendre(); await attendre()
}

test('LE TEST QUI COMPTE (étape 2) : après l envoi depuis la carte, la proposition est demandée — APRÈS l envoi — et RIEN n est écrit sans clic', async () => {
  const v = monter({ repondre: reponsesBase() })
  try {
    await envoyerDepuisLaCarte(v)
    assert.equal(v.envois().length, 1)
    assert.deepEqual(v.propositionsBase().map(a => a.corps), [{ action: 'base', bookingId: 'B1', tacheId: 'ti1', envoye: REDIGE }])
    assert.ok(v.appels.indexOf(v.envois()[0]) < v.appels.indexOf(v.propositionsBase()[0]), 'la proposition est demandée avant l envoi')
    const carte = v.carteBase()
    assert.ok(carte, 'la carte de base est là')
    assert.match(carte.textContent, /À retenir pour la prochaine fois/)
    const lignes = [...carte.querySelectorAll('[data-base]')]
    assert.equal(lignes.length, 2)
    assert.match(lignes[0].textContent, /Mise à jour d’une réponse prête/)
    assert.match(lignes[0].textContent, /Aujourd’hui : Les animaux ne sont pas acceptés\./)
    assert.match(lignes[1].textContent, /Nouvelle réponse prête/)
    assert.deepEqual(v.ecrituresBase(), [], 'la base est écrite sans geste de l hôte')
  } finally { v.fermer() }
})

test('étape 2 : « Enregistrer » une création -> le writer de la base, lisible par l IA ; une mise à jour -> son id, sans toucher au cadenas', async () => {
  const v = monter({ repondre: reponsesBase() })
  try {
    await envoyerDepuisLaCarte(v)
    cliquer(v.carteBase().querySelector('[data-base-enregistrer="1"]'))
    await attendre(); await attendre()
    cliquer(v.carteBase().querySelector('[data-base-enregistrer="0"]'))
    await attendre(); await attendre()
    assert.deepEqual(v.ecrituresBase().map(a => a.corps), [
      { action: 'enregistrer', bien: '209413', key: 'Moto', value: PROPOSITIONS[1].texte, lisible_par_ia: true },
      { action: 'enregistrer', bien: '209413', key: 'Animaux', value: PROPOSITIONS[0].texte, id: 7 }
    ])
    const lignes = [...v.carteBase().querySelectorAll('[data-base]')]
    for (const l of lignes) {
      assert.match(l.textContent, /Enregistrée dans vos réponses prêtes/)
      assert.equal(l.querySelector('[data-base-enregistrer]'), null, 'un second clic réécrirait')
    }
    assert.equal(v.envois().length, 1, 'rien d autre ne part au voyageur')
  } finally { v.fermer() }
})

test('étape 2 : « Modifier » dans la carte — le texte (et le sujet d une création) se corrige sur place, survit au rendu, et part tel quel', async () => {
  const v = monter({ repondre: reponsesBase() })
  try {
    await envoyerDepuisLaCarte(v)
    cliquer(v.carteBase().querySelector('[data-base-modifier="1"]'))
    const sujet = v.carteBase().querySelector('[data-base-sujet="1"]')
    const texte = v.carteBase().querySelector('[data-base-texte="1"]')
    assert.ok(sujet && texte, 'une création se corrige : sujet et texte')
    taper(sujet, 'Stationnement moto')
    taper(texte, 'Pas de moto dans le logement.')
    v.msg.renderFil()
    assert.equal(v.carteBase().querySelector('[data-base-texte="1"]').value, 'Pas de moto dans le logement.', 'un rendu du fil efface la correction')
    cliquer(v.carteBase().querySelector('[data-base-modifier="0"]'))
    assert.equal(v.carteBase().querySelector('[data-base-sujet="0"]'), null, 'le sujet d une réponse existante reste le sien')
    cliquer(v.carteBase().querySelector('[data-base-enregistrer="1"]'))
    await attendre(); await attendre()
    assert.deepEqual(v.ecrituresBase()[0].corps, { action: 'enregistrer', bien: '209413', key: 'Stationnement moto', value: 'Pas de moto dans le logement.', lisible_par_ia: true })
  } finally { v.fermer() }
})

test('étape 2 : un texte vidé ne part pas ; un refus du writer se dit, et la proposition reste', async () => {
  const v = monter({ repondre: reponsesBase((chemin) => {
    if (chemin === '/api/ecran/connaissance') { const e = new Error('Une réponse porte déjà ce sujet'); e.status = 409; e.code = 'sujet_existe'; throw e }
  }) })
  try {
    await envoyerDepuisLaCarte(v)
    cliquer(v.carteBase().querySelector('[data-base-modifier="1"]'))
    taper(v.carteBase().querySelector('[data-base-texte="1"]'), '   ')
    cliquer(v.carteBase().querySelector('[data-base-enregistrer="1"]'))
    await attendre()
    assert.equal(v.ecrituresBase().length, 0)
    assert.match(v.carteBase().querySelector('[data-base="1"]').textContent, /Le sujet et la réponse sont obligatoires/)
    taper(v.carteBase().querySelector('[data-base-texte="1"]'), 'Pas de moto.')
    cliquer(v.carteBase().querySelector('[data-base-enregistrer="1"]'))
    await attendre(); await attendre()
    assert.equal(v.ecrituresBase().length, 1)
    const ligne = v.carteBase().querySelector('[data-base="1"]')
    assert.match(ligne.textContent, /Une réponse prête porte déjà ce sujet/)
    assert.ok(ligne.querySelector('[data-base-texte="1"]'), 'la correction reste à l écran')
  } finally { v.fermer() }
})

test('étape 2 : « Non merci » retire la proposition, et la carte quand il n en reste plus ; rien n est écrit', async () => {
  const v = monter({ repondre: reponsesBase() })
  try {
    await envoyerDepuisLaCarte(v)
    cliquer(v.carteBase().querySelector('[data-base-non="0"]'))
    assert.equal(v.carteBase().querySelectorAll('[data-base]').length, 1)
    cliquer(v.carteBase().querySelector('[data-base-non="1"]'))
    assert.equal(v.carteBase(), null)
    assert.equal(v.ecrituresBase().length, 0)
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE (étape 2) : un MEMBRE délégué n appelle jamais la proposition — la base n est pas à lui', async () => {
  const v = monter({ titulaire: false, repondre: reponsesBase() })
  try {
    await envoyerDepuisLaCarte(v)
    assert.equal(v.envois().length, 1)
    assert.equal(v.propositionsBase().length, 0)
    assert.equal(v.carteBase(), null)
  } finally { v.fermer() }
})

test('étape 2 : un envoi en échec ne demande rien ; « Réessayer » réussi demande la proposition', async () => {
  let echoue = true
  const v = monter({ repondre: reponsesBase((chemin) => {
    if ((chemin === '/api/beds24' || chemin === '/api/channel-message') && echoue) { const e = new Error('canal'); e.status = 502; throw e }
  }) })
  try {
    await envoyerDepuisLaCarte(v)
    assert.equal(v.propositionsBase().length, 0, 'demandée pour un message qui n est pas parti')
    echoue = false
    cliquer(v.doc.querySelector('[data-list="fil"] [data-reessayer]'))
    await attendre(); await attendre(); await attendre()
    assert.equal(v.propositionsBase().length, 1)
  } finally { v.fermer() }
})

test('étape 2 : le bouton « IA » sur une question ouverte propose de retenir ; un texte tapé à la main, ou sans question ouverte, non', async () => {
  // B, carte présente : la tâche de la carte.
  let v = monter({ repondre: reponsesBase() })
  try {
    await v.msg.relireDirect()
    taperSaisie(v, 'oui chien, pas de moto')
    await v.msg.redigerBrouillon()
    await v.msg.envoyer()
    await attendre(); await attendre(); await attendre()
    assert.deepEqual(v.propositionsBase().map(a => a.corps), [{ action: 'base', bookingId: 'B1', tacheId: 'ti1', envoye: REDIGE }])
  } finally { v.fermer() }
  // À la main : rien.
  v = monter({ repondre: reponsesBase() })
  try {
    await v.msg.relireDirect()
    taperSaisie(v, 'Oui pour le chien.')
    await v.msg.envoyer()
    await attendre(); await attendre()
    assert.equal(v.envois().length, 1)
    assert.equal(v.propositionsBase().length, 0)
  } finally { v.fermer() }
  // « IA », puis « Annuler » : c'est le texte de l'hôte qui part — rien.
  v = monter({ repondre: reponsesBase() })
  try {
    await v.msg.relireDirect()
    taperSaisie(v, 'oui chien')
    await v.msg.redigerBrouillon()
    v.msg.annulerIA()
    await v.msg.envoyer()
    await attendre(); await attendre()
    assert.equal(v.propositionsBase().length, 0)
  } finally { v.fermer() }
  // « IA » sans question ouverte : rien.
  v = monter({ infos: [], repondre: reponsesBase() })
  try {
    await v.msg.relireDirect()
    taperSaisie(v, 'oui chien')
    await v.msg.redigerBrouillon()
    await v.msg.envoyer()
    await attendre(); await attendre()
    assert.equal(v.envois().length, 1)
    assert.equal(v.propositionsBase().length, 0)
  } finally { v.fermer() }
})

test('étape 2 : la proposition ne suit pas l hôte dans un autre fil — ni affichée là-bas, ni gardée au retour', async () => {
  const d = differe()
  const v = monter({
    conversations: [conv('B1', [entrant('Can I come with my dog?', il(25 * MIN))]), conv('B2', [entrant('Hola', il(30 * MIN))], { guestName: 'Marie' })],
    repondre: reponsesBase((chemin, corps) => chemin === '/api/guestflow-rediger' && corps.action === 'base' ? d.p : undefined)
  })
  try {
    await envoyerDepuisLaCarte(v)
    v.msg.ouvrir('B2')
    d.resoudre({ ok: true, propositions: PROPOSITIONS })
    await attendre(); await attendre()
    assert.equal(v.carteBase(), null, 'affichée dans le fil de Marie')
    v.msg.ouvrir('B1')
    v.msg.renderFil()
    assert.equal(v.carteBase(), null, 'une réponse arrivée pendant l absence est jetée')
  } finally { v.fermer() }
  // Affichée, puis l'hôte change de fil : elle tombe.
  const w = monter({
    conversations: [conv('B1', [entrant('Can I come with my dog?', il(25 * MIN))]), conv('B2', [entrant('Hola', il(30 * MIN))], { guestName: 'Marie' })],
    repondre: reponsesBase()
  })
  try {
    await envoyerDepuisLaCarte(w)
    assert.ok(w.carteBase())
    w.msg.ouvrir('B2'); w.msg.ouvrir('B1')
    w.msg.renderFil()
    assert.equal(w.carteBase(), null)
  } finally { w.fermer() }
})

test('étape 2 : un refus de la proposition (plafond, pause, droit) ne se signale pas, et n affiche rien', async () => {
  for (const status of [403, 409, 429]) {
    const v = monter({ repondre: reponsesBase((chemin, corps) => {
      if (chemin === '/api/guestflow-rediger' && corps.action === 'base') { const e = new Error('refus'); e.status = status; e.code = 'x'; throw e }
    }) })
    try {
      await envoyerDepuisLaCarte(v)
      assert.equal(v.propositionsBase().length, 1)
      assert.equal(v.carteBase(), null)
      assert.equal(v.banc.journal.filter(l => /reponse prete/.test(String(l[1]))).length, 0, `un refus ${status} est journalisé comme une panne`)
    } finally { v.fermer() }
  }
})

test('étape 2 : une panne de la proposition (500) se journalise, sans rien afficher', async () => {
  const v = monter({ repondre: reponsesBase((chemin, corps) => {
    if (chemin === '/api/guestflow-rediger' && corps.action === 'base') { const e = new Error('panne'); e.status = 502; e.code = 'ia_indisponible'; throw e }
  }) })
  try {
    await envoyerDepuisLaCarte(v)
    assert.equal(v.carteBase(), null)
    assert.equal(v.banc.journal.filter(l => /reponse prete/.test(String(l[1]))).length, 1)
  } finally { v.fermer() }
})

// ─── Review 1 de l'étape 2 : corrections ─────────────────────────────────────

const utiliser = (v, texte) => {
  const b = v.msg.etat.biens
  if (b.set) b.set('209413', { id: '209413', name: 'La bulle' }); else b.add('209413')
  return v.msg.utiliserDansLaSaisie({ texte, resa: 'B1', ref: '209413' })
}

test('LE TEST QUI COMPTE (review 1, constat 2) : une réponse de la base posée par « Utiliser » — rien ne se propose, ni après la carte, ni après « IA »', async () => {
  // A : carte, Rédiger, puis « Utiliser » un code de la base.
  let v = monter({ repondre: reponsesBase() })
  try {
    await v.msg.relireDirect()
    choix(v, 0, 'oui'); choix(v, 1, 'non')
    cliquer(v.carte().querySelector('[data-info-rediger]'))
    await attendre(); await attendre()
    assert.equal(utiliser(v, 'Code de la porte : 4521'), true, 'Utiliser a posé le texte')
    await v.msg.envoyer()
    await attendre(); await attendre(); await attendre()
    assert.equal(v.envois().length, 1)
    assert.match(v.envois()[0].corps.message, /4521/)
    assert.equal(v.propositionsBase().length, 0, 'le code partirait vers une réponse prête')
  } finally { v.fermer() }
  // B : « Utiliser » puis « IA » — la version rédigée dérive de la base.
  v = monter({ repondre: reponsesBase() })
  try {
    await v.msg.relireDirect()
    assert.equal(utiliser(v, 'Code de la porte : 4521'), true)
    await v.msg.redigerBrouillon()
    assert.equal(v.zone().value, REDIGE)
    await v.msg.envoyer()
    await attendre(); await attendre(); await attendre()
    assert.equal(v.propositionsBase().length, 0)
  } finally { v.fermer() }
})

test('review 1, constat 6 : le texte de l IA ne suit pas l hôte — changement de fil, saisie vidée, envoi fait', async () => {
  const deux = () => [conv('B1', [entrant('Can I come with my dog?', il(25 * MIN))]), conv('B2', [entrant('Hola', il(30 * MIN))], { guestName: 'Marie' })]
  // Changement de fil : « IA » dans B1, passage par B2, retour, texte tapé à la main.
  let v = monter({ conversations: deux(), repondre: reponsesBase() })
  try {
    await v.msg.relireDirect()
    taperSaisie(v, 'oui chien')
    await v.msg.redigerBrouillon()
    v.msg.ouvrir('B2'); v.msg.ouvrir('B1')
    taperSaisie(v, 'Oui pour le chien.')
    await v.msg.envoyer()
    await attendre(); await attendre()
    assert.equal(v.envois().length, 1)
    assert.equal(v.propositionsBase().length, 0, 'changement de fil')
  } finally { v.fermer() }
  // Saisie vidée, puis texte à la main.
  v = monter({ repondre: reponsesBase() })
  try {
    await v.msg.relireDirect()
    taperSaisie(v, 'oui chien')
    await v.msg.redigerBrouillon()
    taperSaisie(v, '')
    taperSaisie(v, 'Oui pour le chien.')
    await v.msg.envoyer()
    await attendre(); await attendre()
    assert.equal(v.propositionsBase().length, 0, 'saisie vidée')
  } finally { v.fermer() }
  // Envoi fait : le message suivant, tapé à la main, ne propose rien.
  v = monter({ repondre: reponsesBase() })
  try {
    await v.msg.relireDirect()
    taperSaisie(v, 'oui chien')
    await v.msg.redigerBrouillon()
    await v.msg.envoyer()
    await attendre(); await attendre(); await attendre()
    assert.equal(v.propositionsBase().length, 1)
    // Le voyageur repose une question : une NOUVELLE carte est ouverte. Le
    // texte de l'IA déjà parti ne compte plus pour elle.
    v.msg.etat.conversations[0].infos = [{ ...INFO, id: 'ti2', maj: new Date(Date.now() + 60000).toISOString(), questions: ['Et le parking ?'] }]
    v.msg.renderFil()
    assert.ok(v.carte(), 'la nouvelle carte est là')
    taperSaisie(v, 'Et bon séjour !')
    await v.msg.envoyer()
    await attendre(); await attendre()
    assert.equal(v.envois().length, 2)
    assert.equal(v.propositionsBase().length, 1, 'le second envoi, à la main, a proposé')
  } finally { v.fermer() }
})

test('review 1, constat 9 : un 404 laisse seulement « Non merci » ; un 403 dit un refus, pas « réessayez »', async () => {
  for (const [status, attendu] of [[404, /n’existe plus/], [403, /refusé pour ce logement/]]) {
    const v = monter({ repondre: reponsesBase((chemin) => {
      if (chemin === '/api/ecran/connaissance') { const e = new Error('refus'); e.status = status; throw e }
    }) })
    try {
      await envoyerDepuisLaCarte(v)
      cliquer(v.carteBase().querySelector('[data-base-enregistrer="0"]'))
      await attendre(); await attendre()
      const ligne = v.carteBase().querySelector('[data-base="0"]')
      assert.match(ligne.textContent, attendu)
      if (status === 404) {
        assert.equal(ligne.querySelector('[data-base-enregistrer]'), null, 'un nouveau clic redonnerait 404')
        assert.ok(ligne.querySelector('[data-base-non]'))
        cliquer(ligne.querySelector('[data-base-non]'))
        assert.equal(v.carteBase().querySelectorAll('[data-base]').length, 1)
      } else {
        assert.ok(ligne.querySelector('[data-base-enregistrer]'))
        assert.equal(v.banc.journal.filter(l => /reponse prete/.test(String(l[1]))).length, 1, 'un 403 se journalise')
      }
    } finally { v.fermer() }
  }
})

// ─── Review 2 de l'étape 2 ───────────────────────────────────────────────────

const PROPOSITION_IA = { id: 'p9', book_id: 'B1', property_id: '209413', task_type: 'auto_reply', status: 'pending_validation',
  suggested_reply: 'Le mot de passe wifi est LaBulle65.', summary: 'Wifi', created_at: il(10 * MIN) }

test('LE TEST QUI COMPTE (review 2, constats D et G) : « Modifier » une proposition, puis « IA », puis Envoyer — aucune proposition de base, même édition fermée', async () => {
  // Édition ouverte : la garde de l'envoi (valideTache).
  let v = monter({ repondre: reponsesBase() })
  try {
    await v.msg.relireDirect()
    v.msg.etat.taches = [PROPOSITION_IA]; v.msg.indexerTaches(); v.msg.renderFil()
    v.msg.modifierProposition('p9')
    assert.match(v.zone().value, /LaBulle65/)
    await v.msg.redigerBrouillon()
    await v.msg.envoyer()
    await attendre(); await attendre(); await attendre()
    assert.equal(v.propositionsBase().length, 0, 'édition ouverte')
  } finally { v.fermer() }
  // Édition FERMÉE par un passage dans un autre fil : la marque de la saisie.
  v = monter({
    conversations: [conv('B1', [entrant('Can I come with my dog?', il(25 * MIN))]), conv('B2', [entrant('Hola', il(30 * MIN))], { guestName: 'Marie' })],
    repondre: reponsesBase()
  })
  try {
    await v.msg.relireDirect()
    v.msg.etat.taches = [PROPOSITION_IA]; v.msg.indexerTaches(); v.msg.renderFil()
    v.msg.modifierProposition('p9')
    taperSaisie(v, 'Le mot de passe wifi est LaBulle65, bon séjour.')
    v.msg.ouvrir('B2'); v.msg.ouvrir('B1')
    assert.equal(v.msg.etat.enEdition, null, 'l édition est fermée')
    assert.match(v.zone().value, /LaBulle65/, 'le texte retouché reste')
    await v.msg.redigerBrouillon()
    await v.msg.envoyer()
    await attendre(); await attendre(); await attendre()
    assert.equal(v.propositionsBase().length, 0, 'édition fermée')
  } finally { v.fermer() }
})

test('review 2, constat E : carte, « IA », « Annuler », Envoyer — la réponse de la carte propose bien de se retenir', async () => {
  const v = monter({ repondre: reponsesBase((chemin, corps) => chemin === '/api/guestflow-rediger' && corps.action === 'texte' ? { ok: true, texte: 'Autre version.' } : undefined) })
  try {
    await v.msg.relireDirect()
    choix(v, 0, 'oui'); choix(v, 1, 'non')
    cliquer(v.carte().querySelector('[data-info-rediger]'))
    await attendre(); await attendre()
    await v.msg.redigerBrouillon()
    assert.equal(v.zone().value, 'Autre version.')
    v.msg.annulerIA()
    assert.equal(v.zone().value, REDIGE)
    await v.msg.envoyer()
    await attendre(); await attendre(); await attendre()
    assert.deepEqual(v.propositionsBase().map(a => a.corps.envoye), [REDIGE])
  } finally { v.fermer() }
})
