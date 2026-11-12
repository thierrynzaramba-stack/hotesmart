// tests/notifications-menages.test.js
// PWA lot 2c-2, domaine Ménages (docs/kb/pwa.md §11.3) : ménage sans personne
// (h), pas vu (i), refusé (l), disponibilités modifiées (m) — leurs textes,
// leur module (lib/notifications/evenements-menages.js), et le refus.
// Les autres émetteurs sont observés dans leurs propres bancs :
// tests/cleaning-sync-menages-entite.test.js (h), tests/menages-valider.test.js
// (i), tests/alert-regles-modifiees.test.js (m).

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const textes = require('../lib/notifications/textes')
const { evenement } = require('../lib/notifications/catalogue')
const ev = require('../lib/notifications/evenements-menages')

const COMPTE = 'compte-1'
const AUTRE = 'compte-2'
const UUID_BIEN = '3f2a1b4c-1111-4222-8333-944455556666'

// ─── Les textes ──────────────────────────────────────────────────────────────

test('les quatre événements ont un texte dans les trois langues, et le catalogue les connaît', () => {
  for (const code of ['menage_sans_personne', 'menage_pas_vu', 'menage_refuse', 'disponibilites_modifiees']) {
    assert.ok(evenement(code), code)
    for (const l of ['fr', 'en', 'es']) {
      const t = textes.rediger(code, l, { bien: 'La bulle', jour: '2026-11-12', prestataire: 'Régina' })
      assert.ok(t && t.titre && t.corps, `${code}/${l}`)
      assert.ok(!/undefined|null/.test(JSON.stringify(t)), `${code}/${l}`)
    }
  }
  assert.deepStrictEqual(textes.rediger('menage_refuse', 'fr', { bien: 'La bulle', jour: '2026-11-12', prestataire: 'Régina' }),
    { titre: 'Ménage refusé — La bulle', corps: 'Régina ne peut pas faire le ménage du 12/11. Confiez-le à quelqu’un d’autre.' })
  assert.strictEqual(textes.rediger('menage_pas_vu', 'fr', { bien: 'B', jour: '2026-11-12' }).corps, 'La prestataire n’a pas encore vu le ménage du 12/11.')
  assert.ok(textes.rediger('menage_pas_vu', 'fr', { bien: 'B', jour: '2026-11-12', prestataire: 'x'.repeat(200) }).corps.length < 100)
})

// ─── Un faux client : lectures filtrées, insertions avec index unique ────────

function fakeSupabase (tables, { insertionsRefusees = [] } = {}) {
  return {
    from (table) {
      const f = {}
      let mode = 'select'
      let charge = null
      const b = {
        select () { return b },
        eq (c, v) { f[c] = v; return b },
        in (c, v) { f[c] = { dans: v.map(String) }; return b },
        limit () { return b },
        maybeSingle () { return b },
        insert (row) { mode = 'insert'; charge = row; return b },
        delete () { mode = 'delete'; return b },
        then (res) {
          const lignes = tables[table] = tables[table] || []
          if (mode === 'insert') {
            if (insertionsRefusees.includes(table)) return res({ data: null, error: { code: 'XX000', message: 'refus' } })
            // L'index unique de `message_sent_log` (user_id, booking_id, template_id).
            if (table === 'message_sent_log' && lignes.some(l => l.user_id === charge.user_id && l.booking_id === charge.booking_id && l.template_id === charge.template_id)) {
              return res({ data: null, error: { code: '23505', message: 'doublon' } })
            }
            lignes.push({ ...charge })
            return res({ data: null, error: null })
          }
          const garde = (l) => Object.entries(f).every(([c, v]) => v && v.dans ? v.dans.includes(String(l[c])) : String(l[c]) === String(v))
          if (mode === 'delete') {
            tables[table] = lignes.filter(l => !garde(l))
            return res({ data: null, error: null })
          }
          return res({ data: lignes.filter(garde), error: null })
        }
      }
      return b
    }
  }
}

const tablesDeBase = () => ({
  properties: [
    { user_id: AUTRE, id: 'uuid-autre', provider_property_id: 'p1', name: 'Bien d\'un autre' },
    { user_id: COMPTE, id: UUID_BIEN, provider_property_id: 'p1', name: 'La bulle' }
  ],
  message_sent_log: []
})

function capte (bilan = { ok: true, erreurs: [] }) {
  const appels = []
  return { appels, deps: { notifier: async (o) => { appels.push(o); return bilan } } }
}

// ─── h : une fois par ménage ────────────────────────────────────────────────

