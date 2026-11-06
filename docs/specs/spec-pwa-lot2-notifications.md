# Spec — PWA lot 2 : les notifications push de l'appli hôte

**Statut : brouillon du 6 novembre 2026, à valider par Thierry. Aucune ligne de
code n'est écrite.** Chaque choix produit est posé en question (Q1 à Q10,
récapitulées au §12) et n'est pas tranché ici. Les propositions techniques du
§8 sont à valider aussi. KB du lot 1 : `docs/kb/pwa.md`.

## 0. Ce que le lot ajoute, et ce qu'il ne change pas

- **Un canal de plus.** La notification push s'ajoute à l'e-mail et au SMS
  existants, elle n'en retire aucun. En particulier, l'alarme de surréservation
  garde son SMS toutes les ~45 minutes jusqu'à l'acquittement
  (`lib/cron-overbooking.js`, `docs/kb/alertes.md`).
- **L'appli hôte seulement.** L'appli prestataire (`apps/menages/`, son service
  worker `apps/menages/sw.js`) n'est pas touchée. Faut-il un jour des
  notifications push pour les prestataires ? C'est la question Q10, hors de ce
  lot.
- **Aucun écran n'est modifié sans l'accord de Thierry** : la refonte V5
  continue sur `pages/`, `apps/` et `shared/ui.css`. Le bouton d'abonnement
  (§5) devra vivre dans un écran : son emplacement est une question (Q5).

## 1. État des lieux (mesuré sur main `66495863`)

- **Service worker hôte** (`shared/pwa/service-worker.js`, servi à `/sw.js`) :
  trois écouteurs seulement, `install`, `activate`, `fetch`.
  `tests/pwa-service-worker.test.js` garantit qu'il n'y a aucune notification
  push. **Ce lot changera ce test exprès** (§8.5).
- **Ce qui prévient l'hôte aujourd'hui** :

  | Événement | Où il naît | Canal actuel |
  |---|---|---|
  | Surréservation | `lib/cron-overbooking.js` | SMS au titulaire toutes les ~45 min jusqu'à acquittement |
  | Intervention urgente détectée par l'IA | `lib/alert-notify.js` (type `intervention`) | e-mail et/ou SMS, réglés par bien dans `agent_alert_config` |
  | Information manquante demandée par l'IA | idem (type info manquante), avec délai et sourdine de nuit | idem |
  | Code d'accès non résolu, pause automatique d'un bien | `docs/kb/alertes.md` §2-3 | e-mail (SMS si l'hôte l'a activé) |
  | Nouvelle réservation **directe** | `lib/notif-hote-resa.js` (Offline seulement) | e-mail |
  | Ménage sans personne (trou de garde, jours non réglés) | `lib/cleaning/sync-menages-entite.js` (liste `alertes`) | alerte hôte (canal exact à relever au lot) |
  | Ménage « Pas vu » par la prestataire | `shared/menages-a-traiter.js` | à l'écran seulement (les relances SMS vont à la prestataire) |

- **Droits** (`lib/permissions.js`) : un titulaire (`is_owner`) et des membres,
  avec 8 domaines (`reservations`, `menages`, `prestataires`, `messages`,
  `avis`, `reglages`, `facturation`, `equipe`), chacun à `none`, `read` ou
  `write`, et un périmètre de biens.
- **Aucune dépendance push** dans `package.json`, aucune table d'abonnement.

## 2. Ce que permettent les téléphones (vérifié le 6 novembre 2026)

**Android (Chrome)** : la notification push marche dans l'appli installée comme
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
5. **Chaque push doit afficher une notification.** Sinon, Safari retire
   l'abonnement (« silent push penalties »). Donc jamais de push « silencieux ».
6. Depuis **iOS 18.4**, le *Declarative Web Push* affiche la notification
   décrite dans le message sans passer par le service worker. C'est plus
   fiable, et ça reste compatible : il suffit que le service worker sache lire
   et afficher le même format.

**Ordinateur** : Chrome, Edge, Firefox, et Safari sur Mac (sans installation).

**Conséquence technique, pas un choix produit** : tous les messages partent au
format déclaratif (§8.4), et le service worker affiche toujours une
notification pour chaque push reçu.

