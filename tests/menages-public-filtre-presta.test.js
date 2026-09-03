// tests/menages-public-filtre-presta.test.js
// api/menages-public.js — le planning PWA filtre par PRESTATAIRE (spec §11.5).
//
// ⚠ CE QUE CE FILTRE FERME. Tant que la PWA filtrait par
// `public_tokens.property_ids`, deux prestataires sur un même bien voyaient
// chacune TOUS les ménages de l'autre — les noms des voyageurs, les dates, les
// occupants. C'est le cas qui motive tout ce chantier : une seconde femme de
// ménage arrive en renfort sur les mêmes biens.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const U = 'compte-1', TOKEN = 'regina-x', REGINA = 'p-regina', NOUVELLE = 'p-nouvelle'

const BIENS = [{ provider_property_id: '209413', name: 'La bulle', provider: 'beds24' }]

// Deux séjours sur le MÊME bien, l'un à Régina, l'autre à la nouvelle.
const SNAPS = [
  { booking_id: 'b1', property_id: '209413',
    snapshot: { status: 'confirmed', arrival: '2026-09-01', departure: '2026-09-05',
                firstName: 'Alice', lastName: 'Martin', provider: 'beds24' } },
  { booking_id: 'b2', property_id: '209413',
    snapshot: { status: 'confirmed', arrival: '2026-09-06', departure: '2026-09-09',
                firstName: 'Bruno', lastName: 'Durand', provider: 'beds24' } }
]

function preparer ({ profil = { id: REGINA, first_name: 'Régina', active: true },
                     menages = null, erreurProfil = null, erreurMenages = null,
                     tokenPropIds = ['209413'], done = [], events = [] } = {}) {
  const journal = []
  const client = {
    from (table) {
      const a = { table, f: {}, journal }
      journal.push(a)
      const chain = {
        select (c) { a.colonnes = c; return chain },
        eq (c, v) { a.f[c] = v; return chain },
        neq (c, v) { a.neq = { c, v }; return chain },
        is (c, v) { (a.is = a.is || []).push({ c, v }); return chain },
        or (e) { a.or = e; return chain },
        in (c, v) { a.ins = { c, v }; return chain },
        gte (c, v) { a.gte = { c, v }; return chain },
        lte (c, v) { a.lte = { c, v }; return chain },
        not () { return chain }, order () { return chain },
        limit () { return Promise.resolve(rep()) },
        maybeSingle () {
          if (table === 'public_tokens') {
            return Promise.resolve({ data: a.f.token === TOKEN
              ? { user_id: U, label: 'Régina', property_ids: tokenPropIds, visibility_days: 30, ratio_periode: 'toujours' }
              : null, error: null })
          }
          if (table === 'profiles') return Promise.resolve({ data: profil, error: erreurProfil })
          const r = rep(); return Promise.resolve({ data: (r.data || [])[0] || null, error: r.error })
        },
        then (ok, ko) { return Promise.resolve(rep()).then(ok, ko) }
      }
      function rep () {
        if (table === 'properties') return { data: BIENS, error: null }
        if (table === 'bookings_snapshot') return { data: SNAPS, error: null }
        if (table === 'menage_done') return { data: done, error: null }
        if (table === 'menage_events') return { data: events, error: null }
        if (table === 'menages') {
          if (erreurMenages) return { data: null, error: erreurMenages }
          // ⚠ Les filtres sont HONORES. Un double qui rend la liste entiere
          // quel que soit le `.eq('provider_id')` ou le `.is(..., null)`
          // laisserait passer exactement la fuite que ce fichier garde.
          // ⚠ Le `.or()` est HONORE : c'est lui qui fait remonter les DEUX
          // familles — ce qu'elle porte, et ce qu'on lui propose. Un double qui
          // l'ignore rendrait le filtre indetectable.
          const d = (menages || []).filter(m => {
            if (a.or) {
              const ids = [...String(a.or).matchAll(/(provider_id|offered_to)\.eq\.([^,)]+)/g)]
              return ids.some(([, col, val]) => String(m[col] || '') === val)
            }
            if (a.f.provider_id !== undefined && m.provider_id !== a.f.provider_id) return false
            for (const c of (a.is || [])) {
              if (c.v === null && m[c.c] != null) return false
            }
            return true
          })
          return { data: d, error: null }
        }
        return { data: [], error: null }
      }
      return chain
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of ['../api/menages-public', '../lib/cron-property-status',
                     '../lib/bookings-snapshot', '../lib/stats-avis',
                     '../lib/attribution-prestataire']) {
    try { delete require.cache[require.resolve(mod)] } catch {}
  }
  return journal
}

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = () => {}
  r.end = () => r
  return r
}
const req = () => ({ method: 'GET', query: { token: TOKEN }, headers: {} })

