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
  imposé), au format HH:MM, avec l'aide « L'heure est obligatoire. ».
- **Vider une heure est refusé** : le bouton « Enregistrer » est inactif sur un
  champ vide (il suit le champ ; Entrée aussi), et le serveur refuse en 400
  (`heure_obligatoire`). Chaque refus dit sa cause : heure obligatoire, heure
  attendue au format HH:MM, logement qui n'est plus en service.
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
même valeur que la fiche. Une heure enregistrée depuis la base s'écrit **dans
la fiche** (même writer, mêmes refus : `heure_obligatoire`,
`heure_illisible`) : plus aucune ligne `checkin` / `checkout` n'entre dans la
base.

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
  fiche serait annoncée au voyageur sans que le code la suive. L'heure lue est
  toujours mise au format « HH:MM » (`heureDeLaFiche` → `normaliserHeure`) : la
  fenêtre découpe sur « : », et une fiche à « 11h » aurait fait mourir le code
  à 01:00 ; une heure illisible devient le défaut, des deux côtés. L'alerte
  « PIN toujours absent » règle son délai sur l'arrivée de la fiche (repli :
  la réservation, puis 15:00) ; le code, lui, s'ouvre à l'instant de sa
  création.
  **Cas étroit, assumé** : sur un logement Beds24 dont la fiche est encore
  vide (première synchro pas encore passée, ou matérialisation sautée), le
  message d'arrivée et son code lisent l'heure Beds24, le rafraîchissement
  du code et le message au changement de réservation lisent la fiche, donc le
  défaut. Une seule synchro réussie remplit la fiche et referme l'écart.
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

## 4 bis. L'ordre des gestes de la reprise (constat 1 de la relecture 1)

