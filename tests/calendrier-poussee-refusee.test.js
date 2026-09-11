// tests/calendrier-poussee-refusee.test.js
//
// ⚠ L'INCIDENT QUE CES TESTS FERMENT — 11 septembre 2026, au soir.
//
// Thierry ouvre 50 dates sur un bien et 19 sur l'autre depuis le calendrier.
// Le coeur enregistre tout correctement : `stop_sell = false`, le prix, et
// `avail = 1`. Les PRIX partent — Channex portait bien la nouvelle grille. La
// DISPONIBILITE, non. Chez Channex les dates restaient `availability: 0` et
// `stop_sell: true` : **tarifees mais INVENDABLES**, sur les deux tarifs
// derives que Booking et Airbnb lisent.
//
// L'echec n'avait produit qu'un `pushWarnings.push('availability: HTTP ...')`,
// et le front n'affiche que `warnings[0]` — occupe, ce soir-la, par « 6 nuits
// deja vendues ». Personne n'a rien vu pendant plus de trente minutes.
//
// LA REGLE, posee par Thierry : « une erreur qui rend des dates tarifees mais
// invendables n'est pas un avertissement, c'est une panne ». Meme traitement
// que le cron qui rendait HTTP 200 en portant ses erreurs dans le corps.
//
// CE QUI EST DEFENDU ICI : que les DEUX sens crient. Un `/restrictions` refuse
// pendant qu'un `/availability` passe n'est pas plus benin — les dates
// s'ouvrent a la vente en gardant l'ANCIEN prix, c'est l'ecrasement du
// 10 septembre par une autre porte.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')

const { verdictPoussee } = require('../api/calendar.js')

const OK = { tente: true, ok: true, status: 200 }
const KO = (status) => ({ tente: true, ok: false, status })

test('availability refuse = PANNE (le cas reel du 11 septembre)', () => {
  const v = verdictPoussee({ availability: KO(422), restrictions: OK })
  assert.strictEqual(v.panne, true, 'un /availability refuse doit lever un incident')
  assert.strictEqual(v.type, 'poussee_calendrier_refusee')
  assert.match(v.message, /availability \(HTTP 422\)/)
  assert.match(v.message, /INVENDABLES/, 'la consequence doit etre nommee, pas seulement le code HTTP')
})

test('le cas INVERSE crie aussi : restrictions refuse, availability accepte', () => {
  const v = verdictPoussee({ availability: OK, restrictions: KO(500) })
  assert.strictEqual(v.panne, true,
    'des dates ouvertes a l ANCIEN prix sont une panne, pas un avertissement')
  assert.match(v.message, /restrictions \(HTTP 500\)/)
  assert.match(v.message, /ANCIEN PRIX/)
})

test('les deux refuses : les deux sont nommes', () => {
  const v = verdictPoussee({ availability: KO(429), restrictions: KO(429) })
  assert.strictEqual(v.panne, true)
  assert.strictEqual(v.echecs.length, 2)
  assert.match(v.message, /availability \(HTTP 429\) et restrictions \(HTTP 429\)/)
})

test('tout accepte : aucune panne, aucun bruit', () => {
  const v = verdictPoussee({ availability: OK, restrictions: OK })
  assert.strictEqual(v.panne, false)
  assert.deepStrictEqual(v.echecs, [])
  assert.strictEqual(v.message, null)
})

test('un appel NON TENTE n est pas un echec (mode keep, ou rien a pousser)', () => {
  // En mode « je garde mes prix », /restrictions n'est jamais appele : ce n'est
  // pas une panne, c'est un choix de l'hote, et il a deja son propre message.
  assert.strictEqual(verdictPoussee({ availability: OK }).panne, false)
  assert.strictEqual(verdictPoussee({}).panne, false)
  assert.strictEqual(verdictPoussee({ restrictions: { tente: false } }).panne, false)
})

test('la consequence distingue les trois situations', () => {
  const seulAvail = verdictPoussee({ availability: KO(500), restrictions: OK }).message
  const seulRest  = verdictPoussee({ availability: OK, restrictions: KO(500) }).message
  const lesDeux   = verdictPoussee({ availability: KO(500), restrictions: KO(500) }).message
  assert.notStrictEqual(seulAvail, seulRest, 'les deux sens ne disent pas la meme chose')
  assert.notStrictEqual(seulAvail, lesDeux)
  assert.notStrictEqual(seulRest, lesDeux)
  // Une fermeture non partie, c'est une surreservation possible : ca doit etre dit.
  assert.match(seulAvail, /surreservation/)
})

