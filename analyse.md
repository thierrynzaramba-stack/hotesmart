# Audit d'unification (étape 0) — chantier prestataires ménage

Périmètre : §0 de docs/specs/spec-prestataires-menage.md. Audit lecture de code uniquement
(pas de .env local → aucune requête Supabase possible depuis cette machine).

## A. Fichiers examinés

### Code métier ménage
| Fichier | Rôle | Parle à un provider ? |
|---|---|---|
| api/menages-public.js | API PWA prestataire (planning public) | NON — lit properties + bookings_snapshot |
| apps/menages/public.html | PWA prestataire | NON — appelle /api/menages-public |
| apps/menages/index.html | Planning ménage hôte (sidebar « Planning ») | **OUI — /api/beds24 direct** |
| apps/menages/prestataires.html | Gestion prestataires/tokens | Indirect — loadAllProperties + test `_source==='beds24'` |
| lib/cron-bookings.js | Création des menage_events | OUI (couche sync, légitime) |
| lib/cron-alerting.js | Sonde production d'événements | NON |
| api/channel-property.js | Purge des tables enfant à la suppression d'un bien | Couche sync |

### Writers de bookings_snapshot (5)
| # | Fichier | Provider | Schéma |
|---|---|---|---|
| A | lib/cron-bookings.js:107 | beds24 | 7 champs |
| C | lib/channels/beds24.js:113 | beds24 | 13 champs (+ `provider`) |
| B | api/channel-events.js:92 | channex | 12 champs |
| D | api/channel-webhook.js:126 | channex | 12 champs |
| E | lib/cron-channel-feed.js:66 | channex | 12 champs |

## B. Écarts trouvés

### E1 — BLOQUANT : le planning ménage hôte est mono-provider
apps/menages/index.html:240 et :253 appellent `/api/beds24` (`getProperties`, `getBookings`).
api/beds24.js est un proxy Beds24 direct. Un hôte Channex a un planning ménage **vide**.
Correctif : passer par shared/properties.js `loadAllProperties()` + lecture bookings_snapshot
via un endpoint serverless (pattern api/menages-public.js).

### E2 — BLOQUANT : aucun menage_event côté Channex
`from('menage_events').insert` n'existe qu'en lib/cron-bookings.js:120 (chemin Beds24).
Ni channel-webhook, ni cron-channel-feed, ni channel-events n'en produisent.
Conséquence : sur un bien Channex, aucune notification nouvelle résa / modif / annulation
au prestataire. Le planning lui-même reste correct (il vient de bookings_snapshot).

### E3 — Snapshot Beds24 à deux schémas, résultat non déterministe
Writer A écrit 7 champs et **écrase** les champs de C sur la même ligne
(onConflict user_id,booking_id). Dans un cycle nominal C repasse après A
(cron.js:172 → :174) et restaure le schéma riche. Mais si processProperty jette
avant (fetchMessages Beds24 en échec → catch cron.js:186), le bien reste au schéma
pauvre : `otaReservationCode`, `source`, `amount`, `currency`, `arrivalHour` absents.
Impact direct sur la spec avis voyageurs : la résolution `booking_uid` par
`ota_reservation_id` repose sur `otaReservationCode`.

### E4 — Champs non alignés entre providers
- `provider` : présent uniquement dans le writer C. Absent des 4 autres → impossible de
  savoir de quel provider vient une ligne bookings_snapshot de façon fiable.
- `arrivalHour`, `amount`, `currency` : toujours null côté Beds24 (C les force à null).
- `otaReservationCode` : `b.apiReference` (Beds24) vs `ota_reservation_code` (Channex) —
  formats OTA différents, à confirmer sur données réelles.

### E5 — Vocabulaire de statut divergent
Channex : `new | modified | cancelled` (documenté api/channel-webhook.js:113).
Beds24 : statut brut de l'API v2 (`new, request, confirmed, cancelled, black, inquiry`),
aucun filtre dans lib/cron-beds24.js:47 fetchBookings.
api/menages-public.js:217 ne filtre que `cancelled` → un blocage propriétaire (`black`)
ou une demande (`request`) Beds24 génère un ménage fantôme au planning.

### E6 — Clés : la spec demande properties.id (UUID), le code utilise provider_property_id (TEXT)
Convention réelle, cohérente et assumée dans tout le repo
(api/channel-property.js:361 : « Tables enfant keyees par property_id = provider_property_id
(TEXT). AUCUNE FK cascade (property_id TEXT vs properties.id UUID) → purge EXPLICITE ») :
- `properties.id` = UUID ; `properties.provider_property_id` = TEXT
  (propId Beds24 numérique OU UUID Channex) ;
- `bookings_snapshot.property_id`, `menage_events.property_id`, `menage_comments.property_id`,
  `menage_done`, `property_status`, `public_tokens.property_ids` = TEXT = provider_property_id.

Ce n'est PAS la faille décrite dans la spec (« les biens Channex n'ont pas de propId Beds24 ») :
les biens Channex ont bien un provider_property_id (UUID Channex) et la clé est universelle.
Mais si les nouvelles tables (`ota_reviews`, `cleaning_providers`, `property_cleaning_providers`)
référencent `properties.id` UUID comme le demandent les specs, toute jointure vers
menage_events / bookings_snapshot devra transiter par properties (UUID → provider_property_id).
**Décision produit à prendre avant l'étape 1** : suivre la convention existante (TEXT) ou
introduire l'UUID et payer le pont sur chaque jointure.

## C. Non vérifié (nécessite un accès base)
- Contenu réel des colonnes property_id en prod (types déduits du code seulement).
- Comparaison côte à côte d'une résa Beds24 et d'une résa Channex réelles.
- Existence effective de lignes bookings_snapshot restées au schéma pauvre (E3).
