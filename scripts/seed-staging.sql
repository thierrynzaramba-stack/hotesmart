-- scripts/seed-staging.sql — jeu de donnees minimal pour l'environnement
-- de recette. 1 compte, 2 biens, quelques reservations.
--
-- A N'APPLIQUER QUE SUR LE PROJET SUPABASE STAGING.
-- Deux gardes refusent l'execution ailleurs (voir bloc GARDES).
--
-- Prealable : creer le compte par l'inscription NORMALE sur le site staging.
-- Ce script ne cree pas d'utilisateur auth : un insert direct dans auth.users
-- produit un compte sans identity ni mot de passe hache utilisable, donc un
-- compte sur lequel on ne peut pas se connecter.
--
-- Idempotent : rejouable sans doublon (on nettoie les biens de seed d'abord).

begin;

-- ─── GARDES ─────────────────────────────────────────────────────────────────
do $$
declare
  v_prod_founder constant uuid := '85e3a0ef-75bd-4c11-a3b7-e2811067dc36';
  v_users int;
begin
  -- Garde 1 : le compte fondateur de la PRODUCTION n'existe qu'en production.
  if exists (select 1 from auth.users where id = v_prod_founder) then
    raise exception
      'REFUS : compte fondateur de production detecte. Ce script ne doit JAMAIS tourner sur la prod.';
  end if;

  -- Garde 2 : un staging frais porte UN compte, celui qu'on vient de creer.
  -- Au-dela, on ne sait pas ou on est : on s'arrete plutot que de deviner.
  select count(*) into v_users from auth.users;
  if v_users = 0 then
    raise exception
      'REFUS : aucun compte. Inscrivez-vous d''abord sur le site staging.';
  end if;
  if v_users > 1 then
    raise exception
      'REFUS : % comptes presents, attendu 1. Verifiez que vous etes bien sur staging.', v_users;
  end if;
end $$;

-- ─── Le compte ──────────────────────────────────────────────────────────────
create temporary table _seed_ctx on commit drop as
select id as user_id from auth.users limit 1;

-- ─── FILET : le pivot des comptes ───────────────────────────────────────────
-- ⚠ 20 tables ont leur FK sur `profiles_legacy(id)`, dont `properties`. Rien
-- dans le schema ne la remplit : ni fonction, ni trigger, ni defaut — verifie
-- sur le dump entier de la production. Les comptes existants y sont par un
-- remplissage historique ; un compte NEUF n'y entre pas.
-- Sans ce filet, l'insert de biens plus bas echoue sur
-- `properties_user_id_fkey` — c'est exactement ce qui a plante la creation de
-- bien sur staging le 15 septembre. Ma verification des colonnes obligatoires
-- ne regardait pas les cles etrangeres : elle ne pouvait pas le voir.
-- migrations/0001 ferme la cause pour les inscriptions futures ; ce filet
-- couvre le compte deja cree.
insert into public.profiles_legacy (id, email, full_name)
select u.id, u.email, nullif(split_part(coalesce(u.email, ''), '@', 1), '')
  from auth.users u
    on conflict (id) do nothing;

-- ─── Nettoyage des biens de seed (rejouabilite) ─────────────────────────────
-- ⚠ UN MOTIF, PAS UNE LISTE. La liste explicite ('STG-BIEN-1',
-- 'STG-BIEN-2') a survecu a l'ajout d'un troisieme bien au lot 4.5 : le
-- nettoyage ne le voyait pas, et rejouer le seed le DOUBLAIT — alors que la
-- rejouabilite est justement ce que ce bloc promet en tete de fichier.
-- Le prefixe 'STG-BIEN-' n'appartient qu'a ce script.
delete from public.bookings_snapshot
 where property_id like 'STG-BIEN-%';
delete from public.properties
 where provider_property_id like 'STG-BIEN-%';

-- ─── Profil titulaire ───────────────────────────────────────────────────────
-- access_mode 'compte' impose pwa_token NULL (contrainte profiles_token_coherent).
insert into public.profiles
  (account_user_id, member_user_id, first_name, last_name,
   email, access_mode, is_owner, active, accepted_at)
select c.user_id, c.user_id, 'Recette', 'HoteSmart',
       u.email, 'compte', true, true, now()
  from _seed_ctx c
  join auth.users u on u.id = c.user_id
 where not exists (
   select 1 from public.profiles p
    where p.account_user_id = c.user_id and p.is_owner
 );

-- ─── Trois biens ────────────────────────────────────────────────────────────
-- rate_sync_mode 'keep' : aucun prix ne part vers un OTA sans geste explicite.
-- automation_paused true : rien ne s'envoie tant qu'on n'a pas depause a la main.
--
-- ⚠ LE TROISIEME EST EN 'managed', ET C'EST DELIBERE (lot 4.5).
-- Les deux premiers sont en 'keep' : ils prouvent le REFUS de bascule vers
-- YieldFlow (spec §2 bis, B bis). Mais ce refus etant le seul cas jouable, la
-- pièce principale — « ecriture tarifaire refusee sur un bien PILOTE par
-- YieldFlow » — n'avait aucun bien sur lequel se jouer : un bien 'keep' ne
-- peut pas basculer, donc ne peut jamais etre pilote.
-- 'STG-BIEN-3' existe pour ça, et pour ça seulement. Il reste
-- `automation_paused` comme les autres : rien ne part de staging.
insert into public.properties
  (user_id, name, provider_property_id, provider, currency,
   city, country, capacity, inventory_type, inventory_units,
   rate_sync_mode, ota_connect_status, channel_ready,
   automation_paused, paused_reason, checkin_time, checkout_time)
select c.user_id, v.nom, v.propid, 'channex', 'EUR',
       v.ville, 'FR', v.cap, 'whole', 1,
       v.mode, 'draft', false,
       true, 'environnement de recette', '16:00', '11:00'
  from _seed_ctx c,
       (values ('Recette — Studio Centre', 'STG-BIEN-1', 'Toulouse', 2, 'keep'),
               ('Recette — Maison Jardin', 'STG-BIEN-2', 'Colomiers', 6, 'keep'),
               ('Recette — Loft Pilotable', 'STG-BIEN-3', 'Blagnac', 4, 'managed'))
         as v(nom, propid, ville, cap, mode);

-- ─── Cles provider : AUCUNE, et desactivees explicitement ───────────────────
-- ⚠ api_keys.brevo_enabled et seam_enabled valent true PAR DEFAUT. Une ligne
-- creee sans les nommer serait donc ACTIVE. On les pose a false explicitement.
-- Les colonnes de cles restent NULL : c'est la base, et non l'absence de
-- variable d'environnement, qui empeche tout envoi reel (api/sms.js n'a aucun
-- fallback sur process.env, lib/providers/seam.js lit la base en premier).
insert into public.api_keys
  (user_id, api_key, refresh_token, brevo_api_key, brevo_enabled,
   seam_api_key, seam_enabled)
