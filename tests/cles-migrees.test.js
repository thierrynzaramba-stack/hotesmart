// tests/cles-migrees.test.js
// LE DEFAUT : le cron rapatriait les donnees d'un bien migre, et lui envoyait
// des messages.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const lire = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

const { clesMigrees, estCleMigree, noterCleMigree, _vider } = require('../lib/cles-migrees')

// Faux client qui FILTRE REELLEMENT.
// ⚠ MA PREMIERE VERSION RENDAIT LE MEME `data` QUELS QUE SOIENT LES FILTRES.
// Le test nomme « cloisonne par compte » n'attestait donc que de la PRESENCE de
// deux `.eq` : il passait tel quel si `user_id` etait filtre sur une autre
// valeur, si la requete etait awaitee avant les filtres, ou si la table
// interrogee etait la mauvaise. Releve en review le 10 septembre 2026.
// Ici les lignes portent `user_id`/`provider` et le faux client les applique :
// une garde qui oublie un filtre rend alors les lignes d'un autre compte, et le
// test rougit.
function faux ({ lignes = [], error = null, erreurUpsert = null } = {}) {
  const journal = { table: null, filtres: [], upserts: [], lectures: 0 }

  const requete = () => {
    const appliquer = () => {
      let l = lignes
      for (const [c, v] of journal.filtres) l = l.filter(x => String(x[c]) === String(v))
      return { data: error ? null : l, error }
    }
    const p = Promise.resolve().then(appliquer)
    p.select = () => { journal.lectures++; return requete() }
    p.eq = (c, v) => { journal.filtres.push([c, v]); return requete() }
    p.upsert = (row, opts) => { journal.upserts.push({ row, opts }); return Promise.resolve({ error: erreurUpsert }) }
    return p
  }
  return { from (t) { journal.table = t; journal.filtres = []; return requete() }, journal }
}

test('LE TEST QUI COMPTE : le filtre est CLOISONNE PAR COMPTE, et le faux client peut le prouver', async () => {
  // ⚠ `provider_property_id` N'A AUCUNE UNICITE GLOBALE. Deux hotes d'un meme
  // property manager Beds24 partagent l'espace de numerotation. Filtrer sur la
  // seule cle aurait coupe la synchro du bien `209413` d'un AUTRE hote le jour
  // ou celui-ci migre le sien. C'est la raison d'etre de la table.
  _vider()
  const lignes = [
    { user_id: 'hote-A', provider: 'beds24', provider_property_id: '209413' },
    { user_id: 'hote-B', provider: 'beds24', provider_property_id: '169567' },
    { user_id: 'hote-A', provider: 'channex', provider_property_id: 'uuid-x' }
  ]
  const sb = faux({ lignes })

  assert.equal(await estCleMigree(sb, 'hote-A', '209413', 'beds24'), true)
  assert.equal(sb.journal.table, 'provider_keys_migrated', 'la bonne table est interrogee')

  // LE CAS QUI COMPTE : la cle de l'hote B ne doit PAS etre vue par l'hote A.
  _vider()
  assert.equal(await estCleMigree(faux({ lignes }), 'hote-A', '169567', 'beds24'), false,
    'la cle migree d un AUTRE hote ne coupe pas la synchro de celui-ci')

  // Et l'inverse : B voit la sienne.
  _vider()
  assert.equal(await estCleMigree(faux({ lignes }), 'hote-B', '169567', 'beds24'), true)

  // Le provider cloisonne aussi : une cle Channex migree n'est pas une cle Beds24.
  _vider()
  assert.equal(await estCleMigree(faux({ lignes }), 'hote-A', 'uuid-x', 'beds24'), false)
  _vider()
  assert.equal(await estCleMigree(faux({ lignes }), 'hote-A', 'uuid-x', 'channex'), true)
})

