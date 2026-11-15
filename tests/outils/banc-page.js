// tests/outils/banc-page.js
// LE BANC DES PAGES OUTILS (intégration V5, docs/specs/spec-integration-v5-lot-1.md).
//
// Il charge une page HTML du dépôt dans jsdom et exécute SES scripts dans
// l'ordre d'un navigateur : les classiques d'abord (le VRAI moteur i18n sur les
// VRAIS dictionnaires, le VRAI shared/nav.js, les scripts en ligne), puis les
// modules. Il ENREGISTRE tout ce qui part : chaque `fetch`, chaque lecture
// Supabase, chaque appel d'identité qui coûte un aller-retour (`getUser`).
//
// ⚠ MÊME MÉTHODE QUE banc-charges.js et banc-avis.js : le corps d'un module est
// pris TEL QUEL, ses `import` statiques sont retirés et leurs symboles injectés.
// Deux différences, voulues :
//  - la traduction est la VRAIE (REVIEW.md règle 22 : un double plus permissif
//    que le vrai rend vert un texte que l'hôte ne verra jamais) ;
//  - le corps d'un module est exécuté dans une fonction `async` : les anciennes
//    pages ont un `await` au niveau du module, et le banc doit pouvoir mesurer
//    l'AVANT comme l'APRÈS.
// ⚠ ET IL SAIT EXÉCUTER UN MODULE DU DÉPÔT LUI-MÊME (`evaluerModule`) : la
// barre latérale de l'ancien socle faisait ses propres lectures, et une mesure
// AVANT qui ne la compterait pas ne mesurerait pas la page telle qu'elle était.

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { JSDOM, VirtualConsole } = require('jsdom')

const RACINE = path.join(__dirname, '..', '..')
const lire = (rel) => fs.readFileSync(path.join(RACINE, rel), 'utf8')

const attendre = () => new Promise(r => setTimeout(r, 0))

// ─── Le double de Supabase : il enregistre, et il APPLIQUE ce qu'on lui dit ──
// `tables[nom]` : la réponse d'une lecture — `{ data, error }`, ou une fonction
// `(requete) => { data, error }` qui voit les filtres posés (REVIEW.md
// règle 22 : un double qui enregistre un filtre sans rien en faire rend tout
// vert ; ici, c'est la fonction du test qui décide sur les filtres réels).
function doubleSupabase (journal, tables, session) {
  const from = (table) => {
    const req = { table, mode: 'select', select: null, filtres: [], corps: null }
    journal.supabase.push(req)
    const resultat = () => {
      const v = tables[table]
      const r = typeof v === 'function' ? v(req) : v
      if (r === undefined) return { data: null, error: null }
      return r
    }
    const b = {
      select (c) { req.select = c; return b },
      insert (x) { req.mode = 'insert'; req.corps = x; return b },
      update (x) { req.mode = 'update'; req.corps = x; return b },
      upsert (x) { req.mode = 'upsert'; req.corps = x; return b },
      delete () { req.mode = 'delete'; return b },
      eq (k, v) { req.filtres.push(['eq', k, v]); return b },
      neq (k, v) { req.filtres.push(['neq', k, v]); return b },
      in (k, v) { req.filtres.push(['in', k, v]); return b },
      is (k, v) { req.filtres.push(['is', k, v]); return b },
      order () { return b },
      limit () { return b },
      maybeSingle: async () => resultat(),
      single: async () => resultat(),
      then: (ok, ko) => Promise.resolve(resultat()).then(ok, ko)
    }
    return b
  }
  return {
    from,
    auth: {
      getSession: async () => ({ data: { session } }),
      // ⚠ getUser COÛTE UN ALLER-RETOUR (supabase-js interroge /auth/v1/user) :
      // il se compte, contrairement à getSession qui lit le stockage local.
      getUser: async () => { journal.auth.push('getUser'); return { data: { user: session && session.user } } },
      signOut: async () => { journal.auth.push('signOut') }
    }
  }
}

