// tests/notifications-avis.test.js
// PWA lot 2c-2, domaine Avis (docs/kb/pwa.md §11.4) : nouvel avis (n) — ses
// textes, son module (lib/notifications/evenements-avis.js) et son émetteur, le
// writer unique `upsertAvis` (lib/cron-channel-reviews.js). L'évaluation du
// voyageur (o) est observée dans tests/avis-notifications.test.js.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const textes = require('../lib/notifications/textes')
const ev = require('../lib/notifications/evenements-avis')

const COMPTE = 'compte-1'
const MAINTENANT = Date.parse('2026-11-09T10:00:00Z')
const ilYA = (jours) => new Date(MAINTENANT - jours * 86400000).toISOString()

// ─── Les textes ──────────────────────────────────────────────────────────────

test('SÉCURITÉ (S1) : un avis se dit par son bien, sa note SUR 5 et son canal — JAMAIS le voyageur, jamais le texte', () => {
  const d = { bien: 'La bulle', prenom: 'Marie', guest_name: 'Marie Dupont', note: 4.7, canal: 'BookingCom', content: 'Super séjour, mais le wifi…' }
  for (const l of ['fr', 'en', 'es']) {
    const t = JSON.stringify(textes.rediger('avis', l, d))
    assert.ok(!/Marie|wifi/.test(t), `${l} : ${t}`)
  }
  assert.deepStrictEqual(textes.rediger('avis', 'fr', d), { titre: 'Nouvel avis — La bulle', corps: '4,7/5 · Booking.com.' })
  assert.strictEqual(textes.rediger('avis', 'en', { bien: 'B', note: 5, canal: 'abb' }).corps, '5/5 · Airbnb.')
  assert.strictEqual(textes.rediger('avis', 'fr', { bien: 'B', canal: 'airbnb' }).corps, 'Avis déposé sur Airbnb.')
  assert.strictEqual(textes.rediger('avis', 'fr', { bien: 'B' }).corps, 'Un voyageur a laissé un avis.')
})

test('un avis MASQUÉ se dit sans note ; sa RÉVÉLATION se dit avec la vraie note', () => {
  assert.deepStrictEqual(textes.rediger('avis', 'fr', { bien: 'B', masque: true, note: 4.7, canal: 'airbnb' }),
    { titre: 'Nouvel avis — B', corps: 'Avis déposé sur Airbnb, masqué jusqu’à votre évaluation du voyageur.' })
  assert.deepStrictEqual(textes.rediger('avis', 'es', { bien: 'B', revele: true, note: 4.5, canal: 'airbnb' }),
    { titre: 'Reseña revelada — B', corps: '4,5/5 · Airbnb.' })
  assert.strictEqual(textes.rediger('avis', 'en', { bien: 'B', revele: true }).corps, 'The review is now visible.')
})

test('l\'évaluation du voyageur : un ÉTAT, jamais un ordre (un membre en lecture seule la reçoit aussi)', () => {
  assert.strictEqual(textes.rediger('evaluation_voyageur', 'fr', { bien: 'B', rempli: true, prestataire: 'Régina', echeance: '2026-11-21' }).corps,
    'Régina a rempli l’état du logement : l’évaluation est prête à être complétée. À publier avant le 21/11.')
  assert.strictEqual(textes.rediger('evaluation_voyageur', 'fr', { bien: 'B', rempli: false, derniere: true }).corps, 'Dernier jour pour évaluer le voyageur.')
  assert.strictEqual(textes.rediger('evaluation_voyageur', 'fr', { bien: 'B' }).corps, 'L’évaluation du voyageur est en attente.')
  for (const l of ['fr', 'en', 'es']) {
    for (const d of [{ rempli: true }, {}, { derniere: true }, { auto: 'echec' }, { auto: 'rappel' }]) {
      assert.ok(!/complétez|publiez|complete and publish|complete y publique/i.test(textes.rediger('evaluation_voyageur', l, { bien: 'B', ...d }).corps), `${l} ${JSON.stringify(d)}`)
    }
  }
})

