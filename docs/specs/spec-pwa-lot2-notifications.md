# Spec — PWA lot 2 : les notifications push de l'appli hôte

**Statut : décisions produit prises par Thierry le 7 novembre 2026 (§13).
Aucune ligne de code n'est écrite.** La spec a passé deux reviews avant ces
décisions : la première a trouvé 5 constats de sécurité et 2 bloquants ; la
seconde, la dernière, a vérifié leur correction.

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
13. **La langue sur le profil** : une colonne sur `profiles`, écrite quand la
    personne change de langue au menu ≡. Sans valeur, c'est le français.
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

## 14. Découpage proposé, et ce que le lot ne fait pas

**Découpage proposé** (un fil, une branche par sous-lot, chacun reviewé et
recetté) :
1. **2a — le socle** : table et endpoint d'abonnement, clés, service worker,
   bouton « cet appareil » et essai dans `/settings`. À la fin, on reçoit une
   notification d'essai.
2. **2b — la configuration** : le tableau par personne, les plages, le mode
   urgence et sa file d'attente, les contacts libres, la migration des listes
   d'`agent_alert_config`, le déménagement du bloc « Alertes » de Messages, la
   langue sur le profil.
3. **2c — les quatorze événements** branchés un par un, avec le remplacement
   du SMS et l'e-mail du dernier appareil.

**Ce que le lot ne fait pas** :
- pas de notification marketing, ni rien vers les voyageurs ;
- pas de notification envoyée depuis un écran ouvert : seul le serveur envoie ;
- l'appli prestataire attend le lot 3 ;
- rien en production sans le go de Thierry : migration, clés, envoi réel.
