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

// ⚠ LA CELLULE DU TEST EST CELLE DU PRODUIT, ENFANTS COMPRIS.
// La premiere version de ce fichier posait un `<td>` au contenu textuel nu.
// `grilleBien` n'en produit JAMAIS : il met toujours un `<span
// class="cal-nuit__prix">`, et parfois l'icone « nuit orpheline ». C'est ce
// confort qui a laisse passer un correctif fautif — une garde `e.target !== td`
// cote cellule, qui tuait 25 a 36 % de la surface cliquable (les chiffres, en
// plein centre). REVIEW.md regle 8 : tester le cas dangereux, pas sa version
// confortable.
const CELLULE_REELLE = (iso, { orpheline = false } = {}) =>
  `<td class="cal-nuit cal-nuit--ouverte" data-bien="ofuro" data-i="0" data-iso="${iso}">`
  + (orpheline ? '<span class="cal-orpheline" title="x"><svg class="icon"><use href="#i-alert"/></svg></span>' : '')
  + '<span class="cal-nuit__prix">—</span></td>'

// Une cellule de la ligne Prix, branchee par le VRAI `brancherPlanning`.
function cellule ({ lectureSeule = false, peutEcrire = () => true, iso = ISO, orpheline = false } = {}) {
  const dom = new JSDOM('<div data-bind="grilles"><table><tr data-ligne-prix>'
    + CELLULE_REELLE(iso, { orpheline })
    + '</tr></table></div>')
  const { window } = dom
  const td = window.document.querySelector('.cal-nuit')
  const journal = { segments: null, popup: 0, toasts: [] }
  const ctx = {
    etat: { sel: null, biens: [{ id: 'ofuro', base_price: null }],
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
  return { ctx, td, journal, frappe, clic, dom,
    champ: () => td.querySelector('input'),
    prix: () => td.querySelector('.cal-nuit__prix'),
    alerte: () => td.querySelector('.cal-orpheline .icon') }
}

// ═══════════════════════════════════════════════════════════════════════════
// LE CONSTAT : taper un prix dans le champ ouvert
// ═══════════════════════════════════════════════════════════════════════════

test('CONSTAT 8 : les frappes DANS le champ ne sont plus annulees ni avalees', () => {
  const c = cellule()
  c.ctx.etat.sel = { bien: 'ofuro', a: 0, b: 0 }
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
  c.ctx.etat.sel = { bien: 'ofuro', a: 0, b: 0 }
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
  c.ctx.etat.sel = { bien: 'ofuro', a: 0, b: 0 }
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

// ═══════════════════════════════════════════════════════════════════════════
// LA REGRESSION QUE LE PREMIER CORRECTIF AVAIT INTRODUITE (review du commit)
// ═══════════════════════════════════════════════════════════════════════════

test('un clic SUR LE PRIX demarre la selection, comme sur le reste de la case', () => {
  // Le defaut qu'ils ferment : une garde `e.target !== td` posee sur la cellule
  // rendait la main des que le clic visait le `<span>` des chiffres — soit le
  // centre de la case, la ou le curseur va. Mesure : 25 a 36 % de la surface
  // devenue morte, selon la longueur du prix affiche.
  const c = cellule()
  const ev = c.clic(c.prix())
  assert.strictEqual(ev.defaultPrevented, true, 'le cliquer-glisser doit demarrer')
  assert.deepStrictEqual({ a: c.ctx.etat.sel.a, b: c.ctx.etat.sel.b }, { a: 0, b: 0 })
})

test('un clic sur l\'icone « nuit orpheline » demarre la selection aussi', () => {
  const c = cellule({ orpheline: true })
  const ev = c.clic(c.alerte())
  assert.strictEqual(ev.defaultPrevented, true)
  assert.deepStrictEqual({ a: c.ctx.etat.sel.a, b: c.ctx.etat.sel.b }, { a: 0, b: 0 })
})

test('la lecture seule refuse AUSSI le clic, pas seulement les frappes', () => {
  // Trou releve en review : retirer la garde `lectureSeule` du `mousedown` ne
  // faisait rougir aucun test EXECUTANT — seulement une expression reguliere
  // sur le texte du fichier (tests/lecture-seule.test.js:84).
  for (const cible of ['td', 'prix']) {
    const seule = cellule({ lectureSeule: true })
    seule.clic(cible === 'td' ? seule.td : seule.prix())
    assert.strictEqual(seule.ctx.etat.sel, null, `lecture seule : aucune selection (${cible})`)

    const sansDroit = cellule({ peutEcrire: () => false })
    sansDroit.clic(cible === 'td' ? sansDroit.td : sansDroit.prix())
    assert.strictEqual(sansDroit.ctx.etat.sel, null, `sans droit : aucune selection (${cible})`)

    const passe = cellule({ iso: '2020-01-01' })
    passe.clic(cible === 'td' ? passe.td : passe.prix())
    assert.strictEqual(passe.ctx.etat.sel, null, `jour passe : aucune selection (${cible})`)
  }
})

test('le harnais rend bien ce que la page rend : le prix est un ENFANT de la case', () => {
  // ⚠ CE TEST LIT LA SOURCE, et c'est son role : il garde la FIDELITE du
  // harnais ci-dessus, pas un comportement. Si `grilleBien` cesse de poser ces
  // enfants, ou en pose d'autres, les tests de clic testeraient une cellule qui
  // n'existe plus — c'est exactement l'angle mort qui a laisse passer le
  // correctif fautif. Ce qu'il ne voit pas : un enfant ajoute ailleurs que dans
  // ce bloc de rendu.
  const rendu = bloc('const cellules = etat.joursISO.map', 'return `<section class="cal-bien"')
  assert.match(rendu, /<td class="cal-nuit/, 'la case est bien un td.cal-nuit')
  assert.match(rendu, /<span class="cal-nuit__prix/, 'elle contient toujours le span du prix')
  assert.match(rendu, /class="cal-orpheline"/, 'et parfois l\'icone « nuit orpheline »')
})

// ═══════════════════════════════════════════════════════════════════════════
// CONSTAT 9 — « impossible de modifier le prix », le GESTE DIRECT
//
// Mesure au NAVIGATEUR REEL (chrome-headless-shell pilote par CDP, vrais clics
// et vraies frappes, page servie par le banc avec un bien a la forme exacte
// d'Ofuro Futari). Le chemin par le bouton « Prix » fonctionnait ; celui que
// Thierry decrit — cliquer une case, puis taper — ne fonctionnait pas :
//
//   apres le clic sur la case : case selectionnee = true
//                               qui a le CURSEUR  = BODY
//   puis « 1 », « 5 », « 0 »  : champ de saisie   = (AUCUN CHAMP)
//   POST partis               : (AUCUN)
//
// Deux causes, independantes, toutes deux dans ce fichier de tests :
//  (a) `e.preventDefault()` du cliquer-glisser empeche AUSSI la mise au point.
//      La case porte `tabIndex = 0` et le raccourci A.5, mais le curseur
//      restait sur `body` : le raccourci etait inatteignable a la souris.
//  (b) meme avec le curseur, taper « 150 » donnait « 50 » — `input.select()`
//      selectionnait l'amorce, que la touche suivante remplacait.
// ═══════════════════════════════════════════════════════════════════════════

test('CONSTAT 9 : un clic sur la case lui donne le curseur', () => {
  const c = cellule()
  c.clic(c.td)
  assert.strictEqual(c.dom.window.document.activeElement, c.td,
    'sans la mise au point, taper un chiffre sur la case ne fait rien du tout')
})

test('CONSTAT 9 : un clic sur le PRIX donne aussi le curseur a la case', () => {
  const c = cellule()
  c.clic(c.prix())
  assert.strictEqual(c.dom.window.document.activeElement, c.td)
})

test('CONSTAT 9 : le chiffre qui ouvre la saisie n\'est plus efface par le suivant', () => {
  // `select()` sur une amorce faisait remplacer « 1 » par « 5 » : « 150 »
  // devenait « 50 ». Sur une amorce, le curseur se pose APRES, sans selection.
  const c = cellule()
  c.frappe(c.td, '1')
  const champ = c.champ()
  assert.strictEqual(champ.value, '1')
  assert.strictEqual(champ.selectionStart, 1, 'curseur apres le chiffre')
  assert.strictEqual(champ.selectionEnd, 1, 'et RIEN de selectionne')
})

test('sans amorce, le prix existant reste selectionne pour etre remplace', () => {
  // Le confort d'origine : ouvrir la saisie par le bouton sur une nuit deja
  // tarifee selectionne le montant, qu'un nouveau prix remplace d'un coup.
  const c = cellule()
  c.ctx.etat.states.ofuro[ISO] = { rate: 229 }
  c.ctx.etat.sel = { bien: 'ofuro', a: 0, b: 0 }
  c.ctx.actionPrix([ISO])
  const champ = c.champ()
  assert.strictEqual(champ.value, '229')
  assert.strictEqual(champ.selectionStart, 0, 'tout selectionne')
  assert.strictEqual(champ.selectionEnd, 3)
})

test('la lecture seule ne donne pas le curseur non plus', () => {
  const seule = cellule({ lectureSeule: true })
  seule.clic(seule.td)
  assert.notStrictEqual(seule.dom.window.document.activeElement, seule.td,
    'aucune porte d\'entree vers la saisie sans droit d\'ecriture')
})
