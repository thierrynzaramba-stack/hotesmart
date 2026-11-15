// tests/integration-v5-lot-1.test.js
// INTÉGRATION V5, LOT 1 — serrures, SMS, connexions, abonnement.
// Spec : docs/specs/spec-integration-v5-lot-1.md.
//
// Deux familles, et la distinction compte (REVIEW.md règle 19) :
//
// 1. CE QUE LE LOT CHANGE — la page charge le socle V5, monte les onglets et le
//    menu ≡ avec la section Outils de la liste UNIQUE, parle la langue de l'hôte,
//    ne porte ni hexa ni emoji, et ses liens visent les adresses V5. Ces tests
//    ROUGISSENT contre le code d'avant (contre-épreuve par `git archive` de
//    082d376e hors de l'arbre, résultat dans la spec §6 ter).
//
// 2. CE QUE LE LOT NE DOIT PAS CHANGER — chaque geste part au même endpoint
//    avec le même corps, chaque état s'affiche, chaque refus se dit. Ce sont
//    des tests de NON-RÉGRESSION : ils sont verts contre l'ancien code, et
//    c'est leur raison d'être (« la forme ne supprime jamais le fond »). Ils
//    exécutent la page au banc (tests/outils/banc-page.js) avec le VRAI moteur
//    i18n et le VRAI nav.js, et affirment le TEXTE RENDU (règle 22), jamais une
//    clé.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { monterPage, evaluerModule } = require('./outils/banc-page')

const RACINE = path.join(__dirname, '..')
const lire = (p) => fs.readFileSync(path.join(RACINE, p), 'utf8')
const PAGES = ['apps/serrures/index.html', 'apps/sms/index.html', 'pages/connexions.html', 'pages/abonnement.html']
const LANGUES = ['fr', 'en', 'es']
const DICOS = Object.fromEntries(LANGUES.map(l => [l, JSON.parse(lire(`shared/i18n/${l}.json`))]))
const sansCommentaires = (src) => src
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\s\/\/ .*$/gm, '')

const SESSION = { access_token: 'jeton-session', user: { id: 'u-moi', email: 'thierry@exemple.test', user_metadata: {} } }

// Les symboles des `import` des pages — anciennes ET nouvelles, pour que la
// contre-épreuve exécute vraiment l'ancien code au lieu de rougir sur un nom
// absent (règle 19 : « un rouge par undefined ne prouve rien »).
function injecteur (o = {}) {
  return (w, journal, supabase) => {
    journal.ordre = []
    journal.assistant = []
    const pageOutil = evaluerModule(w, 'shared/page-outil.js', {})
    return {
      ...pageOutil,
      supabase,
      getUser: async () => (await supabase.auth.getUser()).data.user,
      signOut: async () => {
        journal.ordre.push('signOut')
        journal.sessionAuMomentDeLaSortie = w.sessionStorage.length
      },
      requireAuth: async () => { journal.ordre.push('requireAuth'); return SESSION },
      // ⚠ `garde: 'refus'` : la VRAIE garde, sur un compte partagé, remplace la
      // page par son refus et ne se résout JAMAIS (shared/compte-courant.js).
      exigerCompteProprePage: async () => {
        journal.ordre.push('garde')
        if (o.garde === 'refus') await new Promise(() => {})
        return true
      },
      compteCourant: () => 'u-moi',
      peutLire: o.peutLire || (() => true),
      estTitulaire: () => o.titulaire !== false,
      comptes: () => [],
      basculerVers: () => {},
      initErrorHandler: () => {},
      markOnboardingCompleted: () => {},
      renderSidebar: async () => { journal.ordre.push('barreLaterale') },
      renderOnboardingBanner: async () => { journal.ordre.push('bandeau') },
      openConnexions: (p) => { journal.assistant.push(String(p.id)) },
      bootstrapAirbnbReturn: () => { journal.ordre.push('retourAirbnb') }
    }
  }
}

const monter = (page, o = {}) => monterPage(page, { session: SESSION, injecter: injecteur(o), ...o })

// ═══════════════════════════════════════════════════════════════════════════
// 1. CE QUE LE LOT CHANGE
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : les quatre pages chargent le socle V5, et plus l ancien', () => {
  for (const p of PAGES) {
    const html = lire(p)
    for (const f of ['/shared/theme.css', '/shared/ui.css']) {
      assert.match(html, new RegExp(`<link rel="stylesheet" href="${f}">`), `${p} : ${f} absent`)
    }
    assert.match(html, /<script src="\/shared\/i18n\/i18n\.js"><\/script>/, `${p} : moteur i18n absent`)
    assert.match(html, /<script src="\/shared\/nav\.js"><\/script>/, `${p} : nav.js absent`)
    assert.doesNotMatch(html, /public\/style\.css/, `${p} : charge encore l'ancienne feuille`)
    const vif = sansCommentaires(html)
    assert.doesNotMatch(vif, /renderSidebar|components\/sidebar\.js|id="sidebar"/, `${p} : monte encore l'ancienne barre latérale`)
    assert.match(html, /class="topbar__nav"/, `${p} : pas de barre du haut V5`)
    assert.match(html, /class="bottombar"/, `${p} : pas de barre du bas V5`)
    assert.match(html, /data-menu-toggle/, `${p} : pas de bouton du menu ≡`)
  }
})

for (const p of PAGES) {
  test(`LE TEST QUI COMPTE : ${p} monte les onglets V5 et le menu ≡ AU CHARGEMENT, Outils compris`, async () => {
    const b = await monter(p, { api: () => ({ body: {} }) })
    try {
      const liens = (sel) => b.$$(sel).map(a => a.getAttribute('href'))
      assert.deepEqual(liens('.topbar__nav a'), ['/pages/aujourdhui', '/calendrier', '/pages/messages', '/menages', '/logements'])
      assert.deepEqual(liens('.bottombar a'), ['/pages/aujourdhui', '/m/calendrier', '/pages/messages', '/menages', '/logements'])
      // Le menu ≡ : la section Outils vient de la liste UNIQUE de shared/nav.js.
      const menu = b.$('[data-menu]')
      const outils = [...menu.querySelectorAll('a.menu__item')].map(a => a.getAttribute('href'))
      for (const h of ['/apps/yield', '/apps/serrures', '/apps/sms', '/apps/reservation-directe', '/connexions', '/abonnement', '/settings', '/avis', '/guide']) {
        assert.ok(outils.includes(h), `${p} : le menu ≡ ne mène pas à ${h} (${outils.join(', ')})`)
      }
      // Le texte RENDU, pas la clé (règle 22).
      assert.ok(menu.textContent.includes('Outils'), `${p} : la section Outils n'est pas nommée`)
      assert.ok(menu.textContent.includes('Serrures') && menu.textContent.includes('Abonnement'))
      // Les initiales de l'hôte dans l'avatar, comme sur les écrans V5.
      assert.equal(b.texte('[data-bind="initials"]'), 'TH')
    } finally { b.fermer() }
  })
}

