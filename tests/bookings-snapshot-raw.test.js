// tests/bookings-snapshot-raw.test.js
// Lancement : npm test  (node --test, aucune dependance externe)
//
// Sous-chantier A : le writer conserve le payload provider integral.
// Regle gravee (docs/specs/spec-historique-reservations.md §4) :
//
//   « Un evenement est declenche SI ET SEULEMENT SI `merged` change. Le `raw` est
//     stocke, JAMAIS compare. Si le payload brut differe mais que `merged` est
//     identique : mettre a jour `raw` silencieusement, SANS evenement et SANS
//     toucher `updated_at`. »

const test = require('node:test')
const assert = require('node:assert')

const {
  stableStringify,
  memeContenu,
  empreinte,
  fromBeds24,
  saveBookingSnapshot,
  saveBookingSnapshots
} = require('../lib/bookings-snapshot')

// ─── Mock : distingue upsert (ligne complete) et update (raw seul) ───────────
function fakeSupabase ({ existing = null, existingRaw = null, existingPropId = '12345',
                         capture = {}, updateError = null } = {}) {
  capture.upserts = capture.upserts || []
  capture.updates = capture.updates || []
  capture.events  = capture.events  || []
  return {
    from () {
      const b = {
        _patch: null,
        select () { return b },
        eq () { return b },
        in () { return b },
        maybeSingle: async () => ({
          // La colonne `raw` n'est jamais relue : seule son empreinte l'est.
          data: existing ? { snapshot: existing, property_id: existingPropId, raw_hash: empreinte(existingRaw) } : null
        }),
        upsert: async (row) => { capture.upserts.push(row); return { error: null } },
        insert: async (row) => { capture.events.push(row); return { error: null } },
        update (patch) { b._patch = patch; return b },
        // Rend le builder attendable : c'est la forme `update(...).eq(...).eq(...)`.
        then (resoudre) {
          if (b._patch) { capture.updates.push(b._patch); b._patch = null }
          return Promise.resolve(updateError ? { error: { message: updateError } } : { error: null }).then(resoudre)
        }
      }
      return b
    }
  }
}

const SNAP_BASE = {
  provider: 'beds24', status: 'confirmed', statusRaw: 'new',
  arrival: '2099-09-01', departure: '2099-09-05',
  firstName: 'Jean', lastName: 'Durand', numAdult: 2, numChild: 0,
  source: 'airbnb', otaReservationCode: 'HMXXXX', amount: 160, commission: 29.76
}
// Un booking Beds24 qui produit exactement SNAP_BASE.
const BOOKING_BASE = {
  id: 77, status: 'new', arrival: '2099-09-01', departure: '2099-09-05',
  firstName: 'Jean', lastName: 'Durand', numAdult: 2, numChild: 0,
  channel: 'airbnb', apiReference: 'HMXXXX', price: 160, commission: 29.76,
  bookingTime: '2099-01-01T10:00:00Z', invoiceItems: [{ type: 'charge', lineTotal: 130.24 }]
}

// ─── Comparaison stable ─────────────────────────────────────────────────────

test('stableStringify : l\'ordre des cles ne compte pas', () => {
  // Postgres jsonb reordonne les cles : le raw relu n'a jamais l'ordre du mapper.
  assert.strictEqual(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }))
  assert.ok(memeContenu({ x: { y: 1, z: 2 } }, { x: { z: 2, y: 1 } }), 'recursif')
})

test('stableStringify : l\'ordre des TABLEAUX compte', () => {
  // Dans un payload provider (invoiceItems, rooms, days_breakdown) l'ordre porte
  // du sens : deux ordres differents sont deux payloads differents.
  assert.ok(!memeContenu({ items: [1, 2] }, { items: [2, 1] }))
})

test('stableStringify : null, undefined et valeurs simples', () => {
  assert.ok(memeContenu(null, null))
  assert.ok(!memeContenu(null, {}))
  assert.ok(!memeContenu({ a: 1 }, { a: '1' }), 'le type compte')
  assert.ok(memeContenu([{ b: 1, a: 2 }], [{ a: 2, b: 1 }]), 'objets dans un tableau')
})

// ─── Le raw est ecrit ───────────────────────────────────────────────────────

