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
//
// ⚠ ET POUR LA GARDE DE SECURITE (24 octobre 2026) : garde de cle desactivee
// dans `lib/airroi/fixture-sure.js`, hors de l'arbre — le test rougit, et la
// sortie porte `fixture ecrite : .../occupation-bagneres-*.json`. Il rougit
// AUSSI a J+60, donc l'enfant atteint reellement l'ecriture a cette date : le
// vert n'est pas vacueux. Et le code 6 n'est produit QUE par la branche
// « cle absente » de `ecrireFixtureSansCle` : `code === 6` implique donc que la
// garde a tire, donc que le cache a bien servi l'enfant.

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
  const { spawnSync } = require('child_process')
  const racine = path.join(__dirname, '..')
  const market = { country: 'France', region: 'Occitania', locality: 'Bagnères-de-Bigorre' }
  const cas = [
    { script: 'scripts/capturer-occupation-airroi.js', prefixe: 'occupation-bagneres-', endpoint: 'POST /markets/metrics/occupancy',
      params: { market, num_months: 60, currency: 'native' }, reponse: '{"results":[{"date":"2026-01-01"}]}' }
  ]
  // ⚠ LE DECALAGE D'HORLOGE NE TRAVERSE PAS `execFileSync`, ET CE TEST SEME UNE
  // CLE DE CACHE QUI DEPEND DE LA DATE. Le preexistant : ce test etait le
  // dernier rouge calendaire du depot (CLAUDE.md, « IL RESTE UN ROUGE A J+60 »,
  // cause supposee « une fixture sur disque qui ne suit pas » — ce n'etait pas
  // ça). Mesure du 23 octobre 2026 : a J+60, le test calcule la fenetre du
  // relief sur l'horloge DECALEE (1er janvier 2027) et seme le cache sur cette
  // cle, tandis que le processus ENFANT, qui ne recoit pas le prechargement,
  // calcule 2026-11-01 -> 2028-10-30 sur l'horloge reelle. Cache manque, donc le
  // script refuse de PAYER (« Rien n est paye : relancer avec --confirmer »),
  // sort en 0, et l'assertion « refus attendu (code 6) » tombe — sur un script
  // qui s'est comporte correctement. Le test et le script doivent vivre dans le
  // MEME temps.
  //
  // ⚠ ON NE PROPAGE PAS LE DECALAGE A L'ENFANT : ON LIT L'HORLOGE QU'IL LIT.
  // Premiere version de ce correctif : passer `--require horloge-decalee.js` a
  // l'enfant, sous condition `process.env.JOURS`. La review l'a mesure faux
  // dans les TROIS directions, parce que la variable d'environnement n'est qu'un
  // PROXY de « mon horloge est decalee » et que les deux sont independants :
  //   - `JOURS=60` SANS prechargement : l'enfant recevait un decalage que le
  //     parent n'avait pas. VERT avant mon correctif, ROUGE apres — une vraie
  //     regression, dont la victime est `npm test` dans un shell ou une
  //     contre-epreuve precedente a laisse `export JOURS=60`.
  //   - prechargement SANS `JOURS` : l'outil avançait le parent de dix jours par
  //     defaut et ma porte restait fermee. Le trou vise restait OUVERT.
  //   - `JOURS=abc` : truthy pour la porte, `NaN` pour l'outil. L'enfant
  //     installait une horloge invalide, donc toute entree de cache etait jugee
  //     perimee — et mon message accusait la cle, qui etait bonne.
  //
  // `performance.timeOrigin + performance.now()` rend l'heure REELLE :
  // `horloge-decalee.js` ne remplace que `globalThis.Date` et le `Date` de la
  // fenetre jsdom (verifie aussi sur la version de staging, qui ajoute
  // `HEURES`). Or l'enfant n'est JAMAIS decale, puisqu'il ne recoit aucun
  // prechargement. Les deux calculent donc la MEME fenetre quoi qu'on pose dans
  // l'environnement, et il n'y a plus de porte a tenir d'accord avec un outil
  // qui evolue.
  const maintenantReel = () => new Date(performance.timeOrigin + performance.now())
  // Le relief : meme fenetre que le script (1er du mois suivant, 730 jours).
  // ⚠ `FENETRE_JOURS` DUPLIQUE UNE REGLE QUI VIT AILLEURS : le script la
  // construit et `lib/airroi/client.js` la VALIDE (`JOURS_FACTEURS_MAX = 730`,
  // non exporte) — trois orthographes pour une regle. Thierry a borne ce lot au
  // test seul, donc on ne touche pas au client : signale au chef de file pour
  // qu'il soit numerote au registre a la prochaine ouverture du fichier. Pas de
  // numero cite ici : une reference a une dette qui n'existe pas encore serait
  // lue comme un fait, et c'est le defaut que ce lot passe sa journee a fermer.
  const FENETRE_JOURS = 730
  const { jourLocalParis } = require('../lib/yield/zones-scolaires')
  const [an, mo] = jourLocalParis(maintenantReel().toISOString()).slice(0, 7).split('-').map(Number)
  const debut = new Date(Date.UTC(an, mo, 1)).toISOString().slice(0, 10)
  const fin = new Date(Date.parse(`${debut}T00:00:00Z`)
    + (FENETRE_JOURS - 1) * 86400000).toISOString().slice(0, 10)
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
    // ⚠ `spawnSync`, PAS `execFileSync` — un seul changement ferme quatre
    // defauts releves en review : les DEUX flux reviennent toujours (en sortie 0,
    // `execFileSync` ne rendait que stdout, donc deplacer un `console.log` vers
    // `console.error` desarmait une garde en silence) ; une mort par SIGNAL ne
    // laisse plus un `status` a `null` muet ; il y a un DELAI, alors que
    // `node:test` n'en a aucun par defaut et qu'un enfant bloque figeait la
    // suite entiere sans une ligne de sortie, ni verte ni rouge ; et il n'y a
    // plus de try/catch dont la branche depend du code de sortie.
    // ⚠ Ces trois enfants ne sont PAS couverts par la promesse « AUCUN APPEL
    // REEL » de l'en-tete : ils utilisent le `fetch` global, et leur seul verrou
    // avant le reseau est `if (!cleApi)` (lib/airroi/client.js:244).
    // `--fixtures` isole l'ECRITURE : meme si le script regresse, le depot n'est
    // pas sali (re-review de 9b47690).
    const r = spawnSync(process.execPath,
      [path.join(racine, c.script), `--cache=${d}`, `--fixtures=${sortie}`],
      { env, encoding: 'utf8', timeout: 60000 })
    const code = r.status ?? `signal:${r.signal}${r.error ? ` (${r.error.code || r.error.message})` : ''}`
    const dit = String(r.stdout || '') + String(r.stderr || '')
    const queue = () => dit.trim().split('\n').slice(-3).join(' | ')

    // ⚠ LES DEUX ASSERTIONS DE SECURITE D'ABORD, ET C'EST LE CORRECTIF LE PLUS
    // IMPORTANT DE CETTE RE-ECRITURE. Ma premiere version avait place son
    // assertion de DIAGNOSTIC devant elles : mesure de la review, avec deux
    // mutations plausibles cumulees (un script qui ecrit la fixture avant
    // d'appeler `ecrireFixtureSansCle`, et une cle semee qui derive d'un
    // parametre), le seul message rendu etait « le script n a PAS ete servi par
    // le cache... donc il n a jamais atteint l ecriture de fixture » — alors que
    // le dossier de sortie contenait bel et bien une fixture ecrite SANS aucun
    // controle de cle. `assert.ok` levait, les deux lignes suivantes ne
    // tournaient jamais, et le lecteur corrigeait le semis du cache, revenait au
    // vert, et laissait la fuite. Un diagnostic de confort ne passe JAMAIS
    // devant une assertion de securite.
    assert.deepEqual(fs.readdirSync(sortie), [], `${c.script} : rien d ecrit dans le dossier de sortie`)
    assert.deepEqual(etat(c.prefixe), avant, `${c.script} : aucune fixture ecrite ni reecrite`)
    assert.equal(code, 6, `${c.script} : refus attendu (code 6). Sortie : ${queue()}`)

    // ⚠ ET LA PREUVE EST POSITIVE, PAS UNE LISTE NOIRE DE PROSE. Ce message
    // n'est imprime que par la branche « cle absente » de
    // `ecrireFixtureSansCle` : le lire prouve que l'enfant a ATTEINT l'ecriture,
    // et que c'est bien la garde de securite qui a refuse — pas un refus
    // anterieur. Ma premiere version faisait l'inverse, une regex negative sur
    // « Rien n est paye », et elle etait aveugle a `capturer-pacing.js`, qui n'a
    // aucune porte `--confirmer` et sort en 1 sur un tout autre refus.
    // ⚠ ET UNE GARDE NEGATIVE SUR « AIRROI_API_KEY absente » AURAIT MORDU SUR LE
    // CAS SAIN : les deux refus contiennent ces mots — celui du client dit
    // « absente de l environnement », celui de la garde « absente ou mal formee
    // — impossible de verifier... ». Seule la seconde moitie discrimine.
    assert.match(dit, /impossible de verifier que la reponse ne contient pas la cle/,
      `${c.script} : le refus ne vient pas de la garde de fixture. Soit l enfant n a pas ete`
      + ' servi par le cache et a refuse de payer avant d atteindre l ecriture, soit il a refuse'
      + ` plus tot encore, faute de cle. Dans les deux cas ce test ne prouve rien. Sortie : ${queue()}`)
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

