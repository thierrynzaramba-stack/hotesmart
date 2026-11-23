# Spec — PWA lot 4 : l'hôte prévenu d'un ménage pas fait avant l'arrivée

Branche : `pwa-lot-4-spec` (partie de `main` `bf8c48e4`). Lot de code : branche
à ouvrir sur go de Thierry, partie de `main` à jour.
Demande de Thierry du 19 novembre 2026 : « il manque une notification au
propriétaire : ménage non marqué fait 30 minutes avant l'heure d'arrivée ».

## 0. En bref

- Un **nouvel événement** du catalogue des alertes de l'hôte, groupe
  « Ménages » : **« Ménage pas fait avant l'arrivée »**.
- Il part **une fois**, quand il reste **30 minutes** avant **l'heure
  d'arrivée réglée sur le logement**, le jour d'une arrivée, si le ménage qui
  précède cette arrivée **n'est pas marqué fait**.
- Il se règle **comme les autres alertes** (« Choisir ce qui vous prévient » :
  canaux, ou coupé), et va au titulaire et aux membres ayant le domaine
  « ménages ». **Pas aux contacts prévenus** (Q51, 23 novembre 2026).
- Seulement pour un logement **confié** à au moins une prestataire (règle du
  3 septembre pour les alertes ménage ; review de l'étape 1).
- Rien ne change pour la prestataire.

## 1. État des lieux (lu sur `main` `bf8c48e4`, 22 novembre 2026)

- **Le catalogue** (`lib/notifications/catalogue.js`) a quatre alertes ménage :
  h `menage_sans_personne`, i `menage_pas_vu`, l `menage_refuse`,
  m `disponibilites_modifiees`. **Aucune ne parle d'un ménage pas fait.**
- **« Fait »** est une ligne de `menage_done` (clé `user_id, property_id,
  booking_id, departure_date`), posée par un seul writer
  (`lib/cleaning/menage-fait.js`), depuis la page de la prestataire ou depuis
  l'écran de l'hôte.
- **L'heure d'arrivée du logement** est `properties.checkin_time`, une colonne
  **texte libre** (« 16:00 », « 16:00:00 », ou vide). L'accueil la lit avec
  `heureCourte` (`shared/aujourdhui.js`) : rien d'exploitable → `null`.
- **Les heures calmes** (`lib/notifications/decision.js`) : une alerte liée à
  une **arrivée d'aujourd'hui** part tout de suite, même pendant les heures
  calmes (règle 3), comme les autres alertes ménage, qui passent le jour du
  ménage en « séjour ».
- **L'écran des réglages** (`pages/settings.html`) reçoit la liste des
  événements **du serveur** : un événement ajouté au catalogue y apparaît sans
  toucher la page.
- **La mémoire « déjà prévenu »** : l'index unique de `message_sent_log` avec
  un UUID sentinelle, comme h (`evenements-menages.js`).

## 2. Décisions de Thierry

| # | Question | Décision |
|---|---|---|
| — | Quelle heure d'arrivée ? | **Toujours celle du logement** (`checkin_time`), jamais celle annoncée par le voyageur (19 novembre 2026) |
| — | Où ranger l'alerte ? | **Un lot à part, après le lot 3** (19 novembre 2026) |
| — | Heures calmes ? | **« Configurable comme les autres »** (19 novembre 2026). Conséquence de la règle existante : liée à une arrivée du jour, elle passe les heures calmes comme les autres alertes ménage ; l'hôte choisit ses canaux ou la coupe. |
| Q49 | Un logement **sans heure d'arrivée réglée** (vide ou illisible) | **Pas d'alerte** pour ce logement tant que l'heure n'est pas réglée, et le guide le dit (22 novembre 2026) |
| Q49 bis | Le logement « À compléter » annonce **18:00** au voyageur (lot `logement-heures`) : l'alerte suit-elle cette heure ? | **Non** : Q49 tient, pas d'alerte tant que l'heure n'est pas réglée (23 novembre 2026) |

## 3. La règle

À chaque cycle du cron (toutes les cinq minutes), pour chaque **arrivée
d'aujourd'hui** (jour de Paris), réservation active du cœur
(`bookings_snapshot`, annulations exclues), sur un logement non archivé :

1. **L'heure** : `checkin_time` du logement, lue comme `HH:MM`, heure de Paris.
   L'alerte est due dès que l'instant dépasse **cette heure − 30 minutes**, et
   jusqu'à la fin du jour d'arrivée (un cycle manqué rattrape ; jamais le
   lendemain).
2. **Le ménage concerné** : dans `menages`, la ligne du même compte et du même
   logement dont `departure_date` est la plus récente **au plus tard le jour de
   l'arrivée**, hors `cancelled`. Le cas courant est le départ du matin même ;
   un logement resté vide plusieurs jours vise le ménage de son dernier départ.
3. **Pas fait** : aucune ligne `menage_done` pour ce ménage (même clé).
4. **Une seule fois** par compte, logement et jour d'arrivée (mémoire
   `message_sent_log`, posée avant l'envoi, retirée si rien n'est parti — le
   geste de h). La même mémoire est posée quand le ménage est trouvé **fait**
   ou qu'il n'y a **aucun ménage** : l'arrivée est tranchée pour la journée et
   n'est plus relue toutes les cinq minutes.
5. **Dans le doute, rien** : `menage_done` illisible → pas d'alerte, l'erreur
   va dans `results.errors`, le cycle suivant relit.

Pas d'alerte :
- marqué fait avant l'échéance ;
- aucun ménage dans `menages` pour ce logement (l'hôte ne suit pas ses ménages
  dans HôteSmart, ou première réservation du logement) ;
