// tests/cles-migrees-portee.test.js
// LE DEFAUT : une garde aveugle suspendait des biens qu'elle ne concerne pas.
//
// Mesure du 14 septembre 2026, premier « Gateway Timeout » reel sur la lecture
// de `provider_keys_migrated` — cinq incidents entre 09:30 et 12:00 UTC.
// La boucle Beds24 ne contient que deux biens, tous deux migres : les suspendre
// ne coute rien. Mais `processMessageTemplates` et `processArrivalCodes` sont
// PARTAGES avec la boucle Channex et portaient la meme garde. Aveugle, elle
// repondait « oui » pour La bulle, le 23, Colomiers et Ofuro : messages et
// codes d'acces suspendus sur des biens qui n'ont jamais eu de cle Beds24.
//
// Thierry : « une garde qui suspend mes biens sains parce qu'elle n'arrive pas a
// repondre a une question qui ne les concerne pas, c'est un defaut de
// conception, pas un probleme de robustesse ».
//
// ⚠ CES TESTS APPELLENT LE CODE. La review du meme jour a montre, sur trois
// mutations, qu'une suite de `readFileSync` + `includes` reste verte quand on
// reintroduit le defaut. La decision est donc une FONCTION, et on l'exerce.

process.env.TZ = 'Europe/Paris'
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321'
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key'

const test = require('node:test')
const assert = require('node:assert')
// ⚠ LE FAUX `founder-notify` AVANT TOUT REQUIRE DE LA GARDE.
// La branche d'echec de `clesMigrees` leve un incident, et il est ATTENDU
// (`await`) depuis le correctif de review — une promesse flottante est perdue
// quand Vercel gele l'instance. Sans ce leurre, chaque test qui fait echouer la
// lecture tente un vrai INSERT vers une base inexistante : ce fichier mettait
// 28 secondes pour 0,3 s de calcul. Un test qui attend le reseau est un test
// qu'on finit par ne plus lancer.
const cheminNotify = require.resolve('../lib/founder-notify')
const incidents = []
require.cache[cheminNotify] = {
  id: cheminNotify, filename: cheminNotify, loaded: true, exports: {
    reportIncident: async (type, opts) => { incidents.push({ type, ...opts }); return true }
  }
}

const { motifNonSyncPourBien, concerneLeProvider, statistiques, _vider, _viderCompteurs } =
  require('../lib/cles-migrees')

// Faux client qui APPLIQUE les filtres, et qui peut tomber en panne a la demande.
function faux ({ lignes = [], error = null } = {}) {
  const journal = { lectures: 0 }
  const req = (filtres = []) => {
    const p = Promise.resolve().then(() => {
      if (error) return { data: null, error }
      let l = lignes
      for (const [c, v] of filtres) l = l.filter(x => String(x[c]) === String(v))
      return { data: l, error: null }
    })
    p.select = () => { journal.lectures++; return req(filtres) }
    p.eq = (c, v) => req([...filtres, [c, v]])
    return p
  }
  return { from () { return req() }, journal }
}

const MIGREE = { user_id: 'hote-A', provider: 'beds24', provider_property_id: '169567' }
const BIEN_CHANNEX = { id: '1655ab32-uuid-channex', provider: 'channex' }
const BIEN_BEDS24_LIVE = { id: '169567' }          // liste live du provider : aucun champ `provider`
const BIEN_BEDS24_SAIN = { id: '999999' }

test('LE TEST QUI COMPTE : garde AVEUGLE + bien Channex = on TRAITE quand meme', async () => {
  // C'est tout l'objet du correctif. Avant lui, la reponse etait « suspendu »,
  // et les messages comme les codes d'acces s'arretaient sur des biens sains.
  _vider()
  const sb = faux({ error: { message: 'Gateway Timeout' } })
  const motif = await motifNonSyncPourBien(sb, 'hote-A', BIEN_CHANNEX, 'beds24')
  assert.equal(motif, null, 'un bien Channex n a jamais eu de cle Beds24 : rien a suspendre')
  assert.equal(sb.journal.lectures, 0,
    'et on ne lit meme PAS la table : la question ne se pose pas, donc elle ne coute rien')
})

