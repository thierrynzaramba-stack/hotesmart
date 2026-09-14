// tests/cles-migrees.test.js
// LE DEFAUT : le cron rapatriait les donnees d'un bien migre, et lui envoyait
// des messages.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const lire = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

// ⚠ LE FAUX `founder-notify` DOIT ETRE POSE AVANT LE REQUIRE DE LA GARDE.
// `cles-migrees` le charge PARESSEUSEMENT (dans la branche d'echec seulement),
// mais le vrai module construit un client Supabase au chargement : sans ce
// leurre, le test dependrait des variables d'environnement.
const cheminNotify = require.resolve('../lib/founder-notify')
const incidents = []
require.cache[cheminNotify] = {
  id: cheminNotify, filename: cheminNotify, loaded: true, exports: {
    reportIncident: async (type, opts) => { incidents.push({ type, ...opts }); return true }
  }
}

const { clesMigrees, motifNonSync, estCleMigree, noterCleMigree, _vider } = require('../lib/cles-migrees')

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

test('LE TEST QUI COMPTE : un echec de lecture retombe FERME — decision du 14 septembre 2026', async () => {
  // ⚠ CE TEST AFFIRMAIT L'INVERSE, ET IL AVAIT TORT. Il gravait le repli OUVERT
  // avec pour raison qu'une table illisible ne devait pas arreter la synchro de
  // tous les hotes. L'argument reste vrai, mais le prix mesure du repli ouvert
  // l'a emporte : lors de trois cycles isoles (12/09 14:15, 13/09 16:01,
  // 14/09 05:00), la garde est passee aveugle, l'ancienne cle Beds24 du 23 s'est
  // rouverte, 82 sejours ont quitte la fiche Channex — et cinq minutes plus tard
  // le writer des menages en a ANNULE SEIZE, ne les voyant plus vivants.
  //
  // Une synchro en pause se rattrape au cycle suivant. Un menage annule la
  // veille du depart, non.
  _vider()
  const sb = faux({ lignes: [], error: { message: 'table absente' } })
  assert.equal(await estCleMigree(sb, 'hote-A', '209413', 'beds24'), true,
    'garde aveugle = on ne traite pas le bien')

  // ⚠ ET C'EST VRAI DE N'IMPORTE QUELLE CLE, pas seulement d'une cle migree :
  // aveugle, on ne sait rien de personne.
  _vider()
  assert.equal(await estCleMigree(faux({ lignes: [], error: { message: 'x' } }), 'hote-A', '999999', 'beds24'), true,
    'aveugle, meme un bien jamais migre est laisse tranquille')

  // ⚠ ET LE REPLI N'EST PAS DEFINITIF. L'echec est cache 5 s seulement (teste
  // a part) ; des que la table redevient lisible, la garde reprend son vrai
  // travail — elle ne reste pas bloquee sur « tout est migre ».
  _vider()
  const sb2 = faux({ lignes: [{ user_id: 'hote-A', provider: 'beds24', provider_property_id: '209413' }] })
  assert.equal(await estCleMigree(sb2, 'hote-A', '209413', 'beds24'), true)
  _vider()
  assert.equal(await estCleMigree(faux({ lignes: [] }), 'hote-A', '209413', 'beds24'), false,
    'lecture rendue : un bien non migre redevient synchronisable')
})

test('LE TEST QUI COMPTE : « migre » et « aveugle » sont deux faits distincts', async () => {
  // Les deux arretent le traitement, mais les confondre ecrit un message faux
  // dans le journal — « cle migree » pour une panne passagere envoie le
  // diagnostic dans la mauvaise direction. C'est la lecon de cron-beds24-props.
  _vider()
  const migre = faux({ lignes: [{ user_id: 'hote-A', provider: 'beds24', provider_property_id: '209413' }] })
  assert.equal(await motifNonSync(migre, 'hote-A', '209413', 'beds24'), 'migree')
  _vider()
  assert.equal(await motifNonSync(faux({ lignes: [] }), 'hote-A', '209413', 'beds24'), null,
    'un bien vivant n a AUCUN motif de ne pas etre traite')
  _vider()
  const aveugle = faux({ lignes: [], error: { message: 'timeout' } })
  assert.equal(await motifNonSync(aveugle, 'hote-A', '209413', 'beds24'), 'illisible')
})

