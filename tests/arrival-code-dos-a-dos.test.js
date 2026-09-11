// tests/arrival-code-dos-a-dos.test.js
//
// ⚠ L'INCIDENT QUE CES TESTS FERMENT — 11 septembre 2026, premiere arrivee
// reelle apres la bascule Channex.
//
// Une voyageuse est arrivee devant une porte fermee. Aucun code sur la serrure
// (verifie chez Seam : 0 code sur l'appareil), aucune ligne `access_codes`,
// aucun message porteur du PIN. Elle a du ecrire : « nous arrivons a bagneres
// de bigorre mais nous n'avons pas le code ».
//
// LA CAUSE N'ETAIT NI LA MIGRATION, NI LA SERRURE, NI LE TEMPLATE — tous
// verifies sains. `processArrivalCodes` choisissait le sejour du jour avec un
// `.find()`, donc UN seul. La fenetre de rattrapage introduite le 7 juillet
// (`arrival <= today && departure >= today`) est satisfaite par tous les
// voyageurs PRESENTS ce jour-la. Un jour de dos-a-dos en compte deux :
//
//    92802963   10/09 -> 11/09   le voyageur qui PART      <- rendu par find()
//    726e95e9   11/09 -> 12/09   la voyageuse qui ARRIVE   <- jamais examinee
//
// Le sortant avait deja son code et sa ligne de journal : le chemin se
// terminait sans rien faire. Et `.find()` s'arretant au premier, l'arrivante
// n'etait meme pas regardee.
//
// Ce n'est pas propre a Channex ni a un bien migre : c'est tout jour de
// dos-a-dos, chez les deux providers. Cinq arrivees a venir etaient exposees.
//
// CE QUI EST DEFENDU ICI : que TOUS les sejours presents soient rendus. Pas le
// premier, pas « le bon » choisi par un tri — un tri qui privilegierait
// l'arrivee du jour recreerait le meme angle mort a l'envers, en cessant de
// rattraper le sejour en cours.

const test = require('node:test')
const assert = require('node:assert')

// Le module instancie un client Supabase au chargement : on lui donne de quoi
// se construire. Aucun appel reseau — la fonction testee est pure.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const { sejoursPresents } = require('../lib/cron-arrival-code')

const BIEN = { id: '0db6b39b', provider: 'channex' }
const AUJ = '2026-09-11'

// Le cas reel, avec les identifiants de l'incident.
const SORTANT = { id: '92802963', arrival: '2026-09-10', departure: '2026-09-11', status: 'confirmed' }
const ARRIVANTE = { id: '726e95e9', arrival: '2026-09-11', departure: '2026-09-12', status: 'confirmed' }

test('dos-a-dos : le sortant ET l arrivante sont rendus, pas seulement le premier', () => {
  // Ordre du tableau tel que la base le rend : le sortant d'abord. C'est cet
  // ordre-la qui faisait rendre le mauvais sejour par `.find()`.
  const out = sejoursPresents([SORTANT, ARRIVANTE], AUJ, BIEN)
  const ids = out.map(b => b.id)
  assert.strictEqual(out.length, 2, 'les deux sejours presents doivent etre traites')
  assert.ok(ids.includes('726e95e9'), "l'ARRIVANTE doit etre traitee — c'est elle qui n'avait pas de code")
  assert.ok(ids.includes('92802963'), 'le SORTANT reste traite : la fenetre de rattrapage le veut')
})

test('l ordre du tableau source ne change pas le resultat', () => {
  const a = sejoursPresents([SORTANT, ARRIVANTE], AUJ, BIEN).map(b => b.id)
  const b = sejoursPresents([ARRIVANTE, SORTANT], AUJ, BIEN).map(b => b.id)
  assert.deepStrictEqual(a, b, 'la selection ne doit pas dependre de l ordre de la source')
  assert.deepStrictEqual(a, ['92802963', '726e95e9'], 'ordre deterministe : par arrivee, puis par id')
})

