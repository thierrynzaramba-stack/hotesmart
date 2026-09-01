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

### Tables à `user_id` — soumises aux nouvelles politiques (29)

| # | Table | Domaine | `property_id` | Lignes |
|---|---|---|---|---|
| 1 | `bookings_snapshot` | reservations | TEXT | 180 |
| 2 | `booking_change_events` | reservations | TEXT | 1 |
| 3 | `access_codes` | reservations | TEXT | 109 |
| 4 | `property_locks` | reservations | TEXT | 2 |
| 5 | `locks` | reservations | absent | 3 |
| 5b | `lock_alert_config` | reservations | absent (clé `lock_id`) | 3 |
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

### Tables sans `user_id` — hors périmètre RLS par compte (9)

| Table | Nature | `property_id` |
|---|---|---|
| `calendar_inventory` | inventaire tarifaire, 1172 lignes | **UUID** |
| `property_channel_rate_plans` | réglages canal par bien | **UUID** |
| `channel_sync_queue` | file technique | absent |
| `availability_push_log` | déduplication technique | absent |
| `cron_logs` | horodatage des cycles | absent |
| `kb_question_templates` | référentiel global | absent |
| `app_logs` | journal applicatif, 0 ligne | absent |
| `locks_with_alert_config` | **vue** (jointure locks + config) | absent |
| `profiles_legacy` | ancienne table, conservée, plus lue | absent |

Les trois premières sont rattachées à un bien : elles devront être protégées **par
jointure** sur `properties.user_id`, pas par `can_read(user_id, …)`. Les trois
dernières sont des tables techniques sans donnée client.

**38 tables au total, 29 à `user_id`.**

⚠️ **Le premier inventaire en annonçait 34 et il était faux.** Il partait des tables
citées dans le code (`grep from('...')`) : une table présente en base mais qu'aucun
code ne lit y était **structurellement invisible** — précisément le cas d'une table
abandonnée. C'est ainsi que `profiles` a été manquée, et que la migration de
l'étape 1 a échoué en tentant de la créer.

