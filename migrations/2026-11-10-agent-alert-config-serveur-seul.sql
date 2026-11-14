-- migrations/2026-11-10-agent-alert-config-serveur-seul.sql
-- PWA lot 2c-3, étape 4 — constats 1, 3 et 7 de la review du 10 novembre 2026.
--
-- Deux gestes, et une raison commune : une liste d'alertes REPRISE (mise de
-- côté dans `listes_reprises` par scripts/reprendre-listes-alertes.js, ses
-- adresses devenues contacts prévenus ou réglages de la personne) ne doit
-- jamais revenir. Sinon l'ancien expéditeur repart en parallèle des contacts :
-- deux messages pour une alerte, et une adresse désinscrite d'un côté qui
-- reçoit encore de l'autre.
--
-- 1. LA TABLE NE S'ÉCRIT PLUS QUE PAR LE SERVEUR. La politique d'écriture
--    `agent_alert_config_write` (2026-09-02-droits-lot6.sql) laissait un
--    titulaire, ou un membre `reglages:write`, écrire la table en direct par
--    PostgREST — donc contourner les clés réservées et le 410 de
--    api/agent-config.js. Aucune page n'écrit la table en direct (mesuré : tout
--    passe par /api/agent-config, en clé de service). La LECTURE reste ouverte
--    au domaine `reglages`, telle quelle. La RLS reste ACTIVE.
--
-- 2. LA BASE REFUSE DE DÉFAIRE UNE REPRISE. Pour chaque logement de l'ancienne
--    config qui porte `listes_reprises`, la nouvelle config, si elle garde ce
--    logement, doit garder toute la pile et ne pas AJOUTER ni MODIFIER
--    `intervention` ou `info_unknown`. (Une liste déjà présente À CÔTÉ de la
--    pile, et laissée telle quelle, passe : sinon un logement dans cet état
--    mixte bloquerait toute écriture du compte, mode et délais compris, sans
--    issue — constat 1 de la re-review. Cet état ne doit pas exister : la
--    vérification ci-dessous le compte.) Ferme la course lecture → coupure → écriture
--    (api/agent-config.js relit, le script coupe, l'endpoint réécrit ce qu'il
--    avait lu) et un `--go` lancé avant le déploiement (l'ancien Messages
--    réécrirait les listes). Un logement RETIRÉ de la config reste permis
--    (scripts de re-clé). Le refus porte le code `HS409` :
--    api/agent-config.js le rend en 409.
--
-- Vérification après application (éditeur SQL) :
--   select policyname, cmd from pg_policies where tablename = 'agent_alert_config';
--     -> une seule ligne : agent_alert_config_select, SELECT
--   select tgname from pg_trigger
--    where tgrelid = 'public.agent_alert_config'::regclass and not tgisinternal;
--     -> agent_alert_config_listes_reprises
--   select count(*) from agent_alert_config c, jsonb_each(c.config) e
--    where jsonb_typeof(c.config) = 'object' and jsonb_typeof(e.value) = 'object'
--      and e.value ? 'listes_reprises' and e.value ?| array['intervention','info_unknown'];
--     -> 0 (aucun logement à la fois repris et porteur d'une liste)

drop policy if exists agent_alert_config_write on public.agent_alert_config;

create or replace function public.agent_alert_config_garder_reprises()
returns trigger
language plpgsql
as $$
declare
  ref text;
  avant jsonb;
  apres jsonb;
  pile_avant jsonb;
begin
  if jsonb_typeof(old.config) is distinct from 'object' then
    return new;
  end if;
  for ref, avant in select key, value from jsonb_each(old.config) loop
    if jsonb_typeof(avant) is distinct from 'object'
       or not (avant ? 'listes_reprises') then
      continue;
    end if;
    if jsonb_typeof(new.config) is distinct from 'object'
       or not (new.config ? ref) then
      continue;
    end if;
    apres := new.config -> ref;
    -- Une pile ancienne en objet seul (forme que `mettreDeCote` sait lire)
    -- se compare comme une pile d'un élément.
    pile_avant := case jsonb_typeof(avant -> 'listes_reprises')
      when 'array' then avant -> 'listes_reprises'
      else jsonb_build_array(avant -> 'listes_reprises') end;
    -- La pile est gardée telle quelle, ou allongée (une seconde reprise).
    if jsonb_typeof(apres) is distinct from 'object'
       or not (apres ? 'listes_reprises')
       or not ((apres -> 'listes_reprises') = (avant -> 'listes_reprises')
               or (jsonb_typeof(apres -> 'listes_reprises') = 'array'
                   and (apres -> 'listes_reprises') @> pile_avant))
       or exists (select 1 from unnest(array['intervention', 'info_unknown']) k
                   where apres ? k and (apres -> k) is distinct from (avant -> k)) then
      raise exception using
        errcode = 'HS409',
        message = 'La configuration a changé pendant l''enregistrement : rechargez la page et recommencez.',
        detail = 'listes_reprises : ' || ref;
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists agent_alert_config_listes_reprises on public.agent_alert_config;
create trigger agent_alert_config_listes_reprises
  before update on public.agent_alert_config
  for each row execute function public.agent_alert_config_garder_reprises();
