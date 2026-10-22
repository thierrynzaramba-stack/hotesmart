// tests/logement-endpoint.test.js
// GET /api/logement — LES GARDES, EPROUVEES PAR LE VRAI lib/require-permission.
//
// ⚠ Rien n'est simule de la garde elle-meme : seul le CLIENT Supabase est un
// double. Un test qui remplacerait `requirePermission` par un stub mesurerait
// mon stub, pas le produit — et c'est precisement une garde de ce fichier qui a
// laisse passer la creation d'un bien par un membre delegue le 19 octobre 2026.
//
// Les quatre qui comptent :
//   1. la fiche d'un bien d'un AUTRE compte ne se lit pas, meme avec son UUID ;
//   2. sur la liste, le perimetre d'un membre invite est un FILTRE — sans lui il
//      recoit le portefeuille complet du titulaire ;
//   3. une panne rend 503, jamais un 200 a liste vide ;
//   4. aucun identifiant du partenaire ne descend dans la reponse.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'cle-de-test'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'http://localhost:1/api/v1'
process.env.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY || 'cle-de-test'

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

const TITULAIRE = '11111111-1111-1111-1111-111111111111'
const MEMBRE    = '22222222-2222-2222-2222-222222222222'
const ETRANGER  = '33333333-3333-3333-3333-333333333333'
const BIEN_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const BIEN_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const BIEN_X = 'cccccccc-cccc-cccc-cccc-cccccccccccc'   // le bien d'un autre compte
const REF_A = '209413'
const REF_B = '552211'
const REF_X = '999999'

const bien = (id, user, ref, nom) => ({
  user_id: user, id, name: nom, city: 'Bagnères', country: 'FR', address: 'a',
  zip_code: '65200', capacity: 4, photo_url: null, currency: 'EUR', base_price: 120,
  prix_minimum: 60, included_guests: 2, extra_guest_fee: 15, rate_sync_mode: 'managed',
  pilote_tarifaire: false, automation_paused: false, inventory_type: 'whole',
  ota_listing_urls: null, created_at: '2026-01-01T00:00:00Z',
  provider: 'channex', provider_property_id: ref, migration_target_property_id: null,
  provider_rate_plan_id: 'RP-' + ref
})

const BIENS = [
  bien(BIEN_A, TITULAIRE, REF_A, 'La bulle'),
  bien(BIEN_B, TITULAIRE, REF_B, 'Cœur de vie 23'),
  bien(BIEN_X, ETRANGER, REF_X, 'Chez un autre')
]

const MODULES = ['../api/logement', '../lib/logement/lecture', '../lib/require-permission']

// Un `or` PostgREST, evalue comme la base l'evaluerait : `col.eq.v` et
// `col.in.(a,b)` separes par des virgules de premier niveau.
function passeOr (ligne, expr) {
  if (!expr) return true
  const branches = []
  let niveau = 0, courant = ''
  for (const c of expr) {
    if (c === '(') niveau++
    if (c === ')') niveau--
    if (c === ',' && niveau === 0) { branches.push(courant); courant = ''; continue }
    courant += c
  }
  if (courant) branches.push(courant)
  return branches.some(b => {
    const mEq = b.match(/^([a-z_]+)\.eq\.(.*)$/)
    if (mEq) return String(ligne[mEq[1]] == null ? '' : ligne[mEq[1]]) === mEq[2]
    const mIn = b.match(/^([a-z_]+)\.in\.\((.*)\)$/)
    if (mIn) return mIn[2].split(',').includes(String(ligne[mIn[1]] == null ? '' : ligne[mIn[1]]))
    return false
  })
}

