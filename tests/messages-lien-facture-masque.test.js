// tests/messages-lien-facture-masque.test.js — le lien du formulaire de facture
// n'est JAMAIS écrit en clair dans la conversation.
// Décisions de Thierry du 10 novembre 2026 (facture voyageur 2a) : S1 (le
// cacher), puis S1-bis (« ne jamais l'enregistrer ») après la re-review, qui a
// montré qu'un masque à l'affichage laissait le jeton lisible par la base
// (`messages_select`), recopié dans `agent_tasks.source_thread` et lu par l'IA.
// Spec : docs/specs/spec-facture-voyageur.md §4 bis (P2 bis, P2 ter), §10 ter.
//
// Le lien `/facture#<jeton>` est une CLÉ : il ouvre les coordonnées de
// facturation du voyageur et permet de les réécrire. Ce fichier APPELLE le
// writer unique du fil (lib/record-message.js) avec une base factice qui
// applique ses filtres : notre envoi, l'écho de la synchronisation et une
// réponse e-mail du voyageur arrivent tous masqués, et l'écho se reconnaît
// toujours.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert/strict')

const FV = require('../lib/factures-voyageur')
const { recordMessage } = require('../lib/record-message')

const A = '11111111-1111-4111-8111-111111111111'
const JETON = 'Q'.repeat(30) + '_-' + 'z'.repeat(11)
const LIEN = `https://hotesmart.vercel.app/facture#${JETON}`
const TEXTE = FV.texteDuLien('fr', 'Léa', LIEN)

test('le masque : toutes les formes du lien, et il échoue FERMÉ', () => {
  const m = FV.masquerLiensFacture
  assert.equal(m(TEXTE),
    'Bonjour Léa, pour recevoir votre facture, merci de renseigner vos coordonnées de facturation ici : [lien de facture]. Votre facture sera disponible sur ce même lien après votre séjour.')
  // Un caractère de jeton collé après (italique Markdown) : masqué quand même.
  assert.equal(m(`_${LIEN}_`), '_[lien de facture]_')
  assert.equal(m(`${LIEN}x`), '[lien de facture]x')
  // `\_` échappé (réponse e-mail convertie en Markdown).
  assert.equal(m(`voir ${LIEN.replace(/_/g, '\\_')} merci`), 'voir [lien de facture] merci')
  // Dans une URL de redirection, encodé.
  assert.equal(m(`https://r.example/?u=https%3A%2F%2Fhotesmart.vercel.app%2Ffacture%23${JETON}`), '[lien de facture]')
  // En entité HTML, sans schéma, en majuscules, deux fois.
  assert.equal(m(`/facture&#35;${JETON}`), '[lien de facture]')
  assert.equal(m(`HTTPS://H.APP/FACTURE#${JETON}`), '[lien de facture]')
  assert.equal(m(`/facture#${JETON} et /facture#${JETON}`), '[lien de facture] et [lien de facture]')
  // Ce qui n'est pas un lien de facture ne bouge pas.
  assert.equal(m('Bonjour, la facture # 12 et /facture#court'), 'Bonjour, la facture # 12 et /facture#court')
  assert.equal(m(null), null)
})

// ─── Une base factice : elle APPLIQUE les filtres de recordMessage ────────────
function base () {
  const lignes = { messages: [], bookings_snapshot: [{ user_id: A, booking_id: 'BK-1', snapshot: { source: 'Airbnb' } }] }
  let n = 0
  function from (table) {
    const q = { f: [], op: 'select', row: null, unique: false }
    const ok = (r) => q.f.every(([c, v]) => (v === null ? (r[c] ?? null) === null : String(r[c]) === String(v)))
    function executer () {
      const t = (lignes[table] = lignes[table] || [])
      if (q.op === 'insert') { t.push({ id: `m${++n}`, created_at: new Date().toISOString(), provider_msg_id: null, ...q.row }); return { data: null, error: null } }
      if (q.op === 'update') { for (const r of t.filter(ok)) Object.assign(r, q.row); return { data: null, error: null } }
      const res = t.filter(ok)
      return q.unique ? { data: res[0] || null, error: null } : { data: res, error: null }
    }
    const c = {
      select () { return c }, order () { return c }, limit () { return c },
      eq (k, v) { q.f.push([k, v]); return c },
      is (k, v) { q.f.push([k, v]); return c },
      gte () { return c },
      insert (row) { q.op = 'insert'; q.row = row; return c },
      update (row) { q.op = 'update'; q.row = row; return c },
      maybeSingle () { q.unique = true; return c },
      then (o, k) { return Promise.resolve(executer()).then(o, k) }
    }
    return c
  }
  return { db: { from }, lignes }
}

test('LE TEST QUI COMPTE : notre envoi entre dans le fil MASQUÉ — le jeton n\'est nulle part en base', async () => {
  const { db, lignes } = base()
  const r = await recordMessage({ supabase: db, userId: A, provider: 'channex', propertyId: 'P1', bookingId: 'BK-1',
    direction: 'outbound', sender: 'host', body: TEXTE, kind: 'message', origine: 'hote' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(lignes.messages.length, 1)
  assert.match(lignes.messages[0].body, /ici : \[lien de facture\]\. Votre facture/)
  assert.ok(!JSON.stringify(lignes).includes(JETON), 'le jeton est en base')
})

test('l\'écho de la synchronisation (texte EN CLAIR) se reconnaît toujours : aucun doublon, aucun jeton', async () => {
  const { db, lignes } = base()
  await recordMessage({ supabase: db, userId: A, provider: 'channex', propertyId: 'P1', bookingId: 'BK-1',
    direction: 'outbound', sender: 'host', body: TEXTE, kind: 'message' })
  const echo = await recordMessage({ supabase: db, userId: A, provider: 'channex', propertyId: 'P1', bookingId: 'BK-1',
    direction: 'outbound', sender: 'host', body: TEXTE, providerMsgId: 'cx-1', sentAt: new Date().toISOString(), kind: 'message' })
  assert.equal(echo.reason, 'echo_reconcilie', JSON.stringify(echo))
  assert.equal(lignes.messages.length, 1, 'l\'écho n\'a pas créé de seconde ligne')
  assert.equal(lignes.messages[0].provider_msg_id, 'cx-1')
  assert.ok(!JSON.stringify(lignes).includes(JETON))
})

test('la réponse du voyageur qui CITE le lien (e-mail en Markdown) entre masquée elle aussi', async () => {
  const { db, lignes } = base()
  await recordMessage({ supabase: db, userId: A, provider: 'channex', propertyId: 'P1', bookingId: 'BK-1',
    direction: 'inbound', sender: 'guest', body: `> ${LIEN.replace(/_/g, '\\_')}\nMerci, c'est fait !`,
    providerMsgId: 'mail-1', sentAt: new Date().toISOString(), kind: 'message' })
  assert.equal(lignes.messages[0].body, '> [lien de facture]\nMerci, c\'est fait !')
})
