# HÔTESMART — DOC TECHNIQUE CANAUX (DUAL-PROVIDER)
# À LIRE avant de coder quoi que ce soit qui touche aux réservations,
# à la messagerie voyageur, à la dispo ou à la connexion OTA.
# Périmètre : architecture dual-provider, flux Channex de bout en bout, bascule prod.
# Doc sœur : docs/CALENDRIER_TECH.md (calendrier tarifaire custom).
# Dernière mise à jour : Session #16 (6 juin 2026) — bascule prod étage A terminée.

## 1. ARCHITECTURE DUAL-PROVIDER (PERMANENTE)

Décision Session #15 : deux providers coexistent DÉFINITIVEMENT (pas une migration).

| | Beds24 | Channex |
|---|---|---|
| Pour qui | Hôtes déjà équipés Beds24 | Hôtes SANS channel manager |
| Entrée | Invite code (pages/connexions) | Création bien HôteSmart + iframe OTA |
| Source résas | API Beds24 (fetchBookings, polling cron) | Webhook temps réel + poll de secours |
| Envoi messages | sendViaBeds24 (tableau obligatoire) | POST /bookings/{id}/messages |
| Identifiant bien | propId Beds24 (number, ex 169567) | provider_property_id (uuid Channex) |

RÈGLE ABSOLUE : tout code aval (cron, agent IA, messages, codes, ménages) route par
`properties.provider` via `lib/channels/`. JAMAIS d'appel Beds24 direct dans du code neuf.

GARDE-FOU BUSINESS : aucun autre bridge CM (Smoobu, Hostaway, Lodgify...) avant un
prospect réel qui le demande. La couche channelProvider rend chaque ajout borné
(4 fonctions à implémenter) mais on ne code pas en avance.

### Modèle de données
- `properties.provider` : 'beds24' | 'channex' (les valeurs legacy 'channel' sont tolérées par les filtres)
- `properties.provider_property_id` : uuid de la propriété chez Channex
- `properties.room_type_id` / `rate_plan_id` : créés au provisioning
- `properties.inventory_type` : 'whole' (logement entier, SEUL codé) | 'room' | 'hotel' (501 explicite)
- Toutes les tables métier (bookings_snapshot, conversations, agent_tasks, message_templates,
  access_codes, knowledge, property_status...) utilisent `property_id` TEXT =
  propId Beds24 OU provider_property_id Channex selon le provider. PAS de FK possible.

### lib/channels/ — la couche moteur
- `index.js` : channelProvider — résout le moteur selon properties.provider
- `beds24.js` : getReservations, sendMessage (TOUJOURS un tableau), updateAvailability (TODO), refreshToken (TODO, vit dans cron-beds24)
- `channex.js` : moteur RÉEL Session #16
  - `sendMessage(ctx, { bookingId, message })` → POST /bookings/{bookingId}/messages, body { message: { message } }
  - `getMessages(ctx, bookingId)` → GET /bookings/{bookingId}/messages (sender: 'guest'|'property')
  - `getReservations(ctx)` → GET /bookings?filter[property_id]= (relectures ponctuelles ; le temps réel = webhook)
  - `updateAvailability(ctx, ari)` → POST /availability { values: [...] }
  - `refreshToken` → no-op (clé API statique)
  - Auth : header `user-api-key: CHANNEL_API_KEY` sur CHANNEL_BASE_URL

## 2. FLUX ENTRANT CHANNEX (AUTONOME, VALIDÉ EN RÉEL)

Réservation OTA → Channex → POST webhook → api/channel-webhook.js :
1. Validation header X-Channel-Webhook-Secret (CHANNEL_WEBHOOK_SECRET)
2. event 'booking' → GET /booking_revisions/feed → pour chaque révision :
   résolution du bien (properties.provider_property_id) → upsert bookings_snapshot
   (booking_id = id booking Channex, snapshot = attributs) → fermeture dispo (whole)
   → POST /booking_revisions/{id}/ack
