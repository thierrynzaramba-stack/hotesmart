# Spec — Heures d'arrivée et de départ : obligatoires, une seule source, la fiche

**Statut : à valider par Thierry.** Fil logements. Branche `logement-heures`,
partie de main `7a558b4b`. Demande d'origine : fil PWA (lot 4, alerte « ménage
pas fait 30 min avant l'arrivée », réglée sur `properties.checkin_time`).

Lot qui touche l'**envoi au voyageur** (les heures remplacent `{checkin}` et
`{checkout}` dans les messages, l'IA les lit) **et la fenêtre de validité du
code d'accès** : jusqu'à trois reviews, et Thierry présent pour tester juste
après le merge.

**Ordre** (chef de file, 22 novembre 2026) : le merge attend la clôture du lot 1
de la dette 129 — `lib/cron-beds24-props.js` est un writer de la couche sync,
et la place « cœur et sync » est tenue.

## 0. Les décisions de Thierry (22 novembre 2026)

1. **L'heure d'arrivée et l'heure de départ d'un logement sont OBLIGATOIRES.**
2. **Une seule source : la fiche du logement** (`properties.checkin_time`,
   `properties.checkout_time`), comme l'adresse le 8 novembre (option A). Le
   bloc « Accueil du voyageur » écrit là. Les heures déjà saisies dans ce bloc —
   rangées jusqu'ici dans la base de connaissance (`knowledge`, lignes `fixed`
   `checkin` / `checkout`) — y sont reprises. Messages, IA, aperçu, code
   d'accès et alerte du fil PWA lisent la même valeur.
3. **Logement Beds24 : l'heure saisie dans HôteSmart l'emporte** (option A). La
   synchronisation Beds24 ne remplit l'heure que si elle est vide ; elle
   n'écrase jamais une heure saisie.
4. **Logement existant sans heure : « À compléter »** en rouge dans la fiche,
   et d'ici là le voyageur reçoit l'heure par défaut, comme aujourd'hui :
   18:00 à l'arrivée, 10:00 au départ (option A).
5. **Airbnb : l'arrivée est désormais au plus tard à 16:00.** Un logement ouvert
   sur Airbnb dont l'heure d'arrivée est après 16:00 affiche un avertissement
   dans la fiche. L'enregistrement reste possible (lecture de la demande de
   Thierry, qu'il n'a pas corrigée). Je n'ai pas trouvé cette limite dans la
   politique publique d'Airbnb du 20 novembre 2026 : la règle vient de ce que
   Thierry a vu dans son compte.
6. **Découpage** (23:03) : étape 1 sans `api/channel-property.js` ni
   `lib/logement/lecture.js` ; **étape 2**, après la sortie de
   `fix-garde-suppression-bien` : le refus de créer un logement sans ses heures.

## 1. Mesure du 22 novembre 2026 (prod, lecture seule, compte de Thierry)

| logement | état | heures tapées dans le bloc (base) | canal Airbnb |
|---|---|---|---|
| Cœur de vie 23 | en service | arrivée 18:00, départ 12:00 | actif, mappé |
| La bulle | en service | arrivée 18:00, départ 12:00 | actif, mappé |
| Ofuro Futari | en service | aucune (le voyageur reçoit 18:00 / 10:00 par défaut) | actif, mappé |
| Colomiers | archivé | aucune | aucun |

Conséquences, à savoir avant la recette :
- après la reprise, **Cœur de vie 23 et La bulle afficheront l'avertissement
  Airbnb** (18:00 est après 16:00) ;
- **Ofuro Futari sera « À compléter »** ;
- `properties.checkin_time` n'a pas pu être lu par la fiche (elle ne le publie
  pas) : le script de reprise, à blanc, dira ce qu'il contient pour chaque
  logement avant toute écriture.

## 2. Ce que l'hôte voit

### 2.1 La fiche du logement, bloc « Accueil du voyageur »

| ligne | valeur montrée |
|---|---|
| Heure d'arrivée | l'heure de la fiche ; sinon **« À compléter »** en rouge, suivi de « le voyageur reçoit 18:00 par défaut » |
| Heure de départ | idem, défaut 10:00 |

- Le crayon ouvre un champ **heure** (`input type="time"`, pas de 5 minutes
  imposé), au format HH:MM.
- **Vider une heure est refusé** : le bouton « Enregistrer » est inactif sur un
  champ vide, et le serveur refuse en 400 (`heure_obligatoire`).
- **Avertissement Airbnb** (décision 5), sous la ligne « Heure d'arrivée » :
  « Airbnb demande une arrivée au plus tard à 16:00. » quand le logement a un
  canal Airbnb **actif et mappé** (`canaux_du_bien`, déjà dans la fiche) et une
  heure d'arrivée après 16:00. Rien ne change dans l'enregistrement.
- La mention « synchronisée » disparaît : il n'y a plus qu'une heure, celle de
  la fiche (Beds24 la remplit si elle est vide, décision 3).
