# Chantier : Prestataires de ménage — fondation, disponibilités, assignation

## Contexte
Aujourd'hui l'app ménage suppose un prestataire unique et implicite (Régina, un token PWA, `api/menages-public.js`). Cas concret déclencheur : une seconde femme de ménage arrive à Bagnères-de-Bigorre, disponible le week-end une semaine sur deux. Le prestataire devient une entité de première classe, avec disponibilités récurrentes, et l'assignation des ménages devient automatique selon un mode réglé par bien.

Les choix de conception (boucle d'acquittement, escalade, priorités, verrou manuel, journal immuable) reprennent les patterns qui font consensus chez Turno, Breezeway, ServiceTitan et PagerDuty, calibrés pour un petit SaaS (2–3 prestataires par bien). Règle d'or issue de ces outils : **l'automate propose, l'humain dispose — et rien n'échoue en silence.**

Ce chantier s'appuie sur le chantier « Avis voyageurs » (table `ota_reviews` avec colonne `menage_event_id` réservée) : on livre ici le rattachement avis ↔ ménage ↔ prestataire.

> ⚠️ **Cette spec est postérieurement révisée par `docs/specs/spec-profils-et-droits.md`** :
> `cleaning_providers` disparaît au profit de `profiles`, et les droits d'accès
> (dont ceux du prestataire sur ses propres disponibilités) relèvent désormais de
> `profile_permissions`. Lire les deux ensemble ; en cas de contradiction, la spec
> profils et droits fait foi.

Règles d'architecture à respecter impérativement :
- **L'app ménage est provider-agnostique** : elle s'appuie uniquement sur les données en base HôteSmart (`bookings_snapshot`, `properties`, `menage_events`…). Elle ne connaît ni Beds24 ni Channex. Seule la couche sync (cron, webhooks, `lib/channels/`) parle aux providers et alimente ces tables.
- `cron.js` : toujours générer le fichier complet.
- Frugalité : l'assignation est un calcul local Supabase, aucun appel externe.
- Mettre à jour `docs/kb/` dans le même commit.
- ⚠️ Piège UUID/text : les nouvelles tables référencent `properties.id` (UUID). Le contenu réel de `menage_events.property_id` est vérifié à l'étape 0.
- RLS sur toutes les nouvelles tables (`user_id = auth.uid()`), écritures serveur via service key.

## 0. Audit préalable — unification des données (bloquant)

Avant toute migration, vérifier et corriger si nécessaire :
- L'app ménage (`api/menages-public.js`, front PWA, création des `menage_events` dans le cron) ne lit **que** des tables HôteSmart. Aucun appel Beds24/Channex, aucun import de `lib/channels/` dans le code métier ménage. Lister chaque fichier touché.
- `bookings_snapshot` est réellement unifié : même schéma et mêmes conventions (dates, statuts, référence OTA, `property_id`) quelle que soit l'origine (Channex ou Beds24). Comparer une résa Beds24 et une résa Channex côte à côte.
- Cohérence des clés : `menage_events.property_id`, `bookings_snapshot.property_id` et `properties.id` — UUID ou propId Beds24 texte ? Si les tables enfants stockent du texte Beds24, les biens Channex n'ont pas de propId Beds24 : c'est une faille d'unification à corriger **avant** de créer les liaisons prestataires.
- Rendre compte de l'audit (fichiers, écarts trouvés) avant de passer à l'étape 1. Si des écarts existent, les corriger dans un commit séparé, KB à jour, puis seulement enchaîner.

## 1. Migration SQL

> ⚠️ **RÉVISÉ par `docs/specs/spec-profils-et-droits.md`.** La table
> `cleaning_providers` **n'existe plus** : un prestataire est un `profiles` avec
> `access_mode = 'lien'`. Un prestataire est un profil comme un autre, ce qui évite
> deux annuaires de personnes à maintenir. Toutes les références ci-dessous
> pointent donc `profiles(id)`.
>
> Ce qui figurait dans `cleaning_providers` est repris par :
> - `name`, `phone`, `email` → `profiles.first_name` / `last_name` / `phone` / `email` ;
> - `pwa_token` → `profiles.pwa_token` (`access_mode = 'lien'`) ;
> - `active` → `profiles.active` ;
> - `requires_ack` → **reste à placer** : il ne relève pas de l'identité mais du
>   mode d'assignation. À porter sur `property_cleaning_providers` (par bien, ce qui
>   est plus fin) ou sur une colonne dédiée de `profiles`. **À trancher à l'étape 1.**
>
> `self_availability` (`profile_permissions`) commande l'écran « Mes disponibilités »
> de la PWA : `none` → pas d'écran, `read` → lecture seule, `write` → le prestataire
> gère ses règles et exceptions. L'admin garde toujours le dernier mot.

