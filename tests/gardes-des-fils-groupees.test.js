// tests/gardes-des-fils-groupees.test.js
// LE DEFAUT : trois gardes posees FIL PAR FIL, toutes les 5 minutes.
//
// Mesure du 22 octobre 2026 en production : `biens_channel` porte 76 % des
// requetes du cron (178 sur 234), et 129 d'entre elles sont ces trois gardes,
// sur 52 fils de messagerie — pour decouvrir que 51 n'attendent rien.
// Groupees par bien, elles tiennent en TROIS requetes.
//
// ⚠ CE QUE CE FICHIER PROUVE, ET CE QU'IL NE PROUVE PAS.
// Il prouve que les DEUX BRANCHES du code JS rendent le meme verdict, et que
// l'echec de la lecture groupee ramene la lecture par fil — jamais l'absence
// de garde. Il ne prouve PAS le SQL : trois fonctions Postgres ne s'eprouvent
// pas avec un faux client. C'est `scripts/parite-gardes-des-fils.js` qui les
// confronte aux 52 fils REELS, et zero divergence est la condition de passage.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'cle-test'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const Module = require('node:module')

const USER = '11111111-1111-4111-8111-111111111111'
const PROP = 'P1'
const PREFIXE = '[AUTO:'
const FENETRE = 20

// Une base en memoire. Les MEMES lignes servent les deux branches : les RPC
// (semantique SQL rejouee ici) et les lectures par fil.
function base ({ taches = [], conversations = [], rpcEnPanne = null }) {
  const compte = { rpc: 0, taches: 0, conversations: 0 }

  const derniereTache = (bookIds, types) => {
    const out = []
    for (const b of bookIds) {
      const l = taches.filter(t => t.book_id === b && types.includes(t.task_type))
        .sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at))[0]
      if (l) out.push({ book_id: b, created_at: l.created_at })
    }
    return out
  }
  const derniereReponse = (bookIds) => {
    const out = []
    for (const b of bookIds) {
      // la fenetre D'ABORD, le filtre ENSUITE — comme le JS et comme le SQL
      const fenetre = conversations.filter(c => c.book_id === b && c.agent_reply != null)
        .sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at))
        .slice(0, FENETRE)
      const l = fenetre.filter(c => !String(c.guest_message || '').startsWith(PREFIXE))[0]
      if (l) out.push({ book_id: b, created_at: l.created_at })
    }
    return out
  }
  const tachesPause = (bookIds, motif) => {
    const out = []
    for (const b of bookIds) {
      taches.filter(t => t.book_id === b && t.status === 'pending' && t.summary === motif)
        .sort((x, y) => Date.parse(x.created_at) - Date.parse(y.created_at))
        .slice(0, FENETRE)
        .forEach(t => out.push({ book_id: b, id: t.id, created_at: t.created_at }))
    }
    return out
  }

  const client = {
    rpc: async (nom, args) => {
      compte.rpc++
      if (rpcEnPanne) return { data: null, error: { message: rpcEnPanne } }
      if (nom === 'cron_derniere_tache_classif') return { data: derniereTache(args.p_book_ids, args.p_types), error: null }
      if (nom === 'cron_derniere_reponse_hote') return { data: derniereReponse(args.p_book_ids), error: null }
      if (nom === 'cron_taches_pause_ouvertes') return { data: tachesPause(args.p_book_ids, args.p_motif), error: null }
      return { data: null, error: { message: `rpc inconnue ${nom}` } }
    },
    from: (nom) => {
      const f = { eq: {}, in: {} }
      const q = {
        select () { return q },
        eq (c, v) { f.eq[c] = String(v); return q },
        in (c, v) { f.in[c] = v; return q },
        not () { f.eq.__agent_reply = 'non nul'; return q },
        order () { return q },
        update () { return { in: () => ({ eq: async () => ({ error: null }) }) } },
        limit () { return rendre() },
        then (r, j) { return rendre().then(r, j) }
      }
      function rendre () {
        if (nom === 'agent_tasks') {
          compte.taches++
          const lignes = taches.filter(t => t.book_id === f.eq.book_id)
          if (f.eq.status === 'pending') {
            return Promise.resolve({ data: lignes.filter(t => t.status === 'pending' && t.summary === f.eq.summary).slice(0, FENETRE), error: null })
          }
          const types = f.in.task_type || []
          const l = lignes.filter(t => types.includes(t.task_type))
            .sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at))[0]
          return Promise.resolve({ data: l ? [l] : [], error: null })
        }
        if (nom === 'conversations') {
          compte.conversations++
          const l = conversations.filter(c => c.book_id === f.eq.book_id && c.agent_reply != null)
            .sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at)).slice(0, FENETRE)
          return Promise.resolve({ data: l, error: null })
        }
        return Promise.resolve({ data: [], error: null })
      }
      return q
    }
  }

  const abs = require.resolve(path.join(__dirname, '..', 'lib/cron-shared.js'))
  const m = new Module(abs)
  m.exports = { supabase: client, anthropic: null, getPropertyMode: async () => 'test', isAutomationPaused: async () => false }
  m.loaded = true
  require.cache[abs] = m
  delete require.cache[require.resolve('../lib/cron-classify')]
  return { mod: require('../lib/cron-classify'), compte }
}

