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

## L'escalade — un incident qui dure doit s'espacer

⚠️ **Vécu le 18 septembre 2026.** Colomiers avait un ménage du 22 sans personne de garde —
un fait vrai, stable, que personne ne pouvait corriger sur-le-champ. L'anti-spam horaire a
réexpédié la **même phrase toutes les heures** : 235 e-mails transactionnels sur le compte,
au point de noyer un e-mail de test qu'on cherchait. C'est littéralement l'alarme qu'on
apprend à ignorer, et c'est la faute que ce dépôt combat partout ailleurs.

Une alerte utile dit deux choses : « ça ne va pas » et « ça ne va **toujours** pas ». La
première mérite l'heure ; la seconde, de plus en plus d'espace.

**La règle** : `1 h → 2 → 4 → 8 → 16`, plafonnées à **24 h**. La fenêtre passée en
`fenetreMs` est la **base** du doublement, pas une valeur fixe.

⚠️ **Aujourd'hui, un seul appelant escalade réellement : le défaut à 1 h.** `api_credit`
(`lib/incident-facturation.js`) passe déjà 24 h, qui *est* le plafond — pour lui,
`min(24 h × 2, 24 h)` vaut toujours 24 h et la mention « élargi » n'apparaît jamais. Ce n'est
pas un défaut, c'est une conséquence : un crédit épuisé est le même fait toute la journée.
Mais la doc l'annonçait comme l'exemple d'un appelant qui escalade — c'était faux.

**Le compteur repart de zéro** quand le fait **se tait** : deux alertes séparées de plus de
**48 h** n'appartiennent pas au même épisode. L'hôte corrige, trois jours passent, le même
message revient — et il réveille tout de suite au lieu d'hériter du silence de l'ancien.

⚠️ **La remise à zéro « par acquittement » ne suffit pas, et elle était même du code mort** :
`acquitted_at` n'est posé que sur les incidents `overbooking`, qui n'empruntent pas
`reportIncident`. Le test existe toujours (il coûte une ligne et servira le jour où
l'acquittement s'élargira), mais c'est la **rupture par le silence** qui fait le travail.

⚠️ **Un autre fait sur le même bien n'efface pas l'ancienneté du nôtre.** On compte les
lignes qui disent la *même* chose, sans s'arrêter à la première qui dit autre chose.
Rompre au premier message différent paraissait juste : `menage_non_assigne` a **deux
producteurs** sur un même bien (`synchroniserMenages` et `expirerPropositions`), avec des
phrases différentes, dans la même passe de cron. Le fait A, escaladé à 8 h, voyait la ligne
de B arriver en tête, repartait à 1 h — et les deux s'étouffaient mutuellement à l'heure,
exactement le mode de panne à 235 e-mails que ce lot corrige.

**Fail-safe** : une lecture en échec rend la fenêtre de base. On préfère une alerte de trop à
une alerte manquante — c'est le sens même d'une alerte.

L'e-mail **dit** quand la fenêtre a été élargie (« élargi parce que ce fait persiste »), sinon
le fondateur croit l'alerte perdue alors qu'elle est seulement espacée.

### Ce que l'escalade ne remplace pas

Elle rend le bruit supportable ; elle ne corrige pas sa cause. Pour Colomiers, la cause était
réelle : le 22 septembre est un **mardi**, et sur ce bien aucune prestataire n'est à la fois
*attitrée* ce jour-là et *disponible*. Voir `docs/kb/menage.md` — l'escalade ne doit pas
servir à ne plus voir un réglage qui manque.

## Écran d'incidents hôte — chantier EN PAUSE au 18 septembre 2026

Branche `chantier-incidents`, arrêtée après l'étude, **avant toute implémentation**.
Cette section existe pour reprendre sans réétudier.

### Pourquoi ce chantier

C'est la dette la plus lourde du chantier canal e-mail : **l'hôte n'a aucun endroit où voir
ce qui s'est mal passé**. Deux replis plateforme (la confirmation de réservation et la
notification de vente, qui partent sous l'identité HôteSmart quand l'identité de l'hôte
échoue) n'existent que parce que cet écran n'existe pas. Le jour où il existe, on les retire
et on **retourne les tests** qui défendent aujourd'hui « elle part toujours ».

### Ce que l'étude a trouvé (production, 18 septembre 2026)

