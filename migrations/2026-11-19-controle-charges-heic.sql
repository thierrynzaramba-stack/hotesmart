-- Controle de la migration
-- 2026-11-19-charges-heic
-- La ligne doit dire ok = true.
select '1 bucket justificatifs' as controle,
  count(*) = 1
  and bool_and(not public)
  and bool_and(file_size_limit = 10485760)
  and bool_and(allowed_mime_types @> array[
    'application/pdf', 'image/jpeg',
    'image/png', 'image/heic',
    'image/heif']::text[])
  and bool_and(cardinality(
    allowed_mime_types) = 5) as ok,
  coalesce(string_agg(array_to_string(
    allowed_mime_types, ', '), ''),
    'bucket absent') as detail
from storage.buckets
where id = 'justificatifs';
