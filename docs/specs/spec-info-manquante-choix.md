# Spec — Information manquante : l'hôte répond par Oui / Non / Autre, l'IA rédige, la base apprend

**Statut : VALIDÉE par Thierry le 10 novembre 2026** (décisions du §10).
Numéro au registre : demandé au chef de file le 10 novembre 2026, pas encore
reçu. Domaine messagerie / GuestFlow. Ce lot touche l'**envoi au voyageur** :
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
  aussi l'hôte par SMS ou e-mail (`sendAlertNotifications`), après le délai
  « alerte info manquante » et en tenant compte de la sourdine.
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
- Quand la réponse part, la tâche `info_unknown` est **close** (`done`), et
  l'alerte SMS ou e-mail qui n'était pas encore partie ne part plus : la règle
  du 27 octobre (« si l'hôte agit, pas de SMS ») s'applique.
- La carte ne remplace rien. Aujourd'hui garde sa liste, et l'alerte garde son
  délai et sa sourdine.

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
    rend `{ texte }`.
  - `texte` : `{ bookingId, brouillon }` rend `{ texte }`.
  - `base` : `{ bookingId, tacheId, envoye }` rend `{ propositions: [{ action:
    'creer'|'modifier', id?, sujet, texte, avant? }] }`.
- **Gardes.** `requirePermission` avec `domaine: 'messages'`, `niveau:
  'write'`, booking requis, donc le compte et le bien désignés par la
  réservation, comme `api/guestflow-proposer.js`. La garde de coût IA
  (`lib/guestflow-garde.js` : plafond par jour, délai après échecs). Le kill
  switch du bien. Chaque appel IA est journalisé (`avecContexteIA`).
  `private, no-store` avant le premier refus, et le nombre de requêtes dans
  `Server-Timing`.
- **Lectures des propositions.** `pages/messages.html` (deux lectures) et
  `api/messages.js` (fil en direct) prennent aussi les tâches `info_unknown`
  au statut `pending`. Le filtre change, pas le nombre de requêtes.
- **Clôture.** L'envoi d'une réponse rédigée depuis la carte clôt la tâche
  `info_unknown` par une action du writer existant (`POST /api/messages`). Le
  statut est relu avant l'écriture, comme pour les propositions.
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
| 6 | Pas de lecture tronquée à 1000 lignes | Lectures bornées : une tâche, une réservation, les réponses prêtes d'un logement (bien moins de 1000). |
| 7 | Budget par écran | **Aucun appel périodique ajouté** : le fil en direct reste à 12 appels par minute. Chaque geste (« Rédiger », « IA », proposition de base) coûte un POST et un appel IA. Tenu par un test qui compte les appels de la page. |
| 8 | Mesure avant / après | Avant, mesuré en production le 10 novembre 2026 : une relecture du fil = 7 requêtes, 423 octets. Après : identique hors gestes, à remesurer en recette. |

## 6. Inventaire (rien n'est retiré)

| Existant | Sort |
|---|---|
| Tâche `info_unknown` et ses `sub_tasks` | **Conservée.** La carte la lit. |
| Alerte SMS / e-mail de l'info manquante (délai, sourdine) | **Conservée.** Elle ne part plus si l'hôte a répondu avant l'échéance. |
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
