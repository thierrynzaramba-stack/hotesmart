// tests/outils/banc-calendrier.js
// LE BANC DE LA PAGE CALENDRIER : il execute le VRAI module de
// `pages/calendrier.html` dans un vrai DOM, pour qu'un test puisse rejouer un
// geste de souris ou de doigt — glisser, cliquer, taper — et observer ce qui
// part au serveur.
//
// ⚠ ON N'EN RECOPIE RIEN. Le corps du module est pris tel quel ; seuls ses
// `import` sont retires (leurs symboles sont injectes avant) et l'appel final
// `init()` est coupe, parce qu'il irait au reseau. Les modules partages dont
// la page depend sont eux aussi evalues POUR DE VRAI, dans la MEME fenetre —
// deux realms font des comparaisons fausses (vecu : deepEqual rouge sur deux
// objets identiques).
//
// Seuls l'authentification, le reseau, les droits et le journal sont des
// doubles : ils n'ont rien a voir avec le geste qu'on mesure. Tout ce qu'un
// module partage exporte reellement — `loadCalendarData`, `deplacer`,
// `brancherEvaluation`… — vient de CE module, pas d'un double.

const fs = require('fs')
const path = require('path')
const { JSDOM } = require('jsdom')

const RACINE = path.join(__dirname, '..', '..')
const lire = (...p) => fs.readFileSync(path.join(RACINE, ...p), 'utf8')

// Les modules partages, dans l'ordre des dependances. `import`/`export`
// retires : on les evalue comme des scripts, dans la fenetre du test.
const PARTAGES = ['properties', 'calendar-core', 'calendrier-resa', 'calendrier-contrat',
  'nuits-orphelines', 'bande-jours', 'reordonner-biens']
const scriptPartage = (nom) => lire('shared', nom + '.js')
  .replace(/^import[\s\S]*?from\s*'[^']*'\s*$/gm, '')
  .replace(/^export default /gm, 'const __defaut_' + nom.replace(/-/g, '_') + ' = ')
  .replace(/^export /gm, '')

// Le corps du module de la page : entre <script type="module"> et </script>,
// sans les imports (multi-lignes comprises) et sans l'amorce init().
function corpsDeLaPage () {
  const html = lire('pages', 'calendrier.html')
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(html)
  if (!m) throw new Error('banc : le module de pages/calendrier.html est introuvable')
  const sansImports = m[1].replace(/^import\s[\s\S]*?from\s*'[^']*'\s*$/gm, '')
  const sansAmorce = sansImports.replace(/^init\(\)\.catch\([\s\S]*?\)\s*$/m, '')
  if (/^\s*import\s/m.test(sansAmorce)) throw new Error('banc : un import a survecu')
  if (/^init\(\)/m.test(sansAmorce)) throw new Error('banc : l amorce init() a survecu')
  return sansAmorce
}

