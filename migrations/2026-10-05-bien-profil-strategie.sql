-- 2026-10-05-bien-profil-strategie.sql
-- « Se positionner » : la strategie de prix et le
-- sejour minimum souhaite. Spec :
-- docs/kb/chantier-nouveau-bien.md §22.2.
--
-- juste (au positionnement) | agressif (-10 %) |
-- qualite (+10 %). Writer unique :
-- lib/marche/profil-bien.js. Nulles tant que
-- l'hote n'a pas repondu.
--
-- ⚠ LIGNES COURTES (editeur Supabase). Rejouable.

alter table public.bien_profil
  add column if not exists strategie text
    check (strategie in (
      'juste', 'agressif', 'qualite'));

alter table public.bien_profil
  add column if not exists sejour_min smallint
    check (sejour_min between 1 and 30);

notify pgrst, 'reload schema';
