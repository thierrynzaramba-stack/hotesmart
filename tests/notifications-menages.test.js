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
          const garde = (l) => Object.entries(f).every(([c, v]) => String(l[c]) === String(v))
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
    { id: UUID_BIEN, ref: 'p1' }, { bien: 'La bulle', jour: '2026-11-12' }, { arrivee: '2026-11-12', depart: '2026-11-12' }
  ])
  // Un AUTRE jour sur le même bien : un autre ménage, une autre notification.
  await ev.notifierMenageSansPersonne({ compte: COMPTE, propertyId: UUID_BIEN, jour: '2026-11-13', db, deps: c.deps })
  assert.strictEqual(c.appels.length, 2)
  // La mémoire est celle de CE compte : l'autre hôte n'en hérite pas.
  assert.ok(t.message_sent_log.every(l => l.user_id === COMPTE && l.template_id === ev.SENTINELLE_SANS_PERSONNE))
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

test('pas vu et refusé : le même sujet que « sans personne » — une notification par ménage', async () => {
  const c = capte()
  const db = fakeSupabase(tablesDeBase())
  await ev.notifierMenagePasVu({ compte: COMPTE, propertyId: 'p1', jour: '2026-11-12', prestataire: 'Régina', db, deps: c.deps })
  await ev.notifierMenageRefuse({ compte: COMPTE, propertyId: 'p1', jour: '2026-11-12T00:00:00Z', prestataire: 'Régina', db, deps: c.deps })
  assert.deepStrictEqual(c.appels.map(o => [o.code, o.sujet, o.rappel, o.bien, o.donnees]), [
    ['menage_pas_vu', `menage:${UUID_BIEN}:2026-11-12`, true, { id: UUID_BIEN, ref: 'p1' }, { bien: 'La bulle', jour: '2026-11-12', prestataire: 'Régina' }],
    ['menage_refuse', `menage:${UUID_BIEN}:2026-11-12`, true, { id: UUID_BIEN, ref: 'p1' }, { bien: 'La bulle', jour: '2026-11-12', prestataire: 'Régina' }]
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

function preparerRefus ({ dejaRefuse = false } = {}) {
  const hote = []
  const client = {
    from (table) {
      const chain = {
        select () { return chain },
        eq () { return chain },
        maybeSingle () { return Promise.resolve({ data: table === 'agent_tasks' && dejaRefuse ? { id: 't1' } : null, error: null }) },
        single () { return Promise.resolve({ data: null, error: { message: 'aucune configuration' } }) },
        insert () { return Promise.resolve({ error: null }) }
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
})