test('LE TEST QUI COMPTE : un echec de lecture laisse une trace DURABLE, pas un log', async () => {
  // ⚠ PENDANT QUATRE JOURS L'ECHEC N'A EXISTE QUE DANS UN console.error.
  // Donc dans des logs Vercel ephemeres, donc nulle part : impossible de dire
  // si c'etait un timeout, le pooler ou le cache de schema. Un incident survit
  // au cycle et se relit. C'est la lecon deja payee (« erreur avalee, cron a
  // 200 ») : on ne diagnostique pas ce qui n'a pas ete ecrit.
  incidents.length = 0
  _vider()
  await estCleMigree(faux({ lignes: [], error: { message: 'statement timeout', code: '57014' } }), 'hote-Z', '1', 'beds24')
  await new Promise(r => setImmediate(r))
  assert.equal(incidents.length, 1, 'un incident est leve')
  assert.equal(incidents[0].type, 'cles_migrees_illisible')
  assert.equal(incidents[0].userId, 'hote-Z', 'et il nomme le compte concerne')
  assert.equal(incidents[0].detail.message, 'statement timeout',
    'et le MESSAGE de la base, qui est la seule chose qui dira la cause')
  assert.equal(incidents[0].detail.code, '57014', 'et son code')

  // ⚠ UNE LECTURE QUI REUSSIT NE LEVE RIEN. Sans quoi l'incident deviendrait du
  // bruit permanent, et un bruit permanent ne se lit plus.
  incidents.length = 0
  _vider()
  await estCleMigree(faux({ lignes: [] }), 'hote-Z', '1', 'beds24')
  await new Promise(r => setImmediate(r))
  assert.equal(incidents.length, 0)
})

test('LE TEST QUI COMPTE : les deux portes de LECTURE refusent aussi quand la garde est aveugle', () => {
  // ⚠ NI FANTOMES, NI LISTE VIDE. Servir la liste non filtree ramene les biens
  // migres a l'ecran (mesure du 11 septembre : quatre biens au lieu de deux) ;
  // rendre une liste vide dirait « vous n'avez aucun bien ». Les deux mentent.
  const beds24 = lire('api/beds24.js')
  // ⚠ MA PREMIERE VERSION CHERCHAIT `res.status(503)` DANS TOUT LE FICHIER.
  // Il y en a un autre ailleurs : la contre-epreuve a remplace CELUI-CI par un
  // 200 et la suite est restee VERTE. Un test qui passe pour la mauvaise raison
  // ne protege rien. On lit donc le BLOC de la garde, pas le fichier.
  const iGarde = beds24.indexOf('if (migrees.lectureEnEchec) {')
  assert.ok(iGarde > 0, 'getProperties traite explicitement la garde aveugle')
  const blocGarde = beds24.slice(iGarde, iGarde + 500)
  assert.ok(blocGarde.includes('res.status(503)'), 'et REFUSE plutot que de repondre a moitie')
  assert.ok(blocGarde.includes('momentanément indisponible'),
    'avec une phrase en francais que l hote peut comprendre')
  const posGarde = beds24.indexOf('migrees.lectureEnEchec')
  const posFiltre = beds24.indexOf('const gardees = (d.data || [])')
  assert.ok(posGarde > 0 && posGarde < posFiltre, 'le refus precede le filtrage')

  // Ici la liste Beds24 n'est qu'un complement du coeur : on n'ajoute rien,
  // mais on le DIT — « je ne sais pas » n'est pas « non ».
  // ⚠ MON PREMIER TEST NE VERIFIAIT QUE DES `includes` SUR TOUT LE FICHIER.
  // La review a deplace le bloc de garde APRES le remplissage de `beds24Props`
  // — donc fantomes servis quand meme — et les trois assertions passaient.
  // Le meme faux vert que sur l'autre porte, laisse intact sur celle-ci.
  const cp = lire('api/channel-property.js')
  const iCp = cp.indexOf('if (migrees.lectureEnEchec) {')
  assert.ok(iCp > 0, 'le complement Beds24 est garde aussi')
  const blocCp = cp.slice(iCp, iCp + 500)
  assert.ok(blocCp.includes('res.status(503)'),
    'et REFUSE la requete : un 200 a liste vide ferait dire « aucun bien » a l ecran')
  assert.ok(blocCp.includes('momentanément indisponible'), 'avec une phrase en francais')
  const iRemplissage = cp.indexOf('beds24Props = (d.data || [])')
  assert.ok(iRemplissage > 0 && iCp < iRemplissage,
    'et le refus PRECEDE le remplissage, sinon les fantomes sont deja servis')

  // ⚠ ET LE DRAPEAU QUE PERSONNE NE LISAIT A DISPARU. `beds24_indisponible`
  // n'etait consomme par AUCUN front : la reponse restait un 200 a liste vide,
  // `shared/properties.js` rendait `allFailed: false`, et l onboarding
  // reconciliait contre une liste amputee — donc creait des biens en double.
  // Meme discipline qu au-dessus : on lit le CODE, pas les commentaires — le
  // paragraphe qui explique pourquoi ce drapeau a ete retire le nomme forcement.
  const cpCode = cp.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter(l => !l.trim().startsWith('//')).join('\n')
  assert.ok(!cpCode.includes('beds24_indisponible'),
    'aucun drapeau muet ne remplace un refus')
})