test('RAW : une ligne neuve porte le payload provider integral', async () => {
  const capture = {}
  const sb = fakeSupabase({ capture })
  const res = await saveBookingSnapshot(sb, {
    userId: 'u1', bookingId: 77, propertyId: 12345, provider: 'beds24', booking: BOOKING_BASE
  })
  assert.strictEqual(res.ok, true)
  assert.strictEqual(capture.upserts.length, 1)
  assert.deepStrictEqual(capture.upserts[0].raw, BOOKING_BASE, 'le payload entier, pas les 14 champs')
  assert.strictEqual(capture.upserts[0].raw_hash, empreinte(BOOKING_BASE), 'empreinte posee avec le payload')
  assert.ok(capture.upserts[0].raw.invoiceItems, 'y compris ce que le snapshot jette')
  assert.ok(capture.upserts[0].raw.bookingTime)
})

// ─── LE CŒUR DE LA REGLE : raw seul modifie ─────────────────────────────────

test('REGLE §4 : raw modifie seul -> UPDATE cible, aucun evenement, updated_at INTACT', async () => {
  const capture = {}
  // Meme reservation, mais Beds24 a ajoute une ligne de facture et bouge modifiedTime.
  const bookingEnrichi = {
    ...BOOKING_BASE,
    modifiedTime: '2099-02-02T12:00:00Z',
    invoiceItems: [{ type: 'charge', lineTotal: 130.24 }, { type: 'charge', lineTotal: 12 }]
  }
  const sb = fakeSupabase({ existing: SNAP_BASE, existingRaw: BOOKING_BASE, capture })
  const res = await saveBookingSnapshot(sb, {
    userId: 'u1', bookingId: 77, propertyId: 12345, provider: 'beds24', booking: bookingEnrichi
  })

  assert.strictEqual(res.ok, true)
  assert.strictEqual(res.inchange, true, 'contenu normalise inchange')
  assert.strictEqual(res.rawMisAJour, true)
  assert.strictEqual(res.change, null, 'AUCUN changement detecte')
  assert.strictEqual(capture.events.length, 0, 'AUCUN evenement : ni menage, ni code, ni message')
  assert.strictEqual(capture.upserts.length, 0, 'pas d\'upsert de la ligne complete')
  assert.strictEqual(capture.updates.length, 1, 'un UPDATE cible')
  assert.deepStrictEqual(Object.keys(capture.updates[0]).sort(), ['raw', 'raw_hash'], 'raw et son empreinte, rien d\'autre')
  assert.ok(!('updated_at' in capture.updates[0]), 'updated_at NON touche')
  assert.deepStrictEqual(capture.updates[0].raw, bookingEnrichi)
})

test('REGLE §4 : raw identique a l\'ordre des cles pres -> RIEN du tout', async () => {
  // Le piege : jsonb rend les cles dans un autre ordre que le mapper. Sans
  // comparaison stable, chaque cycle reecrirait toutes les lignes pour rien.
  const capture = {}
  const memePayloadAutreOrdre = {}
  Object.keys(BOOKING_BASE).sort().forEach(k => { memePayloadAutreOrdre[k] = BOOKING_BASE[k] })
  assert.notStrictEqual(JSON.stringify(memePayloadAutreOrdre), JSON.stringify(BOOKING_BASE),
    'les deux ordres different bien pour un stringify naif')

  const sb = fakeSupabase({ existing: SNAP_BASE, existingRaw: memePayloadAutreOrdre, capture })
  const res = await saveBookingSnapshot(sb, {
    userId: 'u1', bookingId: 77, propertyId: 12345, provider: 'beds24', booking: BOOKING_BASE
  })
  assert.strictEqual(res.inchange, true)
  assert.strictEqual(res.rawMisAJour, undefined, 'aucune reecriture')
  assert.strictEqual(capture.updates.length, 0)
  assert.strictEqual(capture.upserts.length, 0)
  assert.strictEqual(capture.events.length, 0)
})

test('REGLE §4 : merged change -> upsert complet AVEC raw ET evenement', async () => {
  const capture = {}
  const bookingDecale = { ...BOOKING_BASE, departure: '2099-09-07' }
  const sb = fakeSupabase({ existing: SNAP_BASE, existingRaw: BOOKING_BASE, capture })
  const res = await saveBookingSnapshot(sb, {
    userId: 'u1', bookingId: 77, propertyId: 12345, provider: 'beds24', booking: bookingDecale
  })
  assert.strictEqual(res.change.type, 'modified')
  assert.strictEqual(capture.updates.length, 0, 'pas d\'update cible : c\'est un vrai changement')
  assert.strictEqual(capture.upserts.length, 1)
  assert.ok(capture.upserts[0].updated_at, 'updated_at pose, le contenu a change')
  assert.deepStrictEqual(capture.upserts[0].raw, bookingDecale)
  assert.strictEqual(capture.events.length, 1)
})

// ─── Ne jamais effacer un raw connu ─────────────────────────────────────────

