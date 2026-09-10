# Checklist — transfert de « coeur de vie 23 »

> Écrite le 10 septembre 2026 au soir, à la demande de Thierry, **après** le
> transfert réussi de La bulle. Décision : **pas ce soir, à tête reposée.**
>
> Le plan de référence général est `docs/specs/plan-bascule-jour-j.md` — dont
> l'en-tête dit ce qui l'a dépassé. Cette checklist-ci est l'ordre exact pour
> le second bien, avec les identifiants réels.

## Les identifiants

| | |
|---|---|
| Fiche source (Beds24) | `49b2d1f6-b8df-43ba-b636-fa4f73713c4b` — clé `169567` |
| Fiche cible (Channex) | `efe1daf1-652c-4177-b29b-19f1db377c96` — clé `1655ab32-d339-413d-b8ff-b4ccbd2a7b66` |
| Booking | `hotel_id 8985969` · canal `2b0f16df-…` **actif**, mappé sur le dérivé |
| Airbnb | **aucun canal** — Thierry a déconnecté le précédent (`a42a7f18-…`) le 10/09 au soir, **délibérément, pour un test**. Déconnexion propre : le canal est en 404, le lien `airbnb/derived` en base est intact. |
| Tarif dérivé airbnb en base | `97462698-…`, lien `airbnb/derived` intact |

## État vérifié au 10 septembre, 21 h

- Les **neuf refus** de `transferer_bien` sont levés, sauf `automation_paused`
  (étape 1 ci-dessous, posée par le script).
- Calendriers **fusionnés** : 875 dates sur la cible, 0 sur la source, **0
  collision**. 35 dates tarifées, **0 date non fermée**.
- Chez Channex : **0 date ouverte à la vente**, 500/500 avec
  `availability = 0` **et** `stop_sell = true`.
- À déplacer : 1 848 lignes par clé provider, 72 par UUID de fiche, 3 à purger.

## ⚠ A1 — GESTE DE THIERRY, OBLIGATOIRE AVANT TOUT MAPPING AIRBNB DU 23

`guests_included = 6` dans Airbnb, sur l'annonce du 23
(`697908942876699669`).

**Pourquoi c'est le seul point qui peut coûter de l'argent au voyageur :**
Airbnb porte **nativement** `guests_included` et `price_per_extra_person`. Si
`guests_included` reste à 4 alors que le bien accueille 6, Airbnb facture son
propre supplément **en plus** du prix que nous poussons — double comptage, à la
charge du voyageur.

⚠ **Impossible à vérifier tant qu'il n'y a pas de mapping** : la valeur ne se
lit que dans `channel.rate_plans[].settings.pricing_setting`. Donc A1 **précède**
le mapping, il ne se contrôle pas après.

Le mapping Airbnb du 23 n'est **pas** un prérequis du transfert : les deux sont
indépendants.

## L'ordre

### 1. Couper l'automatisation sur la source

```
node scripts/transferer-bien-vers-fiche-neuve.js coeur-23            # essai à blanc
node scripts/transferer-bien-vers-fiche-neuve.js coeur-23 --ecrire
```

Le script pose `automation_paused = true` lui-même, **et le rend** si le
transfert est refusé — une source en pause sans transfert couperait les
messages et les codes du voyageur pour rien.

⚠ La pause ne coupe **que** le voyageur, jamais la synchro provider (choix
assumé du kill switch). Ce n'est donc pas elle qui protège du rapatriement :
c'est l'étape 2.

### 2. Le transfert, dans la même transaction

Le même appel enchaîne, sans intervention :

- sauvegarde intégrale dans `rekeying_backup` ;
- déplacement par **clé provider** (17 tables + 3 références nommées autrement
  + `public_tokens.property_ids`) ;
- déplacement par **UUID de fiche** (`calendar_inventory`, `booking_links`,
  `booking_attempts`, `ota_reviews`, `airbnb_connect_sessions`) ;
- **purge** de `property_channel_rate_plans` côté source — la fiche neuve a
  déjà ses trois liens, et l'index unique refuserait le doublon ;
- `profile_permissions.property_ids` — sinon le périmètre de la prestataire
  cesse silencieusement de couvrir le logement ;
- retrait de la fiche source (`active_at` effacé : sans quoi la facturation
  compterait deux biens) ;
