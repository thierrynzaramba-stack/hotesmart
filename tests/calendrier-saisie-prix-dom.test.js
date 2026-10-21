// tests/calendrier-saisie-prix-dom.test.js
// LE GESTE DE THIERRY, REJOUE DANS UN VRAI DOM : il selectionne des jours,
// il clique dans la case, il tape un prix.
//
// Constate en prod le 21 octobre 2026 sur « Ofuro Futari » : « il est
// impossible d'ecrire dedans ». Rien n'etait ecrit, ni en base ni chez le
// canal, et l'ecran ne disait rien. Cause : le `mousedown` de la cellule fait
// `preventDefault()` — elle ne prend donc JAMAIS le focus a la souris, la
// saisie au clavier ne se declenche pas, et AUCUN clic n'ouvre la case ; seul
// le bouton « Prix » de la barre flottante le faisait.
//
// ⚠ CES TESTS EXECUTENT LE MODULE DE LA PAGE, pas une copie (tests/outils/
// banc-calendrier.js). Un banc qui recopie le geste prouve la copie.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const B = require('./outils/banc-calendrier.js')

const BIEN = {
  id: 'B1', name: 'Ofuro Futari', provider: 'channex', capacity: 2, currency: 'EUR',
  pilote_tarifaire: 'calendrier', provider_property_id: 'P1', base_price: null,
  included_guests: 2, extra_guest_fee: 0
}
// Un inventaire ouvert et tarife : les nuits sont « ouvertes », donc selectionnables.
const inventaire = (jours, prix = 199) =>
  ({ B1: Object.fromEntries(jours.map(iso => [iso, { date: iso, rate: prix, avail: 1, stop_sell: false }])) })

// La page ne connait son inventaire qu'une fois construit : on peuple deux
// fois, la premiere pour obtenir la liste des jours affiches.
function banc ({ large = true, decalage = 0, mois = null, mois3 = false, reponse } = {}) {
  const b = B.monter({ large, appel: reponse || (async () => ({ saved: 1, pushed: true, local_only: false, push_failed: false, warnings: [] })) })
  const o = { biens: [BIEN], jours: mois3 ? 3 : 1, decalage, mois }
  const jours = B.peupler(b, o)
  B.peupler(b, { ...o, inv: inventaire(jours) })
  return { b, jours }
}

// ⚠ LES FIXTURES DU TELEPHONE SONT ANCREES DANS LEUR FENETRE, JAMAIS
// POSITIONNELLES (constat 3 de la review de b238432). `blocBienMobile` rend UN
// mois calendaire et ignore le decalage : indexer « la 4e journee a venir du
// mois affiche » rend `undefined` les derniers jours de chaque mois, et la
// moitie « jour passe » rend une liste vide le 1er. Mesure de la review :
// 6 rouges le 31 octobre, 2 le 1er novembre, 6 le 30 novembre.
//
// La regle du depot : *dates relatives si le test lit l'horloge, dates figees
// s'il injecte le temps*. Ces tests LISENT l'horloge (`AUJOURDHUI` vient de
// `new Date()`), donc les dates sont calculees — mais sur un mois ENTIEREMENT
// a venir (ou entierement passe), pour que le rang d'un jour dans le mois ne
// depende plus de la date du jour. La fenetre est portee a 3 mois pour que le
// mois affiche tienne dedans : `joursSelection()` filtre sur `etat.joursISO`.
const moisDecale = (n) => {
  const d = new Date()
  d.setDate(1)
  d.setMonth(d.getMonth() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
const MOIS_A_VENIR = moisDecale(1)
const MOIS_PASSE = moisDecale(-1)
const jourDuMois = (mois, n) => `${mois}-${String(n).padStart(2, '0')}`
// Le telephone, sur un mois entierement A VENIR.
const bancMobile = () => banc({ large: false, mois: MOIS_A_VENIR, mois3: true })
// Le telephone, sur un mois entierement PASSE.
const bancMobilePasse = () => banc({ large: false, mois: MOIS_PASSE, mois3: true, decalage: -70 })
const caseM = (b, iso) => {
  const el = b.doc.querySelector(`.cal-case[data-case="${iso}"][data-bien="B1"]`)
  assert.ok(el, `case ${iso} absente de la grille rendue`)
  return el
}

// ⚠ UN VRAI CLIC RELACHE SUR L'ELEMENT PRESSE. La page l'exige depuis la
// review : un appui abandonne — presse sur une case, relache ailleurs — ne
// doit PAS compter comme un clic. Relacher sur `document`, comme le faisait la
// premiere version de ces tests, decrivait donc un geste qui n'existe pas.
function glisser (b, cases, du, au) {
  B.geste(b, cases[du], 'mousedown')
  for (let i = du + 1; i <= au; i++) B.geste(b, cases[i], 'mouseenter')
  B.geste(b, cases[au], 'mouseup')
}
// Clic simple sur une cellule de l'ordinateur.
const clicCase = (b, el, o = {}) => {
  B.geste(b, el, 'mousedown', o)
  B.geste(b, el, 'mouseup', o)
}
// Tap / clic simple sur une case du telephone.
const tapCase = (b, el, pointerType = 'mouse', o = {}) => {
  B.geste(b, el, 'pointerdown', { pointerType, ...o })
  B.geste(b, el, 'pointerup', { pointerType, ...o })
}
// Glisser sur les cases du telephone, relache sur la derniere survolee.
function glisserMobile (b, du, au, pointerType = 'mouse') {
  B.geste(b, du, 'pointerdown', { pointerType })
  B.geste(b, au, 'pointerenter', { pointerType })
  B.geste(b, au, 'pointerup', { pointerType })
}

// ═══════════════════════════════════════════════════════════════════════════
// ORDINATEUR
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : glisser, relacher, CLIQUER DANS LA CASE, taper 175, Entree', async () => {
  const { b, jours } = banc({})
  const cases = B.casesBureau(b, 'B1')
  glisser(b, cases, 2, 5)
  assert.equal(b.cal.joursSelection().length, 4, 'quatre nuits selectionnees')
  assert.ok(B.barreVisible(b), 'la barre d actions est la')

  // LE GESTE : un clic simple dans une case DE LA SELECTION.
  clicCase(b, cases[2])
  const input = B.saisie(b)
  assert.ok(input, 'la case de saisie s ouvre au clic')
  assert.equal(b.cal.joursSelection().length, 4, 'le clic ne reduit pas la selection a un jour')

  input.value = '175'
  B.touche(b, input, 'Enter')
  await new Promise(r => setTimeout(r, 0))

  const posts = b.envois.filter(e => e.methode === 'POST' && e.chemin === '/api/calendar')
  assert.equal(posts.length, 1, 'un seul enregistrement')
  assert.deepEqual(posts[0].corps.segments, [{ date_from: jours[2], date_to: jours[5], rate: 175 }],
    'UN segment, sur TOUS les jours selectionnes')
  assert.equal(posts[0].corps.property_id, 'B1')
})

