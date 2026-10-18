// tests/garde-endpoint.test.js
// api/garde.js — l'écran « Planning de garde » (lot 3.4, spec §12.6).
//
// ⚠ CE QUI EST EN JEU. Cet écran répond à « mes logements sont-ils couverts ».
// Trois fautes le rendraient pire qu'inutile :
//   1. dire « couvert » sur un jour qui ne l'est pas — ou l'inverse, peindre en
//      rouge des jours sans ménage jusqu'à ce que l'hôte cesse de regarder ;
//   2. montrer les prénoms du personnel à un propriétaire délégué qui n'a que
//      `menages: read` ;
//   3. afficher une garde calculée sur des liaisons ou des disponibilités
//      partiellement lues — un écran faux, qu'on ne rouvre pas.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const PROD = '11111111-1111-4111-8111-111111111111'
const MEMBRE = '22222222-2222-4222-8222-222222222222'
const REGINA = 'p-regina', SECONDE = 'p-seconde'
const BIEN = '209413'

// Lundi 7 au dimanche 13 septembre 2026.
const DU = '2026-09-07', AU = '2026-09-13'
// ⚠ Une semaine RÉELLEMENT passée, quelle que soit l'horloge : le retour de
// propreté ne s'affiche que sur un ménage dont le séjour a eu lieu.
const HIER = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10)
const PASSE = { du: new Date(Date.now() - 9 * 86400000).toISOString().slice(0, 10),
                au: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10) }

function preparer ({ user = PROD, profil = null, permissions = null,
                     biens = [{ provider_property_id: BIEN, name: 'La bulle' }],
                     liaisons = [], regles = [], exceptions = [], menages = [],
                     profils = [{ id: REGINA, first_name: 'Régina', active: true },
                                { id: SECONDE, first_name: 'Marie', active: true }],
                     erreurLiaisons = null, erreurBiens = null, avis = [], erreurAvis = null,
                     done = [], erreurDone = null, conges = [], notes = [],
                     jetons = [], erreurJetons = null,
                     // La migration pas encore collee : le `select` qui nomme
                     // `vu_le` echoue, celui qui ne la nomme pas passe.
                     erreurColonneMenages = null } = {}) {
  const etat = { lectures: [] }
  const client = {
    auth: { getUser: async () => (user ? { data: { user: { id: user } }, error: null }
                                      : { data: null, error: { message: 'x' } }) },
    from (table) {
      const a = { table, f: {} }
      etat.lectures.push(a)
      const rep = () => {
        if (table === 'properties') return { data: biens, error: erreurBiens }
        if (table === 'property_cleaning_providers') {
          return { data: erreurLiaisons ? null : liaisons, error: erreurLiaisons }
        }
        if (table === 'provider_availability_rules') return { data: regles, error: null }
        if (table === 'provider_availability_exceptions') return { data: exceptions, error: null }
        if (table === 'menages') {
          const demandeValidation = /vu_le/.test(String(a.cols || ''))
          if (erreurColonneMenages && demandeValidation) {
            return { data: null, error: erreurColonneMenages }
          }
          // ⚠ LE DOUBLE REND CE QUI EST DEMANDE, comme PostgREST : sans cela,
          // le repli recevrait quand meme `vu_le` et le test ne prouverait
          // rien.
          if (demandeValidation) return { data: menages, error: null }
          return { data: menages.map(m => {
            const { vu_le, vu_par, ...reste } = m
            return reste
          }), error: null }
        }
        if (table === 'profiles') return { data: profils, error: null }
        if (table === 'ota_reviews') return { data: erreurAvis ? null : avis, error: erreurAvis }
        if (table === 'menage_done') return { data: erreurDone ? null : done, error: erreurDone }
        if (table === 'conges_plages') return { data: conges, error: null }
        if (table === 'menage_comments') return { data: notes, error: null }
        if (table === 'public_tokens') return { data: erreurJetons ? null : jetons, error: erreurJetons }
        return { data: [], error: null }
      }
      const chain = {
        select (cols) { a.cols = cols; return chain },
        eq (c, v) { a.f[c] = v; return chain },
        neq (c, v) { a.f['neq_' + c] = v; return chain },
        in (c, v) { a.f['in_' + c] = v; return chain },
        is () { return chain }, not () { return chain }, or (e) { a.or = e; return chain },
        gte (c, v) { a.f[c + '_gte'] = v; return chain },
        lte (c, v) { a.f[c + '_lte'] = v; return chain },
        order () { return chain },
        limit () { return Promise.resolve(rep()) },
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
  for (const mod of ['../lib/require-permission', '../lib/permissions', '../api/garde',
                     '../lib/stats-avis', '../lib/attribution-prestataire']) {
    try { delete require.cache[require.resolve(mod)] } catch {}
  }
  return { handler: require('../api/garde'), etat }
}

function reponse () {
  const r = { code: null, body: null }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  return r
}
const get = (q = {}) => ({ method: 'GET', query: { du: DU, au: AU, ...q },
                           headers: { authorization: 'Bearer jeton' } })

const LIAISON = (o = {}) => ({ user_id: PROD, property_id: BIEN, provider_id: REGINA,
                               rang: 1, weekdays: null, requires_ack: false, active: true, ...o })
const MENAGE = (o = {}) => ({ property_id: BIEN, booking_id: 'b1', departure_date: '2026-09-12',
                              status: 'accepted', provider_id: REGINA, offered_to: null,
                              offer_expires_at: null, assignment_reason: null, ...o })

// ─── Les droits ────────────────────────────────────────────────────────────

test('sans session : 401', async () => {
  const { handler } = preparer({ user: null })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.code, 401)
})

test('une méthode autre que GET est refusée', async () => {
  const { handler } = preparer({})
  const res = reponse()
  await handler({ method: 'POST', query: {}, headers: {} }, res)
  assert.strictEqual(res.code, 405)
})

test('sans `menages: read` : refus, et aucune lecture de données', async () => {
  const { handler, etat } = preparer({
    user: MEMBRE,
    profil: { id: 'pr1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { menages: 'none', property_scope: 'all' }
  })
  const res = reponse()
  await handler({ ...get(), headers: { authorization: 'Bearer jeton', 'x-compte': PROD } }, res)
  assert.strictEqual(res.code, 403)
  assert.ok(!etat.lectures.some(l => l.table === 'menages'))
})

// ─── La fenêtre ────────────────────────────────────────────────────────────

test('une fenêtre illisible est refusée', async () => {
  for (const q of [{ du: 'lundi' }, { au: '' }, { du: '07-09-2026' }, { du: '2026-09-32' }]) {
    const { handler } = preparer({})
    const res = reponse()
    await handler(get(q), res)
    assert.strictEqual(res.code, 400, JSON.stringify(q))
  }
})

test('une fenêtre INVERSÉE est refusée', async () => {
  const { handler } = preparer({})
  const res = reponse()
  await handler(get({ du: '2026-09-13', au: '2026-09-07' }), res)
  assert.strictEqual(res.code, 400)
})

test('une fenêtre trop large est REFUSÉE, pas tronquée', async () => {
  // ⚠ Un écran qui affiche six jours sur sept sans le dire laisse croire que le
  // septième n'a pas de ménage. Et `planningDeGarde` évalue la récurrence par
  // (personne, jour) : une fenêtre d'un an demandée par une URL bricolée ferait
  // des dizaines de milliers d'évaluations.
  const { handler } = preparer({})
  const res = reponse()
  await handler(get({ du: '2026-01-01', au: '2026-12-31' }), res)
  assert.strictEqual(res.code, 400)
  assert.match(res.body.error, /max/)
})

test('la semaine demandée est rendue en entier, jour par jour', async () => {
  const { handler } = preparer({ liaisons: [LIAISON()] })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.jours.length, 7)
  assert.strictEqual(res.body.jours[0], DU)
  assert.strictEqual(res.body.jours[6], AU)
})

// ─── La garde elle-même ────────────────────────────────────────────────────

test('la garde vient de la MÊME brique que le moteur', async () => {
  // ⚠ Recopier la règle côté écran, c'était garantir que les deux divergent :
  // l'hôte aurait lu un planning qui ne dit pas ce que le cron fait.
  const source = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'api/garde.js'), 'utf8')
  assert.match(source, /require\('\.\.\/lib\/cleaning\/garde'\)/)
  assert.match(source, /planningDeGarde\(/)
})

test('Régina attitrée tous les jours est de garde les 7 jours', async () => {
  const { handler } = preparer({ liaisons: [LIAISON()] })
  const res = reponse()
  await handler(get(), res)
  const b = res.body.garde[0]
  assert.strictEqual(b.propertyId, BIEN)
  assert.strictEqual(b.jours.length, 7)
  assert.ok(b.jours.every(j => j.responsable && j.responsable.id === REGINA), 'tous les jours')
  assert.ok(b.jours.every(j => j.trou === false))
})

test('un CONGÉ fait apparaître le trou de garde, ce jour-là seulement', async () => {
  const { handler } = preparer({
    liaisons: [LIAISON()],
    exceptions: [{ user_id: PROD, provider_id: REGINA, date: '2026-09-09', available: false }]
  })
  const res = reponse()
  await handler(get(), res)
  const jours = res.body.garde[0].jours
  const trou = jours.find(j => j.date === '2026-09-09')
  assert.strictEqual(trou.trou, true)
  assert.strictEqual(trou.responsable, null)
  assert.strictEqual(jours.filter(j => j.trou).length, 1, 'les autres jours restent couverts')
})

test('la REMPLAÇANTE est rendue quand il y en a une', async () => {
  const { handler } = preparer({
    liaisons: [LIAISON(), LIAISON({ provider_id: SECONDE, rang: 2, requires_ack: true })]
  })
  const res = reponse()
  await handler(get(), res)
  const j = res.body.garde[0].jours[0]
  assert.strictEqual(j.responsable.id, REGINA)
  assert.strictEqual(j.remplacante.id, SECONDE)
})

test('les trous BRUTS sont rendus, y compris les jours SANS ménage', async () => {
  // ⚠ C'est ce qui permet de voir venir (§12.6). L'écran ne met en rouge que
  // ceux qui portent un ménage, mais il doit pouvoir montrer les autres en gris.
  const { handler } = preparer({
    liaisons: [LIAISON()],
    exceptions: [{ user_id: PROD, provider_id: REGINA, date: '2026-09-09', available: false }]
  })
  const res = reponse()
  await handler(get(), res)
  assert.deepStrictEqual(res.body.trous, [{ propertyId: BIEN, date: '2026-09-09' }])
})

// ─── Les ménages posés dessus ──────────────────────────────────────────────

test('les ménages de la semaine sont rendus avec leur état', async () => {
  const { handler } = preparer({
    liaisons: [LIAISON()],
    menages: [MENAGE(), MENAGE({ booking_id: 'b2', departure_date: '2026-09-13',
                                 status: 'accepted', offered_to: SECONDE,
                                 offer_expires_at: '2026-09-12T16:00:00Z' })]
  })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.body.menages.length, 2)
  const porte = res.body.menages[0]
  assert.strictEqual(porte.porteur.id, REGINA)
  assert.strictEqual(porte.proposeA, null)
  const propose = res.body.menages[1]
  assert.strictEqual(propose.proposeA.id, SECONDE)
  assert.ok(propose.expireLe, 'le délai de réponse doit remonter')
})

