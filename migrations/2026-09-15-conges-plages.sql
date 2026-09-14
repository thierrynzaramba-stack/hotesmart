-- Lot ergonomie disponibilites — point 2 : LES CONGES SONT DES PLAGES.
-- Spec : docs/specs/spec-prestataires-menage.md (§ disponibilites)
-- Doc : docs/kb/menage.md (MEME COMMIT)
--
-- ⚠ LIGNES COURTES VOLONTAIRES : l'editeur SQL de Supabase
-- tronque les lignes longues au copier-coller.
--
-- ═══════════════════════════════════════════════════════════
-- POURQUOI UNE TABLE, ET PAS DES LIGNES DANS L'EXISTANT
-- ═══════════════════════════════════════════════════════════
-- `provider_availability_exceptions` porte UNE DATE et un
-- booleen : c'est le bon outil pour « pas ce samedi-la ».
-- Un conge, lui, est une PLAGE qu'on supprime d'un geste.
-- Stocke en huit lignes isolees, plus rien ne dit qu'elles
-- formaient un conge : ni lesquelles verrouiller a l'ecran,
-- ni quoi supprimer ensemble quand l'hote clique
-- « supprimer ». On recreerait a la main un regroupement que
-- la base sait tenir.
--
-- ⚠ ET LES DEUX COEXISTENT, ce n'est pas un remplacement.
-- Precedence gravee (validee le 15 septembre 2026) :
--   1. un CONGE couvre le jour      -> absente, VERROUILLE
--   2. une EXCEPTION pour ce jour   -> ce qu'elle dit
--   3. une REGLE couvre le jour     -> disponible
--   4. AUCUNE regle                 -> disponible
-- Les etages 2, 3 et 4 sont le comportement actuel, inchange
-- (lib/cleaning/availability.js). On ajoute un etage AU-DESSUS.

-- ═══════════════════════════════════════════════════════════
-- 1. LA TABLE
-- ═══════════════════════════════════════════════════════════
create table if not exists public.conges_plages (
  id          uuid primary key default gen_random_uuid(),

  -- ⚠ `user_id` N'EST PAS FACULTATIF, meme si `provider_id`
  -- suffirait a retrouver le compte. REVIEW.md regle 1 :
  -- l'isolation multi-comptes ne doit dependre d'aucune
  -- jointure. C'est aussi ce que lisent les policies RLS
  -- ci-dessous, et ce que porte chaque table soeur.
  user_id     uuid not null references auth.users(id) on delete cascade,
  provider_id uuid not null references public.profiles(id) on delete cascade,

  -- ⚠ Des DATES de calendrier, pas des instants — et bornes
  -- INCLUSIVES des deux cotes, comme `prestataire_periodes`.
  -- Le code normalise a midi UTC : a minuit, le moindre
  -- decalage de fuseau fait basculer le jour. Piege deja
  -- corrige deux fois dans ce depot.
  debut       date not null,
  fin         date not null,

  motif       text,

  -- Qui l'a pose. Meme vocabulaire que les exceptions, pour
  -- que l'ecran dise « posé par vous » ou « déclaré par elle »
  -- sans traduire d'une table a l'autre.
  source      text not null default 'prestataire'
              check (source in ('prestataire', 'hote')),

  created_at  timestamptz not null default now(),

  -- Un conge qui finit avant de commencer n'a pas de sens.
  constraint conges_plages_bornes check (debut <= fin)
);

-- ⚠ AUCUNE CONTRAINTE D'ANTI-CHEVAUCHEMENT, et c'est reflechi.
-- Deux conges qui se recouvrent ne sont pas une incoherence :
-- la disponibilite est une UNION, et supprimer l'un laisse
-- l'autre verrouiller ses jours — ce qui est le comportement
-- juste. Une contrainte `EXCLUDE` exigerait `btree_gist` et
-- ferait echouer une saisie parfaitement legitime (prolonger
-- un conge en en posant un second par-dessus).
create index if not exists conges_plages_idx
  on public.conges_plages (user_id, provider_id, debut, fin);

comment on table public.conges_plages is
  'Conges en PLAGE. Priment sur les exceptions et les regles. '
  'Verrouillent les jours couverts dans le calendrier.';

-- ═══════════════════════════════════════════════════════════
-- 2. RLS — domaine `prestataires`
-- ═══════════════════════════════════════════════════════════
-- ⚠ Meme garde que les tables soeurs : les conges d'une
-- personne relevent de sa GESTION, pas de la consultation du
-- planning. Un membre `menages: read` voit les menages ; il
-- n'a pas a savoir quand une prestataire est en vacances.
alter table public.conges_plages enable row level security;

drop policy if exists conges_plages_select on public.conges_plages;
create policy conges_plages_select on public.conges_plages
  for select to authenticated using (can_read(user_id, 'prestataires'));

drop policy if exists conges_plages_write on public.conges_plages;
create policy conges_plages_write on public.conges_plages
  for all to authenticated
  using (can_write(user_id, 'prestataires'))
  with check (can_write(user_id, 'prestataires'));

-- ⚠ La PWA prestataire n'a PAS de session : elle pose ses
-- conges par un endpoint serveur en service key, garde par
-- son jeton ET par `self_availability`. Aucune policy ne lui
-- est destinee ici — c'est deja la regle des exceptions.

-- ═══════════════════════════════════════════════════════════
-- 3. VERIFICATION
-- ═══════════════════════════════════════════════════════════
-- Attendu : table vide (aucun conge ne preexiste), RLS
-- active, deux policies.
select
  (select count(*) from public.conges_plages) as conges,
  (select relrowsecurity
     from pg_class
    where oid = 'public.conges_plages'::regclass) as rls_active,
  (select count(*)
     from pg_policies
    where schemaname = 'public'
      and tablename = 'conges_plages') as policies;
-- attendu : 0 | true | 2
