-- Un echec de releve se voit, et une disparition
-- totale se confirme avant d'etre ecrite
-- (19 octobre 2026) — suite de la dette 59.
-- Lignes < 60 car. : collage manuel dans l'editeur.
--
-- POURQUOI. Pendant la recette du 19 octobre, un
-- releve a echoue et personne n'a pu le savoir :
-- l'ecran remettait « Reessayer » sans motif, le
-- journal du navigateur n'ecrit que sur localhost, et
-- l'horloge ne gardait que le DERNIER etat — donc
-- impossible de distinguer un hoquet d'une panne qui
-- dure. Une heure de diagnostic pour une panne qui
-- aurait du se lire d'un coup d'oeil.
--
-- CE QUE CES COLONNES AJOUTENT.
--   · `echecs_consecutifs` et `premier_echec_le` : la
--     DUREE d'une panne, pas son dernier instant. Au
--     dela de 24 h, le fondateur est reveille — un
--     `console.error` ne reveille personne.
--   · `disparition_totale_vue_le` et `_nb` : le
--     DISJONCTEUR. Une lecture qui dit que TOUS les
--     canaux d'un compte ont disparu alors qu'il en
--     avait n'ecrit plus `disparu_le` tout de suite :
--     elle est notee, et il faut une SECONDE lecture
--     concordante, au moins une heure plus tard, pour
--     que l'effacement ait lieu.
--
-- POURQUOI LE DISJONCTEUR. Le 19 octobre, on a decouvert
-- qu'un `200` portant une page HTML etait lu comme
-- « ce compte n'a aucun canal » : le writer effacait
-- tout. Le guard de `channelCall` ferme ce cas precis
-- (docs/kb/reponse-200-sans-json.md), mais il ne ferme
-- pas la FAMILLE : un partenaire qui rend une liste
-- vide par erreur, une cle qui change de perimetre, un
-- compte momentanement vu comme vide. Une disparition
-- totale est trop grave pour etre crue du premier coup.

alter table public.canaux_releve
  add column if not exists
    echecs_consecutifs int not null default 0;

alter table public.canaux_releve
  add column if not exists
    premier_echec_le timestamptz;

alter table public.canaux_releve
  add column if not exists
    disparition_totale_vue_le timestamptz;

alter table public.canaux_releve
  add column if not exists
    disparition_totale_nb int;

comment on column
  public.canaux_releve.echecs_consecutifs is
  'Echecs d''affilee. Remis a 0 par la premiere '
  'lecture reussie. Dette 59.';

comment on column
  public.canaux_releve.premier_echec_le is
  'Debut de la panne en cours. null des qu''une '
  'lecture reussit. Sert au seuil de 24 h.';

comment on column
  public.canaux_releve.disparition_totale_vue_le is
  'Premiere lecture ayant annonce la disparition de '
  'TOUS les canaux du compte. L''effacement attend '
  'une seconde lecture concordante, 1 h plus tard.';

comment on column
  public.canaux_releve.disparition_totale_nb is
  'Nombre de canaux vivants au moment de cette '
  'premiere annonce. Une seconde lecture qui en voit '
  'un autre nombre ne confirme rien.';

-- ⚠ ET LA LISTE DES MOTIFS DE `erreur` CHANGE AUSSI.
-- Le commentaire pose par la migration du 19 octobre
-- en annoncait cinq ; il y en a huit, et le huitieme
-- commande tout l'affichage. Une liste recopiee se
-- perime en silence : on la remet a jour ici, dans la
-- migration qui ajoute les motifs.
comment on column public.canaux_releve.erreur is
  'Motif NORMALISE, jamais un message de la base : '
  'injoignable | delai | reponse_invalide | tronquee '
  '| plafonnee | ecriture | echec | suspendu. '
  '`suspendu` = la lecture a REUSSI, seul '
  'l''effacement est reporte par le disjoncteur : '
  'l''ecran de l''hote ne doit RIEN montrer d''anormal '
  '(lib/canaux-du-bien.js, echecVisibleParLHote).';

-- ⚠ AUCUNE DE CES COLONNES NE PORTE DE SECRET : ni
-- jeton, ni cle, ni identifiant interne du partenaire.
-- Des compteurs et des dates. Elles peuvent donc
-- rester dans la lecture client, qui passe deja par
-- can_read(user_id, 'reservations'). L'ecran a besoin
-- de `echecs_consecutifs` pour dire « verification
-- impossible » plutot que de se taire.
