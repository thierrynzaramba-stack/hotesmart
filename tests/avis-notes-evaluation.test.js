// tests/avis-notes-evaluation.test.js
// LES NOTES SE CALCULENT, ELLES NE SE REDIGENT PAS.
// Spec docs/specs/spec-evaluation-voyageur.md §3 et §4 : « Notes = calcul
// deterministe depuis les boutons, sans IA. L'IA ne redige que le texte. »
//
// LE DEFAUT QU'IL EMPECHE : une note qui derive du texte, ou qui change entre
// deux appels. Un avis publie chez Airbnb ne se reprend pas — la note part une
// fois, et elle doit etre EXACTEMENT ce que les boutons disaient.
//
// L'echelle et les categories viennent de l'etape 0, mesurees sur l'API
// Channex le 24 septembre 2026 :
//   POST /reviews/:id/guest_review
//   scores[] : { category: cleanliness | communication | respect_house_rules,
//                rating: 1..5 }
//   is_reviewee_recommended : booleen
//   tags[] : liste fermee, par categorie.
const test = require('node:test')
const assert = require('node:assert')

const {
  GRILLE_DEFAUT, CATEGORIES, CATEGORIES_NOTEES, TAGS,
  noter, estNegatif, tagsDe,
} = require('../lib/avis/notes-evaluation')

// ⚠ CE FICHIER TESTE LA GRILLE PAR DEFAUT. Depuis l'amendement du 30 septembre
// 2026, les niveaux ne sont plus une constante du module : ils sont une GRILLE,
// et l'hote peut la changer. Ce que ces tests defendent n'a pas bouge — le
// comportement de la grille livree — mais ils le lisent desormais dans
// GRILLE_DEFAUT. La grille configurable a son propre fichier,
// tests/avis-grille.test.js.
const NIVEAUX = Object.fromEntries(GRILLE_DEFAUT.criteres.map(c => [c.cle, c.niveaux.map(v => v.cle)]))

// Les reponses les plus favorables, comme base de comparaison.
const PARFAIT = {
  etat: 'impeccable', degats: 'aucun', poubelles: 'fait',
  communication: 'excellente', regles: 'oui', recommande: 'oui',
}

// ─── Le vocabulaire est ferme ───────────────────────────────────────────────
test('les niveaux sont ceux de la spec, ni plus ni moins', () => {
  assert.deepStrictEqual(NIVEAUX.etat, ['impeccable', 'correct', 'sale', 'tres_sale'])
  assert.deepStrictEqual(NIVEAUX.degats, ['aucun', 'mineurs', 'importants'])
  assert.deepStrictEqual(NIVEAUX.poubelles, ['fait', 'partiel', 'pas_fait'])
  assert.deepStrictEqual(NIVEAUX.communication, ['excellente', 'correcte', 'difficile'])
  assert.deepStrictEqual(NIVEAUX.regles, ['oui', 'partiellement', 'non'])
  assert.deepStrictEqual(NIVEAUX.recommande, ['oui', 'non'])
})

test('les categories sont celles de l’OTA, pas les notres', () => {
  // Trois categories NOTEES, plus « recommandation » qui porte un booleen et
  // non une note : Airbnb attend `is_reviewee_recommended`.
  assert.deepStrictEqual(CATEGORIES_NOTEES, ['cleanliness', 'communication', 'respect_house_rules'])
  assert.deepStrictEqual(CATEGORIES, ['cleanliness', 'communication', 'respect_house_rules', 'recommandation'])
})

// ─── Le calcul ──────────────────────────────────────────────────────────────
test('tout au mieux : 5 partout, et recommande', () => {
  const r = noter(PARFAIT)
  assert.deepStrictEqual(r.scores, [
    { category: 'cleanliness', rating: 5 },
    { category: 'communication', rating: 5 },
    { category: 'respect_house_rules', rating: 5 },
  ])
  assert.strictEqual(r.is_reviewee_recommended, true)
})

