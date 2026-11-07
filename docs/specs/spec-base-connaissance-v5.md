# Spec — Base de connaissance V5 : les réponses prêtes

Chantier ouvert par Thierry le **3 novembre 2026**.
Branche : `kb-v5-base-connaissance`. Worktree : `/home/thierry/hotesmart-kb`.
Recette : **staging** (`ortyofzzdsthlhqmzsnq`).

⚠ **DIRECTION VALIDÉE LE 3 NOVEMBRE 2026, ET ELLE REMPLACE LA PRÉCÉDENTE**, que
Thierry a jugée trop compliquée. Maquette de référence : les cinq captures
`Ordinateur ·` / `Téléphone · Base de connaissance` du 3 novembre 16:26.
Ce qui disparaît de la version d'avant : les « faits » et les « réponses
rédigées » comme deux natures séparées, les balises montrées en `{…}` à l'écran,
et le badge de vérification sur chaque information.

---

## 1. Principe

**La base de connaissance, ce sont des RÉPONSES PRÊTES** — des messages
pré-enregistrés, une liste par logement. Elles servent de base à l'IA **et** aux
réponses manuelles de l'hôte.

- **Les balises restent**, et ce sont **les mêmes que dans les messages
  programmés**. À l'écran elles apparaissent en **étiquettes lisibles** —
  Prénom, Nom wifi, Mot de passe wifi, Heure d'arrivée, Téléphone, Code
  immeuble — **jamais en `{…}`**.
- **Chaque valeur est saisie une seule fois**, dans le bloc **« Infos du
  logement »**, placé **sous** les réponses prêtes.
- **Une valeur vide s'affiche « À remplir » en rouge.**

---
## 2. ÉTAPE 0 — l'inventaire, mesuré en lecture seule le 3 novembre 2026

Toutes les mesures ci-dessous viennent de la **production**
(`cjmrizpdyhrcurmgyrhs`), en lecture seule.

### 2.1 La base aujourd'hui : table `knowledge`, 45 lignes

