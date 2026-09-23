// tests/dates-commerciales-repli.test.js — lot V2.0.6 (23 septembre 2026).
//
// LE DEFAUT QU'ILS EMPECHENT : un reveillon moins cher que la veille.
// Constate sur La bulle : le 31 decembre 2026, un jeudi de vacances de Noel,
// sortait a 125 € (Moyen) quand le 30 decembre voisin etait a 155 € (Tres
// haut) ; la Saint-Valentin 2027 a 125 € au milieu de vacances d'hiver a
// 155 €. Une date commerciale n'a presque jamais huit nuits d'historique (une
// par an), et le repli retombait sur un jour ORDINAIRE hors vacances au lieu
// de « la nuit qu'elle serait sans elle ».
//
// CE QUE CES TESTS DEFENDENT :
//   1. sans historique propre, une date commerciale prend le niveau de sa nuit
//      sous-jacente (vacances de Noel, jour de semaine compris), et le dit ;
//   2. la date commerciale elle-meme passe avant le pont, jamais avant le ferie ;
//   3. l'invariant, sur toutes les dates commerciales de sept annees : jamais
//      sous la nuit ordinaire sans mesure propre ;
//   4. le garde-fou : une position empruntee sous la nuit ordinaire se MARQUE.

const test = require('node:test')
const assert = require('node:assert')
const S = require('../lib/yield/suggestion')
const R = require('../lib/yield/reference')
const { datesCommerciales } = require('../lib/yield/dates-commerciales')

const VACANCES = [
  { zone: 'C', nom: 'Vacances de Noël', date_debut: '2024-12-21', date_fin: '2025-01-05' },
  { zone: 'C', nom: 'Vacances de Noël', date_debut: '2025-12-20', date_fin: '2026-01-04' },
  { zone: 'C', nom: 'Vacances de Noël', date_debut: '2026-12-19', date_fin: '2027-01-03' },
  { zone: 'C', nom: "Vacances d'Hiver", date_debut: '2027-02-06', date_fin: '2027-02-21' }
]
const DEBUT = '2023-01-01'
const FIN = '2032-12-31'
const COMMERCIALES = datesCommerciales(DEBUT, FIN)
const ctxAvec = (evenements = COMMERCIALES) =>
  R.construireContexte({ zoneBien: 'C', vacances: VACANCES, evenements, debut: DEBUT, fin: FIN })
const CTX = ctxAvec()
const CTX_SANS = ctxAvec([])
const bien = { prix_minimum: 1 }

function ecl (dates, prix, id) {
  return { compte: true, booking_id: id, long_sejour: false,
    date_vente: '2024-12-01', date_vente_fiable: true,
    nuits: dates.map(d => ({ date: d, prix, hors_reference: false })) }
}
// Des jours du segment voulu, choisis PAR LA SEGMENTATION, pas de tete.
function jours (depart, segment, n, prix, prefixe, jour = null) {
  const out = []
  const d = new Date(`${depart}T00:00:00Z`)
  for (let garde = 0; out.length < n && garde < 800; garde++) {
    const j = d.toISOString().slice(0, 10)
    const s = R.segmenterJour(j, CTX)
    if (s && s.segment === segment && (!jour || s.jour_semaine === jour)) {
      out.push(ecl([j], prix, `${prefixe}${out.length}`))
    }
    d.setUTCDate(d.getUTCDate() + 1)
  }
  assert.equal(out.length, n, `jeu d'essai incomplet : ${segment}`)
  return out
}
// Hors vacances : mardis a 100, samedis a 150 ; vacances de Noel a 175 ;
// un seul reveillon vendu (257 €) — sous le seuil, comme sur La bulle.
const LIGNES = [
  ...jours('2025-09-01', 'hors_vacances', 9, 100, 'M', 'mardi'),
  ...jours('2025-09-01', 'hors_vacances', 9, 150, 'S', 'samedi'),
  ...jours('2025-12-20', 'vacances_zone_du_bien', 12, 175, 'N'),
  ecl(['2025-12-31'], 257, 'R')
]
const G = S.construireGrille(LIGNES, { contexte: CTX, debut: DEBUT, fin: '2025-12-31' })
const idx = n => G.base.niveaux.findIndex(x => x.nom === n)
const prix = (date, contexte = CTX, extra = {}) => S.suggerer({ date, grille: G, contexte,
  ouverte: true, delaiJours: 30, bien, ...extra })

