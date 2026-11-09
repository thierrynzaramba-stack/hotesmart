-- ENTITES JURIDIQUES (facture voyageur, etape 1)
-- 8 novembre 2026. Spec :
-- docs/specs/spec-facture-voyageur.md §5.1 et §5.2
-- Lignes < 60 car. : collage manuel dans l'editeur.
-- Rejouable (if not exists, drop ... if exists).
--
-- UNE LIGNE = UNE IDENTITE LEGALE D'UN COMPTE :
-- l'hote en nom propre, une SCI, une societe.
-- Partagee avec le chantier « compte de charges »
-- (decision de Thierry du 8 novembre 2026).
--
-- ⚠ UN COMPTE PEUT N'AVOIR AUCUNE ENTITE (Thierry,
-- 8 nov. 2026, reponse A) : rien n'est cree ici pour
-- les comptes existants, jamais d'identite remplie a
-- la place du titulaire.
--
-- ⚠ RLS ACTIVE, AUCUNE POLICY, ET REVOKE : exception
-- a la regle 5 de REVIEW.md, sur le precedent de
-- `taxes_sejour`. Le navigateur ne lit ni n'ecrit
-- rien ici : tout passe par api/entites-juridiques.js
-- et son writer unique lib/entites-juridiques.js.

create table if not exists
  public.entites_juridiques (
  id uuid primary key
    default gen_random_uuid(),
  user_id uuid not null
    references auth.users (id)
    on delete cascade,
  type text not null,
  forme_juridique text,
  nom text not null,
  adresse_ligne1 text,
  adresse_ligne2 text,
  code_postal text,
  ville text,
  pays text not null default 'FR',
  siret text,
  tva_intracom text,
  regime_tva text not null,
  taux_tva numeric(5, 2),
  capital text,
  rcs text,
  email text,
  telephone text,
  -- Debut de l'exercice comptable, « MM-JJ »,
  -- VIDE POSSIBLE et sans defaut (Thierry, 8 nov.
  -- 2026, 22 h 50) : on ne suppose pas une annee
  -- civile a la place de l'hote. Lu par le compte
  -- de charges : totaux par exercice (aucune purge,
  -- Thierry 22 h 53).
  debut_exercice text,
  -- Numerotation des factures (Thierry, 9 nov.
  -- 2026) : `auto`, HoteSmart enchaine la suite ;
  -- `manuel`, l'hote saisit chaque numero (il
  -- facture aussi ailleurs).
  numerotation_factures text not null
    default 'auto',
  par_defaut boolean not null
    default false,
  archivee_le timestamptz,
  cree_le timestamptz not null
    default now(),
  modifie_le timestamptz not null
    default now(),
  constraint ej_id_user_uniq
    unique (id, user_id),
  constraint ej_type_chk check (
    type in ('personne_physique',
             'societe')),
  constraint ej_regime_chk check (
    regime_tva in ('exonere',
      'franchise', 'assujetti')),
  -- Un taux si et seulement si assujetti.
  constraint ej_taux_chk check (
    (regime_tva = 'assujetti')
    = (taux_tva is not null)),
  constraint ej_taux_borne_chk check (
    taux_tva is null
    or (taux_tva > 0
        and taux_tva < 100)),
  constraint ej_siret_chk check (
    siret is null
    or siret ~ '^[0-9]{14}$'),
  constraint ej_pays_chk check (
    pays ~ '^[A-Z]{2}$'),
  constraint ej_numerotation_chk check (
    numerotation_factures
      in ('auto', 'manuel')),
  constraint ej_exercice_chk check (
    debut_exercice is null
    or debut_exercice ~
    '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  -- Une entite archivee n'est jamais celle
  -- par defaut.
  constraint ej_defaut_archive_chk
    check (not (par_defaut
      and archivee_le is not null))
);

-- UNE SEULE ENTITE PAR DEFAUT PAR COMPTE.
create unique index if not exists
  entites_juridiques_defaut_uidx
  on public.entites_juridiques (user_id)
  where par_defaut;

create index if not exists
  entites_juridiques_user_idx
  on public.entites_juridiques (user_id);

alter table public.entites_juridiques
  enable row level security;

revoke all on public.entites_juridiques
  from anon, authenticated;

-- LE LIEN BIEN -> ENTITE, HORS DE `properties`.
-- ⚠ La politique `properties_write` laisse un
-- membre `reglages: write` ecrire toute la ligne
-- d'un bien : une colonne la-bas lui laisserait
-- changer l'emetteur des factures. Pas de ligne =
-- l'entite par defaut du compte.
-- `property_uuid` : exception E6 (properties.id),
-- comme `taxes_sejour.property_uuid`.

create table if not exists
  public.biens_entites (
  property_uuid uuid primary key
    references public.properties (id)
    on delete cascade,
  entite_id uuid not null,
  user_id uuid not null,
  modifie_le timestamptz not null
    default now(),
  -- MEME COMPTE, garanti en base.
  constraint be_entite_fk
    foreign key (entite_id, user_id)
    references public.entites_juridiques
      (id, user_id)
    on delete restrict
);

create index if not exists
  biens_entites_entite_idx
  on public.biens_entites (entite_id);

