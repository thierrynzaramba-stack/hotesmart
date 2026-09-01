-- migrations/2026-09-02-droits-lot2.sql
-- Etape 2, LOT 2 — journaux et historiques metier (5 tables)
--                  + RATTRAPAGE de la purge des anciennes politiques du LOT 1.
--
-- PREMIER TEST POSITIF du chantier : le compte test a `menages = read` sur un
-- seul bien. Il doit voir les lignes de La bulle dans menage_comments et
-- menage_done — et AUCUNE des deux autres. Jusqu'ici, tous les tests etaient
-- negatifs (rien ne doit etre visible), ce qui ne prouvait que l'absence de
-- regression.
--
-- Rejouable. A EXECUTER dans l'editeur SQL Supabase, puis
-- `node scripts/test-droits.js 2`.

-- ═══════════════════════════════════════════════════════════════════════════
-- 0. PURGE DES ANCIENNES POLITIQUES
-- ═══════════════════════════════════════════════════════════════════════════
-- Les politiques historiques (`user_id = auth.uid()`) doivent DISPARAITRE.
--
-- Postgres combine les politiques PERMISSIVES en OU : une ligne est visible des
-- qu'UNE politique l'autorise. Une ancienne `user_id = auth.uid()` laissee en
-- place rend donc toute ligne du compte visible a son titulaire sans passer par
-- le perimetre, et une ancienne politique `for all` autorise des ecritures que
-- can_write refuse. Le nouveau modele ne s'applique reellement que seul.
--
-- On ne suppose AUCUN nom : on supprime tout ce qui ne fait pas partie du
-- nouveau modele, table par table.
--
-- ⚠ La liste couvre AUSSI les cinq tables du LOT 1, qui n'ont pas eu leur purge.
-- Le dashboard fonctionne apres le lot 1, mais cela ne dit RIEN sur la presence
-- d'anciennes politiques : le titulaire voit ses donnees dans les deux cas
-- (perm_level lui rend 'write' des que auth.uid() = row_user_id). Seule la
-- requete de controle c) tranche — au-dela de 2 politiques par table, une
-- ancienne a survecu.
do $$
declare
  t text;
  pol record;
  gardees text[] := array[]::text[];
begin
  foreach t in array array[
    -- LOT 1 (rattrapage : ces tables n'ont pas eu leur purge)
    'automation_incidents','integration_requests','onboarding_state',
    'agent_prompting','conversation_flags',
    -- LOT 2
    'sms_logs','message_sent_log','agent_tasks','menage_comments','menage_done'
  ]
  loop
    gardees := array[t || '_select', t || '_write'];
    for pol in
      select policyname from pg_policies
       where schemaname = 'public' and tablename = t
         and policyname <> all (gardees)
    loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
      raise notice 'ancienne politique supprimee : %.%', t, pol.policyname;
    end loop;
  end loop;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- sms_logs — messages, cle TEXT
-- ═══════════════════════════════════════════════════════════════════════════
alter table sms_logs enable row level security;
drop policy if exists sms_logs_select on sms_logs;
create policy sms_logs_select on sms_logs for select to authenticated
  using (can_read(user_id, 'messages', property_id));
drop policy if exists sms_logs_write on sms_logs;
create policy sms_logs_write on sms_logs for all to authenticated
  using (can_write(user_id, 'messages', property_id))
  with check (can_write(user_id, 'messages', property_id));

-- ═══════════════════════════════════════════════════════════════════════════
-- message_sent_log — messages, sans bien
-- ═══════════════════════════════════════════════════════════════════════════
-- Anti-doublon d'envoi, ecrit par le cron en service key : la RLS ne le gene pas.
alter table message_sent_log enable row level security;
drop policy if exists message_sent_log_select on message_sent_log;
create policy message_sent_log_select on message_sent_log for select to authenticated
  using (can_read(user_id, 'messages'));
drop policy if exists message_sent_log_write on message_sent_log;
create policy message_sent_log_write on message_sent_log for all to authenticated
  using (can_write(user_id, 'messages'))
  with check (can_write(user_id, 'messages'));

-- ═══════════════════════════════════════════════════════════════════════════
-- agent_tasks — messages, cle TEXT
-- ═══════════════════════════════════════════════════════════════════════════
alter table agent_tasks enable row level security;
drop policy if exists agent_tasks_select on agent_tasks;
create policy agent_tasks_select on agent_tasks for select to authenticated
  using (can_read(user_id, 'messages', property_id));
drop policy if exists agent_tasks_write on agent_tasks;
create policy agent_tasks_write on agent_tasks for all to authenticated
  using (can_write(user_id, 'messages', property_id))
  with check (can_write(user_id, 'messages', property_id));

-- ═══════════════════════════════════════════════════════════════════════════
-- menage_comments — menages, cle TEXT        ← TEST POSITIF
-- ═══════════════════════════════════════════════════════════════════════════
alter table menage_comments enable row level security;
drop policy if exists menage_comments_select on menage_comments;
create policy menage_comments_select on menage_comments for select to authenticated
  using (can_read(user_id, 'menages', property_id));
drop policy if exists menage_comments_write on menage_comments;
create policy menage_comments_write on menage_comments for all to authenticated
  using (can_write(user_id, 'menages', property_id))
  with check (can_write(user_id, 'menages', property_id));

-- ═══════════════════════════════════════════════════════════════════════════
-- menage_done — menages, cle TEXT            ← TEST POSITIF
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠ Lue et ecrite par la PWA prestataire via api/menages-public.js, EN SERVICE
-- KEY : le prestataire n'a pas de session Supabase, il s'authentifie par token.
-- La RLS ne le concerne donc pas. A confirmer au test : marquer un menage fait
-- depuis la PWA doit continuer de fonctionner.
alter table menage_done enable row level security;
drop policy if exists menage_done_select on menage_done;
create policy menage_done_select on menage_done for select to authenticated
  using (can_read(user_id, 'menages', property_id));
drop policy if exists menage_done_write on menage_done;
create policy menage_done_write on menage_done for all to authenticated
  using (can_write(user_id, 'menages', property_id))
  with check (can_write(user_id, 'menages', property_id));

-- ═══════════════════════════════════════════════════════════════════════════
-- CONTROLES
-- ═══════════════════════════════════════════════════════════════════════════
-- a) Tables a user_id encore sans politique can_read (doit decroitre de 5) :
select c.table_name
from information_schema.columns c
left join pg_policies p on p.schemaname = 'public' and p.tablename = c.table_name
where c.table_schema = 'public' and c.column_name = 'user_id'
group by c.table_name
having coalesce(bool_or(p.qual::text like '%can_read%'), false) = false
order by c.table_name;

-- b) Anciennes politiques restantes, TOUTES TABLES (doit se vider lot apres lot) :
--   select tablename, policyname, cmd
--     from pg_policies
--    where schemaname = 'public'
--      and qual::text not like '%can_read%'
--      and qual::text not like '%can_write%'
--      and tablename not in ('profiles','profile_permissions')
--    order by tablename;
--
-- c) Les lots 1 et 2 ont bien EXACTEMENT 2 politiques par table (si une table en
--    affiche 3 ou plus, une ancienne a survecu a la purge) :
--   select tablename, count(*) as politiques
--     from pg_policies
--    where schemaname='public'
--      and tablename in ('automation_incidents','integration_requests','onboarding_state',
--                        'agent_prompting','conversation_flags',
--                        'sms_logs','message_sent_log','agent_tasks','menage_comments','menage_done')
--    group by tablename order by tablename;
--
-- RETOUR ARRIERE :
--   alter table <table> disable row level security;