test('LE TEST QUI COMPTE : sans historique, le reveillon garde le niveau de sa nuit de vacances de Noel', () => {
  assert.equal(R.segmenterJour('2026-12-31', CTX).segment, 'commercial:reveillon_nouvel_an')
  assert.ok(!G.positions.get('commercial:reveillon_nouvel_an').fiable, 'une seule vente : sous le seuil')
  const avec = prix('2026-12-31')
  const sans = prix('2026-12-31', CTX_SANS)
  assert.equal(sans.segment, 'vacances_zone_du_bien')
  assert.equal(avec.niveau, sans.niveau, 'le niveau qu il aurait sans la date')
  assert.equal(avec.prix, sans.prix)
  assert.equal(avec.position_sous_jacente, 'vacances_zone_du_bien')
  // ⚠ ET PAS CELUI D'UN JEUDI ORDINAIRE : c'etait le defaut.
  const jeudiOrdinaire = prix('2026-11-19')
  assert.ok(idx(avec.niveau) > idx(jeudiOrdinaire.niveau),
    `reveillon ${avec.niveau} doit depasser un jeudi ordinaire ${jeudiOrdinaire.niveau}`)
  // L'etiquette reste le reveillon, et le repli se dit.
  assert.equal(avec.segment, 'commercial:reveillon_nouvel_an')
  const pos = avec.couches.find(c => c.nom === 'position')
  assert.equal(pos.agit, true, 'le repli s affiche toujours')
  assert.match(pos.resume, /garde le niveau qu’elle aurait sans cette date/)
  assert.match(pos.resume, /1 nuit\(s\) vendue\(s\), il en faut 8/)
})

test('le reglage de l hote sur la nuit sous-jacente vaut pour le reveillon qui s y replie', () => {
  const reglageDe = s => s.segment === 'vacances_zone_du_bien' ? { crans: 3, cle: 'vacances_zone_du_bien' } : null
  const avec = prix('2026-12-31', CTX, { reglageDe })
  const sans = prix('2026-12-31', CTX_SANS, { reglage: reglageDe({ segment: 'vacances_zone_du_bien' }) })
  assert.equal(avec.niveau, sans.niveau)
  assert.equal(avec.ajuste_par_l_hote, true)
  assert.equal(avec.cle_reglage, 'vacances_zone_du_bien')
  // ⚠ RELEVE EN REVIEW : le resume attribuait le cran au reveillon
  // (« Réveillon : +3 crans — c'est vous qui l'avez posé »), et `crans`
  // l'exposait comme l'influence du reveillon.
  const r = avec.couches.find(c => c.nom === 'position').resume
  assert.match(r, /garde le niveau qu’elle aurait sans cette date, Vacances de Noël un jeudi \(\+3 crans, votre réglage\)/)
  assert.equal(avec.crans, null, 'l influence du reveillon reste inconnue')
  assert.equal(avec.crans_mesures, null)
  assert.equal(avec.crans_sous_jacents, 3)
})

