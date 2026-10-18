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
                     regles = [], exceptions = [], conges = [], erreurRegles = null,
                     menages = [], avantRegles = [] } = {}) {
  const etat = { ecritures: [], lectures: [], filtres: [], rpc: [] }
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
          if (table === 'conges_plages') {
            return Promise.resolve({ data: projeter(conges), error: null })
          }
          // ⚠ LES MÉNAGES SONT FILTRÉS COMME PostgREST LE FERAIT : sans honorer
          // `contains('proposee_a')`, le double rendrait les propositions de
          // tout le monde et le test ne dirait plus rien du cloisonnement.
          if (table === 'menages') {
            const vise = a.f.contains_proposee_a
            return Promise.resolve({ data: projeter((menages || []).filter(m =>
              (!a.f.user_id || m.user_id === a.f.user_id) &&
              (!vise || (m.proposee_a || []).map(String).includes(String(vise))))), error: null })
          }
          return Promise.resolve({ data: [], error: null })
        },
        contains (c, v) { a.f['contains_' + c] = Array.isArray(v) ? v[0] : v; return chain },
        lte (c, v) { a.f[c + '_lte'] = v; return chain },
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
            // Les filtres de la reprise d'une proposition : ils se notent, parce
            // que leur ABSENCE est exactement ce qu'un test doit pouvoir voir.
            contains (c, v) { q.f['contains_' + c] = v; return c2 },
            containedBy (c, v) { q.f['containedBy_' + c] = v; return c2 },
            is (c, v) { q.f['is_' + c] = v; return c2 },
            select () { etat.ecritures.push(q); return Promise.resolve({ data: [{ id: q.f.id || 'r1' }], error: null }) }
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
            const bon = a.f.account_user_id === PROD && a.f.id === MARIE &&
                        (a.f.access_mode === 'lien' || a.cols === 'first_name')
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
  // ⚠ LE REMPLACEMENT DES JOURS PASSE PAR UNE FONCTION POSTGRES, pas par des
  // écritures de table : sans `rpc`, le double ferait échouer le geste au lieu
  // de le jouer.
  client.rpc = async (nom, args) => {
    etat.rpc.push({ nom, args })
    return { data: { avant: avantRegles, posees: (args.p_regles || []).length }, error: null }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of ['../lib/require-permission', '../lib/permissions', '../api/disponibilites',
                     // ⚠ CELUI-CI AUSSI : il crée son propre client au chargement.
                     // Sans le purger, il garderait celui d'un test précédent.
                     '../lib/cleaning/apres-changement-regles', '../lib/cleaning/regles',
                     '../lib/alert-notify']) {
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

// ⚠ DATE RELATIVE, ET C'EST LA RÈGLE DU DÉPÔT : ce chemin LIT L'HORLOGE depuis
// que `poserException` borne les dates (J−30 → J+400). Une fixture figée au
// 12 septembre 2026 passait à l'écriture de ce test et refusait un mois plus
// tard — la cinquième famille de rouges calendaires, évitée à sa source.
const dansNJours = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)