Le nouveau code ne lit plus la base : entre le déploiement et la reprise, un
logement dont l'heure n'est que dans la base perdrait son heure (Cœur de vie 23
dirait « départ 10:00 » au lieu de 12:00, et son code finirait à 11:00 au lieu
de 13:00). Dans l'autre ordre, un logement Beds24 perdrait son heure pour de
bon (l'ancienne synchro réécrit la fiche, la ligne de base serait partie). D'où
une reprise en deux temps, toujours sur le go de Thierry :

1. **Avant le merge** : `scripts/reprendre-heures-fiche.js` à blanc, puis
   `--copier`. La fiche reçoit les heures de la base ; **aucune ligne n'est
   retirée**. L'ancien code lit encore la base en premier : rien ne change pour
   le voyageur.
2. **Merge et déploiement**, vérifié au SHA complet.
3. **Dans le quart d'heure** : à blanc, puis `--go`. Le script recopie ce qui a
   bougé entre-temps (un logement Beds24 réaligné par l'ancienne synchro, une
   heure saisie dans l'ancien bloc) et retire les lignes de base.

Chaque écriture exige que la fiche vaille encore ce que le plan a lu (vide pour
une copie, la valeur lue sinon) : une heure saisie entre-temps n'est jamais
écrasée, le geste est « sauté » et dit. Une ligne de base cachée à l'IA
(« Hors IA ») est montrée avant d'écrire : la retirer rend l'heure à l'IA. Les
lignes de base sans logement sont comptées.

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
| Cadenas « Hors IA » sur une ligne d'heure | **retiré de l'écran** : l'heure est une donnée de la fiche, que l'IA lit comme l'adresse. Tant que la ligne existe en base, l'IA ne lit pas l'heure ; la reprise montre ces lignes avant de les retirer |
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
   `knowledge`). Le rafraîchissement du code (`cron-access`) fait une lecture
   de `properties` au lieu d'une lecture de `knowledge` : **une pour une**.
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
  celle du message qui porte le code — au générateur (`processArrivalCodes`)
  comme au rafraîchissement (`cron-access`) ; une fiche à « 11h » donne 11:00
  aux deux ; l'alerte PIN lit l'arrivée de la fiche.
- Écriture : HH:MM accepté, « 25:00 », « 16h », vide refusés ; membre délégué
  refusé en 403 ; bien d'un autre compte refusé.
- Écran : « À compléter » + défaut ; avertissement Airbnb seulement avec un
  canal Airbnb actif et mappé et une arrivée après 16:00 ; archivé sans crayon.
- Reprise : à blanc n'écrit rien ; écart montré ; forme illisible signalée ;
  `--go` copie puis supprime la ligne de base.
- Suite complète à zéro rouge, et contre-épreuve à horloge décalée.

Fichiers ajoutés par les correctifs de la relecture 1, hors de la liste
accordée et déclarés au chef de file : `pages/logement.html` (bouton inactif,
message par refus), `scripts/rejouer-message-offline.js` (heures de la fiche),
`tests/logement-page-dom.test.js`.

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

## 9. Relecture 1 (23 novembre 2026) — rapport recopié tel quel

Agent distinct, lecture seule. Arbre `/home/claude/hotesmart-heures`, branche
`logement-heures`, plage
`7a558b4b8eab2dbf746e77b6b74c024df77e4d1e..1d5fe10cd27931ba0caf66390a20ee5d003800df`.
Trace sur disque : `/home/claude/revues/heures-logement-relecture-1.md`.

# Relecture 1 — lot « heures du logement » (étape 1)

- **Arbre lu** : `/home/claude/hotesmart-heures` (rien lu dans `/home/claude/hotesmart` ni dans un autre worktree)
- **Branche** : `logement-heures`
- **SHA de tête lu** (`git rev-parse HEAD`) : `1d5fe10cd27931ba0caf66390a20ee5d003800df`
- **Plage** : `7a558b4b8eab2dbf746e77b6b74c024df77e4d1e..1d5fe10cd27931ba0caf66390a20ee5d003800df` (2 commits, 25 fichiers)
- Tests, mutations et contre-épreuves faits sur des copies `git archive` dans `/tmp/revue-heures`, plus un clone temporaire pour les 2 fichiers de test qui appellent `git`. `git status --short` est vide à la fin.

**Aucun constat de sécurité.** Vérifié : la garde « titulaire » passe avant toute lecture. Le bien est résolu dans les biens du compte, archivés exclus. L'`update` est filtré par `id` + `user_id` + `archive_le is null`. La bascule `bienId` ne va que vers le compte de l'appelant. Tout ce qui est rendu passe par `esc` (aucun XSS). Les références texte et les UUID ne sont jamais comparés entre eux : `provider_property_id` est lu en texte dans `cron-access`, `String(ref)` sert pour `knowledge` dans le script, l'UUID sert pour `properties` dans l'endpoint.

Mesures : suite complète sur la tête, **9247 tests, 9244 verts**. Les 3 rouges viennent de l'archive sans `.git` (`reponse-partenaire-execution` ×2, `v2-marche-aucune-ecriture-calendrier` ×1, qui appellent `git show` / `git diff`) ; ils sont **16/16 verts** dans un clone du même SHA. À horloge décalée (J+0, 5, 15, 40, 60, 200, 400), les 7 fichiers de test touchés rendent 146/146 à chaque palier. Contre-épreuve : les tests du lot, lancés contre le code de base, rougissent. Seuls `lib/heures-logement.js` neuf et `tests/heures-logement.test.js` sont ajoutés à la copie. On obtient 10 rouges sur 13 dans `heures-logement.test.js` (les 3 verts : `normaliserHeure`, `planDeReprise`, et « archivé », ce dernier rougit sous mutation), 4 dans `connaissance-ecran`, 4 dans `beds24-props-adresse-fiche`, 2 dans `booking-changes-dispatch`, 1 dans `balises`, 1 dans `connaissance`, 1 dans `cron-messages-placeholders`.

## Constats

1. **Défaut — envoi au voyageur, ordre déploiement / reprise non écrit.** Fichiers : `lib/balises.js:80-83` (`fiche: true`), `scripts/reprendre-heures-fiche.js`, `docs/specs/spec-heures-logement.md` §4.
   **Après le déploiement et avant le `--go`**, les biens dont l'heure n'est que dans la base perdent cette heure. Mesuré sur un bien comme Cœur de vie 23 (base 18:00 / 12:00, fiche vide). Messages programmés : « départ 10:00 » au lieu de 12:00. Message du code : « départ 10:00 ». Fenêtre du code : fin à 12:00 au lieu de 13:00. L'IA dit aussi 10:00. Établi par un script qui compare `remplacerBalises` et `buildMessageDetaille` sur la base et sur la tête.
   **Dans l'ordre inverse (reprise avant le déploiement), une heure est perdue pour de bon** sur un bien Beds24. L'ancien `syncPropertyHours` réaligne la fiche sur Beds24 à chaque cycle. Le script, lui, a déjà supprimé la ligne de base.
   La spec dit seulement « lancé hors du merge, sur le go de Thierry ».
   **Correction** : écrire l'ordre dans la spec : déploiement vérifié au SHA, puis reprise à blanc, puis `--go` dans le même quart d'heure, avant le prochain envoi programmé. Une autre option : une reprise en deux temps, avec un mode copie seule (aucune suppression) avant le merge et la suppression après.

2. **Défaut — S3 cassable par une heure de fiche hors « HH:MM ».** Fichier : `lib/balises.js:407-413`.
   `heureDeLaFiche` rend la valeur brute (trim seulement), alors que la fenêtre (`combineDateAndTime`) découpe sur « : ». Exemple mesuré : une fiche à « 11h » donne un message « Depart 11h » et une fin de code à `2026-12-03T00:00:00Z`. Le code meurt donc à 01:00 le jour du départ, dix heures avant le départ annoncé.
   Ce cas est atteignable de deux façons. Par les valeurs héritées jusqu'au `--go` (action `normaliser`). Et pour toujours par les `fiche_illisible`, que la reprise laisse en place.
   Les chemins ne sont pas non plus homogènes. Le chemin Beds24 normalise (`cron-beds24-props.js:54-55`). Channex, le dispatcher et `cron-access` envoient la valeur brute (« 16:00:00 » part telle quelle). L'avertissement Airbnb se tait sur « 18:00:00 ».
   **Correction** : `heureDeLaFiche` rend `normaliserHeure(v)`. Une valeur illisible devient `null`, donc le défaut, des deux côtés. Ajouter un test : une fiche à « 11h » donne un message et une fenêtre cohérents.

3. **Défaut — test : la fenêtre du code du générateur n'est couverte par aucun test.** Fichiers : `lib/cron-arrival-code.js:348`, `tests/heures-logement.test.js`.
   Mutation : `fenetreDuCode(todayArrival.departure, knowledge.checkout)` (retour à la base). Résultat : **548/548 verts** sur `heures-logement` et sur les 15 fichiers qui chargent `cron-arrival-code`, `cron-channel-props` ou `cron-access`. Seul le rafraîchissement (`cron-access`) est testé. Or §7 demande « la fenêtre finit à l'heure de départ de la fiche, la même que celle du message qui porte le code ».
   Même trou pour `pinAlertDue` (`:72`) : la mutation reste verte.
   **Correction** : un test qui traverse `processArrivalCodes`, avec les doubles de `tests/arrival-code-adresse-fiche.test.js`. Il pose une fiche à 12:00 et une base à 09:00, puis vérifie que `ends_at` du claim vaut départ + 13:00 Paris et que le texte dit 12:00.

4. **Défaut — envoi au voyageur, un appelant de `replisDuBien` laissé à l'ancien contrat.** Fichier : `lib/balises.js:397-398`. Appelant lu hors du diff : `scripts/rejouer-message-offline.js:207-213`.
   Le script de rejeu construit `property` avec `checkInStart: k.checkin || bien.checkin_time` et sans `checkin_time` / `checkout_time`. Il le passe ensuite à `generateAutoMessage`, puis à `replisDuBien`. Mesuré : `replisDuBien({ checkInStart: '15:00', checkOutEnd: '12:00' })` rend `checkin: null, checkout: null`. Le brouillon rejoué dit donc 18:00 / 10:00, quelle que soit la fiche, puis part tel quel avec `--execute`.
   **Correction** : poser `checkin_time: bien.checkin_time, checkout_time: bien.checkout_time` dans ce script, ou le citer en §7 bis.

5. **Défaut (écart à la spec, écran) — « Enregistrer inactif sur un champ vide » n'est pas codé.** Fichier : `shared/accueil-voyageur.js:88-95`. Appelant lu : `pages/logement.html` `enregistrerAccueil`.
   Le bouton est `type="button"` hors de tout formulaire, donc `required` ne bloque rien. Un champ vide part au serveur, qui répond 400 `heure_obligatoire`. La page affiche alors `fiche.accueil_echec`, « L'info n'a pas été enregistrée. Réessayez. ». C'est aussi le message affiché pour `heure_illisible` et pour le 409 `bien_indisponible`. L'hôte réessaie sans savoir pourquoi.
   **Correction** : désactiver le bouton tant que le champ heure est vide (écouteur `input`), et donner un message propre à chacun des trois codes.

6. **Mineur — Beds24 : le générateur et le rafraîchissement peuvent diverger quand la fiche est vide.** Fichiers : `lib/cron-access.js:112-119`, `lib/booking-changes-dispatch.js:128-131`, `lib/cron-beds24-props.js:54-66`.
   L'envoi Beds24 lit « fiche, sinon heure Beds24 ». Le rafraîchissement du code et le dispatcher lisent la fiche seule. Si la matérialisation est sautée (archives ou clés migrées illisibles : `materializeBeds24Properties` sort avant `syncPropertyHours`), la fiche reste vide. Le code d'arrivée finit alors à H Beds24 + 1 h, le code rafraîchi à 12:00. Avec une heure Beds24 de 12:30, le code rafraîchi finit **avant** le départ annoncé. De même, `booking_confirmed` dit 18:00 quand le message d'arrivée dit l'heure Beds24.
   Le cas est étroit : une seule synchro réussie remplit la fiche.
   **Correction** : l'écrire dans la spec (S3, S4), ou faire lire au rafraîchissement le même repli que la décoration.

7. **Mineur — « Hors IA » : l'écran et l'IA divergent, et la reprise efface sans montrer.** Fichiers : `lib/connaissance.js:194`, `scripts/reprendre-heures-fiche.js:61`.
   Tant qu'une ligne `checkin` avec `lisible_par_ia=false` reste en base, `buildKnowledgeText` (`lib/cron-classify.js:1618`, lu hors du diff) retire l'heure de la fiche à l'IA. Le test `tests/connaissance-page.test.js:121`, non modifié, l'exige. Pendant ce temps, l'écran montre l'heure sans cadenas (`horsIa: false`).
   La reprise supprime ces lignes sans lire `lisible_par_ia`. L'IA se met donc à annoncer une heure que l'hôte lui avait cachée, sans que personne ne le voie (S6).
   **Correction** : sélectionner `lisible_par_ia` dans le script et ajouter ces lignes à « À montrer à Thierry ».

8. **Mineur — reprise : écriture sans condition, et `--go` non testé.** Fichier : `scripts/reprendre-heures-fiche.js:90-104`.
   L'`update` ne vérifie pas que la fiche vaut encore ce que le plan a lu. Si l'hôte saisit son heure dans la nouvelle fiche entre la lecture et l'écriture, l'heure de la base l'écrase (actions `copier` et `ecart`).
   Les lignes de base sans logement correspondant ne sont ni comptées ni montrées.
   L'ordre des gestes est juste à la lecture (la fiche d'abord, la suppression seulement si `data` est revenu). Mais seul le plan pur est testé : « à blanc n'écrit rien » et « `--go` copie puis supprime » (§7) ne le sont pas.
   **Correction** : conditionner l'`update` par `.is(col, null)` pour `copier` ou par `.eq(col, ficheBrute)` sinon (même geste que la synchro Beds24), compter les lignes orphelines, et ajouter un test du script avec un double Supabase.