3. event 'message' → handleMessage → insert table conversations
   (guest_name vide dans le payload — enrichissement depuis bookings_snapshot = TODO)

POLL DE SECOURS (recommandation Channex) : lib/cron-channel-feed.js pollChannelFeed()
à chaque tick du cron — lit le feed des révisions non ackées (filet anti-webhook perdu).

⚠️ Les résas sur chambres/rate plans NON MAPPÉS ne remontent JAMAIS
(event booking_unmapped_room côté Channex). TOUT mapper, toujours.

### Webhooks enregistrés
- PROD (Session #16) : `73b8253f-6ebb-4421-9696-1023d5fa4af9`
  → https://hotesmart.vercel.app/api/channel-webhook | booking;message | global | request_params {}
- Branche (obsolète, à supprimer dans l'UI Channex staging) : `fd312aea-7257-4d93-9256-e4c0d53ffd97`
- Enregistrement : action 'register' du webhook, authentifiée par token de session Supabase
  (les 6 endpoints admin protégés par secret ont été RETIRÉS Session #16, commit 8759c09)
- En Preview, Channex doit passer le mur Vercel : request_params
  { x-vercel-protection-bypass: VERCEL_BYPASS_TOKEN }. JAMAIS en prod (pas de mur).
  Ne JAMAIS utiliser x-vercel-set-bypass-cookie (provoque des 307).

## 3. LOGIQUE WHOLE (LOGEMENT ENTIER)

- À la création du bien : push dispo availability=1 sur 365 jours (étape 3bis du provisioning)
- count_of_rooms = 1, availability ∈ {0, 1} exclusivement
- Sur résa : fermeture des nuits arrival → departure-1. LA NUIT DE DÉPART RESTE LIBRE.
- Sur annulation : réouverture des mêmes nuits
- Cause racine du bug "3 chambres vendues" (Session #15) : avail jamais poussé (NULL)
  → stock par défaut Channex. Le push 365j à la création élimine ce risque.
- Propagation multi-OTA : toute mise à jour de dispo est distribuée par Channex à TOUS
  les canaux actifs du room type (anti-surbooking automatique, rien à coder).

## 4. CONNEXION OTA WHITE-LABEL (IFRAME HEADLESS)

api/channel-connect.js (GET ?property_id=<uuid Supabase du bien>) :
1. Auth Bearer token de session Supabase + garde provider ('channex'/'channel') + propriété du user
2. POST {CHANNEL_APP_BASE}/api/v1/auth/one_time_token (username = user.id)
3. Renvoie iframe_url = {CHANNEL_APP_BASE}/auth/exchange?oauth_session_key=...
   &app_mode=headless&redirect_to=/channels&property_id={provider_property_id}
   - SANS filtre channels=BDC,ABB : sur un bien sans canal il provoque la page "Ooops"
     (confirmé support Channex, Andrew)
   - Token usage unique, 15 min — l'endpoint en régénère un à chaque clic
4. Front : carte "🌐 Mes plateformes" dans pages/connexions.html — liste des biens
   channex, bouton par bien, modale plein écran avec l'iframe. La session reste
   confinée à l'iframe (headless = pas de menu ni marque Channex).
⚠️ Tester l'URL en ONGLET la fait naviguer vers l'UI complète — comportement normal
hors iframe, ne pas confondre avec un bug.

## 5. PROVISIONING D'UN BIEN (api/channel-property.js)

POST (auth session) { name, capacity, currency, base_price, city... } :
1. Création property Channex → provider_property_id
2. Création room_type (occ = capacity) + rate_plan (devise du bien)
3. (3bis) Push dispo 365j availability=1
4. (3ter) Install app Messages : POST /applications/install
   { application_installation: { property_id, application_code: 'channex_messages' } }
   — non bloquant si échec ; la réponse expose dispo_pushed et messages_app
5. Insert Supabase properties (provider='channex', inventory_type='whole' défaut)
- inventory_type 'room'/'hotel' → 501 explicite (non codé, décision Session #15)
- ⚠️ La DEVISE du rate plan DOIT matcher l'hôtel Booking au mapping (sinon mapping refusé)

## 6. MESSAGERIE VOYAGEUR (DUAL-PROVIDER)

- ENTRANT channex : webhook event 'message' → conversations (VALIDÉ en réel Session #16)
- SORTANT : lib/cron-messages.js sendGuestMessage(beds24Key, property, bookingId, message)
  → route channex (lib/channels/channex.sendMessage) ou beds24 (sendViaBeds24)
- bookings_snapshot.booking_id EST l'id booking Channex → sendMessage direct, aucune table en plus
- PRÉREQUIS : app Messages installée sur la propriété (sinon 403). Installée auto au
  provisioning (3ter). App PAYANTE par propriété → à intégrer au pricing (PENDING business).
- Erreurs connues : 403 = app absente | 422 "Thread id is not available" = le voyageur
  doit écrire en premier (le thread est créé par son 1er message) | 422 "send message
  for inactive channel" = canal mappé mais pas activé
- ⚠️ sendMessage JAMAIS validé en succès (canal sandbox resté inactif). Code prouvé
  correct par la progression des erreurs. À VALIDER au premier canal actif.
- Airbnb "inquiry" = thread SANS booking — non géré (cohérent avec le report Airbnb)

## 7. AVAL CRON (lib/cron-channel-props.js — Session #16)

processChannelProperties(results) — appelé dans api/cron.js (section 3bis) :
- SELECT properties provider IN ('channex','channel')
- property au format métier : { id: provider_property_id, name, address, provider, capacity, inventory_type }
- processMessageTemplates : source = fetchChannelBookings (bookings_snapshot, fenêtre
  -7j/+30j, exclut cancelled) au lieu de l'API Beds24 ; tout le métier (templates,
  dédup message_sent_log, mode test/auto, require_ready_status, Haiku) est PARTAGÉ
- processArrivalCodes : même cycle Seam 2 phases que Beds24 (création code → délai →
  ménage validé → PIN → envoi routé). Fix Session #16 : les bookings sans champ
  propertyId (= issus de bookings_snapshot) sont réputés appartenir au bien.
- Mode par défaut d'un bien sans config : 'test' → tout part en agent_tasks
  pending_validation, rien n'est envoyé seul.
- RESTE : classifyAndHandle (agent IA) non routé channex — chantier Session #17+.
- detectBookingChanges n'a PAS d'équivalent channex : le webhook fait ce travail.

## 8. ENVIRONNEMENTS & VARIABLES

| Variable | Valeur actuelle | Environnements |
|---|---|---|
| CHANNEL_BASE_URL | https://staging.channex.io/api/v1 | Production + Preview |
| CHANNEL_APP_BASE | https://staging.channex.io (racine SANS /api/v1) | Production + Preview |
| CHANNEL_API_KEY | clé API globale (sensible) | Production + Preview |
| CHANNEL_WEBHOOK_SECRET | secret header webhook | Production + Preview |
| VERCEL_BYPASS_TOKEN | bypass mur Vercel | Preview UNIQUEMENT |
| CRON_SECRET | régénérée Session #16 (openssl rand) | les 3 |

CONVENTION WHITE-LABEL : variables CHANNEL_* (JAMAIS CHANNEX_*), aucune mention
"channex" côté utilisateur (UI, URLs publiques, libellés, emails).

### Bascule prod — état
- ÉTAGE A (FAIT Session #16) : merge main, variables en Production, webhook prod,
  cron Vercel natif (vercel.json crons */5, auth Bearer stricte, GitHub Actions supprimé)
- ÉTAGE B (au premier vrai bien sans CM) : compte Channex payant secure.channex.io
  → changer les VALEURS de CHANNEL_BASE_URL / CHANNEL_APP_BASE / CHANNEL_API_KEY
  → recréer les biens sur le compte prod → ré-enregistrer le webhook si l'orga change.
  AUCUN changement de code. Coût/propriété + app Messages → pricing.
⚠️ Base Supabase UNIQUE (preview + prod) : le cron prod traite aussi les biens
channex de test tant qu'ils existent.

## 9. SANDBOX & TESTS

- Compte staging Channex : les biens test appartiennent au compte HôteSmart PROD
  (user 85e3a0ef / thierrynzaramba@gmail.com), PAS au compte test.
- bellevue : property 10615ece-e11c-4e8c-82f8-cbe2e7acec19, id Supabase 90e2986f,
  app Messages installée (69db6f7b). Autres : mauche vue, test, test 2.
- Hôtels test Booking : EUR 4372137 (PARTAGÉ, INSTABLE : canaux qui disparaissent,
  chambres parasites, "Channel Already Exists" → support). GBP 5868189 / 10745030 /
  11140466. USD 10485037 (vraie CB requise) / 12152494 (indispo). JPY 10484818.
- Résa test : https://secure.booking.com/book.html?hotel_id=4372137&test=1
  Visa 4111 1111 1111 1111, CVC 123, exp future. Choisir une chambre MAPPÉE.
- Pour tester le flux message entrant : garder l'onglet de confirmation ouvert
  → "Contacter l'établissement" → le message crée le thread + déclenche le webhook.
- Le sandbox n'envoie PAS d'email de confirmation.
- Support Channex réactif (Andrew, via Intercom) pour libérer les hôtels test.

## 10. RESTE À FAIRE (module canaux)

1. Supprimer l'ancien webhook de branche fd312aea (UI Channex staging)
2. Valider sendMessage sur un canal ACTIF (premier vrai canal ou sandbox débloqué)
3. Test fonctionnel codes d'accès channex (template menage_done + serrure + arrivée jour J)
4. Agent IA channex : router classifyAndHandle/processProperty (conversations déjà alimentées)
5. Enrichir guest_name des messages entrants depuis bookings_snapshot
6. Événements Airbnb spécifiques (reservation_request, inquiry, alteration_request) — à la 1re connexion Airbnb réelle
7. Étage B (compte Channex payant) au premier vrai bien sans CM
8. Nettoyer la propriété parasite "HoteSmart Test 01" 40330a78-d5c1-47aa-8be4-84f938f4f09a


## `hotel_id` en NOMBRE à la création d'un canal Booking.com

**Mesuré le 10 septembre 2026, sur l'hôtel `10853342` (La bulle).**

`POST /channels` avec `settings: { hotel_id: "10853342" }` (chaîne) rend :

```
HTTP 500  {"errors":{"code":"internal_server_error","title":"Internal Server Error"}}
```

Aucun détail, aucun champ nommé — pas un 422. Quatre variantes ont été essayées
avant de trouver : sans `rate_plans`, sans `known_mappings_list`, sans `group_id`
(qui donne, lui, un 422 explicite « You not have access to requested group »), et
avec `machine_account`. **Le seul changement qui fait passer la création de 500 à
201 est le type de `hotel_id`** : `10853342` en nombre.

**L'exigence est INVERSE sur les appels de lecture — et ça a coûté cher.**
`POST /channels/test_connection`, `/channels/mapping_details` et
`/channels/connection_details` veulent `hotel_id` en **chaîne**. En nombre,
`mapping_details` rend :

```
HTTP 422  {"errors":null}
```

Un corps **vide** : rien ne distingue ce refus de forme d'un refus de l'OTA.
C'est ce piège qui a fait conclure à tort, le 10 septembre, que « Channex n'est
pas autorisé chez Booking » — et **supprimer un canal correctement créé** — alors
que la connexion était active depuis 12:06:03 avec tous les scopes accordés.
Le même appel, `hotel_id` en chaîne, a rendu HTTP 200 et les codes réels.

Création = **nombre**. Lecture = **chaîne**. Les deux formes ne sont donc jamais
interchangeables. `settingsFor` (`api/channel-bcom.js`) impose la chaîne côté
lecture ; ne pas l'aligner sur l'écriture. Gardé par le test
« hotel_id en NOMBRE a la creation, en CHAINE a la lecture »
(`tests/migration-adressage-provider.test.js`).

## Les trois appels de lecture Booking.com, et ce qu'ils valent comme indicateur

**Mesuré le 10 septembre 2026 sur les deux hôtels de Bagnères**, `hotel_id` en
chaîne, connexion Channex active côté Booking pour le premier seulement :

| Appel | La bulle `10853342` | coeur de vie 23 `8985969` |
|---|---|---|
| `test_connection` | 200 — `success: true` | 200 — `success: false` |
| `connection_details` | 200 — `connection_status: "XML Active"`, 8 types actifs, `currency: EUR` | **400** `bad_request` |
| `mapping_details` | 200 — `rooms[]` / `rates[]` réels | **422** `{"errors":null}` |

Les trois **discriminent bien** l'hôtel connecté du non connecté. `success: true`
est le signal net ; `connection_details` dit en plus quels types de flux sont
actifs et dans quelle devise (à comparer à celle du `rate_plan`, sinon les prix
partent dans la mauvaise unité).

`mapping_details` rend les codes à recopier dans `rate_plans[].settings` :
`room_type_code` = `rooms[].id`, `rate_plan_code` = `rooms[].rates[].id`.
Exemple réel de La bulle : `1085334201` / `39174986`, `pricing_type: "Standard"`,
`max_persons: 2`, un tarif dérivé `41170866`.

⚠ `pricing_type` est au niveau `data`, pas par tarif. `price_1` est un drapeau de
structure (Standard uniquement), **pas un prix**.

**Ce que ça coûtait** : `api/channel-bcom-write.js` envoyait `String(hotelId)`.
L'écran de liaison Booking de l'hôte (`components/booking-connect.js`) aurait
donc échoué à son étape de création — juste après une vérification réussie, et
sans rien pour comprendre.

**Autre fait relevé au passage** : un canal Booking existant ne rend pas de
`group_id` dans ses attributs, alors que la création l'exige. Ne pas conclure de
son absence en lecture qu'il est optionnel en écriture.

## `hotel_id` : NOMBRE à la création, CHAÎNE pour être activable — le piège se referme sur lui-même

**Mesuré le 10 septembre 2026 sur l'hôtel `10853342`.** C'est le piège le plus
coûteux de la journée, et il n'a pas d'issue si on ne le connaît pas :

```
POST /channels                   hotel_id CHAÎNE  -> HTTP 500, sans détail
POST /channels                   hotel_id NOMBRE  -> HTTP 201  ✓
POST /channels/<id>/activate     hotel_id NOMBRE  -> HTTP 422
                                 {"errors":{"details":{"settings":["invalid settings"]}}}
```

Un canal créé par `POST /channels` est donc **inactivable pour toujours** : la
création impose le type que l'activation refuse.

**Les signes d'un canal pris dans ce piège**, tous vérifiables :
`updated_at` à quelques centièmes de `inserted_at` (Channex ne l'a jamais
touché), pas de bloc `settings.tax_settings`, et `hotel_id` de type `number`.
Un canal sain porte une **chaîne** et un `tax_settings` tiré de Booking dans la
minute ou les deux heures.

**Le remède, mesuré** : `PUT /channels/<id>` avec `{ channel: { settings: {
hotel_id: "10853342" } } }`.

⚠ **Et ce PUT FUSIONNE — l'inconnue est levée.** Envoyer la seule clé `hotel_id`
conserve `machine_account`, `mappingSettings` et les sept réglages de paiement ;
les mappings restent en place. C'était l'inconnue qui faisait éviter d'y toucher
dans `action=map` (« au cas où le PUT remplace l'objet »). Mieux : le PUT
déclenche la poignée de main avec Booking dans la seconde — `tax_settings`
apparaît, et l'activation passe alors en HTTP 200.

`api/channel-bcom-write.js` normalise donc `hotel_id` en chaîne juste après
chaque création, et rend `proof.activable` pour que l'appelant sache la
différence entre « pas encore activé » et « jamais activable ».

⚠ **Et j'ai affirmé le contraire pendant une journée** : « Channex active un
canal de lui-même quand l'OTA confirme le mapping ». C'est **faux**. Je l'avais
inféré de canaux vus passer à `is_active: true` — ils avaient été activés
explicitement, depuis le tableau de bord ou l'interface Channex. L'activation
est toujours un appel, jamais un effet de bord.

## Un canal MAPPÉ ne peut pas être désactivé

**Mesuré le 10 septembre 2026** sur le canal Airbnb de Cœur de vie 23 :

```
POST /channels/<id>/deactivate
HTTP 422  {"errors":{"code":"validation_error",
           "details":{"channel":["remove mappings before"]}}}
```

Il n'existe donc **pas** d'état « mappé mais inactif ». Un canal est soit
inactif et non mappé, soit mappé et actif — désactiver exige de retirer les
mappings d'abord.

**Ce que ça change.** La règle « mapper d'abord, activer après le transfert des
données » n'est applicable qu'à **Booking**, dont un canal se crée mappé et
`is_active: false` (vérifié : `POST /channels` avec `is_active: false` et
`rate_plans` renseigné donne bien un canal inactif mappé). Pour **Airbnb**, le
retour de l'OAuth crée le canal **actif**, et il ne peut plus être désactivé
sans se démapper. La fenêtre de doublon (le même séjour sous deux
`booking_id`, l'ancien du CM sortant et le nouveau de Channex) ne peut donc pas
être fermée côté Airbnb : elle se traite en **transférant vite**, puis en
neutralisant les séjours OTA à venir de l'ancienne clé.

## Le mapping Airbnb se pose par `/mappings`, jamais par `PUT /channels`

Les `settings` d'un canal Airbnb contiennent les **jetons OAuth**
(`settings.tokens`), plus `scope`, `token_invalid` et sept réglages de
paiement. Un `PUT /channels/:id` les fait transiter et risque de les écraser.
Le chemin est donc :

```
DELETE /channels/<id>/mappings/<mapping_id>
POST   /channels/<id>/mappings  { mapping: { rate_plan_id, settings: { listing_id, primary_occ } } }
```

Airbnb impose **un mapping par annonce** : il faut retirer l'ancien avant
d'ajouter le nouveau, donc prévoir le rollback (remettre l'ancien tarif) si
l'ajout échoue — sinon l'annonce reste non mappée sur un canal actif.

⚠ `GET /channels/<id>/mappings` rend **404** sur cette version de l'API :
seuls `POST` et `DELETE` existent sur cette collection. Les mappings se lisent
dans `channel.attributes.rate_plans[]`.

⚠ **La lecture est différée après un POST.** Un `POST /mappings` rend 200 et le
`GET` immédiat peut montrer le mapping, puis un `GET` quelques secondes plus
tard montrer `rate_plans: []` — puis le mapping revenir, cette fois avec la
configuration réelle de l'annonce tirée d'Airbnb (`published`,
`default_daily_price`, `guests_included`, `promotions`, `availability_rule`).
Le payload minimal (`listing_id` + `primary_occ`) suffit : Channex complète
seul. **Ne pas conclure d'un `rate_plans: []` immédiat que le mapping a
échoué** — le 10 septembre, cette lecture prématurée a fait diagnostiquer à
tort un mapping perdu et un prix à 0.
