# Spec — Information manquante : ta réponse ferme tout, et deux réponses rédigées à la place de Oui / Non

**Statut : VALIDÉE par Thierry le 23 novembre 2026, 22h10** (« ok » sur les
quatre points du §2, proposés le même jour à 17h20).
Domaine messagerie / GuestFlow, sauf le point B (cœur & sync). Les points A, C
et D touchent l'**envoi au voyageur** : trois reviews au plus par lot, et
Thierry présent juste après le merge.
Prolonge `docs/specs/spec-info-manquante-choix.md` (validée le 10 novembre
2026) : ce qui n'est pas dit ici y reste vrai.
Numéros de dette : à donner par le chef de file.

## 0. Le cas mesuré (production, 23 novembre 2026, La bulle)

Lu dans le cœur par le fil en direct (`GET /api/messages?direct=1`). Heures de
Paris.

| heure | qui | quoi | arrivé dans le cœur par |
|---|---|---|---|
| 16:47:33 | voyageur | « Pensez-vous que le logement sera bientôt disponible ? » | webhook (immédiat) |
| 16:50:31 | cron | tâche `info_unknown` créée, une question | — |
| 16:57:03 | hôte, **depuis l'appli Airbnb** | « le ménage est encore en cours, je vous dis dès que c'est terminé » | **import** (toutes les 10 min) |
| 16:57:34 | voyageur | « D'accord nous attendons, merci beaucoup. » | webhook (immédiat) |
| 17:00:32 | cron | la tâche est **complétée** : « (message de 16h47, relancé à 16h57 par « nous attendons ») » | — |
| 17:20:32 | agent IA | « 👍 » **envoyé** au voyageur (envoi différé) | `journaliserReponseIA` |

Dans `GET /api/messages`, ordonné par `created_at`, la réponse de l'hôte vient
APRÈS le second message du voyageur, alors qu'elle a été écrite avant lui. Son
`sent_at` est à la seconde, et son `origine` est vide. C'est la signature d'un
message importé, pas d'un message envoyé depuis HôteSmart.

Trois défauts, tous lus dans le code (`main` 5e220196) :

1. **Le cron a classé un fil incomplet.** `api/channel-webhook.js` n'enregistre
   que les messages du voyageur (ligne 330 : `sender !== 'guest'` → ignoré). Une
   réponse écrite dans l'appli Airbnb n'entre dans le cœur que par
   `api/cron-messages.js`, toutes les 10 minutes. À 17:00, `preparerLot` ne
   voyait donc aucune réponse côté hôte, et il a mis les deux messages du
   voyageur dans le même lot. Comme la tâche du lot était encore ouverte, la
   classification l'a complétée.
2. **La carte s'est remontrée.** `infoAAfficher` (`shared/info-manquante.js`)
   ne cache la carte que si l'hôte a répondu après `maj`. Ici `maj` vaut 17:00,
   qui est postérieur à sa réponse (16:57). Et c'est le « 👍 » de l'IA qui l'a
   cachée à 17:20 : la règle compte comme réponse tout message sortant qui
   n'est pas un modèle, y compris ceux de l'IA.
3. **L'IA a répondu à un simple accusé de réception.** Après la réponse de
   l'hôte, le voyageur dit seulement « d'accord, merci ». C'est classé
   `sympathy`, donc l'IA envoie un émoji. De plus, l'envoi différé
   (`lib/guestflow/brouillons-dus.js`, `encoreLegitime`) ne vérifie pas si
   l'hôte a répondu depuis la pose du brouillon : il vérifie la pause, le
   réglage, l'annulation et la fin du séjour, mais pas cela.

Et un réglage trop prudent. La base de La bulle porte « Heure d'arrivée :
L'arrivée se fait à partir de 18:00 » et « transmission des accès et code : les
codes de la boîte à clé sont transmis le jour même par message ». La règle d'or
du prompt (« si la réponse exacte n'est PAS écrite dans la base, c'est
info_unknown ») a fait remonter la question à l'hôte, alors qu'une réponse sûre
existait : « les codes vous seront envoyés dès que le logement sera prêt, au
plus tard à 18h ».

## 1. La demande (Thierry, 23 novembre 2026, 17h20)

> une proposition de réponse alors que j'ai répondu ? il faut supprimer les
> réponses auto si la réponse est donnée, et en plus la question a une réponse
> dans la base de connaissance. La question par oui / non n'est pas terrible :
> peut-être partir sur une formulation avec une proposition négative et une
> positive et autre à chaque question ?

## 2. Les quatre décisions (validées le 23 novembre 2026)

### A. La réponse de l'hôte ferme tout (messagerie)

**Cette décision remplace une règle de la spec du 10 novembre.** Cette règle
disait : « le cron ne clôt jamais une tâche `pending` quand l'hôte répond à la
main ». Désormais, il la clôt.