9. **Mineur — restes dans le diff.**
   - `lib/cron-arrival-code.js:347` : `const knowledge = …` n'est plus lu dans `ensureCodeCreated`. C'est une variable morte, et une lecture de `knowledge` pour rien si `connaissance` manque.
   - `lib/message-builder.js:32-36` : le commentaire dit encore « ici l'horaire de repli vient de la RÉSERVATION … là-bas du BIEN ». C'est faux depuis le lot.

10. **Mineur — exactitude de la spec.** Fichier : `docs/specs/spec-heures-logement.md`.
    - §2.2 annonce un refus `heure_dans_la_fiche`. Le code écrit dans la fiche (§4) et ce code d'erreur n'existe nulle part.
    - §2.1 et §4 : « Enregistrer inactif » n'est pas codé (constat 5).
    - §3 S3 : « l'heure d'ouverture du code garde son repli 15:00 » est inexact. Le code s'ouvre à l'instant (`startsAt = maintenant`) ; 15:00 est l'arrivée supposée par `pinAlertDue` pour régler le délai d'alerte.
    - §6.7 : « dans la ligne du bien déjà lue … une requête de moins par code » est faux. `cron-access` fait sa propre lecture (`:113-117`) après celle du kill-switch, et §6.8 dit d'ailleurs 1 → 1.
    - §5 : « Cadenas Hors IA retiré » est vrai pour l'écran, pas pour l'IA tant que la ligne existe (constat 7).
    - §7 : le test du code d'accès ne couvre que le rafraîchissement (constat 3).
    - L'ordre déploiement / reprise manque (constat 1).

