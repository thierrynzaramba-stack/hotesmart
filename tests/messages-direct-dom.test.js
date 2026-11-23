// tests/messages-direct-dom.test.js
// Le fil de Messages se met a jour tout seul — dans la VRAIE page.
// Spec : docs/specs/spec-messages-fil-en-direct.md (§2, regles 1 a 6, et §6).
//
// Banc : tests/outils/banc-messages.js — le vrai module de pages/messages.html
// dans un vrai DOM. Le reseau est double au niveau de `fetch` : chaque test
// compte ce qui part, et affirme ce que l'hote voit.

const test = require('node:test')
const assert = require('node:assert/strict')
const B = require('./outils/banc-messages')

const MIN = 60000
const il = (ms) => new Date(Date.now() - ms).toISOString()
const jour = (d) => new Date(Date.now() + d * 86400000).toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' })

const T1 = il(10 * MIN), T2 = il(5 * MIN)
const LU_LE = il(20000)
const attendre = (ms) => new Promise(r => setTimeout(r, ms))
const conv = (bookId, messages, extra = {}) => ({
  bookId, propertyId: '209413', provider: 'channex', ota: 'Airbnb', platform: 'airbnb',
  guestName: 'Ana Lopez', firstNight: jour(0), lastNight: jour(3), status: 'confirmed',
  messages, lastTime: messages.length ? messages[messages.length - 1].sent_at : null, ...extra
})
const entrant = (body, sent_at) => ({ sender: 'guest', direction: 'inbound', body, sent_at, kind: 'message', origine: null })

function monterDirect ({ conversations, ouverte = 'B1', repondre = () => ({}), taches = [], luLe = LU_LE } = {}) {
  const appels = []
  const banc = B.monter({ appel: async (chemin, corps) => {
    appels.push({ chemin, corps })
    return repondre(chemin, corps)
  } })
  const etatVue = { visible: true }
  Object.defineProperty(banc.doc, 'visibilityState', { configurable: true, get: () => etatVue.visible ? 'visible' : 'hidden' })
  const delais = []
  const vrai = banc.window.setTimeout
  banc.window.setTimeout = (fn, d, ...a) => { delais.push(d); return vrai(fn, d, ...a) }
  const { msg } = banc
  msg.etat.conversations = conversations
  msg.etat.taches = taches
  msg.indexerTaches()
  msg.etat.ouverte = ouverte
  // L'instant de la lecture de la liste, tel que la collection le rend.
  msg.etat.luLe = luLe
  msg.renderListe(); msg.renderFil()
  // Les ecouteurs du direct (pastille, defilement, onglet) : ceux de la page.
  msg.demarrerDirect()
  return { banc, msg, appels, delais, etatVue, doc: banc.doc,
    directs: () => appels.filter(a => a.chemin.startsWith('/api/messages?direct=1')),
    fermer: () => { banc.window.clearTimeout(msg.direct.minuteur); banc.fermer() } }
}
const textesDuFil = (doc) => [...doc.querySelectorAll('[data-list="fil"] .bulle')].map(b => b.textContent.trim())

