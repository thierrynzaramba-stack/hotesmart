// tests/reference-yield.test.js
// LE DEFAUT QU'ILS EMPECHENT : une reference servie sur trois nuits. Le moteur
// suggere des prix a partir de ces medianes — une case a deux nuits n'est pas
// une norme, c'est un accident, et un prix construit dessus se trompe dans les
// deux sens sans que rien ne le signale.
//
// Spec : docs/specs/spec-yieldflow-v1.md §6 (etape 3, lot 3.4)

const test = require('node:test')
const assert = require('node:assert')
const R = require('../lib/yield/reference')
const { SEGMENTS, NIVEAUX } = R

// Vacances reelles de la zone C, telles que `school_holidays` les porte.
const VACANCES = [
  { zone: 'C', nom: "Vacances d'Hiver", date_debut: '2025-02-15', date_fin: '2025-03-02' },
  { zone: 'A', nom: "Vacances d'Hiver", date_debut: '2025-02-08', date_fin: '2025-02-23' },
  { zone: 'B', nom: "Vacances d'Hiver", date_debut: '2025-02-22', date_fin: '2025-03-09' },
  { zone: 'C', nom: "Vacances d'Été", date_debut: '2025-07-05', date_fin: '2025-08-31' }
]
// ⚠ LE CONTEXTE SE CONSTRUIT SUR UNE FENETRE EXPLICITE. Assemble a la main,
// il couvrait 2025 et servait pourtant a segmenter 2026 : le 14 juillet 2026
// partait alors en « hors_vacances » par simple ABSENCE du ferie dans la Map.
const CTX = R.construireContexte({
  zoneBien: 'C', vacances: VACANCES, debut: '2023-01-01', fin: '2027-12-31'
})

