-- Le cout du cron, passage par passage
-- (22 octobre 2026) — lot de mesure avant decoupage.
-- Lignes < 60 car. : collage manuel dans l'editeur.
--
-- POURQUOI. Le cycle de 5 minutes depasse
-- regulierement les 60 s de `maxDuration`, et ce qui
-- saute alors est ce qui vient en dernier. On sait
-- quelles taches sont LENTES (le chrono les loge depuis
-- des semaines), on ne sait pas lesquelles sont
-- COUTEUSES : combien de requetes a la base, combien
-- d'appels aux partenaires, pour combien de travail
-- reellement fait. Decouper le cron sans ces chiffres,
-- c'est deplacer le probleme au hasard.
--
-- UNE LIGNE PAR PASSAGE, PAS UNE PAR TACHE. Le detail
-- par tache vit dans `taches` (JSON) : une ligne par
-- tache ferait 288 x 25 = 7200 lignes par jour pour une
-- lecture qui est toujours un agregat. Le JSON est
-- PLAFONNE a 40 taches par passage cote code, le reste
-- agrege (lib/metriques-cron.js).
--
-- `commence_le` EST LA DATE DU PASSAGE, pas celle de
-- l'ecriture. Un cycle de 55 s ecrit sa ligne 55 s
-- apres son debut : classer sur l'ecriture decalerait
-- chaque passage d'une minute, et les comptes par jour
-- seraient faux au changement de jour.
--
-- RLS ACTIVEE, AUCUNE POLICY. Cette table n'a pas de
-- proprietaire : elle ne porte la donnee de personne,
-- seulement le cout de la plateforme. Seule la cle
-- service ecrit et lit (elle contourne la RLS) ; la cle
-- publique ne lit RIEN, et c'est voulu.

create table if not exists public.cron_stats (
  id uuid primary key
    default gen_random_uuid(),
  cron text not null,
  commence_le timestamptz not null,
  termine_le timestamptz not null default now(),
  duree_ms integer not null default 0,
  requetes integer not null default 0,
  appels_externes integer not null default 0,
  taches jsonb not null default '[]'::jsonb,
  totaux jsonb,
  cree_le timestamptz not null default now()
);

-- Le classement lit par (cron, date) ; la purge lit par
-- date seule.
create index if not exists cron_stats_cron_date_idx
  on public.cron_stats (cron, commence_le desc);
create index if not exists cron_stats_date_idx
  on public.cron_stats (commence_le);

alter table public.cron_stats
  enable row level security;

-- ─────────────────────────────────────────────────────
-- L'AGREGATION SE FAIT DANS LA BASE, ET C'EST UNE
-- NECESSITE. Sept jours font plus de 3000 passages :
-- au-dela de la troncature SILENCIEUSE de Supabase a
-- 1000 lignes, et plusieurs megaoctets de JSON pour
-- n'afficher que dix lignes.
--
-- SECURITY INVOKER (le defaut, ecrit ici pour qu'on ne
-- le change pas par distraction) : la fonction tourne
-- avec les droits de l'appelant, donc la RLS de la
-- table continue de mordre. En SECURITY DEFINER, cette
-- fonction ouvrirait a la cle publique ce que la RLS
-- vient de fermer.
-- ─────────────────────────────────────────────────────

create or replace function
  public.cron_stats_classement(
    depuis timestamptz,
    quel_cron text default null
  )
returns table (
  cron text,
  tache text,
  passages bigint,
  appels bigint,
  ms bigint,
  requetes bigint,
  externes bigint,
  travail bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    s.cron,
    t->>'nom' as tache,
    count(*) as passages,
    sum(coalesce((t->>'n')::bigint, 1)) as appels,
    sum(coalesce((t->>'ms_seul')::bigint, 0)) as ms,
    sum(coalesce((t->>'req')::bigint, 0))
      as requetes,
    sum(coalesce((t->>'ext_total')::bigint, 0))
      as externes,
    sum(coalesce((t->>'travail_total')::bigint, 0))
      as travail
  from public.cron_stats s
  -- ⚠ UNE SEULE LIGNE MALFORMEE NE DOIT PAS TUER
  -- TOUT LE CLASSEMENT. `jsonb_array_elements`
  -- leve sur autre chose qu'un tableau, et l'erreur
  -- porterait sur la requete entiere : la page
  -- dirait « classement illisible » pour 3000 lignes
  -- saines a cause d'une seule.
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(s.taches) = 'array'
      then s.taches else '[]'::jsonb end) as t
  where s.commence_le >= depuis
    and (quel_cron is null or s.cron = quel_cron)
  group by 1, 2
$$;

create or replace function
  public.cron_stats_par_jour(depuis timestamptz)
returns table (
  jour date,
  cron text,
  passages bigint,
  ms bigint,
  requetes bigint,
  externes bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    (s.commence_le
      at time zone 'Europe/Paris')::date as jour,
    s.cron,
    count(*) as passages,
    sum(s.duree_ms)::bigint as ms,
    sum(s.requetes)::bigint as requetes,
    sum(s.appels_externes)::bigint as externes
  from public.cron_stats s
  where s.commence_le >= depuis
  group by 1, 2
$$;

-- ⚠ ET LES FONCTIONS SE FERMENT AUSSI. Sans ces deux
-- lignes, tout role recoit EXECUTE par defaut : la RLS
-- suffirait a ne rien rendre, mais une garde qui tient
-- par une seule raison n'est pas une garde. Le cout de
-- la plateforme n'est pas une donnee de client.
revoke execute on function
  public.cron_stats_classement(timestamptz, text)
  from public;
revoke execute on function
  public.cron_stats_par_jour(timestamptz)
  from public;
grant execute on function
  public.cron_stats_classement(timestamptz, text)
  to service_role;
grant execute on function
  public.cron_stats_par_jour(timestamptz)
  to service_role;

comment on table public.cron_stats is
  'Cout d un passage de cron : duree, requetes, '
  'appels externes, travail fait, detail par tache. '
  'Purge a 30 jours par lib/cron-stats.js.';
