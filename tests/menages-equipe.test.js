// tests/menages-equipe.test.js
// GET /api/menages?equipe=1 — le volet « Équipe ménage » (lot Ménages V5).
//
// ⚠ CE QUI EST EN JEU. Ce chemin rend l'ANNUAIRE du personnel de l'hôte et
// ce que les voyageurs ont dit de chaque personne. Trois droits le gardent,
// et ils ne disent pas la même chose :
//   `menages: read`      → ouvre l'endpoint ;
//   `prestataires: read` → les PERSONNES (sans lui, pas même un identifiant —
//                          un annuaire stable reconstitue l'équipe) ;
//   `avis: read`         → les RETOURS (une parole de voyageur sur quelqu'un).
// Les confondre exposerait à un délégué « couverture » la composition de
// l'équipe et les reproches faits à chacune.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const PROD = '11111111-1111-4111-8111-111111111111'
const MEMBRE = '22222222-2222-4222-8222-222222222222'
const REGINA = 'aaaa1111-1111-4111-8111-111111111111'
const LENA = 'bbbb2222-2222-4222-8222-222222222222'
const BIEN = '209413', BIEN2 = '209414'

function preparer ({ user = PROD, profil = null, permissions = null,
                     profils = [{ id: REGINA, first_name: 'Régina', last_name: 'M.', active: true, pwa_token: 'tok-r' },
                                { id: LENA, first_name: 'Lena', last_name: 'Lou', active: false, pwa_token: 'tok-l' }],
                     liaisons = [], biens = [{ provider_property_id: BIEN, name: 'La bulle', photo_url: 'p.jpg' },
                                             { provider_property_id: BIEN2, name: 'Colomiers', photo_url: null }],
                     jetons = [{ token: 'tok-r', ratio_periode: '30j' }],
                     ratio = null, erreurProfils = null, erreurBiens = null, erreurJetons = null } = {}) {
  const etat = { lectures: [], ratios: [] }
  const client = {
    auth: { getUser: async () => (user ? { data: { user: { id: user } }, error: null }
                                       : { data: null, error: { message: 'x' } }) },
    from (table) {
      const a = { table, f: {} }
      etat.lectures.push(a)
      const rep = () => {
        if (table === 'profiles') return { data: profils, error: erreurProfils }
        if (table === 'property_cleaning_providers') return { data: liaisons, error: null }
        if (table === 'properties') return { data: erreurBiens ? null : biens, error: erreurBiens }
        if (table === 'public_tokens') return { data: erreurJetons ? null : jetons, error: erreurJetons }
        return { data: [], error: null }
      }
      const chain = {
        select () { return chain },
        eq (c, v) { a.f[c] = v; return chain },
        neq () { return chain }, not () { return chain }, or () { return chain },
        in (c, v) { a.f['in_' + c] = v; return chain },
        gte () { return chain }, lte () { return chain }, order () { return chain },
        limit () { return Promise.resolve(rep()) },
        // ⚠ `lireTout` pagine : `.order().range()`. Un double qui s'arrête à
        // `limit` ferait rougir le test sur sa propre faiblesse.
        range (from) { return Promise.resolve(from === 0 ? rep() : { data: [], error: null }) },
        maybeSingle () {
          if (table === 'profiles') return Promise.resolve({ data: profil, error: null })
          if (table === 'profile_permissions') return Promise.resolve({ data: permissions, error: null })
          return Promise.resolve({ data: null, error: null })
        },
        then (ok) { return Promise.resolve(rep()).then(ok) }
      }
      return chain
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of ['../lib/require-permission', '../lib/permissions', '../api/menages',
                     '../lib/stats-avis']) {
    try { delete require.cache[require.resolve(mod)] } catch {}
  }
  // ⚠ Le double de `ratioProprete` ENREGISTRE ses arguments : la période et le
  // périmètre transmis sont la moitié de ce que ce chemin promet (« le même
  // chiffre qu'elle voit »).
  const absStats = require.resolve(path.join(__dirname, '..', 'lib/stats-avis.js'))
  const mstats = new Module(absStats)
  mstats.exports = {
    ratioProprete: async (sb, opts) => {
      etat.ratios.push(opts)
      if (ratio === 'panne') return { erreur: true, total: 0, positif: 0, remarque: 0 }
      if (ratio === 'jette') throw new Error('boom')
      return { total: 12, positif: 9, remarque: 2, rien_signale: 1, non_analyses: 0 }
    },
    noteMoyenne: async () => null, borneDepuis: () => null,
    periodeNormalisee: p => p, PERIODES: {}
  }
  mstats.loaded = true
  require.cache[absStats] = mstats
  return { handler: require('../api/menages'), etat }
}

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  return r
}
const get = (entetes = {}) => ({ method: 'GET', query: { equipe: '1' },
  headers: { authorization: 'Bearer jeton', ...entetes } })

