# Reviews — information manquante, étape 1 (branche `info-manquante-etape-1`)

Lot d'envoi au voyageur : trois reviews au plus (CLAUDE.md, exception du
27 octobre 2026). Chaque rapport est recopié ici TEL QUEL, dès réception,
avant toute correction.

## Review 1 — reçue le 11 novembre 2026

Plage : `096cdde4a7d8bf770edd12417b18a84d58da3cf0..36b7c848e860ecfb83bbad1cb7e3aa67018d67e6`,
worktree `/home/claude/hotesmart-infoetape1`. Contrôle : chaque fichier cité
figure dans `git diff --name-only` de la plage.

---

Arbre lu : `/home/claude/hotesmart-infoetape1`, HEAD `36b7c848e860ecfb83bbad1cb7e3aa67018d67e6`, branche `info-manquante-etape-1`, plage `096cdde4a7d8bf770edd12417b18a84d58da3cf0..36b7c848e860ecfb83bbad1cb7e3aa67018d67e6`. Tous les fichiers cités ci-dessous sont dans `git diff --name-only` de cette plage.

Les 4 fichiers de test du lot passent (72 sur 72), et `scripts/i18n-check.js` est vert (1329 clés dans les trois langues). Je n'ai rien modifié dans l'arbre. Le constat 1 a été reproduit avec le banc de test réel, depuis un script mis dans /tmp puis supprimé.

**Un constat bloquant (le 1). Aucun constat de sécurité serveur.**

---

**1. BLOQUANT — `pages/messages.html:998-1003` (`redigerInfo`)**
- **Défaut :** la garde `saisieRemplieAilleurs()` n'est vérifiée qu'au clic, pas au retour de l'IA. Au retour, le code remplace sans condition la marque d'un autre fil par celle du fil courant (`else etat.saisieRemplie = { bookId: ici, … }`). La garde contre l'envoi au mauvais voyageur saute.
- **Scénario reproduit :**
  - Fil d'Ana (B1) : choix sur la carte, puis « Rédiger la réponse ».
  - Pendant la rédaction, ouverture du fil de Marie (B2). « Utiliser » une réponse prête (le wifi de Marie), puis ajout de « Bonjour Marie, ».
  - Retour au fil d'Ana : le texte reste, avec la note « il ne partira pas ici ».
  - L'IA répond : son texte s'ajoute à la suite, et la marque passe à B1.
  - « Envoyer » poste à Ana : `"Bonjour Marie, WIFI MAISON DE MARIE : xyz\nHello Ana, yes"`.
  - Témoin, même parcours sans réponse de l'IA : `envois = []`, la garde tient.
- **Probabilité :** la fenêtre est la durée de la rédaction. Elle est courte avec Haiku, mais peut durer des minutes si Anthropic est lent. La page promet pourtant à l'écran que le texte ne partira pas.
- **Correction (une ligne) :** juste après `if (String(etat.ouverte) !== ici) return`, ajouter `if (saisieRemplieAilleurs()) { noteChamp(t('kb.use_wrong_conv')); return }`. Ou ne jamais remplacer une marque dont le `bookId` diffère de `ici`. Mettre la même vérification dans `redigerBrouillon`, par symétrie.
- **Test manquant :** le cas A → B (« Utiliser » + retouche) → A pendant la rédaction. Le test actuel « revient après un changement de fil » ne couvre que A → B.

**2. MINEUR — `pages/messages.html:1039` (`redigerBrouillon`)**
- **Défaut :** `zone.readOnly = true` s'applique à la zone de saisie, qui est commune à tous les fils. Il n'existe aucun délai maximum côté client, et `etat.iaEnCours` est global.
- **Scénario :** l'IA est lente (le SDK fait des tentatives, la fonction peut durer jusqu'à son temps maximum). Pendant ce temps, l'hôte ne peut taper de réponse dans aucun fil, même pour un message urgent. « Rédiger » et « IA » sont bloqués sur toute la page.
- **Correction :** remettre `readOnly` à false dans `ouvrir()` quand on change de fil. La vérification `zone.value !== avant` jette déjà la réponse si le champ a bougé. Ajouter aussi un délai maximum (`AbortController`, environ 30 s).

