// tests/cron-overbooking.test.js
// Detection des surreservations et ALARME RECURRENTE
// (spec-reservation-manuelle.md §4, amendement du 6 septembre 2026).

const test = require('node:test')
const assert = require('node:assert')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'

const { regrouper, signature, RELANCE_MS } = require('../lib/cron-overbooking')

test('regroupement : une alarme par BIEN, pas par nuit', () => {
  // Cinq nuits qui se chevauchent sur le meme bien sont UN probleme. Cinq SMS
  // repetes toutes les 45 minutes seraient le bruit qu'on veut eviter.
  const g = regrouper([
    { userId: 'u1', propertyId: 'p1', propertyName: 'A', nuit: '2026-10-12', occupants: ['a', 'b'], unites: 1 },
    { userId: 'u1', propertyId: 'p1', propertyName: 'A', nuit: '2026-10-13', occupants: ['a', 'b'], unites: 1 },
    { userId: 'u2', propertyId: 'p2', propertyName: 'B', nuit: '2026-10-12', occupants: ['c', 'd'], unites: 1 }
  ])
  assert.strictEqual(g.length, 2, 'deux biens, deux alarmes')
  const a = g.find(x => x.propertyId === 'p1')
  assert.deepStrictEqual(a.nuits, ['2026-10-12', '2026-10-13'])
  assert.deepStrictEqual(a.bookings, ['a', 'b'], 'les reservations en cause, dedupliquees')
})

test('regroupement : deux hotes au meme provider_property_id ne se melangent pas', () => {
  // `provider_property_id` n'a aucune unicite globale.
  const g = regrouper([
    { userId: 'u1', propertyId: 'MEME', propertyName: 'Chez A', nuit: '2026-10-12', occupants: ['a1', 'a2'], unites: 1 },
    { userId: 'u2', propertyId: 'MEME', propertyName: 'Chez B', nuit: '2026-10-12', occupants: ['b1', 'b2'], unites: 1 }
  ])
  assert.strictEqual(g.length, 2)
  assert.deepStrictEqual(g.map(x => x.bookings).flat().sort(), ['a1', 'a2', 'b1', 'b2'])
})

test('la periode de relance est configurable et vaut 45 min par defaut', () => {
  assert.ok(RELANCE_MS >= 30 * 60 * 1000 && RELANCE_MS <= 60 * 60 * 1000,
    'la spec demande 30-60 min')
})

// ─── Cycle de vie de l'alarme ───────────────────────────────────────────────

function fakeSupabase ({ ouverts = [], capture = {} } = {}) {
  capture.inserts = capture.inserts || []
  capture.updates = capture.updates || []
  return {
    from () {
      const q = {
        _upd: null,
        select () { return q }, eq () { return q }, is () { return q }, order () { return q },
        gte () { return q }, lt () { return q }, or () { return q },
        range () { return q },
        upsert: async () => ({ error: null }),
        insert (row) { capture.inserts.push(row); return { select: () => ({ maybeSingle: async () => ({ data: { id: 'inc-' + capture.inserts.length }, error: null }) }) } },
        update (patch) { q._upd = patch; return q },
        maybeSingle: async () => ({ data: null, error: null }),
        then (res, rej) {
          if (q._upd) { capture.updates.push(q._upd); q._upd = null; return Promise.resolve({ error: null }).then(res, rej) }
          return Promise.resolve({ data: ouverts, error: null }).then(res, rej)
        }
      }
      return q
    }
  }
}

test('ALARME : premiere detection -> incident cree ET SMS envoye', async () => {
  const capture = {}
  const envois = []
  const mod = requireFrais(capture, envois, [])
  const bilan = await mod.traiterAlarmes([
    { userId: 'u1', propertyId: 'p1', propertyName: 'La bulle', nuits: ['2026-10-12'], bookings: ['a', 'b'], unites: 1 }
  ])
  assert.strictEqual(bilan.ouverts, 1)
  assert.strictEqual(capture.inserts.length, 1)
  assert.strictEqual(capture.inserts[0].type, 'overbooking')
  assert.strictEqual(capture.inserts[0].acquitted_at, undefined, 'ouvert : jamais acquitte a la creation')
  assert.ok(capture.inserts[0].last_alerted_at)
  assert.strictEqual(envois.length, 1, 'le SMS part')
  assert.strictEqual(envois[0].prefixe, '', 'premiere alerte, pas une relance')
})