test('la publication automatique : son rappel (jour et heure de Paris) et son échec', () => {
  assert.strictEqual(textes.rediger('evaluation_voyageur', 'fr', { bien: 'B', auto: 'rappel', publication_jour: '2026-11-21', publication_heure: '14:30' }).corps,
    'Elle sera publiée automatiquement le 21/11 à 14 h 30, sauf reprise d’ici là.')
  assert.strictEqual(textes.rediger('evaluation_voyageur', 'en', { bien: 'B', auto: 'rappel', publication_jour: '2026-11-21', publication_heure: '14:30' }).corps,
    'It will be published automatically on 11/21 at 14:30, unless it is taken over before then.')
  assert.strictEqual(textes.rediger('evaluation_voyageur', 'fr', { bien: 'B', auto: 'echec', echeance: '2026-11-22' }).corps,
    'La publication automatique n’a pas abouti : l’évaluation reste à publier. À publier avant le 22/11.')
})

test('l\'échéance passée au texte est le jour de PARIS : 23 h 30 UTC le 20 est le 21 — et une échéance PASSÉE ne se dit pas', async () => {
  const vus = []
  const deps = { notifier: async (o) => { vus.push(o); return { ok: true } } }
  await ev.notifierEvaluation({ compte: COMPTE, propertyRef: 'p1', bookingUid: 'BK 1', echeance: '2026-11-20T23:30:00Z', rempli: true,
    maintenant: MAINTENANT, db: fauxClient({ properties: [] }), deps })
  assert.deepStrictEqual([vus[0].donnees.echeance, vus[0].sujet, vus[0].chemin, vus[0].rappel], ['2026-11-21', 'eval:BK 1', '/avis?evaluer=BK%201', true])
  await ev.notifierEvaluation({ compte: COMPTE, propertyRef: 'p1', bookingUid: 'BK 1', echeance: ilYA(1), auto: 'echec',
    maintenant: MAINTENANT, db: fauxClient({ properties: [] }), deps })
  assert.deepStrictEqual([vus[1].donnees.echeance, vus[1].donnees.auto], [null, 'echec'])
})

test('le rappel de publication automatique porte le jour et l\'heure de PARIS (sans fuseau : UTC)', async () => {
  const vus = []
  await ev.notifierEvaluation({ compte: COMPTE, propertyRef: 'p1', bookingUid: 'BK', auto: 'rappel', publication: '2026-11-20T23:30:00',
    maintenant: MAINTENANT, db: fauxClient({ properties: [] }), deps: { notifier: async (o) => { vus.push(o); return { ok: true } } } })
  assert.deepStrictEqual([vus[0].donnees.publication_jour, vus[0].donnees.publication_heure], ['2026-11-21', '00:30'])
})

// ─── Le module ───────────────────────────────────────────────────────────────

