// tests/pwa-prendre-menage.test.js
// Refonte PWA v2, lot 2 — les gardes SERVEUR de « prendre un ménage ».
//
// ⚠ Le reste du lot n'est éprouvé que côté DOM (tests/pwa-mes-jours-dom.test.js).
// Or les gardes de la LECTURE disent ce qu'on affiche ; elles ne protègent rien
// d'un appel forgé. Ce fichier tient les invariants du chemin d'écriture, et la
// cohérence entre ce qui est lisible et ce qui est prenable.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const API = fs.readFileSync(path.join(__dirname, '..', 'api', 'menages-public.js'), 'utf8')
// Le bloc d'écriture seul : les gardes de la lecture ont leur propre section
// plus haut dans le fichier, et les confondre ferait passer un test sur l'autre.
const ECRITURE = API.slice(API.indexOf('async function prendreUnMenage'),
                           API.indexOf('// ─── LE DELAI DE RETRAIT'))
// Le chemin de RETRAIT (lot 5), qui a ses propres gardes.
const RETRAIT = API.slice(API.indexOf('async function retirerMonMenage'),
                          API.indexOf('// ─── « MES DISPONIBILITÉS »'))
const DELAI = API.slice(API.indexOf('async function delaiDeRetrait'),
                        API.indexOf('async function retirerMonMenage'))
const HOTE = fs.readFileSync(path.join(__dirname, '..', 'apps', 'menages', 'prestataires.html'), 'utf8')
const MIGRATION = fs.readFileSync(path.join(__dirname, '..', 'migrations',
  '2026-09-17-menage-reglages-compte.sql'), 'utf8')
const LECTURE = API.slice(API.indexOf('let aPrendre = []'),
                          API.indexOf('// NOUVEAU : on renvoie aussi la liste'))

// ═══════════════════════════════════════════════════════════════════════════
// CE QUI EST PROPOSÉ
// ═══════════════════════════════════════════════════════════════════════════

test('lecture : seul le couple `unassigned` + `manual` est écarté', () => {
  // ⚠ RÉGRESSION FERMÉE, ET C'ÉTAIT LE DÉFAUT CENTRAL DU LOT.
  // `assigned_by = 'manual'` a DEUX sens : l'hôte qui désassigne (`unassigned`)
  // et une prestataire qui refuse (`orphaned`). Filtrer sur `assigned_by` seul
  // écartait tous les ménages REFUSÉS — le cas même que cette fonctionnalité
  // existe pour résoudre.
  assert.match(LECTURE, /\.in\('status', \['orphaned', 'unassigned'\]\)/)
  assert.match(LECTURE, /status\.eq\.orphaned,assigned_by\.is\.null,assigned_by\.neq\.manual/)
  // Le NULL doit être nommé : `assigned_by <> 'manual'` vaut NULL, donc faux,
  // quand la colonne est nulle — le cas le plus courant.
  assert.ok(LECTURE.includes('assigned_by.is.null'),
    'sans le NULL explicite, le filtre vide la fonctionnalité')
  // Et l'ancien filtre, celui qui écartait tout `manual`, a bien disparu.
  assert.ok(!/\.neq\('assigned_by', 'manual'\)/.test(LECTURE))
})

test('lecture : ni porteur, ni proposition en cours', () => {
  // Un ménage proposé à quelqu'un d'autre n'est pas libre : l'afficher
  // « à prendre » lancerait une course avec une collègue qui s'apprête
  // peut-être à répondre.
  assert.match(LECTURE, /\.is\('provider_id', null\)/)
  assert.match(LECTURE, /\.is\('offered_to', null\)/)
})

