# KB — Profils et droits : étape 0 (livrable préalable)

<!-- SOURCES (mapping inverse). ⚠️ DOC en tête de ces fichiers pointe ici. Modif = MÊME COMMIT. -->
> Sources : `docs/specs/spec-profils-et-droits.md` (spec de référence),
> `docs/specs/spec-prestataires-menage.md` (révisée par la précédente).
>
> Mots-clés routage chat : droits, profil, équipe, permission, accès, employé,
> propriétaire, prestataire, RLS.

**Statut : en attente de validation.** Rien n'est codé ni migré.

## 1. Inventaire des tables

Relevé **sur la base de production**, pas sur le code : chaque valeur de
`property_id` a été comparée à `properties.id` (UUID) et à
`properties.provider_property_id` (TEXT), sur la totalité des lignes.

### Tables à `user_id` — soumises aux nouvelles politiques (28)

| # | Table | Domaine | `property_id` | Lignes |
|---|---|---|---|---|
| 1 | `bookings_snapshot` | reservations | TEXT | 180 |
| 2 | `booking_change_events` | reservations | TEXT | 1 |
| 3 | `access_codes` | reservations | TEXT | 109 |
| 4 | `property_locks` | reservations | TEXT | 2 |
| 5 | `locks` | reservations | absent | 3 |
| 6 | `property_status` | menages | TEXT | 2 |
| 7 | `menage_events` | menages | TEXT | 167 |
| 8 | `menage_done` | menages | TEXT | 116 |
| 9 | `menage_comments` | menages | TEXT | 5 |
| 10 | `public_tokens` | prestataires | absent | 1 |
| 11 | `messages` | messages | TEXT ⚠️ mixte | 773 |
| 12 | `conversations` | messages | TEXT | 860 |
| 13 | `message_templates` | messages | TEXT | 9 |
| 14 | `message_sent_log` | messages | absent | 588 |
| 15 | `sms_logs` | messages | TEXT | 216 |
| 16 | `agent_tasks` | messages | TEXT | 334 |
| 17 | `conversation_flags` | messages | absent | 1 |
| 18 | `agent_prompting` | reglages | présent, table vide | 1 |
| 19 | `knowledge` | reglages | TEXT ⚠️ mixte | 62 |
| 20 | `properties` | reglages | absent (c'est la table des biens) | 4 |
| 21 | `api_keys` | reglages | absent | 1 |
| 22 | `agent_alert_config` | reglages | absent | 1 |
| 23 | `onboarding_state` | reglages | absent | 3 |
| 24 | `automation_incidents` | reglages | TEXT | 12 |
| 25 | `integration_requests` | reglages | absent | 1 |
| 26 | `airbnb_connect_sessions` | reglages | **UUID** | 2 |
| 27 | `accounts` | facturation | absent | 1 |
| 28 | `subscriptions` | facturation | absent | 2 |

### Tables sans `user_id` — hors périmètre RLS par compte (6)

| Table | Nature | `property_id` |
|---|---|---|
| `calendar_inventory` | inventaire tarifaire, 1172 lignes | **UUID** |
| `property_channel_rate_plans` | réglages canal par bien | **UUID** |
| `channel_sync_queue` | file technique | absent |
| `availability_push_log` | déduplication technique | absent |
| `cron_logs` | horodatage des cycles | absent |
| `kb_question_templates` | référentiel global | absent |

Les trois premières sont rattachées à un bien : elles devront être protégées **par
jointure** sur `properties.user_id`, pas par `can_read(user_id, …)`. Les trois
dernières sont des tables techniques sans donnée client.

**34 tables au total, 28 à `user_id`** — la spec en annonçait 27. L'écart vient de
`booking_change_events`, créée pendant le chantier d'unification.

## 2. Deux anomalies à traiter avant les politiques

**`knowledge`** — 5 valeurs distinctes de `property_id` : 2 `provider_property_id`
et **3 UUID orphelins** (ni `properties.id` ni `provider_property_id` actuels).
L'interface n'écrit pas cette clé de façon homogène selon le parcours. Conséquence
déjà constatée : les placeholders `{checkin}` / `{telephone_hote}` restaient vides
pour les biens concernés (contourné dans `lib/cleaning/sync-menages.js`, qui
interroge les deux clés).

**`messages`** — 3 `provider_property_id` et **1 UUID orphelin** sur 773 lignes.

Ces valeurs orphelines viennent probablement de biens supprimés. Tant qu'elles
existent, une politique `in_scope` les rejettera — ce qui est le comportement sûr,
mais il faut le savoir avant de conclure à un bug de droits.

## 3. Le pont TEXT / UUID — choix proposé

**Option retenue : stocker les deux identifiants dans `profile_permissions`, avec
resynchronisation automatique.**

```sql
property_ids  uuid[],   -- source de vérité : properties.id, stable
property_refs text[],   -- dénormalisation : provider_property_id, maintenue par trigger
```

`in_scope` compare `row_property_id = any(property_refs)` pour les tables TEXT,
`= any(property_ids)` pour les tables UUID. Aucune sous-requête, aucune jointure :
une comparaison de tableau en mémoire, par ligne.

**Pourquoi pas la résolution via `properties` dans `in_scope`.** C'est l'autre
option de la spec. Elle est plus simple à écrire, mais la fonction reçoit un
argument qui **change à chaque ligne** (`row_property_ref`) : PostgreSQL ne peut
pas mémoïser, et exécute donc une sous-requête **par ligne évaluée**. Sur
`conversations` (860 lignes) ou `calendar_inventory` (1172), chaque lecture
paierait autant de lookups. Le critère posé par la spec — « une seule requête RLS,
pas de sous-requête coûteuse par ligne » — l'exclut.

**Pourquoi le trigger n'est pas optionnel.** Une dénormalisation nue périmerait en
silence : `provider_property_id` **n'est pas stable** — c'est précisément la raison
pour laquelle les nouvelles tables métier utilisent `properties.id` (écart E6 de
l'audit d'unification). Un bien qui migre de Beds24 vers Channex change de
`provider_property_id` ; sans resynchronisation, un membre perdrait l'accès à un
bien autorisé, ou pire, conserverait un accès sur un identifiant réattribué.

```sql
-- Resynchronise property_refs quand un bien change d'identifiant provider,
-- est créé, ou disparaît. Sans lui, les droits périment en silence.
create or replace function sync_property_refs() returns trigger ...
create trigger properties_sync_refs
  after insert or update of provider_property_id or delete on properties
  for each row execute function sync_property_refs();
```

**Index requis** dans les deux cas, pour la résolution à l'attribution et pour le
trigger : `create index on properties (user_id, provider_property_id);`

**Conséquence pratique** : l'interface d'attribution des droits manipule des UUID
(stables, lisibles dans l'URL d'un bien) ; `property_refs` est un détail
d'implémentation que personne ne saisit à la main.

## 4. Points à trancher avec le livrable

**`requires_ack`** (spec prestataires) n'a plus de table où vivre. Il ne relève pas
de l'identité du prestataire mais du mode d'assignation : je propose de le porter
sur `property_cleaning_providers`, ce qui le rend réglable **par bien** — plus fin
que l'actuel réglage global par prestataire.

**`public_tokens`** (domaine `prestataires`) devient redondante avec
`profiles.pwa_token`. À migrer puis retirer, ou à conserver le temps de la
transition ? Elle est lue par `api/menages-public.js` et par la sonde d'événements.

**`properties`** est classée en `reglages`, mais elle porte le périmètre lui-même :
un membre doit pouvoir **lire** les biens de son périmètre quel que soit son droit
sur `reglages`, sinon aucune page ne peut afficher un nom de bien. Je propose une
politique dédiée : lecture si le bien est dans le périmètre, écriture si
`reglages = 'write'`.
