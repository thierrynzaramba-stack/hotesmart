--
-- migrations/0000-schema-initial.sql
-- Schema de depart du projet Supabase STAGING, decalque de la production.
--
-- Produit par : pg_dump --schema-only --no-owner --no-privileges --schema=public
-- Source : production (PostgreSQL 17.6), 2026-09-15.
--
-- TROIS instructions ont ete neutralisees en commentaire, chacune signalee sur
-- place. Le reste du fichier est la sortie pg_dump intacte.
--   1. \restrict / \unrestrict : meta-commandes pg_dump 18.
--   2. CREATE SCHEMA public : le schema existe deja.
--   3. COMMENT ON SCHEMA public : droit refuse au role applicatif.
--
-- Les references a auth.users sont CONSERVEES : ce schema est fourni
-- nativement par Supabase dans le projet cible.
--

--
-- PostgreSQL database dump
--

-- \restrict retire : meta-commande pg_dump 18, incomprise de psql 17
-- et de l'editeur SQL Supabase.

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.6 (Ubuntu 18.6-0ubuntu0.26.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- CREATE SCHEMA public;  -- retire : le schema existe deja sur tout projet
-- Supabase neuf, l'instruction echouerait en « schema already exists ».


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

-- COMMENT ON SCHEMA public ... -- retire : sur Supabase le schema public
-- appartient a pg_database_owner, le role applicatif n'a pas le droit de le
-- commenter (« must be owner of schema public »).


--
-- Name: can_read(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.can_read(row_user_id uuid, domain text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select perm_level(row_user_id, domain) in ('read','write');
$$;


--
-- Name: can_read(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.can_read(row_user_id uuid, domain text, row_property_ref text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select perm_level(row_user_id, domain) in ('read','write') and in_scope(row_user_id, row_property_ref);
$$;


--
-- Name: can_read(uuid, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.can_read(row_user_id uuid, domain text, row_property_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select perm_level(row_user_id, domain) in ('read','write') and in_scope(row_user_id, row_property_id);
$$;


--
-- Name: can_write(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.can_write(row_user_id uuid, domain text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select perm_level(row_user_id, domain) = 'write'
     and (domain not in ('facturation','equipe') or auth.uid() = row_user_id);
$$;


--
-- Name: can_write(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.can_write(row_user_id uuid, domain text, row_property_ref text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select perm_level(row_user_id, domain) = 'write' and in_scope(row_user_id, row_property_ref)
     and (domain not in ('facturation','equipe') or auth.uid() = row_user_id);
$$;


--
-- Name: can_write(uuid, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.can_write(row_user_id uuid, domain text, row_property_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select perm_level(row_user_id, domain) = 'write' and in_scope(row_user_id, row_property_id)
     and (domain not in ('facturation','equipe') or auth.uid() = row_user_id);
$$;


--
-- Name: claim_availability_push(text, text, date, date, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_availability_push(p_property text, p_room text, p_from date, p_to date, p_avail integer, p_window_s integer DEFAULT 60) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_won boolean;
begin
  insert into public.availability_push_log (property_id, room_type_id, date_from, date_to, availability)
  values (p_property, p_room, p_from, p_to, p_avail)
  on conflict (property_id, room_type_id, date_from, date_to, availability)
  do update set pushed_at = now()
    where public.availability_push_log.pushed_at < now() - make_interval(secs => p_window_s)
  returning true into v_won;

  return coalesce(v_won, false);
end
$$;


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare pid uuid;
begin
  insert into profiles (account_user_id, member_user_id, first_name, email, access_mode, is_owner, active, accepted_at)
  values (new.id, new.id,
          coalesce(nullif(split_part(coalesce(new.email,''), '@', 1), ''), 'Titulaire'),
          new.email, 'compte', true, true, now())
  returning id into pid;

  insert into profile_permissions (
    profile_id, account_user_id, property_scope,
    reservations, menages, prestataires, messages, avis, reglages, facturation, equipe,
    self_availability, self_view_reviews)
  values (pid, new.id, 'all',
          'write','write','write','write','write','write','write','write',
          'write', true);
  return new;
end $$;


--
-- Name: in_scope(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.in_scope(row_user_id uuid, row_property_ref text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select auth.uid() = row_user_id
      or row_property_ref is null
      or exists (
        select 1 from profiles pr
        join profile_permissions p on p.profile_id = pr.id and p.account_user_id = pr.account_user_id
        where pr.account_user_id = row_user_id and pr.member_user_id = auth.uid()
          and pr.active and pr.accepted_at is not null
          and (p.property_scope = 'all'
               or row_property_ref = any(p.property_refs)
               or row_property_ref = any(p.property_ids::text[]))
      );
$$;


--
-- Name: in_scope(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.in_scope(row_user_id uuid, row_property_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select auth.uid() = row_user_id
      or row_property_id is null
      or exists (
        select 1 from profiles pr
        join profile_permissions p on p.profile_id = pr.id and p.account_user_id = pr.account_user_id
        where pr.account_user_id = row_user_id and pr.member_user_id = auth.uid()
          and pr.active and pr.accepted_at is not null
          and (p.property_scope = 'all' or row_property_id = any(p.property_ids))
      );
$$;


--
-- Name: ota_reviews_reanalyse(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ota_reviews_reanalyse() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.verdict_source = 'humain' then
    return new;
  end if;
  if (new.content is distinct from old.content)
     or (new.content_public is distinct from old.content_public)
     or (new.content_private is distinct from old.content_private) then
    new.ai_analyzed_at := null;
    new.ai_clean_verdict := null;
    new.ai_clean_excerpt := null;
  end if;
  return new;
end;
$$;


--
-- Name: ota_reviews_touch(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ota_reviews_touch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


--
-- Name: perm_level(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.perm_level(row_user_id uuid, domain text) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select case
    when auth.uid() = row_user_id then 'write'
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
      from profiles pr
      join profile_permissions p on p.profile_id = pr.id and p.account_user_id = pr.account_user_id
      where pr.account_user_id = row_user_id
        and pr.member_user_id = auth.uid()
        and pr.active
        and pr.accepted_at is not null
    ), 'none')
  end;
$$;


--
-- Name: refs_depuis_ids(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refs_depuis_ids(ids uuid[]) RETURNS text[]
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce(array_agg(p.provider_property_id), '{}')
  from properties p
  where p.id = any(ids) and p.provider_property_id is not null;
$$;


--
-- Name: rekey_property(uuid, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rekey_property(p_bien uuid, p_source text, p_cible text, p_provider text) RETURNS TABLE(nom_table text, colonne text, deplacees bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  t text; paire text[]; n bigint; v_actuel text; v_user uuid;
begin
  if p_source is null or p_cible is null or p_source = p_cible then
    raise exception 'rekey_property : source et cible requises et differentes (% -> %)', p_source, p_cible;
  end if;
  if p_provider is null or p_provider = '' then
    raise exception 'rekey_property : provider cible requis';
  end if;
  select provider_property_id, user_id into v_actuel, v_user
    from public.properties where id = p_bien for update;
  if not found then
    raise exception 'rekey_property : bien % introuvable', p_bien;
  end if;
  if v_actuel is null then
    raise exception 'rekey_property : le bien % n''a aucune cle provider a deplacer', p_bien;
  end if;
  if v_actuel <> p_source then
    raise exception 'rekey_property : le bien porte % et non % — deja migre ?', v_actuel, p_source;
  end if;

  insert into public.rekeying_backup (bien_id, source, cible, nom_table, lignes)
  select p_bien, p_source, p_cible, 'properties',
         coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
    from public.properties x where x.id = p_bien;

  foreach t in array public.rekeying_tables()
  loop
    execute format(
      'insert into public.rekeying_backup (bien_id, source, cible, nom_table, lignes) '
      'select $1, $2, $3, $4, coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) '
      'from public.%I x where x.property_id = $2 and (x.user_id = $5 or x.user_id is null)', t)
      using p_bien, p_source, p_cible, t, v_user;
  end loop;
  foreach paire slice 1 in array public.rekeying_tables_ref()
  loop
    execute format(
      'insert into public.rekeying_backup (bien_id, source, cible, nom_table, lignes) '
      'select $1, $2, $3, $4, coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) '
      'from public.%I x where x.%I = $2 and (x.user_id = $5 or x.user_id is null)', paire[1], paire[2])
      using p_bien, p_source, p_cible, paire[1] || '.' || paire[2], v_user;
  end loop;
  foreach paire slice 1 in array public.rekeying_tables_tableau()
  loop
    execute format(
      'insert into public.rekeying_backup (bien_id, source, cible, nom_table, lignes) '
      'select $1, $2, $3, $4, coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) '
      'from public.%I x where $2 = any(x.%I) and (x.user_id = $5 or x.user_id is null)', paire[1], paire[2])
      using p_bien, p_source, p_cible, paire[1] || '.' || paire[2], v_user;
  end loop;

  foreach t in array public.rekeying_tables()
  loop
    execute format(
      'update public.%I set property_id = $1 '
      'where property_id = $2 and (user_id = $3 or user_id is null)', t)
      using p_cible, p_source, v_user;
    get diagnostics n = row_count;
    nom_table := t; colonne := 'property_id'; deplacees := n;
    return next;
  end loop;
  foreach paire slice 1 in array public.rekeying_tables_ref()
  loop
    execute format(
      'update public.%I set %I = $1 '
      'where %I = $2 and (user_id = $3 or user_id is null)', paire[1], paire[2], paire[2])
      using p_cible, p_source, v_user;
    get diagnostics n = row_count;
    nom_table := paire[1]; colonne := paire[2]; deplacees := n;
    return next;
  end loop;
  foreach paire slice 1 in array public.rekeying_tables_tableau()
  loop
    execute format(
      'update public.%I set %I = array_replace(%I, $2, $1) '
      'where $2 = any(%I) and (user_id = $3 or user_id is null)',
      paire[1], paire[2], paire[2], paire[2])
      using p_cible, p_source, v_user;
    get diagnostics n = row_count;
    nom_table := paire[1]; colonne := paire[2] || ' (tableau)'; deplacees := n;
    return next;
  end loop;

  update public.properties
     set provider = p_provider, provider_property_id = p_cible
   where id = p_bien;
  nom_table := 'properties'; colonne := 'provider_property_id'; deplacees := 1;
  return next;
end;
$_$;


--
-- Name: rekeying_clause_compte(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rekeying_clause_compte(p_table text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  select case when p_table = any(public.rekeying_tables_sans_compte())
    then '(user_id = %s or user_id is null)'
    else 'user_id = %s'
  end;
$$;


--
-- Name: rekeying_compter(text, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rekeying_compter(p_source text, p_cible text, p_user uuid) RETURNS TABLE(nom_table text, colonne text, sous_source bigint, sous_cible bigint, sans_compte bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  t text;
  paire text[];
  n_src bigint;
  n_cib bigint;
  n_nul bigint;
  cl text;
begin
  if p_user is null then
    raise exception 'rekeying_compter : compte requis (sans lui, le comptage traverserait les comptes)';
  end if;

  foreach t in array public.rekeying_tables()
  loop
    cl := format(public.rekeying_clause_compte(t), '$2');
    execute format('select count(*) from public.%I where property_id = $1 and ' || cl, t)
      into n_src using p_source, p_user;
    execute format('select count(*) from public.%I where property_id = $1 and ' || cl, t)
      into n_cib using p_cible, p_user;
    execute format('select count(*) from public.%I where property_id = $1 and user_id is null', t)
      into n_nul using p_source;
    nom_table := t; colonne := 'property_id';
    sous_source := n_src; sous_cible := n_cib; sans_compte := n_nul;
    return next;
  end loop;

  foreach paire slice 1 in array public.rekeying_tables_ref()
  loop
    cl := format(public.rekeying_clause_compte(paire[1]), '$2');
    execute format('select count(*) from public.%I where %I = $1 and ' || cl, paire[1], paire[2])
      into n_src using p_source, p_user;
    execute format('select count(*) from public.%I where %I = $1 and ' || cl, paire[1], paire[2])
      into n_cib using p_cible, p_user;
    execute format('select count(*) from public.%I where %I = $1 and user_id is null', paire[1], paire[2])
      into n_nul using p_source;
    nom_table := paire[1]; colonne := paire[2];
    sous_source := n_src; sous_cible := n_cib; sans_compte := n_nul;
    return next;
  end loop;

  foreach paire slice 1 in array public.rekeying_tables_tableau()
  loop
    cl := format(public.rekeying_clause_compte(paire[1]), '$2');
    execute format('select count(*) from public.%I where $1 = any(%I) and ' || cl, paire[1], paire[2])
      into n_src using p_source, p_user;
    execute format('select count(*) from public.%I where $1 = any(%I) and ' || cl, paire[1], paire[2])
      into n_cib using p_cible, p_user;
    execute format('select count(*) from public.%I where $1 = any(%I) and user_id is null', paire[1], paire[2])
      into n_nul using p_source;
    nom_table := paire[1]; colonne := paire[2] || ' (tableau)';
    sous_source := n_src; sous_cible := n_cib; sans_compte := n_nul;
    return next;
  end loop;
end;
$_$;


--
-- Name: rekeying_tables(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rekeying_tables() RETURNS text[]
    LANGUAGE sql IMMUTABLE
    AS $$
  select array[
    'access_codes',
    'agent_tasks',
    'automation_incidents',
    'booking_change_events',
    'bookings_snapshot',
    'conversations',
    'knowledge',
    'menage_comments',
    'menage_done',
    'menage_events',
    'menages',
    'message_templates',
    'messages',
    'property_cleaning_providers',
    'property_locks',
    'property_status',
    'sms_logs'
  ]::text[];
$$;


--
-- Name: rekeying_tables_ref(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rekeying_tables_ref() RETURNS text[]
    LANGUAGE sql IMMUTABLE
    AS $$
  select array[
    array['ota_reviews', 'property_id_ref'],
    array['prestataire_periodes', 'property_id_ref'],
    array['airbnb_connect_sessions', 'provider_property_id']
  ]::text[][];
$$;


--
-- Name: rekeying_tables_sans_compte(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rekeying_tables_sans_compte() RETURNS text[]
    LANGUAGE sql IMMUTABLE
    AS $$
  select array['access_codes', 'automation_incidents']::text[];
$$;


--
-- Name: rekeying_tables_tableau(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rekeying_tables_tableau() RETURNS text[]
    LANGUAGE sql IMMUTABLE
    AS $$
  select array[
    array['public_tokens', 'property_ids']
  ]::text[][];
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: supprimer_bien_vide(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.supprimer_bien_vide(p_bien uuid) RETURNS TABLE(nom_table text, restantes bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
  declare
    paire text[];
    t text;
    n bigint;
    cl text;
    v_cle text;
    v_user uuid;
    total bigint := 0;
  begin
    select provider_property_id, user_id into v_cle, v_user
      from public.properties where id = p_bien for update;
    if not found then
      raise exception 'supprimer_bien_vide : bien % introuvable', p_bien;
    end if;

    if v_user is null then
      raise exception 'supprimer_bien_vide : fiche sans compte, suppression refusee';
    end if;

    select count(*) into n from public.properties
      where provider_property_id = v_cle;
    if n > 1 then
      raise exception 'supprimer_bien_vide : la cle % est portee par % fiches — '
        'comptage impossible a attribuer, suppression refusee', v_cle, n;
    end if;

    foreach t in array public.rekeying_tables()
    loop
      cl := format(public.rekeying_clause_compte(t), '$2');
      execute format('select count(*) from public.%I where property_id = $1 and ' || cl, t)
        into n using v_cle, v_user;
      if n > 0 then total := total + n; nom_table := t; restantes := n; return next; end if;
    end loop;

    foreach paire slice 1 in array public.rekeying_tables_ref()
    loop
      cl := format(public.rekeying_clause_compte(paire[1]), '$2');
      execute format('select count(*) from public.%I where %I = $1 and ' || cl, paire[1], paire[2])
        into n using v_cle, v_user;
      if n > 0 then total := total + n; nom_table := paire[1] || '.' || paire[2];
        restantes := n; return next; end if;
    end loop;

    foreach paire slice 1 in array public.rekeying_tables_tableau()
    loop
      cl := format(public.rekeying_clause_compte(paire[1]), '$2');
      execute format('select count(*) from public.%I where $1 = any(%I) and ' || cl,
        paire[1], paire[2])
        into n using v_cle, v_user;
      if n > 0 then total := total + n; nom_table := paire[1] || '.' || paire[2];
        restantes := n; return next; end if;
    end loop;

    foreach paire slice 1 in array public.transfert_tables_uuid()
    loop
      execute format('select count(*) from public.%I where %I = $1', paire[1], paire[2])
        into n using p_bien;
      if n > 0 then total := total + n; nom_table := paire[1] || '.' || paire[2];
        restantes := n; return next; end if;
    end loop;

    foreach paire slice 1 in array public.transfert_tables_uuid_purgees()
    loop
      execute format('select count(*) from public.%I where %I = $1', paire[1], paire[2])
        into n using p_bien;
      if n > 0 then total := total + n; nom_table := paire[1] || '.' || paire[2];
        restantes := n; return next; end if;
    end loop;

    select count(*) into n from public.profile_permissions where p_bien = any(property_ids);
    if n > 0 then total := total + n; nom_table := 'profile_permissions.property_ids';
      restantes := n; return next; end if;

    if total > 0 then
      raise exception 'supprimer_bien_vide : % ligne(s) encore rattachee(s) — '
        'suppression refusee (relancer transfert_compter pour voir ou)', total;
    end if;

    delete from public.properties where id = p_bien;

  delete from public.properties where id = p_bien;
  nom_table := 'properties'; restantes := 0;
  return next;
end;
$_$;


--
-- Name: sync_refs_compte(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_refs_compte() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare compte uuid;
begin
  if TG_OP = 'DELETE' then compte := old.user_id;
  else                     compte := new.user_id;
  end if;
  update profile_permissions pp
     set property_refs = refs_depuis_ids(pp.property_ids),
         updated_at = now()
   where pp.account_user_id = compte
     and pp.property_scope = 'selected';
  return null;
end $$;


--
-- Name: sync_refs_ligne(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_refs_ligne() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  new.property_refs := refs_depuis_ids(new.property_ids);
  new.updated_at := now();
  return new;
end $$;


--
-- Name: transferer_bien(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.transferer_bien(p_source uuid, p_cible uuid) RETURNS TABLE(famille text, nom_table text, colonne text, deplacees bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  paire text[];
  t text;
  n bigint;
  v_src_cle text;
  v_cib_cle text;
  v_user uuid;
  v_user_cib uuid;
  v_pause boolean;
  v_prov_cib text;
  cl text;
  n_collision bigint;
begin
  if p_source is null or p_cible is null or p_source = p_cible then
    raise exception 'transferer_bien : source et cible requises et differentes';
  end if;

  select provider_property_id, user_id, automation_paused
    into v_src_cle, v_user, v_pause
    from public.properties where id = p_source for update;
  if not found then
    raise exception 'transferer_bien : bien source % introuvable', p_source;
  end if;
  select provider_property_id, user_id, provider
    into v_cib_cle, v_user_cib, v_prov_cib
    from public.properties where id = p_cible for update;
  if not found then
    raise exception 'transferer_bien : bien cible % introuvable', p_cible;
  end if;

  if v_user is distinct from v_user_cib then
    raise exception 'transferer_bien : les deux fiches ne sont pas du meme compte';
  end if;
  if v_user is null then
    raise exception 'transferer_bien : fiche sans compte, transfert refuse';
  end if;
  if v_src_cle is null then
    raise exception 'transferer_bien : la source n''a aucune cle provider a deplacer';
  end if;
  if v_cib_cle is null then
    raise exception 'transferer_bien : la cible n''a pas de cle provider (bien non provisionne ?)';
  end if;
  if v_src_cle = v_cib_cle then
    raise exception 'transferer_bien : les deux fiches portent la meme cle provider (%)', v_src_cle;
  end if;

  if v_pause is not true then
    raise exception 'transferer_bien : automation_paused doit etre true sur la source (%)', p_source;
  end if;

  select count(*) into n_collision from public.properties
    where provider_property_id = v_src_cle;
  if n_collision > 1 then
    raise exception 'transferer_bien : la cle source % est portee par % fiches — '
      'transfert refuse (impossible de savoir a qui sont les lignes sans compte)',
      v_src_cle, n_collision;
  end if;

  select count(*) into n_collision from public.properties
    where provider_property_id = v_cib_cle;
  if n_collision > 1 then
    raise exception 'transferer_bien : la cle CIBLE % est portee par % fiches — '
      'transfert refuse (les lignes sans compte deviendraient lisibles par l''autre)',
      v_cib_cle, n_collision;
  end if;

  select count(*) into n_collision from public.property_status
    where property_id = v_cib_cle and user_id = v_user
      and status = 'ready';
  if n_collision > 0 then
    raise exception 'transferer_bien : la cible porte un statut « ready » — '
      'une prestataire a valide un menage dessus, transfert refuse';
  end if;

  delete from public.property_status
    where property_id = v_cib_cle and user_id = v_user;

  select count(*) into n_collision
    from public.calendar_inventory a
    join public.calendar_inventory b
      on b.property_id = p_cible and b.date = a.date
   where a.property_id = p_source;
  if n_collision > 0 then
    raise exception 'transferer_bien : % date(s) de calendrier existent DES DEUX COTES — '
      'fusionner avant le transfert (UNIQUE (property_id, date))', n_collision;
  end if;

  select count(*) into n_collision
    from public.menages a
    join public.menages b
      on b.property_id = v_cib_cle and b.user_id = a.user_id
     and b.booking_id = a.booking_id and b.departure_date = a.departure_date
   where a.property_id = v_src_cle and a.user_id = v_user;
  if n_collision > 0 then
    raise exception 'transferer_bien : % menage(s) en collision (meme reservation, '
      'meme depart) des deux cotes — les traiter avant le transfert', n_collision;
  end if;

  select count(*) into n_collision
    from public.property_cleaning_providers a
    join public.property_cleaning_providers b
      on b.property_id = v_cib_cle and b.user_id = a.user_id
     and b.provider_id = a.provider_id
   where a.property_id = v_src_cle and a.user_id = v_user;
  if n_collision > 0 then
    raise exception 'transferer_bien : % prestataire(s) assignee(s) des deux cotes — '
      'les traiter avant le transfert', n_collision;
  end if;

  insert into public.rekeying_backup (bien_id, source, cible, nom_table, lignes)
  select p_source, v_src_cle, v_cib_cle, 'properties (source)',
         coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
    from public.properties x where x.id = p_source;
  insert into public.rekeying_backup (bien_id, source, cible, nom_table, lignes)
  select p_source, v_src_cle, v_cib_cle, 'properties (cible)',
         coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
    from public.properties x where x.id = p_cible;

  foreach t in array public.rekeying_tables()
  loop
    cl := format(public.rekeying_clause_compte(t), '$5');
    execute format(
      'insert into public.rekeying_backup '
      '(bien_id, source, cible, nom_table, lignes) '
      'select $1, $2, $3, $4, coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) '
      'from public.%I x where x.property_id = $2 and ' || cl, t)
      using p_source, v_src_cle, v_cib_cle, t, v_user;
  end loop;

  foreach paire slice 1 in array public.rekeying_tables_ref()
  loop
    cl := format(public.rekeying_clause_compte(paire[1]), '$5');
    execute format(
      'insert into public.rekeying_backup '
      '(bien_id, source, cible, nom_table, lignes) '
      'select $1, $2, $3, $4, coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) '
      'from public.%I x where x.%I = $2 and ' || cl, paire[1], paire[2])
      using p_source, v_src_cle, v_cib_cle, paire[1] || '.' || paire[2], v_user;
  end loop;

  foreach paire slice 1 in array public.rekeying_tables_tableau()
  loop
    cl := format(public.rekeying_clause_compte(paire[1]), '$5');
    execute format(
      'insert into public.rekeying_backup '
      '(bien_id, source, cible, nom_table, lignes) '
      'select $1, $2, $3, $4, coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) '
      'from public.%I x where $2 = any(x.%I) and ' || cl, paire[1], paire[2])
      using p_source, v_src_cle, v_cib_cle, paire[1] || '.' || paire[2], v_user;
  end loop;

  foreach paire slice 1 in array public.transfert_tables_uuid()
  loop
    execute format(
      'insert into public.rekeying_backup '
      '(bien_id, source, cible, nom_table, lignes) '
      'select $1, $2, $3, $4, coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) '
      'from public.%I x where x.%I = $5', paire[1], paire[2])
      using p_source, v_src_cle, v_cib_cle,
            paire[1] || '.' || paire[2] || ' (uuid)', p_source;
  end loop;

  foreach paire slice 1 in array public.transfert_tables_uuid_purgees()
  loop
    execute format(
      'insert into public.rekeying_backup '
      '(bien_id, source, cible, nom_table, lignes) '
      'select $1, $2, $3, $4, coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) '
      'from public.%I x where x.%I = $5', paire[1], paire[2])
      using p_source, v_src_cle, v_cib_cle,
            paire[1] || '.' || paire[2] || ' (purgee)', p_source;
  end loop;

  insert into public.rekeying_backup (bien_id, source, cible, nom_table, lignes)
  select p_source, v_src_cle, v_cib_cle, 'profile_permissions (uuid)',
         coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
    from public.profile_permissions x where p_source = any(x.property_ids);

  insert into public.rekeying_backup (bien_id, source, cible, nom_table, lignes)
  select p_source, v_src_cle, v_cib_cle, 'property_snapshots (conservee, non deplacee)',
         coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
    from public.property_snapshots x
   where x.property_id = v_src_cle and x.user_id = v_user;

  foreach t in array public.rekeying_tables()
  loop
    cl := format(public.rekeying_clause_compte(t), '$3');
    execute format(
      'update public.%I set property_id = $1 where property_id = $2 and ' || cl, t)
      using v_cib_cle, v_src_cle, v_user;
    get diagnostics n = row_count;
    famille := 'cle provider'; nom_table := t; colonne := 'property_id';
    deplacees := n;
    return next;
  end loop;

  foreach paire slice 1 in array public.rekeying_tables_ref()
  loop
    cl := format(public.rekeying_clause_compte(paire[1]), '$3');
    execute format(
      'update public.%I set %I = $1 where %I = $2 and ' || cl,
      paire[1], paire[2], paire[2])
      using v_cib_cle, v_src_cle, v_user;
    get diagnostics n = row_count;
    famille := 'cle provider'; nom_table := paire[1]; colonne := paire[2];
    deplacees := n;
    return next;
  end loop;

  foreach paire slice 1 in array public.rekeying_tables_tableau()
  loop
    cl := format(public.rekeying_clause_compte(paire[1]), '$3');
    execute format(
      'update public.%I set %I = array_replace(%I, $2, $1) '
      'where $2 = any(%I) and ' || cl,
      paire[1], paire[2], paire[2], paire[2])
      using v_cib_cle, v_src_cle, v_user;
    get diagnostics n = row_count;
    famille := 'cle provider'; nom_table := paire[1];
    colonne := paire[2] || ' (tableau)'; deplacees := n;
    return next;
  end loop;

  foreach paire slice 1 in array public.transfert_tables_uuid()
  loop
    execute format('update public.%I set %I = $1 where %I = $2',
      paire[1], paire[2], paire[2]) using p_cible, p_source;
    get diagnostics n = row_count;
    famille := 'uuid fiche'; nom_table := paire[1]; colonne := paire[2];
    deplacees := n;
    return next;
  end loop;

  foreach paire slice 1 in array public.transfert_tables_uuid_purgees()
  loop
    execute format('delete from public.%I where %I = $1', paire[1], paire[2])
      using p_source;
    get diagnostics n = row_count;
    famille := 'uuid — purgee'; nom_table := paire[1]; colonne := paire[2];
    deplacees := n;
    return next;
  end loop;

  update public.profile_permissions
     set property_ids = array_replace(property_ids, p_source, p_cible)
   where p_source = any(property_ids);
  get diagnostics n = row_count;
  famille := 'uuid fiche'; nom_table := 'profile_permissions';
  colonne := 'property_ids (tableau)'; deplacees := n;
  return next;

  update public.properties
     set automation_paused = true,
         paused_reason = 'fiche transferee vers ' || p_cible::text,
         paused_at = now(),
         active_at = null,
         migration_target_property_id = null,
         migration_target_at = null
   where id = p_source;
  famille := 'fiche'; nom_table := 'properties (source)';
  colonne := 'retiree'; deplacees := 1;
  return next;
end;
$_$;


--
-- Name: transfert_compter(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.transfert_compter(p_source uuid, p_cible uuid) RETURNS TABLE(famille text, nom_table text, colonne text, sous_source bigint, sous_cible bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  paire text[];
  t text;
  v_src_cle text;
  v_cib_cle text;
  v_user_src uuid;
  v_user_cib uuid;
  cl text;
  n_src bigint;
  n_cib bigint;
begin
  select provider_property_id, user_id into v_src_cle, v_user_src
    from public.properties where id = p_source;
  if not found then
    raise exception 'transfert_compter : bien source % introuvable', p_source;
  end if;
  select provider_property_id, user_id into v_cib_cle, v_user_cib
    from public.properties where id = p_cible;
  if not found then
    raise exception 'transfert_compter : bien cible % introuvable', p_cible;
  end if;
  if v_user_src is distinct from v_user_cib then
    raise exception 'transfert_compter : les deux fiches ne sont pas du meme compte';
  end if;
  if v_user_src is null then
    raise exception 'transfert_compter : fiche sans compte, audit refuse';
  end if;

  foreach t in array public.rekeying_tables()
  loop
    cl := format(public.rekeying_clause_compte(t), '$2');
    execute format('select count(*) from public.%I where property_id = $1 and ' || cl, t)
      into n_src using v_src_cle, v_user_src;
    execute format('select count(*) from public.%I where property_id = $1 and ' || cl, t)
      into n_cib using v_cib_cle, v_user_src;
    famille := 'cle provider'; nom_table := t; colonne := 'property_id';
    sous_source := n_src; sous_cible := n_cib;
    return next;
  end loop;

  foreach paire slice 1 in array public.rekeying_tables_ref()
  loop
    cl := format(public.rekeying_clause_compte(paire[1]), '$2');
    execute format('select count(*) from public.%I where %I = $1 and ' || cl, paire[1], paire[2])
      into n_src using v_src_cle, v_user_src;
    execute format('select count(*) from public.%I where %I = $1 and ' || cl, paire[1], paire[2])
      into n_cib using v_cib_cle, v_user_src;
    famille := 'cle provider'; nom_table := paire[1]; colonne := paire[2];
    sous_source := n_src; sous_cible := n_cib;
    return next;
  end loop;

  foreach paire slice 1 in array public.rekeying_tables_tableau()
  loop
    cl := format(public.rekeying_clause_compte(paire[1]), '$2');
    execute format('select count(*) from public.%I where $1 = any(%I) and ' || cl,
      paire[1], paire[2]) into n_src using v_src_cle, v_user_src;
    execute format('select count(*) from public.%I where $1 = any(%I) and ' || cl,
      paire[1], paire[2]) into n_cib using v_cib_cle, v_user_src;
    famille := 'cle provider'; nom_table := paire[1]; colonne := paire[2] || ' (tableau)';
    sous_source := n_src; sous_cible := n_cib;
    return next;
  end loop;

  foreach paire slice 1 in array public.transfert_tables_uuid()
  loop
    execute format('select count(*) from public.%I where %I = $1', paire[1], paire[2])
      into n_src using p_source;
    execute format('select count(*) from public.%I where %I = $1', paire[1], paire[2])
      into n_cib using p_cible;
    famille := 'uuid fiche'; nom_table := paire[1]; colonne := paire[2];
    sous_source := n_src; sous_cible := n_cib;
    return next;
  end loop;

  foreach paire slice 1 in array public.transfert_tables_uuid_purgees()
  loop
    execute format('select count(*) from public.%I where %I = $1', paire[1], paire[2])
      into n_src using p_source;
    execute format('select count(*) from public.%I where %I = $1', paire[1], paire[2])
      into n_cib using p_cible;
    famille := 'uuid — A PURGER'; nom_table := paire[1]; colonne := paire[2];
    sous_source := n_src; sous_cible := n_cib;
    return next;
  end loop;

  select count(*) into n_src from public.profile_permissions
    where p_source = any(property_ids);
  select count(*) into n_cib from public.profile_permissions
    where p_cible = any(property_ids);
  famille := 'uuid fiche'; nom_table := 'profile_permissions';
  colonne := 'property_ids (tableau)';
  sous_source := n_src; sous_cible := n_cib;
  return next;
end;
$_$;


--
-- Name: transfert_tables_uuid(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.transfert_tables_uuid() RETURNS text[]
    LANGUAGE sql IMMUTABLE
    AS $$
  select array[
    array['calendar_inventory',      'property_id'],
    array['booking_links',           'property_id'],
    array['booking_attempts',        'property_id'],
    array['ota_reviews',             'property_id'],
    array['airbnb_connect_sessions', 'property_id']
  ]::text[][];
$$;


--
-- Name: transfert_tables_uuid_purgees(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.transfert_tables_uuid_purgees() RETURNS text[]
    LANGUAGE sql IMMUTABLE
    AS $$
  select array[
    array['property_channel_rate_plans', 'property_id']
  ]::text[][];
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: access_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.access_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lock_id uuid NOT NULL,
    booking_id text NOT NULL,
    property_id text NOT NULL,
    seam_code_id text,
    code text,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    user_id uuid
);


--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    user_id uuid NOT NULL,
    is_beta boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    stripe_customer_id text,
    stripe_subscription_id text,
    sub_status text,
    sub_quantity integer,
    trial_started_at timestamp with time zone,
    trial_ends_at timestamp with time zone
);


--
-- Name: agent_alert_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_alert_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: agent_prompting; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_prompting (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    property_id text,
    instructions text DEFAULT ''::text,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: agent_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    user_id uuid,
    property_id text,
    book_id text,
    guest_name text,
    guest_message text,
    task_type text NOT NULL,
    summary text,
    suggested_reply text,
    status text DEFAULT 'pending'::text,
    source_thread jsonb,
    sub_tasks jsonb,
    guest_phone text,
    arrival date,
    departure date,
    lock_id uuid,
    battery_level integer,
    next_reminder_at timestamp with time zone
);


--
-- Name: airbnb_connect_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.airbnb_connect_sessions (
    token text NOT NULL,
    user_id uuid NOT NULL,
    property_id uuid NOT NULL,
    provider_property_id text NOT NULL,
    channel_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    consumed_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT (now() + '00:30:00'::interval) NOT NULL
);


--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    api_key text,
    created_at timestamp without time zone DEFAULT now(),
    brevo_api_key text,
    brevo_enabled boolean DEFAULT true,
    seam_api_key text,
    seam_enabled boolean DEFAULT true,
    refresh_token text
);


--
-- Name: app_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    app_id text,
    action text,
    data jsonb,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: automation_incidents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_incidents (
    id bigint NOT NULL,
    user_id uuid,
    property_id text,
    type text NOT NULL,
    detail jsonb,
    alerted boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    acquitted_at timestamp with time zone,
    acquitted_by uuid,
    last_alerted_at timestamp with time zone
);


--
-- Name: automation_incidents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.automation_incidents ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.automation_incidents_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: availability_push_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.availability_push_log (
    id bigint NOT NULL,
    property_id text NOT NULL,
    room_type_id text NOT NULL,
    date_from date NOT NULL,
    date_to date NOT NULL,
    availability integer NOT NULL,
    pushed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: availability_push_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.availability_push_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.availability_push_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: booking_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.booking_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    link_id uuid NOT NULL,
    property_id uuid NOT NULL,
    user_id uuid NOT NULL,
    arrival date NOT NULL,
    departure date NOT NULL,
    guests integer NOT NULL,
    guest_first_name text NOT NULL,
    guest_last_name text NOT NULL,
    guest_email text NOT NULL,
    guest_phone text NOT NULL,
    lang text DEFAULT 'fr'::text NOT NULL,
    amount_cents integer NOT NULL,
    currency text DEFAULT 'EUR'::text NOT NULL,
    price_coefficient numeric DEFAULT 100 NOT NULL,
    price_detail jsonb,
    status text DEFAULT 'pending'::text NOT NULL,
    checkout_session_id text,
    payment_intent_id text,
    idempotency_key text NOT NULL,
    hold_expires_at timestamp with time zone NOT NULL,
    provider_booking_id text,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    cancellation_policy text,
    paid_at timestamp with time zone,
    CONSTRAINT booking_attempts_montant CHECK ((amount_cents > 0)),
    CONSTRAINT booking_attempts_sejour CHECK (((departure > arrival) AND (guests >= 1))),
    CONSTRAINT booking_attempts_statut CHECK ((status = ANY (ARRAY['pending'::text, 'paid'::text, 'booked'::text, 'failed'::text, 'expired'::text, 'refunded'::text])))
);


--
-- Name: booking_change_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.booking_change_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    booking_id text NOT NULL,
    property_id text NOT NULL,
    provider text,
    type text NOT NULL,
    changes jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    processing_errors jsonb,
    CONSTRAINT booking_change_events_type_check CHECK ((type = ANY (ARRAY['new'::text, 'modified'::text, 'cancelled'::text])))
);


--
-- Name: booking_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.booking_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    property_id uuid NOT NULL,
    token text NOT NULL,
    label text DEFAULT ''::text NOT NULL,
    price_coefficient numeric DEFAULT 100 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT booking_links_coefficient_borne CHECK (((price_coefficient > (0)::numeric) AND (price_coefficient <= (1000)::numeric)))
);


--
-- Name: bookings_snapshot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bookings_snapshot (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    user_id uuid,
    booking_id text NOT NULL,
    property_id text,
    snapshot jsonb,
    raw jsonb,
    raw_hash text
);


--
-- Name: COLUMN bookings_snapshot.raw; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings_snapshot.raw IS 'Payload provider integral, tel que servi (Beds24 GET /bookings avec invoiceItems, Channex GET /bookings attributes). Ecrit par le seul writer lib/bookings-snapshot.js. JAMAIS compare pour decider d''un evenement : la detection porte sur le snapshot normalise uniquement (spec §4). Une mise a jour du seul raw ne touche pas updated_at.';


--
-- Name: COLUMN bookings_snapshot.raw_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings_snapshot.raw_hash IS 'sha256 de la forme stable (cles triees) du payload ci-dessus. Permet au writer de detecter un changement de raw sans relire la colonne. Ecrit avec raw, jamais seul.';


--
-- Name: calendar_inventory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calendar_inventory (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    property_id uuid NOT NULL,
    date date NOT NULL,
    rate numeric,
    avail integer,
    stop_sell boolean DEFAULT false,
    min_stay_arrival integer DEFAULT 0,
    min_stay_through integer DEFAULT 0,
    max_stay integer DEFAULT 0,
    cta boolean DEFAULT false,
    ctd boolean DEFAULT false,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: channel_sync_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_sync_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    property_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    CONSTRAINT channel_sync_queue_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'done'::text, 'failed'::text])))
);


--
-- Name: conges_plages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conges_plages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    provider_id uuid NOT NULL,
    debut date NOT NULL,
    fin date NOT NULL,
    motif text,
    source text DEFAULT 'prestataire'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT conges_plages_bornes CHECK ((debut <= fin)),
    CONSTRAINT conges_plages_source_check CHECK ((source = ANY (ARRAY['prestataire'::text, 'hote'::text])))
);


--
-- Name: conversation_flags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_flags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    book_id text NOT NULL,
    pinned boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    property_id text NOT NULL,
    guest_name text,
    guest_message text NOT NULL,
    agent_reply text,
    book_id text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: cron_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cron_logs (
    id text NOT NULL,
    last_run timestamp with time zone,
    total_messages integer DEFAULT 0,
    total_replies integer DEFAULT 0,
    errors jsonb DEFAULT '[]'::jsonb
);


--
-- Name: integration_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    type text NOT NULL,
    provider_name text NOT NULL,
    note text,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    notified_at timestamp with time zone,
    contact_first_name text,
    contact_last_name text,
    contact_phone text,
    contact_email text,
    properties_count smallint,
    properties_urls jsonb,
    CONSTRAINT integration_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'acknowledged'::text, 'in_progress'::text, 'shipped'::text, 'declined'::text]))),
    CONSTRAINT integration_requests_type_check CHECK ((type = ANY (ARRAY['channel_manager'::text, 'smart_lock'::text])))
);


--
-- Name: kb_question_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kb_question_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    question_fr text NOT NULL,
    category text NOT NULL,
    kind text NOT NULL,
    sort_order smallint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    priority smallint DEFAULT 2 NOT NULL,
    CONSTRAINT kb_question_templates_kind_check CHECK ((kind = ANY (ARRAY['factual'::text, 'advice'::text]))),
    CONSTRAINT kb_question_templates_priority_check CHECK ((priority = ANY (ARRAY[1, 2])))
);


--
-- Name: knowledge; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    property_id text NOT NULL,
    type text NOT NULL,
    key text NOT NULL,
    value text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT knowledge_type_check CHECK ((type = ANY (ARRAY['fixed'::text, 'faq'::text])))
);


--
-- Name: lock_alert_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lock_alert_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lock_id uuid NOT NULL,
    threshold integer DEFAULT 15 NOT NULL,
    phone text,
    reminder_days integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    user_id uuid
);


--
-- Name: locks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.locks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    label text NOT NULL,
    brand text DEFAULT 'igloohome'::text NOT NULL,
    seam_device_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    user_id uuid
);


--
-- Name: locks_with_alert_config; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.locks_with_alert_config AS
 SELECT l.id,
    l.label,
    l.brand,
    l.seam_device_id,
    lac.threshold,
    lac.phone,
    lac.reminder_days,
    t.id AS open_task_id,
    t.battery_level AS last_battery_level,
    t.next_reminder_at
   FROM ((public.locks l
     LEFT JOIN public.lock_alert_config lac ON ((lac.lock_id = l.id)))
     LEFT JOIN public.agent_tasks t ON (((t.lock_id = l.id) AND (t.task_type = 'battery_low'::text) AND (t.status = 'open'::text))));


--
-- Name: menage_assignment_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.menage_assignment_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    menage_id uuid NOT NULL,
    event text NOT NULL,
    from_provider_id uuid,
    to_provider_id uuid,
    actor text NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT menage_assignment_log_actor_check CHECK ((actor = ANY (ARRAY['cron'::text, 'provider'::text, 'host'::text]))),
    CONSTRAINT menage_assignment_log_event_check CHECK ((event = ANY (ARRAY['created'::text, 'assigned'::text, 'offered'::text, 'accepted'::text, 'declined'::text, 'expired'::text, 'escalated'::text, 'orphaned'::text, 'manual_assign'::text, 'cancelled'::text, 'started'::text, 'completed'::text, 'offer_withdrawn'::text])))
);


--
-- Name: menage_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.menage_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    user_id uuid,
    booking_id text NOT NULL,
    departure_date text NOT NULL,
    comment text,
    property_id text
);


--
-- Name: menage_done; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.menage_done (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    property_id text NOT NULL,
    booking_id text NOT NULL,
    departure_date date NOT NULL,
    done_at timestamp with time zone DEFAULT now() NOT NULL,
    done_by_token text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: menage_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.menage_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    user_id uuid,
    booking_id text NOT NULL,
    property_id text,
    property_name text,
    event_type text NOT NULL,
    event_data jsonb,
    token text NOT NULL,
    read boolean DEFAULT false
);


--
-- Name: menages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.menages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    property_id text NOT NULL,
    booking_id text NOT NULL,
    departure_date date NOT NULL,
    provider_id uuid,
    status text DEFAULT 'unassigned'::text NOT NULL,
    assigned_by text,
    assignment_reason text,
    offered_at timestamp with time zone,
    accepted_at timestamp with time zone,
    assignment_mode text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    offered_to uuid,
    offer_expires_at timestamp with time zone,
    CONSTRAINT menages_accepted_a_un_porteur CHECK (((status <> 'accepted'::text) OR (provider_id IS NOT NULL))),
    CONSTRAINT menages_assigned_by_check CHECK ((assigned_by = ANY (ARRAY['auto'::text, 'manual'::text]))),
    CONSTRAINT menages_offre_datee CHECK ((((offered_to IS NULL) AND (offer_expires_at IS NULL)) OR ((offered_to IS NOT NULL) AND (offer_expires_at IS NOT NULL)))),
    CONSTRAINT menages_offre_pas_a_soi CHECK (((offered_to IS NULL) OR (provider_id IS NULL) OR (offered_to <> provider_id))),
    CONSTRAINT menages_status_check CHECK ((status = ANY (ARRAY['unassigned'::text, 'offered'::text, 'accepted'::text, 'started'::text, 'completed'::text, 'orphaned'::text, 'cancelled'::text])))
);


--
-- Name: message_sent_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_sent_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    booking_id text,
    template_id uuid,
    sent_at timestamp with time zone DEFAULT now(),
    stay_key text
);


--
-- Name: message_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    property_id text,
    event_type text NOT NULL,
    reference text DEFAULT 'arrival'::text NOT NULL,
    offset_days integer DEFAULT '-1'::integer,
    send_time text DEFAULT '10:00'::text,
    send_anyway boolean DEFAULT true,
    active boolean DEFAULT true,
    template_text text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    offset_value text,
    earliest_send_time text DEFAULT '15:00'::text,
    lock_id uuid,
    require_ready_status boolean DEFAULT false NOT NULL
);


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    ota text,
    property_id text NOT NULL,
    booking_id text,
    provider_msg_id text,
    direction text NOT NULL,
    sender text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    kind text DEFAULT 'message'::text NOT NULL,
    sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT messages_direction_chk CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text]))),
    CONSTRAINT messages_sender_chk CHECK ((sender = ANY (ARRAY['guest'::text, 'host'::text, 'ai'::text, 'auto'::text, 'system'::text])))
);


--
-- Name: onboarding_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.onboarding_state (
    user_id uuid NOT NULL,
    current_step smallint DEFAULT 0 NOT NULL,
    completed boolean DEFAULT false NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'in_progress'::text NOT NULL,
    CONSTRAINT onboarding_state_current_step_check CHECK (((current_step >= 0) AND (current_step <= 9))),
    CONSTRAINT onboarding_state_status_check CHECK ((status = ANY (ARRAY['in_progress'::text, 'completed'::text, 'pending_integration'::text])))
);


--
-- Name: ota_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ota_reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    property_id uuid NOT NULL,
    property_id_ref text NOT NULL,
    provider text NOT NULL,
    ota text NOT NULL,
    external_review_id text NOT NULL,
    channel_id text,
    listing_id text,
    ota_reservation_id text,
    booking_uid text,
    provider_booking_id text,
    menage_event_id uuid,
    stay_start date,
    stay_end date,
    guest_name text,
    content text,
    content_public text,
    content_private text,
    reply text,
    is_replied boolean DEFAULT false NOT NULL,
    is_hidden boolean DEFAULT false NOT NULL,
    overall_score numeric,
    score_clean numeric,
    scores jsonb,
    tags jsonb,
    received_at timestamp with time zone,
    expired_at timestamp with time zone,
    is_expired boolean DEFAULT false NOT NULL,
    provider_updated_at timestamp with time zone,
    ai_clean_verdict text,
    ai_clean_excerpt text,
    ai_analyzed_at timestamp with time zone,
    raw jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source text,
    statut text DEFAULT 'confirme'::text NOT NULL,
    source_message_id uuid,
    verdict_source text DEFAULT 'auto'::text NOT NULL,
    verdict_modifie_at timestamp with time zone,
    verdict_modifie_par uuid,
    CONSTRAINT ota_reviews_ai_clean_verdict_check CHECK ((ai_clean_verdict = ANY (ARRAY['rien_signale'::text, 'remarque'::text, 'positif'::text]))),
    CONSTRAINT ota_reviews_provider_check CHECK ((provider = ANY (ARRAY['channex'::text, 'beds24'::text, 'manuel'::text]))),
    CONSTRAINT ota_reviews_source_check CHECK ((((provider = 'manuel'::text) AND (source = ANY (ARRAY['sms'::text, 'email'::text, 'oral'::text, 'message'::text]))) OR ((provider <> 'manuel'::text) AND (source IS NULL)))),
    CONSTRAINT ota_reviews_source_message_check CHECK ((((source = 'message'::text) AND (source_message_id IS NOT NULL)) OR ((source IS DISTINCT FROM 'message'::text) AND (source_message_id IS NULL)))),
    CONSTRAINT ota_reviews_statut_check CHECK ((statut = ANY (ARRAY['detecte'::text, 'confirme'::text, 'ignore'::text]))),
    CONSTRAINT ota_reviews_verdict_source_check CHECK ((verdict_source = ANY (ARRAY['auto'::text, 'humain'::text])))
);


--
-- Name: COLUMN ota_reviews.source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ota_reviews.source IS 'Canal de reception, avis saisis a la main uniquement : sms | email | oral. NULL pour les avis provider.';


--
-- Name: prestataire_periodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prestataire_periodes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    provider_id uuid NOT NULL,
    property_id_ref text NOT NULL,
    debut date,
    fin date,
    source text DEFAULT 'declare'::text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT prestataire_periodes_bornes CHECK (((debut IS NULL) OR (fin IS NULL) OR (debut <= fin))),
    CONSTRAINT prestataire_periodes_source_check CHECK ((source = 'declare'::text))
);


--
-- Name: price_display_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_display_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    property_id uuid NOT NULL,
    stay_date date NOT NULL,
    rate integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    replaced_at timestamp with time zone,
    sold_at timestamp with time zone,
    sold_booking_uid text,
    source text DEFAULT 'host'::text NOT NULL,
    CONSTRAINT price_display_log_rate_check CHECK ((rate >= 0)),
    CONSTRAINT price_display_log_source_check CHECK ((source = ANY (ARRAY['host'::text, 'engine'::text, 'seed'::text])))
);


--
-- Name: TABLE price_display_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.price_display_log IS 'Journal des prix affiches (YieldFlow etape 1). Une ligne par changement de prix REEL pour une nuit, jamais par cycle. Ouverte a la poussee, fermee par remplacement (replaced_at) ou par vente (sold_at). NON RETROACTIF : un prix non capte est perdu.';


--
-- Name: COLUMN price_display_log.property_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.price_display_log.property_id IS 'UUID properties.id — exception raisonnee a la regle 10 : ce journal est ecrit par nous, pas par la couche sync, et survit a un changement de provider.';


--
-- Name: COLUMN price_display_log.rate; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.price_display_log.rate IS 'Prix affiche en CENTIMES, entier. Meme unite que la poussee ARI (api/calendar.js), aucune conversion.';


--
-- Name: profile_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profile_permissions (
    profile_id uuid NOT NULL,
    account_user_id uuid NOT NULL,
    property_scope text DEFAULT 'all'::text NOT NULL,
    property_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    property_refs text[] DEFAULT '{}'::text[] NOT NULL,
    reservations text DEFAULT 'none'::text NOT NULL,
    menages text DEFAULT 'none'::text NOT NULL,
    prestataires text DEFAULT 'none'::text NOT NULL,
    messages text DEFAULT 'none'::text NOT NULL,
    avis text DEFAULT 'none'::text NOT NULL,
    reglages text DEFAULT 'none'::text NOT NULL,
    facturation text DEFAULT 'none'::text NOT NULL,
    equipe text DEFAULT 'none'::text NOT NULL,
    self_availability text DEFAULT 'none'::text NOT NULL,
    self_view_reviews boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT profile_permissions_avis_check CHECK ((avis = ANY (ARRAY['none'::text, 'read'::text, 'write'::text]))),
    CONSTRAINT profile_permissions_equipe_check CHECK ((equipe = ANY (ARRAY['none'::text, 'read'::text, 'write'::text]))),
    CONSTRAINT profile_permissions_facturation_check CHECK ((facturation = ANY (ARRAY['none'::text, 'read'::text, 'write'::text]))),
    CONSTRAINT profile_permissions_menages_check CHECK ((menages = ANY (ARRAY['none'::text, 'read'::text, 'write'::text]))),
    CONSTRAINT profile_permissions_messages_check CHECK ((messages = ANY (ARRAY['none'::text, 'read'::text, 'write'::text]))),
    CONSTRAINT profile_permissions_prestataires_check CHECK ((prestataires = ANY (ARRAY['none'::text, 'read'::text, 'write'::text]))),
    CONSTRAINT profile_permissions_property_scope_check CHECK ((property_scope = ANY (ARRAY['all'::text, 'selected'::text]))),
    CONSTRAINT profile_permissions_reglages_check CHECK ((reglages = ANY (ARRAY['none'::text, 'read'::text, 'write'::text]))),
    CONSTRAINT profile_permissions_reservations_check CHECK ((reservations = ANY (ARRAY['none'::text, 'read'::text, 'write'::text]))),
    CONSTRAINT profile_permissions_self_availability_check CHECK ((self_availability = ANY (ARRAY['none'::text, 'read'::text, 'write'::text])))
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_user_id uuid NOT NULL,
    member_user_id uuid,
    first_name text NOT NULL,
    last_name text,
    email text,
    phone text,
    access_mode text NOT NULL,
    pwa_token text,
    is_owner boolean DEFAULT false NOT NULL,
    active boolean DEFAULT true NOT NULL,
    invited_at timestamp with time zone,
    accepted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    invite_token text,
    invite_expires_at timestamp with time zone,
    CONSTRAINT profiles_access_mode_check CHECK ((access_mode = ANY (ARRAY['compte'::text, 'lien'::text]))),
    CONSTRAINT profiles_invite_coherent CHECK ((((invite_token IS NULL) AND (invite_expires_at IS NULL)) OR ((invite_token IS NOT NULL) AND (invite_expires_at IS NOT NULL) AND (accepted_at IS NULL) AND (access_mode = 'compte'::text)))),
    CONSTRAINT profiles_token_coherent CHECK ((((access_mode = 'lien'::text) AND ((pwa_token IS NOT NULL) OR (active = false))) OR ((access_mode = 'compte'::text) AND (pwa_token IS NULL))))
);


--
-- Name: profiles_legacy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles_legacy (
    id uuid NOT NULL,
    email text,
    full_name text,
    plan text DEFAULT 'starter'::text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: properties; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.properties (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    provider_property_id text,
    created_at timestamp without time zone DEFAULT now(),
    provider text DEFAULT 'channex'::text NOT NULL,
    provider_room_type_id text,
    provider_rate_plan_id text,
    currency text DEFAULT 'EUR'::text NOT NULL,
    address text,
    city text,
    country text DEFAULT 'FR'::text,
    capacity integer DEFAULT 2,
    updated_at timestamp without time zone DEFAULT now(),
    zip_code text,
    base_price numeric,
    included_guests integer,
    extra_guest_fee numeric,
    orphan_autofix boolean DEFAULT false,
    orphan_price_enabled boolean DEFAULT false,
    orphan_price_mode text DEFAULT 'set'::text,
    orphan_price_unit text DEFAULT 'eur'::text,
    orphan_price_value numeric,
    inventory_type text DEFAULT 'whole'::text NOT NULL,
    last_fullsync_at timestamp with time zone,
    channel_ready boolean DEFAULT false NOT NULL,
    channel_ready_at timestamp with time zone,
    messages_backfilled boolean DEFAULT false NOT NULL,
    rate_sync_mode text DEFAULT 'keep'::text NOT NULL,
    ota_connect_status text DEFAULT 'draft'::text NOT NULL,
    ota_requested_at timestamp with time zone,
    ota_listing_urls jsonb,
    active_at timestamp with time zone,
    automation_paused boolean DEFAULT false NOT NULL,
    paused_at timestamp with time zone,
    paused_reason text,
    checkin_time text,
    checkout_time text,
    cleaning_assignment_mode text DEFAULT 'priorite'::text NOT NULL,
    inventory_units integer DEFAULT 1 NOT NULL,
    cancellation_policy text DEFAULT 'non_remboursable'::text NOT NULL,
    property_type text,
    timezone text,
    migration_target_property_id text,
    migration_target_at timestamp with time zone,
    zone_scolaire text,
    prix_minimum integer,
    CONSTRAINT properties_cancellation_policy CHECK ((cancellation_policy = ANY (ARRAY['non_remboursable'::text, 'j14'::text, 'j7'::text, 'flexible_j2'::text]))),
    CONSTRAINT properties_cleaning_mode_valide CHECK ((cleaning_assignment_mode = ANY (ARRAY['priorite'::text, 'jour'::text, 'quota'::text]))),
    CONSTRAINT properties_inventory_type_check CHECK ((inventory_type = ANY (ARRAY['whole'::text, 'room'::text, 'hotel'::text]))),
    CONSTRAINT properties_inventory_units_positif CHECK ((inventory_units >= 1)),
    CONSTRAINT properties_ota_connect_status_check CHECK ((ota_connect_status = ANY (ARRAY['draft'::text, 'requested'::text, 'live'::text]))),
    CONSTRAINT properties_prix_minimum_check CHECK (((prix_minimum IS NULL) OR ((prix_minimum > 0) AND (prix_minimum <= 10000000)))),
    CONSTRAINT properties_rate_sync_mode_check CHECK ((rate_sync_mode = ANY (ARRAY['keep'::text, 'managed'::text]))),
    CONSTRAINT properties_zone_scolaire_check CHECK (((zone_scolaire IS NULL) OR (zone_scolaire = ANY (ARRAY['A'::text, 'B'::text, 'C'::text]))))
);


--
-- Name: COLUMN properties.zone_scolaire; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.properties.zone_scolaire IS 'Zone de vacances scolaires du bien (A, B ou C), deduite du departement puis modifiable. Ne limite PAS le moteur, qui lit les 3 zones : situe le bien.';


--
-- Name: COLUMN properties.prix_minimum; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.properties.prix_minimum IS 'Prix plancher du bien, en CENTIMES. Une nuit dont le tarif tombe en dessous n''est pas poussee : elle est FERMEE et l''hote alerte. NULL = plancher global du code. Ne corrige jamais le prix : un prix remonte d''office serait un prix que l''hote n''a pas choisi.';


--
-- Name: property_channel_rate_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.property_channel_rate_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    property_id uuid NOT NULL,
    channel text NOT NULL,
    role text DEFAULT 'derived'::text NOT NULL,
    provider_rate_plan_id text NOT NULL,
    derive_mode text DEFAULT 'percent'::text,
    derive_value numeric DEFAULT 0,
    min_stay integer,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: property_cleaning_providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.property_cleaning_providers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    property_id text NOT NULL,
    provider_id uuid NOT NULL,
    rang integer DEFAULT 1 NOT NULL,
    weekdays integer[],
    quota_share numeric,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    requires_ack boolean DEFAULT true NOT NULL,
    CONSTRAINT property_cleaning_providers_rang_check CHECK ((rang >= 1))
);


--
-- Name: property_locks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.property_locks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lock_id uuid NOT NULL,
    property_id text NOT NULL,
    role text DEFAULT 'main'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    user_id uuid
);


--
-- Name: property_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.property_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    property_id text NOT NULL,
    raw jsonb NOT NULL,
    raw_hash text NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: property_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.property_status (
    user_id uuid NOT NULL,
    property_id text NOT NULL,
    status text DEFAULT 'unknown'::text NOT NULL,
    current_booking_id text,
    next_booking_id text,
    last_menage_at timestamp with time zone,
    last_checkin_at timestamp with time zone,
    last_checkout_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT property_status_status_check CHECK ((status = ANY (ARRAY['occupied'::text, 'to_clean'::text, 'ready'::text, 'unknown'::text])))
);


--
-- Name: provider_availability_exceptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_availability_exceptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    provider_id uuid NOT NULL,
    date date NOT NULL,
    available boolean NOT NULL,
    reason text,
    source text DEFAULT 'prestataire'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_availability_exceptions_source_check CHECK ((source = ANY (ARRAY['prestataire'::text, 'hote'::text])))
);


--
-- Name: TABLE provider_availability_exceptions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.provider_availability_exceptions IS 'Conges et disponibilites exceptionnelles. Prime toujours sur les regles RRULE.';


--
-- Name: provider_availability_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_availability_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    provider_id uuid NOT NULL,
    rrule text NOT NULL,
    label text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_availability_rules_rrule_non_vide CHECK ((length(TRIM(BOTH FROM rrule)) > 0))
);


--
-- Name: TABLE provider_availability_rules; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.provider_availability_rules IS 'Disponibilites recurrentes au format RRULE. Aucune regle = disponible.';


--
-- Name: provider_keys_migrated; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_keys_migrated (
    user_id uuid NOT NULL,
    provider text NOT NULL,
    provider_property_id text NOT NULL,
    target_property_id uuid,
    migrated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: public_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.public_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    token text NOT NULL,
    label text,
    created_at timestamp with time zone DEFAULT now(),
    property_ids text[] DEFAULT '{}'::text[],
    visibility_days integer DEFAULT 30,
    ratio_periode text DEFAULT 'toujours'::text NOT NULL,
    CONSTRAINT public_tokens_ratio_periode_valide CHECK ((ratio_periode = ANY (ARRAY['15j'::text, '30j'::text, '6mois'::text, 'toujours'::text])))
);


--
-- Name: rekeying_backup; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rekeying_backup (
    id bigint NOT NULL,
    fait_le timestamp with time zone DEFAULT now() NOT NULL,
    bien_id uuid NOT NULL,
    source text NOT NULL,
    cible text NOT NULL,
    nom_table text NOT NULL,
    lignes jsonb NOT NULL
);


--
-- Name: rekeying_backup_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.rekeying_backup_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rekeying_backup_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.rekeying_backup_id_seq OWNED BY public.rekeying_backup.id;


--
-- Name: school_holidays; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_holidays (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    zone text NOT NULL,
    annee_scolaire text NOT NULL,
    nom text NOT NULL,
    date_debut date NOT NULL,
    date_fin date NOT NULL,
    importe_le timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT school_holidays_periode_valide CHECK ((date_fin >= date_debut)),
    CONSTRAINT school_holidays_zone_check CHECK ((zone = ANY (ARRAY['A'::text, 'B'::text, 'C'::text])))
);


--
-- Name: TABLE school_holidays; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.school_holidays IS 'Vacances scolaires officielles par zone, importees et cachees. Bornes INCLUSES, heure locale : date_fin est le DERNIER jour de vacances, pas la rentree.';


--
-- Name: sms_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sms_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    to_number text NOT NULL,
    message text NOT NULL,
    sender text,
    status text,
    twilio_sid text,
    property_id text,
    context text,
    error text,
    user_id uuid
);


--
-- Name: stripe_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stripe_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    secret_key_cipher text NOT NULL,
    key_last4 text,
    mode text DEFAULT 'test'::text NOT NULL,
    key_restricted boolean DEFAULT false NOT NULL,
    webhook_endpoint_id text,
    webhook_secret_cipher text,
    webhook_url_token text,
    verified_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stripe_accounts_chiffre CHECK (((secret_key_cipher ~~ 'v1:%'::text) AND ((webhook_secret_cipher IS NULL) OR (webhook_secret_cipher ~~ 'v1:%'::text)))),
    CONSTRAINT stripe_accounts_mode CHECK ((mode = ANY (ARRAY['test'::text, 'live'::text])))
);


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    module text NOT NULL,
    status text NOT NULL,
    stripe_customer_id text,
    stripe_subscription_id text,
    trial_ends_at timestamp with time zone,
    current_period_start timestamp with time zone,
    current_period_end timestamp with time zone,
    cancel_at_period_end boolean DEFAULT false NOT NULL,
    quantity smallint DEFAULT 1 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscriptions_module_check CHECK ((module = ANY (ARRAY['guestflow'::text, 'menage'::text, 'serrure'::text, 'caution'::text]))),
    CONSTRAINT subscriptions_status_check CHECK ((status = ANY (ARRAY['trialing'::text, 'active'::text, 'past_due'::text, 'canceled'::text, 'incomplete'::text, 'incomplete_expired'::text, 'unpaid'::text])))
);


--
-- Name: write_locks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.write_locks (
    key text NOT NULL,
    token text,
    expire_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: yield_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.yield_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    property_id uuid NOT NULL,
    nom text NOT NULL,
    date_debut date NOT NULL,
    date_fin date NOT NULL,
    recurrence text DEFAULT 'ponctuelle'::text NOT NULL,
    parent_segment text,
    reconduit_de uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT yield_events_nom_court CHECK ((length(nom) <= 80)),
    CONSTRAINT yield_events_nom_non_vide CHECK ((length(btrim(nom)) > 0)),
    CONSTRAINT yield_events_parent_connu CHECK (((parent_segment IS NULL) OR (parent_segment = ANY (ARRAY['ferie'::text, 'pont'::text, 'vacances_zone_du_bien'::text, 'vacances_autre_zone'::text, 'hors_vacances'::text])))),
    CONSTRAINT yield_events_periode_valide CHECK ((date_fin >= date_debut)),
    CONSTRAINT yield_events_recurrence_connue CHECK ((recurrence = ANY (ARRAY['annuelle_fixe'::text, 'annuelle_ajustable'::text, 'ponctuelle'::text])))
);


--
-- Name: TABLE yield_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.yield_events IS 'Evenements declares par l''hote (saison thermale, festival...). Chaque ligne est une occurrence REELLE et datee : la reconduction annuelle est proposee a l''ecran et confirmee par l''hote, jamais en silence.';


--
-- Name: COLUMN yield_events.recurrence; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.yield_events.recurrence IS 'Comment PROPOSER la reconduction, jamais comment ecrire. Aucune ligne n''est creee sans confirmation.';


--
-- Name: COLUMN yield_events.parent_segment; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.yield_events.parent_segment IS 'Segment auquel emprunter la reference tant que l''evenement n''a pas son propre historique (meme regle que les ponts, §6 bis). NULL = pas d''emprunt.';


--
-- Name: yield_exceptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.yield_exceptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    property_id uuid NOT NULL,
    date_debut date NOT NULL,
    date_fin date NOT NULL,
    motif text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT yield_exceptions_motif_non_vide CHECK ((length(btrim(motif)) > 0)),
    CONSTRAINT yield_exceptions_periode_valide CHECK ((date_fin >= date_debut))
);


--
-- Name: TABLE yield_exceptions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.yield_exceptions IS 'Periodes exclues de la reference du moteur YieldFlow (travaux, fermeture personnelle...). Bornes INCLUSES. Marquage par periode uniquement : le marquage par reservation attendra un besoin reel.';


--
-- Name: COLUMN yield_exceptions.motif; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.yield_exceptions.motif IS 'Texte libre. Aucun calcul n''en depend : c''est une trace pour l''hote, pas une categorie.';


--
-- Name: yield_segment_reglages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.yield_segment_reglages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    property_id uuid NOT NULL,
    segment text NOT NULL,
    actif boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    crans smallint,
    CONSTRAINT yield_reglages_crans_bornes CHECK (((crans IS NULL) OR ((crans >= '-4'::integer) AND (crans <= 4)))),
    CONSTRAINT yield_reglages_segment_court CHECK ((length(segment) <= 120)),
    CONSTRAINT yield_reglages_segment_non_vide CHECK ((length(btrim(segment)) > 0))
);


