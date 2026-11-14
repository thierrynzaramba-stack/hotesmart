# Avis V5 — traduire les avis écrits dans une autre langue

**Statut : décisions de Thierry du 11 novembre 2026 (10:12 à 10:36), et du
15 novembre 2026 (Q6, 00:38, après la seconde revue) ; spec
écrite sur la branche `avis-traduction`, partie de `main` à
`f4b2597cfdf43b86025c2d75c7fe5f9d645184aa`. Aucun code avant l'accord du chef de
file sur les fichiers partagés (§9).**

## 1. Pourquoi

Les voyageurs écrivent dans leur langue. Un avis en anglais, en espagnol ou en
allemand s'affiche aujourd'hui tel quel : l'hôte doit le traduire lui-même, et la
prestataire de ménage lit un extrait qu'elle ne comprend pas toujours.

Demande de Thierry (11 novembre 2026, 10:12) : « les commentaires en langue
étrangère doivent être traduits, avec une mention qui indique lire l'original ».

## 2. Décisions

- **Q1 = B** : la traduction s'affiche **sur la page Avis** (texte public, retour
  privé, extrait de propreté) **et dans l'extrait de propreté montré à la
  prestataire** (son application).
- **Q2 = B** : on traduit **vers la langue d'affichage de la personne qui lit** —
  français, anglais ou espagnol. Un même avis peut avoir jusqu'à trois versions.
  L'application de la prestataire n'existe qu'en français : elle lit la version
  française.
- **Q3 = A** : **l'historique est traduit aussi**, une fois pour toutes
  (≈ 680 avis, coût d'IA estimé de l'ordre de 2 €).
- Par défaut, on montre **la traduction**, avec la mention « Traduit (anglais)
  · Voir l'original ». Un clic montre l'original, un second revient à la
  traduction. (La mention ne dit pas « de l'anglais » : l'article et l'élision
  changent avec chaque langue et chaque nom de langue — « du japonais », « del
  inglés » — et une règle de grammaire recopiée par langue serait fausse un jour
  sur deux.)
- **Q5 = A, le coût de l'IA** (condition du chef de file, 10:34) : voir §3.6.
- **Ce qui n'est pas une décision produit, et suit la règle du dépôt** (« donnée
  non urgente = calculée en tâche de fond, servie prête ») : la traduction est
  faite **à l'arrivée de l'avis**, gardée en base, et l'écran ne fait jamais
  attendre une traduction. Un avis pas encore traduit s'affiche dans sa langue,
  sans mention.

- **Q4 = A** : l'extrait est traduit **partout où il apparaît**, donc aussi dans
  la fiche d'un ménage de la page Ménages de l'hôte (`/menages`), dans la langue
  de l'hôte.
- **Q6 = A** (15 novembre 2026, après la seconde revue) : **l'extrait est
  traduit par un appel qui ne reçoit QUE lui**, jamais le retour privé ni le
  texte public. La prestataire ne lit que l'extrait ; traduit dans le même
  appel que le retour privé, il pouvait en porter une phrase jusqu'à elle, et
  sans l'étiquette « retour privé ». Une borne de longueur limitait la place,
  pas la provenance ; l'isolement est la seule garantie. Coût : un second appel
  pour un avis qui a un extrait (≈ 0,08 centime). Les plafonds restent comptés
  en appels (§3.6).

## 3. Ce qui change

### 3.1 Le cœur : une table de traductions, un writer unique

`avis_traductions`, une ligne par avis (clé `review_id`, clé étrangère vers
`ota_reviews.id`, suppression en cascade) :

| colonne | rôle |
|---|---|
| `review_id` | l'avis |
| `user_id` | le compte, pour le cloisonnement |
| `empreinte` | empreinte des trois textes traduits (public, privé, extrait). Un texte qui change rend la traduction **périmée** : elle n'est plus servie, et l'avis repasse dans la file |
| `textes` | par champ (`public`, `prive`, `extrait`) : la langue **source détectée** et les versions dans les langues cibles (`fr`, `en`, `es`) autres que la source |
| `traduit_le` | l'heure de la traduction |

Chaque champ a sa propre langue source : un voyageur peut écrire le public en
anglais et le privé en français. Un texte déjà dans la langue de lecture n'a
pas de version de plus, et n'affiche aucune mention.

RLS active, aucune policy : la table n'est lue et écrite que par le serveur.