// Les RENOMMAGES d'import de la page (`escapeHtml as esc`) : lus dans ses
// propres lignes d'import, pour qu'un renommage de plus n'oblige a rien ici.
function aliasDesImports () {
  const html = lire('pages', 'calendrier.html')
  const paires = [...html.matchAll(/\b([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/g)]
  return paires.map(([, source, local]) => `const ${local} = ${source}`).join('\n')
}

// Le squelette : LE VRAI CORPS DE LA PAGE, scripts retires. Recopier une
// liste d'ancres ici obligerait a la tenir a jour, et un `data-bind` renomme
// passerait inapercu ; en partant du HTML lui-meme, le banc suit la page.
function squelette () {
  const html = lire('pages', 'calendrier.html')
  const corps = html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<link[^>]*>/g, '')
  if (!/data-bind="grilles"/.test(corps)) throw new Error('banc : le corps de la page est vide de ses ancres')
  return corps
}

// Les textes REELS : un test qui lit « Rien a enregistrer » lit la phrase que
// l'hote voit, pas une cle.
const FR = JSON.parse(lire('shared', 'i18n', 'fr.json'))

/**
 * Monte le banc.
 * @param {object} o
 * @param {boolean} o.large      true = ordinateur (>= 900 px), false = telephone
 * @param {function} o.appel     double de `appel(chemin, corpsPost)` : ce que la page envoie
 * @param {boolean} o.ecriture   droit `reservations` en ecriture
 */
function monter ({ large = true, appel = async () => ({ saved: 1, pushed: true }), ecriture = true } = {}) {
  const dom = new JSDOM(squelette(), { runScripts: 'outside-only', url: 'https://exemple.test/calendrier' })
  // Le selecteur de vue vit normalement dans la nav (posee par nav.js, absente
  // ici) : la page le deplace si elle la trouve, et le laisse en place sinon.
  const { window } = dom
  const envois = []
  const toasts = []

  // matchMedia : c'est LUI qui decide ordinateur ou telephone (`estLarge`).
  window.matchMedia = (q) => ({ matches: /min-width:\s*900px/.test(q) ? large : !large, media: q,
    addEventListener () {}, removeEventListener () {}, addListener () {}, removeListener () {} })
  // ⚠ `CSS.escape` EST UNE API DE NAVIGATEUR QUE JSDOM 26 N'A PAS. La page
  // l'utilise pour viser une cellule par son identifiant ; sans elle le banc
  // levait un ReferenceError que jsdom avale, et le test voyait seulement
  // « la saisie ne s'ouvre pas ». L'algorithme est celui de la spec CSSOM.
  window.CSS = {
    escape (valeur) {
      const s = String(valeur)
      let out = ''
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i)
        if (c === 0) { out += '\uFFFD'; continue }
        if ((c >= 0x1 && c <= 0x1f) || c === 0x7f
          || (i === 0 && c >= 0x30 && c <= 0x39)
          || (i === 1 && c >= 0x30 && c <= 0x39 && s.charCodeAt(0) === 0x2d)) {
          out += '\\' + c.toString(16) + ' '; continue
        }
        if (i === 0 && c === 0x2d && s.length === 1) { out += '\\' + s[i]; continue }
        if (c >= 0x80 || c === 0x2d || c === 0x5f
          || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) {
          out += s[i]; continue
        }
        out += '\\' + s[i]
      }
      return out
    }
  }
  window.I18n = {
    lang: 'fr',
    t: (k, v) => {
      let s = Object.prototype.hasOwnProperty.call(FR, k) ? FR[k] : k
      if (v) for (const [a, b] of Object.entries(v)) s = s.split('{' + a + '}').join(String(b))
      return s
    }
  }

  // Les DOUBLES, et rien d'autre : authentification, reseau, droits, journal.
  // ⚠ CE BLOC EST UN GABARIT DE CHAINE : aucun backtick ne peut y vivre, les
  // commentaires compris. Les references de code y sont donc entre guillemets.
  const doubles = `
    const requireAuth = async () => ({ user: { id: 'U1' } })
    const getUser = async () => ({ id: 'U1' })
    const signOut = async () => {}
    const initErrorHandler = () => {}
    const logger = { error: (...a) => { window.__journal.push(a) }, warn () {}, info () {} }
    const supabase = { auth: { getSession: async () => ({ data: { session: { access_token: 'jeton' } } }) } }
    // ⚠ « shared/calendar-core.js » appelle « api.calendar.load ». Sans cette
    // branche, « charger() » levait a CHAQUE ecriture : la relecture d'apres
    // ecriture, « construireEtats », « renderTout() » et la garde de course du
    // jeton de lecture n'etaient jamais exerces, et le journal du banc etait
    // pollue par une erreur que personne n'affirmait (constat 12).
    const api = { get: async () => ({}), post: async () => ({}),
      calendar: { load: async () => window.__chargement() } }
    const compteCourant = () => 'U1'
    const peutLire = () => true
    // ⚠ AVEUGLE A SON ARGUMENT, LE DOUBLE NE PROUVE QUE « UN BOOLEEN GARDE »,
    // PAS « LEQUEL » : une faute de frappe sur le domaine passait au vert. Le
    // double enregistre donc les domaines demandes, et les tests les affirment.
    const peutEcrire = (domaine) => { window.__domaines.push(domaine); return ${ecriture ? 'true' : 'false'} }
    const estTitulaire = () => true
    const comptes = () => []
    const basculerVers = () => {}
    const enteteCompte = () => ({ 'x-hs-compte': 'U1' })
  `
  // LE POINT D'OBSERVATION EST `fetch`, PAS `appel`. Le test traverse ainsi le
  // vrai `appel()` de la page : le jeton, l'en-tete de compte, la lecture du
  // corps JSON, le `!r.ok` et le `e.code` qui decide du message affiche.
  const queue = `
    window.__cal = {
      etat, renderTout, renderFlottante, renderPlanning, renderGrilleMobile,
      joursSelection, actionPrix, viderSelection, enregistrerPopup, ouvrirPopup,
      toast, AUJOURDHUI, estLarge, construireEtats, computeDays, toISO, etatNuit
    }
  `
  window.__journal = []
  window.__domaines = []
  // Ce que rend la relecture d'apres ecriture ; un test peut la remplacer.
  window.__chargement = () => ({ properties: [], inventory: {}, bookings: {}, fermetures: {} })
  try {
    window.eval(PARTAGES.map(scriptPartage).join('\n') + '\n' + doubles + '\n' + aliasDesImports() + '\n'
      + corpsDeLaPage() + '\n' + queue)
  } catch (e) {
    throw new Error('banc : le module de la page n a pas pu etre evalue — ' + e.message)
  }
  window.fetch = async (chemin, options = {}) => {
    const corps = options.body ? JSON.parse(options.body) : null
    // Les EN-TETES sont gardees : c'est la seule facon de prouver que le jeton
    // et l'en-tete de compte partent. Les jeter rendait vrai le commentaire
    // ci-dessus pour `appel()`, et faux pour ce que le test peut verifier
    // (constat 13) : supprimer `enteteCompte()` laissait les 18 tests verts,
    // et un compte delegue aurait ecrit ses prix sur le MAUVAIS compte.
    envois.push({ chemin, methode: options.method || 'GET', corps, entetes: options.headers || {} })
    const r = await appel(chemin, corps)
    const statut = r && r.__statut ? r.__statut : 200
    const charge = r && r.__statut ? (r.__corps || {}) : (r || {})
    return { ok: statut >= 200 && statut < 300, status: statut, json: async () => charge }
  }
  const cal = window.__cal
  // Les toasts : on les lit dans le DOM, la ou l'hote les lit.
  const lireToasts = () => [...window.document.querySelectorAll('.cal-toast')].map(e => e.textContent.trim())
  return { dom, window, doc: window.document, cal, envois, toasts, lireToasts,
    journal: window.__journal, domaines: window.__domaines,
    fermer: () => { try { window.close() } catch {} } }
}

