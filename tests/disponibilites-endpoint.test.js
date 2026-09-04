// tests/disponibilites-endpoint.test.js
// api/disponibilites.js — quand une prestataire est là (lot 3.5, spec §12).
//
// ⚠ CE QUI EST EN JEU. Ces deux tables décident QUI reçoit un ménage : une règle
// posée sur la mauvaise personne, ou lue sans son compte, envoie quelqu'un qui
// n'est pas là — ou retire du planning quelqu'un qui l'est. Trois fautes visées :
//   1. écrire les congés d'une prestataire d'un AUTRE compte (REVIEW.md règle 11) ;
//   2. accepter une chaîne RRULE venue du client (§2 de la spec : jamais) ;
//   3. supprimer une règle au lieu de la désactiver — l'historique d'assignation
//      s'appuie dessus.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const PROD = 'compte-prod'
const MARIE = 'bbbb2222-2222-4222-8222-222222222222'
const AUTRE = 'cccc3333-3333-4333-8333-333333333333'

function preparer ({ user = PROD, profil = { id: MARIE, first_name: 'Marie', active: true },
                     regles = [], exceptions = [], erreurRegles = null } = {}) {
  const etat = { ecritures: [], lectures: [], filtres: [] }
  const client = {
    auth: { getUser: async () => (user ? { data: { user: { id: user } }, error: null }
                                      : { data: null, error: { message: 'x' } }) },
    from (table) {
      const a = { table, f: {} }
      etat.lectures.push(a)
      // ⚠ LE DOUBLE PROJETTE LES COLONNES DEMANDÉES, comme PostgREST. Sans cela,
      // retirer une colonne du `select` — ou en ajouter une qui n'a rien à faire
      // dans une réponse, comme la chaîne RRULE — ne casserait aucun test.
      const projeter = lignes => (lignes || []).map(l => {
        if (!a.cols) return l
        const gardees = a.cols.split(',').map(c => c.trim())
        return Object.fromEntries(Object.entries(l).filter(([k]) => gardees.includes(k)))
      })
      const chain = {
        select (cols) { a.cols = cols; return chain },
        eq (c, v) { a.f[c] = v; return chain },
        gte (c, v) { a.f[c + '_gte'] = v; return chain },
        order () { return chain },
        limit () {
          if (table === 'provider_availability_rules') {
            return Promise.resolve({ data: projeter(regles), error: erreurRegles })
          }
          if (table === 'provider_availability_exceptions') {
            return Promise.resolve({ data: projeter(exceptions), error: null })
          }
          return Promise.resolve({ data: [], error: null })
        },
        insert (row) {
          etat.ecritures.push({ table, op: 'insert', row, f: a.f })
          return { select: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'r1', ...row }, error: null }) }) }
        },
        upsert (row, opts) {
          etat.ecritures.push({ table, op: 'upsert', row, opts, f: a.f })
          return { select: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'e1', ...row }, error: null }) }) }
        },
        update (row) {
          const q = { table, op: 'update', row, f: {} }
          const c2 = {
            eq (c, v) { q.f[c] = v; return c2 },
            select () { etat.ecritures.push(q); return Promise.resolve({ data: [{ id: 'r1' }], error: null }) }
          }
          return c2
        },
        delete () {
          const q = { table, op: 'delete', f: {} }
          const c2 = {
            eq (c, v) { q.f[c] = v; return c2 },
            select () { etat.ecritures.push(q); return Promise.resolve({ data: [{ id: 'e1' }], error: null }) }
          }
          return c2
        },
        maybeSingle () {
          if (table === 'profiles') {
            // ⚠ LES FILTRES SONT HONORÉS. Un double qui rend le profil quels que
            // soient les `.eq()` rendrait indétectable le retrait de
            // `.eq('account_user_id')` — la seule garde qui empêche d'écrire les
            // congés d'une prestataire d'un autre compte.
            const bon = a.f.account_user_id === PROD && a.f.access_mode === 'lien' &&
                        a.f.id === MARIE
            return Promise.resolve({ data: bon ? profil : null, error: null })
          }
          if (table === 'profile_permissions') return Promise.resolve({ data: null, error: null })
          return Promise.resolve({ data: null, error: null })
        },
        then (ok) { return Promise.resolve({ data: [], error: null }).then(ok) }
      }
      return chain
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of ['../lib/require-permission', '../lib/permissions', '../api/disponibilites']) {
    try { delete require.cache[require.resolve(mod)] } catch {}
  }
  return { handler: require('../api/disponibilites'), etat }
}

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  return r
}
const get = (q = {}) => ({ method: 'GET', query: { provider_id: MARIE, ...q },
                           headers: { authorization: 'Bearer jeton' } })
const post = (body = {}) => ({ method: 'POST', query: {},
                               body: { provider_id: MARIE, ...body },
                               headers: { authorization: 'Bearer jeton' } })

// ─── Les droits ────────────────────────────────────────────────────────────

