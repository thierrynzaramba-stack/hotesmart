// tests/ecran-avis.test.js — l'appel d'ecran de la page Avis V5
// (api/ecran/avis.js) et son compteur de requetes (lib/compte-requetes.js).
// Spec : docs/specs/avis-v5/spec-refonte-ui-v5-lot-avis.md §6 et §9.
//
// ⚠ LE BANC GARDE LA VRAIE GARDE (`contexteDEcran`, `lib/require-permission`)
// et ne double que la base : c'est l'ordre des refus et l'en-tete prive qu'on
// veut voir, pas ceux d'un double.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'cle-test'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')

const PROD = '11111111-1111-4111-8111-111111111111'
const MEMBRE = '22222222-2222-4222-8222-222222222222'
const REF_A = '0544fd9a-6579-44e7-b75e-19c63a2019ba'
const REF_B = '209413'
const BIEN_A = { id: 'aa11bb22-cc33-4dd4-8ee5-ff6677889900', user_id: PROD, name: 'Colomiers', provider: 'channex', provider_property_id: REF_A, photo_url: 'https://exemple.test/a.jpg', archive_le: null }
const BIEN_B = { id: 'bb22cc33-dd44-4ee5-8ff6-001122334455', user_id: PROD, name: 'La bulle', provider: 'beds24', provider_property_id: REF_B, photo_url: null, archive_le: null }

const ilYa = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return d.toISOString() }
// ⚠ UN NOM, DES DATES ET UNE RESERVATION : sans eux, le test du droit
// `reservations` ne mesurerait rien (revue du lot V5, constat 11).
const AVIS_A = { id: 'r1', user_id: PROD, statut: 'confirme', provider: 'channex', ota: 'airbnb', ai_analyzed_at: ilYa(3), property_id_ref: REF_A, ai_clean_verdict: 'positif', received_at: ilYa(3), overall_score: 9, content: 'Séjour parfait', is_hidden: false,
                 guest_name: 'Fanny Durand', stay_start: ilYa(8).slice(0, 10), stay_end: ilYa(5).slice(0, 10), booking_uid: 'resa-a1' }
// Une detection ecrite trois semaines apres le depart : rangee dans les Anciens.
const DETECTION_ANCIENNE = { id: 'r9', user_id: PROD, statut: 'detecte', provider: 'message', ota: null, ai_analyzed_at: ilYa(40), property_id_ref: REF_A, ai_clean_verdict: 'remarque', received_at: ilYa(40), content: 'La moquette était tachée', is_hidden: false }
const AVIS_B = { id: 'r2', user_id: PROD, statut: 'confirme', provider: 'channex', ota: 'booking', ai_analyzed_at: ilYa(4), property_id_ref: REF_B, ai_clean_verdict: 'remarque', received_at: ilYa(4), overall_score: 7, content: 'La clé était difficile à trouver', is_hidden: false }

const MODULES = ['../api/ecran/avis', '../api/avis', '../lib/require-permission', '../lib/permissions', '../lib/cron-reviews-classify', '../lib/cron-shared']

// La projection des colonnes demandees : une colonne non lue ne descend pas.
function projeter (ligne, colonnes) {
  if (typeof colonnes !== 'string' || !colonnes.trim() || colonnes.trim() === '*') return ligne
  const out = {}
  for (const n of colonnes.split(',').map(c => c.trim()).filter(Boolean)) if (Object.prototype.hasOwnProperty.call(ligne, n)) out[n] = ligne[n]
  return out
}

// ⚠ LA RESERVATION DANS LE COEUR, source principale du nom et des dates d'un
// sejour (re-review du lot V5, constat 11) : un prenom DIFFERENT de celui de
// l'avis, pour savoir d'ou vient ce qui s'affiche.
// ⚠ DATES RELATIVES : le sejour doit rester dans « Récents » quel que soit le
// jour ou tourne le test (horloge decalee comprise).
const ARRIVEE_A = ilYa(7).slice(0, 10)
const DEPART_A = ilYa(4).slice(0, 10)
const SNAPSHOTS = [{ user_id: PROD, booking_id: 'resa-a1', snapshot: { firstName: 'Fabienne', lastName: 'Durand', arrival: ARRIVEE_A, departure: DEPART_A } }]

