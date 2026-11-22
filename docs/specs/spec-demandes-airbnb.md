# Spec — Les demandes Airbnb dans Messages (dette 129)

Statut : **spec, rien n'est codé.** Fil messagerie, 21 novembre 2026.

## 0. Constat, mesuré en production le 21 novembre 2026

Une **demande** est un fil de messages ouvert par un voyageur AVANT toute
réservation (Airbnb : « inquiry »). Channex la range dans un fil
(`message_thread`) **sans réservation** : ses `relationships` portent le bien et
le canal, pas de `booking`. On peut y répondre par
`POST /message_threads/:id/messages` (doc Channex, collection Messages).

Ce que la base de production contient (`messages`, `booking_id is null`) :

| bien (clé provider) | entrants (import) | entrants (webhook) | sortants | période |
|---|---|---|---|---|
| `0544fd9a…` | 8 (17 au total) | 9 | 7 | 3 août → 1er sept. |
| `0db6b39b…` | 30 | 34 | 15 | 30 sept. → 18 nov. |
| `1655ab32…` | 10 | 10 | 8 | 25 sept. → 18 nov. |
| `204cef81…` | 31 | 32 | 22 | 19 sept. → 20 nov. |

Quatre faits en sortent :

1. **Les demandes sont fréquentes et vivantes** : jusqu'au 20 novembre, et
   Thierry y répond aujourd'hui depuis Airbnb (les sortants sont ses réponses,
   importées — vérifié : aucun message système « inquiry » parmi eux).
2. **L'identifiant du fil n'est gardé nulle part.** `importMessages` le lit
   (`th.id`) et le jette ; le webhook le reçoit (`payload.message_thread_id`)
   et le jette aussi. Sans lui, on ne sait ni séparer deux demandes du même
   bien, ni y répondre.
