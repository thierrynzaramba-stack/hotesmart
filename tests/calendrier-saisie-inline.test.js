// tests/calendrier-saisie-inline.test.js
//
// CONSTAT 8 — « on ne peut pas modifier directement le prix ».
//
// Signale par Thierry le 18 octobre 2026, en recette sur la preview, ecran
// ORDINATEUR : la selection se fait, la barre d'actions sort, le champ de
// saisie s'ouvre — et il est impossible d'y taper un prix.
//
// LA CAUSE. La cellule porte un raccourci clavier qui OUVRE la saisie inline
// (Entree / F2 / un chiffre, regle A.5). Une fois le champ ouvert, il vit DANS
// cette cellule : chaque frappe y remontait par bouillonnement, et le raccourci
// se redeclenchait. Il annulait la touche (`preventDefault`) puis rappelait
// `actionPrix`, qui reconstruisait le champ avec la SEULE touche frappee.
// Taper « 150 » laissait « 0 » — chaque chiffre effacait le precedent — et
// « Entree » etait annulee de la meme facon, donc rien ne s'enregistrait
// jamais. Mesure avant correctif : 3 frappes annulees sur 3, 0 enregistrement.
//
// ⚠ UN RACCOURCI QUI OUVRE UN CHAMP NE DOIT PAS PILOTER CE CHAMP. C'est la
// regle que ce fichier garde, dans les deux sens : les frappes du champ lui
// appartiennent, et celles de la cellule continuent d'ouvrir la saisie.
//
// ⚠ ON EXECUTE LE VRAI CODE DE LA PAGE : `brancherPlanning` et `actionPrix`
// sont decoupes dans pages/calendrier.html et evalues tels quels. Une copie
// resterait verte pendant que la page refuse les frappes — c'est exactement ce
// qui etait arrive aux tests du constat 7 (voir leur en-tete).
//
// ⚠ AUCUNE DATE ICI : ce fichier ne lit pas l'horloge.

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

const ISO = '2026-12-10'

// Une cellule de la ligne Prix, branchee par le VRAI `brancherPlanning`.
function cellule ({ lectureSeule = false, peutEcrire = () => true, iso = ISO } = {}) {
  const dom = new JSDOM('<div data-bind="grilles"><table><tr data-ligne-prix>'
    + `<td class="cal-nuit" data-bien="ofuro" data-i="0" data-iso="${iso}">—</td>`
    + '</tr></table></div>')
  const { window } = dom
  const td = window.document.querySelector('.cal-nuit')
  const journal = { segments: null, popup: 0, toasts: [] }
  const ctx = {
    etat: { sel: { bien: 'ofuro', a: 0, b: 0 }, biens: [{ id: 'ofuro', base_price: null }],
      vueMobile: 'rate', lectureSeule, states: { ofuro: { [iso]: { rate: null } } }, inv: {} },
    document: window.document, window, CSS: { escape: (v) => String(v) },
    $: (s) => window.document.querySelector(s),
    AUJOURDHUI: '2026-01-01', esc: (s) => String(s), estLarge: () => true,
    peutEcrire, toast: (m) => journal.toasts.push(m), t: (k) => k,
    ouvrirPopup: () => { journal.popup++ },
    saveAvecAnnulation: (_id, segs) => { journal.segments = segs },
    viderSelection: () => {}, joursSelection: () => [iso], brancherDrag: () => {},
    peindreSelectionDesktop: () => {}, reduireBien: () => {}, ouvrirFicheResa: () => {},
    ouvrirFicheBlocage: () => {}, renderFlottante: () => {},
    Number, String, console
  }
  vm.createContext(ctx)
  vm.runInContext(bloc('function brancherPlanning', '// La navigation de mois')
    + '\n' + bloc('function actionPrix', '// Fermer / Rouvrir a la vente')
    + '\nthis.brancherPlanning = brancherPlanning; this.actionPrix = actionPrix', ctx)
  ctx.brancherPlanning()

  const frappe = (cible, key) => {
    const ev = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    cible.dispatchEvent(ev)
    return ev
  }
  const clic = (cible) => {
    const ev = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true })
    cible.dispatchEvent(ev)
    return ev
  }
  return { ctx, td, journal, frappe, clic, champ: () => td.querySelector('input') }
}

// ═══════════════════════════════════════════════════════════════════════════
// LE CONSTAT : taper un prix dans le champ ouvert
// ═══════════════════════════════════════════════════════════════════════════

