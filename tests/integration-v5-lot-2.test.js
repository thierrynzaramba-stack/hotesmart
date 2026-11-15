// tests/integration-v5-lot-2.test.js
// INTÉGRATION V5, LOT 2 — les écrans YieldFlow. Sous-lot 2a : la température
// du marché, le marché, le marché global (lecture seule).
// Spec : docs/specs/spec-integration-v5-lot-2.md.
//
// Comme au lot 1 (REVIEW.md règle 19), deux familles :
// 1. CE QUE LE LOT CHANGE — socle V5, coquille et sous-menu YieldFlow, langue
//    de l'hôte, aucun hexa ni emoji, palettes dans la charte. Ces tests
//    ROUGISSENT contre le code d'avant (contre-épreuve, spec §6 ter).
// 2. CE QUE LE LOT NE DOIT PAS CHANGER — les rendus détaillés restent gardés
//    par les tests qui existaient (marche-global-page-dom, marche-temperature-
//    page, yield-marche-calendrier…), retargetés sur le VRAI moteur i18n et les
//    VRAIS dictionnaires : ils affirment le texte FRANÇAIS rendu, au caractère.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { monterPage, evaluerModule } = require('./outils/banc-page')

const RACINE = path.join(__dirname, '..')
const lire = (p) => fs.readFileSync(path.join(RACINE, p), 'utf8')
const PAGES_2A = ['apps/yield/marche-temperature.html', 'apps/yield/marche.html', 'apps/yield/marche-global.html']
const LANGUES = ['fr', 'en', 'es']
const DICOS = Object.fromEntries(LANGUES.map(l => [l, JSON.parse(lire(`shared/i18n/${l}.json`))]))
const sansCommentaires = (src) => src
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\s\/\/ .*$/gm, '')

const SESSION = { access_token: 'jeton-session', user: { id: 'u-moi', email: 'thierry@exemple.test', user_metadata: {} } }
const BIENS = { data: [{ id: 'B1', name: 'La bulle' }, { id: 'B2', name: 'Cœur de vie 23' }], error: null }

// Les symboles des `import` — ceux de l'ancien code ET du nouveau, pour que la
// contre-épreuve EXÉCUTE l'ancien code (règle 19 : un rouge par `undefined` ne
// prouve rien). Les modules du dépôt sont les VRAIS.
function injecteur ({ compte = null } = {}) {
  return (w, journal, supabase) => {
    journal.coquille = []
    const mod = (rel) => { const m = evaluerModule(w, rel, {}); delete m.default; return m }
    const existe = (rel) => fs.existsSync(path.join(RACINE, rel))
    return {
      ...mod('shared/page-outil.js'),
      ...(existe('shared/yieldflow-onglets.js') ? mod('shared/yieldflow-onglets.js') : {}),
      ...mod('shared/temperature-calendrier.js'),
      ...mod('shared/biens-vivants.js'),
      supabase,
      requireAuth: async () => SESSION,
      compteCourant: () => compte,
      enteteCompte: () => (compte ? { 'X-Compte': compte } : {}),
      peutLire: () => true,
      estTitulaire: () => true,
      comptes: () => [],
      basculerVers: () => {},
      signOut: async () => {},
      initErrorHandler: () => {},
      renderOnboardingBanner: async () => { journal.coquille.push('bandeau') },
      renderSidebar: async (actif) => { journal.coquille.push(`barre:${actif}`) }
    }
  }
}

const monter = (page, o = {}) => monterPage(page, {
  session: SESSION, tables: { properties: BIENS }, injecter: injecteur(o), ...o
})