test('LE TEST QUI COMPTE : garde AVEUGLE + bien Beds24 = on s abstient TOUJOURS', async () => {
  // Le repli ferme reste entier la ou il a un sens. Reduire la portee ne doit
  // pas rouvrir la porte du 14 septembre (82 sejours arraches a la fiche
  // Channex, 16 menages annules cinq minutes plus tard).
  _vider()
  const sb = faux({ error: { message: 'Gateway Timeout' } })
  assert.equal(await motifNonSyncPourBien(sb, 'hote-A', BIEN_BEDS24_LIVE, 'beds24'), 'illisible')
  _vider()
  const sb2 = faux({ error: { message: 'Gateway Timeout' } })
  assert.equal(await motifNonSyncPourBien(sb2, 'hote-A', BIEN_BEDS24_SAIN, 'beds24'), 'illisible',
    'meme un bien Beds24 jamais migre : aveugle, on ne sait rien de personne')
})

test('LE TEST QUI COMPTE : lecture saine, la garde fait toujours son vrai travail', async () => {
  _vider()
  assert.equal(await motifNonSyncPourBien(faux({ lignes: [MIGREE] }), 'hote-A', BIEN_BEDS24_LIVE, 'beds24'),
    'migree', 'une cle migree reste ecartee')
  _vider()
  assert.equal(await motifNonSyncPourBien(faux({ lignes: [MIGREE] }), 'hote-A', BIEN_BEDS24_SAIN, 'beds24'),
    null, 'un bien Beds24 sain est traite')
  _vider()
  assert.equal(await motifNonSyncPourBien(faux({ lignes: [MIGREE] }), 'hote-A', BIEN_CHANNEX, 'beds24'),
    null, 'et un bien Channex aussi')
})

test('LE TEST QUI COMPTE : sans champ `provider`, le doute va vers la PRUDENCE', () => {
  // La liste live du provider ne porte pas ce champ. Le defaut doit donc etre
  // « c est bien lui », sinon reduire la portee rouvrirait la porte.
  assert.equal(concerneLeProvider({ id: '169567' }, 'beds24'), true)
  assert.equal(concerneLeProvider(null, 'beds24'), true, 'meme sans bien du tout')
  assert.equal(concerneLeProvider({ provider: 'channex' }, 'beds24'), false)
  assert.equal(concerneLeProvider({ provider: 'beds24' }, 'beds24'), true)
})

test('LE TEST QUI COMPTE : les echecs sont COMPTES, et le compte repart au succes', async () => {
  // ⚠ L'incident est borne a un toutes les dix minutes : il dit « ca s est
  // produit dans ce creneau », jamais « combien de fois ». Au premier incident
  // reel, c est exactement ce qu on n a pas pu etablir — et sans ce compte, on
  // ne saura pas si la portee reduite et le cache long ont regle le probleme.
  // ⚠ MA PREMIERE VERSION GRAVAIT LE DEFAUT COMME LA SPECIFICATION : trois
  // echecs sur hote-1/2/3, un succes sur hote-4, et j'exigeais que le compteur
  // reparte a zero. Autrement dit j'affirmais que le succes d'un hote efface les
  // echecs d'un autre — ce que la review a releve comme un vrai defaut. Le
  // compteur est desormais PAR COMPTE, comme l'incident qu'il alimente.
  _vider(); _viderCompteurs()
  const CLE = 'hote-1|beds24'
  const avant = statistiques().echecs
  for (let i = 0; i < 3; i++) {
    await motifNonSyncPourBien(faux({ error: { message: 'Gateway Timeout' } }), 'hote-1', BIEN_BEDS24_LIVE, 'beds24')
    _vider()   // le cache d'echec masquerait les lectures suivantes
  }
  const apres = statistiques(CLE)
  assert.equal(apres.echecs - avant, 3, 'trois echecs comptes')
  assert.equal(apres.echecsDepuisSucces, 3, 'et trois pour CE compte')

  // Le succes d'un AUTRE compte ne doit RIEN effacer chez celui qui est en panne.
  await motifNonSyncPourBien(faux({ lignes: [] }), 'hote-2', BIEN_BEDS24_LIVE, 'beds24')
  assert.equal(statistiques(CLE).echecsDepuisSucces, 3,
    'le succes de hote-2 n efface pas les echecs de hote-1 — sinon l incident rapporterait « 1 » indefiniment')
  assert.ok(statistiques('hote-2|beds24').dernierSucces, 'et hote-2 a bien son propre dernier succes')

  // Son propre succes, lui, remet son compteur a zero.
  _vider()
  await motifNonSyncPourBien(faux({ lignes: [] }), 'hote-1', BIEN_BEDS24_LIVE, 'beds24')
  assert.equal(statistiques(CLE).echecsDepuisSucces, 0, 'son propre succes remet SON compteur a zero')
  assert.ok(statistiques(CLE).dernierSucces, 'et date SON dernier succes')
  assert.equal(statistiques().echecs, apres.echecs, 'le cumul d instance, lui, ne recule pas')
})

