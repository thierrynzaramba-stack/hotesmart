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
- **Stripe : CHAQUE HÔTE APPORTE SES PROPRES CLÉS** (modèle SuperHote).
  Mode test d'abord, bascule live à la migration. Voir §3 bis — cette ligne a
  changé trois fois ; l'historique complet y est gardé exprès.
  ⚠ **Corrigé le 7 septembre 2026** : la version initiale disait « compte propre
  de l'hôte-fondateur », c'est-à-dire le même compte que la facturation SaaS —
  l'argent des voyageurs et les revenus HôteSmart mélangés dans un seul tableau
  de bord. Thierry a créé un **compte séparé**, qui isole l'argent qui ne lui
  appartient pas. Contrepartie assumée : la bascule en live (phase 4) demande
  **deux activations** (SIRET, IBAN, pièce d'identité, une fois par compte).
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

### Stripe — ARCHITECTURE REMPLACÉE LE 7 SEPTEMBRE 2026

> **Historique des décisions, gardé exprès.** Ce point a changé trois fois dans
> la même journée : (1) compte propre de l'hôte-fondateur, (2) compte dédié aux
> réservations, (3) Stripe Connect *direct charges*. **Aucune n'a été
> construite.** La décision qui tient est la quatrième, ci-dessous. Les
> précédentes restent écrites pour qu'on ne les repropose pas comme neuves.

**DÉCISION FERME (Thierry) — CHAQUE HÔTE APPORTE SES PROPRES CLÉS STRIPE.**
Modèle SuperHote. Pas de Connect, pas de compte plateforme, pas de commission
technique. Le moteur encaisse avec **la clé du propriétaire du bien**.

L'hôte-fondateur n'est **pas un cas particulier** : son compte « réservations »
est la **première ligne** de la même table, ses biens passent par le **même
chemin** que ceux de n'importe quel hôte. Aucune branche `si fondateur` n'a le
droit d'exister dans ce code.

**Ce que ça donne, et c'est le bon côté :** l'hôte est commerçant de plein droit.
L'argent arrive directement chez lui, les litiges et les frais sont les siens,
et **la page de paiement Stripe porte SA raison sociale** — ce qui sert la marque
blanche mieux qu'une page à notre nom.

**Le risque, dit une fois et assumé :** HôteSmart détient de quoi encaisser et
rembourser sur le compte de chaque hôte. Les clés **restreintes** réduisent la
portée, le chiffrement protège au repos, mais le risque ne disparaît pas — c'est
précisément celui que Connect évitait. Décision prise en connaissance de cause.

#### Les trois exigences gravées

1. **Chiffrées en base, jamais loguées, jamais réaffichées.**
   AES-256-GCM, clé dans `BOOKING_SECRET_ENCRYPTION_KEY`, format versionné
   `v1:<iv>:<tag>:<chiffré>` pour permettre une rotation. **Aucun endpoint ne
   rend une clé en clair, jamais** — l'écran n'affiche que le mode (test/live) et
   les 4 derniers caractères. Une clé qui se réaffiche est une clé qui fuit par
   copie d'écran, journal de navigateur ou capture de support.
2. **SEULES les clés RESTREINTES sont acceptées** — décision durcie le
   7 septembre 2026. L'écran **refuse** une clé secrète complète `sk_…`, il ne
   se contente pas de l'avertir. Raison gravée : *« un avertissement qu'on
   clique pour passer n'est pas une protection »*. Une `sk_` donnerait à
   HôteSmart les pleins pouvoirs sur le compte Stripe de l'hôte.
   Le refus est **antérieur à l'appel Stripe** : une clé qu'on n'acceptera pas
   ne part même pas sur le réseau.
   **Ne pas réintroduire l'avertissement** au motif qu'un hôte est bloqué.

   **PARCOURS STRIPE RÉEL** (traversé par Thierry le 7 septembre 2026 — c'est
   celui-ci qui fait foi, pas une reconstitution) :
   Développeurs → Clés API → onglet **« Clés limitées »** → « Créer une clé
   limitée » → *« Comment utiliserez-vous cette clé ? »* → **« Envoi de cette
   clé à une application tierce »** → écran des modèles → **« Personnalisé »**,
   jamais un paquet (une trentaine d'autorisations pour quatre nécessaires).

   ⚠ **La grille ne démarre PAS avec tout sur « Aucun »** : Stripe en pré-coche
   certaines. Il faut la **parcourir entièrement et tout remettre sur « Aucun »
   AVANT** d'accorder les quatre droits. Règle à vérifier avant de créer la
   clé : **exactement 4 lignes ont un droit, tout le reste est sur « Aucun ».**

   Les quatre droits, **nommés comme Stripe les écrit** :
   | Ligne de la grille | Niveau |
   |---|---|
   | `Payment Intents` | Lecture |
   | `Charges and Refunds` | Écriture |
   | `Checkout Sessions` | Écriture |
   | `Webhook Endpoints, Event Destinations` | Écriture *(tout en bas)* |

   ⚠ **Il n'existe PAS de ligne `Refunds` séparée** : les remboursements sont
   dans `Charges and Refunds`. Les versions précédentes de ce document
   nommaient `Refunds: write` et `Charges: read` comme deux droits distincts —
   la grille Stripe ne les sépare pas.

3. **Webhook créé automatiquement sur le compte de l'hôte à la connexion.**
   `POST /v1/webhook_endpoints` avec sa clé. On garde l'`id` (pour le remplacer
   ou le supprimer) et le `secret` (chiffré, comme la clé).

#### La table `stripe_accounts` (une ligne par HÔTE, pas par bien)

Un hôte encaisse pour **tous** ses biens : la clé se range sur le compte, pas sur
le logement. Colonnes : `user_id` (unique), `secret_key_cipher`, `key_last4`,
`mode` ('test'|'live', déduit du préfixe), `webhook_endpoint_id`,
`webhook_secret_cipher`, `webhook_url_token` (opaque, 43 car.), `verified_at`,
`last_error`, `created_at`, `updated_at`.

**`webhook_url_token` n'est pas décoratif.** Un webhook posé sur le compte propre
d'un hôte ne porte **aucun identifiant de compte** dans son corps — contrairement
à Connect. La signature ne peut donc être vérifiée qu'avec le bon secret, et le
bon secret ne se trouve que si l'**URL** dit de quel hôte il s'agit :
`/api/book-webhook/<webhook_url_token>`. Une URL unique par hôte.

#### Où l'écran de connexion vit

Dans l'app **« Réservation directe »** (étape 3 bis), pas dans `/settings` ni
`/connexions`.
Test qui tranche (CLAUDE.md) : cette clé a-t-elle un sens si le moteur n'existait
pas ? **Non** — elle ne sert qu'à encaisser des réservations directes.
*(À trancher par Thierry s'il préfère `/connexions`, qui porte déjà les
connexions PMS.)*

#### Variables d'environnement

| Variable | Valeur | État |
|---|---|---|
| `BOOKING_SECRET_ENCRYPTION_KEY` | 32 octets, base64 | **nouvelle, critique** |
| `BOOKING_ENGINE_PAYMENT` | `false` jusqu'à l'étape 3 | garde de sécurité |
| `APP_URL` | déjà posée | sert aux URLs de retour et de webhook |
| ~~`BOOKING_STRIPE_SECRET_KEY`~~ | — | **caduque : par hôte, en base** |
| ~~`BOOKING_STRIPE_PUBLISHABLE_KEY`~~ | — | **caduque : Checkout hébergé n'en a pas besoin** |
| ~~`BOOKING_STRIPE_WEBHOOK_SECRET`~~ | — | **caduque : un secret par hôte, en base** |

⚠ `BOOKING_SECRET_ENCRYPTION_KEY` **perdue** = toutes les connexions Stripe sont
mortes et chaque hôte doit recoller sa clé. **Divulguée** = toutes les clés des
hôtes sont exposées. Elle ne se régénère pas à la légère.

#### Dette découverte au passage (hors périmètre de ce chantier)

`api_keys` stocke **en clair** le jeton Beds24, la clé Brevo, la clé Seam et le
`refresh_token`, et **aucun chiffrement n'existe dans le dépôt**. Les clés Stripe
seront les premiers secrets chiffrés du produit. Aligner `api_keys` sur le même
mécanisme est un chantier à part, à programmer.

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

**NOM GRAVÉ (Thierry, 7 septembre 2026) : « Réservation directe ».**

Pas un nom de marque — un **libellé qui dit ce que ça fait**. Décision prise
contre l'option « BookFlow », écartée.

Ce que ça engage :
- **l'entrée de menu** porte « Réservation directe », en toutes lettres ;
- **le répertoire** est `apps/reservation-directe/` ;
- **aucun nom inventé** ne se glisse ailleurs — ni dans une page, ni dans un
  libellé de droit, ni dans une variable d'environnement.

⚠ **À ne pas confondre avec `docs/kb/reservation-directe.md`**, qui documente la
SAISIE MANUELLE d'une réservation par l'hôte (phase 2, primitive CRS). Les deux
noms se ressemblent parce que les deux choses le sont : dans les deux cas une
réservation entre par HôteSmart plutôt que par une OTA. La différence est **qui
la saisit** — l'hôte lui-même dans la phase 2, le voyageur dans cette app-ci.
Le KB de cette app est `docs/kb/moteur-reservation.md`.

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

## 5. Étape 2 — connexion Stripe de l'hôte, puis paiement (mode test)

Réécrite le 7 septembre 2026 : le modèle « clés de l'hôte » (voir §3 bis) coupe
cette étape en deux moitiés qui se livrent dans cet ordre.

### 5.1 — Connecter le compte Stripe de l'hôte

Sans compte connecté, il n'y a rien à encaisser : cette moitié vient d'abord.

- Écran d'onboarding **guidé** : où trouver les clés restreintes chez Stripe,
  quels droits cocher, comment vérifier qu'on est bien en **mode test**.
- L'hôte colle sa clé `rk_test_…`. HôteSmart, dans l'ordre :
  1. **vérifie** la clé par un appel en lecture (elle est valide, elle est du
     bon mode) — une clé fausse est refusée tout de suite, pas au premier
     voyageur ;
  2. **chiffre** et stocke ; la clé en clair ne survit pas à la requête ;
  3. **crée le webhook** sur le compte de l'hôte, stocke `id` et `secret` chiffré.
- L'écran ne réaffiche **jamais** la clé : mode, 4 derniers caractères, date de
  connexion, état du webhook. Un bouton « remplacer », jamais « afficher ».
- **Reconnexion** : remplacer une clé supprime l'ancien webhook chez Stripe avant
  d'en créer un nouveau. Deux webhooks vivants livreraient deux fois le même
  événement.

### 5.2 — Le paiement : Stripe Checkout HÉBERGÉ (v1)

**Décision : page Checkout hébergée par Stripe.** Le voyageur est redirigé vers
la page de paiement — qui porte la **raison sociale de l'hôte**, son compte étant
le commerçant — puis revient sur la page de confirmation.

Pourquoi hébergé plutôt qu'intégré, en v1 :
- **Le 3DS, les moyens de paiement locaux et la conformité sont chez Stripe.**
  Rien de sensible ne traverse notre page.
- La réserve 3DS notée à l'étape 0 disparaît : plus de champ de carte chez nous,
  donc plus de question d'iframe.
- **Payment Element intégré = v2**, si et seulement si la redirection gêne.

Le chemin, dans l'ordre du §2 :
1. **verrou + vérification** capacité / stop-sell / prix — rien n'est promis
   avant, et le refus arrive **avant** tout encaissement ;
2. **tenue des nuits**, puis création de la **Checkout Session** avec la clé de
   l'hôte, montant recalculé par le serveur, `idempotency_key` par tentative ;
3. redirection ; retour par `success_url` / `cancel_url` sur `/book/<token>` ;
4. le **webhook de l'hôte** confirme (`checkout.session.completed`).

**Idempotence stricte** : une clé par tentative, jamais de double encaissement.
Un double-clic, un rejeu réseau ou un retour arrière retombent sur la même
tentative, donc la même Session.

Événements écoutés : `checkout.session.completed`,
`checkout.session.expired` (libère la tenue sans attendre l'expiration),
`payment_intent.payment_failed`, `charge.refunded`.

### 5.2 bis — Purge des tentatives (décision Thierry, 7 septembre 2026)

`booking_attempts` stocke **nom, e-mail et téléphone** de voyageurs qui n'ont
peut-être jamais payé. Deux régimes, et ils ne se confondent pas :

| Cas | Règle |
|---|---|
| **Jamais payée** (`pending`, `failed`, `expired`) | **anonymisation à 30 jours** |
| **Payée** (`paid`, `booked`, `refunded`) | **conservation comptable** |

**Anonymisation, pas suppression.** La ligne reste — dates, montant, lien
d'origine, statut — mais les champs personnels sont écrasés. On garde de quoi
mesurer (combien de tentatives abandonnées, sur quel lien, à quel prix) sans
garder de quoi identifier qui que ce soit. Supprimer la ligne perdrait la
statistique en même temps que la donnée personnelle.

Champs écrasés : `guest_first_name`, `guest_last_name`, `guest_email`,
`guest_phone`. Champs conservés : tout le reste.

Une tentative **payée ne s'anonymise jamais** par ce chemin : elle porte une
transaction, et sa durée de conservation relève du comptable, pas de nous.

**Le cron de purge est une tâche de l'étape 3** (`api/cron.js`, cadence
quotidienne suffit). Il n'a rien à purger avant que 30 jours ne se soient
écoulés, ce qui laisse le temps de le livrer avec l'étape 3 — mais il doit
**exister avant que le moteur ne serve de vrais voyageurs** (phase 4).

⚠ `api/cron.js` est TOUJOURS régénéré en fichier COMPLET, jamais rustiné
partiellement (règle dure, CLAUDE.md).

### 5.3 — Ce que l'étape 2 ne fait PAS

Elle ne crée **aucune réservation** : c'est l'étape 3. Tant que celle-ci n'existe
pas, un paiement réussi laisse une tentative en `paid` — de l'argent encaissé
sans réservation, ce que la règle 4 du §2 interdit. D'où deux protections :

- **`BOOKING_ENGINE_PAYMENT` fermée par défaut** : sans elle, l'endpoint de
  paiement refuse. L'absence de la variable est le comportement sûr, sur le
  modèle de `SENDVIABEDS24_ENABLED`.
- **Alarme fondateur** sur toute tentative qui atteint `paid`, et sur tout
  paiement orphelin. De l'argent qui dort sans réservation ne doit jamais être
  silencieux.

## 6. Étape 3 — création, confirmation, échecs

Le chemin complet de §2 (verrou → paiement → CRS → feed), la page de
confirmation, l'email trilingue, **et le cron de purge des tentatives**
(§5.2 bis : anonymisation à 30 jours des tentatives jamais payées). Tous les chemins d'échec testés un par un :
paiement refusé (rien ne se passe), création CRS en échec après encaissement
(remboursement auto + incident + alarme), double-clic/double soumission
(idempotence), dates prises entre l'affichage et le paiement (verrou refuse
AVANT l'encaissement — jamais après).

## 6 bis. Étape 3 bis — l'app « Réservation directe »

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
- **Stripe Connect — ÉCARTÉ, pas reporté.** Le modèle retenu est « chaque hôte
  apporte ses clés » (§3 bis). Connect aurait évité que HôteSmart détienne les
  secrets des hôtes ; le coût était un compte plateforme, une activation de plus,
  et un rattachement OAuth à construire. Décision assumée — ne pas la reproposer
  sans fait nouveau.
- **Payment Element intégré** — v2, seulement si la redirection vers la page
  Checkout hébergée gêne réellement à l'usage.
- Acomptes, caution/dépôt de garantie, extras payants.
- Taxe de séjour automatique — À TRANCHER (Thierry) : affichée comme mention
  informative en v1 ou intégrée au prix ; rien de calculé automatiquement.
- Multi-biens / panier ; photos et page de présentation riche du bien.
- Codes promo, tarifs dégressifs.
