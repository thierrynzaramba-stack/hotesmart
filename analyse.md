# Étape 0 — Inventaire par les faits : historique des réservations

Lecture seule. Aucun code de production écrit, aucune migration. 5 septembre 2026.

> **Réserve** : `docs/specs/spec-historique-reservations.md` n'existe pas dans le
> dépôt (ni en local, ni sur `origin`, ni sur aucune branche). Les 6 questions du
> §4 et le parti pris du §3 n'ont pas pu être lus. Ce rapport couvre les
> 4 investigations décrites dans la demande ; les réponses sont organisées autour
> des questions attendues, à confirmer une fois la spec disponible.

---

## 1. Beds24 — bien 209413 « Cœur de vie La bulle »

### Profondeur d'historique

| Mesure | Valeur |
|---|---|
| Arrivée la plus ancienne | **2022-09-06** |
| Réservation la plus ancienne prise (`bookingTime`) | **2022-09-05T09:00:09Z** |
| Arrivée la plus lointaine | 2026-09-26 |

**4 ans d'historique complet.** La borne n'est pas celle de l'API : `arrivalFrom=2015-01-01`
remonte jusqu'à septembre 2022, c'est-à-dire l'ouverture du compte. Beds24 ne
tronque pas, ne purge pas.

### Volumes

| Découpage | Nombre |
|---|---|
| Réservations non annulées | **1 234** |
| Réservations **annulées** (requête séparée) | **179** |
| **Total historique** | **1 413** |

Par année d'arrivée (hors annulées) : 2022 = 49, 2023 = 164, 2024 = 372,
2025 = 399, 2026 = 250.

### ⚠ Fait central n°1 — les annulations sont invisibles par défaut

`GET /bookings` **exclut silencieusement les annulations**. Il faut
`status=cancelled` explicitement pour les voir. Sans ce paramètre, aucun message
d'erreur, aucun indice : les 179 annulées n'existent tout simplement pas dans la
réponse.

Conséquence mesurée en production (§3 ci-dessous) : une réservation confirmée qui
est annulée **disparaît du fetch** au lieu de revenir avec un nouveau statut.
Le writer ne voit rien, `detectChange` ne produit rien, et le snapshot reste
`confirmed` **pour toujours**.

Autre appel testé : `GET /bookings` **sans aucun filtre** ne renvoie que **7**
réservations (les arrivées à venir), pas 1 234. C'est pourtant la forme utilisée
par `lib/channels/beds24.js:getReservations` — non, celle-ci borne à −3 mois/+6 mois —
mais bien par `api/beds24.js:198`.

### Statuts rencontrés

| Statut brut | Nombre | → canonique |
|---|---|---|
| `new` | 1 138 | confirmed |
| `confirmed` | 95 | confirmed |
| `cancelled` | 179 | cancelled |
| `black` | 1 | blocked |
| `request` | 0 | — |
| `inquiry` | 0 | — |

`subStatus` vaut `none` sur les 1 234. `cancelTime` n'est rempli que sur
**139 des 179** annulées (78 %) : la date d'annulation n'est pas fiable.

### Champs réellement servis

70 champs par réservation (**+ `invoiceItems` avec `includeInvoiceItems=true`**,
soit 71). Payload brut : **1 755 octets en moyenne, 2,37 Mo** pour les 1 413.

Remplis à 100 % : `id`, `propertyId`, `roomId`, `unitId`, `roomQty`, `arrival`,
`departure`, `numAdult`, `numChild`, `status`, `subStatus`, `statusCode`,
`referer`, `apiSource`, `apiSourceId`, `bookingTime`, `modifiedTime`, **`price`**,
**`commission`**, `tax`, `deposit`, `offerId`, `allow*`.

Partiellement remplis, sur 1 234 : `apiReference` 89 %, `lang` 93 %,
`rateDescription` 94 %, `country` 90 %, **`firstName` 30 %**, `lastName` 29 %,
`phone` 30 %, `email` 8 %, `city` 14 %, `comments` 8 %.