test('LE TEST QUI COMPTE : l incident PORTE le compte — c est toute sa raison d etre', async () => {
  // ⚠ L'incident est borne a un toutes les dix minutes, et le compteur ne vit
  // que dans l'instance — or une instance Vercel est recyclee. Si le nombre ne
  // voyage pas DANS l'incident, il est perdu, et on ne saura pas davantage
  // qu'au 14 septembre combien de fois la lecture a echoue.
  _vider()
  incidents.length = 0
  const sb = faux({ error: { message: 'Gateway Timeout', code: null } })
  await motifNonSyncPourBien(sb, 'hote-compte', BIEN_BEDS24_LIVE, 'beds24')
  await new Promise(r => setImmediate(r))

  assert.equal(incidents.length, 1, 'un incident est leve')
  const d = incidents[0].detail
  assert.equal(d.message, 'Gateway Timeout', 'le message de la base, qui nomme la cause')
  assert.ok(Number.isInteger(d.echecs_depuis_dernier_succes), 'les echecs depuis le dernier succes')
  assert.ok(Number.isInteger(d.echecs_cumules_instance), 'le cumul de l instance')
  assert.ok(Number.isInteger(d.lectures_cumulees_instance),
    'et le total des lectures : sans lui, « 3 echecs » ne dit pas si c est 3 sur 4 ou 3 sur 300')
})

test('LE TEST QUI COMPTE : le cache long et l ordre du transfert sont UN SEUL geste', () => {
  // ⚠ `noterCleMigree` vide le cache du processus COURANT. Il n est appele que
  // depuis le script de transfert — un processus LOCAL. Le cron tourne ailleurs :
  // son cache n expire que par TTL. Passer ce TTL a 15 minutes sans toucher au
  // script rejouerait le 10 septembre en quinze fois plus long : 106 sejours
  // etaient repartis sous l ancienne cle « dans les minutes suivant un transfert
  // pourtant verifie a 0 ligne restante ».
  // ⚠ ON N'ASSERTE PAS LA VALEUR, MAIS L'INVARIANT — releve en review.
  // Le code et le KB autorisent explicitement de BAISSER `CACHE_MS` sous la
  // duree d'un cycle si l'on retire l'attente. Verrouiller « 15 minutes »
  // interdisait la sortie documentee. Ce qui doit tenir, c'est que le cache soit
  // plus long qu'un cycle de cron — donc qu'il EXIGE l'attente.
  const { CACHE_MS } = require('../lib/cles-migrees')
  assert.ok(CACHE_MS > 5 * 60 * 1000,
    'le cache depasse un cycle de cron : c est ce qui rend l attente necessaire')

  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'scripts/transferer-bien-vers-fiche-neuve.js'), 'utf8')
  const posNote = src.indexOf('await noterCleMigree(')
  const posAttente = src.indexOf('await attendreFenetreDeCache(')
  const posTransfert = src.indexOf('// 2) Le transfert, en une transaction.')
  assert.ok(posNote > 0 && posTransfert > 0, 'les deux etapes sont reperables')
  assert.ok(posNote < posTransfert,
    'la cle est enregistree AVANT que la moindre ligne ne bouge')
  assert.ok(posAttente > posNote && posAttente < posTransfert,
    'et le script ATTEND la fenetre de cache entre les deux')
  // ⚠ AUCUNE CONDITION AUTOUR DE L APPEL. Ma premiere version gardait
  // l attente derriere un `if (!SANS_ATTENTE)` dans le script, et le test
  // cherchait le TEXTE du message : remplacer la condition par `if (false)`
  // le laissait VERT. La contre-epreuve l a montre. La decision de sauter vit
  // maintenant DANS la fonction, ou un test peut l exercer.
  assert.ok(!src.includes('if (!SANS_ATTENTE)'),
    'plus de condition dans le script : ce qui se decide doit pouvoir s eprouver')
})

