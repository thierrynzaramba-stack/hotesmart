// tests/avis-naissance.test.js
// Quand une evaluation du voyageur nait (lib/avis/naissance.js, decision D2 de
// docs/recette/decisions-nuit.md).
//
// Le danger que ces tests gardent : le poll relit TOUS les avis a chaque
// passage. Une naissance sans filtre aurait cree, au premier passage apres la
// mise en production, une evaluation pour chaque objet historique — delais
// depasses compris.

const test = require('node:test')
const assert = require('node:assert')
const { assurerEvaluation, rattacherObjetsRecus, objetOuvert, estEvaluable } = require('../lib/avis/naissance')

const MAINTENANT = Date.parse('2026-10-02T12:00:00Z')
const DANS = (j) => new Date(MAINTENANT + j * 86400000).toISOString()

// Un double de base : `guest_evaluations` (unicite user_id + booking_uid) et
// `ota_reviews` (lecture des identifiants), avec la trace de chaque ecriture.
function base ({ evaluations = [], objets = [], panne = null } = {}) {
  const etat = { evaluations: evaluations.map(e => ({ ...e })), ecritures: [] }
  function requete (table) {
    const q = { filtres: [], estNul: null, dans: null }
    const api = {
      select () { return api },
      eq (c, v) { q.filtres.push([c, v]); return api },
      in (c, v) { q.dans = [c, v]; return api },
      is (c, v) { q.estNul = [c, v]; return api },
      gt (c, v) { q.plusTard = [c, v]; return api },
      upsert (ligne, opts) {
        etat.ecritures.push({ table, op: 'upsert', ligne, opts })
        q.op = 'upsert'; q.ligne = ligne; q.opts = opts; return api
      },
      update (champs) { etat.ecritures.push({ table, op: 'update', champs }); q.op = 'update'; q.champs = champs; return api },
      then (ok, ko) { return Promise.resolve(executer()).then(ok, ko) },
    }
    function executer () {
      if (panne && panne === table) return { data: null, error: { message: 'panne simulee' } }
      if (table === 'ota_reviews') {
        const [, refs] = q.dans || [null, []]
        return { data: objets.filter(o => refs.includes(o.external_review_id)), error: null }
      }
      if (q.op === 'upsert') {
        const existe = etat.evaluations.find(e => e.user_id === q.ligne.user_id && e.booking_uid === q.ligne.booking_uid)
        if (existe) return { data: [], error: null }        // ignoreDuplicates
        const nee = { id: 'ev-' + (etat.evaluations.length + 1), ota_review_id: null, deadline_at: null, ...q.ligne }
        etat.evaluations.push(nee)
        return { data: [{ id: nee.id }], error: null }
      }
      if (table === 'guest_evaluations' && !q.op) {
        const [, uids] = q.dans || [null, []]
        const uid = (q.filtres.find(([c]) => c === 'user_id') || [])[1]
        return { data: etat.evaluations.filter(e => e.user_id === uid && uids.includes(e.booking_uid)), error: null }
      }
      if (q.op === 'update') {
        const cibles = etat.evaluations.filter(e =>
          q.filtres.every(([c, v]) => e[c] === v) && (!q.estNul || e[q.estNul[0]] == null)
          && (!q.plusTard || (e[q.plusTard[0]] != null && e[q.plusTard[0]] > q.plusTard[1])))
        for (const e of cibles) Object.assign(e, q.champs)
        return { data: cibles.map(e => ({ id: e.id })), error: null }
      }
      return { data: [], error: null }
    }
    return api
  }
  return { etat, sb: { from: requete } }
}

const SEJOUR = { userId: 'compte-1', propertyId: 'bien-uuid', propertyRef: 'ref-1', bookingUid: 'resa-1', provider: 'channex', ota: 'airbnb' }