// ═══════════════════════════════════════════════════════════════════════════
// LA REACTION — et pas seulement le verdict
// ═══════════════════════════════════════════════════════════════════════════
// ⚠ LECON DU 11 SEPTEMBRE AU MATIN : une fonction pure admirablement defendue
// ne prouve rien si ce qui la CONSOMME ne l'est pas. Une review avait montre
// qu'un `for (…of…)` remplace par `[0]` laissait 8 tests verts et restaurait
// l'incident a l'identique. On tient donc aussi la reaction.

const { signalerPousseeRefusee } = require('../api/calendar.js')

function double () {
  const appels = []
  return { appels, reportIncident: async (type, opts) => { appels.push({ type, opts }) } }
}

test('un refus leve un incident FONDATEUR, avec le bien et la consequence', async () => {
  const d = double()
  const warnings = ['6 nuit(s) deja vendue(s) : leur stock n a pas ete rouvert']
  const verdict = verdictPoussee({ availability: KO(422), restrictions: OK })
  const r = await signalerPousseeRefusee(verdict, {
    warnings, userId: 'u1', propertyId: '0db6b39b', propertyName: 'La bulle',
    datesDisponibilite: 44, datesTarifs: 50
  }, d)

  assert.strictEqual(r.signale, true)
  assert.strictEqual(d.appels.length, 1, 'exactement un incident')
  assert.strictEqual(d.appels[0].type, 'poussee_calendrier_refusee')
  assert.strictEqual(d.appels[0].opts.threshold, 1, 'un seul refus suffit : pas de seuil a franchir')
  assert.strictEqual(d.appels[0].opts.propertyName, 'La bulle')
  assert.deepStrictEqual(d.appels[0].opts.detail.echecs, [{ appel: 'availability', status: 422 }])
  assert.strictEqual(d.appels[0].opts.detail.dates_disponibilite, 44)
})

test('le message de panne passe EN TETE des avertissements', async () => {
  const d = double()
  const warnings = ['6 nuit(s) deja vendue(s) : leur stock n a pas ete rouvert']
  await signalerPousseeRefusee(verdictPoussee({ availability: KO(422), restrictions: OK }), {
    warnings, userId: 'u1', propertyId: 'p', propertyName: 'La bulle'
  }, d)
  assert.match(warnings[0], /Poussee refusee par le canal/,
    "le front n'affiche que warnings[0] : c'est la panne qui doit s'y trouver, "
    + 'pas « 6 nuits deja vendues » — exactement ce qui a masque l incident du 11 septembre')
  assert.strictEqual(warnings.length, 2, "l'avertissement d'origine n'est pas perdu")
})

test('aucune panne : aucun incident, aucun avertissement ajoute', async () => {
  const d = double()
  const warnings = []
  const r = await signalerPousseeRefusee(verdictPoussee({ availability: OK, restrictions: OK }), {
    warnings, userId: 'u1', propertyId: 'p', propertyName: 'La bulle'
  }, d)
  assert.strictEqual(r.signale, false)
  assert.strictEqual(d.appels.length, 0)
  assert.deepStrictEqual(warnings, [])
})

test("une alerte qui echoue ne casse pas la sauvegarde", async () => {
  // Les lignes sont deja ecrites en base. Si l'alerte levait, l'hote recevrait
  // une erreur HTTP, croirait que rien n'est enregistre, et recommencerait.
  const warnings = []
  const r = await signalerPousseeRefusee(verdictPoussee({ availability: KO(500), restrictions: OK }), {
    warnings, userId: 'u1', propertyId: 'p', propertyName: 'La bulle'
  }, { reportIncident: async () => { throw new Error('canal fondateur injoignable') } })
  assert.strictEqual(r.signale, false)
  assert.match(r.erreur, /injoignable/)
  assert.match(warnings[0], /Poussee refusee/, "l'hote est prevenu meme si le fondateur ne l'est pas")
})

// ⚠ LE CABLAGE : que le handler appelle bien la reaction. Un test unitaire de
// `signalerPousseeRefusee` resterait vert si plus personne ne l'appelait.
test('le handler du calendrier appelle bien le verdict ET la reaction', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'api/calendar.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  assert.match(src, /const\s+verdict\s*=\s*verdictPoussee\(/, 'le verdict doit etre calcule')
  assert.match(src, /await\s+signalerPousseeRefusee\(\s*verdict\s*,/, 'et la reaction declenchee')
})

