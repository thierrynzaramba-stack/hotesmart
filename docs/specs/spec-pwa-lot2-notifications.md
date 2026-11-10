# Spec — PWA lot 2 : les notifications push de l'appli hôte

**Statut : décisions produit prises par Thierry le 7 novembre 2026 (§13).
Le lot 2a (le socle) est EN PRODUCTION depuis le 7 novembre 2026 à 19 h 57
(main `019ae717`, KB `docs/kb/pwa.md` §8) ; 2b et 2c restent à coder.** La spec
a passé deux reviews avant ces décisions : la première a trouvé 5 constats de
sécurité et 2 bloquants ; la seconde, la dernière, a vérifié leur correction.

**Comment lire.** Les §0 à §8 disent ce que le produit fera. Les §9 à §12 sont
techniques et ne demandent aucune décision. KB du lot 1 : `docs/kb/pwa.md`.

## 0. Ce que le lot fait

- **L'hôte et ses membres reçoivent des notifications** sur leur téléphone ou
  leur ordinateur, pour quatorze événements (§3). Chacun règle, événement par
  événement, ce qu'il reçoit par notification, par e-mail ou par SMS.
- **Le point important, selon Thierry : l'hôte n'est pas dérangé quand la
  réponse peut attendre.** C'est le mode « urgence seulement » (§4).
- **Tout se règle dans `/settings`**, en un seul endroit. Le bloc « Alertes » du
  tiroir de Messages y déménage.
- **Quand un appareil est abonné, la notification remplace le SMS** pour cette
  personne, toujours.
- **L'appli prestataire suit juste après**, dans un lot 3 qui utilisera les
  mêmes clés (§8).
- **Les écrans touchés** sont `/settings` et le tiroir de Messages, deux écrans
  de la refonte V5. Thierry a donné son accord le 7 novembre pour ce
  déplacement. Le reste de `pages/`, `apps/` et `shared/ui.css` n'est pas
  touché.

## 1. État des lieux (mesuré sur main `66495863`)

- **Le service worker de l'appli** (`shared/pwa/service-worker.js`, servi à
  `/sw.js`, 8 477 octets) ne réagit qu'à trois choses : son installation, son
  activation, et le chargement des pages. `tests/pwa-service-worker.test.js`
  garantit qu'il n'a aucune notification push. **Ce lot changera ce test
  exprès** (§9.5).
- **Ce qui prévient l'hôte aujourd'hui** :

  | Événement | Où il naît | Canal actuel |
  |---|---|---|
  | Surréservation | `lib/cron-overbooking.js` | toutes les ~45 min jusqu'à l'acquittement : e-mail, copie au fondateur, et SMS si l'hôte a une clé Brevo |
  | « Intervention » : urgence détectée par l'IA, code d'accès non résolu, ménage refusé par la prestataire, disponibilités modifiées par une prestataire | `lib/alert-notify.js` (un seul type, `intervention`, pour ces quatre événements) | e-mail et/ou SMS, vers des listes d'adresses et de numéros saisies par bien dans `agent_alert_config` |
  | Information manquante demandée par l'IA | `lib/alert-notify.js` | idem. ⚠ Le délai et la sourdine de nuit **ne sont pas encore branchés** : l'alerte part dans le tour (lot 3 du chantier délai) |
  | Pause automatique d'un bien | `docs/kb/alertes.md` §3 | e-mail |
  | Nouvelle réservation **directe** | `lib/notif-hote-resa.js` (Offline seulement) | e-mail |
  | Ménage sans personne (trou de garde) | `lib/cleaning/sync-menages-entite.js` | **le fondateur seulement** (`reportIncident`), et sans SMS depuis le 17 septembre parce qu'il partait trop souvent. Un hôte externe ne reçoit rien |
  | Ménage « Pas vu » par la prestataire | `shared/menages-a-traiter.js` | à l'écran seulement |

- **Les droits** (`lib/permissions.js`) : un titulaire et des membres, avec
  8 domaines (`reservations`, `menages`, `prestataires`, `messages`, `avis`,
  `reglages`, `facturation`, `equipe`) à `none`, `read` ou `write`, et un
  périmètre de biens. L'acquittement d'une surréservation est permis au
  titulaire **et** à un membre qui a `reservations` en `write` sur le bien
  (`api/incidents-acquitter.js`).
- **Les profils** portent un e-mail et un téléphone, **pas de langue** : la
  langue choisie au menu ≡ ne vit que dans le navigateur
  (`shared/README-ui-v5.md`, « ce qui reste à brancher »).
- **Aucune dépendance push** dans `package.json`, aucune table d'abonnement.
- **Le retour au bon écran après une reconnexion n'existe pas** :
  `components/auth-guard.js` renvoie vers la page de connexion sans dire d'où
  on venait (§9.7).

## 2. Ce que permettent les téléphones (vérifié le 6 novembre 2026)

**Android (Chrome)** : les notifications marchent dans l'appli installée comme
dans un simple onglet. Le navigateur demande la permission une fois.

**iPhone et iPad** :
1. Il faut **iOS/iPadOS 16.4 ou plus**, et l'appli **posée sur l'écran
   d'accueil, ouverte depuis son icône**. Dans Safari, en simple onglet, rien
   n'est possible.
2. La demande de permission doit suivre **un geste de l'hôte** (un bouton
   touché), jamais s'ouvrir toute seule.
3. **Un refus ne se rattrape pas dans l'appli** : il faut supprimer l'icône et
   reposer l'appli pour que la question revienne.
4. L'appli posée a **son propre stockage** : on s'y reconnecte une fois (déjà
   écrit au §6 du KB du lot 1).
5. **Chaque envoi doit afficher une notification.** Sinon, Safari supprime
   l'abonnement de lui-même. On n'envoie donc jamais rien d'invisible.
6. Depuis **iOS 18.4**, l'iPhone peut afficher la notification directement à
   partir du message reçu (*Declarative Web Push*). C'est plus fiable, et
   compatible avec les anciens téléphones.

**Ordinateur** : Chrome, Edge, Firefox, et Safari sur Mac (sans installation).

⚠ **Une notification n'est pas une garantie de réception** : un téléphone
éteint, une permission retirée, une appli supprimée. D'où l'e-mail du §6
quand le dernier appareil d'une personne disparaît.

