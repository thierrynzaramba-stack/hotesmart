-- Etape 3 : moteur de reservation direct
-- La politique d'annulation, par bien.
-- Spec : docs/specs/spec-moteur-reservation.md §6.5
-- Pourquoi : docs/kb/moteur-reservation.md §12
--
-- ⚠ LIGNES COURTES VOLONTAIRES : le copier-coller vers
-- l'editeur SQL de Supabase tronque les lignes longues.
--
-- ADDITIVE : deux colonnes, aucune table touchee.
--
-- POURQUOI MAINTENANT
-- Le §2 declare la politique « affichee clairement AVANT le
-- paiement ». L'etape 2 ne l'a pas construite : un voyageur
-- pouvait donc payer sans connaitre ses conditions. Dette
-- nommee, reprise ici.

alter table public.properties
  add column if not exists cancellation_policy text
  not null default 'non_remboursable';

-- Les quatre politiques du §2, et rien d'autre.
--   non_remboursable : aucun remboursement
--   j14              : remboursable jusqu'a J-14
--   j7               : remboursable jusqu'a J-7
--   flexible_j2      : remboursable jusqu'a J-2
--
-- ⚠ DEFAUT LE PLUS PROTECTEUR. Un bien qui n'a rien reglé ne
-- promet rien qu'on ne tienne. Le contraire ferait promettre
-- au voyageur un remboursement que l'hote n'a pas choisi.

alter table public.properties
  drop constraint if exists
  properties_cancellation_policy;

alter table public.properties
  add constraint
  properties_cancellation_policy
  check (cancellation_policy in
    ('non_remboursable','j14','j7','flexible_j2'));

-- ⚠ FIGEE SUR LA TENTATIVE au moment de la vente.
-- Ce que l'hote change apres ne s'applique PAS a une
-- reservation deja vendue : le voyageur a paye en lisant des
-- conditions, ce sont celles-la qui l'engagent.
-- Nullable : les tentatives d'avant cette migration n'en ont
-- pas, et on ne leur en invente pas.

alter table public.booking_attempts
  add column if not exists cancellation_policy text;
