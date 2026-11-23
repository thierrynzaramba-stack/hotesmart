-- Revenus nets : un BLOCAGE n'est pas un sejour
-- (27 octobre 2026, decision de Thierry apres mesure).
-- Lignes < 60 car. : collage manuel.
--
-- ⚠ MESURE EN PRODUCTION, 1 564 lignes, lecture seule :
-- 74 sejours CONFIRMES n'ont aucun prix voyageur. Sur
-- ces 74, SOIXANTE-SIX portent deux indices ensemble —
-- aucun nom de voyageur, et `price` a ZERO (pas nul :
-- zero). Beds24 envoie ses blocages comme des
-- reservations confirmees a prix nul.
--
-- Les afficher « non calculable » etait exact et
-- inutile : ce ne sont pas des sejours. L'ecran disait
-- « 74 sejours dont le montant n'est pas calculable »
-- la ou la reponse juste est 8.
--
-- ⚠ ET ON NE TOUCHE PAS `statut_canonique` (decision
-- explicite de Thierry). Requalifier une ligne
-- `confirmed` en `blocked` sur une HEURISTIQUE
-- changerait un comportement qui n'a rien a voir avec
-- les revenus : ce statut gouverne aussi le menage.
-- Une colonne a cote, lue par les seuls agregats de
-- revenus, ne peut rien casser ailleurs.
--
-- ⚠ LES DEUX INDICES SONT CUMULES, JAMAIS SEULS. Un
-- vrai sejour OFFERT existe (geste commercial), et un
-- vrai sejour peut arriver sans nom transmis. Les deux
-- ensemble, sur 66 lignes, ne laissent guere de doute —
-- et les 8 restants s'affichent « non calculable »,
-- ce qui est juste.


-- ─── 1. LA COLONNE ─────────────────────────────────

alter table public.bookings_snapshot
  add column if not exists est_blocage boolean;

comment on column
  public.bookings_snapshot.est_blocage is
'VRAI quand la ligne est un blocage et non un sejour :
aucun nom de voyageur ET price a zero. Posee par le
writer unique (lib/revenus/derive.js), jamais a la
main. Les agregats de revenus l''excluent du total, du
compte des sejours ET des reserves.
⚠ Elle ne reclasse PAS statut_canonique : ce statut
gouverne le menage, et une heuristique n''a pas a le
toucher.
⚠ Et elle ne vaut aujourd''hui que pour Beds24, qui
seul sert un champ `price` : mesure du 27 octobre 2026,
les 66 lignes concernees en viennent toutes. Channex
n''envoie pas ses blocages ainsi.';


-- ─── 2. L'INDEX SE RECREE, IL NE SE COMPLETE PAS ───
--
-- ⚠ `create index if not exists` SUR UN INDEX QUI
-- EXISTE DEJA REUSSIT EN SILENCE, sans changer sa
-- definition. C'est le meme piege que
-- `create table if not exists` — celui qui a laisse
-- deux CHECK non poses en septembre, et qui a demande
-- une seconde migration de durcissement. On supprime
-- donc avant de recreer.
--
-- L'index ne porte plus que les lignes que l'agregat
-- lit vraiment : confirmees ET pas des blocages.

drop index if exists
  public.bookings_snapshot_revenus_idx;

create index bookings_snapshot_revenus_idx
  on public.bookings_snapshot
     (user_id, date_versement, property_uuid)
  where statut_canonique = 'confirmed'
    and est_blocage is not true;


-- ─── 3. LES DEUX AGREGATS EXCLUENT LES BLOCAGES ────
--
-- ⚠ `is not true` ET NON `= false` : la colonne vaut
-- NULL sur toute ligne derivee avant cette migration,
-- et `null = false` rend NULL, donc la ligne sortirait
-- de l'agregat. Un seul operateur mal choisi ferait
-- disparaitre TOUS les revenus anterieurs — un total a
-- zero sur un mois vendu.

