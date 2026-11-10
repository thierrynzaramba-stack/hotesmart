# Reviews du lot « fil en direct » (branche `messages-fil-en-direct`)

Le constat 1 de la review 1 touche l'ENVOI AU VOYAGEUR (un envoi en double
possible) : le lot passe sous l'exception de Thierry du 27 octobre 2026,
trois reviews au plus. Chaque rapport est recopié ici mot pour mot, dès
réception.

## Review 1 — reçue le 10 novembre 2026

- Lancée sur : `/home/claude/hotesmart-direct`, branche `messages-fil-en-direct`,
  plage `53381e947ea7bdae91d36df6e72d5886b978c24c..e6173c9811df80d458740a4eaf5f12cca20806ac`.
- Contrôle d'arbre : arbre, branche et SHA déclarés conformes au brief.
- Contrôle des fichiers cités : les sept fichiers « du diff » le sont. Les
  sept fichiers « lus pour le contexte » sont hors du diff ; la review les
  déclare comme tels, et chaque constat porte sur un fichier du diff.

### Rapport, mot pour mot

Arbre lu : /home/claude/hotesmart-direct — branche : messages-fil-en-direct — SHA lu : e6173c9811df80d458740a4eaf5f12cca20806ac

**Fichiers cités**
- Fichiers du diff : `api/messages.js`, `pages/messages.html`, `shared/messages-direct.js`, `tests/messages-direct-api.test.js`, `tests/messages-direct-dom.test.js`, `docs/specs/spec-messages-fil-en-direct.md`, `docs/kb/messages-v5.md`
- Fichiers lus pour le contexte : `lib/guestflow/brouillons-dus.js`, `lib/require-permission.js`, `lib/record-message.js`, `api/channel-webhook.js`, `lib/channels/channex.js`, `lib/channels/beds24.js`, `api/inbound-email.js`

**Mesures faites.** Les 3 fichiers de tests neufs passent à 34/34, à l'heure réelle comme à J+60 et J+200. La suite complète donne 7817/7817, `fail 0`. `i18n-check` est OK. Les scénarios de course ont été rejoués dans le vrai banc, par des fichiers placés hors de l'arbre, dans `/tmp/revue-direct/`. Les mutations de l'API ont été faites sur une copie `git archive` du SHA. L'arbre est intact (`git status` : seul `node_modules` est non suivi).

---

**1. BLOQUANT (envoi au voyageur, régression du lot)** — `pages/messages.html:3797` et `:778`
- **Mécanisme.** `relireListe` appelle `rechargerTaches()`, qui écrase `etat.taches` avec les seules tâches `pending_validation`. Cas « Modifier puis Envoyer » d'une proposition différée :
  1. `reserver` passe la tâche en `sending`.
  2. Pendant `posterMessage`, une relecture de liste la retire de l'écran.
  3. Une fois le message parti, `lancerEnvoi` cherche la tâche dans `etat.taches`, ne la trouve pas, et n'appelle jamais `cloreTache`.
- **Conséquence.** La tâche reste en `sending`. Dix minutes plus tard, `brouillons-dus.js` la rend à l'hôte avec « impossible de savoir si le message est parti » et prévient le fondateur. Un second clic de l'hôte envoie le message en double au voyageur. C'est exactement le scénario grave que décrit le commentaire de `lancerEnvoi` (constat 5 de la troisième revue).
- **Mesuré.** POST partis : `["brouillon","reserver","sendMessage"]`, aucun `proposition`.
- **Condition.** Un message arrive dans un autre fil pendant l'envoi, et la liste n'a pas été relue depuis une minute.
- **Pourquoi c'est une régression.** Avant le lot, `rechargerTaches` n'était appelé que par « Proposer », un geste de l'hôte.
- **Correctif.**
  - Dans `lancerEnvoi`, garder l'objet `x` trouvé avant `reserver` et clore celui-là, comme le fait déjà `envoyerProposition`.
  - Dans `relireListe`, ne plus écraser les tâches `en_cours`, `echec` ou en édition : fusion au lieu du remplacement.
  - Test à ajouter : reprendre `/tmp/revue-direct/course-recharger.test.js`.