function ligneAvis (over = {}) {
  return {
    user_id: 'compte-1', property_id: 'bien-uuid', property_id_ref: 'ref-1', provider: 'channex', ota: 'airbnb',
    external_review_id: 'rev-1', booking_uid: 'resa-1', is_replied: false, expired_at: DANS(10), ...over,
  }
}

// ─── Le filtre : ce qui peut faire naitre ───────────────────────────────────
test('seul Airbnb par Channex est evaluable', () => {
  assert.strictEqual(estEvaluable({ provider: 'channex', ota: 'airbnb' }), true)
  assert.strictEqual(estEvaluable({ provider: 'channex', ota: 'booking' }), false)
  assert.strictEqual(estEvaluable({ provider: 'beds24', ota: 'airbnb' }), false)
})

test('un objet est ouvert seulement s il a une echeance future et pas d evaluation partie', () => {
  assert.strictEqual(objetOuvert({ expired_at: DANS(1) }, MAINTENANT), true)
  assert.strictEqual(objetOuvert({ expired_at: DANS(-1) }, MAINTENANT), false, 'delai depasse')
  assert.strictEqual(objetOuvert({ expired_at: null }, MAINTENANT), false, 'on n invente pas d echeance')
  assert.strictEqual(objetOuvert({ expired_at: DANS(5), raw: { attributes: { guest_review: { public_review: 'x' } } } }, MAINTENANT), false, 'evaluation deja partie')
  assert.strictEqual(objetOuvert({ expired_at: DANS(5), raw: { attributes: { guest_review_submitted_at: '2026-10-01' } } }, MAINTENANT), false)
  assert.strictEqual(objetOuvert({ expired_at: 'pas une date' }, MAINTENANT), false)
})

// ─── Naissance 1 : la prestataire, sans objet ───────────────────────────────
test('naissance sans objet : a_remplir, sans echeance ni objet inventes', async () => {
  const { etat, sb } = base()
  const r = await assurerEvaluation(sb, { ...SEJOUR, menageEventId: 'men-1' })
  assert.deepStrictEqual(r, { cree: true, rattache: false })
  const e = etat.evaluations[0]
  assert.strictEqual(e.status, 'a_remplir')
  assert.strictEqual(e.deadline_at, null)
  assert.strictEqual(e.ota_review_id, null)
  assert.strictEqual(e.menage_event_id, 'men-1')
  assert.strictEqual(etat.ecritures[0].opts.ignoreDuplicates, true, 'une evaluation nee n est jamais reecrite')
})

test('LE TEST QUI COMPTE : une evaluation deja remplie n est pas reecrite par une seconde naissance', async () => {
  const { etat, sb } = base({ evaluations: [{ id: 'ev-1', user_id: 'compte-1', booking_uid: 'resa-1', status: 'a_valider', answers_cleaner: { etat: 'ok' }, ota_review_id: null }] })
  const r = await assurerEvaluation(sb, SEJOUR)
  assert.deepStrictEqual(r, { cree: false, rattache: false })
  assert.strictEqual(etat.evaluations.length, 1)
  assert.strictEqual(etat.evaluations[0].status, 'a_valider')
  assert.deepStrictEqual(etat.evaluations[0].answers_cleaner, { etat: 'ok' })
})

test('un sejour Booking ne fait rien naitre, et rien n est ecrit', async () => {
  const { etat, sb } = base()
  const r = await assurerEvaluation(sb, { ...SEJOUR, ota: 'booking' })
  assert.deepStrictEqual(r, { ignore: 'non_evaluable' })
  assert.strictEqual(etat.ecritures.length, 0)
})

test('un sejour incomplet ne fait rien naitre', async () => {
  const { etat, sb } = base()
  assert.deepStrictEqual(await assurerEvaluation(sb, { ...SEJOUR, bookingUid: null }), { ignore: 'sejour_incomplet' })
  assert.strictEqual(etat.ecritures.length, 0)
})