test('LE TEST QUI COMPTE : « ménage sans personne » ne prévient qu\'UNE fois par ménage, quel que soit le nombre de cycles', async () => {
  const t = tablesDeBase()
  const db = fakeSupabase(t)
  const c = capte()
  const retours = []
  for (let cycle = 0; cycle < 5; cycle++) {
    retours.push(await ev.notifierMenageSansPersonne({ compte: COMPTE, propertyId: UUID_BIEN, jour: '2026-11-12', db, deps: c.deps }))
  }
  assert.strictEqual(c.appels.length, 1)
  assert.deepStrictEqual(retours.slice(1), Array(4).fill({ ok: true, deja: true }), 'les cycles suivants se savent déjà prévenus')
  const o = c.appels[0]
  assert.deepStrictEqual([o.compte, o.code, o.sujet, o.chemin, o.rappel, o.bien, o.donnees, o.sejour], [
    COMPTE, 'menage_sans_personne', `menage:${UUID_BIEN}:2026-11-12`, '/menages', true,
    { id: UUID_BIEN, ref: 'p1' }, { bien: 'La bulle', jour: '2026-11-12', motif: null }, { arrivee: '2026-11-12', depart: '2026-11-12' }
  ])
  // Un AUTRE jour sur le même bien : un autre ménage, une autre notification.
  await ev.notifierMenageSansPersonne({ compte: COMPTE, propertyId: UUID_BIEN, jour: '2026-11-13', db, deps: c.deps })
  assert.strictEqual(c.appels.length, 2)
  // La mémoire est celle de CE compte : l'autre hôte n'en hérite pas.
  assert.ok(t.message_sent_log.every(l => l.user_id === COMPTE && l.template_id === ev.SENTINELLE_SANS_PERSONNE))
})

test('LE TEST QUI COMPTE : rien n\'est parti → la mémoire s\'oublie (le cycle suivant réessaie) ; parti en partie, ou personne n\'a de canal → elle reste', async () => {
  const cas = [
    ['tout a raté, et le notifier dit pourtant ok', { ok: true, destinataires: 1, sans_canal: 0, push: 0, emails: 0, sms: 0, en_attente: 0, personne_joignable: false, erreurs: ['push_echec', 'email_echec'] }, 0],
    ['exception APRÈS un premier envoi', { ok: false, destinataires: 2, sans_canal: 0, push: 1, emails: 0, sms: 0, en_attente: 0, erreurs: ['boum'] }, 1],
    ['en file pour la fin de la plage', { ok: true, destinataires: 1, sans_canal: 0, push: 0, emails: 0, sms: 0, en_attente: 1, erreurs: [] }, 1],
    ['personne n\'a de canal pour h', { ok: true, destinataires: 1, sans_canal: 1, push: 0, emails: 0, sms: 0, en_attente: 0, erreurs: [] }, 1]
  ]
  for (const [nom, bilan, reste] of cas) {
    const t = tablesDeBase()
    await ev.notifierMenageSansPersonne({ compte: COMPTE, propertyId: 'p1', jour: '2026-11-12', db: fakeSupabase(t), deps: capte(bilan).deps })
    assert.strictEqual(t.message_sent_log.length, reste, nom)
  }
})

test('un envoi qui n\'a joint personne s\'oublie (le cycle suivant réessaie) ; une mémoire illisible ne prévient pas', async () => {
  const t = tablesDeBase()
  const db = fakeSupabase(t)
  const rate = capte({ ok: false, erreurs: ['destinataires_illisibles'] })
  await ev.notifierMenageSansPersonne({ compte: COMPTE, propertyId: 'p1', jour: '2026-11-12', db, deps: rate.deps })
  assert.strictEqual(t.message_sent_log.length, 0, 'la ligne posée est retirée')
  const ok = capte()
  await ev.notifierMenageSansPersonne({ compte: COMPTE, propertyId: 'p1', jour: '2026-11-12', db, deps: ok.deps })
  assert.strictEqual(ok.appels.length, 1)
  // La base refuse la mémoire : sans elle, on préviendrait toutes les cinq minutes.
  const muet = capte()
  const r = await ev.notifierMenageSansPersonne({ compte: COMPTE, propertyId: 'p1', jour: '2026-11-14',
    db: fakeSupabase(tablesDeBase(), { insertionsRefusees: ['message_sent_log'] }), deps: muet.deps })
  assert.deepStrictEqual([r.ok, muet.appels.length], [false, 0])
})

// ─── i, l, m ────────────────────────────────────────────────────────────────

