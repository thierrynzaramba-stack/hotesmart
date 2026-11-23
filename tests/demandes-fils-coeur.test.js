// tests/demandes-fils-coeur.test.js
// DETTE 129, LOT 1, ETAPE 2 — LE FIL ENTRE AU COEUR.
// Spec : docs/specs/spec-demandes-airbnb.md §3.
//
// Une DEMANDE Airbnb est un fil sans reservation. Mesure du 21 novembre 2026 en
// production : chaque message d'une demande y existe en DOUBLE (copie webhook
// sans identifiant, copie import avec), parce que toutes les reconciliations
// cherchaient par `booking_id` — nul pour une demande. Ces tests PILOTENT les
// writers (client Supabase injecte) : aucun n'est une lecture de code.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'http://localhost:9/api/v1'
process.env.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY || 'k'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

// ─── Un faux Supabase qui APPLIQUE ses filtres et donne un `id` ─────────────
// ⚠ ET QUI APPLIQUE L'INDEX ANTI-DOUBLON DE LA VRAIE BASE (review 1 du lot,
// B1 ; REVIEW.md regle 22) : un double plus permissif que la base faisait
// passer pour vert un comportement que la base refuse. La cle est celle de la
// migration 2026-11-23 (`messages_sans_msgid_fil_unique_idx`) ; un test plus
// bas verifie que la migration la porte bien. `indexSansFil` rejoue l'ancien.
function cleAntiDoublon (r, avecFil) {
  const minute = Math.floor(Date.parse(r.sent_at) / 60000)
  return [r.user_id, r.booking_id || '', avecFil ? (r.provider_thread_id || '') : '', r.direction, r.sender, String(r.body || '').trim(), minute].join('|')
}
function fauxSupabase (tables, { sansColonneFil = false, indexSansFil = false } = {}) {
  let n = 0
  const journal = { updates: [], upserts: [], selects: [] }
  const vrai = (r, f) => {
    switch (f.op) {
      case 'eq': return r[f.col] != null && String(r[f.col]) === String(f.val)
      case 'is': return f.val === null ? r[f.col] == null : r[f.col] === f.val
      case 'gte': return String(r[f.col]) >= String(f.val)
      default: throw new Error('filtre inconnu ' + f.op)
    }
  }
  const nommeLeFil = (cols) => sansColonneFil && /provider_thread_id/.test(cols || '')
  const erreurFil = { code: 'PGRST204', message: "Could not find the 'provider_thread_id' column of 'messages' in the schema cache" }
  return {
    journal,
    from (table) {
      const q = { filtres: [], mode: 'select', charge: null, ordre: null, limite: null, colonnes: '' }
      const b = {
        select (c) { q.colonnes = c || ''; return b },
        eq (col, val) { q.filtres.push({ op: 'eq', col, val }); return b },
        is (col, val) { q.filtres.push({ op: 'is', col, val }); return b },
        gte (col, val) { q.filtres.push({ op: 'gte', col, val }); return b },
        order (col, o) { q.ordre = { col, asc: !o || o.ascending !== false }; return b },
        limit (k) { q.limite = k; return b },
        maybeSingle () { q.single = true; return b },
        insert (row) { q.mode = 'insert'; q.charge = row; return b },
        update (row) { q.mode = 'update'; q.charge = row; return b },
        upsert (row, opts) { q.mode = 'upsert'; q.charge = row; q.opts = opts; return b },
        then (res, rej) {
          try {
            const lignes = tables[table] = tables[table] || []
            if (sansColonneFil && table === 'messages') {
              const touche = q.filtres.some(f => f.col === 'provider_thread_id') || nommeLeFil(q.colonnes) ||
                (q.charge && 'provider_thread_id' in q.charge)
              if (touche) return res({ data: null, error: erreurFil })
            }
            if (q.mode === 'insert') {
              if (table === 'messages' && q.charge.provider_msg_id == null) {
                const k = cleAntiDoublon(q.charge, !indexSansFil)
                if (lignes.some(l => l.provider_msg_id == null && cleAntiDoublon(l, !indexSansFil) === k)) {
                  return res({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } })
                }
              }
              lignes.push({ id: 'id-' + (++n), created_at: new Date(Date.now() + n).toISOString(), ...q.charge })
              return res({ data: null, error: null })
            }
            if (q.mode === 'upsert') {
              journal.upserts.push({ table, ligne: q.charge, opts: q.opts })
              const cles = String(q.opts && q.opts.onConflict || '').split(',')
              const ex = lignes.find(l => cles.every(k => String(l[k]) === String(q.charge[k])))
              if (ex) Object.assign(ex, q.charge)
              else lignes.push({ id: 'id-' + (++n), ...q.charge })
              return res({ data: null, error: null })
            }
            if (q.mode === 'select') journal.selects.push({ table, filtres: q.filtres.map(f => f.col) })
            const vises = lignes.filter(r => q.filtres.every(f => vrai(r, f)))
            if (q.mode === 'update') {
              journal.updates.push({ table, charge: q.charge, n: vises.length, filtres: q.filtres.map(f => f.col) })
              vises.forEach(r => Object.assign(r, q.charge))
              return res({ data: null, error: null })
            }
            let rows = vises.slice()
            if (q.ordre) rows.sort((a, c) => (a[q.ordre.col] < c[q.ordre.col] ? -1 : 1) * (q.ordre.asc ? 1 : -1))
            if (q.limite != null) rows = rows.slice(0, q.limite)
            if (q.single) return res({ data: rows[0] || null, error: null })
            return res({ data: rows, error: null })
          } catch (e) { return rej(e) }
        },
      }
      return b
    },
  }
}

