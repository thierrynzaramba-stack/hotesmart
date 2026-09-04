// tests/menages-endpoint.test.js
// api/menages.js — planning menage de l'hote (ecart E1 : dual-provider).

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

function chargerEndpoint({ props = [], snaps = [], user = { id: 'u1' }, propErr = null, snapErr = null,
                          menages = [], prestataires = [] }) {
  const etat = { requetes: [], parTable: {} }
  const par = nom => (etat.parTable[nom] = etat.parTable[nom] || {})
  const client = {
    auth: { getUser: async () => (user ? { data: { user }, error: null } : { data: null, error: { message: 'invalide' } }) },
    from(nom) {
      const q = {
        _nom: nom,
        select() { return q }, eq(c, v) { etat.requetes.push({ table: nom, col: c, val: v }); return q },
        not() { return q }, in() { return q },
        order(c) { par(nom).order = c; etat.order = c; return q },
        // `or` : filtre de perimetre pose par la garde (etape 3). Le titulaire
        // n'en recoit pas ; le double l'accepte pour ne pas casser sur un membre.
        or(e) { etat.filtreOr = e; return q },
        // ⚠ ENREGISTRE PAR TABLE. Une variable unique gardait la DERNIERE requete
        // du handler : des qu'il a interroge `menages` et `profiles` apres les
        // snapshots, les assertions sur les bornes SQL du planning lisaient le
        // tri de `profiles`. Les tests tombaient pour une raison fausse — et
        // auraient pu passer pour une raison fausse aussi.
        gte(c, v) { par(nom).gte = { col: c, val: v }; etat.gte = { col: c, val: v }; return q },
        lte(c, v) { par(nom).lte = { col: c, val: v }; etat.lte = { col: c, val: v }; return q },
        limit(n) { par(nom).limit = n; etat.limit = n; return q },
        // ⚠ `neq` est HONORE comme le reste : sans lui, le double levait un
        // TypeError que le catch de l'endpoint transformait en 500 — un test
        // rouge pour une raison qui n'a rien a voir avec ce qu'il verifie.
        neq(c, v) { etat.neq = { col: c, val: v }; return q },
        // La garde de droits lit profiles / profile_permissions : sans profil,
        // l'appelant est titulaire de son propre compte, ce que testent ces cas.
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        then(res, rej) {
          const r = nom === 'properties'
            ? { data: props, error: propErr }
            : nom === 'menages'
              ? { data: menages, error: null }
              // `profiles` sert DEUX usages ici : la garde de droits (qui attend
              // null pour reconnaitre un titulaire) et la liste des prestataires
              // du selecteur. Le second passe par `then`, le premier par
              // `maybeSingle` — d'ou deux valeurs differentes, volontairement.
              : nom === 'profiles'
                ? { data: prestataires, error: null }
                : nom === 'profile_permissions'
                  ? { data: null, error: null }
                  : { data: snaps, error: snapErr }
          return Promise.resolve(r).then(res, rej)
        }
      }
      return q
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs)
  m.exports = { createClient: () => client }
  m.loaded = true
  require.cache[abs] = m

  // ⚠ La garde de droits cree SON PROPRE client supabase au chargement du module.
  // Ne vider que le cache de l'endpoint la laissait sur un client d'un test
  // precedent : la session invalide passait, et le test lisait 200 au lieu de 401.
  for (const mod of ['../lib/require-permission', '../lib/permissions', '../api/menages']) {
    try { delete require.cache[require.resolve(mod)] } catch {}
  }
  return { handler: require('../api/menages'), etat }
}

function reponse() {
  const r = { code: null, body: null }
  r.status = (c) => { r.code = c; return r }
  r.json = (b) => { r.body = b; return r }
  return r
}
const req = (headers = { authorization: 'Bearer tok' }, query = {}) => ({ method: 'GET', headers, query })

const snap = (o = {}) => ({
  booking_id: '77', property_id: '12345',
  snapshot: { provider: 'beds24', status: 'confirmed', arrival: '2026-09-01', departure: '2026-09-05',
              firstName: 'Jean', lastName: 'Dupont', numAdult: 2, numChild: 0, ...o }
})

test('auth : sans token -> 401', async () => {
  const { handler } = chargerEndpoint({})
  const res = reponse()
  await handler(req({}), res)
  assert.strictEqual(res.code, 401)
})

test('auth : session invalide -> 401', async () => {
  const { handler } = chargerEndpoint({ user: null })
  const res = reponse()
  await handler(req(), res)
  assert.strictEqual(res.code, 401)
})

const PRESTA = [{ id: 'p1', first_name: 'Régina', active: true, pwa_token: null,
                 phone: '0600000000', email: 'regina@exemple.fr' }]

test('CONTACTS : sans `contacts=1`, ni téléphone ni email ne sortent', async () => {
  // ⚠ Le planning (`apps/menages/index.html`) appelle le meme endpoint et ne lit
  // que `id`, `prenom` et `actif`. Les rendre a tout appelant donnait les
  // coordonnees personnelles de tout le personnel de menage a un delegue en
  // lecture seule, sur un ecran qui ne les affiche nulle part.
  const { handler } = chargerEndpoint({
    props: [{ provider_property_id: '12345', name: 'Bien', provider: 'beds24' }],
    prestataires: PRESTA })
  const res = reponse()
  await handler(req(), res)
  assert.strictEqual(res.code, 200)
  const p = res.body.prestataires[0]
  assert.strictEqual(p.prenom, 'Régina', 'l\'annuaire lui-meme reste rendu')
  assert.ok(!('telephone' in p), 'pas de telephone sans demande explicite')
  assert.ok(!('email' in p), 'pas d\'email sans demande explicite')
})

test('CONTACTS : avec `contacts=1`, la fiche prestataire les reçoit', async () => {
  const { handler } = chargerEndpoint({
    props: [{ provider_property_id: '12345', name: 'Bien', provider: 'beds24' }],
    prestataires: PRESTA })
  const res = reponse()
  await handler(req(undefined, { contacts: '1' }), res)
  assert.strictEqual(res.code, 200)
  const p = res.body.prestataires[0]
  assert.strictEqual(p.telephone, '0600000000')
  assert.strictEqual(p.email, 'regina@exemple.fr')
})

test('methode ni GET ni POST -> 405', async () => {
  // ⚠ POST n'est plus refuse : c'est la reassignation manuelle (spec §11.6).
  // Elle a sa propre garde — `prestataires: write` — testee juste en dessous.
  const { handler } = chargerEndpoint({})
  const res = reponse()
  await handler({ method: 'DELETE', headers: {}, query: {} }, res)
  assert.strictEqual(res.code, 405)
})

test('reassignation : sans session -> 401, jamais 405', async () => {
  // Un 405 laisserait croire que la reassignation n'existe pas ; le vrai motif
  // du refus est l'absence de session.
  const { handler } = chargerEndpoint({})
  const res = reponse()
  await handler({ method: 'POST', headers: {}, query: {}, body: {} }, res)
  assert.strictEqual(res.code, 401)
})

test('E1 : un bien CHANNEX apparait au planning', async () => {
  const { handler } = chargerEndpoint({
    props: [{ provider_property_id: 'uuid-channex', name: 'Colomiers', provider: 'channex' }],
    snaps: [{ booking_id: 'b1', property_id: 'uuid-channex',
              snapshot: { provider: 'channex', status: 'confirmed', arrival: '2026-09-01', departure: '2026-09-05', firstName: 'Marie', lastName: 'Martin', numAdult: 2, numChild: 1 } }]
  })
  const res = reponse()
  await handler(req(), res)
  assert.strictEqual(res.code, 200)
  assert.strictEqual(res.body.properties.length, 1)
  assert.strictEqual(res.body.properties[0].provider, 'channex')
  assert.strictEqual(res.body.bookings.length, 1, 'le planning n\'est plus vide pour un hote Channex')
  assert.strictEqual(res.body.bookings[0].propName, 'Colomiers')
  assert.strictEqual(res.body.bookings[0].firstName, 'Marie')
})

test('les deux providers cohabitent dans le meme planning', async () => {
  const { handler } = chargerEndpoint({
    props: [
      { provider_property_id: '12345', name: 'Bien Beds24', provider: 'beds24' },
      { provider_property_id: 'uuid-cx', name: 'Bien Channex', provider: 'channex' }
    ],
    snaps: [
      snap(),
      { booking_id: 'b2', property_id: 'uuid-cx', snapshot: { provider: 'channex', status: 'new', arrival: '2026-09-10', departure: '2026-09-12', firstName: 'Ana', lastName: '', numAdult: 1, numChild: 0 } }
    ]
  })
  const res = reponse()
  await handler(req(), res)
  assert.strictEqual(res.body.bookings.length, 2)
  assert.deepStrictEqual(res.body.bookings.map(b => b.propName).sort(), ['Bien Beds24', 'Bien Channex'])
})

test('E5 : seuls les sejours ACTIFS apparaissent', async () => {
  const { handler } = chargerEndpoint({
    props: [{ provider_property_id: '12345', name: 'Bien', provider: 'beds24' }],
    snaps: [
      snap(),                                                  // confirmed -> visible
      { ...snap(), booking_id: '78', snapshot: { ...snap().snapshot, status: 'cancelled' } },
      { ...snap(), booking_id: '79', snapshot: { ...snap().snapshot, status: 'blocked' } },
      { ...snap(), booking_id: '80', snapshot: { ...snap().snapshot, status: 'request' } }
    ]
  })
  const res = reponse()
  await handler(req(), res)
  assert.strictEqual(res.body.bookings.length, 1, 'annulation, blocage et demande ecartes')
  assert.strictEqual(res.body.bookings[0].id, '77')
})

test('lignes anterieures a l\'unification : statut brut lu correctement', async () => {
  const { handler } = chargerEndpoint({
    props: [{ provider_property_id: '12345', name: 'Bien', provider: 'beds24' }],
    snaps: [
      // sans champ provider (ligne legacy) : 'new' Beds24 = reservation reelle
      { booking_id: '81', property_id: '12345', snapshot: { status: 'new', arrival: '2026-09-01', departure: '2026-09-05' } },
      { booking_id: '82', property_id: '12345', snapshot: { status: 'black', provider: 'beds24', arrival: '2026-09-01', departure: '2026-09-06' } }
    ]
  })
  const res = reponse()
  await handler(req(), res)
  assert.deepStrictEqual(res.body.bookings.map(b => b.id), ['81'], 'le blocage proprietaire reste exclu')
})

test('une reservation sans date de depart n\'est pas un menage', async () => {
  const { handler } = chargerEndpoint({
    props: [{ provider_property_id: '12345', name: 'Bien', provider: 'beds24' }],
    snaps: [{ ...snap(), snapshot: { ...snap().snapshot, departure: null } }]
  })
  const res = reponse()
  await handler(req(), res)
  assert.strictEqual(res.body.bookings.length, 0)
})

test('bornes from / to sur la date de depart', async () => {
  const base = {
    props: [{ provider_property_id: '12345', name: 'Bien', provider: 'beds24' }],
    snaps: [
      { ...snap(), booking_id: 'a', snapshot: { ...snap().snapshot, departure: '2026-09-05' } },
      { ...snap(), booking_id: 'b', snapshot: { ...snap().snapshot, departure: '2026-10-05' } }
    ]
  }
  let { handler } = chargerEndpoint(base)
  let res = reponse()
  await handler(req(undefined, { from: '2026-09-01', to: '2026-09-30' }), res)
  assert.deepStrictEqual(res.body.bookings.map(b => b.id), ['a'])

  ;({ handler } = chargerEndpoint(base))
  res = reponse()
  await handler(req(undefined, {}), res)
  assert.strictEqual(res.body.bookings.length, 2, 'sans bornes, tout remonte')
})

test('aucun bien -> reponse vide, pas d\'erreur', async () => {
  const { handler } = chargerEndpoint({ props: [] })
  const res = reponse()
  await handler(req(), res)
  assert.strictEqual(res.code, 200)
  assert.deepStrictEqual(res.body, { properties: [], bookings: [] })
})

test('ISOLATION : chaque lecture est filtree sur user_id', async () => {
  const { handler, etat } = chargerEndpoint({
    props: [{ provider_property_id: '12345', name: 'Bien', provider: 'beds24' }],
    snaps: [snap()]
  })
  await handler(req(), reponse())
  const filtres = etat.requetes.filter(r => r.col === 'user_id')
  assert.ok(filtres.some(r => r.table === 'properties'), 'properties filtre par user_id')
  assert.ok(filtres.some(r => r.table === 'bookings_snapshot'), 'bookings_snapshot filtre par user_id')
  assert.ok(filtres.every(r => r.val === 'u1'))
})

test('erreur de lecture -> 500, jamais un planning vide silencieux', async () => {
  const { handler } = chargerEndpoint({ props: [], propErr: { message: 'timeout' } })
  const res = reponse()
  await handler(req(), res)
  assert.strictEqual(res.code, 500)
})

// ─── Regression E5 sur les lignes ANTERIEURES a l'unification ───────────────
// Le cas reellement dangereux : statut brut SANS champ provider. Sans le
// provider du bien en 2e argument, canonicalStatus ne trouve aucune table de
// correspondance et retombe sur 'confirmed' — le menage fantome revient.

test('E5 legacy : un blocage Beds24 SANS champ provider reste exclu', async () => {
  const { handler } = chargerEndpoint({
    props: [{ provider_property_id: '12345', name: 'Bien', provider: 'beds24' }],
    snaps: [
      // Lignes telles que les ecrivait l'ancien writer : statut brut, pas de provider.
      { booking_id: 'black', property_id: '12345', snapshot: { status: 'black',   arrival: '2026-09-01', departure: '2026-09-06' } },
      { booking_id: 'req',   property_id: '12345', snapshot: { status: 'request', arrival: '2026-09-01', departure: '2026-09-07' } },
      { booking_id: 'inq',   property_id: '12345', snapshot: { status: 'inquiry', arrival: '2026-09-01', departure: '2026-09-08' } },
      { booking_id: 'ok',    property_id: '12345', snapshot: { status: 'new',     arrival: '2026-09-01', departure: '2026-09-05' } }
    ]
  })
  const res = reponse()
  await handler(req(), res)
  assert.deepStrictEqual(res.body.bookings.map(b => b.id), ['ok'],
    'blocage, demande et inquiry legacy ne doivent PAS produire de menage')
})

test('E5 legacy : un statut Channex brut sans provider est lu avec la bonne table', async () => {
  const { handler } = chargerEndpoint({
    props: [{ provider_property_id: 'uuid-cx', name: 'Bien Channex', provider: 'channex' }],
    snaps: [
      { booking_id: 'a', property_id: 'uuid-cx', snapshot: { status: 'modified',  arrival: '2026-09-01', departure: '2026-09-05' } },
      { booking_id: 'b', property_id: 'uuid-cx', snapshot: { status: 'cancelled', arrival: '2026-09-01', departure: '2026-09-06' } }
    ]
  })
  const res = reponse()
  await handler(req(), res)
  assert.deepStrictEqual(res.body.bookings.map(b => b.id), ['a'])
})

// ─── Bornes SQL : ne jamais subir la troncature PostgREST ───────────────────

test('les bornes from/to sont portees cote SQL, pas seulement en JS', async () => {
  const { handler, etat } = chargerEndpoint({
    props: [{ provider_property_id: '12345', name: 'Bien', provider: 'beds24' }],
    snaps: [snap()]
  })
  await handler(req(undefined, { from: '2026-09-01', to: '2026-09-30' }), reponse())
  // L'assertion vise la requete des SNAPSHOTS precisement : le handler en pose
  // d'autres (menages, prestataires) qui ont leurs propres bornes.
  assert.deepStrictEqual(etat.parTable['bookings_snapshot'].gte, { col: 'snapshot->>departure', val: '2026-09-01' })
  assert.deepStrictEqual(etat.parTable['bookings_snapshot'].lte, { col: 'snapshot->>departure', val: '2026-09-30' })
})

test('la lecture est toujours triee et bornee (cap PostgREST)', async () => {
  const { handler, etat } = chargerEndpoint({
    props: [{ provider_property_id: '12345', name: 'Bien', provider: 'beds24' }],
    snaps: [snap()]
  })
  await handler(req(), reponse())
  const q = etat.parTable['bookings_snapshot']
  assert.strictEqual(q.order, 'snapshot->>departure', 'ordre deterministe')
  assert.ok(q.limit > 0, 'limite explicite')
})

test('troncature signalee a l\'appelant plutot que subie', async () => {
  const beaucoup = Array.from({ length: 5000 }, (_, i) => ({
    booking_id: `b${i}`, property_id: '12345',
    snapshot: { provider: 'beds24', status: 'confirmed', arrival: '2026-09-01', departure: '2026-09-05' }
  }))
  const { handler } = chargerEndpoint({
    props: [{ provider_property_id: '12345', name: 'Bien', provider: 'beds24' }],
    snaps: beaucoup
  })
  const res = reponse()
  await handler(req(), res)
  assert.strictEqual(res.body.tronque, true)
})

test('lecture normale : tronque = false', async () => {
  const { handler } = chargerEndpoint({
    props: [{ provider_property_id: '12345', name: 'Bien', provider: 'beds24' }],
    snaps: [snap()]
  })
  const res = reponse()
  await handler(req(), res)
  assert.strictEqual(res.body.tronque, false)
})

// ─── Chrono par etape : une ligne de log en fin de requete ──────────────────

test('chrono : une ligne loguee avec le detail des etapes', async () => {
  const lignes = []
  const log = console.log
  console.log = (...a) => lignes.push(a.join(' '))
  try {
    const { handler } = chargerEndpoint({
      props: [{ provider_property_id: '12345', name: 'Bien', provider: 'beds24' }],
      snaps: [snap()]
    })
    await handler(req(), reponse())
  } finally { console.log = log }

  const ligne = lignes.find(l => l.startsWith('[menages]'))
  assert.ok(ligne, 'une ligne de chrono est loguee')
  for (const etape of ['auth=', 'properties=', 'snapshots=', 'mapping=', 'total=']) {
    assert.ok(ligne.includes(etape), `l'etape ${etape} est mesuree`)
  }
  assert.ok(/biens=1 resas=1/.test(ligne), 'les volumes sont reportes')
})

test('chrono : la sortie 401 est aussi tracee', async () => {
  const lignes = []
  const log = console.log
  console.log = (...a) => lignes.push(a.join(' '))
  try {
    const { handler } = chargerEndpoint({ user: null })
    await handler(req(), reponse())
  } finally { console.log = log }
  assert.ok(lignes.some(l => l.includes('[menages]') && l.includes('-> 401')))
})

test('chrono : les sorties 500 sont tracees aussi (cas le plus interessant)', async () => {
  for (const [cas, opts] of [
    ['properties', { props: [], propErr: { message: 'timeout' } }],
    ['snapshots',  { props: [{ provider_property_id: '12345', name: 'B', provider: 'beds24' }], snaps: [], snapErr: { message: 'statement timeout' } }]
  ]) {
    const lignes = []
    const log = console.log, err = console.error
    console.log = (...a) => lignes.push(a.join(' ')); console.error = () => {}
    try {
      const { handler } = chargerEndpoint(opts)
      const res = reponse()
      await handler(req(), res)
      assert.strictEqual(res.code, 500, cas)
    } finally { console.log = log; console.error = err }
    const l = lignes.find(x => x.startsWith('[menages]'))
    assert.ok(l, `chrono logue sur 500 ${cas}`)
    assert.ok(l.includes(`-> 500 ${cas}`), `motif de sortie identifie (${cas}) : ${l}`)
    assert.ok(l.includes('total='), 'la duree totale est reportee')
  }
})
