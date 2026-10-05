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
// Une carte ne porte AUCUNE cle d'argent, a aucun niveau, ni de montant dans un texte.
const CLES_ARGENT = /^(ttm_|l90d_)|rate|revenue|occupancy|revpar|fee|price|prix|currency$/i
function clesArgent (o, chemin = '') {
  if (Array.isArray(o)) return o.flatMap((x, i) => clesArgent(x, `${chemin}[${i}]`))
  if (!o || typeof o !== 'object') return []
  return Object.entries(o).flatMap(([k, v]) => [...(CLES_ARGENT.test(k) ? [`${chemin}.${k}`] : []), ...clesArgent(v, `${chemin}.${k}`)])
}


test('LE TEST QUI COMPTE : une carte n a AUCUN prix, revenu ou occupation — liste blanche', () => {
  const cartes = p.trierComparables(COMPS, MOI)
  assert.equal(cartes.length, 25)
  for (const c of cartes) {
    assert.deepEqual(Object.keys(c).sort(), ['a_vos_equipements', 'chambres', 'details', 'distance_km', 'equipements', 'latitude', 'listing_id', 'longitude', 'nom', 'ouvert_toute_annee', 'photo', 'photos', 'position_approchee', 'ressemblance', 'source', 'voyageurs'])
  }
  assert.deepEqual(clesArgent(cartes), [], 'aucune cle d argent')
  assert.ok(!/€|\$\s?\d/.test(JSON.stringify(cartes)), 'aucun montant, meme dans la description')
  assert.deepEqual(Object.keys(cartes[0].details).sort(), ['annulation', 'arrivee', 'avis', 'coup_de_coeur', 'depart', 'description', 'equipements_airbnb', 'gestion_pro', 'hote', 'lits', 'logement_entier', 'nb_photos', 'note', 'notes', 'reservation_instantanee', 'salles_de_bain', 'sejour_min', 'superhote', 'type'].sort())
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

test('ressemblance : 100 % pour un jumeau ; une composante NON MESURABLE COMPTE 0 (review de a52b3e4)', () => {
  const jumeau = fiche({ amenities: ['Free parking on premises', 'Mountain view'] })
  assert.equal(p.trierComparables([jumeau], MOI)[0].ressemblance, 100)
  const sansPosition = fiche({ amenities: ['Free parking on premises', 'Mountain view'] })
  sansPosition.location_info = {}
  const c = p.trierComparables([sansPosition], MOI)[0]
  assert.equal(c.distance_km, null)
  assert.equal(c.ressemblance, 60, 'la zone (40 %) manque')
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

// ─── Constats de la review de a52b3e4 ───────────────────────────────────────
test('REVIEW (C1) : une fiche VIDE ne passe jamais devant un voisin mesure', () => {
  const vide = { listing_info: { listing_id: '42', listing_name: 'Vide' } }
  const voisin = fiche({ lat: 43.066, bloques: 30 })
  const r = p.trierComparables([vide, voisin], { ...MOI, equipements: [] })
  assert.equal(r[0].nom, voisin.listing_info.listing_name)
  assert.ok(r[1].ressemblance <= 20, `vide : ${r[1].ressemblance} %`)
})

test('REVIEW (C2) : equipements — ni billard ni vue de piscine, ni garage hors du bien ; carport et clim split reconnus', () => {
  assert.deepEqual(p.equipementsDeFiche(['Pool table', 'Pool view', 'Paid parking garage off premises', 'Free street parking']), [])
  assert.deepEqual(p.equipementsDeFiche(['Free carport on premises']), ['parking'])
  assert.deepEqual(p.equipementsDeFiche(['Paid parking garage on premises']), ['parking'])
  assert.deepEqual(p.equipementsDeFiche(['AC - split type ductless system']), ['climatisation'])
  assert.deepEqual(p.equipementsDeFiche(['Window AC unit']), ['climatisation'])
  assert.deepEqual(p.equipementsDeFiche(['Vacuum cleaner', 'Backpack']), [], '« ac » dans un mot n est pas la clim')
  assert.deepEqual(p.equipementsDeFiche(['Private outdoor pool - available all year', 'Bay view']), ['piscine', 'vue'])
  assert.deepEqual(p.equipementsDeFiche(['Waterfront']), ['vue'])
})

test('LE TEST QUI COMPTE (SECURITE, review de a52b3e4) : la photo — https sur muscache.com seulement, URL reserialisee', () => {
  assert.equal(p.photoSure('https://a0.muscache.com/im/pictures/x.jpg?im_w=720'), 'https://a0.muscache.com/im/pictures/x.jpg?im_w=720')
  for (const mauvais of ['https://evil.example/x.jpg', 'http://a0.muscache.com/x.jpg', 'javascript:alert(1)', 'https://muscache.com.evil.example/x', 'https://user:pw@a0.muscache.com/x', 'https://a0.muscache.com:8443/x', null, 42]) {
    assert.equal(p.photoSure(mauvais), null, String(mauvais))
  }
  const casse = p.photoSure('https://a0.muscache.com/x" onerror="alert(1)')
  assert.ok(casse === null || !/"/.test(casse), 'aucun guillemet ne sort tel quel')
})

test('REVIEW : un identifiant en double ne donne qu une carte', () => {
  const a = fiche()
  const b = { ...fiche(), listing_info: { ...a.listing_info } }
  assert.equal(p.trierComparables([a, b], MOI).length, 1)
})

test('REVIEW (C5) : le tri suit le score brut, pas l arrondi affiche', () => {
  // Deux fiches dont les scores arrondis sont egaux mais pas les bruts : la meilleure passe devant,
  // quel que soit l'ordre d'AirROI.
  const moins = fiche({ bloques: 5 })
  const plus = fiche({ bloques: 4 })
  const r = p.trierComparables([moins, plus], MOI)
  assert.equal(r[0].ressemblance, r[1].ressemblance)
  assert.equal(r[0].nom, plus.listing_info.listing_name)
})

test('RE-REVIEW (65d6cc7) : « Air conditioning » seul et en majuscules est reconnu ; la borne « EV charger - AC » ne l est pas', () => {
  assert.deepEqual(p.equipementsDeFiche(['Air conditioning']), ['climatisation'])
  assert.deepEqual(p.equipementsDeFiche(['AIR CONDITIONING']), ['climatisation'])
  assert.deepEqual(p.equipementsDeFiche(['EV charger - AC']), [])
})

// ─── §21 : position, photos, provenance ─────────────────────────────────────
test('§21.4 : une carte porte la position publique de l annonce, ses photos filtrees (30 au plus), sa provenance', () => {
  const f = fiche({ lat: 43.07, lng: 0.15 })
  f.listing_info.photo_urls = ['https://a0.muscache.com/1.jpg', 'https://evil.example/2.jpg', ...Array.from({ length: 40 }, (_, i) => `https://a0.muscache.com/p${i}.jpg`)]
  const c = p.trierComparables([f], MOI)[0]
  assert.equal(c.latitude, 43.07)
  assert.equal(c.longitude, 0.15)
  assert.equal(c.photos.length, 30, '§21.6 : jusqu a 30 photos')
  assert.equal(c.photos[0], 'https://a0.muscache.com/x.jpg', 'la couverture d abord')
  assert.ok(c.photos.every(u => u.startsWith('https://a0.muscache.com/')), 'aucune photo hors muscache')
  assert.equal(c.source, 'voisins')
  const hors = fiche({ lat: 123 })
  assert.equal(p.trierComparables([hors], MOI)[0].latitude, null, 'une latitude impossible n est pas une position')
})

test('§21.2 : les deux listes reunies — sans doublon (la liste de base gagne), triees ensemble, la provenance dite', () => {
  const a = fiche({ bloques: 100 })
  const b = fiche({ amenities: ['Hot tub', 'Free parking on premises', 'Mountain view'] })
  const doublon = { ...a, listing_info: { ...a.listing_info } }
  const r = p.reunirEtTrier([a], [b, doublon], MOI)
  assert.equal(r.length, 2)
  assert.deepEqual(r.map(c => [c.nom, c.source]), [[b.listing_info.listing_name, 'equipements'], [a.listing_info.listing_name, 'voisins']])
})

// ─── §21.6 : toute l'information, sauf l'argent ──────────────────────────────
test('LE TEST QUI COMPTE (§21.6) : details — description, type, lits, note et sous-notes, hote, reservation, horaires, TOUS les equipements ; jamais l argent', () => {
  const f = fiche({ amenities: ['Hot tub', 'Wifi', 'Pool table'] })
  Object.assign(f.listing_info, { description: 'Bel appartement.<br />Linge : 15 € ; menage 30€.', listing_type: 'Entire rental unit', room_type: 'entire_home', guest_favorite: true, checkin_time: '3:00 PM', checkout_time: '11:00 AM', photos_count: 12 })
  f.property_details.beds = 2; f.property_details.baths = 1.5
  f.host_info = { host_name: 'Sophie', superhost: true, professional_management: false, host_id: 42 }
  f.booking_settings = { instant_book: true, min_nights: 2, cancellation_policy: 'Moderate' }
  f.ratings = { num_reviews: 45, rating_overall: 4.87, rating_cleanliness: 4.9, rating_accuracy: 4.8, rating_checkin: 5, rating_communication: 5, rating_location: 4.7, rating_value: 4.6 }
  const d = p.trierComparables([f], MOI)[0].details
  assert.equal(d.description, 'Bel appartement.\nLinge : … ; menage ….')
  assert.deepEqual({ type: d.type, entier: d.logement_entier, lits: d.lits, sdb: d.salles_de_bain, note: d.note, avis: d.avis }, { type: 'Entire rental unit', entier: true, lits: 2, sdb: 1.5, note: 4.87, avis: 45 })
  assert.deepEqual(d.notes, { proprete: 4.9, exactitude: 4.8, arrivee: 5, communication: 5, emplacement: 4.7, rapport_qualite: 4.6 })
  assert.deepEqual({ h: d.hote, s: d.superhote, g: d.gestion_pro, c: d.coup_de_coeur }, { h: 'Sophie', s: true, g: false, c: true })
  assert.deepEqual({ i: d.reservation_instantanee, m: d.sejour_min, a: d.annulation, ar: d.arrivee, de: d.depart, n: d.nb_photos }, { i: true, m: 2, a: 'Moderate', ar: '3:00 PM', de: '11:00 AM', n: 12 })
  assert.deepEqual(d.equipements_airbnb, ['Hot tub', 'Wifi', 'Pool table'], 'tous les equipements, tels quels')
  assert.ok(!('host_id' in d))
  assert.deepEqual(clesArgent(d), [])
})

test('§21.6 : une description — les balises retirees, les montants masques (euros, dollars, avant ou apres le nombre), le reste intact', () => {
  assert.equal(p.descriptionPropre('A surcharge of €20 will be requested.<br />Linen 15 euros, cleaning 30€, deposit $ 200 or 1 500 EUR.'),
    'A surcharge of … will be requested.\nLinen …, cleaning …, deposit … or ….')
  assert.equal(p.descriptionPropre('Studio de 25 m², 2 personnes, 10 min du centre<script>x</script>'), 'Studio de 25 m², 2 personnes, 10 min du centrex')
  assert.equal(p.descriptionPropre(42), null)
  assert.equal(p.descriptionPropre('x'.repeat(5000)).length, 3000)
})

test('§21.6 : une valeur de forme inattendue n est pas une information (objet, nombre hors bornes)', () => {
  const f = fiche()
  Object.assign(f.listing_info, { description: { x: 1 }, listing_type: 42, checkin_time: ['15'] })
  f.ratings = { rating_overall: 9, num_reviews: -3 }
  f.host_info = { host_name: { nom: 'x' }, superhost: 'oui' }
  const d = p.trierComparables([f], MOI)[0].details
  assert.deepEqual({ desc: d.description, type: d.type, ar: d.arrivee, note: d.note, avis: d.avis, hote: d.hote, sh: d.superhote }, { desc: null, type: null, ar: null, note: null, avis: null, hote: null, sh: null })
})

// ─── Constats de la review de 05223a1 ───────────────────────────────────────
test('LE TEST QUI COMPTE (review) : tous les formats de montant sont masques — devise avant, apres, collee, en entite HTML', () => {
  const formats = ['20 EUR', '20eur', '€20,50', '1.500 €', '1 500 €', 'EUR 20', 'EUR20', '50 CHF', 'CHF 50', '20 balles', '20,-€', '20E', '20 &euro;', '20&#8364;', '$15', '15 dollars', '£30']
  for (const f of formats) assert.equal(p.descriptionPropre(`Linge : ${f}.`), 'Linge : ….', f)
})

test('REVIEW : aucun faux positif — etage, surface, note, liste de nombres, mots en « eur »', () => {
  const t = '2e étage, 3 E-mails, 25 m², 10 min, 4,9 sur 5, 1, 2, 3 chambres, européen, Europe, eurostar 3'
  assert.equal(p.descriptionPropre(t), t)
})

test('REVIEW : une note de 0 n est pas une note (un bien a 2 avis portait 0 partout)', () => {
  const f = fiche()
  f.ratings = { num_reviews: 2, rating_overall: 0, rating_cleanliness: 0 }
  const d = p.trierComparables([f], MOI)[0].details
  assert.equal(d.note, null)
  assert.equal(d.notes.proprete, null)
  assert.equal(d.avis, 2)
})

test('REVIEW : « a vos equipements » est calcule par le serveur, quelle que soit la provenance — liste de base comprise', () => {
  const base = fiche({ amenities: ['Hot tub'] })
  const sans = fiche({ amenities: ['Wifi', 'Free parking on premises'] })
  const r = p.reunirEtTrier([base, sans], [], { ...MOI, equipements: ['spa', 'parking'] })
  const de = nom => r.find(c => c.nom === nom)
  assert.equal(de(base.listing_info.listing_name).a_vos_equipements, true, 'un bien de la liste de BASE avec jacuzzi')
  assert.equal(de(sans.listing_info.listing_name).a_vos_equipements, false, 'le parking n est pas un equipement rare')
})
