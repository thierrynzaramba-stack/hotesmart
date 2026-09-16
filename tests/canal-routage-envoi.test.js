// tests/canal-routage-envoi.test.js
// Etape 2 du chantier « canal e-mail pour les reservations directes ».
//
// LA PREUVE EXIGEE, EN DEUX PHRASES :
//   1. une reservation OTA part EXACTEMENT comme avant — meme API, meme appel ;
//   2. une reservation Offline ne frappe PLUS l'API messages de Channex, celle
//      qui rendait HTTP 422 `not_supported`.
//
// Le test porte sur `sendGuestMessage`, le point de passage unique : les deux
// moteurs de templates et le code d'acces y aboutissent tous.

const test = require('node:test')
const assert = require('node:assert')
const Module = require('node:module')

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test'

// ─── Harnais : on compte les appels PROVIDER ────────────────────────────────
const appels = { channex: [], beds24: [] }

const origine = Module._load
Module._load = function (d, ...reste) {
  if (d === './channels/channex') return {
    sendMessage: async (ctx, { bookingId, message }) => {
      appels.channex.push({ bookingId, message })
      return { success: true, status: 200, data: {} }
    }
  }
  if (d === './cron-beds24') return {
    fetchBookings: async () => [],
    sendViaBeds24: async (key, bookingId, message) => {
      appels.beds24.push({ key, bookingId, message })
      return { ok: true }
    }
  }
  return origine.apply(this, [d, ...reste])
}

const { sendGuestMessage } = require('../lib/cron-messages')
// ⚠ LE HOOK RESTE ACTIF. `sendGuestMessage` fait `require('./channels/channex')`
// A L'INTERIEUR de la fonction (chargement paresseux) : le restaurer ici ferait
// partir de VRAIS appels HTTP au provider depuis la suite de tests.
test.after(() => { Module._load = origine })

const BIEN_CHANNEX = { id: '0544fd9a', provider: 'channex', name: 'Colomiers' }
const BIEN_BEDS24  = { id: '209413',  provider: 'beds24',  name: 'La bulle' }

const remise = () => { appels.channex = []; appels.beds24 = [] }

// ─── 1. Les reservations OTA : rien ne bouge ─────────────────────────────────
test('PREUVE 1 — Airbnb sur Channex : l\'API messages est appelee, comme avant', async () => {
  remise()
  const r = await sendGuestMessage(null, BIEN_CHANNEX,
    { id: '512013a3', source: 'AirBNB', guestEmail: null }, 'bonjour')
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.canal, 'ota')
  assert.strictEqual(appels.channex.length, 1, 'un appel, et un seul')
  assert.strictEqual(appels.channex[0].bookingId, '512013a3')
  assert.strictEqual(appels.channex[0].message, 'bonjour')
  assert.strictEqual(appels.beds24.length, 0)
})

test('PREUVE 1 — Booking.com et son alias : l\'API messages, jamais l\'e-mail', async () => {
  remise()
  const r = await sendGuestMessage(null, BIEN_CHANNEX,
    { id: 'a2a77727', source: 'BookingCom', guestEmail: 'x5261285458@guest.booking.com' },
    'bonjour')
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.canal, 'ota')
  assert.strictEqual(appels.channex.length, 1, 'l\'alias n\'a rien detourne')
})

test('PREUVE 1 — Airbnb sur Beds24 : sendViaBeds24, avec la cle du compte', async () => {
  remise()
  const r = await sendGuestMessage('CLE24', BIEN_BEDS24,
    { id: 84489862, channel: 'airbnb' }, 'bonjour')
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.canal, 'ota')
  assert.strictEqual(appels.beds24.length, 1)
  assert.deepStrictEqual(
    { key: appels.beds24[0].key, bookingId: appels.beds24[0].bookingId },
    { key: 'CLE24', bookingId: '84489862' })
  assert.strictEqual(appels.channex.length, 0)
})

test('PREUVE 1 bis — un identifiant nu se comporte comme avant (aucune regression)', async () => {
  // Un appelant qui n'aurait pas ete mis a jour ne doit rien casser : sans la
  // source, on ne peut que router par provider, comme la version precedente.
  remise()
  const r = await sendGuestMessage(null, BIEN_CHANNEX, '512013a3', 'bonjour')
  assert.strictEqual(r.ok, true)
  assert.strictEqual(appels.channex.length, 1)
  assert.strictEqual(appels.channex[0].bookingId, '512013a3')
})

