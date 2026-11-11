// tests/outils/banc-charges.js
// LE BANC DE LA PAGE CHARGES (compte de charges, lot 3) : il exécute le VRAI
// module de `pages/charges.html` dans un vrai DOM (jsdom), avec la VRAIE vue
// (`shared/charges-vue.js`), et enregistre ce qui part au serveur.
//
// ⚠ MÊME MÉTHODE QUE tests/outils/banc-avis.js : un grep prouve qu'un texte
// existe, il ne prouve pas qu'un geste le traverse. Le budget « un appel au
// chargement » et chaque geste se MESURENT ici, en comptant les `fetch`.
// ⚠ ON N'EN RECOPIE RIEN : le corps du module est pris tel quel ; seuls ses
// `import` statiques sont retirés (leurs symboles sont injectés).

const fs = require('fs')
const path = require('path')
const { JSDOM } = require('jsdom')

const RACINE = path.join(__dirname, '..', '..')
const lire = (...p) => fs.readFileSync(path.join(RACINE, ...p), 'utf8')

// I18n minimal, sur le VRAI fr.json : `{x}` seulement (les clés du lot n'ont
// pas de pluriel ICU).
function i18nFr () {
  const fr = JSON.parse(lire('shared/i18n/fr.json'))
  const t = (k, v = {}) => {
    const s = fr[k]
    if (s === undefined) return k
    return s.replace(/\{(\w+)\}/g, (m, c) => (v[c] !== undefined ? String(v[c]) : m))
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
    }
  }
}

const ENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BIEN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const BIEN_VIEUX = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/** Une facture plausible. */
function facture (n, extra = {}) {
  return {
    id: id(n), statut: 'validee', motif: null, origine: 'fichier', entite_juridique_id: ENT, bien_id: BIEN,
    fournisseur_nom: `Fournisseur ${n}`, fournisseur_siret: null, numero_facture: `F-${n}`, date_facture: '2026-11-02',
    jour: '2026-11-02', date_repli: false, montant_ht_cents: 10000, montant_tva_cents: 2000, montant_ttc_cents: 12000,
    categorie: 'energie', signal: null, signal_tranche: false, groupe_doublon: null, tentatives_lecture: 0,
    cree_le: '2026-11-02T10:00:00Z', valide_le: '2026-11-03T10:00:00Z', ...extra
  }
}

/** Une réponse d'écran plausible. */
function reponseEcran ({ aTraiter = [], nombre = null, liste = [], suite = null, entites = null, totaux, biens = null } = {}) {
  return {
    a_traiter: { lignes: aTraiter, nombre: nombre == null ? aTraiter.length : nombre },
    liste: { lignes: liste, suite },
    entites: entites || [{ id: ENT, nom: 'Moi', archivee: false, debut_exercice: null }],
    biens: biens || [{ id: BIEN, nom: 'Studio', entite_id: ENT }],
    biens_archives: [{ id: BIEN_VIEUX, nom: 'Ancien', entite_id: ENT }],
    totaux: totaux === undefined
      ? {
          total: { ht: 10000, tva: 2000, ttc: 12000, nb_factures: 1, nb_non_verifiees: 0, nb_signaux: 0, nb_sans_ht: 0, nb_sans_tva: 0, nb_sans_ttc: 0 },
          par_mois: [{ cle: '2026-11', ht: 10000, tva: 2000, ttc: 12000, nb_factures: 1, nb_sans_ttc: 0 }],
          par_categorie: [{ cle: 'energie', ttc: 12000 }], par_bien: [{ cle: BIEN, ttc: 12000 }],
          calcule_le: '2026-11-10T19:00:00Z', entite: null, periode: '12_mois', proposees: ['12_mois'], debut: '2025-12-01', fin: '2026-11-30'
        }
      : totaux,
    categories: ['menage', 'linge', 'consommables', 'energie', 'internet_telephone', 'entretien', 'travaux_equipement', 'assurance', 'impots_taxes', 'copropriete', 'abonnements_logiciels', 'honoraires', 'commissions_plateformes', 'frais_bancaires', 'autre']
  }
}

/**
 * @param o.ecran(url)   → corps JSON de /api/ecran/charges (ou lève { status })
 * @param o.geste(corps) → corps JSON de POST /api/charges (ou lève { status, error })
 * @param o.depot(url)   → statut HTTP du dépôt au stockage (200 par défaut)
 * @param o.confirmer    réponse de `confirm` (vrai par défaut)
 * @param o.titulaire    faux : le compte courant n'est pas le sien
 */
