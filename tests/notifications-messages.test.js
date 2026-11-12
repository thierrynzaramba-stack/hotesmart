// tests/notifications-messages.test.js
// PWA lot 2c-2, domaine Messages (docs/kb/pwa.md §11.2) : urgence (b),
// information manquante (c), réponse à valider (d), nouveau message (e), pause
// automatique (k) — leurs textes, leur module (lib/notifications/evenements-
// messages.js), et leurs trois émetteurs : lib/cron-classify.js,
// lib/record-message.js, lib/cron-alerting.js.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')

const textes = require('../lib/notifications/textes')
const ev = require('../lib/notifications/evenements-messages')

const COMPTE = 'compte-1'
const AUTRE = 'compte-2'
const UUID_BIEN = '3f2a1b4c-1111-4222-8333-944455556666'

// ─── Un faux Supabase minimal (lectures filtrées, insertions, pannes) ────────
function fakeSupabase (tables, { pannes = [], insertionsRefusees = [] } = {}) {
  const filtre = (rows, f) => rows.filter(r => {
    switch (f.op) {
      case 'eq': return String(r[f.col]) === String(f.val)
      case 'in': return f.val.map(String).includes(String(r[f.col]))
      case 'is': return f.val === null ? r[f.col] == null : r[f.col] === f.val
      case 'not': return !(f.val === null ? r[f.col] == null : r[f.col] === f.val)
      case 'gte': return String(r[f.col]) >= String(f.val)
      default: throw new Error('filtre inconnu ' + f.op)
    }
  })
  return {
    from (table) {
      const q = { filtres: [], ordre: null, limite: null, mode: 'select', charge: null }
      const b = {
        select () { return b },
        eq (col, val) { q.filtres.push({ op: 'eq', col, val }); return b },
        in (col, val) { q.filtres.push({ op: 'in', col, val }); return b },
        is (col, val) { q.filtres.push({ op: 'is', col, val }); return b },
        not (col, op, val) { q.filtres.push({ op: 'not', col, val }); return b },
        gte (col, val) { q.filtres.push({ op: 'gte', col, val }); return b },
        update (row) { q.mode = 'update'; q.charge = row; return b },
        order (col, o) { q.ordre = { col, asc: !o || o.ascending !== false }; return b },
        limit (n) { q.limite = n; return b },
        insert (row) { q.mode = 'insert'; q.charge = row; return b },
        maybeSingle () { q.single = true; return b },
        then (res, rej) {
          try {
            if (pannes.includes(table)) return res({ data: null, error: { message: 'panne simulee' } })
            if (q.mode === 'insert') {
              if (insertionsRefusees.includes(table)) return res({ data: null, error: { message: 'insertion refusee' } })
              ;(tables[table] = tables[table] || []).push({ created_at: new Date().toISOString(), ...q.charge })
              return res({ data: null, error: null })
            }
            if (q.mode === 'update') {
              q.filtres.reduce(filtre, tables[table] || []).forEach(r => Object.assign(r, q.charge))
              return res({ data: null, error: null })
            }
            let rows = q.filtres.reduce(filtre, (tables[table] || []).slice())
            if (q.ordre) rows.sort((a, c) => (a[q.ordre.col] < c[q.ordre.col] ? -1 : 1) * (q.ordre.asc ? 1 : -1))
            if (q.limite != null) rows = rows.slice(0, q.limite)
            if (q.single) return res({ data: rows[0] || null, error: null })
            return res({ data: rows, error: null })
          } catch (e) { return rej(e) }
        }
      }
      return b
    }
  }
}

// ─── Les textes ──────────────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : le bien et le prénom, jamais le texte — aucune de ces notifications ne porte le message ni le résumé de l\'IA', () => {
  const secret = 'Le code de la boîte est 4521, la fuite est sous l’évier'
  for (const code of ['urgence_ia', 'info_manquante', 'brouillon_ia', 'message_voyageur', 'pause_automatique']) {
    for (const l of ['fr', 'en', 'es']) {
      // Même si un émetteur passait le texte, aucun gabarit ne le lirait.
      const t = textes.rediger(code, l, { bien: 'La bulle', prenom: 'Marie', message: secret, resume: secret, summary: secret })
      assert.ok(t && t.titre && t.corps, `${code}/${l}`)
      assert.ok(!JSON.stringify(t).includes('4521'), `${code}/${l}`)
    }
  }
  assert.deepStrictEqual(textes.rediger('message_voyageur', 'fr', { bien: 'La bulle', prenom: 'Marie' }),
    { titre: 'Nouveau message de Marie — La bulle', corps: 'Ouvrez la conversation pour le lire et répondre.' })
})

