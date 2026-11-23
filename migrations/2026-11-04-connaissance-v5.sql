-- BASE DE CONNAISSANCE V5, lot 3 : la date de
-- verification et la portee IA. Lignes < 60 car. :
-- collage manuel dans l'editeur Supabase.
--
-- ADDITIVE : deux colonnes, aucune ligne touchee, aucun
-- comportement change. Sans elles le code d'aujourd'hui
-- continue de tourner.
--
-- ⚠ `verifie_le` EST POSEE PAR L'HOTE, JAMAIS PAR LE
-- SYSTEME. C'est tout son interet : une date posee
-- automatiquement dirait « verifie » de ce que personne
-- n'a relu. Elle reste donc NULLE jusqu'au premier
-- enregistrement, et l'ecran lit « jamais verifiee ».
--
-- ⚠ POURQUOI 90 JOURS, et c'est mesure : le prix du
-- champagne annonce par l'IA avait 106 jours. Un badge
-- a 90 aurait sonne 16 jours avant la question du
-- voyageur. Le seuil vit dans le code, pas ici : une
-- regle ecrite deux fois diverge.
--
-- ⚠ `lisible_par_ia` VAUT `true` PAR DEFAUT, et ce
-- defaut est le comportement d'aujourd'hui : l'IA lit
-- toute la base. Poser `false` par defaut aurait coupe
-- l'agent sur l'existant sous couvert de migration.
-- La valeur `false` est reservee aux secrets d'acces
-- (code d'immeuble), decision de Thierry du
-- 3 novembre 2026.

alter table public.knowledge
  add column if not exists verifie_le timestamptz;

alter table public.knowledge
  add column if not exists lisible_par_ia boolean
  not null default true;

-- L'ecran liste les entrees d'un bien, par compte.
-- Sans index, c'est un balayage de toute la table a
-- chaque ouverture du volet.
create index if not exists
  idx_knowledge_bien
  on public.knowledge (user_id, property_id, type);
