// tests/outils/banc-evenements.js
// LE BANC DE LA PAGE « CE QUI FAIT BOUGER VOS PRIX » (apps/yield/evenements.html).
//
// Deux outils :
//   - `reponseEcran(o)` : une réponse de `GET /api/ecran/evenements` FABRIQUÉE
//     PAR LA VRAIE ASSEMBLÉE (lib/yield/ecran-evenements.js), sur un contexte
//     bâti par les vrais modules purs — seule la lecture de la base est
//     remplacée. La page est donc éprouvée sur la forme exacte du serveur, pas
//     sur une forme recopiée qui pourrait diverger.
//   - `monter(o)` : exécute le VRAI module de la page dans un vrai DOM (jsdom),
//     avec le vrai rendu (shared/yield-evenements-rendu.js) et le vrai cache
//     (shared/cache-ecran.js), et enregistre ce qui part au serveur.
//
// ⚠ ON N'EN RECOPIE RIEN (même règle que tests/outils/banc-avis.js) : le corps
// du module est pris tel quel ; seuls ses `import` statiques sont retirés et
// leurs symboles injectés.

const fs = require('fs')
const path = require('path')
const Module = require('module')
const { JSDOM } = require('jsdom')

const RACINE = path.join(__dirname, '..', '..')
const lire = (...p) => fs.readFileSync(path.join(RACINE, ...p), 'utf8')

const R = require('../../lib/yield/reference')
const P = require('../../lib/yield/positions')
const S = require('../../lib/yield/suggestion')
const DC = require('../../lib/yield/dates-commerciales')

const AUJ = '2026-11-09'
const VACANCES = [
  { zone: 'C', nom: 'Vacances de Noël', date_debut: '2026-12-19', date_fin: '2027-01-03' },
  { zone: 'C', nom: "Vacances d'Hiver", date_debut: '2027-02-20', date_fin: '2027-03-07' }
]
const SALON = { id: 'ev-salon', nom: 'Salon du chocolat', segment: 'evenement:salon_du_chocolat', date_debut: '2027-03-19', date_fin: '2027-03-21' }
const NIV = [115, 125, 140, 155, 165]
const NOEL = `${R.SEGMENTS.VACANCES_ZONE}:${R.nomCourt('Vacances de Noël')}`
const jourSuivant = j => new Date(Date.parse(`${j}T00:00:00Z`) + 864e5).toISOString().slice(0, 10)

function grille () {
  const niveaux = S.NIVEAUX.map((x, i) => ({ ...x, prix: NIV[i], prix_mesure: NIV[i], etire: false }))
  const pos = i => ({ fiable: true, indice: i, niveau: niveaux[i].nom, crans: 0, echantillon: 40, reservations: 20, mediane: NIV[i] })
  return {
    base: { fiable: true, echantillon: 854, reservations: 400, niveaux, min: 35, max: 295, plafond: 295 },
    positions: new Map([['hors_vacances', pos(1)]]),
    positions_jour: new Map([['hors_vacances|samedi', pos(3)], ['hors_vacances|vendredi', pos(2)]])
  }
}

/**
 * @param o.lignes   lignes de réglage par position
 * @param o.reglages Map des réglages d'événement (crans, largeurs, coupures)
 * @param o.vendues  { date: [resa] }
 * @param o.prixHote Map date -> centimes (bien piloté)
 */
async function reponseEcran (o = {}) {
  const reglages = o.reglages || new Map()
  const lignes = o.lignes || []
  const coupees = new Set()
  for (const [cle, r] of reglages) if (r && r.actif === false) coupees.add(cle)
  const evenements = [...DC.datesCommerciales('2023-01-01', '2027-12-31', { desactivees: coupees }), SALON]
  const preparer = async (s, bien, compte, opt) => {
    const materiauxPositions = { reglages, zoneBien: 'C', vacances: VACANCES, evenements, debut: '2026-11-01', fin: opt.fin }
    const parDate = new Map()
    const ouverts = new Set()
    for (let j = opt.debut; j <= opt.fin; j = jourSuivant(j)) { parDate.set(j, { date: j, rate: 100 }); ouverts.add(j) }
    return {
      auj: opt.aujourdHui, bien, grille: grille(),
      contexte: R.construireContexte({ zoneBien: 'C', vacances: VACANCES, evenements, debut: '2023-11-09', fin: opt.fin }),
      evenements, reglages, lignesPosition: lignes, materiauxPositions,
      positions: P.positionsDuContexte({ ...materiauxPositions, lignes }),
      pressionParMois: new Map(), vendues: o.vendues || {}, parDate, ouverts, ouvertureConnue: true
    }
  }
  const avant = Module._load
  const chemin = require.resolve('../../lib/yield/ecran-evenements')
  let E
  Module._load = function (d, ...reste) {
    if (d === './contexte-du-bien') { const vrai = avant.apply(this, [d, ...reste]); return { ...vrai, preparerContexte: preparer } }
    if (d === './vacances') { const vrai = avant.apply(this, [d, ...reste]); return { ...vrai, etendueSource: async () => [{ zone: 'C', date_debut: '2025-09-01', date_fin: '2027-07-03' }] } }
    if (d === '../prix-hote') return { prixHoteDuBien: async () => o.prixHote || new Map() }
    return avant.apply(this, [d, ...reste])
  }
  try {
    delete require.cache[chemin]
    E = require('../../lib/yield/ecran-evenements')
  } finally {
    Module._load = avant
    delete require.cache[chemin]
  }
  const bien = { id: '22222222-2222-4222-8222-222222222222', zone_scolaire: 'C', prix_minimum: 1, inventory_units: 1, ...(o.prixHote ? { pilote_tarifaire: 'yieldflow' } : {}) }
  const ecran = await E.assemblerEcranEvenements(null, bien, 'compte-1', { aujourdHui: AUJ })
  return {
    aujourdhui: AUJ,
    biens: o.biens || [{ id: bien.id, nom: 'La bulle' }, { id: '33333333-3333-4333-8333-333333333333', nom: 'Cœur de vie 23' }],
    bien: bien.id,
    droits_ecriture: true,
    calcule_a: '2026-11-09T09:30:00.000Z',
    ...ecran
  }
}

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
    time: (d) => new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
    money: (n) => `${n} €`
  }
}

