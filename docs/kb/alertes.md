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
webhook, coupe-circuit, et **boucle de production d'événements ménage** (`event_loop` : un producteur
qui génère des `menage_events` en rafale, seuil `EVENT_LOOP_THRESHOLD`/booking/24h, alerte seule,
dédup 24h par bien — aucune suspension d'écriture).

## Rappel
Aucun SMS n'est **inclus ni facturé par HôteSmart** : le SMS passe **par le compte Brevo de l'hôte**.