// Le texte d'un module du dépôt, sans ses `import` statiques ni ses `export`.
// Les `import(` dynamiques restent : ce sont des appels.
function sansImports (src) {
  return src
    .replace(/^[ \t]*import\s+(?!\()[\s\S]*?\sfrom\s*['"][^'"]+['"];?[ \t]*$/gm, '')
    .replace(/^[ \t]*import\s+['"][^'"]+['"];?[ \t]*$/gm, '')
}

// Exécute un module du dépôt DANS la fenêtre jsdom, ses dépendances injectées.
// Rend ses exports nommés (et `default`).
function evaluerModule (w, rel, deps = {}) {
  let src = sansImports(lire(rel))
  const exports = []
  src = src.replace(/^export\s+(async\s+function|function|const|let|class)\s+([\w$]+)/gm, (_, k, nom) => { exports.push(nom); return `${k} ${nom}` })
  src = src.replace(/^export\s+default\s+([\w$]+)\s*;?\s*$/m, (_, nom) => { exports.push(`default: ${nom}`); return '' })
  src = src.replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '')
  const noms = Object.keys(deps)
  const fabrique = w.Function(...noms, `${src}\nreturn { ${exports.join(', ')} }`)
  return fabrique(...noms.map(n => deps[n]))
}

/**
 * Monte une page.
 * @param rel           chemin de la page dans le dépôt
 * @param o.url         adresse de la page (défaut : https://hs.test/<rel sans .html>)
 * @param o.api(u, opt) → { status, body } pour un appel `/api/…` (404 sinon)
 * @param o.tables      réponses Supabase par table (voir doubleSupabase)
 * @param o.session     session (défaut : une session de titulaire)
 * @param o.injecter(w, journal, supabase) → symboles des `import` de la page
 * @param o.confirmer   réponse de `confirm` (vrai par défaut)
 */