test('LE TEST QUI COMPTE : un reveillon dans un evenement de l hote regle s arrete sur cet evenement', () => {
  // Releve en review : la boucle sautait la « Semaine du Nouvel An » (non
  // mesuree) jusqu'aux vacances de Noel, ignorait son +4, et posait le 31 sous
  // le 30.
  const ev = [{ nom: 'Semaine du Nouvel An', segment: 'evenement:semaine_na', date_debut: '2026-12-29',
    date_fin: '2027-01-02', parent_segment: null, origine: 'declare' }]
  const ctx = ctxAvec([...COMMERCIALES, ...ev])
  const g = S.construireGrille(LIGNES, { contexte: ctx, debut: DEBUT, fin: '2025-12-31' })
  const reglageDe = t => t.segment === 'evenement:semaine_na' ? { crans: 4, cle: 'evenement:semaine_na' } : null
  const nuit = d => S.suggerer({ date: d, grille: g, contexte: ctx, ouverte: true, delaiJours: 30, bien,
    reglage: reglageDe(R.segmenterJour(d, ctx)), reglageDe })
  const veille = nuit('2026-12-30')
  const reveillon = nuit('2026-12-31')
  assert.equal(reveillon.position_sous_jacente, 'evenement:semaine_na')
  assert.equal(reveillon.cle_reglage, 'evenement:semaine_na')
  assert.equal(reveillon.niveau_de_depart, veille.niveau_de_depart,
    `reveillon ${reveillon.niveau_de_depart} ne doit pas passer sous la veille ${veille.niveau_de_depart}`)
})

test('un evenement de l hote replie dit « sans cet evenement » et la contrainte qui manque vraiment', () => {
  // 12 nuits en 2 reservations : le seuil manque par les RESERVATIONS.
  // Deux occurrences, hors des mardis et samedis de reference (fin octobre
  // 2025) : sinon ils entrent dans la saison et la rendent fiable.
  const ev = ['2025-12-01|2025-12-13', '2026-11-16|2026-11-20'].map(p => ({ nom: 'Saison thermale',
    segment: 'evenement:thermes', date_debut: p.split('|')[0], date_fin: p.split('|')[1],
    parent_segment: null, origine: 'declare' }))
  const ctx = ctxAvec([...COMMERCIALES, ...ev])
  const g = S.construireGrille([...LIGNES, ecl(['2025-12-01', '2025-12-02', '2025-12-03', '2025-12-04',
    '2025-12-05', '2025-12-06'], 130, 'T1'), ecl(['2025-12-08', '2025-12-09', '2025-12-10', '2025-12-11',
    '2025-12-12', '2025-12-13'], 130, 'T2')], { contexte: ctx, debut: DEBUT, fin: '2025-12-31' })
  assert.equal(g.positions.get('evenement:thermes').echantillon, 12)
  const s = S.suggerer({ date: '2026-11-19', grille: g, contexte: ctx, ouverte: true, delaiJours: 30, bien })
  const r = s.couches.find(c => c.nom === 'position').resume
  assert.match(r, /12 nuits mais 2 réservation\(s\), il en faut 3/)
  assert.match(r, /sans cet événement/)
})

test('un cran pose par l hote SUR la date commerciale reste prioritaire', () => {
  const s = prix('2026-12-31', CTX, { reglage: { crans: 4, cle: 'commercial:reveillon_nouvel_an' } })
  assert.equal(s.position_sous_jacente, undefined)
  assert.equal(s.ajuste_par_l_hote, true)
  assert.equal(s.cle_reglage, 'commercial:reveillon_nouvel_an')
})

test('LE TEST QUI COMPTE : la date commerciale passe avant le pont, jamais avant le ferie', () => {
  // Mardi 31 decembre 2024 : enclave entre le week-end et le 1er janvier.
  assert.equal(R.segmenterJour('2024-12-31', CTX_SANS).segment, 'pont', 'sans la date : un pont')
  assert.equal(R.segmenterJour('2024-12-31', CTX).segment, 'commercial:reveillon_nouvel_an')
  // Le lundi 30, lui, reste un pont : seule la date elle-meme est reprise.
  assert.equal(R.segmenterJour('2024-12-30', CTX).segment, 'pont')
  // Un ferie reste un ferie, meme sous une date commerciale.
  const fictive = [{ nom: 'Fictive', segment: 'commercial:fictive', date_debut: '2026-07-14',
    date_fin: '2026-07-14', origine: 'commercial', principale: true, parent_segment: null }]
  assert.equal(R.segmenterJour('2026-07-14', ctxAvec(fictive)).segment, 'ferie')
  // Le samedi RATTACHE a une date commerciale ne prend pas le pas sur un pont.
  const rattache = [{ nom: 'Rattache', segment: 'commercial:rattache', date_debut: '2024-12-31',
    date_fin: '2024-12-31', origine: 'commercial', principale: false, parent_segment: null }]
  assert.equal(R.segmenterJour('2024-12-31', ctxAvec(rattache)).segment, 'pont')
})