test('un GLISSER refait une selection, il n ouvre pas la saisie', () => {
  const { b } = banc({})
  const cases = B.casesBureau(b, 'B1')
  glisser(b, cases, 2, 5)
  assert.equal(B.saisie(b), null, 'un glisser ne saisit pas')
  glisser(b, cases, 7, 8)
  assert.equal(b.cal.joursSelection().length, 2, 'la selection est refaite, pas etendue')
  assert.equal(B.saisie(b), null)
})

test('le mousedown d une cellule N ANNULE PAS le defaut : c est le navigateur qui donne le focus', () => {
  // ⚠ CE TEST A ETE RETOURNE (review de b238432). Il affirmait
  // `activeElement === cases[2]`, donc l'APPEL a `td.focus()` — un
  // contournement du `preventDefault()` qu'il verrouillait au passage. La
  // propriete juste est l'inverse : le mousedown ne doit RIEN annuler, et le
  // navigateur donne le focus tout seul (jsdom, lui, n'implemente pas le
  // focus au mousedown : on prouve donc le mecanisme, pas son effet).
  const { b } = banc({})
  const cases = B.casesBureau(b, 'B1')
  const e = B.geste(b, cases[2], 'mousedown')
  assert.equal(e.defaultPrevented, false, 'aucun preventDefault : le focus natif peut avoir lieu')
  B.geste(b, cases[2], 'mouseup')
  // Et la selection de texte est empechee par le CSS, pas par le script.
  const css = fs.readFileSync(path.join(__dirname, '..', 'shared', 'ui.css'), 'utf8')
  for (const sel of ['.cal-nuit ', '.cal-case ']) {
    const i = css.indexOf(sel)
    assert.ok(i > 0 && /user-select:\s*none/.test(css.slice(i, css.indexOf('}', i))),
      `${sel.trim()} : user-select none, sinon le glisser selectionne du texte`)
  }
})

test('taper un chiffre juste apres une selection ouvre la saisie SANS perdre les jours', () => {
  const { b, jours } = banc({})
  const cases = B.casesBureau(b, 'B1')
  glisser(b, cases, 2, 5)
  // Le navigateur a donne le focus a la cellule au mousedown ; jsdom ne le
  // fait pas, on le pose donc comme le navigateur l'aurait fait.
  cases[2].focus()
  B.touche(b, cases[2], '1')
  const input = B.saisie(b)
  assert.ok(input, 'un chiffre ouvre la saisie')
  assert.equal(input.value, '1', 'le chiffre tape amorce la valeur')
  assert.equal(b.cal.joursSelection().length, 4, 'les quatre nuits sont toujours visees')
  input.value = '150'
  B.touche(b, input, 'Enter')
  return new Promise(r => setTimeout(r, 0)).then(() => {
    const p = b.envois.filter(e => e.methode === 'POST')[0]
    assert.deepEqual(p.corps.segments, [{ date_from: jours[2], date_to: jours[5], rate: 150 }])
  })
})

test('POINT 2 : un clic DANS la case de saisie ne touche ni la selection ni le focus', () => {
  const { b } = banc({})
  const cases = B.casesBureau(b, 'B1')
  glisser(b, cases, 2, 5)
  clicCase(b, cases[2])
  const input = B.saisie(b)
  assert.ok(input)
  const e = B.geste(b, input, 'mousedown')
  assert.equal(e.defaultPrevented, false, 'le mousedown de la cellule ignore la case de saisie')
  assert.ok(B.saisie(b), 'la case de saisie est toujours la')
  assert.equal(b.cal.joursSelection().length, 4, 'la selection n a pas ete refaite sous le curseur')
})

test('POINT 6 : apres Entree, la selection et la barre d actions se vident', async () => {
  const { b } = banc({})
  const cases = B.casesBureau(b, 'B1')
  glisser(b, cases, 2, 5)
  clicCase(b, cases[2])
  const input = B.saisie(b)
  input.value = '175'
  B.touche(b, input, 'Enter')
  await new Promise(r => setTimeout(r, 0))
  assert.equal(b.cal.etat.sel, null, 'plus de selection')
  assert.equal(B.barreVisible(b), false, 'plus de barre')
})

test('POINT 6 : apres Enregistrer DANS LA POPUP, la selection et la barre se vident', async () => {
  const { b, jours } = banc({})
  const cases = B.casesBureau(b, 'B1')
  glisser(b, cases, 2, 5)
  b.cal.ouvrirPopup(b.cal.joursSelection(), 'rate')
  const corps = b.doc.querySelector('[data-bind="feuille-corps"]')
  corps.querySelector('[data-champ="rate-valeur"]').value = '175'
  corps.querySelector('[data-cfg-save]').click()
  await new Promise(r => setTimeout(r, 0))
  const posts = b.envois.filter(e => e.methode === 'POST')
  assert.equal(posts.length, 1, 'la popup enregistre')
  assert.deepEqual(posts[0].corps.segments, [{ date_from: jours[2], date_to: jours[5], rate: 175 }])
  assert.equal(b.cal.etat.sel, null, 'plus de selection apres Enregistrer')
  assert.equal(B.barreVisible(b), false, 'plus de barre apres Enregistrer')
})

