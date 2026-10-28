// tests/accueil-rapide.test.js
// LE CHEMIN D'OUVERTURE DE L'APP : la sonde de la landing, l'epinglage du CDN,
// et les lectures qui partent ENSEMBLE.
//
// ⚠ CE QUE CE LOT A CHANGE, ET CE QUI LE CASSERAIT SANS BRUIT. La landing
// testait la session par un `<script type="module">` de FIN DE PAGE qui
// importait supabase-js : 9 requetes et 350 ms a froid pendant lesquelles un
// hote CONNECTE voyait la page commerciale. Le remplacant est un script
// SYNCHRONE en tete du <head>. Trois facons de le casser sans qu'aucun ecran
// ne change :
//   - le rendre asynchrone (`type="module"`, `defer`, un `src`) : la landing
//     repasse devant ;
//   - y coder la ref du projet en dur : la redirection marche en prod et
//     RATE EN STAGING, ou l'inverse, en silence ;
//   - partager UN SEUL `try` entre le test du fragment et la lecture du
//     stockage : quand `localStorage` leve, l'exception emporte le retour
//     d'authentification avec elle et les jetons meurent en silence ;
//   - masquer `documentElement` AVANT de naviguer : si la navigation est
//     refusee, le `catch` avale l'echec et la page reste blanche pour de bon.
// ⚠ Ce qu'il ne faut PAS croire : que retirer le `try` du stockage blanchirait
// la landing. Le seul masquage vient APRES l'acces qui leve, et une exception
// non capturee dans un script de tete laisse le parsing continuer : la landing
// s'affiche. Le vrai cout de retirer ce `try`, c'est la regression que le lot
// combat — un connecte revoit la page commerciale.
// La sonde est donc EXECUTEE ici, pas relue.
//
// Mesures et methode : docs/kb/performance.md §4.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

// Le module REEL du bloc « Derniers avis » : il est injecte dans la page
// montee par ce banc, pour que `renderDerniersAvis` soit appelable.
let AVIS = {}
test.before(async () => { AVIS = await import('../shared/avis-recents.js') })

const racine = path.join(__dirname, '..')
const lire = p => fs.readFileSync(path.join(racine, p), 'utf8')

// Les deux refs reelles (shared/config.js) : la sonde doit marcher sur les DEUX
// sans les connaitre.
const REFS = { prod: 'cjmrizpdyhrcurmgyrhs', staging: 'ortyofzzdsthlhqmzsnq' }

// ─── La sonde de index.html ──────────────────────────────────────────────────

const INDEX = lire('index.html')

function sondeDeLaLanding () {
  const tete = INDEX.slice(0, INDEX.indexOf('<style>'))
  const ouvre = tete.indexOf('<script')
  assert.notStrictEqual(ouvre, -1, 'aucun <script> avant le <style> : la sonde a disparu du <head>')
  const finBalise = tete.indexOf('>', ouvre)
  const balise = tete.slice(ouvre, finBalise + 1)
  const ferme = tete.indexOf('</script>', finBalise)
  assert.notStrictEqual(ferme, -1, '<script> du <head> non ferme avant le <style>')
  return { balise, corps: tete.slice(finBalise + 1, ferme) }
}

// ⚠ Resolue PARESSEUSEMENT. Si la sonde disparait du <head>, chaque test doit
// rougir en disant lequel — un assert au chargement du fichier fait echouer le
// module entier et n'en nomme aucun.
let _sonde = null
const SONDE = () => (_sonde || (_sonde = sondeDeLaLanding()))

// Execute la sonde avec un localStorage et un location injectes.
// `cles` = null fait lever l'acces, pour eprouver le repli.
function lancerLaSonde (cles, url = {}) {
  const vus = []
  const localStorage = cles === null
    ? { get length () { throw new Error('localStorage indisponible') }, key () { throw new Error('idem') } }
    : { get length () { return cles.length }, key: i => cles[i] }
  const location = {
    search: url.search || '',
    hash: url.hash || '',
    // `replace` peut etre REFUSE : frame sandboxee, extension, navigation de
    // haut niveau bloquee. On sait alors ce que la page montre.
    replace: u => { if (url.replaceLeve) throw new Error('navigation refusee'); vus.push(u) }
  }
  const documentElement = { style: {} }
  const document = { documentElement }
  new Function('localStorage', 'location', 'document', SONDE().corps)(localStorage, location, document)
  return { redirections: vus, masque: documentElement.style.display === 'none' }
}

