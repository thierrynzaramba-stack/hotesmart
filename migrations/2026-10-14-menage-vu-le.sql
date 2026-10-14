-- « Vu » par la prestataire, menage par menage
-- (14 octobre 2026) — Lot Menages V5.
-- NON APPLIQUEE : staging puis prod, par Thierry.
-- Lignes < 60 car. : collage manuel dans l'editeur.
--
-- POURQUOI. Une prestataire a qui le menage est
-- ATTRIBUE D'OFFICE n'a rien a confirmer : son menage
-- nait `accepted`. Personne ne sait donc si elle l'a
-- lu. `public_tokens.pwa_vue_le` repond a une question
-- voisine mais plus faible — « a-t-elle ouvert sa
-- page ? » — et par LIEN, pas par menage : elle ouvre
-- sa page lundi, l'hote lui ajoute un menage mardi, et
-- rien ne distingue plus les deux.
--
-- CE QUE CETTE COLONNE EST. L'instant ou ELLE a dit
-- « vu » sur CE menage, depuis sa page. Writer unique :
-- api/menages-public.js — le bouton « Vu », et les deux
-- gestes par lesquels elle se saisit deja d'un menage
-- (accepter une proposition, prendre un menage libre),
-- qui valent validation : elle a dit oui.
--
-- LE MEME FAIT, DEUX MOTS. Elle lit « Vu » sur son
-- bouton ; l'hote lit « Non validé » dans sa bulle et
-- sur la fiche. C'est la meme colonne.
--
-- LES DEUX RELANCES. Le cron relance a J-1 et le jour
-- J, a 9 h de Paris, tant que `vu_le` est nul. Les deux
-- marqueurs sont PAR MENAGE : un compteur global
-- relancerait deux fois le meme jour des qu'un cycle
-- echoue au milieu, et une prestataire qui recoit deux
-- fois le meme SMS cesse de les lire.

alter table public.menages
  add column if not exists vu_le timestamptz;

alter table public.menages
  add column if not exists relance_vu_j1_le timestamptz;

alter table public.menages
  add column if not exists relance_vu_j0_le timestamptz;

comment on column public.menages.vu_le is
  'Instant ou la prestataire a dit « vu » sur ce
   menage, depuis sa page. Writer unique :
   api/menages-public.js. Null = non valide.';

comment on column public.menages.relance_vu_j1_le is
  'Relance « non valide » envoyee la veille (9 h Paris).
   Writer unique : lib/cleaning/relance-validation.js.';

comment on column public.menages.relance_vu_j0_le is
  'Relance « non valide » envoyee le jour du menage
   (9 h Paris). Writer unique :
   lib/cleaning/relance-validation.js.';

-- RATTRAPAGE — CE QU'ELLE A DEJA ACCEPTE EST VALIDE.
-- Les deux seuls chemins par lesquels une prestataire a
-- deja dit oui a un menage sont `accepterMenage` et
-- `prendreMenage`, et tous deux laissent leur trace
-- dans `assignment_reason`. Sans ce rattrapage, un
-- menage accepte la semaine derniere et qui part demain
-- serait annonce « non valide » a l'hote, et lui
-- vaudrait deux SMS — pour un oui deja donne.
--
-- ⚠ ET RIEN D'AUTRE N'EST RATTRAPE, VOLONTAIREMENT :
-- un menage attribue d'office n'a jamais ete valide par
-- personne. Le dire est exact, et c'est le point de
-- depart de la relance.
update public.menages
   set vu_le = accepted_at
 where accepted_at is not null
   and vu_le is null
   and (assignment_reason like 'Accepte par %'
     or assignment_reason like 'Pris par %');
