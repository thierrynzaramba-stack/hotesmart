# Plan de bascule — jour J, minute par minute

> Écrit le 9 septembre 2026. Complète `docs/specs/spec-migration-channex.md`
> (le *quoi*) et `docs/specs/spec-assistant-migration.md` (le *par quoi*).
> **Format checklist : chaque item porte son état vérifiable.**
>
> L'accélération supprime l'attente entre les étapes, **jamais une vérification.**

## Les faits établis

| | |
|---|---|
| coeur de vie 23 | Beds24 `169567` · Booking `hotel_id` **8985969** · capacité 6 · 4 inclus + 10 €/supp · 22 nuits tarifées (9→30 sept) |
| Cœur de vie « La bulle » | Beds24 `209413` · Booking `hotel_id` **10853342** · capacité 2 · pas de supplément · 17 nuits tarifées (9→25 sept) |
| Périmètres Booking | 5 exclusifs chez Beds24 (Rates and availability, Reservations, Content, Photos, Guest messages) + 2 partageables (Guest reviews, Reporting) |
| Réconciliation | `otaReservationCode` — identique des deux côtés |
| À recréer à la main | la réservation directe `78671952` (La bulle, 24→27 sept) : aucun code OTA |

**Ordre des biens : La bulle d'abord.** Moins de nuits tarifées, pas de grille
d'occupation (`per_room`, un seul tarif), carnet plus léger. Si quelque chose
casse, ça casse sur le bien le plus simple.

---

## AVANT LE JOUR J

- [ ] **A1. Airbnb — neutraliser le supplément natif.** ⚠ *Le seul point qui peut
  coûter de l'argent au voyageur.* Airbnb porte nativement `guests_included` et
  `price_per_extra_person` (5 à 300 USD, vérifié dans le schéma Channex
  `Airbnb.ListingSettings.PricingSettings`). Pour **coeur de vie 23**, Channex
  poussera une grille `per_person` (1p→4p à 120 €, 5p à 130 €, 6p à 140 € sur une
  nuit à 120 €) : si Airbnb applique en plus son supplément natif, **le groupe de
  6 paie deux fois**.
  **Consigne validée par Thierry** : dans Airbnb → Tarification → Voyageurs
  supplémentaires, mettre **`guests_included` = 6** (la capacité). Aucun voyageur n'est alors
  « supplémentaire » pour Airbnb, et la grille Channex reste seule source.
  *Ne pas mettre le prix à 0 : Airbnb refuse en dessous de 5 USD.*
  Pour **La bulle**, rien à faire : `per_room`, un seul tarif, aucun double
  comptage possible.
  **État vérifiable** : capture de l'écran Airbnb montrant `guests_included` = capacité.

- [x] **A2. La réouverture par le prix fonctionne — SANS correctif.**
  Vérifié en base le 9 septembre : les 39 dates amorcées portent
  `stop_sell = false` (défaut de la colonne), et non `NULL`. Or `api/calendar.js`
  appelle déjà `reaffirmerStopSell` après chaque poussée, qui restitue
  `stop_sell: false` pour toute ligne dont la mémoire n'est pas `NULL`.
  **Le correctif que j'avais écrit était redondant** — et il violait la règle
  « `NULL` n'est pas `false` » (`lib/channel-availability.js`), qui interdit
  d'inventer une intention. Retiré après review.
  **Reste vrai pour les dates à mémoire `NULL`** (44 sur Colomiers, aucune sur
  les deux biens à migrer) : elles resteraient fermées. Hors périmètre du jour J.
  **État vérifiable** : `select stop_sell, count(*) from calendar_inventory where rate is not null` → aucun `NULL` sur les deux biens.

- [x] **A3. Les deux biens sont « prêts » sur les étapes de l'assistant.**
  **État vérifiable** : `GET /api/migration` → **`7/7` sur La bulle** et
  **`6/7` sur coeur de vie 23** (9 septembre 2026) — la 7e étape, `poussee_ari`,
  est bloquée sur ce bien par le mode `keep` : voir 0.3. Les six premières sont
  « fait » sur les deux.