const t0 = Date.parse('2026-10-21T10:00:00Z')
const a = (min) => new Date(t0 + min * 60000).toISOString()
const MOTIF = 'Reçu pendant la pause : aucune réponse automatique n’est partie. Répondez au voyageur si besoin.'

// Les six cas qui couvrent les deux gardes, bornes comprises.
const CAS = [
  { nom: 'rien en base', taches: [], conversations: [] },
  { nom: 'tache de classification PLUS RECENTE que le message', taches: [{ id: '1', book_id: 'B', task_type: 'sympathy', created_at: a(10) }] },
  { nom: 'tache de classification PLUS ANCIENNE', taches: [{ id: '1', book_id: 'B', task_type: 'sympathy', created_at: a(-10) }] },
  { nom: 'tache a la MEME seconde (la borne est >=)', taches: [{ id: '1', book_id: 'B', task_type: 'sympathy', created_at: a(0) }] },
  { nom: 'tache d un type NON suivi', taches: [{ id: '1', book_id: 'B', task_type: 'auto_message', created_at: a(10) }] },
  { nom: 'reponse de l hote plus recente', conversations: [{ id: 'c1', book_id: 'B', agent_reply: 'ok', guest_message: 'Bonjour', created_at: a(10) }] },
  { nom: 'conversation SANS reponse (un echo de webhook)', conversations: [{ id: 'c1', book_id: 'B', agent_reply: null, guest_message: 'Bonjour', created_at: a(10) }] },
  { nom: 'seul un modele AUTO plus recent', conversations: [{ id: 'c1', book_id: 'B', agent_reply: 'ok', guest_message: '[AUTO: arrival]', created_at: a(10) }] },
  {
    nom: 'un AUTO recent ET une vraie reponse ancienne',
    conversations: [
      { id: 'c1', book_id: 'B', agent_reply: 'ok', guest_message: '[AUTO: arrival]', created_at: a(10) },
      { id: 'c2', book_id: 'B', agent_reply: 'ok', guest_message: 'Bonjour', created_at: a(-30) }
    ]
  },
  {
    nom: 'la fenetre des 20 est PLEINE d AUTO, la vraie reponse est derriere',
    conversations: [
      ...Array.from({ length: FENETRE }, (_, i) => ({ id: `auto${i}`, book_id: 'B', agent_reply: 'ok', guest_message: '[AUTO: arrival]', created_at: a(20 + i) })),
      { id: 'vraie', book_id: 'B', agent_reply: 'ok', guest_message: 'Bonjour', created_at: a(5) }
    ]
  }
]

