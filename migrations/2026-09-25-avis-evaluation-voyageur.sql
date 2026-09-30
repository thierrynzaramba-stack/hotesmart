-- migrations/2026-09-25-avis-evaluation-voyageur.sql
-- Lot 2 du chantier « evaluation du voyageur ».
-- Spec : docs/specs/spec-evaluation-voyageur.md §7.
-- Writer : lib/avis/ (lot 3), seul writer autorise.
-- Verification (les TROIS migrations du jour) :
--   node scripts/verifier-avis-evaluation.js
--
-- ⚠ LIGNES COURTES VOLONTAIRES : ce SQL se colle a la
-- main dans l'editeur Supabase, qui tronque au-dela de
-- 60 caracteres (constate 3 fois).
--
-- ADDITIVE, ET ENTIEREMENT. Elle cree deux tables, et
-- ajoute deux colonnes a `profiles`. Elle ne touche NI
-- `ota_reviews`, NI `booking_change_events`, NI aucune
-- table existante (decisions de Thierry, 25 septembre).
--
-- ⚠ CE QUI RELIE UNE EVALUATION A L'OTA : `ota_review_id`.
-- Airbnb cree l'objet review LE JOUR DU DEPART, cache
-- (`is_hidden`), vide, et c'est SON identifiant que le
-- POST de publication exige
-- (POST /reviews/:review_id/guest_review). Le cron des
-- avis le range deja dans `ota_reviews`. Une evaluation
-- sans lui ne peut pas etre publiee : la colonne est
-- donc renseignee des que l'objet existe, et la
-- publication la relit.

-- ─── guest_evaluations ──────────────────────────────────
-- Une evaluation par sejour, jamais dupliquee.
create table if not exists public.guest_evaluations (
  id uuid primary key default gen_random_uuid(),

  -- FK vers le compte, comme `ota_reviews` : un compte
  -- supprime n'a pas a laisser derriere lui des
  -- evaluations qui designent un proprietaire mort.
  user_id uuid not null
    references auth.users(id) on delete cascade,

  -- UUID de properties.id (decision E6) : ecrite par
  -- NOUS, pas par la couche sync. `property_id_ref`
  -- garde la cle provider, comme `ota_reviews`, pour la
  -- RLS par bien (can_read prend un ref texte).
  property_id uuid not null
    references public.properties(id) on delete cascade,
  property_id_ref text not null,

  -- Le sejour, tel que le coeur le nomme partout.
  booking_uid text not null,

  -- L'objet review Channex : la cle du POST. Nul tant
  -- que l'OTA ne l'a pas cree (depart non atteint).
  ota_review_id uuid
    references public.ota_reviews(id) on delete set null,

  -- Le menage d'ou vient la reponse de la prestataire.
  menage_event_id uuid,

  provider text not null,
  ota text not null,

  -- a_remplir -> soumise_prestataire -> a_valider
  --           -> publiee
  -- Branches : echec_publication, expiree, abandonnee.
  status text not null default 'a_remplir',

  -- Les boutons coches, de chaque cote, et les notes
  -- qu'on en DERIVE (calcul deterministe, lot 3).
  answers_cleaner jsonb,
  answers_host jsonb,
  scores jsonb,

  -- Ce qui part chez l'OTA. `private_note` n'est JAMAIS
  -- recopie dans `public_text` (garde-fou §3).
  public_text text,
  private_note text,
  language text,

  -- Qui a rempli, qui a valide. Profils, pas comptes :
  -- une prestataire n'a pas de compte.
  filled_by_profile uuid
    references public.profiles(id) on delete set null,
  validated_by_profile uuid
    references public.profiles(id) on delete set null,

  published_at timestamptz,

  -- La fenetre de l'OTA. Mesure du 24 septembre 2026 :
  -- Channex pose expired_at = received_at + 30 jours sur
  -- 400 objets lus ; Airbnb annonce 14. On recopie la
  -- date de Channex et on ne l'invente pas.
  deadline_at timestamptz,

  -- La reponse brute du provider a la publication.
  provider_response jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- ⚠ UNE SEULE EVALUATION PAR SEJOUR ET PAR COMPTE.
  -- C'est l'idempotence de la publication, au niveau de
  -- la base : deux clics, deux onglets, deux appels
  -- concurrents ne peuvent pas creer deux lignes.
  constraint guest_evaluations_unique_sejour
    unique (user_id, booking_uid),

  constraint guest_evaluations_status_check
    check (status in (
      'a_remplir',
      'soumise_prestataire',
      'a_valider',
      'publiee',
      'echec_publication',
      'expiree',
      'abandonnee'
    )),

  -- Publiee => on sait QUAND, et CE QUI est parti.
  constraint guest_evaluations_publiee_coherente
    check (
      status <> 'publiee'
      or (published_at is not null
          and public_text is not null)
    )
);

