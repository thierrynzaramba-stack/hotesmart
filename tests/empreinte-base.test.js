// tests/empreinte-base.test.js — QUELLE BASE EST-ON EN TRAIN DE LIRE ?
//
// Tous les vérificateurs du dépôt impriment une empreinte avant de mesurer, et
// refusent de travailler sur une base qu'ils ne reconnaissent pas : « un
// résultat qui ne dit pas OÙ il a été obtenu ne prouve rien ».
//
// ⚠ VINGT-TROIS SCRIPTS IDENTIFIAIENT LA BASE PAR SON NOMBRE DE LOGEMENTS —
// « 5 = production, 3 = staging ». Mesure du 26 octobre 2026 : staging en porte
// QUATRE depuis qu'un bien y a été créé, et ces scripts ont commencé à refuser
// une base parfaitement identifiable. Une empreinte qui dérive avec la donnée
// se trompe dans les deux sens, et le second est le dangereux : le jour où la
// production tombera à 3 biens, elle dira « STAGING » sur la PRODUCTION.
//
// ⚠ ET LE COMPTE A MONTÉ TROIS FOIS — 5, PUIS 14, PUIS 23 — TOUJOURS POUR LA
// MÊME RAISON. Chaque élargissement est venu d'une relecture, jamais de mon
// balayage : un motif textuel ne voit que la FORME qu'il connaît.
//   · je cherchais `biens === <n>` → neuf scripts écrivaient `biens !== 3` ;
//   · j'ai élargi aux deux sens → sept scripts de plus comparaient le compte à
//     une valeur ANNONCÉE par l'opérateur, `Number(val('biens')) !== count`,
//     sans aucun littéral 3 ni 5 dans la comparaison.
// D'où le second volet de ce fichier : au lieu de chercher les formes
// fautives, EXIGER la forme juste. C'est la seule garde qui ne dépend pas de
// mon imagination.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const E = require('../lib/empreinte-base')

const RACINE = path.join(__dirname, '..')
const DOSSIER = path.join(RACINE, 'scripts')
const SCRIPTS = fs.readdirSync(DOSSIER).filter(x => x.endsWith('.js')).sort()
const lire = (f) => fs.readFileSync(path.join(DOSSIER, f), 'utf8')

// ⚠ LE CODE SEUL, COMMENTAIRES RETIRÉS — ET LES TROIS FORMES, PAS UNE SEULE
// (constat MINEUR de la review : mon filtre ne retirait que les lignes
// commençant par `//`, donc un `/* … */` ou un commentaire de fin de ligne
// était VU par les motifs et aurait pu faire crier la garde à tort).
// L'HISTOIRE d'un défaut a le droit de le nommer — c'est même ce qui empêche
// de le réintroduire par ignorance.
function codeSeul (src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // blocs
    .split('\n')
    .map(l => l.replace(/\/\/.*$/, ''))  // fin de ligne, et lignes `//` entières
    .join('\n')
}

test('LE TEST QUI COMPTE : la base se reconnaît à la référence du PROJET', () => {
  assert.equal(E.nomDeLaBase('https://cjmrizpdyhrcurmgyrhs.supabase.co'), 'PRODUCTION')
  assert.equal(E.nomDeLaBase('https://ortyofzzdsthlhqmzsnq.supabase.co'), 'STAGING')
  // Avec un chemin, un port, une casse différente : c'est la même base.
  assert.equal(E.nomDeLaBase('https://CJMRIZPDYHRCURMGYRHS.supabase.co/rest/v1'), 'PRODUCTION')
  // Un espace parasite ne change pas la base, de quel côté qu'il soit. La
  // version précédente acceptait l'espace FINAL et refusait l'INITIAL, parce
  // que seul le début de la chaîne était ancré.
  assert.equal(E.nomDeLaBase(' https://cjmrizpdyhrcurmgyrhs.supabase.co'), 'PRODUCTION')
  assert.equal(E.nomDeLaBase('https://cjmrizpdyhrcurmgyrhs.supabase.co '), 'PRODUCTION')
})

