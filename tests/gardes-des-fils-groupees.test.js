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
// ⚠ UN AUTRE COMPTE ET UN AUTRE BIEN, AVEC LES MEMES IDENTIFIANTS DE
// RESERVATION. Constat 13 : le faux client enregistrait `user_id` et
// `property_id` sans jamais les appliquer, ni dans les lectures par fil ni dans
// les doublures de RPC. On pouvait retirer `.eq('user_id', userId)` du code —
// ou `and t.user_id = p_user_id` de la fonction SQL — sans faire rougir une
// seule assertion, alors que c'est la fuite inter-comptes que ce lot dit
// refermer. `property_id` est une cle PROVIDER : elle n'a aucune unicite
// globale, et `book_id` non plus.
const AUTRE_USER = '22222222-2222-4222-8222-222222222222'
const AUTRE_PROP = 'P2'
// Les valeurs du module, pas des litteraux : le lot les a sorties pour ca.
const {
  PREFIXE_AUTO: PREFIXE,
  FENETRE_CONVERSATIONS: FENETRE,
  MOTIF_PAUSE: MOTIF,
  PLAFOND_POSTGREST
} = require('../lib/gardes-des-fils')

// Une base en memoire. Les MEMES lignes servent les deux branches : les RPC
// (semantique SQL rejouee ici) et les lectures par fil.
function base ({ taches = [], conversations = [], rpcEnPanne = null }) {
  const compte = { rpc: 0, taches: 0, conversations: 0 }
  // Par defaut une ligne appartient au compte et au bien du test ; une fixture
  // qui veut l'AUTRE compte le dit explicitement.
  const mien = (x) => ({ user_id: USER, property_id: PROP, ...x })
  taches = taches.map(mien)
  conversations = conversations.map(mien)

  // Les doublures appliquent les TROIS cles, comme les fonctions SQL.
  const aMoi = (x, u, pr) => x.user_id === u && x.property_id === pr
  const derniereTache = (bookIds, types, u, pr) => {
    const out = []
    for (const b of bookIds) {
      const l = taches.filter(t => aMoi(t, u, pr) && t.book_id === b && types.includes(t.task_type))
        .sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at))[0]
      if (l) out.push({ book_id: b, created_at: l.created_at })
    }
    return out
  }
  const derniereReponse = (bookIds, u, pr) => {
    const out = []
    for (const b of bookIds) {
      // la fenetre D'ABORD, le filtre ENSUITE — comme le JS et comme le SQL
      const fenetre = conversations.filter(c => aMoi(c, u, pr) && c.book_id === b && c.agent_reply != null)
        .sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at))
        .slice(0, FENETRE)
      const l = fenetre.filter(c => !String(c.guest_message || '').startsWith(PREFIXE))[0]
      if (l) out.push({ book_id: b, created_at: l.created_at })
    }
    return out
  }
  // ⚠ LA FENETRE VIENT DE L'ARGUMENT, PAS D'UNE CONSTANTE DU TEST (constat 6
  // de la re-review). En decoupant avec `FENETRE_CONVERSATIONS`, cette doublure
  // laissait la mutation « FENETRE_TACHES_PAUSE passe de 20 a 3 » a 13/13 : la
  // propriete « les deux branches lisent la meme fenetre » n'etait prouvee que
  // pour UNE des deux fenetres — dans le fichier meme qui honore `limit(n)`
  // cote REST pour pouvoir le prouver.
  const tachesPause = (bookIds, motif, u, pr, fenetre) => {
    const out = []
    for (const b of bookIds) {
      taches.filter(t => aMoi(t, u, pr) && t.book_id === b && t.status === 'pending' && t.summary === motif)
        .sort((x, y) => Date.parse(x.created_at) - Date.parse(y.created_at))
        .slice(0, fenetre)
        .forEach(t => out.push({ book_id: b, id: t.id, created_at: t.created_at }))
    }
    return out
  }

  const client = {
    rpc: async (nom, args) => {
      compte.rpc++
      if (rpcEnPanne) return { data: null, error: { message: rpcEnPanne } }
      const u = args.p_user_id, pr = args.p_property_id
      if (nom === 'cron_derniere_tache_classif') return { data: derniereTache(args.p_book_ids, args.p_types, u, pr), error: null }
      if (nom === 'cron_derniere_reponse_hote') return { data: derniereReponse(args.p_book_ids, u, pr), error: null }
      if (nom === 'cron_taches_pause_ouvertes') return { data: tachesPause(args.p_book_ids, args.p_motif, u, pr, args.p_fenetre), error: null }
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
        // ⚠ LE FAUX CLIENT HONORE L'ARGUMENT DE `limit`, ET C'EST CE QUI
        // PERMET AU TEST DE VOIR LE CONSTAT 3. Ma premiere version l'ignorait
        // et decoupait avec SA PROPRE constante : les deux branches
        // recevaient donc la meme fenetre quelle qu'elle soit, et un litteral
        // fige dans la branche de repli etait indetectable. Contre-eprouve :
        // la mutation « la fenetre passe de 20 a 3 » ne faisait rougir aucun
        // test.
        limit (n) { f.limite = n; return rendre() },
        then (r, j) { return rendre().then(r, j) }
      }
      function rendre () {
        if (nom === 'agent_tasks') {
          compte.taches++
          const lignes = taches.filter(t => t.book_id === f.eq.book_id &&
            t.user_id === f.eq.user_id && t.property_id === f.eq.property_id)
          if (f.eq.status === 'pending') {
            return Promise.resolve({ data: lignes.filter(t => t.status === 'pending' && t.summary === f.eq.summary).slice(0, f.limite), error: null })
          }
          const types = f.in.task_type || []
          const l = lignes.filter(t => types.includes(t.task_type))
            .sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at))[0]
          return Promise.resolve({ data: l ? [l] : [], error: null })
        }
        if (nom === 'conversations') {
          compte.conversations++
          const l = conversations.filter(c => c.book_id === f.eq.book_id && c.agent_reply != null &&
            c.user_id === f.eq.user_id && c.property_id === f.eq.property_id)
            .sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at)).slice(0, f.limite)
          return Promise.resolve({ data: l, error: null })
        }
        return Promise.resolve({ data: [], error: null })
      }
      return q
    }
  }

  const abs = require.resolve(path.join(__dirname, '..', 'lib/cron-shared.js'))
  const m = new Module(abs)
  m.exports = { supabase: client, anthropic: null, getPropertyMode: async () => 'test', lireReglagesDuBien: async () => ({ mode: 'test', delais: null }), isAutomationPaused: async () => false }
  m.loaded = true
  require.cache[abs] = m
  delete require.cache[require.resolve('../lib/cron-classify')]
  return { mod: require('../lib/cron-classify'), compte }
}

