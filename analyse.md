# Booking.com — connexion en rate plan indépendant

Sources : `Booking.com Connection.pdf` (extrait intégral, 13 pages texte), `Bcom postman_collection.json`,
code repo à 60b0623. Rien codé, rien appelé sur l'API.

---

## Réponse courte au fil rouge

**La connexion elle-même n'écrase rien.** `POST /channels` ne contient aucun prix — c'est
prouvé par la doc ET le Postman. Le danger n'est pas la connexion : c'est **ce qui se passe
après**, quand notre push ARI existant enverra *nos* prix sur le rate plan mappé.

**Mais** il y a un blocage structurel avant même d'y arriver : notre schéma ne peut pas
porter des tarifs différents Airbnb vs Booking (§6). C'est le vrai sujet.

---

## 1. Le mapping pousse-t-il des prix ? → NON

Payload réel de création (doc p.10 + Postman, identiques) :

```json
{ "channel": { "channel": "BookingCom", "group_id": "...", "is_active": false,
    "title": "Opera", "known_mappings_list": [], "properties": ["<UUID Channex>"],
    "rate_plans": [ { "rate_plan_id": "<notre UUID>", "settings": {
        "occ_changed": false, "occupancy": 2, "pricing_type": "OBP",
        "primary_occ": true, "rate_plan_code": 16385048,
        "readonly": false, "room_type_code": 586818903 } } ],
    "settings": { "hotel_id": "5868189" } } }
```

Aucun champ de prix, de devise, de restriction ou de condition. `settings` ne contient que des
**codes de correspondance**. Le canal établit le lien, il ne touche pas aux valeurs.

Symétriquement, **`mapping_details` ne renvoie aucun prix non plus**. Piège à éviter : le champ
`price_1` n'est pas un prix. Citation doc p.6 :

> `price_1` — Boolean. Optional. Only for Standard Pricing Model. Flag to let us know have Rate
> Plan single occupancy option or not.

C'est un drapeau de structure. Dans l'exemple il vaut `null` partout. **Conséquence directe pour
ton objectif** : les tarifs réels de Jean-Éric sur Booking **ne sont pas lisibles** par ces
endpoints. On récupère la structure (codes room/rate, occupancies, `pricing_type`, `readonly`,
titres) — jamais l'argent. Voir §5.

## 2. Où est le vrai risque d'écrasement

Il est **après** la connexion, dans du code qui existe déjà :

| Élément | Fichier | Ce qu'il fait |
|---|---|---|
| Push ARI 500 j | `lib/channel-fullsync.js:119-121` | `POST /availability` + `POST /restrictions` |
| Nos prix | `lib/channel-pricing.js:12` | `buildOccupancyRates(basePriceCents, capacity, includedGuests, extraFeeCents)` |
| Déclencheur cron | `lib/cron-channel-sync.js` (passe 3ter) | dépile `channel_sync_queue`, 1 bien/run |
| Mise en file | `api/calendar.js:233` | action explicite hôte/UI |

Nos prix viennent de **notre base** (prix de base, capacité, invités inclus, supplément), pas de
Booking. Si un full sync part sur un bien dont le rate plan est mappé à un canal Booking **actif**,
Channex pousse ces prix vers Booking → **les tarifs réels de Jean-Éric sont remplacés**.

Bonne nouvelle vérifiée : **la mise en file n'est jamais automatique**. `channel_sync_queue` n'est
alimentée que par `api/calendar.js` sur action explicite. Connecter un canal ne déclenche aucun
push. Le risque est donc maîtrisable, pas latent.

Trois protections, par ordre de solidité :

1. **`is_active: false` à la création** — c'est ce que fait l'exemple officiel. Canal inerte, aucun
   flux. Réversible (`PUT /channels/{id}`).
2. **`readonly`** — vient de Booking, on ne le choisit pas. Doc p.6 : *"Marker to represent can we
   manage this Rate Plan or not. Read Only rate plans should be mapped to prevent problems with
   booking allocation in future."* Un rate plan readonly **doit être mappé quand même**, et Channex
   ne peut pas le piloter → écrasement impossible par construction.
3. **Ne jamais enfiler de full sync** sur ce bien tant qu'on n'a pas tranché §6.

## 3. `pricing_type` et `readonly` — on copie, on n'invente pas

`POST /channels/mapping_details {channel:"BookingCom", settings:{hotel_id}}` renvoie :

```json
{ "data": { "pricing_type": "OBP",
    "rooms": [ { "id": 586818903, "title": "Double Room", "max_children": 0,
        "rates": [ { "id": 16385048, "title": "non-refundable rate", "max_persons": 2,
                     "occupancies": [1,2], "price_1": null, "readonly": false } ] } ] } }
```