test('lecture : ses biens, et aucune donnée voyageur', () => {
  // ⚠ C'est ce qui sépare cette lecture de celle qui a fuité le 14 septembre :
  // un lien orphelin y voyait 11 séjours avec les NOMS DES VOYAGEURS.
  assert.match(LECTURE, /\.in\('property_id', propIds\)/)
  assert.match(LECTURE, /\.select\('booking_id, property_id, departure_date, status'\)/)
  for (const champ of ['firstName', 'lastName', 'numAdult', 'numChild', 'guest']) {
    assert.ok(!LECTURE.includes(champ), `${champ} ne doit pas sortir d'ici`)
  }
})

test('lecture : une panne coupe, elle ne rend pas une liste vide', () => {
  // « Rien à prendre » et « la lecture a échoué » ne doivent pas se ressembler.
  assert.match(LECTURE, /if \(errLibres\)/)
  assert.match(LECTURE, /503/)
})

// ═══════════════════════════════════════════════════════════════════════════
// LES CINQ GARDES DE L'ÉCRITURE
// ═══════════════════════════════════════════════════════════════════════════

test('écriture : un profil ACTIF est exigé', () => {
  // Un lien sans profil ne porte aucune assignation : le laisser prendre un
  // ménage l'attribuerait à personne.
  assert.match(ECRITURE, /profilActifDuJeton/)
  assert.match(ECRITURE, /refuserPorteur/)
})

test('écriture : ses biens uniquement', () => {
  assert.match(ECRITURE, /pt\.property_ids/)
  assert.match(ECRITURE, /403/)
  // Un `property_ids` vide signifie « tous les biens du compte », comme partout
  // sur cet endpoint — ce n'est pas une absence de périmètre.
  assert.match(ECRITURE, /permis\.length && !permis\.includes/)
})

test('écriture : les DEUX bornes de la fenêtre, pas seulement le passé', () => {
  // ⚠ La lecture borne en haut à `visibility_days` ; l'écriture ne bornait rien
  // de ce côté. « Lisible donc prenable » était vrai, l'inverse non — et une
  // garde d'écriture plus large que sa lecture finit par être celle qui compte.
  assert.match(ECRITURE, /jour < todayInParis\(\)/, 'borne basse, en heure de Paris')
  assert.match(ECRITURE, /visibility_days/, 'borne haute, celle de la lecture')
  assert.match(ECRITURE, /jour > finFenetre/)
})

test('écriture : le format de la date est vérifié AVANT la base', () => {
  // ⚠ Sans lui, la borne basse — une comparaison de CHAÎNES — se contourne :
  // « 2026-9-7 » est lexicographiquement SUPÉRIEUR à « 2026-09-17 » (parce que
  // '9' > '0'), alors que Postgres le lit comme le 7 septembre.
  const routeur = API.slice(API.indexOf("if (action === 'prendreMenage')"),
                            API.indexOf("if (action === 'declarerConge'"))
  assert.match(routeur, /\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/)
  assert.ok(routeur.indexOf('test(String(departure_date))') < routeur.indexOf('prendreUnMenage'),
    'le format se vérifie avant tout accès base')
})