test('LE TEST QUI COMPTE : la sonde est SYNCHRONE et dans le <head>, avant le <style>', () => {
  // Un module, un defer, un async ou un src la remettent apres le rendu : la
  // landing redevient visible pour un connecte, et rien d'autre ne le dit.
  assert.ok(!/type\s*=\s*["']module["']/.test(SONDE().balise), 'la sonde est devenue un module')
  assert.ok(!/\bdefer\b/.test(SONDE().balise), 'la sonde est devenue defer')
  assert.ok(!/\basync\b/.test(SONDE().balise), 'la sonde est devenue async')
  assert.ok(!/\bsrc\s*=/.test(SONDE().balise), 'la sonde est devenue un fichier externe')
})

test('LE TEST QUI COMPTE : un connecte part, sur les DEUX environnements', () => {
  for (const [nom, ref] of Object.entries(REFS)) {
    const r = lancerLaSonde([`sb-${ref}-auth-token`])
    assert.deepEqual(r.redirections, ['/pages/aujourdhui'], `${nom} : pas de depart`)
    assert.ok(r.masque, `${nom} : la landing n'est pas masquee avant le depart`)
  }
})

test('LE TEST QUI COMPTE : la ref du projet n est pas codee en dur', () => {
  // Une ref inconnue des deux environnements doit marcher aussi : c'est la
  // preuve que le motif est ancre et non une liste.
  const r = lancerLaSonde(['sb-unprojetquinexistepas-auth-token'])
  assert.deepEqual(r.redirections, ['/pages/aujourdhui'])
  for (const ref of Object.values(REFS)) {
    assert.ok(!SONDE().corps.includes(ref), `la ref ${ref} est ecrite en dur dans la sonde`)
  }
})

test('un visiteur anonyme reste sur la landing', () => {
  for (const cles of [[], ['hs.lang'], ['hs_compte_courant', 'hs_ob_forced_42'], ['sb--auth-token'], ['sb-x-auth-token-bis']]) {
    const r = lancerLaSonde(cles)
    assert.deepEqual(r.redirections, [], 'depart a tort avec ' + JSON.stringify(cles))
    assert.ok(!r.masque, 'landing masquee a tort avec ' + JSON.stringify(cles))
  }
})

test('localStorage inaccessible : la landing s affiche, elle ne blanchit pas', () => {
  const r = lancerLaSonde(null)
  assert.deepEqual(r.redirections, [])
  assert.ok(!r.masque, 'la landing est masquee alors que la sonde a echoue')
})

test("LE TEST QUI COMPTE : le retour d'authentification n'est pas perdu", () => {
  // signUp et updateUser({ email }) ne passent pas de `redirectTo` : leur lien
  // arrive sur la racine, jetons dans le FRAGMENT. Avant ce lot, le module de
  // fin de page creait un client qui les consommait. Il n'y en a plus ici : le
  // fragment doit partir vers une page qui en cree un.
  const frais = lancerLaSonde([], { hash: '#access_token=abc&refresh_token=def&type=signup' })
  assert.deepEqual(frais.redirections,
    ['/pages/aujourdhui#access_token=abc&refresh_token=def&type=signup'],
    'un retour d authentification sans session en base reste sur la landing : les jetons sont perdus')

  // Et pour qui a deja une session : le fragment part aussi.
  const connecte = lancerLaSonde([`sb-${REFS.prod}-auth-token`], { hash: '#access_token=abc&type=email_change' })
  assert.deepEqual(connecte.redirections, ['/pages/aujourdhui#access_token=abc&type=email_change'])
})

test("un fragment d'ERREUR laisse la landing, comme avant", () => {
  // ⚠ TEST DE NON-REGRESSION, et il faut le savoir en le lisant (regle 19 de
  // REVIEW.md, point 2). Il ne garde pas un correctif, il garde une DECISION :
  // ne PAS elargir le motif a `error`.
  // Compte rendu exact de la contre-epreuve, corrige le 20 octobre 2026 : contre
  // `git archive HEAD~1`, les tests de la sonde rougissent TOUS, celui-ci
  // compris — la sonde n'existe pas dans HEAD~1, l'extraction leve avant tout
  // jugement. Une version anterieure de ce commentaire annoncait « reste vert
  // contre le code d'avant » : c'etait faux, et invérifiable par le relecteur
  // suivant. Ce qui est vrai et se verifie : contre la version fautive plausible
  // (motif elargi `/[#&](access_token|refresh_token|error)=/`, celle que
  // suggerait la review), il est le SEUL a rougir.
  //
  // `#error=access_denied` n'est pas un retour exploitable : aucun jeton a
  // sauver, et rien ne justifie d'envoyer un visiteur sans session vers /login.
  // C'est aussi ce que faisait l'ancien module de fin de page : le client se
  // creait, `_getSessionFromURL` levait, aucune redirection.
  const r = lancerLaSonde([], { hash: '#error=access_denied&error_description=expired' })
  assert.deepEqual(r.redirections, [])
  assert.ok(!r.masque)
})

test("mais un CONNECTE avec un fragment d'erreur part quand meme, fragment compris", () => {
  // ⚠ LA DECISION CI-DESSUS NE VAUT QUE POUR UN VISITEUR SANS SESSION. Des
  // qu'une cle de session existe, c'est elle qui fait partir, et `hash` voyage
  // avec le reste — exactement comme le faisait `pages/index.html`, qui
  // concatenait `location.hash` sans le lire. Le fragment d'erreur n'est pas
  // filtre : il ne declenche rien a lui seul, et le filtrer couterait une regle
  // de plus sur le chemin le plus chaud du site.
  // Ce test existe parce que le commentaire de la sonde a dit l'inverse pendant
  // une journee : la decision ecrite doit etre celle que le code applique.
  const r = lancerLaSonde([`sb-${REFS.prod}-auth-token`],
    { hash: '#error=access_denied&error_code=otp_expired' })
  assert.deepEqual(r.redirections, ['/pages/aujourdhui#error=access_denied&error_code=otp_expired'])
})

test("LE TEST QUI COMPTE : localStorage qui LEVE ne fait pas perdre le retour d'authentification", () => {
  // ⚠ LE CONSTAT LE PLUS CHER DE LA REVUE DU 20 OCTOBRE 2026. Les deux calculs
  // partageaient un seul `try` : quand `localStorage` levait — cookies de site
  // bloques, navigation privee, webview, iframe sans allow-same-origin —
  // l'exception emportait le fragment avec elle. Un hote qui confirmait son
  // inscription ou son changement d'e-mail voyait la landing, ses jetons tout
  // juste emis morts en silence, et PLUS AUCUNE page pour les consommer : ce lot
  // a supprime le module de fin de page qui le faisait.
  const r = lancerLaSonde(null, { hash: '#access_token=abc&refresh_token=def&type=signup' })
  assert.deepEqual(r.redirections,
    ['/pages/aujourdhui#access_token=abc&refresh_token=def&type=signup'],
    'le fragment d authentification meurt avec l exception de localStorage')
})

test("LE TEST QUI COMPTE : une navigation REFUSEE laisse la landing visible", () => {
  // Masquer puis naviguer : si la navigation levait, le catch avalait l'echec
  // et la page restait BLANCHE — definitivement, et reproductible a chaque
  // rechargement puisque la cle de session est toujours la. On navigue donc
  // d'abord, on masque ensuite.
  const r = lancerLaSonde([`sb-${REFS.prod}-auth-token`], { replaceLeve: true })
  assert.ok(!r.masque, 'la landing reste masquee alors que la navigation a ete refusee : page blanche')
})

test("LE TEST QUI COMPTE : search et hash sont EMPORTES", () => {
  // `pages/index.html`, la page que cette sonde court-circuite, fait
  // `location.replace('/pages/aujourdhui' + location.search + location.hash)`.
  // C'est ici la derniere occasion de les transmettre.
  const r = lancerLaSonde([`sb-${REFS.prod}-auth-token`], { search: '?bien=42&utm_source=x', hash: '#bas' })
  assert.deepEqual(r.redirections, ['/pages/aujourdhui?bien=42&utm_source=x#bas'])
})

test('la landing ne charge plus supabase-js', () => {
  assert.ok(!INDEX.includes('/shared/supabase.js'),
    'index.html importe de nouveau supabase-js : les 9 requetes du chemin d ouverture sont revenues')
})

test('la landing vise la destination FINALE, pas une redirection de plus', () => {
  assert.ok(!SONDE().corps.includes('/pages/index.html'),
    '/pages/index.html redirige lui-meme vers /pages/aujourdhui : une navigation pour rien')
})

// ─── L'epinglage du CDN ──────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : supabase-js est epingle sur une version', () => {
  // Sans version, jsdelivr sert la derniere : le front change de bibliotheque
  // sans aucun commit, le jour de la publication. Dette 70.
  const src = lire('shared/supabase.js')
  const m = src.match(/@supabase\/supabase-js(@[^/'"]*)?\/\+esm/)
  assert.ok(m, 'shared/supabase.js ne charge plus supabase-js depuis le CDN')
  assert.match(m[1] || '', /^@\d+\.\d+\.\d+$/,
    'la version de supabase-js n est pas epinglee : ' + JSON.stringify(m[0]))
})

test('LE TEST QUI COMPTE : le prechargement vise la version EPINGLEE', () => {
  // La landing ne rechauffe plus jsdelivr pour personne : /pages/aujourdhui paie
  // le cout a froid, et ne decouvrait l'URL qu'apres avoir lu shared/supabase.js.
  // Le `modulepreload` la demande des le <head> — mais une URL qui s'ecarte de
  // celle du module, c'est DEUX telechargements de supabase-js au lieu d'un.
  const src = lire('shared/supabase.js')
  const voulue = src.match(/https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@[^'"]+/)
  assert.ok(voulue, 'shared/supabase.js ne charge plus supabase-js depuis jsdelivr')
  const page = lire('pages/aujourdhui.html')
  const pre = page.match(/<link[^>]*rel="modulepreload"[^>]*>/)
  assert.ok(pre, 'pages/aujourdhui.html ne precharge plus supabase-js : le CDN repart a froid, en serie')
  assert.ok(pre[0].includes(voulue[0]),
    'le prechargement et shared/supabase.js ne visent pas la meme version : ' + pre[0])
  assert.ok(pre[0].includes('crossorigin'),
    'sans crossorigin, le prechargement est ignore pour un module et la requete est faite deux fois')
  assert.ok(/<link rel="preconnect" href="https:\/\/cdn\.jsdelivr\.net"/.test(page),
    'plus de preconnexion a jsdelivr : la poignee de main DNS/TLS reste sur le chemin critique')
})

// ⚠ LE FICHIER, PAS LA FORME DE L'URL. Ces deux tests comparaient l'URL avec
// `endsWith('langues.json')`. Le lot (a) de la spec performance y a ajoute une
// version (`?v=<empreinte>`) pour pouvoir cacher les dictionnaires un an : les
// deux tests ont rougi sans qu'aucune regle n'ait bouge. Ils figeaient le
// REMEDE — la forme exacte de l'URL — au lieu de la PROPRIETE qu'ils gardent :
// que les deux lectures partent ensemble, et qu'une erreur soit nommee. On
// reconnait donc le fichier demande, quelle que soit sa chaine de requete.
const estLeFichier = (url, nom) =>
  new RegExp(`/${nom.replace('.', '\\.')}(\\?|$)`).test(String(url))

// ─── Les lectures qui partent ensemble ───────────────────────────────────────

test('LE TEST QUI COMPTE : i18n demande la liste et le repli EN MEME TEMPS', async () => {
  // Preuve par l'execution : `langues.json` ne repond qu'une fois `fr.json`
  // demande. En file, on n'arriverait jamais a la seconde demande.
  const src = lire('shared/i18n/i18n.js')
  const demandes = []
  let repondreLangues
  const rep = corps => ({ ok: true, json: async () => corps })
  const fetchFaux = url => {
    demandes.push(String(url))
    if (estLeFichier(url, 'langues.json')) {
      return new Promise(r => { repondreLangues = () => r(rep([{ code: 'fr', dir: 'ltr' }])) })
    }
    return Promise.resolve(rep({ 'today.greeting': 'Bonjour {name}' }))
  }
  const faux = {
    documentElement: { dataset: {}, style: {} },
    querySelectorAll: () => [],
    dispatchEvent: () => {},
    addEventListener: () => {}
  }
  const fenetre = {}
  new Function('window', 'document', 'navigator', 'localStorage', 'fetch', 'console',
    src)(fenetre, faux, { language: 'fr' }, { getItem: () => null, setItem: () => {} }, fetchFaux, console)

  const promesse = fenetre.I18n.init()
  // Quelques tours de boucle : assez pour qu'une version SERIALISEE n'ait
  // toujours demande que le premier fichier.
  for (let i = 0; i < 20; i++) await Promise.resolve()

  assert.ok(demandes.some(u => estLeFichier(u, 'langues.json')), 'langues.json jamais demande')
  assert.ok(demandes.some(u => estLeFichier(u, 'fr.json')),
    'fr.json attend la reponse de langues.json : les deux lectures sont en file')

  repondreLangues()
  assert.strictEqual(await promesse, 'fr')
})

// ─── requireAuth, EXECUTE ────────────────────────────────────────────────────
//
// ⚠ POURQUOI PAR EXECUTION, ET PLUS PAR LECTURE DU SOURCE. Jusqu'au 20 octobre
// 2026, les deux garde-fous de cette section comparaient des expressions
// regulieres au TEXTE de auth-guard.js et de aujourdhui.html. Mesure faite sur
// des copies extraites par `git archive` : deplacer la construction de
// `pOnboarding` APRES `await pContexte` — une vraie re-serialisation — les
// laissait VERTS, pendant qu'un simple renommage `pContexte` -> `pCtx` les
// faisait rougir. Ils gardaient l'orthographe du lot, pas son effet.
// REVIEW.md regle 20 : appeler, pas lire.

// Le module est execute hors navigateur : on retire ses `import` et on injecte
// leurs symboles. Rien d'autre n'est reecrit — c'est le code de la page.
function batirRequireAuth () {
  const src = lire('components/auth-guard.js')
    .replace(/^import[\s\S]*?from\s+'[^']*'\s*$/gm, '')
    .replace(/^export\s+/gm, '')
  return src + '\n;return { requireAuth }'
}

function faireStockage () {
  const m = new Map()
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k)
  }
}

// `branchements.contexte` et `.onboarding` sont les deux promesses que le test
// pilote. `appels` enregistre QUAND chaque lecture part.
// La fenetre du banc. ⚠ `matchMedia` rend un objet COMPLET — `matches`,
// `addEventListener` et `removeEventListener` — parce que la page s'abonne au
// franchissement du seuil. Un objet qui n'aurait que `matches` ferait lever
// l'abonnement, donc le meme defaut un cran plus loin.
function fenetreDuBanc (options = {}) {
  const etroit = options.etroit === true
  // ⚠ UN `IntersectionObserver` QUI RETIENT SON RAPPEL ET SA CIBLE. Sans lui,
  // la page sort tout de suite (`typeof window.IntersectionObserver !==
  // 'function'`) et le chargement au defilement n'est atteignable par AUCUN
  // test. `options.observateurs` est la liste que le test declenche ensuite :
  // c'est elle qui joue le geste de l'hote.
  const observateurs = options.observateurs
  // ⚠ LA FENETRE N'AVAIT AUCUNE PLOMBERIE D'EVENEMENTS, et la page en a besoin :
  // elle n'observe la sentinelle qu'au PREMIER DEFILEMENT (mesure au banc reel :
  // sans ca, la sentinelle intersecte des le chargement a 1280x900, donc un
  // troisieme appel au chargement). `options.ecouteurs` garde ce qui a ete
  // enregistre, et le test joue le geste.
  const ecouteurs = options.ecouteurs
  return {
    addEventListener (type, fn, reglages) {
      if (Array.isArray(ecouteurs)) ecouteurs.push({ type: String(type), fn, reglages: reglages || {} })
    },
    removeEventListener () {},
    IntersectionObserver: options.sansObservateur === true ? undefined : class {
      constructor (rappel, reglages) {
        this.rappel = rappel
        this.reglages = reglages || {}
        this.cibles = []
        this.coupe = false
        if (Array.isArray(observateurs)) observateurs.push(this)
      }
      observe (n) { this.cibles.push(n) }
      unobserve (n) { this.cibles = this.cibles.filter(x => x !== n) }
      disconnect () { this.coupe = true; this.cibles = [] }
      // Le geste : « la sentinelle entre dans la fenetre ».
      declencher () {
        return this.rappel(this.cibles.map(c => ({ isIntersecting: true, target: c })), this)
      }
    },
    matchMedia: (requete) => ({
      media: String(requete),
      matches: etroit && /max-width/.test(String(requete)),
      addEventListener: () => {},
      removeEventListener: () => {}
    })
  }
}

function lancerRequireAuth (branchements, options = {}) {
  const appels = []
  const redirections = []
  const journal = []
  const window = {
    location: {
      pathname: options.pathname || '/pages/aujourdhui',
      replace: u => redirections.push(u)
    }
  }
  const chaine = {
    select: () => chaine,
    eq: () => chaine,
    maybeSingle: () => branchements.onboarding,
    insert: () => { appels.push('onboarding:insert'); return Promise.resolve({ error: null }) }
  }
  const supabase = {
    from: (table) => {
      appels.push('from:' + table)
      if (table === 'onboarding_state' && !appels.includes('onboarding:lance')) {
        appels.push('onboarding:lance')
      }
      return chaine
    }
  }
  const getSession = async () => {
    if (options.getSessionLeve) throw new Error('lecture de session impossible')
    return options.session === undefined ? { user: { id: 'u1' } } : options.session
  }
  // Stockage qui leve : la meme configuration de navigateur que pour la sonde.
  const leve = () => { throw new Error('SecurityError: acces au stockage refuse') }
  const stockageMort = { getItem: leve, setItem: leve, removeItem: leve }
  const chargerContexte = () => { appels.push('contexte:lance'); return branchements.contexte }
  const console_ = { error: (...a) => journal.push(a.map(String).join(' ')), warn: () => {}, log: () => {} }

  const sorti = new Function(
    'supabase', 'getSession', 'chargerContexte', 'reinitialiser',
    'window', 'sessionStorage', 'localStorage', 'console',
    batirRequireAuth()
  )(supabase, getSession, chargerContexte, () => {},
    window,
    options.sessionStorageLeve ? stockageMort : faireStockage(),
    options.localStorage || faireStockage(),
    console_)

  return { appels, redirections, journal, promesse: sorti.requireAuth() }
}

const tours = async (n = 30) => { for (let i = 0; i < n; i++) await Promise.resolve() }

test("i18n : une langues.json en erreur est NOMMEE, pas parsee", async () => {
  // Sans le controle `r.ok`, un 404 renvoie la page d'erreur HTML au parseur
  // JSON : l'hote lit « Unexpected token < » au lieu du fichier manquant.
  // `load()` portait deja cette garde ; la lecture en ligne de langues.json, non.
  const src = lire('shared/i18n/i18n.js')
  const fetchFaux = url => Promise.resolve(estLeFichier(url, 'langues.json')
    ? { ok: false, status: 404, json: async () => { throw new SyntaxError('Unexpected token <') } }
    : { ok: true, json: async () => ({}) })
  const faux = {
    documentElement: { dataset: {}, style: {} },
    querySelectorAll: () => [], dispatchEvent: () => {}, addEventListener: () => {}
  }
  const fenetre = {}
  new Function('window', 'document', 'navigator', 'localStorage', 'fetch', 'console',
    src)(fenetre, faux, { language: 'fr' }, { getItem: () => null, setItem: () => {} }, fetchFaux, console)
  await assert.rejects(fenetre.I18n.init(), /langues\.json introuvable/)
})

test('LE TEST QUI COMPTE : requireAuth lance ses DEUX lectures avant que l une reponde', async () => {
  // Preuve par l'execution : `onboarding_state` est demande alors que
  // `chargerContexte` n'a toujours pas repondu. En file, on n'y arriverait pas.
  let resoudreContexte, resoudreOnboarding
  const r = lancerRequireAuth({
    contexte: new Promise(res => { resoudreContexte = res }),
    onboarding: new Promise(res => { resoudreOnboarding = res })
  })
  await tours()
  assert.ok(r.appels.includes('contexte:lance'), 'chargerContexte n est jamais appele')
  assert.ok(r.appels.includes('onboarding:lance'),
    'onboarding_state attend la reponse de chargerContexte : les deux lectures sont de nouveau en file')
  resoudreContexte({ comptes: [{ user_id: 'u1' }] })
  resoudreOnboarding({ data: { current_step: 3, completed: true }, error: null })
  assert.ok(await r.promesse, 'requireAuth ne rend pas la session')
})

test('LE TEST QUI COMPTE : la DECISION d onboarding attend les deux resultats', async () => {
  // ⚠ TEST DE NON-REGRESSION (regle 19 de REVIEW.md, point 2) : avec ce lui-ci
  // et « premier login », ce sont les deux seuls de ce fichier qui restent VERTS
  // contre `git archive origin/main`. C'est leur role : avant le lot les deux
  // lectures etaient EN FILE, donc la decision attendait les deux a fortiori.
  // Ils gardent l'invariant que la parallelisation ne devait pas casser.
  //
  // Paralleliser des lectures n'autorise pas a paralleliser des decisions.
  // L'etat d'onboarding (« jamais commence ») repond tout de suite ; c'est le
  // CONTEXTE, plus lent, qui dit que cet hote est membre d'un AUTRE compte et
  // n'a donc rien a faire dans « connectez votre logement ». Si la decision se
  // prenait sans l'attendre, il y partirait.
  let resoudreContexte
  const r = lancerRequireAuth({
    contexte: new Promise(res => { resoudreContexte = res }),
    onboarding: Promise.resolve({ data: { current_step: 0, completed: false }, error: null })
  })
  await tours()
  assert.deepEqual(r.redirections, [],
    'la redirection d onboarding est partie avant de savoir si l hote est membre d un autre compte')
  resoudreContexte({ comptes: [{ user_id: 'u1' }, { user_id: 'u2' }] })
  await r.promesse
  assert.deepEqual(r.redirections, [], 'un membre invite ailleurs est envoye dans l assistant')
})

test('premier login : l assistant est force une fois (le cas nominal tient)', async () => {
  // ⚠ TEST DE NON-REGRESSION, vert contre origin/main comme contre 5655e78 : il
  // existe pour que le durcissement d'`etatConnu` juste en dessous ne se paie
  // pas en supprimant le forcage pour tout le monde.
  const r = lancerRequireAuth({
    contexte: Promise.resolve({ comptes: [{ user_id: 'u1' }] }),
    onboarding: Promise.resolve({ data: null, error: null })
  })
  assert.strictEqual(await r.promesse, null)
  assert.deepEqual(r.redirections, ['/pages/onboarding.html'])
  assert.ok(r.appels.includes('onboarding:insert'), 'la ligne onboarding_state n est plus creee au 1er login')
})

test('LE TEST QUI COMPTE : une lecture onboarding en ECHEC ne force pas l assistant', async () => {
  // Un builder PostgREST ne REJETTE pas : sans `.throwOnError()`, un 503, un
  // refus RLS ou un navigateur hors ligne RESOLVENT en
  // `{ data: null, error, status: 0 }`. Lire `data` seul rendait la panne
  // indistinguable de « pas de ligne » : un hote qui a fini son onboarding il y
  // a des mois, sur un appareil neuf (donc sans la garde localStorage), etait
  // jete dans l'assistant par un incident passager.
  const r = lancerRequireAuth({
    contexte: Promise.resolve({ comptes: [{ user_id: 'u1' }] }),
    onboarding: Promise.resolve({ data: null, error: { message: 'service unavailable' }, status: 503 })
  })
  assert.ok(await r.promesse, 'requireAuth doit laisser entrer : la panne n est pas un refus d authentification')
  assert.deepEqual(r.redirections, [],
    'une lecture d onboarding_state en echec vaut « jamais commence » : l hote est renvoye dans l assistant')
  assert.ok(!r.appels.includes('onboarding:insert'), 'un INSERT aveugle part sur une lecture en echec')
})

test('une raison de rejet FALSY est un echec, pas un succes', async () => {
  // `.then(ok, e => ({ e }))` capture n'importe quelle raison, `undefined`
  // comprise. Teste par la VERACITE (`if (r.e)`), elle prenait le chemin du
  // succes avec des donnees `undefined` — ce que le try/catch remplace par ce
  // lot ne pouvait pas faire.
  const r = lancerRequireAuth({
    contexte: Promise.reject(undefined),
    onboarding: Promise.resolve({ data: { current_step: 3, completed: true }, error: null })
  })
  await r.promesse
  assert.ok(r.journal.some(l => l.includes('contexte de compte indisponible')),
    'un rejet falsy du contexte de compte passe pour un succes, en silence')
})

test('une construction de requete qui LEVE ne fait pas rejeter requireAuth', async () => {
  // Les appelants font tous `const session = await requireAuth()` sans catch :
  // un throw synchrone a la construction laissait la page sur son ecran de
  // chargement, sans meme renvoyer vers /login.
  const r = lancerRequireAuth({
    contexte: Promise.resolve({ comptes: [{ user_id: 'u1' }] }),
    get onboarding () { throw new Error('client en mauvais etat') }
  })
  assert.ok(await r.promesse, 'requireAuth rejette au lieu de laisser entrer avec un etat inconnu')
  assert.deepEqual(r.redirections, [])
})

test("LE TEST QUI COMPTE : sessionStorage qui LEVE ne fait pas rejeter requireAuth", async () => {
  // ⚠ C'EST LA MEME CONFIGURATION DE NAVIGATEUR QUE CELLE DE LA SONDE — donnees
  // de site bloquees, iframe sans allow-same-origin, webview : `localStorage` ET
  // `sessionStorage` levent tous les deux. Depuis ce lot, l'hote qui confirme
  // son inscription dans cette configuration est AIGUILLE ICI par la sonde.
  // Hors garde, les quatre acces au cache faisaient rejeter `requireAuth`, que
  // personne n'attrape : squelette de page indefini, pas meme un /login.
  const r = lancerRequireAuth({
    contexte: Promise.resolve({ comptes: [{ user_id: 'u1' }] }),
    onboarding: Promise.resolve({ data: { current_step: 3, completed: true }, error: null })
  }, { sessionStorageLeve: true })
  const session = await r.promesse
  assert.ok(session, 'requireAuth rejette quand le cache de session est inaccessible')
  assert.deepEqual(r.redirections, [], 'un stockage inaccessible ne doit pas deplacer l hote')
})

test("une lecture de session impossible renvoie vers /login, elle ne rejette pas", async () => {
  const r = lancerRequireAuth({ contexte: Promise.resolve({}), onboarding: Promise.resolve({ data: null, error: null }) },
    { getSessionLeve: true })
  assert.strictEqual(await r.promesse, null)
  assert.deepEqual(r.redirections, ['/pages/login.html'],
    'une session illisible laisse la page sur son squelette au lieu de renvoyer vers /login')
})

// ─── L'ouverture d'Aujourd'hui, EXECUTEE ─────────────────────────────────────

// Le module de la page, prive de ses `import`, avec ses dependances injectees.
// ⚠ LE BANC INJECTAIT `String` A LA PLACE DE `esc`, ET DONC AUCUN TEST
// D'ECHAPPEMENT N'Y ETAIT VALABLE : `String('<img>')` rend `<img>`. Un double
// PLUS PERMISSIF que le vrai valide du code qui ne peut pas tourner — c'est la
// lecon deja payee sur `CacheEcran` et sur le module de courbe.
//
// ⚠ ET ON NE PEUT PAS LE `require` : `shared/properties.js` importe
// `/shared/api-client.js` en chemin ABSOLU de navigateur, que Node ne resout
// pas (`ERR_MODULE_NOT_FOUND`). On prend donc sa SOURCE, exactement comme ce
// banc prend celle de la page — pas une reecriture.
function escapeHtmlReel () {
  const src = lire('shared/properties.js')
  const i = src.indexOf('export function escapeHtml')
  assert.notStrictEqual(i, -1, 'escapeHtml a disparu de shared/properties.js')
  const fin = src.indexOf('\n}', i)
  assert.notStrictEqual(fin, -1, 'la forme de escapeHtml a change : le decoupage ne tient plus')
  const corps = src.slice(i, fin + 2).replace('export function', 'function')
  // eslint-disable-next-line no-new-func
  const f = new Function(`${corps}; return escapeHtml`)()
  assert.strictEqual(f('<i>'), '&lt;i&gt;', 'le escapeHtml extrait n echappe pas : extraction ratee')
  return f
}
const ESC = escapeHtmlReel()

function batirAujourdhui (sansInit = false) {
  const html = lire('pages/aujourdhui.html')
  const ouvre = html.indexOf('<script type="module">')
  assert.notStrictEqual(ouvre, -1, 'pages/aujourdhui.html n a plus de module')
  const corps = html.slice(html.indexOf('>', ouvre) + 1, html.indexOf('</script>', ouvre))
  const depart = corps.indexOf('initErrorHandler()')
  assert.notStrictEqual(depart, -1, 'initErrorHandler() a disparu : le decoupage des imports ne tient plus')
  // ⚠ On rend aussi la poignee sur les internes : `chargerNotes` et `etat` sont
  // des declarations de haut niveau du module, et les eprouver DIRECTEMENT evite
  // de faire traverser a `init()` les cinq chargeurs qui n'ont rien a voir.
  const corpsUtile = sansInit
    // ⚠ ON RETIRE LE DEMARRAGE. `init().catch(...)` est la derniere ligne du
    // module : construire celui-ci le LANCE. L'assertion « un seul appel a
    // /api/avis » n'etait alors vraie que parce que `init()` restait coince sur
    // `await requireAuth()` — un accident, que rien dans le test ne disait.
    // Pour eprouver une fonction isolee, on n'allume pas la page entiere.
    ? corps.slice(depart).replace(/\n\s*init\(\)\.catch\([^\n]*\)\s*$/, '\n')
    : corps.slice(depart)
  if (sansInit) {
    assert.ok(!/\binit\(\)\.catch\(/.test(corpsUtile),
      "le demarrage `init().catch(...)` n'a pas pu etre retire : sa forme a change")
  }
  // ⚠ LES FONCTIONS DE RENDU SORTENT, ET C'EST LA LECON DE LA REVUE DE
  // L'ETAPE 1. Quatre garde-fous retarges mesuraient une POSITION DANS LE
  // TEXTE de la page (« le compte s'ecrit apres la garde », « l'etat vide cite
  // `listeLue` ») : six mutations du code de production sur onze les laissaient
  // verts, dont deux qui rejouent un incident deja vecu sur cet ecran — « A
  // valider · Rien a valider » sur une lecture ratee, et « Ajoutez votre
  // premier logement » a un hote qui en a quatre. Un test qui lit du texte ne
  // dit rien de l'execution (REVIEW.md regle 20) ; celui de la date, lui,
  // APPELLE, et sa mutation rougit. On rend donc les deux rendus appelables.
  return corpsUtile + '\n;return { chargerNotes, etat, chargerDerniersAvis, renderTaches, renderRevenus, renderDerniersAvis, chargerEcran, repartirEnEuros, renderAnnee, renderEvenements }'
}

function ouvrirAujourdhui (options = {}) {
  const lectures = []
  // `fetch` enregistre CE QUI EST DEMANDE : c'est la mesure du lot 2.
  const urls = []
  const fetchFaux = (url) => {
    urls.push(String(url))
    if (options.fetchLeve) return Promise.reject(new Error('reseau'))
    const statut = options.statut || 200
    return Promise.resolve({
      ok: statut >= 200 && statut < 300,
      status: statut,
      // Un corps illisible : c'est `appel()` qui le transforme en `{}`.
      // ⚠ LE CORPS PEUT DEPENDRE DE L'URL. Un corps unique ne sait pas rendre
      // deux PAGES differentes : la pagination au defilement demande la suite,
      // et un double qui redonne la premiere page la ferait boucler.
      json: async () => {
        if (options.corpsIllisible) throw new SyntaxError('<')
        return (typeof options.corps === 'function'
          ? options.corps(String(url))
          : options.corps) || {}
      }
    })
  }
  const stubs = new Map()
  const elem = () => ({
    hidden: false, textContent: '', value: '', style: {}, dataset: {},
    // ⚠ ECRIRE `innerHTML` **DETACHE** LES ENFANTS, comme dans un vrai DOM.
    // C'etait la derniere permissivite du banc, et elle cachait la moitie du
    // constat GRAVE du 29 octobre 2026 : apres `zone.innerHTML = …`, la
    // sentinelle du rendu PRECEDENT gardait son `parentNode`, donc la garde
    // `marque.parentNode` ne pouvait pas mordre et la mutation qui la retirait
    // restait verte. Un double plus permissif que le vrai VALIDE du code qui ne
    // peut pas tourner.
    _html: '',
    get innerHTML () { return this._html },
    set innerHTML (v) {
      for (const n of this.enfants) n.parentNode = null
      this.enfants = []
      this._html = String(v)
    },
    // ⚠ UNE `classList` QUI RETIENT CE QU'ON LUI DIT. Elle etait faite de
    // quatre fonctions vides et d'un `contains` qui rendait toujours `false` :
    // aucune assertion ne pouvait juger une classe, donc aucune bascule de
    // classe n'etait mesurable — et ce fichier le notait lui-meme plus bas
    // (« le noeud du banc n'a pas de classList reelle »). Meme famille que le
    // double d'`I18n.t` qui jetait ses parametres.
    // `className` reste la source : la liste la lit et l'ecrit, pour qu'une
    // affectation directe (`n.className = '…'`) et un `toggle` parlent du meme
    // etat.
    get classList () {
      const n = this
      const lire = () => String(n.className || '').split(/\s+/).filter(Boolean)
      const ecrire = (l) => { n.className = l.join(' ') }
      return {
        add (...c) { const l = lire(); for (const x of c) if (!l.includes(x)) l.push(x); ecrire(l) },
        remove (...c) { ecrire(lire().filter(x => !c.includes(x))) },
        toggle (c, force) {
          const a = force === undefined ? !lire().includes(c) : !!force
          return a ? (this.add(c), true) : (this.remove(c), false)
        },
        contains: (c) => lire().includes(c)
      }
    },
    addEventListener () {}, removeAttribute () {}, remove () {},
    // ⚠ UN NOEUD CREE QUI SE DECLARE DEVIENT TROUVABLE. Le banc cle ses
    // doubles sur la CHAINE du selecteur ; un noeud fabrique par
    // `document.createElement` n'y etait donc pas, et `cache('[data-bind="…"]')`
    // rendait un stub VIDE au lieu du noeud fabrique — une assertion qui lisait
    // le vide et le prenait pour « rien n'a ete ajoute ». On enregistre le
    // noeud sous son selecteur, comme un vrai DOM le rend trouvable des qu'il
    // est attache.
    // ⚠ `setAttribute` RANGE, IL N'ATTACHE PAS. Il remplissait la table des
    // selecteurs, donc un noeud non attache y etait trouvable (voir
    // `appendChild`). Et il n'ecrit dans `dataset` que pour les attributs
    // `data-*` : un vrai DOM ne met pas `aria-pressed` dans `dataset`.
    setAttribute (nom, val) {
      if (/^data-/.test(String(nom))) this.dataset[String(nom).slice(5)] = val
    },
    // ⚠ CES TROIS-LA RETIENNENT, au lieu de ne rien faire. `appendChild` et
    // `insertAdjacentHTML` etaient des fonctions vides : une page qui AJOUTE
    // des cartes (la suite des avis au defilement) n'ecrivait donc nulle part,
    // et aucune assertion ne pouvait juger ce qu'elle avait ajoute. Meme
    // famille que la `classList` muette et que le double d'`I18n.t` qui jetait
    // ses parametres.
    enfants: [],
    avant: '',
    parentNode: null,
    // ⚠ `appendChild` ATTACHE POUR DE VRAI : il pose `parentNode` **et** c'est
    // LUI qui rend le noeud trouvable par son selecteur. Constat de la review
    // du 29 octobre 2026 : quand c'etait `setAttribute` qui l'enregistrait, un
    // noeud JAMAIS attache restait trouvable — le banc validait donc une page
    // dont la sentinelle n'entrait pas dans le document, et la mutation qui
    // retirait l'`appendChild` restait VERTE alors qu'elle rendait la fonction
    // entierement morte en navigateur. Un double plus permissif que le vrai
    // VALIDE du code qui ne peut pas tourner.
    appendChild (n) {
      this.enfants.push(n)
      n.parentNode = this
      const cle = n.dataset && n.dataset.bind
      if (cle) stubs.set(`[data-bind="${cle}"]`, n)
      return n
    },
    // ⚠ `beforebegin` EXIGE UN PARENT, comme dans un navigateur : sur un noeud
    // detache, un vrai DOM LEVE une `DOMException`. Le double l'acceptait, et
    // c'est ce qui cachait le constat GRAVE du second rendu.
    insertAdjacentHTML (ou, html) {
      if (String(ou) === 'beforebegin') {
        if (!this.parentNode) {
          throw new Error("insertAdjacentHTML('beforebegin') sur un noeud sans parent")
        }
        this.avant += String(html)
      } else this.innerHTML += String(html)
    },
    closest: () => null, querySelector: () => null, querySelectorAll: () => []
  })
  const document_ = {
    documentElement: elem(),
    body: elem(),
    querySelector: sel => (stubs.has(sel) ? stubs.get(sel) : (stubs.set(sel, elem()), stubs.get(sel))),
    querySelectorAll: () => [],
    addEventListener () {}, createElement: () => elem()
  }
  // Chaque `.from(table)` cree une lecture que le test resout quand il veut.
  const supabase = {
    // `appel()` lit la session pour poser l'en-tete Authorization.
    auth: { getSession: async () => ({ data: { session: { access_token: 'jeton' } } }) },
    from: (table) => {
      let resoudre
      const p = new Promise(res => { resoudre = res })
      lectures.push({ table, resoudre })
      const chaine = new Proxy({}, {
        get (_, prop) {
          if (prop === 'then') return p.then.bind(p)
          if (prop === 'catch') return p.catch.bind(p)
          if (prop === 'finally') return p.finally.bind(p)
          return () => chaine
        }
      })
      return chaine
    }
  }
  let resoudreSession, resoudreI18n
  const requireAuth = () => new Promise(res => { resoudreSession = res })
  const I18n = {
    appels: 0,
    init () { this.appels++; return new Promise(res => { resoudreI18n = res }) },
    // ⚠ `date` REND QUELQUE CHOSE. Elle rendait '' : la date du titre, posee a
    // l'etape 1, s'ecrivait donc vide, et aucun test ne pouvait distinguer
    // « affichee » de « pas encore ». Un double qui rend du vide ne mesure rien.
    // ⚠ `money` REND LE NOMBRE, ET PLUS LA CHAINE VIDE. Ce fichier nommait
    // lui-meme l'angle mort : « un test qui aurait compare le texte a 0,00 €
    // serait vert dans les deux cas ». Tant que le double rendait `''`, aucune
    // assertion ne pouvait juger un MONTANT — et la recette du 27 octobre 2026
    // a trouve a l'oeil ce qu'aucun test ne pouvait voir : des lignes qui
    // sommaient a 936 sous un bandeau disant 935.
    // On rend le nombre NU plutot qu'un montant formate : le format appartient
    // a `Intl`, qu'on ne teste pas ici, et un nombre s'additionne.
    t: (k, p) => (p ? `${k}{${Object.entries(p).map(([a2, b2]) => `${a2}=${b2}`).join(',')}}` : k), date: () => 'LE-JOUR', time: () => '', pct: () => '',
    money: (n) => String(n),
    apply () {},
    // Formate reellement : sans cela, rien ne peut asserter la note affichee.
    num: (n) => String(n),
    lang: 'fr', langues: []
  }
  const rien = () => {}
  // `shared/aujourdhui.js` : des fonctions pures, dont on n'a besoin ici que de
  // la FORME de retour. `etatDesBiens` rend une Map, que `renderBiens` interroge.
  // ⚠ `noteSur5` A ETE RETIREE DE `shared/aujourdhui.js` LE 20 OCTOBRE 2026 :
  // l'endpoint descend `note_sur_5`, deja ramenee sur 5 et arrondie UNE SEULE
  // fois (lib/avis/echelle.js). Une page qui rediviserait arrondirait deux fois
  // — Colomiers affichait 4,8 pour un calcul juste a 4,7. Le double LEVE donc
  // si la page y touche : c'est la seule facon de voir revenir une division.
  const R = new Proxy({}, { get: (_, cle) => {
    if (cle === 'noteSur5') {
      throw new Error('pages/aujourdhui.html appelle R.noteSur5 : la note descend DEJA sur 5, '
        + 'la rediviser arrondit deux fois (lib/avis/echelle.js)')
    }
    // ⚠ `jourParis` REND UN JOUR, PAS UNE LISTE. Le double rendait `[]` pour
    // toute clé inconnue : `etat.aujourdHui` valait `[]`, et la date du titre —
    // posée à l'étape 1, donc AVANT la première lecture — levait
    // « jour.split is not a function », silencieusement avalé par le
    // `init().catch`. Un double qui rend la mauvaise FORME ne fait pas échouer
    // le test qu'il sert : il le fait échouer ailleurs, et plus tard.
    // Date FIGÉE, parce que le double INJECTE le temps (règle du dépôt).
    if (cle === 'jourParis') return () => '2026-10-24'
    // ⚠ `tachesOuvertes` LAISSE PASSER SA LISTE, au lieu de rendre `[]`. La
    // REGLE de filtrage (sejours a venir ou en cours) a ses propres tests dans
    // `tests/aujourdhui.test.js` ; ici c'est le RENDU qu'on juge, et un double
    // qui vide la liste rend tout compte indistinguable de zero.
    if (cle === 'tachesOuvertes') return (t) => (Array.isArray(t) ? t : [])
    // ⚠ `evenementsDuJour` PEUT RENDRE QUELQUE CHOSE. Le double rendait `[]`
    // pour toute clef inconnue, donc le bloc du jour etait TOUJOURS a l'etat
    // vide dans le banc : l'etat « il y a une arrivee » n'etait atteignable par
    // aucun test, et la bascule qui en depend n'etait mesurable que dans un
    // sens. La REGLE de composition d'un evenement a ses tests dans
    // `tests/aujourdhui.test.js` ; ici c'est le RENDU qu'on juge.
    if (cle === 'evenementsDuJour') {
      return () => (Array.isArray(options.evenements) ? options.evenements : [])
    }
    return cle === 'etatDesBiens' ? (() => new Map()) : (() => [])
  } })

  // ⚠ LE BANC GARDE LES ERREURS AU LIEU DE LES AVALER. Le `logger` injecte
  // etait `{ error: rien }`, et la derniere ligne de la page est
  // `init().catch(e => logger.error(...))` : une panne du DEMARRAGE ne laissait
  // donc aucune trace. Mesure du 27 octobre 2026 : apres un chargement complet,
  // `p.urls` et `p.lectures` sont VIDES — `init()` n'arrive jamais a sa phase
  // reseau, et les tests qui chargent la page entiere affirmaient des choses
  // d'un ecran qui ne s'etait jamais construit. C'est la famille « erreur
  // avalee » que ce depot a deja payee 24 heures sur un cron rendant 200.
  const erreurs = []
  const journal = { error: (...a) => erreurs.push(a.map(String).join(' ')), warn: rien, info: rien }

  const sorti = new Function(
    'requireAuth', 'supabase', 'signOut', 'initErrorHandler', 'logger', 'esc',
    'compteCourant', 'moi', 'peutLire', 'peutEcrire', 'estTitulaire', 'comptes',
    'basculerVers', 'enteteCompte', 'etatHtml',
    'vueDesAvis', 'blocAvisHtml', 'enTeteAvisHtml', 'carteAvisHtml', 'MUETS', 'libelleDuCanal', 'R',
    'I18n', 'HSNav', 'document', 'window', 'location', 'fetch', 'localStorage', 'console',
    // ⚠ `CacheEcran` MANQUAIT, ET C'EST CE QUI TUAIT LE DEMARRAGE. La page fait
    // `import * as CacheEcran from '/shared/cache-ecran.js'` et s'en sert des
    // sa phase de cache ; le nom n'etant pas injecte ici, `init()` levait
    // `CacheEcran is not defined` A CHAQUE CHARGEMENT, et son `.catch` le
    // donnait a un `logger.error` qui ne gardait rien.
    // ⚠ ON INJECTE LE VRAI MODULE, pas un double — meme regle que pour le
    // module des avis. Un double de cache qui ne cache rien masquerait la
    // moitie du chemin qu'on croit eprouver, y compris la purge et la
    // peremption. Il ecrit dans le `localStorage` du banc, qui est deja faux.
    'CacheEcran',
    // ⚠ LE MODULE DE COURBE MANQUAIT, et c'est la vue Annee ENTIERE qui ne
    // s'executait jamais : `renderAnnee` appelle `courbeMensuelle`, donc le
    // premier appel levait `courbeMensuelle is not defined`. Aucun test ne
    // l'appelait, donc rien ne
    // le disait — la page avait un ecran complet sans un seul garde-fou qui
    // l'exerce. Meme lecon que `CacheEcran` deux lignes plus haut.
    // ⚠ ET C'EST LE VRAI MODULE : un double rendrait des SVG inventes, donc des
    // assertions sur une geometrie qui n'est pas celle qu'on livre.
    'courbeMensuelle',
    batirAujourdhui(options.sansInit)
  )(requireAuth, supabase, rien, rien, journal, ESC,
    () => 'u1', () => 'u1', () => true, () => true, () => true, () => [],
    rien, () => ({}), () => '<h2 data-i18n="logements.vide_titre"></h2>',
    // ⚠ LE MODULE DES AVIS EST INJECTE POUR DE VRAI, pas double (constat MOYEN 3
    // de la revue de l'etape 2). `renderDerniersAvis` etait EXPOSE par ce banc
    // et INAPPELABLE : le `new Function` n'injectait pas `vueDesAvis`, et
    // l'appeler levait `ReferenceError`. Le commit annoncait « quatre tests qui
    // APPELLENT remplacent quatre regex » — c'etait vrai pour deux rendus sur
    // trois. Resultat mesure : onze mutations du code neuf survivaient.
    // On injecte le MODULE REEL : un double rendrait un test qui mesure son
    // propre double, et c'est le rendu qu'on veut juger.
    AVIS.vueDesAvis, AVIS.blocAvisHtml, AVIS.enTeteAvisHtml, AVIS.carteAvisHtml, AVIS.MUETS,
    (c) => ({ airbnb: 'Airbnb', booking: 'Booking.com' })[String((c || {}).ota || '')] || null,
    R,
    // ⚠ LA FENETRE PORTE `matchMedia`, et ce n'est pas un bouchon de confort :
    // la vue Annee choisit le repere de sa courbe avec elle (360 unites au
    // telephone, 680 a l'ordinateur). Une fenetre vide faisait tomber la page
    // au CHARGEMENT du module — 36 rouges le 27 octobre 2026 — et la rendre
    // defensive cote page ne suffit pas : sans double ici, la branche etroite
    // ne serait jamais eprouvee. `options.etroit` la choisit.
    I18n, { renderMenu: rien, render: rien }, document_, fenetreDuBanc(options), { search: '', hash: '' },
    fetchFaux, faireStockage(), { error: rien, warn: rien, log: rien },
    require('../shared/cache-ecran.js'),
    require('../shared/courbe-mensuelle.js').courbeMensuelle)

  return {
    // Le corps que le test a fourni. Depuis le lot (b), les tests nourrissent
    // `etat.ecran` avec lui au lieu de compter sur le faux `fetch` : la page ne
    // fait plus l'appel, l'endpoint d'ecran le fait pour elle.
    corpsDonne: options.corps || {},
    // Ce que le demarrage a journalise. Vide = il est alle au bout.
    erreurs,
    interne: sorti,
    urls,
    lectures,
    I18n,
    date: () => document_.querySelector('[data-bind="date"]').textContent,
    html: (sel) => document_.querySelector(sel).innerHTML,
    // L'element lui-meme, pour lire `hidden` et `textContent` : le double les
    // porte, et c'est sur eux que se jugent « masque » et « se tait ».
    cache: (sel) => document_.querySelector(sel),
    // Le geste de l'hote : « je fais defiler ». C'est lui qui arme
    // l'observation de la sentinelle (voir `armerLaSuiteDesAvis`).
    defiler: () => {
      for (const e of (options.ecouteurs || [])) if (e.type === 'scroll') e.fn({ type: 'scroll' })
    },
    ouvrirSession: () => resoudreSession({ user: { id: 'u1', email: 'thierry@exemple.fr', user_metadata: {} } }),
    repondreI18n: () => resoudreI18n('fr'),
    resoudre: (table, charge) => {
      const l = lectures.find(x => x.table === table)
      assert.ok(l, 'aucune lecture de ' + table)
      l.resoudre(charge)
    }
  }
}

test("LE TEST QUI COMPTE : I18n.init part AVANT que requireAuth reponde", async () => {
  const p = ouvrirAujourdhui()
  await tours()
  assert.strictEqual(p.I18n.appels, 1,
    'I18n.init attend la session : les deux partaient en file, soit un aller-retour de plus')
})

test("LE TEST QUI COMPTE : la page ne lit plus `properties` elle-meme", async () => {
  // ⚠ LA GARANTIE EST DEVENUE PLUS FORTE, ET LE TEST A DU SUIVRE. Ce test
  // exigeait que `profiles` et `properties` partent ENSEMBLE — parce que la
  // page lisait les biens en direct, sous RLS, 9 colonnes et toutes les lignes
  // du compte sans limite. Le lot (b) a deplace cette lecture dans l appel
  // d ecran, ou son perimetre est applique EXPLICITEMENT (la cle de service
  // contourne la RLS). La page ne lit donc plus `properties` du tout, ce qui
  // rend l ancienne assertion impossible a satisfaire — et c est un progres,
  // pas une regression.
  const p = ouvrirAujourdhui()
  p.ouvrirSession(); p.repondreI18n()
  await tours()
  const tables = p.lectures.map(l => l.table)
  // ⚠ ET DEPUIS L'ETAPE 1 DU LOT AUJOURD'HUI V5, LA GARANTIE EST ENTIERE : la
  // page ne lit AUCUNE table en direct. `profiles` etait la derniere — le
  // « Bonjour {prenom} » la demandait alors que `/api/membres` l'avait deja
  // rendue dans `requireAuth` (dette 73), sur un objet de session fige qui
  // pouvait porter un e-mail perime (dette 72). L'en-tete retire, les deux
  // dettes sont sans objet ici.
  assert.ok(!tables.includes('profiles'),
    'la page relit `profiles` : le bonjour est parti, plus rien ne justifie cette lecture')
  assert.ok(!tables.includes('properties'),
    'la page relit `properties` en direct : le lot (b) l a replie dans l appel d ecran, '
    + 'ou le perimetre est applique explicitement')
  assert.ok(!tables.includes('agent_tasks'),
    'la page relit `agent_tasks` en direct : meme raison')

  // ⚠ ET LA LISTE OBSERVEE NE SUFFIT PAS — LA CONTRE-EPREUVE L'A MONTRE.
  // A ce point du chargement, la page est arretee sur une lecture que le test
  // ne resout pas : une lecture de `properties` AJOUTEE PLUS LOIN (dans
  // `chargerEcran`, par exemple) n'apparaitrait jamais dans `tables`, et
  // l'assertion ci-dessus resterait verte. Elle dit « pas encore », pas
  // « jamais ». C'est la SOURCE qui dit « jamais ».
  const src = lire('pages/aujourdhui.html')
  const tablesLues = [...src.matchAll(/supabase\.from\('([^']+)'\)/g)].map(m => m[1])
  assert.deepEqual(tablesLues, [],
    'la page lit une table en direct, sous RLS, hors du perimetre applique par '
    + 'l appel d ecran : ' + tablesLues.join(', ') + '. Depuis l etape 1, AUCUNE '
    + 'lecture directe n est autorisee sur cet ecran.')
})

test("LE TEST QUI COMPTE : la DATE s affiche sans attendre aucune lecture", async () => {
  // ⚠ CE TEST GARDAIT LE BONJOUR, RETIRE A L'ETAPE 1. Ce qu'il protegeait reste
  // vrai et se deplace : le premier element visible de la page ne doit attendre
  // AUCUN aller-retour. C'etait un `Promise.all` sur deux resultats qui faisait
  // attendre au bonjour la lecture `properties` ; c'est aujourd'hui plus simple
  // encore, la date ne depend que de l'horloge.
  const p = ouvrirAujourdhui()
  p.ouvrirSession(); p.repondreI18n()
  await tours()
  assert.notStrictEqual(p.date(), '',
    'la date attend une lecture pour s afficher : elle ne depend que de l horloge')
  assert.strictEqual(p.lectures.length, 0,
    'la page fait une lecture directe avant son premier affichage : ' + p.lectures.map(l => l.table).join(', '))
})

test("l accueil ne refait plus d aller-retour pour l utilisateur deja connu", () => {
  const src = lire('pages/aujourdhui.html')
  // On juge le CODE, pas les commentaires : le commentaire du lot nomme
  // `getUser()` pour dire qu'il est parti.
  const code = src.replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/\bgetUser\s*\(/.test(code),
    'getUser est appele de nouveau : un aller-retour vers /auth/v1/user pour un objet que requireAuth rend deja')
  assert.ok(!/import\s*\{[^}]*\bgetUser\b[^}]*\}/.test(code),
    'getUser est de nouveau importe dans pages/aujourdhui.html')
  assert.ok(src.includes('const user = session.user'), 'l utilisateur ne vient plus de la session')
})

// ⚠ CES TESTS ONT ETE RETARGES AU LOT (b) DU CHANTIER PERFORMANCE, et il faut
// savoir ce qui a bouge : la SOURCE, pas la regle. `chargerNotes` ne fait plus
// d'appel reseau — les notes arrivent dans `etat.ecran.notes`, remplies par
// `/api/ecran/aujourdhui`, qui appelle la MEME fonction `notesDuPerimetre`
// cote serveur. Tout ce que ces tests gardent — un bien absent vaut zero, une
// cle heritee d'Object ne devient pas une note, la page ne redivise pas —
// reste vrai mot pour mot, et a ete paye par deux mesures. On nourrit donc
// `etat.ecran` au lieu du faux `fetch`.
// ─── Lot 2 du chantier chargement : les notes en UN appel ────────────────────
//
// ⚠ CE QUE CE LOT A CHANGE. `chargerNotes` appelait `/api/avis?action=cartes`
// une fois pour le compte PUIS UNE FOIS PAR BIEN, pour n'en garder que
// `moyenne` et `notes`. Chaque appel lisait jusqu'a 5000 avis, 2000
// evaluations, leurs sejours et leurs menages, et assemblait les cartes deux
// fois. Mesure de Thierry en production le 20 octobre 2026 : 10,7 s puis
// 3 x 4-5 s, environ 75 % des ~20 s de la page.
//
// Le garde-fou est EXECUTE : on compte les appels reellement emis.

const biensDeTest = [
  { id: 'b1', name: 'Colomiers', provider_property_id: 'REF_A' },
  { id: 'b2', name: 'La bulle', provider_property_id: 'REF_B' },
  { id: 'b3', name: 'Sans canal', provider_property_id: null },
]

test('LE TEST QUI COMPTE : l accueil ne demande PLUS les notes lui-meme', async () => {
  // ⚠ LA GARANTIE S'EST DEPLACEE, ELLE NE S'EST PAS PERDUE. Le 1 + N
  // (`action=cartes` une fois par compte puis une fois par bien, 10,7 s puis
  // 3 x 4-5 s en production) avait ete ramene a UN appel `action=notes` au lot 2
  // du chantier chargement. Le lot (b) va plus loin : la page n'appelle plus
  // `/api/avis` DU TOUT — les notes arrivent dans l'appel d'ecran, ou elles
  // coutent une lecture parmi 22.
  // Ce test garde donc l'absence, et le suivant garde que l'ENDPOINT, lui, ne
  // lit les notes qu'une fois.
  const p = ouvrirAujourdhui({ sansInit: true, corps: {} })
  p.interne.etat.biens = biensDeTest
  p.interne.etat.ecran = { notes: { global: { note_sur_5: 4.7, notes: 42 }, par_bien: {} } }
  await p.interne.chargerNotes()
  const avis = p.urls.filter(u => u.includes('/api/avis'))
  assert.deepEqual(avis, [],
    'la page redemande /api/avis : le lot (b) l a replie dans l appel d ecran')
  // Et la note est bien arrivee, donc le test ne passe pas par vacuite.
  assert.deepEqual(p.interne.etat.noteGlobale, { note_sur_5: 4.7, notes: 42 })

  // ⚠ ET SURTOUT : PAS DE REPLI RESEAU QUAND LES NOTES MANQUENT.
  // La contre-epreuve par mutation l'a exige. Un `|| await appel('/api/avis')`
  // en repli — la forme la plus naturelle d'une rechute — laissait ce test
  // vert, parce qu'il nourrissait toujours `etat.ecran.notes`. Un bloc absent
  // de l'appel d'ecran (droit refuse, panne de lecture) doit s'afficher
  // « non calculable », JAMAIS declencher l'ancien appel : ce serait le 1 + N
  // qui revient par la porte de service, et seulement chez les comptes dont
  // le bloc a echoue — donc invisible en recette.
  const q = ouvrirAujourdhui({ sansInit: true, corps: {} })
  q.interne.etat.biens = biensDeTest
  q.interne.etat.ecran = {}
  await q.interne.chargerNotes()
  assert.deepEqual(q.urls.filter(u => u.includes('/api/avis')), [],
    'les notes absentes de l appel d ecran declenchent un repli vers /api/avis')
  assert.strictEqual(q.interne.etat.noteGlobale, null, 'un bloc absent s affiche comme un fait')
})

test('LE TEST QUI COMPTE : l endpoint d ecran ne lit les notes qu UNE fois', () => {
  // La garantie du 1 + N, cote serveur maintenant. Un appel par bien y serait
  // invisible a l ecran et couterait autant qu avant.
  const src = lire('api/ecran/aujourdhui.js').replace(/^\s*\/\/.*$/gm, '')
  const appels = (src.match(/notesDuPerimetre\(/g) || []).length
  assert.strictEqual(appels, 1,
    `${appels} appels a notesDuPerimetre dans l endpoint : le 1 + N est revenu, cote serveur`)
  assert.ok(!/for\s*\([^)]*\)\s*\{[^}]*notesDuPerimetre/.test(src),
    'notesDuPerimetre est appele dans une boucle')
})

test('LE TEST QUI COMPTE : chaque bien recoit la meme chose qu avant, zero compris', async () => {
  const p = ouvrirAujourdhui({ sansInit: true, corps: {
    global: { note_sur_5: 4.7, notes: 42 },
    // REF_B n'a aucune note sur la periode : la reponse n'a pas sa cle.
    par_bien: { REF_A: { note_sur_5: 4.8, notes: 30 } },
  } })
  p.interne.etat.biens = biensDeTest
  p.interne.etat.ecran = { notes: p.corpsDonne }
  await p.interne.chargerNotes()

  assert.deepEqual(p.interne.etat.noteGlobale, { note_sur_5: 4.7, notes: 42 })
  // ⚠ LES TROIS ASSERTIONS PAR BIEN SONT PARTIES AVEC `etat.notesParBien`
  // (etape 4), ET IL FAUT DIRE CE QU'ELLES TENAIENT : un bien absent de la
  // reponse valait zero et non `undefined`, et un bien sans cle provider n'avait
  // pas d'entree du tout. Ces deux distinctions n'avaient qu'un consommateur,
  // l'etoile des cartes de logement, et les cartes partent avec le bloc
  // « Vos logements » (inventaire I28). La note par bien revient a la fiche du
  // logement, que /logements rend deja avec sa propre lecture.
  //
  // Ce qui reste teste ici est la seule chose que l'accueil lit encore : la note
  // GLOBALE, telle quelle, sans redivision.
  assert.ok(!('notesParBien' in p.interne.etat),
    'la Map par bien est revenue : elle n a aucun lecteur, donc elle ferait croire que la donnee est disponible')
})

// ⚠ CES TROIS TESTS PASSAIENT PAR VACUITE, ET LA REVIEW L'A VU.
// Ils reglaient `fetchLeve`, `corpsIllisible` ou `statut: 503` sur le faux
// `fetch` — alors que `chargerNotes` ne fait plus AUCUN appel reseau depuis le
// lot (b). Les trois options etaient donc inertes : les tests prouvaient
// seulement qu'un bloc `notes` vide ne devient pas zero, en decrivant dans
// leurs commentaires une panne qu'ils ne provoquaient plus.
// Ce qu'il faut garder est le meme invariant — « une lecture en echec se DIT,
// elle ne rend pas des compteurs a zero » — mais contre les formes que
// l'endpoint produit VRAIMENT : `notes: null` (droit refuse ou lecture
// indisponible), un bloc illisible, et l'appel d'ecran entierement absent.
const casSansNote = [
  ['le bloc est `null` : droit `avis` refuse, ou lecture indisponible', { notes: null }],
  ['le bloc est illisible : ni global, ni par_bien', { notes: { parasite: 1 } }],
  ["l'appel d'ecran a echoue : aucun bloc du tout", {}],
  ["l'appel d'ecran a rendu un corps vide", { notes: {} }]
]

for (const [quoi, ecran] of casSansNote) {
  test(`LE TEST QUI COMPTE : ${quoi} — « 0 avis » n est jamais affirme`, async () => {
    const p = ouvrirAujourdhui({ sansInit: true, corps: {} })
    p.interne.etat.biens = biensDeTest
    p.interne.etat.ecran = ecran
    await p.interne.chargerNotes()
    // ⚠ L'ASSERTION PAR BIEN EST PARTIE AVEC `etat.notesParBien` (etape 4), ET
    // L'INVARIANT NE L'EST PAS : elle doublait celle du dessus, qui porte la
    // meme regle sur la note GLOBALE — « 0 avis » n'est jamais affirme quand
    // rien n'a ete lu. La Map par bien n'avait qu'un lecteur, l'etoile des
    // cartes de logement, et les cartes partent avec le bloc « Vos logements ».
    assert.strictEqual(p.interne.etat.noteGlobale, null,
      'la tuile affiche un nombre d avis alors que rien n a ete lu')
    assert.deepEqual(p.urls.filter(u => u.includes('/api/')), [],
      'la page part en reseau pour se rattraper : le 1 + N reviendrait par la porte de service')
  })
}

test("LE TEST QUI COMPTE : une cle de bien piegeuse ne fait plus rien tomber sur l'accueil", async () => {
  // ⚠ CE TEST GARDAIT `hasOwnProperty` DANS LA PAGE, ET LA REGLE A CHANGE DE
  // MAISON — elle n'a pas disparu. `par_bien` vient de `JSON.parse` : pour un
  // bien dont la cle provider vaudrait `constructor`, `toString` ou `valueOf`,
  // une lecture directe rendrait une FONCTION heritee d'Object, vraie, donc le
  // repli n'etait jamais pris.
  //
  // ⚠ ET ELLE EST TENUE COTE SERVEUR, VERIFIE AVANT D'ECRIRE CETTE LIGNE :
  // `lib/stats-avis.js:497` construit `par_bien` avec `Object.create(null)`,
  // donc la table n'a AUCUNE cle heritee a rendre — et c'est teste la-bas,
  // `tests/stats-avis.test.js` l 770-819 (« le prototype nul ne protege plus :
  // la cle est avalee », « par_bien a de nouveau un prototype : une reference
  // `__proto__` l ecrirait »). Retirer ce doublon sans cette verification aurait
  // ete retirer un garde-fou en croyant le deplacer.
  //
  // Ce qui reste a garder ici est que la PAGE ne retombe pas dans le piege : des
  // cles provider piegeuses ne doivent faire ni lever, ni afficher de note.
  const p = ouvrirAujourdhui({ sansInit: true, corps: { global: { note_sur_5: 4.5, notes: 3 }, par_bien: {} } })
  p.interne.etat.biens = [
    { id: 'bc', name: 'Piege', provider_property_id: 'constructor' },
    { id: 'bt', name: 'Piege 2', provider_property_id: 'toString' },
    { id: 'bp', name: 'Piege 3', provider_property_id: '__proto__' },
  ]
  p.interne.etat.ecran = { notes: p.corpsDonne }
  await p.interne.chargerNotes()
  assert.deepEqual(p.interne.etat.noteGlobale, { note_sur_5: 4.5, notes: 3 },
    'une cle provider piegeuse a fait tomber la note globale')
  assert.deepEqual(p.urls.filter(u => u.includes('/api/')), [],
    'la page part en reseau sur une cle piegeuse')
})

test("LE TEST QUI COMPTE : la page affiche la note telle quelle, elle ne la redivise pas", async () => {
  // ⚠ L'endpoint descend `note_sur_5`, deja ramenee sur 5 et arrondie UNE
  // SEULE fois. La version d'avant le 20 octobre 2026 divisait ici une moyenne
  // elle-meme arrondie : deux arrondis, et Colomiers affichait 4,8 la ou le
  // calcul juste donne 4,7. Le double de `R` LEVE si la page appelle encore
  // `noteSur5`, donc ce test echoue aussi par ce chemin-la.
  const p = ouvrirAujourdhui({ sansInit: true, corps: {
    global: { note_sur_5: 4.7, notes: 42 },
    par_bien: { REF_A: { note_sur_5: 4.8, notes: 30 } },
  } })
  p.interne.etat.biens = biensDeTest
  p.interne.etat.ecran = { notes: p.corpsDonne }
  await p.interne.chargerNotes()

  // ⚠ CET INVARIANT A CHANGE DE SUPPORT DEUX FOIS, ET IL NE S'AFFAIBLIT PAS.
  // La tuile du bandeau « Note · 30 j » est partie a l'etape 1 (24 octobre
  // 2026) ; le test s'est alors appuye sur l'ETOILE de chaque logement. Les
  // cartes de logement partent a leur tour avec le bloc « Vos logements »
  // (etape 4, inventaire I28), donc l'etoile par bien n'existe plus sur
  // l'accueil — mais la note GLOBALE, elle, s'affiche toujours : en tete du
  // bloc « Derniers avis ». C'est la qu'on le tient maintenant.
  //
  // La regle est inchangee depuis le premier jour : l'endpoint descend
  // `note_sur_5` DEJA ramenee sur 5 et arrondie UNE SEULE fois, et l'ecran ne la
  // redivise pas. 4,7 sur 10 redivise donnerait 2,3 ou 2,4 — les deux valeurs
  // qu'on refuse de voir.
  assert.deepEqual(p.interne.etat.noteGlobale, { note_sur_5: 4.7, notes: 42 },
    'la note globale a ete redivisee ou perdue avant l affichage')
  // ⚠ L'EN-TETE NE S'AFFICHE QUE SUR UN BLOC NON MUET, et c'est une regle du
  // bloc avis, pas une complication de ce test : `enTeteAvisHtml` rend la chaine
  // vide quand l'etat est MUET (refus, inconnu, perimetre vide) ou que la note
  // est `null`. Sans avis a montrer, il n'y a pas d'en-tete ou poser la note —
  // donc la fixture doit porter un avis, comme la production.
  p.interne.etat.derniersAvis = [{
    id: 'r1', bien_ref: 'REF_A', ota: 'airbnb', recu_le: '2026-10-20T10:00:00Z',
    note_sur_5: 4.9, texte: 'Sejour parfait.', voyageur: 'Claire B.'
  }]
  p.interne.etat.avisConnu = true
  p.interne.renderDerniersAvis()
  const tete = p.html('[data-bind="reviews-head"]')
  // ⚠ LE DOUBLE DE `t` DANS CE BANC REND LA CLE, PAS LE TEXTE INTERPOLE :
  // l'en-tete contient « reviews.score », donc la VALEUR n'est pas lisible dans
  // le HTML. C'est la meme limite que le test du compte plafonne plus haut, qui
  // la contourne en lisant `fr.json`. On juge donc ce que le banc peut dire :
  // l'en-tete EXISTE (la note est passee, elle n'est pas `null`) et il ne porte
  // aucun nombre redivise.
  assert.ok(tete.includes('reviews.score'),
    `l en-tete du bloc avis ne porte pas la note : ${tete}`)
  assert.ok(!/2[.,][34]/.test(tete), `l en-tete du bloc avis a redivise la note : ${tete}`)
  // ⚠ ET LA VALEUR PASSEE AU RENDU SE VERIFIE A LA SOURCE, par le module
  // partage qui construit la vue — lui-meme teste sur ses propres fixtures
  // dans `tests/avis-recents-dom.test.js`. C'est la seule facon de voir le
  // NOMBRE : la page ne le formate pas elle-meme, et c'est voulu.
  const vue = M_AVIS.vueDesAvis({
    derniers: p.interne.etat.derniersAvis,
    notes: { global: p.interne.etat.noteGlobale },
    biens: p.interne.etat.biens, connu: true
  })
  assert.strictEqual(vue.note_sur_5, 4.7,
    'la vue du bloc avis a redivise la note avant de la rendre')
})

test("LE TEST QUI COMPTE : une lecture ROGNEE n'est pas affichee comme une note", async () => {
  // L'endpoint pose `tronque` quand il a lu moins de lignes que le total
  // annonce (db-max-rows, ou le plafond). La note porte alors sur une
  // fraction : l'afficher avec l'aplomb des autres serait affirmer un chiffre
  // faux. Regle du depot : un resultat non calculable ne s'affiche jamais
  // comme un fait.
  const p = ouvrirAujourdhui({ sansInit: true, corps: {
    global: { note_sur_5: 4.8, notes: 500 },
    par_bien: { REF_A: { note_sur_5: 4.9, notes: 300 } },
    tronque: true
  } })
  p.interne.etat.biens = biensDeTest
  p.interne.etat.ecran = { notes: p.corpsDonne }
  await p.interne.chargerNotes()
  assert.strictEqual(p.interne.etat.noteGlobale, null,
    'une note calculee sur une fraction est affichee comme un fait')
})

// ═══════════════════════════════════════════════════════════════════════════
// Ce que l'ecran REND vraiment — constat MOYEN 1 de la revue de l'etape 1
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠ CES TESTS APPELLENT, ILS NE RELISENT PAS LA PAGE. Les quatre garde-fous
// retarges de l'etape 1 mesuraient une position dans le texte source : six
// mutations sur onze passaient au vert. Chacun des tests ci-dessous est ne
// d'une de ces mutations, et porte son numero.

// Le banc, prepare pour appeler un rendu : la page est montee sans son
// demarrage, et l'etat est pose a la main.
function bancDeRendu (etat = {}) {
  const p = ouvrirAujourdhui({ sansInit: true })
  Object.assign(p.interne.etat, etat)
  return p
}

test("LE TEST QUI COMPTE (M1b) : des taches ILLISIBLES ne rendent ni liste ni compte", async () => {
  // Mutation de la revue : la garde `if (!etat.tachesOk)` perd son `return`.
  // L'hote dont la lecture a echoue lisait alors « A valider · Rien a valider »
  // — une absence AFFIRMEE sur une donnee qu'on n'a pas pu lire. C'est, mot
  // pour mot, l'incident que le commentaire de cette fonction raconte.
  const p = bancDeRendu({ tachesOk: false, taches: [] })
  p.interne.renderTaches()
  assert.strictEqual(p.cache('[data-bind="validate-section"]').hidden, true,
    'la section « A valider » reste visible alors que la lecture a echoue')
  assert.strictEqual(p.html('[data-list="pending"]'), '',
    'une liste est rendue alors que les taches sont illisibles')
  assert.strictEqual(p.cache('[data-bind="validate-count"]').textContent, '',
    'un compte s affiche alors qu on n a rien pu lire')
})

test("LE TEST QUI COMPTE (M3) : zero tache a valider ne s'affiche PAS « 0 »", async () => {
  // Mutation : `: ''` devient `: '0'`. Un zero pose a cote d'un titre se lit
  // comme un fait, et la liste en dessous dit deja « Rien a valider ».
  const p = bancDeRendu({ tachesOk: true, taches: [] })
  p.interne.renderTaches()
  assert.strictEqual(p.cache('[data-bind="validate-count"]').textContent, '',
    'le compte affiche un zero au lieu de se taire')
})

test("LE TEST QUI COMPTE (M8) : une liste PLAFONNEE affiche « N+ », pas un nombre exact", async () => {
  // Mutation : `tachesPlafonnees()` rend toujours `false`. Le compte de Thierry
  // porte 222 taches ouvertes pour un plafond serveur de 200 : afficher « 200 »
  // serait un nombre faux avec aplomb, et `tronquees` existe pour l'eviter.
  const taches = [1, 2, 3, 4].map(i => ({ id: i, status: 'pending', book_id: 'R' + i, departure: '2099-01-01' }))
  const franc = bancDeRendu({ tachesOk: true, taches, ecran: { tronquees: [] } })
  franc.interne.renderTaches()
  const exact = franc.cache('[data-bind="validate-count"]').textContent
  assert.ok(/^\d+$/.test(exact), `un compte franc doit etre un nombre nu : ${exact}`)

  const plafonne = bancDeRendu({ tachesOk: true, taches, ecran: { tronquees: ['taches'] } })
  plafonne.interne.renderTaches()
  const avecPlus = plafonne.cache('[data-bind="validate-count"]').textContent
  assert.notStrictEqual(avecPlus, exact,
    'le compte est identique que la liste soit plafonnee ou non : le « + » ne s applique jamais')
  // ⚠ LE « + » LUI-MEME VIT DANS LE DICTIONNAIRE, pas dans le code : le double
  // de `t` rend la cle, pas le texte. On juge donc ici que les deux cas
  // DIFFERENT — c'est le comportement —, et on lit le texte reel a cote, parce
  // qu'une cle qui perdrait son « + » rendrait ce test vert pour rien.
  const fr = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shared', 'i18n', 'fr.json'), 'utf8'))
  assert.match(fr['validate.count_capped'], /\+/,
    'la cle du compte plafonne ne porte plus de « + » : le nombre se lirait exact')
})

test("LE TEST QUI COMPTE (M2) : l'etat « aucun logement » ne s'affiche QUE sur une liste vraiment lue", async () => {
  // Mutation : l'etat vide s'affiche sans consulter `listeLue`. L'hote qui a
  // quatre logements et dont l'appel n'a pas encore repondu lisait « Ajoutez
  // votre premier logement » — et, a l'onboarding, une reconciliation contre
  // une liste amputee CREE des biens en double chez le canal.
  //
  // ⚠ CE GARDE-FOU EST TRANSPOSE DU BLOC « Vos logements » AU BLOC « Revenus
  // nets » (etape 4), ET AUCUNE DES TROIS DISTINCTIONS N'EST PERDUE : pas
  // encore lu, lu et vide, lu en echec. L'etat vide a suivi le bloc parce qu'un
  // hote sans bien n'a pas de revenus non plus, et que c'est la seule action qui
  // lui reste sur cette page.
  const pasLu = bancDeRendu({ biens: [], ecran: null })
  pasLu.interne.renderRevenus()
  assert.strictEqual(pasLu.cache('[data-bind="etat-vide"]').hidden, true,
    'l etat vide s affiche alors que la liste n a pas ete lue')
  assert.strictEqual(pasLu.cache('[data-bind="revenue-section"]').hidden, true)

  const lu = bancDeRendu({ biens: [], ecran: { biens: [] } })
  lu.interne.renderRevenus()
  assert.strictEqual(lu.cache('[data-bind="etat-vide"]').hidden, false,
    'une liste lue et vide doit proposer d ajouter un logement')
  assert.match(lu.html('[data-bind="etat-vide"]'), /logements\.vide_titre/)

  // Et une lecture EN ECHEC (`null`) n'est ni une liste vide ni un etat vide.
  // ⚠ ELLE DOIT LE DIRE, et c'est ce controle qui a trouve un defaut dans mon
  // rendu neuf : `etat.biens` a `null` faisait tomber la boucle des lignes sur
  // `(etat.biens || [])`, donc un bloc avec son total mais SANS AUCUNE LIGNE —
  // un ecran qui a l'air complet et ne montre rien.
  const illisible = bancDeRendu({ biens: null, ecran: { biens: null } })
  illisible.interne.renderRevenus()
  assert.strictEqual(illisible.cache('[data-bind="etat-vide"]').hidden, true)
  assert.match(illisible.cache('[data-bind="revenue-total"]').textContent, /revenue\.unavailable/,
    'une liste de biens illisible affiche un total comme si tout allait bien')

  // Et avec un total VALIDE mais des biens illisibles : meme refus. C'est le
  // cas que mon rendu laissait passer.
  const avecTotal = bancDeRendu({ biens: null, ecran: { biens: null, revenus: { mois: '2026-11', total: { total_cents: 50000, recu_cents: 50000, a_venir_cents: 0, bruts: 0, refuses: { montant: 0, date: 0 }, motifs: {} }, par_bien: {} } } })
  avecTotal.interne.renderRevenus()
  assert.match(avecTotal.cache('[data-bind="revenue-total"]').textContent, /revenue\.unavailable/,
    'un total s affiche sur une liste de biens illisible')
})

// ═══════════════════════════════════════════════════════════════════════════
// Le bloc « Derniers avis » TEL QUE L'ECRAN LE REND — constats de la revue
// de l'etape 2 (25 octobre 2026)
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠ CES TESTS APPELLENT `renderDerniersAvis`, ce qu'aucun test ne faisait : la
// fonction etait exposee par ce banc et INAPPELABLE (le module des avis n'etait
// pas injecte, et l'appeler levait `ReferenceError`). Onze mutations du code
// neuf survivaient.

// ⚠ MODULE ES : `import()` ET NON `require`. Node leve
// ERR_REQUIRE_ESM_RACE_CONDITION sur un `require` de module ES en cours de
// chargement — meme patron que `tests/avis-recents-dom.test.js`.
let M_AVIS
test.before(async () => { M_AVIS = await import('../shared/avis-recents.js') })

const AVIS_SERVEUR = [{
  id: 'r1', bien_ref: '209413', ota: 'airbnb', recu_le: '2026-10-20T10:00:00Z',
  note_sur_5: 4.8, texte: 'Sejour parfait, on reviendra.', voyageur: 'Claire B.'
}]
const BIENS_SERVEUR = [{ id: 'u1', provider_property_id: '209413', name: 'La bulle', photo_url: null }]

function bancAvis (ecran = {}) {
  const p = ouvrirAujourdhui({ sansInit: true })
  p.interne.etat.ecran = ecran
  p.interne.etat.biens = BIENS_SERVEUR
  p.interne.etat.noteGlobale = ecran.notes ? ecran.notes.global : null
  return p
}

test("LE TEST QUI COMPTE : un droit `avis` refuse n'EFFACE pas seulement, il ne laisse RIEN", async () => {
  // ⚠ MESURE DE LA REVUE : la section passait a `hidden` et gardait ses trois
  // cartes et sa moyenne dans le DOM. `hidden` cache, il n'efface pas — et le
  // cas se produit en deux temps : un premier affichage rend les avis, puis la
  // reponse du serveur refuse le droit (membre revoque en cours de session).
  const p = bancAvis({ derniers_avis: AVIS_SERVEUR, notes: { global: { note_sur_5: 4.8, notes: 336 } } })
  await p.interne.chargerDerniersAvis()
  p.interne.renderDerniersAvis()
  assert.match(p.html('[data-list="reviews"]'), /avis-carte/, 'le rendu normal ne produit rien')

  // Puis le refus arrive.
  p.interne.etat.ecran = { derniers_avis: null, refuses: ['avis'] }
  p.interne.etat.noteGlobale = null
  await p.interne.chargerDerniersAvis()
  p.interne.renderDerniersAvis()
  assert.strictEqual(p.cache('[data-bind="reviews-section"]').hidden, true, 'la section reste visible')
  assert.strictEqual(p.html('[data-list="reviews"]'), '',
    'les cartes restent dans le DOM : `hidden` les cache, il ne les efface pas')
  assert.strictEqual(p.html('[data-bind="reviews-head"]'), '',
    'la moyenne reste dans le DOM apres un refus de droit')
})

test("LE TEST QUI COMPTE : « pas encore demande » ne se dit pas « pas lisible »", async () => {
  // Le cache d'ecran ne porte plus ce bloc (il descend un prenom de voyageur) :
  // au premier affichage la cle est ABSENTE. La traiter comme `null` afficherait
  // « Les avis ne sont pas lisibles » a chaque ouverture, pendant un
  // aller-retour, sur une donnee qui arrive une seconde plus tard.
  const p = bancAvis({ biens: [], notes: { global: { note_sur_5: 4.8, notes: 12 } } })
  await p.interne.chargerDerniersAvis()
  p.interne.renderDerniersAvis()
  assert.strictEqual(p.cache('[data-bind="reviews-section"]').hidden, true)
  assert.strictEqual(p.html('[data-list="reviews"]'), '')

  // Alors qu'une lecture VRAIMENT en echec, elle, se dit.
  const q = bancAvis({ derniers_avis: null, indisponibles: ['derniers_avis'] })
  await q.interne.chargerDerniersAvis()
  q.interne.renderDerniersAvis()
  assert.strictEqual(q.cache('[data-bind="reviews-section"]').hidden, false)
  assert.match(q.html('[data-list="reviews"]'), /reviews\.unavailable/)
})

test("LE TEST QUI COMPTE : un membre SANS AUCUN BIEN ne lit pas « pas encore d'avis »", async () => {
  // Une phrase qui parle d'absence d'AVIS la ou il y a absence de BIENS. C'est
  // l'injonction symetrique de « Ajoutez votre premier logement », fermee le
  // meme jour sur le bloc des logements.
  const p = bancAvis({ derniers_avis: [], perimetre_vide: true })
  await p.interne.chargerDerniersAvis()
  p.interne.renderDerniersAvis()
  assert.strictEqual(p.cache('[data-bind="reviews-section"]').hidden, true)
  assert.strictEqual(p.html('[data-list="reviews"]'), '')

  // Un hote qui a des biens et pas d'avis, lui, lit bien la phrase.
  const q = bancAvis({ derniers_avis: [], perimetre_vide: false })
  await q.interne.chargerDerniersAvis()
  q.interne.renderDerniersAvis()
  assert.strictEqual(q.cache('[data-bind="reviews-section"]').hidden, false)
  assert.match(q.html('[data-list="reviews"]'), /reviews\.empty/)
})

test('le bloc rend les cartes, la moyenne et le compte quand tout va bien', async () => {
  const p = bancAvis({ derniers_avis: AVIS_SERVEUR, notes: { global: { note_sur_5: 4.8, notes: 336 } } })
  await p.interne.chargerDerniersAvis()
  p.interne.renderDerniersAvis()
  const liste = p.html('[data-list="reviews"]')
  assert.match(liste, /Sejour parfait/)
  assert.match(liste, /Claire B\./)
  assert.match(liste, /La bulle/, 'le bien est retrouve par sa cle PROVIDER')
  assert.match(p.html('[data-bind="reviews-head"]'), /reviews\.score/)
})

// ═══════════════════════════════════════════════════════════════════════════
// Le bloc « Revenus nets » TEL QUE L'ECRAN LE REND — constats de la review
// de l'etape 4 (26 octobre 2026)
//
// ⚠ AUCUN TEST N'EXERCAIT CE RENDU AVEC UN `par_bien` NON VIDE, et la review
// l'a prouve par la mutation la plus simple : remplacer
// `parBien[String(b.provider_property_id)]` par `parBien[String(b.id)]` — la
// jointure naive UUID contre cle TEXTE, c'est-a-dire la REGLE DURE n° 3 du
// depot — survivait a la suite ENTIERE, 6337 tests. Toutes les lignes
// auraient affiche « aucun versement ce mois-ci » sous un bandeau juste : un
// ecran qui a l'air complet et ne montre rien.
// ═══════════════════════════════════════════════════════════════════════════

const REV_BIENS = [
  { id: 'uuid-1', provider_property_id: '209413', name: 'La bulle', currency: 'EUR' },
  { id: 'uuid-2', provider_property_id: '307820', name: 'Coeur de vie 23', currency: 'EUR' }
]
const parBien = (o) => ({
  sejours: 0, recu_cents: 0, a_venir_cents: 0, total_cents: 0, bruts: 0,
  refuses: { montant: 0, date: 0 }, motifs: {}, ...o
})
const bancRevenus = (revenus, biens = REV_BIENS) => bancDeRendu({
  biens, ageCache: null, ecran: { biens, revenus, droits: { reservations: true } }
})

test("LE TEST QUI COMPTE : chaque ligne est jointe par l'UUID du bien, et plus par sa cle provider", () => {
  // ⚠ CE TEST S'EST INVERSE LE 27 OCTOBRE 2026, ET CE N'EST PAS UN RELACHEMENT.
  // Il gardait « jointe par la cle PROVIDER, jamais par l'UUID », parce que
  // l'endpoint groupait par `bookings_snapshot.property_id` — du TEXTE.
  // L'agregat SQL groupe desormais par `property_uuid`, la colonne derivee qui
  // porte l'IDENTITE du bien.
  //
  // La regle dure n° 3 n'est pas contredite, elle est HONOREE : on ne joint
  // jamais un UUID a une cle TEXTE. Les deux cotes sont des UUID, et c'est le
  // writer qui a fait la resolution une fois, a l'ecriture, en comparant le
  // COUPLE (compte, cle provider). La cle provider change au re-keying et a la
  // bascule ; l'UUID non — c'etait la cause racine des 1 000 EUR d'ecart muet
  // entre le bandeau et les lignes.
  const p = bancRevenus({
    mois: '2026-11',
    par_bien: { 'uuid-1': parBien({ sejours: 2, total_cents: 70000, recu_cents: 40000, a_venir_cents: 30000 }) },
    total: parBien({ sejours: 2, total_cents: 70000, recu_cents: 40000, a_venir_cents: 30000 }),
    hors_mois: parBien({}), hors_biens: parBien({})
  })
  p.interne.renderRevenus()
  const lignes = p.html('[data-list="revenue-rows"]')
  assert.match(lignes, /La bulle/, 'le bien n est pas rendu')
  assert.ok(!lignes.includes('revenue.none') || !/La bulle[\s\S]{0,200}revenue\.none/.test(lignes),
    'le bien joint par UUID affiche « aucun versement » : la jointure est fausse')
  // Et le second bien, qui n'a pas de ligne dans `par_bien`, dit « aucun
  // versement » — un FAIT, puisqu'il a bien ete lu.
  assert.match(lignes, /Coeur de vie 23[\s\S]{0,200}revenue\.none/,
    'un bien sans versement ce mois-ci ne dit pas « aucun versement »')
})

test("LE TEST QUI COMPTE : une ligne dont le MONTANT manque ne dit JAMAIS 0,00 €", () => {
  // ⚠ CONSTAT GRAVE DE LA REVIEW, MESURE. Le module SAIT qu'un montant manque
  // (`refuses.montant`), et la ligne ne lisait ni ce compteur ni les motifs :
  // elle affichait « 0,00 € », un FAIT, au niveau du bien, sous un total juste.
  // Et le faux zero etait PIRE que l'absence : un bien qui n'a vraiment rien
  // touche n'a pas de cle, donc dit « aucun versement » SANS chiffre. L'ecran
  // avait deux rendus, et c'est le FAUX qui portait le nombre.
  const p = bancRevenus({
    mois: '2026-11',
    par_bien: {
      'uuid-1': parBien({ sejours: 1, refuses: { montant: 1, date: 0 }, motifs: { prix_non_calculable: 1 } })
    },
    total: parBien({ sejours: 1, refuses: { montant: 1, date: 0 }, motifs: { prix_non_calculable: 1 } }),
    hors_mois: parBien({}), hors_biens: parBien({})
  })
  p.interne.renderRevenus()
  const lignes = p.html('[data-list="revenue-rows"]')
  assert.ok(!/0[.,]00/.test(lignes), `la ligne affiche un zero : ${lignes}`)
  assert.match(lignes, /revenue\.unavailable/, 'la ligne ne dit pas que le montant est non calculable')
  assert.match(lignes, /revenue\.no_amount_short/, 'la ligne ne porte pas sa marque')
})

test("LE TEST QUI COMPTE : le compte de sejours d'une ligne porte TOUS les sejours", () => {
  // ⚠ CE TEST A ETE RETOURNE A LA RECETTE DE THIERRY DU 27 OCTOBRE 2026. Il
  // figeait l'inverse — « le compte de sejours ne compte pas les refuses » — et
  // il justifiait la soustraction par la coherence : « deux nombres de la meme
  // ligne se contredisent ».
  //
  // C'est la soustraction qui produisait la contradiction. Sur staging, la
  // ligne du Studio Centre affichait « 0 sejours · 2 sans montant » : « 0 » est
  // un FAIT FAUX — il y a bien deux sejours ce mois-ci — et il contredisait le
  // « 2 » de la mention suivante. Thierry a dicte la forme juste : « 2 sejours ·
  // montant non calculable ».
  //
  // Le compte porte donc TOUS les sejours du mois pour ce bien, et c'est la
  // colonne Total qui dit que le montant n'est pas calculable.
  const p = bancRevenus({
    mois: '2026-11',
    par_bien: {
      'uuid-1': parBien({ sejours: 2, total_cents: 30000, recu_cents: 30000, refuses: { montant: 1, date: 0 } })
    },
    total: parBien({ sejours: 2, total_cents: 30000, recu_cents: 30000, refuses: { montant: 1, date: 0 } }),
    hors_mois: parBien({}), hors_biens: parBien({})
  })
  p.interne.renderRevenus()
  const lignes = p.html('[data-list="revenue-rows"]')
  // ⚠ LE BANC NE MONTRE NI LES NOMBRES NI LES MONTANTS : son double de `t` rend
  // la CLE (`revenue.stays` au lieu de « 1 séjours »), et son double de
  // `I18n.money` rend une chaine vide. On juge donc ce qu'il peut dire, et on
  // verifie le NOMBRE a la source, juste apres.
  assert.match(lignes, /revenue\.no_amount_short/, 'le refus n est pas marque sur la ligne')
  // Un montant calculable prend la branche `<strong>`, pas la branche
  // « non calculable » — c'est la distinction que la ligne doit faire.
  assert.match(lignes, /<strong class="num small">/,
    'un montant calculable est rendu comme non calculable')
  assert.ok(!lignes.includes('revenue.unavailable'),
    'une ligne qui porte 300 € se dit non calculable')

  // ⚠ ET LE NOMBRE PASSE A `revenue.stays` SE VERIFIE A LA SOURCE, parce que
  // c'est tout l'objet de ce test : le banc ne montre pas les nombres.
  // La page passe `d.sejours` — TOUS les sejours du mois pour ce bien — et non
  // une soustraction.
  const html = fs.readFileSync(path.join(__dirname, '..', 'pages', 'aujourdhui.html'), 'utf8')
  assert.match(html, /t\('revenue\.stays', \{ n: d\.sejours \}\)/,
    '`revenue.stays` ne recoit plus TOUS les sejours du bien')
  assert.ok(!/d\.sejours - refuses/.test(html),
    'la soustraction est revenue : « 0 sejours · 2 sans montant » contredit ses propres nombres')
})

test("LE TEST QUI COMPTE : l'argent rattache a AUCUN bien connu se DIT", () => {
  // ⚠ SECOND CONSTAT GRAVE DE LA REVIEW : 1 000 € d'ecart muet entre le bandeau
  // et la somme des lignes. `par_bien` est groupe par `property_id` de
  // `bookings_snapshot` ; l'ecran ne peint que les cles qui correspondent a un
  // bien. Une cle ORPHELINE — `property_id` nul, re-keying, bien supprime —
  // entrait dans le total et sortait de l'affichage sans aucune reserve.
  //
  // ⚠ CE TEST GARDE L'AFFICHAGE, PAS LE COMPTAGE, et la review du 28 octobre
  // 2026 a eu raison de le dire : sa fixture n'etait PLUS produisible par
  // l'endpoint. L'agregat `revenus_hors_mois` ne comptait que les
  // `property_uuid` NULS, donc une cle `CLE-DISPARUE` (un UUID pendant, bien
  // supprime) rendait `hors_biens = 0` — l'ecart muet se rouvrait, et ce test
  // restait vert en peignant une reserve que le serveur n'aurait jamais
  // envoyee.
  //
  // La migration `2026-10-26-revenus-hors-biens.sql` l'a referme : le compteur
  // demande maintenant « ce bien existe-t-il encore ? » (`not exists` sur
  // `properties`, borne au compte) et non « l'UUID est-il nul ? ». La fixture
  // est donc redevenue produisible, et le COMPTAGE est mesure sur des donnees
  // reelles par `scripts/verifier-parite-revenus.js`, qui compare `hors_biens`
  // et `hors_biens_cents` a l'oracle — ce qu'il ne faisait pas non plus.
  const p = bancRevenus({
    mois: '2026-11',
    par_bien: {
      'uuid-1': parBien({ sejours: 1, total_cents: 50000, recu_cents: 50000 }),
      '': parBien({ sejours: 1, total_cents: 50000, recu_cents: 50000 }),
      'CLE-DISPARUE': parBien({ sejours: 1, total_cents: 50000, recu_cents: 50000 })
    },
    total: parBien({ sejours: 3, total_cents: 150000, recu_cents: 150000 }),
    hors_mois: parBien({}),
    hors_biens: parBien({ sejours: 2, total_cents: 100000, recu_cents: 100000 })
  })
  p.interne.renderRevenus()
  const res = p.cache('[data-bind="revenue-reserves"]')
  assert.strictEqual(res.hidden, false, 'la reserve est masquee alors que 1 000 € ne sont sur aucune ligne')
  assert.match(res.textContent, /revenue\.hors_biens/,
    'rien ne dit que de l argent du total n est sur aucune ligne')
})

test("LE TEST QUI COMPTE : les trois reserves s'affichent, et chacune dit sa cause", () => {
  // Elles ne se melangent pas : un montant manquant se repare dans le payload
  // du provider, une date manquante dans la table des delais, un brut attend
  // que la plateforme transmette sa commission.
  const p = bancRevenus({
    mois: '2026-11',
    par_bien: { 'uuid-1': parBien({ sejours: 3, total_cents: 90000, recu_cents: 90000, bruts: 1, refuses: { montant: 1, date: 0 } }) },
    total: parBien({ sejours: 3, total_cents: 90000, recu_cents: 90000, bruts: 1, refuses: { montant: 1, date: 0 } }),
    hors_mois: parBien({ sejours: 2, refuses: { montant: 0, date: 2 }, motifs: { canal_inconnu: 2 } }),
    hors_biens: parBien({}),
    tronque: true
  })
  p.interne.renderRevenus()
  const res = p.cache('[data-bind="revenue-reserves"]')
  assert.strictEqual(res.hidden, false)
  for (const cle of ['revenue.gross_count', 'revenue.no_amount', 'revenue.no_date', 'revenue.truncated']) {
    assert.ok(res.textContent.includes(cle), `la reserve ${cle} n est pas dite : ${res.textContent}`)
  }
})

test("LE TEST QUI COMPTE : sans le droit `reservations`, le bloc n'est pas dans l'ecran", () => {
  // ⚠ ET LE MASQUAGE SE DOUBLE D'UNE GARDE SERVEUR, qui est dans l'endpoint —
  // regle absolue du depot : le masquage tombe sur une feuille de style absente.
  // Le test de la garde serveur est juste en dessous.
  const p = bancDeRendu({
    biens: REV_BIENS, ageCache: null,
    ecran: { biens: REV_BIENS, revenus: null, droits: { reservations: false } }
  })
  p.interne.renderRevenus()
  assert.strictEqual(p.cache('[data-bind="revenue-section"]').hidden, true,
    'le bloc revenus s affiche sans le droit `reservations`')
})

test("LE TEST QUI COMPTE : la garde SERVEUR du droit `reservations` existe, et precede la lecture", () => {
  // ⚠ LA REVIEW A MONTRE QU'AUCUN TEST NE LA TENAIT : la retirer laissait la
  // suite au vert. Or le payload part dans le `localStorage` du membre pour
  // 12 h, et le masquage UI ne protege rien.
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'ecran', 'aujourdhui.js'), 'utf8')
  const bloc = (src.match(/const lireRevenus = async \(\) => \{[\s\S]*?\n  \}/) || [''])[0]
  assert.ok(bloc, 'lireRevenus a change de forme')
  assert.match(bloc, /if \(!droits\.reservations\) return null/,
    'la garde serveur du droit `reservations` a disparu de lireRevenus')
  // ⚠ ELLE PRECEDE TOUT APPEL, et la forme de l'appel a change le 27 octobre
  // 2026 : ce n'est plus `.from(...)` mais `.rpc(...)`. Un test reste sur
  // l'ancienne forme serait devenu vert pour rien — il ne trouvait plus de
  // lecture a comparer, donc `iLecture` valait -1 et la condition tombait.
  const iGarde = bloc.indexOf('if (!droits.reservations)')
  const iAppel = Math.min(
    ...['.rpc(', '.from('].map(x => { const i = bloc.indexOf(x); return i === -1 ? Infinity : i })
  )
  assert.ok(Number.isFinite(iAppel), 'aucun appel trouve dans lireRevenus : ce test ne mesure rien')
  assert.ok(iGarde > -1 && iGarde < iAppel, 'un appel part avant la garde du droit')
  // ⚠ ET LA TRONCATURE N'EXISTE PLUS : l'agregat ne pagine pas, il groupe. Ce
  // qui remplace ce garde-fou est la distinction entre une fonction ABSENTE
  // (migration en attente, donc « non calculable ») et une vraie panne.
  assert.match(bloc, /indisponibles\.push\('revenus'\)/,
    'une lecture impossible ne serait plus signalee : l ecran afficherait un mois a zero')
})

test("LE TEST QUI COMPTE : l'endpoint passe le perimetre en UUID, et l'agregat groupe en UUID", () => {
  // ⚠ LA REGLE DURE N° 3, DU COTE SERVEUR, ET ELLE A CHANGE DE FORME LE
  // 27 OCTOBRE 2026. L'endpoint comparait des cles PROVIDER ; il passe
  // maintenant `refsUuid` — la liste des biens confies a un membre, en UUID —
  // a une fonction SQL qui groupe par `property_uuid`.
  //
  // Les deux cotes sont donc des UUID. Ce qui serait faux aujourd'hui, c'est
  // l'INVERSE de l'ancienne erreur : passer `refsTexte` a une fonction qui
  // compare des UUID ne rendrait AUCUNE correspondance — un ecran vide sous un
  // bandeau vide, pour un membre delegue SEULEMENT, donc invisible en recette.
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'ecran', 'aujourdhui.js'), 'utf8')
  const bloc = (src.match(/const lireRevenus = async \(\) => \{[\s\S]*?\n  \}/) || [''])[0]
  assert.ok(bloc, 'lireRevenus a change de forme')

  assert.match(bloc, /rpc\('revenus_du_mois'/, 'l agregat du mois n est pas appele')
  assert.match(bloc, /rpc\('revenus_hors_mois'/, 'l agregat hors mois n est pas appele')
  assert.match(bloc, /p_refs: refsUuid/, 'le perimetre n est plus passe en UUID')
  assert.ok(!/p_refs: refsTexte/.test(bloc),
    'le perimetre est passe en cle TEXTE a une fonction qui compare des UUID : aucune correspondance')
  assert.match(bloc, /p_aujourdhui: jour/, 'le jour de Paris n est plus passe a l agregat')

  // ⚠ ET L'ENDPOINT NE CALCULE PLUS RIEN. C'est tout l'objet de
  // l'architecture : 3,8 Mo et 569-961 ms retires du chemin critique.
  const codeEntier = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  for (const interdit of ['revenusDuMois', 'fenetreDeLecture', 'tableDesDelais']) {
    assert.ok(!codeEntier.includes(interdit),
      `l endpoint calcule encore les revenus lui-meme (${interdit})`)
  }
  assert.ok(!/from\('delais_versement'\)/.test(codeEntier),
    'l endpoint relit la table des delais : c est le writer qui s en sert')
})

test("LE TEST QUI COMPTE : le BANDEAU dit « non calculable », il n'affiche pas 0,00 €", () => {
  // ⚠ CONSTAT BLOQUANT DE LA REVIEW DU 26 OCTOBRE 2026. La ligne d'un logement
  // porte cette garde depuis le debut — zero euro ET un montant refuse veut
  // dire « on ne sait pas », pas « ce logement n'a rien rapporte ». Le BANDEAU,
  // lui, ecrivait son total sans condition.
  //
  // Mesure sur les donnees reelles de staging : `revenus_du_mois(2026-10)` rend
  // `{sejours: 2, total_cents: 0, sans_montant: 2}`. L'ecran affichait donc
  // « 0,00 € » en grand, « non calculable » sur la ligne juste en dessous, et
  // « 2 sejour(s) dont le montant n'est pas calculable » en reserve. Les deux
  // moities du meme ecran se contredisaient, et c'est le bandeau que l'hote
  // retient.
  //
  // ⚠ CE QUI REND CE TEST POSSIBLE, et ce qui a laissé le defaut survivre si
  // longtemps : le banc stube `I18n.money` pour rendre la chaine VIDE, donc un
  // montant s'affiche `''`. Un test qui aurait compare le texte a « 0,00 € »
  // serait donc vert dans les deux cas — c'est l'angle mort.
  //
  // Mais `t()` n'est pas stube de la meme facon : il rend la CLEF. Les deux
  // etats sont donc parfaitement distinguables ici — `'revenue.unavailable'`
  // contre `''` — et c'est cette distinction qu'on mesure.
  //
  // (Premiere version de ce test : j'assertais `classList.contains('muted')`.
  // ⚠ CE COMMENTAIRE EST PERIME DEPUIS LE 29 OCTOBRE 2026 : le banc porte
  // maintenant une `classList` REELLE, adossee a `className`. Il est garde pour
  // l'histoire, pas comme une description de l'etat du banc.
  // Le noeud du banc n'avait pas de `classList` reelle, donc l'assertion echouait
  // alors que la garde fonctionnait. Mesurer ce que le banc ne simule pas, c'est
  // se fabriquer un rouge et chercher un defaut la ou il n'y en a pas.)
  const p = bancRevenus({
    mois: '2026-10',
    par_bien: { 'uuid-1': parBien({ sejours: 2, total_cents: 0, refuses: { montant: 2, date: 0 } }) },
    total: parBien({ sejours: 2, total_cents: 0, refuses: { montant: 2, date: 0 } }),
    hors_mois: parBien({}),
    hors_biens: parBien({})
  })
  p.interne.renderRevenus()
  assert.strictEqual(p.cache('[data-bind="revenue-total"]').textContent, 'revenue.unavailable',
    'le bandeau affiche un montant comme un fait alors qu AUCUN sejour du mois n est calculable')
  assert.strictEqual(p.cache('[data-bind="revenue-received"]').textContent, '',
    'le bandeau affiche un « recu » alors que rien n est calculable')
  assert.strictEqual(p.cache('[data-bind="revenue-upcoming"]').textContent, '',
    'le bandeau affiche un « a venir » alors que rien n est calculable')

  // ⚠ LA CONTRE-EPREUVE : un mois a ZERO EURO REEL — aucun refus — reste un
  // fait, et doit s'afficher comme tel. Sans elle, une garde qui dirait
  // toujours « non calculable » passerait le test ci-dessus.
  const q = bancRevenus({
    mois: '2026-10',
    par_bien: { 'uuid-1': parBien({ sejours: 0, total_cents: 0 }) },
    total: parBien({ sejours: 0, total_cents: 0 }),
    hors_mois: parBien({}),
    hors_biens: parBien({})
  })
  q.interne.renderRevenus()
  assert.notStrictEqual(q.cache('[data-bind="revenue-total"]').textContent, 'revenue.unavailable',
    'un mois sans aucun sejour est annonce « non calculable » alors que zero est la bonne reponse')
})

// ─── LES CINQ CONSTATS DE LA RECETTE DU 27 OCTOBRE 2026 (Thierry) ────────────

test("LE TEST QUI COMPTE : `--recu` est un NOMBRE NU, jamais un pourcentage", () => {
  // ⚠ CONSTAT 2 DE LA RECETTE : « un mois entierement recu (aout, Loft)
  // s'affiche hachure ». La cause n'etait pas la couleur, c'etait une unite.
  // La couche pleine de la barre fait
  // `inline-size: calc(var(--part) * var(--recu) / 100)`. Avec `--recu: 100%`,
  // cela donne `calc(50% * 100% / 100)` — un POURCENTAGE MULTIPLIE PAR UN
  // POURCENTAGE, invalide en CSS. La declaration tombe EN SILENCE, la couche
  // pleine n'a jamais eu de largeur, et seules les hachures s'affichaient : sur
  // tous les biens, tous les mois, depuis la livraison du bloc.
  //
  // ⚠ ET RIEN NE POUVAIT LE VOIR : le pourcentage s'ecrivait « correctement »
  // dans l'attribut, aucune assertion ne lit une largeur calculee, et jsdom ne
  // resout pas `calc()`. Seul l'oeil de Thierry sur un vrai telephone l'a pris.
  // D'ou ce test, qui garde la FORME de la valeur plutot que son effet.
  const p = bancRevenus({
    mois: '2026-11',
    par_bien: { 'uuid-1': parBien({ sejours: 2, total_cents: 70000, recu_cents: 70000, a_venir_cents: 0 }) },
    total: parBien({ sejours: 2, total_cents: 70000, recu_cents: 70000, a_venir_cents: 0 }),
    hors_mois: parBien({}), hors_biens: parBien({})
  })
  p.interne.renderRevenus()
  const lignes = p.html('[data-list="revenue-rows"]')
  assert.match(lignes, /--recu:\s*\d/, 'la barre ne porte pas `--recu`')
  assert.ok(!/--recu:\s*[\d.]+%/.test(lignes),
    '`--recu` est un pourcentage : `calc(% * %)` est invalide, la part RECUE ne s affichera pas')
  // Et `--part`, lui, EST un pourcentage : c'est une largeur.
  assert.match(lignes, /--part:\s*\d+%/, '`--part` doit rester un pourcentage : c est une largeur')
})

test("LE TEST QUI COMPTE : le telephone recoit une LISTE, rendue par la meme boucle", () => {
  // ⚠ CONSTAT 1 DE LA RECETTE : a 390 px le tableau en demandait 425, la colonne
  // Total etait coupee et les noms se cassaient mot par mot. La forme telephone
  // est un SECOND BALISAGE, parce qu'on ne peut pas basculer un `<table>` en
  // liste par CSS sans retirer ses cellules de l'arbre d'accessibilite.
  const p = bancRevenus({
    mois: '2026-11',
    par_bien: { 'uuid-1': parBien({ sejours: 2, total_cents: 70000, recu_cents: 40000, a_venir_cents: 30000 }) },
    total: parBien({ sejours: 2, total_cents: 70000, recu_cents: 40000, a_venir_cents: 30000 }),
    hors_mois: parBien({}), hors_biens: parBien({})
  })
  p.interne.renderRevenus()
  const cartes = p.html('[data-list="revenue-cards"]')
  assert.match(cartes, /La bulle/, 'la liste du telephone ne porte pas le bien')
  assert.match(cartes, /rev-carte__total/, 'la carte ne porte pas le total sur la ligne du nom')
  assert.match(cartes, /revenue-bar/, 'la carte ne porte pas la barre')
  assert.match(cartes, /revenue\.split/, 'la carte ne dit pas « x recus · y a venir »')
  // ⚠ ET LE COMPTE DE SEJOURS Y EST AUSSI, que la demande ne mentionnait pas :
  // regle « LE MOBILE SUIT L'ORDINATEUR », le tableau le porte.
  assert.match(cartes, /revenue\.stays/, 'le compte de sejours est perdu au telephone')
  // Les DEUX formes sortent des MEMES valeurs : un bien dans l'une est dans
  // l'autre. Deux boucles divergeraient au premier correctif applique a une
  // seule.
  const lignes = p.html('[data-list="revenue-rows"]')
  for (const nom of ['La bulle', 'Coeur de vie 23']) {
    assert.ok(lignes.includes(nom) && cartes.includes(nom),
      `${nom} n est pas dans les DEUX formes : les deux boucles ont divergé`)
  }
})

test("LE TEST QUI COMPTE : un montant non calculable le reste au telephone", () => {
  // La carte ne doit pas rattraper en « 0,00 € » ce que la ligne refuse de dire.
  const p = bancRevenus({
    mois: '2026-11',
    par_bien: {
      'uuid-1': parBien({ sejours: 1, refuses: { montant: 1, date: 0 }, motifs: { prix_non_calculable: 1 } })
    },
    total: parBien({ sejours: 1, refuses: { montant: 1, date: 0 }, motifs: { prix_non_calculable: 1 } }),
    hors_mois: parBien({}), hors_biens: parBien({})
  })
  p.interne.renderRevenus()
  const cartes = p.html('[data-list="revenue-cards"]')
  assert.match(cartes, /revenue\.unavailable/, 'la carte ne dit pas que le montant est non calculable')
  assert.ok(!/0[.,]00/.test(cartes), `la carte affiche un zero la ou la ligne refuse : ${cartes}`)
})

test("RECENSEMENT : le mois ne s'affiche qu'UNE fois, et le selecteur Mois/Annee est parti", () => {
  // ⚠ CONSTATS 4 ET 5 DE LA RECETTE. « octobre 2026 » etait ecrit a DEUX
  // endroits — entre les fleches et a droite du total — et le selecteur de vue
  // n'avait qu'un bouton visible, de 30 px, la ou la charte exige 44.
  const src = lire('pages/aujourdhui.html')
  const bindings = (src.match(/data-bind="revenue-month(?!-nav)"/g) || [])
  assert.deepEqual(bindings, [],
    'le mois est encore affiche a cote du total : il y est deux fois a l ecran')
  assert.match(src, /data-bind="revenue-month-nav"/, 'le mois des fleches a disparu aussi')
  // ⚠ CETTE ASSERTION EXIGEAIT LA DISPARITION DU SELECTEUR, et elle avait
  // raison tant que la vue Annee n'existait pas : un selecteur a un seul choix
  // ne selectionne rien. La vue Annee existe depuis le 27 octobre 2026, et la
  // decision 5 de Thierry la ramene. Ce que son constat exigeait VRAIMENT, et
  // qui reste vrai, c'est DEUX choix visibles et une cible de 44 px.
  const vues = (src.match(/data-vue="(mois|annee)"/g) || [])
  assert.deepEqual(vues.sort(), ['data-vue="annee"', 'data-vue="mois"'],
    'le selecteur ne porte plus exactement DEUX choix : un selecteur a un seul bouton ne selectionne rien')
  assert.ok(!/data-vue="[^"]*"[^>]*\bhidden\b/.test(src),
    'un des deux choix est masque : on retombe sur le bouton sans effet de la recette')
  const css = lire('shared/ui.css')
  const bouton = (css.match(/\.seg__btn\s*\{[^}]*\}/) || [''])[0]
  assert.match(bouton, /min-height:\s*var\(--control\)/,
    'la cible du selecteur n est plus reglee sur --control : Thierry avait mesure 30 px')
})

