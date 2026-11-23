-- ═══ Compte de charges : photos HEIC
-- Decision de Thierry, 19 novembre 2026 : une
-- photo HEIC (recue par SMS, que Chrome ne
-- sait pas lire) s'envoie telle quelle ; le
-- serveur la convertit en JPEG a la
-- confirmation, et le JPEG REMPLACE la photo
-- (spec §14.19). Le bucket doit donc accepter
-- le DEPOT d'un HEIC ; il ne le garde jamais.
--
-- Ordre libre. Avant le code : rien ne change,
-- l'ancien code refuse le HEIC avant le depot.
-- Apres le code sans elle : le depot d'un HEIC
-- est refuse par le bucket (erreur a l'envoi,
-- comme avant le lot) — rien de casse.
-- ⚠ APRES ELLE, la section 5 de
-- 2026-11-09-compte-de-charges ne se rejoue
-- plus : elle retirerait le HEIC du bucket.
-- Rejouable. Lignes courtes : collage manuel.
-- Controle : 2026-11-19-controle-charges-heic.

update storage.buckets
set allowed_mime_types = array[
    'application/pdf', 'image/jpeg',
    'image/png', 'image/heic', 'image/heif']
where id = 'justificatifs';