test('la clé et le sujet tiennent à ce que l\'émetteur passe, pas à la relecture du bien : une lecture ratée ne fait pas un second h', async () => {
  const t = tablesDeBase()
  const c = capte()
  const enPanne = { from (table) { if (table === 'properties') return { select: () => ({ eq: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: null, error: { message: 'panne' } }) }) }) }) }; return fakeSupabase(t).from(table) } }
  await ev.notifierMenageSansPersonne({ compte: COMPTE, propertyId: 'p1', jour: '2026-11-12', db: enPanne, deps: c.deps })
  await ev.notifierMenageSansPersonne({ compte: COMPTE, propertyId: 'p1', jour: '2026-11-12', db: fakeSupabase(t), deps: c.deps })
  assert.strictEqual(c.appels.length, 1)
  assert.strictEqual(c.appels[0].sujet, 'menage:p1:2026-11-12')
})

test('LE TEST QUI COMPTE : le lot d\'un cycle — une lecture des mémoires, les déjà prévenus sautés, vingt au plus, le reste au cycle suivant', async () => {
  const t = tablesDeBase()
  t.message_sent_log.push({ user_id: COMPTE, booking_id: 'notif:menage:p1:2026-11-12', template_id: ev.SENTINELLE_SANS_PERSONNE })
  const insertions = []
  const db = fakeSupabase(t)
  const espion = { from (table) { const q = db.from(table); const ins = q.insert; q.insert = (r) => { insertions.push(r.booking_id); return ins(r) }; return q } }
  const c = capte({ ok: true, push: 1, erreurs: [] })
  const liste = [{ compte: COMPTE, propertyId: 'p1', jour: '2026-11-12' }, { compte: COMPTE, propertyId: 'p1', jour: '2026-11-12' }]
  for (let i = 0; i < 25; i++) liste.push({ compte: COMPTE, propertyId: 'p1', jour: `2026-12-${String(i + 1).padStart(2, '0')}`, motif: 'jours' })
  const bilan = await ev.notifierMenagesSansPersonne({ liste, db: espion, deps: c.deps })
  assert.deepStrictEqual(bilan, { envoyes: 20, injoignables: 0, deja: 1, reportes: 5, erreurs: 0 })
  assert.ok(!insertions.includes('notif:menage:p1:2026-11-12'), 'le déjà prévenu ne coûte même pas une insertion')
  assert.strictEqual(c.appels[0].donnees.motif, 'jours')
  // Le cycle suivant : les vingt sont mémorisés, les cinq partent.
  const c2 = capte({ ok: true, push: 1, erreurs: [] })
  const b2 = await ev.notifierMenagesSansPersonne({ liste, db: fakeSupabase(t), deps: c2.deps })
  assert.deepStrictEqual(b2, { envoyes: 5, injoignables: 0, deja: 21, reportes: 0, erreurs: 0 })
})

test('LE TEST QUI COMPTE (review de rattrapage, constat 3) : personne de joignable — la mémoire reste, le plafond est libre pour les autres', async () => {
  const t = tablesDeBase()
  // Envoi sans erreur, mais personne n'avait d'appareil ni d'e-mail.
  const injoignable = capte({ ok: true, destinataires: 1, sans_canal: 0, push: 0, emails: 0, sms: 0, en_attente: 0, erreurs: [] })
  const liste = Array.from({ length: 25 }, (_, i) => ({ compte: COMPTE, propertyId: 'p1', jour: `2026-12-${String(i + 1).padStart(2, '0')}` }))
  const b1 = await ev.notifierMenagesSansPersonne({ liste, db: fakeSupabase(t), deps: injoignable.deps })
  assert.deepStrictEqual(b1, { envoyes: 0, injoignables: 25, deja: 0, reportes: 0, erreurs: 0 })
  const b2 = await ev.notifierMenagesSansPersonne({ liste, db: fakeSupabase(t), deps: injoignable.deps })
  assert.deepStrictEqual([b2.deja, injoignable.appels.length], [25, 25], 'pas un second essai')
  // Un vrai échec, lui, rend la mémoire : le cycle suivant réessaie.
  assert.strictEqual(ev.rienNestParti({ ok: false, destinataires: 1, erreurs: ['exception'] }), true)
  assert.strictEqual(ev.rienNestParti({ ok: true, destinataires: 1, erreurs: ['email_echec'] }), true)
})