test('un ménage ANNULÉ n\'est pas affiché', async () => {
  // Il n'a plus d'objet : le montrer ferait chercher à l'hôte une réservation
  // qui n'existe plus.
  const { handler, etat } = preparer({ liaisons: [LIAISON()] })
  await handler(get(), reponse())
  const l = etat.lectures.find(x => x.table === 'menages')
  assert.strictEqual(l.f.neq_status, 'cancelled')
})

test('un ménage REFUSÉ porte son motif : « refusé » n\'est pas « personne »', async () => {
  // ⚠ Les confondre laisse l'hôte sans savoir qu'il doit agir.
  const { handler } = preparer({
    liaisons: [LIAISON()],
    menages: [MENAGE({ status: 'orphaned', provider_id: null,
                       assignment_reason: 'Refuse par Marie, et personne ne porte ce menage.' })]
  })
  const res = reponse()
  await handler(get(), res)
  const m = res.body.menages[0]
  assert.strictEqual(m.status, 'orphaned')
  assert.strictEqual(m.porteur, null)
  assert.match(m.raison, /Refuse par/)
})

test('les ménages sont bornés à la fenêtre ET aux biens du périmètre', async () => {
  const { handler, etat } = preparer({ liaisons: [LIAISON()] })
  await handler(get(), reponse())
  const l = etat.lectures.find(x => x.table === 'menages')
  assert.strictEqual(l.f.user_id, PROD)
  assert.strictEqual(l.f.departure_date_gte, DU)
  assert.strictEqual(l.f.departure_date_lte, AU)
  assert.deepStrictEqual(l.f.in_property_id, [BIEN])
})

// ─── Le cloisonnement des PRÉNOMS ──────────────────────────────────────────

test('sans `prestataires: read`, aucun PRÉNOM ne sort', async () => {
  // ⚠ Voir la couverture n'est pas voir qui compose l'équipe. Un propriétaire
  // délégué doit savoir que son bien est couvert, pas qui y travaille.
  const { handler } = preparer({
    user: MEMBRE,
    profil: { id: 'pr1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { menages: 'read', prestataires: 'none', avis: 'none', property_scope: 'all' },
    liaisons: [LIAISON()], menages: [MENAGE()]
  })
  const res = reponse()
  await handler({ ...get(), headers: { authorization: 'Bearer jeton', 'x-compte': PROD } }, res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.avec_noms, false)
  const brut = JSON.stringify(res.body)
  assert.ok(!brut.includes('Régina'), 'aucun prénom')
  assert.ok(!brut.includes('Marie'), 'aucun prénom')
  // ⚠ NI L'IDENTIFIANT. Rendu jour par jour et bien par bien, un UUID stable
  // suffit à reconstituer le calendrier de présence et d'absence du personnel —
  // exactement ce que `api/disponibilites.js` refuse à `menages: read`. Un
  // identifiant est une identité quand il est constant.
  assert.strictEqual(res.body.garde[0].jours[0].responsable.id, undefined)
  assert.ok(!brut.includes(REGINA), 'aucun identifiant de prestataire')
  // La couverture, elle, reste lisible : c'est l'objet de l'écran.
  assert.ok(res.body.garde[0].jours[0].responsable, 'quelqu\'un est de garde')
  assert.strictEqual(res.body.garde[0].jours[0].trou, false)
})

test('avec `prestataires: read`, les prénoms sortent', async () => {
  const { handler } = preparer({ liaisons: [LIAISON()] })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.body.avec_noms, true)
  assert.strictEqual(res.body.garde[0].jours[0].responsable.prenom, 'Régina')
})

test('AUCUNE coordonnée ni donnée voyageur ne sort', async () => {
  // L'écran répond à « qui est de garde », pas à « qui est ce voyageur ».
  const { handler } = preparer({
    liaisons: [LIAISON()], menages: [MENAGE()],
    profils: [{ id: REGINA, first_name: 'Régina', active: true,
                phone: '+33600000000', email: 'regina@exemple.fr', pwa_token: 'jeton-secret' }]
  })
  const res = reponse()
  await handler(get(), res)
  const brut = JSON.stringify(res.body)
  assert.ok(!brut.includes('+33600000000'))
  assert.ok(!brut.includes('regina@exemple.fr'))
  assert.ok(!brut.includes('jeton-secret'))
})

// ─── Les pannes ────────────────────────────────────────────────────────────

test('une panne des LIAISONS coupe : un écran faux est pire qu\'un écran en panne', async () => {
  // ⚠ Une garde calculée sur des liaisons partielles afficherait « personne »
  // sur des jours couverts — ou quelqu'un qui est en congé.
  const { handler } = preparer({ erreurLiaisons: { message: 'timeout' } })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.code, 503)
})

test('une panne des BIENS coupe aussi', async () => {
  const { handler } = preparer({ erreurBiens: { message: 'timeout' } })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.code, 503)
})

test('aucun bien : une réponse vide et lisible, pas une erreur', async () => {
  const { handler } = preparer({ biens: [] })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.code, 200)
  assert.deepStrictEqual(res.body.biens, [])
  assert.deepStrictEqual(res.body.garde, [])
})

test('un périmètre VIDE ne montre rien — et ne lit rien', async () => {
  // ⚠ Périmètre vide et « tous les biens » ne se confondent pas : les mélanger
  // montrerait tout le compte à un membre qui n'a droit à rien.
  const { handler, etat } = preparer({
    user: MEMBRE,
    profil: { id: 'pr1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { menages: 'read', property_scope: 'selected', property_ids: [], property_refs: [] }
  })
  const res = reponse()
  await handler({ ...get(), headers: { authorization: 'Bearer jeton', 'x-compte': PROD } }, res)
  assert.strictEqual(res.code, 200)
  assert.deepStrictEqual(res.body.biens, [])
  assert.ok(!etat.lectures.some(l => l.table === 'menages'))
})

// ─── Ce que la review a trouvé, et qui ne doit plus revenir ────────────────

test('les PRÉNOMS ne fuient pas par le champ `raison`', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW, et c'était une fuite. `assignment_reason` porte
  // « Refuse par Marie… », « reste chez Regina », « Propose a Marie par
  // l'hote » : rendue sans condition, elle affichait à un propriétaire délégué
  // exactement ce que la garde `prestataires: read` venait de masquer.
  const { handler } = preparer({
    user: MEMBRE,
    profil: { id: 'pr1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { menages: 'read', prestataires: 'none', avis: 'none', property_scope: 'all' },
    liaisons: [LIAISON()],
    menages: [MENAGE({ status: 'orphaned', provider_id: null,
                       assignment_reason: 'Refuse par Marie, et personne ne porte ce menage.' })]
  })
  const res = reponse()
  await handler({ ...get(), headers: { authorization: 'Bearer jeton', 'x-compte': PROD } }, res)
  assert.strictEqual(res.code, 200)
  assert.ok(!JSON.stringify(res.body).includes('Marie'), 'aucun prénom, par aucun champ')
  // Le STATUT, lui, reste : c'est lui qui commande une action.
  assert.strictEqual(res.body.menages[0].status, 'orphaned')
})

test('AUCUN compteur global de personne ne sort de cet écran', async () => {
  // ⚠ Décision du product owner, 4 septembre 2026 : le ratio d'une prestataire
  // est sa fiche QUALITÉ — il vit sur /avis et dans sa PWA. Ici, ce qu'on montre
  // est attaché à UN MÉNAGE : ce que le voyageur a dit de CE séjour-là.
  const source = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'api/garde.js'), 'utf8')
  assert.ok(!source.includes('ratioProprete'), 'plus de ratio par personne')
  assert.ok(!source.includes('avisDuPrestataire'), 'plus d\'attribution par personne')
  const front = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'pages/menages.html'), 'utf8')
  // ⚠ TRANSPOSÉ DE `garde.html` (étape 4) : l'écran ne compte pas les pouces
  // d'une personne. Le ratio est sa fiche QUALITÉ — il vit sur /avis et dans sa
  // PWA, attaché à UNE personne ; ici, ce qu'on montre est attaché à UN MÉNAGE.
  assert.ok(!/function pouces/.test(front))
  assert.ok(!/ratioProprete/.test(front), 'ni ratio par personne sur le planning')
})

