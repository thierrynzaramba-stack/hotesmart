# Chantier : Profils et droits d'accès à la carte

## Contexte
Aujourd'hui HôteSmart connaît un seul acteur authentifié (le compte hôte, RLS `user_id = auth.uid()` partout) et un cas spécial (le prestataire de ménage, par token PWA, sans compte). Une conciergerie ne rentre pas dans un organigramme figé : on ne définit **pas de rôles fixes**, mais des **profils** auxquels le titulaire du compte attribue des droits à la carte, domaine par domaine.

Principes :
- **Un seul concept : le profil.** Employé, propriétaire d'un bien, prestataire de ménage, et le titulaire lui-même sont des profils.
- **Le prestataire est un profil** dont le mode d'accès est « lien PWA » plutôt que « compte ». Ses ménages, sa note qualité et les avis voyageurs rattachés à ses ménages font partie de sa fiche — ils ne sont pas dissociables de son profil.
- **Les droits sont attribués par le titulaire**, sur une page dédiée, pour chaque profil sauf le sien (non éditable, il a tout).
- Aucune modification de la clé `user_id` des tables existantes ; aucune migration de données.
- Toute nouvelle table (avis, planning prestataires) utilise `can_read` / `can_write` dès sa création.
- Pas de base de test séparée : les migrations s'exécutent sur la base prod, en deux temps (structures d'abord, politiques ensuite, par lots), avec un test réel via le compte test invité comme profil restreint.
- `docs/kb/profils-et-droits.md` dans le même commit.

## 1. Le modèle

### Table `profiles`
```sql
create table profiles (
  id uuid primary key default gen_random_uuid(),
  account_user_id uuid not null references auth.users(id) on delete cascade, -- le compte (= user_id des tables)
  member_user_id uuid references auth.users(id) on delete set null,          -- renseigné si accès par compte, null si accès par lien
  first_name text not null,
  last_name text,
  email text,
  phone text,
  access_mode text not null check (access_mode in ('compte','lien')),        -- compte = login ; lien = token PWA (prestataire)
  pwa_token text unique,                                                     -- si access_mode = lien
  is_owner boolean not null default false,                                   -- exactement un par compte, non éditable
  active boolean not null default true,
  invited_at timestamptz,
  accepted_at timestamptz,                                                   -- null = invitation en attente (mode compte)
  created_at timestamptz default now(),
  unique (account_user_id, member_user_id)
);
```
Le titulaire a une ligne `is_owner = true` créée automatiquement (migration pour les comptes existants). Elle porte son nom, sert d'identité dans les journaux (qui a réassigné un ménage, qui a noté), et n'est pas éditable sur la page des droits.

### Table `profile_permissions` — une ligne par profil
```sql
create table profile_permissions (
  profile_id uuid primary key references profiles(id) on delete cascade,
  account_user_id uuid not null references auth.users(id) on delete cascade,
  property_scope text not null default 'all' check (property_scope in ('all','selected')),
  property_ids uuid[],                     -- si selected : properties.id autorisés
  -- niveau par domaine : 'none' | 'read' | 'write'
  reservations text not null default 'none',
  menages text not null default 'none',
  prestataires text not null default 'none',
  messages text not null default 'none',
  avis text not null default 'none',
  reglages text not null default 'none',   -- automatisation, templates, connaissances
  facturation text not null default 'none',
  equipe text not null default 'none',     -- gérer les profils et leurs droits
  -- droits « sur soi-même » (surtout pour les prestataires)
  self_availability text not null default 'none',         -- 'none' : aucun écran, il passe par un gestionnaire ; 'read' : consulte ; 'write' : gère règles récurrentes ET exceptions
  self_view_reviews boolean not null default true,        -- voir sa propre note et ses avis
  updated_at timestamptz default now()
);
```
Contraintes : `check` sur chaque colonne de domaine et sur `self_availability` (`in ('none','read','write')`). `facturation` et `equipe` ne peuvent être `write` que pour l'owner — vérifié par la fonction, pas par la contrainte, pour garder le schéma simple.

### Modèles pré-remplis (côté front uniquement, jamais figés en base)
Trois presets qui remplissent le formulaire, tous modifiables ensuite :
- **Employé** : tous les biens, tout en `write` sauf facturation et équipe en `none`.
- **Propriétaire** : biens sélectionnés, réservations/ménages/messages/avis en `read`, le reste `none`.
- **Prestataire** : accès `lien`, tous les biens (ou sélection), aucun domaine (il ne voit que ses ménages via la PWA), `self_availability = 'write'`, `self_view_reviews = true`.
Un preset est un point de départ, pas un rôle : rien dans le code ne teste « est-ce un propriétaire ».

## 2. Fonctions d'accès

