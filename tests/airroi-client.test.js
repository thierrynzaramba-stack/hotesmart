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
const assert = require('node:assert/strict')
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
const H = { horsCompte: true }   // un appel de test n'est rattache a aucun compte, et le dit

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
    const c = creerClient({ alerter: null, depot: depotFichier(d), fetch: f })
    const a = await c.metriquesAnnonce('992723390568420450', H)
    assert.equal(a.depuisCache, false)
    assert.equal(a.cout, 0.10)
    assert.equal(a.donnees.results.length, 26)
    const b = await c.metriquesAnnonce('992723390568420450', H)
    assert.equal(b.depuisCache, true)
    assert.equal(b.cout, 0)
    assert.equal(f.appels.length, 1, 'un seul appel reseau')
    // Et un nouveau client sur le meme dossier (une relance du script) : cache.
    const c2 = creerClient({ alerter: null, depot: depotFichier(d), fetch: f })
    assert.equal((await c2.metriquesAnnonce('992723390568420450', H)).depuisCache, true)
    assert.equal(f.appels.length, 1)
  })
})

test('LE TEST QUI COMPTE : sans cle, un appel reseau echoue BRUYAMMENT — un cache frais, lui, se sert', async () => {
  const d = dossier()
  const f = faux(lire('moi.json'))
  const c = creerClient({ alerter: null, depot: depotFichier(d), fetch: f })
  const avantCle = process.env.AIRROI_API_KEY
  delete process.env.AIRROI_API_KEY
  await assert.rejects(c.annonce('992723390568420450', H), /AIRROI_API_KEY absente/)
  assert.equal(f.appels.length, 0, 'rien n est parti')
  assert.ok(!fs.existsSync(path.join(d, 'appels.jsonl')), 'rien n est journalise')
  // Cache deja rempli : servi sans cle.
  await avecCle(() => c.annonce('992723390568420450', H))
  delete process.env.AIRROI_API_KEY
  assert.equal((await c.annonce('992723390568420450', H)).depuisCache, true)
  if (avantCle !== undefined) process.env.AIRROI_API_KEY = avantCle
})

test('LE TEST QUI COMPTE : la cle ne s ecrit nulle part — cache, journal, erreur', async () => {
  await avecCle(async cle => {
    const d = dossier()
    const ok = faux(lire('moi.json'))
    await creerClient({ alerter: null, depot: depotFichier(d), fetch: ok }).annonce('992723390568420450', H)
    assert.equal(ok.appels[0].init.headers['x-api-key'], cle, 'la cle part dans l en-tete, et la seulement')
    assert.ok(!ok.appels[0].url.includes(cle), 'jamais dans l URL')
    const ko = faux('{"error":"quota"}', 500)
    const c = creerClient({ alerter: null, depot: depotFichier(d), fetch: ko })
    const err = await c.metriquesAnnonce('33549601', H).catch(e => e)
    assert.match(err.message, /HTTP 500/)
    assert.ok(!err.message.includes(cle), 'jamais dans un message d erreur')
    assert.ok(!toutLeDossier(d).includes(cle), 'jamais dans le cache ni le journal')
  })
})