function writer () {
  delete require.cache[require.resolve('../lib/record-message')]
  return require('../lib/record-message').recordMessage
}

const QUAND = '2026-11-20T15:47:20.000Z'
const base = (db, p) => ({
  userId: 'C1', provider: 'channex', propertyId: 'P1', supabase: db,
  notifierMessage: async () => {}, ...p,
})

// ─── recordMessage ──────────────────────────────────────────────────────────

test('le fil du message est enregistré ; sans fil, la ligne s\'écrit comme avant (aucune clé ajoutée)', async () => {
  const t = { messages: [] }; const db = fauxSupabase(t); const rec = writer()
  await rec(base(db, { direction: 'inbound', sender: 'guest', body: 'a', providerMsgId: 'm1', threadId: 'T1', sentAt: QUAND }))
  await rec(base(db, { direction: 'inbound', sender: 'guest', body: 'b', providerMsgId: 'm2', sentAt: QUAND }))
  assert.strictEqual(t.messages[0].provider_thread_id, 'T1')
  assert.ok(!('provider_thread_id' in t.messages[1]))
})

test('LE CAS MESURÉ EN PROD : une demande (sans réservation) n\'est plus enregistrée deux fois — la copie webhook est réconciliée par le fil', async () => {
  const t = { messages: [] }; const db = fauxSupabase(t); const rec = writer()
  // Le webhook : pas d'identifiant de message, pas de reservation, le fil.
  await rec(base(db, { direction: 'inbound', sender: 'guest', body: 'Bonjour, dispo en mars ?', threadId: 'T1', sentAt: QUAND }))
  // L'import : le meme message, avec son identifiant.
  const r = await rec(base(db, { direction: 'inbound', sender: 'guest', body: 'Bonjour, dispo en mars ?', providerMsgId: 'm1', threadId: 'T1', sentAt: '2026-11-20T15:47:20' }))
  assert.strictEqual(r.reason, 'echo_entrant_reconcilie')
  assert.strictEqual(t.messages.length, 1)
  assert.deepStrictEqual([t.messages[0].provider_msg_id, t.messages[0].provider_thread_id, t.messages[0].booking_id], ['m1', 'T1', null])
})

