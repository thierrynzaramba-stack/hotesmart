-- COMPTE DE CHARGES, LOT 2 : LE SOCLE
-- (9 novembre 2026). Spec :
-- docs/specs/spec-compte-de-charges.md §6, §11
-- Lignes < 60 car. : collage manuel dans l'editeur.
--
-- ⚠ DEPEND DE 2026-11-08-entites-juridiques.sql
-- (fil facturation) : la cle composite de `charges`
-- vise entites_juridiques (id, user_id). A COLLER
-- APRES elle, jamais avant : sans la table cible,
-- ce fichier s'arrete a la premiere instruction.
--
-- UNE LIGNE DE `charges` = UNE FACTURE RECUE PAR
-- L'HOTE (ou une commission de plateforme, lot 4).
-- RLS ACTIVEE, AUCUNE POLICY, sur les quatre tables :
-- le navigateur ne lit ni n'ecrit rien ici. Seule la
-- cle service y touche, par /api/charges et
-- /api/cron-charges, gardes au titulaire du compte
-- (Q9). Writer unique : lib/charges.js.
--
-- ⚠ LES TOTAUX NE SONT JAMAIS CALCULES A LA LECTURE.
-- `charges_resume` porte une cellule par compte x
-- entite x bien x JOUR (un exercice peut commencer en
-- milieu de mois, Q22). Un TRIGGER la recalcule a
-- chaque ecriture de charge, dans la MEME transaction
-- : la cellule d'avant et celle d'apres. Recalcul,
-- jamais increment. Le cron dedie refait tout une
-- fois par jour pour la coherence.

-- ─── 1. Les charges ---

create table if not exists public.charges (
  id uuid primary key
    default gen_random_uuid(),
  user_id uuid not null
    references auth.users (id) on delete cascade,
  entite_juridique_id uuid,
  bien_id uuid
    references public.properties (id)
    on delete set null,
  statut text not null default 'envoi',
  motif text,
  tentatives_lecture int not null default 0,
  fournisseur_nom text,
  fournisseur_siret text,
  numero_facture text,
  date_facture date,
  jour date not null default current_date,
  date_repli boolean not null default true,
  montant_ht_cents bigint,
  montant_tva_cents bigint,
  montant_ttc_cents bigint,
  categorie text,
  origine text not null,
  booking_id text,
  email_uuid text,
  email_expediteur text,
  email_recu_le timestamptz,
  justificatif_chemin text,
  justificatif_type text,
  justificatif_octets int,
  justificatif_empreinte text,
  -- « Même fournisseur, même numéro » NORMALISE
  -- (lib/charges/regles.js, cleFournisseurNumero) :
  -- « F 12 » et « F-12 » sont la meme facture.
  cle_doublon text,
  groupe_doublon uuid
    references public.charges (id)
    on delete set null,
  signal text,
  signal_tranche boolean not null default false,
  lecture_ia jsonb,
  cree_le timestamptz not null default now(),
  modifie_le timestamptz not null default now(),
  valide_le timestamptz,
  valide_par uuid,
  -- ⚠ UNE CHARGE NE PEUT PAS POINTER L'ENTITE D'UN
  -- AUTRE COMPTE : garanti en base, pas seulement
  -- par le code (meme modele que biens_entites).
  constraint charges_entite_fk
    foreign key (entite_juridique_id, user_id)
    references public.entites_juridiques
      (id, user_id),
  constraint charges_statut_ck check (statut in (
    'envoi', 'a_lire', 'a_verifier', 'validee',
    'annulee', 'illisible', 'sans_facture')),
  constraint charges_origine_ck check (origine in (
    'photo', 'fichier', 'email', 'ota')),
  constraint charges_signal_ck check (
    signal is null or signal in (
      'doublon', 'commission_deja_comptee')),
  -- La liste fermee de Q5. Le test
  -- tests/charges-migration.test.js la compare
  -- caractere pour caractere a lib/charges/regles.js.
  constraint charges_categorie_ck check (
    categorie is null or categorie in (
      'menage', 'linge', 'consommables',
      'energie', 'internet_telephone',
      'entretien', 'travaux_equipement',
      'assurance', 'impots_taxes',
      'copropriete', 'abonnements_logiciels',
      'honoraires', 'commissions_plateformes',
      'frais_bancaires', 'autre')),
  constraint charges_montants_ck check (
    coalesce(montant_ht_cents, 0) >= 0
    and coalesce(montant_tva_cents, 0) >= 0
    and coalesce(montant_ttc_cents, 0) >= 0),
  -- D3 / Q20 : une charge VALIDEE a son entite.
  constraint charges_validee_entite_ck check (
    statut <> 'validee'
    or entite_juridique_id is not null)
);

