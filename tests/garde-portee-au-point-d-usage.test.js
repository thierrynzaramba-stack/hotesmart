// tests/garde-portee-au-point-d-usage.test.js
// LE FAUX VERT QUE LA REVIEW A TROUVE, ET QU'IL FALLAIT FERMER.
//
// Le 14 septembre 2026, une garde AVEUGLE suspendait messages et codes d'acces
// sur des biens CHANNEX, parce que `processMessageTemplates` et
// `processArrivalCodes` sont partagees entre les deux boucles et demandaient a
// une cle Channex si elle etait une cle Beds24 migree.
//
// Le correctif (`motifNonSyncPourBien`) a ete livre avec six tests... qui
// l'exercaient EN ISOLATION. La review a remis la forme non bornee aux deux
// points d'usage — le defaut exact, integralement — et la suite entiere est
// restee VERTE : 2544 pass, 8 rouges dates, rien d'autre.
//
// ⚠ CE FICHIER TESTE L'INVARIANT METIER, PAS LA FORME : « la table des cles
// migrees est illisible ET le bien est Channex => on le traite quand meme ».
// Il charge les vraies fonctions et observe si elles vont plus loin que la
// garde. Aucune assertion sur du texte.

process.env.TZ = 'Europe/Paris'
process.env.SUPABASE_URL = 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = 'test-key'
process.env.CLAUDE_API_KEY = 'cle-test'

const test = require('node:test')
const assert = require('node:assert')

// ─── Les leurres, poses AVANT tout require du code teste ────────────────────
// `cron-shared` construit un client Supabase et un client Anthropic au
// chargement : sans leurre, ces tests partiraient en vrai reseau (28 s mesurees
// sur un autre fichier pour 0,3 s de calcul).
const journal = { lectures: [], pauseDemandee: 0 }

function fauxSupabase () {
  const req = (table, filtres = []) => {
    const p = Promise.resolve().then(() => {
      journal.lectures.push(table)
      // ⚠ LA PANNE, CIBLEE SUR LA SEULE TABLE DES CLES MIGREES.
      if (table === 'provider_keys_migrated') {
        return { data: null, error: { message: 'Gateway Timeout', code: null } }
      }
      return { data: [], error: null }
    })
    p.select = () => req(table, filtres)
    p.eq = () => req(table, filtres)
    p.in = () => req(table, filtres)
    p.gte = () => req(table, filtres)
    p.lte = () => req(table, filtres)
    p.not = () => req(table, filtres)
    p.is = () => req(table, filtres)
    p.order = () => req(table, filtres)
    p.limit = () => req(table, filtres)
    p.maybeSingle = () => Promise.resolve().then(() => { journal.lectures.push(table); return { data: null, error: null } })
    p.single = () => p.maybeSingle()
    p.insert = () => Promise.resolve({ error: null })
    p.update = () => { const q = Promise.resolve({ error: null }); q.eq = () => q; q.is = () => q; return q }
    p.upsert = () => Promise.resolve({ error: null })
    p.delete = () => { const q = Promise.resolve({ error: null }); q.eq = () => q; return q }
    return p
  }
  return { from: (t) => req(t) }
}

function poser (chemin, exports) {
  const abs = require.resolve(chemin)
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports }
}

poser('../lib/cron-shared', {
  supabase: fauxSupabase(),
  anthropic: { messages: { create: async () => ({ content: [{ text: '{}' }] }) } },
  getPropertyMode: async () => 'test',
  // ⚠ LE TEMOIN. C'est le PREMIER appel apres la garde : s'il se declenche,
  // c'est que la garde a laisse passer. S'il ne se declenche pas, elle a
  // suspendu le bien — le defaut du 14 septembre.
  isAutomationPaused: async () => { journal.pauseDemandee++; return true },
  formatDate: (d) => String(d),
  SENDVIABEDS24_ENABLED: false,
  GUESTFLOW_SIGNATURE: '',
  hasActiveSubscription: async () => true,
  getSignatureForKey: async () => '',
  parseDelay: () => 0
})
poser('../lib/founder-notify', { reportIncident: async () => true, envoyerAlerteBrute: async () => ({}) })

const { processMessageTemplates } = require('../lib/cron-messages')

const BIEN_CHANNEX = { id: '1655ab32-uuid-channex', provider: 'channex', name: 'Coeur de vie l 23' }
const BIEN_BEDS24  = { id: '169567', name: 'coeur de vie 23' }   // liste live : pas de champ provider

test('L INVARIANT : table des cles migrees ILLISIBLE + bien CHANNEX => on traite quand meme', async () => {
  journal.pauseDemandee = 0
  journal.lectures.length = 0
  await processMessageTemplates('hote-A', null, BIEN_CHANNEX, { errors: [] })

  assert.equal(journal.pauseDemandee, 1,
    'la fonction est allee PLUS LOIN que la garde : messages et codes d acces ne sont pas suspendus')
  assert.ok(!journal.lectures.includes('provider_keys_migrated'),
    'et la table n a meme pas ete lue : la question ne se pose pas pour un bien Channex')
})

test('L INVARIANT, L AUTRE MOITIE : illisible + bien BEDS24 => on s abstient', async () => {
  // Reduire la portee ne doit pas rouvrir la porte du 14 septembre (82 sejours
  // arraches a la fiche Channex, 16 menages annules cinq minutes plus tard).
  journal.pauseDemandee = 0
  journal.lectures.length = 0
  await processMessageTemplates('hote-A', 'cle-beds24', BIEN_BEDS24, { errors: [] })

  assert.equal(journal.pauseDemandee, 0,
    'la fonction s est arretee A la garde : un bien Beds24 n est pas traite quand on ne sait pas')
  assert.ok(journal.lectures.includes('provider_keys_migrated'),
    'et la table a bien ete interrogee : pour lui, la question se pose')
})
