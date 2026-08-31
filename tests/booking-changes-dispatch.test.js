// tests/booking-changes-dispatch.test.js
// Garde anti-boucle du dispatcher + production d'evenements cote Channex.
// Le dispatcher parle a Supabase et aux consommateurs : on charge donc le module
// avec un cache de require pre-rempli par des doubles (aucun reseau, aucune cle).

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

// ─── Injection de doubles dans le cache de require ───────────────────────────
function stub(relPath, exports) {
  const abs = require.resolve(path.join(__dirname, '..', relPath))
  const m = new Module(abs)
  m.exports = exports
  m.loaded = true
  require.cache[abs] = m
  return abs
}

function chargerDispatcher({ events, menageThrows = false, accessThrows = false, templateThrows = false }) {
  const etat = {
    updates: [],
    incidents: [],
    menageWrites: 0,
    appels: { menages: 0, access: 0, templates: 0 }
  }

  const table = (nom) => {
    const q = {
      select() { return q }, is() { return q }, order() { return q },
      in() { return q }, not() { return q }, eq(col, val) { q._eq = val; return q },
      limit: async () => ({ data: nom === 'booking_change_events' ? events : [], error: null }),
      update(payload) { q._payload = payload; return q },
      insert: async () => ({ error: null }),
      then(res, rej) {
        // `await supabase.from(x).select().in(...)` sans .limit()
        const data = nom === 'bookings_snapshot'
          ? events.map(e => ({ booking_id: e.booking_id, snapshot: { firstName: 'Jean', lastName: 'Dupont', arrival: '2026-09-01', departure: '2026-09-05', numAdult: 2, numChild: 0, source: 'airbnb' } }))
          : []
        return Promise.resolve({ data, error: null }).then(res, rej)
      }
    }
    // .update({...}).eq('id', x) doit etre awaitable et enregistrer l'update
    const origEq = q.eq
    q.eq = (col, val) => {
      origEq(col, val)
      if (q._payload) {
        const p = Promise.resolve({ error: null })
        etat.updates.push({ id: val, payload: q._payload })
        return p
      }
      return q
    }
    return q
  }

  stub('lib/cron-shared.js', { supabase: { from: table } })
  stub('lib/founder-notify.js', {
    reportIncident: async (type, detail) => { etat.incidents.push({ type, detail }) }
  })
  const cle = (u, p) => `${u}|${String(p)}`
  stub('lib/cleaning/sync-menages.js', {
    cle,
    syncMenageEvent: async (event, { tokens }) => {
      etat.appels.menages++
      etat.tokensRecus = tokens
      if (menageThrows) throw new Error('menage_events insert: boom')
      etat.menageWrites++
      return { written: 1 }
    },
    loadContext: async () => ({
      tokens: [{ token: 'tok', property_ids: [], user_id: 'u1' }],
      propsByKey: {
        [cle('u1', '12345')]:      { name: 'Bien test', provider: 'beds24', address: '1 rue A' },
        [cle('u1', 'uuid-channex')]: { name: 'Bien Channex', provider: 'channex', address: '2 rue B' }
      },
      knowledgeByKey: {
        [cle('u1', '12345')]: { telephone_hote: '0600000000', checkin: '15:00', checkout: '11:00' }
      }
    })
  })
  stub('lib/cron-access.js', {
    cancelAccessCode: async () => { etat.appels.access++; if (accessThrows) throw new Error('seam down') },
    refreshAccessCode: async () => { etat.appels.access++; if (accessThrows) throw new Error('seam down') },
    checkBatteries: async () => {}
  })
  stub('lib/cron-messages.js', {
    triggerTemplates: async () => { etat.appels.templates++; if (templateThrows) throw new Error('brevo down') },
    processMessageTemplates: async () => {}
  })

  delete require.cache[require.resolve('../lib/booking-changes-dispatch')]
  const mod = require('../lib/booking-changes-dispatch')
  return { mod, etat }
}

const ev = (o = {}) => ({
  id: 'e1', user_id: 'u1', booking_id: '77', property_id: '12345',
  provider: 'beds24', type: 'new', changes: null, created_at: '2026-08-31T12:00:00Z',
  processed_at: null, ...o
})

