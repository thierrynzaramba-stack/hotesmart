// tests/zones-scolaires.test.js
// LE DEFAUT QU'ILS EMPECHENT : des vacances scolaires decalees d'un jour, ou
// attribuees a la mauvaise zone. Le moteur en tirerait une saisonnalite fausse
// et suggererait des prix hauts la veille du bon jour.

const test = require('node:test')
const assert = require('node:assert')

const {
  ACADEMIES, ZONE_PAR_DEPARTEMENT, departementDuCodePostal, zoneDuBien,
  jourLocalParis, veille, periodeDepuisSource, estLignePertinente, zoneDepuisSource
} = require('../lib/yield/zones-scolaires')

test('LE TEST QUI COMPTE : chaque academie est dans la BONNE zone', () => {
  // ⚠ MON PREMIER TEST VERIFIAIT LA FORME, PAS LE FOND, et il passait au vert
  // pendant que le 72 (Sarthe) etait classe en zone A au lieu de B. Un bien
  // manceau aurait ete place en vacances aux dates de Lyon au lieu de celles
  // de Nantes : deux semaines d'ecart sur la Toussaint, l'hiver et le
  // printemps, TOUS LES ANS. Couverture et absence de doublon ne disent rien
  // de l'exactitude de l'affectation.
  //
  // Cette liste est recopiee de l'arrete officiel, INDEPENDAMMENT du module :
  // c'est ce qui en fait un controle et non un miroir.
  const OFFICIEL = {
    A: { 'Besançon': ['25', '39', '70', '90'], 'Bordeaux': ['24', '33', '40', '47', '64'],
         'Clermont-Ferrand': ['03', '15', '43', '63'], 'Dijon': ['21', '58', '71', '89'],
         'Grenoble': ['07', '26', '38', '73', '74'], 'Limoges': ['19', '23', '87'],
         'Lyon': ['01', '42', '69'], 'Poitiers': ['16', '17', '79', '86'] },
    B: { 'Aix-Marseille': ['04', '05', '13', '84'], 'Amiens': ['02', '60', '80'],
         'Lille': ['59', '62'], 'Nancy-Metz': ['54', '55', '57', '88'],
         'Nantes': ['44', '49', '53', '72', '85'], 'Nice': ['06', '83'],
         'Normandie': ['14', '27', '50', '61', '76'],
         'Orléans-Tours': ['18', '28', '36', '37', '41', '45'],
         'Reims': ['08', '10', '51', '52'], 'Rennes': ['22', '29', '35', '56'],
         'Strasbourg': ['67', '68'] },
    C: { 'Créteil': ['77', '93', '94'], 'Montpellier': ['11', '30', '34', '48', '66'],
         'Paris': ['75'], 'Toulouse': ['09', '12', '31', '32', '46', '65', '81', '82'],
         'Versailles': ['78', '91', '92', '95'] }
  }

  for (const [zone, academies] of Object.entries(OFFICIEL)) {
    for (const [nom, deps] of Object.entries(academies)) {
      assert.deepEqual(ACADEMIES[zone]?.[nom], deps, `${nom} (zone ${zone})`)
    }
    assert.deepEqual(Object.keys(ACADEMIES[zone]).sort(), Object.keys(academies).sort(),
      `academies de la zone ${zone}`)
  }

  // Et le compte, qui aurait suffi a reveler l'erreur du 72 : A=32, B=41, C=21.
  const compte = {}
  for (const [z, deps] of Object.entries(ZONE_PAR_DEPARTEMENT)) compte[z] = deps.length
  assert.deepEqual(compte, { A: 32, B: 41, C: 21 })
})

test('la table derivee est coherente : ni doublon, ni trou, ni entree invalide', () => {
  const vus = {}
  const doublons = []
  const invalides = []
  for (const [zone, deps] of Object.entries(ZONE_PAR_DEPARTEMENT)) {
    for (const d of deps) {
      if (!/^\d{2,3}$/.test(d)) invalides.push(`${d} (${zone})`)
      if (vus[d]) doublons.push(`${d} : ${vus[d]} et ${zone}`)
      else vus[d] = zone
    }
  }
  assert.deepEqual(invalides, [], 'entrees qui ne sont pas des numeros de departement')
  assert.deepEqual(doublons, [], 'un departement ne peut appartenir qu a une zone')

  const manquants = []
  for (let i = 1; i <= 95; i++) {
    const d = String(i).padStart(2, '0')
    if (d === '20') continue
    if (!vus[d]) manquants.push(d)
  }
  assert.deepEqual(manquants, [], 'couverture 01-95 hors Corse')
  assert.equal(vus['20'], undefined, 'la Corse n est volontairement PAS dans la table')
})

test('quelques affectations, en clair', () => {
  assert.equal(zoneDuBien({ zip_code: '72000', country: 'FR' }), 'B', 'Le Mans : academie de Nantes')
  assert.equal(zoneDuBien({ zip_code: '44000', country: 'FR' }), 'B', 'Nantes')
  assert.equal(zoneDuBien({ zip_code: '21000', country: 'FR' }), 'A', 'Dijon')
  assert.equal(zoneDuBien({ zip_code: '34000', country: 'FR' }), 'C', 'Montpellier')
})

test('la zone se lit sur le CODE POSTAL, pas sur la ville', () => {
  // Mesure du 12 septembre 2026 : un bien porte `city = 'comomiers'` (faute de
  // frappe) avec `zip_code = '31770'`. Chercher par nom aurait rendu
  // « inconnu » sur un bien parfaitement localise.
  assert.equal(zoneDuBien({ zip_code: '31770', city: 'comomiers', country: 'FR' }), 'C')
  assert.equal(zoneDuBien({ zip_code: '65200', country: 'FR' }), 'C', 'Bagneres-de-Bigorre')
  assert.equal(zoneDuBien({ zip_code: '69001', country: 'FR' }), 'A', 'Lyon')
  assert.equal(zoneDuBien({ zip_code: '59000', country: 'FR' }), 'B', 'Lille')
  assert.equal(zoneDuBien({ zip_code: '75001', country: 'FR' }), 'C', 'Paris')
})

