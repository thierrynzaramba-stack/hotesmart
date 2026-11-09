# Reviews du lot « dette 137 » (branche `dette-137-code-acces`)

Lot qui touche l'ENVOI AU VOYAGEUR : trois reviews au plus. Chaque rapport est
recopié ici mot pour mot, dès réception.

## Review 1 — reçue le 10 novembre 2026

- Lancée sur : `/home/claude/hotesmart-137`, branche `dette-137-code-acces`,
  plage `9385a9e1ddfe3d957ffc9e79985b16122ef14bd1..9b6d6f168e3c625b558d0156426960f675c57ad8`.
- Contrôle d'arbre : l'arbre, la branche et le SHA déclarés par la review sont
  ceux du brief.
- Contrôle des fichiers cités : `lib/cron-arrival-code.js`,
  `lib/message-builder.js`, `lib/founder-notify.js` et
  `tests/arrival-code-manquant-alerte.test.js` sont dans le diff.
  `lib/balises.js`, `lib/cron-messages.js`, `lib/providers/seam.js`,
  `lib/platform-notify.js` et `docs/kb/alertes.md` n'y sont pas. Ce sont des
  fichiers de CONTEXTE que le brief l'invitait à lire (remplaceur,
  `prevenirManque`, serrure, envoi SMS, recensement des alertes), et chaque
  constat porte sur un fichier du diff. Écart à la règle « un seul fichier
  hors du diff : on relance », signalé tel quel au chef de file.

### Rapport, mot pour mot

Arbre lu : /home/claude/hotesmart-137 — branche : dette-137-code-acces — SHA lu : 9b6d6f168e3c625b558d0156426960f675c57ad8

**Fichiers cités**
- lib/cron-arrival-code.js
- lib/message-builder.js
- lib/balises.js
- lib/founder-notify.js
- lib/cron-messages.js
- lib/providers/seam.js
- lib/platform-notify.js
- tests/arrival-code-manquant-alerte.test.js
- docs/kb/alertes.md

**Mesures faites, arbre non modifié**
- Suite complète : **7756 tests, 7756 verts, 0 rouge**.
- Fichier neuf : 9/9 à l'heure réelle, et 9/9 avec l'horloge décalée de 30 jours puis de 200 jours (`horloge-decalee.js`).
- Tests voisins (arrival-code-*, balises, escalade, founder-notify, canal-routage, empreinte, envoi-ota…) : 265/265.

**Par catégorie demandée**

1. **Envoi : rien n'a changé.** Le diff touche seulement la construction du message (l. 586-588, qui fait la même chose que `buildMessage`) et ajoute l'appel d'alerte (l. 705-708).
   - La garde du code est intacte (l. 593).
   - La tâche « envoi impossible » (l. 653-676), `noterEnvoi` (l. 688), `recordMessage` (l. 721-736) et le passage du code à `active` (l. 771-776) sont toujours atteints. Le test 7 le mesure même quand l'alerte lève une erreur : journal = 1, code actif = 1.
2. **Alerte : elle sonne quand il faut.**
   - Elle ne sonne qu'en mode Auto, après l'envoi, et seulement si quelque chose manque.
   - Elle ne sonne jamais quand le message est retenu (tous les `return` des l. 489-600), ni en mode Test.
   - Chaque information manquante n'est comptée qu'une fois (balises.js:266-272), et chacune a bien un marqueur entre crochets (balises.js:83-90).
   - Le texte est vrai dans les trois cas : envoyé, refusé par le canal, e-mail différé (`differe`). Dans ces deux derniers cas, la tâche existe bien (l. 654).
   - Une erreur levée par l'alerte est attrapée (l. 462-481). Une alerte qui reste bloquée sans répondre, en revanche, n'est pas couverte : voir constat 2.
3. **Anti-spam : acceptable.** La fenêtre est d'une heure par type et par bien (founder-notify.js:278-285).
   - Le texte change d'une réservation à l'autre (nom, dates), donc l'élargissement progressif de la fenêtre ne s'applique pas d'un voyageur au suivant (l. 243).
   - Une seconde alerte est étouffée seulement si deux messages de code partent pour le même bien dans la même heure :
     - deux modèles ou deux serrures pour la même réservation : l'étouffement est souhaitable, c'est le même fait ;
     - un rattrapage le même jour qu'une arrivée, ou une surréservation : cas rares pour un logement loué entier. L'incident reste quand même enregistré en base, sans alerte (`alerted=false`).
   - Une alerte d'un autre type ne la fait pas taire, et elle n'en fait taire aucune autre.
4. **Tests : ils testent ce qu'ils annoncent**, avec des dates relatives à l'horloge. Mais voir les constats 1 et 6.
5. **Données personnelles : aucune fuite.** L'alerte contient les mêmes champs que `prevenirManque` (prénom, nom, dates) et part au même destinataire. Ni le PIN ni le texte du message n'y figurent.

**Constats**