- [ ] **A4. Accès administrateur confirmés** sur les extranets Booking et Airbnb.

---

## JOUR J — BIEN 1 : « La bulle » (`209413` / `10853342`)

### Phase 0 — préparation (aucun impact, réversible sans trace)

- [x] **0.1 Créer la propriété Channex** depuis la fiche unifiée. **FAIT** sur
  les deux biens (8c604b8). L'identifiant cible va dans
  `migration_target_property_id`, pas dans `provider_property_id` : celui-ci est
  la clé de 4 274 lignes d'historique, et seul le re-keying (2.8) le promeut.
  **Vérifiable** : `migration_target_property_id` renseigné sur `properties`, et
  `GET /properties/<id>` chez Channex rend le bon titre, la bonne devise, le bon
  fuseau et le bon `property_type`.
- [x] **0.2 Créer room_type et rate_plan.** **FAIT** sur les deux biens :
  `count_of_rooms: 1`, `occ_adults: 2` (La bulle, `per_room`) et `occ_adults: 6`
  (coeur de vie 23, `per_person`, 6 options).
  **Vérifiable** : `provider_room_type_id` et `provider_rate_plan_id` renseignés.
- [x] **0.3 Pousser l'ARI — FAIT ET VÉRIFIÉ sur La bulle (9 septembre 2026).**
  Les 17 nuits tarifées portent leur prix chez la cible (09-09 → 09-25), les 97
  autres de la fenêtre lue sont en `stop_sell` — fermeture calculée, aucune
  intention écrite dans le cœur. C'est la gestion voulue.
  **Vérifié** par lecture de la cible : `GET /restrictions` sur la propriété
  Channex, 114 dates lues, 17 avec prix, 97 fermées. L'étape `poussee_ari` de
  l'assistant rend « fait » sur cette même lecture.

  ⚠ **« coeur de vie 23 » n'est PAS dans cet état** : sa cible a reçu une poussée
  qui a tout fermé — 114 dates lues, **0 avec prix** — alors que le cœur détient
  22 nuits tarifées (109 €, 110 €…). Le bien est en `rate_sync_mode = 'keep'` :
  toute re-poussée tarifaire est refusée tant que l'hôte n'a pas choisi
  « HôteSmart gère mes prix ». **C'est un bloquant du bien 2, pas du bien 1.**

  ⚠ **Fait manquant, à mesurer à la première poussée réelle du bien 2** : la
  lecture `filter[restrictions]=rate` rend le prix d'un rate plan `per_room`
  (mesuré sur La bulle). Pour un `per_person` — les prix voyagent alors en
  `rates[]` par occupation — on ne sait pas encore si ce même champ les rend. Si
  non, l'étape 7 afficherait « à faire » sur un calendrier pourtant poussé : à
  vérifier juste après la poussée, pas avant.
- [x] **0.4 La garde d'activation est verte — mais elle se VÉRIFIE en 1.1.**
  `jugerPrixDuCoeur` rend `pret_a_activer: true` sur les deux biens (17 et 22
  prix détenus, mesuré le 9 septembre 2026). En revanche l'appel du plan —
  `POST /api/channel-mapping?action=activate&dry_run=true` — **exige un
  `channel_id`**, et aucun canal n'existe avant **1.1** : cette case était mal
  placée. Elle se coche pour de bon au moment de créer le canal inactif.

  ⚠ **Ce que 0.4 a révélé, et qui bloquait toute la phase 1** : les endpoints de
  canal adressaient le provider avec l'identifiant reçu, c'est-à-dire la clé
  **source**. Mesuré : `GET /channels?filter[property_id]=209413` → **HTTP 422**,
  contre `200` sur la propriété cible. Créer le canal Booking aurait échoué.
  Corrigé : `proprieteChezLeProvider` résout la destination (`channel-mapping`,
  `channel-bcom-write`).

  ⚠ **Et le sens inverse, plus grave encore** : un bien en migration porte ses
  canaux sur sa propriété **cible**, donc tout ce qui remonte du provider —
  webhook de réservation, événement, activation — le désigne par **cet**
  identifiant. `channel-webhook`, `channel-events`, `channel-bcom-activate` et
  **la garde d'autorisation elle-même** ne cherchaient que sur la clé source :
  une réservation arrivée pendant la bascule n'aurait été réclamée par personne.
  Or « une réservation OTA n'arrive pas dans le cœur sous 30 min » est un critère
  de rollback. Corrigé : `lib/bien-du-provider.js`, point unique, les deux
  colonnes.