// ─── 1. Le socle ─────────────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : les trois écrans chargent le socle V5, plus l ancien', () => {
  for (const page of PAGES_2A) {
    const src = lire(page)
    for (const f of ['/shared/theme.css', '/shared/ui.css']) assert.match(src, new RegExp(`<link rel="stylesheet" href="${f}">`), `${page} : ${f}`)
    assert.match(src, /<script src="\/shared\/i18n\/i18n\.js"><\/script>/, `${page} : le moteur i18n`)
    assert.match(src, /<script src="\/shared\/nav\.js"><\/script>/, `${page} : nav.js`)
    assert.doesNotMatch(src, /public\/style\.css/, `${page} : l ancienne feuille`)
    assert.doesNotMatch(sansCommentaires(src), /renderSidebar|components\/sidebar\.js|class="sidebar"/, `${page} : l ancienne barre latérale`)
    assert.match(src, /<body class="out-page out-pont">/, `${page} : la classe de page outil et le pont`)
    assert.match(src, /<header class="topbar">/, `${page} : la barre du haut`)
    assert.match(src, /<nav class="bottombar"/, `${page} : la barre du bas`)
  }
})

test('LE TEST QUI COMPTE : au chargement, barre du haut, menu ≡ avec la section Outils, sous-menu YieldFlow', async () => {
  for (const page of PAGES_2A) {
    const p = await monter(page, { api: () => ({ body: { etat: 'marche_inconnu' } }) })
    assert.deepEqual(p.journal.erreurs, [], `${page} : ${p.journal.erreurs.join('\n')}`)
    assert.ok(p.$$('.topbar__nav a').length >= 4, `${page} : les onglets V5`)
    const menu = p.$('[data-menu]')
    assert.ok(menu && menu.querySelector('a[href="/apps/yield"]'), `${page} : YieldFlow dans les outils du menu ≡`)
    // Le sous-menu de la barre latérale, déplacé : cinq liens.
    const liens = p.$$('[data-yf-onglets] a').map(a => a.getAttribute('href'))
    assert.deepEqual(liens, ['/apps/yield', '/apps/yield/prix', '/apps/yield/prix?evenements=1', '/apps/yield/marche-global', '/apps/yield/comparables'], page)
    assert.deepEqual(p.journal.coquille, ['bandeau'], `${page} : le bandeau d incitation, et aucune barre latérale`)
    assert.equal(p.d.title, `HôteSmart — ${DICOS.fr[{ 'apps/yield/marche-temperature.html': 'mt.titre', 'apps/yield/marche.html': 'mc.titre', 'apps/yield/marche-global.html': 'mg.titre' }[page]]}`)
    p.fermer()
  }
})

test('LE TEST QUI COMPTE : le sous-menu YieldFlow porte les adresses ET les libellés de l ancienne barre latérale', async () => {
  // La source de vérité d'avant : components/sidebar.js. Les quatre liens du
  // sous-menu y sont lus, pas recopiés ; « Tarification dynamique » est le nom
  // de l'app dans shared/config.js.
  const barre = lire('components/sidebar.js')
  const bloc = barre.slice(barre.indexOf("app.id === 'yield'"), barre.indexOf("app.id === 'menages'"))
  const anciens = [...bloc.matchAll(/href="([^"]+)">\s*<div[^>]*><\/div>([^<]+)</g)].map(m => [m[1], m[2].trim()])
  assert.equal(anciens.length, 4)
  const p = await monter('apps/yield/marche-global.html', { api: () => ({ body: { etat: 'marche_inconnu' } }) })
  const rendus = p.$$('[data-yf-onglets] a').map(a => [a.getAttribute('href'), a.textContent.trim()])
  assert.deepEqual(rendus.slice(1), anciens)
  assert.deepEqual(rendus[0], ['/apps/yield', 'Tarification dynamique'])
  assert.match(lire('shared/config.js'), /id: 'yield', name: 'Tarification dynamique'/)
  // L'écran courant est marqué ; les deux écrans hors de la liste n'en marquent aucun.
  assert.deepEqual(p.$$('[data-yf-onglets] [aria-current="page"]').map(a => a.getAttribute('href')), ['/apps/yield/marche-global'])
  p.fermer()
  for (const page of ['apps/yield/marche-temperature.html', 'apps/yield/marche.html']) {
    const q = await monter(page, { api: () => ({ body: { etat: 'marche_inconnu' } }) })
    assert.equal(q.$$('[data-yf-onglets] [aria-current]').length, 0, page)
    q.fermer()
  }
})