--
-- Name: TABLE yield_segment_reglages; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.yield_segment_reglages IS 'Ce que l''hote decide d''un contexte de prix : de combien de crans il pousse la structure du bien (prioritaire sur le calcul) et s''il compte pour ce bien. Absence de ligne = actif, cran mesure.';


--
-- Name: COLUMN yield_segment_reglages.crans; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.yield_segment_reglages.crans IS 'Decalage impose par l''hote, en crans de la grille (+1, +2, -1...). Prioritaire sur le cran mesure depuis la mediane du segment. NULL = calcul.';


--
-- Name: rekeying_backup id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rekeying_backup ALTER COLUMN id SET DEFAULT nextval('public.rekeying_backup_id_seq'::regclass);


--
-- Name: access_codes access_codes_lock_id_booking_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_codes
    ADD CONSTRAINT access_codes_lock_id_booking_id_key UNIQUE (lock_id, booking_id);


--
-- Name: access_codes access_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_codes
    ADD CONSTRAINT access_codes_pkey PRIMARY KEY (id);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (user_id);


--
-- Name: agent_alert_config agent_alert_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_alert_config
    ADD CONSTRAINT agent_alert_config_pkey PRIMARY KEY (id);


--
-- Name: agent_alert_config agent_alert_config_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_alert_config
    ADD CONSTRAINT agent_alert_config_user_id_key UNIQUE (user_id);


