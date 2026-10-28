// tests/classify-snapshots-bornes.test.js
// LE DEFAUT : la classification lisait TOUT l'historique du bien pour nommer
// les voyageurs de quelques fils.
//
//   .from('bookings_snapshot').select('booking_id, snapshot')
//     .eq('property_id', String(property.id))
//
// Pas de `user_id`, pas de fenetre, pas de limite, et `error` jamais lu.
// Mesure du 22 octobre 2026 en PRODUCTION : 827 lignes pour La bulle, 651 pour
// Coeur de vie 23 — PostgREST coupe a 1000 SANS ERREUR. A 173 lignes du
// plafond, et ce qui disparait d'abord est le nom, l'arrivee et le depart
// passes au modele : le voyageur recoit une reponse batie sur une fiche vide.
//
// Les trois proprietes gardees ici, et pas la forme de la requete :
//   1. la lecture est CLOISONNEE par compte et BORNEE aux fils en main ;
//   2. une lecture en echec arrete la classification SANS lever — sinon elle
//      emporterait les codes d'acces du meme `try` (incident du 10 septembre) ;
//   3. au plafond de PostgREST, on refuse plutot que de nommer les voyageurs
//      avec une liste coupee.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'cle-test'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const PROP = '0db6b39b-b8f6-4bbf-bb20-4c73e3e769d4'
const USER = 'u-hote'
// Trois fils, dont un sans identifiant de reservation.
const FILS = [
  { bookingId: 'B1', sender: 'guest', message: 'Bonjour', time: '2026-10-21T08:00:00Z' },
  { bookingId: 'B1', sender: 'host',  message: 'Bonjour !', time: '2026-10-21T09:00:00Z' },
  { bookingId: 'B2', sender: 'guest', message: 'Le code ?', time: '2026-10-21T10:00:00Z' },
  { bookingId: null, sender: 'guest', message: 'Sans resa', time: '2026-10-21T11:00:00Z' }
]

