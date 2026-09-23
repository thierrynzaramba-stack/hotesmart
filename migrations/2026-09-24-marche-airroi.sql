-- Chantier V2 « nouveau bien sans historique »,
-- lots V2.1 et V2.5.
-- Cadrage : docs/kb/chantier-nouveau-bien.md.
--
-- ⚠ LIGNES COURTES VOLONTAIRES : ce SQL se colle a la
-- main dans l'editeur Supabase, qui tronque au-dela de
-- 60 caracteres (constate 3 fois).
--
-- ADDITIVE : ajoute des colonnes NULLABLES a properties
-- et quatre tables neuves. Ne modifie ni ne supprime rien.
--
-- La V2 est une INFORMATION PARALLELE : aucune de ces
-- tables n'est lue par le moteur de prix ni par le
-- pilote. Elles ne poussent aucun prix.
--
-- Writers (un par table) :
--   properties.latitude/longitude : saisie (SQL, puis
--     ecran V2.2) — jamais une app
--   airroi_cache, airroi_appels : lib/airroi/client.js
--   comparables_retenus : saisie (SQL, puis V2.4)
--   grille_controle : lib/marche/controle.js

-- ─── 1. Coordonnees du bien ─────────────────────────────
-- Ecartees le 8 septembre, reintroduites : sans elles,
-- AirROI ne trouve ni le marche ni les comparables.
alter table public.properties
  add column if not exists latitude numeric(9,6);
alter table public.properties
  add column if not exists longitude numeric(9,6);
-- D'ou viennent-elles : l'annonce Airbnb (position
-- exacte ou decalee), une saisie, un geocodage.
alter table public.properties
  add column if not exists coords_source text;
-- L'annonce Airbnb du bien, en TEXTE : les
-- identifiants Airbnb depassent 2^53 et un nombre
-- JavaScript les arrondit (992723390568420450 devient
-- 992723390568420500 — une AUTRE annonce).
alter table public.properties
  add column if not exists airbnb_listing_id text;

alter table public.properties
  drop constraint if exists properties_latitude_chk;
alter table public.properties
  add constraint properties_latitude_chk
  check (latitude is null
    or latitude between -90 and 90);
alter table public.properties
  drop constraint if exists properties_longitude_chk;
alter table public.properties
  add constraint properties_longitude_chk
  check (longitude is null
    or longitude between -180 and 180);
alter table public.properties
  drop constraint if exists properties_coords_src_chk;
alter table public.properties
  add constraint properties_coords_src_chk
  check (coords_source is null or coords_source in (
    'annonce_exacte', 'annonce_decalee',
    'saisie', 'geocodage'));
alter table public.properties
  drop constraint if exists properties_airbnb_id_chk;
alter table public.properties
  add constraint properties_airbnb_id_chk
  check (airbnb_listing_id is null
    or airbnb_listing_id ~ '^[0-9]{1,24}$');

-- ─── 2. Cache des reponses AirROI ───────────────────────
-- Une ligne par requete canonique (endpoint + parametres
-- tries). La reponse est gardee en TEXTE brut : jsonb
-- relu par le client JavaScript arrondirait les
-- identifiants d'annonce (voir ci-dessus).
create table if not exists public.airroi_cache (
  cle text primary key,
  endpoint text not null,
  parametres jsonb not null,
  reponse text not null,
  recupere_le timestamptz not null default now(),
  cout_usd numeric(6,3) not null default 0
);
create index if not exists airroi_cache_endpoint_idx
  on public.airroi_cache (endpoint, recupere_le);

-- ─── 3. Journal des appels PAYANTS ──────────────────────
-- Append-only. Sert les garde-fous de cout : budget
-- mensuel global, plafond par compte, une etude par bien
-- tous les 90 jours. Un appel servi par le cache n'y
-- entre pas (il ne coute rien).
create table if not exists public.airroi_appels (
  id bigint generated always as identity primary key,
  endpoint text not null,
  cle text not null,
  cout_usd numeric(6,3) not null,
  user_id uuid,
  property_id uuid
    references public.properties(id)
    on delete set null,
  statut text not null check (statut in (
    'ok', 'erreur')),
  http integer,
  created_at timestamptz not null default now()
);
create index if not exists airroi_appels_mois_idx
  on public.airroi_appels (created_at);