--
-- Name: agent_prompting agent_prompting_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_prompting
    ADD CONSTRAINT agent_prompting_pkey PRIMARY KEY (id);


--
-- Name: agent_tasks agent_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tasks
    ADD CONSTRAINT agent_tasks_pkey PRIMARY KEY (id);


--
-- Name: airbnb_connect_sessions airbnb_connect_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.airbnb_connect_sessions
    ADD CONSTRAINT airbnb_connect_sessions_pkey PRIMARY KEY (token);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: api_keys api_keys_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_user_id_key UNIQUE (user_id);


--
-- Name: app_logs app_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_logs
    ADD CONSTRAINT app_logs_pkey PRIMARY KEY (id);


--
-- Name: automation_incidents automation_incidents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_incidents
    ADD CONSTRAINT automation_incidents_pkey PRIMARY KEY (id);


--
-- Name: availability_push_log availability_push_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.availability_push_log
    ADD CONSTRAINT availability_push_log_pkey PRIMARY KEY (id);


--
-- Name: availability_push_log availability_push_log_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.availability_push_log
    ADD CONSTRAINT availability_push_log_uniq UNIQUE (property_id, room_type_id, date_from, date_to, availability);


--
-- Name: booking_attempts booking_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_attempts
    ADD CONSTRAINT booking_attempts_pkey PRIMARY KEY (id);