test('LE TEST QUI COMPTE : l attente dure REELLEMENT la fenetre de cache', async () => {
  const { attendreFenetreDeCache, CACHE_MS } = require('../lib/cles-migrees')
  let cumul = 0
  const dormir = async (ms) => { cumul += ms }   // horloge injectee : instantane
  const attendu = await attendreFenetreDeCache({ dormir, dire: () => {} })
  assert.equal(cumul, attendu, 'la fonction rend exactement ce qu elle a fait dormir')
  // ⚠ L'INVARIANT, PAS LA VALEUR : l'attente doit couvrir l'expiration du cache
  // ET le cycle deja EN VOL. Une instance peut avoir lu le cache a la derniere
  // milliseconde de la fenetre, puis passer 40 a 56 s a ecrire — pendant que le
  // script deplace les lignes. Et sur ce chemin `detectBookingChanges` ne
  // consulte pas `automation_paused` : la pause du script ne le couvre pas.
  assert.ok(attendu >= CACHE_MS, 'elle couvre au moins l expiration du cache')
  assert.ok(attendu >= CACHE_MS + 60 * 1000, 'et un cycle de cron par-dessus')
})

test('LE TEST QUI COMPTE : --sans-attente NU est REFUSE', async () => {
  // ⚠ Exigence de Thierry, 14 septembre 2026 : « un drapeau qui existe pour un
  // cas precis finit toujours par etre utilise par reflexe ». On ne contourne
  // pas une garde d'un caractere : il faut ECRIRE pourquoi.
  const { attendreFenetreDeCache } = require('../lib/cles-migrees')
  await assert.rejects(
    () => attendreFenetreDeCache({ sauter: true, dormir: async () => {}, dire: () => {} }),
    /REFUS : --sans-attente exige une raison/)
})

test('LE TEST QUI COMPTE : avec une raison, il n attend rien mais DIT la consequence', async () => {
  // L echappement vaut pour le redeploiement (demarrage a froid = cache vide).
  // Il doit dire ce qu'il coute si la premisse est fausse.
  const { attendreFenetreDeCache } = require('../lib/cles-migrees')
  let cumul = 0
  const dits = []
  const attendu = await attendreFenetreDeCache({
    sauter: 'cron redeploye a 14h02', dormir: async (ms) => { cumul += ms }, dire: (m) => dits.push(m)
  })
  assert.equal(cumul, 0, 'aucune pause')
  assert.equal(attendu, 0)
  const tout = dits.join(' ')
  assert.ok(tout.includes('cron redeploye a 14h02'), 'la raison invoquee est tracee')
  assert.ok(tout.includes('ANCIENNE cle'),
    'et la consequence est dite en clair : les ecritures d une instance chaude repartiront sous l ancienne cle')
  assert.ok(tout.includes('10 septembre'), 'avec le precedent qui la rend concrete')
})
