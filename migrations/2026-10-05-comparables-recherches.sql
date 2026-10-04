-- 2026-10-05-comparables-recherches.sql
-- « Choisir vos comparables » : le QUOTA des
-- recherches nouvelles, ATOMIQUE. Spec :
-- docs/kb/chantier-nouveau-bien.md §20.6.
--
-- Pourquoi (review de 7ace057, SECURITE) : lire le
-- journal puis payer n'est pas atomique ; 60
-- requetes paralleles passaient toutes. Ici, la
-- fonction COMPTE et RESERVE dans la meme
-- transaction, sous un verrou : deux requetes ne
-- passent jamais ensemble. Les etudes du
-- fondateur n'y entrent pas (compteur distinct).
-- Writer unique : la fonction ci-dessous, appelee
-- par api/marche-comparables.js (cle service).
--
-- ⚠ LIGNES COURTES (editeur Supabase). Rejouable.

create table if not exists
  public.comparables_recherches (
  id bigint generated always as identity
    primary key,
  user_id uuid not null,
  property_id uuid not null
    references public.properties(id)
    on delete cascade,
  cree_le timestamptz not null default now()
);

create index if not exists
  comparables_recherches_cree_le_idx
  on public.comparables_recherches (cree_le);

comment on table public.comparables_recherches
  is 'V2 §20.6 : une ligne par recherche AirROI '
     'NOUVELLE d un hote (quota). Aucun prix.';

alter table public.comparables_recherches
  enable row level security;
revoke all on table
  public.comparables_recherches
  from anon, authenticated;
revoke all on sequence
  public.comparables_recherches_id_seq
  from anon, authenticated;

-- Rend 'ok' (et reserve) ou le plafond atteint :
-- 'mois', 'bien', 'compte', 'compte_mois'.
create or replace function
  public.reserver_recherche_comparables(
    p_user uuid,
    p_property uuid,
    p_bien_jour int,
    p_compte_jour int,
    p_compte_30j int,
    p_tous_mois int)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  -- Un seul a la fois, tous comptes : le
  -- compte et la reservation sont atomiques.
  perform pg_advisory_xact_lock(
    hashtext('comparables_recherches'));
  select count(*) into n
    from comparables_recherches
    where cree_le >=
      date_trunc('month', now(), 'UTC');
  if n >= p_tous_mois then
    return 'mois';
  end if;
  select count(*) into n
    from comparables_recherches
    where property_id = p_property
      and cree_le > now() - interval '24 hours';
  if n >= p_bien_jour then
    return 'bien';
  end if;
  select count(*) into n
    from comparables_recherches
    where user_id = p_user
      and cree_le > now() - interval '24 hours';
  if n >= p_compte_jour then
    return 'compte';
  end if;
  select count(*) into n
    from comparables_recherches
    where user_id = p_user
      and cree_le > now() - interval '30 days';
  if n >= p_compte_30j then
    return 'compte_mois';
  end if;
  insert into comparables_recherches
    (user_id, property_id)
    values (p_user, p_property);
  return 'ok';
end;
$$;

revoke all on function
  public.reserver_recherche_comparables(
    uuid, uuid, int, int, int, int)
  from public, anon, authenticated;

notify pgrst, 'reload schema';
