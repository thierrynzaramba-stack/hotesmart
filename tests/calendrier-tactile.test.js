// tests/calendrier-tactile.test.js
//
// CONSTAT 11 — « la modification multiple fonctionne sur ordinateur mais pas
// sur portable ». Signale par Thierry le 18 octobre 2026.
//
// AU TELEPHONE, L'APPUI LONG EST LA SEULE PORTE vers une selection de
// plusieurs nuits : on presse 450 ms pour ouvrir la selection, puis on tape les
// autres dates pour l'etendre. Une review precedente avait fait annuler cet
// appui par le moindre `touchmove`, pour qu'un DEFILEMENT ne declenche pas une
// selection par accident. La garde etait juste dans son intention et trop
// stricte d'un cran : un doigt pose n'est jamais immobile.
//
// Mesure au NAVIGATEUR REEL (chrome-headless-shell, ecran 390x844, vrais
// evenements tactiles), derive progressive du doigt pendant l'appui :
//
//      0 px -> selection      10 px -> selection      20 px -> AUCUNE
//
// Sur un telephone, une case fait ~44 px et la main bouge : 20 px de derive en
// 450 ms est ordinaire. On distingue desormais le TREMBLEMENT du DEFILEMENT
// par la DISTANCE parcourue, pas par le simple fait qu'un doigt ait bouge.
// Apres correctif, meme mesure : 0, 10 et 20 px ouvrent la selection ; 30 et
// 60 px l'annulent, comme un defilement doit le faire.
//
// ⚠ ON EXECUTE LE VRAI `brancherMobile` DE LA PAGE, decoupe et evalue tel quel.
// ⚠ AUCUNE DATE FIGEE : les jours sont calcules a partir de l'horloge.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('node:vm')
const { JSDOM } = require('jsdom')

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'pages', 'calendrier.html'), 'utf8')
function bloc (debut, fin) {
  const a = PAGE.indexOf(debut)
  const b = PAGE.indexOf(fin, a)
  assert.ok(a >= 0 && b > a, `bloc introuvable dans la page : ${debut}`)
  return PAGE.slice(a, b)
}

const BIEN = 'ofuro'
const jour = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }

// Le banc tactile : quatre cases du mois, le VRAI `brancherMobile`, et des
// minuteries qu'on fait avancer a la main — l'appui long dure 450 ms, et un
// test n'attend pas une demi-seconde pour savoir ce que la page a decide.
function telephone ({ lectureSeule = false, peutEcrire = () => true } = {}) {
  const jours = [1, 2, 3, 4].map(jour)
  const dom = new JSDOM('<div data-bind="grille-mobile">'
    + jours.map(iso => `<button class="cal-case" data-case="${iso}" data-bien="${BIEN}">`
      + `<span class="cal-case__num">${iso.slice(-2)}</span></button>`).join('')
    + '</div>')
  const { window } = dom
  const minuteries = new Map(); let suivant = 1
  const journal = { rendus: 0, popups: [] }
  const ctx = {
    etat: { sel: null, lectureSeule, biens: [{ id: BIEN, name: 'Ofuro Futari' }] },
    document: window.document, window,
    $: (s) => window.document.querySelector(s),
    AUJOURDHUI: jour(0), peutEcrire,
    renderGrilleMobile: () => { journal.rendus++ }, renderFlottante: () => { journal.rendus++ },
    ouvrirPopup: (...a) => journal.popups.push(a), ouvrirFormulaire: () => {},
    reduireBien: () => {}, ouvrirFicheResa: () => {}, ouvrirFicheBlocage: () => {},
    naviguerMois: () => {}, brancherDrag: () => {},
    setTimeout: (fn, ms) => { const n = suivant++; minuteries.set(n, { fn, ms }); return n },
    clearTimeout: (n) => minuteries.delete(n),
    Math, Number, String, console
  }
  vm.createContext(ctx)
  vm.runInContext(bloc('function brancherMobile', '// ─── Écritures : save + verdicts')
    + '\nthis.brancherMobile = brancherMobile', ctx)
  ctx.brancherMobile()

  const caseDe = (k) => window.document.querySelectorAll('[data-case]')[k]
  // Le temps passe : toutes les minuteries encore vivantes se declenchent.
  const laisserPasserLeTemps = () => { for (const [n, m] of [...minuteries]) { minuteries.delete(n); m.fn() } }
  const toucher = (el, type, x, y) => {
    const ev = new window.Event(type, { bubbles: true })
    ev.touches = (type === 'touchend' || type === 'touchcancel') ? [] : [{ clientX: x, clientY: y }]
    el.dispatchEvent(ev)
  }
  // L'appui long, avec une derive de `derive` pixels pendant la pression.
  const appuiLong = (k, derive = 0) => {
    const el = caseDe(k)
    toucher(el, 'touchstart', 100, 300)
    if (derive) toucher(el, 'touchmove', 100 + derive, 300)
    laisserPasserLeTemps()
    toucher(el, 'touchend', 0, 0)
    // ⚠ FIDELITE AU NAVIGATEUR : un appui long emet quand meme un `click` en
    // relachant. La page l'avale (`if (long) { long = false; return }`) — et
    // c'est ce click avale qui remet le drapeau a zero pour le tap SUIVANT.
    // Sans lui, le harnais retenait le premier tap d'extension et faisait
    // croire a un defaut qui n'existe pas.
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    return el
  }
  const tap = (k) => { const el = caseDe(k); el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); return el }
  return { ctx, journal, jours, caseDe, appuiLong, tap, toucher, laisserPasserLeTemps,
    selection: () => ctx.etat.sel }
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSTAT 11 : la derive d'un doigt ne doit pas tuer l'appui long
// ═══════════════════════════════════════════════════════════════════════════

