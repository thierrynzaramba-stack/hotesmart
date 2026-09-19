-- scripts/seed-staging.sql — jeu de donnees de recette.
-- 1 compte, 3 biens, 4 reservations.
--
-- A N'APPLIQUER QUE SUR LE PROJET SUPABASE STAGING.
-- Deux gardes refusent l'execution ailleurs, dans le
-- bloc GARDES ci-dessous : le compte fondateur de
-- production, et le nombre de comptes.
--
-- Prealable : creer le compte par l'inscription NORMALE
-- sur le site staging. Ce script ne cree aucun compte
-- auth : un insert direct dans auth.users produit un
-- compte sans mot de passe utilisable.
--
-- Idempotent : rejouable sans doublon.
--
-- ⚠ LE COMPTE EST UNE LIGNE, PAS « TOUS LES COMPTES ».
-- Ma premiere reecriture remplacait `_seed_ctx` par
-- `in (select id from auth.users)` : une TAUTOLOGIE.
-- L'update des cles et le delete Stripe reprenaient
-- alors TOUTE la table, et leurs commentaires
-- promettaient l'inverse (« le seed ne touche que ce
-- qu'il gere »). La portee explicite avait disparu dans
-- la reecriture — releve en review.
-- `order by created_at` fige AUSSI la ligne : un
-- `limit 1` nu peut rendre deux lignes differentes a
-- deux instructions, et les biens atterriraient sur un
-- compte pendant que les reservations vont sur l'autre.
--
-- ⚠ PLUS DE TABLE TEMPORAIRE — 19 septembre 2026.
-- La version precedente posait `_seed_ctx` en
-- `create temporary table ... on commit drop`, puis la
-- relisait sept fois. Au collage, l'editeur SQL a rendu
-- « 42P01 : relation _seed_ctx does not exist » : des
-- que le decoupage valide une instruction, `on commit
-- drop` emporte la table avant la lecture suivante. Le
-- compte se relit donc directement depuis auth.users, ou
-- les gardes ont deja etabli qu'il est UNIQUE.
--
-- ⚠ LIGNES COURTES : l'editeur SQL de Supabase tronque
-- les lignes longues au collage (constate 3 fois).
--
-- ⚠ ET CE SCRIPT N'EST PAS ATOMIQUE DANS CET EDITEUR.
-- Le `begin`/`commit` ci-dessous ne protege que si
-- l'outil honore la transaction. L'echec `42P01` sur
-- `_seed_ctx` prouve que l'editeur valide instruction
-- par instruction : le `delete from properties` est
-- donc valide SEUL, et si l'insert qui suit echoue,
-- staging reste sans biens — les FK `on delete cascade`
-- ayant emporte calendar_inventory, price_display_log,
-- ota_reviews, yield_exceptions et les liens de
-- reservation. Aucun rollback.
-- C'est acceptable ICI et seulement ici : staging est un
-- environnement de recette, dont la perte se repare en
-- rejouant ce script. Sur toute autre base, le passer
-- par `psql`, qui honore la transaction.

begin;

-- ─── GARDES ──────────────────────────────────────────
do $$
declare
  v_prod constant uuid :=
    '85e3a0ef-75bd-4c11-a3b7-e2811067dc36';
  v_users int;
begin
  -- 1 : le fondateur de PROD n'existe qu'en prod.
  if exists (
    select 1 from auth.users where id = v_prod
  ) then
    raise exception
      'REFUS : compte fondateur de PRODUCTION detecte.';
  end if;

  -- 2 : un staging frais porte UN compte. Au-dela, on
  -- ne sait pas ou on est : on s'arrete.
  select count(*) into v_users from auth.users;
  if v_users = 0 then
    raise exception
      'REFUS : aucun compte. Inscrivez-vous d''abord.';
  end if;
  if v_users > 1 then
    raise exception
      'REFUS : % comptes, attendu 1.', v_users;
  end if;
end $$;

-- ─── FILET : le pivot des comptes ────────────────────
-- ⚠ 20 tables ont leur FK sur profiles_legacy(id), dont
-- properties. Rien dans le schema ne la remplit : ni
-- fonction, ni trigger, ni defaut. Les comptes existants
-- y sont par un remplissage historique ; un compte NEUF
-- n'y entre pas. Sans ce filet, l'insert de biens echoue
-- sur properties_user_id_fkey — ce qui a plante la
-- creation de bien sur staging le 15 septembre.
-- ⚠ `migrations/0001-triggers-auth-users.sql` ferme la
-- cause pour les inscriptions FUTURES (`handle_new_user`
-- insere dans profiles_legacy) ; ce filet couvre le
-- compte deja cree. Cette phrase avait ete perdue a la
-- reecriture, laissant croire que rien ne remplit la
-- table — un lecteur serait alle refaire un correctif
-- qui existe.
insert into public.profiles_legacy (id, email, full_name)
select u.id, u.email,
       nullif(
         split_part(coalesce(u.email, ''), '@', 1), ''
       )
  from auth.users u
    on conflict (id) do nothing;

