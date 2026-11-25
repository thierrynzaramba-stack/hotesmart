// tests/comparables-detail.test.js — le DETAIL de chaque comparable
// (accueil, vue Annee ; spec-revenus-comparables §7).
//
// Deux moities, eprouvees sans base ni navigateur :
//   · les REGLES de l'endpoint (`api/ecran/revenus-annee`, `_interne`) : la
//     fenetre glissante, les annees a demander, ce que dit chaque case ;
//   · le RENDU du module commun (`shared/comparables-detail.js`) : les deux
//     formes, ordinateur et telephone, a partir des memes valeurs.
//
// ⚠ LES DATES SONT FIGEES ET INJECTEES : ces fonctions ne lisent pas
// l'horloge, elles recoivent le jour. Regle du depot : *dates figees si le
// test injecte le temps*.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'

const test = require('node:test')
const assert = require('node:assert/strict')
const { _interne: E } = require('../api/ecran/revenus-annee')
const { detailComparablesHtml, valeurCase, valeurLogement } = require('../shared/comparables-detail.js')

// ─── LA FENETRE ────────────────────────────────────────────────────────────

test('LE TEST QUI COMPTE : la fenetre porte les 12 derniers mois ET les 3 prochains (decision D2)', () => {
  const f = E.fenetreDetail('2026-11-25')
  assert.equal(f.mois.length, 15, `${f.mois.length} mois au lieu de 15`)
  assert.equal(f.mois[0], '2025-12', 'le premier mois n est pas decembre 2025')
  assert.equal(f.courant, '2026-11')
  assert.equal(f.mois[11], '2026-11', 'le mois en cours n est pas le 12e')
  assert.equal(f.mois[14], '2027-02', 'le dernier mois n est pas fevrier 2027')
  // Les bornes de la lecture : [debut, fin), la fin est le mois APRES le dernier.
  assert.equal(f.debut, '2025-12-01')
  assert.equal(f.fin, '2027-03-01')
})

test('LE TEST QUI COMPTE : la fenetre de decembre ne deborde pas sur deux ans de trop', () => {
  const f = E.fenetreDetail('2026-12-31')
  assert.equal(f.mois[0], '2026-01')
  assert.equal(f.mois[14], '2027-03')
})

test('LE TEST QUI COMPTE : trois annees civiles = deux appels, et aucune annee n est oubliee', () => {
  // ⚠ `revenus_annee(p)` rend [p-1, p]. En novembre la fenetre touche 2025,
  // 2026 et 2027 : un seul appel laisserait un bout de la fenetre sans ligne,
  // lu « aucun sejour ».
  for (const [jour, attendu] of [
    ['2026-11-25', [2026, 2027]], ['2026-10-01', [2026, 2027]],
    ['2026-12-31', [2027]], ['2026-01-15', [2026]], ['2026-09-30', [2026]]
  ]) {
    const f = E.fenetreDetail(jour)
    const appels = E.anneesARevenus(f.mois)
    assert.deepEqual(appels, attendu, `${jour} : ${JSON.stringify(appels)}`)
    const couvert = new Set(appels.flatMap(p => [p - 1, p]))
    for (const m of f.mois) {
      assert.ok(couvert.has(Number(m.slice(0, 4))), `${jour} : ${m} n est couvert par aucun appel`)
    }
  }
})

// ─── CE QUE DIT CHAQUE CASE ────────────────────────────────────────────────

const photo = (o = {}) => ({
  listing_id: '111', mois: '2026-05-01', nature: 'clos',
  montant_estime_cents: 500000, montant_affiche_cents: null,
  nuits_indisponibles: null, nuits_mesurees: null, motif: null,
  releve_le: '2026-11-02', ...o
})

test('LE TEST QUI COMPTE : un montant ABSENT n est jamais 0, et ZERO n est pas « il a gagne zero »', () => {
  const absent = E.caseComparable(photo({ montant_estime_cents: null, motif: 'revenu absent du relevé AirROI' }), '2026-05', '2026-11')
  assert.equal(absent.etat, 'nc', 'un revenu absent est rendu comme un chiffre')
  assert.equal(absent.motif, 'revenu absent du relevé AirROI', 'le motif est perdu')
  assert.ok(!('montant_cents' in absent), 'un montant est invente pour un revenu absent')
  const zero = E.caseComparable(photo({ montant_estime_cents: 0 }), '2026-05', '2026-11')
  assert.equal(zero.etat, 'inactif', 'zero est affiche comme un revenu de zero euro')
  assert.equal(E.caseComparable(null, '2026-05', '2026-11').etat, 'absent')
  // ⚠ `Number('')` VAUT 0 : une chaine vide est une absence, pas un zero.
  assert.equal(E.caseComparable(photo({ montant_estime_cents: '' }), '2026-05', '2026-11').etat, 'nc')
})

