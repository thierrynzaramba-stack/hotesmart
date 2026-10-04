-- 2026-10-04-marche-temperature-airroi.sql
-- Pipeline AirROI : le calendrier de temperature.
-- Spec : docs/kb/chantier-nouveau-bien.md §15.
--
-- Une ligne par marche, capture et jour. Facteurs
-- en base 100 : AUCUN prix en euros. Pipeline
-- ETANCHE : rien ici ne vient de l'historique.
-- Writer unique : lib/marche/temperature-airroi.js
-- (scripts/enregistrer-temperature-airroi.js).
-- Ajout seul : une capture ne se reecrit pas.
--
-- ⚠ LIGNES COURTES (editeur Supabase). Rejouable.
-- Aucun SELECT de verification ici.

create table if not exists
  public.marche_temperature_airroi (
  id bigint generated always as identity
    primary key,
  pays text not null,
  region text not null,
  localite text not null,
  capture_le date not null,
  jour date not null,
  prix_base100 numeric not null,
  saison numeric not null,
  semaine numeric not null,
  fete numeric not null,
  fete_nom text,
  demande numeric not null,
  ecart numeric not null,
  niveau text not null check (niveau in (
    'creux', 'modere', 'favorable', 'pic')),
  methode text not null,
  cree_le timestamptz not null default now(),
  unique (pays, region, localite,
          capture_le, jour, methode)
);

create index if not exists
  marche_temperature_airroi_capture_idx
  on public.marche_temperature_airroi
  (pays, region, localite, capture_le desc);

comment on table
  public.marche_temperature_airroi is
  'Pipeline AirROI (§15) : niveau de chaque jour '
  'selon le modele AirROI, base 100, aucun prix. '
  'Etanche : jamais melange a l historique.';

alter table public.marche_temperature_airroi
  enable row level security;
revoke all on table
  public.marche_temperature_airroi
  from anon, authenticated;
revoke all on sequence
  public.marche_temperature_airroi_id_seq
  from anon, authenticated;

notify pgrst, 'reload schema';
