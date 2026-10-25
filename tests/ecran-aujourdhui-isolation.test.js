// tests/ecran-aujourdhui-isolation.test.js
//
// L'ISOLATION ENTRE COMPTES DE `/api/ecran/aujourdhui` — lot (b) du chantier
// performance. DOC : docs/specs/spec-performance-pages.md
//
// ⚠ POURQUOI UN FICHIER ENTIER POUR UN SEUL ENDPOINT. Celui-ci regroupe DIX
// lectures qui etaient dans cinq endpoints distincts, chacun avec sa garde.
// Les dix fuites du chantier profils et droits sont toutes nees de cette
// famille : une lecture qui oublie son perimetre, dans un fichier ou les neuf
// autres l'appliquent. Un oubli y est invisible a la lecture — le bloc
// ressemble a ses voisins — et invisible a l'ecran : l'hote ne voit pas qu'un
// compteur porte les biens d'un autre.
//
// ⚠ ET LA CLE DE SERVICE CONTOURNE LA RLS. C'est le fait qui rend ce fichier
// necessaire : en base, `properties` et ses enfants sont proteges par 28
// policies, mais cet endpoint lit avec `SUPABASE_SERVICE_KEY`, donc AUCUNE ne
// s'applique. Le seul cloisonnement est celui qu'on ecrit ici, en JavaScript.
//
// Ce que ce fichier eprouve, et dans cet ordre :
//   1. le titulaire : aucun filtre de perimetre, et le compte est celui de la
//      garde — jamais celui que la requete demande ;
//   2. le membre restreint : TOUTE lecture bornee, aucune exception ;
//   3. le perimetre VIDE (`[]`) : un ecran vide, jamais l'ecran complet ;
//   4. un droit refuse : la table n'est pas meme interrogee ;
//   5. la reponse : zero reference hors perimetre, passee au tamis.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')

// ⚠ LE JOUR DE PARIS, PAS LE JOUR UTC — ET C'EST UN ROUGE MESURE, PAS UNE
// PRECAUTION. Les fixtures de ce fichier posaient leur arrivee a
// `new Date().toISOString().slice(0, 10)`, c'est-a-dire le jour UTC, alors que
// l'endpoint borne sa fenetre sur `jourParis(0)` / `jourParis(1)`. Les deux
// coincident la journee et DIVERGENT chaque nuit entre 22 h UTC et minuit (23 h
// en heure d'hiver) : l'arrivee tombe hors fenetre, la preuve de transmission
// n'est plus lue, et trois tests rougissent.
//
// Mesure du 23 octobre 2026 a 22 h 45 UTC (Paris +2, heure d'ete) : jour UTC
// 2026-10-23, jour Paris 2026-10-24 — `ℹ fail 3`. Le MEME arbre, au MEME blob,
// rendait `fail 0` a 14 h 50 UTC le meme jour. Ce n'est donc pas une regression :
// c'est une fenetre d'HEURES.
//
// ⚠ ET L'OUTIL DE CONTRE-EPREUVE DU DEPOT NE PEUT PAS LE VOIR.
// `tests/outils/horloge-decalee.js` decale des JOURS : la fixture et le code
// glissent ensemble, donc `JOURS=-1`, `0` et `1` rendent tous les trois le meme
// rouge. Une bascule de FUSEAU lui est invisible par construction. La regle du
// depot — « dates relatives si le test lit l'horloge » — a donc une seconde
// moitie : **et dans le meme fuseau que le code mesure**.
//
// ⚠ PAS UNE QUATRIEME COPIE DE LA REGLE. Trois copies de `jourParis` existent
// deja (api/ecran/aujourdhui.js, api/messages.js, shared/aujourdhui.js) et un
// test de ce fichier les tient d'accord ; en ajouter une ici serait exactement
// ce que ce test surveille. On charge la copie PARTAGEE, la seule importable
// depuis un test, et c'est elle qui repond.
const SHARED_AUJOURDHUI = (() => {
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'shared/aujourdhui.js'), 'utf8')
  const mod = { exports: {} }
  new Function('module', src.replace(/^export (function|const)/gm, '$1')
    + '\n;module.exports = { jourParis, ajouterJours }')(mod)
  return mod.exports
})()
const jourDeParis = (decalage = 0) => SHARED_AUJOURDHUI.jourParis(Date.now(), decalage)

const TITULAIRE = '85e3a0ef-75bd-4c11-a3b7-e2811067dc36'
const MEMBRE    = '18920ead-f936-4e26-b62e-9a5f52b5e657'
// La bulle : le bien du membre restreint, sous ses DEUX formes de cle.
// ⚠ LA REF EST NUMERIQUE EXPRES — C'EST LA FORME BEDS24, et c'est elle qui
// fait tomber une borne posee sur une colonne `uuid`. Les cinq biens de
// production sont Channex aujourd'hui, donc leur cle provider est elle-meme un
// UUID et le defaut y est inerte : un banc qui ne prendrait que des UUID ne
// verrait jamais rien. Le dual-provider Beds24 est PERMANENT (CLAUDE.md).
const BULLE_UUID = '091d9abf-ff86-45ce-8123-3425e6f3900f'
const BULLE_REF  = '209413'
// Et le bien d'a cote, celui qu'il ne doit jamais voir, sous ses deux formes.
const AUTRE_UUID = 'cccccccc-1111-4222-8333-444444444444'
const AUTRE_REF  = '11111'

const TOUS_DOMAINES = ['reservations', 'menages', 'messages', 'avis', 'reglages']

// ⚠ ET LE BANC CONNAIT LE TYPE DES COLONNES, PARCE QUE SON ABSENCE A LAISSE
// PASSER UN DEFAUT BLOQUANT. Ma premiere version implementait `.in` par une
// comparaison de CHAINES, sans typage : elle ne pouvait donc pas voir qu'une
// colonne `uuid` ne compare pas une valeur mal formee — elle la REFUSE, et
// fait echouer la requete ENTIERE en `22P02`. Le code poussait l'union des
// deux formes de cle du perimetre dans `.in('id', …)` sur `properties.id`, et
// ce fichier ASSERTAIT ce comportement comme un contrat (`deepEqual(valeurs,
// refs.map(String))`) : le test figeait le bug. La review l'a mesure contre la
// production, et le banc le reproduit maintenant.
//
// Colonnes `uuid` mesurees le 23 octobre 2026 (`.in(col, ['209413'])` rend
// 22P02) ; toutes les autres colonnes de bien de ces tables sont `text`.
const COLONNES_UUID = new Set(['properties.id', 'price_display_log.property_id'])
const EST_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

// ⚠ LE BANC APPLIQUE LES FILTRES, ET C'EST LE POINT DE TOUT CE FICHIER.
// Un double qui rend ses lignes sans regarder les filtres ne peut prouver
// qu'une chose : que le filtre a ete ECRIT. Il ne dit pas qu'il est EFFECTIF —
// une borne sur la mauvaise colonne, une valeur en UUID la ou la colonne est en
// TEXT, un `.in` sur une liste vide traitee comme « tous » : tout cela passe
// une lecture de code et passe un test de presence. Ici la base fausse se
// comporte comme la vraie, donc une borne absente ou fausse se lit dans la
// REPONSE, la ou l'hote la verrait.
// Le `user_id` manquant d'une ligne de fixture vaut celui du titulaire : les
// fixtures decrivent le contenu du compte, et c'est le cas courant.
const valeur = (ligne, colonne) => {
  const m = String(colonne).match(/^([a-z_]+)->>([a-z_]+)$/)
  if (m) return (ligne[m[1]] || {})[m[2]]
  return ligne[colonne]
}
function tient (ligne, f) {
  const [op, colonne] = f
  const v = valeur(ligne, colonne)
  if (op === 'eq')  return String(v) === f[2]
  if (op === 'neq') return String(v) !== f[2]
  if (op === 'in')  return f[2].includes(String(v))
  if (op === 'is')  return f[2] === null ? (v === null || v === undefined) : v === f[2]
  if (op === 'not') return f[2] === 'is' && f[3] === null ? (v !== null && v !== undefined) : true
  if (op === 'gt')  return String(v) > f[2]
  if (op === 'gte') return String(v) >= f[2]
  if (op === 'lte') return String(v) <= f[2]
  return true
}