test('écriture : la décision de l\'hôte se reconnaît au STATUT, pas au verrou', () => {
  // Tester `assigned_by` seul renvoyait « votre hôte gère ce ménage lui-même »
  // à quelqu'un qui regardait un ménage REFUSÉ, auquel l'hôte n'avait jamais
  // touché — une phrase fausse, sur le cas même qu'on veut résoudre.
  assert.match(ECRITURE, /menage\.assigned_by === 'manual' && menage\.status === 'unassigned'/)
  assert.ok(!/if \(menage\.assigned_by === 'manual'\) \{/.test(ECRITURE),
    'le test sur le seul verrou a disparu')
})

test('écriture : la COURSE est tranchée dans l\'écriture, pas avant', () => {
  // ⚠ Les tests de lecture ont une fenêtre derrière eux : deux prestataires
  // peuvent toucher la même bulle à la même seconde. La condition est donc
  // refaite dans l'`update`, où elle est atomique.
  const maj = ECRITURE.slice(ECRITURE.indexOf('.update({'))
  assert.match(maj, /\.is\('provider_id', null\)/)
  assert.match(maj, /\.is\('offered_to', null\)/)
  assert.match(maj, /\.in\('status', \['orphaned', 'unassigned'\]\)/)
  // Zéro ligne = course perdue, pas panne. On le DIT — sinon elle s'organise
  // autour d'un ménage qui ne lui revient pas.
  assert.match(ECRITURE, /if \(!maj \|\| !maj\.length\)/)
  assert.match(ECRITURE, /409/)
})

// ═══════════════════════════════════════════════════════════════════════════
// CE QUE L'ÉCRITURE LAISSE DERRIÈRE ELLE
// ═══════════════════════════════════════════════════════════════════════════

test('la prise pose `assigned_by: manual` — sinon le cron la lui reprend', () => {
  // ⚠ `poserPropositionsDues` sélectionne exactement `assigned_by = 'auto'` et
  // ne protège le porteur que s'il est la personne de garde du jour. Or ce
  // qu'elle vient de prendre n'a, par construction, personne de garde : le cron
  // le proposait à quelqu'un d'autre, dont l'acceptation le lui retirait sans
  // un mot.
  const maj = ECRITURE.slice(ECRITURE.indexOf('.update({'), ECRITURE.indexOf('.eq(\'id\', menage.id)'))
  assert.match(maj, /assigned_by: 'manual'/)
  assert.match(maj, /provider_id: profil\.id/)
  assert.match(maj, /status: 'accepted'/)

  // Contre-épreuve sur le lecteur : le filtre du cron est bien `'auto'`.
  const CRON = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cleaning', 'sync-menages-entite.js'), 'utf8')
  assert.match(CRON, /\.eq\('assigned_by', 'auto'\)/,
    'si ce filtre change, la protection posée ici doit être revue')
})

test('la trace est écrite, et son échec ne passe pas sous silence', () => {
  // C'est le seul canal par lequel l'hôte apprend que le ménage a changé de
  // main. Le ménage, lui, EST pris : on rend le succès, mais on crie.
  assert.match(ECRITURE, /menage_assignment_log/)
  assert.match(ECRITURE, /actor: 'provider'/)
  assert.match(ECRITURE, /if \(errLog\)/)
  assert.match(ECRITURE, /trace de prise NON ECRITE/)
})

test('le cœur n\'est pas écrit ailleurs que sur la ligne du ménage', () => {
  // Le ménage change de porteur ; rien d'autre ne bouge. Aucune écriture de
  // `bookings_snapshot` ni de `menage_done` sur ce chemin.
  for (const table of ['bookings_snapshot', 'menage_done', 'public_tokens']) {
    assert.ok(!new RegExp(`from\\('${table}'\\)[\\s\\S]{0,120}(insert|update|upsert|delete)\\(`).test(ECRITURE),
      `${table} ne doit pas être écrite par la prise`)
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// SE RETIRER D'UN MÉNAGE (lot 5)
// ═══════════════════════════════════════════════════════════════════════════

test('retrait : les quatre gardes sont refaites côté serveur', () => {
  assert.match(RETRAIT, /profilActifDuJeton/, '1 — être quelqu\'un')
  assert.match(RETRAIT, /permis\.length && !permis\.includes/, '2 — ses biens')
  assert.match(RETRAIT, /String\(menage\.provider_id \|\| ''\) !== String\(profil\.id\)/, '3 — c\'est le sien')
  assert.match(RETRAIT, /restantH < reglage\.heures/, '4 — le délai de l\'hôte')
})

test('retrait : la course est tranchée DANS l\'écriture', () => {
  // Entre la lecture et l'écriture, l'hôte a pu réassigner.
  const maj = RETRAIT.slice(RETRAIT.indexOf('.update({'))
  assert.match(maj, /\.eq\('provider_id', profil\.id\)/)
  assert.match(RETRAIT, /if \(!maj \|\| !maj\.length\)/)
  assert.match(RETRAIT, /409/)
})

test('retrait : le ménage repasse « à prendre », et le cron ne le redistribue pas', () => {
  // `orphaned` passe le filtre de `a_prendre` (quel que soit le verrou) ET n'est
  // jamais réassigné par le cron : ce statut appelle une décision humaine.
  const maj = RETRAIT.slice(RETRAIT.indexOf('.update({'), RETRAIT.indexOf(".eq('id'"))
  assert.match(maj, /provider_id: null/)
  assert.match(maj, /status: 'orphaned'/)
  assert.match(maj, /assigned_by: 'manual'/)
})

test('retrait : la trace porte un événement que la CONTRAINTE accepte', () => {
  // ⚠ L'échec de la trace est volontairement non bloquant : un événement hors
  // CHECK aurait donc été refusé EN SILENCE, et le ménage aurait changé de main
  // sans que l'hôte en soit informé — en cassant la seule chose que cette ligne
  // garantit. `released` n'existe pas dans la contrainte ; `orphaned` si.
  assert.match(RETRAIT, /event: 'orphaned'/)
  assert.ok(!/event: 'released'/.test(RETRAIT))
  const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'migrations',
    '2026-09-03-menages-entite.sql'), 'utf8')
  const check = /check \(event in \(([^)]*)\)/.exec(SCHEMA)
  assert.ok(check && check[1].includes("'orphaned'"), 'la contrainte accepte bien orphaned')
})

test('délai : une panne de lecture ne se confond pas avec « pas de réglage »', () => {
  // ⚠ Appliquer le défaut sur une panne ouvrirait le retrait à un hôte qui
  // l'avait fermé — ou l'inverse. Les deux sont des décisions prises à sa place.
  assert.match(DELAI, /if \(error\)/)
  assert.match(DELAI, /erreur: true/)
  assert.match(RETRAIT, /if \(reglage\.erreur\)/)
  assert.match(RETRAIT, /503/)
  // Un compte SANS ligne, lui, applique bien le défaut : ce n'est pas une panne.
  assert.match(DELAI, /RETRAIT_DELAI_DEFAUT/)
})

test('le réglage est à portée COMPTE, et il est borné', () => {
  assert.match(MIGRATION, /create table if not exists public\.menage_reglages/)
  assert.match(MIGRATION, /user_id uuid primary key/, 'une ligne par compte')
  assert.match(MIGRATION, /default 24/)
  assert.match(MIGRATION, /check \(retrait_delai_heures >= 0 and retrait_delai_heures <= 168\)/)
  assert.match(MIGRATION, /enable row level security/)
  assert.strictEqual((MIGRATION.match(/create policy/g) || []).length, 2)
})

test('l\'écran hôte ne montre PAS un défaut qu\'il n\'a pas pu lire', () => {
  // Afficher « 24 h » sur une panne ferait croire à l'hôte que c'est SON
  // réglage, et il repartirait sans rien changer en croyant l'avoir vérifié.
  const bloc = HOTE.slice(HOTE.indexOf('async function chargerReglageRetrait'),
                          HOTE.indexOf('async function enregistrerReglageRetrait'))
  assert.match(bloc, /champ\.disabled = true/)
  assert.match(bloc, /non lisible/)
  // Et un refus d'écriture remet le champ sur la valeur réelle du compte.
  const ecr = HOTE.slice(HOTE.indexOf('async function enregistrerReglageRetrait'))
  assert.match(ecr, /Non enregistré/)
  assert.match(ecr, /await chargerReglageRetrait\(true\)/)
  // ⚠ ET LE MESSAGE SURVIT A LA RELECTURE. Pose AVANT `chargerReglageRetrait()`,
  // il etait efface par le chemin normal de celle-ci (`etat.textContent = ''`) :
  // l'hote voyait le champ revenir au defaut SANS UN MOT.
  assert.ok(ecr.indexOf('await chargerReglageRetrait(true)') < ecr.indexOf("'Non enregistré : '"),
    'le refus s\'affiche APRES la relecture, sinon elle l\'efface')
})

test('la PWA ne propose pas un retrait qu\'elle sait refusé', () => {
  const PWA = fs.readFileSync(path.join(__dirname, '..', 'apps', 'menages', 'public.html'), 'utf8')
  const bloc = PWA.slice(PWA.indexOf('const btnRet = document.getElementById'),
                         PWA.indexOf('if (possible) retraitEnCours = m'))
  assert.match(bloc, /role === 'porteur'/, 'seulement SES ménages')
  assert.match(bloc, /retraitDelaiH !== null/, 'pas de bouton si le délai est illisible')
  assert.match(bloc, /retraitDelaiH > 0/, 'et le délai est comparé en heures')
})

// ═══════════════════════════════════════════════════════════════════════════
// LES DÉFAUTS TROUVÉS EN REVIEW DU LOT 5
//
// ⚠ CEUX-CI SONT DES TESTS DE COMPORTEMENT, PAS DE PRÉSENCE. Les tests
// ci-dessus grepent la source ; celui qui a laissé passer le défaut central le
// faisait aussi — `RETRAIT_DELAI_DEFAUT` était bien ÉCRIT dans le fichier, il
// n'était simplement jamais ATTEINT. On exécute donc le code, ici.
// ═══════════════════════════════════════════════════════════════════════════

// Rend exécutable une fonction isolée du source serveur, avec ses dépendances
// injectées. Pas de copie : c'est bien la source livrée qui tourne.
function fonctionDuServeur (nom, contexte) {
  const deb = API.indexOf(`async function ${nom} (`) >= 0
    ? API.indexOf(`async function ${nom} (`)
    : API.indexOf(`function ${nom} (`)
  assert.ok(deb >= 0, `${nom} introuvable dans api/menages-public.js`)
  const suite = API.indexOf('\n}\n', deb)
  const src = API.slice(deb, suite + 3)
  const noms = Object.keys(contexte)
  return new Function(...noms, `${src}; return ${nom}`)(...noms.map(n => contexte[n]))
}

test('délai : un compte SANS ligne applique bien 24 h — et non 0', async () => {
  // ⚠ LE DÉFAUT CENTRAL DU LOT, trouvé en review. `maybeSingle()` rend
  // `data === null` quand le compte n'a pas de ligne ; `data && data.x` vaut
  // alors `null`, `Number(null)` vaut 0, et 0 EST FINI. Le défaut n'était donc
  // jamais atteint : tous les comptes — c'est-à-dire tous, le jour de la
  // sortie — tombaient à 0 h, soit le retrait libre jusqu'à la dernière minute.
  const faux = (reponse) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => reponse }) }) }) })
  const RETRAIT_DELAI_DEFAUT = 24

  let f = fonctionDuServeur('delaiDeRetrait', { supabase: faux({ data: null, error: null }), RETRAIT_DELAI_DEFAUT, console })
  assert.deepStrictEqual(await f('u1'), { heures: 24 }, 'aucune ligne = le défaut')

  f = fonctionDuServeur('delaiDeRetrait', { supabase: faux({ data: { retrait_delai_heures: null }, error: null }), RETRAIT_DELAI_DEFAUT, console })
  assert.deepStrictEqual(await f('u1'), { heures: 24 }, 'colonne nulle = le défaut')

  // 0 réglé EXPRÈS reste 0 : c'est un choix légitime de l'hôte.
  f = fonctionDuServeur('delaiDeRetrait', { supabase: faux({ data: { retrait_delai_heures: 0 }, error: null }), RETRAIT_DELAI_DEFAUT, console })
  assert.deepStrictEqual(await f('u1'), { heures: 0 }, '0 réglé est un vrai réglage')

  f = fonctionDuServeur('delaiDeRetrait', { supabase: faux({ data: { retrait_delai_heures: 48 }, error: null }), RETRAIT_DELAI_DEFAUT, console })
  assert.deepStrictEqual(await f('u1'), { heures: 48 })

  // Et une PANNE ne se confond toujours pas avec « pas de réglage ».
  const muet = { error: () => {}, log: () => {} }
  f = fonctionDuServeur('delaiDeRetrait', { supabase: faux({ data: null, error: { message: 'boom' } }), RETRAIT_DELAI_DEFAUT, console: muet })
  assert.deepStrictEqual(await f('u1'), { erreur: true }, 'une panne n\'applique aucun défaut')
})

