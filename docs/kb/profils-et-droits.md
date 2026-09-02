# KB — Profils et droits (étapes 0 à 2 terminées)

<!-- SOURCES (mapping inverse). ⚠️ DOC en tête de ces fichiers pointe ici. Modif = MÊME COMMIT. -->
> Sources : `docs/specs/spec-profils-et-droits.md` (spec de référence),
> `docs/specs/spec-prestataires-menage.md` (révisée par la précédente).
>
> Mots-clés routage chat : droits, profil, équipe, permission, accès, employé,
> propriétaire, prestataire, RLS.

**Statut : étapes 0, 1 et 2 appliquées en production.** Les 30 tables sont
protégées par le modèle de profils. Reste : étapes 3 à 6 (endpoints, page Équipe,
sélecteur de compte, fiche prestataire).

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

## 5 ter. Étape 2 — lots 1 à 4 appliqués

| Lot | Tables | Vérifié |
|---|---|---|
| 1 | `automation_incidents`, `integration_requests`, `onboarding_state`, `agent_prompting`, `conversation_flags` | 10/10 |
| 2 | `sms_logs`, `message_sent_log`, `agent_tasks`, `menage_comments`, `menage_done` | 10/10 |
| 3 | `menage_events`, `property_status`, `public_tokens`, `locks`, `lock_alert_config` | 10/10 |
| 4 | `messages`, `conversations`, `message_templates`, `knowledge` | 8/8 |

Chaque lot purge les anciennes politiques `user_id = auth.uid()` avant de poser
les siennes : PostgreSQL combine les politiques permissives en **OU**, une seule
survivante rendrait le périmètre inopérant.

Le lot 4 a été éprouvé par **bascule temporaire** du compte test à
`messages = read` / `reglages = read`, puis retour à `none` :

| | bascule active | bascule annulée |
|---|---|---|
| `messages` | 465 / 773 | 0 |
| `conversations` | 499 / 860 | 0 |
| `message_templates` | 5 / 9 | 0 |
| `knowledge` | 18 / 62 | 0 |

Sans cette bascule, le test aurait été vert **sans rien prouver** : les deux
domaines étaient à `none`, donc tout invisible de toute façon. À retenir pour les
lots suivants — un test entièrement négatif ne démontre que l'absence de
régression.

### ⚠️ La branche UUID de `in_scope(uuid, text)` n'est pas couverte en base

`in_scope(uuid, text)` compare la référence à `property_refs` **et** à
`property_ids`, pour les colonnes mixtes. Or **aucune ligne réelle ne porte l'UUID
d'un bien existant** : les seules valeurs UUID de `knowledge` sont les trois
orphelines, rattachées à des biens disparus.

Cette branche n'est donc couverte que par les tests unitaires de
`lib/permissions.js`. Aucune conséquence pratique tant que rien n'écrit l'UUID —
mais voir ci-dessous.

### ⚠️ La cause des orphelines est TOUJOURS ACTIVE (vérifié par grep)

La parade de fond serait qu'aucun parcours n'écrive l'UUID dans `knowledge`.
**Ce n'est pas le cas aujourd'hui.**