async function monterPage (rel, o = {}) {
  const html = lire(rel)
  const journal = { fetch: [], supabase: [], auth: [], confirmations: [], erreurs: [], navigations: [] }
  const console_ = new VirtualConsole()
  console_.on('jsdomError', (e) => {
    if (/navigation/i.test(String(e && e.message))) journal.navigations.push(String(e.message))
    else journal.erreurs.push(String(e && (e.stack || e.message)))
  })
  console_.on('error', (...a) => journal.erreurs.push(a.map(String).join(' ')))
  const url = o.url || 'https://hs.test/' + rel.replace(/\.html$/, '')
  // ⚠ Les scripts ne sont PAS exécutés par jsdom : c'est le banc qui les
  // exécute, dans l'ordre d'un navigateur. Le DOM, lui, est celui de la page.
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: console_ })
  const w = dom.window
  const session = o.session === undefined
    ? { access_token: 'jeton-session', user: { id: 'u-moi', email: 'thierry@exemple.test', user_metadata: {} } }
    : o.session

  const repondre = (statut, corps) => ({
    ok: statut >= 200 && statut < 300, status: statut,
    json: async () => (typeof corps === 'string' ? JSON.parse(corps) : corps),
    text: async () => (typeof corps === 'string' ? corps : JSON.stringify(corps))
  })
  w.fetch = async (cible, opts = {}) => {
    const u = String(cible)
    const entree = { url: u, methode: (opts.method || 'GET').toUpperCase(), entetes: opts.headers || {}, corps: null }
    if (typeof opts.body === 'string') { try { entree.corps = JSON.parse(opts.body) } catch { entree.corps = opts.body } }
    journal.fetch.push(entree)
    const chemin = u.split('?')[0]
    if (chemin.startsWith('/shared/i18n/') && chemin.endsWith('.json')) {
      const f = path.join(RACINE, chemin)
      if (fs.existsSync(f)) {
        const texte = fs.readFileSync(f, 'utf8')
        entree.octets = Buffer.byteLength(texte)
        return repondre(200, texte)
      }
      return repondre(404, {})
    }
    if (chemin.startsWith('/api/') && o.api) {
      const r = await o.api(u, entree)
      if (r) return repondre(r.status || 200, r.body === undefined ? {} : r.body)
    }
    return repondre(404, { error: 'inconnu' })
  }
  w.confirm = (texte) => { journal.confirmations.push(texte); return o.confirmer !== false }
  w.alert = (texte) => { journal.confirmations.push('alert:' + texte) }
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new w.Event('close')) }
  try { Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async (t) => { journal.presse = t } }, configurable: true }) } catch { /* lecture seule */ }

  const supabase = doubleSupabase(journal, o.tables || {}, session)

  // Les scripts, dans l'ordre du document.
  const scripts = [...w.document.querySelectorAll('script')]
  const modules = []
  for (const s of scripts) {
    const src = s.getAttribute('src')
    if (s.type === 'module') { modules.push(s.textContent); continue }
    if (src === '/shared/i18n/i18n.js') {
      const { moteurI18n } = require(path.join(RACINE, 'lib/i18n-version.js'))
      w.eval(moteurI18n())
    } else if (src === '/shared/nav.js') {
      w.eval(lire('shared/nav.js'))
    } else if (src) {
      // Un script classique d'une autre origine (CDN) : rien à exécuter ici.
    } else {
      w.eval(s.textContent)
    }
  }

  const injectes = o.injecter ? o.injecter(w, journal, supabase) : {}
  Object.assign(w, injectes)

  w.__amorces = []
  for (const m of modules) {
    // Le corps tel quel, dans une fonction async (anciennes pages : `await` au
    // niveau du module). L'amorce `init().catch(...)` est attendue elle aussi.
    const code = sansImports(m).replace(/^init\(\)\.catch\(/m, 'await init().catch(')
    w.eval(`window.__amorces.push((async () => {\n${code}\n})().catch(e => { window.__erreurBanc = e }))`)
  }
  await Promise.race([Promise.all(w.__amorces), new Promise(r => setTimeout(r, 2000))])
  await stabiliser(journal)
  if (w.__erreurBanc) journal.erreurs.push(String(w.__erreurBanc && (w.__erreurBanc.stack || w.__erreurBanc)))

  return {
    dom, w, d: w.document, journal, supabase,
    $: (s) => w.document.querySelector(s),
    $$: (s) => [...w.document.querySelectorAll(s)],
    attendre: () => stabiliser(journal),
    cliquer: async (el) => { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true })); await stabiliser(journal) },
    changer: async (el, valeur) => {
      if (typeof valeur === 'boolean') el.checked = valeur; else if (valeur !== undefined) el.value = valeur
      el.dispatchEvent(new w.Event('input', { bubbles: true }))
      el.dispatchEvent(new w.Event('change', { bubbles: true }))
      await stabiliser(journal)
    },
    texte: (s) => { const el = w.document.querySelector(s); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null },
    appels: (prefixe) => journal.fetch.filter(f => f.url.startsWith(prefixe)),
    fermer: () => w.close()
  }
}

// Attend que plus rien ne parte : le journal ne bouge plus pendant plusieurs
// tours de boucle. Borné : une page qui boucle ne fait pas pendre le test.
async function stabiliser (journal) {
  let avant = -1
  let calmes = 0
  for (let i = 0; i < 400 && calmes < 12; i++) {
    await attendre()
    const n = journal.fetch.length + journal.supabase.length + journal.auth.length
    if (n === avant) calmes++; else { calmes = 0; avant = n }
  }
}

