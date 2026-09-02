# Chantier : Avis voyageurs OTA (ingestion + affichage)

## Contexte
HôteSmart doit récupérer les avis voyageurs (Airbnb, Booking.com) pour les afficher à l'hôte et, à terme, rattacher la note propreté au prestataire de ménage. Ce chantier couvre **l'ingestion et l'affichage uniquement**. Le rattachement au prestataire viendra dans un chantier ultérieur (fondation prestataires) — on prévoit juste la colonne.

Règles d'architecture à respecter impérativement :
- Aucun module métier ne parle aux providers : seule la couche sync (cron / webhooks / `lib/channels/`) appelle Channex ou Beds24.
- Routage par `properties.provider` via `lib/channels/`.
- Frugalité des appels API.
- `cron.js` : toujours générer le fichier complet, jamais de patch manuel.
- Mettre à jour le fichier `docs/kb/` correspondant dans le même commit.
- ⚠️ Piège connu : `properties.id` est un UUID, mais les colonnes `property_id` des tables enfants stockent des propIds Beds24 en texte. Pour cette nouvelle table on référence **l'UUID de `properties.id`** (l'app métier est provider-agnostique et ne doit rien connaître de Beds24 ; seule la couche sync parle aux providers).

## 0. Décision d'architecture — `ota_reviews` appartient au CŒUR

> À intégrer **avant** d'ouvrir ce chantier. Décision prise le 2 septembre 2026.
> Elle conditionne la table, sa rétention et ce qu'on y stocke.

`ota_reviews` fait partie du **cœur de données HôteSmart**
(`docs/kb/coeur-de-donnees.md`), au même titre que l'historique des ventes que
consommera YieldFlow. **Ce n'est pas une table du domaine ménage.**

**Table de vérité unique, liée à la réservation** (`booking_uid`), lue par :
- la **fiche prestataire**, via `menage_event_id` — quels avis se rapportent aux
  ménages de cette personne ;
- le **futur module de pricing**, via le bien et les dates — comment les avis
  évoluent au regard des tarifs et de l'occupation.

**Jamais dupliquée.** Ni copie dans une table ménage, ni recopie d'un extrait
dans une app. Deux lecteurs, une seule table : c'est précisément le cas que la
règle du cœur existe pour tenir. Une copie « pour le confort de la fiche
prestataire » divergerait au premier avis modifié par le voyageur.

### Conserver l'avis COMPLET, pas le verdict propreté

Le réflexe naturel, en abordant ce chantier par la qualité du ménage, serait de
ne garder que `ai_clean_verdict` et son extrait. **Ce serait une erreur
irréversible** : les scores par catégorie, les tags, le texte et les dates ne se
récupèrent pas rétroactivement quand l'OTA les a fait tourner.

On conserve donc : scores par catégorie, tags, texte intégral, réponse de l'hôte,
**dates de séjour et date de dépôt de l'avis**. Le module de pricing corrélera
l'évolution des avis avec les tarifs pratiqués et l'occupation — il a besoin de la
série complète, pas d'un verdict binaire.

⚠️ La table ci-dessous porte `received_at` (dépôt) mais **pas les dates de
séjour** : elles sont dans `bookings_snapshot`, atteignables par `booking_uid`.
Quand `booking_uid` n'a pas pu être résolu, l'avis perd son ancrage temporel de
séjour — prévoir de les dénormaliser (`stay_start`, `stay_end`) ou de traiter la
résolution tardive du `booking_uid` comme un travail de fond.

### Rétention — alignée sur l'historique des ventes

**Conservée tant que le bien existe, supprimée avec lui.** C'est déjà ce
qu'exprime `property_id uuid references properties(id) on delete cascade` dans la
table ci-dessous : la rétention est portée par le schéma, pas par une purge
périodique. Aucun effacement à l'ancienneté — une série tronquée à douze mois
serait sans valeur pour le yield.

## 1. Migration SQL — table `ota_reviews`

