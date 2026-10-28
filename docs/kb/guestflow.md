# KB — GuestFlow AI (agent voyageur)

<!-- SOURCES (mapping inverse). ⚠️ DOC en tête de ces fichiers pointe ici. Modif = MÊME COMMIT. -->
> Sources : `lib/cron-messages.js`, `lib/canal-voyageur.js`, `lib/email-guestflow.js`, `api/agent-config.js`, `api/grok.js`,
> `apps/agent-ai/config.html`, `apps/agent-ai/messagerie.html`, `apps/agent-ai/knowledge.html`

## Ce que fait l'agent
Répond aux messages voyageurs (Claude Haiku) **à partir de la base de connaissances du bien**
(adresse, wifi, check-in, règles…). Il n'invente pas : hors base, il ne répond pas seul.

- **Info connue** → réponse automatique, signée au nom de l'hôte, à toute heure.
- **Info inconnue** → l'IA demande la réponse à l'hôte **une fois**, puis l'apprend.
- **Urgence** → l'hôte est alerté (**email par défaut**, SMS optionnel via Brevo — voir `alertes.md`),
  l'IA ne gère pas seule.

## Deux modes
- **Automatique** : l'IA envoie directement.
- **Validation** : le message reste en attente (`pending_validation`), l'hôte valide avant envoi.


## Par où sort un message (`lib/canal-voyageur.js`)

Un seul module décide, et il rend **toujours** un canal *et* un motif — « je ne sais pas »
n'est pas une réponse.

| source de la réservation | canal | motif |
|---|---|---|
| Airbnb, Booking, tout canal de vente | messagerie OTA | `messagerie_ota` |
| `Offline` **avec** adresse dans le cœur | e-mail au voyageur | `email_voyageur` |
| `Offline` **sans** adresse | aucun | `pas_d_email` |
| saisie directe Beds24, aucune source | aucun | `sans_canal` |

### ⚠️ C'est la SOURCE qui tranche, jamais la présence d'une adresse

Booking.com sert un alias de relais (`…@guest.booking.com`) dans le même champ qu'une
réservation directe, **et cet alias délivre**. Router sur « une adresse existe » sortirait
ces réservations de leur messagerie OTA. Mesure du 16 septembre 2026 : sur les 148 adresses
du cœur, 114 sont des adresses d'OTA, contre 7 Offline.

### ⚠️ Ce que `hasMessagingThread` disait de faux

