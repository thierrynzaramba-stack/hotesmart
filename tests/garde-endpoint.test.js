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
                     erreurLiaisons = null, erreurBiens = null, avis = [], erreurAvis = null } = {}) {
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
        if (table === 'menages') return { data: menages, error: null }
        if (table === 'profiles') return { data: profils, error: null }
        if (table === 'ota_reviews') return { data: erreurAvis ? null : avis, error: erreurAvis }
        return { data: [], error: null }
      }
      const chain = {
        select () { return chain },
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
    .join(__dirname, '..', 'apps/menages/garde.html'), 'utf8')
  assert.ok(!/function pouces/.test(front))
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
    .join(__dirname, '..', 'apps/menages/garde.html'), 'utf8')
  // ⚠ Depuis la refonte en grille, le délai vit dans l'infobulle et dans le
  // détail au clic : la case fait 34 px, aucun texte n'y tient. Mais il doit
  // TOUJOURS être quelque part.
  assert.match(front, /function delaiTexte/, 'et l\'écran doit le montrer')
  assert.match(front, /timeZone: 'Europe\/Paris'/, 'en heure de Paris, pas en UTC')
  assert.match(front, /délai dépassé/, 'et ne pas dire « avant » d\'une échéance passée')
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
    .join(__dirname, '..', 'apps/menages/garde.html'), 'utf8')
  assert.match(front, /non confié/, 'et le dire autrement qu\'en rouge')
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
    .join(__dirname, '..', 'apps/menages/garde.html'), 'utf8')
  assert.match(front, /proposition à venir/, 'et l\'écran ne doit pas crier au loup')
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
    .join(__dirname, '..', 'apps/menages/garde.html'), 'utf8')
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
  const front = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'apps/menages/garde.html'), 'utf8')
  assert.match(front, /g\.remplacante\.a_regler/, 'un filet de sécurité qui n\'existe pas doit se voir')
})

// ─── La refonte en grille (5 septembre 2026) ───────────────────────────────

test('l\'écran REPREND la grille du calendrier des tarifs, il ne la réinvente pas', async () => {
  // ⚠ Décision du product owner. Deux écrans qui montrent des jours et des biens
  // doivent se lire pareil : une seconde grammaire visuelle, c'est un second
  // apprentissage. Les primitives viennent du noyau partagé — réécrire `toISO`
  // ou la largeur de colonne ici, c'était garantir que les deux grilles se
  // décalent d'un pixel puis d'un jour.
  const front = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'apps/menages/garde.html'), 'utf8')
  assert.match(front, /from '\/shared\/calendar-core\.js'/, 'le noyau partagé')
  for (const marqueur of ['CELL_W', 'cal-controls', 'month-pills', 'month-band',
                          'scroll-shell', 'table class="cal"', 'row-label',
                          'weekend', 'today', 'month-start']) {
    assert.ok(front.includes(marqueur), `structure commune manquante : ${marqueur}`)
  }
})

test('AUCUNE information de la version précédente n\'a disparu', async () => {
  // ⚠ La refonte ne portait que sur la PRÉSENTATION : tout ce qui était dit
  // hier doit rester accessible, au survol ou au clic si la grille est trop
  // dense pour l'écrire. Ce test est la liste de ce qui ne doit pas se perdre.
  const front = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'apps/menages/garde.html'), 'utf8')
  const attendus = [
    'non confié',            // bien sans liaison : jamais rouge
    'personne de garde',     // trou de garde
    'proposition à venir',   // hors fenêtre de proposition
    'jours à régler',        // responsable jamais sollicitée
    'désactivée',            // profil désactivé
    'réponse avant',         // délai d'une proposition
    'délai dépassé',         // échéance passée
    'refusé',                // orphaned
    'retour privé',          // extrait venu d'un message privé
    'requalifié par vous',   // requalification humaine
    'retour-extrait',        // la phrase du voyageur
    'Liste incomplète',      // troncature dite
    'quelqu\'un'             // sans `prestataires: read`
  ]
  for (const a of attendus) {
    assert.ok(front.includes(a), `information perdue à la refonte : « ${a} »`)
  }
})