test('trois sejours qui se touchent : les trois sont rendus', () => {
  // La bulle enchaine 11->12, 12->13, 13->14. Le 12, deux sejours se touchent.
  const veille = { id: 'a', arrival: '2026-09-10', departure: '2026-09-11', status: 'confirmed' }
  const out = sejoursPresents([veille, SORTANT, ARRIVANTE], AUJ, BIEN)
  assert.strictEqual(out.length, 3)
})

test('un sejour deja parti est exclu, un sejour futur est exclu', () => {
  const parti = { id: 'p', arrival: '2026-09-08', departure: '2026-09-10', status: 'confirmed' }
  const futur = { id: 'f', arrival: '2026-09-12', departure: '2026-09-13', status: 'confirmed' }
  const out = sejoursPresents([parti, ARRIVANTE, futur], AUJ, BIEN).map(b => b.id)
  assert.deepStrictEqual(out, ['726e95e9'])
})

test('un sejour sans depart reste eligible (borne haute optionnelle)', () => {
  const sansFin = { id: 'sf', arrival: '2026-09-09', departure: null, status: 'confirmed' }
  const out = sejoursPresents([sansFin], AUJ, BIEN).map(b => b.id)
  assert.deepStrictEqual(out, ['sf'])
})

test('un sejour NEUTRALISE par le dedoublonnage ne repasse pas', () => {
  // Le jumeau Beds24 de l'arrivante, passe en `demapped` au dedoublonnage : il
  // porte les MEMES dates. S'il etait traite, un second code partirait sur la
  // serrure pour le meme sejour.
  const jumeau = { id: '92731980', arrival: '2026-09-11', departure: '2026-09-12', status: 'demapped' }
  const out = sejoursPresents([jumeau, ARRIVANTE], AUJ, BIEN).map(b => b.id)
  assert.deepStrictEqual(out, ['726e95e9'], 'seul le sejour vivant est traite')
})

test('une annulation n est pas un sejour present', () => {
  const annule = { ...ARRIVANTE, id: 'x', status: 'cancelled' }
  const out = sejoursPresents([annule], AUJ, BIEN).map(b => b.id)
  assert.deepStrictEqual(out, [])
})

// ⚠ LE VOCABULAIRE DU PROVIDER, PAS SEULEMENT LE VOCABULAIRE CANONIQUE.
// Releve en review : tous les cas ci-dessus emploient `confirmed` / `cancelled`
// / `demapped`, qui traversent `canonicalStatus` SANS consulter la table du
// provider. Retirer le 2e argument de `isActiveStatus(b, provider)` — une
// simplification credible, le commentaire voisin dit « le provider porte par un
// snapshot reste prioritaire » — laissait donc les 8 tests verts. En production
// ca posait un code sur la serrure et envoyait le PIN pour un BLOCAGE DE
// MAINTENANCE ou une simple DEMANDE non confirmee.
test('vocabulaire Beds24 : un blocage proprietaire n est pas un sejour', () => {
  const blocage = { id: 'b', arrival: '2026-09-10', departure: '2026-09-13', status: 'black' }
  const out = sejoursPresents([blocage], AUJ, { id: '0db6b39b', provider: 'beds24' }).map(b => b.id)
  assert.deepStrictEqual(out, [], 'un `black` Beds24 ne doit ni recevoir de code ni de PIN')
})

test('vocabulaire Beds24 : une demande non confirmee n est pas un sejour', () => {
  const demande = { id: 'i', arrival: '2026-09-10', departure: '2026-09-13', status: 'inquiry' }
  const out = sejoursPresents([demande], AUJ, { id: '0db6b39b', provider: 'beds24' }).map(b => b.id)
  assert.deepStrictEqual(out, [], 'une `inquiry` Beds24 n est pas un voyageur present')
})

test('un booking d un AUTRE bien est exclu quand la source le nomme', () => {
  // Source Beds24 : les bookings portent propertyId et la liste est mixte.
  const autre = { id: 'z', propertyId: '999999', arrival: '2026-09-11', departure: '2026-09-12', status: 'confirmed' }
  const mien = { id: 'm', propertyId: '0db6b39b', arrival: '2026-09-11', departure: '2026-09-12', status: 'confirmed' }
  const out = sejoursPresents([autre, mien], AUJ, { id: '0db6b39b', provider: 'beds24' }).map(b => b.id)
  assert.deepStrictEqual(out, ['m'])
})

