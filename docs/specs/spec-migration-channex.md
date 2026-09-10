# Spec — Migration Channex des deux biens de Bagnères

> v1 du 8 septembre 2026. Objectif gravé : brancher la réservation directe de
> `coeurdevie65.com` sur les deux biens (phase 4).
> Fichier de référence : `docs/specs/spec-migration-channex.md`.

## 1. Principes (ne pas rediscuter)

- **Rapatrier n'oblige pas à migrer** (`docs/kb/coeur-de-donnees.md`). Ces deux
  biens migrent parce que la vente directe demande l'écriture CRS, pas parce que
  Beds24 les retiendrait.
- **Migration AVEC carnet.** Attendre un calendrier vide est une cible mouvante :
  les dates s'ouvrent au fur et à mesure. Les séjours en cours doivent traverser
  la bascule — ménages, codes, messages sans interruption. C'est le cœur du plan.
- **Un bien à la fois.** Le second ne démarre que si le premier est vérifié.
- **Jamais un instant où un calendrier n'est piloté par personne.**
- **Aucune exécution sans feu vert de Thierry.** Biens en exploitation.

## 2. Faits établis (mesurés le 8 septembre 2026)

**Correspondance `hotel_id` ↔ bien** (donnée par Thierry le 8 septembre 2026) :

| `hotel_id` Booking | bien | `provider_property_id` Beds24 |
|---|---|---|
| **8985969** | coeur de vie 23 | `169567` |
| **10853342** | Cœur de vie « La bulle » | `209413` |

Une inversion mapperait le calendrier d'un bien sur l'annonce de l'autre : cette
table est à relire **à voix haute** avant chaque `create channel`. Corroboration
faible mais rassurante : le plus petit `hotel_id` va au bien le plus ancien
(réservations depuis 2022 contre 2023).

**Périmètres Booking.com**, identiques sur les deux établissements :

| périmètre | détenteur | type |
|---|---|---|
| Rates and availability | Beds24 | **exclusif** |
| Reservations | Beds24 | **exclusif** |
| Content | Beds24 | **exclusif** |
| Photos | Beds24 | **exclusif** |
| Guest messages | Beds24 | **exclusif** |
| Guest reviews | Beds24 | partageable |
| Reporting | Beds24 | partageable |
| Performance data | *aucun* | — |

**Réconciliation des réservations.** Chaque réservation OTA porte un
`otaReservationCode` **stable et identique des deux côtés** : numéro Booking
(`5385348982`) ou code Airbnb (`HMEA8PYCPM`). C'est la clé qui empêchera les
doublons quand `load_future_reservations` réimportera le carnet.

**L'exception qui doit être traitée à la main** : la réservation directe
`78671952` (La bulle, 24→27 septembre) n'a **aucun** code OTA. Elle ne viendra ni
de Booking ni d'Airbnb : elle devra être **recréée dans Channex** par le
formulaire de réservation manuelle.

**Volumétrie du re-keying** — 4 274 lignes portent `property_id` = `169567` ou
`209413`, réparties sur 14 tables :

| table | lignes | table | lignes |
|---|---|---|---|
| bookings_snapshot | 1 420 | menage_events | 192 |
| conversations | 837 | menages | 176 |
| messages | 783 | menage_done | 125 |
| agent_tasks | 315 | access_codes | 117 |
| sms_logs | 231 | knowledge | 44 |
| booking_change_events | 15 | message_templates | 9 |
| menage_comments | 5 | property_cleaning_providers | 3 |
| property_status | 2 | | |

`ota_reviews` est clée en **UUID** : elle n'est pas concernée.
`calendar_inventory` non plus (UUID, et vide pour ces deux biens).

## 3. Le chemin de connexion

**Thierry n'a pas à trouver de bouton dans l'extranet aujourd'hui.** Le parcours
est initié par le fournisseur entrant : Channex crée le canal avec le `hotel_id`
(`POST /api/v1/channels/` avec `is_active: false`), Booking fait alors apparaître
la demande dans l'extranet, et c'est **à ce moment** que Thierry approuve et
choisit les périmètres accordés.

> ⚠ Hypothèse forte, non vérifiée : la doc Channex dit seulement « if user
> provide correct details and property ready for connection at OTA side ». Le
> détail de l'écran d'approbation est côté Booking. On le constatera à la
> première demande — sur le bien le moins chargé, et sur les périmètres
> partageables (§4, phase 1), donc sans risque.

**Le canal se crée INACTIF chez les deux OTA.** C'est ce qui rend la bascule sans
trou possible : on mappe pendant qu'il dort, on vérifie, on active ensuite.

## 4. Ordre des bascules par périmètre

### Phase 0 — préparation (aucun impact sur l'exploitation)