```sql
-- niveau effectif d'un utilisateur connecté sur un domaine d'un compte
create or replace function perm_level(row_user_id uuid, domain text)
returns text language sql stable security definer set search_path = public as $$
  select case
    when auth.uid() = row_user_id then 'write'                     -- titulaire : tout
    else coalesce((
      select case domain
        when 'reservations' then p.reservations
        when 'menages'      then p.menages
        when 'prestataires' then p.prestataires
        when 'messages'     then p.messages
        when 'avis'         then p.avis
        when 'reglages'     then p.reglages
        when 'facturation'  then p.facturation
        when 'equipe'       then p.equipe
      end
      from profiles pr join profile_permissions p on p.profile_id = pr.id
      where pr.account_user_id = row_user_id
        and pr.member_user_id = auth.uid()
        and pr.active and pr.accepted_at is not null
    ), 'none')
  end;
$$;

-- le bien de la ligne est-il dans le périmètre du membre ?
create or replace function in_scope(row_user_id uuid, row_property_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() = row_user_id
      or row_property_id is null
      or exists (
        select 1 from profiles pr join profile_permissions p on p.profile_id = pr.id
        where pr.account_user_id = row_user_id and pr.member_user_id = auth.uid()
          and pr.active and pr.accepted_at is not null
          and (p.property_scope = 'all' or row_property_id = any(p.property_ids))
      );
$$;

create or replace function can_read(row_user_id uuid, domain text, row_property_id uuid default null)
returns boolean language sql stable as $$
  select perm_level(row_user_id, domain) in ('read','write') and in_scope(row_user_id, row_property_id);
$$;

create or replace function can_write(row_user_id uuid, domain text, row_property_id uuid default null)
returns boolean language sql stable as $$
  select perm_level(row_user_id, domain) = 'write' and in_scope(row_user_id, row_property_id)
     and (domain not in ('facturation','equipe') or auth.uid() = row_user_id);
$$;
```

### Le pont property_id TEXT / UUID
Les tables enfants portent `property_id` en TEXT (`provider_property_id`), pas `properties.id`. Deux options, Claude Code choisit et documente, avec pour critère « une seule requête RLS, pas de sous-requête coûteuse par ligne » :
- surcharge `in_scope(row_user_id uuid, row_property_ref text)` qui résout via `properties` (index sur `(user_id, provider_property_id)` requis) ;
- ou stocker dans `profile_permissions.property_ids` les deux identifiants résolus à l'attribution (UUID et TEXT).

## 3. Réécriture des politiques RLS — par lots, sur les 27 tables

Chaque table est rattachée à **un domaine**. Livrable préalable : la liste des 27 tables avec leur domaine et le type de `property_id` (TEXT, UUID, absent), validée par Thierry avant le premier lot.

Pour chaque table à `user_id` :
- `select` : `using (can_read(user_id, '<domaine>', property_id))` — sans `property_id` pour les tables non rattachées à un bien.
- `insert/update/delete` : `using (can_write(user_id, '<domaine>', property_id))` + `with check` identique.
- Tables owner-only par nature (`accounts`, `profiles`, `profile_permissions`) : domaine `facturation` ou `equipe` → seule la fonction laisse passer le titulaire. Exception : un membre peut lire sa propre ligne `profiles`.

Test « aucune table oubliée » : requête sur `pg_policies` qui vérifie que chaque table à `user_id` a une politique utilisant `can_read`/`can_write`. Lots de 5–6 tables, un test réel après chaque lot (voir §7), puis lot suivant.

### Écritures serveur
Cron, webhooks et endpoints serverless écrivent en service key : rien ne change. Tout endpoint qui agit **au nom d'un utilisateur** (dashboard) vérifie `can_write(domaine, bien)` côté serveur avant d'écrire — la RLS ne protège que les accès directs Supabase.

## 4. Le prestataire comme profil (réconciliation avec la spec prestataires)

- `cleaning_providers` de la spec prestataires **disparaît** : un prestataire est un `profiles` avec `access_mode = 'lien'`. Les tables `property_cleaning_providers`, `provider_availability_rules`, `provider_availability_exceptions` et `menage_events.provider_id` référencent `profiles.id`.
- La PWA prestataire est scopée par `pwa_token` → `profiles.id`. Le prestataire ne voit que ses ménages.
- `self_availability` contrôle l'écran « Mes disponibilités » de la PWA : `none` → l'écran n'existe pas, un texte indique le gestionnaire à contacter (nom et téléphone du titulaire ou d'un profil désigné) ; `read` → règles et exceptions visibles, non modifiables ; `write` → le prestataire gère lui-même ses règles récurrentes et ses exceptions. Dans tous les cas, l'admin peut corriger depuis la fiche — il a toujours le dernier mot. C'est le titulaire qui décide, prestataire par prestataire.
- **Fiche prestataire** (dashboard, domaine `prestataires`) : identité, mode d'accès et lien PWA, biens, mode d'assignation par bien, disponibilités, et **section qualité non dissociable** : ménages effectués, note moyenne du titulaire, avis voyageurs rattachés à ses ménages (verdict propreté, extraits, note OTA), remarques propreté sur la période. C'est une seule page : on ne consulte pas un prestataire sans voir sa qualité.
- Migration Régina : profil `lien` avec son token actuel, `self_availability = 'write'` (à ajuster), `menage_events` passés rattachés à son profil.