test('sans prénom ni nom de bien, les phrases restent françaises : « d’un voyageur », « d’Anne », « votre logement »', () => {
  assert.strictEqual(textes.rediger('message_voyageur', 'fr', { bien: 'B' }).titre, 'Nouveau message d’un voyageur — B')
  assert.strictEqual(textes.rediger('message_voyageur', 'fr', { bien: 'B', prenom: 'Anne' }).titre, 'Nouveau message d’Anne — B')
  assert.strictEqual(textes.rediger('message_voyageur', 'en', { bien: 'B' }).titre, 'New message from a guest — B')
  assert.strictEqual(textes.rediger('info_manquante', 'fr', { bien: 'B', arret: true }).corps,
    'L’IA s’est arrêtée sur la conversation d’un voyageur : répondez-lui à la main.')
  assert.strictEqual(textes.rediger('urgence_ia', 'fr', { prenom: 'Jean' }).titre, 'Urgence — votre logement')
  assert.strictEqual(textes.rediger('brouillon_ia', 'fr', { bien: 'B', prenom: 'Jean', differe: true }).corps,
    'L’IA a préparé une réponse pour Jean. Elle partira seule si vous ne faites rien.')
  assert.strictEqual(textes.rediger('brouillon_ia', 'fr', { bien: 'B', prenom: 'Jean', nonDelivree: true }).corps,
    'La réponse automatique à Jean n’est pas partie : vérifiez-la et renvoyez-la.')
})

// ─── Le module des événements ───────────────────────────────────────────────

function tablesDeBase () {
  return {
    // ⚠ L'AUTRE compte EN PREMIER : sans le filtre de compte, c'est lui qu'on lirait.
    properties: [
      { user_id: AUTRE, id: 'uuid-autre', provider_property_id: 'p1', name: 'Bien d\'un autre' },
      // Un bien archivé puis recréé sous la même référence : le bien actif gagne.
      { user_id: COMPTE, id: 'uuid-archive', provider_property_id: 'p1', name: 'Ancienne bulle', archive_le: '2026-10-01T00:00:00Z' },
      { user_id: COMPTE, id: UUID_BIEN, provider_property_id: 'p1', name: 'La bulle' }
    ],
    bookings_snapshot: [
      { user_id: AUTRE, booking_id: 'b1', snapshot: { firstName: 'Autre', arrival: '2099-01-01', departure: '2099-01-02' } },
      { user_id: COMPTE, booking_id: 'b1', snapshot: { firstName: 'Marie', arrival: '2026-11-12', departure: '2026-11-15' } }
    ]
  }
}

function capte () {
  const appels = []
  return { appels, deps: { notifier: async (o) => { appels.push(o); return { ok: true, erreurs: [] } } } }
}