test('ALARME : deja ouverte et delai ecoule -> RELANCE (pas de doublon)', async () => {
  const capture = {}
  const envois = []
  const vieux = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  const mod = requireFrais(capture, envois, [{ id: 'inc-1', user_id: 'u1', property_id: 'p1', last_alerted_at: vieux, acquitted_at: null }])
  const bilan = await mod.traiterAlarmes([
    { userId: 'u1', propertyId: 'p1', propertyName: 'La bulle', nuits: ['2026-10-12'], bookings: ['a', 'b'], unites: 1 }
  ])
  assert.strictEqual(bilan.relances, 1)
  assert.strictEqual(bilan.ouverts, 0, 'aucun incident duplique')
  assert.strictEqual(capture.inserts.length, 0)
  assert.strictEqual(envois.length, 1)
  assert.strictEqual(envois[0].prefixe, 'RELANCE — ')
})

test('ALARME : deja ouverte mais delai NON ecoule -> silence, sans oublier le probleme', async () => {
  const capture = {}
  const envois = []
  const recent = new Date(Date.now() - 60 * 1000).toISOString()
  const mod = requireFrais(capture, envois, [{ id: 'inc-1', user_id: 'u1', property_id: 'p1', last_alerted_at: recent, acquitted_at: null }])
  const bilan = await mod.traiterAlarmes([
    { userId: 'u1', propertyId: 'p1', propertyName: 'La bulle', nuits: ['2026-10-12'], bookings: ['a', 'b'], unites: 1 }
  ])
  assert.strictEqual(envois.length, 0, 'pas de SMS toutes les 5 minutes')
  assert.strictEqual(bilan.relances, 0)
  assert.ok(capture.updates.length >= 1, 'le detail est tout de meme rafraichi')
})

test('ALARME : un incident ACQUITTE fait TAIRE tant que le conflit ne change pas', async () => {
  // ⚠ REGRESSION ATTRAPEE EN REVIEW. Premiere version : on ne chargeait que les
  // incidents ouverts, donc apres acquittement le cycle suivant (5 min) creait un
  // incident neuf et CRIAIT aussitot. Cliquer « J'ai vu — arreter l'alerte »
  // faisait arriver le SMS suivant en 5 min au lieu de 45 : l'exact inverse.
  const capture = {}
  const envois = []
  const g = { userId: 'u1', propertyId: 'p1', propertyName: 'La bulle', nuits: ['2026-10-12'], bookings: ['a', 'b'], unites: 1 }
  const mod = requireFrais(capture, envois, [
    { id: 'inc-1', user_id: 'u1', property_id: 'p1', acquitted_at: new Date().toISOString(),
      acquitted_by: 'humain-1', detail: { signature: signature(g) } }
  ])
  const bilan = await mod.traiterAlarmes([g])
  assert.strictEqual(bilan.tus, 1, 'l\'alarme se tait')
  assert.strictEqual(capture.inserts.length, 0, 'aucun incident neuf')
  assert.strictEqual(envois.length, 0, 'AUCUN SMS')
})

test('ALARME : le conflit CHANGE apres acquittement -> l\'alarme repart', async () => {
  // « J'ai vu CE conflit-la » : une nuit de plus est un probleme nouveau.
  const capture = {}
  const envois = []
  const vu = { userId: 'u1', propertyId: 'p1', propertyName: 'La bulle', nuits: ['2026-10-12'], bookings: ['a', 'b'], unites: 1 }
  const nouveau = { ...vu, nuits: ['2026-10-12', '2026-10-13'] }
  const mod = requireFrais(capture, envois, [
    { id: 'inc-1', user_id: 'u1', property_id: 'p1', acquitted_at: new Date().toISOString(),
      acquitted_by: 'humain-1', detail: { signature: signature(vu) } }
  ])
  const bilan = await mod.traiterAlarmes([nouveau])
  assert.strictEqual(bilan.tus, 0)
  assert.strictEqual(bilan.ouverts, 1, 'un incident neuf')
  assert.strictEqual(envois.length, 1, 'et il crie')
})

