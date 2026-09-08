# KB — Alertes hôte, kill switch & coupe-circuit

<!-- SOURCES (mapping inverse). ⚠️ DOC en tête de ces fichiers pointe ici. Modif = MÊME COMMIT. -->
> Sources : `apps/agent-ai/config.html` (config canaux + boutons Tester + miroir kill switch),
> `pages/biens.html` (bouton Couper l'IA / Réactiver), `api/agent-config.js`,
> `lib/alert-notify.js` (envoi email universel + SMS hôte), `api/alert-test.js` (bouton Tester),
> `pages/onboarding.html` (`seedAlertConfig` : email activé par défaut), `api/sms.js`,
> `lib/cron-alerting.js` (volume anormal + coupe-circuit auto), `lib/founder-notify.js`,
> `lib/platform-notify.js`

## 1. Canaux d'alerte hôte

### Email (canal par défaut, universel)
- **Activé automatiquement pour tous** à l'onboarding, avec l'**email du compte prérempli**.
- Envoyé **par HôteSmart** — aucun compte tiers requis.
- Modifiable dans la **config GuestFlow** (Agent IA).

### SMS (optionnel, via le compte Brevo de l'hôte)
- Nécessite un **compte Brevo gratuit côté hôte** : créer le compte, récupérer la **clé API**, la
  saisir dans **`/connexions`**.
- **Sans clé Brevo, l'option SMS est désactivée** avec un message explicatif.

### Boutons « Tester »
Un bouton **Tester** par canal dans la config : en cas d'échec, il affiche **l'erreur exacte**.

## 2. Événements qui alertent l'hôte
- **Urgence** détectée par l'IA.
- **Information manquante** demandée par l'IA.
- **Code d'accès non résolu**.
- **Pause automatique** de son bien (voir §3).

## 3. Kill switch (manuel) & coupe-circuit (automatique)

### Couper l'IA / Réactiver (manuel)
Chaque bien a un bouton **Couper l'IA / Réactiver** sur **`/biens`** (miroir dans la config GuestFlow).
- **Coupé** = plus de réponses auto, **plus de codes créés** (ni création sur la serrure, ni envoi),
  plus de messages sortants.
- **Continuent** : la **réception** des messages et la **synchro** des réservations.
- Le **code du voyageur déjà en place reste valable** (le kill switch ne le supprime pas).

**Périmètre du kill switch : il est tourné vers le VOYAGEUR, pas vers le ménage.**
Décision produit assumée — un bien en pause continue de notifier son prestataire,
parce que le logement doit être nettoyé même quand l'automatisation voyageur est
coupée. Concrètement, restent actifs pendant la pause :
- les **notifications ménage** (`menage_events` : nouvelle réservation, modification,
  annulation) et donc la PWA prestataire ;
- la **suppression** du code d'accès sur annulation (`cancelAccessCode`) — seule sa
  *régénération* est bloquée ;
- l'écriture des `bookings_snapshot` et des `booking_change_events`.

**Aucun rattrapage à la reprise** : un événement ignoré pour cause de pause est
consommé et marqué traité (garde anti-boucle, cf. `docs/kb/booking-changes.md`).
Rien ne s'accumule, rien ne repart en masse à la réactivation — un message non
envoyé pendant la pause est définitivement perdu, ce qui est le comportement voulu.

### Pause automatique (coupe-circuit)
Deux protections tournent en fond (par heure glissante) :
- **Volume anormal par bien** (seuil ~10 messages IA/auto en 1h) → **alerte** l'équipe, **sans**
  mettre le bien en pause.
- **Coupe-circuit par conversation** : si une **même conversation boucle** (seuil ~6 messages IA en
  1h sur la même réservation), le **bien est mis en pause automatiquement** (`automation_paused`,
  raison « coupe-circuit auto : boucle conversation »). L'hôte reçoit un **email explicatif**.

Effet identique au kill switch manuel (plus de réponses ni de codes créés ; réception + synchro
continuent ; code déjà posé valable). **Réactivation en un clic** après vérification de la messagerie.

## 4. Réponses type support
- « Je ne reçois pas les SMS » → vérifier la **clé Brevo dans `/connexions`**, l'**option SMS
  activée**, et utiliser le bouton **Tester**.
- « Je ne reçois pas les emails » → vérifier les **spams** et l'**adresse** dans la config GuestFlow.
- « L'IA ne répond plus sur un bien » → vérifier le **badge « IA en pause »** sur `/biens`, **lire
  la messagerie**, puis **réactiver**.

## Note interne (invisible à l'hôte)
Il existe aussi un canal d'alerte **plateforme/fondateur** (incidents techniques → équipe, SMS+email,
persistance + anti-spam). Utilisé par le futur chat support pour remonter un bug bloquant. Ne pas
l'exposer aux hôtes. Types d'incidents : échecs d'envoi, échec code serrure, volume anormal, erreur
webhook, coupe-circuit, **boucle de production d'événements ménage** (`event_loop` : un producteur
qui génère des `menage_events` en rafale, seuil `EVENT_LOOP_THRESHOLD`/booking/24h, alerte seule,
dédup 24h par bien — aucune suspension d'écriture), et **croissance anormale d'une table**
(`table_growth` : sonde générique horaire sur les tables à écriture auto — menage_events,
message_sent_log, messages, agent_tasks, automation_incidents, sms_logs, bookings_snapshot ;
seuils larges surchargeables via `TABLE_GROWTH_MULTIPLIER` ; alerte seule, dédup 6h par table,
aucune action automatique).

## Rappel
Aucun SMS n'est **inclus ni facturé par HôteSmart** : le SMS passe **par le compte Brevo de l'hôte**.

