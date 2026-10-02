// tests/avis-ecran-reglages.test.js
// L'onglet « Avis » de /settings (core/avis/ecran-reglages.js), en jsdom, avec
// l'appel serveur INJECTE.
//
// CE QU'ILS PROTEGENT : un ecran qui laisserait decocher « negatif » sur une
// note 1 — la regle que l'hote ne peut pas defaire, et qu'il ne doit pas
// decouvrir par un refus du serveur —, qui pre-inserirait la grille par defaut
// en base, ou qui enverrait une grille que la base refusera.
const test = require('node:test')
const assert = require('node:assert')
const { JSDOM } = require('jsdom')

let monter, rendre, negatifForce, vidangerNiveau, cleDe
test.before(async () => {
  ({ monter, rendre, negatifForce, vidangerNiveau, cleDe } = await import('../core/avis/ecran-reglages.js'))
})

function dom () {
  const d = new JSDOM('<!doctype html><body><div id="c"></div></body>', { pretendToBeVisual: true })
  global.CustomEvent = d.window.CustomEvent
  return d.window
}

const DEFAUT = [
  { libelle: 'Etat du logement', categorie: 'cleanliness', rempli_par: 'prestataire', rang: 1, niveaux: [
    { cle: 'impeccable', libelle: 'Impeccable', rang: 1, note: 5, negatif: false },
    { cle: 'sale', libelle: 'Sale', rang: 2, note: 1, negatif: true },
  ] },
  { libelle: 'Recommandez-vous ce voyageur ?', categorie: 'recommandation', rempli_par: 'hote', rang: 2, niveaux: [
    { cle: 'oui', libelle: 'Oui', rang: 1, note: null, recommande: true, negatif: false },
    { cle: 'non', libelle: 'Non', rang: 2, note: null, recommande: false, negatif: true },
  ] },
]

function faussAppel ({ grilleCompte = [], config = null, erreurs = {}, biensAvecGrille = 0 } = {}) {
  const appels = []
  return {
    appels,
    fn: async (chemin, opts = {}) => {
      appels.push({ chemin, ...opts })
      for (const [motif, err] of Object.entries(erreurs)) if (chemin.includes(motif)) throw err
      if (chemin.includes('action=grille&') || chemin.endsWith('action=grille')) {
        return { compte: grilleCompte, bien: [], defaut: DEFAUT, biens_avec_grille: biensAvecGrille, categories: ['cleanliness', 'communication', 'respect_house_rules', 'recommandation'], rempli_par: ['prestataire', 'hote', 'les_deux'] }
      }
      if (chemin.includes('action=config')) return { compte: config, bien: null, tons: ['chaleureux', 'sobre'] }
      return { ok: true }
    },
  }
}

async function ouvrirEcran (options = {}) {
  const window = dom()
  const conteneur = window.document.getElementById('c')
  const a = faussAppel(options)
  const avertis = []
  const r = await monter(conteneur, { appel: a.fn, avertir: (m, t) => avertis.push([m, t]) })
  return { window, conteneur, appels: a.appels, resultat: r, avertis }
}

// ─── La grille par defaut ───────────────────────────────────────────────────
test('LE TEST QUI COMPTE : sans critere en base, la grille par defaut est MONTREE, pas enregistree', async () => {
  // Decision du 30 septembre 2026 : pas de seed sur 30 000 comptes.
  const { conteneur, appels, resultat } = await ouvrirEcran()
  assert.strictEqual(resultat.surDefaut, true)
  assert.match(conteneur.textContent, /grille par défaut/)
  // ⚠ Le libelle vit dans la VALEUR d'un champ, pas dans le texte du document :
  // `textContent` ne voit pas l'attribut `value`. Une assertion sur le texte
  // serait restee muette meme si la grille ne s'affichait pas.
  const libelles = [...conteneur.querySelectorAll('[data-champ="libelle"]')].map(e => e.value)
  assert.ok(libelles.includes('Etat du logement'), `libelles vus : ${libelles.join(' | ')}`)
  assert.ok(!appels.some(a => a.methode === 'POST'), 'aucune ecriture au chargement')
})

test('avec une grille en base, c’est elle qui s’affiche', async () => {
  const mienne = [{ id: 'c1', libelle: 'Couvre-feu', categorie: 'respect_house_rules', rempli_par: 'hote', rang: 1,
                    niveaux: [{ cle: 'ok', libelle: 'Respecte', rang: 1, note: 5, negatif: false }] }]
  const { conteneur, resultat } = await ouvrirEcran({ grilleCompte: mienne })
  assert.strictEqual(resultat.surDefaut, false)
  const libelles = [...conteneur.querySelectorAll('[data-critere][data-champ="libelle"]')].map(e => e.value)
  assert.deepStrictEqual(libelles, ['Couvre-feu'])
})

