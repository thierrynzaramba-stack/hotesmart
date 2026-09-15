// tests/messages-import-recurrent.test.js
// LE DEFAUT : l'agent IA pouvait repondre DEUX FOIS au meme voyageur.
//
// `getPropertyMessages` (Channex) lisait `conversations` — qui ne porte que les
// messages du VOYAGEUR en attente de reponse — et etiquetait chaque ligne
// `sender: 'guest'` EN DUR. La garde de l'appelant, « si le dernier message du
// fil vient de l'hote, il n'y a rien a traiter », ne pouvait donc JAMAIS se
// declencher pour un bien Channex. Elle existait, elle etait juste, elle etait
// morte.
//
// MESURE SUR LES DONNEES REELLES, 14 septembre 2026 : une fois la fonction
// branchee sur le coeur, 53 fils sur 69 sont ecartes par cette garde. Avant,
// necessairement ZERO.

process.env.TZ = 'Europe/Paris'
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'
process.env.CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || 'cle-test'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const lire = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

// ─── La source : getPropertyMessages lit le COEUR, avec le vrai sens ────────

test('LE TEST QUI COMPTE : le sens du message vient de la donnee, il n est plus en dur', () => {
  const src = lire('lib/channels/channex.js')
  const i = src.indexOf('async function getPropertyMessages')
  const fin = src.indexOf('function normOta')
  assert.ok(i > 0 && fin > i, 'la fonction est reperable')
  const bloc = src.slice(i, fin)

  assert.ok(bloc.includes(".from('messages')"), 'elle lit le coeur')
  assert.ok(!bloc.includes(".from('conversations')"), 'et plus `conversations`, qui n a qu un seul sens')
  assert.ok(!/sender: 'guest'(?!\s*\|)/.test(bloc.replace(/\/\/.*$/gm, '')),
    'aucun expediteur en dur : c est ce qui tuait la garde')
  assert.ok(bloc.includes("m.direction === 'inbound' ? 'guest' : 'host'"),
    'le sens fait foi — un message `auto` parti de nos modeles est, pour l appelant, un message de l hote')
})

