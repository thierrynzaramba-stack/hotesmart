// tests/canaux-du-bien.test.js
// LE WRITER DES CANAUX : ce qu'il ecrit, ce qu'il refuse d'ecrire, et ce qu'il
// n'envoie JAMAIS au partenaire.
//
// ⚠ LES DEUX TESTS QUI COMPTENT, parce qu'ils portent les deux promesses du
// chantier :
//   · « GET seulement » — ce module lit chez le partenaire, il n'ecrit pas
//     chez lui. Aucun mapping cree, aucun canal active, aucun tarif pousse ;
//   · « un silence n'est pas une disparition » — un partenaire muet laisse la
//     derniere valeur connue en place. C'est le defaut qu'on ferme : l'ecran
//     se vidait sans un mot des que l'appel echouait.

// Le module et l'endpoint construisent un client au chargement : on leur donne
// de quoi se construire, jamais de quoi atteindre une base reelle.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'cle-de-test'
process.env.CHANNEL_BASE_URL = process.env.CHANNEL_BASE_URL || 'http://localhost:1/api/v1'
process.env.CHANNEL_API_KEY = process.env.CHANNEL_API_KEY || 'cle-de-test'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  rafraichirCanauxDuCompte, lireCanauxDuPartenaire, lignesDeLaLecture,
  tarifsDuBienDe, normaliserOta
} = require('../lib/canaux-du-bien')

const COMPTE = '11111111-1111-1111-1111-111111111111'
const BIEN_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const BIEN_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

const biens = [
  { id: BIEN_A, user_id: COMPTE, provider: 'channex',
    provider_property_id: 'P-A', provider_rate_plan_id: 'RP-A1' },
  { id: BIEN_B, user_id: COMPTE, provider: 'channex',
    provider_property_id: 'P-B', provider_rate_plan_id: 'RP-B1' }
]

// Le canal Airbnb porte LES DEUX biens, mais ne mappe qu'un tarif du bien A.
const canaux = [
  { id: 'CH-AIR', attributes: { title: 'HoteSmart — Airbnb', channel: 'AirBNB',
      is_active: true, properties: ['P-A', 'P-B'],
      rate_plans: [{ rate_plan_id: 'RP-A1' }] } },
  { id: 'CH-BOOK', attributes: { title: 'Booking.com — A', channel: 'BookingCom',
      is_active: false, properties: ['P-A'],
      rate_plans: [{ rate_plan_id: 'RP-A1' }] } }
]

// Une base simulee : on retient ce qui est ecrit, on sert ce qu'on nous donne.
function baseSimulee ({ existantes = [], liens = [], liensEnEchec = false } = {}) {
  const trace = { upserts: [], updates: [] }
  const table = (nom) => {
    const q = {
      _nom: nom, _filtres: {},
      select () { return q },
      eq (k, v) { q._filtres[k] = v; return q },
      in (k, v) { q._filtres[k] = v; return q },
      is () { return q },
      gt () { return q },
      limit () { return q },
      upsert (lignes) { trace.upserts.push({ nom, lignes }); return Promise.resolve({ error: null }) },
      update (maj) {
        const o = { maj, ids: null,
          in (_k, v) { o.ids = v; return o }, eq () { return o },
          then (res) { trace.updates.push(o); return res({ error: null }) } }
        return o
      },
      then (res) {
        if (nom === 'properties') return res({ data: biens, error: null })
        if (nom === 'property_channel_rate_plans') {
          return res(liensEnEchec ? { data: null, error: { message: 'lecture refusee' } }
                                  : { data: liens, error: null })
        }
        if (nom === 'canaux_du_bien') return res({ data: existantes, error: null })
        return res({ data: [], error: null })
      }
    }
    return q
  }
  return { from: table, trace }
}

test('LE TEST QUI COMPTE : le module n envoie QUE des GET au partenaire', async () => {
  const methodes = []
  const appel = async (m, chemin) => {
    methodes.push(String(m).toUpperCase())
    return { ok: true, status: 200, json: { data: canaux, meta: { total: canaux.length } } }
  }
  const sb = baseSimulee({ liens: [{ property_id: BIEN_A, provider_rate_plan_id: 'RP-A1' }] })
  await rafraichirCanauxDuCompte({ userId: COMPTE, sb, appel })
  assert.ok(methodes.length > 0, 'aucun appel au partenaire : le test ne prouve rien')
  assert.deepEqual([...new Set(methodes)], ['GET'],
    `le module a emis autre chose qu un GET : ${[...new Set(methodes)].join(', ')}`)
})

test('LE TEST QUI COMPTE : un silence n est pas une disparition', async () => {
  const existantes = [{ id: 'L1', property_id: BIEN_A, provider_channel_id: 'CH-AIR' }]
  const appel = async () => ({ ok: false, status: 503, json: {} })
  const sb = baseSimulee({ existantes, liens: [] })
  const bilan = await rafraichirCanauxDuCompte({ userId: COMPTE, sb, appel })
  assert.equal(bilan.ok, false)
  assert.match(bilan.erreur, /injoignable/)
  assert.equal(bilan.ecrits, 0, 'le partenaire muet a declenche une ecriture')
  assert.equal(bilan.disparus, 0, 'le partenaire muet a fait disparaitre un canal')
  assert.deepEqual(sb.trace.upserts, [], 'une ecriture est partie malgre l echec')
  assert.deepEqual(sb.trace.updates, [], 'un disparu_le a ete pose sur un silence')
})