test('deux prospects du même bien qui disent la même chose dans la même minute restent DEUX messages (dédup sans réservation par le fil, et index de la base)', async () => {
  // Contre-epreuve de la base : avec l'ANCIEN index (sans le fil), le second
  // prospect est refuse — c'est le defaut B1 de la review, que la migration ferme.
  {
    const t = { messages: [] }; const db = fauxSupabase(t, { indexSansFil: true }); const rec = writer()
    await rec(base(db, { direction: 'inbound', sender: 'guest', body: 'Bonjour', threadId: 'T1', sentAt: QUAND }))
    const r = await rec(base(db, { direction: 'inbound', sender: 'guest', body: 'Bonjour', threadId: 'T2', sentAt: '2026-11-20T15:47:50.000Z' }))
    assert.strictEqual(r.reason, 'race_23505_outbound', 'l\'ancien index confond les deux prospects')
  }
  const t = { messages: [] }; const db = fauxSupabase(t); const rec = writer()
  await rec(base(db, { direction: 'inbound', sender: 'guest', body: 'Bonjour', threadId: 'T1', sentAt: QUAND }))
  const r = await rec(base(db, { direction: 'inbound', sender: 'guest', body: 'Bonjour', threadId: 'T2', sentAt: '2026-11-20T15:47:50.000Z' }))
  assert.deepStrictEqual(r, { ok: true, skipped: false })
  assert.deepStrictEqual(t.messages.map(m => m.provider_thread_id), ['T1', 'T2'])
  // Et dans le MEME fil, la dedup d'avant tient toujours.
  const d = await rec(base(db, { direction: 'inbound', sender: 'guest', body: 'Bonjour', threadId: 'T1', sentAt: QUAND }))
  assert.strictEqual(d.reason, 'duplicate_outbound')
})

// Non-regression : vert contre le code d'avant (qui ne cherchait pas par le
// fil). Rougit contre la version fautive qui omet `.eq('user_id', …)` dans la
// recherche par le fil — mutation mesuree.
test('le fil ne traverse pas les comptes : même fil, même texte, même instant, AUTRE compte — pas de réconciliation', async () => {
  const t = { messages: [] }; const db = fauxSupabase(t); const rec = writer()
  await rec(base(db, { direction: 'inbound', sender: 'guest', body: 'Bonjour', threadId: 'T1', sentAt: QUAND }))
  const r = await rec(base(db, { userId: 'C2', direction: 'inbound', sender: 'guest', body: 'Bonjour', providerMsgId: 'm1', threadId: 'T1', sentAt: QUAND }))
  assert.deepStrictEqual(r, { ok: true, skipped: false })
  assert.strictEqual(t.messages.length, 2)
  assert.strictEqual(t.messages[0].provider_msg_id, null, 'la ligne du compte C1 garde son absence d\'identifiant')
})

test('une demande DEVENUE réservation : la copie webhook (sans réservation) se retrouve par le fil, et rejoint la réservation', async () => {
  const t = { messages: [] }; const db = fauxSupabase(t); const rec = writer()
  await rec(base(db, { direction: 'inbound', sender: 'guest', body: 'Je réserve !', threadId: 'T1', sentAt: QUAND }))
  const r = await rec(base(db, { direction: 'inbound', sender: 'guest', body: 'Je réserve !', providerMsgId: 'm1', threadId: 'T1', bookingId: 'B1', sentAt: QUAND }))
  assert.strictEqual(r.reason, 'echo_entrant_reconcilie')
  assert.deepStrictEqual([t.messages.length, t.messages[0].booking_id, t.messages[0].provider_msg_id], [1, 'B1', 'm1'])
})

test('une ligne d\'AVANT ce lot (réservation, pas de fil) est toujours retrouvée par la réservation — l\'import qui suit le déploiement ne duplique rien', async () => {
  // Ligne d'avant le lot, telle que la base la rend APRES la migration : la
  // colonne existe, et vaut null.
  const t = { messages: [{ id: 'old', user_id: 'C1', provider: 'channex', property_id: 'P1', booking_id: 'B1', provider_thread_id: null, ota: null, direction: 'inbound', sender: 'guest', body: 'Merci', sent_at: QUAND, provider_msg_id: null, created_at: '2026-11-20T15:47:21Z' }] }
  const db = fauxSupabase(t); const rec = writer()
  const r = await rec(base(db, { direction: 'inbound', sender: 'guest', body: 'Merci', providerMsgId: 'm9', threadId: 'T1', bookingId: 'B1', sentAt: QUAND }))
  assert.strictEqual(r.reason, 'echo_entrant_reconcilie')
  assert.deepStrictEqual([t.messages.length, t.messages[0].provider_msg_id, t.messages[0].provider_thread_id], [1, 'm9', 'T1'])
})