// ═══════════════════════════════════════════════════════════════════════════
// TELEPHONE (point 4) et VUE ETROITE A LA SOURIS (point 5)
// ═══════════════════════════════════════════════════════════════════════════

test('POINT 4 : au doigt, appui long puis tap sur une seconde date, la rubrique Prix ecrit UN segment', async () => {
  const { b } = bancMobile()
  const a = jourDuMois(MOIS_A_VENIR, 5), z = jourDuMois(MOIS_A_VENIR, 8)
  B.geste(b, caseM(b, a), 'pointerdown', { pointerType: 'touch' })
  await new Promise(r => setTimeout(r, 500))           // appui LONG
  B.geste(b, caseM(b, a), 'pointerup', { pointerType: 'touch' })
  assert.ok(B.barreVisible(b), 'l appui long ouvre la barre d actions')
  // Un tap sur une seconde date HORS de la plage l'ETEND (point 5).
  B.geste(b, caseM(b, z), 'pointerdown', { pointerType: 'touch' })
  B.geste(b, caseM(b, z), 'pointerup', { pointerType: 'touch' })
  assert.equal(b.cal.joursSelection().length, 4, 'la plage est etendue, la popup ne s ouvre pas')

  b.cal.actionPrix(b.cal.joursSelection())
  const corps = b.doc.querySelector('[data-bind="feuille-corps"]')
  assert.ok(corps.querySelector('[data-champ="rate-valeur"]'), 'la rubrique Prix est la')
  corps.querySelector('[data-champ="rate-valeur"]').value = '175'
  corps.querySelector('[data-cfg-save]').click()
  await new Promise(r => setTimeout(r, 0))
  const posts = b.envois.filter(e => e.methode === 'POST')
  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0].corps.segments, [{ date_from: a, date_to: z, rate: 175 }], 'UN segment sur la plage')
  assert.equal(b.cal.etat.sel, null, 'la selection se vide')
  assert.equal(B.barreVisible(b), false)
})

test('CONSTAT 11 : au telephone, un tap DANS la selection ouvre la saisie pour TOUTE la selection', async () => {
  // Le mobile suit l'ordinateur. Avant la review, ce tap tombait dans la
  // branche d'extension et RETRECISSAIT la plage en silence.
  const { b } = bancMobile()
  const du = jourDuMois(MOIS_A_VENIR, 5), au = jourDuMois(MOIS_A_VENIR, 12)
  glisserMobile(b, caseM(b, du), caseM(b, au))
  assert.equal(b.cal.joursSelection().length, 8, 'huit nuits selectionnees')
  // Un clic au MILIEU de la plage.
  tapCase(b, caseM(b, jourDuMois(MOIS_A_VENIR, 8)))
  assert.equal(b.cal.joursSelection().length, 8, 'la plage n est PAS retrecie')
  const corps = b.doc.querySelector('[data-bind="feuille-corps"]')
  assert.ok(corps.querySelector('[data-champ="rate-valeur"]'), 'la rubrique Prix s ouvre')
  assert.equal(corps.querySelector('[data-champ="cfg-du"]').value, du, 'sur toute la plage')
  assert.equal(corps.querySelector('[data-champ="cfg-au"]').value, au)
})

test('POINT 5 : vue etroite A LA SOURIS, glisser selectionne une plage', () => {
  const { b } = bancMobile()
  const du = jourDuMois(MOIS_A_VENIR, 5)
  B.geste(b, caseM(b, du), 'pointerdown', { pointerType: 'mouse' })
  B.geste(b, caseM(b, jourDuMois(MOIS_A_VENIR, 6)), 'pointerenter', { pointerType: 'mouse' })
  const fin = caseM(b, jourDuMois(MOIS_A_VENIR, 7))
  B.geste(b, fin, 'pointerenter', { pointerType: 'mouse' })
  B.geste(b, fin, 'pointerup', { pointerType: 'mouse' })
  assert.equal(b.cal.joursSelection().length, 3, 'trois nuits selectionnees a la souris')
  assert.ok(B.barreVisible(b), 'la barre d actions apparait')
  assert.equal(b.doc.querySelector('[data-bind="feuille"]').hidden, true, 'le glisser n ouvre pas la popup')
})

test('POINT 5 : une date deja choisie, un clic de SOURIS HORS de la plage l etend', () => {
  const { b } = bancMobile()
  glisserMobile(b, caseM(b, jourDuMois(MOIS_A_VENIR, 5)), caseM(b, jourDuMois(MOIS_A_VENIR, 6)))
  assert.equal(b.cal.joursSelection().length, 2)
  tapCase(b, caseM(b, jourDuMois(MOIS_A_VENIR, 9)))
  assert.equal(b.cal.joursSelection().length, 5, 'la plage est etendue, pas remplacee')
  assert.equal(b.doc.querySelector('[data-bind="feuille"]').hidden, true, 'la popup ne s est pas rouverte')
})

test('POINT 5 : sans selection, un clic de souris ouvre toujours la popup du jour', () => {
  const { b } = bancMobile()
  const iso = jourDuMois(MOIS_A_VENIR, 7)
  tapCase(b, caseM(b, iso), 'mouse')
  assert.equal(b.doc.querySelector('[data-bind="feuille"]').hidden, false, 'la popup du jour s ouvre')
  assert.equal(b.doc.querySelector('[data-champ="cfg-du"]').value, iso, 'pre-remplie sur le jour clique')
})

