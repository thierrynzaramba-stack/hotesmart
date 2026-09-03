-- ⚠⚠ SUPERSEDE PAR migrations/2026-09-03-ota-reviews-requalification.sql.
-- NE PAS REJOUER SEUL : ce fichier contient une version de ota_reviews_touch()
-- SANS la garde des verdicts humains. Le rejouer supprimerait cette garde en
-- silence — et sa propre requete de verification resterait au vert, puisqu'elle
-- ne cherche que 'ai_analyzed_at'. Rejouer la migration du 3 septembre a la
-- place, ou apres.
--
-- migrations/2026-09-02-ota-reviews-reanalyse.sql
-- Chantier AVIS, lot 4 — reanalyse automatique quand le texte du voyageur change.
--
-- Un verdict de proprete perime sur la fiche prestataire serait pire que pas de
-- verdict du tout : il donnerait tort ou raison a un prestataire sur la foi d'un
-- texte qui n'existe plus.
--
-- POURQUOI UN TRIGGER ET PAS DU CODE. Deux writers alimentent deja ota_reviews
-- (le poll quotidien et le webhook updated_review), et le poll ecrit PAR LOT
-- sans relire l'existant : une comparaison cote JS demanderait une lecture
-- supplementaire par avis, exactement le cout qu'on a supprime en passant a
-- l'ecriture par lot. Le trigger voit OLD et NEW, c'est le seul endroit ou la
-- comparaison est gratuite et ou aucun writer ne peut l'oublier.
--
-- Rejouable. A EXECUTER dans l'editeur SQL Supabase.

create or replace function public.ota_reviews_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();

  -- Le texte du VOYAGEUR seul declenche la reanalyse.
  --
  -- `reply` en est volontairement EXCLU : quand l'hote repond, l'avis change,
  -- mais ce que le voyageur a dit de la proprete ne change pas. Reanalyser sur
  -- `reply` ferait repasser tout l'historique par le modele a chaque reponse,
  -- pour un verdict identique.
  --
  -- `is distinct from` et non `<>` : l'un des deux cotes peut etre NULL, et
  -- NULL <> 'x' vaut NULL, donc faux. La reanalyse serait silencieusement
  -- sautee sur le cas le plus courant — un texte qui apparait la ou il n'y en
  -- avait pas.
  if new.content         is distinct from old.content
  or new.content_public  is distinct from old.content_public
  or new.content_private is distinct from old.content_private then
    new.ai_analyzed_at   := null;
    new.ai_clean_verdict := null;
    new.ai_clean_excerpt := null;
  end if;

  return new;
end;
$$;

-- Le trigger lui-meme existe deja (ota_reviews_touch_trg, migration du lot 1) :
-- seule la fonction change. On le recree malgre tout pour que ce fichier soit
-- autonome et rejouable sur une base neuve.
drop trigger if exists ota_reviews_touch_trg on public.ota_reviews;
create trigger ota_reviews_touch_trg
  before update on public.ota_reviews
  for each row execute function public.ota_reviews_touch();

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════
-- Doit renvoyer 1 ligne, et le corps de la fonction doit contenir ai_analyzed_at.
select tgname,
       (select count(*) from pg_proc
         where proname = 'ota_reviews_touch'
           and prosrc like '%ai_analyzed_at%')  as fonction_a_jour
from pg_trigger
where tgrelid = 'public.ota_reviews'::regclass and not tgisinternal;