const LIAISON = (o = {}) => ({ provider_id: REGINA, property_id: BIEN,
                               requires_ack: false, weekdays: null, ...o })

// ─── Les droits ─────────────────────────────────────────────────────────────

test('sans session : 401', async () => {
  const { handler } = preparer({ user: null })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.code, 401)
})

test('sans `prestataires: read` : liste VIDE, et aucun profil n\'est lu', async () => {
  // Pas une erreur : l'écran n'affiche simplement pas le volet. Mais pas un
  // identifiant ne sort — un annuaire stable reconstitue l'équipe.
  const { handler, etat } = preparer({
    user: MEMBRE,
    profil: { id: 'pr1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { menages: 'read', prestataires: 'none', property_scope: 'all' }
  })
  const res = reponse()
  await handler(get({ 'x-compte': PROD }), res)
  assert.strictEqual(res.code, 200)
  assert.deepStrictEqual(res.body.prestataires, [])
  assert.strictEqual(res.body.avec_avis, false)
  assert.ok(!etat.lectures.some(l => l.table === 'property_cleaning_providers'),
    'rien n\'est lu au-delà de la garde')
})

test('sans `avis: read` : les personnes sortent, les RETOURS non', async () => {
  const { handler, etat } = preparer({
    user: MEMBRE,
    profil: { id: 'pr1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { menages: 'read', prestataires: 'read', avis: 'none', property_scope: 'all' },
    liaisons: [LIAISON()]
  })
  const res = reponse()
  await handler(get({ 'x-compte': PROD }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.avec_avis, false)
  assert.strictEqual(res.body.prestataires.length, 2)
  assert.ok(res.body.prestataires.every(p => p.retours === null), 'aucun compte de retours')
  assert.strictEqual(etat.ratios.length, 0, 'et la fonction de comptage n\'est même pas appelée')
})

// ─── Ce que la liste dit ────────────────────────────────────────────────────

test('les DÉSACTIVÉES restent listées, avec leur drapeau', async () => {
  // Les effacer ferait disparaître l'historique de quelqu'un qui a travaillé
  // pour l'hôte — et l'écran les montre grisées, pas absentes.
  const { handler } = preparer({ liaisons: [LIAISON()] })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.body.prestataires.length, 2)
  const lena = res.body.prestataires.find(p => p.id === LENA)
  assert.strictEqual(lena.actif, false)
  assert.strictEqual(lena.prenom, 'Lena')
  assert.strictEqual(lena.nom, 'Lou', 'le nom de famille sort : le volet affiche prénom + nom')
})

test('chaque personne porte SES biens, avec nom et photo', async () => {
  const { handler } = preparer({ liaisons: [LIAISON(), LIAISON({ property_id: BIEN2 }),
                                            LIAISON({ provider_id: LENA, property_id: BIEN2 })] })
  const res = reponse()
  await handler(get(), res)
  const regina = res.body.prestataires.find(p => p.id === REGINA)
  assert.deepStrictEqual(regina.biens.map(b => b.nom).sort(), ['Colomiers', 'La bulle'])
  assert.strictEqual(regina.biens.find(b => b.nom === 'La bulle').photo, 'p.jpg')
  assert.strictEqual(regina.biens.find(b => b.nom === 'Colomiers').photo, null,
    'un bien sans photo rend null, jamais une chaîne vide')
  const lena = res.body.prestataires.find(p => p.id === LENA)
  assert.deepStrictEqual(lena.biens.map(b => b.nom), ['Colomiers'])
})

test('« jours à régler » suit la MÊME règle que le planning (§12.9c)', async () => {
  // Elle doit confirmer, et aucun jour ne lui est confié : le moteur ne lui
  // proposera jamais rien sur ce bien.
  const { handler } = preparer({ liaisons: [
    LIAISON({ requires_ack: true, weekdays: [] }),
    LIAISON({ provider_id: LENA, requires_ack: true, weekdays: [1, 3] })
  ] })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.body.prestataires.find(p => p.id === REGINA).aRegler, true)
  assert.strictEqual(res.body.prestataires.find(p => p.id === LENA).aRegler, false)
})

// ─── Les retours ────────────────────────────────────────────────────────────

test('les retours sont comptés par personne, sur SA période à elle', async () => {
  // « Le même chiffre que ce qu'elle voit » : son en-tête suit
  // `public_tokens.ratio_periode`. Une autre période afficherait à l'hôte un
  // chiffre différent du sien, pour la même réalité.
  const { handler, etat } = preparer({ liaisons: [LIAISON()] })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.body.avec_avis, true)
  const regina = res.body.prestataires.find(p => p.id === REGINA)
  assert.deepStrictEqual(regina.retours, { positif: 9, remarque: 2, total: 12 })
  const sien = etat.ratios.find(o => o.prestataireId === REGINA)
  assert.strictEqual(sien.periode, '30j', 'la période de SON jeton')
  const autre = etat.ratios.find(o => o.prestataireId === LENA)
  assert.strictEqual(autre.periode, 'toujours', 'sans jeton connu : « toujours », jamais une période inventée')
})

