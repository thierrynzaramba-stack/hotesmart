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
--   5. 2026-10-26-revenus-hors-biens.sql  <- remplace
--      une fonction creee en 3 et modifiee en 4
--   6. 2026-10-26-revenus-calcul-incomplet.sql
--
-- ⚠ CET ORDRE A ETE INVERSE LE 26 OCTOBRE 2026, apres un
-- constat BLOQUANT de review. La sonde d'abord creait
-- une fenetre : elle repondait, et `revenus_hors_mois`
-- etait encore en deux arguments, donc PGRST202 — les
-- totaux s'affichaient et les reserves restaient
-- muettes, ce qui est exactement l'ecart MUET que ce
-- lot repare.
--
-- Les deux migrations sont INDEPENDANTES (celle des
-- reserves depend de la 4, celle de la sonde de la 3,
-- et les deux sont deja collees), donc l'ordre inverse
-- n'a aucun etat intermediaire dangereux : tant que la
-- sonde manque, l'ecran refuse tout le bloc.
--
-- Revenus nets : l'ecart MUET se rouvrait par le bien
-- SUPPRIME, et les reserves parlaient d'un autre mois
-- (26 octobre 2026, constats GRAVES 2 et 3 de la
-- review du lot).
-- Lignes < 60 car. : collage manuel.
--
-- ⚠ DEUX DEFAUTS, UNE SEULE FONCTION, DONC UNE SEULE
-- MIGRATION.
--
-- ─── G2 : L'ECART MUET SE ROUVRAIT ────────────────
--
-- `revenus_du_mois` groupe par `property_uuid` QUEL
-- QU'IL SOIT. Le compteur `hors_biens`, lui, ne
-- comptait que les lignes dont `property_uuid` est
-- NULL. Et `property_uuid` est une colonne `uuid` NUE,
-- sans cle etrangere : rien ne la met a NULL quand le
-- bien disparait, et la suppression d'un bien
-- n'invalide pas `derive_le`, donc le rattrapage ne
-- reprend jamais ces lignes.
--
-- Scenario : un bien est retire de `properties` ; ses
-- 3 reservations de novembre (1 500 €) gardent l'UUID
-- supprime. L'agregat rend un groupe pour cet UUID,
-- donc 1 500 € entrent dans le TOTAL du bandeau ;
-- l'ecran boucle sur la liste des biens, aucun ne
-- correspond, donc AUCUNE LIGNE n'est peinte ; et
-- `hors_biens` vaut 0 puisque l'UUID n'est pas NULL.
--
-- Bandeau 1 500 € plus haut que la somme des lignes,
-- MUET. C'est le defaut d'origine, a l'identique —
-- celui que le commit precedent declarait referme.
--
-- ⚠ LA BONNE QUESTION N'EST PAS « L'UUID EST-IL
-- NULL ? » MAIS « CE BIEN EXISTE-T-IL ENCORE ? ».
-- D'ou le `not exists`, et il porte AUSSI `user_id` :
-- un UUID qui existe sur un AUTRE compte n'est pas un
-- bien de celui-ci.
--
-- ─── G3 : LES RESERVES PARLAIENT D'UN AUTRE MOIS ──
--
-- La fonction n'avait AUCUNE borne de mois :
-- `hors_biens_cents` sommait toutes les lignes
-- orphelines du compte, toutes periodes confondues, et
-- l'ecran l'affichait sous un total strictement
-- mensuel. Scenario : 4 sejours orphelins — un verse
-- en novembre (500 €), trois en 2025 (2 500 €). En
-- novembre, l'hote lit un ecart de 500 € et, juste en
-- dessous, « 4 sejours rattaches a aucun de vos
-- logements : 3 000,00 € ». Le chiffre de la reserve
-- additionne de l'argent qui n'est PAS dans le total.
--
-- L'oracle (lib/revenus/mois.js) ne faisait pas ca :
-- son compteur est alimente APRES le filtre du mois.
--
-- ⚠ `sans_date` RESTE TOUS MOIS CONFONDUS, et c'est
-- voulu : une ligne sans date de versement n'a pas de
-- mois, le ranger dans le mois demande serait inventer
-- son appartenance. L'ecran le DIT (« tous mois
-- confondus »). Seuls les deux compteurs d'orphelins
-- se bornent, parce qu'eux ONT une date.
--
-- ⚠ LA SIGNATURE CHANGE, DONC ON SUPPRIME AVANT DE
-- RECREER — et c'est le piege a ne pas rater. Un
-- `create or replace` avec une signature DIFFERENTE ne
-- remplace rien : il cree une SURCHARGE, et l'ancienne
-- fonction a deux arguments reste appelable. Les
-- appels de l'endpoint continueraient de resoudre vers
-- elle, donc rien ne changerait — en silence.
--
-- ⚠ ET UN `drop` PERD LES DROITS, contrairement a un
-- `create or replace`. Il faut donc reposer le
-- `revoke` et le `grant`, et la requete de controle
-- les reverifie.