// ─── Les deux regles que l'hote ne peut pas defaire ─────────────────────────
test('LE TEST QUI COMPTE : la case « negatif » d’une note 1 est cochee ET desactivee', async () => {
  const { conteneur } = await ouvrirEcran()
  const cases = [...conteneur.querySelectorAll('[data-champ="negatif"]')]
  const forcee = cases.find(c => c.disabled)
  assert.ok(forcee, 'au moins une case doit etre forcee')
  assert.strictEqual(forcee.checked, true)
})

test('LE TEST QUI COMPTE : la RAISON est ecrite a cote de la case, pas laissee a deviner', async () => {
  const { conteneur } = await ouvrirEcran()
  assert.match(conteneur.textContent, /forcé : une note 1 est toujours négatif/)
  assert.match(conteneur.textContent, /forcé : un refus de recommander est toujours négatif/)
})

test('la regle vaut aussi pour un refus de recommander', () => {
  assert.strictEqual(negatifForce({ recommande: false }, 'recommandation'), true)
  assert.strictEqual(negatifForce({ recommande: true }, 'recommandation'), false)
  assert.strictEqual(negatifForce({ note: 1 }, 'cleanliness'), true)
  assert.strictEqual(negatifForce({ note: 2 }, 'cleanliness'), false)
})

test('LE TEST QUI COMPTE : ce qui part au serveur porte le drapeau force, meme si la case etait decochee', async () => {
  // La case est desactivee a l'ecran, mais un appel direct pourrait envoyer
  // autre chose. L'ecran applique la regle une seconde fois a l'envoi, et la
  // base une troisieme.
  const mienne = [{ id: 'c1', libelle: 'Couvre-feu', categorie: 'respect_house_rules', rempli_par: 'hote', rang: 1,
                    niveaux: [{ cle: 'non', libelle: 'Jamais', rang: 1, note: 1, negatif: false }] }]
  const { conteneur, appels } = await ouvrirEcran({ grilleCompte: mienne })
  conteneur.querySelector('[data-action="enregistrer"]').click()
  await new Promise(r => setTimeout(r, 0))
  const envoi = appels.find(a => a.chemin.includes('grille-maj'))
  assert.ok(envoi)
  assert.strictEqual(envoi.corps.criteres[0].niveaux[0].negatif, true)
})

// ─── Ce que la categorie change ─────────────────────────────────────────────
test('passer un critere en « recommandation » retire les notes de ses niveaux', () => {
  const n = vidangerNiveau({ cle: 'x', libelle: 'X', rang: 1, note: 4, negatif: false }, 'recommandation')
  assert.strictEqual(n.note, null)
  assert.strictEqual(n.recommande, false)
  assert.strictEqual(n.negatif, true, 'un refus de recommander est negatif')
})

test('revenir a une categorie notee redonne une note, et force le negatif sur 1', () => {
  assert.strictEqual(vidangerNiveau({ cle: 'x', note: null }, 'cleanliness').note, 3)
  assert.strictEqual(vidangerNiveau({ cle: 'x', note: 1, negatif: false }, 'cleanliness').negatif, true)
})

test('un critere de recommandation propose « je recommande / je ne recommande pas », pas une note', async () => {
  const { conteneur } = await ouvrirEcran()
  const html = conteneur.innerHTML
  assert.match(html, /Je ne recommande pas/)
  // Le critere de recommandation n'a pas de selecteur de note.
  const notes = [...conteneur.querySelectorAll('[data-champ="note"]')]
  const recos = [...conteneur.querySelectorAll('[data-champ="recommande"]')]
  assert.ok(recos.length >= 2)
  assert.ok(notes.length >= 2)
})

// ─── Les cles de niveaux ────────────────────────────────────────────────────
test('une cle se derive du libelle, accents et ponctuation retires', () => {
  assert.strictEqual(cleDe({ libelle: 'Très sale !' }, 0, []), 'tres-sale')
})

test('deux niveaux du meme libelle ne partagent pas leur cle', () => {
  const freres = [{ libelle: 'Bien' }, { libelle: 'Bien' }]
  assert.strictEqual(cleDe(freres[0], 0, freres), 'bien')
  assert.strictEqual(cleDe(freres[1], 1, freres), 'bien-2')
})

test('un libelle vide donne quand meme une cle', () => {
  assert.strictEqual(cleDe({ libelle: '   ' }, 2, []), 'niveau-3')
})

