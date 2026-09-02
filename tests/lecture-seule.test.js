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

test('calendrier : la barre flottante n\'est PAS supprimee du DOM', () => {
  // ⚠ La supprimer provoquait un TypeError a chaque clic : `showFloatBar()` et
  // `btn-clear-sel` la lisent. La selection restait surlignee, sans aucun moyen
  // de l'effacer. On bloque la selection en amont, on ne retire pas le noeud.
  const html = lire('pages/biens-calendrier.html')
  const i = html.indexOf('function appliquerLectureSeule')
  const bloc = html.slice(i, i + 900)
  assert.ok(!/float-bar'\)[^\n]*remove\(\)/.test(bloc),
    'float-bar ne doit pas etre retiree : d\'autres fonctions la lisent')
  assert.ok(bloc.includes('LECTURE_SEULE = true'), 'un drapeau doit bloquer la selection')
  assert.ok(html.includes('function attachEvents(){ if(LECTURE_SEULE) return;'),
    'la selection ne doit pas demarrer du tout en lecture seule')
})

test('calendrier : showFloatBar tolere un DOM incomplet', () => {
  const html = lire('pages/biens-calendrier.html')
  const i = html.indexOf('function showFloatBar()')
  const ligne = html.slice(i, i + 220)
  assert.ok(/if\(!floatBar\|\|!c\)return/.test(ligne),
    'showFloatBar doit sortir plutot que de derefercer null')
})

test('calendrier : le masquage precede le return de l\'etat vide', () => {
  // Un membre dont le perimetre ne resout aucun bien, ou un echec reseau,
  // gardait sinon les boutons d'ecriture et ne voyait jamais l'avis.
  const html = lire('pages/biens-calendrier.html')
  const iGarde = html.indexOf('appliquerLectureSeule()')
  const iVide  = html.indexOf('Votre calendrier apparaîtra ici')
  assert.ok(iGarde > 0 && iVide > 0)
  assert.ok(iGarde < iVide, 'le masquage doit s\'appliquer avant toute sortie anticipee')
})

test('calendrier mobile : renderGrid tolere un <main> remplace', () => {
  // #view-select vit dans la topbar et survit au remplacement de <main> : il
  // rappelle renderGrid() sur un #grid disparu.
  const html = lire('pages/calendrier-mobile.html')
  const i = html.indexOf('function renderGrid(){')
  assert.ok(html.slice(i, i + 260).includes("if(!document.getElementById('grid')) return"),
    'renderGrid doit sortir quand la grille n\'existe plus')
})

test('calendrier mobile : un compte 100% Beds24 n\'est pas invite a se reconnecter', () => {
  // ⚠ Le bandeau disait « géré dans Beds24 » et l'etat vide, juste dessous,
  // « connectez votre PMS » — deux messages contradictoires, et un CTA qui pousse
  // vers une reconnexion inutile.
  const html = lire('pages/calendrier-mobile.html')
  assert.ok(html.includes('const queDuBeds24 = beds24.length > 0'),
    'les deux etats vides doivent etre distingues')
  assert.ok(html.includes('Rien à piloter ici'), 'le cas Beds24 a son propre message')
  const i = html.indexOf('Rien à piloter ici')
  const j = html.indexOf('Votre calendrier apparaîtra ici')
  assert.ok(i < j, 'le message Beds24 vient en premier dans le ternaire')
  const messageBeds24 = html.slice(i, j)
  assert.ok(!messageBeds24.includes('onboarding.html'),
    'aucun appel a reconnecter un PMS deja connecte')
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
