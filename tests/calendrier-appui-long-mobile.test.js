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
// Contre-epreuve (REVIEW.md regle 19) : le compte rendu du lot donne, test par
// test, le resultat contre le code d'avant (`main`) et contre les deux
// versions naives du correctif (docs/specs/spec-appui-long-mobile.md §5).

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

test('8. un appui long relache HORS de sa case n ouvre rien', async () => {
  const b = bancMobile()
  B.geste(b, caseM(b, jourDuMois(12)), 'pointerdown', doigt())
  await attendre(500)
  B.geste(b, b.doc.querySelector('[data-bind="toasts"]'), 'pointerup', doigt())
  assert.equal(ficheOuverte(b), false, 'l hote a abandonne : aucune fiche')
  assert.equal(b.cal.etat.sel, null, 'et aucune selection')
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