test('tout au pire : le plancher de chaque categorie, et non recommande', () => {
  // ⚠ PAS « 1 PARTOUT », ET C'EST UN ARBITRAGE, PAS UN OUBLI.
  // La spec laissait les valeurs a fixer apres l'etape 0. Regle retenue : une
  // note tombe a 1 quand le niveau declenche le garde-fou du NEGATIF (§3) —
  // tres sale, degats importants, regles non. « Communication difficile » n'est
  // PAS dans cette liste limitative : le juger 1/5, la note la plus punitive
  // qu'Airbnb affiche sur un voyageur, contredirait la spec qui ne le tient pas
  // pour grave. Il vaut 2. Decision prise seul le 30 septembre 2026, a
  // renverser d'une ligne dans NOTES si Thierry en juge autrement.
  const r = noter({
    etat: 'tres_sale', degats: 'importants', poubelles: 'pas_fait',
    communication: 'difficile', regles: 'non', recommande: 'non',
  })
  assert.deepStrictEqual(r.scores, [
    { category: 'cleanliness', rating: 1 },
    { category: 'communication', rating: 2 },
    { category: 'respect_house_rules', rating: 1 },
  ])
  assert.strictEqual(r.is_reviewee_recommended, false)
})

test('la note 1 est reservee aux niveaux que la spec tient pour NEGATIFS', () => {
  // Le lien entre les deux regles se verifie, il ne se suppose pas : tout
  // niveau note 1 doit declencher estNegatif, et reciproquement pour ceux qui
  // portent une note. Sans ce lien, un avis pourrait partir avec un 1/5 sans
  // que l'hote ait eu a le valider.
  const PIRE = { etat: 'tres_sale', degats: 'importants', regles: 'non' }
  for (const [champ, valeur] of Object.entries(PIRE)) {
    const jeu = { ...PARFAIT, [champ]: valeur }
    const notes = noter(jeu).scores.map(s => s.rating)
    assert.ok(notes.includes(1), `${champ} = ${valeur} devrait porter un 1`)
    assert.strictEqual(estNegatif(jeu), true, `${champ} = ${valeur} devrait etre negatif`)
  }
  // et l'inverse : aucun niveau note 1 en dehors de ceux-la
  for (const [champ, niveaux] of Object.entries(NIVEAUX)) {
    if (champ === 'recommande') continue
    for (const v of niveaux) {
      const jeu = { ...PARFAIT, [champ]: v }
      if (noter(jeu).scores.some(s => s.rating === 1)) {
        assert.strictEqual(estNegatif(jeu), true, `${champ} = ${v} porte un 1 sans etre negatif`)
      }
    }
  }
})

test('la proprete combine TROIS boutons, et prend le plus severe', () => {
  // Un logement impeccable dont les poubelles n'ont pas ete faites n'est pas
  // « impeccable » : la note suit le pire des trois, jamais leur moyenne — une
  // moyenne noierait un degat important sous deux reponses parfaites.
  const propre = (a) => noter({ ...PARFAIT, ...a }).scores.find(s => s.category === 'cleanliness').rating
  assert.strictEqual(propre({}), 5)
  assert.strictEqual(propre({ etat: 'correct' }), 4)
  assert.strictEqual(propre({ poubelles: 'partiel' }), 4)
  assert.strictEqual(propre({ degats: 'mineurs' }), 3)
  assert.strictEqual(propre({ etat: 'sale' }), 2)
  assert.strictEqual(propre({ degats: 'importants' }), 1)
  // le plus severe l'emporte, quel que soit l'ordre
  assert.strictEqual(propre({ etat: 'impeccable', degats: 'importants', poubelles: 'fait' }), 1)
  assert.strictEqual(propre({ etat: 'sale', degats: 'mineurs' }), 2)
})