// ─── Le banc ──────────────────────────────────────────────────────────────────
//
// Il remplace TROIS choses, et pas une de plus :
//   · `createClient` du SDK, pour enregistrer chaque requete et ses filtres ;
//   · `contexteDEcran`, la garde — ce fichier ne teste pas la garde (c'est
//     `tests/contexte-ecran.test.js` qui le fait), il teste ce que l'endpoint
//     fait du contexte qu'elle rend ;
//   · `notesDuPerimetre` et `etatMenage`, deux lectures d'autres modules, pour
//     observer les REFS qu'elles recoivent.
//
// ⚠ ET LE BANC NE DOUBLE PAS `lib/ecran/etat-du-code`. C'est lui qui lit
// `access_codes`, la table dont les lignes sont souvent SANS compte (bloquant
// (d) de CLAUDE.md : 50 des 65 codes de La bulle n'ont pas de `user_id`) : son
// cloisonnement passe donc par le couple `property_id` + `booking_id`, et c'est
// precisement ce qu'on veut voir partir en requete.
function banc ({ refs = null, domaines = TOUS_DOMAINES, titulaire = false,
                 methode = 'GET', lignes = {}, pannes = [], erreurs = {},
                 instant = null, pages = null, notesLevent = false } = {}) {
  const requetes = []
  const notesVues = []
  const client = {
    from (table) {
      const r = { table, filtres: [], select: null, options: null }
      requetes.push(r)
      const q = {
        select (cols, opts) { r.select = cols; r.options = opts || null; return q },
        eq (c, v)  { r.filtres.push(['eq', c, String(v)]); return q },
        neq (c, v) { r.filtres.push(['neq', c, String(v)]); return q },
        in (c, v)  { r.filtres.push(['in', c, (v || []).map(String)]); return q },
        is (c, v)  { r.filtres.push(['is', c, v]); return q },
        // ⚠ `or` MANQUAIT, ET SON ABSENCE NE SE LISAIT PAS COMME UNE ABSENCE.
        // Un double qui ignore une methode ne rend pas `undefined` : il LEVE,
        // et l'exception remonte au bloc appelant, qui la nomme « indisponible ».
        // Mesure du 24 octobre 2026 : la lecture des derniers avis s'arretait
        // sur ce TypeError AVANT son `.in(...)`, et ce test a conclu « ota_reviews
        // part SANS borne de bien » — un diagnostic juste sur une cause fausse.
        // Il est enregistre comme les autres : une condition de texte n'est pas
        // une borne de perimetre, mais une lecture qui la perdrait changerait de
        // population sans que rien ne rougisse.
        or (expr)  { r.filtres.push(['or', expr]); return q },
        not (c, o, v) { r.filtres.push(['not', c, o, v]); return q },
        gt (c, v)  { r.filtres.push(['gt', c, String(v)]); return q },
        gte (c, v) { r.filtres.push(['gte', c, String(v)]); return q },
        lte (c, v) { r.filtres.push(['lte', c, String(v)]); return q },
        // ⚠ L'ORDRE EST ENREGISTRE, ET IL NE L'ETAIT PAS. `order () { return q }`
        // n'ecrivait rien : la contre-epreuve a montre qu'on pouvait retirer
        // `.order('id')` de la pagination ET retourner la preuve de
        // transmission de DESC en ASC sans faire rougir un seul test. Le
        // second est le pire : avec plus de 1000 messages sortants sur les
        // reservations proches, ASC garde les PLUS ANCIENS, donc le message
        // qui porte le code n'est jamais lu et « transmis » devient « cree » —
        // l'hote renvoie un code deja envoye.
        order (colonne, opts) { (r.ordres = r.ordres || []).push([colonne, !!(opts && opts.ascending)]); return q },
        range (a, b) { r.plage = [a, b]; return q },
        limit (n) { r.limite = n; return q },
        then (ok, ko) {
          // La colonne typee `uuid` REFUSE, elle ne compare pas.
          for (const f of r.filtres) {
            const col = `${table}.${f[1]}`
            if (!COLONNES_UUID.has(col)) continue
            const vals = f[0] === 'in' ? f[2] : [f[2]]
            const mauvaise = vals.find(v => v != null && !EST_UUID.test(String(v)))
            if (mauvaise !== undefined) {
              return Promise.resolve({ data: null, count: null, error: {
                code: '22P02',
                message: `invalid input syntax for type uuid: "${mauvaise}"`
              } }).then(ok, ko)
            }
          }
          if (erreurs[table]) {
            return Promise.resolve({ data: null, count: null, error: erreurs[table] }).then(ok, ko)
          }
          if (pannes.includes(table)) {
            return Promise.resolve({ data: null, count: null, error: { message: `panne ${table}` } })
              .then(ok, ko)
          }
          // Une base qui rend des PAGES PLEINES : de quoi eprouver la
          // pagination sans fabriquer mille lignes a la main.
          // ⚠ LES PAGES SE SERVENT PAR CURSEUR, comme le code les demande
          // maintenant : une lecture paginee est celle qui ordonne par `id` et
          // porte une `limit`, et sa page suivante se reconnait a son
          // `.gt('id', <dernier>)`. Un banc qui servirait encore des decalages
          // laisserait passer un retour a `.range`.
          const estPaginee = pages && pages[table] && r.limite === 1000
            && (r.ordres || []).some(o => o[0] === 'id')
          if (estPaginee) {
            const curseur = (r.filtres.find(f => f[0] === 'gt' && f[1] === 'id') || [])[2]
            const page = curseur ? Number(String(curseur).split('-')[0]) + 1 : 0
            const plein = page < pages[table]
            const lot = Array.from({ length: plein ? 1000 : 3 },
              (_, i) => ({ id: `${page}-${String(i).padStart(4, '0')}`,
                           booking_id: `B${page}-${i}`,
                           property_id: String(BULLE_REF), user_id: TITULAIRE }))
            return Promise.resolve({ data: lot, count: lot.length, error: null }).then(ok, ko)
          }
          const gardees = (lignes[table] || [])
            .map(l => (l.user_id === undefined ? { ...l, user_id: TITULAIRE } : l))
            .filter(l => r.filtres.every(f => tient(l, f)))
          return Promise.resolve({ data: gardees, count: gardees.length, error: null })
            .then(ok, ko)
        }
      }
      return q
    }
  }

  const absSdk = require.resolve('@supabase/supabase-js')
  require('@supabase/supabase-js')
  const vraiCreate = require.cache[absSdk].exports.createClient
  require.cache[absSdk].exports.createClient = () => client

  // ⚠ LA GARDE EST DOUBLEE EN ENTIER, SINON LE CONTEXTE SERAIT CELUI DU VRAI
  // MODULE. Et elle rend la MEME forme que la vraie : `{ ok, accountUserId,
  // contexte }` — verifiee contre `lib/require-permission.js`.
  // ⚠ ON CHARGE AVANT DE CAPTURER, ET J'AVAIS FAIT L'INVERSE. Je lisais
  // `require.cache[...]` AVANT le `require`, donc au premier appel le cache
  // etait vide, `vraieGarde` valait `null`, et le double ne portait QUE
  // `contexteDEcran` : `UUID_RE` — que l'endpoint importe du meme module —
  // devenait `undefined`, et chaque bloc levait `Cannot read properties of
  // undefined (reading 'test')`. Un double PARTIEL qui perd un export est le
  // piege que CLAUDE.md decrit, et je venais de le reproduire dans le banc
  // cense prouver l'isolation.
  const absGarde = require.resolve('../lib/require-permission')
  require('../lib/require-permission')
  const vraieGarde = require.cache[absGarde].exports
  const permissions = refs === null && !titulaire
    ? { property_scope: 'all', property_ids: [], property_refs: [] }
    : { property_scope: 'selected',
        property_ids: (refs || []).filter(x => x.includes('-')),
        property_refs: (refs || []).filter(x => !x.includes('-')) }
  for (const d of TOUS_DOMAINES) permissions[d] = domaines.includes(d) ? 'read' : 'none'
  const contexte = titulaire
    ? { userId: TITULAIRE, accountUserId: TITULAIRE, profil: null, permissions: null }
    : { userId: MEMBRE,
        accountUserId: TITULAIRE,
        profil: { active: true, accepted_at: '2026-01-01', member_user_id: MEMBRE,
                  account_user_id: TITULAIRE },
        permissions }
  require.cache[absGarde].exports = Object.assign({}, vraieGarde, {
    contexteDEcran: async () => ({
      ok: true, userId: contexte.userId, accountUserId: TITULAIRE, contexte
    })
  })

  const absNotes = require.resolve('../lib/stats-avis')
  require('../lib/stats-avis')
  const vraiNotes = require.cache[absNotes].exports
  require.cache[absNotes].exports = Object.assign({}, vraiNotes, {
    notesDuPerimetre: async (sb, opts) => {
      notesVues.push(opts)
      // ⚠ IL LEVE PAR CONCEPTION (`lib/stats-avis.js` : « `<option>` n'est pas
      // honore »), et c'est l'option qui eprouve l'enveloppe des blocs.
      if (notesLevent) throw new TypeError('q.in is not a function')
      return { global: { note_sur_5: 4.7, notes: 42 }, par_bien: {}, periode: '30j' }
    }
  })

  const absMenage = require.resolve('../lib/cron-arrival-code')
  require('../lib/cron-arrival-code')
  const vraiMenage = require.cache[absMenage].exports
  require.cache[absMenage].exports = Object.assign({}, vraiMenage,
    { etatMenage: async () => 'fait' })

  delete require.cache[require.resolve('../api/ecran/aujourdhui')]
  const handler = require('../api/ecran/aujourdhui')

  const res = { codes: [], corps: null, entetes: {},
    setHeader (k, v) { this.entetes[String(k).toLowerCase()] = v },
    status (c) { this.codes.push(c); return this },
    json (o) { this.corps = o; return this } }

  // ⚠ L'HORLOGE EST FIGEE PAR UNE SOUS-CLASSE DE `Date`, pas par `Date.now`
  // seul : `jourParis` lit `new Date()`, et stubber l'un sans l'autre fabrique
  // des echecs qui n'ont rien a voir (lecon de `tests/outils/horloge-decalee.js`).
  const VraiDate = Date
  const figer = () => {
    if (!instant) return
    const t = new VraiDate(instant).getTime()
    class DateFigee extends VraiDate {
      constructor (...a) { super(...(a.length ? a : [t])) }
      static now () { return t }
    }
    globalThis.Date = DateFigee
  }

  const rendre = async () => {
    figer()
    try {
      await handler({ method: methode, headers: {}, query: {} }, res)
    } finally {
      globalThis.Date = VraiDate
      require.cache[absSdk].exports.createClient = vraiCreate
      if (vraieGarde) require.cache[absGarde].exports = vraieGarde
      require.cache[absNotes].exports = vraiNotes
      require.cache[absMenage].exports = vraiMenage
      delete require.cache[require.resolve('../api/ecran/aujourdhui')]
    }
    return { res, requetes, notesVues, corps: res.corps }
  }
  return rendre
}

