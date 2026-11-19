-- Controle de la migration
-- 2026-11-19-charges-heic
-- La ligne doit dire ok = true.
-- ⚠ Une liste de types VIDE (null) veut dire,
-- pour Supabase, « tout type accepte » : elle
-- rend false, et le detail le dit.
select '1 bucket justificatifs' as controle,
  coalesce(count(*) = 1
    and bool_and(not public)
    and bool_and(file_size_limit = 10485760)
    and bool_and(allowed_mime_types @> array[
      'application/pdf', 'image/jpeg',
      'image/png', 'image/heic',
      'image/heif']::text[])
    and bool_and(cardinality(
      allowed_mime_types) = 5), false) as ok,
  case when count(*) = 0 then 'bucket absent'
    else coalesce(string_agg(array_to_string(
      allowed_mime_types, ', '), ''),
      'liste vide : tout type accepte')
  end as detail
from storage.buckets
where id = 'justificatifs';
