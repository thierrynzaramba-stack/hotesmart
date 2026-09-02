// tests/pages-ids.test.js
// Coherence entre les `id` presents dans le HTML et ceux que le script appelle.
//
// ⚠ POURQUOI CE TEST EXISTE. Un refactor de /settings a retire un element du
// HTML en laissant la ligne `$('note-mode').style.display = …` dans le script.
// `$()` renvoie null, l'acces a `.style` leve un TypeError — et comme il se
// produisait AVANT l'ouverture de la modale, plus aucun profil ne pouvait etre
// cree ni modifie. La page etait morte.
//
// Les 71 tests de l'endpoint n'ont rien vu : ils couvrent le serveur, et seule
// la page avait change. Ce test comble exactement cet angle mort — il est
// grossier (analyse textuelle, pas un DOM), mais il attrape la classe d'erreur
// qui nous a coutee une regression totale.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const PAGES = ['pages/settings.html', 'pages/invitation.html']

// `$('x')`, `getElementById('x')`, `querySelector('#x')`
const APPELS = [
  /\$\(\s*'([A-Za-z0-9_-]+)'\s*\)/g,
  /getElementById\(\s*'([A-Za-z0-9_-]+)'\s*\)/g,
  /querySelector\(\s*'#([A-Za-z0-9_-]+)'\s*\)/g
]