test('LE TEST QUI COMPTE : un mois a venir couvert PARTIELLEMENT ne donne pas de montant', () => {
  // Le calendrier commence a sa date de capture : un mois couvert sur 4 nuits
  // se lirait comme un mois creux (meme filtre que la bande).
  const c = E.caseComparable(photo({
    mois: '2027-02-01', nature: 'futur', montant_estime_cents: null,
    montant_affiche_cents: 12000, nuits_indisponibles: 2, nuits_mesurees: 4
  }), '2027-02', '2026-11')
  assert.equal(c.etat, 'partiel')
  assert.equal(c.nuits_mesurees, 4)
  assert.equal(c.jours, 28)
  assert.ok(!('montant_cents' in c), 'un mois partiel porte un montant')
  // Sans le compte des nuits mesurees, la couverture est INCONNUE : pas entiere.
  const inconnue = E.caseComparable(photo({ mois: '2027-01-01', nature: 'futur', montant_affiche_cents: 5000, nuits_mesurees: null }), '2027-01', '2026-11')
  assert.equal(inconnue.etat, 'nc', 'une couverture inconnue est prise pour entiere')
})

test('un mois a venir entier rend l occupe et ses nuits prises', () => {
  const c = E.caseComparable(photo({
    mois: '2026-12-01', nature: 'futur', montant_estime_cents: null,
    montant_affiche_cents: 98000, nuits_indisponibles: 10, nuits_mesurees: 31
  }), '2026-12', '2026-11')
  assert.deepEqual(
    { etat: c.etat, m: c.montant_cents, n: c.nuits_indisponibles, t: c.nuits_mesurees },
    { etat: 'futur', m: 98000, n: 10, t: 31 })
})

test('LE TEST QUI COMPTE : un `futur` sur un mois CLOS est ecarte, meme si la base le rend', () => {
  // La fonction SQL filtre deja ; une version collee a moitie ne le ferait
  // pas. La case d un mois clos ne doit jamais dire « occupe ».
  const f = E.fenetreDetail('2026-11-25')
  const d = E.detailDesComparables({
    lignes: [photo({ mois: '2026-05-01', nature: 'futur', montant_estime_cents: null, montant_affiche_cents: 99999, nuits_mesurees: 31, nuits_indisponibles: 31 })],
    retenus: [{ listing_id: '111', nom: 'Gite', actif: true }],
    fenetre: f
  })
  assert.equal(d.comparables[0].mois['2026-05'].etat, 'absent',
    `un futur perime est rendu comme ${d.comparables[0].mois['2026-05'].etat}`)
})

test('LE TEST QUI COMPTE : d un meme comparable, seule la photo la plus recente compte', () => {
  const f = E.fenetreDetail('2026-11-25')
  const d = E.detailDesComparables({
    lignes: [
      photo({ montant_estime_cents: 100000, releve_le: '2026-10-01' }),
      photo({ montant_estime_cents: 300000, releve_le: '2026-11-02' }),
      photo({ montant_estime_cents: 200000, releve_le: '2026-09-01' })
    ],
    retenus: [],
    fenetre: f
  })
  assert.equal(d.comparables[0].mois['2026-05'].montant_cents, 300000)
  assert.deepEqual(d.releves, { de: '2026-11-02', a: '2026-11-02' }, 'la date du releve n est pas celle de la photo gardee')
})

test('LE TEST QUI COMPTE : qui est liste, et dans quel ordre', () => {
  const f = E.fenetreDetail('2026-11-25')
  const d = E.detailDesComparables({
    lignes: [
      photo({ listing_id: '222' }),
      photo({ listing_id: '333' }), // n'est plus retenu, mais porte la bande
      photo({ listing_id: '444' })
    ],
    retenus: [
      { listing_id: '222', nom: 'Zebre', actif: true },
      { listing_id: '444', nom: null, actif: true },
      { listing_id: '333', nom: 'Ancien', actif: false },
      { listing_id: '555', nom: 'Nouveau', actif: true }, // retenu, pas encore releve
      { listing_id: '666', nom: 'Oublie', actif: false } // ni retenu ni photo
    ],
    fenetre: f
  })
  const ids = d.comparables.map(c => c.listing_id)
  assert.ok(!ids.includes('666'), 'un ancien comparable sans photo est liste')
  assert.ok(ids.includes('555'), 'un comparable choisi depuis le dernier releve disparait')
  // Les retenus d'abord, par titre, un titre absent en dernier ; puis les autres.
  assert.deepEqual(ids, ['555', '222', '444', '333'])
  assert.equal(d.comparables.find(c => c.listing_id === '333').retenu, false)
  assert.equal(d.comparables.find(c => c.listing_id === '555').mois['2026-05'].etat, 'absent')
})

