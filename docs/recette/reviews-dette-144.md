# Reviews — dette 144 (branche `dette-144-code-incertain`)

Chaque rapport est recopié ici TEL QUEL, dès réception, avant toute
correction.

## Review 1 — reçue le 18 novembre 2026

Plage : `8a59d514e57f9599535268b17c9167e6a63a7604..622cc8eb0bd43ac926821b5788bf95bb453f1f59`,
worktree `/home/claude/hotesmart-dette144`. Contrôle : chaque fichier cité
comme constat figure dans `git diff --name-only` de la plage ; les mentions
« hors diff » sont dites comme telles.

---

**Arbre relu : `/home/claude/hotesmart-dette144`, branche `dette-144-code-incertain`, plage `8a59d514e57f9599535268b17c9167e6a63a7604..622cc8eb0bd43ac926821b5788bf95bb453f1f59` (HEAD = `622cc8eb…`, 7 fichiers).** Je n'ai rien modifié dans le worktree.

**Bloquant : non**

Réponses courtes aux 6 questions :
1. **Le marqueur est posé au bon endroit.** Il est « incertain » seulement si `sendResult.incertain === true`. `sendGuestMessage` transmet bien le drapeau sur les trois chemins : e-mail (`lib/cron-messages.js:238`), Channex (`:254`) et Beds24 (`:261`, qui recopie le retour de `sendViaBeds24` ; l'exception y pose `incertain:true`, `lib/cron-beds24.js:550`). Les cas `differe` et `permanent` ne portent jamais `incertain` à la source, donc ils gardent le marqueur « impossible ». C'est juste aujourd'hui, mais aucun test ne le tient (constat 3).
2. **Aucun lecteur n'ignore la tâche incertaine.** Recherche `git grep` sur tout le dépôt :
   - seule `lib/cron-classify.js` lit le marqueur exact ;
   - `lib/gardes-des-fils.js` et `cron-classify.js:705` filtrent par le préfixe `[AUTO:`, que portent les deux marqueurs ;
   - `api/messages.js:297` recopie `guest_message` dans `conversations` sans le comparer à rien ;
   - les écrans affichent `suggested_reply` avant `summary` (`pages/messages.html:659`, `pages/aujourdhui.html:1066`) ;
   - `etats_arrivee` se calcule depuis `access_codes` et les messages sortants, et `shared/cache-ecran.js` exclut le bloc `taches` en entier, sans regarder son contenu ;
   - aucune migration SQL ne contient le marqueur.
3. **L'ordre de priorité est juste à l'intérieur d'un même statut**, avec un trou entre statuts (constat 1). Le texte injecté est cohérent avec la règle EXACTITUDE du prompt (`lib/cron-classify.js:977`) : un code non « marqué envoyé » ne se dit pas envoyé, et un voyageur qui dit ne pas l'avoir reçu donne une intervention.
4. **Aucun risque de chargement.** `lib/marqueurs-code-acces.js` ne dépend de rien, donc pas de cycle. Les tests doublent les modules par `require.cache` sans toucher à celui-ci, et la suite complète passe.
5. **Les tests neufs passent pour la bonne raison** (contre-épreuve plus bas). Des mutations survivent (constats 3 à 5).
6. **Aucune régression sur le chemin d'envoi.** Le diff ne change que deux valeurs de l'insert, sans nouvel `await`. L'ordre envoi → tâche → journal → `active` → alerte de la dette 141 est intact, et ses tests restent verts.

**Constats**

1. **MINEUR — `lib/cron-classify.js:790-801`.** La règle « un NON ENVOYÉ sûr l'emporte sur un incertain » ne vaut qu'à l'intérieur d'un même statut. Les tâches en attente sont examinées avant les tâches écartées.
   - Scénario : un logement a deux modèles de code. Celui du code A est coupé pendant l'envoi (tâche incertaine en attente). Celui du code B est refusé par le canal, et l'hôte écarte sa tâche. L'agent lit « ENVOI INCERTAIN » alors que le code B n'est sûrement pas parti. Avant le lot, il lisait « NON ENVOYÉ ». Cas rare, et l'agent ne peut toujours pas dire « envoyé ».
   - Correction : avant le bloc des tâches en attente, rendre « NON ENVOYÉ » dès qu'une tâche « impossible » ou une tâche écartée non incertaine existe, quel que soit son statut. Ou corriger le commentaire de la ligne 791 pour qu'il dise la portée réelle.

2. **MINEUR — `lib/cron-classify.js:801` (texte de 775-776).** Le suffixe « (l'hôte n'a pas voulu le renvoyer) » est collé après « c'est une intervention ». Il semble donc qualifier l'intervention. Et c'est une interprétation : l'hôte a pu donner le code par téléphone. Le modèle risque de la répéter au voyageur.
   - Correction : un libellé factuel placé avant la consigne, par exemple « ENVOI INCERTAIN (proposition de renvoi écartée par l'hôte) — … ».

3. **MINEUR (couverture) — `tests/arrival-code-manquant-alerte.test.js:501`.** Le test du refus n'utilise qu'un refus nu (`{ok:false, reason}`). Deux mutations passent toute la suite :
   - M2 : `incertain = sendResult.incertain === true || !!sendResult.differe` ;
   - M3 : la même avec `!!sendResult.permanent`.
   - Scénario futur : quelqu'un élargit la condition. Une adresse e-mail invalide ou un `call_error` Channex (le code n'est pas parti, c'est sûr) deviennent « incertain », et l'agent cesse de dire « NON ENVOYÉ ».
   - Correction : ajouter les cas `{ok:false, permanent:true}` et `{ok:false, differe:true}` → `MARQUEUR_CODE_IMPOSSIBLE`.

4. **IMPORTANT (couverture, hors diff : `lib/cron-messages.js:254`, `lib/cron-beds24.js:550`).** Le lot s'appuie sur le drapeau `incertain` de Channex et de Beds24, mais aucun test ne vérifie qu'il traverse `sendGuestMessage`.
   - M10 (Channex `incertain: false` dans `sendGuestMessage`) et M12 (pas de `incertain` dans le `catch` de `sendViaBeds24`) passent toute la suite (8828 tests).
   - Seul le chemin e-mail est tenu (`tests/canal-routage-envoi.test.js:355`). Les tests du lot doublent `lib/cron-messages.js` entier.
   - Scénario : une réécriture perd le drapeau. Une coupure Channex redevient « impossible », la dette 144 se rouvre sur le canal principal, et la suite reste verte. C'est le cas « chemin réel traversé par aucun test » de CLAUDE.md.
   - Correction : deux tests sur le modèle de `canal-routage-envoi.test.js:355`, l'un pour Channex `network_error` → `incertain:true`, l'autre pour une exception `fetch` Beds24 → `incertain:true`. Le code actuel est juste ; ce n'est donc pas bloquant pour ce lot.

5. **MINEUR — `tests/guestflow-messages-en-attente.test.js:560`.** Le test « pas recopiés » se contourne et est trop strict à la fois :
   - M9 réécrit le marqueur en concaténation (`'[AUTO: arrival_code' + ' — envoi impossible]'`) et passe ;
   - une regex `/envoi impossible/` comme avant le lot passerait aussi ;
   - à l'inverse, un simple commentaire qui citerait le marqueur entier ferait rougir.
   - Le test « LE TEST QUI COMPTE » de l'état des envois (la mutation M7 l'a montré) tient déjà le fond. Celui-ci peut rester comme alarme de style, mais il ne prouve pas que le module est utilisé.

6. **MINEUR (hors diff) — `lib/cron-classify.js:803`.** Une tâche en statut `sending` (« Envoyer » cliqué, envoi en cours) tombe sur « marqué envoyé par le système ». Le cas existait déjà pour la tâche « impossible » et la fenêtre est courte. À noter pour un lot futur.

**Expériences** (copies `git archive` dans /tmp, `node_modules` lié, toutes supprimées ensuite ; worktree vérifié intact : `git status` = `?? node_modules`, présent avant)

| Expérience | Résultat |
|---|---|
| Les 2 fichiers touchés, sur la tête | 82/82 verts |
| Suite complète, sur la tête | 8828 tests, 3 rouges. Mêmes 3 rouges sur la base `8a59d514` dans la même archive, et 16/16 verts dans le worktree : ils viennent de l'absence de dépôt git dans l'archive, pas du diff |
| Contre-épreuve : tests neufs contre le code d'avant | 4 rouges (les tests du lot). Les 2 gardes de non-régression restent vertes, comme leurs commentaires l'annoncent |
| M1 (`incertain = false`), M4 (tout refus = incertain), M5 (sans priorité « impossible »), M6 (`some` au lieu de `every`), M7 (marqueur incertain retiré de la liste), M8 (tâches écartées toujours « NON ENVOYÉ ») | attrapées |
| M2 (`differe`), M3 (`permanent`), M9 (marqueur recopié en concaténation) | survivent |
| M10 (Channex), M12 (Beds24) | survivent à la suite complète |
| `etatDuModele` évalué à part | « incertain en attente + impossible écarté » rend ENVOI INCERTAIN ; une tâche en `sending` rend « marqué envoyé » |
