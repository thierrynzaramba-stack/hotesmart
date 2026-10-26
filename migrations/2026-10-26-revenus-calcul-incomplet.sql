-- ⚠⚠ ELLE S'APPLIQUE APRES LES DEUX MIGRATIONS
-- `2026-10-27-revenus-derives.sql` ET
-- `2026-10-27-est-blocage.sql`, MALGRE SON NOM.
--
-- Son nom porte le 26 octobre parce que c'est le jour
-- ou elle est ecrite ; les deux autres portent le 27,
-- qui est une date FUTURE — une erreur de nommage
-- faite avant, et qu'on ne corrige pas ici puisque
-- ces deux migrations sont DEJA COLLEES sous ce nom.
--
-- L'ordre ne se lit donc pas dans le repertoire. Il
-- est donne explicitement, et il est contraint :
--   1. 2026-10-25-delais-versement.sql
--   2. 2026-10-26-delais-versement-durcissement.sql
--   3. 2026-10-27-revenus-derives.sql
--   4. 2026-10-27-est-blocage.sql
--   5. 2026-10-26-revenus-calcul-incomplet.sql
--   6. 2026-10-26-revenus-hors-biens.sql  <- remplace
--      une fonction creee en 3 et modifiee en 4
--
-- Revenus nets : l'ecran doit savoir que le calcul
-- n'est PAS FINI (26 octobre 2026, constat GRAVE 1
-- de la review du lot Revenus).
-- Lignes < 60 car. : collage manuel.
--
-- ⚠ LE DEFAUT, ET IL SE PRODUIT AU COLLAGE MEME DE
-- LA MIGRATION PRECEDENTE. Les deux agregats filtrent
-- sur `statut_canonique = 'confirmed'`. Cette colonne
-- est NEUVE : elle vaut NULL sur les 1 436 lignes
-- existantes jusqu'a ce que le remplissage passe. Or
-- `NULL = 'confirmed'` rend NULL, donc la ligne sort
-- des DEUX agregats — y compris de `sans_date`.
--
-- Consequence mesuree sur le deroule de deploiement
-- prevu (migration collee a la main, remplissage
-- ensuite) : `revenus_du_mois` rend ZERO ligne, et
-- l'ecran affiche « 0,00 € · Recu 0,00 € · A venir
-- 0,00 € » AVEC L'APLOMB D'UN FAIT. Aucune reserve,
-- aucun « non calculable ». Un mois vendu devient
-- indistinguable d'un mois vide.
--
-- Et c'est PIRE en remplissage partiel : le script
-- s'arrete a sa limite, le cron de 04:00 plafonne a
-- 2 000 lignes par nuit — le total est alors
-- plausible mais AMPUTE, et rien ne le dit.
--
-- ⚠ C'EST LA REGLE DU DEPOT, MOT POUR MOT : un `null`
-- s'affiche « non calculable » avec son motif, jamais
-- 0 (docs/kb/restitution-yield.md). Un resume qui
-- ecrit 0 la ou le calcul n'a pas eu lieu transforme
-- une absence en fait.


-- ─── LA SONDE ──────────────────────────────────────
--
-- ⚠ ELLE NE DIT PAS « COMBIEN D'ARGENT », elle dit
-- « ai-je fini de compter ». C'est pour ca qu'elle ne
-- filtre NI sur le statut, NI sur les blocages : une
-- ligne non derivee n'a pas encore de statut, et
-- c'est precisement ce qu'on cherche a savoir.
--
-- ⚠ ET ELLE SE LIT AVEC LES DEUX AUTRES, EN PARALLELE.
-- Trois appels partis ensemble coutent la latence d'un
-- seul. Elargir `revenus_hors_mois` aurait evite un
-- appel au prix d'un WHERE a deux branches dont chaque
-- agregat aurait du se reproteger — sur une fonction
-- qui porte deja le cloisonnement du membre delegue.

create or replace function
  public.revenus_calcul_incomplet(
    p_user_id uuid,
    p_refs uuid[] default null
)
returns table (
  incomplet boolean,
  non_derives bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    -- ⚠ UN BOOLEEN POUR TOUT LE MONDE, parce qu'un
    -- membre delegue doit savoir que le chiffre n'est
    -- pas fiable sans apprendre le volume du compte.
    --
    -- ⚠ ET IL EST VRAI MEME SI LES LIGNES NON DERIVEES
    -- NE SONT PAS LES SIENNES — faux positif ASSUME,
    -- et il est inevitable : une ligne non derivee n'a
    -- pas encore de `property_uuid`, donc il est
    -- IMPOSSIBLE de savoir a quel bien elle appartient.
    -- Le membre lira « calcul en cours » un instant de
    -- trop ; l'inverse serait de lui montrer 0 € comme
    -- un fait.
    count(*) filter
      (where b.derive_le is null) > 0,
    -- Le NOMBRE, pour le titulaire seul : c'est un
    -- volume du compte, il ne descend pas a un membre.
    case when p_refs is null
      then count(*) filter
             (where b.derive_le is null)
      else 0 end
  from public.bookings_snapshot b
  where b.user_id = p_user_id
$$;

-- ⚠ LES DROITS, ET `public` N'EST PAS `anon`.
-- PostgreSQL accorde EXECUTE a PUBLIC par defaut sur
-- toute fonction neuve, et `anon` herite de PUBLIC :
-- un `revoke from anon` seul serait INOPERANT (constat
-- de Thierry sur la premiere migration du lot).
revoke all on function
  public.revenus_calcul_incomplet(uuid, uuid[])
  from public;

grant execute on function
  public.revenus_calcul_incomplet(uuid, uuid[])
  to service_role;


-- ╶╶╶ PREUVE, A COLLER JUSTE APRES ╶╶╶
--
-- ATTENDU — DEUX LIGNES, ET DEUX EXACTEMENT :
--   fonction revenus_calcul_incomplet -> existe
--   droit    revenus_calcul_incomplet -> public ne
--            peut pas
--
-- Si la premiere dit « ABSENTE », le `create` n'a pas
-- pris : ne pas poursuivre.

select 'fonction'::text as objet,
       p.proname::text as nom,
       'existe'::text as detail
  from pg_proc p
  join pg_namespace n
    on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname = 'revenus_calcul_incomplet'
union all
select 'droit',
       'revenus_calcul_incomplet',
       case when bool_or(has_function_privilege(
              'public', p.oid, 'EXECUTE'))
            then 'DANGER : public peut EXECUTE'
            else 'ok : public ne peut pas' end
  from pg_proc p
  join pg_namespace n
    on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname = 'revenus_calcul_incomplet'
 order by 1, 2;
