// tests/ecrans-sans-biens-archives.test.js
// DOC : docs/kb/coeur-de-donnees.md (config d'app vs config generale)
//
// UN BIEN ARCHIVE NE PARAIT SUR AUCUN ECRAN DE TRAVAIL.
//
// Demande de Thierry du 3 novembre 2026, apres avoir archive « Colomiers » en
// production et l'avoir retrouve sur huit ecrans : « propose UN filtre partage
// (serveur), applique a tous les endpoints d'ecran, pas un correctif par page,
// avec un test qui liste les endpoints et rougit si l'un d'eux rend un bien
// archive ».
//
// ⚠ CE TEST **APPELLE** LES HANDLERS. Il ne grepe pas leur source : un `grep`
// de `sansArchives` resterait vert le jour ou l'appel devient inatteignable, ou
// ou la chaine filtree n'est plus celle qui sert la reponse. C'est la lecon
// « un test qui grepe la source » du depot.
//
// ⚠ ET LE DOUBLE **APPLIQUE** LE FILTRE, c'est tout l'enjeu de ce banc. Un
// double qui ignorerait `.is('archive_le', null)` rendrait les deux biens quoi
// que fasse l'endpoint : le test rougirait toujours, donc on le retirerait. Un
// double qui filtrerait de lui-meme les rendrait toujours conformes : le test
// serait vert pour tout le monde, y compris pour un endpoint sans garde. Il
// n'applique donc QUE les filtres que l'endpoint demande, et le test de
// non-vacuite plus bas prouve qu'il sait rendre le bien archive.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

// ⚠ LES DEUX VARIABLES SONT POSEES AVANT TOUT `require`, comme dans le banc
// d'isolation : les endpoints creent leur client AU NIVEAU MODULE, et le vrai
// `createClient` leve « supabaseUrl is required » avant que le double n'ait eu
// la main. Elles ne joignent rien — toutes les requetes passent par le double.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const TITULAIRE = '11111111-1111-1111-1111-111111111111'
// ⚠ `provider_property_id` EST OBLIGATOIRE SUR LES DEUX : le domaine menage
// raisonne en cle provider et EXCLUT les biens qui n'en ont pas
// (`.not('provider_property_id', 'is', null)`). Sans elle, l'endpoint rendait
// zero bien et l'assertion de non-vacuite refusait — a juste titre : un banc
// qui ne rend rien ne prouve rien.
const VIVANT = {
  id: '22222222-2222-2222-2222-222222222222', name: 'La bulle',
  provider_property_id: 'prop-vivant', provider: 'channex', archive_le: null
}
const RANGE = {
  id: '33333333-3333-3333-3333-333333333333', name: 'Colomiers',
  provider_property_id: 'prop-range', provider: 'channex',
  archive_le: '2026-11-03T20:42:19.342Z'
}

// ─── Le double de `properties`, qui HONORE les filtres demandes ─────────────
function tableProperties (lignes, journal) {
  const filtres = []
  const chaine = {
    select (champs) { journal.champs = champs; return chaine },
    eq (c, v) { filtres.push(['eq', c, v]); return chaine },
    in (c, v) { filtres.push(['in', c, v]); return chaine },
    is (c, v) { filtres.push(['is', c, v]); return chaine },
    not (c, op, v) { filtres.push(['not', c, v]); return chaine },
    or () { return chaine },
    order () { return chaine },
    limit () { return chaine },
    range () { return chaine },
    gte () { return chaine },
    lte () { return chaine },
    maybeSingle: async () => ({ data: applique()[0] || null, error: null }),
    single: async () => ({ data: applique()[0] || null, error: null }),
    then (res) { return res({ data: applique(), error: null, count: applique().length }) }
  }
  function applique () {
    journal.filtres = filtres
    return lignes.filter(l => filtres.every(([op, c, v]) => {
      if (op === 'is') return l[c] === v || (v === null && l[c] == null)
      if (op === 'eq') return c === 'user_id' ? true : String(l[c]) === String(v)
      if (op === 'in') return c === 'user_id' ? true : (v || []).map(String).includes(String(l[c]))
      if (op === 'not') return !(l[c] === v || (v === null && l[c] == null))
      return true
    }))
  }
  return chaine
}