1. **MINEUR (test) — le harnais n'est pas étanche : un test passe seulement parce qu'un appel réseau échoue.**
   - Où : tests/arrival-code-manquant-alerte.test.js:60-63 (`seam_code_id: null`) ; lib/cron-arrival-code.js:321 et 396-406.
   - Ce qui se passe : avec ce `seam_code_id: null`, chaque test passe par la création du code chez Seam. Mesuré : **28 vraies requêtes** vers `SUPABASE_URL/rest/v1/api_keys` (la lecture de la clé Seam). Le fichier prend **49 s, contre 1 s** pour le test voisin `arrival-code-adresse-fiche`. Les « ~30 s » du brief ne viennent donc pas de Seam lui-même mais de cette lecture, provoquée par la fixture.
   - Contre-épreuve : j'ai remplacé `lib/providers/seam.js` par un double dont la lecture de clé réussit et rend « pas de clé ». Résultat : **`not ok 2 - fiche avec adresse … expected 0, actual 1`**. L'alerte `seam_key_missing` arrive dans `vus.alertes`. Le vert de ce test dépend donc d'une base injoignable.
   - Correctif : mettre `seam_code_id: 'seam-1'`, comme le test voisin, et doubler `lib/providers/seam.js` avec `{ getSeamKey: async () => null, generateCode: async () => { throw … } }`. Le cas « PIN pas encore posé » reste alors retenu par `hasUnresolvedCode`, sans aucun appel réseau.

2. **MINEUR — l'alerte est attendue avant `recordMessage` et avant le passage du code à `active`.**
   - Où : lib/cron-arrival-code.js:705-708, à comparer avec les l. 721-736 et 771-776.
   - Scénario : Brevo répond très lentement. Les appels (platform-notify.js:18 et 41) n'ont pas de délai maximum, et le cron est limité à 60 s. La fonction est coupée : le message du code manque dans le fil de Messages (justement là où l'alerte dit d'aller), et le code reste `pending`. `noterEnvoi` est déjà écrit, donc rien ne se rattrape au cycle suivant. Le try/catch protège contre une erreur levée, pas contre une attente.
   - Correctif : garder `manquants` et `parti` dans des variables et appeler `prevenirCodeIncomplet` en toute fin du `try`, après la mise à jour d'`access_codes`, toujours seulement en mode Auto.

3. **MINEUR — le SMS est coupé avant la consigne.**
   - Où : founder-notify.js:300 (`.slice(0, 300)`) et cron-arrival-code.js:467-477.
   - Mesuré : 544 caractères avec deux informations manquantes, environ 305 avec une seule. Le SMS s'arrête à « Le code, lui, est bien parti : s… ». « Envoyez-lui l'information depuis Messages » et l'endroit où la renseigner n'arrivent que par e-mail.
   - Correctif : mettre la consigne juste après « il manque X », et retirer la phrase « Le code, lui, est bien parti… », que le libellé de l'alerte dit déjà.

4. **MINEUR (défaut ancien, conséquence nouvelle) — une panne de lecture est présentée comme un manque de l'hôte.**
   - Où : cron-arrival-code.js:140-149. `loadKnowledge` ignore l'`error` renvoyé par Supabase.
   - Scénario : la lecture de la base de connaissance échoue au moment de l'envoi. La base vaut `{}`, le wifi et le téléphone passent dans les manquants, le marqueur part (comportement d'avant le lot), et l'alerte neuve dit maintenant « il manque Mot de passe wifi… à renseigner dans … » alors que l'hôte l'a bien renseigné. C'est exactement le défaut corrigé dans cron-messages.js:1017-1021 (« accusait la configuration de l'hôte au lieu de la panne »). L'adresse n'est pas concernée : elle vient de la fiche.
   - Correctif : lire `error`. Ensuite, deux options : retenir le message pour ce cycle, ce qui retarde le PIN de 5 min (décision de Thierry), ou au minimum signaler « lecture de la base en échec » dans l'alerte au lieu de « à renseigner ». Sinon, l'inscrire au registre des dettes.

5. **MINEUR (défaut ancien, même famille, hors option (a)) — une balise inconnue part en clair, sans alerte.**
   - Où : message-builder.js:52 et 66 ne gardent pas `inconnues` (calculées dans balises.js:318).
   - Mesuré : le modèle « …arrivée à {heure_arrivee}… » donne `manquants: []`, et `{heure_arrivee}` part en clair avec le PIN, sans aucune alerte. Les messages programmés, eux, retiennent le message et préviennent (cron-messages.js:1174).
   - Ce n'est pas une régression du lot. Correctif peu coûteux : `buildMessageDetaille` rend aussi `inconnues`, et l'alerte les cite (« à corriger dans le modèle »). Sinon, ligne au registre.

6. **MINEUR (tests) — trois promesses ne sont pas mesurées.**
   - « Une seule fois par réservation » : le double de `message_sent_log` est toujours vide (test l. 65), donc il n'existe aucun test sur deux cycles.
   - « Après `noterEnvoi` » : le double de `noterEnvoi` ne compte rien (l. 83).
   - Le cas `differe` n'est pas testé. Risque faible : il suit le même chemin que le refus du canal.
   - Correctif : ajouter un compteur dans le double de `noterEnvoi` et une assertion dans le test 7 ; ajouter un second cycle avec `message_sent_log` non vide, qui doit donner 0 nouvelle alerte.

7. **MINEUR (doc) — docs/kb/alertes.md n'est pas mis à jour.**
   - L'en-tête de founder-notify.js:1 demande de le mettre à jour dans le même commit. Le type neuf n'y figure pas, alors que le recensement des alertes sans écran (alertes.md:636-645) gagne une entrée. La pratique du dépôt est déjà inégale sur ce point (`reservation_sur_bien_archive` y manque aussi).

**Rien de BLOQUANT ni de SÉCURITÉ trouvé.**

Remarque, hors constat : `reportIncident` envoie au téléphone et à l'e-mail du fondateur (`FOUNDER_PHONE`/`FOUNDER_EMAIL`, founder-notify.js:309-310), pas à l'hôte du compte concerné. C'est le même destinataire que `prevenirManque`, donc pas une régression. Mais la phrase de codes-acces.md « l'hôte reçoit l'alerte » n'est vraie que pour le compte du fondateur.