select c.user_id, null, null, null, false, null, false
  from _seed_ctx c
 where not exists (
   select 1 from public.api_keys k where k.user_id = c.user_id
 );

-- ⚠ QUALIFIE, comme le delete de stripe_accounts plus bas et pour la meme
-- raison : un UPDATE sans WHERE ne tient que par une garde posee quarante
-- lignes plus haut. Le seed n'a le droit de toucher que ce qu'il gere.
update public.api_keys
   set api_key = null, refresh_token = null,
       brevo_api_key = null, brevo_enabled = false,
       seam_api_key = null, seam_enabled = false
 where user_id in (select user_id from _seed_ctx);

-- ─── Stripe : AUCUNE ligne ──────────────────────────────────────────────────
-- stripe_accounts.secret_key_cipher est NOT NULL avec une contrainte de forme
-- ('v1:%'). Une ligne « neutralisee » y est donc IMPOSSIBLE : la neutralisation
-- correcte est l'absence de ligne, pas une ligne a NULL.
--
-- ⚠ QUALIFIE AU COMPTE DE RECETTE. La version precedente vidait la table
-- ENTIERE. Les gardes garantissent qu'il n'y a qu'un compte ici, donc le
-- resultat etait le meme — mais un `delete` non qualifie dans un script qu'on
-- rejoue ne tient que par une garde posee quarante lignes plus haut. Si cette
-- garde s'assouplit un jour, le `delete` emporte tout sans le dire.
-- Portee explicite : ce que le seed a le droit d'effacer, c'est ce qu'il gere.
delete from public.stripe_accounts
 where user_id in (select user_id from _seed_ctx);

-- ─── Quelques reservations ──────────────────────────────────────────────────
-- Dates RELATIVES a aujourd'hui : des dates figees franchiraient la garde
-- d'anciennete de lib/booking-changes.js (JOURS_DE_GRACE = 7) et le jeu
-- deviendrait muet au bout d'une semaine. Meme regle que pour les tests.
insert into public.bookings_snapshot
  (user_id, booking_id, property_id, snapshot)
select c.user_id, v.bid, v.propid,
       jsonb_build_object(
         'provider',           'channex',
         'status',             v.statut,
         'statusRaw',          v.statut,
         'arrival',            to_char(current_date + v.j_arr, 'YYYY-MM-DD'),
         'departure',          to_char(current_date + v.j_dep, 'YYYY-MM-DD'),
         'arrivalHour',        null,
         'firstName',          v.prenom,
         'lastName',           'Recette',
         'numAdult',           2,
         'numChild',           0,
         'source',             v.canal,
         'otaReservationCode', v.bid,
         'amount',             v.montant,
         'commission',         null,
         'currency',           'EUR'
       )
  from _seed_ctx c,
       (values
         ('STG-RES-001', 'STG-BIEN-1', 'confirmed',  3,  6, 'Alice',  'airbnb',  420.00),
         ('STG-RES-002', 'STG-BIEN-1', 'confirmed', 12, 15, 'Bruno',  'booking', 385.00),
         ('STG-RES-003', 'STG-BIEN-2', 'confirmed',  1,  8, 'Chloe',  'direct',  980.00),
         ('STG-RES-004', 'STG-BIEN-2', 'cancelled', 20, 23, 'David',  'booking', 310.00)
       ) as v(bid, propid, statut, j_arr, j_dep, prenom, canal, montant);

commit;

-- ─── Controle ───────────────────────────────────────────────────────────────
select 'profils'   as objet, count(*) from public.profiles
union all select 'biens',        count(*) from public.properties
union all select 'reservations', count(*) from public.bookings_snapshot
union all select 'cles Stripe',  count(*) from public.stripe_accounts
union all select 'cles provider non nulles',
       count(*) from public.api_keys
        where api_key is not null or refresh_token is not null
           or brevo_api_key is not null or seam_api_key is not null
union all select 'canaux actifs (doit etre 0)',
       count(*) from public.api_keys
        where brevo_enabled or seam_enabled;