Vu sans constat :
- `.or('col.is.null,col.eq.')` : la grammaire de PostgREST accepte une valeur vide. Ce n'est pas éprouvé contre une vraie base.
- La règle « en vente » (`pastillesDesCanaux`, état `vente`) est bien importée.
- Les trois fichiers i18n ont 1643 clés (`scripts/i18n-check.js` vert).
- `--warn` existe dans `theme.css`.
- Les tests retournés gardent une intention juste. Aucun test n'a été supprimé : les 3 `test(` retirés sont renommés et inversés.

Rapport écrit dans `/home/claude/revues/heures-logement-relecture-1.md`.

### Ce qui en est fait

Aucun constat de sécurité. Lot « envoi au voyageur » : une relecture de plus,
limitée au diff de ces correctifs, et c'est la dernière.

1. Reprise en deux temps : `--copier` avant le merge, `--go` dans le quart
   d'heure après le déploiement (§4 bis, en-tête du script).
2. `heureDeLaFiche` rend `normaliserHeure(v)` ; test « fiche à 11h » : message
   et fenêtre à 11:00.
3. Tests du générateur (`processArrivalCodes` : fin du code = départ de la
   fiche + 1 h, base ignorée) et de l'alerte PIN (`pinAlertDue`, exportée pour
   lui).
4. `scripts/rejouer-message-offline.js` pose `checkin_time` / `checkout_time`
   de la fiche.
5. Bouton inactif sur un champ heure vide (`etatBoutonHeure`, branché sur
   `change` — la page interdit `input` —, à l'ouverture, après un refus ; Entrée
   suit le bouton) ; un message par refus (`cleRefusInfo` : obligatoire,
   illisible, logement plus en service). Deux clés i18n.
6. Écrit en S3 comme cas étroit assumé.
7. La reprise lit `lisible_par_ia` et montre ces lignes avant d'écrire.
8. Écriture conditionnelle (vide pour une copie, la valeur lue sinon), geste
   « sauté » dit, lignes orphelines comptées ; `executerReprise` sorti dans
   `lib/heures-logement.js` et testé (`--go`, `--copier`, fiche changée).
9. Variable morte retirée ; commentaire de `message-builder` corrigé.
10. Spec corrigée (§2.1, §2.2, S3, §5, §6.7, §7, §4 bis).
