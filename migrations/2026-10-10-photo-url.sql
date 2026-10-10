-- migrations/2026-10-10-photo-url.sql
-- Photo de couverture d'un bien (lot photos,
-- 10 octobre 2026) : l'URL publique du fichier
-- du bucket Storage « property-photos ».
-- Ecrite par api/property-photo.js (POST, garde
-- reglages en ecriture) ; lue par l'accueil et
-- la fiche du bien. Vide = fond neutre.
-- Le nom du fichier dans le bucket est un
-- identifiant ALEATOIRE, jamais l'id du bien
-- (decision de Thierry du 10 octobre 2026).
--
-- ⚠ LIGNES COURTES (editeur Supabase).
-- Rejouable. Aucun SELECT ici.

alter table public.properties
  add column if not exists photo_url text;

comment on column public.properties.photo_url
  is 'URL publique de la photo de couverture '
     '(bucket property-photos, nom aleatoire). '
     'Vide = aucun visuel.';
