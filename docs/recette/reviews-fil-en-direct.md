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

## Review 3 — reçue le 10 novembre 2026 (correctifs de la review 2 seulement) — LA DERNIÈRE

- Lancée sur : `/home/claude/hotesmart-direct`, branche `messages-fil-en-direct`,
  plage `6b467ecee765e672b1687dd584a6bcc7bf12a082..4a3f9c7ebc16e07ef56658f14a5a5aa8c86ad4dd`.
- Contrôle d'arbre : arbre, branche et SHA déclarés conformes au brief.
- Contrôle des fichiers cités : les neuf fichiers « du diff » sont exactement
  ceux de `git diff --name-only` de la plage. Les quatre fichiers « lus pour
  le contexte » sont hors du diff, déclarés comme tels ; chaque constat porte
  sur un fichier du diff.
- Exception du 27 octobre 2026 : c'est la dernière review. Ce qu'elle trouve
  se corrige sans nouvelle review.
- Seule retouche de transcription : les entités HTML du transport (`&amp;`,
  `&gt;`, `&lt;`) sont rendues par leur caractère.

### Rapport, mot pour mot

Arbre lu : /home/claude/hotesmart-direct — branche : messages-fil-en-direct — SHA lu : 4a3f9c7ebc16e07ef56658f14a5a5aa8c86ad4dd

**Fichiers cités**
- Fichiers du diff : `pages/messages.html`, `shared/messages-direct.js`, `api/messages.js`, `tests/messages-direct-dom.test.js`, `tests/messages-direct-api.test.js`, `tests/messages-direct-regles.test.js`, `docs/kb/messages-v5.md`, `docs/specs/spec-messages-fil-en-direct.md`, `docs/recette/reviews-fil-en-direct.md`
- Fichiers lus pour le contexte (hors du diff) : `tests/outils/banc-messages.js`, `lib/guestflow/brouillons-dus.js`, `migrations/0000-schema-initial.sql`, `api/channel-message.js`

**Comment j'ai mesuré.** Tous les essais sont dans `/tmp/revue3/`, hors de l'arbre. J'ai fait quatre copies par `git archive` :
- `copie` : 4a3f9c7e ;
- `avant` : 6b467ece ;
- `contre` : 6b467ece avec les tests neufs ;
- `correctif` : 4a3f9c7e avec le correctif essayé.

Les trois fichiers du lot passent à 61/61 sur `copie`. À la fin, `git status` de l'arbre ne montre que `node_modules` et HEAD n'a pas bougé.

---

**1. IMPORTANT (envoi au voyageur, régression créée par le correctif 2) — une proposition partie dont la clôture échoue revient 5 s plus tard avec « Envoyer »** — `pages/messages.html:1024`, `pages/messages.html:1014-1018`, `shared/messages-direct.js:153`
- **Mécanisme.**
  1. Le cas : « Modifier puis Envoyer » d'une proposition **sans échéance**. Ce chemin ne réserve pas la tâche (`:744`), donc elle reste `pending_validation` en base jusqu'à la clôture.
  2. Si le POST `action=proposition` échoue (503, 500, réseau, délai dépassé), `cloreTache` poursuit quand même et appelle `retirerTache`, qui note `closes.set(id, Date.now())`.
  3. La relecture suivante est demandée **après** ce retrait, donc `lueA` est plus grand que l'instant noté. `retireeApres` rend faux, et la ligne du serveur, toujours `pending_validation`, revient dans le fil avec « Modifier » et « Envoyer ».
  4. Un clic sur « Envoyer » réserve la tâche sans erreur, puisqu'elle est encore `pending_validation`, et poste le **texte IA d'origine**.
- **Avant le correctif.** Le `Set` permanent cachait la tâche jusqu'au rechargement, ce que promet le commentaire `:975-978` (« au rechargement la proposition reviendra »). Ce commentaire est désormais faux.
- **Mesuré** (`/tmp/revue3/scenario-e.test.js`, cas E 503 et E 500) :
  - sur `copie` : bouton revenu = `true`, envois `["Texte retouche","Texte IA"]` ;
  - sur `avant` : bouton revenu = `false`, envois `["Texte retouche"]`.