// Les chiffres de la page sont LUS dans `resume_bien_avis` (lot Avis V5,
// etape 2) : une ligne par bien et par periode, comme le writer les ecrit.
// ⚠ UNE DATE QU'AUCUN SEJOUR NE PEUT PORTER : les dates de sejour suivent
// l'horloge, et un test refuse qu'une date de sejour descende sans le droit
// `reservations`. Une heure de calcul le jour d'un sejour le ferait rougir a
// J+4 (mesure par l'horloge decalee) pour une raison qui n'est pas la sienne.
const CALCULE_LE = '2020-01-15T05:02:00.000Z'
const ligneResume = (ref, periode, o = {}) => ({ user_id: PROD, property_id_ref: ref, periode, total: 1, positif: 1, remarque: 0,
  rien_signale: 0, notes: 1, notes_micro: 4500000, calcule_le: CALCULE_LE, motif_non_calculable: null, ...o })
const RESUME = ['15j', '30j', '6mois', 'toujours'].flatMap(p => [ligneResume(BIEN_A.provider_property_id, p), ligneResume(BIEN_B.provider_property_id, p)])

function preparer ({ user = PROD, profil = null, permissions = null, avis = [AVIS_A, AVIS_B], biens = [BIEN_A, BIEN_B], autoEnPanne = false, auto = [], evalsEnPanne = false, snapshots = SNAPSHOTS, resume = RESUME } = {}) {
  const etat = { tables: [], fetchs: 0 }
  // ⚠ CHAQUE LECTURE DU DOUBLE PASSE PAR `fetch`, comme supabase-js : sans ca,
  // le compteur de `Server-Timing` n'etait jamais traverse, et « 0 requêtes »
  // ecrit en dur restait vert (revue du lot V5, constat 9).
  globalThis.fetch = async () => { etat.fetchs++; return { ok: true } }
  const viaFetch = (chemin) => globalThis.fetch(process.env.SUPABASE_URL + chemin)
  const client = {
    auth: { getUser: async () => { await viaFetch('/auth/v1/user'); return user ? { data: { user: { id: user } }, error: null } : { data: null, error: { message: 'x' } } } },
    from (nom) {
      etat.tables.push(nom)
      const q = { f: {}, ins: [], ors: [], head: false, count: null, colonnes: '' }
      const chaine = {
        select (c, o) { q.colonnes = c; q.head = !!(o && o.head); q.count = o && o.count; return chaine },
        eq (c, v) { q.f[c] = v; return chaine },
        in (c, v) { q.ins.push({ c, v: (v || []).map(String) }); return chaine },
        or (e) { q.ors.push(String(e)); return chaine },
        is (c, v) { q.f[c] = v; return chaine },
        neq () { return chaine }, not () { return chaine }, gt () { return chaine }, gte () { return chaine }, lt () { return chaine },
        order () { return chaine }, limit () { return chaine }, range () { return chaine },
        maybeSingle: async () => { const r = await lire(); return { data: (r.data || [])[0] || null, error: r.error } },
        then (ok, ko) { return lire().then(ok, ko) },
      }
      async function lire () {
        await viaFetch('/rest/v1/' + nom)
        return lireSansFetch()
      }
      function lireSansFetch () {
        if (nom === 'guest_evaluations' && evalsEnPanne) return Promise.resolve({ data: null, error: { message: 'relation "guest_evaluations" : panne de connexion 10.0.0.12' } })
        if (nom === 'properties') {
          let c = biens.filter(b => (q.f.user_id == null || b.user_id === q.f.user_id))
          if ('archive_le' in q.f) c = c.filter(b => b.archive_le === q.f.archive_le)
          for (const i of q.ins) c = c.filter(b => i.v.includes(String(b[i.c])))
          return Promise.resolve({ data: c, error: null })
        }
        if (nom === 'ota_reviews') {
          let c = avis.filter(a => q.f.user_id == null || a.user_id === q.f.user_id)
          if (q.f.property_id_ref) c = c.filter(a => a.property_id_ref === q.f.property_id_ref)
          for (const i of q.ins) c = c.filter(a => i.v.includes(String(a[i.c])))
          for (const e of q.ors) if (/property_id_ref/.test(e)) c = c.filter(a => e.includes(a.property_id_ref))
          if (q.head) return Promise.resolve({ data: null, count: c.length, error: null })
          return Promise.resolve({ data: c.map(a => projeter(a, q.colonnes)), count: c.length, error: null })
        }
        if (nom === 'bookings_snapshot') {
          let c = snapshots.filter(x => q.f.user_id == null || x.user_id === q.f.user_id)
          for (const i of q.ins) c = c.filter(x => i.v.includes(String(x[i.c])))
          return Promise.resolve({ data: c, error: null })
        }
        if (nom === 'resume_bien_avis') {
          let c = resume.filter(l => l.user_id === q.f.user_id && l.periode === q.f.periode)
          for (const i of q.ins) c = c.filter(l => i.v.includes(String(l[i.c])))
          return Promise.resolve({ data: c, error: null })
        }
        if (nom === 'avis_auto_validation') {
          if (autoEnPanne) return Promise.resolve({ data: null, error: { message: 'panne' } })
          return Promise.resolve({ data: auto, error: null })
        }
        if (nom === 'profiles') {
          const ok = profil && profil.account_user_id === q.f.account_user_id && profil.member_user_id === q.f.member_user_id
          return Promise.resolve({ data: ok ? [profil] : [], error: null })
        }
        if (nom === 'profile_permissions') {
          return Promise.resolve({ data: permissions && profil ? [{ ...permissions, profile_id: profil.id }] : [], error: null })
        }
        return Promise.resolve({ data: [], error: null })
      }
      return chaine
    },
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of MODULES) { try { delete require.cache[require.resolve(mod)] } catch {} }
  return etat
}

