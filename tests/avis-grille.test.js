// tests/avis-grille.test.js
// LA GRILLE EST CONFIGURABLE, LES GARDE-FOUS NE LE SONT PAS.
// Spec §4 (amendement du 30 septembre 2026).
//
// LE DEFAUT QU'IL EMPECHE : une grille bricolee qui laisse partir chez Airbnb
// une note que l'hote n'a pas relue, ou qui publie un jugement sur une
// categorie dont il n'a rien dit.
const test = require('node:test')
const assert = require('node:assert')
const {
  GRILLE_DEFAUT, grilleDe, noter, estNegatif, tagsDe, validerGrille,
} = require('../lib/avis/notes-evaluation')

const PARFAIT = {
  etat: 'impeccable', degats: 'aucun', poubelles: 'fait',
  communication: 'excellente', regles: 'oui', recommande: 'oui',
}

// Une grille d'hote : un seul critere, invente de toutes pieces.
const GRILLE_HOTE = {
  criteres: [{
    cle: 'couvre_feu', libelle: 'Respect du couvre-feu',
    categorie: 'respect_house_rules', rempli_par: 'hote', rang: 1,
    niveaux: [
      { cle: 'oui', libelle: 'Oui', rang: 1, note: 5, negatif: false },
      { cle: 'non', libelle: 'Non', rang: 2, note: 1, negatif: true },
    ],
  }],
}

// ─── D'ou vient la grille ───────────────────────────────────────────────────
test('aucune ligne en base : la grille par defaut, sans rien ecrire', () => {
  assert.deepStrictEqual(grilleDe({ duBien: [], duCompte: [] }), GRILLE_DEFAUT)
  assert.deepStrictEqual(grilleDe({}), GRILLE_DEFAUT)
})

test('une grille de bien REMPLACE celle du compte, elle ne s’y ajoute pas', () => {
  const g = grilleDe({ duBien: GRILLE_HOTE.criteres, duCompte: GRILLE_DEFAUT.criteres })
  assert.deepStrictEqual(g.criteres.map(c => c.cle), ['couvre_feu'])
})

test('sans grille de bien, celle du compte s’applique', () => {
  const g = grilleDe({ duBien: [], duCompte: GRILLE_HOTE.criteres })
  assert.deepStrictEqual(g.criteres.map(c => c.cle), ['couvre_feu'])
})

// ─── Les garde-fous que l'hote ne peut pas defaire (§4.2) ──────────────────
test('LE TEST QUI COMPTE : une note 1 sans drapeau negatif est REFUSEE', () => {
  const g = { criteres: [{ ...GRILLE_HOTE.criteres[0], niveaux: [
    { cle: 'oui', libelle: 'Oui', rang: 1, note: 5, negatif: false },
    { cle: 'non', libelle: 'Non', rang: 2, note: 1, negatif: false },  // ⚠
  ] }] }
  assert.throws(() => validerGrille(g), /negati/i)
})

test('LE TEST QUI COMPTE : un refus de recommander sans drapeau negatif est REFUSE', () => {
  const g = { criteres: [{
    cle: 'reco', libelle: 'Recommandez-vous ?', categorie: 'recommandation',
    rempli_par: 'hote', rang: 1,
    niveaux: [
      { cle: 'oui', libelle: 'Oui', rang: 1, note: null, recommande: true, negatif: false },
      { cle: 'non', libelle: 'Non', rang: 2, note: null, recommande: false, negatif: false },  // ⚠
    ],
  }] }
  assert.throws(() => validerGrille(g), /recommand/i)
})

test('la grille par defaut respecte ses propres regles', () => {
  assert.doesNotThrow(() => validerGrille(GRILLE_DEFAUT))
})

test('une categorie inconnue d’Airbnb est refusee', () => {
  const g = { criteres: [{ ...GRILLE_HOTE.criteres[0], categorie: 'ambiance' }] }
  assert.throws(() => validerGrille(g), /categorie/i)
})

test('une note hors 1-5 est refusee, et « recommandation » n’en porte pas', () => {
  const hors = { criteres: [{ ...GRILLE_HOTE.criteres[0], niveaux: [{ cle: 'a', libelle: 'A', rang: 1, note: 7, negatif: false }] }] }
  assert.throws(() => validerGrille(hors), /note/i)
  const reco = { criteres: [{
    cle: 'r', libelle: 'R', categorie: 'recommandation', rempli_par: 'hote', rang: 1,
    niveaux: [{ cle: 'oui', libelle: 'Oui', rang: 1, note: 5, recommande: true, negatif: false }],
  }] }
  assert.throws(() => validerGrille(reco), /recommandation.*note|note.*recommandation/i)
})