## Surréservation — l'exception qui ne se tait pas

`overbooking` est le SEUL type d'alerte à ne pas suivre l'anti-spam décrit
ci-dessus. Il réémet un SMS toutes les ~45 minutes et ne s'arrête **que** par
acquittement manuel (`api/incidents-acquitter.js`, bouton au dashboard) — ou
lorsque le conflit disparaît de lui-même.

Raison : c'est le seul incident du produit qui ne se rattrape pas après coup —
deux voyageurs devant la même porte le même soir. Il passe donc par
`envoyerAlerteBrute` (envoi seul, sans persistance ni anti-spam) et non par
`reportIncident`, qui dupliquerait l'incident et éteindrait la relance.

**Réservé à cette gravité.** Une alerte qui crie pour rien finit ignorée, et le
jour où elle compte, personne ne la lit. Détail : `docs/kb/reservation-directe.md`.

## Qui est joignable, et où — état de référence au 6 septembre 2026

Photo prise à la clôture de l'étape 2 du chantier « réservation manuelle », après
correction. Numéros masqués : seuls les quatre derniers chiffres figurent ici — le
KB est versionné, il ne porte pas de coordonnées complètes.

| emplacement | numéro | à quoi il sert |
|---|---|---|
| `profiles` — **titulaire** (`is_owner = true`) | **…6760** | alarmes qui réveillent l'hôte : surréservation, incidents |
| `profiles` — **Régina** (`access_mode = 'lien'`) | **…5290** | ses notifications de ménage et propositions d'assignation |
| `knowledge.telephone_hote` — coeur de vie 23 | **…5290** | contact **voyageur** (placeholder `{telephone_hote}`) |
| `knowledge.telephone_hote` — Cœur de vie « La bulle » | **…5290** | idem |

**Deux numéros distincts pour quatre emplacements**, et c'est voulu :

- Le titulaire est seul sur le sien. C'est lui que l'alarme de surréservation
  appelle, et lui seul qui peut l'acquitter — le cycle « crier jusqu'à
  acquittement » ne boucle que si ces deux rôles coïncident.
- Régina porte son propre numéro, **définitif**, sur son profil comme dans
  `telephone_hote`. Ce dernier est un **choix produit assumé** : c'est le contact
  terrain donné aux voyageurs, et c'est elle qui est sur place.

### Ce que cette photo corrige

Jusqu'au 6 septembre 2026, le profil de Régina portait **le numéro du titulaire**.
Ses notifications de ménage et ses propositions d'assignation arrivaient donc chez
l'hôte — ce qui explique probablement qu'on n'ait jamais constaté qu'elle ne les
recevait pas.

Cette collision a bien failli avoir une seconde conséquence, plus grave. Le code
de l'alarme de surréservation cherchait d'abord le titulaire par
`member_user_id is null` — un filtre qui désigne en réalité un **accès par lien**,
donc Régina. L'alarme lui aurait été adressée toutes les 45 minutes, avec le nom du
bien et les identifiants des réservations en conflit. Le défaut serait resté
**invisible** en test, puisque son profil portait alors le numéro de l'hôte : les
SMS seraient arrivés au bon endroit pour la mauvaise raison, jusqu'au jour où un
vrai numéro aurait été renseigné pour elle. Le titulaire se reconnaît à
`is_owner`, jamais à l'absence de `member_user_id`.

`telephone_hote` n'existe **que sur les deux biens Beds24**. Les biens Channex
(Colomiers) n'ont pas d'entrée : un modèle de message qui utiliserait ce
placeholder sur ces biens ne le résoudrait pas.

## `api_credit` — un service tiers est coupé (crédit ou quota épuisé)

**Vécu du 8 septembre 2026** : le crédit Anthropic s'est épuisé. Toute l'IA du
produit s'est arrêtée — classification des messages entrants, réponses
suggérées, agent, extraction de base de connaissance — et **rien ne le disait**.
L'erreur ne vivait que dans `cron_logs.errors`, un champ que personne ne regarde.
Elle a été trouvée par hasard, en vérifiant autre chose.

Une panne de facturation n'est pas une erreur technique : c'est un service
**coupé**, qui le restera jusqu'à une action humaine.

**Trois services instrumentés**, au plus près de l'appel :

| service | où | ce qui s'arrête |
|---|---|---|
| Anthropic | `lib/cron-shared.js` (client enveloppé) + `api/grok.js` | toute l'IA |
| Brevo | `lib/platform-notify.js` | SMS et e-mails, **alertes comprises** |
| Seam | `lib/providers/seam.js` | les codes d'accès — porte fermée au voyageur |

**Anti-spam : 1 par jour**, et non l'heure habituelle. Un crédit épuisé est le
même fait toute la journée ; une alerte horaire ferait du bruit là où une seule
suffit, et le bruit finit par se faire ignorer. `reportIncident` accepte
désormais `fenetreMs` — défaut inchangé à 1 h pour tous les autres incidents.

**Ce qui n'alerte PAS, et c'est délibéré** : une clé révoquée (401), un
dépassement de débit (429), une panne réseau. Alerter « crédit épuisé » sur une
clé révoquée enverrait chercher au mauvais endroit — une alerte qui trompe est
pire qu'une alerte absente. Hors 402 (explicite), il faut que le texte de
l'erreur le dise.

⚠ **Le cas Brevo se signale par le canal qui vient d'échouer.** Si Brevo est
coupé, le SMS et l'e-mail d'alerte ne partiront pas non plus — l'incident reste
en base (`automation_incidents`), visible, mais silencieux. C'est une limite
connue : la seule sortie serait un second fournisseur d'alerte, hors périmètre.
