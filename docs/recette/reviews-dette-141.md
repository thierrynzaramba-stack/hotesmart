# Reviews du lot « dette 141 » — alerte « envoi impossible » du code d'accès après le journal

Lot qui touche l'ENVOI AU VOYAGEUR : trois reviews au plus (exception du
27 octobre 2026). Chaque rapport est recopié mot pour mot dès réception.

## Review 1 — reçue le 10 novembre 2026

- Lancée sur : `/home/claude/hotesmart-141`, branche `dette-141-alerte-apres-journal`,
  plage `86c97cbfa1e6888a502f0d83fecb20953328341c..4e787854ebeeea43c6389e9af7dde3e65b250436`.
- Contrôle d'arbre : arbre, branche et SHA déclarés conformes au brief.
- Contrôle des fichiers cités : les cinq fichiers « du diff » sont exactement
  ceux de `git diff --name-only` de la plage ; les fichiers « lus pour le
  contexte » sont hors diff, déclarés comme tels.
- Aucun constat de sécurité (compte, garde, authentification).
- Seule retouche de transcription : les entités HTML du transport (`&gt;`)
  sont rendues par leur caractère.

### Rapport, mot pour mot

Arbre lu : /home/claude/hotesmart-141 — branche : dette-141-alerte-apres-journal — SHA lu : 4e787854ebeeea43c6389e9af7dde3e65b250436

