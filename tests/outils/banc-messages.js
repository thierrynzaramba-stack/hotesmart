// tests/outils/banc-messages.js
// LE BANC DE LA PAGE MESSAGES : il execute le VRAI module de
// `pages/messages.html` dans un vrai DOM, pour qu'un test puisse rejouer un
// geste de l'hote — ouvrir le panneau, cliquer une pilule, decocher la pause,
// enregistrer — et observer ce qui part au serveur ET ce qui s'affiche.
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

function corpsDeLaPage () {
  const html = lire('pages', 'messages.html')
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(html)
  if (!m) throw new Error('banc : le module de pages/messages.html est introuvable')
  const sansImports = m[1].replace(/^import\s[\s\S]*?from\s*'[^']*'\s*$/gm, '')
  const sansAmorce = sansImports.replace(/^init\(\)\.catch\([\s\S]*?\)\s*$/m, '')
  if (/^\s*import\s/m.test(sansAmorce)) throw new Error('banc : un import a survecu')
  if (/^init\(\)/m.test(sansAmorce)) throw new Error('banc : l amorce init() a survecu')
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
  const traduire = (k, v) => {
    let s = Object.prototype.hasOwnProperty.call(FR, k) ? FR[k] : k
    s = window.__plural(s, v || {})
    if (v) for (const [a, b] of Object.entries(v)) s = s.split('{' + a + '}').join(String(b))
    return s
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
      from: () => window.__table()
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
      noteReglage, PILULES
    }
  `
  window.__journal = []
  window.__domaines = []
  // Les lectures et ecritures qui passent par supabase — consignes, relecture
  // des taches — ne sont pas le sujet de ce banc : un double inerte suffit.
  // ⚠ ET IL EST DELIBEREMENT PERMISSIF : il accepte n'importe quel maillon de
  // chaine (`.eq`, `.in`, `.order`, `.limit`…) et rend toujours « aucune
  // ligne, aucune erreur ». Un double permissif VALIDE du code qui ne pourrait
  // pas tourner (le depot l'a paye une fois), donc aucun test de ce banc ne
  // doit affirmer quoi que ce soit sur une requete supabase : ce qui se mesure
  // ici, c'est le PANNEAU. Les requetes du module `appliquer-delai` sont
  // eprouvees par leur propre double, strict, dans
  // tests/guestflow-appliquer-delai.test.js.
  window.__table = () => {
    const resultat = () => ({ data: [], error: null })
    const q = new Proxy({}, {
      get (_, nom) {
        if (nom === 'then') return (f, r) => Promise.resolve(resultat()).then(f, r)
        if (nom === 'single' || nom === 'maybeSingle') return async () => ({ data: { id: 'C1' }, error: null })
        return () => q
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

module.exports = { monter, peupler, clic, changer, corps, pilules, pilule, pilManuel,
  casePause, boutonSave, selBien, FR }
