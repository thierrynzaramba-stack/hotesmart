# Reviews — dette 129 (demandes Airbnb dans Messages)

## Lot 1, étape 0 — review 1 (22 novembre 2026), rapport tel que rendu

Plage relue : `53f0ed431dc762ada95aeb61e87439cb71949577..8874d695b78ae65ea9b5cf7c1c4cc88adefcbe36`,
branche `dette-129-sans-resa`, arbre `/home/claude/hotesmart-dette129`.

---

**Review de la plage `53f0ed43..8874d695`, branche `dette-129-sans-resa`**

Arbre lu : `/home/claude/hotesmart-dette129`. Tête lue : `8874d695b78ae65ea9b5cf7c1c4cc88adefcbe36`. La plage contient un seul commit, qui touche quatre fichiers : `api/diagnostic.js`, `lib/channels/channex.js`, `lib/demandes/mesure.js` et `tests/demandes-mesure.test.js`.

J'ai lancé `tests/demandes-mesure.test.js` : 16 sur 16 au vert. J'ai aussi lancé les 20 fichiers de tests qui touchent `api/diagnostic` ou `lib/channels/channex` : 378 sur 378 au vert.

**Conclusion : aucun constat de sécurité bloquant.** La garde est correcte. J'ai trouvé deux points à durcir (S1, S2), quatre problèmes mineurs de justesse de la mesure, et quatre tests qui passeraient contre un code faux.

### Ce qui a été vérifié et qui est juste

- **La garde.** `requirePermission` (`lib/require-permission.js:48-91`) retrouve le bien en base, par son UUID, son `provider_property_id` ou son `migration_target_property_id`.
  - `garde.bien.user_id` est bien `properties.user_id`, c'est-à-dire le compte propriétaire.
  - Le périmètre `messages:read` est vérifié avant toute lecture du cœur et tout appel à Channex (404, 403, 409 ou 503 sinon).
  - Ensuite, le code n'utilise plus que `bien.user_id` et `bien.provider_property_id`, jamais la valeur envoyée par le client.
- **L'en-tête `private, no-store`** est posé à la toute première ligne de `requirePermission` (l.249), donc avant tout refus de cette branche.
- **Aucun texte de message dans la réponse.** Seul `titre` sort, c'est-à-dire le nom du voyageur.
- **Aucune écriture par l'endpoint.** Seule exception, déjà existante : `channelCall` enregistre les réponses mal formées du partenaire dans `reponses_partenaire_invalides`.
- **Lecture du cœur par curseur** sur `id` (de type uuid), même convention que le reste du dépôt.
- **Comparaison des instants** par `Date.parse`. V8 lit bien les microsecondes de Postgres (mesuré : `…17.123456+00:00` donne 123 ms). C'est la même règle à la milliseconde que `instantDe` dans `recordMessage`.
- **Pagination chez Channex** : l'arrêt sur page vide est correct, et une page qui recommence par le même premier élément est bien détectée comme pagination ignorée.

### Constats

**S1. `lib/channels/channex.js:1004-1024`, sécurité (durcissement, fuite non démontrée).**
- **Le problème.** `listerFils` fait confiance au filtre `filter[property_id]` sans vérifier, fil par fil, que `relationships.property.data.id === propId`. Or la clé Channex est globale (marque blanche), et ce filtre ne figure pas dans la page « messages collection » de la doc Channex.
- **Le scénario.** Si le filtre était ignoré un jour, la réponse renverrait la liste des fils et le nom du voyageur de tous les clients à n'importe quel membre qui a `messages:read` sur un seul bien Channex.
- **Ce qui rassure.** `importMessages` repose sur la même hypothèse, son commentaire (l.399-400) dit que le filtre a été validé une fois par capture, et les données de production sont bien séparées par bien.
- **Le correctif.** Une ligne : écarter les fils d'un autre bien et les compter.

**S2. `api/diagnostic.js:229-232`, sécurité et coût (mineur).**
- **Le problème.** Avec le domaine `messages:read`, tout membre délégué peut déclencher jusqu'à environ 50 + 60 × 20 appels sur la clé partagée par tous les clients. Les appels partent cinq à la fois, avec relance automatique sur 429 et 5xx, et sans limite de fréquence.
- **Le correctif.** C'est un outil de mesure pour l'étape 0 : le réserver au titulaire, ou au fondateur comme `cron_stats`.