test('le retour de propreté du SÉJOUR, sur un ménage passé', async () => {
  const { handler } = preparer({
    liaisons: [LIAISON()],
    menages: [MENAGE({ departure_date: HIER })],
    avis: [{ booking_uid: 'b1', property_id_ref: BIEN, ai_clean_verdict: 'remarque',
             ai_clean_excerpt: 'la douche était sale', content_public: 'séjour correct mais la douche était sale',
             content_private: null, verdict_source: 'auto' }]
  })
  const res = reponse()
  await handler(get(PASSE), res)
  const m = res.body.menages[0]
  assert.ok(m.retour, 'le retour doit être rattaché au ménage')
  assert.strictEqual(m.retour.verdict, 'remarque')
  assert.strictEqual(m.retour.extrait, 'la douche était sale')
  assert.strictEqual(m.retour.prive, false)
})

test('un ménage À VENIR n\'affiche AUCUN retour', async () => {
  // ⚠ Un avis ne peut pas concerner un séjour qui n'a pas eu lieu : ce serait au
  // mieux l'avis d'un AUTRE séjour du même bien, au pire un rattachement faux
  // présenté comme un fait.
  const { handler } = preparer({
    liaisons: [LIAISON()],
    menages: [MENAGE({ departure_date: '2099-09-08' })],
    avis: [{ booking_uid: 'b1', property_id_ref: BIEN, ai_clean_verdict: 'positif',
             ai_clean_excerpt: 'impeccable', content_public: 'impeccable', content_private: null }]
  })
  const res = reponse()
  await handler(get({ du: '2099-09-07', au: '2099-09-13' }), res)
  assert.strictEqual(res.body.menages[0].retour, null)
})

test('un ménage SANS avis rattaché ne rend rien — pas « pas encore d\'avis »', async () => {
  const { handler } = preparer({ liaisons: [LIAISON()],
                                 menages: [MENAGE({ departure_date: HIER })], avis: [] })
  const res = reponse()
  await handler(get(PASSE), res)
  assert.strictEqual(res.body.menages[0].retour, null)
})

test('« rien_signalé » n\'est pas un retour à montrer', async () => {
  const { handler } = preparer({
    liaisons: [LIAISON()], menages: [MENAGE({ departure_date: HIER })],
    avis: [{ booking_uid: 'b1', property_id_ref: BIEN, ai_clean_verdict: 'rien_signale',
             ai_clean_excerpt: null, content_public: 'très bon séjour', content_private: null }]
  })
  const res = reponse()
  await handler(get(PASSE), res)
  assert.strictEqual(res.body.menages[0].retour, null)
})

test('un extrait venu du PRIVÉ est étiqueté « retour privé »', async () => {
  // ⚠ La règle est « privé dès qu'il n'est pas certainement public » : un extrait
  // à cheval sortait sinon comme public, et l'hôte lisait sur son planning une
  // phrase que le voyageur n'avait pas rendue publique.
  const { handler } = preparer({
    liaisons: [LIAISON()], menages: [MENAGE({ departure_date: HIER })],
    avis: [{ booking_uid: 'b1', property_id_ref: BIEN, ai_clean_verdict: 'remarque',
             ai_clean_excerpt: 'poussière sous le lit',
             content_public: 'séjour agréable',
             content_private: 'je ne l\'ai pas mis dans l\'avis mais poussière sous le lit' }]
  })
  const res = reponse()
  await handler(get(PASSE), res)
  assert.strictEqual(res.body.menages[0].retour.prive, true)
})

test('une REQUALIFICATION humaine se voit', async () => {
  const { handler } = preparer({
    liaisons: [LIAISON()], menages: [MENAGE({ departure_date: HIER })],
    avis: [{ booking_uid: 'b1', property_id_ref: BIEN, ai_clean_verdict: 'positif',
             ai_clean_excerpt: 'très propre', content_public: 'très propre',
             content_private: null, verdict_source: 'humain' }]
  })
  const res = reponse()
  await handler(get(PASSE), res)
  assert.strictEqual(res.body.menages[0].retour.humain, true)
})

test('aucun NOM DE VOYAGEUR ni texte complet ne sort avec le retour', async () => {
  const { handler, etat } = preparer({
    liaisons: [LIAISON()], menages: [MENAGE({ departure_date: HIER })],
    avis: [{ booking_uid: 'b1', property_id_ref: BIEN, ai_clean_verdict: 'remarque',
             ai_clean_excerpt: 'la douche', guest_name: 'Jean Voyageur',
             content_public: 'la douche était sale, sinon parfait',
             content_private: 'entre nous, la douche était sale' }]
  })
  const res = reponse()
  await handler(get(PASSE), res)
  const brut = JSON.stringify(res.body)
  assert.ok(!brut.includes('Jean Voyageur'))
  assert.ok(!brut.includes('sinon parfait'), 'le texte public ne sort pas')
  assert.ok(!brut.includes('entre nous'), 'le texte privé encore moins')
  // Et la requête ne demande jamais ces colonnes-là.
  const l = etat.lectures.find(x => x.table === 'ota_reviews')
  assert.ok(l, 'les avis sont bien lus')
})

test('sans `avis: read`, aucun retour ne sort', async () => {
  const { handler } = preparer({
    user: MEMBRE,
    profil: { id: 'pr1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { menages: 'read', prestataires: 'read', avis: 'none', property_scope: 'all' },
    liaisons: [LIAISON()], menages: [MENAGE({ departure_date: HIER })],
    avis: [{ booking_uid: 'b1', property_id_ref: BIEN, ai_clean_verdict: 'remarque',
             ai_clean_excerpt: 'la douche était sale', content_public: 'la douche était sale' }]
  })
  const res = reponse()
  await handler({ ...get(), headers: { authorization: 'Bearer jeton', 'x-compte': PROD } }, res)
  assert.strictEqual(res.body.menages[0].retour, null)
  assert.strictEqual(res.body.avec_avis, false)
})

test('le rattachement exige le BIEN ET la réservation', async () => {
  // ⚠ Ni `booking_uid` ni `property_id_ref` n'ont d'unicité globale : un avis
  // rapproché sur le seul booking tomberait sur le ménage d'un autre bien.
  const { handler, etat } = preparer({
    liaisons: [LIAISON()], menages: [MENAGE({ departure_date: HIER })],
    avis: [{ booking_uid: 'b1', property_id_ref: 'AUTRE-BIEN', ai_clean_verdict: 'remarque',
             ai_clean_excerpt: 'sale', content_public: 'sale' }]
  })
  const res = reponse()
  await handler(get(PASSE), res)
  assert.strictEqual(res.body.menages[0].retour, null, 'même booking, autre bien : aucun rattachement')
  const l = etat.lectures.find(x => x.table === 'ota_reviews')
  assert.strictEqual(l.f.user_id, PROD)
  assert.strictEqual(l.f.statut, 'confirme', 'seul un avis VALIDÉ par un humain est un fait')
})

test('une panne de lecture des avis ne coupe PAS le planning', async () => {
  // Sans retour, l'écran reste juste. C'est la différence avec les liaisons.
  const { handler } = preparer({
    liaisons: [LIAISON()], menages: [MENAGE({ departure_date: HIER })],
    erreurAvis: { message: 'timeout' }
  })
  const res = reponse()
  await handler(get(PASSE), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.menages[0].retour, null)
})

test('une lecture TRONQUÉE est dite, jamais silencieuse', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW. Un ménage hors du lot rend son jour « sans
  // ménage » : il s'affiche en gris au lieu du rouge — l'alerte que cet écran
  // existe pour montrer devient un silence.
  const beaucoup = Array.from({ length: 500 }, (_, i) => MENAGE({ booking_id: `b${i}` }))
  const { handler } = preparer({ liaisons: [LIAISON()], menages: beaucoup })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.body.tronque, true)
})

test('une lecture complète ne crie pas au loup', async () => {
  const { handler } = preparer({ liaisons: [LIAISON()], menages: [MENAGE()] })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.body.tronque, false)
})

