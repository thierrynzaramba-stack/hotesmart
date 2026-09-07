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

## 3 bis. Étape 0 — CONSTATS ET DÉCISIONS GRAVÉES (7 septembre 2026)

Étape 0 menée par les faits, en lecture seule. Constats complets : `analyse.md`.

### Les constats qui commandent

- **Le cœur ne porte aucun prix futur.** 33 lignes de `calendar_inventory` sur
  1172 portent un prix, toutes PASSÉES. Sur J → J+365 : 0 prix, 4 biens sur 4.
  Le seul writer de `rate` est `api/calendar.js` POST — l'hôte qui saisit un prix.
  Rien n'importe jamais un prix depuis le provider : `lib/channels/index.js`
  n'expose aucune méthode de lecture de prix.
- **La grille Channex est complète mais plate** : 365/365 jours avec prix, une
  seule valeur (86 € sur Colomiers, 90 € sur le bien de test) — c'est
  `properties.base_price` recopié, pas une intention tarifaire.
- **Les rate_plans divergent.** Channex rend 5 rate_plans pour Colomiers ; les
  dérivés Booking.com portent `min_stay = 2`, le rate_plan du bien porte 1.
- **`properties.inventory_units` est une COLONNE, pas une table.**
- **Le widget Beds24 de coeurdevie65.com est un plugin WordPress**
  (`beds24-online-booking`), ni iframe ni script — mode non reproductible.
- **Aucun en-tête ne bloque l'embarquement en iframe** en production (pas de
  `X-Frame-Options`, pas de `frame-ancestors`).

### Les décisions (Thierry, 7 septembre 2026)

1. **PRIX — mémoire d'exceptions, comme le stop-sell.**
   `calendar_inventory.rate` s'il est présent, **sinon `properties.base_price`**.
   Un bien **sans `base_price` n'est pas réservable** — le moteur ne l'expose pas.
   Conséquence : **« une date sans prix » n'existe plus.** Ou le bien a un prix
   de base et toutes ses nuits ont un prix, ou il n'est pas vendable du tout.
   Le calendrier ne porte que les **écarts** au prix de base.
2. **REMPLISSAGE — aucun.** Pas de réconciliation de prix : la grille provider
   n'est que `base_price` recopié (vérifié), la réconcilier n'apporterait rien
   et créerait un second writer. La **ligne « Prix » du calendrier reste le
   writer unique des exceptions** ; YieldFlow y écrira plus tard.
   *Note phase 4* : à la migration, **amorcer les exceptions de prix réelles
   depuis Beds24**, exactement comme l'amorce du stop-sell (étape 0 du chantier
   audit).
3. **IFRAME — v2.** La page `/book` **reste embarquable** (aucun en-tête
   bloquant, à ne pas en introduire), mais **l'usage v1 est un LIEN pleine
   page**. Cela règle du même coup la réserve 3DS : aucun paiement en iframe.
   L'iframe est documentée comme évolution v2.