test('les mémoires d\'un cycle se lisent par paquets de cent (review de rattrapage, constat 5)', async () => {
  const t = tablesDeBase()
  const tailles = []
  const db = fakeSupabase(t)
  const espion = { from (table) { const q = db.from(table); if (table === 'message_sent_log') { const i = q.in; q.in = (c, v) => { tailles.push(v.length); return i.call(q, c, v) } } return q } }
  const liste = Array.from({ length: 230 }, (_, i) => ({ compte: COMPTE, propertyId: `p${i}`, jour: '2026-12-01' }))
  await ev.notifierMenagesSansPersonne({ liste, db: espion, deps: capte({ ok: true, push: 1, erreurs: [] }).deps })
  assert.deepStrictEqual(tailles, [100, 100, 30])
})

test('« sans jours réglés » se dit comme un réglage à faire, pas comme un manque de monde', () => {
  assert.strictEqual(textes.rediger('menage_sans_personne', 'fr', { bien: 'B', jour: '2026-11-12', motif: 'jours' }).corps,
    'Ménage du 12/11 : aucune de vos prestataires n’a de jours réglés pour ce logement. Réglez leurs jours, ou confiez-le à quelqu’un.')
})

test('une expiration (uneFois: false) prévient sans mémoire : un nouvel épisode n\'est pas tu par le précédent', async () => {
  const t = tablesDeBase()
  t.message_sent_log.push({ user_id: COMPTE, booking_id: 'notif:menage:p1:2026-11-12', template_id: ev.SENTINELLE_SANS_PERSONNE })
  const c = capte()
  await ev.notifierMenageSansPersonne({ compte: COMPTE, propertyId: 'p1', jour: '2026-11-12', uneFois: false, db: fakeSupabase(t), deps: c.deps })
  assert.strictEqual(c.appels.length, 1)
  assert.strictEqual(t.message_sent_log.length, 1)
})

test('pas vu et refusé : le même sujet que « sans personne » — une notification par ménage', async () => {
  const c = capte()
  const db = fakeSupabase(tablesDeBase())
  await ev.notifierMenagePasVu({ compte: COMPTE, propertyId: 'p1', jour: '2026-11-12', prestataire: 'Régina', db, deps: c.deps })
  await ev.notifierMenageRefuse({ compte: COMPTE, propertyId: 'p1', jour: '2026-11-12T00:00:00Z', prestataire: 'Régina', db, deps: c.deps })
  assert.deepStrictEqual(c.appels.map(o => [o.code, o.sujet, o.rappel, o.bien, o.donnees]), [
    ['menage_pas_vu', 'menage:p1:2026-11-12', true, { id: UUID_BIEN, ref: 'p1' }, { bien: 'La bulle', jour: '2026-11-12', prestataire: 'Régina' }],
    ['menage_refuse', 'menage:p1:2026-11-12', true, { id: UUID_BIEN, ref: 'p1' }, { bien: 'La bulle', jour: '2026-11-12', prestataire: 'Régina' }]
  ])
})

test('disponibilités : un sujet par prestataire, sa fiche à l\'ouverture ; sans bien, rien', async () => {
  const c = capte()
  const db = fakeSupabase(tablesDeBase())
  await ev.notifierDisponibilites({ compte: COMPTE, propertyId: 'p1', providerId: 'prof/1', prestataire: 'Lena', db, deps: c.deps })
  assert.deepStrictEqual(c.appels.map(o => [o.code, o.sujet, o.chemin, o.rappel, o.donnees]),
    [['disponibilites_modifiees', 'dispos:prof/1', '/menages?presta=prof%2F1', true, { prestataire: 'Lena' }]])
  const r = await ev.notifierDisponibilites({ compte: COMPTE, propertyId: null, providerId: 'x', db, deps: c.deps })
  assert.strictEqual(r.ignore, true)
})

test('aucun ne lève, même quand le point d\'envoi lève', async () => {
  const deps = { notifier: async () => { throw new Error('boum') } }
  const db = () => fakeSupabase(tablesDeBase())
  for (const r of [
    await ev.notifierMenageSansPersonne({ compte: COMPTE, propertyId: 'p1', jour: '2026-11-12', db: db(), deps }),
    await ev.notifierMenagePasVu({ compte: COMPTE, propertyId: 'p1', jour: '2026-11-12', db: db(), deps }),
    await ev.notifierMenageRefuse({ compte: COMPTE, propertyId: 'p1', jour: '2026-11-12', db: db(), deps }),
    await ev.notifierDisponibilites({ compte: COMPTE, propertyId: 'p1', providerId: 'x', db: db(), deps })
  ]) assert.strictEqual(r.ok, false)
})

