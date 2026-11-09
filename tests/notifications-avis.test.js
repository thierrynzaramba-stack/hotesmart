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

test('un avis se dit par le prénom, la note SUR 5 (le cœur stocke sur 10) et le canal — jamais son texte', () => {
  assert.deepStrictEqual(textes.rediger('avis', 'fr', { bien: 'La bulle', prenom: 'Marie', note: 9.4, canal: 'BookingCom', content: 'Super séjour, mais le wifi…' }),
    { titre: 'Nouvel avis — La bulle', corps: 'Marie · 4,7/5 · Booking.com.' })
  assert.strictEqual(textes.rediger('avis', 'en', { bien: 'B', note: 10, canal: 'abb' }).corps, 'A guest · 5/5 · Airbnb.')
  assert.strictEqual(textes.rediger('avis', 'fr', { bien: 'B', prenom: 'Marie' }).corps, 'Marie a laissé un avis.')
})

test('l\'évaluation du voyageur : remplie par la prestataire, ou relance ; l\'échéance en jour de Paris', () => {
  assert.strictEqual(textes.rediger('evaluation_voyageur', 'fr', { bien: 'B', rempli: true, prestataire: 'Régina', echeance: '2026-11-21' }).corps,
    'Régina a rempli l’état du logement : complétez et publiez l’évaluation. À publier avant le 21/11.')
  assert.strictEqual(textes.rediger('evaluation_voyageur', 'fr', { bien: 'B', rempli: false, derniere: true }).corps, 'Dernier jour pour évaluer le voyageur.')
  assert.strictEqual(textes.rediger('evaluation_voyageur', 'fr', { bien: 'B', rempli: true }).corps, 'Votre prestataire a rempli l’état du logement : complétez et publiez l’évaluation.')
})

test('l\'échéance passée au texte est le jour de PARIS : 23 h 30 UTC le 20 est le 21', async () => {
  const vus = []
  await ev.notifierEvaluation({ compte: COMPTE, propertyRef: 'p1', bookingUid: 'BK 1', echeance: '2026-11-20T23:30:00Z', rempli: true,
    db: fauxClient({ properties: [] }), deps: { notifier: async (o) => { vus.push(o); return { ok: true } } } })
  assert.deepStrictEqual([vus[0].donnees.echeance, vus[0].sujet, vus[0].chemin, vus[0].rappel], ['2026-11-21', 'eval:BK 1', '/avis?evaluer=BK%201', true])
})

// ─── Le module ───────────────────────────────────────────────────────────────

function fauxClient (tables, { panne = null } = {}) {
  return {
    from (table) {
      const f = {}
      let dans = null
      let ecriture = null
      const b = {
        select () { return b },
        eq (c, v) { f[c] = v; return b },
        in (c, v) { dans = { c, v: v.map(String) }; return b },
        limit () { return b },
        maybeSingle () { return b },
        upsert (lignes) { ecriture = lignes; return b },
        then (res) {
          if (panne && panne(table, ecriture)) return res({ data: null, error: { message: 'panne' } })
          const t = tables[table] = tables[table] || []
          if (ecriture) {
            for (const l of ecriture) {
              const i = t.findIndex(x => x.user_id === l.user_id && x.provider === l.provider && x.external_review_id === l.external_review_id)
              if (i >= 0) t[i] = { ...t[i], ...l }
              else t.push({ ...l })
            }
            return res({ data: null, error: null })
          }
          const r = t.filter(x => Object.entries(f).every(([c, v]) => String(x[c]) === String(v)) && (!dans || dans.v.includes(String(x[dans.c]))))
          return res({ data: r, error: null })
        }
      }
      return b
    }
  }
}

const avis = (id, o = {}) => ({ user_id: COMPTE, property_id: 'uuid-1', property_id_ref: 'p1', provider: 'channex', ota: 'airbnb',
  external_review_id: id, guest_name: 'Marie Dupont', overall_score: 9, received_at: ilYA(1), ...o })

