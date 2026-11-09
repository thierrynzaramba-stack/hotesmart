-- Lot 2 « Ce qui fait bouger vos prix » — LE REGLAGE
-- PAR POSITION DANS UN EVENEMENT.
-- Spec : docs/specs/spec-yf-reglages-position.md
-- Decision 8 du registre (30 octobre 2026) : un
-- reglage se memorise en POSITION, jamais en date —
-- c'est ce qui le reconduit l'annee suivante.
-- Thierry, 5 novembre 2026 : « pouvoir regler chaque
-- jour separement ».
-- Writer : lib/yield/reglages-position.js (les deux
-- tables) ; lib/yield/reglages-segment.js (les deux
-- colonnes de yield_segment_reglages).
--
-- ⚠ LIGNES COURTES VOLONTAIRES (< 60 caracteres) : ce
-- SQL se colle a la main dans l'editeur Supabase.
-- ⚠ AUCUNE REQUETE DE VERIFICATION ICI : on ne colle
-- que la migration ; la verification passe par un
-- script (scripts/verifier-migration-reglages-
-- position.js, ecrit a l'etape 2a).
--
-- ADDITIVE : cree deux tables, ajoute deux colonnes
-- nullables a yield_segment_reglages. Rien n'est
-- reecrit, aucune ligne existante ne change.

-- ─── 1. Les positions reglees ─────────────────────────
-- Une ligne = une position d'un evenement, reglee par
-- l'hote. AUCUNE DATE : la ligne cherche sa nuit
-- chaque annee.
--   evenement : la cle de reglage la plus fine,
--               stable d'une annee sur l'autre
--               (vacances_zone_du_bien:noel,
--               ferie:armistice_1918,
--               commercial:saint_valentin...)
--   zone      : evenement | avant | apres
--   rang      : n-ieme <jour> de l'evenement, ou
--               k-ieme week-end avant/apres.
--               NULL = tous.
--   jour      : lundi..dimanche. NULL = tous.
--   nuit      : date | samedi_rattache — dates
--               fixes seulement (feries, dates
--               commerciales).
--   niveau    : les cinq niveaux, ou 'calcul' (la
--               nuit est rendue au calcul et masque
--               une ligne plus large). NULL reserve
--               au lot 3 (une ligne qui ne porterait
--               qu'une restriction de sejour).
create table if not exists
  public.yield_reglages_position (
  id uuid primary key
    default gen_random_uuid(),
  user_id uuid not null,
  property_id uuid not null
    references public.properties(id)
    on delete cascade,
  evenement text not null,
  zone text not null,
  rang smallint,
  jour text,
  nuit text,
  niveau text,
  created_at timestamptz not null
    default now(),
  updated_at timestamptz not null
    default now(),
  constraint yrp_evenement_non_vide
    check (length(btrim(evenement)) > 0),
  constraint yrp_evenement_court
    check (length(evenement) <= 120),
  constraint yrp_zone_connue
    check (zone in ('evenement',
                    'avant', 'apres')),
  constraint yrp_jour_connu
    check (jour is null or jour in (
      'lundi', 'mardi', 'mercredi',
      'jeudi', 'vendredi', 'samedi',
      'dimanche')),
  constraint yrp_nuit_connue
    check (nuit is null or nuit in (
      'date', 'samedi_rattache')),
  constraint yrp_niveau_connu
    check (niveau is null or niveau in (
      'Base', 'Moyen', 'Haut',
      'Très haut', 'Exceptionnel',
      'calcul')),
  -- Le rang : jusqu'a 60 dans l'evenement (une
  -- saison de cinq mois compte 22 samedis), 1 a 4
  -- dans le rayonnement (la largeur maximale).
  constraint yrp_rang_borne
    check (rang is null
      or (zone = 'evenement'
          and rang between 1 and 60)
      or (zone in ('avant', 'apres')
          and rang between 1 and 4)),
  -- Le rayonnement ne porte que des NUITS de
  -- week-end : vendredi et samedi (registre §3 ;
  -- jamais le estWeekEnd du moteur).
  constraint yrp_rayonnement_ven_sam
    check (zone = 'evenement'
      or jour is null
      or jour in ('vendredi', 'samedi')),
  -- Dans l'evenement, un rang sans jour ne designe
  -- rien : « le 2e » quoi ?
  constraint yrp_rang_avec_jour
    check (zone <> 'evenement'
      or rang is null
      or jour is not null),
  -- `nuit` exclut rang et jour, et ne vit que dans
  -- l'evenement.
  constraint yrp_nuit_seule
    check (nuit is null
      or (zone = 'evenement'
          and rang is null
          and jour is null)),
  -- Une date fixe se designe par sa nuit, jamais
  -- par un jour de semaine : le reveillon est un
  -- jeudi en 2026, un vendredi en 2027.
  constraint yrp_date_fixe_sans_jour
    check (zone <> 'evenement'
      or jour is null
      or evenement !~ '^(ferie|commercial):'),
  -- Et une periode n'a pas de « nuit de la date ».
  constraint yrp_nuit_date_fixe
    check (nuit is null
      or evenement ~ '^(ferie|commercial):'),
  -- Le samedi rattache n'existe que pour les dates
  -- commerciales (lib/yield/dates-commerciales.js).
  constraint yrp_samedi_rattache_commercial
    check (nuit is distinct from
             'samedi_rattache'
      or evenement ~ '^commercial:')
);

-- Une position par bien et par evenement. Les NULL
-- comptent comme une valeur (« tous ») : coalesce,
-- pour ne pas dependre de NULLS NOT DISTINCT.
create unique index if not exists
  yrp_unicite_idx
  on public.yield_reglages_position (
    property_id, evenement, zone,
    coalesce(rang, 0),
    coalesce(jour, ''),
    coalesce(nuit, ''));

comment on table public.yield_reglages_position is
  'Reglages de l''hote par POSITION dans un '
  'evenement (n-ieme jour, nuit de la date, k-ieme '
  'week-end avant/apres). Aucune date : la ligne '
  'cherche sa nuit chaque annee ; sans cible, elle '
  'est signalee, jamais deplacee.';
comment on column
  public.yield_reglages_position.niveau is
  'Niveau ABSOLU impose par l''hote pour la nuit. '
  '''calcul'' = rendue au calcul (masque une ligne '
  'plus large). NULL reserve au lot 3.';

alter table public.yield_reglages_position
  enable row level security;
drop policy if exists yrp_lecture
  on public.yield_reglages_position;
create policy yrp_lecture
  on public.yield_reglages_position
  for select to authenticated
  using (user_id = auth.uid());
revoke insert, update, delete
  on table public.yield_reglages_position
  from anon, authenticated;

-- ─── 2. Le journal des gestes ─────────────────────────
-- Chaque geste de l'hote, avec le niveau d'avant et
-- ce que YieldFlow RECOMMANDAIT pour les nuits visees
-- au moment du geste (meme exigence que
-- grille_hote.recommended_rate_cents, decision de
-- Thierry du 30 septembre 2026). `recommandes` :
-- { "2026-12-26": "Haut", ... } — un objet, parce
-- qu'une ligne joker vise plusieurs nuits.
create table if not exists
  public.yield_reglages_position_journal (
  id bigint generated always as identity
    primary key,
  user_id uuid not null,
  property_id uuid not null
    references public.properties(id)
    on delete cascade,
  evenement text not null,
  zone text not null,
  rang smallint,
  jour text,
  nuit text,
  geste text not null check (geste in (
    'posee', 'remplacee', 'retiree')),
  niveau text,
  niveau_avant text,
  recommandes jsonb,
  created_at timestamptz not null
    default now()
);
create index if not exists yrpj_bien_idx
  on public.yield_reglages_position_journal
  (property_id, created_at);

alter table
  public.yield_reglages_position_journal
  enable row level security;
drop policy if exists yrpj_lecture
  on public.yield_reglages_position_journal;
create policy yrpj_lecture
  on public.yield_reglages_position_journal
  for select to authenticated
  using (user_id = auth.uid());
revoke insert, update, delete
  on table
  public.yield_reglages_position_journal
  from anon, authenticated;

-- ─── 3. La largeur de la zone d'influence ─────────────
-- Un reglage de l'EVENEMENT, pas d'une nuit : il va
-- avec crans et actif. NULL = par defaut (0 tant que
-- le rayonnement automatique n'existe pas).
alter table public.yield_segment_reglages
  add column if not exists
  weekends_avant smallint;
alter table public.yield_segment_reglages
  add column if not exists
  weekends_apres smallint;
alter table public.yield_segment_reglages
  drop constraint if exists
  yield_reglages_weekends_bornes;
alter table public.yield_segment_reglages
  add constraint
  yield_reglages_weekends_bornes
  check ((weekends_avant is null
          or weekends_avant between 0 and 4)
     and (weekends_apres is null
          or weekends_apres between 0 and 4));
comment on column
  public.yield_segment_reglages.weekends_avant is
  'Nombre de week-ends AVANT l''evenement dans sa '
  'zone d''influence (0 a 4). NULL = par defaut.';
comment on column
  public.yield_segment_reglages.weekends_apres is
  'Nombre de week-ends APRES l''evenement dans sa '
  'zone d''influence (0 a 4). NULL = par defaut.';