test('cycle nominal : les trois consommateurs sont appeles, evenement marque traite', async () => {
  const { mod, etat } = chargerDispatcher({ events: [ev()] })
  const out = await mod.dispatchBookingChanges({})
  assert.strictEqual(out.traites, 1)
  assert.strictEqual(out.echecs, 0)
  assert.strictEqual(etat.appels.menages, 1)
  assert.strictEqual(etat.appels.templates, 1)   // 'new' -> booking_confirmed
  assert.strictEqual(etat.updates.length, 1)
  assert.ok(etat.updates[0].payload.processed_at)
  assert.strictEqual(etat.updates[0].payload.processing_errors, null)
})

test('GARDE ANTI-BOUCLE : un consommateur qui jette -> incident, evenement marque QUAND MEME', async () => {
  const { mod, etat } = chargerDispatcher({ events: [ev()], menageThrows: true })
  const out = await mod.dispatchBookingChanges({})

  assert.strictEqual(out.echecs, 1)
  assert.strictEqual(out.traites, 1)

  // L'evenement est marque traite malgre l'echec : pas de retraitement automatique.
  assert.strictEqual(etat.updates.length, 1)
  assert.ok(etat.updates[0].payload.processed_at, 'processed_at pose malgre l\'echec')
  assert.strictEqual(etat.updates[0].payload.processing_errors[0].consommateur, 'menages')

  // Et un incident est trace.
  assert.strictEqual(etat.incidents.length, 1)
  assert.strictEqual(etat.incidents[0].type, 'booking_change_dispatch')
})

test('un consommateur qui jette n\'empeche pas les suivants', async () => {
  const { mod, etat } = chargerDispatcher({ events: [ev()], menageThrows: true })
  await mod.dispatchBookingChanges({})
  assert.strictEqual(etat.appels.templates, 1, 'les templates tournent malgre l\'echec menage')
})

test('echecs multiples : tous traces, un seul marquage', async () => {
  const { mod, etat } = chargerDispatcher({
    events: [ev({ type: 'cancelled' })], menageThrows: true, accessThrows: true
  })
  await mod.dispatchBookingChanges({})
  const err = etat.updates[0].payload.processing_errors
  assert.strictEqual(err.length, 2)
  assert.deepStrictEqual(err.map(e => e.consommateur).sort(), ['codes_acces', 'menages'])
})

test('cycle suivant : plus aucun evenement en attente -> rien n\'est rejoue', async () => {
  // Le dispatcher ne lit que processed_at null ; une file vide ne fait rien.
  const { mod, etat } = chargerDispatcher({ events: [] })
  const out = await mod.dispatchBookingChanges({})
  assert.strictEqual(out.traites, 0)
  assert.strictEqual(etat.updates.length, 0)
  assert.strictEqual(etat.incidents.length, 0)
})

test('templates : uniquement sur new, jamais sur modified ni cancelled', async () => {
  for (const type of ['modified', 'cancelled']) {
    const { mod, etat } = chargerDispatcher({ events: [ev({ type })] })
    await mod.dispatchBookingChanges({})
    assert.strictEqual(etat.appels.templates, 0, `type ${type}`)
  }
})

test('codes d\'acces : cancelled -> annulation ; modified sans date -> rien', async () => {
  const c = chargerDispatcher({ events: [ev({ type: 'cancelled' })] })
  await c.mod.dispatchBookingChanges({})
  assert.strictEqual(c.etat.appels.access, 1)

  // modified sur numChild seul : le code d'acces ne bouge pas
  const m = chargerDispatcher({ events: [ev({ type: 'modified', changes: { numChild: { before: 0, after: 1 }, arrival: null, departure: null } })] })
  await m.mod.dispatchBookingChanges({})
  assert.strictEqual(m.etat.appels.access, 0)

  // modified sur arrival : regeneration
  const a = chargerDispatcher({ events: [ev({ type: 'modified', changes: { arrival: { before: 'a', after: 'b' }, departure: null } })] })
  await a.mod.dispatchBookingChanges({})
  assert.strictEqual(a.etat.appels.access, 1)
})

test('WEBHOOK CHANNEX : un evenement channex est distribue comme un Beds24 (E2)', async () => {
  const { mod, etat } = chargerDispatcher({
    events: [ev({ provider: 'channex', property_id: 'uuid-channex', type: 'new' })]
  })
  const out = await mod.dispatchBookingChanges({})
  assert.strictEqual(out.traites, 1)
  assert.strictEqual(etat.appels.menages, 1, 'un bien Channex produit bien un menage_event')
  assert.strictEqual(out.menageEvents, 1)
})