**3. MINEUR — `api/guestflow-rediger.js:115-122` (le plafond)**
- **Défaut :** le plafond compte les lignes de `ia_appels`. Mais cette ligne n'est écrite par l'enveloppe qu'après la réponse du modèle, et son échec est volontairement silencieux (le journal ne doit jamais casser l'appel).
- **Scénario :** N requêtes envoyées en même temps (deux onglets, ou un script d'un membre qui a le droit d'écrire) lisent toutes 0 et passent. Une insertion en échec, elle, ne compte jamais.
- **Ce qui est vérifié :** le plafond de l'agent n'est jamais touché. Aucune lecture ni écriture de `guestflow_appels_ia`, et l'étiquette, le compte et le séjour correspondent à la requête de comptage (index `ia_appels_fil_idx` présent).
- **Correction :** l'inscrire comme dette (même schéma que la garde de l'agent), ou réserver la place de façon atomique (RPC « compter + insérer »). Il n'existe pas de test de concurrence.

**4. MINEUR — `api/messages.js:340` (`cloreInfo`) avec `pages/messages.html:831`**
- **Défaut :** la clôture ne vérifie pas que la tâche est celle pour laquelle le texte a été rédigé.
- **Scénario :** l'hôte rédige sur la question Q1. Le voyageur réécrit, et le cron complète la même tâche avec Q2. L'hôte envoie le texte, qui ne répond qu'à Q1. La tâche passe à `done`, et la question Q2 disparaît de « À valider » sur Aujourd'hui.
- **Nuance :** c'est cohérent avec la règle du cron (une réponse de l'hôte vaut réponse à tout ce qui précède), d'où la gravité mineure.
- **Correction :** faire porter `maj` (ou les questions) par `info_traitee`, et conditionner l'`UPDATE` à `updated_at` inchangé. En cas d'écart, rendre 409 `questions_changees`. Envoyer aussi `booking_id` serait un durcissement peu coûteux.