test('LE TEST QUI COMPTE : UNE notification par conversation (décision du 9 novembre) — urgence, information, réponse, message : le même sujet, et chacune sonne', async () => {
  const db = fakeSupabase(tablesDeBase())
  const c = capte()
  const maintenant = Date.now()
  await ev.notifierMessageVoyageur({ compte: COMPTE, propertyId: 'p1', bookingId: 'b1', envoyeLe: new Date(maintenant - 60e3).toISOString(), maintenant, db, deps: c.deps })
  await ev.notifierEscalade({ compte: COMPTE, propertyId: 'p1', bookingId: 'b1', type: 'intervention', guestName: 'Marie Dupont', arrival: '2026-11-12', departure: '2026-11-15', db, deps: c.deps })
  await ev.notifierEscalade({ compte: COMPTE, propertyId: 'p1', bookingId: 'b1', type: 'info_unknown', guestName: 'Marie Dupont', db, deps: c.deps })
  await ev.notifierBrouillon({ compte: COMPTE, propertyId: 'p1', bookingId: 'b1', guestName: 'Marie', differe: true, db, deps: c.deps })
  assert.deepStrictEqual(c.appels.map(o => [o.compte, o.code, o.sujet, o.chemin, o.rappel, o.bien]), [
    [COMPTE, 'message_voyageur', 'conv:b1', '/pages/messages?conv=b1', true, { id: UUID_BIEN, ref: 'p1' }],
    [COMPTE, 'urgence_ia', 'conv:b1', '/pages/messages?conv=b1', true, { id: UUID_BIEN, ref: 'p1' }],
    [COMPTE, 'info_manquante', 'conv:b1', '/pages/messages?conv=b1', true, { id: UUID_BIEN, ref: 'p1' }],
    [COMPTE, 'brouillon_ia', 'conv:b1', '/pages/messages?conv=b1', true, { id: UUID_BIEN, ref: 'p1' }]
  ])
  assert.deepStrictEqual(c.appels[1].donnees, { bien: 'La bulle', prenom: 'Marie', arret: false })
  assert.deepStrictEqual(c.appels[1].sejour, { arrivee: '2026-11-12', depart: '2026-11-15' })
  assert.deepStrictEqual(c.appels[3].donnees, { bien: 'La bulle', prenom: 'Marie', differe: true, nonDelivree: false })
})

test('« Voyageur » n\'est pas un prénom ; une réservation inconnue n\'ouvre pas un fil au hasard ; l\'identifiant s\'encode', async () => {
  const c = capte()
  const db = fakeSupabase(tablesDeBase())
  await ev.notifierEscalade({ compte: COMPTE, propertyId: 'p1', bookingId: 'unknown', type: 'intervention', guestName: 'Voyageur', db, deps: c.deps })
  await ev.notifierBrouillon({ compte: COMPTE, propertyId: 'p1', bookingId: 'a&b=c/d', guestName: 'Guest', db, deps: c.deps })
  assert.deepStrictEqual(c.appels.map(o => [o.sujet, o.chemin, o.donnees.prenom]), [
    ['conv:bien:p1', '/pages/messages', null],
    ['conv:a&b=c/d', '/pages/messages?conv=a%26b%3Dc%2Fd', null]
  ])
  assert.strictEqual(textes.rediger('urgence_ia', 'en', c.appels[0].donnees).corps, 'A guest: the AI flagged an urgent message. Please reply.')
})

test('LE TEST QUI COMPTE : un nouveau message — récent seulement, prénom et séjour lus dans le cœur DU COMPTE, et il sonne', async () => {
  const maintenant = Date.parse('2026-11-09T10:00:00Z')
  const c = capte()
  await ev.notifierMessageVoyageur({ compte: COMPTE, propertyId: 'p1', bookingId: 'b1', envoyeLe: '2026-11-09T09:58:00Z', maintenant, db: fakeSupabase(tablesDeBase()), deps: c.deps })
  assert.strictEqual(c.appels.length, 1)
  const o = c.appels[0]
  assert.deepStrictEqual([o.code, o.sujet, o.chemin, o.rappel, o.bien, o.donnees, o.sejour],
    ['message_voyageur', 'conv:b1', '/pages/messages?conv=b1', true, { id: UUID_BIEN, ref: 'p1' }, { bien: 'La bulle', prenom: 'Marie' }, { arrivee: '2026-11-12', depart: '2026-11-15' }])
  // La borne des six heures, au plus près : 5 h 50 prévient, 6 h 10 non.
  await ev.notifierMessageVoyageur({ compte: COMPTE, propertyId: 'p1', bookingId: 'b1', envoyeLe: '2026-11-09T04:10:00Z', maintenant, db: fakeSupabase(tablesDeBase()), deps: c.deps })
  assert.strictEqual(c.appels.length, 2, '5 h 50')
  // Un import de rattrapage écrit des messages anciens : pas de notification.
  const r = await ev.notifierMessageVoyageur({ compte: COMPTE, propertyId: 'p1', bookingId: 'b1', envoyeLe: '2026-11-09T03:50:00Z', maintenant, db: fakeSupabase(tablesDeBase()), deps: c.deps })
  assert.deepStrictEqual(r, { ok: true, ignore: true, raison: 'message_ancien' }, '6 h 10')
  const r2 = await ev.notifierMessageVoyageur({ compte: COMPTE, propertyId: 'p1', bookingId: 'b1', envoyeLe: 'n importe quoi', maintenant, db: fakeSupabase(tablesDeBase()), deps: c.deps })
  assert.strictEqual(r2.ignore, true)
  assert.strictEqual(c.appels.length, 2)
})