```sql
-- Prestataires : PAS de table dédiée. Voir profiles (access_mode = 'lien').

-- Liaison bien ↔ prestataire
create table property_cleaning_providers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  property_id uuid not null references properties(id) on delete cascade,
  provider_id uuid not null references profiles(id) on delete cascade,   -- profil prestataire (access_mode='lien')
  priority int not null default 1,          -- 1 = principal, 2 = renfort…
  quota_share numeric,                      -- part cible pour le mode quota (ex. 0.5, 0.333) ; null si mode ≠ quota
  weekdays int[],                           -- jours attitrés pour le mode jour (0=dim … 6=sam) ; null si mode ≠ jour
  active boolean default true,
  unique (property_id, provider_id)
);

-- Mode d'assignation par bien
alter table properties
  add column cleaning_assignment_mode text not null default 'priorite'
  check (cleaning_assignment_mode in ('priorite','jour','quota'));

-- Disponibilités récurrentes (aucune règle = disponible tous les jours)
-- Stockées au standard RRULE (RFC 5545) — ne pas coder la récurrence à la main, utiliser la lib npm `rrule`
create table provider_availability_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_id uuid not null references profiles(id) on delete cascade,   -- profil prestataire (access_mode='lien')
  rrule text not null,                      -- ex. "DTSTART:20260905\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SA,SU"
  label text,                               -- lisible : "Week-ends, une semaine sur deux"
  active boolean default true
);

-- Exceptions ponctuelles (dans les deux sens)
create table provider_availability_exceptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_id uuid not null references profiles(id) on delete cascade,   -- profil prestataire (access_mode='lien')
  date date not null,
  available boolean not null,               -- false = congé ; true = dispo exceptionnelle
  reason text,
  unique (provider_id, date)
);

-- ⚠️ RÉVISÉ LE 3 SEPTEMBRE 2026 — VOIR §11. Ce bloc `alter table menage_events`
-- N'EST PLUS LA CONCEPTION RETENUE et ne doit pas être exécuté tel quel.
-- `menage_events` est un journal de NOTIFICATIONS (une ligne par prestataire
-- notifiée ET par type d'événement : 168 lignes pour 151 couples bien/résa en
-- production). Y greffer un cycle de vie d'assignation donnerait, dès la
-- seconde prestataire, plusieurs lignes concurrentes pour le même ménage,
-- chacune avec son `status` et son `provider_id`.
-- Ces colonnes vont sur la table `menages` (§11), qui fait du ménage une entité.
-- Le bloc est conservé ici comme référence des champs à porter, pas comme SQL.
alter table menage_events
  add column type text not null default 'turnover'
    check (type in ('turnover','ponctuel','fond')),   -- turnover auto ; ponctuel/fond créés par l'hôte
  add column priority text not null default 'standard'
    check (priority in ('standard','urgent')),
  add column status text not null default 'created'
    check (status in ('created','offered','accepted','started','completed','orphaned','cancelled')),
  add column provider_id uuid references profiles(id),
  add column assigned_by text check (assigned_by in ('auto','manual')),
  add column assignment_reason text,        -- trace lisible : "mode jour : samedi → X" / "aucune candidate"
  add column escalation_level int not null default 0,  -- rang de la candidate à qui l'offre est en cours
  add column offered_at timestamptz,
  add column offer_expires_at timestamptz,
  add column accepted_at timestamptz,
  add column started_at timestamptz,
  add column completed_at timestamptz,
  add column quality_rating int check (quality_rating between 1 and 5),
  add column quality_comment text,
  add column rated_at timestamptz;

create index menage_events_provider_idx on menage_events (provider_id, date);
create index menage_events_status_idx on menage_events (status, offer_expires_at);

-- Journal immuable des affectations (timeline — jamais de update/delete)
create table menage_assignment_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  menage_event_id uuid not null references menage_events(id) on delete cascade,
  event text not null,                      -- offered | accepted | declined | expired | escalated | orphaned | manual_assign | cancelled | started | completed
  from_provider_id uuid,
  to_provider_id uuid,
  actor text not null,                      -- 'cron' | 'provider' | 'host'
  reason text,
  created_at timestamptz default now()
);
```

Toute transition de `status` ou de `provider_id` écrit une ligne dans `menage_assignment_log`. C'est la source des métriques (délai offre→acceptation, taux d'expiration, taux d'orphelins) et la preuve en cas de litige.

### Migration des données existantes (Régina)
- Créer un **profil** pour Régina : `access_mode = 'lien'`, le token PWA **actuel**
  comme `pwa_token` (aucune rupture de son lien), `self_availability = 'write'`
  (à ajuster), `self_view_reviews = true`.
- La lier en priorité 1 à chaque bien de Thierry.
- Renseigner `provider_id = Régina`, `assigned_by = 'auto'` sur tous les `menage_events` passés du compte (historique de qualité cohérent).
- Vérifier que cette migration ne touche que les comptes ayant déjà un token ménage configuré.

## 2. Calcul de disponibilité — `lib/cleaning/availability.js`

> ⚠️ **PRÉCISÉ PAR LE §12 (4 septembre 2026)** : la disponibilité ne sert plus
> à filtrer des « candidates d'un bien » mais à désigner la **responsable du
> jour**. Tout est normalisé à **midi UTC** — pas minuit.


Dépendance : `npm install rrule`. Ne pas réimplémenter la récurrence.

`isAvailable(provider, date)` :
1. Une exception existe pour cette date → retourner sa valeur `available`.
2. Aucune règle active → disponible.
3. Sinon, disponible si au moins une règle matche : `rrulestr(rule.rrule).between(date, date, inclusive=true)` renvoie une occurrence.

