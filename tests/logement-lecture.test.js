// tests/logement-lecture.test.js
// LA LECTURE DES LOGEMENTS — ce qu'on affiche, et ce qu'on refuse d'inventer.
//
// Etape 0 du lot « Logements V5 ». Ces tests eprouvent des INVARIANTS, pas des
// lignes : la forme de la sortie bougera a l'etape 1 (l'ecran), les regles ci-
// dessous ne doivent pas bouger.
//
// Les trois qui comptent :
//   1. un bloc qu'on n'a pas pu lire vaut `null`, JAMAIS une liste vide — sans
//      quoi l'hote lit « aucun canal » la ou il en a deux (dette 59) ;
//   2. aucun identifiant du partenaire ne quitte ce module (spec §6) ;
//   3. « suppression possible » a `null` DESACTIVE le bouton — une lecture
//      ratee n'ouvre jamais l'action la plus destructrice du produit.

// `lib/canaux-du-bien` tire la couche canal, qui construit son client au
// chargement : sans ces variables, le fichier de test leve avant le premier test.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'cle-de-test'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'http://localhost:1/api/v1'
process.env.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY || 'cle-de-test'

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

// ⚠ L'ALARME DU FONDATEUR EST NEUTRALISEE. `clesMigrees` signale une table
// illisible par `reportIncident`, qui part en vrai appel reseau : le test
// « cles migrees illisibles » attendait 14 SECONDES son echec. On garde la
// trace en memoire — et un test verifie qu'elle est bien emise.
const INCIDENTS = []
{
  const abs = require.resolve(path.join(__dirname, '..', 'lib', 'founder-notify'))
  const m = new Module(abs)
  m.exports = { reportIncident: async (type, paquet) => { INCIDENTS.push({ type, paquet }); return { ok: true } } }
  m.loaded = true
  require.cache[abs] = m
}

const L = require('../lib/logement/lecture')
const { _vider } = require('../lib/cles-migrees')

const COMPTE = '11111111-1111-1111-1111-111111111111'
const BIEN   = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const BIEN2  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const REF    = '209413'          // la cle partenaire, TEXT
const REF2   = '552211'

// Un bien complet, tel qu'il sort de `properties`.
const bienDe = (extra = {}) => ({
  user_id: COMPTE, id: BIEN, name: 'La bulle', city: 'Bagnères', country: 'FR', address: '1 rue X',
  zip_code: '65200', capacity: 4, photo_url: null, currency: 'EUR', base_price: 120,
  prix_minimum: 60, included_guests: 2, extra_guest_fee: 15, rate_sync_mode: 'managed',
  pilote_tarifaire: true, automation_paused: false, inventory_type: 'whole',
  ota_listing_urls: null, created_at: '2026-01-01T00:00:00Z',
  provider: 'channex', provider_property_id: REF, migration_target_property_id: null,
  provider_rate_plan_id: 'RP-1', ...extra
})