test('le délai se compte depuis minuit à PARIS, été comme hiver', () => {
  // ⚠ Tout ce fichier raisonne en Europe/Paris. Minuit UTC est, pour un compte
  // à l'ouest, POSTÉRIEUR au début local de la journée : le « 24 h avant » de
  // l'hôte s'appliquait avec ~28 h de marge réelle.
  const minuitParis = fonctionDuServeur('minuitParis', {})
  assert.strictEqual(new Date(minuitParis('2026-07-15')).toISOString(), '2026-07-14T22:00:00.000Z', 'été : UTC+2')
  assert.strictEqual(new Date(minuitParis('2026-01-15')).toISOString(), '2026-01-14T23:00:00.000Z', 'hiver : UTC+1')
  assert.match(RETRAIT, /minuitParis\(departureDate\)/, 'et le retrait s\'en sert')
})

test('retrait : un ménage annulé, commencé ou fait ne se retire pas', () => {
  // ⚠ `provider_id` SURVIT À L'ANNULATION — c'est ce sur quoi s'appuie la
  // résurrection. Sans garde de statut, un retrait sur une ligne `cancelled` la
  // repassait `orphaned` : proposée à toute l'équipe pour un séjour qui
  // n'existe plus, et sortie pour toujours du chemin de résurrection.
  assert.match(RETRAIT, /menage\.status !== 'accepted' && menage\.status !== 'offered'/)
  // Et le « déjà fait » est refait côté serveur : l'écran le teste, mais une
  // feuille restée ouverte ou une file hors ligne rejouée arrivent sans lui.
  assert.match(RETRAIT, /from\('menage_done'\)/)
  assert.match(RETRAIT, /déjà marqué fait/)
  // ⚠ ET LE STATUT EST REFAIT DANS L'ECRITURE : entre la lecture et elle, la
  // sync peut annuler la résa sans toucher à `provider_id`.
  const maj = RETRAIT.slice(RETRAIT.indexOf('.update({'))
  assert.match(maj, /\.in\('status', \['accepted', 'offered'\]\)/)
})

