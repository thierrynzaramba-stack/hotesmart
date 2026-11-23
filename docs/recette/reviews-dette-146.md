# Reviews — dette 146 (branche `dette-146-plafond-agent`)

Chaque rapport est recopié ici TEL QUEL, dès réception, avant toute
correction.

## Review 1 — reçue le 17 novembre 2026

Plage : `a7dad213951a8c24eb11eb9529ad0c50ec1d95e9..eae3a6a1608624efe61a63ce4ddb141dc128761a`,
worktree `/home/claude/hotesmart-dette146`. Contrôle : chaque fichier cité
comme constat figure dans `git diff --name-only` de la plage (les mentions
« hors diff » sont dites comme telles).

---

Arbre lu : `/home/claude/hotesmart-dette146`, branche `dette-146-plafond-agent`, HEAD `eae3a6a1608624efe61a63ce4ddb141dc128761a`, plage `a7dad213…95e9..eae3a6a1…a761a`, soit un commit et 14 fichiers. Le worktree n'a pas été modifié : `git status` ne montre que `node_modules`.

**Rien de bloquant.** La suite complète passe dans le worktree : 8704 tests, 0 rouge. Les trois fichiers de tests modifiés passent aussi en décalant l'horloge de 4, 60 et 200 jours (66/66 chaque fois).

## Constats

**1. IMPORTANT (non bloquant) — `lib/cron-classify.js:1115-1117`**
- **Défaut :** la reconnaissance de l'ancien texte ne sert que si le fil atteint de nouveau le plafond. Le cas le plus courant après le déploiement est autre : le fil est déjà sous le nouveau plafond, l'agent repart, et l'ancienne tâche reste ouverte.
- **Scénario :** un fil arrêté à 3 appels juste avant le go a sa tâche « (3 appels en 24 h) : répondez au voyageur à la main » ouverte. Le voyageur écrit « Merci ! ». On est à 3 sur 6, donc l'IA est appelée.
  - En Mode Auto, la réponse part et couvre tout le lot, y compris le message que porte la tâche d'arrêt.
  - La tâche reste ouverte et continue de dire « répondez à la main ». Je l'ai vérifié par un test exécuté sur une copie de l'arbre : 1 envoi, et la tâche toujours ouverte avec l'ancien texte.
  - L'hôte risque donc de répondre une seconde fois.
  - C'est déjà ce qui se passe aujourd'hui quand la fenêtre de 24 h expire. Mais le go le déclenche d'un coup sur tous les fils arrêtés depuis moins de 24 h.
- **Correction :** avant le go, compter en production les tâches `pending` qui portent l'ancien texte. À plus long terme, et c'est une décision pour Thierry : fermer la tâche d'arrêt quand une réponse part, comme `fermerTachesPause` le fait pour la pause.

**2. MINEUR — `lib/cron-classify.js:1119`**
- **Défaut :** quand le fil atteint de nouveau le plafond, la mise à jour de la tâche existante ne touche que `guest_message`. Son `summary` garde « 3 appels ».
- **Scénario :** une ancienne tâche encore ouverte, puis le fil arrive à 6 appels. L'écran affiche « (3 appels en 24 h) », alors que l'alerte SMS envoyée au même moment dit « 6 » (`summary: MOTIF_ARRET`, ligne 1135).
- **Correction :** mettre aussi `summary: MOTIF_ARRET` dans la mise à jour, et ajouter cette vérification au test de la dette 146.

**3. MINEUR — commentaires inexacts sur la « ré-alerte » : `lib/cron-classify.js:1110-1111`, `tests/guestflow-boucle.test.js:379`**
- **Défaut :** ces commentaires disent que, sans la reconnaissance de l'ancien texte, l'hôte serait alerté une seconde fois. C'est faux : `tacheArretAgent` alerte l'hôte (SMS et notification) sur les deux chemins, mise à jour comme création.
- **Mesure :** avec la tâche ancienne bien reconnue, il y a quand même 1 alerte.
- **Réponse à ta question 3 :** l'alerte repart à chaque nouveau message reçu au plafond. C'est le comportement voulu par la review de ecce019 (point B2), pas un envoi à tort. L'incident au fondateur, lui, reste limité à un par fil sur 24 h, quel que soit le texte de la tâche. La reconnaissance évite seulement une seconde tâche.
- **Correction :** réécrire les deux commentaires.