Fonction pure, testable unitairement. Fuseaux horaires — piège classique : la **date du ménage est une date calendaire dans le fuseau du bien** (`Europe/Paris` en V1, à stocker sur `properties` dès maintenant pour l'avenir), dérivée du checkout dans ce fuseau, jamais du timestamp UTC serveur. Les règles RRULE et les requêtes `between` se font sur des dates calendaires normalisées (minuit UTC comme convention interne), jamais sur des timestamps réels.

Côté UI, l'hôte ne voit jamais la chaîne RRULE : le formulaire propose jours de la semaine + hebdo/une semaine sur deux + date de départ, et le code génère la chaîne (`new RRule({freq: WEEKLY, interval: 2, byweekday: [SA, SU], dtstart}).toString()`) et le `label`.

Bénéfice ultérieur (hors périmètre) : le format est iCal, donc un export du planning de chaque prestataire abonnable depuis Google Agenda devient trivial.

## 3. Moteur d'assignation — `lib/cleaning/assign.js`

> ⚠️ **RÉVISÉ PAR LE §12.1** : les trois modes n'en font plus qu'un. `priorite`
> était le cas particulier où personne n'a de jours attitrés — `weekdays` vide
> vaut « tous les jours ». `properties.cleaning_assignment_mode` reste dormante
> pour `quota`, seul mode alternatif restant. Le rang ne sert plus qu'à
> départager et remplacer.


Appelé par le cron à la création de chaque `menage_event` (date du ménage = jour du checkout), et exposé aussi pour un recalcul manuel depuis le dashboard.

```
candidats = liaisons actives du bien
          → filtrées par isAvailable(provider, date)
classement selon properties.cleaning_assignment_mode :
  priorite : tri par priority asc
  jour     : jours fixes — d'abord les candidates dont weekdays contient le jour du ménage (« tous les jeudis → X »),
             puis, pour un jour sans personne attitrée ou si l'attitrée est indisponible, repli sur la priorité
  quota    : pour chaque candidate, part réalisée = ses ménages sur les 30 derniers jours (ce bien) / total ménages du bien sur 30 j ;
             tri par (quota_share − part réalisée) desc ; égalité → priority asc
résultat : une LISTE ORDONNÉE de candidates (pas une seule) → transmise à la boucle d'offre (section 3 bis)
  liste vide → status='orphaned', assignment_reason='aucune candidate disponible',
               insertion automation_incidents + alerte hôte ET fondateur (mécanique existante)
```

### Détermination automatique de `priority` (à la création par le cron)
- `urgent` si : checkout et checkin le même jour sur ce bien (back-to-back) ; OU réservation créée moins de 48 h avant la date du ménage (last-minute) ; OU flag posé par l'hôte.
- `standard` sinon. L'hôte peut basculer manuellement.

### Règles
- **Verrou manuel** : ne jamais réassigner automatiquement un ménage `assigned_by='manual'`. Si sa date change, garder la prestataire, la re-notifier, et alerter l'hôte si elle est devenue indisponible ce jour-là — sans recalcul.
- Si un ménage `auto` change de date (modification de résa) : relancer le moteur et la boucle d'offre.
- Si la réservation est annulée : `status='cancelled'`, notifier la prestataire assignée, log.
- Si une prestataire pose une exception `available=false` sur une date où elle a des ménages `auto` acceptés : relancer le moteur pour ces ménages (elle est exclue), log `escalated` avec raison « congé déclaré » ; personne → orphelin + alerte.

## 3 bis. Boucle d'offre, acquittement et escalade — `lib/cleaning/offer.js`

> ⚠️ **PRÉCISÉ PAR LE §11.3 (3 septembre 2026)** : le référent (rang 1) est
> assigné d'office, sans confirmation ; seul le suppléant (rang 2+) reçoit une
> offre à accepter. L'escalade en cascade et les délais d'expiration ci-dessous
> sont reportés — les statuts, eux, sont posés dès le premier lot.


Principe (Turno/Breezeway/PagerDuty) : **assigné ≠ accepté**. Un ménage n'est réputé pris en charge que lorsque la prestataire l'a accepté dans sa PWA. V1 = dispatch **séquentiel** (offre à la 1re candidate, puis à la suivante si refus ou délai dépassé).

```
offrir(menage, candidates, level=0) :
  candidate = candidates[level]
  si aucune → status='orphaned', incident, alerte hôte + fondateur (SMS), log 'orphaned'
  si candidate.requires_ack = false :
      status='accepted', provider_id, accepted_at=now, log 'offered'+'accepted' (actor 'cron'), notifier
  sinon :
      status='offered', provider_id=candidate, escalation_level=level,
      offered_at=now, offer_expires_at=now + délai(priority, date), log 'offered', notifier l'offre

délai(priority, date) :
  urgent   → 30 min
  standard → min(24 h, veille du ménage à 18h)   -- jamais au-delà de J-1 18h

acceptation (PWA, endpoint atomique) :
  update menage_events set status='accepted', accepted_at=now
    where id=? and status='offered' and provider_id=? and offer_expires_at > now
  → 0 ligne modifiée = l'offre n'est plus valide (expirée, réassignée à la main) : la PWA affiche « ce ménage n'est plus disponible ». Anti double-affectation.

refus (PWA) : log 'declined', offrir(menage, candidates, level+1)

job cron escaladeOffres (à chaque exécution du cron) :
  pour chaque menage status='offered' and offer_expires_at < now :
      log 'expired', offrir(menage, candidates, level+1)
  pour chaque menage status='orphaned' non résolu et date ≤ demain :
      ré-alerter l'hôte à chaque exécution (principe PagerDuty « ack timeout » : rien ne s'éteint tant que ce n'est pas pris en charge)
```

- Régina : `requires_ack=false` à la migration pour ne rien changer à son fonctionnement actuel ; à passer à `true` quand elle est à l'aise avec le bouton. La seconde prestataire démarre à `true`.
- La PWA affiche **tous les détails** (bien, accès, checkin suivant, consignes) dès l'offre, pas seulement après acceptation.
- La réassignation manuelle par l'hôte passe par le même chemin : `assigned_by='manual'`, offre à la prestataire choisie (ou acceptation directe si `requires_ack=false`), log `manual_assign`, et retrait immédiat de l'offre précédente si elle était en cours.
- Une acceptation et une réassignation manuelle concurrentes sont départagées par la condition atomique ci-dessus — pas de double affectation possible.

## 4. PWA prestataire — `api/menages-public.js` et front PWA

> ⚠️ **PRÉCISÉ PAR LE §11.5** : le filtre passe du bien à la personne
> (`menages.provider_id`), et non plus `public_tokens.property_ids`.


- Le token identifie désormais un `profiles.pwa_token` (et non plus un token global). Un prestataire ne voit **que** ses ménages (`provider_id = lui`). Un token inconnu ou inactif → 401.
- Écran principal : les **offres en attente** en tête (badge « À confirmer », délai restant, badge « URGENT » si `priority='urgent'`), avec boutons « J'accepte » / « Je refuse » ; puis les ménages acceptés du jour et à venir.
- Sur un ménage accepté : boutons « Je commence » (`started_at`) et « Terminé » (`completed_at`) — deux clics, aucune saisie. C'est ce qui donnera la durée réelle par bien et par prestataire.
- Nouvel écran « Mes disponibilités » dans la PWA :
  - Voir ses règles récurrentes (lecture seule — c'est l'hôte qui les définit).
  - Déclarer une indisponibilité (date ou plage) → exceptions `available=false`.
  - Déclarer une disponibilité exceptionnelle → `available=true`.
- Endpoints correspondants scoped par token, jamais par user_id côté PWA.

## 5. Dashboard hôte

> ⚠️ **COMPLÉTÉ PAR LE §11.6** : le « marquer fait » de l'écran hôte n'écrit
> pas `menage_done` aujourd'hui — dette à régler dans le lot 2.3.


### Onglet « Prestataires » (nouveau, dans les réglages ou l'app ménage)
- CRUD prestataires : **c'est la page « Équipe et droits »** de
  `spec-profils-et-droits.md` §5 (création d'un profil `lien`, génération du token,
  affichage du lien PWA). Ne pas construire un second écran de gestion de personnes.
  La **fiche prestataire** (§4 de cette même spec) reste propre à ce chantier :
  biens, mode d'assignation, disponibilités et section qualité non dissociable.
- Règles de disponibilité par prestataire : formulaire jours + hebdo/quinzaine + date de départ (génère la RRULE). Liste des exceptions (dont celles déclarées par le prestataire).
- Par bien : mode d'assignation + liaisons (priorité, jours attitrés si mode jour, part si mode quota). Validation : en mode quota la somme des parts actives = 1 (avertissement, pas blocage).

### Vue ménages
- Chaque ménage affiche son statut et sa prestataire : orphelin = rouge avec la raison ; offre en attente = orange avec délai restant et niveau d'escalade ; accepté = vert ; badge « URGENT ».
- Réassignation manuelle (select) → passe par la boucle d'offre (section 3 bis), `assigned_by='manual'`.
- Accès à la timeline du ménage (lecture de `menage_assignment_log`).
- Après passage : notation qualité 1–5 + commentaire (l'hôte note, optionnel).

### Vue « Qualité par prestataire »
Tableau par prestataire sur période sélectionnable : nb ménages, note moyenne hôte, nb avis voyageurs rattachés, nb `remarque` propreté, nb `positif`, note propreté OTA moyenne quand elle existe. Aucun score inventé : afficher « — » quand la donnée manque.

## 6. Rattachement avis ↔ ménage ↔ prestataire

Job cron léger (une fois par jour, après le poll reviews) : pour chaque `ota_reviews` avec `menage_event_id` null et `booking_uid` résolu, trouver le `menage_event` du même bien dont la date est la plus proche **avant** le checkin de la réservation (fenêtre : 3 jours max) et renseigner `menage_event_id`. Si aucun match → laisser null, ne pas forcer. Le `provider_id` se déduit ensuite par jointure — ne pas le dupliquer sur `ota_reviews`.

### Vue « Avis » de la PWA prestataire — décidé le 3 septembre 2026

À côté du prénom de la prestataire, un **ratio** : nombre d'avis, pouce haut,
pouce bas. Calculé par **`ratioProprete`** (`lib/stats-avis.js`), la même
fonction que `/avis` — voir `docs/kb/avis-voyageurs.md` §12 pour sa signature.
Deux chiffres calculés différemment pour la même chose finiraient par se
contredire, et c'est celui montré à la prestataire qui perdrait sa crédibilité.

**Restreint à son travail** : `menageEventIds` = les ménages qu'elle a faits, et
`statut = 'confirme'` seul (la fonction l'impose déjà). Une prestataire sans
aucun ménage rattaché voit **zéro**, jamais le ratio de l'hôte — c'est
l'invariant `[] ≠ null` de la fonction.

**Au clic**, la liste des avis correspondants, filtrée à l'identique, et
**soumise au §6** : extrait de propreté seul, étiqueté « retour privé du
voyageur » quand il en vient, jamais le nom du voyageur, jamais l'avis complet,
et coupé par `self_view_reviews`.

### Mécanisme d'attribution — implémenté le 3 septembre 2026

`lib/attribution-prestataire.js`. **Deux voies, dans cet ordre de fiabilité :**

1. **`menage_event_id`** — le lien au ménage précis. Voie normale, et la seule
   pour tout ménage futur. La prestataire y est identifiée par son `pwa_token`
   (`menage_events` n'a pas encore de `provider_id`) : un profil sans token —
   identité d'attribution historique — n'a donc aucun ménage par cette voie, et
   c'est correct.
2. **`prestataire_periodes`** — attribution déclarée, quand aucun ménage
   n'existe. Le ménage précis **prime** en cas de recouvrement.

**La date qui situe l'avis** : `stay_end` d'abord — un ménage précède le séjour,
l'avis peut tomber des semaines après. `received_at` est un **repli assumé**,
utilisé par 136 des 168 avis réels faute de séjour résolu. Quand l'import de
l'historique des réservations résoudra les `booking_uid`, `stay_end` reprendra
la main **sans reprise manuelle** : l'attribution se recalcule à chaque
affichage, elle n'est jamais figée en base.

⚠ **Un avis non attribuable reste non attribué.** Ni « le prestataire du bien
par défaut », ni « le ménage le plus proche ». Un avis sans date n'est jamais
attribué. Deux ménages pour une même réservation : la case reste vide. Un
reproche qui tombe sur la mauvaise personne coûte plus cher qu'un reproche qui
ne tombe sur personne.

**Mesuré sur les données réelles** : Régina 98 avis (10 positifs, 16 remarques),
Tiphaine 58 avis (36 positifs, 1 remarque) — tous par période, aucun par ménage,
puisque `menage_event_id` est encore vide partout.

### Attribution rétroactive — faits établis, périmètre borné

Trois faits, établis par le product owner, pas déduits du code :

| prestataire | biens | période couverte |
|---|---|---|
| **Régina** | La bulle, Cœur de vie 23 | depuis le début, 100 % des ménages |
| **Tiphaine** | Colomiers | jusqu'au **31 juillet 2026**, 100 % des ménages |

**Après ces dates, le rattachement se fait par `menage_event` uniquement.**

⚠ **Ces attributions sont une exception bornée, pas un mode de rattachement.**
Une seconde femme de ménage arrive : à partir de là, seul le lien au ménage
précis dit qui a préparé quel séjour. Rattacher « au prestataire du bien »
attribuerait à l'une le travail de l'autre dès la première semaine — et le
reproche tomberait sur la mauvaise personne.

### Fait établi — Régina couvre les deux biens depuis le début

**Régina est la femme de ménage de La bulle et de Cœur de vie 23 depuis
l'origine.** Les remarques de propreté de ces deux biens, de 2023 à 2026,
concernent donc son travail — fait établi par le product owner, pas une
déduction du code.

**Conséquence pour la fiche prestataire** : l'historique de ces deux biens peut
lui être rattaché **rétroactivement**, sans passer par `menage_event_id`. C'est
un lot du chantier prestataires, à faire une fois, sur ces deux biens nommément.

⚠ **La règle générale ne change pas pour autant : tout ménage FUTUR se rattache
par `menage_event`.** Une seconde femme de ménage arrive, et à partir de là seul
le lien au ménage précis dira qui a préparé quel séjour. Le rattachement
rétroactif est une exception bornée à un fait connu, pas un précédent — ne pas
généraliser « le prestataire du bien » comme mode de rattachement, ce serait
attribuer à l'une le travail de l'autre dès la première semaine de la seconde.

### Ce que la prestataire voit de l'avis — décision du 2 septembre 2026

**L'extrait de propreté EST montré à la prestataire.** C'est le signal utile :
« la bouilloire n'était pas du tout propre », c'est à elle qu'il faut le dire, et
un reproche sans la phrase qui le fonde est incontestable donc inutilisable.

**Trois limites, non négociables :**

1. **L'extrait seul, jamais l'avis complet.** L'extrait est la phrase que la
   classification a isolée et vérifiée comme citation exacte. Le reste de l'avis
   ne la concerne pas.
2. **Jamais le nom du voyageur.** Ni `guest_name`, ni aucun élément permettant de
   l'identifier.
3. **Étiqueté « retour privé du voyageur »** quand l'extrait vient de
   `content_private`. C'est le cas le plus fréquent des remarques — l'unique
   remarque des 70 premiers avis en venait, sur un avis public élogieux noté
   10/10. La prestataire doit savoir qu'elle lit un message que le voyageur
   n'avait pas rendu public, pour ne pas le citer ailleurs.

**Coupé par `self_view_reviews`.** Le drapeau existe déjà (`lib/permissions.js`,
`api/membres.js`) et vaut `true` par défaut. À `false`, la prestataire ne voit
aucun extrait — l'hôte garde la main sur ce qu'il transmet.

**Pourquoi c'est écrit ici et pas seulement dans le code** : la donnée est
techniquement disponible dès que la fiche prestataire lit `ota_reviews`, et rien
dans le schéma n'empêche d'afficher `content_private` en entier. C'est une
décision produit, elle ne se déduit d'aucune contrainte technique.

## 7. Notifications (différenciées par urgence — contre la fatigue de notification)
- Les SMS/notifications ménage existants (Brevo, clé hôte) partent à la **prestataire visée par l'offre ou assignée**, avec son propre lien PWA. Vérifier qu'il n'y a plus aucune référence à un numéro/token ménage global.
- `standard` : un SMS à l'offre (« Ménage [bien] le [date] — confirme ici : lien »), un rappel J-1 si accepté. Pas de relance en rafale.
- `urgent` : SMS à l'offre avec mention URGENT, et si expiration → SMS à la candidate suivante immédiatement. Orphelin urgent → SMS hôte + alerte fondateur.
- Hôte : alerte uniquement sur orphelin, sur refus de toutes les candidates, et sur indisponibilité d'une prestataire verrouillée manuellement. Jamais sur une acceptation normale.
- Une prestataire dont l'offre est retirée (expirée ou réassignée) ne reçoit rien en V1 ; le ménage disparaît de sa PWA.

## 8. Hors périmètre
- Réponse aux avis, envoi de la review hôte.
- Facturation des prestataires.
- Export iCal du planning prestataire (le format RRULE le rend facile plus tard).
- Check-lists photo de fin de ménage (standard du marché — Turno/Breezeway — à envisager ensuite).
- Optimisation de tournée / géographique.
- Mode de dispatch « claim » (offre simultanée à un pool, la première qui prend gagne — Breezeway Claim Tasks) : utile pour les conciergeries à plusieurs prestataires interchangeables ; le modèle de données le permet (même statuts, même log), à activer par bien plus tard.
- Tampon de capacité (fraction de journée non allouable par l'automate, réservée à l'urgent) : pertinent pour les conciergeries, pas pour 2–3 biens.
- Tableau de bord des métriques d'exploitation (délai offre→acceptation, taux d'expiration, orphelins) : les données sont dans `menage_assignment_log`, l'UI viendra avec les premiers retours.

## 9. Tests
- Compte test uniquement (`thierrylapoule31@gmail.com`).
- Tests unitaires `availability.js` : weekly, biweekly (semaine on/off autour de la date de départ, passage d'année, fuseau horaire), exceptions dans les deux sens.
- Tests `assign.js` : les trois modes, liste vide → orphelin + incident, respect du verrou `manual`, détermination auto de `priority` (back-to-back, last-minute).
- Tests `offer.js` : acceptation atomique (deux acceptations concurrentes → une seule passe), expiration → escalade au niveau suivant, refus → niveau suivant, `requires_ack=false` → acceptation immédiate, délai `standard` plafonné à J-1 18h, orphelin ré-alerté à chaque cycle, chaque transition produit exactement une ligne de log.
- Scénario Bagnères : Régina priorité 1 sans règle ; seconde prestataire règle sam-dim biweekly, mode `jour` avec `weekdays=[0,6]` pour elle → un checkout samedi de semaine « on » lui revient, samedi de semaine « off » → Régina, mardi → Régina.
- Vérifier que le lien PWA existant de Régina fonctionne toujours après migration.

## 10. Documentation
Mettre à jour `docs/kb/` (app ménage) : nouvelles tables, moteur d'assignation et ses trois modes, disponibilités en RRULE via la lib `rrule`, token PWA par prestataire, rattachement avis, boucle d'offre/acquittement/escalade et ses délais, priorités automatiques, journal `menage_assignment_log`, points de vigilance (verrou manuel jamais écrasé, orphelin jamais silencieux, acceptation atomique).

## Ordre d'exécution suggéré
0. Audit d'unification (étape 0) — corriger avant de continuer.
1. Migration SQL + RLS + migration Régina (vérifier que la PWA actuelle fonctionne toujours).
2. `availability.js` + `assign.js` + `offer.js` + tests unitaires.
3. Branchement dans le cron (fichier complet) : création avec priorité auto, boucle d'offre, job d'escalade, relance sur changement de date / annulation / exception.
4. PWA : scoping par token prestataire, offres à accepter/refuser, boutons commencer/terminé, écran disponibilités.
5. Dashboard : prestataires, modes par bien, réassignation, notation.
6. Rattachement avis + vue qualité par prestataire.
7. KB + commit.

## 11. Lot 2 — gestion et assignation (conception gravée le 3 septembre 2026)

Déclencheur : une seconde femme de ménage arrive à Bagnères-de-Bigorre, **en
renfort de Régina** sur La bulle et Cœur de vie 23. Colomiers reste hors de son
périmètre.

### 11.1 Le ménage devient une entité — `menages`

**Décision révisée** : le §1 posait `provider_id`, `status`, `offered_at`… sur
`menage_events`. Cette table est un **journal de notifications**, écrit par
`lib/cleaning/sync-menages.js` **une fois par prestataire notifiée et par type
d'événement** — mesuré en production : 168 lignes pour 151 couples (bien,
réservation), dont 156 `new`, 7 `modified`, 5 `note`. Greffer un cycle de vie
dessus donnerait plusieurs lignes concurrentes pour le même ménage, chacune avec
son statut : le statut du ménage serait indéterminé. C'est la faute du double
writer de `public_tokens.property_ids` (CLAUDE.md), et `lib/cron-rattacher-menages.js`
la constate déjà : *« DEUX TOKENS = deux prestataires notifiées : on ne devine
pas laquelle a préparé le séjour. »*

Le ménage n'existait nulle part : la PWA le **dérivait** de
`bookings_snapshot.departure`. Il devient une ligne, avec l'identité déjà
utilisée partout — celle de `menage_done` :

```
menages (user_id, property_id, booking_id, departure_date)  -- unique
```

⚠️ `property_id` est du **TEXT** (`provider_property_id`), comme
`menage_events`, `menage_done` et `bookings_snapshot` — REVIEW.md règle 10. Pas
d'UUID ici, sans quoi les biens Beds24 et Channex ne joignent plus.

**Writer unique** : la couche sync, à partir de `bookings_snapshot`. Aucune app
n'écrit un ménage. C'est la règle du cœur de données appliquée telle quelle.

**Ce qui NE va PAS dans `menages`** : le fait que le ménage soit *fait*.
`menage_done` reste la seule vérité sur ce point — writer existant (la PWA), file
hors ligne qui en dépend, 118 lignes en production. Deux vérités sur « c'est
fait » seraient pires que la duplication qu'on vient de supprimer. Les
`started_at` / `completed_at` du §1 viendront avec les boutons « je commence » /
« terminé », et **le writer sera à trancher à ce moment-là**, pas avant.

### 11.2 Assignation — rang, puis les trois modes

Liaison `property_cleaning_providers (property_id, provider_id, rang, active)`.

**Cible inchangée** : les trois modes du §3 (`priorite`, `jour`, `quota`) et les
disponibilités RRULE du §2 restent l'objectif. La colonne
`properties.cleaning_assignment_mode` est posée **dès le premier lot** pour ne
pas migrer deux fois, mais seul `priorite` est implémenté en V1.

**Règle de départ** : Régina **rang 1 (référente)** sur les deux biens de
Bagnères ; la nouvelle **rang 2 (suppléante)**. Le rythme « week-ends, une
semaine sur deux » attend le mode `jour` ; d'ici là, **réassignation manuelle**.

### 11.3 Règle d'engagement — décision du 3 septembre 2026

**Elle précise le §3 bis, qui traitait toutes les candidates de la même façon.**

- **Le référent (rang 1) est assigné d'office.** L'assignation vaut engagement,
  aucune confirmation — c'est le fonctionnement actuel de Régina, et rien ne
  change pour elle. Le ménage naît `accepted`.
- **Le suppléant (rang 2+) doit confirmer.** Une assignation vers lui naît
  `offered` ; il l'accepte depuis sa PWA. C'est la boucle offre/acquittement du
  §3 bis, **déclenchée uniquement pour les non-référents**.

Ce qui reste reporté du §3 bis : l'escalade automatique en cascade, les délais
d'expiration et la ré-alerte périodique. Les statuts `offered` / `accepted` sont
posés dès le premier lot pour que cette suite s'ajoute sans migration.

**Acceptation atomique**, conservée du §3 bis — c'est la garde anti double
affectation, elle ne se reporte pas :
```sql
update menages set status='accepted', accepted_at=now()
 where id=? and status='offered' and provider_id=?
```
0 ligne modifiée = l'offre n'est plus valide.

### 11.4 Aucun forçage

Chaque bien a toujours un référent (le rang 1 actif). Si « personne
d'assignable » survient malgré tout, le ménage reste **non assigné** — jamais de
repli sur quelqu'un — et l'hôte est alerté par le canal d'alerte existant.
C'est le pendant, côté assignation, de la règle de souplesse du §6 : *un avis non
attribuable reste non attribué*.

### 11.5 PWA — chacune ne voit que ses ménages

Le filtre passe **du bien à la personne** : `menages.provider_id` = le profil
derrière le token, et non plus `public_tokens.property_ids`. Sans ce changement,
deux prestataires sur un même bien verraient chacune tous les ménages de l'autre.

La file hors ligne n'a pas à changer : elle envoie déjà
`(booking_id, property_id, departure_date)`, qui est l'identité du ménage.

### 11.6 Écran hôte

⚠️ **Dette à régler dans ce lot** : le « marquer fait » de `apps/menages/index.html`
ne vit que dans le `localStorage` du navigateur et n'écrit jamais `menage_done`,
que la PWA alimente pourtant (défaut écrit en clair dans son code). L'hôte ne
voit donc pas ce que la prestataire a fait — « qui fait quoi » serait faux dès le
premier écran.

Vue cible : le planning existant, la prestataire assignée sur chaque ménage, et
un sélecteur de réassignation (deux clics) qui écrit `assigned_by='manual'` et
une ligne de `menage_assignment_log`. Un ménage `manual` n'est jamais réassigné
par l'automate — verrou du §3, conservé.

### 11.7 Attribution des avis

`lib/attribution-prestataire.js` voie 1 passe du `pwa_token` au
`menages.provider_id`. `lib/cron-rattacher-menages.js` cesse de renoncer sur deux
tokens : l'avis pointe le ménage, le ménage porte la prestataire.
`prestataire_periodes` reste l'exception rétroactive bornée du §6.

### 11.8 Reprise de l'existant

Les 118 `menage_done` et les 168 `menage_events` portent **tous** le token de
Régina. Les 118 ménages faits lui sont rattachés rétroactivement — fait établi
par le product owner, confirmé le 3 septembre 2026. **La reprise s'arrête à
l'arrivée de la seconde prestataire** : après, seul le lien au ménage dit qui a
préparé quel séjour (§6).

⚠️ **À vérifier avant de s'y appuyer** : la chaîne de notification n'a jamais
rien produit pour Tiphaine — 168 `menage_events` sur 168 sont à Régina, alors que
le token de Tiphaine existe.

**Tiphaine** reste une identité d'attribution historique : profil inactif, sans
`pwa_token`, sans accès. Rien ne change pour elle.

### 11.9 Découpage en lots

| Lot | Contenu | Écrans touchés |
|---|---|---|
| **2.1** | Table `menages` + `property_cleaning_providers` + RLS + writer sync + reprise des 118 + assignation par rang | aucun |
| **2.2** | PWA filtrée par prestataire + acceptation du suppléant | PWA |
| **2.3** | Écran hôte : qui fait quoi, réassignation 2 clics, « fait » branché sur `menage_done` | app ménage |
| **2.4** | Attribution des avis par `provider_id` | — |
| **2.5** | Profil et lien PWA de la nouvelle prestataire, rang 2 | équipe et droits |

⚠️ **2.5 vient après 2.2, et pas avant** : lui ouvrir un accès pendant que la PWA
filtre encore par bien lui montrerait tous les ménages de Régina.

## 12. Lot 3 — l'assignation automatique, par JOURNÉE (conception gravée le 4 septembre 2026)

Thierry ne veut pas assigner à la main. Ce lot rend l'assignation automatique —
mais il révise d'abord la façon dont on désigne qui fait quoi.

### 12.1 Le prisme : la responsable DU JOUR

⚠️ **« Référente d'un bien » n'existe plus comme statut.** C'est l'apparence
qu'a une personne attitrée sur tous les jours. La référence est **par journée** :

> Pour chaque **bien** et chaque **jour**, la **responsable effective** est la
> première — par rang croissant — parmi les personnes **attitrées ce jour-là**
> (`weekdays`) **et disponibles** (règles RRULE + exceptions).

**`weekdays` vide ou NULL = attitrée tous les jours.** C'est ce qui rend le
modèle rétrocompatible sans aucune migration de données : Régina, sans
`weekdays`, est de garde tous les jours sur ses deux biens — exactement l'état
actuel.

**Conséquence : le « mode » du bien disparaît.** `priorite` n'était pas un mode
concurrent de `jour`, c'était le cas particulier où personne n'a de jours
attitrés. Un seul algorithme suffit. `properties.cleaning_assignment_mode` reste
en base, **dormante**, pour le jour où `quota` arrivera — le seul vrai mode
alternatif. Le rang, lui, ne sert plus qu'à **départager et remplacer**.

### 12.2 La garde est CALCULÉE, jamais stockée

Décision du 4 septembre 2026. `responsableDuJour(bien, date)` est une **fonction
pure** : l'écran l'appelle pour la semaine affichée, le moteur à la création d'un
ménage. **Aucune table `garde_jour`.**

⚠️ **Pourquoi.** Une garde stockée est de la donnée dérivée persistée : elle
diverge dès qu'une règle change entre deux cycles, et rien ne le signale. Ce
dépôt a payé ce prix deux fois — snapshots fantômes, double writer de
`public_tokens`. L'exigence « la remplaçante est en place avant même qu'une
réservation tombe » est satisfaite sans stockage : elle **est** déterminée pour
n'importe quel jour futur, à tout instant. Ne pas être stockée ne veut pas dire
ne pas être décidée.

Une table ne se justifiera que le jour où l'on voudra l'**historique** de qui
était de garde — pas maintenant.

### 12.3 `requires_ack` est une propriété de la LIAISON, pas du rang

Avec le prisme par journée, « d'office ou doit confirmer » ne se déduit plus du
rang : une attitrée du week-end en rang 2 ne doit pas être condamnée à confirmer
pour toujours. La colonne vit donc sur `property_cleaning_providers`.

- `requires_ack = false` → elle **porte** le ménage d'office.
- `requires_ack = true` → elle reçoit une **proposition** (modèle parallèle §11.3).

**Reprise** : toutes les liaisons de rang 1 passent à `false` — c'est leur
comportement actuel, rien ne change pour personne. Les rangs 2+ restent à `true`.
Le jour où une suppléante est rodée : **un booléen à basculer, pas une
migration**.

### 12.4 L'invariant de la porteuse, appliqué au jour

Celui du §11 tient tel quel, appliqué à la responsable du jour :

> Le ménage est **porté** par la première candidate qui n'a rien à confirmer.
> Il est **proposé** à la responsable du jour si elle est différente.

Déroulé du cas réel — samedi, Régina attitrée tous les jours (`requires_ack`
false), la seconde attitrée le week-end (`requires_ack` true) :

| Moment | Porteuse | Proposé à |
|---|---|---|
| Création | Régina | la seconde |
| Acceptation | la seconde | — (transfert) |
| Refus / expiration | Régina | — (l'escalade retombe sur elle, qui porte déjà) |
| Samedi de semaine « off » | Régina | personne (indisponible → hors candidates) |
| Mardi | Régina | personne (pas attitrée ce jour-là) |

**Aucun état sans porteuse**, et l'escalade se termine d'elle-même. Le seul cas
où personne ne porte : aucune candidate `requires_ack = false` — c'est le
`offered` du §11, déjà géré.

### 12.5 Congé déclaré APRÈS l'assignation

- Ménage **proposé** → recalculé. Rien n'est engagé.
- Ménage **accepté** → **jamais défait automatiquement**. L'hôte est alerté et
  tranche. ⚠️ Un engagement ne se défait que par un humain.
- Ménage **verrouillé** (`assigned_by='manual'`) → jamais recalculé, comme partout.

### 12.6 Trou de garde : visible, mais pas alerté

Un bien n'a pas de ménage tous les jours. Alerter sur chaque jour sans
responsable noierait les vraies alertes.

- **L'écran** montre les trous, y compris les jours sans réservation — c'est ce
  qui permet de voir venir.
- **L'alerte** ne part que si un **ménage existe** ce jour-là sans personne.

### 12.7 Fuseaux et conventions

- `weekdays` : **0 = dimanche … 6 = samedi**, lu avec `getUTCDay()`. Le
  samedi-dimanche s'écrit `[0, 6]`.
- ⚠️ Une RRULE raisonne en **instants**, une garde en **jours de calendrier**.
  Tout est normalisé à **midi UTC** — pas minuit, qui bascule de jour au moindre
  décalage. C'est le piège déjà corrigé deux fois sur les dates de séjour et sur
  le planning.
- ⚠️ **Jamais de récurrence codée à la main** : la lib npm `rrule`. Décision
  gravée du §2.

### 12.8 Découpage

| Lot | Contenu | Écrans |
|---|---|---|
| **3.1** | Tables de disponibilité, `rrule`, `requires_ack`, `availability.js` + tests. Rien de branché. | aucun |
| **3.2** | `lib/cleaning/garde.js` : `responsableDuJour()` / `planningDeGarde()`. Fonctions pures. | aucun |
| **3.3** | ✅ **LIVRÉ** (4 septembre 2026) — le moteur consomme la garde : création, changement de date, refus/expiration → remplaçante, `requires_ack` interprété partout, la proposition notifie, alerte sur trou de garde. | — |
| **3.4** | Écran **planning de garde** : semaine × biens, qui est de garde, ménages posés dessus. | app ménage |
| **3.5** | Jours attitrés et disponibilités côté hôte, « Mes disponibilités » dans la PWA. | 2 écrans |

**Qui déclare les congés** : la prestataire (`self_availability: write`), l'hôte
voit tout et corrige.

### 12.9 Ce que le lot 3.3 a tranché en plus (4 septembre 2026)

Deux points que le §12 laissait ouverts, et que l'implémentation a dû fermer.

**(a) La file de proposition, ce sont les candidates qui doivent confirmer** — pas seulement
celles placées avant la porteuse dans le classement du jour. Le tableau du §12.4 dit
« Création : portée par Régina, proposée à la seconde », alors que Régina est **rang 1 ET**
d'office : lire l'invariant au pied de la lettre (« proposée à la première du classement si
différente ») ne proposait plus jamais rien sur le seul cas réel du dépôt. Proposition et
escalade seraient nées mortes. La porteuse reste la première `requires_ack = false` ; la file
est la suite des candidates du jour qui doivent confirmer, moins celles que le journal connaît.

**(b) La proposition est POSÉE À L'APPROCHE DU DÉPART, pas à la création** — fenêtre de
**7 jours** (`JOURS_PROPOSITION`), job `poserPropositionsDues` dans le cron. Deux raisons, et
chacune suffirait :
- une proposition expire en **48 h** au plus. Posée à la création d'un départ dans six mois,
  elle serait morte deux jours plus tard, la file serait épuisée, et la responsable du jour
  n'aurait **plus jamais** l'occasion de prendre ce ménage ;
- le writer balaye **J−30/J+180**. Proposer à la création aurait envoyé, à la première
  activation d'un compte Channex, **un SMS par réservation future de l'historique** — REVIEW.md
  règle 2, la faute exacte qui a produit les messages « bienvenue » à des voyageurs partis.

Entre la création et la fenêtre, **personne n'est découvert** : la porteuse a le ménage depuis
le premier instant. C'est l'invariant du §12.4 qui rend ce report possible.

Corollaire : ce même job est le **chemin d'escalade** après une expiration. Le refus, lui,
escalade tout de suite — dans le même update que le refus, pour qu'il n'existe aucun instant où
le ménage soit à la fois refusé et sans proposition.

**(c) On ne propose qu'aux liaisons dont les `weekdays` sont explicitement
réglés** — décision du product owner, 4 septembre 2026, **à revoir au lot 3.5**.

`weekdays` vide vaut « attitrée tous les jours » (§12.1), et c'est ce qui rend le
modèle rétrocompatible sans migration. Mais tant qu'aucun écran ne permet de
régler ces jours, **toute** liaison à `requires_ack = true` est candidate à chaque
départ : elle recevrait une proposition, donc un SMS, par ménage — pour des jours
qu'elle n'a jamais déclaré prendre. Le défaut est donc le **silence**.

Portée exacte, et elle est étroite :
- la restriction ne vaut que pour la **proposition**. Elle ne retire personne des
  candidates : une liaison sans jours reste attitrée tous les jours pour tout le
  reste, et **la porteuse d'office n'est pas concernée** — elle ne confirme rien.
  Régina, sans `weekdays`, porte ses ménages exactement comme avant ;
- ⚠️ quand la restriction laisse un ménage que **personne ne porte** (aucune
  candidate d'office, et aucune aux jours réglés), l'hôte **est alerté** avec ce
  motif précis. Le silence porte sur le SMS, pas sur le fait qu'un logement n'a
  personne — sans cela, un ménage restait sans personne sans que rien ne le
  signale, et il n'y avait même pas de trou de garde à voir puisque des
  candidates existent. Le statut reste `unassigned` (jamais `orphaned`, qui
  verrouille) : le jour où l'hôte règle les jours, le rattrapage du writer
  reprend ce ménage tout seul, sans geste.

**Le quota reste reporté** — il suppose de compter les ménages réalisés sur 30
jours par personne et par bien, pour un besoin qui n'existe pas à deux
prestataires. `quota_share` est déjà en base : aucune migration le jour venu.