// Les filtres `.in` qui bornent un bien, par requete.
const bornes = (r) => r.filtres.filter(f => f[0] === 'in'
  && ['id', 'property_id', 'property_id_ref'].includes(f[1]))

// Ce que la borne d'une colonne DOIT contenir : les UUID seuls sur une colonne
// `uuid`, les deux formes sur une colonne `text`.
const borneAttendue = (table, colonne, refs) =>
  (COLONNES_UUID.has(`${table}.${colonne}`)
    ? refs.map(String).filter(r => EST_UUID.test(r))
    : refs.map(String))

// ─── 1. LE TITULAIRE ──────────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : le compte lu est celui de la GARDE, jamais celui de la requete', async () => {
  // Une fuite d'une ligne : `req.query.compte` au lieu de `garde.accountUserId`.
  // C'est la forme exacte de plusieurs des dix fuites du chantier droits.
  const { requetes } = await banc({ titulaire: true })()
  const sansCompte = requetes.filter(r =>
    r.table !== 'access_codes' && !r.filtres.some(f => f[0] === 'eq' && f[1] === 'user_id'))
  assert.deepEqual(sansCompte.map(r => r.table), [],
    'une lecture part SANS `user_id` : avec la cle de service, elle lit toute la base')
  const mauvais = requetes.filter(r =>
    r.filtres.some(f => f[0] === 'eq' && f[1] === 'user_id' && f[2] !== TITULAIRE))
  assert.deepEqual(mauvais.map(r => r.table), [], 'une lecture porte un autre compte')
})

test("LE TEST QUI COMPTE : le nom du voyageur exige `reservations`, et la colonne n'est pas meme demandee", async () => {
  // ⚠ LA REGLE EST CELLE DE `api/avis.js`, DEJA TRANCHEE POUR LES DATES DE
  // SEJOUR : « le CONTENU de l'avis reste sous `avis` ; le SEJOUR qu'il designe
  // suit `reservations` ». Un nom de voyageur dit QUI occupait le logement.
  // ⚠ ET LA COLONNE N'EST PAS SELECTIONNEE : une donnee qu'on ne demande pas a
  // la base ne peut pas fuiter plus tard par un oubli d'affichage. C'est le
  // CABLAGE de cette garde qu'on mesure ici — la revue du 25 octobre 2026 a
  // montre que forcer `avecNom: true` dans l'endpoint laissait les 6284 tests
  // au vert, alors que c'est le seul point ou la garde est posee.
  // ⚠ `statut` ET `is_hidden` SONT DANS LA FIXTURE, et ce n'est pas du
  // remplissage : `avisQuiComptent` les pose en `eq`, et le double compare par
  // egalite stricte — une ligne qui ne les porte pas est ECARTEE, donc le test
  // passerait sur une liste vide sans rien mesurer.
  const lignes = { ota_reviews: [{ id: 'r1', property_id_ref: BULLE_REF, ota: 'airbnb',
    statut: 'confirme', is_hidden: false,
    content_public: 'Sejour parfait', overall_score: 9.6, received_at: jourDeParis() + 'T10:00:00Z',
    guest_name: 'Claire Bernard' }] }

  const sans = await banc({ refs: [BULLE_UUID, BULLE_REF], lignes,
    domaines: TOUS_DOMAINES.filter(d => d !== 'reservations') })()
  const qSans = sans.requetes.find(r => r.table === 'ota_reviews')
  assert.ok(qSans, 'les avis ne sont pas lus')
  // ⚠ UN TEST QUI MESURE UNE LISTE VIDE NE MESURE RIEN : si la fixture ne
  // traverse pas le double, toutes les assertions qui suivent passent pour de
  // mauvaises raisons.
  assert.strictEqual((sans.corps.derniers_avis || []).length, 1,
    'la fixture ne traverse pas le double : le reste du test ne prouve rien')
  assert.ok(!/guest_name/.test(qSans.select || ''),
    'la colonne `guest_name` est demandee sans le droit `reservations`')
  assert.strictEqual((sans.corps.derniers_avis[0] || {}).voyageur, null,
    'le nom du voyageur descend sans le droit `reservations`')
  assert.ok(!JSON.stringify(sans.corps).includes('Bernard'),
    'le nom COMPLET traverse la reponse')

  const avec = await banc({ refs: [BULLE_UUID, BULLE_REF], lignes })()
  const qAvec = avec.requetes.find(r => r.table === 'ota_reviews')
  assert.match(qAvec.select || '', /guest_name/)
  assert.strictEqual(avec.corps.derniers_avis[0].voyageur, 'Claire B.',
    'le serveur doit descendre « Claire B. », jamais le nom complet')
  assert.ok(!JSON.stringify(avec.corps).includes('Bernard'),
    'le nom COMPLET traverse la reponse meme avec le droit')
})

test("LE TEST QUI COMPTE : une lecture d'avis EN ECHEC rend `null`, jamais une liste vide", async () => {
  // ⚠ CONSTAT DE LA REVUE DU 25 OCTOBRE 2026 : le contrat de la VUE etait
  // garde (elle distingue `null` de `[]`), celui de l'ENDPOINT ne l'etait pas.
  // Remplacer `return null` par `return []` passait les 6284 tests, et l'hote
  // lisait « Pas encore d'avis sur 30 jours » la ou la lecture avait plante —
  // la phrase que le module cite lui-meme comme le defaut a eviter.
  // ⚠ Et `indisponibles` n'est PAS lu par la page : `derniers_avis: null` est
  // le seul signal qui lui reste.
  const { corps } = await banc({ titulaire: true, pannes: ['ota_reviews'] })()
  assert.strictEqual(corps.derniers_avis, null,
    'une panne de lecture est rendue comme « aucun avis »')
  assert.ok(corps.indisponibles.includes('derniers_avis'),
    'la panne n est pas annoncee')
})

