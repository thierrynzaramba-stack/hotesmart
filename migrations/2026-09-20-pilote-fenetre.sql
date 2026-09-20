-- Lot 4.6.0 — LA FENETRE GLISSANTE D'UN BIEN AUTO-PILOTE.
-- Spec : docs/specs/spec-yieldflow-v1.md §2 ter
-- Regle : lib/pilote-tarifaire.js (fenetreDuBien)
--
-- ⚠ LIGNES COURTES VOLONTAIRES : ce SQL se colle a la
-- main dans l'editeur Supabase, qui tronque au-dela de
-- 60 caracteres (constate 3 fois).
--
-- CE QUE CES DEUX COLONNES DISENT : jusqu'ou un bien
-- pilote par YieldFlow est OUVERT a la vente, vu
-- d'aujourd'hui. N jours glissants, ou N mois.
-- Au-dela, une nuit est PAS ENCORE OUVERTE — ce n'est
-- pas une fermeture, aucun objet n'est cree, aucune
-- intention n'est memorisee. La fenetre glisse et la
-- nuit s'ouvre seule (4.6.3).
--
-- ⚠ NULLES PAR DEFAUT, ET C'EST LA GARANTIE DU LOT.
-- Un bien sans fenetre n'a pas de « hors fenetre » :
-- rien ne change pour lui, qu'il soit en mode
-- calendrier ou en yieldflow pas encore regle. Le
-- reglage se fait a l'activation (4.6.3), jamais ici.

begin;

alter table public.properties
  add column if not exists pilote_fenetre_type text;

alter table public.properties
  add column if not exists pilote_fenetre_valeur int;

-- Deux types, pas trois. Un type inconnu serait lu
-- « pas de fenetre » par la regle serveur : on ferme.
alter table public.properties
  drop constraint if exists properties_fenetre_type_ck;

alter table public.properties
  add constraint properties_fenetre_type_ck
  check (
    pilote_fenetre_type is null
    or pilote_fenetre_type in ('jours', 'mois')
  );

-- Une fenetre de zero ou negative n'ouvrirait rien.
alter table public.properties
  drop constraint if exists properties_fenetre_valeur_ck;

alter table public.properties
  add constraint properties_fenetre_valeur_ck
  check (
    pilote_fenetre_valeur is null
    or pilote_fenetre_valeur > 0
  );

-- Les deux ensemble, ou aucune : un type sans valeur
-- (ou l'inverse) est une fenetre a moitie reglee, que
-- la regle lirait « pas de fenetre » en silence.
alter table public.properties
  drop constraint if exists properties_fenetre_paire_ck;

alter table public.properties
  add constraint properties_fenetre_paire_ck
  check (
    (pilote_fenetre_type is null)
    = (pilote_fenetre_valeur is null)
  );

comment on column public.properties.pilote_fenetre_type
  is 'Fenetre glissante du pilote yieldflow : jours '
     'ou mois. NULL = pas de fenetre. Spec §2 ter.';

comment on column
  public.properties.pilote_fenetre_valeur
  is 'Longueur de la fenetre glissante (N jours ou '
     'N mois). NULL = pas de fenetre.';

commit;

-- CONTROLE APRES APPLICATION (a coller aussi) :
--   select pilote_tarifaire, pilote_fenetre_type,
--          pilote_fenetre_valeur, count(*)
--     from public.properties
--    group by 1, 2, 3
--    order by 1, 2, 3;
-- Attendu : toutes les fenetres NULL. Une fenetre
-- deja posee serait une anomalie a comprendre AVANT
-- d'aller plus loin.
