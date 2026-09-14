// tests/messages-classify-age.test.js
// LE DEFAUT : un rattrapage de messages fait analyser des mois de conversation.
//
// Le curseur de ce module est sur `created_at` — la date d'INSERTION — et c'est
// deliberé : un message recent livre en retard doit etre vu. Mais l'import des
// fils OTA change l'echelle. Le rattrapage d'Ofuro Futari a insere 44 lignes
// d'un coup le 14 septembre 2026 ; celui de Colomiers en portera ~107. Chacune
// partait chez le modele, avec des detections de proprete sur des sejours clos.
//
// Decision de Thierry le 14 septembre : au-dela de 30 jours, on n'analyse plus.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'cle-test'

const test = require('node:test')
const assert = require('node:assert')
const { classerMessages } = require('../lib/cron-messages-classify')

const MAINTENANT = new Date('2026-09-14T08:00:00Z').getTime()
const ilYA = (jours) => new Date(MAINTENANT - jours * 86400000).toISOString()

// Faux client : `messages` rend la file, `cron_logs` rend un curseur vide.
// Les upserts sont journalises pour verifier que le curseur AVANCE.
function faux (messages) {
  const journal = { upserts: [], lignesEcrites: [] }
  const req = (table) => {
    const p = Promise.resolve().then(() => ({
      data: table === 'messages' ? messages : [], error: null
    }))
    p.select = () => req(table)
    p.eq = () => req(table)
    p.gt = () => req(table)
    p.in = () => req(table)
    p.order = () => req(table)
    p.limit = () => req(table)
    p.maybeSingle = () => Promise.resolve({ data: null, error: null })
    p.upsert = (row) => { journal.upserts.push({ table, row }); return Promise.resolve({ error: null }) }
    p.insert = (row) => { journal.lignesEcrites.push({ table, row }); return Promise.resolve({ error: null }) }
    return p
  }
  return { from: (t) => req(t), journal }
}

function modele (compteur) {
  return { messages: { create: async () => {
    compteur.appels++
    return { content: [{ text: '{"signale": false, "extrait": null}' }] }
  } } }
}

test('LE TEST QUI COMPTE : un message de plus de 30 jours n est PAS envoye au modele', async () => {
  const compteur = { appels: 0 }
  const sb = faux([
    { id: 'vieux', user_id: 'u', body: 'Le menage laissait a desirer', property_id: 'p',
      sent_at: ilYA(95), created_at: new Date(MAINTENANT - 60000).toISOString() }
  ])
  const bilan = await classerMessages(null, {
    supabase: sb, now: () => MAINTENANT, forcer: true, anthropic: modele(compteur)
  })
  assert.equal(compteur.appels, 0, 'aucun appel au modele : c est tout l objet de la borne')
  assert.equal(bilan.trop_anciens, 1, 'et il est COMPTE, pas avale en silence')
  assert.equal(bilan.detectes, 0)
})

test('LE TEST QUI COMPTE : le curseur AVANCE quand tout le lot est trop ancien', async () => {
  // ⚠ LE PIEGE QUE LA BORNE AURAIT PU CREER. Filtrer en SQL aurait rendu un lot
  // VIDE : `dernierTraite` serait reste nul, le curseur n aurait pas bouge, et
  // la file se serait bloquee sur ces memes messages a chaque passage — pour
  // toujours. D'ou un filtre DANS la boucle, qui saute ET avance.
  const compteur = { appels: 0 }
  const dernier = new Date(MAINTENANT - 30000).toISOString()
  const sb = faux([
    { id: 'v1', user_id: 'u', body: 'a', property_id: 'p', sent_at: ilYA(80), created_at: new Date(MAINTENANT - 60000).toISOString() },
    { id: 'v2', user_id: 'u', body: 'b', property_id: 'p', sent_at: ilYA(70), created_at: dernier }
  ])
  await classerMessages(null, { supabase: sb, now: () => MAINTENANT, forcer: true, anthropic: modele(compteur) })
  const curseur = sb.journal.upserts.filter(u => u.row?.id === 'messages_classify_cursor').pop()
  assert.ok(curseur, 'le curseur est ecrit')
  assert.equal(curseur.row.last_run, dernier,
    'et il depasse le dernier message du lot : la file ne se bloque pas dessus')
})

test('LE TEST QUI COMPTE : un message RECENT reste analyse — la borne ne ferme pas la porte', async () => {
  const compteur = { appels: 0 }
  const sb = faux([
    { id: 'recent', user_id: 'u', body: 'Le menage laissait a desirer', property_id: 'p',
      sent_at: ilYA(3), created_at: new Date(MAINTENANT - 60000).toISOString() }
  ])
  const bilan = await classerMessages(null, {
    supabase: sb, now: () => MAINTENANT, forcer: true, anthropic: modele(compteur)
  })
  assert.equal(compteur.appels, 1, 'le modele est bien appele')
  assert.equal(bilan.trop_anciens, 0)
})

test('LE TEST QUI COMPTE : sans sent_at, on ANALYSE — « je ne sais pas quand » n est pas « c est vieux »', async () => {
  // Se taire par defaut ferait rater un signalement reel pour une donnee
  // manquante. C'est la regle du depot : « je ne sais pas » n'est jamais « non ».
  const compteur = { appels: 0 }
  const sb = faux([
    { id: 'sans-date', user_id: 'u', body: 'Le menage laissait a desirer', property_id: 'p',
      sent_at: null, created_at: new Date(MAINTENANT - 60000).toISOString() }
  ])
  const bilan = await classerMessages(null, {
    supabase: sb, now: () => MAINTENANT, forcer: true, anthropic: modele(compteur)
  })
  assert.equal(compteur.appels, 1, 'analyse quand meme')
  assert.equal(bilan.trop_anciens, 0)
})

test('LE TEST QUI COMPTE : un lot entierement ancien PARLE quand meme', () => {
  // ⚠ RELEVE EN REVIEW. Le saut n incremente pas `lus`, et le bilan n etait
  // journalise que si `lus > 0` : cent messages ecartes ne laissaient AUCUNE
  // trace, indiscernables de « rien a faire ».
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib/cron-messages-classify.js'), 'utf8')
  assert.ok(src.includes('if (bilan.lus > 0 || bilan.trop_anciens > 0)'),
    'le bilan sort aussi quand tout le lot a ete ecarte par l age')
})

test('la borne est bien de 30 jours, et elle porte sa raison', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib/cron-messages-classify.js'), 'utf8')
  assert.ok(/AGE_MAX_MS = 30 \* 24 \* 60 \* 60 \* 1000/.test(src), 'trente jours, en clair')
  const i = src.indexOf('AGE_MAX_MS')
  assert.ok(src.slice(Math.max(0, i - 1800), i).includes('DECISION DE'),
    'et la decision qui la fixe est datee dans le fichier')
})
