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

### ⚠️ Ce qui reste HORS du routage : `lib/cron-classify.js`

Les réponses **automatiques de l'IA** à un message entrant n'empruntent pas `canalPour` :
elles appellent le provider en direct, sans lire le retour, puis écrivent dans `messages`
inconditionnellement.

C'est **sans objet pour le canal e-mail en v1** — une réservation Offline n'a pas de fil, donc
aucun message entrant, donc rien à classer : le chemin n'est pas atteignable. Mais deux
choses restent vraies et méritent d'être écrites plutôt que supposées :

1. le jour où l'ingestion des réponses e-mail existera (chantier séparé, hors périmètre),
   ce producteur devra router comme les autres, sans quoi il rouvrira le faux vert ;
2. son `recordMessage` inconditionnel après un envoi dont le retour n'est pas lu est le même
   défaut que celui corrigé ailleurs — il concerne aujourd'hui les seuls canaux OTA, où
   l'envoi fonctionne. **Dette notée, pas soldée.**

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
Garde temporelle commune Beds24+Channex (hasNewerTaskOrConv) : toute tâche ou conversation créée après le dernier message guest fait skipper le thread AVANT l'appel IA. Le chemin Channex n'avait aucune garde basée sur les tâches (~3500 classifications/jour inutiles). Skip également si le dernier message du thread est du host.