`automation_incidents` existe déjà et porte **12 348 lignes, dont 12 347 jamais acquittées**.
23 types déclarés dans `lib/founder-notify.js`. Sur 30 jours :

| type | 30 j | 7 j | sans `user_id` |
|---|---|---|---|
| `api_credit` | 11 196 | 11 196 | **11 196** |
| `ecriture_de_masse_annoncee` | 332 | 332 | 0 |
| `menage_non_assigne` | 601 | 601 | 0 |
| `table_growth` | 128 | 121 | **121** |
| `messages_import_suspendu` | 19 | 19 | 0 |
| `send_failure` | 16 | 9 | 0 |
| `cles_migrees_illisible` | 5 | 5 | 0 |
| `overbooking` | 1 | 0 | 0 |

⚠ **Trois constats qui commandent la conception. Ne pas les redécouvrir.**

1. **Ce ne sont pas 12 348 incidents, c'est une poignée de faits réémis toutes les cinq
   minutes.** Les 601 `menage_non_assigne` sont *un* ménage, sur *un* bien, répété 601 fois.
   Un écran qui liste les LIGNES est inutilisable dès le premier jour.
2. **Seul `overbooking` sait se refermer.** `api/incidents-acquitter.js` ne traite que lui.
   Les 22 autres types n'ont **aucun cycle de vie** : rien ne dit jamais « c'est réglé ».
3. **Deux types ne portent aucun compte** (`api_credit`, `table_growth` : `user_id` nul
   partout) : ils sont structurellement invisibles d'un écran hôte.

### La structure proposée (validée par Thierry, non implémentée)

**L'écran montre des FAITS, pas des lignes.** Un fait = (type + bien + message), avec
« depuis le… », « n fois », « dernière fois… ».

**Deux familles, et c'est la distinction qui décide de tout :**

- **Faits récurrents** — le cron les réémet tant que ça dure (`menage_non_assigne`,
  `stop_sell_perdu`, `cles_migrees_illisible`, `messages_import_suspendu`). Le silence vaut
  résolution : après ~6 h sans récidive, le fait descend dans « réglé tout seul ».
- **Faits ponctuels** — émis une fois, jamais réémis (`paiement_orphelin`,
  `reservation_remboursee`, `email_voyageur_abandon`, `notif_hote_non_envoyee`,
  `email_confirmation_repli`). Le silence **ne vaut pas** résolution : sans acquittement
  explicite, un paiement orphelin disparaîtrait de lui-même.

Chaque type porte deux phrases en français d'hôte — ce que ça veut dire, ce qu'on peut
faire. Aujourd'hui le libellé le plus clair dit `cles_migrees_illisible`.

### ⚠ Les trois décisions sont POSÉES, pas tranchées

Elles ont été soumises à Thierry le 18 septembre ; le chantier a été mis en pause **avant
qu'il y réponde**. Ne pas les traiter comme acquises à la reprise :

1. **Les incidents de plateforme** (`api_credit`, `table_growth`,
   `ecriture_de_masse_annoncee`, `webhook_error`) : masqués de l'écran hôte, ou vue
   fondateur séparée ?
2. **« J'ai vu » sur un fait récurrent** : mise en sourdine avec retour après 24 h si le fait
   persiste, ou disparition jusqu'à extinction réelle ? *Recommandation : la sourdine —
   l'inverse de la leçon des 235 e-mails, pour qu'un hôte ne puisse pas éteindre durablement
   un fait qui dure.*
3. **L'entrée** : page `/incidents` à part, ou bandeau permanent sur `/index` avec le détail
   derrière ? Aujourd'hui seule la surréservation a un bandeau, dans `pages/index.html`.

### Dette découverte en chemin : `api_credit` n'est attribué à personne

Les 11 196 lignes portent `user_id = null`. Or ce type dit « vos SMS sont coupés, crédit
épuisé » — exactement ce qu'un hôte doit savoir. **Tel quel, l'hôte dont les envois
s'arrêtent ne l'apprendra jamais par cet écran.** À trancher au moment de l'implémenter :
attribuer l'incident au compte dont la clé a échoué, ou l'assumer comme un fait de
plateforme. Voir aussi § « `api_credit` » plus haut.

### Ce que l'étude a mis au jour, et qui vit encore

