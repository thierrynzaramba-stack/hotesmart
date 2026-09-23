// tests/airroi-client.test.js — le client AirROI (lot V2.1), SANS RESEAU.
//
// LES DEFAUTS QU'ILS EMPECHENT :
//   - un identifiant d'annonce arrondi en silence (992723390568420450 lu
//     992723390568420500 : une AUTRE annonce) ;
//   - un appel paye deux fois (le cache doit servir des le premier appel) ;
//   - une cle qui fuit (cache, journal, message d'erreur) ou qui manque sans
//     bruit ;
//   - un budget depasse (le refus doit tomber AVANT le reseau).
//
// ⚠ AUCUN APPEL REEL : `fetch` est injecte. Les reponses sont les fixtures
// enregistrees le 22-23 septembre (tests/fixtures/airroi). AUCUNE CLE dans ce
// fichier : la valeur factice est tiree au hasard a l'execution.
//
// CONTRE-EPREUVE (REVIEW.md regle 19) : contre `JSON.parse` a la place de
// `lireJson`, le test des identifiants rougit ; contre un client sans cache
// (lecture ignoree), « le deuxieme appel ne repaie pas » rougit ; contre un
// client qui juge le budget APRES le fetch, le test du budget rougit (fetch
// appele). Rejoue dans le scratchpad le 24 septembre 2026.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { lireJson } = require('../lib/airroi/json')
const { creerClient, cleCanonique } = require('../lib/airroi/client')
const { depotFichier } = require('../lib/airroi/depot')
const { RefusAirroi } = require('../lib/airroi/cout')

const FIX = path.join(__dirname, 'fixtures', 'airroi')
const lire = f => fs.readFileSync(path.join(FIX, f), 'utf8')
const dossier = () => fs.mkdtempSync(path.join(os.tmpdir(), 'airroi-test-'))
const MOI = lireJson(lire('moi.json'))

// Un fetch factice qui rend une fixture et compte ses appels.
function faux (texte, statut = 200) {
  const f = async (url, init) => { f.appels.push({ url, init }); return { ok: statut >= 200 && statut < 300, status: statut, text: async () => texte } }
  f.appels = []
  return f
}
function avecCle (fn) {
  const avant = process.env.AIRROI_API_KEY
  const cle = `factice-${crypto.randomUUID()}`
  process.env.AIRROI_API_KEY = cle
  return Promise.resolve(fn(cle)).finally(() => { if (avant === undefined) delete process.env.AIRROI_API_KEY; else process.env.AIRROI_API_KEY = avant })
}
const toutLeDossier = d => fs.readdirSync(d).map(f => fs.readFileSync(path.join(d, f), 'utf8')).join('\n')

test('LE TEST QUI COMPTE : un identifiant Airbnb ne perd aucun chiffre', () => {
  assert.equal(JSON.parse(lire('moi.json')).listing_info.listing_id, 992723390568420500, 'le piege : JSON.parse arrondit')
  assert.equal(MOI.listing_info.listing_id, '992723390568420450', 'lireJson garde l identifiant exact, en texte')
  const comps = lireJson(lire('comps-labulle.json')).listings.map(c => String(c.listing_id ?? c.listing_info.listing_id))
  assert.ok(comps.includes('722157446581196382'), 'Cozy nest, exact')
  // Les nombres ordinaires restent des nombres ; une chaine n'est jamais touchee.
  assert.deepEqual(lireJson('{"a":1.5,"b":12,"c":"12345678901234567890","d":1e3}'), { a: 1.5, b: 12, c: '12345678901234567890', d: 1000 })
})

test('LE TEST QUI COMPTE : le deuxieme appel ne repaie pas — le cache sert des le premier', async () => {
  await avecCle(async () => {
    const d = dossier()
    const f = faux(lire('labulle-60.json'))
    const c = creerClient({ depot: depotFichier(d), fetch: f })
    const a = await c.metriquesAnnonce('992723390568420450')
    assert.equal(a.depuisCache, false)
    assert.equal(a.cout, 0.10)
    assert.equal(a.donnees.results.length, 26)
    const b = await c.metriquesAnnonce('992723390568420450')
    assert.equal(b.depuisCache, true)
    assert.equal(b.cout, 0)
    assert.equal(f.appels.length, 1, 'un seul appel reseau')
    // Et un nouveau client sur le meme dossier (une relance du script) : cache.
    const c2 = creerClient({ depot: depotFichier(d), fetch: f })
    assert.equal((await c2.metriquesAnnonce('992723390568420450')).depuisCache, true)
    assert.equal(f.appels.length, 1)
  })
})