**2. IMPORTANT — doublon permanent à l'écran après un envoi** — `shared/messages-direct.js:92-96`, `pages/messages.html:782` et `:995`
- **Mécanisme.** La bulle `_local` n'est remplacée que si la ligne du cœur arrive comme une ligne NEUVE. Si un cycle ramène cette ligne pendant le retour de `posterMessage`, ou pendant la clôture `action=proposition`, la bulle locale est posée après coup. Au cycle suivant, `deja` court-circuite la fusion et la bulle n'est jamais réconciliée.
- **Mesuré.** Envoi d'une proposition : 2 bulles « Avec plaisir », toujours là au cycle suivant.
- **Fréquence.** La fenêtre va d'environ 0,1 à 1 s par envoi, face à une relecture toutes les 5 s : quelques pourcents des envois.
- **Pourquoi les tests ne le voient pas.** Le test DOM « aucun doublon » ne couvre que l'ordre « bulle locale puis ligne du cœur ».
- **Correctif.**
  - Ne pas poser la bulle `_local` si `c.messages` contient déjà une ligne sortante du cœur au même texte, à moins de 2 min.
  - Ou bien, dans `fusionnerMessages`, une passe finale qui retire la bulle `_local` jumelle.
  - Test à ajouter : `/tmp/revue-direct/course-doublon.test.js`.

**3. IMPORTANT — un message peut ne jamais apparaître dans le fil ouvert** — `api/messages.js:671` (`gte('sent_at', apres)`) et `:663`
- **Mécanisme.** Le point de reprise est le `sent_at` le plus récent connu, c'est-à-dire l'instant donné par le provider, pas l'ordre d'insertion en base. Plusieurs producteurs écrivent des lignes dont le `sent_at` est antérieur à leur insertion :
  - le webhook Channex (`inserted_at`, `channel-webhook.js:390`) ;
  - l'import de rattrapage Channex (`channex.js:634`) ;
  - Beds24, relevé par le cron (`beds24.js:108`) ;
  - l'e-mail entrant (`inbound-email.js:502`).