// ─── Peupler : l'etat du calendrier, construit par le code de la PAGE ──────
// On ne fabrique pas `etat.states` a la main : `construireEtats` est la vraie
// fonction, et c'est elle qui decide de l'etat d'une nuit.
function peupler (banc, { biens, inv = {}, jours = 1, mois = null, decalage = 0 } = {}) {
  const { cal } = banc
  cal.etat.biens = biens
  cal.etat.choisis = biens.map(b => b.id)
  cal.etat.choisisDefinis = true
  cal.etat.inv = inv
  cal.etat.propsById = Object.fromEntries(biens.map(b => [b.id, { base: b.base_price ?? null }]))
  cal.etat.rawProps = Object.fromEntries(biens.map(b => [b.id, {}]))
  // ⚠ `etat.pp` VIENT DU SERVEUR dans la vraie page. Le laisser vide faisait
  // pousser a la popup un segment `perPerson` a chaque enregistrement (la
  // valeur lue differait de la valeur affichee), et le test l'aurait pris pour
  // un comportement de la page.
  cal.etat.pp = Object.fromEntries(biens.map(b => [b.id,
    { included: b.included_guests || b.capacity || 1, extraFee: Number(b.extra_guest_fee) || 0 }]))
  cal.etat.bookings = {}
  cal.etat.fermetures = {}
  cal.etat.months = jours
  const d = mois ? new Date(mois + '-01T12:00:00') : new Date()
  cal.etat.annee = d.getFullYear()
  cal.etat.mois = d.getMonth()
  cal.etat.decalage = decalage
  cal.etat.jours = cal.computeDays(jours, 0, decalage)
  const liste = cal.etat.jours.map(cal.toISO)
  cal.construireEtats(liste[0], liste[liste.length - 1])
  cal.renderTout()
  return liste
}