**5. MINEUR — `lib/guestflow/rediger.js:51` (`questionsDe`)**
- **Défaut :** seules les tâches pause et arrêt sont exclues. Les tâches de secours du cron (« Réponse de l'IA illisible », garde emoji « Question restée sans réponse ») mettent tout le message du voyageur dans `question`.
- **Scénario :** la carte propose Oui / Non / Autre sur un paragraphe qui contient plusieurs demandes. L'IA reçoit alors un « OUI » global.
- **Correction :** décision produit. Soit exclure ces deux motifs, soit l'assumer par écrit dans la spec.

**6. MINEUR — `pages/messages.html` (`ouvrir` / `carteInfo`)**
- **Défaut :** la spec dit que la carte vient du fil en direct « relu à l'ouverture ». En pratique, aucune relecture n'est lancée à l'ouverture : la carte arrive au premier cycle, soit environ 5 s. Entre-temps, le `c.infos` d'une visite précédente est affiché.
- **Conséquence :** surtout un délai à l'écran. Un clic sur une carte périmée reçoit 409 et la carte se relit, donc c'est sans danger.

---

**Ce que j'ai vérifié sans rien trouver :**
- **Fuite entre comptes ou périmètres :**
  - `infos` est filtré par compte et par `filtreOr`.
  - `info_traitee` rend 404 sur un autre compte ou hors périmètre, et 403 en lecture seule.
  - Dans `guestflow-rediger`, la réservation détermine le bien (le `propertyId` envoyé par la page est ignoré). La tâche est liée au séjour et à la référence du bien. Les connaissances lues sont celles de ce bien seul.
- **En-tête `private, no-store` :** posé avant le premier refus sur les deux endpoints, 405 compris.
- **La note interne `suggested_reply` :**
  - Elle ne sort ni dans `taches` (propositions seules, forme inchangée), ni dans `infos` (questions seules).
  - Elle ne part pas non plus dans le prompt.
- **Envoi :**
  - Rien ne part sans « Envoyer ».
  - La clôture ne part qu'après `posterMessage` réussi, une seule fois par entrée, y compris après « Réessayer ».
  - Pas de double envoi hors second clic volontaire.
- **Régressions :**
  - L'ordre de `taches` est conservé (récentes d'abord, puis remises à l'endroit).
  - « Modifier puis Envoyer » est intact, `cloreInfoTraitee` ne peut pas lever d'erreur dans le `try`, et le rendu de la carte est retardé pendant une saisie dans le fil.
  - Le chemin « Utiliser » est inchangé, hors le constat 1.

## Review 2 — reçue le 11 novembre 2026 (diff des correctifs)

Plage : `36b7c848e860ecfb83bbad1cb7e3aa67018d67e6..0e69c9c40622a49c09202120d65d946d8b7ef0cc`,
worktree `/home/claude/hotesmart-infoetape1`. Contrôle : chaque fichier cité
figure dans `git diff --name-only` de la plage.

---

**Arbre lu :** `/home/claude/hotesmart-infoetape1` (`pwd`), branche `info-manquante-etape-1`, HEAD `0e69c9c40622a49c09202120d65d946d8b7ef0cc`. Plage relue : `36b7c848e860ecfb83bbad1cb7e3aa67018d67e6..0e69c9c40622a49c09202120d65d946d8b7ef0cc`, soit un commit. Tous les fichiers cités ci-dessous sont dans `git diff --name-only` de cette plage.

**Ce que j'ai lancé :**
- Les 4 fichiers de test du lot passent : 80 sur 80.
- **Contre-épreuve**, sur une copie de `36b7c848` faite par `git archive` dans `/tmp` :
  - les tests neufs sont rouges contre le code d'avant, **sauf un** (constat 3 ci-dessous) ;
  - le test du délai de 30 s ne rougit pas : il bloque, puisque sans délai l'appel ne revient jamais.
- **Mutations**, et une sonde qui joue le scénario du constat 1, dans une copie hors de l'arbre.

Rien n'a été modifié dans le worktree. Les copies dans `/tmp` sont supprimées.

**Aucun constat bloquant. Aucun constat de sécurité serveur.** Les correctifs 2, 4 et 5 ferment leur constat. Le correctif 1 ferme le scénario reproduit (texte marqué), mais pas sa variante avec un texte non marqué (constat 1 ci-dessous).

---

**1. IMPORTANT — `pages/messages.html:1001-1007` (`redigerInfo`)**
- **Défaut :** le correctif ne revérifie que la marque. Un texte **non marqué**, écrit chez un autre voyageur pendant la rédaction, reçoit la réponse d'Ana. La page dit ensuite qu'il est prêt, et il part chez Ana.
- **Scénario, mesuré avec le banc réel :**
  - Ana (B1) : choix, puis « Rédiger ».
  - Chez Marie (B2), l'hôte tape « Bonjour Marie, le code du portail est 4321 », puis revient chez Ana.
  - L'IA répond. Résultat :
    - la saisie contient `"Bonjour Marie, le code du portail est 4321\nHello Ana, yes…"` ;
    - la marque passe à B1 ;
    - la note dit « Réponse rédigée dans la saisie : relisez-la, puis envoyez. »
  - « Envoyer » poste ce texte entier à Ana, puis clôt la tâche.
  - Le texte de Marie ne peut plus partir chez Marie : sa saisie porte maintenant la marque d'Ana.
- **Même chemin** avec « Modifier » une proposition de Marie, retouchée, pendant la rédaction (le texte retouché reste dans la saisie, sans marque).
- **Pourquoi pas bloquant :** un texte tapé n'a jamais été protégé par la page. « Envoyer » seul l'enverrait aussi. Mais la rédaction l'enrobe et invite à l'envoyer.
- **Correction :**
  - un compteur de changements de fil, incrémenté dans `ouvrir()` quand le fil change ;
  - au clic, garder ce compteur et `zone.value` ;
  - au retour, si le compteur a bougé **et** que la saisie a changé, jeter la réponse avec `noteChamp(...)`.
  
  Cela ferme toute la famille A → B → A (texte marqué, tapé, retouché, Ctrl+Z), sans pénaliser un simple coup d'œil sur un autre fil. Ajouter le test de la sonde.

**2. MINEUR — `lib/guestflow/rediger.js:30` et `:62` (`SOUS_TACHES_DE_SECOURS`)**
- **Défaut, en deux parties :**
  - une tâche de secours n'a plus de carte, donc plus aucun geste de la V5 ne la clôt. Le bouton « IA » cité par la spec ne clôt rien. Elle reste dans « À valider » d'Aujourd'hui jusqu'au départ du voyageur ;
  - il existe une troisième voie de secours au cron, non couverte. Quand le modèle classe `info_unknown` **sans** `sub_tasks`, la question devient le message entier du voyageur, avec un `summary` libre. Même défaut « oui global », et la liste des deux textes fixes ne peut pas le voir.
- **Correction :** décision produit, à écrire dans la spec. Soit accepter que la tâche reste ouverte, soit poser au cron un texte fixe pour cette troisième voie et l'ajouter à la liste.
- **Copies (point 4) :** les deux textes sont identiques octet pour octet à ceux du cron. Le test vérifie bien la citation exacte, guillemet fermant compris, mais seulement dans un sens : il ne verrait pas un nouveau texte de secours ajouté au cron.

**3. MINEUR — tests : deux branches neuves ne sont tenues par aucun test**
- **`tests/info-manquante-messages-api.test.js:289` (`updated_at` nul) :**
  - ce test passe aussi contre le code d'avant ;
  - il passe si on retire `.is('updated_at', null)` ;
  - il passe si on le remplace par `.eq('updated_at', null)`. Or en vrai PostgREST, cela donne une erreur de type (`eq.null` sur un `timestamptz`), donc un 503 et une tâche jamais close.
  - Cause : le double compare par `String()`, donc `'null' === 'null'`, et `majs` n'enregistre pas les `is`.
  - Portée faible : la colonne a `DEFAULT now()`, donc la branche est presque morte. Correction : enregistrer `q.is` dans `majs` et l'affirmer.
- **`pages/messages.html:1053-1054` :** la garde ajoutée au retour de `redigerBrouillon` n'est couverte par aucun test (suite verte une fois la ligne retirée). Elle n'est atteignable que par un chemin tiré par les cheveux (la saisie revenue exactement à `avant` avec une marque d'un autre fil). Elle est sans danger.

**4. MINEUR — `pages/messages.html:1113-1117` (`cloreInfoTraitee`), un 409 `questions_changees`**
- **Ce qui est vérifié :**
  - pas d'erreur journalisée ;
  - pas de carte ressuscitée à tort. Si le cron a complété la tâche avant l'envoi, `infoAAfficher` masque la carte, puisque l'hôte a répondu après `maj`. S'il l'a complétée entre la lecture et l'`UPDATE`, la carte revient avec les **nouvelles** questions et les choix remis à zéro, ce qui est juste.
- **Défaut :** le refus est muet dans Messages. La tâche reste dans « À valider », comme la spec le veut. Mais aucune carte ni aucun geste de la V5 ne permet ensuite de la clore.
- **Correction (facultative) :** sur `questions_changees`, poser `etat.infoNote = { bookId, cle: 'messages.info.erreur.questions_changees' }` pour ce fil.

**5. MINEUR — `pages/messages.html:3946` et `:1052` (`ouvrir` / `redigerBrouillon`)**
- **Défaut :** après A → B → A, le champ n'est plus figé. Si l'hôte tape, la réponse de l'IA est jetée (c'est voulu, `zone.value !== avant`), mais sans aucune note. Sans danger, seulement de l'interface.

---

**Vérifié sans rien trouver de plus :**
- **Constat 2 :**
  - `Promise.race` + `clearTimeout` dans `finally` ; une réponse tardive est ignorée (test probant) ;
  - `iaEnCours` est remis à `null` dans les deux `finally` ;
  - le champ figé tombe au plus tard après 30 s, et tout de suite au changement de fil.
- **Constat 4, format :**
  - `infos.maj` et la relecture comparent la même colonne, lue par le même client, en chaîne brute. Aucune normalisation côté page (`majInfos` affecte tel quel), et la borne de 40 caractères suffit (32 pour un `timestamptz`).
  - Course avec le cron : sous `READ COMMITTED`, l'`UPDATE` réévalue sa condition `updated_at` après l'écriture du cron, donc 0 ligne, une relecture, et 409 `questions_changees` (test probant par mutation).
  - `maj` absent : la vérification de version saute, l'`UPDATE` reste conditionné. Seul cas réel : une page en cache pendant un déploiement.
  - `booking_id` : 404 avant le contrôle de périmètre, sans fuite.
- **Constat 1, autres chemins :**
  - délai dépassé puis réponse tardive : la réponse est ignorée ;
  - plusieurs changements de fil avec un texte marqué : refusé ;
  - « Modifier » dans le même fil : même voyageur, accepté ;
  - champ vidé puis Ctrl+Z : la marque « vide » d'un autre fil est remplacée, comme le fait déjà « Utiliser ». Ce n'est pas ouvert par le correctif, et je ne l'ai pas éprouvé dans un vrai navigateur (Ctrl+Z après une écriture par script).

## Review 3 — reçue le 11 novembre 2026 (diff des correctifs de la review 2 ; DERNIÈRE)

Plage : `0e69c9c40622a49c09202120d65d946d8b7ef0cc..6845b5ae85eace1ff75b796876a8a75115170c8b`,
worktree `/home/claude/hotesmart-infoetape1`. Contrôle : chaque fichier cité
figure dans `git diff --name-only` de la plage. Ses constats se corrigent sans
nouvelle review (exception « envoi au voyageur » du 27 octobre 2026).

---

Arbre lu : `/home/claude/hotesmart-infoetape1` (`pwd`). Branche `info-manquante-etape-1`, HEAD `6845b5ae85eace1ff75b796876a8a75115170c8b`. Plage relue : `0e69c9c40622a49c09202120d65d946d8b7ef0cc..6845b5ae85eace1ff75b796876a8a75115170c8b` (un commit). Tous les fichiers cités ci-dessous figurent dans `git diff --name-only` de cette plage.

Je n'ai rien modifié dans le worktree : `git status` ne montre que `node_modules`, qui était déjà là. Les contre-épreuves, les mutations et les sondes ont tourné sur une copie faite par `git archive` dans `/tmp`, supprimée depuis.

**Aucun constat bloquant, aucun constat de sécurité.** Les correctifs 2, 3, 4 et 5 ferment leur constat. Le correctif 1 ferme le scénario mesuré en review 2. Mais la note qu'il affiche invite à relancer, et la relance retombe sur le même état final (constat 1 ci-dessous).

---

**1. IMPORTANT (non bloquant) — `pages/messages.html:1012-1015` et `:1005`, texte de `shared/i18n/fr.json:790`**
- **Défaut :** quand la rédaction est jetée, le texte tapé chez Marie reste dans la saisie. La note dit seulement « relancez-la ». Si l'hôte relance, la réponse s'ajoute à ce texte comme s'il était à Ana.
- **Scénario, mesuré avec le banc réel :**
  - B1 (Ana) : « Rédiger ».
  - Chez B2, l'hôte tape « Bonjour Marie, le code du portail est 4321 », puis revient sur B1.
  - La rédaction est jetée, la note s'affiche. Le bouton « Rédiger » reste actif ; un clic donne :
    - saisie : `"Bonjour Marie, le code du portail est 4321\nHello Ana, yes…"` ;
    - marque B1, note « relisez-la, puis envoyez ».
  - « Envoyer » poste ce texte à B1 et clôt la tâche.
- **Même chose par la première garde** (ligne 1005) : la réponse arrive pendant que l'hôte est chez Marie, puis il revient.
- **Portée :** c'est l'état final du constat 1 de la review 2, avec un clic de plus — et c'est la page qui demande ce clic.
- **Correction, sans nouvelle review :** changer le texte de la note pour ces deux chemins. Par exemple : « La saisie a changé pendant que vous étiez dans une autre conversation : vérifiez-la ou videz-la, puis relancez. »
  - Variante plus sûre, à noter en dette : mémoriser `{ bookId, valeur }` au moment de la jetée, et refuser une relance tant que la saisie vaut encore cette valeur.

**2. MINEUR, existait avant ce diff — `pages/messages.html:1028` (pose de l'engagement) et `:890-891` (`envoyer`)**
- **Défaut :** l'engagement d'une rédaction RÉUSSIE (`etat.infoEngagee`) survit à deux choses :
  - le retrait de son texte par `rangerSaisieRemplie` quand on change de fil ;
  - une rédaction suivante jetée.

  Le message suivant de l'hôte dans ce fil, quel qu'il soit, clôt alors la tâche.
- **Scénario, mesuré :**
  - Rédaction 1 réussie ; aller-retour B1 → B2 → B1 ; la saisie revient vide.
  - L'engagement est toujours là : `{B1, ti1, maj}`.
  - « Je vérifie et je reviens vers vous », puis « Envoyer » : la clôture part, et la question disparaît de « À valider ».
  - Même résultat après une rédaction 2 jetée.
- **Réponse à ta question 3 :** les chemins de jetée ne posent jamais l'engagement (vérifié par le test et par sonde). Le reste vient d'avant. Pas de mauvais destinataire, et le serveur vérifie toujours `maj`.
- **Correction (ou dette) :** garder le texte rédigé dans l'engagement, et ne l'attacher dans `envoyer()` que si le texte envoyé le contient encore.

**3. MINEUR — `pages/messages.html:1068-1071` (`redigerBrouillon`)**
- **Défaut :** la note donne une cause fausse. Elle dit « Vous avez changé de conversation » même quand le champ a changé dans le même fil.
- **Scénario, mesuré :** pendant une rédaction « IA » sur B1, « Modifier » une proposition de B1. `readOnly` ne bloque pas une écriture par script. Résultat : la note « changé de conversation » avec `changementsDeFil = 0`. La jetée elle-même est juste.
- **Correction :** une clé générique, « La saisie a changé pendant la rédaction : vérifiez-la, puis relancez. » Elle sert aussi au constat 1.

**4. MINEUR — `tests/info-manquante-dom.test.js` : deux branches neuves ne sont tenues par aucun test**
- La note de la première garde de `redigerInfo` (`:1005`) : la retirer laisse 25 tests sur 25 verts.
- Le `bookId` de la note de clôture refusée (`:1139`) : le remplacer par `etat.ouverte` laisse 25 sur 25 verts.
- Le comportement actuel, lui, est juste (mesuré) : la note est cachée sur B2 et dans la liste, et visible au retour sur B1.
- **Correction :** deux tests. Réponse ou 409 reçus pendant que l'hôte est sur B2 → note absente sur B2, présente sur B1.

**5. MINEUR — `tests/info-manquante-regles.test.js:80`**
- **Défaut :** la vérification « dans l'autre sens » ne voit qu'une sous-tâche écrite sur une seule ligne, avec des apostrophes.
- **Mesuré :** un texte de secours ajouté au cron sur une ligne, entre apostrophes, fait bien rougir le test. Le même texte entre guillemets doubles, ou réparti sur plusieurs lignes, laisse le test vert. La troisième voie du cron est justement écrite sur plusieurs lignes.
- **Correction :** lire `summary:` sans exiger la même ligne (par exemple `/question:\s*message,\s*summary:\s*…/`) et accepter `"`. Ou l'écrire dans la spec comme limite.

---

**Vérifié sans rien trouver de plus :**
- **Question 1 (mauvais destinataire) :**
  - Tout retour sur A passe par `ouvrir(A)` depuis un fil différent de A, donc le compteur bouge toujours. Le bouton « retour » ne compte pas, mais l'`ouvrir` qui suit compte.
  - Mesuré : retour liste → B2 (frappe) → retour liste → B1 donne une rédaction jetée.
  - Réponse arrivée pendant la liste : jetée, la note s'affiche sur B1 seulement.
  - `?conv=` n'agit qu'à l'`init`, avant toute rédaction.
  - Texte modifié puis remis à l'identique : la saisie est revenue à ce qu'elle était au clic dans A, donc il est accepté.
  - « Utiliser » ou « Modifier » chez Marie, puis retour : texte non retouché, il est retiré par `ouvrir` et la réponse est acceptée sur une saisie vide ; texte retouché, la réponse est jetée.
- **Question 2 (la note) :**
  - « relancez » n'est jamais posée quand le texte a été mis dans la saisie : les trois chemins posent la note puis s'arrêtent.
  - « Réponse envoyée » n'arrive qu'après `posterMessage` réussi.
  - Le cron ne change la version d'une tâche `info_unknown` en attente que sur un nouveau message du voyageur, donc « nouvelle question » est exact.
- **Question 4 (contre-épreuve et mutations) :**
  - Les tests 9, 11 et 13 sont rouges contre `0e69c9c`. Le 10 (non-régression) et le 12 (garde qui existait déjà) sont verts, ce qui est attendu.
  - Chaque mutation est tuée par son test : compteur retiré → test 9 ; `&&` remplacé par `||` → test 10 ; garde de `redigerBrouillon` retirée → test 12 ; note retirée → test 11 ; note de clôture non repeinte → test 13.
  - Côté API, remplacer `is` par `eq(updated_at, null)`, ou retirer `is`, fait rougir le test. L'ancien double + `eq` reste vert : c'est donc le nouveau double qui attrape le défaut.
- **Spec :** l'affirmation « aucune tâche `info_unknown` ne se clôturait depuis Messages avant le lot » est exacte. Avant le lot, la clôture d'une proposition n'acceptait que `pending_validation` ou `sending`.
- **Exécutions :** les 3 fichiers de test du lot passent (69 sur 69). `scripts/i18n-check.js` est vert, avec 1331 clés dans les trois langues.
- **Non éprouvé :** le Ctrl+Z dans un vrai navigateur.