const t0 = Date.parse('2026-10-21T10:00:00Z')
const a = (min) => new Date(t0 + min * 60000).toISOString()

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

// ─── Les constats de la review du 22 octobre 2026 ────────────────────────────

test('les deux branches s accordent AUSSI sur un fil sans reservation', async () => {
  // ⚠ CE TEST NE PROUVE PAS LE CONSTAT 1, ET IL NE FAUT PAS LE CROIRE.
  // Il appelle `chargerLesGardesDesFils` avec 'unknown' DEJA dans la liste :
  // le defaut etait chez l'APPELANT, qui ne l'y mettait pas. Contre-eprouve le
  // 22 octobre 2026 contre le code d'avant le correctif — il reste VERT.
  // Ce qui garde le constat 1 est l'assertion d'integration de
  // `tests/classify-snapshots-bornes.test.js` (« les gardes couvrent AUSSI le
  // fil sans reservation »), qui lit la liste REELLEMENT passee aux fonctions.
  // Celui-ci garde autre chose, qui vaut d'etre garde : que les deux branches
  // traitent cette cle de la meme facon.
  //
  // Le defaut qu'il accompagne, pour memoire :
  // Un message entrant sans `messages.booking_id` (un e-mail non rattache) fait
  // une cle 'unknown' dans le fil. La lecture du COEUR l'ecarte a juste titre —
  // il n'y a pas de snapshot a chercher — mais les GARDES l'ecartaient aussi,
  // alors que `classifyAndHandle` ecrit bel et bien `book_id = 'unknown'` et
  // que la boucle traite ce fil comme les autres. Verdict toujours « pas encore
  // traite » : reclassification IA toutes les 5 minutes, et en Mode Auto un
  // SECOND message au meme voyageur.
  const { mod } = base({
    taches: [{ id: '1', book_id: 'unknown', task_type: 'sympathy', created_at: a(10) }]
  })
  const gardes = await mod.chargerLesGardesDesFils(USER, PROP, ['unknown'], null)
  const groupe = await mod.hasNewerTaskOrConv(USER, PROP, 'unknown', new Date(t0), gardes)
  const parFil = await mod.hasNewerTaskOrConv(USER, PROP, 'unknown', new Date(t0), null)
  assert.equal(parFil, true, 'la lecture par fil voit la tache du fil non rattache')
  assert.equal(groupe, parFil, 'et la lecture groupee doit dire la MEME chose')
})

test('LE TEST QUI COMPTE : les gardes sont CLOISONNEES par compte et par bien', async () => {
  // ⚠ CONSTAT 13. `property_id` est une cle PROVIDER et `book_id` n'a aucune
  // unicite globale : la tache d'un AUTRE compte sur les memes identifiants ne
  // doit jamais faire taire ce fil-ci.
  const { mod } = base({
    taches: [{ id: '1', book_id: 'B', task_type: 'sympathy', created_at: a(10), user_id: AUTRE_USER }],
    conversations: [{ id: 'c1', book_id: 'B', agent_reply: 'ok', guest_message: 'Bonjour', created_at: a(10), property_id: AUTRE_PROP }]
  })
  const gardes = await mod.chargerLesGardesDesFils(USER, PROP, ['B'], null)
  const groupe = await mod.hasNewerTaskOrConv(USER, PROP, 'B', new Date(t0), gardes)
  const parFil = await mod.hasNewerTaskOrConv(USER, PROP, 'B', new Date(t0), null)
  assert.equal(groupe, false, 'ni la tache d un autre compte, ni la reponse d un autre bien')
  assert.equal(parFil, false)
})

