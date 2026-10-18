-- « Derniere ouverture de sa page » (14 octobre 2026)
-- Lot Menages V5, configuration prestataire.
-- NON APPLIQUEE : staging puis prod, par Thierry.
-- Lignes < 60 car. : collage manuel dans l'editeur.
--
-- POURQUOI. L'hote assigne un menage pour apres-demain
-- et n'a aucun moyen de savoir si la prestataire l'a
-- vu. Rien, aujourd'hui, n'enregistre qu'elle a ouvert
-- sa page : `menage_events.read` est un booleen par
-- notification, pose quand elle TAPE sur son fil, sans
-- date. Il dit « elle a acquitte cette notification »,
-- pas « elle a ouvert sa page ».
--
-- CE QUE CETTE COLONNE EST. L'instant de la derniere
-- SYNCHRO SERVEUR REUSSIE du planning de sa PWA.
-- Ecrite par le serveur SEUL, a un seul endroit : le
-- succes du GET planning de api/menages-public.js.
-- Jamais par le navigateur, jamais depuis un
-- localStorage — une PWA hors ligne lit un cache qui ne
-- contient pas le menage neuf : elle ne l'a donc pas
-- vu, et l'alerte doit tenir.
--
-- POURQUOI SUR LE JETON, PAS SUR LE PROFIL. La page
-- EST le lien. Un « Nouveau lien » doit repartir de
-- « Pas encore ouverte », ce que la regeneration du
-- jeton donne gratuitement ici.

alter table public.public_tokens
  add column if not exists pwa_vue_le timestamptz;

comment on column public.public_tokens.pwa_vue_le is
  'Derniere synchro serveur reussie du planning de la
   PWA. Writer unique : le GET de api/menages-public.
   Null = ce lien n''a jamais ete ouvert.';
