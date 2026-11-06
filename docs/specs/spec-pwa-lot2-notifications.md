# Spec — PWA lot 2 : les notifications push de l'appli hôte

**Statut : brouillon du 7 novembre 2026, à valider par Thierry. Aucune ligne de
code n'est écrite.** Révisée après une review (5 constats de sécurité, 2
bloquants, tous repris ici).

**Comment lire.** Les §0 à §7 sont pour Thierry : chaque choix produit y est
posé en question (Q1 à Q15, récapitulées au §12) et n'est pas tranché. Les §8 à
§11 sont techniques et ne demandent aucune décision de sa part. KB du lot 1 :
`docs/kb/pwa.md`.

## 0. Ce que le lot ajoute, et ce qu'il ne change pas

- **Un canal de plus**, à côté de l'e-mail et du SMS. Faut-il qu'une
  notification push **remplace** le SMS quand l'appareil est abonné ? Le SMS
  est payé sur la clé Brevo de l'hôte, et `docs/kb/menage.md` dit déjà du push
  qu'« il l'économise ». C'est la question **Q11**. L'alarme de surréservation,
  elle, garde son SMS dans tous les cas : c'est la seule alerte qui crie
  jusqu'à l'acquittement.
- **L'appli hôte seulement.** L'appli prestataire (`apps/menages/`) n'est pas
  touchée. Ses notifications push ont déjà leur ligne au backlog
  (`docs/kb/menage.md`, « lot dédié, après le chantier garde »). **Q10** :
  garde-t-on cet ordre ?
- **Aucun écran n'est modifié sans l'accord de Thierry** : la refonte V5
  continue sur `pages/`, `apps/` et `shared/ui.css`. Le bouton d'abonnement
  (§5) devra pourtant vivre dans un écran.

## 1. État des lieux (mesuré sur main `66495863`)

- **Le service worker de l'appli** (`shared/pwa/service-worker.js`, servi à
  `/sw.js`, 8 477 octets) ne réagit qu'à trois choses : son installation, son
  activation, et le chargement des pages. `tests/pwa-service-worker.test.js`
  garantit qu'il n'a aucune notification push. **Ce lot changera ce test
  exprès** (§8.5).
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
- **Aucune dépendance push** dans `package.json`, aucune table d'abonnement.
- **Le retour au bon écran après une reconnexion n'existe pas** :
  `components/auth-guard.js` renvoie vers la page de connexion sans dire d'où
  on venait. Il faudra le construire (§8.7).

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