test('le DÉLAI de réponse remonte ET est affiché', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW : il était calculé, transporté, jamais affiché —
  // et le KB annonçait le contraire. Sans lui, l'hôte ne sait pas s'il doit agir
  // maintenant ou attendre.
  const { handler } = preparer({
    liaisons: [LIAISON()],
    menages: [MENAGE({ offered_to: SECONDE, offer_expires_at: '2026-09-12T16:00:00Z' })]
  })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.body.menages[0].expireLe, '2026-09-12T16:00:00Z')
  const front = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'pages/menages.html'), 'utf8')
  // ⚠ TRANSPOSÉ DE `garde.html` (étape 4). Le délai ne tient pas dans une case
  // de calendrier : il vit dans l'infobulle du ménage. Mais il doit TOUJOURS
  // être quelque part, et en HEURE DE PARIS — l'afficher en UTC annonce 16 h à
  // quelqu'un qui a jusqu'à 18 h.
  assert.match(front, /tt_expire/, 'l\'écran doit montrer l\'échéance')
  assert.match(front, /timeZone: 'Europe\/Paris'/, 'en heure de Paris, pas en UTC')
  // Et une offre MORTE ne se dit pas comme une offre qui court : la règle vit
  // dans le module partagé, qui fait sortir l'alerte quand l'échéance est
  // passée — plus fort qu'un mot dans une infobulle.
  const regle = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'shared/menages-a-traiter.js'), 'utf8')
  assert.match(regle, /const expiree = m\.expireLe/, 'une offre périmée alerte')
})

test('un bien SANS AUCUNE liaison n\'est pas un trou de garde', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW. `deciderParGarde` sépare « aucune liaison » (ce
  // bien n'est pas confié à l'app ménage — le moteur n'alerte PAS, décision du
  // 3 septembre) de « personne ce jour-là ». L'écran les confondait : un hôte
  // qui fait son ménage lui-même, ou qui n'a confié qu'un logement sur trois,
  // voyait du rouge à chaque départ — le bruit permanent que le moteur évite.
  const { handler } = preparer({
    biens: [{ provider_property_id: BIEN, name: 'La bulle' },
            { provider_property_id: '169567', name: 'Colomiers' }],
    liaisons: [LIAISON()]   // seulement sur le premier bien
  })
  const res = reponse()
  await handler(get(), res)
  const bulle = res.body.garde.find(b => b.propertyId === BIEN)
  const colomiers = res.body.garde.find(b => b.propertyId === '169567')
  assert.strictEqual(bulle.gere, true)
  assert.strictEqual(colomiers.gere, false, 'l\'écran doit pouvoir ne PAS le peindre en rouge')
  const front = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'pages/menages.html'), 'utf8')
  // ⚠ TRANSPOSÉ DE `garde.html` (étape 4) : un bien non confié n'a NI ligne de
  // prestataire, NI rouge. Un hôte qui fait son ménage lui-même ne produit
  // aucun bruit (décision du 3 septembre 2026).
  assert.match(front, /non confié/, 'et le dire autrement qu\'en rouge')
  assert.match(front, /men-nonconfie/, 'la règle est dans le RENDU, pas seulement en commentaire')
  assert.match(front, /const trous = gere \? trousDuBien\(g\) : new Set\(\)/,
    'et un bien non confié n\'a PAS de jours « sans personne »')
})

test('une responsable que le moteur ne sollicitera JAMAIS est signalée', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW. Une liaison « à confirmer » sans jours réglés est
  // candidate (weekdays null = tous les jours) donc rendue comme responsable,
  // mais la restriction du §12.9c l'exclut de toute proposition. L'écran
  // affichait « Marie est de garde » juste au-dessus de « ménage — personne ».
  const { handler } = preparer({
    liaisons: [LIAISON({ provider_id: SECONDE, requires_ack: true, weekdays: null })],
    menages: [MENAGE({ provider_id: null, status: 'unassigned' })]
  })
  const res = reponse()
  await handler(get(), res)
  const j = res.body.garde[0].jours[0]
  assert.strictEqual(j.responsable.id, SECONDE)
  assert.strictEqual(j.responsable.a_regler, true, 'le réglage manquant doit se voir')
})

test('des jours réglés lèvent le signalement', async () => {
  const { handler } = preparer({
    liaisons: [LIAISON({ provider_id: SECONDE, requires_ack: true, weekdays: [0, 1, 2, 3, 4, 5, 6] })]
  })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.body.garde[0].jours[0].a_regler, undefined)
  assert.strictEqual(res.body.garde[0].jours[0].responsable.a_regler, false)
})

test('`avec_avis` dit ce qui SORT, pas ce que le droit autorise', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW. Les pouces s'accrochent à une personne nommée :
  // sans `prestataires: read`, il n'y a personne à qui les attacher, et annoncer
  // `true` faisait chercher à l'écran des compteurs qui ne viendraient jamais.
  const { handler } = preparer({
    user: MEMBRE,
    profil: { id: 'pr1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { menages: 'read', prestataires: 'none', avis: 'read', property_scope: 'all' },
    liaisons: [LIAISON()]
  })
  const res = reponse()
  await handler({ ...get(), headers: { authorization: 'Bearer jeton', 'x-compte': PROD } }, res)
  assert.strictEqual(res.body.avec_avis, false)
})

test('un ménage PAS ENCORE PROPOSÉ n\'est pas « personne »', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW. Au-delà de la fenêtre de proposition (§12.9b), un
  // ménage dont la responsable doit confirmer reste `unassigned` sans offre : le
  // moteur dit explicitement qu'il n'y a rien à signaler. L'écran le peignait en
  // rouge « ⚠ personne » juste sous la pastille violette de sa responsable, et
  // un clic sur « semaine suivante » suffisait à rougir tout l'écran.
  const loin = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
  const fin = new Date(Date.now() + 34 * 86400000).toISOString().slice(0, 10)
  const debut = new Date(Date.now() + 28 * 86400000).toISOString().slice(0, 10)
  const { handler } = preparer({
    liaisons: [LIAISON({ provider_id: SECONDE, requires_ack: true, weekdays: [0, 1, 2, 3, 4, 5, 6] })],
    menages: [MENAGE({ departure_date: loin, provider_id: null, status: 'unassigned' })]
  })
  const res = reponse()
  await handler(get({ du: debut, au: fin }), res)
  const m = res.body.menages[0]
  assert.strictEqual(m.differe, true, 'la proposition partira quand la date approchera')
  const front = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'pages/menages.html'), 'utf8')
  // ⚠ TRANSPOSÉ DE `garde.html` (étape 4) : un ménage dont la proposition est
  // DIFFÉRÉE (départ lointain) n'est pas « personne ». Et un REFUS n'est pas un
  // report : `orphaned` doit passer AVANT `differe`, sinon un ménage que tout
  // le monde a refusé reste invisible jusqu'à J−7.
  assert.match(front, /m\.differe && m\.status !== 'orphaned'/,
    'le différé se tait, mais pas le refusé')
})

test('un ménage PROCHE sans personne reste, lui, une alerte', async () => {
  // La garde ne doit pas taire un vrai trou : dans la fenêtre, « personne » est
  // « personne ».
  const proche = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10)
  const fin = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10)
  const debut = new Date(Date.now() - 1 * 86400000).toISOString().slice(0, 10)
  const { handler } = preparer({
    liaisons: [LIAISON({ provider_id: SECONDE, requires_ack: true, weekdays: [0, 1, 2, 3, 4, 5, 6] })],
    menages: [MENAGE({ departure_date: proche, provider_id: null, status: 'unassigned' })]
  })
  const res = reponse()
  await handler(get({ du: debut, au: fin }), res)
  assert.strictEqual(res.body.menages[0].differe, false)
})

test('deux avis sur le même séjour : la REMARQUE n\'est pas masquée', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW. Un même séjour peut porter un avis OTA et une
  // détection dans les messages, tous deux confirmés : sans arbitrage, l'ordre
  // de PostgREST décidait, et une remarque pouvait être remplacée par un
  // compliment d'un appel à l'autre.
  const { handler } = preparer({
    liaisons: [LIAISON()], menages: [MENAGE({ departure_date: HIER })],
    avis: [{ booking_uid: 'b1', property_id_ref: BIEN, ai_clean_verdict: 'positif',
             ai_clean_excerpt: 'très propre', content_public: 'très propre' },
           { booking_uid: 'b1', property_id_ref: BIEN, ai_clean_verdict: 'remarque',
             ai_clean_excerpt: 'sauf la douche', content_public: 'très propre sauf la douche' }]
  })
  const res = reponse()
  await handler(get(PASSE), res)
  assert.strictEqual(res.body.menages[0].retour.verdict, 'remarque')
})

test('une requalification HUMAINE prime sur tout', async () => {
  const { handler } = preparer({
    liaisons: [LIAISON()], menages: [MENAGE({ departure_date: HIER })],
    avis: [{ booking_uid: 'b1', property_id_ref: BIEN, ai_clean_verdict: 'remarque',
             ai_clean_excerpt: 'la douche', content_public: 'la douche' },
           { booking_uid: 'b1', property_id_ref: BIEN, ai_clean_verdict: 'positif',
             ai_clean_excerpt: 'impeccable', content_public: 'impeccable',
             verdict_source: 'humain' }]
  })
  const res = reponse()
  await handler(get(PASSE), res)
  assert.strictEqual(res.body.menages[0].retour.humain, true)
  assert.strictEqual(res.body.menages[0].retour.verdict, 'positif', 'la décision de l\'hôte tranche')
})

