# Nuit du 1er au 2 octobre 2026 — décisions et arrêts

> Mode autonome demandé par Thierry. Règles : branche `lot-avis-1-protocole` et
> STAGING seulement ; rien sur `main`, rien en production, aucune migration de
> production, aucune rotation. Une revue par commit. Sur une décision produit :
> l'option la plus prudente, notée ici, sans bloquer. Sur un risque pour la
> production : arrêt, noté ici.

Chaque entrée dit : la question, l'option retenue, pourquoi c'est la plus
prudente, et ce qui la défait si Thierry préfère l'autre.

## Décisions produit

### D1 — `eval_scope` : « seulement si autorisé » (demande de Thierry)

La valeur par défaut passe de `selon_grille` à **`aucun`**, et le serveur lit une
valeur absente comme `aucun`. **Les profils existants passent aussi à `aucun`** :
c'est l'option la plus prudente, et elle ne retire rien à personne en production,
où aucune évaluation n'a jamais été remplie (le chantier n'y est pas). L'hôte
autorise chaque prestataire depuis sa fiche (lot 5). **Défaire** : remettre la
valeur par défaut à `selon_grille` à **trois** endroits — la migration (sans son
`update`), `api/avis.js` (`roleEtReglages`) et `lib/avis/evaluations.js`
(`enregistrerReponses`).

**Conséquence de sécurité trouvée en revue, et fermée.** `aucun` coupait le
formulaire, pas la publication : un profil « aucun + valider » — que la
migration crée justement à partir de « selon_grille + valider » — lisait le
texte public et publiait l'évaluation remplie par l'hôte. La publication
(`lib/avis/publication.js`) et la lecture (`evaluationLire`) exigent désormais
`selon_grille`.

### D2 — Quand une évaluation NAÎT (pièce manquante trouvée cette nuit)

**Constat.** Aucun code ne créait de ligne `guest_evaluations` : seuls les scripts
de recette en inséraient. En production, la liste serait restée vide à jamais.

**Mesure en production, lecture seule (2 octobre 2026, 1 h)** : 576 objets review
Airbnb chez Channex, **tous** avec une note du voyageur. Channex ne crée donc
l'objet — la cible de la publication — que lorsque le voyageur a laissé un avis.

**Option retenue — deux naissances, aucune date inventée :**
1. quand la prestataire ouvre ses questions après « Ménage fait », pour un séjour
   **Airbnb passé par Channex** : l'évaluation naît `a_remplir`, sans objet ni
   échéance ;
2. quand l'objet review Channex arrive (poll ou webhook) pour un séjour résolu :
   il est rattaché à l'évaluation existante, ou en crée une, avec
   `deadline_at = expired_at` de Channex.

La publication reste refusée tant que l'objet n'existe pas (motif
`sans_objet_ota`, déjà en place). Pas de naissance à chaque départ : ce serait un
balayage, et des évaluations que l'hôte remplirait pour un voyageur qui
n'écrira jamais d'avis.

**Ce que ça coûte.** Un hôte sans prestataire ne voit une évaluation qu'une fois
l'avis du voyageur reçu. **Défaire** : ajouter une naissance au départ dans le
dispatcher de réservations.

### D3 — Le jeton de la PWA : ce qu'il ouvre, et ses bornes