test('sans session : 401, et aucune lecture', async () => {
  const { handler, etat } = preparer({ user: null })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.code, 401)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('une méthode non prévue est refusée avant tout', async () => {
  const { handler } = preparer({})
  const res = reponse()
  await handler({ method: 'DELETE', query: {}, headers: {} }, res)
  assert.strictEqual(res.code, 405)
})

// ─── Le cloisonnement (REVIEW.md règle 11) ─────────────────────────────────

test('un prestataire d\'un AUTRE compte est refusé, sans rien écrire', async () => {
  // ⚠ L'identifiant vient du client : sans cette vérification, un hôte poserait
  // — et lirait — les congés de la prestataire de quelqu'un d'autre en changeant
  // un identifiant dans la requête.
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post({ provider_id: AUTRE, action: 'poserException',
                       date: '2026-09-12', available: false }), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('un identifiant qui n\'est pas un UUID est refusé', async () => {
  for (const id of ['', 'x', '../../etc', '1 OR 1=1']) {
    const { handler, etat } = preparer({})
    const res = reponse()
    await handler(get({ provider_id: id }), res)
    assert.strictEqual(res.code, 400, JSON.stringify(id))
    assert.strictEqual(etat.ecritures.length, 0)
  }
})

test('toute lecture est filtrée par COMPTE et par personne', async () => {
  const { handler, etat } = preparer({})
  await handler(get(), reponse())
  for (const table of ['provider_availability_rules', 'provider_availability_exceptions']) {
    const l = etat.lectures.find(x => x.table === table)
    assert.ok(l, table)
    assert.strictEqual(l.f.user_id, PROD)
    assert.strictEqual(l.f.provider_id, MARIE)
  }
})

// ─── Jamais de RRULE venue du client (§2 de la spec) ───────────────────────

test('l\'hôte envoie des JOURS, le serveur produit la RRULE', async () => {
  // ⚠ Une chaîne acceptée depuis le client serait une expression exécutée par la
  // lib `rrule` sur les données d'un autre compte, et un `COUNT=100000` suffirait
  // à faire tourner le moteur d'assignation pour rien à chaque cycle.
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post({ action: 'poserRegle', jours: [6, 0], toutes_les_n_semaines: 2,
                       depuis: '2026-09-05',
                       rrule: 'RRULE:FREQ=DAILY;COUNT=100000' }), res)
  assert.strictEqual(res.code, 200)
  const e = etat.ecritures.find(x => x.op === 'insert')
  assert.match(e.row.rrule, /FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,SA/)
  assert.ok(!e.row.rrule.includes('COUNT=100000'), 'la chaîne du client est ignorée')
  assert.strictEqual(e.row.user_id, PROD)
  assert.strictEqual(e.row.provider_id, MARIE)
})

test('la règle porte un LIBELLE lisible, construit au serveur', async () => {
  // L'écran ne doit jamais avoir à relire une RRULE pour dire ce qu'elle veut
  // dire — et l'hôte ne voit jamais la chaîne.
  const { handler, etat } = preparer({})
  await handler(post({ action: 'poserRegle', jours: [6, 0], toutes_les_n_semaines: 2 }), reponse())
  const e = etat.ecritures.find(x => x.op === 'insert')
  assert.match(e.row.label, /une semaine sur deux/)
  assert.match(e.row.label, /[Dd]imanche/)
})

test('des jours ou une cadence invalides sont refusés avant écriture', async () => {
  const cas = [
    { jours: [], },
    { jours: [7] },
    { jours: ['samedi'] },
    { jours: [null] },
    { jours: 'lundi' },
    { jours: [1], toutes_les_n_semaines: 0 },
    { jours: [1], toutes_les_n_semaines: 99 },
    { jours: [1], toutes_les_n_semaines: 1.5 }
  ]
  for (const c of cas) {
    const { handler, etat } = preparer({})
    const res = reponse()
    await handler(post({ action: 'poserRegle', ...c }), res)
    assert.strictEqual(res.code, 400, JSON.stringify(c))
    assert.strictEqual(etat.ecritures.length, 0)
  }
})

// ─── Retirer, c'est désactiver ─────────────────────────────────────────────

test('retirer une règle la DÉSACTIVE, elle ne la supprime pas', async () => {
  // ⚠ Une règle supprimée emporterait la raison pour laquelle des ménages passés
  // ont été attribués comme ils l'ont été.
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post({ action: 'retirerRegle', id: '11111111-1111-4111-8111-111111111111' }), res)
  assert.strictEqual(res.code, 200)
  const e = etat.ecritures.find(x => x.table === 'provider_availability_rules')
  assert.strictEqual(e.op, 'update')
  assert.strictEqual(e.row.active, false)
  // Les trois filtres comptent : l'identifiant vient du client.
  assert.strictEqual(e.f.user_id, PROD)
  assert.strictEqual(e.f.provider_id, MARIE)
})

test('une exception, elle, se supprime — et sous les mêmes filtres', async () => {
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post({ action: 'retirerException', id: '11111111-1111-4111-8111-111111111111' }), res)
  assert.strictEqual(res.code, 200)
  const e = etat.ecritures.find(x => x.table === 'provider_availability_exceptions')
  assert.strictEqual(e.op, 'delete')
  assert.strictEqual(e.f.user_id, PROD)
  assert.strictEqual(e.f.provider_id, MARIE)
})