test('LE TEST QUI COMPTE : la ou « migre » AUTORISE une action, le booleen ne suffit pas', () => {
  // ⚠ LE DEFAUT QUE LE REPLI FERME A CREE, TROUVE EN REVIEW LE 14 SEPTEMBRE.
  // Partout ailleurs « migre » veut dire « abstiens-toi », et fermer la garde
  // protege. Dans `supprimer-residu-beds24.js`, « migre » veut dire
  // « tu peux SUPPRIMER la fiche » : la meme fermeture y devient une
  // AUTORISATION accordee sur une panne de lecture. Le script affichait alors
  // « Cle migree enregistree : OUI » — un mensonge a l'operateur — puis
  // DELETE FROM properties. Le cron recreait la fiche avec un `active_at`
  // neuf : le defaut de facturation du 10 septembre, rouvert par son correctif.
  const src = lire('scripts/supprimer-residu-beds24.js')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter(l => !l.trim().startsWith('//')).join('\n')

  assert.ok(!code.includes('estCleMigree('),
    'le booleen n est PAS utilise ici : il rend true sur une lecture en echec')
  assert.ok(code.includes('await motifNonSync('), 'le motif est demande explicitement')
  assert.ok(/motif !== 'migree'/.test(code) || /motif === 'migree'/.test(code),
    'et seul le FAIT « migree » autorise la suppression')
  assert.ok(/motif === 'illisible'/.test(code),
    'une garde aveugle a son propre refus, distinct de « pas migree »')

  // Les deux refus doivent PRECEDER la suppression, sinon ils arrivent trop tard.
  const posMotif = code.indexOf('await motifNonSync(')
  const posDelete = code.indexOf(".from('properties')\n    .delete()") >= 0
    ? code.indexOf(".from('properties')\n    .delete()")
    : code.indexOf('.delete()')
  assert.ok(posMotif > 0 && posDelete > 0 && posMotif < posDelete,
    'la garde precede le DELETE')
})

test('LE TEST QUI COMPTE : le poll des avis Beds24 est garde comme les autres portes', () => {
  // ⚠ SEPTIEME PORTE. Elle lit `properties` et non la liste live du provider,
  // donc elle etait « protegee » seulement parce qu'aucune fiche ne porte
  // `provider = 'beds24'` aujourd'hui. C'est la protection accidentelle que
  // `processArrivalCodes` avait deja payee le 10 septembre : le jour ou une
  // fiche migree se recree, ce poll ecrit des avis sous une cle abandonnee.
  const src = lire('lib/cron-beds24-reviews.js')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter(l => !l.trim().startsWith('//')).join('\n')
  assert.ok(code.includes('await motifNonSync('), 'le poll interroge la garde')
  const posGarde = code.indexOf('await motifNonSync(')
  const posAppel = code.indexOf('/channels/booking/reviews')
  assert.ok(posGarde > 0 && posAppel > 0 && posGarde < posAppel,
    'et AVANT d appeler le provider, sinon le credit est deja depense')
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
    // Deux formes valides : `estCleMigree` (booleen, ferme par defaut) ou
    // `motifNonSync` (qui distingue « migre » de « aveugle » pour le journal).
    //
    // ⚠ ON EXIGE L'APPEL `await`, PAS LE NOM. La contre-epreuve a desarme la
    // garde par `const motif = null // motifNonSync desarme` : le nom restait
    // dans le fichier, le test restait vert, et la garde ne s'executait plus.
    // Chercher un identifiant, c'est chercher une intention ; on cherche un acte.
    // ⚠ ET ON LIT DU CODE, PAS DES COMMENTAIRES — SECOND FAUX VERT DE LA REVIEW.
    // `// DESARMEE : if (await estCleMigree(...)) return` laissait l appel dans
    // le texte : le test restait vert, la garde ne s executait plus. On retire
    // donc les commentaires avant de chercher.
    const code = tete.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
      .filter(l => !l.trim().startsWith('//')).join('\n')
    // ⚠ TROIS FORMES VALIDES, ET CHACUNE PORTE SA RAISON :
    //   `estCleMigree`        — booleen, ferme par defaut ;
    //   `motifNonSync`        — distingue « migre » de « aveugle » pour le journal ;
    //   `motifNonSyncPourBien` — AJOUTE le 14 septembre : ne pose la question
    //     qu'aux biens du provider concerne. C'est la forme qu'il FAUT pour une
    //     fonction partagee entre la boucle Beds24 et la boucle Channex, sans
    //     quoi une garde aveugle suspend des biens qui n'ont jamais eu de cle
    //     Beds24 (messages et codes d'acces coupes sur des biens sains).
    const gardes = ['await estCleMigree(', 'await motifNonSync(', 'await motifNonSyncPourBien(']
    if (!gardes.some(g => code.includes(g))) {
      nonGardees.push(`${nom} (dans ${dans})`)
    }
  }
  assert.deepEqual(nonGardees, [],
    'ces fonctions de la boucle par bien ne verifient pas la cle migree')
})

