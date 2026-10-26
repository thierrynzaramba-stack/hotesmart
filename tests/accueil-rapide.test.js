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
  return corpsUtile + '\n;return { chargerNotes, etat, chargerDerniersAvis, renderTaches, renderRevenus, renderDerniersAvis }'
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
      json: async () => { if (options.corpsIllisible) throw new SyntaxError('<'); return options.corps || {} }
    })
  }
  const stubs = new Map()
  const elem = () => ({
    hidden: false, textContent: '', innerHTML: '', value: '', style: {}, dataset: {},
    classList: { add () {}, remove () {}, toggle () {}, contains: () => false },
    addEventListener () {}, removeAttribute () {}, setAttribute () {}, remove () {},
    appendChild () {}, closest: () => null, querySelector: () => null, querySelectorAll: () => []
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
    t: (k) => k, date: () => 'LE-JOUR', time: () => '', money: () => '', pct: () => '',
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
    return cle === 'etatDesBiens' ? (() => new Map()) : (() => [])
  } })

  const sorti = new Function(
    'requireAuth', 'supabase', 'signOut', 'initErrorHandler', 'logger', 'esc',
    'compteCourant', 'moi', 'peutLire', 'peutEcrire', 'estTitulaire', 'comptes',
    'basculerVers', 'enteteCompte', 'etatHtml',
    'vueDesAvis', 'blocAvisHtml', 'enTeteAvisHtml', 'MUETS', 'libelleDuCanal', 'R',
    'I18n', 'HSNav', 'document', 'window', 'location', 'fetch', 'localStorage', 'console',
    batirAujourdhui(options.sansInit)
  )(requireAuth, supabase, rien, rien, { error: rien, warn: rien, info: rien }, String,
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
    AVIS.vueDesAvis, AVIS.blocAvisHtml, AVIS.enTeteAvisHtml, AVIS.MUETS,
    (c) => ({ airbnb: 'Airbnb', booking: 'Booking.com' })[String((c || {}).ota || '')] || null,
    R,
    I18n, { renderMenu: rien, render: rien }, document_, {}, { search: '', hash: '' },
    fetchFaux, faireStockage(), { error: rien, warn: rien, log: rien })

  return {
    // Le corps que le test a fourni. Depuis le lot (b), les tests nourrissent
    // `etat.ecran` avec lui au lieu de compter sur le faux `fetch` : la page ne
    // fait plus l'appel, l'endpoint d'ecran le fait pour elle.
    corpsDonne: options.corps || {},
    interne: sorti,
    urls,
    lectures,
    I18n,
    date: () => document_.querySelector('[data-bind="date"]').textContent,
    html: (sel) => document_.querySelector(sel).innerHTML,
    // L'element lui-meme, pour lire `hidden` et `textContent` : le double les
    // porte, et c'est sur eux que se jugent « masque » et « se tait ».
    cache: (sel) => document_.querySelector(sel),
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

test("LE TEST QUI COMPTE : le compte de sejours d'une ligne ne compte pas les refuses", () => {
  // « 2 sejours — 300,00 € » quand le total ne couvre qu'un sejour sur deux est
  // incoherent EN SOI : les deux nombres de la meme ligne se contredisent, et
  // rien ne dit lequel croire.
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
  // c'est tout l'objet de ce test. La page calcule
  // `Math.max(0, d.sejours - refuses)` : 2 sejours dont 1 refuse = 1.
  const html = fs.readFileSync(path.join(__dirname, '..', 'pages', 'aujourdhui.html'), 'utf8')
  assert.match(html, /const comptes = Math\.max\(0, d\.sejours - refuses\)/,
    'le compte des sejours ne retire plus les refuses')
  assert.match(html, /t\('revenue\.stays', \{ n: comptes \}\)/,
    '`revenue.stays` ne recoit plus le compte des sejours COMPTES')
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