--
-- Name: booking_change_events booking_change_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_change_events
    ADD CONSTRAINT booking_change_events_pkey PRIMARY KEY (id);


--
-- Name: booking_links booking_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_links
    ADD CONSTRAINT booking_links_pkey PRIMARY KEY (id);


--
-- Name: bookings_snapshot bookings_snapshot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings_snapshot
    ADD CONSTRAINT bookings_snapshot_pkey PRIMARY KEY (id);


--
-- Name: bookings_snapshot bookings_snapshot_user_id_booking_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings_snapshot
    ADD CONSTRAINT bookings_snapshot_user_id_booking_id_key UNIQUE (user_id, booking_id);


--
-- Name: calendar_inventory calendar_inventory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_inventory
    ADD CONSTRAINT calendar_inventory_pkey PRIMARY KEY (id);


--
-- Name: calendar_inventory calendar_inventory_property_id_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_inventory
    ADD CONSTRAINT calendar_inventory_property_id_date_key UNIQUE (property_id, date);


--
-- Name: channel_sync_queue channel_sync_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_sync_queue
    ADD CONSTRAINT channel_sync_queue_pkey PRIMARY KEY (id);


--
-- Name: conges_plages conges_plages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conges_plages
    ADD CONSTRAINT conges_plages_pkey PRIMARY KEY (id);


