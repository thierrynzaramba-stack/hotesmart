// tests/menages-fiche-presta.test.js
// GET /api/menages?presta=<id> et POST action:'reglages_lien' — la fenêtre de
// configuration d'une prestataire (lot Ménages V5).
//
// ⚠ CE QUI EST EN JEU. Cette réponse porte TOUT ce qu'un hôte règle sur une
// personne : ses biens, ses jours, ses coordonnées, les droits de son
// application. Quatre fautes la rendraient dangereuse :
//   - laisser sortir son JETON (c'est son mot de passe, et il ouvre sa page) ;
//   - oublier les liaisons INACTIVES (le rang et les jours d'un bien retiré
//     seraient perdus à la réouverture, en silence) ;
//   - ignorer le périmètre de l'appelant (un délégué verrait des biens qu'il
//     n'a pas le droit d'ouvrir) ;
//   - confondre « non lu » et « valeur par défaut » (l'écran afficherait
//     30 jours sur une panne, et l'enregistrement suivant l'écrirait).

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

const PROFIL_REGINA = { id: REGINA, first_name: 'Régina', last_name: 'M.', active: true,
                        pwa_token: 'tok-secret', phone: '+33600000000', email: 'r@ex.fr',
                        notify_sms: true, notify_email: false }

function preparer ({ user = PROD, profil = null, permissions = null,
                     cible = PROFIL_REGINA, erreurCible = null,
                     liaisons = [], biens = [{ provider_property_id: BIEN, name: 'La bulle', photo_url: 'p.jpg' },
                                             { provider_property_id: BIEN2, name: 'Colomiers', photo_url: null }],
                     erreurBiens = null, erreurLiaisons = null,
                     jeton = { visibility_days: 60, ratio_periode: '30j', pwa_vue_le: '2026-10-13T18:09:00Z' },
                     erreurJeton = null, droitsPresta = { self_availability: 'write' }, erreurDroits = null,
                     collegues = [{ id: LENA, first_name: 'Lena', last_name: 'Lou', active: false }],
                     erreurUpdate = null } = {}) {
  const etat = { lectures: [], ecritures: [] }
  const client = {
    auth: { getUser: async () => (user ? { data: { user: { id: user } }, error: null }
                                       : { data: null, error: { message: 'x' } }) },
    from (table) {
      const a = { table, f: {} }
      etat.lectures.push(a)
      const rep = () => {
        if (a.update) { etat.ecritures.push(a); return { data: null, error: erreurUpdate } }
        if (table === 'profiles') return { data: collegues, error: null }
        if (table === 'property_cleaning_providers') return { data: erreurLiaisons ? null : liaisons, error: erreurLiaisons }
        if (table === 'properties') return { data: erreurBiens ? null : biens, error: erreurBiens }
        return { data: [], error: null }
      }
      const chain = {
        select () { return chain },
        update (v) { a.update = v; return chain },
        eq (c, v) { a.f[c] = v; return chain },
        neq (c, v) { a.f['neq_' + c] = v; return chain },
        not () { return chain }, or () { return chain },
        in (c, v) { a.f['in_' + c] = v; return chain },
        gte () { return chain }, lte () { return chain }, order () { return chain },
        limit () { return Promise.resolve(rep()) },
        range (from) { return Promise.resolve(from === 0 ? rep() : { data: [], error: null }) },
        maybeSingle () {
          if (a.update) { etat.ecritures.push(a); return Promise.resolve({ data: null, error: erreurUpdate }) }
          if (table === 'profiles') {
            // Le profil de l'APPELANT (délégué) se distingue de la CIBLE par
            // le filtre : la cible est demandée par son `id`.
            if (a.f.id) return Promise.resolve({ data: erreurCible ? null : cible, error: erreurCible })
            return Promise.resolve({ data: profil, error: null })
          }
          if (table === 'profile_permissions') {
            // ⚠ LES DEUX LECTURES PASSENT PAR `profile_id` : celle des droits
            // de l'APPELANT (son profil de membre) et celle du droit
            // d'absences de la CIBLE. On les distingue par la VALEUR, sinon le
            // double rend les droits de la prestataire à `requirePermission`
            // et tout délégué se voit refuser.
            if (profil && a.f.profile_id === profil.id) {
              return Promise.resolve({ data: permissions, error: null })
            }
            return Promise.resolve({ data: erreurDroits ? null : droitsPresta, error: erreurDroits })
          }
          if (table === 'public_tokens') return Promise.resolve({ data: erreurJeton ? null : jeton, error: erreurJeton })
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
  for (const mod of ['../lib/require-permission', '../lib/permissions', '../api/menages']) {
    try { delete require.cache[require.resolve(mod)] } catch {}
  }
  return { handler: require('../api/menages'), etat }
}

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  return r
}
const get = (id = REGINA, entetes = {}) => ({ method: 'GET', query: { presta: id },
  headers: { authorization: 'Bearer jeton', ...entetes } })
const post = (body, entetes = {}) => ({ method: 'POST', query: {}, body,
  headers: { authorization: 'Bearer jeton', ...entetes } })

const LIAISON = (o = {}) => ({ property_id: BIEN, rang: 1, requires_ack: true,
                               weekdays: [2, 3], active: true, ...o })
const DELEGUE = {
  user: MEMBRE,
  profil: { id: 'pr1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' }
}
const ENTETE_COMPTE = { 'x-compte': PROD }

// ─── Ce que la fiche rend ───────────────────────────────────────────────────

test('la fiche rend l\'identité, les biens, les liaisons et les réglages du lien', async () => {
  const { handler } = preparer({ liaisons: [LIAISON()] })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.personne.prenom, 'Régina')
  assert.strictEqual(res.body.personne.nom, 'M.')
  assert.strictEqual(res.body.personne.tel, '+33600000000')
  assert.strictEqual(res.body.personne.notify_sms, true)
  assert.strictEqual(res.body.personne.notify_email, false)
  assert.strictEqual(res.body.personne.self_availability, 'write')
  assert.strictEqual(res.body.personne.vue_le, '2026-10-13T18:09:00Z')
  assert.deepStrictEqual(res.body.biens.map(b => b.nom), ['La bulle', 'Colomiers'])
  assert.deepStrictEqual(res.body.liaisons, [{ property_id: BIEN, rang: 1, requires_ack: true,
                                               weekdays: [2, 3], active: true }])
  assert.deepStrictEqual(res.body.lien, { visibility_days: 60, ratio_periode: '30j' })
  assert.deepStrictEqual(res.body.collegues, [{ id: LENA, prenom: 'Lena', nom: 'Lou', actif: false }])
})

test('LE JETON NE SORT JAMAIS — il ne s\'obtient que par /api/membres action:lien', async () => {
  // Son lien est son mot de passe. Le poser dans le DOM à chaque ouverture de
  // fiche l'exposerait à toute capture d'écran, pour un geste fait une fois.
  const { handler } = preparer({ liaisons: [LIAISON()] })
  const res = reponse()
  await handler(get(), res)
  assert.ok(!JSON.stringify(res.body).includes('tok-secret'))
  assert.strictEqual(res.body.personne.a_un_lien, true, 'mais l\'écran sait qu\'un lien existe')
})

test('les liaisons INACTIVES sortent, avec leur drapeau', async () => {
  // Sans elles, le rang et les jours d'un bien qu'on vient de retirer seraient
  // perdus à la première réouverture de la fiche — en silence.
  const { handler } = preparer({ liaisons: [LIAISON(), LIAISON({ property_id: BIEN2, active: false, rang: 2, weekdays: [6] })] })
  const res = reponse()
  await handler(get(), res)
  const off = res.body.liaisons.find(l => l.property_id === BIEN2)
  assert.strictEqual(off.active, false)
  assert.deepStrictEqual(off.weekdays, [6], 'ses jours sont gardés')
  assert.strictEqual(off.rang, 2)
})

test('les trois états de `weekdays` traversent sans être confondus', async () => {
  const { handler } = preparer({ liaisons: [
    LIAISON({ property_id: BIEN, weekdays: null }),
    LIAISON({ property_id: BIEN2, weekdays: [] })
  ] })
  const res = reponse()
  await handler(get(), res)
  const parId = Object.fromEntries(res.body.liaisons.map(l => [l.property_id, l]))
  assert.strictEqual(parId[BIEN].weekdays, null, 'null = tous les jours')
  assert.deepStrictEqual(parId[BIEN2].weekdays, [], '[] = aucun jour, et ce n\'est pas null')
})

// ─── Les droits ─────────────────────────────────────────────────────────────

test('sans `prestataires: read`, la fiche est REFUSÉE', async () => {
  const { handler } = preparer({
    ...DELEGUE,
    permissions: { menages: 'read', prestataires: 'none', avis: 'none', property_scope: 'all' },
    liaisons: [LIAISON()]
  })
  const res = reponse()
  await handler(get(REGINA, ENTETE_COMPTE), res)
  assert.strictEqual(res.code, 403)
})

test('la réponse DIT ce que l\'appelant peut écrire — `equipe` est non délégable', async () => {
  // L'identité, les contacts, les canaux, le droit d'absences et le retrait
  // passent par `/api/membres`, qui exige `equipe: write` NON DÉLÉGABLE. Un
  // délégué ne doit pas voir ces boutons : ils seraient refusés.
  const { handler } = preparer({
    ...DELEGUE,
    permissions: { menages: 'read', prestataires: 'write', avis: 'read', equipe: 'write', property_scope: 'all' },
    liaisons: [LIAISON()]
  })
  const res = reponse()
  await handler(get(REGINA, ENTETE_COMPTE), res)
  assert.strictEqual(res.body.droits.prestataires, 'write')
  assert.strictEqual(res.body.droits.equipe, 'none', 'même écrit en base, `equipe` ne se délègue pas')
  assert.strictEqual(res.body.droits.avis, 'read')
})

test('le titulaire a tout, sans passer par un profil', async () => {
  const { handler } = preparer({ liaisons: [LIAISON()] })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.body.droits.equipe, 'write')
  assert.strictEqual(res.body.droits.prestataires, 'write')
})

test('le PÉRIMÈTRE de l\'appelant borne les biens ET les liaisons', async () => {
  const { handler, etat } = preparer({
    ...DELEGUE,
    permissions: { menages: 'read', prestataires: 'read', property_scope: 'selected',
                   property_ids: [BIEN], property_refs: [BIEN] },
    liaisons: [LIAISON()]
  })
  const res = reponse()
  await handler(get(REGINA, ENTETE_COMPTE), res)
  assert.strictEqual(res.code, 200)
  const qBiens = etat.lectures.find(l => l.table === 'properties')
  const qLiens = etat.lectures.find(l => l.table === 'property_cleaning_providers')
  assert.deepStrictEqual(qBiens.f.in_provider_property_id, [BIEN], 'les biens sont bornés DANS LA REQUÊTE')
  assert.deepStrictEqual(qLiens.f.in_property_id, [BIEN], 'les liaisons aussi')
})

test('un périmètre VIDE ne montre rien, et ne lit rien', async () => {
  const { handler, etat } = preparer({
    ...DELEGUE,
    permissions: { menages: 'read', prestataires: 'read', property_scope: 'selected',
                   property_ids: [], property_refs: [] },
    liaisons: [LIAISON()]
  })
  const res = reponse()
  await handler(get(REGINA, ENTETE_COMPTE), res)
  assert.strictEqual(res.code, 200)
  assert.deepStrictEqual(res.body.biens, [])
  assert.strictEqual(etat.lectures.some(l => l.table === 'property_cleaning_providers'), false)
})

test('un identifiant d\'un AUTRE compte rend 404, pas 403', async () => {
  // Un 403 apprendrait que ce profil existe. Même règle que `/api/membres`.
  const { handler } = preparer({ cible: null })
  const res = reponse()
  await handler(get('ffff9999-9999-4999-8999-999999999999'), res)
  assert.strictEqual(res.code, 404)
})

// ─── « Non lu » n'est pas « valeur par défaut » ─────────────────────────────

test('une panne de lecture du lien rend `lien: null`, pas 30 jours', async () => {
  // Afficher le défaut ferait croire à l'hôte qu'il a réglé ce qu'il n'a pas
  // réglé — et l'enregistrement suivant l'écrirait pour de bon.
  const { handler } = preparer({ liaisons: [LIAISON()], erreurJeton: { message: 'timeout' } })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.code, 200, 'la fiche s\'ouvre quand même')
  assert.strictEqual(res.body.lien, null)
})