- `pricing_type` : **au niveau racine `data`**, pas par rate. Doc p.9 : *"Just copy from Mapping
  Details."* `OBP` = Occupancy Based Pricing, `Standard` = per-room avec rate plan single occupancy.
- `readonly` : **par rate**, dans `rooms[].rates[]`. À recopier tel quel dans `settings.readonly`.
- `occupancies[]` : par rate, **OBP uniquement**.
- `price_1` : **Standard uniquement**, drapeau (cf. §1).
- `room_type_code` ← `rooms[].id` · `rate_plan_code` ← `rooms[].rates[].id` (entiers).
- `channel_restrictions` (via `GET /channels/list`) : `min_price: 500`, `currency: "EUR"` → Booking
  refuse < 5,00 €.
- `connection_details` → devise attendue. Doc : *"Mapped Rate Plans should have same Currency."*
- `machine_account` : type `hidden`, **rempli automatiquement par Channex**. Ne pas le demander à l'hôte.

Règle : tout ce qui décrit Booking se **recopie** depuis `mapping_details`. On n'invente que
`rate_plan_id` (notre UUID) et `primary_occ`.

`primary_occ` n'est pas cosmétique — doc p.9 :

> If Occupancy option is Primary, it will produce Restriction changes, in other case it was produce
> only Price changes.

Donc `primary_occ: true` = cette ligne pousse aussi les **restrictions** (min stay, CTA/CTD…).
C'est le levier le plus dangereux pour « ne pas perturber les conditions ».

## 4. Réutilisable vs spécifique Booking

**Réutilisable tel quel depuis `api/channel-mapping.js`** :

- bloc AUTH + ownership (l.53-79) : Bearer Supabase → `user.id` → `properties` par `provider_property_id`
- `channelCall()` (l.25) et `redact()` (l.37)
- action `groups` (l.82) : résout le `group_id` du bien — **requis** par `POST /channels`, déjà écrit
- action `channels` (l.102) : état des canaux du bien
- le pattern de sûreté maison : `dry_run=true` par défaut, refus 409 sur canal actif sauf `force=1`,
  et relecture après écriture comme preuve (l.320-330)

**Spécifique Booking — à écrire** :

- `test_connection` / `connection_details` : n'existent pas aujourd'hui.
- **`mapping_details` n'est PAS réutilisable en l'état.** L'action actuelle (l.121) *lit d'abord le
  canal existant* pour en extraire `channel` + `settings`. Pour Booking il n'y a **pas encore de
  canal** — c'est justement ce qu'on veut construire. Il faut une variante qui prend `hotel_id`
  en paramètre et fabrique `{channel:"BookingCom", settings:{hotel_id}}` directement.
- Le canal Airbnb est créé par l'**OAuth** (`action=map` fait juste `POST /channels/:id/mappings`
  avec `{listing_id, primary_occ}`, payload minimal). Pour Booking **c'est nous qui créons le canal**
  via `POST /channels`, avec le `rate_plans[]` riche complet. Deux mécaniques différentes.