test('une prestataire DÉSACTIVÉE est signalée, pas affichée comme si de rien n\'était', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW. La désactivation supprime sa ligne
  // `public_tokens` — sa PWA ne s'ouvre plus — sans toucher ses liaisons : elle
  // reste « de garde » pour le calcul. L'afficher en violet laissait l'hôte
  // compter sur quelqu'un qui ne verra jamais le ménage.
  const { handler } = preparer({
    liaisons: [LIAISON()],
    profils: [{ id: REGINA, first_name: 'Régina', active: false }]
  })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.body.garde[0].jours[0].responsable.actif, false)
  const front = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'pages/menages.html'), 'utf8')
  // ⚠ TRANSPOSÉ DE `garde.html` (étape 4) : une prestataire désactivée se voit
  // — prénom grisé, ligne vide — plutôt que d'être affichée comme si de rien
  // n'était, ou d'être retirée en silence.
  assert.match(front, /désactivée/, 'et l\'écran doit le dire')
})

test('la REMPLAÇANTE aussi porte « jours à régler »', async () => {
  const { handler } = preparer({
    liaisons: [LIAISON(),
               LIAISON({ provider_id: SECONDE, rang: 2, requires_ack: true, weekdays: null })]
  })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.body.garde[0].jours[0].remplacante.a_regler, true)
  // ⚠ L'ÉCRAN NE MONTRE PLUS LA REMPLAÇANTE (étape 4, 14 octobre 2026), et
  // c'est une PERTE ASSUMÉE, pas un oubli : l'inventaire la signalait déjà
  // comme « retirée par omission » (§E.2). La V5 affiche une ligne par
  // prestataire et une pastille par ménage ; la remplaçante du jour n'y a plus
  // de place. L'ENDPOINT, lui, continue de la rendre — ce test garde le
  // contrat serveur intact pour le jour où l'écran la reprendra.
  assert.ok(res.body.garde[0].jours[0].remplacante.prenom !== undefined,
    'le serveur la nomme toujours')
})

// ─── La refonte en grille (5 septembre 2026) ───────────────────────────────

test('l\'écran REPREND la grille du calendrier des tarifs, il ne la réinvente pas', async () => {
  // ⚠ Décision du product owner. Deux écrans qui montrent des jours et des biens
  // doivent se lire pareil : une seconde grammaire visuelle, c'est un second
  // apprentissage. Les primitives viennent du noyau partagé — réécrire `toISO`
  // ou la largeur de colonne ici, c'était garantir que les deux grilles se
  // décalent d'un pixel puis d'un jour.
  // ⚠ TRANSPOSÉ SUR LA PAGE V5 (étape 4, 14 octobre 2026) : `apps/menages/garde.html`
  // est devenu une redirection, et c'est `/menages` qui porte la grille.
  const front = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'pages/menages.html'), 'utf8')
  assert.match(front, /from '\/shared\/calendar-core\.js'/, 'le noyau partagé')
  // ⚠ LA LARGEUR DE CASE N'EST PAS RECOPIÉE EN JS : elle vient du CSS partagé.
  // Deux sources pour une même mesure, c'est la garantie qu'elles divergent.
  assert.ok(!/largeurCase\s*=\s*\d+/.test(front), 'aucune largeur en dur en JavaScript')
})

test('AUCUNE information de l\'ancien Planning n\'a disparu', async () => {
  // ⚠ LA LISTE DE CE QUI NE DOIT PAS SE PERDRE. Elle gardait la refonte en
  // grille du 5 septembre ; elle garde désormais le passage à la page V5
  // (étape 4, 14 octobre 2026), où `apps/menages/garde.html` devient une
  // redirection. Tout ce que l'ancien écran disait doit rester accessible,
  // au survol ou au clic si la grille est trop dense pour l'écrire.
  //
  // ⚠ ON VISE LES CLÉS i18n, PAS DES BOUTS DE PHRASE : la V5 dit les mêmes
  // choses avec d'autres mots, et une formulation retouchée ne doit pas faire
  // croire qu'une information a disparu.
  const front = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'pages/menages.html'), 'utf8')
  const fr = JSON.parse(require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'shared/i18n/fr.json'), 'utf8'))
  const cles = [
    'menages.non_confie',      // bien sans liaison : jamais rouge
    'menages.a_regler',        // responsable jamais sollicitée
    'menages.tt_expire',       // délai d'une proposition
    'menages.retour_prive',    // extrait venu d'un message privé
    'menages.retour_bon',      // 👍 : il ne disparaît pas avec la refonte
    'menages.retour_mauvais',  // 👎
    'menages.quelquun'         // sans `prestataires: read`
  ]
  for (const c of cles) {
    assert.ok(fr[c], `libellé perdu : « ${c} »`)
    assert.ok(front.includes(c), `information perdue à l'étape 4 : « ${c} »`)
  }
  // Et les trois états que le rendu décide lui-même.
  assert.match(front, /désactivée/, 'profil désactivé')
  assert.match(front, /men-jj__bang/, 'trou de garde sur un jour qui porte un ménage')
  assert.match(front, /aTraiterTronque|tronque/, 'troncature dite, jamais silencieuse')
})

test('la grille reste DENSE : le retour de propreté n\'y est pas en pavé', async () => {
  // ⚠ Un extrait par cellule ruinerait la densité, qui est tout l'intérêt d'un
  // calendrier. La case porte un 👍/👎 discret ; la phrase est au clic.
  // Transposé sur la page V5 (étape 4).
  const front = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'pages/menages.html'), 'utf8')
  const i = front.indexOf('const retour = (e === \'fait\' && m.retour)')
  assert.ok(i > 0, 'la case sait montrer un retour')
  const grille = front.slice(i, i + 600)
  assert.ok(!grille.includes('extrait'), 'pas d\'extrait dans la case')
  assert.match(grille, /i-thumb-down|i-thumb-up/, 'mais un pictogramme discret')
  // Et la phrase du voyageur vit dans la fiche, au clic.
  assert.match(front, /function ouvrirFiche/, 'le détail au clic')
})

test('une garde LOINTAINE se lit par tranches, sous la borne du serveur', async () => {
  // ⚠ CE CONTRAT A CHANGÉ À LA V5, ET C'EST DÉLIBÉRÉ. L'ancien écran
  // s'interdisait 6 et 12 mois : les règles de disponibilité auront changé bien
  // avant, et il aurait présenté une prévision comme un fait. La page V5 les
  // propose — mais ce qu'elle montre loin, ce sont les MÉNAGES et les
  // liaisons, pas une garde calculée présentée comme acquise.
  // ⚠ CE QUI NE CHANGE PAS : la borne SERVEUR. L'endpoint refuse une fenêtre
  // de plus de 92 jours (troncature silencieuse interdite), et l'écran la
  // respecte en découpant sa demande en tranches — il ne la contourne pas.
  const front = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'pages/menages.html'), 'utf8')
  assert.match(front, /const TRANCHE_MAX = 92/, 'la borne serveur est connue de l\'écran')
  assert.match(front, /i \+= TRANCHE_MAX/, 'et la fenêtre est découpée, pas tronquée')
  // Et le serveur refuse toujours au-delà : c'est lui qui tranche.
  const { handler } = preparer({ liaisons: [LIAISON()] })
  const res = reponse()
  await handler(get({ du: '2026-09-01', au: '2027-09-01' }), res)
  assert.strictEqual(res.code, 400, 'une fenêtre d\'un an est refusée par le serveur')
})

test('la fenêtre que l\'écran DEMANDE VRAIMENT est acceptée', async () => {
  // ⚠ LE TEST QUI COMPTE : pas « le serveur refuse 93 jours », mais « ce que
  // l'écran envoie passe ». Les deux bornes se sont déjà décalées d'un jour, et
  // l'hôte voyait un écran vide sans un mot.
  const { handler } = preparer({ liaisons: [LIAISON()] })
  const res = reponse()
  await handler(get({ du: '2026-09-01', au: '2026-11-30' }), res)
  assert.strictEqual(res.code, 200, '91 jours : la plus grande tranche de l\'écran passe')
})

test('au-delà de la borne, le serveur refuse plutôt que de tronquer', async () => {
  const { handler } = preparer({ liaisons: [LIAISON()] })
  const res = reponse()
  await handler(get({ du: '2026-01-01', au: '2026-06-30' }), res)
  assert.strictEqual(res.code, 400)
})

test('un ménage PASSÉ sans personne n\'est jamais « proposition à venir »', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW. `dansLaFenetreDeProposition` est bornée des deux
  // côtés : un départ vieux de deux jours en sort aussi, et le ménage se
  // décrivait « le départ est encore loin » — pour un départ passé que personne
  // n'a fait. Depuis que la grille montre les sept jours écoulés, ce n'est plus
  // un cas rare, c'est une garantie.
  const vieux = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10)
  const { handler } = preparer({
    liaisons: [LIAISON({ provider_id: SECONDE, requires_ack: true, weekdays: [0, 1, 2, 3, 4, 5, 6] })],
    menages: [MENAGE({ departure_date: vieux, provider_id: null, status: 'unassigned' })]
  })
  const res = reponse()
  await handler(get(PASSE), res)
  assert.strictEqual(res.body.menages[0].differe, false, 'c\'est une alerte, pas une attente')
})