create index if not exists charges_user_statut_idx
  on public.charges (user_id, statut);
create index if not exists charges_user_jour_idx
  on public.charges (user_id, jour);
create index if not exists charges_empreinte_idx
  on public.charges
  (user_id, justificatif_empreinte)
  where justificatif_empreinte is not null;
create index if not exists charges_cle_doublon_idx
  on public.charges (user_id, cle_doublon)
  where cle_doublon is not null;
create index if not exists charges_groupe_idx
  on public.charges (groupe_doublon)
  where groupe_doublon is not null;
-- La file du cron dedie : envois a purger (par
-- cree_le), lectures restees en attente (par
-- modifie_le, l'ordre de lib/charges.js).
create index if not exists charges_file_idx
  on public.charges (statut, cree_le)
  where statut in ('envoi', 'a_lire');
create index if not exists charges_a_lire_idx
  on public.charges (modifie_le)
  where statut = 'a_lire';
-- Une commission par reservation et par compte.
create unique index if not exists
  charges_ota_uidx
  on public.charges (user_id, booking_id)
  where origine = 'ota';
-- Un webhook rejoue par Brevo ne cree rien deux fois.
create unique index if not exists
  charges_email_piece_uidx
  on public.charges
  (user_id, email_uuid, justificatif_empreinte)
  where email_uuid is not null
    and justificatif_empreinte is not null;
-- ⚠ Une ligne `sans_facture` n'a pas d'empreinte, et
-- Postgres tient deux vides pour differents : son
-- unicite est la sienne.
create unique index if not exists
  charges_email_sans_facture_uidx
  on public.charges (user_id, email_uuid)
  where statut = 'sans_facture';

-- ⚠ LE BIEN D'UNE CHARGE EST DU MEME COMPTE.
-- Q18 (bien de l'entite choisie) se verifie a la
-- validation, par le code : le lien bien -> entite
-- peut changer apres coup, et une charge passee
-- garde le sien.
create or replace function
  public.charges_bien_meme_compte()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.bien_id is not null and not exists (
    select 1 from public.properties p
    where p.id = new.bien_id
      and p.user_id = new.user_id
  ) then
    raise exception
      'charges: bien hors du compte'
      using errcode = '23514';
  end if;
  new.modifie_le := now();
  return new;
end $$;

drop trigger if exists charges_bien_meme_compte_trg
  on public.charges;
create trigger charges_bien_meme_compte_trg
  before insert or update on public.charges
  for each row execute function
    public.charges_bien_meme_compte();

alter table public.charges
  enable row level security;
revoke all on public.charges
  from anon, authenticated;

-- ─── 2. Le resume des totaux ---

create table if not exists public.charges_resume (
  user_id uuid not null
    references auth.users (id) on delete cascade,
  entite_juridique_id uuid,
  bien_id uuid,
  jour date not null,
  -- ⚠ NULL, PAS 0, quand aucune facture comptee
  -- n'a ce montant : `nb_sans_*` en dit le motif.
  ht_cents bigint,
  tva_cents bigint,
  ttc_cents bigint,
  nb_factures int not null default 0,
  nb_non_verifiees int not null default 0,
  nb_signaux int not null default 0,
  nb_sans_ht int not null default 0,
  nb_sans_tva int not null default 0,
  nb_sans_ttc int not null default 0,
  calcule_le timestamptz not null default now()
);

-- ⚠ UNE CELLULE « SANS ENTITE » OU « SANS BIEN » EST
-- UNE SEULE CELLULE. Deux NULL sont differents pour
-- Postgres : la cle les ramene a une valeur fixe.
-- Rejouable sur une version anterieure de la table.
alter table public.charges_resume
  alter column ht_cents drop not null,
  alter column ht_cents drop default,
  alter column tva_cents drop not null,
  alter column tva_cents drop default,
  alter column ttc_cents drop not null,
  alter column ttc_cents drop default;

create unique index if not exists
  charges_resume_cellule_uidx
  on public.charges_resume (
    user_id,
    coalesce(entite_juridique_id,
      '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(bien_id,
      '00000000-0000-0000-0000-000000000000'::uuid),
    jour);
create index if not exists charges_resume_jour_idx
  on public.charges_resume (user_id, jour);

alter table public.charges_resume
  enable row level security;
revoke all on public.charges_resume
  from anon, authenticated;

-- La cle d'une cellule, pour son verrou. Les
-- verrous se prennent TOUJOURS dans l'ordre de cette
-- cle : deux ecritures croisees ne s'interbloquent
-- pas (constat de review).
create or replace function
  public.charges_cle_cellule(
    p_user uuid, p_entite uuid,
    p_bien uuid, p_jour date)
returns bigint
language sql
immutable
set search_path = public
as $$
  select hashtext(
    p_user::text || '|'
    || coalesce(p_entite::text, '-') || '|'
    || coalesce(p_bien::text, '-') || '|'
    || p_jour::text)::bigint;
$$;

-- RECALCULE UNE CELLULE, a partir des charges.
-- Ce qui compte (spec §6, Q4, Q14) :
--  · s'additionnent `a_verifier` et `validee` ;
--  · un groupe de doublons non tranche compte UNE
--    fois (la premiere, sans `groupe_doublon`) ;
--  · une commission deja comptee non tranchee
--    compte ZERO ;
--  · `envoi`, `annulee`, `sans_facture` : rien.
-- Le verrou par cellule evite que deux ecritures
-- simultanees se croisent sur la meme ligne.
create or replace function
  public.charges_recalculer_cellule(
    p_user uuid, p_entite uuid,
    p_bien uuid, p_jour date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(
    public.charges_cle_cellule(
      p_user, p_entite, p_bien, p_jour));

  delete from public.charges_resume r
  where r.user_id = p_user
    and r.entite_juridique_id
      is not distinct from p_entite
    and r.bien_id is not distinct from p_bien
    and r.jour = p_jour;

  insert into public.charges_resume (
    user_id, entite_juridique_id, bien_id, jour,
    ht_cents, tva_cents, ttc_cents,
    nb_factures, nb_non_verifiees, nb_signaux,
    nb_sans_ht, nb_sans_tva, nb_sans_ttc,
    calcule_le)
  select p_user, p_entite, p_bien, p_jour,
    sum(c.montant_ht_cents)
      filter (where c.compte),
    sum(c.montant_tva_cents)
      filter (where c.compte),
    sum(c.montant_ttc_cents)
      filter (where c.compte),
    count(*) filter (where c.compte),
    count(*) filter (where c.statut in (
      'a_lire', 'a_verifier', 'illisible')),
    count(*) filter (where c.signal is not null
      and not c.signal_tranche),
    count(*) filter (where c.compte
      and c.montant_ht_cents is null),
    count(*) filter (where c.compte
      and c.montant_tva_cents is null),
    count(*) filter (where c.compte
      and c.montant_ttc_cents is null),
    now()
  from (
    select x.*,
      (x.statut in ('a_verifier', 'validee')
       -- ⚠ `is not distinct from`, PAS `=` : un
       -- signal vide rend `=` NULL, et la ligne
       -- sortait du total (constat de review).
       and not (x.signal is not distinct from
                  'commission_deja_comptee'
                and not x.signal_tranche)
       and not (x.groupe_doublon is not null
                and not x.signal_tranche)
      ) as compte
    from public.charges x
    where x.user_id = p_user
      and x.entite_juridique_id
        is not distinct from p_entite
      and x.bien_id is not distinct from p_bien
      and x.jour = p_jour
      and x.statut not in (
        'envoi', 'annulee', 'sans_facture')
  ) c
  having count(*) > 0;
end $$;

-- Le trigger : cellule d'avant ET cellule d'apres.
-- Une validation qui change l'entite, le bien ou le
-- jour deplace la charge ; une suppression qui
-- detache un groupe (`on delete set null`) declenche
-- aussi l'UPDATE des autres membres, donc leur
-- recalcul.
create or replace function
  public.charges_resume_suivre()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  k_old bigint;
  k_new bigint;
begin
  -- Les deux verrous d'abord, dans l'ordre des cles.
  if tg_op = 'UPDATE' then
    k_old := public.charges_cle_cellule(
      old.user_id, old.entite_juridique_id,
      old.bien_id, old.jour);
    k_new := public.charges_cle_cellule(
      new.user_id, new.entite_juridique_id,
      new.bien_id, new.jour);
    perform pg_advisory_xact_lock(
      least(k_old, k_new));
    perform pg_advisory_xact_lock(
      greatest(k_old, k_new));
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.charges_recalculer_cellule(
      old.user_id, old.entite_juridique_id,
      old.bien_id, old.jour);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.charges_recalculer_cellule(
      new.user_id, new.entite_juridique_id,
      new.bien_id, new.jour);
  end if;
  return null;
end $$;

drop trigger if exists charges_resume_trg
  on public.charges;
create trigger charges_resume_trg
  after insert or update or delete
  on public.charges
  for each row execute function
    public.charges_resume_suivre();

-- Le recalcul quotidien d'UN compte : chaque
-- cellule qui a une charge, et chaque cellule du
-- resume qui n'en a plus.
create or replace function
  public.charges_recalculer_compte(p_user uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select u.entite_juridique_id, u.bien_id, u.jour
    from (
      select c.entite_juridique_id, c.bien_id,
        c.jour
      from public.charges c
      where c.user_id = p_user
      union
      select s.entite_juridique_id, s.bien_id,
        s.jour
      from public.charges_resume s
      where s.user_id = p_user
    ) u
    order by public.charges_cle_cellule(p_user,
      u.entite_juridique_id, u.bien_id, u.jour)
  loop
    perform public.charges_recalculer_cellule(
      p_user, r.entite_juridique_id,
      r.bien_id, r.jour);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Les comptes a recalculer, par curseur : jamais une
-- lecture tronquee a 1000 lignes sans le dire.
create or replace function
  public.charges_comptes(
    p_apres uuid, p_limite int)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select distinct c.user_id
  from public.charges c
  where p_apres is null or c.user_id > p_apres
  order by c.user_id
  limit greatest(1, least(p_limite, 500));
$$;

-- ⚠ DES FONCTIONS `security definer` SONT APPELABLES
-- PAR POSTGREST : sans ce retrait, n'importe quel
-- compte connecte recalculerait le resume d'un autre.
revoke execute on function
  public.charges_cle_cellule(
    uuid, uuid, uuid, date)
  from public, anon, authenticated;
revoke execute on function
  public.charges_recalculer_cellule(
    uuid, uuid, uuid, date)
  from public, anon, authenticated;
revoke execute on function
  public.charges_recalculer_compte(uuid)
  from public, anon, authenticated;
revoke execute on function
  public.charges_comptes(uuid, int)
  from public, anon, authenticated;
revoke execute on function
  public.charges_resume_suivre()
  from public, anon, authenticated;
grant execute on function
  public.charges_recalculer_compte(uuid)
  to service_role;
grant execute on function
  public.charges_comptes(uuid, int)
  to service_role;

-- ─── 3. Commissions supprimees par l'hote (Q11) ---

-- ⚠ Une commission de plateforme supprimee n'est
-- JAMAIS recreee par la materialisation quotidienne
-- (lot 4) : elle saute toute reservation d'ici.
create table if not exists
  public.charges_ota_supprimees (
  user_id uuid not null
    references auth.users (id) on delete cascade,
  booking_id text not null,
  supprimee_le timestamptz not null
    default now(),
  primary key (user_id, booking_id)
);

alter table public.charges_ota_supprimees
  enable row level security;
revoke all on public.charges_ota_supprimees
  from anon, authenticated;

-- ─── 4. Version de l'adresse de factures (Q16) ---

-- Le bouton « Changer d'adresse » (lot 5) monte la
-- version : l'ancienne adresse est refusee aussitot.
create table if not exists
  public.charges_adresses (
  user_id uuid primary key
    references auth.users (id) on delete cascade,
  version int not null default 1
    check (version >= 1),
  modifiee_le timestamptz not null
    default now()
);

alter table public.charges_adresses
  enable row level security;
revoke all on public.charges_adresses
  from anon, authenticated;

-- ─── 5. Le bucket des justificatifs ---

-- PRIVE, et AUCUNE policy storage : seule la cle
-- service y ecrit (URL d'envoi signee, delivree par
-- /api/charges) et y lit (URL de consultation de
-- courte duree, titulaire seul). 10 Mo au plus ;
-- les photos sont reduites sur le telephone.
insert into storage.buckets (
  id, name, public,
  file_size_limit, allowed_mime_types)
values (
  'justificatifs', 'justificatifs', false,
  10485760,
  array['application/pdf', 'image/jpeg',
        'image/png'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types =
    excluded.allowed_mime_types;
