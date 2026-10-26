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
const fs = require('node:fs')

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
  prix_minimum: 13000, included_guests: 2, extra_guest_fee: 15, rate_sync_mode: 'managed',
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
    // Les tables que la purge de suppression efface, pour le COMPTAGE.
    messages = [], menages = [], codes = [],
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
          property_locks: serrures, taxes_sejour: taxes, fermetures: fermetures,
          messages: messages, menage_events: menages, access_codes: codes
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
        // ⚠ `count` ET `head` SONT HONORÉS, comme chez PostgREST : le comptage de
        // la suppression ne lit AUCUNE ligne (`head: true`) et ne regarde que
        // `count`. Un double qui ignorerait l'option rendrait `count: undefined`
        // et le code le lirait comme « illisible » — vert pour la mauvaise raison.
        select (cols, opts) { if (opts && opts.count) { a.compte = true; a.head = opts.head === true } return chain },
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
  const vu = { releveDuCompte: '2026-10-19T08:00:00Z' }
  assert.equal(L.suppressionPossible(bienDe(), [{ ota: 'airbnb', mappe: false }], vu).possible, true)
  assert.equal(L.suppressionPossible(bienDe(), [], vu).possible, true)
})

test('LE TEST QUI COMPTE (H4) : `mappe === null` ne vaut PAS « pas relie »', () => {
  // Le writer pose `null` quand il n'a pas pu conclure, et jamais `false` par
  // defaut. Le lire comme « pas relie » ouvrait le bouton Supprimer sur un bien
  // encore en vente sur Airbnb.
  const r = L.suppressionPossible(bienDe(), [{ ota: 'airbnb', mappe: null }], { releveDuCompte: '2026-10-19T08:00:00Z' })
  assert.equal(r.possible, null)
  assert.equal(r.motif, 'mapping_inconnu')
})

test('LE TEST QUI COMPTE (M1a) : « jamais releve » ne vaut pas « pas relie »', () => {
  // La dette 59 n'est en prod que depuis le 19 octobre : un compte jamais releve
  // a `canaux = []`, ce qui n'autorise rien.
  const r = L.suppressionPossible(bienDe(), [], { releveDuCompte: null })
  assert.equal(r.possible, null)
  assert.equal(r.motif, 'jamais_releve')
})

// ═══════════════════════════════════════════════════════════════════════════
// LE RELEVE EST UN FAIT DE COMPTE — decision de Thierry, 22 octobre 2026
// ═══════════════════════════════════════════════════════════════════════════
// ⚠ CE QUE CES TESTS FERMENT : un logement NEUF etait insupprimable. La
// fonction recevait `vuLe`, la FRAICHEUR AFFICHEE du bien — et
// `fraicheurDuBien` rend `null` pour un bien sans aucun canal, VOLONTAIREMENT
// (« une date qui parle de rien » a l'ecran). La condition `!canaux.length &&
// !vuLe` se reduisait donc a `!canaux.length` : tout bien sans canal passait
// pour inconnu, et la fiche V5 n'a aucun bouton pour lancer un releve.
//
// La dette etait ECRITE dans shared/logements-liste.js depuis l'etape 0 :
// « sa branche `jamais_releve` est degeneree ». Elle se ferme ici.

test('LE TEST QUI COMPTE : un logement NEUF se supprime, si le compte a ete releve', () => {
  // Aucun canal pour ce bien + un releve de COMPTE qui a reussi = « aucun canal
  // relie ». C'est un FAIT, pas une ignorance.
  const r = L.suppressionPossible(bienDe(), [], { releveDuCompte: '2026-10-22T08:00:00Z' })
  assert.equal(r.possible, true, 'un logement qu on vient de creer doit pouvoir etre efface')
  assert.equal(r.motif, null)
})

test('LE TEST QUI COMPTE : un releve de compte EN ECHEC ne conclut rien', () => {
  // « On ne sait pas » reste reserve a deux cas, et a eux seuls : le releve du
  // compte n'a jamais reussi, ou il a echoue. Un echec silencieux qui
  // ouvrirait la suppression est exactement ce que la regle interdit.
  const r = L.suppressionPossible(bienDe(), [], {
    releveDuCompte: '2026-10-22T08:00:00Z', releveEnEchec: true
  })
  assert.equal(r.possible, null)
  assert.equal(r.motif, 'jamais_releve')
})

test('la fraicheur AFFICHEE du bien ne decide plus de la suppression', () => {
  // ⚠ LES DEUX QUESTIONS SE SEPARENT, et c'est tout l'objet du correctif :
  // « quelle est la fraicheur de CE bien ? » (null pour un bien sans canal,
  // volontairement) et « un releve a-t-il eu lieu sur ce COMPTE ? ».
  // Passer l'ancien nom ne doit plus rien autoriser.
  const r = L.suppressionPossible(bienDe(), [], { vuLe: '2026-10-22T08:00:00Z' })
  assert.equal(r.possible, null,
    'l ancienne option ne doit pas suffire : sinon les deux questions restent confondues')
  assert.equal(r.motif, 'jamais_releve')
})

test('LE TEST QUI COMPTE (M1b) : sans `reglages: write`, on ne PROMET pas une suppression', () => {
  // La garde DELETE exige reglages:write. Rendre `true` a un profil en lecture
  // lui promettrait une action refusee en 403, et la spec §5 veut « aucun bouton
  // d action dans le DOM » pour ce profil.
  const r = L.suppressionPossible(bienDe(), [{ mappe: false }], { releveDuCompte: 'x', peutSupprimer: false })
  assert.equal(r.possible, null)
  assert.equal(r.motif, 'droit_refuse')
})