test('RAW : un appelant qui ne fournit pas la source n\'efface pas le raw en base', async () => {
  // cron-channel-feed et channel-webhook mappent eux-memes ; s'ils omettaient la
  // source, la colonne ne doit pas etre remise a null pour autant.
  const capture = {}
  const sb = fakeSupabase({ existing: SNAP_BASE, existingRaw: BOOKING_BASE, capture })
  await saveBookingSnapshot(sb, {
    userId: 'u1', bookingId: 77, propertyId: 12345, provider: 'beds24',
    snapshot: { ...SNAP_BASE, departure: '2099-09-09' }   // pas de `booking`
  })
  assert.strictEqual(capture.upserts.length, 1)
  assert.ok(!('raw' in capture.upserts[0]), 'la colonne raw n\'est pas citee -> intacte')
})

test('RAW : contenu normalise inchange et pas de source -> aucune ecriture', async () => {
  const capture = {}
  const sb = fakeSupabase({ existing: SNAP_BASE, existingRaw: BOOKING_BASE, capture })
  const res = await saveBookingSnapshot(sb, {
    userId: 'u1', bookingId: 77, propertyId: 12345, provider: 'beds24', snapshot: SNAP_BASE
  })
  assert.strictEqual(res.inchange, true)
  assert.strictEqual(capture.updates.length, 0)
  assert.strictEqual(capture.upserts.length, 0)
})

test('RAW : un echec d\'UPDATE ne fait pas echouer le cycle', async () => {
  const capture = {}
  const sb = fakeSupabase({
    existing: SNAP_BASE, existingRaw: BOOKING_BASE, capture,
    updateError: 'column "raw" does not exist'
  })
  const erreurs = []
  const vraiErr = console.error
  console.error = (...a) => erreurs.push(a.join(' '))
  try {
    const res = await saveBookingSnapshot(sb, {
      userId: 'u1', bookingId: 77, propertyId: 12345, provider: 'beds24',
      booking: { ...BOOKING_BASE, modifiedTime: 'x' }
    })
    assert.strictEqual(res.ok, true, 'le contenu normalise est deja a jour')
    assert.strictEqual(res.rawEchec, true)
    assert.strictEqual(erreurs.length, 1, 'mais l\'echec est dit')
  } finally { console.error = vraiErr }
})

// ─── Test regle 8 de la spec : l'annulation Channex a payload vide ──────────

test('REGLE 8 : annulation Channex a payload vide -> pas de faux merged, raw remplace', async () => {
  // Le cas de la regression du commit 5f1777d : Channex sert une annulation dont
  // arrival_date, departure_date et rooms sont vides. Elle doit rester une
  // annulation franche, et le raw doit refleter ce que le provider a REELLEMENT
  // envoye — c'est tout l'interet de le conserver.
  const capture = {}
  const snapConfirme = {
    provider: 'channex', status: 'confirmed', statusRaw: 'new',
    arrival: '2099-09-20', departure: '2099-09-21', firstName: 'X', lastName: '',
    numAdult: 2, numChild: 0, source: 'BookingCom', otaReservationCode: '66899'
  }
  const revVide = {
    id: 'a3f88358', status: 'cancelled', arrival_date: null, departure_date: null,
    amount: '97.00', currency: 'EUR', ota_name: 'BookingCom', rooms: [], occupancy: {}
  }
  const { fromChannex } = require('../lib/bookings-snapshot')
  const sb = fakeSupabase({ existing: snapConfirme, existingRaw: { id: 'a3f88358', status: 'new' }, capture })
  const res = await saveBookingSnapshot(sb, {
    userId: 'u1', bookingId: 'a3f88358', propertyId: 'p-uuid', provider: 'channex',
    snapshot: fromChannex(revVide), booking: revVide, existingPropertyId: 'p-uuid'
  })
  assert.strictEqual(res.change.type, 'cancelled', 'l\'annulation part bien')
  assert.strictEqual(capture.upserts.length, 1)
  assert.strictEqual(capture.upserts[0].snapshot.status, 'cancelled')
  assert.deepStrictEqual(capture.upserts[0].raw, revVide, 'le raw dit ce que le provider a envoye')
  assert.strictEqual(capture.events.length, 1)
})

// ─── Le lot ─────────────────────────────────────────────────────────────────