// Double de `lib/cron-shared` + de `lib/channels`. `snapshots` decide ce que
// rend la lecture du coeur : des lignes, une erreur, ou le plafond.
function charger ({ snapshots }) {
  const vu = { snapshotQueries: [], tables: [], rpc: [] }

  const table = (nom) => {
    const f = { eq: {}, in: null }
    const q = {
      select () { return q },
      eq (col, val) { f.eq[col] = String(val); return q },
      in (col, vals) { if (col === 'booking_id') f.in = vals.slice(); return q },
      is () { return q }, not () { return q }, neq () { return q },
      gte () { return q }, lte () { return q }, gt () { return q },
      order () { return q },
      update () { vu.majAgentTasks = (vu.majAgentTasks || 0) + 1; return q },
      insert () { return Promise.resolve({ error: null }) },
      limit () { return rendre() },
      maybeSingle: async () => ({ data: null, error: null }),
      then (res, rej) { return rendre().then(res, rej) }
    }
    function rendre () {
      vu.tables.push(nom)
      if (nom === 'bookings_snapshot') {
        vu.snapshotQueries.push({ eq: { ...f.eq }, in: f.in })
        if (snapshots === 'erreur') return Promise.resolve({ data: null, error: { message: 'panne transitoire' } })
        if (snapshots === 'doublons') {
          // Plus de lignes que d identifiants demandes : l unicite
          // (user_id, booking_id) ne tiendrait pas, et la suite ne serait plus
          // fiable. C est ce qui se CONSTATE — le plafond de PostgREST, lui,
          // est arithmetiquement hors d atteinte sur un lot de 100 (constat 9).
          return Promise.resolve({ data: [
            { booking_id: 'B1', snapshot: {} }, { booking_id: 'B1', snapshot: {} },
            { booking_id: 'B2', snapshot: {} }
          ], error: null })
        }
        return Promise.resolve({ data: snapshots, error: null })
      }
      // Les gardes par fil tranchent « deja traite » : le fil s arrete avant
      // tout appel au modele. Ce fichier garde la LECTURE DU COEUR, pas la
      // classification — un appel IA ici ne serait que du bruit.
      if (nom === 'agent_tasks') return Promise.resolve({ data: [{ id: 't', created_at: '2026-10-22T00:00:00Z' }], error: null })
      return Promise.resolve({ data: [], error: null })
    }
    return q
  }

  const absShared = require.resolve(path.join(__dirname, '..', 'lib/cron-shared.js'))
  const mShared = new Module(absShared)
  mShared.exports = {
    // ⚠ `rpc` EXISTE ICI, ET C'ETAIT LE CONSTAT 4 DE LA REVIEW.
    // Mon faux client n'en avait pas : `chargerLesGardesDesFils` levait, son
    // `catch` ramenait la lecture par fil, et ce fichier — cense garder la
    // nouvelle lecture — n'exercait JAMAIS la branche groupee. La suite etait
    // verte et la sortie imprimait « appel tombe, retour a la lecture par fil :
    // supabase.rpc is not a function », que personne ne lisait.
    supabase: {
      from: table,
      rpc: async (nom, args) => {
        vu.rpc.push({ nom, ids: (args.p_book_ids || []).slice() })
        // Une tache de classification recente : les fils sont « deja traites »
        // et s arretent avant le modele. Ce fichier garde la LECTURE DU COEUR.
        if (nom === 'cron_derniere_tache_classif') {
          // ⚠ B2 N'A PAS DE TACHE RECENTE, ET C'EST VOLONTAIRE (constat 5 de la
          // re-review). En rendant une tache pour TOUS les fils, mon double les
          // faisait tous sortir sur `hasNewerTaskOrConv` : retirer
          // `if (ficheIllisible) continue` laissait le fichier a 4/4 — mesure
          // faite. La moitie « on ne batit pas un prompt sur une fiche qu'on
          // n'a pas lue » n'etait donc gardee par rien. B2 n'est arrete que par
          // elle.
          return {
            data: (args.p_book_ids || []).filter(b => b !== 'B2')
              .map(b => ({ book_id: b, created_at: '2026-10-22T00:00:00Z' })),
            error: null
          }
        }
        // Une tache « recu pendant la pause » ANTERIEURE a la reponse de l hote
        // sur le fil B1 : elle doit se fermer meme quand le coeur est illisible.
        if (nom === 'cron_taches_pause_ouvertes') {
          return { data: [{ book_id: 'B1', id: 'pause-1', created_at: '2026-10-20T00:00:00Z' }], error: null }
        }
        return { data: [], error: null }
      }
    },
    getPropertyMode: async () => 'test', lireReglagesDuBien: async () => ({ mode: 'test', delais: null }),
    isAutomationPaused: async () => false,
    surAppel: () => {}
  }
  mShared.loaded = true
  require.cache[absShared] = mShared

  const absCanaux = require.resolve(path.join(__dirname, '..', 'lib/channels/index.js'))
  const mCanaux = new Module(absCanaux)
  mCanaux.exports = { getProvider: () => ({ getPropertyMessages: async () => FILS }) }
  mCanaux.loaded = true
  require.cache[absCanaux] = mCanaux

  delete require.cache[require.resolve('../lib/cron-classify')]
  const mod = require('../lib/cron-classify')
  return { mod, vu }
}

const bien = { id: PROP, name: 'La bulle', provider: 'channex' }
const resultats = () => ({ errors: [], totalMessages: 0, totalTasks: 0 })

test('LE TEST QUI COMPTE : la lecture du coeur porte user_id ET la liste des fils', async () => {
  const { mod, vu } = charger({ snapshots: [{ booking_id: 'B1', snapshot: { firstName: 'Ana' } }] })
  await mod.processChannelPropertyMessages(USER, bien, resultats())

  assert.ok(vu.snapshotQueries.length >= 1, 'le coeur est bien lu')
  const q = vu.snapshotQueries[0]
  assert.equal(q.eq.user_id, USER, 'CLOISONNEE PAR COMPTE : property_id est une cle provider, elle ne suffit pas')
  assert.equal(q.eq.property_id, PROP)
  assert.ok(Array.isArray(q.in), 'BORNEE : la lecture demande des identifiants, pas tout l historique')
  assert.deepEqual(q.in.slice().sort(), ['B1', 'B2'], 'les fils en main, et le fil sans reservation ecarte')

  // ⚠ DEUX LISTES, UNE PAR USAGE (constat 1). Le coeur n'a pas de fiche pour
  // un fil sans reservation ; les GARDES, elles, doivent le couvrir, sinon
  // elles repondent « pas encore traite » a chaque cycle.
  assert.ok(vu.rpc.length >= 3, 'la branche GROUPEE a bien tourne — trois appels, pas un repli')
  assert.deepEqual(vu.rpc[0].ids.slice().sort(), ['B1', 'B2', 'unknown'],
    'les gardes couvrent AUSSI le fil sans reservation')
})