Elle répondait « oui, il y a un fil » pour toute source non vide et différente de `direct` —
donc **oui pour `Offline`**. GuestFlow tentait l'envoi, Channex répondait `HTTP 422
not_supported`, et comme `message_sent_log` était écrit **avant** l'envoi, trois réservations
portent un `booking_confirmed` marqué envoyé que le voyageur n'a jamais reçu. Le fil côté hôte
affichait un message délivré. Un faux vert, pas une panne — c'est pire, parce que personne ne
cherche.

### L'ordre du journal dépend du canal

- **Messagerie OTA** : `message_sent_log` écrit **AVANT** l'envoi. C'est l'anti-boucle
  historique — un envoi parti et non noté repart toutes les 5 minutes. Contrepartie assumée :
  un échec n'est pas rejoué, l'incident `send_failure` le dit à l'hôte.
- **E-mail** : écrit **APRÈS** un succès. Un 400 Brevo est définitif et doit pouvoir être
  corrigé (adresse saisie, expéditeur vérifié) puis rejoué. Sur échec, **rien** n'est écrit :
  ni journal, ni `conversations`, ni `messages` — un fil qui afficherait un message non
  délivré est exactement le faux vert qu'on vient de fermer.

### L'asymétrie du code d'accès, qui est une décision

Les moteurs de templates n'écrivent rien quand l'e-mail n'est pas parti. `lib/cron-arrival-code.js`,
lui, garde son filet — tâche à l'hôte pour transmission manuelle **et** ligne de journal.
Un code d'accès qui n'arrive pas, c'est une porte fermée devant le voyageur ce soir-là.

Ce que ce filet ne fait **pas**, depuis la review du 16 septembre 2026 :

- il n'**alerte plus le fondateur** quand le canal e-mail n'est simplement pas branché.
  `differe` veut dire « rien n'a été tenté », pas « l'envoi a échoué » — réveiller quelqu'un
  à chaque arrivée Offline, c'est fabriquer l'alarme qu'on apprend à ignorer, et le jour où
  un vrai échec arrive, il s'y noie ;
- il n'écrit plus le fil `conversations` ni `messages` **avant** la preuve de l'envoi, sur
  les canaux non-OTA. Ces deux écritures étaient inconditionnelles : le fil affichait le
  code d'accès comme délivré alors que rien n'était parti. Le même faux vert, reproduit sur
  le chemin du code d'accès. Le chemin OTA, lui, garde son ordre historique.

## L'envoi e-mail (`lib/email-guestflow.js`)

### La clé est celle de l'hôte, sans aucun repli

`api_keys.brevo_api_key` du compte **propriétaire du bien** — jamais `process.env`, jamais
l'appelant (qui peut être un membre délégué). Même règle que `api/sms.js` : ce sont ses
crédits, son domaine, sa réputation d'expéditeur. Un repli sur une clé plateforme ferait
partir les messages de tous les hôtes depuis la même adresse, et un seul signalement pour
spam les couperait tous. Sans compte propriétaire résolu, **on n'envoie pas**.

### L'expéditeur est un sender vérifié, pas un champ libre

Brevo n'envoie qu'au nom d'un expéditeur vérifié : une adresse saisie librement rend `400`
**à l'envoi**, pas à la configuration — l'hôte croirait avoir réglé son adresse et ne
découvrirait l'échec qu'au premier message raté, c'est-à-dire devant un voyageur.

L'hôte choisit son adresse dans **`/connexions`**, carte « Brevo — SMS et e-mails »
(`api_keys.brevo_sender_email` / `brevo_sender_name`) :

- le menu est **alimenté par Brevo** (`GET /api/sms?action=senders`), filtré sur les
  expéditeurs actifs. Jamais un champ texte ;
- **le serveur revérifie le choix chez Brevo avant d'écrire** (`action=saveSender`). Se fier
  au menu affiché reviendrait à accepter n'importe quelle adresse postée à la main — donc à
  enregistrer une identité d'expéditeur que l'hôte ne possède pas. La comparaison ignore la
  casse, et c'est la forme rendue par Brevo qui est stockée ;
- Brevo injoignable → **on n'enregistre rien**. Pas de validation « au bénéfice du doute » ;
- rien de choisi → premier expéditeur actif, et **l'écran l'annonce** (« Par défaut : … ») au
  lieu de laisser croire à une sélection. Ce défaut n'est pas un provisoire.

**L'expéditeur ne suit pas le toggle SMS.** Couper les SMS ne coupe pas les e-mails : deux
canaux, un seul compte Brevo. Un hôte qui refuse les SMS doit pouvoir régler l'adresse que
verront ses voyageurs.

Si le choix cesse d'être valide (expéditeur supprimé chez Brevo), l'envoi rend `400`, traité
en échec **permanent** : l'hôte est prévenu une fois et rouvre l'écran. Retomber en silence
sur un autre expéditeur ferait partir ses messages sous une identité qu'il n'a pas choisie —
pire que l'échec, parce que personne ne le verrait.

**`reply-to` = l'adresse d'expédition.** Le voyageur répond, l'hôte reçoit dans sa boîte.
L'ingestion de ces réponses dans la messagerie HôteSmart est un chantier séparé : tant
qu'il n'existe pas, un `reply-to` pointant ailleurs ferait disparaître les réponses.

### Le texte du template part tel quel

Pas de refonte (spec §4). Il est **échappé** — c'est du texte, pas du HTML : une apostrophe
ou un `<` ne doit ni casser la page ni ouvrir une injection dans la boîte du voyageur —
puis une ligne vide devient un paragraphe et un saut simple un `<br>`. Marque blanche : le
seul nom qui apparaît est celui du bien.

**Le sujet est dérivé** de l'`event_type` et du nom du bien (`sujetPour`), parce qu'un
template n'a pas de champ sujet et qu'on n'en ajoute pas un. En français, comme le corps :
un sujet traduit devant un corps français serait un faux service.

### ⚠️ Trois issues à un échec, et elles ne se confondent jamais

| issue | exemples | ce qu'on fait |
|---|---|---|
| **permanent** | 4xx Brevo, adresse invalide, aucun expéditeur vérifié, Brevo non configuré | on abandonne **tout de suite**, on écrit `message_sent_log` (sinon ça repart toutes les 5 min) et on prévient l'hôte — c'est un geste de sa part qu'il faut |
| **quota** | 429, **402** (crédits épuisés — un 402 est un quota, pas un refus définitif) | on repassera, **hors plafond** : un forfait journalier épuisé rend 429 toute la journée, un plafond abandonnerait le message en 20 minutes alors qu'il repart à minuit. Signalement propre, une seule fois |
| **transitoire** | 5xx, réseau coupé | on repassera, et on **compte**. Au plafond (5 en 24 h), on abandonne et on le dit |

Compter sans distinguer aurait fait attendre cinq échecs à une adresse qui ne marchera
jamais, et abandonné un quota qui se rétablit tout seul.

⚠️ **Le chemin one-shot n'utilise pas ce plafond.** `triggerTemplates`
(`booking_confirmed`) n'aura jamais qu'une tentative : l'événement est marqué traité quoi
qu'il arrive. Attendre cinq échecs qui ne viendront pas, c'est ne jamais alerter — alors
qu'avant ce chantier `send_failure` remontait dès la deuxième occurrence. Un échec y est un
abandon par nature, quota compris (le quota se rétablira, pas l'événement) : l'alerte part
immédiatement.

Le compteur vit dans `automation_incidents` (type `email_voyageur_echec`, clé
`EMAILKEY:<booking>:<template>` interrogée via **`detail->>message`** — la colonne est du
JSONB et `reportIncident` y range une chaîne sous `{ message }` ; un `ILIKE` sur la colonne
entière fait lever Postgres, l'erreur est avalée par le fail-safe, le compte rend 0 et le
plafond n'est jamais atteint), **sans nouvelle table** : les migrations
de ce dépôt se collent à la main dans l'éditeur Supabase, et en demander une pour un
compteur aurait fait attendre tout le chantier sur un geste humain. Ces lignes ne réveillent
personne (seuil inatteignable) ; c'est l'abandon (`email_voyageur_abandon`) qui alerte, une
fois, avec de quoi agir.

### `ENVOI_EMAIL_BRANCHE` — devenu un kill switch de canal

Ouvert depuis l'étape 3. Les sorties anticipées qui le citent sont **conservées** : le
refermer coupe le canal e-mail sans déployer, et les deux moteurs sortent alors **avant**
`generateAutoMessage` — sans quoi un appel Claude Haiku partirait par réservation Offline et
par template, toutes les 5 minutes, sur toute la fenêtre −7 j/+30 j, pour un message qui ne
part pas.

### ⚠️ « En attente » et « perdu » ne sont pas le même mot

Les deux moteurs n'ont pas la même physique, et c'est ce que la review a rattrapé :

- **`checkAndSendTemplate`** (arrival / departure) est rejoué par le cron `*/5` tant que le
  séjour a un sens. Un e-mail non parti y est vraiment **en attente** : rien n'est écrit,
  tout repartira.
- **`triggerTemplates`** (`booking_confirmed`) n'a qu'un seul appelant, `consommateurTemplates`
  dans le dispatcher, qui consomme un événement **one-shot** et le marque `processed_at`
  juste après, quel que soit le résultat. Rien ne le rejouera jamais. Le message de
  bienvenue d'une réservation Offline créée pendant que l'interrupteur est fermé est donc
  **perdu pour cette réservation** — il part dans `results.errors` (`email_non_branche`), pas
  dans un log rassurant, et se rattrape à la main si le séjour compte.

### Le Mode Validation route enfin (corrigé à l'étape 3)

`apps/agent-ai/messagerie.html` postait **« Valider et envoyer » en dur vers `/api/beds24`** —
un chemin Beds24 seul, qui ne connaît ni Channex ni l'e-mail. Sur un bien Channex, le message
validé par l'hôte partait du mauvais côté et n'arrivait jamais ; avec le canal e-mail ouvert,
il aurait en plus été journalisé comme envoyé sans l'être.

L'endpoint ne refuse que ce qu'il sait impossible — une réservation Offline **sans
adresse**. Une réservation dont la source ne dit rien (`sans_canal`) part quand même chez
Channex, comme avant : le normaliseur écrit `source: ota_name || 'direct'`, et `'direct'`
compte parmi les sources sans canal **côté Beds24** ; appliquer ce filtre à un snapshot
Channex aurait retiré à l'hôte la possibilité d'écrire à son voyageur. En cas de doute,
c'est le provider qui tranche.

**Trois** appels postaient ainsi en dur (« Valider et envoyer », le bouton « Envoyer » d'une
sous-tâche, et l'envoi manuel qui, lui, routait déjà) : ils passent tous par une seule
fonction `posterMessage`. `/api/channel-message` route désormais par la source, comme le
cron : messagerie OTA pour Airbnb/Booking, e-mail pour les Offline, et un refus **lisible**
(422 + motif) quand la réservation n'a aucun canal — au lieu du 422 `not_supported` du
provider, que personne ne pouvait interpréter.

### `messages.canal` — par où le message est sorti (soldé à l'étape 4)

`provider` dit d'où vient la **réservation** (`beds24` / `channex`) et commande le routage
interne ; **`canal`** dit le chemin réellement emprunté (`ota` / `email`). Un envoi Brevo
était enregistré « channex / Offline » : la table affirmait qu'il était passé par la
messagerie du canal de vente — celle-là même qui rend 422 sur ces réservations.

Défaut `'ota'`, exact pour tout l'existant : avant ce chantier, c'était le seul chemin,
dans les deux sens. Aucune ligne historique n'a besoin d'être corrigée.

⚠️ **`lib/record-message.js` retombe sans la colonne si elle manque encore.** La migration se
colle à la main dans Supabase : entre le déploiement et ce geste, PostgREST rejetterait
l'INSERT entier (`PGRST204`) — donc plus **aucun** message enregistré, entrants compris,
sans qu'aucun envoi n'échoue pour autant. Le fil de l'hôte se viderait en silence. Même
parade que pour `bookings_snapshot.raw` : on tente avec, on retombe sans, et on le dit. À
retirer quand la migration `2026-09-17` sera passée.

Les colonnes d'expéditeur ont le même repli, côté lecture (`lib/email-guestflow.js` et
`/api/sms?action=config`) et côté écriture (`action=saveSender` répond « pas encore
disponible » plutôt qu'un message PostgREST brut dans un toast).

## Le badge « pas d'e-mail — messages non envoyés »

Une réservation directe sans adresse ne reçoit **rien** : ni confirmation, ni consignes
d'arrivée, ni code d'accès. Le cron n'écrit alors aucune ligne de journal et **n'alerte
pas** — c'est un *état*, pas une panne, et une alarme qui sonnerait toutes les heures sans
qu'aucun geste ne la fasse taire est une alarme qu'on apprend à ignorer.

Restait à le **montrer** là où l'hôte regarde la réservation : la fiche du planning
(`pages/biens-calendrier.html`, `badgeSansEmail`). Sans ce badge, il découvrirait le silence
le jour de l'arrivée, devant un voyageur sans son code.

- **Seulement sur les réservations sans messagerie OTA.** Une résa Airbnb n'a pas d'adresse
  non plus — la plateforme ne la communique jamais — et ses messages passent très bien par la
  messagerie de l'OTA. Le badge y serait faux, et un badge faux apprend à ignorer les vrais.
- **Mais « Offline » n'est pas le seul cas.** Une saisie directe côté Beds24 arrive avec
  `source: 'direct'` : `lib/canal-voyageur.js` la classe `sans_canal`, elle ne reçoit rien
  non plus, et la fiche affichait « Canal : Direct » sans avertissement. Le badge couvre les
  deux.
- **`/api/calendar` sert un booléen `aEmail`, jamais l'adresse.** La fiche a besoin de savoir
  si les messages peuvent partir, c'est tout ; faire transiter l'adresse de chaque voyageur
  pour afficher un badge exposerait bien plus que le besoin, dans une réponse qui couvre des
  mois et tous les biens du compte.
- **La collecte existait déjà** : le formulaire de saisie manuelle porte le champ e-mail
  (facultatif) depuis la phase 2 de la réservation manuelle, et il part bien jusqu'au
  provider. C'est le badge qui manquait, pas la collecte.

## « Vous avez une nouvelle réservation » — l'e-mail à l'HÔTE

`lib/notif-hote-resa.js`, branché comme **consommateur du dispatcher** (`3 bis`).

Une réservation Airbnb ou Booking, l'hôte l'apprend par la plateforme. Une réservation
**directe**, personne ne la lui annonçait : il devait ouvrir HôteSmart pour savoir qu'il
avait vendu.

**Dans le dispatcher, pas dans le moteur ni dans la saisie manuelle.** Les deux créent des
réservations `Offline` et passent toutes deux par le feed : brancher une fois ici couvre les
deux sources, et la prochaine. Deux branchements en amont auraient donné deux
implémentations — et un jour, une seule des deux corrigée.

- **Offline seulement, en v1.** Notifier aussi les OTA doublerait ce que les plateformes
  font déjà : deux e-mails pour un même fait, et on apprend à les ignorer tous les deux.
  Le filtre vit dans le module, **pas** aussi dans le dispatcher : deux gardes d'accord
  aujourd'hui, c'est une garde oubliée demain.
- **Sur `new` seulement.** « Nouvelle réservation » sur une modification serait faux ; sur
  une annulation, absurde. Et si la réservation a été annulée entre la détection et l'effet,
  rien ne part — annoncer une vente défaite est pire que ne rien annoncer.
- **Même canal host-owned** : la clé Brevo du compte propriétaire, son expéditeur vérifié.
  L'hôte s'écrit à lui-même sous son propre nom — et surtout, sa notification de vente ne
  dépend pas d'une clé plateforme qu'il ne contrôle pas.
- **Mais avec repli plateforme, et ici il va de soi.** Sans lui, un hôte qui n'a jamais
  connecté Brevo n'aurait *jamais* été prévenu de ses ventes directes — exactement le manque
  que cette fonction comble — pendant que le fondateur recevait un SMS à chaque vente. Les
  deux moitiés du défaut se tenaient : l'hôte muet, l'alarme bruyante. Et la question est
  plus simple que pour le voyageur : le destinataire est **l'hôte**, qui sait parfaitement ce
  qu'est HôteSmart. La marque blanche protège l'illusion du voyageur, pas la sienne.
- **Destinataire** : le profil `is_owner` du compte. `notify_email = false` est un refus
  explicite, respecté — et ce n'est **pas** une panne, donc aucun incident.

### ⚠️ La dédup passe par `message_sent_log`, avec un `template_id` sentinelle

La table porte un index unique `(user_id, booking_id, template_id)` et `template_id` n'a
**aucune clé étrangère** : un UUID constant y tient la place d'un template, et c'est la base
qui garantit l'unicité — pas notre vigilance. Le dispatcher peut rejouer un événement (échec
d'un consommateur, reprise après coupure) ; sans cette garde, l'hôte recevrait deux fois la
même annonce.

**La ligne est posée AVANT l'envoi.** Contrepartie assumée, et c'est l'**inverse** du canal
voyageur : un doublon « nouvelle réservation » inquiète plus qu'un manque, que l'écran des
réservations comble.

Avec une exception : quand les deux canaux échouent et que l'échec est **transitoire** (un
quota Brevo se rétablit à minuit), la ligne est **retirée**. Sans ce geste, la sentinelle
condamnerait l'annonce pour toujours — rattrapage manuel compris. Un échec **permanent**, lui,
garde sa ligne : rien ne sert de réessayer ce qui ne peut pas marcher.

### Ce qui manque au voyageur est dit à l'hôte

Si la réservation n'a pas d'adresse, l'e-mail le dit en clair : aucun message automatique ne
partira, ni confirmation, ni consignes, ni code d'accès. C'est le pendant du badge sur la
fiche — l'hôte l'apprend quand il peut encore appeler son client, pas le jour de l'arrivée.

### Une annonce ratée est un échec, jamais un silence

Incident `notif_hote_non_envoyee` (seuil 1, **sans SMS**) et trace dans `processing_errors`.
Sans SMS parce que la réservation, elle, est bien enregistrée : c'est son annonce qui manque.
Un SMS par vente et par bien sur un compte mal configuré, c'est l'alarme qu'on apprend à
ignorer — et le jour d'une vraie panne, elle s'y noie. L'hôte croit
être prévenu de ses ventes : s'il ne l'est pas, il doit l'apprendre autrement que par un
client à sa porte. L'échec **n'emporte pas** les autres consommateurs — ni le ménage, ni le
code d'accès, ni le message de bienvenue.

### `guestPhone` a rejoint le cœur

Même régime que `guestEmail` (jamais `null`, cf. `emailOuRien`) : `customer.phone` côté
Channex, `mobile` puis `phone` côté Beds24. Il **n'ouvre aucun canal** — les SMS au voyageur
ne sont pas du périmètre. Il sert à cette notification, pour que l'hôte puisse joindre son
client sans ouvrir trois écrans, et il dormait dans `raw` comme l'adresse y dormait.

## Rattraper un message que le 422 avait condamné

`scripts/rejouer-message-offline.js <bookingId> <templateId> [--execute]`.

`booking_confirmed` passe par `triggerTemplates`, déclenché par un événement **one-shot**
que le dispatcher marque `processed_at` : supprimer la ligne de `message_sent_log` ne suffit
pas à le faire repartir, rien ne relira cet événement. Ce script est le rejeu manuel.

Il emprunte **les fonctions du cron**, jamais des copies (`knowledgeDuBien`,
`generateAutoMessage`, `canalPour`, `sendGuestMessage`, `noterEnvoi`) : un script de
rattrapage qui réimplémenterait le chemin ne prouverait rien du chemin réel. Une première
version recopiait la lecture de `knowledge` et y perdait son filtre `type = 'fixed'` — le
voyageur aurait reçu une adresse que le cron n'aurait jamais envoyée.

Les gardes, dans l'ordre du cron : séjour **actif** (une confirmation de bienvenue sur un
séjour annulé n'a pas de sens), arrivée **dans la fenêtre −7 j/+30 j**, kill switch, canal
e-mail, `message_sent_log`, empreinte de séjour. Chacune **arrête** si sa lecture échoue :
`supabase-js` ne lève pas, et une garde qui ignore `error` conclut « rien trouvé » — donc
« envoie » — sur une panne. C'est la seule barrière entre l'opérateur et un doublon.

**Le texte envoyé est celui qui a été lu.** `generateAutoMessage` finit par un appel Haiku
sans température figée : deux générations ne rendent pas le même texte, et un `--execute`
qui régénérerait enverrait autre chose que ce que le dry run a montré. Le dry run écrit donc
un brouillon (`.rejeu-message.json`, hors dépôt) que `--execute` envoie **tel quel**, après
avoir vérifié qu'il concerne la même réservation et le même template.

**Le dry run n'alerte personne** : `generateAutoMessage` appelle `prevenirManque` quand un
placeholder manque, ce qui réveille le fondateur par SMS. Un mode « rien ne part » qui envoie
un SMS n'en est pas un — on lui passe `userId = null`, seule condition que cette alerte
regarde.

⚠️ **Et il inscrit ce qu'il envoie dans le fil.** Constaté en production le 17 septembre : le
rejeu de `c87f24ce` a bien atteint le voyageur, mais `messages` n'en portait **aucune trace**
— pendant que la ligne mensongère du 12 septembre y figurait toujours en `canal=ota`. L'hôte
voyait un message jamais parti, et ne voyait pas celui qui venait de partir : l'exact inverse
de la vérité. Le cron écrit cette ligne ; ce script doit l'écrire aussi, sinon « il passe par
les mêmes fonctions que le cron » est une phrase, pas un fait.

### Dette : les lignes mensongères de `messages` n'ont pas été purgées

La purge de l'étape 6 a nettoyé `message_sent_log` — ce qui **bloquait** les rejeux. Les trois
lignes correspondantes de `messages` (`outbound/auto`, `canal=ota`, réservations Offline du 12
et du 14 septembre) sont **toujours là** : le fil de l'hôte affiche donc encore trois messages
que le 422 de Channex avait refusés. Les corriger demande de trancher entre les supprimer
(l'historique perd une trace) et les marquer (aucune colonne ne le permet aujourd'hui).
À décider avec le product owner.

### Purger une ligne de journal qui ment

`scripts/purger-faux-envois-offline.js [--execute]` supprime, **par `id` et par `id` seul**,
les lignes de `message_sent_log` posées avant l'envoi et jamais délivrées.

⚠️ **Il vérifie `event_type` en base avant de supprimer.** Un `booking_confirmed` ne sera pas
rejoué (événement one-shot consommé), mais un `arrival` ou un `departure` est rejoué par le
cron **toutes les 5 minutes** tant que le séjour est dans la fenêtre : supprimer sa ligne
enverrait un vrai message à un vrai voyageur, en quelques minutes, sans que personne l'ait
demandé. La première version se fiait à un `template_id` relevé à la main pour affirmer que
les trois étaient des `booking_confirmed` — c'était vrai ce jour-là, et ça ne prouvait rien.

## Le `reply-to` pointe vers HôteSmart (bascule du 18 septembre 2026)

Quand on écrit **au voyageur**, le `reply-to` est `<jeton>@reply.hotesmart.fr` : sa réponse
entre dans le fil de la réservation au lieu d'arriver dans la boîte de l'hôte.

⚠️ **Au moindre doute, on retombe sur l'adresse de l'hôte** — pas de `bookingId`, pas de
secret de jeton. Une réponse doit arriver *quelque part* : un `reply-to` cassé ne se remarque
que le jour où un voyageur attend une réponse à une question qu'on n'a jamais lue.

⚠️ **Les trois chemins d'envoi doivent transmettre le `bookingId`**, et l'un d'eux a failli ne
pas le faire : `envoyerEmailVoyageur` ne le déclarait pas dans sa signature. Les appelants le
passaient consciencieusement et il tombait là, silencieusement — la bascule était inopérante
pour **deux des trois chemins** (templates GuestFlow et envoi manuel), pendant que l'encart
client annonçait le contraire.

Ce qui l'a laissé passer mérite d'être retenu : mes « tests qui comptent » étaient des **greps
de source**. Ils vérifiaient que `bookingId` apparaissait dans les fichiers appelants — ce qui
était vrai — sans jamais traverser la fonction qui le jetait. Un test qui lit du code ne voit
pas ce que le code fait. Les cas d'exécution (`tests/email-guestflow.test.js`) assèrent
désormais `replyTo.email`, et la contre-épreuve a été faite : le bug réintroduit, ils rougissent.

## La copie à l'hôte

Chaque réponse de voyageur est **aussi** envoyée à l'hôte, marquée « Copie — répondez depuis
HôteSmart » avec la conséquence dite : *votre voyageur ne le recevra pas*. C'est un filet
tant que l'application n'a pas de notifications — sans lui, un hôte qui ne l'ouvre pas ne
saurait pas qu'on lui a écrit, et il perdrait l'habitude de sa boîte avant d'avoir celle de
l'app. `notify_email = false` la désactive.

⚠️ **Elle ne porte pas de `bookingId`** : son `reply-to` retombe donc sur l'hôte. Sans ça,
répondre à la copie enverrait vraiment au voyageur, depuis un fil que l'hôte croit seulement
lire.

⚠️ **Ce filet a besoin du sien.** Il part par la clé Brevo de l'hôte : quota épuisé, clé
absente, expéditeur non vérifié — et l'hôte ne reçoit alors **plus rien**, ni la réponse (le
`reply-to` pointe vers HôteSmart) ni la copie. On replie donc sur la plateforme, et si elle
tombe aussi, on dépose une tâche. Le seul canal restant serait qu'il ouvre l'application,
c'est-à-dire l'hypothèse même que ce filet couvre.

## Les réponses des voyageurs entrent dans le cœur (`api/inbound-email.js`)

Brevo POSTe sur `/api/inbound-email` quand un e-mail arrive sur `*@reply.hotesmart.fr`.

**Validé de bout en bout en production le 18 septembre 2026** sur une réservation Offline
réelle : confirmation partie par e-mail à 17 h 33, réponse du voyageur dans le fil à 18 h 20
(`canal=email`, `inbound`), réponse de l'hôte depuis la messagerie à 18 h 21 — un seul fil,
au même endroit que les messages OTA.

### ⚠️ Le webhook apporte le contenu, la relecture l'authentifie

Channex accepte un en-tête personnalisé (`X-Channel-Webhook-Secret`) ; **Brevo n'en propose
aucun**, et un secret glissé dans l'URL fuirait dans les journaux.

La première conception — « le POST n'est qu'un déclencheur, on relit tout chez Brevo » — a
été **démentie par les faits** : `GET /inbound/events/<uuid>` ne rend que des métadonnées,
**aucun corps**. Le contenu d'un e-mail entrant n'existe que dans le POST. Détail et risque
résiduel accepté : `docs/specs/spec-canal-email-resa-directe.md`.

Ce qui **désigne** une ressource vient donc de Brevo ; ce qui la **décrit** peut venir du
POST, une fois corroboré :

- le **rattachement** se fait sur le `recipient` **relu**, jamais sur celui du payload ;
- `sender`, `subject` et `messageId` sont **confrontés** — divergence = refus. La tolérance
  est **symétrique** : Brevo documente tous les champs relus comme optionnels, et comparer une
  valeur à une absence n'est pas constater une contradiction. Une première version ne tolérait
  l'absence que du côté POST, et refusait donc un e-mail légitime dès que Brevo ne rendait pas
  le sujet ;
- l'horodatage vient de Brevo : une date du payload est choisie par l'expéditeur et ferait
  mentir l'ordre du fil ;
- **sans `uuid`, on ne relit rien et on ne traite rien.**

C'est la règle 11 appliquée à ce qui compte : le compte et la réservation ne viennent jamais
du message.

**On acquitte en 200 tout ce qu'on a décidé**, même quand on ignore : un 4xx/5xx ferait
rejouer Brevo indéfiniment sur un e-mail qu'on a décidé d'écarter. Ce qu'on ne traite pas se
journalise, ça ne se renvoie pas au facteur.

**Une seule exception, et elle va dans l'autre sens : ce qu'on n'a pas pu décider se
redemande.** Quand la relecture tombe pour une cause passagère — `429`, `5xx`, coupure
réseau, événement pas encore interrogeable, clé absente — on rend **503** et Brevo rejoue.
Constat de review, et le défaut était grave : *toute* relecture ratée rendait 200, donc Brevo
ne rejouait jamais, donc un simple incident réseau **perdait définitivement** la réponse d'un
voyageur, sans trace et sans que l'hôte l'apprenne. L'alternative — mettre le message en file
— a été écartée par Thierry le 18 septembre 2026 : le rejeu **réessaie** l'authentification,
la mise en attente y **renoncerait**. Les causes qui ne guérissent pas en recommençant (pas
d'`uuid`, clé refusée) restent en 200.

### ⚠️ La forme réelle du payload Brevo — trois écarts qui passaient au vert

Le faux client des tests servait une forme **inventée**, et trois gardes reposaient dessus :

| ce que le code lisait | ce que Brevo envoie | conséquence |
|---|---|---|
| `Spam.Score` | **`SpamScore`**, flottant, **à la racine** | `NaN` → seuil jamais atteint : **l'anti-spam était mort en production** |
| `Uuid` scalaire | **`Uuid` est un tableau** (un par destinataire) | marchait par accident à un destinataire ; à deux, l'URL devenait `a%2Cb` → 404 → message perdu. Et `[]` est *truthy* : la garde « pas d'uuid, pas de traitement » était contournée |
| `From` chaîne | **`From` est `{Address, Name}`** | la confrontation comparait une chaîne à un objet |

**La leçon, pour la quatrième fois dans ce dépôt : un faux client qui n'imite pas la forme du
vrai ne prouve rien du vrai.** Le commit précédent avait réparé le faux de la *relecture* et
laissé celui du *payload* — or depuis que le payload porte le corps, les en-têtes et le spam,
c'est **lui** qui doit être imité fidèlement. La contre-épreuve est désormais systématique :
on réintroduit le défaut et on vérifie que le test rougit.

### L'adresse de réponse porte sa preuve (`lib/jeton-reponse.js`)

`<booking>-<signature>@reply.hotesmart.fr`. **Pas de plus-adressage** : le `+` est réécrit ou
refusé par une partie des clients mail, et surtout un identifiant nu **se devine** — quiconque
connaît un `booking_id` écrirait dans le fil d'autrui. Le sous-domaine acceptant n'importe
quelle adresse locale (wildcard), elle porte identifiant *et* signature HMAC.

**Aucune table**, et c'est délibéré : un jeton aléatoire stocké aurait demandé une migration,
donc un collage manuel, donc un chantier suspendu à un geste humain. Contrepartie assumée —
un jeton ne se révoque pas ; la validité réelle se décide à la lecture de la réservation.

Minuscules partout (les relais réécrivent la partie locale sans prévenir), comparaison à
temps constant, et **sans secret on ne fabrique ni ne valide rien**.

La réservation est retrouvée par une **requête ciblée** : on reconstruit la forme canonique
d'un UUID *uniquement* sur 32 caractères hexadécimaux, où elle est sans ambiguïté. Un
identifiant Beds24, numérique, passe tel quel. Deux lignes pour un même identifiant →
**on refuse de choisir** : `booking_id` n'est unique que par compte, et répondre au hasard
ferait entrer le message d'un voyageur dans le fil d'un autre hôte.

### ⚠️ L'anti-boucle : une réponse automatique n'en déclenche pas une autre

L'agent IA lit `messages`. Y écrire un « je suis en vacances » le ferait répondre, ce qui
déclencherait un nouvel automatique — une boucle qui tourne aussi vite que les deux serveurs
le permettent.

On écarte sur les **en-têtes normalisés** (`Auto-Submitted` ≠ `no` au sens de la RFC 3834,
`X-Autoreply`, `Precedence: bulk|junk|list`, `List-Id`, `List-Unsubscribe`, `X-Loop`) et sur
un **`SpamScore` ≥ 5** (à la racine du payload — voir le tableau des trois écarts
ci-dessus) — jamais sur une heuristique de sujet, qui varierait avec la langue.
`Auto-Submitted: no` désigne explicitement un message humain : il passe.

### ⚠️ Une réservation morte ne réveille pas l'agent

`lib/jeton-reponse.js` le grave : « la validité réelle se décide à la lecture de la
**réservation**, pas du jeton ». Un voyageur dont le séjour est annulé depuis trois mois — ou
son client mail qui renvoie un vieux fil — entrait dans `conversations`, que l'IA lit et à
quoi elle peut répondre, et déclenchait une copie facturée sur la clé de l'hôte.

Le message **ne se perd pas** pour autant : il va dans la file, avec son statut. Un voyageur
qui écrit a droit à une trace, même quand son séjour n'existe plus.

### La file des non-rattachables

Un e-mail qu'on ne sait pas ranger **ne se jette pas**. Un voyageur qui répond depuis une
autre adresse, ou dont le client mail a mangé l'adresse de réponse, disparaîtrait en silence
et l'hôte ne saurait jamais qu'on lui a écrit. Il atterrit dans `agent_tasks`
(`task_type: 'email_non_rattache'`, `pending_validation`), là où l'hôte regarde déjà — avec
la raison et le message conservé.

### Dettes connues de l'inbound (seconde review, 18 septembre 2026)

Deux reviews, aucune fuite entre comptes ni contournement d'authentification — donc on
pousse, et ce qui reste se **note** plutôt que de relancer une review de plus (règle
« une review par commit, pas de boucle »).

| # | dette | pourquoi elle attend |
|---|---|---|
| 1 | **Un e-mail à DEUX adresses-jeton ne nourrit qu'un fil** | `items[0]` et `uuid[0]` : les destinataires suivants sont jetés avec un `200 {ok}`, donc sans rejeu possible. La seconde réservation n'aura jamais le message. Traiter la liste entière est une refonte de la boucle, pas une retouche |
| 2 | **Un `SpamScore ≥ 5` jette en silence** | la garde vient de devenir vivante : un faux positif (réponse relayée ou transférée, SPF-DKIM cassé) fait maintenant disparaître un vrai message. Mettre en file ne servirait à rien ici — le compte n'est pas encore résolu, la tâche serait invisible (voir ci-dessous). **Arbitrage produit à trancher par Thierry** : perdre un vrai message, ou laisser du courrier indésirable réveiller l'agent IA |
| 3 | **`evenement_introuvable` / `404` rejouent en boucle** | un évènement purgé par la rétention Brevo, ou un POST tiers portant un `Uuid` inventé (l'endpoint n'est pas authentifiable), produisent des 503 jusqu'à épuisement des tentatives de Brevo. Borné, mais bruyant |
| 4 | **Un `ref.sender` vide fait afficher l'adresse du payload** | conséquence de la tolérance symétrique : l'adresse montrée à l'hôte n'est plus corroborée sur ce chemin. Elle est informative — le rattachement, lui, vient toujours du `recipient` relu |

⚠️ **Une tâche sans `user_id` n'est visible de personne** : l'écran lit `agent_tasks` filtré
sur le compte courant, et la RLS ne laisserait rien passer non plus. La branche « corps vide »
se décide donc **après** la résolution de la réservation, pour que la tâche porte son compte
et son bien — « l'hôte voit qu'on lui a écrit » était sinon une phrase, pas une garantie.
Effet de bord réglé au passage : un corps vide ne masque plus le diagnostic `jeton_refuse`.
**Dette connue** : les mises en attente qui surviennent *avant* cette résolution
(`sans_adresse_de_reponse`, `jeton_refuse`, `reservation_ambigue`, `reservation_introuvable`)
restent sans `user_id` — là c'est structurel, le compte n'est pas encore connu.

### La réponse de l'IA emprunte le routage commun (dette 3, soldée le 18 septembre 2026)

`lib/cron-classify.js` appelait `channex.sendMessage` **lui-même**, sans lire le retour, puis
écrivait dans `messages` inconditionnellement. Sur une réservation `Offline`, Channex rend
`HTTP 422 not_supported` : le voyageur ne recevait rien, et le cœur affirmait le contraire.

C'était sans objet tant qu'aucune Offline n'avait de fil. **L'inbound e-mail vient d'en
créer un** : la dette devenait une panne, d'où sa fermeture dans ce chantier.

Ce qui change :

- l'envoi passe par **`sendGuestMessage`**, avec le **booking** et non l'identifiant nu —
  sans lui, le routage ne peut se faire que par provider, c'est-à-dire comme avant ;
- les deux chemins le fournissent : Channex depuis le snapshot du cœur (`source`,
  `guestEmail`), Beds24 depuis le booking brut de l'API (`channel` / `apiSource`) ;
- **le retour est lu.** Un échec ne produit ni fil ni ligne dans `messages` — rien ne doit
  affirmer qu'une réponse est partie quand elle ne l'est pas — et il remonte en erreur de
  cycle *et* en incident `send_failure` : « le voyageur attend toujours » ;
- `messages.canal` porte le chemin réellement emprunté.

Le **kill switch** et le **Mode Test** restent en amont de l'envoi : les déplacer sous le
routage les rendrait contournables par le canal e-mail. Un test le vérifie par la position
dans le fichier.

⚠️ Ce module parle encore au provider pour **lire** (`syncMessages`, `syncBookings`,
`getPropertyMessages`), et c'est sain. Le test `tests/reponse-ia-routee.test.js` en tient la
liste exhaustive et échoue si elle change — y compris pour un appel qui ne serait pas un
envoi : on veut le voir passer et le qualifier, pas le découvrir en production.

## Kill switch (pause par bien) — détail dans `alertes.md`
Bouton **Couper l'IA / Réactiver** sur `/biens` (miroir dans la config GuestFlow). Coupé = plus de
réponses auto **et plus de codes d'accès créés** (ni création serrure, ni envoi) ; la **réception**
des messages et la **synchro** continuent ; le code déjà posé reste valable. Une **pause
automatique** (coupe-circuit) peut aussi se déclencher si une conversation boucle. Tout le détail
(canaux d'alerte, coupe-circuit, réactivation) est dans **`alertes.md`**.

## Messagerie unifiée
Tous les messages (Airbnb, Booking, direct) dans une interface unique, filtrable par bien, avec les
réponses de l'IA.

## Réponses type support
- « L'IA a dit un truc faux » → compléter/corriger la base de connaissances (Agent IA → base de
  connaissances) ; en cas de doute, passer le bien en **mode validation**.
- « Faire taire l'IA sur un bien » → **kill switch** (pause).
- « Ma réservation directe n'a pas reçu les messages auto » → **ça dépend d'où elle vient**,
  depuis le 16 septembre 2026. Une réservation **Offline** (vendue par notre moteur ou saisie
  dans le calendrier) part désormais par **e-mail** si le cœur porte l'adresse du voyageur ;
  sans adresse, rien n'est tenté et la fiche le dit. Une saisie directe **Beds24** n'a
  toujours pas de canal : aucun message n'est tenté. Voir « Par où sort un message » plus haut.

## ⚠️ À VÉRIFIER
- Emplacement exact du bascule mode auto ↔ validation dans la config agent. (Kill switch : sur
  `/biens` + miroir config — confirmé.)

## Fix août 2026 — garde anti-reclassification (conso tokens)
Garde temporelle commune Beds24+Channex (hasNewerTaskOrConv) : toute tâche ou conversation **avec réponse** créée après le dernier message guest fait skipper le thread AVANT l'appel IA. Le chemin Channex n'avait aucune garde basée sur les tâches (~3500 classifications/jour inutiles). Skip également si le dernier message du thread est du host.

**Correctif du 20 septembre 2026 — l'écho n'est pas une réponse.** Les webhooks entrants
(`api/channel-webhook.js`, `api/inbound-email.js`) écrivent une ligne `conversations` sans
`agent_reply` à la réception de chaque message du voyageur, datée de la réception, donc
toujours après l'instant du message. Lue sans filtre, la garde prenait cet écho pour un
traitement : depuis sa pose le 20 août, **aucun fil Channex n'a jamais atteint l'IA** (0 réponse
IA sur Channex en 45 jours ; 56 fils sur 58 portaient l'écho sur 7 jours). Symptôme déclencheur :
« je peux venir avec mon chien ? » reçu par e-mail sur une Offline du 23, base à jour, mode auto,
ni réponse ni tâche ni log. La garde filtre désormais `agent_reply IS NOT NULL` sur
`conversations`. Le chemin Beds24 n'était pas touché (aucun écho : il lit l'API Beds24).

Deux décisions de Thierry attachées au correctif :
- **Reprise bornée** : `REPRISE_DEPUIS` (`lib/cron-classify.js`) ferme le passé — aucun
  message antérieur à l'instant du push n'est classifié, donc aucune réponse IA tardive sur un
  séjour terminé (le déploiement suit le push de une à deux minutes ; un message reçu dans cet
  intervalle est classifié en Mode Test, donc proposé, jamais envoyé). Les fils réels encore
  ouverts à cette date ont été traités à la main. La constante devient du code mort après le
  21 octobre 2026 (fenêtre de lecture de 30 jours) : à retirer alors.
- La garde ne compte plus que les tâches de la **classification** (`TYPES_CLASSIFICATION`) : une
  tâche `auto_message` déposée par un modèle ou un code d'accès dans le même cycle faisait taire
  le fil de la même façon (constat de review). Et le pré-scan « dernière réponse par booking »,
  qui lisait `conversations` sans `user_id`, a disparu : la réponse d'un autre compte sur la même
  clé provider pouvait faire taire ce fil-ci.

**Dette (altitude, constat de review du 20 septembre 2026).** La cause racine est que les deux
webhooks entrants écrivent l'écho du voyageur dans `conversations`, une table dont tous les
autres writers signifient « nous avons répondu ». Le correctif protège un lecteur ; tout autre
lecteur de `conversations` (messagerie, analyse, KPI) peut refaire la même erreur. Le vrai
correctif : ne plus écrire l'écho et dédupliquer sur `messages`, comme `api/inbound-email.js` le
fait déjà — `api/channel-webhook.js` déduplique encore sur l'écho, et l'écran messagerie le lit.
À traiter dans un chantier propre, pas dans ce correctif.
- **Mode Test 24-48 h** sur les quatre biens Channex (Colomiers, Ofuro Futari, Le 23, La bulle) :
  l'agent n'a jamais parlé sur un fil OTA Channex, ses premières propositions se lisent avant de
  le laisser répondre seul. Retour en auto par Thierry lui-même.

Test : `tests/garde-echo-conversation.test.js`.

## Messagerie — ordre de la liste et téléphone (23 septembre 2026)
Demande de Thierry : le jour de l'arrivée, le fil du voyageur était noyé sous les
conversations plus bavardes. `apps/agent-ai/messagerie.html` trie désormais : épinglées,
puis **arrivées du jour** (fond vert pâle, badge « Arrive aujourd'hui », intercalaire
« Arrivées du jour »), puis **arrivées de demain** (badge « Arrive demain »), puis le reste en
chronologique. Un séjour annulé, démappé, en simple demande ou bloqué ne compte pas comme une
arrivée, ni une conversation sans statut connu (« tâche seule »). Le jour est celui de **Paris**
(`Intl.DateTimeFormat` avec `timeZone: 'Europe/Paris'`, comme l'app ménage), calculé une fois au
chargement et posé sur chaque conversation ; passé minuit, c'est le rechargement qui remet l'ordre.
Le fond vert pâle distingue les arrivées du jour, la bordure gauche reste au code couleur des tâches.
La carte dit qui (voyageur, plateforme), où (le bien, ligne 🏠), quand (dates), et quoi faire s'il y a une
tâche ; l'extrait du dernier message a disparu (demande de Thierry). L'en-tête du fil porte aussi le bien.

Sur les arrivées du jour et du lendemain, deux marques. **🧹 Ménage** : `etatMenage` (lib/cron-arrival-code)
rend le motif de la règle du cron — `fait`, `a_faire`, `premier_sejour`, `sans_suivi`, `inconnu` — et
`isMenageValidated` n'en est plus que la lecture booléenne (rien ne bloque = fait, premier séjour ou sans
suivi ; inconnu bloque, comme avant). L'écran n'affiche que **« Ménage fait »** et **« Code transmis »** :
rien pour « à faire », « premier séjour », « non suivi » ou « pas de code » — un hôte qui n'utilise ni le
ménage ni les codes ne voit aucune pastille, et l'absence se lit « pas encore » (Thierry, 23 septembre). **🔑 Code transmis / créé, pas
envoyé / pas de code** : « transmis » se prouve par un message sortant, postérieur à la création du code,
qui contient le code entier (borné par des non-chiffres) ; ni `access_codes.status` ni `message_sent_log`
ne le disent, tous deux écrits aussi en Mode Test. Lecture d'`access_codes` sans les lignes `deleted`, la
plus récente d'abord, sur la clé composite bien + réservation (un identifiant Beds24 n'est unique que par bien).

Téléphone : `/api/messages` renvoie `guestPhone` (le `snapshot.guestPhone`, Channex comme
Beds24), les conversations « tâche seule » prennent `agent_tasks.guest_phone`. Lien `tel:` dans
l'en-tête du fil (bouton portant le numéro) et, dans la liste, pour les seules arrivées du jour et du
lendemain. Si le champ porte deux numéros, on compose le premier ; le champ s'affiche tel quel.

## Incident du 8 octobre 2026 — l'agent reclassait 4 fils à chaque cycle

**Constat.** Alerte « 42 lignes dans `automation_incidents` en 1 h » et crédit
Anthropic épuisé vers 4 h UTC. Quatre fils (Ofuro Futari ×3, en pause
volontaire ; Cœur de vie l 23 ×1) passaient toutes les gardes et repartaient à
l'IA à chaque cycle de 5 minutes : environ 48 appels par heure sur
`GUESTFLOW_MODEL` (Sonnet 5.5), jusqu'à épuiser le crédit ; puis un incident
`api_credit` par appel en échec, chaque échec rejoué au cycle suivant (264 en
une journée). Aucun envoi en double aux voyageurs. Sans lien avec le
déploiement avis (915f741, poussé après le début de la boucle).

**Cause.** `hasNewerTaskOrConv` ne ferme un fil que sur une tâche de
classification ou une réponse écrite après le dernier message du voyageur.
Quatre chemins appelaient l'IA puis n'écrivaient RIEN : bien en pause (réponse
gelée), réponse automatique vide, proposition du même type déjà en attente,
envoi en échec en Mode Auto.

**Arrêt (go de Thierry, 8 octobre 2026, 20:51 UTC).** Quatre tâches `ignored`
« Arrêt de boucle » sur les quatre fils ; deux cycles réels observés ensuite :
0 fil traité (contre 3), aucun incident.

**Correctif.**
- Une **trace** (tâche `ignored` du type classé) après chacun de ces chemins :
  un fil n'est jamais reclassé sans nouveau message du voyageur. Sur un bien en
  pause, une intervention ou une question inconnue crée toujours sa tâche.
- `lib/guestflow-garde.js` : **au plus 3 appels IA par fil sur 24 h** (incident
  `guestflow_plafond`, un par fil et par jour) et **délai croissant après un
  échec** (5, 10, 20, 40 min… plafonné à 6 h). Journal `guestflow_appels_ia`
  (migration `2026-10-08-guestflow-appels-ia.sql`) : une ligne par appel, avec
  le modèle réellement utilisé — ce que le cron ne journalisait pas. Sans la
  migration, l'agent tourne sans plafond et le dit (`guestflow_journal_absent`).
- **Un seul incident `api_credit` par service et par heure**
  (`lib/incident-facturation.js`).
- `totalAutoReplies` ne compte plus que les réponses réellement envoyées (il
  annonçait « 3 réponses » par cycle sans qu'aucune ne parte).

### « Bonjour {prenom} » parti à deux voyageurs (même jour)
Modèle « arrivée », réservations 814bf119 (11:00) et 12bbf074 (18:00). Cause :
`generateAutoMessage` (lib/cron-messages.js) améliore le texte par Haiku ; en
échec (crédit épuisé), son repli rendait le **modèle brut**, avant substitution
— toute variable pouvait partir ainsi. Désormais : le repli est le texte
substitué ; sans prénom, la formule est neutre (« Bonjour, »), jamais
« Voyageur » ; une variable `{…}` restée dans le modèle retient le message et
prévient l'hôte (`message_non_envoye`) ; une variable réintroduite par l'IA
fait renvoyer le texte substitué ; une erreur inattendue n'envoie rien.

### Reviews de ecce019 et fbd316e (aucun constat de sécurité)
Corrigé :
- **B1** — un envoi en échec en Mode Auto devient une **proposition visible**
  (`pending_validation`, la réponse à renvoyer d'un clic) et l'incident
  `send_failure` part dès le 1er échec ; avant, la boucle le rejouait.
- **B2** — au plafond, le message ne disparaît pas : une **tâche visible**
  (« L'agent IA s'est arrêté sur ce fil… ») et l'hôte alerté ; un nouveau
  message met à jour cette tâche. Le plafond ne compte que les appels
  **réussis** (une coupure de crédit ne bloque plus les fils 24 h).
- **B3** — le garde-fou passe avant l'écartement des propositions périmées.
- Les traces sont **datées du dernier message du lot** (un message écrit pendant
  l'appel IA rouvre le fil).
- Messages automatiques : la garde des variables passe **avant** l'appel IA ;
  motif « variable inconnue, à corriger dans GuestFlow → Messages » ; détection
  des variables accentuées ou chiffrées ; une erreur imprévue prévient l'hôte ;
  le prénom neutre vaut aussi pour les **codes d'accès** (`lib/message-builder.js`,
  plus de « Bonjour Voyageur »).

**À décider par Thierry / dettes notées :**
- **Bien en pause — tranché par Thierry le 9 octobre 2026** : pas de réponse
  automatique tardive à la reprise ; un message reçu pendant la pause devient
  une tâche VISIBLE « Reçu pendant la pause… » (une par lot, mise à jour par un
  nouveau message, la réponse que l'agent aurait envoyée jointe en note, jamais
  envoyée). Les interventions et questions inconnues créent leur tâche comme
  d'habitude. `GUESTFLOW_MODEL` reste sur Sonnet 5.5 ; Thierry pose une limite
  de dépense sur la console Anthropic.
- `prevenirManque` / `prevenirVariableInconnue` écrivent une ligne d'incident
  par cycle tant que le message est retenu (l'alerte, elle, a son anti-spam).
- Les traces `ignored` occupent la fenêtre de 200 tâches lue par la messagerie.
- `lib/message-builder.js` (codes d'accès) n'a pas de garde finale `{…}` ;
  `[CODE À INSÉRER]` / `[WIFI …]` partent encore sur le chemin des modèles
  quand la base de connaissance ne les porte pas (antérieur).
- Review de ad4a21b (aucun constat de sécurité) : la tâche « reçu pendant la
  pause » à reprendre est cherchée **dans le lot en cours** (bornée par la
  dernière réponse de l'hôte) — une tâche d'un lot déjà répondu n'est jamais
  réécrite, sinon le lot ne se fermait plus ; la note suit le lot ; type
  `info_unknown` (affichée comme information, pas « Intervention requise »).
  **Tranché par Thierry le 9 octobre 2026** : à la reprise, l'agent répond
  aux messages reçus en pause et aux nouveaux ensemble ; la tâche « reçu
  pendant la pause » se **ferme d'elle-même** (`done`, comme « Traité ») dès
  qu'une réponse part — de l'agent (aussitôt) ou de l'hôte, depuis la
  messagerie ou l'app OTA (au cycle suivant, avant les gardes qui sortiraient
  sans voir la réponse).
- Review de ef61bc0 (aucun constat de sécurité, aucun bloquant). **Dettes** :
  sur Beds24, un modèle (J-1, code) relu en `host` faute de rapprochement avec
  le cœur (`nosEnvoisBeds24` illisible, ou texte différent après normalisation)
  fermerait la tâche « reçu pendant la pause » sans réponse réelle ; un message
  sorti de la fenêtre de lecture (30 jours Channex, 100 messages Beds24) laisse
  sa tâche ouverte. **À la reprise sans nouveau message**, l'agent ne répond pas
  aux messages reçus en pause : il le fera au prochain message du voyageur, et
  la tâche reste ouverte d'ici là (ou jusqu'à la réponse de l'hôte).

## Délai de réponse IA — le socle (lot 1, 27 octobre 2026)

Spec complète : `docs/specs/spec-delai-reponse-ia.md`. Ce lot **ne change aucun
comportement** : il pose le schéma, le writer de réglages et la dérivation du
mode. Le différé lui-même arrive au lot 2.

**Ce que le chantier remplace.** L'interrupteur binaire Mode Test / Mode Auto
(`agent_alert_config.config[<ref>].mode`) devient le cas limite d'un délai :
`0` = immédiat (l'ancien Auto), `null` = validation manuelle (l'ancien Test),
`N` minutes = le brouillon attend N minutes puis part de lui-même. Le gain
n'est pas le réglage, c'est le **parachute** : aujourd'hui, en Mode Test, un
hôte qui oublie une proposition laisse le voyageur sans réponse indéfiniment.

**Où vivent les réglages** — dans le blob d'app, pas dans `/settings` (test qui
tranche : ce réglage n'a pas de sens si l'app n'existe pas) :

```
agent_alert_config.config[<ref>].delais = {
  reponse_ia:  null | <minutes 0..1440>,   // null = validation manuelle
  alerte_info: <minutes 0..1440>,
  sourdine:    { active: false, debut: '22:00', fin: '08:00' }
}
```

**Quatre colonnes sur `agent_tasks`**, toutes nullables, toutes nulles au lot 1
(`migrations/2026-10-27-delai-reponse-ia.sql`) : `send_after` (échéance du
brouillon), `alert_after` (échéance de l'alerte info manquante), `suspendu_le`
(l'hôte a ouvert le brouillon), `modifie_le` (l'hôte a écrit dedans — la
reprise doit l'alerter). **`NULL` est le repli SÛR** : pas d'échéance = rien ne
part tout seul. Un défaut non nul aurait armé un envoi automatique sur **tout
l'historique des tâches**, sans que personne l'ait examiné.

⚠ Une première version de ces trois en-têtes chiffrait cet historique à
« 1436 lignes ». **1436 est la mesure de `bookings_snapshot`** (backfill
214 → 1436, CLAUDE.md), pas d'`agent_tasks`, que rien dans ce lot n'a mesurée —
constat de la revue du 27 octobre 2026. Un nombre écrit à la main se lit comme
une mesure et ne rougit jamais : le vérificateur imprime le vrai compte en
tête, et c'est lui qui fait foi.

Deux index **partiels** (`status` + échéance non nulle) : la règle des 30 000
comptes. Le cron lit les tâches **échues**, jamais les tâches — sans eux la
passe dégénère en scan toutes les 5 minutes. ⚠ Le vérificateur
(`scripts/verifier-migration-delai-ia.js`) **ne peut pas les prouver** :
PostgREST n'expose pas le catalogue (même limite que la grille, dette 32). Il
prouve que le filtre RÉPOND, pas qu'il est INDEXÉ. La relecture du fichier de
migration couvre les index, et rien d'autre.

**`getPropertyMode` garde sa signature, et DÉRIVE** (`lib/cron-shared.js`) :
`reponse_ia === null` → `'test'`, sinon → `'auto'`. Trois des quatre appelants
ne changent pas d'une ligne — les modèles programmés (`cron-messages` ×2) et le
code d'accès (`cron-arrival-code`) restent binaires. **Un délai de réponse IA
ne retarde pas un modèle programmé** : les messages d'arrivée et les codes
partent à leur heure. Le repli sur `mode` reste jusqu'au lot 4.

Nouvelle fonction `lireReglagesDuBien(userId, propertyId)` → `{ mode, delais }` :
**une seule lecture pour les deux usages**, parce que ce chemin fait déjà une
requête de trop (une par bien et par passe, alors que le blob est unique par
compte — dette inoffensive à quatre biens, condamnée à 30 000).

### ⚠ Deux surprises de l'état des lieux, à ne pas réapprendre

1. **`info_unknown` et `intervention` ne lisaient PAS le mode du tout.**
   L'alerte partait dans le tour, Mode Test ou Auto. Le réglage
   `alerte_info` ne retarde donc pas un chemin déjà réglable : il crée le
   premier réglage de ce chemin. Conséquence sur la migration : `alerte_info = 0`
   **partout**, pour ne rien changer ; 15 min est le défaut des biens NEUFS
   seulement.
2. **La course cron/clic n'était pas fermée.** `cloreProposition`
   (`api/messages.js`) a un claim atomique, mais l'écran **envoie d'abord et
   claime ensuite**. Inoffensif tant que seul un humain envoie ; dès qu'un cron
   peut envoyer la même tâche, c'est le double envoi. Le lot 2 **inverse
   l'ordre** et ajoute un statut `sending`.

### Le POST legacy de `/api/agent-config` merge, il n'écrase plus

Il reste ouvert parce qu'un appelant réel l'utilise : `seedAlertConfig`
(`pages/onboarding.html`), qui fait GET du blob, merge côté client, POST du
tout. Entre son GET et son POST, une autre session peut écrire — et le POST
passait par-dessus. Le serveur **relit et merge bien par bien** :
une clé absente de la charge est préservée, jamais effacée. Conséquence voulue :
ce chemin ne peut plus **supprimer** une entrée, et c'est ce qui le rend sûr.

### Le plafond d'appels IA précède tout ce que ce chantier pose

`lib/guestflow-garde.js` : `PLAFOND_JOUR = 3` appels IA **réussis** par fil sur
24 h glissantes, plus le délai croissant après échec (5, 10, 20, 40 min…
plafonné à 6 h). **Une revalidation de brouillon consomme un de ces 3 appels.**
D'où la règle gravée du lot 2 : à l'échéance, **plafond atteint → aucun appel,
le brouillon part tel quel**. Le texte est déjà écrit, l'envoyer ne coûte rien ;
la revalidation est un bonus qui s'efface devant la garde, jamais une condition
de l'envoi.

### Le modèle n'est pas un levier de coût

`GUESTFLOW_MODEL` est sur **Sonnet 5.5** depuis le 2 octobre 2026, et c'est un
choix de Thierry maintenu le 27 : **Haiku annonçait des codes d'accès non
envoyés**. Haiku 5.5 coûterait dix fois moins que le défaut du code
(`claude-haiku-4-5`), mais la raison du passage à Sonnet est la qualité sur un
chemin qui parle au voyageur. Chiffrage d'une revalidation, sur Sonnet :
**0,8 à 1,1 ct $** (2 500-4 000 tokens d'entrée, ~300 de sortie — estimation
par taille de chaînes, **pas** une mesure `count_tokens`).

### Dettes relevées pendant l'état des lieux, hors périmètre

- `lib/alert-notify.js` — `PROPERTY_NAMES` code en dur `169567` et `209413` :
  tout autre bien s'annonce « Logement <id> » dans le SMS et dans l'objet de
  l'e-mail. Un hôte qui reçoit l'alerte d'un troisième bien lit un numéro.
- `lib/cron-shared.js` — `parseDelay` n'a aucun appelant de production, mais il
  est exporté et stubé par `tests/garde-portee-au-point-d-usage.test.js` : le
  retirer casse ce test. Vestige d'un délai antérieur, à ne pas réutiliser —
  son unité (minutes depuis des libellés `'5min'…'24h'`) n'est pas celle de ce
  chantier.

### Les constats de la revue du lot 1 (27 octobre 2026) — 11, dont deux graves

**1. ⚠ `delais` gouverne, mais deux lecteurs lisaient encore `mode`.**
`getPropertyMode` fait gagner `delais` quand il existe ; or `modesDe`
(`pages/messages.html`, l'interrupteur Test/Auto — qui **relit après écriture**
et confirmait donc une valeur qui ne gouverne plus) et la garde de
`scripts/templates-test-colomiers.js` lisent `mode`. Scénario : après la
migration des données, l'hôte bascule un bien en Test, le POST écrit
`mode:'test'`, **l'écran affiche Test, et GuestFlow continue d'envoyer tout
seul** ; le script, lui, imprime « mode : test — jamais un envoi » puis arme un
message sur un séjour en cours. Un interrupteur qui ment est pire qu'un
interrupteur absent.
**Correctif** : tant que la clé `mode` existe (elle part au lot 4), **chaque
écriture pose les deux, dans les deux sens** — cible `delais` → `mode` dérivé ;
cible `mode` → `delais.reponse_ia` aligné (`test` = `null`, `auto` = `0`).
`auto` vaut **0 et pas 15** : c'est le sens exact du Mode Auto d'avant, et un
toggle ne doit pas inventer un délai. Éprouvé par cinq tests d'appel.

**2. ⚠ Un `delais` non validé rendait `'auto'`** — le sens NON sûr. Toute forme
avec `reponse_ia` non nul (`"15"`, `15.5`, `99999`, `{}`, `true`) donnait « ça
part tout seul », et débloquait aussi les modèles programmés et le code
d'accès. **Le POST legacy n'appelle pas `delaisPropres`**, et c'est précisément
le writer des défauts des biens neufs : une forme fautive peut donc arriver en
lecture sans avoir croisé un validateur.
**Correctif** : la validation est **au point de lecture** — `null` → `test`,
entier 0..1440 → `auto`, **tout le reste → repli sur `mode`, et on le dit**.
Le repli est `mode` et non `'test'` inconditionnel : une donnée malformée ne
doit pas *retenir* les messages d'un bien que l'hôte a mis en Auto.

**3. Le merge legacy ne ferme pas tout, et le commentaire affirmait le
contraire.** Il est à **un niveau** : il protège les clés **absentes** de la
charge. Or `seedAlertConfig` n'omet rien — il **repose le blob entier** qu'il a
lu. Chaque clé qu'il réémet (`mode`, `intervention`, `info_unknown`) écrase donc
toujours ce qu'une cible concurrente a écrit entre son GET et son POST.
**Ce qui est fermé** : la disparition d'une clé qu'il ne connaît pas.
**Ce qui reste ouvert** : la péremption d'une clé qu'il connaît.
**Correctif partiel, sur ce qui compte** : `delais` est **réservée aux cibles**
et écartée de toute charge legacy — la valeur en base gagne toujours. Un
réglage d'envoi ne se change que par sa cible.
⚠ **DETTE** : le seeder d'onboarding devrait passer par des cibles (une requête
par bien). Tant qu'il reposte le blob, les alertes restent exposées à cette
course.

**4. Omettre `sourdine` la réinitialisait en silence.** Le bloc `delais` est
remplacé en entier, donc une charge sans `sourdine` y substituait le défaut
inactif : l'hôte qui enregistrait ses deux délais **perdait sa plage de nuit**,
en 200 et sans un mot. Correctif : sourdine absente de la charge → celle de la
base est gardée.

**5. Le legacy jetait les entrées invalides en silence avec un 200
`{ok:true}`** (elles étaient persistées avant ce lot). Correctif : **400**, et
la réponse **nomme** ce qui a été refusé.

**6. Le vérificateur comptait « aucune ligne » comme « RLS fermée ».** Sur une
table vide, la clé anon rend zéro ligne quelle que soit la policy : la sonde
affichait ✔ sur une table potentiellement grande ouverte. Correctif : si le
comptage service-key vaut 0, **la sonde s'abstient et le dit**. Un vérificateur
qui n'a rien lu ne doit pas rassurer.

**7. « 1436 lignes d'historique » était un chiffre emprunté.** Voir plus haut.

**8, 9.** Spec : titre « trois colonnes et un index » pour quatre et deux ; et
le critère de remise fixé à « 28 rouges » alors que la suite est à `fail 0`.

**10.** `package-lock.json` : `"name"` changé par npm dans le worktree, sans
rapport avec le chantier — **non commité**.

**11. Deux tests existants grepaient une expression source exacte**, et l'un
des deux était *ma propre correction* du premier. `tests/messages-v5.test.js`
vérifiait la règle « une cible par requête » par la chaîne
`viseMode && viseAlertes`, et le merge du mode par
`? { ...(blob[ref] || {}), mode }` : les deux ont rougi sur du code **plus
correct** que celui qu'ils protégeaient. Correctif : ces tests ne lisent plus le
source de l'endpoint ; ils gardent les invariants stables (l'écriture est
ciblée, le serveur relit avant d'écrire) et **la règle est éprouvée par appel**
dans `tests/delai-reponse-ia-lot1.test.js`. Leçon, déjà au REVIEW.md : un test
qui fige une expression protège une formulation, pas un comportement.

### Les constats de la SECONDE revue (27 octobre 2026) — 9, aucun de sécurité

Appliquée la règle de CLAUDE.md : deux reviews sans constat de sécurité = on
corrige sans nouvelle review, puis on pousse.

- **`delais` écarté d'une charge legacy en silence** — dans la fonction même qui
  pose « un rejet se dit » : `delete` + `200 {ok:true}`. Désormais **400 nommé**.
- **Mon commentaire justifiait la garde de lecture par un chemin inexistant.**
  Il affirmait que le POST legacy « n'appelle pas `delaisPropres` » et qu'il est
  « le writer des défauts 15/15 des biens neufs » : les deux sont démentis par
  le code du même lot (`CLES_RESERVEES_AUX_CIBLES` écarte `delais` du legacy, et
  `seedAlertConfig` n'écrit ni `delais` ni 15/15). **Le motif réel, et il
  suffit** : cette fonction est le passage de tous les lecteurs, et le blob est
  un JSONB qu'aucune contrainte de base ne borne — un script, une migration ou
  une correction en console peuvent y poser n'importe quelle forme. Une garde à
  la lecture ne dépend d'aucun inventaire des écrivains, et c'est ce qui la rend
  vraie quand l'inventaire change.
- **`delaisAlignes` étalait `blob[ref].delais` sans vérifier sa forme** :
  `{...[]}` donnait `{reponse_ia: 0}` — plus d'`alerte_info`, plus de
  `sourdine`. Le serveur écrivait lui-même un bloc que son validateur
  refuserait, et le lot 2 aurait lu « pas d'échéance d'alerte » sans le voir.
- **⚠ Basculer Test puis Auto détruisait le délai réglé par l'hôte**, en 200 et
  sans un mot : 30 min → `0`, envoi immédiat. La dernière valeur non nulle est
  mémorisée (`reponse_ia_rappel`) et restituée.
- **Le 400 du legacy pouvait casser l'onboarding définitivement** : comme
  `seedAlertConfig` réémet le blob qu'il a lu, une entrée fautive déjà stockée
  aurait fait échouer **tout** POST legacy futur — et l'onboarding ne teste pas
  `r.ok`. On refuse donc ce que l'appelant **apporte**, pas ce qu'il recopie.
- **La borne 0..1440 était recopiée** au point de lecture. Nouveau module
  `lib/guestflow/delais-contrat.js` : une dérive aurait rendu « hors contrat » à
  la lecture une valeur acceptée et stockée à l'écriture — un réglage qui cesse
  de gouverner sans que rien ne rougisse.
- **Le vérificateur aurait crié au loup dès le lot 2** : son contrôle « aucune
  colonne armée » devient faux quand `cron-classify` pose légitimement
  `send_after`. Informatif par défaut, strict sur `AUCUN_ARMEMENT_ATTENDU=1`.
- **`.is('suspendu_le', null)` était appliqué aussi à la requête des alertes** :
  une suspension de brouillon aurait masqué l'alerte `info_unknown` du même
  séjour. Et l'en-tête annonçait « la requête du cron rejouée telle quelle »
  alors que `lib/guestflow/brouillons-dus.js` n'existe pas — « attendue du
  lot 2 » est le mot juste.
- **⚠ Et pour la troisième fois, un test de `messages-v5` grepait le source —
  mes deux corrections comprises.** La deuxième assertait « le serveur RELIT le
  blob avant d'écrire » par un motif que le handler **GET** satisfait : la revue
  a supprimé les deux relectures du POST et la regex matchait toujours. **Un
  test qui reste vert quand la garde disparaît est pire qu'absent : il occupe la
  place.** Ce test ne lit plus le source de l'endpoint du tout ; ce qui relève
  de l'endpoint est éprouvé par appel. Leçon : trois corrections fausses d'affilée
  sur le même grep signifient qu'il faut arrêter de greper, pas chercher un
  meilleur motif.

## Délai de réponse IA — le lot 2 : le différé existe (27 octobre 2026)

Spec : `docs/specs/spec-delai-reponse-ia.md`. Le lot 1 posait le socle ; celui-ci
fait partir les brouillons.

### Le chemin complet d'un brouillon différé

1. **`lib/cron-classify.js`** classe le message. Trois cas, dont **deux sont les
   comportements d'avant, octet pour octet** : `reponse_ia = null` → tâche sans
   échéance (l'ancien Mode Test) ; `= 0` → envoi dans le tour (l'ancien Mode
   Auto) ; `= N` → tâche avec `send_after = maintenant + N`.
   ⚠ **Un délai différé emprunte la branche « tâche », pas la branche « envoi ».**
   Mon premier jet écrivait `delai.manuel ? 'test' : 'auto'` : un délai de
   15 minutes rendait donc `'auto'` et **le message partait tout de suite**,
   l'échéance n'étant jamais atteinte puisqu'aucune tâche n'était posée. Ce sont
   ses propres tests qui l'ont trouvé.
2. **`lib/guestflow/brouillons-dus.js`** (passe `brouillons_dus` du cron) lit les
   tâches **échues** par deux index partiels, **claime** (statut `sending`),
   revérifie tout, envoie, écrit le statut.
3. **`api/messages.js`** porte les gestes de l'hôte : `reserver` (le claim),
   `relacher`, `brouillon` (son texte), `reprendre`, et `proposition` (la
   clôture, qui **désarme** `send_after`).

### ⚠ L'ordre claim/envoi est inversé, côté écran comme côté cron

`envoyerProposition` relisait le statut **puis** envoyait. Une atténuation, pas
un verrou : elle suffisait tant que **seul un humain** envoyait. Depuis que le
cron peut envoyer la même proposition à son échéance, la fenêtre entre la
relecture et l'envoi produit le **double message au voyageur**. L'écran passe
donc par `reserver` — un UPDATE conditionnel qui **dit** si quelqu'un d'autre a
pris la tâche. Un 409 n'est pas une erreur à réessayer : c'est « cette réponse
vient de partir », et rien ne part.

Et **une réservation se relâche** : sans ça, un envoi raté laisserait la tâche
en `sending` jusqu'à la reprise des orphelines, soit dix minutes d'attente.

### La suspension, et pourquoi elle reprend

Ouvrir un brouillon pose `suspendu_le` : le cron ne l'enverra pas. L'écrire pose
`modifie_le` **en plus** — et la distinction compte : ouvrir, lire et refermer
n'est pas modifier, sinon un simple coup d'œil déclencherait l'alerte de reprise
et la sourdine de nuit.

⚠ **La suspension REPREND**, décision de Thierry contre ma spec : j'avais écrit
qu'elle serait définitive, et son argument tranche — *il suffirait d'ouvrir un
brouillon pour que l'oubli redevienne possible*, exactement ce que le différé
existe pour empêcher. Deux chemins : l'hôte clique « Envoyer dans X min », ou
le cron reprend après **30 minutes sans modification** (`updated_at` mesure
l'inactivité, pas l'ancienneté).

⚠ **L'échéance repart avec le temps QUI RESTAIT, 5 minutes au minimum**, et ce
temps se **calcule** : `send_after - suspendu_le`. Sans ce recalcul, deux
défauts opposés — laisser `send_after` tel quel ferait partir sous les doigts un
brouillon ouvert vingt minutes ; repartir du délai plein laisserait l'hôte
repousser l'envoi de quinze minutes à chaque coup d'œil.
**Dette** : cette règle est écrite **deux fois** (`api/messages.js` et
`lib/guestflow/brouillons-dus.js`). Le jour où le plancher change, il change aux
deux endroits.

### Le budget mur, parce que cette passe ENVOIE

Plafond de 30 brouillons par cycle **et** budget de 20 s. Sans le budget, trente
envois lents mangeaient les 60 s de `maxDuration` et **affamaient le dispatch
des changements de réservation**, qui tourne après et qui est déjà le poste le
plus coûteux. On ne **commence** pas un envoi sous le seuil ; **un envoi déjà
commencé n'est jamais coupé** — entre le claim et l'écriture du statut se trouve
le seul endroit où le voyageur peut recevoir un message sans que la tâche le
dise.

### ⚠ Une tâche `sending` abandonnée est rendue DÉSARMÉE

Mon premier jet la rendait armée : la passe la relisait comme échue **dans le
même cycle** et la renvoyait. Or une tâche restée `sending` est précisément
celle dont on **ne sait pas** si l'envoi est parti. La renvoyer automatiquement,
c'est choisir le double message plutôt que l'attente. Elle revient donc à l'hôte
avec le doute écrit dans son résumé, et lui seul tranche.

### L'écran : le volet « Réponse IA », et un seul « Enregistrer »

Les trois réglages prennent **la place exacte** de l'ancien bloc Test/Auto, en
haut du volet ; tout ce qui suivait reste dans son ordre (pause, consignes,
coupe-circuit, alertes). Aucun onglet ajouté. Le mobile n'est **pas** un autre
écran : `ui.css` donne au tiroir `width: min(360px, 100vw)`.

**Un seul bouton pour trois écritures** (demande de Thierry), et elles ne
peuvent pas voyager ensemble : délais et alertes sont deux **cibles** de
`/api/agent-config`, qui refuse par 400 une requête portant les deux ; les
consignes vivent dans `agent_prompting`. Donc trois requêtes séquentielles et un
**échec partiel nommé** — « Non enregistré : les alertes. » Un « erreur » global
ferait relancer les trois à l'aveugle, et re-poster des délais déjà enregistrés
n'est pas anodin : ils gouvernent les envois.

⚠ **La pause reste hors du bouton** : couper l'automatique est un geste
d'urgence. Un kill switch qui attend un « Enregistrer » n'est pas un kill switch.

### ⚠ Deux gardes que le remplacement de l'écran avait emportées

1. **La confirmation de Thierry**, demandée le 11 octobre : « passer en Auto est
   un geste lourd, tout ce que l'IA sait part sans validation ». Le toggle a
   disparu, **et la confirmation avec lui**. Le geste existe toujours : quitter
   « Je valide chaque réponse » autorise des envois sans relecture. Elle est donc
   sur ce bouton — seul chemin pour en sortir, les pilules n'étant pas rendues en
   mode manuel. **Un test existant l'a attrapée, pas moi.**
2. **Le repli des SMS sans clé Brevo.** Les champs SMS n'existent pas à l'écran
   sans Brevo ; mon `lireType` écrivait donc `sms_enabled: false`, et enregistrer
   le panneau aurait **désactivé les SMS d'alerte** d'un hôte sans Brevo, sans
   qu'il touche à ce réglage. Le repli sur la valeur enregistrée existait dans
   l'ancien chemin. **Attrapé par un test aussi.**

Leçon commune : un écran qu'on remplace emporte des gardes produit en silence.
Les tests d'écran de ce dépôt — y compris ceux qui grepent — sont ce qui les
rattrape.

### Le libellé qui ne s'accorde pas

« Non enregistré : {parties}. » remplace « {parties} n'ont pas été
enregistrés. » parce que **l'accord dépend de la variable** : « les alertes » et
« les consignes » sont féminins, « les délais » masculin. Accorder au féminin
aurait été juste deux fois sur trois. Une formulation invariable est juste dans
les trois cas, et le restera à la quatrième partie.

### La migration des données

`scripts/migrer-modes-vers-delais.js` — **à blanc par défaut**, `--go` pour
écrire, idempotent, refus sur une base non reconnue.
`mode:'auto'` → `reponse_ia: 0` ; `mode:'test'` → `null` ; **`alerte_info: 0`
partout**, et c'est une décision de Thierry contre mon premier réflexe : poser
15 minutes aurait changé le comportement de biens en production sous couvert de
migration, puisque l'alerte d'info manquante partait **déjà** dans le tour. Les
15 minutes sont le défaut des biens **neufs**.

### Divergence maquette / code, acceptée par Thierry

La maquette montrait un textarea **dans la bulle** pour l'état « vous
modifiez ». Le mécanisme existant **descend** le texte dans la zone de saisie et
filtre la bulle du fil. Décision : garder le mécanisme, et porter les trois
informations près de la saisie (`.msg-saisie__echeance`) — l'état, ce qui se
passera, l'abandon. L'étiquette du compte à rebours a **une seule source**
(`etiquetteEcheance`), parce que la bulle et le bandeau l'affichent tous les
deux.

### Les 15 constats de la revue du lot 2 — trois graves, et tous justes

**La leçon d'ensemble, avant le détail** : les trois constats graves disent la
même chose sous trois formes. J'ai écrit un **second chemin d'envoi** et je ne
lui ai pas donné ce que le premier avait appris en dix-huit mois de reviews.

**1. ⚠ GRAVE — l'envoi différé n'écrivait RIEN dans le cœur.** Le chemin
immédiat fait quatre écritures après un envoi réussi (`conversations`,
`recordMessage` dans `messages`, `fermerTachesPause`, le compteur) ;
`brouillons-dus.js` posait `status: 'done'` et s'arrêtait là. Le voyageur
recevait la réponse et **elle n'existait nulle part** : l'hôte voyait un fil
sans réponse, le journal était muet, et au message suivant `preparerLot` ne
voyait aucune réponse côté hôte — **l'IA pouvait répondre une seconde fois à la
même question.** C'est exactement ce que « provider → cœur → apps » interdit.
**Correctif** : les quatre écritures vivent dans `lib/guestflow/journal-envoi-ia.js`,
appelé par les **deux** chemins. Une seule copie, et `origine: 'ia_differee'`
distingue ce qui part à l'échéance — la seule trace qui dira, dans six mois,
combien de réponses le parachute a réellement envoyées.

**2. ⚠ GRAVE — l'envoi recevait l'identifiant nu, pas la réservation.**
`sendGuestMessage` pose alors `{ canal: OTA }` sans consulter `canalPour`.
L'avertissement est écrit dans le dépôt depuis des mois : « `booking` : l'objet
de la RÉSERVATION, pas seulement son identifiant. C'est lui qui porte `source`
et `guestEmail`, donc le CANAL de sortie. » Une réservation directe ou
`Offline` dont la réponse était différée partait vers la messagerie OTA → 422
`not_supported`, **la dette 3 rouverte pour tout le chemin différé**.
**Correctif** : `chargerLesReservations` lit `bookings_snapshot` groupé, et
l'objet traverse jusqu'à l'envoi.

**3. ⚠ GRAVE — le claim ne couvrait qu'un des deux chemins d'envoi.** Je
l'avais posé sur `envoyerProposition` (le bouton de la bulle) mais pas sur
« Modifier puis Envoyer », qui passe par `lancerEnvoi`. Sa seule protection
était `suspendu_le` — que la reprise automatique **efface** après 30 minutes
d'inactivité, et `updated_at` ne bouge qu'au `blur`, pas à la frappe. Scénario
entièrement réaliste : brouillon à 60 min, l'hôte ouvre et tape sans quitter le
champ ; à T+30 le cron reprend la suspension puis envoie ; l'hôte clique
« Envoyer » → **deuxième message au voyageur**. Un seul verrou, le même pour les
deux chemins.

**4. `sending` n'est cloturable que pour un ENVOI.** L'accepter pour un rejet
rouvrait la course : le cron claime, l'hôte clique « Ne pas envoyer », la tâche
passe à `ignored` — et le cron finit d'envoyer. **Et son UPDATE final n'avait
pas de `.select()`** : zéro ligne touchée, et `bilan.envoyes++` montait quand
même. Le voyageur avait reçu le message, l'hôte lisait « rejetée », rien ne le
disait. Désormais : rejet refusé sur `sending`, `.select()` vérifié, et un
incident au fondateur si le statut ne suit pas un envoi parti.

**5. Une panne de lecture AUTORISAIT l'envoi.** `reglages` vide → `d`
`undefined` → la garde « repassé en validation manuelle » **sautée**. Mon repli
était l'inverse du contrat : `lireReglagesDuBien` rend `{mode:'test'}` en cas de
panne, `delaiDeReponse` en déduit `manuel`. Tout le reste du chantier refuse
quand il ne sait pas. Même trou pour une entrée disparue du blob : `undefined`
n'est pas une permission.

**6. Un réglage sans lecteur mentait à l'hôte.** Le bloc « Info manquante : me
prévenir après » s'enregistrait, mais `sendAlertNotifications` part toujours
dans le tour : un hôte réglant « 4 h » recevait ses alertes immédiatement.
C'est l'« interrupteur qui mente » que ce chantier a déjà corrigé une fois.
**Retiré de l'écran jusqu'au lot 3** — la maquette validée le portait, mais le
livrer inerte est pire que le livrer une semaine plus tard. Le réglage, les clés
i18n et la règle de sourdine restent : le lot 3 n'aura que le branchement.

**7. Mon commentaire promettait une garde d'annulation qui n'existait pas.**
Rien d'autre ne purge `agent_tasks` à l'annulation : un voyageur qui annulait
pendant la fenêtre recevait la réponse (« à bientôt », un code d'accès…).
`estAnnulationVoyageur` est maintenant lu.

**13. ⚠ Une fuite entre comptes.** Mes `Map` étaient clées sur le seul
`provider_property_id`, et aucune lecture n'était filtrée par compte : dès que
deux comptes partagent une ref provider — bien en bascule, bien re-provisionné,
ref non UUID —, **le réglage et le `automation_paused` d'un autre compte
gouvernaient l'envoi**. Un bien en pause aurait pu envoyer. Clé `user_id|ref`
partout, et `.in('user_id', …)` sur les trois lectures. Le précédent du dépôt le
faisait déjà (`sync-menages-entite.js`) ; je ne l'avais pas suivi.
⚠ **Et j'avais corrigé `encoreLegitime` en oubliant le bloc de la sourdine** —
ce sont ses tests qui l'ont montré.

**8, 12, 14, 15** : la restitution du rappel ignorait la valeur courante (un
délai de 30 min détruit par un POST `mode`) ; la migration lisait sans
`.range()` (PostgREST tronque à 1000 **sans erreur**, et l'idempotence aurait
masqué le manque) ; `relacher` rendait la tâche **armée** alors que
`reprendreOrphelines` refuse délibérément de renvoyer dans le même doute ; la
suspension à l'ouverture était un appel non attendu dont l'échec ne faisait
qu'un `logger.error` — l'écran affichait « vous modifiez » alors qu'en base rien
n'était suspendu.

**9, 10, 11 — trois commentaires qui affirmaient faux.** L'en-tête disait « pas
encore branchée dans api/cron.js » alors qu'elle l'était ; un autre promettait
une alerte qui n'existe pas (elle est au lot 3, et les 15 minutes de grâce ne
protègent donc rien aujourd'hui) ; un troisième justifiait l'ordre des passes
par un effet **impossible par construction**. Aucun de ces trois ne rougirait
jamais. C'est la même famille que « un nombre écrit à la main est lu comme une
mesure ».

### ⚠ Une TROISIÈME review, par exception décidée par Thierry (27 octobre 2026)

CLAUDE.md dit : **une review par commit**, et une seule re-review quand la
première trouve un constat de sécurité. Son vécu est documenté — neuf reviews
enchaînées sur un même groupe d'endpoints, dont six n'ont plus trouvé que du
durcissement, et **deux régressions introduites par les correctifs eux-mêmes**.
La règle existe pour arrêter cette spirale.

**Thierry a décidé une exception pour ce lot, et l'a encadrée** : portée limitée
au diff des correctifs, **dernière** review quoi qu'elle trouve, motif écrit.

**Le motif, en deux faits mesurés :**

1. **Le chemin d'envoi par défaut n'était traversé par AUCUN test.** Tous les
   tests de la passe injectent `opts.envoyer`, donc `envoyerParDefaut` n'était
   jamais exécuté. Il passait le snapshot brut au provider — qui n'a pas d'`id`
   — et **tous les envois différés réels ciblaient la réservation
   « undefined »**. Le lot ne fonctionnait pas, et la suite était verte.
2. **La seconde review a trouvé des défauts créés par les correctifs de la
   première.** Le correctif du constat 1 (journaliser dans le cœur) introduisait
   le constat 2 de la seconde : je passais `properties.id`, c'est-à-dire l'UUID,
   là où le cœur attend la ref provider — donc la ligne ne matchait jamais la
   garde anti-double-réponse, et **le défaut que le correctif devait fermer était
   rouvert par la clé**.

**Ce que ces deux faits disent ensemble** : sur ce lot, ni la suite de tests ni
une relecture n'ont suffi à elles seules. Le vert ne couvrait pas le chemin réel,
et les correctifs ont déplacé le défaut au lieu de le fermer. C'est exactement la
situation que la règle des deux reviews ne prévoit pas — d'où l'exception, et
d'où le fait qu'elle soit **encadrée et nommée**, plutôt que prise en silence.

**Et la limite assumée de la portée** : « le diff des 10 correctifs » n'était pas
isolable — ils vivent dans le même arbre de travail que le lot. La review a donc
porté sur les **quatre fichiers de production** qu'ils touchent
(`lib/guestflow/brouillons-dus.js`, `api/messages.js`, `api/agent-config.js`,
`pages/messages.html`) : plus large que demandé, donc pas moins sûr.

### La migration des données refuse la production, et elle est prouvée sur staging

**Condition de Thierry du 28 octobre 2026 : « ma main ne doit pas être la seule
sûreté ».** Ce script écrit le réglage qui **gouverne les envois au voyageur** :
un `--go` tapé dans le mauvais terminal changerait le comportement de tous les
biens d'un compte réel.

**⚠ C'est une variable qui NOMME le projet, pas un drapeau.** Thierry avait
demandé `--confirmer-prod` ; le motif éprouvé du dépôt
(`scripts/verifier-migration-canaux-echec.js`) est plus fort et je l'ai suivi :
`CONFIRMER_PROD=<référence du projet>`. Un drapeau s'ajoute par réflexe au bout
d'une ligne de commande ; nommer soi-même la référence ne se fait pas par
accident. Code de sortie **3** (1 = lecture impossible ou base inconnue,
2 = écritures en erreur).

**⚠ Et le refus passe AVANT toute connexion** — défaut que j'ai corrigé **en
l'éprouvant**. Je l'avais placé après la lecture des configs : un script qui
refuse la production après s'y être connecté et avoir lu ses données fait deux
choses de trop, **et il devient intestable sans accès réel** (une fausse clé le
fait échouer en lecture, code 1, avant d'atteindre son refus, code 3). Le refus
ne dépend que de `SUPABASE_URL`.

**Ce qui ne passe pas**, éprouvé un par un avec une clé bidon donc aucun accès :
`1`, `true`, `oui`, la référence en majuscules, tronquée d'un caractère, avec un
caractère en trop, la référence de **staging**, la chaîne vide, et les drapeaux
`--confirmer-prod` / `--confirmer` / `--force` / `--prod`. La menace testée est
**la faute de frappe, pas l'attaquant**.

**⚠ Ce qui PASSE, et c'est assumé : un espace avant ou après la valeur.** Le
`.trim()` l'absorbe, comme dans le motif existant. C'est voulu — un
copier-coller avec un espace a une intention claire (la personne a tapé la
référence complète), alors qu'une troncature ou une autre référence signalent
une erreur réelle. Nommé ici plutôt que découvert un jour comme une surprise.
`tests/migration-modes-refuse-prod.test.js`, 7 tests.

**La preuve sur staging (28 octobre 2026).** Staging n'avait **aucun** bien à
migrer — zéro ligne d'`agent_alert_config`. Deux biens ont donc été semés à
l'ancien format, puis mesurés :

| bien | semé | `getPropertyMode` avant | après | `delais` écrit |
|---|---|---|---|---|
| `STG-BIEN-1` | `mode: 'test'` | `test` | **`test`** | `reponse_ia: null` |
| `STG-BIEN-2` | `mode: 'auto'` | `auto` | **`auto`** | `reponse_ia: 0` |

`alerte_info: 0` sur les deux, sourdine inactive. Le passage **à blanc n'a rien
écrit** (vérifié par une mesure entre les deux), et un second `--go` rend « 0 à
migrer, 2 déjà migrés ».

**Le seul écart, et il est attendu** : le *motif* de `delaiDeReponse` passe de
`sans_delai` à `validation_manuelle` / `immediat`. C'est la **provenance** qui
change — avant, le binaire était dérivé de `mode` ; après, il est lu dans le
bloc. Le résultat, lui, est identique, et c'est tout le cahier des charges.

⚠ **Les deux biens semés restent sur staging** : ils donnent à la recette un
bien en validation manuelle et un en immédiat, ce qui est exactement ce qu'il
faut pour vérifier l'écran. Pour les retirer, vider leur entrée du blob
`agent_alert_config` du compte `6c413095`.