// ─── Naissance 2 : l'objet review arrive ────────────────────────────────────
test('un objet ouvert fait naitre l evaluation avec l echeance de Channex', async () => {
  const { etat, sb } = base({ objets: [{ id: 'objet-1', external_review_id: 'rev-1', expired_at: DANS(10) }] })
  const bilan = await rattacherObjetsRecus(sb, [ligneAvis()], { maintenant: MAINTENANT })
  assert.deepStrictEqual(bilan, { candidats: 1, crees: 1, rattaches: 0, erreurs: 0 })
  assert.strictEqual(etat.evaluations[0].ota_review_id, 'objet-1')
  assert.strictEqual(etat.evaluations[0].deadline_at, DANS(10))
})

test('un objet qui arrive APRES la prestataire est rattache, l evaluation garde ses reponses', async () => {
  const { etat, sb } = base({
    evaluations: [{ id: 'ev-1', user_id: 'compte-1', booking_uid: 'resa-1', status: 'soumise_prestataire', answers_cleaner: { etat: 'ok' }, ota_review_id: null, deadline_at: null }],
    objets: [{ id: 'objet-1', external_review_id: 'rev-1', expired_at: DANS(10) }],
  })
  const bilan = await rattacherObjetsRecus(sb, [ligneAvis()], { maintenant: MAINTENANT })
  assert.deepStrictEqual(bilan, { candidats: 1, crees: 0, rattaches: 1, erreurs: 0 })
  const e = etat.evaluations[0]
  assert.strictEqual(e.ota_review_id, 'objet-1')
  assert.strictEqual(e.deadline_at, DANS(10))
  assert.strictEqual(e.status, 'soumise_prestataire', 'le statut ne bouge pas')
  assert.deepStrictEqual(e.answers_cleaner, { etat: 'ok' })
})

test('un objet deja rattache n est jamais remplace', async () => {
  const { etat, sb } = base({
    evaluations: [{ id: 'ev-1', user_id: 'compte-1', booking_uid: 'resa-1', status: 'a_remplir', ota_review_id: 'objet-ancien', deadline_at: DANS(3) }],
    objets: [{ id: 'objet-1', external_review_id: 'rev-1', expired_at: DANS(10) }],
  })
  const bilan = await rattacherObjetsRecus(sb, [ligneAvis()], { maintenant: MAINTENANT })
  assert.strictEqual(bilan.rattaches, 0)
  assert.strictEqual(etat.evaluations[0].ota_review_id, 'objet-ancien')
  assert.strictEqual(etat.evaluations[0].deadline_at, DANS(3))
})

test('LE TEST QUI COMPTE : les objets historiques ne font RIEN naitre (premier poll apres la mise en production)', async () => {
  const { etat, sb } = base({ objets: [] })
  const historiques = [
    ligneAvis({ external_review_id: 'a', booking_uid: 'r-a', expired_at: '2022-10-06T00:00:00Z' }),
    ligneAvis({ external_review_id: 'b', booking_uid: 'r-b', expired_at: DANS(-1) }),
    ligneAvis({ external_review_id: 'c', booking_uid: 'r-c', raw: { attributes: { guest_review_submitted_at: '2026-09-30T10:00:00' } } }),
    ligneAvis({ external_review_id: 'd', booking_uid: null }),               // non resolu
    ligneAvis({ external_review_id: 'e', booking_uid: 'r-e', ota: 'booking' }),
    ligneAvis({ external_review_id: 'f', booking_uid: 'r-f', expired_at: null }),
  ]
  const bilan = await rattacherObjetsRecus(sb, historiques, { maintenant: MAINTENANT })
  assert.strictEqual(bilan.candidats, 0)
  assert.strictEqual(etat.ecritures.length, 0, 'pas une seule ecriture')
})

test('une panne ne leve pas : la reception des avis ne doit pas echouer pour une evaluation', async () => {
  const { sb } = base({ panne: 'ota_reviews' })
  const bilan = await rattacherObjetsRecus(sb, [ligneAvis()], { maintenant: MAINTENANT })
  assert.strictEqual(bilan.crees, 0)
  assert.ok(bilan.erreurs > 0, 'la panne est comptee, pas tue')
})