3. **Chaque message du voyageur existe deux fois** : la copie du webhook (sans
   identifiant, `ota` nul) et celle de l'import (avec identifiant, `ota =
   airbnb`), aux mêmes instants. La réconciliation de `recordMessage` (« l'écho
   dans l'autre sens ») exige `booking_id` : elle ne joue jamais ici.
4. **L'agent IA lit plusieurs prospects comme un seul fil.**
   `lib/cron-classify.js` regroupe tout message sans réservation sous la clé
   `'unknown'`, par bien : deux prospects du même logement sont lus comme une
   seule conversation, et la proposition produite (deux cas sur La bulle, 2 et
   3 novembre) n'est affichable nulle part — c'est la dette 129 telle
   qu'écrite au registre.

## 1. Décisions de Thierry

- **3 novembre 2026** : le remède est de rendre la proposition AFFICHABLE, pas
  de poser une alarme.
- **21 novembre 2026** :
  1. Les demandes s'affichent **dans Messages, dans la même liste que les
     réservations, marquées « Demande »**, sans dates de séjour.
  2. **L'IA traite une demande comme une réservation**, Mode Auto compris : en
     Auto, elle répond seule.

Choix par défaut posés par cette spec (Thierry peut les renverser) :

- **Une demande devenue réservation rejoint la conversation de la
  réservation** : ses messages prennent le `booking_id` que Channex donne au
  fil. L'hôte retrouve les questions d'avant la réservation dans le même fil,
  et l'étiquette « Demande » disparaît.

## 2. Modèle de données

- **`messages.provider_thread_id`** (texte, nul permis) : l'identifiant du fil
  chez le provider, écrit pour TOUT message Channex, avec ou sans réservation.
- **Table `fils_provider`** (cœur, writer unique dans `lib/`) : une ligne par
  fil — `user_id`, `provider`, `property_id` (clé provider), `provider_thread_id`,
  `booking_id` (nul = demande), `titre` (le nom du voyageur chez Channex),
  `ota`, `ferme`, `maj_le`. Unicité `(provider, provider_thread_id)`. RLS
  active ; lecture par la même règle que `messages` (domaine `messages`, par
  bien) ; écriture par la clé de service seule.
  Elle porte le NOM d'une demande, que les messages ne portent pas.
- **Clé de conversation d'une demande : `demande:<provider_thread_id>`.** Elle
  sert partout où un `bookId` sert de clé d'écran ou de tâche
  (`agent_tasks.book_id`, `conversation_flags.book_id`, curseur de pagination,
  paramètre de fil). `messages.booking_id` reste nul : une demande n'est pas
  une réservation, et rien qui cherche un snapshot ne doit recevoir cette clé.
  Un seul module la fabrique et la reconnaît (`lib/demandes.js`).

## 3. Lot 1 — Enregistrement (cœur de données)

⚠ Ce lot touche la couche sync (webhook, import, `recordMessage`) : il passe
**seul**, coordonné par le chef de file.

- **Étape 0, mesure en lecture seule.** Un contrôle de diagnostic liste, par
  bien Channex, les fils chez le provider : identifiant, titre, réservation
  rattachée ou non, nombre de messages, dernier message, fermé ou non. Il
  répond à deux questions avant toute écriture : combien de demandes
  distinctes, et combien sont devenues des réservations.
- **Étape 1, migration** : colonne, index `(user_id, provider_thread_id)`,
  table `fils_provider` et sa RLS. Prouvée par un script de vérification.
- **Étape 2, writers** :
  - `importMessages` écrit `provider_thread_id` et met à jour `fils_provider`
    (titre, réservation, fermé) ;
  - le webhook écrit `payload.message_thread_id` ;
  - `recordMessage` accepte l'identifiant de fil, et la réconciliation de
    l'écho entrant s'étend aux messages sans réservation, sur la clé
    `(compte, fil, texte, instant)` — l'instant reste obligatoire, pour la même
    raison que pour les réservations (deux « Ok » réels à 45 minutes d'écart).
- **Étape 3, rattrapage de l'historique** (script, à blanc puis `--go` sur go
  de Thierry) :
  - pose `provider_thread_id` sur les lignes existantes, par l'identifiant de
    message de l'import ;
  - retire la copie webhook d'un message quand la copie import existe (même
    compte, même bien, même texte, même instant) — sauf si une ligne
    `ota_reviews.source_message_id` la désigne : elle est alors repointée vers
    la copie gardée ;
  - pose le `booking_id` du fil sur les messages d'une demande devenue
    réservation.
  Le script annonce ses nombres avant d'écrire, et la vérification les recompte
  après.

## 4. Lot 2 — Écran

- `api/messages.js` : les messages sans réservation mais avec un fil se
  regroupent sous `demande:<fil>` ; nom = `fils_provider.titre`, sinon
  « Voyageur » ; statut « demande » ; pas de dates. Épingler, archiver, marquer
  lu acceptent la clé (le bien se retrouve par le fil, sous le compte).
- `pages/messages.html` : étiquette « Demande » (i18n fr/en/es), pas de ligne
  de dates, fil lisible, envoi manuel. La proposition de l'IA s'y accroche par
  la même clé que pour une réservation.
- `api/channel-message.js` : accepte une demande. La garde vérifie que le fil
  appartient au compte et au périmètre du bien (403 sinon, 404 si inconnu),
  puis l'envoi part par `POST /message_threads/:id/messages`, et le message est
  enregistré avec son fil.
- Mobile : même page, même règle.

**Case performance (obligatoire)**

1. Un écran = un endpoint : inchangé, la liste reste servie par
   `/api/messages` ; le nom des demandes vient d'une lecture de
   `fils_provider` en parallèle, bornée aux fils de la page.
2. Donnée non urgente : sans objet — des messages, donc du temps réel.
3. Cache navigateur : inchangé ; aucune donnée interdite de cache n'est ajoutée.
4. `private, no-store` : inchangé, posé avant le premier refus.
5. Fichiers statiques : la page garde sa version par empreinte.
6. Lecture tronquée : la lecture de `fils_provider` est bornée par la liste des
   fils de la page, jamais « tous les fils du compte ».
7. Budget : premier affichage < 1 s, écran complet < 2 s ; le test qui compte
   les appels de l'écran ne doit pas bouger.
8. Mesure avant / après (appels, requêtes, octets) : prise au début du lot 2
   sur le compte réel, et notée ici.

## 5. Lot 3 — L'IA sur les demandes

- `lib/cron-classify.js` : regroupe par `booking_id`, sinon par
  `demande:<fil>`. La clé `'unknown'` ne sert plus qu'aux messages sans
  réservation ET sans fil (hors Channex), qui restent ignorés.
- Le contexte donné au modèle : le nom du fil, et l'indication explicite que la
  personne **n'a pas encore réservé** (ni dates sûres, ni prix confirmé). Les
  règles de la base de connaissance s'appliquent comme pour une réservation.
- L'envoi automatique et la file de brouillons acceptent une demande
  (aujourd'hui refus `reservation_introuvable`) et envoient par le fil.
- Les tâches existantes en `'unknown'` sont closes au déploiement (elles
  mêlent plusieurs prospects), par script à blanc puis `--go`.
- Lot qui touche l'**envoi au voyageur** : jusqu'à trois reviews, et Thierry
  présent juste après le merge.

## 6. Hors périmètre

- Accepter ou refuser une demande de réservation Airbnb (`reservation_request`,
  `inquiry` comme événement) : sujet séparé, décisions de Thierry du
  9 novembre 2026.
- Le masque du webhook (`booking;message`, certifié) ne change pas : l'import
  suffit à connaître les fils.
- Beds24 : pas de notion de fil.

## 7. Ordre

Lot 1 (seul, cœur) → rattrapage en production → lot 2 → lot 3. Chaque lot a
sa branche partie de `main`, sa review, et sa remise au chef de file.