// `message_sent_log` porte l'index unique (user_id, booking_id, template_id) :
// l'insertion d'un doublon rend 23505, comme la base.
function fauxClient (tables, { panne = null } = {}) {
  const lectures = []
  const cl = {
    lectures,
    from (table) {
      const f = {}
      let dans = null
      let ecriture = null
      let insertion = null
      let suppression = false
      const b = {
        select () { return b },
        eq (c, v) { f[c] = v; return b },
        in (c, v) { dans = { c, v: v.map(String) }; return b },
        limit () { return b },
        maybeSingle () { return b },
        upsert (lignes) { ecriture = lignes; return b },
        insert (ligne) { insertion = ligne; return b },
        delete () { suppression = true; return b },
        then (res) {
          const op = ecriture ? 'upsert' : insertion ? 'insert' : suppression ? 'delete' : 'select'
          if (panne && panne(table, op, ecriture)) return res({ data: null, error: { message: 'panne' } })
          const t = tables[table] = tables[table] || []
          if (op === 'insert') {
            if (table === 'message_sent_log' && t.some(x => x.user_id === insertion.user_id && x.booking_id === insertion.booking_id && x.template_id === insertion.template_id)) {
              return res({ data: null, error: { code: '23505', message: 'duplicate key' } })
            }
            t.push({ ...insertion })
            return res({ data: null, error: null })
          }
          const garde = (x) => Object.entries(f).every(([c, v]) => String(x[c]) === String(v)) && (!dans || dans.v.includes(String(x[dans.c])))
          if (op === 'delete') {
            tables[table] = t.filter(x => !garde(x))
            return res({ data: null, error: null })
          }
          if (op === 'upsert') {
            for (const l of ecriture) {
              const i = t.findIndex(x => x.user_id === l.user_id && x.provider === l.provider && x.external_review_id === l.external_review_id)
              if (i >= 0) t[i] = { ...t[i], ...l }
              else t.push({ ...l })
            }
            return res({ data: null, error: null })
          }
          lectures.push({ table, f: { ...f }, dans })
          return res({ data: t.filter(garde), error: null })
        }
      }
      return b
    }
  }
  return cl
}

const avis = (id, o = {}) => ({ user_id: COMPTE, property_id: 'uuid-1', property_id_ref: 'p1', provider: 'channex', ota: 'airbnb',
  external_review_id: id, guest_name: 'Marie Dupont', overall_score: 9, is_hidden: false, received_at: ilYA(1), ...o })
const capteur = () => {
  const vus = []
  return { vus, deps: { notifier: async (o) => { vus.push(o); return { ok: true, push: 1 } } } }
}

test('LE TEST QUI COMPTE : seul un avis NOUVEAU et RÉCENT prévient — pas un avis déjà en base, pas un avis de l\'an passé', async () => {
  const { vus, deps } = capteur()
  const bilan = await ev.notifierNouveauxAvis({
    lignes: [avis('a1'), avis('a2'), avis('a3', { received_at: ilYA(200) }), avis('a4', { received_at: null })],
    existants: new Map([[`${COMPTE}|channex|a2`, { cache: false }]]), maintenant: MAINTENANT, db: fauxClient({}), deps
  })
  assert.deepStrictEqual(bilan, { envoyes: 1, reveles: 0, deja: 0, anciens: 2, plafond: 0 })
  assert.deepStrictEqual([vus[0].code, vus[0].sujet, vus[0].chemin, vus[0].rappel, vus[0].donnees],
    ['avis', 'avis:channex:a1', '/avis', true, { bien: null, note: 4.5, canal: 'airbnb', masque: false, revele: false }])
})

test('la note qui part est celle de l\'écran, pas la moitié de la note brute', async () => {
  const { vus, deps } = capteur()
  await ev.notifierNouveauxAvis({ lignes: [avis('a1', { ota: 'booking', overall_score: 7.5 })], existants: new Map(), maintenant: MAINTENANT, db: fauxClient({}), deps })
  assert.deepStrictEqual([vus[0].donnees.note, vus[0].donnees.canal], [3.8, 'booking'])
})

test('SÉCURITÉ (S1) : rien de ce qui part ne porte le nom du voyageur', async () => {
  const { vus, deps } = capteur()
  await ev.notifierNouveauxAvis({ lignes: [avis('a1'), avis('a2', { is_hidden: true, overall_score: 0 })], existants: new Map(), maintenant: MAINTENANT, db: fauxClient({}), deps })
  assert.strictEqual(vus.length, 2)
  assert.ok(!/Marie|Dupont/.test(JSON.stringify(vus)))
})