test('bookingDepuisSnapshot : reconstruit les champs attendus par les consommateurs', () => {
  const { mod } = chargerDispatcher({ events: [] })
  const b = mod.bookingDepuisSnapshot(
    { booking_id: '77', property_id: '12345' },
    { firstName: 'Marie', lastName: 'Martin', arrival: '2026-09-01', departure: '2026-09-05', source: 'booking' }
  )
  assert.strictEqual(b.id, '77')
  assert.strictEqual(b.propertyId, '12345')
  assert.strictEqual(b.firstName, 'Marie')
  assert.strictEqual(b.source, 'booking')   // hasMessagingThread s'appuie dessus
})

// ─── Reconstruction du bien (regression signalee par la revue) ──────────────
// Un property ampute a {id, name} route tout vers Beds24 : un hote Channex-only
// part vers sendViaBeds24 sans cle -> echec silencieux, et message_sent_log
// etant ecrit AVANT l'envoi, le message n'est jamais rejoue.

test('property reconstruit : provider present -> routage d\'envoi correct', () => {
  const { mod } = chargerDispatcher({ events: [] })
  const ctx = {
    propsByKey: { 'u1|uuid-channex': { name: 'Villa', provider: 'channex', address: '2 rue B' } },
    knowledgeByKey: {}
  }
  const p = mod.propertyDepuisContexte({ user_id: 'u1', property_id: 'uuid-channex', provider: 'channex' }, ctx)
  assert.strictEqual(p.provider, 'channex', 'sans provider, sendGuestMessage partirait vers Beds24')
  assert.strictEqual(p.name, 'Villa')
})

test('property reconstruit : les placeholders des templates sont alimentes', () => {
  const { mod } = chargerDispatcher({ events: [] })
  const ctx = {
    propsByKey: { 'u1|12345': { name: 'Bien', provider: 'beds24', address: '1 rue A' } },
    knowledgeByKey: { 'u1|12345': { telephone_hote: '0600000000', checkin: '15:00', checkout: '11:00' } }
  }
  const p = mod.propertyDepuisContexte({ user_id: 'u1', property_id: '12345', provider: 'beds24' }, ctx)
  assert.strictEqual(p.address, '1 rue A')        // {adresse}
  assert.strictEqual(p.phone, '0600000000')       // {telephone_hote}
  assert.strictEqual(p.checkInStart, '15:00')     // {checkin} (defaut 18:00 sinon)
  assert.strictEqual(p.checkOutEnd, '11:00')      // {checkout} (defaut 10:00 sinon)
})

test('property reconstruit : le provider de l\'evenement sert de repli', () => {
  const { mod } = chargerDispatcher({ events: [] })
  const p = mod.propertyDepuisContexte(
    { user_id: 'u1', property_id: 'inconnu', provider: 'channex' },
    { propsByKey: {}, knowledgeByKey: {} }
  )
  assert.strictEqual(p.provider, 'channex')
})

test('ISOLATION : le bien d\'un autre hote n\'est jamais repris (cle composite)', () => {
  const { mod } = chargerDispatcher({ events: [] })
  const ctx = {
    propsByKey: {
      'u1|1': { name: 'Bien de A', provider: 'beds24', address: 'chez A' },
      'u2|1': { name: 'Bien de B', provider: 'channex', address: 'chez B' }
    },
    knowledgeByKey: {}
  }
  // Meme provider_property_id '1' chez deux hotes : aucune contrainte d'unicite
  // globale ne l'interdit (cf. lib/cron-beds24-props.js).
  const pA = mod.propertyDepuisContexte({ user_id: 'u1', property_id: '1' }, ctx)
  const pB = mod.propertyDepuisContexte({ user_id: 'u2', property_id: '1' }, ctx)
  assert.strictEqual(pA.name, 'Bien de A')
  assert.strictEqual(pA.address, 'chez A')
  assert.strictEqual(pB.name, 'Bien de B')
  assert.strictEqual(pB.provider, 'channex')
})

test('les tokens transmis au consommateur menage sont ceux du lot complet (filtrage en aval)', async () => {
  const { mod, etat } = chargerDispatcher({ events: [ev()] })
  await mod.dispatchBookingChanges({})
  // Le dispatcher passe la liste ; c'est syncMenageEvent qui filtre par user_id
  // (verrouille par tests/sync-menages.test.js).
  assert.ok(Array.isArray(etat.tokensRecus))
})