1. Créer la propriété Channex du bien (`POST /properties`, room_type, rate_plan)
   depuis la fiche unifiée (étape 2).
2. Poser le calendrier et les tarifs dans Channex, **sans aucun canal actif**.
3. Airbnb : générer le lien OAuth, connecter le compte, lister les listings,
   mapper — le canal reste inactif.
4. Booking : créer le canal `is_active: false` **et sans mapping**, attendre
   l'approbation dans l'extranet, puis `mapping_details` pour récupérer les
   `room_type_code` / `rate_plan_code` **depuis l'OTA** (rien à relever à la
   main), et poser le mapping.

   ⚠ **L'ordre a été corrigé le 9 septembre 2026, par la mesure.** Cette liste
   disait « `test_connection` puis `mapping_details` … créer le canal, mapper ».
   Or sur les deux hôtels de Bagnères, `test_connection` rend `success: false` et
   `mapping_details` **HTTP 422** tant que la connexion n'est pas approuvée — ce
   que le §3 annonçait déjà sans en tirer la conséquence : c'est la **création du
   canal** qui fait apparaître la demande. Les codes n'existent donc pas avant
   l'approbation, et le mapping est un geste d'après
   (`POST /api/channel-bcom-write?action=map`).
5. Préparer et **répéter à blanc** le script de re-keying (§5).

**Rien n'est basculé. On peut s'arrêter ici sans conséquence.**

### Phase 1 — les partageables, en répétition générale

**Guest reviews** et **Reporting** vont à Channex **sans retirer Beds24** : le
type « plusieurs fournisseurs » l'autorise. Aucune perte possible, et on apprend
l'écran d'approbation Booking sur un périmètre inoffensif.

*Critère de passage* : Channex apparaît bien comme co-détenteur, et Beds24
continue de fonctionner.

### Phase 2 — Reservations + Rates and availability, ENSEMBLE

**Les deux au même moment, jamais l'un sans l'autre.** Un fournisseur qui pousse
les disponibilités sans recevoir les réservations produit de la surréservation —
et Channex accepte la surréservation (stock à −1), c'est un fait mesuré de ce
dépôt.

Séquence, dans l'ordre, sur **un seul bien** :

1. `automation_paused = true` sur le bien (kill switch existant) — le voyageur
   ne reçoit plus rien, le ménage n'est pas notifié, pendant la fenêtre.
2. Dernier cycle Beds24 complet : snapshots et messages à jour.
3. Approuver le transfert des deux périmètres à Channex dans l'extranet.
4. `POST /channels/{id}/activate` côté Channex (Booking, puis Airbnb).
5. `action/load_future_reservations` sur chaque canal → le carnet remonte dans
   Channex.
6. **Re-keying** (§5), pendant que l'automatisation est encore en pause.
7. Vérifications §6.
8. `automation_paused = false`.

**Durée visée : moins de 30 minutes.** Au-delà, on tient le rollback prêt (§7).

### Phase 3 — Guest messages

En dernier, seul, et seulement quand la phase 2 est stable depuis **au moins
24 h**. Détail en §6.

### Content et Photos — NON transférés, et c'est un choix

**Recommandation ferme : les laisser retomber sans fournisseur**, donc en gestion
manuelle dans l'extranet Booking.

Deux raisons. D'abord, **on n'a pas le contenu** : Beds24 n'expose ni
descriptions ni photos par son API — vérifié, `includeTexts`/`includePictures`
sont acceptés et ne rendent rien, les 8 `templates` sont vides sur les deux
biens. Ensuite, **un fournisseur de contenu sans contenu peut écraser
l'annonce** : donner Content à Channex, c'est l'autoriser à pousser ce qu'il a —
c'est-à-dire rien.

Ce qu'on perd : la capacité de modifier le contenu par API. Ce qu'on garde :
l'annonce telle qu'elle est aujourd'hui, et la main sur elle dans l'extranet.

## 5. Le re-keying — le vrai morceau

À la migration, `properties.provider_property_id` passe de `"209413"` à l'UUID
Channex. Les 14 tables enfants clées en TEXT doivent suivre, **en une fois**.

- Script **idempotent**, avec **répétition à blanc obligatoire** (comptes
  avant/après, table par table) avant toute écriture.
- Exécuté **pendant `automation_paused`**, entre la bascule et la reprise.
- **Sauvegarde préalable** des 14 tables filtrées sur le bien, dans un fichier
  daté, hors dépôt.
- Le `provider` de `properties` passe à `channex` **dans la même opération** :
  un bien dont le provider dit Channex et dont les tables enfants disent encore
  Beds24 est un bien à moitié migré, et c'est l'état le plus dangereux.