test('LE TEST QUI COMPTE : la garde des messages precede le kill switch, donc rien ne peut la contourner', () => {
  // Si elle venait apres, un bien migre mais NON en pause enverrait quand meme.
  // ⚠ CETTE ASSERTION ETAIT DEVENUE TOUJOURS VRAIE, ET C'EST LE COMMIT DU
  // 14 SEPTEMBRE QUI L'A VIDEE. Elle comparait `indexOf('estCleMigree')` a
  // `indexOf('isAutomationPaused')` ; la fonction n'utilise plus `estCleMigree`
  // (elle appelle `motifNonSyncPourBien`), donc le premier valait -1 et
  // « -1 < 1393 » passait quoi qu'il arrive. Contre-epreuve de la review :
  // garde DEPLACEE apres le kill switch -> suite verte.
  // On cherche donc la forme REELLEMENT posee, et on exige que les DEUX
  // positions existent avant de les comparer.
  const src = lire('lib/cron-messages.js')
  const i = src.indexOf('async function processMessageTemplates')
  const bloc = src.slice(i, i + 2200)
  const posGarde = bloc.indexOf('await motifNonSyncPourBien(')
  const posPause = bloc.indexOf('isAutomationPaused')
  assert.ok(posGarde > 0, 'la garde est bien dans la fonction')
  assert.ok(posPause > 0, 'et le kill switch aussi — sinon la comparaison ne compare rien')
  assert.ok(posGarde < posPause,
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

test('LE TEST QUI COMPTE : une lecture en echec est MARQUEE, pas silencieuse', async () => {
  // ⚠ MESURE DU 12 SEPTEMBRE 2026 (le repli etait alors OUVERT ; il est FERME
  // depuis le 14 — mais le besoin de DISTINGUER les deux cas, lui, n a pas bouge).
  // Ce module retombait OUVERT quand la table est illisible, et
  // son en-tete affirmait que « le seul degat serait un message renvoye a un
  // voyageur ». C'etait faux : `materializeBeds24Properties` passait aussi et
  // RECREAIT les fiches migrees avec un `active_at` neuf. Deux fiches Beds24
  // sont revenues dans la nuit — a 03:00:58 et 06:00:39, deux cycles isoles
  // sur une centaine — et la facturation est passee de 2 a 4 biens.
  //
  // « Lecture en echec » et « aucune cle migree » donnaient tous deux un
  // ensemble vide : l'appelant ne pouvait pas les distinguer.
  _vider()
  const sb = faux({ lignes: [], error: { message: 'table illisible' } })
  const enEchec = await clesMigrees(sb, 'hote-A')
  assert.equal(enEchec.size, 0,
    'l ensemble rendu reste VIDE — on n invente pas des cles migrees ; c est le drapeau qui ferme')
  assert.equal(enEchec.lectureEnEchec, true, 'mais l echec est MARQUE')

  _vider()
  const vraimentVide = await clesMigrees(faux({ lignes: [] }), 'hote-B')
  assert.equal(vraimentVide.size, 0)
  assert.equal(vraimentVide.lectureEnEchec, undefined,
    '« aucune cle migree » ne porte PAS le drapeau : les deux cas sont distincts')

  // Le drapeau ne doit pas polluer une iteration ni une serialisation.
  _vider()
  const s2 = await clesMigrees(faux({ lignes: [], error: { message: 'x' } }), 'hote-C')
  assert.deepEqual([...s2], [], 'non enumerable : l ensemble reste un ensemble vide')
})

test('LE TEST QUI COMPTE : une garde aveugle NE materialise RIEN', () => {
  // Materialiser cree un bien FACTURE. Un bien non materialise pendant un
  // cycle ne coute rien — le suivant le rattrape. Un bien refacture, si.
  const src = lire('lib/cron-beds24-props.js')
  assert.ok(/if \(migrees\.lectureEnEchec\) \{/.test(src),
    'la materialisation refuse d agir quand la garde est aveugle')
  // Le refus doit intervenir AVANT la boucle d'insertion.
  const posGarde = src.indexOf('migrees.lectureEnEchec')
  const posInsert = src.indexOf(".from('properties').insert(")
  assert.ok(posGarde > 0 && posGarde < posInsert,
    'et AVANT tout insert, sinon la protection arrive trop tard')
  assert.ok(/return\s*$/m.test(src.slice(posGarde, posGarde + 600)),
    'il sort, il ne se contente pas de journaliser')
})