// ⚠ CERTAINS ENDPOINTS ONT BESOIN D'UNE AUTRE TABLE POUR FRANCHIR LEUR GARDE
// D'ENTREE — l'app de la prestataire resout son jeton dans `public_tokens`
// avant de lire quoi que ce soit. Un banc qui ne sait servir que `properties`
// ne les atteint jamais, et l'assertion de non-vacuite le dit au lieu de
// verdir. Les lignes sont donc fournies par l'ecran, a cote de sa `query`.
function tableGarnie (lignes) {
  const chaine = {
    select () { return chaine },
    eq () { return chaine },
    in () { return chaine },
    is () { return chaine },
    not () { return chaine },
    or () { return chaine },
    order () { return chaine },
    limit () { return chaine },
    range () { return chaine },
    gte () { return chaine },
    lte () { return chaine },
    maybeSingle: async () => ({ data: lignes[0] || null, error: null }),
    single: async () => ({ data: lignes[0] || null, error: null }),
    then (res) { return res({ data: lignes, error: null, count: lignes.length }) }
  }
  return chaine
}

// Toute autre table rend une liste vide : l'endpoint doit survivre sans elle.
function tableVide () {
  const chaine = new Proxy({}, {
    get (_, p) {
      if (p === 'then') return (res) => res({ data: [], error: null, count: 0 })
      if (p === 'maybeSingle' || p === 'single') return async () => ({ data: null, error: null })
      return () => chaine
    }
  })
  return chaine
}

function installer (lignes, journal, tables = {}) {
  const client = {
    from: (nom) => (nom === 'properties'
      ? tableProperties(lignes, journal)
      : (tables[nom] ? tableGarnie(tables[nom]) : tableVide())),
    rpc: () => ({ then: (res) => res({ data: [], error: null }) }),
    // ⚠ CERTAINS ENDPOINTS AUTHENTIFIENT AVANT LA GARDE, par le jeton Bearer
    // (`supabase.auth.getUser`) : doubler `requirePermission` seul ne suffit
    // pas, ils rendaient 401 et n'atteignaient jamais `properties`. C'est
    // l'assertion de non-vacuite de ce banc qui l'a dit — sans elle, trois
    // tests auraient ete VERTS sans rien mesurer.
    auth: { getUser: async () => ({ data: { user: { id: TITULAIRE } }, error: null }) }
  }
  const absGarde = require.resolve('../lib/require-permission')
  require('../lib/require-permission')
  // ⚠ DOUBLE COMPLET, JAMAIS PARTIEL : l'endpoint importe `UUID_RE` et
  // `REF_SURE_RE` du meme module, et un double qui les perd fait lever chaque
  // bloc sur `undefined.test`. Lecon deja payee par le banc d'isolation.
  const vraieGarde = require.cache[absGarde].exports
  const contexte = { userId: TITULAIRE, accountUserId: TITULAIRE, profil: null, permissions: null }
  const origine = Module._load
  Module._load = function (demande, parent, isMain) {
    if (demande === '@supabase/supabase-js') return { createClient: () => client }
    if (demande.endsWith('require-permission')) {
      // ⚠ TROIS GARDES DIFFERENTES SELON L'ENDPOINT, et il a fallu les trois :
      // `requirePermission` pour les endpoints metier, `contexteDEcran` pour
      // ceux de `api/ecran/`, et l'auth par jeton Bearer plus haut. Doubler la
      // premiere seule laissait les deux ecrans a 401 ou 403.
      return {
        ...vraieGarde,
        // ⚠ `accountUserId` COMME LA VRAIE GARDE : sans lui, un endpoint qui
        // en deduit son compte (`api/channel-property.js`) lisait pour
        // `undefined`, et sa lecture des biens archives n'avait jamais lieu.
        requirePermission: async () => ({ ok: true, contexte, compte: TITULAIRE, accountUserId: TITULAIRE, userId: TITULAIRE, bien: null }),
        contexteDEcran: async () => ({ ok: true, userId: TITULAIRE, accountUserId: TITULAIRE, contexte }),
        // ⚠ QUATRIEME PORTE D'ENTREE : certains endpoints appellent
        // `verifierSession` directement, sans passer par les deux gardes
        // ci-dessus. Doubler trois gardes sur quatre laisse l endpoint a 401 —
        // et c est encore la non-vacuite qui l a dit.
        verifierSession: async () => TITULAIRE
      }
    }
    return origine.apply(this, arguments)
  }
  return () => { Module._load = origine }
}