`scripts/inventaire-tables.js` corrige la méthode : il interroge le descripteur
OpenAPI de PostgREST (`GET /rest/v1/`), qui expose **tout** le schéma public.
Quatre tables sont ainsi apparues : `profiles` (l'ancienne), `app_logs`,
`lock_alert_config` (à `user_id`, donc dans le périmètre) et la vue
`locks_with_alert_config`.

**Leçon** : inventorier une base depuis le code renseigne sur ce que le code
connaît, pas sur ce que la base contient.

## 2. Deux anomalies à traiter avant les politiques

**`knowledge`** — 5 valeurs distinctes de `property_id` : 2 `provider_property_id`
et **3 UUID orphelins** (ni `properties.id` ni `provider_property_id` actuels).
L'interface n'écrit pas cette clé de façon homogène selon le parcours. Conséquence
déjà constatée : les placeholders `{checkin}` / `{telephone_hote}` restaient vides
pour les biens concernés (contourné dans `lib/cleaning/sync-menages.js`, qui
interroge les deux clés).

**`messages`** — 3 `provider_property_id` et **1 UUID orphelin** sur 773 lignes.

Valeurs exactes relevées le 1er septembre 2026 :

| Table | `property_id` orphelin | Lignes | Nature |
|---|---|---|---|
| `knowledge` | `1a2cfd91-f501-4b0e-83ef-0598a0c921b2` | 6 | UUID |
| `knowledge` | `90e2986f-0fb8-4783-9566-92941d1c1bba` | 6 | UUID |
| `knowledge` | `33494dd7-e309-450e-9892-48761084c5a8` | 7 | UUID |
| `messages` | `429f043c-f927-41af-b874-3b9b07cca15a` | 1 | UUID |

Les 19 lignes de `knowledge` portent des clés `fixed` (`adresse`,
`telephone_hote`…) : ce sont des fiches de connaissance rattachées à des biens qui
n'existent plus, ou saisies sous un identifiant qui a changé depuis.

Ces valeurs viennent probablement de biens supprimés. Tant qu'elles existent, une
politique `in_scope` les rejettera — comportement sûr, mais il faut le savoir avant
de conclure à un bug de droits. **À trancher séparément** : purger ces lignes, ou
les rattacher si le bien correspondant est identifiable.

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

## 4. Décisions prises (validées le 1er septembre 2026)

- **`requires_ack`** → porté par `property_cleaning_providers`, donc réglable **par
  bien** plutôt que globalement par prestataire.
- **`public_tokens`** → conservée **en lecture** pendant ce chantier.
  `profiles.pwa_token` devient la source ; suppression dans un commit ultérieur.
  Le token en circulation n'est pas régénéré : la migration le reprend tel quel.
- **`properties`** → politique dédiée : **lecture** si le bien est dans le
  périmètre du profil, **écriture** si `reglages = 'write'`. Sans cela, aucune page
  ne pourrait afficher un nom de bien.
- **Pont TEXT/UUID** → dualité `property_ids` / `property_refs` avec trigger.

## 5. Étape 1 — structures livrées

`migrations/2026-09-01-profils-et-droits-structures.sql` :
tables `profiles` et `profile_permissions`, fonctions `perm_level`, `in_scope`
(deux variantes), `can_read` et `can_write` (trois variantes chacune), index,
triggers de resynchronisation, profil titulaire pour chaque compte, profils `lien`
pour les prestataires existants.

**Aucune politique des 29 tables existantes n'est modifiée.** Attention à la
nuance : un **trigger** est posé sur `properties`, qui s'exécute donc à chaque
écriture de cette table. « Impact zéro » vaut pour les politiques, pas pour les
triggers.

**Exécutée en production le 1er septembre 2026.** Résultat vérifié : 5 profils
titulaires, 1 profil `lien` (Régina, token conservé, périmètre résolu en 2 UUID et
2 refs par le trigger du pont).

Trois éléments ont été ajoutés au fil de l'exécution et **réintégrés au fichier**
pour qu'il reste la vérité :

- **`alter table profiles rename to profiles_legacy`** — l'ancienne table
  (`id, email, full_name, plan`) occupait le nom. Aucun code ne la lisait ; la
  facturation vit dans `accounts` et `subscriptions`. Renommée, pas supprimée :
  ses 5 lignes sont conservées.
- **`handle_new_user()` réécrite** pour créer le profil titulaire **et** sa ligne
  de permissions à chaque inscription. Sans elle, un nouvel inscrit garderait ses
  droits (`perm_level` court-circuite pour le titulaire) mais serait absent de la
  page Équipe et sans identité dans les journaux.
- **Le trigger `on_auth_user_created` reste en place** : seule la fonction qu'il
  appelle est redéfinie.

⚠️ La version de `handle_new_user()` inscrite dans le fichier est **reconstruite**,
pas copiée depuis la base. Si celle en place fait autre chose en plus (email,
ligne `accounts`…), **fusionner avant de rejouer** : `create or replace` écrase
sans prévenir. Pour la lire :
`select prosrc from pg_proc where proname = 'handle_new_user';`

Deux points de mise en œuvre qui méritent d'être connus :

**Trois variantes explicites de `can_read`/`can_write`**, pas un paramètre par
défaut. `can_read(user_id, 'domaine', null)` serait **ambigu** entre la surcharge
`uuid` et la surcharge `text`, et PostgreSQL refuserait l'appel — au moment
d'écrire une politique, pas au moment de la tester.

**RLS activée dès la création** sur `profiles` et `profile_permissions`. « Aucune
politique modifiée » vaut pour les tables existantes ; ces deux-là naissent
protégées, sinon elles seraient lisibles par tout porteur de l'anon key.

### Pièges corrigés à l'étape 1 (relevés en revue)

- **`NEW` n'existe pas en `DELETE`.** Le trigger sur `properties` utilisait
  `coalesce(new.user_id, old.user_id)` : PL/pgSQL lève « record new is not assigned
  yet » et **annule la transaction**. Toute suppression de bien aurait échoué.
  Utiliser `TG_OP` pour choisir la ligne. Corollaire à retenir : ce trigger
  s'exécute sur **chaque écriture de `properties`** — « impact zéro » ne vaut que
  pour les *politiques*, pas pour les triggers.
- **Escalade de privilèges.** `account_user_id` est une colonne librement fixée par
  l'insérant : une policy qui ne vérifie qu'elle laisse un membre créer une ligne de
  permissions pointant son profil **sur le compte d'un autre**, en mettant son
  propre uid dans `account_user_id`. La policy exige donc que le profil visé
  appartienne au compte de l'appelant, et les jointures de `perm_level`/`in_scope`
  exigent `p.account_user_id = pr.account_user_id`.
- **Colonnes mixtes.** `in_scope(uuid, text)` compare aussi à `property_ids` :
  `knowledge` et `messages` portent tantôt le `provider_property_id`, tantôt l'UUID.
  Ne comparer qu'à `property_refs` masquerait des lignes légitimes.
- **Périmètre d'un prestataire migré.** Si `public_tokens.property_ids` est non vide
  mais qu'aucun identifiant ne résout, on bascule sur `'all'` plutôt que de produire
  un `'selected'` vide — un prestataire coupé de tous ses ménages est pire qu'un
  périmètre temporairement large, d'autant qu'il ne voit que **ses** ménages via son
  token. Une requête de contrôle (§6 de la migration) signale l'écart.
- **`refs_depuis_ids`** est `security definer` : `revoke` pour les clients, les
  triggers s'exécutant en `definer`.
- **`search_path`** posé sur les six variantes de `can_read`/`can_write`, comme sur
  les fonctions qu'elles appellent.

`lib/permissions.js` est le **miroir JS** de ces fonctions, pour les endpoints
serverless : ils écrivent en service key, qui contourne la RLS, et doivent donc
vérifier les droits eux-mêmes. Module non branché à cette étape (câblage = étape 3),
mais testé — sa sémantique doit rester strictement alignée sur le SQL.

## 6. Points restant à trancher

**Les 4 valeurs orphelines** de `knowledge` et `messages` (§2) : purger ou
rattacher, avant que les politiques ne les rendent invisibles.

**`agent_prompting`** est vide : son `property_id` n'a pu être typé par les
valeurs. À confirmer au moment d'écrire sa politique.