// ─────────────────────────────────────────────────────────────────────────────
// Faux client Supabase. `order` et `limit` sont HONORES : le code tronque apres
// avoir trie cote base, et un double qui ignore l'ordre coupe les mauvaises
// lignes — un test qui passe (ou rougit) pour une raison qui n'existe pas.
// ─────────────────────────────────────────────────────────────────────────────
function base (d = {}) {
  const {
    biens = [], canaux = [], horloge = null, migrees = [], sejours = [],
    avis = [], liaisons = [], profils = [], serrures = [], taxes = [],
    enPanne = {}   // { nomDeTable: 'message' }
  } = d
  const vus = []
  return {
    _vus: vus,
    from (table) {
      const a = { table, f: {}, ins: [], gte: {}, is: {}, limit: null, order: null }
      vus.push(a)
      const donnees = () => {
        if (enPanne[table]) return { data: null, error: { message: enPanne[table] } }
        const source = {
          properties: biens, canaux_du_bien: canaux, canaux_releve: horloge ? [horloge] : [],
          provider_keys_migrated: migrees, bookings_snapshot: sejours, ota_reviews: avis,
          property_cleaning_providers: liaisons, public_tokens: profils,
          property_locks: serrures, taxes_sejour: taxes
        }[table] || []
        let c = source.filter(l =>
          Object.entries(a.f).every(([k, v]) => String(l[k]) === String(v)) &&
          a.ins.every(f => f.v.includes(String(l[f.c]))) &&
          Object.entries(a.is).every(([k, v]) => v === null ? (l[k] == null) : l[k] === v) &&
          Object.entries(a.gte).every(([k, v]) => {
            // `snapshot->>departure` : le filtre jsonb que la base applique.
            const lu = k.includes('->>')
              ? (l[k.split('->>')[0]] || {})[k.split('->>')[1]]
              : l[k]
            return String(lu || '') >= String(v)
          }))
        if (a.order) {
          const k = a.order.c
          c = [...c].sort((x, y) => {
            const r = String(x[k] == null ? '' : x[k]).localeCompare(String(y[k] == null ? '' : y[k]))
            return a.order.asc ? r : -r
          })
        }
        if (a.limit != null) c = c.slice(0, a.limit)
        return { data: c, error: null }
      }
      const chain = {
        select () { return chain },
        eq (c, v) { a.f[c] = v; return chain },
        in (c, v) { a.ins.push({ c, v: (v || []).map(String) }); return chain },
        gte (c, v) { a.gte[c] = v; return chain },
        is (c, v) { a.is[c] = v; return chain },
        or (expr) { a.or = expr; return chain },
        order (c, o) { a.order = { c, asc: !(o && o.ascending === false) }; return chain },
        limit (n) { a.limit = n; return Promise.resolve(donnees()) },
        maybeSingle () { const r = donnees(); return Promise.resolve({ data: r.data ? (r.data[0] || null) : null, error: r.error }) },
        then (f, g) { return Promise.resolve(donnees()).then(f, g) }
      }
      return chain
    }
  }
}

test.beforeEach(() => _vider())

// ═══════════════════════════════════════════════════════════════════════════
// 1. Le fait date — des faits, et seulement les sejours qui occupent
// ═══════════════════════════════════════════════════════════════════════════

// ⚠ `user_id` EN TETE, comme en base : le module cloisonne toutes ses lectures
// par compte, et un double sans cette colonne rend zero ligne — donc un test
// rouge pour une raison qui n'existe pas en production.
const sejour = (arrival, departure, extra = {}) => ({
  user_id: COMPTE, property_id: REF,
  snapshot: { provider: 'channex', status: 'new', arrival, departure, ...extra }
})

test('occupe aujourd hui : arrivee <= jour < depart', () => {
  const f = L.faitDate([sejour('2026-10-18', '2026-10-22')], '2026-10-19')
  assert.equal(f.occupe, true)
  assert.equal(f.depart, '2026-10-22')
  assert.equal(f.prochaine_arrivee, null)
})

test('LE JOUR DU DEPART, LE LOGEMENT EST LIBRE — convention des nuitees de tout le depot', () => {
  const f = L.faitDate([sejour('2026-10-15', '2026-10-19')], '2026-10-19')
  assert.equal(f.occupe, false, 'un depart le jour meme libere la nuit : compter occupe cacherait une nuit vendable')
  assert.equal(f.depart, null)
})

test('la prochaine arrivee est la PLUS PROCHE, pas la premiere lue', () => {
  const f = L.faitDate([sejour('2026-12-01', '2026-12-05'), sejour('2026-10-25', '2026-10-28')], '2026-10-19')
  assert.equal(f.prochaine_arrivee, '2026-10-25')
})

test('UNE RESERVATION ANNULEE N OCCUPE RIEN — sinon « Occupe » s affiche sur un bien a vendre', () => {
  const f = L.faitDate([sejour('2026-10-18', '2026-10-22', { status: 'cancelled' })], '2026-10-19')
  assert.deepEqual(f, { occupe: false, depart: null, prochaine_arrivee: null })
})

test('aucun sejour : des faits vides, pas une panne', () => {
  assert.deepEqual(L.faitDate([], '2026-10-19'), { occupe: false, depart: null, prochaine_arrivee: null })
})

test('un sejour sans dates est ignore sans lever', () => {
  const f = L.faitDate([{ snapshot: { status: 'new', arrival: null, departure: null } }], '2026-10-19')
  assert.equal(f.occupe, false)
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Aucun identifiant du partenaire ne sort (spec §6)
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : `publier` est une LISTE BLANCHE — aucune cle ni valeur du partenaire ne sort', () => {
  const sortie = L.publier(bienDe({ provider_property_id: REF, provider_rate_plan_id: 'RP-SECRET' }))
  const json = JSON.stringify(sortie)
  assert.ok(!json.includes(REF), 'la cle partenaire du bien est dans la reponse')
  assert.ok(!json.includes('RP-SECRET'), 'le plan tarifaire partenaire est dans la reponse')
  for (const k of Object.keys(sortie)) {
    assert.ok(!/^provider/.test(k), `la colonne ${k} descend a l ecran`)
  }
  // Et le fait Beds24 descend comme un BOOLEEN, jamais comme un identifiant.
  assert.equal(sortie.beds24_de_l_hote, false)
  assert.equal(L.publier(bienDe({ provider: 'beds24' })).beds24_de_l_hote, true)
})

