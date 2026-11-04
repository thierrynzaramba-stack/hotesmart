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
        requirePermission: async () => ({ ok: true, contexte, compte: TITULAIRE, bien: null }),
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
    delete require.cache[abs]
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
  { ecran: 'Calendrier et base de connaissance', chemin: 'api/channel-property.js', query: {} },
  { ecran: 'Menages (A traiter et calendrier)', chemin: 'api/menages.js', query: {} },
  // ⚠ `legitimes` EST VIDE ICI ET C'EST VOULU : la decision de Thierry garde
  // les avis RECUS d'un bien archive, mais la liste `biens` — celle du filtre et
  // du formulaire — ne doit plus le proposer. Le banc ne fournit aucun avis,
  // donc seule cette liste parle.
  { ecran: 'Avis (filtre et formulaire)', chemin: 'api/avis.js', query: {} },
  { ecran: 'Avis — reglage auto-validation', chemin: 'api/avis.js', query: { action: 'auto-validation' } },
]

// ⚠ `api/menages-public.js` N'EST PAS DANS CETTE LISTE, et la raison vaut
// d'etre ecrite : son chemin d'entree valide un PORTEUR de jeton — profil
// prestataire actif, mode d'acces, perimetre de biens — et le banc generique ne
// reproduit pas cet etat. Garni a moitie, il refusait en 401 et l'assertion de
// non-vacuite le disait au lieu de verdir.
// Son filtre est prouve la ou le banc sait franchir cette garde :
// `tests/menages-public-filtre-presta.test.js`, qui lit la requete REELLEMENT
// emise et exige `archive_le is null`.

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