--
-- Name: conversation_flags conversation_flags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_flags
    ADD CONSTRAINT conversation_flags_pkey PRIMARY KEY (id);


--
-- Name: conversation_flags conversation_flags_user_id_book_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_flags
    ADD CONSTRAINT conversation_flags_user_id_book_id_key UNIQUE (user_id, book_id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: cron_logs cron_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cron_logs
    ADD CONSTRAINT cron_logs_pkey PRIMARY KEY (id);


--
-- Name: integration_requests integration_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_requests
    ADD CONSTRAINT integration_requests_pkey PRIMARY KEY (id);


--
-- Name: kb_question_templates kb_question_templates_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kb_question_templates
    ADD CONSTRAINT kb_question_templates_code_key UNIQUE (code);


--
-- Name: kb_question_templates kb_question_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kb_question_templates
    ADD CONSTRAINT kb_question_templates_pkey PRIMARY KEY (id);


--
-- Name: knowledge knowledge_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge
    ADD CONSTRAINT knowledge_pkey PRIMARY KEY (id);


--
-- Name: knowledge knowledge_user_property_type_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge
    ADD CONSTRAINT knowledge_user_property_type_key_unique UNIQUE (user_id, property_id, type, key);


--
-- Name: lock_alert_config lock_alert_config_lock_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lock_alert_config
    ADD CONSTRAINT lock_alert_config_lock_id_key UNIQUE (lock_id);


--
-- Name: lock_alert_config lock_alert_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lock_alert_config
    ADD CONSTRAINT lock_alert_config_pkey PRIMARY KEY (id);


--
-- Name: locks locks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.locks
    ADD CONSTRAINT locks_pkey PRIMARY KEY (id);


--
-- Name: locks locks_seam_device_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.locks
    ADD CONSTRAINT locks_seam_device_id_key UNIQUE (seam_device_id);


--
-- Name: menage_assignment_log menage_assignment_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menage_assignment_log
    ADD CONSTRAINT menage_assignment_log_pkey PRIMARY KEY (id);


--
-- Name: menage_comments menage_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menage_comments
    ADD CONSTRAINT menage_comments_pkey PRIMARY KEY (id);


--
-- Name: menage_comments menage_comments_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menage_comments
    ADD CONSTRAINT menage_comments_unique UNIQUE (user_id, booking_id, departure_date);


--
-- Name: menage_done menage_done_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menage_done
    ADD CONSTRAINT menage_done_pkey PRIMARY KEY (id);


--
-- Name: menage_done menage_done_user_id_property_id_booking_id_departure_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menage_done
    ADD CONSTRAINT menage_done_user_id_property_id_booking_id_departure_date_key UNIQUE (user_id, property_id, booking_id, departure_date);


--
-- Name: menage_events menage_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menage_events
    ADD CONSTRAINT menage_events_pkey PRIMARY KEY (id);


--
-- Name: menages menages_identite; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menages
    ADD CONSTRAINT menages_identite UNIQUE (user_id, property_id, booking_id, departure_date);


--
-- Name: menages menages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menages
    ADD CONSTRAINT menages_pkey PRIMARY KEY (id);


--
-- Name: message_sent_log message_sent_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_sent_log
    ADD CONSTRAINT message_sent_log_pkey PRIMARY KEY (id);


--
-- Name: message_templates message_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_templates
    ADD CONSTRAINT message_templates_pkey PRIMARY KEY (id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: onboarding_state onboarding_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onboarding_state
    ADD CONSTRAINT onboarding_state_pkey PRIMARY KEY (user_id);


--
-- Name: ota_reviews ota_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ota_reviews
    ADD CONSTRAINT ota_reviews_pkey PRIMARY KEY (id);


--
-- Name: ota_reviews ota_reviews_unique_source; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ota_reviews
    ADD CONSTRAINT ota_reviews_unique_source UNIQUE (user_id, provider, external_review_id);


--
-- Name: property_cleaning_providers pcp_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_cleaning_providers
    ADD CONSTRAINT pcp_unique UNIQUE (user_id, property_id, provider_id);


--
-- Name: prestataire_periodes prestataire_periodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prestataire_periodes
    ADD CONSTRAINT prestataire_periodes_pkey PRIMARY KEY (id);


--
-- Name: price_display_log price_display_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_display_log
    ADD CONSTRAINT price_display_log_pkey PRIMARY KEY (id);


--
-- Name: profile_permissions profile_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profile_permissions
    ADD CONSTRAINT profile_permissions_pkey PRIMARY KEY (profile_id);


--
-- Name: profiles profiles_account_user_id_member_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_account_user_id_member_user_id_key UNIQUE (account_user_id, member_user_id);


--
-- Name: profiles_legacy profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles_legacy
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_pkey1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey1 PRIMARY KEY (id);


--
-- Name: profiles profiles_pwa_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pwa_token_key UNIQUE (pwa_token);


--
-- Name: properties properties_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.properties
    ADD CONSTRAINT properties_pkey PRIMARY KEY (id);


--
-- Name: properties properties_user_provider_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.properties
    ADD CONSTRAINT properties_user_provider_unique UNIQUE (user_id, provider, provider_property_id);


--
-- Name: property_channel_rate_plans property_channel_rate_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_channel_rate_plans
    ADD CONSTRAINT property_channel_rate_plans_pkey PRIMARY KEY (id);


--
-- Name: property_channel_rate_plans property_channel_rate_plans_property_id_channel_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_channel_rate_plans
    ADD CONSTRAINT property_channel_rate_plans_property_id_channel_key UNIQUE (property_id, channel);


--
-- Name: property_cleaning_providers property_cleaning_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_cleaning_providers
    ADD CONSTRAINT property_cleaning_providers_pkey PRIMARY KEY (id);


--
-- Name: property_locks property_locks_lock_id_property_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_locks
    ADD CONSTRAINT property_locks_lock_id_property_id_key UNIQUE (lock_id, property_id);


--
-- Name: property_locks property_locks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_locks
    ADD CONSTRAINT property_locks_pkey PRIMARY KEY (id);


--
-- Name: property_snapshots property_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_snapshots
    ADD CONSTRAINT property_snapshots_pkey PRIMARY KEY (id);


--
-- Name: property_status property_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_status
    ADD CONSTRAINT property_status_pkey PRIMARY KEY (user_id, property_id);


--
-- Name: provider_availability_exceptions provider_availability_exceptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_availability_exceptions
    ADD CONSTRAINT provider_availability_exceptions_pkey PRIMARY KEY (id);


--
-- Name: provider_availability_exceptions provider_availability_exceptions_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_availability_exceptions
    ADD CONSTRAINT provider_availability_exceptions_unique UNIQUE (provider_id, date);


--
-- Name: provider_availability_rules provider_availability_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_availability_rules
    ADD CONSTRAINT provider_availability_rules_pkey PRIMARY KEY (id);


--
-- Name: provider_keys_migrated provider_keys_migrated_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_keys_migrated
    ADD CONSTRAINT provider_keys_migrated_pkey PRIMARY KEY (user_id, provider, provider_property_id);


--
-- Name: public_tokens public_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_tokens
    ADD CONSTRAINT public_tokens_pkey PRIMARY KEY (id);


--
-- Name: public_tokens public_tokens_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_tokens
    ADD CONSTRAINT public_tokens_token_key UNIQUE (token);


--
-- Name: rekeying_backup rekeying_backup_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rekeying_backup
    ADD CONSTRAINT rekeying_backup_pkey PRIMARY KEY (id);


--
-- Name: school_holidays school_holidays_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_holidays
    ADD CONSTRAINT school_holidays_pkey PRIMARY KEY (id);


--
-- Name: sms_logs sms_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_logs
    ADD CONSTRAINT sms_logs_pkey PRIMARY KEY (id);


--
-- Name: stripe_accounts stripe_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_accounts
    ADD CONSTRAINT stripe_accounts_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_stripe_subscription_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_stripe_subscription_id_key UNIQUE (stripe_subscription_id);


--
-- Name: subscriptions subscriptions_user_id_module_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_user_id_module_key UNIQUE (user_id, module);


--
-- Name: write_locks write_locks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.write_locks
    ADD CONSTRAINT write_locks_pkey PRIMARY KEY (key);


--
-- Name: yield_events yield_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.yield_events
    ADD CONSTRAINT yield_events_pkey PRIMARY KEY (id);


--
-- Name: yield_exceptions yield_exceptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.yield_exceptions
    ADD CONSTRAINT yield_exceptions_pkey PRIMARY KEY (id);


--
-- Name: yield_segment_reglages yield_segment_reglages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.yield_segment_reglages
    ADD CONSTRAINT yield_segment_reglages_pkey PRIMARY KEY (id);


--
-- Name: access_codes_booking_lock_active_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX access_codes_booking_lock_active_uidx ON public.access_codes USING btree (booking_id, lock_id) WHERE (status IS DISTINCT FROM 'deleted'::text);


--
-- Name: agent_prompting_user_property_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agent_prompting_user_property_idx ON public.agent_prompting USING btree (user_id, COALESCE(property_id, '__GLOBAL__'::text));


--
-- Name: automation_incidents_non_acquittes; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX automation_incidents_non_acquittes ON public.automation_incidents USING btree (type, acquitted_at) WHERE (acquitted_at IS NULL);


--
-- Name: availability_push_log_pushed_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX availability_push_log_pushed_at_idx ON public.availability_push_log USING btree (pushed_at);


--
-- Name: booking_attempts_a_traiter; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX booking_attempts_a_traiter ON public.booking_attempts USING btree (status, created_at) WHERE (status = ANY (ARRAY['paid'::text, 'refunded'::text]));


--
-- Name: booking_attempts_bien_dates; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX booking_attempts_bien_dates ON public.booking_attempts USING btree (property_id, arrival);


--
-- Name: booking_attempts_idempotence; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX booking_attempts_idempotence ON public.booking_attempts USING btree (idempotency_key);


--
-- Name: booking_attempts_session; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX booking_attempts_session ON public.booking_attempts USING btree (checkout_session_id) WHERE (checkout_session_id IS NOT NULL);


--
-- Name: booking_change_events_booking_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX booking_change_events_booking_idx ON public.booking_change_events USING btree (booking_id, created_at DESC);


--
-- Name: booking_change_events_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX booking_change_events_pending_idx ON public.booking_change_events USING btree (created_at) WHERE (processed_at IS NULL);


--
-- Name: booking_links_property; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX booking_links_property ON public.booking_links USING btree (property_id);


--
-- Name: booking_links_token_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX booking_links_token_unique ON public.booking_links USING btree (token);


--
-- Name: channel_sync_queue_one_active_per_property; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX channel_sync_queue_one_active_per_property ON public.channel_sync_queue USING btree (property_id) WHERE (status = ANY (ARRAY['pending'::text, 'processing'::text]));


--
-- Name: channel_sync_queue_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_sync_queue_status_created_idx ON public.channel_sync_queue USING btree (status, created_at);


--
-- Name: conges_plages_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conges_plages_idx ON public.conges_plages USING btree (user_id, provider_id, debut, fin);


--
-- Name: idx_agent_alert_config_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_alert_config_user_id ON public.agent_alert_config USING btree (user_id);


--
-- Name: idx_agent_tasks_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_tasks_created_at ON public.agent_tasks USING btree (created_at);


--
-- Name: idx_agent_tasks_lock_battery; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_tasks_lock_battery ON public.agent_tasks USING btree (lock_id, task_type, status) WHERE (task_type = 'battery_low'::text);


--
-- Name: idx_automation_incidents_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_automation_incidents_created_at ON public.automation_incidents USING btree (created_at);


--
-- Name: idx_bookings_snapshot_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_snapshot_created_at ON public.bookings_snapshot USING btree (created_at);


--
-- Name: idx_calendar_inventory_prop_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_calendar_inventory_prop_date ON public.calendar_inventory USING btree (property_id, date);


--
-- Name: idx_integration_requests_contact_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integration_requests_contact_phone ON public.integration_requests USING btree (contact_phone) WHERE (contact_phone IS NOT NULL);


--
-- Name: idx_integration_requests_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integration_requests_status ON public.integration_requests USING btree (status, type);


--
-- Name: idx_integration_requests_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integration_requests_user ON public.integration_requests USING btree (user_id);


--
-- Name: idx_kb_templates_category_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kb_templates_category_order ON public.kb_question_templates USING btree (category, sort_order);


--
-- Name: idx_kb_templates_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kb_templates_priority ON public.kb_question_templates USING btree (priority);


--
-- Name: idx_menage_done_departure; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_menage_done_departure ON public.menage_done USING btree (departure_date);


--
-- Name: idx_menage_done_user_property; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_menage_done_user_property ON public.menage_done USING btree (user_id, property_id);


--
-- Name: idx_menage_events_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_menage_events_created_at ON public.menage_events USING btree (created_at);


--
-- Name: idx_message_sent_log_sent_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_sent_log_sent_at ON public.message_sent_log USING btree (sent_at);


--
-- Name: idx_messages_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_created_at ON public.messages USING btree (created_at);


--
-- Name: idx_onboarding_state_completed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_onboarding_state_completed ON public.onboarding_state USING btree (completed) WHERE (completed = false);


--
-- Name: idx_onboarding_state_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_onboarding_state_status ON public.onboarding_state USING btree (status);


--
-- Name: idx_property_status_user_prop; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_property_status_user_prop ON public.property_status USING btree (user_id, property_id);


--
-- Name: idx_sms_logs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sms_logs_created_at ON public.sms_logs USING btree (created_at);


--
-- Name: idx_subscriptions_status_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_status_active ON public.subscriptions USING btree (status) WHERE (status = ANY (ARRAY['trialing'::text, 'active'::text]));


--
-- Name: idx_subscriptions_stripe_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_stripe_customer ON public.subscriptions USING btree (stripe_customer_id) WHERE (stripe_customer_id IS NOT NULL);


--
-- Name: idx_subscriptions_user_module; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_subscriptions_user_module ON public.subscriptions USING btree (user_id, module);


--
-- Name: ix_automation_incidents_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_automation_incidents_lookup ON public.automation_incidents USING btree (type, property_id, created_at DESC);


--
-- Name: menage_assignment_log_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX menage_assignment_log_idx ON public.menage_assignment_log USING btree (user_id, menage_id, created_at);


--
-- Name: menages_bien_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX menages_bien_idx ON public.menages USING btree (user_id, property_id, departure_date);


--
-- Name: menages_offre_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX menages_offre_idx ON public.menages USING btree (user_id, offered_to, offer_expires_at) WHERE (offered_to IS NOT NULL);


--
-- Name: menages_provider_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX menages_provider_idx ON public.menages USING btree (user_id, provider_id, departure_date);


--
-- Name: menages_statut_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX menages_statut_idx ON public.menages USING btree (user_id, status, departure_date);


--
-- Name: message_sent_log_dedup_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX message_sent_log_dedup_uidx ON public.message_sent_log USING btree (user_id, booking_id, template_id);


--
-- Name: message_sent_log_stay_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX message_sent_log_stay_key_idx ON public.message_sent_log USING btree (user_id, stay_key, template_id) WHERE (stay_key IS NOT NULL);


--
-- Name: messages_booking_sent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_booking_sent_idx ON public.messages USING btree (booking_id, sent_at);


--
-- Name: messages_provider_msgid_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX messages_provider_msgid_uidx ON public.messages USING btree (provider, provider_msg_id) WHERE (provider_msg_id IS NOT NULL);


--
-- Name: messages_sans_msgid_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX messages_sans_msgid_unique_idx ON public.messages USING btree (user_id, COALESCE(booking_id, ''::text), direction, sender, md5(btrim(body)), date_trunc('minute'::text, (sent_at AT TIME ZONE 'UTC'::text))) WHERE (provider_msg_id IS NULL);


--
-- Name: messages_user_sent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_user_sent_idx ON public.messages USING btree (user_id, sent_at DESC);


--
-- Name: ota_reviews_a_analyser_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ota_reviews_a_analyser_idx ON public.ota_reviews USING btree (user_id, received_at) WHERE (ai_analyzed_at IS NULL);


--
-- Name: ota_reviews_a_valider_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ota_reviews_a_valider_idx ON public.ota_reviews USING btree (user_id, received_at DESC) WHERE (statut = 'detecte'::text);


--
-- Name: ota_reviews_booking_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ota_reviews_booking_idx ON public.ota_reviews USING btree (user_id, booking_uid) WHERE (booking_uid IS NOT NULL);


--
-- Name: ota_reviews_confirmes_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ota_reviews_confirmes_idx ON public.ota_reviews USING btree (user_id, property_id_ref, received_at DESC) WHERE (statut = 'confirme'::text);


--
-- Name: ota_reviews_resa_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ota_reviews_resa_idx ON public.ota_reviews USING btree (user_id, ota_reservation_id) WHERE (ota_reservation_id IS NOT NULL);


--
-- Name: ota_reviews_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ota_reviews_scope_idx ON public.ota_reviews USING btree (user_id, property_id_ref, received_at DESC);


--
-- Name: pcp_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pcp_lookup_idx ON public.property_cleaning_providers USING btree (user_id, property_id, active, rang);


--
-- Name: prestataire_periodes_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX prestataire_periodes_lookup_idx ON public.prestataire_periodes USING btree (user_id, property_id_ref, debut, fin);


--
-- Name: prestataire_periodes_provider_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX prestataire_periodes_provider_idx ON public.prestataire_periodes USING btree (user_id, provider_id);


--
-- Name: price_display_log_bien_nuit_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_display_log_bien_nuit_idx ON public.price_display_log USING btree (property_id, stay_date);


--
-- Name: price_display_log_courante_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX price_display_log_courante_idx ON public.price_display_log USING btree (property_id, stay_date) WHERE ((replaced_at IS NULL) AND (sold_at IS NULL));


--
-- Name: price_display_log_vente_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_display_log_vente_idx ON public.price_display_log USING btree (sold_booking_uid) WHERE (sold_booking_uid IS NOT NULL);


--
-- Name: profile_permissions_compte_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX profile_permissions_compte_idx ON public.profile_permissions USING btree (account_user_id);


--
-- Name: profiles_compte_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX profiles_compte_idx ON public.profiles USING btree (account_user_id);


--
-- Name: profiles_invite_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX profiles_invite_token_idx ON public.profiles USING btree (invite_token) WHERE (invite_token IS NOT NULL);


--
-- Name: profiles_membre_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX profiles_membre_idx ON public.profiles USING btree (member_user_id) WHERE (member_user_id IS NOT NULL);


--
-- Name: profiles_un_seul_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX profiles_un_seul_owner ON public.profiles USING btree (account_user_id) WHERE is_owner;


--
-- Name: properties_migration_target_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX properties_migration_target_unique ON public.properties USING btree (migration_target_property_id) WHERE (migration_target_property_id IS NOT NULL);


--
-- Name: properties_user_provider_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX properties_user_provider_idx ON public.properties USING btree (user_id, provider_property_id);


--
-- Name: property_snapshots_bien_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX property_snapshots_bien_unique ON public.property_snapshots USING btree (user_id, provider, property_id);


--
-- Name: property_snapshots_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX property_snapshots_user ON public.property_snapshots USING btree (user_id);


--
-- Name: provider_availability_exceptions_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_availability_exceptions_idx ON public.provider_availability_exceptions USING btree (user_id, provider_id, date);


--
-- Name: provider_availability_rules_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_availability_rules_idx ON public.provider_availability_rules USING btree (user_id, provider_id, active);


--
-- Name: provider_keys_migrated_compte_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_keys_migrated_compte_idx ON public.provider_keys_migrated USING btree (user_id, provider);


--
-- Name: rekeying_backup_bien_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rekeying_backup_bien_idx ON public.rekeying_backup USING btree (bien_id, fait_le DESC);


--
-- Name: school_holidays_periode_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX school_holidays_periode_idx ON public.school_holidays USING btree (date_debut, date_fin);


--
-- Name: school_holidays_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX school_holidays_unique_idx ON public.school_holidays USING btree (zone, nom, date_debut);


--
-- Name: sms_logs_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sms_logs_user_id_idx ON public.sms_logs USING btree (user_id);


--
-- Name: stripe_accounts_user_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX stripe_accounts_user_unique ON public.stripe_accounts USING btree (user_id);


--
-- Name: stripe_accounts_webhook_token_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX stripe_accounts_webhook_token_unique ON public.stripe_accounts USING btree (webhook_url_token) WHERE (webhook_url_token IS NOT NULL);


--
-- Name: ux_properties_beds24; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_properties_beds24 ON public.properties USING btree (user_id, provider_property_id) WHERE (provider = 'beds24'::text);


--
-- Name: write_locks_expire; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX write_locks_expire ON public.write_locks USING btree (expire_at);


--
-- Name: yield_events_bien_periode_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX yield_events_bien_periode_idx ON public.yield_events USING btree (property_id, date_debut, date_fin);


--
-- Name: yield_events_unicite_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX yield_events_unicite_idx ON public.yield_events USING btree (property_id, nom, date_debut);


--
-- Name: yield_exceptions_bien_periode_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX yield_exceptions_bien_periode_idx ON public.yield_exceptions USING btree (property_id, date_debut, date_fin);


--
-- Name: yield_reglages_unicite_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX yield_reglages_unicite_idx ON public.yield_segment_reglages USING btree (property_id, segment);


--
-- Name: ota_reviews ota_reviews_reanalyse_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ota_reviews_reanalyse_trg BEFORE UPDATE ON public.ota_reviews FOR EACH ROW EXECUTE FUNCTION public.ota_reviews_reanalyse();


--
-- Name: ota_reviews ota_reviews_touch_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ota_reviews_touch_trg BEFORE UPDATE ON public.ota_reviews FOR EACH ROW EXECUTE FUNCTION public.ota_reviews_touch();


--
-- Name: profile_permissions profile_permissions_sync_refs; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER profile_permissions_sync_refs BEFORE INSERT OR UPDATE OF property_ids ON public.profile_permissions FOR EACH ROW EXECUTE FUNCTION public.sync_refs_ligne();


--
-- Name: properties properties_sync_refs; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER properties_sync_refs AFTER INSERT OR DELETE OR UPDATE OF provider_property_id ON public.properties FOR EACH ROW EXECUTE FUNCTION public.sync_refs_compte();


--
-- Name: onboarding_state trg_onboarding_state_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_onboarding_state_updated_at BEFORE UPDATE ON public.onboarding_state FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: subscriptions trg_subscriptions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_subscriptions_updated_at BEFORE UPDATE ON public.subscriptions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: access_codes access_codes_lock_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_codes
    ADD CONSTRAINT access_codes_lock_id_fkey FOREIGN KEY (lock_id) REFERENCES public.locks(id) ON DELETE CASCADE;


--
-- Name: accounts accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: agent_tasks agent_tasks_lock_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tasks
    ADD CONSTRAINT agent_tasks_lock_id_fkey FOREIGN KEY (lock_id) REFERENCES public.locks(id);


--
-- Name: agent_tasks agent_tasks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tasks
    ADD CONSTRAINT agent_tasks_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: airbnb_connect_sessions airbnb_connect_sessions_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.airbnb_connect_sessions
    ADD CONSTRAINT airbnb_connect_sessions_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE CASCADE;


--
-- Name: airbnb_connect_sessions airbnb_connect_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.airbnb_connect_sessions
    ADD CONSTRAINT airbnb_connect_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: api_keys api_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles_legacy(id) ON DELETE CASCADE;


--
-- Name: app_logs app_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_logs
    ADD CONSTRAINT app_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles_legacy(id) ON DELETE CASCADE;


--
-- Name: booking_attempts booking_attempts_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_attempts
    ADD CONSTRAINT booking_attempts_link_id_fkey FOREIGN KEY (link_id) REFERENCES public.booking_links(id) ON DELETE RESTRICT;


--
-- Name: booking_attempts booking_attempts_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_attempts
    ADD CONSTRAINT booking_attempts_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE CASCADE;


--
-- Name: booking_change_events booking_change_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_change_events
    ADD CONSTRAINT booking_change_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: booking_links booking_links_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_links
    ADD CONSTRAINT booking_links_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE CASCADE;


--
-- Name: bookings_snapshot bookings_snapshot_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings_snapshot
    ADD CONSTRAINT bookings_snapshot_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: calendar_inventory calendar_inventory_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calendar_inventory
    ADD CONSTRAINT calendar_inventory_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE CASCADE;


--
-- Name: channel_sync_queue channel_sync_queue_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_sync_queue
    ADD CONSTRAINT channel_sync_queue_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE CASCADE;


--
-- Name: conges_plages conges_plages_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conges_plages
    ADD CONSTRAINT conges_plages_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: conges_plages conges_plages_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conges_plages
    ADD CONSTRAINT conges_plages_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: conversation_flags conversation_flags_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_flags
    ADD CONSTRAINT conversation_flags_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles_legacy(id) ON DELETE CASCADE;


--
-- Name: conversations conversations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: access_codes fk_access_codes_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_codes
    ADD CONSTRAINT fk_access_codes_user FOREIGN KEY (user_id) REFERENCES public.profiles_legacy(id) ON DELETE CASCADE;


--
-- Name: agent_alert_config fk_agent_alert_config_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_alert_config
    ADD CONSTRAINT fk_agent_alert_config_user FOREIGN KEY (user_id) REFERENCES public.profiles_legacy(id) ON DELETE CASCADE;


--
-- Name: agent_prompting fk_agent_prompting_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_prompting
    ADD CONSTRAINT fk_agent_prompting_user FOREIGN KEY (user_id) REFERENCES public.profiles_legacy(id) ON DELETE CASCADE;


--
-- Name: agent_tasks fk_agent_tasks_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tasks
    ADD CONSTRAINT fk_agent_tasks_user FOREIGN KEY (user_id) REFERENCES public.profiles_legacy(id) ON DELETE CASCADE;


--
-- Name: conversations fk_conversations_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT fk_conversations_user FOREIGN KEY (user_id) REFERENCES public.profiles_legacy(id) ON DELETE CASCADE;


--
-- Name: knowledge fk_knowledge_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge
    ADD CONSTRAINT fk_knowledge_user FOREIGN KEY (user_id) REFERENCES public.profiles_legacy(id) ON DELETE CASCADE;


--
-- Name: lock_alert_config fk_lock_alert_config_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lock_alert_config
    ADD CONSTRAINT fk_lock_alert_config_user FOREIGN KEY (user_id) REFERENCES public.profiles_legacy(id) ON DELETE CASCADE;


--
-- Name: locks fk_locks_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.locks
    ADD CONSTRAINT fk_locks_user FOREIGN KEY (user_id) REFERENCES public.profiles_legacy(id) ON DELETE CASCADE;


--
-- Name: menage_comments fk_menage_comments_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menage_comments
    ADD CONSTRAINT fk_menage_comments_user FOREIGN KEY (user_id) REFERENCES public.profiles_legacy(id) ON DELETE CASCADE;


--
-- Name: menage_done fk_menage_done_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menage_done
    ADD CONSTRAINT fk_menage_done_user FOREIGN KEY (user_id) REFERENCES public.profiles_legacy(id) ON DELETE CASCADE;


--
-- Name: menage_events fk_menage_events_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menage_events
    ADD CONSTRAINT fk_menage_events_user FOREIGN KEY (user_id) REFERENCES public.profiles_legacy(id) ON DELETE CASCADE;


--
-- Name: message_sent_log fk_message_sent_log_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_sent_log
    ADD CONSTRAINT fk_message_sent_log_user FOREIGN KEY (user_id) REFERENCES public.profiles_legacy(id) ON DELETE CASCADE;


--
-- Name: message_templates fk_message_templates_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_templates
    ADD CONSTRAINT fk_message_templates_user FOREIGN KEY (user_id) REFERENCES public.profiles_legacy(id) ON DELETE CASCADE;


--
-- Name: property_locks fk_property_locks_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_locks
    ADD CONSTRAINT fk_property_locks_user FOREIGN KEY (user_id) REFERENCES public.profiles_legacy(id) ON DELETE CASCADE;


--
-- Name: property_status fk_property_status_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_status
    ADD CONSTRAINT fk_property_status_user FOREIGN KEY (user_id) REFERENCES public.profiles_legacy(id) ON DELETE CASCADE;


--
-- Name: sms_logs fk_sms_logs_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sms_logs
    ADD CONSTRAINT fk_sms_logs_user FOREIGN KEY (user_id) REFERENCES public.profiles_legacy(id) ON DELETE CASCADE;


--
-- Name: integration_requests integration_requests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_requests
    ADD CONSTRAINT integration_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: knowledge knowledge_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge
    ADD CONSTRAINT knowledge_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: lock_alert_config lock_alert_config_lock_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lock_alert_config
    ADD CONSTRAINT lock_alert_config_lock_id_fkey FOREIGN KEY (lock_id) REFERENCES public.locks(id) ON DELETE CASCADE;


--
-- Name: menage_assignment_log menage_assignment_log_menage_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menage_assignment_log
    ADD CONSTRAINT menage_assignment_log_menage_id_fkey FOREIGN KEY (menage_id) REFERENCES public.menages(id) ON DELETE CASCADE;


--
-- Name: menage_assignment_log menage_assignment_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menage_assignment_log
    ADD CONSTRAINT menage_assignment_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: menage_comments menage_comments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menage_comments
    ADD CONSTRAINT menage_comments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: menage_events menage_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menage_events
    ADD CONSTRAINT menage_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: menages menages_offered_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menages
    ADD CONSTRAINT menages_offered_to_fkey FOREIGN KEY (offered_to) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: menages menages_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menages
    ADD CONSTRAINT menages_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: menages menages_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.menages
    ADD CONSTRAINT menages_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: message_templates message_templates_lock_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_templates
    ADD CONSTRAINT message_templates_lock_id_fkey FOREIGN KEY (lock_id) REFERENCES public.locks(id);


--
-- Name: message_templates message_templates_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_templates
    ADD CONSTRAINT message_templates_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: onboarding_state onboarding_state_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onboarding_state
    ADD CONSTRAINT onboarding_state_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: ota_reviews ota_reviews_menage_event_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ota_reviews
    ADD CONSTRAINT ota_reviews_menage_event_fk FOREIGN KEY (menage_event_id) REFERENCES public.menage_events(id) ON DELETE SET NULL;


--
-- Name: ota_reviews ota_reviews_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ota_reviews
    ADD CONSTRAINT ota_reviews_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE CASCADE;


--
-- Name: ota_reviews ota_reviews_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ota_reviews
    ADD CONSTRAINT ota_reviews_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: prestataire_periodes prestataire_periodes_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prestataire_periodes
    ADD CONSTRAINT prestataire_periodes_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: prestataire_periodes prestataire_periodes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prestataire_periodes
    ADD CONSTRAINT prestataire_periodes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: price_display_log price_display_log_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_display_log
    ADD CONSTRAINT price_display_log_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE CASCADE;


--
-- Name: profile_permissions profile_permissions_account_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profile_permissions
    ADD CONSTRAINT profile_permissions_account_user_id_fkey FOREIGN KEY (account_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: profile_permissions profile_permissions_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profile_permissions
    ADD CONSTRAINT profile_permissions_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_account_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_account_user_id_fkey FOREIGN KEY (account_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: profiles_legacy profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles_legacy
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_member_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_member_user_id_fkey FOREIGN KEY (member_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: properties properties_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.properties
    ADD CONSTRAINT properties_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles_legacy(id) ON DELETE CASCADE;


--
-- Name: property_channel_rate_plans property_channel_rate_plans_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_channel_rate_plans
    ADD CONSTRAINT property_channel_rate_plans_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE CASCADE;


--
-- Name: property_cleaning_providers property_cleaning_providers_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_cleaning_providers
    ADD CONSTRAINT property_cleaning_providers_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: property_cleaning_providers property_cleaning_providers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_cleaning_providers
    ADD CONSTRAINT property_cleaning_providers_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: property_locks property_locks_lock_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.property_locks
    ADD CONSTRAINT property_locks_lock_id_fkey FOREIGN KEY (lock_id) REFERENCES public.locks(id) ON DELETE CASCADE;


--
-- Name: provider_availability_exceptions provider_availability_exceptions_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_availability_exceptions
    ADD CONSTRAINT provider_availability_exceptions_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: provider_availability_exceptions provider_availability_exceptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_availability_exceptions
    ADD CONSTRAINT provider_availability_exceptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: provider_availability_rules provider_availability_rules_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_availability_rules
    ADD CONSTRAINT provider_availability_rules_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: provider_availability_rules provider_availability_rules_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_availability_rules
    ADD CONSTRAINT provider_availability_rules_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: public_tokens public_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.public_tokens
    ADD CONSTRAINT public_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: yield_events yield_events_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.yield_events
    ADD CONSTRAINT yield_events_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE CASCADE;


--
-- Name: yield_events yield_events_reconduit_de_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.yield_events
    ADD CONSTRAINT yield_events_reconduit_de_fkey FOREIGN KEY (reconduit_de) REFERENCES public.yield_events(id) ON DELETE SET NULL;


--
-- Name: yield_exceptions yield_exceptions_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.yield_exceptions
    ADD CONSTRAINT yield_exceptions_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE CASCADE;


--
-- Name: yield_segment_reglages yield_segment_reglages_property_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.yield_segment_reglages
    ADD CONSTRAINT yield_segment_reglages_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE CASCADE;


--
-- Name: property_channel_rate_plans Users manage own property rate plans; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage own property rate plans" ON public.property_channel_rate_plans TO authenticated USING ((property_id IN ( SELECT properties.id
   FROM public.properties
  WHERE (properties.user_id = auth.uid())))) WITH CHECK ((property_id IN ( SELECT properties.id
   FROM public.properties
  WHERE (properties.user_id = auth.uid()))));


--
-- Name: access_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.access_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: access_codes access_codes_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY access_codes_select ON public.access_codes FOR SELECT TO authenticated USING (public.can_read(user_id, 'reservations'::text, property_id));


--
-- Name: access_codes access_codes_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY access_codes_write ON public.access_codes TO authenticated USING (public.can_write(user_id, 'reservations'::text, property_id)) WITH CHECK (public.can_write(user_id, 'reservations'::text, property_id));


--
-- Name: accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: accounts accounts_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY accounts_select ON public.accounts FOR SELECT TO authenticated USING (public.can_read(user_id, 'facturation'::text));


--
-- Name: accounts accounts_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY accounts_write ON public.accounts TO authenticated USING (public.can_write(user_id, 'facturation'::text)) WITH CHECK (public.can_write(user_id, 'facturation'::text));


--
-- Name: agent_alert_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_alert_config ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_alert_config agent_alert_config_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY agent_alert_config_select ON public.agent_alert_config FOR SELECT TO authenticated USING (public.can_read(user_id, 'reglages'::text));


--
-- Name: agent_alert_config agent_alert_config_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY agent_alert_config_write ON public.agent_alert_config TO authenticated USING (public.can_write(user_id, 'reglages'::text)) WITH CHECK (public.can_write(user_id, 'reglages'::text));


--
-- Name: agent_prompting; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_prompting ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_prompting agent_prompting_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY agent_prompting_select ON public.agent_prompting FOR SELECT TO authenticated USING (public.can_read(user_id, 'reglages'::text, property_id));


--
-- Name: agent_prompting agent_prompting_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY agent_prompting_write ON public.agent_prompting TO authenticated USING (public.can_write(user_id, 'reglages'::text, property_id)) WITH CHECK (public.can_write(user_id, 'reglages'::text, property_id));


--
-- Name: agent_tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_tasks agent_tasks_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY agent_tasks_select ON public.agent_tasks FOR SELECT TO authenticated USING (public.can_read(user_id, 'messages'::text, property_id));


--
-- Name: agent_tasks agent_tasks_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY agent_tasks_write ON public.agent_tasks TO authenticated USING (public.can_write(user_id, 'messages'::text, property_id)) WITH CHECK (public.can_write(user_id, 'messages'::text, property_id));


--
-- Name: airbnb_connect_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.airbnb_connect_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: airbnb_connect_sessions airbnb_connect_sessions_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY airbnb_connect_sessions_select ON public.airbnb_connect_sessions FOR SELECT TO authenticated USING (public.can_read(user_id, 'reglages'::text, property_id));


--
-- Name: airbnb_connect_sessions airbnb_connect_sessions_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY airbnb_connect_sessions_write ON public.airbnb_connect_sessions TO authenticated USING (public.can_write(user_id, 'reglages'::text, property_id)) WITH CHECK (public.can_write(user_id, 'reglages'::text, property_id));


--
-- Name: api_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: api_keys api_keys_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY api_keys_select ON public.api_keys FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: api_keys api_keys_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY api_keys_write ON public.api_keys TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: app_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: app_logs app_logs_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY app_logs_select ON public.app_logs FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: app_logs app_logs_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY app_logs_write ON public.app_logs TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: automation_incidents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.automation_incidents ENABLE ROW LEVEL SECURITY;

--
-- Name: automation_incidents automation_incidents_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY automation_incidents_select ON public.automation_incidents FOR SELECT TO authenticated USING (public.can_read(user_id, 'reglages'::text, property_id));


--
-- Name: automation_incidents automation_incidents_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY automation_incidents_write ON public.automation_incidents TO authenticated USING (public.can_write(user_id, 'reglages'::text, property_id)) WITH CHECK (public.can_write(user_id, 'reglages'::text, property_id));


--
-- Name: availability_push_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.availability_push_log ENABLE ROW LEVEL SECURITY;

--
-- Name: booking_attempts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.booking_attempts ENABLE ROW LEVEL SECURITY;

--
-- Name: booking_attempts booking_attempts_service_only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY booking_attempts_service_only ON public.booking_attempts TO authenticated USING (false) WITH CHECK (false);


--
-- Name: booking_change_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.booking_change_events ENABLE ROW LEVEL SECURITY;

--
-- Name: booking_change_events booking_change_events_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY booking_change_events_select ON public.booking_change_events FOR SELECT TO authenticated USING (public.can_read(user_id, 'reservations'::text, property_id));


--
-- Name: booking_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.booking_links ENABLE ROW LEVEL SECURITY;

--
-- Name: booking_links booking_links_service_only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY booking_links_service_only ON public.booking_links TO authenticated USING (false) WITH CHECK (false);


--
-- Name: bookings_snapshot; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bookings_snapshot ENABLE ROW LEVEL SECURITY;

--
-- Name: bookings_snapshot bookings_snapshot_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bookings_snapshot_select ON public.bookings_snapshot FOR SELECT TO authenticated USING (public.can_read(user_id, 'reservations'::text, property_id));


--
-- Name: bookings_snapshot bookings_snapshot_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bookings_snapshot_write ON public.bookings_snapshot TO authenticated USING (public.can_write(user_id, 'reservations'::text, property_id)) WITH CHECK (public.can_write(user_id, 'reservations'::text, property_id));


--
-- Name: calendar_inventory cal_inv_delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cal_inv_delete_own ON public.calendar_inventory FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.properties p
  WHERE ((p.id = calendar_inventory.property_id) AND (p.user_id = auth.uid())))));