`menage_non_assigne` tournait toujours le 18 septembre à 21 h 31 : le ménage du
**24 septembre** sur Colomiers n'a personne de garde — ni attitrée, ni disponible. Ce ménage
découle des réservations de test du chantier canal e-mail ; leur annulation l'éteint.


---

## Les trois alarmes des canaux d'un bien (dette 59, 19 octobre 2026)

Ajoutées avec le chantier « les canaux au cœur ». Writer unique :
`lib/canaux-du-bien.js`.

| type | ce qu'il dit | ce qu'on fait |
|---|---|---|
| `canaux_releve_en_panne` | le relevé échoue depuis plus de 24 h d'affilée | regarder le motif (`injoignable`, `delai`, `reponse_invalide`, `tronquee`, `plafonnee`) ; l'écran de l'hôte **ne se vide pas**, il vieillit |
| `canaux_disparition_totale` | une lecture réussie n'annonce plus **aucun** canal d'un compte qui en avait | **rien n'a été effacé.** Si la seconde lecture confirme dans l'heure, les pastilles disparaîtront. C'est le moment de vérifier chez le partenaire |
| `canaux_lecture_incomplete` | lecture plafonnée, tronquée, ou plus de canaux vivants que la borne de lecture | aucune disparition n'est écrite tant que ça dure |

**Trois choses à savoir avant de lire ces alertes.**

1. **Le message est STABLE, les nombres sont à côté.** `fenetreEscaladee`
   reconnaît « le même fait » en comparant le message : un message qui porterait
   le nombre d'heures changerait à chaque cycle et l'escalade 6 h → 12 h → 24 h
   ne se déclencherait jamais. Les valeurs qui bougent (`heures`,
   `tentatives`, `motif`, `canaux_concernes`) sont des champs du `detail`.
2. **L'anti-spam est par TYPE, pas par compte.** `reportIncident` déduplique sur
   `(type, property_id)`, et ces trois alarmes n'ont pas de bien à désigner —
   elles sont au grain du compte. Le compte A en panne rend donc l'alarme du
   compte B muette pendant 6 h, alors que le `detail` ne nomme que A. Connu,
   acceptable à un seul compte réel, à revoir quand il y en aura plusieurs :
   le changement est dans `lib/founder-notify.js`, partagé par toutes les
   alarmes, donc c'est un chantier à lui seul.
3. **`suspendu` n'est pas une panne.** Le relevé rend `ok: false` avec ce motif
   quand le disjoncteur reporte un effacement : le cron le voit, le fondateur
   est averti, et l'hôte, lui, ne lit rien d'anormal — ses pastilles et leur
   date sont celles d'avant.

---

## `reponse_partenaire_invalide` — détection seule (19 octobre 2026)

Posée par `lib/reponse-partenaire.js`, branchée sur les **17 copies de
`channelCall` du code déployé**. Elle dit une seule chose : le partenaire a
répondu **2xx avec un corps inexploitable** — pas du JSON, ou du JSON sans
`data`/`meta`/`errors`, ou un corps vide sur une lecture.

**⚠ Aucun comportement n'en dépend.** C'est l'étape 1 du chantier : on mesure
d'abord si le cas se produit et où, parce qu'**aucune trace n'existait** — le
défaut est muet par construction. Les quatre chemins qui en tirent une
conclusion destructrice se corrigent ensuite, un par un, chacun avec sa recette.
Inventaire : `docs/kb/reponse-200-sans-json.md`.

**Ce que l'alerte vous dit, et ce qu'il faut regarder.**

| champ du détail | à quoi il sert |
|---|---|
| `fichier` | **le plus important** : c'est lui qui dit quel chemin est touché, donc ce que le code a conclu de cette réponse |
| `code` | `reponse_non_json`, `forme_inattendue` ou `reponse_vide` |
| `statut` | le code HTTP rendu — toujours un 2xx, sinon l'appelant le verrait déjà |
| `chemin` | **normalisé** : les identifiants du partenaire y sont remplacés par `:id` |

La table `reponses_partenaire_invalides` garde le détail, avec 300 caractères du
corps reçu. **Elle n'est lue par aucun client** : RLS active sans aucune policy,
et les privilèges de table retirés — une page d'erreur porte plausiblement la
marque du partenaire.

**Trois choses à savoir.**