test('CONSTAT 5 : les cases sont des boutons, donc elles repondent au CLAVIER', () => {
  // Entree et Espace produisent un `click` SANS evenement de pointeur.
  const { b } = bancMobile()
  const iso = jourDuMois(MOIS_A_VENIR, 7)
  B.clicClavier(b, caseM(b, iso))
  assert.equal(b.doc.querySelector('[data-bind="feuille"]').hidden, false, 'le clavier ouvre la popup du jour')
  assert.equal(b.doc.querySelector('[data-champ="cfg-du"]').value, iso)
})

test('CONSTAT 5 bis : le clic qui SUIT un geste de pointeur n agit pas deux fois', () => {
  const { b } = bancMobile()
  const iso = jourDuMois(MOIS_A_VENIR, 7)
  const c = caseM(b, iso)
  tapCase(b, c)
  const avant = b.doc.querySelector('[data-champ="cfg-du"]').value
  B.geste(b, c, 'click')                 // detail = 1 : il vient du pointeur
  assert.equal(b.doc.querySelector('[data-champ="cfg-du"]').value, avant, 'rien n a bouge')
})

test('CONSTAT 10 : un second doigt ne vole pas le geste du premier', async () => {
  const { b } = bancMobile()
  const a = jourDuMois(MOIS_A_VENIR, 5), autre = jourDuMois(MOIS_A_VENIR, 20)
  B.geste(b, caseM(b, a), 'pointerdown', { pointerType: 'touch', pointerId: 1 })
  B.geste(b, caseM(b, autre), 'pointerdown', { pointerType: 'touch', pointerId: 2 })  // pince, paume
  await new Promise(r => setTimeout(r, 500))
  B.geste(b, caseM(b, a), 'pointerup', { pointerType: 'touch', pointerId: 1 })
  // L'appui long du PREMIER doigt a bien pose SA date, et rien ne s est ouvert
  // sur la date du second.
  assert.ok(b.cal.etat.sel, 'le geste du premier doigt a survecu')
  assert.equal(b.cal.etat.sel.duIso, a)
  assert.equal(b.doc.querySelector('[data-bind="feuille"]').hidden, true,
    'aucune popup sur une date jamais touchee')
})

test('CONSTAT 6 : vue etroite, un survol SANS bouton tenu n etend rien', () => {
  const { b } = bancMobile()
  B.geste(b, caseM(b, jourDuMois(MOIS_A_VENIR, 5)), 'pointerdown', { pointerType: 'mouse' })
  // Le bouton a ete relache hors de la page : le survol suivant n a plus de bouton.
  B.geste(b, caseM(b, jourDuMois(MOIS_A_VENIR, 11)), 'pointerenter', { pointerType: 'mouse', boutons: 0 })
  assert.equal(b.cal.etat.sel, null, 'la selection ne suit pas un curseur nu')
  assert.equal(B.barreVisible(b), false)
})

test('CONSTAT 7 : vue etroite, un clic DROIT n ouvre rien', () => {
  const { b } = bancMobile()
  tapCase(b, caseM(b, jourDuMois(MOIS_A_VENIR, 7)), 'mouse', { bouton: 2, boutons: 2 })
  assert.equal(b.doc.querySelector('[data-bind="feuille"]').hidden, true, 'aucune popup')
  assert.equal(b.cal.etat.sel, null, 'aucune selection')
})

test('CONSTAT 9 : le bouton + d un bien vide la selection ET la barre', () => {
  const { b } = bancMobile()
  glisserMobile(b, caseM(b, jourDuMois(MOIS_A_VENIR, 5)), caseM(b, jourDuMois(MOIS_A_VENIR, 6)))
  assert.ok(B.barreVisible(b), 'barre ouverte sur deux nuits')
  b.doc.querySelector('[data-plus]').click()
  assert.equal(b.cal.etat.sel, null, 'plus de selection')
  assert.equal(B.barreVisible(b), false, 'plus de barre — elle ne reste pas a proposer des nuits deja traitees')
  assert.equal(b.doc.querySelectorAll('.cal-case--sel').length, 0, 'plus de peinture')
})

test('Entree valide UNE fois : aucune seconde saisie ne se rouvre derriere', async () => {
  // Trouve par ce banc : la touche Entree remonte de la case de saisie a la
  // CELLULE, dont le `keydown` rouvrait aussitot une saisie — et un second
  // enregistrement partait au geste suivant.
  const { b } = banc({})
  const cases = B.casesBureau(b, 'B1')
  glisser(b, cases, 2, 5)
  clicCase(b, cases[2])
  const input = B.saisie(b)
  input.value = '175'
  B.touche(b, input, 'Enter')
  await new Promise(r => setTimeout(r, 0))
  assert.equal(B.saisie(b), null, 'la case de saisie est refermee, pas rouverte')
  assert.equal(b.envois.filter(e => e.methode === 'POST').length, 1, 'un seul enregistrement')
})

test('Echap referme la saisie sans rien enregistrer, et garde la selection', () => {
  const { b } = banc({})
  const cases = B.casesBureau(b, 'B1')
  glisser(b, cases, 2, 5)
  clicCase(b, cases[2])
  const input = B.saisie(b)
  input.value = '175'
  B.touche(b, input, 'Escape')
  assert.equal(B.saisie(b), null, 'la case se referme')
  assert.equal(b.envois.filter(e => e.methode === 'POST').length, 0, 'rien n est enregistre')
  assert.equal(b.cal.joursSelection().length, 4, 'la selection reste, pour recommencer')
})

// ═══════════════════════════════════════════════════════════════════════════
// LECTURE SEULE : la garde se prouve par le GESTE, pas par le nom de
// l'evenement. Les deux ecrans ont change d'evenements le 21 octobre 2026
// (souris -> pointeur au telephone) ; une garde verifiee par regex sur la
// source aurait suivi le renommage sans rien prouver.
// ═══════════════════════════════════════════════════════════════════════════