test('LE TEST QUI COMPTE : un echec de lecture retombe OUVERT, pas ferme', async () => {
  // ⚠ FERMER SUR UN ECHEC ARRETERAIT LA SYNCHRO DE TOUS LES BIENS DE TOUS LES
  // HOTES des que cette table devient illisible — une panne locale devenue
  // panne generale, pour une table vide chez 99 % des comptes.
  _vider()
  const sb = faux({ lignes: [], error: { message: 'table absente' } })
  assert.equal(await estCleMigree(sb, 'hote-A', '209413', 'beds24'), false,
    'sur echec, la cle n est PAS consideree migree : le cron continue')

  // ⚠ ET LE REPLI N'EST PAS DEFINITIF. L'echec est cache 5 s seulement (teste
  // a part) ; des que la table redevient lisible, la garde reprend. On le
  // verifie en vidant le cache, ce que fait aussi le TTL.
  _vider()
  const sb2 = faux({ lignes: [{ user_id: 'hote-A', provider: 'beds24', provider_property_id: '209413' }] })
  assert.equal(await estCleMigree(sb2, 'hote-A', '209413', 'beds24'), true,
    'la garde reprend des que la lecture repasse')
})

test('clesMigrees : sans supabase ou sans compte, ensemble vide et aucune lecture', async () => {
  _vider()
  assert.equal((await clesMigrees(null, 'hote-A')).size, 0)
  const sb = faux({ lignes: [{ user_id: 'hote-A', provider: 'beds24', provider_property_id: 'x' }] })
  assert.equal((await clesMigrees(sb, null)).size, 0)
  assert.equal(sb.journal.lectures, 0, 'aucun aller-retour inutile')
})

test('noterCleMigree : upsert idempotent sur la cle composite, et vide le cache', async () => {
  _vider()
  const sb = faux({ lignes: [] })
  // Avant : pas migree (et donc mise en cache).
  assert.equal(await estCleMigree(sb, 'hote-A', '209413'), false)
  await noterCleMigree(sb, { userId: 'hote-A', provider: 'beds24', propId: 209413, cibleFiche: 'uuid-cible' })
  const u = sb.journal.upserts[0]
  assert.equal(u.opts.onConflict, 'user_id,provider,provider_property_id')
  assert.equal(u.row.provider_property_id, '209413', 'la cle est ecrite en TEXTE')
  assert.equal(u.row.target_property_id, 'uuid-cible')

  // ⚠ LE CACHE DOIT ETRE VIDE PAR L'ECRITURE. Sinon la cle fraichement
  // enregistree resterait « non migree » pendant 60 s — soit un cycle de cron
  // entier a rapatrier les donnees qu'on vient de deplacer. C'est exactement
  // la fenetre qui a produit le defaut.
  const sb2 = faux({ lignes: [{ user_id: 'hote-A', provider: 'beds24', provider_property_id: '209413' }] })
  assert.equal(await estCleMigree(sb2, 'hote-A', '209413'), true)
})

test('noterCleMigree : refuse un appel incomplet plutot que d ecrire un demi-enregistrement', async () => {
  const sb = faux({})
  for (const args of [
    { provider: 'beds24', propId: '1' },
    { userId: 'a', propId: '1' },
    { userId: 'a', provider: 'beds24' }
  ]) {
    await assert.rejects(() => noterCleMigree(sb, args), /userId, provider et propId requis/)
  }
  assert.equal(sb.journal.upserts.length, 0)
})