1. **Une panne qui dure ne fabrique pas mille lignes.** `channelCall` est appelé
   des dizaines de fois par cycle de cron. Les répétitions sont regroupées par
   `(fichier, code)` dans une fenêtre de 10 minutes, avec un compteur
   `occurrences` — et une seule alarme par fenêtre.
2. **Le chemin normal ne coûte rien.** La base n'est touchée que sur une réponse
   inexploitable ; une réponse saine ne provoque aucune lecture.
3. **La surveillance ne lève jamais et ne change rien.** Un appelant ne doit pas
   tomber parce que l'observation a échoué — trois tests le tiennent.

**Neuf outils de `scripts/` sont exemptés, nommément**, dans
`tests/reponse-partenaire-detection.test.js` : ils sont lancés à la main, leur
sortie est lue par un humain au moment où il les lance, et aucun n'est déployé.
Le même test refuse qu'un fichier de `api/` ou `lib/` soit exempté.

## Délai d'alerte « info manquante » — le socle (lot 1, 27 octobre 2026)

Spec : `docs/specs/spec-delai-reponse-ia.md`. Détail du chantier et des
réglages : `docs/kb/guestflow.md`, section « Délai de réponse IA ».
**Ce lot ne change aucun comportement** — le différé arrive au lot 3.

### ⚠ Le constat qui compte : l'alerte n'a JAMAIS été réglable

`lib/cron-classify.js` insère la tâche `info_unknown` ou `intervention`, puis
appelle `sendAlertNotifications` **dans le même tour, inconditionnellement** —
et **sans lire le mode du bien**. En Mode Test comme en Mode Auto, l'alerte
d'info manquante part tout de suite.

Donc le réglage `delais.alerte_info` ne retarde pas un chemin déjà réglable :
**il crée le premier réglage de ce chemin.** L'intuition « c'était déjà en
test » est fausse ici, et c'est pour ça que la migration pose `alerte_info = 0`
**partout** : mettre 15 min aurait changé le comportement de biens en
production sous couvert de migration. Les 15 min sont le défaut des biens
**neufs**, à l'onboarding.

### Ce qui restera inchangé au lot 3

**`intervention` ne sera jamais retardée, jamais mise en sourdine.** L'urgence
part dans le tour, `alert_after` reste nul pour ce type. Seule `info_unknown`
porte une échéance.

### La sourdine de nuit (lot 3)

Activable par bien, plage réglable, **désactivée par défaut**. Une alerte dont
l'échéance tombe dans la plage est repoussée à la fin de la plage. Plage qui
enjambe minuit (22 h → 8 h) traitée explicitement : c'est le cas normal, pas le
cas limite.

⚠ **Le fuseau en v1 est `Europe/Paris` pour tous les biens**, dans une
constante unique (`FUSEAU_V1`, `lib/guestflow/sourdine.js`) — décision de
Thierry du 27 octobre 2026. `properties.timezone` **existe** déjà
(`migrations/2026-09-08-fiche-unifiee.sql`), et on ne la lit volontairement
pas tant qu'aucun bien n'est hors de France. La constante porte son motif :
sans lui, la session qui lira « Paris en dur » dans six mois y verra un oubli
et « corrigera » une décision. Ce qui reste interdit : calculer une sourdine en
UTC en silence — la famille de bugs qui a dupliqué 83 messages le 14 septembre
2026.

### ⚠ Question ouverte au 27 octobre 2026 : la sourdine et l'alerte de reprise

Le lot 2 ajoute une alerte quand le compte à rebours d'un brouillon **modifié
par l'hôte** reprend, pour le prévenir avant qu'un texte peut-être inachevé
parte. Thierry l'a demandée « même canal et même sourdine que l'info
manquante ». **Les deux moitiés ne tiennent pas ensemble** : avec la sourdine,
une reprise à 2 h du matin donne une alerte à 8 h, soit **après** le départ du
brouillon — l'alerte n'avertit plus, elle raconte. Trois issues au §9 de la
spec ; recommandation retenue en attente : la sourdine retarde **l'alerte ET
l'envoi**, pour que l'avertissement précède toujours le texte.

### Dette relevée en passant

`lib/alert-notify.js` — `PROPERTY_NAMES` code en dur `169567` (« Cœur de vie
23 ») et `209413` (« La bulle »). Tout autre bien s'annonce « Logement <id> »
dans le SMS **et** dans l'objet de l'e-mail : l'hôte d'un troisième bien reçoit
une alerte qui lui parle d'un numéro.