> **On peut s'arrêter ici sans conséquence.** Rien n'est publié : aucun canal.

### Phase 1 — les périmètres partageables (répétition générale)

- [ ] **1.1 Créer le canal Booking INACTIF** sur `hotel_id` **10853342**.
  `POST /api/channel-bcom-write?action=create` (`dry_run=true` d'abord).
  **Vérifiable** : `GET /channels` → canal présent, `is_active: false`.
- [ ] **1.2 Approuver dans l'extranet Booking — Guest reviews + Reporting SEULEMENT.**
  Ce sont les deux périmètres « plusieurs fournisseurs » : Beds24 les garde.
  **Vérifiable** : la page Connectivité montre Channex **co-détenteur** de ces
  deux périmètres, Beds24 toujours présent.
- [ ] **1.3 Constater l'écran d'approbation ET MESURER LE DÉLAI.** *C'est l'objet
  principal de cette phase, décidé par Thierry : elle sert de mesure du fait
  manquant n°2 — un transfert de périmètre est-il instantané ou soumis à revue
  Booking ?*
  **Vérifiable** : horodatage de la demande, horodatage de l'effet constaté, et
  description de ce que la page propose.
  ⚠ **Si le transfert est soumis à revue : ON SUSPEND.** La bulle reste sur
  Beds24, rien n'est cassé, on replanifie avec le délai réel.

> **Critère de passage** : Beds24 fonctionne toujours à l'identique. Si quoi que
> ce soit a bougé côté réservations ou calendrier, **on s'arrête** — le modèle
> « partageable » ne serait pas ce qu'on croit.

### Phase 2 — Reservations + Rates and availability (la bascule)

**Durée visée : moins de 30 minutes.** Au-delà d'une heure sans phase 2 vérifiée : rollback.

- [ ] **2.1 `automation_paused = true`** sur le bien. Le voyageur ne reçoit plus
  rien, le ménage n'est pas notifié, pendant la fenêtre.
  **Vérifiable** : la colonne est à `true` sur `properties`.
- [ ] **2.2 Dernier cycle Beds24 complet.** Snapshots et messages à jour.
  **Vérifiable** : `cron_logs.last_run` postérieur à 2.1, sans erreur.
- [ ] **2.3 Noter l'horodatage du dernier message reçu.** *C'est la borne qui
  permettra de détecter un trou en phase 3.*
  **Vérifiable** : `select max(created_at) from messages where property_id='209413'`.
- [ ] **2.4 Approuver le transfert des DEUX périmètres** dans l'extranet Booking.
  Jamais l'un sans l'autre : pousser les dispos sans recevoir les réservations
  produit de la surréservation, et Channex accepte la surréservation.
  **Vérifiable** : Connectivité montre Channex sur les deux, Beds24 dessaisi.
- [ ] **2.5 Airbnb — connecter et mapper.** Lien OAuth Channex, autoriser,
  `action/listings`, mapper le listing sur le rate plan. **Canal inactif.**
  **Vérifiable** : `GET /channels` → canal AirBNB, `is_active: false`, mapping présent.
- [ ] **2.6 Activer les deux canaux.**
  `POST /api/channel-mapping?action=activate&dry_run=false`.
  **Vérifiable** : `is_active: true` sur les deux, et la garde n'a pas refusé.
- [ ] **2.7 Importer le carnet.** `action/load_future_reservations` sur chaque canal.
  **Vérifiable** : les séjours à venir apparaissent côté Channex.
- [ ] **2.8 Re-keying.** `169567`/`209413` → l'UUID Channex, sur les 14 tables,
  **pendant que l'automatisation est en pause**, avec sauvegarde préalable et
  répétition à blanc.
  **Vérifiable** : comptes avant/après identiques table par table ; `properties.provider = 'channex'`.
- [ ] **2.9 Dédoublonner.** Les séjours importés portent de **nouveaux**
  identifiants Channex ; le cœur les a déjà sous leur identifiant Beds24.
  Rapprochement par `otaReservationCode`, tout marqué `initialImport`.
  **Vérifiable** : chaque `otaReservationCode` à venir apparaît **une seule fois**
  dans `bookings_snapshot`.
- [ ] **2.10 Recréer la réservation directe `78671952`** (La bulle, 24→27 sept)
  **par le module de réservation manuelle** (`ota_name: "Offline"`, chemin CRS
  éprouvé au chantier réservation manuelle). Elle n'a aucun code OTA : personne ne la
  remontera.
  **Vérifiable** : elle existe côté Channex et occupe ses nuits.
- [ ] **2.11 `automation_paused = false`.**

### Phase 2 bis — vérifications, périmètre par périmètre

- [ ] **V1 — Rates and availability.** Le calendrier Channex égale le calendrier
  Booking sur 90 jours : mêmes nuits fermées, mêmes prix.
- [ ] **V2 — Propagation.** Fermer une nuit lointaine dans HôteSmart → elle
  devient indisponible sur Booking en **moins de 15 min**. Puis la rouvrir.
- [ ] **V3 — Réouverture par le prix.** *Le geste hebdomadaire.* Saisir un prix
  sur une date fermée faute de prix → elle **rouvre** chez l'OTA sans autre geste.
- [ ] **V4 — Nuits occupées.** Aucune nuit d'un séjour en carnet n'est vendable.
- [ ] **V5 — Reservations, par le toggle et la surveillance** (décision de
  Thierry : pas de réservation test réelle). Deux temps :
  a) **Toggle** : fermer puis rouvrir une nuit lointaine et vérifier que Channex
     reçoit et propage — prouve que le canal est vivant dans les deux sens.
  b) **Surveillance** : la première réservation réelle est suivie de bout en
     bout (snapshot, ménage, message, code) et vaut acceptation.
  **Tant que (b) n'a pas eu lieu, la migration n'est PAS déclarée terminée.**
