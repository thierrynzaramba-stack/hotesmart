// tests/contexte-compte-cache.test.js
//
// LOT (a) DE LA SPEC PERFORMANCE : le contexte de compte garde quelques
// minutes. `chargerContexte` part a CHAQUE ouverture de page, et son seul cout
// reseau — `api.membres.mesComptes()` — precede toute lecture metier, sur tous
// les ecrans.
//
// ⚠ CE QUI EST GARDE, ET CE QUI NE L'EST PAS : la LISTE des comptes, jamais
// les DROITS. `chargerPermissions()` reste appelee a chaque fois (zero lecture
// pour un titulaire, deux pour un membre delegue). Garder les droits aurait
// fait survivre un droit REVOQUE pendant la duree du cache, sur l'interface
// meme qui s'en sert pour masquer — le masquage est double d'une garde serveur,
// donc ce ne serait pas une faille, mais un ecran qui propose un geste que le
// serveur refuse. Le depot a paye ce defaut trois fois.
//
// ⚠ COMMENT CE FICHIER CHARGE LE MODULE, ET POURQUOI PAS PAR `import`.
// `shared/compte-courant.js` importe `/shared/api-client.js` par un chemin
// ABSOLU, que Node ne resout pas. On execute donc la source dans un `vm`, avec
// de faux `sessionStorage` et `api` — ce qui eprouve le VRAI code du cache, pas
// une copie.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const racine = path.join(__dirname, '..')
const SOURCE = fs.readFileSync(path.join(racine, 'shared/compte-courant.js'), 'utf8')
const SOURCE_API = fs.readFileSync(path.join(racine, 'shared/api-client.js'), 'utf8')

const MOI = '85e3a0ef-75bd-4c11-a3b7-e2811067dc36'
const AUTRE = '18920ead-f936-4e26-b62e-9a5f52b5e657'
const COMPTES = [
  { user_id: MOI, nom: 'Mon compte', titulaire: true },
  { user_id: AUTRE, nom: 'Compte partagé', titulaire: false }
]

// Un faux stockage, et un faux `api` qui COMPTE ses appels.
function harnais ({ horloge = () => Date.now(), mesComptes = null } = {}) {
  const magasin = new Map()
  const compte = { mesComptes: 0 }
  const stockage = {
    getItem: (k) => (magasin.has(k) ? magasin.get(k) : null),
    setItem: (k, v) => { magasin.set(k, String(v)) },
    removeItem: (k) => { magasin.delete(k) }
  }
  const api = {
    membres: {
      mesComptes: async () => {
        compte.mesComptes++
        if (mesComptes) return mesComptes()
        return { comptes: COMPTES }
      }
    }
  }
  const sandbox = {
    sessionStorage: stockage,
    localStorage: stockage,
    document: { documentElement: { dataset: {} } },
    window: {},
    Date: class extends Date { static now () { return horloge() } },
    JSON, console,
    api,
    logger: { info () {}, error () {}, warn () {} },
    supabase: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }) },
    IMPORT: async () => ({})
  }
  // On retire les `import`/`export` (modules ES) sans toucher au corps.
  const corps = SOURCE
    .replace(/^import[\s\S]*?from\s+'[^']*'\s*$/gm, '')
    .replace(/^export (async function|function|const|let)/gm, '$1')
    .replace(/\bimport\(/g, 'IMPORT(')
  const script = `${corps}\n;globalThis.__mod = { chargerContexte, reinitialiser, oublierCacheComptes, comptes, compteCourant }`
  vm.createContext(sandbox)
  new vm.Script(script).runInContext(sandbox)
  return { mod: sandbox.__mod, compte, magasin, stockage }
}

test('LE TEST QUI COMPTE : le second chargement ne rappelle PAS le serveur', async () => {
  const h = harnais()
  await h.mod.chargerContexte(MOI)
  assert.equal(h.compte.mesComptes, 1, 'le premier chargement lit la liste')
  // Un second chargement, comme une navigation vers un autre ecran : le module
  // est recharge, donc son cache memoire est vide — seul le stockage reste.
  h.mod.reinitialiser()
  h.magasin.set('hs.ctx.comptes', JSON.stringify({ moi: MOI, ts: Date.now(), comptes: COMPTES }))
  await h.mod.chargerContexte(MOI)
  assert.equal(h.compte.mesComptes, 1, 'le second chargement sert la liste du cache')
  assert.equal(h.mod.comptes().length, 2, 'et la liste est complete')
})

test('LE TEST QUI COMPTE : passe trois minutes, le serveur est rappele', async () => {
  let t = 1_700_000_000_000
  const h = harnais({ horloge: () => t })
  await h.mod.chargerContexte(MOI)
  assert.equal(h.compte.mesComptes, 1)
  t += 3 * 60 * 1000 + 1
  h.mod.reinitialiser()
  // ⚠ `reinitialiser` efface le cache : on le repose a la main, date de AVANT,
  // pour eprouver la BORNE et pas l'effacement.
  h.magasin.set('hs.ctx.comptes', JSON.stringify({ moi: MOI, ts: t - (3 * 60 * 1000 + 1), comptes: COMPTES }))
  await h.mod.chargerContexte(MOI)
  assert.equal(h.compte.mesComptes, 2, 'le cache a expire, la liste est relue')
})

test('LE TEST QUI COMPTE : la cle porte l UTILISATEUR, jamais la liste d un autre', async () => {
  const h = harnais()
  h.magasin.set('hs.ctx.comptes', JSON.stringify({ moi: AUTRE, ts: Date.now(), comptes: COMPTES }))
  await h.mod.chargerContexte(MOI)
  assert.equal(h.compte.mesComptes, 1,
    'une liste memorisee pour un AUTRE utilisateur ne doit jamais etre servie — ' +
    'deux personnes sur le meme poste verraient les comptes de l autre dans le selecteur')
})