// ─── §21.2 : la recherche par equipement, corps FIGE ─────────────────────────
test('§22.10 : POST /listings/search/radius — tarif 0,50 $, fraicheur 90 jours, et le corps construit par la route est valide', () => {
  const { TARIFS, FRAICHEUR_JOURS } = require('../lib/airroi/cout')
  assert.equal(TARIFS['POST /listings/search/radius'], 0.50)
  assert.equal(FRAICHEUR_JOURS['POST /listings/search/radius'], 90)
  const { corpsRechercheActifs } = require('../lib/marche/choix-comparables')
  const corps = corpsRechercheActifs({ latitude: 43.60797, longitude: 1.452579, voyageurs: 2, chambres: 1, equipements: ['spa', 'vue', 'parking'] }, 2)
  assert.deepEqual(corps, { latitude: 43.61, longitude: 1.45, radius_miles: 6.2,
    filter: { amenities: { all: ['hot_tub'], any: ['ocean_view', 'river_view', 'waterfront', 'lake_access'] }, bedrooms: { eq: 1 }, guests: { range: [1, 4] },
      room_type: { eq: 'entire_home' }, ttm_days_booked: { gte: 10 }, l90d_available_days: { gte: 1 } },
    sort: { ttm_revenue: 'desc' }, pagination: { page_size: 10, offset: 20 } })
  assert.equal(corpsRechercheActifs({ latitude: 43.6, longitude: 1.45, voyageurs: 2, chambres: 1, equipements: ['parking', 'terrasse', 'climatisation'] }), null, 'aucun equipement rare : pas de recherche')
  assert.throws(() => corpsRechercheActifs({ latitude: 43.6, longitude: 1.45, voyageurs: 2, chambres: 1, equipements: ['spa'] }, 5), /page invalide/, '50 biens au plus')
})