test('LE TEST QUI COMPTE : un bien EN VENTE ne se supprime pas, MEME sans plan tarifaire', () => {
  // ⚠ CONSTAT DE LA RECETTE DE THIERRY, 22 octobre 2026. Un bien dont Airbnb
  // etait « en vente » montrait un bouton ACTIF et proposait d'effacer
  // 77 reservations. La garde ne regardait les canaux QU'APRES avoir exige
  // `provider_rate_plan_id`, parce que le serveur interroge le partenaire PAR
  // ce plan. Sans plan, il ne verifiait rien — et l'ecran n'annoncait rien.
  //
  // Le COEUR, lui, porte le mappage sans aucun appel au partenaire. C'est la
  // question que l'hote se pose : « ce logement est-il en vente ? »
  const enVente = [{ ota: 'airbnb', mappe: true, actif: true }]
  for (const bien of [
    bienDe({ provider_rate_plan_id: null }),
    bienDe({ provider: 'beds24' }),
    bienDe({ provider_property_id: null })
  ]) {
    const r = L.suppressionPossible(bien, enVente)
    assert.equal(r.possible, false, JSON.stringify(bien.provider))
    assert.equal(r.motif, 'annonce_reliee')
  }

  // Et sans canal relie, le bouton reste actif : il n'y a rien a casser.
  //
  // ⚠ A CONDITION QUE LE RELEVE AIT ABOUTI, et cette precision est le
  // correctif du 26 octobre 2026. Ce test appelait `suppressionPossible` SANS
  // options, donc avec `releveDuCompte = null` — ce qui ne veut pas dire « ce
  // bien n'a pas de canal » mais « on n'a jamais reussi a le savoir ». Les deux
  // etaient confondus, et c'est ce qui laissait passer le defaut mesure en
  // review : un bien du canal sans plan de base, dont le coeur ne disait rien,
  // s'effacait sans refus. Le cas « coeur muet » a desormais son test a lui,
  // juste apres celui du bien Beds24.
  const releveFait = { releveDuCompte: '2026-10-26T08:00:00Z' }
  assert.equal(L.suppressionPossible(bienDe({ provider_rate_plan_id: null }), [], releveFait).possible, true)
  assert.equal(L.suppressionPossible(bienDe({ provider: 'beds24' }), []).possible, true,
    'un bien Beds24 ne depend pas du releve de l autre partenaire')

  // Des canaux ILLISIBLES n'ouvrent jamais l'action la plus destructrice,
  // quel que soit le plan tarifaire (constat H4 de l'etape 0).
  assert.equal(L.suppressionPossible(bienDe({ provider_rate_plan_id: null }), null).possible, null)

  // ⚠ ET LA SECONDE MOITIE DU MEME CORRECTIF (constat de la revue du
  // 23 octobre 2026). Le 22, le refus sur un canal MAPPE est passe au-dessus du
  // test du plan tarifaire ; la garde du mappage INDETERMINE est restee
  // dessous. Un bien sans plan tarifaire dont un canal porte `mappe == null`
  // rendait `possible: true` : la fiche montrait une pastille « indetermine »
  // et, juste en dessous, un Supprimer ACTIF.
  const incertain = [{ ota: 'airbnb', mappe: null, actif: true }]
  for (const bien of [
    bienDe({ provider_rate_plan_id: null }),
    bienDe({ provider_property_id: null }),
    bienDe()
  ]) {
    const r = L.suppressionPossible(bien, incertain, { releveDuCompte: '2026-10-19T08:00:00Z' })
    assert.equal(r.possible, null, `plan ${bien.provider_rate_plan_id} / ref ${bien.provider_property_id}`)
    assert.equal(r.motif, 'mapping_inconnu')
  }
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
  assert.equal(f.avis.total_proprete, 0)
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
  assert.equal(f.avis.total_proprete, 2)
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
  const r = await L.lireListe(base({ biens: [] }), { compte: COMPTE, droits: TOUS_DROITS })
  assert.deepEqual(r, { biens: [], indisponibles: [], refuses: [] })
  // Sans droits, meme forme — mais le bloc d'un autre domaine est refuse.
  const sansDroits = await L.lireListe(base({ biens: [] }), { compte: COMPTE })
  assert.deepEqual(sansDroits, { biens: [], indisponibles: [], refuses: ['avis'] })
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
  const vu = { releveDuCompte: '2026-10-19T08:00:00Z' }
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

test('LE TEST QUI COMPTE : la FICHE descend le fait de compte, dans ses trois etats', async () => {
  // ⚠ FAUX VERT MESURE LE 23 OCTOBRE 2026 (constat de la revue) : muter
  // `fiche.canaux_releve_fait = false` dans lib/logement/lecture.js laissait
  // 139 tests sur 139 au vert. Les quatre assertions qui existaient portaient
  // sur `lireListe` (`r.biens[].canaux_releve_fait`) ; la FICHE, elle, n'en
  // avait aucune — et c'est le champ dont `canauxHtml` se sert pour ne pas
  // confondre « aucun canal relie » avec « jamais releve ».
  //
  // Les trois etats, parce qu'ils ne se confondent pas : releve fait, releve
  // jamais fait (ou en echec), lecture impossible.
  const fait = await L.lireFiche(ficheComplete(),
    { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.equal(fait.canaux_releve_fait, true, 'horloge posee et `ok` : le compte a bien ete releve')

  const jamais = await L.lireFiche(ficheComplete({ horloge: null }),
    { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.equal(jamais.canaux_releve_fait, false, 'aucune ligne de releve : l ecran doit pouvoir le dire')

  const echec = await L.lireFiche(ficheComplete({ enPanne: { canaux_releve: 'timeout' } }),
    { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.equal(echec.canaux_releve_fait, false,
    'un releve en echec n est pas un releve : « aucun canal relie » serait une affirmation sans preuve')

  const illisible = await L.lireFiche(ficheComplete({ enPanne: { canaux_du_bien: 'timeout' } }),
    { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.equal(illisible.canaux_releve_fait, null,
    '`null`, pas `false` : on ne sait pas, et l ecran ne doit pas conclure')
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
  assert.equal(f.avis.total_proprete, 1)
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

// ⚠ `ota` EST TOUJOURS RENSEIGNE EN BASE, et depuis la dette 76 il DECIDE :
// une source hors table n'est plus convertie du tout (decision de Thierry du
// 20 octobre 2026 — supposer /10 pour un canal qui note sur 5 affichait ses
// avis a la moitie de leur valeur, sans un mot). Une fixture sans `ota`
// decrivait donc un cas que les writers ne produisent pas : ils ecrivent
// `airbnb`, `booking` ou `direct`, jamais rien.
const avisDe = (property_id, overall_score, extra = {}) => ({
  id: `av-${property_id}-${overall_score}-${Math.random().toString(36).slice(2, 7)}`,
  user_id: COMPTE, property_id, property_id_ref: REF, statut: 'confirme', ota: 'airbnb',
  is_hidden: false, overall_score, content: 'Sejour parfait',
  received_at: '2026-10-10T00:00:00Z', ...extra
})

test('la liste : le total des avis et la note, bien par bien', async () => {
  const r = await L.lireListe(listeDe({
    avis: [avisDe(BIEN, 10), avisDe(BIEN, 9), avisDe(BIEN2, 8)]
  }), { compte: COMPTE, maintenant: MAINTENANT, droits: TOUS_DROITS })
  const bulle = r.biens.find(b => b.nom === 'La bulle')
  const coeur = r.biens.find(b => b.nom === 'Cœur de vie 23')
  assert.deepEqual(bulle.avis, { total: 2, notes: 2, note_sur_5: 4.8 })
  assert.deepEqual(coeur.avis, { total: 1, notes: 1, note_sur_5: 4 },
    'les avis d un bien ne comptent jamais pour un autre')
})

test('LE TEST QUI COMPTE : la note descend DEJA SUR 5, arrondie UNE SEULE FOIS', async () => {
  // Decision de Thierry du 20 octobre 2026. L'ecran n'a plus rien a diviser :
  // deux conversions dans deux fichiers affichent deux notes pour le meme
  // logement, et deux arrondis en affichent une troisieme.
  const r = await L.lireListe(listeDe({ avis: [avisDe(BIEN, 9.8)] }),
    { compte: COMPTE, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.equal(r.biens.find(b => b.nom === 'La bulle').avis.note_sur_5, 4.9)
  assert.equal(r.biens.find(b => b.nom === 'La bulle').avis.moyenne, undefined,
    'la moyenne sur 10 ne descend plus : elle invitait a rediviser')
})

test('LE TEST QUI COMPTE (decision de Thierry) : 10 avis Airbnb a 5 etoiles + 10 Booking a 8 => 4,5 / 5', async () => {
  // L'enonce de Thierry, a la lettre — en ecrivant les notes COMME LA BASE LES
  // PORTE. Airbnb note sur 5 etoiles chez lui, mais livre la note deja ramenee
  // sur 10 : « 5 etoiles » arrive a 10 (mesure du 20 octobre 2026, 563 notes
  // Airbnb sur 598 depassent 5, ce qui est impossible sur une echelle a 5).
  // Les deux lectures donnent le meme resultat, parce que 5 etoiles et 10/10
  // sont la meme note.
  const r = await L.lireListe(listeDe({
    avis: [
      ...Array.from({ length: 10 }, (_, i) => avisDe(BIEN, 10, { id: `ab${i}`, ota: 'airbnb' })),
      ...Array.from({ length: 10 }, (_, i) => avisDe(BIEN, 8, { id: `bk${i}`, ota: 'booking' }))
    ]
  }), { compte: COMPTE, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.deepEqual(r.biens.find(b => b.nom === 'La bulle').avis,
    { total: 20, notes: 20, note_sur_5: 4.5 })
})

test('LA PONDERATION EST PAR AVIS, PAS PAR CANAL — un canal a 300 avis pese 300', async () => {
  // Moyenner les moyennes de chaque canal donnerait (5,0 + 2,5) / 2 = 3,8 ;
  // ponderer par le nombre d'avis donne (5,0 x 10 + 2,5 x 1) / 11 = 4,8.
  const r = await L.lireListe(listeDe({
    avis: [
      ...Array.from({ length: 10 }, (_, i) => avisDe(BIEN, 10, { id: `a${i}`, ota: 'airbnb' })),
      avisDe(BIEN, 5, { id: 'b0', ota: 'booking' })
    ]
  }), { compte: COMPTE, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.equal(r.biens.find(b => b.nom === 'La bulle').avis.note_sur_5, 4.8)
})

test('LE TEST QUI COMPTE : AUCUN ARRONDI INTERMEDIAIRE', async () => {
  // Trois notes dont la moyenne exacte sur 10 vaut 9,65 : arrondir la moyenne
  // sur 10 (9,7) PUIS diviser donnerait 4,9. Le calcul exact donne 4,825, donc
  // 4,8. C'est le defaut de la premiere version, et la raison de la consigne.
  const r = await L.lireListe(listeDe({
    avis: [avisDe(BIEN, 9.5, { id: 'x1' }), avisDe(BIEN, 9.8, { id: 'x2' }), avisDe(BIEN, 9.65, { id: 'x3' })]
  }), { compte: COMPTE, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.equal(r.biens.find(b => b.nom === 'La bulle').avis.note_sur_5, 4.8)
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
  assert.deepEqual(r.biens.find(b => b.nom === 'La bulle').avis, { total: 0, notes: 0, note_sur_5: null })
  assert.deepEqual(r.indisponibles, [])
})

test('un avis SANS NOTE compte dans le total, pas dans la note (5 detections de messages en production)', async () => {
  const r = await L.lireListe(listeDe({
    avis: [avisDe(BIEN, 10), avisDe(BIEN, null, { ota: 'direct' })]
  }), { compte: COMPTE, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.deepEqual(r.biens.find(b => b.nom === 'La bulle').avis, { total: 2, notes: 1, note_sur_5: 5 })
})

test('un avis MASQUE ou NON CONFIRME ne compte pas', async () => {
  const r = await L.lireListe(listeDe({
    avis: [
      avisDe(BIEN, 10),
      avisDe(BIEN, 2, { is_hidden: true }),            // masque par l OTA : 33 en production
      avisDe(BIEN, 2, { statut: 'detecte' })           // detection en attente de validation humaine
    ]
  }), { compte: COMPTE, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.deepEqual(r.biens.find(b => b.nom === 'La bulle').avis, { total: 1, notes: 1, note_sur_5: 5 })
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

// ⚠ LE CAS QUE PERSONNE NE COUVRAIT (constat G1 de la revue du 20 octobre 2026).

test('LE TEST QUI COMPTE (G1) : un objet d avis VIDE mais visible n est pas un avis', async () => {
  // L'objet Channex nait au depart, cache et vide ; Airbnb le revele au bout de
  // 14 jours MEME si le voyageur n'a rien ecrit (lib/avis/naissance.js). Il a
  // alors `is_hidden: false`, pas de texte, et une note a 0 ou absente. Le
  // compter gonflerait le total ET entrerait a 0/10 dans la moyenne — le defaut
  // de la recette du 7 octobre, arrive par l'autre porte.
  const r = await L.lireListe(listeDe({
    avis: [
      avisDe(BIEN, 10),
      { id: 'vide-1', user_id: COMPTE, property_id: BIEN, property_id_ref: REF, statut: 'confirme',
        is_hidden: false, overall_score: 0, content: null, content_public: null, received_at: '2026-10-10T00:00:00Z' },
      { id: 'vide-2', user_id: COMPTE, property_id: BIEN, property_id_ref: REF, statut: 'confirme',
        is_hidden: false, overall_score: null, content: null, content_public: null, received_at: '2026-10-10T00:00:00Z' }
    ]
  }), { compte: COMPTE, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.deepEqual(r.biens.find(b => b.nom === 'La bulle').avis, { total: 1, notes: 1, note_sur_5: 5 },
    'deux objets vides ne sont ni deux avis, ni deux zeros dans la moyenne')
})

test('G1 : un avis NOTE A ZERO mais qui porte un TEXTE est un avis — sans peser sur la moyenne', async () => {
  // Contre-epreuve : la regle du depot est « une note > 0 OU un texte ». Ecarter
  // tout ce qui vaut zero ferait disparaitre un avis que le voyageur a bien
  // ecrit. Il compte dans le total, pas dans la moyenne : zero n'est une note
  // chez aucun canal (Booking part de 1, Airbnb de 1/5 normalise a 2/10).
  const r = await L.lireListe(listeDe({
    avis: [avisDe(BIEN, 10), avisDe(BIEN, 0, { content: 'Rien a redire, mais la cle etait difficile a trouver' })]
  }), { compte: COMPTE, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.deepEqual(r.biens.find(b => b.nom === 'La bulle').avis, { total: 2, notes: 1, note_sur_5: 5 })
})

test('G1 : un avis SANS NOTE mais avec texte compte (les 5 detections de messages en production)', async () => {
  const r = await L.lireListe(listeDe({
    avis: [avisDe(BIEN, 9), avisDe(BIEN, null, { content_public: 'Merci pour tout !' })]
  }), { compte: COMPTE, maintenant: MAINTENANT, droits: TOUS_DROITS })
  assert.deepEqual(r.biens.find(b => b.nom === 'La bulle').avis, { total: 2, notes: 1, note_sur_5: 4.5 })
})

test('LE TEST QUI COMPTE (M3) : sans `droits`, la liste echoue FERME sur les avis', async () => {
  // Le seul appelant les passe — mais un script, ou un endpoint de demain, qui
  // les oublierait servirait les notes EN SERVICE KEY, donc sans RLS. Le
  // voisinage fait deja ce choix : perimetre vide => ferme.
  const sb = listeDe({ avis: [avisDe(BIEN, 10)] })
  const r = await L.lireListe(sb, { compte: COMPTE, maintenant: MAINTENANT })
  assert.ok(r.biens.every(b => b.avis === null))
  assert.deepEqual(r.refuses, ['avis'])
  assert.ok(!sb._vus.map(v => v.table).includes('ota_reviews'))
})

test('LE TEST QUI COMPTE : le prix plancher est rendu en EUROS, pas en centimes', async () => {
  // ⚠ `properties.prix_minimum` EST EN CENTIMES — seule de ses quatre voisines
  // du bloc Prix (`base_price`, `included_guests`, `extra_guest_fee` sont en
  // euros). Sans division, la fiche affichait « 13 000 € » pour le plancher de
  // 130 € d'un bien, juste sous un prix de base juste : la ligne la plus
  // sensible du bloc (la garde anti-nuit-a-0) etait fausse exactement quand
  // elle etait renseignee. Releve en revue de 5c0d759 ; rien ne le gardait.
  const f = await L.lireFiche(ficheComplete(), { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT })
  assert.equal(f.bien.prix_plancher, 130)

  // Un plancher d'un euro cinquante ne se perd pas dans l'arrondi.
  const f2 = await L.lireFiche(ficheComplete({ biens: [bienDe({ prix_minimum: 150 })] }),
    { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT })
  assert.equal(f2.bien.prix_plancher, 1.5)

  // Absent reste absent : c'est l'ECRAN qui dit « 10 € (par defaut) », pas le
  // coeur — le plancher global vit dans le code, pas dans la donnee.
  const f3 = await L.lireFiche(ficheComplete({ biens: [bienDe({ prix_minimum: null })] }),
    { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT })
  assert.equal(f3.bien.prix_plancher, null)
})

test('LE TEST QUI COMPTE : `cles_motif` NE FIGURE PLUS dans le contrat de l API', async () => {
  // ⚠ DETTE 80, TRANCHEE PAR THIERRY LE 21 OCTOBRE 2026. Ce champ etait
  // descendu dans la reponse publique et lu par AUCUN ecran. La spec §1 du lot
  // interdit le code dormant, et une donnee que personne ne consomme finit par
  // etre gardee « au cas ou » par la prochaine lecture — puis par la suivante.
  //
  // Le diagnostic qu'il portait n'est pas perdu : il part au JOURNAL serveur,
  // ou le support le lit. Ce qui disparait, c'est sa presence dans ce que
  // l'hote recoit.
  //
  // Ce test garde une ABSENCE, et c'est voulu : le remettre demain se verrait.
  const cas = [
    ['bien ordinaire', ficheComplete()],
    ['cles illisibles', ficheComplete({ enPanne: { provider_keys_migrated: 'timeout' } })],
    ['bien jamais provisionne', base({ biens: [bienDe({ provider_property_id: null })] })]
  ]
  for (const [nom, sb] of cas) {
    // ⚠ LE CACHE DES CLES MIGREES SE VIDE ENTRE DEUX CAS : sans ca, le cas
    // « cles illisibles » retrouve les cles lues par le cas precedent, et
    // mesure un etat qui n'est pas le sien.
    _vider()
    const f = await L.lireFiche(sb, { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT })
    assert.ok(f, nom)
    assert.equal('cles_motif' in f, false, `${nom} : \`cles_motif\` est revenu dans le contrat`)
  }

  // ⚠ ET LA REGLE QU'IL SERVAIT A MESURER TIENT TOUJOURS, par `indisponibles` :
  // c'est ce tableau que l'ecran lit, et lui seul. Retirer un champ ne doit pas
  // retirer la garde.
  _vider()
  const panne = await L.lireFiche(ficheComplete({ enPanne: { provider_keys_migrated: 'timeout' } }),
    { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT })
  for (const bloc of ['menage', 'serrures', 'fait_date']) {
    assert.equal(panne[bloc], null, bloc)
    assert.ok(panne.indisponibles.includes(bloc), bloc)
  }
})

// ════════════════════════════════════════════════════════════════════════
// 12. Ce que la suppression va effacer, en nombres (étape 3)
// ════════════════════════════════════════════════════════════════════════

const lignesDe = (n, cle, extra = {}) => Array.from({ length: n }, (_, i) =>
  ({ id: `x${i}`, user_id: COMPTE, property_id: cle, ...extra }))

test('LE TEST QUI COMPTE : le comptage annonce ce que la purge efface VRAIMENT', async () => {
  // « La confirmation dit ce qui sera effacé, avec les nombres » (Thierry,
  // 21 octobre 2026).
  const sb = base({
    sejours: lignesDe(3, REF, { booking_id: 'b' }),
    messages: lignesDe(7, REF),
    menages: lignesDe(2, REF),
    codes: lignesDe(1, REF)
  })
  const r = await L.compterPourSuppression(sb, { compte: COMPTE, bien: bienDe() })
  assert.deepEqual(r, { cle_absente: false, reservations: 3, messages: 7, menages: 2, codes: 1 })
})

test('LE TEST QUI COMPTE : on compte sur la clé DE LA PURGE, pas sur celle de l affichage', async () => {
  // ⚠ `DELETE /api/channel-property` purge sur `provider_property_id` SEUL.
  // `clesTextDuBien`, qui sert à AFFICHER, fait deux choses de plus : elle ajoute
  // la clé CIBLE d'une migration et elle écarte les clés migrées. Compter avec
  // elle annoncerait des lignes qui resteront, ou tairait celles qui partiront.
  const sb = base({
    sejours: [...lignesDe(2, REF, { booking_id: 'b' }), ...lignesDe(5, REF2, { booking_id: 'c' })],
    messages: lignesDe(4, REF2)
  })
  const r = await L.compterPourSuppression(sb, {
    compte: COMPTE, bien: bienDe({ migration_target_property_id: REF2 })
  })
  assert.equal(r.reservations, 2, 'seules les lignes de la clé que la purge utilise')
  assert.equal(r.messages, 0, 'la clé cible n est pas comptée : elle ne sera pas purgée')
})

test('LE TEST QUI COMPTE : un bien SANS clé partenaire le DIT, il n affiche pas quatre zéros', async () => {
  // La purge entière est sous `if (providerId)` : sans clé, rien de lié n est
  // effacé. Quatre zéros se liraient « on a regardé, il n y a rien ».
  const sb = base({ sejours: lignesDe(9, REF, { booking_id: 'b' }) })
  for (const sans of [null, '', '   ']) {
    const r = await L.compterPourSuppression(sb, {
      compte: COMPTE, bien: bienDe({ provider_property_id: sans })
    })
    assert.equal(r.cle_absente, true, JSON.stringify(sans))
    assert.equal(r.reservations, 0)
  }
})

test('LE TEST QUI COMPTE : une lecture ratée rend `null`, JAMAIS zéro', async () => {
  // La règle de tout le lot, au moment où elle coûte le plus cher : « on n a pas
  // pu lire » affiché comme « il n y en a pas » ferait supprimer un bien en
  // croyant ne rien perdre.
  const sb = base({
    messages: lignesDe(3, REF), menages: lignesDe(1, REF),
    enPanne: { bookings_snapshot: 'timeout' }
  })
  const r = await L.compterPourSuppression(sb, { compte: COMPTE, bien: bienDe() })
  assert.equal(r.reservations, null, 'illisible : `null`, pas 0')
  assert.equal(r.messages, 3, 'et les autres comptes tiennent quand même')
  assert.equal(r.menages, 1)
})

test('le comptage ne lit que des nombres : rien du partenaire n en sort', async () => {
  const sb = base({ sejours: lignesDe(1, REF, { booking_id: 'b' }) })
  const r = await L.compterPourSuppression(sb, { compte: COMPTE, bien: bienDe() })
  const texte = JSON.stringify(r)
  assert.doesNotMatch(texte, new RegExp(REF), 'la clé partenaire ne doit pas sortir')
  for (const v of Object.values(r)) {
    assert.ok(typeof v === 'number' || typeof v === 'boolean' || v === null, texte)
  }
})

test('le comptage NE LIT AUCUNE LIGNE : il demande un compte, pas des données', async () => {
  // ⚠ `head: true` + `count: 'exact'`. Compter en ramenant les lignes
  // retomberait dans le plafond à 1000 de PostgREST — le défaut que la purge
  // elle-même a payé en revue du 7 septembre 2026 : 1000 lignes rendues SANS
  // erreur, et un chiffre faux à partir de la 1001e.
  const sb = base({ sejours: lignesDe(1500, REF, { booking_id: 'b' }) })
  const r = await L.compterPourSuppression(sb, { compte: COMPTE, bien: bienDe() })
  assert.equal(r.reservations, 1500, 'le compte doit être exact au-delà de 1000')
  const vu = sb._vus.find(v => v.table === 'bookings_snapshot')
  assert.equal(vu.compte, true, 'la requête doit demander un `count`')
  assert.equal(vu.head, true, 'et ne ramener AUCUNE ligne')
})

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// 13. Ce que le serveur accepterait de PUBLIER (recette du 22 octobre 2026)
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

test('LE TEST QUI COMPTE : un bien NON CONNECTE ne se publie pas', () => {
  // Le bouton s'affichait sur un bien sans aucun canal, et le serveur rendait
  // 400 « Bien non connecte au canal (ids manquants) » — un message interne,
  // pour un geste que l'ecran n'aurait pas du proposer. L'ecran ne peut pas en
  // juger seul : il ne descend AUCUN identifiant du partenaire, et c'est
  // justement ce qu'il faut regarder.
  const complet = { provider: 'channex', provider_property_id: 'P', provider_rate_plan_id: 'R',
    provider_room_type_id: 'RT', rate_sync_mode: 'managed', pilote_tarifaire: 'calendrier' }
  assert.deepEqual(L.publicationPossible(complet), { possible: true, motif: null })

  // Les trois identifiants sont exiges : le serveur les exige tous les trois.
  for (const manquant of ['provider_property_id', 'provider_rate_plan_id', 'provider_room_type_id']) {
    const r = L.publicationPossible({ ...complet, [manquant]: null })
    assert.equal(r.possible, false, manquant)
    assert.equal(r.motif, 'pas_connecte', manquant)
  }
  // Un bien qui n'est pas du canal non plus.
  assert.equal(L.publicationPossible({ ...complet, provider: 'beds24' }).motif, 'pas_connecte')
})

test('LE TEST QUI COMPTE : les trois refus de publication ne se confondent pas', () => {
  const complet = { provider: 'channex', provider_property_id: 'P', provider_rate_plan_id: 'R',
    provider_room_type_id: 'RT', rate_sync_mode: 'managed', pilote_tarifaire: 'calendrier' }
  // « Je garde mes prix » : le serveur refuse la mise en file (RATE_PUSH_BLOCKED).
  assert.equal(L.publicationPossible({ ...complet, rate_sync_mode: 'keep' }).motif, 'mode_keep')
  // Bien pilote : deux ecrivains de prix sur la meme nuit.
  assert.equal(L.publicationPossible({ ...complet, pilote_tarifaire: 'yieldflow' }).motif, 'pilote')
  // L'ORDRE compte : un bien NON CONNECTE et en keep dit d'abord « pas connecte »,
  // parce que c'est ce que le serveur opposerait en premier (400 avant le 200).
  assert.equal(L.publicationPossible({ ...complet, provider_property_id: null, rate_sync_mode: 'keep' }).motif,
    'pas_connecte')
})

test('LE TEST QUI COMPTE : les colonnes que la regle LIT sont SELECTIONNEES', () => {
  // La lecon payee trois fois dans ce depot, dont une le 22 octobre 2026 en
  // recette : une garde qui juge sur une colonne non selectionnee est une garde
  // ouverte. On confronte les colonnes lues par les regles de ce module a la
  // liste qu'il demande a `properties`.
  // Ce fichier n'importe ni `fs` ni `path` : on les prend ici, au plus pres.
  const fs2 = require('node:fs')
  const src = fs2.readFileSync(path.join(__dirname, '..', 'lib', 'logement', 'lecture.js'), 'utf8')
  const m = src.match(/const COLONNES_BIEN = \[([\s\S]*?)\]\.join/)
  assert.ok(m, 'la liste des colonnes doit \u00eatre lisible')
  const colonnes = new Set([...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]))
  for (const col of ['prix_minimum', 'base_price', 'provider_property_id',
    'provider_rate_plan_id', 'provider_room_type_id', 'rate_sync_mode', 'pilote_tarifaire']) {
    assert.ok(colonnes.has(col), `${col} est lu par une garde et doit \u00eatre s\u00e9lectionn\u00e9`)
  }
})

test('LE TEST QUI COMPTE : la fiche DESCEND la r\u00e9ponse de publication', () => {
  // `publicationPossible` ne sert \u00e0 rien si la r\u00e9ponse ne la porte pas :
  // l'\u00e9cran retomberait sur sa d\u00e9duction locale, celle qui proposait le bouton
  // sur un bien sans canal (recette du 22 octobre 2026).
  const sb = base({ biens: [bienDe({ provider_room_type_id: null })] })
  return L.lireFiche(sb, { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT })
    .then(async (f) => {
      assert.ok(f.publication, 'la r\u00e9ponse doit porter `publication`')
      assert.equal(f.publication.possible, false)
      assert.equal(f.publication.motif, 'pas_connecte',
        'sans `provider_room_type_id`, le serveur refuserait la mise en file')

      // Et un bien complet, lui, est publiable.
      const sb2 = base({ biens: [bienDe({ provider_room_type_id: 'RT', provider_rate_plan_id: 'RP-1',
        rate_sync_mode: 'managed', pilote_tarifaire: 'calendrier' })] })
      const f2 = await L.lireFiche(sb2, { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT })
      assert.deepEqual(f2.publication, { possible: true, motif: null })
    })
})

// ═══════════════════════════════════════════════════════════════════════════
// BOUT EN BOUT : un logement NEUF est supprimable (Thierry, 22 octobre 2026)
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : la fiche d un logement NEUF autorise la suppression', async () => {
  // ⚠ LE CAS REEL : on vient de creer le logement. Il est provisionne chez le
  // partenaire — il a donc `provider_property_id` ET `provider_rate_plan_id` —
  // mais AUCUNE ligne de `canaux_du_bien` ne le porte, puisqu'il n'est en vente
  // nulle part. Le releve du COMPTE, lui, a bien eu lieu.
  //
  // Avant le correctif, la fiche rendait `possible: null` : le bouton Supprimer
  // restait en « on ne sait pas », et la fiche V5 n'a aucun bouton pour lancer
  // un releve. Le logement etait INSUPPRIMABLE depuis l'ecran.
  const f = await L.lireFiche(ficheComplete({ canaux: [] }),
    { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT })
  assert.deepEqual(f.canaux, [], 'aucun canal ne porte ce bien')
  assert.equal(f.suppression.possible, true, 'aucun canal relie est un FAIT, pas une ignorance')
  assert.equal(f.suppression.motif, null)
})

test('LE TEST QUI COMPTE : sans releve de compte, la fiche ne conclut toujours rien', async () => {
  // La contre-epreuve du test ci-dessus : c'est bien le releve du COMPTE qui
  // decide. Sans lui, « on ne sait pas » — et c'est le seul cas qui reste.
  const f = await L.lireFiche(ficheComplete({ canaux: [], horloge: null }),
    { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT })
  assert.equal(f.suppression.possible, null)
  assert.equal(f.suppression.motif, 'jamais_releve')
})

test('LE TEST QUI COMPTE : un releve de compte en ECHEC ne conclut rien non plus', async () => {
  const f = await L.lireFiche(ficheComplete({
    canaux: [],
    horloge: { user_id: COMPTE, vu_le: '2026-10-19T08:00:00Z', ok: false, erreur: 'timeout' }
  }), { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT })
  assert.equal(f.suppression.possible, null)
  assert.equal(f.suppression.motif, 'jamais_releve')
})

test('et un releve SUSPENDU n est pas un echec visible par l hote', async () => {
  // `echecVisibleParLHote` ecarte `suspendu` : un compte sans aucun bien chez
  // ce partenaire n'est plus releve, et son drapeau resterait allume a vie.
  const f = await L.lireFiche(ficheComplete({
    canaux: [],
    horloge: { user_id: COMPTE, vu_le: '2026-10-19T08:00:00Z', ok: false, erreur: 'suspendu' }
  }), { compte: COMPTE, bienId: BIEN, maintenant: MAINTENANT })
  assert.equal(f.suppression.possible, true)
})

test('LE TEST QUI COMPTE : la liste DESCEND le fait de compte jusqu a la carte', async () => {
  // ⚠ SANS CETTE DESCENTE, LA CARTE LIT `undefined`. Et `undefined !== true`
  // la ferait basculer en « non verifies » pour TOUS les logements : le
  // correctif se retournerait en mensonge generalise. C'est pour ca que ce
  // test porte sur l'endpoint, pas sur le rendu.
  const r = await L.lireListe(listeDe(), { compte: COMPTE, maintenant: MAINTENANT })
  for (const b of r.biens) {
    assert.equal(b.canaux_releve_fait, true, `${b.nom} : le releve du compte a bien eu lieu`)
  }
})

test('LE TEST QUI COMPTE : sans releve de compte, la liste le dit — elle n invente pas', async () => {
  const r = await L.lireListe(listeDe({ horloge: null }), { compte: COMPTE, maintenant: MAINTENANT })
  for (const b of r.biens) assert.equal(b.canaux_releve_fait, false)
})

test('un releve de compte en ECHEC ne vaut pas un releve', async () => {
  const r = await L.lireListe(listeDe({
    horloge: { user_id: COMPTE, vu_le: '2026-10-19T08:00:00Z', ok: false, erreur: 'timeout' }
  }), { compte: COMPTE, maintenant: MAINTENANT })
  for (const b of r.biens) assert.equal(b.canaux_releve_fait, false)
})

test('et des canaux ILLISIBLES rendent `null`, jamais `false`', async () => {
  // « On n'a pas pu lire » n'est pas « on n'a jamais releve » : la carte montre
  // deja « non verifies » dans ce cas, et une valeur inventee la contredirait.
  const r = await L.lireListe(listeDe({ enPanne: { canaux_du_bien: 'timeout' } }),
    { compte: COMPTE, maintenant: MAINTENANT })
  for (const b of r.biens) assert.equal(b.canaux_releve_fait, null)
})

// ═══════════════════════════════════════════════════════════════════════════
// SUPPRIMER UN BIEN BEDS24 : LA REGLE DU SERVEUR, ET CE QUE L ECRAN EN DIT
// ═══════════════════════════════════════════════════════════════════════════
// ⚠ LA REGLE DU SERVEUR, LUE DANS `api/channel-property.js` (bloc DELETE) :
//
//   · le refus 409 « encore relie a une annonce » est garde par
//     `(prop.provider === 'channex' || prop.provider === 'channel') && providerId
//     && prop.provider_rate_plan_id`. Un bien Beds24 n'y entre JAMAIS ;
//   · l'appel `DELETE /properties/<id>` au channel manager est garde par la
//     meme condition : rien n'est supprime chez le partenaire ;
//   · la purge des donnees liees, elle, s'applique a tous, sur
//     `provider_property_id`.
//
// Donc, pour un bien Beds24 : le serveur ne refuse jamais a cause des canaux.
// Il efface le logement dans HoteSmart, purge ce qui s'y rattache, et ne touche
// a rien chez Beds24 — l'annonce reste dans le compte de l'hote.

test('LE TEST QUI COMPTE : seul l APPEL AU PARTENAIRE est garde par le provider, plus le refus', () => {
  // ⚠ CE TEST A ETE RETOURNE LE 26 OCTOBRE 2026, ET C'EST LE SENS DU
  // CORRECTIF. Il exigeait DEUX gardes `provider === 'channex'` dans le bloc
  // DELETE — une pour l'appel au partenaire, une pour le refus 409 — et il
  // disait que ces biens « ne passent jamais par le refus 409 ». C'etait vrai,
  // et c'etait le defaut : le refus ne doit pas dependre du provider.
  //
  // Ce qui reste garde par le provider : l'APPEL AU PARTENAIRE. Un bien Beds24
  // n'a pas de propriete chez Channex, donc on ne lui envoie pas de DELETE.
  // Ce qui ne l'est plus : le REFUS. Il applique desormais la regle du coeur a
  // tous les biens, par la meme fonction que l'ecran — parce que la divergence
  // entre les deux etait la cause racine (voir le test de la regle partagee,
  // plus bas).
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'channel-property.js'), 'utf8')
  const i = src.indexOf("if (req.method === 'DELETE')")
  assert.ok(i > 0)
  // ⚠ LE BLOC S'ARRETE AU POST. `src.slice(i)` allait jusqu'a la fin du
  // fichier : l'assertion sur le NOMBRE de gardes par provider contraignait
  // donc aussi la creation, et le jour ou le POST en gagne une, ce test
  // rougirait avec un message parlant du refus 409 — un rouge qui envoie
  // chercher au mauvais endroit.
  const finDuBloc = src.indexOf("if (req.method === 'POST')", i)
  assert.ok(finDuBloc > i, 'le POST ne suit plus le DELETE : la borne du bloc est a revoir')
  const bloc = src.slice(i, finDuBloc)
  const gardes = [...bloc.matchAll(/prop\.provider === 'channex' \|\| prop\.provider === 'channel'/g)]
  assert.equal(gardes.length, 1,
    `${gardes.length} garde(s) par provider dans le DELETE : une seule est attendue, `
    + 'celle de l appel au partenaire. Si le refus 409 en a retrouve une, il est '
    + 'redevenu aveugle aux biens Beds24 en cours de migration.')
  assert.match(bloc, /encore relié à une annonce Airbnb ou Booking/)
  // ⚠ ET LA GARDE RESTANTE EST BIEN CELLE DE L'APPEL, PAS CELLE DU REFUS :
  // elle se tient APRES le refus dans le fichier. Sans ce controle d'ordre, le
  // compte de 1 serait satisfait par l'inverse exact de ce qu'on veut.
  const iRefus = bloc.indexOf('suppressionPossible(prop, canaux,')
  assert.ok(iRefus > 0, 'la regle partagee n est plus appelee dans le DELETE')
  assert.ok(gardes[0].index > iRefus,
    'la garde par provider precede le refus : le refus est redevenu conditionnel au provider')
})

test('LE TEST QUI COMPTE : un bien Beds24 se supprime, quel que soit l etat du releve', () => {
  // Le releve est celui de l'AUTRE partenaire : il ne dit rien de ce bien-la.
  //
  // ⚠ LE BIEN DE TEST PORTE UN PLAN TARIFAIRE, ET C'EST LE CORRECTIF DU
  // 26 OCTOBRE 2026. Il portait `provider_rate_plan_id: null` en plus de
  // `provider: 'beds24'` : les deux suffisaient seuls a rendre `possible: true`,
  // donc le test ne disait pas lequel agissait — et il VERDISSAIT le defaut
  // trouve en review ce jour-la (un bien du CANAL sans plan de base se
  // supprimait sans refus, meme sans aucun releve). Un test qui passe pour deux
  // raisons dont une est un bug ne garde rien.
  const b24 = bienDe({ provider: 'beds24', provider_rate_plan_id: 'PLAN-BEDS24' })
  for (const opts of [
    { releveDuCompte: '2026-10-23T08:00:00Z' },
    { releveDuCompte: null },
    { releveDuCompte: '2026-10-23T08:00:00Z', releveEnEchec: true }
  ]) {
    const r = L.suppressionPossible(b24, [], opts)
    assert.equal(r.possible, true, JSON.stringify(opts))
    assert.equal(r.motif, null)
  }
})

test('LE TEST QUI COMPTE : un bien DU CANAL sans plan tarifaire ne se supprime PAS sans releve', () => {
  // ⚠ LE CAS SYMETRIQUE DU PRECEDENT, ET LE DEFAUT MESURE EN REVIEW LE
  // 26 OCTOBRE 2026. `jamais_releve` vivait SOUS le retour qui exige
  // `provider_rate_plan_id` : un bien channex sans plan de base, sans ligne de
  // canal et sans releve rendait `possible: true`. La seule difference entre un
  // refus et un effacement irreversible etait ce plan — qui ne sert qu'au
  // chemin de verification chez le partenaire.
  //
  // C'est le profil exact du bien de la recette de Thierry du 22 octobre :
  // « un bien sans plan de base », Airbnb en vente, 77 reservations.
  const sansPlan = bienDe({ provider: 'channex', provider_rate_plan_id: null })
  for (const opts of [
    { releveDuCompte: null },
    { releveDuCompte: '2026-10-23T08:00:00Z', releveEnEchec: true }
  ]) {
    assert.deepEqual(L.suppressionPossible(sansPlan, [], opts),
      { possible: null, motif: 'jamais_releve' }, JSON.stringify(opts))
  }
  // ⚠ ET IL SE SUPPRIME DES QUE LE RELEVE A PARLE : le refus porte sur
  // l'ignorance, pas sur le bien. Sans cette moitie, un durcissement qui
  // rendrait le bien insupprimable passerait pour un correctif.
  assert.deepEqual(L.suppressionPossible(sansPlan, [], { releveDuCompte: '2026-10-26T08:00:00Z' }),
    { possible: true, motif: null })
  // ⚠ ET UN BIEN SANS REFERENCE PARTENAIRE RESTE SUPPRIMABLE : il n'a aucune
  // propriete chez le partenaire, donc aucune annonce possible. Le refuser
  // serait un refus sans objet, et il bloquerait un bien dont la creation
  // s'est arretee en route.
  assert.deepEqual(L.suppressionPossible(
    bienDe({ provider: 'channex', provider_property_id: null, provider_rate_plan_id: null }),
    [], { releveDuCompte: null }), { possible: true, motif: null })
})

test('LE TEST QUI COMPTE : L ECRAN ET LE SERVEUR N ONT PLUS QU UNE SEULE REGLE', () => {
  // ⚠ CE TEST FIXAIT UNE DIVERGENCE ASSUMEE ; LA DIVERGENCE EST SUPPRIMEE
  // (decision de Thierry, 26 octobre 2026). Il s'appelait « DEUX CAS OU L ECRAN
  // EST PLUS STRICT QUE LE SERVEUR, et c est ecrit » et il affirmait : « Le
  // serveur ne regarde PAS `canaux_du_bien` pour un bien Beds24 ; l'ecran, si ».
  //
  // Cette divergence n'etait pas un choix, c'etait un defaut, et il a coute une
  // garde serveur MORTE en production : l'ecran a ete durci deux fois (recette
  // du 22 octobre, revue du 23) pendant que le handler gardait sa propre regle,
  // laquelle comparait un plan tarifaire de BASE que plus aucun mapping ne
  // porte. L'ecran refusait, le serveur supprimait.
  //
  // ⚠ ET LE COMPTE « DEUX » ETAIT DEJA FAUX : une troisieme divergence existait
  // (`mapping_inconnu`, hissee par la revue du 23 octobre) sans que ce test la
  // nomme — « une exemption se COMPTE, elle ne se decrit pas ». Un inventaire
  // qui sous-compte est pire qu'absent : il rassure.
  //
  // On ne compte donc plus des divergences, on verifie qu'il n'y en a aucune :
  // les deux cotes appellent `suppressionPossible`, sur les memes entrees.
  const b24 = bienDe({ provider: 'beds24', provider_rate_plan_id: null })
  const CAS = [
    [null, { possible: null, motif: 'canaux_illisibles' }],
    [[{ ota: 'airbnb', mappe: true }], { possible: false, motif: 'annonce_reliee' }],
    [[{ ota: 'airbnb', mappe: null }], { possible: null, motif: 'mapping_inconnu' }]
  ]
  for (const [canaux, attendu] of CAS) {
    assert.deepEqual(L.suppressionPossible(b24, canaux, { releveDuCompte: 'x' }), attendu,
      `canaux = ${JSON.stringify(canaux)}`)
  }
  // ⚠ ET C'EST LA MEME FONCTION QUI TRANCHE COTE SERVEUR. Sans ce controle, les
  // trois cas ci-dessus ne prouveraient que le comportement de l'ECRAN — ce que
  // l'ancienne version de ce test faisait, pendant que le serveur en faisait
  // un autre. `tests/suppression-bien-garde-serveur.test.js` mesure le refus en
  // APPELANT le handler ; ici on verifie seulement qu'il n'existe pas de
  // seconde copie de la regle.
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'channel-property.js'), 'utf8')
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.match(code, /require\('\.\.\/lib\/logement\/lecture'\)/,
    'le handler ne tire plus la regle partagee : une copie a ete reintroduite')
  assert.ok(!/stillMapped/.test(code),
    'le match sur le plan tarifaire de BASE est revenu dans le handler : il n aboutit jamais')
})