test('LE TEST QUI COMPTE : un message du voyageur apparait dans le fil ouvert, sans recharger, en UN appel', async () => {
  const neuf = entrant('Je suis devant la porte', il(3000))
  const v = monterDirect({
    conversations: [conv('B1', [entrant('Bonjour', T1)])],
    repondre: (chemin) => chemin.startsWith('/api/messages?direct=1')
      ? { messages: [entrant('Bonjour', T1), neuf], taches: [], dernier: T1, complet: true, curseur: 'CURSEUR-1' } : {}
  })
  try {
    assert.deepEqual(textesDuFil(v.doc), ['Bonjour'])
    await v.msg.relireDirect()
    assert.deepEqual(textesDuFil(v.doc), ['Bonjour', 'Je suis devant la porte'])
    assert.equal(v.directs().length, 1, 'une relecture = un appel')
    const url = new URL(v.directs()[0].chemin, 'https://x.test')
    assert.equal(url.searchParams.get('fil'), 'B1')
    // Premier cycle : l'instant de la lecture de la liste, moins deux minutes
    // de recouvrement (deux horloges serveur) — review 1, constat 3.
    assert.equal(url.searchParams.get('depuis'), new Date(Date.parse(LU_LE) - 2 * MIN).toISOString())
    assert.ok(!v.appels.some(a => a.chemin.startsWith('/api/messages?limit')), 'la liste entiere a ete relue pour rien')
    // Cycle suivant : le curseur RENDU par le serveur, tel quel.
    await v.msg.relireDirect()
    assert.equal(new URL(v.directs()[1].chemin, 'https://x.test').searchParams.get('depuis'), 'CURSEUR-1')
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : onglet CACHE — aucune relecture, aucun minuteur', async () => {
  const v = monterDirect({ conversations: [conv('B1', [entrant('Bonjour', T1)])] })
  try {
    v.etatVue.visible = false
    await v.msg.relireDirect()
    v.delais.length = 0
    v.msg.planifierDirect()
    assert.equal(v.appels.length, 0, 'un appel est parti onglet cache')
    assert.deepEqual(v.delais, [], 'un minuteur est arme onglet cache')
    assert.equal(v.msg.direct.minuteur, null)
  } finally { v.fermer() }
})

test('le rythme : 5 s fil ouvert, 60 s liste seule, 60 s apres 15 min sans geste', () => {
  const v = monterDirect({ conversations: [conv('B1', [entrant('Bonjour', T1)])] })
  try {
    v.delais.length = 0
    v.msg.planifierDirect()
    v.msg.etat.ouverte = null
    v.msg.planifierDirect()
    v.msg.etat.ouverte = 'B1'
    v.msg.direct.dernierGeste = Date.now() - 16 * MIN
    v.msg.planifierDirect()
    assert.deepEqual(v.delais, [5000, 60000, 60000])
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : ce que l hote tape reste intact, et garde le focus', async () => {
  const neuf = entrant('Le code ne marche pas', il(2000))
  const v = monterDirect({
    conversations: [conv('B1', [entrant('Bonjour', T1)])],
    repondre: (c) => c.startsWith('/api/messages?direct=1') ? { messages: [neuf], taches: [], dernier: T1, complet: true } : {}
  })
  try {
    const zone = v.doc.querySelector('[data-bind="texte"]')
    zone.value = 'Je vous envoie le code de secours'
    zone.focus()
    await v.msg.relireDirect()
    assert.ok(textesDuFil(v.doc).includes('Le code ne marche pas'))
    assert.equal(zone.value, 'Je vous envoie le code de secours')
    assert.equal(v.doc.activeElement, zone)
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : un element du fil en main (focus) n est pas redessine — la pastille le dit, le rendu attend', async () => {
  const neuf = entrant('Merci !', il(2000))
  let reponse = { messages: [neuf], taches: [], dernier: T1, complet: true }
  const tache = { id: 'x1', book_id: 'B1', property_id: '209413', suggested_reply: 'Avec plaisir', summary: '', status: 'pending_validation', created_at: T2 }
  const v = monterDirect({
    conversations: [conv('B1', [entrant('Bonjour', T1)])], taches: [tache],
    repondre: (c) => c.startsWith('/api/messages?direct=1') ? reponse : {}
  })
  try {
    v.msg.renderFil()
    const bouton = v.doc.querySelector('[data-list="fil"] [data-envoyer-prop]')
    assert.ok(bouton, 'jeu d essai : la proposition porte un bouton')
    bouton.focus()
    await v.msg.relireDirect()
    assert.ok(!textesDuFil(v.doc).some(t => t.includes('Merci !')), 'le fil a ete redessine sous la main de l hote')
    assert.equal(v.doc.activeElement, bouton, 'le focus a ete perdu')
    assert.equal(v.doc.querySelector('[data-bind="fil-nouveau"]').hidden, false, 'la pastille ne dit pas qu un message attend')
    bouton.blur()
    reponse = { messages: [], taches: [tache], dernier: T1, complet: true }
    await v.msg.relireDirect()
    assert.ok(textesDuFil(v.doc).some(t => t.includes('Merci !')), 'le rendu differe n a jamais eu lieu')
  } finally { v.fermer() }
})

test('le defilement est respecte : l hote remonte lire, le fil ne saute pas, la pastille apparait', async () => {
  const neuf = entrant('Une question', il(2000))
  const v = monterDirect({
    conversations: [conv('B1', [entrant('Bonjour', T1)])],
    repondre: (c) => c.startsWith('/api/messages?direct=1') ? { messages: [neuf], taches: [], dernier: T1, complet: true } : {}
  })
  try {
    const deroule = v.doc.querySelector('[data-list="fil"]')
    Object.defineProperty(deroule, 'scrollHeight', { configurable: true, get: () => 1000 })
    Object.defineProperty(deroule, 'clientHeight', { configurable: true, get: () => 300 })
    deroule.scrollTop = 100
    await v.msg.relireDirect()
    assert.ok(textesDuFil(v.doc).includes('Une question'))
    assert.equal(deroule.scrollTop, 100, 'le fil a saute en bas pendant la lecture')
    assert.equal(v.doc.querySelector('[data-bind="fil-nouveau"]').hidden, false)
    v.doc.querySelector('[data-bind="fil-nouveau"]').click()
    assert.equal(deroule.scrollTop, 1000)
    assert.equal(v.doc.querySelector('[data-bind="fil-nouveau"]').hidden, true)
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : aucun doublon — le message envoye depuis la page n apparait qu une fois', async () => {
  const local = { sender: 'host', direction: 'outbound', body: 'Le code est 4821', sent_at: new Date().toISOString(), kind: 'message', origine: 'hote', _local: true }
  const coeur = { ...local, sent_at: il(1500) }
  delete coeur._local
  const v = monterDirect({
    conversations: [conv('B1', [entrant('Bonjour', T1), local])],
    repondre: (c) => c.startsWith('/api/messages?direct=1') ? { messages: [coeur], taches: [], dernier: T1, complet: true } : {}
  })
  try {
    await v.msg.relireDirect()
    assert.equal(textesDuFil(v.doc).filter(t => t === 'Le code est 4821').length, 1)
  } finally { v.fermer() }
})

test('lu tant que c est a l ecran : un message du voyageur arrive, la page le marque UNE fois', async () => {
  const neuf = entrant('Nous arrivons a 18 h', il(2000))
  let reponse = { messages: [neuf], taches: [], dernier: T1, complet: true }
  const v = monterDirect({
    conversations: [conv('B1', [entrant('Bonjour', T1)])],
    repondre: (c) => c.startsWith('/api/messages?direct=1') ? reponse : {}
  })
  try {
    await v.msg.relireDirect()
    reponse = { messages: [neuf], taches: [], dernier: T1, complet: true }
    await v.msg.relireDirect()
    const lus = v.appels.filter(a => a.corps && a.corps.action === 'lu')
    assert.equal(lus.length, 1)
    assert.deepEqual(lus[0].corps, { action: 'lu', booking_id: 'B1' })
  } finally { v.fermer() }
})

test('une proposition de l IA arrive en direct dans le fil, et le badge suit', async () => {
  const tache = { id: 'x9', book_id: 'B1', property_id: '209413', suggested_reply: 'Le parking est au sous-sol', summary: '', status: 'pending_validation', created_at: il(1000) }
  const v = monterDirect({
    conversations: [conv('B1', [entrant('Ou se garer ?', T1)])],
    repondre: (c) => c.startsWith('/api/messages?direct=1') ? { messages: [], taches: [tache], dernier: T1, complet: true } : {}
  })
  try {
    await v.msg.relireDirect()
    assert.ok(textesDuFil(v.doc).some(t => t.includes('Le parking est au sous-sol')))
    assert.equal(v.msg.etat.taches.map(x => x.id).join(','), 'x9')
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : la reponse d un fil QUITTE entre-temps est jetee', async () => {
  let liberer
  const v = monterDirect({
    conversations: [conv('B1', [entrant('Bonjour', T1)]), conv('B2', [entrant('Salut', T1)], { guestName: 'Marie' })],
    repondre: (c) => c.startsWith('/api/messages?direct=1')
      ? new Promise(r => { liberer = () => r({ messages: [entrant('POUR B1', il(1000))], taches: [], dernier: il(1000), complet: true }) })
      : {}
  })
  try {
    const enVol = v.msg.relireDirect()
    await B.reposer(v.banc)
    v.msg.ouvrir('B2')
    liberer()
    await enVol
    const b1 = v.msg.etat.conversations.find(c => c.bookId === 'B1')
    assert.ok(!b1.messages.some(m => m.body === 'POUR B1'), 'une reponse perimee a ete appliquee')
    assert.ok(!textesDuFil(v.doc).includes('POUR B1'))
  } finally { v.fermer() }
})

test('une panne ne casse rien : trois echecs → la mention discrete ; 401 → la relecture s arrete', async () => {
  let statut = 500
  const v = monterDirect({
    conversations: [conv('B1', [entrant('Bonjour', T1)])],
    repondre: (c) => c.startsWith('/api/messages?direct=1') ? { __statut: statut, __corps: { error: 'x' } } : {}
  })
  try {
    const panne = v.doc.querySelector('[data-bind="fil-direct-panne"]')
    await v.msg.relireDirect(); await v.msg.relireDirect()
    assert.equal(panne.hidden, true, 'deux echecs : rien a dire encore')
    await v.msg.relireDirect()
    assert.equal(panne.hidden, false)
    assert.deepEqual(textesDuFil(v.doc), ['Bonjour'], 'le fil est intact')
    v.delais.length = 0
    v.msg.planifierDirect()
    assert.deepEqual(v.delais, [80000], 'trois echecs : on espace')
    statut = 401
    await v.msg.relireDirect()
    v.delais.length = 0
    v.msg.planifierDirect()
    assert.equal(v.msg.direct.arret, true)
    assert.deepEqual(v.delais, [], 'session expiree : plus aucune relecture')
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : la liste se relit seulement si du neuf est annonce, et au plus une fois par minute', async () => {
  let dernier = il(1000)
  const v = monterDirect({
    conversations: [conv('B1', [entrant('Bonjour', T1)])], ouverte: null,
    repondre: (c) => c.startsWith('/api/messages?direct=1') ? { dernier }
      // Comme la production : la collection rend son `lu_le` (review 2, constat 7).
      : c.startsWith('/api/messages?limit=') ? { conversations: [conv('B3', [entrant('Nouveau voyageur', dernier)], { guestName: 'Paul' })], lu_le: new Date().toISOString() } : {}
  })
  try {
    await v.msg.relireDirect()
    const listes = () => v.appels.filter(a => a.chemin.startsWith('/api/messages?limit='))
    assert.equal(listes().length, 1, 'du neuf annonce : la liste se relit')
    assert.ok(v.msg.etat.conversations.some(c => c.bookId === 'B3'))
    assert.equal(new URL(v.directs()[0].chemin, 'https://x.test').searchParams.get('fil'), null, 'sans fil, rien du fil')
    dernier = new Date().toISOString()
    await v.msg.relireDirect()
    assert.equal(listes().length, 1, 'relue deux fois dans la minute')
    await v.msg.relireDirect()
    assert.equal(listes().length, 1)
  } finally { v.fermer() }
})

test('rien de neuf : la relecture ne redessine rien et n ecrit rien', async () => {
  const v = monterDirect({
    conversations: [conv('B1', [entrant('Bonjour', T1)])],
    repondre: (c) => c.startsWith('/api/messages?direct=1') ? { messages: [entrant('Bonjour', T1)], taches: [], dernier: T1, complet: true } : {}
  })
  try {
    const avant = v.doc.querySelector('[data-list="fil"]').firstElementChild
    await v.msg.relireDirect()
    assert.equal(v.doc.querySelector('[data-list="fil"]').firstElementChild, avant, 'le fil a ete redessine pour rien')
    assert.equal(v.appels.filter(a => a.corps).length, 0, 'une ecriture est partie pour rien')
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : « Modifier puis Envoyer » — une relecture de la liste PENDANT l envoi ne fait pas perdre la cloture', async () => {
  // Review 1, constat BLOQUANT : la relecture de la liste ecrasait les
  // propositions ; celle en cours d'envoi disparaissait, sa cloture ne partait
  // jamais, la tache restait `sending` et revenait a l'hote dix minutes plus
  // tard — un second clic envoyait le message en double.
  let libererEnvoi
  const posts = []
  const v = monterDirect({
    conversations: [conv('B1', [entrant('Bonjour', T1)])],
    taches: [{ id: 'x1', book_id: 'B1', property_id: '209413', suggested_reply: 'Texte IA', summary: '', status: 'pending_validation',
      created_at: il(MIN), send_after: new Date(Date.now() + 10 * MIN).toISOString() }],
    repondre: (chemin, corps) => {
      if (corps) posts.push(corps.action || chemin)
      if (chemin.startsWith('/api/messages?direct=1')) return { messages: [], taches: [], dernier: new Date().toISOString(), complet: true, curseur: 'C' }
      if (chemin.startsWith('/api/messages?limit=')) return { conversations: [conv('B1', [entrant('Bonjour', T1)]), conv('B2', [entrant('Autre', il(1000))], { guestName: 'Paul' })], lu_le: new Date().toISOString() }
      if (chemin === '/api/beds24' || chemin === '/api/channel-message') return new Promise(r => { libererEnvoi = () => r({ success: true }) })
      return { ok: true }
    }
  })
  try {
    v.msg.modifierProposition('x1')
    v.doc.querySelector('[data-bind="texte"]').value = 'Texte retouche'
    v.banc.window.envoyer()
    for (let i = 0; i < 100 && !libererEnvoi; i++) await attendre(5)
    assert.ok(libererEnvoi, 'jeu d essai : l envoi doit etre en vol')
    await v.msg.relireDirect()
    assert.ok(v.appels.some(a => a.chemin.startsWith('/api/messages?limit=')), 'jeu d essai : la liste doit avoir ete relue pendant l envoi')
    libererEnvoi()
    for (let i = 0; i < 100 && !posts.includes('proposition'); i++) await attendre(5)
    assert.ok(posts.includes('proposition'), 'la proposition envoyee n a jamais ete close : ' + JSON.stringify(posts))
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : la ligne du coeur ramenee PENDANT la cloture d une proposition — une seule bulle', async () => {
  // Review 1, constat 2.
  const coeur = []
  let libererCloture
  const v = monterDirect({
    conversations: [conv('B1', [entrant('Bonjour', T1)])],
    taches: [{ id: 'x1', book_id: 'B1', property_id: '209413', suggested_reply: 'Avec plaisir', summary: '', status: 'pending_validation', created_at: il(MIN) }],
    repondre: (chemin, corps) => {
      if (chemin.startsWith('/api/messages?direct=1')) return { messages: [...coeur], taches: [], dernier: T1, complet: true, curseur: 'C' }
      if (chemin === '/api/beds24' || chemin === '/api/channel-message') {
        coeur.push({ sender: 'host', direction: 'outbound', body: corps.message, sent_at: new Date().toISOString(), kind: 'message', origine: 'ia_validee' })
        return { success: true }
      }
      if (corps && corps.action === 'proposition') return new Promise(r => { libererCloture = () => r({ ok: true }) })
      return { ok: true }
    }
  })
  try {
    v.doc.querySelector('[data-envoyer-prop="x1"]').click()
    for (let i = 0; i < 100 && !libererCloture; i++) await attendre(5)
    assert.ok(libererCloture, 'jeu d essai : la cloture doit etre en vol')
    await v.msg.relireDirect()
    libererCloture()
    await attendre(30)
    await v.msg.relireDirect()
    assert.equal(textesDuFil(v.doc).filter(t => t === 'Avec plaisir').length, 1, 'doublon : ' + JSON.stringify(textesDuFil(v.doc)))
  } finally { v.fermer() }
})

test('le menu ⋯ ouvert dans l en-tete du fil n est pas referme sous la main de l hote', async () => {
  // Review 1, constat 6 : le seul <details> de la page est dans l'en-tete.
  const neuf = entrant('Une question', il(2000))
  let reponse = { messages: [neuf], taches: [], dernier: T1, complet: true, curseur: 'C' }
  const v = monterDirect({
    conversations: [conv('B1', [entrant('Bonjour', T1)])],
    repondre: (c) => c.startsWith('/api/messages?direct=1') ? reponse : {}
  })
  try {
    const menu = v.doc.querySelector('[data-bind="fil-menu"] details')
    assert.ok(menu, 'jeu d essai : le menu du fil existe')
    menu.open = true
    await v.msg.relireDirect()
    assert.equal(v.doc.querySelector('[data-bind="fil-menu"] details'), menu, 'le menu a ete redessine')
    assert.equal(menu.open, true)
    assert.equal(v.doc.querySelector('[data-bind="fil-nouveau"]').hidden, false)
    menu.open = false
    reponse = { messages: [], taches: [], dernier: T1, complet: true, curseur: 'C' }
    await v.msg.relireDirect()
    assert.ok(textesDuFil(v.doc).includes('Une question'), 'le rendu differe n a jamais eu lieu')
  } finally { v.fermer() }
})

test('une proposition rejetee pendant qu un cycle etait en vol ne revient pas', async () => {
  // Review 1, constat 5a.
  const tache = { id: 'x1', book_id: 'B1', property_id: '209413', suggested_reply: 'Non merci', summary: '', status: 'pending_validation', created_at: il(MIN) }
  let liberer
  const v = monterDirect({
    conversations: [conv('B1', [entrant('Bonjour', T1)])], taches: [tache],
    repondre: (c) => c.startsWith('/api/messages?direct=1')
      ? new Promise(r => { liberer = () => r({ messages: [], taches: [{ ...tache }], dernier: T1, complet: true, curseur: 'C' }) })
      : { ok: true }
  })
  try {
    const enVol = v.msg.relireDirect()
    await B.reposer(v.banc)
    v.banc.window.retirerTache(v.msg.etat.taches[0])
    liberer()
    await enVol
    assert.equal(v.msg.etat.taches.length, 0, 'la proposition retiree est revenue')
    assert.ok(!textesDuFil(v.doc).some(t => t.includes('Non merci')))
  } finally { v.fermer() }
})

test('retour sur l onglet : une relecture IMMEDIATE, puis le rythme', async () => {
  const v = monterDirect({
    conversations: [conv('B1', [entrant('Bonjour', T1)])],
    repondre: (c) => c.startsWith('/api/messages?direct=1') ? { messages: [], taches: [], dernier: T1, complet: true, curseur: 'C' } : {}
  })
  try {
    v.etatVue.visible = false
    v.doc.dispatchEvent(new v.banc.window.Event('visibilitychange'))
    assert.equal(v.msg.direct.minuteur, null, 'onglet cache : le minuteur doit tomber')
    v.etatVue.visible = true
    v.delais.length = 0
    v.doc.dispatchEvent(new v.banc.window.Event('visibilitychange'))
    await B.reposer(v.banc)
    assert.equal(v.directs().length, 1, 'pas de relecture immediate au retour')
    assert.ok(v.delais.includes(5000))
  } finally { v.fermer() }
})

test('page oubliee : un message arrive mais reste NON LU ; le premier geste le lit, relit et remet 5 s', async () => {
  // Review 1, constat 11 : personne n'est devant l'ecran.
  const neuf = entrant('Vous etes la ?', il(2000))
  let reponse = { messages: [neuf], taches: [], dernier: T1, complet: true, curseur: 'C' }
  const v = monterDirect({
    conversations: [conv('B1', [entrant('Bonjour', T1)])],
    repondre: (c) => c.startsWith('/api/messages?direct=1') ? reponse : {}
  })
  try {
    v.msg.direct.dernierGeste = Date.now() - 16 * MIN
    await v.msg.relireDirect()
    assert.ok(textesDuFil(v.doc).includes('Vous etes la ?'), 'le message doit s afficher')
    assert.equal(v.appels.filter(a => a.corps && a.corps.action === 'lu').length, 0, 'marque lu alors que personne n etait la')
    reponse = { messages: [], taches: [], dernier: T1, complet: true, curseur: 'C' }
    v.delais.length = 0
    v.doc.dispatchEvent(new v.banc.window.KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    await B.reposer(v.banc)
    assert.equal(v.appels.filter(a => a.corps && a.corps.action === 'lu').length, 1, 'le geste de retour doit lire le fil ouvert')
    assert.equal(v.directs().length, 2, 'le geste de retour doit relire tout de suite')
    assert.ok(v.delais.includes(5000), 'le rythme du fil doit revenir')
  } finally { v.fermer() }
})

test('session expiree (401) : la relecture s arrete ET le dit', async () => {
  const v = monterDirect({
    conversations: [conv('B1', [entrant('Bonjour', T1)])],
    repondre: (c) => c.startsWith('/api/messages?direct=1') ? { __statut: 401, __corps: { error: 'x' } } : {}
  })
  try {
    await v.msg.relireDirect()
    assert.equal(v.msg.direct.arret, true)
    assert.equal(v.doc.querySelector('[data-bind="fil-direct-panne"]').hidden, false, 'l arret est silencieux')
  } finally { v.fermer() }
})

test('le defilement n est pas un geste : la page qui defile seule reste « oubliee »', () => {
  // Review 1, constat 7 : la page fait defiler le fil a chaque message ; si
  // `scroll` comptait comme un geste, une page oubliee restait a 5 s.
  const v = monterDirect({ conversations: [conv('B1', [entrant('Bonjour', T1)])] })
  try {
    v.msg.direct.dernierGeste = Date.now() - 16 * MIN
    v.doc.querySelector('[data-list="fil"]').dispatchEvent(new v.banc.window.Event('scroll'))
    v.delais.length = 0
    v.msg.planifierDirect()
    assert.deepEqual(v.delais, [60000])
  } finally { v.fermer() }
})

// ─── Review 2 : les quatre scenarios qu'elle a rejoues, portes ici ───────────

test('LE TEST QUI COMPTE : 409 a l envoi, puis le cron REND la proposition a l hote — elle revient', async () => {
  // Review 2, constat 2 : la memoire des propositions retirees n'avait pas de
  // date ; une tache retiree sur un 409 « deja partie », puis rendue par le
  // cron (envoi non delivre), restait cachee pour toujours.
  const tache = { id: 'x1', book_id: 'B1', property_id: '209413', suggested_reply: 'Le code est 4821', summary: '',
    status: 'pending_validation', created_at: il(MIN), send_after: il(1000) }
  let serveur = []
  const v = monterDirect({
    conversations: [conv('B1', [entrant('Bonjour', T1)])], taches: [{ ...tache }],
    repondre: (chemin, corps) => {
      if (chemin.startsWith('/api/messages?direct=1')) return { messages: [], taches: serveur.map(x => ({ ...x })), dernier: T1, complet: true, curseur: 'C' }
      if (corps && corps.action === 'reserver') return { __statut: 409, __corps: { error: 'deja_close', statut: 'sending' } }
      return { ok: true }
    }
  })
  try {
    v.doc.querySelector('[data-envoyer-prop="x1"]').click()
    for (let i = 0; i < 50 && v.msg.etat.taches.length; i++) await attendre(5)
    assert.equal(v.msg.etat.taches.length, 0, 'jeu d essai : sur le 409, la proposition est retiree')
    await attendre(5)
    serveur = [{ ...tache, send_after: null, summary: 'Reponse differee NON DELIVREE : verifiez-la et renvoyez-la.' }]
    await v.msg.relireDirect()
    assert.ok(v.msg.etat.taches.some(x => x.id === 'x1'), 'la proposition rendue a l hote ne revient jamais')
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : pendant la cloture d une proposition SANS echeance, aucun bouton « Envoyer » — un seul envoi', async () => {
  // Review 2, constat 1 : sur ce chemin la tache reste pending_validation en
  // base jusqu'a la cloture ; un cycle la remettait a l'ecran avec « Envoyer ».
  const base = { statut: 'pending_validation' }
  const coeur = [], envois = []
  let libererCloture
  const tache = { id: 'x1', book_id: 'B1', property_id: '209413', suggested_reply: 'Texte IA', summary: '', status: 'pending_validation', created_at: il(MIN) }
  const v = monterDirect({
    conversations: [conv('B1', [entrant('Bonjour', T1)])], taches: [{ ...tache }],
    repondre: (chemin, corps) => {
      if (chemin.startsWith('/api/messages?direct=1')) return { messages: [...coeur], taches: base.statut === 'pending_validation' ? [{ ...tache }] : [], dernier: T1, complet: true, curseur: 'C' }
      if (chemin === '/api/channel-message' || chemin === '/api/beds24') {
        envois.push(corps.message)
        coeur.push({ sender: 'host', direction: 'outbound', body: corps.message, sent_at: new Date().toISOString(), kind: 'message', origine: corps.origine })
        return { success: true }
      }
      if (corps && corps.action === 'reserver') {
        if (base.statut !== 'pending_validation') return { __statut: 409, __corps: { error: 'deja_close', statut: base.statut } }
        base.statut = 'sending'; return { ok: true }
      }
      if (corps && corps.action === 'proposition') return new Promise(r => { libererCloture = () => { base.statut = 'done'; r({ ok: true }) } })
      return { ok: true }
    }
  })
  try {
    v.msg.modifierProposition('x1')
    v.doc.querySelector('[data-bind="texte"]').value = 'Texte retouche'
    v.banc.window.envoyer()
    for (let i = 0; i < 100 && !libererCloture; i++) await attendre(5)
    assert.ok(libererCloture, 'jeu d essai : la cloture est en vol')
    await v.msg.relireDirect()
    const bouton = v.doc.querySelector('[data-list="fil"] [data-envoyer-prop="x1"]')
    assert.equal(bouton, null, 'le bouton « Envoyer » de la proposition deja partie est revenu')
    libererCloture()
    await attendre(30)
    assert.deepEqual(envois, ['Texte retouche'])
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : l hote change de fil pendant l envoi, la liste est relue — la cloture part quand meme', async () => {
  // Review 2, scenario D.
  let libererEnvoi
  const posts = []
  const v = monterDirect({
    conversations: [conv('B1', [entrant('Bonjour', T1)]), conv('B2', [entrant('Autre', il(2 * MIN))], { guestName: 'Paul' })],
    taches: [{ id: 'x1', book_id: 'B1', property_id: '209413', suggested_reply: 'Texte IA', summary: '', status: 'pending_validation',
      created_at: il(MIN), send_after: new Date(Date.now() + 10 * MIN).toISOString() }],
    repondre: (chemin, corps) => {
      if (corps) posts.push(corps.action || chemin)
      if (chemin.startsWith('/api/messages?direct=1')) return { messages: [], taches: [], dernier: new Date().toISOString(), complet: true, curseur: 'C' }
      if (chemin.startsWith('/api/messages?limit=')) return { conversations: [conv('B1', [entrant('Bonjour', T1)]), conv('B2', [entrant('Autre', il(1000))], { guestName: 'Paul' })], lu_le: new Date().toISOString() }
      if (chemin === '/api/beds24' || chemin === '/api/channel-message') return new Promise(r => { libererEnvoi = () => r({ success: true }) })
      return { ok: true }
    }
  })
  try {
    v.msg.modifierProposition('x1')
    v.doc.querySelector('[data-bind="texte"]').value = 'Texte retouche'
    v.banc.window.envoyer()
    for (let i = 0; i < 100 && !libererEnvoi; i++) await attendre(5)
    assert.ok(libererEnvoi, 'jeu d essai : l envoi doit etre en vol')
    v.msg.ouvrir('B2')
    await v.msg.relireDirect()
    libererEnvoi()
    for (let i = 0; i < 100 && !posts.includes('proposition'); i++) await attendre(5)
    assert.ok(posts.includes('proposition'), 'la cloture n est jamais partie : ' + JSON.stringify(posts))
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : un message dans un AUTRE fil — la liste est relue UNE fois, pas a chaque minute', async () => {
  // Review 2, constat 3 : le « dernier » connu etait remplace par le lastTime
  // de la liste, qui ne le rattrapait jamais ; la liste (31 Ko) etait relue
  // chaque minute pour un seul message.
  const V0 = Date.now() - 2 * MIN
  const M = new Date(V0 - 3000).toISOString()
  let lectures = 0
  const v = monterDirect({
    conversations: [conv('B1', [entrant('Bonjour', T1)])], luLe: new Date(V0 - 30000).toISOString(),
    repondre: (chemin) => {
      if (chemin.startsWith('/api/messages?direct=1')) return { messages: [], taches: [], dernier: M, complet: true, curseur: 'C' }
      if (chemin.startsWith('/api/messages?limit=')) {
        const luLe = new Date(V0 + lectures * MIN).toISOString(); lectures++
        return { conversations: [conv('B1', [entrant('Bonjour', T1)]), conv('B2', [entrant('Coucou', M)], { guestName: 'Paul' })], lu_le: luLe }
      }
      return { ok: true }
    }
  })
  try {
    for (let minute = 0; minute < 4; minute++) {
      v.msg.direct.derniereListe = Date.now() - 61000
      await v.msg.relireDirect()
    }
    assert.equal(lectures, 1, 'un seul message neuf, liste relue ' + lectures + ' fois')
  } finally { v.fermer() }
})

test('le premier curseur d un fil part de la lecture qui a produit SES messages, pas de la derniere lecture de la liste', async () => {
  // Review 2, constat 5 : une conversation chargee par « Afficher plus » (ou
  // sortie de la page 1) gardait le `lu_le` global, plus recent que ses
  // messages ; une insertion antidatee entre les deux ne s'affichait jamais.
  const luConv = il(30 * MIN)
  const v = monterDirect({
    conversations: [conv('B1', [entrant('Bonjour', T1)], { _luLe: luConv })], luLe: new Date().toISOString(),
    repondre: (c) => c.startsWith('/api/messages?direct=1') ? { messages: [], taches: [], dernier: T1, complet: true, curseur: 'C' } : {}
  })
  try {
    await v.msg.relireDirect()
    const depuis = new URL(v.directs()[0].chemin, 'https://x.test').searchParams.get('depuis')
    assert.ok(new Date(depuis) <= new Date(luConv), 'le fil part de la derniere lecture de la liste : ' + depuis)
  } finally { v.fermer() }
})

// ─── Review 3 : les scenarios qu'elle a rejoues, portes ici ─────────────────
//
// Une BASE simulee : le statut de chaque proposition (`reserver` la claime,
// 409 si elle n'est plus `pending_validation`), ce qui part au voyageur, et ce
// que le coeur rend. Les lectures (direct, RLS de `agent_tasks`) rendent les
// propositions encore `pending_validation` — comme le vrai serveur.
function monterBase ({ taches, conversations, cloture = null, envoi = null, lecture = null } = {}) {
  const statuts = Object.fromEntries(taches.map(t => [t.id, 'pending_validation']))
  const envois = [], coeur = []
  const ouvertes = (fil) => taches.filter(t => statuts[t.id] === 'pending_validation' && (fil == null || t.book_id === fil)).map(t => ({ ...t }))
  const v = monterDirect({
    conversations: conversations || [conv('B1', [entrant('Bonjour', T1)]), conv('B2', [entrant('Autre', il(2 * MIN))], { guestName: 'Paul' })],
    taches: taches.map(t => ({ ...t })),
    repondre: (chemin, corps) => {
      if (chemin.startsWith('/api/messages?direct=1')) {
        const fil = new URL(chemin, 'https://x.test').searchParams.get('fil')
        // La reponse est CALCULEE a la lecture ; `lecture` peut la retenir.
        const rendu = { messages: [...coeur], taches: ouvertes(fil), dernier: T1, complet: true, curseur: 'C' }
        return lecture ? lecture(rendu) : rendu
      }
      if (chemin === '/api/channel-message' || chemin === '/api/beds24') {
        envois.push(corps.message)
        coeur.push({ sender: 'host', direction: 'outbound', body: corps.message, sent_at: new Date().toISOString(), kind: 'message', origine: corps.origine })
        return envoi ? envoi(envois.length) : { success: true }
      }
      if (chemin === '/api/guestflow-proposer') return { proposition: { id: 'x9' } }
      if (corps && corps.action === 'relacher') {
        if (statuts[corps.task_id] === 'sending') statuts[corps.task_id] = 'pending_validation'
        return { ok: true, desarmee: true }
      }
      if (corps && corps.action === 'reserver') {
        if (statuts[corps.task_id] !== 'pending_validation') return { __statut: 409, __corps: { error: 'deja_prise', statut: statuts[corps.task_id] } }
        statuts[corps.task_id] = 'sending'; return { ok: true }
      }
      if (corps && corps.action === 'proposition') {
        if (cloture) { const r = cloture(corps, statuts); if (r) return r }
        if (!['pending_validation', 'sending'].includes(statuts[corps.task_id])) return { __statut: 409, __corps: { error: 'deja_close', statut: statuts[corps.task_id] } }
        statuts[corps.task_id] = corps.statut; return { ok: true }
      }
      return { ok: true }
    }
  })
  // La lecture RLS de `agent_tasks` (« Proposer », relecture de la liste).
  const vraie = v.banc.window.__table
  v.banc.window.__table = (nom) => {
    if (nom !== 'agent_tasks') return vraie(nom)
    const q = new Proxy({}, { get (_, cle) {
      if (cle === 'then') return (ok, ko) => Promise.resolve({ data: ouvertes(null), error: null }).then(ok, ko)
      return () => q
    } })
    return q
  }
  return { ...v, statuts, envois }
}
const proposition = (id, texte, extra = {}) => ({ id, book_id: 'B1', property_id: '209413', suggested_reply: texte, summary: '', status: 'pending_validation', created_at: il(MIN), ...extra })
const envoyerRetouche = async (v, id, texte = 'Texte retouche') => {
  v.msg.modifierProposition(id)
  v.doc.querySelector('[data-bind="texte"]').value = texte
  v.banc.window.envoyer()
}
const boutonEnvoyer = (v, id) => v.doc.querySelector(`[data-list="fil"] [data-envoyer-prop="${id}"]`)

for (const statut of [503, 500]) {
  test(`LE TEST QUI COMPTE : cloture en echec (${statut}) apres un envoi reussi — la proposition ne revient pas avec « Envoyer »`, async () => {
    // Review 3, constat 1 : sans reservation, la tache restait
    // `pending_validation` ; le cycle suivant la rendait, un clic envoyait le
    // texte de l'IA en second.
    const v = monterBase({ taches: [proposition('x1', 'Texte IA')], cloture: () => ({ __statut: statut, __corps: { error: 'Enregistrement impossible' } }) })
    try {
      await envoyerRetouche(v, 'x1')
      for (let i = 0; i < 100 && v.msg.etat.taches.length; i++) await attendre(5)
      assert.equal(v.msg.etat.taches.length, 0, 'jeu d essai : apres la cloture ratee, la page retire la proposition')
      assert.equal(v.statuts.x1, 'sending', 'la proposition n a pas ete reservee')
      await attendre(5)
      await v.msg.relireDirect()
      const b = boutonEnvoyer(v, 'x1')
      if (b) { b.click(); for (let i = 0; i < 100 && v.envois.length < 2; i++) await attendre(5) }
      assert.equal(b, null, 'le bouton « Envoyer » est revenu')
      assert.deepEqual(v.envois, ['Texte retouche'])
    } finally { v.fermer() }
  })
}

test('cloture en echec par le bouton de la bulle : la proposition ne revient pas non plus', async () => {
  // Review 3, scenario E3 : ce chemin reservait deja — garde de non-regression.
  const v = monterBase({ taches: [proposition('x1', 'Texte IA')], cloture: () => ({ __statut: 503, __corps: { error: 'Enregistrement impossible' } }) })
  try {
    boutonEnvoyer(v, 'x1').click()
    for (let i = 0; i < 100 && v.msg.etat.taches.length; i++) await attendre(5)
    await attendre(5)
    await v.msg.relireDirect()
    assert.equal(boutonEnvoyer(v, 'x1'), null)
    assert.deepEqual(v.envois, ['Texte IA'])
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : l hote change de fil et revient PENDANT l appel au canal — pas de « Envoyer », un seul envoi', async () => {
  // Review 3, constat 2, scenario F.
  const enVol = []
  const v = monterBase({ taches: [proposition('x1', 'Texte IA')], envoi: (n) => n === 1 ? new Promise(r => enVol.push(() => r({ success: true }))) : { success: true } })
  try {
    await envoyerRetouche(v, 'x1')
    for (let i = 0; i < 100 && !enVol.length; i++) await attendre(5)
    assert.equal(enVol.length, 1, 'jeu d essai : l envoi est en vol')
    v.msg.ouvrir('B2')
    v.msg.ouvrir('B1')
    const b = boutonEnvoyer(v, 'x1')
    if (b) b.click()
    await attendre(30)
    enVol[0]()
    await attendre(50)
    assert.equal(b, null, 'le bouton « Envoyer » de la proposition en cours d envoi est a l ecran')
    assert.deepEqual(v.envois, ['Texte retouche'])
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : « Modifier » une AUTRE proposition pendant l appel au canal — pas de « Envoyer » sur la premiere', async () => {
  // Review 3, constat 2, scenario F2.
  const enVol = []
  const v = monterBase({
    taches: [proposition('x1', 'Texte IA'), proposition('x2', 'Autre proposition', { created_at: il(MIN / 2) })],
    envoi: (n) => n === 1 ? new Promise(r => enVol.push(() => r({ success: true }))) : { success: true }
  })
  try {
    await envoyerRetouche(v, 'x1')
    for (let i = 0; i < 100 && !enVol.length; i++) await attendre(5)
    v.banc.repondreConfirm(true)
    v.msg.modifierProposition('x2')
    const b = boutonEnvoyer(v, 'x1')
    if (b) b.click()
    await attendre(30)
    enVol[0]()
    await attendre(50)
    assert.equal(b, null)
    assert.deepEqual(v.envois, ['Texte retouche'])
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : « Proposer » pendant la cloture — la proposition deja partie ne revient pas', async () => {
  // Review 3, constat 2, scenario H : `rechargerTaches` remplace les objets ;
  // l'etat « en cours » disparaissait avec eux.
  let liberer
  const v = monterBase({
    taches: [proposition('x1', 'Texte IA')],
    cloture: (corps, statuts) => corps.task_id === 'x1' && !liberer
      ? new Promise(r => { liberer = () => { statuts.x1 = 'done'; r({ ok: true }) } }) : null
  })
  try {
    await envoyerRetouche(v, 'x1')
    for (let i = 0; i < 100 && !liberer; i++) await attendre(5)
    assert.ok(liberer, 'jeu d essai : cloture en vol')
    v.banc.window.proposer()
    await attendre(30)
    const b = boutonEnvoyer(v, 'x1')
    if (b) b.click()
    await attendre(30)
    liberer()
    await attendre(30)
    assert.equal(b, null)
    assert.deepEqual(v.envois, ['Texte retouche'])
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : l horloge du poste recule pendant une relecture — la proposition close ne revient pas', async () => {
  // Review 3, constat 3, scenario I : retrait et demande etaient dates par
  // `Date.now()`, que le reglage du poste fait reculer.
  let libererLecture = null
  const v = monterBase({
    taches: [proposition('x1', 'Texte IA')],
    // La premiere relecture est LUE maintenant (avant la cloture), rendue plus tard.
    lecture: (rendu) => libererLecture ? rendu : new Promise(r => { libererLecture = () => r(rendu) })
  })
  const vraiNow = v.banc.window.Date.now.bind(v.banc.window.Date)
  try {
    const cycle = v.msg.relireDirect()
    for (let i = 0; i < 100 && !libererLecture; i++) await attendre(5)
    assert.ok(libererLecture, 'jeu d essai : la lecture est en vol')
    v.banc.window.Date.now = () => vraiNow() - 3000
    boutonEnvoyer(v, 'x1').click()
    for (let i = 0; i < 100 && v.statuts.x1 !== 'done'; i++) await attendre(5)
    await attendre(10)
    assert.equal(v.statuts.x1, 'done', 'jeu d essai : la proposition est close')
    libererLecture(); await cycle
    assert.equal(v.msg.etat.taches.some(x => x.id === 'x1'), false, 'proposition close ressuscitee par une reponse lue avant la cloture')
    assert.equal(v.doc.querySelector('[data-list="fil"] [data-modifier="x1"]'), null)
  } finally { v.banc.window.Date.now = vraiNow; v.fermer() }
})

test('pendant la cloture d un texte retouche, le fil ne montre pas le texte de l IA « en cours d envoi »', async () => {
  // Review 3, constat 4, scenario G : c'est le texte de la SAISIE qui est
  // parti ; la proposition « Envoi… » y montrait celui de l'IA.
  for (const coeurLu of [false, true]) {
    let liberer
    const v = monterBase({
      taches: [proposition('x1', 'Texte IA')],
      cloture: (corps, statuts) => !liberer ? new Promise(r => { liberer = () => { statuts.x1 = 'done'; r({ ok: true }) } }) : null,
      lecture: (rendu) => coeurLu ? rendu : { ...rendu, messages: [] }
    })
    try {
      await envoyerRetouche(v, 'x1')
      for (let i = 0; i < 100 && !liberer; i++) await attendre(5)
      assert.ok(liberer, 'jeu d essai : la cloture est en vol')
      await v.msg.relireDirect()
      const fil = [...v.doc.querySelectorAll('[data-list="fil"] .bulle')].map(b => b.textContent.trim())
      assert.ok(!fil.some(t => /Texte IA/.test(t)), `coeur lu : ${coeurLu} — ${JSON.stringify(fil)}`)
      liberer()
      await attendre(20)
    } finally { v.fermer() }
  }
})

test('LE TEST QUI COMPTE : une proposition retiree PENDANT la lecture des propositions de la liste ne revient pas', async () => {
  // Review 3, constat 6 : `lueA` doit etre pris AVANT `lireTachesOuvertes`.
  let libererLecture = null
  const v = monterBase({ taches: [proposition('x1', 'Texte IA')] })
  const vraie = v.banc.window.__table
  v.banc.window.__table = (nom) => {
    if (nom !== 'agent_tasks') return vraie(nom)
    const lue = [{ ...proposition('x1', 'Texte IA') }]   // lue AVANT le retrait
    const q = new Proxy({}, { get (_, cle) {
      if (cle === 'then') return (ok, ko) => new Promise(r => { libererLecture = () => r({ data: lue, error: null }) }).then(ok, ko)
      return () => q
    } })
    return q
  }
  try {
    const enVol = v.msg.relireListe(T1)
    for (let i = 0; i < 100 && !libererLecture; i++) await attendre(5)
    assert.ok(libererLecture, 'jeu d essai : la lecture des propositions est en vol')
    v.banc.window.retirerTache(v.msg.etat.taches[0])
    libererLecture()
    await enVol
    assert.equal(v.msg.etat.taches.length, 0, 'la proposition retiree pendant la lecture est revenue')
  } finally { v.fermer() }
})

test('LE TEST QUI COMPTE : chaque lecture estampille SES conversations — premiere page, « Afficher plus », relecture', async () => {
  // Review 3, constat 6 : le test du curseur par conversation posait `_luLe`
  // lui-meme ; retirer l'estampille des lectures ne rougissait rien.
  const LU_PAGE2 = il(40 * MIN), LU_RELUE = il(MIN)
  const v = monterDirect({
    conversations: [conv('B1', [entrant('Bonjour', T1)])],
    repondre: (c) => {
      if (c.startsWith('/api/messages?direct=1')) return { messages: [], taches: [], dernier: T1, complet: true, curseur: 'C' }
      if (c.startsWith('/api/messages?limit=') && c.includes('before=')) {
        return { conversations: [conv('B5', [entrant('Ancien', il(50 * MIN))], { guestName: 'Eva' })], lu_le: LU_PAGE2, has_more: false }
      }
      if (c.startsWith('/api/messages?limit=')) return { conversations: [conv('B1', [entrant('Bonjour', T1)]), conv('B6', [entrant('Neuf', il(30000))], { guestName: 'Zoe' })], lu_le: LU_RELUE }
      return {}
    }
  })
  try {
    v.msg.etat.nextBefore = il(45 * MIN); v.msg.etat.nextBeforeId = 'B1'
    await v.msg.chargerPageSuivante()
    await v.msg.relireListe(T1)
    const luLe = (id) => (v.msg.etat.conversations.find(c => c.bookId === id) || {})._luLe
    assert.equal(luLe('B5'), LU_PAGE2, '« Afficher plus » n estampille pas ses conversations')
    assert.equal(luLe('B6'), LU_RELUE, 'la relecture de la liste n estampille pas ses conversations')
    // Et le fil ouvert part de SA lecture : ici B5, lue a la page 2.
    v.msg.ouvrir('B5')
    await v.msg.relireDirect()
    const d = v.directs().map(a => new URL(a.chemin, 'https://x.test').searchParams).filter(p => p.get('fil') === 'B5')
    assert.ok(d.length && new Date(d[0].get('depuis')) <= new Date(LU_PAGE2), 'le fil B5 ne part pas de sa propre lecture')
  } finally { v.fermer() }
})

test('la premiere page, lue par la vraie initialisation, estampille ses conversations', async () => {
  // Review 3, constat 6 : retirer l'estampille de `charger` ne rougissait rien.
  const LU = il(25000)
  const banc = B.monter({ appel: async (chemin) => chemin.startsWith('/api/messages?limit=')
    ? { conversations: [conv('B1', [entrant('Bonjour', T1)])], lu_le: LU }
    : chemin.startsWith('/api/messages?direct=1') ? { messages: [], taches: [], dernier: T1, complet: true, curseur: 'C' } : {} })
  try {
    await B.amorcer(banc)
    await B.reposer(banc)
    const c = banc.msg.etat.conversations.find(x => x.bookId === 'B1')
    assert.ok(c, 'jeu d essai : la premiere page est lue')
    assert.equal(c._luLe, LU)
  } finally { banc.window.clearTimeout(banc.msg.direct.minuteur); banc.fermer() }
})

test('l envoi au canal echoue : la proposition est relachee, et ne reste pas cachee hors de la saisie', async () => {
  // Review 3, constat 2 : l'etat « en cours » pose des le depart doit tomber
  // quand rien n'est parti. Sinon, des que l'edition est quittee (changer de
  // fil), la proposition reste invisible jusqu'au rechargement.
  const v = monterBase({ taches: [proposition('x1', 'Texte IA')], envoi: () => ({ __statut: 500, __corps: { error: 'canal indisponible' } }) })
  try {
    await envoyerRetouche(v, 'x1')
    for (let i = 0; i < 100 && v.statuts.x1 !== 'pending_validation' || i < 3; i++) await attendre(5)
    await attendre(20)
    assert.equal(v.statuts.x1, 'pending_validation', 'jeu d essai : la reservation est relachee')
    const x = v.msg.etat.taches.find(t => t.id === 'x1')
    assert.ok(x, 'la proposition a quitte l etat de la page')
    assert.equal(x.envoiSaisie, undefined, 'la proposition reste marquee « envoyee depuis la saisie »')
    assert.equal(x.etatEnvoi, undefined, 'la proposition reste « en cours »')
    v.msg.ouvrir('B2'); v.msg.ouvrir('B1')
    assert.ok(textesDuFil(v.doc).some(t => t.includes('Texte IA')), 'la proposition est cachee du fil : ' + JSON.stringify(textesDuFil(v.doc)))
    assert.ok(boutonEnvoyer(v, 'x1'), 'la proposition relachee n a plus son bouton')
  } finally { v.fermer() }
})