test('D3 : une capacite vide n est pas 0, elle est absente', () => {
  assert.equal(L.publier(bienDe({ capacity: null })).capacite, null)
  assert.equal(L.publier(bienDe({ capacity: 0 })).capacite, null)
  assert.equal(L.publier(bienDe({ capacity: 4 })).capacite, 4)
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. « Suppression possible » — trois valeurs, et `null` desactive
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : canaux ILLISIBLES => `null`, jamais `true`', () => {
  const r = L.suppressionPossible(bienDe(), null)
  assert.equal(r.possible, null, 'une lecture ratee ouvrirait la suppression definitive du bien')
  assert.equal(r.motif, 'canaux_illisibles')
})

test('une annonce encore reliee refuse la suppression, avec son motif', () => {
  const r = L.suppressionPossible(bienDe(), [{ ota: 'airbnb', mappe: true }])
  assert.equal(r.possible, false)
  assert.equal(r.motif, 'annonce_reliee')
})

test('aucune annonce reliee : la suppression est possible', () => {
  assert.equal(L.suppressionPossible(bienDe(), [{ ota: 'airbnb', mappe: false }]).possible, true)
  assert.equal(L.suppressionPossible(bienDe(), []).possible, true)
})

test('la garde OTA ne vaut que pour un bien du canal POURVU d un plan tarifaire — c est la regle du serveur', () => {
  // Sans plan tarifaire, la garde DELETE ne verifie rien : le bouton est actif,
  // meme si les canaux sont illisibles.
  assert.equal(L.suppressionPossible(bienDe({ provider_rate_plan_id: null }), null).possible, true)
  assert.equal(L.suppressionPossible(bienDe({ provider: 'beds24' }), null).possible, true)
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. La jointure TEXT / UUID
// ═══════════════════════════════════════════════════════════════════════════

test('un bien EN MIGRATION apporte sa cle cible, pas seulement sa cle d origine', async () => {
  const sb = base({ migrees: [] })
  const r = await L.clesTextDuBien(sb, COMPTE, bienDe({ migration_target_property_id: REF2 }))
  assert.deepEqual(r.cles.sort(), [REF2, REF].sort())
  assert.equal(r.erreur, false)
})

test('UNE CLE MIGREE NE SE ROUVRE JAMAIS — elle est ecartee', async () => {
  const sb = base({ migrees: [{ user_id: COMPTE, provider: 'beds24', provider_property_id: REF }] })
  const r = await L.clesTextDuBien(sb, COMPTE, bienDe({ migration_target_property_id: REF2 }))
  assert.deepEqual(r.cles, [REF2], 'rouvrir une cle abandonnee a fait quitter 82 sejours de la fiche le 14 septembre')
})

test('LE TEST QUI COMPTE : table des cles migrees ILLISIBLE => on ne devine pas', async () => {
  const sb = base({ enPanne: { provider_keys_migrated: 'timeout' } })
  const r = await L.clesTextDuBien(sb, COMPTE, bienDe())
  assert.equal(r.erreur, true)
  assert.deepEqual(r.cles, [], 'aucune cle ne doit etre retenue sur une lecture en echec')
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. La fiche — un bloc en panne n'emporte pas les autres
// ═══════════════════════════════════════════════════════════════════════════

const ficheComplete = (extra = {}) => base({
  biens: [bienDe()],
  canaux: [
    { property_id: BIEN, user_id: COMPTE, ota: 'airbnb', titre: 'La bulle', actif: true, mappe_pour_ce_bien: true, listing_url: 'u', vu_le: '2026-10-19T08:00:00Z', disparu_le: null },
    { property_id: BIEN, user_id: COMPTE, ota: 'booking', titre: 'La bulle', actif: true, mappe_pour_ce_bien: false, listing_url: null, vu_le: '2026-10-19T08:00:00Z', disparu_le: null }
  ],
  horloge: { user_id: COMPTE, vu_le: '2026-10-19T08:00:00Z', ok: true, erreur: null },
  sejours: [sejour('2026-10-18', '2026-10-22')],
  avis: [{ user_id: COMPTE, property_id: BIEN, is_hidden: false, ai_clean_verdict: 'positif', ai_analyzed_at: '2026-10-10T00:00:00Z', received_at: '2026-10-10T00:00:00Z' }],
  liaisons: [{ user_id: COMPTE, property_id: REF, provider_id: 'p1', rang: 1, weekdays: null, requires_ack: false, active: true }],
  profils: [{ user_id: COMPTE, id: 'p1', nom: 'Dupont', prenom: 'Marie' }],
  serrures: [{ user_id: COMPTE, property_id: REF, role: 'main', locks: { label: 'Entrée', brand: 'igloohome' } }],
  taxes: [{ user_id: COMPTE, property_id: REF, commune: 'Bagnères', communale_cents: 110, departementale_cents: 11, regionale_cents: null, collecteur: 'plateforme', origine: 'transmis', inclus_dans_prix: false, updated_at: '2026-10-01T00:00:00Z' }],
  ...extra
})

const MAINTENANT = new Date('2026-10-19T10:00:00Z')

test('la fiche complete : chaque bloc rend ses donnees, et rien n est indisponible', async () => {
  const f = await L.lireFiche(ficheComplete(), { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT })
  assert.equal(f.bien.nom, 'La bulle')
  assert.equal(f.canaux.length, 2)
  assert.equal(f.fait_date.occupe, true)
  assert.equal(f.avis.positif, 1)
  assert.equal(f.menage[0].nom, 'Marie Dupont')
  assert.equal(f.serrures[0].nom, 'Entrée')
  assert.equal(f.taxe.commune, 'Bagnères')
  assert.deepEqual(f.indisponibles, [])
  assert.equal(f.suppression.possible, false, 'une annonce est encore reliee')
})

test('LE TEST QUI COMPTE : UN BLOC EN PANNE N EMPORTE PAS LA FICHE', async () => {
  const f = await L.lireFiche(ficheComplete({ enPanne: { property_cleaning_providers: 'timeout' } }),
    { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT })
  assert.equal(f.menage, null, 'le bloc en panne vaut null')
  assert.ok(f.indisponibles.includes('menage'), 'et il se NOMME, sinon l ecran affiche un vide muet')
  // Les autres blocs sont intacts : c est tout l enjeu de `allSettled`.
  assert.equal(f.bien.nom, 'La bulle')
  assert.equal(f.serrures[0].nom, 'Entrée')
  assert.equal(f.taxe.commune, 'Bagnères')
  assert.equal(f.fait_date.occupe, true)
})

test('LE TEST QUI COMPTE : un bloc vide n est pas un bloc en panne', async () => {
  const f = await L.lireFiche(ficheComplete({ liaisons: [], avis: [], serrures: [], taxes: [] }),
    { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT })
  assert.deepEqual(f.menage, [], 'lu, et il n y a personne : c est une REPONSE')
  assert.deepEqual(f.serrures, [])
  assert.deepEqual(f.taxe, [])
  assert.equal(f.avis.total, 0)
  assert.equal(f.avis.positif, 0)
  assert.deepEqual(f.indisponibles, [], 'un vide ne doit JAMAIS compter comme indisponible')
})

test('canaux illisibles : les pastilles valent null, et la suppression se desactive', async () => {
  const f = await L.lireFiche(ficheComplete({ enPanne: { canaux_du_bien: 'timeout' } }),
    { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT })
  assert.equal(f.canaux, null)
  assert.ok(f.indisponibles.includes('canaux'))
  assert.equal(f.suppression.possible, null)
})

test('LE TEST QUI COMPTE : cles migrees illisibles => AUCUN bloc TEXT n est lu', async () => {
  const sb = ficheComplete({ enPanne: { provider_keys_migrated: 'timeout' } })
  const f = await L.lireFiche(sb, { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT })
  for (const bloc of ['menage', 'serrures', 'taxe', 'fait_date']) {
    assert.equal(f[bloc], null, `${bloc} a ete lu sans cle sure`)
    assert.ok(f.indisponibles.includes(bloc))
  }
  // Contre-epreuve : la base n a vu AUCUNE lecture des tables TEXT.
  const tables = sb._vus.map(v => v.table)
  for (const t of ['property_cleaning_providers', 'property_locks', 'taxes_sejour', 'bookings_snapshot']) {
    assert.ok(!tables.includes(t), `${t} a ete interrogee alors que la cle n est pas sure`)
  }
  // Les blocs UUID, eux, restent servis.
  assert.equal(f.bien.nom, 'La bulle')
  assert.equal(f.canaux.length, 2)
})

test('un bien sans aucune cle partenaire : des blocs VIDES, pas des pannes', async () => {
  const f = await L.lireFiche(base({ biens: [bienDe({ provider_property_id: null })] }),
    { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT })
  assert.deepEqual(f.menage, [])
  assert.deepEqual(f.indisponibles, [], 'un bien jamais provisionne n a rien a montrer : ce n est pas une panne')
  assert.equal(f.cles_motif, 'aucune_cle')
})

test('bien inconnu : `null`, et la panne de lecture LEVE — les deux ne se confondent pas', async () => {
  assert.equal(await L.lireFiche(base({ biens: [] }), { compte: COMPTE, bienId: BIEN }), null)
  await assert.rejects(
    () => L.lireFiche(base({ enPanne: { properties: 'timeout' } }), { compte: COMPTE, bienId: BIEN }),
    (e) => e.panne === true,
    'une panne doit lever (503), pas rendre « bien introuvable » (404)')
})

test('la fiche d un autre compte ne se lit pas', async () => {
  const f = await L.lireFiche(base({ biens: [bienDe()] }),
    { compte: '99999999-9999-9999-9999-999999999999', bienId: BIEN })
  assert.equal(f, null)
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. Les avis — « pas encore analyse » n'est pas « rien signale »
// ═══════════════════════════════════════════════════════════════════════════

test('un avis NON ANALYSE se compte a part, jamais en « rien signale »', async () => {
  const f = await L.lireFiche(ficheComplete({
    avis: [
      { user_id: COMPTE, property_id: BIEN, is_hidden: false, ai_clean_verdict: null, ai_analyzed_at: null, received_at: '2026-10-10T00:00:00Z' },
      { user_id: COMPTE, property_id: BIEN, is_hidden: false, ai_clean_verdict: 'remarque', ai_analyzed_at: '2026-10-11T00:00:00Z', received_at: '2026-10-11T00:00:00Z' }
    ]
  }), { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT })
  assert.equal(f.avis.non_analyses, 1)
  assert.equal(f.avis.rien_signale, 0, 'un pouce vert sur un avis qu on n a pas lu')
  assert.equal(f.avis.remarque, 1)
  assert.equal(f.avis.total, 2)
})

test('la fenetre des avis est bien de 30 jours, bornee cote base', async () => {
  const sb = ficheComplete()
  await L.lireFiche(sb, { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT })
  const q = sb._vus.find(v => v.table === 'ota_reviews')
  assert.equal(q.gte['received_at'].slice(0, 10), '2026-09-19',
    '30 jours avant le 19 octobre 2026')
  assert.equal(L.FENETRE_AVIS_JOURS, 30)
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. La liste
// ═══════════════════════════════════════════════════════════════════════════

const listeDe = (extra = {}) => base({
  biens: [bienDe(), bienDe({ id: BIEN2, name: 'Cœur de vie 23', provider_property_id: REF2 })],
  canaux: [{ property_id: BIEN, user_id: COMPTE, ota: 'airbnb', titre: 'x', actif: true, mappe_pour_ce_bien: true, listing_url: null, vu_le: '2026-10-19T08:00:00Z', disparu_le: null }],
  horloge: { user_id: COMPTE, vu_le: '2026-10-19T08:00:00Z', ok: true, erreur: null },
  sejours: [sejour('2026-10-18', '2026-10-22'), { user_id: COMPTE, property_id: REF2, snapshot: { provider: 'channex', status: 'new', arrival: '2026-11-02', departure: '2026-11-05' } }],
  ...extra
})

test('la liste : un fait date par bien, chacun depuis SA cle', async () => {
  const r = await L.lireListe(listeDe(), { compte: COMPTE, maintenant: MAINTENANT })
  assert.equal(r.biens.length, 2)
  const bulle = r.biens.find(b => b.nom === 'La bulle')
  const coeur = r.biens.find(b => b.nom === 'Cœur de vie 23')
  assert.equal(bulle.fait_date.occupe, true)
  assert.equal(bulle.fait_date.depart, '2026-10-22')
  assert.equal(coeur.fait_date.occupe, false)
  assert.equal(coeur.fait_date.prochaine_arrivee, '2026-11-02')
  assert.equal(bulle.canaux.length, 1)
  assert.deepEqual(coeur.canaux, [], 'ce bien n a pas de canal : lu, et vide')
})

test('LE TEST QUI COMPTE : sejours illisibles => fait_date `null`, JAMAIS « libre »', async () => {
  const r = await L.lireListe(listeDe({ enPanne: { bookings_snapshot: 'timeout' } }), { compte: COMPTE, maintenant: MAINTENANT })
  for (const b of r.biens) {
    assert.equal(b.fait_date, null, 'afficher « Libre jusqu au… » sur un bien peut-etre complet est un mensonge commercial')
  }
  assert.ok(r.indisponibles.includes('fait_date'))
})

test('cles migrees illisibles : aucun fait date, et bookings_snapshot n est pas interrogee', async () => {
  const sb = listeDe({ enPanne: { provider_keys_migrated: 'timeout' } })
  const r = await L.lireListe(sb, { compte: COMPTE, maintenant: MAINTENANT })
  assert.ok(r.biens.every(b => b.fait_date === null))
  assert.ok(!sb._vus.map(v => v.table).includes('bookings_snapshot'))
  assert.ok(r.indisponibles.includes('fait_date'))
})

test('LE TEST QUI COMPTE : une liste de biens ILLISIBLE LEVE — jamais un 200 a liste vide', async () => {
  await assert.rejects(
    () => L.lireListe(base({ enPanne: { properties: 'timeout' } }), { compte: COMPTE }),
    (e) => e.panne === true,
    'un 200 vide ferait lire « Ajoutez votre premier logement » a un hote qui en a quatre, et l onboarding reconcilierait contre du vide')
})

test('un compte sans bien : une liste vide, et aucune panne', async () => {
  const r = await L.lireListe(base({ biens: [] }), { compte: COMPTE })
  assert.deepEqual(r, { biens: [], indisponibles: [] })
})

test('PERIMETRE VIDE : on echoue FERME, on n elargit pas', async () => {
  const r = await L.lireListe(listeDe(), { compte: COMPTE, refsPerimetre: [] })
  assert.deepEqual(r.biens, [], 'un membre sans aucun bien au perimetre ne recoit rien')
})

test('le perimetre filtre, et le PIEGE UUID ne se declenche pas sur une reference partenaire', async () => {
  const sb = listeDe()
  await L.lireListe(sb, { compte: COMPTE, refsPerimetre: [REF], maintenant: MAINTENANT })
  const q = sb._vus.find(v => v.table === 'properties')
  assert.ok(q.or.includes(`provider_property_id.in.(${REF})`))
  const branches = q.or.split(',')
  assert.ok(!branches.some(b => b.startsWith('id.in.')),
    'une reference partenaire numerique passee a `id` (uuid) fait echouer la requete ENTIERE en 22P02')
})

test('un perimetre en UUID emet bien la branche `id`', async () => {
  const sb = listeDe()
  await L.lireListe(sb, { compte: COMPTE, refsPerimetre: [BIEN], maintenant: MAINTENANT })
  const q = sb._vus.find(v => v.table === 'properties')
  assert.ok(q.or.startsWith(`id.in.(${BIEN})`))
})

test('toutes les lectures sont BORNEES : PostgREST tronque a 1000 lignes sans lever', async () => {
  const sb = ficheComplete()
  await L.lireFiche(sb, { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT })
  const sansBorne = sb._vus.filter(v =>
    v.table !== 'provider_keys_migrated' &&   // module tiers, borne chez lui
    v.table !== 'canaux_releve' &&            // maybeSingle
    v.table !== 'properties' &&               // maybeSingle
    v.limit == null)
  assert.deepEqual(sansBorne.map(v => v.table), [], 'une lecture sans `.limit()` rend un resultat FAUX qui a l air juste')
})

test('une lecture qui ATTEINT sa borne leve, au lieu de decider sur un morceau', async () => {
  const beaucoup = Array.from({ length: L.BORNE_BIENS + 5 }, (_, i) => bienDe({ id: `${i}`, name: `b${i}` }))
  await assert.rejects(
    () => L.lireListe(base({ biens: beaucoup }), { compte: COMPTE }),
    (e) => e.tronquee === true)
})