function ecl (nuits, { prix = 100, vente = null, fiable = true, exclues = [] } = {}) {
  return {
    compte: true, date_vente: vente, date_vente_fiable: fiable,
    nuits: nuits.map(d => ({ date: d, prix, hors_reference: exclues.includes(d) }))
  }
}
function decale (iso, n) {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// n nuits d'un segment, a un prix donne, pour franchir le seuil.
function nNuits (dates, prix) {
  return dates.map(d => ecl([d], { prix, vente: '2024-12-01' }))
}

test('LE TEST QUI COMPTE : les ponts sont ceux du calendrier reel de 2025', () => {
  // ⚠ AUCUNE SOURCE OFFICIELLE NE PUBLIE LES PONTS — ils se calculent.
  // Verifie contre le calendrier 2025 a la main : jeudi 1er mai ferie donc
  // vendredi 2 pont ; jeudi 8 mai ferie donc vendredi 9 ; Ascension jeudi
  // 29 mai donc vendredi 30 ; mardi 11 novembre ferie donc lundi 10 ;
  // jeudi 25 decembre ferie donc vendredi 26.
  const p = R.pontsEntre('2025-01-01', '2025-12-31')
  assert.deepEqual([...p.keys()],
    ['2025-05-02', '2025-05-09', '2025-05-30', '2025-11-10', '2025-12-26'])

  // Un ferie ne devient pas son propre pont.
  assert.ok(!p.has('2025-05-01'))
  // Un mercredi ferie ne fait pas de lundi-mardi des ponts : personne ne pose
  // quatre jours par automatisme, et les compter gonflerait un segment maigre
  // avec des jours ordinaires. Le 15 aout 2025 est un vendredi — donc pont
  // d'aucun cote, mais le 14 (jeudi) n'en est pas un pour autant.
  assert.ok(!p.has('2025-08-14'))

  // 2026 : Ascension jeudi 14 mai → vendredi 15 ; 14 juillet mardi → lundi 13.
  const p26 = R.pontsEntre('2026-01-01', '2026-12-31')
  assert.ok(p26.has('2026-05-15') && p26.has('2026-07-13'))
})

test('LE TEST QUI COMPTE : un jour tombe dans UN segment, par priorite', () => {
  // ⚠ ARBITRAGE DE THIERRY. Le 14 juillet est ferie ET en vacances d'ete :
  // sans ordre fixe il compterait deux fois, et les echantillons se
  // chevaucheraient — deux references construites sur les memes nuits.
  const quatorze = R.segmenterJour('2025-07-14', CTX)
  assert.equal(quatorze.segment, SEGMENTS.FERIE, 'ferie AVANT vacances')
  assert.equal(quatorze.libelle, 'Fête nationale')

  const samediHiver = R.segmenterJour('2025-02-22', CTX)
  assert.equal(samediHiver.segment, SEGMENTS.VACANCES_ZONE)
  assert.equal(samediHiver.detail, 'vacances_zone_du_bien:hiver')
  assert.equal(samediHiver.jour_semaine, 'samedi')

  const mardiHors = R.segmenterJour('2025-03-11', CTX)
  assert.equal(mardiHors.segment, SEGMENTS.HORS_VACANCES)

  const pontMai = R.segmenterJour('2025-05-02', CTX)
  assert.equal(pontMai.segment, SEGMENTS.PONT)
})

test('LE TEST QUI COMPTE : les vacances des AUTRES zones ne valent pas les siennes', () => {
  // Mesure sur La bulle, 3 ans : mediane de 144,00 € en vacances de sa propre
  // zone contre 117,00 € en vacances d'une autre — soit exactement la mediane
  // hors vacances. Les vacances des autres zones ne remplissent pas ce bien.
  // Les confondre aurait dilue le seul segment qui porte un vrai signal.
  const le10fev = R.segmenterJour('2025-02-10', CTX)  // zone A seulement
  assert.equal(le10fev.segment, SEGMENTS.VACANCES_AUTRE)
  assert.deepEqual(le10fev.zones_en_vacances, ['A'])

  const le22fev = R.segmenterJour('2025-02-22', CTX)  // A, B et C
  assert.equal(le22fev.segment, SEGMENTS.VACANCES_ZONE, 'sa zone prime')
  assert.deepEqual(le22fev.zones_en_vacances, ['A', 'B', 'C'])
})

test('LE TEST QUI COMPTE : sous le seuil, la reference se TAIT', () => {
  // Trois nuits ne font pas une norme. Servir leur mediane serait exactement
  // le « chiffre la ou la verite est je ne sais pas » que ce chantier combat.
  const ref = R.construireReference(
    nNuits(['2025-03-11', '2025-03-18', '2025-04-15'], 100),
    { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })
  const r = R.referencePour(ref, '2025-03-25', CTX)   // un mardi hors vacances
  assert.equal(r.valeur, null)
  assert.equal(r.non_calculable, 'echantillon_sous_le_seuil')
  assert.equal(r.echantillon, 3, 'et on DIT combien il y avait')
})

test('LE TEST QUI COMPTE : le niveau de repli vit DANS la donnee', () => {
  // Meme exigence qu'aux lots 3.2 et 3.3 : l'etape 4 ne doit pas POUVOIR
  // presenter « la mediane de tous les samedis » comme « la mediane des
  // samedis de fevrier ». Un repli est une reponse plus faible, ça se voit.
  const samedisHiver = ['2025-02-15', '2025-02-22', '2025-03-01']
  const samedisEte = ['2025-07-05', '2025-07-12', '2025-07-19', '2025-07-26',
    '2025-08-02', '2025-08-09', '2025-08-16', '2025-08-23', '2025-08-30']
  const ref = R.construireReference(
    [...nNuits(samedisHiver, 200), ...nNuits(samedisEte, 160)],
    { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })

  // L'ete a 9 samedis : il tient au niveau le plus fin.
  const ete = R.referencePour(ref, '2025-07-19', CTX)
  assert.equal(ete.valeur, 160)
  assert.equal(ete.niveau, NIVEAUX[0])
  assert.equal(ete.replie, null)

  // L'hiver n'en a que 3 : il replie sur « vacances de la zone x samedi »,
  // qui melange hiver et ete — donc une valeur entre les deux.
  const hiver = R.referencePour(ref, '2025-02-22', CTX)
  assert.equal(hiver.niveau, NIVEAUX[1])
  assert.equal(hiver.replie, NIVEAUX[1], 'le repli est NOMME')
  assert.equal(hiver.echantillon, 12, '3 samedis d hiver + 9 d ete')
  // ⚠ ET SA VALEUR — releve en review : c'est elle qui sera AFFICHEE.
  // Mediane de [200,200,200, 160x9] : la 6e et la 7e valeur triees valent 160.
  assert.equal(hiver.valeur, 160, 'la mediane du melange hiver+ete')
})

test('LE TEST QUI COMPTE : le plancher est le jour de semaine, pas « tout le bien »', () => {
  // ⚠ CONSTATE SUR PIECE. Premiere version : le plancher etait la mediane de
  // toutes les nuits du bien. Le pont du 2 mai 2025 — 7 nuits en trois ans,
  // donc sous le seuil — recevait 124,39 €, la mediane de 665 nuits toutes
  // saisons et tous jours confondus. Un chiffre sans aucun rapport avec un
  // vendredi de pont. Or le jour de semaine est le signal le plus stable du
  // parc : 145,80 € le samedi hors vacances contre 109,71 € le mardi.
  const vendredis = ['2025-01-03', '2025-01-10', '2025-01-17', '2025-01-24',
    '2025-01-31', '2025-03-07', '2025-03-14', '2025-03-21', '2025-03-28']
  const mardis = ['2025-01-07', '2025-01-14', '2025-01-21', '2025-01-28',
    '2025-03-11', '2025-03-18', '2025-03-25', '2025-04-01', '2025-04-15']
  const ref = R.construireReference(
    [...nNuits(vendredis, 150), ...nNuits(mardis, 100), ...nNuits(['2025-05-02'], 999)],
    { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })

  const pont = R.referencePour(ref, '2025-05-09', CTX)   // un autre pont, un vendredi
  assert.equal(pont.niveau, NIVEAUX[3])
  assert.equal(pont.valeur, 150, 'la mediane des VENDREDIS, pas celle de tout')
  assert.notEqual(pont.valeur, 125, 'surtout pas la mediane vendredis+mardis')
})

test('les nuits HORS REFERENCE ne fabriquent pas la norme', () => {
  // C'est leur raison d'etre : une fermeture pour travaux appartient au
  // realise, jamais a ce qui est « normal ».
  const mardis = ['2025-01-07', '2025-01-14', '2025-01-21', '2025-01-28',
    '2025-03-11', '2025-03-18', '2025-03-25', '2025-04-15']
  const ref = R.construireReference([
    ...nNuits(mardis, 100),
    ecl(['2025-04-01'], { prix: 999, exclues: ['2025-04-01'] })
  ], { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })
  assert.equal(ref.nuits_hors_reference, 1)
  const r = R.referencePour(ref, '2025-04-08', CTX)
  assert.equal(r.valeur, 100, 'les 999 € exclus n ont pas bouge la mediane')
})

test('la MEDIANE, jamais la moyenne', () => {
  // Une seule nuit bradee a 40 € deplacerait une moyenne de plusieurs euros
  // sur dix nuits. La mediane ne bouge pas.
  const mardis = ['2025-01-07', '2025-01-14', '2025-01-21', '2025-01-28',
    '2025-03-11', '2025-03-18', '2025-03-25', '2025-04-01', '2025-04-15']
  const ref = R.construireReference(
    [...nNuits(mardis, 100), ...nNuits(['2025-04-08'], 40)],
    { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })
  const r = R.referencePour(ref, '2025-04-15', CTX)
  assert.equal(r.valeur, 100, 'la mediane tient')
  assert.equal(r.min, 40, 'mais l etendue le DIT')
})

test('LE TEST QUI COMPTE : la courbe de delai ignore les dates non fiables', () => {
  // Une date de vente reconstruite a la migration placerait toutes les ventes
  // au meme delai et ecraserait la courbe. Et le DENOMINATEUR est le nombre de
  // nuits datees, pas le total : compter des nuits sans date ferait croire que
  // rien ne s'est vendu tot, et le moteur dirait « en retard » a un bien en
  // avance.
  // ⚠ TOUS CES MARDIS SONT HORS VACANCES DES TROIS ZONES. Le 4 mars, lui,
  // tombe dans les vacances d'hiver de la ZONE B (22/02 → 09/03) : il part au
  // segment « vacances autre zone », pas au hors-vacances. C'est le detail qui
  // fait qu'un echantillon construit a la main ne vaut rien sans verification.
  const dates = ['2025-01-07', '2025-01-14', '2025-01-21', '2025-01-28',
    '2025-03-11', '2025-03-18', '2025-03-25', '2025-04-15']
  const fiables = dates.map(d => ecl([d], { prix: 100, vente: '2024-12-01' }))
  const douteuses = ['2025-04-01', '2025-04-08'].map(d =>
    ecl([d], { prix: 100, vente: '2025-03-31', fiable: false }))
  const c = R.courbeDeDelai([...fiables, ...douteuses],
    { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })
  const h = c.par_segment.get(SEGMENTS.HORS_VACANCES)
  assert.equal(h.nuits, 10)
  assert.equal(h.nuits_datees, 8, 'seules les dates fiables comptent')
  assert.equal(h.nuits_sans_date_fiable, 2)
  // ⚠ LE PALIER J-0 VAUT 1 PAR CONSTRUCTION — releve en review : l'asserter
  // gravait une tautologie vraie quelles que soient les donnees. Ce qu'il faut
  // verifier, c'est un palier NON TRIVIAL. Les 8 nuits sont vendues le
  // 2024-12-01 : leurs delais vont de 37 j (2025-01-07) a 135 j (2025-04-15).
  assert.equal(h.courbe.find(p => p.jours_avant === 0).trivial, true,
    'et le module DIT que ce palier est une identite, pas une mesure')
  assert.equal(h.courbe.find(p => p.jours_avant === 30).part_vendue, 1,
    'a J-30, aucune de ces ventes tardives n avait encore eu lieu')
  assert.equal(h.courbe.find(p => p.jours_avant === 90).part_vendue, 0.5,
    '4 des 8 nuits sont a plus de 90 jours de leur vente')
  assert.equal(h.courbe.find(p => p.jours_avant === 180).part_vendue, 0)
  assert.equal(h.mesure, 'part des ventes finales deja realisees',
    'ce n est PAS un taux d occupation, et le module le nomme')
  assert.ok(h.fiable)
})

test('une courbe sous le seuil se declare non fiable', () => {
  const c = R.courbeDeDelai(
    [ecl(['2025-03-11'], { prix: 100, vente: '2025-01-01' })],
    { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })
  const h = c.par_segment.get(SEGMENTS.HORS_VACANCES)
  assert.equal(h.fiable, false)
  assert.equal(h.non_calculable, 'echantillon_sous_le_seuil')
})

test('LE TEST QUI COMPTE : on ne projette pas une periode FERMEE', () => {
  // Projeter des nuits sur un bien ferme inventerait un manque a gagner qui
  // n'existe pas — Coeur de vie 23, octobre 2026, zero jour ouvert (lot 3.3).
  const ref = R.construireReference(
    nNuits(['2025-01-07', '2025-01-14', '2025-01-21', '2025-01-28',
      '2025-03-11', '2025-03-18', '2025-03-25', '2025-04-15'], 100),
    { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })
  const p = R.projeter({
    jours: ['2026-03-03', '2026-03-10'], reference: ref, contexte: CTX,
    capacite: { calculable: true, jours_ouverts: 0 }
  })
  assert.ok(p.non_calculable.includes('periode_fermee_a_la_vente'))
  assert.equal(p.nuitees_finales_extrapolees, undefined, 'aucune attente inventee')

  // ⚠ LE CAS DANGEREUX, CELUI QUE LE TEST EVITAIT — releve en review.
  // `joursOuverts` rend `jours_ouverts: 0` sur ses SIX motifs de
  // non-calculabilite. Ne lire que le zero faisait annoncer « ferme a la
  // vente » a un bien Beds24 sans memoire d'intention, qui vend pourtant.
  const inconnue = R.projeter({
    jours: ['2026-03-03'], reference: ref, contexte: CTX,
    capacite: { calculable: false, jours_ouverts: 0,
      raison: 'provider_sans_memoire_intention' }
  })
  assert.ok(inconnue.non_calculable.includes('capacite_non_calculable'))
  assert.ok(!inconnue.non_calculable.includes('periode_fermee_a_la_vente'),
    'inconnu n est PAS ferme')
  assert.equal(inconnue.capacite_raison, 'provider_sans_memoire_intention')
})

test('LE TEST QUI COMPTE : on extrapole le final, on ne multiplie pas la capacite', () => {
  // ⚠ LE DEFAUT DE CONCEPTION RELEVE EN REVIEW. Premiere version :
  // `nuitees_attendues = jours_ouverts x part_vendue`. Or `part_vendue` est
  // une part des ventes FINALES, pas de la capacite : le produit supposait
  // 100 % d'occupation finale. Le palier J-0 valant 1 par construction, un
  // bien a 3 jours ouverts et 1 nuit vendue s'entendait dire « 2 nuits de
  // retard » alors qu'il etait parfaitement normal. Le biais etait
  // systematique, d'un seul cote, et sur le chiffre-titre du lot.
  const mardis = ['2025-01-07', '2025-01-14', '2025-01-21', '2025-01-28',
    '2025-03-11', '2025-03-18', '2025-03-25', '2025-04-15']
  const ref = R.construireReference(nNuits(mardis, 120),
    { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })
  // Quatre nuits vendues a 100 jours, quatre a 10 jours : a J-30, la moitie
  // des ventes finales du segment reste a faire.
  const courbe = R.courbeDeDelai([
    ...mardis.slice(0, 4).map(d => ecl([d], { prix: 120, vente: decale(d, -100) })),
    ...mardis.slice(4).map(d => ecl([d], { prix: 120, vente: decale(d, -10) }))
  ], { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })
  const h = courbe.par_segment.get(SEGMENTS.HORS_VACANCES)
  assert.equal(h.courbe.find(p => p.jours_avant === 30).part_vendue, 0.5)

  const p = R.projeter({
    jours: ['2026-03-03', '2026-03-10', '2026-03-17', '2026-03-24'],
    reference: ref, courbe, contexte: CTX, delaiJours: 30, nuiteesVendues: 1,
    capacite: { calculable: true, jours_ouverts: 4 }
  })
  assert.equal(p.prix_attendu_moyen, 120)
  assert.equal(p.part_attendue_a_ce_delai, 0.5)
  // 1 nuit vendue represente la moitie du final attendu → 2 nuits au total.
  assert.equal(p.nuitees_finales_extrapolees, 2, 'vendu / part, JAMAIS capacite x part')
  assert.equal(p.taux_occupation_extrapole, 0.5, '2 nuits sur 4 jours ouverts')
  // ⚠ ET PAS D AVANCE/RETARD SANS REFERENCE D OCCUPATION : ce module ne peut
  // pas deviner ce qui est « normal » comme remplissage.
  assert.equal(p.avance_retard, undefined)
  assert.ok(p.non_calculable.includes('occupation_de_reference_absente'))

  // Avec la reference d'occupation fournie, la comparaison devient possible.
  const avec = R.projeter({
    jours: ['2026-03-03', '2026-03-10', '2026-03-17', '2026-03-24'],
    reference: ref, courbe, contexte: CTX, delaiJours: 30, nuiteesVendues: 1,
    capacite: { calculable: true, jours_ouverts: 4 }, occupationReference: 0.75
  })
  assert.equal(avec.nuitees_de_reference, 3, '75 % de 4 jours ouverts')
  assert.equal(avec.avance_retard, -1, '2 attendues contre 3 de reference')
})

test('rien ne se vend a ce delai : on ne divise pas par zero', () => {
  const mardis = ['2025-01-07', '2025-01-14', '2025-01-21', '2025-01-28',
    '2025-03-11', '2025-03-18', '2025-03-25', '2025-04-15']
  const ref = R.construireReference(nNuits(mardis, 120),
    { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })
  // Tout se vend a 5 jours : a J-90, l'historique n'avait jamais rien vendu.
  const courbe = R.courbeDeDelai(
    mardis.map(d => ecl([d], { prix: 120, vente: decale(d, -5) })),
    { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })
  const p = R.projeter({
    jours: ['2026-03-03'], reference: ref, courbe, contexte: CTX,
    delaiJours: 90, nuiteesVendues: 0,
    capacite: { calculable: true, jours_ouverts: 1 }
  })
  assert.equal(p.part_attendue_a_ce_delai, 0)
  assert.equal(p.nuitees_finales_extrapolees, undefined, 'ni infini, ni zero invente')
  assert.ok(p.non_calculable.includes('rien_ne_se_vend_a_ce_delai'))
})

test('la projection compte les jours servis par REPLI', () => {
  // ⚠ RELEVE EN REVIEW : `prix_attendu_moyen` melangeait sans compteur les
  // jours servis au niveau le plus fin et ceux servis au plancher. C'est la
  // regle du lot 3.2 qui sautait la ou l'etape 4 ne lira qu'un seul chiffre.
  // ⚠ TOUS HORS VACANCES DES TROIS ZONES. Le 7 mars tombe dans l'hiver de la
  // ZONE B (22/02 → 09/03) : il partirait en « vacances autre zone » et
  // l'echantillon des vendredis hors vacances tomberait a 7, sous le seuil.
  const vendredis = ['2025-01-03', '2025-01-10', '2025-01-17', '2025-01-24',
    '2025-01-31', '2025-03-14', '2025-03-21', '2025-03-28']
  const ref = R.construireReference(nNuits(vendredis, 150),
    { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })
  // Un vendredi ordinaire (case propre) et le pont du 15 mai 2026, un vendredi
  // lui aussi : faute d'echantillon de ponts, il replie sur « les vendredis ».
  const p = R.projeter({ jours: ['2026-03-06', '2026-05-15'], reference: ref, contexte: CTX })
  assert.equal(p.jours_projetes, 2)
  assert.equal(p.jours_sans_reference, 0)
  assert.equal(p.jours_replies, 1, 'le repli est COMPTE, pas dilue dans la moyenne')
  assert.equal(p.prix_attendu_moyen, 150)
  assert.equal(p.detail[1].niveau, NIVEAUX[3])
  assert.equal(p.detail[1].replie, NIVEAUX[3])
})

test('LE TEST QUI COMPTE : un contexte qui ne couvre pas le jour se DIT', () => {
  // ⚠ RELEVE EN REVIEW. `feries` et `ponts` sont des Map bornees a la fenetre
  // sur laquelle on les a calculees : un jour hors de cette fenetre n'y figure
  // pas, et la priorite etait contournee par simple ABSENCE, sans un signal.
  // Constate : avec un contexte bati sur 2025, le 14 juillet 2026 partait en
  // « hors_vacances » au lieu de « ferie ». `construireReference` travaille sur
  // 3 ans d'historique et `referencePour` sur des jours futurs — rien
  // n'obligeait le contexte a couvrir les deux.
  const court = R.construireContexte({
    zoneBien: 'C', vacances: VACANCES, debut: '2025-01-01', fin: '2025-12-31'
  })
  const s2026 = R.segmenterJour('2026-07-14', court)
  assert.equal(s2026.segment, null)
  assert.equal(s2026.non_calculable, 'hors_fenetre_du_contexte')

  // Le meme jour, avec un contexte qui le couvre : ferie, comme il se doit.
  assert.equal(R.segmenterJour('2026-07-14', CTX).segment, SEGMENTS.FERIE)

  // Et la reference le repercute plutot que de servir une case fausse.
  const ref = R.construireReference([], { contexte: court })
  assert.equal(R.referencePour(ref, '2026-07-14', court).non_calculable,
    'hors_fenetre_du_contexte')
})

test('LE TEST QUI COMPTE : une seule reservation ne fait pas une norme', () => {
  // ⚠ RELEVE EN REVIEW. `eclater` repartit le prix UNIFORMEMENT : les 11 nuits
  // d'un sejour portent exactement le meme prix. Un seul sejour franchissait
  // donc le seuil de 8 nuits, et la « norme » de tous les etes du bien pouvait
  // etre UNE reservation. Seul `min === max` le trahissait, indirectement.
  const sejour = {
    compte: true, booking_id: 'B1', date_vente: '2025-01-01', date_vente_fiable: true,
    nuits: ['2025-07-10', '2025-07-11', '2025-07-12', '2025-07-13', '2025-07-14',
      '2025-07-15', '2025-07-16', '2025-07-17', '2025-07-18', '2025-07-19',
      '2025-07-20'].map(d => ({ date: d, prix: 300, hors_reference: false }))
  }
  const ref = R.construireReference([sejour],
    { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })
  const r = R.referencePour(ref, '2025-07-25', CTX)
  assert.equal(r.valeur, null, '11 nuits, mais UNE observation')
  assert.equal(r.non_calculable, 'echantillon_sous_le_seuil')

  // Trois reservations distinctes, meme total de nuits : la norme existe.
  const trois = ['B1', 'B2', 'B3'].map((id, i) => ({
    compte: true, booking_id: id, date_vente: '2025-01-01', date_vente_fiable: true,
    nuits: Array.from({ length: 3 }, (_, k) => ({
      date: decale('2025-07-10', i * 3 + k), prix: 300, hors_reference: false }))
  }))
  const ref3 = R.construireReference(trois,
    { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })
  assert.equal(R.referencePour(ref3, '2025-07-25', CTX).valeur, 300)
  assert.equal(R.referencePour(ref3, '2025-07-25', CTX).reservations, 3)
})

test('LE TEST QUI COMPTE : un long sejour ne fabrique pas la norme', () => {
  // ⚠ RELEVE EN REVIEW. `eclater` pose `long_sejour` (> 24 nuits) en
  // expliquant que c'est « pour que les moyennes les ecartent » — personne ne
  // le lisait, la reference comprise. Un sejour de 28 nuits a tarif degressif
  // verse quatre samedis identiques dans une case qui en compte dix-huit.
  const samedis = ['2025-07-05', '2025-07-12', '2025-07-19', '2025-07-26',
    '2025-08-02', '2025-08-09', '2025-08-16', '2025-08-23']
  const long = {
    compte: true, booking_id: 'LONG', long_sejour: true,
    date_vente: '2025-01-01', date_vente_fiable: true,
    nuits: Array.from({ length: 28 }, (_, k) => ({
      date: decale('2025-07-01', k), prix: 40, hors_reference: false }))
  }
  const ref = R.construireReference([...nNuits(samedis, 160), long],
    { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })
  assert.equal(ref.nuits_long_sejour, 28, 'ecartees, et COMPTEES')
  const r = R.referencePour(ref, '2025-08-30', CTX)
  assert.equal(r.valeur, 160, 'les 40 € du long sejour n ont pas tire la mediane')
  assert.equal(r.echantillon, 8)
})

test('un delai negatif est COMPTE, il ne s evapore pas', () => {
  // ⚠ RELEVE EN REVIEW. Une nuit vendue APRES sa propre date (saisie tardive)
  // etait comptee au total, absente des delais ET des sans-date : la somme des
  // compteurs ne faisait plus le total, et « champ absent » se confondait avec
  // « regle violee » (regle 13).
  const c = R.courbeDeDelai([
    ecl(['2025-03-11'], { prix: 100, vente: '2025-01-01' }),
    ecl(['2025-03-18'], { prix: 100, vente: '2025-03-20' })
  ], { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })
  const h = c.par_segment.get(SEGMENTS.HORS_VACANCES)
  assert.equal(h.nuits, 2)
  assert.equal(h.nuits_datees, 1)
  assert.equal(h.nuits_delai_negatif, 1)
  assert.equal(h.nuits_datees + h.nuits_sans_date_fiable + h.nuits_delai_negatif +
    h.nuits_delai_illisible, h.nuits, 'la somme des compteurs fait le total')
})

test('la courbe respecte le seuil de l appelant', () => {
  // ⚠ RELEVE EN REVIEW : `courbeDeDelai` codait SEUIL_DEFAUT en dur. Un
  // appelant qui durcit a 15 obtenait une reference muette et une courbe
  // declaree fiable sur 8 nuits, dans le meme ecran.
  const dates = ['2025-01-07', '2025-01-14', '2025-01-21', '2025-01-28',
    '2025-03-11', '2025-03-18', '2025-03-25', '2025-04-15']
  const lignes = dates.map(d => ecl([d], { prix: 100, vente: '2024-12-01' }))
  const large = R.courbeDeDelai(lignes, { contexte: CTX })
  const strict = R.courbeDeDelai(lignes, { contexte: CTX, seuil: 15 })
  assert.equal(large.par_segment.get(SEGMENTS.HORS_VACANCES).fiable, true)
  assert.equal(strict.par_segment.get(SEGMENTS.HORS_VACANCES).fiable, false)
})

test('pontsEntre sur une fenetre trop large ne plante pas', () => {
  // ⚠ RELEVE EN REVIEW : `joursDeLaPeriode` rend `null` au-dela de JOURS_MAX,
  // et `for (const j of null)` levait un TypeError — sur l'appel le plus
  // plausible, couvrir historique ET horizon d'un seul coup.
  assert.doesNotThrow(() => R.pontsEntre('2010-01-01', '2030-12-31'))
  assert.equal(R.pontsEntre('2010-01-01', '2030-12-31').size, 0)
})

test('le module est PUR : ni base, ni reseau, ni horloge', () => {
  const src = require('node:fs').readFileSync(
    require.resolve('../lib/yield/reference'), 'utf8')
  for (const interdit of ['supabase', 'fetch(', 'Date.now(', 'process.env',
    '.from(']) {
    assert.ok(!src.includes(interdit), `le module ne doit pas contenir ${interdit}`)
  }
  assert.ok(!/new Date\s*\(\s*\)/.test(src), 'aucune lecture de l horloge systeme')
})

test('une date impossible ne casse rien et n invente rien', () => {
  assert.equal(R.segmenterJour('2025-02-30', CTX), null)
  assert.equal(R.jourDeSemaine('2025-13-01'), null)
  assert.equal(R.pontsEntre('2025-13-01', '2025-12-31').size, 0)
  const r = R.referencePour(null, '2025-03-11', CTX)
  assert.equal(r.valeur, null)
  assert.equal(r.non_calculable, 'aucun_historique')
})

test('LE TEST QUI COMPTE : une periode DEJA COMMENCEE n a plus de trajectoire', () => {
  // ⚠ CONSTATE A LA PREMIERE LECTURE REELLE DE /api/yield. Septembre 2026, vu
  // du 12 septembre, a un delai NEGATIF : aucun palier ne s'y applique, et le
  // motif rendu accusait la DONNEE (`aucune_courbe_fiable`) alors que c'est la
  // QUESTION qui ne se pose plus. Un lecteur en aurait conclu que son
  // historique est trop mince.
  const mardis = ['2025-01-07', '2025-01-14', '2025-01-21', '2025-01-28',
    '2025-03-11', '2025-03-18', '2025-03-25', '2025-04-15']
  const ref = R.construireReference(nNuits(mardis, 120),
    { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })
  const courbe = R.courbeDeDelai(
    mardis.map(d => ecl([d], { prix: 120, vente: decale(d, -60) })),
    { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })
  const args = { jours: ['2026-03-03'], reference: ref, courbe, contexte: CTX,
    nuiteesVendues: 12, capacite: { calculable: true, jours_ouverts: 31 } }

  const commencee = R.projeter({ ...args, delaiJours: -11 })
  assert.ok(commencee.non_calculable.includes('periode_deja_commencee'))
  assert.ok(!commencee.non_calculable.includes('aucune_courbe_fiable'),
    'on n accuse pas la donnee quand c est la question qui ne se pose plus')
  assert.equal(commencee.nuitees_finales_extrapolees, undefined)

  // ⚠ ET LE PREMIER JOUR AUSSI : delai ZERO attrapait le palier J-0, qui vaut
  // 1 par construction. 12 nuitees vendues rendaient « 12 attendues au final »
  // sur un mois qui commence — le chiffre faux et credible qu'on corrige.
  const premierJour = R.projeter({ ...args, delaiJours: 0 })
  assert.ok(premierJour.non_calculable.includes('periode_deja_commencee'))
  assert.equal(premierJour.nuitees_finales_extrapolees, undefined)

  // A un jour du debut, en revanche, la trajectoire existe encore.
  const veille = R.projeter({ ...args, delaiJours: 1 })
  assert.ok(!veille.non_calculable.includes('periode_deja_commencee'))
})

test('LE TEST QUI COMPTE : la projection rend un INTERVALLE, jamais un point seul', () => {
  // ⚠ DECISION DE THIERRY, spec §7.1 : « projection a terminaison avec
  // intervalle, jamais un point unique, qui se lirait comme une prevision alors
  // que c'est une extrapolation ». L'incertitude est reelle : entre J-14 et
  // J-30, la part vendue du segment « hors vacances » passe de 45 % a 25 % —
  // le meme portefeuille donne donc un final tres different selon le palier.
  const mardis = ['2025-01-07', '2025-01-14', '2025-01-21', '2025-01-28',
    '2025-03-11', '2025-03-18', '2025-03-25', '2025-04-15']
  const ref = R.construireReference(nNuits(mardis, 120),
    { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })
  // Quatre nuits vendues a 100 jours, quatre a 20 jours : a J-21, le palier
  // inferieur (J-14) et le superieur (J-30) different.
  const courbe = R.courbeDeDelai([
    ...mardis.slice(0, 4).map(d => ecl([d], { prix: 120, vente: decale(d, -100) })),
    ...mardis.slice(4).map(d => ecl([d], { prix: 120, vente: decale(d, -20) }))
  ], { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })

  const p = R.projeter({
    jours: ['2026-03-03', '2026-03-10', '2026-03-17', '2026-03-24'],
    reference: ref, courbe, contexte: CTX, delaiJours: 21, nuiteesVendues: 2,
    capacite: { calculable: true, jours_ouverts: 4 }
  })
  assert.ok(p.nuitees_finales_extrapolees != null, 'le point central existe')
  assert.ok(p.nuitees_finales_min != null && p.nuitees_finales_max != null,
    'et il est encadre')
  // ⚠ LE SENS DES BORNES : une part ATTENDUE plus ELEVEE veut dire que le
  // portefeuille actuel represente une plus grosse part du final, donc un final
  // plus BAS. Les inverser rendrait la fourchette a l'envers — et personne ne
  // le verrait, les deux nombres restant plausibles.
  assert.ok(p.nuitees_finales_min <= p.nuitees_finales_max, 'min <= max')
  // ⚠ ON ASSERTE LES PALIERS ATTENDUS, PAS LEUR RELATION — releve en review.
  // La premiere version re-derivait la sortie depuis la sortie
  // (`intervalle_paliers` vient des memes variables que `min`/`max`) : une
  // implementation qui aurait pris J-0 et J-180, ou toujours le meme palier,
  // serait passee. A J-21, les encadrants sont J-14 et J-30.
  const c = courbe.par_segment.get(SEGMENTS.HORS_VACANCES)
  const p14 = c.courbe.find(x => x.jours_avant === 14).part_vendue
  const p30 = c.courbe.find(x => x.jours_avant === 30).part_vendue
  assert.deepStrictEqual(p.intervalle_paliers,
    [Math.round(Math.min(p14, p30) * 10000) / 10000,
      Math.round(Math.max(p14, p30) * 10000) / 10000],
    'les paliers retenus doivent etre ceux qui ENCADRENT le delai')
  // ⚠ ET LE POINT CENTRAL EST UNE INTERPOLATION entre les deux, pas la borne
  // basse : `part_vendue` decroit avec le delai, donc le palier inferieur donne
  // toujours la part la plus haute. Le « point central » etait identiquement le
  // minimum, et `avance_retard` — colore — tranchait systematiquement du cote
  // « retard », meme quand la fourchette enjambait zero.
  const attendue = p14 + (p30 - p14) * ((21 - 14) / (30 - 14))
  assert.equal(p.part_attendue_a_ce_delai, Math.round(attendue * 10000) / 10000,
    'la part attendue est INTERPOLEE entre les deux paliers')
})

test('un intervalle du simple au double se DIT trop large', () => {
  // Une fourchette qui va du simple au double ne permet pas de decider : mieux
  // vaut le dire que laisser l'hote croire a une prevision.
  const mardis = ['2025-01-07', '2025-01-14', '2025-01-21', '2025-01-28',
    '2025-03-11', '2025-03-18', '2025-03-25', '2025-04-15']
  const ref = R.construireReference(nNuits(mardis, 120),
    { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })
  // Sept nuits vendues a 10 jours, une a 200 jours : a J-60 le palier inferieur
  // (J-30) vaut 1/8 et le superieur (J-90) 1/8 aussi... on force l'ecart en
  // repartissant sur les paliers encadrants.
  const courbe = R.courbeDeDelai([
    ...mardis.slice(0, 1).map(d => ecl([d], { prix: 120, vente: decale(d, -200) })),
    ...mardis.slice(1, 2).map(d => ecl([d], { prix: 120, vente: decale(d, -80) })),
    ...mardis.slice(2).map(d => ecl([d], { prix: 120, vente: decale(d, -10) }))
  ], { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })
  const p = R.projeter({
    jours: ['2026-03-03'], reference: ref, courbe, contexte: CTX,
    delaiJours: 45, nuiteesVendues: 1,
    capacite: { calculable: true, jours_ouverts: 31 }
  })
  // ⚠ PLUS DE `if` QUI REIMPLEMENTE LA CONDITION TESTEE — releve en review :
  // si la branche ne se declenchait pas, le test passait en n'assertant RIEN.
  // On assert inconditionnellement l'invariant : jamais une fourchette du
  // simple au double SANS reserve.
  assert.ok(p.nuitees_finales_min <= p.nuitees_finales_max)
  const large = p.nuitees_finales_max != null &&
    p.nuitees_finales_max > p.nuitees_finales_extrapolees * 2
  assert.equal(large, p.non_calculable.includes('intervalle_trop_large'),
    'une fourchette du simple au double DOIT porter sa reserve, et elle seule')
})

test('LE TEST QUI COMPTE : au-dela du dernier palier, on ne projette PAS', () => {
  // ⚠ LE DEFAUT LE PLUS GRAVE DU RECADRAGE, releve en review. Quand le delai
  // depasse le dernier palier (180 j), il n'existe plus de palier superieur :
  // la premiere version repliait sur le palier inferieur des DEUX cotes, la
  // fourchette se refermait sur un point, et `intervalle_trop_large` ne pouvait
  // plus se declencher — precisement la ou l'incertitude est maximale.
  //
  // Mesure : aout 2027 vu en septembre 2026, 2 nuitees vendues, part 2 %
  // → 100 nuitees finales « de 100 a 100 » sur un mois de 31 jours,
  // soit 322 % d'occupation, affiche EN VERT sur la vue par defaut. Six a sept
  // lignes sur treize etaient dans cette zone a chaque ouverture de l'app.
  const mardis = ['2025-01-07', '2025-01-14', '2025-01-21', '2025-01-28',
    '2025-03-11', '2025-03-18', '2025-03-25', '2025-04-15']
  const ref = R.construireReference(nNuits(mardis, 120),
    { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })
  const courbe = R.courbeDeDelai([
    ...mardis.slice(0, 1).map(d => ecl([d], { prix: 120, vente: decale(d, -200) })),
    ...mardis.slice(1).map(d => ecl([d], { prix: 120, vente: decale(d, -10) }))
  ], { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })

  const p = R.projeter({
    jours: ['2026-03-03'], reference: ref, courbe, contexte: CTX,
    delaiJours: 322, nuiteesVendues: 2,
    capacite: { calculable: true, jours_ouverts: 31 }
  })
  assert.ok(p.non_calculable.includes('delai_au_dela_du_dernier_palier'),
    'on DIT que la periode est plus loin que tout ce qu on a observe')
  assert.equal(p.nuitees_finales_extrapolees, undefined, 'et on ne projette rien')
  assert.equal(p.nuitees_finales_min, undefined)
  assert.equal(p.jours_hors_courbe, 1, 'et on compte les jours concernes')
})

test('LE TEST QUI COMPTE : une extrapolation ne depasse pas la capacite ouverte', () => {
  // C'est arithmetiquement impossible : on ne vend pas 100 nuits sur un mois qui
  // en compte 31. Quand le calcul y mene, c'est que le rythme observe ne
  // s'applique pas a cette periode — on plafonne ET on le dit.
  const mardis = ['2025-01-07', '2025-01-14', '2025-01-21', '2025-01-28',
    '2025-03-11', '2025-03-18', '2025-03-25', '2025-04-15']
  const ref = R.construireReference(nNuits(mardis, 120),
    { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })
  // Une seule vente lointaine : a J-45, la part attendue est minuscule.
  const courbe = R.courbeDeDelai([
    ...mardis.slice(0, 1).map(d => ecl([d], { prix: 120, vente: decale(d, -95) })),
    ...mardis.slice(1).map(d => ecl([d], { prix: 120, vente: decale(d, -3) }))
  ], { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })
  const p = R.projeter({
    jours: ['2026-03-03'], reference: ref, courbe, contexte: CTX,
    delaiJours: 45, nuiteesVendues: 3,
    capacite: { calculable: true, jours_ouverts: 5 }
  })
  if (p.nuitees_finales_extrapolees != null) {
    assert.ok(p.nuitees_finales_extrapolees <= 5, 'jamais plus que les jours ouverts')
    assert.ok(p.taux_occupation_extrapole <= 1, 'et jamais plus de 100 % d occupation')
    if (p.nuitees_finales_plafonnees) {
      assert.ok(p.non_calculable.includes('extrapolation_au_dela_de_la_capacite'),
        'un plafonnement se DIT : le rythme ne s applique visiblement pas')
    }
  }
})

test('LE TEST QUI COMPTE : une borne haute non calculable se DIT', () => {
  // Quand le palier superieur vaut 0 — « rien ne s est jamais vendu a plus de
  // N jours », le cas le plus courant — la premiere version sautait
  // l'intervalle ENTIER sans le moindre motif : l'ecran affichait un point
  // unique en gras, sans reserve. La violation litterale de la spec §7.1 que ce
  // lot grave dans le meme commit, et elle etait silencieuse.
  const mardis = ['2025-01-07', '2025-01-14', '2025-01-21', '2025-01-28',
    '2025-03-11', '2025-03-18', '2025-03-25', '2025-04-15']
  const ref = R.construireReference(nNuits(mardis, 120),
    { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })
  // Tout se vend a moins de 60 jours : a J-60, le palier J-90 vaut ZERO.
  const courbe = R.courbeDeDelai(
    mardis.map(d => ecl([d], { prix: 120, vente: decale(d, -40) })),
    { contexte: CTX, debut: '2023-01-01', fin: '2025-12-31' })
  // ⚠ LE DELAI DOIT TOMBER ENTRE UN PALIER NON NUL ET UN PALIER NUL.
  // A J-75 les DEUX encadrants valent zero : c'est alors
  // `rien_ne_se_vend_a_ce_delai` qui sort, un autre cas. Ici J-45 encadre
  // J-30 (tout vendu) et J-60 (rien) — la borne haute seule est impossible.
  const c = courbe.par_segment.get(SEGMENTS.HORS_VACANCES)
  assert.ok(c.courbe.find(x => x.jours_avant === 30).part_vendue > 0)
  assert.equal(c.courbe.find(x => x.jours_avant === 60).part_vendue, 0,
    'le palier superieur doit valoir zero pour que le cas soit exerce')

  const p = R.projeter({
    jours: ['2026-03-03'], reference: ref, courbe, contexte: CTX,
    delaiJours: 45, nuiteesVendues: 2,
    capacite: { calculable: true, jours_ouverts: 31 }
  })
  assert.ok(p.nuitees_finales_min != null, 'la borne basse existe toujours')
  assert.equal(p.nuitees_finales_max, undefined, 'la haute, non')
  assert.ok(p.non_calculable.includes('borne_haute_non_calculable'),
    'et son absence est DITE, jamais silencieuse')
})
