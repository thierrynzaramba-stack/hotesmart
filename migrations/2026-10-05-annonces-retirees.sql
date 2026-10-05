-- 2026-10-05-annonces-retirees.sql
-- Les annonces RETIREES d'Airbnb : elles ne
-- s'affichent plus. Spec :
-- docs/kb/chantier-nouveau-bien.md §22.9.
--
-- Une annonce retiree l'est pour TOUS les biens :
-- une table commune, une ligne par annonce.
-- Constat : le calendrier en ligne d'AirROI
-- repond 404 (non facture). Writer unique :
-- lib/marche/annonces-retirees.js, appele par
-- api/marche-comparables.js (cle service).
-- Aucun prix.
--
-- ⚠ LIGNES COURTES (editeur Supabase). Rejouable.

create table if not exists
  public.airroi_annonces_retirees (
  listing_id text primary key
    check (listing_id ~ '^[0-9]{1,24}$'),
  constatee_le timestamptz not null
    default now(),
  http smallint not null
    check (http between 400 and 499)
);

comment on table public.airroi_annonces_retirees
  is 'V2 §22.9 : annonce retiree d Airbnb '
     '(AirROI 404). Ne s affiche plus. Aucun prix.';

alter table public.airroi_annonces_retirees
  enable row level security;
revoke all on table
  public.airroi_annonces_retirees
  from anon, authenticated;

notify pgrst, 'reload schema';