test('la pause automatique : au titulaire, vers les réglages de l\'IA DU BIEN EN PAUSE (le fil qui l\'a déclenchée)', async () => {
  const c = capte()
  await ev.notifierPause({ compte: COMPTE, propertyId: 'p1', propertyUuid: UUID_BIEN, nom: 'La bulle', bookingId: 'b 1', deps: c.deps })
  await ev.notifierPause({ compte: COMPTE, propertyId: 'p1', deps: c.deps })
  assert.deepStrictEqual(c.appels.map(o => [o.code, o.sujet, o.chemin, o.bien, o.donnees]), [
    ['pause_automatique', 'pause:p1', '/pages/messages?conv=b%201&volet=ia', { id: UUID_BIEN, ref: 'p1' }, { bien: 'La bulle' }],
    ['pause_automatique', 'pause:p1', '/pages/messages?volet=ia', { id: undefined, ref: 'p1' }, { bien: null }]
  ])
})

test('aucun de ces événements ne lève, même quand le point d\'envoi lève', async () => {
  const deps = { notifier: async () => { throw new Error('boum') } }
  const db = fakeSupabase(tablesDeBase())
  for (const r of [
    await ev.notifierEscalade({ compte: COMPTE, propertyId: 'p1', bookingId: 'b1', type: 'intervention', db, deps }),
    await ev.notifierBrouillon({ compte: COMPTE, propertyId: 'p1', bookingId: 'b1', db, deps }),
    await ev.notifierMessageVoyageur({ compte: COMPTE, propertyId: 'p1', bookingId: 'b1', envoyeLe: new Date().toISOString(), db, deps }),
    await ev.notifierPause({ compte: COMPTE, propertyId: 'p1', deps })
  ]) assert.strictEqual(r.ok, false)
})

// ─── Émetteur 1 : le writer unique de `messages` ────────────────────────────

function enregistreur (tables, opts = {}) {
  delete require.cache[require.resolve('../lib/record-message')]
  const { recordMessage } = require('../lib/record-message')
  const notifies = []
  const db = fakeSupabase(tables, opts)
  const ecrire = (p) => recordMessage({ userId: COMPTE, provider: 'channex', propertyId: 'p1', bookingId: 'b1', supabase: db,
    notifierMessage: async (o) => { notifies.push(o) }, ...p })
  return { ecrire, notifies }
}

test('LE TEST QUI COMPTE : un message de voyageur RÉELLEMENT inséré prévient — un doublon, un écho, un sortant, non', async () => {
  const t = { messages: [], bookings_snapshot: [] }
  const { ecrire, notifies } = enregistreur(t)
  const quand = new Date().toISOString()
  const r1 = await ecrire({ direction: 'inbound', sender: 'guest', body: 'Bonjour', providerMsgId: 'm1', sentAt: quand })
  assert.deepStrictEqual(r1, { ok: true, skipped: false })
  assert.deepStrictEqual(notifies.map(o => [o.compte, o.propertyId, o.bookingId]), [[COMPTE, 'p1', 'b1']])
  assert.strictEqual(Date.parse(notifies[0].envoyeLe), Date.parse(quand))
  // Le même message rejoué par l'import : doublon, rien.
  assert.strictEqual((await ecrire({ direction: 'inbound', sender: 'guest', body: 'Bonjour', providerMsgId: 'm1', sentAt: quand })).skipped, true)
  // Un message de l'hôte, une réponse de l'IA : rien.
  await ecrire({ direction: 'outbound', sender: 'host', body: 'Bonjour à vous' })
  await ecrire({ direction: 'outbound', sender: 'ai', body: 'Réponse IA' })
  // Le webhook a écrit un entrant SANS identifiant ; l'import le retrouve avec le sien : écho réconcilié, rien.
  await ecrire({ direction: 'inbound', sender: 'guest', body: 'Merci', sentAt: quand })
  assert.strictEqual(notifies.length, 2, 'l\'entrant du webhook prévient une fois')
  const echo = await ecrire({ direction: 'inbound', sender: 'guest', body: 'Merci', providerMsgId: 'm2', sentAt: quand })
  assert.strictEqual(echo.reason, 'echo_entrant_reconcilie')
  assert.strictEqual(notifies.length, 2)
})

