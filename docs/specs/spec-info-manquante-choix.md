# Spec — Information manquante : l'hôte répond par Oui / Non / Autre, l'IA rédige, la base apprend

**Statut : VALIDÉE par Thierry le 10 novembre 2026** (décisions du §10).
Aucun numéro de dette : c'est un lot neuf (chef de file, 10 novembre 2026). Domaine messagerie / GuestFlow. Ce lot touche l'**envoi au voyageur** :
trois reviews au plus, et Thierry doit être présent juste après le merge.

## 0. La demande (Thierry, 10 novembre 2026)

> Quand une information manque, l'IA propose plusieurs types de réponse. Le
> voyageur écrit : « je peux venir avec un chien et garer ma moto dans
> l'appartement ? ». L'IA propose à l'hôte : question 1) oui / non / autre ;
> question 2) oui / non / autre ; puis elle rédige une réponse. Si l'hôte
> rédige une réponse et clique sur « IA », l'IA propose une réponse.

Et, pour boucler : **l'IA propose une réponse prête, enregistrée et
réutilisable, qui sert de base de connaissance. Si le sujet correspond à une
réponse prête existante, elle propose sa modification.**

## 1. Aujourd'hui (lu dans le code, `main` 69d849bb)

- `lib/cron-classify.js` classe le lot du voyageur. Si une réponse manque à la
  base, il le classe `info_unknown`. Il crée alors une tâche `agent_tasks` au
  statut **`pending`**, avec `sub_tasks: [{ question, summary,
  suggested_reply }]` : une entrée par question. `suggested_reply` est une
  **note interne pour l'hôte**, jamais un texte pour le voyageur. Il prévient
  aussi l'hôte par SMS ou e-mail (`sendAlertNotifications`). ⚠ **Mesuré
  dans le code le 10 novembre 2026 : l'alerte part DANS LE TOUR de
  classification.** Le réglage « alerte info manquante » (`alerte_info`,
  `api/agent-config.js`) est enregistré, mais aucun code de `lib/` ne le lit
  encore, et la migration l'a posé à 0 partout (docs/kb/guestflow.md).
- **La page Messages ne montre pas cette tâche.** Ses deux lectures de
  propositions (`pages/messages.html`, au chargement et à la relecture ;
  `api/messages.js`, fil en direct) ne prennent que `pending_validation`.
  L'hôte la voit sur Aujourd'hui (« À valider ») et par l'alerte. Dans la
  conversation, il ne voit que le message du voyageur.
- « Proposer une réponse » (`api/guestflow-proposer.js`) **refuse** de déposer
  quoi que ce soit quand l'IA classe le lot « info inconnue ». C'est voulu :
  l'alerte du cron doit partir.
- La base de connaissance, ce sont les **réponses prêtes** (table `knowledge`,
  `type: 'faq'` : un sujet et un texte, avec le drapeau « Hors IA »). Elle a un
  seul writer, `api/ecran/connaissance.js` (spec-base-connaissance-v5.md).

## 2. Ce que le lot change

### A. La carte « Information manquante » dans la conversation

- Sous le dernier message du voyageur, une carte **« Information manquante »**,
  avec **une ligne par question** (`sub_tasks[].question`). Chaque ligne a trois
  boutons : **Oui / Non / Autre**. « Autre » ouvre un champ court (« garage à
  200 m »).
- Le bouton **« Rédiger la réponse »** est actif dès que chaque question a un
  choix. L'IA rédige alors la réponse au voyageur à partir des choix, dans sa
  langue, avec les connaissances du logement. Le texte arrive **dans la zone de
  saisie** : rien ne part. L'hôte relit, modifie et envoie par le chemin
  d'envoi existant (même routage, mêmes gardes).
