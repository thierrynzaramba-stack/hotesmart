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