// ⚠ UNE GARDE QUI PASSE A VIDE NE GARDE RIEN. Le meme geste est joue DEUX
// fois — avec le droit, puis sans — et on exige qu'il selectionne dans le
// premier cas. Sans ce couplage, le test resterait vert le jour ou le geste
// cesserait de marcher du tout : c'est exactement ce qu'il faisait contre
// l'ancien code, ou mes evenements de pointeur n'etaient ecoutes par personne.
test('sans droit d ecriture : aucun geste ne selectionne, ni ordinateur ni telephone', () => {
  for (const large of [true, false]) {
    for (const ecriture of [true, false]) {
    const b = B.monter({ large, ecriture })
    // ⚠ ANCRE : mois entierement A VENIR, fenetre de 3 mois. Indexer « la 2e
    // journee a venir du mois courant » rendait `undefined` les 30 et 31 du
    // mois (mesure : 2 rouges a J+9 et J+10).
    const o = { biens: [BIEN], jours: large ? 1 : 3, mois: large ? null : MOIS_A_VENIR }
    const jours = B.peupler(b, o)
    B.peupler(b, { ...o, inv: inventaire(jours) })
    if (large) {
      const cases = B.casesBureau(b, 'B1')
      B.geste(b, cases[2], 'mousedown')
      B.geste(b, cases[4], 'mouseenter')
      B.geste(b, cases[4], 'mouseup')
      B.touche(b, cases[2], '1')
    } else {
      const a = caseM(b, jourDuMois(MOIS_A_VENIR, 5)), z = caseM(b, jourDuMois(MOIS_A_VENIR, 6))
      B.geste(b, a, 'pointerdown', { pointerType: 'mouse' })
      B.geste(b, z, 'pointerenter', { pointerType: 'mouse' })
      B.geste(b, z, 'pointerup', { pointerType: 'mouse' })
    }
    const ou = `${large ? 'ordinateur' : 'telephone'}`
    if (ecriture) {
      // LA CONTRE-EPREUVE : avec le droit, ce geste-la selectionne VRAIMENT.
      assert.ok(b.cal.etat.sel, `${ou} : avec le droit, le geste selectionne`)
      assert.ok(b.cal.joursSelection().length >= 2, `${ou} : et il selectionne une PLAGE`)
      continue
    }
    assert.equal(b.cal.etat.sel, null, `${ou} : rien n est selectionne`)
    assert.equal(B.saisie(b), null, 'aucune saisie')
    assert.equal(B.barreVisible(b), false, 'aucune barre d actions')
    assert.equal(b.doc.querySelector('[data-bind="feuille"]').hidden, true, 'aucune popup d edition')
    assert.equal(b.envois.filter(e => e.methode === 'POST').length, 0, 'aucune ecriture')
    }
  }
})

// Meme couplage que ci-dessus : le geste est joue en lecture ET en ecriture,
// et on exige qu'il PRODUISE quelque chose quand il est autorise.
test('en lecture seule (etat.lectureSeule) : meme refus, les deux ecrans', () => {
  for (const large of [true, false]) {
    for (const lecture of [false, true]) {
      const b = B.monter({ large })
      const o = { biens: [BIEN], jours: large ? 1 : 3, mois: large ? null : MOIS_A_VENIR }
      const jours = B.peupler(b, o)
      B.peupler(b, { ...o, inv: inventaire(jours) })
      b.cal.etat.lectureSeule = lecture
      if (large) {
        const cases = B.casesBureau(b, 'B1')
        clicCase(b, cases[2])
      } else {
        const c = caseM(b, jourDuMois(MOIS_A_VENIR, 5))
        B.geste(b, c, 'pointerdown', { pointerType: 'mouse' })
        B.geste(b, c, 'pointerup', { pointerType: 'mouse' })
      }
      const ou = `${large ? 'ordinateur' : 'telephone'}`
      if (!lecture) {
        // CONTRE-EPREUVE : hors lecture seule, ce geste-la fait quelque chose
        // — une selection d'un jour a l'ordinateur, la popup du jour au
        // telephone. Sans elle, le refus serait prouve a vide.
        const aAgi = !!b.cal.etat.sel || b.doc.querySelector('[data-bind="feuille"]').hidden === false
        assert.ok(aAgi, `${ou} : hors lecture seule, le geste agit`)
        continue
      }
      assert.equal(b.cal.etat.sel, null, `${ou} : rien n est selectionne`)
      assert.equal(b.doc.querySelector('[data-bind="feuille"]').hidden, true, 'aucune popup d edition')
    }
  }
})

test('un bien pilote par YieldFlow refuse la saisie de prix, avec son message', () => {
  const b = B.monter({})
  const pilote = { ...BIEN, pilote_tarifaire: 'yieldflow' }
  const jours = B.peupler(b, { biens: [pilote], jours: 1 })
  B.peupler(b, { biens: [pilote], inv: inventaire(jours), jours: 1 })
  const cases = B.casesBureau(b, 'B1')
  glisser(b, cases, 2, 5)
  clicCase(b, cases[2])
  assert.equal(B.saisie(b), null, 'aucune saisie ne s ouvre sur un bien pilote')
  assert.equal(b.lireToasts().length, 1, 'et l ecran le DIT')
  assert.match(b.lireToasts()[0], /pilot/i)
})

// ═══════════════════════════════════════════════════════════════════════════
// POINT 7 : un jour passe se VOIT desactive
// ⚠ ANCRE DANS SA FENETRE (cause 2 du constat 3) : la premiere version
// appelait `banc({ large: false })` sans decalage, donc la liste des jours
// passes du mois courant etait VIDE le 1er du mois, et le test rougissait.
// ═══════════════════════════════════════════════════════════════════════════

