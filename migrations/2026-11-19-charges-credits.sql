-- ═══ Compte de charges : les credits
-- Decision de Thierry, 19 novembre 2026 : le
-- tableau d'amortissement d'un credit se charge
-- en PDF. Chaque mensualite echue devient UNE
-- charge (interets + assurance + accessoires) ;
-- la mensualite entiere (capital compris) se lit
-- par mois, comme un decaissement (§14.20).
--
-- A coller APRES 2026-11-19-charges-periode-
-- longue, et AVANT le deploiement du code : le
-- code ecrit dans ces tables et ces colonnes.
-- Sans le code, elle ne change rien : aucune
-- ligne n'a origine = 'credit'.
-- Rejouable. Lignes courtes : collage manuel.
-- Controle : 2026-11-19-controle-charges-
--   credits.sql, puis scripts/oracle-resume-
--   charges.sql (ecarts = 0).

-- ─── 1. Le credit ───
create table if not exists
  public.charges_credits (
  id uuid primary key
    default gen_random_uuid(),
  user_id uuid not null
    references auth.users (id)
    on delete cascade,
  entite_juridique_id uuid not null,
  bien_id uuid
    references public.properties (id)
    on delete set null,
  preteur text not null,
  justificatif_chemin text,
  justificatif_empreinte text,
  nb_echeances int not null,
  premiere_echeance date not null,
  derniere_echeance date not null,
  cree_le timestamptz not null
    default now(),
  constraint charges_credits_id_user_uq
    unique (id, user_id),
  constraint charges_credits_entite_fk
    foreign key (entite_juridique_id, user_id)
    references public.entites_juridiques
      (id, user_id),
  constraint charges_credits_preteur_ck
    check (char_length(preteur)
      between 1 and 120),
  constraint charges_credits_dates_ck
    check (premiere_echeance
      <= derniere_echeance
      and nb_echeances between 1 and 1000)
);

-- Le meme tableau ne s'importe pas deux fois.
create unique index if not exists
  charges_credits_empreinte_uidx
  on public.charges_credits
  (user_id, justificatif_empreinte)
  where justificatif_empreinte is not null;

-- ⚠ Le bien d'un credit est du meme compte.
create or replace function
  public.charges_credits_bien_compte()
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
      'charges_credits: bien hors du compte'
      using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists
  charges_credits_bien_compte_trg
  on public.charges_credits;
create trigger charges_credits_bien_compte_trg
  before insert or update
  on public.charges_credits
  for each row execute function
    public.charges_credits_bien_compte();

-- ─── 2. Ses echeances, telles que lues ───
-- echeance = interets + assurance
--   + accessoires + capital, au centime :
-- la meme preuve que la lecture du tableau.
create table if not exists
  public.charges_credit_echeances (
  credit_id uuid not null,
  user_id uuid not null,
  indice int not null,
  rang int,
  date_echeance date not null,
  interets_cents bigint not null,
  assurance_cents bigint not null,
  accessoires_cents bigint not null,
  capital_cents bigint not null,
  echeance_cents bigint not null,
  capital_restant_cents bigint,
  materialisee_le timestamptz,
  primary key (credit_id, indice),
  constraint charges_credit_ech_credit_fk
    foreign key (credit_id, user_id)
    references public.charges_credits
      (id, user_id)
    on delete cascade,
  constraint charges_credit_ech_somme_ck
    check (interets_cents >= 0
      and assurance_cents >= 0
      and accessoires_cents >= 0
      and capital_cents >= 0
      and echeance_cents = interets_cents
        + assurance_cents
        + accessoires_cents
        + capital_cents)
);
create index if not exists
  charges_credit_ech_user_date_idx
  on public.charges_credit_echeances
  (user_id, date_echeance);
create index if not exists
  charges_credit_ech_a_faire_idx
  on public.charges_credit_echeances
  (date_echeance)
  where materialisee_le is null;

alter table public.charges_credits
  enable row level security;
revoke all on public.charges_credits
  from anon, authenticated;
alter table public.charges_credit_echeances
  enable row level security;
revoke all on public.charges_credit_echeances
  from anon, authenticated;

-- ─── 3. La charge d'une echeance ───
alter table public.charges
  add column if not exists credit_id uuid;
alter table public.charges
  add column if not exists credit_indice int;

alter table public.charges
  drop constraint if exists charges_credit_fk;
alter table public.charges
  add constraint charges_credit_fk
  foreign key (credit_id, user_id)
  references public.charges_credits
    (id, user_id)
  on delete cascade;

-- Une echeance, une charge. ⚠ SANS clause
-- where : l'ecriture passe par ON CONFLICT
-- (credit_id, credit_indice), qu'un index
-- partiel ne sert pas. Deux vides ne se
-- heurtent pas : les autres charges passent.
create unique index if not exists
  charges_credit_uidx
  on public.charges (credit_id, credit_indice);

alter table public.charges
  drop constraint if exists charges_origine_ck;
alter table public.charges
  add constraint charges_origine_ck
  check (origine in ('photo', 'fichier',
    'email', 'ota', 'credit'));

-- La liste fermee de Q5, plus 'credit', reserve
-- aux echeances (tests/charges-migration-
-- credits.test.js la compare a regles.js).
alter table public.charges
  drop constraint if exists charges_categorie_ck;
alter table public.charges
  add constraint charges_categorie_ck check (
    categorie is null or categorie in (
      'menage', 'linge', 'consommables',
      'energie', 'internet_telephone',
      'entretien', 'travaux_equipement',
      'assurance', 'impots_taxes',
      'copropriete', 'abonnements_logiciels',
      'honoraires', 'commissions_plateformes',
      'frais_bancaires', 'autre', 'credit'));

-- ⚠ Une charge 'credit' vient d'une echeance,
-- et seulement elle porte la categorie 'credit'.
alter table public.charges
  drop constraint if exists charges_credit_ck;
alter table public.charges
  add constraint charges_credit_ck check (
    (origine = 'credit')
      = (credit_id is not null)
    and (origine <> 'credit'
      or (credit_indice is not null
        and categorie = 'credit'))
    and (categorie is distinct from 'credit'
      or origine = 'credit'));