test('LE TEST QUI COMPTE : sur un compte DELEGUE aussi, le compte lu est celui de la garde', async () => {
  // ⚠ CE TEST MANQUAIT, ET SON ABSENCE RENDAIT LE PRECEDENT AVEUGLE (constat
  // GRAVE de la revue de l'etape 2, 25 octobre 2026). Celui du dessus tourne
  // avec `titulaire: true` : l'appelant EST le compte lu, donc
  // `contexte.userId` et le compte consulte valent la meme chose, et toute
  // confusion des deux reste invisible. Mesure de la revue : remplacer
  // `userId: compte` par `userId: contexte.userId` dans la lecture des avis
  // laissait les 6284 tests au vert, et la requete partait avec le `user_id`
  // du MEMBRE — donc la reponse portait les avis d'un autre compte.
  //
  // Ici les deux valeurs different par construction, et l'assertion porte sur
  // TOUTES les tables : le bloc ajoute demain est couvert sans qu'on pense a
  // le nommer.
  const { requetes } = await banc({ refs: [BULLE_UUID, BULLE_REF] })()
  const sansCompte = requetes.filter(r =>
    r.table !== 'access_codes' && !r.filtres.some(f => f[0] === 'eq' && f[1] === 'user_id'))
  assert.deepEqual(sansCompte.map(r => r.table), [],
    'une lecture part SANS `user_id` : avec la cle de service, elle lit toute la base')
  const mauvais = requetes.filter(r =>
    r.filtres.some(f => f[0] === 'eq' && f[1] === 'user_id' && f[2] !== TITULAIRE))
  assert.deepEqual(mauvais.map(r => r.table), [],
    'une lecture porte le compte de l APPELANT au lieu du compte CONSULTE')
})

test('le titulaire n est borne par aucun perimetre, et les notes le savent', async () => {
  const { requetes, notesVues } = await banc({ titulaire: true })()
  for (const r of requetes) {
    assert.deepEqual(bornes(r), [],
      `${r.table} est borne alors que le titulaire voit tout son compte`)
  }
  assert.strictEqual(notesVues.length, 1)
  assert.strictEqual(notesVues[0].refs, null, 'les notes du titulaire sont bornees a tort')
})

// ─── 2. LE MEMBRE RESTREINT ───────────────────────────────────────────────────

test('LE TEST QUI COMPTE : CHAQUE lecture du membre restreint est bornee a ses biens', async () => {
  // ⚠ L'ASSERTION EST « TOUTES », PAS « CELLES QUE J'AI PENSE A CITER ».
  // Une liste nominative de tables vieillit mal : le bloc ajoute demain n'y
  // serait pas, et le test resterait vert en laissant fuiter la nouvelle
  // lecture. On exige donc que toute requete sur une table a bien porte sa
  // borne, et on ne nomme que les EXCEPTIONS, avec leur raison.
  const refs = [BULLE_UUID, BULLE_REF]
  const { requetes, notesVues } = await banc({ refs })()
  // ⚠ ET LES NOTES AUSSI, QUI PARTENT PAR UN AUTRE MODULE. `notesDuPerimetre`
  // porte sa propre requete : la borne ne passe pas par `bornerRef`, elle
  // passe par son argument `refs`. Un `refs: null` ici donnerait au membre la
  // note moyenne de TOUS les biens du compte — un chiffre, pas une liste, donc
  // rien a l'ecran ne trahirait la fuite.
  assert.strictEqual(notesVues.length, 1, 'les notes ne sont pas lues')
  assert.deepEqual(notesVues[0].refs, refs.map(String),
    'les notes du membre ne sont pas bornees a ses biens')
  assert.strictEqual(notesVues[0].userId, TITULAIRE, 'les notes sont lues sur un autre compte')
  // `access_codes` est borne par le couple bien + reservation, pas par le
  // perimetre : ses reservations viennent deja d'une lecture bornee.
  const aExaminer = requetes.filter(r => r.table !== 'access_codes')
  assert.ok(aExaminer.length >= 8, `seulement ${aExaminer.length} lectures observees`)
  for (const r of aExaminer) {
    const b = bornes(r)
    assert.ok(b.length >= 1,
      `${r.table} part SANS borne de bien : le membre y verrait tout le compte`)
    for (const [, colonne, valeurs] of b) {
      // ⚠ LA FORME ATTENDUE DEPEND DE LA COLONNE, et l'exiger identique
      // partout etait la version qui figeait le bug : sur `properties.id`, une
      // ref provider numerique ne restreint pas la requete, elle la DETRUIT.
      assert.deepEqual(valeurs, borneAttendue(r.table, colonne, refs),
        `${r.table}.${colonne} est bornee sur une autre liste que le perimetre du membre`)
    }
  }
})

test('les messages des arrivees proches sont bornes aux reservations en main', async () => {
  // Ce bloc ne porte pas de `property_id` : il est borne par `booking_id`, et
  // ces identifiants viennent de `bookings_snapshot`, deja borne. La garantie
  // est donc qu'il ne part JAMAIS sans l'une des deux bornes.
  const refs = [BULLE_UUID, BULLE_REF]
  const { requetes } = await banc({ refs, lignes: {
    bookings_snapshot: [{ booking_id: 'B1', property_id: BULLE_REF,
      snapshot: { arrival: jourDeParis(), status: 'confirmed' } }]
  } })()
  const msgs = requetes.filter(r => r.table === 'messages')
  assert.ok(msgs.length >= 1, 'aucune lecture de messages')
  for (const r of msgs) {
    assert.ok(bornes(r).length,
      'une lecture de messages part sans borne de BIEN : le membre y verrait tout le compte')
  }
  // ⚠ LA PREUVE DE TRANSMISSION EXIGE LES DEUX BORNES, ET MA PREMIERE VERSION
  // ACCEPTAIT L'UNE OU L'AUTRE (`parBien.length || parResa.length`) : retirer
  // la borne de bien de cette lecture ne faisait donc rougir personne — la
  // contre-epreuve par mutation l'a montre, et c'etait exactement le constat
  // de la review.
  // Un identifiant de reservation Beds24 est numerique et n'est unique QUE par
  // bien : reutilise sur un autre logement du meme compte, il melangeait les
  // messages sortants de cet autre logement dans le sac de celui-ci. Si l'un
  // d'eux contenait les chiffres du code bornes par des non-chiffres (un prix,
  // un autre code de porte), `verdictDuCode` rendait « transmis » pour une
  // arrivee dont le code n'a jamais ete envoye : l'hote ne fait pas l'envoi
  // manuel, et le voyageur arrive devant une porte fermee.
  const preuve = msgs.filter(r => r.filtres.some(f => f[0] === 'in' && f[1] === 'booking_id'))
  assert.strictEqual(preuve.length, 1, 'la preuve de transmission ne se lit plus')
  assert.ok(bornes(preuve[0]).length,
    'la preuve de transmission part sans borne de BIEN')
  assert.ok(preuve[0].filtres.some(f => f[0] === 'eq' && f[1] === 'direction' && f[2] === 'outbound'),
    'la preuve de transmission ne se limite plus aux messages SORTANTS')
  const codes = requetes.filter(r => r.table === 'access_codes')
  assert.ok(codes.length >= 1, 'les codes ne sont plus lus')
  for (const r of codes) {
    assert.ok(r.filtres.some(f => f[0] === 'in' && f[1] === 'booking_id'),
      'les codes partent sans borne de reservation')
    // ⚠ ET LE BIEN AUSSI, AJOUTE AU LOT (b). Les identifiants Beds24 sont
    // numeriques et sans unicite globale, et cette table n'a pas de `user_id`
    // renseigne : sans le bien, la ligne d'un autre compte portant le meme
    // numero traversait le reseau avant d'etre ecartee en memoire.
    assert.ok(r.filtres.some(f => f[0] === 'in' && f[1] === 'property_id'),
      'les codes partent sans borne de BIEN : un identifiant partage fuiterait')
  }
})