const MENAGE = (booking, provider, depart, over = {}) => ({
  booking_id: booking, property_id: '209413', departure_date: depart,
  provider_id: provider, status: 'accepted', offered_to: null, offer_expires_at: null, ...over
})

// ─── Le filtre par personne ────────────────────────────────────────────────

test('la prestataire ne voit QUE les ménages qui lui sont assignés', async () => {
  preparer({ menages: [MENAGE('b1', REGINA, '2026-09-05')] })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req(), res)
  assert.strictEqual(res.code, null)
  assert.deepStrictEqual(res.body.bookings.map(b => b.id), ['b1'])
})

test('le séjour de l\'AUTRE prestataire ne sort pas — ni le nom du voyageur', async () => {
  // Le filtre porte sur la réponse entière : un champ imprévu qui laisserait
  // fuiter « Bruno Durand » serait attrapé ici.
  preparer({ menages: [MENAGE('b1', REGINA, '2026-09-05')] })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req(), res)
  const brut = JSON.stringify(res.body)
  assert.ok(!brut.includes('Bruno'), 'le voyageur de l\'autre prestataire ne doit pas sortir')
  assert.ok(!brut.includes('Durand'))
  assert.ok(brut.includes('Alice'), 'le sien, si')
})

test('aucun ménage assigné : planning VIDE, pas le planning du bien', async () => {
  // Sans le filtre, elle verrait les deux séjours d'un bien où elle n'intervient
  // plus.
  preparer({ menages: [] })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req(), res)
  assert.deepStrictEqual(res.body.bookings, [])
})

test('un ménage ANNULÉ ne revient pas au planning', async () => {
  const journal = preparer({ menages: [MENAGE('b1', REGINA, '2026-09-05')] })
  const handler = require('../api/menages-public')
  await handler(req(), reponse())
  const q = journal.find(a => a.table === 'menages')
  assert.ok(q, 'les ménages doivent être lus')
  assert.deepStrictEqual(q.neq, { c: 'status', v: 'cancelled' })
})

test('la lecture des ménages est filtrée par COMPTE et par PERSONNE', async () => {
  // ⚠ Sans `user_id`, la service key contourne la RLS et rien ne cloisonne.
  // Le filtre par personne, lui, porte désormais sur les DEUX colonnes : ce
  // qu'elle porte, et ce qu'on lui propose.
  const journal = preparer({ menages: [MENAGE('b1', REGINA, '2026-09-05')] })
  const handler = require('../api/menages-public')
  await handler(req(), reponse())
  const q = journal.find(a => a.table === 'menages')
  assert.strictEqual(q.f.user_id, U)
  assert.ok(q.or && q.or.includes(`provider_id.eq.${REGINA}`), 'ce qu\'elle porte')
  assert.ok(q.or && q.or.includes(`offered_to.eq.${REGINA}`), 'et ce qu\'on lui propose')
})

test('un ménage PROPOSÉ à quelqu\'un d\'autre reste dans SON planning', async () => {
  // ⚠ LA RÈGLE DU 4 SEPTEMBRE. La proposition ne lui retire rien : tant que
  // personne n'a accepté, le ménage reste sa responsabilité, avec la mention.
  preparer({ menages: [MENAGE('b1', REGINA, '2026-09-05',
    { offered_to: NOUVELLE, offer_expires_at: '2026-09-04T16:00:00Z' })] })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req(), res)
  assert.deepStrictEqual(res.body.bookings.map(b => b.id), ['b1'], 'il reste à l\'écran')
  assert.strictEqual(res.body.menages[0].role, 'porteur')
  assert.strictEqual(res.body.menages[0].propose, true, 'avec la mention')
})