// ⚠ Les COMMENTAIRES sont retires avant analyse. Un `$('x')` cite dans une
// explication n'est pas un appel, et un commentaire qui raconte pourquoi un id a
// ete supprime ne doit pas compter comme un residu.
function sansCommentaires (texte) {
  return texte
    .replace(/<!--[\s\S]*?-->/g, '')   // commentaires HTML
    .replace(/\/\*[\s\S]*?\*\//g, '')   // blocs /* */
    .replace(/^\s*\/\/.*$/gm, '')       // lignes //
}

function analyser (fichier) {
  const html = sansCommentaires(fs.readFileSync(path.join(__dirname, '..', fichier), 'utf8'))

  const presents = new Set()
  for (const m of html.matchAll(/\sid=["']([A-Za-z0-9_-]+)["']/g)) presents.add(m[1])

  // Les ids crees dynamiquement comptent aussi : innerHTML, createElement, etc.
  for (const m of html.matchAll(/id=["']\$\{[^}]*\}["']/g)) void m
  for (const m of html.matchAll(/\bid\s*=\s*['"`]([A-Za-z0-9_-]+)['"`]/g)) presents.add(m[1])

  const references = new Set()
  for (const re of APPELS) for (const m of html.matchAll(re)) references.add(m[1])

  return { presents, references }
}

for (const fichier of PAGES) {
  test(`${fichier} : tout id appele par le script existe dans le HTML`, () => {
    const { presents, references } = analyser(fichier)
    const manquants = [...references].filter(id => !presents.has(id))
    assert.deepStrictEqual(manquants, [],
      `id référencés par le script mais absents du HTML : ${manquants.join(', ')}`)
  })
}

test('settings : les ids cles de la page Equipe sont bien la', () => {
  // Garde-fou explicite sur ce que la page ne peut pas perdre sans casser.
  const { presents } = analyser('pages/settings.html')
  // `f-self` a disparu avec « Droits sur ses propres données » — résidu des
  // prestataires, qui ne se gèrent plus ici.
  for (const id of ['liste', 'overlay', 'p-titre', 'f-prenom', 'f-scope',
                    'f-biens', 'f-domaines', 'zone-acces',
                    'btn-ajouter', 'btn-enregistrer', 'btn-annuler', 'msg']) {
    assert.ok(presents.has(id), `id manquant dans le HTML : ${id}`)
  }
})

test('settings : les prestataires ne sont plus references par la page', () => {
  // Le retrait doit etre complet : un residu d'id rouvrirait la porte a une
  // reference morte.
  const html = sansCommentaires(fs.readFileSync(path.join(__dirname, '..', 'pages/settings.html'), 'utf8'))
  for (const mort of ['liste-presta', 'btn-ajouter-presta', 'note-presta', 'note-mode',
                      'note-perimetre', 'f-self', 'bloc-modeles', 'data-modele']) {
    assert.ok(!html.includes(mort), `residu de l'ancienne version : ${mort}`)
  }
})

test('settings : le panneau de droits est reduit a QUATRE blocs', () => {
  // ⚠ La demande etait « simplification maximale ». Ce test fige la structure :
  // Identite, Biens, Droits, Acces — et rien d'autre.
  const html = sansCommentaires(fs.readFileSync(path.join(__dirname, '..', 'pages/settings.html'), 'utf8'))
  for (const titre of ['Identité', 'Biens', 'Droits']) {
    assert.ok(html.includes(`<div class="bloc-titre">${titre}`), `bloc manquant : ${titre}`)
  }
  assert.ok(html.includes("id=\"zone-acces\""), 'le bloc Accès est rendu par le script')
  // ⚠ On COMPTE, sinon le test ne tient pas sa promesse : rien n'empechait
  // d'ajouter un cinquieme bloc alors que le commentaire dit « et rien d'autre ».
  const blocs = (html.match(/class="bloc"/g) || []).length
  assert.strictEqual(blocs, 4, `le panneau doit avoir exactement 4 blocs, trouve ${blocs}`)
})

test('settings : les huit domaines, et une seule phrase visible', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'pages/settings.html'), 'utf8')
  // ⚠ On cherche dans la TABLE `DOMAINES`, pas n'importe ou dans le fichier :
  // `html.includes("'menages'")` matchait le mot cite dans un commentaire ou une
  // URL, et aurait passe meme avec un domaine retire du formulaire.
  // ⚠ La fin du tableau est le `]` en DEBUT DE LIGNE : `indexOf(']')` tombait sur
  // celui de la premiere entree, et la tranche ne contenait qu'un domaine.
  const debutTable = html.indexOf('const DOMAINES = [')
  const table = html.slice(debutTable, html.indexOf('\n]', debutTable))
  for (const d of ['reservations', 'menages', 'prestataires', 'messages',
                   'avis', 'reglages', 'facturation', 'equipe']) {
    assert.ok(table.includes(`'${d}'`), `domaine absent de DOMAINES : ${d}`)
  }
  assert.ok(html.includes('Facturation et Équipe ne se délèguent pas en écriture.'),
    'la seule phrase visible du bloc Droits')
  // Les trois choix, dans le vocabulaire demande.
  assert.ok(html.includes("['none', 'Rien'], ['read', 'Voir'], ['write', 'Modifier']"),
    'les trois choix doivent etre Rien / Voir / Modifier')
})

test('settings : chaque domaine porte une infobulle, aucun sous-texte', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'pages/settings.html'), 'utf8')
  assert.ok(html.includes('data-aide='), 'les explications passent par des infobulles')
  assert.ok(!html.includes('dom-hint'),
    'plus de sous-texte sous chaque domaine : huit paragraphes noyaient la regle')
})

test('settings : l\'aide reste atteignable au doigt et au lecteur d\'ecran', () => {
  // ⚠ Reservee au :hover, elle etait muette sur mobile et pour un lecteur
  // d'ecran — alors qu'elle porte des regles. `title` est le repli universel.
  const html = sansCommentaires(fs.readFileSync(path.join(__dirname, '..', 'pages/settings.html'), 'utf8'))
  const infobulles = html.match(/<span class="info"[^>]*>/g) || []
  assert.ok(infobulles.length > 0, 'des infobulles doivent exister')
  for (const s of infobulles) {
    assert.ok(/title=/.test(s), `infobulle sans title : ${s.slice(0, 70)}`)
    assert.ok(!/role="button"/.test(s), 'role="button" annonce un bouton qui ne fait rien')
  }
})

test('settings : la regle du perimetre est en TEXTE VISIBLE', () => {
  // Elle decide de ce que voit un collaborateur quand un bien est ajoute plus
  // tard : elle ne peut pas dependre d'un survol.
  const html = sansCommentaires(fs.readFileSync(path.join(__dirname, '..', 'pages/settings.html'), 'utf8'))
  assert.ok(html.includes('Une sélection reste figée'), 'la regle doit etre lisible sans survol')
  assert.ok(html.includes('y compris ceux ajoutés plus tard'),
    'le libelle « tous les biens » doit dire ce qu\'il inclut')
})

test('settings : Renouveler est AVEC le lien, Desactiver est SEUL', () => {
  const html = sansCommentaires(fs.readFileSync(path.join(__dirname, '..', 'pages/settings.html'), 'utf8'))
  // ⚠ On decoupe sur le TEMPLATE, pas sur la feuille de style : `lien-box` et
  // `zone-danger` y apparaissent d'abord comme selecteurs CSS, et le test
  // decoupait donc dans le mauvais bloc — il passait sans rien verifier.
  const debutLien = html.indexOf('id="f-lien"')
  const debutDanger = html.indexOf('class="zone-danger"', debutLien)
  assert.ok(debutLien > 0 && debutDanger > debutLien, 'structure attendue introuvable')

  const boiteLien = html.slice(debutLien, debutDanger)
  assert.ok(boiteLien.includes('btn-regen'), 'Renouveler appartient a la boite du lien')

  // ⚠ Borne a la FIN DU TEMPLATE (`z.appendChild`) : sans elle, la tranche
  // courait jusqu'aux gestionnaires d'evenements en bas de fichier, ou
  // `$('btn-regen').onclick` figure forcement — le test echouait sur du code
  // qui n'a rien a voir avec la mise en page.
  const finTemplate = html.indexOf('z.appendChild(bloc)', debutDanger)
  const boiteDanger = html.slice(debutDanger, finTemplate)
  assert.ok(boiteDanger.includes('btn-activite'), 'Desactiver est isole dans sa zone')
  assert.ok(!boiteDanger.includes('btn-regen'), 'Renouveler n\'est plus dans la zone de danger')
})

test('settings : le lien vers Prestataires respecte cleanUrls', () => {
  const html = sansCommentaires(fs.readFileSync(path.join(__dirname, '..', 'pages/settings.html'), 'utf8'))
  assert.ok(html.includes('/apps/menages/prestataires"'), 'le lien doit exister')
  assert.ok(!html.includes('/apps/menages/prestataires.html"'),
    'cleanUrls est actif : un .html provoque une redirection 308 inutile')
})
