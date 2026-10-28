// tests/outils/banc-messages.js
// LE BANC DE LA PAGE MESSAGES : il execute le VRAI module de
// `pages/messages.html` dans un vrai DOM, pour qu'un test puisse rejouer un
// geste de l'hote — cliquer une pilule, decocher la pause, enregistrer — et
// observer ce qui part au serveur ET ce qui s'affiche.
//
// ⚠ DEUX NIVEAUX, ET IL FAUT SAVOIR LEQUEL ON MONTE (constat 10 de la revue du
// 28 octobre 2026 : l'en-tete promettait plus que le banc ne tenait).
//   · `monter()` + `peupler()` : seuls les ecouteurs de `brancherTiroir` —
//     donc du CORPS du volet — sont vivants. Le selecteur de bien et les deux
//     boutons de volet, branches par `init()`, ne sont PAS cliquables.
//   · `monter()` + `await amorcer()` + `peupler()` : `init()` tourne pour de
//     vrai, avec les doubles en place, et TOUS les gestes sont rejouables.
// Le premier niveau a laisse passer deux defauts (l'aller-retour entre volets
// ecrasait le bien choisi a la main ; le selecteur restait vivant pendant un
// enregistrement) : un test qui touche a l'en-tete du tiroir amorce.
//
// ⚠ POURQUOI CE BANC EXISTE, ET C'EST LA LEÇON DE LA RECETTE DU 28 OCTOBRE
// 2026. La confirmation de sortie de « Je valide chaque reponse » etait
// gardee par un test qui GREPAIT la ligne dans la source
// (`tests/messages-v5.test.js`, « LE TEST QUI COMPTE »). La ligne etait la,
// le test etait vert — et Thierry, en recette, n'a vu AUCUNE confirmation :
// le gestionnaire n'etait jamais branche, parce que le bouton qu'il visait
// n'est pas celui que la page rend. Un grep prouve qu'un texte existe ; il ne
// prouve pas qu'un geste le traverse. D'ou ce banc : les gardes produit de ce
// panneau se mesurent desormais en CLIQUANT.
//
// ⚠ ON N'EN RECOPIE RIEN (meme discipline que tests/outils/banc-calendrier.js).
// Le corps du module est pris tel quel ; seuls ses `import` sont retires
// (leurs symboles sont injectes avant) et l'amorce `init()` est coupee, parce
// qu'elle irait au reseau. Les modules partages sont evalues POUR DE VRAI,
// dans la MEME fenetre — deux realms font des comparaisons fausses.

const fs = require('fs')
const path = require('path')
const { JSDOM } = require('jsdom')

const RACINE = path.join(__dirname, '..', '..')
const lire = (...p) => fs.readFileSync(path.join(RACINE, ...p), 'utf8')

// Les modules partages dont la page importe des symboles, dans l'ordre des
// dependances. `import`/`export` retires : on les evalue comme des scripts.
const PARTAGES = ['properties', 'aujourdhui', 'messages-programmes', 'calendrier-resa']
const scriptPartage = (nom) => lire('shared', nom + '.js')
  .replace(/^import[\s\S]*?from\s*'[^']*'\s*$/gm, '')
  .replace(/^export default /gm, 'const __defaut_' + nom.replace(/-/g, '_') + ' = ')
  .replace(/^export /gm, '')

