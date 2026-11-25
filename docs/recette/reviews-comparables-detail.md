# Review du lot « détail de chaque comparable » — trace

- **Arbre** : `/home/claude/hotesmart`
- **Branche** : `accueil-comparables-detail`
- **Plage relue** : `0428e0adf98c1af8d63a85e65245bfb649709672..eaebd802227a556c01fb42730ad4c8f643006422`
  (un commit, le lot). SHA collés depuis `git rev-parse`.
- **Le rapport nomme lui-même l'arbre et le SHA lus** : « Arbre lu : /home/claude/hotesmart, SHA
  eaebd802227a556c01fb42730ad4c8f643006422 (branche accueil-comparables-detail, plage
  0428e0adf98c1af8d63a85e65245bfb649709672..eaebd802227a556c01fb42730ad4c8f643006422) » — conformes
  au brief.
- **Une review.** Les correctifs sont dans `8a34248c78803019df14f4d4265f291ad12c3386`, sans nouvelle
  review (CLAUDE.md, « une review par commit » : pas de constat de sécurité). Le lot ne touche pas
  l'envoi au voyageur.

## Ce que veut dire « aucun constat de sécurité »

**Aucun constat de sécurité, nulle part** : ni dans le code, ni dans la migration, ni dans les droits.
Le rapport l'a mesuré sur les trois :
- **code** : ordre des gardes (droit, périmètre, appartenance du bien au compte, puis lectures) ;
  titres et liens échappés ;
- **migration et droits** : la fonction `comparables_derniers_releves` est fermée à `anon` et
  `authenticated`, exécutable par `service_role`, **mesuré sur un Postgres 16 jetable** ; le contrôle
  est rouge (lignes 1 à 4) quand les objets manquent ;
- **RLS** : le lot ne crée aucune table ; la colonne `comparables_retenus.nom` hérite de la RLS de sa
  table.

Deux constats (M1, M2) portent sur des **gardes de sécurité que les tests ne tenaient pas** : le code
était juste, mais sa suppression laissait la suite verte. Ce sont des constats de **tests**, corrigés,
et chaque mutation du rapport a été rejouée contre les correctifs : **rouge** (voir « Suite donnée »).

## Fichiers cités par le rapport

| fichier cité | dans `git diff --name-only` de la plage |
|---|---|
| `api/ecran/revenus-annee.js` | oui (M2, M3, m1, m2, m8 ; m9 cite des lignes PRÉEXISTANTES de ce fichier, :426-433) |
| `tests/ecran-revenus-annee.test.js` | oui (M1, M6, M3) |
| `shared/comparables-detail.js` | oui (M3, M7, m3, m4) |
| `migrations/2026-11-25-comparables-detail.sql` | oui (M4, M5) |
| `docs/kb/aujourdhui.md` | oui (M5) |
| `docs/specs/spec-revenus-comparables.md` | oui (M5) |
| `shared/i18n/fr.json` | oui (M7, m7) |
| `pages/aujourdhui.html` | oui (m4, m5, m6, sélecteurs `:not(...)`) |
| `lib/marche/choix-comparables.js` (`enregistrerChoix`) | **hors plage** — lu par le rapport pour M5, sans être cité comme emplacement de constat |
| forme des réponses AirROI en cache (`POST /listings/search/radius`) | **hors plage** (donnée, pas fichier du dépôt) — lue pour M4 |

## Suite donnée

Correctifs : `8a34248c78803019df14f4d4265f291ad12c3386`.