// ─── Le calcul, sur une grille quelconque ──────────────────────────────────
test('la grille par defaut donne exactement ce que donnait le code en dur', () => {
  const r = noter(PARFAIT, GRILLE_DEFAUT)
  assert.deepStrictEqual(r.scores, [
    { category: 'cleanliness', rating: 5 },
    { category: 'communication', rating: 5 },
    { category: 'respect_house_rules', rating: 5 },
  ])
  assert.strictEqual(r.is_reviewee_recommended, true)
  // et le plus severe l'emporte toujours
  assert.strictEqual(noter({ ...PARFAIT, degats: 'importants' }, GRILLE_DEFAUT)
    .scores.find(s => s.category === 'cleanliness').rating, 1)
})

test('LE TEST QUI COMPTE : une categorie SANS critere n’est pas publiee', () => {
  // Airbnb accepte un scores[] partiel. Publier un 5 par defaut dirait ce que
  // l'hote n'a pas dit.
  const r = noter({ couvre_feu: 'oui' }, GRILLE_HOTE)
  assert.deepStrictEqual(r.scores, [{ category: 'respect_house_rules', rating: 5 }])
  assert.strictEqual(r.is_reviewee_recommended, undefined, 'aucun critere de recommandation : on ne se prononce pas')
})

test('plusieurs criteres d’une meme categorie : le plus severe', () => {
  const g = { criteres: [
    { cle: 'a', libelle: 'A', categorie: 'communication', rempli_par: 'hote', rang: 1,
      niveaux: [{ cle: 'ok', libelle: 'OK', rang: 1, note: 5, negatif: false }] },
    { cle: 'b', libelle: 'B', categorie: 'communication', rempli_par: 'hote', rang: 2,
      niveaux: [{ cle: 'bof', libelle: 'Bof', rang: 1, note: 2, negatif: false }] },
  ] }
  assert.deepStrictEqual(noter({ a: 'ok', b: 'bof' }, g).scores, [{ category: 'communication', rating: 2 }])
})

test('plusieurs criteres de recommandation : un seul « non » suffit', () => {
  const niv = (r) => [
    { cle: 'oui', libelle: 'Oui', rang: 1, note: null, recommande: true, negatif: false },
    { cle: 'non', libelle: 'Non', rang: 2, note: null, recommande: false, negatif: true },
  ]
  const g = { criteres: [
    { cle: 'r1', libelle: 'R1', categorie: 'recommandation', rempli_par: 'hote', rang: 1, niveaux: niv() },
    { cle: 'r2', libelle: 'R2', categorie: 'recommandation', rempli_par: 'hote', rang: 2, niveaux: niv() },
  ] }
  assert.strictEqual(noter({ r1: 'oui', r2: 'oui' }, g).is_reviewee_recommended, true)
  assert.strictEqual(noter({ r1: 'oui', r2: 'non' }, g).is_reviewee_recommended, false)
})

test('une reponse hors de la grille est REFUSEE, jamais ignoree', () => {
  assert.throws(() => noter({ couvre_feu: 'parfois' }, GRILLE_HOTE), /parfois|niveau/i)
  assert.throws(() => noter({}, GRILLE_HOTE), /couvre_feu|manquant/i)
})

// ─── Le negatif suit la grille, plus une liste en dur ──────────────────────
test('est negatif : le drapeau de la grille, et les deux regles forcees', () => {
  assert.strictEqual(estNegatif({ couvre_feu: 'oui' }, GRILLE_HOTE), false)
  assert.strictEqual(estNegatif({ couvre_feu: 'non' }, GRILLE_HOTE), true)
  // la grille par defaut garde son comportement d'origine
  assert.strictEqual(estNegatif(PARFAIT, GRILLE_DEFAUT), false)
  assert.strictEqual(estNegatif({ ...PARFAIT, etat: 'sale' }, GRILLE_DEFAUT), true)
  assert.strictEqual(estNegatif({ ...PARFAIT, recommande: 'non' }, GRILLE_DEFAUT), true)
})

test('une grille FIGEE ancienne qui viole les regles reste jugee negative', () => {
  // Une copie figee d'avant la contrainte pourrait porter une note 1 sans
  // drapeau. Le module ne la croit pas sur parole : la note 1 et le refus de
  // recommander declenchent le garde-fou meme sans drapeau.
  const vieille = { criteres: [{ ...GRILLE_HOTE.criteres[0], niveaux: [
    { cle: 'non', libelle: 'Non', rang: 1, note: 1, negatif: false },
  ] }] }
  assert.strictEqual(estNegatif({ couvre_feu: 'non' }, vieille), true)
})

// ─── Les tags ───────────────────────────────────────────────────────────────
test('un critere invente par l’hote ne porte aucun tag', () => {
  assert.deepStrictEqual(tagsDe({ couvre_feu: 'non' }, GRILLE_HOTE), [])
})

test('les criteres de la grille par defaut gardent leurs tags', () => {
  const t = tagsDe(PARFAIT, GRILLE_DEFAUT)
  assert.ok(t.includes('host_review_guest_positive_neat_and_tidy'))
  assert.ok(!t.some(x => x.includes('negative')))
})