test('la note est celle de L\'ÉCRAN : échelle par canal, un seul arrondi, et rien plutôt qu\'une note devinée', () => {
  assert.strictEqual(ev.noteDe(avis('x', { overall_score: 9.4 })), 4.7)
  assert.strictEqual(ev.noteDe(avis('x', { ota: 'booking', overall_score: 7.5 })), 3.8, '3,75 : le demi monte')
  assert.strictEqual(ev.noteDe(avis('x', { overall_score: 9.7 })), 4.9)
  assert.strictEqual(ev.noteDe(avis('x', { overall_score: 0 })), null, 'zéro n\'est une note chez aucun canal')
  assert.strictEqual(ev.noteDe(avis('x', { overall_score: 9, is_hidden: true })), null)
  const avant = console.warn
  console.warn = () => {}
  try { assert.strictEqual(ev.noteDe(avis('x', { ota: 'canal-inconnu-test', overall_score: 4 })), null, 'sans échelle, pas de conversion') } finally { console.warn = avant }
})

test('un avis MASQUÉ : sans note, et le lien mène à l\'évaluation du séjour quand il est connu', async () => {
  const { vus, deps } = capteur()
  await ev.notifierNouveauxAvis({
    lignes: [avis('m1', { is_hidden: true, overall_score: 0, booking_uid: 'BK 7' }), avis('m2', { is_hidden: true, overall_score: 0 })],
    existants: new Map(), maintenant: MAINTENANT, db: fauxClient({}), deps
  })
  assert.deepStrictEqual(vus.map(v => [v.sujet, v.chemin, v.donnees.note, v.donnees.masque]),
    [['avis:channex:m1', '/avis?evaluer=BK%207', null, true], ['avis:channex:m2', '/avis', null, true]])
})

test('LE TEST QUI COMPTE : la RÉVÉLATION d\'un avis masqué prévient UNE fois, avec la vraie note, et remplace l\'annonce', async () => {
  const { vus, deps } = capteur()
  const db = fauxClient({})
  const existants = new Map([[`${COMPTE}|channex|m1`, { cache: true }]])
  const revele = avis('m1', { is_hidden: false, overall_score: 9.4, received_at: ilYA(10) })
  const b1 = await ev.notifierNouveauxAvis({ lignes: [revele], existants, maintenant: MAINTENANT, db, deps })
  const b2 = await ev.notifierNouveauxAvis({ lignes: [revele], existants, maintenant: MAINTENANT, db, deps })
  assert.deepStrictEqual([b1.reveles, b2.reveles, b2.deja], [1, 0, 1])
  assert.strictEqual(vus.length, 1)
  assert.deepStrictEqual([vus[0].sujet, vus[0].donnees.note, vus[0].donnees.revele, vus[0].donnees.masque], ['avis:channex:m1', 4.7, true, false])
})

test('pas de révélation : un avis déjà visible, un avis encore masqué, une révélation de plus de trente jours', async () => {
  const { vus, deps } = capteur()
  const bilan = await ev.notifierNouveauxAvis({
    lignes: [avis('v1'), avis('m1', { is_hidden: true, overall_score: 0 }), avis('m2', { received_at: ilYA(45) })],
    existants: new Map([[`${COMPTE}|channex|v1`, { cache: false }], [`${COMPTE}|channex|m1`, { cache: true }], [`${COMPTE}|channex|m2`, { cache: true }]]),
    maintenant: MAINTENANT, db: fauxClient({}), deps
  })
  assert.strictEqual(vus.length, 0)
  assert.strictEqual(bilan.anciens, 1)
})

test('dix au plus PAR COMPTE et par écriture, les plus récents d\'abord — un compte bavard ne fait pas taire les autres', async () => {
  const { vus, deps } = capteur()
  const lignes = [
    ...Array.from({ length: 12 }, (_, i) => avis(`a${i}`, { received_at: new Date(MAINTENANT - (12 - i) * 3600000).toISOString() })),
    avis('b1', { user_id: 'compte-2' }), avis('b2', { user_id: 'compte-2' })
  ]
  const bilan = await ev.notifierNouveauxAvis({ lignes, existants: new Map(), maintenant: MAINTENANT, db: fauxClient({}), deps })
  assert.deepStrictEqual([bilan.envoyes, bilan.plafond], [12, 2])
  const duPremier = vus.filter(v => v.compte === COMPTE).map(v => v.sujet)
  assert.strictEqual(duPremier.length, 10)
  assert.ok(!duPremier.includes('avis:channex:a0') && !duPremier.includes('avis:channex:a1'), 'les deux plus anciens restent sans notification')
  assert.strictEqual(vus.filter(v => v.compte === 'compte-2').length, 2)
})

