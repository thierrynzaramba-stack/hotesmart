// tests/pertinence.test.js — les comparables AirROI en cartes SANS PRIX, tries
// par ressemblance au profil du bien (spec §20.3 de docs/kb/chantier-nouveau-bien.md).
//
// CE QU'ILS EMPECHENT :
//   - un prix, un revenu ou une occupation dans une carte (on prend a AirROI sa
//     donnee, jamais ses prix) ;
//   - un tri qui ne suit pas l'ordre d'importance : zone, ouverture,
//     equipements, capacite ;
//   - un equipement mal reconnu (« Garden view » n'est pas un jardin).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const p = require('../lib/marche/pertinence')
const { lireJson } = require('../lib/airroi/json')

const COMPS = lireJson(fs.readFileSync(path.join(__dirname, 'fixtures', 'airroi', 'comps-labulle.json'), 'utf8')).listings
const MOI = { latitude: 43.0636, longitude: 0.1476, voyageurs: 2, chambres: 1, equipements: ['parking', 'vue'] }

// Une fiche AirROI minimale, au plus pres de la forme reelle.
let n = 0
function fiche ({ lat = 43.0636, lng = 0.1476, guests = 2, bedrooms = 1, bloques = 0, amenities = [], exact = true, ...prix } = {}) {
  n++
  return {
    listing_info: { listing_id: String(1000 + n), listing_name: `Bien ${n}`, cover_photo_url: 'https://a0.muscache.com/x.jpg' },
    location_info: { latitude: lat, longitude: lng, exact_location: exact },
    property_details: { guests, bedrooms, amenities },
    pricing_info: { cleaning_fee: 50 },
    performance_metrics: { ttm_blocked_days: bloques, ttm_avg_rate: 120, ttm_revenue: 9999, ttm_occupancy: 0.5, ...prix },
  }
}
const ids = cartes => cartes.map(c => c.nom)

test('LE TEST QUI COMPTE : une carte n a AUCUN prix, revenu ou occupation — liste blanche', () => {
  const cartes = p.trierComparables(COMPS, MOI)
  assert.equal(cartes.length, 25)
  for (const c of cartes) {
    assert.deepEqual(Object.keys(c).sort(), ['chambres', 'distance_km', 'equipements', 'listing_id', 'nom', 'ouvert_toute_annee', 'photo', 'position_approchee', 'ressemblance', 'voyageurs'])
  }
  const texte = JSON.stringify(cartes)
  for (const interdit of ['rate', 'revenue', 'occupancy', 'revpar', 'cleaning_fee', 'price', 'prix']) assert.ok(!texte.includes(interdit), interdit)
})

test('LE TEST QUI COMPTE (tri) : la ZONE d abord — a tout le reste egal, le plus proche passe devant', () => {
  const loin = fiche({ lat: 43.10 })      // ~4 km au nord
  const pres = fiche({ lat: 43.064 })
  assert.deepEqual(ids(p.trierComparables([loin, pres], MOI)), [pres.listing_info.listing_name, loin.listing_info.listing_name])
})

test('tri : a distance egale, le bien OUVERT TOUTE L ANNEE passe devant le saisonnier', () => {
  const saison = fiche({ bloques: 200 })
  const annee = fiche({ bloques: 0 })
  const r = p.trierComparables([saison, annee], MOI)
  assert.deepEqual(ids(r), [annee.listing_info.listing_name, saison.listing_info.listing_name])
  assert.equal(r[0].ouvert_toute_annee, true)
  assert.equal(r[1].ouvert_toute_annee, false)
})

test('tri : a distance et ouverture egales, les EQUIPEMENTS PARTAGES font remonter', () => {
  const sans = fiche({ amenities: ['Wifi'] })
  const avec = fiche({ amenities: ['Free parking on premises', 'Mountain view'] })
  assert.deepEqual(ids(p.trierComparables([sans, avec], MOI)), [avec.listing_info.listing_name, sans.listing_info.listing_name])
})

test('tri : a tout le reste egal, la CAPACITE la plus proche passe devant', () => {
  const grand = fiche({ guests: 8, bedrooms: 4 })
  const pareil = fiche({ guests: 2, bedrooms: 1 })
  assert.deepEqual(ids(p.trierComparables([grand, pareil], MOI)), [pareil.listing_info.listing_name, grand.listing_info.listing_name])
})

