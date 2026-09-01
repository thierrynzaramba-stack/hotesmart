-- migrations/2026-09-02-droits-lot5.sql
-- Etape 2, LOT 5 — reservations, codes d'acces et connexions canal (5 tables).
--
-- Le compte test a `reservations = read` sur un seul bien : ce lot est
-- REELLEMENT testable sans bascule, contrairement au lot 4. Il doit voir les
-- reservations et les codes d'acces de La bulle, et rien des deux autres biens.
-- `reglages` restant a none, property_locks et airbnb_connect_sessions doivent
-- rester invisibles.
--
-- ⚠ SEULE TABLE DU CHANTIER EN CLE UUID : airbnb_connect_sessions. C'est la
-- seule occasion de verifier in_scope(uuid, uuid) sur des donnees reelles.
--
-- Rejouable. A EXECUTER dans l'editeur SQL Supabase, puis
-- `node scripts/test-droits.js 5`.

-- ═══════════════════════════════════════════════════════════════════════════
-- 0. PURGE DES ANCIENNES POLITIQUES
-- ═══════════════════════════════════════════════════════════════════════════
-- a) Nominative — noms releves en base.
--    ⚠ `booking_change_events_select` porte le MEME NOM que la politique du
--    nouveau modele : c'est celle posee a l'etape 1 dans la migration des
--    structures, avec `user_id = auth.uid()`. Elle est donc remplacee plus bas
--    par le `create policy` du meme nom — pas besoin de la supprimer ici, et
--    surtout la purge generique ne doit PAS la retirer (elle la garderait de
--    toute facon, le nom etant dans la liste des gardees).
drop policy if exists users_own_bookings_snapshot on public.bookings_snapshot;
drop policy if exists users_own_access_codes      on public.access_codes;
drop policy if exists users_own_property_locks    on public.property_locks;
-- Le nom sur airbnb_connect_sessions n'a pas ete releve : la purge generique
-- s'en charge. Pour le connaitre :
--   select policyname, cmd from pg_policies
--    where schemaname='public' and tablename='airbnb_connect_sessions';

-- b) Generique — tout ce qui n'est pas <table>_select / <table>_write.
do $$
declare
  t text;
  pol record;
  gardees text[] := array[]::text[];