create or replace function public.revenus_du_mois(
  p_user_id uuid,
  p_mois text,
  p_aujourdhui date,
  p_refs uuid[] default null
)
returns table (
  property_uuid uuid,
  sejours bigint,
  recu_cents bigint,
  a_venir_cents bigint,
  total_cents bigint,
  bruts bigint,
  sans_montant bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    b.property_uuid,
    count(*) as sejours,
    coalesce(sum(case
      when b.date_versement <= p_aujourdhui
      then b.montant_net_cents else 0 end), 0),
    coalesce(sum(case
      when b.date_versement > p_aujourdhui
      then b.montant_net_cents else 0 end), 0),
    coalesce(sum(b.montant_net_cents), 0),
    count(*) filter
      (where b.montant_est_brut is true),
    count(*) filter
      (where b.montant_net_cents is null)
  from public.bookings_snapshot b
  where b.user_id = p_user_id
    and b.statut_canonique = 'confirmed'
    and b.est_blocage is not true
    and b.date_versement is not null
    and b.date_versement
        >= (p_mois || '-01')::date
    and b.date_versement
        < ((p_mois || '-01')::date
           + interval '1 month')
    and (p_refs is null
         or b.property_uuid = any(p_refs))
  group by b.property_uuid
$$;

create or replace function public.revenus_hors_mois(
  p_user_id uuid,
  p_refs uuid[] default null
)
returns table (
  sans_date bigint,
  hors_biens bigint,
  hors_biens_cents bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*) filter
      (where b.date_versement is null
         and (p_refs is null
              or b.property_uuid = any(p_refs))),
    count(*) filter
      (where p_refs is null
         and b.property_uuid is null),
    coalesce(sum(case when p_refs is null
      and b.property_uuid is null
      then b.montant_net_cents else 0 end), 0)
  from public.bookings_snapshot b
  where b.user_id = p_user_id
    and b.statut_canonique = 'confirmed'
    and b.est_blocage is not true
    and (p_refs is null
         or b.property_uuid = any(p_refs)
         or b.property_uuid is null)
$$;

-- ⚠ FAUT-IL REPOSER LES DROITS APRES UN
-- `create or replace` ? D'apres la documentation
-- PostgreSQL, non : `create or replace function`
-- CONSERVE les privileges de la fonction existante,
-- contrairement a un `drop` suivi d'un `create`.
--
-- ⚠ MAIS JE NE L'AI PAS MESURE, et je refuse de l'ecrire
-- comme si je l'avais fait : aucune base Postgres locale,
-- et l'API ne prend pas de SQL. C'est pour ca que la
-- requete de controle ci-dessous reverifie les droits.
-- Si elle dit « DANGER : public peut EXECUTE », il faut
-- rejouer les `revoke`/`grant` de la migration des
-- revenus derives — et me le dire, parce que ce serait
-- ma supposition qui aurait eu tort.
-- Une regle de securite qu'on croit acquise est celle
-- qu'on ne regarde plus.


-- ╶╶╶ PREUVE, A COLLER JUSTE APRES ╶╶╶
--
-- ATTENDU — CINQ LIGNES, ET CINQ EXACTEMENT :
--   colonne  est_blocage        -> boolean
--   index    ..._revenus_idx    -> exclut les blocages
--   fonction revenus_du_mois    -> exclut les blocages
--   fonction revenus_hors_mois  -> exclut les blocages
--   droit    les deux fonctions -> public ne peut pas
--
-- Une ligne « NE LES EXCLUT PAS » veut dire que le
-- `create or replace` n'a pas pris : ne pas poursuivre.

select 'colonne'::text as objet,
       'est_blocage'::text as nom,
       data_type::text as detail
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'bookings_snapshot'
   and column_name = 'est_blocage'
union all
select 'index',
       indexname::text,
       case when indexdef like '%est_blocage%'
            then 'exclut les blocages'
            else 'NE LES EXCLUT PAS' end
  from pg_indexes
 where schemaname = 'public'
   and indexname = 'bookings_snapshot_revenus_idx'
union all
select 'fonction',
       p.proname::text,
       case when pg_get_functiondef(p.oid)
                 like '%est_blocage is not true%'
            then 'exclut les blocages'
            else 'NE LES EXCLUT PAS' end
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('revenus_du_mois',
       'revenus_hors_mois')
union all
select 'droit',
       'les deux fonctions'::text,
       case when bool_or(has_function_privilege(
              'public', p.oid, 'EXECUTE'))
            then 'DANGER : public peut EXECUTE'
            else 'ok : public ne peut pas' end
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('revenus_du_mois',
       'revenus_hors_mois')
 order by 1, 2;
