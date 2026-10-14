// tests/menages-valider.test.js
// « Vu » : la prestataire valide un ménage qui est déjà le sien, et les deux
// relances qui la poursuivent tant qu'elle ne l'a pas fait (14 octobre 2026).
//
// ⚠ CE QUI EST EN JEU. Un ménage ATTRIBUÉ D'OFFICE naît `accepted` : elle n'a
// rien à confirmer, personne ne lui demande rien, et rien ne garantit qu'elle
// l'a lu — alors que l'hôte le croit confié. Trois fautes possibles :
//   1. valider le ménage de QUELQU'UN D'AUTRE : l'alerte de l'hôte s'éteint et
//      les deux relances se taisent sur une personne qui n'a rien lu ;
//   2. déplacer la date à chaque tape : l'hôte lirait « vu à 9 h 02 » sur un
//      ménage vu à 7 h 40, et la relance de 9 h aurait l'air déclenchée pour
//      rien ;
//   3. relancer deux fois le même jour : une prestataire qui reçoit deux fois
//      le même SMS cesse de les lire — et c'est tout ce que ce lot achète.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const U = 'compte-1', TOKEN = 'regina-x', REGINA = 'p-regina', LENA = 'p-lena'
const BIEN = '209413', BOOK = 'b1', DEPART = '2026-10-15'

// ─────────────────────────────────────────────────────────────────────────────
// L'ENDPOINT
// ─────────────────────────────────────────────────────────────────────────────

