// tests/marche-global.test.js — le marche global (cadrage §14) : bloc 1 (ADR et
// occupation medianes), bloc 2 (RevPAR en quantiles, couverture), bloc 3
// (calendrier jour par jour CONSTRUIT).
//
// LES DEFAUTS QU'ILS EMPECHENT :
//   - un mois non mesure (0 chez AirROI) trace comme un zero ;
//   - la couverture partielle de 2021-2022 cachee ;
//   - la vue qui lirait le marche d'un autre client, ou paierait un appel ;
//   - une page qui ecrirait, ou tairait qu'elle n'est pas un prix ;
//   - un ADR brut lu comme un net, une occupation du marche mise en regard de
//     celle d'un logement (regle 13) ;
//   - un relief qui deplacerait le niveau du mois (il est a somme nulle), un
//     mois classe sans ses vacances, des bornes de niveau decalees.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { revparMensuel, adrOccupationMensuel, calendrierAttendu, poidsDuJour, niveauDe } = require('../lib/marche/marche-global')
const { cleCanonique } = require('../lib/airroi/client')

const RACINE = path.join(__dirname, '..')
const TEXTE60 = fs.readFileSync(path.join(__dirname, 'fixtures', 'airroi', 'marche-60.json'), 'utf8')
const MARCHE60 = JSON.parse(TEXTE60)

test('LE TEST QUI COMPTE : les 60 mois de Bagneres, quatre quantiles et la couverture reelle, tels que mesures', () => {
  const r = revparMensuel(MARCHE60)
  assert.equal(r.statut, 'calcule')
  assert.equal(r.mois.length, 60)
  assert.deepEqual([r.mois[0].mois, r.mois[59].mois], ['2021-09', '2026-08'])
  assert.deepEqual(r.mois[0], { mois: '2021-09', p25: 18.3, p50: 34.9, p75: 57.2, p90: 108.8, annonces: 432, couverture_partielle: true })
  assert.deepEqual(r.mois[59], { mois: '2026-08', p25: 19.6, p50: 39.8, p75: 61.9, p90: 92.3, annonces: 953, couverture_partielle: false })
  assert.deepEqual([...new Set(r.mois.filter(m => m.couverture_partielle).map(m => m.mois.slice(0, 4)))], ['2021', '2022'])
  assert.deepEqual(r.marche, { pays: 'France', region: 'Occitania', localite: 'Bagnères-de-Bigorre' })
})

test('LE TEST QUI COMPTE : une valeur 0 est une ABSENCE (null), jamais un zero trace ; mois en double et dates illisibles ecartes', () => {
  const troue = { results: [
    { date: '2025-01-01', revpar: { p25: 0, p50: 30, p75: 40, p90: 0 }, active_listings_count: 0 },
    { date: '2025-01-01', revpar: { p25: 1, p50: 1, p75: 1, p90: 1 } },
    { date: 'hier', revpar: {} },
    { date: '2025-02-01', revpar: { p25: 10, p50: 20, p75: 30, p90: 40 }, active_listings_count: 900 }] }
  const r = revparMensuel(troue)
  assert.deepEqual(r.mois[0], { mois: '2025-01', p25: null, p50: 30, p75: 40, p90: null, annonces: null, couverture_partielle: false })
  assert.deepEqual(r.ecartes.map(e => e.motif), ['mois en double', 'date illisible'])
  assert.equal(revparMensuel({ results: [] }).statut, 'non_calculable')
  assert.equal(revparMensuel({ results: [{ date: '2025-01-01', revpar: { p50: 0 } }] }).statut, 'non_calculable')
})

// ─── La vue d'API ───────────────────────────────────────────────────────────
function base (tables) {
  const lus = []
  return { lus, client: { from: t => {
    lus.push(t)
    // `null` : la table est en panne (erreur de lecture).
    const panne = tables[t] === null
    let lignes = [...(tables[t] || [])]
    const rendu = d => Promise.resolve(panne ? { data: null, error: { message: 'panne simulee' } } : { data: d, error: null })
    const q = { select: () => q, eq: (k, v) => { lus.push(`${t}.${k}=${v}`); lignes = lignes.filter(l => l[k] === v); return q },
      lte: (k, v) => { lignes = lignes.filter(l => l[k] <= v); return q },
      gte: (k, v) => { lignes = lignes.filter(l => l[k] >= v); return q },
      order: () => q,
      limit: n => rendu(lignes.slice(0, n)),
      then: (ok, ko) => rendu(lignes).then(ok, ko) }
    return q
  } } }
}