**4. MINEUR — `lib/founder-notify.js:87`, et `tests/info-manquante-regles.test.js:49`**
- **Défaut :** le libellé de l'alerte fondateur écrit « 6 » en dur, et aucun test ne le tient. Remis à « 3 », la suite reste entièrement verte. De même, le test vérifie que le texte d'arrêt contient la chaîne `/6 appels/`, sans la rattacher à `PLAFOND_JOUR`.
- **Correction :** dans le test, vérifier `` `${PLAFOND_JOUR} appels` `` pour le texte d'arrêt et pour le libellé. Ou construire le libellé à partir de `PLAFOND_JOUR` : `guestflow-garde` ne charge pas `founder-notify`, donc pas de dépendance circulaire.

**5. MINEUR — `lib/guestflow-garde.js:40` (`LECTURE_MAX = 50`)**
- **Calcul du pire cas** sur 24 h, en tenant compte du délai croissant (5·2^(k-1) min) et d'au plus `PLAFOND_JOUR` succès qui découpent les séries d'échecs : **28 lignes avec un plafond de 3, 44 avec 6.** La lecture de 50 lignes suffit encore, mais la marge passe de 22 à 6.
- **Risque si on dépasse 50 :** les succès les plus anciens tombent hors de la lecture, et le plafond est sous-compté.
- **Correction :** passer à 100 (coût nul), ou ajouter un test qui fige cette borne.

**6. MINEUR — mentions de « 3 » ou de « 4e » restées dans des fichiers du diff (lignes non modifiées)**
- `lib/guestflow-garde.js:99` (« aucun 4e appel ») ;
- `lib/cron-classify.js:1273` (« une 4e fois ») ;
- `tests/guestflow-boucle.test.js:181`, et `:252` (titre « un 4e message ») ;
- `docs/specs/spec-info-manquante-choix.md:124` (« 3 appels ») et `:247` (« les 3 appels de l'agent »).
- Hors diff : `docs/specs/spec-delai-reponse-ia.md:501-502, 522, 726` et `docs/specs/spec-journal-ia.md:66`.

**7. MINEUR — `tests/guestflow-boucle.test.js:98` (`minutesAuPlafond`)**
- **Défaut :** la formule `300 - k*40` donne des dates dans le futur dès que `PLAFOND_JOUR` vaut 9 ou plus (k=8 donne −20 min). Le prochain relèvement fera dériver les tests en silence.
- **Correction :** répartir les dates dans le passé, par exemple `60 + k * 20`.

## Effets du passage à 6 (question 2)
- **Coût IA :** au plus +3 appels Sonnet réussis par fil sur 24 h, soit environ +3 ct $ par fil et par jour. C'est une estimation tirée du KB (0,8 à 1,1 ct par appel), pas une mesure.
- **Mode Auto :** jusqu'à 6 réponses automatiques par fil sur 24 h. Il y a toujours un seul appel par nouveau message du voyageur, donc un échange en boucle avec un répondeur automatique côté voyageur s'arrête à 6 envois au lieu de 3.
- **Revalidation de brouillons :** seuls `lib/cron-classify.js` et `api/guestflow-proposer.js` passent par la garde. `lib/guestflow/brouillons-dus.js` n'appelle pas l'IA, donc le changement n'a aucun effet de ce côté. La phrase de `docs/kb/guestflow.md:869` (« une revalidation consomme un de ces appels ») décrit une règle, pas du code existant.
- **Hors diff :** quand « Proposer une réponse » bute sur le plafond, il répond « réessayez dans quelques minutes » (`api/guestflow-proposer.js:83`). Au plafond, l'attente peut durer des heures.
- **Copies du texte d'arrêt :** les cartes « information manquante » passent toutes par `questionsDe`, qui reconnaît les deux textes. Aucune autre comparaison au texte d'arrêt dans le code, les pages ou le SQL.

## Les tests de la question 4 (contre-épreuves faites sur une copie `git archive` de `eae3a6a1` dans `/tmp`, supprimée ensuite)

| Mutation | Résultat |
|---|---|
| Retirer l'ancien texte de `MOTIFS_ARRET` | 1 rouge, le nouveau test de `guestflow-boucle`. Il passe pour la bonne raison. |
| Retirer l'ancien texte de `MOTIFS_SANS_QUESTION` | 1 rouge, le nouveau test de `info-manquante-regles`. Bonne raison. |
| Remettre `PLAFOND_JOUR = 3` | 2 rouges : « le plafond est 6 » et le texte du panneau dans les trois langues. Les autres tests suivent la constante, c'est voulu. |
| Remettre « 3 appels » dans les deux copies du texte d'arrêt | 1 rouge. Bonne raison. |
| Remettre le libellé fondateur à 3 | 0 rouge (constat 4). |

Trois tests sans rapport rougissent dans la copie, avec ou sans mutation, et passent dans le worktree. Je les attribue au fait que la copie n'est pas un dépôt git.
