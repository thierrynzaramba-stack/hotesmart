// tests/yield-libelles-feries.test.js
// LE NOM COURANT D'UN FÉRIÉ, À L'AFFICHAGE, SANS TOUCHER AU MOTEUR.
//
// ⚠ DÉCISION DE THIERRY DU 2 NOVEMBRE 2026 : « correction à l'AFFICHAGE
// seulement, jamais dans le moteur. Le nom interne (la clé du segment et de
// ses réglages) ne change pas. » La recette du 1er novembre avait vu
// « Week-end du Armistice 1918 » : faux en français, et le nom officiel d'un
// férié n'est pas ce qu'un hôte a en tête.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const racine = path.join(__dirname, '..')
const lire = (f) => fs.readFileSync(path.join(racine, f), 'utf8')

// ⚠ LES NOMS VIENNENT DE LA SOURCE, PAS D'UNE LISTE RECOPIÉE. Une liste
// recopiée ici vieillirait en silence le jour où un férié serait ajouté,
// renommé, ou verrait son orthographe changer — et c'est précisément ce qui
// s'est produit en écrivant cette table (voir le test de l'apostrophe).
function feriesDuMoteur () {
  const src = lire('lib/yield/jours-feries.js')
  const noms = [...src.matchAll(/poser\(.+?,\s*'((?:[^'\\]|\\.)*)'\s*\)/g)]
    .map((m) => m[1].replace(/\\'/g, "'"))
  // ⚠ NON-VACUITÉ : une extraction vide satisferait toutes les assertions qui
  // suivent. Je m'y suis fait prendre deux fois en préparant cette table — un
  // motif `[^,]+` ne traversait pas `jourUTC(an, 11, 11)` et rendait zéro nom,
  // pendant que le contrôle annonçait « aucun férié sans entrée ».
  assert.ok(noms.length >= 10,
    `extraction des feries douteuse (${noms.length}) : la mesure ne vaut rien`)
  return noms
}

let T = null
test.before(async () => { ({ LIBELLE_FERIE: T } = await import('../shared/yield-libelles-feries.js')) })

test('LE TEST QUI COMPTE : les onze feries du moteur ont une entree, et aucune entree n est orpheline', () => {
  const noms = feriesDuMoteur()
  const sans = noms.filter((n) => !(n in T))
  const orphelines = Object.keys(T).filter((c) => !noms.includes(c))
  assert.deepEqual(sans, [],
    'ces feries n ont pas de libelle d affichage :\n' + sans.join('\n')
    + '\nIls rendraient « Week-end — <nom interne> », le repli, au lieu du nom courant.')
  assert.deepEqual(orphelines, [],
    'ces entrees ne correspondent a aucun ferie du moteur :\n' + orphelines.join('\n')
    + '\nUne entree qui ne sert a rien est une entree qui a vieilli.')
})

test('LE TEST QUI COMPTE : l apostrophe de la cle est celle du MOTEUR, pas la typographique', () => {
  // ⚠ CE TEST EXISTE PARCE QUE J'AI FAIT L'ERREUR. `lib/yield/jours-feries.js`
  // pose 'Jour de l\'An' avec U+0027 ; ecrite avec U+2019, la cle ne matche
  // JAMAIS et le repli rend « Week-end — Jour de l'An » sans que rien ne
  // rougisse. Le test ci-dessus l attrape deja ; celui-ci NOMME la cause, pour
  // que le prochain qui voit rouge sache quoi regarder.
  const cles = Object.keys(T).filter((c) => /[’']/.test(c))
  assert.ok(cles.length > 0, 'au moins une cle porte une apostrophe, sinon ce test ne mesure rien')
  const typographiques = cles.filter((c) => c.includes('’'))
  assert.deepEqual(typographiques, [],
    'ces cles portent une apostrophe TYPOGRAPHIQUE (U+2019) :\n' + typographiques.join('\n')
    + '\nLe moteur ecrit U+0027 : la recherche echouerait en silence.')
})

test('LE TEST QUI COMPTE : aucun « du » devant une voyelle, aucun « Lundi de »', () => {
  // Les deux fautes que la table existe pour empecher, et que Thierry a
  // nommees : « Week-end du Ascension » et « Week-end du Lundi de Paques ».
  const devantVoyelle = Object.entries(T)
    .filter(([, v]) => /^du [aeiouyàâéèêîïôûœh]/i.test(v)).map(([k, v]) => `${k} -> ${v}`)
  assert.deepEqual(devantVoyelle, [],
    'ces libelles mettent « du » devant une voyelle :\n' + devantVoyelle.join('\n'))
  const lundi = Object.entries(T).filter(([, v]) => /Lundi/.test(v)).map(([k, v]) => `${k} -> ${v}`)
  assert.deepEqual(lundi, [],
    'ces libelles gardent « Lundi » :\n' + lundi.join('\n')
    + '\nOn dit « le week-end de Paques », pas « le week-end du Lundi de Paques ».')
})

test('LE TEST QUI COMPTE : le titre se compose, et un ferie inconnu ne casse pas la phrase', async () => {
  const { titreWeekEnd } = await import('../shared/yield-libelles-feries.js')
  assert.equal(titreWeekEnd('Armistice 1918'), 'Week-end du 11 novembre')
  assert.equal(titreWeekEnd('Ascension'), 'Week-end de l’Ascension')
  assert.equal(titreWeekEnd('Lundi de Pâques'), 'Week-end de Pâques')
  // ⚠ LE REPLI SE DIT PLUTOT QUE DE MENTIR. Deux feries rayonnant sur le meme
  // week-end sont joints par « et » en amont (lib/yield/reference.js), et un
  // ferie ajoute un jour n aurait pas d entree. On rend le nom tel quel,
  // precede d un tiret : moins joli, mais ca se voit.
  assert.equal(titreWeekEnd('Armistice 1918 et Toussaint'),
    'Week-end — Armistice 1918 et Toussaint')
  assert.equal(titreWeekEnd(null), null)
  assert.equal(titreWeekEnd(''), null)
})

test('LE TEST QUI COMPTE : le MOTEUR n est pas touche — les cles internes sont intactes', () => {
  // ⚠ C'EST LA MOITIE QUI PROTEGE LES REGLAGES DEJA POSES. Un reglage vit sur
  // la cle du SEGMENT, pas sur le libelle : si quelqu un « simplifiait » en
  // renommant le ferie a la source, tous les reglages poses dessus
  // deviendraient orphelins en base, en silence.
  const src = lire('lib/yield/jours-feries.js')
  for (const attendu of ['Armistice 1918', 'Victoire 1945', 'Fête nationale',
    'Lundi de Pâques', 'Ascension', 'Lundi de Pentecôte']) {
    assert.ok(src.includes(`'${attendu}'`),
      `lib/yield/jours-feries.js doit garder le nom interne « ${attendu} » :`
      + ' c est la cle du segment et de ses reglages, pas un libelle.')
  }
  // Et la table ne doit pas vivre dans le moteur.
  assert.ok(!src.includes('11 novembre'),
    'le nom COURANT ne doit pas entrer dans le moteur : il est d affichage')
})
