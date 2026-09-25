-- Chantier V2, lot V2.3.3 : le calendrier de segments
-- du MARCHE (etape 1), stocke.
-- Cadrage : docs/kb/chantier-nouveau-bien.md §11, §13.
--
-- ⚠ LIGNES COURTES VOLONTAIRES (collage manuel, < 60).
--
-- ADDITIVE ET SUPPRIMABLE : une table neuve, V2. Elle
-- ne touche aucune table existante, n'a aucune cle
-- etrangere vers elles, et aucun code de l'existant ne
-- la lit. `drop table public.marche_calendrier` et
-- l'app tourne exactement comme avant (garantie de
-- suppression, frontiere V2).
--
-- PAR MARCHE, PAS PAR LOGEMENT : deux logements de
-- Bagneres partagent la meme etude (cache par zone).
--
-- AUCUN PRIX : saisons, ruptures, regimes, causes,
-- evenements possibles (a LIRE), ecart week-end en
-- pourcentage. Rien ne la lit pour tarifer.
--
-- Writer unique : lib/marche/calendrier-marche.js.

create table if not exists public.marche_calendrier (
  id bigint generated always as identity primary key,
  -- Le marche AirROI, tel que markets/lookup le rend.
  pays text not null,
  region text not null,
  localite text not null,
  -- La date de CAPTURE du pacing : le calendrier
  -- regarde devant elle, il change avec elle.
  capture_le date not null,
  calcule_le timestamptz not null default now(),
  source text not null default 'marche'
    check (source = 'marche'),
  statut text not null check (statut in (
    'calcule', 'non_calculable')),
  motif text,
  fenetre_debut date,
  fenetre_fin date,
  horizon_fin date,
  -- Deux regimes, jamais une echelle (regle §13).
  regimes jsonb,
  saisons jsonb,
  ruptures jsonb,
  au_dela jsonb,
  -- Explication (V2.3.2) : pics, evenements POSSIBLES
  -- (a lire, jamais ecrits ailleurs), ecart week-end.
  pics jsonb,
  evenements_possibles jsonb,
  ecart_semaine_week_end jsonb,
  couverture_calendrier jsonb,
  limites jsonb,
  -- Version de la methode : un recalcul apres un
  -- changement de regle se distingue d'un recalcul.
  methode text not null,
  unique (pays, region, localite, capture_le, methode)
);
comment on table public.marche_calendrier is
  'V2.3 : calendrier de segments du marche. '
  'Information parallele, aucun prix, lue par '
  'aucun moteur. Supprimable sans effet.';

-- ─── RLS : SERVEUR SEULEMENT ────────────────────────────
alter table public.marche_calendrier
  enable row level security;
revoke all on table public.marche_calendrier
  from anon, authenticated;
revoke all on sequence
  public.marche_calendrier_id_seq
  from anon, authenticated;

-- Verification : PAS dans l'editeur (regle du
-- 25/09/2026). Seul le script la fait, empreinte
-- en tete : scripts/verifier-migration-marche.js