test("RECENSEMENT : la barre dit le RECU en plein noir et l A VENIR en hachure grise", () => {
  // ⚠ CONSTAT 2, seconde moitie. Les deux couches etaient en `var(--ok)` — le
  // vert : un mois entierement recu s'affichait de la couleur de l'encaisse ET
  // du motif de l'attente, donc la barre ne distinguait plus rien.
  const css = lire('shared/ui.css')
  // ⚠ CHACUN DES DEUX SELECTEURS APPARAIT DEUX FOIS : une regle COMMUNE pose
  // `content` et la position, une regle propre pose la largeur et la couleur.
  // Ma premiere version prenait la PREMIERE occurrence, donc la regle commune,
  // qui n'a pas de `background` — le test rougissait sur un code juste. Un test
  // qui lit le mauvais bloc peut aussi PASSER pour une raison fausse, et c'est
  // le sens de ce commentaire : on designe la regle par ce qu'elle CONTIENT.
  const blocs = (sel) => (css.match(new RegExp('\\' + sel + '\\s*\\{[^}]*\\}', 'g')) || [])
  // ⚠ ET « contient background » NE SUFFIT PAS NON PLUS : la regle
  // `prefers-reduced-motion` retire les hachures par `background-image: none`,
  // donc DEUX regles peignent legitimement l'« a venir ». On designe donc
  // chaque couche par ce qui la caracterise — le motif pour l'une, un fond
  // plein pour l'autre. Deuxieme resserrage de ce test, et les deux fois c'est
  // mon assertion qui etait trop large, pas le CSS qui etait faux.
  const avenirs = blocs('.revenue-bar::before').filter(b => /repeating-linear-gradient/.test(b))
  const recus = blocs('.revenue-bar::after').filter(b => /background:\s*var\(/.test(b))
  assert.equal(avenirs.length, 1, `une seule regle doit peindre l « a venir » : ${avenirs.length}`)
  assert.equal(recus.length, 1, `une seule regle doit peindre le « recu » : ${recus.length}`)
  const avenir = avenirs
  const recu = recus
  assert.match(avenir[0], /repeating-linear-gradient/, 'l « a venir » n est plus hachure')
  assert.match(avenir[0], /var\(--muted\)/, 'les hachures ne sont pas grises')
  assert.match(recu[0], /background:\s*var\(--ink\)/, 'le « recu » n est pas en plein noir')
  assert.ok(!/var\(--ok\)/.test(avenir[0] + recu[0]),
    'la barre utilise encore le vert : les deux couches se confondent')
  // ⚠ CONSTAT 3 : les cellules s'alignent par le HAUT. Avec `baseline`, la
  // vignette de 28 px repoussait la ligne de base de la cellule du nom, et les
  // trois cellules de chiffres descendaient — mais SEULEMENT sur les lignes qui
  // portent une photo.
  const cellules = css.match(/\.rev-tbl th,\s*\.rev-tbl td\s*\{[^}]*\}/)
  assert.ok(cellules, 'la regle des cellules du tableau a disparu')
  assert.match(cellules[0], /vertical-align:\s*top/,
    'les cellules s alignent encore par la baseline : une ligne a photo decale ses montants')
})