test('le prénom de la personne sollicitée n\'est PAS renvoyé à la porteuse', async () => {
  // Savoir qu'une proposition est en cours lui suffit ; le nom de sa collègue ne
  // la regarde pas plus que l'organisation de l'hôte.
  preparer({ menages: [MENAGE('b1', REGINA, '2026-09-05',
    { offered_to: NOUVELLE, offer_expires_at: '2026-09-04T16:00:00Z' })] })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req(), res)
  assert.ok(!JSON.stringify(res.body).includes(NOUVELLE), 'aucun identifiant de la sollicitée')
})

test('un ménage PROPOSÉ à elle porte son délai, et le rôle « propose »', async () => {
  preparer({ menages: [MENAGE('b1', null, '2026-09-05',
    { offered_to: REGINA, offer_expires_at: '2026-09-04T16:00:00Z', status: 'offered' })] })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req(), res)
  assert.strictEqual(res.body.menages[0].role, 'propose')
  assert.strictEqual(res.body.menages[0].expire_le, '2026-09-04T16:00:00Z')
})

// ─── Le pont de convergence, assumé ────────────────────────────────────────

test('un token SANS profil ne voit QUE ce qui n\'est assigné à personne', async () => {
  // ⚠ LA FUITE QUE CE TEST FERME. `apps/menages/prestataires.html` crée un
  // `public_tokens` SANS profil : garder l'ancien filtrage par bien pour ces
  // tokens-là aurait montré à une prestataire nouvellement créée TOUS les
  // ménages de Régina sur les mêmes biens, noms des voyageurs compris.
  // La règle se dérive du modèle, pas d'une date de bascule : pas de profil,
  // donc rien de ce qui appartient à quelqu'un.
  preparer({ profil: null, menages: [
    MENAGE('b1', REGINA, '2026-09-05'),
    { ...MENAGE('b2', null, '2026-09-09'), status: 'unassigned' }
  ] })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req(), res)
  assert.deepStrictEqual(res.body.bookings.map(b => b.id), ['b2'],
    'le ménage de Régina ne doit pas sortir ; celui de personne, si')
  assert.ok(!JSON.stringify(res.body).includes('Alice'), 'ni le voyageur de Régina')
  assert.strictEqual(res.body.menages, null, 'et aucun état d\'assignation n\'est affiché')
})

test('un lien legacy sur un bien SANS assignation continue de fonctionner', async () => {
  // Contre-épreuve : fermer la fuite ne doit pas vider l'écran de quelqu'un qui
  // s'en sert tous les jours. Colomiers est dans ce cas — 14 ménages, personne
  // d'assigné.
  preparer({ profil: null, menages: [
    { ...MENAGE('b1', null, '2026-09-05'), status: 'unassigned' },
    { ...MENAGE('b2', null, '2026-09-09'), status: 'unassigned' }
  ] })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req(), res)
  assert.strictEqual(res.body.bookings.length, 2)
})

test('un profil DÉSACTIVÉ retombe sur la même règle, pas sur l\'ancienne', async () => {
  // Un profil désactivé ne peut pas porter d'assignation : son token ne doit
  // pas pour autant redevenir une clé passe-partout.
  preparer({ profil: { id: REGINA, first_name: 'Régina', active: false },
             menages: [MENAGE('b1', REGINA, '2026-09-05')] })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req(), res)
  assert.deepStrictEqual(res.body.bookings, [], 'rien qui appartienne à quelqu\'un')
})

// ─── Les pannes coupent, elles n'élargissent pas ───────────────────────────

