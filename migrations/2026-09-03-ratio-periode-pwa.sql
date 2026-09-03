-- 2026-09-03 — Periode du ratio affiche dans la PWA prestataire
--
-- POURQUOI ICI ET PAS AILLEURS.
-- `apps/menages/prestataires.html` ecrit DEJA `public_tokens` en direct
-- (insert/update sous RLS) : ce reglage n'y ajoute aucun writer. Le poser dans
-- `profile_permissions` aurait fait de cet ecran un SECOND writer d'une table
-- dont `api/membres.js` est le writer — la faute deja vecue sur
-- `public_tokens.property_ids`, qui s'ecrasait silencieusement.
-- Et `visibility_days` est deja un reglage d'affichage de la PWA stocke la :
-- `ratio_periode` en est le voisin direct.
--
-- DEFAUT « toujours » : aucun ratio existant ne change sans decision d'un hote.
-- ⚠ `lib/stats-avis.js` retombe sur '30j' pour une cle inconnue — un defaut
-- adapte a /avis, ou la periode vient d'un selecteur. `api/menages-public.js`
-- valide donc explicitement contre cette liste avant de s'en servir.

ALTER TABLE public_tokens
  ADD COLUMN IF NOT EXISTS ratio_periode TEXT NOT NULL DEFAULT 'toujours';

ALTER TABLE public_tokens
  DROP CONSTRAINT IF EXISTS public_tokens_ratio_periode_valide;

ALTER TABLE public_tokens
  ADD CONSTRAINT public_tokens_ratio_periode_valide
  CHECK (ratio_periode IN ('15j', '30j', '6mois', 'toujours'));

-- Verification.
-- SELECT label, visibility_days, ratio_periode FROM public_tokens ORDER BY created_at DESC;