// ─── Les exceptions ────────────────────────────────────────────────────────

test('une exception se pose dans les DEUX sens, et remplace la précédente', async () => {
  // ⚠ Une seule décision par personne et par jour (contrainte SQL) : reposer
  // « pas ce samedi » sur un jour marqué disponible doit CORRIGER, pas échouer —
  // c'est le geste même que ce réglage prévoit.
  for (const available of [true, false]) {
    const { handler, etat } = preparer({})
    const res = reponse()
    await handler(post({ action: 'poserException', date: '2026-09-12', available }), res)
    assert.strictEqual(res.code, 200)
    const e = etat.ecritures.find(x => x.op === 'upsert')
    assert.strictEqual(e.row.available, available)
    assert.strictEqual(e.row.source, 'hote', 'posée par l\'hôte, pas par elle')
    assert.strictEqual(e.opts.onConflict, 'provider_id,date')
  }
})

test('une date illisible ou un sens manquant sont refusés', async () => {
  for (const c of [{ date: 'demain', available: false }, { date: '', available: false },
                   { date: '2026-09-12' }, { date: '2026-09-12', available: 'oui' }]) {
    const { handler, etat } = preparer({})
    const res = reponse()
    await handler(post({ action: 'poserException', ...c }), res)
    assert.strictEqual(res.code, 400, JSON.stringify(c))
    assert.strictEqual(etat.ecritures.length, 0)
  }
})

test('une action inconnue ne fait rien', async () => {
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post({ action: 'toutSupprimer' }), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.ecritures.length, 0)
})

// ─── Ce que la lecture rend ────────────────────────────────────────────────

test('la lecture ne rend JAMAIS la chaîne RRULE', async () => {
  // Elle n'a rien à faire à l'écran : l'hôte règle des cases, et son libellé dit
  // ce que la règle veut dire.
  const { handler } = preparer({
    regles: [{ id: 'r1', label: 'Tous les samedis', active: true,
               rrule: 'DTSTART:20260905T120000Z\nRRULE:FREQ=WEEKLY' }]
  })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.code, 200)
  assert.ok(!JSON.stringify(res.body).includes('FREQ=WEEKLY'), 'la chaîne ne sort pas')
  assert.strictEqual(res.body.regles[0].label, 'Tous les samedis')
})

test('« aucune règle » est DIT, parce que ça veut dire « disponible »', async () => {
  const { handler } = preparer({ regles: [] })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.body.aucune_regle, true)
})

test('une règle DÉSACTIVÉE ne compte pas comme une règle', async () => {
  const { handler } = preparer({ regles: [{ id: 'r1', label: 'x', active: false }] })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.body.aucune_regle, true, 'sinon l\'écran dirait « elle travaille » à tort')
})

test('une PANNE de lecture répond 503, elle ne rend pas une liste vide', async () => {
  // ⚠ Une liste vide veut dire « disponible tous les jours » : la rendre sur une
  // panne ferait croire à l'hôte que sa prestataire n'a aucune contrainte.
  const { handler } = preparer({ erreurRegles: { message: 'timeout' } })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.code, 503)
})

test('la lecture des exceptions a un PLANCHER de date', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW. Triée par date croissante et plafonnée à 500,
  // une lecture sans plancher finit par ne rendre QUE du passé : les congés à
  // venir tombent hors du lot, l'hôte croit qu'elle n'en a déclaré aucun, et il
  // lui confie des ménages sur ses jours d'absence.
  const { handler, etat } = preparer({})
  await handler(get(), reponse())
  const l = etat.lectures.find(x => x.table === 'provider_availability_exceptions')
  assert.ok(l.f.date_gte, 'une borne basse doit être posée')
  assert.ok(l.f.date_gte < new Date().toISOString().slice(0, 10),
    'mais elle garde un peu d\'historique récent')
})

test('un jour envoyé DEUX FOIS ne produit pas un libellé bègue', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW. `construireRrule` déduplique, pas le libellé :
  // `{jours:[1,1,2]}` donnait « Tous les lundi, lundi et mardi », affiché tel
  // quel dans les deux écrans et stocké pour toujours.
  const { handler, etat } = preparer({})
  await handler(post({ action: 'poserRegle', jours: [1, 1, 2] }), reponse())
  const e = etat.ecritures.find(x => x.op === 'insert')
  assert.strictEqual(e.row.label, 'Tous les lundi et mardi')
})