test('ce qui n a pas de zone rend null, jamais une zone devinee', () => {
  assert.equal(zoneDuBien({ zip_code: '20000', country: 'FR' }), null, 'Corse : calendrier propre')
  assert.equal(zoneDuBien({ zip_code: '97400', country: 'FR' }), null, 'La Reunion : calendrier propre')
  assert.equal(zoneDuBien({ zip_code: '31770', country: 'ES' }), null, 'hors de France')
  assert.equal(zoneDuBien({ zip_code: null }), null)
  assert.equal(zoneDuBien({ zip_code: 'abc' }), null)
  assert.equal(zoneDuBien(null), null)
  assert.equal(departementDuCodePostal('1234'), null, 'un code postal a 4 chiffres')
})

test('LE TEST QUI COMPTE : le decalage UTC varie avec l heure d ete', () => {
  // ⚠ LE PIEGE PRINCIPAL DE CE LOT, sur donnees reelles.
  // La source sert des instants UTC dont le decalage CHANGE selon la saison :
  // 22:00 l ete (UTC+2), 23:00 l hiver (UTC+1). Les deux valent MINUIT a Paris.
  // Un `slice(0,10)` rendrait la veille, et pas toujours du meme cote.
  assert.equal(jourLocalParis('2025-10-17T22:00:00+00:00'), '2025-10-18', 'heure d ete')
  assert.equal(jourLocalParis('2025-12-19T23:00:00+00:00'), '2025-12-20', 'heure d hiver')
  // Le naif aurait rendu le 17 et le 19.
  assert.notEqual(jourLocalParis('2025-10-17T22:00:00+00:00'), '2025-10-17')
  assert.equal(jourLocalParis('pas une date'), null)
  assert.equal(jourLocalParis(null), null)
})

test('veille : passages de mois, d annee, et annee bissextile', () => {
  assert.equal(veille('2026-01-01'), '2025-12-31')
  assert.equal(veille('2026-03-01'), '2026-02-28')
  assert.equal(veille('2024-03-01'), '2024-02-29', 'annee bissextile')
  assert.equal(veille('pas-une-date'), null)
})

test('LE TEST QUI COMPTE : end_date est la RENTREE, pas le dernier jour', () => {
  // Verifie sur les donnees reelles. Toussaint 2025 finit a 2025-11-02T23:00Z,
  // soit le 3 novembre a Paris — or la rentree a bien eu lieu le 3. Le dernier
  // jour de vacances est le 2. Stocker le 3 ferait compter un jour de trop a
  // chaque periode, tous les ans.
  assert.deepEqual(
    periodeDepuisSource({ start_date: '2025-10-17T22:00:00+00:00', end_date: '2025-11-02T23:00:00+00:00' }),
    { date_debut: '2025-10-18', date_fin: '2025-11-02' })
  assert.deepEqual(
    periodeDepuisSource({ start_date: '2025-12-19T23:00:00+00:00', end_date: '2026-01-04T23:00:00+00:00' }),
    { date_debut: '2025-12-20', date_fin: '2026-01-04' })
})

test('un evenement PONCTUEL ne devient pas une periode inversee', () => {
  // « Debut des Vacances d'Ete » est servi comme marqueur : start === end.
  // Le reculer d un jour rendrait fin < debut, que le CHECK refuserait.
  assert.deepEqual(
    periodeDepuisSource({ start_date: '2027-07-02T22:00:00+00:00', end_date: '2027-07-02T22:00:00+00:00' }),
    { date_debut: '2027-07-03', date_fin: '2027-07-03' })
  assert.equal(periodeDepuisSource({ start_date: null, end_date: '2027-07-02T22:00:00+00:00' }), null)
  // Une donnee corrompue (fin AVANT debut) ne doit pas devenir une periode
  // d'un jour inventee, indiscernable d'un vrai marqueur ponctuel.
  assert.equal(periodeDepuisSource({
    start_date: '2026-06-10T22:00:00+00:00', end_date: '2026-06-01T22:00:00+00:00' }), null)
  assert.equal(periodeDepuisSource(null), null)
})

test('les lignes « Enseignants » sont ecartees, pas les autres', () => {
  // La source sert une ligne par population : les enseignants rentrent un jour
  // plus tot, et garder leurs lignes ferait DEUX periodes concurrentes pour les
  // memes vacances.
  assert.equal(estLignePertinente({ population: '-' }), true)
  assert.equal(estLignePertinente({ population: '' }), true)
  assert.equal(estLignePertinente({}), true, 'champ absent : on garde')
  assert.equal(estLignePertinente({ population: 'Élèves' }), true)
  assert.equal(estLignePertinente({ population: 'Eleves' }), true, 'sans accent')
  assert.equal(estLignePertinente({ population: 'Enseignants' }), false)
})

test('la zone se lit dans le champ `zones` de la source', () => {
  assert.equal(zoneDepuisSource({ zones: 'Zone C' }), 'C')
  assert.equal(zoneDepuisSource({ zones: 'zone a' }), 'A')
  assert.equal(zoneDepuisSource({ zones: 'Corse' }), null)
  assert.equal(zoneDepuisSource({}), null)
})

test('le module est PUR : ni base, ni reseau', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'lib/yield/zones-scolaires.js'), 'utf8')
  assert.ok(!/fetch\(|supabase|require\('\.\.\//.test(src),
    'fonctions pures : c est ce qui permet de les tester exhaustivement')
})