`apps/agent-ai/knowledge.html` prend sa clé dans `properties[].id` renvoyé par
`/api/channel-property`. (`analyze.html` présente le même motif mais lit
`/api/beds24`, dont l'`id` est déjà le propId : elle n'écrivait pas d'UUID —
vérification faite après coup, l'affirmation initiale était trop large.) Or cet endpoint
expose, pour un bien **Channex**, l'`id` de la table `properties` — l'UUID — alors
que pour un bien **Beds24** il expose le `provider_property_id`
(`api/channel-property.js:139-142`). Ces deux pages écrivent donc l'UUID pour tout
bien Channex.

Deux parcours écrivent correctement : `pages/onboarding.html`
(`provider_property_id || p.id`) et `apps/agent-ai/messagerie.html` (commentaire
explicite : « propId = provider_property_id, pas l'UUID Supabase »).

**Conséquence** : toute connaissance saisie depuis la page Connaissances ou depuis
Analyse, sur un bien Channex, est écrite sous une clé que le reste du code ne lit
pas — et devient invisible aux membres une fois les politiques posées. C'est un
bug **antérieur** au chantier des droits, que celui-ci rend simplement visible.

**CORRIGÉ** (chantier knowledge, 2 septembre 2026) : `knowledge.html` normalise
désormais sa clé à la lecture (`analyze.html` porte le même garde-fou, inerte pour
elle)
(`p.provider_property_id || p.id`), comme `messages.html` et `config.html`. Voir
`REVIEW.md` §10.

**Diagnostic des orphelines** (`scripts/diagnostic-orphelines.js`) : les quatre
valeurs correspondent à des biens **supprimés**, aucune n'est rattachable à un
bien existant.

| Table | `property_id` | Lignes | Verdict |
|---|---|---|---|
| `knowledge` | `1a2cfd91-f501-4b0e-83ef-0598a0c921b2` | 6 | bien supprimé |
| `knowledge` | `90e2986f-0fb8-4783-9566-92941d1c1bba` | 6 | bien supprimé |
| `knowledge` | `33494dd7-e309-450e-9892-48761084c5a8` | 7 | bien supprimé |
| `messages` | `429f043c-f927-41af-b874-3b9b07cca15a` | 1 | bien supprimé |

**PURGÉES le 2 septembre 2026** (`scripts/purge-orphelines.js`) : comptage à blanc
20, `--apply` 20 supprimées 0 échec, second comptage 0. `knowledge` passe de 63 à
44 lignes (26 pour coeur de vie 23, 18 pour La bulle), et plus aucune valeur de
`property_id` inconnue ne subsiste dans les 16 tables enfants examinées.

### ⚠️ Dette : `analyze.html` est mono-provider

Même famille que l'écart **E1** du planning ménage. `apps/agent-ai/analyze.html`
lit `/api/beds24 getProperties` : pour un hôte 100 % channel, l'endpoint répond
`400 « Clé Beds24 non configurée »`, `data.properties` est `undefined` et la page
Analyse affiche une liste vide — elle ne fonctionne pas du tout.

À traiter **avant la bêta** : bascule sur `/api/channel-property` (ou
`shared/properties.js`), comme l'ont été le planning ménage et la page
Prestataires.

C'est aussi ce qui a corrigé un diagnostic trop large de ma part : cette page
présentait le même motif de code que `knowledge.html`, mais lit une **autre
source** — son `id` est déjà le propId, elle n'a jamais écrit d'UUID.

**Chantier knowledge clos.** La cause est corrigée (normalisation de la clé dans
les quatre pages), la règle est écrite (`REVIEW.md` §10), les résidus sont
supprimés.

À noter : les deux biens Channex actuels (`colomier`, `Colomiers`) n'ont **aucune
connaissance** enregistrée, ni sous UUID ni sous `provider_property_id`. Le bug
était donc réel mais n'a lésé aucune donnée vivante — il aurait frappé à la
première saisie.

## 5 quater. Étape 2 TERMINÉE — les 30 tables

| Lot | Tables | Test |
|---|---|---|
| 1 | `automation_incidents`, `integration_requests`, `onboarding_state`, `agent_prompting`, `conversation_flags` | 10/10 |
| 2 | `sms_logs`, `message_sent_log`, `agent_tasks`, `menage_comments`, `menage_done` | 10/10 |
| 3 | `menage_events`, `property_status`, `public_tokens`, `locks`, `lock_alert_config` | 10/10 |
| 4 | `messages`, `conversations`, `message_templates`, `knowledge` | 8/8 (par bascule) |
| 5 | `bookings_snapshot`, `booking_change_events`, `access_codes`, `property_locks`, `airbnb_connect_sessions` | 10/10 |
| 6 | `properties`, `api_keys`, `app_logs`, `agent_alert_config`, `accounts`, `subscriptions` | 12/12 |

**30 tables**, toutes protégées. Le contrôle final ne renvoie que `api_keys`,
`app_logs` et `properties` — les trois politiques dédiées, qui n'utilisent pas
`can_read` par construction.

### Les trois politiques dédiées

- **`properties`** — lecture par le **périmètre seul**, sans condition de domaine.
  Elle porte le périmètre lui-même : sans cela, aucune page n'afficherait de nom
  de bien. Écriture : `reglages = write` + bien dans le périmètre.
- **`api_keys`** — **titulaire seul**. Clés Beds24, Seam et Brevo en clair : des
  identifiants d'accès, pas des réglages.
- **`app_logs`** — **titulaire seul**. Journal d'audit, `data` jsonb libre.

### `booking_change_events` : lecture seule côté client

Aucune politique d'écriture pour `authenticated`. `booking_id` et `property_id` y
sont libres, et le dispatcher consomme la file en service key : un membre pouvant
y insérer ferait annuler le code d'accès du voyageur d'un autre bien. Cette table
a donc **1** politique, pas 2.

### Effet mesuré (compte test : un bien, `reservations`/`menages` en lecture)

```
bookings_snapshot   90 / 180      menage_events    90 / 167
menage_done         68 / 116      access_codes     15 / 109
properties           1 bien du compte prod (La bulle) + le sien
api_keys, app_logs, accounts, subscriptions, locks, public_tokens : invisibles
aucune écriture acceptée, sur aucune table
```

Le cron n'est pas affecté : il écrit en service key. Cycles vérifiés après les
lots 5 et 6 — 27 à 37 s, terminés, sans erreur.

### Ce que le dispositif de test a appris

`scripts/test-droits.js` a dû être corrigé **quatre fois**, et chaque correction
portait sur une manière de conclure juste pour une mauvaise raison :

1. il écrivait au nom du testeur — écriture légitime, qui passait et polluait la
   base (→ `REVIEW.md` §9) ;
2. il comptait les lignes propres du testeur comme des fuites ;
3. il lisait un `count` avec `head:true` après un `update` : PostgREST répond 200
   sans erreur et le count vaut `null`, pas `0` — il concluait « écriture
   acceptée » alors que rien n'était écrit ;
4. il traitait `properties` comme un domaine ordinaire, alors que sa politique est
   au périmètre seul, et cherchait un `property_id` sur une table dont
   l'identifiant est la clé primaire.

Les droits attendus sont désormais **lus en base**, jamais codés en dur : une
bascule de configuration change l'attendu du test, au lieu de le contredire.

## 5 quinquies. Étape 3 — endpoints serverless (en cours)

Les endpoints écrivent en **service key**, qui contourne la RLS : les politiques
de l'étape 2 ne protègent que les accès directs depuis le navigateur. Chaque
endpoint agissant au nom d'un utilisateur doit donc vérifier lui-même, via
`lib/require-permission.js` — garde unique, jamais de vérification ad hoc.

**État : 9 endpoints sur 26 · 3 fuites fermées · 2 régressions introduites puis
corrigées (toutes deux vues par la review, aucune poussée pour la seconde).**

| Endpoint | Domaine | Constat |
|---|---|---|
| `diagnostic.js` | reglages / titulaire | **FUITE** — `property_id` client non vérifié : lecture des canaux OTA de n'importe quel bien. Et `check=channel` renvoyait les identifiants de biens d'autres clients. |
| `channel-message.js` | messages / write | **FUITE** — `bookingId` client non vérifié : envoi d'un message au voyageur de n'importe quelle réservation, en son nom. |
| `sms.js` | messages / write | Pas de fuite. `property_id` client non validé (traçabilité faussée) ; garde rendue inconditionnelle. |
| `channel-property.js` | reglages / write | Pas de fuite (filtrait déjà `user_id`), mais aucun droit de domaine. Garde sur PATCH/DELETE/POST. |

**Régression introduite puis corrigée** : `resoudreBien` interrogeait `id.eq.<v>`
sur une colonne de type **uuid**. Avec un propId Beds24, Postgres renvoie une
*erreur*, pas un résultat vide — l'envoi de SMS a été cassé une vingtaine de
minutes. Les doubles de test utilisaient `'uuid-bulle'` comme `properties.id` :
une valeur qui n'est pas un UUID masquait exactement ce piège (`REVIEW.md` §8).

**Groupe 1 (domaine `reglages`)** : `agent-config`, `alert-test`, `beds24-setup`,
`channel-connect`, `channel-token`.

**TROISIÈME FUITE, la plus grave** — `agent-config.js` décodait le `user_id`
depuis le JWT **sans vérifier la signature**. Un JWT est en base64, pas chiffré :
forger `xxx.<sub de la cible>.yyy` suffisait à lire **et écrire** la configuration
d'alertes de n'importe quel compte, donc à en rediriger les destinataires. Le
commentaire invoquait « même pattern que `cron.js` » — faux, `cron.js` utilise
`CRON_SECRET`. Seul endroit du repo dans ce cas (vérifié par grep).

### ⚠️ Portée réelle de la garde sans ressource désignée

Sur `agent-config`, `alert-test` et `beds24-setup`, **aucun bien n'est désigné** :
le compte cible est donc celui de l'appelant, dont il est titulaire par
définition. La garde n'y filtre **que la session** — elle ne « réserve au
titulaire » rien du tout, et le cloisonnement par domaine n'y prendra effet
qu'avec le **sélecteur de compte** (étape 5).

Ce n'est pas un défaut : toutes les écritures de ces endpoints portent déjà sur
le compte de l'appelant. Mais il ne faut pas lire ces gardes comme une protection
qu'elles n'apportent pas. C'est écrit dans chaque fichier concerné.

### ⚠️ Dette : `alert-test` — `to` non contraint

Tout utilisateur authentifié peut faire partir un SMS (sa clé Brevo) ou un email
(**clé plateforme**) vers un destinataire arbitraire. Le correctif est une limite
de débit et/ou une contrainte sur `to` — ce n'est pas un problème de droits, à
traiter séparément.

### ⚠️ Dette : `channel-airbnb-connect` incohérent

Il filtre encore `.eq('user_id', user.id)` sans passer par la garde. Depuis que
`channel-connect` accepte la délégation, un membre délégué peut ouvrir l'iframe du
bien du titulaire mais recevra un **404** sur `channel-airbnb-connect` pour ce même
bien. Parcours OTA incohérent, à traiter dans le groupe suivant.

**Reste 21 endpoints**, à traiter par groupes de 5, review lue **avant** chaque
push (`CLAUDE.md`, règle absolue).

### ⚠️ Dette : `apps/sms` n'est pas dans le menu

L'application SMS existe (`apps/sms/index.html`, endpoint `api/sms.js`,
227 lignes dans `sms_logs`) mais n'est déclarée ni dans `shared/config.js`, ni
dans `components/sidebar.js` : elle n'est atteignable que par URL directe. À
trancher — l'exposer dans le menu, ou la retirer si elle n'a plus d'usage.

## 6. Points restant à trancher

**Les 4 valeurs orphelines** de `knowledge` et `messages` (§2) : purger ou
rattacher, avant que les politiques ne les rendent invisibles.

**`agent_prompting`** est vide : son `property_id` n'a pu être typé par les
valeurs. À confirmer au moment d'écrire sa politique.

## 7. Étape 3 — état du câblage de la garde

### Endpoints traités : 19 / 26

- **Groupe 1** (`reglages`) : `agent-config`, `alert-test`, `beds24-setup`,
  `channel-connect`, `channel-token`
- **Groupe 2** (`reglages`, canaux) : `channel-mapping`, `channel-airbnb-connect`,
  `channel-bcom`, `channel-bcom-write`, `channel-bcom-activate`
- **Groupe 3** (prix, disponibilités, messages) : `channel-rateplan`, `calendar`,
  `channel-import-messages`, `messages`, `beds24`
- Plus les quatre premiers, hors groupe : `diagnostic`, `channel-message`, `sms`,
  `channel-property`

**Reste 7 endpoints.**

### ⚠️ Divergence assumée : `property_id` NULL dans un filtre de collection

`in_scope` (SQL) et `dansPerimetre` (JS) considèrent qu'une donnée **sans bien**
est toujours dans le périmètre. `filtrePerimetreSql`, lui, **exclut** les lignes à
`property_id` NULL par défaut.

**Pourquoi.** La règle « donnée sans bien = dans le périmètre » vaut pour une
donnée de **compte**. Elle ne vaut pas pour une **collection de données
voyageur** : `messages.property_id` peut être NULL par simple défaut de
rattachement, et inclure ce cas montrerait à un membre limité au bien A les
conversations des biens B et C. L'alignement propagerait ici une permissivité, il
ne la justifie pas.

Un appelant dont les lignes sans bien sont légitimement communes au compte passe
`inclureSansBien = true` explicitement. Aujourd'hui `api/messages.js` est le seul
consommateur, et il prend le défaut.

### ⚠️ Câblage inerte jusqu'au sélecteur de compte (étape 5)

`api/messages.js` est un endpoint de **collection** : aucun identifiant client, donc
aucune ressource ne désigne un compte, donc le compte cible est celui de
l'appelant — qui en est titulaire par définition. La garde de domaine et le filtre
de périmètre y sont donc **inertes**. Conséquence fonctionnelle, pas sécuritaire :
un membre invité ne voit pas la messagerie du compte auquel il appartient, il voit
la sienne (vide). Même limite sur le repli `sendMessage` de `api/beds24.js` sans
bien ni réservation : la clé Beds24 cherchée est celle de l'appelant.

La couverture de tests porte donc sur `lib/permissions` (`refsDuPerimetre`,
`filtrePerimetreSql`), pas sur l'endpoint : un vert d'endpoint ne prouverait rien.

### Règle de partage des domaines dans `api/calendar.js`

Ce qui s'écrit dans `calendar_inventory` et se pousse en ARI (tarif du jour,
disponibilité, séjour minimum, `fullsync`) relève de **`reservations`** — c'est le
métier du calendrier. Ce qui s'écrit dans `properties` relève de **`reglages`** —
c'est la configuration du bien (prix par personne, autofix des nuits orphelines),
gardée par ce même domaine ailleurs. Un membre peut donc tenir le calendrier sans
pouvoir reconfigurer le bien.