test('LE TEST QUI COMPTE : TOUTE fonction de la boucle par bien est gardee — liste DERIVEE, pas ecrite', () => {
  // ⚠ MON PREMIER TEST ENUMERAIT TROIS PORTES EN DUR, COMME SI C'ETAIT
  // EXHAUSTIF. C'est lui qui m'a donne la fausse assurance : la review a
  // trouve DEUX portes de plus, dont `processArrivalCodes`, qui cree un code
  // REEL sur la serrure physique et envoie le PIN au voyageur. Un test qui
  // recopie la liste qu'il devrait verifier ne verifie rien.
  //
  // Ici la liste est EXTRAITE de `api/cron.js` : toute fonction ajoutee demain
  // a la boucle par bien fera rougir ce test jusqu'a ce qu'elle soit gardee, ou
  // exemptee ICI avec sa raison.
  const cron = lire('api/cron.js')

  // La boucle lit Beds24, PAS `properties` : supprimer la fiche ne protege rien.
  assert.ok(/fetchProperties\(beds24Key\)/.test(cron),
    'la liste des biens vient de Beds24, donc la garde ne peut pas etre dans properties')

  const debut = cron.indexOf('for (const property of properties) {')
  assert.ok(debut > 0, 'la boucle par bien est reperable')
  const corps = cron.slice(debut, cron.indexOf('\nasync function', debut) > 0
    ? cron.indexOf('\nasync function', debut) : cron.length)

  // Tout appel qui recoit le `property` de la boucle.
  const appels = new Set()
  for (const m of corps.matchAll(/\b([a-zA-Z][\w]*)\s*\(\s*userId\s*,[^)]*\bproperty\b/g)) {
    appels.add(m[1])
  }
  assert.ok(appels.size >= 4, `au moins 4 appels attendus, trouve ${[...appels].join(', ')}`)

  // Ou est definie chaque fonction, et porte-t-elle la garde ?
  const fs2 = require('fs'); const path2 = require('path')
  const dossier = path2.join(__dirname, '..', 'lib')
  const fichiers = fs2.readdirSync(dossier).filter(f => f.endsWith('.js'))

  // ⚠ EXEMPTIONS : vides aujourd'hui, et c'est voulu. Toute fonction de cette
  // boucle ecrit ou envoie quelque chose pour un bien — il n'y a pas de
  // « lecture seule » ici. Une exemption future doit porter sa raison.
  const EXEMPTES = {}

  const nonGardees = []
  for (const nom of appels) {
    if (EXEMPTES[nom]) continue
    const dans = fichiers.find(f =>
      fs2.readFileSync(path2.join(dossier, f), 'utf8').includes(`async function ${nom}(`))
    if (!dans) { nonGardees.push(`${nom} (definition introuvable)`); continue }
    const src = fs2.readFileSync(path2.join(dossier, dans), 'utf8')
    const i = src.indexOf(`async function ${nom}(`)
    // La garde doit etre dans les premieres lignes du corps : posee apres un
    // fetch ou une ecriture, elle ne protege plus rien.
    const tete = src.slice(i, i + 2600)
    if (!tete.includes('estCleMigree')) nonGardees.push(`${nom} (dans ${dans})`)
  }
  assert.deepEqual(nonGardees, [],
    'ces fonctions de la boucle par bien ne verifient pas la cle migree')
})

test('LE TEST QUI COMPTE : la garde des messages precede le kill switch, donc rien ne peut la contourner', () => {
  // Si elle venait apres, un bien migre mais NON en pause enverrait quand meme.
  const src = lire('lib/cron-messages.js')
  const i = src.indexOf('async function processMessageTemplates')
  const bloc = src.slice(i, i + 2200)
  assert.ok(bloc.indexOf('estCleMigree') < bloc.indexOf('isAutomationPaused'),
    'la garde de cle migree est la premiere sortie de la fonction')
})

test('LE TEST QUI COMPTE : la materialisation distingue « rien de migre » de « garde aveugle »', () => {
  // ⚠ MON TEST VALIDAIT UNE AFFIRMATION FAUSSE, releve en review.
  // Le commentaire annoncait qu'on distinguait « aucun bien migre » de « la
  // lecture a echoue », mais mon `if (ignorees > 0)` ne se declenchait dans
  // AUCUN des deux cas : les deux donnent 0. Or `clesMigrees` retombe
  // volontairement OUVERT sur un echec — « 0 ignore » peut donc vouloir dire
  // « la garde est aveugle ».
  const src = lire('lib/cron-beds24-props.js')
  assert.ok(src.includes('if (!migrees.size)'),
    'l ensemble vide est traite explicitement, pas confondu avec « rien a filtrer »')
  assert.ok(/aucune cle migree connue pour le compte/.test(src),
    'et le message renvoie vers [cles-migrees] pour trancher les deux causes')
  assert.ok(src.includes('bien(s) migre(s) ignore(s)'), 'le compte des ignores est journalise')
  assert.ok(src.includes('results.beds24MigratedSkipped'), 'et rendu dans le bilan du cron')
})