// ─── 2. La langue de l'hôte ──────────────────────────────────────────────────

const CLES_DYNAMIQUES = ['mg.vac_de_', 'mg.vac_en_']
function clesDe (src) {
  const cles = new Set()
  for (const m of src.matchAll(/(?:th|t)\('((?:mt|mc|mg|yfm|yfnav)\.[a-z0-9_]+)'/g)) cles.add(m[1])
  for (const m of src.matchAll(/data-(?:i18n|riche)="((?:mt|mc|mg|yfm|yfnav)\.[a-z0-9_]+)"/g)) cles.add(m[1])
  for (const m of src.matchAll(/aria-label:((?:mt|mc|mg|yfm|yfnav)\.[a-z0-9_]+)/g)) cles.add(m[1])
  for (const m of src.matchAll(/'((?:mt|mc|mg|yfm|yfnav)\.[a-z0-9_]+)'/g)) cles.add(m[1])
  return cles
}

test('LE TEST QUI COMPTE : chaque clé employée existe dans les trois langues, y compris les clés composées', () => {
  const manques = []
  for (const f of [...PAGES_2A, 'shared/yieldflow-onglets.js']) {
    for (const k of clesDe(lire(f))) for (const l of LANGUES) if (!(k in DICOS[l])) manques.push(`${f} : ${k} (${l})`)
  }
  // Les périodes de vacances : la clé se compose avec la période (mg.vac_de_noel…).
  const periodes = (lire('apps/yield/marche-global.html').match(/const PERIODES = \[([^\]]+)\]/) || [])[1]
  assert.ok(periodes, 'la liste des périodes')
  for (const per of periodes.match(/'([a-z]+)'/g).map(x => x.slice(1, -1))) {
    for (const pre of CLES_DYNAMIQUES) for (const l of LANGUES) if (!(`${pre}${per}` in DICOS[l])) manques.push(`${pre}${per} (${l})`)
  }
  assert.deepEqual(manques, [])
})