test('le poll et le webhook passent tous deux par la naissance', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const poll = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cron-channel-reviews.js'), 'utf8')
  const webhook = fs.readFileSync(path.join(__dirname, '..', 'api', 'channel-events.js'), 'utf8')
  assert.match(poll, /await rattacherObjetsRecus\(sb, lot, /)
  assert.match(webhook, /await rattacherObjetsRecus\(supabase, prep\.ligne\)/)
})

// ─── Constats de la revue de fb703f6 ────────────────────────────────────────
test('LE TEST QUI COMPTE : une REPONSE de l hote a l avis du voyageur n empeche pas la naissance', async () => {
  // `ota_reviews.is_replied` veut dire « l'hote a repondu a l'avis du voyageur »,
  // pas « l'evaluation du voyageur est partie ». Le lire ici perdait des
  // evaluations encore publiables.
  const { etat, sb } = base({ objets: [{ id: 'objet-1', external_review_id: 'rev-1', expired_at: DANS(10) }] })
  const bilan = await rattacherObjetsRecus(sb, [ligneAvis({ is_replied: true })], { maintenant: MAINTENANT })
  assert.strictEqual(bilan.crees, 1)
  assert.strictEqual(etat.evaluations.length, 1)
})

test('un objet deja rattache ne coute AUCUNE ecriture au passage suivant', async () => {
  const { etat, sb } = base({
    evaluations: [{ id: 'ev-1', user_id: 'compte-1', booking_uid: 'resa-1', status: 'a_remplir', ota_review_id: 'objet-1', deadline_at: DANS(10) }],
    objets: [{ id: 'objet-1', external_review_id: 'rev-1', expired_at: DANS(10) }],
  })
  const bilan = await rattacherObjetsRecus(sb, [ligneAvis()], { maintenant: MAINTENANT })
  assert.deepStrictEqual(bilan, { candidats: 1, crees: 0, rattaches: 0, erreurs: 0 })
  assert.strictEqual(etat.ecritures.length, 0, 'ni upsert ignore ni update sans cible')
})

test('une echeance Channex sans fuseau est lue en UTC', () => {
  const { instantUTC } = require('../lib/avis/naissance')
  assert.strictEqual(new Date(instantUTC('2026-09-29T18:29:33.852000')).toISOString(), '2026-09-29T18:29:33.852Z')
  assert.strictEqual(new Date(instantUTC('2026-09-29T20:29:33+02:00')).toISOString(), '2026-09-29T18:29:33.000Z')
})

test('le poll passe son horloge a la naissance', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const poll = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cron-channel-reviews.js'), 'utf8')
  assert.match(poll, /rattacherObjetsRecus\(sb, lot, \{ maintenant: maintenant\(\) \}\)/)
})

// ─── Naissance au jour du depart (§9 bis, 2 octobre 2026) ───────────────────
const { naitreAuDepart, echeanceDuDepart } = require('../lib/avis/naissance')