// ─── Les octets statiques d'une page ─────────────────────────────────────────
// Ce que le navigateur télécharge du dépôt pour peindre la page : le HTML, ses
// feuilles, ses scripts classiques, le GRAPHE de ses modules (imports statiques
// suivis), le sprite d'icônes et le logo s'ils sont référencés. Les ressources
// d'une autre origine (polices Google, supabase-js du CDN) sont LISTÉES, pas
// comptées. Les dictionnaires i18n se comptent à part, depuis le journal du
// banc (ce que le moteur a réellement demandé).
function octetsStatiques (rel, { avecNav = null } = {}) {
  const fichiers = new Map()
  const externes = new Set()
  const ajouter = (r) => {
    const abs = path.join(RACINE, r)
    if (!fichiers.has(r) && fs.existsSync(abs) && fs.statSync(abs).isFile()) fichiers.set(r, fs.readFileSync(abs))
  }
  ajouter(rel)
  const html = lire(rel)
  for (const m of html.matchAll(/<link[^>]+href="([^"]+)"[^>]*>/g)) {
    const h = m[1]
    if (/^https?:/.test(h)) { externes.add(h); continue }
    if (/rel="(stylesheet|icon)"/.test(m[0])) ajouter(h.replace(/^\//, '').split('?')[0])
  }
  for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
    const h = m[1]
    if (/^https?:/.test(h)) { externes.add(h); continue }
    if (h === '/shared/i18n/i18n.js') {
      const { moteurI18n } = require(path.join(RACINE, 'lib/i18n-version.js'))
      fichiers.set('shared/i18n/i18n.js (servi par api/i18n.js)', Buffer.from(moteurI18n()))
    } else ajouter(h.replace(/^\//, ''))
  }
  for (const m of html.matchAll(/<img[^>]+src="(\/[^"]+)"/g)) ajouter(m[1].replace(/^\//, ''))
  const chargeNav = avecNav === null ? /src="\/shared\/nav\.js"/.test(html) : avecNav
  if (/icons\.svg#/.test(html) || chargeNav) ajouter('shared/icons.svg')

  // Le graphe des modules : imports statiques, suivis.
  const aVisiter = []
  const modulesEnLigne = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map(m => m[1])
  const specifs = (src) => [
    ...[...src.matchAll(/^[ \t]*import\s+(?!\()[\s\S]*?\sfrom\s*['"]([^'"]+)['"]/gm)].map(m => m[1]),
    ...[...src.matchAll(/^[ \t]*import\s+['"]([^'"]+)['"]/gm)].map(m => m[1]),
    ...[...src.matchAll(/^[ \t]*export\s+[^;\n]*\sfrom\s*['"]([^'"]+)['"]/gm)].map(m => m[1])
  ]
  const resoudre = (spec, depuis) => {
    if (/^https?:/.test(spec)) { externes.add(spec); return null }
    if (spec.startsWith('/')) return spec.slice(1)
    return path.posix.normalize(path.posix.join(path.posix.dirname(depuis), spec))
  }
  for (const m of modulesEnLigne) for (const s of specifs(m)) { const r = resoudre(s, rel); if (r) aVisiter.push(r) }
  const vus = new Set()
  while (aVisiter.length) {
    const r = aVisiter.shift()
    if (vus.has(r)) continue
    vus.add(r)
    ajouter(r)
    if (!fs.existsSync(path.join(RACINE, r))) continue
    for (const s of specifs(lire(r))) { const x = resoudre(s, r); if (x) aVisiter.push(x) }
  }

  let brut = 0
  let gzip = 0
  const detail = []
  for (const [f, buf] of fichiers) {
    const g = zlib.gzipSync(buf).length
    brut += buf.length
    gzip += g
    detail.push({ fichier: f, octets: buf.length, gzip: g })
  }
  detail.sort((a, b) => b.octets - a.octets)
  return { brut, gzip, detail, externes: [...externes].sort(), modules: [...vus].sort() }
}

module.exports = { monterPage, evaluerModule, doubleSupabase, octetsStatiques, sansImports, stabiliser, RACINE }