-- ⚠ LES DEUX SIGNATURES SONT SUPPRIMEES, POUR QUE CE
-- FICHIER SOIT REJOUABLE (constat de review). Le seul
-- `drop` de l'ancienne laissait un second collage
-- echouer sur « function already exists » : le `drop`
-- ne visait pas la version a TROIS arguments, celle que
-- ce fichier cree. Une migration qu'on ne peut pas
-- recoller est une migration qu'on n'ose pas verifier.
drop function if exists
  public.revenus_hors_mois(uuid, uuid[]);

drop function if exists
  public.revenus_hors_mois(uuid, text, uuid[]);

create function public.revenus_hors_mois(
  p_user_id uuid,
  p_mois text,
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
    -- Tous mois confondus : une ligne sans date n'a
    -- pas de mois. L'ecran le dit.
    count(*) filter
      (where b.date_versement is null
         and (p_refs is null
              or b.property_uuid = any(p_refs))),
    -- ⚠ ORPHELIN = AUCUN BIEN EXISTANT, pas « UUID
    -- nul ». Et borne au mois demande.
    count(*) filter
      (where p_refs is null
         and b.date_versement is not null
         and b.date_versement
             >= (p_mois || '-01')::date
         and b.date_versement
             < ((p_mois || '-01')::date
                + interval '1 month')
         and (b.property_uuid is null
              or not exists (
                select 1 from public.properties p
                 where p.id = b.property_uuid
                   and p.user_id = p_user_id))),
    coalesce(sum(case
      when p_refs is null
       and b.date_versement is not null
       and b.date_versement
           >= (p_mois || '-01')::date
       and b.date_versement
           < ((p_mois || '-01')::date
              + interval '1 month')
       and (b.property_uuid is null
            or not exists (
              select 1 from public.properties p
               where p.id = b.property_uuid
                 and p.user_id = p_user_id))
      then b.montant_net_cents else 0 end), 0)
  from public.bookings_snapshot b
  where b.user_id = p_user_id
    and b.statut_canonique = 'confirmed'
    and b.est_blocage is not true
    and (p_refs is null
         or b.property_uuid = any(p_refs)
         or b.property_uuid is null)
$$;

-- ⚠ LES DROITS SE REPOSENT APRES UN `drop`, et
-- `public` n'est pas `anon` : PostgreSQL accorde
-- EXECUTE a PUBLIC par defaut, et `anon` en herite.
revoke all on function
  public.revenus_hors_mois(uuid, text, uuid[])
  from public;

grant execute on function
  public.revenus_hors_mois(uuid, text, uuid[])
  to service_role;


-- ╶╶╶ PREUVE, A COLLER JUSTE APRES ╶╶╶
--
-- ATTENDU — TROIS LIGNES, ET TROIS EXACTEMENT :
--   fonction  revenus_hors_mois -> 3 arguments
--   surcharge revenus_hors_mois -> 1 seule version
--   droit     revenus_hors_mois -> public ne peut pas
--
-- ⚠ LA LIGNE « surcharge » EST CELLE QUI COMPTE. Si
-- elle dit 2, l'ancienne fonction a deux arguments
-- existe encore : l'endpoint l'appellerait et rien
-- n'aurait change. Ne pas poursuivre.

select 'fonction'::text as objet,
       p.proname::text as nom,
       pronargs::text || ' arguments' as detail
  from pg_proc p
  join pg_namespace n
    on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname = 'revenus_hors_mois'
union all
select 'surcharge',
       'revenus_hors_mois',
       count(*)::text || ' version(s)'
  from pg_proc p
  join pg_namespace n
    on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname = 'revenus_hors_mois'
union all
select 'droit',
       'revenus_hors_mois',
       case when bool_or(has_function_privilege(
              'public', p.oid, 'EXECUTE'))
            then 'DANGER : public peut EXECUTE'
            else 'ok : public ne peut pas' end
  from pg_proc p
  join pg_namespace n
    on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname = 'revenus_hors_mois'
-- ⚠ L'ORDRE EST CELUI DE L'ANNONCE, PAS L'ALPHABET.
-- `order by 1, 2` rendait droit / fonction / surcharge,
-- alors que le texte annonce fonction / surcharge /
-- droit : on lisait la premiere ligne en croyant lire
-- l'autre.
 order by case objet when 'fonction' then 1
                     when 'surcharge' then 2
                     else 3 end;