| constat | gravité | suite |
|---|---|---|
| M1 — test « hors périmètre » : faux vert | moyen (test d'une garde de sécurité) | **corrigé** : les deux biens sont au compte, seul le périmètre peut refuser. Mutation du rapport (garde de :704) rejouée : **rouge** |
| M2 — lecture de `comparables_retenus` non cloisonnée par un test | moyen (test d'une garde de sécurité) | **corrigé** : le double honore les `eq` ; test « retenus d'un autre bien ou d'un autre compte ». Mutation (retrait des deux `eq`) rejouée : **rouge** |
| M3 — titres illisibles : « n'est plus retenu » sur chaque ligne | moyen | **corrigé** : `retenus = null` (illisible) rend `retenu: null`, l'écran n'affirme rien ; test exige `retenu === null`. Mutation rejouée : **rouge** |
| M4 — reprise des titres sans les réponses `results` | moyen | **corrigé** : branche `results` dans le bloc DO ; rejouée sur PGlite, l'annonce issue d'une réponse radius est nommée |
| M5 — migration annonçant un writer qui n'existe pas | moyen | **corrigé** : migration, commentaire de colonne, spec §7.2 et KB §8 disent que l'écriture au choix attend le go de Thierry (`lib/marche`), et que rejouer le bloc 2 rattrape les nouveaux |
| M6 — test « demi-ligne » dépendant du calendrier | moyen | **corrigé** : jour injecté (25 novembre, deux appels) via `_interne.rendreDetail` ; le test vérifie lui-même que le jour produit deux appels. Mutation `every` rejouée : **rouge** |
| M7 — motif d'un « n. c. » inaccessible au toucher | moyen | **corrigé** : au téléphone, motif court écrit sous la case ; texte de l'ⓘ ajusté |
| m1 — 0 € à venir sous le bas de la bande | mineur | **commentaire corrigé** : la différence est voulue (la bande écarte les 0 de son minimum, le détail montre chaque comparable) ; écrite dans la spec §7.4 |
| m2 — UUID en majuscules (règle 11) | mineur | **corrigé** : toutes les lectures utilisent l'id résolu en base ; test dédié. Mutation rejouée : **rouge** |
| m3 — ligne du logement sans ses réserves | mineur | **corrigé** : « incomplet » (séjours sans montant) et « en brut », visibles dans les deux formes |
| m4 — `refuseTout` en deux copies | mineur | **corrigé** : une seule copie, exportée par `shared/comparables-detail.js`, importée par la page |
| m5 — appel du détail pour un bien sans bande ; pas de retente par ce chemin | mineur | **corrigé** : c'est le rendu qui demande la lecture, seulement si le détail se montre ; test dédié. La retente d'un échec reste à la réouverture (choix assumé) |
| m6 — focus perdu après « Afficher » | mineur | **corrigé** : le focus est rendu au nouveau bouton |
| m7 — « nuits prises » et pluriels | mineur | **pluriels corrigés** (ICU) ; le mot « prises » est **gardé** : c'est celui de l'ⓘ des comparables validée par Thierry (« les nuits déjà prises chez eux »), jamais « réservé » |
| m8 — `?annee=` invalide fait refuser le détail | mineur | **corrigé** : le mode détail passe avant la validation de l'année ; test dédié |
| m9 — bande lue avec `.limit(5000)` contre 1 000 lignes (préexistant) | dette | **inscrite au registre, dette 157** (`docs/kb/dettes-v1.md`), à trancher par Thierry dans un lot à part ; spec §7.8 |

Suite après correctifs : `npm test` **9507 / 9507**.

## Rapport tel que rendu

Texte inchangé ; seuls ses titres sont descendus d'un niveau (`##` → `###`) pour s'imbriquer sous cette section.

Arbre lu : /home/claude/hotesmart, SHA eaebd802227a556c01fb42730ad4c8f643006422 (branche accueil-comparables-detail, plage 0428e0adf98c1af8d63a85e65245bfb649709672..eaebd802227a556c01fb42730ad4c8f643006422). Je n'ai rien modifié : `git status` est vide. Les mutations ont tourné dans des dossiers temporaires remplis par `git archive`, la migration dans un Postgres 16 jetable. Tout est supprimé.
Chaque constat est situé dans un fichier de la liste du diff. Pour M4 et M5, j'ai aussi lu, sans les citer comme emplacement, deux sources hors diff : la forme des réponses AirROI en cache et le writer `enregistrerChoix`.

**SÉCURITÉ : aucune fuite dans le code livré.** L'ordre des gardes est juste : droit, puis périmètre, puis appartenance du bien au compte, puis lectures. La fonction SQL est fermée à `anon` et `authenticated`, ce que j'ai mesuré sur PG16. Titres et liens sont échappés. En revanche, **deux gardes de sécurité ne sont pas tenues par les tests** (M1, M2).

### GRAVE
Aucun.

### MOYEN

**M1 — tests/ecran-revenus-annee.test.js:796-805 : le test « (SECURITE) hors périmètre » est un faux vert.**
- **Cause :** il pose `biens: [BIEN_A]`, donc BIEN_B n'appartient pas au compte. C'est la garde du bien qui refuse, pas celle du périmètre.
- **Mutation mesurée :** j'ai remplacé la garde de api/ecran/revenus-annee.js:704 par `if (Array.isArray(refsUuid) && refsUuid.length === 0)`. Le fichier reste à 41/41 verts.
- **Ce que la mutation ouvrirait :** un membre limité à A lirait le détail de B, du même compte.
- **Correctif :** garder `biens: [BIEN_A, BIEN_B]` (le défaut du banc), refs [BIEN_A], demander B, et exiger 403 sans aucune lecture.

**M2 — api/ecran/revenus-annee.js:729-730 : la lecture de `comparables_retenus` n'est pas cloisonnée par un test (règle 22).**
- **Cause :** le double rend `retenus` quels que soient les filtres.
- **Mutation mesurée :** j'ai retiré `.eq('user_id', compte).eq('property_id', bien)`. Le résultat reste à 61/61 verts.
- **Ce que la mutation ouvrirait :** avec la clé de service, les retenus actifs de tous les comptes apparaîtraient, sans photo, en lignes du tableau, avec titre et lien.
- **Correctif :** le double applique ses `eq` sur cette table. Ajouter un retenu d'un autre bien et d'un autre compte qui ne doit pas apparaître.

**M3 — api/ecran/revenus-annee.js:636, 663, 751-760 et shared/comparables-detail.js:82 : des titres illisibles affichent « n'est plus retenu » sur chaque ligne.**
- **Scénario :** si la lecture des retenus échoue, ou dépasse 200 lignes, alors `retenus = []`, chaque comparable reçoit `actif:false` puis `retenu:false`, et l'écran écrit « n'est plus retenu » sous chacun.
- **Effet aggravant :** les retenus actifs encore sans relevé disparaissent. Une absence devient un fait.
- **Test qui fige le défaut :** celui de la ligne 922 ne vérifie que `nom === null`.
- **Correctif :** quand `noms` est indisponible, rendre `retenu: null` et n'afficher aucune mention. Le test exige `retenu !== false`.

**M4 — migrations/2026-11-25-comparables-detail.sql:64-72 : la reprise des titres ignore les réponses `POST /listings/search/radius`.**
- **Cause :** ces réponses ont la forme `{pagination, results:[{listing_info…}]}`. C'est la liste proposée quand le profil a des équipements rares ; seuls `listings` et la fiche seule sont lus.
- **Mesure sur PG16 :** fiche et `listings` sont bien nommés ; l'annonce `957719958325441345`, issue d'une réponse radius, reste à `null`.
- **Correctif :** ajouter `when jsonb_typeof(j -> 'results') = 'array' then j -> 'results'`. Les éléments sans `listing_info` sont déjà écartés par `ident is null`.

**M5 — migrations/2026-11-25-comparables-detail.sql:5-8 et 30-34 : la migration annonce un writer qui n'existe pas encore.**
- **Contradiction :** l'en-tête et le commentaire de colonne en base disent « WRITER UNIQUE : enregistrerChoix ». Or aucun fichier de `lib/marche` n'est dans la plage : le writer n'écrit pas `nom` à ce SHA. La spec §7.2 dit qu'il attend le go de Thierry.
- **Effet :** tout comparable choisi après la migration reste « Annonce sans titre » pour toujours, sauf si l'on recolle le bloc DO.
- **Ni la KB ni la spec ne le disent :** docs/kb/aujourdhui.md §8 n'en parle pas, et docs/specs/spec-revenus-comparables.md §7.7 compte les nommés « après la migration » comme si c'était stable.
- **Correctif :** écrire « writer à venir » dans le commentaire et dans la KB, ou livrer le writer avant.

**M6 — tests/ecran-revenus-annee.test.js:908-918 : le test « demi-ligne » dépend du calendrier (règle 19, dette 124).**
- **Cause :** `anneesARevenus` ne donne deux appels qu'en octobre et novembre. Le reste de l'année, l'unique appel échoue et le test passe contre un code faux.
- **Mesure :** la mutation `revs.every(r => r && r.error) ? revs[0] : undefined` à :740 est rouge à J+0, mais verte à J+10 et J+40. À partir du 1er décembre, le test ne garde plus rien.
- **Correctif :** injecter le jour, par exemple en exposant `rendreDetail(res, t0, {…, jour:'2026-11-25'})`.

**M7 — mobile ≤ 560 px : le motif d'un « n. c. » est inaccessible au toucher et au clavier.**
- **Où :** le motif ne vit que dans un attribut `title` (shared/comparables-detail.js:86, 91, 167, 178).
- **Contradiction :** l'infobulle dit « le motif s'affiche au survol » (shared/i18n/fr.json:1303). La page a pourtant décidé le 29 octobre qu'un `title` n'apparaît pas au toucher.
- **Effet :** sur téléphone, chaque « n. c. » perd son motif, alors que la règle veut qu'un `null` s'affiche avec son motif.
- **Correctif :** mettre le motif dans le DOM dans la forme carte (ligne secondaire ou ⓘ par carte).

### MINEUR
- **m1 — api/ecran/revenus-annee.js:605-611 :** un mois à venir à 0 € s'affiche « 0 € », alors que la bande l'écarte du minimum (:476, `sansActivite`). Le tableau montre donc un minimum sous celui de la bande, contre le commentaire « mêmes filtres que la bande » (:586).
- **m2 — api/ecran/revenus-annee.js:683 (règle 11) :** un UUID en majuscules passe la garde (`UUID_RE` est en `/i`, et le cast uuid accepte la casse). La comparaison de chaînes vide alors la ligne du logement, qui affiche « aucun » chaque mois. Correctif : utiliser l'id résolu en base (`biens[0].id`) pour toutes les lectures suivantes.
- **m3 — shared/comparables-detail.js:68 :** une case du logement avec `sans_montant > 0` et un total positif, ou avec `bruts > 0`, montre un chiffre sans réserve. L'infobulle de la vue Année, elle, les déclare.
- **m4 — shared/comparables-detail.js:24 :** `refuseTout` est une copie de pages/aujourdhui.html:2188. Deux copies divergent ; il faut une seule source.
- **m5 — pages/aujourdhui.html:3280 :**
  - détail ouvert et changement de pastille : l'appel part même si ce bien n'a pas de bande, donc un appel que personne n'a demandé ;
  - un bien dont la lecture a échoué n'est pas retenté par ce chemin, seulement à la réouverture.
- **m6 — pages/aujourdhui.html:693-699 :** « Afficher » réécrit la légende, donc le bouton est détruit et le focus est perdu au clavier et au lecteur d'écran. Correctif : remettre le focus sur `[data-detail-comparables]` après le rendu.
- **m7 — shared/i18n/fr.json:1303 et 1322 :**
  - « nuits déjà prises » et « {n} nuits prises » se lisent comme « vendues ». Or `available=false` confond nuits vendues, fermées et invendables (règle « occupé, jamais réservé ») ;
  - il manque le pluriel ICU (« 1 nuits »).
- **m8 — api/ecran/revenus-annee.js:97 :** un `?annee=` invalide fait rendre 400 au mode détail, qui n'utilise pas l'année.
- **m9 — préexistant, dans ce fichier : bande lue sans plafond réel.** La lecture de la bande garde `.limit(5000)` contre un plafond PostgREST de 1 000 lignes (:426-433). Le propre en-tête de la migration dit que cette lecture brute dépasse 1 000 lignes en quelques mois. Au-delà d'environ 27 comparables par relevé, la bande perd des comparables sans le dire et diverge du détail.

### Vérifié sans constat
- **Migration sur PG16 :**
  - elle s'applique et se rejoue ;
  - un JSON illisible, un scalaire ou un tableau au premier niveau sont sautés ;
  - les grands identifiants restent exacts ;
  - la fonction rend la photo la plus récente par case et filtre `clos`/`futur` ;
  - `service_role` peut l'exécuter, `anon` non ;
  - le contrôle est rouge (lignes 1 à 4) quand les objets manquent.
- **Fenêtre et années demandées :** justes en octobre, novembre, décembre et janvier.
- **Pas de double comptage :** `revenus_annee` groupe par bien, année et mois.
- **Sélecteurs `:not(...)` :** justes. Le seul `.rev-tbl-wrap` nu (aujourdhui.html:1705) tombe sur le tableau du mois, qui est préexistant.
- **Suite complète :** 9500/9500 verts.
- **Tests du lot :** verts à J+6, 37, 60, 128, 200 et 400.
- **`scripts/i18n-check.js` :** OK.