Jamais remplis : `arrivalTime`, les 10 `custom*`, `notes`, `message`, `title`,
`reference`, `voucher`, `flagColor`, `flagText`, `groupNote`, `masterId`,
`invoiceeId`, `state`, `fax`.

**Le nom du voyageur n'est présent que dans 30 % des cas** — les OTA anonymisent
après le séjour. Un historique construit aujourd'hui ne récupérera plus les noms
de 2022-2025.

### invoiceItems

- Présents sur **1 231 / 1 413** réservations, **1 402 lignes** au total (1,14 par résa).
- Types : `charge` 1 361, `payment` 41. Sous-types : `charge/8` = 1 099 (loyer),
  `charge/11` = 125, `charge/7` = 77, `charge/1` = 55, `payment/203` = 38.
- Champs par ligne : `id, bookingId, type, subType, description, status, qty,
  amount, lineTotal, vatRate, invoiceId, invoiceDate, invoiceeId, createdBy, createTime`.
- ⚠ **`somme(charges) ≠ price` dans 853 cas sur 1 234** (69 %). Les deux
  grandeurs ne disent pas la même chose. Un futur module revenus devra trancher
  laquelle fait foi — ce n'est pas un détail d'implémentation.
- CA cumulé (`price`) : 216 966 € ; commissions : 37 089 €.
- **`price` et `commission` sont servis SANS `includeInvoiceItems`.** Le surcoût
  du paramètre n'est que de 0,1 crédit par appel (1,6 contre 1,5).

### Crédits API

En-têtes servis : `x-five-min-limit-remaining`, `x-five-min-limit-resets-in`,
`x-request-cost`. Pas d'en-tête horaire ni journalier.

- Budget : **100 crédits par fenêtre de 5 minutes**, glissante.
- Coût constant : **1,6 crédit** par page de 100 avec `includeInvoiceItems`,
  **1,5** sans.
- **Un historique complet d'un bien = 13 pages ≈ 21 crédits ≈ 21 % du budget 5 min.**
  Plus 2 pages pour les annulées. Environ **24 crédits par bien**, en ~6 secondes.
- Le plancher observé pendant l'inventaire complet : 65,7 restants. Jamais bloqué.
- **4 biens rentrent dans une seule fenêtre de 5 minutes.** Un backfill est
  parfaitement tenable, même sans étalement.

---

## 2. Channex — Colomiers (`0544fd9a-6579-44e7-b75e-19c63a2019ba`)

### Profondeur : il n'y a pas d'historique

| Mesure | Valeur |
|---|---|
| Total réservations | **18** |
| `inserted_at` le plus ancien | **2026-07-17** |
| Arrivée la plus ancienne | 2026-07-22 |
| Arrivée la plus lointaine | 2026-09-05 |

**Channex ne détient rien avant la date de branchement du canal** (~7 semaines).
Contrairement à Beds24, il n'y a aucun passé à rapatrier : Channex n'est pas une
archive, c'est un tuyau. Ce qui n'a pas transité par lui n'existe pas chez lui.

C'est asymétrique et structurant : **les deux providers n'offrent pas la même
chose.** Beds24 = 4 ans, Channex = depuis la connexion. Un hôte qui migre de
Beds24 vers Channex perd son passé si HôteSmart ne l'a pas capturé avant.

### Statuts et volumes

`new` 15, `cancelled` 3. **Les annulations SONT incluses par défaut** — l'inverse
exact de Beds24. OTA : AirBNB 13, BookingCom 5. Pagination : `meta.total`,
`pagination[page]`, `pagination[limit]`.

### ⚠ Fait central n°2 — une annulée sans dates

La réservation `a3f88358-30e4-40e4-a564-d2485195b87a` (cancelled, BookingCom,
97,00 €) a `arrival_date = null`, `departure_date = null`, `rooms = []`,
`occupancy.adults = 0`. Channex conserve la coquille sans les dates.

Le mapper `fromChannex` la traduit en `arrival: null, departure: null`, et
`sejourTermine()` renvoie `false` sur une date de départ absente (« date inconnue :
on ne bloque pas »). **Une réservation sans dates franchit donc la garde
d'ancienneté** — vérifié en §4.

