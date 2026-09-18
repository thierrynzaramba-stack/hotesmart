// tests/inbound-email.test.js
// Chantier « inbound e-mail » — etapes 4 et 5.
//
// CE QUE CES TESTS DEFENDENT, dans l'ordre d'importance :
//   1. le corps du webhook n'est JAMAIS cru — il n'est qu'un declencheur ;
//   2. le compte vient du jeton signe, jamais du message ;
//   3. une reponse automatique ne reveille pas l'agent (sinon : boucle) ;
//   4. un e-mail qu'on ne sait pas ranger ne se JETTE pas.

const test = require('node:test')
const assert = require('node:assert')
const Module = require('node:module')

process.env.SUPABASE_URL = 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = 'test'
process.env.ALERT_BREVO_API_KEY = 'cle-plateforme-de-test'
process.env.REPLY_TOKEN_SECRET = 'secret-de-test-suffisamment-long-pour-passer'

const etat = { resas: [], conversations: [], taches: [], messages: [], brevo: null, brevoStatus: 200, dejaVu: [] }

const origine = Module._load
Module._load = function (d, ...reste) {
  if (d === '@supabase/supabase-js') return {
    createClient: () => ({
      from (table) {
        const b = {
          _t: table,
          select: () => b, eq: () => b, gte: () => b, order: () => b, in: () => b,
          limit () {
            return Promise.resolve({
              data: b._t === 'bookings_snapshot' ? etat.resas : etat.dejaVu, error: null
            })
          },
          insert: async (row) => {
            if (b._t === 'conversations') etat.conversations.push(row)
            if (b._t === 'agent_tasks') etat.taches.push(row)
            return { error: null }
          }
        }
        return b
      }
    })
  }
  if (d === '../lib/record-message') return {
    recordMessage: async o => { etat.messages.push(o); return { ok: true } }
  }
  return origine.apply(this, [d, ...reste])
}

const fetchOrigine = global.fetch
global.fetch = async (url) => {
  etat.appelsBrevo = (etat.appelsBrevo || 0) + 1
  etat.derniereUrl = String(url)
  return { ok: etat.brevoStatus === 200, status: etat.brevoStatus,
           json: async () => etat.brevo || {} }
}

const handler = require('../api/inbound-email.js')
const { adresseDeReponse } = require('../lib/jeton-reponse')
test.after(() => { Module._load = origine; global.fetch = fetchOrigine })

const BOOKING = 'c87f24ce-9587-4d5e-841f-e8ef6d34edfd'
const ADRESSE = adresseDeReponse(BOOKING)
const RESA = {
  user_id: 'compte-A', booking_id: BOOKING, property_id: 'prop-1',
  snapshot: { firstName: 'Marie', lastName: 'Durand', source: 'Offline', provider: 'channex' }
}

function reponse () {
  const r = { code: null, corps: null }
  r.status = c => { r.code = c; return r }
  r.json = o => { r.corps = o; return r }
  return r
}
const appel = async (body) => {
  const res = reponse()
  await handler({ method: 'POST', body }, res)
  return res
}

function remise (evenement, o = {}) {
  etat.resas = o.resas !== undefined ? o.resas : [RESA]
  etat.brevo = evenement ? { events: [evenement] } : null
  etat.brevoStatus = o.brevoStatus || 200
  etat.conversations = []; etat.taches = []; etat.messages = []; etat.dejaVu = []
  etat.appelsBrevo = 0
}
const mail = (o = {}) => ({
  Uuid: 'uuid-1', From: 'marie@exemple.test', To: [{ Address: ADRESSE }],
  Subject: 'Re: votre séjour', ExtractedMarkdownMessage: 'Bonjour, une question.',
  Headers: o.headers || {}, Spam: { Score: o.spam ?? 0 }, ...o.champs
})