- Contraintes Booking absentes chez Airbnb (doc p.11) :
  - **one-to-one** : *"Booking.com supports only one-to-one connections, so for Booking.com you
    should choose one Property ID"* → `properties: [un seul UUID]`.
  - **un seul canal par `hotel_id`** chez Channex → `DELETE /channels/{id}` obligatoire avant de
    retester. À intégrer au cycle throwaway (l'action `delete` existe déjà, l.388).

## 5. Diagnostic lecture d'abord — 5 actions, zéro écriture

Sur le compte test **5868189** (OBP), puis **6519420** (Standard) pour comparer les deux modèles :

| # | Action | Appel | Ce qu'on cherche |
|---|---|---|---|
| 1 | `bcom_list` | `GET /channels/list` | `params`/`rate_params` réels, `channel_restrictions`, **`actions[]`** |
| 2 | `bcom_test_connection` | `POST /channels/test_connection` | `success: true` |
| 3 | `bcom_mapping_details` | `POST /channels/mapping_details` | `pricing_type`, `rooms[].rates[]`, `readonly`, `occupancies` |
| 4 | `bcom_connection_details` | `POST /channels/connection_details` | devise attendue |
| 5 | `bcom_our_options` | `GET /room_types/options` + `GET /rate_plans/options?filter[property_id]=<notre UUID>&multi_occupancy=true` | **le point noir, cf. ci-dessous** |

Tous en lecture. Aucun `POST /channels`. Le commentaire existant l.12 de `channel-mapping.js` dit
déjà que `mapping_details` est un POST sans effet de bord — même logique ici.

**Deux inconnues que seul le diagnostic tranche — je ne veux pas les deviner :**

- **(a) Une ligne `rate_plans[]` par occupation.** Dans l'exemple officiel, occupancy 2
  (`primary_occ: true`) et occupancy 1 (`primary_occ: false`) pointent le **même**
  `rate_plan_code`/`room_type_code` mais **deux `rate_plan_id` Channex différents**
  (`a35f1fd4…` et `2a0c416b…`). Or notre provisioning crée **un seul** rate plan `per_person`
  avec des options 1..cap (`api/channel-property.js:365-376`). Est-ce que
  `rate_plans/options?…&multi_occupancy=true` éclate notre rate plan unique en une entrée par
  occupation (même UUID), ou est-ce que Booking OBP exige réellement N rate plans distincts ?
  **L'appel #5 sur notre bien répond.** Tout le reste en dépend.
- **(b) `load_and_save_ari` existe-t-il pour BookingCom ?** Le Postman l'utilise en exemple
  générique (`GET /channels/{uuid}/execute/load_and_save_ari`), mais la doc liste pour BookingCom
  `actions: ["load_future_reservations"]` **seulement**. Si `load_and_save_ari` était disponible,
  ce serait la seule voie pour *importer* les tarifs Booking existants au lieu de les ressaisir.
  **L'appel #1 tranche.** Attention : le nom suggère aussi une écriture — ne pas l'exécuter à
  l'aveugle sur un canal actif.

## 6. Le blocage structurel — à trancher avant de coder l'UI

Ton énoncé : le bien est sur Airbnb **et** Booking, avec des **tarifs/conditions différents**.

L'ARI se pousse **par rate plan**. Or aujourd'hui :

- `api/channel-property.js:338-392` provisionne **1 room_type + 1 rate_plan** par bien ;
- `properties.provider_rate_plan_id` est une colonne **unique** (singulier) ;
- l'Airbnb de ce bien est déjà mappé sur **ce** rate plan.

Si on mappe **le même** rate plan au canal Booking, tout push de prix part **sur les deux canaux à
la fois** → tarifs forcément identiques Airbnb = Booking. Des tarifs différenciés sont
**structurellement impossibles** dans le schéma actuel. Ton titre dit « rate plan indépendant » —
c'est exactement ça, et ça coûte : 2ᵉ rate plan Channex dédié Booking, table de liaison
bien ↔ canal ↔ rate plan (la colonne unique ne suffit plus), provisioning, pricing, UI, full sync
par canal. C'est un chantier, pas une feature.

**Recommandation (boussoles 1 et 3) : ne pas le faire maintenant.**

V1 Booking = **connexion en lecture**. Canal créé `is_active: false`, mapping posé (y compris les
rate plans `readonly`, comme la doc l'exige), **aucun push ARI**, jamais de full sync sur ce bien.
Jean-Éric continue de piloter ses tarifs Booking dans son extranet ; HôteSmart ingère les
réservations et les messages. « Ne rien écraser » devient une **garantie par construction**, pas
une discipline à tenir. Ça se livre vite et ça vaut déjà : messagerie unifiée + calendrier consolidé
sont la douleur aiguë, pas le pricing Booking qu'il gère déjà.

Le rate plan indépendant devient un chantier V2, décidé sur un prospect réel qui demande à piloter
ses prix Booking depuis HôteSmart.

**Réserve honnête sur cette V1** : `is_active: false` implique-t-il qu'aucune réservation ne
remonte ? Doc muette. Si le canal inactif ne pull rien, la V1 lecture perd son intérêt et il faut
un canal actif — donc la question du push redevient centrale, et c'est `readonly` qui devient
l'unique garde-fou. **À vérifier au diagnostic (appels #1 et #2) avant de s'engager sur la V1.**

---

## Séquence proposée

1. Coder les **5 actions diagnostic** (lecture pure) sur 5868189 + 6519420.
2. Lire les réponses réelles : trancher (a) une ligne par occupation, (b) `load_and_save_ari`,
   et la réserve `is_active:false`.
3. **Décision produit** : V1 lecture, ou rate plan indépendant.
4. Seulement ensuite : UI + `POST /channels` en `dry_run` par défaut, cycle throwaway
   (`DELETE` avant chaque retest, contrainte 1 canal/hotel_id).

---

## Validation E2E sur Booking réel Jean-Éric (Session #22, 18 juil 2026)

Bien Colomiers : `properties.id = e14e25f6-…`, UUID Channex `0544fd9a-…`,
`provider_rate_plan_id = 06a3f06c-…`, `group_id = 8fed3205-…`. Hôtel Booking `12902199`.

**Décision RLO → Standard.** `mapping_details` renvoie `pricing_type:"RLO"` (absent de la doc
Evan et du Postman : seuls `Standard`/`OBP` existent dans le `select` `rate_params.pricing_type`).
Structure vide (`occupancies:[]`, `price_1:null`) = prix unique par logement = définition du
Standard. On mappe donc en `Standard`. **Channex a accepté** (canal créé HTTP 201, mapping relu
identique). RLO activé mais inutilisé côté Booking → Standard est le bon équivalent.

**Étape 1 — mapping seul** (`api/channel-bcom-write.js`, action `create`) : `POST /channels`,
`is_active:false` forcé serveur, aucun push ARI (allowlist réseau refuse
availability/restrictions/action/sync). Canal créé : `fc215573-d51c-41f8-827e-e04488a0e4ef`.
`actions:["load_future_reservations"]` (pas de `load_and_save_ari` pour BookingCom → pas
d'import des tarifs Booking existants, cf. §5(b)). `delete` prêt en rollback.

**Étape 2 — activation** (`api/channel-bcom-activate.js`, actions `activate`/`deactivate`/`ari`) :
fichier séparé, allowlist autorise seulement activate/deactivate + lectures ; aucune écriture ARI.
`POST /channels/:id/activate` → `is_active:true`, Channex « Success ». Lecture ARI post-activation :
`availability` OK (Channex détient dispo `1` sur dates libres, `0` sur résas réelles — recoupe la
résa Airbnb de Cristina arr. 28 juil) ; **lecture `restrictions` en 400** (`"restrictions is
required"` : le GET Channex exige un paramètre `restrictions=min_stay_…` — format à corriger si on
veut prouver le min stay par lecture ; min stay 3 déjà confirmé propagé via rate plan unique).
`deactivate` = rollback immédiat (garde le mapping).

**Chaîne post-activation AUTOMATIQUE — validée, rien à coder.** L'event `activate_channel`
(channel-events.js) s'est déclenché **à notre activation directe par API** (`POST /channels/:id/activate`),
pas seulement depuis l'iframe. Trace Vercel : `GET /channels/fc215573` → `GET properties` →
`GET /bookings` → 3× `POST bookings_snapshot` → `GET /message_threads`+messages →
`PATCH properties (channel_ready)`. Preuve base : `channel_ready_at=22:58:47` (= moment de
l'`activate`, pas du `create` à 22:40 → **la création seule n'arme pas la chaîne, l'activation
oui**). Donc pour un hôte réel : map+active dans l'iframe → historique résas + messages rapatriés
automatiquement.

**Prêt (vérifié lecture) pour un hôte Booking** : rapatriement résas (`getReservations` OTA-agnostique),
capture temps réel résas (webhook + feed cron, routés par `provider_property_id`, aucun filtre OTA),
import + capture messages (`importMessages` OTA-agnostique, `normOta('BookingCom')→'booking'`),
push dispo cross-canal (`pushAvailabilityOnce`, dispo seule — jamais prix/min stay).

**Push ARI : jamais automatique sur prix/min stay.** Seuls déclencheurs = action hôte explicite
(`calendar.js action=fullsync` → file → cron worker ; ou sauvegarde d'édition calendrier → push
direct). Aucun cron/webhook ne pousse prix ni restrictions. Le seul flux sortant automatique =
`availability` (0/1) reflétant une vraie résa/annulation. Réserve : ce que **Channex** propage de
lui-même à l'activation (état déjà correct : min stay 3, dispo) n'est pas gouverné par notre code.

**Reste à confirmer pour certifier « hôte Booking fonctionnel »** :
- app messages Channex **active sur le compte de l'hôte** (sinon `importMessages` → 403
  `messages_app_absent`, import à vide). Colomiers n'a aucune résa Booking → non prouvable ici.
- enregistrement du 2ᵉ webhook (channel-events, action `register`) **par compte hôte** à l'onboarding.
- **envoi** message → Booking (`sendMessage` → `POST /bookings/:id/messages` ; 422 = OTA sans
  support) non testé bout en bout (connection_details annonce « Messaging XML Active », non prouvé).

État final : canal `fc215573` **actif et mappé, gardé** (Voie A : rouvrir les dates). Fichiers
`channel-bcom-write.js` (create/delete) et `channel-bcom-activate.js` (activate/deactivate/ari)
déployés, chacun avec allowlist anti-push ARI.

---

## Chantier écran « Connexions » par bien + assistant Booking (Session #23, analyse)

Aujourd'hui le bouton de la carte d'un bien (`biens.html`, `[data-connect]`) appelle
directement `openAirbnbConnect`. Avec Booking, il faut une étape intermédiaire : un écran
listant les canaux, qui route vers l'assistant du canal cliqué.

### 1. Détection d'état par canal — UN SEUL appel

`api.channel.mapping.channels(providerPropertyId)` (action `channels` de `channel-mapping.js`,
déjà déployée) fait `GET /channels?filter[property_id]` et renvoie **tous** les canaux du bien :
`[{ id, title, ota, is_active }]` avec `ota ∈ {Airbnb, BookingCom}`. **Un seul appel couvre
Airbnb ET Booking** → on classe les lignes par `ota`. Pas besoin d'`account_status` (spécifique
Airbnb) ni d'appel séparé Booking.

- Airbnb connecté = ligne `ota=Airbnb` présente (+ `is_active`). Nom de l'annonce en référence :
  `title` du canal en v1 ; le nom exact de l'annonce Airbnb nécessiterait un 2ᵉ appel
  (`action=mappings`) — à faire **paresseusement** (seulement si on veut le nom précis), pas au
  chargement.
- Booking connecté = ligne `ota=BookingCom` + `is_active`. Mappé-mais-inactif = état intermédiaire.

**Coût / ne pas alourdir** : 1 appel au moment où l'hôte OUVRE l'écran Connexions d'un bien (la
modale). **Ne PAS** mettre de badge d'état sur chaque carte de la liste des biens (ce serait N
appels au chargement de `biens.html`) — l'état ne se lit qu'à l'ouverture de la modale.