Plage relue : `86c97cbfa1e6888a502f0d83fecb20953328341c..4e787854ebeeea43c6389e9af7dde3e65b250436`, un commit. L'arbre n'a pas été modifié : `git status --short` ne montre que `?? node_modules`, le lien symbolique qui y était déjà. Tous les essais ont été faits dans /tmp/revue141 (copies `copie/` = 4e787854, `avant/` = 86c97cbf, `contre/` = code d'avant avec les tests neufs, `mut/`, `scripts/`).

**Fichiers cités**

Fichiers du diff (tous dans `git diff --name-only 86c97cbf..4e787854`) :
- `lib/cron-arrival-code.js`
- `tests/arrival-code-manquant-alerte.test.js`
- `tests/canal-routage-envoi.test.js`
- `docs/kb/codes-acces.md`
- `docs/kb/dettes-v1.md`

Fichiers lus pour le contexte, hors diff, au même SHA :
- `lib/founder-notify.js`, `lib/platform-notify.js`, `lib/cron-messages.js`, `lib/envoi-ota.js`, `lib/channels/channex.js`
- `lib/record-message.js`, `lib/cron-shared.js`, `lib/alert-notify.js`, `lib/message-builder.js`, `lib/booking-changes-dispatch.js`, `lib/cleaning/sync-menages.js`, `lib/email-voyageur.js`, `lib/metriques-cron.js`
- `api/cron.js`, `vercel.json`, `docs/kb/guestflow.md`, `docs/kb/alertes.md`
- `node_modules/@supabase/postgrest-js/dist/index.cjs`, à travers le lien vers `/home/claude/hotesmart-accueil/node_modules` prescrit par le brief

---

**1. IMPORTANT — touche l'envoi au voyageur (documentation) — `docs/kb/codes-acces.md:40-45`**

*Ce qui est faux.* Le paragraphe ajouté dit que le refus du canal produit « l'alerte « envoi impossible » au fondateur », « une seule fois par réservation ». C'est faux pour un refus isolé.

*Mécanisme.* `send_failure` est appelée avec `threshold: 2` (`lib/cron-arrival-code.js:822`). Le vrai `reportIncident` s'arrête avant tout SMS et tout e-mail tant que les incidents de ce type sur ce bien, dans la fenêtre, sont moins de deux (`lib/founder-notify.js:294`). Le libellé réel de l'alerte est « Échecs d'envoi répétés » (`lib/founder-notify.js:61`) ; aucune alerte ne s'appelle « envoi impossible ». `docs/kb/guestflow.md:143` le dit déjà : `send_failure` remonte « dès la deuxième occurrence ». L'alerte n'est donc pas « par réservation » : elle est par bien et par fenêtre, à partir du deuxième refus.

*Scénario.* Une seule réservation sans messagerie sur La bulle dans l'heure. L'hôte a sa tâche. Le fondateur ne reçoit rien, alors que la fiche lui dit qu'il est prévenu. Le seul signal qui atteint vraiment le fondateur dès le premier refus est `message_envoye_incomplet` (seuil 1), et seulement s'il manque une information. La justification de la rangée 141 (« c'est l'alerte qui compte le plus », d'où son passage en premier) s'appuie sur la même lecture erronée.

*Mesuré* avec `scripts/seuil-fondateur.js` : vrai `founder-notify`, base et `fetch` remplacés par des doubles, valeurs factices.
- Un refus : `{"recorded":true,"alerted":false,"count":1}`, **0 appel plateforme**.
- Deux refus : `alerted:true`, 2 appels (SMS et e-mail).

*Correctif proposé.* Réécrire la fiche ainsi : « l'incident `send_failure` est consigné ; le fondateur reçoit l'alerte « Échecs d'envoi répétés » à partir du deuxième refus sur le même logement dans la fenêtre ». Ou bien demander à Thierry s'il veut le seuil 1 pour le code d'accès : c'est une décision produit, à ne pas trancher dans ce lot. Retirer aussi « c'est l'alerte qui compte le plus » de la rangée 141.

---

**2. IMPORTANT — touche l'envoi au voyageur — hors diff, antérieur au lot — `lib/cron-arrival-code.js:680-710`**

*Mécanisme.* Une coupure réseau pendant le POST du message rend `ok:false, incertain:true` : le code a peut-être été reçu. `sendArrivalMessage` ne lit pas `incertain`. Il traite ce cas comme un refus :
- tâche à l'hôte « envoi automatique impossible (pas de messagerie pour cette réservation), à transmettre manuellement » ;
- l'alerte notée par ce correctif, « Envoi du code d'arrivée impossible … : network_error ».

L'autre moteur, `lib/cron-messages.js` via `classerEnvoiOta`, en fait une issue « à vérifier », jamais rejouée.

*Scénario.* Le POST vers Channex est émis, la réponse se perd. L'hôte lit « impossible », renvoie le code à la main, et le voyageur le reçoit deux fois. Le paragraphe de `codes-acces.md` (« réservation sans messagerie, refus du provider ») ne couvre pas ce cas.

*Mesuré.*
- `scripts/incertain-reel.js` : vrai `sendGuestMessage`, bien Channex, `fetch` qui lève ECONNRESET sur le POST → `POST emis = 1 | {"ok":false,"incertain":true,"permanent":false,"error":"network_error","canal":"ota"}`.
- Passé dans le vrai `processArrivalCodes` avec le harnais du test (fichier jetable dans `copie/`) → ordre `envoi > noter > actif > alerte`, tâche « …envoi automatique impossible (pas de messagerie… », alerte `send_failure : … : network_error`.

*Correctif proposé.* Ouvrir une rangée au registre, hors de ce lot (la règle de portée l'exige). Si `sendResult.incertain`, la tâche doit dire « a peut-être été reçu — vérifiez le fil avant de renvoyer », et l'incident doit suivre le chemin « à vérifier » plutôt que `send_failure`.

---

**3. MINEUR — documentation — `docs/kb/dettes-v1.md:153`**

*Première affirmation fausse.* « Son échec est journalisé (« alerte « envoi impossible » non partie ») ». Le vrai `reportIncident` ne lève jamais : chaque étape a son try/catch, et `sendPlatformSms` / `sendPlatformEmail` rendent `{ok:false}`. Le `catch` ajouté en `lib/cron-arrival-code.js:823-825` ne peut donc pas se déclencher en production. Un vrai échec de Brevo ne produit aucune ligne chez l'appelant. Le `try/catch` reste une ceinture acceptable ; c'est la phrase qui annonce une trace qui n'existera pas.
- *Mesuré* (`scripts/seuil-fondateur.js`, `fetch` qui rejette) : `reportIncident RESOUT sans lever -> {"sms":{"ok":false,"error":"socket hang up"},"email":{"ok":false,…}}`.

*Seconde affirmation incomplète.* La phrase « même famille, hors portée » sur `lib/cron-messages.js` :
- **Exact** : `faut_il_abandonner_email` attend `email_voyageur_abandon` avant le `noterEnvoi` d'abandon (l. 274-310 puis 427-431).
- **Exact** : l'e-mail sur événement attend son alerte (l. 413-419) avant que `lib/booking-changes-dispatch.js:405` pose `processed_at`.
- **Exact pour le voyageur** : « jamais un message reçu deux fois ». À la relance, chaque modèle déjà livré est sauté par `message_sent_log` (l. 851-858). Les blocages « à vérifier » et « arrêt » sont la ligne d'incident, insérée avant tout appel à la plateforme (`founder-notify` étape 1). Cette conclusion est déduite du code, pas d'un essai.
- **Il manque deux sites de la même famille.** `prevenirCodeARemplir` (seuil 1, donc Brevo dès la première fois) est attendu aux l. 714 et 912, **avant** l'insert `agent_tasks` et le `noterEnvoi`. Si la plateforme est lente : ni tâche ni journal. Au passage suivant, nouvel appel Anthropic (`generateAutoMessage`, l. 642), nouvelle alerte, et sur le site 912 tout l'événement est réexpédié. Pour le voyageur, rien ne part deux fois.
- Non mesuré, signalé seulement : cette réexpédition rejoue aussi le consommateur ménages, qui fait un `insert` dans `menage_events`.

*Correctif proposé.* Remplacer « son échec est journalisé » par « elle ne peut pas casser l'envoi (try/catch de ceinture ; `reportIncident` ne lève pas) ». Compléter la liste de `cron-messages.js` avec `prevenirCodeARemplir`, l. 714 et 912.

---

**4. MINEUR — touche l'envoi au voyageur (tests) — `tests/arrival-code-manquant-alerte.test.js:362-370`**

*Mécanisme.* Les nouveaux tests ne vérifient de l'alerte `send_failure` que son type, son seuil et son détail. `userId`, `propertyId` et `propertyName` ne sont tenus par aucun test. Or `propertyId` fixe le périmètre du seuil 2 et de l'anti-spam : par bien, ou par type sur tout le parc s'il vaut `null`.

*Mesuré* avec `scripts/muter.js` : 14 mutations du correctif, les deux fichiers relancés à chaque fois. Trois survivent avec 0 rouge :

| Mutation | Effet | Rouges |
|---|---|---|
| M6 | sans `userId` | 0 |
| M7 | `propertyId: null` | 0 |
| M8 | sans `propertyName` | 0 |

Les onze autres rougissent ; voir la dernière catégorie ci-dessous.

*Correctif proposé.* Dans le test « refus du canal ET information manquante », ajouter :
`assert.strictEqual(vus.alertes[0].userId, 'u1')`, `assert.strictEqual(vus.alertes[0].propertyId, '0db6b39b')`, `assert.strictEqual(vus.alertes[0].propertyName, 'La bulle')`.

---

**Catégories sans constat réel**

- **Double envoi au voyageur créé par le correctif : aucun.**
  - Le diff ne déplace que l'alerte. `sendGuestMessage` est appelé une fois, et l'ordre mesuré est `envoi > noter > actif > alerte`.
  - Entre l'envoi et `noterEnvoi`, il ne reste plus aucun appel à la plateforme d'alerte. Il reste des appels sans délai maximum (`sendGuestMessage`, `channelCall` sans délai à `lib/channels/channex.js:45`, les écritures Supabase), mais ils existaient avant le lot et ne dépendent pas de lui. Je ne les compte pas comme constat.

- **Alerte qui ne partirait plus alors qu'elle partait avant : aucun chemin réel.**
  - Rien ne lève entre le refus et la fin : `noterEnvoi` ne lève pas (l. 87-114) ; `recordMessage` attrape tout (l. 373-377) ; postgrest-js 2.102.1 transforme les erreurs de `fetch` en `{error}` (`index.cjs:234`) ; `bati.manquants` est toujours rendu.
  - Le mode Test ne passe jamais par cette branche.
  - `differe` donne zéro alerte, avant comme après (tenu par le test 4).
  - Les retours anticipés sont tous avant le `try`.
  - Seul reste un compromis assumé : une coupure entre `noterEnvoi` et la ligne d'incident fait perdre l'incident au lieu de doubler la tâche.

- **Ordre de fin : conforme.**
  - Mutation M5 (alerte remise avant `noterEnvoi`) : 2 rouges.
  - M4 (alerte avant le passage en `active`) : 2 rouges.
  - M3 (`send_failure` après l'alerte incomplète) : 2 rouges.
  - Le cron n'impose aucun délai par tâche (`lib/metriques-cron.js:241`, `api/cron.js:858-882`). Une alerte bloquée après le journal ne bloque plus qu'un seul passage, au lieu de se rejouer à chaque cycle.

- **Contre-épreuve sur le code d'avant** (`contre/`) :
  - Les trois tests neufs du comportement rougissent pour la bonne raison : `le journal anti-doublon attend l alerte : envoi > alerte` ; `envoi > alerte > noter > actif > alerte` ; `[send_failure]` seul au lieu de `[send_failure, message_envoye_incomplet]`.
  - Le test de forme rougit aussi.
  - Le test `differe` passe des deux côtés, ce qui est attendu pour un test de non-régression.

- **Horloge décalée** : 46/46 à J+4, J+60, J+200 et J+400 ; 46/46 aussi à l'heure réelle.

- **Le test de forme de `tests/canal-routage-envoi.test.js` reste utile.**
  - Il est le seul à attraper M14 (`if (echecAPrevenir !== undefined)`), qui écrirait « alerte « envoi impossible » non partie » après chaque envoi réussi.
  - Il attrape aussi M2, M11 et M12.
  - Il laisse passer M5, mais les tests de comportement l'attrapent.

- **Mutations qui rougissent** : M1, M2, M3, M4, M5, M9, M10, M11, M12, M13, M14.

## Review 2 — reçue le 10 novembre 2026 (commit de la décision « dès le premier refus » seulement)

- Lancée sur : `/home/claude/hotesmart-141`, branche `dette-141-alerte-apres-journal`,
  plage `061669e3c3a33f773abda524a73c931e6997f6d9..58ad5d30d93bfd3063efff2f0a03d04839bf4ed6`.
- Contrôle d'arbre : arbre, branche et SHA déclarés conformes au brief.
- Contrôle des fichiers cités : les sept fichiers « du diff » sont exactement
  ceux de `git diff --name-only` de la plage ; les fichiers « lus pour le
  contexte » sont hors diff, déclarés comme tels.
- Aucun constat de sécurité (compte, garde, authentification).
- Seule retouche de transcription : l'entité HTML du transport (`&amp;`) est
  rendue par son caractère.

### Rapport, mot pour mot

Arbre lu : /home/claude/hotesmart-141 — branche : dette-141-alerte-apres-journal — SHA lu : 58ad5d30d93bfd3063efff2f0a03d04839bf4ed6

Plage relue : `061669e3c3a33f773abda524a73c931e6997f6d9..58ad5d30d93bfd3063efff2f0a03d04839bf4ed6`, soit un seul commit. Je n'ai rien modifié dans l'arbre : `git status --short` ne montre que `?? node_modules`, déjà présent avant ma review. Tous les essais ont été faits dans `/tmp/revue141b` :
- `copie/` : l'état 58ad5d30 ;
- `avant/` : l'état 061669e3 ;
- `contre/` : le code de 061669e3 avec les tests neufs ;
- `mut/` : les mutations ;
- `scripts/` : `harnais.js`, `scenarios.js`, `muter.sh`, `muter2.sh`.

`scripts/harnais.js` fait tourner le vrai `processArrivalCodes` et le vrai `founder-notify` : seuil, anti-spam, escalade et composition du SMS sont réels. Seules la table `automation_incidents` (en mémoire) et la plateforme SMS / e-mail sont des doubles. Les numéros et adresses utilisés sont factices.

**Fichiers cités**

Fichiers du diff (tous présents dans `git diff --name-only 061669e3..58ad5d30`) :
- `lib/cron-arrival-code.js`
- `lib/founder-notify.js`
- `tests/arrival-code-manquant-alerte.test.js`
- `tests/canal-routage-envoi.test.js`
- `docs/kb/codes-acces.md`
- `docs/kb/alertes.md`
- `docs/kb/dettes-v1.md`

Fichiers lus pour le contexte, hors diff, au même SHA :
- `lib/cron-messages.js`, `lib/channels/channex.js`, `lib/cron-beds24.js`, `lib/canal-voyageur.js`, `lib/email-voyageur.js`, `lib/cron-alerting.js`
- `api/ecran/aujourdhui.js`, `api/incidents-acquitter.js`
- `scripts/observer-test-canal-email.js`, `scripts/rendre-sejours-au-bien.js`
- `docs/recette/reviews-dette-141.md`, `docs/kb/guestflow.md`, `migrations/0000-schema-initial.sql`, `pages/logement-nouveau.html`, `tests/founder-notify-sans-sms.test.js`

---

**1. IMPORTANT — touche l'envoi au voyageur — `lib/cron-arrival-code.js:825-827`, `lib/founder-notify.js:289-301`**

*Mécanisme.* `code_acces_non_envoye` a le seuil 1, mais l'anti-spam de `reportIncident` porte sur la paire (type, logement) pendant 1 h.
- Un second code refusé sur le même logement dans l'heure trouve `alreadyAlerted = true`. Il est consigné, sans SMS ni e-mail.
- Le message cite le nom et la réservation, donc il diffère d'une réservation à l'autre. L'escalade (fenêtre élargie quand le même fait persiste) ne joue donc pas : la fenêtre reste d'une heure.
- `sejoursPresents` trie par date d'arrivée. Un jour de dos-à-dos, c'est donc le voyageur qui part qui prend l'alerte, et celui qui arrive le soir même devant la porte est tu.
- Le message du commit écarte `send_failure` justement parce que son anti-spam par logement « aurait tu celui du code ». Le même mécanisme reste ici, entre deux réservations du même logement.
- La garde `!aPrevenir` ajoute une variante. Quand le code refusé a aussi une information manquante, sa seule alerte est `message_envoye_incomplet`. Son anti-spam est partagé avec les alertes « ENVOYÉ, il y manque… » du même logement.

*Scénarios mesurés* (`scripts/scenarios.js`, sur `copie/` puis sur `avant/`) :

| Scénario | 58ad5d30 | 061669e3 |
|---|---|---|
| S2 : D (part ce jour) et A (arrive ce jour), tous deux refusés dans le même passage | 1 SMS, qui nomme **Paul Martin (D)** ; A est « consigné seulement » | 1 SMS, à la 2e occurrence, donc pour **A** |
| S3 : refus de A, puis refus de B 40 min plus tard | SMS au 2e passage : **0** | SMS au 2e passage : **1** |
| S4 : fiche sans adresse ; A part incomplet (alerté « ENVOYÉ à Ana… ») ; B refusé et incomplet | B « consigné seulement » | B « consigné seulement » |

- Pour S2 et S3, le commit régresse : avant lui, un second refus prévenait le fondateur.
- Pour S4, c'est un trou de la décision du 10 novembre, pas une régression. Le seul SMS reçu dit « ENVOYÉ », alors que le code de Bea Ruiz n'est pas parti.

*Quand cela arrive.* Il faut deux codes en attente sur le même logement le même jour. Exemples : reprise après une pause d'automatisation, modèle activé en cours de séjour, `scripts/rendre-sejours-au-bien.js`. Le cas est rare, mais c'est celui d'une porte fermée. L'hôte a bien ses deux tâches.

*Correctif proposé.* Le journal `message_sent_log` garantit déjà un seul appel par (réservation, modèle). L'anti-spam par logement n'apporte donc rien à ce type. Deux voies :
- donner à `reportIncident` une clé d'anti-spam distincte du `property_id`, par exemple la réservation. Il ne faut pas toucher `property_id`, qui sert à la RLS (`can_read(user_id,'reglages',property_id)`) ;
- à défaut, écrire dans les deux fiches qu'un second refus sur le même logement dans l'heure est consigné sans SMS, et faire trancher Thierry.

---

**2. IMPORTANT — touche l'envoi au voyageur — `lib/cron-arrival-code.js:708-709`**

*Mécanisme.* Un envoi « incertain » est une coupure réseau après le POST : le code a peut-être été reçu. C'est le constat 2 de la review 1, renvoyé à une dette dont le numéro n'est pas encore au registre (`grep incertain docs/kb/dettes-v1.md` ne trouve rien).
- Avant ce commit, ce cas ne produisait qu'une tâche à l'hôte. `send_failure` au seuil 2 n'envoyait rien au fondateur pour un cas isolé.
- Maintenant, il produit dès la première occurrence un SMS qui affirme « NON ENVOYÉ par le canal : à lui transmettre vous-même ». Le commit rend donc plus fort et plus affirmatif un défaut connu. Le fondateur peut renvoyer un code que le voyageur a déjà reçu.

*Mesuré.* S6 : envoi `{ok:false, incertain:true, error:'network_error'}`, la forme que la review 1 a mesurée sur le vrai `sendGuestMessage` avec ECONNRESET.
- Sur 58ad5d30, 1 SMS : `"…Code d'accès de Ana Lopez NON ENVOYÉ par le canal : à lui transmettre vous-même, code et texte dans vos tâches. Motif : network_error (réservation A)."`
- Sur 061669e3 : 0 SMS.

*Correctif proposé.* Une ligne dans le diff, à la l. 709 : si `sendResult.incertain`, écrire « PEUT-ÊTRE REÇU (coupure réseau pendant l'envoi) : vérifiez le fil avant de le lui transmettre ». La correction de la tâche à l'hôte reste à la dette annoncée.

---

**3. MINEUR — touche l'envoi au voyageur — `lib/cron-arrival-code.js:825`**

*Mécanisme.* Avec `!aPrevenir`, le cas « refus + information manquante » n'écrit plus aucune ligne qui porte le refus ni son motif. Seule `message_envoye_incomplet` est écrite, et son texte ne contient ni le motif ni la réservation.

*Mesuré.* S5, avec `network_error` et une fiche sans adresse.
- Sur 58ad5d30 : « le motif figure-t-il dans les incidents ? false ».
- Sur 061669e3 : true, via la ligne `send_failure` consignée.
- Le cas incertain n'y est pas distingué non plus : le texte dit « NON ENVOYÉ ».

*Correctif proposé.* Passer le motif à `prevenirCodeIncomplet` et l'ajouter en fin de texte quand `!parti`, après l'action, à cause de la coupe à 300 caractères.

---

**4. MINEUR — `lib/cron-arrival-code.js:709`**

*Mécanisme.* `${sendResult.reason || sendResult.error}` : `sendViaBeds24` rend `error: result.errors || 'unknown'`, qui peut être un tableau ou un objet (`lib/cron-beds24.js:533`).

*Mesuré.* S7 : le SMS dit `Motif : [object Object] (réservation A).` Sur 061669e3, ce texte ne partait pas au premier refus.

*Correctif proposé.* Reprendre la logique de `fmtSendErr` (`lib/cron-messages.js:36-41`, qui stringifie l'objet).

---

**5. MINEUR — documentation — `docs/kb/codes-acces.md:45-50`, `docs/kb/alertes.md:660-668`, `docs/kb/dettes-v1.md:153`**

Cinq phrases ne disent pas ce que fait le code :
- « dès le premier refus » est faux pour un second refus sur le même logement dans l'heure (constat 1).
- « Un canal e-mail pas encore branché (`differe`) n'alerte pas » (`codes-acces.md:50`) est faux quand il manque une information. S9 : 1 SMS « NON ENVOYÉ par le canal, il y manque Adresse… », comportement déjà présent dans 061669e3. Aujourd'hui `ENVOI_EMAIL_BRANCHE = true`, donc `differe` n'existe pas en production.
- « réservation sans messagerie, refus du provider » (`alertes.md:662`) omet le cas incertain (constat 2).
- « Une seule alerte par code » est faux avec deux modèles `menage_done` actifs, l'un incomplet et l'autre complet. S8 : 2 SMS pour la même réservation, ce qui existait déjà avant (2 aussi sur 061669e3).
- Le libellé cité est « Code d'accès non envoyé », alors que le vrai est `CODE D'ACCÈS NON ENVOYÉ` (`founder-notify.js:118`).

*Correctif proposé.* Ajuster ces phrases au comportement mesuré.

---

**6. MINEUR — lecteurs de `send_failure` (hors diff)**

Deux endroits du dépôt comptent encore sur `send_failure` pour le code :
- `scripts/observer-test-canal-email.js:234` filtre `/email|send_failure|message_non_envoye/`. Mesuré : `code_acces_non_envoye` et `message_envoye_incomplet` sont tous deux ignorés. Un code d'accès raté sur le canal e-mail (réservation Offline) y est désormais compté « hors chantier », et le contrôle reste VERT. Avant, il était ROUGE.
- `scripts/rendre-sejours-au-bien.js:20` annonce encore « incident `send_failure` » pour ces envois. Pour le code d'accès, c'est maintenant un SMS immédiat au fondateur.

Aucun écran, compteur ou liste d'acquittement ne lisait `send_failure` (voir « Catégories sans constat réel »).

*Correctif proposé.* Ajouter `code_acces` au motif de l'observateur et mettre à jour le commentaire du script.

---

**7. MINEUR — tests — `tests/arrival-code-manquant-alerte.test.js`**

*Mécanisme.* « Refus + balise inconnue, sans information manquante → une seule alerte » n'est tenu par aucun test de comportement, seulement par l'expression régulière qui vérifie la forme du code dans `tests/canal-routage-envoi.test.js:319`.

*Mesuré.*
- Mutation M9 (`!aPrevenir` remplacé par `!bati.manquants.length`) : 1 rouge, uniquement le test de forme.
- Mutation M15 (`!(aPrevenir && bati.manquants.length)`) : même résultat.
- Une réécriture équivalente rougirait sans défaut, et une garde fausse mais de la bonne forme passerait.

*Correctif proposé.* Un test de comportement : modèle `{heure_arrivee}`, fiche complète, refus du canal → `['message_envoye_incomplet']`.

---

**Catégories sans constat réel**

- **Seuil 1 effectif.** S1 : un refus isolé donne 1 SMS et 1 e-mail. Le SMS contient l'action, et aucun PIN.
- **Coupe du SMS.** La partie fixe du SMS, jusqu'à la fin de l'action, fait 146 caractères. Il reste 154 caractères pour le nom du logement et celui du voyageur. Avec le maximum de saisie du nom (100, `pages/logement-nouveau.html:153`) et un voyageur de 40 caractères, l'action reste entière ; seul le motif est coupé.
- **Bruit.** Une alerte par code. Pas de nouvelle alerte au cycle suivant (journal ; test `dejaEnvoye`). L'escalade ne s'applique pas puisque les messages diffèrent d'une réservation à l'autre. Le seul doublon mesuré (S8) existait déjà avant.
- **Mode Test et `differe` sans information manquante.** Aucune alerte, tenu par les tests et par la mutation M8 (2 rouges).
- **Ordre.** L'alerte part toujours après `noterEnvoi` et après le passage du code en `active` : M11 donne 5 rouges. Le try/catch est tenu : M12 donne 1 rouge.
- **Données personnelles.** Le nom complet du voyageur part au fondateur et est conservé dans `automation_incidents.detail`, lisible par les membres du compte (RLS sur `reglages`). C'est déjà le cas de `message_envoye_incomplet` (nom et dates, dette 137) ; avant, `send_failure` ne portait que l'identifiant. Pas de PIN, et l'e-mail est échappé par `esc()`.
- **Retrait de `send_failure`.** Aucun écran, compteur ou liste d'acquittement n'en dépendait :
  - `api/ecran/aujourdhui.js` (`TYPES_ALARME`) et `api/incidents-acquitter.js` n'ont que quatre types, sans `send_failure` ;
  - `lib/cron-alerting.js` ne lit que `event_loop` et `table_growth` ;
  - aucune contrainte CHECK sur `automation_incidents.type` (`migrations/0000-schema-initial.sql:1255`).
- **Contre-épreuve sur `contre/`.** 6 rouges : 5 dans le fichier d'alerte, plus le test de forme. Tous pour le type, le seuil ou l'absence d'alerte. Le test du nom long rougit par `TypeError` (alerte absente) plutôt que par une assertion, ce qui est acceptable. Les tests « envoi réussi » et `differe` sont des non-régressions, verts des deux côtés.
- **Mutations.** Rougissent toutes : M1 (2 rouges), M2, M4, M5, M6, M7, M13, M16 (1 chacune), M3 (5), M8 (2), M10 (2), M11 (5), M12 (1), M14 (4). Survivent aux tests de comportement : M9 et M15 (constat 7).
- **Horloge décalée** (`tests/outils/horloge-decalee.js`) : 56/56 sur les trois fichiers à J+0, J+4, J+60, J+200 et J+400.

## Review 3 — reçue le 10 novembre 2026 (correctifs de la review 2 seulement) — LA DERNIÈRE

- Lancée sur : `/home/claude/hotesmart-141`, branche `dette-141-alerte-apres-journal`,
  plage `58ad5d30d93bfd3063efff2f0a03d04839bf4ed6..4295c17b8d262f6c34417aad458bbdfc33050fdf`.
- Contrôle d'arbre : arbre, branche et SHA déclarés conformes au brief.
- Contrôle des fichiers cités : les dix fichiers « du diff » sont exactement
  ceux de `git diff --name-only` de la plage ; les fichiers « lus pour le
  contexte » sont hors diff, déclarés comme tels.
- Aucun constat de sécurité. C'est la dernière review (exception du
  27 octobre 2026) : ce qu'elle trouve se corrige sans nouvelle review.
- Seule retouche de transcription : les entités HTML du transport (`&gt;`,
  `&lt;`, `&amp;`) sont rendues par leur caractère.

### Rapport, mot pour mot

Arbre lu : /home/claude/hotesmart-141 — branche : dette-141-alerte-apres-journal — SHA lu : 4295c17b8d262f6c34417aad458bbdfc33050fdf

Plage relue : `58ad5d30d93bfd3063efff2f0a03d04839bf4ed6..4295c17b8d262f6c34417aad458bbdfc33050fdf`, un seul commit. Je n'ai rien modifié dans l'arbre : `git status --short` ne montre que `?? node_modules`, qui y était déjà. Tous les essais sont dans `/tmp/revue141c` :
- `copie/` : l'état 4295c17b ;
- `avant/` : l'état 58ad5d30 ;
- `contre/` : le code de 58ad5d30 avec les tests neufs ;
- `mut/` : les mutations ;
- `scripts/` : les scripts de mesure ;
- `copie/tests/zz-revue141c.test.js` : un fichier de test jetable.

`scripts/pgrest.js` fait tourner le **vrai** client `@supabase/supabase-js` 2.102.1. Seuls le `fetch` sortant (un faux serveur PostgREST, qui applique `cs.` comme le `@>` de jsonb) et Brevo sont remplacés. Les numéros et adresses utilisés sont factices.

**Fichiers cités**

Fichiers du diff (tous présents dans `git diff --name-only 58ad5d30..4295c17b`) :
- `lib/cron-arrival-code.js`
- `lib/founder-notify.js`
- `tests/arrival-code-manquant-alerte.test.js`
- `tests/founder-notify-cle.test.js`
- `docs/kb/alertes.md`
- `docs/kb/codes-acces.md`
- `docs/kb/dettes-v1.md`
- `docs/recette/reviews-dette-141.md`
- `scripts/observer-test-canal-email.js`
- `scripts/rendre-sejours-au-bien.js`

Fichiers lus pour le contexte, hors diff, au même SHA :
- `lib/cron-messages.js`, `lib/email-guestflow.js`, `lib/email-voyageur.js`, `lib/channels/channex.js`, `lib/cron-beds24.js`, `lib/canal-voyageur.js`, `lib/envoi-ota.js`, `lib/cron-shared.js`, `lib/cron-classify.js`, `lib/contradiction-prix.js`, `lib/reponse-partenaire.js`, `lib/canaux-du-bien.js`, `lib/guestflow-garde.js`
- `tests/escalade-alertes.test.js`
- `migrations/0000-schema-initial.sql`
- `node_modules/@supabase/postgrest-js/dist/index.cjs`, par le lien prescrit

---

**1. IMPORTANT — touche l'envoi au voyageur — `lib/cron-arrival-code.js:731-733` et `:766` ; cause hors diff : `lib/cron-messages.js:219-235` ; documentation : `docs/kb/alertes.md:662-663`, `docs/kb/codes-acces.md:50-52`**

*Mécanisme.* Le correctif du constat 2 de la review 2 se fie à `sendResult.incertain`. Or, sur le **canal e-mail** (réservation Offline avec une adresse), `sendGuestMessage` ne transmet pas ce drapeau.
- `envoyerHtml` le pose bien quand Brevo est coupé pendant le POST : `{ ok:false, raison:'brevo_injoignable: …', permanent:false, incertain:true }` (`lib/email-guestflow.js:285-286`).
- Mais la branche e-mail de `sendGuestMessage` rend un objet qui ne garde que `ok, canal, destinataire, expediteur, permanent, quota, error`. Le drapeau est perdu.
- Les chemins Channex (`network_error`) et Beds24 (exception) le transmettent, eux.

*Scénario.* Le voyageur a réservé en direct, donc le code part par e-mail. La connexion avec Brevo est coupée après l'envoi du POST : l'e-mail est peut-être parti. Le fondateur reçoit pourtant « NON ENVOYÉ par le canal : à lui transmettre vous-même », c'est-à-dire exactement le texte que le constat 2 voulait supprimer. Le voyageur peut recevoir le code deux fois. Les deux fiches affirment au contraire que toute coupure pendant l'envoi produit « PEUT-ÊTRE REÇU ».

*Mesuré.*
- `scripts/email-incertain.js` (vrai `sendGuestMessage`, `fetch` qui lève ECONNRESET) :
  - un seul appel réseau, `POST https://api.brevo.com/v3/smtp/email` ;
  - le résultat ne contient pas de champ `incertain` (`incertain present ? false`) ;
  - même coupure sur Channex : `{"ok":false,"incertain":true,"error":"network_error"}`.
- `R1`, dans le harnais du vrai `processArrivalCodes`, avec cette forme mesurée :
  - `Code d'accès de Ana Lopez NON ENVOYÉ par le canal : à lui transmettre vous-même, … Motif : brevo_injoignable: fetch failed (réservation ARRIVANTE).` ;
  - fiche incomplète : « NON ENVOYÉ par le canal, il y manque Adresse … ».
- Aucun test ne le voit : tous les tests remplacent `sendGuestMessage`.

*Correctif proposé.*
- Dans `lib/cron-messages.js`, branche e-mail, ajouter une ligne : `incertain: envoi.ok ? false : envoi.incertain === true,`.
- Aucun autre lecteur n'en souffre : sur l'e-mail, `envoyerEtJournaliser`, `cron-classify` et `brouillons-dus` ne lisent pas `incertain`, et `classerEnvoiOta` n'est appelé que pour la messagerie du canal.
- Ajouter un test qui traverse le vrai `sendGuestMessage` sur une réservation Offline.

---

**2. MINEUR — touche l'envoi au voyageur — `lib/cron-arrival-code.js:520` et `:855` ; `lib/founder-notify.js:280-281` ; `docs/kb/codes-acces.md:55` ; `docs/kb/alertes.md:677`**

*Mécanisme.* La clé ne porte que la réservation (`code_acces:<id>`, `code_incomplet:<id>`). Le journal `message_sent_log`, lui, garantit un appel par réservation **et par modèle**, et la boucle de `processArrivalCodes` parcourt chaque modèle `menage_done` actif. Deux modèles de code sur la même réservation partagent donc la même clé, et la seconde alerte se tait dans l'heure. Plusieurs phrases sont donc fausses :
- `codes-acces.md:55` : « Deux modèles de code actifs sur un logement donnent chacun leur alerte » ;
- le commentaire `founder-notify.js:280-281` : « un seul appel par fait » ;
- le commentaire `cron-arrival-code.js:516-517` : l'alerte « ENVOYÉ » ne tait plus un « NON ENVOYÉ » — c'est vrai entre deux réservations, faux entre deux modèles d'une même réservation.

*Mesuré* (vrai `reportIncident` derrière le harnais) :
- `R2` : deux modèles complets, tous deux refusés → 2 appels avec `code_acces:ARRIVANTE`, 2 tâches, **1 SMS**.
- `R3` : deux modèles incomplets ; le premier part, le second est coupé (incertain) → 1 SMS seulement, qui dit « Code d'accès ENVOYÉ à Ana Lopez …, il y manque Adresse : envoyez-le-lui depuis Messages ». Le « PEUT-ÊTRE REÇU » du second modèle est consigné sans être envoyé.
- Impact réel faible : dans R3, le voyageur a le code par le premier modèle.

*Correctif proposé.* Deux voies :
- ajouter le modèle à la clé (`code_acces:${todayArrival.id}:${template.id}`, et passer `template.id` à `prevenirCodeIncomplet`) — la mutation M15 le fait, et seul le test qui vérifie la valeur exacte des clés rougit ;
- ou bien corriger les trois phrases pour dire « une alerte par réservation ».

---

**3. MINEUR — `lib/founder-notify.js:334-336` (aussi les commentaires `:6-7` et `:153-157`)**

*Mécanisme.* Le pied de l'e-mail dit toujours « Anti-spam : 1 par type et par bien toutes les N min », même quand la clé a resserré l'anti-spam à une réservation.

*Mesuré* (`scripts/pied.js`, vrai client) : deux codes refusés sur La bulle dans la même minute donnent 2 e-mails. Le second dit « Anti-spam : 1 par type et par bien toutes les 60 min. », démenti par sa propre existence.

*Correctif proposé.* Quand une clé est passée, écrire « 1 par réservation » (ou « par fait »). Ajuster l'en-tête et le commentaire de `reportIncident`.

---

**4. MINEUR — touche l'envoi au voyageur (texte et tests) — `lib/cron-arrival-code.js:509` ; `tests/arrival-code-manquant-alerte.test.js:156-184`**

*Mécanisme.* La branche incertaine de l'alerte « code incomplet » produit le texte le plus long. Or le test qui balaie la coupe du SMS ne couvre que les cas « envoyé » et « refusé ».

*Mesuré* (`R4` à `R6`, voyageur « Marie-Christine Dupont-Lefebvre », nom de logement de longueur croissante) :

| Branche | Action entière jusqu'à un nom de logement de |
|---|---|
| Incomplet, refus | 79 caractères |
| Incomplet, incertain, 1 information manquante | **26 caractères** |
| Incomplet, incertain, 2 informations manquantes | **7 caractères** |
| Code non envoyé, incertain | 80 caractères |

- « PEUT-ÊTRE REÇU » tient dans **tous** les cas.
- Cas réel « Cœur de vie 23 », 2 informations manquantes, nom de voyageur long : le SMS est coupé à « …avant de le lui trans ». « vérifiez le fil, puis complétez-le » tient.
- Avec un nom de logement de 100 caractères (le maximum saisissable) et un nom de voyageur long, « vérifiez le fil » est perdu.

*Correctif proposé.*
- Ajouter `{ ok:false, incertain:true, error:'network_error' }` aux envois balayés par ce test.
- Raccourcir le texte, par exemple : « … PEUT-ÊTRE REÇU (coupure), il y manque X : vérifiez le fil avant de le compléter dans vos tâches. »

---

**5. MINEUR — documentation — `docs/kb/codes-acces.md:52`, `docs/kb/dettes-v1.md:153`, `lib/cron-arrival-code.js:729`**

Ces trois endroits renvoient à la « dette 144 » pour la tâche de l'hôte qui dit encore « impossible » sur un envoi incertain. Aucune rangée 144 n'existe :
- `git log --all -S"| 144 |" -- docs/kb/dettes-v1.md` ne trouve que ce commit, qui ne l'écrit que dans la rangée 141 ;
- `origin/main` et `origin/staging` n'ont pas non plus de rangée 142 à 149.

La review 2 avait déjà signalé un renvoi vers une dette absente du registre ; elle a maintenant un numéro, mais toujours pas de ligne.

*Correctif proposé.* Écrire la rangée 144 : envoi incertain du code d'accès, la tâche dit « impossible ». Y ajouter le canal e-mail du constat 1 s'il n'est pas corrigé ici.

---

**6. MINEUR — tests — `lib/founder-notify.js:284`, branche `{ ...detail, cle }`**

*Mesuré.* La mutation M4 (`{ ...detail, cle }` remplacé par `{ cle }`) rend **0 rouge** sur les sept fichiers concernés. Le cas « detail objet + clé » n'a aujourd'hui aucun appelant, mais `reportIncident` est partagé.
- Le comportement réel est juste (`scripts/objet-cle.js`) : la ligne stockée est `{"message":"Prix","canaux":["airbnb"],"cle":"k1"}`, le SMS porte le message, et la même clé se tait.
- Effet latent relevé au passage : l'escalade compare le message sans tenir compte de la clé. Une clé neuve dont le message est identique à celui d'une autre hérite de « anti-spam porté à 120 min — élargi parce que ce fait persiste ». Aucun appelant actuel n'est concerné, car les messages des codes d'accès contiennent la réservation.

*Correctif proposé.* Un test sur un `detail` objet avec une clé, dans `tests/founder-notify-cle.test.js`.

---

**Catégories sans constat réel**

- **Appelants sans clé : inchangés.**
  - `scripts/sans-cle-identique.js` compare, sur `avant/` et `copie/`, les requêtes HTTP, les lignes insérées, les SMS et les e-mails. Sept cas : `detail` en chaîne, objet, objet sans `message`, `null`, seuil 2, `notifyFounder`, et un historique de deux alertes pour faire jouer l'escalade (`fenetreEscaladee`). Six sont identiques à l'octet.
  - Le septième (même type, sans clé) ne diffère que par le libellé voulu (« CODE D'ACCÈS — ENVOI NON CONFIRMÉ »), pas par les requêtes ni par les lignes insérées (`scripts/diff-cas6.js`).
  - Aucun appelant du dépôt ne passe d'option `cle` (vérifié par grep, y compris les appels indirects de `sonner`, `signaler` et `notifyFounder`).
  - Aucun autre code n'émet `code_acces_non_envoye` ni `message_envoye_incomplet`.
- **Forme réelle de la requête.**
  - postgrest-js 2.102.1, `contains` (`index.cjs:1986-1990`) : un objet devient `cs.${JSON.stringify(value)}`.
  - Requête mesurée : `GET …?select=id,alerted&type=eq.code_acces_non_envoye&created_at=gte.…&property_id=eq.0db6b39b&detail=cs.{"cle":"code_acces:A"}`.
  - `detail` est bien en `jsonb` (`migrations/0000-schema-initial.sql:1260`). La clé n'est pas dans `property_id` (POST mesuré).
- **Lignes historiques sans clé.**
  - Elles ne taisent pas une alerte avec clé (`alerted = true`).
  - À l'inverse, une ligne avec clé tait un appel sans clé du même type sur le même logement. C'est le comportement par logement attendu, et aucun appelant de ces types ne passe sans clé.
- **Lecture d'anti-spam en échec.** Lecture `cs.` refusée avec une erreur 404 : 3 alertes sur 3 en 10 minutes pour la même clé. C'est le fail-open d'avant, sans changement.
- **Boucle quand `noterEnvoi` échoue** (même code retraité toutes les 5 minutes pendant 24 h, vrai client) :
  - avec clé : 4 SMS, à 0 h, 2,08 h, 6,17 h et 14,25 h ; sans clé, sur 58ad5d30 : exactement les mêmes 4 SMS ;
  - si le motif varie à chaque passage : 23 SMS des deux côtés ;
  - l'anti-spam et l'escalade tiennent donc avec la clé comme sans.
- **Dos-à-dos.** Vrai client : D puis A donnent 2 SMS, et A rejoué ne donne rien.
- **« PEUT-ÊTRE REÇU » sur Channex et Beds24, motif lisible.**
  - Channex : `incertain` est transmis (`lib/channels/channex.js:246`, mesuré).
  - Beds24 : l'exception produit `incertain:true` (`lib/cron-beds24.js:550`).
  - Aucun canal ne rend d'objet `Error` dans `error`. Le seul objet possible est `result.errors` de Beds24, stringifié par `motifDe`.
  - La mutation M13 (inverser `reason` et `error`) ne rougit pas, mais aucun canal ne rend les deux à la fois : ce n'est pas un défaut.
- **Contre-épreuve sur `contre/` : 8 rouges, chacun pour sa raison.**
  - Clés des deux alertes.
  - Le texte incertain : on obtient « NON ENVOYÉ » au lieu de « PEUT-ÊTRE REÇU ».
  - Le motif en fin de texte, et `[object Object]`.
  - Dans `founder-notify-cle` : `b.alerted` vaut false, et le `detail` ne contient pas la clé.
  - Les non-régressions (sans clé, même clé, autres types, « refus + balise inconnue ») restent vertes des deux côtés.
- **Faux client de `tests/founder-notify-cle.test.js`.**
  - Il a la même forme de constructeur que le vrai (enchaînable, résolu seulement par `then`), avec `insert().select().maybeSingle()` et `update().eq()`.
  - Son `contains` est superficiel (`===`) alors que `@>` est profond. Pour des valeurs en chaîne, c'est équivalent : le vrai client donne les mêmes issues (2 SMS au dos-à-dos, la même clé se tait).
  - Seul manque : il ne simule jamais `{ data:null, error }`, mais ce chemin de repli est mesuré plus haut.
- **Mutations** (`scripts/muter.js`, sept fichiers) :
  - rougissent : M1 (sans `contains`, 1 rouge), M2 (`contains` sans condition, 3), M3 (2), M5, M6, M7, M8, M9, M10 (2), M11, M12, M14, M15 ;
  - survivent : M4 (constat 6) et M13 (sans objet).
- **Horloge décalée** (`tests/outils/horloge-decalee.js`) : 62/62 sur `arrival-code-manquant-alerte`, `founder-notify-cle` et `canal-routage-envoi`, à J+0, J+4, J+60, J+200 et J+400. Les sept fichiers concernés passent à 104/104 à l'heure réelle.
- **Scripts.** `observer-test-canal-email.js` compte maintenant `code_acces_non_envoye` et `message_envoye_incomplet`. Le commentaire de `rendre-sejours-au-bien.js` est exact pour un code complet.