- [ ] **V6 — Aucun doublon.** Pas deux ménages sur la même date de départ,
  aucun message parti deux fois, aucun code d'accès posé deux fois.
- [ ] **V7 — Événements.** Aucun `booking_change_events` non traité datant de la fenêtre.

### Phase 3 — Guest messages (seule, ≥ 24 h après la phase 2 stable)

- [ ] **3.1 Bascule de nuit**, hors heures de messages.
- [ ] **3.2 Transférer le périmètre** dans l'extranet.
- [ ] **3.3 Message test depuis l'app Booking** → il arrive dans `messages` via le
  chemin Channex en moins de 15 min. *(Chemin éprouvé : Colomiers porte 102 messages Channex.)*
- [ ] **3.4 Sous 24 h, comparer** le fil Booking et la table `messages` sur la
  fenêtre de bascule, depuis la borne notée en 2.3.
  **Tout message présent chez Booking et absent du cœur = rollback immédiat.**

### Content et Photos — NON transférés

Décision argumentée (`spec-migration-channex.md` §4) : on n'a pas le contenu
(Beds24 ne l'expose pas), et un fournisseur de contenu sans contenu peut écraser
l'annonce. Ils retombent en gestion manuelle dans l'extranet.

---

## BIEN 2 : « coeur de vie 23 » (`169567` / `8985969`)

**Ne démarre que si les 7 vérifications du bien 1 sont vertes.** Même séquence,
avec deux différences :

- **A1 est obligatoire** (grille `per_person` : 1p→4p au prix de base, 5p +10 €, 6p +20 €).
- `occ_adults: 6` au room_type, et le rate plan part en `per_person`.

---

## ROLLBACK

**Six critères. Un seul suffit, et il n'y a pas à en débattre sur le moment :**

1. Surréservation, ou une nuit occupée redevenue vendable.
2. Une réservation OTA n'arrive pas dans le cœur sous 30 min.
3. Un message présent chez l'OTA, absent du cœur.
4. Un ménage, un code d'accès ou un message parti **en double**.
5. Re-keying incohérent (comptes avant/après divergents).
6. Fenêtre dépassant **1 heure** sans phase 2 vérifiée.

**Procédure :**

1. `automation_paused = true` — **avant tout diagnostic**.
2. Désactiver les canaux Channex (`is_active: false`).
3. Réattribuer les périmètres à Beds24 dans l'extranet.
4. Re-keying inverse (script symétrique, idempotent ; la sauvegarde de 2.8 est le filet).
5. Rejouer les vérifications V1→V7 dans l'autre sens.
6. `automation_paused = false`.
7. **Écrire ce qui s'est passé au KB avant de retenter quoi que ce soit.**

⚠ **Le rollback n'est pas gratuit** : les réservations arrivées chez Channex
pendant la fenêtre devront être réconciliées à la main.

---

## NETTOYAGE BEDS24 — après, jamais pendant

- [ ] **N1. DIFFÉRÉ — décision de Thierry.** Le nettoyage Beds24 n'a aucune
  urgence et ne se fait pas dans la foulée de la bascule. Attendre au minimum
  30 jours de fonctionnement Channex vérifié, et le traiter comme un lot à part.
- [ ] **N2. TRANCHER LES MESSAGES HISTORIQUES AVANT TOUTE DÉCONNEXION.**
  268 + 513 messages, **tous datés 2026**, alors que les réservations remontent à
  2022. Une fois le compte coupé, la question est répondue par la négative.
- [ ] **N3. Retirer les périmètres restants** à Beds24 dans l'extranet.
- [ ] **N4. Ne PAS supprimer le compte Beds24** tant que N2 n'est pas tranché.
- [ ] **N5. Purger `api_keys.api_key` (Beds24)** — dette connue : les secrets y
  sont en clair.

---

## ⚠ CE QUE JE N'AI PAS, ET QUE JE NE SUPPOSE PAS

1. **L'écran d'approbation Booking.** Je sais que Channex initie la demande par
   le `hotel_id` et qu'elle apparaît ensuite dans l'extranet. Le détail — bouton,
   liste de périmètres, délai de validation — je ne l'ai jamais vu. C'est l'objet
   de la phase 1.
2. **Le délai réel de transfert d'un périmètre.** Instantané ou soumis à revue
   Booking ? Inconnu. Si c'est soumis à revue, la « fenêtre de 30 minutes » de la
   phase 2 n'est plus tenable et le plan doit être revu.
3. **Ce que l'OTA affiche pour une date fermée sans prix.** Le staging a établi ce
   que Channex accepte, pas ce que Booking en fait. Première observation réelle en V1.
4. **Le supplément natif Airbnb sur tes deux annonces.** Les endpoints de
   tarification ne sont pas exposés par le proxy Channex (`route_not_found`).
   Seul un regard dans Airbnb le dira — d'où A1.
5. **La faisabilité d'une réservation test réelle** sur Booking (V5). Si elle n'est
   pas possible, la vérification devient « attendre la première réservation
   réelle sous surveillance », et il faut l'assumer comme tel.
