-- Chantier V2, lot V2.3.4 : le lien LOGEMENT -> MARCHE.
-- Cadrage : docs/kb/chantier-nouveau-bien.md §11, §13.
--
-- ⚠ LIGNES COURTES VOLONTAIRES (collage manuel, < 60).
--
-- POURQUOI (review de securite du 24 septembre 2026) :
-- sans ce lien, la page « Le marche » rendait les
-- calendriers de TOUS les marches a tout compte
-- connecte — la commune des autres clients, presentee
-- comme « le marche de votre commune ». Avec lui, la vue
-- ne rend que le marche du logement demande, sous la
-- garde de ce logement.
--
-- ADDITIVE ET SUPPRIMABLE : une table V2 neuve, sans
-- cle etrangere, serveur seulement. `drop table` et
-- l'app tourne comme avant.
--
-- Writer unique : scripts/lier-bien-marche.js (saisie
-- du fondateur, comme la liste des comparables).

create table if not exists public.marche_biens (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  property_id uuid not null,
  pays text not null,
  region text not null,
  localite text not null,
  lie_par text not null default 'fondateur'
    check (lie_par in ('fondateur', 'etude')),
  lie_le timestamptz not null default now(),
  unique (property_id)
);
comment on table public.marche_biens is
  'V2.3.4 : le marche de chaque logement, pour '
  'la page Le marche. Aucun prix. Supprimable.';

alter table public.marche_biens
  enable row level security;
revoke all on table public.marche_biens
  from anon, authenticated;
revoke all on sequence
  public.marche_biens_id_seq
  from anon, authenticated;

-- ─── Verification (a coller aussi) ──────────────────────
-- EMPREINTE : biens = 5 en production, 3 en staging.
-- FORME : colonnes et unicite (create table if not
-- exists reussit en silence sur une autre forme).
select
  (select count(*) from public.properties)
    as biens,
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
     and c.relname = 'marche_biens'
     and c.relrowsecurity)
    as rls,
  (select count(*) from pg_policies
     where schemaname = 'public'
     and tablename = 'marche_biens')
    as policies,
  (has_table_privilege('anon',
     'public.marche_biens',
     'select,insert,update,delete')
   or has_table_privilege('authenticated',
     'public.marche_biens',
     'select,insert,update,delete'))
    as acces_client,
  (select count(*) from pg_constraint
     where conrelid =
       'public.marche_biens'::regclass
     and contype = 'f')
    as cles_etrangeres,
  (select count(*) from information_schema.columns
     where table_schema = 'public'
     and table_name = 'marche_biens')
    as colonnes,
  (select count(*) from pg_constraint
     where conrelid =
       'public.marche_biens'::regclass
     and contype = 'u')
    as unicite,
  (select count(*) from public.marche_biens)
    as lignes;
-- Attendu : biens 5 (prod) ou 3 (staging), rls 1,
-- policies 0, acces_client false,
-- cles_etrangeres 0, colonnes 9, unicite 1,
-- lignes 0.