test('une panne de lecture du droit d\'absences rend `null` — la case se grisera', async () => {
  // Un simple timeout révoquait sinon définitivement un droit que personne
  // n'avait touché.
  const { handler } = preparer({ liaisons: [LIAISON()], erreurDroits: { message: 'timeout' } })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.body.personne.self_availability, null)
})

test('une panne des BIENS ou des LIAISONS coupe : une fiche fausse est pire', async () => {
  // Sans les biens, chaque bien paraîtrait non confié ; sans les liaisons,
  // tous les interrupteurs paraîtraient éteints — et le premier enregistrement
  // retirerait pour de vrai ce que l'écran montrait éteint.
  for (const panne of [{ erreurBiens: { message: 'x' } }, { erreurLiaisons: { message: 'x' } }]) {
    const { handler } = preparer({ liaisons: [LIAISON()], ...panne })
    const res = reponse()
    await handler(get(), res)
    assert.strictEqual(res.code, 503)
  }
})

// ─── POST reglages_lien ─────────────────────────────────────────────────────

test('les réglages du lien s\'écrivent par le SERVEUR, filtrés compte ET jeton', async () => {
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post({ action: 'reglages_lien', provider_id: REGINA, visibility_days: 90 }), res)
  assert.strictEqual(res.code, 200)
  const w = etat.ecritures.find(e => e.table === 'public_tokens')
  assert.deepStrictEqual(w.update, { visibility_days: 90 })
  assert.strictEqual(w.f.user_id, PROD, 'le compte est la seule défense de ce chemin')
  assert.strictEqual(w.f.token, 'tok-secret')
})