// ─── 3. LE PERIMETRE VIDE ─────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : un perimetre VIDE rend un ecran vide, jamais l ecran complet', async () => {
  // ⚠ C'EST LE PIEGE QUI A COUTE LE PLUS CHER A CE DEPOT. `[]` n'est pas
  // `null` : le premier veut dire « aucun bien », le second « tous ». Un
  // `if (refs) borner()` laisse le perimetre vide SANS filtre — donc tout le
  // compte visible, au membre qui a le moins de droits.
  const { requetes, corps } = await banc({ refs: [] })()
  assert.strictEqual(corps.perimetre_vide, true, 'l ecran ne dit pas que le perimetre est vide')
  const tables = requetes.map(r => r.table)
  assert.deepEqual(tables, [],
    'un perimetre vide interroge quand meme la base : ' + tables.join(', '))
  assert.deepEqual(corps.biens, [])
  assert.deepEqual(corps.taches, [])
  assert.deepEqual(corps.alarmes, [])
  // ⚠ `arrivees` NE PART PLUS DANS LA REPONSE : elle emportait le snapshot
  // INTEGRAL du voyageur (courriel, telephone, nom, montant) pour 200
  // reservations, vers un navigateur qui ne la lisait nulle part. On garde son
  // COMPTE, et il doit valoir zero.
  assert.strictEqual(corps.arrivees_nombre, 0)
  assert.deepEqual(corps.conversations, [])
  // Les compteurs valent ZERO — un fait vrai : il n'a aucun bien. Pas `null`,
  // qui dirait « indisponible », et surtout pas le compte du titulaire.
  assert.deepEqual(corps.fait_pour_vous.menages, 0)
  assert.deepEqual(corps.fait_pour_vous.surreservation, 0)
})

// ─── 4. UN DROIT REFUSE ───────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : un domaine refuse n interroge meme pas sa table', async () => {
  // Le masquage par droit ne suffit jamais (regle absolue de CLAUDE.md) : la
  // garde SERVEUR est ici, et elle se mesure a ce qui ne part pas en requete.
  const refs = [BULLE_UUID, BULLE_REF]
  // ⚠ L'ALARME DE SURRESERVATION EST SOUS `reservations`, PAS `reglages` —
  // ET CE TEST DISAIT L'INVERSE, PARCE QUE L'ENDPOINT LE DISAIT. Le droit de
  // lecture doit etre celui de l'endpoint qui l'ACQUITTE
  // (`api/incidents-acquitter.js` : « une surreservation est un conflit de
  // reservations »), sinon il bouge dans les deux sens : un profil
  // `proprietaire` (`reservations: read`, `reglages: none`) perdait ses
  // alarmes alors que la page lui montre le bouton d'acquittement, et un
  // membre `reglages: read` / `reservations: none` recevait le detail de
  // l'incident — nom du bien, nuits en conflit, identifiants des reservations.
  // ⚠ `ota_reviews` A ETE AJOUTEE LE 25 OCTOBRE 2026 (constat GRAVE de la revue
  // de l'etape 2 du lot Aujourd'hui V5). Le bloc « Derniers avis » lit cette
  // table DIRECTEMENT, et la liste ci-dessous ne la nommait pas : retirer la
  // garde `if (!droits.avis) return null` de l'endpoint laissait les 6284 tests
  // au vert, pendant qu'un membre SANS le droit `avis` recevait les
  // commentaires ET le prenom du voyageur. Seul le masquage restait — la
  // classe de defaut que CLAUDE.md enregistre trois fois.
  const cas = [
    ['messages', ['agent_tasks', 'messages']],
    ['reservations', ['automation_incidents']],
    ['avis', ['ota_reviews']]
  ]
  for (const [domaine, interdites] of cas) {
    const garde = TOUS_DOMAINES.filter(d => d !== domaine)
    const { requetes, corps, notesVues } = await banc({ refs, domaines: garde })()
    assert.ok(corps.refuses.includes(domaine), `${domaine} n est pas annonce comme refuse`)
    for (const t of interdites) {
      assert.ok(!requetes.some(r => r.table === t),
        `${domaine} refuse, et ${t} est pourtant interrogee`)
    }
    if (domaine === 'avis') {
      assert.strictEqual(notesVues.length, 0, 'les notes sont lues sans le droit `avis`')
      assert.strictEqual(corps.notes, null, 'les notes refusees ne valent pas zero')
      // ⚠ `null`, PAS `[]`. Une liste vide dirait « cet hote n'a pas d'avis »
      // a qui n'a pas le droit de le savoir — et l'ecran afficherait « Pas
      // encore d'avis sur 30 jours » au lieu de ne rien montrer.
      assert.strictEqual(corps.derniers_avis, null,
        'les derniers avis refuses ne valent pas une liste vide')
    }
    if (domaine === 'reservations') {
      assert.strictEqual(corps.alarmes, null, 'les alarmes refusees valent une liste vide')
      assert.strictEqual(corps.fait_pour_vous.surreservation, null,
        'le compteur de surreservation se lit sans le droit `reservations`')
    }
    if (domaine === 'messages') {
      assert.strictEqual(corps.taches, null, 'les taches refusees valent une liste vide')
      assert.strictEqual(corps.conversations, null)
      assert.strictEqual(corps.etats_arrivee, null)
      assert.strictEqual(corps.fait_pour_vous.messages_ia, null)
    }
  }
})

test('LE TEST QUI COMPTE : `price_display_log` ne se lit que pour le TITULAIRE', async () => {
  // Sa RLS est `user_id = auth.uid()` : elle ne connait pas la delegation. La
  // cle de service la contourne, donc le droit se verifie ici — et un membre,
  // meme avec tous les domaines en lecture, n'y a pas acces.
  const { requetes, corps } = await banc({ refs: [BULLE_UUID, BULLE_REF] })()
  assert.ok(!requetes.some(r => r.table === 'price_display_log'),
    'un membre delegue lit `price_display_log`, dont la RLS ne connait que le titulaire')
  assert.strictEqual(corps.fait_pour_vous.prix, null, 'le compteur prix vaut un nombre pour un membre')
  const t = await banc({ titulaire: true })()
  assert.ok(t.requetes.some(r => r.table === 'price_display_log'),
    'le titulaire ne lit plus son propre journal de prix')
})

// ─── 5. LA REPONSE, AU TAMIS ──────────────────────────────────────────────────

test('LE TEST QUI COMPTE : aucune reference hors perimetre dans la reponse', async () => {
  // ⚠ LE TAMIS PORTE SUR LE JSON RENDU, PAS SUR LES REQUETES. Les deux se
  // trompent differemment : une requete peut etre bornee et la reponse porter
  // quand meme une donnee d'un autre bien (un assemblage en memoire, une
  // jointure a la main). On relit donc la sortie.
  const refs = [BULLE_UUID, BULLE_REF]
  const jour = jourDeParis()
  const { corps } = await banc({ refs, lignes: {
    // La base rend EXPRES des lignes des deux biens — comme si une borne
    // manquait : si l'endpoint les recopie, le tamis le dira.
    properties: [{ id: BULLE_UUID, name: 'La bulle' }, { id: AUTRE_UUID, name: 'Interdit' }],
    agent_tasks: [{ id: 1, property_id: BULLE_REF, status: 'pending', guest_name: 'Chez moi' },
      { id: 2, property_id: AUTRE_REF, status: 'pending', guest_name: 'Interdit' }],
    bookings_snapshot: [
      { booking_id: 'B1', property_id: BULLE_REF, snapshot: { arrival: jour } },
      { booking_id: 'B2', property_id: AUTRE_REF, snapshot: { arrival: jour } }
    ]
  } })()
  const json = JSON.stringify(corps)
  assert.ok(!json.includes(AUTRE_UUID), 'l UUID d un bien hors perimetre est dans la reponse')
  assert.ok(!json.includes('Interdit'), 'le nom d un bien hors perimetre est dans la reponse')
})

// ─── La forme de l endpoint ───────────────────────────────────────────────────

test('seul GET est accepte, et l en-tete prive est pose AVANT le refus', async () => {
  // L'en-tete prive vient de la garde, donc avant tout : un 405 ne doit pas
  // sortir sans lui — c'est un cache partage qui le retiendrait sinon.
  const { res } = await banc({ titulaire: true, methode: 'POST' })()
  assert.deepEqual(res.codes, [405])
  assert.strictEqual(res.entetes.allow, 'GET')
})

test('le cout s annonce : `Server-Timing` et le bloc `cout`', async () => {
  const { res, corps } = await banc({ titulaire: true })()
  // ⚠ `db;dur` ET `calc;dur`, exigees par la spec §7.2 : c'est la coupe qui
  // attribue une reponse lente a la base ou au JavaScript. Et `desc` annonce
  // son compte comme un PLANCHER, parce que deux appels ne se comptent pas
  // exactement (`etatMenage` a son propre client, `notesDuPerimetre` pagine).
  const st = res.entetes['server-timing'] || ''
  assert.match(st, /db;dur=\d+/, 'la part BASE manque')
  assert.match(st, /calc;dur=\d+/, 'la part CALCUL manque')
  assert.match(st, /total;dur=\d+/)
  // ⚠ « ORDRE DE GRANDEUR », PAS « PLANCHER » — ET J'AVAIS ECRIT « plancher ».
  // Le mot etait faux dans l'autre sens : `LECTURES_ETAT_MENAGE = 4` est un
  // MAJORANT (la fonction a trois sorties anticipees), donc le compte peut
  // aussi SURESTIMER. Un instrument pose pour designer la cause ne doit pas
  // mentir sur son propre sens d'erreur.
  assert.match(st, /desc="\d+ req \(ordre de grandeur\)"/,
    'le compte de requetes doit annoncer son incertitude')
  assert.ok(Number.isInteger(corps.cout.requetes) && corps.cout.requetes > 0)
  assert.ok(typeof corps.calcule_le === 'string' && corps.calcule_le.endsWith('Z'),
    'l heure du calcul est exigee par la regle d architecture')
})

