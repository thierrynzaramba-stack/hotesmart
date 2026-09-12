// tests/pickup-yield.test.js
// LE DEFAUT QU'ILS EMPECHENT : un « -100 % » qui veut dire deux choses
// opposees. Le 12 septembre 2026, les deux biens de Bagneres affichaient le
// meme -100 % de CA sur octobre : Coeur de vie 23 parce que son calendrier est
// FERME (bascule inachevee), La bulle parce qu'elle est ouverte et n'a pas
// encore vendu. Un moteur qui confond les deux suggere de brader un logement
// qu'on ne peut pas vendre.
//
// Spec : docs/specs/spec-yieldflow-v1.md §6 (etape 3, lot 3.3)

const test = require('node:test')
const assert = require('node:assert')
const {
  pickup, pivotN1, filtrerADate, decalerJours, debutDePeriode, MOTIFS_ECART, DRAPEAUX
} = require('../lib/yield/pickup')
// ⚠ LA VRAIE CONSTANTE, PAS UNE PARAPHRASE — releve en review. Le double
// ecrivait `raison: 'futur_non_amorce'` la ou `capacite.js` produit
// `'futur_sans_memoire_intention'` : un consommateur de l'etape 4 branche sur
// cette chaine aurait ete teste contre une valeur qui n'existe nulle part.
const { NON_CALCULABLE } = require('../lib/yield/capacite')

// Un eclatement a la forme de ce que rend `eclater()`.
function ecl (nuits, { prix = 100, personnes = 2, vente = null, fiable = true, compte = true } = {}) {
  return {
    compte, personnes, date_vente: vente, date_vente_fiable: fiable,
    nuits: nuits.map(d => ({ date: d, prix, hors_reference: false }))
  }
}
const cap = (jours, extra = {}) => ({ calculable: true, jours_ouverts: jours, ...extra })
const capNulle = () => ({ calculable: false, jours_ouverts: null,
  raison: NON_CALCULABLE.FUTUR_NON_AMORCE })

test('LE TEST QUI COMPTE : le pivot N-1 se calcule en JOURS, pas date a date', () => {
  // « Au meme delai » est litteralement un nombre de jours avant le debut de
  // la periode. Reculer d'un an date a date donne le meme resultat neuf fois
  // sur dix — mais pas quand un 29 fevrier s'intercale, et l'ecart glisserait
  // alors sans que rien ne le signale.
  const p = pivotN1('2026-09-12', '2026-10')
  assert.equal(p.delai_jours, 19, 'du 12 septembre au 1er octobre')
  assert.equal(p.pivot_n1, '2025-09-12')

  // Mars vu du 15 janvier : 2024 est bissextile, 2023 non. Date a date, le
  // delai glisserait de 46 a 45 jours. En jours, il ne glisse pas.
  const b = pivotN1('2024-01-15', '2024-03')
  assert.equal(b.delai_jours, 46)
  assert.equal(b.pivot_n1, '2023-01-14', 'un jour plus tot, pour tenir le delai')
  assert.equal(debutDePeriode('2023-03') , '2023-03-01')
  assert.equal(decalerJours('2023-03-01', -46), '2023-01-14')
})

test('le filtre a date : retient les ventes anterieures, COMPTE les autres', () => {
  const f = filtrerADate([
    ecl(['2026-10-01'], { vente: '2026-08-01' }),
    ecl(['2026-10-05'], { vente: '2026-09-20' }),
    ecl(['2026-10-08'], { vente: null }),
    ecl(['2026-10-09'], { vente: '2026-05-01', fiable: false }),
    ecl(['2026-10-10'], { compte: false })
  ], '2026-09-12')
  assert.equal(f.retenus.length, 1)
  assert.equal(f.candidats, 4, 'la ligne annulee n est meme pas candidate')
  assert.equal(f.ecartes[MOTIFS_ECART.POSTERIEURE], 1)
  assert.equal(f.ecartes[MOTIFS_ECART.SANS_DATE], 1)
  assert.equal(f.ecartes[MOTIFS_ECART.NON_FIABLE], 1)
})