// ─── LE BUDGET DE L'ECRAN (spec §5, regle gravee de CLAUDE.md) ───────────────

test("LE TEST QUI COMPTE : l'accueil coute DEUX appels, et ce compte NE CROIT PAS avec les biens", async () => {
  // ⚠ CE TEST MANQUAIT, ET C'EST LA SESSION CHEF DE FILE QUI L'A VU avant le
  // merge vers `main` : la spec du lot porte une case « Performance », et trois
  // de ses huit points n'etaient ni traites ni declares « sans objet » — celui
  // qui demande un test comptant les appels etait du nombre.
  //
  // ⚠ CE QU'IL GARDE N'EST PAS UN NOMBRE, C'EST UNE PENTE. Un ecran qui coute
  // 2 appels a 1 bien et 2 a douze est borne ; celui qui coute 2 puis 13 est un
  // « 1 + N » qu'on ne voit pas en developpement — on a tous deux ou trois
  // biens — et qui se voit chez l'hote qui en a trente. C'est la mesure du
  // 22 octobre 2026 en production : 13 appels HTTP et 1 047 556 octets pour
  // QUATRE logements, dont `/api/yield` appele DEUX FOIS PAR BIEN.
  //
  // ⚠ ET LE COMPTE EST DEUX, PAS UN. L'en-tete de la page le dit depuis le lot
  // (b) : `/api/menages` n'est PAS remplace par l'appel d'ecran, et c'est
  // assume. Ecrire « un seul appel » ici serait plus joli et faux ; le test
  // garde ce qui est vrai, et le nomme.
  const appels = async (nBiens) => {
    const biens = Array.from({ length: nBiens }, (_, i) => ({
      id: `uuid-${i}`, provider_property_id: String(200000 + i), name: `Bien ${i}`, currency: 'EUR'
    }))
    const p = ouvrirAujourdhui({ corps: { biens, droits: { reservations: true, menage: true } } })
    p.ouvrirSession(); p.repondreI18n()
    await tours()
    // ⚠ UNE ERREUR DE DEMARRAGE INVALIDE LA MESURE. Sans cette garde, un
    // `init()` qui leve rend zero appel — et « zero » se lirait « aucun appel
    // superflu », c'est-a-dire le meilleur resultat possible. C'est exactement
    // ce qui se passait avant le 27 octobre 2026 : `CacheEcran` n'etait pas
    // injecte, le demarrage levait a chaque chargement, et son `.catch` donnait
    // l'erreur a un `logger` qui ne gardait rien.
    assert.deepEqual(p.erreurs, [], `le demarrage a echoue : ${p.erreurs.join(' / ')}`)
    return p.urls.filter(u => u.includes('/api/'))
  }
  const un = await appels(1)
  const douze = await appels(12)
  assert.strictEqual(douze.length, un.length,
    `le nombre d appels CROIT avec les biens : ${un.length} a 1 bien, ${douze.length} a 12. `
    + 'C est un « 1 + N » : invisible a quatre logements, ruineux a trente.')
  assert.strictEqual(un.length, 2, `l accueil fait ${un.length} appels : ${un.join(', ')}`)
  assert.match(un[0], /\/api\/ecran\/aujourdhui/, `le premier appel n est pas celui de l ecran : ${un[0]}`)
  assert.match(un[1], /\/api\/menages/,
    `le second appel n est plus celui des menages : ${un[1]} — si un appel s ajoute, `
    + 'il doit etre DECLARE dans la spec avant d etre tolere ici')
  // ⚠ ET AUCUN APPEL NE PORTE UNE CLE DE BIEN. Un endpoint appele une fois par
  // bien se verrait deja dans la pente ci-dessus ; un appel UNIQUE portant
  // `?bien=` serait le premier pas vers la boucle, et c est le moment de le
  // refuser, pas quand il y en aura trente.
  for (const u of un) {
    assert.ok(!/[?&](bien|property|property_id)=/.test(u), `un appel porte une cle de bien : ${u}`)
  }
})

