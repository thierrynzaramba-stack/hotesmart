// tests/lecture-seule.test.js
// Vague 2 : aucun bouton d'ecriture visible pour un membre en LECTURE.
//
// ⚠ LE CONSTAT DU TEST HUMAIN. Bascule avec `menages: read`, le bouton
// « ✓ Marquer fait » restait ACTIF dans le planning.
//
// Diagnostic : ce bouton n'ecrit RIEN en base — il ne touche que le
// localStorage. Donc ni faille de perimetre, ni refus serveur : une troisieme
// possibilite que la question n'envisageait pas. Il n'en devait pas moins
// disparaitre, car il donne l'illusion d'une action partagee.
//
// La regle que ces tests figent : sur une page delegable, TOUT declencheur
// d'ecriture est retire quand le droit manque. Pas grise — retire, avec un
// message qui dit pourquoi.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const lire = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')

// Chaque page delegable, avec le domaine qui commande ses ecritures.
const PAGES = [
  ['apps/menages/index.html',        'menages'],
  ['apps/agent-ai/messagerie.html',  'messages'],
  ['pages/biens-calendrier.html',    'reservations'],
  ['pages/calendrier-mobile.html',   'reservations'],
  ['pages/biens.html',               'reservations'],
  ['pages/index.html',               'reservations']
]

for (const [page, domaine] of PAGES) {
  test(`${page} : garde ses ecritures derriere un droit`, () => {
    const html = lire(page)
    assert.ok(/peutEcrire\s*\(|estTitulaire\s*\(/.test(html),
      `${page} ecrit sans jamais consulter les droits`)
  })
}

test('menages : « Marquer fait » disparait en lecture seule', () => {
  // Le constat exact du test humain.
  const html = lire('apps/menages/index.html')
  const i = html.indexOf("if (!peutEcrire('menages'))")
  assert.ok(i > 0, 'le bloc de lecture seule doit exister')
  const bloc = html.slice(i, i + 700)
  assert.ok(bloc.includes("getElementById('modal-done')"),
    '« Marquer fait » doit etre retire comme le champ de note')
  assert.ok(bloc.includes("getElementById('btn-save-comment')"),
    'le bouton d\'enregistrement de note aussi')
})

test('menages : openModal ne suppose pas le bouton present', () => {
  // ⚠ Retirer un element sans proteger ce qui le lit ensuite casse la page pour
  // le membre — exactement le genre de regression que ce lot doit eviter.
  const html = lire('apps/menages/index.html')
  const i = html.indexOf("const btn = document.getElementById('modal-done')")
  assert.ok(i > 0)
  assert.ok(html.slice(i, i + 160).includes('if (btn)'),
    'le code qui suit doit tolerer un bouton absent')
})

test('calendrier : ni edition en ligne ni barre d\'action en lecture', () => {
  const html = lire('pages/biens-calendrier.html')
  assert.ok(html.includes("function startInlineEdit(cell,idx,initial){ if(!peutEcrire('reservations'))return;"),
    'l\'edition en ligne doit refuser avant d\'ouvrir le champ')
  assert.ok(html.includes('function appliquerLectureSeule'),
    'les declencheurs d\'ecriture doivent etre retires')
  assert.ok(html.includes('avis-lecture'), 'et la raison affichee')
})

test('calendrier mobile : la feuille d\'edition ne s\'ouvre pas', () => {
  const html = lire('pages/calendrier-mobile.html')
  const i = html.indexOf('function openSheet(iso, openKey){')
  assert.ok(i > 0)
  assert.ok(html.slice(i, i + 220).includes("peutEcrire('reservations')"),
    'openSheet doit refuser avant de proposer une saisie')
})

test('messagerie : la zone de composition disparait en lecture', () => {
  const html = lire('apps/agent-ai/messagerie.html')
  assert.ok(html.includes("peutEcrire('messages') ?"), 'la composition est conditionnee')
  assert.ok(html.includes('Lecture seule — vous ne pouvez pas répondre'),
    'et remplacee par une explication')
})

// ─── La limite Beds24, rendue explicite ─────────────────────────────────────

test('calendrier : les biens Beds24 sont annonces, pas seulement grises', () => {
  // ⚠ La mention vivait dans le selecteur multiple : il fallait l'OUVRIR pour la
  // voir. Un hote 100 % Beds24 arrivait sur un calendrier vide sans explication.
  const html = lire('pages/biens-calendrier.html')
  assert.ok(html.includes('function annoncerBiensBeds24'), 'une annonce doit exister')
  assert.ok(html.includes('avis-beds24'), 'et un emplacement pour l\'afficher')
  assert.ok(html.includes('Aucun bien pilotable ici'),
    'le cas « que du Beds24 » doit avoir son propre message')
})

test('calendrier mobile : les biens Beds24 sont exclus ET annonces', () => {
  // Cette page les PROPOSAIT : l'hote decouvrait le refus a l'enregistrement.
  const html = lire('pages/calendrier-mobile.html')
  assert.ok(html.includes("BIENS = TOUS.filter(b => b.provider !== 'beds24')"),
    'les biens Beds24 ne doivent plus etre selectionnables')
  assert.ok(html.includes('avis-beds24'), 'et leur absence doit etre expliquee')
  assert.ok(html.includes('Aucun bien pilotable ici'),
    'y compris quand le perimetre ne contient que du Beds24')
})
