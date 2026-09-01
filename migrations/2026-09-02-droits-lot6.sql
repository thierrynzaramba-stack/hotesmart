-- migrations/2026-09-02-droits-lot6.sql
-- Etape 2, LOT 6 — le lot sensible, applique en DERNIER (6 tables).
--
-- Pourquoi en dernier : une politique trop restrictive sur `api_keys` couperait
-- toute integration, et sur `properties` viderait l'ensemble des pages — aucun
-- nom de bien ne s'afficherait nulle part.
--
-- Rejouable. A EXECUTER dans l'editeur SQL Supabase, puis
-- `node scripts/test-droits.js 6`.

-- ═══════════════════════════════════════════════════════════════════════════
-- 0. PURGE DES ANCIENNES POLITIQUES
-- ═══════════════════════════════════════════════════════════════════════════
-- Aucun nom releve pour ce lot : la purge generique s'en charge integralement.
-- Pour les connaitre avant execution :
--   select tablename, policyname, cmd from pg_policies
--    where schemaname='public'
--      and tablename in ('properties','api_keys','app_logs','agent_alert_config',
--                        'accounts','subscriptions')
--    order by tablename;
do $$
declare
  t text;
  pol record;
  gardees text[] := array[]::text[];
begin
  foreach t in array array[
    'properties','api_keys','app_logs','agent_alert_config','accounts','subscriptions'
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
-- properties — POLITIQUE DEDIEE
-- ═══════════════════════════════════════════════════════════════════════════
-- LECTURE : le perimetre SEUL, sans condition de domaine.
--
-- C'est la seule table du chantier dans ce cas, et c'est necessaire : elle porte
-- le perimetre lui-meme. Un membre doit pouvoir lire les biens qui lui sont
-- attribues quel que soit son droit sur `reglages`, sinon aucune page ne peut
-- afficher un nom de bien — le planning menage montrerait des identifiants
-- bruts, les filtres seraient vides, la messagerie sans intitules.
--
-- Le risque est faible : la table ne contient que le descriptif du bien (nom,
-- adresse, capacite, tarif de base). Les identifiants d'integration vivent dans
-- api_keys, les reglages canal dans property_channel_rate_plans.
--
-- ECRITURE : `reglages` en write ET le bien dans le perimetre.
alter table properties enable row level security;
drop policy if exists properties_select on properties;
create policy properties_select on properties for select to authenticated
  using (in_scope(user_id, id));
drop policy if exists properties_write on properties;
create policy properties_write on properties for all to authenticated
  using (can_write(user_id, 'reglages', id))
  with check (can_write(user_id, 'reglages', id));

-- ═══════════════════════════════════════════════════════════════════════════
-- api_keys — TITULAIRE SEUL
-- ═══════════════════════════════════════════════════════════════════════════
-- Clés Beds24, Seam et Brevo en clair. Ce ne sont pas des « reglages » : ce sont
-- des identifiants qui donnent acces aux serrures, au PMS et a l'envoi d'emails.
-- Aucun profil delegue n'a a les lire, meme en `reglages = write`.
-- Pas de domaine, pas de perimetre : uniquement le titulaire du compte.
alter table api_keys enable row level security;
drop policy if exists api_keys_select on api_keys;
create policy api_keys_select on api_keys for select to authenticated
  using (user_id = auth.uid());
drop policy if exists api_keys_write on api_keys;
create policy api_keys_write on api_keys for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════════════
-- app_logs — TITULAIRE SEUL
-- ═══════════════════════════════════════════════════════════════════════════
-- Journal d'audit applicatif (app_id, action, data jsonb). `data` est un champ
-- libre dont le contenu n'est pas garanti : il peut porter des informations
-- relatives a n'importe quel bien. Et la spec place le journal d'audit hors
-- perimetre (§8) — aucun profil n'a de raison de le lire.
-- Table vide a ce jour, aucun code du repo ne l'utilise.
alter table app_logs enable row level security;
drop policy if exists app_logs_select on app_logs;
create policy app_logs_select on app_logs for select to authenticated
  using (user_id = auth.uid());
drop policy if exists app_logs_write on app_logs;
create policy app_logs_write on app_logs for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════════════
-- agent_alert_config — reglages, sans bien
-- ═══════════════════════════════════════════════════════════════════════════
-- Canaux d'alerte de l'hote (email, SMS). Configuration au sens propre : un
-- profil avec `reglages` peut legitimement l'ajuster.
alter table agent_alert_config enable row level security;
drop policy if exists agent_alert_config_select on agent_alert_config;
create policy agent_alert_config_select on agent_alert_config for select to authenticated
  using (can_read(user_id, 'reglages'));
drop policy if exists agent_alert_config_write on agent_alert_config;
create policy agent_alert_config_write on agent_alert_config for all to authenticated
  using (can_write(user_id, 'reglages'))
  with check (can_write(user_id, 'reglages'));

-- ═══════════════════════════════════════════════════════════════════════════
-- accounts — facturation
-- ═══════════════════════════════════════════════════════════════════════════
-- Identifiants Stripe, statut d'abonnement, quantite facturee, dates d'essai.
-- can_write refuse `facturation` a tout autre que le titulaire, quel que soit le
-- niveau stocke : la LECTURE est delegable (un comptable, un associe), jamais
-- l'ecriture.
alter table accounts enable row level security;
drop policy if exists accounts_select on accounts;
create policy accounts_select on accounts for select to authenticated
  using (can_read(user_id, 'facturation'));
drop policy if exists accounts_write on accounts;
create policy accounts_write on accounts for all to authenticated
  using (can_write(user_id, 'facturation'))
  with check (can_write(user_id, 'facturation'));

-- ═══════════════════════════════════════════════════════════════════════════
-- subscriptions — facturation
-- ═══════════════════════════════════════════════════════════════════════════
alter table subscriptions enable row level security;
drop policy if exists subscriptions_select on subscriptions;
create policy subscriptions_select on subscriptions for select to authenticated
  using (can_read(user_id, 'facturation'));
drop policy if exists subscriptions_write on subscriptions;
create policy subscriptions_write on subscriptions for all to authenticated
  using (can_write(user_id, 'facturation'))
  with check (can_write(user_id, 'facturation'));

-- ═══════════════════════════════════════════════════════════════════════════
-- CONTROLE FINAL « AUCUNE TABLE OUBLIEE »
-- ═══════════════════════════════════════════════════════════════════════════
-- Apres ce lot, cette requete doit renvoyer EXACTEMENT trois lignes :
--   api_keys, app_logs, properties
-- — les trois politiques dediees, qui n'utilisent pas can_read. Toute AUTRE
-- table qui apparait ici a ete oubliee.
select c.table_name
from information_schema.columns c
left join pg_policies p on p.schemaname = 'public' and p.tablename = c.table_name
where c.table_schema = 'public' and c.column_name = 'user_id'
group by c.table_name
having coalesce(bool_or(p.qual::text like '%can_read%'), false) = false
order by c.table_name;

-- Aucune ancienne politique ne doit subsister, TOUTES TABLES :
--   select tablename, policyname, cmd from pg_policies
--    where schemaname='public'
--      and qual::text not like '%can_read%'
--      and qual::text not like '%can_write%'
--      and qual::text not like '%in_scope%'
--      and qual::text not like '%auth.uid()%'
--      and tablename not in ('profiles','profile_permissions')
--    order by tablename;
--
-- Chaque table a user_id a bien la RLS active :
--   select c.table_name, t.rowsecurity
--     from information_schema.columns c
--     join pg_tables t on t.schemaname='public' and t.tablename=c.table_name
--    where c.table_schema='public' and c.column_name='user_id' and not t.rowsecurity;
--   -- doit etre vide
--
-- VERIFICATIONS HUMAINES (le lot le plus risque) :
--   - TOUTES les pages doivent afficher les noms de biens (properties_select) ;
--   - page Connexions : les cles doivent rester visibles pour le titulaire ;
--   - page Abonnement : statut et essai visibles ;
--   - un cycle de cron complet sans erreur.
--
-- RETOUR ARRIERE :
--   alter table <table> disable row level security;