- **Le chemin du bouton de la bulle n'est pas touché** (cas E3) : la tâche y est réservée (`sending`), et le serveur ne la rend pas.
- **Correctif** (essayé, voir constat 2 pour la mesure) : réserver sur **tous** les chemins « Modifier puis Envoyer ». Il suffit de remplacer `if (x && valide(x.send_after))` par `if (x)` à `:744`. Après un échec de clôture, la tâche reste alors `sending`. Elle revient au bout de 10 minutes par la reprise des orphelines, avec « impossible de savoir si le message est parti » : c'est déjà le comportement du bouton de la bulle.
- **Variante plus étroite** : dans `cloreTache`, retirer une tâche `done` avec `Infinity` au lieu de `Date.now()`, pour la garder cachée jusqu'au rechargement comme avant.

**2. IMPORTANT (envoi au voyageur, présent à 6b467ece, laissé passer par le correctif 1) — le verrou d'écran du correctif 1 se contourne par trois gestes : le chemin sans échéance n'a aucun verrou serveur** — `pages/messages.html:742-744`, `:798`, `:3656`, `:906`, `:1075`
- **Mécanisme.**
  - `etatEnvoi = 'en_cours'` n'est posé qu'**après** `posterMessage`, et seulement sur l'objet affiché.
  - Pendant l'appel au canal, la proposition n'est cachée que par `etat.enEdition`. Deux gestes effacent ce champ :
    - changer de fil (`ouvrir`, `:3656`) ;
    - « Modifier » sur une autre proposition (`:906`).
  - Pendant la clôture, « Proposer une réponse » appelle `rechargerTaches` (`:1075`). Celle-ci remplace `etat.taches` par des objets neufs, sans `etatEnvoi`.
  - Dans les trois cas, « Envoyer » revient à l'écran. Comme rien n'est réservé côté serveur, le clic réserve sans erreur et envoie le texte IA.
- **Mesuré** :
  - F (`scenario-f.test.js`) : aller sur le fil B2 puis revenir sur B1 pendant l'envoi. Envois `["Texte retouche","Texte IA"]`, sur `copie` **et** sur `avant`.
  - F2 (même fichier) : « Modifier » sur x2 pendant l'envoi de x1. Même résultat, sur les deux copies.
  - H (`scenario-h.test.js`) : « Proposer » pendant la clôture. Sur `copie`, les tâches passent de `[["x1","en_cours"]]` à `[["x1",null]]`, et les envois valent `["Texte retouche","Texte IA"]`. Même résultat sur `avant`.
- **Ce qui est faux dans le commit.** Le message annonce que le double envoi est fermé. Il ne l'est que pour la seule fenêtre « cycle pendant la clôture ».
- **Correctif essayé** (`/tmp/revue3/correctif-essaye.diff`, 31 lignes) :
  - (a) réserver sur tous les chemins (`:744`) ;
  - (b) poser `tacheDuGeste.etatEnvoi = 'en_cours'` dès l'entrée dans `lancerEnvoi`, et le retirer si la réservation ou `posterMessage` échoue (sans 409).
- **Résultat du correctif essayé.**
  - E, E3, F, F2, H, C, D, A et B sont verts.
  - Les trois fichiers du lot plus `messages-v5`, `delai-reponse-ia-lot1`, `delai-reponse-ia-messages` et `proposition-par-rang` donnent 229/229.
- **Effet de bord à connaître.** Un « Réessayer » après l'échec de `posterMessage` **et** de `relacher` reçoit 409 sur sa propre réservation. La page dit alors « déjà partie » et retire l'envoi de l'écran. Ce cas existe déjà sur le chemin avec échéance ; le correctif l'étend aux propositions sans échéance.

**3. MINEUR (envoi au voyageur via le constat 2 ; seul, affichage) — `closes` et `lueA` lisent `Date.now()`, qui ne va pas toujours en avant** — `pages/messages.html:1024`, `:3732`, `:3843`
- **Scénario.** Une relecture est en vol. Pendant ce temps, l'horloge du poste recule (resynchronisation NTP, sortie de veille), et l'hôte envoie puis clôt la proposition. Le retrait est alors daté **avant** `lueA`. La réponse, lue avant la clôture, ressuscite la proposition pour un cycle, avec ses boutons.
- **Mesuré** (`scenario-i.test.js`, recul de 3 s) :
  - sur `copie` : proposition revenue = `true`, puis « Modifier » et « Envoyer » donnent les envois `["Texte IA","Texte IA, complete"]` ;
  - sur `avant` : la proposition ne revient pas (`false`).