--
-- Name: calendar_inventory cal_inv_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cal_inv_insert_own ON public.calendar_inventory FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.properties p
  WHERE ((p.id = calendar_inventory.property_id) AND (p.user_id = auth.uid())))));


--
-- Name: calendar_inventory cal_inv_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cal_inv_select_own ON public.calendar_inventory FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.properties p
  WHERE ((p.id = calendar_inventory.property_id) AND (p.user_id = auth.uid())))));


--
-- Name: calendar_inventory cal_inv_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cal_inv_update_own ON public.calendar_inventory FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.properties p
  WHERE ((p.id = calendar_inventory.property_id) AND (p.user_id = auth.uid())))));


--
-- Name: calendar_inventory; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.calendar_inventory ENABLE ROW LEVEL SECURITY;

--
-- Name: channel_sync_queue; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.channel_sync_queue ENABLE ROW LEVEL SECURITY;

--
-- Name: conges_plages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conges_plages ENABLE ROW LEVEL SECURITY;

--
-- Name: conges_plages conges_plages_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY conges_plages_select ON public.conges_plages FOR SELECT TO authenticated USING (public.can_read(user_id, 'prestataires'::text));


--
-- Name: conges_plages conges_plages_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY conges_plages_write ON public.conges_plages TO authenticated USING (public.can_write(user_id, 'prestataires'::text)) WITH CHECK (public.can_write(user_id, 'prestataires'::text));


