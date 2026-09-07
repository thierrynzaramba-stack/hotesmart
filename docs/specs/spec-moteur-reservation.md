# Spec — Moteur de réservation direct (phase 3)

> Le chantier pour lequel tout le reste a été construit : la page publique qui
> remplacera le widget Beds24 sur coeurdevie65.com au moment de la migration
> (phase 4). Fichier de référence : `docs/specs/spec-moteur-reservation.md`.
> Périmètre : biens Channex uniquement. Réutilise tel quel : la primitive CRS
> (phase 2 §3), le verrou + capacité (phase 2 §4), la mémoire d'intention
> stop-sell (chantier audit stop_sell).

## 1. Objectif

Un voyageur arrive depuis le site vitrine de l'hôte, voit les disponibilités et
les prix, réserve et paie en ligne. La réservation entre chez Channex par le CRS
(`ota_name: "Offline"`, `meta.source: "hotesmart-engine"`), ferme les dispos sur
les OTA, revient dans le cœur par le feed — ménage, codes, alarmes fonctionnent
sans code spécifique. L'hôte n'a rien à faire.

## 2. Décisions gravées (Thierry, 7 septembre 2026)

- **Paiement : 100 % à la réservation.** Pas d'acompte en v1.
- **Politique d'annulation : réglage PAR BIEN**, choisi par l'hôte parmi 4 :
  non remboursable / remboursable J-14 / remboursable J-7 / flexible (J-2).
  Affichée clairement AVANT le paiement, dans la langue du voyageur.
  (V1 : la politique est affichée et contractuelle ; le remboursement d'une
  annulation reste un geste manuel de l'hôte via Stripe — pas de self-service
  voyageur.)
- **Langues : français, espagnol, anglais.** Détection navigateur + sélecteur.
- **Respect STRICT du stop-sell** (règle gravée au chantier audit) : une date
  fermée à la vente n'est jamais proposée — ni sélectionnable ni visible comme
  libre. Le moteur lit l'intention mémorisée ET le stock calculé.
- **Email de confirmation au voyageur** — la brique reportée de la phase 2,
  construite ici : envoi transactionnel après paiement + création réussis,
  trilingue, avec récapitulatif, politique d'annulation, contact hôte
  (`telephone_hote`). Prévoir le canal email réutilisable par la saisie
  manuelle plus tard.
- **Stripe : compte propre de l'hôte-fondateur en v1** (pas de Connect
  multi-hôtes — v2). Mode test d'abord, bascule live à la migration.
- **Ordre paiement/création — la règle qui protège l'argent** :
  1. verrou + vérification capacité/stop-sell (rien n'est promis avant),
  2. paiement Stripe confirmé (PaymentIntent, 3DS),
  3. createBooking CRS (POST jamais rejoué — règle phase 2),
  4. si la création échoue APRÈS encaissement : remboursement automatique
     immédiat + incident + alarme fondateur. Jamais d'argent gardé sans
     réservation existante.
- **Prix lus du cœur** (inventaire mode managed), monnaie du bien, total
  affiché avant paiement avec le détail par nuit.

## 3. Étape 0 — par les faits, avant toute construction

- Où vivent les prix publics aujourd'hui (calendar_inventory.rate ? complet
  sur quelles fenêtres ?) et que faire d'une date sans prix (non réservable).
- Le widget Beds24 actuel sur coeurdevie65.com : comment est-il intégré
  (iframe, script) — pour savoir ce que le remplacement exigera en phase 4.
  [Tâche partagée : Thierry a l'accès WordPress/Elementor.]
- Stripe : création du compte, récupération des clés test — TÂCHE MANUELLE
  THIERRY, guidée. Webhooks Stripe → endpoint HôteSmart, signature vérifiée.
- L'URL publique : forme /book/<token-par-bien> (token opaque, pas l'UUID),
  hébergée sur le domaine HôteSmart existant.
- Min-stay et restrictions : lesquelles existent en mémoire et lesquelles le
  moteur doit respecter (min_stay, cta/ctd).

## 4. Étape 1 — la page publique en lecture (sans paiement)

Calendrier de disponibilité (stock calculé + stop-sell respecté + min-stay),
prix par nuit, total du séjour, sélection de dates, formulaire voyageur
(prénom, nom, email, téléphone, nb de personnes plafonné à capacity).
Trilingue. Validée sur staging (bien test 2) avant toute suite.
Aucune donnée personnelle stockée à cette étape.

### 4 bis. Amendement gravé (Thierry, 7 septembre 2026) — CALENDRIER EN MARQUE BLANCHE

Le moteur n'expose pas seulement une page hébergée : il expose un **widget
calendrier intégrable** sur le site vitrine de l'hôte, exactement au rôle que
tient aujourd'hui le widget Beds24.

- Le widget affiche les **disponibilités** (stock calculé + stop-sell respecté)
  et les **prix par nuit**, en **FR / ES / EN**.
- **Aucune marque HôteSmart visible.** La marque affichée est celle de l'hôte ;
  couleurs sobres et personnalisables. Rien dans le rendu, les libellés ou les
  URLs visibles ne doit trahir le fournisseur.
- La **sélection de dates mène au parcours de réservation** (formulaire +
  paiement), lui aussi en marque blanche — continuité visuelle complète.
- L'intégration doit être **simple pour un site WordPress/Elementor** : coller
  un bloc et rien d'autre. Le mode exact — **iframe ou script** — se décide à
  l'étape 0, en regardant comment le widget Beds24 actuel est posé.
- **La page hébergée `/book/<token>` reste le socle** : le widget en est la
  forme intégrée, pas une seconde implémentation. Un seul moteur, deux formes
  d'exposition.

## 5. Étape 2 — paiement (Stripe mode test)

PaymentIntent au montant total (monnaie du bien), 3DS, webhook de confirmation.
Idempotence stricte : une clé d'idempotence par tentative, jamais de double
encaissement. Page de paiement aux couleurs sobres du bien (nom, photo v2).

## 6. Étape 3 — création, confirmation, échecs

Le chemin complet de §2 (verrou → paiement → CRS → feed), la page de
confirmation, l'email trilingue. Tous les chemins d'échec testés un par un :
paiement refusé (rien ne se passe), création CRS en échec après encaissement
(remboursement auto + incident + alarme), double-clic/double soumission
(idempotence), dates prises entre l'affichage et le paiement (verrou refuse
AVANT l'encaissement — jamais après).

## 7. Étape 4 — validation

- Staging : parcours complet répété, y compris les échecs provoqués.
- Prod en mode test Stripe : la page réelle, une carte de test, sur Colomiers
  (bien en pause, résa annulée derrière) — le passage réel qui validera aussi
  reaffirmerStopSell au premier mouvement de feed.
- La bascule Stripe live et le remplacement du widget appartiennent à la
  phase 4 (migration) : le moteur sera prêt et éprouvé, en attente.

## 8. Hors périmètre (v2 et au-delà)

- Annulation/modification self-service par le voyageur.
- Stripe Connect (encaissement au nom de chaque hôte) — v1 = compte propre.
- Acomptes, caution/dépôt de garantie, extras payants.
- Taxe de séjour automatique — À TRANCHER (Thierry) : affichée comme mention
  informative en v1 ou intégrée au prix ; rien de calculé automatiquement.
- Multi-biens / panier ; photos et page de présentation riche du bien.
- Codes promo, tarifs dégressifs.