test('un ménage REFUSÉ reste « refusé », même hors fenêtre de proposition', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW. `orphaned` n'a ni porteur ni offre : dès que son
  // départ sort de la fenêtre, il satisfait aussi `differe`. L'écran testait
  // `differe` en premier et peignait en gris « proposition à venir » la décision
  // humaine que ce statut existe pour réclamer. Transposé sur la page V5
  // (étape 4), où la règle vit dans `etatPastille`.
  const front = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'pages/menages.html'), 'utf8')
  const i = front.indexOf('function etatPastille')
  assert.ok(i > 0)
  const bloc = front.slice(i, i + 700)
  assert.match(bloc, /m\.differe && m\.status !== 'orphaned'/,
    '`orphaned` échappe à `differe`, sinon un refus devient un report')
})

test('sur un jour à PLUSIEURS ménages, la case montre le plus grave', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW. La cellule ne montrait que le premier : un ménage
  // porté (✓) cachait un second que personne n'a (⚠). La grille est ce que
  // l'hôte parcourt pour repérer un problème. Transposé sur la page V5.
  const front = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'pages/menages.html'), 'utf8')
  assert.match(front, /const GRAVITE = /)
  assert.match(front, /GRAVITE\[etatPastille\(x\)\] > GRAVITE\[etatPastille\(pire\)\]/,
    'la case garde le plus grave des ménages du jour')
})

// ─── Le nommage du sous-menu (tranché le 5 septembre 2026) ─────────────────
// (voir aussi le sous-menu « Réservation directe », plus bas)

test('le sous-menu Ménages dit : Ménages · Prestataires', async () => {
  // ⚠ « Planning » désignait l'écran d'AFFECTATION, et le calendrier de garde
  // s'appelait « Garde » : deux plannings, dont aucun ne portait le mot au bon
  // endroit. Décision du product owner — « Ménages » = ce qu'on fait,
  // « Planning » = le calendrier. Ce test fige l'ordre ET les libellés : un
  // renommage partiel recréerait le doublon qu'on vient de lever.
  //
  // ⚠ ET LE DOUBLON S'EST LEVÉ TOUT SEUL À L'ÉTAPE 4 (14 octobre 2026) : les
  // DEUX anciens écrans sont devenus des redirections vers `/menages`, qui
  // porte le calendrier ET les gestes. Il ne reste qu'une entrée « Ménages » —
  // ce que le renommage de septembre cherchait déjà à obtenir — plus la fiche
  // des prestataires, qui vit encore (la récurrence A/B y est saisie).
  const sidebar = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'components/sidebar.js'), 'utf8')
  // ⚠ La borne de fin s'arrete a la BRANCHE SUIVANTE, pas au prochain `return`.
  // Une app ajoutee apres « menages » dans la meme chaine de `else if` tombait
  // sinon dans la tranche, et son sous-menu comptait pour un libelle de menage
  // (constate a l'ajout de « Reservation directe »).
  const debut = sidebar.indexOf("app.id === 'menages'")
  const suivante = sidebar.indexOf("} else if (app.id ===", debut)
  const retour = sidebar.indexOf('return `', debut)
  const fin = suivante !== -1 ? Math.min(suivante, retour) : retour
  const bloc = sidebar.slice(debut, fin)
  const libelles = [...bloc.matchAll(/><\/div>([A-Za-zÀ-ÿ]+)/g)].map(m => m[1])
  assert.deepStrictEqual(libelles, ['Ménages', 'Prestataires'])
  // Et chacun pointe où il faut. « Ménages » mène à la page V5 ; plus aucune
  // entrée ne mène aux deux anciens écrans, qui sont des redirections.
  assert.match(bloc, /href="\/menages"/, '« Ménages » mène à la page V5')
  assert.ok(!/href="\/apps\/menages"/.test(bloc), 'ni vers l\'ancien planning ménage')
  assert.ok(!/href="\/apps\/menages\/garde"/.test(bloc), 'ni vers l\'ancien planning de garde')
})

test('les anciennes URL de ménage mènent toujours quelque part', async () => {
  // ⚠ Un lien envoyé par SMS ou mis en favori doit continuer d'ouvrir une page
  // utile : un renommage d'étiquette ne casse pas d'adresse, et une refonte non
  // plus. À l'étape 4 (14 octobre 2026), l'ancien planning ménage est devenu
  // une redirection — l'adresse vit encore, elle mène à la page V5.
  const lire = f => require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', f), 'utf8')
  assert.match(lire('apps/menages/index.html'), /location\.replace\('\/menages'\)/,
    'l\'ancienne adresse du planning ménage mène à la page V5')
  // Et `/menages` existe vraiment : c'est une réécriture, pas un fichier.
  const vercel = JSON.parse(lire('vercel.json'))
  const r = (vercel.rewrites || []).find(x => x.source === '/menages')
  assert.ok(r && r.destination === '/pages/menages', 'la réécriture /menages existe')
  // ⚠ ET L'ANCIEN PLANNING DE GARDE AUSSI : son adresse survit, elle mène à la
  // page V5. Plus aucune entrée de menu n'y conduit — c'est voulu — mais un
  // favori ou un lien d'e-mail, si.
  assert.match(lire('apps/menages/garde.html'), /location\.replace\('\/menages'\)/,
    'l\'ancienne adresse du planning de garde mène à la page V5')
})

test('les anciens écrans ménage sont des REDIRECTIONS, pas des pages oubliées', async () => {
  // ⚠ CE TEST A CHANGÉ D'OBJET À L'ÉTAPE 4 (14 octobre 2026). Il figeait les
  // titres des deux anciens écrans (« HôteSmart — Planning », « — Ménages »)
  // pour qu'ils suivent le menu sans se répéter. Les deux écrans sont devenus
  // des redirections vers `/menages` : il n'y a plus de titre à tenir, et le
  // titre de la page qui les remplace est tenu avec les autres écrans V5.
  //
  // Ce qui reste à garder, et qui compte autant : qu'ils redirigent VRAIMENT.
  // Une page vidée de son contenu mais sans redirection serait un écran blanc
  // au bout d'un favori.
  const lire = f => require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', f), 'utf8')
  for (const f of ['apps/menages/index.html', 'apps/menages/garde.html']) {
    const html = lire(f)
    assert.match(html, /location\.replace\('\/menages'\)/, `${f} ne redirige pas`)
    // ⚠ ET ELLE DIT POURQUOI : le commentaire de tête est ce qui empêche
    // qu'on recrée l'écran dans six mois sans savoir ce qu'il portait.
    assert.match(html, /étape 4/, `${f} ne dit pas d'où vient sa redirection`)
  }
})

// ─── Le prénom en entier (5 septembre 2026) ────────────────────────────────

test('la ligne Garde écrit le PRÉNOM, plus une initiale', async () => {
  // ⚠ Décision du product owner : une initiale ne distingue pas deux Marie, et
  // c'est la lecture la plus fréquente de l'écran. Transposé sur la page V5
  // (étape 4) : la barre d'une prestataire porte son prénom entier.
  const front = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'pages/menages.html'), 'utf8')
  assert.ok(!front.includes('function initialeDe'), 'plus de réduction à une lettre')
  // ⚠ L'ellipse est CSS : couper à N caractères en JS tranche au milieu d'un
  // accent composé — « Régina » y devient « Re… » — et ignore la largeur réelle
  // de la case, qui change avec l'écran.
  assert.ok(!/\.slice\(0,\s*\d+\)\s*\+\s*'…'/.test(front), 'aucune troncature en JavaScript')
  const css = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'shared/ui.css'), 'utf8')
  assert.match(css, /text-overflow: ellipsis/, 'c\'est le CSS qui coupe')
})

test('la largeur de case vient du CSS partagé, jamais recopiée en JS', async () => {
  // ⚠ Deux sources pour une même mesure, c'est la garantie qu'elles divergent :
  // la grille se décale d'un pixel, puis d'un jour. La page V5 reprend la
  // grille du calendrier (`shared/calendar-core.js`) et sa largeur de case.
  const front = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'pages/menages.html'), 'utf8')
  assert.ok(!/largeurCase\s*=\s*\d+/.test(front), 'jamais une largeur recopiée en JS')
  assert.ok(!/CELL_W\s*=\s*\d+/.test(front), 'ni une constante de case propre à cet écran')
  // ⚠ La grille vient du noyau partagé : c'est LUI qui porte la mesure.
  assert.match(front, /from '\/shared\/calendar-core\.js'/)
  // ⚠ ET LA BASCULE RESPONSIVE N'EST PAS UNE LARGEUR DE CASE : `matchMedia`
  // décide d'une mise en page, pas de la taille d'une colonne. La distinguer
  // évite un garde-fou qui crie sur du code juste.
  assert.match(front, /matchMedia\('\(min-width: 900px\)'\)/, 'un seuil de mise en page, lui, est légitime')
})