- **~~Déduplication du carnet~~ — REMPLACÉE par une règle de Thierry, le
  10 septembre 2026.** L'ancienne approche : rapprocher par `otaReservationCode`
  les séjours que l'OTA rend avec de *nouveaux* identifiants. La règle qui la
  remplace :

  > « Quand on démappe une propriété d'un OTA, les réservations à venir et en
  > cours ne comptent plus. Seules les passées sont conservées. Comme ça, au
  > remapping, pas de problème. »

  **Si le futur ne compte plus sous l'ancien identifiant, il n'y a plus rien à
  rapprocher** — et le rapprochement est précisément ce qui se trompe. Plus de
  ménage en double, plus de message envoyé deux fois, plus de code posé deux
  fois, sans écrire une ligne de dédoublonnage.

  **On neutralise, on ne supprime pas** (deuxième précision de Thierry, meilleure
  que ma première version qui détruisait les lignes) : un séjour neutralisé
  n'occupe aucune nuit, fait annuler son ménage **tout seul** par le chemin
  normal du produit — `sync-menages-entite` construit ses séjours « vivants »
  avec `isActiveStatus` — et laisse la trace.

  **Et le statut est `demapped`, pas `cancelled`** (troisième précision, et elle
  évite un dégât définitif) : les annulations alimentent les **statistiques**.
  Ranger sous le même mot « le voyageur s'est décommandé » et « nous avons
  débranché ce logement d'un OTA » aurait faussé ces chiffres pour toujours, sans
  aucun moyen de les séparer après coup. `estAnnulationVoyageur`
  (`lib/bookings-snapshot-status.js`) porte la distinction.

  **Quand le faire : APRÈS le re-keying, jamais avant.** Tant que le bien est
  encore `provider = 'beds24'`, le cron de synchronisation réécrit ses snapshots
  et remettrait « confirmé » au cycle suivant, en silence. La pause de
  l'automatisation ne suffit pas — `isAutomationPaused` ne couvre pas les writers
  de synchro.

  **Seuls les séjours d'un OTA sont neutralisés, et le critère est la SOURCE —
  pas le code.** Première version : « il a un `otaReservationCode`, donc il
  reviendra ». Faux, et mesuré : les réservations créées par HôteSmart en portent
  un aussi (`HS-…`, `HSM-…`, rendues par Channex en `ota_name: "Offline"`). Elles
  auraient été neutralisées — nuits remises en vente, ménage annulé, voyageur
  oublié — contre la règle qu'on venait de graver. Répartition réelle des
  1 431 snapshots : airbnb 927, booking 311, **direct 199**, **Offline 3**,
  **iCal 4**.

  La liste des OTA est **fermée**, et le doute profite à la conservation : ne pas
  neutraliser un séjour d'OTA produit un doublon — grave, mais visible et
  réparable ; neutraliser une réservation vivante remet ses nuits en vente et
  annule son ménage — pire, et silencieux. Une source non classée est donc
  **conservée et signalée**, pour qu'un humain tranche au lieu d'un défaut.

  **Un code déjà posé ne bloque pas** — arbitrage de Thierry : « il l'a déjà, et
  impossible de le supprimer, donc pas d'impact ». Un code supplémentaire
  n'empêche pas d'entrer, et le suivi se fait à la main pendant la fenêtre.
  L'aperçu le **nomme** quand même, date par date : ne pas bloquer n'est pas la
  même chose que ne pas dire.

  **Seuls les `confirmed` sont neutralisés**, et l'oubli de `blocked` coûtait
  cher : `lib/nuits-occupees.js` compte `confirmed` **et** `blocked`. Un blocage
  propriétaire passé en `demapped` cessait d'occuper, et la poussée ARI **remettait
  en vente les nuits que l'hôte s'était réservées**. Un blocage n'est pas une
  réservation d'OTA : il n'est pas réimporté, donc il ne peut pas faire doublon.

  **Un départ du jour est exclu** : avec `>=`, `sync-menages-entite` annulait au
  passage suivant le ménage de ce départ — déjà attribué, peut-être en cours.

  **L'ordre est vérifié, pas supposé** : l'étape refuse d'agir tant que le bien
  est encore chez son ancien provider. Le cron */5 réécrirait le snapshot en
  `confirmed`, et `detectChange` lirait `demapped → confirmed` comme un séjour
  **neuf** — ménage recréé et re-notifié, message d'arrivée et code rejoués.
  L'aperçu, lui, reste possible : montrer n'est pas agir.

  **Et l'étape est `sans_objet` hors migration.** Sans ce repli, tout bien du
  compte — y compris un bien Channex vif — ressortait « à faire » avec l'action
  exposée : un clic mettait son carnet futur entier en `demapped`.

  **Les vues masquent `demapped` comme `cancelled`** (`biens-calendrier`,
  `calendrier-mobile`, `messagerie`) : le cœur considère ces nuits libres et les
  pousse en vente ; les afficher comme occupées aurait fait lire à l'hôte une
  réservation sur une nuit disponible.

  ⚠ **RESTE OUVERT — les messages déjà envoyés.** L'anti-doublon des messages est
  `(user_id, booking_id, template_id)` : au remapping, les nouveaux identifiants
  ne sont pas dans le journal, et **13 messages déjà reçus repartiraient** aux
  voyageurs des 11 séjours à venir (mesure du 10 septembre). La neutralisation ne
  couvre pas ce cas — elle empêche le ménage en double, pas le message. Correctif
  prévu : une **empreinte de séjour** stable (`logement | arrivée | départ`) dans
  `message_sent_log`, vérifiée en plus de l'identifiant. C'est le dernier verrou
  avant la bascule.