Writer unique : `lib/avis/traduction.js`. **Deux appels à Haiku au plus par
avis** (Q6 = A) : l'appel A reçoit le texte public et le retour privé, JAMAIS
l'extrait ; l'appel B reçoit l'extrait SEUL, quand l'avis en a un. Chaque appel
détecte la langue de chacun de ses champs et rend les versions manquantes, en
JSON validé (langues dans `fr|en|es`, textes non vides, longueur bornée, aucun
champ qu'on ne lui a pas donné). Tout ou rien : un appel en échec fait échouer
l'avis, et l'appel B ne part pas si l'appel A a échoué. Une réponse invalide
n'écrit rien en traduction. Journal des appels IA par `avecContexteIA`, comme la
classification.

### 3.2 La file et le cron

- Est **à traduire** : un avis non masqué, qui porte au moins un texte, dont la
  ligne de traduction manque ou dont l'empreinte a changé. La file est lue par
  une fonction SQL (`avis_a_traduire(limite)`), exécutable par le seul
  `service_role`, comme `resume_bien_avis_remplacer`.
- **On attend la classification** (`ai_analyzed_at` posé) pour que l'extrait de
  propreté soit traduit dans le même appel ; un avis encore non classé après
  48 h est traduit sans attendre, pour qu'une classification en échec ne bloque
  pas la traduction.
- Tâche `traduction_avis` dans `api/cron.js`, **après** `classification_avis`,
  en **ajout seul** (le lot 2 PWA tient aussi ce fichier : aucune ligne existante
  n'est réécrite). Plafonds au §3.6. Un passage sans travail coûte deux requêtes
  et **zéro appel à l'IA**.
- **L'historique** : par `scripts/traduire-avis.js`, lancé une fois par Thierry
  après la mise en production (§3.6).

### 3.3 La page Avis

- `api/avis.js` (`cartesLister`) : la traduction est lue **dans la même
  requête** que l'avis (ressource embarquée par la clé étrangère), donc **zéro
  requête de plus**. L'écran passe sa langue (`?langue=fr|en|es`, `fr` par
  défaut) ; le serveur ne renvoie que la version de cette langue.
- `lib/avis/cartes.js` : chaque avis porte `traduction` — pour le public, le
  privé et l'extrait, la langue source et le texte traduit — ou `null` (avis
  masqué, déjà dans la langue de lecture, pas encore traduit, traduction
  périmée).
- `core/avis/cartes.js` : le texte traduit à la place de l'original, avec la
  ligne « Traduit (anglais) · Voir l'original ». **Une seule bascule par avis** :
  l'extrait, le texte public et le retour privé passent ensemble. L'original est
  dans la page, masqué : basculer ne coûte aucun appel. Le nom de la langue vient
  d'`Intl.DisplayNames` dans la langue de lecture : aucune liste de langues
  recopiée. Le rendu vit dans `shared/avis-traduction.js`, partagé avec la fiche
  ménage (§3.4).
- Changer de langue d'affichage recharge les cartes dans la nouvelle langue.

### 3.4 La fiche ménage de l'hôte (Q4)

- `api/garde.js` : le retour d'un ménage porte l'extrait traduit dans la langue
  demandée par l'écran (`?langue=`), avec sa langue source ; même lecture
  embarquée, aucune requête de plus.
- `pages/menages.html` : l'extrait traduit, avec « Traduit de l'anglais · Voir
  l'original ».

### 3.5 L'application de la prestataire

- `api/menages-public.js` : l'extrait de propreté porte sa version française
  (`extraitTraduit`) et sa langue source (`extraitLangue`) quand l'extrait
  n'est pas en français. Toujours ni le texte complet, ni le retour privé, ni le
  nom du voyageur — ni leurs traductions : seul `textes.extrait` est lu.
  ⚠ **Une lecture de plus**, ajoutée après celle des avis : le lot 2 PWA tient
  aussi ce fichier, et le chef de file l'a ouvert en **ajouts seulement**. Elle
  ne coupe rien (en échec ou avant la migration, la liste sort sans
  traduction). Une fois le lot PWA en production, elle pourra rejoindre la
  lecture des avis, comme sur la page Avis.
- `apps/menages/public.html` : l'extrait traduit, avec « Traduit (anglais) ·
  Voir l'original ». Rendu en ligne, sans module partagé : la page doit tenir
  hors ligne.

### 3.6 Le coût de l'IA (Q5 = A, décision de Thierry, 10:36)