- **Correctif** (essayé, dans le diff ci-dessus) : une horloge logique `direct.tic`, incrémentée à chaque demande et à chaque retrait (`++direct.tic`), à la place de `Date.now()`. Avec ce compteur, l'égalité n'existe plus.
- **Effet mesuré** : avec la réservation du constat 2 seule, la double saisie est refusée en 409, mais la proposition revient encore pour un cycle. Le compteur supprime ce retour : I passe au vert, et la suite reste à 229/229.

**4. MINEUR (affichage, envoi au voyageur) — pendant la clôture, le fil montre le texte IA d'ORIGINE « Envoi… » alors que c'est le texte retouché qui est parti** — `pages/messages.html:798-800`, `shared/messages-direct.js:165`
- **Mécanisme.** `etat.enEdition = null` rend la proposition au fil, avec l'état `en_cours`. À chaque cycle, `Object.assign(x, s)` y remet le `suggested_reply` du serveur, donc le texte IA.
- **Mesuré** (`scenario-g.test.js`, quand la ligne du cœur est déjà lue) : le fil affiche `["Bonjour","01:34","PropositionTexte IA","Envoi…","Texte retouche","01:44"]`. L'hôte lit que le texte de l'IA part en plus du sien. Aucun bouton n'est affiché, donc pas de double envoi.
- **Correctif (non essayé).**
  - Ne pas dessiner une proposition dont le message est déjà parti : un état `partie`, gardé par `garder` mais filtré au rendu.
  - Ou afficher `entree.texte`, en le protégeant de l'`Object.assign`.

**5. MINEUR (régression de forme, sans fuite) — `depuis` accepte des dates impossibles que Postgres refuse** — `api/messages.js:634`, `:664-668`
- **Mécanisme.** L'expression accepte `2026-02-30T08:00:00Z` ou `2026-11-31T…`, et V8 les parse en les reportant au mois suivant. Quand l'instant est dans la fenêtre des 7 jours, la chaîne brute part telle quelle à la base.
- **Avant le correctif**, `toISOString()` normalisait la valeur, donc la base ne recevait jamais une date invalide.
- **Mesuré** (node) : `INSTANT_ISO.test` rend `true` et `new Date(...)` est valide.
- **Non mesuré contre une base** : le refus de Postgres (« date/time field value out of range »), qui donnerait un 503 « Lecture impossible » avec `console.error`, au lieu d'un 400. Seule une requête forgée sur son propre compte y arrive : la page n'envoie jamais ces valeurs.
- **Correctif.** Vérifier jour et heure par aller-retour, par exemple que `Date.UTC(a, m-1, j).getUTCDate() === j` et que l'heure est inférieure à 24, avant de passer `brut`.

**6. MINEUR (tests) — trois des quatre lignes du correctif 5 et la moitié « liste » du correctif 2 ne sont tenues par aucun test** — `tests/messages-direct-dom.test.js:587-593`
- **Mesuré** (`/tmp/revue3/mutations.sh`, une copie neuve par mutation, trois fichiers du lot) :
  - retirer l'estampille `_luLe` dans `relireListe` (`:3821`) : 0 rouge ;
  - la retirer dans `chargerPageSuivante` (`:492`) : 0 rouge ;
  - la retirer dans `charger` (`:269`) : 0 rouge ;
  - déplacer `lueA` après `lireTachesOuvertes` dans `relireListe` : 0 rouge ;
  - remplacer `>=` par `>` dans `retireeApres` : 0 rouge (sans portée avec `Date.now()`, sans objet avec le compteur).
- **Pourquoi.** Le test `:587` pose `_luLe` lui-même dans la conversation. Il ne vérifie donc pas qu'une lecture l'estampille.
- **Pour comparaison**, les mutations « sans plancher 7 j » et « `en_cours` retiré » donnent chacune 1 rouge.
- **Contre-épreuve.** Les tests neufs contre 6b467ece (`/tmp/revue3/contre`) donnent 7 rouges. Ce sont ceux annoncés, plus le test unitaire de `fusionnerTaches` dont le contrat change. D passe, comme annoncé.
- **Correctif.**
  - Un test qui passe par la vraie lecture « Afficher plus » ou `relireListe` avec deux `lu_le` distincts.
  - Un test où une tâche est retirée pendant `lireTachesOuvertes`.
  - Les scénarios E, F, F2, H et I à porter dans le lot.