test('une seule infobulle, et elle dit le BIEN autant que la personne', async () => {
  // ⚠ Deux `title` imbriqués : le navigateur montre celui de l'élément survolé,
  // donc celui de la pastille — qui ne portait que le prénom, pas le nom du
  // bien. L'hôte aurait survolé une case rouge pour n'y lire qu'un prénom.
  // Transposé sur la page V5 (étape 4) : c'est la CASE qui porte l'infobulle,
  // et elle agrège les ménages du jour.
  const front = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'pages/menages.html'), 'utf8')
  assert.match(front, /const titres = ms\.map\(infobulle\)/,
    'la case agrège les ménages du jour en une seule infobulle')
  assert.match(front, /class="men-case"[\s\S]{0,80}title="\$\{esc\(titres\)\}"/,
    'et c\'est la case qui la porte')
  // ⚠ ET LA PASTILLE N'EN A PAS : deux `title` imbriqués, et le navigateur ne
  // montre que celui du plus profond.
  const marques = front.slice(front.indexOf('const retour = (e === \'fait\''), front.indexOf('const titres ='))
  assert.ok(!/class="men-mk"[\s\S]{0,60}title=/.test(marques), 'aucun `title` sur la pastille')
  // La fabrique nomme le bien ET la personne.
  const i = front.indexOf('function infobulle')
  assert.ok(i > 0)
  const bloc = front.slice(i, i + 900)
  assert.match(bloc, /nomOu\(qui/, 'la personne y est nommée')
  assert.match(bloc, /dateLongue\(m\.date\)/, 'et le jour aussi')
})

test('un `resize` ne ramène pas l\'hôte sur aujourd\'hui', async () => {
  // ⚠ Elle regarde novembre, elle tourne son téléphone, et l'écran revient sur
  // aujourd'hui : le travail de navigation est perdu. Transposé sur la page V5
  // (étape 4) — elle ne repeint QUE si la catégorie de largeur a changé, et
  // ne touche jamais à la période choisie.
  const front = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'pages/menages.html'), 'utf8')
  const i = front.indexOf("window.addEventListener('resize'")
  assert.ok(i > 0)
  const bloc = front.slice(i, i + 260)
  assert.match(bloc, /if \(estLarge\(\) !== large\)/,
    'rien ne bouge tant que la largeur reste dans la même catégorie')
  assert.ok(!/charger\(\)|jourCourant|aujourdhui =/.test(bloc),
    'et jamais un rechargement ni un retour à aujourd\'hui')
})


// ─── L'app « Réservation directe » (nom gravé le 7 septembre 2026) ─────────

test('l app de reservation directe porte son nom grave, pas un nom de marque', () => {
  // Spec §3 ter : « un libelle qui dit ce que ca fait ». « BookFlow » ecarte.
  const config = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'shared/config.js'), 'utf8')
  assert.match(config, /id: 'reservation-directe'[^}]*name: 'Réservation directe'/)
  assert.ok(!/BookFlow/i.test(config), 'aucun nom invente ne doit reapparaitre')
})

test('le sous-menu de la reservation directe n existe QUE pour le titulaire', () => {
  // La cle Stripe releve de `facturation`, non delegable : un collaborateur ne
  // branche pas le compte qui recoit l'argent. Les liens et les conditions
  // d'annulation reglent la VENTE : meme traitement tant que la delegation du
  // moteur n'est pas tranchee.
  const sidebar = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'components/sidebar.js'), 'utf8')
  const debut = sidebar.indexOf("app.id === 'reservation-directe'")
  assert.ok(debut > 0, 'la branche de l app doit exister')
  const bloc = sidebar.slice(debut, sidebar.indexOf('return `', debut))
  assert.match(bloc, /subMenu = titulaire \?/, 'le sous-menu doit etre garde par `titulaire`')
  const libelles = [...bloc.matchAll(/><\/div>([A-Za-zÀ-ÿ]+)/g)].map(m => m[1])
  assert.deepStrictEqual(libelles, ['Liens', 'Paiements'])
  assert.match(bloc, /href="\/apps\/reservation-directe"/)
  assert.match(bloc, /href="\/apps\/reservation-directe\/paiements"/)
})

// ─── Lot Ménages V5, étape 1 : la photo du bien et la vérité « fait » ────────

test('chaque bien porte sa photo de couverture, null quand il n\'en a pas', async () => {
  const { handler } = preparer({
    biens: [{ provider_property_id: BIEN, name: 'La bulle', photo_url: 'https://x/p.jpg' },
            { provider_property_id: '209414', name: 'Sans photo' }],
    liaisons: [LIAISON()]
  })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.biens[0].photo, 'https://x/p.jpg')
  assert.strictEqual(res.body.biens[1].photo, null, 'une absence est null, jamais une chaîne vide')
})

test('un ménage présent dans menage_done sort `fait: true` — la vérité SERVEUR, pas le localStorage', async () => {
  const { handler } = preparer({
    liaisons: [LIAISON()],
    menages: [MENAGE(), MENAGE({ booking_id: 'b2', departure_date: '2026-09-13' })],
    done: [{ property_id: BIEN, booking_id: 'b1', departure_date: '2026-09-12' }]
  })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.code, 200)
  const parBooking = Object.fromEntries(res.body.menages.map(m => [m.bookingId, m.fait]))
  assert.strictEqual(parBooking.b1, true)
  assert.strictEqual(parBooking.b2, false)
})

test('une panne de menage_done ne coupe PAS le planning : les ménages sortent, aucun n\'est dit fait', async () => {
  // Même règle que l'annuaire : sans « fait », l'écran reste JUSTE (un ménage
  // fait redevient « à faire », défaut visible) — rien à voir avec les
  // liaisons, dont l'absence rendrait la garde fausse.
  const { handler } = preparer({
    liaisons: [LIAISON()], menages: [MENAGE()],
    erreurDone: { message: 'boom' }
  })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.menages.length, 1)
  assert.strictEqual(res.body.menages[0].fait, false)
})

// ─── Lot Ménages V5, étape 3 : l'annuaire pour « changer la prestataire » ───

test('la liste des prestataires ACTIVES sort, triée, sous `prestataires: read`', async () => {
  const { handler } = preparer({ liaisons: [LIAISON()],
    profils: [{ id: SECONDE, first_name: 'Marie', active: true },
              { id: REGINA, first_name: 'Régina', active: true },
              { id: 'p-off', first_name: 'Partie', active: false }] })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.code, 200)
  assert.deepStrictEqual(res.body.prestataires,
    [{ id: SECONDE, prenom: 'Marie' }, { id: REGINA, prenom: 'Régina' }],
    'les actives, par prénom — une désactivée ne s\'assigne pas')
})

test('sans `prestataires: read`, la liste est VIDE — pas un identifiant', async () => {
  const { handler } = preparer({
    user: MEMBRE,
    profil: { id: 'pr1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { menages: 'read', prestataires: 'none', property_scope: 'all' },
    liaisons: [LIAISON()]
  })
  const res = reponse()
  await handler({ ...get(), headers: { authorization: 'Bearer jeton', 'x-compte': PROD } }, res)
  assert.strictEqual(res.code, 200)
  assert.deepStrictEqual(res.body.prestataires, [])
})

// ─── Lot Ménages V5, étape 3 : les étapes de la fiche ────────────────────────

test('la fiche reçoit les TROIS étapes réellement enregistrées, et pas une de plus', async () => {
  // Q1 de l'inventaire : `started` / `completed` existent au schéma mais aucun
  // code ne les écrit. La fiche n'invente pas d'étape qu'on ne sait pas dater.
  const { handler } = preparer({
    liaisons: [LIAISON()],
    menages: [MENAGE({ offered_at: '2026-09-05T10:00:00Z', accepted_at: '2026-09-05T18:30:00Z' })],
    done: [{ property_id: BIEN, booking_id: 'b1', departure_date: '2026-09-12',
             done_at: '2026-09-12T11:00:00Z', done_by_token: 'tok-r' }]
  })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.code, 200)
  const e = res.body.menages[0].etapes
  assert.strictEqual(e.propose, '2026-09-05T10:00:00Z')
  assert.strictEqual(e.pris, '2026-09-05T18:30:00Z')
  assert.strictEqual(e.fait, '2026-09-12T11:00:00Z')
  assert.strictEqual(e.parElle, true, 'marqué par la prestataire : son jeton était posé')
})

test('le JETON de la prestataire ne sort jamais — seulement la réponse « est-ce elle »', async () => {
  const { handler } = preparer({
    liaisons: [LIAISON()], menages: [MENAGE()],
    done: [{ property_id: BIEN, booking_id: 'b1', departure_date: '2026-09-12',
             done_at: '2026-09-12T11:00:00Z', done_by_token: 'SECRET-abc' }]
  })
  const res = reponse()
  await handler(get(), res)
  assert.ok(!JSON.stringify(res.body).includes('SECRET-abc'), 'le secret d\'accès ne traverse pas')
  assert.strictEqual(res.body.menages[0].etapes.parElle, true)
})

