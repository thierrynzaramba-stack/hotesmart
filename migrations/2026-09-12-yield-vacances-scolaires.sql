-- Etape 2 de YieldFlow, lot 2.3 : les VACANCES SCOLAIRES.
-- Spec : docs/specs/spec-yieldflow-v1.md §5
-- Import : node scripts/importer-vacances-scolaires.js
-- Verification : node scripts/verifier-yield-evenements.js
--
-- ⚠ LIGNES COURTES VOLONTAIRES : l'editeur SQL de Supabase
-- tronque les lignes longues au copier-coller.
--
-- IMPORTEES ET CACHEES DANS LE COEUR, jamais interrogees a
-- la volee par le moteur (regle d'architecture : provider
-- -> coeur -> apps). Les calendriers officiels sont publies
-- des ANNEES a l'avance et ne bougent pratiquement jamais :
-- un import one-shot et un rafraichissement rare suffisent.
-- Interroger data.education.gouv.fr a chaque calcul
-- rendrait le moteur dependant d'un tiers pour une donnee
-- qui ne change pas.
--
-- POURQUOI LES TROIS ZONES, et pas seulement celle du bien.
-- Un logement toulousain (zone C) accueille des Parisiens
-- (zone C) mais aussi des Lyonnais (zone A) et des Lillois
-- (zone B). La demande depend des vacances de TOUTES les
-- zones, pas de celle du bien. C'est meme l'interet du
-- signal : savoir quelle zone remplit quel bien.
--
-- ADDITIVE : cree une table, ajoute une colonne nullable.

create table if not exists public.school_holidays (
  id uuid primary key default gen_random_uuid(),

  -- 'A' | 'B' | 'C' — la zone officielle, pas l'academie.
  -- Les academies d'une meme zone partagent leurs dates ;
  -- garder l'academie multiplierait les lignes par cinq
  -- sans rien ajouter.
  zone text not null check (zone in ('A', 'B', 'C')),

  -- '2025-2026'. Sert au rafraichissement : on remplace une
  -- annee entiere, jamais une ligne isolee.
  annee_scolaire text not null,

  -- 'Vacances de la Toussaint', 'Pont de l'Ascension'...
  nom text not null,

  -- ⚠ BORNES INCLUSES, EN HEURE LOCALE.
  -- La source sert des instants UTC dont le decalage VARIE
  -- (22:00 l'ete, 23:00 l'hiver) : un `slice(0,10)` naif
  -- decalerait toutes les dates d'un jour. Et sa `end_date`
  -- est le jour de la RENTREE, pas le dernier jour de
  -- vacances : on stocke la veille.
  date_debut date not null,
  date_fin date not null,

  importe_le timestamptz not null default now(),

  constraint school_holidays_periode_valide
    check (date_fin >= date_debut)
);

-- Une meme periode ne peut entrer qu'une fois par zone.
-- L'import est ainsi rejouable sans produire de doublons,
-- et la source elle-meme en contient (une ligne par
-- academie d'une meme zone).
create unique index if not exists
  school_holidays_unique_idx
  on public.school_holidays (zone, nom, date_debut);

-- Lecture du moteur : periodes croisant une fenetre.
create index if not exists school_holidays_periode_idx
  on public.school_holidays (date_debut, date_fin);

comment on table public.school_holidays is
  'Vacances scolaires officielles par zone, importees et '
  'cachees. Bornes INCLUSES, heure locale : date_fin est '
  'le DERNIER jour de vacances, pas la rentree.';

-- ─── La zone de chaque bien ─────────────────────────────
-- Deduite du departement, MODIFIABLE ensuite :
-- un hote sait mieux que nous de quelle zone viennent ses
-- voyageurs. Nullable : un bien hors de France n'en a pas.
alter table public.properties
  add column if not exists zone_scolaire text;

alter table public.properties
  drop constraint if exists properties_zone_scolaire_check;
alter table public.properties
  add constraint properties_zone_scolaire_check
  check (zone_scolaire is null
         or zone_scolaire in ('A', 'B', 'C'));

comment on column public.properties.zone_scolaire is
  'Zone de vacances scolaires du bien (A, B ou C), deduite '
  'du departement puis modifiable. Ne limite PAS le '
  'moteur, qui lit les 3 zones : situe le bien.';

-- ─── RLS ────────────────────────────────────────────────
-- Regle 5. Donnee PUBLIQUE (calendrier officiel) : tout
-- compte authentifie peut la lire, aucun ne peut l'ecrire.
-- L'import passe par la service key.
alter table public.school_holidays
  enable row level security;

drop policy if exists school_holidays_select
  on public.school_holidays;
create policy school_holidays_select
  on public.school_holidays
  for select to authenticated
  using (true);

revoke insert, update, delete
  on table public.school_holidays
  from anon, authenticated;

-- ─── Verification ───────────────────────────────────────
select
  (select count(*) from public.school_holidays)
    as lignes,
  (select count(*) from pg_indexes
     where tablename = 'school_holidays')
    as index_poses,
  (select count(*) from pg_policies
     where tablename = 'school_holidays')
    as policies,
  (select relrowsecurity from pg_class
     where relname = 'school_holidays')
    as rls_active,
  (select count(*) from information_schema.columns
     where table_name = 'properties'
       and column_name = 'zone_scolaire')
    as colonne_zone;