// ⚠ CE N'EST PAS UN TRI CRITERE PAR CRITERE : les poids (40 / 25 / 20 / 15 %)
// portent l'ordre d'importance. Un ecart MAXIMAL sur un critere l'emporte sur un
// ecart maximal du critere suivant ; un petit ecart, non.
test('LE TEST QUI COMPTE : l ordre d importance, a ecart maximal — la zone pese plus que l ouverture, qui pese plus que les equipements', () => {
  // Proche mais saisonnier, contre loin (8 km) mais ouvert toute l'annee.
  const proche = fiche({ bloques: 180 })
  const loin = fiche({ lat: 43.135, bloques: 0 })
  assert.equal(p.trierComparables([loin, proche], MOI)[0].nom, proche.listing_info.listing_name)
  // Ouvert sans equipements, contre saisonnier avec tous les equipements.
  const ouvert = fiche({ bloques: 0 })
  const equipe = fiche({ bloques: 365, amenities: ['Free parking on premises', 'Mountain view'] })
  assert.equal(p.trierComparables([equipe, ouvert], MOI)[0].nom, ouvert.listing_info.listing_name)
})

test('a egalite de score, l ordre d AirROI est garde', () => {
  const a = fiche()
  const b = fiche()
  assert.deepEqual(ids(p.trierComparables([a, b], MOI)), [a.listing_info.listing_name, b.listing_info.listing_name])
  assert.deepEqual(ids(p.trierComparables([b, a], MOI)), [b.listing_info.listing_name, a.listing_info.listing_name])
})

test('les equipements Airbnb reconnus — « Garden view » n est pas un jardin, une vue de jardin n est pas exceptionnelle', () => {
  assert.deepEqual(p.equipementsDeFiche(['Patio or balcony', 'Hot tub', 'Backyard', 'Shared outdoor pool', 'Free parking on premises', 'Mountain view', 'Central air conditioning']),
    ['terrasse', 'spa', 'jardin', 'piscine', 'parking', 'vue', 'climatisation'])
  assert.deepEqual(p.equipementsDeFiche(['Garden view', 'Free street parking', 'Wifi', 'Paid parking off premises']), [])
  assert.deepEqual(p.equipementsDeFiche(['Sauna', 'Paid parking on premises', 'River view']), ['spa', 'parking', 'vue'])
  assert.deepEqual(p.equipementsDeFiche(null), [])
})

test('ressemblance : 100 % pour un jumeau ; une composante non mesurable ne compte ni pour ni contre', () => {
  const jumeau = fiche({ amenities: ['Free parking on premises', 'Mountain view'] })
  assert.equal(p.trierComparables([jumeau], MOI)[0].ressemblance, 100)
  const sansPosition = fiche({ amenities: ['Free parking on premises', 'Mountain view'] })
  sansPosition.location_info = {}
  const c = p.trierComparables([sansPosition], MOI)[0]
  assert.equal(c.distance_km, null)
  assert.equal(c.ressemblance, 100)
  // Aucun equipement d'un cote ni de l'autre : la composante vaut 1.
  assert.equal(p.trierComparables([fiche()], { ...MOI, equipements: [] })[0].ressemblance, 100)
})

test('distance : haversine, ~111 km par degre de latitude ; nulle au-dela de 10 km', () => {
  assert.ok(Math.abs(p.distanceKm({ latitude: 43, longitude: 0 }, { latitude: 44, longitude: 0 }) - 111.2) < 0.2)
  const tresLoin = fiche({ lat: 43.25 })
  const c = p.composantes(tresLoin, MOI)
  assert.equal(c.zone, 0)
})

test('une position approchee (exact_location faux) se dit ; une photo non https est ecartee ; une fiche sans identifiant est ignoree', () => {
  const approx = fiche({ exact: false })
  approx.listing_info.cover_photo_url = 'javascript:alert(1)'
  const sansId = fiche()
  sansId.listing_info.listing_id = 'abc'
  const r = p.trierComparables([approx, sansId], MOI)
  assert.equal(r.length, 1)
  assert.equal(r[0].position_approchee, true)
  assert.equal(r[0].photo, null)
})

test('un profil sans position est refuse', () => {
  assert.throws(() => p.trierComparables(COMPS, { ...MOI, latitude: undefined }), /sans position/)
})

test('donnees reelles (La bulle) : 25 cartes, ressemblances decroissantes, toutes a moins de 500 m', () => {
  const r = p.trierComparables(COMPS, MOI)
  for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].ressemblance >= r[i].ressemblance)
  assert.ok(r.every(c => c.distance_km < 0.5))
  assert.ok(r[0].ressemblance >= 85)
})