-- Les trois acces prevus, tous prefixes user_id (regle
-- d'indexation du depot) : l'ecran d'un compte, la file
-- des relances (statut + echeance), le rattachement a un
-- sejour.
create index if not exists guest_evaluations_compte_idx
  on public.guest_evaluations (user_id, created_at desc);
create index if not exists guest_evaluations_relance_idx
  on public.guest_evaluations
  (user_id, status, deadline_at);
-- ⚠ PAS D'INDEX (user_id, booking_uid) : la contrainte
-- d'unicite ci-dessus en pose deja un, identique. Un
-- second serait une copie que Postgres maintiendrait
-- pour rien.

-- ⚠ `updated_at` SE MAINTIENT, SINON IL MENT. Sans ce
-- declencheur il resterait egal a `created_at` pour
-- toujours, et le lot 3 lirait une date fausse pour
-- ordonner un passage de statut. `set_updated_at()`
-- existe depuis le schema initial ; `ota_reviews` pose
-- le meme.
drop trigger if exists guest_evaluations_touch_trg
  on public.guest_evaluations;
create trigger guest_evaluations_touch_trg
  before update on public.guest_evaluations
  for each row execute function public.set_updated_at();

comment on table public.guest_evaluations is
  'Evaluation du VOYAGEUR par l''hote (Airbnb). Une '
  'ligne par sejour, jamais dupliquee. Les notes sont '
  'derivees des boutons par calcul deterministe ; l''IA '
  'ne redige que le texte. Publication par '
  'lib/channels/, jamais rejouee. '
  'Spec docs/specs/spec-evaluation-voyageur.md §7.';
comment on column public.guest_evaluations.ota_review_id is
  'L''objet review Channex, cle du POST de publication. '
  'Cree par l''OTA le jour du depart, cache et vide.';
comment on column public.guest_evaluations.private_note is
  'Note privee au voyageur. JAMAIS recopiee dans '
  'public_text (garde-fou §3 de la spec).';

-- ─── avis_config ────────────────────────────────────────
-- Le vocabulaire de l'IA : par compte, surchargeable par
-- bien. `property_id` nul = le niveau compte.
create table if not exists public.avis_config (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null
    references auth.users(id) on delete cascade,
  property_id uuid
    references public.properties(id) on delete cascade,
  keywords text[] not null default '{}',
  tone text not null default 'chaleureux',
  signature text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint avis_config_tone_check
    check (tone in ('chaleureux', 'sobre'))
);

-- ⚠ DEUX INDEX UNIQUES, PAS UN. Un `unique (user_id,
-- property_id)` ne contraint RIEN quand property_id est
-- nul : en SQL, deux NULL ne sont pas egaux, et le
-- niveau compte pourrait exister en dix exemplaires.
create unique index if not exists avis_config_bien_uniq
  on public.avis_config (user_id, property_id)
  where property_id is not null;
create unique index if not exists avis_config_compte_uniq
  on public.avis_config (user_id)
  where property_id is null;

drop trigger if exists avis_config_touch_trg
  on public.avis_config;
create trigger avis_config_touch_trg
  before update on public.avis_config
  for each row execute function public.set_updated_at();

comment on table public.avis_config is
  'Mots-cles, ton et signature pour la redaction IA des '
  'avis. property_id nul = niveau compte ; une ligne '
  'avec property_id surcharge ce niveau pour ce bien.';

-- ─── profiles : les deux reglages prestataire ───────────
-- Decision de Thierry (25 septembre) : sur `profiles`.
-- C'est un reglage de la PERSONNE, pas du bien, et c'est
-- la table que le jeton PWA resout deja.
alter table public.profiles
  add column if not exists eval_scope text
  not null default 'proprete';
alter table public.profiles
  add column if not exists eval_power text
  not null default 'soumettre';

-- ⚠ AJOUTEES SEPAREMENT DES COLONNES : `add constraint`
-- n'a pas de `if not exists`. Le bloc les pose si elles
-- manquent, et se rejoue sans erreur.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_eval_scope_check'
  ) then
    alter table public.profiles
      add constraint profiles_eval_scope_check
      check (eval_scope in (
        'aucun', 'proprete', 'complet'
      ));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_eval_power_check'
  ) then
    alter table public.profiles
      add constraint profiles_eval_power_check
      check (eval_power in ('soumettre', 'valider'));
  end if;