test('une notification qui lève n\'emporte jamais l\'écriture du message', async () => {
  delete require.cache[require.resolve('../lib/record-message')]
  const { recordMessage } = require('../lib/record-message')
  const t = { messages: [] }
  const r = await recordMessage({ userId: COMPTE, provider: 'channex', propertyId: 'p1', bookingId: 'b1', supabase: fakeSupabase(t),
    direction: 'inbound', sender: 'guest', body: 'Bonjour', providerMsgId: 'm1', sentAt: new Date().toISOString(),
    notifierMessage: async () => { throw new Error('boum') } })
  assert.deepStrictEqual(r, { ok: true, skipped: false })
  assert.strictEqual(t.messages.length, 1)
})

// ─── Émetteur 2 : la classification de l'agent ──────────────────────────────

function charger ({ tables, messages, reponse, mode = 'test', delais = null, envoi = { ok: true, canal: 'ota' }, insertionsRefusees = [] }) {
  const notifs = []
  const anthropic = { messages: { create: async () => ({ model: 'claude-sonnet-5-5', content: [{ type: 'text', text: JSON.stringify(reponse) }] }) } }
  const stubs = {
    '../lib/cron-shared': { supabase: fakeSupabase(tables, { insertionsRefusees }), anthropic, getPropertyMode: async () => mode,
      lireReglagesDuBien: async () => ({ mode, delais }),
      isAutomationPaused: async () => false, getSignatureForKey: () => '', SENDVIABEDS24_ENABLED: false },
    '../lib/cron-beds24': { fetchMessages: async () => [], fetchBookingsHistory: async () => [] },
    '../lib/alert-notify': { sendAlertNotifications: async () => {} },
    '../lib/cron-messages': { sendGuestMessage: async () => envoi },
    '../lib/record-message': { recordMessage: async () => ({ ok: true }) },
    '../lib/cles-migrees': { estCleMigree: async () => false },
    '../lib/founder-notify': { reportIncident: async () => {} },
    '../lib/channels': { getProvider: () => ({ getPropertyMessages: async () => messages, syncMessages: async () => {}, syncBookings: async () => {} }) },
    '../lib/notifications/evenements-messages': {
      notifierEscalade: async (o) => { notifs.push(['escalade', o]) },
      notifierBrouillon: async (o) => { notifs.push(['brouillon', o]) }
    }
  }
  for (const m of ['../lib/cron-classify', '../lib/guestflow-garde', '../lib/cron-messages']) delete require.cache[require.resolve(m)]
  for (const [k, ex] of Object.entries(stubs)) { const c = require.resolve(k); require.cache[c] = { id: c, filename: c, loaded: true, exports: ex } }
  const mod = require('../lib/cron-classify')
  return { mod, notifs }
}

const U = 'user-1'
const P = 'prop-1'
const B = 'booking-1'
const bien = { id: P, name: 'Ofuro Futari', provider: 'channex' }
const recent = (min) => new Date(Date.now() - min * 60e3).toISOString()
const tables = () => ({ knowledge: [], bookings_snapshot: [], conversations: [], agent_tasks: [], agent_prompting: [], guestflow_appels_ia: [], automation_incidents: [] })
const bilan = () => ({ totalMessages: 0, totalTasks: 0, totalAutoReplies: 0, errors: [], properties: [] })
const fil = (texte = 'Il y a une fuite sous l évier !', min = 30) => [{ bookingId: B, sender: 'guest', guestName: 'Marie Dupont', message: texte, time: recent(min) }]