// ─── L'émetteur du refus : lib/alert-notify.js ──────────────────────────────

function stub (rel, exports) {
  const abs = require.resolve(path.join(__dirname, '..', rel))
  const m = new Module(abs); m.exports = exports; m.loaded = true
  require.cache[abs] = m
}

function preparerRefus ({ dejaRefuse = false, marqueurIllisible = false, tacheRefusee = false } = {}) {
  const hote = []
  const client = {
    from (table) {
      const chain = {
        select () { return chain },
        eq () { return chain },
        limit () {
          if (table === 'agent_tasks' && marqueurIllisible) return Promise.resolve({ data: null, error: { message: 'panne' } })
          return Promise.resolve({ data: table === 'agent_tasks' && dejaRefuse ? [{ id: 't1' }, { id: 't2' }] : [], error: null })
        },
        single () { return Promise.resolve({ data: null, error: { message: 'aucune configuration' } }) },
        insert () { return Promise.resolve({ error: tacheRefusee ? { message: 'refus' } : null }) }
      }
      return chain
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  stub('api/sms', { sendSms: async () => ({ ok: true }) })
  stub('lib/platform-notify', { sendPlatformEmail: async () => ({ ok: true }) })
  stub('lib/notifications/evenements-menages.js', { notifierMenageRefuse: async (o) => { hote.push(o); return { ok: true } } })
  delete require.cache[require.resolve('../lib/alert-notify')]
  return { alertMenageRefuse: require('../lib/alert-notify').alertMenageRefuse, hote }
}

test('LE TEST QUI COMPTE : un ménage refusé prévient l\'hôte et son équipe — une fois par refus', async () => {
  const a = preparerRefus()
  await a.alertMenageRefuse({ userId: COMPTE, propertyId: UUID_BIEN, bookingId: 'b1', departureDate: '2026-11-12', prenom: 'Régina' })
  assert.deepStrictEqual(a.hote.map(o => [o.compte, o.propertyId, o.jour, o.prestataire]), [[COMPTE, UUID_BIEN, '2026-11-12', 'Régina']])
  const b = preparerRefus({ dejaRefuse: true })
  await b.alertMenageRefuse({ userId: COMPTE, propertyId: UUID_BIEN, bookingId: 'b1', departureDate: '2026-11-12', prenom: 'Régina' })
  assert.deepStrictEqual(b.hote, [])
  // Sans mémoire (marqueur illisible, tâche refusée) : pas de notification (constat 4).
  for (const o of [{ marqueurIllisible: true }, { tacheRefusee: true }]) {
    const c = preparerRefus(o)
    await c.alertMenageRefuse({ userId: COMPTE, propertyId: UUID_BIEN, bookingId: 'b1', departureDate: '2026-11-12', prenom: 'Régina' })
    assert.deepStrictEqual(c.hote, [], JSON.stringify(o))
  }
})


test('LE TEST QUI COMPTE (décision du 9 novembre) : disponibilités — la première du jour sonne, les suivantes remplacent sans sonner, le lendemain sonne de nouveau', async () => {
  const t = tablesDeBase()
  const c = capte()
  const matin = Date.parse('2026-11-09T08:00:00Z')
  for (const quand of [matin, matin + 60e3, matin + 3600e3, Date.parse('2026-11-09T22:30:00Z') /* 23 h 30 à Paris */, Date.parse('2026-11-09T23:30:00Z') /* 0 h 30 le 10 */]) {
    await ev.notifierDisponibilites({ compte: COMPTE, propertyId: 'p1', providerId: 'lena', prestataire: 'Lena', maintenant: quand, db: fakeSupabase(t), deps: c.deps })
  }
  assert.deepStrictEqual(c.appels.map(o => o.rappel), [true, false, false, false, true])
  // Une autre prestataire, le même jour : la sienne sonne.
  await ev.notifierDisponibilites({ compte: COMPTE, propertyId: 'p1', providerId: 'lola', maintenant: matin, db: fakeSupabase(t), deps: c.deps })
  assert.strictEqual(c.appels[5].rappel, true)
  // La mémoire illisible : on sonne plutôt que de manquer.
  const c2 = capte()
  await ev.notifierDisponibilites({ compte: COMPTE, propertyId: 'p1', providerId: 'lena', maintenant: matin,
    db: fakeSupabase(tablesDeBase(), { insertionsRefusees: ['message_sent_log'] }), deps: c2.deps })
  assert.strictEqual(c2.appels[0].rappel, true)
})