### Champs réellement servis

33 champs. Payload brut : **5 995 octets en moyenne** (3,4 fois Beds24), 105 Ko
pour 18 réservations. `raw_message` seul pèse ~2,7 Ko par réservation (c'est une
chaîne, pas un objet).

Riches et absents du snapshot : `amount`, `currency`, `ota_commission`,
`payment_collect`, `payment_type`, `notes` (Airbnb y met le détail du payout :
prix de base, frais de ménage, host fee), `rooms[]` avec
**`meta.days_breakdown` = le tarif jour par jour**, `services[]` (frais de ménage
en ligne séparée), `revision_id`, `inserted_at`, `unique_id`, `meta.listing_id`,
`meta.thread_id`.

Jamais remplis sur les 18 : `agent`, `arrival_hour`, `deposits`, `guarantee`,
`secondary_ota`.

### Crédits API

En-tête `ratelimit` : `"bookings";r=5999;t=60`, `r=359999;t=3600`,
`r=8639999;t=86400`. **6 000 par minute, 360 000 par heure, 8,64 M par jour.**
Sans commune mesure avec Beds24 — le coût d'un backfill Channex est nul.

---

## 3. Ce que `lib/bookings-snapshot.js` conserve réellement

**Un sous-ensemble strict de 14 champs, jamais le payload intégral.**

`EMPTY_SNAPSHOT` = `provider, status, statusRaw, arrival, departure, arrivalHour,
firstName, lastName, numAdult, numChild, source, otaReservationCode, amount, currency`.

Taille mesurée : **266 octets en moyenne** sur les 185 lignes réellement en base
(219 o pour du Beds24 mappé, 287 o pour du Channex).

### Ce qui est perdu au passage

**Beds24 — 37 champs servis et jetés**, dont : `price`, `commission`, `tax`,
`deposit`, `invoiceItems`, `bookingTime`, `modifiedTime`, `cancelTime`, `email`,
`phone`, `mobile`, `country`, `city`, `address`, `comments`, `roomId`, `unitId`,
`roomQty`, `rateDescription`, `apiSourceId`, `subStatus`, `statusCode`.

**Channex — 18 champs servis et jetés**, dont : `amount` est gardé mais
`ota_commission`, `rooms[]` (et son `days_breakdown`), `services[]`, `notes`,
`payment_collect`, `payment_type`, `revision_id`, `inserted_at`, `meta` sont perdus.

### ⚠ Fait central n°3 — le mapper Beds24 jette l'argent par erreur

```js
amount:   undefined,   // non fourni sur cet endpoint
currency: undefined
```

**Le commentaire est faux.** `price` (100 % rempli) et `commission` (100 %) sont
servis par cet endpoint, avec ou sans `includeInvoiceItems`. Résultat mesuré :
`amount` rempli sur **0 / 1 413** réservations Beds24 après mapping, contre
18 / 18 côté Channex. Le champ `amount` du cœur est structurellement vide pour
tout un provider — un module revenus, yield ou facturation lirait aujourd'hui
zéro pour les hôtes Beds24 sans qu'aucune erreur ne se déclenche.

### Ce que dit la base aujourd'hui

| Mesure | Valeur |
|---|---|
| Lignes totales dans `bookings_snapshot` | **185** |
| dont bien 209413 | 92 (le provider en a **1 413**) |
| dont bien 169567 | 75 |
| dont Colomiers (Channex) | 18 |
| Fenêtre d'arrivées couverte | 2026-03-20 → 2026-09-26 |
| Statuts | `confirmed` 182, `cancelled` 3 (les 3 Channex) |

**Zéro annulation Beds24 en base**, sur 167 lignes Beds24 — alors que le provider
en compte 179 pour le seul bien 209413.

### ⚠ Fait central n°4 — trois fantômes actifs en production

Croisement des 92 snapshots du bien 209413 avec la liste des annulées Beds24 :