Sources :
[WebKit — Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/),
[WebKit — nouveautés de Safari 18.4](https://webkit.org/blog/16574/digital-credentials-api/),
[Pushpad — exigences iOS](https://pushpad.xyz/blog/ios-special-requirements-for-web-push-notifications),
[OneSignal — web push pour iOS](https://documentation.onesignal.com/docs/en/web-push-for-ios),
[W3C — Push API](https://w3c.github.io/push-api/index.html).

## 3. Les quatorze événements

Tous sont réglables. Les quatre « interventions » d'aujourd'hui y sont
séparées (b, j, l, m). La colonne « urgent » donne la **liste par défaut**,
que chaque personne peut modifier (§4).

| # | Événement | Domaine du membre | Urgent par défaut |
|---|---|---|---|
| a | Surréservation | `reservations` en `write` (ceux qui peuvent acquitter) | oui |
| b | Urgence détectée par l'IA dans un message | `messages` | oui |
| c | Information manquante demandée par l'IA | `messages` | |
| d | Brouillon de l'IA en attente de validation | `messages` | |
| e | Nouveau message d'un voyageur | `messages` | |
| f | Nouvelle réservation (directe et OTA) | `reservations` | |
| g | Annulation ou modification d'une réservation | `reservations` | |
| h | Ménage sans personne (trou de garde) | `menages` | oui |
| i | Ménage « Pas vu » par la prestataire la veille | `menages` | |
| j | Code d'accès non résolu | `reservations` | oui |
| k | Pause automatique d'un bien | titulaire seul | |
| l | Ménage refusé par la prestataire | `menages` | |
| m | Disponibilités modifiées par une prestataire | `menages` | |
| n | Nouvel avis | `avis` | |

Deux conséquences à connaître :
- **h n'allait jusqu'ici qu'au fondateur**, et son SMS avait été coupé le
  17 septembre parce qu'il partait trop souvent. Il devient un événement de
  l'hôte, urgent par défaut. Le mode « urgence seulement » et le remplacement
  d'une notification par la suivante (§7) sont ce qui doit l'empêcher de
  redevenir du bruit.
- **f vaut aussi pour les réservations OTA**, que l'appli Airbnb ou Booking
  notifie déjà. Chacun peut le couper.

## 4. Le mode « urgence seulement »

1. **Chaque personne règle ses propres heures**, une ou plusieurs plages (par
   exemple la nuit et les heures de travail).
2. **Pendant une plage, passent quand même** :
   - un événement que la personne a gardé dans sa **liste des urgences**
     (par défaut a, b, h, j) ;
   - tout événement qui concerne une réservation dont **l'arrivée est
     aujourd'hui ou demain**, ou dont le **séjour est en cours**.
3. **Ce qui peut attendre part à la fin de la plage, regroupé** : un seul
   message par canal, qui liste ce qui s'est passé.
4. **Le même réglage vaut pour les trois canaux** : notification, e-mail et
   SMS.
5. **La surréservation peut sortir de la liste des urgences**, si la personne
   le choisit. Elle attend alors la fin de la plage comme le reste. Elle reste
   pourtant la seule alerte du produit qui ne se rattrape pas (deux voyageurs
   devant la même porte) : l'écran le dit au moment où on la décoche.
6. **Les contacts libres** (§5) suivent les heures **du titulaire**.
7. **Ce qui ne change pas** : la nuit, un brouillon que l'hôte a modifié ne
   part pas chez le voyageur (décision 7 du chantier délai,
   `docs/kb/alertes.md`). Il **garde sa propre plage** : elle concerne l'envoi
   au voyageur, pas le dérangement de l'hôte.

**À coordonner** : le fil messagerie tient le chantier « délai de réponse
IA ». Son lot 3 devait brancher la sourdine de l'alerte « info manquante ».
Cette alerte suit désormais le mode urgence ; seule la décision 7 garde
`delais.sourdine`. Il ne faut donc pas construire deux sourdines.

## 5. Qui reçoit

- **Le titulaire et les membres, chacun selon ses droits** : le domaine de
  l'événement (§3) au moins en `read`, et le bien dans son périmètre. Le droit
  est **revérifié au moment de l'envoi** : un membre qui perd un domaine ne
  reçoit plus rien de ce domaine.
- **La surréservation** va au titulaire et aux membres qui peuvent
  l'acquitter (`reservations` en `write` sur le bien).
- **La pause automatique (k)**, qui n'a pas de domaine, va au titulaire seul.
- **Un membre de plusieurs comptes** reçoit les notifications de tous ses
  comptes ; chaque notification nomme le compte et le bien.
- **Les contacts libres** restent possibles : un numéro ou un e-mail hors
  compte (un gardien, par exemple), **pour des biens choisis**. Ils reçoivent
  l'e-mail et le SMS, jamais de notification (ils n'ont pas d'appareil
  abonné). Les listes actuelles d'`agent_alert_config` deviennent ces
  contacts, avec leurs biens : personne ne perd ses destinataires.
- **Les accès par lien** (les prestataires) ne reçoivent jamais rien par ce
  canal. Leurs notifications viendront avec l'appli prestataire, au lot 3.

## 6. La configuration, dans `/settings`

- **Un tableau par personne** : les quatorze événements en lignes ; en
  colonnes, la notification, l'e-mail, le SMS, et « urgent ». **Le même pour
  tous les biens** : pas de réglage par bien, sauf pour les contacts libres.
- **Les heures du mode urgence**, plage par plage.
- **Les contacts libres** du compte, avec leurs biens (réglés par le
  titulaire).
- **Les appareils abonnés** de la personne, chacun avec son nom (« iPhone de
  Thierry ») et un bouton pour le retirer.
- **« Recevoir les notifications sur cet appareil »** : le bouton qui abonne
  l'appareil, et un bouton « m'envoyer un essai ». Sur iPhone, il n'apparaît
  que dans l'appli posée sur l'écran d'accueil. Dans Safari, il est remplacé
  par une phrase qui explique comment poser l'appli. Le guide
  (`pages/guide.html`) l'explique aussi.
- **La notification remplace le SMS** : une personne qui a au moins un
  appareil abonné ne reçoit plus de SMS, quel que soit l'événement. Son
  e-mail continue selon son réglage.
- **Quand le dernier appareil abonné d'une personne disparaît** (appli
  supprimée, permission retirée), elle est **prévenue par e-mail**. Sinon,
  elle croirait être prévenue alors qu'elle ne l'est plus, et ses SMS ne
  partent plus.
- **La déconnexion désabonne l'appareil**, côté téléphone et côté serveur. Une
  autre personne qui se connecte sur l'appareil le désabonne aussi pour
  l'ancienne. C'est une règle de sécurité : un téléphone prêté ne doit pas
  continuer de recevoir les notifications du compte d'avant.

## 7. Ce que dit la notification

- **Le bien et le prénom du voyageur** sur l'écran verrouillé, jamais le texte
  du message. Par exemple : « Nouveau message de Marie — La bulle ».
- **Au toucher**, la notification ouvre le bon écran (par exemple le bon fil de
  `/messages`). Si la session a expiré, l'hôte se reconnecte puis arrive sur
  cet écran.
- **Pas de chiffre sur l'icône** de l'appli.
- **Une notification sur le même sujet remplace la précédente** au lieu de
  s'empiler. Exception : chaque relance de la surréservation (toutes les ~45
  minutes) sonne de nouveau.
- **Dans la langue de la personne** (français, anglais ou espagnol). La langue
  doit pour cela être enregistrée sur le profil (§9.13). Faute de langue
  connue, c'est le français.

## 8. Les clés d'envoi

- Une **paire de clés** signe chaque envoi. La clé publique n'est pas secrète.
  **La clé privée est un secret** : elle ne s'affiche jamais.
- **Deux paires**, une pour la production et une pour staging.
- **Elles arrivent dans Vercel par un petit script que Thierry lance une fois
  sur son PC**, guidé pas à pas. Le script génère les clés et les écrit
  directement dans les variables Vercel, sans rien afficher. Aucun secret ne
  passe par la conversation.
- **Adresse de contact** exigée par Apple : l'e-mail fondateur déjà configuré
  (`FOUNDER_EMAIL`).
- **Changer de clé désabonne tout le monde** : chaque appareil devra se
  réabonner. Si la clé privée fuyait, c'est pourtant ce qu'il faudrait faire
  (§9.10).
- **La même paire servira à l'appli prestataire** au lot 3, qui vit sur le
  même site.

## 9. Architecture (technique)

1. **Table `push_abonnements`** (migration : staging d'abord, la production
   sur go). Elle stocke l'utilisateur, l'adresse d'envoi, les clés du
   navigateur, le libellé de l'appareil, les dates de création et du dernier
   envoi réussi.
   - **L'adresse d'envoi est unique** : un nouvel abonné sur le même appareil
     prend la ligne, et l'ancien ne reçoit plus rien.
   - **Plafond** : 10 appareils par utilisateur.
   - **Un seul module écrit** dans cette table, `lib/push/abonnements.js`. La
     RLS ne permet aucune écriture depuis le navigateur ; en lecture, chacun ne
     voit que ses propres lignes.
2. **Endpoint `/api/push`** : s'abonner (POST), se désabonner (DELETE),
   « m'envoyer un essai » (POST), et la clé publique (GET).
   - La garde est l'utilisateur connecté, sur ses propres abonnements.
   - `private, no-store` est posé avant le premier refus, 405 compris. Seule
     la clé publique est servie en public.
   - **L'adresse d'envoi est validée à chaque écriture** (abonnement comme
     renouvellement) : `https` obligatoire, et seulement les services connus
     (Google `fcm.googleapis.com`, Apple `*.push.apple.com`, Mozilla
     `updates.push.services.mozilla.com`, Microsoft `*.notify.windows.com`).
     Le nom d'hôte est lu par `new URL()` et comparé exactement, ou par
     suffixe avec son point.
3. **Envoi `lib/push/envoyer.js`.** La signature (RFC 8292) et le chiffrement
   (RFC 8291) viennent de la bibliothèque `web-push`, par sa fonction
   `generateRequestDetails()`, qui prépare la requête sans l'envoyer. C'est
   une seule dépendance ajoutée, sans code de chiffrement à maintenir. **L'envoi
   lui-même passe par `fetch`**, donc il est compté par le compteur de coût du
   cron (`docs/kb/cout-du-cron.md` §2), avec `redirect: 'error'` et un délai
   maximal de 5 secondes. Un 404 ou un 410 supprime l'abonnement.
4. **Le message suit le format déclaratif** :
   `{"web_push": 8030, "notification": {title, body, navigate, tag, …}}`,
   **jamais `mutable: true`**. L'iPhone 18.4+ l'affiche lui-même, sans
   consulter le service worker. L'adresse `navigate` est donc **construite par
   le serveur**, en chemin relatif du site, jamais à partir d'une donnée du
   voyageur. `tag` porte le sujet (§7). La surréservation porte en plus
   `renotify`.
5. **Le service worker** gagne trois écouteurs :
   - `push`, qui affiche **toujours** une notification ;
   - `notificationclick`, qui ouvre l'écran visé, jamais hors du site ;
   - `pushsubscriptionchange`, qui réabonne le navigateur mais **n'écrit rien
     côté serveur** (le service worker n'a pas de session). C'est la page qui,
     à la prochaine ouverture, envoie le nouvel abonnement par le même POST et
     les mêmes contrôles.

   Ce qui change exprès : les deux tests de `tests/pwa-service-worker.test.js`
   (l. 348 et l. 426), le motif qui interdit `showNotification`, l'en-tête du
   service worker (l. 25) et le §2.7 du KB du lot 1. Un test neuf refuse un
   `push` qui n'afficherait rien.
6. **Les destinataires se calculent depuis les profils et les droits**, plus
   les contacts libres.
   - La garde à l'envoi reprend les contrôles de `dansPerimetre` et
     `niveauEffectif` (`lib/permissions.js`) : profil actif, invitation
     acceptée, membre égal à l'abonné, domaine de l'événement (§3), bien dans
     le périmètre.
   - Elle exclut les accès par lien. Un événement sans domaine (k) ne part
     qu'au titulaire.
   - Le point d'envoi se branche sur l'émetteur de chaque événement, avec un
     **motif** propre à chacun (b, j, l, m séparés). Un seul module décide,
     pour chaque destinataire, des canaux et du moment. Le SMS est sauté pour
     une personne qui a un appareil abonné.
7. **Le retour au bon écran** : `components/auth-guard.js` transmet l'adresse
   demandée à la page de connexion (`next`). `pages/login.html` la lit et la
   contrôle déjà : chemin du site seulement.
8. **L'ordre à l'abonnement**, pour l'iPhone : d'abord la permission, dans le
   geste ; puis la clé publique ; puis l'abonnement ; puis l'enregistrement
   côté serveur.
9. **La déconnexion** appelle `subscription.unsubscribe()` dans le navigateur
   **même si** l'appel au serveur échoue (session expirée, appareil hors
   ligne). Le service d'envoi répondra ensuite 404 ou 410, et le serveur
   nettoiera la ligne. **À la connexion**, si l'appareil porte un abonnement
   enregistré pour un autre utilisateur, il est désabonné.
10. **Un changement de clé** vide la table des abonnements de cet
    environnement. À l'ouverture, la page compare la clé de l'abonnement de
    l'appareil à la clé publique servie : si elles diffèrent, elle désabonne,
    puis réabonne.
11. **Le mode « urgence seulement »** :
    - **une seule règle de calcul des plages**, dans un module commun : celle
      de `lib/guestflow/sourdine.js` (plage `[début, fin[`, instants injectés,
      changements d'heure éprouvés, fuseau `Europe/Paris` en V1), généralisée
      à plusieurs plages par personne, et non recopiée ;
    - à chaque événement et pour chaque destinataire, une seule décision :
      « part maintenant » ou « attend la fin de la plage ». Elle lit la liste
      des urgences de la personne et, dans le cœur (`bookings_snapshot`), les
      dates de la réservation concernée ;
    - ce qui attend va dans une **file d'attente en base**. Une passe du cron
      la vide à la fin de chaque plage, en un message regroupé par canal ;
    - `delais.sourdine` ne sert plus qu'à la décision 7 (§4.7).
12. **Les réglages** (tableau par personne, plages, contacts libres) vivent
    dans des tables à writer unique, lues par l'endpoint d'écran de
    `/settings`. Les listes d'`agent_alert_config` sont reprises en contacts
    libres à la migration, vérifiées par script (avant = après).
13. **La langue de la personne** : écrite quand la personne change de langue
    au menu ≡. Sans valeur, c'est le français. ⚠ **Pas sur `profiles`**, comme
    la première version de ce paragraphe le disait : `profiles` porte une ligne
    par couple (compte, membre), donc une personne membre de deux comptes en a
    trois. La langue est celle de la PERSONNE : elle vit dans la ligne de
    réglages de la personne (§15.1), une seule par utilisateur.
14. **Staging n'a pas de cron** (`docs/STAGING.md` §1) : en recette, les envois
    déclenchés par le cron se lancent à la main.

## 10. Case PERFORMANCE (CLAUDE.md, huit points)

1. **Endpoint d'écran** : `/settings` lit les réglages, les plages, les
   contacts et les appareils par **son** endpoint d'écran, en parallèle côté
   serveur. `/api/push` n'est appelé que sur un geste.
2. **Donnée non urgente** : sans objet, une notification est du temps réel. Le
   regroupé de fin de plage est calculé par le cron, jamais à l'ouverture d'un
   écran.
3. **Cache navigateur à clé compte** : aucun. Ni le service worker ni l'écran
   ne mettent de notification ou de réglage en cache.
4. **`private, no-store`** : sur toute réponse de `/api/push` sauf la clé
   publique, et sur l'endpoint d'écran de `/settings`, posé avant le premier
   refus.
5. **Statiques** : sans changement. Le service worker reste revalidé à chaque
   déploiement (lot 1).
6. **Lecture tronquée** : les lectures d'abonnements, de destinataires et de la
   file d'attente se paginent par curseur dès qu'elles peuvent dépasser 1000
   lignes.
7. **Budget** : **zéro appel ajouté au chargement des autres pages.** L'état de
   l'appareil (abonné ou non) se lit dans le navigateur. Côté serveur, chaque
   envoi est un appel compté par le compteur du cron.
8. **Mesure avant/après**, au lot, sur staging : appels, requêtes Supabase et
   octets de `/settings` avant et après, taille de `/sw.js` (avant : 8 477
   octets), et durée d'une passe de cron avec et sans envoi.

## 11. Inventaire (la forme ne supprime jamais le fond)

- **E-mail d'alerte** : conservé, désormais réglé par personne et par événement.
- **SMS d'alerte** : conservé pour qui n'a pas d'appareil abonné et pour les
  contacts libres ; remplacé par la notification sinon (décision du
  7 novembre).
- **Alarme de surréservation** : conservée (relances toutes les ~45 min,
  acquittement), avec la notification qui sonne de nouveau à chaque relance.
- **Listes d'`agent_alert_config`** : reprises en contacts libres, avec leurs
  biens.
- **Bloc « Alertes » du tiroir de Messages** : **déplacé** dans `/settings`
  (accord de Thierry du 7 novembre).
- **`delais.sourdine`** : conservé pour la décision 7 seulement.
- **`lib/guestflow/sourdine.js`** : généralisé en module commun, sans
  changement de ses garanties.
- **Événement h** : il ne va plus au fondateur seul, il devient un événement de
  l'hôte. `reportIncident` reste pour le fondateur.
- **Service worker du lot 1** : ses règles sont conservées, et trois écouteurs
  s'ajoutent. Son en-tête (l. 25) et le §2.7 du KB sont réécrits.
- **Tests « aucune notification push »** : remplacés exprès (§9.5).
- **`components/auth-guard.js`** : complété (retour au bon écran).
- **`pages/guide.html`** : complété (installer l'appli et s'abonner sur
  iPhone).
- **`package.json`** : une dépendance ajoutée, `web-push`.
- **Appli prestataire** : non touchée dans ce lot (dette 130 inchangée).

## 12. Tests et recette

- **Service worker** :
  - il affiche toujours une notification ;
  - le clic ouvre l'écran visé, jamais hors du site ;
  - un abonnement renouvelé est renvoyé par la page, avec les mêmes contrôles.
- **Garde à l'envoi**, avec contre-épreuve à chaque fois. Rien ne part pour :
  - un membre sans le domaine ;
  - un bien hors de son périmètre ;
  - un profil désactivé ;
  - une invitation non acceptée ;
  - un accès par lien ;
  - un événement sans domaine envoyé à un membre ;
  - l'ancien abonné d'un appareil passé à un autre utilisateur.
- **Mode urgence** :
  - un événement non urgent pendant une plage attend, puis part regroupé à la
    fin ;
  - une urgence passe ;
  - une arrivée aujourd'hui ou demain, ou un séjour en cours, passe ;
  - plusieurs plages, et les deux changements d'heure ;
  - les contacts libres suivent les heures du titulaire ;
  - la décision 7 garde sa propre plage.
- **Canaux** :
  - le SMS est sauté pour une personne qui a un appareil abonné ;
  - la disparition du dernier appareil déclenche l'e-mail.
- **Abonnements** :
  - un second abonné sur le même appareil prend l'abonnement ;
  - la déconnexion désabonne, y compris quand l'appel au serveur échoue ;
  - la connexion d'un autre utilisateur désabonne l'ancien ;
  - un changement de clé réabonne l'appareil ;
  - un 410 supprime l'abonnement ;
  - une adresse d'envoi hors liste est refusée ;
  - le plafond de 10 tient.
- **Migration** : les listes d'`agent_alert_config` reprises en contacts
  libres, vérifiées par script (avant = après).
- **Envoi** :
  - les envois sont comptés par le compteur du cron ;
  - aucune clé privée dans le dépôt ni dans une réponse.
- **Recette Android** (Thierry, sur staging) :
  - s'abonner, recevoir l'essai, toucher la notification ;
  - régler une plage, vérifier qu'un événement non urgent attend la fin ;
  - se déconnecter, vérifier que plus rien n'arrive.
- **Recette iPhone** : **en une fois avec le point 2 reporté de la recette du
  lot 1** (installation sur iPhone).

## 13. Les décisions de Thierry (7 novembre 2026)

| | Question | Décision |
|---|---|---|
| Q1 | Quels événements ? | Les quatorze, réglables dans la configuration, pour la notification et l'e-mail |
| — | Ne pas déranger | Mode « urgence seulement » avec des heures |
| — | L'exception | Arrivée aujourd'hui ou demain, et séjour en cours |
| — | Hors heures | Envoyé à la fin de la plage, regroupé |
| Q16 | La liste des urgences | Par défaut a, b, h, j, modifiable par chacun |
| Q17 | La surréservation | Peut sortir de la liste |
| — | Les canaux du mode urgence | Notification, e-mail et SMS |
| Q18 | Les heures | Chaque personne les siennes, plusieurs plages possibles |
| Q19 | Le brouillon modifié la nuit | Garde sa propre plage |
| Q2 | Qui reçoit | Titulaire et membres selon leurs droits |
| Q2 bis | Plusieurs comptes | Tous ses comptes |
| Q3 | La surréservation va à | Titulaire et membres qui peuvent l'acquitter |
| Q4 | Le niveau de réglage | Par événement et par canal, le même pour tous les biens |
| Q5 | Où | `/settings` |
| Q20 | Le bloc « Alertes » de Messages | Déménage dans `/settings` |
| — | Les contacts libres | Gardés, pour des biens choisis, avec les heures du titulaire |
| Q6 | L'écran verrouillé | Le bien et le prénom |
| Q7 | La pastille sur l'icône | Non |
| Q11 | La notification remplace le SMS | Oui, toujours, quand un appareil est abonné |
| Q12 | Deux notifications sur le même sujet | La seconde remplace la première |
| Q13 | Le dernier appareil disparaît | Prévenir par e-mail |
| Q14 | La langue | Celle du profil |
| Q9 | Les clés | Script lancé par Thierry sur son PC ; contact : l'e-mail fondateur |
| Q10 | Les prestataires | Dans la foulée, au lot 3 |
| Q15 | La recette iPhone | Avec celle du lot 1, en une fois |

**Décisions du 7 novembre au soir (go du 2b) :**

| | Question | Décision |
|---|---|---|
| Q21 | Le message « notifications bloquées » | « Le plus simple et clair pour l'utilisateur » : le chemin exact pour son appareil (Android, iPhone, ordinateur), affiché dès l'ouverture de l'onglet, et un lien vers le guide |
| Q22 | Le guide | Complété dans le 2b : installer l'appli, activer les notifications, débloquer |
| Q23 | Les canaux par défaut | Notification et e-mail cochés, SMS décoché, pour les quatorze événements |
| Q24 | La livraison | 2b recetté sur staging seul ; la production reçoit 2b et 2c ensemble |

**Décisions du 8 novembre (spec du 2c, §16) :**

| | Question | Décision |
|---|---|---|
| Q25 | Ce que reçoivent les contacts libres | Comme aujourd'hui : chacun garde ce que sa liste recevait (les urgences b, j, l, m, o, et/ou l'info manquante c), pour ses biens |
| Q26 | Le SMS de la surréservation | Coché par défaut pour elle seule (il ne part que sans appareil abonné) — exception à Q23 |
| Q27 | « Évaluation du voyageur à faire », trouvée à l'inventaire | Quinzième événement (o), groupe Avis, notification et e-mail, non urgent |
| Q28 | L'e-mail du « Nouveau message d'un voyageur » | Décoché par défaut pour cet événement seul — exception à Q23 |

**Décisions du 9 novembre (2c-3, §16.3) :**

| | Question | Décision |
|---|---|---|
| Q29 | Une liste qui porte l'e-mail ou le numéro d'un MEMBRE (pas du titulaire) | Comme le titulaire si ses droits couvrent le domaine et le bien : le canal se coche dans ses réglages, pas de contact. Sinon il reste un contact libre — personne ne perd une alerte |
| Q30 | Se désinscrire, pour un contact libre | Un lien « Ne plus recevoir ces alertes » dans chaque e-mail ; un clic le retire, et le titulaire le voit dans Réglages. Rien dans le SMS |
| Q31 | La langue d'un contact libre | Celle du titulaire |
| Q32 | Le bouton « Tester » du bloc Alertes | Gardé : un essai par contact, au plus une fois par jour et par contact (pas de relais vers une adresse saisie) |

**Décisions du 10 novembre (2c-3, étape 3, §16.8) :**

| | Question | Décision |
|---|---|---|
| Q33 | Qui peut annuler la désinscription d'un contact | Le contact, par le même lien (« Recevoir à nouveau »), et le titulaire, par « Réinscrire » dans Réglages |
| Q34 | Où vit le bloc « Contacts prévenus » | Dans l'onglet Notifications de `/settings`, sous « Heures calmes » |
| Q35 | L'adresse d'un contact désinscrit change | Il repart inscrit : la nouvelle adresse ne s'est jamais désinscrite ; l'ancien lien cesse de marcher |
| Q36 | Ajouter (ou mettre) l'adresse de quelqu'un qui s'est désinscrit | L'écran prévient (« s'est désinscrite le … ; lui renvoyer vos alertes ? ») et le titulaire confirme |
| Q37 | La limite des essais | Une fois par jour et par adresse, même si le contact est retiré puis recréé ; dix essais par compte et par jour |
| Q38 | Un contact désinscrit à deux adresses : une seule change | Il repart inscrit, comme Q35 : une adresse qui change suffit |

## 14. Découpage proposé, et ce que le lot ne fait pas

**Découpage proposé** (un fil, une branche par sous-lot, chacun reviewé et
recetté) :
1. **2a — le socle** : table et endpoint d'abonnement, clés, service worker,
   bouton « cet appareil » et essai dans `/settings`. À la fin, on reçoit une
   notification d'essai. **En production le 7 novembre 2026, recette Android
   conforme.**
2. **2b — les réglages de la personne** (§15) : le tableau des quatorze
   événements, les heures du mode urgence, la règle de décision
   « maintenant ou fin de plage », la langue enregistrée, le message clair du
   blocage (Q21) et le guide. **Recetté sur staging seul** (Q24).
3. **2c — la bascule** : les contacts libres et la reprise des listes
   d'`agent_alert_config`, le déménagement du bloc « Alertes » de Messages, la
   file d'attente et sa passe de cron, les quatorze événements branchés un par
   un, le remplacement du SMS, l'e-mail du dernier appareil, et le retour au
   bon écran après reconnexion (`next`). **Part en production avec le 2b.**

**Pourquoi les contacts libres et le bloc « Alertes » sont passés au 2c**
(ajustement annoncé à Thierry le 7 novembre au soir) : tant que les alertes
partent par `agent_alert_config`, des contacts libres réglés dans `/settings`
ne feraient rien, et le bloc déménagé laisserait Messages sans réglage actif.
Ils n'ont de sens qu'avec la bascule. Comme 2b et 2c partent ensemble en
production, l'hôte ne voit jamais l'état intermédiaire.

**Q21, née de la recette du 2a — tranchée** (§13) : le 7 novembre, en
réabonnant son téléphone en production, Thierry a lu « Les notifications sont
bloquées pour HôteSmart sur cet appareil ». Le réglage Notifications de Chrome
pour le site (Paramètres des sites) bloquait, alors que les notifications de
l'appli installée étaient actives côté Android. Après réautorisation dans
Chrome, le réabonnement est passé ; la cause n'est pas établie (le code ne
touche pas à la permission). Le message donne désormais le chemin exact
(§15.6).

**Ce que le lot ne fait pas** :
- pas de notification marketing, ni rien vers les voyageurs ;
- pas de notification envoyée depuis un écran ouvert : seul le serveur envoie ;
- l'appli prestataire attend le lot 3 ;
- rien en production sans le go de Thierry : migration, clés, envoi réel.

## 15. Lot 2b — les réglages de la personne (détail)

Branche `pwa-lot-2b-reglages`, partie de `main` `019ae717`. Rien n'envoie
encore selon ces réglages : c'est le 2c qui branche les événements.

### 15.1 La donnée

- **Table `notifications_reglages`**, une ligne par personne (`user_id`, clé
  primaire, vers `auth.users`, supprimée avec elle) : `evenements` (jsonb),
  `plages` (jsonb), `langue` (`fr`, `en`, `es` ou vide), `maj_le`.
- **RLS active, aucune politique** : seule la clé de service lit et écrit,
  comme `push_abonnements`.
- **Un seul writer**, `lib/notifications/reglages.js`. Il valide tout à
  l'écriture : un code d'événement inconnu, un canal inconnu, une valeur qui
  n'est pas un booléen, une heure mal formée, une plage vide (début = fin),
  un jour hors de 1 à 7, plus de 6 plages : refusé en 400, rien n'est écrit.
- **Une personne sans ligne a les défauts** (Q23) : notification et e-mail
  cochés, SMS décoché, urgent pour a, b, h et j, aucune plage, français. La
  ligne ne s'écrit qu'au premier « Enregistrer ». Un événement ajouté plus
  tard au catalogue prend ses défauts chez tout le monde, sans migration.
- **Les mêmes réglages pour tous les comptes** d'une personne membre de
  plusieurs comptes : ses heures sont les siennes, pas celles d'un compte.

### 15.2 Le catalogue des quatorze événements

`lib/notifications/catalogue.js` : pour chacun, son code, son libellé, son
groupe à l'écran, son domaine de droits (§3) et s'il est urgent par défaut.
**C'est la seule liste** : l'écran la reçoit du serveur, il ne la recopie pas.

### 15.3 Les plages du mode urgence

`lib/notifications/plages.js`. **Une seule règle de calcul**, celle de
`lib/guestflow/sourdine.js` (`plageDeNuit`, `minutesDeLHeure`), réutilisée sans
la modifier : `[début, fin[`, fuseau `Europe/Paris`, changements d'heure déjà
éprouvés. Ce qui s'ajoute :
- **les jours** : une plage peut ne valoir que certains jours. Le jour est
  **celui où la plage commence** : la plage « 22:00 → 07:00, du lundi au
  vendredi » couvre la nuit du vendredi au samedi jusqu'à 7 h, et pas celle du
  samedi au dimanche ;
- **plusieurs plages** : l'instant est « en plage » s'il est dans l'une d'elles ;
- **les plages qui se suivent** : 22:00 → 07:00 puis 07:00 → 09:00 font une
  seule attente, jusqu'à 9 h. La fin retenue est le premier instant qui n'est
  dans aucune plage.

### 15.4 La décision « maintenant ou fin de plage »

`lib/notifications/decision.js`, sans base ni horloge lue : tout entre en
paramètre (l'événement, les réglages, l'instant, le séjour concerné). Pour
chaque canal coché :
1. hors plage → **maintenant** ;
2. événement dans la liste des urgences de la personne → **maintenant** ;
3. séjour dont l'arrivée est **aujourd'hui ou demain**, ou **en cours** →
   **maintenant**. « En cours » va de l'arrivée au départ, **jour du départ
   compris** : le matin du départ, le voyageur est encore là. Les jours sont
   ceux de Paris ;
4. sinon → **à la fin de la plage** (§15.3).

Un canal décoché ne part jamais. Le 2c lira le séjour dans le cœur
(`bookings_snapshot`) et rangera « fin de plage » dans la file d'attente.

### 15.5 L'endpoint

`/api/push` reste le seul endpoint de l'onglet Notifications :
- **GET** rend en plus `evenements` (le catalogue fusionné avec les réglages de
  la personne), `plages` et `langue` ;
- **POST `action: 'reglages'`** enregistre le tableau et les plages ;
- **POST `action: 'langue'`** enregistre la langue.

La garde est la session : chacun lit et écrit **ses** réglages, jamais ceux
d'un autre (aucun identifiant de personne n'est accepté dans le corps).

