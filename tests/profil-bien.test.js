// tests/profil-bien.test.js — le profil du bien decrit par l'hote (etape A de
// « Choisir vos comparables », spec §20.2).
//
// CE QU'ILS EMPECHENT :
//   - plus de pieces que de chambres refuse a tort, ou l'inverse accepte ;
//   - un nombre hors bornes, un equipement inconnu ;
//   - une adresse mal geocodee acceptee (score bas, reponse illisible, panne) ;
//   - une ecriture dans une autre table que bien_profil, ou par un autre module.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const pb = require('../lib/marche/profil-bien')

const SAISIE = { adresse: '12 rue des Thermes, Bagnères-de-Bigorre', voyageurs: 2, chambres: 1, pieces: 2, salles_de_bain: 1, equipements: ['vue', 'parking'] }

test('LE TEST QUI COMPTE : un profil valide — les equipements remis dans l ordre de reference', () => {
  const r = pb.validerProfil(SAISIE)
  assert.deepEqual(r.profil, { adresse: SAISIE.adresse, voyageurs: 2, chambres: 1, pieces: 2, salles_de_bain: 1, equipements: ['parking', 'vue'] })
})

test('LE TEST QUI COMPTE : VRAIES chambres — moins de pieces que de chambres est refuse ; un studio a 0 chambre et 1 piece', () => {
  assert.match(pb.validerProfil({ ...SAISIE, chambres: 3, pieces: 2 }).erreur, /pièces ne peut pas être inférieur au nombre de chambres/)
  assert.ok(pb.validerProfil({ ...SAISIE, chambres: 0, pieces: 1 }).profil, 'un studio')
  assert.ok(pb.validerProfil({ ...SAISIE, chambres: 2, pieces: 2 }).profil)
})

test('bornes : voyageurs 1-30, chambres 0-20, pieces 1-30, salles de bain 0-10 ; un entier, pas un decimal', () => {
  for (const [cle, mauvais] of [['voyageurs', 0], ['voyageurs', 31], ['chambres', -1], ['chambres', 21], ['pieces', 0], ['salles_de_bain', 11], ['voyageurs', 2.5], ['voyageurs', 'deux'], ['voyageurs', null]]) {
    assert.ok(pb.validerProfil({ ...SAISIE, [cle]: mauvais }).erreur, `${cle}=${mauvais}`)
  }
  assert.ok(pb.validerProfil({ ...SAISIE, voyageurs: '4' }).profil, 'un nombre saisi en texte est lu')
})

test('adresse vide ou trop longue, equipement inconnu : refuses', () => {
  assert.match(pb.validerProfil({ ...SAISIE, adresse: '   ' }).erreur, /adresse/)
  assert.match(pb.validerProfil({ ...SAISIE, adresse: 'x'.repeat(201) }).erreur, /trop longue/)
  assert.match(pb.validerProfil({ ...SAISIE, equipements: ['sauna-prive'] }).erreur, /inconnu/)
})

// ─── Le geocodage, sans reseau ──────────────────────────────────────────────
const reponse = (corps, ok = true, status = 200) => async (url) => { reponse.url = url; return { ok, status, json: async () => corps } }
const BAN = { features: [{ geometry: { coordinates: [0.147612, 43.063611] }, properties: { label: '12 Rue des Thermes 65200 Bagnères-de-Bigorre', score: 0.93, type: 'housenumber' } }] }

test('LE TEST QUI COMPTE : geocodage — position, libelle trouve, score ; l URL est l API Adresse de l Etat', async () => {
  const r = await pb.geocoder('12 rue des Thermes, Bagnères', { fetch: reponse(BAN) })
  assert.deepEqual(r, { latitude: 43.063611, longitude: 0.147612, adresse_trouvee: '12 Rue des Thermes 65200 Bagnères-de-Bigorre', geocode_score: 0.93 })
  assert.match(reponse.url, /^https:\/\/api-adresse\.data\.gouv\.fr\/search\/\?q=12%20rue%20des%20Thermes%2C%20Bagn%C3%A8res&limit=1$/)
})

test('geocodage : un score sous 0,5 est une adresse introuvable ; 0,5 pile passe', async () => {
  const bas = { features: [{ ...BAN.features[0], properties: { ...BAN.features[0].properties, score: 0.49 } }] }
  assert.match((await pb.geocoder('x', { fetch: reponse(bas) })).erreur, /Adresse introuvable/)
  const pile = { features: [{ ...BAN.features[0], properties: { ...BAN.features[0].properties, score: 0.5 } }] }
  assert.equal((await pb.geocoder('x', { fetch: reponse(pile) })).geocode_score, 0.5)
})