test('le meme jeu de boutons donne toujours la meme note', () => {
  const a = noter(PARFAIT), b = noter({ ...PARFAIT })
  assert.deepStrictEqual(a, b)
  // et l'ordre des cles n'y change rien
  const desordre = { recommande: 'oui', regles: 'oui', communication: 'excellente', poubelles: 'fait', degats: 'aucun', etat: 'impeccable' }
  assert.deepStrictEqual(noter(desordre), a)
})

test('un niveau inconnu est REFUSE, jamais interprete', () => {
  // Un « sale » mal orthographie qui deviendrait 5 par defaut publierait un
  // avis elogieux sur un logement sale. On refuse.
  assert.throws(() => noter({ ...PARFAIT, etat: 'moyen' }), /etat/)
  assert.throws(() => noter({ ...PARFAIT, recommande: 'peut-etre' }), /recommande/)
  assert.throws(() => noter({ ...PARFAIT, etat: undefined }), /etat/)
})

// ─── Le garde-fou du negatif (spec §3) ──────────────────────────────────────
test('est negatif : recommandation non, proprete sale ou pire, degats importants, regles non', () => {
  assert.strictEqual(estNegatif(PARFAIT), false)
  assert.strictEqual(estNegatif({ ...PARFAIT, recommande: 'non' }), true)
  assert.strictEqual(estNegatif({ ...PARFAIT, etat: 'sale' }), true)
  assert.strictEqual(estNegatif({ ...PARFAIT, etat: 'tres_sale' }), true)
  assert.strictEqual(estNegatif({ ...PARFAIT, degats: 'importants' }), true)
  assert.strictEqual(estNegatif({ ...PARFAIT, regles: 'non' }), true)
})

test('ce qui n’est PAS negatif au sens de la spec', () => {
  // La liste de §3 est limitative : « correct », « mineurs », « partiel »,
  // « difficile », « partiellement » genent, mais ne declenchent pas la
  // validation obligatoire par l'hote. Elargir la liste en douce retirerait a
  // la prestataire un pouvoir que Thierry lui a donne.
  for (const a of [{ etat: 'correct' }, { degats: 'mineurs' }, { poubelles: 'pas_fait' },
                   { communication: 'difficile' }, { regles: 'partiellement' }]) {
    assert.strictEqual(estNegatif({ ...PARFAIT, ...a }), false, JSON.stringify(a))
  }
})

test('un jeu de boutons incomplet ne peut pas etre juge negatif « par defaut »', () => {
  // Repondre « je ne sais pas » n'est pas repondre « tout va bien ».
  assert.throws(() => estNegatif({ etat: 'impeccable' }), /manquant|regles|recommande/)
})

// ─── Les tags (liste fermee de l'OTA) ───────────────────────────────────────
test('les tags sortent de la liste fermee d’Airbnb, jamais inventes', () => {
  for (const t of Object.values(TAGS).flat()) {
    assert.match(t, /^host_review_guest_(positive|negative)_[a-z_]+$/, t)
  }
})

test('les tags suivent les boutons, et restent dans leur categorie', () => {
  const parfait = tagsDe(PARFAIT)
  assert.ok(parfait.includes('host_review_guest_positive_neat_and_tidy'))
  assert.ok(parfait.includes('host_review_guest_positive_took_care_of_garbage'))
  assert.ok(!parfait.some(t => t.includes('negative')), 'aucun tag negatif sur un sejour parfait')

  const degrade = tagsDe({ ...PARFAIT, degats: 'importants', poubelles: 'pas_fait', regles: 'non' })
  assert.ok(degrade.includes('host_review_guest_negative_damage'))
  assert.ok(degrade.includes('host_review_guest_negative_garbage'))
  assert.ok(!degrade.includes('host_review_guest_positive_neat_and_tidy'), 'pas de tag positif contredit par les boutons')
})

test('aucun tag en double, meme quand deux boutons pointent le meme', () => {
  const t = tagsDe({ ...PARFAIT, etat: 'tres_sale', degats: 'importants', poubelles: 'pas_fait' })
  assert.strictEqual(new Set(t).size, t.length)
})