test("LE TEST QUI COMPTE : la barre a sa PROPRE colonne, elle ne suit plus le nom", () => {
  // ⚠ DEMANDE DE THIERRY, 27 octobre 2026 : « aligne-les verticalement sur
  // ordinateur, comme la maquette (colonne de largeur fixe) ». La barre vivait
  // dans la cellule du nom, APRES le nom, le compte de sejours et une pastille
  // eventuelle : sa position horizontale suivait donc la longueur du texte, et
  // deux barres de deux lignes voisines ne commencaient jamais au meme endroit.
  // Une barre qui ne s'aligne pas avec sa voisine ne se compare pas d'un coup
  // d'oeil — ce pour quoi elle existe.
  const p = bancRevenus({
    mois: '2026-11',
    par_bien: {
      'uuid-1': parBien({ sejours: 2, total_cents: 70000, recu_cents: 40000, a_venir_cents: 30000 }),
      'uuid-2': parBien({ sejours: 1, total_cents: 30000, recu_cents: 30000, a_venir_cents: 0 })
    },
    total: parBien({ sejours: 3, total_cents: 100000, recu_cents: 70000, a_venir_cents: 30000 }),
    hors_mois: parBien({}), hors_biens: parBien({})
  })
  p.interne.renderRevenus()
  const lignes = p.html('[data-list="revenue-rows"]')
  // La barre est dans une cellule a elle, et PLUS dans celle du nom.
  assert.match(lignes, /<td class="rev-tbl__barre">\s*<span class="revenue-bar"/,
    'la barre n est pas dans sa propre cellule')
  // ⚠ ON INSPECTE CHAQUE CELLULE, PAS LE TEXTE ENTIER. Ma premiere version
  // cherchait `bien-int … revenue-bar … </th>` dans tout le rendu : les
  // quantificateurs paresseux TRAVERSENT la frontiere des rangees, donc le
  // `</th>` trouve etait celui de la ligne SUIVANTE, et le test rougissait sur
  // un code juste. Une expression reguliere sur du balisage doit etre bornee a
  // l'element qu'elle juge.
  const cellulesDuNom = lignes.match(/<th scope="row"[\s\S]*?<\/th>/g) || []
  assert.ok(cellulesDuNom.length > 0, 'aucune cellule de nom rendue')
  for (const c of cellulesDuNom) {
    assert.ok(!/revenue-bar/.test(c),
      'la barre est restee dans la cellule du nom : sa position suivra la longueur du texte')
  }
  // ⚠ ET CHAQUE RANGEE A LE MEME NOMBRE DE CELLULES QUE L'EN-TETE. Une colonne
  // ajoutee a l'en-tete sans l'etre aux rangees decale TOUS les chiffres d'une
  // colonne vers la gauche, en silence — le tableau reste valide, il ment.
  const src = lire('pages/aujourdhui.html')
  // ⚠ L'EN-TETE SE COMPTE SUR LE TABLEAU DU MOIS, PAS SUR LA PAGE. La vue Annee
  // a pose un SECOND tableau le 27 octobre 2026 : compter tous les
  // `<th scope="col">` de la page donnait 9 colonnes pour 5 cellules, et ce
  // test rougissait sur un code juste. C'est la meme erreur que la premiere
  // version de ce test (ci-dessus) : une mesure de balisage doit etre bornee a
  // l'element qu'elle juge.
  const tableauDuMois = (src.match(/<table class="rev-tbl">[\s\S]*?<\/table>/) || [''])[0]
  assert.ok(/data-list="revenue-rows"/.test(tableauDuMois),
    'le tableau du mois n a pas ete isole : la mesure porterait sur un autre')
  const enTete = (tableauDuMois.match(/<th scope="col"/g) || []).length
  const parRangee = (lignes.match(/<tr>/g) || []).map((_, i) =>
    (lignes.split('<tr>')[i + 1] || '').match(/<t[hd][ >]/g) || [])
  for (const cells of parRangee) {
    assert.strictEqual(cells.length, enTete,
      `une rangee porte ${cells.length} cellules pour ${enTete} colonnes : les chiffres sont decales`)
  }
  // Le libelle de la colonne existe pour qui ecoute, sans s'afficher.
  assert.match(src, /<th scope="col" class="rev-tbl__barre">\s*<span class="sr-only" data-i18n="revenue\.col_split">/,
    'la colonne de la barre n a pas de libelle lu : un lecteur d ecran annonce une cellule vide')
  // ⚠ ET `sr-only` N'EST PAS SUR LE `<th>` : une cellule en `position: absolute`
  // quitte la grille du tableau, donc decale toutes les suivantes.
  assert.ok(!/<th[^>]*class="[^"]*sr-only/.test(src),
    'une cellule de tableau porte `sr-only` : elle sort de la grille')
  // La largeur est FIXE : c est ce qui met les barres en colonne.
  const css = lire('shared/ui.css')
  assert.match(css, /\.rev-tbl__barre\s*\{[^}]*width:\s*\d+px/,
    'la colonne de la barre n a pas de largeur fixe : les barres ne s aligneront pas')
})

test("LE TEST QUI COMPTE : la carte ne dit pas DEUX FOIS que le montant est inconnu", () => {
  // ⚠ RECETTE DE THIERRY, 27 octobre 2026 : « corrige le doublon mobile ».
  // Quand tout est refuse, la carte ecrivait « non calculable » DEUX FOIS — en
  // total et en legende — plus la pastille « 2 sans montant » : trois
  // affirmations du meme fait sur trois lignes de 390 px, dont deux identiques
  // au caractere.
  //
  // Ce qu'on garde est ce qui APPORTE quelque chose : le total dit l'etat, la
  // pastille dit le COMBIEN — « un compte n'est jamais redondant avec un
  // etat » — et la legende ne garde que le nombre de sejours.
  const p = bancRevenus({
    mois: '2026-11',
    par_bien: {
      'uuid-1': parBien({ sejours: 2, refuses: { montant: 2, date: 0 }, motifs: { prix_non_calculable: 2 } })
    },
    total: parBien({ sejours: 2, refuses: { montant: 2, date: 0 } }),
    hors_mois: parBien({}), hors_biens: parBien({})
  })
  p.interne.renderRevenus()
  const carte = p.html('[data-list="revenue-cards"]').split('</li>')[0]
  const fois = (carte.match(/revenue\.unavailable/g) || []).length
  assert.strictEqual(fois, 1,
    `« non calculable » est ecrit ${fois} fois sur la meme carte`)
  // Le COMBIEN reste : il n'est pas redondant avec l'etat.
  assert.match(carte, /revenue\.no_amount_short/,
    'la pastille qui dit COMBIEN de sejours manquent a disparu avec le doublon')
  assert.match(carte, /revenue\.stays/, 'le compte de sejours a disparu')

  // ⚠ ET LE TOTAL N'EST PLUS UN `<strong>` IMBRIQUE. La variable `montant`
  // apporte son propre element — `<strong>` pour un chiffre, `<span>` discret
  // pour « non calculable » : l'envelopper donnait un gras sur un gras, et une
  // mention discrete promue en fort.
  const chiffree = bancRevenus({
    mois: '2026-11',
    par_bien: { 'uuid-1': parBien({ sejours: 1, total_cents: 30000, recu_cents: 30000 }) },
    total: parBien({ sejours: 1, total_cents: 30000, recu_cents: 30000 }),
    hors_mois: parBien({}), hors_biens: parBien({})
  })
  chiffree.interne.renderRevenus()
  const c2 = chiffree.html('[data-list="revenue-cards"]').split('</li>')[0]
  assert.ok(!/<strong[^>]*>\s*<strong/.test(c2), `un strong est imbrique dans un strong : ${c2}`)
})

test("LE TEST QUI COMPTE : les lignes affichees SOMMENT au chiffre affiche du bandeau", () => {
  // ⚠ RECETTE DE THIERRY EN PRODUCTION, 27 octobre 2026 : « A venir octobre
  // affiche 935 € alors que les lignes font 168 + 160 + 608 = 936 ». Ce n'etait
  // pas un calcul faux, c'etait de l'arithmetique : `I18n.money` arrondit a
  // l'euro, et arrondir chacun puis sommer ne donne pas arrondir la somme.
  //   167,68 + 159,54 + 608,04 = 935,26
  //   arrondis un par un : 168 + 160 + 608 = 936
  //   arrondi de la somme :                  935
  // Les chiffres ci-dessous sont EXACTEMENT ceux de la production ce jour-la.
  const biens = [
    { id: 'uuid-1', provider_property_id: '1', name: 'Coeur de vie 23', currency: 'EUR' },
    { id: 'uuid-2', provider_property_id: '2', name: 'La bulle', currency: 'EUR' },
    { id: 'uuid-3', provider_property_id: '3', name: 'Ofuro Futari', currency: 'EUR' }
  ]
  const p = bancRevenus({
    mois: '2026-10',
    par_bien: {
      'uuid-1': parBien({ sejours: 1, a_venir_cents: 16768, total_cents: 16768 }),
      'uuid-2': parBien({ sejours: 1, a_venir_cents: 15954, total_cents: 15954 }),
      'uuid-3': parBien({ sejours: 1, a_venir_cents: 60804, total_cents: 60804 })
    },
    total: parBien({ sejours: 3, a_venir_cents: 93526, total_cents: 93526 }),
    hors_mois: parBien({}), hors_biens: parBien({})
  }, biens)
  p.interne.renderRevenus()

  // Le double de `I18n.money` rend le NOMBRE : on peut donc l'additionner.
  const nombres = (html) => (html.match(/>(-?\d+)</g) || []).map(x => Number(x.slice(1, -1)))
  const lignes = p.html('[data-list="revenue-rows"]')
  // Colonne « A venir » : la deuxieme cellule de chiffres de chaque rangee.
  const parRangee = lignes.split('<tr>').slice(1)
  assert.strictEqual(parRangee.length, 3, 'trois rangees attendues')
  const aVenir = parRangee.map(r => {
    const cells = r.match(/<td class="rev-tbl__num">[\s\S]*?<\/td>/g) || []
    return nombres(cells[1])[0]
  })
  const bandeau = Number(p.cache('[data-bind="revenue-upcoming"]').textContent)
  assert.strictEqual(aVenir.reduce((a, b) => a + b, 0), bandeau,
    `les lignes font ${aVenir.join(' + ')} = ${aVenir.reduce((a, b) => a + b, 0)} `
    + `et le bandeau dit ${bandeau} : l hote ne peut pas recouper son propre ecran`)
  assert.strictEqual(bandeau, 935, 'le bandeau ne dit plus l arrondi du total exact')
  assert.deepEqual(aVenir, [168, 159, 608],
    'la repartition au plus fort reste ne donne plus l euro manquant a la plus forte decimale')

  // ⚠ ET DANS L'AUTRE SENS : le total de chaque ligne est la somme de ses deux
  // colonnes AFFICHEES. Repartir la colonne « Total » separement la ferait
  // tomber juste en colonne et faux en ligne — un bien afficherait 159 + 0 = 160.
  for (const r of parRangee) {
    const cells = r.match(/<td class="rev-tbl__num">[\s\S]*?<\/td>/g) || []
    const [recu, venir, total] = cells.map(c => nombres(c)[0])
    assert.strictEqual(recu + venir, total,
      `une rangee dit ${recu} + ${venir} mais ${total} en total`)
  }

  // Et le bandeau s'additionne aussi : Total = Recu + A venir, sous les yeux.
  const bRecu = Number(p.cache('[data-bind="revenue-received"]').textContent)
  const bTotal = Number(p.cache('[data-bind="revenue-total"]').textContent)
  assert.strictEqual(bRecu + bandeau, bTotal,
    `le bandeau dit ${bRecu} + ${bandeau} mais ${bTotal} en total`)
})

test("LE TEST QUI COMPTE : la repartition tient l INVARIANT, pas une liste de valeurs", () => {
  // ⚠ CE TEST VIENT D'UNE EPREUVE FAITE PAR LA SESSION CHEF DE FILE, dans son
  // bac a sable : 20 008 jeux, aucun ecart. Il vaut mieux dans le depot, pour
  // la meme raison qu'elle m'a donnee ce matin a propos d'un autre recensement —
  // un garde-fou qui vit ailleurs ne protege personne du prochain remaniement.
  //
  // ⚠ ET IL MESURE L'INVARIANT, PAS DES VALEURS ATTENDUES. La meme session a
  // failli me remonter un faux constat sur de l'argent en ecrivant « 49 €
  // attendus » pour un total de 49,50 € — `Math.round(49.5)` vaut 50. L'attendu
  // etait faux, pas la fonction. Une valeur ecrite a la main se trompe ; un
  // invariant, non.
  const p = ouvrirAujourdhui({ sansInit: true, corps: {} })
  const repartir = p.interne.repartirEnEuros
  assert.strictEqual(typeof repartir, 'function', 'la repartition n est plus exposee par le banc')

  // ⚠ TIRAGE DETERMINISTE. Un test aleatoire qui rougit une fois sur mille et
  // qu'on ne peut pas rejouer est pire qu'aucun test : on le relance, il passe,
  // et on classe l'incident. La graine est fixe, donc l'echec se reproduit.
  let graine = 20261027
  const alea = () => { graine = (graine * 1103515245 + 12345) % 2147483648; return graine / 2147483648 }
  const entre = (a, b) => Math.floor(alea() * (b - a + 1)) + a

  const cas = [
    [[16768, 15954, 60804]],            // les chiffres de la production, 27 octobre 2026
    [[]],                               // aucun bien
    [[0, 0, 0]],                        // trois biens a zero
    [[93526]],                          // un seul bien
    [[-16768, 15954, 60804]],           // un remboursement : reste NEGATIF
    [[4950]],                           // 49,50 € — `Math.round` arrondit a 50, pas 49
    [[50, 50, 50, 50]],                 // quatre fois un demi-euro
    [[1, 1, 1]]                         // des centimes qui ne font pas un euro
  ]
  for (let i = 0; i < 2000; i++) {
    const n = entre(1, 30)
    cas.push([Array.from({ length: n }, () => entre(-50000, 500000))])
  }

  let verifies = 0
  for (const [liste] of cas) {
    const total = liste.reduce((a, b) => a + b, 0)
    const r = repartir(liste)
    const cible = Math.round(total / 100)
    assert.strictEqual(r.reduce((a, b) => a + b, 0), cible,
      `[${liste}] rend ${r} = ${r.reduce((a, b) => a + b, 0)}, cible ${cible}`)
    assert.strictEqual(r.length, liste.length, 'une ligne a disparu de la repartition')
    // Aucune ligne ne s'eloigne de plus d'un euro de son propre arrondi : c'est
    // le COUT annonce de la methode, et il doit rester borne.
    for (let k = 0; k < liste.length; k++) {
      assert.ok(Math.abs(r[k] - Math.round(liste[k] / 100)) <= 1,
        `la ligne ${k} de [${liste}] s ecarte de ${r[k] - Math.round(liste[k] / 100)} euros`)
    }
    // Deterministe : deux rendus de la meme donnee ne peuvent pas differer.
    assert.deepEqual(repartir(liste), r, 'la repartition n est pas deterministe')
    verifies++
  }
  assert.ok(verifies >= 2000, `${verifies} jeu(x) verifie(s) : le tirage n a rien produit`)
})

test("LE TEST QUI COMPTE : l argent d un logement SUPPRIME ne se pose pas sur les lignes vivantes", () => {
  // ⚠ RELEVE PAR LA SESSION CHEF DE FILE, 27 octobre 2026, sur ma propre
  // repartition. `revenus_du_mois` groupe par `property_uuid` SANS jointure sur
  // `properties` : un sejour d'un logement supprime garde son uuid, entre donc
  // dans le total du compte, et n'a AUCUNE ligne a l'ecran — `etat.biens` ne le
  // contient plus. Ma premiere version passait `T.recu_cents` comme cible alors
  // que la liste ne porte que les biens AFFICHES : les euros manquants se
  // posaient sur les lignes des biens VIVANTS, +1 € chacune. Une ligne portait
  // de l'argent qui n'est pas le sien.
  //
  // La fonction calcule desormais sa cible elle-meme, ce qui rend ce mesusage
  // impossible. Ce test garde le RESULTAT a l'ecran : deux biens vivants a
  // 167,68 et 159,54, plus 100 € sur un logement disparu du compte.
  const biens = [
    { id: 'uuid-1', provider_property_id: '1', name: 'Vivant A', currency: 'EUR' },
    { id: 'uuid-2', provider_property_id: '2', name: 'Vivant B', currency: 'EUR' }
  ]
  const p = bancRevenus({
    mois: '2026-10',
    par_bien: {
      'uuid-1': parBien({ sejours: 1, recu_cents: 16768, total_cents: 16768 }),
      'uuid-2': parBien({ sejours: 1, recu_cents: 15954, total_cents: 15954 }),
      // Le logement supprime : present dans l'agregat, absent de `etat.biens`.
      'uuid-DISPARU': parBien({ sejours: 1, recu_cents: 10000, total_cents: 10000 })
    },
    total: parBien({ sejours: 3, recu_cents: 42722, total_cents: 42722 }),
    hors_mois: parBien({}),
    // ⚠ LA RESERVE PORTE CE SEJOUR, ET C'EST LE POINT. Ma premiere version
    // mettait `hors_biens` a zero et assertait un ecart « MUET » — elle
    // modelisait un etat IMPOSSIBLE. La fonction SQL deployee
    // (`2026-10-26-revenus-hors-biens.sql`) compte les uuid dont
    // `not exists (select 1 from properties …)`, donc un logement supprime
    // entre dans la reserve. J'avais recopie « elle ne compte que les NULS »
    // d'une analyse portant sur la migration 3, remplacee depuis.
    hors_biens: parBien({ sejours: 1, total_cents: 10000 })
  }, biens)
  p.interne.renderRevenus()

  const nombres = (h) => (h.match(/>(-?\d+)</g) || []).map(x => Number(x.slice(1, -1)))
  const rangees = p.html('[data-list="revenue-rows"]').split('<tr>').slice(1)
  assert.strictEqual(rangees.length, 2, 'le logement supprime ne doit pas fabriquer une ligne')
  const recus = rangees.map(r => nombres((r.match(/<td class="rev-tbl__num">[\s\S]*?<\/td>/g) || [])[0])[0])
  // 167,68 et 159,54 : chacun a son propre arrondi au plus fort reste SUR LEUR
  // SOMME (327,22 -> 327), et AUCUN euro venu du logement disparu.
  assert.deepEqual(recus, [168, 159],
    `les lignes portent ${recus.join(' + ')} : un euro orphelin s y est pose`)
  assert.strictEqual(recus.reduce((a, b) => a + b, 0), 327,
    'la somme des lignes n est plus l arrondi de leur propre somme')

  // ⚠ L'ECART AVEC LE BANDEAU RESTE — il est REEL, le total du compte contient
  // cet argent — MAIS IL EST DIT. La reserve le nomme en toutes lettres :
  // « N sejours rattaches a aucun de vos logements : X € dans le total, sur
  // AUCUNE LIGNE ». C'est precisement la phrase que ce cas appelle.
  const bandeau = Number(p.cache('[data-bind="revenue-received"]').textContent)
  assert.strictEqual(bandeau, 427, 'le bandeau ne compte plus le logement supprime')
  const ecart = bandeau - recus.reduce((a, b) => a + b, 0)
  assert.strictEqual(ecart, 100, 'l ecart entre le bandeau et les lignes a change de valeur')
  const reserve = p.cache('[data-bind="revenue-reserves"]')
  assert.strictEqual(reserve.hidden, false, 'la reserve est masquee : l ecart serait MUET')
  assert.match(reserve.textContent, /revenue\.hors_biens/,
    'la reserve ne dit pas les sejours rattaches a aucun logement')
})

// ─── LA VUE ANNEE DU BLOC REVENUS ──────────────────────────────────────────
// ⚠ AUCUN TEST NE JUGEAIT CE RENDU avant le 27 octobre 2026 : l'endpoint avait
// les siens, l'ecran aucun. Ce qui suit APPELLE `renderAnnee` et lit ce qu'elle
// pose, parce qu'un test qui cherche une forme dans le texte de la page ne dit
// rien de l'execution (REVIEW.md regle 20).

// Le montant d'un libelle, en euros entiers. ⚠ ON RETIRE TOUT CE QUI N'EST PAS
// UN CHIFFRE : le separateur de milliers de `Intl` est une espace FINE
// INSECABLE (U+202F), que `\s` ne couvre pas dans toutes les versions — une
// comparaison de texte echouerait sans que rien ne soit visible a l'oeil.
const euros = (texte) => Number(String(texte).replace(/[^\d]/g, ''))

// Un mois ENCAISSE, et un mois seulement RESERVE : le partage recu/a venir
// decide ou s'arrete le trait plein, donc quels mois sont « a venir ».
const recuDe = (t) => ({ sejours: 1, total_cents: t, recu_cents: t, a_venir_cents: 0, bruts: 0, sans_montant: 0 })
const aVenirDe = (t) => ({ sejours: 1, total_cents: t, recu_cents: 0, a_venir_cents: t, bruts: 0, sans_montant: 0 })

// Un mois de l'annee, au format que l'endpoint rend.
const mo = (total, sejours = 1) => ({
  sejours, total_cents: total, recu_cents: total, a_venir_cents: 0, bruts: 0, sans_montant: 0
})

// ⚠ LES DATES SONT FIGEES **ET** INJECTEES : `renderAnnee` ne lit pas l'horloge,
// elle lit `etat.aujourdHui`. Regle du depot : *dates relatives si le test lit
// l'horloge, dates figees s'il injecte le temps.* Des dates relatives ici
// feraient varier la tranche comparee d'un jour a l'autre.
function bancAnnee (options = {}) {
  const p = ouvrirAujourdhui({ sansInit: true, etroit: options.etroit === true })
  const an = options.an || 2026
  p.interne.etat.vueRevenus = 'annee'
  p.interne.etat.anneeRevenus = an
  p.interne.etat.anneeEtat = 'ok'
  p.interne.etat.aujourdHui = options.aujourdHui || '2026-10-15'
  p.interne.etat.biens = options.biens || [
    { id: 'uuid-1', name: 'La bulle' }, { id: 'uuid-2', name: 'Colomiers' }
  ]
  p.interne.etat.filtreAnnee = options.filtre || null
  // Les bandes deja chargees, comme si le clic sur la pastille avait rendu.
  // ⚠ LA CLE DU CACHE EST « annee|bien » depuis la review : une bande ne vaut
  // que pour la fenetre d'annees qu'elle couvre.
  p.interne.etat.comparablesParBien = Object.fromEntries(
    Object.entries(options.comparables || {}).map(([b, v]) => [`${options.an || 2026}|${b}`, v]))
  p.interne.etat.annee = options.annee
  p.interne.renderAnnee()
  return p
}

test("LE TEST QUI COMPTE : l annee EN COURS se compare A DATE, pas sur douze mois", () => {
  // ⚠ DECISION 2 DE THIERRY : « Le cumul a date ne vaut que pour l'annee en
  // cours. » Le grand total doit donc s'arreter au mois courant — novembre et
  // decembre sont DEJA RESERVES, ils se tracent mais ne se comptent pas dans la
  // comparaison. Sommer douze mois ferait un chiffre qui n'a pas de pendant
  // en N-1 et transformerait un carnet de reservations en chiffre d'affaires.
  const p = bancAnnee({
    aujourdHui: '2026-10-15',
    annee: {
      total: { '2026-09': mo(10000), '2026-10': mo(20000), '2026-11': mo(500000) },
      par_bien: {}, hors_biens: {}
    }
  })
  const total = p.cache('[data-bind="revenue-annee-n"]').textContent
  // ⚠ ON COMPARE LE NOMBRE, PAS UNE SOUS-CHAINE. Ma premiere version cherchait
  // « 300 » dans le texte et refusait « 5000 » : elle acceptait donc **5 300 €**
  // — la somme des douze mois — parce qu'elle contient « 300 ». Mesure du
  // 27 octobre 2026 : la mutation « sommePeriode(..., 12) » laissait ce test
  // VERT. Une assertion de sous-chaine sur un montant formate est un faux vert.
  assert.strictEqual(euros(total), 300,
    `le total de l en-tete vaut « ${total} » au lieu de 300 € : novembre (5 000 €, a venir) y est entre`)
})

test("LE TEST QUI COMPTE : une annee PASSEE se compare en ENTIER", () => {
  // Le pendant de la decision 2 : sur 2025, les douze mois comptent — aucun
  // n'est « a venir ». S'arreter en octobre inventerait une baisse de deux mois.
  const p = bancAnnee({
    an: 2025,
    aujourdHui: '2026-10-15',
    annee: {
      total: { '2025-10': mo(10000), '2025-12': mo(30000) },
      par_bien: {}, hors_biens: {}
    }
  })
  const total = p.cache('[data-bind="revenue-annee-n"]').textContent
  assert.strictEqual(euros(total), 400,
    `le total de 2025 vaut « ${total} » au lieu de 400 € : decembre manque, l annee passee est tronquee au mois courant`)
})

test("LE TEST QUI COMPTE : aucun pourcentage au niveau du COMPTE", () => {
  // ⚠ DECISION 1 DE THIERRY, confirmee le 27 octobre APRES la maquette — qui
  // en portait un (« +14 % »). Les deux annees ne portent pas les memes
  // logements : un bien arrive en cours d'annee gonfle N sans rien devoir a
  // l'exploitation. L'ecart vit sur les LIGNES, ou les deux annees parlent du
  // meme logement.
  const p = bancAnnee({
    annee: {
      total: { '2026-05': mo(50000), '2025-05': mo(10000) },
      par_bien: {}, hors_biens: {}
    }
  })
  for (const b of ['revenue-annee-n', 'revenue-annee-n1', 'revenue-annee-periode']) {
    const txt = p.cache(`[data-bind="${b}"]`).textContent
    assert.ok(!/%/.test(txt),
      `« ${b} » affiche « ${txt} » : un pourcentage est revenu au niveau du compte`)
  }
})

test("LE TEST QUI COMPTE : la pastille pilote l EN-TETE, et l en-tete se NOMME", () => {
  // ⚠ CE TEST A CHANGE DE REGLE LE 28 OCTOBRE 2026, ET CE N EST PAS UN
  // REVIREMENT. Il exigeait que l en-tete NE suive PAS la pastille, et il avait
  // raison tant que rien ne disait de quoi le grand chiffre parlait : « un
  // chiffre qui change sous une pastille est ambigu ».
  // La decision Q1 de Thierry leve l ambiguite autrement, et mieux : l en-tete
  // suit la pastille ET SE NOMME (« La bulle · janvier -> octobre 2026 »). Ce
  // que l ancien test protegeait — on sait toujours de quoi parle le chiffre —
  // reste donc garde, par le prefixe au lieu de l immobilite.
  const annee = {
    total: { '2026-05': mo(50000), '2025-05': mo(40000) },
    par_bien: {
      'uuid-1': { '2026-05': mo(20000), '2025-05': mo(10000) },
      'uuid-2': { '2026-05': mo(30000), '2025-05': mo(30000) }
    },
    hors_biens: {}
  }
  const biens = [{ id: 'uuid-1', name: 'A' }, { id: 'uuid-2', name: 'B' }]
  const sansFiltre = bancAnnee({ annee, biens })
  const tous = sansFiltre.cache('[data-bind="revenue-annee-n"]').textContent
  const filtre = bancAnnee({ annee, biens, filtre: 'uuid-1' })
  const duBien = filtre.cache('[data-bind="revenue-annee-n"]').textContent
  assert.notStrictEqual(duBien, tous,
    `l en-tete affiche « ${duBien} » comme sans filtre : la pastille ne le pilote pas`)
  assert.strictEqual(euros(duBien), 200,
    `l en-tete vaut ${euros(duBien)} € au lieu des 200 € du bien choisi`)
  // ⚠ ET IL SE NOMME : sans le prefixe, le chiffre changerait sans qu on sache
  // de quoi il parle — c est ce que l ancienne regle evitait en l immobilisant.
  assert.match(filtre.cache('[data-bind="revenue-annee-periode"]').textContent, /^A ·/,
    'l en-tete filtre ne nomme pas le logement : le chiffre change sans se declarer')
  // Le compte, lui, n a toujours AUCUN pourcentage (decision 1, inchangee).
  assert.strictEqual(sansFiltre.cache('[data-bind="revenue-annee-ecart"]').hidden, true,
    'un pourcentage est apparu au niveau du compte')
  assert.strictEqual(filtre.cache('[data-bind="revenue-annee-ecart"]').hidden, false,
    'le logement choisi n affiche pas son ecart, alors que les deux annees parlent du meme bien')
  // ⚠ ET LA COURBE, ELLE, A CHANGE DE SERIE — mesure par le NOMBRE du palier
  // haut, pas par une sous-chaine. Ma premiere version cherchait `/50\s?000|500,0/`
  // dans le SVG : avec 500 €, le SVG non filtre ecrit « 500 € » et « · 500 »,
  // aucune des deux formes cherchees. Mutation `parMois = a.total` (la pastille
  // ne filtre plus rien) : le test restait VERT. Meme famille de faux vert que
  // deux tests plus haut, au meme endroit du raisonnement.
  const hautDeLAxe = (p) => {
    const svg = p.cache('[data-bind="revenue-annee-courbe"]').innerHTML
    assert.ok(svg.includes('<svg'), 'la courbe ne rend plus de SVG')
    const grads = [...svg.matchAll(/class="cm-grad"[^>]*>([^<]*)</g)].map(m => m[1])
    return euros(grads[grads.length - 1])
  }
  const hautTous = hautDeLAxe(bancAnnee({ annee, biens }))
  const hautFiltre = hautDeLAxe(filtre)
  assert.ok(hautFiltre < hautTous,
    `le haut de l axe vaut ${hautFiltre} filtre contre ${hautTous} pour le compte : la pastille ne filtre pas la courbe`)
})