// ⚠ REECRIT LE 30 SEPTEMBRE 2026 (REVIEW.md regle 17) : la version du
// 24 septembre exigeait le cout PLEIN pour une erreur HTTP — elle figeait le
// defaut releve par Thierry (un 422 non facture vidait le budget).
test('une erreur HTTP est journalisee a cout NUL (non facturee) et n entre pas au cache', async () => {
  await avecCle(async () => {
    const d = dossier()
    const c = creerClient({ alerter: null, depot: depotFichier(d), fetch: faux('non', 403) })
    await assert.rejects(c.metriquesAnnonce('33549601', H), /HTTP 403/)
    const j = fs.readFileSync(path.join(d, 'appels.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(j.map(x => [x.statut, x.cout_usd, x.http]), [['erreur', 0, 403]], 'reservee avant le reseau, liberee au refus du serveur')
    const f = faux(lire('labulle-60.json'))
    await creerClient({ alerter: null, depot: depotFichier(d), fetch: f }).metriquesAnnonce('33549601', H)
    assert.equal(f.appels.length, 1, 'rien en cache : l appel repart')
  })
})

test('LE TEST QUI COMPTE : le budget refuse AVANT le reseau', async () => {
  await avecCle(async () => {
    const d = dossier()
    const f = faux(lire('marche-60.json'))
    const c = creerClient({ alerter: null, depot: depotFichier(d), fetch: f, gardes: { budgetMensuelUsd: 0.30 } })
    await c.metriquesAnnonce('1', H) .catch(() => {})
    const err = await c.metriquesMarche({ country: 'France', region: 'Occitania', locality: 'Bagnères-de-Bigorre' }, 60, H).catch(e => e)
    assert.ok(err instanceof RefusAirroi, 'refus du budget mensuel')
    assert.equal(err.motif, 'budget_mensuel')
    assert.equal(f.appels.length, 1, 'le marche (0,50 $) n est jamais parti')
  })
})

test('plafond par compte et etude par bien : refus avant le reseau', async () => {
  await avecCle(async () => {
    const d = dossier()
    const f = faux(lire('labulle-60.json'))
    const c = creerClient({ alerter: null, depot: depotFichier(d), fetch: f, gardes: { plafondCompte30jUsd: 0.15, plafondBien90jUsd: 10 } })
    await c.metriquesAnnonce('1', { userId: 'u1' })
    const e = await c.metriquesAnnonce('2', { userId: 'u1' }).catch(x => x)
    assert.equal(e.motif, 'plafond_compte')
    const c2 = creerClient({ alerter: null, depot: depotFichier(dossier()), fetch: f, gardes: { plafondBien90jUsd: 0.15 } })
    await c2.metriquesAnnonce('1', { propertyId: 'b1' })
    assert.equal((await c2.metriquesAnnonce('2', { propertyId: 'b1' }).catch(x => x)).motif, 'etude_recente')
  })
})

test('un cache perime repart ; la cle de cache ignore l ordre des parametres', async () => {
  await avecCle(async () => {
    const d = dossier()
    const f = faux(lire('moi.json'))
    let jour = new Date('2026-09-24T00:00:00Z')
    const c = creerClient({ alerter: null, depot: depotFichier(d), fetch: f, maintenant: () => jour })
    await c.annonce('1', H)
    jour = new Date('2026-12-24T00:00:00Z')   // 91 jours : au-dela des 90 de la fiche
    assert.equal((await c.annonce('1', H)).depuisCache, false)
    assert.equal(f.appels.length, 2)
  })
  assert.equal(cleCanonique('GET /x', { b: 1, a: 2 }), cleCanonique('GET /x', { a: 2, b: 1 }))
})

test('on prend a AirROI sa donnee, jamais ses prix : price-recommendation est refuse', async () => {
  const c = creerClient({ alerter: null, depot: depotFichier(dossier()), fetch: faux('{}') })
  await assert.rejects(c.appeler('POST /price-recommendation/base-price', {}), /endpoint refuse/)
})

test('LE TEST QUI COMPTE (30 septembre 2026) : calendar-prices, SEULE exception — base 100 imposee, 0,10 $, servi par le cache au deuxieme appel', async () => {
  await avecCle(async () => {
    const f = faux(JSON.stringify({ recommendations: [{ date: '2026-12-25', price: 160 }] }))
    const c = creerClient({ alerter: null, depot: depotFichier(dossier()), fetch: f })
    const p = { latitude: 43.06, longitude: 0.15, debut: '2026-10-01', fin: '2028-09-29' }
    const r = await c.reliefCalendrier(p, H)
    assert.deepEqual([r.depuisCache, r.cout], [false, 0.10])
    assert.equal(f.appels[0].url, 'https://api.airroi.com/price-recommendation/calendar-prices')
    assert.deepEqual(JSON.parse(f.appels[0].init.body),
      { location: { latitude: 43.06, longitude: 0.15 }, currency: 'EUR', base_price: 100, start_date: '2026-10-01', end_date: '2028-09-29' })
    assert.equal((await c.reliefCalendrier(p, H)).depuisCache, true)
    assert.equal(f.appels.length, 1)
  })
})

test('LE TEST QUI COMPTE (30 septembre 2026) : jamais le prix d un logement — une autre base, un champ de plus ou base-price sont refuses AVANT le reseau', async () => {
  await avecCle(async () => {
    const f = faux('{}')
    const c = creerClient({ alerter: null, depot: depotFichier(dossier()), fetch: f })
    const ok = { location: { latitude: 43.06, longitude: 0.15 }, currency: 'EUR', base_price: 100, start_date: '2026-10-01', end_date: '2028-09-29' }
    const E = 'POST /price-recommendation/calendar-prices'
    await assert.rejects(c.appeler(E, { ...ok, base_price: 135 }, H), /parametres invalides/)
    await assert.rejects(c.appeler(E, { ...ok, base_price: '100' }, H), /parametres invalides/)
    await assert.rejects(c.appeler(E, { ...ok, pricing_rules: {} }, H), /parametres invalides/)
    await assert.rejects(c.appeler(E, { ...ok, start_date: '2029-01-01' }, H), /parametres invalides/)
    await assert.rejects(c.appeler('POST /price-recommendation/base-price', { ...ok }, H), /endpoint refuse/)
    // Review de f13526c : corps fige a TOUS les niveaux, dates reelles,
    // depart au 1er d'un mois, 730 jours au plus.
    await assert.rejects(c.appeler(E, { ...ok, location: { ...ok.location, base_price: 135 } }, H), /parametres invalides/)
    await assert.rejects(c.appeler(E, { ...ok, end_date: '2026-99-99' }, H), /parametres invalides/)
    await assert.rejects(c.appeler(E, { ...ok, start_date: '2026-02-30' }, H), /parametres invalides/)
    await assert.rejects(c.appeler(E, { ...ok, start_date: '2026-10-02' }, H), /parametres invalides/)
    await assert.rejects(c.appeler(E, { ...ok, end_date: '2028-09-30' }, H), /parametres invalides/)
    assert.equal(f.appels.length, 0)
    await c.appeler(E, ok, H).catch(() => {})
    assert.equal(f.appels.length, 1, 'le corps de reference, lui, part (730 jours pile)')
  })
})

test('LE TEST QUI COMPTE (review de f13526c) : un 200 sans aucun jour date n entre PAS au cache — ni « quota », ni liste vide', async () => {
  await avecCle(async () => {
    for (const corps of ['{"message":"quota"}', '{"recommendations":[]}']) {
      const f = faux(corps)
      const d = dossier()
      const c = creerClient({ alerter: null, depot: depotFichier(d), fetch: f })
      const p = { latitude: 43.06, longitude: 0.15, debut: '2026-10-01', fin: '2028-09-29' }
      await assert.rejects(c.reliefCalendrier(p, H))
      await assert.rejects(c.reliefCalendrier(p, H))
      assert.equal(f.appels.length, 2, `${corps} : rien n a ete range, le second appel repart`)
    }
  })
})

// ─── Ajouts de la review du 24 septembre 2026 ───────────────────────────────

test('LE TEST QUI COMPTE (SECURITE) : une erreur reseau qui RECOPIE la cle ne la laisse pas sortir', async () => {
  await avecCle(async cle => {
    const d = dossier()
    const traitre = async () => { throw new Error(`Headers.append: "${cle}" is an invalid header value.`) }
    const err = await creerClient({ alerter: null, depot: depotFichier(d), fetch: traitre }).annonce('1', H).catch(e => e)
    assert.match(err.message, /reseau/)
    assert.ok(!err.message.includes(cle), 'la cle est masquee')
    assert.match(err.message, /\[clé masquée\]/)
    const j = fs.readFileSync(path.join(d, 'appels.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(j.map(x => x.statut), ['erreur'], 'l appel parti est compte, termine en erreur')
    // Et le corps d'une erreur HTTP qui la recopierait (« invalid key: … »).
    const err2 = await creerClient({ alerter: null, depot: depotFichier(dossier()), fetch: faux(`invalid key: ${cle}`, 401) }).annonce('1', H).catch(e => e)
    assert.ok(!err2.message.includes(cle))
  })
})

test('LE TEST QUI COMPTE (SECURITE) : une cle mal formee est refusee SANS etre montree, et rien ne part', async () => {
  const avant = process.env.AIRROI_API_KEY
  const cle = `fa\r\nctice-${crypto.randomUUID()}`
  process.env.AIRROI_API_KEY = cle
  try {
    const f = faux(lire('moi.json'))
    const err = await creerClient({ alerter: null, depot: depotFichier(dossier()), fetch: f }).annonce('1', H).catch(e => e)
    assert.match(err.message, /mal formee/)
    assert.ok(!err.message.includes('ctice-'), 'aucun morceau de la cle')
    assert.equal(f.appels.length, 0)
  } finally { if (avant === undefined) delete process.env.AIRROI_API_KEY; else process.env.AIRROI_API_KEY = avant }
})

test('LE TEST QUI COMPTE : une reponse 200 illisible ou vide est COMPTEE et n entre pas au cache', async () => {
  await avecCle(async () => {
    for (const corps of ['<html>passerelle</html>', '{}']) {
      const d = dossier()
      const f = faux(corps)
      const c = creerClient({ alerter: null, depot: depotFichier(d), fetch: f })
      await assert.rejects(c.annonce('1', H), /illisible|inattendue/)
      await assert.rejects(c.annonce('1', H), /illisible|inattendue/)
      assert.equal(f.appels.length, 2, 'rien en cache : chaque relance repart')
      const j = fs.readFileSync(path.join(d, 'appels.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      assert.equal(j.length, 2, 'et chaque appel paye est au journal — les garde-fous le voient')
    }
  })
})

test('LE TEST QUI COMPTE : les fenetres des garde-fous — mois civil, 30 jours, 90 jours', async () => {
  await avecCle(async () => {
    const d = dossier()
    const f = faux(lire('labulle-60.json'))
    let jour = new Date('2026-08-31T12:00:00Z')
    const c = creerClient({ alerter: null, depot: depotFichier(d), fetch: f, maintenant: () => jour,
      gardes: { budgetMensuelUsd: 0.15, plafondCompte30jUsd: 0.25, plafondBien90jUsd: 0.35 } })
    await c.metriquesAnnonce('1', { userId: 'u', propertyId: 'b' })
    jour = new Date('2026-09-01T12:00:00Z')   // nouveau mois civil : le budget du mois repart
    await c.metriquesAnnonce('2', { userId: 'u', propertyId: 'b' })
    const e = await c.metriquesAnnonce('3', { userId: 'u', propertyId: 'b' }).catch(x => x)
    assert.equal(e.motif, 'budget_mensuel', 'septembre : 0,10 deja + 0,10 > 0,15')
    jour = new Date('2026-10-02T12:00:00Z')
    const e2 = await c.metriquesAnnonce('3', { userId: 'u', propertyId: 'b' }).catch(x => x)
    assert.equal(e2 && e2.motif, undefined, '30 jours apres le premier, le plafond du compte ne compte plus l appel d aout')
    // Le bien, sur 90 jours (aout, septembre, octobre : 0,30 $) — avec un
    // budget mensuel large, pour que ce soit bien la fenetre de 90 jours qui juge.
    const c2 = creerClient({ alerter: null, depot: depotFichier(d), fetch: f, maintenant: () => jour,
      gardes: { budgetMensuelUsd: 10, plafondCompte30jUsd: 10, plafondBien90jUsd: 0.35 } })
    const e3 = await c2.metriquesAnnonce('4', { propertyId: 'b', userId: 'v' }).catch(x => x)
    assert.equal(e3.motif, 'etude_recente', 'le bien a deja 0,30 $ sur 90 jours + 0,10 > 0,35')
    jour = new Date('2026-12-01T12:00:00Z')   // l'appel d'aout est sorti des 90 jours
    const e4 = await c2.metriquesAnnonce('4', { propertyId: 'b', userId: 'v' }).catch(x => x)
    assert.equal(e4 && e4.motif, undefined, '90 jours apres, l appel d aout ne compte plus')
  })
})

test('l alarme fondateur sonne a 80 % du budget ET au refus du budget', async () => {
  await avecCle(async () => {
    const sons = []
    const c = creerClient({ alerter: async (t, d) => sons.push(t), depot: depotFichier(dossier()), fetch: faux(lire('labulle-60.json')), gardes: { budgetMensuelUsd: 0.12 } })
    await c.metriquesAnnonce('1', H)
    assert.deepEqual(sons, ['airroi_budget'], 'a 0,10 sur 0,12 : 80 % franchis')
    await c.metriquesAnnonce('2', H).catch(() => {})
    assert.deepEqual(sons, ['airroi_budget', 'airroi_budget'], 'et au refus')
  })
})

test('garde-fou invalide (NaN) = refus, pas absence de limite ; appel sans compte ni bien = refus', async () => {
  await avecCle(async () => {
    const f = faux(lire('labulle-60.json'))
    const e = await creerClient({ alerter: null, depot: depotFichier(dossier()), fetch: f, gardes: { budgetMensuelUsd: NaN } }).metriquesAnnonce('1', H).catch(x => x)
    assert.equal(e.motif, 'garde_invalide')
    await assert.rejects(creerClient({ alerter: null, depot: depotFichier(dossier()), fetch: f }).metriquesAnnonce('1'), /sans compte ni bien/)
    assert.equal(f.appels.length, 0)
  })
})

test('parametres absents ou invalides : refus AVANT tout, rien n est paye', async () => {
  const f = faux('{}')
  const c = creerClient({ alerter: null, depot: depotFichier(dossier()), fetch: f })
  await assert.rejects(c.trouverMarche(undefined, null, H), /parametres invalides/)
  await assert.rejects(c.comparables({ latitude: 43.1 }, H), /parametres invalides/)
  await assert.rejects(c.metriquesAnnonce('12a', H), /parametres invalides/)
  assert.equal(f.appels.length, 0)
})

test('deux appels identiques simultanes paient UNE fois', async () => {
  await avecCle(async () => {
    const f = faux(lire('labulle-60.json'))
    const c = creerClient({ alerter: null, depot: depotFichier(dossier()), fetch: f })
    await Promise.all(Array.from({ length: 10 }, () => c.metriquesAnnonce('1', H)))
    assert.equal(f.appels.length, 1)
  })
})

test('lireJson : echappements, negatifs, et la frontiere des 16 chiffres', () => {
  assert.deepEqual(lireJson('{"a":"x\\"1234567890123456789","b":-1234567890123456789,"c":123456789012345,"d":1234567890123456}'),
    { a: 'x"1234567890123456789', b: '-1234567890123456789', c: 123456789012345, d: '1234567890123456' })
})

test('SECURITE : masquer couvre les formes encodees de la cle (URL, JSON)', () => {
  const { masquer } = require('../lib/airroi/client')
  const cle = 'ab+c/d="e'
  const t = masquer(`brut ${cle} url ${encodeURIComponent(cle)} json ${JSON.stringify(cle)}`, cle)
  assert.ok(!t.includes(cle) && !t.includes(encodeURIComponent(cle)) && !t.includes(JSON.stringify(cle).slice(1, -1)), t)
  assert.equal(masquer('rien', ''), 'rien')
})

test('LE TEST QUI COMPTE : la marge est le plus petit reste des trois garde-fous', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'airroi-marge-'))
  const depot = depotFichier(d)
  const jour = new Date('2026-09-24T12:00:00Z')
  const client = creerClient({ alerter: null, depot, fetch: async () => { throw new Error('aucun reseau') }, maintenant: () => jour,
    gardes: { budgetMensuelUsd: 10, plafondCompte30jUsd: 4, plafondBien90jUsd: 3 } })
  assert.equal(typeof client.marge, 'function', 'le client dit ce qui reste a depenser')
  assert.equal(await client.marge({ userId: 'u', propertyId: 'b' }), 3, 'rien depense : le plafond du bien')
  const id = await depot.reserver({ endpoint: 'GET /listings', cle: 'k1', cout: 2.6, userId: 'u', propertyId: 'autre', le: jour.toISOString() })
  await depot.terminer(id, { statut: 'ok', http: 200 })
  assert.equal(await client.marge({ userId: 'u', propertyId: 'b' }), 1.4, 'le compte a depense 2,60 $ sur un autre bien : il reste 1,40 $')
  assert.equal(await client.marge({ userId: 'v', propertyId: 'c' }), 3, 'un autre compte n en paie rien')
})

test('LE TEST QUI COMPTE (30 septembre 2026, HTTP 422) : la devise se verifie AVANT l envoi — EUR part, minuscules et « native » ne partent pas', async () => {
  await avecCle(async () => {
    const f = faux('{}')
    const c = creerClient({ alerter: null, depot: depotFichier(dossier()), fetch: f })
    const ok = { location: { latitude: 43.06, longitude: 0.15 }, currency: 'EUR', base_price: 100, start_date: '2026-10-01', end_date: '2028-09-29' }
    const E = 'POST /price-recommendation/calendar-prices'
    for (const devise of ['native', 'eur', 'Eur', 'EURO', 'EU', ' EUR', '', null, ['EUR']]) {
      await assert.rejects(c.appeler(E, { ...ok, currency: devise }, H), /parametres invalides/, String(devise))
    }
    assert.equal(f.appels.length, 0, 'aucune devise mal formee n a atteint le serveur')
    await c.appeler(E, ok, H).catch(() => {})
    assert.equal(f.appels.length, 1)
    assert.equal(JSON.parse(f.appels[0].init.body).currency, 'EUR')
  })
})

test('LE TEST QUI COMPTE (30 septembre 2026) : une requete REFUSEE par le serveur libere sa reservation — le budget ne se vide pas sur des appels qui n ont pas eu lieu', async () => {
  await avecCle(async () => {
    const d = dossier()
    const c = creerClient({ alerter: null, depot: depotFichier(d), fetch: faux('{"detail":"currency must be ISO"}', 422) })
    const p = { latitude: 43.06, longitude: 0.15, debut: '2026-10-01', fin: '2028-09-29' }
    await assert.rejects(c.reliefCalendrier(p, H), /HTTP 422/)
    const journal = fs.readFileSync(path.join(d, 'appels.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.deepEqual(journal.map(l => [l.statut, l.http, l.cout_usd]), [['erreur', 422, 0]])
    assert.equal(await c.estimer([{ endpoint: 'POST /price-recommendation/calendar-prices', params: { location: { latitude: 43.06, longitude: 0.15 }, currency: 'EUR', base_price: 100, start_date: '2026-10-01', end_date: '2028-09-29' } }]), 0.1)
    // Une coupure RESEAU, elle, reste comptee (facturation inconnue).
    const d2 = dossier()
    const coupe = async () => { throw new Error('ECONNRESET') }
    const c2 = creerClient({ alerter: null, depot: depotFichier(d2), fetch: coupe })
    await assert.rejects(c2.reliefCalendrier(p, H), /reseau/)
    const j2 = fs.readFileSync(path.join(d2, 'appels.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.deepEqual(j2.map(l => [l.statut, l.cout_usd]), [['erreur', 0.1]])
  })
})

test('LE TEST QUI COMPTE (30 septembre 2026) : occupancy — corps fige (marche, mois, native), 0,10 $, cache au deuxieme appel ; tout ecart refuse AVANT le reseau', async () => {
  await avecCle(async () => {
    const f = faux(JSON.stringify({ results: [{ date: '2026-08-01', occupancy: { p50: 0.5 } }] }))
    const c = creerClient({ alerter: null, depot: depotFichier(dossier()), fetch: f })
    const market = { country: 'France', region: 'Occitania', locality: 'Bagnères-de-Bigorre' }
    const r = await c.occupationMarche(market, 60, H)
    assert.deepEqual([r.depuisCache, r.cout], [false, 0.10])
    assert.equal(f.appels[0].url, 'https://api.airroi.com/markets/metrics/occupancy')
    assert.deepEqual(JSON.parse(f.appels[0].init.body), { market, num_months: 60, currency: 'native' })
    assert.equal((await c.occupationMarche(market, 60, H)).depuisCache, true)
    const E = 'POST /markets/metrics/occupancy'
    for (const p of [{ market, num_months: 61, currency: 'native' }, { market, num_months: -1, currency: 'native' }, { market, num_months: 0.5, currency: 'native' }, { market, num_months: 60, currency: 'EUR' },
      { market, num_months: 60, currency: 'native', filter: {} }, { market: { country: 'France' }, num_months: 60, currency: 'native' },
      { market: { ...market, district: null }, num_months: 60, currency: 'native' }]) {
      await assert.rejects(c.appeler(E, p, H), /parametres invalides/)
    }
    assert.equal(f.appels.length, 1)
  })
})

test('occupancy : un 200 sans aucun tableau non vide n entre pas au cache', async () => {
  await avecCle(async () => {
    const f = faux('{"results":[]}')
    const c = creerClient({ alerter: null, depot: depotFichier(dossier()), fetch: f })
    const market = { country: 'France', region: 'Occitania', locality: 'Bagnères-de-Bigorre' }
    await assert.rejects(c.occupationMarche(market, 60, H))
    await assert.rejects(c.occupationMarche(market, 60, H))
    assert.equal(f.appels.length, 2)
  })
})

test('LE TEST QUI COMPTE (review de f40ee9e) : occupancy — un 200 d erreur ou sans point date n entre PAS au cache', async () => {
  await avecCle(async () => {
    const market = { country: 'France', region: 'Occitania', locality: 'Bagnères-de-Bigorre' }
    for (const corps of ['{"errors":["quota exceeded"]}', '{"results":[{}]}', '[[1]]', '{"error":"x","results":[{"date":"2026-01-01"}]}']) {
      const d = dossier()
      const f = faux(corps)
      const c = creerClient({ alerter: null, depot: depotFichier(d), fetch: f })
      await assert.rejects(c.occupationMarche(market, 60, H))
      await assert.rejects(c.occupationMarche(market, 60, H))
      assert.equal(f.appels.length, 2, `${corps} : rien n a ete range`)
    }
    // Un point date un niveau plus bas (forme « daily / monthly ») est accepte.
    const f = faux(JSON.stringify({ daily: { results: [{ date: '2026-01-01', occupancy: 0.4 }] } }))
    const c = creerClient({ alerter: null, depot: depotFichier(dossier()), fetch: f })
    assert.equal((await c.occupationMarche(market, 60, H)).depuisCache, false)
    assert.equal((await c.occupationMarche(market, 60, H)).depuisCache, true)
  })
})

test('LE TEST QUI COMPTE (SECURITE, review de f40ee9e) : sans cle dans l environnement, les scripts de capture n ecrivent AUCUNE fixture, meme servis par le cache', async () => {
  const { execFileSync } = require('child_process')
  const racine = path.join(__dirname, '..')
  const market = { country: 'France', region: 'Occitania', locality: 'Bagnères-de-Bigorre' }
  const cas = [
    { script: 'scripts/capturer-occupation-airroi.js', prefixe: 'occupation-bagneres-', endpoint: 'POST /markets/metrics/occupancy',
      params: { market, num_months: 60, currency: 'native' }, reponse: '{"results":[{"date":"2026-01-01"}]}' }
  ]
  // Le relief : meme fenetre que le script (1er du mois suivant, 730 jours).
  const { jourLocalParis } = require('../lib/yield/zones-scolaires')
  const [an, mo] = jourLocalParis(new Date().toISOString()).slice(0, 7).split('-').map(Number)
  const debut = new Date(Date.UTC(an, mo, 1)).toISOString().slice(0, 10)
  const fin = new Date(Date.parse(`${debut}T00:00:00Z`) + 729 * 86400000).toISOString().slice(0, 10)
  const moi = lireJson(lire('moi.json')).location_info
  cas.push({ script: 'scripts/capturer-relief-airroi.js', prefixe: 'relief-bagneres-', endpoint: 'POST /price-recommendation/calendar-prices',
    params: { location: { latitude: moi.latitude, longitude: moi.longitude }, currency: 'EUR', base_price: 100, start_date: debut, end_date: fin },
    reponse: '{"recommendations":[{"date":"2026-10-01","price":100}]}' })
  // Le pacing (script du 24 septembre, meme defaut — re-review de 9b47690) :
  // un lookup puis le pacing, tous deux servis par le cache.
  const moiLoc = lireJson(lire('moi.json')).location_info
  const marche60 = lireJson(lire('marche-60.json')).market
  const marcheP = { country: marche60.country, region: marche60.region, locality: marche60.locality }
  cas.push({ script: 'scripts/capturer-pacing.js', prefixe: 'pacing-bagneres-', endpoint: 'POST /markets/metrics/future/pacing',
    params: { market: marcheP, currency: 'native' }, reponse: '{"market":{},"results":[{"date":"2026-10-01"}]}',
    avant: { endpoint: 'GET /markets/lookup', params: { lat: moiLoc.latitude, lng: moiLoc.longitude }, reponse: JSON.stringify(marcheP) } })
  // Liste ET date de modification : une fixture du jour reecrite ne changerait
  // pas la liste.
  const etat = prefixe => fs.readdirSync(FIX).filter(f => f.startsWith(prefixe)).map(f => [f, fs.statSync(path.join(FIX, f)).mtimeMs])
  for (const c of cas) {
    const d = dossier()
    const sortie = dossier()
    for (const e of [c.avant, c].filter(Boolean)) {
      await depotFichier(d).ecrireCache({ cle: cleCanonique(e.endpoint, e.params), endpoint: e.endpoint, parametres: e.params,
        reponse: e.reponse, cout: 0.1, recupereLe: new Date().toISOString() })
    }
    const avant = etat(c.prefixe)
    const env = { ...process.env }
    delete env.AIRROI_API_KEY
    let code = 0
    // `--fixtures` isole l'ECRITURE : meme si le script regresse, le depot
    // n'est pas sali (re-review de 9b47690).
    try { execFileSync(process.execPath, [path.join(racine, c.script), `--cache=${d}`, `--fixtures=${sortie}`], { env, stdio: 'pipe' }) } catch (e) { code = e.status }
    assert.equal(code, 6, `${c.script} : refus attendu (code 6)`)
    assert.deepEqual(fs.readdirSync(sortie), [], `${c.script} : rien d ecrit dans le dossier de sortie`)
    assert.deepEqual(etat(c.prefixe), avant, `${c.script} : aucune fixture ecrite ni reecrite`)
  }
})

test('LE TEST QUI COMPTE (SECURITE) : ecrireFixtureSansCle — verifie en memoire, puis ecrit ; cle absente ou mal formee = refus', () => {
  const { ecrireFixtureSansCle } = require('../lib/airroi/fixture-sure')
  const d = dossier()
  const f = path.join(d, 'x.json')
  const cle = `factice-${crypto.randomUUID()}`
  const code = fn => { try { fn(); return 0 } catch (e) { return e.code } }
  assert.equal(code(() => ecrireFixtureSansCle('{}', f, '')), 6)
  assert.equal(code(() => ecrireFixtureSansCle('{}', f, `${cle}\n`)), 6, 'une cle avec un blanc final rendrait le controle vide')
  assert.equal(code(() => ecrireFixtureSansCle(`{"k":"${cle}"}`, f, cle)), 4)
  assert.equal(code(() => ecrireFixtureSansCle(`{"k":"${encodeURIComponent(cle)}"}`, f, cle)), 4)
  assert.equal(code(() => ecrireFixtureSansCle(`{"k":"${btoa(cle)}"}`, f, cle)), 4)
  assert.deepEqual(fs.readdirSync(d), [], 'aucun refus n a ecrit')
  assert.equal(code(() => ecrireFixtureSansCle('{"ok":1}', f, cle)), 0)
  assert.equal(fs.readFileSync(f, 'utf8'), '{"ok":1}')
})

test('occupancy : num_months = 0 est admis (contrat de l API : 0 a 60) — essai du 30 septembre 2026', async () => {
  await avecCle(async () => {
    const f = faux(JSON.stringify({ results: [{ date: '2026-08-01', p50: 0.5 }] }))
    const c = creerClient({ alerter: null, depot: depotFichier(dossier()), fetch: f })
    const market = { country: 'France', region: 'Occitania', locality: 'Bagnères-de-Bigorre' }
    await c.occupationMarche(market, 0, H)
    assert.deepEqual(JSON.parse(f.appels[0].init.body), { market, num_months: 0, currency: 'native' })
  })
})