function reponse () {
  const r = { code: null, body: null, entetes: {} }
  r.status = c => { r.code = c; return r }
  r.json = b => { r.body = b; return r }
  r.setHeader = (k, v) => { r.entetes[String(k).toLowerCase()] = v; return r }
  return r
}
const req = (query = {}, method = 'GET', compte = null) => ({ method, query, body: null, headers: { authorization: 'Bearer jeton', ...(compte ? { 'x-compte': compte } : {}) } })
const MEMBRE_SUR_A = {
  user: MEMBRE,
  profil: { id: 'profil-1', account_user_id: PROD, member_user_id: MEMBRE, active: true, accepted_at: '2026-01-01' },
  permissions: { avis: 'read', property_scope: 'some', property_ids: [BIEN_A.id], property_refs: [REF_A] },
}

let etatCompte = () => NaN
test('le titulaire : UN appel rend les cartes, les chiffres, les biens (avec photo), les periodes et la publication automatique', async () => {
  const etat = preparer({ auto: [{ property_id: BIEN_A.id, heures: 48 }] })
  etatCompte = () => etat.fetchs
  const res = reponse()
  await require('../api/ecran/avis')(req({ periode: '30j' }), res)
  assert.equal(res.code, 200, JSON.stringify(res.body))
  assert.deepEqual(Object.keys(res.body.cartes).sort(), ['anciens', 'attente', 'recents'])
  assert.equal(res.body.cartes.anciens, null, 'les anciens ne se lisent qu a l ouverture')
  assert.ok(res.body.stats && 'note_sur_5' in res.body.stats)
  // Les chiffres sont LUS (lot Avis V5, etape 2) : la somme des deux lignes
  // 30j, l'heure du calcul avec, et une seule lecture des avis — celle des
  // cartes. Les quatre comptages et la lecture des notes ont disparu.
  assert.deepEqual([res.body.stats.total, res.body.stats.note_sur_5, res.body.stats.calcule_le], [2, 4.5, CALCULE_LE])
  assert.equal(etat.tables.filter(t => t === 'resume_bien_avis').length, 1)
  assert.equal(etat.tables.filter(t => t === 'ota_reviews').length, 1, 'les avis ne sont lus que pour les cartes')
  assert.deepEqual(res.body.biens.map(b => [b.name, b.photo_url]), [['Colomiers', 'https://exemple.test/a.jpg'], ['La bulle', null]])
  assert.ok(Array.isArray(res.body.periodes) && res.body.periodes.includes('30j'))
  assert.deepEqual(res.body.publication_auto, { actifs: 1, total: 2 })
  // Les cartes portent la reference de leur bien : c'est elle qui trouve la photo.
  assert.ok(res.body.cartes.recents.every(c => [REF_A, REF_B].includes(c.bien_ref)))
  assert.equal(res.entetes['cache-control'], 'private, no-store')
  // Le compte EXACT, garde comprise : chaque lecture du double est un `fetch`.
  const compte = Number(res.entetes['server-timing'].match(/^total;dur=\d+;desc="(\d+) requêtes"$/)[1])
  assert.ok(compte > 0)
  assert.equal(compte, etatCompte())
})

test('l en-tete prive est pose AVANT le refus de methode (dette 90)', async () => {
  const etat = preparer()
  const res = reponse()
  await require('../api/ecran/avis')(req({}, 'POST'), res)
  assert.equal(res.code, 405)
  assert.equal(res.entetes['cache-control'], 'private, no-store')
  assert.ok(!etat.tables.includes('ota_reviews'), 'aucune lecture d avis sur un refus')
})

