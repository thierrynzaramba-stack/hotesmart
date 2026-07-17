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