-- ─── Nettoyage des biens de seed (rejouabilite) ──────
-- ⚠ UN MOTIF, PAS UNE LISTE. La liste explicite n'a pas
-- vu le bien ajoute au lot 4.5 : rejouer le seed
-- l'aurait DOUBLE. Le prefixe n'appartient qu'a ce
-- script.
delete from public.bookings_snapshot
 where property_id like 'STG-BIEN-%';
delete from public.properties
 where provider_property_id like 'STG-BIEN-%';

-- ⚠ ET LES ENFANTS CLES EN **TEXT**, QUE LA CASCADE NE
-- VOIT PAS. Les FK `on delete cascade` ne couvrent que
-- les tables clees sur `properties.id` (UUID). Celles
-- qui portent `property_id` en TEXT — le numero
-- provider — survivent au delete. Au rejeu, les biens
-- renaissent avec de NOUVEAUX UUID mais le MEME
-- `provider_property_id`, et ces lignes orphelines se
-- rattachent silencieusement aux biens neufs.
-- C'est le motif « menages fantomes » de
-- docs/kb/bookings-snapshot.md, reproduit ici. Releve en
-- review : « rejouable sans doublon » n'etait vrai que
-- pour deux tables.
-- `to_regclass` rend NULL pour une table absente : le
-- bloc ne casse pas si l'une d'elles disparait.
-- Les onze tables ont ete VERIFIEES sur staging le
-- 20 septembre : toutes existent et portent bien
-- `property_id`. Des `delete` explicites plutot qu'une
-- boucle dynamique — on lit ce qui est purge, et rien
-- ne depend d'un `format()` qu'aucun test ne couvre.
delete from public.menages
 where property_id like 'STG-BIEN-%';
delete from public.menage_events
 where property_id like 'STG-BIEN-%';
delete from public.menage_done
 where property_id like 'STG-BIEN-%';
delete from public.menage_comments
 where property_id like 'STG-BIEN-%';
delete from public.messages
 where property_id like 'STG-BIEN-%';
delete from public.conversations
 where property_id like 'STG-BIEN-%';
delete from public.access_codes
 where property_id like 'STG-BIEN-%';
delete from public.booking_change_events
 where property_id like 'STG-BIEN-%';
delete from public.property_status
 where property_id like 'STG-BIEN-%';
delete from public.property_cleaning_providers
 where property_id like 'STG-BIEN-%';
delete from public.sms_logs
 where property_id like 'STG-BIEN-%';

-- ─── Profil titulaire ────────────────────────────────
-- access_mode 'compte' impose pwa_token NULL
-- (contrainte profiles_token_coherent).
insert into public.profiles
  (account_user_id, member_user_id,
   first_name, last_name, email,
   access_mode, is_owner, active, accepted_at)
select u.id, u.id, 'Recette', 'HoteSmart', u.email,
       'compte', true, true, now()
  from auth.users u
 where u.id = (
   select id from auth.users
    order by created_at limit 1
 )
   and not exists (
   select 1 from public.profiles p
    where p.account_user_id = u.id and p.is_owner
 );

-- ─── Trois biens ─────────────────────────────────────
-- rate_sync_mode 'keep' : aucun prix ne part vers un OTA
-- sans geste explicite. automation_paused true : rien ne
-- s'envoie tant qu'on n'a pas depause a la main.
--
-- ⚠ LE TROISIEME EST EN 'managed', DELIBEREMENT (4.5).
-- Les deux premiers, en 'keep', prouvent le REFUS de
-- bascule vers YieldFlow (§2 bis, B bis). Mais un bien
-- 'keep' ne peut jamais etre pilote : sans un bien
-- 'managed', la piece principale — ecriture tarifaire
-- refusee sur un bien PILOTE — n'a aucun bien sur lequel
-- se jouer. STG-BIEN-3 existe pour ca, et pour ca seul.
--
-- ⚠ IL EST BASCULABLE, PAS PILOTE. `pilote_tarifaire`
-- n'est pas nomme ici : il prend son defaut
-- 'calendrier'. La bascule vers YieldFlow est un GESTE
-- DE LA RECETTE — c'est la piece 2 elle-meme. Le seed
-- ne la fait pas a la place du testeur, sinon on ne
-- verifierait jamais que le selecteur fonctionne.
insert into public.properties
  (user_id, name, provider_property_id, provider,
   currency, city, country, capacity,
   inventory_type, inventory_units,
   rate_sync_mode, ota_connect_status, channel_ready,
   automation_paused, paused_reason,
   checkin_time, checkout_time)