```sql
create table ota_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  property_id uuid not null references properties(id) on delete cascade,
  provider text not null check (provider in ('channex','beds24')),
  ota text not null,                      -- 'airbnb' | 'booking' (normalisé en minuscules)
  external_review_id text not null,       -- id review Channex OU id review Beds24
  ota_reservation_id text,                -- code résa OTA (ex. HMSZMHHF2X, 2328423042)
  booking_uid text,                       -- lien vers bookings_snapshot si résolu, sinon null
  menage_event_id uuid,                   -- NULL pour l'instant — rempli au chantier prestataires
  guest_name text,
  content text,
  reply text,
  is_replied boolean default false,
  overall_score numeric,                  -- normalisé sur 10
  score_clean numeric,                    -- extrait des scores détaillés (catégorie clean/cleanliness)
  scores jsonb,                           -- liste complète des scores par catégorie
  tags jsonb,                             -- tags Airbnb (dirty_bathroom, stains, etc.)
  received_at timestamptz,
  ai_clean_verdict text check (ai_clean_verdict in ('rien_signale','remarque','positif')),
                                          -- classification IA du texte : propreté non évoquée / remarque négative / propreté saluée
  ai_clean_excerpt text,                  -- extrait exact du texte évoquant la propreté (null si rien_signale)
  ai_analyzed_at timestamptz,             -- null = pas encore analysé
  raw jsonb,                              -- payload brut pour debug/évolution
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (provider, external_review_id)   -- idempotence des upserts
);

create index ota_reviews_property_idx on ota_reviews (property_id, received_at desc);
create index ota_reviews_reservation_idx on ota_reviews (ota_reservation_id);
```

**⚠️ RLS — CORRECTION : cette spec date d'avant le chantier profils et droits.**

`user_id = auth.uid()` **ignorerait la délégation** : un membre avec
`avis: read` ne verrait rien. Les politiques suivent le modèle de droits, domaine
`avis` :

```sql
create policy ota_reviews_select on ota_reviews for select to authenticated
  using (can_read(user_id, 'avis', property_id_ref));
create policy ota_reviews_write on ota_reviews for all to authenticated
  using (can_write(user_id, 'avis', property_id_ref))
  with check (can_write(user_id, 'avis', property_id_ref));
```

**Deux colonnes s'ajoutent au schéma ci-dessus** :

- **`property_id_ref text not null`** — le `provider_property_id`. `can_read` et
  le filtre de périmètre travaillent sur la référence **TEXT**, pas sur l'UUID
  (`REVIEW.md` §10). Sans elle, le périmètre ne s'appliquerait pas.
- **`stay_start date` / `stay_end date`** — dénormalisées à l'ingestion. Les
  dates de séjour vivent dans `bookings_snapshot` et ne sont atteignables que par
  `booking_uid` : quand celui-ci n'est pas résolu, l'avis perd son ancrage
  temporel, dont le module de pricing a besoin.

**Résolution de `booking_uid`** — la clé existe et est déjà peuplée :
`bookings_snapshot.snapshot->>'otaReservationCode'` (164 lignes sur 182).
C'est elle qu'on matche contre `ota_reservation_id`.

Les écritures serveur passent par la service key (cron/webhook), les lectures
front par l'anon key + RLS.

## 2. Couche sync — `lib/channels/`

Créer un module reviews par provider, exposant une interface commune :

```
lib/channels/channex/reviews.js   → fetchReview(reviewId), listReviews(propertyId)
lib/channels/beds24/reviews.js    → listReviews() (booking + airbnb)
lib/channels/reviews.js           → normalisation commune → format ota_reviews
```

### Normalisation
- `overall_score` : Channex fournit déjà /10. Si Beds24 renvoie une autre échelle (ex. Airbnb /5), normaliser sur 10 et conserver le brut dans `raw`.
- `score_clean` : chercher la catégorie `clean` ou `cleanliness` dans les scores détaillés ; null si absente.
- `ota` : normaliser en `airbnb` / `booking`.
- Résolution `booking_uid` : matcher `ota_reservation_id` contre la référence OTA stockée dans `bookings_snapshot` (vérifier le nom exact de la colonne dans le schéma actuel — apiReference/channel booking id). Si aucun match : laisser null, ne pas bloquer l'insert.

### Channex — temps réel via webhook
- ⚠️ **État vérifié (étape 0)** : `updated_review` n'est **ni abonné ni routé**.
  Le code enregistre deux webhooks — `api/channel-webhook.js` avec le masque
  `booking;message`, et `api/channel-events.js` avec
  `new_channel;updated_channel;activate_channel`. L'événement n'est dans aucun
  des deux, et le handler ne traite que `booking` et `message` : tout le reste
  tombe dans `ignored:<event>` avec un 200. **Deux actions, donc : l'ajouter à
  l'abonnement ET le router.**