test('relu par l\'import, un message déjà connu reçoit le fil (lignes d\'avant) ou la réservation obtenue depuis — et rien d\'autre', async () => {
  const t = { messages: [
    { id: 'a', user_id: 'C1', provider: 'channex', provider_msg_id: 'm1', booking_id: null, provider_thread_id: null, body: 'x' },
    { id: 'b', user_id: 'C1', provider: 'channex', provider_msg_id: 'm2', booking_id: null, provider_thread_id: 'T1', body: 'y' },
  ] }
  const db = fauxSupabase(t); const rec = writer()
  const r1 = await rec(base(db, { direction: 'inbound', sender: 'guest', body: 'x', providerMsgId: 'm1', threadId: 'T1', sentAt: QUAND }))
  const r2 = await rec(base(db, { direction: 'inbound', sender: 'guest', body: 'y', providerMsgId: 'm2', threadId: 'T1', bookingId: 'B1', sentAt: QUAND }))
  assert.deepStrictEqual([r1.reason, r2.reason], ['duplicate_inbound', 'duplicate_inbound'])
  assert.deepStrictEqual([t.messages[0].provider_thread_id, t.messages[0].booking_id], ['T1', null])
  assert.deepStrictEqual([t.messages[1].provider_thread_id, t.messages[1].booking_id], ['T1', 'B1'])
  // ⚠ Second verrou de S2 (review 2 du lot, D2) : TOUTE mise a jour filtre
  // aussi sur le compte, quelle que soit la facon dont la ligne a ete trouvee.
  assert.ok(db.journal.updates.length > 0)
  for (const u of db.journal.updates) assert.ok(u.filtres.includes('user_id'), JSON.stringify(u))
})

test('D1 (review 2) : une copie du séjour au même texte mais à un autre instant ne fait pas sauter la recherche par le fil', async () => {
  const t = { messages: [
    // Phase demande : la copie webhook du message m1, sans reservation.
    { id: 'w1', user_id: 'C1', provider: 'channex', property_id: 'P1', booking_id: null, provider_thread_id: 'T1', ota: null, direction: 'inbound', sender: 'guest', body: 'Merci', sent_at: '2026-11-20T10:00:00.000Z', provider_msg_id: null, created_at: '2026-11-20T10:00:01Z' },
    // Apres la reservation : un autre « Merci », copie webhook pas encore reconciliee.
    { id: 'w2', user_id: 'C1', provider: 'channex', property_id: 'P1', booking_id: 'B1', provider_thread_id: 'T1', ota: null, direction: 'inbound', sender: 'guest', body: 'Merci', sent_at: '2026-11-21T10:00:00.000Z', provider_msg_id: null, created_at: '2026-11-21T10:00:01Z' },
  ] }
  const db = fauxSupabase(t); const rec = writer()
  // L'import relit m1, le message du 20/11, qui porte maintenant la reservation.
  const r = await rec(base(db, { direction: 'inbound', sender: 'guest', body: 'Merci', providerMsgId: 'm1', threadId: 'T1', bookingId: 'B1', sentAt: '2026-11-20T10:00:00' }))
  assert.strictEqual(r.reason, 'echo_entrant_reconcilie')
  assert.strictEqual(t.messages.length, 2, 'pas de troisième ligne')
  const w1 = t.messages.find(m => m.id === 'w1')
  assert.deepStrictEqual([w1.provider_msg_id, w1.booking_id], ['m1', 'B1'])
  assert.strictEqual(t.messages.find(m => m.id === 'w2').provider_msg_id, null)
  for (const u of db.journal.updates) assert.ok(u.filtres.includes('user_id'), JSON.stringify(u))
})