function preparer ({ appelant = TITULAIRE, profils = [], permissions = [], avis = [],
  // Les tables que la purge de suppression efface, pour le COMPTAGE (étape 3).
  sejours = [], messages = [], menages = [], codes = [],
  enPanne = {}, enPanneApres = {} } = {}) {
  const vus = []
  const passages = {}
  const client = {
    auth: { getUser: async (t) => t ? ({ data: { user: { id: appelant } }, error: null }) : ({ data: null, error: { message: 'no' } }) },
    from (table) {
      const a = { table, f: {}, ins: [], or: null, limit: null, order: null, ordres: [], gte: {}, lte: {}, is: {} }
      vus.push(a)
      const donnees = () => {
        if (enPanne[table]) return { data: null, error: { message: enPanne[table] } }
        if (enPanneApres[table] != null) {
          passages[table] = (passages[table] || 0) + 1
          if (passages[table] > enPanneApres[table]) return { data: null, error: { message: 'timeout' } }
        }
        const source = { properties: BIENS, profiles: profils, profile_permissions: permissions,
          ota_reviews: avis, bookings_snapshot: sejours, messages: messages,
          menage_events: menages, access_codes: codes }[table] || []
        const c = source.filter(l =>
          Object.entries(a.f).every(([k, v]) => String(l[k]) === String(v)) &&
          a.ins.every(f => f.v.includes(String(l[f.c]))) &&
          passeOr(l, a.or))
        return { data: a.limit != null ? c.slice(0, a.limit) : c, error: null }
      }
      const chain = {
        // `count` / `head` honorés comme chez PostgREST (voir l'autre fichier) :
        // le comptage de la suppression ne lit aucune ligne.
        select (cols, opts) { if (opts && opts.count) { a.compte = true; a.head = opts.head === true } return chain },
        eq (c, v) { a.f[c] = v; return chain },
        in (c, v) { a.ins.push({ c, v: (v || []).map(String) }); return chain },
        gte (c, v) { a.gte[c] = v; return chain },
        lte (c, v) { a.lte[c] = v; return chain },
        is (c, v) { a.is[c] = v; return chain },
        or (e) { a.or = e; return chain },
        order (c, o) { a.ordres.push({ c, asc: !(o && o.ascending === false) }); a.order = a.ordres[0]; return chain },
        // Le plafond `max_rows = 1000` du serveur, simule comme dans l'autre
        // fichier de test : un double plus genereux que la base rend vertes des
        // gardes qui, en production, ne peuvent pas mordre.
        range (de, jusqu) {
          const r = donnees()
          if (r.error) return Promise.resolve(r)
          return Promise.resolve({ data: r.data.slice(de, de + Math.min(jusqu - de + 1, 1000)), error: null })
        },
        limit (n) { a.limit = n; const r = donnees(); return Promise.resolve(r.error ? r : { data: r.data.slice(0, Math.min(n, 1000)), error: null }) },
        maybeSingle () { const r = donnees(); return Promise.resolve({ data: r.data ? (r.data[0] || null) : null, error: r.error }) },
        then (f, g) {
          const r = donnees()
          if (!a.compte) return Promise.resolve(r).then(f, g)
          return Promise.resolve(r.error
            ? { data: null, error: r.error, count: null }
            : { data: a.head ? null : r.data, error: null, count: r.data.length }).then(f, g)
        }
      }
      return chain
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  // L'alarme du fondateur ne part pas en vrai appel reseau depuis un test.
  const absN = require.resolve(path.join(__dirname, '..', 'lib', 'founder-notify'))
  const mN = new Module(absN); mN.exports = { reportIncident: async () => ({ ok: true }) }; mN.loaded = true
  require.cache[absN] = mN
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
  try { require('../lib/cles-migrees')._vider() } catch {}
  return { vus }
}

const reponse = () => {
  const r = { code: null, body: null, entetes: {} }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = (k, v) => { r.entetes[k] = v }
  return r
}
const appeler = async (query = {}, headers = {}, method = 'GET') => {
  const res = reponse()
  await require('../api/logement')(
    { method, query, body: null, headers: { authorization: 'Bearer jeton', ...headers } }, res)
  return res
}

const profilDe = (compte, membre, extra = {}) => ({
  id: `prof-${membre}-${compte}`, account_user_id: compte, member_user_id: membre,
  active: true, accepted_at: '2026-01-01T00:00:00Z', ...extra
})
const droitsDe = (profileId, extra = {}) => ({
  profile_id: profileId, reservations: 'read', reglages: 'read',
  prestataires: 'read', avis: 'read', facturation: 'read',
  property_scope: 'all', property_ids: [], property_refs: [], ...extra
})

// ═══════════════════════════════════════════════════════════════════════════

test('une autre methode que GET est refusee : cet endpoint ne doit RIEN ecrire', async () => {
  preparer()
  for (const m of ['POST', 'PATCH', 'DELETE', 'PUT']) {
    const r = await appeler({}, {}, m)
    assert.equal(r.code, 405, `${m} doit etre refuse`)
  }
  assert.equal((await appeler({}, {}, 'GET')).code, 200)
})

test('sans jeton : 401, et aucune lecture de donnees', async () => {
  const { vus } = preparer()
  const res = reponse()
  await require('../api/logement')({ method: 'GET', query: {}, body: null, headers: {} }, res)
  assert.equal(res.code, 401)
  assert.ok(!vus.map(v => v.table).includes('properties'),
    'une requete sans jeton ne doit pas declencher de requete SQL — c est un oracle d existence')
})

test('le titulaire voit ses biens, et pas ceux des autres comptes', async () => {
  preparer()
  const r = await appeler()
  assert.equal(r.code, 200)
  assert.deepEqual(r.body.biens.map(b => b.nom).sort(), ['Cœur de vie 23', 'La bulle'])
})

test('LE TEST QUI COMPTE : le perimetre d un membre invite est un FILTRE sur la liste', async () => {
  preparer({
    appelant: MEMBRE,
    profils: [profilDe(TITULAIRE, MEMBRE)],
    permissions: [droitsDe(`prof-${MEMBRE}-${TITULAIRE}`, { property_scope: 'selected', property_refs: [REF_A] })]
  })
  const r = await appeler({}, { 'x-compte': TITULAIRE })
  assert.equal(r.code, 200)
  assert.deepEqual(r.body.biens.map(b => b.nom), ['La bulle'],
    'sans filtre, le membre recoit le portefeuille COMPLET du titulaire : noms, adresses, prix de base')
})

test('un membre au perimetre VIDE ne recoit rien', async () => {
  preparer({
    appelant: MEMBRE,
    profils: [profilDe(TITULAIRE, MEMBRE)],
    permissions: [droitsDe(`prof-${MEMBRE}-${TITULAIRE}`, { property_scope: 'selected', property_refs: [] })]
  })
  const r = await appeler({}, { 'x-compte': TITULAIRE })
  assert.equal(r.code, 200)
  assert.deepEqual(r.body.biens, [])
})

test('un membre SANS droit sur les reservations est refuse', async () => {
  preparer({
    appelant: MEMBRE,
    profils: [profilDe(TITULAIRE, MEMBRE)],
    permissions: [droitsDe(`prof-${MEMBRE}-${TITULAIRE}`, { reservations: 'none' })]
  })
  assert.equal((await appeler({}, { 'x-compte': TITULAIRE })).code, 403)
})

test('un X-Compte dont on n est pas membre actif est refuse', async () => {
  preparer({ appelant: MEMBRE, profils: [], permissions: [] })
  assert.equal((await appeler({}, { 'x-compte': TITULAIRE })).code, 403)
})

test('LE TEST QUI COMPTE : la fiche d un bien d un AUTRE compte ne se lit pas', async () => {
  preparer()  // appelant = TITULAIRE, BIEN_X appartient a ETRANGER
  const r = await appeler({ id: BIEN_X })
  assert.equal(r.code, 403, 'le bien designe le compte : la garde doit mordre')
  assert.ok(!JSON.stringify(r.body).includes('Chez un autre'),
    'aucune donnee du bien ne doit fuir dans la reponse de refus')
})

test('la fiche d un bien inconnu : 404, sans distinguer « n existe pas » de « pas a vous »', async () => {
  preparer()
  assert.equal((await appeler({ id: 'dddddddd-dddd-dddd-dddd-dddddddddddd' })).code, 404)
})

test('la fiche du titulaire s affiche, bloc par bloc', async () => {
  preparer()
  const r = await appeler({ id: BIEN_A })
  assert.equal(r.code, 200)
  assert.equal(r.body.bien.nom, 'La bulle')
  assert.deepEqual(r.body.canaux, [], 'aucun canal releve : lu, et vide')
  // ⚠ Et « jamais releve » n'autorise PAS la suppression : aucun canal ET aucune
  // date de releve ne disent pas « pas relie » (constat M1a).
  assert.equal(r.body.suppression.possible, null)
  assert.equal(r.body.suppression.motif, 'jamais_releve')
})

test('LE TEST QUI COMPTE : aucun identifiant du partenaire ne descend dans la reponse', async () => {
  preparer()
  const fiche = JSON.stringify((await appeler({ id: BIEN_A })).body)
  const liste = JSON.stringify((await appeler()).body)
  for (const interdit of [REF_A, REF_B, 'RP-' + REF_A, 'provider_property_id', 'provider_rate_plan_id']) {
    assert.ok(!fiche.includes(interdit), `la fiche porte ${interdit}`)
    assert.ok(!liste.includes(interdit), `la liste porte ${interdit}`)
  }
})

test('LE TEST QUI COMPTE : une panne rend 503, jamais un 200 a liste vide', async () => {
  preparer({ enPanne: { properties: 'timeout' } })
  const r = await appeler()
  assert.equal(r.code, 503,
    'un 200 vide ferait lire « Ajoutez votre premier logement » a un hote qui en a deux')
  assert.equal(r.body.biens, undefined)
})

test('LE TEST QUI COMPTE : une panne APRES la garde rend 503, pas une fiche amputee', async () => {
  // ⚠ La panne doit tomber APRES la garde, sinon on mesure le refus de la garde
  // et pas le chemin de lecture. `enPanneApres` laisse passer la resolution du
  // bien (une lecture de `properties`), puis casse la suivante — celle de
  // `lireFiche`. Ma premiere version de ce test ne mesurait RIEN : elle
  // assertait `vus.length > 0`, ce qui est vrai de n'importe quelle requete.
  preparer({ enPanneApres: { properties: 1 } })
  const r = await appeler({ id: BIEN_A })
  assert.equal(r.code, 503,
    'un 200 ampute laisserait l ecran afficher un bien sans nom ni prix, et l hote croirait a une perte de donnees')
  assert.equal(r.body.bien, undefined)
  assert.ok(/indisponible/i.test(r.body.error))
})

test('une reference PARTENAIRE en parametre est acceptee, et resolue en UUID', async () => {
  preparer()
  const r = await appeler({ id: REF_A })
  assert.equal(r.code, 200, 'la garde accepte les deux formes : la fiche doit suivre')
  assert.equal(r.body.bien.id, BIEN_A,
    'lire `.eq(id, <ref texte>)` ferait echouer la requete en 22P02 — le piege UUID')
})

// ═══════════════════════════════════════════════════════════════════════════
// Les droits par DOMAINE, de bout en bout — constat de SECURITE du 20 octobre
// ═══════════════════════════════════════════════════════════════════════════

const membre = (extra = {}) => preparer({
  appelant: MEMBRE,
  profils: [profilDe(TITULAIRE, MEMBRE)],
  permissions: [droitsDe(`prof-${MEMBRE}-${TITULAIRE}`, extra)]
})

test('LE TEST QUI COMPTE : `reservations: read` seul ne donne ni les personnes, ni les avis, ni les serrures', async () => {
  // Combinaison que l ecran Equipe permet : le co-hote voit les reservations,
  // pas les prestataires. api/menages.js lui refuse les personnes, et la RLS
  // aussi (`can_read(user_id, 'prestataires', property_id)`). Cet endpoint
  // tourne en service key : sans verification propre, il contournait les deux.
  //
  // ⚠ `serrures` a ete AJOUTE apres la re-revue : `property_locks_select` et
  // `locks_select` font tous deux `can_read(user_id, 'reglages', …)`, et
  // api/serrures.js declare `locks: ['reglages', 'read']`. La premiere version
  // avait les branches de refus, pas l entree qui les rend atteignables.
  const { vus } = membre({ prestataires: 'none', avis: 'none', reglages: 'none' })
  const r = await appeler({ id: BIEN_A }, { 'x-compte': TITULAIRE })
  assert.equal(r.code, 200, 'la fiche s affiche : c est le BLOC qui est refuse, pas la page')
  assert.equal(r.body.menage, null)
  assert.equal(r.body.avis, null)
  assert.equal(r.body.taxe, null)
  assert.equal(r.body.serrures, null)
  assert.deepEqual(r.body.refuses.sort(), ['avis', 'menage', 'serrures', 'taxe'])
  const tables = vus.map(v => v.table)
  for (const t of ['property_cleaning_providers', 'ota_reviews', 'taxes_sejour', 'property_locks', 'locks']) {
    assert.ok(!tables.includes(t), `${t} a ete interrogee sans le droit correspondant`)
  }
})

test('un membre qui A le droit `prestataires` recoit le bloc Menage', async () => {
  membre({ prestataires: 'read' })
  const r = await appeler({ id: BIEN_A }, { 'x-compte': TITULAIRE })
  assert.equal(r.code, 200)
  assert.deepEqual(r.body.menage, [], 'aucune liaison dans ce double : lu, et vide')
  assert.ok(!r.body.refuses.includes('menage'))
})

test('sans `reglages: write`, la suppression n est pas PROMISE', async () => {
  membre({ reglages: 'none' })
  const r = await appeler({ id: BIEN_A }, { 'x-compte': TITULAIRE })
  assert.equal(r.body.suppression.possible, null)
  assert.equal(r.body.suppression.motif, 'droit_refuse')
})

test('le titulaire n est refuse sur rien', async () => {
  preparer()
  const r = await appeler({ id: BIEN_A })
  assert.deepEqual(r.body.refuses, [])
})

test('la reponse n est pas mise en cache par un intermediaire, et varie par compte', async () => {
  preparer()
  const r = await appeler({ id: BIEN_A })
  assert.equal(r.entetes['cache-control'], 'private, no-store')
  assert.equal(r.entetes['vary'], 'authorization, x-compte')
})

test('LE TEST QUI COMPTE (M1) : `reglages: read` LIT la taxe et les serrures, mais ne PROMET pas la suppression', async () => {
  // ⚠ Ce test existe parce que la contre-epreuve a montre que remplacer
  // `peutEcrire` par `peutLire` dans l endpoint laissait la suite VERTE. Le cas
  // `reglages: 'none'` echoue des deux cotes : il faut le cas INTERMEDIAIRE,
  // celui ou la lecture passe et l ecriture non.
  membre({ reglages: 'read' })
  const r = await appeler({ id: BIEN_A }, { 'x-compte': TITULAIRE })
  assert.equal(r.code, 200)
  // Le droit de LECTURE est accorde : les deux blocs `reglages` sont servis.
  assert.deepEqual(r.body.refuses, [])
  assert.deepEqual(r.body.taxe, { connue: false })
  assert.deepEqual(r.body.serrures, [])
  // Mais la garde DELETE exige `reglages: write` : on ne promet rien.
  assert.equal(r.body.suppression.possible, null)
  assert.equal(r.body.suppression.motif, 'droit_refuse',
    'promettre une suppression a un profil en lecture annonce un 403, et la spec §5 veut aucun bouton dans le DOM')
})

test('`reglages: write` : la suppression est jugee sur les canaux, plus sur le droit', async () => {
  membre({ reglages: 'write' })
  const r = await appeler({ id: BIEN_A }, { 'x-compte': TITULAIRE })
  assert.notEqual(r.body.suppression.motif, 'droit_refuse')
  assert.equal(r.body.suppression.motif, 'jamais_releve', 'aucun canal releve dans ce double')
})

// ═══════════════════════════════════════════════════════════════════════════
// Les avis sur la liste — le droit de DOMAINE, verifie par l'endpoint lui-meme
// ═══════════════════════════════════════════════════════════════════════════

// ⚠ `ota` ET `content` COMME EN BASE : depuis le 20 octobre 2026, une source
// hors table n'est pas convertie (dette 76) et un objet sans note ni texte
// n'est pas un avis. Une fixture sans ces deux champs decrit un cas que les
// writers ne produisent pas.
const avisDe = (property_id, overall_score, extra = {}) => ({
  id: `av-${property_id}-${overall_score}`, user_id: TITULAIRE, property_id,
  statut: 'confirme', is_hidden: false, overall_score, ota: 'airbnb', content: 'Sejour parfait',
  received_at: '2026-10-10T00:00:00Z', ...extra
})

test('la note et le nombre d avis descendent sur chaque carte de la liste', async () => {
  preparer({ avis: [avisDe(BIEN_A, 10), avisDe(BIEN_A, 9), avisDe(BIEN_B, 8)] })
  const r = await appeler()
  assert.equal(r.code, 200)
  assert.deepEqual(r.body.biens.find(b => b.nom === 'La bulle').avis, { total: 2, notes: 2, note_sur_5: 4.8 })
  assert.deepEqual(r.body.refuses, [])
})

test('LE TEST QUI COMPTE (SECURITE) : un membre sans le droit `avis` ne recoit AUCUNE note', async () => {
  // `ota_reviews` est gardee par `can_read(user_id, 'avis', …)`, et cet endpoint
  // tourne en service key, qui contourne la RLS par conception. Sans cette
  // garde, un co-hote invite avec `avis: none` recevait la note de chaque
  // logement du portefeuille — ce que api/avis.js lui refuse.
  const { vus } = preparer({
    appelant: MEMBRE,
    profils: [profilDe(TITULAIRE, MEMBRE)],
    permissions: [droitsDe(`prof-${MEMBRE}-${TITULAIRE}`, { avis: 'none' })],
    avis: [avisDe(BIEN_A, 10)]
  })
  const r = await appeler({}, { 'x-compte': TITULAIRE })
  assert.equal(r.code, 200)
  assert.ok(r.body.biens.length >= 1)
  assert.ok(r.body.biens.every(b => b.avis === null))
  assert.deepEqual(r.body.refuses, ['avis'])
  assert.ok(!vus.map(v => v.table).includes('ota_reviews'),
    'le droit se verifie AVANT la lecture : une fois sortie de la base, la donnee a deja fuite')
})

test('un membre QUI A le droit `avis` recoit bien les notes de son perimetre', async () => {
  // Contre-epreuve du test precedent : une garde qui refuse tout le monde n est
  // pas une garde, c est une panne.
  preparer({
    appelant: MEMBRE,
    profils: [profilDe(TITULAIRE, MEMBRE)],
    permissions: [droitsDe(`prof-${MEMBRE}-${TITULAIRE}`, { property_scope: 'selected', property_refs: [REF_A] })],
    avis: [avisDe(BIEN_A, 10)]
  })
  const r = await appeler({}, { 'x-compte': TITULAIRE })
  assert.deepEqual(r.body.biens.map(b => b.nom), ['La bulle'])
  assert.deepEqual(r.body.biens[0].avis, { total: 1, notes: 1, note_sur_5: 5 })
  assert.deepEqual(r.body.refuses, [])
})

// ════════════════════════════════════════════════════════════════════════
// Le comptage de la suppression (étape 3) : gardé comme la SUPPRESSION
// ════════════════════════════════════════════════════════════════════════

const ligne = (n, cle, compte, extra = {}) => Array.from({ length: n }, (_, i) =>
  ({ id: `l${i}-${cle}`, user_id: compte, property_id: cle, ...extra }))

test('le titulaire obtient les nombres de ce que la suppression effacerait', async () => {
  preparer({
    sejours: ligne(3, REF_A, TITULAIRE, { booking_id: 'b' }),
    messages: ligne(5, REF_A, TITULAIRE),
    menages: ligne(2, REF_A, TITULAIRE),
    codes: ligne(1, REF_A, TITULAIRE)
  })
  const r = await appeler({ id: BIEN_A, compter: 'suppression' })
  assert.equal(r.code, 200)
  assert.deepEqual(r.body.suppression,
    { cle_absente: false, reservations: 3, messages: 5, menages: 2, codes: 1 })
})

test('LE TEST QUI COMPTE (SÉCURITÉ) : sans le droit d ÉCRITURE, pas de nombres — 403', async () => {
  // ⚠ CES NOMBRES SONT CEUX D UNE ACTION, PAS D UNE LECTURE. Le DELETE est
  // gardé par `reglages:write` sur le bien : servir le détail de ce qu il
  // effacerait à un profil en LECTURE montrerait ce qui mène à un refus — et la
  // fiche, elle, s ouvre dès `reservations:read`. Deux droits, deux réponses.
  preparer({
    appelant: MEMBRE,
    profils: [profilDe(TITULAIRE, MEMBRE)],
    permissions: [droitsDe(`prof-${MEMBRE}-${TITULAIRE}`, { reglages: 'read' })],
    sejours: ligne(3, REF_A, TITULAIRE, { booking_id: 'b' })
  })
  const r = await appeler({ id: BIEN_A, compter: 'suppression' }, { 'x-compte': TITULAIRE })
  assert.equal(r.code, 403)
  assert.equal(r.body && r.body.suppression, undefined, 'aucun nombre ne doit fuir')
  // Et la FICHE, elle, reste lisible pour ce même membre : c est bien le droit
  // d écriture qui tranche, pas l accès à l écran.
  const fiche = await appeler({ id: BIEN_A }, { 'x-compte': TITULAIRE })
  assert.equal(fiche.code, 200)
})

test('LE TEST QUI COMPTE (SÉCURITÉ) : le bien d un AUTRE compte ne se compte pas', async () => {
  preparer({ sejours: ligne(4, REF_X, ETRANGER, { booking_id: 'b' }) })
  // Le même contrat que la fiche, mesuré plus haut dans ce fichier : un bien
  // d'un AUTRE compte rend 403, un bien INCONNU rend 404. Le comptage suit, il
  // n'invente pas sa propre grammaire de refus.
  const r = await appeler({ id: BIEN_X, compter: 'suppression' })
  assert.equal(r.code, 403)
  assert.equal(r.body && r.body.suppression, undefined, 'aucun nombre ne doit fuir')
  assert.doesNotMatch(JSON.stringify(r.body), /Chez un autre/, 'ni le nom du bien')

  const inconnu = await appeler({ id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', compter: 'suppression' })
  assert.equal(inconnu.code, 404)
  assert.equal(inconnu.body && inconnu.body.suppression, undefined)
})

test('un membre délégué avec `reglages: write` obtient bien les nombres', async () => {
  preparer({
    appelant: MEMBRE,
    profils: [profilDe(TITULAIRE, MEMBRE)],
    permissions: [droitsDe(`prof-${MEMBRE}-${TITULAIRE}`, { reglages: 'write' })],
    messages: ligne(2, REF_A, TITULAIRE)
  })
  const r = await appeler({ id: BIEN_A, compter: 'suppression' }, { 'x-compte': TITULAIRE })
  assert.equal(r.code, 200)
  assert.equal(r.body.suppression.messages, 2)
})

test('le comptage ne rend QUE des nombres : aucun identifiant du partenaire', async () => {
  preparer({ sejours: ligne(1, REF_A, TITULAIRE, { booking_id: 'b' }) })
  const r = await appeler({ id: BIEN_A, compter: 'suppression' })
  const texte = JSON.stringify(r.body)
  for (const ref of [REF_A, REF_B, REF_X]) {
    assert.doesNotMatch(texte, new RegExp(ref), `la référence ${ref} ne doit pas sortir`)
  }
  assert.doesNotMatch(texte, /provider|channex|beds24/i)
})

test('une valeur inattendue de `compter` rend la FICHE, elle n ouvre aucun chemin', async () => {
  preparer()
  for (const v of ['', 'oui', 'suppression2', '1']) {
    const r = await appeler({ id: BIEN_A, compter: v })
    assert.equal(r.code, 200, JSON.stringify(v))
    assert.ok(r.body.bien, 'c est la fiche qui est rendue')
    assert.equal(r.body.suppression && r.body.suppression.reservations, undefined)
  }
})

test('LE TEST QUI COMPTE (S\u00c9CURIT\u00c9) : la fiche DESCEND les deux droits d \u00e9criture', async () => {
  // \u26a0 SANS EUX, L \u00c9CRAN D\u00c9CIDE SEUL (constat de la revue de l \u00e9tape 3).
  // `peutEcrire`, c\u00f4t\u00e9 navigateur, r\u00e9pond pour le compte du S\u00c9LECTEUR et
  // commence par « si je suis titulaire, oui » ; cette fiche est gard\u00e9e par la
  // RESSOURCE. Le serveur sait, lui : il envoie ce qu il autorisera.
  preparer({
    appelant: MEMBRE,
    profils: [profilDe(TITULAIRE, MEMBRE)],
    permissions: [droitsDe(`prof-${MEMBRE}-${TITULAIRE}`, { reglages: 'read', reservations: 'read' })]
  })
  const lecture = await appeler({ id: BIEN_A }, { 'x-compte': TITULAIRE })
  assert.equal(lecture.code, 200)
  assert.deepEqual(JSON.parse(JSON.stringify(lecture.body.droits)),
    { modifier: false, publier: false })

  // Les deux se d\u00e9cident S\u00c9PAR\u00c9MENT : le calendrier et les r\u00e9glages sont deux
  // domaines, et le serveur garde \u00ab Publier \u00bb par le premier.
  preparer({
    appelant: MEMBRE,
    profils: [profilDe(TITULAIRE, MEMBRE)],
    permissions: [droitsDe(`prof-${MEMBRE}-${TITULAIRE}`, { reglages: 'read', reservations: 'write' })]
  })
  const mixte = await appeler({ id: BIEN_A }, { 'x-compte': TITULAIRE })
  assert.deepEqual(JSON.parse(JSON.stringify(mixte.body.droits)),
    { modifier: false, publier: true })

  // Et le titulaire a les deux.
  preparer()
  const titulaire = await appeler({ id: BIEN_A })
  assert.deepEqual(JSON.parse(JSON.stringify(titulaire.body.droits)),
    { modifier: true, publier: true })
})