// ⚠ ET L'ECRAN. Ma premiere lecture etait FAUSSE : le front joint bien TOUS les
// avertissements (`warnings.join(' · ')`), il n'en montre pas qu'un. Le vrai
// defaut est le CADRAGE — il les prefixe « Enregistre — », un message de
// succes. Le 11 septembre, une poussee refusee se lisait donc « Enregistre »
// pendant que 69 dates restaient invendables.
test('les ecrans calendrier distinguent « non publie » de « enregistre »', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  for (const page of ['pages/biens-calendrier.html', 'pages/calendrier-mobile.html']) {
    const src = fs.readFileSync(path.join(__dirname, '..', page), 'utf8')
    // ⚠ ON COMPTE, ON NE SE CONTENTE PAS D'UNE OCCURRENCE. Releve en review :
    // `biens-calendrier.html` a DEUX points de sauvegarde (l'edition de prix en
    // ligne et la barre d'action). Un `includes` au niveau du fichier restait
    // vert si l'un des deux perdait sa branche — l'edition de prix redevenait
    // « Enregistre » sur un refus. L'invariant est : tout point qui sait
    // traiter `local_only` doit savoir traiter `push_failed`.
    const pointsDeSauvegarde = (src.match(/resp\s*(?:&&)?\s*\.?local_only/g) || []).length
      || (src.match(/resp\.local_only/g) || []).length
    const traitent = (src.match(/resp\.push_failed/g) || []).length
    assert.ok(pointsDeSauvegarde > 0, `${page} : aucun point de sauvegarde trouve`)
    assert.strictEqual(traitent, pointsDeSauvegarde,
      `${page} : ${traitent} point(s) traitent push_failed pour ${pointsDeSauvegarde} `
      + 'point(s) de sauvegarde — un refus du canal s y afficherait « Enregistre »')
    assert.match(src, /NON PUBLIE/,
      `${page} doit le DIRE, pas le noyer dans une liste d'avertissements`)
  }
})

test("l'endpoint rend le drapeau push_failed", () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'api/calendar.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  assert.match(src, /push_failed:\s*pousseeRefusee/, 'le drapeau doit sortir dans la reponse')
  assert.match(src, /if\s*\(verdict\.panne\)\s*pousseeRefusee\s*=\s*true/, 'et etre pose par le verdict')
})

// ═══════════════════════════════════════════════════════════════════════════
// LA POUSSEE, EXECUTEE — le lien entre la realite HTTP et le verdict
// ═══════════════════════════════════════════════════════════════════════════
// ⚠ RELEVE EN REVIEW : les tests ci-dessus ne touchaient jamais les deux lignes
// qui enregistrent le resultat de chaque POST. Mutation proposee — ne noter le
// resultat que dans le `else` du succes — : 13 tests verts, silence complet
// restaure. On execute donc `pousserAri` avec un double de `appel`.

const { pousserAri } = require('../api/calendar.js')

const AV = [{ date: '2026-09-15' }]
const RE = [{ date: '2026-09-15' }]
const reponse = (ok, status) => ({ ok, status, json: { data: [{ id: 'task-1' }] } })

test('un 422 sur /availability est ENREGISTRE, donc vu par le verdict', async () => {
  const c = { resultats: {}, warnings: [], taskIds: {} }
  await pousserAri({ availabilityValues: AV, restrictionValues: RE, pousserLesTarifs: true,
    appel: async (m, chemin) => reponse(chemin !== '/availability', chemin === '/availability' ? 422 : 200),
    ...c })
  assert.deepStrictEqual(c.resultats.availability, { tente: true, ok: false, status: 422 })
  assert.strictEqual(verdictPoussee(c.resultats).panne, true)
})

test('UNE COUPURE RESEAU laisse l echec pose — le cas le plus probable', async () => {
  // `channelCall` ne protege pas son `fetch` : ECONNRESET, EAI_AGAIN et les
  // timeouts LEVENT. Avant le correctif, la ligne qui note le resultat n'etait
  // jamais atteinte, `verdictPoussee({})` rendait « pas de panne », et
  // l'incident du 11 septembre se reproduisait sans la moindre alerte.
  const c = { resultats: {}, warnings: [], taskIds: {} }
  await assert.rejects(() => pousserAri({
    availabilityValues: AV, restrictionValues: RE, pousserLesTarifs: true,
    appel: async () => { throw new TypeError('fetch failed') }, ...c }))
  assert.deepStrictEqual(c.resultats.availability, { tente: true, ok: false, status: 0 },
    "l'echec doit rester pose malgre l'exception")
  assert.strictEqual(verdictPoussee(c.resultats).panne, true,
    'une coupure reseau DOIT lever un incident')
})