test('les deux réglages partent ensemble si les deux sont envoyés', async () => {
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post({ action: 'reglages_lien', provider_id: REGINA,
                       visibility_days: 7, ratio_periode: '6mois' }), res)
  assert.strictEqual(res.code, 200)
  assert.deepStrictEqual(etat.ecritures.find(e => e.table === 'public_tokens').update,
    { visibility_days: 7, ratio_periode: '6mois' })
})

test('une valeur hors liste est REFUSÉE, et rien n\'est écrit', async () => {
  // `ratio_periode` porte un CHECK en base : sans ce refus, l'écran afficherait
  // un message Postgres. Et 45 jours n'est pas une option de l'écran.
  for (const corps of [{ visibility_days: 45 }, { ratio_periode: '3mois' }, { visibility_days: 'tout' }]) {
    const { handler, etat } = preparer({})
    const res = reponse()
    await handler(post({ action: 'reglages_lien', provider_id: REGINA, ...corps }), res)
    assert.strictEqual(res.code, 400, JSON.stringify(corps))
    assert.strictEqual(etat.ecritures.length, 0)
  }
})

test('un corps SANS réglage n\'est pas un succès', async () => {
  // Il viendrait d'un écran qui croit avoir envoyé quelque chose : le lui
  // confirmer cacherait le défaut.
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post({ action: 'reglages_lien', provider_id: REGINA }), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('un profil DÉSACTIVÉ refuse les réglages : il n\'a plus de ligne de lien', async () => {
  // L'update toucherait zéro ligne et l'écran annoncerait un succès vide.
  const { handler, etat } = preparer({ cible: { ...PROFIL_REGINA, active: false } })
  const res = reponse()
  await handler(post({ action: 'reglages_lien', provider_id: REGINA, visibility_days: 30 }), res)
  assert.strictEqual(res.code, 409)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('sans `prestataires: write`, aucun réglage ne s\'écrit', async () => {
  const { handler, etat } = preparer({
    ...DELEGUE,
    permissions: { menages: 'read', prestataires: 'read', property_scope: 'all' }
  })
  const res = reponse()
  await handler(post({ action: 'reglages_lien', provider_id: REGINA, visibility_days: 30 },
                     ENTETE_COMPTE), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('une panne d\'écriture le DIT, elle ne confirme pas un enregistrement', async () => {
  const { handler } = preparer({ erreurUpdate: { message: 'timeout' } })
  const res = reponse()
  await handler(post({ action: 'reglages_lien', provider_id: REGINA, visibility_days: 30 }), res)
  assert.strictEqual(res.code, 503)
})