test("LE TEST QUI COMPTE : un logement sans N-1 dit « nouveau », pas « +0 % »", () => {
  // « Pas comparable » n est jamais « +0 % » : meme regle que « non calculable
  // n est jamais zero ».
  const p = bancAnnee({
    biens: [{ id: 'uuid-2', name: 'Colomiers' }],
    annee: {
      total: { '2026-05': mo(30000) },
      par_bien: { 'uuid-2': { '2026-05': mo(30000) } },
      hors_biens: {}
    }
  })
  const lignes = p.cache('[data-list="revenue-annee-lignes"]').innerHTML
  assert.ok(/nouveau/i.test(lignes),
    'un logement sans annee precedente n est pas nomme comme tel')
  assert.ok(!/\+0\s?%/.test(lignes),
    'un logement sans annee precedente affiche « +0 % » : une absence devenue un fait')
})

test("LE TEST QUI COMPTE : le haut de l axe est un palier ROND", () => {
  // Mesure au banc du 27 octobre 2026 : sur un maximum de 12 600 €, trois
  // paliers calcules sur le maximum reel ecrivaient « 0 / 6,3 k / 12,6 k ».
  // Un axe sert a SITUER, et 6,3 k ne situe rien.
  const p = bancAnnee({
    annee: { total: { '2026-05': mo(1260000) }, par_bien: {}, hors_biens: {} }
  })
  const svg = p.cache('[data-bind="revenue-annee-courbe"]').innerHTML
  const grads = [...svg.matchAll(/class="cm-grad"[^>]*>([^<]*)</g)].map(m => m[1])
  assert.strictEqual(grads.length, 3, `l axe porte ${grads.length} paliers, la maquette en veut 3`)
  // Le palier du haut doit etre un multiple rond : 16 k, pas 12,6 k.
  const chiffres = grads.map(g => Number(g.replace(/[^\d,.]/g, '').replace(',', '.')))
  assert.ok(chiffres[2] > 12.6 && Number.isInteger(chiffres[2]),
    `le haut de l axe vaut « ${grads[2]} » : il suit le maximum reel au lieu d etre releve`)
})

test("LE TEST QUI COMPTE : au telephone, le repere RETRECIT", () => {
  // ⚠ LE `viewBox` EST MIS A L ECHELLE DE SON CADRE, DONC LES TEXTES AUSSI :
  // 680 unites rendues dans 358 px affichent les libelles a 5,8 px. Mesure au
  // banc le 27 octobre 2026 — graduations et initiales illisibles, et rien ne
  // le signalait : le SVG etait parfaitement valide.
  const donnees = { total: { '2026-05': mo(50000) }, par_bien: {}, hors_biens: {} }
  const large = bancAnnee({ annee: donnees }).cache('[data-bind="revenue-annee-courbe"]').innerHTML
  const etroit = bancAnnee({ annee: donnees, etroit: true }).cache('[data-bind="revenue-annee-courbe"]').innerHTML
  assert.match(large, /viewBox="0 0 680 220"/, 'le repere de l ordinateur a change')
  assert.match(etroit, /viewBox="0 0 360 200"/,
    'le telephone dessine encore dans le repere large : ses libelles tomberont a 5,8 px')
})

test("LE TEST QUI COMPTE : le trait « deja reserve » REJOINT le realise", () => {
  // Sans chevauchement d un mois, le trait se couperait au changement de style
  // et la courbe aurait un trou la ou il n y en a pas.
  const p = bancAnnee({
    aujourdHui: '2026-10-15',
    annee: {
      total: { '2026-09': mo(10000), '2026-10': mo(20000), '2026-11': mo(30000) },
      par_bien: {}, hors_biens: {}
    }
  })
  const svg = p.cache('[data-bind="revenue-annee-courbe"]').innerHTML
  const pointilles = [...svg.matchAll(/<path d="([^"]*)"[^>]*stroke-dasharray/g)].map(m => m[1])
  assert.strictEqual(pointilles.length, 1, 'il n y a plus exactement un trait pointille')
  const points = (pointilles[0].match(/[ML]/g) || []).length
  assert.ok(points >= 2,
    `le trait « deja reserve » n a que ${points} point : il part de novembre au lieu de rejoindre octobre`)
})

// ─── CE QUE LA REVIEW DU 28 OCTOBRE 2026 A TROUVE, ET QUE RIEN NE GARDAIT ───
// Trois constats GRAVES et quatre MOYENS portaient sur du rendu neuf qui
// n'avait AUCUN garde-fou : les reserves, l'echappement, la fenetre des lignes,
// l'arrondi. Chacun de ces tests ferme un de ces constats.

test("LE TEST QUI COMPTE : un montant NON CALCULABLE ne s affiche pas « 0 € »", () => {
  // ⚠ LE DEFAUT QUE LA VUE MOIS A FERME EN TROIS ENDROITS, rouvert en entier
  // par la vue Annee — avec un porteur de plus, le POINT de la courbe. Avec
  // `{sejours: 2, total_cents: 0, sans_montant: 2}`, l'ecran affirmait « 0 € »
  // en tete, « 0 € » sur la ligne, posait un point PLEIN sur l'axe, et ne
  // disait rien des deux sejours. « Non calculable » n'est JAMAIS zero.
  const refus = { sejours: 2, total_cents: 0, recu_cents: 0, a_venir_cents: 0, bruts: 0, sans_montant: 2 }
  const p = bancAnnee({
    biens: [{ id: 'uuid-1', name: 'La bulle' }],
    annee: { total: { '2026-09': refus }, par_bien: { 'uuid-1': { '2026-09': refus } }, hors_biens: {} }
  })
  // ⚠ ON ASSERTE LA CLE, PAS LE TEXTE : le banc rend les cles i18n telles
  // quelles, et une reformulation francaise ne doit pas faire rougir un test
  // qui parle d'une REGLE.
  const entete = p.cache('[data-bind="revenue-annee-n"]').textContent
  assert.strictEqual(entete, 'revenue.unavailable',
    `l en-tete affiche « ${entete} » au lieu de « non calculable » : un faux zero la ou le coeur ne sait pas`)
  const lignes = p.cache('[data-list="revenue-annee-lignes"]').innerHTML
  assert.ok(!/>\s*0\s*€/.test(lignes), `la ligne affiche un faux zero : ${lignes.slice(0, 200)}`)
  // ⚠ ET LA COURBE NE POSE PAS DE POINT SUR L AXE : un point plein a y=max dit
  // « ce mois-la, zero euro ». Le module coupe le trait sur un `null`.
  const svg = p.cache('[data-bind="revenue-annee-courbe"]').innerHTML
  assert.ok(!/<circle[^>]*fill="var\(--ink\)"/.test(svg),
    'la courbe pose un point plein : elle affirme zero euro la ou le montant est inconnu')
  // Et les deux sejours sont COMPTES dans une reserve.
  const res = p.cache('[data-bind="revenue-annee-reserves"]')
  assert.strictEqual(res.hidden, false, 'aucune reserve : deux sejours sans montant passent sous silence')
  // ⚠ LE BANC N'INTERPOLE PAS `{n}` : on ne peut pas lire « 2 » dans le texte.
  // On prouve donc que la reserve SUIT LA DONNEE par un contre-cas — sans
  // sejour refuse, elle ne doit pas apparaitre. Une reserve posee en dur
  // passerait le premier test et echouerait celui-ci.
  assert.match(res.textContent, /revenue\.no_amount/,
    `la reserve ne parle pas des montants non calculables : « ${res.textContent} »`)
  const sansRefus = bancAnnee({
    biens: [{ id: 'uuid-1', name: 'La bulle' }],
    annee: {
      total: { '2026-09': mo(10000) },
      par_bien: { 'uuid-1': { '2026-09': mo(10000) } },
      hors_biens: {}
    }
  })
  assert.ok(!/revenue\.no_amount/.test(sansRefus.cache('[data-bind="revenue-annee-reserves"]').textContent),
    'la reserve des montants non calculables s affiche sans aucun sejour refuse : elle est posee en dur')
})

test("LE TEST QUI COMPTE : l argent HORS BIENS de N-1 est declare, pas seulement celui de N", () => {
  // ⚠ LE SECOND CONSTAT GRAVE, rejoue du cote N-1 : un bien SUPPRIME qui avait
  // encaisse en juin 2025 mettait son montant dans le grand chiffre de N-1 et
  // sur AUCUNE ligne, sans un mot. C'est le defaut deja paye sur la vue Mois
  // (« 1 000 € d'ecart muet entre le bandeau et la somme des lignes »).
  const p = bancAnnee({
    biens: [{ id: 'uuid-1', name: 'La bulle' }],
    annee: {
      // ⚠ L'ARGENT HORS BIENS N'EXISTE QU'EN N-1 : c'est ce qui fait mordre.
      // Avec du hors-biens des DEUX cotes, une reserve qui ne regarde que `an`
      // serait quand meme rendue, et le test passerait sur un code faux.
      total: { '2026-05': mo(10000), '2025-05': mo(10000), '2025-06': mo(99900) },
      par_bien: { 'uuid-1': { '2026-05': mo(10000), '2025-05': mo(10000) } },
      hors_biens: { '2025-06': mo(99900) }
    }
  })
  const res = p.cache('[data-bind="revenue-annee-reserves"]')
  assert.strictEqual(res.hidden, false, 'aucune reserve : 999 € de N-1 sont dans le total et sur aucune ligne')
  assert.match(res.textContent, /revenue\.annee_hors_biens/,
    `la reserve ne parle pas de l argent hors biens : « ${res.textContent} »`)
})

test("LE TEST QUI COMPTE : « nouveau » se verifie sur l ANNEE, pas sur la fenetre comparee", () => {
  // ⚠ UN FAIT FAUX, MESURE : un bien qui a vendu en DECEMBRE 2025 et qui a du
  // deja-reserve en NOVEMBRE 2026 n'a rien entre janvier et octobre des deux
  // cotes. Il etait annonce « nouveau en 2026 » alors qu il exploite depuis
  // l an dernier. Et ce lot avait SUPPRIME la formulation honnete qui existait
  // (« pas d annee precedente a comparer ») pour la remplacer par ce fait.
  const p = bancAnnee({
    aujourdHui: '2026-10-15',
    biens: [{ id: 'uuid-1', name: 'La bulle' }],
    annee: {
      total: { '2025-12': mo(500000), '2026-11': mo(400000) },
      par_bien: { 'uuid-1': { '2025-12': mo(500000), '2026-11': mo(400000) } },
      hors_biens: {}
    }
  })
  const lignes = p.cache('[data-list="revenue-annee-lignes"]').innerHTML
  assert.ok(!/revenue\.annee_nouveau/.test(lignes),
    `la ligne dit « nouveau » d un bien qui a vendu en 2025 : ${lignes.slice(0, 300)}`)
  assert.match(lignes, /revenue\.sans_comparaison/,
    'la ligne n explique pas pourquoi l ecart manque : une absence se dit avec son motif')
})

test("LE TEST QUI COMPTE : les lignes AFFICHEES somment au chiffre AFFICHE", () => {
  // ⚠ LE CONSTAT DE RECETTE DE THIERRY DU 27 OCTOBRE, sur la vue Mois : deux
  // biens a 100,50 € donnaient « 201 € » en tete et « 101 € + 101 € » en
  // lignes. La vue Annee met le grand total et les lignes dans le MEME bloc,
  // donc l ecart y saute encore plus aux yeux.
  const p = bancAnnee({
    biens: [{ id: 'uuid-1', name: 'A' }, { id: 'uuid-2', name: 'B' }],
    annee: {
      total: { '2026-05': mo(20100, 2) },
      par_bien: { 'uuid-1': { '2026-05': mo(10050) }, 'uuid-2': { '2026-05': mo(10050) } },
      hors_biens: {}
    }
  })
  const entete = euros(p.cache('[data-bind="revenue-annee-n"]').textContent)
  const lignes = p.cache('[data-list="revenue-annee-lignes"]').innerHTML
  const colonneN = [...lignes.matchAll(/<td class="rev-tbl__num">([^<]*)</g)].map(m => euros(m[1]))
  const somme = colonneN.reduce((a, b) => a + b, 0)
  assert.strictEqual(somme, entete,
    `les lignes font ${somme} € pour un en-tete a ${entete} € : l arrondi par ligne ne concorde pas`)
})

test("LE TEST QUI COMPTE : les montants BRUTS sont dits dans la vue Annee aussi", () => {
  // ⚠ UN RETRAIT DE FOND PAR OMISSION DE FORME, ce que la regle de refonte
  // interdit nommement. La vue Mois dit les bruts DEUX fois ; la vue Annee ne
  // les disait pas du tout, alors qu ils entrent dans le total et dans l ecart
  // en % comme s ils etaient nets.
  const avecBrut = { sejours: 1, total_cents: 50000, recu_cents: 50000, a_venir_cents: 0, bruts: 1, sans_montant: 0 }
  const p = bancAnnee({
    biens: [{ id: 'uuid-1', name: 'La bulle' }],
    annee: { total: { '2026-05': avecBrut }, par_bien: { 'uuid-1': { '2026-05': avecBrut } }, hors_biens: {} }
  })
  const res = p.cache('[data-bind="revenue-annee-reserves"]')
  assert.strictEqual(res.hidden, false, 'aucune reserve : un montant brut passe pour un net')
  assert.match(res.textContent, /revenue\.gross_count/,
    `la reserve ne parle pas des bruts : « ${res.textContent} »`)
})

test("LE TEST QUI COMPTE : un `total` ABSENT se dit, il ne s affiche pas « 0 € »", () => {
  // La vue Mois ecrit la forme lache `!rev.total` ; la vue Annee testait
  // `=== null`. Avec un `total` absent mais un `par_bien` peuplé, la garde
  // stricte laissait passer : « 0 € » en tete au-dessus d une ligne a 1 234 €.
  const p = bancAnnee({
    biens: [{ id: 'uuid-1', name: 'La bulle' }],
    annee: { par_bien: { 'uuid-1': { '2026-05': mo(123400) } }, hors_biens: {} }
  })
  const etatTxt = p.cache('[data-bind="revenue-annee-etat"]')
  assert.strictEqual(etatTxt.hidden, false,
    'aucun message d etat : l ecran affirme un total alors que la lecture n en porte pas')
})

test("LE TEST QUI COMPTE : le nom d un logement est ECHAPPE partout", () => {
  // Le nom vient du compte, donc d une saisie. Trois chemins l inserent en
  // `innerHTML` : la pastille de filtre, la ligne du tableau, la carte
  // telephone. Aucun n etait garde.
  const p = bancAnnee({
    biens: [{ id: 'uuid-1', name: '<img src=x onerror=alert(1)>' }],
    annee: {
      total: { '2026-05': mo(10000) },
      par_bien: { 'uuid-1': { '2026-05': mo(10000) } },
      hors_biens: {}
    }
  })
  for (const sel of ['[data-list="revenue-annee-filtres"]', '[data-list="revenue-annee-lignes"]',
    '[data-list="revenue-annee-cartes"]']) {
    const html = p.cache(sel).innerHTML
    assert.ok(!/<img/i.test(html), `${sel} insere le nom sans l echapper : ${html.slice(0, 160)}`)
    assert.match(html, /&lt;img/, `${sel} n a pas echappe le nom`)
  }
})

test("LE TEST QUI COMPTE : les LIGNES comparent la meme fenetre que l en-tete", () => {
  // Si les lignes somment douze mois quand l en-tete en somme dix, la colonne
  // ne s explique plus par le total, et l ecart en % compare deux fenetres.
  const p = bancAnnee({
    aujourdHui: '2026-10-15',
    biens: [{ id: 'uuid-1', name: 'La bulle' }],
    annee: {
      total: { '2026-09': mo(10000), '2026-11': mo(500000) },
      par_bien: { 'uuid-1': { '2026-09': mo(10000), '2026-11': mo(500000) } },
      hors_biens: {}
    }
  })
  const entete = euros(p.cache('[data-bind="revenue-annee-n"]').textContent)
  const lignes = p.cache('[data-list="revenue-annee-lignes"]').innerHTML
  const colonneN = [...lignes.matchAll(/<td class="rev-tbl__num">([^<]*)</g)].map(m => euros(m[1]))
  assert.strictEqual(colonneN[0], entete,
    `la ligne vaut ${colonneN[0]} € pour un en-tete a ${entete} € : novembre entre dans l une et pas dans l autre`)
})

test("LE TEST QUI COMPTE : le mois courant est designe sur l axe", () => {
  // Il marque la frontiere entre le realise et le deja reserve. Sans lui, rien
  // sur l axe ne dit ou elle passe.
  const p = bancAnnee({
    aujourdHui: '2026-10-15',
    annee: { total: { '2026-09': mo(10000), '2026-11': mo(20000) }, par_bien: {}, hors_biens: {} }
  })
  const svg = p.cache('[data-bind="revenue-annee-courbe"]').innerHTML
  assert.match(svg, /cm-mois--fort/, 'aucun mois n est designe sur l axe')
  // Et sur une annee PASSEE, aucun mois n est « maintenant ».
  const passe = bancAnnee({
    an: 2025, aujourdHui: '2026-10-15',
    annee: { total: { '2025-09': mo(10000) }, par_bien: {}, hors_biens: {} }
  })
  assert.ok(!/cm-mois--fort/.test(passe.cache('[data-bind="revenue-annee-courbe"]').innerHTML),
    'une annee passee designe un mois courant : aucun de ses mois n est « maintenant »')
})

