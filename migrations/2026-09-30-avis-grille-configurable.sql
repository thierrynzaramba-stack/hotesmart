-- migrations/2026-09-30-avis-grille-configurable.sql
-- Amendement du 30 septembre 2026 : la grille d'evaluation
-- devient configurable par l'hote.
-- Spec : docs/specs/spec-evaluation-voyageur.md §4, §7 bis.
-- Writer : api/avis.js (lot 3), seul writer.
-- Verification :
--   node scripts/verifier-avis-grille.js
--
-- ⚠ LIGNES COURTES VOLONTAIRES (editeur Supabase).
--
-- ADDITIVE. Cree deux tables, ajoute une colonne a
-- guest_evaluations, elargit un CHECK sur profiles.
-- Ne supprime rien.
--
-- ⚠ DEUX TABLES, PAS UN JSONB, ET POUR UNE SEULE RAISON
-- (spec §7 bis) : les deux regles que l'hote ne peut pas
-- defaire doivent tenir EN BASE. « Une note est entre 1
-- et 5 » et « une note 1 est toujours negative »
-- deviennent des CHECK — vraies meme si un bug, un
-- import ou un lot futur ecrit directement. En jsonb
-- elles ne vivraient que dans le code qui valide avant
-- d'ecrire. Une note fausse ne se rattrape pas : elle
-- part chez Airbnb.

-- ─── Les criteres ───────────────────────────────────────
create table if not exists public.avis_criteres (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null
    references auth.users(id) on delete cascade,

  -- Nul = grille du COMPTE ; renseigne = grille de ce
  -- bien, qui REMPLACE celle du compte (jamais fusion).
  property_id uuid
    references public.properties(id) on delete cascade,

  libelle text not null,

  -- Les quatre seules categories publiables chez Airbnb
  -- (etape 0, 24 septembre 2026). `recommandation` ne
  -- porte pas de note : Airbnb attend un booleen.
  categorie text not null,

  -- Qui repond a ce critere.
  rempli_par text not null default 'hote',

  -- Ordre d'affichage dans l'ecran et la fenetre.
  rang integer not null default 1,

  actif boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint avis_criteres_categorie_check
    check (categorie in (
      'cleanliness',
      'communication',
      'respect_house_rules',
      'recommandation'
    )),
  constraint avis_criteres_rempli_par_check
    check (rempli_par in (
      'prestataire', 'hote', 'les_deux'
    )),
  constraint avis_criteres_libelle_non_vide
    check (length(btrim(libelle)) > 0),
  constraint avis_criteres_rang_check
    check (rang >= 1)
);

create index if not exists avis_criteres_grille_idx
  on public.avis_criteres (user_id, property_id, rang);

comment on table public.avis_criteres is
  'Les criteres de la grille d''evaluation du voyageur, '
  'composee par l''hote. property_id nul = grille du '
  'compte ; une grille de bien REMPLACE celle du compte, '
  'elle ne s''y ajoute pas. Spec §4.';
comment on column public.avis_criteres.categorie is
  'Categorie Airbnb, seules publiables. '
  '« recommandation » ne porte pas de note : l''OTA '
  'attend un booleen (is_reviewee_recommended).';

-- ─── Les niveaux d'un critere ───────────────────────────
create table if not exists public.avis_criteres_niveaux (
  id uuid primary key default gen_random_uuid(),
  critere_id uuid not null
    references public.avis_criteres(id) on delete cascade,

  -- Valeur stockee dans les reponses (jamais le libelle :
  -- renommer « Sale » ne doit pas casser les evaluations).
  cle text not null,
  libelle text not null,

  -- Du meilleur (1) au pire. C'est cet ordre que l'ecran
  -- affiche ; la severite, elle, vient de la note.
  rang integer not null,

  -- 1 a 5. Nul UNIQUEMENT pour la categorie
  -- « recommandation », qui ne porte pas de note.
  note integer,

  -- Declenche la validation obligatoire par l'hote (§3).
  negatif boolean not null default false,

  -- Pour « recommandation » : ce niveau recommande-t-il ?
  recommande boolean,

  created_at timestamptz not null default now(),

  constraint avis_niveaux_note_check
    check (note is null or note between 1 and 5),

  -- ⚠ LA REGLE QUE L'HOTE NE PEUT PAS DEFAIRE (§4.2).
  -- Une note 1 est TOUJOURS negative. Ici, pas dans
  -- l'ecran : sinon un autre chemin d'ecriture la
  -- contournerait, et un 1/5 partirait chez Airbnb sans
  -- que l'hote l'ait relu.
  constraint avis_niveaux_un_est_negatif
    check (note is distinct from 1 or negatif),

  constraint avis_niveaux_cle_non_vide
    check (length(btrim(cle)) > 0),
  constraint avis_niveaux_rang_check
    check (rang >= 1),
  constraint avis_niveaux_cle_unique
    unique (critere_id, cle)
);