Sources :
[WebKit — Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/),
[WebKit — nouveautés de Safari 18.4](https://webkit.org/blog/16574/digital-credentials-api/),
[Pushpad — exigences iOS](https://pushpad.xyz/blog/ios-special-requirements-for-web-push-notifications),
[OneSignal — web push pour iOS](https://documentation.onesignal.com/docs/en/web-push-for-ios),
[W3C — Push API](https://w3c.github.io/push-api/index.html).

## 3. Ce qui déclenche une notification — Q1

Les candidats sont rangés du plus urgent au moins urgent. **Thierry choisit
ceux du lot 2**, événement par événement : les quatre « interventions »
d'aujourd'hui sont séparées (b, j, l, m), on peut donc en garder certaines
sans les autres.

| # | Événement | Temps réel ? | Remarque |
|---|---|---|---|
| a | Surréservation | oui | Toujours en plus du SMS |
| b | Urgence détectée par l'IA dans un message | oui | |
| c | Information manquante demandée par l'IA | oui | |
| d | Brouillon de l'IA en attente de validation (délai de réponse IA) | oui | Nouveau : aujourd'hui l'hôte le voit seulement à l'écran |
| e | Nouveau message d'un voyageur | oui | Airbnb et Booking le notifient déjà dans leurs applis : doublon possible |
| f | Nouvelle réservation | oui | Directe seulement, comme l'e-mail actuel, ou aussi OTA (doublon) ? |
| g | Annulation ou modification d'une réservation | oui | |
| h | Ménage sans personne (trou de garde) | oui | Aujourd'hui, il ne va qu'au fondateur, et son SMS a été coupé parce qu'il partait trop souvent. Le prévenir rouvre une décision prise contre le bruit |
| i | Ménage « Pas vu » par la prestataire la veille | non | |
| j | Code d'accès non résolu | oui | |
| k | Pause automatique d'un bien | oui | |
| l | Ménage refusé par la prestataire | oui | |
| m | Disponibilités modifiées par une prestataire | non | |
| n | Nouvel avis | non | |

`docs/kb/alertes.md` le dit à propos de la surréservation : **une alerte qui
crie pour rien finit ignorée.** Mieux vaut moins de types, bien suivis.

## 4. Qui la reçoit — Q2, Q2 bis, Q3

- **Q2 — les membres.** Trois possibilités :
  1. le titulaire seul ;
  2. le titulaire et les membres, chaque membre ne recevant que ce que ses
     droits lui montrent. Le domaine est choisi **par événement** : `messages`
     pour b, c, d, e ; `reservations` pour f, g, j ; `menages` pour h, i, l, m ;
     `avis` pour n. Le bien doit aussi être dans son périmètre ;
  3. comme 2, mais c'est le titulaire qui coche, membre par membre.

  Les accès par lien (les prestataires) ne reçoivent **jamais** rien par ce
  canal.
- **Q2 bis — plusieurs comptes.** Un membre peut appartenir à plusieurs comptes.
  Reçoit-il les notifications de tous ses comptes, la notification nommant le
  compte et le bien ? Ou seulement celles du compte choisi sur cet appareil ?
- **Q3 — la surréservation.** Le titulaire seul ? Ou aussi les membres qui
  peuvent l'acquitter, c'est-à-dire ceux qui ont `reservations` en `write` sur
  le bien ?

## 5. S'abonner, se désabonner — Q4, Q5, Q5 bis, Q13

**La mécanique.** Le téléphone et l'ordinateur de l'hôte sont deux abonnements
différents. Un appareil n'est jamais abonné pour deux personnes à la fois : si
quelqu'un d'autre s'abonne sur le même appareil, l'abonnement passe à lui et
le précédent n'y reçoit plus rien.

- **Q4 — le niveau de réglage.** Trois possibilités :
  1. un seul interrupteur par appareil : « recevoir les notifications sur cet
     appareil » ;
  2. un interrupteur par événement (Q1) ;
  3. par événement et par bien.
- **Q5 — où vit le bouton.** La règle du dépôt range la configuration d'une app
  dans l'app, et la configuration générale dans `/settings`. Le test qui
  tranche : ce réglage a-t-il un sens si l'app n'existait pas ? « Cet appareil
  reçoit les notifications » est général : il irait dans `/settings`. Les
  événements propres à une app (b, c, d par exemple) pourraient vivre dans
  l'app, à côté des alertes e-mail et SMS du tiroir de Messages. Ces deux
  emplacements sont des écrans de la refonte V5.
- **Q5 bis — la déconnexion.** Proposition : se déconnecter désabonne
  l'appareil, côté téléphone **et** côté serveur. Sinon, un téléphone prêté ou
  partagé continuerait de recevoir les notifications du compte d'avant. D'accord ?
- **Un abonnement mort** est supprimé à la première tentative d'envoi.
  C'est le cas d'une appli supprimée ou d'une permission retirée dans les
  réglages du téléphone. **Q13** : l'hôte est-il prévenu, par e-mail, quand
  son **dernier** appareil abonné disparaît ? Sinon, il croirait être prévenu
  alors qu'il ne l'est plus.
- **iPhone** : le bouton n'apparaît que dans l'appli posée sur l'écran
  d'accueil. Dans Safari, il est remplacé par une phrase qui explique comment
  poser l'appli. Cette explication va aussi dans le guide (`pages/guide.html`).

## 6. Ce que dit la notification — Q6, Q7, Q8, Q12, Q14

- **Q6 — l'écran verrouillé.** La notification s'affiche sur l'écran
  verrouillé et sur la montre. Jusqu'où va le détail ? Trois possibilités :
  1. « Nouveau message — La bulle » ;
  2. avec le prénom du voyageur ;
  3. avec le début du message.
- **Au toucher**, la notification ouvre le bon écran (par exemple le bon fil de
  `/messages`). Si la session a expiré, l'hôte se reconnecte et arrive à cet
  écran.
- **Q7 — la pastille sur l'icône.** Faut-il un chiffre sur l'icône de l'appli,
  par exemple le nombre de choses à traiter ? L'iPhone le permet pour l'appli
  posée sur l'écran d'accueil. Sur Android, c'est le téléphone qui décide, en
  général un simple point tant qu'une notification attend.
- **Q8 — la nuit.** Ce qui existe déjà :
  - une **urgence** (b) n'est **jamais** retardée ni mise en sourdine : c'est
    une décision prise (`docs/kb/alertes.md`) ;
  - la sourdine de nuit de l'info manquante (c) est prévue mais **pas encore
    branchée** (lot 3 du chantier délai).

  La question : les autres événements se taisent-ils la nuit ? Et la
  surréservation (a) sonne-t-elle la nuit, comme son SMS ? Le téléphone a aussi
  ses propres modes « Ne pas déranger ».
- **Q12 — le remplacement.** Deux notifications sur le même sujet
  (deux messages du même voyageur, par exemple) : la seconde remplace la
  première, ou elles s'empilent ?
- **Q14 — la langue.** HôteSmart parle français, anglais et espagnol. Le
  serveur envoie la notification dans quelle langue : celle du profil de
  l'hôte, ou le français pour tous au lot 2 ?

## 7. Les clés d'envoi — Q9

Pour envoyer, le serveur signe chaque message avec une **paire de clés** :
- **La clé publique** est donnée au téléphone au moment de l'abonnement. Elle
  n'est pas secrète.
- **La clé privée est un secret.** Elle ne s'affiche jamais : elle s'écrit
  directement dans les variables Vercel. Il faut deux paires distinctes, une
  pour la production et une pour staging, pour qu'un abonnement de test ne
  reçoive jamais un envoi de la production.
- **Changer de clé désabonne tout le monde** : chaque appareil devra se
  réabonner. Si la clé privée fuyait, c'est pourtant ce qu'il faudrait faire.
- **La même paire servira un jour à l'appli prestataire**, qui vit sur le même
  site.

**Q9 — comment les clés arrivent dans Vercel.** Je n'ai pas d'accès à Vercel
depuis le cloud, et Vercel ne génère pas ce type de clé. Deux possibilités :
1. **un jeton Vercel donné au fil.** Il génère les clés et les écrit dans les
   variables. Trois choses à savoir avant de choisir :
   - un jeton limité à un projet donne **tous les droits sur ce projet** :
     déployer, lire et modifier toutes les variables ;
   - il en faut deux, un pour la production et un pour staging ;
   - le jeton lui-même passerait par la conversation, ce que la règle « un
     secret ne passe jamais par le terminal » interdit. C'est aussi la décision
     qu'attend le chef de file pour observer le cron ;
2. **un petit script que Thierry lance une fois sur son PC**, guidé pas à pas.
   Il génère les clés et les écrit directement dans Vercel, sans rien
   afficher. Aucun secret ne passe par la conversation.

Il faut aussi une adresse de contact pour le service d'Apple : un e-mail ou un
lien vers le site. Laquelle ?

## 8. Architecture (technique, sans décision pour Thierry)

1. **Table `push_abonnements`** (migration : staging d'abord, la production
   sur go). Elle stocke l'utilisateur, le compte, l'adresse d'envoi et les
   clés du navigateur. Elle stocke aussi un libellé de l'appareil, les dates
   de création et du dernier envoi réussi, et les préférences de Q4.
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
   - **L'adresse d'envoi est validée à l'abonnement** : `https` obligatoire,
     et seulement les services connus (Google `fcm.googleapis.com`, Apple
     `*.push.apple.com`, Mozilla `updates.push.services.mozilla.com`,
     Microsoft `*.notify.windows.com`). Sinon, le serveur pourrait être poussé
     à appeler n'importe quelle adresse.
3. **Envoi `lib/push/envoyer.js`, écrit avec le module `crypto` de Node et
   `fetch`, sans dépendance.** Il signe (RFC 8292) et chiffre (RFC 8291), et
   il est vérifié contre les vecteurs de test de la RFC 8291. Pourquoi pas la
   bibliothèque `web-push` : elle envoie par `https.request`, que le compteur
   de coût du cron ne voit pas (il ne compte que `fetch`,
   `docs/kb/cout-du-cron.md` §2). Chaque envoi a un délai maximal de
   5 secondes. Un 404 ou un 410 supprime l'abonnement.
4. **Le message suit le format déclaratif** :
   `{"web_push": 8030, "notification": {title, body, navigate, …}}`, **jamais
   `mutable: true`**. C'est ce qui permet à l'iPhone 18.4+ de l'afficher
   lui-même, et au service worker de l'afficher sur les autres appareils.
5. **Le service worker** gagne trois écouteurs :
   - `push`, qui affiche **toujours** une notification ;
   - `notificationclick`, qui ouvre l'écran visé, jamais hors du site ;
   - `pushsubscriptionchange`, qui renvoie au serveur un abonnement renouvelé
     par le navigateur.

   Ce qui change exprès : les deux tests de `tests/pwa-service-worker.test.js`
   (l. 348 et l. 426), le motif qui interdit `showNotification`, l'en-tête du
   service worker (l. 25) et le §2.7 du KB du lot 1. Un test neuf refuse un
   `push` qui n'afficherait rien.
6. **Les destinataires se calculent depuis les profils et les droits**, pas
   depuis `agent_alert_config`, qui ne contient que des listes libres de
   numéros et d'adresses.
   - La garde à l'envoi reprend les mêmes contrôles que `dansPerimetre` et
     `niveauEffectif` (`lib/permissions.js`) : profil actif, invitation
     acceptée, membre égal à l'abonné, domaine de l'événement, bien dans le
     périmètre.
   - Elle exclut les accès par lien.
   - Le point d'envoi se branche sur l'émetteur de chaque événement, à côté de
     l'e-mail et du SMS, avec un **motif** propre à chaque événement (b, j, l,
     m séparés).
7. **Le retour au bon écran** : `components/auth-guard.js` transmet l'adresse
   demandée à la page de connexion (`next`), que `login.html` sait déjà lire.
   L'adresse est contrôlée : même site seulement.
8. **L'ordre à l'abonnement**, pour l'iPhone : d'abord la permission, dans le
   geste ; puis la clé publique ; puis l'abonnement ; puis l'enregistrement
   côté serveur.
9. **Staging n'a pas de cron** (`docs/STAGING.md` §1) : en recette, les envois
   déclenchés par le cron se lancent à la main.

## 9. Case PERFORMANCE (CLAUDE.md, huit points)

1. **Endpoint d'écran** : `/api/push` n'en est pas un, il n'est appelé que sur
   un geste. Si Q4 vaut 2 ou 3, les préférences s'affichent dans l'écran qui
   porte le bouton (Q5) : elles sont lues par **son** endpoint d'écran, sans
   appel de plus.
2. **Donnée non urgente** : sans objet, une notification est du temps réel.
3. **Cache navigateur à clé compte** : aucun. Ni le service worker ni l'écran
   ne mettent de notification ou de préférence en cache.
4. **`private, no-store`** : sur toute réponse de `/api/push` sauf la clé
   publique, et posé avant le premier refus.
5. **Statiques** : sans changement. Le service worker reste revalidé à chaque
   déploiement (lot 1).
6. **Lecture tronquée** : la lecture des abonnements d'un compte se pagine par
   curseur si elle peut dépasser 1000 lignes (le plafond de 10 par utilisateur
   la borne déjà).
7. **Budget** : **zéro appel ajouté au chargement des pages.** L'état de
   l'appareil (abonné ou non) se lit dans le navigateur. L'état en base vient
   de l'endpoint d'écran du point 1. Côté serveur, chaque envoi est un appel
   compté par le compteur du cron.
8. **Mesure avant/après**, au lot, sur staging : appels, requêtes Supabase et
   octets d'une page avant et après, taille de `/sw.js` (avant : 8 477
   octets), et durée d'une passe de cron avec et sans envoi.

## 10. Inventaire (la forme ne supprime jamais le fond)

- E-mail et SMS d'alerte : **conservés**. Seule Q11 peut changer le SMS.
- Alarme de surréservation : **conservée**, la notification s'ajoute.
- `agent_alert_config` : **conservé**. Les destinataires des notifications
  vivent à part (§8.6).
- Service worker du lot 1 : ses règles sont **conservées**, et trois écouteurs
  s'ajoutent. Son en-tête (l. 25) et le §2.7 du KB sont **réécrits**.
- Tests « aucune notification push » : **remplacés exprès** (§8.5).
- `components/auth-guard.js` : **complété** (retour au bon écran).
- `pages/guide.html` : **complété** (installer l'appli et s'abonner sur
  iPhone).
- Appli prestataire : **non touchée** (dette 130 inchangée).

## 11. Tests et recette

- **Tests** :
  - le service worker affiche toujours une notification ;
  - le clic ouvre l'écran visé, jamais hors du site ;
  - un abonnement renouvelé est renvoyé au serveur.
- **Garde à l'envoi**, avec contre-épreuve à chaque fois : rien ne part pour
  - un membre sans le domaine ;
  - un bien hors de son périmètre ;
  - un profil désactivé ;
  - une invitation non acceptée ;
  - un accès par lien.
- **Abonnements** :
  - un second abonné sur le même appareil prend l'abonnement ;
  - la déconnexion désabonne ;
  - un 410 supprime l'abonnement ;
  - une adresse d'envoi hors liste est refusée ;
  - le plafond de 10 tient.
- **Envoi** :
  - chiffrement vérifié contre les vecteurs de la RFC 8291 ;
  - les envois sont comptés par le compteur du cron ;
  - aucune clé privée dans le dépôt ni dans une réponse.
- **Recette Android** (Thierry, sur staging) : s'abonner, recevoir l'essai,
  toucher la notification, se déconnecter, vérifier que plus rien n'arrive.
- **Recette iPhone** : **Q15**, la fait-on en même temps que le point 2
  reporté de la recette du lot 1 (installation sur iPhone) ?

## 12. Questions à trancher par Thierry

| | Question | Section |
|---|---|---|
| Q1 | Quels événements déclenchent une notification au lot 2 (a à n) ? | §3 |
| Q2 | Les membres : titulaire seul, membres selon leurs droits, ou membres choisis par le titulaire ? | §4 |
| Q2 bis | Plusieurs comptes : les notifications de tous, ou du compte choisi sur l'appareil ? | §4 |
| Q3 | La surréservation : titulaire seul, ou aussi les membres qui peuvent l'acquitter ? | §4 |
| Q4 | Le niveau de réglage : par appareil, par événement, ou par événement et par bien ? | §5 |
| Q5 | Où vit le bouton : `/settings`, chaque app, ou les deux ? | §5 |
| Q5 bis | La déconnexion désabonne l'appareil : d'accord ? | §5 |
| Q6 | Le détail sur l'écran verrouillé : le bien seul, le prénom, ou le début du message ? | §6 |
| Q7 | Une pastille avec un chiffre sur l'icône ? | §6 |
| Q8 | La nuit : quels événements se taisent, et la surréservation sonne-t-elle ? | §6 |
| Q9 | Les clés : jeton Vercel ou script sur ton PC ? Et quelle adresse de contact ? | §7 |
| Q10 | Les notifications des prestataires restent-elles après le chantier garde, comme prévu ? | §0 |
| Q11 | La notification remplace-t-elle le SMS quand l'appareil est abonné ? | §0 |
| Q12 | Deux notifications sur le même sujet : la seconde remplace la première, ou elles s'empilent ? | §6 |
| Q13 | Prévenir l'hôte par e-mail quand son dernier appareil abonné disparaît ? | §5 |
| Q14 | La langue de la notification : celle du profil, ou le français au lot 2 ? | §6 |
| Q15 | La recette iPhone avec celle, reportée, du lot 1 ? | §11 |

## 13. Ce que le lot ne fait pas

- Pas de notification marketing, ni rien vers les voyageurs.
- Pas de notification envoyée depuis un écran ouvert : seul le serveur envoie.
- Pas de changement de l'appli prestataire.
- Rien en production sans le go de Thierry : migration, clés, envoi réel.