test('LE TEST QUI COMPTE (§22.10) : un corps de recherche hors contrat est REFUSE avant tout reseau', async () => {
  const appels = []
  const depot = { lireCache: async () => null, ecrireCache: async () => {}, reserver: async () => 1, terminer: async () => {}, appelsDepuis: async () => [] }
  const { creerClient } = require('../lib/airroi/client')
  const client = creerClient({ depot, alerter: null, fetch: async (...a) => { appels.push(a); throw new Error('reseau interdit') } })
  const { corpsRechercheActifs } = require('../lib/marche/choix-comparables')
  const bon = corpsRechercheActifs({ latitude: 43.6, longitude: 1.45, voyageurs: 2, chambres: 1, equipements: ['spa'] }, 0)
  const filtre = (k, v) => ({ ...bon, filter: { ...bon.filter, [k]: v } })
  const mauvais = [
    { ...bon, currency: 'native' },
    { ...bon, radius_miles: 50 },
    { ...bon, latitude: 43.6079 },                                     // zone non arrondie : la cle ne se partagerait pas
    { ...bon, pagination: { page_size: 100, offset: 0 } },
    { ...bon, pagination: { page_size: 10, offset: 50 } },             // 50 biens au plus
    { ...bon, sort: { ttm_avg_rate: 'desc' } },
    filtre('amenities', { any: ['wifi'] }),
    filtre('amenities', { all: [] }),
    filtre('amenities', { all: ['hot_tub'], none: ['pool'] }),
    filtre('room_type', { eq: 'private_room' }),
    filtre('ttm_days_booked', { gte: 0 }),
    filtre('bedrooms', { gte: 1 }),
    filtre('ttm_avg_rate', { gt: 100 }),
    filtre('guests', { range: [5, 2] }),
  ]
  assert.ok(Object.keys(bon).length, 'le bon corps existe')
  for (const c of mauvais) await assert.rejects(client.rechercheActifs(c, { propertyId: 'P', userId: 'U' }), /parametres invalides/)
  assert.equal(appels.length, 0)
})