async function monter (o = {}) {
  const html = lire('pages/charges.html')
  const corps = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script src="/shared/i18n/i18n.js">'))
  const dom = new JSDOM(`<!doctype html><html><body>${corps}</body></html>`, { url: 'https://hs.test/charges', runScripts: 'outside-only', pretendToBeVisual: true })
  const w = dom.window
  const journal = { fetch: [], onglets: [], confirmations: [], gardes: 0 }

  const repondre = (statut, corpsJson) => ({ ok: statut >= 200 && statut < 300, status: statut, json: async () => corpsJson })
  w.fetch = async (url, opts = {}) => {
    const u = String(url)
    const entree = { url: u, methode: opts.method || 'GET', entetes: opts.headers || {}, corps: null }
    if (typeof opts.body === 'string') entree.corps = JSON.parse(opts.body)
    else if (opts.body) entree.corps = opts.body
    journal.fetch.push(entree)
    try {
      if (u.startsWith('/api/ecran/charges')) return repondre(200, (o.ecran || (() => reponseEcran()))(u))
      if (u === '/api/charges') return repondre(200, (o.geste || (() => ({ ok: true })))(entree.corps))
      if (u.startsWith('https://stockage.test/')) return repondre(o.depot ? o.depot(u) : 200, {})
    } catch (e) {
      if (e && e.status) return repondre(e.status, { error: e.error || e.message })
      throw e
    }
    return repondre(404, { error: 'inconnu' })
  }
  w.confirm = (texte) => { journal.confirmations.push(texte); return o.confirmer !== false }
  w.open = () => { const onglet = { location: { href: '' }, closed: false, opener: 'moi', close () { this.closed = true } }; journal.onglets.push(onglet); return onglet }
  w.I18n = i18nFr()
  w.HSNav = { renderMenu () {}, render () {} }

  const vue = await import(path.join(RACINE, 'shared/charges-vue.js'))
  const injectes = {
    requireAuth: async () => ({ access_token: 'jeton-session', user: { id: 'u-moi', email: 'th@exemple.test' } }),
    signOut: async () => {},
    supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'jeton-relu' } } }) } },
    initErrorHandler: () => {},
    logger: { info () {}, error () {}, warn () {} },
    compteCourant: () => 'u-moi',
    peutLire: () => true,
    estTitulaire: () => o.titulaire !== false,
    comptes: () => [],
    basculerVers: () => {},
    enteteCompte: () => ({}),
    exigerCompteProprePage: async () => { journal.gardes++; return true },
    preparerJpeg: async (f) => new w.Blob(['jpeg-reduit'], { type: 'image/jpeg' }),
    monter: vue.monter
  }
  Object.assign(w, injectes)

  const module = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  const code = module
    .replace(/^import [^\n]*from [^\n]*$/gm, '')
    .replace(/^init\(\)\.catch\(/m, 'window.__amorce = init().catch(')
  w.eval(code)
  const attendre = () => new Promise(r => setTimeout(r, 0))
  await w.__amorce
  await attendre()

  const banc = {
    dom, w, d: w.document, journal,
    $: (s) => w.document.querySelector(s),
    $$: (s) => [...w.document.querySelectorAll(s)],
    attendre,
    cliquer: async (el) => { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); for (let i = 0; i < 6; i++) await attendre() },
    choisir: async (el, valeur) => { el.value = valeur; el.dispatchEvent(new w.Event('change', { bubbles: true })); for (let i = 0; i < 6; i++) await attendre() },
    saisir: (el, valeur) => { el.value = valeur },
    deposerFichier: async (nom, type, contenu = '%PDF-1.4') => {
      const input = w.document.querySelector('[data-bind="fichier"]')
      const f = new w.File([contenu], nom, { type })
      Object.defineProperty(input, 'files', { value: [f], configurable: true })
      input.dispatchEvent(new w.Event('change', { bubbles: true }))
      for (let i = 0; i < 12; i++) await attendre()
    },
    gestes: () => journal.fetch.filter(f => f.url === '/api/charges').map(f => f.corps),
    lecturesEcran: () => journal.fetch.filter(f => f.url.startsWith('/api/ecran/charges')),
    fermer: () => w.close()
  }
  return banc
}

module.exports = { monter, reponseEcran, facture, ENT, BIEN, BIEN_VIEUX, id }
