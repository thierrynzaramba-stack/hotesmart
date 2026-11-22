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