// ═══════════════════════════════════════════════════════════════════════════
// LA BOUCLE ELLE-MEME — c'est LA qu'etait le bug
// ═══════════════════════════════════════════════════════════════════════════
// ⚠ RELEVE EN REVIEW : les tests ci-dessus defendent admirablement la fonction
// pure, et pas du tout ce qui la consomme. Mutation proposee par la review :
// remplacer `for (const sejour of presents)` par `const sejour = presents[0]`
// — les 8 tests restaient verts et l'incident etait restaure a l'identique.
//
// On traverse donc le VRAI `processArrivalCodes`, avec un double de
// `lib/cron-shared`, et on compte les sejours qui atteignent la creation du
// code. Le harnais est celui de tests/menage-valide.test.js : injection dans
// `require.cache` avant le chargement du module.

const path = require('node:path')
const Module = require('node:module')

function chargerAvecDouble ({ templates, accessCodeExistant }) {
  const vus = { access_codes: [], message_sent_log: [], inserts: [] }

  const table = (nom) => {
    const etat = { bookingId: null }
    const q = {
      select () { return q },
      insert (row) {
        if (nom === 'access_codes') vus.inserts.push(String(row.booking_id))
        return { select: () => ({ single: async () => ({ data: { id: 'neuf', ...row } }) }) }
      },
      eq (col, val) { if (col === 'booking_id') etat.bookingId = String(val); return q },
      neq () { return q },
      in () { return q },
      is () { return q },
      lte () { return q },
      gte () { return q },
      order () { return q },
      single: async () => ({ data: nom === 'locks' ? { seam_device_id: 'dev-1' } : null }),
      maybeSingle: async () => ({ data: null }),
      limit () {
        if (nom === 'access_codes') {
          vus.access_codes.push(etat.bookingId)
          if (accessCodeExistant === null) return Promise.resolve({ data: [] })
          // Une ligne DEJA complete : `ensureCodeCreated` rend la main tout de
          // suite. Aucun appel Seam, aucun INSERT — on observe le parcours,
          // on ne simule pas un provider.
          return Promise.resolve({ data: [accessCodeExistant] })
        }
        if (nom === 'message_sent_log') {
          vus.message_sent_log.push(etat.bookingId)
          // Deja envoye : `sendArrivalMessage` s'arrete. Le test porte sur la
          // BOUCLE, pas sur l'envoi.
          return Promise.resolve({ data: [{ id: 'deja' }] })
        }
        return Promise.resolve({ data: [] })
      },
      then (res, rej) {
        const data = nom === 'message_templates' ? templates : []
        return Promise.resolve({ data }).then(res, rej)
      }
    }
    return q
  }

  const abs = require.resolve(path.join(__dirname, '..', 'lib/cron-shared.js'))
  const m = new Module(abs)
  m.exports = {
    supabase: { from: table },
    getPropertyMode: async () => 'auto',
    isAutomationPaused: async () => false
  }
  m.loaded = true
  require.cache[abs] = m

  delete require.cache[require.resolve('../lib/cles-migrees')]
  delete require.cache[require.resolve('../lib/cron-arrival-code')]
  const mod = require('../lib/cron-arrival-code')
  return { mod, vus }
}

test('processArrivalCodes traite LES DEUX sejours du dos-a-dos, pas le premier', async () => {
  const { mod, vus } = chargerAvecDouble({
    templates: [{ id: 'tmpl-1', lock_id: 'lock-1', event_type: 'menage_done', active: true }],
    accessCodeExistant: { id: 'ac-1', seam_code_id: 'seam-1', code: '123456', status: 'active' }
  })

  // La date du jour, pour que la fenetre de rattrapage soit vraie quel que
  // soit le jour ou le test tourne (regle du depot sur l'horloge reelle).
  const auj = new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' })
  const hier = new Date(Date.now() - 86400000).toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' })
  const demain = new Date(Date.now() + 86400000).toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' })

  const sortant = { id: 'SORTANT', arrival: hier, departure: auj, status: 'confirmed', provider: 'channex' }
  const arrivante = { id: 'ARRIVANTE', arrival: auj, departure: demain, status: 'confirmed', provider: 'channex' }

  await mod.processArrivalCodes('u1', null,
    { id: '0db6b39b', name: 'La bulle', provider: 'channex' },
    [sortant, arrivante], {})

  const vusUniques = [...new Set(vus.access_codes.filter(Boolean))]
  assert.deepStrictEqual(vusUniques.sort(), ['ARRIVANTE', 'SORTANT'],
    "les deux sejours doivent atteindre la creation du code — c'est exactement ce que `.find()` empechait")
})