test('retrait : le passé ne se retire pas, même chez un hôte à délai zéro', () => {
  // ⚠ HORS du `if (heures > 0)` : chez un hôte qui a choisi « jusqu'au dernier
  // moment », rien d'autre ne borne la date.
  const avant = RETRAIT.slice(0, RETRAIT.indexOf('if (reglage.heures > 0)'))
  assert.match(avant, /departureDate < todayInParis\(\)/)
})

test('le délai ne rallonge pas le chemin du planning', () => {
  // ⚠ Un aller-retour de plus EN SÉRIE sur le chemin que f90874f vient
  // d'accélérer, pour une valeur qui ne sert qu'à griser un bouton.
  const GET = API.slice(API.indexOf('const propIdsForDone'), API.indexOf('return res.json({'))
  assert.ok(GET.indexOf('const promesseDelai = ') === -1, 'la promesse part AVANT la lecture des faits')
  const amont = API.slice(API.indexOf('// NOUVEAU : on renvoie aussi la liste'), API.indexOf('const propIdsForDone'))
  assert.match(amont, /const promesseDelai = delaiDeRetrait\(userId\)/)
  assert.match(API, /const lu = await promesseDelai/)
})

test('la PWA n\'ouvre pas le retrait quand le délai est illisible', () => {
  // ⚠ MÊME PIÈGE QUE LE SERVEUR, côté écran : le GET envoie `null` EXPRÈS pour
  // que le bouton soit grisé, et `Number(null)` le transformait en 0 — donc en
  // « aucun délai », donc en bouton toujours offert, dans le seul cas pour
  // lequel il a été écrit.
  const PWA = fs.readFileSync(path.join(__dirname, '..', 'apps', 'menages', 'public.html'), 'utf8')
  const deb = PWA.indexOf('const brut = data.retrait_delai_heures')
  assert.ok(deb > 0, 'la lecture du délai est introuvable')
  const src = PWA.slice(deb, PWA.indexOf('\n\n', deb))
  const calcul = new Function('data', `let retraitDelaiH; ${src}; return retraitDelaiH`)
  assert.strictEqual(calcul({ retrait_delai_heures: null }), null, 'illisible reste illisible')
  assert.strictEqual(calcul({}), null, 'champ absent = illisible')
  assert.strictEqual(calcul({ retrait_delai_heures: 0 }), 0, '0 réglé reste 0')
  assert.strictEqual(calcul({ retrait_delai_heures: 24 }), 24)
})