select (select id from auth.users
          order by created_at limit 1),
       v.nom, v.propid, 'channex',
       'EUR', v.ville, 'FR', v.cap,
       'whole', 1,
       v.mode, 'draft', false,
       true, 'environnement de recette',
       '16:00', '11:00'
  from (values
    ('Recette — Studio Centre',
     'STG-BIEN-1', 'Toulouse', 2, 'keep'),
    ('Recette — Maison Jardin',
     'STG-BIEN-2', 'Colomiers', 6, 'keep'),
    ('Recette — Loft Pilotable',
     'STG-BIEN-3', 'Blagnac', 4, 'managed')
  ) as v(nom, propid, ville, cap, mode);

-- ─── Cles provider : AUCUNE, desactivees en clair ────
-- ⚠ api_keys.brevo_enabled et seam_enabled valent true
-- PAR DEFAUT. Une ligne creee sans les nommer serait
-- donc ACTIVE. C'est la BASE, et non l'absence de
-- variable d'environnement, qui empeche tout envoi reel.
insert into public.api_keys
  (user_id, api_key, refresh_token,
   brevo_api_key, brevo_enabled,
   seam_api_key, seam_enabled)
select u.id, null, null, null, false, null, false
  from auth.users u
 where u.id = (
   select id from auth.users
    order by created_at limit 1
 )
   and not exists (
   select 1 from public.api_keys k
    where k.user_id = u.id
 );

-- ⚠ QUALIFIE. Un UPDATE sans WHERE ne tient que par une
-- garde posee quarante lignes plus haut. Le seed ne
-- touche que ce qu'il gere.
update public.api_keys
   set api_key = null, refresh_token = null,
       brevo_api_key = null, brevo_enabled = false,
       seam_api_key = null, seam_enabled = false
 where user_id = (
   select id from auth.users
    order by created_at limit 1
 );

-- ─── Stripe : AUCUNE ligne ───────────────────────────
-- secret_key_cipher est NOT NULL avec une contrainte de
-- forme ('v1:%') : une ligne « neutralisee » y est donc
-- IMPOSSIBLE. La neutralisation correcte est l'ABSENCE
-- de ligne, pas une ligne a NULL.
-- Qualifie pour la meme raison que l'update ci-dessus.
delete from public.stripe_accounts
 where user_id = (
   select id from auth.users
    order by created_at limit 1
 );

-- ─── Quatre reservations ─────────────────────────────
-- Dates RELATIVES a aujourd'hui : des dates figees
-- franchiraient la garde d'anciennete de
-- lib/booking-changes.js (JOURS_DE_GRACE = 7) et le jeu
-- deviendrait muet au bout d'une semaine. Meme regle que
-- pour les tests du depot.
insert into public.bookings_snapshot
  (user_id, booking_id, property_id, snapshot)
select (select id from auth.users
          order by created_at limit 1),
       v.bid, v.propid,
       jsonb_build_object(
         'provider', 'channex',
         'status', v.statut,
         'statusRaw', v.statut,
         'arrival', to_char(
           current_date + v.j_arr, 'YYYY-MM-DD'),
         'departure', to_char(
           current_date + v.j_dep, 'YYYY-MM-DD'),
         'arrivalHour', null,
         'firstName', v.prenom,
         'lastName', 'Recette',
         'numAdult', 2,
         'numChild', 0,
         'source', v.canal,
         'otaReservationCode', v.bid,
         'amount', v.montant,
         'commission', null,
         'currency', 'EUR'
       )
  from (values
    ('STG-RES-001', 'STG-BIEN-1', 'confirmed',
     3, 6, 'Alice', 'airbnb', 420.00),
    ('STG-RES-002', 'STG-BIEN-1', 'confirmed',
     12, 15, 'Bruno', 'booking', 385.00),
    ('STG-RES-003', 'STG-BIEN-2', 'confirmed',
     1, 8, 'Chloe', 'direct', 980.00),
    ('STG-RES-004', 'STG-BIEN-2', 'cancelled',
     20, 23, 'David', 'booking', 310.00)
  ) as v(bid, propid, statut,
         j_arr, j_dep, prenom, canal, montant);

commit;

-- ─── Controle (a coller aussi) ───────────────────────
select 'profils' as objet, count(*)
  from public.profiles
union all select 'biens', count(*)
  from public.properties
union all select 'dont basculables', count(*)
  from public.properties
 where rate_sync_mode = 'managed'
union all select 'dont pilotes (attendu 0)', count(*)
  from public.properties
 where pilote_tarifaire = 'yieldflow'
union all select 'reservations', count(*)
  from public.bookings_snapshot
union all select 'cles Stripe', count(*)
  from public.stripe_accounts
union all select 'cles provider non nulles', count(*)
  from public.api_keys
 where api_key is not null
    or refresh_token is not null
    or brevo_api_key is not null
    or seam_api_key is not null
union all select 'canaux actifs (doit etre 0)', count(*)
  from public.api_keys
 where brevo_enabled or seam_enabled;
