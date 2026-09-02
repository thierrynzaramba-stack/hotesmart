-- migrations/2026-09-02-ota-reviews-manuel.sql
-- Chantier AVIS, lot 5 — avis recus EN DIRECT (SMS, email, oral).
--
-- Ils entrent dans ota_reviews comme les autres : meme table, meme cloisonnement,
-- meme classification. C'est la regle du coeur (CLAUDE.md) — une donnee ne vit
-- pas dans un coin parce qu'elle vient d'ailleurs. La fiche prestataire et le
-- futur pricing liront une seule table.
--
-- Rejouable. A EXECUTER dans l'editeur SQL Supabase.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. `manuel` devient un provider a part entiere
-- ═══════════════════════════════════════════════════════════════════════════
-- Le CHECK est nomme automatiquement par Postgres a la creation ; on le retrouve
-- par son role plutot que par un nom devine.
do $$
declare nom text;
begin
  select con.conname into nom
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  where rel.relname = 'ota_reviews'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%provider%channex%';
  if nom is not null then
    execute format('alter table public.ota_reviews drop constraint %I', nom);
  end if;
end $$;

alter table public.ota_reviews
  add constraint ota_reviews_provider_check
  check (provider in ('channex', 'beds24', 'manuel'));

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Par quel canal l'avis est arrive
-- ═══════════════════════════════════════════════════════════════════════════
-- Ne concerne que les avis saisis a la main : un avis Channex n'a pas de
-- `source`. La contrainte l'exige donc pour 'manuel' et l'interdit ailleurs,
-- pour qu'aucune ligne ne puisse mentir sur son origine.
alter table public.ota_reviews
  add column if not exists source text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ota_reviews_source_check') then
    alter table public.ota_reviews
      add constraint ota_reviews_source_check check (
        (provider = 'manuel' and source in ('sms', 'email', 'oral'))
        or (provider <> 'manuel' and source is null)
      );
  end if;
end $$;

comment on column public.ota_reviews.source is
  'Canal de reception, avis saisis a la main uniquement : sms | email | oral. NULL pour les avis provider.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════
select
  (select count(*) from information_schema.columns
     where table_name = 'ota_reviews' and column_name = 'source')          as colonne_source,
  (select pg_get_constraintdef(oid) from pg_constraint
     where conname = 'ota_reviews_provider_check')                         as check_provider,
  (select count(*) from pg_constraint
     where conname = 'ota_reviews_source_check')                           as check_source;