test('LE TEST QUI COMPTE : en anglais et en espagnol, l écran parle la langue de l hôte', async () => {
  const titres = { 'apps/yield/marche-temperature.html': 'mt', 'apps/yield/marche.html': 'mc', 'apps/yield/marche-global.html': 'mg' }
  for (const langue of ['en', 'es']) {
    for (const page of PAGES_2A) {
      const p = await monter(page, { langue, api: () => ({ body: { etat: 'marche_inconnu' } }) })
      const D = DICOS[langue]
      assert.equal(p.texte('h1'), D[`${titres[page]}.titre`], `${page} (${langue})`)
      assert.equal(p.$('.out-note--avertir').textContent, D[`${titres[page]}.avertir`].replace(/\*\*/g, ''), `${page} (${langue}) : l avertissement`)
      assert.equal(p.texte('.out-choix span'), D['yfm.logement'])
      assert.match(p.$('main').textContent, new RegExp(D['yfm.marche_inconnu'].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${page} (${langue}) : l état`)
      assert.equal(p.texte('[data-yf-onglets] a'), D['yfnav.synthese'])
      assert.doesNotMatch(p.$('main').textContent, /Logement|Lecture du marché|Aucun marché/, `${page} (${langue}) : plus de français`)
      p.fermer()
    }
  }
})

test('les dates suivent la langue, et rendent le français d avant en français', () => {
  const w = new (require('jsdom').JSDOM)('').window
  const po = evaluerModule(w, 'shared/page-outil.js', {})
  const I18n = (lang) => ({ date: (d, o) => new Intl.DateTimeFormat(lang, o).format(d), lang })
  assert.equal(po.jourIso(I18n('fr'), '2026-10-04'), '4 octobre 2026')
  assert.equal(po.jourIso(I18n('en'), '2026-10-04'), 'October 4, 2026')
  assert.equal(po.jourIso(I18n('fr'), '2026-10-04T10:00:00Z'), '—', 'jour exact attendu, comme l ancien jourFr')
  assert.equal(po.jourIso(I18n('fr'), null), '—')
  assert.equal(po.moisIso(I18n('fr'), '2026-10'), 'octobre 2026')
  assert.equal(po.moisIso(I18n('fr'), '2026-10', { month: 'short', year: 'numeric' }), 'oct. 2026')
  assert.equal(po.moisIso(I18n('fr'), 'n/a'), '—')
  // Le premier janvier ne recule pas au 31 décembre, quel que soit le fuseau.
  assert.equal(po.jourIso(I18n('fr'), '2027-01-01'), '1 janvier 2027')
  assert.equal(po.listeLocale('fr', ['A', 'B', 'C']), 'A, B et C')
  assert.equal(po.listeLocale('en', ['A', 'B']), 'A and B')
  assert.equal(po.listeLocale('es', ['A', 'B']), 'A y B')
})

test('LE TEST QUI COMPTE (sécurité) : tHtml échappe la donnée et le dictionnaire, et seul le gras du dictionnaire devient du HTML', () => {
  const w = new (require('jsdom').JSDOM)('').window
  const { tHtml, esc } = evaluerModule(w, 'shared/page-outil.js', {})
  const dico = { a: 'Marché : **{loc}** <i>{n}</i>', b: '{n, plural, one {# nuit} other {# nuits}}' }
  const t = (k, v = {}) => dico[k].replace(/\{(\w+)\}/g, (_, x) => (v[x] ?? `{${x}}`))
  assert.equal(tHtml(t, 'a', { loc: esc('<img src=x onerror=alert(1)>'), n: 3 }), 'Marché : <b>&lt;img src=x onerror=alert(1)&gt;</b> &lt;i&gt;3&lt;/i&gt;')
  // Une donnée qui contient « ** » reste du texte.
  assert.equal(tHtml(t, 'a', { loc: esc('**x**'), n: 1 }), 'Marché : <b>**x**</b> &lt;i&gt;1&lt;/i&gt;')
})

test('LE TEST QUI COMPTE (sécurité) : un motif venu du serveur reste du texte sur les trois écrans', async () => {
  const piege = '<img src=x onerror="window.__xss=1">'
  for (const page of PAGES_2A) {
    const p = await monter(page, { api: () => ({ body: { etat: 'marche_inconnu', motif: piege } }) })
    // Le corps entier, pas `main` : ce test de non-régression doit tenir sur
    // l'ancien code aussi (règle 19), qui n'avait pas de `main`.
    assert.equal(p.$$('img[src="x"]').length, 0, page)
    assert.ok(p.d.body.textContent.includes(piege), `${page} : le motif est dit, tel quel`)
    assert.equal(p.w.__xss, undefined)
    p.fermer()
  }
})

// ─── 3. La charte ─────────────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : aucun hexa ni emoji dans les trois écrans ; les palettes sont des jetons de la charte', () => {
  for (const page of PAGES_2A) {
    const src = sansCommentaires(lire(page))
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b(?![\w-])/, `${page} : un hexa`)
    assert.doesNotMatch(src, /\p{Extended_Pictographic}/u, `${page} : un emoji`)
  }
  // ⚠ LES VALEURS SONT CELLES QUE LES PAGES PORTAIENT EN DUR AVANT LE LOT
  // (apps/yield/marche.html et marche-global.html sur fb93b24e) : aucune
  // couleur ne change à l'intégration.
  const theme = lire('shared/theme.css')
  const AVANT = {
    'yf-pacing-1': '#D8E4F5', 'yf-pacing-2': '#9DB9E3', 'yf-pacing-3': '#5B87C9', 'yf-pacing-4': '#234E8C', 'yf-pacing-fond': '#E6EEF9',
    'yf-mensuel-1': '#F1E6D2', 'yf-mensuel-2': '#DEC49A', 'yf-mensuel-3': '#B98C47', 'yf-mensuel-4': '#7A5418', 'yf-mensuel-fond': '#F4ECDF',
    'yf-annee-n2': '#9DB9E3', 'yf-annee-n1': '#5B87C9', 'yf-annee-n': '#1E3F73', 'yf-barre': '#9DB9E3', 'yf-barre-partielle': '#C9CED6'
  }
  for (const [jeton, valeur] of Object.entries(AVANT)) assert.match(theme, new RegExp(`--${jeton}: ${valeur};`), jeton)
  // Et chaque page emploie ceux qui la concernent.
  const marche = lire('apps/yield/marche.html')
  for (const j of ['yf-pacing-1', 'yf-pacing-4', 'yf-pacing-fond', 'yf-mensuel-1', 'yf-mensuel-4', 'yf-mensuel-fond']) assert.match(marche, new RegExp(`var\\(--${j}\\)`), j)
  const global = lire('apps/yield/marche-global.html')
  for (const j of ['yf-annee-n2', 'yf-annee-n1', 'yf-annee-n', 'yf-barre', 'yf-barre-partielle']) assert.match(global, new RegExp(`var\\(--${j}\\)`), j)
})

test('LE TEST QUI COMPTE : les cinq niveaux copiés dans ui.css sont ceux de public/style.css, au caractère', () => {
  // L'échelle est un élément de structure (choix de Thierry, docs/kb/charte-ui.md §3) :
  // la copie du pont ne peut pas diverger de la source.
  const source = lire('public/style.css')
  const ui = lire('shared/ui.css')
  for (const n of ['n-base', 'n-moyen', 'n-haut', 'n-tres-haut', 'n-exceptionnel']) {
    const corps = (css, sel) => ((css.match(new RegExp(`${sel}\\s*\\{([^}]*)\\}`)) || [])[1] || '').trim()
    const a = corps(source, `\\n\\.${n}`)
    const b = corps(ui, `\\.out-pont \\.${n}`)
    assert.ok(a, `${n} dans public/style.css`)
    assert.equal(b, a, `${n} : la copie du pont diverge de la source`)
  }
  // Et marche-global les emploie toujours sur la PASTILLE, pas sur la ligne.
  assert.match(lire('apps/yield/marche-global.html'), /<b class="mg-pastille \$\{classe\}">/)
})

test('le bloc ajouté à ui.css pour le lot 2 ne déclare que des classes out- (et le pont)', () => {
  const ui = lire('shared/ui.css')
  const bloc = ui.slice(ui.indexOf('/* ── Les écrans YieldFlow (lot 2'), ui.indexOf('@media (max-width: 720px)', ui.indexOf('/* ── Les écrans YieldFlow (lot 2')))
  assert.ok(bloc.length > 100)
  const selecteurs = [...bloc.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/^([^{}@][^{]*)\{/gm)].map(m => m[1].trim())
  for (const s of selecteurs) assert.match(s, /^\.out-/, s)
})

// ─── 4. Ce qui ne change pas ──────────────────────────────────────────────────

test('LE TEST QUI COMPTE : les trois écrans restent DÉLÉGABLES, en lecture seule, et lisent le logement du compte courant', async () => {
  for (const page of PAGES_2A) {
    const src = sansCommentaires(lire(page))
    assert.doesNotMatch(src, /exigerCompteProprePage/, `${page} : aucune garde de compte propre`)
    assert.doesNotMatch(src, /method\s*:/, `${page} : aucune écriture`)
    const p = await monter(page, { compte: 'C-autre', api: () => ({ body: { etat: 'marche_inconnu' } }) })
    const lecture = p.journal.supabase.find(r => r.table === 'properties')
    assert.ok(lecture, page)
    assert.deepEqual(lecture.filtres.filter(f => f[0] === 'eq'), [['eq', 'user_id', 'C-autre']], `${page} : le compte courant`)
    assert.ok(lecture.filtres.some(f => f[0] === 'is'), `${page} : sans les logements archivés`)
    const api = p.journal.fetch.filter(f => f.url.startsWith('/api/') && !f.url.startsWith('/api/membres'))
    assert.ok(api.length >= 1)
    for (const a of api) {
      assert.equal(a.methode, 'GET', `${page} : ${a.url}`)
      assert.equal(a.entetes['X-Compte'], 'C-autre', `${page} : l en-tête de compte`)
      assert.match(a.url, /property_id=B1/)
    }
    // Changer de logement relit, pour le nouveau.
    await p.changer(p.$('select[id$="-bien"]'), 'B2')
    assert.ok(p.journal.fetch.some(f => /property_id=B2/.test(f.url)), `${page} : le nouveau logement`)
    p.fermer()
  }
})

test('les sélecteurs de logement gardent leur identifiant (le menu YieldFlow du calendrier et les tests s y fient)', () => {
  for (const [page, id] of [['apps/yield/marche-temperature.html', 'mt-bien'], ['apps/yield/marche.html', 'mc-bien'], ['apps/yield/marche-global.html', 'mg-bien']]) {
    assert.match(lire(page), new RegExp(`<select id="${id}"[ >]`), page)
  }
})

test('LE TEST QUI COMPTE : le calendrier commun parle la langue de l hôte, et le français d avant sans elle', () => {
  const { JSDOM } = require('jsdom')
  const jours = [{ jour: '2026-10-05', niveau: 'pic', evenement: 'Fête', sens: { saison: 'haut', semaine: 'bas', evenement: 'haut', demande: 'neutre' }, week_end: false }]
  const rendre = (langue) => {
    const w = new JSDOM('<!doctype html><div id="c"></div>', { runScripts: 'outside-only' }).window
    const m = evaluerModule(w, 'shared/temperature-calendrier.js', {})
    if (langue) {
      const D = DICOS[langue]
      m.parlerLangue({ t: (k, v = {}) => String(D[k]).replace(/\{(\w+)\}/g, (_, x) => v[x] ?? ''), date: (d, o) => new Intl.DateTimeFormat(langue, o).format(d) })
    }
    m.monterAnneeTemperature(w.document.getElementById('c'), jours, { premierMois: '2026-10', nbMois: 1 })
    const c = w.document.getElementById('c')
    return { titre: c.querySelector('h3').textContent, entete: [...c.querySelectorAll('.tc-mjsem')].map(x => x.textContent).join(''), legende: c.querySelector('.tc-legende-simple').textContent, cas: c.querySelector('.tc-case').getAttribute('aria-label'), badge: m.badge('pic') }
  }
  const avant = rendre(null)
  assert.deepEqual(avant, { titre: 'octobre 2026', entete: 'LMMJVSD', legende: 'Creux (marché faible)Modéré (marché normal)Favorable (bon moment)Pic (très forte demande)', cas: '5 octobre 2026 : Pic, Fête', badge: avant.badge })
  assert.match(avant.badge, />Pic<\/span>$/)
  // En français par le dictionnaire : le même rendu, au caractère.
  assert.deepEqual(rendre('fr'), avant)
  const en = rendre('en')
  assert.equal(en.titre, 'October 2026')
  assert.equal(en.entete, 'MTWTFSS')
  assert.equal(en.legende, 'Low (weak market)Moderate (normal market)Favourable (good time)Peak (very strong demand)')
  assert.equal(en.cas, 'October 5, 2026 : Peak, Fête')
  assert.match(en.badge, />Peak<\/span>$/)
  assert.match(rendre('es').titre, /octubre/)
})