test('POINT 7 : un jour passe porte aria-disabled, sur les deux ecrans', () => {
  const { b } = banc({ decalage: -10 })
  const passees = B.casesBureau(b, 'B1').filter(c => c.classList.contains('cal-nuit--passe'))
  assert.ok(passees.length >= 10, 'la fenetre contient des jours passes')
  for (const c of passees) assert.equal(c.getAttribute('aria-disabled'), 'true', 'ordinateur')

  // Mois ENTIEREMENT passe : la liste n est jamais vide, quel que soit le jour.
  const m = bancMobilePasse()
  const toutes = B.casesTelephone(m.b, 'B1')
  const passeesM = toutes.filter(c => c.dataset.passe)
  assert.equal(passeesM.length, toutes.length, 'tout le mois affiche est passe')
  assert.ok(passeesM.length >= 28)
  for (const c of passeesM) assert.equal(c.getAttribute('aria-disabled'), 'true', 'telephone')
})

test('POINT 7 : le curseur « interdit » est declare pour les deux ecrans', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'shared', 'ui.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  // ⚠ UNE REGLE, PAS UNE SOUS-CHAINE : `.cal-nuit--passe` apparait d'abord
  // dans `:not(.cal-nuit--passe):hover`. On exige le selecteur SEUL devant
  // son accolade, sinon le test lirait le corps d'une autre regle.
  const regle = (sel) => {
    const re = new RegExp('(?:^|[}])\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')
    const m = re.exec(css)
    assert.ok(m, `regle absente : ${sel}`)
    return m[1]
  }
  assert.match(regle('.cal-nuit--passe'), /cursor:\s*not-allowed/, 'ordinateur : curseur interdit')
  assert.match(regle('.cal-case.cal-nuit--passe'), /cursor:\s*not-allowed/, 'telephone : curseur interdit')
})

test('un jour passe ne se selectionne toujours pas, aux deux ecrans', () => {
  const { b } = banc({ decalage: -10 })
  const passee = B.casesBureau(b, 'B1').find(c => c.classList.contains('cal-nuit--passe'))
  clicCase(b, passee)
  assert.equal(b.cal.etat.sel, null, 'ordinateur : rien n est selectionne')
  assert.equal(B.saisie(b), null, 'ordinateur : aucune saisie ne s ouvre')

  const m = bancMobilePasse()
  const passeeM = caseM(m.b, jourDuMois(MOIS_PASSE, 10))
  assert.equal(passeeM.dataset.passe, '1', 'la case visee est bien passee')
  tapCase(m.b, passeeM, 'mouse')
  assert.equal(m.b.cal.etat.sel, null, 'telephone : rien n est selectionne')
  assert.equal(m.b.doc.querySelector('[data-bind="feuille"]').hidden, true, 'telephone : pas de popup')
  // Et le clavier non plus.
  B.clicClavier(m.b, passeeM)
  assert.equal(m.b.doc.querySelector('[data-bind="feuille"]').hidden, true, 'telephone : ni au clavier')
})

// ═══════════════════════════════════════════════════════════════════════════
// LES CONSTATS DE LA REVIEW DE b238432 — ORDINATEUR
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE (ECRITURE) : un DOUBLE-CLIC n enregistre RIEN', async () => {
  // ⚠ LE DEFAUT LE PLUS GRAVE DE LA PREMIERE VERSION. Le `td.focus()` pose a
  // la main volait le focus de la case de saisie ouverte ; son `blur`
  // ENREGISTRAIT la valeur pre-remplie — un double-clic poussait quatre nuits
  // au canal, au prix que personne n avait tape. Sur une fenetre de 90 jours,
  // un clic de travers en repoussait 90.
  const { b } = banc({})
  const cases = B.casesBureau(b, 'B1')
  glisser(b, cases, 2, 5)
  clicCase(b, cases[2])   // 1er clic : la saisie s ouvre
  assert.ok(B.saisie(b), 'la saisie est ouverte')
  clicCase(b, cases[2])   // 2e clic du double-clic
  await new Promise(r => setTimeout(r, 0))
  assert.equal(b.envois.filter(e => e.methode === 'POST').length, 0,
    'AUCUNE ecriture : personne n a tape de prix')
  assert.equal(b.lireToasts().filter(t => /Annuler|Enregistr/i.test(t)).length, 0,
    'et aucun verdict d enregistrement')
})

test('un clic sur une AUTRE cellule pendant la saisie n enregistre pas la valeur pre-remplie', async () => {
  const { b } = banc({})
  const cases = B.casesBureau(b, 'B1')
  glisser(b, cases, 2, 5)
  clicCase(b, cases[2])
  assert.ok(B.saisie(b))
  clicCase(b, cases[9])
  await new Promise(r => setTimeout(r, 0))
  assert.equal(b.envois.filter(e => e.methode === 'POST').length, 0, 'rien n est parti')
})

test('CONSTAT 2 : aucun geste ne laisse une exception muette dans le journal', async () => {
  const { b } = banc({})
  const cases = B.casesBureau(b, 'B1')
  glisser(b, cases, 2, 5)
  clicCase(b, cases[2])
  clicCase(b, cases[2])
  const input = B.saisie(b)
  if (input) { input.value = '175'; B.touche(b, input, 'Enter') }
  await new Promise(r => setTimeout(r, 10))
  // ⚠ `window.__journal` existe pour attraper ce que jsdom avale. L affirmer
  // VIDE est la seule facon de voir une exception qui ne casse aucun test.
  assert.deepEqual(b.journal, [], 'aucune exception avalee : ' + JSON.stringify(b.journal))
})