test("LE TEST QUI COMPTE : `INCONNUE` est un REFUS, jamais un repli", () => {
  // Un script qui continue sur une base qu'il ne reconnaît pas rend une mesure
  // dont personne ne pourra dire d'où elle vient.
  for (const url of [
    'https://autre-projet.supabase.co',   // un troisième projet
    'http://localhost:54321',             // une base locale
    '', null, undefined, 'pas une url',
    'cjmrizpdyhrcurmgyrhs.supabase.co',   // sans schéma : on ne devine pas
    'https://a.b.supabase.co',            // deux étiquettes : laquelle ?
    'https://supabase.co',                // le domaine nu n'est pas un projet
    0, 1, true, {}, [], NaN               // et rien de tout cela ne doit lever
  ]) {
    assert.equal(E.nomDeLaBase(url), 'INCONNUE', `${String(url)} est reconnue à tort`)
    assert.equal(E.estLaProduction(url), false, `${String(url)} passe pour la production`)
  }
})

test("LE TEST QUI COMPTE : une clé d'`Object.prototype` n'est pas une base", () => {
  // ⚠ CONSTAT GRAVE DE LA REVIEW DU 26 OCTOBRE 2026, MESURÉ :
  //   nomDeLaBase('https://constructor.supabase.co')  ->  [Function: Object]
  // Un littéral objet hérite d'`Object.prototype`, donc `PROJETS['constructor']`
  // rendait la FONCTION `Object` — truthy. Le `|| 'INCONNUE'` ne mordait pas,
  // `=== 'INCONNUE'` était faux, et les six lecteurs du dépôt CONTINUAIENT,
  // trois en rendant exit 0 : une mesure complète, annoncée réussie, sur une
  // base non reconnue. Le défaut que l'empreinte existe pour empêcher, par la
  // porte du langage.
  for (const cle of ['constructor', 'tostring', 'valueof', 'hasownproperty',
    'isprototypeof', 'proto', 'prototype']) {
    const nom = E.nomDeLaBase(`https://${cle}.supabase.co`)
    assert.equal(nom, 'INCONNUE', `« ${cle} » est reconnue à tort : ${String(nom)}`)
  }
  // Et le contrat tient : trois valeurs, jamais autre chose.
  for (const url of ['https://constructor.supabase.co', 'https://cjmrizpdyhrcurmgyrhs.supabase.co', null]) {
    assert.ok(['PRODUCTION', 'STAGING', 'INCONNUE'].includes(E.nomDeLaBase(url)),
      `hors contrat : ${String(E.nomDeLaBase(url))}`)
  }
})

test("LE TEST QUI COMPTE : une URL qui ne POINTE pas sur le projet est INCONNUE", () => {
  // ⚠ CONSTAT DE LA MÊME REVIEW, ET LES DEUX SENS ÉTAIENT MAUVAIS. Le motif
  // ancré lisait la première étiquette sans jamais regarder OÙ l'URL pointe :
  //   'https://cjmrizpdyhrcurmgyrhs.supabase.co.evil.test/' -> PRODUCTION,
  //      et `estLaProduction` rendait TRUE, alors que l'hôte est un
  //      sous-domaine d'evil.test ;
  //   'https://ortyofzzdsthlhqmzsnq.supabase.co@evil.test/' -> STAGING,
  //      alors que tout ce qui précède le `@` est de l'userinfo.
  for (const url of [
    'https://cjmrizpdyhrcurmgyrhs.supabase.co.evil.test/',
    'https://ortyofzzdsthlhqmzsnq.supabase.co@evil.test/',
    'https://cjmrizpdyhrcurmgyrhs.supabase.co.attaquant.fr',
    'https://evil.test/?h=cjmrizpdyhrcurmgyrhs.supabase.co'
  ]) {
    assert.equal(E.nomDeLaBase(url), 'INCONNUE', `${url} est reconnue à tort`)
    assert.equal(E.estLaProduction(url), false, `${url} passe pour la production`)
  }
})

