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
  // ⚠ `journalAvantEnvoi` N'EXISTE PLUS, et c'est le correctif du 29 octobre
  // 2026 : plus aucun canal n'ecrit avant l'envoi, donc plus aucun ordre a
  // tirer de la decision. Les deux moteurs passent par le MEME helper.
  assert.ok(!/journalAvantEnvoi/.test(src),
    'aucun ordre « journal avant envoi » ne subsiste')
  const appels = src.split('await envoyerEtJournaliser({').length - 1
  assert.strictEqual(appels, 2, 'et chacun appelle le helper partage')
})

test('LE TEST QUI COMPTE : sur AUCUN canal rien n\'est ecrit avant un succes', () => {
  // Le defaut d'origine : `noterEnvoi` etait appele AVANT l'envoi, donc trois
  // reservations Offline portent un message marque envoye que Channex avait
  // refuse. Sur le canal e-mail, l'echec doit laisser la place nette — le fil et
  // `messages` ne disent JAMAIS qu'un message est parti quand il ne l'est pas.
  // ⚠ LA GARDE A CHANGE DE FORME ET DE PORTEE. Elle ne vit plus dans deux
  // blocs recopies, mais dans le helper partage — et elle vaut desormais pour
  // l'OTA comme pour l'e-mail, ce qui est tout le correctif du 29 octobre 2026.
  const helper = src.split('async function envoyerEtJournaliser')[1]
    .split('async function processMessageTemplates')[0]
  // Le fil et le journal ne s'ecrivent QUE dans la branche du succes.
  const succes = helper.split('if (sendRes?.ok) {')[1].split('\n  }\n')[0]
  assert.ok(/from\('conversations'\)/.test(succes), 'le fil s\'ecrit sur un succes')
  assert.ok(/noterEnvoi/.test(succes), 'et le journal aussi')
  // Et nulle part ailleurs, sauf l'abandon e-mail.
  const apres = helper.split('if (sendRes?.ok) {')[1].split('\n  }\n').slice(1).join('\n  }\n')
  assert.ok(!/from\('conversations'\)/.test(apres),
    'aucun fil qui afficherait un message non delivre')
  assert.ok(!/recordMessage/.test(helper), 'et le helper n\'ecrit jamais dans `messages`')
  const journaux = (apres.match(/noterEnvoi/g) || []).length
  assert.strictEqual(journaux, 1, 'un seul journal apres l\'echec : celui de l\'abandon')
  assert.ok(/if \(abandon\) \{[\s\S]{0,200}?noterEnvoi/.test(apres),
    'et c\'est bien celui de l\'abandon e-mail')
  // ⚠ ET LES DEUX SITES REFUSENT LA DOUBLE ECRITURE SUR UN ECHEC : c'est elle
  // qui a menti, avec des lignes « outbound/auto » annoncant un message refuse.
  assert.ok(/if \(!envoi\.livre\) return/.test(src), 'le site rejouable sort sur un echec')
  assert.ok(/if \(!envoi\.livre\) continue/.test(src), 'le site one-shot aussi')
})

test('LE TEST QUI COMPTE : un abandon s\'ecrit, sinon le plafond ne plafonne rien', () => {
  // L'ancre a suivi le code : la politique e-mail vit dans le helper partage.
  const helper = src.split('async function envoyerEtJournaliser')[1]
    .split('async function processMessageTemplates')[0]
  assert.ok(/if \(abandon\) \{\s*\n\s*await noterEnvoi\(/.test(helper),
    'un message qu\'on renonce a envoyer ne doit pas repartir a chaque tick')
})

test('LE TEST QUI COMPTE : le chemin OTA n\'ecrit PLUS rien avant l\'envoi', () => {
  // ⚠ CE TEST DISAIT L'INVERSE, ET IL FIGEAIT LE DEFAUT — regle 17 de REVIEW.md
  // en acte. Il s'appelait « le chemin OTA garde son ordre historique : journal
  // AVANT envoi » et il etait VERT, pendant que la production perdait des
  // messages : `message_sent_log` ecrit avant l'envoi est la garde anti-doublon,
  // donc un refus du provider condamnait le message pour de bon et le fil
  // l'affichait comme parti.
  //
  // Mesure du 29 octobre 2026 : cinq envois en echec en sept jours sur
  // La bulle, et dans le journal la ligne est horodatee 0,1 a 0,6 seconde AVANT
  // l'incident — la meme tentative. CINQ messages perdus, un par echec : le
  // journal etant la garde anti-doublon, chacun etait condamne pour de bon.
  // (J'avais d'abord ecrit « trois » — en comptant les voyageurs dont AUCUN
  // message du meme type n'etait passe, au lieu des gabarits reellement
  // perdus. Un nombre ecrit a la main, encore.) Parmi eux, les consignes de
  // securite du jacuzzi et l'annonce des codes d'acces.
  //
  // Et le defaut etait DEJA ecrit dans `cron-messages.js` depuis septembre :
  // le correctif d'alors n'avait ete applique qu'au canal e-mail.
  const helper = src.split('async function envoyerEtJournaliser')[1]
    .split('async function processMessageTemplates')[0]
  // L'ancre est l'APPEL au provider, sans mot-cle de declaration : `sendRes`
  // est declare plus haut depuis que l'envoi vit dans un `try/finally` (le
  // verrou anti-doublon doit se relacher meme si l'envoi leve). Ancrer sur
  // `const sendRes =` rendait la tranche egale a TOUT le helper, et
  // l'assertion rougissait pour une raison qui n'etait pas la sienne.
  const avantEnvoi = helper.split('await sendGuestMessage(')[0]
  assert.ok(!/noterEnvoi/.test(avantEnvoi), 'aucun journal avant l\'appel au provider')
  assert.ok(!/from\('conversations'\)/.test(avantEnvoi), 'aucune ligne de fil non plus')
  assert.ok(!/recordMessage/.test(avantEnvoi), 'ni dans `messages`')
  // ⚠ MAIS LE VERROU, LUI, EST POSE AVANT : ne plus rien ecrire avant l'envoi a
  // emporte la protection anti-doublon que le defaut procurait par accident
  // (deux passes concurrentes lisaient la ligne et passaient leur tour).
  assert.match(avantEnvoi, /await tenirEnvoi\(/, 'la tenue est posee avant l appel')
  assert.match(helper, /await relacherEnvoi\(tenue\.key, tenue\.token\)/,
    'et relachee ensuite AVEC SON JETON : on ne supprime que sa propre tenue')
  assert.match(helper, /\} finally \{/, 'dans un finally, meme si l envoi leve')
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
  // ⚠ LA DISTINCTION EST DESORMAIS PORTEE PAR UN ARGUMENT, PAS PAR DU TEXTE
  // RECOPIE : le site one-shot passe `rejouable: false`, et le helper en tire
  // tout le reste (ni palier, ni plafond, alerte immediate).
  // ⚠ L'ORDRE DE DECLARATION COMPTE : `envoyerEtJournaliser` vient AVANT
  // `checkAndSendTemplate`, donc une tranche bornee par lui avale tout le
  // fichier — site one-shot compris. La borne est `triggerTemplates`.
  const check = src.split('async function checkAndSendTemplate')[1].split('async function triggerTemplates')[0]
  const trigger = src.split('async function triggerTemplates')[1]
  const helper = src.split('async function envoyerEtJournaliser')[1]
    .split('async function processMessageTemplates')[0]
  assert.ok(!/rejouable: false/.test(check), 'le chemin rejouable ne se declare pas one-shot')
  assert.ok(/rejouable: false/.test(trigger), 'le chemin one-shot le declare')
  assert.ok(/send_message_one_shot/.test(helper),
    'et le helper le distingue dans les erreurs du cycle')
  assert.ok(/NON REJOUABLE/.test(helper), 'en le nommant dans l\'erreur')
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
  // ⚠ L'ALERTE A CHANGE DE NOM ET DE PORTEE : elle vaut maintenant pour l'OTA
  // comme pour l'e-mail, et c'est `noterAbandonOta` qui la pose — avec
  // `threshold: 1`, donc sans attendre une seconde occurrence qui ne viendra
  // jamais sur un evenement one-shot.
  const trigger = src.split('async function triggerTemplates')[1]
  const helper = src.split('async function envoyerEtJournaliser')[1]
    .split('async function processMessageTemplates')[0]
  assert.ok(/rejouable: false/.test(trigger), 'le site one-shot se declare')
  // La tranche s'arrete au `return` du bloc, pas a un nombre de caracteres :
  // 700 caracteres debordaient sur le `noterRefusOta` du chemin rejouable, et
  // l'assertion « rien n'est compte » mesurait alors la ligne d'a cote.
  // ⚠ DEUX BLOCS `!rejouable` DESORMAIS — un par canal — et les DEUX doivent
  // alerter tout de suite sans compter. Ma premiere version ne lisait que le
  // premier, donc elle ne mesurait que la moitie de la garantie (constat d'une
  // revue independante : la distinction one-shot de l'e-mail avait disparu de
  // ma factorisation, avec l'assertion qui la tenait).
  // ⚠ LES DEUX BLOCS N'ONT PAS LA MEME INDENTATION — celui de l'e-mail vit dans
  // `if (!estOta) {`, donc a quatre espaces ; celui de l'OTA a deux. Couper sur
  // un seul terminateur faisait deborder l'un des deux sur le code suivant, et
  // l'assertion « rien n'est compte » mesurait alors la ligne d'a cote. On
  // coupe au PREMIER des deux terminateurs qui se presente.
  const finDeBloc = (b) => {
    const a = b.indexOf('\n  }\n'), c = b.indexOf('\n    }\n')
    const bornes = [a, c].filter(x => x >= 0)
    return bornes.length ? b.slice(0, Math.min(...bornes)) : b
  }
  const blocs = helper.split('if (!rejouable) {').slice(1).map(finDeBloc)
  assert.equal(blocs.length, 2, 'un bloc one-shot par canal : e-mail et OTA')
  for (const bloc of blocs) {
    assert.ok(/noterAbandonOta|reportIncident\('email_voyageur_abandon'/.test(bloc),
      'l\'alerte part directement')
    assert.ok(!/noterRefusOta/.test(bloc), 'rien n\'est COMPTE : le plafond serait inatteignable')
    assert.ok(!/faut_il_abandonner_email\(/.test(bloc),
      'et le compteur e-mail n\'est pas appele non plus')
  }
  const ota = require('../lib/envoi-ota')
  assert.equal(typeof ota.noterAbandonOta, 'function', 'le writer de l\'abandon est exporte')
  // Le compteur e-mail reste reserve au chemin qui peut vraiment reessayer.
  const emails = (helper.match(/await faut_il_abandonner_email\(/g) || []).length
  assert.strictEqual(emails, 1, 'un seul appel au compteur e-mail, dans sa branche')
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

test('LE TEST QUI COMPTE : le rejeu inscrit ce qu\'il envoie dans le fil', () => {
  // Constate en production : le rejeu atteignait le voyageur sans laisser de
  // trace dans `messages`, pendant que la ligne mensongere d'un envoi jamais
  // parti y figurait toujours. L'hote voyait l'inverse de la verite.
  const rejeu = fs.readFileSync(path.join(__dirname, '..', 'scripts/rejouer-message-offline.js'), 'utf8')
  assert.ok(/require\('\.\.\/lib\/record-message'\)/.test(rejeu), 'il importe le writer du fil')
  const apresEnvoi = rejeu.split('ENVOYE — canal')[1]
  assert.ok(/await recordMessage\(/.test(apresEnvoi), 'et l\'appelle APRES l\'envoi reussi')
  assert.ok(/canal: envoi\.canal === 'email' \? 'email' : 'ota'/.test(apresEnvoi),
    'avec le canal reellement emprunte')
})