// ⚠ RE-REVIEW DE 0fab219 (SECURITE) : une erreur levee APRES le depart de la
// requete n'a jamais `coutLibere === true`, meme si elle vient du cache ou du
// journal — AirROI a pu facturer, la reservation de l'appelant est gardee.
test('coutLibere : vrai seulement avant le reseau ou sur une erreur HTTP ; faux des que la requete a pu partir', async () => {
  await avecCle(async () => {
    const marque = async (client, appel) => (await appel(client).catch(e => e)).coutLibere
    const annonce = c => c.annonce('992723390568420450', H)
    const ok = () => faux(lire('moi.json'))
    // Avant le reseau : parametres, garde-fou du budget.
    assert.equal(await marque(creerClient({ alerter: null, depot: depotFichier(dossier()), fetch: ok() }), c => c.annonce('', H)), true, 'parametres invalides')
    assert.equal(await marque(creerClient({ alerter: null, depot: depotFichier(dossier()), fetch: ok(), gardes: { budgetMensuelUsd: 0.01 } }), annonce), true, 'refus du budget')
    // Reponse d'erreur du serveur : non facturee.
    assert.equal(await marque(creerClient({ alerter: null, depot: depotFichier(dossier()), fetch: faux('non', 403) }), annonce), true, 'HTTP 403')
    // La requete est partie.
    assert.equal(await marque(creerClient({ alerter: null, depot: depotFichier(dossier()), fetch: async () => { throw new Error('ECONNRESET') } }), annonce), false, 'coupure reseau')
    assert.equal(await marque(creerClient({ alerter: null, depot: depotFichier(dossier()), fetch: faux('pas du json') }), annonce), false, 'reponse illisible')
    const cachePanne = { ...depotFichier(dossier()), ecrireCache: async () => { throw new Error('cache plein') } }
    assert.equal(await marque(creerClient({ alerter: null, depot: cachePanne, fetch: ok() }), annonce), false, 'LE CAS DE LA RE-REVIEW : 200 facture, puis le cache tombe')
    const base = depotFichier(dossier())
    const journalPanne = { ...base, terminer: async () => { throw new Error('journal en panne') } }
    assert.equal(await marque(creerClient({ alerter: null, depot: journalPanne, fetch: async () => { throw new Error('ECONNRESET') } }), annonce), false, 'coupure puis journal en panne')
    assert.equal(await marque(creerClient({ alerter: null, depot: journalPanne, fetch: faux('non', 403) }), annonce), false, 'HTTP 403 dont la liberation n a pas pu etre journalisee : prudence')
  })
})

// C6 (review de f37b7da) : la forme du calendrier en ligne n'avait ete vue que
// dans l'exemple de la documentation. Vraie reponse capturee le 5 octobre 2026.
test('C6 : une VRAIE reponse du calendrier en ligne passe la forme et se range', async () => {
  await avecCle(async () => {
    const brut = lire('calendrier-live-38988457-2026-10-05.json')
    const c = creerClient({ alerter: null, depot: depotFichier(dossier()), fetch: faux(brut) })
    const r = await c.calendrierAnnonce('38988457', { propertyId: 'P', userId: 'U' })
    assert.equal(r.donnees.currency, 'EUR')
    assert.ok(r.donnees.results.length > 300)
    assert.ok(r.donnees.results.every(n => /^\d{4}-\d{2}-\d{2}$/.test(n.date) && typeof n.rate === 'number' && Number.isInteger(n.min_nights) && typeof n.available === 'boolean'))
  })
})

