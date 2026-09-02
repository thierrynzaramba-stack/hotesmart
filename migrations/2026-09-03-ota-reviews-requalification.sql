-- migrations/2026-09-03-ota-reviews-requalification.sql
-- Chantier AVIS, lot 8 — requalification humaine d'un verdict de proprete.
--
-- La classification se trompe : un avis elogieux mal lu, une remarque prise pour
-- un compliment. L'hote doit pouvoir corriger — et sa correction doit TENIR.
--
-- ⚠ L'AVIS N'EST JAMAIS SUPPRIME. Seul le verdict change. Un avis reste un fait,
-- et le faire disparaitre parce qu'on n'aime pas sa lecture automatique
-- reviendrait a effacer la parole du voyageur.
--
-- Rejouable. A EXECUTER dans l'editeur SQL Supabase.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. QUI A POSE LE VERDICT
-- ═══════════════════════════════════════════════════════════════════════════
-- Meme logique que le DO NOTHING des detections en messagerie : ce que le
-- modele dirait d'une seconde lecture n'a aucune valeur face a une decision
-- humaine deja prise.
alter table public.ota_reviews
  add column if not exists verdict_source text not null default 'auto';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ota_reviews_verdict_source_check') then
    alter table public.ota_reviews
      add constraint ota_reviews_verdict_source_check
      check (verdict_source in ('auto', 'humain'));
  end if;
end $$;

comment on column public.ota_reviews.verdict_source is
  'auto = verdict pose par la classification | humain = requalifie par l''hote. Un verdict humain n''est JAMAIS ecrase, ni par la classification ni par le trigger de reanalyse.';

-- Trace, utile pour comprendre une correction six mois plus tard.
alter table public.ota_reviews
  add column if not exists verdict_modifie_at timestamptz;
alter table public.ota_reviews
  add column if not exists verdict_modifie_par uuid;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. LE TRIGGER DE REANALYSE RESPECTE LE VERDICT HUMAIN
-- ═══════════════════════════════════════════════════════════════════════════
-- Sans cette garde, modifier le texte d'un avis — ce que fait le poll quand
-- l'hote repond ou que l'OTA corrige — effacait la requalification et renvoyait
-- l'avis a la file de classification, qui reposait son verdict automatique.
-- La correction humaine aurait tenu jusqu'au prochain poll, sans un mot.
create or replace function public.ota_reviews_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();

  -- Le texte du VOYAGEUR seul declenche la reanalyse ; `reply` en est exclu
  -- (quand l'hote repond, ce que le voyageur a dit ne change pas).
  --
  -- `is distinct from` et non `<>` : l'un des cotes peut etre NULL, et
  -- NULL <> 'x' vaut NULL donc faux — la reanalyse serait silencieusement
  -- sautee sur le cas le plus courant, un texte qui apparait la ou il n'y en
  -- avait pas.
  if (new.content         is distinct from old.content
   or new.content_public  is distinct from old.content_public
   or new.content_private is distinct from old.content_private)
   -- ⚠ ET le verdict n'a pas ete pose par un humain.
   and coalesce(new.verdict_source, 'auto') <> 'humain' then
    new.ai_analyzed_at   := null;
    new.ai_clean_verdict := null;
    new.ai_clean_excerpt := null;
  end if;

  return new;
end;
$$;

drop trigger if exists ota_reviews_touch_trg on public.ota_reviews;
create trigger ota_reviews_touch_trg
  before update on public.ota_reviews
  for each row execute function public.ota_reviews_touch();

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. INDEX
-- ═══════════════════════════════════════════════════════════════════════════
-- La file de classification exclut desormais les verdicts humains : l'index
-- partiel existant (ai_analyzed_at is null) suffit, mais celui-ci sert la
-- question « qu'est-ce que l'hote a corrige ? », utile au reglage du prompt.
create index if not exists ota_reviews_requalifies_idx
  on public.ota_reviews (user_id, verdict_modifie_at desc)
  where verdict_source = 'humain';

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════
-- Attendu : les trois colonnes a 1, le CHECK a 1, les 168 lignes existantes
-- toutes en 'auto', et le corps du trigger contenant bien 'humain'.
select
  (select count(*) from information_schema.columns
     where table_name='ota_reviews' and column_name='verdict_source')       as col_source,
  (select count(*) from information_schema.columns
     where table_name='ota_reviews' and column_name='verdict_modifie_at')   as col_date,
  (select count(*) from information_schema.columns
     where table_name='ota_reviews' and column_name='verdict_modifie_par')  as col_par,
  (select count(*) from pg_constraint
     where conname='ota_reviews_verdict_source_check')                      as check_source,
  (select count(*) from public.ota_reviews where verdict_source='auto')     as lignes_auto,
  (select count(*) from pg_proc
     where proname='ota_reviews_touch' and prosrc like '%humain%')          as trigger_a_jour;
