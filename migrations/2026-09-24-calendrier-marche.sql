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

-- ─── Verification (a coller aussi) ──────────────────────
-- EMPREINTE : biens = 5 en production, 3 en staging.
-- ⚠ `create table if not exists` REUSSIT EN SILENCE si
-- une table du meme nom existe deja sous une autre
-- forme : `colonnes` et `unicite` prouvent la FORME
-- (controles ajoutes par Thierry, 24 septembre 2026).
select
  (select count(*) from public.properties)
    as biens,
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
     and c.relname = 'marche_calendrier'
     and c.relrowsecurity)
    as rls,
  (select count(*) from pg_policies
     where schemaname = 'public'
     and tablename = 'marche_calendrier')
    as policies,
  (has_table_privilege('anon',
     'public.marche_calendrier',
     'select,insert,update,delete')
   or has_table_privilege('authenticated',
     'public.marche_calendrier',
     'select,insert,update,delete'))
    as acces_client,
  (select count(*) from pg_constraint
     where conrelid =
       'public.marche_calendrier'::regclass
     and contype = 'f')
    as cles_etrangeres,
  (select count(*) from information_schema.columns
     where table_schema = 'public'
     and table_name = 'marche_calendrier')
    as colonnes,
  (select count(*) from pg_constraint
     where conrelid =
       'public.marche_calendrier'::regclass
     and contype = 'u')
    as unicite,
  (select count(*) from public.marche_calendrier)
    as lignes;
-- Attendu : biens 5 (prod) ou 3 (staging), rls 1,
-- policies 0, acces_client false,
-- cles_etrangeres 0, colonnes 22, unicite 1,
-- lignes 0.