test('LE TEST QUI COMPTE : le webhook et le poll écrivent le même avis en même temps — UNE notification (l\'insertion tranche)', async () => {
  const { vus, deps } = capteur()
  const db = fauxClient({})
  await Promise.all([
    ev.notifierNouveauxAvis({ lignes: [avis('a1')], existants: new Map(), maintenant: MAINTENANT, db, deps }),
    ev.notifierNouveauxAvis({ lignes: [avis('a1')], existants: new Map(), maintenant: MAINTENANT, db, deps })
  ])
  assert.strictEqual(vus.length, 1)
})

test('mémoire illisible : on ne prévient pas ; rien n\'est parti : la mémoire est retirée et le poll suivant réessaie', async () => {
  const vus = []
  const enPanne = fauxClient({}, { panne: (table, op) => table === 'message_sent_log' && op === 'insert' })
  const r = await ev.notifierAvis({ compte: COMPTE, propertyRef: 'p1', provider: 'channex', externalId: 'a1', db: enPanne,
    deps: { notifier: async (o) => { vus.push(o); return { ok: true, push: 1 } } } })
  assert.deepStrictEqual([r.ok, vus.length], [false, 0])

  const t = {}
  const db = fauxClient(t)
  let echec = true
  const deps = { notifier: async (o) => { vus.push(o); return echec ? { ok: false, destinataires: 1, erreurs: ['panne'] } : { ok: true, push: 1 } } }
  await ev.notifierAvis({ compte: COMPTE, propertyRef: 'p1', provider: 'channex', externalId: 'a1', db, deps })
  assert.strictEqual((t.message_sent_log || []).length, 0, 'mémoire retirée')
  echec = false
  await ev.notifierAvis({ compte: COMPTE, propertyRef: 'p1', provider: 'channex', externalId: 'a1', db, deps })
  assert.deepStrictEqual([vus.length, t.message_sent_log.length, t.message_sent_log[0].booking_id, t.message_sent_log[0].template_id],
    [2, 1, 'notif:avis:channex:a1', ev.SENTINELLE_AVIS])
})

test('la réception de Channex arrive SANS fuseau : c\'est de l\'UTC, quel que soit le fuseau du serveur', async () => {
  const avant = process.env.TZ
  process.env.TZ = 'Pacific/Kiritimati'
  try {
    const { vus, deps } = capteur()
    // Lu en UTC : 2 j 23 h 30 → récent. Lu à UTC+14 : 3 j 13 h 30 → ancien.
    await ev.notifierNouveauxAvis({ lignes: [avis('a1', { received_at: '2026-11-06T10:30:00' })], existants: new Map(), maintenant: MAINTENANT, db: fauxClient({}), deps })
    assert.strictEqual(vus.length, 1)
  } finally {
    if (avant === undefined) delete process.env.TZ
    else process.env.TZ = avant
  }
})

// ─── L'émetteur : le writer unique des avis ─────────────────────────────────

function writer () {
  const vus = []
  const abs = require.resolve(path.join(__dirname, '..', 'lib/notifications/evenements-avis.js'))
  delete require.cache[abs]
  const vrai = require(abs)
  const m = new Module(abs)
  m.exports = { ...vrai, notifierNouveauxAvis: async ({ lignes, existants }) => { vus.push({ ids: lignes.map(l => l.external_review_id), existants: [...existants] }); return {} } }
  m.loaded = true
  require.cache[abs] = m
  delete require.cache[require.resolve('../lib/cron-channel-reviews')]
  // Le writer charge le module des avis au moment d'écrire : le double reste en place.
  const { upsertAvis } = require('../lib/cron-channel-reviews')
  return { upsertAvis, vus }
}