### ⚠️ Dette : `analyze.html` mono-provider

La page lit `/api/beds24 getProperties`. Pour un hôte 100 % channel, elle répond
400 « Clé Beds24 non configurée » et la liste des biens reste vide. Même nature que
l'écart E1 du planning ménage. À traiter avant la bêta.

## 8. Étape 3 terminée — 26 / 26 endpoints

### Groupe final (7)

`grok`, `serrures`, `stripe`, `property-automation`, `simulate`, `extract-kb`,
`menages`.

### ⚠️ Deux fuites de clé plateforme, fermées

**`api/grok.js` n'avait aucune authentification.** N'importe qui sur Internet
pouvait poster et consommer la clé Claude de la plateforme : relais IA gratuit,
facturé au compte HôteSmart. Les quatre appelants envoyaient déjà le jeton — la
garde n'a cassé aucun parcours. Taille de requête bornée (40 messages,
200 000 caractères, calibrés sur `analyze.html` qui inline jusqu'à
50 conversations).

**`getSeamKey` retombait sur `SEAM_API_KEY`.** Un hôte sans clé Seam propre
empruntait celle de la plateforme — donc le **même compte Seam** que tous les
autres hôtes dans ce cas : `devices/list` leur listait les serrures les uns des
autres, `access_codes/delete` acceptait n'importe quel `code_id`. Le repli est
retiré pour un compte identifié ; il ne survit que pour `!userId` (appel interne
sans compte). Il y avait **deux copies** de `getSeamKey` — `api/serrures.js`
utilise désormais celle de `lib/providers/seam.js`.