// §22.9 : l'erreur HTTP porte son code (404 = annonce retiree).
test('une erreur HTTP porte son code', async () => {
  await avecCle(async () => {
    const e = await creerClient({ alerter: null, depot: depotFichier(dossier()), fetch: faux('{"detail":"Not found"}', 404) }).calendrierAnnonce('1223814870412684731', { propertyId: 'P', userId: 'U' }).catch(x => x)
    assert.equal(e.http, 404)
    assert.equal(e.coutLibere, true)
  })
})

test("LE TEST QUI COMPTE (dette 91) : la fixture du pacing porte le jour de PARIS, sinon elle ecrase l archive de la veille", async () => {
  // ⚠ CE DEFAUT DETRUIT UNE DONNEE AU LIEU DE ROUGIR UN TEST, et c'est pour ça
  // que Thierry l'a passe en priorite. `capturer-pacing.js` etait le seul des
  // trois scripts de capture nommes a decouper `recupere_le` en UTC
  // (`slice(0, 10)`) quand ses deux jumeaux passent par `jourLocalParis`. Quand
  // le jour UTC est encore celui de la veille, la fixture prenait le nom de
  // l'archive de la veille, et l'ecriture finale est NUE.
  //
  // ⚠ LES INSTANTS SONT RELATIFS, ET LA PREMIERE VERSION DE CE TEST LES AVAIT
  // FIGES — defaut GRAVE releve en review. Le nom vient bien du cache, mais la
  // FRAICHEUR, elle, se juge contre l'horloge : `FRAICHEUR_JOURS` vaut 30 jours
  // pour le pacing (`lib/airroi/cout.js`). Un `recupere_le` fige au
  // 24 octobre 2026 devenait donc perime le 24 novembre, le cache etait
  // manque, et l'enfant partait SUR LE RESEAU — mesure de la review : HTTP 403
  // du vrai serveur AirROI a J+31, avec l'en-tete `x-api-key`. `npm test`
  // aurait appele une API tierce FACTUREE. C'est exactement la regle du depot
  // dans son autre moitie : dates relatives si le test lit l'horloge.
  //
  // ⚠ ET UNE CEINTURE : `--budget=0.0001`. `jugerAppel` tourne AVANT le
  // controle de cle et avant le reseau (`lib/airroi/client.js:237`), donc si le
  // cache etait manque pour une raison qu'on n'a pas prevue, l'enfant REFUSE
  // au lieu de payer. Et on l'asserte : la sortie doit dire « cache, 0 $ ».
  const { spawnSync } = require('child_process')
  const racine = path.join(__dirname, '..')
  const moiLoc = lireJson(lire('moi.json')).location_info
  const marche60 = lireJson(lire('marche-60.json')).market
  const marche = { country: marche60.country, region: marche60.region, locality: marche60.locality }
  const E_PACING = 'POST /markets/metrics/future/pacing'
  const P_PACING = { market: marche, currency: 'native' }
  const REPONSE = '{"market":{},"results":[{"date":"2026-11-01","occupancy":0.4}]}'

  // Le jour civil, calcule ICI et par un autre chemin que le module sous test.
  const jourParisDe = iso => new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' }).format(new Date(iso))
  const jourUtcDe = iso => new Date(iso).toISOString().slice(0, 10)
  const hier = new Date(Date.now() - 86400000).toISOString().slice(0, 10)

  // ⚠ ON CHERCHE LA FRONTIERE DE MINUIT, ON NE LA SUPPOSE PAS. Deux instants
  // figes a 23 h 30 et 12 h 00 UTC auraient ete, par construction, dans la
  // SAISON DU JOUR : la review a mesure que deux instants d'ete ne prouvent pas
  // « le fuseau de Paris » mais seulement « un decalage vers l'est », et que
  // deux correctifs faux restaient verts — `+2 h` puis `slice` (aucun fuseau),
  // et `Europe/London`, qui EST le defaut d'origine en hiver.
  // En encadrant minuit a UNE DEMI-HEURE pres, de part et d'autre, tout
  // correctif qui se trompe d'UNE HEURE — fuseau fige, mauvaise zone, oubli de
  // l'heure d'ete — tombe forcement du mauvais cote de l'un des deux.
  const bornes = (() => {
    for (let h = 23; h >= 20; h--) {
      const apres = `${hier}T${String(h).padStart(2, '0')}:30:00Z`
      const avant = `${hier}T${String(h - 1).padStart(2, '0')}:30:00Z`
      if (jourParisDe(apres) !== jourUtcDe(apres) && jourParisDe(avant) === jourUtcDe(avant)) {
        return { apres, avant }
      }
    }
    return null
  })()
  assert.ok(bornes,
    'frontiere de minuit introuvable entre 19 h 30 et 23 h 30 UTC : le fuseau de'
    + ' Paris aurait change de nature, et ce test ne peut plus rien prouver')
  // ⚠ CE QUE CE TEST NE VOIT PAS, ET IL FAUT LE DIRE (REVIEW.md regle 18 : une
  // mesure dit sa plage). L'encadrement attrape toute erreur d'UNE HEURE
  // RELATIVE au decalage reel de l'instant — donc `Europe/London`, un oubli de
  // l'heure d'ete, un fuseau fige du mauvais cote. Il ne peut PAS attraper un
  // decalage fige qui se trouve EGAL au decalage reel du jour : mesure du
  // 25 octobre 2026, la mutation `+ 2 h puis slice` reste verte, parce que les
  // instants tombent la veille, encore en heure d'ete, ou +2 h est la bonne
  // reponse. Elle rougira en hiver. C'est le test suivant, sur
  // `jourLocalParis` lui-meme, qui tient la regle dans les DEUX saisons avec
  // des instants figes — et il a le droit de les figer, puisqu'il injecte son
  // instant au lieu de lire l'horloge.
  const cas = [
    { recupereLe: bornes.apres, divergent: true,
      pourquoi: 'une demi-heure APRES minuit a Paris : le jour UTC est encore celui de la veille' },
    { recupereLe: bornes.avant, divergent: false,
      pourquoi: 'une demi-heure AVANT minuit a Paris : les deux jours coincident encore' }
  ]

  // Liste ET dates de modification du VRAI dossier de fixtures : une regression
  // de `--fixtures` salirait l'arbre du clone PARTAGE (reprise du test frere).
  const etatDepot = () => fs.readdirSync(FIX).filter(f => f.startsWith('pacing-bagneres-'))
    .map(f => [f, fs.statSync(path.join(FIX, f)).mtimeMs])
  const avantDepot = etatDepot()

  for (const c of cas) {
    const attendu = `pacing-bagneres-${jourParisDe(c.recupereLe)}.json`
    // ⚠ LA PREMISSE S'ASSERTE, elle ne s'annonce pas en prose (regle 19 §4) :
    // si l'instant cessait d'etre discriminant, le cas verdirait a vide.
    if (c.divergent) {
      assert.notEqual(jourUtcDe(c.recupereLe), jourParisDe(c.recupereLe),
        `l instant ${c.recupereLe} ne fait plus diverger le jour UTC du jour de Paris :`
        + ' ce cas ne prouve plus rien')
    } else {
      assert.equal(jourUtcDe(c.recupereLe), jourParisDe(c.recupereLe),
        `l instant ${c.recupereLe} devait faire coincider les deux jours`)
    }

    const d = dossier()
    const sortie = dossier()
    const semer = (endpoint, parametres, reponse) => depotFichier(d).ecrireCache({
      cle: cleCanonique(endpoint, parametres), endpoint, parametres,
      reponse, cout: 0.1, recupereLe: c.recupereLe })
    // `ecrireCache` est `async` par CONTRAT (l'autre depot l'est vraiment) :
    // l'attendre, sinon le jour ou `depotFichier` passe en asynchrone le cache
    // est VIDE quand l'enfant le lit, et l'enfant part au reseau.
    await semer('GET /markets/lookup', { lat: moiLoc.latitude, lng: moiLoc.longitude }, JSON.stringify(marche))
    await semer(E_PACING, P_PACING, REPONSE)

    const env = { ...process.env, AIRROI_API_KEY: `factice-${crypto.randomUUID()}` }
    const r = spawnSync(process.execPath,
      [path.join(racine, 'scripts/capturer-pacing.js'),
        `--cache=${d}`, `--fixtures=${sortie}`, '--budget=0.0001'],
      { env, encoding: 'utf8', timeout: 60000 })
    const dit = String(r.stdout || '') + String(r.stderr || '')
    const code = r.status ?? `signal:${r.signal}${r.error ? ` (${r.error.code || r.error.message})` : ''}`
    const queue = dit.trim().split('\n').slice(-4).join(' | ') || '(aucune sortie)'
    const ecrits = fs.readdirSync(sortie)

    // ⚠ LE NOM D'ABORD : c'est LUI que ce lot corrige. La premiere version
    // assertait le code de sortie en tete, et `capturer-pacing.js` ECRIT la
    // fixture avant de pouvoir sortir en 5 : une regression qui nommait la
    // fixture avec le jour de la veille ET sortait en 5 ne nommait jamais le
    // mauvais jour. Un diagnostic de confort ne passe jamais devant l assertion
    // qui porte le defaut.
    assert.deepEqual(ecrits, [attendu],
      `fixture(s) ${JSON.stringify(ecrits)} au lieu de [${attendu}] — ${c.pourquoi}.`
      + ` Un nom de la veille ECRASE l archive de la veille. Code ${code}. Sortie : ${queue}`)
    // Le CONTENU doit etre la reponse BRUTE du cache : le contrat du script est
    // « le texte exact d AirROI, pas un JSON re-serialise qui pourrait arrondir
    // un nombre », et c est le defaut d origine de ce fichier de tests.
    assert.equal(fs.readFileSync(path.join(sortie, attendu), 'utf8'), REPONSE,
      `${attendu} ne porte pas le texte exact de la reponse`)
    assert.equal(code, 0, `le script n a pas abouti. Sortie : ${queue}`)
    // AUCUN RESEAU : les deux etapes viennent du cache. Si l une avait appele,
    // le budget de 0,0001 $ l aurait refusee — et on le verrait ici.
    assert.match(dit, /cache, 0 \$[\s\S]*cache, 0 \$/,
      `une etape n a pas ete servie par le cache — risque d appel REEL. Sortie : ${queue}`)
  }

  assert.deepEqual(etatDepot(), avantDepot,
    'une fixture a ete ecrite ou reecrite dans le VRAI dossier du depot')
})

