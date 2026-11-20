-- ═══ Compte de charges, lot 8b ═══════════════════
-- Un seul bouton « Ajouter » : le tableau
-- d'amortissement reconnu tout seul (spec §14.21.3).
-- Deux listes s'allongent, rien d'autre :
--   · le statut `tableau` : un PDF reconnu comme
--     tableau d'amortissement, qui attend dans
--     « A traiter » l'import de ses echeances ;
--   · le type `tableau_amortissement`.
-- Une charge `tableau` n'entre dans AUCUN total :
-- le resume ne compte que `a_verifier` et
-- `validee`. Aucune donnee n'est modifiee.
-- A coller APRES 2026-11-19-charges-exercice-mois,
-- ET AVANT LE DEPLOIEMENT DU CODE du lot 8b :
-- sans elle, un tableau depose par « Ajouter »
-- est refuse par la base (503) ; les factures,
-- elles, se lisent comme avant.
-- Puis jouer 2026-11-20-controle-charges-tableau.

alter table public.charges
  drop constraint if exists charges_statut_ck;
alter table public.charges
  add constraint charges_statut_ck check (
    statut in ('envoi', 'a_lire',
      'a_verifier', 'validee', 'annulee',
      'illisible', 'sans_facture',
      'tableau'));

alter table public.charges
  drop constraint if exists charges_type_ck;
alter table public.charges
  add constraint charges_type_ck check (
    type_document in ('facture',
      'regularisation', 'avoir',
      'echeancier', 'avis_impot',
      'tableau_amortissement'));