for (const p of PAGES) {
  test(`LE TEST QUI COMPTE : ${p} parle la langue de l hôte (page rendue en anglais et en espagnol)`, async () => {
    const titres = { fr: [], en: [], es: [] }
    for (const langue of LANGUES) {
      const b = await monter(p, { langue, api: () => ({ body: {} }) })
      try { titres[langue] = b.texte('main') } finally { b.fermer() }
    }
    assert.ok(titres.fr && titres.en && titres.es, `titres vides : ${JSON.stringify(titres)}`)
    assert.notEqual(titres.en, titres.fr, `${p} : la page ne change pas en anglais`)
    assert.notEqual(titres.es, titres.fr, `${p} : la page ne change pas en espagnol`)
    assert.notEqual(titres.es, titres.en)
  })
}

test('LE TEST QUI COMPTE : aucun hexa, aucun emoji dans les pages et le module du lot', () => {
  const emoji = /\p{Extended_Pictographic}/u
  for (const f of [...PAGES, 'shared/page-outil.js']) {
    const src = lire(f)
    assert.ok(!/#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3}\b(?![\w-])/.test(src.replace(/&#\d+;/g, '')), `${f} contient une couleur en dur`)
    assert.ok(!emoji.test(sansCommentaires(src)), `${f} contient un emoji`)
  }
})

test('aucune icône dessinée : <use href="/shared/icons.svg#…"> seulement, et chaque icône existe', () => {
  const sprite = lire('shared/icons.svg')
  for (const f of PAGES) {
    const html = lire(f)
    assert.ok(!/<(path|circle|rect|polyline|line)\b/.test(html), `${f} : forme SVG dessinée dans la page`)
    const icones = [...html.matchAll(/icons\.svg#([\w-]+)/g)]
    // Un contrôle qui n'a rien examiné doit échouer (REVIEW.md règle 16) : la
    // barre V5 porte au moins l'icône du menu ≡.
    assert.ok(icones.length >= 1, `${f} : aucune icône du sprite — le contrôle n'a rien examiné`)
    for (const m of icones) {
      assert.ok(sprite.includes(`id="${m[1]}"`), `${f} : icône ${m[1]} absente du sprite`)
    }
  }
})

// Les clés : DÉRIVÉES des pages, jamais recopiées. Les clés construites
// (`'abo.statut_' + s`) sont listées avec les valeurs qu'elles prennent.
const DYNAMIQUES = {
  'abo.statut_': ['trialing', 'active', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid', 'none'],
  'abo.module_': ['guestflow', 'menage', 'serrure', 'caution'],
  'abo.desc_': ['guestflow', 'menage', 'serrure', 'caution']
}
function clesDe (src) {
  const s = new Set()
  for (const m of src.matchAll(/data-i18n="([\w.]+)"/g)) s.add(m[1])
  for (const m of src.matchAll(/data-riche="([\w.]+)"/g)) s.add(m[1])
  for (const m of src.matchAll(/data-i18n-attr="([^"]+)"/g)) for (const p of m[1].split(';')) s.add(p.split(':')[1].trim())
  for (const m of src.matchAll(/'((?:outil|serrures|sms|cnx|abo|common|nav)\.[\w]+)'/g)) s.add(m[1])
  for (const [prefixe, valeurs] of Object.entries(DYNAMIQUES)) {
    if (src.includes(`'${prefixe}' +`)) { s.delete(prefixe); for (const v of valeurs) s.add(prefixe + v) }
  }
  return [...s]
}

test('LE TEST QUI COMPTE : chaque clé de texte des quatre pages existe dans les TROIS langues, non vide', () => {
  let total = 0
  for (const p of PAGES) {
    const cles = clesDe(lire(p))
    assert.ok(cles.length > 20, `${p} : extraction des clés vide ou trop courte (${cles.length})`)
    total += cles.length
    for (const l of LANGUES) {
      const manquantes = cles.filter(k => !(k in DICOS[l]) || !String(DICOS[l][k]).trim())
      assert.deepEqual(manquantes, [], `${p} : clés absentes ou vides dans ${l}.json`)
    }
  }
  assert.ok(total > 200, `trop peu de clés vues : ${total}`)
})

test('les dictionnaires du lot ne portent aucun emoji, et les marques de texte riche sont équilibrées', () => {
  const emoji = /\p{Extended_Pictographic}/u
  for (const l of LANGUES) {
    const du_lot = Object.keys(DICOS[l]).filter(k => /^(outil|serrures|sms|cnx|abo)\./.test(k))
    assert.ok(du_lot.length > 200, `${l}.json : ${du_lot.length} clés du lot — le contrôle n'a rien examiné`)
    for (const [k, v] of Object.entries(DICOS[l])) {
      if (!/^(outil|serrures|sms|cnx|abo)\./.test(k)) continue
      assert.ok(!emoji.test(v), `${l}.json ${k} : emoji`)
      assert.equal((v.match(/\*\*/g) || []).length % 2, 0, `${l}.json ${k} : ** non fermé`)
      assert.equal((v.match(/`/g) || []).length % 2, 0, `${l}.json ${k} : \` non fermé`)
      // Un lien porte un NOM, jamais une adresse : l'URL est dans la page.
      for (const m of v.matchAll(/\]\(([^)]*)\)/g)) assert.match(m[1], /^\w+$/, `${l}.json ${k} : adresse dans la traduction`)
    }
  }
})

test('LE TEST QUI COMPTE : les liens internes visent les adresses V5', () => {
  for (const p of PAGES) {
    const vif = sansCommentaires(lire(p))
    for (const vieille of ['/dashboard', '"/pages/index.html"', '/apps/agent-ai/messagerie', '/apps/menages"', '"/biens"', "'/biens'"]) {
      assert.ok(!vif.includes(vieille), `${p} : lien vers une ancienne adresse ${vieille}`)
    }
    assert.match(lire(p), /<a class="topbar__brand" href="\/pages\/aujourdhui">/, `${p} : le logo ne mène pas à l'accueil V5`)
  }
})

// ─── La liste UNIQUE des outils ─────────────────────────────────────────────
function navDans (url = 'https://hs.test/x') {
  const { JSDOM } = require('jsdom')
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only', url })
  dom.window.eval(lire('shared/nav.js'))
  return dom.window.HSNav
}

test('LE TEST QUI COMPTE : HSNav.outils rend la liste des outils, avec les droits des écrans V5', () => {
  const HSNav = navDans()
  assert.equal(typeof HSNav.outils, 'function', 'shared/nav.js n expose pas la liste unique')
  // Les tableaux viennent du royaume jsdom : on les ramène ici avant de comparer.
  const ici = (x) => JSON.parse(JSON.stringify(x))
  const titulaire = ici(HSNav.outils({ peutLire: () => true, titulaire: true }))
  assert.deepEqual(titulaire.map(o => o.href),
    ['/apps/yield', '/apps/serrures', '/apps/sms', '/apps/reservation-directe', '/connexions', '/abonnement'])
  assert.deepEqual(titulaire.map(o => o.key),
    ['nav.tool_yield', 'nav.tool_locks', 'nav.tool_sms', 'nav.tool_direct', 'nav.tool_connections', 'nav.tool_billing'])
  // Un membre délégué qui lit les réservations : YieldFlow seul (l'app est
  // délégable), le reste est au titulaire — comme l'ancienne barre latérale.
  const membre = ici(HSNav.outils({ peutLire: d => d === 'reservations', titulaire: false }))
  assert.deepEqual(membre.map(o => o.href), ['/apps/yield'])
  assert.deepEqual(ici(HSNav.outils({ peutLire: () => false, titulaire: false })), [])
  // ⚠ Sans droits fournis, AUCUN outil : une entrée de trop est un lien vers un refus.
  assert.deepEqual(ici(HSNav.outils()), [])
  assert.deepEqual(ici(HSNav.outils({ titulaire: 'oui' })), [], 'un titulaire se dit par `true`, pas par une valeur vraie')
})

test('la liste unique n expose pas ses champs de droit aux pages', () => {
  const HSNav = navDans()
  for (const o of HSNav.outils({ peutLire: () => true, titulaire: true })) {
    assert.deepEqual(Object.keys(o).sort(), ['href', 'icon', 'key'])
  }
})

// ⚠ LES COPIES QUI RESTENT CETTE NUIT. Sept écrans V5 recopient la section
// Outils (mesuré sur main 082d376e). Elles ne sont pas remplacées dans ce lot ;
// d'ici là, chacune doit dire EXACTEMENT ce que dit la liste unique — adresse,
// clé, icône, droit et ordre — sinon une page montrerait un menu différent de
// sa voisine. Découvertes dans le dépôt, jamais listées à la main.
test('LE TEST QUI COMPTE : chaque copie de la section Outils dit exactement ce que dit la liste unique', () => {
  const ici = (x) => JSON.parse(JSON.stringify(x))
  const HSNav = navDans()
  const titulaire = ici(HSNav.outils({ peutLire: () => true, titulaire: true }))
  const membre = ici(HSNav.outils({ peutLire: d => d === 'reservations', titulaire: false })).map(o => o.href)
  const copies = []
  for (const d of ['pages', 'apps']) {
    const parcourir = (rel) => {
      for (const e of fs.readdirSync(path.join(RACINE, rel), { withFileTypes: true })) {
        const r = `${rel}/${e.name}`
        if (e.isDirectory()) parcourir(r)
        else if (e.name.endsWith('.html') && /\boutils:\s*\[/.test(lire(r))) copies.push(r)
      }
    }
    parcourir(d)
  }
  assert.ok(copies.length >= 7, `copies trouvées : ${copies.join(', ')}`)
  for (const c of copies) {
    const bloc = lire(c).match(/outils:\s*\[([\s\S]*?)\n\s*\]\.filter\(Boolean\)/)
    assert.ok(bloc, `${c} : forme de la copie inattendue`)
    const lignes = [...bloc[1].matchAll(/(peutLire\('(\w+)'\)|estTitulaire\(\))\s*&&\s*\{\s*href:\s*'([^']+)',\s*key:\s*'([^']+)',\s*icon:\s*'([^']+)'\s*\}/g)]
      .map(m => ({ droit: m[2] ? `lire:${m[2]}` : 'titulaire', href: m[3], key: m[4], icon: m[5] }))
    assert.deepEqual(lignes.map(({ href, key, icon }) => ({ href, key, icon })), titulaire, `${c} : la copie diverge de la liste unique`)
    assert.deepEqual(lignes.filter(l => l.droit === 'lire:reservations').map(l => l.href), membre, `${c} : les droits de la copie divergent`)
  }
})

// ─── Le bloc PAGES OUTILS de shared/ui.css ──────────────────────────────────
const UI = lire('shared/ui.css')
const DEBUT_BLOC = UI.indexOf('PAGES OUTILS (intégration V5)')
function blocOutils () {
  assert.ok(DEBUT_BLOC > 0, 'le bloc PAGES OUTILS est absent de shared/ui.css')
  const debut = UI.lastIndexOf('/*', DEBUT_BLOC)
  const finEnTete = UI.indexOf('*/', DEBUT_BLOC) + 2
  // Le bloc va jusqu'au prochain en-tête de bloc (« /* ===… ») d'un autre fil,
  // ou à la fin du fichier.
  const prochain = UI.slice(finEnTete).search(/\/\* =+\s*\n/)
  return UI.slice(debut, prochain >= 0 ? finEnTete + prochain : UI.length)
}

// ⚠ CE TEST NE GARDE QUE LE BLOC DU LOT. Qu'aucune ligne existante de
// shared/ui.css ne soit modifiée se vérifie sur le DIFF du lot, à la review
// (`git diff --numstat` : 0 suppression) — pas dans un test permanent, que les
// blocs des autres fils feraient rougir à chaque merge.
test('LE TEST QUI COMPTE : le bloc PAGES OUTILS n habille que des classes `out-`', () => {
  const css = blocOutils().replace(/\/\*[\s\S]*?\*\//g, '')
  const selecteurs = []
  for (const m of css.matchAll(/([^{}@]+)\{[^{}]*\}/g)) {
    for (const s of m[1].split(',')) { const x = s.trim(); if (x && !/^(from|to|\d+%)$/.test(x)) selecteurs.push(x) }
  }
  assert.ok(selecteurs.length > 60, `trop peu de sélecteurs lus : ${selecteurs.length}`)
  const etrangers = selecteurs.filter(s => !/\.out(-[\w-]+)?\b/.test(s))
  assert.deepEqual(etrangers, [], 'sélecteurs hors `out-` dans le bloc')
  assert.ok(!/#[0-9A-Fa-f]{3,6}\b/.test(css), 'couleur en dur dans le bloc')
})

test('LE TEST QUI COMPTE : le pont `.out-pont` couvre chaque variable de l ancien socle que l assistant de connexion utilise', () => {
  const theme = lire('shared/theme.css')
  const pont = (blocOutils().match(/\.out-pont\s*\{([^}]*)\}/) || [])[1]
  assert.ok(pont, 'le pont .out-pont est absent')
  const vues = new Set()
  for (const f of ['components/connexions.js', 'components/airbnb-connect.js', 'components/booking-connect.js']) {
    for (const m of lire(f).matchAll(/var\((--[\w-]+)/g)) vues.add(m[1])
  }
  assert.ok(vues.size >= 6, `variables lues dans l'assistant : ${[...vues].join(', ')}`)
  const definie = (v) => new RegExp(`${v}\\s*:`).test(pont) || new RegExp(`^\\s*${v}\\s*:`, 'm').test(theme)
  const orphelines = [...vues].filter(v => !definie(v))
  assert.deepEqual(orphelines, [], 'variables de l\'assistant définies nulle part sur la page des connexions : sa fenêtre serait transparente')
  // Et le pont n'invente pas de couleur : uniquement des alias.
  for (const m of pont.matchAll(/--[\w-]+\s*:\s*([^;]+);/g)) assert.match(m[1].trim(), /^var\(--[\w-]+\)$/, `alias attendu : ${m[0]}`)
  assert.match(lire('pages/connexions.html'), /<body class="[^"]*\bout-pont\b[^"]*">/)
})

// ─── Le texte riche : seule protection d'une donnée serveur (constat 4) ─────
// `rendreRiche` échappe AVANT de poser ses trois marques. L'adresse
// d'expédition enregistrée (une donnée serveur) passe par lui jusqu'à
// innerHTML : sans l'échappement, une adresse piégée devenait du HTML.
test('LE TEST QUI COMPTE (SÉCURITÉ) : rendreRiche échappe tout, et ne pose que gras, code et liens FOURNIS', () => {
  const { JSDOM } = require('jsdom')
  const w = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' }).window
  const { rendreRiche } = evaluerModule(w, 'shared/page-outil.js', {})
  const pieges = [
    '<img src=x onerror=alert(1)>',
    '"><script>alert(1)</script>',
    "**<b onmouseover='x'>gras</b>**",
    '[clic](inconnu) et [clic](js)',
    '`<svg onload=alert(1)>`',
    '[a](lien)" onclick="x'
  ]
  for (const p of pieges) {
    const div = w.document.createElement('div')
    div.innerHTML = rendreRiche(p, { js: 'javascript:alert(1)'.replace('javascript:', '/x?'), lien: 'https://exemple.test/a"b' })
    const balises = [...div.querySelectorAll('*')].map(e => e.tagName.toLowerCase())
    assert.ok(balises.every(b => ['b', 'code', 'a'].includes(b)), `balise inattendue pour ${p} : ${balises.join(',')}`)
    for (const e of div.querySelectorAll('*')) {
      for (const a of e.attributes) assert.ok(['class', 'href', 'target', 'rel'].includes(a.name), `attribut injecté ${a.name} pour ${p}`)
    }
    assert.ok(!div.querySelector('img, script, svg'))
  }
  const ok = w.document.createElement('div')
  ok.innerHTML = rendreRiche('Allez dans **API Keys**, clé `seam_`, voir [la console](seam) ou [rien](absent).', { seam: 'https://console.seam.co' })
  assert.equal(ok.querySelector('b').textContent, 'API Keys')
  assert.equal(ok.querySelector('code').textContent, 'seam_')
  const liens = [...ok.querySelectorAll('a')]
  assert.equal(liens.length, 1, 'un nom de lien inconnu reste du texte')
  assert.equal(liens[0].getAttribute('href'), 'https://console.seam.co')
  assert.equal(liens[0].getAttribute('rel'), 'noopener')
  assert.match(ok.textContent, /ou rien\.$/)
  const interne = w.document.createElement('div')
  interne.innerHTML = rendreRiche('[Serrures](s)', { s: '/apps/serrures' })
  assert.equal(interne.querySelector('a').getAttribute('target'), null, 'un lien interne reste dans l onglet')
})

test('LE TEST QUI COMPTE (SÉCURITÉ) : une adresse d expédition piégée reste du TEXTE à l écran', async () => {
  const piege = '<img src=x onerror=alert(1)>@x.test'
  const b = await monter('pages/connexions.html', {
    api: (u, e) => {
      if (u.includes('action=config')) return { body: { configured: true, enabled: true, senderEmail: piege } }
      if (u.includes('action=senders')) return { body: { configured: true, senders: [{ email: 'a@x.test', name: '<b>Thierry</b>' }] } }
      return { body: u.startsWith('/api/channel-property') ? { properties: [] } : { connected: false } }
    }
  })
  try {
    assert.equal(b.$('#sender-aide img'), null, 'l adresse enregistrée a été interprétée comme du HTML')
    assert.ok(b.texte('#sender-aide').includes(piege))
    assert.equal(b.$('#brevo-sender option').textContent, '<b>Thierry</b> — a@x.test')
  } finally { b.fermer() }
})

// ─── La garde de compte propre, éprouvée par son COMPORTEMENT (constat 3) ───
// La vraie garde, sur un compte partagé, remplace la page par son refus et ne
// se résout jamais. Rien ne doit être parti avant : ni lecture de la base, ni
// `/api`, ni session — les dictionnaires seuls.
for (const p of PAGES) {
  test(`LE TEST QUI COMPTE (SÉCURITÉ) : ${p} — garde refusée, RIEN ne part (ni /api, ni base, ni session)`, async () => {
    const b = await monter(p, { garde: 'refus', attenteMax: 300, api: () => ({ body: {} }) })
    try {
      assert.ok(b.journal.ordre.includes('garde'), 'la garde n a pas été appelée')
      assert.deepEqual(b.journal.fetch.filter(f => !f.url.startsWith('/shared/i18n/')).map(f => f.url), [])
      assert.deepEqual(b.journal.supabase.map(r => r.table), [])
      assert.deepEqual(b.journal.auth, [], 'getUser est parti avant la garde')
      assert.ok(!b.journal.ordre.includes('requireAuth'), 'la session est lue avant la garde')
    } finally { b.fermer() }
  })
}

// ─── Le nom de la page dans l'onglet (constat 11) ────────────────────────────
test('chaque page garde son nom dans l onglet du navigateur, dans la langue de l hôte', async () => {
  const attendu = {
    'apps/serrures/index.html': 'HôteSmart — Serrures connectées',
    'apps/sms/index.html': 'HôteSmart — SMS',
    'pages/connexions.html': 'HôteSmart — Connexions API',
    'pages/abonnement.html': 'HôteSmart — Mon abonnement'
  }
  for (const [p, titre] of Object.entries(attendu)) {
    const b = await monter(p, { api: () => ({ body: {} }) })
    try { assert.equal(b.d.title, titre) } finally { b.fermer() }
  }
})

// ─── Le bandeau d'incitation ne recouvre pas le menu ≡ (constat 1) ──────────
test('au téléphone, le menu ≡ des pages outils s ouvre SOUS le bandeau d incitation', () => {
  const css = blocOutils().replace(/\/\*[\s\S]*?\*\//g, '')
  const mobile = css.slice(css.indexOf('@media (max-width: 720px)'))
  assert.match(mobile, /\.out-page \.menu \{ top: calc\(64px \+ var\(--bandeau-h, 0px\)\); \}/)
  // Le 64 px est celui du socle : si le socle bouge, cette règle doit suivre.
  assert.match(UI, /\.menu \{ position: fixed; inset-inline: var\(--gap-m\); top: 64px;/)
  for (const p of PAGES) assert.match(lire(p), /<body class="out-page[" ]/, `${p} : pas de classe out-page`)
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. CE QUE LE LOT NE DOIT PAS CHANGER (non-régression)
// ═══════════════════════════════════════════════════════════════════════════

// ─── Serrures ───────────────────────────────────────────────────────────────
test('serrures : la configuration se lit au chargement, la clé est masquée, l état est dit', async () => {
  const b = await monter('apps/serrures/index.html', { api: (u) => u.includes('action=config') ? { body: { configured: true, enabled: true } } : null })
  try {
    assert.deepEqual(b.appels('/api/serrures').map(f => f.url), ['/api/serrures?action=config'])
    assert.equal(b.appels('/api/serrures')[0].entetes.Authorization, 'Bearer jeton-session')
    assert.match(b.$('#apiKey').value, /^•+$/)
    assert.equal(b.$('#seamEnabled').checked, true)
    assert.equal(b.texte('#statusText'), 'Seam connecté et actif')
    assert.equal(b.texte('#topStatus'), 'Seam · Actif')
    const iGarde = b.journal.ordre.indexOf('garde')
    assert.ok(iGarde >= 0 && iGarde < b.journal.ordre.indexOf('requireAuth'), 'la garde de compte propre passe AVANT la session')
    assert.ok(b.journal.ordre.includes('bandeau'), 'le bandeau d incitation que la barre latérale posait est gardé')
  } finally { b.fermer() }
})

test('serrures : un refus du serveur à la bascule REMET la case et le dit (réponse lue)', async () => {
  const b = await monter('apps/serrures/index.html', {
    api: (u, e) => {
      if (u.includes('action=config')) return { body: { configured: false } }
      if (e.corps && e.corps.action === 'toggleConfig') return { status: 400, body: { error: 'Aucune clé Seam enregistrée' } }
      return null
    }
  })
  try {
    await b.changer(b.$('#seamEnabled'), true)
    assert.equal(b.$('#seamEnabled').checked, false, 'la case dit « activé » alors que le serveur a refusé')
    assert.equal(b.texte('#configToast'), 'Aucune clé Seam enregistrée')
    assert.match(b.$('#configToast').className, /out-retour--erreur/)
    assert.equal(b.texte('#statusText'), 'Non configuré', 'l état ne doit pas passer à « actif »')
  } finally { b.fermer() }
})

test('serrures : une clé vide ou masquée est refusée sans appel', async () => {
  const b = await monter('apps/serrures/index.html', { api: () => ({ body: { configured: true, enabled: false } }) })
  try {
    const avant = b.appels('/api/serrures').length
    await b.cliquer(b.$('[data-action="enregistrer"]'))
    assert.equal(b.appels('/api/serrures').length, avant)
    assert.equal(b.texte('#configToast'), 'Saisissez une clé API valide')
  } finally { b.fermer() }
})

test('serrures : la liste vide dit « module optionnel » et ramène à la configuration', async () => {
  const b = await monter('apps/serrures/index.html', { api: (u) => u.includes('action=locks') ? { body: { locks: [] } } : { body: {} } })
  try {
    await b.cliquer(b.$('[data-onglet="locks"]'))
    assert.ok(b.appels('/api/serrures?action=locks').length === 1)
    assert.match(b.texte('#locks-container'), /module optionnel/)
    await b.cliquer(b.$('#locks-container [data-action="configurer"]'))
    assert.equal(b.$('#tab-config').hidden, false)
    assert.equal(b.$('#tab-locks').hidden, true)
  } finally { b.fermer() }
})

test('serrures : une serrure offline dit ses codes immuables, et sa corbeille est désactivée', async () => {
  const lock = { device_id: 'dev-<1>', display_name: 'Porte <b>entrée</b>', capabilities_supported: [], properties: { locked: true, manufacturer: 'Igloo', battery_level: 0.8 } }
  const b = await monter('apps/serrures/index.html', {
    api: (u) => {
      if (u.includes('action=locks')) return { body: { locks: [lock] } }
      if (u.includes('action=codes')) return { body: { codes: [{ name: 'Sofia', code: '1234', access_code_id: 'c1', starts_at: '2026-11-20T15:00:00Z', ends_at: '2026-11-22T10:00:00Z' }] } }
      return { body: {} }
    }
  })
  try {
    await b.cliquer(b.$('[data-onglet="locks"]'))
    const carte = b.$('[data-serrure]')
    assert.ok(carte.textContent.includes('Porte <b>entrée</b>'), 'le nom de la serrure est du TEXTE, jamais du HTML')
    assert.equal(carte.querySelector('b') && carte.querySelector('b').textContent === 'entrée', false)
    assert.match(carte.textContent, /Offline/)
    assert.match(carte.textContent, /Verrouillée/)
    assert.match(carte.textContent, /Marque : Igloo/)
    assert.match(carte.textContent, /Batterie 80 %/)
    assert.match(carte.textContent, /Mode offline \(codes immuables\)/)
    await b.cliquer(carte.querySelector('[data-action="codes"]'))
    const appel = b.appels('/api/serrures?action=codes')[0]
    assert.equal(appel.url, '/api/serrures?action=codes&lock_id=dev-%3C1%3E')
    const corbeille = carte.querySelector('[data-codes] button')
    assert.equal(corbeille.disabled, true, 'un code offline ne se supprime pas')
    assert.equal(corbeille.getAttribute('title'), 'Code immuable (mode offline)')
    assert.match(carte.querySelector('[data-codes]').textContent, /1234/)
    assert.equal(carte.querySelector('[data-action="codes"]').textContent, 'Masquer codes')
  } finally { b.fermer() }
})

test('serrures : générer un code envoie la serrure, le voyageur et les bornes, puis montre le code', async () => {
  const lock = { device_id: 'dev-1', properties: { name: 'Porte' }, capabilities_supported: ['online_access_codes'] }
  const b = await monter('apps/serrures/index.html', {
    api: (u, e) => {
      if (u.includes('action=locks')) return { body: { locks: [lock] } }
      if (e.corps && e.corps.action === 'generateCode') return { body: { success: true, code: { code: '4321', starts_at: '2026-11-20T15:00:00Z', ends_at: '2026-11-22T10:00:00Z' } } }
      return { body: {} }
    }
  })
  try {
    await b.cliquer(b.$('[data-onglet="locks"]'))
    await b.cliquer(b.$('[data-action="generer"]'))
    assert.ok(b.$('#modal').hasAttribute('open'), 'la fenêtre ne s ouvre pas')
    b.$('#modal-guest').value = 'Sofia'
    await b.cliquer(b.$('#modal-generate'))
    const g = b.journal.fetch.find(f => f.corps && f.corps.action === 'generateCode')
    assert.equal(g.corps.lock_id, 'dev-1')
    assert.equal(g.corps.guest_name, 'Sofia')
    assert.ok(g.corps.starts_at && g.corps.ends_at)
    assert.equal(b.texte('#code-pin-display'), '4321')
    assert.equal(b.$('#code-result').hidden, false)
    assert.equal(b.$('#modal-generate').hidden, true)
    assert.match(b.texte('#code-validity'), /^Valide du \d\d\/\d\d\/2026 au \d\d\/\d\d\/2026$/)
    await b.cliquer(b.$('[data-action="copier"]'))
    assert.equal(b.journal.presse, '4321')
  } finally { b.fermer() }
})

test('serrures : un code créé sans bornes lisibles est MONTRÉ quand même (constat 5)', async () => {
  const lock = { device_id: 'dev-1', properties: { name: 'Porte' }, capabilities_supported: ['online_access_codes'] }
  const b = await monter('apps/serrures/index.html', {
    api: (u, e) => {
      if (u.includes('action=locks')) return { body: { locks: [lock] } }
      if (e.corps && e.corps.action === 'generateCode') return { body: { success: true, code: { code: '4321' } } }
      return { body: {} }
    }
  })
  try {
    await b.cliquer(b.$('[data-onglet="locks"]'))
    await b.cliquer(b.$('[data-action="generer"]'))
    await b.cliquer(b.$('#modal-generate'))
    assert.equal(b.texte('#code-pin-display'), '4321')
    assert.equal(b.$('#code-result').hidden, false, 'le code créé chez Seam n est pas montré')
    assert.equal(b.$('#modal-generate').hidden, true, 'un second code reste possible par erreur')
  } finally { b.fermer() }
})

// ─── SMS ────────────────────────────────────────────────────────────────────
test('SMS : un modèle remplit le message, le compteur suit (160 puis 320)', async () => {
  const b = await monter('apps/sms/index.html', { api: () => ({ body: {} }) })
  try {
    assert.equal(b.texte('#charCount'), '0 / 160')
    await b.cliquer(b.$('[data-modele="checkin"]'))
    assert.match(b.$('#message').value, /^Bonjour, voici vos informations d'arrivée : le code de la boîte à clés est \[CODE\]\. Bon séjour !$/)
    assert.equal(b.texte('#charCount'), `${b.$('#message').value.length} / 160`)
    await b.changer(b.$('#message'), 'x'.repeat(161))
    assert.match(b.$('#charCount').className, /out-compteur--long/)
    await b.changer(b.$('#message'), 'x'.repeat(321))
    assert.match(b.$('#charCount').className, /out-compteur--trop/)
  } finally { b.fermer() }
})

test('SMS : l envoi exige numéro et message, puis part avec le bien et le contexte choisis', async () => {
  const b = await monter('apps/sms/index.html', { api: (u, e) => (e.corps && e.corps.action === 'send') ? { body: { success: true } } : { body: {} } })
  try {
    await b.cliquer(b.$('#sendBtn'))
    assert.equal(b.texte('#sendToast'), 'Numéro et message requis.')
    assert.equal(b.journal.fetch.filter(f => f.corps && f.corps.action === 'send').length, 0)
    b.$('#to').value = '+33612345678'
    b.$('#message').value = 'Bonjour'
    b.$('#property_id').value = '209413'
    b.$('#context').value = 'menages'
    await b.cliquer(b.$('#sendBtn'))
    const envoi = b.journal.fetch.find(f => f.corps && f.corps.action === 'send')
    assert.deepEqual(envoi.corps, { action: 'send', to: '+33612345678', message: 'Bonjour', property_id: '209413', context: 'menages' })
    assert.equal(b.texte('#sendToast'), 'SMS envoyé !')
    assert.equal(b.$('#message').value, '')
    assert.equal(b.$('#sendBtn').disabled, false)
    // La liste des biens est celle de l'ancienne page, et le choix « aucun » existe.
    assert.deepEqual(b.$$('#property_id option').map(o => o.value), ['', '169567', '209413'])
  } finally { b.fermer() }
})

test('SMS : l historique compte, filtre par bien, et montre le message comme du TEXTE', async () => {
  const logs = [
    { to_number: '+33600000001', created_at: '2026-11-14T09:05:00Z', message: '<img src=x onerror=alert(1)>', status: 'sent', context: 'manuel', property_id: '169567' },
    { to_number: '+33600000002', created_at: '2026-11-14T10:00:00Z', message: 'B', status: 'error', error: 'crédit épuisé' }
  ]
  const b = await monter('apps/sms/index.html', { api: (u) => u.includes('action=logs') ? { body: { logs } } : { body: {} } })
  try {
    await b.cliquer(b.$('[data-onglet="history"]'))
    assert.equal(b.texte('#statTotal'), '2')
    assert.equal(b.texte('#statSuccess'), '1')
    assert.equal(b.texte('#statError'), '1')
    assert.equal(b.$('#smsList img'), null, 'le message d un SMS a été interprété comme du HTML')
    assert.match(b.texte('#smsList'), /Cœur de vie 23/)
    assert.match(b.texte('#smsList'), /crédit épuisé/)
    await b.changer(b.$('#filterProperty'), '209413')
    assert.equal(b.appels('/api/sms?action=logs').at(-1).url, '/api/sms?action=logs&property_id=209413')
  } finally { b.fermer() }
})

// ─── Connexions (les garde-fous de tests/expediteur-email.test.js et de
//     tests/inbound-email.test.js, RECIBLÉS sur l'écran rendu) ────────────────
const API_CNX = (o = {}) => (u, e) => {
  if (u.startsWith('/api/beds24-setup')) return { body: o.beds24 || { connected: false } }
  if (u.startsWith('/api/channel-property')) return { body: { properties: o.biens || [] } }
  if (u.includes('action=config')) return o.configErreur ? { status: 500, body: '<html>' } : { body: o.config || { configured: true, enabled: true, senderEmail: null } }
  if (u.includes('action=senders')) return { body: o.senders || { configured: true, senders: [{ email: 'a@x.test', name: 'Thierry' }] } }
  if (e.corps && e.corps.action === 'saveSender') return { body: { success: true } }
  return null
}

test('connexions : l adresse d expédition est un MENU des expéditeurs vérifiés, jamais un champ libre', async () => {
  const b = await monter('pages/connexions.html', { api: API_CNX() })
  try {
    const champ = b.$('#bloc-expediteur #brevo-sender')
    assert.equal(champ.tagName, 'SELECT', 'un champ texte laisserait saisir une adresse que Brevo refusera')
    assert.equal(b.$$('#bloc-expediteur input').length, 0)
    assert.deepEqual(b.$$('#brevo-sender option').map(o => o.value), ['a@x.test'])
  } finally { b.fermer() }
})

test('connexions : rien de choisi, l écran ANNONCE le défaut', async () => {
  const b = await monter('pages/connexions.html', { api: API_CNX() })
  try {
    assert.equal(b.texte('#sender-aide'), 'Par défaut : Thierry — a@x.test')
  } finally { b.fermer() }
})

test('LE TEST QUI COMPTE : l écran DIT que l adresse enregistrée n est plus un expéditeur vérifié, et la conséquence', async () => {
  const b = await monter('pages/connexions.html', { api: API_CNX({ config: { configured: true, enabled: true, senderEmail: 'vieille@x.test' } }) })
  try {
    const aide = b.texte('#sender-aide')
    assert.match(aide, /L'adresse enregistrée \(vieille@x\.test\) n'est plus un expéditeur vérifié/)
    assert.match(aide, /vos e-mails aux voyageurs ne partent plus/)
    assert.doesNotMatch(aide, /Par défaut/, 'l écran affirmerait le contraire du serveur')
    assert.equal(b.$('#sender-aide b').textContent, 'vieille@x.test')
  } finally { b.fermer() }
})

test('connexions : sur erreur de configuration, le bloc expéditeur ne reste pas figé sur « Chargement… »', async () => {
  const b = await monter('pages/connexions.html', { api: API_CNX({ configErreur: true }) })
  try {
    assert.equal(b.$('#bloc-expediteur').hidden, true, 'une UI morte ne doit pas prétendre attendre quelque chose')
    assert.equal(b.texte('#status-brevo'), 'Erreur')
  } finally { b.fermer() }
})

test('connexions : sans clé Brevo, le réglage d expédition est caché', async () => {
  const b = await monter('pages/connexions.html', { api: API_CNX({ config: { configured: false } }) })
  try {
    assert.equal(b.$('#bloc-expediteur').hidden, true)
    assert.equal(b.texte('#status-brevo'), 'Non configuré')
  } finally { b.fermer() }
})

test('connexions : l encart explique le circuit des réponses, avec son filet', async () => {
  const b = await monter('pages/connexions.html', { api: API_CNX() })
  try {
    const t = b.texte('#bloc-expediteur')
    assert.match(t, /Où arrivent les réponses de vos voyageurs/)
    assert.match(t, /et non dans votre boîte mail/, 'le changement d habitude est dit')
    assert.match(t, /une copie par e-mail/, 'et le filet aussi')
  } finally { b.fermer() }
})

test('connexions : l expéditeur ne suit pas l interrupteur SMS (SMS coupés, réglage d e-mail lisible)', async () => {
  const b = await monter('pages/connexions.html', { api: API_CNX({ config: { configured: true, enabled: false, senderEmail: null } }) })
  try {
    assert.equal(b.$('#brevo-enabled').checked, false)
    assert.equal(b.$('#bloc-expediteur').hidden, false)
    assert.equal(b.texte('#status-brevo'), 'Clé enregistrée, envoi SMS désactivé')
  } finally { b.fermer() }
})

test('connexions : un bien EN MIGRATION est proposé, et `?bien=` ouvre l assistant sur CE bien', async () => {
  const biens = [
    { id: 'b1', name: 'La bulle', provider: 'channex', city: 'Bagnères' },
    { id: 'b2', name: 'Cœur', provider: 'beds24', migration_target_property_id: 'p-cible' },
    { id: 'b3', name: 'Beds pur', provider: 'beds24' }
  ]
  const b = await monter('pages/connexions.html', { url: 'https://hs.test/pages/connexions?bien=b2', api: API_CNX({ biens }) })
  try {
    assert.deepEqual(b.$$('[data-connect]').map(x => x.dataset.connect), ['b1', 'b2'])
    assert.equal(b.texte('#status-ota'), '2 biens')
    assert.deepEqual(b.journal.assistant, ['b2'], 'l assistant ne s est pas ouvert sur le bien demandé')
    await b.cliquer(b.$('[data-connect="b1"]'))
    assert.deepEqual(b.journal.assistant, ['b2', 'b1'])
    assert.ok(b.journal.ordre.includes('retourAirbnb'), 'le retour Airbnb en pleine page doit rester branché')
  } finally { b.fermer() }
})

test('connexions : un identifiant inconnu SE DIT, et un compte sans bien éligible aussi', async () => {
  const inconnu = await monter('pages/connexions.html', { url: 'https://hs.test/pages/connexions?bien=zz', api: API_CNX({ biens: [{ id: 'b1', name: 'A', provider: 'channex' }] }) })
  try {
    assert.ok(inconnu.$('[data-bien-inconnu]'), 'un identifiant inconnu doit le DIRE')
    assert.deepEqual(inconnu.journal.assistant, [])
  } finally { inconnu.fermer() }
  const vide = await monter('pages/connexions.html', { url: 'https://hs.test/pages/connexions?bien=zz', api: API_CNX({ biens: [] }) })
  try {
    assert.match(vide.texte('#ota-properties'), /Ce logement n'est pas encore éligible/)
    assert.equal(vide.$('#ota-properties a').getAttribute('href'), '/logements/nouveau')
    assert.equal(vide.texte('#status-ota'), 'Aucun bien')
  } finally { vide.fermer() }
})

test('connexions : l état Seam se lit dans api_keys, celui de la PERSONNE', async () => {
  const b = await monter('pages/connexions.html', {
    api: API_CNX(),
    tables: { api_keys: (req) => ({ data: req.filtres.some(f => f[1] === 'user_id' && f[2] === 'u-moi') ? { seam_api_key: 'k', seam_enabled: true } : null, error: null }) }
  })
  try {
    assert.equal(b.texte('#status-seam'), 'Connecté')
    assert.match(b.$('#status-seam').className, /out-etat--ok/)
  } finally { b.fermer() }
})

test('connexions : Beds24 connecté sans refresh token le dit', async () => {
  const b = await monter('pages/connexions.html', { api: API_CNX({ beds24: { connected: true, hasRefresh: false } }) })
  try {
    assert.equal(b.texte('#status-beds24'), 'Connecté')
    assert.equal(b.$('#token-info-beds24').hidden, false)
    assert.match(b.texte('#token-info-beds24'), /Pas de refresh token/)
  } finally { b.fermer() }
})

// ─── Abonnement (ARGENT : chaque geste vers Stripe est vérifié) ─────────────
const SUBS = (lignes) => ({
  accounts: { data: { is_beta: false }, error: null },
  subscriptions: { data: lignes, error: null }
})

test('abonnement : compte bêta — aucune offre, aucun paiement', async () => {
  const b = await monter('pages/abonnement.html', { tables: { accounts: { data: { is_beta: true }, error: null } } })
  try {
    assert.match(b.texte('#content'), /Votre compte est en bêta : aucun paiement requis/)
    assert.equal(b.$$('[data-action="start"]').length, 0)
    assert.equal(b.journal.supabase.filter(r => r.table === 'subscriptions').length, 0)
  } finally { b.fermer() }
})

test('abonnement : quatre modules, leurs prix au centime, leurs états et échéances', async () => {
  const b = await monter('pages/abonnement.html', {
    tables: SUBS([
      { module: 'guestflow', status: 'trialing', trial_ends_at: '2026-11-30T12:00:00Z', quantity: 2 },
      { module: 'serrure', status: 'past_due' }
    ])
  })
  try {
    const cartes = b.$$('#content article')
    assert.equal(cartes.length, 4)
    const [gf, men, ser, cau] = cartes.map(c => c.textContent.replace(/\s+/g, ' '))
    assert.match(gf, /GuestFlow AI/); assert.match(gf, /Requis/); assert.match(gf, /Essai gratuit/)
    assert.match(gf, /19,99\s€/); assert.match(gf, /9,90\s€\/mois par bien supplémentaire/)
    assert.match(gf, /Essai jusqu'au 30\/11\/2026/); assert.match(gf, /Quantité : 2 biens/)
    assert.match(men, /6,90\s€/); assert.match(men, /Non activé/); assert.match(men, /Démarrer mon essai gratuit/)
    assert.match(ser, /Paiement en échec/); assert.match(ser, /Mettre à jour la CB/)
    assert.match(cau, /Bientôt disponible/)
    assert.equal(cartes[3].querySelector('button').disabled, true)
    assert.equal(b.journal.supabase.find(r => r.table === 'subscriptions').filtres[0][2], 'u-moi')
  } finally { b.fermer() }
})

test('abonnement : démarrer un essai — la quantité est bornée à 1..50, le module et la quantité partent à Stripe', async () => {
  const b = await monter('pages/abonnement.html', {
    tables: SUBS([]),
    api: (u, e) => (e.corps && e.corps.action === 'create_checkout') ? { body: { url: 'https://checkout.stripe.test/s' } } : null
  })
  try {
    await b.cliquer(b.$('[data-action="start"][data-module="guestflow"]'))
    assert.ok(b.$('#qty-modal').hasAttribute('open'))
    assert.equal(b.texte('#qty-title'), 'Combien de biens ?')
    assert.match(b.texte('#qty-desc'), /19,99\s€ pour le 1er bien, 9,90\s€ par bien supplémentaire/)
    b.$('#qty-input').value = '99'
    await b.cliquer(b.$('#qty-confirm'))
    const c = b.journal.fetch.find(f => f.corps && f.corps.action === 'create_checkout')
    assert.equal(c.url, '/api/stripe?action=create_checkout')
    assert.deepEqual(c.corps, { action: 'create_checkout', module: 'guestflow', quantity: 50 })
    assert.equal(c.entetes.Authorization, 'Bearer jeton-session')
  } finally { b.fermer() }
})

test('abonnement : un refus de Stripe se dit, et le bouton revient', async () => {
  const b = await monter('pages/abonnement.html', {
    tables: SUBS([]),
    api: (u, e) => (e.corps && e.corps.action === 'create_checkout') ? { status: 400, body: { error: 'Prix introuvable' } } : null
  })
  try {
    await b.cliquer(b.$('[data-action="start"][data-module="menage"]'))
    assert.equal(b.texte('#qty-title'), 'Combien de biens ?')
    await b.cliquer(b.$('#qty-confirm'))
    assert.equal(b.texte('#banners'), 'Prix introuvable')
    assert.equal(b.$('#qty-confirm').disabled, false)
    assert.equal(b.texte('#qty-confirm'), 'Démarrer mon essai →')
    assert.equal(b.$('#qty-modal').hasAttribute('open'), false)
  } finally { b.fermer() }
})

test('abonnement : annuler demande confirmation ; sans elle, RIEN ne part', async () => {
  const b = await monter('pages/abonnement.html', {
    confirmer: false,
    tables: SUBS([{ module: 'menage', status: 'active', current_period_end: '2026-12-01T00:00:00Z', cancel_at_period_end: false }])
  })
  try {
    assert.match(b.texte('#content'), /Prochain renouvellement le 01\/12\/2026/)
    await b.cliquer(b.$('[data-action="cancel"][data-module="menage"]'))
    assert.equal(b.journal.confirmations.length, 1)
    assert.equal(b.journal.fetch.filter(f => f.url.startsWith('/api/stripe')).length, 0)
  } finally { b.fermer() }
})

test('LE TEST QUI COMPTE (ARGENT) : annuler — CE module part à Stripe, avec la session, puis l écran se relit', async () => {
  let lectures = 0
  const b = await monter('pages/abonnement.html', {
    tables: {
      accounts: { data: { is_beta: false }, error: null },
      subscriptions: () => { lectures++; return { data: [{ module: 'menage', status: 'active', current_period_end: '2026-12-01T00:00:00Z', cancel_at_period_end: false }], error: null } }
    },
    api: (u, e) => (e.corps && e.corps.action === 'cancel_subscription') ? { body: { ok: true } } : null
  })
  try {
    assert.equal(lectures, 1)
    await b.cliquer(b.$('[data-action="cancel"][data-module="menage"]'))
    assert.equal(b.journal.confirmations.length, 1)
    const c = b.journal.fetch.filter(f => f.url.startsWith('/api/stripe'))
    assert.equal(c.length, 1)
    assert.equal(c[0].url, '/api/stripe?action=cancel_subscription')
    assert.equal(c[0].methode, 'POST')
    assert.deepEqual(c[0].corps, { action: 'cancel_subscription', module: 'menage' })
    assert.equal(c[0].entetes.Authorization, 'Bearer jeton-session')
    assert.equal(b.texte('#banners'), 'Annulation enregistrée. Vous conservez l\'accès jusqu\'à la fin de la période.')
    assert.equal(lectures, 2, 'l écran ne s est pas relu après l annulation')
  } finally { b.fermer() }
})

test('LE TEST QUI COMPTE (ARGENT) : une annulation refusée par le serveur se DIT, et rien n est relu', async () => {
  const b = await monter('pages/abonnement.html', {
    tables: SUBS([{ module: 'menage', status: 'active', cancel_at_period_end: false }]),
    api: (u, e) => (e.corps && e.corps.action === 'cancel_subscription') ? { status: 409, body: { error: 'Abonnement introuvable chez Stripe' } } : null
  })
  try {
    await b.cliquer(b.$('[data-action="cancel"][data-module="menage"]'))
    assert.equal(b.texte('#banners'), 'Abonnement introuvable chez Stripe')
    assert.match(b.$('#banners p').className, /out-retour--erreur/)
    assert.equal(b.journal.supabase.filter(r => r.table === 'subscriptions').length, 1)
  } finally { b.fermer() }
})

test('LE TEST QUI COMPTE (ARGENT) : « Gérer le paiement » ouvre le PORTAIL, et rien d autre', async () => {
  const b = await monter('pages/abonnement.html', {
    tables: SUBS([{ module: 'guestflow', status: 'trialing', trial_ends_at: '2026-11-30T12:00:00Z' }]),
    api: (u, e) => (e.corps && e.corps.action === 'portal') ? { body: { url: 'https://billing.stripe.test/p' } } : null
  })
  try {
    await b.cliquer(b.$('[data-action="portal"]'))
    const c = b.journal.fetch.filter(f => f.url.startsWith('/api/stripe'))
    assert.equal(c.length, 1)
    assert.equal(c[0].url, '/api/stripe?action=portal')
    assert.deepEqual(c[0].corps, { action: 'portal' })
    assert.equal(c[0].entetes.Authorization, 'Bearer jeton-session')
    assert.equal(b.journal.navigations.length, 1, 'la page ne part pas vers le portail')
    assert.equal(b.texte('#banners'), '')
  } finally { b.fermer() }
})

test('LE TEST QUI COMPTE (ARGENT) : un portail refusé se DIT, sans navigation', async () => {
  const b = await monter('pages/abonnement.html', {
    tables: SUBS([{ module: 'serrure', status: 'past_due' }]),
    api: (u, e) => (e.corps && e.corps.action === 'portal') ? { status: 400, body: {} } : null
  })
  try {
    await b.cliquer(b.$('[data-action="portal"]'))
    assert.equal(b.texte('#banners'), 'Erreur Portal')
    assert.equal(b.journal.navigations.length, 0)
  } finally { b.fermer() }
})

test('une échéance illisible ne bloque pas la page d abonnement (constat 5)', async () => {
  const b = await monter('pages/abonnement.html', {
    tables: SUBS([{ module: 'guestflow', status: 'trialing', trial_ends_at: 'pas-une-date', quantity: 1 }])
  })
  try {
    assert.equal(b.$$('#content article').length, 4, 'la page est restée sur « Chargement… »')
    assert.ok(b.$('[data-action="portal"]'), 'les gestes sont là')
  } finally { b.fermer() }
})

test('abonnement : le retour de Stripe se dit, et l adresse est nettoyée', async () => {
  const b = await monter('pages/abonnement.html', { url: 'https://hs.test/pages/abonnement.html?success=true&module=guestflow', tables: SUBS([]) })
  try {
    assert.equal(b.texte('#banners'), 'Votre essai gratuit a démarré pour guestflow. Vous pouvez gérer vos abonnements ci-dessous.')
    assert.equal(b.w.location.pathname + b.w.location.search, '/pages/abonnement.html')
    assert.ok(!b.journal.ordre.includes('bandeau'), 'la page d abonnement ne portait pas le bandeau d incitation')
  } finally { b.fermer() }
})

test('abonnement : la déconnexion du menu ≡ vide la session d onglet AVANT de déconnecter, et « Mon compte » reste atteignable', async () => {
  const b = await monter('pages/abonnement.html', { tables: SUBS([]) })
  try {
    b.w.sessionStorage.setItem('x', '1')
    await b.cliquer(b.$('[data-menu-sortie]'))
    assert.ok(b.journal.ordre.includes('signOut'))
    assert.equal(b.journal.sessionAuMomentDeLaSortie, 0, 'la session d onglet doit être vidée avant la déconnexion')
    assert.ok(b.$$('a').some(a => a.getAttribute('href') === '/pages/compte.html' && /Mon compte/.test(a.textContent)))
  } finally { b.fermer() }
})