test('une panne de lecture se NOMME, elle ne devient pas une liste vide', async () => {
  // Regle de restitution du depot : un `null` s'affiche « non calculable » avec
  // son motif. Une liste vide dirait « rien a traiter », un FAIT.
  const { corps } = await banc({ titulaire: true, pannes: ['agent_tasks', 'automation_incidents'] })()
  assert.strictEqual(corps.taches, null)
  assert.strictEqual(corps.alarmes, null)
  assert.ok(corps.indisponibles.includes('taches'))
  assert.ok(corps.indisponibles.includes('alarmes'))
})

test('une liste PLAFONNEE le dit, pour que l ecran puisse afficher « 200+ »', async () => {
  // Mesure du 23 octobre 2026 : le compte de Thierry porte 222 taches ouvertes
  // pour un plafond de 200. La liste est donc deja tronquee aujourd'hui.
  const taches = Array.from({ length: 200 },
    (_, i) => ({ id: i, property_id: BULLE_REF, status: 'pending' }))
  const { corps } = await banc({ titulaire: true, lignes: { agent_tasks: taches } })()
  assert.ok(corps.tronquees.includes('taches'),
    'une liste au plafond passe pour complete : l ecran affiche un compte faux avec aplomb')
})

// ─── Les correctifs de la review max, chacun avec sa mesure ───────────────────

test("LE TEST QUI COMPTE : le jour et le lendemain ne se confondent JAMAIS, meme au changement d'heure", async () => {
  // ⚠ CE DEFAUT SE DECLENCHAIT DEUX JOURS APRES LE COMMIT DU LOT.
  // `jourParis` ajoutait `n * 86400000` ms, alors que son propre commentaire
  // promettait « jamais un pas de 24 h ». Le 24 octobre 2026 a 22 h 30 UTC
  // (Paris 25 octobre 00 h 30, jour de 25 heures), `jour` et `demain` valaient
  // tous deux « 2026-10-25 » : la fenetre des arrivees devenait UN seul jour,
  // et aucune arrivee du 26 n'avait d'etat de code — donc aucune invite
  // « Envoyer le code » pour le voyageur du lendemain.
  // Au printemps, le miroir : le 27 mars 2027, `demain` sautait au 29.
  for (const [instant, jour, demain] of [
    ['2026-10-24T22:30:00Z', '2026-10-25', '2026-10-26'],   // recul de l'heure
    // ⚠ A 22 h 30 UTC le 27 mars 2027, Paris est encore a UTC+1 : la date
    // civile est le 27, et le lendemain le 28. L'ancien code rendait 27 et
    // **29** — il SAUTAIT le 28, le jour de 23 heures.
    ['2027-03-27T22:30:00Z', '2027-03-27', '2027-03-28'],   // avance de l'heure
    ['2026-12-31T23:30:00Z', '2027-01-01', '2027-01-02']    // passage d'annee
  ]) {
    const { corps, requetes } = await banc({ titulaire: true, instant })()
    assert.strictEqual(corps.jour, jour, `jour faux a ${instant}`)
    const arr = requetes.find(r => r.table === 'bookings_snapshot')
    const bornes = arr.filtres.filter(f => f[1] === 'snapshot->>arrival')
    assert.deepEqual(bornes.map(f => f[2]).sort(), [demain, jour].sort(),
      `la fenetre des arrivees n est pas [${jour}, ${demain}] a ${instant}`)
  }
})

test('LE TEST QUI COMPTE : les fils se lisent en PAGES, parce que PostgREST coupe a 1000', async () => {
  // ⚠ MESURE DU 23 OCTOBRE 2026 : 1843 lignes `messages` reelles, et
  // `.limit(5000)` en rendait 1000. `db-max-rows` coupe SANS erreur, donc mon
  // drapeau `length >= 5000` ne pouvait jamais se lever : la liste etait deja
  // tronquee ce jour-la, en silence. Consequence a l'ecran : une arrivee dont
  // les messages tombaient hors des 1000 lus renvoyait vers la fiche du bien
  // au lieu de sa conversation, differemment a chaque rechargement.
  // Apres correctif, le titulaire de production passe de 137 a 221 fils.
  const { requetes, corps } = await banc({ titulaire: true, pages: { messages: 2 } })()
  const lectures = requetes.filter(r => r.table === 'messages' && r.limite === 1000)
  assert.strictEqual(lectures.length, 3,
    `${lectures.length} lecture(s) paginees de fils : la pagination ne tourne pas`)
  // ⚠ PAR CURSEUR, PAS PAR DECALAGE. `messages.id` est un `gen_random_uuid()`
  // et `.range` se traduit en `offset` : un message insere entre deux pages
  // prend une cle aleatoire qui peut tomber DANS la page deja lue, toutes les
  // lignes suivantes glissent d'un rang, et celle de l'index 1000 n'est jamais
  // rendue. Son fil manque alors de `conversations`, donc l'arrivee renvoie
  // vers la fiche du bien au lieu de la conversation — differemment a chaque
  // rechargement. Un ordre stable est NECESSAIRE mais pas suffisant.
  for (const r of lectures) {
    assert.ok((r.ordres || []).some(o => o[0] === 'id' && o[1] === true),
      'une page de fils n est pas ordonnee par `id` croissant : deux pages peuvent se recouvrir')
    assert.strictEqual(r.plage, undefined,
      'la pagination est repassee a `.range()` (decalage) : une ligne peut etre sautee')
  }
  assert.deepEqual(lectures.slice(1).map(r => !!r.filtres.find(f => f[0] === 'gt' && f[1] === 'id')),
    [true, true], 'les pages suivantes ne portent pas de curseur `.gt(id, dernier)`')
  assert.ok(Array.isArray(corps.conversations) && corps.conversations.length > 1000,
    `${(corps.conversations || []).length} fils : la deuxieme page n a pas ete lue`)
  assert.deepEqual(corps.tronquees, [], 'la troncature est annoncee a tort')

  // Et au-dela du nombre de pages, la troncature SE DIT.
  const bcp = await banc({ titulaire: true, pages: { messages: 99 } })()
  assert.ok(bcp.corps.tronquees.includes('conversations'),
    'au plafond de pages, la liste des fils passe pour complete')
})

test("LE TEST QUI COMPTE : une colonne absente masque la tuile SANS la dire en panne", async () => {
  // Dette 66. `42703` = la migration n'est pas encore collee : la tuile se
  // masque, sans bruit. Toute AUTRE erreur est une panne, et doit se nommer.
  const a = await banc({ titulaire: true,
    erreurs: { messages: { code: '42703', message: 'column origine does not exist' } } })()
  assert.strictEqual(a.corps.fait_pour_vous.messages_ia, null, 'un faux zero est affiche')
  assert.ok(!a.corps.indisponibles.includes('messages_ia'),
    'une colonne pas encore creee est annoncee comme une panne')

  const b = await banc({ titulaire: true,
    erreurs: { messages: { code: '57014', message: 'canceling statement: origine' } } })()
  assert.strictEqual(b.corps.fait_pour_vous.messages_ia, null)
  assert.ok(b.corps.indisponibles.includes('messages_ia'),
    'un timeout dont le message cite « origine » passe pour une colonne absente')
})

test("LE TEST QUI COMPTE : un bloc qui LEVE n'emporte pas les neuf autres", async () => {
  // Dix blocs dans un `Promise.all` : une seule exception rejetait le handler,
  // Vercel rendait 500, et la page degradait TOUT d'un coup — y compris
  // l'alarme de surreservation, qui disparaissait avec le reste. `lireNotes`
  // appelle un module qui leve PAR CONCEPTION, et il etait le seul appel
  // etranger non garde du fichier.
  const { res, corps } = await banc({ titulaire: true, notesLevent: true })()
  assert.deepEqual(res.codes, [200], 'l ecran entier part en 500 pour un bloc')
  assert.strictEqual(corps.notes, null)
  assert.ok(corps.indisponibles.includes('notes'), 'le bloc en echec ne se nomme pas')
  // Et les autres blocs ont bien repondu : c'est toute la conception
  // d'`indisponibles` — un bloc absent n'est pas un ecran absent.
  assert.ok(Array.isArray(corps.biens))
  assert.strictEqual(corps.fait_pour_vous.jours, 7)
  assert.ok(Array.isArray(corps.alarmes), 'l alarme de surreservation est partie avec les notes')
})