/**
 * @param o.ecran   (url) → corps JSON, ou une Error portant `status`
 * @param o.url     adresse de la page
 * @param o.cache   données à poser dans le cache de l'écran avant l'amorce
 * @param o.compteDelegue  si vrai, `enteteCompte()` rend un X-Compte
 */
async function monter (o = {}) {
  const html = lire('apps/yield/evenements.html')
  const corps = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script src="/shared/i18n/i18n.js">'))
  const dom = new JSDOM(`<!doctype html><html><body>${corps}</body></html>`, { url: o.url || 'https://hs.test/apps/yield/evenements', runScripts: 'outside-only', pretendToBeVisual: true })
  const w = dom.window
  const journal = { fetch: [], erreurs: [] }
  w.fetch = async (url, opts = {}) => {
    const entree = { url: String(url), entetes: opts.headers || {} }
    journal.fetch.push(entree)
    if (entree.url.startsWith('/api/ecran/evenements')) {
      let d
      try { d = await o.ecran(entree.url) } catch (e) {
        if (e && e.status) return { ok: false, status: e.status, json: async () => ({ error: e.message }) }
        throw e
      }
      return { ok: true, status: 200, json: async () => d }
    }
    return { ok: false, status: 404, json: async () => ({ error: 'inconnu' }) }
  }
  w.I18n = i18nFr()
  w.HSNav = { renderMenu () {}, render () {} }
  w.Element.prototype.scrollIntoView = function () {}

  const rendu = await import(path.join(RACINE, 'shared/yield-evenements-rendu.js'))
  const cache = await import(path.join(RACINE, 'shared/cache-ecran.js'))
  globalThis.localStorage = w.localStorage
  const MOI = 'u-moi'
  const COMPTE = o.compteDelegue ? 'compte-autre' : MOI
  if (o.cache) cache.ecrire('yield-evenements', MOI, COMPTE, o.cache)

  Object.assign(w, {
    requireAuth: async () => ({ access_token: 'jeton-session', user: { id: MOI, email: 'th@exemple.test' } }),
    signOut: async () => {},
    supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'jeton-relu' } } }) } },
    initErrorHandler: () => {},
    logger: { info () {}, error (...a) { journal.erreurs.push(a) }, warn () {} },
    esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    compteCourant: () => COMPTE,
    peutLire: () => true,
    estTitulaire: () => !o.compteDelegue,
    comptes: () => [],
    basculerVers: () => {},
    enteteCompte: () => (o.compteDelegue ? { 'X-Compte': COMPTE } : {}),
    lireCache: cache.lire,
    ecrireCache: cache.ecrire,
    oublierCache: cache.oublier,
    ...rendu
  })
  const module = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  const code = module
    .replace(/^import [^\n]*from [^\n]*$/gm, '')
    .replace(/^init\(\)\.catch\(/m, 'window.__amorce = init().catch(')
  w.eval(code)
  const attendre = () => new Promise(r => setTimeout(r, 0))
  await w.__amorce
  await attendre()
  return {
    dom, w, d: w.document, journal, cache, MOI, COMPTE,
    $: (s) => w.document.querySelector(s),
    $$: (s) => [...w.document.querySelectorAll(s)],
    cliquer: async (el) => { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await attendre(); await attendre() },
    choisir: async (sel, valeur) => { sel.value = valeur; sel.dispatchEvent(new w.Event('change', { bubbles: true })); await attendre(); await attendre(); await attendre() }
  }
}

module.exports = { reponseEcran, monter, AUJ, NOEL, NIV }