test('coupure reseau sur /restrictions seul : le cas inverse est vu aussi', async () => {
  const c = { resultats: {}, warnings: [], taskIds: {} }
  await assert.rejects(() => pousserAri({
    availabilityValues: AV, restrictionValues: RE, pousserLesTarifs: true,
    appel: async (m, chemin) => {
      if (chemin === '/restrictions') throw new TypeError('fetch failed')
      return reponse(true, 200)
    }, ...c }))
  assert.strictEqual(c.resultats.availability.ok, true)
  assert.deepStrictEqual(c.resultats.restrictions, { tente: true, ok: false, status: 0 })
  const v = verdictPoussee(c.resultats)
  assert.strictEqual(v.panne, true)
  assert.match(v.message, /ANCIEN PRIX/)
})

test('tout passe : aucune panne, les task_ids sont la', async () => {
  const c = { resultats: {}, warnings: [], taskIds: {} }
  const pushed = await pousserAri({ availabilityValues: AV, restrictionValues: RE,
    pousserLesTarifs: true, appel: async () => reponse(true, 200), ...c })
  assert.strictEqual(pushed, true)
  assert.strictEqual(verdictPoussee(c.resultats).panne, false)
  assert.strictEqual(c.taskIds.availability, 'task-1')
  assert.strictEqual(c.taskIds.restrictions, 'task-1')
  assert.deepStrictEqual(c.warnings, [])
})

test('mode keep : /restrictions n est pas appele, et ce n est pas une panne', async () => {
  const c = { resultats: {}, warnings: [], taskIds: {} }
  const chemins = []
  await pousserAri({ availabilityValues: AV, restrictionValues: RE, pousserLesTarifs: false,
    appel: async (m, chemin) => { chemins.push(chemin); return reponse(true, 200) }, ...c })
  assert.deepStrictEqual(chemins, ['/availability'], 'aucun tarif ne part en mode keep')
  assert.strictEqual(c.resultats.restrictions, undefined)
  assert.strictEqual(verdictPoussee(c.resultats).panne, false, 'un choix de l hote n est pas une panne')
  assert.match(c.warnings.join(' '), /je garde mes prix/, "mais l'hote est prevenu")
})

test('availability AVANT restrictions — un /availability leve le stop_sell', async () => {
  const c = { resultats: {}, warnings: [], taskIds: {} }
  const ordre = []
  await pousserAri({ availabilityValues: AV, restrictionValues: RE, pousserLesTarifs: true,
    appel: async (m, chemin) => { ordre.push(chemin); return reponse(true, 200) }, ...c })
  assert.deepStrictEqual(ordre, ['/availability', '/restrictions'],
    "l'ordre inverse posait le stop-sell puis l'effacait dans la foulee")
})

// ⚠ ET LES DEUX CHEMINS QUI PRODUISENT L'ETAT REDOUTE SANS AUCUN REFUS HTTP.
// Releve en review : une ouverture retiree par le repli « stock non verifiable »,
// ou un bien sans room_type, donnent des dates tarifees et invendables — et le
// verdict ne voyait rien puisqu'aucun POST n'avait ete refuse.
test('les deux chemins muets sont desormais traites comme des echecs', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'api/calendar.js'), 'utf8')
  const repli = src.indexOf('let retirees = 0')
  assert.ok(repli > 0)
  assert.match(src.slice(repli, repli + 1200),
    /resultats?Poussee\.availability = \{ tente: true, ok: false, status: 0 \}/,
    'une ouverture retiree faute de pouvoir verifier le stock est une poussee qui n arrive pas')
  const sansRoom = src.indexOf('datesAvail.length && !roomTypeId')
  assert.ok(sansRoom > 0, 'le cas « pas de room_type » doit etre traite explicitement')
  assert.match(src.slice(sansRoom, sansRoom + 500),
    /resultatsPoussee\.availability = \{ tente: true, ok: false, status: 0 \}/)
})