Sources :
[WebKit — Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/),
[WebKit — Safari 18.4](https://webkit.org/blog/16574/digital-credentials-api/),
[Pushpad — exigences iOS](https://pushpad.xyz/blog/ios-special-requirements-for-web-push-notifications),
[OneSignal — Web push pour iOS](https://documentation.onesignal.com/docs/en/web-push-for-ios).

## 3. Ce qui déclenche une notification — Q1

Les candidats, du plus urgent au moins urgent. **Thierry choisit ceux du
lot 2** ; les autres restent possibles plus tard.

| # | Événement | Temps réel ? | Remarque |
|---|---|---|---|
| a | Surréservation | oui | En plus du SMS, jamais à sa place |
| b | Intervention urgente détectée par l'IA | oui | 3ᵉ canal à côté de l'e-mail et du SMS de `agent_alert_config` |
| c | Information manquante demandée par l'IA | oui | Même réglage que b, même délai et même sourdine |
| d | Brouillon de l'IA en attente de validation (délai de réponse IA) | oui | Nouveau : aujourd'hui l'hôte le voit seulement à l'écran |
| e | Nouveau message d'un voyageur | oui | Airbnb et Booking le notifient déjà dans leurs applis : doublon possible |
| f | Nouvelle réservation | oui | Directe seulement (comme l'e-mail actuel), ou aussi OTA (doublon) ? |
| g | Annulation ou modification d'une réservation | oui | |
| h | Ménage sans personne (trou de garde) | oui | |
| i | Ménage « Pas vu » par la prestataire la veille | non | |
| j | Code d'accès non résolu, pause automatique d'un bien | oui | |
| k | Nouvel avis | non | |

Une boussole de CLAUDE.md s'applique : **une alerte qui crie pour rien finit
ignorée** (`docs/kb/alertes.md`, surréservation). Moins de types, mieux suivis,
vaut mieux qu'une liste complète.

## 4. Qui la reçoit — Q2, Q3

- **Q2 — les membres.** Trois possibilités :
  1. le titulaire seul ;
  2. titulaire et membres, chaque membre ne recevant que ce que ses droits lui
     montrent : domaine au moins en `read` (par exemple `messages` pour b, c,
     d, e ; `reservations` pour f, g ; `menages` pour h, i) **et** bien dans son
     périmètre ;
  3. comme 2, mais c'est le titulaire qui coche, membre par membre.

  Dans les cas 2 et 3, le droit est **revérifié côté serveur au moment de
  l'envoi**, pas seulement au réglage : un membre qui perd un domaine ne doit
  plus rien recevoir de ce domaine (règle « un masquage ne suffit jamais »).
- **Q3 — la surréservation.** Le titulaire seul, comme le SMS, parce que c'est
  lui qui acquitte ? Ou aussi les membres qui ont `reservations` ?
- **Q2 bis — plusieurs comptes.** Un membre peut appartenir à plusieurs
  comptes (le sélecteur de compte). Reçoit-il les notifications de tous ses
  comptes (la notification nommant alors le compte et le bien), ou seulement
  celles du compte choisi sur cet appareil ?

## 5. S'abonner, se désabonner — Q4, Q5

**La mécanique.** Un abonnement, c'est **un appareil et un navigateur, pour une
personne**. Le téléphone et l'ordinateur de l'hôte sont deux abonnements. Le
navigateur fournit une adresse d'envoi, gardée côté serveur.

- **Q4 — le niveau de réglage.** Trois possibilités :
  1. un seul interrupteur par appareil : « recevoir les notifications sur cet
     appareil » ;
  2. un interrupteur par type (Q1) ;
  3. par type et par bien, comme les e-mails et SMS d'aujourd'hui
     (`agent_alert_config`).
- **Q5 — où vit le bouton.** La règle de CLAUDE.md distingue la configuration
  d'une app (dans l'app) de la configuration générale (`/settings`). Le test
  qui tranche est le suivant : ce réglage a-t-il un sens si l'app n'existait
  pas ? « Cet appareil reçoit les notifications » est général, donc il irait
  dans `/settings`. Mais les types liés à une app (b, c, d par exemple)
  pourraient vivre dans l'app, à côté des alertes e-mail et SMS du tiroir de
  Messages. Cela touche des écrans de la refonte V5.
- **Se désabonner.** Un bouton sur l'appareil, et en plus :
  - **à la déconnexion**, l'abonnement de cet appareil est supprimé côté
    serveur. Sinon, un téléphone prêté ou partagé continuerait de recevoir les
    notifications du compte précédent. C'est l'équivalent de la règle « cache
    vidé à la déconnexion ». C'est une règle de sécurité, mais je la pose quand
    même en question : à confirmer ;
  - **un abonnement expiré** (le service d'envoi répond 404 ou 410) est
    supprimé à la première tentative d'envoi.
- **iPhone** : le bouton n'apparaît que dans l'appli posée sur l'écran
  d'accueil. Dans Safari, il est remplacé par une phrase qui explique comment
  poser l'appli.

## 6. Ce que dit la notification — Q6, Q7, Q8

- **Q6 — l'écran verrouillé.** Une notification s'affiche sur l'écran
  verrouillé et sur une montre. Jusqu'où va le détail ? Trois possibilités :
  1. « Nouveau message — La bulle » ;
  2. avec le prénom du voyageur ;
  3. avec le début du message.
- **Au toucher**, la notification ouvre le bon écran (par exemple `/messages`
  sur le bon fil). Si la session a expiré, l'hôte se reconnecte puis arrive à
  cet écran.
- **Q7 — la pastille sur l'icône.** Faut-il un chiffre sur l'icône de l'appli
  (par exemple le nombre « à traiter ») ? L'iPhone le permet pour l'appli
  posée sur l'écran d'accueil. Sur Android, c'est le lanceur qui décide : en
  général un simple point tant qu'une notification attend.
- **Q8 — la nuit.** La sourdine de nuit de GuestFlow existe déjà pour l'info
  manquante (`docs/kb/alertes.md`). Les notifications la suivent-elles ? La
  surréservation, elle, doit sonner la nuit comme le SMS. Le téléphone a aussi
  ses propres modes « Ne pas déranger ».
- **Regroupement.** Une notification du même sujet remplace la précédente au
  lieu de s'empiler (champ `tag`). C'est technique, sauf avis contraire.

## 7. Les clés d'envoi — Q9

Pour envoyer, le serveur signe chaque message avec une **paire de clés
« VAPID »** :
- **La clé publique** est donnée au navigateur lors de l'abonnement. Elle n'est
  pas secrète.
- **La clé privée est un secret.** Elle ne s'affiche jamais, ni dans un
  terminal, ni dans une réponse : elle s'écrit directement dans les variables
  Vercel. Il faudrait deux paires distinctes, une pour la production et une
  pour staging, pour qu'un abonnement de test ne puisse jamais recevoir un
  envoi de la production.
- **Changer de clé désabonne tout le monde** : chaque appareil devra se
  réabonner. La paire est donc posée une fois, puis on n'y touche plus.

**Q9 — comment les clés arrivent dans Vercel.** Je n'ai pas d'accès à Vercel
depuis le cloud, et Vercel ne sait pas générer ce type de clé lui-même. Deux
possibilités :
1. un jeton Vercel limité, donné au fil, qui génère les clés et les écrit
   directement dans les variables : c'est la même décision que celle
   qu'attend le chef de file pour observer le cron ;
2. un petit script que Thierry lance une fois sur son PC, guidé pas à pas : il
   génère les clés et les écrit directement dans Vercel, sans rien afficher.

Il faut aussi une adresse de contact (`mailto:`), exigée par le protocole :
laquelle ?

## 8. Architecture proposée (technique, à valider)

1. **Table `push_abonnements`** (migration : staging d'abord, la production
   sur go). Colonnes : utilisateur, adresse d'envoi, clés publiques du
   navigateur, appareil (libellé lisible), date de création, dernier envoi
   réussi, et les préférences de Q4. **Writer unique** :
   `lib/push/abonnements.js`. RLS : chacun ne lit que ses propres abonnements.
2. **Endpoint `/api/push`** : s'abonner (POST), se désabonner (DELETE),
   « m'envoyer un essai » (POST). Garde : l'utilisateur connecté, sur ses
   propres abonnements seulement. En-tête `private, no-store` posé avant le
   premier refus, 405 compris.
3. **Envoi `lib/push/envoyer.js`** : signature VAPID (RFC 8292) et chiffrement
   du message (RFC 8291). Deux voies sont possibles :
   - la bibliothèque `web-push`, largement utilisée, qui ajoute une
     dépendance ;
   - environ 150 lignes avec le module `crypto` de Node, sans dépendance, mais
     du code de chiffrement à maintenir nous-mêmes.

   C'est à toi de valider la voie.
4. **Le message** suit le format déclaratif
   (`{"web_push": 8030, "notification": {title, body, navigate, …}}`). Le
   service worker sait l'afficher lui-même : les anciens iPhone et Android y
   passent, les iPhone 18.4+ l'affichent sans lui.
5. **Le service worker** gagne deux écouteurs, `push` (qui affiche toujours une
   notification) et `notificationclick` (qui ouvre l'écran visé, dans la
   portée `/`). **`tests/pwa-service-worker.test.js` change exprès** : la liste
   permise devient `install`, `activate`, `fetch`, `push` et
   `notificationclick`, et un test refuse un `push` qui n'afficherait rien.
6. **Un seul chemin d'envoi par événement.** La notification se branche sur
   les émetteurs existants, comme un canal de plus (par exemple dans
   `lib/alert-notify.js` à côté de l'e-mail et du SMS), et non par un second
   circuit parallèle qui recalculerait qui prévenir.
7. **Staging n'a pas de cron** (`docs/STAGING.md` §1) : en recette, les envois
   déclenchés par le cron se lancent à la main, comme pour YieldFlow.

## 9. Case PERFORMANCE (CLAUDE.md, huit points)

1. **Endpoint d'écran** : sans objet. `/api/push` n'est pas un endpoint
   d'écran, il n'est appelé que sur un geste (s'abonner, se désabonner, essai).
2. **Donnée non urgente** : sans objet. Une notification est du temps réel par
   nature.
3. **Cache navigateur à clé compte** : aucun. Le service worker ne met aucune
   notification ni aucune donnée de compte en cache.
4. **`private, no-store`** : sur toute réponse de `/api/push`, posé avant le
   premier refus.
5. **Statiques** : sans changement. Le service worker reste revalidé à chaque
   déploiement (lot 1).
6. **Lecture tronquée** : la lecture des abonnements d'un compte à l'envoi se
   pagine si elle peut dépasser 1000 lignes. C'est improbable, mais la règle
   s'applique.
7. **Budget** : **zéro requête ajoutée au chargement des pages.** Savoir si
   l'appareil est abonné se lit dans le navigateur, sans appel réseau. Côté
   serveur, chaque envoi est un appel HTTP vers le service du navigateur (FCM,
   Apple, Mozilla). Son coût entre dans le compteur du cron
   (`docs/kb/cout-du-cron.md`) quand l'envoi part du cron.
8. **Mesure avant/après** : au lot, sur staging. Taille de `/sw.js` (lot 1 :
   ≈ 7,8 Ko), appels et octets d'une page avant et après, et durée d'une passe
   de cron avec et sans envoi.

## 10. Inventaire (la forme ne supprime jamais le fond)

- E-mail et SMS d'alerte : **conservés**, sans changement de comportement.
- Alarme de surréservation par SMS : **conservée**. La notification push
  s'ajoute.
- Réglages `agent_alert_config` : **conservés**. Selon Q4 et Q5, la
  notification push s'y ajoute comme troisième canal, ou vit à part.
- Service worker du lot 1 : ses règles (§2 du KB) sont **conservées**. Deux
  écouteurs s'ajoutent.
- Appli prestataire : **non touchée** (dette 130 inchangée).
- Test « aucune notification push » : **remplacé exprès** par le test de la
  liste permise (§8.5).

## 11. Tests et recette

- **Tests** :
  - le service worker affiche toujours une notification pour un push ;
  - le clic ouvre l'écran visé, jamais hors de la portée ;
  - un membre sans le domaine ne reçoit rien (garde à l'envoi, avec
    contre-épreuve) ;
  - la déconnexion supprime l'abonnement ;
  - un 410 supprime l'abonnement ;
  - aucune clé privée dans le dépôt ni dans une réponse ;
  - le chiffrement est vérifié contre les vecteurs de test de la RFC 8291.
- **Recette Android** (Thierry, sur staging) : s'abonner, recevoir l'essai,
  toucher la notification, se désabonner, se déconnecter.
- **Recette iPhone** : elle dépend du point 2 de la recette du lot 1
  (installation iPhone), encore reporté. Les deux se feront ensemble.

## 12. Questions à trancher par Thierry

| | Question | Section |
|---|---|---|
| Q1 | Quels événements déclenchent une notification au lot 2 (a à k) ? | §3 |
| Q2 | Les membres : titulaire seul, membres selon leurs droits, ou membres choisis par le titulaire ? | §4 |
| Q2 bis | Plusieurs comptes : les notifications de tous, ou du compte choisi sur l'appareil ? | §4 |
| Q3 | La surréservation : titulaire seul, ou aussi les membres `reservations` ? | §4 |
| Q4 | Le niveau de réglage : par appareil, par type, ou par type et par bien ? | §5 |
| Q5 | Où vit le bouton : `/settings`, chaque app, ou les deux ? | §5 |
| Q5 bis | La déconnexion supprime l'abonnement de l'appareil : d'accord ? | §5 |
| Q6 | Le détail sur l'écran verrouillé : bien seul, prénom, ou début du message ? | §6 |
| Q7 | Une pastille avec un chiffre sur l'icône ? | §6 |
| Q8 | Les notifications suivent-elles la sourdine de nuit (sauf la surréservation) ? | §6 |
| Q9 | Comment les clés arrivent dans Vercel, et quelle adresse de contact ? | §7 |
| Q10 | Les prestataires auront-ils un jour leurs notifications push ? (hors lot 2) | §0 |

## 13. Ce que le lot ne fait pas

- Pas de notification marketing, ni rien vers les voyageurs.
- Pas de notification depuis un écran ouvert (seulement depuis le serveur).
- Pas de changement de l'appli prestataire.
- Rien en production sans le go de Thierry : migration, clés, envoi réel.
