-- migrations/2026-09-02-droits-lot3.sql
-- Etape 2, LOT 3 — coeur menage et serrures (5 tables).
--
-- Le compte test a `menages = read` sur un seul bien : il doit voir les
-- menage_events et le property_status de La bulle, et RIEN des deux autres.
-- `prestataires` et `reglages` restent a none pour lui : public_tokens, locks et
-- lock_alert_config doivent rester totalement invisibles.
--
-- Rejouable. A EXECUTER dans l'editeur SQL Supabase, puis
-- `node scripts/test-droits.js 3`.

-- ═══════════════════════════════════════════════════════════════════════════
-- 0. PURGE DES ANCIENNES POLITIQUES
-- ═══════════════════════════════════════════════════════════════════════════
-- Deux passes volontairement redondantes :
--
--  a) NOMINATIVE — les cinq politiques relevees en base. Elle documente
--     precisement ce qui est retire, et laisse une trace lisible dans ce fichier
--     de ce qui existait avant le chantier.
--  b) GENERIQUE — par enumeration de pg_policies. Elle rattrape toute politique
--     supplementaire non relevee (nom different, ajout ulterieur, casse).
--
-- Rappel : Postgres combine les politiques PERMISSIVES en OU. Une seule ancienne
-- survivante suffit a rendre le perimetre inoperant.

-- a) Purge nominative (noms reels, avec espaces et majuscules le cas echeant)
drop policy if exists users_own_menage_events        on public.menage_events;
drop policy if exists users_own_property_status      on public.property_status;
drop policy if exists "Users manage own tokens"      on public.public_tokens;
drop policy if exists users_own_locks                on public.locks;
drop policy if exists users_own_lock_alert_config    on public.lock_alert_config;

-- b) Purge generique : tout ce qui n'est pas <table>_select / <table>_write
do $$
declare
  t text;
  pol record;
  gardees text[] := array[]::text[];
begin
  foreach t in array array[
    'menage_events','property_status','public_tokens','locks','lock_alert_config'
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
-- menage_events — menages, cle TEXT
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠ Ecrite par lib/cleaning/sync-menages.js EN SERVICE KEY (cron) : la RLS ne
-- gene pas la production des notifications. Lue par la PWA prestataire via
-- api/menages-public.js, egalement en service key et filtree par token.
-- Cote dashboard, c'est le fil d'actualite du planning menage.
alter table menage_events enable row level security;
drop policy if exists menage_events_select on menage_events;
create policy menage_events_select on menage_events for select to authenticated
  using (can_read(user_id, 'menages', property_id));
drop policy if exists menage_events_write on menage_events;
create policy menage_events_write on menage_events for all to authenticated
  using (can_write(user_id, 'menages', property_id))
  with check (can_write(user_id, 'menages', property_id));

-- ═══════════════════════════════════════════════════════════════════════════
-- property_status — menages, cle TEXT
-- ═══════════════════════════════════════════════════════════════════════════
-- Etat du logement (occupied / to_clean / ready). Ecrit par le cron et par
-- markReady (api/menages-public.js), les deux en service key.
alter table property_status enable row level security;
drop policy if exists property_status_select on property_status;
create policy property_status_select on property_status for select to authenticated
  using (can_read(user_id, 'menages', property_id));
drop policy if exists property_status_write on property_status;
create policy property_status_write on property_status for all to authenticated
  using (can_write(user_id, 'menages', property_id))
  with check (can_write(user_id, 'menages', property_id));

-- ═══════════════════════════════════════════════════════════════════════════
-- public_tokens — prestataires, sans bien
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠ Le PRESTATAIRE n'est pas concerne par cette politique : il n'a pas de
-- session Supabase, il s'authentifie par token via api/menages-public.js, en
-- service key. La RLS ne protege ici que la lecture depuis le dashboard.
-- Elle porte le lien PWA en clair : domaine `prestataires`, jamais `menages`.
-- Un profil qui gere les menages n'a pas a recuperer les liens d'acces.
alter table public_tokens enable row level security;
drop policy if exists public_tokens_select on public_tokens;
create policy public_tokens_select on public_tokens for select to authenticated
  using (can_read(user_id, 'prestataires'));
drop policy if exists public_tokens_write on public_tokens;
create policy public_tokens_write on public_tokens for all to authenticated
  using (can_write(user_id, 'prestataires'))
  with check (can_write(user_id, 'prestataires'));

-- ═══════════════════════════════════════════════════════════════════════════
-- locks — reglages, sans bien
-- ═══════════════════════════════════════════════════════════════════════════
-- Serrures connectees : identifiants Seam des appareils. Rattachees a un bien
-- par property_locks, pas par une colonne property_id — d'ou la signature sans
-- bien. Un membre au perimetre restreint verra donc TOUTES les serrures du
-- compte s'il a `reglages` : c'est une limite connue du modele (un seul
-- perimetre par profil, spec §8), acceptable car `reglages` est deja un droit
-- large. A revoir si le besoin d'un cloisonnement par bien apparait.
alter table locks enable row level security;
drop policy if exists locks_select on locks;
create policy locks_select on locks for select to authenticated
  using (can_read(user_id, 'reglages'));
drop policy if exists locks_write on locks;
create policy locks_write on locks for all to authenticated
  using (can_write(user_id, 'reglages'))
  with check (can_write(user_id, 'reglages'));

-- ═══════════════════════════════════════════════════════════════════════════
-- lock_alert_config — reglages, sans bien
-- ═══════════════════════════════════════════════════════════════════════════
-- Seuil de batterie et numero de telephone d'alerte, par serrure (lock_id).
-- Meme domaine que locks, dont elle est le prolongement.
alter table lock_alert_config enable row level security;
drop policy if exists lock_alert_config_select on lock_alert_config;
create policy lock_alert_config_select on lock_alert_config for select to authenticated
  using (can_read(user_id, 'reglages'));
drop policy if exists lock_alert_config_write on lock_alert_config;
create policy lock_alert_config_write on lock_alert_config for all to authenticated
  using (can_write(user_id, 'reglages'))
  with check (can_write(user_id, 'reglages'));

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

-- b) Anciennes politiques restantes, TOUTES TABLES :
--   select tablename, policyname, cmd
--     from pg_policies
--    where schemaname = 'public'
--      and qual::text not like '%can_read%'
--      and qual::text not like '%can_write%'
--      and tablename not in ('profiles','profile_permissions')
--    order by tablename;
--
-- c) Exactement 2 politiques par table sur les lots 1 a 3 :
--   select tablename, count(*) as politiques
--     from pg_policies
--    where schemaname='public'
--      and tablename in ('automation_incidents','integration_requests','onboarding_state',
--                        'agent_prompting','conversation_flags',
--                        'sms_logs','message_sent_log','agent_tasks','menage_comments','menage_done',
--                        'menage_events','property_status','public_tokens','locks','lock_alert_config')
--    group by tablename order by tablename;
--
-- VERIFICATIONS HUMAINES apres application :
--   - dashboard : planning menage (fil d'actualite), page Serrures, page Prestataires ;
--   - PWA Regina : le planning se charge, marquer fait / annuler fonctionne
--     (service key : ne doit pas etre affecte, mais c'est le chemin le plus
--     sensible du lot).
--
-- RETOUR ARRIERE :
--   alter table <table> disable row level security;