test('CONSTAT 7 : un clic DROIT dans la selection n ouvre pas la saisie', () => {
  const { b } = banc({})
  const cases = B.casesBureau(b, 'B1')
  glisser(b, cases, 2, 5)
  const e = B.geste(b, cases[2], 'mousedown', { bouton: 2, boutons: 2 })
  B.geste(b, cases[2], 'mouseup', { bouton: 2 })
  assert.equal(e.defaultPrevented, false, 'le menu contextuel du navigateur reste possible')
  assert.equal(B.saisie(b), null, 'aucune saisie derriere le menu contextuel')
  assert.equal(b.cal.joursSelection().length, 4, 'et la selection n est pas refaite')
})

test('CONSTAT 8 : un glisser qui ne traverse que des jours PASSES reste un glisser', () => {
  const { b } = banc({ decalage: -10 })
  const cases = B.casesBureau(b, 'B1')
  const futures = cases.filter(c => c.dataset.iso >= b.cal.AUJOURDHUI)
  const passees = cases.filter(c => c.dataset.iso < b.cal.AUJOURDHUI)
  assert.ok(futures.length >= 4 && passees.length >= 2, 'la fenetre porte les deux')
  B.geste(b, futures[0], 'mousedown')
  B.geste(b, futures[1], 'mouseenter'); B.geste(b, futures[2], 'mouseenter')
  B.geste(b, b.doc, 'mouseup')
  assert.equal(b.cal.joursSelection().length, 3)
  // Puis un glisser vers la GAUCHE, qui ne croise que du passe : le geste a
  // BOUGE, donc ce n est pas un clic.
  B.geste(b, futures[0], 'mousedown')
  B.geste(b, passees[passees.length - 1], 'mouseenter')
  B.geste(b, passees[passees.length - 2], 'mouseenter')
  B.geste(b, b.doc, 'mouseup')
  assert.equal(B.saisie(b), null, 'rien ne s ouvre : le geste a bouge')
})

test('CONSTAT 6 : un survol sans bouton tenu n etend pas la selection', () => {
  const { b } = banc({})
  const cases = B.casesBureau(b, 'B1')
  B.geste(b, cases[2], 'mousedown')
  B.geste(b, cases[8], 'mouseenter', { boutons: 0 })      // relache hors de la page
  assert.equal(b.cal.joursSelection().length, 1, 'la selection ne suit pas un curseur nu')
})

test('CONSTAT 6 bis : un mouseup egare ne rouvre pas la saisie du geste precedent', () => {
  const { b } = banc({})
  const cases = B.casesBureau(b, 'B1')
  glisser(b, cases, 2, 5)
  B.geste(b, cases[2], 'mousedown')         // appui dans la selection
  // Le bouton est relache hors de la page : aucun mouseup ne nous parvient.
  // L appui SUIVANT, ailleurs, doit jeter le geste arme.
  B.geste(b, b.doc.querySelector('[data-bind="flottante-annuler"]'), 'mousedown')
  B.geste(b, b.doc, 'mouseup')
  assert.equal(B.saisie(b), null, 'aucune saisie ne s ouvre toute seule')
})

test('CONSTAT 13 : le POST porte le jeton, l en-tete de compte, l action et LE BON DROIT', async () => {
  // ⚠ Supprimer `enteteCompte()` laissait les 18 premiers tests verts — et un
  // compte delegue aurait ecrit ses prix sur le MAUVAIS compte.
  const { b } = banc({})
  const cases = B.casesBureau(b, 'B1')
  glisser(b, cases, 2, 5)
  clicCase(b, cases[2])
  const input = B.saisie(b)
  input.value = '175'
  B.touche(b, input, 'Enter')
  await new Promise(r => setTimeout(r, 0))
  const post = b.envois.filter(e => e.methode === 'POST')[0]
  assert.equal(post.corps.action, 'save', 'l action est nommee')
  assert.match(String(post.entetes.Authorization || ''), /^Bearer /, 'le jeton part')
  assert.equal(post.entetes['x-hs-compte'], 'U1', 'l en-tete de compte part')
  assert.equal(post.entetes['Content-Type'], 'application/json')
  // Et le droit demande est celui du domaine des reservations, pas un autre.
  assert.deepEqual([...new Set(b.domaines)], ['reservations'], 'un seul domaine, et c est le bon')
})

test('CONSTAT 12 : apres l ecriture, le calendrier est RELU, et la relecture ne leve pas', async () => {
  let relectures = 0
  const { b } = banc({})
  b.window.__chargement = () => { relectures++; return { properties: [], inventory: {}, bookings: {}, fermetures: {} } }
  const cases = B.casesBureau(b, 'B1')
  glisser(b, cases, 2, 5)
  clicCase(b, cases[2])
  const input = B.saisie(b)
  input.value = '175'
  B.touche(b, input, 'Enter')
  await new Promise(r => setTimeout(r, 20))
  assert.ok(relectures >= 1, 'le calendrier est relu apres l ecriture')
  assert.deepEqual(b.journal, [], 'et la relecture ne leve pas')
})

// ═══════════════════════════════════════════════════════════════════════════
// L'ADDENDUM DE LA REVIEW — trois defauts de plus, tous mesures
// ═══════════════════════════════════════════════════════════════════════════

test('ADDENDUM A : un appui ABANDONNE n ouvre rien, sur les deux ecrans', () => {
  // `click` offrait gratuitement l'ancre « appuyer et relacher sur le MEME
  // element ». En passant au pointeur au niveau du document, on l'avait
  // perdue : l'hote qui appuie sur la mauvaise date, s'en apercoit, glisse
  // hors de la grille et relache ailleurs voyait s'ouvrir ce qu'il abandonnait.
  const { b } = banc({})
  const cases = B.casesBureau(b, 'B1')
  glisser(b, cases, 2, 5)
  B.geste(b, cases[3], 'mousedown')
  B.geste(b, b.doc.querySelector('[data-bind="toasts"]'), 'mouseup')   // relache HORS de la ligne
  assert.equal(B.saisie(b), null, 'ordinateur : aucune saisie sur un appui abandonne')

  const m = bancMobile()
  B.geste(m.b, caseM(m.b, jourDuMois(MOIS_A_VENIR, 9)), 'pointerdown', { pointerType: 'touch' })
  B.geste(m.b, m.b.doc.querySelector('[data-bind="toasts"]'), 'pointerup', { pointerType: 'touch' })
  assert.equal(m.b.doc.querySelector('[data-bind="feuille"]').hidden, true,
    'telephone : aucune fiche du jour sur un appui abandonne')
  assert.equal(m.b.cal.etat.sel, null)
})

