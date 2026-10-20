// tests/logements-page-dom.test.js — LE COMPORTEMENT DE LA PAGE /logements.
//
// ⚠ CE FICHIER EXISTE PARCE QUE SIX MUTATIONS SURVIVAIENT. La revue du
// 20 octobre 2026 a mesuré que `tests/logements-liste-dom.test.js` couvre bien
// le MODULE de rendu, mais que la PAGE n'était vérifiée que par trois
// assertions de chaîne sur son source. Résultat : inverser la garde de droit
// (`ajouter.hidden = estTitulaire()`), transformer une panne en « vide »,
// dé-câbler « Réessayer » ou laisser `aria-busy` à vie ne faisait rougir RIEN.
//
// On extrait donc les fonctions de la page telles qu'elles sont écrites — comme
// `tests/canaux-bouton-actualiser.test.js` le fait pour /biens — et on les
// exerce. Les redéclarer ici en ferait des copies, et le test resterait vert le
// jour où la page les perdrait.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const FICHIER = path.join(__dirname, '..', 'pages', 'logements.html')
const PAGE = fs.readFileSync(FICHIER, 'utf8')

// Extrait une fonction de la page en comptant ses accolades. Le `async` fait
// partie de la déclaration : le perdre rendrait ses `await` incompilables.
function fonctionDeLaPage (nom) {
  let debut = PAGE.indexOf(`function ${nom} (`)
  assert.notEqual(debut, -1, `${nom} introuvable dans pages/logements.html`)
  if (PAGE.slice(Math.max(0, debut - 6), debut) === 'async ') debut -= 6
  let p = 0
  for (let j = PAGE.indexOf('{', debut); j < PAGE.length; j++) {
    if (PAGE[j] === '{') p++
    else if (PAGE[j] === '}') { p--; if (p === 0) return PAGE.slice(debut, j + 1) }
  }
  throw new Error(`accolades non refermées pour ${nom}`)
}

function ligneDeLaPage (motif, etiquette) {
  const m = PAGE.match(motif)
  assert.ok(m, `${etiquette} introuvable dans pages/logements.html`)
  return m[0].trim()
}

// Le squelette réel de la page : on prend son `<main>` tel quel, pour qu'un
// `data-bind` renommé dans la page fasse rougir le test.
const MAIN = PAGE.slice(PAGE.indexOf('<main'), PAGE.indexOf('</main>') + 7)

// La garde de droit du bouton d'ajout, telle qu'elle est écrite.
const GARDE_AJOUT = ligneDeLaPage(/^\s*if \(ajouter\) ajouter\.hidden = .*$/m, 'la garde du bouton d ajout')

let M
test.before(async () => { M = await import('../shared/logements-liste.js') })

