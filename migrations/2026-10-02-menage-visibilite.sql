-- Visibilite des menages d'autrui (2 octobre 2026)
-- Spec : docs/specs/spec-visibilite-menages-autrui.md
-- NON APPLIQUEE : staging puis prod, par Thierry.
-- Lignes < 60 car. : collage manuel dans l'editeur.
--
-- Absence de ligne = elle ne voit que ses menages.
-- Writer unique : api/disponibilites.js
-- (domaine prestataires, delegue compris).

create table if not exists public.menage_visibilite (
  user_id uuid not null
    references auth.users(id) on delete cascade,
  profile_id uuid not null
    references public.profiles(id) on delete cascade,
  par_bien boolean not null default false,
  profils_vus uuid[] not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (user_id, profile_id),
  constraint menage_visibilite_pas_soi
    check (not (profile_id = any (profils_vus))),
  constraint menage_visibilite_plafond
    check (cardinality(profils_vus) <= 20)
);

alter table public.menage_visibilite
  enable row level security;

-- Rejouable : la table est en `if not exists`,
-- les policies aussi doivent l'etre.
drop policy if exists menage_visibilite_select
  on public.menage_visibilite;
drop policy if exists menage_visibilite_write
  on public.menage_visibilite;

-- LECTURE SEULE cote client. Le writer unique
-- (api/disponibilites.js) ecrit en cle de service :
-- aucune policy d'ecriture, donc aucune autre
-- voie d'ecriture que l'endpoint et ses gardes.
create policy menage_visibilite_select
  on public.menage_visibilite
  for select to authenticated
  using (can_read(user_id, 'prestataires'));

-- Preuve (a lancer apres) :
select column_name, data_type,
       is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'menage_visibilite'
 order by ordinal_position;

select policyname
  from pg_policies
 where tablename = 'menage_visibilite';