// ═══════════════════════════════════════════════════════════════════════════
// LA FENETRE DU CODE — ne pas poser un code deja mort
// ═══════════════════════════════════════════════════════════════════════════
test('fenetre revolue : le voyageur qui part en milieu de journee n a pas de code', () => {
  const { fenetreDuCode } = require('../lib/cron-arrival-code')
  // Le 12/09 a 15 h : checkout 11:00 + 1 h = 12:00, deja passe.
  const maintenant = new Date('2026-09-12T13:00:00Z')   // 15 h a Paris
  const f = fenetreDuCode('2026-09-12', '11:00', maintenant)
  assert.strictEqual(f.revolue, true,
    'un code dont la fin est passee ne doit pas etre cree : il resterait pending et alerterait l hote pour rien')
})

test('fenetre valide : l arrivante du jour a bien son code', () => {
  const { fenetreDuCode } = require('../lib/cron-arrival-code')
  const maintenant = new Date('2026-09-11T18:00:00Z')
  const f = fenetreDuCode('2026-09-12', '11:00', maintenant)
  assert.strictEqual(f.revolue, false)
  assert.ok(f.endsAt > f.startsAt)
})

test('sans date de depart : fenetre de 72 h, jamais revolue', () => {
  const { fenetreDuCode } = require('../lib/cron-arrival-code')
  const maintenant = new Date('2026-09-11T18:00:00Z')
  const f = fenetreDuCode(null, '11:00', maintenant)
  assert.strictEqual(f.revolue, false)
  assert.strictEqual(f.endsAt - f.startsAt, 72 * 3600 * 1000)
})

// ⚠ LA GARDE DE FENETRE, DANS SON CABLAGE — pas seulement dans la fonction pure.
// Une mutation `if (revolue)` -> `if (false)` restait verte tant que seul le
// calcul etait teste. On fige l'horloge pour que le verdict ne depende pas de
// l'heure a laquelle la suite tourne.
test('le sortant de la journee ne declenche AUCUNE creation de code', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-12T13:00:00Z') }) // 15 h a Paris
  const { mod, vus } = chargerAvecDouble({
    templates: [{ id: 'tmpl-1', lock_id: 'lock-1', event_type: 'menage_done', active: true }],
    accessCodeExistant: null        // aucune ligne : le chemin de creation est ouvert
  })
  const sortant = { id: 'SORTANT', arrival: '2026-09-11', departure: '2026-09-12', status: 'confirmed', provider: 'channex' }
  await mod.processArrivalCodes('u1', null,
    { id: '0db6b39b', name: 'La bulle', provider: 'channex' }, [sortant], {})
  assert.deepStrictEqual(vus.inserts, [],
    'checkout 11:00 + 1 h = 12:00, il est 15 h : creer le code poserait un code deja expire et alerterait l hote pour rien')
  t.mock.timers.reset()
})

test('l arrivante du jour, elle, declenche bien la creation', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-12T13:00:00Z') })
  const { mod, vus } = chargerAvecDouble({
    templates: [{ id: 'tmpl-1', lock_id: 'lock-1', event_type: 'menage_done', active: true }],
    accessCodeExistant: null
  })
  const arrivante = { id: 'ARRIVANTE', arrival: '2026-09-12', departure: '2026-09-13', status: 'confirmed', provider: 'channex' }
  await mod.processArrivalCodes('u1', null,
    { id: '0db6b39b', name: 'La bulle', provider: 'channex' }, [arrivante], {})
  assert.deepStrictEqual(vus.inserts, ['ARRIVANTE'],
    'la garde de fenetre ne doit pas bloquer une arrivee legitime')
  t.mock.timers.reset()
})