// ─── L'edition ──────────────────────────────────────────────────────────────
test('ajouter un critere l’ajoute a l’ecran, sans rien ecrire', async () => {
  const { conteneur, appels } = await ouvrirEcran()
  const avant = conteneur.querySelectorAll('.hs-critere').length
  conteneur.querySelector('[data-action="ajouter-critere"]').click()
  assert.strictEqual(conteneur.querySelectorAll('.hs-critere').length, avant + 1)
  assert.ok(!appels.some(a => a.methode === 'POST'))
})

test('retirer un critere le retire', async () => {
  const { conteneur } = await ouvrirEcran()
  const avant = conteneur.querySelectorAll('.hs-critere').length
  conteneur.querySelector('[data-action="retirer-critere"]').click()
  assert.strictEqual(conteneur.querySelectorAll('.hs-critere').length, avant - 1)
})

test('« revenir a la grille par defaut » remet la grille du code sans rien ecrire', async () => {
  const mienne = [{ id: 'c1', libelle: 'Couvre-feu', categorie: 'respect_house_rules', rempli_par: 'hote', rang: 1,
                    niveaux: [{ cle: 'ok', libelle: 'Respecte', rang: 1, note: 5, negatif: false }] }]
  const { conteneur, appels } = await ouvrirEcran({ grilleCompte: mienne })
  conteneur.querySelector('[data-action="revenir-defaut"]').click()
  const libelles = [...conteneur.querySelectorAll('[data-critere][data-champ="libelle"]')].map(e => e.value)
  assert.ok(libelles.includes('Etat du logement'), `libelles vus : ${libelles.join(' | ')}`)
  assert.ok(!appels.some(a => a.methode === 'POST'), 'il faut enregistrer pour que cela compte')
})

// ─── La configuration de redaction ──────────────────────────────────────────
test('les mots-cles, le ton et la signature partent avec la grille', async () => {
  const { conteneur, appels } = await ouvrirEcran({ config: { keywords: ['soigneux'], tone: 'sobre', signature: 'Thierry' } })
  const mots = conteneur.querySelector('[data-reglage="mots"]')
  assert.strictEqual(mots.value, 'soigneux')
  mots.value = 'soigneux, discret'
  mots.dispatchEvent(new conteneur.ownerDocument.defaultView.Event('input'))
  conteneur.querySelector('[data-action="enregistrer"]').click()
  await new Promise(r => setTimeout(r, 0))
  const envoi = appels.find(a => a.chemin.includes('config-maj'))
  assert.ok(envoi)
  assert.deepStrictEqual(envoi.corps.keywords, ['soigneux', 'discret'])
  assert.strictEqual(envoi.corps.tone, 'sobre')
  assert.strictEqual(envoi.corps.signature, 'Thierry')
})

// ─── Les echecs ─────────────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : un refus du serveur est AFFICHE, avec sa phrase', async () => {
  const err = new Error('« Couvre-feu / Jamais » porte la note 1 sans etre negatif')
  err.statut = 400; err.motif = 'grille_invalide'
  const { conteneur, avertis } = await ouvrirEcran({ erreurs: { 'grille-maj': err } })
  conteneur.querySelector('[data-action="enregistrer"]').click()
  await new Promise(r => setTimeout(r, 0))
  assert.match(conteneur.textContent, /sans etre negatif/)
  assert.ok(avertis.some(([, t]) => t === 'err'))
})

test('des reglages illisibles le disent, au lieu de laisser un onglet vide', async () => {
  const window = dom()
  const conteneur = window.document.getElementById('c')
  const r = await monter(conteneur, { appel: async () => { throw new Error('Grille illisible') } })
  assert.strictEqual(r.charge, false)
  assert.match(conteneur.textContent, /illisible/)
})

// ─── L'echappement ──────────────────────────────────────────────────────────
test('LE TEST QUI COMPTE : un libelle de critere ne peut pas injecter de balise', async () => {
  const mienne = [{ id: 'c1', libelle: '<img src=x onerror=alert(1)>', categorie: 'cleanliness', rempli_par: 'hote', rang: 1,
                    niveaux: [{ cle: 'a', libelle: 'A', rang: 1, note: 5, negatif: false }] }]
  const { conteneur } = await ouvrirEcran({ grilleCompte: mienne })
  assert.strictEqual(conteneur.querySelectorAll('img').length, 0)
  assert.strictEqual(conteneur.querySelector('[data-champ="libelle"]').value, '<img src=x onerror=alert(1)>')
})

test('une signature ne peut pas injecter de balise non plus', () => {
  const html = rendre({ criteres: [], config: { keywords: [], tone: 'sobre', signature: '"><script>x</script>' }, tons: ['sobre'] })
  assert.ok(!html.includes('<script>x'))
})

