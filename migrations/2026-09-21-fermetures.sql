-- Lot 4.6.2 — LES FERMETURES DE L'HOTE.
-- Spec : docs/specs/spec-yieldflow-v1.md §2 ter, §4, §5
-- et §7-A (arbitrage du 19 septembre 2026 : table dediee).
-- Writer : lib/fermetures.js (seul writer autorise).
-- Verification : node scripts/verifier-fermetures.js
--
-- ⚠ LIGNES COURTES VOLONTAIRES : ce SQL se colle a la
-- main dans l'editeur Supabase, qui tronque au-dela de
-- 60 caracteres (constate 3 fois).
--
-- CE QU'EST UNE FERMETURE : un stop-sell EN DUR, pose par
-- l'hote pour verrouiller une periode (travaux, usage
-- personnel, indisponibilite). Debut, fin, raison.
--
-- ⚠ CE N'EST PAS UNE SECONDE SOURCE DE VERITE.
-- « Une nuit n'a qu'une seule reponse a : suis-je
-- vendable ? » — et cette reponse vit dans
-- calendar_inventory (stop_sell). Une fermeture est ce
-- qui ECRIT cette intention, par le writer unique du
-- calendrier, et qui porte en plus le POURQUOI et les
-- BORNES que calendar_inventory, ligne a ligne, ne sait
-- pas dire. La lire EN PLUS pour decider de la
-- vendabilite creerait deux reponses des le premier
-- desaccord entre les deux tables.
--
-- ⚠ CE N'EST PAS UNE yield_exception NON PLUS. Les
-- exceptions sont des declarations sur le PASSE, pour
-- sortir des mois de la REFERENCE du moteur. Les
-- fermetures portent sur l'AVENIR et la VENTE. Deux
-- objets, deux tables : les fusionner ferait porter deux
-- semantiques a une seule.
--
-- ⚠ YIELD NE TOUCHE JAMAIS UNE FERMETURE DE L'HOTE. C'est
-- la frontiere du mode auto-pilote : le canal interne la
-- consulte avant d'ouvrir, et n'ouvre pas dedans.
--
-- ADDITIVE : cree une table, ne touche a aucune
-- existante. btree_gist sert a la contrainte
-- d'exclusion (egalite sur uuid dans un index gist).

create extension if not exists btree_gist;

create table if not exists public.fermetures (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,

  -- UUID, comme yield_exceptions et price_display_log :
  -- ecrite par NOUS, pas par la couche sync. Survit a un
  -- changement de provider ; la cascade la nettoie si le
  -- bien disparait.
  property_id uuid not null
    references public.properties(id) on delete cascade,

  -- Bornes INCLUSES, comme partout dans le produit :
  -- une fermeture du 12 au 20 couvre neuf nuits.
  date_debut date not null,
  date_fin date not null,

  -- Texte libre : c'est l'hote qui sait pourquoi. Aucun
  -- calcul n'en depend — c'est une trace pour lui, et
  -- ce que le calendrier affiche sur la periode.
  raison text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint fermetures_periode_valide
    check (date_fin >= date_debut),
  -- Meme borne que NUITS_MAX dans lib/fermetures.js :
  -- 1000 nuits au plus. Le code refuse, la base aussi.
  constraint fermetures_periode_bornee
    check (date_fin - date_debut < 1000),
  constraint fermetures_raison_non_vide
    check (length(btrim(raison)) > 0),
  -- ⚠ UNE NUIT N'APPARTIENT QU'A UNE SEULE FERMETURE.
  -- La lecture avant insertion du code ne tient pas
  -- sous concurrence (deux onglets) ; cette contrainte
  -- tient. Son refus (23P01) est rendu « chevauchement ».
  constraint fermetures_sans_chevauchement
    exclude using gist (
      property_id with =,
      daterange(date_debut, date_fin, '[]') with &&
    )
);

-- Les deux acces prevus : les fermetures d'un bien qui
-- CROISENT une periode (calendrier, canal interne), et
-- celles d'un compte (ecran).
create index if not exists fermetures_bien_periode_idx
  on public.fermetures
  (property_id, date_debut, date_fin);

create index if not exists fermetures_compte_idx
  on public.fermetures (user_id);

comment on table public.fermetures is
  'Fermetures a la vente posees par l''hote (debut, '
  'fin, raison). Bornes INCLUSES. Une fermeture ECRIT '
  'stop_sell dans calendar_inventory par le writer du '
  'calendrier ; elle n''est pas une seconde source de '
  'verite. Yield ne touche jamais une fermeture. '
  'Spec §2 ter.';

comment on column public.fermetures.raison is
  'Texte libre. Aucun calcul n''en depend : une trace '
  'pour l''hote, affichee sur la periode.';

-- ─── RLS ────────────────────────────────────────────────
-- Regle 5 : toute nouvelle table porte RLS des sa
-- creation.
alter table public.fermetures
  enable row level security;

-- ⚠ LECTURE SEULE POUR LE CLIENT, ET SUR SON SEUL COMPTE.
-- L'ecriture passe par l'endpoint, qui verifie le droit
-- `reservations` en ecriture (fermer a la vente est le
-- metier du calendrier, comme la disponibilite). Une
-- policy d'ecriture ici court-circuiterait la garde : la
-- RLS ne connait pas les profils delegues.
drop policy if exists fermetures_select
  on public.fermetures;
create policy fermetures_select
  on public.fermetures
  for select to authenticated
  using (user_id = auth.uid());

revoke insert, update, delete
  on table public.fermetures
  from anon, authenticated;

-- ─── Verification (a coller aussi) ──────────────────────
select
  (select count(*) from public.fermetures)
    as lignes,
  (select count(*) from pg_indexes
     where tablename = 'fermetures')
    as index_poses,
  (select count(*) from pg_policies
     where tablename = 'fermetures')
    as policies,
  (select count(*) from pg_constraint
     where conrelid = 'public.fermetures'::regclass
       and contype = 'c')
    as checks,
  (select count(*) from pg_constraint
     where conrelid = 'public.fermetures'::regclass
       and contype = 'x')
    as exclusions,
  (select relrowsecurity from pg_class
     where relname = 'fermetures')
    as rls_active;
-- Attendu : lignes 0, index_poses 4 (pkey + 2 +
-- l'index de l'exclusion), policies 1, checks 3,
-- exclusions 1, rls_active true.