test('LE TEST QUI COMPTE : seul un avis NOUVEAU et RÉCENT prévient — pas un avis déjà en base, pas un avis de l\'an passé', async () => {
  const vus = []
  const deps = { notifier: async (o) => { vus.push(o); return { ok: true } } }
  const bilan = await ev.notifierNouveauxAvis({
    lignes: [avis('a1'), avis('a2'), avis('a3', { received_at: ilYA(200) }), avis('a4', { received_at: null })],
    existants: new Set([`${COMPTE}|channex|a2`]), maintenant: MAINTENANT, db: fauxClient({}), deps
  })
  assert.deepStrictEqual(bilan, { envoyes: 1, anciens: 2, plafond: 0 })
  assert.deepStrictEqual([vus[0].code, vus[0].sujet, vus[0].chemin, vus[0].rappel, vus[0].donnees],
    ['avis', 'avis:a1', '/avis', true, { bien: null, prenom: 'Marie', note: 9, canal: 'airbnb' }])
})

test('dix au plus par écriture', async () => {
  const lignes = Array.from({ length: 14 }, (_, i) => avis(`a${i}`))
  const bilan = await ev.notifierNouveauxAvis({ lignes, existants: new Set(), maintenant: MAINTENANT, db: fauxClient({}),
    deps: { notifier: async () => ({ ok: true }) } })
  assert.deepStrictEqual(bilan, { envoyes: 10, anciens: 0, plafond: 4 })
})

// ─── L'émetteur : le writer unique des avis ─────────────────────────────────

function writer () {
  const vus = []
  const abs = require.resolve(path.join(__dirname, '..', 'lib/notifications/evenements-avis.js'))
  const m = new Module(abs)
  m.exports = { notifierNouveauxAvis: async ({ lignes, existants }) => { vus.push({ ids: lignes.map(l => l.external_review_id), existants: [...existants] }); return {} } }
  m.loaded = true
  require.cache[abs] = m
  delete require.cache[require.resolve('../lib/cron-channel-reviews')]
  // Le writer charge le module des avis au moment d'écrire : le double reste en place.
  const { upsertAvis } = require('../lib/cron-channel-reviews')
  return { upsertAvis, vus }
}

test('LE TEST QUI COMPTE : le writer lit ce qui existe AVANT d\'écrire, et ne prévient que de ce qu\'il a écrit', async () => {
  const { upsertAvis, vus } = writer()
  const t = { ota_reviews: [avis('a1')] }
  const r = await upsertAvis(fauxClient(t), [avis('a1'), avis('a2')])
  assert.strictEqual(r.ecrits, 2)
  assert.deepStrictEqual(vus, [{ ids: ['a1', 'a2'], existants: [`${COMPTE}|channex|a1`] }])
})

test('les avis existants illisibles : personne n\'est prévenu (sinon le premier poll annoncerait tout le lot)', async () => {
  const { upsertAvis, vus } = writer()
  const panne = (table, ecriture) => table === 'ota_reviews' && !ecriture
  const r = await upsertAvis(fauxClient({}, { panne }), [avis('a1')])
  assert.strictEqual(r.ecrits, 1, 'l\'écriture, elle, a lieu')
  assert.deepStrictEqual(vus, [])
})

test('une écriture refusée ne prévient pas de ce qu\'elle n\'a pas écrit', async () => {
  const { upsertAvis, vus } = writer()
  const panne = (table, ecriture) => table === 'ota_reviews' && ecriture && ecriture.some(l => 'booking_uid' in l)
  const r = await upsertAvis(fauxClient({}, { panne }), [avis('a1'), avis('a2', { booking_uid: 'BK', stay_start: '2026-11-01', stay_end: '2026-11-03' })])
  assert.ok(r.error)
  assert.deepStrictEqual(vus.map(v => v.ids), [['a1']], 'seul le groupe écrit est annoncé')
})

test('le même identifiant d\'avis chez un AUTRE compte ne fait pas taire celui-ci', async () => {
  const { upsertAvis, vus } = writer()
  const t = { ota_reviews: [avis('a1', { user_id: 'compte-2' })] }
  await upsertAvis(fauxClient(t), [avis('a1')])
  assert.deepStrictEqual(vus, [{ ids: ['a1'], existants: [] }])
})