test('LE TEST QUI COMPTE : la lecture est CLOISONNEE PAR COMPTE, et refuse sans compte', () => {
  // `property_id` est la cle PROVIDER : aucune unicite globale. L ancienne
  // version ne filtrait pas le compte — le fil d un hote pouvait etre servi a
  // l agent d un autre.
  const src = lire('lib/channels/channex.js')
  const i = src.indexOf('async function getPropertyMessages')
  const bloc = src.slice(i, src.indexOf('function normOta'))
  assert.ok(bloc.includes(".eq('user_id', userId)"), 'le compte est dans la requete')
  assert.ok(/if \(!userId\) \{/.test(bloc), 'et son absence est un REFUS, pas un defaut silencieux')
  const posRefus = bloc.indexOf('if (!userId)')
  const posLecture = bloc.indexOf(".from('messages')")
  assert.ok(posRefus > 0 && posRefus < posLecture, 'le refus precede la lecture')
  assert.ok(lire('lib/cron-classify.js').includes('getPropertyMessages({ userId, providerPropertyId'),
    'et l appelant le fournit')
})

test('LE TEST QUI COMPTE : la lecture du fil est BORNEE — le cap PostgREST tronque en silence', () => {
  // On ne lit plus « ce qui attend une reponse » mais TOUT le fil : un bien
  // actif porte des milliers de messages, et PostgREST s arrete a 1000 lignes
  // SANS erreur. Mesure du jour : La bulle porte 204 messages sur 30 jours.
  const src = lire('lib/channels/channex.js')
  const bloc = src.slice(src.indexOf('async function getPropertyMessages'), src.indexOf('function normOta'))
  assert.ok(bloc.includes(".gte('sent_at', depuis)"), 'bornee par une fenetre de temps')
  assert.ok(bloc.includes('.limit(MESSAGES_MAX)'), 'et par un plafond explicite')
  assert.ok(bloc.includes(".order('sent_at'"), 'avec un ordre : sans lui, le plafond rend un sous-ensemble different a chaque passage')
})

// ─── La garde, chez l'appelant ──────────────────────────────────────────────

test('LE TEST QUI COMPTE : « dernier message du voyageur » ne veut plus dire « dernier message »', () => {
  // Tant que tout etait etiquete 'guest', le `reduce` sans filtre etait juste
  // par accident. Avec le vrai sens, prendre le maximum sur TOUS les messages
  // ferait passer une reponse de l hote pour une sollicitation du voyageur :
  // `hasNewerTaskOrConv` comparerait une tache a l heure de NOTRE reponse, et
  // la garde se relacherait au lieu de se resserrer.
  const src = lire('lib/cron-classify.js')
  const i = src.indexOf('const lastGuestTime = threadMsgs.reduce')
  assert.ok(i > 0, 'le calcul est reperable')
  const bloc = src.slice(i, i + 260)
  assert.ok(bloc.includes("m.source === 'guest'"), 'le maximum ne porte QUE sur les messages du voyageur')
  assert.ok(src.includes('if (!lastGuestTime) continue'),
    'et un fil ou le voyageur n a jamais rien ecrit n attend rien de nous')
})

test('LE TEST QUI COMPTE : la garde « dernier message de l hote » precede tout appel au modele', () => {
  // ⚠ BORNE A LA FONCTION CHANNEX. Ma premiere version cherchait
  // `classifyAndHandle` dans TOUT le fichier : elle tombait sur l occurrence du
  // chemin BEDS24, situee bien avant, et comparait deux chemins differents.
  // Le meme travers que l aperçu qui ne calculait pas comme le code.
  const src = lire('lib/cron-classify.js')
  const debut = src.indexOf('async function processChannelPropertyMessages')
  assert.ok(debut > 0, 'la fonction Channex est reperable')
  const bloc = src.slice(debut, src.indexOf('\nasync function', debut + 10))
  const posGarde = bloc.indexOf("if (lastMsg && lastMsg.source === 'host') continue")
  const posIA = bloc.indexOf('const handled = await classifyAndHandle(')
  assert.ok(posGarde > 0, 'la garde existe dans le chemin Channex')
  assert.ok(posIA > posGarde, 'et elle sort AVANT l appel au modele — sinon elle coute ce qu elle pretend economiser')
})

// ─── L'import recurrent : budget, abstention, annonce ───────────────────────

test('LE TEST QUI COMPTE : l import passe APRES les codes d acces, et dans son PROPRE try', () => {
  // ⚠ Exigence de Thierry, et elle vient du 10 septembre 2026 : un
  // `ReferenceError` dans le premier appel d un `try` commun a emporte
  // `processArrivalCodes` pendant 24 h — plus aucun code cree, une voyageuse
  // devant une porte fermee. Une synchro de messages ne doit jamais couter un
  // code d acces.
  // ⚠ DEPUIS LE CORRECTIF DU BLOQUANT 4, L'IMPORT EST UNE PHASE A PART, apres
  // la boucle metier entiere — donc apres les codes d acces de TOUS les biens.
  // C'est plus fort que l'exigence d'origine : meme un import qui deborde ne
  // peut plus couter un code, ils sont tous deja poses.
  const src = lire('lib/cron-channel-props.js')
  const posCodes = src.indexOf('await processArrivalCodes(')
  const posImport = src.indexOf('await importerMessagesDuBien(')
  assert.ok(posCodes > 0 && posImport > posCodes, 'l import vient APRES les codes d acces')

  // La boucle metier est REFERMEE avant la phase d import.
  const posPhase = src.indexOf('SECONDE PASSE')
  assert.ok(posPhase > posCodes && posPhase < posImport, 'une phase distincte les separe')

  // Et l import garde son propre try, par bien.
  const apres = src.slice(posImport - 500, posImport)
  assert.ok(apres.lastIndexOf('try {') > apres.lastIndexOf('} catch'),
    'l import ouvre son propre try')
})

test('LE TEST QUI COMPTE : le budget est une echeance pour TOUT le parc, pas par bien', () => {
  // Si chaque bien s octroyait son budget, quatre biens suffiraient a faire
  // deborder un cycle deja a 40-56 s pour un plafond de 60.
  // ⚠ CE TEST AFFIRMAIT LE DEFAUT. Il exigeait que l'echeance soit posee AVANT
  // la boucle par bien — c'est-a-dire exactement le bloquant 4 : elle mesurait
  // alors le cycle entier, et les derniers biens s'abstenaient a chaque passage.
  // Elle doit etre posee au debut de la PHASE d'import, pas du cycle.
  const src = lire('lib/cron-channel-props.js')
  assert.ok(src.includes('const echeanceImport = Date.now() + BUDGET_IMPORT_PARC_MS'),
    'l echeance appartient a la phase d import')
  const posMetier = src.indexOf('await processArrivalCodes(')
  const posEcheance = src.indexOf('const echeanceImport =')
  assert.ok(posEcheance > posMetier,
    'et elle demarre APRES le travail metier : sinon elle mesure ce qu elle ne borne pas')
})

test('LE TEST QUI COMPTE : une passe INTERROMPUE n avance PAS le marqueur', async () => {
  // ⚠ Sinon les fils sautes par le budget seraient perdus DEFINITIVEMENT : on
  // ne les relirait jamais. Une passe tronquee ne coute qu un cycle de retard ;
  // un marqueur avance a tort coute un fil entier.
  const src = lire('lib/channels/channex.js')
  assert.ok(src.includes('jusqua: interrompu ? null : (plusRecent != null'),
    'le provider ne rend un marqueur que si la passe est allee au bout')
  const sync = lire('lib/cron-channel-messages-sync.js')
  const i = sync.indexOf('if (r?.interrompu)')
  assert.ok(i > 0, 'et l orchestrateur traite le cas')
  // ⚠ LE BLOC SE DELIMITE PAR SON ACCOLADE, PAS PAR 300 CARACTERES. La fenetre
  // fixe a lache des qu'un commentaire a ete ajoute dans la branche : le test
  // rougissait sur une modification parfaitement correcte, et il aurait aussi
  // bien pu VERDIR sur une branche devenue trop longue pour tenir dedans.
  const fin = sync.indexOf('\n  }', i)
  const bloc = sync.slice(i, fin > i ? fin : i + 600)
  assert.ok(bloc.includes('sAbstenir'), 'il compte une abstention')
  assert.ok(!bloc.includes('ecrireEtat'), 'et n avance pas l etat lui-meme')
})

test('LE TEST QUI COMPTE : une passe interrompue GARDE son point de reprise', () => {
  // ⚠ LE BLOCAGE MESURE EN PRODUCTION LE 15 SEPTEMBRE 2026. Le marqueur
  // d'anteriorite ne bouge pas sur une passe tronquee — c'est juste — mais SANS
  // POINT DE REPRISE, le cycle suivant recommence le fil depuis sa page 1. Sur
  // un fil plus long que le budget de 2,5 s, il n'atteint JAMAIS la fin :
  // 125 abstentions d'affilee sur quatre biens, marqueur a `null`, et l'annonce
  // d'ecriture de masse repartie a chaque cycle avec le meme compte.
  // « On recommencera » et « on reprendra » ne sont pas la meme chose.
  const prov = lire('lib/channels/channex.js')
  assert.ok(prov.includes('repriseSuivante = { fil:'),
    'le provider dit OU il s est arrete')
  assert.ok(prov.includes('reprise: repriseSuivante'),
    'et il le rend a l appelant')
  assert.ok(/msgPage = Math\.max\(1, Number\(reprise\.page\)/.test(prov),
    'et il REPART de cette page')
  assert.ok(prov.includes('String(th.id) === String(reprise.fil)'),
    'mais seulement sur le MEME fil — l appliquer a un autre sauterait ses premieres pages')

  const sync = lire('lib/cron-channel-messages-sync.js')
  assert.ok(sync.includes('reprise: reprise || etat.reprise || null'),
    'une abstention CONSERVE le point de reprise')
  assert.ok(sync.includes('abstentions: 0, reprise: null'),
    'et une passe complete l EFFACE — sinon on rejouerait a jamais un fil deja importe')
})

test('LE TEST QUI COMPTE : une REPRISE ne se re-annonce pas', () => {
  // ⚠ Le preavis d'ecriture de masse prepare l'alerte de croissance. Le lot est
  // le MEME a chaque reprise : le re-annoncer a chaque cycle est precisement ce
  // qui a noye le signal pendant 125 cycles — 222 incidents en 24 h, dont un
  // e-mail par bien et par heure, pendant que l'alarme qui disait le blocage
  // etait muette depuis le 3e cycle.
  const prov = lire('lib/channels/channex.js')
  assert.ok(prov.includes('if (!annonceFaite && !reprise'),
    'on annonce quand on COMMENCE, pas quand on continue')
})

test('LE TEST QUI COMPTE : un import bloque le REDIT, il ne se tait pas', () => {
  // ⚠ « Une seule fois quand l etat s installe » a produit l inverse de ce qu on
  // voulait : l incident est parti au 3e cycle, puis PLUS JAMAIS, pendant que
  // l import restait bloque 125 cycles. Une alarme qui ne parle qu une fois
  // laisse une panne s installer en silence.
  const src = lire('lib/cron-channel-messages-sync.js')
  assert.ok(/abstentions % RAPPEL_TOUS_LES === 0/.test(src),
    'l incident se redit periodiquement tant que le blocage dure')
  const m = /const RAPPEL_TOUS_LES = (\d+)/.exec(src)
  assert.ok(m, 'la periode est nommee')
  assert.ok(Number(m[1]) >= 6 && Number(m[1]) <= 24,
    'assez rare pour ne pas faire de bruit, assez frequent pour rester visible')
})

test('LE TEST QUI COMPTE : l abstention est COMPTEE, et signalee quand elle s installe', () => {
  // « Muet cote voyageur, mais ca doit se voir » — sinon c est encore une panne
  // qui dort, la meme famille que l erreur avalee derriere un cron a 200.
  const src = lire('lib/cron-channel-messages-sync.js')
  assert.ok(src.includes('results.messagesImportAbstentions'), 'le bilan du cycle porte le compte')
  assert.ok(src.includes('abstentions === ABSTENTIONS_AVANT_INCIDENT'),
    'l incident part A L EGALITE : une fois quand l etat s installe, pas a chaque cycle ensuite')
  assert.ok(src.includes("reportIncident('messages_import_suspendu'"), 'et c est un incident durable')
  assert.ok(/l'agent IA travaille sur un fil ampute/.test(src),
    'dont le texte dit la CONSEQUENCE, pas seulement le symptome')
})

test('LE TEST QUI COMPTE : une ecriture de masse s ANNONCE avant d ecrire', () => {
  // ⚠ Regle de Thierry, 14 septembre 2026 : 173 lignes creees en une heure ont
  // declenche « croissance anormale » dix minutes apres qu on lui ait dit que
  // tout allait bien. Sa seule facon de distinguer notre geste d une boucle
  // d ecriture etait de nous le demander.
  const provider = lire('lib/channels/channex.js')
  const posAnnonce = provider.indexOf('ctx.avantEcriture({')
  const posEcriture = provider.indexOf('const res = await recordMessage({')
  assert.ok(posAnnonce > 0 && posAnnonce < posEcriture,
    'le crochet est appele AVANT la premiere ecriture')
  assert.ok(provider.includes('message_count'),
    'et l estimation vient du fil lui-meme : aucun appel supplementaire')

  const sync = lire('lib/cron-channel-messages-sync.js')
  assert.ok(sync.includes("reportIncident('ecriture_de_masse_annoncee'"), 'l annonce est un incident')
  assert.ok(/ce n'est PAS une boucle d'ecriture/.test(sync),
    'et elle reprend la formule du backfill, que la sonde de croissance rend lisible')
  assert.ok(sync.includes('messages < ANNONCE_A_PARTIR_DE'),
    'seul un VOLUME s annonce : annoncer deux messages ferait du bruit, et un bruit permanent ne se lit plus')
})

test('LE TEST QUI COMPTE : un etat ILLISIBLE fait s abstenir, il ne relance pas un import complet', () => {
  // Retomber sur `null` ferait repartir l import a zero — des centaines
  // d ecritures, et l alerte de croissance avec.
  const src = lire('lib/cron-channel-messages-sync.js')
  // ⚠ LE BLOC SE DELIMITE PAR SA FONCTION, PAS PAR UN NOMBRE DE CARACTERES.
  // Une fenetre fixe rougit des qu'on ajoute un commentaire — c'est arrive trois
  // fois dans la meme journee — et, plus grave, elle VERDIT le jour ou la ligne
  // qu'elle cherche sort de la fenetre sans avoir disparu du code.
  const i = src.indexOf('async function lireEtat')
  const fin = src.indexOf('\nasync function ecrireEtat', i)
  assert.ok(i > 0 && fin > i, 'les deux fonctions d etat sont introuvables')
  const bloc = src.slice(i, fin)
  assert.ok(bloc.includes('illisible: true'), 'l echec de lecture est MARQUE, pas confondu avec « jamais importe »')
  // ⚠ ET LA COLONNE LUE EST DEMANDEE. Son absence du `select` rendait tout le
  // point de reprise inerte : PostgREST ne renvoie que ce qu'on demande, donc
  // `data.errors` valait `undefined` et la reprise n'etait jamais relue.
  assert.match(bloc, /select\('[^']*errors[^']*'\)/,
    'le `select` doit demander `errors`, sinon le point de reprise n est jamais relu')
  assert.ok(src.includes("motif: 'etat_illisible'"), 'et il conduit a une abstention nommee')
})