- **Vaut réponse** : un message `outbound` de `sender = 'host'`, quel que soit
  son chemin (HôteSmart, appli Airbnb, Booking). **Ne valent pas réponse** une
  réponse de l'IA (`ai`) ni un modèle (`auto`). Un « 👍 » de l'agent ne répond
  pas à une question.
- **A1. Fermeture des tâches.** À chaque passage, le cron clôt (`done`) toute
  tâche `info_unknown` du fil créée **avant** la dernière réponse de l'hôte.
  Il ne touche ni aux tâches `intervention` (l'hôte les solde lui-même) ni aux
  tâches système (pause, arrêt de l'agent). Le précédent existe déjà :
  `fermerTachesPause` (`lib/cron-classify.js`), qui tourne avant les gardes et
  avant le modèle. La fermeture passe au même endroit et a la même forme : un
  `update ... eq('status','pending')`, borné au compte, au bien et à la
  réservation.
- **A2. Retrait des brouillons.** Une réponse de l'IA en attente (proposition
  Mode Test, ou brouillon différé visible pendant le délai) est retirée si
  l'hôte a répondu après le dernier message du voyageur auquel elle répond.
  `encoreLegitime` ajoute ce contrôle, relu au moment de l'envoi, avec le motif
  `hote_a_repondu`. Le brouillon passe alors en `expired`, pas en proposition
  à valider : l'hôte a déjà traité le fil.
- **A3. La carte se compare à la question.** `infoAAfficher` compare à
  `created_at` (le moment où la question est apparue), et plus à `maj`. Seules
  les réponses `host` comptent. C'est le filet de la fenêtre qui précède A1 :
  au plus 5 minutes, ou 10 si la réponse vient de l'appli Airbnb (voir B).
- **A4. Pas d'émoji après la réponse de l'hôte.** Un lot classé `sympathy` dont
  le message qui le précède est une réponse `host` ne reçoit **aucune réponse
  automatique**. Le lot est marqué traité, comme une proposition sans réponse.
  La règle est écrite dans le code, après la classification, et pas dans le
  prompt : elle se teste sans modèle. Après un message de l'IA, rien ne change.

### B. L'IA ne classe pas un fil où manque une réponse de l'hôte (cœur & sync)

- Avant d'appeler le modèle sur un fil Channex, la couche sync **relit chez le
  partenaire les messages de ce fil** (un appel : `GET
  /message_threads/:id/messages`) et les enregistre par `recordMessage`. Le
  writer reste le même. Le fil du prompt est ensuite reconstruit depuis le cœur.
- L'identifiant du fil vient de `messages.provider_thread_id`, posé par la
  dette 129, lot 1. **B ne démarre donc pas avant que ce lot soit en
  production.**
- Si la relecture échoue, on ne classe pas pendant ce passage. Au-delà de
  10 minutes après le dernier message du voyageur, on classe quand même :
  l'import est passé entre-temps, et un partenaire en panne ne doit pas
  rendre l'agent muet.
- Le coût est d'un appel par lot à classer. On n'en paie aucun quand rien
  n'attend, puisque `preparerLot` sort avant.
- Beds24 n'est pas concerné : sa synchronisation des messages rapporte déjà
  les deux sens.

### C. Une heure fixée par la base répond à « quand ? » (prompt de classification)

- Dans `classifierLot`, section ARRIVÉE ANTICIPÉE et EXACTITUDE : quand la
  base fixe une heure (« arrivée à partir de 18:00 », « codes transmis le jour
  même »), une question sur le moment où le logement sera prêt ou disponible
  est `info_known`. La réponse reprend cette heure comme une **limite** : « au
  plus tard à 18h ». Elle ne promet jamais plus tôt.
- Les règles d'exactitude restent entières. Si le code n'est pas marqué envoyé
  dans « ÉTAT DES ENVOIS », la réponse ne dit jamais que le logement est
  accessible. Elle ne dit pas non plus que le ménage est fini.
- Le Simulateur partage `classifierLot` : la recette commence par lui, sur le
  message réel du §0.

### D. Deux réponses rédigées à la place de Oui / Non (cron, serveur et carte)

- Pour chaque question d'une tâche `info_unknown`, la classification produit,
  dans le **même appel** (sans coût de plus), deux formulations courtes **en
  français, pour l'hôte** :
  `sub_tasks[].positive` et `sub_tasks[].negative`, d'au plus 120 caractères.
  Exemple pour le §0 : « Le logement est prêt : j'envoie les codes
  maintenant » / « Le ménage est encore en cours : les codes arrivent au plus
  tard à 18h ».
  Elles restent des **choix proposés à l'hôte**. Elles ne contiennent jamais
  de code ni de numéro, et seulement des faits tirés de la base ou de
  l'historique. Comme pour `suggested_reply` : « deux mondes », le voyageur ne
  les lit jamais telles quelles.
- **La carte montre trois boutons par question** : la formulation positive, la
  formulation négative, et « Autre », qui garde son champ court. Une tâche
  sans formulations (tâches d'avant ce lot, sortie de secours du cron) garde
  Oui / Non / Autre.
- **Serveur** (`POST /api/guestflow-rediger`, action `choix`) : `reponse`
  accepte `positive | negative | autre`, avec `oui | non | autre` pour les
  anciennes tâches. **Le texte de la formulation est relu dans la tâche en
  base, jamais pris dans la requête** : même règle que la question, relue au
  caractère. S'il a changé, la réponse est `409 questions_changees`.
- « Rédiger la réponse » reçoit la formulation choisie comme la décision de
  l'hôte. Le reste ne change pas : conversation, langue du voyageur, sans la
  base, texte posé dans la saisie, rien ne part sans l'hôte.
- La proposition de réponse prête (étape C de la spec du 10 novembre) reçoit la
  formulation choisie à la place de « oui » ou « non ».

## 3. Ordre des lots

1. **A**, le plus visible : la carte et le « 👍 » de ce soir. Il ferme presque
   tout le cas du §0 : la réponse importée à 17:05-17:10 clôt la tâche au
   passage suivant, et il n'y a plus d'émoji après la réponse de l'hôte.
2. **D** : le changement que Thierry verra à chaque question.
3. **C** : un réglage du prompt, éprouvé au Simulateur.
4. **B** : après la dette 129 lot 1 en production. Il ferme la fenêtre de
   10 minutes qui reste après A.

## 4. Case performance

| # | Point | Réponse |
|---|---|---|
| 1 | Un écran = un endpoint d'écran | Sans objet : aucun écran neuf. La carte (D) garde ses lectures. |
| 2 | Donnée non urgente = résumé | Sans objet : temps réel (messages et tâches). |
| 3 | Cache navigateur | Aucun. |
| 4 | `private, no-store` avant le premier refus | Inchangé sur `/api/guestflow-rediger`. |
| 5 | Fichiers statiques versionnés | `shared/info-manquante.js` garde son empreinte de version. |
| 6 | Pas de lecture tronquée à 1000 lignes | A1 : un `update` borné au fil. B : la relecture d'un fil est paginée par curseur, comme `idsDesMessagesDuFil` (dette 129). |
| 7 | Budget par écran | Aucun appel ajouté à la page. B : un appel au partenaire par lot à classer, et aucun quand rien n'attend. |
| 8 | Mesure avant / après | À mesurer en recette : nombre de requêtes du passage du cron (carte 20 du diagnostic) avant et après A1 et B. |

## 5. Inventaire (rien n'est retiré)

| Existant | Sort |
|---|---|
| Carte « Information manquante » | **Conservée.** Les boutons Oui / Non deviennent deux formulations (D) ; Oui / Non restent pour les tâches sans formulations. |
| Bouton « IA » de la saisie | **Conservé**, inchangé. |
| Alerte SMS / e-mail de l'info manquante | **Conservée**, inchangée. La clôture A1 ne retire pas une alerte déjà partie. |
| « À valider » d'Aujourd'hui | **Conservé.** Les tâches closes par A1 en sortent. |
| Réponse automatique à un « merci » sans réponse de l'hôte avant | **Conservée** (A4 ne vise que le « merci » qui suit l'hôte). |

## 6. Mobile

La page Messages est la même au téléphone. Les deux formulations sont des
boutons pleine largeur, l'une sous l'autre, car elles sont trop longues pour
tenir côte à côte au pouce.

## 7. Tests qui doivent rougir contre le code d'avant (REVIEW.md règle 19)

- A1 : un fil où une réponse `host` suit une tâche `info_unknown` → la tâche
  passe en `done`. Une réponse `ai` ne la clôt pas.
- A2 : un brouillon différé dont le fil a reçu une réponse `host` après le
  dernier message du voyageur → `hote_a_repondu`, rien ne part.
- A3 : le fil exact du §0 (création 16:50, réponse 16:57, `maj` 17:00) → pas
  de carte. Un « 👍 » `ai` seul ne cache pas une carte.
- A4 : réponse `host`, puis « D'accord nous attendons, merci beaucoup. » classé
  `sympathy` → aucun envoi, lot marqué traité.
- B : la réponse de l'hôte absente du cœur et présente chez le partenaire →
  après la relecture, le lot ne contient que le dernier message du voyageur.
- D : une formulation modifiée dans la requête est ignorée, et c'est celle de
  la base qui part au modèle. Une tâche sans formulations rend Oui / Non /
  Autre.
