-- migrations/2026-09-02-droits-lot1.sql
-- Etape 2, LOT 1 — les 5 tables les moins sensibles.
--
-- Techniques et journaux : une erreur ici est visible sans casser un parcours.
-- Le cron n'est JAMAIS concerne (service key, qui contourne la RLS) ; ce qui peut
-- casser, ce sont les lectures directes du front.
--
-- Rejouable. A EXECUTER dans l'editeur SQL Supabase, APRES
-- 2026-09-01-invite-compte-test.sql, puis `node scripts/test-droits.js 1`.

-- ═══════════════════════════════════════════════════════════════════════════
-- automation_incidents — reglages, cle TEXT
-- ═══════════════════════════════════════════════════════════════════════════
alter table automation_incidents enable row level security;
drop policy if exists automation_incidents_select on automation_incidents;
create policy automation_incidents_select on automation_incidents for select to authenticated
  using (can_read(user_id, 'reglages', property_id));
drop policy if exists automation_incidents_write on automation_incidents;
create policy automation_incidents_write on automation_incidents for all to authenticated
  using (can_write(user_id, 'reglages', property_id))
  with check (can_write(user_id, 'reglages', property_id));

-- ═══════════════════════════════════════════════════════════════════════════
-- integration_requests — reglages, sans bien
-- ═══════════════════════════════════════════════════════════════════════════
alter table integration_requests enable row level security;
drop policy if exists integration_requests_select on integration_requests;
create policy integration_requests_select on integration_requests for select to authenticated
  using (can_read(user_id, 'reglages'));
drop policy if exists integration_requests_write on integration_requests;
create policy integration_requests_write on integration_requests for all to authenticated
  using (can_write(user_id, 'reglages'))
  with check (can_write(user_id, 'reglages'));

-- ═══════════════════════════════════════════════════════════════════════════
-- onboarding_state — reglages, sans bien
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠ Ecrite par components/auth-guard.js A CHAQUE CHARGEMENT DE PAGE, en anon key
-- (insert de la ligne au 1er login). Un membre invite n'a pas 'reglages' : son
-- insert echouera silencieusement — c'est acceptable, la ligne appartient au
-- TITULAIRE du compte, pas au membre. A verifier au test : aucune page ne doit
-- planter pour autant.
alter table onboarding_state enable row level security;
drop policy if exists onboarding_state_select on onboarding_state;
create policy onboarding_state_select on onboarding_state for select to authenticated
  using (can_read(user_id, 'reglages'));
drop policy if exists onboarding_state_write on onboarding_state;
create policy onboarding_state_write on onboarding_state for all to authenticated
  using (can_write(user_id, 'reglages'))
  with check (can_write(user_id, 'reglages'));

-- ═══════════════════════════════════════════════════════════════════════════
-- agent_prompting — reglages, cle TEXT
-- ═══════════════════════════════════════════════════════════════════════════
-- Type confirme par le code : apps/agent-ai/config.html ecrit
-- `provider_property_id || id` comme property_id, et lib/cron-classify.js lit
-- `String(property.id)` (= propId provider). C'est donc du TEXT.
-- property_id NULL = instruction GLOBALE du compte : in_scope() laisse passer les
-- valeurs nulles, elle reste donc visible a qui a le droit `reglages`.
alter table agent_prompting enable row level security;
drop policy if exists agent_prompting_select on agent_prompting;
create policy agent_prompting_select on agent_prompting for select to authenticated
  using (can_read(user_id, 'reglages', property_id));
drop policy if exists agent_prompting_write on agent_prompting;
create policy agent_prompting_write on agent_prompting for all to authenticated
  using (can_write(user_id, 'reglages', property_id))
  with check (can_write(user_id, 'reglages', property_id));

-- ═══════════════════════════════════════════════════════════════════════════
-- conversation_flags — messages, sans bien
-- ═══════════════════════════════════════════════════════════════════════════
alter table conversation_flags enable row level security;
drop policy if exists conversation_flags_select on conversation_flags;
create policy conversation_flags_select on conversation_flags for select to authenticated
  using (can_read(user_id, 'messages'));
drop policy if exists conversation_flags_write on conversation_flags;
create policy conversation_flags_write on conversation_flags for all to authenticated
  using (can_write(user_id, 'messages'))
  with check (can_write(user_id, 'messages'));

-- ═══════════════════════════════════════════════════════════════════════════
-- CONTROLE « AUCUNE TABLE OUBLIEE »
-- ═══════════════════════════════════════════════════════════════════════════
-- A relire apres CHAQUE lot. Liste les tables a user_id qui n'ont encore aucune
-- politique adossee a can_read : ce sont celles qui restent a traiter.
--
-- Tant que les 6 lots ne sont pas passes, cette requete DOIT renvoyer des lignes.
-- A la fin, elle doit etre vide — sauf profiles et profile_permissions, dont les
-- politiques sont nominatives (etape 1) et n'utilisent pas can_read.

select c.table_name,
       coalesce(bool_or(p.qual::text like '%can_read%'), false) as protegee
from information_schema.columns c
left join pg_policies p
       on p.schemaname = 'public' and p.tablename = c.table_name
where c.table_schema = 'public'
  and c.column_name = 'user_id'
  and c.table_name not in ('profiles', 'profile_permissions', 'profiles_legacy')
group by c.table_name
having coalesce(bool_or(p.qual::text like '%can_read%'), false) = false
order by c.table_name;

-- Verification ciblee du lot 1 (les 5 doivent apparaitre avec 2 politiques) :
--   select tablename, count(*) as politiques
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in ('automation_incidents','integration_requests','onboarding_state',
--                        'agent_prompting','conversation_flags')
--    group by tablename order by tablename;
--
-- RETOUR ARRIERE (si le test revele un blocage) :
--   alter table <table> disable row level security;
--   -- puis retablir l'ancienne politique `user_id = auth.uid()` si elle existait.