// Sobriete : vert contre le code d'avant (qui n'ecrivait jamais). Rougit contre
// une version qui complete a chaque relecture sans regarder ce qui manque.
test('COÛT : un message relu qui a déjà son fil et sa réservation ne déclenche AUCUNE écriture', async () => {
  const t = { messages: [{ id: 'a', user_id: 'C1', provider: 'channex', provider_msg_id: 'm1', booking_id: 'B1', provider_thread_id: 'T1', body: 'x' }] }
  const db = fauxSupabase(t); const rec = writer()
  for (let i = 0; i < 3; i++) {
    await rec(base(db, { direction: 'inbound', sender: 'guest', body: 'x', providerMsgId: 'm1', threadId: 'T1', bookingId: 'B1', sentAt: QUAND }))
  }
  assert.strictEqual(db.journal.updates.length, 0)
})

test('une réservation connue ne s\'efface jamais, même si une relecture arrive sans réservation', async () => {
  const t = { messages: [{ id: 'a', user_id: 'C1', provider: 'channex', provider_msg_id: 'm1', booking_id: 'B1', provider_thread_id: null, body: 'x' }] }
  const db = fauxSupabase(t); const rec = writer()
  await rec(base(db, { direction: 'inbound', sender: 'guest', body: 'x', providerMsgId: 'm1', threadId: 'T1', sentAt: QUAND }))
  assert.deepStrictEqual([t.messages[0].booking_id, t.messages[0].provider_thread_id], ['B1', 'T1'])
})

test('notre réponse à une demande (sans réservation) reconnaît son écho par le fil', async () => {
  const t = { messages: [] }; const db = fauxSupabase(t); const rec = writer()
  await rec(base(db, { direction: 'outbound', sender: 'host', body: 'Oui, c\'est libre', threadId: 'T1' }))
  const r = await rec(base(db, { direction: 'outbound', sender: 'host', body: 'Oui, c\'est libre', providerMsgId: 'm5', threadId: 'T1', sentAt: QUAND }))
  assert.strictEqual(r.reason, 'echo_reconcilie')
  assert.deepStrictEqual([t.messages.length, t.messages[0].provider_msg_id], [1, 'm5'])
})

// Non-regression de la fenetre « code deploye, migration pas collee » : vert
// contre le code d'avant (qui ignorait la colonne). Rougit sans le repli
// d'insertion ou sans la relecture sans colonne — mutations mesurees.
test('migration pas encore collée : la colonne absente ne perd AUCUN message et ne fabrique aucun doublon', async () => {
  const t = { messages: [] }; const db = fauxSupabase(t, { sansColonneFil: true }); const rec = writer()
  const r1 = await rec(base(db, { direction: 'inbound', sender: 'guest', body: 'Bonjour', providerMsgId: 'm1', threadId: 'T1', bookingId: 'B1', sentAt: QUAND }))
  assert.deepStrictEqual(r1, { ok: true, skipped: false })
  assert.ok(!('provider_thread_id' in t.messages[0]))
  // Relu : reconnu comme doublon (la lecture se refait sans la colonne), pas comme une course.
  const r2 = await rec(base(db, { direction: 'inbound', sender: 'guest', body: 'Bonjour', providerMsgId: 'm1', threadId: 'T1', bookingId: 'B1', sentAt: QUAND }))
  assert.strictEqual(r2.reason, 'duplicate_inbound')
  // L'echo d'une copie webhook a reservation se reconcilie encore, par la reservation.
  await rec(base(db, { direction: 'inbound', sender: 'guest', body: 'Merci', threadId: 'T1', bookingId: 'B1', sentAt: QUAND }))
  const r3 = await rec(base(db, { direction: 'inbound', sender: 'guest', body: 'Merci', providerMsgId: 'm2', threadId: 'T1', bookingId: 'B1', sentAt: QUAND }))
  assert.strictEqual(r3.reason, 'echo_entrant_reconcilie')
  assert.strictEqual(t.messages.length, 2)
})