- Quand la réponse part, la tâche `info_unknown` est **close** (`done`). La
  carte disparaît, et la ligne « À valider » d'Aujourd'hui avec elle.
  ⚠ **La clôture ne retire aucune alerte** : l'alerte est déjà partie au
  moment de la classification (§1). Le jour où le délai `alerte_info` sera
  appliqué, la règle du 27 octobre (« si l'hôte agit, pas de SMS ») devra
  relire le statut de la tâche avant d'envoyer.
- La carte ne se montre que si l'hôte n'a **pas répondu depuis** la tâche :
  le cron ne clôt jamais une tâche `pending` quand l'hôte répond à la main,
  donc une tâche ouverte n'est pas forcément une question en attente. Vaut
  réponse un message sortant qui n'est pas un message automatique (modèle).
- La carte ne remplace rien. Aujourd'hui garde sa liste, et l'alerte garde son
  circuit.

### B. Le bouton « IA » dans la zone de saisie

- L'hôte tape une réponse brute (« oui chien, non moto, parking rue Voltaire »)
  et clique sur **« IA »**. L'IA en fait une réponse rédigée, dans la langue du
  voyageur, avec le fil et les connaissances du logement. Le texte de la zone
  est remplacé, et une action **« Annuler »** rend le texte de l'hôte. Rien ne
  part.
- Le bouton n'apparaît que si du texte est tapé.

### C. La boucle avec la base de connaissance

- Après l'envoi d'une réponse rédigée par A, ou par B sur une conversation qui
  avait une carte « Information manquante », l'IA propose **une réponse prête
  par question tranchée**. Le texte est **généralisé** : sans nom, sans dates,
  sans rien de propre à ce voyageur.
  - Si aucune réponse prête ne traite le sujet : **« Enregistrer comme réponse
    prête ? »**, avec un sujet et un texte proposés.
  - Si une réponse prête existante traite le sujet (chiens, animaux…) :
    **« Mettre à jour la réponse prête « Animaux » ? »**, avec l'avant et
    l'après.
- Trois gestes : **Enregistrer**, **Modifier** (le formulaire de la base, déjà
  rempli), **Non merci**. **Rien n'est jamais écrit sans le geste de l'hôte.**
- L'écriture passe par le **writer unique** de la base
  (`api/ecran/connaissance.js`), avec ses gardes. Une nouvelle réponse prête est
  **lisible par l'IA** : c'est ce qui permet à l'IA de répondre seule la
  prochaine fois.

## 3. Serveur

- **Un endpoint neuf : `POST /api/guestflow-rediger`**. Il a trois actions, et
  aucune n'écrit dans la base de connaissance.
  - `choix` : `{ bookingId, tacheId, choix: [{ question, reponse: 'oui'|'non'|'autre', precision? }] }`
    rend `{ texte }`. ⚠ **La `question` renvoyée doit être celle de la base,
    au caractère** : le cron COMPLÈTE la tâche quand le voyageur écrit encore,
    et des choix pris sur l'ancienne carte, appliqués par position,
    répondraient à des questions que l'hôte n'a jamais lues. Écart :
    `409 questions_changees`, et la page relit la carte.
  - `texte` : `{ bookingId, brouillon }` rend `{ texte }`.
  - `base` : `{ bookingId, tacheId, envoye }` rend `{ propositions: [{ action:
    'creer'|'modifier', id?, sujet, texte, avant? }] }`.
- **Gardes.** `requirePermission` avec `domaine: 'messages'`, `niveau:
  'write'`, booking requis, donc le compte et le bien désignés par la
  réservation, comme `api/guestflow-proposer.js`. Le kill switch du bien.
  Chaque appel IA est journalisé (`avecContexteIA`, étiquette
  `guestflow_rediger`).
- ⚠ **Plafond de coût PROPRE À L'HÔTE (décision de Thierry du 10 novembre
  2026 : « 3 est trop petit de toute façon »)** : **10 rédactions par
  conversation sur 24 h**, comptées dans le journal `ia_appels` sous
  l'étiquette `guestflow_rediger`. Elles ne touchent **jamais** le plafond de
  l'agent (`guestflow_appels_ia`, 3 appels) : sinon trois clics de l'hôte
  arrêteraient l'agent sur la conversation (tâche « L'agent IA s'est
  arrêté… ») et réveilleraient le fondateur pour un geste voulu. Journal
  illisible : on n'appelle pas (503). Relever le plafond de l'agent lui-même
  est un autre sujet : dette 145.
  ⚠ **Limite connue (review 1, constat 3)** : la ligne du journal est écrite
  APRÈS la réponse du modèle, et son échec est silencieux. Des demandes
  simultanées (deux onglets, un script d'un membre autorisé) lisent toutes le
  même compte et passent ensemble ; une écriture du journal en échec ne compte
  pas. C'est un plafond de coût, pas une garde de sécurité : il borne l'usage
  normal, pas un abus délibéré. Le rendre exact demande une réservation
  atomique (compter et inscrire en une opération).
  `private, no-store` avant le premier refus, et le nombre de requêtes dans
  `Server-Timing`.
- **Lecture des tâches.** ⚠ **Jamais dans `taches`** : la page affiche
  `taches` en PROPOSITION, et « Envoyer » y ferait partir `suggested_reply` —
  une NOTE INTERNE pour l'hôte — au voyageur. Le fil en direct
  (`GET /api/messages?direct=1&fil=…`) lit les deux statuts en UNE lecture
  (`in('status', ['pending_validation', 'pending'])`, les plus récentes
  d'abord, borne 50) et rend un champ NEUF, `infos: [{ id, book_id,
  property_id, created_at, maj, questions }]` : les questions seules, ni la
  note interne, ni le résumé ; ni intervention, ni tâche système (pause,
  arrêt de l'agent). `taches` garde exactement sa forme d'avant. Le nombre de
  requêtes ne change pas. Les deux lectures directes de `pages/messages.html`
  (au chargement, et « Proposer ») ne changent pas : la carte vient du fil en
  direct, donc elle apparaît **au premier cycle, au plus 5 s après l'ouverture
  de la conversation** — aucun appel de plus n'est lancé à l'ouverture (review
  1, constat 6). Une carte périmée d'une visite précédente reste sans danger :
  un clic reçoit 409 et la carte se relit.
- **Pas de carte pour les tâches de SECOURS du cron** (review 1, constat 5) :
  sortie de l'IA illisible, ou emoji répondant à une question. Leur `question`
  est le message entier du voyageur, qui peut porter plusieurs demandes ;
  Oui / Non / Autre y donnerait un « oui » global. L'hôte garde le bouton
  « IA » de la saisie.
- **Clôture.** L'envoi d'une réponse rédigée depuis la carte clôt la tâche
  `info_unknown` par `POST /api/messages { action: 'info_traitee', task_id,
  maj, booking_id }`. ⚠ `maj` est la version de la tâche sur laquelle l'hôte
  a tranché (review 1, constat 4) : si le cron l'a complétée depuis (le
  voyageur a écrit une nouvelle question), le serveur rend `409
  questions_changees`, rien n'est écrit, et la tâche reste dans « À valider ».
  L'`UPDATE` porte la même condition (`updated_at` inchangé).
  Le statut est relu avant l'écriture, et l'`UPDATE` porte la condition
  `status = 'pending'` (course avec un second clic, ou avec le cron qui
  complète la tâche). Une proposition ou une intervention y rend 404 (elles
  ont leur circuit), une tâche système 409 `sans_question`. Rien n'est écrit
  dans le journal `conversations` : il porte les réponses de l'agent.
- **Droits.** Un membre délégué qui a `messages: write` mais pas le droit
  d'écrire dans la base ne voit pas la carte C, et le writer de la base le
  refuse en 403 (règle « un masquage par droit ne suffit jamais »).

## 4. Catégorie de la donnée

**Temps réel** (messages et tâches de la conversation) : aucun résumé, aucun
cache navigateur. Les textes rédigés ne sont pas stockés sur le serveur : ils
vivent dans la zone de saisie jusqu'à l'envoi.

## 5. Case performance (règle « tout lot qui touche le front »)

| # | Point | Réponse |
|---|---|---|
| 1 | Un écran = un endpoint d'écran | La page Messages garde ses lectures. Les trois actions neuves sont des gestes, pas de l'affichage. |
| 2 | Donnée non urgente = résumé | Sans objet : rien de non urgent. |
| 3 | Cache navigateur | Aucun : ce sont des tâches et des messages (temps réel). |
| 4 | `private, no-store` avant le premier refus | Oui, sur `/api/guestflow-rediger`, 405 compris. |
| 5 | Fichiers statiques versionnés | Le JS ajouté vit dans un module partagé versionné (`shared/…`). |
| 6 | Pas de lecture tronquée à 1000 lignes | Lectures bornées : une tâche, les 30 derniers messages du fil, les réponses prêtes d'un logement (bien moins de 1000), au plus 10 lignes du journal. Les tâches du fil en direct sont lues des plus récentes aux plus anciennes : la borne des 50 ne peut pas cacher la proposition du jour derrière de vieilles tâches jamais closes. |
| 7 | Budget par écran | **Aucun appel périodique ajouté** : le fil en direct reste à 12 appels par minute. Chaque geste (« Rédiger », « IA », proposition de base) coûte un POST et un appel IA. Tenu par un test qui compte les appels de la page. |
| 8 | Mesure avant / après | Avant, mesuré en production le 10 novembre 2026 : une relecture du fil = 7 requêtes, 423 octets. Après : identique hors gestes, à remesurer en recette. |

## 6. Inventaire (rien n'est retiré)

| Existant | Sort |
|---|---|
| Tâche `info_unknown` et ses `sub_tasks` | **Conservée.** La carte la lit. |
| Alerte SMS / e-mail de l'info manquante | **Conservée, inchangée.** Elle part dans le tour de classification (§1) : la clôture ne la retire pas. |
| Liste « À valider » d'Aujourd'hui | **Conservée.** |
| « Proposer une réponse », qui ne dépose rien sur `info_unknown` | **Conservé.** La carte prend le relais dans la conversation. |
| « Réponses prêtes » et « Utiliser » dans la saisie | **Conservés.** |

## 7. Mobile

La page Messages est la même au téléphone. La carte, le bouton « IA » et la
proposition de réponse prête y sont, avec des boutons à la taille du pouce.

## 8. Étapes

1. **A + B** : la carte avec Oui / Non / Autre, « Rédiger la réponse », le
   bouton « IA », la clôture de la tâche. Recette sur staging : une tâche
   `info_unknown` de recette, posée à la main.
2. **C** : la proposition de réponse prête (créer ou modifier). Recette sur
   staging, avec une base de recette.

Chaque étape fait l'objet de sa propre remise au chef de file.

## 9. Dépendances (à ordonner par le chef de file)

- `pages/messages.html` est aussi tenu par le lot 3 de la base de connaissance
  (`kb-v5-base-connaissance`, zone de saisie au téléphone), par le lot 2c-3
  de la PWA (tiroir « Réponses de l'IA ») et par la dette 133 (`lancerEnvoi`).
- `api/messages.js` : la lecture du fil en direct, déjà en production.
- La dette 144 est indépendante (code d'accès).

## 10. Décisions de Thierry (10 novembre 2026)

1. **Pas de carte pour une « intervention » (urgence).** Elle garde son
   alerte : une intervention n'est pas une question à laquelle on répond par
   oui ou non. La carte ne lit que les tâches `info_unknown`.
2. **Deux étapes** : la carte et le bouton « IA » d'abord, puis, après leur
   recette, les réponses prêtes.
3. **Le plafond de l'hôte est le sien** : 10 rédactions par conversation sur
   24 h, sans toucher les 3 appels de l'agent (« 3 est trop petit de toute
   façon »).
