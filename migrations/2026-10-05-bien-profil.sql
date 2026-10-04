-- 2026-10-05-bien-profil.sql
-- « Choisir vos comparables », etape A : le profil
-- du bien decrit par l'hote. Spec :
-- docs/kb/chantier-nouveau-bien.md §20.2.
--
-- Une ligne par bien. Table V2 NEUVE : rien n'est
-- ecrit dans properties (decision du 25/09/2026).
-- Writer unique : lib/marche/profil-bien.js
-- (api/marche-comparables.js). AUCUN prix.
-- Chambres = VRAIES chambres (une piece avec une
-- porte) ; un canape du salon n'en est pas une.
--
-- ⚠ LIGNES COURTES (editeur Supabase). Rejouable.
-- Aucun SELECT de verification ici.

create table if not exists public.bien_profil (
  id bigint generated always as identity
    primary key,
  user_id uuid not null,
  property_id uuid not null
    references public.properties(id)
    on delete cascade,
  adresse text not null,
  adresse_trouvee text not null,
  latitude numeric(9,6) not null
    check (latitude between -90 and 90),
  longitude numeric(9,6) not null
    check (longitude between -180 and 180),
  geocode_score numeric(4,3) not null
    check (geocode_score between 0 and 1),
  voyageurs smallint not null
    check (voyageurs between 1 and 30),
  chambres smallint not null
    check (chambres between 0 and 20),
  pieces smallint not null
    check (pieces between 1 and 30),
  salles_de_bain smallint not null
    check (salles_de_bain between 0 and 10),
  equipements text[] not null default '{}'
    check (equipements <@ array[
      'terrasse', 'spa', 'jardin', 'piscine',
      'parking', 'vue', 'climatisation'
    ]::text[]),
  maj_le timestamptz not null default now(),
  check (pieces >= chambres),
  unique (property_id)
);

comment on table public.bien_profil is
  'V2 §20 : le profil du bien decrit par l hote '
  '(adresse geocodee, taille, equipements) pour '
  'chercher et trier ses comparables. Aucun prix.';

alter table public.bien_profil
  enable row level security;
revoke all on table public.bien_profil
  from anon, authenticated;
revoke all on sequence
  public.bien_profil_id_seq
  from anon, authenticated;

notify pgrst, 'reload schema';