## Le délai d'alerte et la sourdine — l'état au lot 2 (27 octobre 2026)

Le lot 2 a livré le **réglage** (`delais.alerte_info`, `delais.sourdine` dans
`agent_alert_config.config[<ref>]`) et la **règle de calcul**
(`lib/guestflow/sourdine.js`). Ce qui **n'est pas** encore branché : le report
effectif de l'alerte « info manquante », qui est le **lot 3**.

Donc aujourd'hui, et il faut le savoir : **le réglage existe à l'écran, et
l'alerte part toujours dans le tour.** La migration pose `alerte_info = 0`
partout, donc le réglage affiché dit la vérité pour tous les biens existants —
mais un hôte qui le passerait à 15 minutes ne verrait rien changer avant le
lot 3. ⚠ C'est une dette assumée du découpage, pas un oubli.

### Ce que `lib/guestflow/sourdine.js` garantit déjà

- Plage **`[début, fin[`** : sans cette convention, une échéance repoussée à
  8 h 00 retomberait dans la plage et serait repoussée à nouveau. Un test le
  vérifie explicitement.
- **Les deux changements d'heure sont éprouvés.** La fin reste 8 h de Paris
  quand la nuit dure 23 heures (29 mars 2027) ou 25 (25 octobre 2026). Et une
  mesure qui surprend : le report du 24 octobre dure **10 h 30 réelles** pour
  9 h 30 de cadran — l'heure rendue s'y ajoute. Ma première assertion disait
  11 h 30 et elle était **fausse** ; le module avait raison. Le calcul est posé
  en entier dans le test, pour que personne ne refasse l'erreur. **Une durée de
  sourdine se calcule sur des INSTANTS, jamais sur la différence des heures
  affichées.**
- **Chaque refus a son motif** (`sourdine_absente`, `sourdine_inactive`,
  `plage_illisible`, `plage_vide`, `hors_plage`, `instant_illisible`) — jamais
  un « non » silencieux.
- **Aucune horloge lue** : tout instant est injecté, un test le vérifie par
  grep sur `Date.now()`.

### Le fuseau, et pourquoi il est en dur

`FUSEAU_V1 = 'Europe/Paris'` pour tous les biens, décision de Thierry du
27 octobre 2026. `properties.timezone` **existe** et n'est volontairement pas
lue tant qu'aucun bien n'est hors de France. La constante porte son motif :
sans lui, la session qui lira « Paris en dur » dans six mois y verra un oubli et
« corrigera » une décision.

### Décision 7 : la nuit, un brouillon MODIFIÉ ne part pas

Et **seulement** modifié : un brouillon jamais touché part la nuit comme en
journée. La sourdine protège le texte incertain de l'hôte, pas la réponse de
l'IA. L'alerte part à la fin de la plage, puis le brouillon **15 minutes plus
tard** — sans ce délai de grâce, l'alerte « avertirait » d'une chose déjà faite.
Le report est en place dans la passe (`reportes` au bilan) ; **l'alerte
elle-même est au lot 3**.

## L'envoi au voyageur : trois issues, une porte, une alarme (30 octobre 2026)

Branche `fix-envoi-ota`. Avant ce lot, le canal OTA écrivait `message_sent_log`
et la ligne du fil **avant** l'envoi. Un refus du provider laissait donc les
deux : `message_sent_log` étant la garde anti-doublon, le message ne repartait
jamais, et le fil l'affichait comme parti. **Mesure en production : cinq envois
perdus en sept jours sur La bulle**, tous Airbnb, tous `http_too_many_requests`,
la ligne de journal horodatée 0,1 à 0,6 s *avant* l'incident — la même
tentative. Le même défaut était déjà écrit dans le dépôt depuis septembre, et
son correctif n'avait été appliqué qu'au canal e-mail.

### Les trois issues (`lib/envoi-ota.js`)

| issue | ce qu'on sait | ce qu'on fait |
|---|---|---|
| `LIVRE` | le provider a pris le message | on écrit le journal et le fil — **seule** issue qui écrit |
| `REFUS` | il a répondu et n'a pas pris le message | on **compte**, le cron réessaie au palier suivant |
| `INCERTAIN` | on ne sait pas s'il l'a reçu | **aucun rejeu**, une ligne « à vérifier » et un geste humain |
| `PERMANENT` | rien n'y changera | un **arrêt** définitif, et on le dit |

