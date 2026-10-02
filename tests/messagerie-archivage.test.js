// tests/messagerie-archivage.test.js
// Lot 7 du chantier avis (spec §9) — l'archivage des fils de messagerie :
// lib/archivage-conversations.js (les regles), api/messages.js (le calcul a la
// lecture, et le SEUL writer de l'archivage manuel), et l'ecran.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { etatArchivage } = require('../lib/archivage-conversations')

const JOUR = 86400000
const MAINTENANT = Date.parse('2026-10-20T12:00:00Z')
const il_y_a = (j) => new Date(MAINTENANT - j * JOUR).toISOString()
const jour = (j) => il_y_a(j).slice(0, 10)

// ─── Les regles ──────────────────────────────────────────────────────────────
test('dix jours après le départ ET après le dernier message : archivée (inactivité)', () => {
  assert.deepStrictEqual(etatArchivage({ depart: jour(12), dernierMessage: il_y_a(11), maintenant: MAINTENANT }), { archivee: true, raison: 'inactivite' })
  assert.strictEqual(etatArchivage({ depart: jour(12), dernierMessage: il_y_a(3), maintenant: MAINTENANT }).archivee, false, 'un message récent relance le compteur')
  assert.strictEqual(etatArchivage({ depart: jour(5), dernierMessage: il_y_a(20), maintenant: MAINTENANT }).archivee, false, 'départ trop récent')
})

test('sans séjour (pas de départ), aucune règle automatique de durée', () => {
  assert.strictEqual(etatArchivage({ depart: null, dernierMessage: il_y_a(90), maintenant: MAINTENANT }).archivee, false)
})

test('LE TEST QUI COMPTE : épinglée, jamais archivée — même à la main, même publiée, même inactive', () => {
  assert.strictEqual(etatArchivage({ epinglee: true, depart: jour(60), dernierMessage: il_y_a(60), archiveeManuellement: true, archiveeLe: il_y_a(30), publieeLe: il_y_a(40), maintenant: MAINTENANT }).archivee, false)
})

test('évaluation publiée : archivée — sauf message postérieur', () => {
  assert.deepStrictEqual(etatArchivage({ depart: jour(2), dernierMessage: il_y_a(2), publieeLe: il_y_a(1), maintenant: MAINTENANT }), { archivee: true, raison: 'evaluation_publiee' })
  assert.strictEqual(etatArchivage({ depart: jour(2), dernierMessage: il_y_a(0.5), publieeLe: il_y_a(1), maintenant: MAINTENANT }).archivee, false, 'le voyageur a réécrit')
})

test('archivée à la main : jusqu’au prochain message', () => {
  assert.deepStrictEqual(etatArchivage({ depart: jour(1), dernierMessage: il_y_a(2), archiveeManuellement: true, archiveeLe: il_y_a(1), maintenant: MAINTENANT }), { archivee: true, raison: 'manuel' })
  assert.strictEqual(etatArchivage({ depart: jour(1), dernierMessage: il_y_a(0.1), archiveeManuellement: true, archiveeLe: il_y_a(1), maintenant: MAINTENANT }).archivee, false, 'un nouveau message la ramène')
})

test('LE TEST QUI COMPTE : désarchivée à la main, elle est protégée des règles automatiques jusqu’au prochain message', () => {
  const base = { depart: jour(30), dernierMessage: il_y_a(25), publieeLe: il_y_a(20), maintenant: MAINTENANT }
  assert.strictEqual(etatArchivage(base).archivee, true)
  assert.strictEqual(etatArchivage({ ...base, desarchiveeLe: il_y_a(1) }).archivee, false, 'protégée')
  assert.strictEqual(etatArchivage({ ...base, dernierMessage: il_y_a(0.5), desarchiveeLe: il_y_a(1) }).archivee, false, 'un message relance le compteur, récent')
})

// ─── L'endpoint ──────────────────────────────────────────────────────────────
const PROD = '11111111-1111-4111-8111-111111111111'
const MEMBRE = '22222222-2222-4222-8222-222222222222'
const MODULES = ['../api/messages', '../lib/require-permission', '../lib/permissions', '../lib/cron-shared', '../lib/cron-arrival-code']