test('SIGNATURE : stable a l\'ordre pres, sensible au contenu', () => {
  const a = { nuits: ['2026-10-13', '2026-10-12'], bookings: ['b', 'a'] }
  const b = { nuits: ['2026-10-12', '2026-10-13'], bookings: ['a', 'b'] }
  assert.strictEqual(signature(a), signature(b))
  assert.notStrictEqual(signature(a), signature({ nuits: ['2026-10-12'], bookings: ['a', 'b'] }))
  assert.notStrictEqual(signature(a), signature({ nuits: a.nuits, bookings: ['a', 'c'] }))
})

test('ALARME : conflit disparu -> alarme ETEINTE automatiquement', async () => {
  // Seul cas d'extinction sans humain : le probleme n'existe plus.
  const capture = {}
  const envois = []
  const mod = requireFrais(capture, envois, [{ id: 'inc-1', user_id: 'u1', property_id: 'p1', last_alerted_at: null, acquitted_at: null }])
  const bilan = await mod.traiterAlarmes([])       // plus aucun conflit
  assert.strictEqual(bilan.refermes, 1)
  assert.strictEqual(envois.length, 0, 'on ne crie pas pour dire que tout va bien')
  assert.ok(capture.updates.some(u => u.acquitted_at), 'l\'incident est clos')
})

// Recharge le module avec des dependances mockees (supabase + envoi).
function requireFrais (capture, envois, ouverts) {
  const cheminMod = require.resolve('../lib/cron-overbooking')
  const cheminShared = require.resolve('../lib/cron-shared')
  const cheminNotify = require.resolve('../lib/founder-notify')
  delete require.cache[cheminMod]
  require.cache[cheminShared] = { id: cheminShared, filename: cheminShared, loaded: true, exports: { supabase: fakeSupabase({ ouverts, capture }) } }
  const cheminPlatform = require.resolve('../lib/platform-notify')
  const cheminSms = require.resolve('../api/sms')
  require.cache[cheminNotify] = { id: cheminNotify, filename: cheminNotify, loaded: true,
    exports: { envoyerAlerteBrute: async (type, opts) => { envois.push(opts); return { sms: true } }, LABELS: {} } }
  // L'alerte a l'hote passe par platform-notify : on la neutralise ici, les
  // envois comptes restent ceux du canal fondateur.
  require.cache[cheminPlatform] = { id: cheminPlatform, filename: cheminPlatform, loaded: true,
    exports: { sendPlatformSms: async () => ({ success: true }), sendPlatformEmail: async () => ({ ok: true }) } }
  // L'alerte a l'hote part sur la cle de l'HOTE (api/sms), pas la cle plateforme.
  require.cache[cheminSms] = { id: cheminSms, filename: cheminSms, loaded: true,
    exports: { sendSms: async () => ({ success: true }) } }
  const m = require('../lib/cron-overbooking')
  delete require.cache[cheminMod]
  delete require.cache[cheminShared]
  delete require.cache[cheminNotify]
  delete require.cache[cheminPlatform]
  delete require.cache[cheminSms]
  return m
}

test('ALARME : une fermeture AUTOMATIQUE ne vaut pas « vu » — l\'alarme repart', async () => {
  // ⚠ REGRESSION ATTRAPEE EN REVIEW. La fermeture auto (conflit disparu) pose
  // aussi `acquitted_at`, mais SANS auteur. La confondre avec un acquittement
  // humain rendait l'alarme definitivement muette sur ce scenario : conflit ->
  // reservation annulee -> incident auto-ferme -> l'annulation revient en
  // `confirmed` (modification OTA) -> meme signature -> silence, alors que
  // personne n'avait rien vu.
  const capture = {}
  const envois = []
  const g = { userId: 'u1', propertyId: 'p1', propertyName: 'La bulle', nuits: ['2026-10-12'], bookings: ['a', 'b'], unites: 1 }
  const mod = requireFrais(capture, envois, [
    { id: 'inc-1', user_id: 'u1', property_id: 'p1', acquitted_at: new Date().toISOString(),
      acquitted_by: null, detail: { signature: signature(g) } }   // fermeture AUTO
  ])
  const bilan = await mod.traiterAlarmes([g])
  assert.strictEqual(bilan.tus, 0, 'une fermeture auto ne fait pas taire')
  assert.strictEqual(bilan.ouverts, 1)
  assert.strictEqual(envois.length, 1, 'l\'alarme crie de nouveau')
})