-- Le bien doit appartenir au meme compte que
-- l'entite. La cle composite ne voit pas
-- `properties` : ce trigger le verifie.
create or replace function
  public.biens_entites_meme_compte()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.properties p
    where p.id = new.property_uuid
      and p.user_id = new.user_id
  ) then
    raise exception
      'bien et entite de comptes differents'
      using errcode = '23514';
  end if;
  return new;
end
$$;

drop trigger if exists
  biens_entites_meme_compte_trg
  on public.biens_entites;

create trigger
  biens_entites_meme_compte_trg
  before insert or update
  on public.biens_entites
  for each row execute function
  public.biens_entites_meme_compte();

alter table public.biens_entites
  enable row level security;

revoke all on public.biens_entites
  from anon, authenticated;

-- LA SUITE DES NUMEROS, PAR ENTITE ET PAR ANNEE
-- (annee d'Europe/Paris, calculee par le writer).
-- `prochain_numero` : le numero que prendra la
-- prochaine facture. `dernier_emis` : pose par le
-- tirage de l'etape 3, vide tant que rien n'est
-- emis.

create table if not exists
  public.factures_voyageur_suites (
  entite_id uuid not null,
  user_id uuid not null,
  annee integer not null,
  prefixe text not null default 'F',
  prochain_numero integer not null
    default 1,
  dernier_emis integer,
  modifie_le timestamptz not null
    default now(),
  primary key (entite_id, annee),
  constraint fvs_entite_fk
    foreign key (entite_id, user_id)
    references public.entites_juridiques
      (id, user_id)
    on delete restrict,
  constraint fvs_annee_chk check (
    annee between 2000 and 2999),
  constraint fvs_prefixe_chk check (
    prefixe ~ '^[A-Za-z0-9]{1,12}$'),
  -- Jamais en dessous du dernier emis + 1.
  constraint fvs_prochain_chk check (
    prochain_numero >= 1
    and (dernier_emis is null
      or prochain_numero > dernier_emis))
);

-- ⚠ LA SUITE EST GARDEE EN BASE, ET C'EST LA
-- SEULE GARANTIE « SANS TROU » (Thierry,
-- 9 nov. 2026 ; review 2 de l'etape 1,
-- constat 1 : l'ancien trigger laissait sauter
-- `dernier_emis`, ne voyait ni la premiere
-- emission, ni l'INSERT, ni le DELETE) :
-- - une ligne nait VIERGE (aucun numero emis) ;
-- - ses cles (entite, compte, annee) ne
--   bougent jamais ;
-- - un numero emis est TOUJOURS l'ancien
--   `prochain_numero` : ni saut, ni baisse,
--   ni retour a vide ;
-- - des qu'un numero est emis, le prefixe est
--   fige et le prochain est le dernier + 1 ;
-- - une suite entamee ne se supprime pas.
create or replace function
  public.fvs_suite_protegee()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.dernier_emis is not null then
      raise exception
        'suite entamee : suppression refusee'
        using errcode = '23514';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.dernier_emis is not null then
      raise exception
        'une suite nait sans numero emis'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if new.entite_id <> old.entite_id
     or new.user_id <> old.user_id
     or new.annee <> old.annee then
    raise exception
      'cles de la suite figees'
      using errcode = '23514';
  end if;
  if new.dernier_emis
     is distinct from old.dernier_emis
     and (new.dernier_emis is null
       or new.dernier_emis
          <> old.prochain_numero) then
    raise exception
      'numero emis hors de la suite'
      using errcode = '23514';
  end if;
  if new.dernier_emis is not null
     and new.prefixe <> old.prefixe then
    raise exception
      'prefixe fige apres une emission'
      using errcode = '23514';
  end if;
  if new.dernier_emis is not null
     and new.prochain_numero
       <> new.dernier_emis + 1 then
    raise exception
      'suite figee : pas de trou'
      using errcode = '23514';
  end if;
  return new;
end
$$;

drop trigger if exists
  fvs_suite_protegee_trg
  on public.factures_voyageur_suites;

create trigger fvs_suite_protegee_trg
  before insert or update or delete
  on public.factures_voyageur_suites
  for each row execute function
  public.fvs_suite_protegee();

alter table
  public.factures_voyageur_suites
  enable row level security;

revoke all
  on public.factures_voyageur_suites
  from anon, authenticated;

-- L'ENTITE PAR DEFAUT, EN UNE TRANSACTION :
-- retirer l'ancienne puis poser la nouvelle.
-- Rend true si l'entite (active, du compte) est
-- desormais celle par defaut, false sinon.
create or replace function
  public.entite_definir_defaut(
  p_user_id uuid,
  p_entite_id uuid
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not exists (
    select 1 from entites_juridiques
    where id = p_entite_id
      and user_id = p_user_id
      and archivee_le is null
  ) then
    return false;
  end if;
  update entites_juridiques
    set par_defaut = false,
        modifie_le = now()
    where user_id = p_user_id
      and par_defaut
      and id <> p_entite_id;
  update entites_juridiques
    set par_defaut = true,
        modifie_le = now()
    where id = p_entite_id
      and user_id = p_user_id;
  return true;
end
$$;

revoke all on function
  public.entite_definir_defaut(uuid, uuid)
  from public, anon, authenticated;

notify pgrst, 'reload schema';