function preparer ({ messages = [], snaps = [], flags = [], evenements = [], appelant = null, permissions = null, flagsSansArchivage = false } = {}) {
  const etat = { flags: flags.map(f => ({ ...f })), upserts: [] }
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: appelant ? MEMBRE : PROD } }, error: null }) },
    from (nom) {
      const q = { f: {}, op: 'select', colonnes: '' }
      const executer = () => {
        if (nom === 'profiles') {
          const ok = appelant && q.f.member_user_id === MEMBRE && q.f.account_user_id === PROD
          return { data: ok ? [{ id: 'p-m', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01', access_mode: 'compte' }] : [], error: null }
        }
        if (nom === 'profile_permissions') return { data: appelant && permissions ? [{ ...permissions, profile_id: 'p-m' }] : [], error: null }
        if (nom === 'messages') return { data: messages.filter(m => (q.f.booking_id == null || m.booking_id === q.f.booking_id)), error: null }
        if (nom === 'bookings_snapshot') return { data: snaps.filter(s => q.f.booking_id == null || s.booking_id === q.f.booking_id), error: null }
        if (nom === 'core_events') return { data: evenements, error: null }
        if (nom === 'conversation_flags') {
          if (q.op === 'upsert') {
            etat.upserts.push(q.row)
            const i = etat.flags.findIndex(f => f.book_id === q.row.book_id)
            if (i >= 0) etat.flags[i] = { ...etat.flags[i], ...q.row }; else etat.flags.push({ ...q.row })
            return { data: null, error: null }
          }
          if (flagsSansArchivage && /archived_manual/.test(q.colonnes)) return { data: null, error: { message: 'column "archived_manual" does not exist' } }
          return { data: etat.flags.filter(f => q.f.book_id == null || f.book_id === q.f.book_id), error: null }
        }
        return { data: [], error: null }
      }
      const c = {
        select (col) { q.colonnes = col || ''; return c }, eq (k, v) { q.f[k] = v; return c },
        gte () { return c }, neq () { return c }, in () { return c }, or () { return c },
        order () { return c }, limit () { return c },
        upsert (row) { q.op = 'upsert'; q.row = row; return c },
        maybeSingle: async () => { const r = executer(); return { data: (r.data || [])[0] || null, error: r.error } },
        single: async () => { const r = executer(); return { data: (r.data || [])[0] || null, error: r.error } },
        then (ok, ko) { return Promise.resolve(executer()).then(ok, ko) },
      }
      return c
    },
  }
  const absShared = require.resolve(path.join(__dirname, '..', 'lib/cron-shared'))
  const mShared = new Module(absShared); mShared.exports = { supabase: client, anthropic: null }; mShared.loaded = true
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
  require.cache[absShared] = mShared
  return etat
}
function reponse () { const r = { code: null, body: null }; r.status = c => { r.code = c; return r }; r.json = b => { r.body = b; return r }; r.setHeader = () => {}; return r }
const lire = (entetes = {}) => ({ method: 'GET', query: {}, body: null, headers: { authorization: 'Bearer j', ...entetes } })
const poster = (corps, entetes = {}) => ({ method: 'POST', query: {}, body: corps, headers: { authorization: 'Bearer j', ...entetes } })
async function appeler (r) { const res = reponse(); await require('../api/messages')(r, res); return res }

const ANCIEN = new Date(Date.now() - 20 * JOUR).toISOString()
const RECENT = new Date(Date.now() - 1 * JOUR).toISOString()
const JOUR_REL = (j) => new Date(Date.now() - j * JOUR).toISOString().slice(0, 10)
const MSG = (booking_id, sent_at, property_id = 'ref-a') => ({ booking_id, property_id, provider: 'channex', sender: 'guest', direction: 'inbound', body: 'Bonjour', sent_at, kind: 'message' })

test('la lecture calcule l’état de chaque fil, et dit que l’archivage est disponible', async () => {
  preparer({
    messages: [MSG('BK-VIEUX', ANCIEN), MSG('BK-NEUF', RECENT), MSG('BK-PUBLIE', ANCIEN), MSG('BK-EPINGLE', ANCIEN)],
    snaps: [
      { booking_id: 'BK-VIEUX', snapshot: { departure: JOUR_REL(25) } },
      { booking_id: 'BK-NEUF', snapshot: { departure: JOUR_REL(25) } },
      { booking_id: 'BK-PUBLIE', snapshot: { departure: JOUR_REL(21) } },
      { booking_id: 'BK-EPINGLE', snapshot: { departure: JOUR_REL(30) } },
    ],
    flags: [{ book_id: 'BK-EPINGLE', pinned: true }],
    evenements: [{ payload: { booking_uid: 'BK-PUBLIE' }, created_at: new Date(Date.now() - 2 * JOUR).toISOString() }],
  })
  const res = await appeler(lire())
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.archivage, true)
  const par = Object.fromEntries(res.body.conversations.map(c => [c.bookId, c]))
  assert.deepStrictEqual([par['BK-VIEUX'].archivee, par['BK-VIEUX'].raisonArchivage], [true, 'inactivite'])
  assert.strictEqual(par['BK-NEUF'].archivee, false)
  assert.deepStrictEqual([par['BK-PUBLIE'].archivee, par['BK-PUBLIE'].raisonArchivage], [true, 'evaluation_publiee'])
  assert.strictEqual(par['BK-EPINGLE'].archivee, false)
})