---

**Catégories sans constat réel**
- **Sécurité des trois lectures de `lireEnDirect`.** Mesuré par `/tmp/revue3/mutations-securite.sh` :
  - retirer `user_id` sur `dernier`, le fil et les tâches donne 5, 6 et 3 rouges ;
  - retirer le filtre de périmètre sur chacune donne 2, 2 et 2 rouges ;
  - garder seulement `Number.isFinite`, sans l'expression, donne 1 rouge.

  Injection : l'expression est ancrée, sans le drapeau `m`. `…Z\n`, `…Z,or(user_id.neq.x)`, un espace à la place de `T` et des chiffres non latins sont refusés (mesuré). Les caractères admis (`0-9 - T : . Z +`) ne peuvent pas sortir d'un filtre `gt.`.
- **Valeurs refusées à tort.** Aucune. La page n'envoie que `recul(...)`, au format `toISOString` en `Z`, ou le `curseur` du serveur, soit un `created_at` en `timestamptz` (`migrations/0000-schema-initial.sql:1772`) rendu avec jusqu'à 6 décimales et `+00:00`, soit `depuis` renvoyé tel quel. Toutes ces formes passent l'expression (mesuré). `URLSearchParams` encode `+` en `%2B`, et `URL` comme `querystring` le décodent en `+` (mesuré).
- **`etatEnvoi = 'en_cours'` qui reste collé.** Ça n'arrive pas :
  - sur le chemin `done`, `cloreTache` appelle toujours `retirerTache` (409, autre erreur ou succès) ;
  - un échec d'envoi survient avant la pose ;
  - changer de fil ne touche pas l'état.

  Le seul retour anormal est celui du constat 1.
- **Retrait pendant une lecture.** Fil et liste prennent chacun leur `lueA` avant leur propre lecture. Un retrait pendant le GET du fil est filtré. Un retrait pendant le GET de la liste précède `lueA`, mais la lecture des tâches lui est postérieure, donc elle voit l'état clos. Le cas du 409 suivi d'une tâche rendue par le cron revient bien (scénario A vert).
- **`dernierConnu = dernier`.**
  - Quand `dernier` est null, `traiterDernier` n'est pas appelé.
  - Il n'y a pas de boucle : 1 relecture pour 1 message (scénario B, 1 lecture).
  - Si la relecture de la liste échoue, `dernierConnu` reste inchangé et la relecture se refait 60 s plus tard.
  - Seul coût résiduel : un message inséré entre la lecture du fil et la lecture de la liste coûte une relecture de plus, 60 s plus tard. Rien n'est perdu.
- **`_luLe` des conversations.** Seuls `charger`, `chargerPageSuivante` et `relireListe` créent des conversations (vérifié par grep). Sans `lu_le` dans la réponse, la valeur retombe sur `etat.luLe`, comme avant. Une conversation qui a déjà un `_curseur` n'est pas affectée.

---

**Scénarios réutilisables** (dans `/tmp/revue3/`, choisir l'arbre avec `RACINE=/tmp/revue3/<copie|avant|correctif>`) :
- `scenario-e.test.js` : constat 1 (E 503, E 500, E3 bouton de la bulle)
- `scenario-f.test.js` : constat 2 (F changement de fil, F2 « Modifier » sur une autre proposition)
- `scenario-h.test.js` : constat 2 (« Proposer » pendant la clôture)
- `scenario-i.test.js` : constat 3 (horloge qui recule)
- `scenario-g.test.js` : constat 4 (texte affiché pendant la clôture)
- `mutations.sh` : constat 6 ; `mutations-securite.sh` : gardes de compte et de périmètre
- `scenario-c.test.js`, `scenario-d.test.js`, `scenarios.test.js` : scénarios de la review 2 (C, D, A, B), repris avec `RACINE` pointé sur les copies
- `correctif-essaye.diff` : le correctif essayé (réservation sur tous les chemins, `en_cours` dès le départ, horloge logique), appliqué dans `/tmp/revue3/correctif`
