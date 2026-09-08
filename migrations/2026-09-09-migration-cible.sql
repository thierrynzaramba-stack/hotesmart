-- Assistant de migration : l'identifiant CIBLE.
-- Spec : docs/specs/spec-assistant-migration.md
--
-- ⚠ LIGNES COURTES VOLONTAIRES.
--
-- ADDITIVE : une colonne nullable sur `properties`.
--
-- POURQUOI UNE COLONNE SEPAREE, ET PAS provider_property_id :
-- `provider_property_id` est la CLE de toutes les tables
-- enfants — bookings_snapshot, menages, messages, codes
-- d'acces, conversations : 4 274 lignes pour les deux biens
-- de Bagneres. L'ecraser au moment du provisionnement
-- couperait le bien de tout son historique, avant meme que
-- la bascule ait commence.
--
-- Le provisionnement pose donc l'identifiant Channex ICI.
-- Le re-keying (phase 2.8 du plan de bascule) le promeut
-- ensuite en `provider_property_id`, EN MEME TEMPS qu'il
-- deplace les 14 tables enfants — un seul geste, ou rien.
--
-- Un bien a moitie migre — provider qui dit Channex, tables
-- enfants qui disent Beds24 — est l'etat le plus dangereux
-- du chantier. Cette colonne existe pour qu'il ne puisse pas
-- se produire.

alter table public.properties
  add column if not exists
  migration_target_property_id text;

alter table public.properties
  add column if not exists
  migration_target_at timestamptz;

-- Deux biens ne peuvent pas viser la meme propriete cible :
-- ce serait deux calendriers pousses au meme endroit.

create unique index if not exists
  properties_migration_target_unique
  on public.properties (migration_target_property_id)
  where migration_target_property_id is not null;