test('ADDENDUM B : une selection prise A COTE du tiroir ouvert survit a Enregistrer', async () => {
  // Le tiroir n'a PAS de voile : la grille reste vivante a cote. Le vidage
  // inconditionnel faisait disparaitre quatre nuits selectionnees sous un
  // toast « Enregistre » qui n avait ecrit que la nuit du tiroir.
  const { b } = bancMobile()
  const seul = jourDuMois(MOIS_A_VENIR, 3)
  tapCase(b, caseM(b, seul))                       // le tiroir s ouvre sur UNE nuit
  assert.equal(b.doc.querySelector('[data-bind="feuille"]').hidden, false)
  // Pendant que le tiroir est ouvert, l hote selectionne quatre nuits a cote.
  glisserMobile(b, caseM(b, jourDuMois(MOIS_A_VENIR, 20)), caseM(b, jourDuMois(MOIS_A_VENIR, 23)))
  assert.equal(b.cal.joursSelection().length, 4, 'quatre nuits selectionnees a cote')
  const corps = b.doc.querySelector('[data-bind="feuille-corps"]')
  corps.querySelector('[data-champ="rate-valeur"]').value = '175'
  corps.querySelector('[data-cfg-save]').click()
  await new Promise(r => setTimeout(r, 0))
  const post = b.envois.filter(e => e.methode === 'POST')[0]
  assert.deepEqual(post.corps.segments, [{ date_from: seul, date_to: seul, rate: 175 }],
    'le tiroir ecrit SA nuit')
  assert.equal(b.cal.joursSelection().length, 4, 'et les quatre nuits selectionnees SURVIVENT')
  assert.ok(B.barreVisible(b), 'leur barre d actions aussi')
})

test('ADDENDUM B bis : une plage corrigee a la main dans le tiroir ne vide pas la selection', async () => {
  const { b } = bancMobile()
  const du = jourDuMois(MOIS_A_VENIR, 5)
  glisserMobile(b, caseM(b, du), caseM(b, jourDuMois(MOIS_A_VENIR, 8)))
  b.cal.actionPrix(b.cal.joursSelection())          // le tiroir vient DE la selection
  const corps = b.doc.querySelector('[data-bind="feuille-corps"]')
  // L hote corrige « au » a la main avant d enregistrer : ce n est plus sa selection.
  corps.querySelector('[data-champ="cfg-au"]').value = jourDuMois(MOIS_A_VENIR, 6)
  corps.querySelector('[data-champ="rate-valeur"]').value = '175'
  corps.querySelector('[data-cfg-save]').click()
  await new Promise(r => setTimeout(r, 0))
  assert.ok(b.cal.etat.sel, 'la selection n est pas videe : la plage ecrite n etait pas la sienne')
})

test('ADDENDUM B ter : la popup ouverte DEPUIS la selection, elle, la vide bien', async () => {
  const { b } = bancMobile()
  const du = jourDuMois(MOIS_A_VENIR, 5), au = jourDuMois(MOIS_A_VENIR, 8)
  glisserMobile(b, caseM(b, du), caseM(b, au))
  b.cal.actionPrix(b.cal.joursSelection())
  const corps = b.doc.querySelector('[data-bind="feuille-corps"]')
  corps.querySelector('[data-champ="rate-valeur"]').value = '175'
  corps.querySelector('[data-cfg-save]').click()
  await new Promise(r => setTimeout(r, 0))
  assert.equal(b.cal.etat.sel, null, 'la selection a fait son office')
  assert.equal(B.barreVisible(b), false)
})

test('ADDENDUM C : un STYLET exige l appui long, comme le doigt', async () => {
  // `=== touch` rangeait le stylet du cote de la SOURIS : un glisser au stylet
  // posait une selection sans aucun appui long, alors que l hote voulait faire
  // defiler le mois.
  const { b } = bancMobile()
  const du = caseM(b, jourDuMois(MOIS_A_VENIR, 5))
  const au = caseM(b, jourDuMois(MOIS_A_VENIR, 8))
  B.geste(b, du, 'pointerdown', { pointerType: 'pen' })
  B.geste(b, au, 'pointerenter', { pointerType: 'pen' })
  assert.equal(b.cal.etat.sel, null, 'aucune selection sans appui long au stylet')
  assert.equal(B.barreVisible(b), false)
  // Et avec l appui long, le stylet selectionne comme le doigt.
  B.geste(b, du, 'pointerdown', { pointerType: 'pen' })
  await new Promise(r => setTimeout(r, 500))
  B.geste(b, du, 'pointerup', { pointerType: 'pen' })
  assert.ok(b.cal.etat.sel, 'avec l appui long, le stylet selectionne')
})

test('ADDENDUM C bis : un pointeur INDETERMINE est traite comme direct, pas comme une souris', () => {
  // La spec autorise `pointerType: ''` quand le materiel ne se determine pas.
  const { b } = bancMobile()
  B.geste(b, caseM(b, jourDuMois(MOIS_A_VENIR, 5)), 'pointerdown', { pointerType: '' })
  B.geste(b, caseM(b, jourDuMois(MOIS_A_VENIR, 8)), 'pointerenter', { pointerType: '' })
  assert.equal(b.cal.etat.sel, null, 'aucune selection sans appui long')
})
