// tests/menages-public-disponibilites.test.js
// api/menages-public.js — « Mes absences » côté prestataire (lot 3.5).
//
// ⚠ CE QUI EST EN JEU. Cet écran retire quelqu'un du planning : une garde trop
// faible laisse n'importe quel porteur de lien du compte mettre une autre
// personne en congé, et une garde absente sur le SENS de l'exception lui permet
// de se rendre candidate un jour que l'hôte ne lui a pas confié.
//
// Trois règles, et elles se tiennent :
//   1. DOUBLE GARDE : le token identifie la personne, `self_availability` dit si
//      elle gère ses absences. Jamais l'une sans l'autre ;
//   2. elle déclare une ABSENCE, jamais une présence, jamais ses jours attitrés ;
//   3. elle ne défait que ce QU'ELLE a déclaré — pas ce que l'hôte a posé.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const U = 'compte-1', TOKEN = 'marie-x', MARIE = 'p-marie'
const DEMAIN = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
const HIER = new Date(Date.now() - 86400000).toISOString().slice(0, 10)

function preparer ({ profil = { id: MARIE, first_name: 'Marie', active: true },
                     droits = { self_availability: 'write' },
                     exceptions = [], regles = [], conges = [],
                     // Ce que le DELETE d'un congé touche : rien, ou sa ligne.
                     congeSupprime = [{ id: 'c1' }], congeExistant = null,
                     erreurDroits = null, supprime = [{ id: 'e1' }],
                     // Ce qui occupe déjà ce jour-là : rien, sa déclaration, ou
                     // une absence posée par l'hôte.
                     ligneExistante = null } = {}) {
  const etat = { ecritures: [], lectures: [] }
  const client = {
    from (table) {
      const a = { table, f: {} }
      etat.lectures.push(a)
      const chain = {
        select () { return chain },
        eq (c, v) { a.f[c] = v; return chain },
        gte (c, v) { a.f[c + '_gte'] = v; return chain },
        order () { return chain },
        limit () {
          if (table === 'provider_availability_exceptions') {
            return Promise.resolve({ data: exceptions, error: null })
          }
          if (table === 'provider_availability_rules') {
            return Promise.resolve({ data: regles, error: null })
          }
          if (table === 'conges_plages') {
            return Promise.resolve({ data: conges, error: null })
          }
          return Promise.resolve({ data: [], error: null })
        },
        upsert (row, opts) {
          etat.ecritures.push({ table, op: 'upsert', row, opts })
          return { select: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'e1', ...row }, error: null }) }) }
        },
        // ⚠ Le double honore la SEQUENCE update-puis-insert : c'est elle qui
        // empêche de s'approprier — puis d'effacer — une absence posée par
        // l'hôte. Un double qui répondrait « OK » à tout la rendrait indétectable.
        insert (row) {
          etat.ecritures.push({ table, op: 'insert', row })
          const conflit = ligneExistante === 'hote'
          return { select: () => ({ maybeSingle: () => Promise.resolve(
            conflit ? { data: null, error: { code: '23505', message: 'duplicate key' } }
                    : { data: { id: 'e1', ...row }, error: null }) }) }
        },
        update (row) {
          const q = { table, op: 'update', row, f: {} }
          const c2 = {
            eq (c, v) { q.f[c] = v; return c2 },
            select () {
              etat.ecritures.push(q)
              // Elle ne met à jour QUE sa propre ligne (`source = 'prestataire'`).
              const sienne = ligneExistante === 'prestataire' && q.f.source === 'prestataire'
              return Promise.resolve({ data: sienne ? [{ id: 'e1', ...row }] : [], error: null })
            }
          }
          return c2
        },
        delete () {
          const q = { table, op: 'delete', f: {} }
          const c2 = {
            eq (c, v) { q.f[c] = v; return c2 },
            select () { etat.ecritures.push(q)
              return Promise.resolve({ data: table === 'conges_plages' ? congeSupprime : supprime,
                                       error: null }) }
          }
          return c2
        },
        maybeSingle () {
          // Le congé relu après un DELETE qui n'a rien touché : existe-t-il, et
          // à qui est-il ?
          if (table === 'conges_plages') {
            return Promise.resolve({ data: congeExistant ? { id: 'c1' } : null, error: null })
          }
          // Ce qui occupe ce jour-là, relu après un DELETE qui n'a rien touché.
          if (table === 'provider_availability_exceptions') {
            return Promise.resolve({
              data: ligneExistante ? { id: 'e1', source: ligneExistante } : null, error: null })
          }
          if (table === 'public_tokens') {
            return Promise.resolve({ data: a.f.token === TOKEN ? { user_id: U } : null, error: null })
          }
          // ⚠ LES FILTRES SONT HONORÉS : retirer `.eq('pwa_token')` ou
          // `.eq('account_user_id')` doit faire tomber un test, sinon un porteur
          // de lien pourrait se faire passer pour un autre profil.
          if (table === 'profiles') {
            const bon = a.f.account_user_id === U && a.f.pwa_token === TOKEN
            return Promise.resolve({ data: bon ? profil : null, error: null })
          }
          if (table === 'profile_permissions') {
            return Promise.resolve({ data: droits, error: erreurDroits })
          }
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
  for (const mod of ['../api/menages-public', '../lib/stats-avis', '../lib/attribution-prestataire',
                     '../lib/cron-property-status', '../lib/alert-notify']) {
    try { delete require.cache[require.resolve(mod)] } catch {}
  }
  return { handler: require('../api/menages-public'), etat }
}

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = () => {}
  r.end = () => r
  return r
}
const lire = (token = TOKEN) => ({ method: 'GET', query: { token, action: 'disponibilites' }, headers: {} })
const ecrire = (body, token = TOKEN) => ({
  method: 'POST', query: { token }, headers: {},
  body: { action: 'declarerIndisponibilite', ...body }
})