function baseDepart ({ menages = [], snaps = [], biens = [], evaluations = [] } = {}) {
  const etat = { evaluations: evaluations.map(e => ({ ...e })), requetes: [] }
  const from = (table) => {
    const q = { table, f: {}, dans: {}, neq: null, op: 'select' }
    etat.requetes.push(q)
    const executer = () => {
      if (table === 'menages') return { data: menages.filter(m => q.dans.departure_date.includes(m.departure_date) && m.status !== q.neq), error: null }
      if (table === 'bookings_snapshot') return { data: snaps.filter(s => s.user_id === q.f.user_id && q.dans.booking_id.includes(s.booking_id)), error: null }
      if (table === 'properties') return { data: biens.filter(b => b.user_id === q.f.user_id && q.dans.provider_property_id.includes(b.provider_property_id)), error: null }
      if (table === 'guest_evaluations' && q.op === 'select') {
        etat.lecturesEvaluations = (etat.lecturesEvaluations || 0) + 1
        return { data: etat.evaluations.filter(e => e.user_id === q.f.user_id && q.dans.booking_uid.includes(e.booking_uid)), error: null }
      }
      if (table === 'guest_evaluations' && q.op === 'upsert') {
        if (etat.evaluations.some(e => e.user_id === q.ligne.user_id && e.booking_uid === q.ligne.booking_uid)) return { data: [], error: null }
        etat.evaluations.push({ ...q.ligne }); return { data: [{ id: 'n' }], error: null }
      }
      return { data: [], error: null }
    }
    const c = {
      select () { return c }, eq (k, v) { q.f[k] = v; return c }, in (k, v) { q.dans[k] = v; return c },
      neq (k, v) { q.neq = v; return c }, limit (n) { q.limite = n; return c }, is () { return c },
      order (k) { (q.ordre = q.ordre || []).push(k); return c },
      upsert (ligne) { q.op = 'upsert'; q.ligne = ligne; etat.upserts = (etat.upserts || 0) + 1; return c },
      then (ok, ko) { return Promise.resolve(executer()).then(ok, ko) },
    }
    return c
  }
  return { etat, sb: { from } }
}
const AUJ = Date.parse('2026-10-02T09:00:00Z')
const DEP = (booking_id, departure_date = '2026-10-02', status = 'accepted', property_id = 'ref-1') => ({ user_id: 'compte-1', booking_id, property_id, departure_date, status })
const SNAP = (booking_id, source = 'AirBNB', provider = 'channex', status = 'confirmed') => ({ user_id: 'compte-1', booking_id, property_id: 'ref-1', snapshot: { provider, source, status } })
const BIEN = { id: 'bien-uuid', user_id: 'compte-1', provider_property_id: 'ref-1' }

test('LE TEST QUI COMPTE : le jour du départ, chaque séjour Airbnb terminé fait naître son évaluation, échéance départ + 14 jours', async () => {
  const { etat, sb } = baseDepart({ menages: [DEP('A')], snaps: [SNAP('A')], biens: [BIEN] })
  const bilan = await naitreAuDepart(sb, { maintenant: AUJ })
  assert.deepStrictEqual(bilan, { departs: 1, evaluables: 1, crees: 1, erreurs: 0 })
  const e = etat.evaluations[0]
  assert.strictEqual(e.booking_uid, 'A')
  assert.strictEqual(e.property_id, 'bien-uuid')
  assert.strictEqual(e.status, 'a_remplir')
  assert.strictEqual(e.deadline_at, echeanceDuDepart('2026-10-02'))
  assert.strictEqual(e.deadline_at, '2026-10-16T12:00:00.000Z')
})

test('la requête ne lit QUE les départs du jour et des deux précédents (pas un balayage)', async () => {
  const { etat, sb } = baseDepart()
  await naitreAuDepart(sb, { maintenant: AUJ })
  const q = etat.requetes.find(r => r.table === 'menages')
  assert.deepStrictEqual(q.dans.departure_date, ['2026-09-30', '2026-10-01', '2026-10-02'])
  assert.strictEqual(q.neq, 'cancelled')
})

test('Booking, Beds24, une réservation annulée, un bien ambigu : rien ne naît', async () => {
  const { etat, sb } = baseDepart({
    menages: [DEP('B'), DEP('C'), DEP('D'), DEP('E', '2026-10-02', 'accepted', 'ref-2')],
    snaps: [SNAP('B', 'BookingCom'), SNAP('C', 'airbnb', 'beds24'), SNAP('D', 'AirBNB', 'channex', 'cancelled'), { ...SNAP('E'), property_id: 'ref-2' }],
    biens: [BIEN, { id: 'x1', user_id: 'compte-1', provider_property_id: 'ref-2' }, { id: 'x2', user_id: 'compte-1', provider_property_id: 'ref-2' }],
  })
  const bilan = await naitreAuDepart(sb, { maintenant: AUJ })
  assert.strictEqual(bilan.crees, 0)
  assert.strictEqual(etat.evaluations.length, 0)
})