// ─── 2. Les reservations Offline : plus aucun 422 ────────────────────────────
test('PREUVE 2 — Offline avec adresse : AUCUN appel provider', async () => {
  remise()
  const r = await sendGuestMessage(null, BIEN_CHANNEX,
    { id: 'c87f24ce', source: 'Offline', guestEmail: 'voyageur@exemple.test' }, 'bonjour')
  assert.strictEqual(appels.channex.length, 0,
    'c\'est exactement l\'appel qui rendait 422 not_supported')
  assert.strictEqual(appels.beds24.length, 0)
  assert.strictEqual(r.canal, 'email')
  assert.strictEqual(r.destinataire, 'voyageur@exemple.test')
  // Etape 2 : la decision est prise, l'envoi arrive a l'etape 3.
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.differe, true,
    '« pas encore branche » n\'est pas « a echoue » — rien ne sera journalise')
})

test('PREUVE 2 — Offline sans adresse : aucun appel, et un motif lisible', async () => {
  remise()
  const r = await sendGuestMessage(null, BIEN_CHANNEX,
    { id: '61415d10', source: 'Offline', guestEmail: null }, 'bonjour')
  assert.strictEqual(appels.channex.length, 0)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.canal, 'aucun')
  assert.strictEqual(r.motif, 'pas_d_email')
  assert.ok(/adresse/i.test(r.error), 'le motif est dit en clair, pas en code')
  assert.notStrictEqual(r.differe, true, 'ce n\'est pas un differe : il manque une donnee')
})

test('Beds24 direct : aucun appel, comme avant', async () => {
  remise()
  const r = await sendGuestMessage('CLE24', BIEN_BEDS24,
    { id: 90006015, source: 'direct' }, 'bonjour')
  assert.strictEqual(appels.beds24.length, 0)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.motif, 'sans_canal')
})

// ─── 3. L'ordre du journal, lu dans le source ────────────────────────────────
// Ces deux invariants ne s'observent pas depuis `sendGuestMessage` : ils vivent
// dans les moteurs de templates. Un test fonctionnel demanderait tout le harnais
// Supabase ; on verifie donc la structure, comme le fait deja
// `tests/empreinte-sejour-messages.test.js` pour l'empreinte.
const fs = require('node:fs')
const path = require('node:path')
const src = fs.readFileSync(path.join(__dirname, '..', 'lib/cron-messages.js'), 'utf8')

test('les deux moteurs decident du canal AVANT d\'ecrire quoi que ce soit', () => {
  const decisions = src.split('const decision = canalPour(booking)').length - 1
  assert.strictEqual(decisions, 2, 'un par moteur : checkAndSendTemplate et triggerTemplates')
  const ordres = src.split('const journalAvantEnvoi = decision.canal !== CANAL.EMAIL').length - 1
  assert.strictEqual(ordres, 2, 'et chacun en tire l\'ordre du journal')
})

test('LE TEST QUI COMPTE : sur le canal e-mail, rien n\'est ecrit avant un succes', () => {
  // Le defaut d'origine : `noterEnvoi` etait appele AVANT l'envoi, donc trois
  // reservations Offline portent un message marque envoye que Channex avait
  // refuse. Sur le canal e-mail, l'echec doit laisser la place nette.
  for (const bloc of src.split('if (!journalAvantEnvoi && !sendRes?.ok) {').slice(1)) {
    const corps = bloc.split(/\n\s+(?:continue|return)\n/)[0]
    assert.ok(!/noterEnvoi/.test(corps), 'aucun journal pose sur un envoi qui n\'est pas parti')
    assert.ok(!/from\('conversations'\)/.test(corps), 'aucun fil qui afficherait un message non delivre')
    assert.ok(!/recordMessage/.test(corps), 'aucune ligne dans `messages`')
  }
  assert.strictEqual(src.split('if (!journalAvantEnvoi && !sendRes?.ok) {').length - 1, 2,
    'les deux moteurs portent la garde')
})

test('le chemin OTA garde son ordre historique : journal AVANT envoi', () => {
  // L'anti-boucle. Un envoi qui part sans etre note repart toutes les 5 minutes.
  for (const bloc of src.split('if (journalAvantEnvoi) {').slice(1)) {
    const corps = bloc.split('\n      }\n')[0]
    assert.ok(/noterEnvoi/.test(corps), 'le journal est bien pose dans la branche OTA')
  }
  const avant = src.indexOf('if (journalAvantEnvoi) {')
  const envoi = src.indexOf('const sendRes = await sendGuestMessage(beds24Key, property, booking, message)')
  assert.ok(avant > 0 && envoi > avant, 'et il precede l\'envoi')
})