test('S2 : la ligne d\'un AUTRE compte, retrouvée par l\'identifiant provider, n\'est jamais complétée', async () => {
  const t = { messages: [{ id: 'a', user_id: 'C2', provider: 'channex', provider_msg_id: 'm1', booking_id: null, provider_thread_id: null, ota: null, body: 'x' }] }
  const db = fauxSupabase(t); const rec = writer()
  const r = await rec(base(db, { direction: 'inbound', sender: 'guest', body: 'x', providerMsgId: 'm1', threadId: 'T1', bookingId: 'B1', ota: 'airbnb', sentAt: QUAND }))
  assert.strictEqual(r.reason, 'duplicate_inbound')
  assert.deepStrictEqual([t.messages[0].provider_thread_id, t.messages[0].booking_id, t.messages[0].ota], [null, null, null])
  assert.strictEqual(db.journal.updates.length, 0)
})

test('un fil déjà connu n\'est jamais écrasé par un autre fil ; l\'OTA manquante d\'une copie webhook est complétée', async () => {
  const t = { messages: [{ id: 'w', user_id: 'C1', provider: 'channex', property_id: 'P1', booking_id: 'B1', provider_thread_id: 'T-ANCIEN', ota: null, direction: 'inbound', sender: 'guest', body: 'Merci', sent_at: QUAND, provider_msg_id: null, created_at: '2026-11-20T15:47:21Z' }] }
  const db = fauxSupabase(t); const rec = writer()
  const r = await rec(base(db, { direction: 'inbound', sender: 'guest', body: 'Merci', providerMsgId: 'm1', threadId: 'T-NOUVEAU', bookingId: 'B1', ota: 'airbnb', sentAt: QUAND }))
  assert.strictEqual(r.reason, 'echo_entrant_reconcilie')
  assert.deepStrictEqual([t.messages[0].provider_thread_id, t.messages[0].ota, t.messages[0].provider_msg_id], ['T-ANCIEN', 'airbnb', 'm1'])
})

test('COÛT : pour un séjour ordinaire, la recherche par le fil ne part pas quand la réservation a trouvé la copie', async () => {
  const t = { messages: [] }; const db = fauxSupabase(t); const rec = writer()
  await rec(base(db, { direction: 'inbound', sender: 'guest', body: 'Merci', threadId: 'T1', bookingId: 'B1', sentAt: QUAND }))
  db.journal.selects.length = 0
  const r = await rec(base(db, { direction: 'inbound', sender: 'guest', body: 'Merci', providerMsgId: 'm1', threadId: 'T1', bookingId: 'B1', sentAt: QUAND }))
  assert.strictEqual(r.reason, 'echo_entrant_reconcilie')
  assert.ok(!db.journal.selects.some(q => q.filtres.includes('provider_thread_id')), JSON.stringify(db.journal.selects))
})

test('la migration porte l\'index anti-doublon AVEC le fil, posé avant le retrait de l\'ancien, et l\'unicité des fils par compte', () => {
  const sql = require('fs').readFileSync(path.join(__dirname, '..', 'migrations/2026-11-23-demandes-fils.sql'), 'utf8')
  const pose = sql.indexOf('messages_sans_msgid_fil_unique_idx')
  const retrait = sql.indexOf('drop index if exists')
  assert.ok(pose > 0 && retrait > pose, 'le nouvel index est posé AVANT le retrait de l\'ancien')
  const def = sql.slice(pose, retrait)
  for (const morceau of ["coalesce(booking_id, '')", "coalesce(provider_thread_id, '')", 'direction', 'sender', 'md5(btrim(body))', "date_trunc('minute'", 'where provider_msg_id is null']) {
    assert.ok(def.includes(morceau), morceau)
  }
  assert.match(sql.slice(retrait), /messages_sans_msgid_unique_idx/)
  assert.match(sql, /unique \(user_id, provider,\s+provider_thread_id\)/)
})