test('un membre SANS le droit avis est refuse en 403 AVANT toute lecture d avis', async () => {
  const etat = preparer({ ...MEMBRE_SUR_A, permissions: { avis: 'none', property_scope: 'all' } })
  const res = reponse()
  await require('../api/ecran/avis')(req({}, 'GET', PROD), res)
  assert.equal(res.code, 403)
  assert.equal(res.entetes['cache-control'], 'private, no-store')
  for (const t of ['ota_reviews', 'guest_evaluations', 'avis_auto_validation']) assert.ok(!etat.tables.includes(t), `${t} lue avant le refus`)
})

test('un membre limite a un bien : le MEME perimetre que l action `cartes`, et un bien hors perimetre est refuse', async () => {
  preparer(MEMBRE_SUR_A)
  const res = reponse()
  await require('../api/ecran/avis')(req({}, 'GET', PROD), res)
  assert.equal(res.code, 200, JSON.stringify(res.body))
  assert.deepEqual(res.body.biens.map(b => b.provider_property_id), [REF_A])
  const refs = [...res.body.cartes.attente, ...res.body.cartes.recents].map(c => c.bien_ref)
  assert.ok(refs.length && refs.every(r => r === REF_A), `une carte d un autre bien : ${refs}`)
  // Et l'action historique rend exactement la meme liste de biens.
  preparer(MEMBRE_SUR_A)
  const viaAction = reponse()
  await require('../api/avis')({ ...req({ action: 'cartes' }, 'GET', PROD) }, viaAction)
  assert.deepEqual(viaAction.body.biens, res.body.biens)

  preparer(MEMBRE_SUR_A)
  const hors = reponse()
  await require('../api/ecran/avis')(req({ bien: REF_B }, 'GET', PROD), hors)
  assert.equal(hors.code, 403)
})

test('le droit `reservations` decide du nom et des dates d un sejour : sans lui, ni l un ni les autres, ni la reservation dans la cle', async () => {
  preparer(MEMBRE_SUR_A)
  const sans = reponse()
  await require('../api/ecran/avis')(req({}, 'GET', PROD), sans)
  const c = [...sans.body.cartes.attente, ...sans.body.cartes.recents].find(x => x.bien_ref === REF_A)
  assert.ok(c, 'la carte de Colomiers')
  assert.deepEqual([c.voyageur, c.arrivee, c.depart], [null, null, null])
  assert.ok(!String(c.cle).includes('resa-a1'), `la reservation fuit par la cle : ${c.cle}`)
  for (const nom of ['Fanny', 'Fabienne', 'Durand', ARRIVEE_A, DEPART_A]) assert.ok(!JSON.stringify(sans.body).includes(nom), `« ${nom} » descend sans le droit reservations`)

  preparer({ ...MEMBRE_SUR_A, permissions: { ...MEMBRE_SUR_A.permissions, reservations: 'read' } })
  const avec = reponse()
  await require('../api/ecran/avis')(req({}, 'GET', PROD), avec)
  const c2 = [...avec.body.cartes.attente, ...avec.body.cartes.recents].find(x => x.bien_ref === REF_A)
  // Avec le droit : la RESERVATION du coeur fait foi (prenom et dates du snapshot).
  assert.equal(c2.voyageur && c2.voyageur.prenom, 'Fabienne')
  assert.deepEqual([c2.arrivee, c2.depart], [ARRIVEE_A, DEPART_A])
})

test('une detection des Anciens est servie meme section fermee (« À traiter » ne doit pas dire « rien »)', async () => {
  preparer({ avis: [AVIS_A, DETECTION_ANCIENNE] })
  const res = reponse()
  await require('../api/ecran/avis')(req({}), res)
  assert.equal(res.body.cartes.anciens, null)
  assert.deepEqual(res.body.anciens_a_traiter.map(c => c.avis[0].id), ['r9'])
  assert.ok(res.body.anciens_total >= 1)
  assert.equal(res.body.anciens_detection_seule, 1, 'la carte « detection seule » est comptee a part')
})