--
-- Name: conversation_flags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversation_flags ENABLE ROW LEVEL SECURITY;

--
-- Name: conversation_flags conversation_flags_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY conversation_flags_select ON public.conversation_flags FOR SELECT TO authenticated USING (public.can_read(user_id, 'messages'::text));


--
-- Name: conversation_flags conversation_flags_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY conversation_flags_write ON public.conversation_flags TO authenticated USING (public.can_write(user_id, 'messages'::text)) WITH CHECK (public.can_write(user_id, 'messages'::text));


--
-- Name: conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

--
-- Name: conversations conversations_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY conversations_select ON public.conversations FOR SELECT TO authenticated USING (public.can_read(user_id, 'messages'::text, property_id));


--
-- Name: conversations conversations_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY conversations_write ON public.conversations TO authenticated USING (public.can_write(user_id, 'messages'::text, property_id)) WITH CHECK (public.can_write(user_id, 'messages'::text, property_id));


--
-- Name: cron_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cron_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: integration_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.integration_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: integration_requests integration_requests_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY integration_requests_select ON public.integration_requests FOR SELECT TO authenticated USING (public.can_read(user_id, 'reglages'::text));


--
-- Name: integration_requests integration_requests_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY integration_requests_write ON public.integration_requests TO authenticated USING (public.can_write(user_id, 'reglages'::text)) WITH CHECK (public.can_write(user_id, 'reglages'::text));


