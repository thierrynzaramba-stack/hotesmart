-- migrations/2026-09-02-droits-lot4.sql
-- Etape 2, LOT 4 — messagerie et connaissances (4 tables).
--
-- ⚠ LE LOT LE PLUS DELICAT. `messages` et `knowledge` sont les deux tables aux
-- colonnes MIXTES : leur property_id porte tantot un provider_property_id (TEXT),
-- tantot un UUID properties.id. in_scope(uuid, text) compare aux DEUX tableaux
-- (property_refs et property_ids) precisement pour cela — sans quoi des lignes
-- parfaitement legitimes deviendraient invisibles.
--
-- ⚠ ET LE TEST NE LE VERIFIERA PAS TOUT SEUL : le compte test est a `none` sur
-- `messages` ET sur `reglages`, donc tout sera invisible de toute facon et le
-- resultat serait vert sans rien prouver. Utiliser
-- 2026-09-02-test-mixtes-bascule.sql pour eprouver reellement ce lot.
--
-- Rejouable. A EXECUTER dans l'editeur SQL Supabase, puis
-- `node scripts/test-droits.js 4`.

-- ═══════════════════════════════════════════════════════════════════════════
-- 0. PURGE DES ANCIENNES POLITIQUES
-- ═══════════════════════════════════════════════════════════════════════════
-- a) Nominative — noms releves en base.
--    Le nom de la politique de `messages` n'a PAS ete releve : la purge
--    generique (b) s'en charge quel qu'il soit. Pour le connaitre :
--      select policyname, cmd from pg_policies
--       where schemaname='public' and tablename='messages';
drop policy if exists "Users manage own conversations" on public.conversations;
drop policy if exists users_own_message_templates      on public.message_templates;
drop policy if exists "Users manage own knowledge"     on public.knowledge;

-- b) Generique — tout ce qui n'est pas <table>_select / <table>_write.
do $$
declare
  t text;
  pol record;
  gardees text[] := array[]::text[];
begin
  foreach t in array array['messages','conversations','message_templates','knowledge']
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
-- messages — messages, cle TEXT (colonne MIXTE)
-- ═══════════════════════════════════════════════════════════════════════════
-- 773 lignes : 3 provider_property_id + 1 UUID orphelin (bien supprime).
-- La ligne orpheline restera invisible a tout membre — comportement sur, mais a
-- ne pas confondre avec un bug de droits (cf. docs/kb/profils-et-droits.md §2).
alter table messages enable row level security;
drop policy if exists messages_select on messages;
create policy messages_select on messages for select to authenticated
  using (can_read(user_id, 'messages', property_id));
drop policy if exists messages_write on messages;
create policy messages_write on messages for all to authenticated
  using (can_write(user_id, 'messages', property_id))
  with check (can_write(user_id, 'messages', property_id));

-- ═══════════════════════════════════════════════════════════════════════════
-- conversations — messages, cle TEXT
-- ═══════════════════════════════════════════════════════════════════════════
alter table conversations enable row level security;
drop policy if exists conversations_select on conversations;
create policy conversations_select on conversations for select to authenticated
  using (can_read(user_id, 'messages', property_id));
drop policy if exists conversations_write on conversations;
create policy conversations_write on conversations for all to authenticated
  using (can_write(user_id, 'messages', property_id))
  with check (can_write(user_id, 'messages', property_id));

-- ═══════════════════════════════════════════════════════════════════════════
-- message_templates — messages, cle TEXT
-- ═══════════════════════════════════════════════════════════════════════════
alter table message_templates enable row level security;
drop policy if exists message_templates_select on message_templates;
create policy message_templates_select on message_templates for select to authenticated
  using (can_read(user_id, 'messages', property_id));
drop policy if exists message_templates_write on message_templates;
create policy message_templates_write on message_templates for all to authenticated
  using (can_write(user_id, 'messages', property_id))
  with check (can_write(user_id, 'messages', property_id));

-- ═══════════════════════════════════════════════════════════════════════════
-- knowledge — reglages, cle TEXT (colonne MIXTE)
-- ═══════════════════════════════════════════════════════════════════════════
-- 62 lignes : 2 provider_property_id + 3 UUID orphelins (19 lignes au total sur
-- des biens disparus). Ces 19 lignes deviendront invisibles a tout membre.
-- Le TITULAIRE, lui, continue de les voir : perm_level lui rend 'write' et
-- in_scope court-circuite pour auth.uid() = row_user_id.
alter table knowledge enable row level security;
drop policy if exists knowledge_select on knowledge;
create policy knowledge_select on knowledge for select to authenticated
  using (can_read(user_id, 'reglages', property_id));
drop policy if exists knowledge_write on knowledge;
create policy knowledge_write on knowledge for all to authenticated
  using (can_write(user_id, 'reglages', property_id))
  with check (can_write(user_id, 'reglages', property_id));

-- ═══════════════════════════════════════════════════════════════════════════
-- CONTROLES
-- ═══════════════════════════════════════════════════════════════════════════
-- a) Tables a user_id encore sans politique can_read (doit decroitre de 4) :
select c.table_name
from information_schema.columns c
left join pg_policies p on p.schemaname = 'public' and p.tablename = c.table_name
where c.table_schema = 'public' and c.column_name = 'user_id'
group by c.table_name
having coalesce(bool_or(p.qual::text like '%can_read%'), false) = false
order by c.table_name;

-- b) Exactement 2 politiques sur les 4 tables du lot :
--   select tablename, count(*) from pg_policies
--    where schemaname='public'
--      and tablename in ('messages','conversations','message_templates','knowledge')
--    group by tablename order by tablename;
--
-- VERIFICATIONS HUMAINES (le lot touche la messagerie, tres visible) :
--   - dashboard : messagerie (fil des conversations), Agent IA (templates),
--     Connaissances (les 6 cles fixed du bien) ;
--   - le TITULAIRE doit tout revoir comme avant, y compris les lignes
--     rattachees a des biens disparus.
--
-- RETOUR ARRIERE :
--   alter table <table> disable row level security;
