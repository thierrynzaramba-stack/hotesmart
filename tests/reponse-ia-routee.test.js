// tests/reponse-ia-routee.test.js
// Chantier « inbound e-mail » — etape 6, fermeture de la DETTE 3.
//
// `lib/cron-classify.js` appelait `channex.sendMessage` LUI-MEME, sans lire le
// retour, puis ecrivait dans `messages` inconditionnellement. Sur une
// reservation `Offline`, Channex rend HTTP 422 `not_supported` : le voyageur ne
// recevait rien et le cœur affirmait le contraire.
//
// C'etait sans objet tant qu'aucune Offline n'avait de fil. L'inbound e-mail
// vient d'en creer un : la dette devient une panne.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const src = fs.readFileSync(path.join(__dirname, '..', 'lib/cron-classify.js'), 'utf8')

test('LE TEST QUI COMPTE : plus AUCUN appel provider en direct', () => {
  // La forme exacte qui posait probleme, et toutes ses voisines.
  assert.ok(!/getProvider\(['"]channex['"]\)\.sendMessage/.test(src),
    'channex.sendMessage en direct')
  assert.ok(!/sendViaBeds24\s*\(/.test(src.replace(/\/\/[^\n]*/g, '')),
    'sendViaBeds24 en direct')
  // ⚠ ON N'INTERDIT PAS `require('./channels')`, ET C'EST VOLONTAIRE.
  // Premiere version de ce test : elle bannissait tout usage du module. Or il
  // reste deux appels parfaitement sains — `syncMessages` et
  // `getPropertyMessages`, qui LISENT les fils. Ce qu'on interdit, c'est
  // d'ENVOYER sans passer par le routage, pas de parler au provider.
  // Une assertion trop large aurait fait echouer un code juste, et on l'aurait
  // desarmee au lieu de la preciser.
  const appelsProvider = [...src.matchAll(/getProvider\(['"](\w+)['"]\)\.(\w+)/g)]
    .map(m => `${m[1]}.${m[2]}`)
  for (const appel of appelsProvider) {
    assert.ok(!/\.sendMessage$/.test(appel), `envoi en direct : ${appel}`)
  }
  // La liste EXHAUSTIVE de ce qui parle encore au provider depuis ce module.
  // Elle echoue si un appel s'ajoute — y compris un qui ne serait pas un envoi :
  // c'est voulu, on veut le voir passer et le qualifier, pas le decouvrir en
  // production. (Limite connue : `provider.getPropertyMessages(...)`, appele via
  // une variable, echappe a cette regex. C'est une lecture, et elle est couverte
  // par le premier controle : elle ne s'appelle pas `sendMessage`.)
  assert.deepStrictEqual([...new Set(appelsProvider)].sort(),
    ['beds24.syncBookings', 'beds24.syncMessages'],
    'seules des LECTURES et des synchros passent encore par le provider ici')
})

test('LE TEST QUI COMPTE : l\'envoi passe par sendGuestMessage, avec le BOOKING', () => {
  // Avec un identifiant nu, `sendGuestMessage` ne peut router que par provider :
  // c'est le comportement d'avant le chantier, et la resa Offline repart vers
  // le 422.
  assert.ok(/const \{ sendGuestMessage \} = require\('\.\/cron-messages'\)/.test(src))
  assert.ok(/sendGuestMessage\(beds24Key, property, booking \|\| bookingId,/.test(src),
    'le booking est passe, l\'identifiant n\'est qu\'un repli')
  assert.ok(/\{ userId, eventType: 'reponse_ia' \}/.test(src),
    'et le compte proprietaire, sans quoi aucun e-mail ne peut partir')
})

test('LE TEST QUI COMPTE : le retour est LU, et un echec n\'ecrit rien', () => {
  const bloc = src.split('const envoi = await sendGuestMessage')[1].split('await recordMessage')[0]
  assert.ok(/if \(!envoi\?\.ok\)/.test(bloc), 'le retour est teste')
  assert.ok(/return true/.test(bloc), 'et on sort avant toute ecriture')
  // Ni fil, ni `messages` : rien ne doit affirmer qu'une reponse est partie.
  const avantSortie = bloc.split('return true')[0]
  assert.ok(!/from\('conversations'\)/.test(avantSortie), 'aucun fil sur un echec')
  assert.ok(!/recordMessage/.test(avantSortie), 'aucune ligne dans messages sur un echec')
})

test('un echec de reponse IA REMONTE : erreurs de cycle et incident', () => {
  // Avant, l'echec etait avale : le voyageur attendait, et personne ne le savait.
  const bloc = src.split('const envoi = await sendGuestMessage')[1].split('return true')[0]
  assert.ok(/context: 'reponse_ia'/.test(bloc), 'dans les erreurs du cycle')
  assert.ok(/reportIncident\('send_failure'/.test(bloc), 'et en incident')
  assert.ok(/Le voyageur attend toujours/.test(bloc), 'avec ce que ca implique')
})

test('`messages` porte le canal REELLEMENT emprunte', () => {
  const bloc = src.split('const envoi = await sendGuestMessage')[1]
  assert.ok(/canal:\s+envoi\.canal === 'email' \? 'email' : 'ota'/.test(bloc))
})

test('les deux chemins fournissent le booking', () => {
  // Channex depuis le snapshot du cœur (source + guestEmail), Beds24 depuis le
  // booking brut de l'API (channel / apiSource).
  assert.ok(/\{ id: bookingId, \.\.\.snap \}/.test(src), 'chemin Channex')
  assert.ok(/booking \? \{ id: bookingId, \.\.\.booking \} : \{ id: bookingId \}/.test(src),
    'chemin Beds24')
})

test('le kill switch et le Mode Test restent EN AMONT de l\'envoi', () => {
  // Ils gardaient deja ce bloc ; les deplacer sous le routage les rendrait
  // contournables par le canal e-mail.
  const i = src.indexOf('const paused = await isAutomationPaused')
  const j = src.indexOf('const envoi = await sendGuestMessage')
  assert.ok(i > 0 && j > i, 'le kill switch precede l\'envoi')
  assert.ok(src.indexOf("propMode === 'test'") < j, 'le Mode Test aussi')
})