test('LE TEST QUI COMPTE : une date de vente NON FIABLE est ecartee, pas supposee', () => {
  // ⚠ CAS REEL DES BIENS MIGRES. La date de vente d'une ligne recreee cote
  // Channex vaut la date de la MIGRATION. La garder ferait apparaitre tout le
  // portefeuille au meme jour : le pickup bondirait de zero a tout, et l'hote
  // lirait une explosion des ventes le jour de sa bascule.
  const r = pickup([
    ecl(['2026-10-01', '2026-10-02'], { prix: 100, vente: '2026-09-10', fiable: false })
  ], { periode: '2026-10', pivot: '2026-09-12', capacites: new Map([['2026-10', cap(31)]]) })
  assert.equal(r.a_date.nuitees, 0, 'la resa n entre pas dans le portefeuille')
  assert.equal(r.ecartes[MOTIFS_ECART.NON_FIABLE], 1)
  assert.ok(r.drapeaux.includes(DRAPEAUX.DATES_INCOMPLETES), 'et la perte est DITE')
})

test('LE TEST QUI COMPTE : ferme a la vente n est pas « n a rien vendu »', () => {
  // ⚠ COEUR DE VIE 23, 12 SEPTEMBRE 2026. Octobre 2026 a ZERO jour ouvert :
  // la bascule n'est pas finie, le calendrier est ferme. Son CA a date vaut 0
  // comme celui d'un bien ouvert qui ne vend pas — le drapeau seul les separe.
  const capacites = new Map([['2026-10', cap(0)], ['2025-10', cap(31)]])
  const r = pickup([
    ecl(['2025-10-01', '2025-10-02'], { prix: 100, vente: '2025-04-20' })
  ], { periode: '2026-10', pivot: '2026-09-12', capacites })
  assert.equal(r.a_date.ca, 0)
  assert.equal(r.vs_n1.ca.n1, 200)
  assert.equal(r.vs_n1.ca.variation, -1, 'le -100 % reste vrai...')
  assert.ok(r.drapeaux.includes(DRAPEAUX.PERIODE_FERMEE), '...mais il est EXPLIQUE')
  assert.equal(r.a_date.taux_occupation, null, 'zero jour ouvert : pas de TO')

  // Le meme portefeuille vide, mais sur une periode OUVERTE : le drapeau tombe,
  // et le -100 % redevient un signal commercial.
  const ouvert = pickup([
    ecl(['2025-10-01', '2025-10-02'], { prix: 100, vente: '2025-04-20' })
  ], { periode: '2026-10', pivot: '2026-09-12',
    capacites: new Map([['2026-10', cap(31)], ['2025-10', cap(31)]]) })
  assert.ok(!ouvert.drapeaux.includes(DRAPEAUX.PERIODE_FERMEE))
  assert.equal(ouvert.a_date.taux_occupation, 0, 'ouvert et invendu : 0 %, un vrai zero')
})

test('capacite non amorcee : le zero ne se compare a rien, et on le dit', () => {
  const r = pickup([], { periode: '2026-10', pivot: '2026-09-12',
    capacites: new Map([['2026-10', capNulle()]]) })
  assert.ok(r.drapeaux.includes(DRAPEAUX.CAPACITE_NON_AMORCEE))
  assert.ok(!r.drapeaux.includes(DRAPEAUX.PERIODE_FERMEE), 'inconnu n est pas ferme')
})

test('LE TEST QUI COMPTE : le portefeuille N-1 est RECONSTRUIT, jamais observe', () => {
  // ⚠ LE BIAIS STRUCTUREL DU PICKUP RETROSPECTIF. Une reservation vendue avant
  // le pivot N-1 puis annulee depuis a disparu du snapshot : elle comptait ce
  // jour-la, elle ne compte plus. Le biais va TOUJOURS dans le meme sens — le
  // N-1 est sous-estime, donc la progression affichee est flattee.
  // Mesure au 12/09/2026 sur La bulle / octobre 2025 : 1 nuitee invisible.
  //
  // ⚠ RELEVE EN REVIEW : la premiere version de ce test se contentait
  // d'asserter le drapeau, qui se leve des qu'une capacite N-1 est passee —
  // il serait reste vert si le drapeau avait ete pousse inconditionnellement.
  // Ce qu'il faut prouver, c'est que le chiffre N-1 est bien AMPUTE de
  // l'annulation, et que le drapeau tombe quand il n'y a pas de N-1 du tout.
  const annulee = ecl(['2025-10-01'], { prix: 500, vente: '2025-04-20' })
  annulee.compte = false            // annulee depuis : `eclater` la sort du compte
  const r = pickup([
    annulee,
    ecl(['2025-10-02'], { prix: 100, vente: '2025-04-20' }),
    ecl(['2026-10-01'], { prix: 100, vente: '2026-08-01' })
  ], { periode: '2026-10', pivot: '2026-09-12',
    capacites: new Map([['2026-10', cap(31)], ['2025-10', cap(31)]]) })
  assert.ok(r.drapeaux.includes(DRAPEAUX.PORTEFEUILLE_RECONSTRUIT))
  assert.equal(r.a_date_n1.ca, 100,
    'les 500 € qui existaient au 12/09/2025 ont disparu — c est le biais meme')
  assert.equal(r.vs_n1.ca.variation, 0, 'donc la progression affichee est flattee')

  // Sans aucune periode N-1, il n y a rien a reconstruire : le drapeau tombe.
  const sansN1 = pickup([ecl(['2026-10-01'], { prix: 100, vente: '2026-08-01' })],
    { periode: '2026-10', pivot: '2026-09-12',
      capacites: new Map([['2026-10', cap(31)]]) })
  assert.ok(!sansN1.drapeaux.includes(DRAPEAUX.PORTEFEUILLE_RECONSTRUIT))
})