test('un canal qu une lecture REUSSIE ne rend plus porte disparu_le', async () => {
  const existantes = [
    { id: 'L1', property_id: BIEN_A, provider_channel_id: 'CH-AIR' },
    { id: 'L-PARTI', property_id: BIEN_A, provider_channel_id: 'CH-DISPARU' }
  ]
  const appel = async () => ({ ok: true, status: 200,
    json: { data: canaux, meta: { total: canaux.length } } })
  const sb = baseSimulee({ existantes, liens: [{ property_id: BIEN_A, provider_rate_plan_id: 'RP-A1' }] })
  const bilan = await rafraichirCanauxDuCompte({ userId: COMPTE, sb, appel })
  assert.equal(bilan.ok, true)
  assert.equal(bilan.disparus, 1)
  assert.deepEqual(sb.trace.updates[0].ids, ['L-PARTI'])
  assert.ok(sb.trace.updates[0].maj.disparu_le, 'disparu_le n est pas pose')
})

test('LE TEST QUI COMPTE : un canal actif qui ne mappe pas CE bien ne le dit pas connecte', () => {
  const liensParBien = new Map([[BIEN_A, [{ property_id: BIEN_A, provider_rate_plan_id: 'RP-A1' }]]])
  const lignes = lignesDeLaLecture({
    canaux, biens, liensParBien, liensLisibles: true, maintenant: new Date() })
  const airA = lignes.find(l => l.provider_channel_id === 'CH-AIR' && l.property_id === BIEN_A)
  const airB = lignes.find(l => l.provider_channel_id === 'CH-AIR' && l.property_id === BIEN_B)
  assert.equal(airA.actif, true)
  assert.equal(airA.mappe_pour_ce_bien, true)
  // Le bien B est RATTACHE au meme canal actif, mais aucun de ses tarifs n'y
  // est mappe : c'est le defaut du 11 septembre 2026, pastille verte sur un
  // bien neuf.
  assert.equal(airB.actif, true)
  assert.equal(airB.mappe_pour_ce_bien, false)
  assert.equal(airB.mappings_pour_ce_bien, 0)
})

test('nos liens illisibles rendent null, jamais false', () => {
  const lignes = lignesDeLaLecture({
    canaux, biens, liensParBien: new Map(), liensLisibles: false, maintenant: new Date() })
  for (const l of lignes) {
    assert.equal(l.mappe_pour_ce_bien, null,
      'une lecture en echec s est lue « pas mappe »')
  }
})

test('un bien du partenaire qu on ne connait pas n entre pas dans le coeur', () => {
  const canalInconnu = [{ id: 'CH-X', attributes: { title: 'X', channel: 'AirBNB',
    is_active: true, properties: ['P-INCONNU'], rate_plans: [] } }]
  const lignes = lignesDeLaLecture({
    canaux: canalInconnu, biens, liensParBien: new Map(),
    liensLisibles: true, maintenant: new Date() })
  assert.deepEqual(lignes, [])
})

test('la lecture PAGINE, et un echec de page ne rend pas une liste vide', async () => {
  const pages = []
  const appel = async (_m, chemin) => {
    pages.push(chemin)
    const n = pages.length
    if (n === 1) return { ok: true, status: 200,
      json: { data: Array.from({ length: 50 }, (_, i) => ({ id: 'C' + i, attributes: {} })),
              meta: { total: 60 } } }
    return { ok: true, status: 200,
      json: { data: Array.from({ length: 10 }, (_, i) => ({ id: 'D' + i, attributes: {} })),
              meta: { total: 60 } } }
  }
  const r = await lireCanauxDuPartenaire({ appel })
  assert.equal(r.ok, true)
  assert.equal(r.canaux.length, 60, 'la seconde page n a pas ete lue')
  assert.equal(pages.length, 2)

  // ⚠ ET L'ECHEC NE SE DEGUISE PAS EN « AUCUN CANAL ».
  const r2 = await lireCanauxDuPartenaire({ appel: async () => ({ ok: false, status: 502, json: {} }) })
  assert.equal(r2.ok, false)
  assert.deepEqual(r2.canaux, [])
})

test('les tarifs d un bien : son tarif de base ET ses liens, une seule definition', () => {
  const s = tarifsDuBienDe({ provider_rate_plan_id: 'RP-A1' },
    [{ provider_rate_plan_id: 'RP-A2' }, { provider_rate_plan_id: 'RP-A1' }])
  assert.deepEqual([...s].sort(), ['RP-A1', 'RP-A2'])
  // La meme fonction est celle que l'endpoint utilise : pas de seconde copie.
  const endpoint = require('../api/channel-mapping')
  assert.equal(endpoint.tarifsDuBienDe, tarifsDuBienDe)
})

test('l OTA est normalise par nous, pas par l orthographe du partenaire', () => {
  assert.equal(normaliserOta('AirBNB'), 'airbnb')
  assert.equal(normaliserOta('BookingCom'), 'booking')
  assert.equal(normaliserOta('Booking.com'), 'booking')
  assert.equal(normaliserOta(null), null)
})

test('aucun compte, aucune ecriture', async () => {
  const sb = baseSimulee({})
  const bilan = await rafraichirCanauxDuCompte({ userId: null, sb, appel: async () => { throw new Error('appel interdit') } })
  assert.equal(bilan.ok, false)
  assert.match(bilan.erreur, /compte manquant/)
  assert.deepEqual(sb.trace.upserts, [])
})