test('une évaluation déjà née (par la PWA) n’est jamais réécrite au départ', async () => {
  const { etat, sb } = baseDepart({ menages: [DEP('A')], snaps: [SNAP('A')], biens: [BIEN],
    evaluations: [{ user_id: 'compte-1', booking_uid: 'A', status: 'soumise_prestataire', answers_cleaner: { etat: 'ok' } }] })
  const bilan = await naitreAuDepart(sb, { maintenant: AUJ })
  assert.strictEqual(bilan.crees, 0)
  assert.strictEqual(etat.evaluations[0].status, 'soumise_prestataire')
})

test('une panne ne lève pas', async () => {
  const sb = { from: () => { throw new Error('panne') } }
  const bilan = await naitreAuDepart(sb, { maintenant: AUJ })
  assert.strictEqual(bilan.erreurs, 1)
})

test('LE TEST QUI COMPTE : le rattachement de l’objet Channex ne déplace PAS l’échéance d’Airbnb', async () => {
  const { etat, sb } = base({
    evaluations: [{ id: 'ev-1', user_id: 'compte-1', booking_uid: 'resa-1', status: 'a_remplir', ota_review_id: null, deadline_at: '2026-10-16T12:00:00.000Z' }],
    objets: [{ id: 'objet-1', external_review_id: 'rev-1', expired_at: DANS(29) }],
  })
  await rattacherObjetsRecus(sb, [ligneAvis()], { maintenant: MAINTENANT })
  assert.strictEqual(etat.evaluations[0].ota_review_id, 'objet-1')
  assert.strictEqual(etat.evaluations[0].deadline_at, '2026-10-16T12:00:00.000Z')
})

test('le cron fait naître au départ, avant les relances', () => {
  const fs = require('node:fs'); const path = require('node:path')
  const cron = fs.readFileSync(path.join(__dirname, '..', 'api', 'cron.js'), 'utf8')
  const n = cron.indexOf("chrono.mesure('naissances_avis', () => naitreAuDepart(supabase))")
  const r = cron.indexOf("chrono.mesure('relances_avis'")
  assert.ok(n > 0 && n < r)
})

// ─── Revue de 94f9a43 ───────────────────────────────────────────────────────
test('un depart deja ne ne coute AUCUN upsert aux passages suivants', async () => {
  const { etat, sb } = baseDepart({ menages: [DEP('A')], snaps: [SNAP('A')], biens: [BIEN] })
  await naitreAuDepart(sb, { maintenant: AUJ })
  assert.strictEqual(etat.upserts, 1)
  const bilan = await naitreAuDepart(sb, { maintenant: AUJ + 300000 })
  assert.strictEqual(etat.upserts, 1, 'le second passage lit, il n ecrit pas')
  assert.strictEqual(bilan.crees, 0)
})

test('la lecture des departs est ORDONNEE, et une troncature se compte en erreur', async () => {
  const beaucoup = Array.from({ length: 500 }, (_, i) => DEP('T' + i))
  const { etat, sb } = baseDepart({ menages: beaucoup })
  const bilan = await naitreAuDepart(sb, { maintenant: AUJ })
  const q = etat.requetes.find(r => r.table === 'menages')
  assert.deepStrictEqual(q.ordre, ['departure_date', 'booking_id'])
  assert.strictEqual(q.limite, 500)
  assert.strictEqual(bilan.erreurs, 1)
})

test('LE TEST QUI COMPTE : un objet qui ferme PLUS TOT que depart + 14 jours avance l’echeance', async () => {
  const { etat, sb } = base({
    evaluations: [{ id: 'ev-1', user_id: 'compte-1', booking_uid: 'resa-1', status: 'a_remplir', ota_review_id: null, deadline_at: DANS(14) }],
    objets: [{ id: 'objet-1', external_review_id: 'rev-1', expired_at: DANS(9) }],
  })
  await rattacherObjetsRecus(sb, [ligneAvis()], { maintenant: MAINTENANT })
  assert.strictEqual(etat.evaluations[0].deadline_at, DANS(9))
})