test("LE TEST QUI COMPTE (dette 91) : le jour de Paris se distingue de l UTC en hiver COMME en ete", () => {
  // ⚠ LES DEUX CAS DU TEST CI-DESSUS SONT, PAR CONSTRUCTION, DANS LA SAISON DU
  // JOUR — releve en review : deux instants d'ete ne prouvent pas « le fuseau de
  // Paris », seulement « un decalage vers l'est ». Deux correctifs faux
  // restaient verts : `+2 h` puis `slice` (aucun fuseau), et `Europe/London`,
  // qui EST le defaut d'origine en hiver.
  // Ici les instants sont FIGES, et c'est juste : `jourLocalParis` reçoit son
  // instant en ARGUMENT, il ne lit pas l'horloge (regle du depot, seconde
  // moitie). Bascule 2026 : heure d'ete jusqu'au 25 octobre.
  const { jourLocalParis } = require('../lib/yield/zones-scolaires')
  // ETE (UTC+2) : 23 h 30 UTC est deja le lendemain a Paris.
  assert.equal(jourLocalParis('2026-07-15T23:30:00Z'), '2026-07-16')
  assert.equal(jourLocalParis('2026-07-15T21:30:00Z'), '2026-07-15', '23 h 30 a Paris, meme jour')
  // HIVER (UTC+1) : 23 h 30 UTC est le lendemain, 22 h 30 UTC non — c'est ce
  // couple qui tue la mutation `Europe/London` et la mutation `+2 h`.
  assert.equal(jourLocalParis('2026-12-15T23:30:00Z'), '2026-12-16')
  assert.equal(jourLocalParis('2026-12-15T22:30:00Z'), '2026-12-15', '23 h 30 a Paris, meme jour')
})