test('la grille reste DENSE : le retour de propreté n\'y est pas en pavé', async () => {
  // ⚠ Un extrait par cellule ruinerait la densité, qui est tout l'intérêt d'un
  // calendrier. La case porte un 👍/👎 discret ; la phrase est au clic.
  const front = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'apps/menages/garde.html'), 'utf8')
  const grille = front.slice(front.indexOf('function caseMenage'),
                             front.indexOf('function titreGarde'))
  assert.ok(!grille.includes('retour-extrait'), 'pas d\'extrait dans la case')
  assert.match(grille, /avis-ok|avis-ko/, 'mais un marqueur discret')
  assert.match(front, /function ouvrirDetail/, 'et le détail au clic')
})

test('une garde à 6 ou 12 mois n\'est PAS proposée', async () => {
  // ⚠ Les règles de disponibilité auront changé bien avant : l'écran
  // afficherait une prévision présentée comme un fait. La borne serveur dit la
  // même chose (92 jours).
  const front = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'apps/menages/garde.html'), 'utf8')
  const select = front.slice(front.indexOf('id="period-select"'),
                             front.indexOf('</select>'))
  assert.ok(!select.includes('value="6"') && !select.includes('value="12"'))
  assert.ok(select.includes('value="1"') && select.includes('value="3"'))
})

test('la fenêtre que l\'écran DEMANDE VRAIMENT est acceptée', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW, et il rendait « 3 mois » totalement inopérant :
  // le front demandait 90 + 7 = 97 jours, le serveur en accepte 92, et l'écran
  // affichait « Service indisponible ». Mon test précédent prenait une fenêtre
  // de 91 jours que l'écran ne demande jamais : il était vert pendant que la
  // fonctionnalité était morte. On dérive donc les bornes de la MÊME formule que
  // le front, en la relisant dans le fichier.
  const front = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'apps/menages/garde.html'), 'utf8')
  const avant = Number(/const JOURS_AVANT = (\d+)/.exec(front)[1])
  const maxFront = Number(/const MAX_JOURS = (\d+)/.exec(front)[1])
  assert.ok(front.includes('Math.min(MAX_JOURS'), 'le front doit borner sa fenêtre')

  for (const mois of [1, 3]) {
    const n = Math.min(maxFront, Math.round(mois * 30) + avant)
    const t = new Date(); t.setHours(0, 0, 0, 0)
    const debut = new Date(t); debut.setDate(t.getDate() - avant)
    const fin = new Date(debut); fin.setDate(debut.getDate() + n - 1)
    const { handler } = preparer({ liaisons: [LIAISON()] })
    const res = reponse()
    await handler(get({ du: debut.toISOString().slice(0, 10),
                        au: fin.toISOString().slice(0, 10) }), res)
    assert.strictEqual(res.code, 200, `période de ${mois} mois (${n} jours) refusée`)
  }
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
  // humaine que ce statut existe pour réclamer.
  const front = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'apps/menages/garde.html'), 'utf8')
  const bloc = front.slice(front.indexOf('function etatMenage'), front.indexOf('const MARQUEUR'))
  assert.ok(bloc.indexOf("'orphaned'") < bloc.indexOf('m.differe'),
    '`orphaned` doit être testé AVANT `differe`')
})

test('sur un jour à PLUSIEURS ménages, la case montre le plus grave', async () => {
  // ⚠ DÉFAUT TROUVÉ EN REVIEW. La cellule ne montrait que le premier : un ménage
  // porté (✓) cachait un second que personne n'a (⚠). La grille est ce que
  // l'hôte parcourt pour repérer un problème.
  const front = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'apps/menages/garde.html'), 'utf8')
  assert.match(front, /const GRAVITE = /)
  assert.match(front, /GRAVITE\[e\] > GRAVITE\[etat\]/)
})