test('LE TEST QUI COMPTE : une urgence de l\'IA prévient par le point d\'envoi ; un second message de la même escalade sonne de nouveau', async () => {
  const t = tables()
  const a = charger({ tables: t, messages: fil(), reponse: { type: 'intervention', reason: 'fuite', auto_reply: null, sub_tasks: [] } })
  await a.mod.processChannelPropertyMessages(U, bien, bilan())
  assert.deepStrictEqual(a.notifs.map(([k, o]) => [k, o.compte, o.propertyId, o.bookingId, o.type, o.guestName]), [['escalade', U, P, B, 'intervention', 'Voyageur']])
  // (« Voyageur » est le repli de la messagerie sans nom au cœur : `prenomDe` l'écarte, testé plus haut.)
  // Le voyageur réécrit : l'escalade du MÊME type est complétée — et l'hôte réalerté.
  // (Postérieur à la tâche posée au premier cycle, comme dans la vraie vie.)
  const b = charger({ tables: t, messages: [...fil(), { bookingId: B, sender: 'guest', message: 'Ça coule de plus en plus', time: new Date(Date.now() + 60e3).toISOString() }],
    reponse: { type: 'intervention', reason: 'fuite', auto_reply: null, sub_tasks: [] } })
  await b.mod.processChannelPropertyMessages(U, bien, bilan())
  assert.deepStrictEqual(b.notifs.map(([k, o]) => [k, o.type]), [['escalade', 'intervention']])
})

test('une escalade qui n\'a pas pu s\'écrire ne prévient pas — elle est rejouée au cycle suivant', async () => {
  const bl = bilan()
  const a = charger({ tables: tables(), messages: fil(), insertionsRefusees: ['agent_tasks'], reponse: { type: 'intervention', reason: 'fuite', auto_reply: null, sub_tasks: [] } })
  await a.mod.processChannelPropertyMessages(U, bien, bl)
  assert.deepStrictEqual(a.notifs, [])
  assert.ok(bl.errors.some(e => e.context === 'escalade'))
})

test('une information manquante prévient ; l\'arrêt de l\'agent au plafond aussi, en le disant', async () => {
  const a = charger({ tables: tables(), messages: fil('Quel est le code wifi ?'), reponse: { type: 'info_unknown', reason: 'wifi', auto_reply: null, sub_tasks: [] } })
  await a.mod.processChannelPropertyMessages(U, bien, bilan())
  assert.deepStrictEqual(a.notifs.map(([k, o]) => [k, o.type, !!o.arret]), [['escalade', 'info_unknown', false]])
  // Trois appels réussis dans la journée : l'agent s'arrête sur ce fil.
  const t = tables()
  for (let i = 0; i < 3; i++) t.guestflow_appels_ia.push({ user_id: U, property_id: P, booking_id: B, ok: true, created_at: recent(60 + i) })
  const b = charger({ tables: t, messages: fil('Encore une question'), reponse: { type: 'sympathy', reason: 'x', auto_reply: 'x', sub_tasks: [] } })
  await b.mod.processChannelPropertyMessages(U, bien, bilan())
  assert.deepStrictEqual(b.notifs.map(([k, o]) => [k, o.type, o.arret]), [['escalade', 'info_unknown', true]])
})

test('LE TEST QUI COMPTE : une réponse posée en validation prévient — et seulement si elle existe vraiment', async () => {
  const a = charger({ tables: tables(), messages: fil('Merci !'), reponse: { type: 'sympathy', reason: 'merci', auto_reply: 'Avec plaisir', sub_tasks: [] } })
  await a.mod.processChannelPropertyMessages(U, bien, bilan())
  assert.deepStrictEqual(a.notifs.map(([k, o]) => [k, o.bookingId, o.differe]), [['brouillon', B, false]])
  // Un délai réglé : la réponse partira seule — la notification le dit.
  const b = charger({ tables: tables(), messages: fil('Merci !'), delais: { reponse_ia: 15, alerte_info: 30 }, reponse: { type: 'sympathy', reason: 'merci', auto_reply: 'Avec plaisir', sub_tasks: [] } })
  await b.mod.processChannelPropertyMessages(U, bien, bilan())
  assert.deepStrictEqual(b.notifs.map(([k, o]) => [k, o.differe]), [['brouillon', true]])
  // L'insertion refusée : personne n'est prévenu d'une proposition qui n'existe pas.
  const c = charger({ tables: tables(), messages: fil('Merci !'), insertionsRefusees: ['agent_tasks'], reponse: { type: 'sympathy', reason: 'merci', auto_reply: 'Avec plaisir', sub_tasks: [] } })
  const bl = bilan()
  await c.mod.processChannelPropertyMessages(U, bien, bl)
  assert.deepStrictEqual(c.notifs, [])
  assert.ok(bl.errors.some(e => e.context === 'brouillon_ia'))
})