**Vérifié avant de retirer le repli** : une seule ligne `api_keys` en base, et
elle porte sa propre clé Seam. Aucun compte de production ne dépendait de la clé
d'environnement.

Contrepartie : un compte mal configuré n'a plus de repli silencieux. Le cron
(`lib/cron-arrival-code.js`) lève désormais un incident `seam_key_missing` au
lieu d'un simple `console.warn` — sans quoi la ligne `access_codes` restait
`pending` indéfiniment, sans PIN et sans que personne soit prévenu.

### `provider_property_id` n'est pas unique entre comptes

`resoudreBien` interrogeait la branche TEXTE avec `.maybeSingle()`. Deux hôtes
Beds24 peuvent porter le même `propId` : PostgREST répond alors `PGRST116`, que le
marqueur d'erreur transformait en **503 permanent**. La fonction lit maintenant
toutes les lignes et refuse explicitement l'ambiguïté (`{ ambigu: true }` → 409),
comme le fait déjà `resoudreBooking`.

### Domaines retenus pour le groupe final

| Endpoint | Domaine | Remarque |
|---|---|---|
| `grok` | session seule | pas de ressource, la garde est l'authentification |
| `serrures` | `reglages` (clé) / `reservations` (codes) | la clé du compte est ce qui borne réellement Seam |
| `stripe` | `facturation` | **non délégable** — la barrière de l'étape 5 |
| `property-automation` | `reglages` | bien résolu ; 409 « pas encore synchronisé » émis **après** la garde |
| `simulate` | `messages` | écrit le `provider_property_id` résolu |
| `extract-kb` | `reglages` | alimente la KB qui nourrit les réponses IA |
| `menages` | `menages` | collection + filtre de périmètre |