async function appeler (query, tables, garde = { ok: true, bien: { id: 'BIEN-A' } }) {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:1'
  process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'factice-non-secret'
  const cheminGarde = require.resolve(path.join(RACINE, 'lib', 'require-permission'))
  const vraie = require(cheminGarde)
  const cheminSb = require.resolve('@supabase/supabase-js')
  const vraiSb = require(cheminSb)
  const gardes = []
  const b = base(tables)
  const vraiFetch = globalThis.fetch
  let appelsReseau = 0
  let minuterie
  try {
    globalThis.fetch = async () => { appelsReseau++; throw new Error('aucun appel reseau attendu') }
    require.cache[cheminGarde].exports = { ...vraie, requirePermission: async (req, res, o) => { gardes.push(o); return garde } }
    require.cache[cheminSb].exports = { ...vraiSb, createClient: () => b.client }
    delete require.cache[require.resolve(path.join(RACINE, 'api', 'marche-global'))]
    const api = require(path.join(RACINE, 'api', 'marche-global'))
    const reponse = await Promise.race([
      new Promise(resolve => {
        let code = 200
        const res = { status (c) { code = c; return res }, setHeader () {}, json: corps => resolve({ code, corps }) }
        Promise.resolve(api({ method: 'GET', query, headers: {} }, res)).then(() => resolve({ code, corps: null }))
      }),
      new Promise((resolve, reject) => { minuterie = setTimeout(() => reject(new Error('pas de reponse')), 5000) })
    ])
    return { ...reponse, gardes, lus: b.lus, appelsReseau }
  } finally {
    clearTimeout(minuterie)
    globalThis.fetch = vraiFetch
    require.cache[cheminGarde].exports = vraie
    require.cache[cheminSb].exports = vraiSb
  }
}

const CLE_BAGNERES = cleCanonique('POST /markets/metrics/all', { market: { country: 'France', region: 'Occitania', locality: 'Bagnères-de-Bigorre' }, num_months: 60, currency: 'native' })
const CLE_TOULOUSE = cleCanonique('POST /markets/metrics/all', { market: { country: 'France', region: 'Occitania', locality: 'Toulouse' }, num_months: 60, currency: 'native' })
const TABLES = {
  marche_biens: [{ property_id: 'BIEN-A', pays: 'France', region: 'Occitania', localite: 'Bagnères-de-Bigorre' },
    { property_id: 'BIEN-T', pays: 'France', region: 'Occitania', localite: 'Toulouse' }],
  school_holidays: [],
  airroi_cache: [{ cle: CLE_BAGNERES, reponse: TEXTE60, recupere_le: '2026-09-23T00:00:00Z' },
    { cle: CLE_TOULOUSE, reponse: JSON.stringify({ market: {}, results: [{ date: '2026-01-01', revpar: { p50: 999 } }] }), recupere_le: '2026-09-23T00:00:00Z' }]
}

test('LE TEST QUI COMPTE (securite) : garde du logement, SEUL le marche de ce logement, sous la cle exacte du cache, aucun appel reseau', async () => {
  const sans = await appeler({}, TABLES)
  assert.equal(sans.code, 400)
  assert.deepEqual(sans.lus, [])
  // Le client envoie un identifiant BRUT (numero provider) ; la garde le
  // resout en BIEN-A. La vue doit lire par le bien RESOLU (review : la
  // premiere version passait la meme valeur des deux cotes, et ne prouvait rien).
  const r = await appeler({ property_id: '209413' }, TABLES, { ok: true, bien: { id: 'BIEN-A' } })
  assert.deepEqual(r.gardes, [{ domaine: 'reservations', niveau: 'read', bien: '209413', bienRequis: true }])
  assert.deepEqual(r.lus, ['marche_biens', 'marche_biens.property_id=BIEN-A', 'airroi_cache', `airroi_cache.cle=${CLE_BAGNERES}`, 'school_holidays', 'school_holidays'])
  assert.equal(r.corps.etat, 'calcule')
  assert.equal(r.corps.marche.localite, 'Bagnères-de-Bigorre')
  assert.equal(r.corps.revpar.mois.length, 60)
  assert.equal(r.appelsReseau, 0)
})