// ─── 4. Les correctifs de review (16 septembre 2026) ─────────────────────────
const { ENVOI_EMAIL_BRANCHE } = require('../lib/canal-voyageur')

test('l\'interrupteur de l\'etape 3 est explicite, et encore ferme', () => {
  assert.strictEqual(ENVOI_EMAIL_BRANCHE, false,
    'a l\'etape 3 : passer a true ET retirer les sorties anticipees qui le citent')
})

test('LE TEST QUI COMPTE : on sort AVANT de payer un appel Haiku', () => {
  // Constat de review : le retour anticipe etait place APRES generateAutoMessage.
  // Un appel Claude par reservation Offline et par template, toutes les 5 minutes,
  // pour un message qui ne part pas — sur le budget de cron qui a deja produit un 504.
  const sortie = src.indexOf('if (decision.canal === CANAL.EMAIL && !ENVOI_EMAIL_BRANCHE) {')
  const generation = src.indexOf('const message   = await generateAutoMessage(')
  assert.ok(sortie > 0, 'la sortie anticipee existe')
  assert.ok(generation > 0, 'la generation existe')
  assert.ok(sortie < generation, 'et la sortie precede la generation')
})

test('LE TEST QUI COMPTE : dans triggerTemplates, un differe est dit PERDU, pas « en attente »', () => {
  // `triggerTemplates` consomme un evenement one-shot que le dispatcher marque
  // traite juste apres : rien ne le rejouera. Le mot « en attente » y serait un
  // mensonge, et un rapport de cron qui ment vaut moins que pas de rapport.
  const bloc = src.split('async function triggerTemplates')[1]
  assert.ok(/NON ENVOYE et NON REJOUABLE/.test(bloc), 'la perte est nommee')
  assert.ok(/console\.error/.test(bloc.slice(0, bloc.indexOf('for (const template'))),
    'elle passe par console.error, pas par un log rassurant')
  assert.ok(/context: 'email_non_branche'/.test(bloc),
    'et elle remonte dans les erreurs du cycle')
})

test('les deux moteurs ne parlent pas de la meme chose avec le meme mot', () => {
  // checkAndSendTemplate est rejoue a chaque tick -> « en attente » y est vrai.
  // triggerTemplates ne l'est jamais -> « perdu ». La nuance est le correctif.
  const check = src.split('async function checkAndSendTemplate')[1].split('async function triggerTemplates')[0]
  const trigger = src.split('async function triggerTemplates')[1]
  assert.ok(/reexaminera|reexamine/.test(check), 'le chemin rejouable le dit')
  assert.ok(!/NON REJOUABLE/.test(check), 'et ne parle pas de perte')
  assert.ok(/NON REJOUABLE/.test(trigger), 'le chemin one-shot le dit')
})

test('le code d\'acces n\'alerte pas le fondateur pour un canal pas encore branche', () => {
  const arr = fs.readFileSync(path.join(__dirname, '..', 'lib/cron-arrival-code.js'), 'utf8')
  assert.ok(/if \(!sendResult\.differe\) \{\s*\n\s*await reportIncident\('send_failure'/.test(arr),
    'l\'incident est conditionne : « pas branche » n\'est pas « a echoue »')
  // Le filet, lui, reste inconditionnel : une porte fermee devant un voyageur.
  assert.ok(/task_type: 'auto_message'/.test(arr), 'la tache a l\'hote subsiste')
})

test('le code d\'acces n\'ecrit le fil que si le code est vraiment parti (hors OTA)', () => {
  const arr = fs.readFileSync(path.join(__dirname, '..', 'lib/cron-arrival-code.js'), 'utf8')
  assert.ok(/if \(filAvantEnvoi\) await supabase\.from\('conversations'\)\.insert\(ligneDuFil\)/.test(arr),
    'OTA : ordre historique conserve')
  assert.ok(/if \(!filAvantEnvoi && sendResult && sendResult\.ok\) \{/.test(arr),
    'hors OTA : le fil attend la preuve de l\'envoi')
  assert.ok(/if \(filAvantEnvoi \|\| \(sendResult && sendResult\.ok\)\) \{/.test(arr),
    'et `messages` aussi')
})

test('hasMessagingThread a disparu : plus personne ne peut la rappeler', () => {
  assert.ok(!/function hasMessagingThread/.test(src), 'la fonction est supprimee')
  assert.ok(!/hasMessagingThread\(/.test(src), 'et plus aucun appel ne subsiste')
})