| booking_id | statut en base | dates |
|---|---|---|
| 85268603 | **confirmed** | 2026-04-24 → 2026-04-25 |
| 88783811 | **confirmed** | 2026-07-08 → 2026-07-09 |
| **92209790** | **confirmed** | **2026-09-12 → 2026-09-13** |

La troisième est **à venir**. Elle est annulée chez Beds24 et confirmée chez nous.
Un ménage sera notifié, un code d'accès posé, un message envoyé — pour une
réservation qui n'existe plus. Ce n'est pas un défaut d'historique, c'est un bug
actif sur le présent, et il découle directement du fait central n°1.

(À l'inverse : 0 snapshot absent des deux fetchs provider. Pas de fantôme d'une
autre origine sur ce bien.)

### Bénéfice mesuré, chiffré, du chantier

Rattachement des avis voyageurs du bien 209413 (28 avis, `ota_reservation_id`
renseigné sur 24) :

| Source | Avis rattachables |
|---|---|
| Snapshot actuel (92 lignes) | **5 / 28** |
| Historique provider complet (1 413) | **24 / 28** |

**De 18 % à 86 %.** L'historique n'est pas une commodité : c'est ce qui rend le
chantier avis réellement exploitable — et la fiche prestataire avec lui, puisque
`spec-prestataires-menage.md` §6 fait dépendre l'extrait de propreté du
rattachement avis ↔ séjour ↔ ménage.

---

## 4. `lib/cleaning/sync-menages.js` face à un départ passé

### Vérifié par exécution réelle

Appel **direct** de `syncMenageEvent()` avec un événement `new` portant sur un
départ du 2024-08-08 et un prestataire affecté : **l'insert `menage_events` a été
tenté** (il n'a échoué que sur la validation UUID de mon `user_id` de test, pas
sur une règle métier).

**`sync-menages.js` ne contient aucun filtre de date.** Il ne lit ni `arrival` ni
`departure` pour décider ; il ne les recopie que dans `event_data`. Rien dans ce
fichier ne le protège d'un départ passé.

### La garde est ailleurs, et elle tient

Elle est dans `lib/booking-changes.js:45-68` — `sejourTermine()`, `JOURS_DE_GRACE = 7`.
Résultats exécutés (date de référence : 2026-09-05) :

| Cas | Événement produit |
|---|---|
| Départ il y a 2 ans, jamais vu | **aucun** |
| Départ il y a 30 jours, jamais vu | **aucun** |
| Départ il y a 8 jours (hors grâce) | **aucun** |
| Départ il y a 6 jours (dans la grâce) | `new` → ménage |
| Départ futur | `new` → ménage |
| **Annulation** d'un séjour passé | **aucun** |
| **Modification** d'un séjour passé | **aucun** |
| **Départ absent (`null`)** | **`new` → ménage** |

### Conclusion factuelle

**Oui, rien n'est généré pour un départ passé** — mais par la grâce d'un autre
module. La propriété est vraie du couple `detectChange` + `sync-menages`, pas de
`sync-menages` seul. Deux réserves :

1. **Une réservation sans date de départ franchit la garde.** Ce n'est pas
   théorique : Channex sert exactement ce cas (§2, annulée sans dates). Le
   commentaire du code l'assume (« date inconnue : on ne bloque pas »), mais un
   backfill d'historique multiplierait mécaniquement ces cas.
2. **Aucun test ne couvre cette propriété au niveau de `sync-menages`.** Les
   17 tests de `sync-menages` portent sur le cloisonnement et les types diffusés,
   jamais sur les dates. La garde est testée dans `tests/booking-changes.test.js`.
   Si quelqu'un appelait `syncMenageEvent` depuis un autre chemin que le
   dispatcher, la suite resterait verte. (1 417 tests au vert, sans modification.)

---

## 5. Avis sur le parti pris du §3 (historique dans `bookings_snapshot`, sans purge)

*Le §3 n'a pas pu être lu. Avis fondé sur le seul énoncé de la demande.*

### D'accord sur le fond, pour trois raisons mesurées

