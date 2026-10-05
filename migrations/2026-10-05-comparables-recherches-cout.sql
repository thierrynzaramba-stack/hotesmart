-- 2026-10-05-comparables-recherches-cout.sql
-- Le quota des recherches compte les DOLLARS.
-- Spec : docs/kb/chantier-nouveau-bien.md §21.3.
--
-- Pourquoi : la recherche par equipement coute
-- 0,50 $, cinq fois la liste de base ; compter des
-- recherches ne protegeait plus le budget. Chaque
-- appel payant reserve son COUT, atomiquement (meme
-- verrou que 2026-10-05-comparables-recherches.sql).
-- A coller APRES cette migration-la.
--
-- ⚠ LIGNES COURTES (editeur Supabase). Rejouable.

alter table public.comparables_recherches
  add column if not exists cout_usd numeric(6,2)
    not null default 0.10
    check (cout_usd > 0 and cout_usd <= 5);

-- L'ancienne signature (sans cout) disparait :
-- un seul chemin de reservation.
drop function if exists
  public.reserver_recherche_comparables(
    uuid, uuid, int, int, int, int);

-- Rend 'ok' (et reserve) ou le plafond atteint :
-- 'mois', 'bien', 'compte', 'compte_mois'.
create or replace function
  public.reserver_recherche_comparables(
    p_user uuid,
    p_property uuid,
    p_cout numeric,
    p_bien_jour int,
    p_compte_jour int,
    p_compte_30j int,
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
  -- Deux couts connus seulement (0,10 et 0,50) ;
  -- un parametre absent refuse (jamais un
  -- plafond ignore par un null).
  if p_cout is null or p_cout not in (0.10, 0.50)
     or p_user is null or p_property is null
     or p_bien_jour is null or p_compte_jour is null
     or p_compte_30j is null
     or p_budget_mois is null then
    return 'mois';
  end if;
  -- Un seul a la fois, tous comptes : le
  -- compte et la reservation sont atomiques.
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
    (user_id, property_id, cout_usd)
    values (p_user, p_property, p_cout);
  return 'ok';
end;
$$;

revoke all on function
  public.reserver_recherche_comparables(
    uuid, uuid, numeric, int, int, int, numeric)
  from public, anon, authenticated;

-- Un appel qui ECHOUE rend sa reservation (review
-- de 25ab9e6) : sinon un appel toujours rate
-- re-reservait a chaque essai et videait le
-- budget du mois pour tous les hotes. Rend la
-- plus recente reservation de ce bien et de ce
-- cout, faite il y a moins de 10 minutes.
create or replace function
  public.rendre_recherche_comparables(
    p_property uuid,
    p_cout numeric)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  cible bigint;
begin
  if p_property is null or p_cout is null then
    return false;
  end if;
  perform pg_advisory_xact_lock(
    hashtext('comparables_recherches'));
  select id into cible
    from comparables_recherches
    where property_id = p_property
      and cout_usd = p_cout
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
    uuid, numeric)
  from public, anon, authenticated;

notify pgrst, 'reload schema';