### 2. Placement — nouveau composant `components/connexions.js` (modale)

Composant séparé, calqué sur l'infra modale d'`airbnb-connect.js` (`ensureModal`/`setBody`/`close`),
qui liste les canaux et route :
- clic Airbnb → `openAirbnbConnect(p, el)` (existant, inchangé).
- clic Booking → `openBookingConnect(p, el)` (à créer, cf. §4).

**Collision de nom à éviter** : `/connexions` existe DÉJÀ (`pages/connexions.html` = « Connexions
API », page globale de la sidebar : clés API/état des intégrations). Le nouvel écran est une
**modale par bien**, pas cette page. Garder le fichier `components/connexions.js` mais titrer la
modale « Connexions de {bien} » / « Canaux de distribution » pour ne pas les confondre. Export
proposé : `openConnexions(property, anchorEl)`.

### 3. Refactor minimal `biens.html`

Une ligne + un import :
- `import { openConnexions } from '/components/connexions.js'`
- `card.querySelector('[data-connect]')...` → `openConnexions(p, e.currentTarget)` au lieu de
  `openAirbnbConnect`. Le libellé du bouton passe de « Connecter / Mapper mes annonces » à
  « Connexions ». `airbnb-connect.js` reste importé (appelé par le nouveau composant), inchangé.