## 5. Page « Équipe et droits » (domaine `equipe`, owner uniquement)

- Liste des profils : nom, mode d'accès, statut (actif / invitation en attente), résumé des droits.
- Création : prénom, nom, email, téléphone, mode d'accès. Mode `compte` → envoi d'un email d'invitation (Brevo, clé fondateur) ; mode `lien` → génération du token et affichage du lien PWA à transmettre.
- Édition des droits : périmètre de biens (tous / sélection), une ligne par domaine avec rien / lecture / écriture, et les droits « sur soi-même » : disponibilités (rien / lecture / écriture) et voir ses avis (oui / non). Bouton « appliquer un modèle » (employé / propriétaire / prestataire) qui pré-remplit sans verrouiller.
- Le profil du titulaire est affiché mais grisé : non éditable, tous droits.
- Désactivation : `active = false`, accès coupé immédiatement (compte et lien).

## 5 bis. Page « Répartition des ménages » (domaine `menages`, côté admin)

La vue de pilotage, distincte de la PWA prestataire :
- Calendrier par semaine : pour chaque jour, les prestataires disponibles (issus de leurs règles et exceptions), les ménages prévus avec leur statut (accepté / offre en attente avec délai restant / orphelin en rouge / terminé), et le prestataire attribué.
- Par bien : mode d'assignation (priorité / jours fixes / quota) et ses réglages, modifiables ici.
- Réassignation manuelle en un clic (passe par la boucle d'offre, `assigned_by = 'manual'`).
- Ce qu'un prestataire saisit dans sa PWA apparaît immédiatement ici ; ce que l'admin change ici apparaît immédiatement dans la PWA.
- Lecture seule pour un profil à `menages = 'read'`.

## 6. Front
- **Sélecteur de compte** si l'utilisateur est membre de plusieurs comptes (un propriétaire avec deux conciergeries). Le compte courant fixe le `user_id` de toutes les requêtes.
- **Masquage par droit** : le front charge `profile_permissions` du profil courant et cache ce qui est à `none`, passe en lecture seule ce qui est à `read`. Un membre ne doit jamais voir un bouton qui échouerait.
- Aucune régression pour un compte sans membre : comportement identique à aujourd'hui.

## 7. Tests (base prod, compte test comme cobaye)
- Le compte test (`thierrylapoule31@gmail.com`) est invité comme profil `compte` sur le compte prod avec : périmètre = un seul bien, réservations/ménages `read`, le reste `none`. Vérifier : il voit ce bien et ses réservations, pas les deux autres ; aucune écriture ne passe (RLS et endpoint) ; facturation et équipe invisibles.
- Puis passer `menages` à `write` : il peut réassigner un ménage sur son bien, pas sur un autre.
- Profil désactivé → accès coupé immédiatement. Invitation non acceptée → aucun accès.
- Prestataire `lien` : `self_availability = 'none'` → pas d'écran, message « contactez votre gestionnaire » ; `'read'` → lecture seule ; `'write'` → règles et exceptions éditables ; dans les trois cas il ne voit que ses ménages.
- Non-régression owner seul sur les parcours principaux.
- Test « aucune table oubliée ».

## 8. Hors périmètre
- Journal d'audit des actions par profil (le journal des ménages existe déjà, le reste plus tard).
- Facturation par siège.
- Droits par bien différenciés par domaine (un membre en écriture sur le bien A et en lecture sur le bien B) : le modèle a un seul périmètre de biens par profil.

## Ordre d'exécution

> ✅ **CHANTIER CLOS le 2 septembre 2026** — étapes 0 à 5 livrées et validées en
> production. L'étape 6 est **fusionnée dans le chantier prestataires**.
> Bilan, dettes et leçons : `docs/kb/profils-et-droits.md` §12.

0. ✅ Livrable préalable : liste des 27 tables avec domaine et type de `property_id` ; choix du pont TEXT/UUID. Validation Thierry.
1. ✅ Migration structures (tables `profiles`, `profile_permissions`, fonctions, index, création du profil owner pour chaque compte existant, migration de Régina). Aucune politique modifiée — impact zéro.
2. ✅ Politiques RLS par lots de 5–6 tables, test réel après chaque lot.
3. ✅ Vérification `can_write` dans les endpoints serverless utilisateur.
4. ✅ Page Équipe et droits + invitations + génération de lien PWA.
5. ✅ Sélecteur de compte + masquage par droit.
6. ➡️ **Reporté au chantier prestataires** — fiche prestataire avec section qualité (les données avis arrivent avec le chantier avis ; la section affiche « — » tant qu'elles n'existent pas).
7. ✅ KB + commit.