1. **Le volume est un non-sujet.** 1 413 réservations × 266 o ≈ **376 Ko par
   bien**. Cent biens = 38 Mo. Il n'y a rien à optimiser, et donc rien à purger.
   Une purge est un writer de plus, c'est-à-dire un risque de plus, pour une
   économie nulle.
2. **C'est le cœur de données appliqué à la lettre** (CLAUDE.md § « le cœur de
   données d'abord »). Un writer unique, un schéma commun, les apps qui lisent la
   même vérité. Une table `bookings_history` séparée recréerait exactement la
   situation que l'unification a fermée : deux tables, deux schémas, la question
   « laquelle fait foi » à chaque lecture.
3. **La fenêtre de fetch et le contenu de la table sont deux choses
   distinctes**, et le code le sait déjà : le merge non destructif préserve les
   lignes qu'un fetch ne rapporte pas. Élargir la fenêtre au backfill sans
   toucher au cron nominal ne demande aucune modification du writer.

### Trois réserves, à trancher avant l'étape 1

**a) « Sans purge » ne veut pas dire « sans réconciliation ».** Les 3 fantômes du
§3 le prouvent : sans purge, le snapshot devient la mémoire des **erreurs**
autant que des faits. Il faut un chemin qui corrige un statut, sinon
« pas de purge » se traduit par « pas de correction ». Ma proposition : ajouter
`status=cancelled` au fetch nominal Beds24 — les annulées reviennent alors comme
une donnée, `detectChange` produit un `cancelled`, et le problème se règle par
le chemin normal du cœur, sans purge et sans writer supplémentaire. Coût :
+1,5 crédit par bien et par cycle.

**b) Le passé ne doit pas réveiller le présent.** La garde de 7 jours suffit
pour un séjour daté, mais pas pour un séjour sans dates (§4). Un backfill de
1 413 lignes par bien passe par `saveBookingSnapshots`, donc par `detectChange` :
il faut le drapeau `initialImport` déjà présent dans le writer, **et** une garde
explicite sur `departure === null` avant de généraliser. Sinon on rejoue le
scénario que le commentaire de `booking-changes.js` décrit : une avalanche
d'événements sur du passé.

**c) `amount` vide pour tout Beds24 est le vrai piège du chantier.** Constituer
un historique de 1 413 réservations dont le montant est `null` sur 100 % des
lignes Beds24, c'est fabriquer une base inexploitable pour le yield et la
facturation — et le découvrir six mois plus tard. `price` et `commission` sont
servis gratuitement. **Je recommande de corriger `fromBeds24` AVANT le backfill,
pas après** : un backfill se rejoue, mais il coûte 24 crédits par bien et le
faire deux fois est évitable.

### Deux questions que la spec devra trancher

- **Le montant : `price` ou la somme des `invoiceItems` ?** Les deux divergent
  sur 69 % des réservations. Choisir tard, c'est choisir deux fois.
- **Faut-il conserver le payload provider brut ?** 2,37 Mo par bien côté Beds24,
  contre 376 Ko pour le snapshot mappé — soit ×6, et ×22 côté Channex
  (5 995 o contre 287 o). Je penche pour **non** : le schéma commun est
  précisément ce que l'unification a acquis, et un `raw` par provider réintroduit
  deux vocabulaires dans la même table. Mais si des champs manquent (`price`,
  `commission`, `bookingTime`, `cancelTime`, `days_breakdown`), la réponse est de
  **les ajouter au schéma commun**, pas de stocker le brut à côté.

---

## Récapitulatif des 4 constats à corriger

| # | Constat | Portée |
|---|---|---|
| 1 | `GET /bookings` Beds24 exclut les annulations sans le dire | **Bug actif**, pas seulement historique |
| 2 | 3 réservations annulées restent `confirmed` en base, dont 1 à venir | **Production, aujourd'hui** |
| 3 | `fromBeds24` laisse `amount` vide alors que `price` est servi | Bloquant pour le backfill |
| 4 | `fetchBookingsHistory` (`lib/cron-beds24.js:62`) ne pagine pas — tronqué à 100 | Latent, silencieux |