**Le statut HTTP passe avant la lisibilité du corps.** Un `429` dont le corps
n'est pas du JSON — une page HTML de passerelle, la forme la plus banale d'une
limite de débit — était classé INCERTAIN, donc bloqué jusqu'à un geste de
l'hôte : exactement le symptôme de production, traité comme un doute au lieu
d'un refus à rejouer. Un **4xx lu** est donc un refus certain, quelle que soit
la forme du corps.

⚠ **Mais la borne est haute aussi, et le premier correctif allait trop loin.**
Écrit « tout statut ≥ 400 est un refus », il transformait un timeout de
passerelle en **renvoi à l'aveugle** : un 502, 503, 504 ou 408 avec une page
HTML ne vient pas de l'application — la requête a pu être **traitée** avant que
le proxy abandonne, donc le voyageur recevait le même message une seconde fois,
et jusqu'à cinq. Le test assumait le risque en disant « le plafond le borne » :
il le borne à cinq doublons, pas à zéro. **Un 5xx ou un 408 au corps illisible
reste INCERTAIN** ; porteur d'un code **du provider**, il redevient un refus,
puisqu'un provider qui a su répondre a traité la requête. C'est la lisibilité du
corps qui départage, pas le statut seul. Les trois codes qui sont les nôtres
(`reponse_non_json`, `forme_inattendue`, `reponse_vide`) ne valent donc que
pour un 2xx, un 5xx, un 408, ou un statut absent.

### La porte, et pourquoi elle pose l'arrêt elle-même

`porteOta` est consultée par les **deux** moteurs (`checkAndSendTemplate` et
`triggerTemplates`) **avant** la génération du message — `generateAutoMessage`
est un appel payant à Haiku, et un message au plafond en payait un à chaque
tick. Elle lit, dans cet ordre : l'**arrêt** (sans fenêtre), le « **à
vérifier** » (sans fenêtre), puis le **plafond** et le **palier** (fenêtre de
24 h, paliers 0/5/15/45/120/360 minutes, 5 tentatives).

⚠ **Elle POSE l'arrêt au plafond, et c'est le correctif d'un défaut de
structure.** La gestion du plafond vivait en aval, dans `envoyerEtJournaliser` ;
la porte en amont retournait `!ok` sans rien poser, donc la branche aval était
**inatteignable**. Déroulé réel : 5 refus en 24 h → tick suivant, la porte
refuse en silence → ni arrêt, ni alarme ; 24 h plus tard les 5 refus sortent de
la fenêtre de comptage, la porte rouvre, **et le message part** — alors que
l'hôte n'a jamais rien vu. Le test qui gardait cette branche faisait
`indexOf('noterArretOta')` sur la **source** : il mesurait qu'une ligne était
écrite, pas qu'elle s'exécute, et il est resté vert. L'effet se mesure
maintenant en **appelant** la porte (`tests/porte-ota-execution.test.js`).

⚠ **Et elle ne ferme que le mode Auto.** Placée avant la lecture du mode du
bien, elle étouffait aussi la **proposition** du mode Test — donc le seul chemin
qui restait à l'hôte pour envoyer le message à la main, celui que l'alerte lui
demande d'emprunter. En mode Test il n'y a pas d'envoi, donc pas de rejeu à
plafonner.

### Une alarme, une fois

`noterArretOta` **bloque et alerte** (`threshold: 1`). Il a existé un second
writer, `noterAbandonOta`, qui n'alertait que : deux types d'incident pour un
seul échec, et l'anti-spam de `reportIncident` étant clé sur
`(type, property_id)`, **deux types différents ne se suppriment pas l'un
l'autre** — donc deux cartes au bandeau, deux SMS et deux e-mails disant la
même chose. Il est supprimé ; le compte des tentatives, seule information qu'il
portait en plus, est passé à l'arrêt.

Acquitter une alarme la retire de l'écran ; **ça ne relance aucun envoi**, et
c'est délibéré : « acquitté » est ambigu, et rejouer serait la seule erreur
irréversible de tout ce mécanisme.

### Le verrou d'envoi