// ⚠ LE MOIS DEMANDÉ SUIT L'HORLOGE, LUI AUSSI (17 octobre 2026). Ces tests
// demandaient `mois: MOIS` avec des congés figés au même mois : cohérents
// entre eux, mais pas avec le calendrier. `api/disponibilites.js` ne calcule
// que des mois À VENIR — au 16 décembre, novembre est derrière, la réponse ne
// porte plus ces jours-là, et trois tests tombent. La contre-épreuve à horloge
// décalée (`tests/outils/horloge-decalee.js`) les a vus rougir à J+30, J+60 et
// J+90 alors qu'ils étaient verts le jour même : c'est exactement la dette des
// 28, prise AVANT qu'elle coûte.
//
// ⚠ LE MOIS PROCHAIN, PAS LE MOIS COURANT : entier, et toujours devant, quel
// que soit le jour où la suite tourne. Un test qui passe le 1er et tombe le 28
// est pire qu'un test rouge.
const MOIS = (() => {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  d.setMonth(d.getMonth() + 1, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
})()
const DANS_LE_MOIS = (j) => `${MOIS}-${String(j).padStart(2, '0')}`
// Le SECOND mois rendu, et sa longueur : le calendrier en sert toujours deux.
// ⚠ On ne compte pas « 30 + 31 » à la main — février, et les années
// bissextiles, auraient fait tomber le test deux fois par an.
const nbJours = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate()
const MOIS_2 = (() => {
  const d = new Date(Date.UTC(Number(MOIS.slice(0, 4)), Number(MOIS.slice(5, 7)), 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
})()
const DERNIER_JOUR = `${MOIS_2}-${nbJours(MOIS_2)}`
// ⚠ ET LE JOUR DE LA SEMAINE COMPTE AUTANT QUE LA DATE. Les tests de congé et
// d'exception posent une règle « du lundi au vendredi » puis vérifient qu'un
// jour précis est travaillé ou non : avec un numéro figé (« le 16 »), ils ne
// tenaient que les mois où ce numéro tombe un lundi. La contre-épreuve les a
// vus rougir à J+45 et J+60, verts partout ailleurs — le pire des cas, celui
// qui fait chercher une régression là où il n'y a qu'un calendrier.
const LUNDI = (n) => {
  const d = new Date(Date.UTC(Number(MOIS.slice(0, 4)), Number(MOIS.slice(5, 7)) - 1, 1, 12))
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1)
  d.setUTCDate(d.getUTCDate() + 7 * (n - 1))
  return d.toISOString().slice(0, 10)
}
const PLUS = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const NB_JOURS_RENDUS = nbJours(MOIS) + nbJours(MOIS_2)

test('une exception se pose dans les DEUX sens, et remplace la précédente', async () => {
  // ⚠ Une seule décision par personne et par jour (contrainte SQL) : reposer
  // « pas ce samedi » sur un jour marqué disponible doit CORRIGER, pas échouer —
  // c'est le geste même que ce réglage prévoit.
  for (const available of [true, false]) {
    const { handler, etat } = preparer({})
    const res = reponse()
    await handler(post({ action: 'poserException', date: dansNJours(7), available }), res)
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

// ─── Les congés en PLAGE (15 septembre 2026) ───────────────────────────────

test('GET rend les congés, bornés sur la FIN et pas sur le début', async () => {
  // ⚠ LE PIÈGE, ET IL EST DATÉ. Un congé commencé en juin qui couvre juillet
  // disparaîtrait de l'écran dès le 1er juillet s'il était filtré sur `debut` —
  // alors qu'il verrouille encore des jours. L'hôte le croirait terminé et
  // confierait des ménages pendant les vacances.
  const { handler, etat } = preparer({
    conges: [{ id: 'c1', debut: '2026-06-01', fin: '2026-07-31', motif: 'Été', source: 'hote' }]
  })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.conges.length, 1)
  const lecture = etat.lectures.find(l => l.table === 'conges_plages')
  assert.ok(lecture, 'la table est bien interrogée')
  assert.ok(lecture.f.fin_gte, 'le plancher porte sur `fin`')
  assert.strictEqual(lecture.f.debut_gte, undefined, 'et surtout PAS sur `debut`')
})

test('GET : les congés sont cloisonnés par compte ET par prestataire', async () => {
  const { handler, etat } = preparer({ conges: [] })
  const res = reponse()
  await handler(get(), res)
  const l = etat.lectures.find(x => x.table === 'conges_plages')
  assert.strictEqual(l.f.user_id, PROD)
  assert.strictEqual(l.f.provider_id, MARIE)
})

test('poserConge enregistre la plage, et la marque « hote »', async () => {
  // ⚠ DATES RELATIVES (2 octobre 2026) : `poserConge` refuse une fin anterieure
  // a J-30 en lisant l'horloge reelle. Figee au 5-12 octobre 2026, la plage
  // devenait « trop ancienne » le 12 novembre — un rouge purement calendaire.
  const enJours = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)
  const debut = enJours(3), fin = enJours(10)
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post({ action: 'poserConge', debut, fin, motif: 'Vacances' }), res)
  assert.strictEqual(res.code, 200)
  const e = etat.ecritures.find(x => x.table === 'conges_plages')
  assert.ok(e, 'une écriture a eu lieu')
  assert.strictEqual(e.row.debut, debut)
  assert.strictEqual(e.row.fin, fin)
  assert.strictEqual(e.row.source, 'hote', 'posé depuis la fiche, pas depuis la PWA')
  assert.strictEqual(e.row.user_id, PROD, 'le compte est écrit, pas déduit')
  assert.strictEqual(e.row.provider_id, MARIE)
})

test('poserConge REFUSE une fin antérieure au début — il ne corrige pas en silence', async () => {
  // ⚠ Inverser pour l'hôte enregistrerait une plage qu'il n'a pas demandée : il
  // croirait poser un congé d'un jour et en poserait un de trois semaines.
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post({ action: 'poserConge', debut: '2026-10-12', fin: '2026-10-05' }), res)
  assert.strictEqual(res.code, 400)
  assert.match(res.body.error, /précède/)
  assert.strictEqual(etat.ecritures.length, 0, 'rien n\'est écrit')
})

test('poserConge refuse une plage absurde — plus d\'un an', async () => {
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post({ action: 'poserConge', debut: '2026-01-01', fin: '2030-01-01' }), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('poserConge refuse des dates illisibles', async () => {
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post({ action: 'poserConge', debut: 'demain', fin: '2026-10-12' }), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('retirerConge filtre sur les TROIS clés, jamais sur le seul identifiant', async () => {
  // ⚠ REVIEW.md règle 11 : l'identifiant vient du client. Sans `user_id` et
  // `provider_id`, il désignerait le congé de n'importe qui.
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post({ action: 'retirerConge', id: 'aaaa1111-1111-4111-8111-111111111111' }), res)
  const e = etat.ecritures.find(x => x.table === 'conges_plages' && x.op === 'delete')
  assert.ok(e, 'une suppression a été tentée')
  assert.strictEqual(e.f.user_id, PROD)
  assert.strictEqual(e.f.provider_id, MARIE)
  assert.ok(e.f.id, 'et l\'identifiant demandé')
})

test('retirerConge refuse un identifiant qui n\'est pas un UUID', async () => {
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post({ action: 'retirerConge', id: 'tout' }), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('poserConge refuse une plage ENTIÈREMENT passée — elle serait indélébile', async () => {
  // ⚠ CONSTAT DE REVIEW. `lire()` borne sur `gte('fin', jourMoins(30))` : une
  // plage terminée avant J−30 s'insère avec succès, n'apparaît dans aucune
  // réponse, et son `id` devient introuvable — donc `retirerConge` est
  // inatteignable depuis l'écran. Une ligne indélébile, créée par un geste qui
  // annonce « enregistré ».
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post({ action: 'poserConge', debut: '2020-01-01', fin: '2020-01-05' }), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('poserConge refuse une plage hors de portée de l\'écran', async () => {
  // ⚠ LA DISTANCE, PAS SEULEMENT LA DURÉE. Le plafond bornait la LONGUEUR de la
  // plage : un congé de cinq jours en 2099 passait, alors que l'écran ne règle
  // qu'un an devant. Même défaut que le précédent, par l'autre bout.
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post({ action: 'poserConge', debut: '2099-01-01', fin: '2099-01-05' }), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('poserConge accepte un congé EN COURS — commencé avant, pas terminé', async () => {
  // Contre-épreuve des deux précédents : les gardes ne doivent pas refuser le cas
  // légitime. Un congé commencé la semaine dernière et qui court encore doit
  // pouvoir être saisi — c'est même le cas où l'hôte rattrape une absence.
  const hier = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  const demain = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(post({ action: 'poserConge', debut: hier, fin: demain }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(etat.ecritures.filter(x => x.table === 'conges_plages').length, 1)
})

test('GET ne rend QUE les règles actives — les désactivées ne mangent pas le plafond', async () => {
  // ⚠ LE CALENDRIER DÉSACTIVE ET REPOSE À CHAQUE CHANGEMENT DE CASE. Les lignes
  // mortes s'accumulent vite, et le plafond de 200 trié par date CROISSANTE
  // finissait par ne rendre que les plus anciennes — toutes inactives. L'écran
  // annonçait alors « aucune règle : disponible tous les jours » pendant que le
  // moteur appliquait les vraies ; et l'enregistrement ne pouvait plus retirer
  // des règles qu'il ne voyait plus, donc chaque geste AJOUTAIT au lieu de
  // remplacer. L'addition définitive que ce code dit empêcher.
  const { handler, etat } = preparer({ regles: [] })
  const res = reponse()
  await handler(get(), res)
  const lecture = etat.lectures.find(l => l.table === 'provider_availability_rules')
  assert.strictEqual(lecture.f.active, true, 'le filtre est posé côté base, pas côté écran')
})

// ─── LE CALENDRIER EST CALCULÉ PAR LE MOTEUR, pas par l'écran ──────────────
//
// ⚠ POURQUOI C'EST LE SERVEUR QUI LE REND. La précédence — congé > exception >
// règle > « aucune règle = disponible », plus « une règle illisible rend
// INDISPONIBLE » — est celle de `lib/cleaning/availability.js`, le code qui
// décide à qui un ménage est attribué. Recopiée dans un navigateur, elle
// divergerait au premier changement du moteur, et l'hôte lirait un calendrier
// qui n'est pas celui du moteur.

test('le calendrier rend DEUX mois à partir du mois demandé', async () => {
  const { handler } = preparer({})
  const res = reponse()
  await handler(get({ mois: MOIS }), res)
  assert.strictEqual(res.body.mois, MOIS)
  assert.strictEqual(res.body.jours[0].date, DANS_LE_MOIS(1))
  assert.strictEqual(res.body.jours.at(-1).date, DERNIER_JOUR)
  assert.strictEqual(res.body.jours.length, NB_JOURS_RENDUS,
    'les deux mois entiers, quelle que soit leur longueur')
})

test('un mois ILLISIBLE retombe sur le mois courant, il ne fait pas tout calculer', async () => {
  // Un `mois=` libre ferait calculer des années de calendrier pour rien.
  const { handler } = preparer({})
  const res = reponse()
  await handler(get({ mois: '2026-13-99' }), res)
  assert.strictEqual(res.body.mois, new Date().toISOString().slice(0, 7))
})

test('aucune règle = DISPONIBLE tous les jours (la règle du moteur)', async () => {
  const { handler } = preparer({ regles: [] })
  const res = reponse()
  await handler(get({ mois: MOIS }), res)
  assert.ok(res.body.jours.every(j => j.dispo === true))
  assert.strictEqual(res.body.aucune_regle, true, 'et l\'écran peut le dire')
})

test('un CONGÉ verrouille le jour, et il le dit — bornes INCLUSES', async () => {
  const { handler } = preparer({
    regles: [{ id: 'r1', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', active: true, source: 'prestataire' }],
    conges: [{ id: 'c1', debut: LUNDI(1), fin: PLUS(LUNDI(1), 6), motif: 'Vacances', source: 'prestataire' }]
  })
  const res = reponse()
  await handler(get({ mois: MOIS }), res)
  const parJour = Object.fromEntries(res.body.jours.map(j => [j.date, j]))
  assert.strictEqual(parJour[LUNDI(1)].dispo, false, 'le premier jour du congé')
  assert.strictEqual(parJour[PLUS(LUNDI(1), 6)].dispo, false, 'ET le dernier : les bornes sont incluses')
  assert.strictEqual(parJour[LUNDI(1)].conge.motif, 'Vacances')
  assert.strictEqual(parJour[LUNDI(1)].conge.source, 'prestataire')
  assert.strictEqual(parJour[LUNDI(2)].dispo, true, 'le lundi suivant, elle retravaille')
})

test('une EXCEPTION tranche dans les DEUX sens, et le congé l\'emporte sur elle', async () => {
  const { handler } = preparer({
    regles: [{ id: 'r1', rrule: 'FREQ=WEEKLY;BYDAY=MO', active: true }],
    exceptions: [{ id: 'e1', date: DANS_LE_MOIS(11), available: true, source: 'prestataire' },
                 { id: 'e2', date: DANS_LE_MOIS(2), available: false, source: 'hote' },
                 { id: 'e3', date: DANS_LE_MOIS(10), available: true, source: 'prestataire' }],
    conges: [{ id: 'c1', debut: DANS_LE_MOIS(10), fin: DANS_LE_MOIS(10), motif: null, source: 'hote' }]
  })
  const res = reponse()
  await handler(get({ mois: MOIS }), res)
  const parJour = Object.fromEntries(res.body.jours.map(j => [j.date, j]))
  assert.strictEqual(parJour[DANS_LE_MOIS(11)].dispo, true, 'un mercredi ouvert à la main, alors qu\'elle ne travaille que le lundi')
  assert.strictEqual(parJour[DANS_LE_MOIS(2)].dispo, false, 'un lundi fermé à la main')
  assert.strictEqual(parJour[DANS_LE_MOIS(10)].dispo, false, 'LE CONGÉ L\'EMPORTE sur une exception « disponible »')
  assert.strictEqual(parJour[DANS_LE_MOIS(11)].exception.source, 'prestataire', 'et l\'écran sait qui l\'a posée')
})

test('une règle ILLISIBLE rend INDISPONIBLE : une panne coupe, elle n\'ouvre pas', async () => {
  // L'ignorer la ferait paraître disponible tous les jours, et on lui
  // assignerait des ménages qu'elle ne peut pas faire — sans que personne ne
  // le sache avant le jour J.
  const { handler } = preparer({ regles: [{ id: 'r1', rrule: 'n importe quoi', active: true }] })
  const res = reponse()
  await handler(get({ mois: MOIS }), res)
  assert.ok(res.body.jours.every(j => j.dispo === false))
})

test('une règle DÉSACTIVÉE ne compte pas : on retombe sur « disponible »', async () => {
  const { handler } = preparer({ regles: [{ id: 'r1', rrule: 'FREQ=WEEKLY;BYDAY=MO', active: false }] })
  const res = reponse()
  await handler(get({ mois: MOIS }), res)
  assert.ok(res.body.jours.every(j => j.dispo === true))
})

test('la RRULE ne sort toujours pas, pas même par le calendrier', async () => {
  const { handler } = preparer({
    regles: [{ id: 'r1', rrule: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=2;DTSTART=20261005', active: true }]
  })
  const res = reponse()
  await handler(get({ mois: MOIS }), res)
  assert.ok(!JSON.stringify(res.body).includes('FREQ='))
})

test('un mois HORS PLAGE ne fabrique pas un calendrier vide', async () => {
  // ⚠ CONSTAT DE LA REVUE DE ac28b1f. `2026-13` passait le motif `\d{4}-\d{2}`,
  // produisait une date invalide, et la boucle ne tournait pas : 200 avec
  // `jours: []`, que l'écran lit comme « elle n'a aucun jour ».
  const { handler } = preparer({})
  for (const mois of ['2026-13', '2026-00', '2026-99']) {
    const res = reponse()
    await handler(get({ mois }), res)
    assert.strictEqual(res.body.mois, new Date().toISOString().slice(0, 7), mois)
    assert.ok(res.body.jours.length >= 59, `${mois} : un vrai calendrier, pas une liste vide`)
  }
})

// ─── LE SENS DU GESTE, QUAND L'HÔTE TOUCHE UN JOUR (étape 1, 14 octobre 2026) ─
//
// ⚠ CE QUI EST EN JEU. Depuis que le calendrier de la fiche se touche, l'écran
// doit choisir entre DEUX gestes contraires : retirer l'exception du jour, ou en
// poser une à l'envers. La réponse ne se devine pas de `dispo` — qui est l'état
// FINAL — mais de ce que le jour vaudrait sans son exception. C'est
// `sans_exception`, calculé par `estDisponible`, le code du moteur.
//
// Sans lui, l'écran pose toujours : basculer un jour puis le rebasculer laisse
// une exception redondante, le jour reste figé « à la main », il survit au
// retrait de la récurrence, et plus rien à l'écran ne l'explique.

test('sans_exception dit ce que le jour vaudrait SANS son exception', async () => {
  const { handler } = preparer({
    // Elle travaille du lundi au vendredi. Le premier lundi porte une absence posée à
    // la main : l'état final est « absente », mais la récurrence dit « là ».
    regles: [{ id: 'r1', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', active: true, source: 'hote' }],
    exceptions: [{ id: 'e1', date: LUNDI(1), available: false, reason: null,
                   source: 'hote', created_at: `${LUNDI(1)}T08:00:00Z` }]
  })
  const res = reponse()
  await handler(get({ mois: MOIS }), res)
  const j = res.body.jours.find(x => x.date === LUNDI(1))
  assert.strictEqual(j.dispo, false, 'l\'état final : absente')
  assert.strictEqual(j.sans_exception, true,
    'mais la récurrence dit « là » — donc la remettre au travail se fait en RETIRANT l\'exception')
})

test('sans exception, sans_exception vaut l\'état du jour', async () => {
  // ⚠ L'ÉCRAN S'APPUIE SUR CETTE ÉGALITÉ pour ne jamais tenter un retrait sur
  // un jour qui n'a rien à retirer : `sans_exception === voulu` est alors
  // toujours faux, et le geste pose.
  const { handler } = preparer({
    regles: [{ id: 'r1', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', active: true, source: 'hote' }]
  })
  const res = reponse()
  await handler(get({ mois: MOIS }), res)
  assert.ok(res.body.jours.every(j => j.sans_exception === j.dispo))
})

test('un jour sous CONGÉ reste indisponible même sans son exception', async () => {
  // ⚠ LE CONGÉ PRIME SUR TOUT, exception comprise. Si `sans_exception` ignorait
  // les congés, il rendrait `true` sur un jour verrouillé : l'écran croirait
  // qu'un retrait suffit à la remettre au travail, et promettrait un geste sans
  // aucun effet. Le bouton est inerte, et la donnée dit la même chose que lui.
  const { handler } = preparer({
    regles: [{ id: 'r1', rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', active: true, source: 'hote' }],
    conges: [{ id: 'c1', debut: DANS_LE_MOIS(9), fin: DANS_LE_MOIS(13), motif: 'Vacances', source: 'prestataire' }],
    exceptions: [{ id: 'e1', date: DANS_LE_MOIS(10), available: true, reason: null,
                   source: 'hote', created_at: '2026-11-02T08:00:00Z' }]
  })
  const res = reponse()
  await handler(get({ mois: MOIS }), res)
  const j = res.body.jours.find(x => x.date === DANS_LE_MOIS(10))
  assert.strictEqual(j.dispo, false)
  assert.strictEqual(j.sans_exception, false, 'le congé tient des deux côtés')
})

test('l\'exception du jour sort avec son IDENTIFIANT et sa trace', async () => {
  // ⚠ SANS L'ID, LE RETRAIT EST IMPOSSIBLE : `retirerException` n'accepte qu'un
  // identifiant, et l'écran ne pourrait que poser l'exception contraire — donc
  // empiler. Sans `created_at`, la fiche ne sait pas dire « Réglé par vous · le
  // … » à côté de « Réglé par elle · le … ».
  const { handler } = preparer({
    exceptions: [{ id: 'e1', date: DANS_LE_MOIS(9), available: false, reason: null,
                   source: 'hote', created_at: '2026-11-02T08:00:00Z' }]
  })
  const res = reponse()
  await handler(get({ mois: MOIS }), res)
  const j = res.body.jours.find(x => x.date === DANS_LE_MOIS(9))
  assert.strictEqual(j.exception.id, 'e1')
  assert.strictEqual(j.exception.source, 'hote')
  assert.strictEqual(j.exception.created_at, '2026-11-02T08:00:00Z')
})

test('poser une exception repose sa DATE DE GESTE', async () => {
  // ⚠ L'UPSERT REMPLACE UNE LIGNE EXISTANTE. Sans `created_at` dans l'écriture,
  // corriger aujourd'hui une absence qu'elle a déclarée le 2 octobre laissait la
  // date du 2 octobre : la fiche affichait « Réglé par vous · 2 octobre » pour
  // un geste fait à l'instant. La source changeait, la date restait à l'autre.
  const { handler, etat } = preparer({})
  const avant = Date.now()
  await handler(post({ action: 'poserException', date: DANS_LE_MOIS(9), available: false }), reponse())
  const e = etat.ecritures.find(x => x.table === 'provider_availability_exceptions')
  assert.strictEqual(e.op, 'upsert')
  assert.strictEqual(e.row.source, 'hote')
  assert.ok(e.row.created_at, 'la date du geste part avec l\'écriture')
  const pose = Date.parse(e.row.created_at)
  assert.ok(pose >= avant && pose <= Date.now() + 1000, 'et c\'est bien MAINTENANT')
})

test('une exception HORS DE PORTÉE de l\'écran est refusée, des deux côtés', async () => {
  // ⚠ UNE LIGNE QU'ON NE POURRA NI VOIR NI RETIRER. `lire()` ne rend les
  // exceptions que depuis `gte('date', jourMoins(30))` : une exception posée
  // plus tôt est insérée avec succès, n'apparaît dans aucune réponse, son `id`
  // n'est jamais rendu — et `retirerException`, qui n'accepte qu'un id, devient
  // inatteignable. Une ligne indélébile, créée par un geste qui annonce
  // « enregistré ». `poserConge` portait déjà les deux gardes ; celui-ci non.
  // ⚠ ET LA GARDE ÉTAIT CÔTE ÉCRAN SEULEMENT, en heure LOCALE du navigateur :
  // un hôte à UTC−8 à 18 h est déjà le lendemain à Paris.
  for (const date of [dansNJours(-31), dansNJours(-400), dansNJours(401)]) {
    const { handler, etat } = preparer({})
    const res = reponse()
    await handler(post({ action: 'poserException', date, available: false }), res)
    assert.strictEqual(res.code, 400, date)
    assert.strictEqual(etat.ecritures.length, 0, `${date} : rien n'est écrit`)
  }
  // Et la fenêtre utile reste ouverte — hier, aujourd'hui, dans un an.
  for (const date of [dansNJours(-1), dansNJours(0), dansNJours(365)]) {
    const { handler } = preparer({})
    const res = reponse()
    await handler(post({ action: 'poserException', date, available: false }), res)
    assert.strictEqual(res.code, 200, date)
  }
})


// ─── Remplacer ses jours REPREND les propositions des jours retirés ────────
// (constat de la revue de 70f805d)

const RRULE_SAMEDI = 'DTSTART:20261012T120000Z\nRRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=SA'
const RRULE_LUNDI = 'DTSTART:20261012T120000Z\nRRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO'
// ⚠ UN SAMEDI À VENIR, CALCULÉ — pas une date figée. Le rattrapage ne regarde
// que les départs devant lui : une date en dur rendrait ce test rouge tout seul
// le jour où elle passe.
const prochain = (dow) => {
  const d = new Date(Date.now() + 86400000)
  while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

test('l\'hôte retire le samedi : la proposition du samedi revient au moteur', async () => {
  // ⚠ LE TROU QUE CE TEST FERME. Ce rattrapage n'existait que pour la PWA. Depuis
  // que l'hôte remplace les mêmes jours depuis la fiche — et c'est devenu le
  // chemin le plus fréquent — il retirait le samedi pendant qu'une proposition
  // du samedi suivant restait chez quelqu'un dont il venait de dire qu'elle ne
  // vient plus ce jour-là.
  const { handler, etat } = preparer({
    avantRegles: [{ id: 'av1', rrule: RRULE_SAMEDI }],
    menages: [{ id: 'm1', user_id: PROD, property_id: '101', departure_date: prochain(6),
                status: 'proposed', provider_id: null, offered_to: MARIE,
                proposee_a: [MARIE], assigned_by: null }]
  })
  const res = reponse()
  await handler(post({ action: 'reglerJours', toutes_les_n_semaines: 1,
                       lots: [{ jours: [1], ancre: '2026-10-12' }] }), res)

  assert.strictEqual(res.code, 200, 'les jours sont enregistrés')
  assert.strictEqual(etat.rpc.length, 1, 'un seul aller-retour pour le remplacement')
  const reprise = etat.ecritures.find(e => e.table === 'menages' && e.op === 'update')
  assert.ok(reprise, 'la proposition du samedi est rendue au moteur')
  assert.strictEqual(reprise.row.proposee_a, null, 'elle sort du tour')
  assert.strictEqual(reprise.row.status, 'unassigned', 'et le ménage redevient à attribuer')
  assert.match(String(reprise.row.assignment_reason), /fiche/,
    'la raison nomme le bon auteur : c\'est l\'hôte qui a retiré ce jour, pas elle')
  assert.strictEqual(reprise.f.user_id, PROD, 'l\'écriture reste cloisonnée au compte')
})

test('un jour CONSERVÉ ne fait reprendre aucune proposition', async () => {
  const { handler, etat } = preparer({
    avantRegles: [{ id: 'av1', rrule: RRULE_SAMEDI }],
    menages: [{ id: 'm1', user_id: PROD, property_id: '101', departure_date: prochain(6),
                status: 'proposed', provider_id: null, offered_to: MARIE,
                proposee_a: [MARIE], assigned_by: null }]
  })
  const res = reponse()
  await handler(post({ action: 'reglerJours', toutes_les_n_semaines: 1,
                       lots: [{ jours: [6], ancre: '2026-10-12' }] }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(etat.ecritures.filter(e => e.table === 'menages').length, 0,
    'rien n\'a changé pour elle : on ne touche à rien')
})

test('un ménage qu\'elle PORTE déjà n\'est jamais repris', async () => {
  // ⚠ UN ENGAGEMENT NE SE DÉFAIT PAS PAR UN CALCUL. Elle a dit oui, quelqu'un
  // compte dessus : seul un humain peut revenir dessus.
  const { handler, etat } = preparer({
    avantRegles: [{ id: 'av1', rrule: RRULE_SAMEDI }],
    menages: [{ id: 'm1', user_id: PROD, property_id: '101', departure_date: prochain(6),
                status: 'assigned', provider_id: MARIE, offered_to: null,
                proposee_a: [MARIE], assigned_by: null }]
  })
  const res = reponse()
  await handler(post({ action: 'reglerJours', toutes_les_n_semaines: 1,
                       lots: [{ jours: [1], ancre: '2026-10-12' }] }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(etat.ecritures.filter(e => e.table === 'menages').length, 0,
    'le ménage accepté reste le sien')
})

test('le remplacement répond 200 même si la reprise échoue', async () => {
  // ⚠ LES JOURS SONT DÉJÀ EN BASE QUAND ON ARRIVE LÀ. Faire échouer la réponse
  // pour un rattrapage raté ferait recommencer un geste déjà enregistré.
  const { handler } = preparer({
    avantRegles: [{ id: 'av1', rrule: RRULE_LUNDI }],
    menages: null   // la lecture des ménages lèvera
  })
  const res = reponse()
  await handler(post({ action: 'reglerJours', toutes_les_n_semaines: 1,
                       lots: [{ jours: [2], ancre: '2026-10-12' }] }), res)
  assert.strictEqual(res.code, 200)
})
