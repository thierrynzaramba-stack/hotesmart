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
    if (String(url).endsWith('langues.json')) {
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

  assert.ok(demandes.some(u => u.endsWith('langues.json')), 'langues.json jamais demande')
  assert.ok(demandes.some(u => u.endsWith('fr.json')),
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
  const fetchFaux = url => Promise.resolve(String(url).endsWith('langues.json')
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
function batirAujourdhui () {
  const html = lire('pages/aujourdhui.html')
  const ouvre = html.indexOf('<script type="module">')
  assert.notStrictEqual(ouvre, -1, 'pages/aujourdhui.html n a plus de module')
  const corps = html.slice(html.indexOf('>', ouvre) + 1, html.indexOf('</script>', ouvre))
  const depart = corps.indexOf('initErrorHandler()')
  assert.notStrictEqual(depart, -1, 'initErrorHandler() a disparu : le decoupage des imports ne tient plus')
  // ⚠ On rend aussi la poignee sur les internes : `chargerNotes` et `etat` sont
  // des declarations de haut niveau du module, et les eprouver DIRECTEMENT evite
  // de faire traverser a `init()` les cinq chargeurs qui n'ont rien a voir.
  return corps.slice(depart) + '\n;return { chargerNotes, etat }'
}

function ouvrirAujourdhui (options = {}) {
  const lectures = []
  // `fetch` enregistre CE QUI EST DEMANDE : c'est la mesure du lot 2.
  const urls = []
  const fetchFaux = (url) => {
    urls.push(String(url))
    if (options.fetchLeve) return Promise.reject(new Error('reseau'))
    return Promise.resolve({ ok: true, status: 200, json: async () => (options.corps || {}) })
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
    t: (k) => k, date: () => '', time: () => '', money: () => '', pct: () => '', num: () => '',
    lang: 'fr', langues: []
  }
  const rien = () => {}
  // `shared/aujourdhui.js` : des fonctions pures, dont on n'a besoin ici que de
  // la FORME de retour. `etatDesBiens` rend une Map, que `renderBiens` interroge.
  const R = new Proxy({}, { get: (_, cle) => (
    cle === 'etatDesBiens' ? (() => new Map())
    : cle === 'noteSur5' ? ((n) => n)
    : (() => [])) })

  const sorti = new Function(
    'requireAuth', 'supabase', 'signOut', 'initErrorHandler', 'logger', 'esc',
    'compteCourant', 'moi', 'peutLire', 'peutEcrire', 'estTitulaire', 'comptes',
    'basculerVers', 'enteteCompte', 'R',
    'I18n', 'HSNav', 'document', 'window', 'location', 'fetch', 'localStorage', 'console',
    batirAujourdhui()
  )(requireAuth, supabase, rien, rien, { error: rien, warn: rien, info: rien }, String,
    () => 'u1', () => 'u1', () => true, () => true, () => true, () => [],
    rien, () => ({}), R,
    I18n, { renderMenu: rien, render: rien }, document_, {}, { search: '', hash: '' },
    fetchFaux, faireStockage(), { error: rien, warn: rien, log: rien })

  return {
    interne: sorti,
    urls,
    lectures,
    I18n,
    bonjour: () => document_.querySelector('[data-bind="greeting"]').textContent,
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

test("LE TEST QUI COMPTE : le prenom et les biens partent ENSEMBLE", async () => {
  const p = ouvrirAujourdhui()
  p.ouvrirSession(); p.repondreI18n()
  await tours()
  const tables = p.lectures.map(l => l.table)
  assert.ok(tables.includes('profiles'), 'le prenom n est jamais demande')
  assert.ok(tables.includes('properties'),
    'les biens attendent la reponse du prenom : les deux lectures sont de nouveau en file')
})

test("LE TEST QUI COMPTE : le bonjour s affiche sans attendre la lecture des biens", async () => {
  // `properties` est la plus lourde des deux (9 colonnes, toutes les lignes du
  // compte, sans limite) et le bonjour n'en a aucun besoin. Dans un
  // `Promise.all` sur les RESULTATS, l'element le plus visible de la page
  // attendait la requete la plus lente.
  const p = ouvrirAujourdhui()
  p.ouvrirSession(); p.repondreI18n()
  await tours()
  p.resoudre('profiles', { data: [{ first_name: 'thierry' }] })
  await tours()
  assert.notStrictEqual(p.bonjour(), '',
    'le bonjour attend la lecture des biens pour s afficher')
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

test('LE TEST QUI COMPTE : l accueil demande les notes UNE fois, pas une fois par bien', async () => {
  const p = ouvrirAujourdhui({ corps: {
    global: { moyenne: 9.4, notes: 42 },
    par_bien: { REF_A: { moyenne: 9.6, notes: 30 } },
    periode: '30j'
  } })
  p.interne.etat.biens = biensDeTest
  await p.interne.chargerNotes()

  const avis = p.urls.filter(u => u.includes('/api/avis'))
  assert.strictEqual(avis.length, 1,
    `${avis.length} appels a /api/avis au lieu d un seul : le 1 + N est revenu`)
  assert.ok(avis[0].includes('action=notes'),
    'l accueil redemande action=cartes, qui assemble les cartes pour deux nombres : ' + avis[0])
  assert.ok(!avis[0].includes('bien='),
    'l accueil demande encore un bien precis : il en faudra donc un par bien')
})

test('LE TEST QUI COMPTE : chaque bien recoit la meme chose qu avant, zero compris', async () => {
  const p = ouvrirAujourdhui({ corps: {
    global: { moyenne: 9.4, notes: 42 },
    // REF_B n'a aucune note sur la periode : la reponse n'a pas sa cle.
    par_bien: { REF_A: { moyenne: 9.6, notes: 30 } },
  } })
  p.interne.etat.biens = biensDeTest
  await p.interne.chargerNotes()

  assert.deepEqual(p.interne.etat.noteGlobale, { moyenne: 9.4, notes: 42 })
  assert.deepEqual(p.interne.etat.notesParBien.get('b1'), { moyenne: 9.6, notes: 30 })
  // Un bien absent de la reponse vaut zero, pas `undefined` : c'est ce que
  // rendait son appel par bien, et `renderBiens` lit `note.moyenne`.
  assert.deepEqual(p.interne.etat.notesParBien.get('b2'), { moyenne: null, notes: 0 })
  // Un bien sans canal n'etait pas interroge : il n'a toujours pas d'entree.
  assert.strictEqual(p.interne.etat.notesParBien.has('b3'), false,
    'un bien sans cle provider recoit une note alors qu aucun avis ne peut lui etre rattache')
})

test('une panne de lecture des notes ne fait pas afficher zero avis', async () => {
  // ⚠ TEST DE NON-REGRESSION (regle 19 de REVIEW.md, point 2) : il est VERT
  // contre le code d'avant ce lot, parce que l'ancien `chargerNotes` rendait
  // deja `null` sur echec. Il ne garde pas un correctif, il garde l'invariant
  // que le passage de N+1 lectures a UNE ne devait pas casser : une panne reste
  // une panne, elle ne devient pas « 0 avis ».
  const p = ouvrirAujourdhui({ fetchLeve: true })
  p.interne.etat.biens = biensDeTest
  await p.interne.chargerNotes()
  assert.strictEqual(p.interne.etat.noteGlobale, null, 'une panne se lit « 0 avis » sur la tuile')
  assert.strictEqual(p.interne.etat.notesParBien.get('b1'), null)
})