test('LE TEST QUI COMPTE : sur sept annees, aucune date commerciale sans mesure n est posee sous sa nuit ordinaire', () => {
  let vues = 0
  for (const e of COMMERCIALES) {
    const d = e.date_debut
    if (d < '2026-01-01') continue
    const avec = prix(d)
    // ⚠ LE CONTEXTE « SANS » EST BATI INDEPENDAMMENT du code teste — releve
    // en review : passer par `contexteSansEvenements` rendait le test vrai
    // par construction.
    const sans = prix(d, ctxAvec(COMMERCIALES.filter(x => x.segment !== e.segment)))
    if (avec.prix == null || sans.prix == null) continue
    vues++
    assert.ok(idx(avec.niveau_de_depart) >= idx(sans.niveau_de_depart),
      `${d} ${e.segment} : ${avec.niveau_de_depart} sous sa nuit ordinaire ${sans.niveau_de_depart}`)
    assert.equal(avec.sous_la_nuit_ordinaire, undefined, `${d} : aucun marqueur attendu`)
  }
  assert.ok(vues >= 20, `invariant verifie sur ${vues} nuits seulement`)
})

test('LE TEST QUI COMPTE : le reveillon n est jamais sous la nuit de vacances voisine (le defaut de prod)', () => {
  // Ce qu'on a vu en prod : le 31 decembre sous le 30. On compare aux nuits
  // VOISINES de vacances, pas a une construction du moteur.
  for (const [d, veille] of [['2026-12-31', '2026-12-30'], ['2026-12-24', '2026-12-23']]) {
    const a = prix(d), b = prix(veille)
    assert.equal(R.segmenterJour(veille, CTX).segment, 'vacances_zone_du_bien')
    assert.ok(a.prix >= b.prix, `${d} a ${a.prix} € sous la veille ${veille} a ${b.prix} €`)
  }
})

test('une date commerciale desactivee par l hote : le pont revient, et aucun repli', () => {
  const ctx = ctxAvec(datesCommerciales(DEBUT, FIN, { desactivees: ['reveillon_nouvel_an'] }))
  assert.equal(R.segmenterJour('2024-12-31', ctx).segment, 'pont')
  const s = S.suggerer({ date: '2026-12-31', grille: G, contexte: ctx, ouverte: true, delaiJours: 30, bien })
  assert.equal(s.segment, 'vacances_zone_du_bien')
  assert.equal(s.position_sous_jacente, undefined)
})

test('LE TEST QUI COMPTE : une position EMPRUNTEE sous la nuit ordinaire se marque, et se voit', () => {
  // Un evenement de l'hote en pleines vacances de Noel, avec pour parent
  // « hors vacances » : il emprunte une position plus basse que sa nuit.
  const ev = [{ nom: 'Marché de Noël', segment: 'evenement:marche', date_debut: '2026-12-22',
    date_fin: '2026-12-23', parent_segment: 'hors_vacances', origine: 'declare' }]
  const ctx = ctxAvec([...COMMERCIALES, ...ev])
  const g = S.construireGrille(LIGNES, { contexte: ctx, debut: DEBUT, fin: '2025-12-31' })
  const s = S.suggerer({ date: '2026-12-22', grille: g, contexte: ctx, ouverte: true, delaiJours: 30, bien })
  assert.equal(g.positions.get('evenement:marche').reference_empruntee, 'hors_vacances')
  assert.ok(s.sous_la_nuit_ordinaire, 'le garde-fou doit marquer la nuit')
  assert.equal(s.sous_la_nuit_ordinaire.segment_ordinaire, 'vacances_zone_du_bien')
  const c = s.couches.find(x => x.nom === 'anomalie')
  assert.ok(c && c.agit, 'la couche anomalie s affiche')
  assert.match(c.resume, /^À vérifier/)
})
