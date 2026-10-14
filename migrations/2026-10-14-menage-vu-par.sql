-- QUI a dit « vu » (14 octobre 2026) — Lot Menages V5.
-- Complement de 2026-10-14-menage-vu-le, a coller APRES.
-- NON APPLIQUEE : staging puis prod, par Thierry.
-- Lignes < 60 car. : collage manuel dans l'editeur.
--
-- POURQUOI, ET C'EST UN CONSTAT DE REVUE (20fb83d).
-- `vu_le` seul dit QUAND quelqu'un a valide, pas QUI.
-- Or un menage change de main : l'hote reassigne, une
-- collegue accepte, le moteur pose une remplacante
-- apres un refus. La validation d'Anna restait alors
-- collee au menage passe chez Bea : Bea n'avait ni
-- bouton ni relance, et l'hote lisait « A jour » sur
-- quelqu'un qui n'avait jamais rien lu. C'est le trou
-- meme que ce lot existe pour fermer, rouvert par le
-- geste le plus courant de l'hote.
--
-- POURQUOI PAS « REMETTRE A NULL A CHAQUE
-- REASSIGNATION ». Il faudrait le faire dans les six
-- chemins qui ecrivent `provider_id` aujourd'hui, et
-- dans tous ceux qui viendront. Rien ne le garantit, et
-- aucun test ne peut attraper un septieme chemin qui
-- n'existe pas encore. La donnee porte donc son
-- proprietaire : une validation ne vaut que pour la
-- personne qui l'a posee, et un changement de porteuse
-- la rend caduque TOUT SEUL.
--
-- LECTURE : valide <=> `vu_le is not null`
--                  ET `vu_par = provider_id`.

alter table public.menages
  add column if not exists vu_par uuid;

comment on column public.menages.vu_par is
  'Qui a dit « vu » sur ce menage (profiles.id).
   Une validation ne vaut que si vu_par = provider_id :
   un changement de porteuse la rend caduque.';

-- RATTRAPAGE : les validations deja posees appartiennent
-- a la porteuse du moment — c'est la seule lecture
-- possible, et elle est exacte pour les deux gestes que
-- la migration precedente a rattrapes (accepter, prendre)
-- comme pour tout « Vu » pose avant ce complement.
update public.menages
   set vu_par = provider_id
 where vu_le is not null
   and vu_par is null
   and provider_id is not null;