// ─── Gestes ────────────────────────────────────────────────────────────────
// ⚠ jsdom 26 N'A PAS `PointerEvent`. Un evenement de pointeur se fabrique
// donc a partir d'un `MouseEvent`, avec `pointerType` pose dessus : c'est
// exactement ce que le navigateur donne au gestionnaire, et c'est tout ce que
// le code de la page lit. Si le code se mettait a appeler `setPointerCapture`
// — absent de jsdom —, ce banc le dirait tout de suite.
// ⚠ `boutons` EST UNE INFORMATION DU GESTE, PAS UN DETAIL. Le code de la page
// refuse d'etendre une selection quand aucun bouton n'est tenu — un
// relachement hors de la page laissait sinon la selection suivre le curseur
// nu. Le banc doit donc simuler le bouton TENU pendant l'appui et le glisser,
// et RELACHE au relachement, sinon il prouve un geste qui n'existe pas. Un
// test peut forcer `boutons: 0` sur un survol : c'est precisement le cas du
// relachement perdu.
const BOUTONS_PAR_DEFAUT = (type) => /up$|cancel$|^click$/.test(type) ? 0 : 1
function geste (banc, el, type, { pointerType = 'mouse', bouton = 0, boutons = null, pointerId = 1, detail = null } = {}) {
  const { window } = banc
  const bulle = !/enter$|leave$/.test(type)
  const e = new window.MouseEvent(type, {
    bubbles: bulle, cancelable: true, button: bouton, view: window,
    buttons: boutons == null ? BOUTONS_PAR_DEFAUT(type) : boutons,
    detail: detail == null ? (/^click$/.test(type) ? 1 : 0) : detail
  })
  Object.defineProperty(e, 'pointerType', { value: pointerType })
  Object.defineProperty(e, 'pointerId', { value: pointerId })
  Object.defineProperty(e, 'isPrimary', { value: pointerId === 1 })
  el.dispatchEvent(e)
  return e
}
// Le clic du CLAVIER : un `click` sans geste de pointeur, donc `detail === 0`.
const clicClavier = (banc, el) => geste(banc, el, 'click', { detail: 0 })
const touche = (banc, el, key) =>
  el.dispatchEvent(new banc.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))

// Les cases : ordinateur = cellules de la ligne de donnees ; telephone = boutons du mois.
const casesBureau = (banc, bienId) => [...banc.doc.querySelectorAll(
  `[data-ligne-prix] .cal-nuit[data-bien="${bienId}"]`)]
const casesTelephone = (banc, bienId) => [...banc.doc.querySelectorAll(
  `.cal-case[data-bien="${bienId}"]`)]
const barreVisible = (banc) => !banc.doc.querySelector('[data-bind="flottante"]').hidden
const saisie = (banc) => banc.doc.querySelector('input.cal-nuit__saisie')

module.exports = { monter, peupler, geste, clicClavier, touche, casesBureau, casesTelephone, barreVisible, saisie, FR }