test('LE TEST QUI COMPTE : aveugle avant bascule se DIT, il ne vaut pas zero', () => {
  // Un bien dont le N-1 n'est pas visible — dates de vente toutes non fiables —
  // n'a pas fait zero l'an dernier : ON NE SAIT PAS. Sans ce drapeau, le pickup
  // afficherait « +infini » de progression.
  const r = pickup([
    ecl(['2026-10-01'], { prix: 100, vente: '2026-08-01' }),
    ecl(['2025-10-01'], { prix: 100, vente: '2025-01-01', fiable: false })
  ], { periode: '2026-10', pivot: '2026-09-12',
    capacites: new Map([['2026-10', cap(31)], ['2025-10', cap(31)]]) })
  assert.ok(r.drapeaux.includes(DRAPEAUX.AVEUGLE_AVANT_BASCULE))
  assert.equal(r.vs_n1.ca.n1, 0)
  assert.equal(r.vs_n1.ca.variation, null, 'ni +100 %, ni +infini : rien')
  assert.equal(r.vs_n1.ca.ecart, null, 'et pas davantage un ecart de +100 €')
})

test('LE TEST QUI COMPTE : un N-1 vendu APRES le pivot n est pas un aveuglement', () => {
  // ⚠ LES DEUX ERREURS INVERSES RELEVEES EN REVIEW. La condition portait sur le
  // nombre de CANDIDATS, donc le drapeau criait « aveugle » sur le cas le plus
  // SAIN — un N-1 dont les ventes sont simplement posterieures au pivot, ce qui
  // est l'information la plus actionnable du pickup : « l'an dernier au meme
  // delai, le portefeuille etait vide lui aussi ». Un drapeau qui crie tout le
  // temps ne dit plus rien.
  const r = pickup([
    ecl(['2025-10-05'], { prix: 100, vente: '2025-09-25' }),
    ecl(['2025-10-06'], { prix: 100, vente: '2025-09-30' })
  ], { periode: '2026-10', pivot: '2026-09-12',
    capacites: new Map([['2026-10', cap(31)], ['2025-10', cap(31)]]) })
  assert.equal(r.ecartes_n1[MOTIFS_ECART.POSTERIEURE], 2)
  assert.ok(!r.drapeaux.includes(DRAPEAUX.AVEUGLE_AVANT_BASCULE),
    'ecarter a bon droit n est pas etre aveugle')
  assert.equal(r.a_date_n1.nuitees, 0)
  assert.equal(r.vs_n1.ca.n1, 0, 'un VRAI zero, qui se compare')
})

test('LE TEST QUI COMPTE : aucun candidat N-1 et aucune histoire = aveugle', () => {
  // ⚠ L'AUTRE MOITIE DU MEME DEFAUT. Le drapeau se taisait sur le cas qu'il
  // NOMME : un bien migre dont l'historique N-1 n'a pas ete repris n'a AUCUN
  // candidat, et l'ancienne condition exigeait qu'il y en ait au moins un.
  const r = pickup([ecl(['2026-10-01', '2026-10-02'], { prix: 250, vente: '2026-08-01' })],
    { periode: '2026-10', pivot: '2026-09-12',
      capacites: new Map([['2026-10', cap(31)], ['2025-10', cap(31)]]) })
  assert.equal(r.candidats_n1, 0)
  assert.ok(r.drapeaux.includes(DRAPEAUX.AVEUGLE_AVANT_BASCULE))
  assert.equal(r.vs_n1.ca.ecart, null, 'pas de « +500 € » contre une ignorance')
  assert.equal(r.vs_n1.taux_occupation.ecart, null, 'ni de « +6,45 points »')

  // Mais si le bien a de l'histoire AVANT la periode N-1, son zero est VRAI :
  // il vendait, il n'a rien vendu ce mois-la. Le drapeau doit tomber.
  const avecHistoire = pickup([
    ecl(['2025-06-01'], { prix: 100, vente: '2025-02-01' }),
    ecl(['2026-10-01', '2026-10-02'], { prix: 250, vente: '2026-08-01' })
  ], { periode: '2026-10', pivot: '2026-09-12',
    capacites: new Map([['2026-10', cap(31)], ['2025-10', cap(31)]]) })
  assert.ok(!avecHistoire.drapeaux.includes(DRAPEAUX.AVEUGLE_AVANT_BASCULE))
  assert.equal(avecHistoire.vs_n1.ca.ecart, 500, 'la progression est reelle')
})