- Le reste du bloc (téléphone, wifi, autres infos pour l'IA) ne change pas, et
  le bloc reste **réservé au titulaire** (garde serveur existante, 403).
- Un logement **archivé** montre ses heures sans crayon, comme aujourd'hui, et
  n'est pas « À compléter ».
- Le reste de la fiche (nom, photo…) reste modifiable même si les heures
  manquent : une heure manquante ne bloque rien d'autre.

### 2.2 La base de connaissance

Les lignes « Heure d'arrivée » et « Heure de départ » de la base montrent la
même valeur que la fiche, avec le même renvoi vers la fiche que l'adresse
aujourd'hui. Écrire une ligne `checkin` ou `checkout` dans la base est refusé
(`heure_dans_la_fiche`), comme `adresse` depuis le 8 novembre.

## 3. Les règles de sûreté

- **S1. Une seule source.** Personne ne lit plus une heure dans `knowledge`.
  Les balises `{checkin}` / `{checkout}` deviennent des balises **de la fiche**
  (`fiche: true`, comme `adresse`), avec leur défaut (18:00 / 10:00).
- **S2. Le voyageur reçoit ce que l'hôte voit.** Messages programmés, messages
  au changement de réservation (`lib/booking-changes-dispatch.js`), IA, aperçu
  de la base et message du code d'accès (`lib/message-builder.js`) lisent la
  même valeur, dans le même ordre : l'heure de la fiche, puis le défaut.
- **S3. Le code d'accès ne finit jamais avant le départ annoncé.** La fenêtre
  du code (`lib/cron-arrival-code.js`, `lib/cron-access.js`) lit l'heure de
  départ **de la fiche**, comme le message qui porte le code. Aujourd'hui elle
  la lit dans la base : sans ce changement, une heure de départ saisie dans la
  fiche serait annoncée au voyageur sans que le code la suive. L'heure d'ouverture
  du code garde son repli prudent actuel (15:00) quand la fiche est vide.
- **S4. Beds24 ne remplit que le vide.** `syncPropertyHours` n'écrit plus une
  heure déjà présente. Sur le chemin Beds24 de l'envoi, l'objet du partenaire
  porte l'heure de la fiche (comme `adresseFiche`), jamais `checkInStart` en
  premier.
- **S5. Format.** Le serveur n'accepte que HH:MM (00:00 à 23:59) et enregistre
  « HH:MM ». Les heures déjà en base sous une autre forme lisible (« 16h »,
  « 16h30 », « 16:00:00 ») sont normalisées par la reprise ; une forme illisible
  est montrée à Thierry, jamais devinée.
- **S6. Rien n'est effacé en silence.** La reprise écrit à blanc d'abord, montre
  chaque écart (une heure Beds24 en fiche différente de l'heure tapée dans la
  base), et n'écrit que sur le go de Thierry.

## 4. Ce qui change, fichier par fichier (étape 1)

- `lib/balises.js` : `checkin` / `checkout` en `fiche: true` (défaut gardé) ;
  `replisDuBien` ne prend que l'heure de la fiche (`checkinFiche` posé sur
  l'objet Beds24, sinon `checkin_time`).
- `lib/connaissance.js` : `faits` montre l'heure de la fiche, « À compléter »
  quand elle manque (`aCompleter`), le défaut en mention ; les lignes de la base
  sont ignorées pour ces deux clés.
- `api/ecran/connaissance.js` : `enregistrer` avec la clé `checkin` /
  `checkout` écrit `properties.checkin_time` / `checkout_time` du bien désigné
  (titulaire, biens du compte), valide HH:MM, refuse le vide ; refuse une ligne
  de base pour ces clés.
- `shared/accueil-voyageur.js` : champ heure, « À compléter », avertissement
  Airbnb, enregistrement inactif sur un champ vide.
- `shared/logement-fiche.js` : passe au bloc l'information « Airbnb actif »
  (déjà dans `fiche.canaux`, aucune lecture en plus).
- `lib/booking-changes-dispatch.js`, `lib/message-builder.js`,
  `lib/cron-arrival-code.js`, `lib/cron-access.js` : lisent l'heure de la fiche.
- `lib/cron-beds24-props.js` : ne remplit que le vide ; pose l'heure de la
  fiche sur l'objet du partenaire.
- `shared/i18n` fr/en/es : ajouts de clés.
- `lib/heures-logement.js` (nouveau) : la forme « HH:MM » (`normaliserHeure`)
  et le plan de la reprise (`planDeReprise`), partagés par le writer, la
  synchro Beds24 et le script.
- `shared/ui.css` : une règle (`.kb-avertissement`, couleur d'avertissement).
- `docs/kb/codes-acces.md` : la fenêtre du code lit l'heure de la fiche.
- `scripts/reprendre-heures-fiche.js` (nouveau) : la reprise base → fiche, à
  blanc par défaut, `--go` pour écrire ; après la copie, les lignes `checkin` /
  `checkout` de la base sont supprimées (elles ne sont plus lues par personne).
  Lancé hors du merge, sur le go de Thierry.

Aucune migration : les deux colonnes existent (`text`). Pas de contrainte en
base dans cette étape (la validation est au writer, unique).

## 5. Inventaire

| fonction / information | sort |
|---|---|
| Heure d'arrivée / de départ dans le bloc « Accueil du voyageur » | **conservée**, désormais écrite dans la fiche |
| Mention « synchronisée » (heure Beds24) | **retirée** : une seule heure, celle de la fiche |
| Mention « par défaut » | **déplacée** dans « À compléter — le voyageur reçoit 18:00 par défaut » |
| Lignes `checkin` / `checkout` de la base de connaissance | **déplacées** dans la fiche par la reprise, puis supprimées |
| Écriture Beds24 des heures à chaque synchro | **restreinte** au vide (décision 3) |
| Défaut 18:00 / 10:00 dans les messages | **conservé** (décision 4) |
| Repli 15:00 d'ouverture du code d'accès | **conservé** |
| Avertissement Airbnb après 16:00 | **nouveau** |
| Refus de créer un logement sans heures | **étape 2** |
| Cadenas « Hors IA » sur une ligne d'heure | **retiré** : l'heure est une donnée de la fiche, que l'IA lit comme l'adresse ; la reprise supprime ces lignes |
| Heure « par défaut » d'un logement archivé | **conservée**, sans « À compléter » (il ne loue plus) |

## 6. Case performance

1. Un écran = un endpoint : **sans objet**, aucun appel ajouté — la fiche et la
   base gardent leur endpoint.
2. Donnée non urgente : **sans objet**, l'heure est une donnée de la fiche, lue
   avec elle.
3. Cache navigateur : **sans objet**, rien de mis en cache.
4. `private, no-store` : inchangé sur les deux endpoints.
5. Fichiers statiques versionnés : les modules modifiés gardent leur
   versionnage actuel.
6. Lecture tronquée : **sans objet**, lectures par bien.
7. Budget : la fiche ne fait **aucune requête de plus** (l'information Airbnb
   est déjà dans `fiche.canaux`) ; l'écriture d'une heure fait **une requête au
   lieu d'une** (un `update` de `properties` au lieu d'un `upsert` de
   `knowledge`). Le cron lit l'heure de départ dans la ligne du bien déjà lue
   (`cron-access`) au lieu d'une lecture de `knowledge` : une requête de moins
   par code.
8. Mesure AVANT / APRÈS (banc des tests de l'endpoint et de la fiche) :
   - fiche du logement : **1 appel**, requêtes inchangées, octets : quatre
     clés i18n et un booléen d'écran en plus, rien en réponse serveur ;
   - écrire une heure : **2 requêtes avant** (lecture des biens + `upsert` de
     `knowledge`), **2 après** (lecture des biens + `update` de `properties`) ;
   - code d'accès (rafraîchissement) : **1 lecture avant** (`knowledge`),
     **1 après** (`properties`).

## 7. Tests attendus

- Fiche seule source : une ligne `checkin` restée dans la base n'est lue ni par
  l'envoi, ni par l'IA, ni par l'écran (contre-épreuve : rouge contre main).
- Beds24 : une heure de fiche n'est jamais écrasée ; une fiche vide est remplie.
- Code d'accès : la fenêtre finit à l'heure de départ de la fiche, la même que
  celle du message qui porte le code.
- Écriture : HH:MM accepté, « 25:00 », « 16h », vide refusés ; membre délégué
  refusé en 403 ; bien d'un autre compte refusé.
- Écran : « À compléter » + défaut ; avertissement Airbnb seulement avec un
  canal Airbnb actif et mappé et une arrivée après 16:00 ; archivé sans crayon.
- Reprise : à blanc n'écrit rien ; écart montré ; forme illisible signalée ;
  `--go` copie puis supprime la ligne de base.
- Suite complète à zéro rouge, et contre-épreuve à horloge décalée.

## 7 bis. Restes datés, hors des fichiers du lot (non touchés)

- `lib/cron-messages.js` (~ligne 1144) : un commentaire dit encore « la chaîne
  `checkInStart` → `checkin_time` y est gardée » ; elle ne l'est plus
  (`replisDuBien`, fiche seule). Commentaire seulement.
- `lib/cron-classify.js` (~ligne 1637) : le chemin « sans le bien » (appelant
  ancien, sans replis) donne encore à l'IA les lignes de base sauf `adresse` —
  donc une ligne `checkin` restée dans la base, jusqu'à la reprise. Après le
  `--go` de la reprise, il n'en reste aucune et le writer n'en crée plus.

## 8. Étape 2 (après `fix-garde-suppression-bien`)

`api/channel-property.js` (création) et `shared/logement-nouveau.js` : les deux
heures sont demandées à la création, et le serveur refuse en 400 une création
sans elles. Spec complétée à ce moment-là.