- **Scénario.** Le voyageur écrit à 10:00:00. La réponse de l'hôte est enregistrée à 10:00:01 et un cycle la lit. Le webhook du voyageur arrive ensuite, avec `sent_at` 10:00:00 : il ne sera jamais lu.
- **Rien ne le rattrape.** `dernier` exclut le fil ouvert, donc la liste ne se relit pas pour ce fil.
- **Mesuré.** Avec un double qui applique la même règle que le serveur, après 5 cycles le fil affiche `["Bonjour","Je regarde"]`, avec 0 relecture de liste.
- **Pour Beds24, c'est le cas normal** dès qu'un message plus récent existe. La phrase du §10 de la spec (« La page les montrera dès qu'ils sont dans le cœur ») est donc fausse.
- **Correctif.**
  - Un curseur sur l'ordre d'insertion (`created_at` posé par la base), rendu par le serveur et renvoyé tel quel par la page.
  - Rendre l'`id` du message pour un dédoublonnage exact.
  - Le même curseur pour `dernier`.
- **Repli minimal.** Lire avec un recouvrement (`apres` moins 10 min) et garder le dédoublonnage existant. Cela ne couvre pas l'import de rattrapage.

**4. IMPORTANT (test) — la barrière de COMPTE n'est tenue par aucun test** — `tests/messages-direct-api.test.js`
- **Mutations (sur la copie, pas dans l'arbre).**
  - Retirer `.eq('user_id', userId)` sur l'une ou l'autre des trois lectures (messages `:671`, propositions `:685`, `dernier` `:660`) : 10/10 restent verts.
  - Retirer le filtre de périmètre `.or(...)` sur chacune : 2 rouges à chaque fois.
  - Retirer le contrôle d'archivage : 1 rouge.
- **Pourquoi c'est important.** La garde ne désigne ici aucune ressource. Pour un titulaire, `filtreOr` vaut `null`, et `.eq('user_id')` est la seule séparation entre comptes. Or `fil` vient du client, et les identifiants de réservation Beds24 sont numériques, donc devinables.
- **Le code est juste aujourd'hui** ; c'est le filet de test qui manque.
- **Correctif.** Ajouter au double des lignes et des tâches d'un autre compte portant le même `booking_id`, et affirmer que rien ne sort, pour le titulaire comme pour un membre.

**5. MINEUR — fusion des propositions** — `shared/messages-direct.js:127`
- (a) Un cycle lu avant la clôture, mais traité après `retirerTache`, ré-ajoute la proposition rejetée ou envoyée pendant 5 s. Un clic sur Envoyer reçoit alors un 409 de `reserver` (rien ne part), mais l'hôte lit « déjà partie » après un rejet.
- (b) La fusion crée de nouveaux objets. `envoyerProposition` pose `etatEnvoi = 'echec'` sur l'ancien. Si un remplacement a eu lieu entre-temps, la copie à l'écran reste bloquée sur « en_cours », sans boutons, jusqu'au rechargement. C'est rare : il faut un échec d'envoi et un changement simultané.
- **Correctif.** Fusionner en place (`Object.assign` sur l'objet existant), et garder une courte mémoire des identifiants clos par la page.

**6. MINEUR — règle 1 incomplète, et le KB affirme le contraire** — `pages/messages.html:3758` et `:571`
- Le seul `<details>` de la page est le menu ⋯ de l'en-tête, hors du fil déroulé. Le test `deroule.querySelector('details[open]')` ne trouve donc jamais rien.
- **Mesuré.** Menu ouvert, puis un cycle avec un message neuf : le menu est remplacé et refermé sous la main de l'hôte. Même chose pour le bandeau d'échéance au-dessus de la saisie.
- `docs/kb/messages-v5.md` affirme pourtant qu'« un menu ouvert fait attendre le rendu ».
- **Correctif.** Tester aussi l'en-tête et le bandeau, ou ne redessiner que le fil déroulé.

**7. MINEUR — D2 (page oubliée) contournée par le défilement que la page fait elle-même** — `:674` et `:3827`
- `renderFil` fixe `scrollTop`. Selon la norme CSSOM, un défilement programmé émet un événement `scroll`, que `gesteDirect` compte comme un geste de l'hôte.
- Une page oubliée sur un fil actif reste donc à 5 s.
- Lu au code, non mesuré : jsdom n'émet pas `scroll`.
- **Correctif.** Ne pas compter `scroll` comme un geste : `wheel`, `touchstart`, `keydown` et `pointerdown` couvrent déjà le défilement de l'hôte.

**8. MINEUR — case performance (§6) optimiste**
- **La cible « < 1 Ko quand rien n'est neuf » n'est pas tenue.** Le `gte` renvoie à chaque cycle le dernier message connu, et `taches` renvoie à chaque cycle le texte complet des propositions (`suggested_reply`, `summary`). Le message d'arrivée fait 1 à 3 Ko : on dépasse les « < 12 Ko/min » annoncés.
- **Le tableau omet des appels.** Une relecture de liste coûte 2 appels (la collection, puis la lecture Supabase de `agent_tasks`), pas 1. Le POST `lu` de chaque arrivée n'y figure pas non plus.
- **Le reste est cohérent.** 12 appels par minute au plus, puisque le minuteur est posé après la fin de chaque relecture. Fil ouvert : 6 à 8 requêtes Supabase (environ 7 annoncées). Liste seule : 3 à 5 (environ 4 annoncées).
- **Correctif.** Un curseur strict (voir le point 3), et ne renvoyer les propositions que si leur empreinte a changé.

**9. MINEUR — fenêtre de 2 min calculée sur deux horloges** — `shared/messages-direct.js:96`
- La bulle locale porte l'heure du navigateur, la ligne du cœur celle du serveur.
- Un poste dont l'horloge est décalée de plus de 2 min garde le doublon pour toujours.

**10. MINEUR — `complet: false`**
- Le §3 de la spec et le commentaire `:3745-3747` disent que cette valeur fait relire le fil entier. Ce n'est pas le cas : `dernier` exclut le fil ouvert, donc la liste ne se relit pas.
- Sans conséquence en pratique : le cycle suivant reprend à partir du 200ᵉ message. Mais le texte affirme une chose fausse.

**11. MINEUR — deux cas où l'écran ment par omission**
- **401** (`:3714`) : la relecture s'arrête sans rien dire. L'hôte lit un fil qu'il croit à jour. Afficher aussi la mention « Mise à jour interrompue ».
- **Question produit pour Thierry** : une page restée 15 min sans geste marque encore comme lus les messages du voyageur, donc la pastille « non lu » disparaît alors que personne n'était devant l'écran.

**12. MINEUR (tests) — promis par le §8 de la spec, absents**
- Le retour sur l'onglet déclenche une relecture immédiate (aucun `visibilitychange` n'est simulé).
- Le premier geste après 15 min déclenche une relecture et rétablit les 5 s.
- `no-store` sur un 401.
- Le repli de lecture sans la colonne `origine`.

---

**Catégories sans constat réel**
- **Sécurité de la lecture neuve.**
  - Le périmètre est appliqué sur les trois lectures, ce que prouvent les mutations.
  - X-Compte est revalidé par la même garde que la collection (`compteDelegue`).
  - Un fil hors périmètre rend la même forme vide qu'un fil vide : pas de révélation d'existence.
  - Les entrées sont validées après la garde, et `fil` n'est utilisé que dans `.eq`/`.neq`, sans interpolation dans `.or`.
  - Le `Cache-Control` posé en tête du handler ne change que la réponse 405. Les autres sorties l'avaient déjà, par `posterEnTetesPrives`.
- **Boucles et rafales d'appels.**
  - Un seul minuteur : `planifierDirect` efface toujours le précédent.
  - Une seule relecture à la fois (`enCours`).
  - `visibilitychange` et les gestes sont bornés par `enCours`.
  - Onglet caché : 0 appel, puisque `relireDirect` vérifie lui-même la visibilité.
  - Pas de minuteur qui fuit au changement de fil, et la réponse d'un fil quitté est bien jetée.
- **POST `action=lu`.** Une fois par arrivée, seulement onglet affiché et avec le droit d'écriture. Aucun déclenchement à tort trouvé.

**Scénarios réutilisables comme tests** (dans `/tmp/revue-direct/`, hors de l'arbre)
- `course-recharger.test.js` (constat 1)
- `course-doublon.test.js` (constat 2)
- `insertion-tardive.test.js` (constat 3)
- `menu-ouvert.test.js` (constat 6)

## Review 2 — reçue le 10 novembre 2026 (correctifs seulement)

- Lancée sur : `/home/claude/hotesmart-direct`, branche `messages-fil-en-direct`,
  plage `e6173c9811df80d458740a4eaf5f12cca20806ac..6b467ecee765e672b1687dd584a6bcc7bf12a082`.
- Contrôle d'arbre : arbre, branche et SHA déclarés conformes au brief.
- Contrôle des fichiers cités : les huit fichiers « du diff » le sont. Les cinq
  fichiers « lus pour le contexte » sont hors du diff, déclarés comme tels ;
  chaque constat porte sur un fichier du diff.

### Rapport, mot pour mot

Arbre lu : /home/claude/hotesmart-direct — branche : messages-fil-en-direct — SHA lu : 6b467ecee765e672b1687dd584a6bcc7bf12a082

**Fichiers cités**
- Fichiers du diff : `pages/messages.html`, `api/messages.js`, `shared/messages-direct.js`, `tests/messages-direct-api.test.js`, `tests/messages-direct-dom.test.js`, `tests/messages-direct-regles.test.js`, `docs/specs/spec-messages-fil-en-direct.md`, `docs/kb/messages-v5.md`
- Fichiers lus pour le contexte : `lib/guestflow/brouillons-dus.js`, `lib/record-message.js`, `migrations/0000-schema-initial.sql`, `tests/outils/banc-messages.js`, `lib/channels/channex.js`

**Comment j'ai mesuré.** Tous les essais sont dans `/tmp/revue2/`, hors de l'arbre. Les scénarios ont été rejoués dans le vrai banc. Les mutations et les correctifs essayés l'ont été sur deux copies `git archive`, l'une de 6b467ece, l'autre de e6173c98. À la fin, `git status` de l'arbre ne montre que `node_modules`. Les trois fichiers `messages-direct-*` passent à 53/53. La suite complète sur la copie donne 7833/7836. Les 3 rouges viennent de la copie (pas de `.git`) : les deux fichiers concernés passent à 16/16 dans l'arbre.

---

**1. IMPORTANT (envoi au voyageur) — double envoi encore possible par « Modifier puis Envoyer »** — `pages/messages.html:786-789`
- **Origine.** Ce défaut n'a pas été créé par les correctifs. Il est présent depuis e6173c98 et absent avant le lot, parce qu'aucun rendu périodique n'existait. Il se trouve dans la fonction que le correctif a modifiée, et le message du commit annonce « plus d'envoi en double ».
- **Cas.** Une proposition **sans échéance**. Sur ce chemin, `lancerEnvoi` ne réserve pas la tâche : elle reste `pending_validation` jusqu'à ce que la clôture arrive.
- **Mécanisme.**
  1. Une fois le message parti, `etat.enEdition = null` est posé **avant** `await cloreTache(...)`.
  2. La tâche n'a pas d'`etatEnvoi`.
  3. Un cycle qui tombe pendant la clôture rend la ligne du cœur, et le serveur rend encore la tâche. Le fil est alors redessiné avec la proposition **et son bouton « Envoyer »**.
  4. Un clic réserve la tâche avec succès et la renvoie, cette fois avec le texte IA d'origine.
- **Mesuré** (`/tmp/revue2/scenario-c.test.js`) : bouton présent pendant la clôture, puis messages postés `["Texte retouche","Texte IA"]`. Même résultat sur e6173c98.
- **Fenêtre.** Elle dure autant que le POST `action=proposition`, démarrage à froid compris. Même sans clic, la proposition déjà partie réapparaît le temps de la clôture, ce qui invite à cliquer.
- **Correctif** (essayé : scénario fermé, 60/60 sur `messages-direct-dom` et `messages-v5*`) :
  ```js
  const x = etat.taches.find(...) || tacheDuGeste
  if (x) x.etatEnvoi = 'en_cours'
  etat.enEdition = null
  ```
  `cloreTache('done')` appelle toujours `retirerTache` ensuite, donc l'état ne reste pas collé.

**2. IMPORTANT (régression du correctif 5a, envoi au voyageur, rare) — une proposition rendue à l'hôte ne revient jamais** — `pages/messages.html:1013`, `shared/messages-direct.js:148-150`
- **Mécanisme.** `direct.closes` est une mémoire permanente. Or `retirerTache` est aussi appelé après un 409 de `reserver`, `brouillon` ou `reprendre`, c'est-à-dire quand le cron a pris la tâche (`sending`).
- **Scénario.**
  1. Le cron réserve une réponse différée à son échéance.
  2. L'hôte clique « Envoyer » dans les 5 s, reçoit un 409, et lit « déjà partie ».
  3. L'envoi du cron échoue. `brouillons-dus.js` rend la tâche en `pending_validation` (« Réponse différée NON DÉLIVRÉE… renvoyez-la »).
  4. La page filtre cet identifiant pour toujours : ni bulle ni badge jusqu'au rechargement. Le voyageur n'a rien reçu, et l'hôte croit le contraire.
- **Mesuré** (`/tmp/revue2/scenarios.test.js`, scénario A) : après 3 cycles, la page affiche `[]` à 6b467ece et `['x1']` à e6173c98.
- **Test qui fige ce défaut.** `tests/messages-direct-regles.test.js:162` encode « ne ressuscite pas » sans borne : un test qui fige un bug (REVIEW.md, règle 17).
- **Correctif** (essayé : scénario A vert, et le test 5a de la page reste vert) :
  - `closes` devient une `Map(id → instant du retrait)`.
  - `relireDirect` et `relireListe` notent `t0` avant leur lecture.
  - On n'écarte une ligne du serveur que si elle a été retirée **après** `t0`, autrement dit seulement pour une réponse lue avant la clôture : exactement le cas du constat 5a.

**3. MINEUR (coût, régression du correctif) — trois relectures de la liste (31 Ko) pour un seul message arrivé ailleurs** — `pages/messages.html:3817` (et `:3860`)
- **Mécanisme.** `dernierConnu = recul(lu_le)` recule de 2 minutes à chaque relecture. Le même message `dernier` redéclenche donc une relecture à +60 s, puis à +120 s.
- **Effet au chargement.** Un message arrivé dans les 2 minutes qui précèdent le chargement fait relire la liste dès le premier cycle.
- **Mesuré** (scénario B) : 3 relectures à 6b467ece, 1 à e6173c98. La ligne de la case performance (« + 31 Ko ») ne compte donc pas ces deux relectures supplémentaires.
- **Pourquoi le test ne le voit pas.** Le test DOM `:256` répond sans `lu_le` : il passe par la branche `: dernier`, que la production ne prend jamais.
- **Correctif** (essayé : 1 relecture, 21/21) : `direct.dernierConnu = dernier`. Une seule horloge, celle de la base. Le `recul(lu_le)` ne sert plus qu'à l'initialisation.

**4. MINEUR (coût, promesse fausse) — la dernière ligne du fil revient à chaque cycle en production** — `api/messages.js:655-659` et `:681`
- **Mécanisme.**
  - PostgREST rend `created_at` à la microseconde. Le dépôt l'a mesuré : `11:07:58.499367`.
  - Le serveur reparse le curseur par `new Date(...)`, ce qui le tronque à la milliseconde : `…27.042456+00:00` devient `…27.042Z`.
  - `gt` rend donc de nouveau la ligne du curseur, à chaque cycle, tant que le fil est ouvert.
- **Ce qui n'en souffre pas.** Rien n'est perdu, et `deja` empêche tout doublon à l'écran.
- **Ce qui est faux.** Le commit dit que « rien de neuf ne renvoie plus la dernière ligne », et la spec annonce « < 1 Ko par relecture ». Le constat 8 de la review 1 n'est donc pas résolu.
- **Mesuré** (`/tmp/revue2/micro.test.js`, avec un double qui compare à la microseconde comme Postgres) : cycles 2 et 3, la ligne revient.
- **Pourquoi les tests ne le voient pas.** Leur double compare à la milliseconde, et leurs horodatages en ont 3 chiffres (`tests/messages-direct-api.test.js:149`).
- **Correctif.**
  - Valider `depuis` par une expression stricte (ISO, jusqu'à 6 décimales, `Z` ou décalage) et le passer **tel quel** quand il est dans la fenêtre des 7 jours.
  - Ne garder le `toISOString()` que pour le cas où la valeur est ramenée à 7 jours.
  - Faire comparer le double à la microseconde.

**5. MINEUR — le premier curseur est global, pas propre à chaque conversation** — `pages/messages.html:3721` (et `:3816`)
- **Mécanisme.** `etat.luLe` avance à chaque relecture de la page 1. Une conversation hors de la page 1 (chargée par « Afficher plus », ou sortie du haut de la liste) a des messages plus vieux que ce `luLe`.
- **Scénario.** Une insertion antidatée dans cette conversation (import de rattrapage, e-mail daté) ne la fait pas remonter en page 1. Deux minutes plus tard, et le constat 3 y suffit puisqu'il relit à +120 s, ouvrir le fil part après le message : il ne s'affiche pas avant un rechargement.
- **Correctif.** Estampiller `c._luLe` par la lecture qui a produit ses messages (`charger`, `chargerPageSuivante`, `relireListe`), et partir de `c._curseur || recul(c._luLe)`.

**6. MINEUR (commentaire inexact)** — `api/messages.js:677-679`
- **Ce qui est écrit.** « Seul cas perdu » : deux insertions à la même microseconde, coupées par la borne des 200.
- **Ce qui manque.** Il y a un autre cas : `created_at = now()` est l'instant de **début** de transaction, alors que la ligne devient visible au commit. Deux insertions d'un même fil à quelques millisecondes d'écart, lues entre leurs deux commits, font sauter la première.
- **Correctif.** Probabilité infime : corriger le commentaire suffit.

**7. MINEUR (tests) — le BLOQUANT n'est tenu que globalement**
- **Mesuré sur la copie.**
  - Retirer `|| tacheDuGeste` (`:787`) : 21/21 restent verts.
  - Remettre `rechargerTaches()` dans `relireListe` : 21/21 restent verts.
  - Le test `:290` passe avec l'une ou l'autre moitié du correctif. Le cas qui exige `tacheDuGeste` (l'hôte change de fil pendant l'envoi) n'est pas testé.
- **Correctif.** `/tmp/revue2/scenario-d.test.js` est prêt à reprendre. Il rougit contre e6173c98 et contre la mutation de `tacheDuGeste`, et passe à 6b467ece.
- **Autres tests à ajouter :**
  - le constat 4 (double à la microseconde) ;
  - le constat 3 (`lu_le` dans la réponse de liste du test `:256`) ;
  - les scénarios A et C ci-dessus.

---

**Catégories sans constat réel**
- **Sécurité.**
  - Les trois lectures gardent compte et périmètre. Retirer `user_id` sur chacune : 5, 6 et 3 rouges.
  - `lu_le` n'est qu'un instant serveur.
  - Le `curseur` de la branche « archivé » ne rend qu'un horodatage du même compte, déjà filtré par le périmètre.
- **`fusionnerMessages` et `aDejaSaLigne`.** Ni la passe finale ni le remplacement ne retire jamais une ligne du serveur, seulement des bulles `_local`. Le second envoi d'un texte identique, à moins de 5 minutes, reste invisible au plus un cycle (assumé dans le commit).
- **Marquage lu.**
  - Une écriture par arrivée, et une au réveil d'une page oubliée.
  - La ligne qui revient au constat 4 n'est pas comptée comme entrante.
  - Les gestes en rafale sont bornés par `pageOubliee()`.
- **Correctif BLOQUANT 1.** Il tient dans les deux variantes rejouées : relecture pendant l'envoi, et changement de fil pendant l'envoi (scénario D).

**Scénarios réutilisables** (dans `/tmp/revue2/`)
- `scenario-c.test.js` (constat 1)
- `scenarios.test.js` (scénario A : constat 2 ; scénario B : constat 3)
- `micro.test.js` + `harnais-exports.js` (constat 4)
- `scenario-d.test.js` (constat 7)
