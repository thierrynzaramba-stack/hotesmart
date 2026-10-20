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
  pilote_tarifaire: 'yieldflow', automation_paused: false, inventory_type: 'whole',
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
    avis = [], liaisons = [], profils = [], serrures = [], taxes = [], fermetures = [],
    enPanne = {}   // { nomDeTable: 'message' }
  } = d
  const vus = []
  return {
    _vus: vus,
    from (table) {
      const a = { table, f: {}, ins: [], gte: {}, lte: {}, is: {}, limit: null, order: null, ordres: [] }
      vus.push(a)
      const donnees = () => {
        if (enPanne[table]) return { data: null, error: { message: enPanne[table] } }
        const source = {
          properties: biens, canaux_du_bien: canaux, canaux_releve: horloge ? [horloge] : [],
          provider_keys_migrated: migrees, bookings_snapshot: sejours, ota_reviews: avis,
          property_cleaning_providers: liaisons, profiles: profils,
          property_locks: serrures, taxes_sejour: taxes, fermetures: fermetures
        }[table] || []
        let c = source.filter(l =>
          Object.entries(a.f).every(([k, v]) => String(l[k]) === String(v)) &&
          a.ins.every(f => f.v.includes(String(l[f.c]))) &&
          Object.entries(a.is).every(([k, v]) => v === null ? (l[k] == null) : l[k] === v) &&
          Object.entries(a.lte).every(([k, v]) => String(l[k] == null ? '' : l[k]) <= String(v)) &&
          Object.entries(a.gte).every(([k, v]) => {
            // `snapshot->>departure` : le filtre jsonb que la base applique.
            const lu = k.includes('->>')
              ? (l[k.split('->>')[0]] || {})[k.split('->>')[1]]
              : l[k]
            return String(lu || '') >= String(v)
          }))
        if (a.ordres.length) {
          c = [...c].sort((x, y) => {
            for (const { c: k, asc } of a.ordres) {
              const r = String(x[k] == null ? '' : x[k]).localeCompare(String(y[k] == null ? '' : y[k]))
              if (r !== 0) return asc ? r : -r
            }
            return 0
          })
        }
        if (a.limit != null) c = c.slice(0, a.limit)
        return { data: c, error: null }
      }
      // ⚠ LE PLAFOND DU SERVEUR EST SIMULE, ET C'EST LE COEUR DU CONSTAT H3.
      // PostgREST applique `max_rows = 1000` (supabase/config.toml) et RAMENE
      // tout `.limit(n > 1000)` a 1000 SANS erreur. Un double qui honore `limit`
      // litteralement rend verte une garde de troncature qui, en production, ne
      // peut pas mordre. Le double doit donc etre aussi avare que la base.
      const MAX_ROWS = 1000
      const chain = {
        select () { return chain },
        eq (c, v) { a.f[c] = v; return chain },
        in (c, v) { a.ins.push({ c, v: (v || []).map(String) }); return chain },
        gte (c, v) { a.gte[c] = v; return chain },
        lte (c, v) { a.lte[c] = v; return chain },
        is (c, v) { a.is[c] = v; return chain },
        or (expr) { a.or = expr; return chain },
        // ⚠ LES ORDRES S ACCUMULENT, comme chez PostgREST (`order=a.asc,b.asc`) :
        // un double qui ne garde que le dernier ne peut pas voir qu un ordre
        // d affichage a ete remplace par la cle de pagination (constat R1).
        order (c, o) { a.ordres.push({ c, asc: !(o && o.ascending === false) }); a.order = a.ordres[0]; return chain },
        limit (n) {
          a.limit = n
          const r = donnees()
          return Promise.resolve(r.error ? r : { data: r.data.slice(0, Math.min(n, MAX_ROWS)), error: null })
        },
        range (de, jusqu) {
          a.pages = (a.pages || 0) + 1
          const r = donnees()
          if (r.error) return Promise.resolve(r)
          const taille = Math.min(jusqu - de + 1, MAX_ROWS)
          return Promise.resolve({ data: r.data.slice(de, de + taille), error: null })
        },
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
  const f = L.faitDate([sejour('2026-10-18', '2026-10-22')], [], '2026-10-19')
  assert.equal(f.type, 'occupe')
  assert.equal(f.occupe, true)
  assert.equal(f.depart, '2026-10-22')
  assert.equal(f.au, '2026-10-22')
  assert.equal(f.prochaine_arrivee, null)
})

test('LE JOUR DU DEPART, LE LOGEMENT EST LIBRE — convention des nuitees de tout le depot', () => {
  const f = L.faitDate([sejour('2026-10-15', '2026-10-19')], [], '2026-10-19')
  assert.equal(f.occupe, false, 'un depart le jour meme libere la nuit : compter occupe cacherait une nuit vendable')
  assert.equal(f.depart, null)
})

test('la prochaine arrivee est la PLUS PROCHE, pas la premiere lue', () => {
  const f = L.faitDate([sejour('2026-12-01', '2026-12-05'), sejour('2026-10-25', '2026-10-28')], [], '2026-10-19')
  assert.equal(f.prochaine_arrivee, '2026-10-25')
  assert.equal(f.type, 'arrivee')
  assert.equal(f.du, '2026-10-25')
})

test('UNE RESERVATION ANNULEE N OCCUPE RIEN — sinon « Occupe » s affiche sur un bien a vendre', () => {
  const f = L.faitDate([sejour('2026-10-18', '2026-10-22', { status: 'cancelled' })], [], '2026-10-19')
  assert.equal(f.type, 'libre')
  assert.equal(f.occupe, false)
})

test('aucun sejour, aucune fermeture : « libre », et ce n est pas une panne', () => {
  const f = L.faitDate([], [], '2026-10-19')
  assert.equal(f.type, 'libre')
  assert.equal(f.du, null)
  assert.equal(f.au, null)
})

test('un sejour sans dates est ignore sans lever', () => {
  const f = L.faitDate([{ snapshot: { status: 'new', arrival: null, departure: null } }], [], '2026-10-19')
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

test('aucune annonce reliee, et le releve a bien eu lieu : la suppression est possible', () => {
  const vu = { vuLe: '2026-10-19T08:00:00Z' }
  assert.equal(L.suppressionPossible(bienDe(), [{ ota: 'airbnb', mappe: false }], vu).possible, true)
  assert.equal(L.suppressionPossible(bienDe(), [], vu).possible, true)
})

test('LE TEST QUI COMPTE (H4) : `mappe === null` ne vaut PAS « pas relie »', () => {
  // Le writer pose `null` quand il n'a pas pu conclure, et jamais `false` par
  // defaut. Le lire comme « pas relie » ouvrait le bouton Supprimer sur un bien
  // encore en vente sur Airbnb.
  const r = L.suppressionPossible(bienDe(), [{ ota: 'airbnb', mappe: null }], { vuLe: '2026-10-19T08:00:00Z' })
  assert.equal(r.possible, null)
  assert.equal(r.motif, 'mapping_inconnu')
})

test('LE TEST QUI COMPTE (M1a) : « jamais releve » ne vaut pas « pas relie »', () => {
  // La dette 59 n'est en prod que depuis le 19 octobre : un compte jamais releve
  // a `canaux = []`, ce qui n'autorise rien.
  const r = L.suppressionPossible(bienDe(), [], { vuLe: null })
  assert.equal(r.possible, null)
  assert.equal(r.motif, 'jamais_releve')
})

test('LE TEST QUI COMPTE (M1b) : sans `reglages: write`, on ne PROMET pas une suppression', () => {
  // La garde DELETE exige reglages:write. Rendre `true` a un profil en lecture
  // lui promettrait une action refusee en 403, et la spec §5 veut « aucun bouton
  // d action dans le DOM » pour ce profil.
  const r = L.suppressionPossible(bienDe(), [{ mappe: false }], { vuLe: 'x', peutSupprimer: false })
  assert.equal(r.possible, null)
  assert.equal(r.motif, 'droit_refuse')
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
  profils: [{ account_user_id: COMPTE, id: 'p1', first_name: 'Marie', last_name: 'Dupont', active: true }],
  serrures: [{ user_id: COMPTE, property_id: REF, role: 'main', locks: { label: 'Entrée', brand: 'igloohome' } }],
  taxes: [{ user_id: COMPTE, property_uuid: BIEN, property_id: REF, commune: 'Bagnères', communale_cents: 110, departementale_cents: 11, regionale_cents: null, collecteur: 'plateforme', origine: 'transmis', inclus_dans_prix: false, updated_at: '2026-10-01T00:00:00Z' }],
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
  assert.deepEqual(f.taxe, { connue: false }, 'un seul type, trois etats : `[]` obligeait l ecran a un Array.isArray')
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
  for (const bloc of ['menage', 'serrures', 'fait_date']) {
    assert.equal(f[bloc], null, `${bloc} a ete lu sans cle sure`)
    assert.ok(f.indisponibles.includes(bloc))
  }
  assert.equal(f.cles_motif, 'cles_illisibles')
  // Contre-epreuve : la base n a vu AUCUNE lecture des tables TEXT.
  const tables = sb._vus.map(v => v.table)
  for (const t of ['property_cleaning_providers', 'property_locks', 'bookings_snapshot']) {
    assert.ok(!tables.includes(t), `${t} a ete interrogee alors que la cle n est pas sure`)
  }
  // ⚠ ET LES BLOCS PAR UUID RESTENT SERVIS : avis, taxe et FERMETURES ne
  // dependent d aucune migration. Les joindre en TEXT les faisait disparaitre
  // avec les cles, sans aucune raison.
  assert.ok(tables.includes('taxes_sejour'), 'la taxe se lit par UUID : elle ne doit pas tomber avec les cles')
  assert.equal(f.taxe.commune, 'Bagnères')
  assert.ok(tables.includes('fermetures'), 'les fermetures sont par UUID : un bien sans cle peut etre ferme')
  // ⚠ Aucune fermeture dans ce double, et les sejours sont illisibles : on ne
  // sait RIEN, donc `null`. Rendre « libre » serait le mensonge commercial.
  assert.equal(f.fait_date, null)
  assert.ok(f.indisponibles.includes('fait_date'))
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
  assert.deepEqual(r, { biens: [], indisponibles: [], refuses: [] })
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

test('toutes les lectures multi-lignes sont PAGINEES, aucune ne se contente d une borne', async () => {
  const sb = ficheComplete()
  await L.lireFiche(sb, { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT })
  const sansPagination = sb._vus.filter(v =>
    v.table !== 'provider_keys_migrated' &&   // module tiers, borne chez lui
    v.table !== 'canaux_releve' &&            // maybeSingle
    v.table !== 'properties' &&               // maybeSingle (la fiche)
    v.table !== 'taxes_sejour' &&             // une seule ligne, `limit(1)`
    v.table !== 'fermetures' &&               // bornee par sa FENETRE de dates, chez lib/fermetures.js
    !v.pages)
  assert.deepEqual(sansPagination.map(v => v.table), [],
    'une lecture `.limit(n)` avec n > 1000 est ramenee a 1000 par le serveur, SANS erreur : la garde ne peut plus mordre')
})

test('LE TEST QUI COMPTE (H3) : au-dela de 1000 lignes, la lecture PAGINE — elle ne tronque pas', async () => {
  // Le defaut mesure le 20 octobre : `.limit(8400)` rendait 1000 lignes sans
  // erreur, et les biens dont les sejours tombaient hors du millier recevaient
  // « rien a signaler », donc « Libre jusqu au… » sur un bien COMPLET.
  const beaucoup = Array.from({ length: 2500 }, (_, i) => ({
    user_id: COMPTE, booking_id: `b${String(i).padStart(5, '0')}`, property_id: REF,
    snapshot: { provider: 'channex', status: 'new', arrival: '2027-01-01', departure: '2027-01-03' }
  }))
  // La vraie reservation d occupation est la DERNIERE page : elle serait perdue
  // par une simple borne.
  beaucoup.push({ user_id: COMPTE, booking_id: 'zzzzz', property_id: REF,
    snapshot: { provider: 'channex', status: 'new', arrival: '2026-10-18', departure: '2026-10-22' } })
  const f = await L.lireFiche(ficheComplete({ sejours: beaucoup }),
    { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT })
  assert.equal(f.fait_date.occupe, true, '2501 sejours : la ligne qui occupe est en 3e page')
  assert.equal(f.fait_date.depart, '2026-10-22')
})

test('au-dela de 20 pages, la lecture LEVE au lieu de decider sur un morceau', async () => {
  const trop = Array.from({ length: L.PAGE * L.MAX_PAGES + 10 }, (_, i) => ({
    user_id: COMPTE, booking_id: `b${String(i).padStart(7, '0')}`, property_id: REF,
    snapshot: { provider: 'channex', status: 'new', arrival: '2027-01-01', departure: '2027-01-03' }
  }))
  const f = await L.lireFiche(ficheComplete({ sejours: trop }),
    { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT })
  assert.equal(f.fait_date, null, 'un volume anormal se dit, il ne se devine pas')
  assert.ok(f.indisponibles.includes('fait_date'))
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. Les droits par DOMAINE — le constat de sécurité de la revue du 20 octobre
// ═══════════════════════════════════════════════════════════════════════════

const TOUS_DROITS = { prestataires: true, avis: true, reglages: true, reglages_write: true }

test('LE TEST QUI COMPTE (S1) : sans `prestataires`, le bloc Menage n est pas lu DU TOUT', async () => {
  const sb = ficheComplete()
  const f = await L.lireFiche(sb, {
    compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT,
    droits: { ...TOUS_DROITS, prestataires: false }
  })
  assert.equal(f.menage, null, 'un co-hote sans ce droit ne doit pas voir les personnes')
  assert.ok(f.refuses.includes('menage'), 'et le refus se NOMME : `[]` dirait « personne dans l equipe »')
  assert.ok(!f.indisponibles.includes('menage'), 'un refus de droit n est pas une panne de lecture')
  // Contre-epreuve : la table n a meme pas ete interrogee.
  assert.ok(!sb._vus.map(v => v.table).includes('property_cleaning_providers'),
    'la table a ete lue alors que le droit est refuse')
  // Les autres blocs restent servis : le refus est CIBLE.
  assert.equal(f.serrures[0].nom, 'Entrée')
  assert.equal(f.avis.positif, 1)
})

test('S1 : sans `avis`, la classification de proprete n est pas lue', async () => {
  const sb = ficheComplete()
  const f = await L.lireFiche(sb, {
    compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT,
    droits: { ...TOUS_DROITS, avis: false }
  })
  assert.equal(f.avis, null)
  assert.ok(f.refuses.includes('avis'))
  assert.ok(!sb._vus.map(v => v.table).includes('ota_reviews'))
})

test('S1 : sans `reglages`, ni la taxe ni les serrures ne sont lues', async () => {
  // `taxes_sejour` porte `revoke all from anon, authenticated`, et
  // `property_locks_select` / `locks_select` font tous deux
  // `can_read(user_id, 'reglages', …)`. Decision de Thierry du 20 octobre : sur
  // cette fiche, la taxe est le BAREME, donc `reglages`.
  const sb = ficheComplete()
  const f = await L.lireFiche(sb, {
    compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT,
    droits: { ...TOUS_DROITS, reglages: false }
  })
  assert.equal(f.taxe, null)
  assert.equal(f.serrures, null)
  assert.deepEqual(f.refuses.sort(), ['serrures', 'taxe'])
  const tables = sb._vus.map(v => v.table)
  assert.ok(!tables.includes('taxes_sejour'))
  assert.ok(!tables.includes('property_locks'), 'SEC-1 de la re-revue : les serrures sortent du domaine reservations')
})

test('LE TEST QUI COMPTE (bareme) : la fiche ne porte AUCUN montant de taxe collecte', async () => {
  // Decision de Thierry : « les montants collectes restent sous facturation,
  // hors de cette fiche ». `communale_cents` & co sont des montants PAR
  // RESERVATION, pas un bareme.
  const f = await L.lireFiche(ficheComplete(), { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT, droits: TOUS_DROITS })
  for (const interdit of ['communale_cents', 'departementale_cents', 'regionale_cents', 'montant_cents']) {
    assert.equal(f.taxe[interdit], undefined, `${interdit} est un montant collecte : il n a rien a faire sur la fiche`)
  }
  assert.equal(f.taxe.commune, 'Bagnères')
  assert.equal(f.taxe.collecteur, 'plateforme')
})

test('R2 : un bien EN MIGRATION retrouve sa taxe par la cle TEXTE', async () => {
  // `taxes_sejour.property_uuid` est NULLABLE, et le writer ne la remplit que si
  // `provider_property_id` resout — ce qui n est pas le cas pendant une bascule.
  // Lire par le seul UUID repondait « on a lu, il n y a rien ».
  const sb = ficheComplete({
    biens: [bienDe({ migration_target_property_id: REF2 })],
    taxes: [{ user_id: COMPTE, property_uuid: null, property_id: REF2, commune: 'Colomiers',
      collecteur: 'hote', origine: 'calcule', inclus_dans_prix: false, updated_at: '2026-10-01T00:00:00Z' }]
  })
  const f = await L.lireFiche(sb, { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.equal(f.taxe.connue, true, 'la taxe existe au coeur : la taire serait « je ne sais pas » confondu avec « rien »')
  assert.equal(f.taxe.commune, 'Colomiers')
})

test('S1 : le titulaire (aucun droit refuse) voit tout, et `refuses` est vide', async () => {
  const f = await L.lireFiche(ficheComplete(), {
    compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT, droits: TOUS_DROITS
  })
  assert.deepEqual(f.refuses, [])
  assert.equal(f.menage[0].nom, 'Marie Dupont')
})

test('S1 : les QUATRE domaines sont ceux des policies RLS, pas une liste inventee', () => {
  // pcp_select       -> can_read(user_id, 'prestataires', property_id)
  // ota_reviews_select -> can_read(user_id, 'avis', property_id_ref)
  // property_locks_select / locks_select -> can_read(user_id, 'reglages', …)
  // taxes_sejour     -> table de service ; bareme = reglages (Thierry, 20/10)
  assert.equal(L.DROITS_DES_BLOCS.menage, 'prestataires')
  assert.equal(L.DROITS_DES_BLOCS.avis, 'avis')
  assert.equal(L.DROITS_DES_BLOCS.serrures, 'reglages')
  assert.equal(L.DROITS_DES_BLOCS.taxe, 'reglages')
  assert.deepEqual(L.blocsRefuses({ prestataires: false, avis: true, reglages: true }), ['menage'])
  assert.deepEqual(L.blocsRefuses(null), [], 'aucun droit fourni = lecture interne, rien n est refuse')
  // ⚠ AUCUNE BRANCHE MORTE : tout bloc qui se teste `refuses.includes(...)` doit
  // pouvoir etre refuse. C est l absence de `serrures` ici qui avait cree le trou.
  assert.deepEqual(Object.keys(L.DROITS_DES_BLOCS).sort(), ['avis', 'menage', 'serrures', 'taxe'])
})

test('M4 : le `refuses` de la LISTE ne porte QUE `avis` — les blocs jamais demandes n y figurent pas', async () => {
  // Version d'avant : « la liste ne porte pas de `refuses` ». Depuis le
  // 20 octobre 2026 elle porte les avis, donc un refus possible — mais UN SEUL.
  // Annoncer le refus de menage, taxe ou serrures ferait croire a l ecran qu on
  // lui cache un bloc qu il n a jamais demande, et c est le constat M4 intact.
  const sb = listeDe()
  const r = await L.lireListe(sb, {
    compte: COMPTE, maintenant: MAINTENANT,
    droits: { prestataires: false, avis: false, reglages: false, reglages_write: false }
  })
  assert.deepEqual(r.refuses, ['avis'])
  const tables = sb._vus.map(v => v.table)
  for (const t of ['property_cleaning_providers', 'taxes_sejour', 'property_locks']) {
    assert.ok(!tables.includes(t), `la liste ne doit pas lire ${t}`)
  }
  assert.equal(r.biens.find(b => b.nom === 'La bulle').fait_date.occupe, true)
})

// ═══════════════════════════════════════════════════════════════════════════
// 9. Deux lectures de la base qui etaient FAUSSES (H1 et H2)
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE (H1) : `pilote_tarifaire` est une CHAINE a trois etats', () => {
  // La colonne est `text check (pilote_tarifaire in ('calendrier','yieldflow'))`.
  // La lire `=== true` rendait FAUX pour La bulle et Coeur de vie 23, que
  // YieldFlow pilote depuis le 23 septembre — et l ecran en aurait deduit que le
  // calendrier decide les prix.
  assert.equal(L.publier(bienDe({ pilote_tarifaire: 'yieldflow' })).pilote_tarifaire, 'yieldflow')
  assert.equal(L.publier(bienDe({ pilote_tarifaire: 'calendrier' })).pilote_tarifaire, 'calendrier')
  // Repli raisonne du module : 'calendrier', le mode qui laisse l hote ecrire.
  assert.equal(L.publier(bienDe({ pilote_tarifaire: null })).pilote_tarifaire, 'calendrier')
  assert.equal(L.publier(bienDe({ pilote_tarifaire: 'inconnu' })).pilote_tarifaire, 'calendrier')
  // Et surtout : jamais un booleen.
  assert.notEqual(typeof L.publier(bienDe()).pilote_tarifaire, 'boolean')
})

test('LE TEST QUI COMPTE (H2) : les prestataires se lisent dans `profiles`, par `account_user_id`', async () => {
  // ⚠ CE TEST EXISTE PARCE QUE SON PREDECESSEUR MESURAIT SON PROPRE DOUBLE. La
  // fixture decrivait une table `public_tokens` avec des colonnes `nom` et
  // `prenom` qui n existent pas : le test etait VERT contre le code casse et
  // ROUGE contre le code correct. On asserte donc la REQUETE, pas seulement son
  // resultat.
  const sb = ficheComplete()
  const f = await L.lireFiche(sb, { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.equal(f.menage[0].nom, 'Marie Dupont')
  assert.equal(f.menage[0].nom_motif, null)
  const q = sb._vus.find(v => v.table === 'profiles')
  assert.ok(q, '`profiles` doit etre interrogee : `provider_id` est une FK vers profiles(id)')
  assert.equal(q.f['account_user_id'], COMPTE,
    'le compte d un profil prestataire se filtre par account_user_id, pas user_id (api/menages.js)')
  assert.ok(!sb._vus.map(v => v.table).includes('public_tokens'),
    '`public_tokens` n a ni `nom` ni `prenom` : PostgREST repond 42703 et tous les noms valent null')
})

test('H2 : un profil illisible laisse la liaison VISIBLE, et le dit', async () => {
  const f = await L.lireFiche(ficheComplete({ enPanne: { profiles: 'timeout' } }),
    { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.equal(f.menage.length, 1, 'la liaison existe : la taire ferait lire « personne au menage »')
  assert.equal(f.menage[0].nom, null)
  assert.equal(f.menage[0].nom_motif, 'lecture_impossible',
    'sans ce motif, l ecran affiche une ligne d equipe sans personne dessus')
})

test('M6 : la taxe se lit par `property_uuid`, son seul index par bien', async () => {
  const sb = ficheComplete()
  await L.lireFiche(sb, { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT, droits: TOUS_DROITS })
  const q = sb._vus.find(v => v.table === 'taxes_sejour')
  assert.equal(q.f['property_uuid'], BIEN)
  assert.equal(q.f['property_id'], undefined, 'joindre en TEXT couplait ce bloc aux cles migrees, sans raison')
})

test('L2 : un bien EN MIGRATION ne se dit plus « gere depuis votre compte Beds24 »', () => {
  const enBascule = bienDe({ provider: 'beds24', provider_property_id: REF, migration_target_property_id: REF2 })
  assert.equal(L.publier(enBascule).beds24_de_l_hote, false,
    'le bien est deja servi par le canal : la phrase serait fausse pendant toute la bascule')
  assert.equal(L.publier(bienDe({ provider: 'beds24' })).beds24_de_l_hote, true)
})

test('LE TEST QUI COMPTE (M2) : les motifs d identifiant sont ceux de la GARDE, pas une copie', async () => {
  // ⚠ Ce test existe parce que la contre-epreuve par mutation a montre que la
  // correction n etait protegee par RIEN : remettre une copie locale
  // `/^[A-Za-z0-9_-]+$/` et `/^[0-9a-fA-F-]{36}$/` laissait la suite VERTE.
  //
  // Deux ecarts mesurables entre la copie et l original :
  //   · 36 tirets passent la copie comme un « UUID » — donc la branche
  //     `id.in.()` est emise avec une valeur non-uuid, donc 22P02, donc la
  //     requete ENTIERE echoue et l hote lit « panne ». C est le piege UUID ;
  //   · la copie n avait PAS la borne {1,64} de REF_SURE_RE.
  const trenteSixTirets = '-'.repeat(36)
  const sb = listeDe()
  await L.lireListe(sb, { compte: COMPTE, refsPerimetre: [trenteSixTirets], maintenant: MAINTENANT })
  const q = sb._vus.find(v => v.table === 'properties')
  const branches = (q.or || '').split(',')
  assert.ok(!branches.some(b => b.startsWith('id.in.')),
    '36 tirets ne sont pas un UUID : la branche `id` ferait echouer la requete entiere en 22P02')

  // La borne de longueur : une reference de 65 caracteres est ECARTEE, et comme
  // c est la seule, le perimetre devient vide — on echoue ferme.
  const trop = 'a'.repeat(65)
  const r = await L.lireListe(base({ biens: [bienDe()] }), { compte: COMPTE, refsPerimetre: [trop] })
  assert.deepEqual(r.biens, [], 'une reference hors borne doit etre ecartee, pas transmise a la base')
})

// ═══════════════════════════════════════════════════════════════════════════
// 10. Les fermetures de l'hôte comptent (décision de Thierry, 20 octobre 2026)
// ═══════════════════════════════════════════════════════════════════════════

const fermeture = (debut, fin, bien = BIEN) => ({
  id: `f-${debut}`, user_id: COMPTE, property_id: bien,
  date_debut: debut, date_fin: fin, raison: 'travaux', created_at: '2026-10-01T00:00:00Z'
})

test('LE TEST QUI COMPTE : une fermeture pendant la periode => JAMAIS « Libre »', () => {
  // La demande exacte de Thierry. Aucune reservation, une fermeture a venir :
  // l ecran ne doit pas annoncer « Libre jusqu au… » sans borne.
  const f = L.faitDate([], [fermeture('2026-11-02', '2026-11-10')], '2026-10-19')
  assert.notEqual(f.type, 'libre')
  assert.equal(f.type, 'fermeture')
  assert.equal(f.du, '2026-11-02')
  assert.equal(f.au, '2026-11-10')
})

test('ferme AUJOURD HUI : bornes INCLUSES, contrairement au depart d une reservation', () => {
  // « Une fermeture du 12 au 20 couvre neuf nuits » : le 20 est encore ferme,
  // alors qu un depart le 20 libere la nuit. Deux conventions, et elles different.
  assert.equal(L.faitDate([], [fermeture('2026-10-12', '2026-10-20')], '2026-10-20').type, 'ferme')
  assert.equal(L.faitDate([], [fermeture('2026-10-12', '2026-10-20')], '2026-10-21').type, 'libre')
  const f = L.faitDate([], [fermeture('2026-10-12', '2026-10-20')], '2026-10-19')
  assert.equal(f.ferme, true)
  assert.equal(f.fermeture_jusqu_au, '2026-10-20')
  assert.equal(f.au, '2026-10-20')
})

test('le prochain evenement est le PLUS PROCHE, reservation ou fermeture', () => {
  const resaProche = L.faitDate([sejour('2026-10-25', '2026-10-28')], [fermeture('2026-11-02', '2026-11-10')], '2026-10-19')
  assert.equal(resaProche.type, 'arrivee')
  assert.equal(resaProche.du, '2026-10-25')

  const fermetureProche = L.faitDate([sejour('2026-12-01', '2026-12-05')], [fermeture('2026-10-22', '2026-10-30')], '2026-10-19')
  assert.equal(fermetureProche.type, 'fermeture')
  assert.equal(fermetureProche.du, '2026-10-22')
  // Les deux faits restent lisibles a cote du type.
  assert.equal(fermetureProche.prochaine_arrivee, '2026-12-01')
})

test('si une reservation ET une fermeture couvrent aujourd hui, l OCCUPATION gagne', () => {
  // C est le symptome de l incident stop_sell : un fait plus fort qu une
  // intention, et l hote doit le voir.
  const f = L.faitDate([sejour('2026-10-18', '2026-10-22')], [fermeture('2026-10-15', '2026-10-25')], '2026-10-19')
  assert.equal(f.type, 'occupe')
  assert.equal(f.occupe, true)
  assert.equal(f.ferme, true, 'la fermeture reste dite : les deux faits coexistent')
})

test('la fiche lit les fermetures par UUID, dans une fenetre bornee', async () => {
  const sb = ficheComplete({ sejours: [], fermetures: [fermeture('2026-11-02', '2026-11-10')] })
  const f = await L.lireFiche(sb, { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.equal(f.fait_date.type, 'fermeture')
  const q = sb._vus.find(v => v.table === 'fermetures')
  assert.ok(q.ins.some(i => i.c === 'property_id' && i.v.includes(BIEN)), 'par UUID, pas par cle partenaire')
  assert.ok(q.lte['date_debut'] > '2028-10', `la fenetre doit couvrir ${L.FENETRE_FERMETURES_JOURS} jours`)
})

test('la LISTE compte aussi les fermetures, bien par bien', async () => {
  const r = await L.lireListe(listeDe({ sejours: [], fermetures: [fermeture('2026-10-15', '2026-10-25')] }),
    { compte: COMPTE, maintenant: MAINTENANT })
  assert.equal(r.biens.find(b => b.nom === 'La bulle').fait_date.type, 'ferme')
  assert.equal(r.biens.find(b => b.nom === 'Cœur de vie 23').fait_date.type, 'libre',
    'la fermeture de l un ne ferme pas l autre')
})

test('fermetures illisibles : fait_date `null`, jamais « Libre »', async () => {
  const r = await L.lireListe(listeDe({ enPanne: { fermetures: 'timeout' } }), { compte: COMPTE, maintenant: MAINTENANT })
  for (const b of r.biens) assert.equal(b.fait_date, null)
  assert.ok(r.indisponibles.includes('fait_date'))
})

// ═══════════════════════════════════════════════════════════════════════════
// 11. Quatre corrections qui n'avaient aucun filet (constats M1, M2, M3, M5)
// ═══════════════════════════════════════════════════════════════════════════

test('M1 : `reglages: read` ne suffit pas a PROMETTRE une suppression — il faut `write`', () => {
  // ⚠ La contre-epreuve par mutation a montre que `peutEcrire → peutLire` sur
  // l endpoint laissait la suite VERTE : le test d avant utilisait
  // `reglages: none`, qui echoue des deux cotes. Il faut le cas intermediaire.
  const vu = { vuLe: '2026-10-19T08:00:00Z' }
  assert.equal(L.suppressionPossible(bienDe(), [{ mappe: false }], { ...vu, peutSupprimer: true }).possible, true)
  assert.equal(L.suppressionPossible(bienDe(), [{ mappe: false }], { ...vu, peutSupprimer: false }).motif, 'droit_refuse')
})

test('M2 : une horloge des canaux EN PANNE n est pas « jamais relevee »', async () => {
  // `lib/canaux-du-bien` l a deja appris : « les trois etats ne se confondent
  // pas, et la premiere version les confondait ». Mesure : cette correction
  // n etait protegee par aucun test.
  const f = await L.lireFiche(ficheComplete({ enPanne: { canaux_releve: 'timeout' } }),
    { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.equal(f.canaux.length, 2, 'les pastilles restent servies : l horloge est un ornement')
  assert.equal(f.canaux_echec, true, 'mais l echec se DIT — sinon la date vieillit sans que personne sache pourquoi')
})

test('M3 : cles illisibles ET droit refuse : le bloc est `refuse`, pas `indisponible`', async () => {
  const f = await L.lireFiche(ficheComplete({ enPanne: { provider_keys_migrated: 'timeout' } }), {
    compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT,
    droits: { ...TOUS_DROITS, prestataires: false }
  })
  assert.equal(f.menage, null)
  assert.ok(f.refuses.includes('menage'))
  assert.ok(!f.indisponibles.includes('menage'),
    'un bloc qu on n a pas le droit de voir ne doit pas etre compte comme une panne de lecture')
  // Les autres blocs TEXT, eux, sont bien des pannes.
  assert.ok(f.indisponibles.includes('serrures'))
})

test('M5 : un avis MASQUE ne compte pas', async () => {
  const f = await L.lireFiche(ficheComplete({
    avis: [
      { id: 'a1', user_id: COMPTE, property_id: BIEN, is_hidden: false, ai_clean_verdict: 'positif', ai_analyzed_at: '2026-10-10T00:00:00Z', received_at: '2026-10-10T00:00:00Z' },
      { id: 'a2', user_id: COMPTE, property_id: BIEN, is_hidden: true, ai_clean_verdict: 'remarque', ai_analyzed_at: '2026-10-10T00:00:00Z', received_at: '2026-10-10T00:00:00Z' }
    ]
  }), { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.equal(f.avis.total, 1)
  assert.equal(f.avis.remarque, 0, 'un avis masque par l hote ne doit pas peser sur ses pouces')
})

test('R1 : la liste est servie dans l ordre ALPHABETIQUE, avec un departiteur unique', async () => {
  // La pagination avait chasse l ordre d affichage : la liste sortait triee par
  // UUID. Invisible a l etape 0 (pas d ecran), heritee telle quelle a l etape 1.
  const sb = base({ biens: [
    bienDe({ id: BIEN2, name: 'Zanzibar', provider_property_id: REF2 }),
    bienDe({ id: BIEN, name: 'Abricot' })
  ] })
  const r = await L.lireListe(sb, { compte: COMPTE, maintenant: MAINTENANT })
  assert.deepEqual(r.biens.map(b => b.nom), ['Abricot', 'Zanzibar'])
  const q = sb._vus.find(v => v.table === 'properties')
  assert.deepEqual(q.ordres.map(o => o.c), ['name', 'id'],
    'le nom pour l ecran, l id pour que la pagination soit deterministe')
})

test('LE TEST QUI COMPTE : `origine: absent` n est PAS un bareme (recette staging du 20 octobre)', async () => {
  // Mesure reelle : Loft Pilotable rendait `connue: true` avec `commune: null`
  // et `origine: 'absent'` — c est-a-dire « aucune taxe de sejour transmise ».
  // L ecran aurait affiche un bloc « Taxe de sejour » avec un collecteur et
  // rien d autre : un bloc vide qui a l air plein.
  const f = await L.lireFiche(ficheComplete({
    taxes: [{ user_id: COMPTE, property_uuid: BIEN, property_id: REF, commune: null,
      collecteur: 'plateforme', origine: 'absent', inclus_dans_prix: null, updated_at: '2026-10-09T08:08:56.222+00:00' }]
  }), { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.equal(f.taxe.connue, false)
  assert.equal(f.taxe.motif, 'aucune_taxe_transmise')
  assert.equal(f.taxe.commune, undefined, 'rien d autre ne descend : il n y a pas de bareme a montrer')
  // Contre-epreuve : une vraie ligne, elle, reste connue.
  const g = await L.lireFiche(ficheComplete(), { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.equal(g.taxe.connue, true)
  assert.equal(g.taxe.commune, 'Bagnères')
})

// ═══════════════════════════════════════════════════════════════════════════
// 12. Les avis sur la LISTE (demande de Thierry, 20 octobre 2026)
// ═══════════════════════════════════════════════════════════════════════════
//
// « Au lieu de Fermé jusqu'au mercredi 21 octobre, met les avis total sur le
// logement. » La carte portait un fait date ; elle porte desormais la note et le
// NOMBRE TOTAL d'avis du logement — tous, pas une fenetre de 30 jours comme la
// fiche. `fait_date` reste dans la reponse : la fiche (etape 2) l'affiche.
//
// ⚠ ET C'EST UN BLOC D'UN AUTRE DOMAINE SUR LA LISTE, LE PREMIER. Le commentaire
// de `lireListe` l'annonçait : « le jour ou la liste portera un tel bloc, le
// parametre revient AVEC sa garde ». `ota_reviews` est gardee par
// `can_read(user_id, 'avis', …)` — c'est le constat de SECURITE de la revue du
// 20 octobre, applique a la liste.

const avisDe = (property_id, overall_score, extra = {}) => ({
  id: `av-${property_id}-${overall_score}-${Math.random().toString(36).slice(2, 7)}`,
  user_id: COMPTE, property_id, property_id_ref: REF, statut: 'confirme',
  is_hidden: false, overall_score, received_at: '2026-10-10T00:00:00Z', ...extra
})

test('la liste : le total des avis et la moyenne, bien par bien', async () => {
  const r = await L.lireListe(listeDe({
    avis: [avisDe(BIEN, 10), avisDe(BIEN, 9), avisDe(BIEN2, 8)]
  }), { compte: COMPTE, maintenant: MAINTENANT, droits: TOUS_DROITS })
  const bulle = r.biens.find(b => b.nom === 'La bulle')
  const coeur = r.biens.find(b => b.nom === 'Cœur de vie 23')
  assert.deepEqual(bulle.avis, { total: 2, notes: 2, moyenne: 9.5 })
  assert.deepEqual(coeur.avis, { total: 1, notes: 1, moyenne: 8 },
    'les avis d un bien ne comptent jamais pour un autre')
})

test('LE TEST QUI COMPTE : la moyenne descend sur l ECHELLE DU COEUR (/10), la mise a /5 est a l ecran', async () => {
  // Deux normalisations valent deux chiffres differents pour la meme note. Le
  // coeur stocke brut (Airbnb comme Booking montent a 10, mesure du 20 octobre
  // 2026 sur les 702 avis de production) et `shared/aujourdhui.js` divise par 2
  // a l affichage, « partout » (decision de Thierry).
  const r = await L.lireListe(listeDe({ avis: [avisDe(BIEN, 9.8)] }),
    { compte: COMPTE, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.equal(r.biens.find(b => b.nom === 'La bulle').avis.moyenne, 9.8)
})

test('LE TEST QUI COMPTE (SECURITE) : sans le droit `avis`, rien n est lu et rien n est rendu', async () => {
  const sb = listeDe({ avis: [avisDe(BIEN, 10)] })
  const r = await L.lireListe(sb, {
    compte: COMPTE, maintenant: MAINTENANT, droits: { ...TOUS_DROITS, avis: false }
  })
  assert.ok(r.biens.every(b => b.avis === null))
  assert.ok(r.refuses.includes('avis'))
  assert.ok(!r.indisponibles.includes('avis'),
    'un refus de droit n est pas une panne : les deux ne se confondent pas')
  assert.ok(!sb._vus.map(v => v.table).includes('ota_reviews'),
    'le droit se verifie AVANT la lecture, sinon la donnee a deja quitte la base')
})

test('LE TEST QUI COMPTE : avis illisibles => `null`, JAMAIS zero', async () => {
  const r = await L.lireListe(listeDe({ enPanne: { ota_reviews: 'timeout' } }),
    { compte: COMPTE, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.ok(r.biens.every(b => b.avis === null),
    'afficher « Aucun avis » a un hote qui en a 336 est le meme mensonge que « Libre » sur un bien complet')
  assert.ok(r.indisponibles.includes('avis'))
})

test('un bien SANS avis : lu, et vide — ce n est pas une panne', async () => {
  const r = await L.lireListe(listeDe({ avis: [] }),
    { compte: COMPTE, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.deepEqual(r.biens.find(b => b.nom === 'La bulle').avis, { total: 0, notes: 0, moyenne: null })
  assert.deepEqual(r.indisponibles, [])
})

test('un avis SANS NOTE compte dans le total, pas dans la moyenne (les avis directs, 5 en production)', async () => {
  const r = await L.lireListe(listeDe({
    avis: [avisDe(BIEN, 10), avisDe(BIEN, null, { ota: 'direct' })]
  }), { compte: COMPTE, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.deepEqual(r.biens.find(b => b.nom === 'La bulle').avis, { total: 2, notes: 1, moyenne: 10 })
})

test('un avis MASQUE ou NON CONFIRME ne compte pas', async () => {
  const r = await L.lireListe(listeDe({
    avis: [
      avisDe(BIEN, 10),
      avisDe(BIEN, 2, { is_hidden: true }),            // masque par l OTA : 33 en production
      avisDe(BIEN, 2, { statut: 'a_valider' })         // detection en attente de validation humaine
    ]
  }), { compte: COMPTE, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.deepEqual(r.biens.find(b => b.nom === 'La bulle').avis, { total: 1, notes: 1, moyenne: 10 })
})

test('le total est de TOUJOURS, pas de 30 jours — aucune borne de date n est posee', async () => {
  const sb = listeDe({ avis: [avisDe(BIEN, 10, { received_at: '2024-01-01T00:00:00Z' })] })
  const r = await L.lireListe(sb, { compte: COMPTE, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.equal(r.biens.find(b => b.nom === 'La bulle').avis.total, 1,
    'un avis de 2024 compte dans le total du logement')
  const q = sb._vus.filter(v => v.table === 'ota_reviews').pop()
  assert.equal(q.gte['received_at'], undefined, 'la liste ne borne pas : c est un TOTAL')
})

test('les avis de la liste sont PAGINES et cloisonnes par compte', async () => {
  const sb = listeDe({ avis: Array.from({ length: 1200 }, (_, i) => avisDe(BIEN, 10, { id: `a${String(i).padStart(5, '0')}` })) })
  const r = await L.lireListe(sb, { compte: COMPTE, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.equal(r.biens.find(b => b.nom === 'La bulle').avis.total, 1200,
    'une lecture bornee a 1000 aurait rendu 1000 sans erreur (constat H3)')
  const acces = sb._vus.filter(v => v.table === 'ota_reviews')
  assert.equal(acces[0].f['user_id'], COMPTE)
  // ⚠ UNE REQUETE NEUVE PAR PAGE (constat M6) : `lirePagine` est une fabrique,
  // donc deux pages lues font deux acces a la table, pas un objet a deux pages.
  assert.ok(acces.length >= 2, `une seule page lue : ${acces.length}`)
})
