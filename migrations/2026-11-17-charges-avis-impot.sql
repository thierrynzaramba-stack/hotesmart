-- ═══ Compte de charges, lot 7a : avis d'impot
-- Un impot n'a pas de TVA. Decision de Thierry,
-- recette du 17 novembre 2026 : pour un document
-- de type « avis_impot », HT = TTC et TVA = 0.
-- A coller APRES 2026-11-13-charges-periode.sql.
-- Rejouable. Lignes courtes : collage manuel.
-- Controle : 2026-11-17-controle-charges-avis-
--   impot.sql, puis scripts/oracle-resume-
--   charges.sql (ecarts = 0).
--
-- Pourquoi : laisses vides, HT et TVA comptaient
-- « sans montant lu » et marquaient tout le
-- total « Estimation » ; et le total HT doit
-- inclure l'impot, comme en comptabilite.
--
-- 1. Les avis deja enregistres sont corriges.
--    Le trigger recalcule leur resume (serie,
--    verrou de compte) : rien d'autre a jouer.
-- 2. La base tient la regle du writer
--    (`montantsDuType`, lib/charges/regles.js) :
--    `charges_impot_ck`. Un TTC absent reste
--    absent, et le HT l'est avec lui.

update public.charges
   set montant_ht_cents = montant_ttc_cents,
       montant_tva_cents = 0
 where type_document = 'avis_impot'
   and (montant_tva_cents
          is distinct from 0
     or montant_ht_cents
          is distinct from
          montant_ttc_cents);

alter table public.charges
  drop constraint if exists charges_impot_ck;
alter table public.charges
  add constraint charges_impot_ck check (
    type_document <> 'avis_impot'
    or (montant_tva_cents
          is not distinct from 0
      and montant_ht_cents
          is not distinct from
          montant_ttc_cents));