test("LE TEST QUI COMPTE : le statut d'une arrivee passe par le LECTEUR CANONIQUE", () => {
  // ⚠ TROISIEME VALEUR POUR CE CHAMP, ET LES DEUX PREMIERES ETAIENT FAUSSES.
  // J'avais ecrit `|| 'confirmed'`, la premiere review a demande `|| null`
  // pour s'aligner sur `api/messages.js`, et la seconde a montre que
  // `api/messages.js` avait TORT :
  //   `lib/bookings-snapshot-status.js` dit « valeur vide/absente -> confirmed
  //   (comportement historique des 5 writers) », et `api/menages.js` filtre par
  //   `isActiveStatus`. Une reservation sans statut EST donc affichee comme
  //   arrivee du jour — mais `arriveesProches` exige `arr && st && …`, donc
  //   `null` la faisait sortir : le voyageur arrive, et l'hote n'a ni etat de
  //   code ni invite « Envoyer le code ».
  // La regle ne se recopie pas, elle s'APPELLE : les deux appelants de
  // `arriveesProches` passent par `readStatus`, qui traduit en plus le
  // vocabulaire brut des providers (`inquiry`, `black` sont des mots Beds24).
  const fs = require('node:fs')
  const path = require('node:path')
  const lu = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
  for (const f of ['api/ecran/aujourdhui.js', 'api/messages.js']) {
    const src = lu(f)
    assert.match(src, /require\('[^']*bookings-snapshot-status'\)/,
      `${f} ne charge pas le lecteur canonique du statut`)
    assert.match(src, /status:\s*readStatus\(/,
      `${f} recopie la regle du statut au lieu de l appeler`)
    assert.ok(!/status:[^\n]*\|\|\s*(null|'confirmed')/.test(src),
      `${f} porte encore un defaut de statut en dur`)
  }
  // Et la primitive dit bien ce qu'on attend d'elle.
  const { canonicalStatus } = require('../lib/bookings-snapshot-status')
  assert.strictEqual(canonicalStatus(undefined), 'confirmed',
    'un statut absent doit valoir `confirmed`, sinon l arrivee sort du filtre')
  assert.strictEqual(canonicalStatus(''), 'confirmed')
})

// ─── Les garanties que la contre-epreuve a trouvees SANS AUCUN TEST ──────────

test("LE TEST QUI COMPTE : la preuve « transmis » est cle sur le COUPLE bien + reservation", async () => {
  // ⚠ CETTE GARANTIE N'AVAIT AUCUN TEST, et la contre-epreuve l'a montre :
  // revenir a une cle `booking_id` seule laissait la suite ENTIERE au vert.
  // Un identifiant de reservation Beds24 est numerique et n'est unique QUE par
  // bien : reutilise sur un autre logement du meme compte, il melangeait les
  // messages sortants de cet autre logement dans le sac de celui-ci. Si l'un
  // d'eux contient les chiffres du code bornes par des non-chiffres (un prix,
  // un autre code de porte), le verdict passe a « transmis » pour une arrivee
  // dont le code n'a jamais ete envoye.
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'api/ecran/aujourdhui.js'), 'utf8')
  const bloc = (src.match(/const parBooking = Object\.create\(null\)[\s\S]*?\n      \}/) || [''])[0]
  assert.ok(bloc, 'le sac des messages sortants a disparu')
  assert.match(bloc, /\$\{String\(m\.property_id\)\}\|\$\{String\(m\.booking_id\)\}/,
    'le sac est cle sur la reservation seule : deux biens partageant un numero se melangent')
  assert.match(src, /parBooking\[`\$\{a\.propertyId\}\|\$\{a\.bookId\}`\]/,
    'la lecture du sac n utilise pas le couple')
  // Et la lecture est ordonnee du PLUS RECENT au plus ancien : avec plus de
  // 1000 sortants sur ces reservations, l'ordre croissant garderait les plus
  // ANCIENS, donc jamais celui qui porte le code.
  const { requetes } = await banc({ titulaire: true, lignes: {
    bookings_snapshot: [{ booking_id: 'B1', property_id: BULLE_REF,
      snapshot: { arrival: jourDeParis(), status: 'confirmed' } }]
  } })()
  const preuve = requetes.find(r => r.table === 'messages'
    && r.filtres.some(f => f[0] === 'in' && f[1] === 'booking_id'))
  assert.ok(preuve, 'la preuve de transmission ne se lit plus')
  assert.deepEqual((preuve.ordres || [])[0], ['sent_at', false],
    'la preuve de transmission n est plus ordonnee du plus RECENT au plus ancien')
})

test("LE TEST QUI COMPTE : une lecture de codes en echec ne rend AUCUN verdict", async () => {
  // ⚠ `indisponibles` ETAIT POUSSE, ET LE CODE CONTINUAIT. `codesParReservation([])`
  // rend `{}`, donc `verdictDuCode(undefined, …)` rendait « aucun » — un
  // verdict DEFINITIF — pour chaque arrivee du jour. La page ne traduit que
  // « cree » en invite « Envoyer le code » : la pastille et l'invite
  // disparaissaient en silence alors qu'un code existe.
  const jour = jourDeParis()
  const arrivee = { bookings_snapshot: [{ booking_id: 'R1', property_id: BULLE_REF,
    snapshot: { arrival: jour, status: 'confirmed' } }] }
  for (const table of ['access_codes', 'messages']) {
    const { corps } = await banc({ titulaire: true, lignes: arrivee, pannes: [table] })()
    assert.strictEqual(corps.etats_arrivee, null,
      `${table} illisible, et un verdict est quand meme rendu : ` + JSON.stringify(corps.etats_arrivee))
    assert.ok(corps.indisponibles.includes('etats_arrivee'),
      `${table} illisible n est pas annonce`)
  }
})

test("LE TEST QUI COMPTE : un perimetre sans cle UUID se DIT, il ne rend pas un ecran vide", async () => {
  // ⚠ LE CORRECTIF DU 22P02 POUVAIT ECHANGER UNE PANNE BRUYANTE CONTRE UN FAUX
  // FAIT SILENCIEUX. `property_ids` et `property_refs` sont deux colonnes
  // distinctes, tenues d'accord par un TRIGGER : si le perimetre ne porte que
  // des cles provider, `refsUuid` vaut `[]` alors que `perimetreVide` est faux.
  // `.in('id', [])` rend alors zero ligne SANS erreur — « vous n'avez aucun
  // logement », affirme, pendant que tous les blocs a cle TEXTE sont remplis.
  const { corps } = await banc({ refs: [BULLE_REF] })()
  assert.strictEqual(corps.biens, null, 'un ecran vide est rendu comme un fait')
  assert.ok(corps.indisponibles.includes('biens'),
    'le perimetre sans cle UUID ne laisse aucune trace')
  assert.strictEqual(corps.perimetre_vide, false, 'le perimetre n est pas vide, il est illisible')
})

test("LE TEST QUI COMPTE : les taches portent les colonnes que la regle de repli LIT", async () => {
  // `shared/aujourdhui.js` garde une tache par `t.departure >= aujourd'hui`
  // quand les sejours ne sont pas lus. Sans la colonne au select, ce repli
  // valait TOUJOURS faux, et « A valider » affichait « aucune tache » — un
  // fait — sur un compte qui en porte 222. Les deux cas du repli laissent
  // justement les sejours vides : un profil `messages: read` / `menages: none`,
  // et tout hote dont `/api/menages` echoue.
  const { requetes } = await banc({ titulaire: true })()
  const r = requetes.find(x => x.table === 'agent_tasks')
  assert.ok(r, 'les taches ne sont plus lues')
  for (const col of ['arrival', 'departure', 'book_id', 'status']) {
    assert.ok(String(r.select).includes(col), `la colonne \`${col}\` manque au select des taches`)
  }
})

