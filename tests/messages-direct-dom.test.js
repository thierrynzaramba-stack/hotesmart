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
const conv = (bookId, messages, extra = {}) => ({
  bookId, propertyId: '209413', provider: 'channex', ota: 'Airbnb', platform: 'airbnb',
  guestName: 'Ana Lopez', firstNight: jour(0), lastNight: jour(3), status: 'confirmed',
  messages, lastTime: messages.length ? messages[messages.length - 1].sent_at : null, ...extra
})
const entrant = (body, sent_at) => ({ sender: 'guest', direction: 'inbound', body, sent_at, kind: 'message', origine: null })

function monterDirect ({ conversations, ouverte = 'B1', repondre = () => ({}), taches = [] } = {}) {
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
      ? { messages: [entrant('Bonjour', T1), neuf], taches: [], dernier: T1, complet: true } : {}
  })
  try {
    assert.deepEqual(textesDuFil(v.doc), ['Bonjour'])
    await v.msg.relireDirect()
    assert.deepEqual(textesDuFil(v.doc), ['Bonjour', 'Je suis devant la porte'])
    assert.equal(v.directs().length, 1, 'une relecture = un appel')
    const url = new URL(v.directs()[0].chemin, 'https://x.test')
    assert.equal(url.searchParams.get('fil'), 'B1')
    assert.equal(url.searchParams.get('apres'), new Date(T1).toISOString())
    assert.ok(!v.appels.some(a => a.chemin.startsWith('/api/messages?limit')), 'la liste entiere a ete relue pour rien')
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
    // Le point de reprise ignore la bulle locale : il part du dernier message du COEUR.
    const url = new URL(v.directs()[0].chemin, 'https://x.test')
    assert.equal(url.searchParams.get('apres'), new Date(T1).toISOString())
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
      : c.startsWith('/api/messages?limit=') ? { conversations: [conv('B3', [entrant('Nouveau voyageur', dernier)], { guestName: 'Paul' })] } : {}
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