test('migration absente : tous les fils restent en boîte, et l’écran le sait', async () => {
  preparer({ messages: [MSG('BK-VIEUX', ANCIEN)], snaps: [{ booking_id: 'BK-VIEUX', snapshot: { departure: JOUR_REL(25) } }], flagsSansArchivage: true })
  const res = await appeler(lire())
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.archivage, false)
  assert.strictEqual(res.body.conversations[0].archivee, undefined)
})

test('archiver : l’endpoint écrit l’état, et RECOPIE l’épingle sans jamais en créer une', async () => {
  const etat = preparer({ messages: [MSG('BK-1', RECENT)] })
  const res = await appeler(poster({ action: 'archiver', booking_id: 'BK-1' }))
  assert.strictEqual(res.code, 200)
  const u = etat.upserts[0]
  assert.strictEqual(u.pinned, false, 'une ligne neuve n’est pas épinglée par défaut')
  assert.strictEqual(u.archived_manual, true)
  assert.strictEqual(u.archived_reason, 'manuel')
  assert.ok(u.archive_after)
  assert.strictEqual(u.unarchived_manual_at, null)
  assert.strictEqual(u.property_id_ref, 'ref-a')
})

test('désarchiver : protège des règles automatiques, garde l’épingle', async () => {
  const etat = preparer({ messages: [MSG('BK-1', RECENT)], flags: [{ book_id: 'BK-1', pinned: false, archived_manual: true }] })
  const res = await appeler(poster({ action: 'desarchiver', booking_id: 'BK-1' }))
  assert.strictEqual(res.code, 200)
  const u = etat.upserts[0]
  assert.strictEqual(u.archived_manual, false)
  assert.ok(u.unarchived_manual_at)
  assert.strictEqual(u.archive_after, null)
})

test('LE TEST QUI COMPTE : une conversation épinglée ne s’archive pas (409), rien n’est écrit', async () => {
  const etat = preparer({ messages: [MSG('BK-1', RECENT)], flags: [{ book_id: 'BK-1', pinned: true }] })
  const res = await appeler(poster({ action: 'archiver', booking_id: 'BK-1' }))
  assert.strictEqual(res.code, 409)
  assert.strictEqual(etat.upserts.length, 0)
})

test('LE TEST QUI COMPTE : un membre limité au bien A n’archive pas un fil du bien B', async () => {
  const etat = preparer({ messages: [MSG('BK-B', RECENT, 'ref-b')], appelant: true, permissions: { messages: 'write', property_scope: 'selected', property_refs: ['ref-a'], property_ids: [] } })
  const res = await appeler(poster({ action: 'archiver', booking_id: 'BK-B' }, { 'x-compte': PROD }))
  // 404 et non 403 : on n'apprend pas a un membre qu'un fil existe ailleurs.
  assert.strictEqual(res.code, 404)
  assert.strictEqual(etat.upserts.length, 0)
})

test('un membre en lecture seule n’archive rien', async () => {
  const etat = preparer({ messages: [MSG('BK-1', RECENT)], appelant: true, permissions: { messages: 'read', property_scope: 'all' } })
  const res = await appeler(poster({ action: 'archiver', booking_id: 'BK-1' }, { 'x-compte': PROD }))
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.upserts.length, 0)
})

test('la ligne du simulateur, un fil inconnu ou un identifiant vide sont refusés', async () => {
  const etat = preparer({ messages: [] })
  const a = await appeler(poster({ action: 'archiver', booking_id: '__SIM_ENABLED__' }))
  const b = await appeler(poster({ action: 'archiver', booking_id: 'INCONNU' }))
  const c = await appeler(poster({ action: 'archiver', booking_id: '' }))
  assert.deepStrictEqual([a.code, b.code, c.code], [400, 404, 400])
  assert.strictEqual(etat.upserts.length, 0)
})

// ─── L'écran ─────────────────────────────────────────────────────────────────
test('la messagerie : onglets, recherche, bouton, et l’épingle ne supprime plus la ligne', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'apps', 'agent-ai', 'messagerie.html'), 'utf8')
  assert.match(page, /<div class="conv-vues" id="conv-vues" hidden>/)
  assert.match(page, /id="conv-recherche"/)
  assert.match(page, /const visibles = filtrerConversations\(conversations\)/)
  assert.match(page, /archivageDispo = msgRes\.archivage === true/)
  assert.match(page, /action: archiver \? 'archiver' : 'desarchiver'/)
  // ⚠ Désépingler supprimait la ligne — et avec elle l'état d'archivage.
  assert.doesNotMatch(page, /from\('conversation_flags'\)\.delete\(\)/)
  assert.match(page, /from\('conversation_flags'\)\.update\(\{ pinned: false \}\)/)
})

test('la lecture des épingles est BORNÉE aux fils lus (pas de troncature à 1000 lignes)', () => {
  const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'messages.js'), 'utf8')
  assert.match(api, /\.in\('book_id', ids\.slice\(i, i \+ 100\)\)/)
})
