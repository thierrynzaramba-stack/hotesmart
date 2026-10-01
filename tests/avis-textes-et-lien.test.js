// tests/avis-textes-et-lien.test.js
// Recette humaine du lot 4 (1er octobre 2026), trois demandes de Thierry :
//   1. les textes fixes des écrans avis portent leurs accents et apostrophes ;
//   2. « Moi » devient « L’hôte » dans le choix de qui remplit ;
//   3. la page Avis a un lien « Configuration » vers Réglages > onglet Avis,
//      réservé au titulaire qui a le droit d'écriture sur les avis.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const RACINE = path.join(__dirname, '..')
const lire = (p) => fs.readFileSync(path.join(RACINE, p), 'utf8')

// Les formes SANS accent qu'un écran ne doit plus afficher. Une liste fermée :
// elle attrape les régressions sur les mots de ce domaine, pas toutes les
// fautes possibles.
const SANS_ACCENT = /\b(defaut|evaluations?|evaluer|negatif|negative|NEGATIF|perimetre|delai|depasse|publiee|reglages?|criteres?|sejour|redaction|redige|reponses?|enregistree?s?|deja|etre|privee|Echec|Etat|Evaluation|Delai|Abandonnee|Publiee)\b/
// Une apostrophe oubliée : « l OTA », « n est », « d avis », « qu a ».
const SANS_APOSTROPHE = /\b(l|n|d|qu|s) (?=[aeiouhéèêàâîôûAEIOUHÉ])/

function verifierTexte (origine, texte) {
  const a = String(texte).match(SANS_ACCENT)
  assert.ok(!a, `${origine} : forme sans accent « ${a && a[0]} » dans « ${texte} »`)
  const b = String(texte).match(SANS_APOSTROPHE)
  assert.ok(!b, `${origine} : apostrophe manquante (« ${b && b[0]}… ») dans « ${texte} »`)
}

test('les états, motifs et libellés des modules avis sont accentués', async () => {
  const fenetre = await import('../core/avis/fenetre-evaluation.js')
  const liste = await import('../core/avis/liste-evaluations.js')
  const statut = await import('../core/avis/statut.js')
  const reglages = await import('../core/avis/ecran-reglages.js')
  const tables = {
    'fenetre ETAT_LISIBLE': fenetre.ETAT_LISIBLE,
    'fenetre MOTIF_LISIBLE': fenetre.MOTIF_LISIBLE,
    'liste ETAT_LISIBLE': liste.ETAT_LISIBLE,
    'statut LISIBLE': statut.LISIBLE,
    'reglages CATEGORIE_LISIBLE': reglages.CATEGORIE_LISIBLE,
    'reglages REMPLI_LISIBLE': reglages.REMPLI_LISIBLE,
  }
  let vus = 0
  for (const [nom, table] of Object.entries(tables)) {
    for (const [cle, texte] of Object.entries(table)) { verifierTexte(`${nom}.${cle}`, texte); vus++ }
  }
  assert.ok(vus > 30, `trop peu de libellés vérifiés (${vus}) : la liste ne mesure rien`)
})

test('l’écran des réglages, rendu sur la grille par défaut, est accentué', async () => {
  const { rendre } = await import('../core/avis/ecran-reglages.js')
  const etat = {
    surDefaut: true, inactifs: true, config: { keywords: [], tone: 'chaleureux', signature: '' }, tons: ['chaleureux', 'sobre'],
    criteres: [
      { libelle: 'X', categorie: 'cleanliness', rempli_par: 'hote', niveaux: [{ libelle: 'Y', note: 1 }] },
      { libelle: 'Z', categorie: 'recommandation', rempli_par: 'les_deux', niveaux: [{ libelle: 'W', recommande: false }] },
    ],
  }
  const texte = rendre(etat).replace(/<[^>]+>/g, ' ')
  verifierTexte('rendu des réglages', texte)
})

test('la liste des évaluations, rendue, est accentuée', async () => {
  const { rendre } = await import('../core/avis/liste-evaluations.js')
  const maintenant = Date.parse('2026-10-01T12:00:00Z')
  const vide = rendre({ evaluations: [], filtre: '' }, maintenant).replace(/<[^>]+>/g, ' ')
  verifierTexte('liste vide', vide)
  const pleine = rendre({ evaluations: [
    { booking_uid: 'a', status: 'a_remplir', echeance: '2026-09-29T00:00:00Z', bien: 'B' },
    { booking_uid: 'b', status: 'a_valider', echeance: '2026-10-05T00:00:00Z', bien: 'B' },
  ], filtre: '', message: null }, maintenant).replace(/<[^>]+>/g, ' ')
  verifierTexte('liste pleine', pleine)
})

test('« Moi » devient « L’hôte » dans le choix de qui remplit', async () => {
  const { REMPLI_LISIBLE } = await import('../core/avis/ecran-reglages.js')
  assert.strictEqual(REMPLI_LISIBLE.hote, 'L’hôte')
  assert.ok(!Object.values(REMPLI_LISIBLE).includes('Moi'))
})

test('la page Avis porte le lien « Configuration » vers Réglages > Avis', () => {
  const page = lire('pages/avis.html')
  assert.match(page, /<a [^>]*id="lien-configuration"[^>]*href="\/settings\?onglet=avis"[^>]*hidden/,
    'le lien existe, vise l’onglet Avis et naît caché')
  // ⚠ Réglages refuse un compte délégué : le lien exige le droit d'écriture ET
  // le compte propre, sinon un membre délégué cliquerait vers un refus.
  assert.match(page, /\$\('lien-configuration'\)\.hidden = !\(peut && window\.estTitulaire && window\.estTitulaire\(\)\)/)
  assert.match(page, /window\.estTitulaire = estTitulaire/)
})

test('Réglages ouvre l’onglet Avis quand l’adresse le demande, après le chargement de l’équipe', () => {
  const page = lire('pages/settings.html')
  assert.match(page, /get\('onglet'\)/)
  // La bascule vient APRÈS charger() : charger rallume la zone d'équipe.
  assert.match(page, /charger\(\)\.finally\(\(\) => \{ if \(ongletDemande === 'avis' && !\$\('tab-avis'\)\.hidden\) basculer\('avis'\) \}\)/)
})