// ─── 1. Le corps n'est jamais cru ───────────────────────────────────────────
test('LE TEST QUI COMPTE : le contenu vient de BREVO, pas du POST', async () => {
  // Le webhook n'est pas authentifiable : si on lisait son corps, n'importe qui
  // pourrait injecter un message dans le fil de n'importe quel hote.
  remise(mail())
  const res = await appel({ Uuid: 'uuid-1', ExtractedMarkdownMessage: 'TEXTE INJECTE PAR L ATTAQUANT' })
  assert.strictEqual(res.corps.reason, 'ok')
  assert.strictEqual(etat.messages[0].body, 'Bonjour, une question.', 'le corps relu, pas le corps poste')
  assert.ok(etat.appelsBrevo >= 1, 'Brevo a bien ete interroge')
})

test('relecture impossible : on n\'ecrit RIEN', async () => {
  remise(mail(), { brevoStatus: 503 })
  const res = await appel({ Uuid: 'uuid-1' })
  assert.strictEqual(res.corps.reason, 'relecture_impossible')
  assert.strictEqual(etat.messages.length, 0)
  assert.strictEqual(etat.conversations.length, 0)
})

test('on acquitte TOUJOURS en 200, meme quand on ignore', async () => {
  // Un 4xx/5xx fait rejouer Brevo indefiniment sur un e-mail qu'on a decide
  // d'ignorer. Ce qu'on ne traite pas se journalise, ca ne se renvoie pas.
  for (const cas of [{}, { Uuid: 'x' }, { items: [] }]) {
    remise(null, { brevoStatus: 500 })
    const res = await appel(cas)
    assert.strictEqual(res.code, 200, JSON.stringify(cas))
  }
})

// ─── 2. Le compte vient du jeton ────────────────────────────────────────────
test('LE TEST QUI COMPTE : le compte et le bien viennent de la RESERVATION', async () => {
  remise(mail())
  await appel({ Uuid: 'uuid-1' })
  assert.strictEqual(etat.messages[0].userId, 'compte-A')
  assert.strictEqual(etat.messages[0].propertyId, 'prop-1')
  assert.strictEqual(etat.messages[0].canal, 'email')
  assert.strictEqual(etat.messages[0].direction, 'inbound')
  assert.strictEqual(etat.messages[0].sender, 'guest')
})

test('LE TEST QUI COMPTE : une adresse SIGNEE POUR AUTRE CHOSE est refusee', async () => {
  const forgee = 'c87f24ce95874d5e841fe8ef6d34edfd-000000000000@reply.hotesmart.fr'
  remise(mail({ champs: { To: [{ Address: forgee }] } }))
  const res = await appel({ Uuid: 'uuid-1' })
  assert.strictEqual(res.corps.reason, 'jeton_refuse')
  assert.strictEqual(etat.messages.length, 0, 'rien n\'entre dans le cœur')
  assert.strictEqual(etat.taches.length, 1, 'mais ca ne se perd pas')
})

test('deux reservations pour un meme identifiant : on REFUSE de choisir', async () => {
  // `booking_id` n'est unique que par compte : repondre au hasard ferait entrer
  // le message d'un voyageur dans le fil d'un autre hote.
  remise(mail(), { resas: [RESA, { ...RESA, user_id: 'compte-B' }] })
  const res = await appel({ Uuid: 'uuid-1' })
  assert.strictEqual(res.corps.reason, 'reservation_ambigue')
  assert.strictEqual(etat.messages.length, 0)
  assert.strictEqual(etat.taches.length, 1)
})

// ─── 3. L'anti-boucle ───────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : une reponse automatique ne reveille pas l\'agent', async () => {
  // L'agent IA lit `messages`. Y ecrire un « je suis en vacances » le ferait
  // repondre, ce qui declencherait un nouvel automatique : une boucle qui
  // tourne aussi vite que les deux serveurs le permettent.
  const cas = [
    { 'Auto-Submitted': 'auto-replied' },
    { 'X-Autoreply': 'yes' },
    { 'Precedence': 'bulk' },
    { 'List-Id': '<liste.exemple.test>' },
    { 'X-Loop': 'moi' }
  ]
  for (const headers of cas) {
    remise(mail({ headers }))
    const res = await appel({ Uuid: 'uuid-1' })
    assert.strictEqual(res.corps.reason, 'automatique_ignore', JSON.stringify(headers))
    assert.strictEqual(etat.messages.length, 0)
  }
})