test('les detections des Anciens suivent le perimetre et le droit `reservations` (re-review du lot V5, B.3)', async () => {
  const surB = { ...DETECTION_ANCIENNE, id: 'r8', property_id_ref: REF_B }
  const surA = { ...DETECTION_ANCIENNE, guest_name: 'Gaston Lagaffe', stay_start: '2026-09-01', stay_end: '2026-09-03', booking_uid: 'resa-ga' }
  preparer({ ...MEMBRE_SUR_A, avis: [surA, surB], snapshots: [{ user_id: PROD, booking_id: 'resa-ga', snapshot: { firstName: 'Gaston', lastName: 'Lagaffe', arrival: '2026-09-01', departure: '2026-09-03' } }] })
  const res = reponse()
  await require('../api/ecran/avis')(req({}, 'GET', PROD), res)
  assert.equal(res.code, 200)
  assert.deepEqual(res.body.anciens_a_traiter.map(c => c.avis[0].id), ['r9'], 'la detection du logement B ne descend pas')
  const brut = JSON.stringify(res.body.anciens_a_traiter)
  for (const nom of ['Gaston', 'Lagaffe', 'resa-ga', '2026-09-01']) assert.ok(!brut.includes(nom), `« ${nom} » descend sans le droit reservations`)
})

test('une panne de lecture ne relaie JAMAIS le message brut de la base', async () => {
  preparer({ evalsEnPanne: true })
  const res = reponse()
  await require('../api/ecran/avis')(req({}), res)
  assert.equal(res.code, 503)
  assert.deepEqual(Object.keys(res.body), ['error'])
  assert.ok(!JSON.stringify(res.body).includes('10.0.0.12'))
})

test('la publication automatique illisible se tait : l ecran rend quand meme ses cartes', async () => {
  preparer({ autoEnPanne: true })
  const res = reponse()
  await require('../api/ecran/avis')(req({}), res)
  assert.equal(res.code, 200)
  assert.equal(res.body.publication_auto, null)
  assert.ok(res.body.cartes)
})

test('un bien archive ne figure pas dans la liste de choix', async () => {
  preparer({ biens: [BIEN_A, { ...BIEN_B, archive_le: '2026-11-03T10:00:00Z' }] })
  const res = reponse()
  await require('../api/ecran/avis')(req({}), res)
  assert.deepEqual(res.body.biens.map(b => b.name), ['Colomiers'])
})

// ─── lib/compte-requetes.js ─────────────────────────────────────────────────
test('compterRequetes : compte les requetes Supabase de SA requete seulement, meme en parallele', async () => {
  const { compterRequetes } = require('../lib/compte-requetes')
  const vrai = globalThis.fetch
  const appels = []
  globalThis.fetch = async (url) => { appels.push(String(url)); await new Promise(r => setTimeout(r, 1)); return { ok: true } }
  try {
    const base = process.env.SUPABASE_URL
    const [a, b] = await Promise.all([
      compterRequetes(async () => { await fetch(base + '/rest/v1/x'); await fetch(base + '/rest/v1/y'); await fetch('https://api.channex.io/z'); return 'a' }),
      compterRequetes(async () => { await Promise.all([fetch(base + '/rest/v1/w'), fetch(base + '/rest/v1/v'), fetch(base + '/rest/v1/u')]); return 'b' }),
    ])
    assert.deepEqual([a.resultat, a.requetes], ['a', 2], 'un appel partenaire n est pas une requete Supabase')
    assert.deepEqual([b.resultat, b.requetes], ['b', 3])
    // Hors d'une requete comptee, rien n'est compte, et l'appel passe.
    await fetch(base + '/rest/v1/hors')
    assert.equal(appels.length, 7)
    // Poser deux fois n'empile pas deux enveloppes (chaque requete compterait double).
    const c = await compterRequetes(async () => { await fetch(base + '/rest/v1/t') })
    assert.equal(c.requetes, 1)
  } finally { globalThis.fetch = vrai }
})

test('compterRequetes : un comptage qui leve ne casse pas l appel ; l erreur de la lecture, elle, remonte', async () => {
  const { compterRequetes } = require('../lib/compte-requetes')
  const vrai = globalThis.fetch
  globalThis.fetch = async () => 'reponse du vrai fetch'
  try {
    // Revue du lot V5, constat 10 : une cible dont la lecture de l'URL leve fait
    // lever le COMPTAGE ; l'appel doit passer quand meme, avec la reponse du
    // vrai `fetch`.
    const piege = { get url () { throw new Error('url illisible') } }
    const { resultat, requetes } = await compterRequetes(() => fetch(piege))
    assert.equal(resultat, 'reponse du vrai fetch')
    assert.equal(requetes, 0)
  } finally { globalThis.fetch = vrai }
  await assert.rejects(compterRequetes(async () => { throw new Error('lecture') }), /lecture/)
})