// ─── enregistrerFil ─────────────────────────────────────────────────────────

function fils () {
  delete require.cache[require.resolve('../lib/demandes/fils')]
  return require('../lib/demandes/fils')
}

test('enregistrerFil : une ligne par (provider, fil), mise à jour en place ; la réservation se pose et ne s\'efface jamais', async () => {
  const t = { fils_provider: [] }; const db = fauxSupabase(t); const { enregistrerFil } = fils()
  const r = await enregistrerFil({ userId: 'C1', provider: 'channex', propertyId: 'P1', supabase: db,
    fil: { id: 'T1', titre: 'Marie', booking: null, ota: 'airbnb', ferme: false, derniere: QUAND } })
  assert.deepStrictEqual(r, { ok: true })
  assert.strictEqual(db.journal.upserts[0].opts.onConflict, 'user_id,provider,provider_thread_id')
  assert.ok(!('booking_id' in db.journal.upserts[0].ligne), 'une demande n\'écrit pas booking_id : elle ne peut pas effacer')
  await enregistrerFil({ userId: 'C1', provider: 'channex', propertyId: 'P1', supabase: db, fil: { id: 'T1', titre: 'Marie', booking: 'B1' } })
  await enregistrerFil({ userId: 'C1', provider: 'channex', propertyId: 'P1', supabase: db, fil: { id: 'T1', titre: 'Marie D.', booking: null, ferme: true } })
  assert.strictEqual(t.fils_provider.length, 1)
  assert.deepStrictEqual([t.fils_provider[0].booking_id, t.fils_provider[0].titre, t.fils_provider[0].ferme], ['B1', 'Marie D.', true])
})

test('S1 : deux comptes qui portent le même fil gardent chacun LEUR ligne — le propriétaire ne bascule jamais', async () => {
  const t = { fils_provider: [] }; const db = fauxSupabase(t); const { enregistrerFil } = fils()
  for (let i = 0; i < 2; i++) {
    await enregistrerFil({ userId: 'A', provider: 'channex', propertyId: 'P1', supabase: db, fil: { id: 'T1', titre: 'Voyageur de A' } })
    await enregistrerFil({ userId: 'B', provider: 'channex', propertyId: 'P1', supabase: db, fil: { id: 'T1', titre: 'Voyageur de B' } })
  }
  assert.deepStrictEqual(t.fils_provider.map(f => [f.user_id, f.titre]).sort(), [['A', 'Voyageur de A'], ['B', 'Voyageur de B']])
})

test('enregistrerFil : un titre absent ne vide pas le nom connu', async () => {
  const t = { fils_provider: [] }; const db = fauxSupabase(t); const { enregistrerFil } = fils()
  await enregistrerFil({ userId: 'C1', provider: 'channex', propertyId: 'P1', supabase: db, fil: { id: 'T1', titre: 'Marie' } })
  await enregistrerFil({ userId: 'C1', provider: 'channex', propertyId: 'P1', supabase: db, fil: { id: 'T1', titre: null } })
  await enregistrerFil({ userId: 'C1', provider: 'channex', propertyId: 'P1', supabase: db, fil: { id: 'T1', titre: '  ' } })
  assert.strictEqual(t.fils_provider[0].titre, 'Marie')
  assert.ok(!('titre' in db.journal.upserts[1].ligne))
})

test('enregistrerFil : titre borné, paramètres manquants refusés, jamais d\'exception', async () => {
  const t = { fils_provider: [] }; const db = fauxSupabase(t); const { enregistrerFil } = fils()
  await enregistrerFil({ userId: 'C1', provider: 'channex', propertyId: 'P1', supabase: db, fil: { id: 'T1', titre: 'x'.repeat(500) } })
  assert.strictEqual(t.fils_provider[0].titre.length, 200)
  assert.deepStrictEqual(await enregistrerFil({ userId: 'C1', provider: 'channex', propertyId: 'P1', supabase: db, fil: {} }), { ok: false, error: 'missing_params' })
  const panne = { from () { throw new Error('boum') } }
  const r = await enregistrerFil({ userId: 'C1', provider: 'channex', propertyId: 'P1', supabase: panne, fil: { id: 'T1' } })
  assert.deepStrictEqual(r, { ok: false, error: 'boum' })
})

