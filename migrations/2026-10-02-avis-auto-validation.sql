-- migrations/2026-10-02-avis-auto-validation.sql
-- Demandes de Thierry du 2 octobre 2026.
-- Spec : docs/specs/spec-evaluation-voyageur.md
--        §9 bis (naissance au depart), §10 bis
--        (auto-validation).
--
-- ⚠ LIGNES COURTES VOLONTAIRES (editeur Supabase).
-- Rejouable. Aucun SELECT de verification ici
-- (regle du 25 septembre 2026) :
--   node --env-file=<env> \
--     scripts/verifier-auto-validation.js
--
-- Ordre : APRES 2026-10-02-avis-index-relances.sql.

-- ─── Le reglage de l'hote ───────────────────────────
-- Nul = desactivee. En heures. Plafonne a 14 jours :
-- au-dela, l'echeance d'Airbnb serait passee.
alter table public.avis_config
  add column if not exists auto_validation_heures
  integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'avis_config_auto_validation_check'
  ) then
    alter table public.avis_config
      add constraint avis_config_auto_validation_check
      check (auto_validation_heures is null
             or auto_validation_heures
                between 1 and 336);
  end if;
end $$;

-- ─── L'echeance de la publication automatique ───────
-- Posee quand la prestataire a fini sa part,
-- remise a nul a la premiere reaction de l'hote.
alter table public.guest_evaluations
  add column if not exists auto_publier_le
  timestamptz;

-- La file de l'auto-validation : tous les comptes,
-- depuis le cron. Partiel : seules les evaluations
-- programmees y sont. Meme exception a la regle du
-- prefixe user_id que le dispatcher.
create index if not exists
  guest_evaluations_auto_publier_idx
  on public.guest_evaluations (auto_publier_le)
  where auto_publier_le is not null;

-- ─── Les departs du jour (naissance, §9 bis) ────────
-- `menages` porte un depart par reservation, pour
-- tous les comptes. Les index existants commencent
-- par user_id : celui-ci sert la lecture des departs
-- d'un jour, tous comptes, depuis le cron.
create index if not exists menages_depart_idx
  on public.menages (departure_date);

comment on column
  public.avis_config.auto_validation_heures is
  'Auto-validation : publier apres N heures sans '
  'reaction de l hote. Nul = desactivee. Spec §10 bis.';
comment on column
  public.guest_evaluations.auto_publier_le is
  'Publication automatique programmee (spec §10 bis). '
  'Nul = rien de programme.';