test('la référence du projet se lit, et ne s invente pas', () => {
  assert.equal(E.refDuProjet('https://abcdef.supabase.co'), 'abcdef')
  assert.equal(E.refDuProjet('https://ABCdef.supabase.co'), 'abcdef')
  // ⚠ UN TEST PEUT FIGER UN BUG (règle 17 de REVIEW.md), ET CELUI-LÀ LE
  // FAISAIT. Sa version précédente exigeait `refDuProjet('https://supabase.co')
  // === 'supabase'` — « le premier segment est la référence » —, c'est-à-dire
  // elle DEMANDAIT au module de lire une étiquette sans vérifier le domaine.
  // C'est la cause des deux URL trompeuses ci-dessus.
  assert.equal(E.refDuProjet('https://supabase.co'), null,
    'le domaine nu n est pas un projet')
  assert.equal(E.refDuProjet('ftp:/x'), null)
  assert.equal(E.refDuProjet(null), null)
})

test('LE TEST QUI COMPTE : plus aucun script ne reconnaît la base à son nombre de LOGEMENTS', () => {
  // ⚠ MOTIF TEXTUEL, EN DERNIER RECOURS ET ASSUMÉ (règle 20 de REVIEW.md).
  // Aucun appel ne peut voir qu'un script ÉCRIRA demain `biens === 5` : le
  // défaut est dans la frappe, et c'est par recopie qu'il s'est répandu.
  //
  // ⚠ TROIS FORMES, PARCE QUE J'EN AI DÉCOUVERT UNE À CHAQUE RELECTURE :
  //   1. `biens === 3` / `count !== 5` — la forme d'origine ;
  //   2. la même, écrite dans l'autre sens (`3 !== biens`) ;
  //   3. ⚠ LA COMPARAISON À UNE VALEUR ANNONCÉE — `Number(val('biens')) !==
  //      count` —, qui ne porte AUCUN littéral 3 ni 5 et échappait donc aux
  //      deux premières. Sept scripts, dont cinq qui écrivent. C'est la forme
  //      que la review du 26 octobre a trouvée et que je n'avais pas imaginée.
  const fautifs = []
  for (const f of SCRIPTS) {
    const code = codeSeul(lire(f))
    // Les deux nombres de la convention, dans les deux sens. Viser 3 et 5 et
    // non « tout nombre » est raisonné : ma version large attrapait
    // `inventory_units === 1` et `count === 0`, trois faux positifs sur trois
    // scripts qui n'avaient rien fait de mal — et une garde qui crie à tort
    // est une garde qu'on désactive.
    if (/\b(biens|count)\b[^\n;]{0,40}(===|!==|==|!=)\s*[35]\b/.test(code)) { fautifs.push(f); continue }
    if (/\b[35]\s*(===|!==|==|!=)[^\n;]{0,40}\b(biens|count)\b/.test(code)) { fautifs.push(f); continue }
    // La troisième forme : un compte de biens comparé à ce que l'opérateur a
    // annoncé. Le nombre n'est nulle part dans le code — c'est la comparaison
    // elle-même qui est l'empreinte, et c'est elle qu'on refuse.
    if (/val\(\s*['"]biens['"]\s*\)[^\n;]{0,60}(===|!==|==|!=)|(===|!==|==|!=)[^\n;]{0,60}val\(\s*['"]biens['"]\s*\)/.test(code)) {
      fautifs.push(f)
    }
  }
  assert.deepEqual(fautifs, [],
    'un script identifie la base par son nombre de logements : staging en a gagné un le 26 octobre 2026, '
    + 'et le jour où la production en perdra un, le script dira « STAGING » sur la PRODUCTION. '
    + 'Règle partagée : lib/empreinte-base.js')
})

test("LE TEST QUI COMPTE : la légende « 5 = production, 3 = staging » ne s IMPRIME plus", () => {
  // ⚠ UN NOMBRE ÉCRIT À LA MAIN EST LU COMME UNE MESURE ET NE ROUGIT JAMAIS —
  // règle du dépôt. Cette légende partait dans la sortie console de DOUZE
  // scripts, donc dans les comptes rendus de recette, comme un fait. Elle est
  // FAUSSE pour staging depuis le 26 octobre 2026, et le lot qui l a mesurée ne
  // pouvait pas la laisser derrière lui.
  //
  // ⚠ ON NE CHERCHE QUE DANS CE QUI S IMPRIME, ET C EST RAISONNÉ. Ma première
  // version balayait le fichier entier, donc elle rougissait sur les
  // commentaires qui RACONTENT le défaut — « l ancienne règle 5 = production,
  // 3 = staging refusait une base identifiable ». Or l HISTOIRE d un défaut a le
  // droit de le nommer : c est même ce qui empêche de le réintroduire par
  // ignorance, et la règle du dépôt ne proscrit pas de citer, elle proscrit
  // d AFFIRMER. On vise donc les littéraux de chaîne — ce qui sort à l écran.
  const fautifs = []
  for (const f of SCRIPTS) {
    // Les littéraux : simples, doubles, et gabarits.
    const chaines = String(lire(f)).match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) || []
    for (const c of chaines) {
      if (/[35]\s*=\s*(production|staging)/i.test(c)
        || /\([35]\s+staging,\s*[35]\s+production\)/i.test(c)
        || /[35]\s+biens?\s*=\s*(production|staging)/i.test(c)) { fautifs.push(f); break }
    }
  }
  assert.deepEqual([...new Set(fautifs)], [],
    'la légende « 5 = production, 3 = staging » s imprime encore : elle se lit comme une mesure, '
    + 'et staging porte QUATRE biens.')
})

test("LE TEST QUI COMPTE : aucun script ne recopie une référence de projet", () => {
  // ⚠ LE MODULE S ANNONCE « RÈGLE PARTAGÉE » ET LA TABLE ÉTAIT EN DUR DANS
  // 21 FICHIERS (constat de la review du 26 octobre 2026). Tous utilisaient le
  // BON critère — la référence du projet —, c est la TABLE qui n était pas
  // partagée : une copie ne se corrige pas quand l original change. Le module
  // exporte `REF_PRODUCTION` et `REF_STAGING` pour les deux vérificateurs qui
  // ont besoin de la chaîne elle-même (`CONFIRMER_PROD=<référence>`).
  const fautifs = []
  for (const f of SCRIPTS) {
    const code = codeSeul(lire(f))
    if (code.includes(E.REF_PRODUCTION) || code.includes(E.REF_STAGING)) fautifs.push(f)
  }
  assert.deepEqual(fautifs, [],
    'une référence de projet est recopiée hors de lib/empreinte-base.js : '
    + 'importer REF_PRODUCTION / REF_STAGING, ou comparer par nomDeLaBase()')
})

// ─── Le second volet : EXIGER la forme juste ────────────────────────────────
//
// ⚠ POURQUOI CE VOLET EXISTE, ET C EST LA VRAIE LEÇON DU LOT. Le compte des
// scripts fautifs a monté QUATRE fois — 5, 14, 23, puis 23 + les gardes par
// référence recopiée — et chaque fois la découverte est venue d une relecture,
// jamais de mon balayage. La cause est toujours la même : un motif textuel ne
// voit que la FORME qu il connaît.
//   · `biens === 3` → je ne voyais pas `biens !== 3` ;
//   · les deux sens → je ne voyais pas `Number(val('biens')) !== count`, où le
//     nombre n apparaît nulle part ;
//   · et mon premier motif de garde cherchait la variable `projet`, donc il ne
//     reconnaissait pas `base === 'INCONNUE'` — mes propres corrections.
// D où le renversement : au lieu de chercher les formes fautives, EXIGER la
// forme juste, et ancrer le motif sur les TROIS VALEURS DU CONTRAT plutôt que
// sur un nom de variable que chacun choisit comme il veut.

// Les scripts qui touchent une base Supabase. On ne liste pas à la main : une
// liste se périme, et c est ainsi que cinq scripts sont devenus vingt-trois.
const TOUCHENT = SCRIPTS.filter(f => /process\.env\.SUPABASE_URL/.test(codeSeul(lire(f))))

// Un script ÉCRIT s il appelle une mutation PostgREST ou le stockage.
const ECRITURE = /\.(insert|upsert|update|delete)\s*\(|storage[\s\S]{0,80}\.(createBucket|updateBucket|upload|remove)\s*\(/

// Une garde = une comparaison à l une des TROIS VALEURS DU CONTRAT, ou un appel
// au module, suivie de PRÈS d une sortie. « De près » = 400 caractères, la même
// fenêtre que la garde des lecteurs.
const GARDE = /((===|!==)\s*'(INCONNUE|STAGING|PRODUCTION)'|'(INCONNUE|STAGING|PRODUCTION)'\s*(===|!==)|estLaProduction\s*\(|nomDeLaBase\s*\([^)]*\)\s*(===|!==))[\s\S]{0,400}?process\.exit\s*\(/

const ECRIVAINS = TOUCHENT.filter(f => ECRITURE.test(codeSeul(lire(f))))
const LECTEURS = TOUCHENT.filter(f => !ECRITURE.test(codeSeul(lire(f))))

// ⚠ DEUX LISTES D EXEMPTION, CHIFFRÉES, QUI NE PEUVENT QUE DÉCROÎTRE.
// Elles ne décrivent pas un état acceptable : elles bornent une dette que ce
// lot ne pouvait pas fermer — 73 scripts, pour l essentiel des one-shots
// historiques (`backfill-*`, `supprimer-residu-*`, `purge-*`) dont beaucoup
// n ont servi qu une fois. Les fermer d un coup aurait fait un commit que
// personne ne peut relire, donc une review qui ne mesure rien.
//
// Ce que la liste garantit, et c est ce qui compte : un script NEUF sans garde
// rougit, et un script qu on corrige DOIT sortir de la liste — un retrait non
// enregistré rougit aussi. C est la discipline de l `ATTENDU` de
// `bookings-snapshot-troncature` : une exemption se COMPTE, elle ne se décrit
// pas. Registre : docs/kb/dettes-v1.md, dette 98.
const ECRIVAINS_SANS_GARDE = [
  'amorcer-prix-beds24.js', 'backfill-empreinte-messages.js',
  'backfill-historique.js', 'backfill-snapshot-provider.js',
  'booking-links.js', 'config-lola-mardi-colomiers.js',
  'dedoublonner-sejours-remappes.js', 'diagnostic-orphelines.js',
  'finir-transfert-supprimer-ancienne.js',
  'fusionner-calendriers-avant-transfert.js',
  'importer-vacances-scolaires.js', 'passer-en-managed.js',
  'purge-orphelines.js', 'purger-faux-envois-offline.js',
  'reconcilier-stop-sell.js', 'rekeyer-json-config.js',
  'remplir-fiche-unifiee.js', 'rendre-sejours-au-bien.js',
  'supprimer-resa-figee.js', 'supprimer-residu-beds24.js',
  'supprimer-residus-phase0.js', 'templates-test-colomiers.js',
  'test-acceptation-price-log.js', 'transferer-bien-vers-fiche-neuve.js',
  'verifier-migration-canaux-du-bien.js',
  'verifier-migration-canaux-echec.js', 'verifier-migration-cron-stats.js',
  'verifier-migration-reponses-partenaire.js', 'verifier-migration-units.js',
  'verifier-price-log.js', 'verifier-yield-evenements.js',
  'verifier-yield-events.js', 'verifier-yield-exceptions.js',
  'verifier-yield-reglages.js'
]
const LECTEURS_SANS_REFUS = [
  'amorcer-price-log.js', 'audit-prix-voyageur.js', 'audit-stop-sell.js',
  'backfill-beds24-host.js', 'backfill-fiches.js', 'backfill-guest-email.js',
  'classement-cron.js', 'cloture-annuler-resas-test.js',
  'declarer-exception-yield.js', 'diagnostic-import-colomiers.js',
  'diagnostic-parite-semaines.js', 'etat-bascule-la-bulle.js',
  'inventaire-references-uuid.js', 'inventaire-tables.js',
  'mapper-airbnb-second-bien.js', 'observer-cycles-cron.js',
  'observer-session-test.js', 'observer-test-canal-email.js',
  'parite-gardes-des-fils.js', 'poser-derives-biens-neufs.js',
  'pousser-grille-reelle.js', 'reconcilier-menages-orphelins.js',
  'rejouer-message-offline.js', 'releve-controle-marche.js',
  'valider-moteur.js', 'verifier-chaine.js', 'verifier-dette-78.js',
  'verifier-fermetures.js', 'verifier-isolation-ecran.js',
  'verifier-mapping-airbnb.js', 'verifier-migration-beds24-token-expire.js',
  'verifier-migration-gardes-des-fils.js',
  'verifier-migration-regles-atomiques.js', 'verifier-migrations-4-6.js',
  'verifier-parite-capacites.js', 'verifier-parite-notes.js',
  'verifier-parite-prix.js', 'verifier-parite-templates.js',
  'verifier-pilote-tarifaire.js'
]

test("LE TEST QUI COMPTE : tout script qui ÉCRIT se garde par le PROJET, et la garde est PRÈS du refus", () => {
  // ⚠ MA PREMIÈRE VERSION ÉTAIT UN FAUX VERT, ET LA REVIEW L A PROUVÉ EN
  // FABRIQUANT LE CAS. Elle cherchait `/nomDeLaBase|PROJET_STAGING/` et
  // `/process\.exit\(\d*\)/` N IMPORTE OÙ dans le fichier. Or quatre des huit
  // écrivains importaient `nomDeLaBase` sans jamais l appeler, et `process.exit`
  // y figure cinq à huit fois pour d autres raisons : un script réduit à son
  // `require` plus une écriture, SANS AUCUNE GARDE, passait au vert.
  const sansGarde = ECRIVAINS.filter(f => !GARDE.test(codeSeul(lire(f))))
  const nouveaux = sansGarde.filter(f => !ECRIVAINS_SANS_GARDE.includes(f))
  const corriges = ECRIVAINS_SANS_GARDE.filter(f => !sansGarde.includes(f))
  assert.deepEqual(nouveaux, [],
    'un script ÉCRIT sur une base sans vérifier DE QUELLE BASE il s agit. '
    + 'Règle partagée : lib/empreinte-base.js — le nombre de biens ne décide plus, il informe.')
  assert.deepEqual(corriges, [],
    'ces scripts ont maintenant leur garde : les retirer de ECRIVAINS_SANS_GARDE. '
    + 'Une exemption qu on oublie de rendre est une dette qui a l air plus grosse qu elle n est.')
  // Le compte, en clair : c est lui qu on lit avant de pousser.
  assert.equal(sansGarde.length, ECRIVAINS_SANS_GARDE.length)
})

test("LE TEST QUI COMPTE : tout script qui MESURE refuse une base qu il ne reconnaît pas", () => {
  // Un vérificateur qui continue sur une base inconnue rend un résultat dont
  // personne ne pourra dire d où il vient.
  const sansRefus = LECTEURS.filter(f => !GARDE.test(codeSeul(lire(f))))
  const nouveaux = sansRefus.filter(f => !LECTEURS_SANS_REFUS.includes(f))
  const corriges = LECTEURS_SANS_REFUS.filter(f => !sansRefus.includes(f))
  assert.deepEqual(nouveaux, [], 'un script lit une base sans jamais refuser celle qu il ne reconnaît pas')
  assert.deepEqual(corriges, [], 'ces scripts refusent maintenant : les retirer de LECTEURS_SANS_REFUS')
  assert.equal(sansRefus.length, LECTEURS_SANS_REFUS.length)
})

test("LE TEST QUI COMPTE : les quatorze scripts du LOT ont tous leur garde", () => {
  // ⚠ CE TEST EST LA CONTRE-ÉPREUVE DES DEUX LISTES CI-DESSUS. Une exemption
  // chiffrée protège contre la croissance, pas contre un oubli DANS le lot :
  // si j avais laissé un des quatorze sans garde, il lui aurait suffi d être
  // dans la liste pour passer au vert. Les quatorze sont donc nommés, et aucun
  // n a le droit d y figurer.
  const LOT = ['verifier-temperature-airroi.js', 'relances-avis-a-blanc.js',
    'verifier-auto-validation.js', 'verifier-migration-comparables.js',
    'verifier-eval-scope.js', 'verifier-avis-evaluation.js',
    'creer-membre-test-staging.js', 'prouver-grille-avis.js', 'prouver-parcours-avis.js',
    'prouver-rls-avis.js', 'recette-avis-staging.js', 'prouver-lots-5-7-avis.js',
    'prouver-simulation-avis.js', 'recapturer-calendriers-comparables.js']
  assert.equal(LOT.length, 14)
  for (const f of LOT) {
    assert.ok(!ECRIVAINS_SANS_GARDE.includes(f) && !LECTEURS_SANS_REFUS.includes(f),
      `${f} est dans une liste d exemption alors qu il est DU LOT`)
    assert.ok(GARDE.test(codeSeul(lire(f))), `${f} n a pas de garde reconnaissable`)
  }
})

test("LE TEST QUI COMPTE : les NEUF scripts fermés après la review ont leur garde", () => {
  // Les sept qui comparaient `--biens=N` au compte réel, et les deux qui
  // n avaient AUCUNE garde. Même raison que ci-dessus : nommés, donc protégés
  // contre un retour en arrière passé en exemption.
  const APRES_REVIEW = ['lier-bien-marche.js', 'rattraper-origine-avis.js',
    'corriger-echeance-avis.js', 'nettoyer-profil-test-colomiers.js',
    'verser-fixture-marche.js', 'enregistrer-temperature-airroi.js',
    'calculer-calendrier-marche.js',
    'verifier-migration-messages-origine.js', 'creer-bucket-photos.js']
  assert.equal(APRES_REVIEW.length, 9)
  for (const f of APRES_REVIEW) {
    assert.ok(!ECRIVAINS_SANS_GARDE.includes(f) && !LECTEURS_SANS_REFUS.includes(f),
      `${f} est exempté alors que le lot l a fermé`)
    assert.ok(GARDE.test(codeSeul(lire(f))), `${f} n a pas de garde reconnaissable`)
    // Et l option `--biens` n existe plus : l opérateur annonce la BASE.
    assert.ok(!/val\(\s*['"]biens['"]\s*\)/.test(codeSeul(lire(f))),
      `${f} compare encore un nombre de biens annoncé`)
  }
})

test('les imports du module commun sont tous UTILISÉS', () => {
  // ⚠ UN IMPORT MORT EST UNE GARDE QUI N EXISTE PAS, ET IL A PRODUIT LE FAUX
  // VERT CORRIGÉ PLUS HAUT : six scripts importaient `nomDeLaBase` ou
  // `refDuProjet` sans jamais les appeler, et mon ancien motif s en satisfaisait.
  const morts = []
  for (const f of SCRIPTS) {
    const code = codeSeul(lire(f))
    for (const nom of ['nomDeLaBase', 'refDuProjet', 'estLaProduction', 'REF_PRODUCTION', 'REF_STAGING']) {
      if (!new RegExp(`\\{[^}]*\\b${nom}\\b[^}]*\\}\\s*=\\s*require`).test(code)) continue
      const motif = nom.startsWith('REF_') ? new RegExp(`\\b${nom}\\b`, 'g') : new RegExp(`\\b${nom}\\s*\\(`, 'g')
      const n = (code.match(motif) || []).length
      if (nom.startsWith('REF_') ? n < 2 : n < 1) morts.push(`${f} (${nom})`)
    }
  }
  assert.deepEqual(morts, [], 'import mort : le nom est là, la garde non')
})