end $$;

comment on column public.profiles.eval_scope is
  'Perimetre de questions de la prestataire : aucun | '
  'proprete (defaut) | complet.';
comment on column public.profiles.eval_power is
  'Pouvoir : soumettre (l''hote valide, defaut) | '
  'valider (publication directe). Un avis NEGATIF '
  'repasse toujours par l''hote, quel que soit ce '
  'reglage (garde-fou §3).';

-- ─── RLS ────────────────────────────────────────────────
-- Regle 5 : toute nouvelle table porte RLS des sa
-- creation. Le client LIT son compte, et n'ecrit RIEN :
-- l'ecriture passe par api/avis.js, qui verifie le droit
-- `avis` et le perimetre par bien. Une policy d'ecriture
-- ici court-circuiterait cette garde — la RLS ne connait
-- pas les profils delegues.
alter table public.guest_evaluations
  enable row level security;
drop policy if exists guest_evaluations_select
  on public.guest_evaluations;
create policy guest_evaluations_select
  on public.guest_evaluations
  for select to authenticated
  using (can_read(user_id, 'avis', property_id_ref));
revoke insert, update, delete
  on table public.guest_evaluations
  from anon, authenticated;

alter table public.avis_config
  enable row level security;
drop policy if exists avis_config_select
  on public.avis_config;
-- ⚠ LE PERIMETRE PAR BIEN COMPTE ICI AUSSI. Sans lui, un
-- membre limite a un logement lirait les mots-cles, le
-- ton et la signature de TOUS les biens du compte. La
-- surcharge a trois arguments rend `true` quand
-- `property_id` est nul (in_scope le prevoit) : le
-- niveau compte reste lisible par qui a le droit `avis`.
create policy avis_config_select
  on public.avis_config
  for select to authenticated
  using (can_read(user_id, 'avis', property_id));
revoke insert, update, delete
  on table public.avis_config
  from anon, authenticated;

-- ─── Verification ──────────────────────────────────────
-- ⚠ AUCUN SELECT DE VERIFICATION ICI. Regle gravee par
-- Thierry (25 septembre 2026) : on ne colle QUE des
-- migrations dans l'editeur Supabase. Ce qui a ete
-- applique se prouve par le script, hors de l'editeur :
--
--   node --env-file=<env> \
--     scripts/verifier-avis-evaluation.js
--
-- Il affiche l'empreinte de la base AVANT tout le reste
-- (3 biens = staging, 5 = production) et s'arrete si
-- elle est inconnue.