test('LE TEST QUI COMPTE : sans cle, un appel reseau echoue BRUYAMMENT — un cache frais, lui, se sert', async () => {
  const d = dossier()
  delete process.env.AIRROI_API_KEY
  const f = faux(lire('moi.json'))
  const c = creerClient({ depot: depotFichier(d), fetch: f })
  await assert.rejects(c.annonce('992723390568420450'), /AIRROI_API_KEY absente/)
  assert.equal(f.appels.length, 0, 'rien n est parti')
  assert.ok(!fs.existsSync(path.join(d, 'appels.jsonl')), 'rien n est journalise')
  // Cache deja rempli : servi sans cle.
  await avecCle(() => c.annonce('992723390568420450'))
  delete process.env.AIRROI_API_KEY
  assert.equal((await c.annonce('992723390568420450')).depuisCache, true)
})

test('LE TEST QUI COMPTE : la cle ne s ecrit nulle part — cache, journal, erreur', async () => {
  await avecCle(async cle => {
    const d = dossier()
    const ok = faux(lire('moi.json'))
    await creerClient({ depot: depotFichier(d), fetch: ok }).annonce('992723390568420450')
    assert.equal(ok.appels[0].init.headers['x-api-key'], cle, 'la cle part dans l en-tete, et la seulement')
    assert.ok(!ok.appels[0].url.includes(cle), 'jamais dans l URL')
    const ko = faux('{"error":"quota"}', 500)
    const c = creerClient({ depot: depotFichier(d), fetch: ko })
    const err = await c.metriquesAnnonce('33549601').catch(e => e)
    assert.match(err.message, /HTTP 500/)
    assert.ok(!err.message.includes(cle), 'jamais dans un message d erreur')
    assert.ok(!toutLeDossier(d).includes(cle), 'jamais dans le cache ni le journal')
  })
})

test('une erreur HTTP est journalisee a cout plein et n entre pas au cache', async () => {
  await avecCle(async () => {
    const d = dossier()
    const c = creerClient({ depot: depotFichier(d), fetch: faux('non', 403) })
    await assert.rejects(c.metriquesAnnonce('33549601'), /HTTP 403/)
    const j = fs.readFileSync(path.join(d, 'appels.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(j.map(x => [x.statut, x.cout_usd, x.http]), [['erreur', 0.1, 403]])
    const f = faux(lire('labulle-60.json'))
    await creerClient({ depot: depotFichier(d), fetch: f }).metriquesAnnonce('33549601')
    assert.equal(f.appels.length, 1, 'rien en cache : l appel repart')
  })
})

test('LE TEST QUI COMPTE : le budget refuse AVANT le reseau', async () => {
  await avecCle(async () => {
    const d = dossier()
    const f = faux(lire('marche-60.json'))
    const c = creerClient({ depot: depotFichier(d), fetch: f, gardes: { budgetMensuelUsd: 0.30 } })
    await c.metriquesAnnonce('1') .catch(() => {})
    const err = await c.metriquesMarche({ country: 'France', region: 'Occitania', locality: 'Bagnères-de-Bigorre' }).catch(e => e)
    assert.ok(err instanceof RefusAirroi, 'refus du budget mensuel')
    assert.equal(err.motif, 'budget_mensuel')
    assert.equal(f.appels.length, 1, 'le marche (0,50 $) n est jamais parti')
  })
})

test('plafond par compte et etude par bien : refus avant le reseau', async () => {
  await avecCle(async () => {
    const d = dossier()
    const f = faux(lire('labulle-60.json'))
    const c = creerClient({ depot: depotFichier(d), fetch: f, gardes: { plafondCompte30jUsd: 0.15, plafondBien90jUsd: 10 } })
    await c.metriquesAnnonce('1', { userId: 'u1' })
    const e = await c.metriquesAnnonce('2', { userId: 'u1' }).catch(x => x)
    assert.equal(e.motif, 'plafond_compte')
    const c2 = creerClient({ depot: depotFichier(dossier()), fetch: f, gardes: { plafondBien90jUsd: 0.15 } })
    await c2.metriquesAnnonce('1', { propertyId: 'b1' })
    assert.equal((await c2.metriquesAnnonce('2', { propertyId: 'b1' }).catch(x => x)).motif, 'etude_recente')
  })
})

test('un cache perime repart ; la cle de cache ignore l ordre des parametres', async () => {
  await avecCle(async () => {
    const d = dossier()
    const f = faux(lire('moi.json'))
    let jour = new Date('2026-09-24T00:00:00Z')
    const c = creerClient({ depot: depotFichier(d), fetch: f, maintenant: () => jour })
    await c.annonce('1')
    jour = new Date('2026-12-24T00:00:00Z')   // 91 jours : au-dela des 90 de la fiche
    assert.equal((await c.annonce('1')).depuisCache, false)
    assert.equal(f.appels.length, 2)
  })
  assert.equal(cleCanonique('GET /x', { b: 1, a: 2 }), cleCanonique('GET /x', { a: 2, b: 1 }))
})

test('on prend a AirROI sa donnee, jamais ses prix : price-recommendation est refuse', async () => {
  const c = creerClient({ depot: depotFichier(dossier()), fetch: faux('{}') })
  await assert.rejects(c.appeler('POST /price-recommendation/base-price', {}), /endpoint refuse/)
})