test('`Auto-Submitted: no` est un message HUMAIN, il passe', async () => {
  // La RFC 3834 le dit explicitement : rejeter sur la seule presence de
  // l'en-tete etoufferait de vraies reponses.
  remise(mail({ headers: { 'Auto-Submitted': 'no' } }))
  const res = await appel({ Uuid: 'uuid-1' })
  assert.strictEqual(res.corps.reason, 'ok')
})

test('un score de spam eleve est ignore', async () => {
  remise(mail({ spam: 9 }))
  assert.strictEqual((await appel({ Uuid: 'uuid-1' })).corps.reason, 'automatique_ignore')
})

test('les en-tetes sont lus quelle que soit leur casse et leur forme', async () => {
  for (const headers of [{ 'AUTO-SUBMITTED': 'auto-generated' },
                         [{ Name: 'Precedence', Value: 'junk' }]]) {
    remise(mail({ headers }))
    assert.strictEqual((await appel({ Uuid: 'uuid-1' })).corps.reason, 'automatique_ignore')
  }
})

// ─── 4. La file des non-rattachables ────────────────────────────────────────
test('LE TEST QUI COMPTE : un e-mail non rattachable NE SE PERD PAS', async () => {
  // Un voyageur qui repond depuis une autre adresse disparaitrait en silence,
  // et l'hote ne saurait jamais qu'on lui a ecrit.
  remise(mail({ champs: { To: [{ Address: 'contact@hotesmart.fr' }] } }))
  const res = await appel({ Uuid: 'uuid-1' })
  assert.strictEqual(res.corps.reason, 'sans_adresse_de_reponse')
  assert.strictEqual(etat.taches.length, 1)
  const t = etat.taches[0]
  assert.strictEqual(t.task_type, 'email_non_rattache')
  assert.strictEqual(t.status, 'pending_validation')
  assert.ok(/aucune adresse de réponse/.test(t.summary), 'la raison est dite')
  assert.ok(t.guest_message.includes('une question'), 'et le message est conserve')
})

test('reservation introuvable : en attente, pas a la poubelle', async () => {
  remise(mail(), { resas: [] })
  const res = await appel({ Uuid: 'uuid-1' })
  assert.strictEqual(res.corps.reason, 'reservation_introuvable')
  assert.strictEqual(etat.taches.length, 1)
})

// ─── Le corps utile ─────────────────────────────────────────────────────────
test('on garde le MESSAGE, pas la conversation citee', async () => {
  // Sans ca, chaque reponse rapporterait tout le fil, que l'agent relirait
  // comme une nouvelle question.
  remise(mail({ champs: {
    ExtractedMarkdownMessage: 'Ma question.',
    RawTextBody: 'Ma question.\n\n> Le 12 sept, vous avez écrit :\n> tout le fil…'
  } }))
  await appel({ Uuid: 'uuid-1' })
  assert.strictEqual(etat.messages[0].body, 'Ma question.')
})

test('sans message extrait, on retombe sur le texte brut', async () => {
  remise(mail({ champs: { ExtractedMarkdownMessage: '', RawTextBody: 'Texte brut.' } }))
  await appel({ Uuid: 'uuid-1' })
  assert.strictEqual(etat.messages[0].body, 'Texte brut.')
})

test('le fil de l\'hote recoit la meme chose que le cœur', async () => {
  remise(mail())
  await appel({ Uuid: 'uuid-1' })
  assert.strictEqual(etat.conversations.length, 1)
  assert.strictEqual(etat.conversations[0].guest_name, 'Marie Durand')
  assert.strictEqual(etat.conversations[0].book_id, BOOKING)
  assert.strictEqual(etat.conversations[0].agent_reply, null, 'l\'agent n\'a pas encore repondu')
})