test('LE TEST QUI COMPTE : les deux branches rendent le MEME verdict, cas par cas', async () => {
  for (const cas of CAS) {
    const { mod } = base({ taches: cas.taches || [], conversations: cas.conversations || [] })
    const gardes = await mod.chargerLesGardesDesFils(USER, PROP, ['B'], null)
    assert.ok(gardes, 'les gardes groupees ont ete lues')
    const groupe = await mod.hasNewerTaskOrConv(USER, PROP, 'B', new Date(t0), gardes)
    const parFil = await mod.hasNewerTaskOrConv(USER, PROP, 'B', new Date(t0), null)
    assert.equal(groupe, parFil, `DIVERGENCE sur « ${cas.nom} » : groupe=${groupe} parFil=${parFil}`)
  }
})

test('LE TEST QUI COMPTE : trois requetes pour tout le bien, au lieu de trois PAR FIL', async () => {
  const fils = Array.from({ length: 20 }, (_, i) => `B${i}`)
  const { mod, compte } = base({ taches: [], conversations: [] })
  const gardes = await mod.chargerLesGardesDesFils(USER, PROP, fils, null)
  assert.equal(compte.rpc, 3, 'trois appels, quel que soit le nombre de fils')
  for (const b of fils) await mod.hasNewerTaskOrConv(USER, PROP, b, new Date(t0), gardes)
  assert.equal(compte.taches, 0, 'aucune lecture par fil')
  assert.equal(compte.conversations, 0, 'aucune lecture par fil')
})

test('LE TEST QUI COMPTE : une lecture groupee en echec RAMENE la lecture par fil', async () => {
  // ⚠ LA CONDITION POSEE PAR THIERRY. Une garde qui repond « pas encore
  // traite » faute d avoir lu fait repondre l IA UNE SECONDE FOIS au meme
  // voyageur. Le repli coute 129 requetes ; un verdict invente coute un
  // message de trop chez le voyageur.
  const { mod, compte } = base({
    taches: [{ id: '1', book_id: 'B', task_type: 'sympathy', created_at: a(10) }],
    rpcEnPanne: 'function cron_derniere_tache_classif does not exist'
  })
  const res = { errors: [] }
  const gardes = await mod.chargerLesGardesDesFils(USER, PROP, ['B'], res)
  assert.equal(gardes, null, 'null, pas un objet vide : un objet vide dirait « rien a signaler »')
  assert.equal(res.gardesParFil, 1, 'et le repli est COMPTE — sinon un repli permanent serait invisible')
  // Et la garde, appelee avec ce `null`, retrouve son verdict par la base.
  const verdict = await mod.hasNewerTaskOrConv(USER, PROP, 'B', new Date(t0), gardes)
  assert.equal(verdict, true, 'la tache plus recente est vue malgre la panne de la lecture groupee')
  assert.ok(compte.taches >= 1, 'la lecture par fil a bien eu lieu')
})

test('LE TEST QUI COMPTE : fermerTachesPause lit les gardes groupees et ne requete plus', async () => {
  const { mod, compte } = base({
    taches: [{ id: 'p1', book_id: 'B', status: 'pending', summary: MOTIF, task_type: 'sympathy', created_at: a(-60) }]
  })
  const gardes = await mod.chargerLesGardesDesFils(USER, PROP, ['B'], null)
  const avant = compte.taches
  const fil = [{ source: 'host', message: 'Je reponds', time: a(0) }]
  await mod.fermerTachesPause(USER, PROP, 'B', fil, { errors: [] }, gardes)
  assert.equal(compte.taches, avant, 'aucune lecture de plus : la tache a fermer vient des gardes')
})

test('LE TEST QUI COMPTE : sans gardes, fermerTachesPause relit — et ferme la meme tache', async () => {
  const { mod, compte } = base({
    taches: [{ id: 'p1', book_id: 'B', status: 'pending', summary: MOTIF, task_type: 'sympathy', created_at: a(-60) }]
  })
  const fil = [{ source: 'host', message: 'Je reponds', time: a(0) }]
  const res = { errors: [] }
  await mod.fermerTachesPause(USER, PROP, 'B', fil, res, null)
  assert.ok(compte.taches >= 1, 'la branche de repli lit bien la base')
  assert.deepEqual(res.errors, [], 'et elle n a rien casse')
})
