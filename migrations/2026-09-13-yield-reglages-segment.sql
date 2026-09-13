-- Etape 4 de YieldFlow : les REGLAGES DE SEGMENT.
-- Spec : docs/specs/spec-yieldflow-v1.md §6 quater
-- Verification : node scripts/verifier-yield-reglages.js
--
-- ⚠ LIGNES COURTES VOLONTAIRES : l'editeur SQL de Supabase
-- tronque les lignes longues au copier-coller.
--
-- A QUOI CA SERT. Le moteur POSITIONNE chaque contexte sur
-- la grille du bien, en mesurant la mediane de ses nuits
-- passees. C'est un calcul, donc une estimation. L'hote,
-- lui, SAIT. S'il place la Toussaint a « Haut » quand le
-- calcul dit « Moyen », c'est lui qui a raison : il
-- connait une demande que son historique ne montre pas
-- encore.
--
-- ⚠ L'AJUSTEMENT DE L'HOTE EST PRIORITAIRE SUR LE CALCUL.
-- C'est une DONNEE, pas une preference d'affichage : elle
-- change le prix suggere. Elle porte donc sa trace
-- (`created_at`, `updated_at`) et reste visible a l'ecran,
-- pour qu'un niveau surprenant s'explique par elle plutot
-- que de passer pour une erreur du moteur.
--
-- ⚠ UNE SEULE TABLE POUR DEUX REGLAGES, ET C'EST VOULU.
-- « Ou se positionne ce contexte » et « ce contexte
-- compte-t-il pour ce bien » sont deux reponses a la meme
-- question : ce que l'hote decide d'un segment. Deux
-- tables auraient fait deux writers et deux lectures a
-- tenir d'accord.
--
-- ADDITIVE : cree une table, ne touche a aucune existante.

create table if not exists public.yield_segment_reglages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,

  -- UUID : table ecrite par NOUS, pas par la couche sync.
  property_id uuid not null
    references public.properties(id) on delete cascade,

  -- La cle du contexte, telle que le moteur la nomme :
  --   'ferie:toussaint'        un ferie precis
  --   'pont'                   tous les ponts
  --   'commercial:saint_valentin'
  --   'evenement:saison_thermale'
  --   'vacances_zone_du_bien'  toute la famille
  -- ⚠ TEXTE LIBRE ET NON CONTRAINT, deliberement : la
  -- liste des cles est CALCULEE par le moteur (feries,
  -- ponts, evenements), pas fixee ici. Une contrainte
  -- CHECK devrait etre migree a chaque nouveau ferie.
  segment text not null,

  -- Le niveau impose par l'hote, ou NULL = aucun
  -- ajustement (la ligne ne sert alors qu'a `actif`).
  niveau text,

  -- ⚠ ACTIF PAR DEFAUT. Une absence de ligne vaut
  -- « actif » : l'hote n'a rien a faire pour que les
  -- vacances et les feries comptent. Seule une
  -- desactivation EXPLICITE ecrit ici.
  actif boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint yield_reglages_segment_non_vide
    check (length(btrim(segment)) > 0),
  constraint yield_reglages_segment_court
    check (length(segment) <= 120),
  -- Les cinq niveaux de la grille, et rien d'autre. Ils ne
  -- bougent pas : c'est la nomenclature arbitree, gravee a
  -- la spec §7.3.
  constraint yield_reglages_niveau_connu
    check (niveau is null
           or niveau in ('Base', 'Moyen', 'Haut',
                         'Très haut', 'Exceptionnel'))
);

-- ⚠ UN SEUL REGLAGE PAR BIEN ET PAR SEGMENT. Sans cet
-- index, deux ajustements contradictoires cohabiteraient
-- et l'ordre de lecture deciderait du prix.
create unique index if not exists
  yield_reglages_unicite_idx
  on public.yield_segment_reglages
  (property_id, segment);

comment on table public.yield_segment_reglages is
  'Ce que l''hote decide d''un contexte de prix : a quel '
  'niveau il se positionne (prioritaire sur le calcul du '
  'moteur) et s''il compte pour ce bien. Une absence de '
  'ligne vaut « actif, position calculee ».';

comment on column public.yield_segment_reglages.niveau is
  'Niveau impose par l''hote, prioritaire sur la mediane '
  'mesuree. NULL = le moteur positionne lui-meme.';

-- ─── RLS ────────────────────────────────────────────────
-- Regle 5 : toute table neuve porte RLS des sa creation.
alter table public.yield_segment_reglages
  enable row level security;

-- ⚠ LECTURE SEULE POUR LE CLIENT, ET SUR SON SEUL COMPTE.
-- L'ecriture passe par l'endpoint, garde `reglages` : un
-- ajustement change le prix suggere, c'est le meme niveau
-- de consequence qu'un prix.
drop policy if exists yield_reglages_lecture
  on public.yield_segment_reglages;

create policy yield_reglages_lecture
  on public.yield_segment_reglages
  for select
  to authenticated
  using (user_id = auth.uid());
