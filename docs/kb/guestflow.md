# KB — GuestFlow AI (agent voyageur)

<!-- SOURCES (mapping inverse). ⚠️ DOC en tête de ces fichiers pointe ici. Modif = MÊME COMMIT. -->
> Sources : `lib/cron-messages.js`, `lib/canal-voyageur.js`, `api/agent-config.js`, `api/grok.js`,
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

### `ENVOI_EMAIL_BRANCHE` — l'interrupteur de l'étape 3

Tant qu'il vaut `false` (`lib/canal-voyageur.js`), le canal e-mail est **décidé mais jamais
tenté**. Les deux moteurs sortent **avant** `generateAutoMessage` : sans cette sortie, un
appel Claude Haiku partait par réservation Offline et par template, toutes les 5 minutes,
sur toute la fenêtre −7 j/+30 j, pour un message qui ne part pas. Avant ce chantier, le
journal écrit en amont court-circuitait dès le second passage ; en le déplaçant après
l'envoi, on a ouvert la porte à une dépense répétée — sur le budget de cron qui vient de
produire un 504.

À l'étape 3 : passer l'interrupteur à `true` **et** retirer les sorties anticipées qui le citent.

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

### Dettes ouvertes à traiter à l'étape 3

1. **Le Mode Validation ne route pas.** `apps/agent-ai/messagerie.html` poste « Valider et
   envoyer » en dur vers `/api/beds24` — un chemin Beds24 seul, qui ne connaît ni Channex ni
   l'e-mail. Aujourd'hui sans conséquence (l'interrupteur ferme le canal e-mail avant la
   création de la tâche), mais **le jour où il s'ouvre, un bien en mode validation écrira
   `message_sent_log` pour un message que la validation ne saura pas envoyer** : condamné
   des deux côtés. Cette correction n'est donc pas optionnelle à l'étape 3.
2. **`recordMessage` étiquetterait un e-mail comme un message OTA** : `provider: 'channex'`,
   `ota: 'Offline'`. Un envoi Brevo enregistré comme un message de la messagerie Channex.
   Inatteignable tant que l'interrupteur est fermé.
3. **Le plafond de tentatives** décidé pour ce canal : à l'étape 2 il n'y a aucune tentative
   à plafonner.

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
