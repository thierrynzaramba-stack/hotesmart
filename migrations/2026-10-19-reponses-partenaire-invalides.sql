-- Quand le partenaire repond 200 sans JSON valide,
-- on le SAIT (19 octobre 2026).
-- Lignes < 60 car. : collage manuel dans l'editeur.
--
-- POURQUOI. `channelCall` rangeait une reponse
-- non-JSON en `{ raw: text }` et gardait le succes du
-- code HTTP. Un 200 portant une page HTML — URL mal
-- reglee, page d'erreur d'un pare-feu, maintenance —
-- devenait donc une reponse VALIDE annoncant une liste
-- vide. Pour une lecture : « ce compte n'a rien ». Pour
-- une ecriture : « c'est fait ».
-- Inventaire des 18 copies et de ce que chacune en
-- conclut : docs/kb/reponse-200-sans-json.md.
--
-- ⚠ CETTE ETAPE NE CHANGE AUCUN COMPORTEMENT. Elle
-- OBSERVE. Les quatre chemins destructeurs se
-- corrigent ensuite, un par un, chacun avec sa recette.
-- On veut d'abord savoir si le cas se produit, et ou :
-- aucune trace n'existe aujourd'hui, par construction,
-- puisque le defaut est MUET.
--
-- ⚠ CETTE TABLE N'EST LUE PAR AUCUN CLIENT. `extrait`
-- porte 300 caracteres du corps du partenaire : une
-- page d'erreur porte plausiblement sa marque, et le
-- nom du partenaire ne sort JAMAIS vers l'hote. RLS
-- active, AUCUNE policy : seule la cle de service lit.
--
-- ⚠ PAS DE COLONNE `user_id`, ET C'EST DELIBERE.
-- Une premiere version en portait une : l'unique
-- writer ne l'ecrivait JAMAIS — le compte n'est pas
-- connu au site d'appel, qui est `channelCall`. Une
-- colonne morte suggere un filtre par compte qui
-- n'existe pas, et quelqu'un finira par s'y fier.
-- Constat de la revue de 4dada3e.
--
-- ⚠ `chemin` EST NORMALISE, PAS BRUT. Un chemin reel
-- porte des identifiants du partenaire
-- (`/channels/<uuid>/mappings/<uuid>`) : on les
-- remplace par `:id` avant d'ecrire. On garde ainsi de
-- quoi grouper les incidents sans stocker d'identifiant.

create table if not exists
  public.reponses_partenaire_invalides (
  id uuid primary key
    default gen_random_uuid(),
  fichier text not null,
  methode text not null,
  chemin text not null,
  statut int not null,
  code text not null,
  extrait text,
  occurrences int not null default 1,
  vu_le timestamptz not null default now(),
  cree_le timestamptz not null default now(),
  constraint reponses_partenaire_code
    check (code in ('reponse_non_json',
                    'forme_inattendue',
                    'reponse_vide'))
);

comment on table
  public.reponses_partenaire_invalides is
  'Detection SEULE : le partenaire a repondu 2xx sans '
  'JSON exploitable. Aucun comportement n''en depend. '
  'Writer unique : lib/reponse-partenaire.js. '
  'docs/kb/reponse-200-sans-json.md.';

comment on column
  public.reponses_partenaire_invalides.chemin is
  'NORMALISE : les identifiants du partenaire y sont '
  'remplaces par `:id`. Jamais le chemin brut.';

comment on column
  public.reponses_partenaire_invalides.extrait is
  '300 car. du corps recu, pour le diagnostic. Cette '
  'table n''est lue par AUCUN client : une page '
  'd''erreur porte plausiblement la marque du '
  'partenaire.';

comment on column
  public.reponses_partenaire_invalides.occurrences is
  'Repetitions regroupees dans la fenetre de cadence '
  '(voir lib/reponse-partenaire.js). Une panne qui '
  'dure ne fabrique pas mille lignes.';

create index if not exists
  reponses_partenaire_recentes
  on public.reponses_partenaire_invalides
  (fichier, code, vu_le desc);

alter table public.reponses_partenaire_invalides
  enable row level security;

-- ⚠ AUCUNE POLICY, ET C'EST VOULU. RLS active sans
-- policy = personne ne lit, hors cle de service. On
-- retire aussi les privileges de table, pour que le cas
-- ne depende pas que de la RLS.
revoke all on table
  public.reponses_partenaire_invalides
  from anon, authenticated;