### 15.6 L'écran `/settings`, onglet Notifications

- **« Quand vous prévenir »** : les quatorze événements par groupe
  (Réservations, Messages, Ménages, Avis), quatre cases par ligne :
  Notification, E-mail, SMS, Urgent. Une phrase dit que chacun ne reçoit que
  ce que ses droits permettent.
- **« Heures calmes »** : les plages, chacune avec son début, sa fin et ses
  jours, un bouton pour la retirer, « Ajouter une plage ». Sans plage, tout
  arrive tout de suite. Une phrase dit ce qui passe quand même (les urgences,
  et les séjours qui arrivent aujourd'hui ou demain ou sont en cours).
- **Un seul bouton « Enregistrer »** pour les deux.
- **Décocher « Urgent » sur la surréservation**, ou tous ses canaux, demande
  une confirmation qui dit pourquoi : c'est la seule alerte qui ne se
  rattrape pas (§4.5).
- **Le blocage (Q21)** : dès l'ouverture de l'onglet, si la permission est
  refusée, l'état le dit avec le chemin exact de l'appareil, et un lien vers
  le guide :
  - Android : Chrome → ⋮ → Paramètres → Paramètres des sites → Notifications
    → le site → Autoriser ;
  - iPhone : Réglages → Notifications → HôteSmart → Autoriser les
    notifications ; s'il n'y figure pas, supprimer l'icône, reposer l'appli et
    accepter ;
  - ordinateur : l'icône à gauche de l'adresse → Notifications → Autoriser.

### 15.7 La langue

Le sélecteur de langue du menu ≡ (`shared/nav.js`) enregistre la langue
choisie, **seulement sur ce geste** : aucun appel ajouté au chargement d'une
page.

### 15.8 Le guide

`pages/guide.html` gagne une section « L'appli sur votre téléphone » :
l'installer (iPhone, Android), activer les notifications, débloquer, et ce que
font les heures calmes.

### 15.9 Case PERFORMANCE du 2b

1. Endpoint d'écran : `/api/push` GET pour l'onglet, deux lectures en
   parallèle côté serveur (appareils, réglages).
2. Donnée non urgente : sans objet (des réglages, pas un calcul).
3. Cache navigateur : aucun.
4. `private, no-store` : inchangé, posé avant le premier refus.
5. Statiques : sans changement.
6. Lecture tronquée : une ligne par personne, sans objet.
7. Budget : zéro appel ajouté au chargement des autres pages ; l'onglet garde
   un seul appel à l'ouverture, « Enregistrer » en fait un.
8. Mesure avant/après : §15.10, mesurée au lot.

### 15.10 Mesures (8 novembre 2026, sur la branche, contre `main` `019ae717`)

| | Avant (2a) | Après (2b) |
|---|---|---|
| Appels à l'ouverture de l'onglet | 1 (GET `/api/push`) | 1 (le même) |
| Requêtes Supabase de ce GET | 1 (appareils) | 2, en parallèle (appareils, réglages) |
| Octets de la réponse (personne sans appareil, défauts) | 133 | 2 428 |
| Appels sur « Enregistrer » | — | 1 (POST `reglages`) |
| Appels ajoutés au chargement des autres pages | — | 0 (la langue part sur le geste seulement ; tenu par `tests/notifications-ecran.test.js`) |
| `pages/settings.html` | 40 902 octets | 52 501 |
| `shared/push-appareil.js` | 8 989 | 10 342 |
| `shared/nav.js` | 12 727 | 13 024 |
| `shared/langue-personne.js` (chargé au geste seulement) | — | 1 144 |

Les octets de la page comptent ses commentaires ; aucune ressource n'est
ajoutée à son chargement.

## 16. Lot 2c — la bascule des alertes (proposition, 8 novembre 2026)

Le 2c fait partir les quatorze événements selon les réglages du 2b. Il part en
production **avec** le 2b (Q24). Branche à créer depuis `main`.

### 16.1 Ce qui part aujourd'hui, et d'où (inventaire mesuré sur `main` `13ec5926`)

| | Événement | Émetteur aujourd'hui | Ce qui part aujourd'hui, et à qui |
|---|---|---|---|
| a | Surréservation | `lib/cron-overbooking.js` | SMS (clé Brevo de l'hôte) + e-mail au **titulaire**, toutes les ~45 min jusqu'à l'acquittement ; copie fondateur |
| b | Urgence de l'IA | `lib/cron-classify.js` → `sendAlertNotifications` | SMS + e-mail aux **listes** d'`agent_alert_config` (par bien, type `intervention`) |
| c | Information manquante | `lib/cron-classify.js`, `lib/guestflow/brouillons-dus.js` | idem, type `info_unknown`, avec le délai et la sourdine de GuestFlow |
| d | Brouillon à valider | — | rien (visible dans Messages) |
| e | Message d'un voyageur | — | rien |
| f | Nouvelle réservation | `lib/booking-changes-dispatch.js` → `consommateurNotifHote` | e-mail au titulaire, **réservations directes seulement** |
| g | Annulation ou modification | — | rien |
| h | Ménage sans personne | `lib/cleaning/sync-menages-entite.js` | incident **fondateur** seul (`menage_non_assigne`) |
| i | Ménage « Pas vu » | `lib/cleaning/relance-validation.js` | rien chez l'hôte (alerte à l'écran) ; SMS à la prestataire |
| j | Code d'accès non résolu | `lib/cron-access.js`, `lib/cron-arrival-code.js` → `alertMissingAccessCode` | tâche à l'écran + les listes d'`agent_alert_config` |
| k | Pause automatique | `lib/cron-alerting.js` | incident fondateur ; e-mail à l'hôte (`docs/kb/alertes.md` §3) |
| l | Ménage refusé | `api/menages-public.js` → `alertMenageRefuse` | tâche à l'écran + les listes |
| m | Disponibilités modifiées | `api/menages-public.js` → `alertReglesModifiees`, `alertPlageModifiee` | tâche à l'écran + les listes |
| n | Nouvel avis | — | rien |
| **o** | **Évaluation du voyageur à faire** (la prestataire a rempli l'état du logement ; relances J-5 et J-1) | `lib/avis/notifications.js` → `sendAlertNotifications` | tâche à l'écran + les listes. **Absent des quatorze** : trouvé à l'inventaire du 2c |

**Les listes d'`agent_alert_config` reçoivent donc aujourd'hui** : celle de type
`intervention` → b, j, l, m et o ; celle de type `info_unknown` → c.

Les points exacts de branchement de d, e, g, i et n se fixent au lot ; ils
viennent tous du cœur (règle « le cœur de données d'abord »), jamais d'un appel
au provider.

### 16.2 La pièce centrale : un seul point d'envoi

`lib/notifications/notifier.js`, appelé par chaque émetteur avec : le compte, le
code de l'événement, le bien, la réservation concernée s'il y en a une, et le
contenu (titre, texte court, écran à ouvrir, sujet).

Pour chaque événement :
1. **Les destinataires** : le titulaire et les membres qui ont le domaine de
   l'événement sur ce bien (§5), revérifiés à l'envoi ; puis les contacts
   libres du bien.
2. **Pour chaque personne**, la décision du 2b (`decision.js`), avec le séjour
   lu dans `bookings_snapshot`.
3. **Maintenant** : la notification sur ses appareils ; l'e-mail (clé
   plateforme) ; le SMS (clé Brevo du compte) **seulement si elle n'a aucun
   appareil abonné** (Q11).
4. **Fin de plage** : une ligne dans une **file d'attente**
   (`notifications_file`). Une passe du cron la vide à la fin de chaque plage :
   un seul message regroupé par personne et par canal.
5. **Le contenu dans la langue de la personne** (fr, en, es), le bien et le
   prénom du voyageur, jamais le texte de son message (§7).
6. **Le dernier appareil** : quand un envoi trouve le dernier appareil d'une
   personne mort (404 ou 410), elle reçoit un e-mail (Q13).

Les anciens envois (`sendAlertNotifications`, les SMS de `cron-overbooking`,
`notifierNouvelleResa`) passent par ce point ; ce qui va au fondateur
(`reportIncident`) ne change pas.

### 16.3 Les contacts libres

- **Une table `notifications_contacts`** : le compte, un nom, un e-mail et/ou un
  numéro, les biens, et ce qu'il reçoit — les urgences (b, j, l, m, o) et/ou
  l'info manquante (c), comme ses listes d'aujourd'hui (Q25). Réglés par le
  titulaire dans `/settings`. Ils suivent les heures du titulaire, et ne
  reçoivent jamais de notification (pas d'appareil).
- **La reprise d'`agent_alert_config`** (listes `sms_lines` et `email_lines`,
  par bien et par type) est faite par un script, vérifié avant = après :
  personne ne perd un destinataire.
  - **Une ligne qui porte l'e-mail ou le numéro du titulaire lui-même** ne
    devient pas un contact : elle coche le canal correspondant dans SES
    réglages, sinon il recevrait tout en double.
- **Les réglages de GuestFlow restent dans `agent_alert_config`** : le délai
  d'alerte et la sourdine (`delais`) appartiennent à Messages. Seules les
  listes de destinataires déménagent.

- **Décisions du 9 novembre** (Q29 à Q32, §13) : un membre listé reçoit par
  ses réglages si ses droits suffisent, sinon il reste contact ; un lien de
  désinscription dans chaque e-mail ; la langue du titulaire ; un essai par
  contact, une fois par jour au plus.

### 16.4 Le bloc « Alertes » du tiroir de Messages

Il déménage dans `/settings` (Q20). Dans Messages, il est remplacé par un lien
« Qui est prévenu → Réglages ». **À coordonner avec le fil messagerie**, qui
tient `pages/messages.html` et `api/agent-config.js`.

### 16.5 Le retour au bon écran

`components/auth-guard.js` passe l'adresse demandée à la page de connexion
(`next`) : une notification touchée avec une session expirée ramène sur son
écran après la connexion.

### 16.6 Ce que les décisions du 8 novembre changent au 2b

Elles touchent le catalogue (`lib/notifications/catalogue.js`), donc les
défauts de chacun, et se codent au 2c-1 :
- **quinze événements** : `evaluation_voyageur` (o) rejoint le groupe Avis ;
- **des canaux par défaut par événement** : Q23 reste la règle (notification et
  e-mail, pas de SMS), avec deux exceptions — le SMS de la surréservation
  (Q26) et l'e-mail du message d'un voyageur (Q28) ;
- personne n'a encore de réglage en production : aucune migration de données.

### 16.7 Découpage

Chaque sous-lot a sa branche, sa review et sa recette sur staging ; la
production reçoit 2b et tout le 2c ensemble. **Les branches du 2c partent de
`pwa-lot-2b-reglages`** (elle-même partie de `main`) : le 2b doit passer avant
elles.
1. **2c-1 — le point d'envoi** : `notifier.js`, la file d'attente et sa passe de
   cron, les textes en trois langues, le dernier appareil, `next`. Branché sur
   un seul événement (a, la surréservation), pour l'éprouver de bout en bout.
2. **2c-2 — les treize autres événements**, un par un.
3. **2c-3 — les contacts libres**, la reprise d'`agent_alert_config` et le
   déménagement du bloc « Alertes ».

### 16.8 Étape 3 du 2c-3 — le bloc « Contacts prévenus » (10 novembre 2026)

**Ce que voit le titulaire** (onglet Notifications, sous « Heures calmes »,
Q34) — seulement s'il a des biens : un membre sans bien à lui ne le voit pas.
- La liste de ses contacts : nom, e-mail et/ou numéro, ses biens, ce qu'il
  reçoit (« Urgences », « Info manquante ») ; un contact désinscrit le dit,
  avec sa date, et porte « Réinscrire » (Q33).
- Pour chacun : « Modifier », « Retirer » (avec confirmation), « Envoyer un
  essai » — une fois par jour au plus (Q32), refusé pour un contact
  désinscrit ; le bouton dit quand il redevient possible.
- « Ajouter un contact » : nom, e-mail, numéro (l'un des deux au moins), les
  biens, les alertes. Sans compte Brevo connecté, une phrase dit que les SMS
  ne partent pas, avec le lien vers Connexions (la porte Brevo de l'ancien
  tiroir).
- Une phrase dit que ces contacts suivent ses heures calmes, reçoivent dans
  sa langue, et peuvent se désinscrire par le lien de chaque e-mail.

**L'endpoint** : `/api/push`, l'endpoint de l'onglet. GET rend en plus
`contacts` (la liste, ses biens, la porte Brevo) quand l'appelant a des
biens ; POST `contact_creer`, `contact_modifier`, `contact_retirer`,
`contact_reinscrire`, `contact_essai`. **La garde est la session : le compte
est toujours celui de l'appelant**, aucun identifiant de compte n'est accepté ;
un contact d'un autre compte rend « introuvable » ; chaque bien est relu sur
le compte. Le jeton de désinscription ne sort jamais vers l'écran.

**La page de désinscription** : `/api/alertes-desinscription?jeton=…`,
publique, sans session. GET montre l'adresse masquée, les biens concernés et
UN bouton — « Ne plus recevoir ces alertes », ou « Recevoir à nouveau » si
c'est déjà fait (Q33) ; POST fait le geste. Deux clics parce que les
messageries d'entreprise ouvrent les liens d'un e-mail pour les inspecter : un
GET ne change jamais rien. Dans la langue du titulaire (Q31), `no-store`,
non indexée, sans script.

**Inventaire** (règle « la forme ne supprime jamais le fond ») — le bloc
« Alertes » du tiroir de Messages (`voletAlertes`, pages/messages.html) :
| Ce qu'il porte | Où ça va |
|---|---|
| Deux types × deux canaux, par bien | Conservé : un contact porte ses alertes et ses biens ; le canal est son e-mail et/ou son numéro |
| Les destinataires « Nom : valeur », une ligne chacun | Conservé : un contact par personne, nom et adresse séparés |
| La porte Brevo (SMS fermé sans clé, lien Connexions) | Conservé (phrase + lien) |
| « Tester » par canal, après enregistrement | Conservé : « Envoyer un essai » par contact, une fois par jour (Q32) |
| Champs grisés pendant un changement de mode | Retiré avec raison : il protégeait l'écriture conjointe du mode et des listes dans le même tiroir ; les contacts ne s'écrivent plus là |
| L'adresse du titulaire dans sa propre liste | Déplacé : ses réglages (§16.3) |
Le tiroir lui-même est l'étape 4 (lien « Qui est prévenu → Réglages »).

**Case PERFORMANCE de l'étape 3 :**
1. Endpoint d'écran : `/api/push` GET, ses lectures en parallèle côté serveur
   (appareils, réglages, biens, contacts, porte Brevo).
2. Donnée non urgente : sans objet (une liste réglée par le titulaire).
3. Cache navigateur : aucun.
4. `private, no-store` : inchangé, avant le premier refus ; la page de
   désinscription aussi.
5. Statiques : sans changement.
6. Lecture tronquée : plafond de 100 contacts par compte, lu à 101 pour le
   savoir ; au-delà, l'écran le dit.
7. Budget : zéro appel ajouté à l'ouverture de l'onglet (le GET existant) ;
   chaque geste fait un appel et rend la liste à jour.
8. Mesure avant/après : appels, requêtes et octets du GET de l'onglet,
   mesurés au lot (KB pwa §12.3).