test('LE TEST QUI COMPTE : deux appels qui se recouvrent ne DOUBLENT pas l annee commune', () => {
  const f = E.fenetreDetail('2026-11-25')
  const ligne = (annee, mois, total) => ({
    property_uuid: 'b1', annee, mois, sejours: 1, recu_cents: total, a_venir_cents: 0,
    total_cents: total, bruts: 0, sans_montant: 0
  })
  // `revenus_annee(2026)` et `revenus_annee(2027)` rendent TOUS LES DEUX 2026.
  const logement = E.detailDuLogement({
    lignes: [ligne(2026, 5, 1000), ligne(2025, 12, 700), ligne(2026, 5, 1000), ligne(2027, 1, 400),
      ligne(2025, 1, 999), { ...ligne(2026, 6, 50), property_uuid: 'autre' }],
    bien: 'b1',
    fenetre: f
  })
  assert.equal(logement['2026-05'].total_cents, 1000, 'mai 2026 est compte deux fois')
  assert.equal(logement['2025-12'].total_cents, 700)
  assert.equal(logement['2027-01'].total_cents, 400)
  assert.ok(!('2025-01' in logement), 'un mois hors de la fenetre entre dans le detail')
  assert.ok(!('2026-06' in logement), 'un autre logement entre dans la ligne')
  assert.ok(!('2026-07' in logement), 'un trou est comble')
})

// ─── LE RENDU ──────────────────────────────────────────────────────────────

// ⚠ LE DOUBLE DE `t` REND LA CLE **ET** SES PARAMETRES : un double qui les
// jetterait ne verrait pas une phrase privee de sa valeur.
// ⚠ SANS GUILLEMETS : la page echappe ce qu'elle recoit, et un JSON echappe
// ne se lirait plus dans les assertions.
const t = (k, v) => (v ? `${k}(${Object.entries(v).map(([a, b]) => `${a}=${b}`).join(',')})` : k)
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const outils = {
  t, esc,
  montant: (c) => `${c / 100}EUR`,
  moisCourt: (m) => `c${m}`,
  moisLong: (m) => `L${m}`,
  dateLongue: (j) => `D${j}`,
  nomLogement: 'La bulle'
}
const detailDe = (o = {}) => ({
  mois: E.fenetreDetail('2026-11-25').mois,
  mois_courant: '2026-11',
  logement: { '2026-05': { total_cents: 210000, sans_montant: 0 }, '2026-12': { total_cents: 80000, sans_montant: 0 } },
  comparables: [{
    listing_id: '1238875863287828333', nom: 'Appartement', retenu: true,
    mois: {
      '2026-05': { etat: 'clos', montant_cents: 300000, releve_le: '2026-11-02' },
      '2026-12': { etat: 'futur', montant_cents: 98000, nuits_indisponibles: 10, nuits_mesurees: 31, releve_le: '2026-11-02' }
    }
  }],
  releves: { de: '2026-11-02', a: '2026-11-02' },
  ...o
})

test('LE TEST QUI COMPTE : le logement de l hote est en PREMIERE ligne (decision D1)', () => {
  const html = detailComparablesHtml(detailDe(), outils)
  const corps = html.slice(html.indexOf('<tbody>'))
  const iMoi = corps.indexOf('La bulle')
  const iCmp = corps.indexOf('Appartement')
  assert.ok(iMoi > -1 && iCmp > -1 && iMoi < iCmp, 'le logement de l hote n est pas en tete du tableau')
  assert.match(html, /210000|2100EUR/, 'le montant du logement n est pas rendu')
})