test('LE TEST QUI COMPTE : le writer lit ce qui existe AVANT d\'écrire — avec l\'état masqué — et ne prévient que de ce qu\'il a écrit', async () => {
  const { upsertAvis, vus } = writer()
  // Le writer lit l'horloge : dates relatives.
  const recu = new Date().toISOString()
  const t = { ota_reviews: [avis('a1', { is_hidden: true, received_at: recu })] }
  const r = await upsertAvis(fauxClient(t), [avis('a1', { received_at: recu }), avis('a2', { received_at: recu })])
  assert.strictEqual(r.ecrits, 2)
  assert.deepStrictEqual(vus, [{ ids: ['a1', 'a2'], existants: [[`${COMPTE}|channex|a1`, { cache: true }]] }])
})

test('le writer ne lit l\'existant que des avis RÉCENTS, et par paquets', async () => {
  const { upsertAvis, vus } = writer()
  const db = fauxClient({})
  const recents = Array.from({ length: 230 }, (_, i) => avis(`r${i}`, { received_at: new Date(Date.now() - 86400000).toISOString() }))
  await upsertAvis(db, [avis('vieux', { received_at: new Date(Date.now() - 200 * 86400000).toISOString() }), ...recents])
  const lus = db.lectures.filter(l => l.table === 'ota_reviews')
  assert.deepStrictEqual(lus.map(l => l.dans.v.length), [100, 100, 30])
  assert.ok(!lus.some(l => l.dans.v.includes('vieux')))
  assert.ok(!vus[0].ids.includes('vieux'), 'un avis ancien n\'est pas même proposé')
})

test('les avis existants illisibles : personne n\'est prévenu (sinon le premier poll annoncerait tout le lot)', async () => {
  const { upsertAvis, vus } = writer()
  const panne = (table, op) => table === 'ota_reviews' && op === 'select'
  const r = await upsertAvis(fauxClient({}, { panne }), [avis('a1', { received_at: new Date().toISOString() })])
  assert.strictEqual(r.ecrits, 1, 'l\'écriture, elle, a lieu')
  assert.deepStrictEqual(vus, [])
})

test('une écriture refusée ne prévient pas de ce qu\'elle n\'a pas écrit', async () => {
  const { upsertAvis, vus } = writer()
  const panne = (table, op, ecriture) => table === 'ota_reviews' && op === 'upsert' && ecriture.some(l => 'booking_uid' in l)
  const recu = new Date().toISOString()
  const r = await upsertAvis(fauxClient({}, { panne }), [avis('a1', { received_at: recu }), avis('a2', { received_at: recu, booking_uid: 'BK', stay_start: '2026-11-01', stay_end: '2026-11-03' })])
  assert.ok(r.error)
  assert.deepStrictEqual(vus.map(v => v.ids), [['a1']], 'seul le groupe écrit est annoncé')
})

test('le même identifiant d\'avis chez un AUTRE compte, ou chez un AUTRE provider, ne fait pas taire celui-ci', async () => {
  const { upsertAvis, vus } = writer()
  const recu = new Date().toISOString()
  const db = fauxClient({ ota_reviews: [avis('a1', { user_id: 'compte-2', received_at: recu }), avis('a1', { provider: 'beds24', received_at: recu })] })
  await upsertAvis(db, [avis('a1', { received_at: recu })])
  assert.deepStrictEqual(vus, [{ ids: ['a1'], existants: [] }])
  const lu = db.lectures.find(l => l.table === 'ota_reviews')
  assert.deepStrictEqual([lu.f.user_id, lu.f.provider], [COMPTE, 'channex'])
})
