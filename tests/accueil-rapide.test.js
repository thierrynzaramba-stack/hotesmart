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
//   - retirer le `try` : `localStorage` inaccessible (navigation privee,
//     cookies tiers bloques) ferait une landing blanche.
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
  const location = { search: url.search || '', hash: url.hash || '', replace: u => vus.push(u) }
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
  // REVIEW.md, point 2). Contrairement aux treize autres, celui-ci reste VERT
  // contre le code d'avant le lot : il ne garde pas un correctif, il garde une
  // DECISION — ne PAS elargir le motif a `error`. Il a ete eprouve contre la
  // version fautive plausible (motif `/[#&](access_token|refresh_token|error)=/`,
  // celle que suggerait la review) : il rougit contre elle.
  //
  // `#error=access_denied` n'est pas un retour exploitable : aucun jeton a
  // sauver, et rien ne justifie d'envoyer un visiteur sans session vers /login.
  // C'est aussi ce que faisait l'ancien module de fin de page : le client se
  // creait, `_getSessionFromURL` levait, aucune redirection.
  const r = lancerLaSonde([], { hash: '#error=access_denied&error_description=expired' })
  assert.deepEqual(r.redirections, [])
  assert.ok(!r.masque)
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

test('LE TEST QUI COMPTE : requireAuth ne met plus ses deux lectures en file', () => {
  const src = lire('components/auth-guard.js')
  assert.ok(!/await\s+chargerContexte\s*\(/.test(src),
    'chargerContexte est de nouveau attendu seul : onboarding_state repart apres lui')
  assert.ok(/Promise\.all\(\s*\[\s*pContexte\s*,\s*pOnboarding\s*\]\s*\)/.test(src),
    'les deux lectures ne sont plus attendues ensemble')
  // ⚠ CE QUE CE TEST NE PROUVE PAS, et qu'il faut relire a la main : que la
  // DECISION de redirection d'onboarding attend toujours les deux resultats.
  // Paralleliser des lectures n'autorise pas a paralleliser des decisions.
  const iAll = src.indexOf('Promise.all([pContexte, pOnboarding])')
  const iRedir = src.indexOf("window.location.replace('/pages/onboarding.html')")
  assert.ok(iAll !== -1 && iRedir > iAll, 'la redirection d onboarding precede l attente des deux lectures')
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
  assert.ok(/Promise\.all\(\s*\[\s*prenom\(user\)\s*,\s*lireBiens\(\)\s*\]\s*\)/.test(src),
    'le prenom et les biens ne partent plus ensemble')
})
