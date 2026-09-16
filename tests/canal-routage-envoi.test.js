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
const appels = { channex: [], beds24: [], email: [] }
const etat = { reponseEmail: null }

const origine = Module._load
Module._load = function (d, ...reste) {
  if (d === './channels/channex') return {
    sendMessage: async (ctx, { bookingId, message }) => {
      appels.channex.push({ bookingId, message })
      return { success: true, status: 200, data: {} }
    }
  }
  if (d === './email-guestflow') {
    const vrai = origine.apply(this, [d, ...reste])
    return {
      ...vrai,
      envoyerEmailVoyageur: async o => {
        appels.email.push(o)
        return etat.reponseEmail || { ok: true, id: 'msg-1', expediteur: 'hote@exemple.test' }
      }
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

const remise = () => { appels.channex = []; appels.beds24 = []; appels.email = []; etat.reponseEmail = null }

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
test('PREUVE 2 — Offline avec adresse : AUCUN appel provider, un envoi e-mail', async () => {
  remise()
  const r = await sendGuestMessage(null, BIEN_CHANNEX,
    { id: 'c87f24ce', source: 'Offline', guestEmail: 'voyageur@exemple.test' }, 'bonjour',
    { userId: 'U', eventType: 'arrival' })
  assert.strictEqual(appels.channex.length, 0,
    'c\'est exactement l\'appel qui rendait 422 not_supported')
  assert.strictEqual(appels.beds24.length, 0)
  assert.strictEqual(r.canal, 'email')
  assert.strictEqual(r.destinataire, 'voyageur@exemple.test')
  assert.strictEqual(appels.email.length, 1, 'l\'e-mail, lui, est bien parti')
  assert.strictEqual(appels.email[0].destinataire, 'voyageur@exemple.test')
  assert.strictEqual(appels.email[0].userId, 'U', 'sur la cle du compte proprietaire')
  assert.strictEqual(appels.email[0].sujet, 'Votre arrivée à Colomiers')
  assert.strictEqual(r.ok, true)
})

test('PREUVE 2 bis — sans compte proprietaire, on n\'envoie PAS', async () => {
  // Deviner le compte ferait partir un message sur la cle de quelqu'un d'autre.
  remise()
  const r = await sendGuestMessage(null, BIEN_CHANNEX,
    { id: 'c87f24ce', source: 'Offline', guestEmail: 'v@exemple.test' }, 'bonjour', {})
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.permanent, true)
  assert.strictEqual(appels.email.length, 0)
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
  // refuse. Sur le canal e-mail, l'echec doit laisser la place nette — le fil et
  // `messages` ne disent JAMAIS qu'un message est parti quand il ne l'est pas.
  const blocs = src.split('if (!journalAvantEnvoi && !sendRes?.ok) {').slice(1)
  assert.strictEqual(blocs.length, 2, 'les deux moteurs portent la garde')
  for (const bloc of blocs) {
    const corps = bloc.split(/\n\s+(?:continue|return)\n/)[0]
    assert.ok(!/from\('conversations'\)/.test(corps), 'aucun fil qui afficherait un message non delivre')
    assert.ok(!/recordMessage/.test(corps), 'aucune ligne dans `messages`')
    // Seule exception, et elle est l'inverse d'un faux vert : quand on ABANDONNE
    // pour de bon, le journal s'ecrit — sans lui, le plafond ne plafonnerait rien
    // et le message repartirait a chaque tick.
    const journaux = (corps.match(/noterEnvoi/g) || []).length
    if (journaux) {
      assert.ok(/if \(abandon\) \{[\s\S]*?noterEnvoi/.test(corps),
        'le seul journal admis est celui de l\'abandon')
      assert.strictEqual(journaux, 1, 'et il n\'y en a qu\'un')
    }
  }
})

test('LE TEST QUI COMPTE : un abandon s\'ecrit, sinon le plafond ne plafonne rien', () => {
  const check = src.split('async function checkAndSendTemplate')[1].split('async function triggerTemplates')[0]
  assert.ok(/if \(abandon\) \{\s*\n\s*await noterEnvoi\(/.test(check),
    'un message qu\'on renonce a envoyer ne doit pas repartir a chaque tick')
})

test('le chemin OTA garde son ordre historique : journal AVANT envoi', () => {
  // L'anti-boucle. Un envoi qui part sans etre note repart toutes les 5 minutes.
  for (const bloc of src.split('if (journalAvantEnvoi) {').slice(1)) {
    const corps = bloc.split('\n      }\n')[0]
    assert.ok(/noterEnvoi/.test(corps), 'le journal est bien pose dans la branche OTA')
  }
  const avant = src.indexOf('if (journalAvantEnvoi) {')
  const envoi = src.indexOf('const sendRes = await sendGuestMessage(beds24Key, property, booking, message,')
  assert.ok(avant > 0 && envoi > avant, 'et il precede l\'envoi')
})

// ─── 4. Les correctifs de review (16 septembre 2026) ─────────────────────────
const { ENVOI_EMAIL_BRANCHE } = require('../lib/canal-voyageur')

test('l\'interrupteur du canal e-mail est ouvert, et reste un kill switch', () => {
  assert.strictEqual(ENVOI_EMAIL_BRANCHE, true, 'ouvert depuis l\'etape 3')
  // Les sorties anticipees sont CONSERVEES apres l'ouverture : c'est le seul
  // moyen de couper le canal e-mail sans deployer.
  assert.ok(src.includes('if (decision.canal === CANAL.EMAIL && !ENVOI_EMAIL_BRANCHE) {'),
    'la garde subsiste pour que refermer reste un geste sur')
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
  // checkAndSendTemplate est rejoue a chaque tick : un echec transitoire y
  // repassera. triggerTemplates consomme un evenement one-shot : il n'aura pas de
  // seconde chance, et le dit en erreur de cycle meme sans abandon formel.
  const check = src.split('async function checkAndSendTemplate')[1].split('async function triggerTemplates')[0]
  const trigger = src.split('async function triggerTemplates')[1]
  assert.ok(!/NON REJOUABLE/.test(check), 'le chemin rejouable ne parle pas de perte')
  assert.ok(/NON REJOUABLE/.test(trigger), 'le chemin one-shot le dit')
  assert.ok(/send_message_one_shot/.test(trigger), 'et le distingue dans les erreurs du cycle')
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

// ─── 5. Les correctifs de la review de l'etape 3 ─────────────────────────────
test('LE TEST QUI COMPTE : `quota` traverse sendGuestMessage', async () => {
  // Il etait perdu au passage, donc la branche « quota » de la politique
  // d'abandon etait morte : un forfait Brevo journalier epuise se faisait
  // compter comme un echec ordinaire, et le message etait abandonne au bout de
  // 25 minutes — alors qu'il repart a minuit.
  remise()
  etat.reponseEmail = { ok: false, quota: true, permanent: false, raison: 'brevo_429: daily limit' }
  const r = await sendGuestMessage(null, BIEN_CHANNEX,
    { id: 'c87f24ce', source: 'Offline', guestEmail: 'v@exemple.test' }, 'bonjour',
    { userId: 'U', eventType: 'arrival' })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.quota, true, 'sans ce champ, le plafond compte un quota comme une panne')
  assert.strictEqual(r.permanent, false)
})

test('`permanent` traverse aussi, et commande l\'abandon', async () => {
  remise()
  etat.reponseEmail = { ok: false, permanent: true, raison: 'brevo_400: Invalid email address' }
  const r = await sendGuestMessage(null, BIEN_CHANNEX,
    { id: 'c87f24ce', source: 'Offline', guestEmail: 'pas-une-adresse' }, 'bonjour',
    { userId: 'U', eventType: 'arrival' })
  assert.strictEqual(r.permanent, true)
  assert.notStrictEqual(r.quota, true)
})

test('le bien accompagne l\'envoi, pour qu\'un quota s\'annonce avec lui', async () => {
  remise()
  await sendGuestMessage(null, BIEN_CHANNEX,
    { id: 'c87f24ce', source: 'Offline', guestEmail: 'v@exemple.test' }, 'bonjour',
    { userId: 'U', eventType: 'arrival' })
  assert.strictEqual(appels.email[0].propertyId, BIEN_CHANNEX.id)
  assert.strictEqual(appels.email[0].propertyName, BIEN_CHANNEX.name)
})

test('LE TEST QUI COMPTE : sur le chemin one-shot, un echec ALERTE tout de suite', () => {
  // Le plafond y est inatteignable (une seule tentative par evenement) : s'en
  // remettre a lui, c'etait remplacer une alerte qui marchait — `send_failure` a
  // la 2e occurrence — par un compteur qui n'arrive jamais a 5.
  const trigger = src.split('async function triggerTemplates')[1]
  assert.ok(/reportIncident\('email_voyageur_abandon'/.test(trigger),
    'l\'alerte part directement, sans passer par le compteur')
  assert.ok(/threshold: 1/.test(trigger.split("reportIncident('email_voyageur_abandon'")[1].slice(0, 300)),
    'et elle ne s\'attend pas a une seconde occurrence')
  // Le nom apparait dans le commentaire qui explique pourquoi on ne l'appelle
  // PAS ici : c'est l'appel qu'on interdit, pas la mention.
  assert.ok(!/await faut_il_abandonner_email\(/.test(trigger),
    'le compteur est reserve au chemin qui peut vraiment reessayer')
})

test('la politique d\'abandon teste le quota, et il peut l\'atteindre', () => {
  const politique = src.split('async function faut_il_abandonner_email')[1].slice(0, 1600)
  assert.ok(/if \(sendRes\?\.permanent\)/.test(politique), 'permanent en premier')
  assert.ok(/if \(sendRes\?\.quota\)/.test(politique), 'quota ensuite, et hors plafond')
  const iPermanent = politique.indexOf('sendRes?.permanent')
  const iQuota = politique.indexOf('sendRes?.quota')
  const iCompte = politique.indexOf('compterEchecs')
  assert.ok(iPermanent < iQuota && iQuota < iCompte,
    'un quota ne doit jamais atteindre le compteur')
})
