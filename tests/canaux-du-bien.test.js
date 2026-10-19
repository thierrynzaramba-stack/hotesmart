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
  tarifsDuBienDe, normaliserOta, echecVisibleParLHote
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

// ⚠ UNE BASE SIMULEE QUI APPLIQUE REELLEMENT LES FILTRES (constat de la revue
// de 21e0794). La premiere version aiguillait sur le seul NOM de la table :
// `eq`, `in`, `is` rendaient la requete et etaient jetes. Mesure faite en
// revue : en retirant les TROIS `user_id` du writer, la suite restait a 10/10
// VERT. Le cloisonnement par compte n'etait garde par aucun test.
function baseSimulee ({ existantes = [], liens = [], liensEnEchec = false,
                        biensEnBase = null, horloges = [], biensEnEchec = false,
                        upsertEnEchec = false } = {}) {
  const trace = { upserts: [], updates: [] }
  const JEUX = {
    properties: biensEnBase || biens,
    property_channel_rate_plans: liens,
    canaux_du_bien: existantes,
    canaux_releve: horloges
  }
  const table = (nom) => {
    const filtres = []
    // ⚠ ON RETIENT LES CONDITIONS, PAS SEULEMENT LEUR EFFET. Un filtre qui
    // n'est pas pose se voit alors meme quand le resultat serait juste par
    // ailleurs — c'est la regle 1 de REVIEW.md : le filtre a CHAQUE ecriture,
    // jamais la confiance dans l'etape d'avant.
    const conditions = []
    const q = {
      select () { return q },
      eq (k, v) { conditions.push({ k, v }); filtres.push(r => String(r[k]) === String(v)); return q },
      in (k, v) { filtres.push(r => v.map(String).includes(String(r[k]))); return q },
      is (k, v) { filtres.push(r => (v === null ? r[k] == null : r[k] === v)); return q },
      gt (k, v) { filtres.push(r => r[k] != null && r[k] > v); return q },
      limit () { return q },
      // ⚠ UN UPSERT PEUT ECHOUER, ET LA CLE DE CONFLIT COMPTE (constat de la
      // RE-revue de b181192). La premiere version rendait toujours
      // `{ error: null }` et ignorait `onConflict` : la branche « ecriture
      // impossible » n'etait exercee par aucun test, et deux lignes de meme
      // cle — le defaut qui fait rejeter l'upsert ENTIER par Postgres —
      // passaient inapercues.
      upsert (lignes, opts) {
        const lot = Array.isArray(lignes) ? lignes : [lignes]
        trace.upserts.push({ nom, lignes: Array.isArray(lignes) ? lot : lignes, opts })
        const cle = (opts && opts.onConflict ? opts.onConflict : '').split(',').map(x => x.trim()).filter(Boolean)
        if (cle.length) {
          const vues = new Set()
          for (const l of lot) {
            const k = cle.map(c => String(l[c])).join('|')
            if (vues.has(k)) {
              return Promise.resolve({ error: {
                message: 'ON CONFLICT DO UPDATE command cannot affect row a second time' } })
            }
            vues.add(k)
          }
        }
        return Promise.resolve({ error: upsertEnEchec ? { message: 'ecriture refusee' } : null })
      },
      update (maj) {
        const o = { nom, maj, ids: null, filtres: [...filtres], conditions: [...conditions],
          in (_k, v) { o.ids = v; return o },
          eq (k, v) { o.conditions.push({ k, v }); o.filtres.push(r => String(r[k]) === String(v)); return o },
          then (res) { trace.updates.push(o); return res({ error: null }) } }
        return o
      },
      then (res) {
        if (nom === 'property_channel_rate_plans' && liensEnEchec) {
          return res({ data: null, error: { message: 'lecture refusee' } })
        }
        if (nom === 'properties' && biensEnEchec) {
          return res({ data: null, error: { message: 'biens refuses' } })
        }
        const lignes = (JEUX[nom] || []).filter(r => filtres.every(f => f(r)))
        return res({ data: lignes, error: null })
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
  const existantes = [{ id: 'L1', user_id: COMPTE, property_id: BIEN_A,
                        provider_channel_id: 'CH-AIR', disparu_le: null }]
  const appel = async () => ({ ok: false, status: 503, json: {} })
  const sb = baseSimulee({ existantes, liens: [] })
  const bilan = await rafraichirCanauxDuCompte({ userId: COMPTE, sb, appel })
  assert.equal(bilan.ok, false)
  assert.match(bilan.erreur, /injoignable/)
  assert.equal(bilan.ecrits, 0, 'le partenaire muet a declenche une ecriture')
  assert.equal(bilan.disparus, 0, 'le partenaire muet a fait disparaitre un canal')
  const dansLesCanaux = sb.trace.upserts.filter(u => u.nom === 'canaux_du_bien')
  assert.deepEqual(dansLesCanaux, [], 'une ecriture de canal est partie malgre l echec')
  assert.deepEqual(sb.trace.updates, [], 'un disparu_le a ete pose sur un silence')
  // ⚠ MAIS L'HORLOGE, ELLE, EST POSEE — sinon le partenaire en panne se fait
  // marteler a chaque cycle (constat de la revue de 21e0794).
  const horloge = sb.trace.upserts.find(u => u.nom === 'canaux_releve')
  assert.ok(horloge, 'aucune horloge posee : le compte sera repris au cycle suivant')
  assert.equal(horloge.lignes.ok, false)
  assert.equal(horloge.lignes.vu_le, undefined, 'vu_le a bouge sur un echec')
})

test('un canal qu une lecture REUSSIE ne rend plus porte disparu_le', async () => {
  const existantes = [
    { id: 'L1', user_id: COMPTE, property_id: BIEN_A,
      provider_channel_id: 'CH-AIR', disparu_le: null },
    { id: 'L-PARTI', user_id: COMPTE, property_id: BIEN_A,
      provider_channel_id: 'CH-DISPARU', disparu_le: null },
    // ⚠ LA LIGNE D'UN AUTRE COMPTE. Si le writer cessait de filtrer par
    // `user_id`, elle serait vue comme « disparue » et marquee — une ecriture
    // sur le bien de quelqu'un d'autre.
    { id: 'L-AUTRUI', user_id: '99999999-9999-9999-9999-999999999999',
      property_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      provider_channel_id: 'CH-AUTRUI', disparu_le: null }
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

// ─── Les tests nes de la revue de 21e0794 ───────────────────────────────────

test('LE TEST QUI COMPTE : une page courte avec un `total` plus grand n est PAS la fin', async () => {
  // Le partenaire plafonne sa propre `limit` : on demande 50, il rend 10, et
  // il en existe 12. C'etait le constat BLOQUANT : la lecture se declarait
  // reussie avec 10 canaux, et les 2 manquants se faisaient poser `disparu_le`.
  let page = 0
  const appel = async () => {
    page++
    const reste = page === 1 ? 10 : 2
    return { ok: true, status: 200,
      json: { data: Array.from({ length: reste }, (_, i) => ({ id: `C${page}-${i}`, attributes: {} })),
              meta: { total: 12 } } }
  }
  const r = await lireCanauxDuPartenaire({ appel })
  assert.equal(r.ok, true)
  assert.equal(r.canaux.length, 12, 'la lecture s est arretee sur une page courte')
  assert.equal(page, 2)
})

test('le plafond de pages ne rend JAMAIS une liste qu on sait tronquee', async () => {
  const appel = async () => ({ ok: true, status: 200,
    json: { data: Array.from({ length: 50 }, (_, i) => ({ id: 'X' + i, attributes: {} })),
            meta: { total: 100000 } } })
  const r = await lireCanauxDuPartenaire({ appel })
  assert.equal(r.ok, false, 'une lecture plafonnee s est declaree reussie')
  assert.deepEqual(r.canaux, [])
})

test('LE TEST QUI COMPTE : les canaux d un autre compte ne sont jamais touches', async () => {
  const existantes = [
    { id: 'L-MIEN', user_id: COMPTE, property_id: BIEN_A,
      provider_channel_id: 'CH-PARTI', disparu_le: null },
    { id: 'L-AUTRUI', user_id: '99999999-9999-9999-9999-999999999999',
      property_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      provider_channel_id: 'CH-AUTRUI', disparu_le: null }
  ]
  // ⚠ UNE ANNONCE DEJA VUE, CONCORDANTE. Depuis le disjoncteur du 19 octobre,
  // une premiere annonce de disparition TOTALE n'efface rien : elle est notee et
  // attend une seconde lecture. Ce test juge le filtre de l'effacement, pas le
  // disjoncteur — on le place donc dans l'etat ou l'effacement est legitime.
  // Date RELATIVE : ce test lit l'horloge, il n'injecte pas `maintenant`.
  const dejaVue = [{ user_id: COMPTE, ok: true, echecs_consecutifs: 0,
                     disparition_totale_vue_le: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
                     disparition_totale_nb: 1 }]
  const appel = async () => ({ ok: true, status: 200, json: { data: [], meta: { total: 0 } } })
  const sb = baseSimulee({ existantes, liens: [], horloges: dejaVue })
  await rafraichirCanauxDuCompte({ userId: COMPTE, sb, appel })
  const maj = sb.trace.updates.filter(u => u.nom === 'canaux_du_bien')
  assert.equal(maj.length, 1)
  assert.deepEqual(maj[0].ids, ['L-MIEN'],
    'une ligne d un autre compte a ete marquee disparue')
})

test('un identifiant de bien repete chez le partenaire ne fait pas une ligne en double', () => {
  const canalDouble = [{ id: 'CH-DBL', attributes: { title: 'T', channel: 'AirBNB',
    is_active: true, properties: ['P-A', 'P-A', 'P-A'], rate_plans: [] } }]
  const lignes = lignesDeLaLecture({
    canaux: canalDouble, biens, liensParBien: new Map(),
    liensLisibles: true, maintenant: new Date() })
  // Deux lignes de meme cle de conflit font rejeter l'upsert ENTIER par
  // Postgres, donc zero canal ecrit et un echec qui se repete a chaque cycle.
  assert.equal(lignes.length, 1)
  const cles = lignes.map(l => `${l.property_id}|${l.provider_channel_id}`)
  assert.equal(new Set(cles).size, cles.length)
})

test('l horloge tient la cadence, meme pour un compte sans aucun canal', async () => {
  const { comptesARelever } = require('../lib/canaux-du-bien')
  const maintenant = new Date('2026-10-19T12:00:00Z')
  const ilYaDixMinutes = new Date('2026-10-19T11:50:00Z').toISOString()
  // Le compte a ete tente il y a dix minutes et n'a AUCUN canal : sans
  // horloge, il repassait a chaque cycle de cinq minutes.
  const sb = baseSimulee({ horloges: [{ user_id: COMPTE, tente_le: ilYaDixMinutes }] })
  assert.deepEqual(await comptesARelever({ maintenant, sb }), [])
  // Deux heures plus tard, il est de nouveau du.
  const sb2 = baseSimulee({ horloges: [{ user_id: COMPTE, tente_le: ilYaDixMinutes }] })
  assert.deepEqual(
    await comptesARelever({ maintenant: new Date('2026-10-19T14:00:00Z'), sb: sb2 }),
    [COMPTE])
})

test('une relecture en echec ne se declare pas reussie', async () => {
  const appel = async () => ({ ok: true, status: 200,
    json: { data: canaux, meta: { total: canaux.length } } })
  const sb = baseSimulee({ liens: [{ property_id: BIEN_A, provider_rate_plan_id: 'RP-A1' }] })
  // On casse la RELECTURE de `canaux_du_bien`, celle qui suit l'upsert.
  const vraiFrom = sb.from
  let dejaEcrit = false
  sb.from = (nom) => {
    const q = vraiFrom(nom)
    if (nom !== 'canaux_du_bien') return q
    const ancienUpsert = q.upsert
    q.upsert = (l) => { dejaEcrit = true; return ancienUpsert(l) }
    const ancienThen = q.then
    q.then = (res) => dejaEcrit
      ? res({ data: null, error: { message: 'relecture refusee' } })
      : ancienThen(res)
    return q
  }
  const bilan = await rafraichirCanauxDuCompte({ userId: COMPTE, sb, appel })
  assert.equal(bilan.ok, false, 'une relecture en echec a ete comptee comme un succes')
  assert.equal(bilan.partiel, true)
  assert.match(bilan.erreur, /relecture impossible/)
})

test('LE TEST QUI COMPTE : l ecriture des disparitions porte son filtre de compte', async () => {
  // ⚠ CE TEST NE JUGE PAS LE RESULTAT, IL JUGE LA REQUETE. La relecture etant
  // deja filtree par compte, retirer le `user_id` de cet `update` ne changeait
  // RIEN au resultat — et aucune mutation ne mordait (constat de la revue de
  // 21e0794). Mais une garde qui tient par ricochet ne tient pas : le jour ou
  // la relecture change, l'ecriture part sans borne. REVIEW.md regle 1.
  const existantes = [
    { id: 'L-PARTI', user_id: COMPTE, property_id: BIEN_A,
      provider_channel_id: 'CH-PARTI', disparu_le: null }
  ]
  // ⚠ UNE ANNONCE DEJA VUE, CONCORDANTE. Depuis le disjoncteur du 19 octobre,
  // une premiere annonce de disparition TOTALE n'efface rien : elle est notee et
  // attend une seconde lecture. Ce test juge le filtre de l'effacement, pas le
  // disjoncteur — on le place donc dans l'etat ou l'effacement est legitime.
  // Date RELATIVE : ce test lit l'horloge, il n'injecte pas `maintenant`.
  const dejaVue = [{ user_id: COMPTE, ok: true, echecs_consecutifs: 0,
                     disparition_totale_vue_le: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
                     disparition_totale_nb: 1 }]
  const appel = async () => ({ ok: true, status: 200, json: { data: [], meta: { total: 0 } } })
  const sb = baseSimulee({ existantes, liens: [], horloges: dejaVue })
  await rafraichirCanauxDuCompte({ userId: COMPTE, sb, appel })
  const maj = sb.trace.updates.find(u => u.nom === 'canaux_du_bien')
  assert.ok(maj, 'aucune disparition ecrite')
  assert.ok(maj.conditions.some(c => c.k === 'user_id' && String(c.v) === COMPTE),
    'l update des disparitions ne porte pas de filtre user_id')
})

// ─── Les tests nes de la RE-revue de b181192 ────────────────────────────────

test('LE TEST QUI COMPTE : un `total` annonce SEULEMENT page 1 est retenu', async () => {
  // Le partenaire plafonne sa `limit` a 10 et ne met `meta.total` que sur la
  // premiere page. Relu a chaque tour, il redevenait indefini page 2, et la
  // regle « page courte sans total » concluait a la fin de liste : 20 canaux
  // lus sur 25, et cinq disparitions ecrites.
  let page = 0
  const appel = async () => {
    page++
    const n = page <= 2 ? 10 : 5
    return { ok: true, status: 200,
      json: { data: Array.from({ length: n }, (_, i) => ({ id: `C${page}-${i}`, attributes: {} })),
              meta: page === 1 ? { total: 25 } : {} } }
  }
  const r = await lireCanauxDuPartenaire({ appel })
  assert.equal(r.ok, true)
  assert.equal(r.canaux.length, 25, `lecture tronquee a ${r.canaux.length} sur 25`)
})

test('LE TEST QUI COMPTE : un flux qui s arrete SOUS le total annonce est refuse', async () => {
  let page = 0
  const appel = async () => {
    page++
    return { ok: true, status: 200,
      json: { data: page === 1 ? Array.from({ length: 10 }, (_, i) => ({ id: 'C' + i, attributes: {} })) : [],
              meta: { total: 12 } } }
  }
  const r = await lireCanauxDuPartenaire({ appel })
  assert.equal(r.ok, false, 'une lecture interrompue s est declaree reussie')
  assert.equal(r.motif, 'tronquee')
  assert.deepEqual(r.canaux, [])
})

test('le meme canal rendu deux fois ne fait pas rejeter tout l upsert', async () => {
  const appel = async () => ({ ok: true, status: 200,
    json: { data: [canaux[0], canaux[0]], meta: { total: 2 } } })
  const sb = baseSimulee({ liens: [{ property_id: BIEN_A, provider_rate_plan_id: 'RP-A1' }] })
  const bilan = await rafraichirCanauxDuCompte({ userId: COMPTE, sb, appel })
  assert.equal(bilan.erreur, null, `l upsert a ete rejete : ${bilan.erreur}`)
  const ecriture = sb.trace.upserts.find(u => u.nom === 'canaux_du_bien')
  const cles = ecriture.lignes.map(l => `${l.user_id}|${l.property_id}|${l.provider_channel_id}`)
  assert.equal(new Set(cles).size, cles.length, 'deux lignes de meme cle de conflit')
})

test('LE TEST QUI COMPTE : une panne de NOTRE base ne suspend pas le releve une heure', async () => {
  const sb = baseSimulee({ biensEnEchec: true })
  const bilan = await rafraichirCanauxDuCompte({
    userId: COMPTE, sb, appel: async () => { throw new Error('appel interdit') } })
  assert.equal(bilan.ok, false)
  assert.equal(bilan.aParle, false)
  const horloge = sb.trace.upserts.find(u => u.nom === 'canaux_releve')
  assert.equal(horloge, undefined,
    'l horloge a ete posee alors qu on n a jamais parle au partenaire')
})

test('un releve partiel avance quand meme vu_le : l ecran ne ment pas sur sa fraicheur', async () => {
  const appel = async () => ({ ok: true, status: 200,
    json: { data: canaux, meta: { total: canaux.length } } })
  const sb = baseSimulee({ liens: [{ property_id: BIEN_A, provider_rate_plan_id: 'RP-A1' }] })
  const vraiFrom = sb.from
  let dejaEcrit = false
  sb.from = (nom) => {
    const q = vraiFrom(nom)
    if (nom !== 'canaux_du_bien') return q
    const ancienUpsert = q.upsert
    q.upsert = (l, o) => { dejaEcrit = true; return ancienUpsert(l, o) }
    const ancienThen = q.then
    q.then = (res) => dejaEcrit
      ? res({ data: null, error: { message: 'relecture refusee' } })
      : ancienThen(res)
    return q
  }
  const bilan = await rafraichirCanauxDuCompte({ userId: COMPTE, sb, appel })
  assert.equal(bilan.partiel, true)
  assert.ok(bilan.ecrits > 0)
  const horloge = sb.trace.upserts.find(u => u.nom === 'canaux_releve')
  assert.ok(horloge.lignes.vu_le, 'vu_le est reste en arriere alors que les canaux sont a jour')
})

test('LE TEST QUI COMPTE : l horloge ne porte jamais un message de base brut', async () => {
  const appel = async () => ({ ok: false, status: 503, json: {} })
  const sb = baseSimulee({})
  await rafraichirCanauxDuCompte({ userId: COMPTE, sb, appel })
  const horloge = sb.trace.upserts.find(u => u.nom === 'canaux_releve')
  assert.ok(horloge, 'aucune horloge posee')
  // La colonne est lisible par tout collaborateur ayant `reservations` en
  // lecture : elle ne doit porter qu'un motif normalise, jamais un message
  // Supabase entier (noms de contraintes, de colonnes, details du moteur).
  assert.match(String(horloge.lignes.erreur), /^(injoignable|tronquee|plafonnee|ecriture|echec)$/)
})

test('la lecture des horloges est BORNEE, jamais tronquee en silence', async () => {
  const { comptesARelever } = require('../lib/canaux-du-bien')
  const conditions = []
  const sb = baseSimulee({ horloges: [] })
  const vraiFrom = sb.from
  sb.from = (nom) => {
    const q = vraiFrom(nom)
    if (nom !== 'canaux_releve') return q
    const ancienIn = q.in
    const ancienLimit = q.limit
    q.in = (k, v) => { conditions.push({ quoi: 'in', k, n: v.length }); return ancienIn(k, v) }
    q.limit = (n) => { conditions.push({ quoi: 'limit', n }); return ancienLimit(n) }
    return q
  }
  await comptesARelever({ maintenant: new Date(), sb })
  assert.ok(conditions.some(c => c.quoi === 'in' && c.k === 'user_id'),
    'les horloges sont lues sans borne sur les comptes connus')
  assert.ok(conditions.some(c => c.quoi === 'limit'),
    'aucune limite explicite : PostgREST tronquera a 1000 sans lever')
})

// ─── UN ECHEC SE VOIT (demande de Thierry, 19 octobre 2026) ────────────────
//
// ⚠ POURQUOI CES TROIS TESTS. Pendant la recette du 19 octobre, un releve a
// echoue et PERSONNE n'a pu le savoir : `shared/logger.js` n'ecrit dans la
// console que sur localhost, l'ecran se contentait de remettre « Reessayer »,
// et l'horloge ne distinguait pas un compte vide d'un partenaire qui repond de
// travers. Une heure de diagnostic pour une panne qui aurait du se lire d'un
// coup d'oeil.

test('LE TEST QUI COMPTE : un 200 sans JSON n est PAS un compte sans canal', async () => {
  // ⚠ LE PIEGE DEJA PAYE SUR CET ENVIRONNEMENT. Une URL de partenaire mal
  // reglee (sans `/api/v1`) rend 200 + une page HTML. `channelCall` la range
  // en `{ raw: '<html>…' }` et garde `ok: true` ; la lecture y voyait zero
  // canal, et le writer ecrivait `disparu_le` sur TOUT le compte.
  const existantes = [{ id: 'L1', user_id: COMPTE, property_id: BIEN_A,
                        provider_channel_id: 'CH-AIR', disparu_le: null }]
  const appel = async () => ({ ok: true, status: 200,
                               json: { raw: '<!DOCTYPE html><html>erreur</html>' } })
  const sb = baseSimulee({ existantes, liens: [] })
  const bilan = await rafraichirCanauxDuCompte({ userId: COMPTE, sb, appel })
  assert.equal(bilan.ok, false, 'une page HTML a ete lue comme une reponse valide')
  assert.equal(bilan.motif, 'reponse_invalide')
  assert.equal(bilan.disparus, 0, 'une reponse illisible a fait disparaitre un canal')
  assert.deepEqual(sb.trace.updates, [], 'un disparu_le a ete pose sur une reponse illisible')
})

test('LE TEST QUI COMPTE : un partenaire qui ne repond jamais est borne dans le temps', async () => {
  // ⚠ `channelCall` n'a AUCUN delai d'expiration. Un partenaire qui accepte la
  // connexion puis se tait bloquait le releve — et avec lui la fonction entiere.
  const existantes = [{ id: 'L1', user_id: COMPTE, property_id: BIEN_A,
                        provider_channel_id: 'CH-AIR', disparu_le: null }]
  const appel = () => new Promise(r => setTimeout(
    () => r({ ok: true, status: 200, json: { data: [], meta: { total: 0 } } }), 3000))
  const sb = baseSimulee({ existantes, liens: [] })
  const t0 = Date.now()
  const bilan = await rafraichirCanauxDuCompte({ userId: COMPTE, sb, appel, delaiMs: 120 })
  const ecoule = Date.now() - t0
  assert.ok(ecoule < 1500, `le releve a attendu ${ecoule} ms malgre un delai de 120 ms`)
  assert.equal(bilan.ok, false)
  assert.equal(bilan.motif, 'delai')
  assert.equal(bilan.disparus, 0, 'un delai depasse a fait disparaitre un canal')
})

test('LE TEST QUI COMPTE : des echecs qui durent plus de 24 h reveillent le fondateur', async () => {
  // ⚠ UN `console.error` NE REVEILLE PERSONNE. Un releve en panne depuis la
  // veille est invisible : les pastilles restent (c'est voulu), la mention
  // vieillit doucement, et rien ne sonne. On compte les echecs CONSECUTIFS et
  // on retient la date du premier.
  const maintenant = new Date('2026-10-20T12:00:00Z')
  const horloges = [{ user_id: COMPTE, ok: false, erreur: 'injoignable',
                      echecs_consecutifs: 11,
                      premier_echec_le: '2026-10-19T09:00:00Z',
                      tente_le: '2026-10-20T11:00:00Z' }]
  const appel = async () => ({ ok: false, status: 503, json: {} })
  const sb = baseSimulee({ existantes: [], liens: [], horloges })
  const alarmes = []
  const bilan = await rafraichirCanauxDuCompte({ userId: COMPTE, sb, appel, maintenant,
                                                 alarme: (clef, det) => alarmes.push([clef, det]) })
  assert.equal(bilan.ok, false)
  const horloge = sb.trace.upserts.find(u => u.nom === 'canaux_releve')
  assert.ok(horloge, 'aucune horloge posee')
  assert.equal(horloge.lignes.echecs_consecutifs, 12, 'le compteur d echecs n a pas avance')
  assert.equal(horloge.lignes.premier_echec_le, '2026-10-19T09:00:00.000Z',
    'la date du premier echec a ete ecrasee')
  assert.equal(alarmes.length, 1, `${alarmes.length} alarme(s) levee(s) au lieu d une`)
  assert.equal(alarmes[0][0], 'canaux_releve_en_panne')
})

test('un seul echec, ou des echecs recents, ne sonnent pas', async () => {
  const maintenant = new Date('2026-10-20T12:00:00Z')
  const horloges = [{ user_id: COMPTE, ok: false, erreur: 'injoignable',
                      echecs_consecutifs: 3,
                      premier_echec_le: '2026-10-20T06:00:00Z',
                      tente_le: '2026-10-20T11:00:00Z' }]
  const appel = async () => ({ ok: false, status: 503, json: {} })
  const sb = baseSimulee({ existantes: [], liens: [], horloges })
  const alarmes = []
  await rafraichirCanauxDuCompte({ userId: COMPTE, sb, appel, maintenant,
                                   alarme: (clef, det) => alarmes.push([clef, det]) })
  assert.deepEqual(alarmes, [], 'six heures d echecs ont deja sonne')
})

test('une lecture reussie remet le compteur d echecs a zero', async () => {
  const maintenant = new Date('2026-10-20T12:00:00Z')
  const horloges = [{ user_id: COMPTE, ok: false, erreur: 'injoignable',
                      echecs_consecutifs: 11,
                      premier_echec_le: '2026-10-19T09:00:00Z' }]
  const appel = async () => ({ ok: true, status: 200,
                               json: { data: canaux, meta: { total: canaux.length } } })
  const sb = baseSimulee({ existantes: [], liens: [], horloges })
  await rafraichirCanauxDuCompte({ userId: COMPTE, sb, appel, maintenant })
  const horloge = sb.trace.upserts.find(u => u.nom === 'canaux_releve')
  assert.equal(horloge.lignes.echecs_consecutifs, 0)
  assert.equal(horloge.lignes.premier_echec_le, null,
    'la date du premier echec survit a une lecture reussie')
})

// ─── LE DISJONCTEUR (demande de Thierry, 19 octobre 2026) ──────────────────
//
// ⚠ POURQUOI IL EXISTE. Le 19 octobre, on a decouvert qu'un `200` portant une
// page HTML etait lu « ce compte n'a aucun canal » : le writer effacait tout.
// Le guard de `channelCall` ferme ce cas precis, pas la FAMILLE — une liste
// vide rendue par erreur, une cle qui change de perimetre, un compte vu vide un
// instant. Une disparition TOTALE est trop grave pour etre crue du premier coup.

const VIDE = async () => ({ ok: true, status: 200, json: { data: [], meta: { total: 0 } } })
const deuxCanaux = [
  { id: 'L1', user_id: COMPTE, property_id: BIEN_A, provider_channel_id: 'CH-AIR', disparu_le: null },
  { id: 'L2', user_id: COMPTE, property_id: BIEN_B, provider_channel_id: 'CH-BOOK', disparu_le: null }
]

test('LE TEST QUI COMPTE : la PREMIERE annonce de disparition totale n efface rien', async () => {
  const maintenant = new Date('2026-10-20T12:00:00Z')
  const sb = baseSimulee({ existantes: deuxCanaux, liens: [], horloges: [] })
  const alarmes = []
  const bilan = await rafraichirCanauxDuCompte({ userId: COMPTE, sb, appel: VIDE, maintenant,
                                                 alarme: (c, d) => alarmes.push([c, d]) })
  assert.equal(bilan.disparus, 0, 'une premiere annonce a efface des canaux')
  assert.deepEqual(sb.trace.updates, [], 'un disparu_le a ete pose sans confirmation')
  assert.equal(bilan.motif, 'suspendu')
  assert.equal(bilan.ok, false, 'un effacement suspendu s est declare reussi : la sync n en saura rien')
  // L'annonce est NOTEE, sinon la seconde lecture n aurait rien a confirmer.
  const horloge = sb.trace.upserts.find(u => u.nom === 'canaux_releve')
  assert.ok(horloge, 'aucune horloge posee')
  assert.equal(horloge.lignes.disparition_totale_nb, 2)
  assert.equal(horloge.lignes.disparition_totale_vue_le, '2026-10-20T12:00:00.000Z')
  assert.equal(alarmes.length, 1, `${alarmes.length} trace(s) au lieu d une`)
  assert.equal(alarmes[0][0], 'canaux_disparition_totale')
})

test('LE TEST QUI COMPTE : une SECONDE lecture concordante, 1 h plus tard, efface', async () => {
  const maintenant = new Date('2026-10-20T12:00:00Z')
  const horloges = [{ user_id: COMPTE, ok: false, echecs_consecutifs: 1,
                      disparition_totale_vue_le: '2026-10-20T10:30:00Z',
                      disparition_totale_nb: 2 }]
  const sb = baseSimulee({ existantes: deuxCanaux, liens: [], horloges })
  const bilan = await rafraichirCanauxDuCompte({ userId: COMPTE, sb, appel: VIDE, maintenant,
                                                 alarme: () => {} })
  assert.equal(bilan.disparus, 2, 'la confirmation n a pas efface')
  assert.equal(bilan.ok, true)
  const maj = sb.trace.updates.find(u => u.nom === 'canaux_du_bien')
  assert.ok(maj, 'aucune disparition ecrite apres confirmation')
  assert.ok(maj.conditions.some(c => c.k === 'user_id' && String(c.v) === COMPTE),
    'l effacement confirme part sans filtre de compte')
})

test('LE TEST QUI COMPTE : une seconde lecture TROP TOT n efface pas', async () => {
  // 59 minutes : l'attente est une MESURE, pas un geste symbolique. Deux
  // lectures du meme cycle de cron ne valent pas confirmation.
  const maintenant = new Date('2026-10-20T12:00:00Z')
  const horloges = [{ user_id: COMPTE, ok: false, echecs_consecutifs: 1,
                      disparition_totale_vue_le: '2026-10-20T11:01:00Z',
                      disparition_totale_nb: 2 }]
  const sb = baseSimulee({ existantes: deuxCanaux, liens: [], horloges })
  const bilan = await rafraichirCanauxDuCompte({ userId: COMPTE, sb, appel: VIDE, maintenant,
                                                 alarme: () => {} })
  assert.equal(bilan.disparus, 0, '59 minutes ont suffi a confirmer')
  assert.deepEqual(sb.trace.updates, [])
  // Et la date de la PREMIERE annonce ne se deplace pas : sinon l'attente
  // recommencerait a chaque cycle et la confirmation n'arriverait jamais.
  const horloge = sb.trace.upserts.find(u => u.nom === 'canaux_releve')
  assert.equal(horloge.lignes.disparition_totale_vue_le, '2026-10-20T11:01:00.000Z')
})

test('LE TEST QUI COMPTE : une annonce qui ne porte pas sur le MEME nombre ne confirme rien', async () => {
  // Hier le compte avait 5 canaux et l'annonce en comptait 5 ; aujourd'hui il
  // en a 2. Ce n'est pas la meme disparition : on repart d'une premiere annonce.
  const maintenant = new Date('2026-10-20T12:00:00Z')
  const horloges = [{ user_id: COMPTE, ok: false, echecs_consecutifs: 1,
                      disparition_totale_vue_le: '2026-10-19T08:00:00Z',
                      disparition_totale_nb: 5 }]
  const sb = baseSimulee({ existantes: deuxCanaux, liens: [], horloges })
  const bilan = await rafraichirCanauxDuCompte({ userId: COMPTE, sb, appel: VIDE, maintenant,
                                                 alarme: () => {} })
  assert.equal(bilan.disparus, 0, 'une annonce portant sur 5 canaux a confirme la perte de 2')
  const horloge = sb.trace.upserts.find(u => u.nom === 'canaux_releve')
  assert.equal(horloge.lignes.disparition_totale_nb, 2)
  assert.equal(horloge.lignes.disparition_totale_vue_le, '2026-10-20T12:00:00.000Z',
    'la premiere annonce aurait du etre REMISE a aujourd hui')
})

test('LE TEST QUI COMPTE : une disparition PARTIELLE s ecrit tout de suite', async () => {
  // ⚠ LA CONTRE-EPREUVE DU DISJONCTEUR. S'il bloquait aussi les disparitions
  // partielles, un canal reellement coupe resterait affiche comme relie —
  // l'inverse du defaut qu'on corrige. Un seul canal rendu sur deux : l'autre
  // est parti, et ca s'ecrit sans attendre.
  const maintenant = new Date('2026-10-20T12:00:00Z')
  const unSeul = [{ id: 'CH-AIR', attributes: { title: 'T', channel: 'AirBNB',
    is_active: true, properties: ['P-A'], rate_plans: [{ rate_plan_id: 'RP-A1' }] } }]
  const appel = async () => ({ ok: true, status: 200, json: { data: unSeul, meta: { total: 1 } } })
  const sb = baseSimulee({ existantes: deuxCanaux,
                           liens: [{ property_id: BIEN_A, provider_rate_plan_id: 'RP-A1' }],
                           horloges: [] })
  const alarmes = []
  const bilan = await rafraichirCanauxDuCompte({ userId: COMPTE, sb, appel, maintenant,
                                                 alarme: (c, d) => alarmes.push([c, d]) })
  assert.equal(bilan.ok, true)
  assert.equal(bilan.disparus, 1, 'la disparition partielle a ete suspendue')
  assert.deepEqual(alarmes, [], 'une disparition partielle a sonne')
})

test('LE TEST QUI COMPTE : un effacement SUSPENDU n est pas un echec pour l hote', () => {
  // ⚠ DEUX ETATS RENDENT `ok: false` ET NE VEULENT PAS DIRE LA MEME CHOSE
  // (decision de Thierry, 19 octobre 2026). Un vrai echec de lecture doit se
  // lire a l'ecran : la date de l'hote vieillit, il doit savoir pourquoi. Un
  // effacement suspendu par le disjoncteur, non : la lecture a REUSSI, et c'est
  // nous que ca concerne. Sans cette distinction, le mot « verification
  // impossible » s'affichait sur une lecture parfaitement reussie.
  assert.equal(echecVisibleParLHote({ ok: false, erreur: 'injoignable' }), true)
  assert.equal(echecVisibleParLHote({ ok: false, erreur: 'delai' }), true)
  assert.equal(echecVisibleParLHote({ ok: false, erreur: 'reponse_invalide' }), true)
  assert.equal(echecVisibleParLHote({ ok: false, erreur: 'suspendu' }), false,
    'un effacement suspendu est montre a l hote comme une panne')
  assert.equal(echecVisibleParLHote({ ok: true, erreur: null }), false)
  assert.equal(echecVisibleParLHote(null), false,
    'un compte jamais releve est annonce en panne')
})