function appeler (chemin, query, lignes, tables) {
  const journal = {}
  const stop = installer(lignes, journal, tables)
  try {
    const abs = require.resolve(path.join(__dirname, '..', chemin))
    // ⚠ TOUT `api/` EST RECHARGE, PAS SEULEMENT L'ENDPOINT APPELE : l'appel
    // d'ecran de la page Avis (`api/ecran/avis.js`) reutilise les lectures
    // d'`api/avis.js`, et celui-ci, deja en cache depuis la ligne precedente,
    // gardait le client du banc d'AVANT — le test lisait un autre journal et
    // disait « n'a pas lu properties ».
    const dossierApi = path.join(__dirname, '..', 'api') + path.sep
    for (const k of Object.keys(require.cache)) if (k.startsWith(dossierApi)) delete require.cache[k]
    const handler = require(abs)
    const rep = { code: 0, corps: null, entetes: {} }
    const res = {
      status (c) { rep.code = c; return res },
      json (o) { rep.corps = o; return res },
      setHeader (k, v) { rep.entetes[k] = v; return res },
      end () { return res }
    }
    const req = { method: 'GET', query: query || {}, headers: { authorization: 'Bearer jeton-de-test' }, body: {} }
    return Promise.resolve(handler(req, res)).then(() => ({ rep, journal }), (e) => ({ rep, journal, erreur: e }))
  } finally { stop() }
}

// ─── LA LISTE DES ECRANS ────────────────────────────────────────────────────
// ⚠ ELLE VIT ICI, et le test d'exhaustivite plus bas refuse qu'un fichier de
// `api/ecran/` n'y figure pas : c'est ce qui empeche un ecran neuf d'etre
// oublie. Les autres endpoints d'ecran ne sont pas sous `api/ecran/` — il n'y
// en a que trois — donc ils sont nommes a la main, avec leur ecran.
//
// ⚠ `legitimes` NOMME LES CHAMPS QUI DOIVENT PORTER UN BIEN ARCHIVE. Decision 1
// de Thierry du 31 octobre 2026 : « revenus d'un bien archive comptes dans le
// total, ligne marquee archive ». L'accueil descend donc `biens_archives`
// EXPRES, pour que l'ecran sache nommer la ligne. Chercher le nom dans la
// reponse ENTIERE ferait rougir le test sur un comportement voulu — et la
// reaction serait de retirer le test, pas de corriger l'endpoint.
const ECRANS = [
  { ecran: 'Accueil', chemin: 'api/ecran/aujourdhui.js', query: { blocs: 'biens' }, legitimes: ['biens_archives'] },
  // La base de connaissance V5 (lot kb-v5, dans main le 7 novembre 2026) : le
  // volet et la page telephone choisissent leur logement dans `biens`. Le
  // filtre est l'affaire de kb-v5 (`.is('archive_le', null)`) ; ce banc le
  // TIENT, pour qu'un retrait futur rougisse ici.
  // ⚠ `?bien=` EST LE CHEMIN REEL du volet Messages (constat 3 de la revue de
  // 0ccd215d) : il demande le bien du fil ouvert, et le fil d'un bien archive
  // existe encore. Demander le bien ARCHIVE prouve qu'il n'est pas servi par
  // ce chemin non plus.
  { ecran: 'Base de connaissance (volet et page telephone)', chemin: 'api/ecran/connaissance.js', query: { bien: 'prop-range' } },
  { ecran: 'Calendrier et base de connaissance', chemin: 'api/channel-property.js', query: {} },
  { ecran: 'Menages (A traiter et calendrier)', chemin: 'api/menages.js', query: {} },
  // ⚠ LA PAGE `/menages` NE LIT PAS `api/menages.js` mais `api/garde.js`
  // (bulle « A traiter » et calendrier de garde) — constat 5 de la revue du
  // 7 novembre 2026 : la ligne du dessus couvrait l'accueil et l'ecran des
  // prestataires, pas cet ecran. Sans reservation au banc, le bien archive n'a
  // aucun depart a venir : il doit etre absent.
  { ecran: 'Menages (page /menages : bulle et calendrier de garde)', chemin: 'api/garde.js', query: { du: '2026-11-09', au: '2026-11-15' } },
  // ⚠ `legitimes` EST VIDE ICI ET C'EST VOULU : la decision de Thierry garde
  // les avis RECUS d'un bien archive, mais la liste `biens` — celle du filtre et
  // du formulaire — ne doit plus le proposer. Le banc ne fournit aucun avis,
  // donc seule cette liste parle.
  { ecran: 'Avis (filtre et formulaire)', chemin: 'api/avis.js', query: {} },
  // ⚠ C'EST CETTE LECTURE-CI QUE `pages/avis.html` APPELLE pour remplir son
  // filtre et son formulaire (constat 3 de la revue du 7 novembre 2026) : la
  // ligne du dessus couvrait `lister`, que la page n'appelle plus.
  { ecran: 'Avis (cartes : le filtre et le formulaire de la page)', chemin: 'api/avis.js', query: { action: 'cartes' } },
  { ecran: 'Avis — reglage auto-validation', chemin: 'api/avis.js', query: { action: 'auto-validation' } },
  // ⚠ L'APPEL D'ECRAN DE LA PAGE AVIS V5 (8 novembre 2026) : c'est desormais
  // LUI que la page lit pour son filtre et son formulaire. Il reutilise
  // `cartesLister`, mais un appel d'ecran qui recomposerait sa propre liste
  // rendrait le bien archive sans que la ligne `cartes` ne le voie.
  { ecran: 'Avis V5 (appel d ecran : filtre et formulaire)', chemin: 'api/ecran/avis.js', query: {} },
  // ⚠ L'APPEL D'ECRAN DE « CE QUI FAIT BOUGER VOS PRIX » (lot 4, 4a) : son
  // selecteur de logements vient de `biens`. Le bien archive DEMANDE par
  // `?bien=` (404, sans son nom) est prouve dans tests/ecran-evenements.test.js :
  // une reponse 404 ne porte pas le bien vivant que ce banc exige d'y voir.
  { ecran: 'Ce qui fait bouger vos prix (selecteur)', chemin: 'api/ecran/evenements.js', query: {} },
]

