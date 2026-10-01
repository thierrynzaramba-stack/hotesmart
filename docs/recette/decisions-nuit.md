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

## Arrêts — ce que je n'ai pas fait, et pourquoi

*(rempli au fil de la nuit)*

## Constats hors chantier

- **Cinquième famille de rouges calendaires**, signalée par la session
  `fix-menage` le 2 octobre 2026 à minuit : 6 tests « ANNULATION » de
  `tests/price-log.test.js` (nuits figées du 1er au 3 octobre 2026). Contre-épreuve
  `JOURS=-1` : 44/44. Compte attendu cette nuit : **34**. Non traité ici — hors
  chantier avis, et la décision est demandée à Thierry par l'autre session.