test('LE TEST QUI COMPTE : quinze colonnes de mois, dans les DEUX formes', () => {
  const html = detailComparablesHtml(detailDe(), outils)
  const tableau = html.slice(html.indexOf('<table'), html.indexOf('</table>'))
  const cartes = html.slice(html.indexOf('<ul class="rev-liste rev-cmp-liste">'))
  assert.equal((tableau.match(/<th scope="col" class="rev-tbl__num/g) || []).length, 15, 'le tableau n a pas 15 mois')
  // Deux lignes (le logement + un comparable) × 15 mois, cote telephone.
  assert.equal((cartes.match(/<dt>/g) || []).length, 30, 'les cartes du telephone n ont pas 15 mois chacune')
  // Le meme mois dit la meme chose dans les deux formes.
  assert.ok(tableau.includes('980EUR') && cartes.includes('980EUR'), 'l occupe de decembre manque dans une des formes')
  assert.ok(cartes.includes('revenue.detail_nuits(n=10,total=31)'), 'les nuits prises manquent au telephone')
})

test('LE TEST QUI COMPTE : un mois sans releve dit « n. c. » avec son motif, jamais 0 ni tiret', () => {
  const html = detailComparablesHtml(detailDe(), outils)
  // Janvier 2026 n a aucune photo pour ce comparable.
  assert.match(html, /<abbr title="revenue\.detail_motif_absent">revenue\.detail_nc<\/abbr>/,
    'une absence n est pas dite avec son motif')
  assert.ok(!/>0EUR</.test(html), 'une absence est rendue comme 0')
  // Le logement : un mois sans ligne n est pas « 0 € », c est « aucun ».
  assert.match(html, /<abbr title="revenue\.detail_aucun_titre">revenue\.detail_aucun<\/abbr>/)
})

test('LE TEST QUI COMPTE : le lien ouvre l annonce, le titre est ECHAPPE', () => {
  const html = detailComparablesHtml(detailDe({
    comparables: [{ listing_id: '1238875863287828333', nom: '<img src=x onerror=alert(1)>', retenu: true, mois: {} }]
  }), outils)
  assert.ok(html.includes('href="https://www.airbnb.fr/rooms/1238875863287828333"'), 'le lien de l annonce manque')
  assert.ok(html.includes('rel="noopener noreferrer"'), 'le lien externe garde la main sur la page')
  assert.ok(!html.includes('<img src=x'), 'un titre d annonce est injecte tel quel dans la page')
  // Un identifiant qui n est pas un nombre ne fait pas de lien.
  const sansLien = detailComparablesHtml(detailDe({
    comparables: [{ listing_id: 'javascript:alert(1)', nom: 'X', retenu: true, mois: {} }]
  }), outils)
  assert.ok(!sansLien.includes('airbnb.fr') && !sansLien.includes('javascript:'),
    'un lien est construit depuis un identifiant non verifie')
})

test('un titre absent se dit « Annonce sans titre », et un ancien comparable le dit', () => {
  const html = detailComparablesHtml(detailDe({
    comparables: [{ listing_id: '42', nom: null, retenu: false, mois: {} }]
  }), outils)
  assert.match(html, /revenue\.detail_sans_titre/)
  assert.match(html, /revenue\.detail_plus_retenu/)
})

test('LE TEST QUI COMPTE : lecture en cours, ratee, ou vide — trois etats, aucun ne se tait', () => {
  assert.match(detailComparablesHtml(undefined, outils), /revenue\.computing/)
  assert.match(detailComparablesHtml(null, outils), /revenue\.detail_echec/)
  // ⚠ DES COMPARABLES ILLISIBLES NE SONT PAS « AUCUN COMPARABLE ».
  assert.match(detailComparablesHtml(detailDe({ comparables: null }), outils), /revenue\.detail_echec/)
  assert.match(detailComparablesHtml(detailDe({ comparables: [] }), outils), /revenue\.detail_vide/)
})

test('LE TEST QUI COMPTE : des revenus illisibles ne s affichent pas comme « aucun sejour »', () => {
  const v = valeurLogement(null, '2026-05', outils)
  assert.equal(v.texte, 'revenue.detail_nc')
  assert.equal(v.titre, 'revenue.detail_motif_logement')
  // Un mois dont aucun montant n est calculable : n. c., pas 0.
  const refus = valeurLogement({ '2026-05': { total_cents: 0, sans_montant: 2 } }, '2026-05', outils)
  assert.equal(refus.titre, 'revenue.detail_motif_refus')
})

test('LE TEST QUI COMPTE : la date du releve est dite (un resume sans son age ne vaut rien)', () => {
  const une = detailComparablesHtml(detailDe(), outils)
  assert.match(une, /revenue\.detail_releve\(date=D2026-11-02\)/)
  const deux = detailComparablesHtml(detailDe({ releves: { de: '2026-10-05', a: '2026-11-02' } }), outils)
  assert.match(deux, /revenue\.detail_releves\(de=D2026-10-05,a=D2026-11-02\)/)
})

test('les mois en cours et a venir sont marques, le mois courant porte la frontiere', () => {
  const html = detailComparablesHtml(detailDe(), outils)
  assert.match(html, /<th scope="col" class="rev-tbl__num rev-cmp--avenir rev-cmp--courant">c2026-11<\/th>/)
  assert.match(html, /<th scope="col" class="rev-tbl__num ">c2026-10<\/th>/)
  assert.match(html, /<th scope="col" class="rev-tbl__num rev-cmp--avenir">c2027-02<\/th>/)
})

test('une case partielle dit ses nuits mesurees, un mois inactif le dit en mots', () => {
  assert.equal(valeurCase({ etat: 'partiel', nuits_mesurees: 4, jours: 31 }, outils).titre,
    'revenue.detail_motif_partiel(n=4,total=31)')
  assert.equal(valeurCase({ etat: 'inactif' }, outils).texte, 'revenue.detail_inactif')
})