test('une réponse automatique non délivrée attend l\'hôte : il en est prévenu', async () => {
  const a = charger({ tables: tables(), mode: 'auto', delais: { reponse_ia: 0, alerte_info: 30 }, envoi: { ok: false, error: 'not_supported' },
    messages: fil('Merci !'), reponse: { type: 'sympathy', reason: 'merci', auto_reply: 'Avec plaisir', sub_tasks: [] } })
  await a.mod.processChannelPropertyMessages(U, bien, bilan())
  assert.deepStrictEqual(a.notifs.map(([k, o]) => [k, o.nonDelivree]), [['brouillon', true]])
})

// ─── Émetteur 3 : le coupe-circuit ──────────────────────────────────────────

test('LE TEST QUI COMPTE : le coupe-circuit prévient le titulaire à la bascule, et seulement à la bascule', async () => {
  const t = {
    properties: [{ user_id: U, id: UUID_BIEN, provider_property_id: P, name: 'Ofuro Futari', automation_paused: false }],
    messages: Array.from({ length: 8 }, (_, i) => ({ user_id: U, property_id: P, booking_id: B, sender: 'ai', direction: 'outbound', created_at: recent(i + 1), sent_at: recent(i + 1) }))
  }
  const pauses = []
  const charge = () => {
    const stubs = {
      '../lib/cron-shared': { supabase: fakeSupabaseAvecSelectUpdate(t) },
      '../lib/founder-notify': { reportIncident: async () => {} },
      '../lib/notifications/evenements-messages': { notifierPause: async (o) => { pauses.push(o) } }
    }
    delete require.cache[require.resolve('../lib/cron-alerting')]
    for (const [k, ex] of Object.entries(stubs)) { const c = require.resolve(k); require.cache[c] = { id: c, filename: c, loaded: true, exports: ex } }
    return require('../lib/cron-alerting')
  }
  await charge().checkMessageVolume({})
  assert.deepStrictEqual(pauses, [{ compte: U, propertyId: P, propertyUuid: UUID_BIEN, nom: 'Ofuro Futari', bookingId: B }])
  assert.strictEqual(t.properties[0].automation_paused, true)
  // Le bien est déjà en pause : la bascule n'a pas lieu, personne n'est réalerté.
  await charge().checkMessageVolume({})
  assert.strictEqual(pauses.length, 1)
})

// Le coupe-circuit lit les messages de l'heure (`in`, `gte`) et fait un UPDATE … SELECT.
function fakeSupabaseAvecSelectUpdate (tables) {
  const base = fakeSupabase(tables)
  return {
    from (table) {
      const b = base.from(table)
      const filtres = []
      let maj = null
      const proxy = {
        select (...a) { if (maj) { proxy._selectApresMaj = true } return proxy },
        eq (c, v) { filtres.push([c, v]); b.eq(c, v); return proxy },
        in (c, v) { b.in(c, v); return proxy },
        gte (c, v) { b.gte(c, v); return proxy },
        not (c, o, v) { b.not(c, o, v); return proxy },
        order (c, o) { b.order(c, o); return proxy },
        limit (n) { b.limit(n); return proxy },
        update (row) { maj = row; return proxy },
        then (res, rej) {
          if (!maj) return b.then(res, rej)
          const touchees = (tables[table] || []).filter(r => filtres.every(([c, v]) => String(r[c]) === String(v)))
          touchees.forEach(r => Object.assign(r, maj))
          return res({ data: touchees.map(r => ({ id: r.id, name: r.name })), error: null })
        }
      }
      return proxy
    }
  }
}