- arrivée annulée, logement archivé ;
- heure d'arrivée absente ou illisible (Q49) — le cycle le compte, sans
  rien envoyer.

## 4. Ce que reçoit l'hôte

| | fr |
|---|---|
| titre | « Ménage pas fait — {logement} » |
| corps, prestataire connue | « {prénom} n'a pas marqué fait le ménage. Le voyageur arrive à {heure}. » |
| corps, personne sur le ménage | « Le ménage n'est pas marqué fait, et personne ne l'a pris. Le voyageur arrive à {heure}. » |

Textes en, es sur le même modèle (`lib/notifications/textes.js`). Toucher la
notification ouvre `/menages`. Sujet : celui du ménage
(`menage:<logement>:<jour du ménage>`) — elle remplace une alerte plus ancienne
du même ménage (« pas vu », « sans personne »), comme les autres.

Libellé dans « Choisir ce qui vous prévient » : **« Ménage pas fait avant
l'arrivée »**. Canaux par défaut : ceux de toutes les alertes (notification et
e-mail ; SMS décoché). Urgence par défaut : non — sans effet ici, puisque
l'arrivée du jour la fait déjà passer les heures calmes.

## 5. Architecture (technique)

- `lib/notifications/catalogue.js` : l'événement `menage_pas_fait` (lettre
  suivante libre), groupe et domaine `menages`.
- `lib/notifications/textes.js` : ses textes fr/en/es et son exemple (bouton
  « Tester »).
- `lib/notifications/evenements-menages.js` : `notifierMenagePasFait` (mémoire
  et envoi) et `memoriserPasFait`.
- `lib/cleaning/menage-pas-fait.js` : `prevenirMenagesPasFaits`, l'émetteur —
  lectures, règle du §3, plafond de 20 arrivées par cycle, bilan.
- `api/cron.js` : **une tâche à part**, `menage_pas_fait`, après
  `relance_validation` — mesurée à part dans `cron_stats`, et sa panne ne
  touche pas le cycle ménage. (Écart avec la première version de cette spec,
  qui la logeait dans le cycle ménage sans toucher le cron.)
- KB : `docs/kb/menage-pas-fait.md` (fichier à part : le lot 3 ajoute déjà une
  section en fin de `docs/kb/pwa.md`).
- Lectures du cycle : les arrivées du jour (une requête, bornée, paginée par
  curseur si elle peut passer 1 000 lignes), les logements concernés, leurs
  ménages, leurs `menage_done`, la mémoire — seulement pour les arrivées dont
  l'échéance est passée. Coût mesuré par `cron_stats`
  (docs/kb/cout-du-cron.md).

## 6. Case PERFORMANCE (CLAUDE.md, huit points)

Le lot ne touche aucun écran : l'événement arrive dans « Choisir ce qui vous
prévient » par la réponse existante du serveur.
1. Un écran = un endpoint : sans objet (aucun appel ajouté).
2. Donnée non urgente : sans objet (une alerte d'échéance, temps réel).
3. Cache navigateur : sans objet.
4. `private, no-store` : sans objet (aucun endpoint nouveau).
5. Statiques versionnés : sans objet (aucun fichier statique touché).
6. Lectures tronquées : la lecture des arrivées du jour est bornée et paginée
   par curseur ; les autres sont filtrées par les logements concernés.
7. Budget : sans objet pour les écrans ; pour le cron, un test compte les
   requêtes : un jour sans arrivée, **une** lecture ; des arrivées pas encore
   dues, **deux** (+ les logements) ; une arrivée tranchée n'est plus relue.
8. Mesure AVANT / APRÈS : la réponse des réglages (un événement de plus, en
   octets) et le coût du cycle ménage dans `cron_stats`, sur staging.

## 7. Inventaire

Rien n'est retiré ni déplacé. Une ligne de plus dans « Choisir ce qui vous
prévient », groupe « Ménages ».

## 8. Étapes

1. Catalogue, textes, émetteur et son branchement dans le cycle ménage ; tests
   (règle du §3 cas par cas, heure de Paris et changement d'heure, mémoire,
   plafond, compte des requêtes) ; contre-épreuves ; KB.
2. Guide utilisateur (section des alertes, et l'heure d'arrivée à régler sur
   le logement — Q49), si Thierry l'accorde.

Une review par étape ; suite à zéro rouge aux deux horloges avant chaque push.

**Recette (staging, avec Thierry)** : un logement à heure d'arrivée réglée, une
arrivée aujourd'hui, un ménage non fait — l'alerte arrive à l'heure − 30 min ;
marqué fait avant — rien ; coupée dans les réglages — rien. ⚠ Staging n'a pas
de cron : le cycle se lance par script.

## 9. Limites connues

- **Une alerte, pas de suite** : si le ménage est marqué fait après l'alerte,
  rien ne dit « c'est fait ».
- **La prestataire n'est pas prévenue** par cet événement (hors demande).
- **Heure du logement seulement** : un voyageur qui annonce une arrivée plus
  tôt n'avance pas l'alerte (décision de Thierry).

## 10. Questions ouvertes (à Thierry)

Aucune. Tranchées le 23 novembre 2026 (Thierry, « oui ») :
- **Q50** — Quels logements : **les logements confiés à au moins une
  prestataire** (définition du 3 septembre pour les alertes ménage).
- **Q51** — Les contacts prévenus : **ils ne la reçoivent pas**. (L'ajouter
  toucherait la liste « urgences », qui sert aussi à la reprise des anciennes
  alertes, et la phrase de Réglages : un lot à part, si un jour il le faut.)
