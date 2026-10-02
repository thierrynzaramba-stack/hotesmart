// tests/menages-public-visibilite.test.js
// api/menages-public.js — ce qu'une prestataire voit des ménages PRIS PAR D'AUTRES.
// Spec : docs/specs/spec-visibilite-menages-autrui.md (2 octobre 2026).
//
// ⚠ CE QUI EST EN JEU. Par défaut, elle ne voit que ses ménages. L'hôte peut
// l'autoriser, sur sa fiche, à voir ceux des autres — par bien, par personne, ou
// les deux (union). Le FILTRAGE est fait ICI, côté serveur, à chaque lecture, et
// ce qui sort est une LISTE BLANCHE : le bien, la date, l'heure, le nom de la
// prestataire. Jamais le voyageur, le code d'accès, la réservation, un
// identifiant, un commentaire ou une photo.
//
// ⚠ DATES RELATIVES : le planning lit l'horloge (fenêtre -14 j / +30 j). Règle du
// dépôt, et la famille des 28 rouges en est la preuve.
//
// ⚠ LE DOUBLE APPLIQUE VRAIMENT LES FILTRES (eq, neq, in, is, or, bornes) : un
// double qui rendrait toutes les lignes laisserait passer un serveur qui
// oublierait de filtrer — exactement ce que ces tests existent pour attraper.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const U = 'compte-1', AUTRE_COMPTE = 'compte-2', TOKEN = 'lena-jeton'
const LENA = 'p-lena', LOLA = 'p-lola', MARC = 'p-marc', VIEILLE = 'p-vieille', ETRANGERE = 'p-etrangere'
const B1 = '204cef81', B2 = '209413', B3 = '0db6b39b'