create index if not exists avis_niveaux_critere_idx
  on public.avis_criteres_niveaux (critere_id, rang);

comment on table public.avis_criteres_niveaux is
  'Les niveaux d''un critere, du meilleur au pire. La '
  'note (1-5) est nulle pour « recommandation », qui '
  'porte un booleen. Une note 1 est TOUJOURS negative — '
  'contrainte de base, non desactivable (spec §4.2).';
comment on column public.avis_criteres_niveaux.cle is
  'Valeur stockee dans les reponses. Jamais le libelle : '
  'renommer « Sale » ne doit pas casser les evaluations '
  'deja remplies.';

-- ─── La grille figee dans chaque evaluation ─────────────
-- ⚠ UN TEMOIN, PAS UNE SOURCE. Modifier la grille ne
-- change jamais une evaluation passee : sans cette copie,
-- une evaluation relue six mois plus tard afficherait des
-- libelles qui n'etaient pas ceux qu'on avait coches.
-- En jsonb, et c'est voulu : une copie morte n'a pas
-- besoin d'integrite, et la garder en tables imposerait
-- de distinguer partout les grilles vivantes des mortes.
alter table public.guest_evaluations
  add column if not exists grille_figee jsonb;

comment on column public.guest_evaluations.grille_figee is
  'Copie de la grille au PREMIER remplissage. Temoin, '
  'pas source : la grille vivante peut changer, celle-ci '
  'ne bouge plus. Spec §4.4.';

-- ─── eval_scope : le « si », plus le « quoi » ───────────
-- Le « qui remplit » de chaque critere dit desormais
-- QUOI. eval_scope ne garde que le SI : couper
-- entierement la participation d'une personne reste utile
-- et n'est porte par aucun critere.
-- On ELARGIT le CHECK avant de convertir : l'inverse
-- refuserait les lignes existantes.
do $$
begin
  alter table public.profiles
    drop constraint if exists profiles_eval_scope_check;
  alter table public.profiles
    add constraint profiles_eval_scope_check
    check (eval_scope in (
      'aucun', 'selon_grille',
      'proprete', 'complet'
    ));
end $$;

update public.profiles
  set eval_scope = 'selon_grille'
  where eval_scope in ('proprete', 'complet');

alter table public.profiles
  alter column eval_scope set default 'selon_grille';

comment on column public.profiles.eval_scope is
  'aucun = la prestataire ne participe a aucune '
  'evaluation ; selon_grille = elle voit les criteres '
  'marques prestataire ou les_deux. Les anciennes '
  'valeurs proprete et complet restent acceptees le '
  'temps de la bascule, converties par cette migration.';

-- ─── RLS ────────────────────────────────────────────────
-- Meme regle que les autres tables du domaine : lecture
-- du perimetre, aucune ecriture cliente. La grille se
-- modifie par api/avis.js, qui verifie le droit `avis` en
-- ecriture.
alter table public.avis_criteres
  enable row level security;
drop policy if exists avis_criteres_select
  on public.avis_criteres;
create policy avis_criteres_select
  on public.avis_criteres
  for select to authenticated
  using (can_read(user_id, 'avis', property_id));
revoke insert, update, delete
  on table public.avis_criteres
  from anon, authenticated;

-- ⚠ LES NIVEAUX N'ONT PAS DE user_id : leur droit est
-- celui de LEUR critere. Une policy qui les ouvrirait a
-- tous rendrait lisible la grille d'un autre compte.
alter table public.avis_criteres_niveaux
  enable row level security;
drop policy if exists avis_niveaux_select
  on public.avis_criteres_niveaux;
create policy avis_niveaux_select
  on public.avis_criteres_niveaux
  for select to authenticated
  using (exists (
    select 1 from public.avis_criteres c
    where c.id = critere_id
      and can_read(c.user_id, 'avis', c.property_id)
  ));
revoke insert, update, delete
  on table public.avis_criteres_niveaux
  from anon, authenticated;

-- ─── Verification ──────────────────────────────────────
-- ⚠ AUCUN SELECT ICI (regle gravee) : la preuve se fait
-- par script, hors de l'editeur.
--   node --env-file=<env> scripts/verifier-avis-grille.js