function preparerEndpoint ({ profil = { id: REGINA, first_name: 'Régina', active: true },
                             menage = { id: 'm1', provider_id: REGINA, vu_le: null },
                             erreurMaj = null } = {}) {
  const etat = { majs: [] }
  const client = {
    from (table) {
      const a = { table, f: {} }
      const chain = {
        select () { return chain },
        eq (c, v) { a.f[c] = v; return chain },
        is (c, v) { a.f[`is:${c}`] = v; return chain },
        maybeSingle () {
          if (table === 'public_tokens') {
            return Promise.resolve({ data: a.f.token === TOKEN ? { user_id: U } : null, error: null })
          }
          // ⚠ LES FILTRES SONT HONORÉS. Un double qui rend la ligne quels que
          // soient les `.eq()` rend indétectable la garde de cloisonnement :
          // retirer `.eq('pwa_token')` laisserait toute la suite au vert.
          if (table === 'profiles') {
            const bon = a.f.account_user_id === U && a.f.pwa_token === TOKEN
            return Promise.resolve({ data: bon ? profil : null, error: null })
          }
          if (table === 'menages') {
            // La relecture d'après zéro ligne : la ligne telle qu'elle est.
            const bon = a.f.user_id === U && String(a.f.property_id) === BIEN &&
                        String(a.f.booking_id) === BOOK && a.f.departure_date === DEPART &&
                        a.f.provider_id === profil.id
            return Promise.resolve({ data: bon ? menage : null, error: null })
          }
          return Promise.resolve({ data: null, error: null })
        },
        update (row) {
          const q = { row, f: {}, is: {} }
          const c2 = {
            eq (c, v) { q.f[c] = v; return c2 },
            is (c, v) { q.is[c] = v; return c2 },
            select () {
              etat.majs.push({ table, ...q })
              // ⚠ LE DOUBLE APPLIQUE LES CONDITIONS, comme PostgREST : c'est
              // la seule façon qu'un retrait de `.eq('provider_id')` ou de
              // `.is('vu_le', null)` fasse rougir quelque chose.
              const sienne = q.f.provider_id === profil.id &&
                             q.f.user_id === U &&
                             String(q.f.property_id) === BIEN &&
                             String(q.f.booking_id) === BOOK &&
                             q.f.departure_date === DEPART
              const bonMenage = menage && menage.provider_id === profil.id
              const pasDejaVu = !('vu_le' in q.is) || !menage || menage.vu_le === null
              const ok = sienne && bonMenage && pasDejaVu
              return Promise.resolve({
                data: ok ? [{ id: 'm1', vu_le: row.vu_le }] : [], error: erreurMaj })
            }
          }
          return c2
        },
        then (ok) { return Promise.resolve({ data: [], error: null }).then(ok) }
      }
      return chain
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  for (const mod of ['../api/menages-public', '../lib/stats-avis', '../lib/attribution-prestataire',
                     '../lib/cron-property-status', '../lib/founder-notify',
                     '../lib/cleaning/assign']) {
    try { delete require.cache[require.resolve(mod)] } catch {}
  }
  return etat
}

function reponse () {
  const r = { code: 200, corps: null, entetes: {} }
  r.setHeader = (k, v) => { r.entetes[k] = v }
  r.status = (c) => { r.code = c; return r }
  r.json = (b) => { r.corps = b; return r }
  r.end = () => r
  return r
}

const appelerValider = async (corps = {}) => {
  const handler = require('../api/menages-public')
  const res = reponse()
  await handler({
    method: 'POST', query: { token: TOKEN },
    body: { action: 'validerMenage', property_id: BIEN, booking_id: BOOK,
            departure_date: DEPART, ...corps }
  }, res)
  return res
}

test('« Vu » pose la date sur SON ménage, et le dit', async () => {
  const etat = preparerEndpoint()
  const res = await appelerValider()
  assert.equal(res.code, 200)
  assert.equal(res.corps.success, true)
  assert.ok(res.corps.vu_le, 'la date est rendue : l\'écran la garde plutôt que l\'instant du clic')
  assert.equal(etat.majs.length, 1)
  assert.ok(etat.majs[0].row.vu_le, 'et elle est écrite')
})

test('elle ne peut PAS valider le ménage d\'une collègue', async () => {
  // ⚠ LA FAUTE LA PLUS GRAVE DE CE LOT. Éteindre l'alerte de l'hôte et les
  // deux relances sur quelqu'un qui n'a rien lu, c'est exactement le contraire
  // de ce que ce bouton existe pour dire.
  const etat = preparerEndpoint({ menage: { id: 'm1', provider_id: LENA, vu_le: null } })
  const res = await appelerValider()
  assert.equal(res.code, 404)
  // La condition est DANS l'update : elle a bien été posée.
  assert.equal(etat.majs[0].f.provider_id, REGINA)
})

test('deux tapes ne déplacent pas la date : le geste est idempotent', async () => {
  // ⚠ `vu_le is null` DANS L'UPDATE. Sans lui, un second envoi (réseau lent,
  // double tape) réécrirait la date : l'hôte lirait « vu à 9 h 02 » sur un
  // ménage vu à 7 h 40, et la relance de 9 h aurait l'air déclenchée pour rien.
  const dejaVu = '2026-10-14T07:40:00.000Z'
  const etat = preparerEndpoint({ menage: { id: 'm1', provider_id: REGINA, vu_le: dejaVu } })
  const res = await appelerValider()
  assert.equal(res.code, 200, 'et ce n\'est pas une erreur : son écran doit finir coché')
  assert.equal(res.corps.vu_le, dejaVu, 'la PREMIÈRE date, pas la seconde')
  assert.equal(etat.majs[0].is.vu_le, null, 'la garde est bien posée en base')
})

test('un jeton sans profil actif ne valide rien', async () => {
  const etat = preparerEndpoint({ profil: { id: REGINA, first_name: 'Régina', active: false } })
  const res = await appelerValider()
  assert.equal(res.code, 401)
  assert.equal(etat.majs.length, 0, 'aucune écriture tentée')
})

test('une date mal formée est refusée AVANT toute lecture', async () => {
  // ⚠ LE MÊME DÉFAUT QUE `prendreMenage` : « 2026-9-7 » retrouve la ligne en
  // Postgres tout en passant à côté d'une comparaison de chaînes.
  const etat = preparerEndpoint()
  const res = await appelerValider({ departure_date: '2026-9-7' })
  assert.equal(res.code, 400)
  assert.equal(etat.majs.length, 0)
})

// ─────────────────────────────────────────────────────────────────────────────
// LES DEUX RELANCES
// ─────────────────────────────────────────────────────────────────────────────

function preparerRelance ({ menages = [], erreurLecture = null, erreurMarqueur = null } = {}) {
  const etat = { notifs: [], marqueurs: [], lu: null }
  const client = {
    from (table) {
      const a = { table, f: {}, in: {}, is: {}, not: {} }
      const chain = {
        select () { return chain },
        eq (c, v) { a.f[c] = v; return chain },
        in (c, v) { a.in[c] = v; return chain },
        is (c, v) { a.is[c] = v; return chain },
        not (c, op, v) { a.not[c] = [op, v]; return chain },
        order () { return chain },
        limit () {
          if (table === 'menages') {
            etat.lu = a
            if (erreurLecture) return Promise.resolve({ data: null, error: erreurLecture })
            // ⚠ LE DOUBLE APPLIQUE LES FILTRES. Sans cela, retirer
            // `.is('vu_le', null)` ou `.eq('status','accepted')` du module ne
            // casserait rien — et ce sont eux qui empêchent de relancer un
            // ménage déjà validé, ou une PROPOSITION (qui a sa propre boucle).
            const jours = a.in.departure_date || []
            return Promise.resolve({
              data: menages.filter(m =>
                jours.includes(m.departure_date) &&
                (a.f.status === undefined || m.status === a.f.status) &&
                (!('vu_le' in a.is) || m.vu_le === null) &&
                (!a.not.provider_id || m.provider_id !== null)),
              error: null })
          }
          return Promise.resolve({ data: [], error: null })
        },
        update (row) {
          const q = { row, f: {} }
          const c2 = {
            eq (c, v) {
              q.f[c] = v
              etat.marqueurs.push({ id: v, row })
              return Promise.resolve({ error: erreurMarqueur })
            }
          }
          return c2
        },
        then (ok) {
          if (table === 'properties') {
            return Promise.resolve({
              data: [{ id: BIEN, user_id: U, name: 'La bulle' }], error: null }).then(ok)
          }
          return Promise.resolve({ data: [], error: null }).then(ok)
        }
      }
      return chain
    }
  }
  const abs = require.resolve(path.join(__dirname, '..', 'node_modules/@supabase/supabase-js'))
  const m = new Module(abs); m.exports = { createClient: () => client }; m.loaded = true
  require.cache[abs] = m
  // ⚠ Sans ce double, le module enverrait un VRAI SMS depuis les tests.
  const absPresta = require.resolve(path.join(__dirname, '..', 'lib/cleaning/notifier-prestataire.js'))
  const mp = new Module(absPresta)
  mp.exports = {
    notifierValidationAttendue: async (o) => { etat.notifs.push(o); return { sms: true, email: false } }
  }
  mp.loaded = true
  require.cache[absPresta] = mp
  try { delete require.cache[require.resolve('../lib/cleaning/relance-validation')] } catch {}
  return etat
}

const DOFFICE = (o = {}) => ({
  id: 'm1', user_id: U, property_id: BIEN, provider_id: REGINA,
  departure_date: DEPART, status: 'accepted', vu_le: null,
  relance_vu_j1_le: null, relance_vu_j0_le: null, ...o
})

// ⚠ LE TEMPS EST INJECTÉ, donc les dates sont FIGÉES : règle du dépôt.
const A_NEUF_HEURES = new Date('2026-10-14T09:05:00+02:00')   // J−1 du 15
const A_SEPT_HEURES = new Date('2026-10-14T07:05:00+02:00')

test('relance : avant 9 h de Paris, rien ne part et rien n\'est marqué', async () => {
  // ⚠ ET RIEN N'EST MARQUÉ NON PLUS : marquer ici ferait sauter la relance de
  // 9 h pour toujours. Le cycle de 5 minutes repasse.
  const etat = preparerRelance({ menages: [DOFFICE()] })
  const { relancerValidations } = require('../lib/cleaning/relance-validation')
  const bilan = await relancerValidations({}, { maintenant: A_SEPT_HEURES })
  assert.equal(bilan.differe, true)
  assert.equal(etat.notifs.length, 0)
  assert.equal(etat.marqueurs.length, 0)
})

test('relance : la veille à 9 h, un ménage d\'office non validé est relancé une fois', async () => {
  const etat = preparerRelance({ menages: [DOFFICE()] })
  const { relancerValidations } = require('../lib/cleaning/relance-validation')
  const bilan = await relancerValidations({}, { maintenant: A_NEUF_HEURES })
  assert.equal(bilan.relances, 1)
  assert.equal(etat.notifs.length, 1)
  assert.equal(etat.notifs[0].providerId, REGINA)
  assert.equal(etat.notifs[0].leJour, false, 'c\'est le message de la VEILLE')
  assert.equal(etat.notifs[0].propertyName, 'La bulle', 'et il nomme le logement')
  assert.equal(etat.marqueurs.length, 1)
  assert.ok(etat.marqueurs[0].row.relance_vu_j1_le, 'le marqueur de la veille, pas celui du jour')
})

test('relance : le jour même, c\'est l\'autre message et l\'autre marqueur', async () => {
  const etat = preparerRelance({ menages: [DOFFICE({ departure_date: '2026-10-14' })] })
  const { relancerValidations } = require('../lib/cleaning/relance-validation')
  await relancerValidations({}, { maintenant: A_NEUF_HEURES })
  assert.equal(etat.notifs.length, 1)
  assert.equal(etat.notifs[0].leJour, true)
  assert.ok(etat.marqueurs[0].row.relance_vu_j0_le)
})

test('relance : DEUX FOIS LE MÊME JOUR, JAMAIS — le marqueur tient', async () => {
  // Une prestataire qui reçoit deux fois le même SMS cesse de les lire.
  const etat = preparerRelance({
    menages: [DOFFICE({ relance_vu_j1_le: '2026-10-14T07:00:00Z' })] })
  const { relancerValidations } = require('../lib/cleaning/relance-validation')
  const bilan = await relancerValidations({}, { maintenant: A_NEUF_HEURES })
  assert.equal(bilan.examines, 0)
  assert.equal(etat.notifs.length, 0)
})

test('relance : la veille marquée ne bloque pas celle du jour même', async () => {
  // Deux marqueurs séparés, et c'est pour cela : un seul aurait fait sauter le
  // dernier rappel, celui qui précède le départ du voyageur.
  const etat = preparerRelance({
    menages: [DOFFICE({ departure_date: '2026-10-14', relance_vu_j1_le: '2026-10-13T07:00:00Z' })] })
  const { relancerValidations } = require('../lib/cleaning/relance-validation')
  await relancerValidations({}, { maintenant: A_NEUF_HEURES })
  assert.equal(etat.notifs.length, 1)
  assert.equal(etat.notifs[0].leJour, true)
})

test('relance : un ménage DÉJÀ VALIDÉ n\'est pas relancé', async () => {
  const etat = preparerRelance({ menages: [DOFFICE({ vu_le: '2026-10-13T18:00:00Z' })] })
  const { relancerValidations } = require('../lib/cleaning/relance-validation')
  await relancerValidations({}, { maintenant: A_NEUF_HEURES })
  assert.equal(etat.notifs.length, 0)
})

test('relance : une PROPOSITION n\'est pas relancée — elle a sa propre boucle', async () => {
  // Lui dire « validez » quand on attend « acceptez » la ferait répondre à
  // côté, et l'offre expirerait quand même.
  const etat = preparerRelance({ menages: [DOFFICE({ status: 'offered' })] })
  const { relancerValidations } = require('../lib/cleaning/relance-validation')
  await relancerValidations({}, { maintenant: A_NEUF_HEURES })
  assert.equal(etat.notifs.length, 0)
})

test('relance : un ménage que PERSONNE ne porte n\'est relancé chez personne', async () => {
  const etat = preparerRelance({ menages: [DOFFICE({ provider_id: null })] })
  const { relancerValidations } = require('../lib/cleaning/relance-validation')
  await relancerValidations({}, { maintenant: A_NEUF_HEURES })
  assert.equal(etat.notifs.length, 0)
})

test('relance : DEUX JOURS SEULEMENT — la garde d\'envoi de masse', async () => {
  // ⚠ REVIEW.md RÈGLE 2. Sans cette borne, la première activation d'un compte
  // Channex enverrait un SMS par réservation future de l'historique.
  const etat = preparerRelance({ menages: [DOFFICE({ departure_date: '2026-11-20' })] })
  const { relancerValidations } = require('../lib/cleaning/relance-validation')
  await relancerValidations({}, { maintenant: A_NEUF_HEURES })
  assert.equal(etat.notifs.length, 0)
  assert.deepEqual(etat.lu.in.departure_date, ['2026-10-14', '2026-10-15'],
    'la requête elle-même ne demande que deux jours')
})

test('relance : une panne de lecture est RAPPORTÉE, pas avalée', async () => {
  // Un cron à 200 qui n'a rien fait est le pire des deux mondes : on diagnostique
  // en lisant `results.errors`, pas le code HTTP.
  const results = { errors: [] }
  preparerRelance({ menages: [DOFFICE()], erreurLecture: { message: 'timeout' } })
  const { relancerValidations } = require('../lib/cleaning/relance-validation')
  const bilan = await relancerValidations(results, { maintenant: A_NEUF_HEURES })
  assert.equal(bilan.erreurs, 1)
  assert.equal(results.errors.length, 1)
  assert.equal(results.errors[0].context, 'relance_validation')
})

test('relance : un marqueur qui ne se pose pas est CRIÉ, et ne compte pas', async () => {
  // ⚠ C'est le seul défaut de ce module qui se paie chez la prestataire : au
  // cycle suivant, elle recevrait le même SMS.
  const etat = preparerRelance({ menages: [DOFFICE()], erreurMarqueur: { message: 'ko' } })
  const { relancerValidations } = require('../lib/cleaning/relance-validation')
  const bilan = await relancerValidations({}, { maintenant: A_NEUF_HEURES })
  assert.equal(etat.notifs.length, 1, 'le SMS est parti')
  assert.equal(bilan.erreurs, 1, 'et l\'échec du marqueur est compté')
  assert.equal(bilan.relances, 0)
})