const jour = n => {
  const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

const PROFILS = [
  { id: LENA, account_user_id: U, first_name: 'Lena', last_name: 'Lou', active: true, access_mode: 'lien', pwa_token: TOKEN },
  { id: LOLA, account_user_id: U, first_name: 'Lola', last_name: 'Dupont', active: true, access_mode: 'lien' },
  { id: MARC, account_user_id: U, first_name: 'Marc', last_name: 'Bel', active: true, access_mode: 'lien' },
  { id: VIEILLE, account_user_id: U, first_name: 'Ancienne', last_name: 'Presta', active: false, access_mode: 'lien' },
  { id: ETRANGERE, account_user_id: AUTRE_COMPTE, first_name: 'Autre', last_name: 'Compte', active: true, access_mode: 'lien' }
]
const BIENS = [
  { user_id: U, provider_property_id: B1, name: 'Ofuro Futari', provider: 'channex', checkout_time: '11:00' },
  { user_id: U, provider_property_id: B2, name: 'La bulle', provider: 'channex', checkout_time: null },
  // Hors du périmètre de son lien : jamais servi, quelle que soit la portée.
  { user_id: U, provider_property_id: B3, name: 'Cœur de vie', provider: 'channex', checkout_time: '10:00' }
]
const M = (booking, bien, provider, n, over = {}) => ({
  user_id: U, booking_id: booking, property_id: bien, departure_date: jour(n),
  provider_id: provider, status: 'accepted', offered_to: null, offer_expires_at: null,
  assigned_by: 'auto', ...over
})
const MENAGES = [
  M('bk-lola-1', B1, LOLA, 3),                                    // pris par Lola, sur un bien d'elle
  M('bk-marc-2', B2, MARC, 4),                                    // pris par Marc, bien sans liaison active
  M('bk-lola-3', B2, LOLA, -2, { status: 'completed' }),          // fait par Lola, bien sans liaison active
  M('bk-prop-4', B1, null, 5, { status: 'offered', offered_to: LOLA }), // seulement PROPOSÉ à Lola
  M('bk-lola-5', B3, LOLA, 6),                                    // hors périmètre du lien
  M('bk-vieille-6', B1, VIEILLE, 7),                              // personne désactivée
  M('bk-lena-7', B1, LENA, 8),                                    // le sien
  M('bk-lena-7', B1, LENA, -1),                                   // le sien, passé (marquable fait)
  M('bk-lola-8', B1, LOLA, 9, { offered_to: LENA }),              // porté par Lola, proposé à Lena
  M('bk-annule-9', B1, LOLA, 10, { status: 'cancelled' }),
  // UN AUTRE COMPTE, sur le MEME identifiant de bien (cle provider TEXT) et
  // avec une prestataire de ce compte-la : ne doit jamais sortir.
  M('bk-etranger-10', B1, ETRANGERE, 3, { user_id: AUTRE_COMPTE })
]
const SNAP = (booking, bien, n, prenom, nom) => ({
  user_id: U, booking_id: booking, property_id: bien,
  snapshot: { status: 'confirmed', provider: 'channex', arrival: jour(n - 2), departure: jour(n),
              firstName: prenom, lastName: nom }
})
const SNAPS = [
  SNAP('bk-lena-7', B1, 8, 'Alice', 'Martin'),
  SNAP('bk-lola-8', B1, 9, 'Camille', 'Proposée'),
  SNAP('bk-lola-1', B1, 3, 'Zoé', 'Secret'),
  SNAP('bk-marc-2', B2, 4, 'Yves', 'Privé')
]
const LIAISONS = [
  { user_id: U, property_id: B1, provider_id: LENA, active: true },
  { user_id: U, property_id: B2, provider_id: LENA, active: false }
]

function lire (ligne, col) {
  if (col.includes('->>')) { const [a, b] = col.split('->>'); return ligne[a] ? ligne[a][b] : undefined }
  return ligne[col]
}

function preparer ({ visibilite = null, erreurs = {} } = {}) {
  const tables = {
    public_tokens: [{ token: TOKEN, user_id: U, label: 'Lena', property_ids: [B1, B2], visibility_days: 30 }],
    profiles: PROFILS, properties: BIENS, bookings_snapshot: SNAPS, menages: MENAGES,
    property_cleaning_providers: LIAISONS,
    menage_visibilite: visibilite ? [{ user_id: U, profile_id: LENA, ...visibilite }] : []
  }
  const journal = []
  const ecritures = []
  const client = {
    from (table) {
      const conds = []
      const a = { table, conds }
      journal.push(a)
      const filtrer = () => (tables[table] || []).filter(l => conds.every(c => {
        const v = c.col ? lire(l, c.col) : undefined
        if (c.op === 'eq') return String(v) === String(c.val)
        if (c.op === 'neq') return String(v) !== String(c.val)
        if (c.op === 'in') return c.val.map(String).includes(String(v))
        if (c.op === 'is') return c.val === null ? v == null : v === c.val
        if (c.op === 'notis') return v != null
        if (c.op === 'gte') return v != null && String(v) >= String(c.val)
        if (c.op === 'lte') return v != null && String(v) <= String(c.val)
        if (c.op === 'or') {
          return String(c.val).split(',').some(t => {
            const [col, op, ...reste] = t.trim().split('.')
            const val = reste.join('.')
            const x = lire(l, col)
            if (op === 'eq') return String(x) === val
            if (op === 'neq') return String(x) !== val
            if (op === 'is' && val === 'null') return x == null
            return true
          })
        }
        return true
      }))
      const rep = () => {
        if (erreurs[table]) return { data: null, error: erreurs[table] }
        const d = filtrer()
        if (a.ecriture) a.ecriture.touchees = d
        return { data: d, error: null }
      }
      const chain = {
        select () { return chain },
        eq (col, val) { conds.push({ op: 'eq', col, val }); return chain },
        neq (col, val) { conds.push({ op: 'neq', col, val }); return chain },
        in (col, val) { conds.push({ op: 'in', col, val }); return chain },
        is (col, val) { conds.push({ op: 'is', col, val }); return chain },
        not (col, op, val) { if (op === 'is' && val === null) conds.push({ op: 'notis', col }); return chain },
        gte (col, val) { conds.push({ op: 'gte', col, val }); return chain },
        lte (col, val) { conds.push({ op: 'lte', col, val }); return chain },
        or (val) { conds.push({ op: 'or', val }); return chain },
        // Une ECRITURE se trace avec les lignes qu'elle toucherait (filtres
        // appliques) : c'est ce qui prouve qu'aucune action n'atteint un menage
        // d'autrui. Rien n'est modifie dans le jeu d'essai.
        update (row) { const e = { table, op: 'update', row, conds }; ecritures.push(e); a.ecriture = e; return chain },
        delete () { const e = { table, op: 'delete', conds }; ecritures.push(e); a.ecriture = e; return chain },
        insert (row) { const e = { table, op: 'insert', row, conds }; ecritures.push(e); a.ecriture = e; return chain },
        upsert (row) { const e = { table, op: 'upsert', row, conds }; ecritures.push(e); a.ecriture = e; return chain },
        order () { return chain },
        limit () { return Promise.resolve(rep()) },
        maybeSingle () { const r = rep(); return Promise.resolve({ data: r.data ? r.data[0] || null : null, error: r.error }) },
        single () { const r = rep(); return Promise.resolve({ data: r.data ? r.data[0] || null : null, error: r.error }) },
        then (ok, ko) { return Promise.resolve(rep()).then(ok, ko) }
      }
      return chain
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of ['../api/menages-public', '../lib/cron-property-status', '../lib/bookings-snapshot',
                     '../lib/stats-avis', '../lib/attribution-prestataire', '../lib/alert-notify',
                     '../lib/cleaning/apres-changement-regles']) {
    try { delete require.cache[require.resolve(mod)] } catch {}
  }
  return { handler: require('../api/menages-public'), journal, ecritures }
}

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = () => {}
  r.end = () => r
  return r
}
const planning = () => ({ method: 'GET', query: { token: TOKEN }, headers: {} })
async function lirePlanning (opts) {
  const { handler, journal } = preparer(opts)
  const res = reponse()
  await handler(planning(), res)
  return { res, journal }
}

const SENSIBLES = ['Zoé', 'Secret', 'Yves', 'Privé', 'bk-lola-1', 'bk-marc-2', 'bk-lola-3', 'bk-vieille-6',
                   'Ancienne', 'Cœur de vie']

test('SANS réglage : zéro ménage d\'autrui — ni dans `autrui`, ni dans ses ménages, ni dans un compteur', async () => {
  const { res } = await lirePlanning()
  // Le planning répond par `res.json(...)` sans `status` : 200 par défaut (Vercel).
  assert.ok(res.code === null || res.code === 200, `réponse normale, pas ${res.code}`)
  assert.deepStrictEqual(res.body.autrui, [], 'toujours un tableau, vide sans autorisation')
  const corps = JSON.stringify(res.body)
  for (const s of SENSIBLES) assert.ok(!corps.includes(s), `rien de « ${s} » ne sort`)
})

test('LA MÊME requête, avec et sans réglage : seule `autrui` change — ses ménages et ses compteurs non', async () => {
  const sans = (await lirePlanning()).res.body
  const avec = (await lirePlanning({ visibilite: { par_bien: true, profils_vus: [MARC] } })).res.body
  assert.strictEqual(sans.autrui.length, 0)
  assert.ok(avec.autrui.length > 0)
  assert.deepStrictEqual(avec.bookings, sans.bookings, 'ses réservations n\'ont pas bougé')
  assert.deepStrictEqual(avec.menages, sans.menages, 'ses ménages — donc ses compteurs — n\'ont pas bougé')
  assert.deepStrictEqual(avec.a_prendre, sans.a_prendre)
})

test('LISTE BLANCHE : chaque ligne porte EXACTEMENT bien, date, heure, prestataire', async () => {
  const { res } = await lirePlanning({ visibilite: { par_bien: true, profils_vus: [MARC] } })
  assert.ok(res.body.autrui.length >= 2)
  for (const l of res.body.autrui) {
    assert.deepStrictEqual(Object.keys(l).sort(), ['bien', 'date', 'heure', 'prestataire'],
      'un champ de plus fait rougir ce test — c\'est voulu')
  }
  const corps = JSON.stringify(res.body)
  for (const s of SENSIBLES.filter(x => !['Cœur de vie'].includes(x))) {
    assert.ok(!corps.includes(s), `ni voyageur, ni réservation : « ${s} »`)
  }
  assert.deepStrictEqual(res.body.autrui.find(l => l.date === jour(3)),
    { bien: 'Ofuro Futari', date: jour(3), heure: '11:00', prestataire: 'Lola Dupont' })
  assert.deepStrictEqual(res.body.autrui.find(l => l.date === jour(4)),
    { bien: 'La bulle', date: jour(4), heure: null, prestataire: 'Marc Bel' },
    'heure inconnue = null, l\'écran dit « heure non précisée »')
})

test('PAR BIEN : seulement ses liaisons ACTIVES, seulement ce qui est PRIS, par une personne ACTIVE', async () => {
  const { res } = await lirePlanning({ visibilite: { par_bien: true, profils_vus: [] } })
  assert.deepStrictEqual(res.body.autrui.map(l => l.date), [jour(3)],
    'B2 (liaison inactive), la proposition, l\'annulé, la désactivée et le sien ne sortent pas')
})

test('PAR PERSONNE : les ménages des seules prestataires désignées, sur le périmètre de son lien', async () => {
  const { res } = await lirePlanning({ visibilite: { par_bien: false, profils_vus: [LOLA] } })
  const dates = res.body.autrui.map(l => l.date).sort()
  assert.deepStrictEqual(dates, [jour(-2), jour(3)].sort(),
    'Lola sur B1 et B2 — pas hors périmètre (B3), pas le ménage qu\'on propose à Lena')
  assert.ok(res.body.autrui.every(l => l.prestataire === 'Lola Dupont'), 'pas Marc')
})

test('LES DEUX PORTÉES SE CUMULENT (union, sans doublon), triées par date', async () => {
  const { res } = await lirePlanning({ visibilite: { par_bien: true, profils_vus: [LOLA, MARC] } })
  assert.deepStrictEqual(res.body.autrui.map(l => l.date), [jour(-2), jour(3), jour(4)])
})

test('une personne d\'un AUTRE compte, ou elle-même, désignée en base : rien ne sort pour elles', async () => {
  const { res } = await lirePlanning({ visibilite: { par_bien: false, profils_vus: [ETRANGERE, LENA] } })
  assert.deepStrictEqual(res.body.autrui, [])
})

test('une PANNE de lecture du réglage coupe (503) — ni vue vide, ni vue pleine', async () => {
  const { res } = await lirePlanning({ visibilite: { par_bien: true, profils_vus: [] },
                                       erreurs: { menage_visibilite: { message: 'timeout' } } })
  assert.strictEqual(res.code, 503)
})

test('le réglage est relu À CHAQUE lecture, filtré sur CE compte et CETTE prestataire', async () => {
  const { journal } = await lirePlanning({ visibilite: { par_bien: true, profils_vus: [] } })
  const v = journal.filter(a => a.table === 'menage_visibilite')
  assert.strictEqual(v.length, 1)
  const eq = Object.fromEntries(v[0].conds.filter(c => c.op === 'eq').map(c => [c.col, c.val]))
  assert.deepStrictEqual(eq, { user_id: U, profile_id: LENA })
})

test('un ménage d\'un AUTRE compte, sur le même identifiant de bien, ne sort jamais — même désignée', async () => {
  const { res } = await lirePlanning({ visibilite: { par_bien: true, profils_vus: [ETRANGERE, LOLA] } })
  assert.ok(!JSON.stringify(res.body).includes('Autre Compte'))
  assert.deepStrictEqual(res.body.autrui.filter(l => l.date === jour(3)).map(l => l.prestataire), ['Lola Dupont'],
    'le 3, seule Lola (de CE compte) sort')
})

test('AUCUNE ACTION sur le ménage d\'une autre : ni prise, ni « fait », ni retrait — même avec ses identifiants', async () => {
  // L'identifiant ne sort jamais dans `autrui` ; on suppose ici le pire : elle
  // l'a deviné (Beds24 numérote en séquence).
  for (const action of ['prendreMenage', 'markDone', 'markUndone', 'retirerMonMenage']) {
    const { handler, ecritures } = preparer({ visibilite: { par_bien: true, profils_vus: [LOLA] } })
    const res = reponse()
    await handler({ method: 'POST', query: { token: TOKEN }, headers: {},
                    body: { action, booking_id: 'bk-lola-1', property_id: B1, departure_date: jour(3) } }, res)
    assert.ok(res.code >= 400, `${action} refusé (${res.code})`)
    const touchees = ecritures.filter(e => e.table === 'menages' || e.table === 'menage_done')
      .flatMap(e => e.touchees || [])
      .filter(l => l.booking_id === 'bk-lola-1')
    assert.strictEqual(touchees.length, 0, `${action} n'a touché aucune ligne du ménage de Lola`)
  }
  // CONTRÔLE POSITIF : sur SON ménage, « fait » passe. Sans lui, un harnais qui
  // refuserait tout rendrait ce test vert pour rien.
  const { handler } = preparer({ visibilite: { par_bien: true, profils_vus: [LOLA] } })
  const res = reponse()
  await handler({ method: 'POST', query: { token: TOKEN }, headers: {},
                  body: { action: 'markDone', booking_id: 'bk-lena-7', property_id: B1, departure_date: jour(-1) } }, res)
  assert.ok(res.code === null || res.code < 400, `son propre ménage, lui, se marque fait (${res.code} ${JSON.stringify(res.body)})`)
})
