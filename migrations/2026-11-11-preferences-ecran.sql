-- PREFERENCES D'AFFICHAGE PAR ECRAN (4b « Ce qui
-- fait bouger vos prix »). 11 novembre 2026.
-- Spec : docs/specs/spec-yf-ecran-evenements.md
-- §16.5. Lignes < 60 car. : collage manuel.
-- Rejouable (if not exists).
--
-- UNE LIGNE = (personne, compte, ecran). Decision
-- S2 de Thierry : « chacun le sien » — un membre
-- qui eteint 2023 ne l'eteint pas pour le
-- titulaire, et son choix le suit sur tous ses
-- appareils.
--
-- `valeur` porte ce qui est ETEINT, en cles
-- relatives ({ "eteintes": ["n3"] }) : une couche
-- nouvelle arrive allumee, et le choix tient
-- d'une saison a l'autre.
--
-- ⚠ RLS ACTIVE, AUCUNE POLICY, ET REVOKE : tout
-- passe par api/ecran/evenements.js (cle de
-- service), qui n'ecrit que la ligne de
-- l'appelant — `user_id` vient de la session,
-- jamais du corps.
--
-- ⚠ L'ECRAN EST UN NOM, PAS UNE LISTE FERMEE : un
-- autre ecran pourra garder ses choix ici sans
-- migration. La forme est bornee, la taille aussi.

create table if not exists
  public.preferences_ecran (
  user_id uuid not null,
  compte_id uuid not null,
  ecran text not null,
  valeur jsonb not null default '{}'::jsonb,
  mis_a_jour_le timestamptz not null
    default now(),
  primary key (user_id, compte_id, ecran),
  constraint pe_ecran_chk check (
    ecran ~ '^[a-z][a-z_]{0,39}$'),
  constraint pe_valeur_chk check (
    jsonb_typeof(valeur) = 'object'
    and pg_column_size(valeur) <= 2048)
);

alter table public.preferences_ecran
  enable row level security;
revoke all on public.preferences_ecran
  from anon, authenticated;
