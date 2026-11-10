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