test('CONSTAT 8 : les frappes DANS le champ ne sont plus annulees ni avalees', () => {
  const c = cellule()
  c.ctx.actionPrix([ISO])
  assert.ok(c.champ(), 'le bouton « Prix » ouvre bien un champ')

  for (const touche of ['1', '5', '0']) {
    const avant = c.champ()
    const ev = c.frappe(avant, touche)
    assert.strictEqual(ev.defaultPrevented, false,
      `la touche « ${touche} » doit atteindre le champ, pas etre annulee par la cellule`)
    assert.strictEqual(c.champ(), avant,
      `la touche « ${touche} » ne doit pas reconstruire le champ (le chiffre precedent serait perdu)`)
  }
})

test('CONSTAT 8 : « Entree » dans le champ enregistre le prix tape', () => {
  const c = cellule()
  c.ctx.actionPrix([ISO])
  c.champ().value = '150'          // ce que l'hote vient de taper
  const ev = c.frappe(c.champ(), 'Enter')

  assert.strictEqual(ev.defaultPrevented, false, '« Entree » ne doit pas etre annulee par la cellule')
  assert.ok(c.journal.segments, 'un enregistrement doit partir')
  assert.strictEqual(c.journal.segments.length, 1)
  assert.strictEqual(c.journal.segments[0].rate, 150)
  assert.strictEqual(c.journal.segments[0].date_from, ISO)
  assert.strictEqual(c.champ(), null, 'et le champ se referme')
})

test('CONSTAT 8 : « Echap » referme sans rien enregistrer', () => {
  const c = cellule()
  c.ctx.actionPrix([ISO])
  c.champ().value = '150'
  c.frappe(c.champ(), 'Escape')

  assert.strictEqual(c.journal.segments, null, 'rien ne part : l\'hote a renonce')
  assert.strictEqual(c.champ(), null, 'le champ se referme quand meme')
})

test('CONSTAT 8 : un clic DANS le champ ne replie plus la selection', () => {
  // `mousedown` sur la cellule fait `preventDefault()` — c'est ce qui permet le
  // cliquer-glisser sans selection de texte. Un clic dans le champ en heritait
  // par bouillonnement : le champ ne recevait jamais la mise au point, et la
  // selection retombait sur un seul jour.
  const c = cellule()
  c.ctx.etat.sel = { bien: 'ofuro', a: 0, b: 3 }   // quatre nuits selectionnees
  c.ctx.actionPrix([ISO])
  const ev = c.clic(c.champ())

  assert.strictEqual(ev.defaultPrevented, false, 'le clic doit atteindre le champ')
  assert.deepStrictEqual({ a: c.ctx.etat.sel.a, b: c.ctx.etat.sel.b }, { a: 0, b: 3 },
    'la selection des quatre nuits doit tenir')
})

// ═══════════════════════════════════════════════════════════════════════════
// CE QUI NE DOIT PAS AVOIR CHANGE : le raccourci de la CELLULE (regle A.5)
// ═══════════════════════════════════════════════════════════════════════════

test('un chiffre tape sur la CELLULE ouvre toujours la saisie, amorcee par ce chiffre', () => {
  const c = cellule()
  const ev = c.frappe(c.td, '7')
  assert.strictEqual(ev.defaultPrevented, true, 'la touche sert a ouvrir, elle ne s\'ecrit pas deux fois')
  assert.strictEqual(c.champ().value, '7', 'le chiffre frappe amorce la saisie')
})

test('« Entree » et « F2 » sur la CELLULE ouvrent toujours la saisie, vide', () => {
  for (const touche of ['Enter', 'F2']) {
    const c = cellule()
    c.frappe(c.td, touche)
    assert.ok(c.champ(), `« ${touche} » doit ouvrir la saisie`)
    assert.strictEqual(c.champ().value, '', 'sans rien amorcer')
  }
})

test('un clic sur la CELLULE demarre toujours la selection', () => {
  const c = cellule()
  const ev = c.clic(c.td)
  assert.strictEqual(ev.defaultPrevented, true,
    'le cliquer-glisser a besoin de ce preventDefault (pas de selection de texte)')
  assert.deepStrictEqual({ a: c.ctx.etat.sel.a, b: c.ctx.etat.sel.b }, { a: 0, b: 0 })
})

test('les gardes de la cellule tiennent : lecture seule et jour passe', () => {
  const seule = cellule({ lectureSeule: true })
  seule.frappe(seule.td, '7')
  assert.strictEqual(seule.champ(), null, 'lecture seule : aucune saisie')

  const sansDroit = cellule({ peutEcrire: () => false })
  sansDroit.frappe(sansDroit.td, '7')
  assert.strictEqual(sansDroit.champ(), null, 'sans le droit « reservations » : aucune saisie')

  const passe = cellule({ iso: '2020-01-01' })
  passe.frappe(passe.td, '7')
  assert.strictEqual(passe.champ(), null, 'jour passe : aucune saisie')
})