test('LE TEST QUI COMPTE : un echec de lecture est mis en cache BRIEVEMENT', async () => {
  // ⚠ NE RIEN CACHER SUR L'ECHEC reintroduisait la charge que le cache existe
  // pour eviter : table illisible = quatre lectures par bien et par cycle,
  // toutes en echec, dans une fonction plafonnee a 60 s — et une table
  // illisible arrive quand la base est deja sous tension. Le cycle pouvait
  // etre tue AVANT les codes d'arrivee et les messages. Releve en review.
  _vider()
  const sb = faux({ lignes: [], error: { message: 'table absente' } })
  await estCleMigree(sb, 'hote-A', '209413')
  const apres1 = sb.journal.lectures
  await estCleMigree(sb, 'hote-A', '209413')
  assert.equal(sb.journal.lectures, apres1, 'la seconde question ne relit pas la table')

  const src = lire('lib/cles-migrees.js')
  assert.ok(/CACHE_ECHEC_MS = 5 \* 1000/.test(src), 'et le cache d echec est COURT (5 s)')
  assert.ok(src.includes('echec: true'), 'l entree est marquee, pour ne pas durer 60 s')
})

test('LE TEST QUI COMPTE : les portes de LECTURE sont gardees aussi, pas seulement les ecritures', () => {
  // ⚠ CINQUIEME ET SIXIEME PORTES, ET LES PREMIERES EN LECTURE.
  // Le bien migre RESTE dans le compte Beds24 (filet de rollback, regle N2) :
  // l'API du provider le rend donc toujours. Les deux endpoints qui listent les
  // biens depuis ce fetch live les servaient aux ecrans.
  //
  // MESURE DU 11 SEPTEMBRE 2026 : Thierry voyait QUATRE biens au lieu de deux —
  // « Cœur de vie « La bulle » » et « coeur de vie 23 » (les fantomes Beds24,
  // qui portent les noms d'origine) a cote de « La bulle » et
  // « Cœur de vie l 23 ». Le meme piege d'homonymie qui lui avait coute une
  // frayeur a minuit cote Channex, cette fois dans son propre tableau de bord.
  //
  // Les quatre premieres portes sont cote ECRITURE (materialisation, snapshots,
  // messages, codes d'acces) : c'est pourquoi celles-ci avaient echappe a
  // l'inventaire. Un bien migre ne doit ni etre ecrit, ni etre MONTRE.
  const listeBiens = lire('api/channel-property.js')
  assert.ok(listeBiens.includes("require('../lib/cles-migrees')"), 'la liste importe la garde')
  assert.ok(/clesMigrees\(supabase, compteLecture, 'beds24'\)/.test(listeBiens),
    'et la lit pour le compte CONSULTE, pas pour l appelant')
  assert.ok(/\.filter\(b => !migrees\.has\(String\(b\.id\)\)\)/.test(listeBiens),
    'le fetch live ecarte les cles migrees')

  const beds24 = lire('api/beds24.js')
  assert.ok(beds24.includes("require('../lib/cles-migrees')"), 'getProperties importe la garde')
  assert.ok(/clesMigrees\(supabase, garde\.accountUserId, 'beds24'\)/.test(beds24),
    'et la lit pour le compte PROPRIETAIRE du bien — celui dont la cle Beds24 sert')
  assert.ok(/gardees = \(d\.data \|\| \[\]\)\.filter\(b => !migrees\.has/.test(beds24),
    'les biens migres sont ecartes de la reponse')
  // ⚠ ET L'ECART EST DIT. Un filtre muet sur une liste rendait indiscernable
  // « aucun bien migre » de « la garde est aveugle » — `clesMigrees` retombe
  // volontairement ouvert sur un echec de lecture.
  assert.ok(/bien\(s\) migre\(s\) ecarte\(s\)/.test(beds24), 'et journalise ce qu il ecarte')
})
