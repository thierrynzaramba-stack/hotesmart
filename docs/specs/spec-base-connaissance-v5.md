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
| **4** | **Insertion en un clic** dans les messages programmés et les réponses manuelles, avec le remplissage automatique et **le blocage si une balise est vide**. | oui |
| **5** | **IA** : elle répond **seulement à partir des réponses prêtes autorisées** ; **jamais** une réponse « Hors IA », **jamais** une donnée confidentielle, **jamais** un prix absent de la base ; sinon **l'alerte « info manquante » existante prend le relais**. | oui |

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
| 5 | Statique versionné | **Oui** : le module de balises servi avec `?v=<empreinte>`. |
| 6 | Pas de lecture tronquée à 1000 | **Oui** : pagination **par curseur** sur `id` — `knowledge` dépassera 1000 lignes à quelques dizaines de biens. |
| 7 | Budget < 1 s / < 2 s, tenu par un test qui compte les appels | **Oui** + `Server-Timing` avec le nombre de requêtes. |
| 8 | Mesure AVANT / APRÈS | **À faire au lot 3** : la page actuelle n'est pas instrumentée. |

---

## 7. Ce qui n'est PAS dans ce chantier

- La dette **129** (une proposition sans réservation est invisible) : domaine
  messagerie.
- `kb_question_templates` : rôle non tranché.
- La réécriture du contenu des réponses : c'est Thierry qui écrit ses textes.
