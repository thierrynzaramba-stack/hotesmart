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
  for (const id of ['liste', 'overlay', 'p-titre', 'f-prenom', 'f-scope',
                    'f-biens', 'f-domaines', 'f-self', 'zone-acces',
                    'btn-ajouter', 'btn-enregistrer', 'btn-annuler', 'msg']) {
    assert.ok(presents.has(id), `id manquant dans le HTML : ${id}`)
  }
})

test('settings : les prestataires ne sont plus references par la page', () => {
  // Le retrait doit etre complet : un residu d'id rouvrirait la porte a une
  // reference morte.
  const html = sansCommentaires(fs.readFileSync(path.join(__dirname, '..', 'pages/settings.html'), 'utf8'))
  for (const mort of ['liste-presta', 'btn-ajouter-presta', 'note-presta', 'note-mode', 'note-perimetre']) {
    assert.ok(!html.includes(mort), `residu de l'ancienne version : ${mort}`)
  }
})

test('settings : le lien vers Prestataires respecte cleanUrls', () => {
  const html = sansCommentaires(fs.readFileSync(path.join(__dirname, '..', 'pages/settings.html'), 'utf8'))
  assert.ok(html.includes('/apps/menages/prestataires"'), 'le lien doit exister')
  assert.ok(!html.includes('/apps/menages/prestataires.html"'),
    'cleanUrls est actif : un .html provoque une redirection 308 inutile')
})