test('geocodage : aucune reponse, reponse illisible, panne reseau, HTTP 500 — jamais une position inventee', async () => {
  assert.match((await pb.geocoder('x', { fetch: reponse({ features: [] }) })).erreur, /introuvable/)
  assert.match((await pb.geocoder('x', { fetch: reponse({ features: [{ geometry: { coordinates: ['a', 'b'] }, properties: { label: 'L', score: 0.9 } }] }) })).erreur, /introuvable/)
  assert.match((await pb.geocoder('x', { fetch: reponse(null) })).erreur, /introuvable/)
  assert.match((await pb.geocoder('x', { fetch: async () => { throw new Error('ECONNRESET') } })).erreur, /ne répond pas/)
  assert.match((await pb.geocoder('x', { fetch: reponse({}, false, 500) })).erreur, /ne répond pas/)
})

// ─── Lecture et ecriture ────────────────────────────────────────────────────
function base () {
  const ecrits = []
  return { ecrits, client: { from: (t) => ({
    upsert: async (ligne, opts) => { ecrits.push({ t, ligne, opts }); return { error: null } },
    select: () => ({ eq: () => ({ limit: async () => ({ data: [{ adresse: 'a', adresse_trouvee: 'A', latitude: '43.1', longitude: '0.1', geocode_score: '0.9', voyageurs: 2, chambres: 1, pieces: 2, salles_de_bain: 1, equipements: null }], error: null }) }) }),
  }) } }
}

test('ecriture : une ligne par bien dans bien_profil (upsert sur property_id), sans prix', async () => {
  const b = base()
  const geo = { latitude: 43.06, longitude: 0.14, adresse_trouvee: 'A', geocode_score: 0.9 }
  await pb.enregistrerProfil(b.client, { userId: 'U', propertyId: 'P', profil: pb.validerProfil(SAISIE).profil, geo })
  assert.equal(b.ecrits.length, 1)
  assert.equal(b.ecrits[0].t, 'bien_profil')
  assert.deepEqual(b.ecrits[0].opts, { onConflict: 'property_id' })
  assert.equal(b.ecrits[0].ligne.property_id, 'P')
  assert.ok(!/prix|price|rate/.test(Object.keys(b.ecrits[0].ligne).join(',')))
  await assert.rejects(pb.enregistrerProfil(b.client, { propertyId: 'P', profil: {}, geo }), /compte et bien requis/)
})

test('lecture : les nombres revenus en texte sont relus en nombres', async () => {
  const p = await pb.lireProfil(base().client, 'P')
  assert.equal(p.latitude, 43.1)
  assert.deepEqual(p.equipements, [])
})

test('LE TEST QUI COMPTE : WRITER UNIQUE — seul profil-bien.js nomme bien_profil dans lib/ et api/', () => {
  const racine = path.join(__dirname, '..')
  const fautifs = []
  for (const dossier of ['lib', 'api']) {
    const parcourir = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const c = path.join(d, f.name)
      if (f.isDirectory()) parcourir(c)
      else if (f.name.endsWith('.js') && /['"`]bien_profil['"`]/.test(fs.readFileSync(c, 'utf8')) && !c.endsWith(path.join('lib', 'marche', 'profil-bien.js'))) fautifs.push(c)
    } }
    parcourir(path.join(racine, dossier))
  }
  assert.deepEqual(fautifs, [])
})

test('la migration : lignes courtes, rejouable, RLS fermee, chambres <= pieces, equipements bornes', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '2026-10-05-bien-profil.sql'), 'utf8')
  assert.ok(sql.split('\n').every(l => l.length < 60), 'lignes courtes')
  assert.match(sql, /create table if not exists public\.bien_profil/)
  assert.match(sql, /check \(pieces >= chambres\)/)
  assert.match(sql, /enable row level security/)
  assert.match(sql, /from anon, authenticated/)
  assert.ok(!/\bselect\b/i.test(sql.replace(/--.*$/gm, '')), 'aucun select')
  for (const e of Object.keys(pb.EQUIPEMENTS)) assert.match(sql, new RegExp(`'${e}'`))
})