function monter ({ reponse = null, erreur = null, titulaire = true } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head><style>[hidden]{display:none !important}</style></head>
    <body>${MAIN}</body></html>`, { pretendToBeVisual: true })
  const { window } = dom
  const etat = { appels: 0, focus: null }

  // Les outils de la page, dans leur version réelle quand c'est possible.
  const I18n = {
    lang: 'fr',
    t: (k, v = {}) => `[${k}]${Object.entries(v).map(([a, b]) => `${a}=${b}`).join(',')}`,
    date: (d, o) => `EN-CLAIR(${d.toISOString().slice(0, 10)}${o && o.year ? '+an' : ''})`,
    // ⚠ `num` EXISTE DANS LE VRAI MOTEUR, et le double doit l'avoir : sans lui,
    // le repli `String(x)` de la page rendait « 4.9 » et le test mesurait son
    // propre double, pas la page.
    num: (x, o) => new Intl.NumberFormat('fr', o).format(x),
    apply: () => {}
  }
  const api = { logement: { liste: async () => { etat.appels++; if (erreur) throw erreur; return reponse } } }
  const logger = { error: () => {}, info: () => {} }
  const contexte = {
    window, document: window.document, I18n, api, logger,
    // ⚠ L'HORLOGE DU TEST, PAS CELLE DU REALM `vm`. `vm.createContext` cree un
    // TROISIEME realm, avec son propre `Date` : le code de la page y lisait une
    // horloge differente de celle des fixtures, et la contre-epreuve calendaire
    // rendait un faux rouge a J+180.
    //
    // ⚠ ET C'EST LE `Date` DE NODE, PAS `window.Date`. Mon premier correctif
    // passait celui de la fenetre jsdom — qui est DEJA le global de Node, que
    // `tests/outils/horloge-decalee.js` patche a la construction : il etait donc
    // decale DEUX FOIS, et le faux rouge se deplaçait a J+60 au lieu de
    // disparaitre. Une horloge pour tout le monde, celle que le test lit.
    Date,
    estTitulaire: () => titulaire,
    carteHtml: M.carteHtml, etatHtml: M.etatHtml, etatDeLaPage: M.etatDeLaPage,
    fraicheurDuCompte: M.fraicheurDuCompte,
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    icone: (id, cls = 'icon') => `<svg class="${cls}" data-icone="${id}"></svg>`,
    etatTest: etat
  }

  const source = `
    const t = (k, v) => I18n.t(k, v)
    const $ = (s) => document.querySelector(s)
    ${fonctionDeLaPage('dateEnClair')}
    ${ligneDeLaPage(/^\s*const nombre = .*$/m, 'le formateur de nombre')}
    ${ligneDeLaPage(/^\s*const OUTILS = .*$/m, 'les outils du rendu')}
    ${fonctionDeLaPage('montrerEtat')}
    ${fonctionDeLaPage('montrerFraicheur')}
    ${ligneDeLaPage(/^let enVol = .*$/m, 'le verrou enVol')}
    ${fonctionDeLaPage('charger')}
    globalThis.__charger = charger
    globalThis.__montrerEtat = montrerEtat
    globalThis.__dateEnClair = dateEnClair
    globalThis.__gardeAjout = (ajouter) => { ${GARDE_AJOUT} }
  `
  const vm = require('node:vm')
  vm.createContext(contexte)
  vm.runInContext(source, contexte)
  return { window, doc: window.document, ctx: contexte, etat }
}

const bien = (extra = {}) => ({
  id: 'b1', nom: 'La bulle', ville: 'Bagnères', capacite: 2, photo_url: null,
  assistant_en_pause: false, canaux_echec: false, canaux: [{ ota: 'airbnb', mappe: true, actif: true }],
  canaux_vu_le: new Date().toISOString(),
  fait_date: { type: 'occupe', du: null, au: '2026-10-22' },
  avis: { total: 336, notes: 332, note_sur_5: 4.9 }, ...extra
})

// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE (MU-A) : la garde du bouton d ajout n est pas INVERSÉE', async () => {
  // La mutation qui survivait : `ajouter.hidden = estTitulaire()` au lieu de
  // `!estTitulaire()`. L ancien test ne cherchait que la CHAÎNE `estTitulaire()`
  // dans le fichier — inverser la condition la laissait intacte.
  const titulaire = monter({ titulaire: true, reponse: { biens: [bien()] } })
  const bouton1 = titulaire.doc.querySelector('[data-bind="ajouter"]')
  titulaire.ctx.__gardeAjout(bouton1)
  assert.equal(bouton1.hidden, false, 'le titulaire doit voir le bouton')

  const membre = monter({ titulaire: false, reponse: { biens: [bien()] } })
  const bouton2 = membre.doc.querySelector('[data-bind="ajouter"]')
  membre.ctx.__gardeAjout(bouton2)
  assert.equal(bouton2.hidden, true, 'un membre délégué ne doit pas se voir proposer la création')
  // Et le masquage MORD vraiment : la feuille du DOM de test porte la règle.
  assert.equal(membre.window.getComputedStyle(bouton2).display, 'none')
})

test('LE TEST QUI COMPTE (MU-B) : une PANNE n affiche jamais « Ajoutez votre premier logement »', async () => {
  const { doc, ctx } = monter({ erreur: Object.assign(new Error('boom'), { status: 503 }) })
  await ctx.__charger()
  const zone = doc.querySelector('[data-bind="etat"]')
  assert.equal(zone.hidden, false)
  const cles = [...zone.querySelectorAll('[data-i18n]')].map(x => x.dataset.i18n)
  assert.ok(cles.includes('logements.panne'))
  assert.ok(!cles.includes('logements.vide_titre'),
    'un hôte qui a quatre logements lirait qu il n en a aucun')
  assert.ok(zone.querySelector('[data-bind="reessayer"]'))
})

test('un REFUS de droit se distingue d une panne, et ne propose pas de réessayer', async () => {
  const { doc, ctx } = monter({ erreur: Object.assign(new Error('nope'), { status: 403 }) })
  await ctx.__charger()
  const zone = doc.querySelector('[data-bind="etat"]')
  assert.deepEqual([...zone.querySelectorAll('[data-i18n]')].map(x => x.dataset.i18n), ['logements.refus'])
  assert.equal(zone.querySelector('[data-bind="reessayer"]'), null)
})

test('LE TEST QUI COMPTE : l état VIDE ne propose rien à un membre délégué', async () => {
  // Les deux actions mènent à des pages NON DÉLÉGABLES et à un POST refusé
  // en 403. « On ne montre jamais ce qui mène à un refus. »
  const membre = monter({ titulaire: false, reponse: { biens: [] } })
  await membre.ctx.__charger()
  const zoneM = membre.doc.querySelector('[data-bind="etat"]')
  assert.equal(zoneM.querySelectorAll('a').length, 0)
  assert.ok([...zoneM.querySelectorAll('[data-i18n]')].map(x => x.dataset.i18n)
    .includes('logements.vide_aide_membre'))

  const titulaire = monter({ titulaire: true, reponse: { biens: [] } })
  await titulaire.ctx.__charger()
  const liens = [...titulaire.doc.querySelectorAll('[data-bind="etat"] a')].map(a => a.getAttribute('href'))
  assert.deepEqual(liens, ['/pages/connexions', '/biens/nouveau'])
})

test('LE TEST QUI COMPTE (MU-D) : « Réessayer » rappelle la lecture, et prend le focus', async () => {
  const { doc, ctx, etat } = monter({ erreur: Object.assign(new Error('boom'), { status: 503 }) })
  await ctx.__charger()
  assert.equal(etat.appels, 1)
  const bouton = doc.querySelector('[data-bind="reessayer"]')
  assert.equal(doc.activeElement, bouton, 'sans ça, le clavier repart du début du document')
  bouton.click()
  await new Promise(r => setTimeout(r, 0))
  assert.equal(etat.appels, 2, 'le bouton doit être CÂBLÉ, pas seulement affiché')
})

test('LE TEST QUI COMPTE (MU-F) : la grille ne reste pas « occupée » à vie', async () => {
  const { doc, ctx } = monter({ reponse: { biens: [bien()] } })
  const grille = doc.querySelector('[data-bind="grille"]')
  assert.equal(grille.getAttribute('aria-busy'), 'true', 'au départ, elle est occupée')
  await ctx.__charger()
  assert.equal(grille.hasAttribute('aria-busy'), false)
  assert.equal(doc.querySelector('[data-bind="chargement"]').hidden, true)
  // Et sur une panne aussi : un écran en erreur n est pas un écran qui charge.
  const panne = monter({ erreur: Object.assign(new Error('x'), { status: 503 }) })
  await panne.ctx.__charger()
  assert.equal(panne.doc.querySelector('[data-bind="grille"]').hasAttribute('aria-busy'), false)
  assert.equal(panne.doc.querySelector('[data-bind="chargement"]').hidden, true)
})

test('LE TEST QUI COMPTE (MU-C) : la date est en toutes lettres, jamais l ISO brut', async () => {
  const { ctx } = monter({})
  const rendu = ctx.__dateEnClair('2026-10-22')
  assert.match(rendu, /^EN-CLAIR\(/, 'la page doit passer par I18n.date')
  assert.notEqual(rendu, '2026-10-22')
  // Une date d une autre année porte l année ; celle de cette année non.
  const cetteAnnee = new Date().getFullYear()
  assert.doesNotMatch(ctx.__dateEnClair(`${cetteAnnee}-06-15`), /\+an/)
  assert.match(ctx.__dateEnClair(`${cetteAnnee + 2}-06-15`), /\+an/)
  // Une entrée vide ou invalide ne casse pas la carte.
  assert.equal(ctx.__dateEnClair(null), '')
  assert.equal(ctx.__dateEnClair('pas-une-date'), 'pas-une-date')
})

test('LE TEST QUI COMPTE : la fraîcheur se dit UNE FOIS, en haut, jamais sur les cartes', async () => {
  const vieux = new Date(Date.now() - 30 * 3600 * 1000).toISOString()
  const { doc, ctx } = monter({ reponse: { biens: [
    bien({ canaux_vu_le: new Date().toISOString() }),
    bien({ id: 'b2', nom: 'Cœur de vie 23', canaux_vu_le: vieux })
  ] } })
  await ctx.__charger()
  const zone = doc.querySelector('[data-bind="fraicheur"]')
  assert.equal(zone.hidden, false)
  // ⚠ LA PLUS ANCIENNE décide : montrer la plus récente ferait passer pour
  // frais un relevé dont la moitié date.
  assert.match(zone.textContent, /logements\.fraicheur_vieille/)
  assert.ok(zone.classList.contains('log-fraicheur--vieille'))
  assert.equal(doc.querySelectorAll('[data-bind="fraicheur"]').length, 1)
  // Et aucune carte ne porte le signal d échec du relevé.
  assert.equal(doc.querySelectorAll('.log-carte [data-signal]').length, 0)
})

test('un relevé récent se dit au présent, sans alarme', async () => {
  const { doc, ctx } = monter({ reponse: { biens: [bien()] } })
  await ctx.__charger()
  const zone = doc.querySelector('[data-bind="fraicheur"]')
  assert.match(zone.textContent, /logements\.fraicheur\]/)
  assert.equal(zone.classList.contains('log-fraicheur--vieille'), false)
})

test('aucune date de relevé : on ne dit rien, plutôt que de dire faux', async () => {
  const { doc, ctx } = monter({ reponse: { biens: [bien({ canaux_vu_le: null })] } })
  await ctx.__charger()
  assert.equal(doc.querySelector('[data-bind="fraicheur"]').hidden, true)
})

test('la liste s affiche, et le verrou empêche deux lectures en vol', async () => {
  const { doc, ctx, etat } = monter({ reponse: { biens: [bien(), bien({ id: 'b2', nom: 'Cœur de vie 23' })] } })
  await Promise.all([ctx.__charger(), ctx.__charger()])
  assert.equal(etat.appels, 1, 'le verrou `enVol` doit tenir')
  assert.equal(doc.querySelectorAll('.log-carte').length, 2)
  assert.equal(doc.querySelector('[data-bind="etat"]').hidden, true)
})

test('une réponse mal formée est une PANNE, pas un compte vide', async () => {
  const { doc, ctx } = monter({ reponse: { biens: { pas: 'un tableau' } } })
  await ctx.__charger()
  const cles = [...doc.querySelectorAll('[data-bind="etat"] [data-i18n]')].map(x => x.dataset.i18n)
  assert.ok(cles.includes('logements.panne'))
})

// ═══════════════════════════════════════════════════════════════════════════
// Les avis sur la page (demande de Thierry, 20 octobre 2026)
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : la carte rend la note et le nombre d avis, pas le fait daté', async () => {
  const { doc, ctx } = monter({ reponse: { biens: [bien()], indisponibles: [], refuses: [] } })
  await ctx.__charger()
  const carte = doc.querySelector('.log-carte')
  assert.ok(carte.querySelector('.log-avis'), 'la ligne des avis est rendue')
  assert.equal(carte.querySelector('[data-fait]'), null, 'le fait daté a quitté la carte')
  // `I18n.t` est ici un double qui rend `[clé]var=valeur` : on lit les VALEURS
  // passées, ce qui prouve la note sur 5 et le total — pas une chaîne de hasard.
  assert.match(carte.querySelector('.log-avis').textContent, /logements\.avis\].*n=336/)
  assert.match(carte.querySelector('.log-avis').textContent, /note=4,9/,
    'la note est divisée par deux ET formatée dans la langue de l hôte')
})

test('LE TEST QUI COMPTE (MU) : avis non lus => la page passe le drapeau, et la carte le DIT', async () => {
  // La mutation qui doit rougir : ne pas passer `avisIndisponibles`. La carte
  // tomberait alors dans le cas « refus » et n afficherait RIEN — une panne
  // silencieuse, là où l hôte doit savoir que la note manque.
  const { doc, ctx } = monter({
    reponse: { biens: [bien({ avis: null })], indisponibles: ['avis'], refuses: [] }
  })
  await ctx.__charger()
  const ligne = doc.querySelector('.log-avis')
  assert.ok(ligne, 'une panne de lecture se dit')
  assert.equal(ligne.dataset.avis, 'inconnu')
})

test('LE TEST QUI COMPTE (SECURITE) : un bloc REFUSE n est pas rendu du tout', async () => {
  // Règle de Thierry du 20 octobre : « on ne montre jamais ce qui mène à un
  // refus. Le JSON peut le porter, l écran le cache. »
  const { doc, ctx } = monter({
    reponse: { biens: [bien({ avis: null })], indisponibles: [], refuses: ['avis'] }
  })
  await ctx.__charger()
  // ⚠ LA CARTE DOIT EXISTER. Sans cette ligne, le test etait VERT quand la
  // grille entiere etait vide — et c'est exactement ce qui est arrive : passer
  // `null` a `I18n.t` faisait tomber la liste en « panne », et l'assertion
  // « pas de ligne d'avis » restait verte pour la pire des raisons.
  assert.ok(doc.querySelector('.log-carte'), 'la carte est rendue')
  assert.equal(doc.querySelector('.log-avis'), null)
  assert.doesNotMatch(doc.querySelector('.log-carte').textContent, /avis/i)
})

test('les zones de la grille au téléphone ne dépendent pas de la POSITION des enfants', async () => {
  // La ligne des avis DISPARAÎT sur un refus : un `:nth-child(4)` ferait alors
  // prendre la zone des avis par le signal, et la carte se décalerait.
  const style = PAGE.slice(PAGE.indexOf('@media (max-width: 560px)'))
  assert.doesNotMatch(style, /:nth-child\(\d\)\s*\{\s*grid-area/,
    'une zone de grille se désigne par classe, jamais par position')
  for (const classe of ['log-photo', 'log-texte', 'log-canaux', 'log-avis', 'log-signal-ligne']) {
    assert.match(style, new RegExp(`\\.${classe} \\{ grid-area:`), `${classe} doit porter sa zone`)
  }
})
