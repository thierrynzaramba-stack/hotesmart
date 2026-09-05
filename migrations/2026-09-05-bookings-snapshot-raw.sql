-- migrations/2026-09-05-bookings-snapshot-raw.sql
-- Sous-chantier A du chantier « historique des reservations »
-- (docs/specs/spec-historique-reservations.md §4).
--
-- POURQUOI
-- Le writer ne conserve que 14 champs normalises (266 octets en moyenne). Le
-- payload provider, lui, porte 71 champs cote Beds24 (1 755 o) et 33 cote Channex
-- (5 995 o) : invoiceItems, bookingTime, cancelTime, days_breakdown, services,
-- ota_commission, notes de payout... Tout cela est aujourd'hui jete a l'ecriture.
-- Le pricing, les avis et les stats en auront besoin, et une donnee non collectee
-- au moment ou le provider la sert ne se rattrape pas.
--
-- ADDITIVE ET SANS RISQUE : colonne nullable, aucun defaut, aucune contrainte.
-- Le code actuel (qui ignore `raw`) continue de fonctionner a l'identique.
-- A APPLIQUER AVANT le deploiement du writer etendu : sinon l'upsert portant
-- `raw` echouerait et plus aucun snapshot ne serait ecrit.

alter table public.bookings_snapshot
  add column if not exists raw jsonb;

-- Empreinte du payload, pour savoir s'il a bouge SANS le rapatrier.
-- Sans elle, le prefetch du writer relit `raw` a chaque cycle */5 : jusqu'a
-- 1,2 Mo par requete cote Channex (200 lignes x ~6 Ko) et ~350 Ko cote Beds24,
-- toutes les 5 minutes, pour une simple comparaison d'egalite.
alter table public.bookings_snapshot
  add column if not exists raw_hash text;

comment on column public.bookings_snapshot.raw is
  'Payload provider integral, tel que servi (Beds24 GET /bookings avec invoiceItems, '
  'Channex GET /bookings attributes). Ecrit par le seul writer lib/bookings-snapshot.js. '
  'JAMAIS compare pour decider d''un evenement : la detection porte sur le snapshot '
  'normalise uniquement (spec §4). Une mise a jour du seul raw ne touche pas updated_at.';

comment on column public.bookings_snapshot.raw_hash is
  'sha256 de la forme stable (cles triees) du payload ci-dessus. Permet au writer '
  'de detecter un changement de raw sans relire la colonne. Ecrit avec raw, jamais seul.';

-- ─── Verification ───────────────────────────────────────────────────────────
select
  (select count(*) from public.bookings_snapshot)                       as lignes_total,
  (select count(*) from public.bookings_snapshot where raw is not null) as lignes_avec_raw,
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'bookings_snapshot'
       and column_name = 'raw' and data_type = 'jsonb')                 as colonne_raw_jsonb,
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'bookings_snapshot'
       and column_name = 'raw_hash')                                    as colonne_raw_hash;