test('LE TEST QUI COMPTE : un objet rattache SANS echeance (ecriture ratee) est repare au passage suivant', async () => {
  const { etat, sb } = base({
    evaluations: [{ id: 'ev-1', user_id: 'compte-1', booking_uid: 'resa-1', status: 'a_remplir', ota_review_id: 'objet-1', deadline_at: null }],
    objets: [{ id: 'objet-1', external_review_id: 'rev-1', expired_at: DANS(10) }],
  })
  await rattacherObjetsRecus(sb, [ligneAvis()], { maintenant: MAINTENANT })
  assert.strictEqual(etat.evaluations[0].deadline_at, DANS(10))
  assert.strictEqual(etat.evaluations[0].ota_review_id, 'objet-1')
})

// ─── « Evaluee sur Airbnb » (spec §6, regle de Thierry du 2 octobre au soir) ──
const { rangerEvalueesAilleurs, evaluationDejaPartie } = require('../lib/avis/naissance')

function baseRangement (evaluations) {
  const etat = { evaluations: evaluations.map(e => ({ ...e })), requetes: [] }
  const from = (table) => {
    const q = { table, f: {}, dans: {} }
    etat.requetes.push(q)
    const c = {
      update (maj) { q.maj = maj; return c },
      insert (ligne) { (etat.journal = etat.journal || []).push(ligne); q.insert = true; return c },
      eq (k, v) { q.f[k] = v; return c },
      in (k, v) { q.dans[k] = v; return c },
      gt (k, v) { q.gt = [k, v]; return c },
      select () { return c },
      then (ok, ko) {
        if (q.insert) return Promise.resolve({ error: null }).then(ok, ko)
        const cibles = etat.evaluations.filter(e => e.user_id === q.f.user_id
          && q.dans.booking_uid.includes(e.booking_uid) && q.dans.status.includes(e.status)
          && (!q.gt || (e[q.gt[0]] != null && e[q.gt[0]] > q.gt[1])))
        for (const e of cibles) Object.assign(e, q.maj)
        return Promise.resolve({ data: cibles.map(e => ({ id: e.id, booking_uid: e.booking_uid })), error: null }).then(ok, ko)
      },
    }
    return c
  }
  return { etat, sb: { from } }
}

// Un objet Airbnb dont l'avis du voyageur est VISIBLE : non cache, et noté.
const VISIBLE = (a = {}) => ligneAvis({ is_hidden: false, ...a, raw: { attributes: { is_hidden: false, overall_score: 10, ...(a.attrs || {}) } } })
const CACHE = (a = {}) => ligneAvis({ is_hidden: true, ...a, raw: { attributes: { is_hidden: true, overall_score: 0 } } })
const EV = (id, uid, status = 'a_remplir', a = {}) => ({ id, user_id: 'compte-1', booking_uid: uid, status, deadline_at: DANS(5), ...a })

test('LE TEST QUI COMPTE : un avis du voyageur VISIBLE avant l’echeance range l’evaluation « Evaluee sur Airbnb »', async () => {
  const { etat, sb } = baseRangement([EV('a', 'resa-1'), EV('b', 'resa-2')])
  const bilan = await rangerEvalueesAilleurs(sb, [
    VISIBLE({ booking_uid: 'resa-1' }),
    CACHE({ external_review_id: 'rev-2', booking_uid: 'resa-2' }),
  ], { maintenant: MAINTENANT })
  assert.strictEqual(bilan.rangees, 1)
  assert.strictEqual(etat.evaluations[0].status, 'evaluee_ailleurs')
  assert.strictEqual(etat.evaluations[0].auto_publier_le, null, 'la publication automatique s arrete')
  assert.strictEqual(etat.evaluations[1].status, 'a_remplir', 'cache : on ne sait pas, on ne range pas')
  assert.strictEqual(etat.journal[0].type, 'avis.evaluee_ailleurs', 'le rangement automatique laisse une trace')
})