test('sans lien : marche inconnu ; sans historique en cache : dit, avec le cout, sans rien payer ; garde refusee : rien n est lu', async () => {
  const inconnu = await appeler({ property_id: 'BIEN-Z' }, TABLES, { ok: true, bien: { id: 'BIEN-Z' } })
  assert.equal(inconnu.corps.etat, 'marche_inconnu')
  const vide = await appeler({ property_id: 'BIEN-A' }, { ...TABLES, airroi_cache: [] })
  assert.equal(vide.corps.etat, 'historique_absent')
  assert.match(vide.corps.motif, /0,50 \$, par un script, jamais depuis cet ecran/)
  assert.equal(vide.appelsReseau, 0)
  const refus = await appeler({ property_id: 'BIEN-A' }, TABLES, { ok: false })
  assert.deepEqual(refus.lus, [])
})

// ─── La page ────────────────────────────────────────────────────────────────
const PAGE = fs.readFileSync(path.join(RACINE, 'apps', 'yield', 'marche-global.html'), 'utf8')

test('LE TEST QUI COMPTE : la page est en lecture seule, dit en tete ce qu elle est, et porte les deux mentions', () => {
  const appels = [...PAGE.matchAll(/fetch\(\s*([`'"])([^`'"]*)/g)].map(m => m[2])
  assert.ok(appels.length >= 1)
  for (const u of appels) assert.ok(u.startsWith('/api/marche-global?property_id='), `appel inattendu : ${u}`)
  assert.ok(!/method\s*:/.test(PAGE))
  assert.deepEqual([...PAGE.matchAll(/supabase\.from\(\s*'([^']+)'/g)].map(m => m[1]), ['properties'])
  assert.ok(!/\.(insert|update|upsert|delete)\(/.test(PAGE))
  assert.match(PAGE, /Une estimation du marché, pas un prix/)
  assert.match(PAGE, /ne pilote rien/)
  assert.match(PAGE, /pas un prix pour votre logement/)
  assert.match(PAGE, /2021-2022 : couverture AirROI en cours de mise en place/)
  assert.match(PAGE, /Couverture réelle, mois par mois/)
})

test('un mois ABSENT de la reponse coupe la serie (ligne nulle inseree) ; une valeur de forme inattendue n est pas une mesure', () => {
  const r = revparMensuel({ results: [
    { date: '2025-01-01', revpar: { p25: 10, p50: 20, p75: 30, p90: 40 } },
    { date: '2025-03-01', revpar: { p25: 11, p50: '21', p75: true, p90: [41] } }] })
  assert.deepEqual(r.mois.map(m => m.mois), ['2025-01', '2025-02', '2025-03'])
  assert.equal(r.mois[1].p50, null)
  assert.equal(r.mois[1].absent_de_la_reponse, true)
  assert.deepEqual([r.mois[2].p50, r.mois[2].p75, r.mois[2].p90], [21, null, null])
})

test('un cache illisible ou un marche saisi en forme decomposee : dit, jamais un 500 ni un faux « absent »', async () => {
  const illisible = await appeler({ property_id: 'x' }, { ...TABLES, airroi_cache: [{ cle: CLE_BAGNERES, reponse: '{pas du json', recupere_le: '2026-09-23' }] })
  assert.equal(illisible.code, 200)
  assert.match(illisible.corps.motif, /illisible/)
  const nfd = { ...TABLES, marche_biens: [{ property_id: 'BIEN-A', pays: 'France', region: 'Occitania', localite: 'Bagnères-de-Bigorre'.normalize('NFD') }] }
  const r = await appeler({ property_id: 'x' }, nfd)
  assert.equal(r.corps.etat, 'calcule', 'la forme NFD retrouve le cache ecrit en NFC')
})


// ─── Bloc 1 : ADR et occupation ─────────────────────────────────────────────
test('LE TEST QUI COMPTE (bloc 1) : ADR et occupation medianes mois par mois, et le profil prix / remplissage des douze mois', () => {
  const r = adrOccupationMensuel(MARCHE60)
  assert.equal(r.statut, 'calcule')
  assert.equal(r.mois.length, 60)
  assert.deepEqual(r.mois[0], { mois: '2021-09', adr: 54.1, occupation: 0.57, couverture_partielle: true })
  assert.deepEqual(r.mois[59], { mois: '2026-08', adr: 78.5, occupation: 0.51, couverture_partielle: false })
  assert.deepEqual(r.profil.map(p => p.porte_par),
    ['prix', 'les_deux', 'les_deux', null, null, null, 'remplissage', 'remplissage', null, null, null, 'prix'])
  assert.deepEqual([r.profil[11].adr, r.profil[11].occupation], [83.2, 0.34])
})

test('bloc 1 : 0 et une occupation au-dela de 1 ne sont pas des mesures ; sans aucune mesure, non calculable', () => {
  const r = adrOccupationMensuel({ results: [
    { date: '2025-01-01', revpar: { p50: 10 }, average_daily_rate: { p50: 0 }, occupancy: { p50: 1.2 } },
    { date: '2025-02-01', revpar: { p50: 10 }, average_daily_rate: { p50: 60 }, occupancy: { p50: 1 } }] })
  assert.deepEqual(r.mois.map(m => [m.adr, m.occupation]), [[null, null], [60, 1]])
  assert.equal(adrOccupationMensuel({ results: [{ date: '2025-01-01', revpar: { p50: 10 } }] }).motif, 'ADR et occupation absents de l historique')
  assert.equal(adrOccupationMensuel({ results: [{ date: '2025-01-01', revpar: { p50: 10 }, average_daily_rate: { p50: 60 } }] }).motif, 'occupation absent de l historique')
})

// ─── Bloc 3 : le calendrier construit ───────────────────────────────────────
const VAC = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'vacances-2026-2027.json'), 'utf8'))

test('LE TEST QUI COMPTE (bloc 3, exige par Thierry) : pour CHAQUE mois, la moyenne des jours apres relief = le niveau mensuel', () => {
  const c = calendrierAttendu(MARCHE60, VAC.vacances, VAC.etendue, '2026-09')
  assert.equal(c.statut, 'calcule')
  assert.equal(c.nature, 'niveau_attendu')
  const calcules = c.mois.filter(m => m.statut === 'calcule')
  assert.deepEqual(calcules.map(m => m.mois), ['2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06'])
  assert.deepEqual(calcules.map(m => m.niveau_mensuel), [24.5, 21.6, 17.4, 31.2, 31.7, 75.9, 37.9, 17.6, 16.1, 21.5])
  for (const m of calcules) {
    const moyenne = m.jours.reduce((a, j) => a + j.valeur, 0) / m.jours.length
    // Egalite au bruit du flottant pres (somme de 30 quotients), pas une tolerance metier.
    assert.ok(Math.abs(moyenne - m.niveau_mensuel) < 1e-9, `${m.mois} : moyenne ${moyenne} ≠ niveau ${m.niveau_mensuel}`)
    assert.equal(m.jours.length, new Date(Date.UTC(Number(m.mois.slice(0, 4)), Number(m.mois.slice(5, 7)), 0)).getUTCDate())
  }
  assert.equal(c.reference, 27.85, 'la mediane des douze niveaux mensuels, celle des bornes posees')
})

test('LE TEST QUI COMPTE (bloc 3) : les reglages de Thierry, cumules en multiplication — Noel 2026', () => {
  const c = calendrierAttendu(MARCHE60, VAC.vacances, VAC.etendue, '2026-09')
  const dec = c.mois.find(m => m.mois === '2026-12').jours
  const j = iso => dec.find(x => x.jour === iso)
  assert.deepEqual(j('2026-12-25').raisons, ['vacances_3_zones', 'ferie', 'nuit_du_vendredi', 'fetes'])
  assert.deepEqual(j('2026-12-24').raisons, ['vacances_3_zones', 'fetes'])
  assert.deepEqual(j('2026-12-02').raisons, [])
  // Rapport entre deux jours du meme mois = rapport de leurs poids.
  assert.ok(Math.abs(j('2026-12-25').valeur / j('2026-12-02').valeur - 1.45 * 1.20 * 1.10 * 1.60) < 1e-12)
  assert.ok(Math.abs(j('2026-12-24').valeur / j('2026-12-02').valeur - 1.45 * 1.60) < 1e-12)
  assert.deepEqual([j('2026-12-25').niveau, j('2026-12-02').niveau], ['tres_fort', 'moyen'])
  // Un pont compte comme un ferie, sans s'y ajouter ; une zone, deux zones.
  assert.equal(poidsDuJour('2027-05-07', [], new Map(), new Map([['2027-05-07', 'Ascension']])).poids, 1.20 * 1.10)
  const v2 = [{ zone: 'A', date_debut: '2027-02-10', date_fin: '2027-02-10' }, { zone: 'B', date_debut: '2027-02-01', date_fin: '2027-02-28' }]
  assert.deepEqual(poidsDuJour('2027-02-10', v2, new Map(), new Map()), { poids: 1.35, raisons: ['vacances_2_zones'] })
  assert.deepEqual(poidsDuJour('2027-02-11', v2, new Map(), new Map()), { poids: 1.25, raisons: ['vacances_1_zone'] })
})

test('bloc 3 : un mois sans les vacances publiees des trois zones n est PAS classe ; les bornes 75 / 110 / 140 % tombent au bon niveau', () => {
  const c = calendrierAttendu(MARCHE60, VAC.vacances, VAC.etendue, '2026-09')
  assert.deepEqual(c.mois.filter(m => m.statut !== 'calcule').map(m => [m.mois, m.motif]), [
    ['2027-07', 'vacances scolaires non publiées dans la base pour les zones A, B, C'],
    ['2027-08', 'vacances scolaires non publiées dans la base pour les zones A, B, C']])
  const sansC = calendrierAttendu(MARCHE60, VAC.vacances, VAC.etendue.filter(e => e.zone !== 'C'), '2026-10', 1)
  assert.deepEqual(sansC.mois.map(m => m.motif), ['vacances scolaires non publiées dans la base pour la zone C'])
  assert.deepEqual(calendrierAttendu(MARCHE60, [], [], '2026-10', 1).mois.map(m => m.statut), ['non_calculable'])
  // Bornes : faible < 75 % ≤ moyen < 110 % ≤ fort < 140 % ≤ tres fort.
  assert.deepEqual([0.7499, 0.75, 1.0999, 1.10, 1.3999, 1.40, 3].map(niveauDe),
    ['faible', 'moyen', 'moyen', 'fort', 'fort', 'tres_fort', 'tres_fort'])
})

test('bloc 3 : aucune horloge dans le calcul — un premier mois illisible est refuse, pas remplace par « aujourd hui »', () => {
  assert.throws(() => calendrierAttendu(MARCHE60, [], [], undefined), /premierMois illisible/)
})

test('LE TEST QUI COMPTE (page) : ADR brut et Airbnb seulement, occupation du marche jamais mise en regard, calendrier dit « pas une mesure », ordre des blocs', () => {
  assert.match(PAGE, /ADR <b>brut, avant la commission Airbnb<\/b> \(18,4 % du brut/)
  assert.match(PAGE, /<b>Airbnb seulement<\/b> : ne le comparez pas à ce que vous touchez net/)
  assert.match(PAGE, /elle ne se compare pas à l’occupation d’un logement/)
  assert.match(PAGE, /<b>Lecture\.<\/b> Un mois fort par le prix/)
  assert.match(PAGE, /Un niveau attendu, bâti sur l’historique et le calendrier — pas une mesure/)
  // Regle 13 : la page ne lit du logement que son nom.
  assert.deepEqual([...PAGE.matchAll(/supabase\.from\('properties'\)\.select\('([^']*)'\)/g)].map(m => m[1]), ['id, name'])
  assert.match(PAGE, /corps\(bloc1\(d\.adr_occupation\) \+ indicateur1\(d\.revpar\) \+ bloc3\(d\.calendrier\)\)/)
})

test('la vue rend les trois blocs ; des vacances illisibles laissent les blocs 1 et 2 et disent le calendrier non calculable', async () => {
  const r = await appeler({ property_id: 'x' }, TABLES)
  assert.deepEqual(Object.keys(r.corps), ['source', 'etat', 'marche', 'recupere_le', 'adr_occupation', 'revpar', 'calendrier'])
  assert.equal(r.corps.adr_occupation.statut, 'calcule')
  assert.equal(r.corps.calendrier.statut, 'calcule')
  assert.equal(r.corps.calendrier.mois.length, 12)
  assert.ok(r.corps.calendrier.mois.every(m => m.statut === 'non_calculable'), 'base sans vacances : aucun mois classe')
  const casse = { ...TABLES, school_holidays: null }
  const r2 = await appeler({ property_id: 'x' }, casse)
  assert.equal(r2.code, 200)
  assert.equal(r2.corps.adr_occupation.statut, 'calcule')
  assert.deepEqual(r2.corps.calendrier, { statut: 'non_calculable', motif: 'les vacances scolaires sont illisibles', mois: [] })
})

test('LE TEST QUI COMPTE (review de 069ecec) : le « Pont de l Ascension » de la base n est pas des vacances — le pont ne pese que comme un ferie', () => {
  const c = calendrierAttendu(MARCHE60, VAC.vacances, VAC.etendue, '2027-05', 1)
  const mai = c.mois[0].jours
  const j = iso => mai.find(x => x.jour === iso)
  assert.deepEqual(j('2027-05-07').raisons, ['pont', 'nuit_du_vendredi'])
  assert.deepEqual(j('2027-05-06').raisons, ['ferie'])
  assert.ok(Math.abs(j('2027-05-07').valeur / j('2027-05-06').valeur - 1.10) < 1e-12)
})

test('LE TEST QUI COMPTE (review de 069ecec) : un ete publie par son seul marqueur de debut n est pas classe — ni pic d un jour, ni ete « hors vacances »', () => {
  // L'etendue deborde l'ete (comme apres l'import de 2027-2028) ; l'ete 2027
  // n'a que son marqueur.
  const etendue = ['A', 'B', 'C'].map(zone => ({ zone, date_debut: '2017-10-21', date_fin: '2028-07-01' }))
  const c = calendrierAttendu(MARCHE60, VAC.vacances, etendue, '2027-06', 4)
  assert.deepEqual(c.mois.map(m => [m.mois, m.statut]), [['2027-06', 'calcule'], ['2027-07', 'non_calculable'], ['2027-08', 'non_calculable'], ['2027-09', 'calcule']])
  assert.equal(c.mois[1].motif, 'fin des vacances d’été non publiée dans la base pour les zones A, B, C')
  // La periode d'ete publiee : juillet se classe, le 3 juillet n'est pas un pic isole.
  const ete = ['A', 'B', 'C'].map(zone => ({ zone, nom: 'Vacances d\'Été', date_debut: '2027-07-03', date_fin: '2027-08-31' }))
  const c2 = calendrierAttendu(MARCHE60, [...VAC.vacances, ...ete], etendue, '2027-07', 1)
  assert.equal(c2.mois[0].statut, 'calcule')
  assert.deepEqual(c2.mois[0].jours.find(x => x.jour === '2027-07-05').raisons, ['vacances_3_zones'])
})

test('la vue classe des jours quand la base porte les vacances (review : la vue n avait jamais produit un jour classe)', async () => {
  const toutes = ['A', 'B', 'C'].map(zone => ({ zone, nom: 'Periode longue de test', date_debut: '2000-01-01', date_fin: '2100-12-31', annee_scolaire: 'test' }))
  const r = await appeler({ property_id: 'x' }, { ...TABLES, school_holidays: toutes })
  assert.equal(r.corps.calendrier.mois.length, 12)
  assert.ok(r.corps.calendrier.mois.every(m => m.statut === 'calcule'))
  assert.ok(r.corps.calendrier.mois.every(m => m.jours.every(j => j.raisons.includes('vacances_3_zones'))))
})
