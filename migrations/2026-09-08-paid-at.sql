-- Etape 4 : moteur de reservation direct
-- L'HEURE DE L'ENCAISSEMENT.
-- Spec : docs/specs/spec-moteur-reservation.md §6.2
--
-- ⚠ LIGNES COURTES VOLONTAIRES : le copier-coller vers
-- l'editeur SQL de Supabase tronque les lignes longues.
--
-- ADDITIVE : une colonne, aucune table touchee.
--
-- POURQUOI UNE COLONNE DEDIEE
-- L'alarme « ARGENT EN SUSPENS » doit permettre de trancher
-- sans ouvrir un ecran : dates, montant, voyageur, ET heure
-- de l'encaissement.
-- `updated_at` ne peut pas servir : le rattrapage des
-- tentatives bloquees l'ecrit a chaque signalement, et
-- l'alarme afficherait alors l'heure de l'alarme au lieu de
-- celle du paiement. Sur un message qui parle d'argent, une
-- date fausse est pire qu'une date absente.
--
-- Nullable : les tentatives d'avant cette migration n'en ont
-- pas, et on ne leur en invente pas.

alter table public.booking_attempts
  add column if not exists paid_at timestamptz;
