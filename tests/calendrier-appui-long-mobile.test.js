// tests/calendrier-appui-long-mobile.test.js
//
// LE TELEPHONE : APPUI COURT = SELECTION, APPUI LONG = FICHE DU JOUR, ET
// L'APPUI LONG TIENT MALGRE LE TREMBLEMENT DU DOIGT.
//
// Constate par Thierry le 23 novembre 2026, sur Android : un appui long sur une
// date de /calendrier ouvrait la fiche du jour (« Configurer les dates ») au
// lieu de poser la selection et la barre d'actions (Prix, Fermer a la vente,
// Bloquer les dates, Reservation, Plus…). Cause : un doigt pose « immobile »
// bouge d'un ou deux pixels, le telephone envoie des `pointermove`, et la page
// annulait l'appui long au PREMIER. La barre etait donc inatteignable au
// telephone.
//
// Deux corrections, decidees par Thierry le meme jour :
//   1. les deux gestes s'INVERSENT : l'appui court selectionne et fait paraitre
//      la barre, comme le clic de l'ordinateur ; l'appui long ouvre la fiche du
//      jour, au relachement ;
//   2. l'appui long ne s'annule qu'au-dela de 10 px sur un axe, et seulement
//      pour le doigt qui a commence le geste.
//
// La review du lot a ajoute trois gardes, testees ici aussi : le clic
// fantome qui suit le relachement est avale ; au doigt, la case du
// relachement est celle SOUS LE DOIGT (capture implicite) ; une selection sur
// un autre bien est remplacee, jamais etendue.
//
// Contre-epreuve (REVIEW.md regle 19) : le compte rendu du lot donne, test par
// test, le resultat contre le code d'avant (`main`) et contre les versions
// naives du correctif (docs/specs/spec-appui-long-mobile.md §4).

const test = require('node:test')
const assert = require('node:assert/strict')
const B = require('./outils/banc-calendrier.js')

const BIEN = {
  id: 'B1', name: 'Ofuro Futari', provider: 'channex', capacity: 2, currency: 'EUR',
  pilote_tarifaire: 'calendrier', provider_property_id: 'P1', base_price: null,
  included_guests: 2, extra_guest_fee: 0
}
const inventaire = (jours) =>
  ({ B1: Object.fromEntries(jours.map(iso => [iso, { date: iso, rate: 199, avail: 1, stop_sell: false }])) })