- **Par passage de cron : 10 appels au plus**, et moins si le budget de temps du
  passage (12 s) est atteint avant. Un appel ne part qu'avant cette échéance,
  dure **20 s au plus** sans relance, et un avis ne part que si TOUS ses appels
  tiennent, chacun avec ses 20 s pleines, dans le reste du cycle moins 25 s (un
  délai raccourci couperait l'appel, payé et compté en échec — seconde revue,
  constat 4). Le plafond se compte en **appels** : un avis avec extrait en coûte
  deux, donc au pire 5 avis par passage et 50 par jour.
- **Le compte du jour est RÉSERVÉ avant le premier appel** (le lot entier), puis
  ce qui n'est pas parti est rendu ; **la tentative est notée avant chaque
  appel**. Un passage coupé par la plateforme en plein appel ne perd donc ni le
  compte ni la tentative : l'avis est écarté 24 h au lieu de repasser en tête,
  hors plafond (revue, constat 1).
- **Un avis de plus de 3 000 caractères** (public + privé + extrait) ne passe
  pas par le cron : il attend le script. **Trois échecs sur le même texte**
  sortent l'avis de la file ; un texte qui change l'y remet (revue, constat 2).
- **Par jour : 100 appels au plus**, pour toute la plateforme, soit au plus
  ≈ 0,30 € par jour (≈ 0,3 centime par avis traduit, Haiku). Le compte du jour
  vit dans `cron_logs` (`traduction_avis_jour` : jour de Paris, nombre
  d'appels) ; au plafond, la tâche s'arrête jusqu'au lendemain et le dit dans
  son bilan, sans alerte (rien n'est urgent).
- **Rien à traduire : zéro appel.** La file est lue d'abord ; l'IA n'est appelée
  que pour un avis qui en sort. Un passage sans travail coûte **deux** requêtes
  (le compte du jour, puis la file). Un texte fait seulement de blancs n'entre
  pas dans la file ; s'il y entrait, il serait écrit comme une réussite vide.
- **Un appel par avis, deux s'il a un extrait** (Q6 = A), quel que soit le
  nombre de langues ; un appel qui échoue compte quand même dans le plafond du
  jour. Trois échecs sur le même texte sortent l'avis de la file ; le compteur
  repart de zéro quand le texte change (seconde revue, constat 3).
- **L'historique** : `scripts/traduire-avis.js`, ≈ 650 avis, ≈ 650 appels de
  textes (≈ 2 €) et au plus ≈ 650 appels d'extrait (≈ 0,50 €). À blanc par
  défaut, il dit le nombre d'avis, le nombre d'appels et le coût estimé ;
  `--go` traduit, `--max N` borne le nombre d'avis (défaut et plafond : 800). Il ne
  consomme pas le plafond du jour du cron. Il prend aussi les avis longs et
  ceux qui ont échoué trois fois : c'est une relance volontaire. Lancé par Thierry, une fois, après
  la mise en production.
- Chaque appel est journalisé par `avecContexteIA` (bien, séjour, tâche), comme
  la classification.

## 4. Inventaire (règle « la forme ne supprime jamais le fond »)

Rien n'est retiré. L'original reste à un clic partout. L'extrait de propreté, le
classement, le pouce de la prestataire, la note, notre avis et le retour privé
ne changent pas : la traduction n'entre dans aucun calcul (la classification
continue de lire l'original). Notre propre avis sur le voyageur n'est pas
traduit : c'est l'hôte qui l'écrit.

## 5. Case « performance » (règle du dépôt, huit points)

1. Un écran = un endpoint : inchangé (`/api/ecran/avis`, `/api/garde`,
   `/api/menages-public`), la traduction arrive dans la même réponse. Page Avis
   et fiche ménage : **zéro requête de plus** (lecture embarquée). Application
   de la prestataire : **une requête de plus**, et seulement quand elle a des
   avis avec extrait (§3.5).
2. Donnée non urgente pré-calculée : oui, c'est l'objet de la tâche de fond.
   **La page Avis, la fiche ménage de l'hôte et l'application de la prestataire
   lisent une traduction déjà calculée, jamais traduite à l'ouverture**
   (condition du chef de file). Un test le garde : aucun des trois endpoints
   n'appelle l'IA.
3. Cache navigateur : sans objet, les cartes ne sont pas mises en cache (seuls
   les chiffres le sont).
4. `private, no-store` : inchangé, test existant.
5. Fichiers statiques : sans objet (clés ajoutées aux fichiers i18n versionnés).
6. Lectures tronquées : la file est bornée par sa limite, et la lecture de
   l'écran embarque une ligne par avis déjà servi (pas de lecture de plus).
7. Budget : `tests/budget-ecran.test.js` inchangé ; `Server-Timing` doit rester à
   **10 requêtes**.
8. Mesure AVANT (production, compte de Thierry, 11 novembre 2026, 10:05) :
   1 appel, 10 requêtes, 463 à 649 ms côté serveur, 35 468 octets. Attendu
   APRÈS : 10 requêtes, octets en hausse de la seule longueur des traductions
   servies.

## 6. Tests attendus

- le writer : une réponse valide écrit une ligne ; une réponse invalide (JSON
  cassé, langue inconnue, texte vide, champ inventé) n'écrit rien ; un texte
  déjà en français n'a pas de version française ;
- l'empreinte : un texte modifié rend la traduction périmée, elle n'est plus
  servie, et l'avis repasse dans la file ;
- la file : avis masqué exclu, avis non classé attendu puis traduit après 48 h,
  compte cloisonné ;
- l'écran : la langue demandée est servie, une langue inconnue retombe sur `fr`,
  un avis masqué ne sort aucune traduction, le compte de requêtes ne bouge pas ;
- la carte : texte traduit et mention, bascule vers l'original et retour ;
- la prestataire : extrait traduit et mention ; ni texte complet ni retour
  privé dans la réponse ;
- chaque test neuf rougit contre le code d'avant ; balayage à horloge décalée
  (J+4, J+60, J+200).

## 7. Mise en production

Migration sur staging, recette (un avis de recette en anglais), migration en
production, merge par le chef de file sur le go de Thierry. L'historique se
traduit ensuite : par le cron, ou par le script si Thierry veut aller plus vite.

## 8. Dépendances

Partie de `main` (`f4b2597c`), qui contient `avis-v5-resume` et
`avis-retour-prive`. Aucune autre branche requise.

## 9. Fichiers, à confirmer avec le chef de file

Neufs : `migrations/2026-11-11-avis-traductions.sql`, `lib/avis/traduction.js`,
`lib/cron-traduction-avis.js`, `scripts/traduire-avis.js`, tests.
Partagés : `api/cron.js` (une tâche), `api/avis.js`, `lib/avis/cartes.js`,
`core/avis/cartes.js`, `api/menages-public.js`, `apps/menages/public.html`,
`shared/ui.css` (bloc de la page Avis seulement), `shared/i18n/*.json` (ajouts de
clés seulement), `pages/avis.html` (passage de la langue), `api/garde.js` et
`pages/menages.html` (Q4).

## 10. Revues

Consigne commune du chef de file : les rapports sont recopiés tels quels, sans
tableau résumé.

### 10.1 Première revue (12 novembre 2026)

Agent distinct ; arbre `/home/claude/hotesmart-avis-trad`, branche
`avis-traduction`, plage
`f4b2597cfdf43b86025c2d75c7fe5f9d645184aa..e413390f5b10be57c0826445786fb8fe31f05763`.
Rapport recopié tel quel :

> Arbre lu : `/home/claude/hotesmart-avis-trad` · branche `avis-traduction` · tête `e413390f5b10be57c0826445786fb8fe31f05763`. J'ai relu la plage `f4b2597c…e413390f`. L'arbre est propre à la fin : `git status --short` ne montre que `?? node_modules`.
>
> **Aucun constat de sécurité.** Aucune donnée ne sort vers un autre compte, un membre hors de ses biens, la prestataire ou un avis masqué. Le seul point de vie privée (n° 3) est un risque lié au modèle, pas une fuite démontrée dans le code.
>
> Ce que j'ai vérifié et qui est juste :
> - **Empreinte :** sur un vrai Postgres 16 lancé dans /tmp, la migration s'applique, et les empreintes SQL et JS sont identiques sur des cas piégeux (`''`, `null`, `\n`, texte unicode).
> - **File SQL :** un échec est écarté 24 h, une réussite sort de la file, un texte modifié y revient, un appel par `authenticated` est refusé (« permission denied »).
> - **Avis masqué :** la règle SQL est la même que `estMasque`.
> - **XSS :** tout est échappé dans les trois écrans.
> - **Ajouts seulement :** `api/cron.js` (+22/−0) et `api/menages-public.js` (+43/−0).
> - **Tests :** `npm test` donne 8327/8327. Les tests du lot ont zéro rouge à J+4, J+60 et J+200. `i18n-check` est vert.
>
> **1. Défaut (coût et cycle du cron)** — `lib/cron-traduction-avis.js:88-116`, `lib/avis/traduction.js:136-142`
> - **Ce qui se passe :** le budget de 12 s n'est vérifié qu'avant chaque appel ; rien n'arrête un appel déjà parti. Il n'y a ni `timeout` ni `maxRetries` sur `messages.create`, et `max_tokens` monte jusqu'à 4000, soit 20 à 40 s de génération (estimation, non mesurée). Le compte du jour (`finally`) et l'échec (`ecrireResultat`) ne s'écrivent qu'**après** l'appel.
> - **Conséquence :** si Vercel coupe la fonction à 60 s, l'appel payé n'est ni compté ni noté. Le même avis repasse en tête au passage suivant, **hors du plafond de 100 par jour**, et le dispatch (messages aux voyageurs) de ce passage ne tourne pas.
> - **Établi par :** lecture, plus un script hors de l'arbre avec un traducteur injecté qui dure 40 s. L'appel part avec 30 s restantes, rien n'est écrit pendant l'appel, et le passage dure 40 s.
> - **Correction :** réserver le compte du jour **avant** chaque appel ; poser `echec_le` et `echec_empreinte` **avant** l'appel, comme une tentative ; passer `{ timeout: min(échéance restante, resteMs() − RESTE_MIN_MS), maxRetries: 0 }` en second argument de `messages.create` ; dans le cron, écarter les avis longs et les laisser au script.
>
> **2. Défaut (coût)** — `lib/avis/traduction.js:140`, migration lignes 137-141
> - **Ce qui se passe :** la formule `300 + 1,5 × caractères` est trop courte pour certains avis, et la réponse est alors toujours coupée : 400 caractères chinois donnent `max_tokens` = 900, alors que les trois traductions font environ 1 200 à 1 400 tokens ; un avis public plus privé de plus de ~5 000 caractères en allemand dépasse 4000 tokens.
> - **Conséquence :** `json_illisible` à chaque essai. La colonne `echecs` n'arrête jamais rien, donc l'avis n'est jamais traduit et repasse chaque jour au coût maximal. Aucun test de `stop_reason` ne signale la coupure.
> - **Établi par :** lecture et calcul, non mesuré.
> - **Correction :** calculer `max_tokens` sur la sortie attendue (trois versions) ; noter un motif `reponse_tronquee` quand `stop_reason === 'max_tokens'` ; exclure de la file au-delà de 3 échecs, ou espacer les essais.
>
> **3. Défaut (vie privée, défense en profondeur)** — `lib/avis/traduction.js:110`, montré par `api/menages-public.js:1083-1123`
> - **Ce qui se passe :** la traduction de l'extrait est produite dans le même appel que le retour privé, sans aucun contrôle comparable à `extraitVerifie`. La borne autorise `4 × longueur + 400` caractères : un extrait de 30 caractères peut ressortir avec 520 caractères, assez pour une phrase complète du retour privé, que la prestataire lirait par défaut.
> - **Établi par :** lecture.
> - **Correction :** pour le champ `extrait`, une borne serrée (par exemple `2 × longueur + 40`).
>
> **4. Mineur (justesse)** — `lib/avis/traduction.js:56` — un texte de plus de 4000 caractères est coupé avant l'envoi. Sa traduction partielle s'affiche pourtant à la place de l'original complet, sans rien le signaler. **Correction :** ne pas servir de traduction pour un champ tronqué, ou marquer la troncature.
>
> **5. Mineur** — migration lignes 125-127 contre `champsDe` — en SQL, `btrim` n'enlève que les espaces ; en JS, `trim` enlève aussi les retours à la ligne et les tabulations. Un retour privé qui ne contient que `"\t\n"` entre dans la file, rend `rien_a_traduire`, est noté en échec, et revient toutes les 24 h pour toujours. Cela ne déclenche aucun appel à l'IA, mais prend une place dans la file. **Établi par :** exécution sur Postgres. **Correction :** écrire une réussite avec `textes: {}` pour `rien_a_traduire`, ou tester `~ '\S'` en SQL.
>
> **6. Mineur** — `api/avis.js:715`, `api/garde.js:435`, `api/menages-public.js:1106` — le repli sur PGRST200 est silencieux. Si PostgREST ne voit jamais la relation (cache de schéma non rechargé, ou table cachée par le `revoke`), aucune traduction ne s'affiche, rien n'est journalisé, et chaque page paie une requête de plus. **Correction :** journaliser le repli une fois. À la recette, vérifier que `Server-Timing` reste à **10** requêtes (et non 11) et que la traduction s'affiche.
>
> **7. Mineur (tests qui passent contre le code d'avant)** — établi par contre-épreuve `git archive` de la base hors de l'arbre, avec les tests neufs. Tous restent verts sur le code d'avant : `tests/menages-public-avis.test.js:677` (traduction périmée), `tests/menages-public-avis.test.js:685` (panne, avant la migration), `tests/menages-public-vue-avis.test.js:976` (extrait hostile échappé), `tests/avis-cartes-dom.test.js:504` (XSS). **Correction :** affirmer en plus que la lecture `avis_traductions` a bien été tentée (journal), ou que le texte traduit est rendu.
>
> **8. Mineur (doc et performance)** — `lib/cron-traduction-avis.js:54-74` — un passage sans travail coûte 2 requêtes (compte du jour puis file), pas 1 comme l'écrit la spec §3.2. La file calcule un md5 sur tous les avis de la plateforme toutes les 5 minutes : négligeable aujourd'hui, mais cela grandit avec le nombre d'avis. **Correction :** corriger la spec.

Suites, dans `0ea0a2816daad54e5228c9910a54842af5ce8e7f` : constats 1, 2, 4, 5, 6, 7 et
8 corrigés comme proposé ; constat 3 corrigé par la borne serrée — reclassé
SÉCURITÉ par le chef de file, d'où la seconde revue.

### 10.2 Seconde et dernière revue (15 novembre 2026), limitée aux correctifs

Agent distinct ; arbre `/home/claude/hotesmart-avis-trad`, branche
`avis-traduction`, plage
`e413390f5b10be57c0826445786fb8fe31f05763..0ea0a2816daad54e5228c9910a54842af5ce8e7f`.
Question posée par le chef de file : la borne suffit-elle, ou faut-il que ce
que lit la prestataire soit produit par un appel qui ne voit jamais le retour
privé ? Rapport recopié tel quel :

> **Arbre lu :** `/home/claude/hotesmart-avis-trad`
> **Branche :** `avis-traduction`
> **SHA de tête lu :** `0ea0a2816daad54e5228c9910a54842af5ce8e7f`
> **Plage :** `e413390f5b10be57c0826445786fb8fe31f05763..0ea0a2816daad54e5228c9910a54842af5ce8e7f` (14 fichiers)
>
> Hors de l'arbre, je n'ai lu que le SDK Anthropic (0.86.1). Le `node_modules` de l'arbre est un lien vers celui d'un autre worktree. Aucun fichier du lot n'a été lu ailleurs. J'ai vérifié le SQL sur un Postgres 16 jetable dans `/tmp`, arrêté et supprimé ensuite. `git status --short` rend seulement `?? node_modules`. Les six fichiers de tests de la plage passent : 196 sur 196.
>
> **Question prioritaire : il faut séparer**
>
> La borne limite la **longueur** de la traduction de l'extrait. Elle ne limite pas sa **provenance**. Avec un extrait de 27 caractères, elle autorise 94 caractères par langue, donc 67 de plus : la place d'une phrase entière. J'ai rejoué deux cas avec `lireReponse` puis `traductionPour`, sans rien écrire :
> - **Ajout.** Extrait : « The bathroom was not clean. » Traduction rendue : « Salle de bain sale ; la femme de ménage a été impolie. » (54 caractères). Elle est acceptée (`ok: true`).
> - **Champs inversés** entre `prive` et `extrait`, une erreur classique de sortie structurée. Le retour privé fait 69 caractères, sous la borne de 94 : acceptés. `traductionPour(…, 'fr').extrait` rend alors la phrase du retour privé, et `api/menages-public.js:1124` la sert à la prestataire.
>
> **Ce qui aggrave.** L'étiquette « retour privé » se calcule sur l'extrait **original** (`extraitEstPrive`, `api/menages-public.js:1073`). Ici l'extrait vient du texte public, donc `prive: false`. La prestataire lit une phrase privée **sans l'étiquette**, exactement le cas que cette étiquette existe pour empêcher.
>
> **La norme du dépôt est une garantie par construction.** L'extrait original est une portion vérifiée du texte (`extraitVerifie`). Une traduction ne peut pas être vérifiée comme une citation. La seule garantie équivalente est l'isolement : un appel ne peut pas rendre ce qu'il n'a pas reçu. La borne a en plus un coût : elle refuse des traductions fidèles (constat 2).
>
> **La forme la plus simple :**
> - **Appel A** : `{public, prive}`, sans jamais l'extrait.
> - **Appel B** : `{extrait}` seul, uniquement si l'avis a un extrait. Même prompt, même validation, avec la borne ordinaire (4 × longueur + 400). La borne serrée disparaît.
> - Les textes sont fusionnés (`{...A, ...B}`) : une seule écriture, une seule empreinte. Un échec de l'un est un échec de l'avis, avec une tentative et un compteur, comme aujourd'hui.
> - `traduireLigne` rend `appels: 0|1|2` au lieu de `appel: true/false`. Le nombre d'appels d'une ligne se connaît avant l'appel, par `champsDe`. Le cron réserve donc la somme des appels prévus, et s'arrête avant une ligne qui ferait dépasser 10 dans le passage ou 100 dans la journée. Le délai se recalcule avant l'appel B.
> - **Effet sur le plafond.** Les plafonds restent comptés en appels (10 par passage, 100 par jour). Un avis avec extrait coûte 2 appels, donc 5 à 10 avis par passage et 50 à 100 par jour. C'est sans effet pratique au rythme d'arrivée actuel, quelques avis par jour.
> - **Effet sur le coût.** L'appel B fait environ 300 tokens en entrée et 100 en sortie, soit environ 0,08 centime. Pour l'historique : au plus +650 appels, environ +0,5 € au pire. Le mode à blanc du script doit alors compter des appels, plus des avis.
> - **Décision à Thierry.** Cela modifie la décision Q5 = A (« un appel par avis »).
> - **Variante écartée** : séparer seulement quand un retour privé existe. Elle laisse le texte public complet passer par la traduction de l'extrait, et la règle ne se dit plus en une phrase.
>
> **1. SÉCURITÉ** — `lib/avis/traduction.js:126` — la borne 2 × longueur + 40 laisse passer une phrase du retour privé jusqu'à la prestataire, par ajout ou par inversion des champs, et sans l'étiquette. **Établi par :** les deux rejeux ci-dessus. Le test `tests/avis-traduction.test.js:130` ne vérifie qu'un ajout de 97 caractères sur un extrait de 10, très au-delà de la borne. Il ne voit donc aucun des deux cas. **Correction :** la séparation décrite plus haut. Ajouter un test espion sur `messages.create` : le prompt de l'appel qui produit `textes.extrait` ne contient ni le texte privé ni le texte public. Ce test doit rougir contre le code actuel.
>
> **2. Défaut** — `lib/avis/traduction.js:126` — la même borne refuse des traductions fidèles depuis les écritures à idéogrammes. Un extrait chinois de 26 caractères donne 110 caractères en français, 101 en anglais et 101 en espagnol, pour une borne de 92. Le motif est `traduction_trop_longue`, et c'est la réponse **entière** qui est refusée, texte public compris. Après trois échecs, l'avis sort de la file du cron. **Établi par :** un appel à `lireReponse` avec cette réponse. **Correction :** disparaît avec la séparation.
>
> **3. Défaut** — `migrations/2026-11-11-avis-traductions.sql:142` et `lib/avis/traduction.js:180` — le compteur d'échecs ne repart pas à zéro quand le texte change. Un avis à 3 échecs sur l'ancien texte revient dans la file avec `echecs = 3`. La tentative écrit alors 4 avec la nouvelle empreinte, et l'avis est exclu **après un seul échec** sur le nouveau texte. La spec §3.6 dit trois échecs par texte. **Établi par :** le scénario rejoué sur Postgres 16. **Correction :** dans le SQL, rendre `case when t.echec_empreinte = e.empreinte then t.echecs else 0 end`.
>
> **4. Défaut (coût)** — `lib/cron-traduction-avis.js:128-129` — le délai d'un appel vaut min(20 s, reste − 25 s), soit min(20 s, 30 s − temps déjà écoulé du cycle), puisque `api/cron.js` passe `55000 − chrono.total()`. Le test du lot montre lui-même un appel lancé avec 6 s. Un appel coupé par **notre** délai compte comme un refus du modèle : un échec de plus, et probablement payé. Un avis moyen ou long, traité tard dans le cycle, peut être coupé trois fois. Il quitte alors la file du cron sans aucune alerte (seulement un `console.warn`), jusqu'à une relance manuelle du script. La limite de 3 000 caractères pour 20 s n'est pas mesurée. **Réponse au brief :** un avis **jamais tenté** n'est pas pénalisé. La tentative est notée juste avant son propre appel, et un test le garde. Le problème concerne les avis tentés avec un délai trop court. **Correction :** ne lancer un appel que si les 20 s tiennent (`resteMs() − RESTE_MIN_MS ≥ TIMEOUT_APPEL_MS`), ou ne pas compter un dépassement de délai dans les trois échecs. Mesurer `ia_appels.duree_ms` à la recette sur un avis de 3 000 caractères.
>
> **5. Mineur** — `lib/cron-traduction-avis.js:76` — la garde d'entrée demande 25 s, mais un appel en demande 28. Entre 25 et 28 s, le passage fait trois requêtes (file, réservation, restitution) pour zéro appel. Le test du lot le montre : marqueurs `[2, 0]`. **Correction :** garde à `RESTE_MIN_MS + TIMEOUT_MIN_MS`, ou `+ TIMEOUT_APPEL_MS` si le constat 4 est corrigé ainsi.
>
> **6. Mineur** — `lib/cron-traduction-avis.js:139-140` et `scripts/traduire-avis.js:102` — « rien à traduire » rend maintenant `ok: true`, donc les deux bilans le comptent comme « traduit ». **Correction :** un compte séparé, par exemple `vides`.
>
> **7. Mineur, conditionnel** — `migrations/2026-11-11-avis-traductions.sql:80` — la fonction passe de 3 à 5 paramètres. Sur une base où l'ancienne version a déjà été appliquée, `create or replace` ajoute une seconde fonction au lieu de remplacer la première. **Établi par :** ancienne puis nouvelle migration appliquées sur Postgres 16 : deux fonctions coexistent. **Correction :** rien à faire si la migration n'a jamais été appliquée, staging compris. Sinon, ajouter `drop function if exists public.avis_a_traduire(integer, timestamptz, timestamptz);`.
>
> **Vérifié juste, sans constat**
> - **Réservation et restitution du compte du jour.** Le lot est réservé avant le premier appel. Si l'écriture échoue, aucun appel ne part. Le `finally` remet le compte exact dans tous les cas où il s'exécute : budget atteint, tentative non écrite, exception. Si la plateforme coupe la fonction, le compte reste surestimé d'au plus 9 appels pour la journée : c'est le sens prudent voulu.
> - **Tentative notée avant l'appel.** Une réussite l'efface, un échec la laisse.
> - **`timeout` et `maxRetries`.** L'enveloppe de `lib/ia/journal.js` transmet bien le second argument (`...args`), et le SDK 0.86.1 l'applique après sa valeur par défaut. La garde « non-streaming » du SDK s'exécute toujours sur `max_tokens` : elle passe avec 16 000 et refuserait au-delà d'environ 21 333.
> - **File SQL (Postgres 16, `C.UTF-8`).** `~ '\S'` écarte un retour privé fait seulement de tabulations. Un texte fait seulement d'espaces insécables entre dans la file. Le JS le traite comme « rien à traduire » et écrit une réussite vide (`textes = {}`), que la contrainte accepte : le repli prévu fonctionne. `p_longueur_max` à 3 000 écarte un avis de 3 001 caractères ; à `null` (script), il l'accepte. `p_echecs_max` à 3 écarte un avis à 3 échecs ; à `null` (script), il l'accepte. Un échec écrit pendant le lancement du script reste écarté par `p_echec_avant`.
> - **Constats 4, 6 et 7 de la première revue** (champ trop long laissé en original, repli journalisé une fois, tests) : correctifs justes.
>
> **Il reste un constat de sécurité : le constat 1.**

Suites (règle du lot : ce que trouve la seconde revue se corrige sans nouvelle
revue) :
- **Constat 1 (SÉCURITÉ)** : décision de Thierry du 15 novembre 2026, Q6 = A —
  la séparation, dans la forme proposée. L'extrait est traduit par un appel qui
  ne reçoit que lui ; chaque appel ne peut rendre que ses champs. Test espion
  sur `messages.create` (le prompt de l'appel de l'extrait ne contient ni le
  retour privé ni le texte public) et test d'inversion de champs : les deux
  rougissent contre `0ea0a281` (contre-épreuve par `git archive`).
- **Constat 2** : la borne serrée disparaît ; un extrait en idéogrammes
  fidèlement traduit est accepté (test).
- **Constat 3** : le compteur rendu par la file vaut 0 quand le texte a changé.
- **Constat 4** : un avis ne part que si tous ses appels tiennent avec leurs
  20 s pleines (`resteMs() − 25 s ≥ 20 s × appels`) ; plus aucun délai raccourci.
- **Constat 5** : la garde d'entrée demande `25 s + 20 s` avant de lire la file.
- **Constat 6** : `vides` compté à part, dans le cron et dans le script.
- **Constat 7** : `drop function if exists` de la forme à 3 paramètres, avant la
  création (la migration n'a été appliquée nulle part, staging compris).