create index if not exists airroi_appels_compte_idx
  on public.airroi_appels (user_id, created_at);
create index if not exists airroi_appels_bien_idx
  on public.airroi_appels (property_id, created_at);

-- ─── 4. Comparables retenus, par bien ───────────────────
-- La liste de listing_id d'ou part le calcul, quelle que
-- soit son origine (Thierry aujourd'hui, l'ecran de
-- selection V2.4 demain).
create table if not exists public.comparables_retenus (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  property_id uuid not null
    references public.properties(id)
    on delete cascade,
  listing_id text not null
    check (listing_id ~ '^[0-9]{1,24}$'),
  retenu_par text not null check (retenu_par in (
    'fondateur', 'proprietaire')),
  actif boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  unique (property_id, listing_id)
);

-- ─── 5. Le controle permanent (V2.5) ────────────────────
-- Trois jeux de niveaux cote a cote. L'ecart qui JUGE la
-- methode : marche contre MESUREE 12 MOIS (memes
-- fenetres). Rien ne le lit pour fixer un prix.
create table if not exists public.grille_controle (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  property_id uuid not null
    references public.properties(id)
    on delete cascade,
  releve_le timestamptz not null default now(),
  motif text not null check (motif in (
    'rafraichissement', 'mensuel', 'manuel')),
  source text not null default 'marche'
    check (source = 'marche'),
  statut text not null check (statut in (
    'fiable', 'reference_amincie',
    'attente_dette_26')),
  fenetre_debut date not null,
  fenetre_fin date not null,
  niveaux_mesure_3ans jsonb,
  niveaux_mesure_12m jsonb,
  niveaux_marche jsonb,
  ecarts jsonb,
  nuits_mesure_12m integer,
  nuits_marche integer,
  comparables jsonb,
  avertissements jsonb,
  fraicheur_marche timestamptz
);
create index if not exists grille_controle_bien_idx
  on public.grille_controle (property_id, releve_le);

comment on table public.grille_controle is
  'Controle permanent V2.5 : grille mesuree 3 ans, '
  'mesuree 12 mois, marche. Information parallele, '
  'lue par aucun moteur. Regle 19 : critere avant '
  'premiere lecture.';

-- ─── RLS ────────────────────────────────────────────────
-- Cache et journal : SERVEUR SEULEMENT (aucune policy :
-- la cle service les lit, personne d'autre).
alter table public.airroi_cache
  enable row level security;
alter table public.airroi_appels
  enable row level security;
revoke all on table public.airroi_cache
  from anon, authenticated;
revoke all on table public.airroi_appels
  from anon, authenticated;

-- Comparables et controle : l'hote lit les siens.
alter table public.comparables_retenus
  enable row level security;
drop policy if exists comparables_retenus_select
  on public.comparables_retenus;
create policy comparables_retenus_select
  on public.comparables_retenus
  for select to authenticated
  using (user_id = auth.uid());
revoke insert, update, delete
  on table public.comparables_retenus
  from anon, authenticated;

alter table public.grille_controle
  enable row level security;
drop policy if exists grille_controle_select
  on public.grille_controle;
create policy grille_controle_select
  on public.grille_controle
  for select to authenticated
  using (user_id = auth.uid());
revoke insert, update, delete
  on table public.grille_controle
  from anon, authenticated;

-- ─── Verification (a coller aussi) ──────────────────────
-- EMPREINTE : biens = 5 en production, 3 en staging.
-- Un resultat sans elle ne prouve rien.
select
  (select count(*) from public.properties)
    as biens,
  (select count(*) from information_schema.columns
     where table_name = 'properties'
     and column_name in ('latitude', 'longitude',
       'coords_source', 'airbnb_listing_id'))
    as colonnes_bien,
  (select count(*) from pg_class
     where relname in ('airroi_cache',
       'airroi_appels', 'comparables_retenus',
       'grille_controle')
     and relrowsecurity)
    as tables_rls,
  (select count(*) from pg_policies
     where tablename in ('comparables_retenus',
       'grille_controle'))
    as policies;
-- Attendu : biens 5 (prod) ou 3 (staging),
-- colonnes_bien 4, tables_rls 4, policies 2.
