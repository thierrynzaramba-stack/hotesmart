-- ═══ Compte de charges, lot 5 ═════════════════════
-- Recevoir les factures par e-mail (spec §14.24).
-- Une adresse par entite juridique et une par
-- logement (Thierry, 23 nov. 2026) :
--   la-bulle.k2j9x7q4@reply.hotesmart.fr
-- le nom, un point, 8 caracteres tires au hasard.
-- Trois gestes :
--   1. la table des adresses ;
--   2. le sujet et le texte d'un e-mail recu,
--      pour la ligne « sans facture lisible » ;
--   3. la suppression de `charges_adresses`
--      (Q16 : compte + version), qu'aucun code
--      n'a jamais lue ni ecrite. Refusee si elle
--      contient une ligne.
-- Aucune donnee existante n'est modifiee.
-- A coller AVANT le deploiement du code du lot 5,
-- sur staging puis en production. Rejouable.
-- Puis jouer
--   2026-11-23-controle-charges-adresses-email.

-- ─── 1. Les adresses ─────────────────────────────
--
-- ⚠ LA CLE EST L'ADRESSE ELLE-MEME (ce qui precede
-- `@`). « Changer d'adresse » la remplace : l'
-- ancienne n'existe plus, donc un e-mail qui y
-- arrive est refuse. Rien a signer, aucun secret.
create table if not exists
  public.charges_adresses_email (
  locale text primary key,
  user_id uuid not null
    references auth.users (id)
    on delete cascade,
  -- Exactement UNE cible : une entite OU un
  -- logement (`cae_cible_ck`).
  entite_id uuid,
  property_uuid uuid
    references public.properties (id)
    on delete cascade,
  cree_le timestamptz not null
    default now(),
  -- Minuscules, chiffres, tirets, un point, puis
  -- 8 caracteres : jamais un point dans une
  -- adresse de reponse d'un voyageur.
  constraint cae_locale_ck check (
    char_length(locale) <= 50
    and locale ~
      '^[a-z0-9]+(-[a-z0-9]+)*[.][a-z0-9]{8}$'),
  constraint cae_cible_ck check (
    (entite_id is null)
      <> (property_uuid is null)),
  -- L'entite est du MEME compte, garanti en base.
  constraint cae_entite_fk
    foreign key (entite_id, user_id)
    references public.entites_juridiques
      (id, user_id)
    on delete cascade
);

-- Au plus UNE adresse vivante par entite, et une
-- par logement.
create unique index if not exists
  cae_entite_uidx
  on public.charges_adresses_email (entite_id)
  where entite_id is not null;
create unique index if not exists
  cae_bien_uidx
  on public.charges_adresses_email
    (property_uuid)
  where property_uuid is not null;
create index if not exists cae_compte_idx
  on public.charges_adresses_email (user_id);

-- ⚠ LE LOGEMENT EST DU MEME COMPTE. `properties`
-- n'a pas de cle (id, user_id) : un declencheur,
-- comme `charges_bien_meme_compte`.
create or replace function
  public.cae_bien_meme_compte()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.property_uuid is not null
    and not exists (
      select 1 from public.properties p
      where p.id = new.property_uuid
        and p.user_id = new.user_id)
  then
    raise exception
      'charges_adresses_email: bien hors du compte'
      using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists cae_bien_meme_compte_trg
  on public.charges_adresses_email;
create trigger cae_bien_meme_compte_trg
  before insert or update
  on public.charges_adresses_email
  for each row execute function
    public.cae_bien_meme_compte();

-- RLS SANS POLICY : seul le writer serveur
-- (lib/charges/adresse.js) lit et ecrit ici.
alter table public.charges_adresses_email
  enable row level security;
revoke all on public.charges_adresses_email
  from anon, authenticated;

-- ─── 2. Le sujet et le texte d'un e-mail ─────────
--
-- Pour la ligne « sans facture lisible » (Q19).
-- Bornes : 300 et 2 000 caracteres ; le code coupe
-- avant d'ecrire, la base refuse au-dela.
alter table public.charges
  add column if not exists email_sujet text;
alter table public.charges
  add column if not exists email_texte text;
alter table public.charges
  drop constraint if exists
    charges_email_sujet_ck;
alter table public.charges
  add constraint charges_email_sujet_ck
  check (char_length(email_sujet) <= 300);
alter table public.charges
  drop constraint if exists
    charges_email_texte_ck;
alter table public.charges
  add constraint charges_email_texte_ck
  check (char_length(email_texte) <= 2000);

-- ─── 3. L'ancienne table de Q16 ──────────────────
--
-- ⚠ ELLE N'EST SUPPRIMEE QUE VIDE. Si une ligne y
-- est, la migration s'arrete ici, et rien de ce qui
-- precede n'est perdu : tout est rejouable.
do $$
begin
  if to_regclass('public.charges_adresses')
    is not null
  then
    if exists (
      select 1 from public.charges_adresses)
    then
      raise exception
        'charges_adresses contient une ligne';
    end if;
    drop table public.charges_adresses;
  end if;
end $$;