test('un ménage marqué par l\'HÔTE se distingue de celui marqué par elle', async () => {
  const { handler } = preparer({
    liaisons: [LIAISON()], menages: [MENAGE()],
    done: [{ property_id: BIEN, booking_id: 'b1', departure_date: '2026-09-12',
             done_at: '2026-09-12T11:00:00Z', done_by_token: null }]
  })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.body.menages[0].etapes.parElle, false)
})

test('la fiche reçoit la NOTE existante — sans elle, l\'enregistrer l\'effacerait', async () => {
  // La fiche ouvre un champ de note. S'il s'affiche vide alors qu'une consigne
  // existe, le premier enregistrement la remplace par du vide, et la
  // prestataire perd « le code de la boîte a changé ».
  const { handler } = preparer({
    liaisons: [LIAISON()], menages: [MENAGE()],
    notes: [{ booking_id: 'b1', departure_date: '2026-09-12', comment: 'Code porte : 4521' }]
  })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.menages[0].note, 'Code porte : 4521')
})

test('un ménage sans note porte une chaîne vide, jamais `undefined`', async () => {
  const { handler } = preparer({ liaisons: [LIAISON()], menages: [MENAGE()] })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.body.menages[0].note, '')
})

// ─── « Elle a valide ce menage », pour l'alerte « Non valide » ─────────────
//
// ⚠ CE QUI EST EN JEU. Depuis le 14 octobre 2026, c'est `vuLe` — pose par le
// bouton « Vu » de sa page — qui decide de l'alerte « Non valide », et plus la
// derniere ouverture de son lien. Un serveur qui ne sert pas ce champ fait
// TAIRE l'alerte (`nonVuPar` rend `null` sur `undefined`, exprès : on ne crie
// pas sur une absence de donnee). Ce test est ce qui empeche ce silence.

test('chaque menage dit s\'il a ete valide — `null` est une REPONSE, pas un oubli', async () => {
  const { handler } = preparer({ liaisons: [LIAISON()], menages: [MENAGE({ vu_le: null })] })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(res.body.menages[0], 'vuLe'), true,
    'absent du corps, l\'alerte « Non valide » se tait entierement')
  assert.strictEqual(res.body.menages[0].vuLe, null)
})

test('... et la date quand elle a valide', async () => {
  const { handler } = preparer({
    liaisons: [LIAISON()],
    menages: [MENAGE({ vu_le: '2026-09-11T06:30:00Z', vu_par: REGINA })] })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.body.menages[0].vuLe, '2026-09-11T06:30:00Z')
})

test('la validation de la porteuse PRECEDENTE ne compte pas (constat de 20fb83d)', async () => {
  // ⚠ UN MENAGE CHANGE DE MAIN : l'hote reassigne, une collegue accepte, le
  // moteur pose une remplacante apres un refus. Le `vu_le` de la precedente
  // restait colle au menage, et l'hote lisait « A jour » sur quelqu'un qui
  // n'avait jamais rien lu — le trou meme que ce lot existe pour fermer,
  // rouvert par le geste le plus courant de l'hote.
  const { handler } = preparer({
    liaisons: [LIAISON()],
    menages: [MENAGE({ provider_id: REGINA, vu_le: '2026-09-11T06:30:00Z', vu_par: 'p-lena' })] })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.body.menages[0].vuLe, null,
    'la date d\'une autre personne vaut « non valide », pas « a jour »')
})

test('une colonne de validation ABSENTE ne coupe pas la garde (constat de 20fb83d)', async () => {
  // ⚠ LA MIGRATION SE COLLE A LA MAIN, APRES LE PUSH. Entre les deux, un
  // `select` qui nomme `vu_le` echoue EN ENTIER (42703) : cet endpoint rendait
  // 503, donc bulle, calendrier de garde et fiche prestataire morts pour
  // l'hote. On relit sans la colonne, et l'alerte se tait — elle ne coupe pas.
  const { handler } = preparer({
    liaisons: [LIAISON()], menages: [MENAGE()],
    erreurColonneMenages: { code: '42703', message: 'column menages.vu_le does not exist' } })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.code, 200, 'la page de l\'hote tient')
  assert.strictEqual(res.body.menages.length, 1, 'et les menages sont servis')
  assert.strictEqual(Object.prototype.hasOwnProperty.call(res.body.menages[0], 'vuLe'), false,
    'le champ est ABSENT : `undefined` fait taire l\'alerte, `null` l\'allumerait')
})

// ─── « Derniere ouverture de sa page », pour la PROPOSITION non vue ─────────
//
// ⚠ CE QUI EST EN JEU. Le type `pas_vu` de la bulle « A traiter » ne lit que
// cette carte. Trois facons de la rendre nuisible : laisser sortir le JETON
// (c'est son mot de passe), confondre « jamais ouverte » avec « on ne sait
// pas » (une alerte sur toute l'equipe), et se taire sur une panne de lecture
// (la meme alerte, mais a cause d'un timeout).

test('la derniere ouverture sort par PERSONNE, et le jeton ne sort pas', async () => {
  const { handler } = preparer({
    liaisons: [LIAISON()],
    profils: [{ id: REGINA, first_name: 'Régina', active: true, pwa_token: 'jeton-secret' }],
    jetons: [{ token: 'jeton-secret', pwa_vue_le: '2026-10-13T18:09:00Z' }]
  })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.body.vues_lues, true)
  assert.strictEqual(res.body.vues[REGINA], '2026-10-13T18:09:00Z')
  assert.ok(!JSON.stringify(res.body).includes('jeton-secret'), 'le jeton sert a joindre, pas a sortir')
})

test('un lien JAMAIS ouvert rend `null` — ce n\'est pas « on ne sait pas »', async () => {
  const { handler } = preparer({
    liaisons: [LIAISON()],
    profils: [{ id: REGINA, first_name: 'Régina', active: true, pwa_token: 'tok-r' }],
    jetons: [{ token: 'tok-r', pwa_vue_le: null }]
  })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.body.vues_lues, true)
  assert.strictEqual(res.body.vues[REGINA], null, 'present et null : jamais ouverte')
  assert.ok(Object.prototype.hasOwnProperty.call(res.body.vues, REGINA))
})

test('une personne SANS ligne de jeton est ABSENTE de la carte, pas « jamais vue »', async () => {
  // Retiree de l'equipe : la ligne `public_tokens` est supprimee. Annoncer
  // « page jamais ouverte » sur un lien qui n'existe plus serait faux, et
  // ferait sonner une alerte qu'aucun geste ne peut eteindre.
  const { handler } = preparer({
    liaisons: [LIAISON()],
    profils: [{ id: REGINA, first_name: 'Régina', active: true, pwa_token: 'tok-r' }],
    jetons: []
  })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.body.vues_lues, true)
  assert.strictEqual(Object.prototype.hasOwnProperty.call(res.body.vues, REGINA), false)
})

test('une PANNE de lecture le DIT : `vues_lues: false`, et la carte reste vide', async () => {
  const { handler } = preparer({
    liaisons: [LIAISON()],
    profils: [{ id: REGINA, first_name: 'Régina', active: true, pwa_token: 'tok-r' }],
    erreurJetons: { message: 'timeout' }
  })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.body.vues_lues, false, 'sans ce drapeau, un timeout alertait sur toute l\'equipe')
  assert.deepStrictEqual(res.body.vues, {})
})

test('aucun jeton a lire n\'est PAS une panne', async () => {
  // Un compte sans aucune prestataire a lien : il n'y a rien a lire, et c'est
  // un etat normal — pas une lecture ratee.
  const { handler } = preparer({ liaisons: [LIAISON()], profils: [] })
  const res = reponse()
  await handler(get(), res)
  assert.strictEqual(res.body.vues_lues, true)
  assert.deepStrictEqual(res.body.vues, {})
})

test('sans `prestataires: read`, AUCUNE carte des ouvertures ne sort', async () => {
  // La carte est `{ profilId: instant }` : rendue sans le droit, elle livrerait
  // des identifiants stables de personnes — ce que `nommer()` refuse deja.
  const { handler } = preparer({
    user: MEMBRE,
    profil: { id: 'pr1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
    permissions: { menages: 'read', prestataires: 'none', avis: 'none', property_scope: 'all' },
    liaisons: [LIAISON()],
    profils: [{ id: REGINA, first_name: 'Régina', active: true, pwa_token: 'tok-r' }],
    jetons: [{ token: 'tok-r', pwa_vue_le: '2026-10-13T18:09:00Z' }]
  })
  const res = reponse()
  await handler({ ...get(), headers: { authorization: 'Bearer jeton', 'x-compte': PROD } }, res)
  assert.strictEqual(res.body.avec_noms, false)
  assert.deepStrictEqual(res.body.vues, {})
  assert.strictEqual(res.body.vues_lues, false)
})

test('la NOTE sort avec sa date : une consigne changee hier soir doit alerter', async () => {
  const { handler } = preparer({
    liaisons: [LIAISON()], menages: [MENAGE()],
    notes: [{ booking_id: 'b1', departure_date: '2026-09-12', comment: 'Le code a changé',
              updated_at: '2026-10-13T20:30:00Z' }]
  })
  const res = reponse()
  await handler(get(), res)
  const m = res.body.menages.find(x => x.note)
  assert.ok(m, 'la note est bien la')
  assert.strictEqual(m.noteLe, '2026-10-13T20:30:00Z')
})
