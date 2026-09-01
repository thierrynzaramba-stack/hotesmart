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

-- Assignation, cycle de vie et qualité sur les ménages
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

Dépendance : `npm install rrule`. Ne pas réimplémenter la récurrence.

`isAvailable(provider, date)` :
1. Une exception existe pour cette date → retourner sa valeur `available`.
2. Aucune règle active → disponible.
3. Sinon, disponible si au moins une règle matche : `rrulestr(rule.rrule).between(date, date, inclusive=true)` renvoie une occurrence.

Fonction pure, testable unitairement. Fuseaux horaires — piège classique : la **date du ménage est une date calendaire dans le fuseau du bien** (`Europe/Paris` en V1, à stocker sur `properties` dès maintenant pour l'avenir), dérivée du checkout dans ce fuseau, jamais du timestamp UTC serveur. Les règles RRULE et les requêtes `between` se font sur des dates calendaires normalisées (minuit UTC comme convention interne), jamais sur des timestamps réels.

Côté UI, l'hôte ne voit jamais la chaîne RRULE : le formulaire propose jours de la semaine + hebdo/une semaine sur deux + date de départ, et le code génère la chaîne (`new RRule({freq: WEEKLY, interval: 2, byweekday: [SA, SU], dtstart}).toString()`) et le `label`.

Bénéfice ultérieur (hors périmètre) : le format est iCal, donc un export du planning de chaque prestataire abonnable depuis Google Agenda devient trivial.

## 3. Moteur d'assignation — `lib/cleaning/assign.js`

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

- Le token identifie désormais un `profiles.pwa_token` (et non plus un token global). Un prestataire ne voit **que** ses ménages (`provider_id = lui`). Un token inconnu ou inactif → 401.
- Écran principal : les **offres en attente** en tête (badge « À confirmer », délai restant, badge « URGENT » si `priority='urgent'`), avec boutons « J'accepte » / « Je refuse » ; puis les ménages acceptés du jour et à venir.
- Sur un ménage accepté : boutons « Je commence » (`started_at`) et « Terminé » (`completed_at`) — deux clics, aucune saisie. C'est ce qui donnera la durée réelle par bien et par prestataire.
- Nouvel écran « Mes disponibilités » dans la PWA :
  - Voir ses règles récurrentes (lecture seule — c'est l'hôte qui les définit).
  - Déclarer une indisponibilité (date ou plage) → exceptions `available=false`.
  - Déclarer une disponibilité exceptionnelle → `available=true`.
- Endpoints correspondants scoped par token, jamais par user_id côté PWA.

## 5. Dashboard hôte

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
