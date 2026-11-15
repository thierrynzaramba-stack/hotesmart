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
    // La charte, comme la page la charge par son <link> (que jsdom ne suit
    // pas) : comparables lit ses couleurs de carte dans les jetons, et refuse
    // de peindre si l'un manque (review 2b, constat 9).
    const charte = w.document.createElement('style'); charte.textContent = lire('shared/theme.css'); w.document.head.append(charte)
    const mod = (rel) => { const m = evaluerModule(w, rel, {}); delete m.default; return m }
    const existe = (rel) => fs.existsSync(path.join(RACINE, rel))
    return {
      ...mod('shared/page-outil.js'),
      ...(existe('shared/yieldflow-onglets.js') ? mod('shared/yieldflow-onglets.js') : {}),
      ...mod('shared/temperature-calendrier.js'),
      ...mod('shared/biens-vivants.js'),
      ...mod('shared/yield-motifs.js'),
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

test('LE TEST QUI COMPTE (sécurité) : tHtml échappe le dictionnaire ET chaque valeur par défaut ; seul brut() laisse passer du HTML', () => {
  const w = new (require('jsdom').JSDOM)('').window
  const { tHtml, brut, esc } = evaluerModule(w, 'shared/page-outil.js', {})
  const dico = { a: 'Marché : **{loc}** <i>{n}</i>' }
  const t = (k, v = {}) => dico[k].replace(/\{(\w+)\}/g, (_, x) => (v[x] ?? `{${x}}`))
  // Une donnée brute, OUBLIÉE sans ech() : elle reste du texte (constat 1 de la review).
  assert.equal(tHtml(t, 'a', { loc: '<img src=x onerror=alert(1)>', n: 3 }), 'Marché : <b>&lt;img src=x onerror=alert(1)&gt;</b> &lt;i&gt;3&lt;/i&gt;')
  // Une chaîne n'est jamais du HTML, même déjà échappée : pas de passe-droit.
  assert.equal(tHtml(t, 'a', { loc: '&lt;', n: 1 }), 'Marché : <b>&amp;lt;</b> &lt;i&gt;1&lt;/i&gt;')
  // Seul brut() entre tel quel — et c'est à l'appelant d'y avoir échappé la donnée.
  assert.equal(tHtml(t, 'a', { loc: brut(`<u>${esc('<x>')}</u>`), n: 1 }), 'Marché : <b><u>&lt;x&gt;</u></b> &lt;i&gt;1&lt;/i&gt;')
  // Une donnée qui contient « ** » reste du texte ; null et undefined rendent vide.
  assert.equal(tHtml(t, 'a', { loc: '**x**', n: 1 }), 'Marché : <b>**x**</b> &lt;i&gt;1&lt;/i&gt;')
  assert.equal(tHtml(t, 'a', { loc: null, n: 1 }), 'Marché : <b></b> &lt;i&gt;1&lt;/i&gt;')
  // Un objet quelconque n'est pas du HTML sûr : seul le jeton de brut() l'est.
  assert.equal(tHtml(t, 'a', { loc: { html: '<b>' }, n: 1 }), 'Marché : <b>[object Object]</b> &lt;i&gt;1&lt;/i&gt;')
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
  assert.equal(en.cas, 'October 5, 2026: Peak, Fête', 'la ponctuation de la langue (constat 6 de la review)')
  assert.match(en.badge, />Peak<\/span>$/)
  assert.match(rendre('es').titre, /octubre/)
})

test('LE TEST QUI COMPTE (sécurité, constat 2 de la review) : chaque texte venu du serveur reste du texte — rendu COMPLET des trois écrans, pièges partout', async () => {
  // Les VRAIES données des fixtures, où chaque champ texte devient un piège :
  // localité, région, pays, méthode, motifs, noms d'événements, de périodes et
  // de zones, jours de la semaine, phrases du calcul.
  const { lireJson } = require('../lib/airroi/json')
  const { revparMensuel, adrOccupationMensuel } = require('../lib/marche/marche-global')
  const { progressionDuMarche } = require('../lib/marche/progression-marche')
  const T = require('../lib/marche/temperature-airroi')
  const fixture = n => lireJson(lire(`tests/fixtures/airroi/${n}`))
  const P = k => `<img src=x data-piege="${k}" onerror="window.__xss=1">`
  const MARCHE = { pays: P('pays'), region: P('region'), localite: P('localite') }
  const lignes = T.construireLignes({ marche: { country: 'France', region: 'Occitania', locality: 'Bagnères-de-Bigorre' }, reponse: fixture('relief-bagneres-2026-09-30.json') })
  const VAC = JSON.parse(lire('tests/fixtures/vacances-2026-2027.json')).vacances
  const temp = T.pourLEcran({ capture_le: '2026-09-30', jours: lignes }, '2026-10', VAC, '2027-07-03')
  // Les pièges entrent dans les noms que le calcul produit.
  temp.evenements.forEach(e => { e.nom = P('evenement') })
  temp.suggestions.forEach(s => { s.nom = P('suggestion') })
  temp.week_end_ou_semaine.meilleur = P('meilleur'); temp.week_end_ou_semaine.pire = P('pire')
  temp.week_end_ou_semaine.par_jour.forEach(j => { j.jour_semaine = P('jour') })
  temp.mois.forEach(m => { m.evenements = m.evenements.map(() => P('evt-mois')) })
  if (temp.resume && Array.isArray(temp.resume.evenements)) temp.resume.evenements.forEach(e => { e.nom = P('evt-resume') })
  if (temp.resume && temp.resume.vacances && Array.isArray(temp.resume.vacances.periodes)) {
    temp.resume.vacances.periodes.forEach(p => { p.nom = P('periode'); p.cle = 'inconnue'; if (Array.isArray(p.zones)) p.zones.forEach(z => { z.zone = P('zone') }) })
  }
  const TEMPERATURE = { source: 'airroi', etat: 'calcule', marche: MARCHE, ...temp }
  const M60 = fixture('marche-60.json')
  const HISTO = { source: 'marche', etat: 'calcule', marche: MARCHE, recupere_le: '2026-09-30T10:00:00Z', adr_occupation: adrOccupationMensuel(M60), revpar: revparMensuel(M60), progression: progressionDuMarche(M60) }
  const CAL = { localite: P('localite'), region: P('region'), pays: P('pays'), capture_le: '2026-10-30', methode: P('methode'), statut: 'calcule',
    regimes: [{ regime: 'derniere_minute', debut: '2026-11-15', fin: '2026-11-28', phrase: P('phrase-dm') }, { regime: 'pacing', debut: '2026-11-29', fin: '2027-03-31', phrase: P('phrase-p') },
      { regime: 'forme_mensuelle', debut: '2027-04-01', fin: '2027-10-31', phrase: P('phrase-m') }],
    saisons: [{ saison: P('saison'), debut: '2026-11-29', fin: '2027-03-31' }], ruptures: [],
    au_dela: [{ mois: '2027-05', saison: null, motif: P('motif-mois') }], pics: [{ debut: '2026-12-19', fin: '2027-01-03', saison: 'forte', phrase: P('pic') }],
    evenements_possibles: [{ a_lire: true, phrase: P('a-lire') }], limites: [P('non mesurée')],
    ecart_semaine_week_end: [{ debut: '2027-04-01', fin: '2027-06-30', ecart_prix_pct: null, motif: P('motif-ecart') }] }
  const ROUTES = { '/api/marche-temperature': TEMPERATURE, '/api/marche-global': HISTO, '/api/yield-marche': { etat: 'calendrier', calendrier: CAL } }
  for (const page of PAGES_2A) {
    const p = await monter(page, { api: (u) => { const r = Object.keys(ROUTES).find(k => u.startsWith(k)); return r ? { body: ROUTES[r] } : null } })
    assert.deepEqual(p.journal.erreurs, [], `${page} : ${p.journal.erreurs.join('\n')}`)
    const injectes = p.$$('img[src="x"]').map(i => i.getAttribute('data-piege'))
    assert.deepEqual(injectes, [], `${page} : des pièges sont devenus du HTML`)
    // Et les pièges sont DITS, en texte, là où la donnée s'affiche.
    assert.ok(p.$('main').textContent.includes(P('localite')), `${page} : la localité est dite`)
    assert.ok(p.$('main').textContent.includes(P('region')), `${page} : la région est dite`)
    if (page.endsWith('marche.html')) assert.ok(p.$('main').textContent.includes(P('methode')), 'la méthode est dite')
    assert.equal(p.w.__xss, undefined)
    p.fermer()
  }
})
// ─── Sous-lot 2b : « Choisir vos comparables » ───────────────────────────────

const COMPARABLES = 'apps/yield/comparables.html'
const leafletAbsent = () => ({})
const profilVide = () => ({ body: { etat: 'calcule', profil: null, retenus: [], fondateur: [], comparables: null } })

test('LE TEST QUI COMPTE (2b) : comparables charge le socle V5, la coquille, et se marque dans le sous-menu YieldFlow', async () => {
  const src = lire(COMPARABLES)
  for (const f of ['/shared/theme.css', '/shared/ui.css']) assert.match(src, new RegExp(`<link rel="stylesheet" href="${f}">`))
  assert.doesNotMatch(src, /public\/style\.css/)
  assert.doesNotMatch(sansCommentaires(src), /renderSidebar|components\/sidebar\.js/)
  assert.match(src, /<body class="out-page out-pont">/)
  const p = await monter(COMPARABLES, { api: profilVide })
  assert.deepEqual(p.journal.erreurs, [], p.journal.erreurs.join('\n'))
  assert.equal(p.d.title, `HôteSmart — ${DICOS.fr['cp.titre']}`)
  assert.ok(p.$('[data-menu] a[href="/apps/yield"]'))
  assert.deepEqual(p.$$('[data-yf-onglets] [aria-current="page"]').map(a => a.getAttribute('href')), ['/apps/yield/comparables'])
  assert.deepEqual(p.journal.coquille, ['bandeau'])
  p.fermer()
})

test('LE TEST QUI COMPTE (2b) : en anglais et en espagnol, le formulaire et ses sept équipements parlent la langue de l hôte', async () => {
  for (const langue of ['en', 'es']) {
    const D = DICOS[langue]
    const p = await monter(COMPARABLES, { langue, api: profilVide })
    assert.equal(p.texte('h1'), D['cp.titre'])
    assert.equal(p.$('.cp-intro').textContent, D['cp.intro'].replace(/\*\*/g, ''))
    assert.equal(p.texte('#cp-valider-a'), D['cp.valider_a'])
    assert.equal(p.$('#cp-adresse').getAttribute('placeholder'), D['cp.adresse_exemple'])
    const eq = p.$$('#cp-eq label').map(l => l.textContent.trim())
    assert.deepEqual(eq, ['terrasse', 'spa', 'jardin', 'piscine', 'parking', 'vue', 'climatisation'].map(k => D[`cp.eq_${k}`]))
    // La valeur qui part au serveur reste la CLÉ, quelle que soit la langue.
    assert.deepEqual(p.$$('#cp-eq input').map(i => i.value), ['terrasse', 'spa', 'jardin', 'piscine', 'parking', 'vue', 'climatisation'])
    assert.equal(p.$('.cp-strategies label').getAttribute('title'), D['cp.strat_agressif_titre'])
    assert.doesNotMatch(p.$('main').textContent, /Votre logement|Valider la description|Chambres/, langue)
    p.fermer()
  }
})

test('LE TEST QUI COMPTE (2b) : les tranches gardent UN SEUL VOCABULAIRE — le français est, au caractère, la table TRANCHE de l écran Prix', () => {
  const w = new (require('jsdom').JSDOM)('').window
  const { TRANCHE } = evaluerModule(w, 'shared/prix-depart-jours.js', {})
  for (const n of ['creux', 'modere', 'favorable', 'pic']) {
    assert.equal(DICOS.fr[`cp.tranche_${n}`], TRANCHE[n], n)
    for (const l of LANGUES) assert.ok(DICOS[l][`cp.tranche_${n}`], `${n} (${l})`)
  }
})

test('LE TEST QUI COMPTE (2b) : chaque clé de comparables existe dans les trois langues', () => {
  const src = lire(COMPARABLES)
  const cles = new Set()
  for (const m of src.matchAll(/(?:th|t)\('((?:cp|mc|mg|yfm|yfnav)\.[a-z0-9_]+)'/g)) cles.add(m[1])
  for (const m of src.matchAll(/data-(?:i18n|riche)="((?:cp|yfm|yfnav)\.[a-z0-9_]+)"/g)) cles.add(m[1])
  for (const m of src.matchAll(/(?:aria-label|placeholder|title):((?:cp|yfm|yfnav)\.[a-z0-9_]+)/g)) cles.add(m[1])
  for (const m of src.matchAll(/'((?:cp|mc|mg|yfm|yfnav)\.[a-z0-9_]+)'/g)) cles.add(m[1])
  for (const n of ['creux', 'modere', 'favorable', 'pic']) cles.add(`cp.tranche_${n}`)
  assert.ok(cles.size > 150, `${cles.size} clés trouvées`)
  const manques = []
  for (const k of cles) for (const l of LANGUES) if (!(k in DICOS[l])) manques.push(`${k} (${l})`)
  assert.deepEqual(manques, [])
})

test('LE TEST QUI COMPTE (2b) : aucun hexa dans la page ; les couleurs de la carte sont dans la charte, aux valeurs d avant', () => {
  const src = sansCommentaires(lire(COMPARABLES))
  assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b(?![\w-])/)
  assert.doesNotMatch(src, /\p{Extended_Pictographic}/u)
  // Les valeurs de l'ancienne table COULEUR (fb93b24e), dans la charte.
  const theme = lire('shared/theme.css')
  for (const [j, v] of Object.entries({ neutre: '#2A5E86', similaire: '#1F8A4C', non: '#5F6368', hote: '#E8A33D', equipements: '#7B3FA0' })) {
    assert.match(theme, new RegExp(`--yf-carte-${j}: ${v};`), j)
    assert.match(lire(COMPARABLES), new RegExp(`${j}: '--yf-carte-${j}'`), `la page lit --yf-carte-${j}`)
  }
})

test('2b : les libellés d équipements Airbnb — en français par la table, tels qu Airbnb les écrit ailleurs', async () => {
  const fiche = { listing_id: '123', nom: 'Chez Paul', ressemblance: 80, latitude: 43, longitude: 0.1, voyageurs: 2, chambres: 1, source: 'voisins', equipements: [], details: { equipements_airbnb: ['Kitchen', 'Wifi', 'Something new'] } }
  const api = (u, e) => (e.methode === 'GET' ? { body: { etat: 'calcule', profil: { adresse: 'a', adresse_trouvee: 'A', voyageurs: 2, chambres: 1, pieces: 2, salles_de_bain: 1, equipements: [], latitude: 43, longitude: 0.1 }, retenus: [], fondateur: [], comparables: [fiche] } } : null)
  for (const [langue, attendu] of [['fr', ['Cuisine', 'Wifi', 'Something new']], ['en', ['Kitchen', 'Wifi', 'Something new']], ['es', ['Kitchen', 'Wifi', 'Something new']]]) {
    const p = await monter(COMPARABLES, { langue, api })
    // Sans Leaflet au banc, la liste accessible ouvre la fiche.
    const b = p.$('#cp-liste-biens button')
    assert.ok(b, langue)
    await p.cliquer(b)
    assert.deepEqual(p.$$('.cp-tous-eq li').map(li => li.textContent), attendu, langue)
    p.fermer()
  }
})

test('2b (téléphone) : le pied collant se pose au-dessus de la barre du bas du socle, à la même largeur', () => {
  const src = lire(COMPARABLES)
  const ui = lire('shared/ui.css')
  // La barre du bas devient fixe sous 721 px…
  const bloc = ui.slice(ui.lastIndexOf('@media (max-width: 720px)', ui.indexOf('.bottombar {\n    position: fixed')), ui.indexOf('.bottombar {\n    position: fixed'))
  assert.ok(bloc.startsWith('@media (max-width: 720px)'), 'la barre du bas est fixe sous 721 px')
  // …et le pied de la page remonte à cette même largeur.
  assert.match(src, /@media \(max-width: 720px\) \{\s*\.cp-pied \{ bottom: calc\(70px \+ env\(safe-area-inset-bottom, 0px\)\); \}/)
})

test('LE TEST QUI COMPTE (2b, review constats 2, 8, 10) : le pied passe SOUS le menu ≡ et la barre du bas ; les verdicts enfoncés ont la couleur de leur point ; les boutons passent à la ligne', () => {
  const src = lire(COMPARABLES)
  const ui = lire('shared/ui.css')
  const zPied = Number((/\.cp-pied \{[^}]*z-index:\s*(\d+)/.exec(src) || [])[1])
  const zMenu = Number((/\.topbar__actions \.menu \{[^}]*z-index:\s*(\d+)|\.menu \{[^}]*z-index:\s*(\d+)/.exec(ui) || []).slice(1).find(Boolean))
  const zBas = Number((/\.bottombar \{[^}]*z-index:\s*(\d+)/.exec(ui) || [])[1])
  assert.ok(Number.isFinite(zPied) && Number.isFinite(zMenu) && Number.isFinite(zBas), `${zPied} ${zMenu} ${zBas}`)
  assert.ok(zPied < zMenu && zPied < zBas, `le pied (${zPied}) doit rester sous le menu (${zMenu}) et la barre du bas (${zBas})`)
  assert.match(src, /#cp-map \{[^}]*isolation: isolate/, 'les couches Leaflet restent chez elles')
  assert.match(src, /\[aria-pressed="true"\]\.similaire \{ background: var\(--yf-carte-similaire\); border-color: var\(--yf-carte-similaire\);/)
  assert.match(src, /\[aria-pressed="true"\]\.non \{ background: var\(--yf-carte-non\); border-color: var\(--yf-carte-non\);/)
  assert.match(src, /\.btn\.cp-btn \{ white-space: normal; height: auto; min-height: var\(--control\);/)
})

// ─── Sous-lot 2c : « Tarification dynamique » (apps/yield/index.html) ────────

const SYNTHESE = 'apps/yield/index.html'
const AUJ_2C = '2026-09-12'
const reponseYield = (o = {}) => ({
  bien: { id: 'B1', name: 'La bulle', provider: 'channex', capacity: 2, zone_scolaire: 'C', prix_minimum: 9500, base_price: null },
  fenetre: { debut: '2026-09-01', fin: '2027-08-31', granularite: 'mois', pivot: AUJ_2C, aujourdhui: AUJ_2C },
  historique: { debut: '2023-09-01', fin: '2026-08-31', ans: 3 },
  realise: [{ periode: '2026-08', reservations: 2, ca: 1000, nuitees: 10, taux_occupation: 0.33, revpar: 33.3, prix_moyen: 100, delai_median: 20, non_calculable: [],
    vs_n1: { ca: { valeur: 1000, n1: 800, ecart: 200, variation: 0.25 }, taux_occupation: { valeur: 0.33, n1: 0.3, ecart: 0.03, variation: 0.1 } } }],
  a_date: [], projection: [],
  reference: { seuil: 8, seuil_reservations: 3, nuits_vues: 680, nuits_sans_prix: 0, nuits_long_sejour: 0, par_segment: {} },
  courbe: { paliers: [0, 7, 14, 30], nuits_sans_date_fiable: 0, par_segment: {} },
  sources: { reservations_du_bien: 790, jours_hors_reference: 0, vacances: { complete: true, horizon: '2027-07-03' } },
  evenements: [], exceptions: [], droits_ecriture: true,
  ...o
})

test('LE TEST QUI COMPTE (2c) : la synthèse charge le socle V5 et se marque dans le sous-menu ; ses trois vues sont des onglets du socle', async () => {
  const src = lire(SYNTHESE)
  for (const f of ['/shared/theme.css', '/shared/ui.css']) assert.match(src, new RegExp(`<link rel="stylesheet" href="${f}">`))
  assert.doesNotMatch(src, /public\/style\.css/)
  assert.doesNotMatch(sansCommentaires(src), /renderSidebar|components\/sidebar\.js/)
  const p = await monter(SYNTHESE, { api: () => ({ body: reponseYield() }) })
  assert.deepEqual(p.journal.erreurs, [], p.journal.erreurs.join('\n'))
  assert.equal(p.d.title, `HôteSmart — ${DICOS.fr['yfs.titre_onglet']}`)
  assert.deepEqual(p.$$('[data-yf-onglets] [aria-current="page"]').map(a => a.getAttribute('href')), ['/apps/yield'])
  // Pilotage par défaut ; Bilan bascule l'onglet ET les champs.
  assert.ok(p.$('#yf-vue-pilotage').classList.contains('is-on'))
  assert.ok(p.$('.yf-si-exploration').hidden && p.$('.yf-si-bilan').hidden && p.$('#yf-charger').hidden)
  await p.cliquer(p.$('#yf-vue-bilan'))
  assert.ok(p.$('#yf-vue-bilan').classList.contains('is-on') && !p.$('#yf-vue-pilotage').classList.contains('is-on'))
  assert.equal(p.$('#yf-vue-bilan').getAttribute('aria-selected'), 'true')
  assert.ok(!p.$('.yf-si-bilan').hidden && p.$('.yf-si-exploration').hidden)
  p.fermer()
})

test('LE TEST QUI COMPTE (2c) : en anglais et en espagnol, la synthèse parle la langue de l hôte', async () => {
  for (const langue of ['en', 'es']) {
    const D = DICOS[langue]
    const p = await monter(SYNTHESE, { langue, api: () => ({ body: reponseYield() }) })
    assert.equal(p.texte('h1'), D['yfs.titre'])
    assert.deepEqual(p.$$('.yf-onglet').map(b => b.textContent), [D['yfs.vue_pilotage'], D['yfs.vue_bilan'], D['yfs.vue_exploration']])
    const titres = p.$$('.yf-bloc h2').map(h => h.textContent)
    for (const k of ['yfs.a_date', 'yfs.projection', 'yfs.reference', 'yfs.realise', 'yfs.exceptions']) assert.ok(titres.includes(D[k]), `${langue} : ${k}`)
    assert.equal(p.texte('#yf-exc-ajouter'), D['yfs.declarer'])
    assert.doesNotMatch(p.$('main').textContent, /Réalisé|Ce qui s’est vendu|Périodes hors référence|Déclarer/, langue)
    p.fermer()
  }
})

// ⚠ NON-RÉGRESSION : l'ancien écran échappait déjà tout (ech) ; ce test passe
// donc contre lui, et c'est voulu. Ce qu'il garde, c'est le passage à tHtml —
// éprouvé par mutation (un brut() posé sur le nom du logement le rougit).
test('2c (sécurité, non-régression) : le nom du logement, les motifs déclarés, les événements et l erreur du serveur restent du texte', async () => {
  const P = k => `<img src=x data-piege="${k}" onerror="window.__xss=1">`
  const corps = reponseYield({
    bien: { id: 'B1', name: P('bien'), capacity: 2, prix_minimum: 9500 },
    sources: { reservations_du_bien: 1, jours_hors_reference: 3, vacances: { complete: false, manque: P('manque'), horizon: '2027-07-03' } },
    evenements: [{ debut: '2026-12-19', fin: '2027-01-03', jours: 16, libelle: P('libelle'), segment: 'vacances_zone', zones_en_vacances: [P('zone')] }],
    exceptions: [{ id: 'e1', date_debut: '2025-03-01', date_fin: '2025-03-10', motif: P('motif') }]
  })
  const p = await monter(SYNTHESE, { api: () => ({ body: corps }) })
  assert.deepEqual(p.$$('img[src="x"]').map(i => i.getAttribute('data-piege')), [])
  for (const k of ['bien', 'manque', 'motif']) assert.ok(p.d.body.textContent.includes(P(k)), k)
  assert.equal(p.w.__xss, undefined)
  p.fermer()
  const q = await monter(SYNTHESE, { api: () => ({ status: 400, body: { error: P('erreur') } }) })
  assert.equal(q.$$('img[src="x"]').length, 0)
  assert.ok(q.$('#yf-contenu').textContent.includes(P('erreur')))
  q.fermer()
})

test('2c (non-régression) : déclarer une période part au même endpoint, avec le même corps, puis relit tout', async () => {
  const p = await monter(SYNTHESE, { api: (u, e) => (u.startsWith('/api/yield-exceptions') ? { body: { ok: true } } : { body: reponseYield() }) })
  p.$('#yf-exc-debut').value = '2025-03-01'
  p.$('#yf-exc-fin').value = '2025-03-10'
  p.$('#yf-exc-motif').value = 'travaux'
  const avant = p.journal.fetch.filter(f => f.url.startsWith('/api/yield?')).length
  p.$('#yf-exc-form').dispatchEvent(new p.w.Event('submit', { cancelable: true }))
  await p.attendre()
  const post = p.journal.fetch.find(f => f.url === '/api/yield-exceptions')
  assert.ok(post, 'le POST est parti')
  assert.equal(post.methode, 'POST')
  assert.deepEqual(post.corps, { property_id: 'B1', debut: '2025-03-01', fin: '2025-03-10', motif: 'travaux' })
  assert.equal(p.journal.fetch.filter(f => f.url.startsWith('/api/yield?')).length, avant + 1, 'la synthèse est relue')
  assert.equal(p.texte('#yf-exc-retour'), 'Période déclarée — la référence a été recalculée.', 'le texte d avant, au caractère')
  p.fermer()
})