4. **TOKEN — recette `crypto.randomBytes(32).toString('base64url')`**
   (43 caractères), **régénérable** (régénérer révoque l'ancien lien).
   **JAMAIS `public_tokens`** : c'est le jeton des prestataires de ménage, et
   cette table a déjà coûté un incident de double writer.
   ⚠ **Le support de ce jeton a changé** : la colonne `properties.booking_token`
   prévue ici est **remplacée par la table `booking_links`** (amendement §3 ter,
   ajout 1). La recette du jeton et l'interdit `public_tokens` sont inchangés.
   *La migration `2026-09-07-moteur-reservation.sql` est caduque et n'a jamais
   été appliquée.*

### RÈGLE GRAVÉE — le moteur ne lit QUE le rate_plan du bien

Tout chemin qui lit des restrictions ou un tarif chez le provider pour le compte
du **canal direct** lit **uniquement** le rate_plan désigné par
`properties.provider_rate_plan_id`. **Jamais les rate_plans dérivés des OTA.**

Vécu qui la fonde : les dérivés Booking.com de Colomiers portent `min_stay = 2`
là où le rate_plan du bien porte 1. Un moteur qui lirait « le » min_stay sans
nommer son rate_plan refuserait au voyageur direct une nuit unique que l'hôte
accepte — il appliquerait au canal direct une contrainte d'OTA. Les rate_plans
dérivés décrivent ce que les OTA vendent, jamais ce que l'hôte vend en direct.

### Stripe

Le webhook des paiements de réservation est un **endpoint DÉDIÉ**, distinct de
`api/stripe.js` (facturation SaaS). On ne touche pas au webhook existant : le
casser couperait la facturation des abonnements.

## 3 ter. Amendement gravé (Thierry, 7 septembre 2026) — LIENS MULTIPLES, COEFFICIENT, APP DE CONFIG

Quatre ajouts liés. Ils forment un tout : le lien cesse d'être un simple jeton
d'accès pour devenir **le point de vente**, avec sa provenance et son prix.

### Ajout 1 — Plusieurs liens de réservation par bien

Un hôte aura **plusieurs sites**, et un même bien peut vivre sur deux d'entre
eux. Un jeton unique par bien ne le permet pas.

Table **`booking_links`** :

| colonne | rôle |
|---|---|
| `id` | clé |
| `property_id` | le bien (UUID, FK `properties`) |
| `token` | 43 caractères base64url, **unique**, la clé d'entrée publique |
| `label` | l'étiquette du site (« Cœur de Vie », « Gîtes de France »…) — c'est la **provenance** |
| `price_coefficient` | coefficient de prix, en **pourcentage**, défaut **100** |
| `active` | un lien se **désactive** sans se supprimer (les stats de provenance survivent) |
| `created_at` | |

**`/book/<token>` résout le LIEN**, donc d'un seul coup : le **bien**, le
**coefficient** et la **provenance**. Un bien sans aucun lien actif n'a pas de
page publique — ce n'est pas une erreur, c'est l'état par défaut.

### Ajout 2 — Coefficient de prix par lien

Défaut **100 %**. Appliqué **à l'affichage ET à l'encaissement** : le prix
coefficienté est celui que le voyageur voit, celui qu'il paie, et celui qui part
dans la réservation CRS.

> **RÈGLE GRAVÉE — le coefficient ne réécrit JAMAIS les prix du cœur.**
> C'est une lentille posée à la lecture, pas une écriture. `calendar_inventory`
> et `properties.base_price` restent la vérité unique, identique pour tous les
> canaux. Même logique que le markup par canal des OTA.
> Le violer créerait un second writer des prix — exactement ce que la décision 2
> de l'étape 0 a refusé.

### Ajout 3 — Une APP de configuration, pas un écran isolé

La configuration du moteur est **une app du menu HôteSmart, au même rang que les
autres apps du produit** — pas une page perdue dans `/settings`.
*(Test qui tranche, CLAUDE.md : ce réglage a-t-il un sens si l'app n'existait
pas ? Non → il vit dans l'app.)*

**Nom à valider par Thierry** (ex. « BookFlow » — non tranché).

Contenu, **par bien** :
- activation du moteur ;
- **politique d'annulation** (les 4 de §2) ;
- **gestion des liens** : créer, étiqueter, régler le coefficient, copier l'URL,
  révoquer ;
- **aperçu** de la page publique.

**Desktop d'abord.** C'est l'**étape 3 bis** de la spec : elle vient **après** le
parcours voyageur complet, pas avant.

### Ajout 4 — La provenance voyage avec la réservation

Le `label` du lien part dans le **`meta`** de chaque réservation créée
(aux côtés de `source: "hotesmart-engine"`). Objectif : **des statistiques par
site** plus tard. Rien à construire côté stats maintenant — seulement ne pas
perdre l'information à la source.

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

## 6 bis. Étape 3 bis — l'app de configuration du moteur

Voir §3 ter ajout 3. Vient APRÈS le parcours voyageur (étapes 1 à 3), jamais
avant : on configure ce qui existe et qu'on a vu fonctionner.

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