test('le pickup nominal : progression lisible, et le delai porte dans la donnee', () => {
  const r = pickup([
    // N-1 : deux nuits vendues avant le pivot, une apres (invisible a date).
    ecl(['2025-10-01', '2025-10-02'], { prix: 100, vente: '2025-06-01' }),
    ecl(['2025-10-20'], { prix: 200, vente: '2025-09-30' }),
    // N : trois nuits vendues avant le pivot.
    ecl(['2026-10-01', '2026-10-02', '2026-10-03'], { prix: 120, vente: '2026-07-15' })
  ], { periode: '2026-10', pivot: '2026-09-12', capacitePersonnes: 2,
    capacites: new Map([['2026-10', cap(31)], ['2025-10', cap(31)]]) })
  assert.equal(r.delai_jours, 19)
  assert.equal(r.pivot_n1, '2025-09-12')
  assert.equal(r.a_date.ca, 360)
  assert.equal(r.a_date_n1.ca, 200, 'la vente du 30 septembre N-1 n est pas encore la')
  assert.equal(r.ecartes_n1[MOTIFS_ECART.POSTERIEURE], 1)
  assert.equal(r.vs_n1.ca.ecart, 160)
  assert.equal(r.vs_n1.ca.variation, 0.8, '+80 %')
  assert.equal(r.vs_n1.nuitees.valeur, 3)
  assert.equal(r.vs_n1.nuitees.n1, 2)
})

test('une periode N-1 sans aucune capacite : dit absente, pas zero', () => {
  const r = pickup([ecl(['2026-10-01'], { prix: 100, vente: '2026-08-01' })],
    { periode: '2026-10', pivot: '2026-09-12',
      capacites: new Map([['2026-10', cap(31)]]) })
  assert.equal(r.a_date_n1, null)
  assert.ok(r.drapeaux.includes(DRAPEAUX.CAPACITE_N1_NON_AMORCEE))
  assert.equal(r.vs_n1.ca.non_calculable, DRAPEAUX.CAPACITE_N1_NON_AMORCEE)
  assert.equal(r.vs_n1.ca.variation, null)
  assert.equal(r.vs_n1.ca.ecart, null, 'un ecart est un chiffre : il se tait aussi')
  assert.equal(r.vs_n1.ca.valeur, 100, 'la valeur de l annee en cours reste lisible')
})

test('le drapeau « estime » traverse le pickup', () => {
  const r = pickup([
    ecl(['2025-10-01'], { prix: 100, vente: '2025-06-01' }),
    ecl(['2026-10-01'], { prix: 100, vente: '2026-08-01' })
  ], { periode: '2026-10', pivot: '2026-09-12',
    capacites: new Map([
      ['2026-10', cap(31)],
      ['2025-10', cap(31, { estimee: true, jours_estimes_ouverts: 31 })]
    ]) })
  assert.equal(r.vs_n1.taux_occupation.estimee, true)
  assert.equal(r.vs_n1.ca.estimee, undefined, 'le CA est MESURE, jamais estime')
})