// ⚠ SEULE LA LIGNE `init().catch(…)` EST COUPEE, PAS LA FONCTION. `init()` est
// exportee dans la queue et `amorcer()` l'appelle : c'est elle qui branche le
// SELECTEUR DE BIEN et les DEUX BOUTONS DE VOLET. Sans elle, ces deux gestes
// n'etaient pas rejouables — et c'est precisement ce qui avait rendu deux
// defauts invisibles au banc (constats 1 et 7 de la revue du 28 octobre 2026 :
// l'aller-retour entre volets ecrasait le bien choisi a la main, et le
// selecteur restait vivant pendant un enregistrement).
function corpsDeLaPage () {
  const html = lire('pages', 'messages.html')
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(html)
  if (!m) throw new Error('banc : le module de pages/messages.html est introuvable')
  const sansImports = m[1].replace(/^import\s[\s\S]*?from\s*'[^']*'\s*$/gm, '')
  const sansAmorce = sansImports.replace(/^init\(\)\.catch\([\s\S]*?\)\s*$/m, '')
  if (/^\s*import\s/m.test(sansAmorce)) throw new Error('banc : un import a survecu')
  // ⚠ LE GARDE-FOU VISE `init()` EN DEBUT DE LIGNE, PAS SEULEMENT
  // `init().catch(` (constat mineur de la derniere revue : je l'avais rétréci).
  // Une amorce ecrite `init()` tout court n'etait alors ni coupee ni detectee,
  // et le banc partait au reseau en rendant trois echecs sans rapport apparent
  // au lieu d'un message clair.
  if (/^init\(\)/m.test(sansAmorce)) throw new Error('banc : l amorce init() a survecu')
  if (!/^async function init \(/m.test(sansAmorce)) throw new Error('banc : init() a disparu du module')
  return sansAmorce
}

// Les RENOMMAGES d'import de la page (`escapeHtml as esc`, `libelleDelai as
// libelleDelaiBrut`) : lus dans ses propres lignes d'import.
function aliasDesImports () {
  const html = lire('pages', 'messages.html')
  const module = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1]
  const imports = module.match(/^import\s[\s\S]*?from\s*'[^']*'\s*$/gm) || []
  const paires = [...imports.join('\n').matchAll(/\b([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/g)]
  return paires.map(([, source, local]) => `const ${local} = ${source}`).join('\n')
}

// Le squelette : LE VRAI CORPS DE LA PAGE, scripts retires. Partir du HTML
// lui-meme fait suivre le banc quand un `data-bind` est renomme.
function squelette () {
  const corps = lire('pages', 'messages.html')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<link[^>]*>/g, '')
  if (!/data-bind="tiroir-corps"/.test(corps)) {
    throw new Error('banc : le corps de la page est vide de ses ancres')
  }
  return corps
}

const FR = JSON.parse(lire('shared', 'i18n', 'fr.json'))

// La VRAIE fonction `plural` de `shared/i18n/i18n.js`, par equilibre des
// accolades : un double qui ne remplacerait que `{n}` rendrait les chaines ICU
// telles quelles, et un test comparerait une chaine ICU a elle-meme.
function fabriquerPlural (window) {
  const src = lire('shared', 'i18n', 'i18n.js')
  const i = src.indexOf('function plural(')
  if (i < 0) throw new Error('banc : la fonction plural de i18n.js est introuvable')
  let j = src.indexOf('{', i); let profondeur = 0; let fin = -1
  for (; j < src.length; j++) {
    if (src[j] === '{') profondeur++
    else if (src[j] === '}') { profondeur--; if (!profondeur) { fin = j + 1; break } }
  }
  if (fin < 0) throw new Error('banc : accolades desequilibrees dans plural()')
  window.eval("const current = 'fr';\n" + src.slice(i, fin) + '\nwindow.__p = plural')
  const f = window.__p
  if (f('{n, plural, one {# nuit} other {# nuits}}', { n: 2 }) !== '2 nuits') {
    throw new Error('banc : la fonction plural extraite ne pluralise pas')
  }
  return f
}

/**
 * Monte le banc.
 * @param {object} o
 * @param {function} o.appel       double de `fetch` vu par chemin + corps POST
 * @param {boolean}  o.titulaire   `estTitulaire()` — les reglages IA en dependent
 * @param {boolean}  o.ecriture    droit `messages` en ecriture
 * @param {boolean}  o.confirme    ce que repond `window.confirm` par defaut
 */
function monter ({ appel = async () => ({}), titulaire = true, ecriture = true, confirme = true } = {}) {
  const dom = new JSDOM(squelette(), { runScripts: 'outside-only', url: 'https://exemple.test/messages' })
  const { window } = dom
  const envois = []

  window.matchMedia = (q) => ({ matches: false, media: q,
    addEventListener () {}, removeEventListener () {}, addListener () {}, removeListener () {} })
  // ⚠ LES CONFIRMATIONS SONT LE SUJET DE CE BANC : chaque appel est GARDE avec
  // son texte, et un test affirme la PHRASE que l'hote lit, pas un compteur.
  window.__confirmations = []
  window.__reponseConfirm = confirme
  window.confirm = (texte) => {
    window.__confirmations.push(String(texte))
    const r = window.__reponseConfirm
    return typeof r === 'function' ? r(String(texte)) : r !== false
  }
  window.__plural = fabriquerPlural(window)
  // ⚠ UNE PASSE UNIQUE, COMME LE VRAI `t()` (constat 10 de la revue). Ma
  // premiere version substituait variable par variable (`split`/`join` en
  // boucle) : une valeur contenant `{autre}` aurait ete RE-substituee ici et
  // pas en production. `shared/i18n/i18n.js` fait
  // `s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '{' + k + '}')` — une seule
  // passe, et un parametre absent reste visible tel quel.
  const traduire = (k, v) => {
    const s = Object.prototype.hasOwnProperty.call(FR, k) ? FR[k] : k
    const vars = v || {}
    return window.__plural(s, vars)
      .replace(/\{(\w+)\}/g, (_, c) => (vars[c] ?? '{' + c + '}'))
  }
  window.I18n = {
    lang: 'fr', t: traduire, init: async () => {}, apply: () => {},
    date: (d) => String(d && d.toISOString ? d.toISOString().slice(0, 10) : d),
    time: (d) => String(d && d.toISOString ? d.toISOString().slice(11, 16) : d)
  }
  window.HSNav = { render: () => {}, renderMenu: () => {} }

  // Les DOUBLES, et rien d'autre : authentification, reseau, droits, journal.
  // ⚠ CE BLOC EST UN GABARIT DE CHAINE : aucun backtick ne peut y vivre.
  const doubles = `
    const requireAuth = async () => ({ user: { id: 'U1' } })
    const getUser = async () => ({ id: 'U1' })
    const signOut = async () => {}
    const initErrorHandler = () => {}
    const logger = { error: (...a) => { window.__journal.push(a) }, warn () {}, info () {} }
    const api = { get: async () => ({}), post: async () => ({}) }
    const supabase = {
      auth: { getSession: async () => ({ data: { session: { access_token: 'jeton' } } }) },
      from: (nom) => window.__table(nom)
    }
    const compteCourant = () => 'U1'
    const peutLire = () => true
    // ⚠ AVEUGLE A SON ARGUMENT, LE DOUBLE NE PROUVE QUE « UN BOOLEEN GARDE »,
    // PAS « LEQUEL » : une faute de frappe sur le domaine passerait au vert.
    const peutEcrire = (domaine) => { window.__domaines.push(domaine); return ${ecriture ? 'true' : 'false'} }
    const estTitulaire = () => ${titulaire ? 'true' : 'false'}
    const comptes = () => []
    const basculerVers = () => {}
    const enteteCompte = () => ({ 'x-hs-compte': 'U1' })
  `
  const queue = `
    window.__msg = {
      etat, renderTiroir, ouvrirTiroir, renderListe, renderFil, renderFiltres,
      enregistrerPanneau, basculerPause, delaisEnCours, delaisDuBien,
      bandeauEcheance, etatEcheance, peutReprendre, pausesFiables, voletIA,
      noteReglage, bienDuFilOuvert, init, PILULES
    }
  `
  window.__journal = []
  window.__domaines = []
  // ⚠ LE DOUBLE SUPABASE REFUSE CE QUE LE VRAI REFUSE (constat 9 de la revue
  // du 28 octobre 2026, et c'est un faux vert qu'il a MESURE). Sa premiere
  // version acceptait n'importe quel nom de maillon et n'importe quelle
  // table : en reecrivant `ecrireConsigne` vers une table inexistante et des
  // maillons qui n'existent pas, les 14 tests restaient verts — y compris les
  // assertions sur la NOTE, qui depend de l'etape 3 du panneau, donc de
  // supabase. Un double plus permissif que le vrai VALIDE du code qui ne peut
  // pas tourner ; le depot l'a deja paye une fois.
  // Les deux listes viennent du fichier mesure : `supabase.from('…')` de
  // pages/messages.html, et les maillons qu'il enchaine.
  const TABLES = new Set(['agent_prompting', 'agent_tasks', 'message_templates',
    'properties', 'property_locks'])
  // ⚠ RECOMPTE A LA MAIN SUR LE FICHIER (constat mineur de la derniere revue) :
  // ma premiere version portait `filter` et `maybeSingle`, que la page
  // n'utilise PAS — les `.filter(` de pages/messages.html sont tous des
  // `Array.prototype.filter`. Le commentaire disait « les deux listes viennent
  // du fichier mesure » ; elles en viennent maintenant pour de vrai. Un maillon
  // que la page se met a utiliser fera LEVER le banc, et c'est le but : on
  // l'ajoute ici en connaissance de cause.
  const MAILLONS = new Set(['select', 'insert', 'update', 'delete', 'eq', 'neq', 'is',
    'in', 'order', 'limit'])
  const FINS = new Set(['single'])
  // `window.__echecTable` permet a un test de faire ECHOUER une table : sans
  // ca, aucune assertion de note n'est conditionnelle a cette etape.
  window.__echecTable = null
  // ⚠ IL N'Y A PAS DE `__leveTable`, ET C'EST MESURE — constat 4 de la derniere
  // revue, et le depot l'avait DEJA ecrit : « postgrest-js NE LEVE JAMAIS sans
  // `.throwOnError()` — il convertit meme une panne fetch en
  // `{ data: null, error }` » (api/book-webhook.js, constat de review verifie
  // par execution ; postgrest-js 2.102.1, et aucun `.throwOnError()` dans ce
  // depot). J'avais ajoute un `__leveTable` pour atteindre le `catch` d'un
  // appelant : il modelisait une panne que le vrai client ne produit pas, donc
  // il VALIDAIT un chemin inatteignable. Un double qui invente une forme de
  // panne est aussi faux qu'un double qui en avale une.
  // Consequence a retenir pour les tests : une erreur de lecture se lit dans
  // `error`, et une lecture qui fait `if (error) return` l'AVALE. Il n'y a pas
  // de chemin par lequel un test puisse la faire remonter plus haut.
  //
  // Ce que les tables ont ete appelees, pour qu'un test puisse affirmer qu'une
  // lecture n'a PAS eu lieu.
  window.__tables = []
  // ⚠ CE QUE `single()` REND EST UNE LIGNE MINIMALE, ET C'EST UNE LIMITE DU
  // BANC, PAS UN CONTRAT (constat mineur de la derniere revue). La page fait
  // `.update(…).select().single()` sur `message_templates` et reinjecte la
  // ligne rendue dans `etat.templates` : un `{ id }` nu y entre comme un
  // modele AMPUTE, ce que le vrai serveur ne renverrait jamais. Aucun test de
  // ce banc ne touche au volet Programmes ; celui qui le fera devra poser
  // `__ligneUnitaire` avec une ligne complete, sinon il mesurera une page
  // nourrie de faux.
  window.__ligneUnitaire = null
  window.__table = (nom) => {
    if (!TABLES.has(nom)) throw new Error('banc : table inconnue de la page — ' + nom)
    window.__tables.push(nom)
    const resultat = () => (window.__echecTable === nom
      ? { data: null, error: { message: 'banc : echec demande sur ' + nom } }
      : { data: [], error: null })
    const unitaire = () => (window.__echecTable === nom
      ? { data: null, error: { message: 'banc : echec demande sur ' + nom } }
      : { data: window.__ligneUnitaire || { id: 'C1' }, error: null })
    const q = new Proxy({}, {
      get (_, cle) {
        if (cle === 'then') return (f, r) => Promise.resolve(resultat()).then(f, r)
        if (FINS.has(cle)) return async () => unitaire()
        if (MAILLONS.has(cle)) return () => q
        throw new Error('banc : maillon inconnu de la page — .' + String(cle) + '() sur ' + nom)
      }
    })
    return q
  }
  try {
    window.eval(PARTAGES.map(scriptPartage).join('\n') + '\n' + doubles + '\n' + aliasDesImports() + '\n'
      + corpsDeLaPage() + '\n' + queue)
  } catch (e) {
    throw new Error('banc : le module de la page n a pas pu etre evalue — ' + e.message)
  }
  // LE POINT D'OBSERVATION EST `fetch`, PAS `appel` : le test traverse ainsi le
  // vrai `appel()` de la page — le jeton, l'en-tete de compte, le `!r.ok`.
  window.fetch = async (chemin, options = {}) => {
    const corps = options.body ? JSON.parse(options.body) : null
    envois.push({ chemin, methode: options.method || 'GET', corps, entetes: options.headers || {} })
    const r = await appel(chemin, corps)
    const statut = r && r.__statut ? r.__statut : 200
    const charge = r && r.__statut ? (r.__corps || {}) : (r || {})
    return { ok: statut >= 200 && statut < 300, status: statut, json: async () => charge }
  }
  const msg = window.__msg
  return {
    dom, window, doc: window.document, msg, envois,
    journal: window.__journal, domaines: window.__domaines,
    confirmations: window.__confirmations,
    tables: window.__tables,
    repondreConfirm: (v) => { window.__reponseConfirm = v },
    note: () => {
      const n = window.document.querySelector('[data-bind="tiroir-note"]')
      return n.hidden ? null : n.textContent
    },
    noteOk: () => window.document.querySelector('[data-bind="tiroir-note"]')
      .classList.contains('msg-tiroir__note--ok'),
    fermer: () => { try { window.close() } catch {} }
  }
}

// ─── Amorcer : la VRAIE `init()` de la page, avec les doubles en place ─────
// C'est elle qui branche le selecteur de bien et les deux boutons de volet.
// Un test qui veut rejouer CES gestes amorce d'abord ; les autres peuvent s'en
// passer, `peupler` ouvre le panneau directement.
async function amorcer (banc) {
  await banc.window.__msg.init()
  // ⚠ CE GARDE-FOU NE VERIFIE QUE LE SQUELETTE, ET SON COMMENTAIRE DISAIT LE
  // CONTRAIRE (constat 5 de la seconde revue). Il affirmait « si `init()`
  // cessait de brancher le selecteur, les tests passeraient au vert » — faux :
  // `[data-bind="tiroir-bien"]` est un noeud STATIQUE de pages/messages.html,
  // qu'`init()` ne cree pas. Retirer l'`addEventListener('change', …)` le
  // laissait vert. Il ne sert donc qu'a dire « l'ancre existe encore ».
  // Ce qui exerce VRAIMENT l'ecouteur, c'est le test « un aller-retour entre
  // volets ne reprend pas le bien du fil » de
  // tests/messages-panneau-ia-dom.test.js : il change de bien au selecteur et
  // affirme que `etat.tiroirBien` a suivi.
  const sel = banc.doc.querySelector('[data-bind="tiroir-bien"]')
  if (!sel) throw new Error('banc : l ancre du selecteur de bien a disparu du squelette')
  banc.window.__amorce = true
  return banc
}

// ─── Peupler : l'etat du panneau, puis le rendu par le code de la PAGE ─────
// On ne fabrique pas le HTML du volet a la main : `renderTiroir` est la vraie
// fonction, et c'est elle qui decide ce que l'hote voit.
function peupler (banc, { biens = [], config = {}, pauses = {}, pausesLues = true,
  prompting = { global: '', overrides: {} }, taches = [], conversations = [], ouverte = null,
  volet = 'ia', bien = null } = {}) {
  const { msg } = banc
  msg.etat.biens = new Map(biens.map(b => [b.ref, { name: b.nom || b.ref, photo: null }]))
  msg.etat.configIA = config
  msg.etat.modes = Object.fromEntries(Object.entries(config || {})
    .map(([k, v]) => [k, (v && v.mode === 'auto') ? 'auto' : 'test']))
  msg.etat.pauses = pauses
  msg.etat.pausesLues = pausesLues
  msg.etat.prompting = prompting
  msg.etat.taches = taches
  msg.etat.conversations = conversations
  msg.etat.ouverte = ouverte
  msg.etat.tiroirVolet = volet
  msg.etat.tiroirBien = bien
  msg.etat.delaisEdit = null
  msg.ouvrirTiroir(true)
  return banc
}

// ─── Gestes ───────────────────────────────────────────────────────────────
const clic = (banc, el) => {
  if (!el) throw new Error('banc : clic sur un element absent')
  el.dispatchEvent(new banc.window.MouseEvent('click', { bubbles: true, cancelable: true, view: banc.window }))
}
const changer = (banc, el, valeur) => {
  if (!el) throw new Error('banc : changement sur un element absent')
  if (el.type === 'checkbox') el.checked = valeur === true
  else el.value = String(valeur)
  el.dispatchEvent(new banc.window.Event('change', { bubbles: true }))
}
// Le panneau : les elements que l'hote vise, nommes par ce qu'ils FONT.
const corps = (banc) => banc.doc.querySelector('[data-bind="tiroir-corps"]')
const pilules = (banc) => [...corps(banc).querySelectorAll('[data-delai]')]
const pilule = (banc, valeur) => corps(banc).querySelector('[data-delai="reponse|' + valeur + '"]')
const pilManuel = (banc) => corps(banc).querySelector('[data-delai-manuel]')
const casePause = (banc) => corps(banc).querySelector('[data-tiroir-pause]')
const boutonSave = (banc) => corps(banc).querySelector('[data-panneau-save]')
const selBien = (banc) => banc.doc.querySelector('[data-bind="tiroir-bien"]')

// ⚠ LAISSER RETOMBER CE QU'UN GESTE A LANCE, AVANT DE FERMER LA FENETRE.
// Ouvrir le volet « Messages programmes » declenche `chargerProgrammes(ref)`,
// qui est ASYNCHRONE : si le test finit et ferme la fenetre avant, le code de
// la page retombe sur un document mort et node:test rend un
// `unhandledRejection` qui fait echouer le FICHIER — 22 verts et un rouge sans
// nom. Ce n'est pas un defaut de la page : c'est le banc qui coupe le sol.
const reposer = async (banc, tours = 3) => {
  for (let i = 0; i < tours; i++) await new Promise(r => setTimeout(r, 0))
  return banc
}

// Le bouton d'en-tete qui ouvre un volet : le geste reel, celui qui bascule.
// Il n'existe qu'apres `amorcer()` — sans elle, son ecouteur n'est pas branche.
const boutonVolet = (banc, nom) =>
  banc.doc.querySelector('[data-ouvre-volet="' + nom + '"]')
const tiroirOuvert = (banc) => !banc.doc.querySelector('[data-bind="tiroir"]').hidden

module.exports = { monter, amorcer, peupler, clic, changer, reposer, corps, pilules,
  pilule, pilManuel, casePause, boutonSave, selBien, boutonVolet, tiroirOuvert, FR }