// ─── La double garde ───────────────────────────────────────────────────────

test('un token inconnu : 401, aucune écriture', async () => {
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(ecrire({ date: DEMAIN }, 'jeton-bidon'), res)
  assert.strictEqual(res.code, 401)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('un lien SANS PROFIL ne peut pas mettre quelqu\'un en congé', async () => {
  // ⚠ Un lien de consultation ne désigne personne : il n'y a pas de calendrier
  // dont ce serait celui-là.
  // ⚠ 401 ET NON 403 depuis la fermeture du pont de convergence : le lien est
  // INVALIDE, pas seulement sans droit. Un 403 disait « ton lien marche, mais
  // pas pour ça » — et c'est cette tolérance qui a laissé vivre en production
  // une ligne `public_tokens` orpheline servant 11 séjours.
  const { handler, etat } = preparer({ profil: null })
  const res = reponse()
  await handler(ecrire({ date: DEMAIN }), res)
  assert.strictEqual(res.code, 401)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('un profil DÉSACTIVÉ ne déclare plus rien', async () => {
  const { handler, etat } = preparer({ profil: { id: MARIE, active: false, access_mode: 'lien' } })
  const res = reponse()
  await handler(ecrire({ date: DEMAIN }), res)
  assert.strictEqual(res.code, 401)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('`self_availability` à \'none\' : elle passe par son employeur', async () => {
  const { handler, etat } = preparer({ droits: { self_availability: 'none' } })
  const res = reponse()
  await handler(ecrire({ date: DEMAIN }), res)
  assert.strictEqual(res.code, 403)
  assert.match(res.body.error, /employeur/)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('`self_availability` à \'read\' : elle CONSULTE, elle n\'écrit pas', async () => {
  const { handler, etat } = preparer({ droits: { self_availability: 'read' } })
  const res = reponse()
  await handler(ecrire({ date: DEMAIN }), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.ecritures.length, 0)
  const lect = reponse()
  await handler(lire(), lect)
  assert.strictEqual(lect.body.autorise, true, 'mais elle voit ses absences')
  assert.strictEqual(lect.body.modifiable, false)
})

test('AUCUNE ligne de droits ne vaut PAS autorisation', async () => {
  // ⚠ L'inverse de `self_view_reviews`, et c'est voulu : consulter ses avis ne
  // change rien pour personne, se retirer du planning engage le logement de
  // quelqu'un d'autre. Le défaut est donc 'none'.
  const { handler, etat } = preparer({ droits: null })
  const res = reponse()
  await handler(ecrire({ date: DEMAIN }), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('une PANNE de lecture des droits COUPE, elle n\'ouvre pas', async () => {
  const { handler, etat } = preparer({ erreurDroits: { message: 'timeout' } })
  const res = reponse()
  await handler(ecrire({ date: DEMAIN }), res)
  assert.strictEqual(res.code, 503)
  assert.strictEqual(etat.ecritures.length, 0)
})

// ─── Ce qu'elle déclare, et ce qu'elle ne peut pas déclarer ────────────────

test('elle déclare une ABSENCE, jamais une présence', async () => {
  // ⚠ `available` n'est PAS un paramètre : se rendre disponible un jour que
  // l'hôte ne lui a pas confié n'aurait aucun effet (ses jours attitrés sont sa
  // décision à lui) et lui ferait croire le contraire.
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(ecrire({ date: DEMAIN, available: true }), res)
  assert.strictEqual(res.code, 200)
  const e = etat.ecritures.find(x => x.op === 'insert')
  assert.strictEqual(e.row.available, false, 'toujours une absence')
  assert.strictEqual(e.row.source, 'prestataire')
  assert.strictEqual(e.row.provider_id, MARIE)
  assert.strictEqual(e.row.user_id, U)
})

test('elle ne touche jamais à ses JOURS ATTITRÉS', async () => {
  // Ceux-là vivent sur la liaison, et c'est l'hôte qui les règle : pouvoir s'en
  // retirer lui permettrait de quitter un bien sans qu'il l'apprenne.
  const { handler, etat } = preparer({})
  await handler(ecrire({ date: DEMAIN, weekdays: [], property_id: '209413' }), reponse())
  assert.ok(!etat.ecritures.some(e => e.table === 'property_cleaning_providers'),
    'aucune écriture sur la liaison')
})

test('pas de déclaration dans le PASSÉ', async () => {
  // ⚠ Se retirer d'un jour déjà passé ne veut rien dire, et réécrirait
  // l'historique sur lequel s'appuie l'attribution des remarques de propreté.
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(ecrire({ date: HIER }), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.ecritures.length, 0)
})

test('une date illisible est refusée, et « 2026-13-45 » aussi', async () => {
  // ⚠ Pas de `new Date()` sur une chaîne libre : un mois 13 y devient une date
  // valide, et le jour écrit ne serait pas celui qu'elle a touché.
  for (const d of ['demain', '', '2026-13-45', '2026-02-30', null, '12/09/2026']) {
    const { handler, etat } = preparer({})
    const res = reponse()
    await handler(ecrire({ date: d }), res)
    assert.strictEqual(res.code, 400, JSON.stringify(d))
    assert.strictEqual(etat.ecritures.length, 0)
  }
})

test('reposer SA propre absence ne casse rien', async () => {
  // Un double tap sur un téléphone est le cas normal, pas une erreur à montrer :
  // sa ligne est simplement mise à jour, et aucun insert n'est tenté.
  const { handler, etat } = preparer({ ligneExistante: 'prestataire' })
  const res = reponse()
  await handler(ecrire({ date: DEMAIN }), res)
  assert.strictEqual(res.code, 200)
  const maj = etat.ecritures.find(x => x.op === 'update')
  assert.strictEqual(maj.f.source, 'prestataire')
  assert.ok(!etat.ecritures.some(x => x.op === 'insert'))
})

test('elle ne S\'APPROPRIE PAS une absence posée par l\'hôte', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW, et c'était le plus grave du lot. Un `upsert` sur
  // `(provider_id, date)` met à jour la ligne QUELLE QU'ELLE SOIT et bascule sa
  // `source` à 'prestataire' : l'absence posée par l'hôte devenait la sienne —
  // et comme elle peut retirer ce qui porte sa source, elle pouvait ensuite
  // l'EFFACER en deux gestes, sans qu'il l'apprenne.
  const { handler, etat } = preparer({ ligneExistante: 'hote' })
  const res = reponse()
  await handler(ecrire({ date: DEMAIN }), res)
  assert.strictEqual(res.code, 409)
  assert.match(res.body.error, /employeur/)
  // L'update n'a touché aucune ligne (il vise `source = 'prestataire'`), et
  // l'insert s'est heurté à la contrainte d'unicité : rien n'a changé de main.
  const maj = etat.ecritures.find(x => x.op === 'update')
  assert.strictEqual(maj.f.source, 'prestataire')
  assert.ok(!etat.ecritures.some(x => x.op === 'upsert'),
    'plus aucun upsert nu sur ce chemin')
})

// ─── Ce qu'elle peut défaire ───────────────────────────────────────────────

test('elle retire SON absence', async () => {
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler({ method: 'POST', query: { token: TOKEN }, headers: {},
                  body: { action: 'retirerIndisponibilite', date: DEMAIN } }, res)
  assert.strictEqual(res.code, 200)
  const e = etat.ecritures.find(x => x.op === 'delete')
  assert.strictEqual(e.f.source, 'prestataire', 'seulement ce qu\'elle a déclaré')
  assert.strictEqual(e.f.provider_id, MARIE)
  assert.strictEqual(e.f.user_id, U)
})

test('elle NE PEUT PAS défaire une absence posée par l\'hôte', async () => {
  // ⚠ La lui laisser effacer la remettrait candidate sur un jour dont il l'avait
  // retirée, sans qu'il l'apprenne.
  const { handler } = preparer({ supprime: [], ligneExistante: 'hote' })
  const res = reponse()
  await handler({ method: 'POST', query: { token: TOKEN }, headers: {},
                  body: { action: 'retirerIndisponibilite', date: DEMAIN } }, res)
  assert.strictEqual(res.code, 409)
  assert.match(res.body.error, /employeur/)
})

test('retirer DEUX FOIS la même absence ne ment pas', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW. « Rien à supprimer » n'est pas « ce n'est pas à
  // vous » : sur cette PWA en 3G, un double tap sur « Annuler » annonçait à la
  // prestataire que son employeur avait posé une absence qu'elle venait
  // elle-même de retirer. Plus rien sur ce jour = c'est le résultat qu'elle
  // demandait : succès idempotent.
  const { handler } = preparer({ supprime: [], ligneExistante: null })
  const res = reponse()
  await handler({ method: 'POST', query: { token: TOKEN }, headers: {},
                  body: { action: 'retirerIndisponibilite', date: DEMAIN } }, res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.retiree, true)
})

// ─── Ce qu'elle voit ───────────────────────────────────────────────────────

test('elle voit les DEUX sources, et laquelle est laquelle', async () => {
  // Masquer ce que l'hôte a posé lui ferait croire à un bug le jour où il
  // corrige une de ses déclarations — et c'est le geste que le modèle prévoit.
  const { handler } = preparer({
    exceptions: [{ id: 'e1', date: DEMAIN, available: false, source: 'prestataire' },
                 { id: 'e2', date: DEMAIN, available: false, source: 'hote' }]
  })
  const res = reponse()
  await handler(lire(), res)
  assert.strictEqual(res.body.autorise, true)
  assert.strictEqual(res.body.exceptions.length, 2)
  assert.deepStrictEqual(res.body.exceptions.map(e => e.source), ['prestataire', 'hote'])
})

test('la lecture est BORNÉE au futur', async () => {
  // Sans borne, la PWA d'une prestataire de longue date téléchargerait des
  // années de congés passés sur un téléphone en 3G.
  const { handler, etat } = preparer({})
  await handler(lire(), reponse())
  const l = etat.lectures.find(x => x.table === 'provider_availability_exceptions')
  assert.ok(l.f.date_gte, 'une borne de date doit être posée')
})

test('la PWA ne reçoit JAMAIS la chaîne RRULE, seulement le libellé', async () => {
  const { handler } = preparer({
    regles: [{ id: 'r1', label: 'Tous les samedis', rrule: 'RRULE:FREQ=WEEKLY' }]
  })
  const res = reponse()
  await handler(lire(), res)
  assert.deepStrictEqual(res.body.regles, [{ id: 'r1', label: 'Tous les samedis' }])
  assert.ok(!JSON.stringify(res.body).includes('FREQ=WEEKLY'))
})

test('sans le droit, la lecture répond « non autorisé » sans rien fuir', async () => {
  const { handler } = preparer({ droits: { self_availability: 'none' },
                                 exceptions: [{ id: 'e1', date: DEMAIN, available: false, source: 'hote' }] })
  const res = reponse()
  await handler(lire(), res)
  assert.strictEqual(res.body.autorise, false)
  assert.deepStrictEqual(res.body.exceptions, [])
})

// ─── Ce que la review a trouvé, et qui ne doit plus revenir ────────────────

test('« aujourd\'hui » se lit en heure de PARIS, pas en UTC', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW. Entre minuit et 2 h du matin l'été, l'UTC est
  // encore la veille : la prestataire pouvait déclarer une absence sur un jour
  // déjà passé chez elle, et la liste le lui montrait. `todayInParis()` existait
  // déjà dans ce fichier.
  const source = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'api/menages-public.js'), 'utf8')
  const bloc = source.slice(source.indexOf('async function mesDisponibilites'))
  assert.ok(!bloc.includes("new Date().toISOString().slice(0, 10)"),
    'plus de date UTC dans les gardes de « Mes absences »')
  assert.ok(bloc.includes('todayInParis()'))
})

// ─── Ses congés en PLAGE (15 septembre 2026) ───────────────────────────────

const DANS_UN_MOIS = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)

test('elle voit ses congés, bornés sur la FIN', async () => {
  // ⚠ Un congé commencé le mois dernier et qui court encore doit apparaître.
  // Borné sur `debut`, il disparaîtrait de son écran et elle le reposerait
  // par-dessus, croyant l'avoir perdu.
  const { handler, etat } = preparer({
    conges: [{ id: 'c1', debut: '2026-01-01', fin: DANS_UN_MOIS, motif: 'Congé', source: 'prestataire' }]
  })
  const res = reponse()
  await handler(lire(), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.conges.length, 1)
  const l = etat.lectures.find(x => x.table === 'conges_plages')
  assert.ok(l.f.fin_gte, 'le plancher porte sur `fin`')
  assert.strictEqual(l.f.debut_gte, undefined, 'et surtout PAS sur `debut`')
})

test('elle déclare un congé, marqué à SA source', async () => {
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(ecrire({ action: 'declarerConge', debut: DEMAIN, fin: DANS_UN_MOIS, motif: 'Vacances' }), res)
  const e = etat.ecritures.find(x => x.table === 'conges_plages' && x.op === 'insert')
  assert.ok(e, 'le congé est inséré')
  assert.strictEqual(e.row.source, 'prestataire', 'c\'est ELLE qui déclare')
  assert.strictEqual(e.row.user_id, U)
  assert.strictEqual(e.row.provider_id, MARIE)
})

test('elle ne peut PAS retirer un congé posé par son employeur', async () => {
  // ⚠ MÊME GARDE QUE LES ABSENCES D'UN JOUR. Un congé posé par l'hôte — « tu ne
  // travailles pas cette semaine-là » — n'est pas le sien à défaire : le lui
  // laisser effacer la remettrait candidate sur des jours dont il l'avait
  // retirée, sans qu'il l'apprenne.
  const { handler, etat } = preparer({ congeSupprime: [], congeExistant: 'hote' })
  const res = reponse()
  await handler(ecrire({ action: 'retirerConge', id: 'c1' }), res)
  assert.strictEqual(res.code, 409)
  assert.match(res.body.error, /employeur/)
  const e = etat.ecritures.find(x => x.table === 'conges_plages' && x.op === 'delete')
  assert.strictEqual(e.f.source, 'prestataire', 'le DELETE filtre sur SA source')
})

test('retirer deux fois le même congé reste un SUCCÈS, pas une accusation', async () => {
  // ⚠ Sur un téléphone en 3G, un double tap ne doit pas annoncer que
  // l'employeur a posé un congé qu'elle vient elle-même de retirer.
  const { handler } = preparer({ congeSupprime: [], congeExistant: null })
  const res = reponse()
  await handler(ecrire({ action: 'retirerConge', id: 'c1' }), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.retire, true)
})

test('un congé ENTIÈREMENT passé est refusé, un congé EN COURS passe', async () => {
  const { handler, etat } = preparer({})
  const res = reponse()
  await handler(ecrire({ action: 'declarerConge', debut: '2020-01-01', fin: '2020-01-10' }), res)
  assert.strictEqual(res.code, 400)
  assert.strictEqual(etat.ecritures.filter(x => x.table === 'conges_plages').length, 0)

  // ⚠ La contre-épreuve doit rester DANS le plafond d'un an, sinon elle échoue
  // pour la mauvaise raison — c'est le test qui me l'a appris.
  const ILYA_DIX_JOURS = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10)
  const b = preparer({})
  const res2 = reponse()
  await b.handler(ecrire({ action: 'declarerConge', debut: ILYA_DIX_JOURS, fin: DEMAIN }), res2)
  assert.notStrictEqual(res2.code, 400, 'un congé commencé avant mais qui court encore est légitime')
})

test('sans le droit d\'écriture, elle ne pose aucun congé', async () => {
  const { handler, etat } = preparer({ droits: { self_availability: 'read' } })
  const res = reponse()
  await handler(ecrire({ action: 'declarerConge', debut: DEMAIN, fin: DANS_UN_MOIS }), res)
  assert.strictEqual(res.code, 403)
  assert.strictEqual(etat.ecritures.filter(x => x.table === 'conges_plages').length, 0)
})

test('ses RÈGLES restent en lecture seule — aucune action ne les touche', async () => {
  // ⚠ DÉCISION PRODUIT DU 15 SEPTEMBRE : ses jours de travail sont
  // l'organisation du travail, réglée par l'hôte. Elle déclare ses ABSENCES.
  // Le serveur n'expose aucune action sur les règles : ce test échouerait si
  // quelqu'un en ajoutait une par commodité.
  const { handler, etat } = preparer({})
  for (const a of ['poserRegle', 'retirerRegle', 'declarerRegle']) {
    const res = reponse()
    await handler(ecrire({ action: a, jours: [1, 2] }), res)
    assert.strictEqual(etat.ecritures.filter(x => x.table === 'provider_availability_rules').length, 0,
      `l'action ${a} ne doit rien écrire dans les règles`)
  }
})
