// tests/outils/banc-avis.js
// LE BANC DE LA PAGE AVIS V5 : il execute le VRAI module de `pages/avis.html`
// dans un vrai DOM (jsdom), avec les vraies cartes (`core/avis/cartes.js`), et
// enregistre ce qui part au serveur.
//
// ⚠ POURQUOI UN BANC ET PAS UN GREP (lecon de la recette du 28 octobre 2026,
// tests/outils/banc-messages.js) : un grep prouve qu'un texte existe, il ne
// prouve pas qu'un geste le traverse. Le budget « un appel au chargement » et
// « le meme a 1 et a 12 logements » se MESURENT ici, en comptant les `fetch`.
//
// ⚠ ON N'EN RECOPIE RIEN : le corps du module est pris tel quel ; seuls ses
// `import` statiques sont retires (leurs symboles sont injectes), et ses
// `import()` dynamiques passent par `__importer`, que le test garnit.

const fs = require('fs')
const path = require('path')
const { JSDOM } = require('jsdom')

const RACINE = path.join(__dirname, '..', '..')
const lire = (...p) => fs.readFileSync(path.join(RACINE, ...p), 'utf8')

// I18n minimal, sur le VRAI fr.json : `{x}` et le pluriel ICU du socle.
function i18nFr () {
  const fr = JSON.parse(lire('shared/i18n/fr.json'))
  const pluriel = (s, v) => s.replace(/\{(\w+),\s*plural,\s*((?:[^{}]|\{[^{}]*\})*)\}/g, (_, k, corps) => {
    const n = Number(v[k]); const f = {}
    for (const m of corps.matchAll(/(=\d+|\w+)\s*\{([^{}]*)\}/g)) f[m[1]] = m[2]
    return (f['=' + n] ?? f[new Intl.PluralRules('fr').select(n)] ?? f.other ?? '').replace(/#/g, String(n))
  })
  const t = (k, v = {}) => {
    const s = fr[k]
    if (s === undefined) return k
    return pluriel(s, v).replace(/\{(\w+)\}/g, (m, c) => (v[c] !== undefined ? String(v[c]) : m))
  }
  return {
    lang: 'fr', t,
    init: async () => {},
    apply: (racine) => {
      for (const el of racine.querySelectorAll('[data-i18n]')) el.textContent = t(el.getAttribute('data-i18n'))
      for (const el of racine.querySelectorAll('[data-i18n-attr]')) {
        for (const paire of el.getAttribute('data-i18n-attr').split(';')) {
          const [attr, cle] = paire.split(':')
          if (attr && cle) el.setAttribute(attr.trim(), t(cle.trim()))
        }
      }
    },
    date: (d, o) => new Date(d).toLocaleDateString('fr-FR', o),
  }
}

// Une reponse d'ecran plausible, a N logements.
function reponseEcran ({ biens = 2, attente = [], recents = [], auto = { actifs: 1, total: 2 } } = {}) {
  const liste = Array.from({ length: biens }, (_, i) => ({ name: `Bien ${i + 1}`, provider_property_id: `ref-${i + 1}`, photo_url: null }))
  return {
    cartes: { attente, recents, anciens: null }, anciens_total: 0, liste_incomplete: false,
    biens: liste, periodes: ['15j', '30j', '6mois', 'toujours'],
    stats: { total: 3, positif: 2, remarque: 1, note_sur_5: 4.8, notes: 3, periode: '30j' },
    publication_auto: auto,
  }
}

/**
 * @param o.ecran        (url) → corps JSON de /api/ecran/avis
 * @param o.peutEcrire   droit `avis: write`
 * @param o.compteDelegue  si vrai, `enteteCompte()` rend un X-Compte
 * @param o.url          adresse de la page
 * @param o.cache        { donnees } a poser dans le cache de l'ecran avant l'amorce
 * @param o.retenirEcran si vrai, la PREMIERE lecture de l'ecran attend `banc.liberer()`
 */
async function monter (o = {}) {
  const html = lire('pages/avis.html')
  const corps = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script src="/shared/i18n/i18n.js">'))
  const dom = new JSDOM(`<!doctype html><html><body>${corps}</body></html>`, { url: o.url || 'https://hs.test/avis', runScripts: 'outside-only', pretendToBeVisual: true })
  const w = dom.window
  const journal = { fetch: [], reglagesMontes: 0, bus: [], alertes: [] }

  let liberer = null
  const retenue = o.retenirEcran ? new Promise(r => { liberer = r }) : null
  let premiere = true
  w.fetch = async (url, opts = {}) => {
    const entree = { url: String(url), methode: opts.method || 'GET', entetes: opts.headers || {}, corps: opts.body ? JSON.parse(opts.body) : null }
    journal.fetch.push(entree)
    if (entree.url.startsWith('/api/ecran/avis')) {
      if (retenue && premiere) { premiere = false; await retenue }
      const d = (o.ecran || (() => reponseEcran()))(entree.url)
      return { ok: true, status: 200, json: async () => d }
    }
    if (entree.url.startsWith('/api/avis?action=sejours')) return { ok: true, status: 200, json: async () => ({ sejours: [] }) }
    if (entree.url === '/api/avis') return { ok: true, status: 200, json: async () => ({ ok: true }) }
    return { ok: false, status: 404, json: async () => ({ error: 'inconnu' }) }
  }
  w.alert = (m) => journal.alertes.push(m)
  w.I18n = i18nFr()
  w.HSNav = { renderMenu () {}, render () {} }

  const cartes = await import(path.join(RACINE, 'core/avis/cartes.js'))
  const cache = await import(path.join(RACINE, 'shared/cache-ecran.js')).catch(() => null)
  // Le cache partage lit `localStorage` en global : on lui donne celui de la fenetre.
  globalThis.localStorage = w.localStorage
  const MOI = 'u-moi'
  const COMPTE = o.compteDelegue ? 'compte-autre' : MOI
  if (o.cache && cache) cache.ecrire('avis', MOI, COMPTE, o.cache)

  const injectes = {
    requireAuth: async () => ({ access_token: 'jeton-session', user: { id: MOI, email: 'th@exemple.test' } }),
    signOut: async () => {},
    supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'jeton-relu' } } }) } },
    initErrorHandler: () => {},
    logger: { info () {}, error () {}, warn () {} },
    esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    compteCourant: () => COMPTE,
    peutLire: () => true,
    peutEcrire: (d) => d === 'avis' ? Boolean(o.peutEcrire) : false,
    estTitulaire: () => !o.compteDelegue,
    comptes: () => [],
    basculerVers: () => {},
    enteteCompte: () => (o.compteDelegue ? { 'X-Compte': COMPTE } : {}),
    lireCache: (...a) => (cache ? cache.lire(...a) : null),
    ecrireCache: (...a) => (cache ? cache.ecrire(...a) : false),
    monterCartes: cartes.monter,
    __importer: async (chemin) => {
      if (chemin === '/shared/hs-bus.js') return { hsBus: { ouvrir: async (action, p) => { journal.bus.push({ action, ...p }); return { ok: true } } } }
      if (chemin === '/core/avis/ecran-reglages.js') return { monter: async (zone) => { journal.reglagesMontes++; zone.innerHTML = '<p data-test="reglages">Réglages</p>' } }
      throw new Error('import inattendu : ' + chemin)
    },
  }
  Object.assign(w, injectes)

  const module = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  const code = module
    .replace(/^import [^\n]*from [^\n]*$/gm, '')
    .replace(/\bimport\(/g, '__importer(')
    // L'amorce part pour de vrai, mais le test l'attend : on la publie.
    .replace(/^init\(\)\.catch\(/m, 'window.__amorce = init().catch(')
  w.eval(code)
  const attendre = () => new Promise(r => setTimeout(r, 0))
  // Une lecture retenue bloque l'amorce : le test regarde l'ecran AVANT la
  // reponse, puis libere et attend `banc.amorce`.
  if (!o.retenirEcran) await w.__amorce
  await attendre()

  return {
    dom, w, d: w.document, journal,
    $: (s) => w.document.querySelector(s),
    $$: (s) => [...w.document.querySelectorAll(s)],
    cliquer: async (el) => { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await attendre(); await attendre() },
    liberer: async () => { if (liberer) liberer(); await w.__amorce; await attendre() },
    amorce: w.__amorce,
    attendre,
    lecturesEcran: () => journal.fetch.filter(f => f.url.startsWith('/api/ecran/avis')),
    fermer: () => { delete globalThis.localStorage; w.close() },
  }
}

module.exports = { monter, reponseEcran }