test('SECURITE (revue de 9f76ae2) : un « is_hidden » absent du brut n’est PAS visible', async () => {
  const { etat, sb } = baseRangement([EV('a', 'resa-1')])
  await rangerEvalueesAilleurs(sb, [ligneAvis({ booking_uid: 'resa-1', is_hidden: false, raw: { attributes: { overall_score: 10 } } })], { maintenant: MAINTENANT })
  assert.strictEqual(etat.evaluations[0].status, 'a_remplir')
})

test('SECURITE : apres l’echeance d’Airbnb (depart + 14 j), un avis visible ne prouve plus rien', async () => {
  const { etat, sb } = baseRangement([EV('a', 'resa-1', 'a_remplir', { deadline_at: DANS(-1) }), EV('b', 'resa-1b', 'a_remplir', { deadline_at: null })])
  await rangerEvalueesAilleurs(sb, [VISIBLE({ booking_uid: 'resa-1' }), VISIBLE({ external_review_id: 'rev-1b', booking_uid: 'resa-1b' })], { maintenant: MAINTENANT })
  assert.deepStrictEqual(etat.evaluations.map(e => e.status), ['a_remplir', 'a_remplir'])
})

test('SECURITE : un objet visible mais SANS avis (ni note ni texte) ne prouve rien', async () => {
  const { etat, sb } = baseRangement([EV('a', 'resa-1')])
  await rangerEvalueesAilleurs(sb, [ligneAvis({ booking_uid: 'resa-1', raw: { attributes: { is_hidden: false, overall_score: 0, content: null } } })], { maintenant: MAINTENANT })
  assert.strictEqual(etat.evaluations[0].status, 'a_remplir')
})

test('jamais une evaluation publiee, expiree, abandonnee ou en echec ; jamais un objet expire', async () => {
  const { etat, sb } = baseRangement(['publiee', 'expiree', 'abandonnee', 'echec_publication']
    .map((s, i) => EV('e' + i, 'resa-1', s)))
  await rangerEvalueesAilleurs(sb, [VISIBLE({ booking_uid: 'resa-1' })], { maintenant: MAINTENANT })
  assert.deepStrictEqual(etat.evaluations.map(e => e.status), ['publiee', 'expiree', 'abandonnee', 'echec_publication'])
  const b = baseRangement([EV('x', 'resa-1')])
  await rangerEvalueesAilleurs(b.sb, [VISIBLE({ booking_uid: 'resa-1', expired_at: DANS(-1) })], { maintenant: MAINTENANT })
  assert.strictEqual(b.etat.evaluations[0].status, 'a_remplir', 'apres 14 jours, l avis devient public de toute facon : aucun signal')
})

test('le rattachement range aussi, dans le meme passage', async () => {
  const { etat, sb } = base({
    evaluations: [{ id: 'ev-1', user_id: 'compte-1', booking_uid: 'resa-1', status: 'a_remplir', ota_review_id: 'objet-1', deadline_at: DANS(10) }],
    objets: [{ id: 'objet-1', external_review_id: 'rev-1', expired_at: DANS(10) }],
  })
  const bilan = await rattacherObjetsRecus(sb, [VISIBLE()], { maintenant: MAINTENANT })
  assert.strictEqual(bilan.rangees, 1)
  assert.ok(etat.ecritures.some(e => e.op === 'update' && e.champs.status === 'evaluee_ailleurs'))
})

test('« deja partie » se lit dans reply.guest_review (la ou Channex la range)', () => {
  assert.strictEqual(evaluationDejaPartie({ raw: { attributes: { reply: { guest_review: { public_review: 'x' } } } } }), true)
  assert.strictEqual(evaluationDejaPartie({ raw: { attributes: { reply: null } } }), false)
})