test('le module est PUR : ni base, ni reseau, ni horloge', () => {
  // ⚠ CE TEST VERIFIE LA FORME, PAS LA PROPRIETE — dit en review, assume ici.
  // Il scanne des sous-chaines : un `new Date` sans parentheses ou l'import
  // d'un module lui-meme impur passeraient. Il est peu couteux et attrape la
  // faute la plus probable (lire l'horloge au lieu du pivot recu), mais il ne
  // doit pas etre compte comme une garantie de purete.
  const src = require('node:fs').readFileSync(
    require.resolve('../lib/yield/pickup'), 'utf8')
  for (const interdit of ['supabase', 'fetch(', 'require(\'http', 'Date.now(',
    'performance.now', 'process.env']) {
    assert.ok(!src.includes(interdit), `le module ne doit pas contenir ${interdit}`)
  }
  // `new Date` n'est autorise qu'avec un argument explicite.
  assert.ok(!/new Date\s*\(\s*\)/.test(src), 'aucune lecture de l horloge systeme')

  // La preuve par l'usage : deux appels identiques rendent le meme resultat,
  // et le pivot ne vient QUE des options.
  const args = [[], { periode: '2026-10', pivot: '2026-09-12' }]
  assert.deepEqual(pickup(...args), pickup(...args))
  assert.equal(pickup([], { periode: '2026-10' }).pivot, null,
    'sans pivot fourni, le module ne s en invente pas un')
})

test('LE TEST QUI COMPTE : une periode N-1 FERMEE ne felicite personne', () => {
  // ⚠ RELEVE EN REVIEW : le raisonnement de Coeur de vie 23, applique au cote
  // N-1, n'existait pas. Un bien ferme pour travaux l'an dernier n'a pas
  // « fait zero » : il ne POUVAIT pas vendre. Le moteur lisait « +360 € contre
  // l'an dernier » et felicitait au lieu d'alerter — la conclusion fausse
  // symetrique de celle qu'on avait corrigee cote N.
  const r = pickup([
    ecl(['2026-10-01', '2026-10-02', '2026-10-03'], { prix: 120, vente: '2026-07-15' })
  ], { periode: '2026-10', pivot: '2026-09-12',
    capacites: new Map([['2026-10', cap(31)], ['2025-10', cap(0)]]) })
  assert.ok(r.drapeaux.includes(DRAPEAUX.PERIODE_N1_FERMEE))
  assert.equal(r.vs_n1.ca.valeur, 360, 'le realise de cette annee reste lisible')
  assert.equal(r.vs_n1.ca.ecart, null, 'mais on ne se compare pas a une fermeture')
  assert.equal(r.vs_n1.ca.non_calculable, DRAPEAUX.PERIODE_N1_FERMEE)
})

test('periode N absente des capacites : le drapeau sort quand meme', () => {
  // ⚠ RELEVE EN REVIEW. Sans ligne N — ni vente, ni cle de capacite — le bloc
  // de drapeaux etait entierement saute : `capacite_de_la_periode_non_amorcee`
  // ne se levait PAS dans le cas qu'il nomme.
  const r = pickup([], { periode: '2026-10', pivot: '2026-09-12', capacites: new Map() })
  assert.equal(r.a_date, null)
  assert.ok(r.drapeaux.includes(DRAPEAUX.CAPACITE_NON_AMORCEE))
  assert.ok(r.drapeaux.includes(DRAPEAUX.CAPACITE_N1_NON_AMORCEE))
})

test('LE TEST QUI COMPTE : une annee deja commencee ne perd pas un jour de N-1', () => {
  // ⚠ RELEVE EN REVIEW. La regle « en jours, pas date a date » est juste pour
  // une periode A VENIR — le sujet est le delai. Appliquee a une periode DEJA
  // COMMENCEE, elle devenait fausse : le cumul 2025 au 12 septembre se
  // comparait a 2024 arrete au 11, parce que 2024 est bissextile. Une journee
  // de ventes manquante cote N-1, silencieuse, et toujours dans le meme sens.
  const a = pivotN1('2025-09-12', '2025')
  assert.equal(a.pivot_n1, '2024-09-12', 'le MEME jour calendaire, pas la veille')
  assert.equal(a.alignement, 'meme_jour_calendaire')
  assert.ok(a.delai_jours < 0, 'la periode a commence')

  // Et la regle en jours reste celle des periodes a venir.
  const b = pivotN1('2026-09-12', '2026-10')
  assert.equal(b.alignement, 'delai_avant_le_debut')
  assert.equal(b.delai_jours, 19)

  // Un mois deja commence suit la meme regle que l'annee.
  const c = pivotN1('2026-10-15', '2026-10')
  assert.equal(c.pivot_n1, '2025-10-15')
  assert.equal(c.alignement, 'meme_jour_calendaire')
})