// ─── importMessages : le fil passe au writer, et le fil entre au coeur ──────

test('importMessages : chaque message porte son fil, et chaque fil DE CE BIEN est enregistré — jamais celui d\'un autre bien ou sans bien', async () => {
  const cheminRecord = require.resolve('../lib/record-message')
  const cheminFils = require.resolve('../lib/demandes/fils')
  const avantRecord = require.cache[cheminRecord]
  const avantFils = require.cache[cheminFils]
  const recus = []
  const filsEcrits = []
  require.cache[cheminRecord] = { id: cheminRecord, filename: cheminRecord, loaded: true,
    exports: { recordMessage: async (p) => { recus.push(p); return { ok: true } } } }
  require.cache[cheminFils] = { id: cheminFils, filename: cheminFils, loaded: true,
    exports: { enregistrerFil: async (p) => { filsEcrits.push(p); return { ok: true } } } }
  delete require.cache[require.resolve('../lib/channels/channex')]
  const { importMessages } = require('../lib/channels/channex')
  const avantFetch = global.fetch
  const th = (id, rel) => ({ id, attributes: { provider: 'Airbnb', title: 'Voyageur ' + id, updated_at: '2026-11-20T10:00:00', message_count: 1, is_closed: false }, relationships: rel })
  global.fetch = async (url) => {
    const u = String(url)
    const page = Number((u.match(/pagination\[page\]=(\d+)/) || [])[1] || 1)
    let data = []
    if (u.includes('/message_threads?')) {
      if (page === 1) data = [
        th('demande', { property: { data: { id: 'P1' } } }),
        th('sejour', { property: { data: { id: 'P1' } }, booking: { data: { id: 'B7' } } }),
        th('etranger', { property: { data: { id: 'AUTRE' } } }),
        th('sans-bien', {}),
      ]
    } else if (page === 1) {
      data = [{ id: 'msg-' + u.split('/message_threads/')[1].split('/')[0], attributes: { sender: 'guest', message: 'x', inserted_at: '2026-11-20T09:00:00' } }]
    }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data, meta: { limit: 100 } }) }
  }
  try {
    await importMessages({ userId: 'C1', propertyId: 'P1' })
  } finally {
    global.fetch = avantFetch
    if (avantRecord) require.cache[cheminRecord] = avantRecord; else delete require.cache[cheminRecord]
    if (avantFils) require.cache[cheminFils] = avantFils; else delete require.cache[cheminFils]
    delete require.cache[require.resolve('../lib/channels/channex')]
  }
  const parMessage = Object.fromEntries(recus.map(p => [p.providerMsgId, [p.threadId, p.bookingId]]))
  assert.deepStrictEqual(parMessage['msg-demande'], ['demande', null])
  assert.deepStrictEqual(parMessage['msg-sejour'], ['sejour', 'B7'])
  assert.deepStrictEqual(filsEcrits.map(p => [p.fil.id, p.fil.booking, p.fil.titre, p.userId, p.propertyId]).sort(),
    [['demande', null, 'Voyageur demande', 'C1', 'P1'], ['sejour', 'B7', 'Voyageur sejour', 'C1', 'P1']])
})

test('le webhook transmet le fil du message (`message_thread_id`) au writer', () => {
  // Lecture de code assumee : le gestionnaire de webhook n'a pas de banc qui
  // pilote la branche `message` jusqu'au writer. Ce test ne garde que le
  // branchement ; le comportement du writer est pilote plus haut.
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'api/channel-webhook.js'), 'utf8')
  const appel = src.slice(src.indexOf('await recordMessage({'), src.indexOf("kind:          'message'", src.indexOf('await recordMessage({')))
  assert.match(appel, /threadId:\s+payload\.message_thread_id \? String\(payload\.message_thread_id\) : null/)
})