test('CONSTAT 11 : un doigt qui tremble ouvre quand meme la selection', () => {
  // Mesure au navigateur reel AVANT correctif : 20 px suffisaient a la perdre.
  for (const derive of [0, 5, 10, 20, 24]) {
    const t = telephone()
    t.appuiLong(0, derive)
    assert.ok(t.selection(), `derive de ${derive} px : l'appui long doit tenir`)
    assert.strictEqual(t.selection().duIso, t.jours[0])
    assert.strictEqual(t.selection().bien, BIEN)
  }
})

test('CONSTAT 11 : un vrai DEFILEMENT annule toujours l\'appui long', () => {
  // La raison d'etre de la garde d'origine : faire defiler la page ne doit
  // jamais ouvrir une selection par surprise.
  for (const derive of [25, 40, 120]) {
    const t = telephone()
    t.appuiLong(0, derive)
    assert.strictEqual(t.selection(), null, `derive de ${derive} px : c'est un defilement`)
  }
})

test('CONSTAT 11 : la derive se mesure en DISTANCE, pas sur un seul axe', () => {
  // Un defilement vertical doit annuler meme si l'ecart horizontal est nul.
  const t = telephone()
  const el = t.caseDe(0)
  t.toucher(el, 'touchstart', 100, 300)
  t.toucher(el, 'touchmove', 100, 360)      // 60 px vers le bas
  t.laisserPasserLeTemps()
  assert.strictEqual(t.selection(), null, 'un defilement vertical annule aussi')
})

test('un touchmove sans point lisible garde l\'ancienne prudence : il annule', () => {
  const t = telephone()
  const el = t.caseDe(0)
  t.toucher(el, 'touchstart', 100, 300)
  const ev = new t.ctx.window.Event('touchmove', { bubbles: true })
  ev.touches = []                            // aucun doigt lisible
  el.dispatchEvent(ev)
  t.laisserPasserLeTemps()
  assert.strictEqual(t.selection(), null)
})

// ═══════════════════════════════════════════════════════════════════════════
// CE QUI NE DOIT PAS AVOIR CHANGE
// ═══════════════════════════════════════════════════════════════════════════

test('la selection s\'etend en tapant les dates suivantes', () => {
  const t = telephone()
  t.appuiLong(0)
  t.tap(3)
  assert.strictEqual(t.selection().duIso, t.jours[0])
  assert.strictEqual(t.selection().auIso, t.jours[3], 'quatre nuits')
})

test('un tap seul, sans appui long, ouvre la fenetre de configuration', () => {
  const t = telephone()
  t.tap(2)
  assert.strictEqual(t.selection(), null, 'aucune selection ouverte')
  assert.strictEqual(t.journal.popups.length, 1)
  assert.strictEqual(t.journal.popups[0][0][0], t.jours[2], 'pre-remplie sur le jour tape')
})

test('touchend et touchcancel annulent l\'appui long', () => {
  for (const fin of ['touchend', 'touchcancel']) {
    const t = telephone()
    const el = t.caseDe(0)
    t.toucher(el, 'touchstart', 100, 300)
    t.toucher(el, fin, 0, 0)
    t.laisserPasserLeTemps()
    assert.strictEqual(t.selection(), null, `${fin} doit annuler`)
  }
})

test('les gardes tiennent : lecture seule, sans droit, jour passe', () => {
  const seule = telephone({ lectureSeule: true })
  seule.appuiLong(0)
  assert.strictEqual(seule.selection(), null, 'lecture seule')

  const sansDroit = telephone({ peutEcrire: () => false })
  sansDroit.appuiLong(0)
  assert.strictEqual(sansDroit.selection(), null, 'sans le droit reservations')

  // Un jour passe : la case porte une date anterieure a aujourd'hui.
  const t = telephone()
  t.caseDe(0).dataset.case = jour(-5)
  const t2 = telephone()
  t2.ctx.AUJOURDHUI = jour(10)              // tout l'ecran est dans le passe
  t2.appuiLong(0)
  assert.strictEqual(t2.selection(), null, 'jour passe')
})