- **`noterCleMigree`** : `169567` entre dans `provider_keys_migrated`. C'est la
  moitié du geste — sans elle, le cron rematérialise la fiche, resynchronise
  sous l'ancienne clé et **fait repartir des messages** ;
- **re-keying des clés JSON** : `agent_alert_config.config['169567']` →
  `['1655ab32-…']`. Sans ça, `getPropertyMode` retombe sur `'test'` et l'agent
  IA du bien devient **muet**, sans un log. C'est arrivé sur La bulle.

**État vérifiable** : `transfert_compter` rend 0 côté source ; `rekeying_backup`
porte ses entrées.

### 3. Balayer, puis vérifier sur deux cycles de cron

```
node scripts/finir-transfert-supprimer-ancienne.js coeur-23 --sans-suppression --ecrire
node scripts/observer-cycles-cron.js 13
```

⚠ `--sans-suppression` : le bien **reste** dans le compte Beds24 (règle N2 — les
messages historiques doivent être tranchés avant toute déconnexion, et Beds24
est le filet de rollback tant qu'aucune réservation réelle n'a traversé la
chaîne Channex de bout en bout). Supprimer la fiche est de toute façon inutile :
le cron la recrée.

⚠ **Adapter `observer-cycles-cron.js`** : ses constantes sont celles de La
bulle. Verdict attendu : « Aucun rapatriement », fiche non recréée, cible
inchangée.

### 4. Dédoublonner les 2 réservations Airbnb

Le canal Airbnb du 23 a été actif ~5 h le 10 septembre — de son OAuth à la
déconnexion de test — et Channex a livré pendant ce temps deux séjours qui
existaient déjà sous la clé Beds24.

| Code OTA | Séjour | `booking_id` Beds24 | `booking_id` Channex |
|---|---|---|---|
| `HMADA4CMQR` | 12→13/09 | `88054797` | `38b66b25-…` |
| `HMEA8PYCPM` | 16→20/09 | `83137395` | `99af35d0-…` |

`bookings_snapshot` est clé `(user_id, booking_id)` : aucun UPDATE n'échoue, les
deux versions vivront donc sous la clé cible.

**Ce qui tranche** : la règle du démappage — les séjours OTA à venir de
l'ancienne clé passent en `demapped`, les Channex sont la vérité vivante.
`otaReservationCode` est le seul identifiant qui traverse le changement de
channel manager : c'est lui qui apparie les deux versions.

⚠ **Pourquoi ça ne peut pas se faire avant** : les 2 ménages en doublon,
supprimés à 19:1x, ont été **recréés à 19:40:34** par le cron, tant que les deux
séjours étaient actifs des deux côtés. Les traiter avant le transfert est donc
inutile — ils reviennent.

⚠ **Et pourquoi ça compte au-delà des séjours** :
`lib/cleaning/sync-menages-entite.js` n'a **aucune** déduplication par empreinte
de séjour. Deux `booking_id` pour un départ = **deux ménages**. C'est la classe
des « 11 ménages fantômes ».

**État vérifiable** : un seul séjour actif par code OTA ; **un seul ménage par
date de départ** (13 et 20 septembre).

### 5. Vérifier 0 date ouverte chez Channex

Le contrôle qui clôt le transfert, sur les 500 jours : chaque date doit porter
`availability = 0` **et** `stop_sell = true`. C'est l'état de La bulle après son
transfert, et l'invariant à tenir jusqu'à la réouverture.

⚠ Le transfert déplace `calendar_inventory` mais **ne pousse rien** :
`rate_sync_mode` reste `keep`. Si l'état chez Channex avait bougé, il faudrait
repousser (`scripts/pousser-grille-reelle.js coeur-23`) et **relire** —
`GET /restrictions` est le seul juge, un `POST` à 200 ne dit que « tâche
acceptée ».

## Après, et seulement après

- Mapping Airbnb du 23 — **A1 d'abord**.
- Mapping Airbnb de La bulle (annonce `992723390568420450`, en réutilisant la
  connexion du compte de Thierry — pas celle d'Éric, voir la mémoire projet).
- **La réouverture à la vente : la toute dernière étape**, décision de Thierry
  du 10 septembre au soir.
