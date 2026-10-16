-- Les jours habituels se remplacent EN UNE FOIS
-- (16 octobre 2026) — Lot Menages V5, etape 2.
-- APPLIQUEE en PROD le 16 octobre 2026 par Thierry,
-- sur le projet cjmrizpdyhrcurmgyrhs, et prouvee par
-- scripts/verifier-migration-regles-atomiques.js :
-- trois refus attendus (source inconnue, liaison
-- incomplete, plafond depasse), aucune ecriture.
-- APPLIQUEE aussi sur STAGING (ortyofzzdsthlhqmzsnq),
-- verifiee de la meme facon, et c'est la que
-- l'ATOMICITE a ete prouvee contre une vraie base :
-- scripts/prouver-atomicite-regles.js provoque une
-- erreur APRES la desactivation et relit — les regles
-- actives sont exactement celles d'avant. Ce script
-- ecrit (sur une liaison jetable qu'il supprime), et
-- il REFUSE de tourner sur la production.
-- Lignes < 60 car. : collage manuel dans l'editeur.
--
-- POURQUOI. Remplacer les jours habituels d'une
-- prestataire, c'est DESACTIVER ce qui existe et
-- INSERER ce qui remplace. Tant que ces deux ecritures
-- sont deux appels depuis le navigateur, le reseau peut
-- couper entre les deux — un telephone, un ascenseur —
-- et il reste un etat a moitie ecrit.
--
-- Les deux moities ne se valent pas :
--   · desactiver PUIS inserer laisse ZERO regle active,
--     c'est-a-dire « disponible TOUS LES JOURS »
--     (etage 4 de la precedence). Le moteur lui
--     attribue alors des menages n'importe quel jour,
--     et personne ne l'a demande ;
--   · inserer PUIS desactiver laisse l'ANCIEN et le
--     NOUVEAU actifs : elle est disponible sur l'UNION
--     des deux. L'ecran l'affiche fidelement et le
--     geste suivant corrige — c'est le moindre mal,
--     et c'est ce que le code faisait depuis 7d27198.
--
-- Le moindre mal reste un mal : l'union attribue elle
-- aussi des menages des jours que l'hote venait de
-- retirer. Cette fonction supprime le choix. Un bloc
-- plpgsql est une TRANSACTION : les deux ecritures
-- aboutissent ensemble, ou aucune n'a lieu.
--
-- CE QU'ELLE FAIT, DANS CET ORDRE.
--   1. compte les regles actives de la liaison et
--      REFUSE au-dela du plafond — la meme borne que
--      la lecture des ecrans, sans quoi un
--      remplacement redevient une addition ;
--   2. retient ce qui etait actif (id + rrule) : c'est
--      ce que l'appelant comparera pour ANNONCER le
--      changement a la prestataire ;
--   3. desactive ces lignes-la PAR ID — jamais par un
--      filtre `active = true`, qui emporterait ce
--      qu'on vient d'inserer ;
--   4. insere les nouvelles.
--
-- CE QU'ELLE NE FAIT PAS. Elle ne valide NI les jours,
-- NI la cadence, NI la RRULE : tout cela vit dans
-- lib/cleaning/regles.js, partage par les deux ecrans,
-- et une seconde validation en SQL finirait par en
-- diverger. Elle ne connait ni droits ni jetons : les
-- gardes restent chez les appelants, ou elles different
-- reellement (`self_availability` pour la PWA,
-- `prestataires: write` pour la fiche).
--
-- ON DESACTIVE, ON NE SUPPRIME PAS. Une regle supprimee
-- emporterait la raison pour laquelle des menages
-- passes ont ete attribues comme ils l'ont ete.

create or replace function public.remplacer_regles_dispo(
  p_user_id uuid,
  p_provider_id uuid,
  p_source text,
  p_regles jsonb,
  p_max_actives int default 50
)
returns jsonb
language plpgsql
as $$
declare
  v_avant jsonb;
  v_n int;
begin
  if p_user_id is null or p_provider_id is null then
    raise exception 'liaison manquante'
      using errcode = '22023';
  end if;
  if p_source not in ('hote', 'prestataire') then
    raise exception 'source invalide: %', p_source
      using errcode = '22023';
  end if;

  -- 1. Le plafond, et c'est un REFUS, pas un ecretage.
  select count(*) into v_n
    from public.provider_availability_rules
   where user_id = p_user_id
     and provider_id = p_provider_id
     and active = true;
  if v_n > p_max_actives then
    raise exception 'trop de regles actives: %', v_n
      using errcode = '54000';
  end if;

  -- 2. Ce qui etait actif : la forme d'AVANT.
  select coalesce(
      jsonb_agg(jsonb_build_object('id', id,
                                   'rrule', rrule)),
      '[]'::jsonb)
    into v_avant
    from public.provider_availability_rules
   where user_id = p_user_id
     and provider_id = p_provider_id
     and active = true;

  -- 3. Desactiver PAR ID.
  update public.provider_availability_rules
     set active = false
   where user_id = p_user_id
     and provider_id = p_provider_id
     and active = true
     and id in (
       select (e->>'id')::uuid
         from jsonb_array_elements(v_avant) e);

  -- 4. Inserer les nouvelles.
  if jsonb_array_length(coalesce(p_regles, '[]'::jsonb))
       > 0 then
    insert into public.provider_availability_rules
      (user_id, provider_id, rrule, label,
       active, source)
    select p_user_id, p_provider_id,
           r->>'rrule', r->>'label',
           true, p_source
      from jsonb_array_elements(p_regles) r;
  end if;

  return jsonb_build_object(
    'avant', v_avant,
    'posees', jsonb_array_length(
                coalesce(p_regles, '[]'::jsonb)));
end;
$$;

-- Le client utilise la cle service (RLS contournee) ;
-- aucun role anonyme ne doit pouvoir l'appeler.
revoke all on function
  public.remplacer_regles_dispo(uuid, uuid, text,
                                jsonb, int)
  from public, anon, authenticated;