**J1. `lib/demandes/mesure.js:85-88`, justesse (mineur).**
- **Le problème.** La jumelle d'une copie webhook n'est cherchée que parmi les lignes sans réservation. Or l'étape 3 de la spec retire la copie webhook dès que la copie import existe, avec ou sans réservation.
- **Le scénario.**
  - 10:00 : message de demande, la copie webhook arrive avec `booking_id` nul.
  - 10:05 : le voyageur réserve.
  - 10:10 : `cron-messages` importe le fil avec le `booking_id` B.
  - Résultat : la copie import n'est jamais lue, et la copie webhook est comptée comme orpheline. La mesure gonfle donc le nombre d'orphelines par rapport à ce que fera le rattrapage.

**J2. `lib/channels/channex.js:1022`, justesse (mineur, risque faible).**
- **Le problème.** `derniere` vaut `last_message_received_at || updated_at` : il préfère le premier même quand `updated_at` est plus récent. La doc Channex dit seulement « when last message was received », sans préciser si les messages de l'hôte comptent. Le filtre par date (`mesure.js:33-34`) n'est juste que si `derniere` est postérieur à tous les messages du fil.
- **En pratique.** Une demande a toujours une ligne du voyageur sans réservation dans le cœur, ce qui place `plusAncien` avant `derniere`. Il faut un cas artificiel pour écarter un fil à tort (seules des lignes de l'hôte sans réservation).
- **Le correctif.** Prendre le maximum de `last_message_received_at`, `updated_at` et `last_message.inserted_at`.

**J3. `lib/demandes/mesure.js:76-78`, justesse (mineur).**
- **Le problème.** Une demande dont le détail a échoué ou est incomplet renvoie `messages_channex: d.ids.length`, et `lu: true` dès que `d.ok` est vrai, même si `complet` est faux.
- **Le scénario.** Une erreur 500 sur la page 1 après quatre relances donne `messages_channex: 0, chez_nous_sans_resa: 0`, alors que la liste annonce 7 messages.
- **Le correctif.** `lu = d.ok && d.complet`, repli sur `nbMessages`, et `chez_nous_sans_resa` à `null` si le détail est incomplet.

**J4. `lib/channels/channex.js:998-1046`, justesse (mineur).**
- **Le problème.** Aucun dédoublonnage par identifiant. Selon la doc, Channex trie par `inserted_at` décroissant.
- **Le scénario.** Un fil, ou un message, créé entre deux lectures de pages décale toute la liste d'un cran. La page 2 commence alors par l'ancien dernier élément de la page 1 : il est compté deux fois (dans le total, dans la liste des demandes, dans `messages_channex`), et la garde « même premier élément » ne le voit pas.
- **Le correctif.** Un `Set` sur les identifiants.

**C1. `api/diagnostic.js:273-279`, durée (mineur).**
- **Le problème.** Aucune échéance interne.
  - Chaque fil coûte au moins deux appels, à cause de l'arrêt sur page vide. Le champ `meta.total` existe selon la doc et permettrait d'éviter cet appel en plus.
  - `channelCall` relance les 429 et 5xx avec des attentes de 1 + 2 + 4 + 8 s.
  - `api/diagnostic.js` n'a pas de `maxDuration` dans `vercel.json` ; le commentaire de `channex.js:29` parle de 15 s.
- **Le scénario.** Une seule série de 429 suffit pour finir en `FUNCTION_INVOCATION_TIMEOUT` avec un corps vide. C'est exactement ce que l'en-tête du fichier (l.38-45) interdit.
- **Le correctif.** Un budget fixe (par exemple 10 s), puis une réponse marquée `interrompu`.
- **Au passage.** La recherche de jumelles est quadratique, avec deux `Date.parse` par paire. C'est négligeable aujourd'hui (environ 30 lignes par bien), mais de l'ordre de 10⁸ comparaisons à 20 000 lignes. Une `Map` sur la clé direction + instant + texte suffit.

**M1. `api/diagnostic.js:236`, marque blanche (mineur).** Le message d'erreur dit « n'est pas relié par Channex » et révèle le partenaire ; le reste du fichier dit « gestionnaire de canaux ». Et l.235 et 240 écrivent `'channex'` en dur, contrairement à REVIEW.md §6. Correctif : `getProvider(bien.provider)`, puis vérifier que `typeof provider.listerFils === 'function'`.

**M2. `api/diagnostic.js:231`, en-tête (mineur, défaut déjà présent dans `channel_detail`).** Avec `?property_id=a&property_id=b`, `.trim` plante sur un tableau avant l'appel de la garde. La réponse 500 part alors sans `private, no-store`. Elle ne contient aucune donnée.

**Lecture du cœur (`api/diagnostic.js:270`).** Le minimum `plusAncien` calculé par comparaison de chaînes est juste tant que PostgREST rend tout au format homogène `+00:00`. C'est fragile et `Date.parse` serait plus sûr, mais sans défaut aujourd'hui.

### Tests qui passeraient contre un code faux

Raisonné à la lecture, pas mesuré : la consigne était de rester en lecture seule. La contre-épreuve « contre le code d'avant » est triviale ici (module, fonctions et `check` absents), donc elle ne prouve rien.

- **T1. `tests/demandes-mesure.test.js:178-190`.** Le titre dit « jusqu'à la page vide », mais le test ne compte pas les appels. Une version qui s'arrête sur la page courte (2 messages sur 100) et rend `complet: true` passe. Et la détection « pagination ignorée » d'`idsDesMessagesDuFil` (l.1041-1043) n'a aucun test : la retirer reste vert.
- **T2. Tests de l'endpoint (l.202, 293-301).** `property_id` vaut `'P'`, la même valeur que `BIEN.provider_property_id`. Un mutant qui lirait `req.query.property_id` dans `.eq('property_id', …)` ou dans `listerFils` reste vert, d'autant que le double de `listerFils` ignore ses arguments (l.245). Correctif : un UUID dans la requête, un `provider_property_id` différent, et vérifier les arguments reçus par `listerFils`.
- **T3. L.318.** Le branchement de `depuis` dans l'endpoint n'est pas testé : `candidats: 2` reste vrai avec `depuis: null`, avec un minimum comme avec un maximum. Il manque un fil avec réservation, ancien, qui doit être écarté, et des `sent_at` différents.
- **T4. L.233-236, règle 22 de REVIEW.md.** Le double de Supabase enregistre les filtres `eq` et `is` sans les appliquer. C'est atténué parce que l.301-302 vérifient les filtres à l'identique, mais il n'y a pas de contre-contrôle : aucune ligne d'un autre compte, d'un autre bien ou avec réservation qui devrait être absente du compte.
- **Chemins sans test** : le 502 (liste illisible chez le partenaire), le 503 (lecture du cœur impossible), un détail en échec, et le plafond de 60 fils au niveau de l'endpoint.

Source : [doc Channex, messages collection](https://docs.channex.io/api-v.1-documentation/messages-collection). On y lit les attributs d'un fil, la définition de `last_message_received_at`, le tri par `inserted_at` décroissant et la présence de `meta.total` ; `filter[property_id]` n'y est pas documenté.

### Suite donnée à la review 1 (étape 0)

Aucun constat de sécurité bloquant : pas de seconde review (règle « une review par commit »).

| constat | suite |
|---|---|
| S1 | corrigé : un fil qui désigne un autre bien est écarté et compté (`fils_d_autres_biens_ecartes`). |
| S2 | corrigé : contrôle réservé au fondateur, même porte que `cron_stats`, cause du refus dite. |
| J1 | corrigé : les copies import AVEC réservation aux instants des copies webhook sont lues (même compte, même bien) ; `dont_jumelle_avec_resa`. |
| J2 | corrigé : dernier mouvement = le plus récent des trois instants du fil. |
| J3 | corrigé : « lu » = lu en entier ; incomplet → compte du listing, cœur `null`. |
| J4 | corrigé : un identifiant ne se compte qu'une fois, dans les deux lecteurs. |
| C1 | corrigé : échéance absolue de 10 s, transmise aux lecteurs ; `interrompu` dans la réponse. Jumelles par clé (Set), plus de double boucle. |
| M1 | corrigé : provider du bien via `getProvider(bien.provider)`, message sans nom de partenaire. |
| M2 | corrigé dans `demandes` (première valeur) ; `channel_detail`, défaut antérieur, laissé tel quel. |
| `plusAncien` | corrigé : calculé en instants (`Date.parse`). |
| T1 à T4 et chemins sans test | tests ajoutés ou resserrés ; contre-épreuve par mutation : 9 mutants tués sur 10, le survivant (retirer le filtre `booking_id` de la lecture des jumelles) est équivalent — une ligne import sans réservation est déjà reconnue par la première clé. |

## Lot 1, étape 0 — review 2 (22 novembre 2026), sur les correctifs de sécurité S1 et S2

Demandée par le chef de file : S1 et S2 sont classés sécurité, leurs correctifs se relisent une fois.
Plage relue : `8874d695b78ae65ea9b5cf7c1c4cc88adefcbe36..779a6439188cf126586d3824ed6f7d243f845e68`,
portée `api/diagnostic.js` et `lib/channels/channex.js`. C'est la dernière review de ce commit :
ce qu'elle trouve se corrige sans nouvelle review. Rapport tel que rendu :

---

Arbre lu : `/home/claude/hotesmart-dette129`, branche `dette-129-sans-resa`. Tête lue : `779a6439188cf126586d3824ed6f7d243f845e68`. Plage : `8874d695..779a6439`, un seul commit. Le diff relu porte sur `api/diagnostic.js` et `lib/channels/channex.js`. J'ai lu aussi `lib/require-permission.js`, `lib/channels/index.js`, `lib/demandes/mesure.js` et `vercel.json` pour comprendre.

Je n'ai rien modifié (`git status` est propre). `node --test tests/demandes-mesure.test.js` donne **31 sur 31 au vert**. J'ai aussi fait deux vérifications en mémoire avec `node -e`, avec un `fetch` simulé : aucun fichier écrit, aucun appel réseau.

### 1. Le 403 « fondateur » tombe-t-il avant tout appel au partenaire et avant toute lecture du cœur ? OUI

Ordre réel dans `api/diagnostic.js` :
- l.232-236 : la garde `requirePermission`.
- l.241-243 : refus 403 si `FOUNDER_EMAIL` est absent.
- l.244-246 : refus 403 si l'e-mail n'est pas celui du fondateur.
- Seulement ensuite : `getProvider` (l.253), la première lecture de `messages` (l.270), les jumelles (l.293) et le premier appel au partenaire (l.309).

`garde.email` existe bien. Dans `lib/require-permission.js`, il vaut `userData.user.email` (l.261) quand la session est vérifiée par la garde elle-même. C'est le cas ici, puisqu'on ne lui passe pas de `userId`. Il est rendu sur le chemin `messages` (l.441). La comparaison se fait en minuscules des deux côtés ; un e-mail nul donne `''`, donc un refus.

Seules les lectures propres à la garde (`properties`, `profiles`, `profile_permissions`) passent avant le 403. Elles ne renvoient qu'un statut.

### 2. `private, no-store` est-il posé avant le premier refus ? OUI

- Avant l'appel de la garde, seules s'exécutent les l.229 et 234. Elles ne peuvent pas lever : `req.query.property_id` vaut une chaîne, un tableau ou `undefined`, et `[].concat(..)[0]` puis `String(..)` sont sûrs. Le paramètre répété est couvert.
- La première instruction de `requirePermission` est `posterEnTetesPrives(res)` (l.249). Elle passe avant le 401, et même la déstructuration des arguments ne peut pas lever avant elle.
- Tous les refus suivants (403, 400, 503, 502) et le 500 du filet (l.108) partent donc avec l'en-tête déjà posé.
- Aucun test ne fixe cet en-tête sur cette branche, parce que le double de la garde ne le pose pas. La preuve est à la lecture.

### 3. Aucun fil d'un autre bien ne peut-il sortir ? NON, pas sans condition

`channex.js:1048-1049` :
```js
const bienDuFil = th.relationships?.property?.data?.id
if (bienDuFil && String(bienDuFil) !== String(propId)) { autresBiens++; continue }
```
- **Si `relationships.property` est absent, le fil est GARDÉ.** C'est aussi le cas avec `data: null` (forme permise par JSON:API), un identifiant vide ou un identifiant à 0.
- Mesuré en mémoire, avec un filtre ignoré et 4 fils : les fils de « CLIENT-B » (sans `property`) et de « CLIENT-C » (sans `relationships`) sortent avec leur `titre`, donc le nom du voyageur. Seul le fil qui déclare `AUTRE` est écarté, et `autres_biens` vaut 1.
- **Le compteur d'alerte est aveugle dans ce cas précis** : `fils_d_autres_biens_ecartes` reste à 0.
- **Les tests figent ce comportement.** L'outil `thread()` (`tests/demandes-mesure.test.js:156`) fabrique les fils avec réservation sans `property`, et la l.163 exige qu'ils soient gardés.
- **Casse ou type différent : le fil est écarté.** Mesuré : un bien `p` face à `P` donne 0 fil gardé et 1 écarté. Pas de fuite, et l'écart se voit dans le compteur.
- **Filtre ignoré avec un fil qui déclare son bien : écarté et compté.** C'est juste.
- **Un fil écarté ne fuit par aucun autre chemin.** Il ne sert qu'à `autresBiens++` et à `vus`. Le détail des messages ne lit que des fils gardés (`choix.choisis`). `mesurer` et `titre` ne voient que `liste.fils`. `motif` ne porte qu'un code d'erreur. Les lectures du cœur sont bornées à `bien.user_id` et `bien.provider_property_id`.

**Gravité : sécurité, au titre du durcissement, non bloquant.**
- Il faut deux écarts du partenaire en même temps : le filtre ignoré, et la relation absente. La doc Channex montre `relationships.property` dans chaque fil.
- Depuis S2, seul le fondateur verrait la fuite.
- Correctif d'une ligne, qui refuse par défaut : `if (String(bienDuFil ?? '') !== String(propId)) { autresBiens++; continue }`. Il faut aussi mettre `property` dans `thread()` l.156 pour les fils avec réservation.

### Autres défauts introduits par les correctifs

**D1. Mineur. C1 n'est fermé qu'à moitié : l'échéance ne borne pas un appel déjà parti.**
- `listerFils` et `idsDesMessagesDuFil` ne regardent l'échéance qu'entre deux pages. `channelCall` (`channex.js:67-71`) rejoue jusqu'à 4 fois en attendant 1, 2, 4 puis 8 s, et respecte `Retry-After` tel quel, sans plafond.
- Mesuré avec des attentes réduites à un dixième (100 ms au lieu de 1 s), une échéance à +50 ms et 4 réponses 429 : l'appel dure 1 503 ms et rend `complet: true` **sans `interrompu`**.
- À l'échelle réelle, le premier appel de la liste qui reçoit une série de 429 dure environ 15 s. C'est exactement le scénario C1 de la review 1. Avec `Retry-After: 30`, il dure jusqu'à 120 s.
- `vercel.json` ne donne aucun `maxDuration` à `api/diagnostic.js`. Le dépôt mentionne une limite de 15 s (`channex.js:29`). On peut donc encore finir en `FUNCTION_INVOCATION_TIMEOUT` avec un corps vide, et le commentaire l.257-261 promet le contraire.
- Correctif le plus sûr : un `maxDuration` d'au moins 60 s pour `api/diagnostic.js`. Je ne conseille pas de modifier `channelCall`, qui est partagé.

**D2. Mineur, non mesuré. Les jumelles avec réservation sont cherchées à la microseconde.**
- `diagnostic.js:300` filtre par `.in('sent_at', instantsWebhook)` : Postgres compare alors à la microseconde.
- Or `cleJumelle` et `recordMessage` comparent à la milliseconde. `record-message.js` explique pourquoi il ne filtre pas l'instant en SQL : comparer des instants, pas des chaînes.
- Si les deux copies d'un même message diffèrent sous la milliseconde, `dont_jumelle_avec_resa` est sous-compté.

**D3. Mineur. Le compteur `lus: details.size` (l.342) compte les tentatives, pas les fils lus.**
- Il inclut les détails en échec et ceux interrompus avant leur première page.
- Le nombre de fils lus en entier vaut `lus − fils.detail_incomplet`. Le chiffre n'est pas faux une fois rapproché de l'autre, mais le nom trompe.

**Défaut déjà présent, non introduit par ce commit.** La garde rend 404 pour un bien inconnu et 403 pour le bien d'un autre compte. N'importe quel utilisateur connecté peut donc savoir si une référence de bien existe. C'est commun à tous les endpoints. Le commentaire `diagnostic.js:230-231`, « 404 autre compte », est inexact.

**Constat de fonctionnement, pas un défaut.** Le fondateur doit aussi avoir `messages:read` sur le bien. Il ne peut donc pas mesurer le bien d'un client dont il n'est pas membre.

### Verdict
- S2 : fermé.
- S1 : fermé pour le cas documenté, mais il reste ouvert par défaut quand la relation au bien manque. Correctif d'une ligne, plus l'outil de test.
- C1 : à moitié fermé (D1).

C'est la dernière review de ce commit : ces correctifs s'appliquent sans nouvelle review.

### Suite donnée à la review 2

| constat | suite |
|---|---|
| 1. 403 avant tout appel | confirmé par la review, rien à corriger. |
| 2. no-store avant le premier refus | confirmé par la review, rien à corriger. |
| 3. S1, relation au bien absente | corrigé : un fil qui ne déclare pas son bien (relation absente, `data: null`, identifiant vide) est écarté par défaut et compté à part (`fils_sans_bien_ecartes`). L'outil `thread()` des tests déclare désormais le bien de chaque fil. |
| D1 | corrigé : `maxDuration` 60 s pour `api/diagnostic.js` dans `vercel.json` ; `channelCall`, partagé, n'est pas touché ; le commentaire de l'échéance dit sa limite. |
| D2 | corrigé : les jumelles avec réservation se lisent par plage d'instants (par curseur), plus par liste d'instants comparée à la microseconde. |
| D3 | corrigé : `detail.tentes` et `detail.lus_en_entier`. |
| commentaire « 404 autre compte » | corrigé : 404 bien inconnu, 403 bien d'un autre compte ou hors périmètre. L'oracle d'existence est commun à tous les endpoints, antérieur, non traité ici. |

Contre-épreuve par mutation des quatre correctifs : 4 mutants tués sur 4. Pas de nouvelle review (dernière review de ce commit).

## Lot 1, étapes 1-2 (cœur) — review 1 (22 novembre 2026), rapport tel que rendu

Plage relue : `6715079b1a9522e23f50409af8c489cd744715ec..dd850ad29d6eb2f75f9ae7d13eec8759b454f30b`,
branche `dette-129-lot1-coeur`, arbre `/home/claude/hotesmart-dette129-lot1`.

---

**Arbre lu** : `/home/claude/hotesmart-dette129-lot1`, branche `dette-129-lot1-coeur`, HEAD `dd850ad29d6eb2f75f9ae7d13eec8759b454f30b`. Plage `6715079b..dd850ad2`, 2 commits (`f12c3b8d`, `dd850ad2`).

**Fichiers de la plage** (9) :
- `api/channel-webhook.js`
- `docs/specs/spec-demandes-airbnb.md`
- `lib/channels/channex.js`
- `lib/demandes/fils.js`
- `lib/record-message.js`
- `migrations/2026-11-23-controle-demandes-fils.sql`
- `migrations/2026-11-23-demandes-fils.sql`
- `tests/demandes-fils-coeur.test.js`
- `tests/record-message-echo.test.js`

**Tests lancés** : `tests/demandes-fils-coeur.test.js` 15/15 verts, `tests/record-message-echo.test.js` 12/12 verts.

**Verdict** : deux constats de sécurité de la même famille (REVIEW.md règle 1), un test qui affirme un comportement que la vraie base refuse, et aucune régression trouvée sur les conversations de séjour.

### 1. Sécurité / cloisonnement

**S1 — `lib/demandes/fils.js:65` + `migrations/2026-11-23-demandes-fils.sql:63-64` — un fil peut changer de compte (gravité : sécurité, à une condition).**
- La table `fils_provider` est unique sur `(provider, provider_thread_id)`, sans `user_id`. Or l'upsert met à jour toutes les colonnes qu'on lui envoie, `user_id` compris. J'ai vérifié dans `node_modules/@supabase/postgrest-js` (2.102.1) : pour un objet seul, les colonnes absentes du payload ne sont pas touchées, toutes les autres sont réécrites.
- **Scénario** : deux lignes `properties` non archivées, sur deux comptes A et B, portent le même `provider_property_id` Channex. Le dépôt dit lui-même que c'est possible (`lib/bien-du-provider.js:58-63`, REVIEW.md règle 1). Le cron d'import tourne bien par bien, sans garde d'ambiguïté (`lib/cron-channel-messages-sync.js:318`).
  - Chaque passage réécrit `user_id` au nom du dernier compte importé.
  - B lit alors par la RLS le `titre` (nom du voyageur de A) et la réservation.
  - A perd la ligne, puis la récupère au passage suivant, et ainsi de suite.
- À noter : `messages` fonctionne en « premier arrivé gardé » ; ce lot introduit un « dernier arrivé gagne » qui bascule à chaque passage.
- **Correctif** : unicité `(user_id, provider, provider_thread_id)`, ou ne jamais réécrire `user_id` d'une ligne existante. Ajouter le test à deux comptes : le faux upsert actuel ne peut pas le montrer.

**S2 — `lib/record-message.js:339-361` — écriture dans la ligne d'un autre compte (gravité : sécurité, durcissement règle 1 ; aucun impact aujourd'hui).**
- La recherche du chemin « déjà connu » se fait par `(provider, provider_msg_id)` sans `user_id`. Elle existait déjà, mais elle ne faisait que sauter le message. Elle est maintenant suivie d'un `update ... eq('id', ex.id)` qui pose le fil et la réservation.
- **Scénario** : même condition que S1. L'import de B complète les lignes de A.
- Les valeurs écrites viennent du même message Channex (même fil, même réservation) : rien de B n'est exposé à A aujourd'hui. Mais c'est une nouvelle écriture qui traverse les comptes.
- **Correctif** : lire aussi `user_id` et ne compléter que si `ex.user_id === row.user_id`, ou ajouter `.eq('user_id', row.user_id)` sur la mise à jour.

**Le reste du point 1 est juste :**
- Les deux recherches de `lignesDuMemeFil` (l.208-220) filtrent par `user_id`. `completerLigne` n'agit que sur des `id` venus de ces recherches, sauf le cas S2.
- La policy `fils_provider_select` résout bien `can_read(uuid, text, text)` : c'est la même règle que `messages_select` (schéma initial l.4998).
- Les privilèges sont corrects : `revoke all` puis `grant select`. Aucune policy d'écriture.
- `enregistrerFil` reçoit toujours le `userId` du propriétaire du bien, dans les quatre appelants.

### 2. Régressions

**B1 — `lib/record-message.js:480-487` et test `tests/demandes-fils-coeur.test.js:120` — deux prospects dans la même minute restent un seul message en base (gravité : bloquant pour le test, mineur en production).**
- L'index unique partiel `messages_sans_msgid_unique_idx` (`migrations/2026-09-11-messages-unicite.sql:102-111`) porte sur `(user_id, coalesce(booking_id,''), direction, sender, md5(body), minute(sent_at))`, **sans le fil**.
- **Scénario du test lui-même** : « Bonjour » sur T1 à 15:47:20, puis sur T2 à 15:47:50. En production, le second insert rend une erreur 23505. Le code renvoie `race_23505_outbound` et la copie webhook du second prospect est jetée. Elle revient plus tard par l'import, avec une notification en retard.
- Le test est vert parce que le faux Supabase est plus permissif que la vraie base (REVIEW.md règle 22). Le commentaire l.480-482 promet ce que la base refuse.
- **Correctif** : ajouter `coalesce(provider_thread_id,'')` à l'index dans la migration, ou corriger le commentaire et le test.

**Séjours : aucune régression trouvée.**
- Beds24, e-mail entrant et sortants : pas de `threadId`, donc la recherche par réservation seule, comme avant.
- Séjour entrant : l'union garde la recherche par réservation, donc les lignes d'avant le lot (sans fil) sont retrouvées.
- `apresInsertion` (la notification) ne part que sur une vraie insertion. Tous les chemins de complément renvoient `skipped`.

**Fenêtre « code déployé, migration pas encore collée » :**
- Les replis sont corrects. PostgREST nomme bien la colonne dans les deux cas : `PGRST204 ... 'provider_thread_id' column ... schema cache` (insert, update) et `42703 column messages.provider_thread_id does not exist` (select, filtre).
- Pendant cette fenêtre :
  - chaque message déjà connu coûte une requête de plus (la relecture sans la colonne) ;
  - la dédup des copies webhook de demande est inopérante : le filtre sur la colonne absente renvoie une erreur, donc `dup` est vide. La dédup de 2 minutes sur `conversations`, en amont, couvre les renvois de webhook.
- Fenêtre inverse (migration collée, ancien code) : aucun effet.

### 3. Justesse (gravité : mineure)

- **`record-message.js:238-240`** : `provider_thread_id` est écrit sans condition dans `completerLigne`. Il écrase un fil différent, alors que le commentaire l.228-229 dit « on n'écrase rien ». La garde `.is(…, null)` côté base n'existe que pour `provider_msg_id`, pas pour `booking_id` ni pour le fil.
- **`fils.js:57`** : un `title` nul relu une fois efface le nom de la demande. La règle « on n'efface jamais » est appliquée à la réservation, pas au titre.
- **`ota` reste nul** sur les copies webhook de demande réconciliées : la spec mesure `ota` nul côté webhook, et `completerLigne` ne le complète pas. À prévoir pour les logos de canal du lot 2.
- **`channex.js:503-523`** : `enregistrerFil` écrit avant l'annonce d'écriture de masse (l.525-547), contrairement à la règle écrite juste en dessous. Au premier import d'un bien, c'est une ligne par fil, sans annonce.
- **Choix par défaut « une demande devenue réservation rejoint la réservation »** : il est appliqué en direct dans le writer (l.358-361, à chaque relecture), pas seulement au rattrapage de l'étape 3. Si Thierry le renverse, les lignes sont déjà modifiées.
- **Piège pour l'étape 3** : un upsert en lot (tableau) de `fils_provider` effacerait `booking_id`. Avec un tableau, supabase-js envoie l'union des colonnes, et `defaultToNull=true` met à nul les colonnes absentes d'une ligne. Aujourd'hui l'appel se fait objet par objet, donc c'est correct.
- **Fils jamais remplis** : `fils_provider` ne se remplit que pour les fils qui bougent, et l'étape 3 de la spec ne prévoit pas de le remplir. Les anciennes demandes resteront sans nom au lot 2.
- **`docs/specs/spec-demandes-airbnb.md:3`** dit encore « rien n'est codé ».

### 4. Coût

- **Nouveau message importé** : environ +1 requête (recherche par réservation puis par fil). Par exemple : séjour entrant de 3 à 4 aller-retours, demande de 2 à 3.
- **Économie possible** : ne lancer la recherche par fil que si la recherche par réservation n'a rien donné. C'est le cas largement majoritaire.
- **Message déjà connu, régime courant** : +0. Les tests garantissent l'absence d'écriture.
- **Premier passage après le déploiement** sur un fil qui bouge : une mise à jour par message (environ ×2 aller-retours). Le budget et la reprise absorbent.
- **Par fil qui bouge** : +1 upsert de `fils_provider`.
- **Webhook** : nombre de requêtes inchangé.

### 5. Migration (gravité : mineure)

- Elle est rejouable. L'ordre « migration avant code » est annoncé, et le code tolère l'ordre inverse.
- Toutes les lignes font moins de 58 caractères (mesuré en caractères : `awk` en locale C compte des octets et signale à tort les lignes 28 et 47).
- **Contrôle 6** (`controle-demandes-fils.sql:50-57`) : il est **vert quand la table n'existe pas** (`count(*)=0`, REVIEW.md règle 16).
- **Ce que le contrôle ne vérifie pas** :
  - que `service_role` garde INSERT et UPDATE (sinon `enregistrerFil` échoue sans bruit) ;
  - l'expression de la policy (`can_read … 'messages'`).
- `has_table_privilege(...)` serait plus sûr que `information_schema.role_table_grants`, qui ne montre que les droits où l'utilisateur courant est concédant ou bénéficiaire.

### 6. Tests

- **Verts contre le code d'avant** (« le fil ne traverse pas les comptes » l.131, « COÛT » l.169, « migration pas encore collée » l.193) : ce sont des tests de non-régression ou de sobriété. La règle 19 §2 demande que leur en-tête nomme la version fautive contre laquelle ils rougissent. Je l'ai raisonné, pas exécuté : la review était limitée à la lecture seule.
- **L.120** : faux vert (B1).
- **Cas sans aucun test** : l'écriture d'un autre compte (S2), le basculement de propriétaire de `fils_provider` (S1), l'écrasement d'un fil par `completerLigne`.

### Hors plage, à transmettre

- **Messages d'un autre bien** : `importMessages` écrit sous ce compte les messages des fils d'un **autre bien ou sans bien**. Le test l.240 enregistre lui-même `msg-etranger` et `msg-sans-bien`. La garde S1 ne protège que `fils_provider`. Ces messages porteront désormais un fil et deviendront une « Demande » visible au lot 2.
- **Doc Channex** ([webhook collection](https://docs.channex.io/api-v.1-documentation/webhook-collection)) :
  - `message_thread_id` est bien dans le payload de l'événement `message`, ce qui confirme le champ choisi par le lot ;
  - l'identifiant du message y est `payload.id`, alors que le webhook lit `payload.message_id`, absent : c'est la cause probable des copies webhook « sans identifiant ». Si la ligne de journal `payload message keys` le confirme, utiliser `payload.id` supprimerait le doublon à la source, pour les séjours comme pour les demandes ;
  - l'exemple de payload n'a pas d'`inserted_at` (`timestamp` est au niveau supérieur). La réconciliation exige le même instant à la milliseconde : la mesure du §0 de la spec (« aux mêmes instants ») est à confirmer à la milliseconde avant le go.
