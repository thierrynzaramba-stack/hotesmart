# Spec — Historique des réservations (cœur de données)

> v2 du 5 septembre 2026 — intègre les décisions prises depuis l'étape 0.
> Chantier préalable à la migration Channex des deux biens de Bagnères.
> Fichier de référence : `docs/specs/spec-historique-reservations.md`.

## 1. Contexte et objectif

Constituer dans le cœur HôteSmart l'historique complet des réservations, données brutes incluses.
Ce chantier construit le cœur du produit, pas seulement YieldFlow : pricing, avis (`booking_uid`),
stats, et tout ce qui viendra.

## 2. Décisions gravées (ne pas rediscuter)

- Dernière version de chaque réservation + journal des changements. Pas de révisions intermédiaires.
- L'historique vit dans `bookings_snapshot`, étendu à toute la profondeur. Pas de nouvelle table.
- **Aucune purge de snapshots, jamais** — mais « sans purge » ≠ « sans réconciliation » :
  les annulations doivent être réconciliées (voir §5).
- Rétention : l'historique vit tant que le bien existe, supprimé avec lui (cascade FK,
  raccroché au blocker beta n°3, hors périmètre ici).
- La table reste clée TEXT `provider_property_id` (règle 10) ; le re-keying global est
  du ressort de la migration Channex, pas de ce chantier. Pas de colonne UUID maintenant.
- **`amount` = total payé par le voyageur, tous canaux, jamais le net hôte.**
  Source : `price` ; repli somme des charges (invoiceItems) uniquement pour le canal direct
  sans commission — seule configuration où le repli est homogène avec `price`.
  `price: 0` étant ambigu chez Beds24 (gratuit ou non renseigné), le mapper rend
  `undefined` (préserve le merge) ; une résa réellement gratuite n'aura jamais d'`amount`,
  trace conservée dans le raw.
- `commission` stockée à part. Net hôte = `amount − commission` : calcul d'app, jamais stocké.
- `currency` : non servi par Beds24 (vérifié par les faits, 71 champs, aucun candidat) —
  si besoin un jour, la source est le réglage du compte, jamais du parsing de texte libre.
  Channex la sert proprement.
- Règle du 2 septembre : toute donnée provider entre d'abord dans le cœur (couche sync),
  puis les apps la lisent. Jamais de dates approximées ou inventées.

## 3. Acquis de l'étape 0 (rappel des faits)

- Beds24 : 4 ans d'historique complet, 1 413 réservations (1 234 actives + 179 annulées),
  `price`/`commission` remplis à 100 %, ~24 crédits API par appel intégral (budget 100/5 min
  partagé avec le cron de prod).
  **Correction du 6 septembre** : ces 1 413 sont le total des **deux** biens, pas celui du
  seul 209413. `GET /bookings` ignore le filtre `propId` et rend tout le compte ; le code
  refiltre côté client, mais l'inventaire d'étape 0 avait attribué le total au premier bien.
  Répartition réelle : **209413 = 780** (686 actives + 94 annulées),
  **169567 = 633** (548 actives + 85 annulées). Les chiffres dérivés qui portaient sur le
  corpus entier (montants, volumétrie, taux de remplissage) restent exacts.
- Channex : historique depuis le branchement du canal seulement ; payload plus riche.
- Le writer conserve 14 champs (266 octets), jamais le payload brut → objet du sous-chantier A.
- La fenêtre -1j/+90j du flux nominal borne la réconciliation des annulations : les
  ~177 annulations passées ne seront JAMAIS réconciliées par le cron → objet du sous-chantier B.

## 4. Sous-chantier A — extension du writer : payload brut

Objectif : le writer (`lib/bookings-snapshot.js`) conserve le payload brut intégral,
pour Beds24 ET Channex, au fil de l'eau.

**Règle de détection de changement (la décision de conception, gravée) :**

> Un événement (`booking_change_events`) est déclenché **si et seulement si `merged` change** —
> c'est-à-dire les champs normalisés, comme aujourd'hui. Le `raw` est stocké, jamais comparé.
> Si le payload brut diffère mais que `merged` est identique : mettre à jour `raw`
> silencieusement, **sans** événement et **sans** toucher `updated_at`
> (`updated_at` = dernier changement de *contenu normalisé*, sémantique existante préservée).

Conséquences à implémenter et tester :
- Colonne `raw` (JSONB) sur `bookings_snapshot`, remplie par le writer dual-provider.
- Le premier cycle après déploiement réécrira toutes les lignes actives une fois
  (remplissage initial du raw) : profil identique au remplissage d'`amount`, accepté.
  Zéro événement attendu sur ce cycle — c'est le test d'acceptation de la règle ci-dessus.
- Test règle 8 sur données réelles : une annulation Channex à payload vide (le cas de la
  régression du commit 5f1777d) ne doit ni écraser le raw existant ni produire de faux merged.
- Déploiement méthode habituelle : biens en pause, cycle observé, réactivation.
  Review avant push. KB dans le même commit.

## 5. Sous-chantier B — backfill one-shot (après A stabilisé)

Script hors cron, idempotent, rejouable. Pattern du backfill d'unification.

- Périmètre : 209413 puis 169567 côté Beds24 — 4 ans, `includeCancelled`, **sans fenêtre
  de dates** : les ~177 annulations passées doivent entrer et réconcilier leur statut,
  sinon l'historique dit « confirmed » sur des séjours annulés et YieldFlow compte du
  CA fantôme. Colomiers côté Channex (dual-provider par construction, volume faible).
- Écriture via le writer unique exclusivement. `initialImport` posé ; `processed_at` posé
  inconditionnellement sur tout événement induit : le dispatcher ne consomme RIEN du backfill.
- Zéro tolérance sur : `menage_events` de départs passés, messages, codes, alertes.
- Upsert conditionnel : jamais écraser une ligne plus fraîche ; le backfill ne touche que
  le passé et les absentes.
- Crédits : throttle avec marge (clé partagée avec le cron), journal de progression,
  curseur de reprise.
- Ordre de validation : un bien → comptages par année vérifiés contre l'interface Beds24 →
  trois passages consécutifs no-op (preuve d'idempotence) → second bien.
- Vérification finale : échantillon aléatoire de 10 résas champ à champ, et mesure du
  bénéfice annoncé — rattachement des avis du 209413 attendu de 5/28 à ~24/28 sans code.
- KB mis à jour dans le même commit. Review avant push.

## 6. Point ouvert (arbitrage par les factures, hors code)

Deux saisies directes 2024 ont un `price` valide divergeant de la ligne de facture
(51980569 : 710,10 € vs 476,10 € ; 51035534 : 281 € vs 281,90 €). La règle « price fait foi »
est l'hypothèse par défaut — **l'arbitrage final appartient aux factures réelles de Thierry**,
pas à la cohérence interne. Si une facture contredit `price`, on corrige la donnée à la main
et on documente, on ne change pas la règle.

## 7. Hors périmètre (chantiers suivants, dans l'ordre)

1. Réservation manuelle (Channex Booking CRS — sous réserve du test staging, protocole
   des 6 points chez Thierry).
2. Moteur de réservation direct pour coeurdevie65.com.
3. Migration Channex des deux biens (re-keying TEXT global inclus).
