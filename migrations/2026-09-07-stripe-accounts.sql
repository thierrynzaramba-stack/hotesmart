-- Etape 2 : moteur de reservation direct
-- Le compte Stripe de l'hote (modele « chaque hote apporte
-- ses cles »).
-- Spec : docs/specs/spec-moteur-reservation.md §3 bis et §5.1
-- Pourquoi : docs/kb/moteur-reservation.md §10
-- Verification : node scripts/stripe-hote.js
--
-- ⚠ LIGNES COURTES VOLONTAIRES : le copier-coller vers
-- l'editeur SQL de Supabase tronque les lignes longues.
--
-- ADDITIVE : cree une table, ne touche a aucune existante.
--
-- UNE LIGNE PAR HOTE, PAS PAR BIEN : un hote encaisse pour
-- tous ses logements. La cle se range sur le compte.
--
-- ⚠ CETTE TABLE PORTE DES SECRETS. `secret_key_cipher` et
-- `webhook_secret_cipher` sont chiffres en AES-256-GCM par
-- lib/chiffrement.js, jamais ecrits en clair, jamais relus
-- par un endpoint. La colonne en clair n'existe pas : il n'y
-- a rien a oublier de purger.

create table if not exists public.stripe_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,

  -- Format versionne v1:<iv>:<tag>:<chiffre>. Jamais en clair.
  secret_key_cipher text not null,
  -- Ce qu'on a le droit de MONTRER : de quoi permettre a un
  -- hote de reconnaitre sa cle, jamais de s'en servir.
  key_last4 text,
  mode text not null default 'test',
  key_restricted boolean not null default false,

  -- Webhook cree AUTOMATIQUEMENT sur le compte de l'hote.
  -- On garde l'id pour pouvoir le remplacer ou le supprimer.
  webhook_endpoint_id text,
  webhook_secret_cipher text,
  -- ⚠ PAS DECORATIF. Un webhook pose sur le compte propre
  -- d'un hote ne porte AUCUN identifiant de compte dans son
  -- corps — contrairement a Connect. La signature ne peut
  -- etre verifiee qu'avec le bon secret, et le bon secret ne
  -- se trouve que si l'URL dit de quel hote il s'agit :
  -- /api/book-webhook/<webhook_url_token>
  webhook_url_token text,

  verified_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Un seul compte Stripe par hote. Deux lignes rendraient le
-- choix de la cle non deterministe — donc un encaissement
-- sur le mauvais compte.

create unique index if not exists
  stripe_accounts_user_unique
  on public.stripe_accounts (user_id);

-- Le jeton d'URL est la SEULE cle d'entree du webhook. Deux
-- hotes qui le partageraient feraient verifier la signature
-- de l'un avec le secret de l'autre.

create unique index if not exists
  stripe_accounts_webhook_token_unique
  on public.stripe_accounts (webhook_url_token)
  where webhook_url_token is not null;

alter table public.stripe_accounts
  drop constraint if exists stripe_accounts_mode;

alter table public.stripe_accounts
  add constraint stripe_accounts_mode
  check (mode in ('test','live'));

-- ⚠ Garde-fou de dernier recours contre l'ecriture en clair.
-- Si un chemin oubliait de chiffrer, Postgres refuse la
-- ligne plutot que de stocker une cle Stripe lisible.
alter table public.stripe_accounts
  drop constraint if exists stripe_accounts_chiffre;

alter table public.stripe_accounts
  add constraint stripe_accounts_chiffre
  check (secret_key_cipher like 'v1:%'
     and (webhook_secret_cipher is null
          or webhook_secret_cipher like 'v1:%'));

-- RLS : AUCUNE policy ouverte, des deux cotes.
-- L'hote lui-meme ne doit pas pouvoir lire cette table
-- depuis le navigateur : sa propre cle ne se reaffiche
-- jamais (exigence 1 de la spec). Tout passe par un
-- endpoint garde, qui ne rend que mode + 4 derniers
-- caracteres.

alter table public.stripe_accounts
  enable row level security;

drop policy if exists stripe_accounts_service_only
  on public.stripe_accounts;

create policy stripe_accounts_service_only
  on public.stripe_accounts
  for all to authenticated
  using (false) with check (false);