### ⚠️ Dette : `api_keys` est une table fourre-tout

Elle porte la clé Beds24 **et** la clé Seam, et n'est créée que par
`beds24-setup` et `sms`. `saveConfig` de `serrures` fait donc un `upsert` : sans
lui, un hôte Channex qui n'a jamais configuré le SMS n'aurait jamais pu
enregistrer sa serrure. À découper quand un troisième fournisseur s'ajoutera.

## 9. Étape 3 — CLOSE

**26 / 26 endpoints**, 10 fuites fermées, **316 tests** au vert. Déployé en
production le 1er septembre 2026 (`4c207a7`).

### Décompte des endpoints

| Groupe | Endpoints |
|---|---|
| Amorce | `diagnostic`, `channel-message`, `sms`, `channel-property` |
| 1 — réglages | `agent-config`, `alert-test`, `beds24-setup`, `channel-connect`, `channel-token` |
| 2 — canaux | `channel-mapping`, `channel-airbnb-connect`, `channel-bcom`, `channel-bcom-write`, `channel-bcom-activate` |
| 3 — prix, dispos, messages | `channel-rateplan`, `calendar`, `channel-import-messages`, `messages`, `beds24` |
| 4 — final | `grok`, `serrures`, `stripe`, `property-automation`, `simulate`, `extract-kb`, `menages` |

