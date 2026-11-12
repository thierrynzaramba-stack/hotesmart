-- migrations/2026-11-11-avis-traductions.sql
-- Les traductions des avis voyageurs (spec avis-v5
-- spec-traduction-avis.md). Writer unique :
-- lib/avis/traduction.js. Lignes < 60 caracteres :
-- cette migration se colle a la main dans l'editeur.
--
-- Une ligne par avis. `textes` porte, par champ
-- (public, prive, extrait), la langue source detectee
-- et les versions fr/en/es autres que la source.
-- `empreinte` est celle des trois textes traduits :
-- un texte qui change rend la traduction perimee.
-- Un echec garde la derniere traduction reussie et
-- note seulement l'heure et l'empreinte de l'essai.

create table if not exists public.avis_traductions (
  review_id uuid primary key
    references public.ota_reviews (id)
    on delete cascade,
  user_id uuid not null,
  empreinte text,
  textes jsonb,
  traduit_le timestamptz,
  echec_le timestamptz,
  echec_empreinte text,
  echecs integer not null default 0,
  constraint traduction_complete check (
    (empreinte is null
      and textes is null
      and traduit_le is null)
    or
    (empreinte is not null
      and textes is not null
      and traduit_le is not null)),
  constraint traduction_echec check (
    (echec_le is null) = (echec_empreinte is null)),
  constraint traduction_echecs check (echecs >= 0)
);

alter table public.avis_traductions
  enable row level security;

revoke all on table public.avis_traductions
  from public, anon, authenticated;

comment on table public.avis_traductions is
  'Traductions fr/en/es des avis voyageurs, ecrites '
  'par lib/avis/traduction.js (writer unique). Les '
  'ecrans les lisent, jamais ne traduisent.';

-- L'empreinte des trois textes. La MEME regle que
-- empreinteAvis() dans lib/avis/traduction.js :
-- public = content_public, sinon content (comme
-- l'ecran) ; separateur chr(31). Un test compare.
create or replace function public.avis_empreinte(
  p_public text,
  p_prive text,
  p_extrait text
)
returns text
language sql
immutable
as $$
  select md5(
    coalesce(p_public, '')
    || chr(31) || coalesce(p_prive, '')
    || chr(31) || coalesce(p_extrait, ''));
$$;

-- La file : les avis a traduire, les plus recents
-- d'abord. Un avis masque par Airbnb (meme regle que
-- estMasque, lib/avis/cartes.js) n'a rien a montrer
-- donc rien a traduire. On attend la classification
-- (l'extrait est traduit dans le meme appel), sauf
-- au-dela de p_classe_avant. Un echec sur la meme
-- empreinte attend p_echec_avant avant de repasser,
-- et sort de la file apres p_echecs_max essais (un
-- texte qui change y revient). p_longueur_max ecarte
-- les avis trop longs pour un passage de cron : le
-- script les traduit. Null = pas de borne.
create or replace function public.avis_a_traduire(
  p_limite integer,
  p_classe_avant timestamptz,
  p_echec_avant timestamptz,
  p_longueur_max integer,
  p_echecs_max integer
)
returns table (
  id uuid,
  user_id uuid,
  property_id_ref text,
  booking_uid text,
  texte_public text,
  texte_prive text,
  texte_extrait text,
  empreinte text,
  echecs integer
)
language sql
stable
security invoker
as $$
  with a as (
    select r.id,
           r.user_id,
           r.property_id_ref,
           r.booking_uid,
           coalesce(nullif(r.content_public, ''),
                    nullif(r.content, ''))
             as texte_public,
           r.content_private as texte_prive,
           r.ai_clean_excerpt as texte_extrait,
           r.received_at
      from public.ota_reviews r
     where r.statut <> 'ignore'
       and not (
             r.provider = 'channex'
             and lower(r.ota) = 'airbnb'
             and (r.raw #> '{attributes,is_hidden}')
               is distinct from 'false'::jsonb)
       and (r.ai_analyzed_at is not null
            or r.verdict_source = 'humain'
            or r.received_at is null
            or r.received_at < p_classe_avant)
  ),
  e as (
    select a.*,
           public.avis_empreinte(a.texte_public,
             a.texte_prive, a.texte_extrait)
             as empreinte
      from a
     where (coalesce(a.texte_public, '') ~ '\S'
            or coalesce(a.texte_prive, '') ~ '\S')
       and (p_longueur_max is null
            or length(coalesce(a.texte_public, ''))
               + length(coalesce(a.texte_prive, ''))
               + length(coalesce(a.texte_extrait, ''))
               <= p_longueur_max)
  )
  select e.id, e.user_id, e.property_id_ref,
         e.booking_uid, e.texte_public,
         e.texte_prive, e.texte_extrait,
         e.empreinte, coalesce(t.echecs, 0)
    from e
    left join public.avis_traductions t
      on t.review_id = e.id
   where (t.empreinte is distinct from e.empreinte)
     and not coalesce(
           t.echec_empreinte = e.empreinte
           and (t.echec_le >= p_echec_avant
                or t.echecs >= p_echecs_max),
           false)
   order by e.received_at desc nulls last, e.id
   limit greatest(0, least(coalesce(p_limite, 0),
                           1000));
$$;

revoke execute on function
  public.avis_empreinte(text, text, text)
  from public, anon, authenticated;
grant execute on function
  public.avis_empreinte(text, text, text)
  to service_role;

revoke execute on function
  public.avis_a_traduire(integer, timestamptz,
    timestamptz, integer, integer)
  from public, anon, authenticated;
grant execute on function
  public.avis_a_traduire(integer, timestamptz,
    timestamptz, integer, integer)
  to service_role;