begin
  foreach t in array array[
    'bookings_snapshot','booking_change_events','access_codes',
    'property_locks','airbnb_connect_sessions'
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
-- bookings_snapshot — reservations, cle TEXT
-- ═══════════════════════════════════════════════════════════════════════════
-- Source de verite des reservations, tous providers. Ecrite EXCLUSIVEMENT par
-- lib/bookings-snapshot.js en service key (cron, webhooks) : la RLS ne gene
-- aucune synchronisation. Lue par api/menages.js et api/menages-public.js,
-- egalement en service key.
alter table bookings_snapshot enable row level security;
drop policy if exists bookings_snapshot_select on bookings_snapshot;
create policy bookings_snapshot_select on bookings_snapshot for select to authenticated
  using (can_read(user_id, 'reservations', property_id));
drop policy if exists bookings_snapshot_write on bookings_snapshot;
create policy bookings_snapshot_write on bookings_snapshot for all to authenticated
  using (can_write(user_id, 'reservations', property_id))
  with check (can_write(user_id, 'reservations', property_id));

-- ═══════════════════════════════════════════════════════════════════════════
-- booking_change_events — reservations, cle TEXT
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠ Cette table avait deja une politique posee a l'etape 1 : LECTURE SEULE cote
-- client, aucune ecriture accordee a `authenticated`. La raison tient toujours :
-- account_user_id... non — ici c'est user_id, et surtout booking_id et
-- property_id sont libres. Un membre pouvant INSERER dans cette file ferait
-- annuler le code d'acces du voyageur d'un autre bien, puisque le dispatcher
-- consomme la file en service key.
-- On conserve donc ce principe : select via can_read, AUCUNE politique
-- d'ecriture. Les ecritures passent par le writer, en service key.
alter table booking_change_events enable row level security;
drop policy if exists booking_change_events_select on booking_change_events;
create policy booking_change_events_select on booking_change_events for select to authenticated
  using (can_read(user_id, 'reservations', property_id));
-- Volontairement PAS de booking_change_events_write. Nettoyage si une version
-- anterieure en avait pose une :
drop policy if exists booking_change_events_write on booking_change_events;

-- ═══════════════════════════════════════════════════════════════════════════
-- access_codes — reservations, cle TEXT
-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠ Contient les PIN de serrure en clair (colonne `code`). Le domaine
-- `reservations` est celui du voyageur et de son sejour : un profil qui gere les
-- reservations doit pouvoir constater qu'un code existe. Ecrite uniquement par
-- lib/cron-access.js et lib/cron-arrival-code.js, en service key.
alter table access_codes enable row level security;
drop policy if exists access_codes_select on access_codes;
create policy access_codes_select on access_codes for select to authenticated
  using (can_read(user_id, 'reservations', property_id));
drop policy if exists access_codes_write on access_codes;
create policy access_codes_write on access_codes for all to authenticated
  using (can_write(user_id, 'reservations', property_id))
  with check (can_write(user_id, 'reservations', property_id));

-- ═══════════════════════════════════════════════════════════════════════════
-- property_locks — reglages, cle TEXT
-- ═══════════════════════════════════════════════════════════════════════════
-- Liaison bien <-> serrure. Meme domaine que `locks` et `lock_alert_config`
-- (lot 3) : c'est de la configuration d'equipement, pas de l'exploitation.
-- Contrairement a `locks`, elle porte un property_id : le perimetre s'applique.
alter table property_locks enable row level security;
drop policy if exists property_locks_select on property_locks;
create policy property_locks_select on property_locks for select to authenticated
  using (can_read(user_id, 'reglages', property_id));
drop policy if exists property_locks_write on property_locks;
create policy property_locks_write on property_locks for all to authenticated
  using (can_write(user_id, 'reglages', property_id))
  with check (can_write(user_id, 'reglages', property_id));

-- ═══════════════════════════════════════════════════════════════════════════
-- airbnb_connect_sessions — reglages, cle UUID          ← SEULE TABLE EN UUID
-- ═══════════════════════════════════════════════════════════════════════════
-- Sessions de connexion Airbnb : property_id = properties.id (UUID), et non
-- provider_property_id. C'est la SEULE table du chantier a utiliser la signature
-- in_scope(uuid, uuid), donc la seule occasion de l'eprouver sur des donnees
-- reelles — les 2 lignes existantes portent l'UUID d'un bien Channex existant.
alter table airbnb_connect_sessions enable row level security;
drop policy if exists airbnb_connect_sessions_select on airbnb_connect_sessions;
create policy airbnb_connect_sessions_select on airbnb_connect_sessions for select to authenticated
  using (can_read(user_id, 'reglages', property_id));
drop policy if exists airbnb_connect_sessions_write on airbnb_connect_sessions;
create policy airbnb_connect_sessions_write on airbnb_connect_sessions for all to authenticated
  using (can_write(user_id, 'reglages', property_id))
  with check (can_write(user_id, 'reglages', property_id));

-- ═══════════════════════════════════════════════════════════════════════════
-- CONTROLES
-- ═══════════════════════════════════════════════════════════════════════════
-- a) Tables a user_id encore sans politique can_read (doit tomber a 5 : celles
--    du lot 6) :
select c.table_name
from information_schema.columns c
left join pg_policies p on p.schemaname = 'public' and p.tablename = c.table_name
where c.table_schema = 'public' and c.column_name = 'user_id'
group by c.table_name
having coalesce(bool_or(p.qual::text like '%can_read%'), false) = false
order by c.table_name;

-- b) Politiques du lot 5. ATTENTION : booking_change_events en a UNE seule
--    (lecture), les quatre autres en ont DEUX. Un 2 sur booking_change_events
--    signifierait qu'une politique d'ecriture a ete posee par erreur.
--   select tablename, count(*) as politiques from pg_policies
--    where schemaname='public'
--      and tablename in ('bookings_snapshot','booking_change_events','access_codes',
--                        'property_locks','airbnb_connect_sessions')
--    group by tablename order by tablename;
--
-- VERIFICATIONS HUMAINES (lot tres visible) :
--   - dashboard : calendrier, planning menage (il lit bookings_snapshot via
--     api/menages.js en service key, donc ne devrait pas bouger), page Serrures ;
--   - PWA Regina : le planning se charge toujours ;
--   - le cron : un cycle complet sans erreur (il ecrit en service key, aucun
--     impact attendu — mais bookings_snapshot est sa table la plus sollicitee).
--
-- RETOUR ARRIERE :
--   alter table <table> disable row level security;