test('LE TEST QUI COMPTE : la deconnexion efface le cache', async () => {
  const h = harnais()
  await h.mod.chargerContexte(MOI)
  assert.ok(h.magasin.has('hs.ctx.comptes'), 'la liste est bien gardee')
  h.mod.reinitialiser()
  assert.ok(!h.magasin.has('hs.ctx.comptes'),
    'sessionStorage meurt avec l onglet, mais une deconnexion SANS fermer l onglet ' +
    'y laisserait la liste de la personne precedente')
})

test('LE TEST QUI COMPTE : une PANNE n ecrit pas au cache', async () => {
  // Le repli de panne reduit la liste a « Mon compte ». L'ecrire figerait le
  // selecteur disparu pendant trois minutes au lieu d un chargement.
  const h = harnais({ mesComptes: () => { throw new Error('503') } })
  await h.mod.chargerContexte(MOI)
  assert.ok(!h.magasin.has('hs.ctx.comptes'),
    'une liste venue d un repli de panne ne doit JAMAIS etre gardee')
})

test('LE TEST QUI COMPTE : un 403 jette le cache, et api-client le fait', () => {
  // La fenetre de trois minutes a un filet : un acces revoque laisse la
  // personne sur un compte que le serveur refuse. Plutot qu un ecran casse
  // jusqu a expiration, le 403 jette la liste.
  const net = SOURCE_API.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
  assert.match(net, /res\.status === 403/, 'api-client doit reconnaitre un 403')
  assert.match(net, /oublierCacheComptes/, 'et jeter le cache de la liste des comptes')
  // ⚠ L'import doit etre PARESSEUX : `compte-courant` importe `api-client`,
  // donc un import en tete creerait un cycle.
  assert.ok(/import\('\/shared\/compte-courant\.js'\)/.test(net),
    'import paresseux, sinon cycle de modules')
})

// ─── Les constats de la review du 22 octobre 2026 ────────────────────────────

test('LE TEST QUI COMPTE : un ts dans le FUTUR ne rend pas le cache permanent', () => {
  // ⚠ CONSTAT DE REVIEW. `Date.now() - ts < CACHE_MS` est VRAI quand l ecart
  // est negatif : avec une horloge machine en avance, puis corrigee en arriere
  // par NTP, la liste ne reexpirait plus pour la duree de l onglet — et la
  // fenetre d un acces revoque cessait d etre bornee a trois minutes.
  const src = fs.readFileSync(path.join(racine, 'shared/compte-courant.js'), 'utf8')
  const net = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
  assert.match(net, /ecoule >= 0/, 'la borne basse doit etre explicite')
  // Et par EXECUTION, pas par lecture : un `ts` dans le futur n est pas servi.
  let t = 1_700_000_000_000
  const h = harnais({ horloge: () => t })
  h.magasin.set('hs.ctx.comptes', JSON.stringify({ moi: MOI, ts: t + 3600_000, comptes: COMPTES }))
  return h.mod.chargerContexte(MOI).then(() => {
    assert.equal(h.compte.mesComptes, 1,
      'une liste datee du futur doit etre ecartee, pas servie indefiniment')
  })
})

test('LE TEST QUI COMPTE : le filet du 403 ne mord QUE sur le refus du compte', () => {
  // ⚠ CONSTAT DE REVIEW, et il annulait le lot pour sa propre population.
  // Le depot traite certains 403 comme un etat NORMAL d un membre delegue
  // (`shared/properties.js` « un refus de droits n est pas une panne »,
  // `pages/settings.html` domaine `equipe`, `logements-liste.js`,
  // `logement-fiche.js`, `pages/menages.html`). Jeter le cache sur tout 403
  // le vidait a CHAQUE chargement de page pour un membre sans `reservations` —
  // c est-a-dire pour les comptes multiples, la seule raison d etre de l appel.
  const net = SOURCE_API.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
  assert.match(net, /res\.status === 403 && data\.error === 'Droits insuffisants sur ce compte'/,
    'le filet doit reconnaitre le refus X-Compte, pas n importe quel 403')
  // Et le libelle doit etre CELUI que pose la garde : deux chaines qui divergent
  // feraient un filet qui ne se declenche jamais.
  const garde = fs.readFileSync(path.join(racine, 'lib/require-permission.js'), 'utf8')
  assert.match(garde, /'Droits insuffisants sur ce compte'/,
    'le libelle du filet doit exister cote serveur, sinon il ne mord jamais')
})

test('LE TEST QUI COMPTE : accepter une invitation jette le cache', () => {
  // ⚠ CONSTAT DE REVIEW. « Continuer » renvoie sur l app DANS LE MEME ONGLET :
  // sans ce geste, le compte qu on vient de rejoindre serait absent du
  // selecteur pendant trois minutes — juste apres avoir lu « vous avez rejoint
  // le compte de X ». Et `membreAilleurs` de `components/auth-guard.js`, calcule
  // sur cette liste perimee, peut jeter l invite dans l onboarding en
  // consommant son forcage a un coup.
  const page = fs.readFileSync(path.join(racine, 'pages/invitation.html'), 'utf8')
  const net = page.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
  const i = net.indexOf('api.membres.accepter')
  assert.ok(i > 0, 'la page accepte bien l invitation')
  // Le geste doit suivre l acceptation, pas la preceder.
  const j = net.indexOf('oublierCacheComptes')
  assert.ok(j > i,
    'le cache de la liste des comptes doit etre jete APRES api.membres.accepter')
})