test('une panne de comptage laisse « — », elle n\'invente pas un zéro', async () => {
  const { handler } = preparer({ liaisons: [LIAISON()], ratio: 'panne' })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.code, 200)
  assert.ok(res.body.prestataires.every(p => p.retours === null),
    'une panne n\'est pas « aucun retour »')
})

test('une exception de comptage ne fait pas tomber le volet', async () => {
  const { handler } = preparer({ liaisons: [LIAISON()], ratio: 'jette' })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.prestataires.length, 2)
})

// ─── Le périmètre ───────────────────────────────────────────────────────────

test('un délégué ne voit que les biens de SON périmètre', async () => {
  const { handler, etat } = preparer({
    user: MEMBRE,
    profil: { id: 'pr1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { menages: 'read', prestataires: 'read', avis: 'read',
                   property_scope: 'selected', property_ids: [BIEN2] },
    liaisons: [LIAISON({ property_id: BIEN2 })]
  })
  const res = reponse()
  await handler(get({ 'x-compte': PROD }), res)
  assert.strictEqual(res.code, 200)
  const l = etat.lectures.find(x => x.table === 'property_cleaning_providers')
  assert.deepStrictEqual(l.f.in_property_id, [BIEN2], 'les liaisons sont bornées au périmètre')
  const r = etat.ratios[0]
  assert.deepStrictEqual(r.refs, [BIEN2], 'et le comptage des retours aussi')
})

test('une panne de lecture des profils : 503, pas une liste vide', async () => {
  // Une équipe vide et une équipe illisible ne se disent pas de la même façon.
  const { handler } = preparer({ erreurProfils: { message: 'boom' } })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.code, 503)
})

// ─── Constats de la revue de dfcf8d4 : les pannes ne mentent pas ────────────

test('une panne de lecture des BIENS coupe — elle n\'affiche pas « aucun bien couvert »', async () => {
  // Sans les noms, chaque personne paraîtrait ne couvrir aucun bien : un écran
  // faux, et faux dans le sens rassurant.
  const { handler } = preparer({ liaisons: [LIAISON()], erreurBiens: { message: 'boom' } })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.code, 503)
})

test('une panne de lecture des PÉRIODES empêche le comptage — elle ne l\'élargit pas', async () => {
  // Retomber sur « toujours » ferait lire à l'hôte 47 retours là où elle en
  // voit 2 : un élargissement silencieux. Sans période sûre, pas de chiffre.
  const { handler, etat } = preparer({ liaisons: [LIAISON()], erreurJetons: { message: 'boom' } })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(etat.ratios.length, 0, 'aucun comptage lancé')
  assert.ok(res.body.prestataires.every(p => p.retours === null), 'et l\'écran affiche « — »')
})

test('une période inconnue en base retombe sur « toujours », comme la PWA', async () => {
  // `periodeNormalisee` retomberait sur « 30j » : deux chiffres contradictoires
  // pour la même personne seraient pires que pas de chiffre.
  const { handler, etat } = preparer({ liaisons: [LIAISON()],
    jetons: [{ token: 'tok-r', ratio_periode: 'bizarre' }] })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(etat.ratios.find(o => o.prestataireId === REGINA).periode, 'toujours')
})

test('sans `prestataires: read`, la réponse DIT que ce n\'est pas une équipe vide', async () => {
  // Sans ce drapeau, l'écran affirmait « personne dans l'équipe » à un délégué
  // qui n'a simplement pas le droit de la voir.
  const { handler } = preparer({
    user: MEMBRE,
    profil: { id: 'pr1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { menages: 'read', prestataires: 'none', property_scope: 'all' }
  })
  const res = reponse()
  await handler(get({ 'x-compte': PROD }), res)
  assert.strictEqual(res.body.avec_personnes, false)
  const { handler: h2 } = preparer({ liaisons: [LIAISON()] })
  const r2 = reponse()
  await h2(get(), r2)
  assert.strictEqual(r2.body.avec_personnes, true, 'et une vraie équipe le dit aussi')
})

test('les biens sont bornés au PÉRIMÈTRE, pas seulement les liaisons', async () => {
  const { handler, etat } = preparer({
    user: MEMBRE,
    profil: { id: 'pr1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { menages: 'read', prestataires: 'read', property_scope: 'selected', property_ids: [BIEN2] },
    liaisons: [LIAISON({ property_id: BIEN2 })]
  })
  const res = reponse()
  await handler(get({ 'x-compte': PROD }), res)
  const q = etat.lectures.find(x => x.table === 'properties')
  assert.deepStrictEqual(q.f.in_provider_property_id, [BIEN2])
})
