// tests/marche-temperature-api.test.js — l'API du calendrier de temperature
// (pipeline AirROI, spec §15 de docs/kb/chantier-nouveau-bien.md, lot T2).
//
// CE QU'ILS EMPECHENT :
//   - ⚠ SECURITE : une vue qui rendrait le marche d'un AUTRE logement, ou un
//     marche sans garde du logement ;
//   - un PRIX qui sortirait, en euros ou en base 100 (§15.6) ;
//   - la mauvaise capture (la plus recente, et de la methode courante) ;
//   - une lecture de l'historique : le pipeline est ETANCHE.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const t = require('../lib/marche/temperature-airroi')
const { lireJson } = require('../lib/airroi/json')

const RACINE = path.join(__dirname, '..')
const RELIEF = lireJson(fs.readFileSync(path.join(__dirname, 'fixtures', 'airroi', 'relief-bagneres-2026-09-30.json'), 'utf8'))
const BAGNERES = { country: 'France', region: 'Occitania', locality: 'Bagnères-de-Bigorre' }

// Un simulacre de Supabase qui APPLIQUE eq, order, limit et range.
function base (tables) {
  const lus = []
  return { lus, client: { from: tb => {
    lus.push(tb)
    let lignes = [...(tables[tb] || [])]
    const q = {
      select: () => q,
      eq: (k, v) => { lignes = lignes.filter(l => l[k] === v); return q },
      order: (k, { ascending }) => { lignes = [...lignes].sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (ascending ? 1 : -1)); return q },
      limit: n => Promise.resolve({ data: lignes.slice(0, n), error: null }),
      range: (a, b) => Promise.resolve({ data: lignes.slice(a, b + 1), error: null }),
    }
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
  try {
    require.cache[cheminGarde].exports = { ...vraie, requirePermission: async (req, res, o) => { gardes.push(o); return garde } }
    require.cache[cheminSb].exports = { ...vraiSb, createClient: () => b.client }
    delete require.cache[require.resolve(path.join(RACINE, 'api', 'marche-temperature'))]
    const api = require(path.join(RACINE, 'api', 'marche-temperature'))
    const reponse = await new Promise(resolve => {
      let code = 200
      const res = { status (c) { code = c; return res }, setHeader () {}, json: corps => resolve({ code, corps }) }
      Promise.resolve(api({ method: 'GET', query, headers: {} }, res)).then(() => resolve({ code, corps: null }))
    })
    return { ...reponse, gardes, lus: b.lus }
  } finally {
    require.cache[cheminGarde].exports = vraie
    require.cache[cheminSb].exports = vraiSb
  }
}

// La table : Bagneres (capture reelle), Toulouse (un AUTRE marche), et une
// capture plus ancienne de Bagneres sous une autre methode.
const lignesBagneres = t.construireLignes({ marche: BAGNERES, reponse: RELIEF })
const autreMarche = t.construireLignes({ marche: { ...BAGNERES, locality: 'Toulouse' }, reponse: RELIEF }).map(l => ({ ...l, capture_le: '2026-12-01', fete_nom: 'SECRET-TOULOUSE' }))
const vieilleMethode = lignesBagneres.slice(0, 3).map(l => ({ ...l, capture_le: '2027-01-01', methode: 'ancienne', niveau: 'pic' }))
const TABLES = {
  marche_biens: [{ property_id: 'BIEN-A', pays: 'France', region: 'Occitania', localite: 'Bagnères-de-Bigorre' }],
  marche_temperature_airroi: [...lignesBagneres, ...autreMarche, ...vieilleMethode],
}

test('LE TEST QUI COMPTE (securite) : un logement est exige, sous sa garde, et SEUL son marche est rendu', async () => {
  const sans = await appeler({}, TABLES)
  assert.equal(sans.code, 400)
  const r = await appeler({ property_id: 'BIEN-A' }, TABLES)
  assert.equal(r.code, 200)
  assert.deepEqual(r.gardes, [{ domaine: 'reservations', niveau: 'read', bien: 'BIEN-A', bienRequis: true }])
  assert.equal(r.corps.marche.localite, 'Bagnères-de-Bigorre')
  assert.ok(!JSON.stringify(r.corps).includes('SECRET-TOULOUSE'), 'jamais un autre marche')
})

test('une garde refusee ne lit rien', async () => {
  const r = await appeler({ property_id: 'BIEN-A' }, TABLES, { ok: false })
  assert.deepEqual(r.lus, [])
})

test('la capture la plus recente de la METHODE COURANTE, ses 729 jours', async () => {
  const r = await appeler({ property_id: 'BIEN-A' }, TABLES)
  assert.equal(r.corps.etat, 'calcule')
  assert.equal(r.corps.capture_le, '2026-09-30', 'la capture d une autre methode est ignoree, meme plus recente')
  assert.equal(r.corps.jours.length, 729)
  const c = {}
  for (const j of r.corps.jours) c[j.niveau] = (c[j.niveau] || 0) + 1
  assert.deepEqual(c, { modere: 281, favorable: 151, creux: 207, pic: 90 })
})

test('LE TEST QUI COMPTE : AUCUN PRIX ne sort — ni en euros, ni en base 100, ni une composante chiffree', async () => {
  const r = await appeler({ property_id: 'BIEN-A' }, TABLES)
  const texte = JSON.stringify(r.corps)
  for (const interdit of ['prix', 'price', 'prix_base100', 'moyenne']) {
    assert.ok(!texte.includes(interdit), `« ${interdit} » ne doit pas sortir`)
  }
  // Une composante sort comme un SENS, jamais comme une valeur chiffree.
  assert.ok(!/"(saison|semaine|demande|fete|ecart_jour)":-?\d/.test(texte), 'aucune composante chiffree')
  assert.deepEqual(Object.keys(r.corps.jours[0]).sort(), ['evenement', 'jour', 'niveau', 'sens', 'week_end'])
  assert.deepEqual(Object.keys(r.corps.jours[0].sens).sort(), ['demande', 'evenement', 'saison', 'semaine'])
  for (const j of r.corps.jours) for (const v of Object.values(j.sens)) assert.ok(['haut', 'neutre', 'bas'].includes(v))
})

test('les analyses sont la : mois, week-end ou semaine, evenements, suggestions, courbe en points', async () => {
  const r = await appeler({ property_id: 'BIEN-A' }, TABLES)
  assert.equal(r.corps.mois.length, 24, 'octobre 2026 a septembre 2028')
  assert.equal(r.corps.week_end_ou_semaine.verdict, 'week_end')
  assert.ok(r.corps.evenements.some(e => e.nom === 'Noël'))
  assert.ok(r.corps.suggestions.some(s => s.type === 'saisonnier'))
  assert.ok(r.corps.courbe.every(p => typeof p.ecart === 'number' && Math.abs(p.ecart) < 50), 'des points, pas des prix')
})

test('sans lien vers un marche, ou sans capture : on le dit, sans rien inventer', async () => {
  const sansLien = await appeler({ property_id: 'BIEN-A' }, { ...TABLES, marche_biens: [] })
  assert.equal(sansLien.corps.etat, 'marche_inconnu')
  const sansCapture = await appeler({ property_id: 'BIEN-A' }, { ...TABLES, marche_temperature_airroi: [] })
  assert.equal(sansCapture.corps.etat, 'capture_absente')
  assert.match(sansCapture.corps.motif, /pas encore été établi/)
  assert.ok(!/\$|airroi|script/i.test(sansCapture.corps.motif), 'ni cout ni jargon pour l hote')
})

test('LE TEST QUI COMPTE : pipeline ETANCHE — la route ne lit que le lien et la temperature', async () => {
  const r = await appeler({ property_id: 'BIEN-A' }, TABLES)
  assert.deepEqual([...new Set(r.lus)], ['marche_biens', 'marche_temperature_airroi'])
  const src = fs.readFileSync(path.join(RACINE, 'api', 'marche-temperature.js'), 'utf8')
  assert.ok(!/airroi\/client|api\.airroi|vacances|bookings_snapshot|airroi_cache/.test(src), 'ni AirROI en direct, ni l historique')
  assert.ok(!/\.(insert|update|upsert|delete)\(/.test(src), 'aucune ecriture')
})

test('SECURITE : le marche suit le bien RESOLU par la garde, jamais l’identifiant brut de la requete', async () => {
  // La requete nomme une reference ; la garde la resout en BIEN-A.
  const r = await appeler({ property_id: 'REF-PROVIDER-42' }, TABLES, { ok: true, bien: { id: 'BIEN-A' } })
  assert.equal(r.corps.etat, 'calcule')
  assert.equal(r.corps.marche.localite, 'Bagnères-de-Bigorre')
})

test('une lecture au plafond de PostgREST (1000 lignes) se dit, au lieu de servir un calendrier tronque', async () => {
  const beaucoup = Array.from({ length: 1000 }, (_, i) => ({ ...lignesBagneres[0], jour: `X-${String(i).padStart(4, '0')}` }))
  const r = await appeler({ property_id: 'BIEN-A' }, { ...TABLES, marche_temperature_airroi: beaucoup })
  assert.equal(r.code, 503)
})