test("LE TEST QUI COMPTE : le mois courant garde sa COULEUR, pas seulement sa graisse", () => {
  // ⚠ SPECIFICITE EGALE, L ORDRE TRANCHE. `.cm-mois--fort` (0,1,0) etait
  // declaree AVANT `.cm-grad, .cm-mois` (0,1,0) : le `fill` de la seconde
  // gagnait, le gras s appliquait et la couleur non. C est mot pour mot la
  // classe de defaut que CLAUDE.md decrit pour `[hidden]`, et aucun test ne lit
  // une valeur calculee.
  const css = lire('shared/ui.css')
  const iFort = css.indexOf('.cm-mois--fort')
  const iBase = css.search(/\.cm-grad,\s*\.cm-mois\s*\{/)
  assert.ok(iFort >= 0 && iBase >= 0, 'les deux regles de l axe ont disparu')
  const compose = /\.cm-mois\.cm-mois--fort\s*\{/.test(css)
  assert.ok(compose || iFort > iBase,
    'la regle du mois courant est simple ET declaree avant la regle de base : son `fill` perd en silence')
})

// ─── LES TROIS CONSTATS DE LA RECETTE DU 28 OCTOBRE 2026 ───────────────────

test("LE TEST QUI COMPTE : en vue Annee, le tableau du MOIS est masque", () => {
  // ⚠ `renderAnnee()` est appele AU MILIEU de `renderRevenus`, et la fin de
  // `renderRevenus` reaffichait le tableau du mois derriere lui. Thierry voyait
  // donc, sous la courbe de l'annee, les lignes « aucun versement ce mois-ci ».
  // Le test APPELLE `renderRevenus` en entier : un test qui n'appellerait que
  // `renderAnnee` ne verrait jamais le defaut, puisqu'il vient de l'APRES.
  const p = bancRevenus({
    mois: '2026-10',
    par_bien: { 'uuid-1': parBien({ sejours: 0, total_cents: 0, recu_cents: 0, a_venir_cents: 0 }) },
    total: parBien({ sejours: 0, total_cents: 0, recu_cents: 0, a_venir_cents: 0 }),
    hors_mois: parBien({}), hors_biens: parBien({})
  })
  p.interne.etat.vueRevenus = 'annee'
  p.interne.etat.anneeRevenus = 2026
  p.interne.etat.anneeEtat = 'ok'
  p.interne.etat.aujourdHui = '2026-10-15'
  p.interne.etat.annee = { total: { '2026-05': mo(10000) }, par_bien: {}, hors_biens: {} }
  p.interne.renderRevenus()
  // ⚠ LES DEUX FORMES, et c'est la regle « le mobile suit l'ordinateur » : la
  // liste de cartes EST le tableau du mois a moins de 561 px. Ma premiere
  // version ne jugeait que le `<table>` — mesure : la mutation qui laissait la
  // liste telephone visible passait au VERT. Le telephone aurait garde sous la
  // courbe de l'annee les cartes « aucun versement ce mois-ci ».
  // ⚠ ON INTERROGE LES SELECTEURS QUE LA PAGE UTILISE, PAS DES EQUIVALENTS. Le
  // banc cle ses doubles sur la CHAINE du selecteur : `.rev-liste:not(…)` et
  // `[data-list="revenue-cards"]` designent le meme element dans un navigateur,
  // mais rendent deux doubles DIFFERENTS ici. Ma premiere version lisait le
  // mauvais — mesure : la mutation qui laissait la liste telephone visible
  // passait au vert.
  // ⚠ ET LA CHAINE SUIT LA PAGE QUAND LA PAGE CHANGE : le tableau « Reserve a
  // date » a ajoute un 3e `.rev-tbl-wrap`, donc la negation nomme desormais
  // les deux formes de l'annee. Ce test a rougi a ce changement — c'est son
  // role, et c'est pourquoi il cite la chaine exacte plutot qu'un equivalent.
  const formesDuMois = ['.rev-tbl-wrap:not(.rev-an-tbl):not(.rev-rad-tbl)', '[data-list="revenue-cards"]']
  for (const sel of formesDuMois) {
    assert.strictEqual(p.cache(sel).hidden, true,
      `${sel} reste affiche sous la courbe de l annee`)
  }
  // Et les deux reviennent quand on repasse au mois.
  p.interne.etat.vueRevenus = 'mois'
  p.interne.renderRevenus()
  for (const sel of formesDuMois) {
    assert.strictEqual(p.cache(sel).hidden, false,
      `${sel} ne revient pas quand on repasse en vue Mois`)
  }
})

test("LE TEST QUI COMPTE : une annee SANS AUCUNE ligne rend « — », pas « 0 € »", () => {
  // ⚠ CONSTAT 2 DE LA RECETTE : « Studio Centre : colonne 2025 = 0 € alors
  // qu il n a aucun sejour en 2025. » L endpoint ne rend que les mois qui
  // portent quelque chose : l ABSENCE DE CLE est l information. « 0 € »
  // affirme un encaissement nul ; le logement n existait pas.
  const p = bancAnnee({
    biens: [{ id: 'uuid-1', name: 'Studio Centre' }],
    annee: {
      total: { '2026-05': mo(10000) },
      par_bien: { 'uuid-1': { '2026-05': mo(10000) } },
      hors_biens: {}
    }
  })
  const lignes = p.cache('[data-list="revenue-annee-lignes"]').innerHTML
  const cellules = [...lignes.matchAll(/<td class="rev-tbl__num[^"]*">([^<]*)</g)].map(m => m[1])
  assert.ok(cellules.length >= 2, `pas assez de cellules rendues : ${lignes.slice(0, 200)}`)
  assert.ok(!/0/.test(cellules[1]),
    `la colonne N-1 affiche « ${cellules[1] }» : un faux zero pour une annee sans aucune ligne`)
  assert.match(cellules[1], /—/,
    `la colonne N-1 affiche « ${cellules[1]} » au lieu d un tiret`)
  // ⚠ ET LE MOTIF EST A COTE, sur la meme ligne : un tiret seul ne dit rien.
  assert.match(lignes, /revenue\.annee_nouveau/,
    'le tiret de la colonne N-1 n est explique par aucun motif sur sa ligne')
  // Au niveau du COMPTE, le motif ne peut pas vivre dans une colonne : il
  // descend dans les reserves.
  assert.match(p.cache('[data-bind="revenue-annee-reserves"]').textContent, /revenue\.annee_sans_n1/,
    'l en-tete rend « — » sans qu aucune reserve ne dise pourquoi')
})

test("LE TEST QUI COMPTE : un mois SANS RIEN D ENCAISSE se trace en POINTILLE", () => {
  // ⚠ CONSTAT 3 DE LA RECETTE : « octobre (0 € recu, 480 € a venir) se trace
  // en plein ». Ma premiere version coupait le trait au MOIS COURANT, donc le
  // mois courant entrait dans le plein — l ecran affirmait « encaisse » un
  // argent qui n est que reserve. La frontiere suit la DONNEE : le plein
  // s arrete au dernier mois qui a vraiment recu quelque chose.
  const recu = (t) => ({ sejours: 1, total_cents: t, recu_cents: t, a_venir_cents: 0, bruts: 0, sans_montant: 0 })
  const aVenir = (t) => ({ sejours: 1, total_cents: t, recu_cents: 0, a_venir_cents: t, bruts: 0, sans_montant: 0 })
  const p = bancAnnee({
    aujourdHui: '2026-10-15',
    annee: {
      total: { '2026-09': recu(30000), '2026-10': aVenir(48000), '2026-11': aVenir(20000) },
      par_bien: {}, hors_biens: {}
    }
  })
  const svg = p.cache('[data-bind="revenue-annee-courbe"]').innerHTML
  const plein = (svg.match(/<path d="([^"]*)"[^>]*stroke="var\(--ink\)"[^>]*stroke-width="2\.5"/) || [])[1] || ''
  const pointille = (svg.match(/<path d="([^"]*)"[^>]*stroke-dasharray/) || [])[1] || ''
  assert.ok(pointille, 'aucun trait pointille : le deja reserve ne se distingue pas')
  // Le plein s arrete a septembre : il porte UN point, pas trois.
  const ptsPlein = (plein.match(/[ML]/g) || []).length
  assert.strictEqual(ptsPlein, 1,
    `le trait plein porte ${ptsPlein} points : octobre (0 € recu) y est entre alors qu il n est que reserve`)
  // Le pointille part de septembre et couvre octobre et novembre : trois points.
  const ptsPointille = (pointille.match(/[ML]/g) || []).length
  assert.strictEqual(ptsPointille, 3,
    `le trait pointille porte ${ptsPointille} points : il ne rejoint pas le dernier mois encaisse`)
})

// ─── LA BANDE DES COMPARABLES (28 octobre 2026) ────────────────────────────

test("LE TEST QUI COMPTE : sans logement choisi, AUCUNE bande n est tracee", () => {
  // Un min-max de comparables n a aucun sens pour un compte entier, dont les
  // logements ont chacun les leurs (decision Q2 de Thierry). Et sans bande,
  // pas de marque de bande dans la legende : une legende qui nomme un trait
  // absent est un mensonge de plus.
  // ⚠ LA BANDE EST EN MEMOIRE, ET POURTANT RIEN NE DOIT SE TRACER. Ma premiere
  // version ne fournissait aucune bande : le test passait meme avec un code
  // qui ignorait la pastille, puisqu il n y avait rien a dessiner. Un test ne
  // demontre une regle que si sa violation produirait quelque chose.
  const p = bancAnnee({
    biens: [{ id: 'uuid-1', name: 'A' }],
    annee: {
      total: { '2026-05': mo(10000) },
      par_bien: { 'uuid-1': { '2026-05': mo(10000) } },
      hors_biens: {}
    },
    comparables: {
      'uuid-1': {
        releve_le: '2026-10-06',
        mois: {
          '2026-04': { nature: 'clos', min_cents: 500000, max_cents: 900000, comparables: 8, releve_le: '2026-10-06' },
          '2026-05': { nature: 'clos', min_cents: 600000, max_cents: 950000, comparables: 8, releve_le: '2026-10-06' }
        }
      }
    }
  })
  const svg = p.cache('[data-bind="revenue-annee-courbe"]').innerHTML
  assert.ok(!/<polygon/.test(svg), 'une bande est tracee sans logement choisi')
  assert.ok(!/rev-an-marque--bande/.test(p.cache('[data-bind="revenue-annee-legende"]').innerHTML),
    'la legende nomme une bande qui n existe pas')
  assert.strictEqual(p.cache('[data-bind="revenue-annee-comparables"]').hidden, true,
    'la note des comparables s affiche sans comparables')
})

test("LE TEST QUI COMPTE : la bande se trace, et sa note DATE le releve", () => {
  // ⚠ SANS LA DATE, l hote compare son mois en cours a une photo dont il
  // ignore l age. Et les mots sont ceux de Thierry : « occupe », jamais
  // « reserve », avec la mention de l estimation.
  const p = bancAnnee({
    biens: [{ id: 'uuid-1', name: 'A' }],
    filtre: 'uuid-1',
    annee: {
      total: { '2026-05': mo(10000) },
      par_bien: { 'uuid-1': { '2026-05': mo(10000) } },
      hors_biens: {}
    },
    comparables: {
      'uuid-1': {
        releve_le: '2026-10-06',
        mois: {
          '2026-04': { nature: 'clos', min_cents: 500000, max_cents: 900000, comparables: 8, releve_le: '2026-10-06' },
          '2026-05': { nature: 'clos', min_cents: 600000, max_cents: 950000, comparables: 8, releve_le: '2026-10-06' }
        }
      }
    }
  })
  const svg = p.cache('[data-bind="revenue-annee-courbe"]').innerHTML
  assert.match(svg, /<polygon class="cm-bande"/, 'la bande des comparables n est pas tracee')
  assert.match(p.cache('[data-bind="revenue-annee-legende"]').innerHTML, /rev-an-marque--bande/,
    'la legende ne nomme pas la bande')
  const note = p.cache('[data-bind="revenue-annee-comparables"]')
  assert.strictEqual(note.hidden, false, 'la note des comparables est masquee alors que la bande existe')
  assert.match(note.textContent, /revenue\.annee_comparables_note/,
    `la note ne porte pas la phrase des comparables : « ${note.textContent} »`)
})

test("LE TEST QUI COMPTE : la bande ne DEPASSE jamais le haut de l axe", () => {
  // Un comparable qui gagne deux fois plus que l hote aurait son plafond trace
  // au-dessus de la zone dessinee, donc invisible — et l ecran montrerait une
  // bande tronquee en affirmant qu elle est complete.
  const p = bancAnnee({
    biens: [{ id: 'uuid-1', name: 'A' }],
    filtre: 'uuid-1',
    annee: {
      total: { '2026-05': mo(10000) },
      par_bien: { 'uuid-1': { '2026-05': mo(10000) } },
      hors_biens: {}
    },
    comparables: {
      'uuid-1': {
        releve_le: '2026-10-06',
        // ⚠ DEUX MOIS, et c'est necessaire : un mois SEUL ne fait pas un
        // polygone — le module lui donne un TRAIT vertical, ce qui est la
        // bonne reponse (un intervalle), mais ce test juge un polygone.
        mois: {
          '2026-04': { nature: 'clos', min_cents: 20000, max_cents: 4000000, comparables: 3, releve_le: '2026-10-06' },
          '2026-05': { nature: 'clos', min_cents: 10000, max_cents: 5000000, comparables: 3, releve_le: '2026-10-06' }
        }
      }
    }
  })
  // ⚠ ON JUGE LA GEOMETRIE, PAS LE LIBELLE. Ma premiere version lisait le
  // palier haut avec `euros()`, qui retire tout ce qui n est pas un chiffre :
  // « 50 k € » y devenait **50**, et le test rougissait sur un code juste.
  // Un libelle en notation compacte ne se compare pas comme un montant — et
  // ce que ce test veut vraiment dire est « la bande tient dans le cadre ».
  const svg = p.cache('[data-bind="revenue-annee-courbe"]').innerHTML
  const poly = (svg.match(/<polygon class="cm-bande" points="([^"]*)"/) || [])[1]
  assert.ok(poly, 'aucune bande tracee : le test ne demontre rien')
  const ys = poly.split(' ').map(pt => Number(pt.split(',')[1])).filter(Number.isFinite)
  assert.ok(ys.length, 'les points de la bande sont illisibles')
  const plusHaut = Math.min(...ys)
  assert.ok(plusHaut >= 0,
    `le sommet de la bande est a y=${plusHaut}, donc HORS du cadre : l axe ne la couvre pas`)
})

test("LE TEST QUI COMPTE : les deux bandes se DISTINGUENT a l oeil", () => {
  // ⚠ CONSTAT 2 DE LA RECETTE DU 28 OCTOBRE : « bande foncee et claire trop
  // proches ». Elles etaient `--border` et `--line`, deux gris voisins a
  // quatorze points de luminosite. Le remede n est pas une couleur vive —
  // c est le MEME gris a deux DENSITES, qui tient aussi en mode sombre.
  const comparables = {
    'uuid-1': {
      releve_le: '2026-10-06',
      mois: {
        '2026-04': { nature: 'clos', min_cents: 500000, max_cents: 900000, comparables: 8, sans_activite: 0, releve_le: '2026-10-06' },
        '2026-05': { nature: 'clos', min_cents: 600000, max_cents: 950000, comparables: 8, sans_activite: 0, releve_le: '2026-10-06' },
        '2026-11': { nature: 'futur', min_cents: 100000, max_cents: 300000, comparables: 8, sans_activite: 0, releve_le: '2026-10-06' },
        '2026-12': { nature: 'futur', min_cents: 120000, max_cents: 320000, comparables: 8, sans_activite: 0, releve_le: '2026-10-06' }
      }
    }
  }
  const p = bancAnnee({
    biens: [{ id: 'uuid-1', name: 'A' }], filtre: 'uuid-1', comparables,
    annee: {
      total: { '2026-05': mo(10000) },
      par_bien: { 'uuid-1': { '2026-05': mo(10000) } },
      hors_biens: {}
    }
  })
  const svg = p.cache('[data-bind="revenue-annee-courbe"]').innerHTML
  const op = [...svg.matchAll(/<polygon class="cm-bande"[^>]*opacity="([\d.]+)"/g)].map(m => Number(m[1]))
  assert.strictEqual(op.length, 2, `${op.length} bandes tracees au lieu de deux : ${svg.slice(0, 200)}`)
  const [a, b] = op.slice().sort((x, y) => y - x)
  assert.ok(a / b >= 2,
    `les deux bandes sont a ${a} et ${b} d opacite : moins du double, elles ne se distinguent pas`)
  // ⚠ ET DISCRETES — CONSTAT DE LA RECETTE DU 29 OCTOBRE 2026 : « le gris est
  // trop fonce, l'adoucir beaucoup, elle doit rester un fond discret derriere
  // les courbes ». Les deux bornes tiennent ENSEMBLE, et c'est tout l'interet
  // de les asserter au meme endroit : baisser la seule foncee aurait referme ce
  // constat-ci en ouvrant celui du 28 (« bandes trop proches »), et remonter la
  // claire pour les ecarter rouvrirait celui-ci. Le plafond vaut pour la plus
  // FONCEE des deux ; la claire suit par le rapport.
  assert.ok(a <= 0.2,
    `la bande la plus foncee est a ${a} d opacite : ce n est plus un fond discret`)
  // ⚠ ET UN PLANCHER, parce que les deux bornes d'au-dessus se satisfont aussi
  // de `[0.002, 0.001]` : rapport de deux, plafond tenu, et DEUX BANDES
  // INVISIBLES. Constat de la review du 29 octobre 2026. Une bande qu'on ne
  // voit pas n'est pas « discrete », c'est une donnee qu'on a cessee d'afficher
  // sans le dire.
  const [, bas] = op.slice().sort((x, y) => y - x)
  assert.ok(bas >= 0.05,
    `la bande la plus claire est a ${bas} d opacite : elle n est plus visible`)
})

test("LE TEST QUI COMPTE : sous « Tous », l ecran DIT pourquoi il n y a pas de bande", () => {
  // ⚠ CONSTAT 1 DE LA RECETTE : ne rien afficher etait juste — un min/max de
  // comparables n a pas de sens pour un compte — mais un silence se lit comme
  // une panne. L ecran explique, et la phrase disparait des qu un logement est
  // choisi.
  const annee = {
    total: { '2026-05': mo(10000) },
    par_bien: { 'uuid-1': { '2026-05': mo(10000) } },
    hors_biens: {}
  }
  const biens = [{ id: 'uuid-1', name: 'A' }]
  const tous = bancAnnee({ biens, annee })
  const phrase = tous.cache('[data-bind="revenue-annee-comparables-tous"]')
  assert.strictEqual(phrase.hidden, false, 'aucune phrase sous « Tous » : le silence se lit comme une panne')
  assert.match(phrase.textContent, /revenue\.annee_comparables_tous/,
    `la phrase attendue n est pas rendue : « ${phrase.textContent} »`)
  // Et elle s efface des qu un logement est choisi.
  const choisi = bancAnnee({ biens, annee, filtre: 'uuid-1' })
  assert.strictEqual(choisi.cache('[data-bind="revenue-annee-comparables-tous"]').hidden, true,
    'la phrase de « Tous » reste affichee alors qu un logement est choisi')
})

// ─── « RESERVE A DATE » A L'ECRAN (28 octobre 2026) ────────────────────────

const rad = (mois, o = {}) => ({
  pivot: '2025-10-28', seuil: 5,
  mois: Object.fromEntries(Object.entries(mois).map(([m, v]) => [m, {
    sejours: 9, total_cents: 200000, sans_date_annulation: 0, non_fiables: 0,
    sous_seuil: false, seuil: 5, ...v
  }])),
  par_bien: o.par_bien || {}
})

test("LE TEST QUI COMPTE : « reserve a date » ne couvre QUE les mois a venir", () => {
  // ⚠ SUR UN MOIS DEJA CLOS DE N-1, LE REVENU FINAL EST CONNU, et c'est lui
  // qui vaut. Comparer un etat intermediaire a un resultat final serait
  // comparer deux choses differentes — et c'est precisement ce que ce lot
  // existe pour eviter.
  const p = bancAnnee({
    aujourdHui: '2026-10-28',
    annee: {
      total: { '2026-09': recuDe(30000), '2026-11': aVenirDe(48000) },
      par_bien: {}, hors_biens: {},
      reserve_a_date: rad({ '2025-05': {}, '2025-11': {}, '2025-12': {} })
    }
  })
  const svg = p.cache('[data-bind="revenue-annee-courbe"]').innerHTML
  const gris = [...svg.matchAll(/<path d="([^"]*)"[^>]*stroke="var\(--muted\)"[^>]*stroke-dasharray/g)].map(m => m[1])
  assert.strictEqual(gris.length, 1, 'le trait « reserve a date » n est pas trace')
  const points = (gris[0].match(/[ML]/g) || []).length
  assert.strictEqual(points, 2,
    `${points} points sur le trait : mai 2025, deja clos, y est entre alors que son revenu FINAL est connu`)
})

test("LE TEST QUI COMPTE : un mois SOUS LE SEUIL n est pas trace, et se DIT", () => {
  // Sans la phrase, l hote voit un trait qui s arrete et croit a un trou dans
  // la donnee, alors que c est un refus raisonne.
  const p = bancAnnee({
    aujourdHui: '2026-10-28',
    annee: {
      total: { '2026-09': recuDe(30000), '2026-11': aVenirDe(48000) },
      par_bien: {}, hors_biens: {},
      reserve_a_date: rad({
        '2025-11': { sejours: 2, sous_seuil: true },
        '2025-12': {}
      })
    }
  })
  const svg = p.cache('[data-bind="revenue-annee-courbe"]').innerHTML
  const gris = (svg.match(/stroke="var\(--muted\)"[^>]*stroke-dasharray/g) || []).length
  assert.strictEqual(gris, 1, 'le trait a disparu alors qu un mois sur deux passe le seuil')
  assert.match(p.cache('[data-bind="revenue-annee-reserves"]').textContent, /revenue\.annee_rad_sous_seuil/,
    'le mois refuse par le seuil n est explique nulle part')
})

test("LE TEST QUI COMPTE : la pastille pilote AUSSI « reserve a date »", () => {
  // ⚠ SINON L'ECRAN SUPERPOSE DEUX PERIMETRES. Ma premiere version de
  // l'endpoint agregeait sur le seul mois : la ligne aurait montre le COMPTE
  // pendant que la courbe montrait un bien, sans le dire.
  const annee = {
    total: { '2026-09': recuDe(30000), '2026-11': aVenirDe(48000) },
    par_bien: { 'uuid-1': { '2026-09': recuDe(30000), '2026-11': aVenirDe(48000) } },
    hors_biens: {},
    reserve_a_date: {
      ...rad({ '2025-11': { total_cents: 900000 }, '2025-12': { total_cents: 900000 } }),
      par_bien: {
        'uuid-1': {
          '2025-11': { sejours: 9, total_cents: 100000, sans_date_annulation: 0, non_fiables: 0, sous_seuil: false, seuil: 5 },
          '2025-12': { sejours: 9, total_cents: 100000, sans_date_annulation: 0, non_fiables: 0, sous_seuil: false, seuil: 5 }
        }
      }
    }
  }
  const biens = [{ id: 'uuid-1', name: 'A' }]
  const svgTous = bancAnnee({ aujourdHui: '2026-10-28', biens, annee }).cache('[data-bind="revenue-annee-courbe"]').innerHTML
  const svgBien = bancAnnee({ aujourdHui: '2026-10-28', biens, annee, filtre: 'uuid-1' }).cache('[data-bind="revenue-annee-courbe"]').innerHTML
  const haut = (svg) => {
    const g = [...svg.matchAll(/class="cm-grad"[^>]*>([^<]*)</g)].map(m => m[1])
    return g[g.length - 1]
  }
  assert.notStrictEqual(haut(svgBien), haut(svgTous),
    'le haut de l axe est identique avec et sans pastille : la ligne « reserve a date » ne suit pas le filtre')
})

// ─── LE TABLEAU « RESERVE A DATE » (decision de Thierry, 28 octobre 2026) ───
// ⚠ IL DOUBLE LA LIGNE POINTILLEE, IL NE LA REMPLACE PAS, et c'est une mesure
// qui l'a decide : au banc, au niveau du compte, l'axe est tire par le pic
// d'ete et les deux pointilles a 2 k € sur un axe a 16 k € se tassent au ras
// de l'axe. La ligne dit la FORME, le tableau dit les NOMBRES.

// Les cellules d'une ligne du tableau, dans l'ordre du balisage :
// mois, reserve aujourd'hui, meme date l'an dernier, ecart.
// ⚠ ON LIT `innerHTML`, PAS UN DOM. Le banc rend des noeuds STUB dont
// `querySelectorAll` rend toujours `[]` : ma premiere version de cette aide
// interrogeait le DOM, et les cinq tests comparaient donc zero ligne a zero
// ligne. Trois ont rougi par chance (0 !== 2) ; celui du telephone, qui
// comparait deux longueurs, etait VERT sur deux listes vides.
const sansBalises = (h) => String(h).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
const lignesDuTableauRad = (p) => {
  const html = String(p.cache('[data-list="revenue-annee-rad-lignes"]').innerHTML)
  return [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(m => {
    const cellules = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => c[1])
    return {
      mois: sansBalises((m[1].match(/<th[^>]*>([\s\S]*?)<\/th>/) || ['', ''])[1]),
      cellules,
      textes: cellules.map(sansBalises)
    }
  })
}

// ⚠ LE MONTANT ET LE COMPTE DE SEJOURS, SEPAREMENT. `euros()` ratisse tous
// les chiffres de la chaine : depuis que le double d'`I18n.t` rend ses
// PARAMETRES, il ramasserait aussi le `n=4` de `revenue.stays`. Et c'est bien
// pour cela que le double les rend : tant qu'il les jetait, le nombre de
// sejours n'etait observable par AUCUNE assertion — la mutation « sAuj + 9 »
// restait verte (constat de la review du 28 octobre 2026).
const montantEtSejours = (txt) => {
  const m = String(txt).match(/^(\S+)\s+revenue\.stays\{n=(\d+)\}$/)
  return m ? { euros: Number(m[1]), sejours: Number(m[2]) } : { euros: null, sejours: null }
}

const cartesDuTableauRad = (p) => {
  const html = String(p.cache('[data-list="revenue-annee-rad-cartes"]').innerHTML)
  return [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map(m => ({
    mois: sansBalises((m[1].match(/class="rev-carte__bien"[^>]*>([\s\S]*?)<\/span>\s*<\/span>/)
      || m[1].match(/class="rev-carte__bien"[^>]*>([\s\S]*?)<\/span>/) || ['', ''])[1]),
    html: m[1]
  }))
}

test("LE TEST QUI COMPTE : le tableau « reserve a date » ne porte QUE les mois a venir", () => {
  // Meme raison que pour la ligne : sur un mois clos, le revenu FINAL est
  // connu, et comparer un etat intermediaire a un resultat final serait
  // comparer deux choses differentes.
  const p = bancAnnee({
    aujourdHui: '2026-10-28',
    annee: {
      total: { '2026-05': recuDe(90000), '2026-09': recuDe(30000), '2026-11': aVenirDe(48000), '2026-12': aVenirDe(20000) },
      par_bien: {}, hors_biens: {},
      reserve_a_date: rad({ '2025-05': {}, '2025-09': {}, '2025-11': {}, '2025-12': {} })
    }
  })
  const mois = lignesDuTableauRad(p).map(l => l.mois)
  assert.strictEqual(mois.length, 2,
    `${mois.length} lignes au tableau (${mois.join(', ')}) : un mois deja clos y est entre`)
})

test("LE TEST QUI COMPTE : le tableau SUIT LA PASTILLE, comme la ligne", () => {
  // ⚠ SINON L'ECRAN SUPERPOSE DEUX PERIMETRES : la colonne N-1 dirait le
  // COMPTE pendant que le reste de l'ecran dit un bien, sans le signaler.
  const annee = {
    total: { '2026-09': recuDe(30000), '2026-11': aVenirDe(48000) },
    par_bien: { 'uuid-1': { '2026-09': recuDe(30000), '2026-11': aVenirDe(48000) } },
    hors_biens: {},
    reserve_a_date: {
      ...rad({ '2025-11': { total_cents: 900000, sejours: 31 } }),
      par_bien: {
        'uuid-1': {
          '2025-11': { sejours: 7, total_cents: 100000, sans_date_annulation: 0, non_fiables: 0, sous_seuil: false, seuil: 5 }
        }
      }
    }
  }
  const biens = [{ id: 'uuid-1', name: 'A' }]
  const n1De = (o) => montantEtSejours(
    lignesDuTableauRad(bancAnnee({ aujourdHui: '2026-10-28', biens, annee, ...o }))[0].textes[1])
  assert.deepStrictEqual(n1De({}), { euros: 9000, sejours: 31 },
    'la colonne N-1 sous « Tous » ne vaut pas le total du compte')
  assert.deepStrictEqual(n1De({ filtre: 'uuid-1' }), { euros: 1000, sejours: 7 },
    'la colonne N-1 ne change pas quand un logement est choisi : le tableau ignore la pastille')
})

test("LE TEST QUI COMPTE : sous le seuil, la ligne le DIT et ne montre AUCUN montant", () => {
  // ⚠ UN MONTANT SOUS LE SEUIL SERAIT UNE AFFIRMATION QU'ON A REFUSE DE FAIRE.
  // L'endpoint ne le rend meme pas — ce test garde l'ecran, qui ne doit pas
  // non plus inventer un « 0 € » a sa place.
  const p = bancAnnee({
    aujourdHui: '2026-10-28',
    annee: {
      total: { '2026-09': recuDe(30000), '2026-11': aVenirDe(48000) },
      par_bien: {}, hors_biens: {},
      reserve_a_date: rad({ '2025-11': { sejours: 2, sous_seuil: true, total_cents: undefined } })
    }
  })
  const l = lignesDuTableauRad(p)[0]
  assert.match(l.textes[1], /revenue\.annee_rad_sous_seuil_court/,
    `la colonne N-1 dit « ${l.textes[1]} » au lieu de nommer le refus du seuil`)
  assert.strictEqual(/\d/.test(l.textes[1]), false,
    `un chiffre apparait sous le seuil : « ${l.textes[1]} »`)
  assert.strictEqual(l.textes[2], '—',
    `l ecart vaut « ${l.textes[2]} » alors qu il n y a pas de base de comparaison`)
})

test("LE TEST QUI COMPTE : l ecart porte son SIGNE, et le retard est rouge", () => {
  // ⚠ LE SIGNE AVANT LA COULEUR. Un hote qui ne distingue pas le vert du rouge
  // lit « +12 % » et « -68 % » (le trait d'union que rend `String(-68)`, pas un signe moins typographique) ; la couleur n'est jamais seule porteuse.
  // ⚠ ET LE ROUGE EST PROPRE A CE TABLEAU : celui des biens emploie
  // `rev-tbl__ecart--bas` (neutre), parce qu'un bien moins vendu que l'an
  // dernier n'est pas une alarme. Ici, Thierry a demande « vert si en avance,
  // rouge si en retard » — ne pas « harmoniser » les deux.
  const p = bancAnnee({
    aujourdHui: '2026-10-28',
    annee: {
      total: { '2026-09': recuDe(30000), '2026-11': aVenirDe(150000), '2026-12': aVenirDe(50000) },
      par_bien: {}, hors_biens: {},
      reserve_a_date: rad({
        '2025-11': { total_cents: 100000 },   // 1 500 € contre 1 000 € : en avance
        '2025-12': { total_cents: 100000 }    //   500 € contre 1 000 € : en retard
      })
    }
  })
  const [avance, retard] = lignesDuTableauRad(p)
  assert.match(avance.textes[2], /^\+50 %$/, `le mois en avance dit « ${avance.textes[2]} »`)
  assert.strictEqual(/--retard/.test(avance.cellules[2]), false,
    'le mois en AVANCE porte la classe du retard')
  assert.match(retard.textes[2], /^-50 %$/, `le mois en retard dit « ${retard.textes[2]} »`)
  assert.match(retard.cellules[2], /rev-tbl__ecart--retard/,
    'le mois en RETARD ne porte pas la classe rouge demandee')
})

test("LE TEST QUI COMPTE : au telephone, UNE LIGNE PAR MOIS, les memes que le tableau", () => {
  // La forme telephone n'est pas un resume : c'est le meme contenu, en cartes.
  // Deux listes qui divergent, c'est la regle « le mobile suit l'ordinateur »
  // qui tombe — et elle est tombee une fois sur les couleurs du calendrier.
  const p = bancAnnee({
    aujourdHui: '2026-10-28',
    annee: {
      total: { '2026-09': recuDe(30000), '2026-11': aVenirDe(48000), '2026-12': aVenirDe(20000) },
      par_bien: {}, hors_biens: {},
      reserve_a_date: rad({ '2025-11': {}, '2025-12': {} })
    }
  })
  const tbl = lignesDuTableauRad(p).map(l => l.mois)
  // ⚠ LA NON-VACUITE D'ABORD. Comparer deux longueurs egales est vrai aussi
  // quand les deux listes sont vides, et c'est exactement le faux vert qu'a
  // produit ma premiere version de ce test.
  assert.strictEqual(tbl.length, 2, `${tbl.length} lignes au tableau au lieu de 2`)
  const cartes = cartesDuTableauRad(p)
  assert.strictEqual(cartes.length, tbl.length,
    `${cartes.length} cartes au telephone contre ${tbl.length} lignes au tableau`)
  assert.deepStrictEqual(cartes.map(c => c.mois), tbl,
    'les cartes du telephone ne portent pas les memes mois que le tableau')
  // ⚠ ET LE BLOC DISPARAIT QUAND IL N'A RIEN A DIRE : un titre seul au-dessus
  // d'un tableau vide se lit comme une panne.
  const vide = bancAnnee({
    aujourdHui: '2026-10-28',
    annee: { total: { '2026-09': recuDe(30000) }, par_bien: {}, hors_biens: {} }
  })
  assert.strictEqual(vide.cache('[data-bind="revenue-annee-rad"]').hidden, true,
    'le bloc « reserve a date » reste affiche alors qu aucun mois a venir ne porte quoi que ce soit')
})

// ─── LES CINQ CONSTATS DE LA REVIEW DU 28 OCTOBRE 2026 ─────────────────────

test("LE TEST QUI COMPTE : la colonne du JOUR dit son montant ET ses sejours", () => {
  // ⚠ CONSTAT DE LA REVIEW : mes cinq premiers tests ne lisaient que la colonne
  // N-1 et l'ecart. La mutation « Math.round(nAuj / 100) + 777 » — un montant
  // faux sur TOUTES les lignes et toutes les cartes — passait au VERT. C'est
  // la moitie des nombres du tableau, et celle qui porte les deux autres
  // constats graves.
  const p = bancAnnee({
    aujourdHui: '2026-10-28',
    annee: {
      total: { '2026-09': recuDe(30000), '2026-11': { ...aVenirDe(150000), sejours: 4 } },
      par_bien: {}, hors_biens: {},
      reserve_a_date: rad({ '2025-11': { total_cents: 100000 } })
    }
  })
  const l = lignesDuTableauRad(p)[0]
  assert.deepStrictEqual(montantEtSejours(l.textes[0]), { euros: 1500, sejours: 4 },
    `la colonne du jour dit « ${l.textes[0]} » au lieu de 1 500 € et 4 sejours`)
})

test("LE TEST QUI COMPTE : un mois NON CALCULABLE ne devient pas « 0 € · -100 % »", () => {
  // ⚠ CONSTAT GRAVE DE LA REVIEW. Un mois a venir ne portant qu'un sejour SANS
  // MONTANT (blocage saisi en resa, canal sans prix) : `refuseTout` le refuse,
  // la courbe coupe son trait, la reserve dit « sans montant ». Le tableau
  // affirmait « 0 € reserve » et « -100 % » EN ROUGE. Une absence transformee
  // en fait — et le meme ecran avait deja corrige ce defaut en trois endroits.
  const p = bancAnnee({
    aujourdHui: '2026-10-28',
    annee: {
      total: {
        '2026-09': recuDe(30000),
        '2026-11': { sejours: 2, total_cents: 0, recu_cents: 0, a_venir_cents: 0, bruts: 0, sans_montant: 2 }
      },
      par_bien: {}, hors_biens: {},
      reserve_a_date: rad({ '2025-11': { total_cents: 200000 } })
    }
  })
  const l = lignesDuTableauRad(p)[0]
  assert.match(l.textes[0], /revenue\.unavailable/,
    `le mois refuse dit « ${l.textes[0]} » au lieu de nommer son motif`)
  assert.strictEqual(/\d/.test(l.textes[0]), false, `un chiffre subsiste : « ${l.textes[0]} »`)
  assert.strictEqual(l.textes[2], '—',
    `l ecart vaut « ${l.textes[2]} » : il est calcule sur un 0 € qui n existe pas`)
  assert.strictEqual(/--retard/.test(l.cellules[2]), false,
    'un mois NON CALCULABLE est signale en rouge comme un retard')
})

test("LE TEST QUI COMPTE : un mois present en N-1 SEUL ne s affiche pas en retard", () => {
  // Aucune ligne cote 2026 : « 0 € » serait arithmetiquement vrai, mais le
  // « -100 % » rouge donnerait la meme alarme a « rien vendu » et a « ce mois
  // n est pas encore ouvert a la vente » — une decision de l hote signalee
  // comme un defaut.
  const p = bancAnnee({
    aujourdHui: '2026-10-28',
    annee: {
      total: { '2026-09': recuDe(30000) },
      par_bien: {}, hors_biens: {},
      reserve_a_date: rad({ '2025-11': { total_cents: 200000 } })
    }
  })
  const l = lignesDuTableauRad(p)[0]
  assert.strictEqual(l.textes[0], '—', `la colonne du jour dit « ${l.textes[0]} » au lieu de « — »`)
  assert.strictEqual(l.textes[2], '—', `l ecart vaut « ${l.textes[2]} » au lieu de « — »`)
  assert.strictEqual(/--retard/.test(l.cellules[2]), false, 'le mois est signale en rouge')
})

test("LE TEST QUI COMPTE : un echec de lecture n emporte PAS le tableau de l annee d avant", () => {
  // ⚠ CONSTAT GRAVE DE LA REVIEW. `renderAnnee` sort par `return` AVANT le code
  // du tableau quand l etat est « chargement » ou « echec », et `videTout` ne
  // connaissait pas le bloc neuf. L hote cliquait « ← 2025 » et lisait
  // « Lecture impossible » au-dessus d un tableau peuple des pourcentages de
  // 2026. C est la garantie que `chargerAnnee` enonce lui-meme.
  const p = bancAnnee({
    aujourdHui: '2026-10-28',
    annee: {
      total: { '2026-09': recuDe(30000), '2026-11': aVenirDe(150000) },
      par_bien: {}, hors_biens: {},
      reserve_a_date: rad({ '2025-11': { total_cents: 100000 } })
    }
  })
  assert.strictEqual(lignesDuTableauRad(p).length, 1, 'le tableau n a pas rendu au depart')
  for (const etat of ['chargement', 'echec']) {
    p.interne.etat.anneeEtat = etat
    p.interne.renderAnnee()
    assert.strictEqual(p.cache('[data-bind="revenue-annee-rad"]').hidden, true,
      `le bloc « reserve a date » reste affiche sous l etat « ${etat} »`)
    assert.strictEqual(lignesDuTableauRad(p).length, 0,
      `les lignes du tableau survivent a l etat « ${etat} »`)
    assert.strictEqual(cartesDuTableauRad(p).length, 0,
      `les cartes du telephone survivent a l etat « ${etat} »`)
  }
})

test("LE TEST QUI COMPTE : sans agregat, le tableau SE TAIT et la panne se NOMME", () => {
  // ⚠ CONSTAT DE LA REVIEW. `reserve_a_date` est `null` quand la RPC a echoue.
  // Tous les `l.lan` etant absents, chaque ligne affirmait « pas assez de
  // ventes a cette date l an dernier » sur une annee qui avait bien vendu — un
  // fait que l ecran n a AUCUN moyen de connaitre — et l en-tete rendait
  // « Meme date l an dernier () ».
  const p = bancAnnee({
    aujourdHui: '2026-10-28',
    annee: {
      total: { '2026-09': recuDe(30000), '2026-11': aVenirDe(150000) },
      par_bien: {}, hors_biens: {}, indisponibles: ['reserve_a_date']
    }
  })
  assert.strictEqual(p.cache('[data-bind="revenue-annee-rad"]').hidden, true,
    'le tableau s affiche alors que l agregat manque')
  assert.strictEqual(lignesDuTableauRad(p).length, 0, 'des lignes sont rendues sans agregat')
  assert.strictEqual(p.cache('[data-bind="revenue-annee-rad-col-n1"]').textContent, '',
    'l en-tete N-1 affiche sa parenthese vide')
  const res = p.cache('[data-bind="revenue-annee-reserves"]')
  assert.strictEqual(res.hidden, false, 'aucune reserve : le silence se lit comme « rien vendu l an dernier »')
  assert.match(res.textContent, /revenue\.annee_rad_indispo/,
    `la reserve dit « ${res.textContent} » au lieu de nommer la panne`)
})

// ─── LES TROIS CONSTATS DE LA RECETTE DU 28 OCTOBRE 2026 ───────────────────

test("LE TEST QUI COMPTE : au telephone, le refus du seuil se dit UNE FOIS", () => {
  // ⚠ CONSTAT DE RECETTE. La carte rendait « l'an dernier a la meme date :
  // pas assez de ventes a cette date l'an dernier — » : trois formulations du
  // meme refus sur une ligne. Le tableau, lui, a ses en-tetes de colonne pour
  // dire de quoi on parle ; la carte n'en a pas, donc elle porte la phrase
  // SEULE.
  const p = bancAnnee({
    aujourdHui: '2026-10-28',
    annee: {
      total: { '2026-09': recuDe(30000), '2026-11': aVenirDe(48000) },
      par_bien: {}, hors_biens: {},
      reserve_a_date: rad({ '2025-11': { sejours: 2, sous_seuil: true } })
    }
  })
  const c = cartesDuTableauRad(p)
  assert.strictEqual(c.length, 1, `${c.length} carte(s) au lieu d une`)
  const phrase = sansBalises(c[0].html.replace(/[\s\S]*<p[^>]*>/, '').replace(/<\/p>[\s\S]*/, ''))
  assert.strictEqual(phrase, 'revenue.annee_rad_sous_seuil_court',
    `la carte dit « ${phrase} » : le refus y est formule plusieurs fois`)

  // ⚠ ET LE CAS NORMAL GARDE SES TROIS MORCEAUX. Constat de la review : le
  // test ne gardait que la branche du seuil, et trois mutations sur la MEME
  // ligne — retirer le libelle, le montant N-1, l'ecart — laissaient la suite
  // a 6599 verts. C'est ainsi que le libelle double est arrive jusqu'a la
  // recette : la carte n'etait lue par aucune assertion de contenu.
  const n = bancAnnee({
    aujourdHui: '2026-10-28',
    annee: {
      total: { '2026-09': recuDe(30000), '2026-11': aVenirDe(150000) },
      par_bien: {}, hors_biens: {},
      reserve_a_date: rad({ '2025-11': { total_cents: 100000, sejours: 7 } })
    }
  })
  const carte = cartesDuTableauRad(n)[0]
  const bas = sansBalises(carte.html.replace(/[\s\S]*<p[^>]*>/, '').replace(/<\/p>[\s\S]*/, ''))
  assert.match(bas, /^revenue\.annee_rad_mobile_n1\b/,
    `la carte a perdu son libelle : « ${bas} »`)
  assert.deepStrictEqual(montantEtSejours(bas.replace(/^revenue\.annee_rad_mobile_n1\s*/, '').replace(/\s*\+50 %$/, '')),
    { euros: 1000, sejours: 7 }, `la carte a perdu le montant N-1 : « ${bas} »`)
  assert.match(bas, /\+50 %$/, `la carte a perdu son ecart : « ${bas} »`)
})

test("LE TEST QUI COMPTE : un mois PARTIELLEMENT mesure dit ce que son total couvre", () => {
  // ⚠ CONSTAT DE RECETTE : « 480 € · 3 sejours » avec deux sejours sans
  // montant presente le total de UN sejour comme celui de trois. Le chiffre
  // est juste, la phrase est fausse. `refuseTout` ne mord pas — le mois garde
  // son total partiel, c'est une verite INCOMPLETE — donc c'est le COMPTE qui
  // doit le dire.
  const p = bancAnnee({
    aujourdHui: '2026-10-28',
    annee: {
      total: {
        '2026-09': recuDe(30000),
        '2026-11': { sejours: 3, total_cents: 48000, recu_cents: 0, a_venir_cents: 48000, bruts: 0, sans_montant: 2 }
      },
      par_bien: {}, hors_biens: {},
      reserve_a_date: rad({ '2025-11': { total_cents: 48000 } })
    }
  })
  const l = lignesDuTableauRad(p)[0]
  assert.match(l.textes[0], /revenue\.annee_rad_sejours_partiel\{n=1,k=2\}/,
    `la colonne du jour dit « ${l.textes[0]} » au lieu de 1 sejour et 2 sans montant`)
  assert.strictEqual(/revenue\.stays/.test(l.textes[0]), false,
    `le compte simple subsiste : « ${l.textes[0]} »`)
  assert.strictEqual(euros(l.textes[0].replace(/revenue\.[\s\S]*/, '')), 480,
    `le montant a change : « ${l.textes[0]} »`)
  // Et un mois ENTIEREMENT mesure garde le compte simple.
  const sain = bancAnnee({
    aujourdHui: '2026-10-28',
    annee: {
      total: { '2026-09': recuDe(30000), '2026-11': { ...aVenirDe(48000), sejours: 3 } },
      par_bien: {}, hors_biens: {},
      reserve_a_date: rad({ '2025-11': { total_cents: 48000 } })
    }
  })
  assert.match(lignesDuTableauRad(sain)[0].textes[0], /revenue\.stays\{n=3\}/,
    'un mois sans sejour non mesure a perdu son compte simple')
})

test("LE TEST QUI COMPTE : « 0 % » est GRIS NEUTRE dans les DEUX tableaux", () => {
  // ⚠ CONSTAT DE RECETTE : le vert s'etendait jusqu'a 0 % par le seul fait que
  // la condition testait `< 0`. Zero n'est ni une avance ni un retard. Et les
  // deux tableaux du bloc se lisent l'un sous l'autre : un zero vert dans l'un
  // et gris dans l'autre serait une difference que rien ne justifie.
  const egal = { sejours: 9, total_cents: 48000, sans_date_annulation: 0, non_fiables: 0, sous_seuil: false, seuil: 5 }
  const p = bancAnnee({
    aujourdHui: '2026-10-28',
    biens: [{ id: 'uuid-1', name: 'A' }],
    annee: {
      total: { '2026-09': recuDe(30000), '2026-11': aVenirDe(48000) },
      // Le bien fait le MEME chiffre sur la fenetre comparee des deux annees :
      // l'ecart du tableau des biens vaut donc 0 % lui aussi.
      par_bien: { 'uuid-1': { '2026-09': recuDe(30000), '2025-09': recuDe(30000) } },
      hors_biens: {},
      reserve_a_date: { ...rad({}), mois: { '2025-11': egal } }
    }
  })
  const rad_ = lignesDuTableauRad(p)[0]
  assert.match(rad_.textes[2], /^0 %$/, `l ecart « reserve a date » vaut « ${rad_.textes[2]} »`)
  assert.match(rad_.cellules[2], /rev-tbl__ecart--nul/,
    'le 0 % de « reserve a date » n est pas neutre : il reste vert')
  assert.strictEqual(/--retard/.test(rad_.cellules[2]), false, 'le 0 % est signale en retard')

  const biens = String(p.cache('[data-list="revenue-annee-lignes"]').innerHTML)
  const cel = (biens.match(/<span class="rev-tbl__ecart[^"]*">0 %<\/span>/) || [''])[0]
  assert.notStrictEqual(cel, '', `aucune cellule a « 0 % » dans le tableau des biens : ${biens.slice(0, 300)}`)
  assert.match(cel, /rev-tbl__ecart--nul/, 'le 0 % du tableau des biens reste vert')
})

// ─── LE BLOC DU JOUR QUI N'A RIEN A DIRE (recette du 29 octobre 2026) ──────

const blocDuJour = (o = {}) => {
  const p = ouvrirAujourdhui({ sansInit: true, evenements: o.evenements })
  p.interne.etat.aujourdHui = '2026-10-29'
  p.interne.etat.menagesOk = o.menagesOk === undefined ? true : o.menagesOk
  p.interne.renderEvenements()
  return p
}
const grilleAPlat = (p) =>
  p.cache('[data-bind="today-duo"]').classList.contains('auj-duo--plat')

test("LE TEST QUI COMPTE : un jour SANS arrivee ni depart met la grille A PLAT", () => {
  // ⚠ CONSTAT DE RECETTE : « quand A valider est plein et que le bloc
  // Aujourd'hui n'a ni arrivee ni depart, la page montre un grand vide ».
  // Mesure au banc reel (chrome, 1280 px) AVANT correctif : le bloc du jour
  // fait 21 px de haut sur 821 px de large, « A valider » 716 px — la ligne de
  // grille fait la hauteur de sa colonne la plus haute, donc le bloc du jour
  // laissait 821 x 695 px de BLANC. Il ne s'etirait pas (`align-items: start`
  // l'empeche deja) : c'est la PLACE RESERVEE qui etait vide. APRES : les deux
  // blocs sont empiles, blanc mesure a ZERO, et la ligne tombe de 716 a 643 px
  // parce que les cartes de « A valider » se replient moins sur toute la
  // largeur.
  const vide = blocDuJour({ evenements: [] })
  assert.strictEqual(grilleAPlat(vide), true,
    'la grille reste en deux colonnes alors que le jour n a qu une ligne a dire')
  assert.match(vide.cache('[data-list="events"]').innerHTML, /today\.empty/,
    'le bloc du jour ne dit pas qu il n y a rien')
})

test("LE TEST QUI COMPTE : « les menages ne sont pas lisibles » met AUSSI a plat", () => {
  // La ligne « indisponible » fait exactement la meme hauteur qu'un « rien
  // aujourd'hui », donc elle laisse exactement le meme blanc. Un correctif qui
  // n'aurait ferme que l'etat vide aurait laisse la moitie du defaut — et
  // c'est l'etat qu'un hote voit quand une lecture echoue, donc le pire moment
  // pour lui montrer une page qui a l'air cassee.
  const ko = blocDuJour({ menagesOk: false })
  assert.strictEqual(grilleAPlat(ko), true,
    'la grille reste en deux colonnes sur l etat « indisponible »')
  assert.match(ko.cache('[data-list="events"]').innerHTML, /today\.unavailable/,
    'le bloc ne dit pas que les menages sont illisibles')
})

test("LE TEST QUI COMPTE : des QU IL Y A une arrivee, la grille reprend ses deux colonnes", () => {
  // ⚠ ET C'EST LA MOITIE QUI SE PERD. Une bascule qui ne remonte jamais laisse
  // la page a plat pour le reste de la session : il suffit que le premier rendu
  // tombe sur un jour vide — le cache, par exemple — pour que l'hote ne
  // retrouve plus ses deux colonnes sans recharger.
  // ⚠ ET ON MESURE SUR LE MEME BANC, APRES L'ETAT VIDE. Ma premiere version
  // ouvrait un banc NEUF : la classe n'y avait jamais ete posee, donc
  // l'assertion « pas a plat » etait vraie sans que `aPlat(false)` existe —
  // mesure par mutation, elle restait VERTE en retirant la remontee. C'est la
  // sequence reelle : le cache affiche un jour vide, puis la lecture arrive.
  // ⚠ `options` EST LE MEME OBJET que celui passe au banc : le changer entre
  // deux rendus suffit, et ca evite d'ajouter une poignee au banc pour un seul
  // test.
  const opts = { sansInit: true, evenements: [] }
  const p = ouvrirAujourdhui(opts)
  p.interne.etat.aujourdHui = '2026-10-29'
  p.interne.etat.menagesOk = true
  p.interne.renderEvenements()
  assert.strictEqual(grilleAPlat(p), true, 'la grille n est pas passee a plat au premier rendu')

  opts.evenements = [{
    type: 'arrivee', heure: '15:00', bien: 'La bulle', bienId: 'uuid-1',
    bookingId: 'B1', voyageur: 'Chloe', nuits: 3, codeEtat: 'transmis'
  }]
  p.interne.renderEvenements()
  assert.strictEqual(grilleAPlat(p), false,
    'la grille reste a plat alors que le jour porte une arrivee')
  assert.match(p.cache('[data-list="events"]').innerHTML, /today\.arrival/,
    'l arrivee n est pas rendue')
})

test("LE TEST QUI COMPTE : la classe « a plat » FAIT une seule colonne", () => {
  // ⚠ LA BASCULE SANS SA REGLE NE FAIT RIEN, et aucun test du rendu ne le voit :
  // mesure par mutation, vider `.auj-duo--plat` laissait les 112 tests VERTS.
  // Le DOM du banc n'a pas de moteur de style, donc c'est la FEUILLE qu'on lit
  // — meme methode que `tests/masquage-hidden.test.js`.
  const css = fs.readFileSync(path.join(__dirname, '..', 'shared', 'ui.css'), 'utf8')
  const regle = (sel) => {
    const i = css.indexOf(sel + ' {')
    assert.notStrictEqual(i, -1, `la regle « ${sel} » n existe pas dans shared/ui.css`)
    return css.slice(i + sel.length + 2, css.indexOf('}', i))
  }
  // L'etat normal : deux colonnes au moins, et aucun etirement.
  const duo = regle('.auj-duo')
  assert.match(duo, /grid-template-columns:\s*repeat\(auto-fit/,
    `.auj-duo ne pose plus ses colonnes : « ${duo.trim()} »`)
  assert.match(duo, /align-items:\s*start/,
    'sans `align-items: start`, le bloc du jour s etirerait vraiment a la hauteur de « A valider »')
  // L'etat a plat : UNE colonne, et le bloc du jour ne s etend plus sur deux.
  const plat = regle('.auj-duo--plat')
  assert.match(plat, /grid-template-columns:\s*1fr/,
    `.auj-duo--plat ne ramene pas a une colonne : « ${plat.trim()} »`)
  const jour = regle('.auj-duo--plat > .auj-duo__jour')
  assert.match(jour, /grid-column:\s*auto/,
    `a plat, le bloc du jour garde son « span 2 » : « ${jour.trim()} »`)
})

// ─── LA SUITE DES AVIS AU DEFILEMENT (recette du 29 octobre 2026) ──────────

const avisDeTest = (n, jour) => ({
  id: String(n), bien_ref: 'P1', ota: 'airbnb',
  recu_le: `2026-10-${String(jour).padStart(2, '0')}T10:00:00Z`,
  note_sur_5: 4.6, texte: `Commentaire numero ${n}`, voyageur: 'Chloe'
})

// Le banc du bloc des avis : trois cartes rendues, l'observateur arme, et les
// pages suivantes servies par URL.
function bancSuiteAvis (pages = []) {
  const observateurs = []
  const ecouteurs = []
  let appelees = 0
  const options = {
    sansInit: true,
    observateurs,
    ecouteurs,
    corps: (url) => {
      if (!url.includes('/api/ecran/avis-recents')) return {}
      const page = pages[appelees++]
      return page || { avis: [], fin: true }
    }
  }
  const p = ouvrirAujourdhui(options)
  p.interne.etat.biens = [{ id: 'uuid-1', name: 'La bulle', provider_property_id: 'P1' }]
  p.interne.etat.avisConnu = true
  p.interne.etat.avisRefuse = false
  p.interne.etat.derniersAvis = [avisDeTest(1, 28), avisDeTest(2, 27), avisDeTest(3, 26)]
  p.interne.renderDerniersAvis()
  // ⚠ LE GESTE FAIT PARTIE DU BANC, parce qu'il fait partie du contrat : la
  // page n'observe la sentinelle qu'au premier defilement. Un banc qui armait
  // sans geste mesurait un comportement que le navigateur n'a pas.
  p.defiler()
  return { p, observateurs, urls: p.urls, pagesDemandees: () => appelees }
}
const sentinelle = (p) => p.cache('[data-bind="reviews-sentinelle"]')

test("LE TEST QUI COMPTE : trois avis au depart, et un observateur arme sur la sentinelle", () => {
  // ⚠ TROIS AU DEPART, ET AUCUN APPEL DE PLUS AU CHARGEMENT. Le budget de cet
  // ecran est de DEUX appels a l'ouverture : la suite ne doit partir qu'au
  // GESTE de l'hote, jamais au rendu.
  const b = bancSuiteAvis()
  assert.strictEqual(b.observateurs.length, 1,
    `${b.observateurs.length} observateur(s) : la sentinelle n est pas armee`)
  assert.strictEqual(b.pagesDemandees(), 0,
    'une page de suite est demandee des le rendu, sans que personne ait defile')
  assert.strictEqual(b.observateurs[0].cibles.length, 1, 'l observateur n observe rien')
})

test("LE TEST QUI COMPTE : le defilement demande les plus ANCIENS, par le curseur des DEUX cles", async () => {
  // ⚠ LE CURSEUR PORTE LA DATE **ET** L'IDENTIFIANT. Le tri est
  // `(received_at desc, id desc)` : deux avis recus au meme instant ne se
  // departagent que par `id`, et un curseur sur la seule date les sauterait
  // tous les deux ou les rendrait deux fois.
  const b = bancSuiteAvis([{ avis: [avisDeTest(4, 25), avisDeTest(5, 24), avisDeTest(6, 23)], fin: false }])
  // ⚠ ON **ATTEND** LE GESTE. Sans `await`, l'assertion tombe avant le premier
  // `await` interne d'`appel()` — donc avant que la requete soit partie : un
  // faux rouge ici, et le meme defaut donnerait un faux VERT dans l'autre sens.
  await b.observateurs[0].declencher()
  const url = b.urls.find(x => x.includes('/api/ecran/avis-recents'))
  assert.ok(url, `aucun appel a la suite des avis : ${b.urls.join(' | ')}`
    + ` / erreurs du banc : ${b.p.erreurs.join(' / ')}`)
  // Le curseur part de la TROISIEME carte — la plus ancienne des trois.
  assert.match(url, /depuis=2026-10-26T10%3A00%3A00Z/, `l URL ne porte pas la date du curseur : ${url}`)
  assert.match(url, /apres_id=3/, `l URL ne porte pas l identifiant du curseur : ${url}`)
})

test("LE TEST QUI COMPTE : les avis charges s AJOUTENT, ils ne remplacent pas", async () => {
  // ⚠ ILS S'INSERENT AVANT LA SENTINELLE, et c'est ce qui garde l'ordre : une
  // insertion a la fin mettrait les plus anciens APRES le marqueur, donc apres
  // le lien « tous les avis ». Et on n'ecrase pas la zone : reconstruire le
  // bloc entier ferait sauter la position de defilement au doigt.
  const b = bancSuiteAvis([{ avis: [avisDeTest(4, 25), avisDeTest(5, 24), avisDeTest(6, 23)], fin: false }])
  await b.observateurs[0].declencher()
  const ajoute = sentinelle(b.p).avant
  for (const n of [4, 5, 6]) {
    assert.ok(ajoute.includes(`Commentaire numero ${n}`),
      `l avis ${n} n a pas ete ajoute : « ${ajoute.slice(0, 200)} »`)
  }
  assert.strictEqual(/Commentaire numero 1/.test(ajoute), false,
    'les trois premiers avis ont ete re-rendus : la zone a ete ecrasee')
})

test("LE TEST QUI COMPTE : au bout des 30 jours, le lien vers /avis — et plus un appel", async () => {
  // ⚠ DECISION DE THIERRY, OPTION 3 : « 30 jours, puis un lien vers /avis ».
  // Mesure en production le 29 octobre 2026 : 16 avis avec texte sur 30 jours
  // contre 645 au total. Paginer jusqu'au premier aurait fait de l'accueil un
  // second /avis, et rendu FAUX le compte de son propre en-tete.
  // ⚠ ET L'OBSERVATEUR SE COUPE. Sans cela, chaque defilement de plus
  // redemanderait la meme page vide — un appel par geste, pour rien.
  const b = bancSuiteAvis([{ avis: [avisDeTest(4, 25)], fin: true }])
  await b.observateurs[0].declencher()
  assert.strictEqual(b.pagesDemandees(), 1, 'la page de fin n a pas ete demandee')
  const fin = sentinelle(b.p)
  assert.match(fin.innerHTML, /href="\/avis"/, `la sentinelle ne porte pas le lien : « ${fin.innerHTML} »`)
  assert.match(fin.innerHTML, /reviews\.all/, 'le lien n est pas libelle')
  assert.strictEqual(b.observateurs[0].coupe, true, 'l observateur continue d observer apres la fin')
  await b.observateurs[0].declencher()
  assert.strictEqual(b.pagesDemandees(), 1,
    'un second defilement redemande une page alors que la fin est atteinte')
})

test("LE TEST QUI COMPTE : une lecture qui ECHOUE n affirme pas « plus rien »", async () => {
  // ⚠ `null` N'EST PAS `[]`. L'endpoint rend `{ avis: null, indisponible: true }`
  // quand il n'a PAS PU lire : traiter ca comme une fin de liste serait
  // affirmer une absence. On s arrete, le lien vers /avis reste le chemin, et
  // aucune carte n est inventee.
  const b = bancSuiteAvis([{ avis: null, fin: true, indisponible: true }])
  await b.observateurs[0].declencher()
  const fin = sentinelle(b.p)
  assert.match(fin.innerHTML, /href="\/avis"/, 'le chemin vers /avis a disparu sur un echec')
  assert.strictEqual(fin.avant, '', `des cartes ont ete ajoutees sur un echec : « ${fin.avant} »`)
})

test("LE TEST QUI COMPTE : sans IntersectionObserver, les trois premiers avis RESTENT", () => {
  // Un navigateur sans observateur ne doit pas perdre le bloc : il garde ses
  // trois cartes et le lien de l en-tete. C est la degradation, pas la panne.
  const p = ouvrirAujourdhui({ sansInit: true, sansObservateur: true })
  p.interne.etat.biens = [{ id: 'uuid-1', name: 'La bulle', provider_property_id: 'P1' }]
  p.interne.etat.avisConnu = true
  p.interne.etat.derniersAvis = [avisDeTest(1, 28), avisDeTest(2, 27), avisDeTest(3, 26)]
  p.interne.renderDerniersAvis()
  const zone = p.cache('[data-list="reviews"]')
  assert.match(zone.innerHTML, /Commentaire numero 1/, 'les avis ont disparu sans observateur')
  assert.strictEqual(p.cache('[data-bind="reviews-section"]').hidden, false,
    'la section est masquee alors qu elle a trois avis')
})

// ─── LES CINQ TROUS QUE LA REVIEW DU 29 OCTOBRE 2026 A MESURES VERTS ───────

test("LE TEST QUI COMPTE : un SECOND rendu n emporte pas la suite au defilement", async () => {
  // ⚠ CONSTAT GRAVE, ET IL CASSAIT LA FONCTION DANS LE CHEMIN NORMAL.
  // `renderDerniersAvis()` est appele DEUX FOIS a chaque chargement — une fois
  // depuis le cache, une fois apres la lecture serveur. Le vrai
  // `IntersectionObserver` appelle son rappel DES LA PREMIERE OBSERVATION si la
  // cible est dans la fenetre : un chargement pouvait donc partir au rendu 1,
  // le rendu 2 remplacait la zone (DETACHANT la sentinelle 1), puis la promesse
  // du rendu 1 se resolvait et coupait l'observateur du rendu 2 — plus aucun
  // chargement pour le reste de la session, sans rien a l'ecran.
  const opts = {
    sansInit: true,
    observateurs: [],
    ecouteurs: [],
    corps: (url) => url.includes('/api/ecran/avis-recents')
      ? { avis: [avisDeTest(4, 25)], fin: false }
      : {}
  }
  const p = ouvrirAujourdhui(opts)
  p.interne.etat.biens = [{ id: 'uuid-1', name: 'La bulle', provider_property_id: 'P1' }]
  p.interne.etat.avisConnu = true
  p.interne.etat.derniersAvis = [avisDeTest(1, 28), avisDeTest(2, 27), avisDeTest(3, 26)]

  p.interne.renderDerniersAvis()          // rendu 1 (le cache)
  p.defiler()                             // l hote a defile : on observe
  const o1 = opts.observateurs[0]
  const promesse = o1.declencher()        // l'observateur du rendu 1 part
  p.interne.renderDerniersAvis()          // rendu 2 (la lecture serveur) arrive
  const o2 = opts.observateurs[1]
  await promesse                          // puis la promesse du rendu 1 se resout

  assert.strictEqual(o1.coupe, true, 'l observateur du rendu 1 n a pas ete coupe')
  assert.strictEqual(o2.coupe, false,
    'le rendu 1, perime, a coupe l observateur du rendu 2 : plus aucun chargement de la session')
  assert.deepStrictEqual(p.erreurs, [],
    `ecrire depuis un rendu perime a leve : ${p.erreurs.join(' / ')}`)
  // Et le rendu 2 marche toujours.
  await o2.declencher()
  assert.match(sentinelle(p).avant, /Commentaire numero 4/,
    'le rendu courant ne charge plus rien')
})

test("LE TEST QUI COMPTE : la sentinelle est ATTACHEE, sinon rien ne peut la voir", () => {
  // ⚠ CONSTAT DE LA REVIEW : la mutation qui retirait `zone.appendChild(marque)`
  // laissait 119 tests verts, alors qu'en navigateur la fonction est
  // ENTIEREMENT MORTE — un noeud detache n'intersecte jamais rien, et
  // `insertAdjacentHTML('beforebegin')` y leve. Le double enregistrait alors le
  // noeud dans la table des selecteurs des `setAttribute` ; c'est `appendChild`
  // qui le fait maintenant, comme un vrai DOM.
  const b = bancSuiteAvis()
  const s = sentinelle(b.p)
  assert.ok(s.parentNode, 'la sentinelle n est pas attachee a la zone des avis')
  assert.strictEqual(b.observateurs[0].cibles[0], s,
    'l observateur n observe pas la sentinelle attachee')
})

test("LE TEST QUI COMPTE : un curseur qui N AVANCE PAS arrete la suite", async () => {
  // ⚠ CONSTAT DE LA REVIEW : la mutation qui figeait le curseur restait verte.
  // Un serveur qui rend trois fois la meme ligne ferait redemander la MEME page
  // indefiniment, en empilant les doublons sans borne.
  const memeLigne = { avis: [avisDeTest(3, 26)], fin: false }
  const b = bancSuiteAvis([memeLigne, memeLigne, memeLigne])
  await b.observateurs[0].declencher()
  assert.strictEqual(b.pagesDemandees(), 1, 'la premiere page n a pas ete demandee')
  const fin = sentinelle(b.p)
  assert.match(fin.innerHTML, /href="\/avis"/,
    'la suite continue alors que le curseur ne bouge plus')
  assert.strictEqual(b.observateurs[0].coupe, true, 'l observateur tourne encore')
})

test("LE TEST QUI COMPTE : l armement d avant est COUPE, jamais laisse vivant", () => {
  // ⚠ CONSTAT DE LA REVIEW : retirer le `disconnect` d'entree laissait la suite
  // verte. Deux rendus laisseraient deux observateurs vivants, donc deux
  // chargements concurrents, chacun avec son propre `enCours`.
  const opts = { sansInit: true, observateurs: [], ecouteurs: [], corps: () => ({}) }
  const p = ouvrirAujourdhui(opts)
  p.interne.etat.biens = [{ id: 'uuid-1', name: 'La bulle', provider_property_id: 'P1' }]
  p.interne.etat.avisConnu = true
  p.interne.etat.derniersAvis = [avisDeTest(1, 28), avisDeTest(2, 27), avisDeTest(3, 26)]
  p.interne.renderDerniersAvis()
  p.defiler()
  p.interne.renderDerniersAvis()
  p.interne.renderDerniersAvis()
  assert.strictEqual(opts.observateurs.length, 3, 'les trois rendus n ont pas arme')
  const vivants = opts.observateurs.filter(o => !o.coupe)
  assert.strictEqual(vivants.length, 1,
    `${vivants.length} observateurs vivants : les rendus d avant n ont pas ete coupes`)
})

test("LE TEST QUI COMPTE : la sentinelle OCCUPE une place, et au bon seuil", () => {
  // ⚠ LA REGLE EST FONCTIONNELLE, PAS DECORATIVE : sans hauteur ni largeur, la
  // sentinelle reste collee a la derniere carte et le defilement ne l atteint
  // jamais. La mutation qui vidait la regle laissait 127 tests verts.
  // ⚠ ET LE SEUIL EST CELUI DU RAIL (720 px), pas celui de `.rev-liste`
  // (560 px) : entre les deux, le bloc est deja un rail.
  const css = fs.readFileSync(path.join(__dirname, '..', 'shared', 'ui.css'), 'utf8')
  const regle = (sel) => {
    const i = css.indexOf(sel + ' {')
    assert.notStrictEqual(i, -1, `la regle « ${sel} » n existe pas`)
    return css.slice(i + sel.length + 2, css.indexOf('}', i))
  }
  assert.match(regle('.avis-suite'), /min-height:\s*\d+px/,
    'la sentinelle n a pas de hauteur : a l ordinateur, rien ne la separe de la derniere carte')
  // La largeur du rail : dans le media du RAIL, et egale a celle d une carte.
  const seuilRail = css.indexOf('@media (max-width: 720px)', css.indexOf('.avis-suite {'))
  assert.notStrictEqual(seuilRail, -1, 'la largeur du rail n est pas posee au seuil du rail (720 px)')
  const bloc = css.slice(seuilRail, css.indexOf('\n}', seuilRail))
  assert.match(bloc, /\.avis-suite\s*\{[^}]*width:\s*268px/,
    `la sentinelle ne fait pas la largeur d une carte dans le rail : ${bloc.slice(0, 160)}`)
  const carte = regle('.scroll-x .avis-carte')
  assert.match(carte, /width:\s*268px/,
    `une carte du rail ne fait plus 268 px (${carte.trim()}) : la sentinelle ne lui correspond plus`)
})

test("LE TEST QUI COMPTE : AUCUNE observation avant le premier defilement", () => {
  // ⚠ MESURE AU BANC REEL (chrome-headless, balisage REEL de la page, cas
  // « journee vide » — celui que la retouche 3 raccourcit le plus) : a
  // 1280x900, le haut de la sentinelle est a 1077 px et le `rootMargin` vaut
  // 200 px, donc 1077 < 1100 : LE VRAI `IntersectionObserver` AURAIT TIRE DES
  // LE CHARGEMENT. L'accueil serait passe a TROIS appels au chargement, alors
  // que son budget est de DEUX et qu'un test le garde. Au telephone (390x844),
  // le bord gauche est a 858 px, hors de portee : le defaut n'existait que sur
  // ordinateur, et seul le banc navigateur pouvait le voir.
  // ⚠ ET C'EST AUSSI LE CONTRAT : « quand on fait defiler on charge » sont les
  // mots de la demande. Le geste n'est pas un garde-fou ajoute par-dessus.
  const opts = { sansInit: true, observateurs: [], ecouteurs: [], corps: () => ({}) }
  const p = ouvrirAujourdhui(opts)
  p.interne.etat.biens = [{ id: 'uuid-1', name: 'La bulle', provider_property_id: 'P1' }]
  p.interne.etat.avisConnu = true
  p.interne.etat.derniersAvis = [avisDeTest(1, 28), avisDeTest(2, 27), avisDeTest(3, 26)]
  p.interne.renderDerniersAvis()

  assert.strictEqual(opts.observateurs.length, 1, 'l observateur n est pas cree')
  assert.strictEqual(opts.observateurs[0].cibles.length, 0,
    'la sentinelle est observee AVANT tout defilement : un troisieme appel part au chargement')
  // ⚠ ET L'ECOUTEUR ATTRAPE LE RAIL : un `scroll` ne bouillonne pas, donc sans
  // la phase de CAPTURE, defiler le rail des avis au telephone — le seul geste
  // possible la-bas — n armerait jamais rien.
  const ecoute = opts.ecouteurs.find(e => e.type === 'scroll')
  assert.ok(ecoute, `aucun ecouteur de defilement : ${JSON.stringify(opts.ecouteurs.map(e => e.type))}`)
  assert.strictEqual(ecoute.reglages.capture, true,
    'l ecouteur de defilement n est pas en phase de capture : le rail du telephone ne l atteint pas')

  // Le geste, puis l observation.
  p.defiler()
  assert.strictEqual(opts.observateurs[0].cibles.length, 1,
    'apres le defilement, la sentinelle n est toujours pas observee')
})
