-- 2026-10-02-avis-auto-validation-par-bien.sql
-- Decision de Thierry du 2 octobre 2026 au soir (option A) :
-- la publication automatique se regle BIEN PAR BIEN.
-- Spec : docs/specs/spec-evaluation-voyageur.md §10 bis.
--
-- Une ligne par bien active ; pas de ligne = desactivee.
-- Writer unique : api/avis.js (auto-validation-maj).
-- avis_config.auto_validation_heures n'est plus lu.
--
-- ⚠ LIGNES COURTES (editeur Supabase). Rejouable.
-- Aucun SELECT de verification (regle du 25 septembre) :
--   scripts/verifier-auto-validation.js
-- Ordre : APRES 2026-10-02-avis-texte-sans-voyageur.sql.

create table if not exists
  public.avis_auto_validation (
  user_id uuid not null
    references auth.users(id) on delete cascade,
  property_id uuid not null
    references public.properties(id)
    on delete cascade,
  heures integer not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, property_id),
  constraint avis_auto_validation_heures_check
    check (heures between 1 and 336)
);

drop trigger if exists avis_auto_validation_touch_trg
  on public.avis_auto_validation;
create trigger avis_auto_validation_touch_trg
  before update on public.avis_auto_validation
  for each row
  execute function public.set_updated_at();

alter table public.avis_auto_validation
  enable row level security;
drop policy if exists avis_auto_validation_select
  on public.avis_auto_validation;
create policy avis_auto_validation_select
  on public.avis_auto_validation
  for select to authenticated
  using (can_read(user_id, 'avis', property_id));
revoke insert, update, delete
  on table public.avis_auto_validation
  from anon, authenticated;

notify pgrst, 'reload schema';
