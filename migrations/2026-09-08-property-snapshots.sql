-- Etape 1B : rapatriement des FICHES DE BIEN
-- Le payload provider integral d'une propriete, tel quel.
-- Spec  : docs/specs/spec-migration-channex.md (volet 1B)
-- Pourquoi : docs/kb/coeur-de-donnees.md
-- Verification : node scripts/backfill-fiches.js
--
-- ⚠ LIGNES COURTES VOLONTAIRES : le copier-coller vers
-- l'editeur SQL de Supabase tronque les lignes longues
-- (constate 3 fois).
--
-- ADDITIVE : cree une table, ne touche a aucune existante.
--
-- POURQUOI UNE TABLE ET PAS UNE COLONNE SUR `properties` :
-- `properties` est la table la plus lue du produit, et le
-- code fait des `select('*')` un peu partout. Y coller un
-- jsonb de plusieurs dizaines de Ko alourdirait TOUTES ces
-- lectures, y compris celles qui n'ont que faire du brut.
-- Le brut vit donc a cote, comme `bookings_snapshot.raw`
-- vit a cote des colonnes normalisees.
--
-- MEME FORME QUE `bookings_snapshot`, ET C'EST DELIBERE :
-- un payload brut, une empreinte pour savoir s'il a bouge
-- sans le rapatrier, un writer unique. La lecon est acquise,
-- on ne la reapprend pas.

create table if not exists public.property_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  provider text not null,

  -- ⚠ TEXT, pas UUID : c'est le `provider_property_id`,
  -- comme toutes les tables enfants (regle 10). Beds24 sert
  -- un entier ("209413"), Channex un uuid textuel — les deux
  -- tiennent dans du TEXT, aucun ne tient dans du uuid.
  property_id text not null,

  -- Le payload provider INTEGRAL, jamais elague. Ce qu'on ne
  -- sait pas encore lire aujourd'hui doit rester lisible
  -- demain : c'est tout l'objet de ce rapatriement.
  raw jsonb not null,

  -- Empreinte stable du payload, pour savoir s'il a change
  -- sans rapatrier des dizaines de Ko a chaque cycle.
  raw_hash text not null,

  -- Quand le provider a repondu. Distinct de updated_at, qui
  -- ne bouge que si le CONTENU a change : un rafraichissement
  -- identique met a jour fetched_at, pas updated_at.
  fetched_at timestamptz not null default now(),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Une seule ligne par bien et par provider. Deux lignes
-- rendraient la source non deterministe — le defaut exact
-- de la dette « double writer Beds24 ».

create unique index if not exists
  property_snapshots_bien_unique
  on public.property_snapshots
  (user_id, provider, property_id);

create index if not exists
  property_snapshots_user
  on public.property_snapshots (user_id);

-- RLS : ferme. Ce brut porte des donnees de compte provider
-- (emails, telephones, reglages de passerelle de paiement,
-- identifiants de webhook). Aucune app ne le lit en direct :
-- la fiche unifiee (etape 2) lit `properties`, pas ceci.
-- Le brut est un filet de securite et une source de
-- remplissage, pas une surface d'API.

alter table public.property_snapshots
  enable row level security;

drop policy if exists property_snapshots_service_only
  on public.property_snapshots;

create policy property_snapshots_service_only
  on public.property_snapshots
  for all to authenticated
  using (false) with check (false);
