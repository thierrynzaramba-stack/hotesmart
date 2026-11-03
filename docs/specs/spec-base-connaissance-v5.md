# Spec — Base de connaissance V5 : source unique des informations d'un bien

Chantier ouvert par Thierry le **3 novembre 2026**.
Branche : `kb-v5-base-connaissance`. Worktree : `/home/thierry/hotesmart-kb`.

> **Rien n'est codé avant que Thierry ait validé cette spec et les maquettes**
> (sa consigne d'ouverture). Les lots sont courts ; un lot qui touche l'envoi au
> voyageur a droit à l'exception de review de `CLAUDE.md`.

---

## 0. Ce qui a déclenché le chantier, et c'est mesuré

Le 2 novembre 2026 à 21:40, un voyageur demande à La bulle quels suppléments
sont proposés. L'IA prépare : « une bouteille de champagne servie avec glaçons
au prix de **39 €** ». Le 3 novembre à 04:26, Thierry répond lui-même :
« une bouteille de champagne au frais avec des glaçons pour **29 euros** ».

**L'IA n'a rien inventé.** Elle a recopié, mot pour mot, la ligne
`knowledge` `f693f184-570e-4c27-801a-976975cc30dc` — bien La bulle, `type: faq`,
clé « Pack en complément », **écrite le 20 juillet 2026** :

> « Bonjour, Actuellement, nous proposons une bouteille de champagne servie avec
> glaçons au prix de 39 €. Le pack massage est malheureusement épuisé pour le
> moment. »

Rien dans `agent_prompting` (0 occurrence de « 39 » ou « champagne ») ni dans
les onze modèles de `message_templates` ne porte ce prix. **La source est unique
et elle est périmée depuis trois mois et demi.**

⚠ **La leçon qui fonde le chantier** : il n'existe aucun garde-fou possible
contre une IA fidèle à une base fausse. Seule la mise à jour **en un seul
endroit** protège. Et ce prix n'est jamais parti au voyageur par un hasard
heureux — la réservation n'existait pas, donc l'envoi a été refusé (dette 126).

---

## 1. Principe

**La base de connaissance est la source unique des faits d'un bien** : wifi,
accès, horaires, équipements, suppléments et prix, règles, contacts.

**Trois usages lisent la même base :**

1. **Les messages programmés** y piochent par balises — même syntaxe
   qu'aujourd'hui (`{telephone_hote}`).
2. **L'IA** lit la base pour répondre.
3. **Les réponses manuelles de l'hôte** : dans la zone de saisie de Messages,
   les mêmes balises sont acceptées, remplacées par leur valeur **avant**
   l'envoi, et **l'hôte voit le texte final avant d'envoyer**.

**Modifier une information la met à jour partout.**

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

## 3. Décisions qui attendent Thierry

| # | question | pourquoi elle bloque |
|---|---|---|
| D1 | ~~Le champagne : 29 € ?~~ **TRANCHÉ par Thierry le 3 novembre 2026 : 29 €, et le pack massage est TOUJOURS ÉPUISÉ.** La ligne `faq` « Pack en complément » de La bulle passe donc de 39 € à **29 €** ; sa seconde phrase reste vraie. | C'est la ligne qui a déclenché le chantier. ⚠ **Pas encore corrigée en production** : c'est une écriture, elle attend son go — ou le geste de Thierry depuis l'écran actuel. |
| D2 | ~~Quel est LE téléphone hôte ?~~ **TRANCHÉ par Thierry le 3 novembre 2026 : les DEUX numéros des modèles sont bons** — NUMERO-C et NUMERO-B. Donc **deux clés**, `telephone_hote` (NUMERO-C) et `telephone_hote_2` (NUMERO-B), et **NUMERO-A, que la base porte aujourd'hui, est PÉRIMÉ** : il est remplacé, pas conservé. | Une balise unique ne peut pas porter deux numéros. ⚠ **Conséquence mesurée : sur les deux biens de Bagnères, la balise `{telephone_hote}` aurait envoyé un numéro périmé à chaque message** — elle n'a jamais servi, parce que les cinq modèles écrivent les bons numéros en dur. Le défaut était donc masqué par celui que le chantier vient fermer. |
| D3 | **Le code d'immeuble `CODE-IMMEUBLE`** devient-il une clé de la base ? | C'est un secret d'accès : s'il entre dans la base, il entre aussi dans ce que l'IA peut lire. ⚠ **Ma recommandation : une clé marquée « jamais lue par l'IA »**, utilisable en balise seulement. |
| D4 | Une entrée de base peut-elle porter **une date de dernière vérification**, et l'écran la montrer ? | C'est le seul garde-fou contre un 39 € qui dort trois mois. |
| D5 | Les `faq` d'aujourd'hui sont des **réponses rédigées** (« Bonjour, … »), pas des faits. On garde les deux natures (`fait` et `réponse`) ou on sépare ? | Change la forme de l'écran et ce que l'IA reçoit. |

---

## 4. Modèle de données cible

**On garde la table `knowledge`** (dix lecteurs), on l'étend :

- `key` et `value` : inchangés.
- `type` : `fixed` et `faq` conservés ; une valeur de plus si D5 le demande.
- **nouveau** `verifie_le` (timestamptz, nullable) — D4.
- **nouveau** `lisible_par_ia` (boolean, défaut `true`) — D3.
- **nouveau** `telephone_hote_2` (clé `fixed`, décision D2) : deux numéros partent aux voyageurs, donc deux
  clés et deux balises. ⚠ La valeur actuelle de `telephone_hote` (NUMERO-A) est **périmée** et remplacée.
- `property_id` reste la **référence provider** (`provider_property_id`), règle 10
  de `CLAUDE.md`. ⚠ Vérifié : les 45 lignes portent bien des refs provider.

Migration additive, lignes courtes, **aucun défaut qui change un comportement**.

---

## 5. Les trois usages, un seul remplaceur

Un module unique — `shared/balises.js` + son miroir serveur — porte :

1. **la liste des balises** et d'où vient chacune (base, réservation, serrure) ;
2. **le remplacement** ;
3. **le constat de manque** : quelles balises n'ont pas de valeur, et **où la
   remplir** (on étend la table de `cron-messages.js:857`).

`lib/message-builder.js` et `lib/cron-messages.js` l'appellent tous les deux :
**les deux copies disparaissent**, et un test refuse qu'une troisième naisse.

---

## 6. Gardes

- ⚠ **Une balise sans valeur ne part JAMAIS en clair au voyageur.** Envoi
  **bloqué**, message qui nomme l'information manquante et où la remplir — même
  règle que les messages programmés aujourd'hui.
- **Règle IA proposée, à valider** : *« Ne donne jamais un prix, un chiffre, un
  code ou un horaire qui ne figure pas dans la base. Si l'information manque,
  dis que tu vas vérifier et préviens l'hôte. »* Posée dans
  `agent_prompting`, donc modifiable sans déploiement.
- **Un fait marqué `lisible_par_ia = false` n'entre pas dans le contexte
  envoyé au modèle** — et un test le prouve en appelant la fonction, pas en
  grepant la source.
- **L'hôte voit le texte final** avant tout envoi manuel : le remplacement se
  fait **à l'affichage de l'aperçu**, pas au moment du clic.

---

## 7. Écran V5

- La base s'ouvre depuis **l'en-tête de Messages**, à côté de l'icône
  « Messages programmés » (troisième bouton d'en-tête).
- **Insertion en un clic** : en écrivant un message programmé ou une réponse
  manuelle, une liste des informations de la base ; un clic insère la balise, et
  **la valeur actuelle est affichée** à côté.
- **Dans la base, on voit quels messages utilisent chaque information** (et
  l'écran le dit quand la réponse est « aucun »).
- Charte V5, peu de texte, **desktop ET mobile**.

Maquettes : `docs/specs/base-connaissance-v5/maquette/kb-desktop.html` et
`kb-mobile.html`.

---

## 8. PERFORMANCE — case obligatoire (`CLAUDE.md`)

| # | point | réponse |
|---|---|---|
| 1 | Un écran = un endpoint | **Oui** : `/api/ecran/connaissance`, garde `contexteDEcran`, lectures en parallèle (base + modèles + usages). |
| 2 | Donnée non urgente = résumé pré-calculé | **Sans objet** : la base est une donnée de **réglage**, lue à l'ouverture d'un écran et modifiée à la main. Aucun calcul. |
| 3 | Affichage instantané par cache navigateur | **NON, et c'est une décision** : la base porte des codes d'accès et des mots de passe wifi. Interdit par la règle 3. |
| 4 | `private, no-store` avant le PREMIER refus | **Oui**, 405 compris (dette 90). |
| 5 | Statique versionné | **Oui** : `shared/balises.js` servi avec `?v=<empreinte>`. |
| 6 | Pas de lecture tronquée à 1000 | **Oui, et ça compte ici** : `knowledge` peut dépasser 1000 lignes à quelques dizaines de biens. Pagination **par curseur** sur `id`. |
| 7 | Budget < 1 s / < 2 s, tenu par un test qui compte les appels | **Oui** + `Server-Timing` avec le nombre de requêtes. |
| 8 | Mesure AVANT / APRÈS | **AVANT, mesuré** : la page actuelle n'est pas instrumentée — à mesurer au lot 1 (appels, requêtes, octets) avant d'écrire une ligne. |

---

## 9. Découpage en lots

| lot | contenu | touche l'envoi ? |
|---|---|---|
| **0** | *Cette spec + maquettes.* Validation de Thierry. | non |
| **1** | **Un seul remplaceur** (`shared/balises.js`), les deux copies retirées, test anti-troisième copie. Aucun changement visible. | **oui** |
| **2** | Migration additive (`verifie_le`, `lisible_par_ia`) + écran V5 de la base, desktop et mobile. | non |
| **3** | Insertion en un clic dans les messages programmés + « quels messages utilisent cette information ». | non |
| **4** | Balises dans la saisie manuelle, avec aperçu du texte final et blocage si une balise est vide. | **oui** |
| **5** | Règle IA « jamais un chiffre absent de la base » + `lisible_par_ia` respecté. | **oui** |
| **6** | Reprise des faits en dur des onze modèles vers des balises — **avec Thierry**, ligne par ligne, puisque chaque valeur demande sa décision. | **oui** |

Lots 1, 4, 5 et 6 : exception de review applicable (une review de plus, limitée
au diff des correctifs).

---

## 10. Ce qui n'est PAS dans ce chantier

- La dette **126** (une proposition sans réservation est invisible) : notée au
  registre, remède = la rendre affichable. Domaine messagerie.
- `kb_question_templates` : rôle non tranché.
- Toute réécriture du contenu des `faq` : c'est Thierry qui écrit ses textes.