Colonnes : `id, user_id, property_id, type, key, value, created_at`.
`type` ne prend que deux valeurs : **`fixed`** (un fait, atteint par une balise)
et **`faq`** (une question et sa réponse rédigée, lue par l'IA).

| bien | lignes | `fixed` | `faq` | clés `fixed` présentes |
|---|---|---|---|---|
| **Cœur de vie l 23** | 26 | 8 | 18 | adresse, checkin, checkout, cuisine_cafetiere_bouilloire, equip_nombre_lits, telephone_hote, wifi_mdp, wifi_nom |
| **La bulle** | 18 | 6 | 12 | adresse, checkin, checkout, telephone_hote, wifi_mdp, wifi_nom |
| **Colomiers** | 1 | 1 | 0 | telephone_hote |
| **Ofuro Futari** | 0 | — | — | **aucune ligne** |
| **colomier** (bien de test) | 0 | — | — | **aucune ligne** |

⚠ **Deux biens sur cinq n'ont AUCUNE connaissance**, et Colomiers n'a qu'un
téléphone. Un bien sans base n'est pas un bien « par défaut » : c'est un bien
dont chaque balise part vide.

### 2.2 Les balises et leur syntaxe

Syntaxe actuelle : `{nom_de_la_cle}`, en minuscules avec underscores.

**Balises voyageur, remplacées par `lib/message-builder.js`** (12) :
`{adresse}` `{arrivee}` `{checkin}` `{checkout}` `{code_acces}` `{depart}`
`{logement}` `{nom}` `{prenom}` `{telephone_hote}` `{wifi_mdp}` `{wifi_nom}`

Toutes ne viennent pas de la base : `{prenom}`, `{nom}`, `{arrivee}`,
`{depart}`, `{logement}` viennent de la **réservation**, `{code_acces}` de la
**serrure**. Les six autres viennent de `knowledge` (`type: fixed`).

⚠ **ET LE REMPLACEUR EXISTE EN DEUX COPIES** : `lib/message-builder.js:56` et
`lib/cron-messages.js:948` remplacent les mêmes balises, chacun de son côté.
`cron-messages.js` en porte en plus huit (`{cle}`, `{detail}`, `{dit}`,
`{empreinte}`, `{ou}`, `{quoi}`, `{tentatives}`, `{text}`) qui sont des balises
d'**alertes internes**, pas de messages voyageur. **Deux copies divergent** —
c'est la règle du dépôt, et c'est le premier point que ce chantier doit fermer :
un seul remplaceur, partagé par les trois usages.

### 2.3 La garde « balise sans valeur » existe DÉJÀ, pour les messages programmés

`lib/cron-messages.js:857` porte la table des endroits à remplir :

```
telephone_hote: 'GuestFlow → Base de connaissance → Téléphone hôte'
```

C'est exactement la règle demandée pour les trois usages. Elle n'est donc pas à
inventer : **elle est à étendre**, et son libellé devra suivre le nouvel écran.

### 2.4 Les faits écrits EN DUR dans les modèles, et les contradictions

Mesuré sur les **onze** modèles de `message_templates`, tous actifs :

| bien · modèle | ce qui est écrit en dur | la base dit |
|---|---|---|
| La bulle · `booking_confirmed` | `NUMERO-B`, `NUMERO-C`, « 18h » | `telephone_hote = NUMERO-A`, `checkin = 18:00` |
| La bulle · `menage_done` | `NUMERO-B`, `NUMERO-C`, **adresse** « rue de La bulle », **code immeuble `CODE-IMMEUBLE`** | `telephone_hote = NUMERO-A`, `adresse = adresse complète de La bulle`, **aucune clé ne porte le code immeuble** |
| La bulle · `arrival` | « 18h » | `checkin = 18:00` |
| Cœur de vie l 23 · `booking_confirmed` | `NUMERO-B`, `NUMERO-C`, « 18h » | `telephone_hote = NUMERO-A`, `checkin = 18:00` |
| Cœur de vie l 23 · `menage_done` | `NUMERO-B`, `NUMERO-C`, **adresse** « rue du 23 », le **wifi en texte** | `adresse = adresse complète du 23`, `wifi_nom = FreeBox` |
| Cœur de vie l 23 · `arrival` | « 18h » | `checkin = 18:00` |
| Colomiers · ses 2 modèles | *rien en dur* | — |

⚠ **LA CONTRADICTION LA PLUS NETTE : le téléphone.** La base porte
**`NUMERO-A`** sur les deux biens de Bagnères — et **ce numéro n'apparaît dans
AUCUN modèle**. Les modèles envoient `NUMERO-B` (Tiphaine) et `NUMERO-C`
(Thierry). Donc trois numéros pour un même rôle, et celui que la balise
`{telephone_hote}` enverrait n'est envoyé par personne aujourd'hui.
**Seul Thierry peut dire lequel est le bon.**

⚠ Et le détecteur d'adresse a d'abord **manqué** Cœur de vie l 23, parce que le
modèle écrit « l'horloge » avec une apostrophe typographique (`’`) et la base
avec une apostrophe droite (`'`). Mesure refaite apostrophes normalisées : les
deux `menage_done` portent bien l'adresse en dur. *Conséquence pour le lot :
toute comparaison de texte dans ce chantier normalise les apostrophes.*

### 2.5 Tous les prix de la base — il n'y en a qu'UN

| bien | ligne | prix | écrit le |
|---|---|---|---|
| La bulle | `faq` / « Pack en complément » | **39 €** | 20 juillet 2026 |

Mesure faite par un motif éprouvé (il attrape « 39 €. » et rejette un
non-prix) sur les 45 lignes : **une seule occurrence de prix dans toute la
base**, et c'est celle qui est fausse. Aucun prix dans les onze modèles.

### 2.6 La page actuelle

`apps/agent-ai/knowledge.html`, **470 lignes**. Atteinte par :

- un lien discret dans le volet « Réponses de l'IA » de `/messages`
  (`pages/messages.html:2116`, clé `messages.knowledge`) ;
- un bouton « ← Base de connaissance » depuis `apps/agent-ai/analyze.html`.

Ce qu'elle permet : saisir les clés `fixed` (ses exemples sont le téléphone, les
horaires, l'adresse, le wifi) et des entrées `faq` (« Sujet ou question » +
« Réponse de l'agent AI »). C'est donc déjà la bonne matière — il lui manque la
**charte V5**, le **mobile**, l'**insertion en un clic** et le **lien avec les
messages**.

### 2.7 Dix lecteurs, et c'est le vrai risque du chantier

`knowledge` est lu par **dix** endroits : `lib/cron-bookings.js`,
`lib/cleaning/sync-menages.js`, `lib/cron-access.js`, `api/guestflow-proposer.js`,
`api/simulate.js`, `lib/cron-messages.js`, `lib/cron-classify.js` (deux fois),
`lib/moteur-creation.js`, `lib/cron-arrival-code.js`.

**Conséquence de conception : le schéma ne bouge pas, ou il bouge pour les dix
d'un coup.** La V5 ajoute (type, libellé, rattachement), elle ne renomme pas
`key` ni `value`.

### 2.8 Ce que l'inventaire NE dit PAS

- **Lesquels des 30 `faq` sont périmés.** Seul Thierry peut le dire ; la base ne
  porte aucune date de dernière vérification (`created_at` seulement).
- **Si `CODE-IMMEUBLE` est encore le bon code d'immeuble.**
- **`kb_question_templates`** (lue par `api/extract-kb.js:189`) n'est pas
  inventoriée ici : hors périmètre tant que son rôle n'est pas tranché.

---


---

## 3. Les écrans

### 3.1 Accès

Une icône **« Base de connaissance »** dans l'en-tête de Messages, à côté de
« Messages programmés » et « Réponses de l'IA ».

- **Ordinateur** : elle ouvre un **volet à droite, 440 px**.
- **Téléphone** : une **page plein écran**.
- **Sélecteur de logement en haut** des deux.
- **La même icône à côté du champ de saisie du fil** (recette du 7 novembre
  2026, demande de Thierry). Au téléphone, l'en-tête n'existe que sur la LISTE :
  pour l'atteindre il fallait quitter le fil, et la page s'ouvrait sur le
  premier logement, sans voyageur pour l'aperçu. Depuis la saisie, elle s'ouvre
  sur le logement ET le voyageur de la conversation, et son retour rouvre cette
  conversation. Partir en pleine frappe ne perd rien : un brouillon différé en
  cours de modification part en base d'abord ; un texte libre est gardé pour ce
  fil (`sessionStorage`) et rendu dans une saisie vide à sa réouverture —
  jamais un texte d'édition, dont l'envoi ne validerait pas la proposition.

### 3.2 La carte d'une réponse prête

Icône + sujet, le texte avec ses étiquettes, et « vérifiée le … ».

- **Badge ambre « À revoir »** quand la réponse n'a pas été vérifiée depuis
  **90 jours**. ⚠ **C'est le seul ambre de l'écran** : la charte V5 réserve
  l'ambre à un seul moment par page.
- **Badge gris « Hors IA »**, avec un cadenas, quand l'IA n'a pas le droit de
  s'en servir.

### 3.3 Modifier une réponse prête

- champs **Sujet** et **Message** (avec les étiquettes) ;
- **« Insérer »** : boutons **bleus** — Prénom / Téléphone / Heure d'arrivée /
  Nom wifi / **Autre…** — qui insèrent la balise en un clic ;
- **aperçu rempli avec le vrai voyageur** ;
- interrupteur **« L'IA peut s'en servir »** (« Sinon, vous seul l'utilisez. ») ;
- **Enregistrer** à bord noir ; **Supprimer** en rouge, avec **une fenêtre dans
  la page** (jamais `window.confirm` — règle acquise le 2 novembre) ;
  **Annuler** en bleu.

### 3.4 La réponse manuelle

- un bouton **« Réponses prêtes »** à côté du champ ouvre une liste avec
  **recherche**, des **aperçus déjà remplis pour ce voyageur**, et un lien
  **« Gérer la base de connaissance »** ;
- au choix d'une réponse, **le texte va dans le champ, balises déjà
  remplacées**, et il **reste modifiable** ;
- au-dessus du texte, la mention **« Réponse prête · <sujet> »**, avec une croix
  pour la retirer.

### 3.5 Une balise vide

- elle reste **en étiquette rouge** dans le texte ;
- un bandeau **« <info> à remplir »** propose un lien **« Remplir »** vers la
  fiche ;
- **l'envoi est bloqué** (bouton gris).

### 3.6 Le champ de saisie

Il se place **juste sous le dernier message et suit le fil**. Il **ne reste pas
collé en bas de l'écran**.

### 3.7 Charte

Plus Jakarta Sans, fond blanc, **bleu `#2563EB` = cliquable**, **ambre pour un
seul moment par écran**, **noir réservé à la navigation**, **bouton principal à
bord noir**. Peu de texte, des icônes. Ordinateur **et** téléphone, chargement
rapide.

---

## 4. Les lots

Un par un, **recette staging entre chaque**.

| lot | contenu | visible ? |
|---|---|---|
| **1** | **Socle : un seul remplaceur de balises**, partagé par les messages programmés, les réponses manuelles et l'IA. Aujourd'hui il en existe **deux** (`lib/message-builder.js`, `lib/cron-messages.js`). Tests. | **rien pour l'hôte** |
| **2** | **Nettoyage des données en production** : doublons, valeurs écrites en dur dans les textes, prix faux. **D'abord un script à blanc qui produit un rapport** ; l'écriture **seulement sur go explicite de Thierry** (`CONFIRMER_PROD=cjmrizpdyhrcurmgyrhs`). | non |
| **3** | **Page V5** : volet ordinateur + page téléphone. Elle **remplace** `apps/agent-ai/knowledge.html`. | oui |
| **4** | **Insertion en un clic** dans les messages programmés et les réponses manuelles, avec le remplissage automatique et **le blocage si une balise est vide**. ⚠ **ET DEUX CHOSES POUR LE CODE** (décisions de Thierry des 3 et 4 novembre 2026). **(a)** Le bouton Envoyer reste gris tant que `[CODE À INSÉRER]` est dans le texte — même règle que les balises vides. **(b)** ⚠ **ET L'INTITULÉ DE LA PROPOSITION DOIT S'AFFICHER SUR LA CARTE**, ce qu'il ne fait pas : relevé par Thierry en recette le 3 novembre, et mesuré ensuite — `pages/messages.html` ligne 602 rend `suggested_reply || summary`, donc dès qu'il y a un texte, le résumé n'est JAMAIS montré. Le « COMPLÉTEZ LE CODE D'ACCÈS avant d'envoyer » posé par le lot 1b existe en base et ne se voit nulle part. ⚠ **Conséquence à retenir : la seule mitigation que le lot 1b annonçait pour cette porte est inopérante à l'écran** — l'hôte voit le marqueur dans le texte, rien d'autre ne l'avertit. C'est ce lot-ci qui ferme la porte, et lui seul. | oui |
| **5** | **IA** : elle répond **seulement à partir des réponses prêtes autorisées** ; **jamais** une réponse « Hors IA », **jamais** une donnée confidentielle, **jamais** un prix absent de la base ; sinon **l'alerte « info manquante » existante prend le relais**. | oui |

---

## 4 ter. LOT 3 — CE QUI EST LIVRÉ (5 novembre 2026, à recetter sur staging)

- **Les deux vues, UN module** : `shared/connaissance-vue.js`, monté par le volet
  de 440 px de Messages (bouton livre à côté de « Messages programmés ») et par
  la page plein écran `/connaissance` au téléphone (`pages/connaissance.html`,
  qui charge `shared/nav.js` et n'enregistre aucun service worker). Sous 900 px,
  le bouton mène à la page ; au-dessus, il ouvre le volet.
- **La carte** : icône + sujet, texte avec étiquettes (jamais d'accolades), une
  balise vide en étiquette rouge, « Vérifiée le … » / « Jamais vérifiée », badge
  ambre « À revoir » au-delà de 90 jours (seul ambre de l'écran), badge gris
  « Hors IA » avec le cadenas.
- **L'éditeur** : Sujet, Message à étiquettes (zone éditable, collage en texte
  brut), « Insérer » en bleu — Prénom / Téléphone / Heure d'arrivée / Nom wifi /
  Autre… —, insertion au curseur, aperçu rempli **par le serveur** avec le vrai
  voyageur (celui du fil ouvert s'il séjourne dans ce logement, sinon le
  prochain séjour actif), interrupteur « L'IA peut s'en servir », Enregistrer à
  bord noir, Annuler en bleu, Supprimer en rouge par une fenêtre dans la page.
- **« Infos du logement »** sous les réponses : chaque valeur se corrige sur
  place ; vide = « À remplir » en rouge ; vider une valeur supprime la ligne.
  ⚠ **« À remplir » veut dire « le voyageur recevrait un trou »**, dans l'ordre
  du remplaceur : la base, puis la **fiche du logement** (`properties.address`,
  `checkin_time`, `checkout_time` — les replis que l'envoi passe déjà), puis le
  **défaut** des horaires (18:00, 10:00 — « un fait, pas un trou »,
  `lib/balises.js`). L'écran montre « 16:00 · fiche du logement » ou « 18:00 ·
  par défaut » au lieu d'un « À remplir » qui serait faux, et l'aperçu reçoit
  les mêmes replis. L'étiquette rouge dans les textes suit la même règle, testée
  balise par balise contre le remplaceur AVEC les replis (reviews 1 et 2).
- **L'écriture ligne à ligne** : une réponse par son `id`, un fait par sa clé ;
  un sujet déjà pris rend 409 et n'écrase rien.
- **« Hors IA » est TENU côté modèle** : `buildKnowledgeText`
  (`lib/cron-classify.js`, les quatre chemins de l'IA) écarte toute entrée
  `lisible_par_ia = false`. Sans ce filtre, le cadenas aurait menti.
- **L'alerte « info manquante »** nomme le nouvel écran :
  « Messages → Base de connaissance → Infos du logement → <étiquette> »
  (`lib/balises.js`, `OU_ECRAN`).
- **Ce qui reste à faire hors de ce fil** : la migration
  `2026-11-04-connaissance-v5` en **production** (sur go de Thierry, puis
  `scripts/verifier-migration-connaissance-v5.js`). Tant qu'elle n'y est pas,
  l'écran marche, le dit, et refuse l'écriture en 503 plutôt que d'écrire à
  moitié.

### Laissé en l'état, avec sa raison (review du lot 3)

- **L'index `idx_knowledge_bien (user_id, property_id, type)` double celui de la
  contrainte unique `(user_id, property_id, type, key)`**, qui couvre déjà ce
  préfixe : un coût d'écriture sans gain. Il n'est PAS retiré de la migration :
  elle est déjà collée sur staging, et un fichier qui ne dit plus ce que la base
  porte serait pire que l'index. À retirer par une migration à part, si Thierry
  le veut — la table compte quelques dizaines de lignes, le coût est nul
  aujourd'hui.

### Recette staging — ce que Thierry regarde

1. Ordinateur, Messages : le bouton livre ouvre le volet large ; la liste des
   réponses du logement du fil ouvert ; « À revoir » et « Hors IA » aux bons
   endroits ; « Infos du logement » dessous, « À remplir » en rouge.
2. Ouvrir une réponse : étiquettes dans le texte, aperçu au prénom d'un vrai
   voyageur, insérer « Téléphone » au milieu d'une phrase, décocher l'IA,
   enregistrer : la carte revient avec « Vérifiée le » du jour et « Hors IA ».
3. Supprimer : la fenêtre dans la page ; « Garder » ne supprime rien.
4. Téléphone : le même bouton ouvre la page plein écran, sélecteur de logement
   en tête, mêmes gestes.
5. L'ancienne adresse `/apps/agent-ai/knowledge` mène au volet.

**Résultat de la recette du 7 novembre 2026 (staging, `b4522a10`)** : les cinq
points passent. Deux correctifs en sortent, commités sur la branche du lot
(règle 8) : l'icône à côté de la saisie (§3.1), et la fenêtre de suppression
d'une réponse Hors IA, qui disait « l'IA ne s'en servira plus ». Un constat de
recette était une erreur de mesure, pas un défaut : le libellé « Logement » du
sélecteur est bien masqué (`.sr-only`) — c'est `innerText` qui le comptait.

## 4 bis. INVENTAIRE de `apps/agent-ai/knowledge.html` (lot 3)

⚠ **Règle du dépôt : une spec UI ne supprime jamais une fonction métier par
omission.** Les 470 lignes de la page en service ont été lues ; ce qui suit dit
pour chaque élément s'il est **conservé**, **déplacé** ou **retiré AVEC RAISON**.

| ce que la page fait aujourd'hui | V5 |
|---|---|
| **Sélecteur de logement** (`/api/channel-property`) | **conservé** — en tête du volet et de la page téléphone, avec la photo du bien. |
| **Six champs fixes** : adresse, téléphone, heure de check-in, heure de check-out, nom wifi, mot de passe wifi | **conservés**, dans le bloc « Infos du logement », **sous** les réponses prêtes. Une valeur vide s'affiche « À remplir » en rouge. |
| **Liste de FAQ** (sujet + réponse), ajout et suppression ligne à ligne | **conservée**, devenue « Réponses prêtes » : une carte par réponse, icône + sujet + texte. |
| **Compteur « N entrées »** | **retiré AVEC RAISON** : la maquette validée ne le porte pas, et le nombre se lit en regardant la liste. Rien ne s'y décide. |
| **Témoin « Modifications non sauvegardées »** | **remplacé** : la V5 enregistre réponse par réponse (écran « Modifier une réponse prête »), il n'y a donc plus d'état global non enregistré à signaler. |
| **Bouton « ⬇️ Importer depuis Beds24 »** | **RETIRÉ — décision de Thierry du 5 novembre 2026.** Il était masqué par défaut et ne s'affichait que pour un bien Beds24 ; la maquette validée ne le porte pas, et le garder aurait obligé l'écran V5 à lire le provider en direct (`/api/channel-property` interroge Beds24), ce que la règle « le cœur de données d'abord » interdit. |
| **Badge « Beds24 »** sur une réponse importée | **retiré avec l'import** : il n'existait qu'à l'écran, au moment de l'import (aucune colonne ne porte l'origine d'une entrée). |
| **Sauvegarde** : `delete` de toutes les lignes du bien, puis `insert` | ⚠ **REMPLACÉE, ET C'EST UNE CORRECTION, PAS UNE REFONTE.** Voir ci-dessous. |
| **Écriture directe en base depuis le navigateur** (RLS) | **déplacée** derrière un endpoint d'écran (`/api/ecran/connaissance`), règle 1 de la performance et garde unique `contexteDEcran`. |
| **Page non délégable** (`exigerCompteProprePage`, domaine `reglages`) | **conservé** : l'écran est réservé au TITULAIRE, lecture comprise — l'endpoint refuse un membre en 403 avant toute lecture, le bouton du tiroir n'existe que pour le titulaire (comme les deux autres volets, dette 68), et la page téléphone porte le même garde-fou. ⚠ La première version du socle ouvrait la LECTURE aux membres (droits `messagerie`) : ce n'était écrit dans aucune décision, et la base porte des mots de passe wifi et des codes d'immeuble. L'ouvrir est une décision de droits, à poser au lot 4 si les réponses manuelles d'un membre en ont besoin. |
| **L'adresse `apps/agent-ai/knowledge`** | **redirigée** vers `/messages?volet=connaissance` — décision de Thierry du 5 novembre 2026, DANS ce lot : laissée en service, son enregistrement (tout supprimer, tout réinsérer) aurait effacé `verifie_le` et `lisible_par_ia` à chaque passage. Au téléphone, Messages renvoie vers `/connaissance`. Le lien « Connaissances » du volet IA ouvre désormais le volet de la base. |

### ⚠ Pourquoi la sauvegarde ne peut PAS rester ce qu'elle est

`apps/agent-ai/knowledge.html` supprime **toutes** les lignes du bien puis les
réinsère. Trois conséquences, et la troisième est bloquante pour ce lot :

1. **`created_at` est perdu à chaque enregistrement** : toute entrée paraît
   écrite aujourd'hui. C'est ce qui rendait l'âge du rapport peu fiable.
2. **Une panne entre le `delete` et l'`insert` vide la base du bien.** Il n'y a
   ni transaction, ni retour arrière : le navigateur peut se fermer entre les
   deux.
3. ⚠ **`verifie_le` et `lisible_par_ia` seraient effacés à chaque
   enregistrement** — donc le badge « À revoir » et la portée IA ne tiendraient
   pas une sauvegarde. **La V5 écrit ligne à ligne, par `id`.**

### Ce que la V5 ajoute, et qui n'existait pas

- **`verifie_le`** : posé **quand l'hôte enregistre**, jamais par le système.
  Badge ambre **« À revoir »** au-delà de **90 jours** — et c'est le **seul
  ambre de l'écran** (charte V5).
- **`lisible_par_ia`** : badge gris **« Hors IA »** avec un cadenas. Un fait
  marqué ainsi n'entre pas dans le contexte envoyé au modèle, et un test le
  prouve **en appelant** le bâtisseur de contexte.
- **Les étiquettes lisibles** à la place des accolades : `{telephone_hote}`
  s'affiche « Téléphone ». La liste vient de `lib/balises.js`, jamais recopiée.

---

## 5. Règles du chantier

- Branche `kb-v5-base-connaissance` ; recette sur **staging**
  (`ortyofzzdsthlhqmzsnq`).
- ⚠ **Aucune valeur réelle** (codes, téléphones, mots de passe wifi, adresses)
  **dans le dépôt, les tests ou les captures.**
- ⚠ **Ne jamais modifier `api/channel-webhook.js`.**
- ⚠ **Ne jamais commiter `package-lock.json`.**
- **Je ne merge pas** : c'est le chef de file qui merge. **Aucune écriture en
  production sans le go de Thierry.**

---

## 6. PERFORMANCE — case obligatoire (`CLAUDE.md`)

| # | point | réponse |
|---|---|---|
| 1 | Un écran = un endpoint | **Oui** (lot 3) : `/api/ecran/connaissance`, garde `contexteDEcran`, lectures en parallèle. |
| 2 | Donnée non urgente = résumé pré-calculé | **Sans objet** : une réponse prête est un réglage, lu à l'ouverture et modifié à la main. Aucun calcul. |
| 3 | Cache navigateur | **NON, et c'est une décision** : les réponses prêtes portent des codes d'accès et des mots de passe wifi. Interdit par la règle 3. |
| 4 | `private, no-store` avant le PREMIER refus | **Oui**, 405 compris (dette 90). |
| 5 | Statique versionné | **Non, et c'est l'état du dépôt, pas un oubli du lot** : aucun module JS n'est versionné aujourd'hui (seuls les dictionnaires i18n le sont, `VERSION` mise à jour). Le module de la vue suit la pratique commune — revalidé à chaque chargement. ⚠ Ce que le lot fait À LA PLACE : Messages charge le module **à la première ouverture du volet** (`import()`), jamais avec la page. Versionner les modules est un chantier du dépôt entier. |
| 6 | Pas de lecture tronquée à 1000 | **Oui** : pagination **par curseur** sur `id` (pages de 200) — test « la lecture se pagine par CURSEUR » à 205 entrées. |
| 7 | Budget < 1 s / < 2 s, tenu par un test qui compte les appels | **Oui** : `tests/connaissance-vue-dom.test.js` exige UN appel pour peindre l'écran, `tests/connaissance-ecran.test.js` exige TROIS requêtes et `Server-Timing` qui les compte. La durée elle-même se mesure en recette (staging). |
| 8 | Mesure AVANT / APRÈS | Voir le tableau ci-dessous. |

### Mesure AVANT / APRÈS (5 novembre 2026)

⚠ **CE QUI EST MESURÉ, ET OÙ.** Les appels et les requêtes ne dépendent pas des
données : ils sont mesurés **au banc** (APRÈS : doubles qui comptent chaque
requête) et **dans le code** (AVANT : la branche GET de `/api/channel-property`
et la lecture RLS de la page remplacée, lues ligne à ligne). Les octets des
fichiers sont mesurés **sur disque**. Les octets des RÉPONSES dépendent du
compte : ils se mesurent **sur staging pendant la recette** — ce fil n'a pas de
session staging, et un chiffre de fixture ne serait pas une mesure.

| | AVANT — `apps/agent-ai/knowledge.html` | APRÈS — volet de Messages | APRÈS — page téléphone |
|---|---|---|---|
| **Appels du navigateur** pour peindre l'écran | **2** : `/api/channel-property` + lecture RLS de `knowledge` | **1** : `/api/ecran/connaissance` | **1** : idem |
| **Requêtes** derrière | **5** : `properties`, `api_keys`, `canaux_du_bien`, `canaux_releve` (channel-property) + `knowledge` — **et un appel Beds24 EN DIRECT** quand le compte a une clé | **3** : `properties`, `knowledge`, `bookings_snapshot` (aperçu) ; +1 sans la migration ; +1 par tranche de 200 entrées | **3** |
| **Octets statiques** propres à l'écran | **53 052** : page 21 832 + `public/style.css` 10 857 + `components/sidebar.js` 20 363 | **28 321** (8 596 gzip) pour `shared/connaissance-vue.js`, chargé à la **première ouverture** du volet seulement ; `shared/ui.css` +7,5 Ko (déjà chargée par Messages) | **33 404** : page 5 083 + module 28 321 |
| **Octets des réponses** | à mesurer sur staging | à mesurer sur staging | à mesurer sur staging |

---

## 7. Ce qui n'est PAS dans ce chantier

- La dette **129** (une proposition sans réservation est invisible) : domaine
  messagerie.
- `kb_question_templates` : rôle non tranché.
- La réécriture du contenu des réponses : c'est Thierry qui écrit ses textes.