--
-- Name: kb_question_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.kb_question_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: kb_question_templates kb_templates_select_auth; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY kb_templates_select_auth ON public.kb_question_templates FOR SELECT TO authenticated USING (true);


--
-- Name: knowledge; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.knowledge ENABLE ROW LEVEL SECURITY;

--
-- Name: knowledge knowledge_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY knowledge_select ON public.knowledge FOR SELECT TO authenticated USING (public.can_read(user_id, 'reglages'::text, property_id));


--
-- Name: knowledge knowledge_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY knowledge_write ON public.knowledge TO authenticated USING (public.can_write(user_id, 'reglages'::text, property_id)) WITH CHECK (public.can_write(user_id, 'reglages'::text, property_id));


--
-- Name: lock_alert_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lock_alert_config ENABLE ROW LEVEL SECURITY;

--
-- Name: lock_alert_config lock_alert_config_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lock_alert_config_select ON public.lock_alert_config FOR SELECT TO authenticated USING (public.can_read(user_id, 'reglages'::text));


--
-- Name: lock_alert_config lock_alert_config_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lock_alert_config_write ON public.lock_alert_config TO authenticated USING (public.can_write(user_id, 'reglages'::text)) WITH CHECK (public.can_write(user_id, 'reglages'::text));


--
-- Name: locks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.locks ENABLE ROW LEVEL SECURITY;

--
-- Name: locks locks_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY locks_select ON public.locks FOR SELECT TO authenticated USING (public.can_read(user_id, 'reglages'::text));


--
-- Name: locks locks_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY locks_write ON public.locks TO authenticated USING (public.can_write(user_id, 'reglages'::text)) WITH CHECK (public.can_write(user_id, 'reglages'::text));


--
-- Name: menage_assignment_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.menage_assignment_log ENABLE ROW LEVEL SECURITY;

--
-- Name: menage_assignment_log menage_assignment_log_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY menage_assignment_log_select ON public.menage_assignment_log FOR SELECT TO authenticated USING (public.can_read(user_id, 'menages'::text));


--
-- Name: menage_comments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.menage_comments ENABLE ROW LEVEL SECURITY;

--
-- Name: menage_comments menage_comments_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY menage_comments_select ON public.menage_comments FOR SELECT TO authenticated USING (public.can_read(user_id, 'menages'::text, property_id));


--
-- Name: menage_comments menage_comments_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY menage_comments_write ON public.menage_comments TO authenticated USING (public.can_write(user_id, 'menages'::text, property_id)) WITH CHECK (public.can_write(user_id, 'menages'::text, property_id));


--
-- Name: menage_done; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.menage_done ENABLE ROW LEVEL SECURITY;

--
-- Name: menage_done menage_done_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY menage_done_select ON public.menage_done FOR SELECT TO authenticated USING (public.can_read(user_id, 'menages'::text, property_id));


--
-- Name: menage_done menage_done_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY menage_done_write ON public.menage_done TO authenticated USING (public.can_write(user_id, 'menages'::text, property_id)) WITH CHECK (public.can_write(user_id, 'menages'::text, property_id));


--
-- Name: menage_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.menage_events ENABLE ROW LEVEL SECURITY;

--
-- Name: menage_events menage_events_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY menage_events_select ON public.menage_events FOR SELECT TO authenticated USING (public.can_read(user_id, 'menages'::text, property_id));


--
-- Name: menage_events menage_events_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY menage_events_write ON public.menage_events TO authenticated USING (public.can_write(user_id, 'menages'::text, property_id)) WITH CHECK (public.can_write(user_id, 'menages'::text, property_id));


--
-- Name: menages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.menages ENABLE ROW LEVEL SECURITY;

--
-- Name: menages menages_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY menages_select ON public.menages FOR SELECT TO authenticated USING (public.can_read(user_id, 'menages'::text, property_id));


--
-- Name: menages menages_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY menages_write ON public.menages TO authenticated USING (public.can_write(user_id, 'prestataires'::text, property_id)) WITH CHECK (public.can_write(user_id, 'prestataires'::text, property_id));


--
-- Name: message_sent_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.message_sent_log ENABLE ROW LEVEL SECURITY;

--
-- Name: message_sent_log message_sent_log_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY message_sent_log_select ON public.message_sent_log FOR SELECT TO authenticated USING (public.can_read(user_id, 'messages'::text));


--
-- Name: message_sent_log message_sent_log_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY message_sent_log_write ON public.message_sent_log TO authenticated USING (public.can_write(user_id, 'messages'::text)) WITH CHECK (public.can_write(user_id, 'messages'::text));


--
-- Name: message_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.message_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: message_templates message_templates_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY message_templates_select ON public.message_templates FOR SELECT TO authenticated USING (public.can_read(user_id, 'messages'::text, property_id));


--
-- Name: message_templates message_templates_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY message_templates_write ON public.message_templates TO authenticated USING (public.can_write(user_id, 'messages'::text, property_id)) WITH CHECK (public.can_write(user_id, 'messages'::text, property_id));


--
-- Name: messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

--
-- Name: messages messages_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY messages_select ON public.messages FOR SELECT TO authenticated USING (public.can_read(user_id, 'messages'::text, property_id));


--
-- Name: messages messages_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY messages_write ON public.messages TO authenticated USING (public.can_write(user_id, 'messages'::text, property_id)) WITH CHECK (public.can_write(user_id, 'messages'::text, property_id));


--
-- Name: onboarding_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.onboarding_state ENABLE ROW LEVEL SECURITY;

--
-- Name: onboarding_state onboarding_state_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY onboarding_state_select ON public.onboarding_state FOR SELECT TO authenticated USING (public.can_read(user_id, 'reglages'::text));


--
-- Name: onboarding_state onboarding_state_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY onboarding_state_write ON public.onboarding_state TO authenticated USING (public.can_write(user_id, 'reglages'::text)) WITH CHECK (public.can_write(user_id, 'reglages'::text));


--
-- Name: ota_reviews; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ota_reviews ENABLE ROW LEVEL SECURITY;

--
-- Name: ota_reviews ota_reviews_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ota_reviews_select ON public.ota_reviews FOR SELECT TO authenticated USING (public.can_read(user_id, 'avis'::text, property_id_ref));


--
-- Name: ota_reviews ota_reviews_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ota_reviews_write ON public.ota_reviews TO authenticated USING (public.can_write(user_id, 'avis'::text, property_id_ref)) WITH CHECK (public.can_write(user_id, 'avis'::text, property_id_ref));


--
-- Name: property_cleaning_providers pcp_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pcp_select ON public.property_cleaning_providers FOR SELECT TO authenticated USING (public.can_read(user_id, 'prestataires'::text, property_id));


--
-- Name: property_cleaning_providers pcp_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pcp_write ON public.property_cleaning_providers TO authenticated USING (public.can_write(user_id, 'prestataires'::text, property_id)) WITH CHECK (public.can_write(user_id, 'prestataires'::text, property_id));


--
-- Name: prestataire_periodes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.prestataire_periodes ENABLE ROW LEVEL SECURITY;

--
-- Name: prestataire_periodes prestataire_periodes_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY prestataire_periodes_select ON public.prestataire_periodes FOR SELECT TO authenticated USING (public.can_read(user_id, 'prestataires'::text, property_id_ref));


--
-- Name: prestataire_periodes prestataire_periodes_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY prestataire_periodes_write ON public.prestataire_periodes TO authenticated USING (public.can_write(user_id, 'prestataires'::text, property_id_ref)) WITH CHECK (public.can_write(user_id, 'prestataires'::text, property_id_ref));


--
-- Name: price_display_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.price_display_log ENABLE ROW LEVEL SECURITY;

--
-- Name: price_display_log price_display_log_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY price_display_log_select ON public.price_display_log FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: profile_permissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profile_permissions ENABLE ROW LEVEL SECURITY;

--
-- Name: profile_permissions profile_permissions_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profile_permissions_select ON public.profile_permissions FOR SELECT TO authenticated USING (((account_user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.profiles pr
  WHERE ((pr.id = profile_permissions.profile_id) AND (pr.member_user_id = auth.uid()))))));


--
-- Name: profile_permissions profile_permissions_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profile_permissions_write ON public.profile_permissions TO authenticated USING (((account_user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.profiles pr
  WHERE ((pr.id = profile_permissions.profile_id) AND (pr.account_user_id = auth.uid())))))) WITH CHECK (((account_user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.profiles pr
  WHERE ((pr.id = profile_permissions.profile_id) AND (pr.account_user_id = auth.uid()))))));


--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles_legacy; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles_legacy ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles profiles_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated USING (((account_user_id = auth.uid()) OR (member_user_id = auth.uid())));


--
-- Name: profiles profiles_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_write ON public.profiles TO authenticated USING ((account_user_id = auth.uid())) WITH CHECK ((account_user_id = auth.uid()));


--
-- Name: properties; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.properties ENABLE ROW LEVEL SECURITY;

--
-- Name: properties properties_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY properties_select ON public.properties FOR SELECT TO authenticated USING (public.in_scope(user_id, id));


--
-- Name: properties properties_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY properties_write ON public.properties TO authenticated USING (public.can_write(user_id, 'reglages'::text, id)) WITH CHECK (public.can_write(user_id, 'reglages'::text, id));


--
-- Name: property_channel_rate_plans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.property_channel_rate_plans ENABLE ROW LEVEL SECURITY;

--
-- Name: property_cleaning_providers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.property_cleaning_providers ENABLE ROW LEVEL SECURITY;

--
-- Name: property_locks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.property_locks ENABLE ROW LEVEL SECURITY;

--
-- Name: property_locks property_locks_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY property_locks_select ON public.property_locks FOR SELECT TO authenticated USING (public.can_read(user_id, 'reglages'::text, property_id));


--
-- Name: property_locks property_locks_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY property_locks_write ON public.property_locks TO authenticated USING (public.can_write(user_id, 'reglages'::text, property_id)) WITH CHECK (public.can_write(user_id, 'reglages'::text, property_id));


--
-- Name: property_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.property_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: property_snapshots property_snapshots_service_only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY property_snapshots_service_only ON public.property_snapshots TO authenticated USING (false) WITH CHECK (false);


--
-- Name: property_status; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.property_status ENABLE ROW LEVEL SECURITY;

--
-- Name: property_status property_status_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY property_status_select ON public.property_status FOR SELECT TO authenticated USING (public.can_read(user_id, 'menages'::text, property_id));


--
-- Name: property_status property_status_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY property_status_write ON public.property_status TO authenticated USING (public.can_write(user_id, 'menages'::text, property_id)) WITH CHECK (public.can_write(user_id, 'menages'::text, property_id));


--
-- Name: provider_availability_exceptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.provider_availability_exceptions ENABLE ROW LEVEL SECURITY;

--
-- Name: provider_availability_exceptions provider_availability_exceptions_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY provider_availability_exceptions_select ON public.provider_availability_exceptions FOR SELECT TO authenticated USING (public.can_read(user_id, 'prestataires'::text));


--
-- Name: provider_availability_exceptions provider_availability_exceptions_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY provider_availability_exceptions_write ON public.provider_availability_exceptions TO authenticated USING (public.can_write(user_id, 'prestataires'::text)) WITH CHECK (public.can_write(user_id, 'prestataires'::text));


--
-- Name: provider_availability_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.provider_availability_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: provider_availability_rules provider_availability_rules_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY provider_availability_rules_select ON public.provider_availability_rules FOR SELECT TO authenticated USING (public.can_read(user_id, 'prestataires'::text));


--
-- Name: provider_availability_rules provider_availability_rules_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY provider_availability_rules_write ON public.provider_availability_rules TO authenticated USING (public.can_write(user_id, 'prestataires'::text)) WITH CHECK (public.can_write(user_id, 'prestataires'::text));


--
-- Name: provider_keys_migrated; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.provider_keys_migrated ENABLE ROW LEVEL SECURITY;

--
-- Name: public_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.public_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: public_tokens public_tokens_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_tokens_select ON public.public_tokens FOR SELECT TO authenticated USING (public.can_read(user_id, 'prestataires'::text));


--
-- Name: public_tokens public_tokens_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_tokens_write ON public.public_tokens TO authenticated USING (public.can_write(user_id, 'prestataires'::text)) WITH CHECK (public.can_write(user_id, 'prestataires'::text));


--
-- Name: rekeying_backup; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rekeying_backup ENABLE ROW LEVEL SECURITY;

--
-- Name: school_holidays; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.school_holidays ENABLE ROW LEVEL SECURITY;

--
-- Name: school_holidays school_holidays_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY school_holidays_select ON public.school_holidays FOR SELECT TO authenticated USING (true);


--
-- Name: sms_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sms_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: sms_logs sms_logs_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sms_logs_select ON public.sms_logs FOR SELECT TO authenticated USING (public.can_read(user_id, 'messages'::text, property_id));


--
-- Name: sms_logs sms_logs_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sms_logs_write ON public.sms_logs TO authenticated USING (public.can_write(user_id, 'messages'::text, property_id)) WITH CHECK (public.can_write(user_id, 'messages'::text, property_id));


--
-- Name: stripe_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stripe_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: stripe_accounts stripe_accounts_service_only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY stripe_accounts_service_only ON public.stripe_accounts TO authenticated USING (false) WITH CHECK (false);


--
-- Name: subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: subscriptions subscriptions_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY subscriptions_select ON public.subscriptions FOR SELECT TO authenticated USING (public.can_read(user_id, 'facturation'::text));


--
-- Name: subscriptions subscriptions_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY subscriptions_write ON public.subscriptions TO authenticated USING (public.can_write(user_id, 'facturation'::text)) WITH CHECK (public.can_write(user_id, 'facturation'::text));


--
-- Name: profiles_legacy users_own_profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY users_own_profile ON public.profiles_legacy USING ((auth.uid() = id));


--
-- Name: write_locks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.write_locks ENABLE ROW LEVEL SECURITY;

--
-- Name: write_locks write_locks_service_only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY write_locks_service_only ON public.write_locks TO authenticated USING (false) WITH CHECK (false);


--
-- Name: yield_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.yield_events ENABLE ROW LEVEL SECURITY;

--
-- Name: yield_events yield_events_lecture; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY yield_events_lecture ON public.yield_events FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: yield_exceptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.yield_exceptions ENABLE ROW LEVEL SECURITY;

--
-- Name: yield_exceptions yield_exceptions_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY yield_exceptions_select ON public.yield_exceptions FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: yield_segment_reglages yield_reglages_lecture; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY yield_reglages_lecture ON public.yield_segment_reglages FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: yield_segment_reglages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.yield_segment_reglages ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

-- \unrestrict retire (voir en-tete).