// ─── Constats de la review de a52b3e4 ───────────────────────────────────────
test('REVIEW (C3) : une adresse reduite a la commune est refusee — sinon le bien serait a la mairie', async () => {
  const commune = { features: [{ geometry: { coordinates: [0.149, 43.065] }, properties: { label: 'Bagnères-de-Bigorre', score: 0.95, type: 'municipality' } }] }
  assert.match((await pb.geocoder('Bagnères-de-Bigorre', { fetch: reponse(commune) })).erreur, /trop vague/)
  for (const type of ['street', 'locality']) {
    const ok = { features: [{ ...BAN.features[0], properties: { ...BAN.features[0].properties, type } }] }
    assert.ok((await pb.geocoder('x', { fetch: reponse(ok) })).latitude, type)
  }
})

test('REVIEW (C4) : un nombre en texte, des chiffres seulement — ni hexadecimal, ni exposant, ni decimal', () => {
  for (const mauvais of ['0x10', '0b11', '1e1', '4.0', ' ', '-2', '+3']) {
    assert.ok(pb.validerProfil({ ...SAISIE, voyageurs: mauvais }).erreur, mauvais)
  }
  assert.equal(pb.validerProfil({ ...SAISIE, voyageurs: ' 4 ' }).profil.voyageurs, 4)
})

test('REVIEW (mineurs) : adresse non textuelle ou trop courte, equipements non tableau, libelle non textuel', async () => {
  assert.match(pb.validerProfil({ ...SAISIE, adresse: { rue: 'x' } }).erreur, /illisible/)
  assert.match(pb.validerProfil({ ...SAISIE, adresse: 'ab' }).erreur, /trop courte/)
  assert.match(pb.validerProfil({ ...SAISIE, equipements: 'piscine' }).erreur, /illisible/)
  const label = { features: [{ ...BAN.features[0], properties: { ...BAN.features[0].properties, label: { x: 1 } } }] }
  assert.match((await pb.geocoder('x', { fetch: reponse(label) })).erreur, /introuvable/)
})

test('REVIEW : un service d adresses qui ne repond jamais est abandonne au delai', async () => {
  const jamais = (url, { signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => { const e = new Error('abort'); e.name = 'AbortError'; reject(e) }) })
  const r = await pb.geocoder('x', { fetch: jamais, delaiMs: 20 })
  assert.match(r.erreur, /ne répond pas/)
})

// ─── §22.2 : la strategie et le sejour minimum ──────────────────────────────
test('LE TEST QUI COMPTE (§22.2) : trois strategies (juste, agressif -10 %, qualite +10 %), un sejour minimum de 1 a 30 nuits', () => {
  assert.deepEqual(pb.STRATEGIES, { juste: 1, agressif: 0.9, qualite: 1.1 })
  assert.deepEqual(pb.validerStrategie({ strategie: 'agressif', sejour_min: '2' }), { strategie: 'agressif', sejour_min: 2 })
  for (const mauvais of [{ strategie: 'luxe', sejour_min: 2 }, { strategie: 'juste', sejour_min: 0 }, { strategie: 'juste', sejour_min: 31 }, { strategie: 'juste', sejour_min: '1e1' }, { strategie: 'juste' }, {}]) {
    assert.ok(pb.validerStrategie(mauvais).erreur, JSON.stringify(mauvais))
  }
})

test('§22.2 : l enregistrement n ecrit QUE la strategie et le sejour minimum, sur le profil existant ; sans profil, il le dit', async () => {
  const appels = []
  const sb = lignes => ({ from: t => ({ update: maj => ({ eq: (k, v) => ({ select: async () => { appels.push({ t, maj, k, v }); return { data: lignes, error: null } } }) }) }) })
  assert.equal(await pb.enregistrerStrategie(sb([{ property_id: 'P' }]), { propertyId: 'P', strategie: 'qualite', sejourMin: 3 }), true)
  assert.equal(appels[0].t, 'bien_profil')
  assert.deepEqual(Object.keys(appels[0].maj).sort(), ['maj_le', 'sejour_min', 'strategie'])
  assert.deepEqual([appels[0].k, appels[0].v], ['property_id', 'P'])
  assert.equal(await pb.enregistrerStrategie(sb([]), { propertyId: 'P', strategie: 'juste', sejourMin: 1 }), false)
})

test('§22.2 : la migration — deux colonnes nullables, bornees, rejouable', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '2026-10-05-bien-profil-strategie.sql'), 'utf8')
  assert.ok(sql.split('\n').every(l => l.length < 60))
  assert.match(sql, /add column if not exists strategie text\s+check \(strategie in \(\s+'juste', 'agressif', 'qualite'\)\)/)
  assert.match(sql, /add column if not exists sejour_min smallint\s+check \(sejour_min between 1 and 30\)/)
})