## 6. Vérifications post-bascule, par périmètre

**Rates and availability**
- Le calendrier Channex du bien est identique au calendrier Booking : mêmes
  nuits fermées, mêmes prix, sur 90 jours.
- Une nuit fermée dans HôteSmart devient indisponible sur Booking en moins de
  15 min (test réel sur une nuit lointaine, puis remise en état).
- Aucune nuit occupée par un séjour en carnet n'est vendable.

**Reservations**
- Les 10 séjours à venir existent **une seule fois** dans `bookings_snapshot`,
  avec le bon `otaReservationCode`.
- Aucun ménage en double sur la période (`menages` par `departure_date`).
- Une réservation test faite sur Booking arrive dans le cœur en moins de 15 min.
- `booking_change_events` : aucun événement non traité qui daterait de la bascule.

**Guest messages** *(phase 3, la fenêtre de risque)*

Le risque : un message envoyé par un voyageur pendant le transfert peut n'être
livré à personne — Booking cesse de le donner à Beds24 avant que Channex ne le
reçoive. GuestFlow ne le verrait jamais, et personne ne saurait qu'il a existé.

Mitigations, toutes obligatoires :
- Bascule **de nuit**, hors heures de messages.
- Juste avant : dernier `fetchMessages` Beds24 complet, et **noter l'horodatage
  du dernier message reçu** — c'est la borne qui permettra de détecter un trou.
- Juste après : envoyer un **message test depuis l'application Booking** et
  vérifier qu'il arrive dans `messages` via le chemin Channex en moins de 15 min
  (chemin déjà éprouvé : Colomiers porte 102 messages Channex).
- Sous 24 h : comparer le fil Booking (extranet) et la table `messages` sur la
  fenêtre de bascule. **Tout message présent chez Booking et absent du cœur est
  un rollback immédiat.**
- **Ne pas déconnecter le compte Beds24** : il reste la seule lecture possible de
  l'historique des messages, dette ouverte (`docs/kb/bookings-snapshot.md`).

**Guest reviews / Reporting**
- Les avis continuent d'arriver (`ota_reviews`), aucun doublon.

## 7. Rollback

**Critères — un seul suffit, et il n'y a pas à en débattre sur le moment :**

1. Une **surréservation** apparaît, ou une nuit occupée redevient vendable.
2. Une réservation Booking/Airbnb **n'arrive pas** dans le cœur sous 30 min.
3. Un message voyageur présent chez l'OTA est **absent** du cœur.
4. Un ménage, un code d'accès ou un message part **en double**.
5. Le re-keying laisse une table **incohérente** (comptes avant/après divergents).
6. La fenêtre dépasse **1 heure** sans que la phase 2 soit vérifiée.

**Procédure :**

1. `automation_paused = true` immédiatement (avant tout diagnostic).
2. Désactiver les canaux Channex : `is_active: false` — ils cessent de pousser.
3. Réattribuer les périmètres à Beds24 dans l'extranet Booking.
4. Rejouer le re-keying **en sens inverse** (le script est symétrique et
   idempotent ; la sauvegarde de §5 est le filet si la symétrie échoue).
5. Vérifier avec le jeu de contrôles du §6, dans l'autre sens.
6. `automation_paused = false`.
7. Écrire ce qui s'est passé au KB **avant** de retenter quoi que ce soit.

**Le rollback n'est pas gratuit** : les réservations arrivées chez Channex
pendant la fenêtre devront être réconciliées à la main. C'est la raison pour
laquelle la fenêtre est courte et la phase 2 tenue sur un seul bien.

## 8. Ce qui reste à décider ou à établir

1. L'écran d'approbation Booking : constaté en phase 1, pas avant.
2. Le sort des **messages historiques** (dette ouverte) — à trancher **avant**
   toute déconnexion du compte Beds24, jamais après.
3. L'ordre des deux biens : le moins chargé d'abord. À arrêter au vu du carnet
   le jour J.
