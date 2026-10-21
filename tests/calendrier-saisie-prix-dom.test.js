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
function banc ({ large = true, decalage = 0, reponse } = {}) {
  const b = B.monter({ large, appel: reponse || (async () => ({ saved: 1, pushed: true, local_only: false, push_failed: false, warnings: [] })) })
  const jours = B.peupler(b, { biens: [BIEN], jours: 1, decalage })
  B.peupler(b, { biens: [BIEN], inv: inventaire(jours), jours: 1, decalage })
  return { b, jours }
}

// Le geste de selection a la souris, sur l'ordinateur.
function glisser (b, cases, du, au) {
  B.geste(b, cases[du], 'mousedown')
  for (let i = du + 1; i <= au; i++) B.geste(b, cases[i], 'mouseenter')
  B.geste(b, b.doc, 'mouseup')
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
  B.geste(b, cases[2], 'mousedown')
  B.geste(b, b.doc, 'mouseup')
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

test('apres une selection, la cellule a le FOCUS : taper un chiffre ouvre la saisie sans perdre les jours', () => {
  const { b, jours } = banc({})
  const cases = B.casesBureau(b, 'B1')
  glisser(b, cases, 2, 5)
  assert.equal(b.doc.activeElement, cases[2],
    'la cellule prend le focus malgre le preventDefault du glisser')
  B.touche(b, b.doc.activeElement, '1')
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
  B.geste(b, cases[2], 'mousedown'); B.geste(b, b.doc, 'mouseup')
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
  B.geste(b, cases[2], 'mousedown'); B.geste(b, b.doc, 'mouseup')
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
// TELEPHONE (point 4) et VUE MOBILE A LA SOURIS (point 5)
// ═══════════════════════════════════════════════════════════════════════════

test('POINT 4 : au doigt, appui long puis extension, la rubrique Prix ecrit UN segment', async () => {
  const { b } = banc({ large: false })
  const cases = B.casesTelephone(b, 'B1')
  const futures = cases.filter(c => !c.dataset.passe)
  const a = futures[1], z = futures[4]
  B.geste(b, a, 'pointerdown', { pointerType: 'touch' })
  await new Promise(r => setTimeout(r, 500))           // appui LONG
  B.geste(b, a, 'pointerup', { pointerType: 'touch' })
  assert.ok(B.barreVisible(b), 'l appui long ouvre la barre d actions')
  // Un tap sur une seconde date ETEND la plage (comportement existant).
  B.geste(b, z, 'pointerdown', { pointerType: 'touch' })
  B.geste(b, z, 'pointerup', { pointerType: 'touch' })
  assert.equal(b.cal.joursSelection().length, 4, 'la plage est etendue, la popup ne s ouvre pas')

  b.cal.actionPrix(b.cal.joursSelection())
  const corps = b.doc.querySelector('[data-bind="feuille-corps"]')
  assert.ok(corps.querySelector('[data-champ="rate-valeur"]'), 'la rubrique Prix est la')
  corps.querySelector('[data-champ="rate-valeur"]').value = '175'
  corps.querySelector('[data-cfg-save]').click()
  await new Promise(r => setTimeout(r, 0))
  const posts = b.envois.filter(e => e.methode === 'POST')
  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0].corps.segments,
    [{ date_from: a.dataset.case, date_to: z.dataset.case, rate: 175 }], 'UN segment sur la plage')
  assert.equal(b.cal.etat.sel, null, 'la selection se vide')
  assert.equal(B.barreVisible(b), false)
})

test('POINT 5 : vue mobile A LA SOURIS, glisser selectionne une plage', () => {
  const { b } = banc({ large: false })
  const futures = B.casesTelephone(b, 'B1').filter(c => !c.dataset.passe)
  B.geste(b, futures[1], 'pointerdown', { pointerType: 'mouse' })
  B.geste(b, futures[2], 'pointerenter', { pointerType: 'mouse' })
  B.geste(b, futures[3], 'pointerenter', { pointerType: 'mouse' })
  B.geste(b, b.doc, 'pointerup', { pointerType: 'mouse' })
  assert.equal(b.cal.joursSelection().length, 3, 'trois nuits selectionnees a la souris')
  assert.ok(B.barreVisible(b), 'la barre d actions apparait')
  assert.equal(b.doc.querySelector('[data-bind="feuille"]').hidden, true,
    'le glisser n ouvre pas la popup')
})

test('POINT 5 : une date deja choisie, un clic de SOURIS sur une deuxieme etend la plage', () => {
  const { b } = banc({ large: false })
  const futures = B.casesTelephone(b, 'B1').filter(c => !c.dataset.passe)
  // Une premiere selection a la souris (glisser d une seule case = clic).
  B.geste(b, futures[1], 'pointerdown', { pointerType: 'mouse' })
  B.geste(b, futures[2], 'pointerenter', { pointerType: 'mouse' })
  B.geste(b, b.doc, 'pointerup', { pointerType: 'mouse' })
  assert.equal(b.cal.joursSelection().length, 2)
  // Puis un CLIC simple de souris sur une date plus loin.
  B.geste(b, futures[5], 'pointerdown', { pointerType: 'mouse' })
  B.geste(b, b.doc, 'pointerup', { pointerType: 'mouse' })
  // futures[1] -> futures[5] inclus : CINQ nuits.
  assert.equal(b.cal.joursSelection().length, 5, 'la plage est etendue, pas remplacee')
  assert.equal(b.doc.querySelector('[data-bind="feuille"]').hidden, true, 'la popup ne s est pas rouverte')
})

test('POINT 5 : sans selection, un clic de souris ouvre toujours la popup du jour', () => {
  const { b } = banc({ large: false })
  const futures = B.casesTelephone(b, 'B1').filter(c => !c.dataset.passe)
  B.geste(b, futures[3], 'pointerdown', { pointerType: 'mouse' })
  B.geste(b, b.doc, 'pointerup', { pointerType: 'mouse' })
  assert.equal(b.doc.querySelector('[data-bind="feuille"]').hidden, false, 'la popup du jour s ouvre')
  const du = b.doc.querySelector('[data-champ="cfg-du"]')
  assert.equal(du.value, futures[3].dataset.case, 'pre-remplie sur le jour clique')
})

// ═══════════════════════════════════════════════════════════════════════════
// POINT 7 : un jour passe se VOIT desactive
// ═══════════════════════════════════════════════════════════════════════════

test('POINT 7 : un jour passe porte aria-disabled, sur les deux ecrans', () => {
  const { b } = banc({ decalage: -10 })
  const passees = B.casesBureau(b, 'B1').filter(c => c.classList.contains('cal-nuit--passe'))
  assert.ok(passees.length > 0, 'la fenetre contient des jours passes')
  for (const c of passees) assert.equal(c.getAttribute('aria-disabled'), 'true', 'ordinateur')

  const m = banc({ large: false })
  const passeesM = B.casesTelephone(m.b, 'B1').filter(c => c.dataset.passe)
  assert.ok(passeesM.length > 0, 'le mois contient des jours passes')
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
  B.geste(b, passee, 'mousedown'); B.geste(b, b.doc, 'mouseup')
  assert.equal(b.cal.etat.sel, null, 'ordinateur : rien n est selectionne')
  assert.equal(B.saisie(b), null, 'ordinateur : aucune saisie ne s ouvre')

  const m = banc({ large: false })
  const passeeM = B.casesTelephone(m.b, 'B1').find(c => c.dataset.passe)
  B.geste(m.b, passeeM, 'pointerdown', { pointerType: 'mouse' })
  B.geste(m.b, m.b.doc, 'pointerup', { pointerType: 'mouse' })
  assert.equal(m.b.cal.etat.sel, null, 'telephone : rien n est selectionne')
  assert.equal(m.b.doc.querySelector('[data-bind="feuille"]').hidden, true, 'telephone : pas de popup')
})

test('Entree valide UNE fois : aucune seconde saisie ne se rouvre derriere', async () => {
  // Trouve par ce banc : la touche Entree remonte de la case de saisie a la
  // CELLULE, dont le `keydown` rouvrait aussitot une saisie — et un second
  // enregistrement partait au geste suivant.
  const { b } = banc({})
  const cases = B.casesBureau(b, 'B1')
  glisser(b, cases, 2, 5)
  B.geste(b, cases[2], 'mousedown'); B.geste(b, b.doc, 'mouseup')
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
  B.geste(b, cases[2], 'mousedown'); B.geste(b, b.doc, 'mouseup')
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
    const jours = B.peupler(b, { biens: [BIEN], jours: 1 })
    B.peupler(b, { biens: [BIEN], inv: inventaire(jours), jours: 1 })
    if (large) {
      const cases = B.casesBureau(b, 'B1')
      B.geste(b, cases[2], 'mousedown')
      B.geste(b, cases[4], 'mouseenter')
      B.geste(b, b.doc, 'mouseup')
      B.touche(b, cases[2], '1')
    } else {
      const futures = B.casesTelephone(b, 'B1').filter(c => !c.dataset.passe)
      B.geste(b, futures[1], 'pointerdown', { pointerType: 'mouse' })
      B.geste(b, futures[2], 'pointerenter', { pointerType: 'mouse' })
      B.geste(b, b.doc, 'pointerup', { pointerType: 'mouse' })
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
      const jours = B.peupler(b, { biens: [BIEN], jours: 1 })
      B.peupler(b, { biens: [BIEN], inv: inventaire(jours), jours: 1 })
      b.cal.etat.lectureSeule = lecture
      if (large) {
        const cases = B.casesBureau(b, 'B1')
        B.geste(b, cases[2], 'mousedown'); B.geste(b, b.doc, 'mouseup')
      } else {
        const futures = B.casesTelephone(b, 'B1').filter(c => !c.dataset.passe)
        B.geste(b, futures[1], 'pointerdown', { pointerType: 'mouse' })
        B.geste(b, b.doc, 'pointerup', { pointerType: 'mouse' })
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
  B.geste(b, cases[2], 'mousedown'); B.geste(b, b.doc, 'mouseup')
  assert.equal(B.saisie(b), null, 'aucune saisie ne s ouvre sur un bien pilote')
  assert.equal(b.lireToasts().length, 1, 'et l ecran le DIT')
  assert.match(b.lireToasts()[0], /pilot/i)
})