Ne plus rien écrire avant l'envoi a emporté une protection que le défaut
procurait par accident : deux passages de cron qui se chevauchent liraient
« aucun journal » et enverraient les deux. `write_locks` la rend explicite —
`insert` et non `upsert` (un conflit de clé primaire **est** le signal), un
**jeton** pour ne relâcher que sa propre tenue, et une durée de **15 minutes**
qui doit dépasser l'intervalle du cron. ⚠ Le cron qui compte n'est pas
`/api/cron-messages` (`*/10`) comme l'avait écrit un commentaire, mais
`api/cron.js` (`*/5`), qui appelle `processMessageTemplates`. Le test ne nomme
plus aucun cron : il prend le **plus court** des intervalles déclarés.

### Ce que l'hôte voit, et où il agit

Quatre types atteignent le bandeau de `/aujourdhui` et sont acquittables, et
**les deux listes doivent rester identiques** (`api/ecran/aujourdhui.js` et
`api/incidents-acquitter.js`) : une alarme affichée mais non acquittable laisse
un bouton qui rend 404 et une alarme à l'écran pour toujours.

- `overbooking`, `message_ota_a_verifier`, `message_ota_arret`,
  `email_voyageur_abandon`.
- **Deux lectures, un plafond par famille** (décision de Thierry, 30 octobre
  2026). Le `limit(50)` était partagé et trié par date descendante : les alarmes
  d'envoi étant plus fraîches qu'une surréservation qui dure, cinquante d'entre
  elles chassaient de l'écran le conflit le plus cher du produit. La
  surréservation a maintenant sa lecture et son plafond ; rien ne peut plus la
  pousser dehors.
- **L'écran n'affiche que les incidents d'envoi nés après le déploiement**
  (`SEUIL_ALARMES_ENVOI`). C'est une ceinture : mesure en production, **0 ligne**
  de ces types avant le lot. L'historique (11 977 `api_credit`, 1 209
  `send_failure`, jamais acquittés) n'est **pas** dans ces listes et n'entre donc
  pas au bandeau ; il sera acquitté en masse plus tard, sur le go de Thierry,
  avec auteur et motif, en lot séparé. ⚠ Ce seuil ne doit **jamais** être déplacé
  vers le futur : il masquerait toutes les alertes d'envoi en silence. Un test
  le refuse.
- **Chaque carte commence par l'information utile.** La clé de corrélation
  (`OTASTOP:…`, `OTAVERIF:…`) est en **fin** de phrase, entre crochets : en tête,
  elle faisait lire quatre-vingts caractères d'identifiants techniques avant le
  premier mot utile. `lireLignes` cherche par `ilike '%clé%'`, la position ne lui
  importe pas.
- **Chaque carte porte les phrases de sa famille.** Le bandeau ne servait que la
  surréservation, et ses trois textes sont écrits pour elle : « Surréservation ·
  {bien} », « Deux séjours sur la même nuit. », « L'alerte se répète jusqu'à
  acquittement. » Sur un arrêt d'envoi, les trois sont faux — et le dernier est
  l'inverse du mécanisme, puisqu'un arrêt n'alerte qu'une fois. Une alarme qui
  se décrit faussement se classe faussement : l'hôte cherche un conflit de
  calendrier et ne lit pas le message qui ne part pas.

⚠ **DÉCISION PRODUIT EN ATTENTE, et elle dépasse ce lot.** En dérivant la liste
du code qui pose les alarmes, on a compté, dans `api/` et `lib/`, **20 types qui
réveillent l'hôte** (`threshold: 1`, avec un bien nommé) : **3 sont affichés**
(les deux de l'envoi OTA et `email_voyageur_abandon`), et **17 n'apparaissent
sur aucun écran** — `api_credit`, `booking_change_dispatch`, `circuit_breaker`,
`claim_failure`, `email_confirmation_repli`, `event_loop`,
`message_non_envoye` (« information manquante », le plus proche de ce lot),
`notif_hote_non_envoyee`, `paiement_issue_incertaine`,
`poussee_dates_sans_prix`, `poussee_nuits_vendues`, `prix_non_pousses`,
`prix_sous_plancher`, `reservation_remboursee`, `seam_failure`, `send_failure`,
`volume`. Les élargir au bandeau d'un coup
noierait exactement l'écran que la décision ci-dessus protège. Choisir lesquels
le méritent est une décision produit.