La prestataire évalue **depuis sa PWA, par son jeton**, sans compte. Cinq gardes
avant toute écriture (profil actif par lien, ménage **à elle**, ménage **fait**,
séjour Airbnb par Channex, **autorisée** par l'hôte), puis les mêmes règles que
la session. Bornes prudentes ajoutées en revue :

- **départ de moins de 30 jours** (la fenêtre de Channex) — un ménage ancien ne
  fait plus naître d'évaluation ;
- **pas de nouvel appel payant à l'IA** si ses réponses n'ont pas changé ;
- **aucun message brut de la base** renvoyé à un porteur de lien ;
- le bus est chargé **à la demande** dans la PWA : un échec ne peut pas faire
  tomber « Ménage fait ».

**À confirmer par Thierry (S2 de la revue).** Une prestataire « publie
elle-même » (`valider`) dont **toute** la grille est à elle peut publier une
évaluation que l'hôte a complétée de son côté, avant qu'il ne la valide. C'est la
règle déjà gravée le 30 septembre (« si ses critères couvrent toute la grille du
bien, elle relit et publie ») ; le jeton la rend simplement possible hors
session. Option plus prudente si besoin : une évaluation où l'hôte a répondu
revient toujours à l'hôte.

### D4 — Lot 7 : la dette E1, et l'archivage calculé à la lecture

**E1.** Depuis « l'étape 4c », la messagerie lit **déjà le cœur** par défaut
(`/api/messages`, table `messages`). Il ne reste à lire Beds24 en direct que le
**filet de repli** `?legacy=1`. Le supprimer retirerait la roue de secours d'un
écran critique en production, en pleine nuit : **gardé**, sa suppression est à
ta main. L'archivage n'en dépend pas — il se calcule sur la table `messages`.

**L'archivage (spec §9)** s'appuie sur les colonnes déjà posées le 25 septembre
(`conversation_flags` : `archived_manual`, `archive_after`,
`unarchived_manual_at`, `archived_reason`, `property_id_ref`) — **aucune
migration neuve**. Option la plus prudente retenue : l'état automatique
(évaluation publiée, dix jours d'inactivité) se **calcule à la lecture**
(`lib/archivage-conversations.js`), au lieu de stocker `archive_after` à chaque
événement — ce qui aurait ajouté un writer dans le chemin d'ingestion des
messages, le plus sensible du produit. `api/messages.js` reste le seul writer de
l'archivage **manuel**. La publication arrive par le journal du cœur
(`core_events`), jamais par les tables des avis.

**Non fait, et noté :** le renommage `book_id` → `booking_uid` prévu « au lot 7 »
par la migration du 25 septembre. Il casse l'épinglage dans la fenêtre entre le
collage et le déploiement ; il mérite un lot à lui, avec toi.

**Ce que ça coûte** : à 30 000 comptes, calculer l'état à chaque lecture est plus
cher qu'un filtre indexé sur `archive_after`. Aujourd'hui, la lecture est déjà
bornée à six mois et 2 000 messages par compte : négligeable.

## Arrêts — ce que je n'ai pas fait, et pourquoi

### A1 — Rien n'est poussé depuis `a93273c`, et staging n'a pas reçu les lots 5 à 7

Vers 3 h, la commande qui poussait la branche vers GitHub et la fusionnait dans
`staging` a été **refusée par le mode automatique** (« publication hors de
place »). Je n'ai pas cherché à contourner ce refus : cette nuit, plus aucun
`push`, et le worktree `hotesmart-staging` n'a pas été touché (propre, sur
`86adf93`, l'état laissé par la session `fix-menage`).

**Conséquence.** Tout le travail des lots 5 à 7 est **commité en local** sur
`lot-avis-1-protocole`, revu et testé, mais **pas déployé** : la recette du matin
commence par la publication sur staging, par toi — les commandes exactes sont
dans le plan de mise en production.

### A2 — Les migrations de la nuit ne sont appliquées nulle part

Aucun accès SQL à staging cette nuit (les migrations se collent à la main dans
l'éditeur). Les deux fichiers neufs sont prêts, dans l'ordre :
`2026-10-02-avis-eval-scope-sur-autorisation.sql`,
`2026-10-02-avis-index-relances.sql`.

## Constats hors chantier

- **Cinquième famille de rouges calendaires**, signalée par la session
  `fix-menage` le 2 octobre 2026 à minuit : 6 tests « ANNULATION » de
  `tests/price-log.test.js` (nuits figées du 1er au 3 octobre 2026). Contre-épreuve
  `JOURS=-1` : 44/44. Compte attendu cette nuit : **34**. Non traité ici — hors
  chantier avis, et la décision est demandée à Thierry par l'autre session.