// ⚠ `api/menages-public.js` N'EST PAS DANS CETTE LISTE, et la raison vaut
// d'etre ecrite : son chemin d'entree valide un PORTEUR de jeton — profil
// prestataire actif, mode d'acces, perimetre de biens — et le banc generique ne
// reproduit pas cet etat. Garni a moitie, il refusait en 401 et l'assertion de
// non-vacuite le disait au lieu de verdir.
// Sa regle est prouvee la ou le banc sait franchir cette garde :
// `tests/menages-public-filtre-presta.test.js` — le CABLAGE (la colonne est
// lue) et l'EFFET (un bien archive reste tant qu'un depart du BIEN est a
// venir). ⚠ Il « exigeait `archive_le is null` » jusqu'au 3 novembre 2026 :
// la decision « jusqu'au dernier depart » a remplace ce filtre (constat 9 de
// la revue du 7 novembre 2026).

// ⚠ UNE EXEMPTION SE COMPTE ET SE MOTIVE, elle ne se decrit pas — meme
// discipline que l'`ATTENDU` de tests/bookings-snapshot-troncature.test.js. Le
// test d'exhaustivite plus bas exige qu'un fichier de `api/ecran/` soit couvert,
// exempte ICI avec sa raison, ou sans lecture de `properties`.
const EXEMPTES = {
  'revenus-annee.js':
    "son role EST de porter les biens archives (decision 1 de Thierry) : il rend "
    + "`archives` pour que la ligne de revenus soit nommee et marquee. Et son "
    + "bloc entier depend d'agregats RPC : un double qui les rend vides ne "
    + "mesure rien. Couvert par tests/ecran-revenus-annee.test.js.",
  'avis-recents.js': "ne lit pas `properties` : aucun bien a filtrer."
}

for (const e of ECRANS) {
  test(`LE TEST QUI COMPTE : ${e.ecran} ne rend AUCUN bien archive`, async () => {
    const { rep, journal, erreur } = await appeler(e.chemin, e.query, [VIVANT, RANGE], e.tables)
    assert.equal(erreur, undefined, `l endpoint a leve : ${erreur && erreur.message}`)
    assert.ok(journal.filtres, `${e.chemin} n a pas lu properties : ce test ne mesure rien`)
    // On retire les champs qui ont le DROIT de nommer un bien archive.
    const corps = { ...(rep.corps || {}) }
    for (const c of (e.legitimes || [])) delete corps[c]
    const texte = JSON.stringify(corps)
    assert.ok(texte.includes(VIVANT.name) || texte.includes(VIVANT.id),
      `${e.chemin} ne rend meme pas le bien VIVANT (code ${rep.code}) : son vert ne vaudrait rien`)
    assert.ok(!texte.includes(RANGE.name),
      `${e.chemin} rend le bien archive « ${RANGE.name} » (code ${rep.code})`)
  })
}

