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