// ─── Les correctifs de la revue du lot 4 ────────────────────────────────────
test('LE TEST QUI COMPTE : une grille enregistree mais NON ACTIVE se dit, et en premier', async () => {
  // Constat de review : `actif` etait jete a la lecture, donc un hote dont
  // l'activation avait echoue revoyait sa grille comme si elle s'appliquait —
  // alors qu'aucune evaluation ne pouvait se remplir.
  const inactive = [{ id: 'c1', libelle: 'Couvre-feu', categorie: 'respect_house_rules', rempli_par: 'hote', rang: 1, actif: false,
                      niveaux: [{ cle: 'ok', libelle: 'Respecte', rang: 1, note: 5, negatif: false }] }]
  const { conteneur } = await ouvrirEcran({ grilleCompte: inactive })
  assert.match(conteneur.textContent, /N’EST PAS ACTIVE/)
  assert.match(conteneur.textContent, /aucune évaluation ne peut être remplie/)
})

test('une grille active ne porte pas cet avertissement', async () => {
  const active = [{ id: 'c1', libelle: 'Couvre-feu', categorie: 'respect_house_rules', rempli_par: 'hote', rang: 1, actif: true,
                    niveaux: [{ cle: 'ok', libelle: 'Respecte', rang: 1, note: 5, negatif: false }] }]
  const { conteneur } = await ouvrirEcran({ grilleCompte: active })
  assert.ok(!conteneur.textContent.includes('N’EST PAS ACTIVE'))
})

test('LE TEST QUI COMPTE : l’ecran ne dit plus « sur tous vos biens » quand un bien a sa propre grille', async () => {
  // `grilleDe` fait primer le bien : la phrase etait fausse, et disait a l'hote
  // l'inverse de ce qui s'applique.
  const mienne = [{ id: 'c1', libelle: 'Couvre-feu', categorie: 'respect_house_rules', rempli_par: 'hote', rang: 1, actif: true,
                    niveaux: [{ cle: 'ok', libelle: 'Respecte', rang: 1, note: 5, negatif: false }] }]
  const { conteneur } = await ouvrirEcran({ grilleCompte: mienne, biensAvecGrille: 2 })
  assert.match(conteneur.textContent, /sauf sur 2 bien\(s\) qui ont la leur/)
  assert.ok(!conteneur.textContent.includes('sur tous vos biens'))
})

// ─── La publication automatique (spec §10 bis, 2 octobre 2026) ──────────────
test('LE TEST QUI COMPTE : cocher la publication automatique propose 48 h, et le delai part au serveur', async () => {
  const { window, conteneur, appels } = await ouvrirEcran({ config: { keywords: [], tone: 'sobre', signature: '', auto_validation_heures: null } })
  const champ = () => conteneur.querySelector('[data-reglage="auto-heures"]')
  assert.strictEqual(champ().disabled, true, 'desactivee : le champ est grise')
  const caseAuto = conteneur.querySelector('[data-reglage="auto-active"]')
  caseAuto.checked = true
  caseAuto.dispatchEvent(new window.Event('change'))
  assert.strictEqual(champ().disabled, false)
  assert.strictEqual(champ().value, '48')
  champ().value = '24'
  champ().dispatchEvent(new window.Event('input'))
  conteneur.querySelector('[data-action="enregistrer"]').click()
  await new Promise(r => setTimeout(r, 0))
  const config = appels.find(a => a.chemin.includes('config-maj'))
  assert.strictEqual(config.corps.auto_validation_heures, 24)
})

test('decocher l’envoie nul ; un delai hors bornes est refuse AVANT tout envoi', async () => {
  const a = await ouvrirEcran({ config: { keywords: [], tone: 'sobre', signature: '', auto_validation_heures: 12 } })
  const caseAuto = a.conteneur.querySelector('[data-reglage="auto-active"]')
  assert.strictEqual(caseAuto.checked, true)
  caseAuto.checked = false
  caseAuto.dispatchEvent(new a.window.Event('change'))
  a.conteneur.querySelector('[data-action="enregistrer"]').click()
  await new Promise(r => setTimeout(r, 0))
  assert.strictEqual(a.appels.find(x => x.chemin.includes('config-maj')).corps.auto_validation_heures, null)

  const b = await ouvrirEcran({ config: { keywords: [], tone: 'sobre', signature: '', auto_validation_heures: 12 } })
  const champ = b.conteneur.querySelector('[data-reglage="auto-heures"]')
  champ.value = '400'
  champ.dispatchEvent(new b.window.Event('input'))
  b.conteneur.querySelector('[data-action="enregistrer"]').click()
  await new Promise(r => setTimeout(r, 0))
  assert.ok(!b.appels.some(x => x.chemin.includes('maj')), 'ni grille ni config envoyees')
  assert.match(b.conteneur.textContent, /entre 1 et 336/)
})