**Hors périmètre, à dessein** : `cron` (Bearer `CRON_SECRET`), `channel-webhook` et
`channel-events` (secret partagé), `menages-public` (jeton public), `manifest`,
`backfill-beds24-host`. Aucun n'agit au nom d'un utilisateur connecté.

### Les 10 fuites

**Entre comptes (8)**

1. `diagnostic` — `property_id` client non vérifié : lecture des canaux OTA de
   n'importe quel bien, et `property_ids` d'autres clients renvoyés
2. `channel-message` — `bookingId` non vérifié : message au voyageur de
   n'importe quelle réservation
3. `agent-config` — **JWT décodé sans vérification de signature** : usurpation
   d'identité complète
4. `channel-bcom-write` action `delete` — suppression de n'importe quel canal
5. `channel-mapping` — `channel_id` jamais validé
6. `channel-rateplan remap` — canal Booking.com d'un autre compte rebranché sur
   ses propres tarifs (`PUT /channels/:id`)
7. `channel-rateplan remap_airbnb` — mapping Airbnb d'autrui détruit
   (`DELETE` puis `POST`)
8. `beds24 getProperties` — un membre limité à un bien récupérait **tous** les
   biens Beds24 du propriétaire (aucun filtre en sortie)

Plus deux moindres : `channel-rateplan raw_channel` (mappings d'un autre compte)
et `inspect` (`rate_plan_id` non contrôlé).

**Clé plateforme (2)**

9. `alert-test` puis `grok` — relais ouverts sur les clés de la plateforme.
   `grok` n'avait **aucune authentification**
10. `getSeamKey` — repli sur `SEAM_API_KEY` : compte Seam partagé entre hôtes

### Trois régressions introduites par les correctifs eux-mêmes

Toutes trouvées par les reviews, aucune n'a survécu :

1. **Déployée en production ~20 min** : `resoudreBien` interrogeait
   `id.eq.<propId Beds24>` sur une colonne `uuid` → erreur Postgres, pas résultat
   vide → 404 → **l'envoi de SMS ne fonctionnait plus**. Origine de la règle
   absolue « aucun push tant qu'une review est en cours » (`CLAUDE.md`).
2. **Trou d'authentification dans `calendar`**, créé en retirant l'auth locale au
   profit de la garde : quand aucun identifiant ne se résolvait, la garde n'était
   jamais atteinte et la requête répondait 200 avec un jeton invalide.
3. **`saveConfig` des serrures rendu impossible** pour un hôte sans ligne
   `api_keys` — le 409 était la mauvaise réponse à un vrai problème.

### Vérification en production (1er septembre 2026)

`GET /api/calendar` sans jeton → **401** · `POST /api/grok` sans authentification
→ **401** · `GET /api/serrures?action=locks` → **401** ·
`POST /api/stripe?action=portal` → **401**.

### ⚠️ Ce qui reste inerte jusqu'au sélecteur de compte (étape 5)

Les gardes de `messages`, `menages`, `serrures`, `stripe` et `extract-kb` sont des
endpoints de **collection ou de compte** : aucun identifiant client, donc aucune
ressource ne désigne un compte, donc le compte cible est celui de l'appelant —
qui en est titulaire par définition.

**Conséquence fonctionnelle, pas sécuritaire** : un membre invité ne voit pas les
données du compte auquel il appartient, il voit les siennes (vides). Le câblage
est posé pour que l'étape 5 n'ait qu'à fournir `accountUserId`.

La couverture de tests porte donc sur `lib/permissions` (`refsDuPerimetre`,
`filtrePerimetreSql`), pas sur ces endpoints : un vert d'endpoint ne prouverait
rien tant que le câblage est inerte.

### Suite

Étape 4 : page Équipe et droits. Étape 5 : **sélecteur de compte** (lève tout ce
qui précède). Étape 6 : fiche prestataire.


## 10. Étape 4 — page Équipe et droits

Livrée le 2 septembre 2026. `/settings` à onglets (Équipe réel, Connexions /
Abonnement / Mon compte en liens), endpoint `api/membres.js`, parcours
d'invitation par lien.

### Deux sections, un seul modèle de données

Les profils `access_mode = 'lien'` (prestataires) sont affichés dans une section
« Prestataires » distincte, et leur panneau est réduit à **identité, accès,
disponibilités, voir ses avis**. Pas de grille des huit domaines, pas de
périmètre : ils se gèrent depuis la fiche prestataire (étape 6).

Rien ne change en base — `access_mode` reste la seule différence entre un
prestataire et un membre.

### ⚠️ Ce qui n'est pas affiché ne doit pas être écrasé

Le panneau réduit n'expose ni périmètre ni domaines. Sans précaution,
enregistrer depuis ce panneau les aurait remis à leurs valeurs par défaut :
Régina, réglée sur **deux biens**, serait repassée à `property_scope = 'all'` —
donc **tout le compte** dans sa PWA.

`validerPermissions` prend donc les droits déjà enregistrés comme **socle** : ce
qui est fourni s'applique (y compris `'none'`, pour pouvoir retirer un droit),
ce qui est absent est conservé. Une panne de lecture de ce socle répond 503
plutôt que d'écraser.

Règle générale : **un formulaire qui n'expose pas un champ ne l'écrase jamais** —
ni dans `profile_permissions` (socle conservé), ni dans `public_tokens` (writer
unique, voir ci-dessous).

Exception voulue : un domaine **non délégable** hérité du socle à `'write'` est
*abaissé* à `'none'`, pas refusé. Une valeur fautive déjà en base rendrait sinon
le profil définitivement non enregistrable — aucun écran ne permet de l'abaisser,
et chaque enregistrement la reconduirait pour la refuser aussitôt. Fourni
explicitement, il reste refusé.

### Invitation par lien, sans email

`invite_token` / `invite_expires_at` (7 jours), jeton généré côté serveur, effacé
à l'acceptation — la contrainte `profiles_invite_coherent` rend l'état
« accepté avec jeton » impossible à écrire. L'acceptation est explicite
(« Rejoindre le compte de X ») ; le rattachement automatique par email a été
écarté, il ferait entrer quelqu'un dans un compte tiers sans qu'il le sache.

L'envoi Brevo viendra plus tard : le champ existe, désactivé.

### ⚠️ Un seul writer pour `public_tokens.property_ids`

`apps/menages/prestataires.html` **est** l'écran d'affectation des biens d'un
prestataire : c'est lui qui écrit `property_ids` et `visibility_days`.

`/settings` n'y touche qu'**à la création**, où il faut bien un point de départ.
Partout ailleurs — édition, réactivation, régénération — il n'écrit plus cette
colonne. Sans cette séparation, trois chemins la réécrivaient depuis
`profile_permissions`, qui n'est pas la même donnée :

- **édition** : l'hôte coche deux biens sur huit dans la fiche prestataire,
  corrige une faute de frappe sur le nom ici, le prestataire récupère les huit ;
- **régénération** : « Régénérer le lien » reconstruisait la ligne entière —
  désormais seul le `token` de la ligne existante est remplacé ;
- **réactivation** : elle recréait la ligne depuis les droits. Elle ne la recrée
  plus du tout : la désactivation ayant supprimé la ligne, son périmètre est
  perdu et on ne l'invente pas. La réponse porte un avertissement explicite
  renvoyant vers la fiche prestataire.

Application directe de `docs/kb/coeur-de-donnees.md`.

Corollaire : `perimetrePwaExploitable` et `synchroniserTokenPwa` ne sont plus
appelées qu'**à la création**. Les garder en réactivation rendait
**définitivement non réactivable** tout prestataire en `property_scope = 'all'` —
état pourtant créé par l'ancien modèle — sans aucun écran pour le corriger.

### ⚠️ Un prestataire n'a aucun domaine, et c'est le serveur qui l'impose

Le panneau réduit masque la grille, mais le brouillon peut encore porter des
domaines : appliquer le modèle « Employé » puis basculer sur « Lien » envoyait
six domaines en écriture. Ils auraient été **ineffaçables** — non affichés, non
renvoyés à l'édition, et reconduits par le socle à chaque enregistrement. La
création force donc tous les domaines à `'none'` pour un accès par lien.

### ⚠️ Un accès par lien ne porte jamais sur « tous les biens »

Refusé côté serveur, à la création. Dans `public_tokens`, une liste vide vaut
« aucune restriction » : un prestataire créé sans périmètre explicite obtenait le
planning ménage de **tout le compte**. C'est un écart assumé à la consigne
« pas de périmètre dans le panneau prestataire » — l'appliquer aussi à la
création ouvrait cet accès. Le sélecteur de biens reste donc visible à la
création d'un prestataire, et disparaît ensuite.

La liste affiche toujours le périmètre d'un prestataire, avec un ⚠️ si
« tous les biens » : un accès trop large hérité doit rester visible.

### ⚠️ Les deux représentations du périmètre

`profile_permissions.property_ids` (UUID) et `public_tokens.property_ids`
(TEXT, `provider_property_id`). La PWA prestataire ne lit que la seconde.

**Le vide n'y veut pas dire la même chose** : « aucune restriction » côté PWA,
« zéro bien » côté droits. Un `selected` vide écrit tel quel donnait au
prestataire l'intégralité du compte. C'est refusé explicitement pour un accès par
lien.

Une mise à jour ne touche **que** `property_ids` : `visibility_days` (7 à 90
jours) et `label` se règlent dans `apps/menages/prestataires.html` et étaient
écrasés à chaque enregistrement.

### ⚠️ Coupure d'accès : deux tables, toujours

`active = false` ne suffit pas — la PWA n'interroge pas `profiles`. La
désactivation retire la ligne `public_tokens`, et ni l'enregistrement de droits
ni la régénération ne la recréent sur un profil coupé. La régénération vérifie
que l'ancien jeton a bien été révoqué, et le dit quand ce n'est pas le cas.

### ⚠️ Inerte jusqu'au sélecteur de compte (étape 5)

Sans sélecteur, aucun identifiant ne désigne un compte : le compte cible est
celui de l'appelant, qui en est titulaire. Un membre voit donc **sa propre** page
Équipe, vide — pas celle du compte auquel il appartient. Ce qui est garanti, et
testé, c'est qu'il ne touche rien du compte d'autrui : 404 sur tout profil
étranger, refus de rattacher un bien étranger.

La zone « Réservé au titulaire » de la page est donc du code prêt pour l'étape 5,
pas une protection active — c'est écrit dans le fichier.

### ⚠️ Dette : deux populations de prestataires

`/settings` crée `profiles` + `profile_permissions` + `public_tokens`.
`apps/menages/prestataires.html` crée **uniquement** une ligne `public_tokens`,
sans profil.

Conséquence : un prestataire créé depuis la fiche prestataire n'apparaît pas dans
la carte « Prestataires » de `/settings`, qui liste `profiles`. Les deux écrans
montrent donc des populations partiellement disjointes, alors que le texte de la
carte renvoie vers la fiche prestataire comme lieu de gestion.

À faire converger à l'**étape 6** (fiche prestataire) : la création d'un
prestataire doit passer par `profiles`, `public_tokens` n'en étant que la
projection PWA. Non traité dans l'étape 4 — cela demanderait de réécrire un écran
qui fonctionne, sans que la fiche prestataire existe encore pour le remplacer.