### 4. Assistant Booking A→D (sans OAuth)

Réutilise l'infra modale + le fil d'étapes (`setStep`) d'Airbnb. Pas de popup OAuth : Booking
s'autorise dans l'extranet de l'hôte, pas par redirection.

- **A — prérequis + `hotel_id`** : 3 prérequis (autoriser le provider de connectivité dans
  l'extranet Booking ; aucun autre channel manager sur cet hôtel — Booking est one-to-one ;
  récupérer l'ID hôtel). **Avertissement fort** : à l'établissement de la connexion, Booking
  **ferme les dates** jusqu'à la fin du process (constaté en vrai) ; HôteSmart les rouvre à
  l'activation. Saisie du `hotel_id`.
- **B — vérification** : `test_connection` (connectable ?) + `mapping_details` (chambres/tarifs) +
  `connection_details` (devise). Affiche « établissement trouvé » + chambre(s)/tarif(s) + devise à
  confirmer. RLO→Standard géré en interne (aucun jargon montré à l'hôte).
- **C — liaison + activation** : `create` (POST /channels, `is_active:false`) puis `activate`.
  Feedback « Liaison… » → « Activation… » ; réouverture des dates annoncée.
- **D — connecté** : réservations + messages récupérés, calendrier synchronisé. + écran
  « déjà connecté » avec Déconnecter (via `delete`/`deactivate`).

**BLOCAGE PRODUIT à trancher pour l'écran A (marque blanche)** : dans l'extranet Booking, l'hôte
doit sélectionner le **provider de connectivité par son nom**. Ce nom est celui du provider certifié
auprès de Booking — vraisemblablement **« Channex »**, pas « HôteSmart » (`machine_account` observé
= `Channex-prod-q2-2026`). La règle marque blanche (jamais exposer Channex) **casse à cette étape**
sauf si Channex propose un nom de provider en marque blanche. **À vérifier avec Channex avant de
figer le texte de l'écran A** — c'est le seul endroit où l'hôte verrait « Channex ».

### 5. Ce qu'on réutilise / ce qui manque

Réutilisable tel quel (endpoints déjà déployés) :
- `channel-bcom.js` : `test_connection`, `mapping_details`, `connection_details`, `our_options` (écran B).
- `channel-bcom-write.js` : `create` (écran C), `delete` (déconnexion).
- `channel-bcom-activate.js` : `activate` (écran C), `deactivate`/`ari` (déconnexion / vérif).
- RLO→Standard déjà géré : `create` a `pricing_type=Standard` par défaut.

Manque (plomberie à écrire) :
- Wrappers `api-client.js` : `api.channel.bcom.{ testConnection, mappingDetails, connectionDetails,
  ourOptions, create, delete, activate, deactivate, ari }` (aucun n'existe aujourd'hui).
- `components/connexions.js` (routeur) + `openBookingConnect` (assistant B, dans un nouveau
  `components/booking-connect.js` calqué sur `airbnb-connect.js`).
- Résolution `group_id`/`provider_rate_plan_id` : déjà gérée **côté serveur** par `create`
  (l'UI n'envoie que `property_id`, `hotel_id`, `room_type_code`, `rate_plan_code` — ces deux
  derniers viennent de l'écran B `mapping_details`).

---

## Chantier rate plans dérivés par plateforme (Session #24, analyse — rien codé)

Vocabulaire figé : **tarif de base** (rate plan pilote, prix/restrictions de référence) ·
**tarif dérivé** (un par canal, = base × règle, restrictions propres possibles) ·
**override** (date détachée du calcul, prix/restriction manuels).

### Fait structurant (détermine tout le chantier)

Prix ET restrictions sont poussés **par `rate_plan_id`** :
`channel-fullsync.js` construit `restItems`/`availItems` avec un **unique** `rate_plan_id`
(`ratePlanFs`), idem le push delta de `calendar.js`. Or Colomiers a **1 rate plan mappé sur
les DEUX canaux** (Airbnb + Booking). **Conséquence dure** : tant qu'un bien n'a qu'un rate plan,
**aucune** différenciation n'est possible — ni prix, ni min stay. Le 2ᵉ rate plan mappé à Booking
est le **socle incontournable**, y compris pour le cas « juste le min stay » (cf. §6).

`calendar_inventory` est clé par **`property_id` (UUID bien) + date** — pas par rate plan. Il porte
le **tarif de base** (rate, min_stay, cta/ctd, avail…). C'est notre source de vérité de la base.

### 1. Modèle de données

**Aujourd'hui** : `properties.provider_rate_plan_id` + `provider_room_type_id` = colonnes UNIQUES
(référencées dans 8 fichiers). Insuffisant pour N rate plans.

**Cible — table de liaison bien ↔ canal ↔ rate plan Channex** :

```sql
create table property_channel_rate_plans (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  channel text not null,                 -- 'airbnb' | 'booking' (canal logique)
  role text not null default 'derived',  -- 'base' | 'derived'
  provider_rate_plan_id text not null,   -- rate plan Channex (TEXT)
  provider_room_type_id text not null,   -- room type Channex (partagé, whole=1 unité)
  -- règle de dérivation (null pour la base)
  derive_mode  text,                     -- 'percent' | 'amount' | null
  derive_value numeric,                  -- +18 (%) ou +2500 (cents), signé
  -- restriction propre au canal (null = suit la base)
  min_stay int,
  is_active boolean not null default true,
  created_at timestamptz default now(),
  unique(property_id, channel)
);
```

- Ligne **base** : `role='base'`, `derive_mode=null` (mappée au canal de référence, ex. Airbnb).
- Ligne **dérivée** : `role='derived'`, `channel='booking'`, `derive_mode='percent'`,
  `derive_value=18`, `min_stay=3`.
- **Règle de dérivation stockée dans cette table** (une ligne = un canal = sa règle).
- `properties.provider_rate_plan_id` reste (rétro-compat = la base) ; la table est la source pour
  qui sait boucler. Migration douce, pas de big-bang sur les 8 fichiers.

**Overrides — table séparée par date et par dérivé** (ne PAS surcharger `calendar_inventory`,
qui est la base) :

```sql
create table channel_rate_overrides (
  id uuid primary key default gen_random_uuid(),
  pcrp_id uuid not null references property_channel_rate_plans(id) on delete cascade,
  date date not null,
  rate_cents int,           -- prix manuel (null = suit la dérivation)
  min_stay_arrival int, min_stay_through int,
  cta boolean, ctd boolean, stop_sell boolean,
  unique(pcrp_id, date)
);
```

Une ligne ici = cette date, sur ce dérivé, **détachée** du calcul auto.

### 2. Provisioning & migration

**Nouveau bien** : créer le room_type (1, whole) + le rate plan **base**, puis 0..N rate plans
**dérivés** (un par canal à différencier). Aujourd'hui `channel-property.js` n'en crée qu'un — à
étendre pour insérer aussi les lignes `property_channel_rate_plans`.

**Biens EXISTANTS (Colomiers)** — coexistence, PAS big-bang :
- État actuel : 1 rate plan mappé Airbnb **et** Booking. On le déclare `role='base'` (Airbnb).
- Pour différencier Booking : créer un **2ᵉ rate plan Channex** (dérivé), **démapper Booking** du
  rate plan partagé, **remapper Booking** sur le dérivé.
- ⚠️ **Fenêtre de risque** : le remap Booking rejoue la fermeture des dates (vécu à la connexion) —
  c'est une **migration délibérée**, à faire dans un moment calme, pas un cron silencieux.
- Les biens qui ne différencient rien restent en 1 rate plan : la table les décrit avec une seule
  ligne `base`. Coexistence propre.

**Beds24** : hors périmètre total (ces biens se gèrent dans Beds24). La table ne concerne que
`provider='channex'`.

### 3. Moteur de calcul

**Calcul au PUSH, pas stocké** (éviter la double source qui désynchronise ; le fullsync lit déjà
`calendar_inventory` en direct). Pour chaque rate plan du bien :
- **base** : pousse `calendar_inventory` tel quel (comportement actuel).
- **dérivé** : par date, `prix = override.rate_cents ?? round(base_rate × coef)` ;
  `min_stay = override ?? pcrp.min_stay ?? base.min_stay` ; autres restrictions = `override ?? base`.

**Restrictions (min stay) : définies par canal, indépendamment** (pas dérivées d'un coef) —
`pcrp.min_stay` écrase la base pour ce canal. C'est le cas #1 (Airbnb 2 / Booking 3). Le prix, lui,
est dérivé par coef (cas #2). Deux mécanismes distincts, cohérent avec le vocabulaire figé.

**Piste à VÉRIFIER avec Channex (peut réduire drastiquement le chantier)** : Channex expose
`derived_rate_plan_ids` (vu dans `mapping_details`). S'il gère nativement des **rate plans dérivés**
(enfant = parent × règle, avec **restrictions indépendantes**), alors :
- on crée le dérivé Booking comme **enfant** du base côté Channex,
- on pousse l'ARI **uniquement à la base** → `channel-fullsync.js` **reste inchangé (certifié
  intact)**, Channex dérive le prix Booking tout seul,
- le min stay Booking se pose une fois sur le dérivé (hors fullsync).
**Inconnues à lever sur le compte test** : (a) un dérivé accepte-t-il des restrictions propres
(min stay différent) ? (b) modes de dérivation supportés (% et montant fixe) ? (c) signe/plage.
**Si oui → Option A (léger). Si non → Option B (on calcule et on pousse N).**

### 4. Push

- **Option A (dérivation native Channex)** : fullsync **non touché**. On ne pousse qu'à la base.
  Idéal : le fichier certifié reste tel quel. Dépend de la vérif §3.
- **Option B (on pousse N)** : extraire un helper `pushRatePlanARI(bien, pcrp, overrides)` et
  **boucler** sur les rate plans du bien. **La forme du push par rate plan reste identique**
  (mêmes champs, même coalescence, état complet) — on répète juste l'appel avec un autre
  `rate_plan_id` et d'autres valeurs. Impact certif : le **format fil par rate plan est inchangé**,
  donc sémantiquement conforme ; mais on **modifie un fichier certifié** → à confirmer si Channex
  exige une re-revue. Mitigation : garder `runFullSync` comme wrapper qui appelle le helper en
  boucle, sans changer la logique d'un push unitaire.

**Recommandation** : trancher §3 sur le compte test AVANT de choisir. Option A évite de toucher le
certifié — à privilégier si elle marche.

### 5. UI

- **Règle par canal** : sur l'**écran Connexions** (déjà par bien, par canal) — c'est le foyer
  naturel. Sur la ligne Booking : « Prix Booking = base + __ % » et « Séjour minimum Booking = __
  nuits ». Écrit dans `property_channel_rate_plans`.
- **Calendrier** : 3 états à distinguer visuellement — **base** (normal), **dérivé** (valeur
  calculée, badge/teinte discrète « auto »), **override** (bordure ambre = manuel, détaché). Le
  calendrier actuel montre UNE ligne par bien ; pour le par-canal il faut un **sélecteur de canal**
  (onglet Base / Booking) plutôt qu'empiler les lignes. Décision UI à figer ; garder le calendrier
  base par défaut, canal dérivé en second onglet.

### 6. Ampleur & découpage minimal livrable vite ⭐

**Fichiers touchés (Option B, complet)** : migration SQL (2 tables) · `channel-property.js`
(provisioning N) · `channel-fullsync.js` + `cron-channel-sync.js` (boucle push, certifié) ·
`calendar.js` (push delta + lecture) · `channel-mapping.js`/`channel-bcom-*` (remap sur dérivé) ·
`api-client.js` + `connexions.js`/calendrier (UI règle + affichage) · moteur de calcul (nouveau
lib). Gros chantier (~8-10 fichiers + 2 tables + UI calendrier).

**Le sous-ensemble livrable vite existe — mais un socle est incompressible.**

- **Socle (Step 0, incontournable)** : donner au bien un **2ᵉ rate plan mappé Booking** +
  la table `property_channel_rate_plans` + la migration Colomiers (créer dérivé, remap Booking).
  Sans lui, RIEN ne diffère. C'est le vrai prérequis, même pour le min stay.
- **Tranche 1 — min stay différencié (cas #1, la plus légère)** : une fois 2 rate plans en place,
  pousser un `min_stay` propre au canal. **Pas de coefficient, pas de moteur de prix, pas
  d'overrides** — juste un entier par canal + une restriction poussée sur le dérivé. Prix
  **identiques** au départ (coef neutre). Livre le cas #1 vite.
- **Tranche 2 — prix dérivé (cas #2)** : ajoute `derive_mode/value` + le moteur de calcul + l'UI
  coefficient. Plus lourd.
- **Tranche 3 — overrides par date** : table `channel_rate_overrides` + calendrier (sélecteur
  canal, code couleur). Le plus lourd en UI.

**Réponse au point 6** : oui, il y a un livrable rapide = **Socle + Tranche 1 (min stay)**. Mais
honnêteté : le Socle (2ᵉ rate plan + migration Colomiers avec fenêtre de fermeture des dates)
n'est **pas** trivial — c'est le prix d'entrée, partagé par les deux cas. Le min stay seul est
ensuite quasi gratuit ; le prix dérivé est le vrai surcoût. **Ordre recommandé** : (0) vérifier la
dérivation native Channex sur le compte test → (1) Socle + min stay → (2) prix dérivé → (3)
overrides. Si la dérivation native marche (§3), le Socle rétrécit et le certifié n'est pas touché.

### Étape 0 — dérivation native Channex : VÉRIFIÉE (doc + test live, Session #24)

**Doc** (docs.channex.io « Rate Plans Collection » + « ARI ») :
- `POST /rate_plans` accepte `parent_rate_plan_id`, `rate_mode ∈ {manual,derived,cascade,auto}`,
  et des flags d'héritage PAR restriction : `inherit_rate`, `inherit_min_stay_arrival`,
  `inherit_min_stay_through`, `inherit_closed_to_arrival/departure`, `inherit_stop_sell`,
  `inherit_max_stay`… Défaut `true` si parent présent, mais réglables un par un.
- Dérivation prix via `derived_option` par option : `{ rate: [["increase_by_percent","18"]] }`
  (aussi `increase_by_amount`).
- `derived_rate_plan_ids` (vu dans Booking `mapping_details`) = côté Booking (OTA), PAS Channex.
- Lecture ARI : `GET /restrictions?filter[property_id]=&filter[date][gte]=&filter[date][lte]=
  &filter[restrictions]=rate,min_stay_arrival,min_stay_through` → réponse indexée par rate_plan_id
  (donc parent + enfant en une lecture).

**Test live jetable** (propriété `ZZ-TEST-derive`, aucun mapping canal, teardown vérifié) :
parent poussé `min_stay=2, rate=100€` par date → **enfant lu = `min_stay=3` (indépendant) + `rate=118€`
(dérivé +18%)**, dès la 1ʳᵉ lecture. Propriété supprimée (`property_gone:true`).

**VERDICT : Option A adoptée.** Booking = enfant du base (`parent_rate_plan_id`, `inherit_rate:true`
+ `derived_option +X%`, `inherit_min_stay_*:false` + `min_stay` propre). On pousse l'ARI UNIQUEMENT
à la base → `channel-fullsync.js` CERTIFIÉ INTACT, l'enfant dérive prix + garde son min stay.
Le chantier Push (§4) tombe. Reste le socle : table `property_channel_rate_plans` + création du
dérivé Booking pour Colomiers + migration (remap Booking = rejoue la fermeture des dates, moment choisi).