test('LE TEST QUI COMPTE : une cle de periode impossible ne casse rien', () => {
  // ⚠ RELEVE EN REVIEW. La validation locale ne verifiait que le FORMAT :
  // `'2026-13-45'` passait et `new Date` levait un RangeError qui casse la
  // page ; `'2026-02-30'` devenait silencieusement le 2 mars. La leçon avait
  // deja ete payee dans `capacite.js` — on y reutilise `estJourISO`.
  assert.equal(pivotN1('2026-09-12', '2026-13-45'), null)
  assert.equal(debutDePeriode('2026-02-30'), null)
  assert.equal(debutDePeriode('2026-13'), null)
  assert.equal(decalerJours('2026-02-30', 1), null, 'pas d invention de date')
  assert.equal(pivotN1('pas-une-date', '2026-10'), null)
  const r = pickup([], { periode: '2026-13', pivot: '2026-09-12' })
  assert.equal(r.pivot_n1, null)
  assert.equal(r.delai_jours, null)
})

test('LE TEST QUI COMPTE : la frontiere du pivot, au jour et non a l instant', () => {
  // ⚠ REGLE 13. `bookingTime` de Beds24 porte l'heure, `arrival` non :
  // comparer les deux en brut avait produit « 164 dates corrompues » qui
  // n'etaient que 162 ventes le jour meme. Les deux cas frontaliers :
  const f = filtrerADate([
    ecl(['2026-10-01'], { vente: '2026-09-12' }),              // AU pivot
    ecl(['2026-10-02'], { vente: '2026-09-12T18:30:00Z' }),    // le jour meme, avec l heure
    ecl(['2026-10-03'], { vente: '2026-09-13' })               // le lendemain
  ], '2026-09-12')
  assert.equal(f.retenus.length, 2, '« au plus tard AU pivot » inclut le pivot')
  assert.equal(f.ecartes[MOTIFS_ECART.POSTERIEURE], 1)

  // Une date illisible est ECARTEE, jamais retenue par defaut.
  const g = filtrerADate([ecl(['2026-10-01'], { vente: 'hier' })], '2026-09-12')
  assert.equal(g.retenus.length, 0)
  assert.equal(g.ecartes[MOTIFS_ECART.NON_FIABLE], 1)
})

test('les compteurs d ecart sont servis avec leur denominateur', () => {
  // ⚠ RELEVE EN REVIEW. « 6 vendues apres le pivot » ne se lit pas tant qu on
  // ignore si c est 6 sur 9 ou 6 sur 200.
  const r = pickup([
    ecl(['2026-10-01'], { vente: '2026-08-01' }),
    ecl(['2026-10-02'], { vente: '2026-09-20' }),
    ecl(['2026-10-03'], { vente: '2026-09-25' })
  ], { periode: '2026-10', pivot: '2026-09-12',
    capacites: new Map([['2026-10', cap(31)]]) })
  assert.equal(r.candidats, 3)
  assert.equal(r.ecartes[MOTIFS_ECART.POSTERIEURE], 2)
})

test('les dates incompletes disent DE QUEL COTE', () => {
  // ⚠ RELEVE EN REVIEW : un drapeau unique ne permettait pas a l interface de
  // savoir lequel des deux chiffres est degrade, donc lequel taire.
  const r = pickup([
    ecl(['2026-10-01'], { prix: 100, vente: '2026-08-01' }),
    ecl(['2025-10-01'], { prix: 100, vente: '2025-06-01' }),
    ecl(['2025-10-02'], { prix: 100, vente: null })
  ], { periode: '2026-10', pivot: '2026-09-12',
    capacites: new Map([['2026-10', cap(31)], ['2025-10', cap(31)]]) })
  assert.ok(r.drapeaux.includes(DRAPEAUX.DATES_INCOMPLETES_N1))
  assert.ok(!r.drapeaux.includes(DRAPEAUX.DATES_INCOMPLETES), 'le cote N est intact')
  assert.equal(r.ecartes_n1[MOTIFS_ECART.SANS_DATE], 1)
})

test('« hors perimetre » survit au pickup', () => {
  // ⚠ RELEVE EN REVIEW : la boucle de comparaison etait reecrite localement et
  // perdait la distinction que `indicateurs.js` declare essentielle — « l
  // appelant n a pas fourni la periode » n est pas « elle n existe pas ».
  // On reutilise `comparerAN1` plutot que de la reimplementer.
  const r = pickup([ecl(['2026-10-01'], { prix: 100, vente: '2026-08-01' })],
    { periode: '2026-10', pivot: '2026-09-12',
      capacites: new Map([['2026-10', cap(31)]]) })
  assert.equal(r.vs_n1.periode_n1, '2025-10')
  assert.equal(r.vs_n1.disponible, false)
})