test("LE TEST QUI COMPTE : `biens` en echec vaut `null`, jamais une liste vide", async () => {
  const { corps } = await banc({ titulaire: true, pannes: ['properties'] })()
  assert.strictEqual(corps.biens, null,
    'une lecture de biens en echec rend `[]` : l ecran dit « aucun logement », un fait')
  assert.ok(corps.indisponibles.includes('biens'))
})

test("LE TEST QUI COMPTE : les fixtures de ce fichier datent en PARIS, comme le code qu'elles mesurent", () => {
  // ⚠ TROIS ROUGES, MESURES LE 23 OCTOBRE 2026 A 22 H 45 UTC, SUR UN ARBRE
  // DONT LE MEME BLOB RENDAIT `fail 0` A 14 H 50 LE MEME JOUR. Les fixtures
  // posaient leur arrivee sur le jour UTC, l'endpoint borne sa fenetre sur le
  // jour PARIS : les deux coincident la journee et divergent chaque nuit entre
  // 22 h UTC et minuit. Le test ne disait rien du code — il disait l'heure.
  //
  // CE TEST GARDE L'INVARIANT, pas la ligne : a un instant ou les deux jours
  // DIVERGENT, c'est le jour de Paris que la fixture doit rendre.
  const nuit = Date.UTC(2026, 9, 23, 22, 45) // 23 oct. 22 h 45 UTC = 24 oct. 00 h 45 a Paris
  assert.strictEqual(new Date(nuit).toISOString().slice(0, 10), '2026-10-23',
    'temoin : a cet instant, le jour UTC est bien le 23')
  assert.strictEqual(SHARED_AUJOURDHUI.jourParis(nuit, 0), '2026-10-24',
    'et le jour de Paris est le 24 : c est CET ecart qui faisait rougir trois tests')
  assert.strictEqual(SHARED_AUJOURDHUI.jourParis(nuit, 1), '2026-10-25')
  // Et le 25 octobre 2026, jour de 25 heures : la fenetre rouge se resserre a
  // 23 h — minuit, parce que Paris repasse a +1. Les deux instants le disent.
  assert.strictEqual(SHARED_AUJOURDHUI.jourParis(Date.UTC(2026, 9, 25, 22, 45), 0), '2026-10-25',
    'a 22 h 45 UTC le 25, Paris est encore le 25 : plus d ecart')
  assert.strictEqual(SHARED_AUJOURDHUI.jourParis(Date.UTC(2026, 9, 25, 23, 45), 0), '2026-10-26',
    'a 23 h 45 UTC le 25, Paris est le 26 : l ecart est revenu, une heure plus tard qu en ete')

  // ⚠ ET LE MOTIF TEXTUEL, EN DERNIER RECOURS ET ASSUME (regle 20). Aucun
  // appel ne peut voir qu'une fixture FUTURE aura ete ecrite en UTC : le defaut
  // est dans la frappe, pas dans un comportement. C'est la seule garde qui
  // attrape la recopie du geste d'origine — et c'est exactement par recopie que
  // les quatre fixtures de ce fichier avaient le meme defaut.
  const fs = require('node:fs')
  const path = require('node:path')
  const moi = fs.readFileSync(path.join(__dirname, 'ecran-aujourdhui-isolation.test.js'), 'utf8')
  const dansLeCode = moi.split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .filter(l => /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/.test(l))
  assert.deepEqual(dansLeCode, [],
    'une fixture date en jour UTC : utilisez `jourDeParis()`, sinon elle rougira entre 22 h et minuit UTC')
})

test("LE TEST QUI COMPTE : les TROIS copies de `jourParis` comptent en jours calendaires", async () => {
  // ⚠ LE PREMIER CORRECTIF N'EN AVAIT TOUCHE QU'UNE. `api/messages.js` est
  // l'AUTRE injecteur du meme `arriveesProches` — tout l'interet de
  // `lib/ecran/etat-du-code.js` est qu'une seule regle serve les deux ecrans, et
  // `jourParis` est justement la piece restee injectee. Ces nuits-la,
  // `/messages` et `/aujourdhui` auraient designe des arrivees « proches »
  // differentes pour la meme reservation le meme jour : la divergence exacte
  // que l'extraction a ete ecrite pour empecher.
  // Et `shared/aujourdhui.js` portait la sienne DEUX LIGNES au-dessus
  // d'`ajouterJours`, qui porte deja l'avertissement.
  const fs = require('node:fs')
  const path = require('node:path')
  for (const f of ['api/ecran/aujourdhui.js', 'api/messages.js', 'shared/aujourdhui.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
    const bloc = (src.match(/(?:const|export function) jourParis[\s\S]*?\n\}/) || [''])[0]
    assert.ok(bloc, `${f} : jourParis introuvable`)
    assert.ok(!/\*\s*86400000/.test(bloc) && !/86400000\s*\*/.test(bloc),
      `${f} avance encore par pas de 24 h : il glisse d un jour au changement d heure`)
    assert.ok(/Date\.UTC|ajouterJours/.test(bloc),
      `${f} ne fait pas d arithmetique calendaire`)
  }

  // Et la mesure, sur la copie qui est importable depuis un test — celle que
  // les fixtures de ce fichier utilisent desormais pour poser leurs arrivees.
  const mod = { exports: SHARED_AUJOURDHUI }
  for (const [instant, jour, demain] of [
    ['2026-10-24T22:30:00Z', '2026-10-25', '2026-10-26'],
    ['2027-03-27T22:30:00Z', '2027-03-27', '2027-03-28'],
    ['2026-12-31T23:30:00Z', '2027-01-01', '2027-01-02']
  ]) {
    const t = new Date(instant).getTime()
    assert.strictEqual(mod.exports.jourParis(t, 0), jour, `jour faux a ${instant}`)
    assert.strictEqual(mod.exports.jourParis(t, 1), demain, `lendemain faux a ${instant}`)
  }
})

test("LE TEST QUI COMPTE : la fenetre des arrivees ne se recalcule pas APRES la lecture", () => {
  // ⚠ LE CORRECTIF DE `jourParis` LAISSAIT UN DECALAGE D'UN JOUR A L'INTERIEUR
  // DE LUI-MEME. `arriveesProches(arrivees, (d) => jourParis(d))` reconstruit
  // la date a l'appel : une requete commencee a 23 h 59 min 59 s interroge
  // `bookings_snapshot` pour [J, J+1], puis — la phase de lecture ayant pris
  // quelques centaines de millisecondes — filtre ses lignes sur [J+1, J+2].
  // Les lignes de J+1 survivent, celles de J+2 n'ont JAMAIS ete lues, et la
  // reponse annonce `jour: J`. Le voyageur du lendemain perd son etat de code.
  // Les deux jours sont deja calcules en tete du handler : on les PASSE.
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'api/ecran/aujourdhui.js'), 'utf8')
  assert.match(src, /arriveesProches\(arrivees, \(d\) => \(d === 0 \? jour : demain\)\)/,
    'la fenetre des arrivees est recalculee sur l horloge apres la phase de lecture')
  // Et `jourParis` n'est appele qu'au DEBUT, pour poser `jour` et `demain`.
  // ⚠ HORS COMMENTAIRES : trois des six occurrences sont dans l'explication du
  // defaut, et c'est la TROISIEME fois que je compte des mentions pour des
  // appels. D'ou `tests/outils/source.js`.
  const { compterDansLeCode } = require('./outils/source')
  const appels = compterDansLeCode(src, /jourParis\(/)
  // Deux, et deux seulement : `jour` et `demain`. La definition est une
  // flechee (`const jourParis = (decalage = 0) => {`), donc elle ne compte pas.
  assert.strictEqual(appels, 2,
    `${appels} appels a jourParis dans le CODE : seules les deux bornes du `
    + 'handler doivent en faire un — tout appel plus loin relit l horloge')
})

test("LE TEST QUI COMPTE : `db;dur` couvre la GARDE, qui fait jusqu'a trois lectures", () => {
  // `contexteDEcran` lit la session, le compte demande et — pour un membre
  // delegue — son profil et ses droits : un a trois allers-retours reseau.
  // Mesures en dehors de `db;dur`, ils tombaient dans `calc;dur` : la requete
  // la plus lente du produit, celle d'un membre delegue, se lisait
  // « JavaScript lent ». C'est l'inverse de ce que la coupe sert a dire.
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'api/ecran/aujourdhui.js'), 'utf8')
  assert.match(src, /const msDb = tFinLectures - t0/,
    'la part BASE exclut la garde, dont les lectures sont les plus lentes du chemin')
  assert.ok(!/const msDb = tFinLectures - tDebutLectures/.test(src))
})
