-- Lot 4.5 — LE PILOTE TARIFAIRE PAR BIEN.
-- Spec : docs/specs/spec-yieldflow-v1.md §2 bis
-- Verification : node scripts/verifier-pilote-tarifaire.js
--
-- ⚠ LIGNES COURTES VOLONTAIRES : l'editeur SQL de
-- Supabase tronque les lignes longues au collage
-- (constate 3 fois). Regle CLAUDE.md § VALIDATION.
--
-- CE QUE CETTE COLONNE DECIDE : qui ECRIT le prix d'un
-- bien. Elle ne decide RIEN d'autre.
--   'calendrier' (defaut) : l'hote saisit ses prix dans
--     le calendrier. C'est le comportement actuel, et il
--     ne bouge pas.
--   'yieldflow' : les prix se travaillent et se valident
--     dans l'app Yield. Le calendrier passe en
--     consultation TARIFAIRE pour ce bien.
--
-- ⚠ LE PILOTE N'EMPORTE QUE LE TARIF. La disponibilite
-- et le stop_sell restent au calendrier DANS LES DEUX
-- MODES (§2 bis, arbitrage B). La memoire d'intention
-- commerciale et l'anti-surreservation ne changent pas
-- de mains. Un refus qui engloberait le segment entier
-- empecherait l'hote de fermer une nuit : c'est la
-- regression du 7 septembre, et elle ne se refait pas.
--
-- ⚠ DEFAUT PROTECTEUR. Tous les biens existants passent
-- en 'calendrier'. Personne ne change de mode sans un
-- geste explicite de l'hote.

begin;

alter table public.properties
  add column if not exists pilote_tarifaire text
  not null default 'calendrier';

-- Les deux seules valeurs. Un mode invente serait lu
-- comme « pas yieldflow » par la garde serveur, donc
-- ouvrirait l'ecriture : on ferme en base.
alter table public.properties
  drop constraint if exists properties_pilote_tarifaire_ck;

alter table public.properties
  add constraint properties_pilote_tarifaire_ck
  check (pilote_tarifaire in ('calendrier', 'yieldflow'));

-- ⚠ LE FILET DE B BIS, EN BASE.
-- Un bien en rate_sync_mode = 'keep' ne peut PAS etre
-- pilote par YieldFlow : l'app ecrirait des prix que
-- RIEN ne pousse. calendar_inventory porterait une
-- strategie tarifaire invisible des plateformes, et le
-- journal des prix ne verrait rien — il ne journalise
-- que ce qui part reellement.
--
-- La garde qui PARLE a l'hote est serveur (message en
-- francais). Celle-ci est le filet : elle tient meme
-- pour un UPDATE direct en base.
alter table public.properties
  drop constraint if exists properties_pilote_keep_ck;

alter table public.properties
  add constraint properties_pilote_keep_ck
  check (
    pilote_tarifaire = 'calendrier'
    or rate_sync_mode = 'managed'
  );

comment on column public.properties.pilote_tarifaire is
  'Qui ecrit le prix : calendrier (hote) ou yieldflow '
  '(app Yield, validation hote). Spec §2 bis. '
  'La dispo et le stop_sell restent au calendrier '
  'dans les deux modes.';

commit;

-- CONTROLE APRES APPLICATION (a coller aussi) :
--   select pilote_tarifaire, rate_sync_mode, count(*)
--     from public.properties
--    group by 1, 2
--    order by 1, 2;
-- Attendu : tout en 'calendrier', aucune ligne
-- 'yieldflow'. Un bien deja bascule serait une anomalie
-- a comprendre AVANT d'aller plus loin.