test('LE TEST QUI COMPTE : la branche groupee tourne, aucun repli silencieux', async () => {
  // Le compteur de repli doit rester vide : un repli PERMANENT — nom de RPC
  // mal tape, droit oublie, migration defaite — ferait tourner le cron plus
  // cher, pour toujours, et `results.gardesParFil` est le seul signal.
  const { mod, vu } = charger({ snapshots: [{ booking_id: 'B1', snapshot: { firstName: 'Ana' } }] })
  const res = resultats()
  await mod.processChannelPropertyMessages(USER, bien, res)
  assert.equal(res.gardesParFil, undefined, 'aucun repli vers la lecture par fil')
  assert.deepEqual(vu.rpc.map(x => x.nom).sort(),
    ['cron_derniere_reponse_hote', 'cron_derniere_tache_classif', 'cron_taches_pause_ouvertes'],
    'les trois gardes ont bien ete demandees, par leur nom')
})

test('LE TEST QUI COMPTE : une lecture du coeur en echec n emporte PAS les codes d acces', async () => {
  const { mod, vu } = charger({ snapshots: 'erreur' })
  const res = resultats()
  // Ne LEVE pas : l appelant enveloppe cette fonction et processArrivalCodes
  // dans le MEME try. Une exception ici couterait le PIN du voyageur.
  await mod.processChannelPropertyMessages(USER, bien, res)
  assert.equal(res.totalMessages, 0, 'rien n est classifie sur une fiche qu on n a pas lue')
  assert.equal(res.errors.length, 1, 'et l echec est COMPTE, pas avale')
  assert.equal(res.errors[0].context, 'classify_snapshots')
  // ⚠ CONSTAT 11 : ET LA FERMETURE DES TACHES DE PAUSE A QUAND MEME EU LIEU.
  // Mon premier correctif rendait la main tout de suite, ce qui emportait une
  // decision du 9 octobre 2026 qui ne lit NI snapshot NI fiche : l hote avait
  // repondu au voyageur et sa tache restait ouverte dans « A valider ».
  assert.equal(vu.majAgentTasks, 1, 'la tache « recu pendant la pause » s est fermee malgre la panne')
  // ⚠ ET L'AUTRE MOITIE : B2 n'a aucune tache recente, donc SEULE la garde de
  // la fiche l'empeche de partir chez le modele. Si elle disparait, le fil
  // atteint `classifyAndHandle`, le client Anthropic absent leve, et une
  // SECONDE erreur apparait ici.
  assert.equal(res.errors.length, 1, 'aucun fil n est parti chez le modele sans sa fiche')
})

test('LE TEST QUI COMPTE : plus de lignes que d identifiants, on refuse de nommer a l aveugle', async () => {
  // ⚠ CONSTAT 9 : MA PREMIERE VERSION COMPARAIT AU PLAFOND DE POSTGREST (1000).
  // Avec des lots de 100 identifiants et l unicite (user_id, booking_id) de
  // `bookings_snapshot`, ce seuil est INATTEIGNABLE : c etait du code mort, qui
  // donnait l impression que la classe de defauts etait fermee partout. Ce qui
  // se verifie vraiment, c est l HYPOTHESE sur laquelle le lot repose.
  const { mod } = charger({ snapshots: 'doublons' })
  const res = resultats()
  await mod.processChannelPropertyMessages(USER, bien, res)
  assert.equal(res.errors.length, 1)
  assert.equal(res.errors[0].context, 'classify_snapshots_en_double')
  assert.match(res.errors[0].error, /3 lignes pour 2 identifiants/)
})
