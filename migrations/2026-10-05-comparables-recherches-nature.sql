-- 2026-10-05-comparables-recherches-nature.sql
-- Le quota distingue les RECHERCHES et les
-- CALENDRIERS des comparables. Spec :
-- docs/kb/chantier-nouveau-bien.md §22.5.
--
-- Les calendriers (0,10 $ chacun, un par
-- comparable retenu) ont leur propre plafond :
-- 30 par bien sur 90 jours. Les plafonds par jour
-- ne comptent que les recherches. Le budget du
-- mois (somme des couts) les compte tous, sous le
-- MEME verrou. A coller APRES
-- 2026-10-05-comparables-recherches-cout.sql.
--
-- ⚠ LIGNES COURTES (editeur Supabase). Rejouable.

alter table public.comparables_recherches
  add column if not exists nature text
    not null default 'recherche'
    check (nature in ('recherche', 'calendrier'));

drop function if exists
  public.reserver_recherche_comparables(
    uuid, uuid, numeric, int, int, int, numeric);
drop function if exists
  public.rendre_recherche_comparables(
    uuid, numeric);

-- Rend 'ok' (et reserve) ou le plafond atteint :
-- 'mois', 'bien', 'compte', 'compte_mois',
-- 'calendriers'.
create or replace function
  public.reserver_recherche_comparables(
    p_user uuid,
    p_property uuid,
    p_cout numeric,
    p_nature text,
    p_bien_jour int,
    p_compte_jour int,
    p_compte_30j int,
    p_calendriers_90j int,
    p_budget_mois numeric)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
  depense numeric;
begin
  if p_cout is null or p_cout not in (0.10, 0.50)
     or p_nature is null
     or p_nature not in ('recherche', 'calendrier')
     or (p_nature = 'calendrier' and p_cout <> 0.10)
     or p_user is null or p_property is null
     or p_bien_jour is null or p_compte_jour is null
     or p_compte_30j is null
     or p_calendriers_90j is null
     or p_budget_mois is null then
    return 'mois';
  end if;
  perform pg_advisory_xact_lock(
    hashtext('comparables_recherches'));
  select coalesce(sum(cout_usd), 0)
    into depense
    from comparables_recherches
    where cree_le >=
      date_trunc('month', now(), 'UTC');
  if depense + p_cout > p_budget_mois then
    return 'mois';
  end if;
  if p_nature = 'calendrier' then
    select count(*) into n
      from comparables_recherches
      where property_id = p_property
        and nature = 'calendrier'
        and cree_le > now() - interval '90 days';
    if n >= p_calendriers_90j then
      return 'calendriers';
    end if;
  else
    select count(*) into n
      from comparables_recherches
      where property_id = p_property
        and nature = 'recherche'
        and cree_le > now() - interval '24 hours';
    if n >= p_bien_jour then
      return 'bien';
    end if;
    select count(*) into n
      from comparables_recherches
      where user_id = p_user
        and nature = 'recherche'
        and cree_le > now() - interval '24 hours';
    if n >= p_compte_jour then
      return 'compte';
    end if;
    select count(*) into n
      from comparables_recherches
      where user_id = p_user
        and nature = 'recherche'
        and cree_le > now() - interval '30 days';
    if n >= p_compte_30j then
      return 'compte_mois';
    end if;
  end if;
  insert into comparables_recherches
    (user_id, property_id, cout_usd, nature)
    values (p_user, p_property, p_cout, p_nature);
  return 'ok';
end;
$$;

revoke all on function
  public.reserver_recherche_comparables(
    uuid, uuid, numeric, text,
    int, int, int, int, numeric)
  from public, anon, authenticated;

-- Un appel qui ECHOUE rend sa reservation : la
-- plus recente de ce bien, de ce cout et de
-- cette nature, faite il y a moins de 10 minutes.
create or replace function
  public.rendre_recherche_comparables(
    p_property uuid,
    p_cout numeric,
    p_nature text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  cible bigint;
begin
  if p_property is null or p_cout is null
     or p_nature is null then
    return false;
  end if;
  perform pg_advisory_xact_lock(
    hashtext('comparables_recherches'));
  select id into cible
    from comparables_recherches
    where property_id = p_property
      and cout_usd = p_cout
      and nature = p_nature
      and cree_le > now() - interval '10 minutes'
    order by cree_le desc, id desc
    limit 1;
  if cible is null then
    return false;
  end if;
  delete from comparables_recherches
    where id = cible;
  return true;
end;
$$;

revoke all on function
  public.rendre_recherche_comparables(
    uuid, numeric, text)
  from public, anon, authenticated;

notify pgrst, 'reload schema';