// Le mois SUIVANT, rendu au telephone : toutes ses dates sont a venir, quel que
// soit le jour ou la suite tourne.
const moisDecale = (n) => {
  const d = new Date()
  d.setDate(1)
  d.setMonth(d.getMonth() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
const MOIS_A_VENIR = moisDecale(1)
const jourDuMois = (n) => `${MOIS_A_VENIR}-${String(n).padStart(2, '0')}`

// Le banc du telephone, avec un vibreur espion : le retour tactile est la
// trace que l'appui long a ete PRIS, independamment de ce qui s'ouvre ensuite.
function bancMobile () {
  const b = B.monter({ large: false, appel: async () => ({ saved: 1, pushed: true, local_only: false, push_failed: false, warnings: [] }) })
  const o = { biens: [BIEN], jours: 3, decalage: 0, mois: MOIS_A_VENIR }
  const jours = B.peupler(b, o)
  B.peupler(b, { ...o, inv: inventaire(jours) })
  b.vibrations = []
  Object.defineProperty(b.window.navigator, 'vibrate', {
    configurable: true, value: (ms) => { b.vibrations.push(ms); return true }
  })
  return b
}
const caseM = (b, iso) => {
  const el = b.doc.querySelector(`.cal-case[data-case="${iso}"][data-bien="B1"]`)
  assert.ok(el, `case ${iso} absente de la grille rendue`)
  return el
}
const doigt = (o = {}) => ({ pointerType: 'touch', pointerId: 1, ...o })
const attendre = (ms) => new Promise(r => setTimeout(r, ms))
const ficheOuverte = (b) => !b.doc.querySelector('[data-bind="feuille"]').hidden
const ficheDu = (b) => b.doc.querySelector('[data-champ="cfg-du"]')?.value
const selection = (b) => [...b.cal.joursSelection()]
const tap = (b, el, o = {}) => {
  B.geste(b, el, 'pointerdown', doigt(o))
  B.geste(b, el, 'pointerup', doigt(o))
}

test('1. un appui COURT selectionne la date et fait paraitre la barre, sans ouvrir la fiche', () => {
  const b = bancMobile()
  const iso = jourDuMois(12)
  assert.equal(B.barreVisible(b), false, 'aucune barre avant le geste')
  tap(b, caseM(b, iso), { x: 100, y: 200 })
  assert.deepEqual(selection(b), [iso], 'la date tapee est selectionnee')
  assert.ok(B.barreVisible(b), 'la barre d actions parait')
  assert.ok(b.doc.querySelector('[data-action="bloquer"]'), 'Bloquer les dates est atteignable')
  assert.equal(ficheOuverte(b), false, 'la fiche du jour ne s ouvre pas')
})

test('2. un second appui court sur une autre date du meme bien ETEND la selection', () => {
  const b = bancMobile()
  tap(b, caseM(b, jourDuMois(12)))
  tap(b, caseM(b, jourDuMois(15)))
  assert.deepEqual(selection(b), [jourDuMois(12), jourDuMois(13), jourDuMois(14), jourDuMois(15)])
  assert.equal(ficheOuverte(b), false)
})

test('3. un appui LONG qui tremble de 1 ou 2 pixels est pris, et ouvre la fiche du jour tenu', async () => {
  const b = bancMobile()
  const iso = jourDuMois(12)
  const c = caseM(b, iso)
  B.geste(b, c, 'pointerdown', doigt({ x: 100, y: 200 }))
  // Le tremblement d'un doigt immobile, tel que le telephone le signale.
  B.geste(b, c, 'pointermove', doigt({ x: 101, y: 201 }))
  B.geste(b, c, 'pointermove', doigt({ x: 102, y: 199 }))
  B.geste(b, c, 'pointermove', doigt({ x: 100, y: 202 }))
  await attendre(500)
  assert.deepEqual(b.vibrations, [15], 'l appui long est pris : le doigt le sent')
  assert.equal(ficheOuverte(b), false, 'rien ne s ouvre sous le doigt encore pose')
  B.geste(b, c, 'pointerup', doigt({ x: 101, y: 200 }))
  assert.equal(ficheOuverte(b), true, 'au relachement, la fiche du jour s ouvre')
  assert.equal(ficheDu(b), iso, 'sur la date tenue')
  assert.equal(b.cal.etat.sel, null, 'et aucune selection')
  assert.equal(B.barreVisible(b), false)
})

test('4. un vrai deplacement du doigt (30 px) annule l appui long : relache sur la case, c est un appui court', async () => {
  const b = bancMobile()
  const iso = jourDuMois(12)
  const c = caseM(b, iso)
  B.geste(b, c, 'pointerdown', doigt({ x: 100, y: 200 }))
  B.geste(b, c, 'pointermove', doigt({ x: 100, y: 230 }))
  await attendre(500)
  assert.deepEqual(b.vibrations, [], 'l appui long n est pas pris')
  B.geste(b, c, 'pointerup', doigt({ x: 100, y: 230 }))
  assert.equal(ficheOuverte(b), false, 'pas de fiche du jour')
  assert.deepEqual(selection(b), [iso], 'un appui court : la date est selectionnee')
})

test('5. un defilement (le navigateur annule le geste) n arme rien, meme sous la tolerance', async () => {
  // Le navigateur peut prendre la main pour faire defiler AVANT nos 10 px
  // (Android commence vers 8). C'est alors `pointercancel`, et lui seul, qui
  // doit clore le geste : le deplacement ici reste SOUS la tolerance.
  const b = bancMobile()
  const c = caseM(b, jourDuMois(12))
  B.geste(b, c, 'pointerdown', doigt({ x: 100, y: 200 }))
  B.geste(b, c, 'pointermove', doigt({ x: 100, y: 208 }))
  B.geste(b, c, 'pointercancel', doigt({ x: 100, y: 208 }))
  await attendre(500)
  assert.deepEqual(b.vibrations, [])
  assert.equal(b.cal.etat.sel, null, 'aucune selection')
  assert.equal(ficheOuverte(b), false, 'aucune fiche')
})

test('6. la tolerance vaut sur chaque axe : 11 px a l horizontale annulent l appui long', async () => {
  const b = bancMobile()
  const iso = jourDuMois(12)
  const c = caseM(b, iso)
  B.geste(b, c, 'pointerdown', doigt({ x: 100, y: 200 }))
  B.geste(b, c, 'pointermove', doigt({ x: 111, y: 200 }))
  await attendre(500)
  assert.deepEqual(b.vibrations, [], 'au-dela de la tolerance, l appui long est annule')
  B.geste(b, c, 'pointerup', doigt({ x: 111, y: 200 }))
  assert.deepEqual(selection(b), [iso], 'et le relachement vaut appui court')
})

test('7. le mouvement d un SECOND doigt n annule pas l appui long du premier', async () => {
  const b = bancMobile()
  const a = jourDuMois(12)
  B.geste(b, caseM(b, a), 'pointerdown', doigt({ x: 100, y: 200 }))
  // Un second doigt bouge franchement ailleurs (pince, paume posee).
  B.geste(b, caseM(b, jourDuMois(20)), 'pointermove', doigt({ pointerId: 2, x: 300, y: 500 }))
  await attendre(500)
  assert.deepEqual(b.vibrations, [15], 'l appui long du premier doigt a tenu')
  B.geste(b, caseM(b, a), 'pointerup', doigt({ x: 100, y: 200 }))
  assert.equal(ficheDu(b), a, 'la fiche est celle de la date du premier doigt')
})

test('8. un appui long relache HORS de sa case n ouvre rien, meme sous capture implicite', async () => {
  // Au doigt, le `pointerup` est TOUJOURS adresse a la case de depart (capture
  // implicite du pointeur). Le banc le reproduit : le relachement part de la
  // case, et c'est `elementFromPoint` qui dit ce qu'il y a sous le doigt.
  const b = bancMobile()
  const c = caseM(b, jourDuMois(12))
  const ailleurs = b.doc.querySelector('[data-bind="toasts"]')
  b.doc.elementFromPoint = (x, y) => (x === 100 && y === 200) ? c : ailleurs
  B.geste(b, c, 'pointerdown', doigt({ x: 100, y: 200 }))
  await attendre(500)
  B.geste(b, c, 'pointerup', doigt({ x: 100, y: 600 }))   // le doigt s'est leve ailleurs
  assert.equal(ficheOuverte(b), false, 'l hote a abandonne : aucune fiche')
  assert.equal(b.cal.etat.sel, null, 'et aucune selection')
  // Et sous le doigt, c'est bien la case : la fiche s'ouvre.
  B.geste(b, c, 'pointerdown', doigt({ x: 100, y: 200 }))
  await attendre(500)
  B.geste(b, c, 'pointerup', doigt({ x: 100, y: 200 }))
  assert.equal(ficheDu(b), jourDuMois(12))
})

test('9. un appui long sur une date vide la selection en cours avant d ouvrir sa fiche', async () => {
  const b = bancMobile()
  tap(b, caseM(b, jourDuMois(5)))
  tap(b, caseM(b, jourDuMois(8)))
  assert.equal(selection(b).length, 4, 'quatre nuits selectionnees')
  const iso = jourDuMois(20)
  B.geste(b, caseM(b, iso), 'pointerdown', doigt())
  await attendre(500)
  B.geste(b, caseM(b, iso), 'pointerup', doigt())
  assert.equal(ficheDu(b), iso, 'la fiche du jour tenu s ouvre')
  assert.equal(b.cal.etat.sel, null, 'la selection est videe')
  assert.equal(B.barreVisible(b), false, 'la barre ne reste pas derriere la fiche')
})

test('10. le menu contextuel de l appui long est retenu pendant le geste du doigt', () => {
  const b = bancMobile()
  const c = caseM(b, jourDuMois(12))
  B.geste(b, c, 'pointerdown', doigt())
  const e = new b.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  c.dispatchEvent(e)
  assert.equal(e.defaultPrevented, true, 'le menu du telephone ne vole pas le relachement')
  B.geste(b, c, 'pointerup', doigt())
  const e2 = new b.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  c.dispatchEvent(e2)
  assert.equal(e2.defaultPrevented, false, 'hors geste, le menu n est pas touche')
})

// ─── Le clic fantome (constat 1 de la review) ──────────────────────────────
// Au doigt, le navigateur envoie un `click` apres le relachement, cible
// recalculee a la position du doigt dans la page que le geste vient de
// changer. Le banc le reproduit en tirant ce `click` sur le bouton qui serait
// maintenant sous le doigt. « Plus… » de la barre sert de temoin : il agit
// sans reseau, et son effet (la fiche s'ouvre) se lit sans ambiguite.
const plus = (b) => b.doc.querySelector('[data-action="plus"]')

test('11. le clic fantome qui suit un appui court est avale : la barre neuve sous le doigt n agit pas', () => {
  const b = bancMobile()
  const iso = jourDuMois(12)
  tap(b, caseM(b, iso), { x: 100, y: 600 })
  assert.ok(B.barreVisible(b))
  const e = B.geste(b, plus(b), 'click', { x: 101, y: 601 })     // detail = 1 : il vient du doigt
  assert.equal(e.defaultPrevented, true, 'le clic fantome est avale')
  assert.equal(ficheOuverte(b), false, 'le bouton sous le doigt n a pas agi')
  assert.deepEqual(selection(b), [iso])
})

test('12 a. un vrai clic LOIN du doigt agit normalement', () => {
  const b = bancMobile()
  tap(b, caseM(b, jourDuMois(12)), { x: 100, y: 200 })
  B.geste(b, plus(b), 'click', { x: 100, y: 600 })
  assert.equal(ficheOuverte(b), true)
})

test('12 b. un clic au CLAVIER n est jamais avale', () => {
  const b = bancMobile()
  tap(b, caseM(b, jourDuMois(12)), { x: 100, y: 200 })
  B.clicClavier(b, plus(b))                                       // detail = 0
  assert.equal(ficheOuverte(b), true)
})

test('12 c. passe le delai, un clic au meme endroit agit', async () => {
  const b = bancMobile()
  tap(b, caseM(b, jourDuMois(12)), { x: 100, y: 200 })
  await attendre(750)
  B.geste(b, plus(b), 'click', { x: 100, y: 200 })
  assert.equal(ficheOuverte(b), true)
})

test('13. le clic fantome n est avale qu UNE fois', () => {
  const b = bancMobile()
  tap(b, caseM(b, jourDuMois(12)), { x: 100, y: 200 })
  B.geste(b, plus(b), 'click', { x: 100, y: 200 })                // le fantome
  assert.equal(ficheOuverte(b), false, 'le fantome est avale')
  B.geste(b, plus(b), 'click', { x: 100, y: 200 })                // un vrai second toucher
  assert.equal(ficheOuverte(b), true, 'le clic suivant agit')
})

test('14. le clic fantome qui suit un appui long ne tombe pas dans la fiche qui vient de s ouvrir', async () => {
  const b = bancMobile()
  const c = caseM(b, jourDuMois(12))
  B.geste(b, c, 'pointerdown', doigt({ x: 100, y: 200 }))
  await attendre(500)
  B.geste(b, c, 'pointerup', doigt({ x: 100, y: 200 }))
  assert.equal(ficheOuverte(b), true)
  const enregistrer = b.doc.querySelector('[data-cfg-save]')
  assert.ok(enregistrer, 'le bouton Enregistrer de la fiche sert de cible')
  const e = B.geste(b, enregistrer, 'click', { x: 100, y: 200 })
  await attendre(0)
  assert.equal(e.defaultPrevented, true, 'le clic fantome est avale')
  assert.equal(b.envois.filter(x => x.methode === 'POST').length, 0, 'rien n est enregistre')
})

// ─── Deux biens empiles au telephone (constat 3 de la review) ───────────────
const BIEN2 = { ...BIEN, id: 'B2', name: 'La bulle', provider_property_id: 'P2' }
function bancDeuxBiens () {
  const b = B.monter({ large: false, appel: async () => ({ saved: 1, pushed: true, local_only: false, push_failed: false, warnings: [] }) })
  const o = { biens: [BIEN, BIEN2], jours: 3, decalage: 0, mois: MOIS_A_VENIR }
  const jours = B.peupler(b, o)
  const inv = { ...inventaire(jours), B2: inventaire(jours).B1 }
  B.peupler(b, { ...o, inv })
  return b
}
const caseDe = (b, bien, iso) => {
  const el = b.doc.querySelector(`.cal-case[data-case="${iso}"][data-bien="${bien}"]`)
  assert.ok(el, `case ${bien} ${iso} absente de la grille rendue`)
  return el
}

test('15. deux biens : un appui court sur le second bien REMPLACE la selection du premier, il ne l etend pas', () => {
  const b = bancDeuxBiens()
  tap(b, caseDe(b, 'B1', jourDuMois(5)))
  tap(b, caseDe(b, 'B2', jourDuMois(9)))
  assert.equal(b.cal.etat.sel.bien, 'B2', 'la barre agira sur le bien tape, pas sur l autre')
  assert.deepEqual(selection(b), [jourDuMois(9)])
})

test('16. deux biens : un appui long sur le second bien ouvre SA fiche et vide la selection du premier', async () => {
  const b = bancDeuxBiens()
  tap(b, caseDe(b, 'B1', jourDuMois(5)))
  tap(b, caseDe(b, 'B1', jourDuMois(7)))
  const c = caseDe(b, 'B2', jourDuMois(20))
  B.geste(b, c, 'pointerdown', doigt())
  await attendre(500)
  B.geste(b, c, 'pointerup', doigt())
  assert.equal(ficheDu(b), jourDuMois(20))
  assert.equal(b.cal.etat.sel, null, 'la selection du premier bien est videe')
  assert.equal(B.barreVisible(b), false)
})