test('le modal est partagé : le bouton de retrait se remet à zéro', () => {
  // ⚠ Elle ouvre SON ménage A (bouton affiché, `retraitEnCours = A`), ferme,
  // puis touche une bulle « à prendre » B : le bouton de A restait sur la
  // feuille de B, et le toucher la retirait de A. Exactement le cas que le
  // commentaire de `modal-prendre` documente déjà.
  const PWA = fs.readFileSync(path.join(__dirname, '..', 'apps', 'menages', 'public.html'), 'utf8')
  assert.match(PWA, /function reinitialiserRetrait \(\)/)
  const prise = PWA.slice(PWA.indexOf('function ouvrirPriseDeMenage'), PWA.indexOf('async function prendreLeMenage'))
  assert.match(prise, /reinitialiserRetrait\(\)/, 'la feuille « prendre » remet à zéro')
  const fermer = PWA.slice(PWA.indexOf('function closeModal()'), PWA.indexOf('function closeModal()') + 200)
  assert.match(fermer, /reinitialiserRetrait\(\)/, 'la fermeture aussi')
})

test('l\'écran et le serveur comptent le délai dans le MÊME référentiel', () => {
  // ⚠ L'écran offrait le bouton jusqu'à minuit UTC quand le serveur refusait
  // déjà depuis minuit à Paris : 2 h de fenêtre l'été, 1 h l'hiver, pendant
  // lesquelles elle confirmait un geste que le serveur renvoyait en 409. Et le
  // passé n'était borné QUE dans la branche `retraitDelaiH > 0` — donc pas du
  // tout chez un hôte à délai zéro, le seul cas où rien d'autre ne le borne.
  const PWA = fs.readFileSync(path.join(__dirname, '..', 'apps', 'menages', 'public.html'), 'utf8')
  const bloc = PWA.slice(PWA.indexOf('const btnRet = document.getElementById'),
                         PWA.indexOf('if (possible) retraitEnCours = m'))
  assert.match(bloc, /minuitParis\(m\.dateStr\)/, 'le délai se compte depuis minuit à Paris')
  assert.ok(!/T00:00:00Z/.test(bloc), 'et plus depuis minuit UTC')
  assert.ok(bloc.indexOf('jourParis()') < bloc.indexOf('retraitDelaiH > 0'),
    'la borne du passé vit HORS du test de délai')

  // Et le helper de l'écran donne le même instant que celui du serveur.
  const deb = PWA.indexOf('  function minuitParis (jour) {')
  const src = PWA.slice(deb, PWA.indexOf('\n  }\n', deb) + 4)
  const mp = new Function(`${src}; return minuitParis`)()
  const serveur = fonctionDuServeur('minuitParis', {})
  for (const j of ['2026-01-15', '2026-07-15', '2026-03-29', '2026-10-25']) {
    assert.strictEqual(mp(j), serveur(j), `même instant le ${j}`)
  }
})