test('le double SAIT rendre un bien archive — sinon tous les tests ci-dessus sont creux', () => {
  // ⚠ LA CONTRE-EPREUVE DU BANC LUI-MEME. Sans elle, un double qui filtrerait
  // de son propre chef rendrait les trois tests verts pour n'importe quel
  // endpoint, garde ou pas.
  const journal = {}
  const q = tableProperties([VIVANT, RANGE], journal)
  let rendu = null
  q.select('*').eq('user_id', TITULAIRE).then((r) => { rendu = r.data })
  assert.equal(rendu.length, 2, 'le double filtre de lui-meme : il ne mesure plus rien')
  assert.ok(rendu.some(b => b.name === RANGE.name), 'le double n a pas rendu le bien archive')

  const j2 = {}
  const q2 = tableProperties([VIVANT, RANGE], j2)
  let r2 = null
  q2.select('*').is('archive_le', null).then((r) => { r2 = r.data })
  assert.equal(r2.length, 1, 'le double n applique pas `.is(archive_le, null)`')
  assert.equal(r2[0].name, VIVANT.name)
})

test("EXHAUSTIVITE : tout fichier de api/ecran/ figure dans la liste ci-dessus", () => {
  // ⚠ C'EST CE TEST QUI EMPECHE UN ECRAN NEUF D'ETRE OUBLIE. Sans lui, la liste
  // `ECRANS` serait un inventaire du jour ou elle a ete ecrite.
  const dossier = path.join(__dirname, '..', 'api', 'ecran')
  const fichiers = fs.readdirSync(dossier).filter(f => f.endsWith('.js'))
  assert.ok(fichiers.length >= 3, `${fichiers.length} fichier(s) dans api/ecran/ : la lecture a echoue`)
  const couverts = new Set(ECRANS.map(e => path.basename(e.chemin)))
  const vraisOublis = fichiers.filter(f => !couverts.has(f) && !EXEMPTES[f])
  assert.deepEqual(vraisOublis, [],
    `ces endpoints d ecran ne sont ni couverts ni exemptes : ${vraisOublis.join(', ')}`)

  // ⚠ ET UNE EXEMPTION QUI NE SERT PLUS SE RETIRE : sans ca, la liste devient
  // un cimetiere ou l'on ajoute sans jamais enlever, et un fichier renomme
  // garderait son laissez-passer sous son ancien nom.
  const mortes = Object.keys(EXEMPTES).filter(f => !fichiers.includes(f))
  assert.deepEqual(mortes, [], `exemptions qui ne correspondent a aucun fichier : ${mortes.join(', ')}`)
  for (const [f, raison] of Object.entries(EXEMPTES)) {
    assert.ok(String(raison).length > 40, `l exemption de ${f} n a pas de raison ecrite`)
  }
})

test('LE TEST QUI COMPTE : un bien BEDS24 archive en base ne revient pas par la liste live du provider', async () => {
  // ⚠ CONSTAT 4 DE LA REVUE DU 7 NOVEMBRE 2026. Les biens Beds24 ne viennent
  // pas de la base mais de l'API du provider : `sansArchives` ne pouvait pas
  // les atteindre, et un bien Beds24 archive restait dans les bulles du
  // calendrier et dans la liste de la base de connaissance.
  const RANGE_B24 = {
    id: '44444444-4444-4444-4444-444444444444', user_id: TITULAIRE, name: 'Studio Beds24',
    provider: 'beds24', provider_property_id: '555', archive_le: '2026-11-03T20:42:19.342Z'
  }
  const vraiFetch = global.fetch
  global.fetch = async (url) => {
    if (String(url).includes('beds24.com/api/v2/properties')) {
      return { ok: true, status: 200, json: async () => ({ data: [
        { id: 555, name: 'Studio Beds24', roomTypes: [] },
        { id: 556, name: 'Gite Beds24 vivant', roomTypes: [] }
      ] }) }
    }
    throw new Error('appel reseau inattendu : ' + url)
  }
  try {
    const { rep, erreur } = await appeler('api/channel-property.js', {}, [VIVANT, RANGE_B24], { api_keys: [{ api_key: 'cle-de-test' }] })
    assert.equal(erreur, undefined, `l endpoint a leve : ${erreur && erreur.message}`)
    const texte = JSON.stringify(rep.corps || {})
    assert.ok(texte.includes('Gite Beds24 vivant'),
      `la liste live Beds24 n a pas ete servie (code ${rep.code}) : ce test ne mesure rien`)
    assert.ok(!texte.includes('Studio Beds24'), 'le bien Beds24 archive revient par la liste live')
  } finally { global.fetch = vraiFetch }
})
