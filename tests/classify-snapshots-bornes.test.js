// tests/classify-snapshots-bornes.test.js
// LE DEFAUT : la classification lisait TOUT l'historique du bien pour nommer
// les voyageurs de quelques fils.
//
//   .from('bookings_snapshot').select('booking_id, snapshot')
//     .eq('property_id', String(property.id))
//
// Pas de `user_id`, pas de fenetre, pas de limite, et `error` jamais lu.
// Mesure du 22 octobre 2026 en PRODUCTION : 827 lignes pour La bulle, 651 pour
// Coeur de vie 23 — PostgREST coupe a 1000 SANS ERREUR. A 173 lignes du
// plafond, et ce qui disparait d'abord est le nom, l'arrivee et le depart
// passes au modele : le voyageur recoit une reponse batie sur une fiche vide.
//
// Les trois proprietes gardees ici, et pas la forme de la requete :
//   1. la lecture est CLOISONNEE par compte et BORNEE aux fils en main ;
//   2. une lecture en echec arrete la classification SANS lever — sinon elle
//      emporterait les codes d'acces du meme `try` (incident du 10 septembre) ;
//   3. au plafond de PostgREST, on refuse plutot que de nommer les voyageurs
//      avec une liste coupee.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'cle-test'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const PROP = '0db6b39b-b8f6-4bbf-bb20-4c73e3e769d4'
const USER = 'u-hote'
// Trois fils, dont un sans identifiant de reservation.
const FILS = [
  { bookingId: 'B1', sender: 'guest', message: 'Bonjour', time: '2026-10-21T08:00:00Z' },
  { bookingId: 'B1', sender: 'host',  message: 'Bonjour !', time: '2026-10-21T09:00:00Z' },
  { bookingId: 'B2', sender: 'guest', message: 'Le code ?', time: '2026-10-21T10:00:00Z' },
  { bookingId: null, sender: 'guest', message: 'Sans resa', time: '2026-10-21T11:00:00Z' }
]

// Double de `lib/cron-shared` + de `lib/channels`. `snapshots` decide ce que
// rend la lecture du coeur : des lignes, une erreur, ou le plafond.
function charger ({ snapshots }) {
  const vu = { snapshotQueries: [], tables: [] }

  const table = (nom) => {
    const f = { eq: {}, in: null }
    const q = {
      select () { return q },
      eq (col, val) { f.eq[col] = String(val); return q },
      in (col, vals) { if (col === 'booking_id') f.in = vals.slice(); return q },
      is () { return q }, not () { return q }, neq () { return q },
      gte () { return q }, lte () { return q }, gt () { return q },
      order () { return q },
      update () { return q },
      insert () { return Promise.resolve({ error: null }) },
      limit () { return rendre() },
      maybeSingle: async () => ({ data: null, error: null }),
      then (res, rej) { return rendre().then(res, rej) }
    }
    function rendre () {
      vu.tables.push(nom)
      if (nom === 'bookings_snapshot') {
        vu.snapshotQueries.push({ eq: { ...f.eq }, in: f.in })
        if (snapshots === 'erreur') return Promise.resolve({ data: null, error: { message: 'panne transitoire' } })
        if (snapshots === 'plafond') {
          return Promise.resolve({ data: Array.from({ length: 1000 }, (_, i) => ({ booking_id: `X${i}`, snapshot: {} })), error: null })
        }
        return Promise.resolve({ data: snapshots, error: null })
      }
      // Les gardes par fil tranchent « deja traite » : le fil s arrete avant
      // tout appel au modele. Ce fichier garde la LECTURE DU COEUR, pas la
      // classification — un appel IA ici ne serait que du bruit.
      if (nom === 'agent_tasks') return Promise.resolve({ data: [{ id: 't', created_at: '2026-10-22T00:00:00Z' }], error: null })
      return Promise.resolve({ data: [], error: null })
    }
    return q
  }

  const absShared = require.resolve(path.join(__dirname, '..', 'lib/cron-shared.js'))
  const mShared = new Module(absShared)
  mShared.exports = {
    supabase: { from: table },
    getPropertyMode: async () => 'test',
    isAutomationPaused: async () => false,
    surAppel: () => {}
  }
  mShared.loaded = true
  require.cache[absShared] = mShared

  const absCanaux = require.resolve(path.join(__dirname, '..', 'lib/channels/index.js'))
  const mCanaux = new Module(absCanaux)
  mCanaux.exports = { getProvider: () => ({ getPropertyMessages: async () => FILS }) }
  mCanaux.loaded = true
  require.cache[absCanaux] = mCanaux

  delete require.cache[require.resolve('../lib/cron-classify')]
  const mod = require('../lib/cron-classify')
  return { mod, vu }
}

const bien = { id: PROP, name: 'La bulle', provider: 'channex' }
const resultats = () => ({ errors: [], totalMessages: 0, totalTasks: 0 })

test('LE TEST QUI COMPTE : la lecture du coeur porte user_id ET la liste des fils', async () => {
  const { mod, vu } = charger({ snapshots: [{ booking_id: 'B1', snapshot: { firstName: 'Ana' } }] })
  await mod.processChannelPropertyMessages(USER, bien, resultats())

  assert.ok(vu.snapshotQueries.length >= 1, 'le coeur est bien lu')
  const q = vu.snapshotQueries[0]
  assert.equal(q.eq.user_id, USER, 'CLOISONNEE PAR COMPTE : property_id est une cle provider, elle ne suffit pas')
  assert.equal(q.eq.property_id, PROP)
  assert.ok(Array.isArray(q.in), 'BORNEE : la lecture demande des identifiants, pas tout l historique')
  assert.deepEqual(q.in.slice().sort(), ['B1', 'B2'], 'les fils en main, et le fil sans reservation ecarte')
})

test('LE TEST QUI COMPTE : une lecture du coeur en echec n emporte PAS les codes d acces', async () => {
  const { mod } = charger({ snapshots: 'erreur' })
  const res = resultats()
  // Ne LEVE pas : l appelant enveloppe cette fonction et processArrivalCodes
  // dans le MEME try. Une exception ici couterait le PIN du voyageur.
  await mod.processChannelPropertyMessages(USER, bien, res)
  assert.equal(res.totalMessages, 0, 'rien n est classifie sur une fiche qu on n a pas lue')
  assert.equal(res.errors.length, 1, 'et l echec est COMPTE, pas avale')
  assert.equal(res.errors[0].context, 'classify_snapshots')
})

test('LE TEST QUI COMPTE : au plafond de PostgREST, on refuse au lieu de nommer a l aveugle', async () => {
  const { mod } = charger({ snapshots: 'plafond' })
  const res = resultats()
  await mod.processChannelPropertyMessages(USER, bien, res)
  assert.equal(res.errors.length, 1)
  assert.equal(res.errors[0].context, 'classify_snapshots_tronques')
  assert.match(res.errors[0].error, /1000 lignes/)
})
