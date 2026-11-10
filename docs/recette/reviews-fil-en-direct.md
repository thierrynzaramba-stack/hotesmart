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
