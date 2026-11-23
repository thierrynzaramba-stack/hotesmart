-- Acces YieldFlow depuis le Calendrier : l'index du
-- comptage « N prix ajustes cette semaine ».
-- 28 octobre 2026, voie A tranchee par Thierry.
-- Lignes < 60 car. : collage manuel.
--
-- ADDITIVE ET REVERSIBLE : un index, rien d'autre.
-- Aucune colonne, aucune donnee, aucun droit touche.
--
-- Le POURQUOI (voie A, pas d'index partiel, pourquoi
-- l'index existant ne suffit pas) est dans
-- docs/specs/spec-yf-bouton-calendrier.md.
--
-- ⚠ `create index if not exists` sur un index qui
-- existe deja REUSSIT EN SILENCE sans changer sa
-- definition : on supprime avant de recreer.
--
-- Verification : node scripts/verifier-index-price-log.js

drop index if exists
  public.price_display_log_source_idx;

create index price_display_log_source_idx
  on public.price_display_log
     (property_id, source, created_at);

comment on index
  public.price_display_log_source_idx is
'Comptage par bien, par source et par anciennete.
Menu YieldFlow du calendrier : source ''engine'' sur
7 jours, compte AU CLIC, sur un seul bien.';