test('PANNE de lecture du profil : 503, jamais le planning de tout le monde', async () => {
  // Sans cette garde, un timeout PostgREST rendrait `profil` null et la
  // prestataire verrait de nouveau les ménages des autres sur ses biens.
  preparer({ erreurProfil: { message: 'timeout' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req(), res)
  assert.strictEqual(res.code, 503)
})

test('PANNE de lecture des ménages : 503, jamais « rien à faire »', async () => {
  // Une liste vide par panne serait indiscernable d'« aucun ménage », et elle en
  // conclurait qu'elle n'a rien à faire aujourd'hui.
  preparer({ erreurMenages: { message: 'timeout' } })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req(), res)
  assert.strictEqual(res.code, 503)
})

// ─── Ce que la réponse porte en plus ───────────────────────────────────────

test('le statut d\'assignation est renvoyé, pour distinguer proposé et engagé', async () => {
  preparer({ menages: [{ ...MENAGE('b1', REGINA, '2026-09-05'), status: 'offered' }] })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req(), res)
  assert.strictEqual(res.body.menages.length, 1)
  assert.strictEqual(res.body.menages[0].status, 'offered')
  assert.strictEqual(res.body.prenom, 'Régina')
})

test('la liste des ménages FAITS suit la personne, pas les biens du token', async () => {
  // ⚠ Elle était calculée sur les biens du token : les `booking_id` et les dates
  // des ménages terminés par l'autre prestataire traversaient le filtre que ce
  // lot vient d'installer.
  preparer({
    menages: [MENAGE('b1', REGINA, '2026-09-05')],
    done: [
      { booking_id: 'b1', property_id: '209413', departure_date: '2026-09-05', done_at: 'x' },
      { booking_id: 'b2', property_id: '209413', departure_date: '2026-09-09', done_at: 'y' }
    ]
  })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req(), res)
  assert.deepStrictEqual(res.body.done.map(d => d.booking_id), ['b1'],
    'le ménage fait par l\'autre ne doit pas sortir')
})

// ─── Le fil d'actualités : la porte que le filtre laissait ouverte ─────────

test('le fil d\'actualités ne porte QUE ses ménages', async () => {
  // ⚠ LA FUITE QUE CE TEST FERME. `menage_events` est diffusé PAR BIEN
  // (lib/cleaning/sync-menages.js) : tout token dont `property_ids` couvre le
  // bien reçoit une ligne, la table n'ayant aucun `provider_id`. Lu par
  // `.eq('token', …)` seul, le bandeau affichait à une nouvelle prestataire le
  // NOM DU VOYAGEUR, l'arrivée et le départ de chaque réservation du bien —
  // pendant que `bookings` et `done`, eux, étaient bien filtrés. Filtrer les
  // réservations ne servait à rien tant que cette porte restait ouverte.
  preparer({
    menages: [MENAGE('b1', REGINA, '2026-09-05')],
    events: [
      { id: 'e1', token: TOKEN, property_id: '209413', booking_id: 'b1', event_type: 'new',
        event_data: { guestName: 'Alice Martin', arrival: '2026-09-01', departure: '2026-09-05' } },
      { id: 'e2', token: TOKEN, property_id: '209413', booking_id: 'b2', event_type: 'new',
        event_data: { guestName: 'Bruno Durand', arrival: '2026-09-06', departure: '2026-09-09' } }
    ]
  })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req(), res)
  assert.deepStrictEqual(res.body.events.map(e => e.id), ['e1'])
  assert.ok(!JSON.stringify(res.body).includes('Bruno'), 'le voyageur de l\'autre ne doit pas sortir')
})

test('les notes de l\'hôte passent, elles ne désignent aucune réservation', async () => {
  // Contre-épreuve : fermer la porte ne doit pas faire disparaître les messages
  // que l'hôte adresse au porteur du lien.
  preparer({
    menages: [],
    events: [{ id: 'n1', token: TOKEN, property_id: '209413', booking_id: null,
               event_type: 'note', event_data: { note: 'Penser aux draps' } }]
  })
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler(req(), res)
  assert.deepStrictEqual(res.body.events.map(e => e.id), ['n1'])
})