- Le payload webhook contient l'id de la review → appeler `GET /api/v1/reviews/:review_id` puis upsert dans `ota_reviews` (conflit sur `(provider, external_review_id)`).
- Vérifier que l'abonnement webhook Channex inclut bien l'événement review (sinon l'ajouter à la création/mise à jour du webhook).
- **Prérequis manuel (à faire par Thierry, pas par le code)** : activer l'application « Messages & Reviews » sur chaque propriété dans app.channex.io, sinon l'API répond 403.

### Beds24 — ⚠️ SOURCE NON CONFIRMÉE (étape 0, 2 septembre 2026)

**Trois hypothèses de cette spec se sont révélées fausses. Vérifié sur le token
de production, en lecture seule.**

**1. Le token n'a pas expiré.** Il est valide, recréé automatiquement par le cron
(`GET /authentication/details` → 200, créé le jour même, expire dans 24 h). Aucun
renouvellement à faire.

**2. Le scope est déjà là.** Scopes réels du token :
`all:bookings`, `all:bookings-personal`, `all:bookings-financial`,
`all:inventory`, `read:properties`, `read:accounts`, **`read:channels`**.
Il n'y a donc pas de scope à ajouter.

**3. L'endpoint de cette spec n'existe pas.** `GET /channels/booking/reviews`
(pluriel) répond **400 « Invalid data »**. La forme `/channels/booking/review`
(**singulier**) répond 200 — mais `null`, quels que soient les paramètres
essayés : `propertyId`, `bookingId` d'une vraie réservation Airbnb, `dateFrom` /
`dateTo`, `page`.

⚠️ **Et `null` n'est pas une réponse métier.** `GET /channels/airbnb/reviewsList`
— un chemin **inventé pour le test** — renvoie exactement la même chose, comme
`/channels`, `/channels/booking` et `/channels/airbnb`. Tout sous-chemin de
`/channels` répond `200 null` en GET : ces chemins ne sont pas implémentés en
lecture.

**Indice concordant** : les réservations portent un champ **`allowReview`**
(booléen). L'API semble donc servir à **publier** un avis hôte → voyageur, pas à
lire les avis reçus. Aucun champ `review` / `rating` / `score` / `feedback` n'a
été trouvé sur les réservations.

⚠️ **Un `POST` n'a délibérément PAS été testé** : il publierait un avis réel sur
une vraie réservation.

**À trancher avant d'écrire une ligne de ce job** : consulter la doc Swagger
authentifiée de Beds24 (compte Thierry) pour établir si la lecture des avis
reçus existe. Si elle n'existe pas, **la source Beds24 disparaît de la V1** et
seul Channex alimente `ota_reviews` — ce qui économise un job cron entier.

Si la lecture existe, le job reste tel que prévu : `syncBeds24Reviews` **une fois
par jour** (frugalité), upsert idempotent sur `(provider, external_review_id)`,
erreurs dans `automation_incidents` sans faire échouer le reste du cron.

## 2 bis. Analyse IA du texte des avis (Claude Haiku via `api/grok.js`)

Problème métier : la note propreté structurée n'est pas toujours présente ; souvent la propreté n'est évoquée que dans le texte de l'avis. On extrait donc un signal propreté par IA, sous forme de **classification simple** (pas de note estimée — fausse précision).

- **Déclenchement** : à l'ingestion (webhook Channex ou poll cron Beds24), pour chaque avis nouvellement inséré dont `ai_analyzed_at` est null. Un seul appel Haiku par avis, jamais de ré-analyse (frugalité). Réutiliser le wrapper existant `api/grok.js` / la même mécanique d'appel Claude Haiku — ne pas créer un second wrapper.
- **Prompt** (français, sortie JSON strict sans markdown) : à partir du texte de l'avis, classer en trois catégories et retourner `{ "verdict": "rien_signale" | "remarque" | "positif", "excerpt": string|null }`.
  - `rien_signale` : la propreté n'est pas évoquée.
  - `remarque` : le voyageur signale un problème de propreté, même mineur ou formulé gentiment (« quelques poussières », « cheveux dans la douche », « odeur »).
  - `positif` : le voyageur salue explicitement la propreté (« impeccable », « très propre »).
  - `excerpt` = citation exacte du passage concerné (null si `rien_signale`). Si un avis contient à la fois du positif et une remarque : classer `remarque` (le signal d'alerte prime).
  - Si le texte est vide ou trop court : `rien_signale` sans appel IA.
- **Stockage** : colonnes `ai_clean_verdict`, `ai_clean_excerpt`, `ai_analyzed_at`.
- **Règle d'or — ne jamais mélanger les sources** : `score_clean` (note OTA officielle) et `ai_clean_verdict` (classification du texte) sont deux signaux complémentaires, affichés distinctement. La classification s'applique à tous les avis ayant du texte, même ceux qui ont une note officielle (un 8/10 avec « cheveux dans la douche » doit remonter la remarque).
- **Échec IA** : si l'appel Haiku échoue, laisser `ai_analyzed_at` null (sera retenté au prochain cycle), logger dans `automation_incidents`, ne pas bloquer l'ingestion.

### Feedback privé Airbnb — à vérifier empiriquement
La doc Channex ne montre pas de champ feedback privé voyageur→hôte sur les reviews entrantes (`private_review` n'existe que dans le sens hôte→voyageur). Les champs exacts de `GET /channels/airbnb/reviews` chez Beds24 ne sont pas documentés publiquement. **Consigne** : au premier avis réel ingéré de chaque provider, inspecter le payload `raw` et vérifier si un champ de feedback privé existe. Si oui : ajouter une colonne `private_feedback text` par migration et l'inclure dans l'analyse IA (c'est souvent le retour le plus honnête). Si non : ne rien inventer, le noter dans le KB.

## 3. UI — section « Avis voyageurs »

Portée V1 volontairement minimale : **lecture seule**.
- Nouvelle section dans le dashboard propriété (ou page dédiée `avis.html` selon la structure actuelle — suivre le pattern des pages existantes).
- Liste des avis triés par `received_at` desc : nom voyageur, OTA (badge), date, note globale, **note propreté OTA quand elle existe** (code couleur : ≥9 vert, 7–9 orange, <7 rouge), texte du commentaire. En plus, un badge verdict issu de l'analyse IA : « Remarque propreté » (rouge) ou « Propreté saluée » (vert) avec l'extrait `ai_clean_excerpt` visible ; rien affiché si `rien_signale`.
- Compteur en tête remplaçant/complétant la moyenne : « Remarques propreté (30 j) » — le nombre d'avis avec verdict `remarque`. C'est le signal d'alerte principal.
- Maquette validée : badge propreté en évidence avec code couleur, tags Airbnb traduits et colorés par polarité (positif vert, négatif rouge), 3 compteurs en tête, filtres bien/OTA.
- Pour Airbnb : afficher les tags propreté traduits en français (ex. `dirty_bathroom` → « Salle de bain sale », `stains` → « Taches », `hair_or_pet_hair` → « Cheveux/poils », `trash_left_behind` → « Déchets laissés », `noticeable_smell` → « Odeur », `spotless_furniture_and_linens` → « Mobilier et linge impeccables », `squeaky_clean_bathroom` → « Salle de bain impeccable », `pristine_kitchen` → « Cuisine impeccable »). Ignorer les tags hors propreté en V1.
- Filtre par propriété. Pas de réponse aux avis en V1 (le POST reply Channex viendra plus tard).
- Lecture via endpoint serverless dédié (ex. `api/reviews.js`) qui lit Supabase — jamais d'appel provider depuis le front.
- Rappel bug Vercel `cleanUrls:true` : toute rewrite doit pointer une URL sans `.html`.

## 4. Hors périmètre (ne pas implémenter)
- Rattachement au prestataire (`menage_event_id` reste null).
- Réponse aux avis / review de l'hôte vers le voyageur.
- Endpoint Scores agrégés Channex (KPI dashboard — plus tard).

## 5. Tests
- Utiliser le compte test (`thierrylapoule31@gmail.com`) — ne jamais toucher au compte prod.
- Channex propose des comptes test Booking/Airbnb permettant de générer des reviews de test.
- Vérifier l'idempotence : rejouer deux fois le même webhook/poll ne doit créer qu'une ligne.
- Vérifier la RLS : un autre user_id ne doit voir aucun avis.

## 6. Documentation
- Mettre à jour le fichier `docs/kb/` thématique concerné (avis/reviews — créer le fichier si aucun ne couvre le sujet) **dans le même commit**.
- Documenter la table `ota_reviews`, le webhook `updated_review`, le job cron quotidien Beds24, et le prérequis manuel Channex (app Messages & Reviews).

## Ordre d'exécution suggéré
1. Migration SQL + RLS (test sur compte test).
2. `lib/channels/channex/reviews.js` + normalisation + branchement webhook.
3. Job cron Beds24 (cron.js régénéré complet).
4. Endpoint `api/reviews.js` + UI lecture seule.
5. KB + commit.