test('LOT : le prefetch relit le raw et compte les rafraichissements', async () => {
  const stats = { upserts: [], updates: [], events: [] }
  const rows = [{ booking_id: '1', snapshot: SNAP_BASE, property_id: '12345', raw_hash: empreinte(BOOKING_BASE) }]
  const client = {
    from () {
      const b = {
        _patch: null,
        select () { return b },
        eq () { return b },
        in () { return b },
        maybeSingle: async () => ({ data: null }),
        upsert: async (r) => { stats.upserts.push(r); return { error: null } },
        insert: async (r) => { stats.events.push(r); return { error: null } },
        update (p) { b._patch = p; return b },
        then (res) {
          if (b._patch) { stats.updates.push(b._patch); b._patch = null; return Promise.resolve({ error: null }).then(res) }
          return Promise.resolve({ data: rows, error: null }).then(res)
        }
      }
      return b
    }
  }
  const out = await saveBookingSnapshots(client, {
    userId: 'u1', propertyId: '12345', provider: 'beds24',
    bookings: [{ ...BOOKING_BASE, id: 1, modifiedTime: 'bouge' }]
  })
  assert.strictEqual(out.inchanges, 1, 'contenu normalise inchange')
  assert.strictEqual(out.rawMisAJour, 1, 'mais le raw a ete rafraichi')
  assert.strictEqual(stats.events.length, 0, 'aucun evenement')
  assert.strictEqual(stats.upserts.length, 0, 'aucune reecriture de ligne')
  assert.strictEqual(stats.updates.length, 1)
})

// ─── Corrections issues de la review ────────────────────────────────────────

test('EMPREINTE : insensible a l\'ordre des cles, sensible au contenu', () => {
  const melange = {}
  Object.keys(BOOKING_BASE).sort().forEach(k => { melange[k] = BOOKING_BASE[k] })
  assert.strictEqual(empreinte(BOOKING_BASE), empreinte(melange))
  assert.notStrictEqual(empreinte(BOOKING_BASE), empreinte({ ...BOOKING_BASE, price: 161 }))
  assert.strictEqual(empreinte(null), null)
  assert.strictEqual(empreinte(undefined), null, 'absent et null se valent : pas d\'UPDATE en boucle')
})

test('COLONNE ABSENTE : repli sur un upsert sans raw, l\'evenement n\'est PAS rejoue', async () => {
  // Sans ce repli, l'echec est PERMANENT : l'evenement est journalise avant
  // l'upsert et le snapshot n'avance pas, donc le meme changement est redetecte
  // a chaque cycle */5 et le dispatcher renvoie message, menage et code
  // indefiniment. Ce test verifie qu'on retombe sur une ecriture qui passe.
  const capture = { upserts: [], events: [], updates: [] }
  let premierAppel = true
  const sb = {
    from () {
      const b = {
        select () { return b }, eq () { return b }, in () { return b },
        maybeSingle: async () => ({ data: null }),
        insert: async (row) => { capture.events.push(row); return { error: null } },
        upsert: async (row) => {
          // Clone : le repli mute l'objet passe (delete ligne.raw), et capturer la
          // reference ferait disparaitre `raw` du premier appel apres coup.
          capture.upserts.push({ ...row })
          if (premierAppel && 'raw' in row) {
            premierAppel = false
            return { error: { code: 'PGRST204', message: "Could not find the 'raw' column of 'bookings_snapshot' in the schema cache" } }
          }
          return { error: null }
        },
        update (p) { b._patch = p; return b },
        then (r) { return Promise.resolve({ error: null }).then(r) }
      }
      return b
    }
  }
  const vraiErr = console.error
  console.error = () => {}
  try {
    const res = await saveBookingSnapshot(sb, {
      userId: 'u1', bookingId: 77, propertyId: 12345, provider: 'beds24', booking: BOOKING_BASE
    })
    assert.strictEqual(res.ok, true, 'le contenu normalise passe malgre tout')
    assert.strictEqual(capture.upserts.length, 2, 'un essai avec raw, un repli sans')
    assert.ok('raw' in capture.upserts[0])
    assert.ok(!('raw' in capture.upserts[1]), 'le repli ne porte plus le payload')
    assert.ok(!('raw_hash' in capture.upserts[1]))
    assert.deepStrictEqual(capture.upserts[1].snapshot, capture.upserts[0].snapshot, 'meme contenu normalise')
    assert.strictEqual(capture.events.length, 1, 'l\'evenement est consomme UNE fois')
  } finally { console.error = vraiErr }
})