test('LE TEST QUI COMPTE : les deux branches lisent la MEME fenetre et le MEME prefixe', async () => {
  // ⚠ CONSTAT 3. La branche de repli gardait `'[AUTO:'` et `.limit(20)` en
  // litteraux la ou la branche groupee passait les constantes. Ce test fixe la
  // propriete au lieu du nombre : la fenetre vient du module, et les deux
  // branches doivent s accorder exactement a sa borne.
  const auFond = []
  for (let i = 0; i < FENETRE; i++) {
    auFond.push({ id: `auto${i}`, book_id: 'B', agent_reply: 'ok', guest_message: `${PREFIXE} arrival]`, created_at: a(20 + i) })
  }
  auFond.push({ id: 'vraie', book_id: 'B', agent_reply: 'ok', guest_message: 'Bonjour', created_at: a(5) })
  const { mod } = base({ conversations: auFond })
  const gardes = await mod.chargerLesGardesDesFils(USER, PROP, ['B'], null)
  const groupe = await mod.hasNewerTaskOrConv(USER, PROP, 'B', new Date(t0), gardes)
  const parFil = await mod.hasNewerTaskOrConv(USER, PROP, 'B', new Date(t0), null)
  assert.equal(groupe, false, 'la vraie reponse est HORS de la fenetre : le fil n est pas tenu pour repondu')
  assert.equal(groupe, parFil, 'et les deux branches le disent pareil')
})

test('LE TEST QUI COMPTE : la fenetre des taches de pause est la MEME des deux cotes', async () => {
  // ⚠ CONSTAT 6 DE LA RE-REVIEW. La fenetre des conversations etait gardee,
  // celle des taches de pause non : la mutation « 20 -> 3 » laissait tout vert.
  // Deux fenetres, deux tests.
  const { FENETRE_TACHES_PAUSE } = require('../lib/gardes-des-fils')
  const nombreuses = []
  for (let i = 0; i < FENETRE_TACHES_PAUSE + 3; i++) {
    nombreuses.push({ id: `p${i}`, book_id: 'B', status: 'pending', summary: MOTIF, task_type: 'sympathy', created_at: a(-100 + i) })
  }
  const { mod } = base({ taches: nombreuses })
  const gardes = await mod.chargerLesGardesDesFils(USER, PROP, ['B'], null)
  const fil = [{ source: 'host', message: 'Je reponds', time: a(0) }]
  const ferme = async (g) => {
    const vus = []
    await mod.fermerTachesPause(USER, PROP, 'B', fil, { errors: [] }, g, { surFermeture: (ids) => vus.push(...ids) })
    return vus.map(String).sort()
  }
  const groupe = await ferme(gardes)
  const parFil = await ferme(null)
  assert.equal(groupe.length, FENETRE_TACHES_PAUSE, 'la fenetre borne bien les deux cotes')
  assert.deepEqual(groupe, parFil, 'et les deux branches ferment EXACTEMENT les memes taches')
})

test('LE TEST QUI COMPTE : au plafond, SEULE la garde des taches de pause retombe par fil', async () => {
  // ⚠ CONSTAT 7 DE LA RE-REVIEW. Jeter les trois gardes parce que l une touche
  // le plafond fait payer les 3 requetes par fil pour toujours a un bien qui y
  // stationne — et une tache de pause ne se ferme QUE si l hote repond. Les
  // deux gardes « derniere » ne peuvent pas etre tronquees : elles restent.
  const trop = []
  for (let i = 0; i < PLAFOND_POSTGREST; i++) {
    trop.push({ id: `p${i}`, book_id: `B${i % 50}`, status: 'pending', summary: MOTIF, task_type: 'sympathy', created_at: a(-60) })
  }
  trop.push({ id: 'recente', book_id: 'B0', task_type: 'sympathy', created_at: a(10) })
  const { mod, compte } = base({ taches: trop })
  const res = { errors: [] }
  const fils = Array.from({ length: 50 }, (_, i) => `B${i}`)
  const gardes = await mod.chargerLesGardesDesFils(USER, PROP, fils, res)
  assert.ok(gardes, 'les gardes ne sont PAS jetees en bloc')
  assert.equal(gardes.pause, null, 'seule celle qui peut etre coupee retombe par fil')
  assert.equal(res.gardesPauseParFil, 1, 'et ce repli PARTIEL a son propre compteur')
  assert.equal(res.gardesParFil, undefined, 'ce n est pas le repli total')
  // Les deux gardes saines servent toujours, sans une requete de plus.
  const avant = compte.taches
  assert.equal(await mod.hasNewerTaskOrConv(USER, PROP, 'B0', new Date(t0), gardes), true,
    'la tache recente est vue par la lecture GROUPEE')
  assert.equal(compte.taches, avant, 'et sans relire fil par fil')
})