test('BUDGET : le remplissage du raw est borne par cycle, le reste est differe', async () => {
  // Ces UPDATE sont sequentiels et vivent dans le cron */5 : au premier cycle
  // apres migration, cron-classify peut presenter jusqu'a 500 lignes par bien.
  // Toutes les ecrire d'un coup depasserait le plafond de 60 s de la fonction.
  const stats = { upserts: [], updates: [], events: [] }
  const rows = []
  const bookings = []
  for (let i = 1; i <= 10; i++) {
    bookings.push({ ...BOOKING_BASE, id: i })
    // Ligne existante a jour cote contenu, mais sans empreinte : raw a remplir.
    rows.push({ booking_id: String(i), snapshot: SNAP_BASE, property_id: '12345', raw_hash: null })
  }
  const client = {
    from () {
      const b = {
        _patch: null,
        select () { return b }, eq () { return b }, in () { return b },
        maybeSingle: async () => ({ data: null }),
        upsert: async (r) => { stats.upserts.push(r); return { error: null } },
        insert: async (r) => { stats.events.push(r); return { error: null } },
        update (p) { b._patch = p; return b },
        then (res) {
          if (b._patch) { stats.updates.push(b._patch); b._patch = null; return Promise.resolve({ error: null }).then(res) }
          return Promise.resolve({ data: rows, error: null }).then(res)
        }
      }
      return b
    }
  }
  const out = await saveBookingSnapshots(client, {
    userId: 'u1', propertyId: '12345', provider: 'beds24', bookings,
    budgetRaw: { restant: 4 }
  })
  assert.strictEqual(out.rawMisAJour, 4, 'quatre rafraichissements, pas dix')
  assert.strictEqual(out.rawDifferes, 6, 'les six autres attendent le cycle suivant')
  assert.strictEqual(stats.updates.length, 4)
  assert.strictEqual(out.inchanges, 10, 'toutes restent « inchangees » cote contenu')
  assert.strictEqual(stats.events.length, 0, 'et aucune ne notifie qui que ce soit')
  assert.strictEqual(stats.upserts.length, 0)
})

test('COMPTEURS : un echec de maj du raw remonte dans le resume du lot', async () => {
  // Sans compteur, un echec systematique (droit manquant, colonne absente) etait
  // invisible : le resume annoncait « N inchangees », tout paraissait sain, et
  // `raw` restait vide indefiniment.
  const rows = [{ booking_id: '1', snapshot: SNAP_BASE, property_id: '12345', raw_hash: null }]
  const client = {
    from () {
      const b = {
        _patch: null,
        select () { return b }, eq () { return b }, in () { return b },
        maybeSingle: async () => ({ data: null }),
        upsert: async () => ({ error: null }),
        insert: async () => ({ error: null }),
        update (p) { b._patch = p; return b },
        then (res) {
          if (b._patch) { b._patch = null; return Promise.resolve({ error: { message: 'permission denied' } }).then(res) }
          return Promise.resolve({ data: rows, error: null }).then(res)
        }
      }
      return b
    }
  }
  const vraiErr = console.error
  const cris = []
  console.error = (...a) => cris.push(a.join(' '))
  try {
    const out = await saveBookingSnapshots(client, {
      userId: 'u1', propertyId: '12345', provider: 'beds24', bookings: [{ ...BOOKING_BASE, id: 1 }]
    })
    assert.strictEqual(out.rawEchecs, 1)
    assert.strictEqual(out.rawMisAJour, 0)
    assert.ok(cris.some(c => c.includes('EN ECHEC')), 'le resume de cycle le crie')
  } finally { console.error = vraiErr }
})

test('EMPREINTE : insensible a l\'ordre des TABLEAUX (API non deterministe)', () => {
  // Mesure sur Channex : deux appels consecutifs au meme endpoint rendent
  // days_breakdown dans un ordre different. Sans cette tolerance, ces lignes se
  // reecrivaient a chaque passage — backfill non idempotent, et cron qui aurait
  // fait de meme toutes les 5 minutes.
  const a = { rooms: [{ meta: { days_breakdown: [{ date: '2026-07-22' }, { date: '2026-07-23' }, { date: '2026-07-24' }] } }] }
  const b = { rooms: [{ meta: { days_breakdown: [{ date: '2026-07-24' }, { date: '2026-07-22' }, { date: '2026-07-23' }] } }] }
  assert.strictEqual(empreinte(a), empreinte(b), 'meme contenu, ordre different -> meme empreinte')
  // Un vrai changement de contenu reste detecte.
  const c = { rooms: [{ meta: { days_breakdown: [{ date: '2026-07-22' }, { date: '2026-07-23' }, { date: '2026-07-25' }] } }] }
  assert.notStrictEqual(empreinte(a), empreinte(c))
  // Et stableStringify, lui, reste strict : les deux fonctions ont des roles distincts.
  assert.notStrictEqual(stableStringify(a), stableStringify(b))
})
