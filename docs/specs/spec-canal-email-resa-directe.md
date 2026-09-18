# Spec — Canal email pour les réservations directes (Offline)

> ## ✅ LIVRÉ — 17 septembre 2026
>
> Les sept étapes sont closes et validées **en production**, dans les deux sens :
> une réservation directe reçoit ses messages par e-mail depuis l'adresse de l'hôte,
> et une réservation OTA continue de passer par sa messagerie sans rien changer.
>
> **Ce qui a été prouvé en réel** (observateur, deux cycles de cron, aucun point rouge) :
> confirmation post-paiement reçue depuis « Cœur de vie », message de parcours validé en
> Mode Test puis délivré en `canal=email`, témoin Booking.com inchangé en `canal=ota`,
> aucun doublon, kill switch qui coupe, badge sur la seule réservation sans adresse,
> et notification « Nouvelle réservation » reçue par l'hôte sur une vraie vente.
>
> Détail technique et règles gravées : `docs/kb/guestflow.md`.
> Dettes ouvertes : §« Ce qui reste à faire » en fin de ce document.


## Objectif
Les réservations directes (provider Channex, `ota_name: "Offline"`, vendues par le moteur) doivent bénéficier du même parcours de communication que les résas OTA — mêmes templates, mêmes automatisations GuestFlow, même messagerie unifiée côté hôte — mais avec l'**email du voyageur** comme canal de sortie, puisqu'il n'y a pas de messagerie OTA derrière.

Décision produit : **pas de PWA voyageur en v1**. Email pour tout le parcours, SMS (Brevo, clé de l'hôte) conservé pour les infos critiques existantes (ex. code d'accès). La PWA « livret d'accueil » est une idée v2, hors périmètre.

## Principe d'architecture (à respecter, pas à réinventer)
- La résa Offline entre déjà par le feed Channex comme une résa normale → writer unique → `bookings_snapshot`. **Aucun chemin parallèle.**
- Le routage se fait dans la **couche d'envoi** de GuestFlow : au moment d'envoyer un message, router selon la source de la résa —
  - résa OTA (Airbnb, Booking…) → messagerie OTA via Channex/Beds24 (comportement actuel, inchangé)
  - résa Offline → email direct au voyageur
- Règle existante inchangée : aucun module métier ne parle à un provider directement — tout passe par la couche sync/envoi.

## Points à spécifier par l'étude (étape 0)
1. **Où vit l'email du voyageur** : le moteur collecte l'email au checkout — vérifier qu'il arrive dans le snapshot via le feed (champ customer de Channex) ou s'il faut le lire depuis `booking_attempts`. Source de vérité unique à trancher.
2. **Expéditeur** : envoi via Brevo avec la clé de l'hôte (cohérent avec la règle SMS host-owned). Adresse d'expédition et nom affichés = ceux de l'hôte (à configurer, avec valeur par défaut propre).
3. **Réponses entrantes** : v1 minimale = `reply-to` vers l'email de l'hôte (le voyageur répond, l'hôte reçoit dans SA boîte mail). L'ingestion des réponses dans la messagerie HôteSmart (inbound parsing Brevo) est un chantier séparé — ne pas le lancer sans décision explicite. Conséquence assumée v1 : le fil « messages envoyés » est dans HôteSmart, les réponses arrivent dans la boîte mail de l'hôte.
4. **Templates** : les templates GuestFlow existants doivent fonctionner tels quels ; prévoir la mise en forme email (objet + corps HTML simple). Pas de refonte des templates.
5. **Email de confirmation de résa** : la décision antérieure l'avait reporté « au chantier suivant avec le moteur » — c'est celui-ci. Premier message du parcours : confirmation immédiate post-paiement (récap dates, prix, politique d'annulation, coordonnées de l'hôte).
## Réponses de l'étude (étape 0 — 16 septembre 2026)

Mesuré sur les 8 réservations Offline réelles (Colomiers + Bagnères) et par appel
direct en lecture à l'API Channex.

1. **L'email vit dans le cœur, pas dans `booking_attempts`.**
   `bookings_snapshot.raw.customer.mail` le porte sur 7 des 8 Offline. La 8e
   (`61415d10`, saisie à la main dans le calendrier) l'a à `null` : le formulaire
   de saisie manuelle ne le collecte pas. `booking_attempts.guest_email` ne couvre
   que les résas du moteur et se clé sur `properties.id` (UUID) quand le snapshot
   se clé sur `provider_property_id` — le retenir ouvrirait un second chemin.
   **Source de vérité : le cœur.** Le snapshot NORMALISÉ n'a aucun champ email, et
   le lecteur GuestFlow (`fetchChannelBookings`) ne sélectionne que
   `booking_id, snapshot` : l'email doit donc entrer dans le schéma du writer
   unique, jamais être lu depuis `raw` par un module d'envoi (6 Ko par ligne).

2. **Le routage se décide sur la SOURCE, jamais sur la présence d'un email.**
   Booking.com sert un alias `@guest.booking.com` dans le même champ : router sur
   « email présent » détournerait des réservations qui ont une messagerie OTA.
   Discriminant : `snapshot.source === 'Offline'`.

3. **Ça échoue déjà, en silence.** `hasMessagingThread()` ne filtre pas les
   Offline (`'Offline'` n'est ni vide ni `'direct'`), donc GuestFlow tente l'envoi
   et Channex répond **HTTP 422 `not_supported`** (vérifié sur deux bookings
   Offline, contre 200 et 10 messages sur un témoin Airbnb). Comme `noterEnvoi()`
   écrit `message_sent_log` AVANT l'envoi, trois réservations Offline portent un
   `booking_confirmed` marqué envoyé, avec une ligne dans `messages`, que le
   voyageur n'a jamais reçu. Ces trois lignes bloquent aussi le rejeu par email.

4. **Point d'insertion unique du routage :**
   `lib/cron-messages.js sendGuestMessage()`. Il sert les deux moteurs de
   templates ET les codes d'accès (`lib/cron-arrival-code.js`), qui en héritent
   sans être touchés. Hors de ce chemin : `api/channel-message.js` (envoi manuel
   de l'hôte) et `lib/cron-classify.js` (réponse auto à un entrant, sans objet
   en v1). L'événementiel existe déjà : `booking_change_events` → dispatcher →
   `triggerTemplates('booking_confirmed')`. Rien à créer, aucun full-scan.

5. **Config expéditeur : la clé existe, l'adresse n'existe nulle part.**
   `api_keys.brevo_api_key` / `brevo_enabled` portent déjà le modèle host-owned
   (`api/sms.js`, sans repli sur l'env) et la clé sait envoyer de l'email
   (`GET /account` → 200). Aucune colonne d'adresse ni de nom d'expéditeur
   n'existe, nulle part. **Brevo exige un expéditeur VÉRIFIÉ** : l'écran doit
   lire les senders du compte de l'hôte (`GET /senders`) et les lui faire
   choisir — un champ texte libre livrerait une config qui rend 400 à l'envoi.
   Emplacement : `/settings` (c'est une connexion, pas un réglage d'app).

6. **La confirmation de réservation est déjà écrite, mais part de la plateforme.**
   `lib/email-voyageur.js` (trilingue, marque blanche soignée) est branché sur
   `lib/moteur-creation.js`. Il passe par `sendPlatformEmail`, donc l'enveloppe
   dit « HôteSmart <alertes@hotesmart.fr> » là où le corps ne dit que le nom du
   bien. Ce qui reste à faire n'est pas de l'écrire, c'est de le faire partir
   **de l'hôte**.

## Décisions tranchées (Thierry, 16 septembre 2026)

- **Envoi manuel de l'hôte sur une résa Offline : OUVERT en v1.** Il part en
  email, par le même routage que les messages automatiques.
- **`reply-to` = l'adresse d'expédition** (le sender Brevo choisi). Aucun champ
  de configuration supplémentaire.
- **Email optionnel à la saisie manuelle.** Absent : aucun envoi, **aucune ligne
  dans `message_sent_log`**, et un badge visible sur la réservation — « pas
  d'email, messages non envoyés ». Jamais d'erreur avalée.
- **`message_sent_log` est écrit APRÈS un envoi réussi**, avec un plafond de
  tentatives. Un échec Brevo remonte visiblement, au même titre que le 422
  Channex trouvé par l'étude. C'est l'exception assumée à l'ordre actuel
  (log avant envoi), et elle ne vaut QUE pour le canal email.

## Périmètre ajouté après l'étude

- **Correction du Mode Test côté front.** `apps/agent-ai/messagerie.html` poste la
  validation en dur vers `/api/beds24` sans routage provider, alors que l'envoi
  manuel route. Sans ce correctif, le Mode Test exigé plus bas ne fonctionne ni
  pour Channex ni pour l'email.
- **Nettoyage des 3 faux envois** de `message_sent_log` (constat 3), juste avant
  le test réel, avec la liste des lignes supprimées au rapport.

## Étapes

1. **Le cœur porte l'email** — `guestEmail` au schéma du writer unique
   (`lib/bookings-snapshot.js`), `customer.mail` côté Channex, `email` côté
   Beds24. Backfill re-dérivé du `raw` déjà en base, borné, sans appel provider.
2. **Le routage par source** — dans `sendGuestMessage` ; `hasMessagingThread`
   dit enfin la vérité sur Offline.
3. **L'envoi email host-owned** — clé du compte propriétaire, sender de l'hôte,
   objet + corps HTML simple dérivés du texte du template.
4. **Config expéditeur dans `/settings`** — choix dans la liste des senders vérifiés.
5. **La confirmation part de l'hôte**, et le formulaire de saisie manuelle
   collecte l'email.
6. **Test réel Colomiers**, précédé du nettoyage des 3 lignes.

Les étapes 1 et 2 sont du périmètre cœur & sync : elles se font seules, sans
aucun autre chantier en parallèle.

## Garde-fous (hérités des règles du repo)
- Anti-envoi-de-masse et anti-boucle existants s'appliquent au canal email comme aux autres.
- `message_sent_log` dédupe aussi les emails.
- Cloisonnement par compte : la clé Brevo utilisée est celle du compte propriétaire du bien, jamais une clé globale.
- Kill switch par bien (`automation_paused`) doit couper les emails comme le reste.
- Mode Test / Mode Auto par bien s'applique : en Mode Test, l'email est proposé à validation, pas envoyé seul.
- Scalabilité : pas de traitement full-scan — le déclenchement suit le mécanisme événementiel existant (booking_change_events / dispatcher).

## Test de validation (règle 8 — cas réel)
Résa test Offline sur Colomiers (avec l'email de Thierry comme voyageur) : confirmation reçue, messages du parcours reçus aux bons moments, dédup vérifiée, kill switch vérifié, et une résa OTA témoin qui continue de passer par la messagerie OTA sans changement.

## Hors périmètre
- PWA voyageur / livret d'accueil (v2)
- Ingestion des réponses email dans la messagerie HôteSmart (chantier séparé)
- Refonte des templates

## Ce qui reste à faire (ouvert au 17 septembre 2026)

Ces points ont été **décidés hors périmètre** ou **découverts en route**. Aucun n'empêche
le chantier d'être clos ; tous méritent d'exister ailleurs que dans une mémoire.

### 1. L'hôte n'a aucun écran d'incidents — et deux gardes en dépendent

`reportIncident` écrit dans `automation_incidents` puis notifie le **fondateur**. L'hôte
n'apprend donc jamais que sa configuration Brevo manque, que ses confirmations partent sous
l'enseigne HôteSmart, ou qu'une annonce de vente n'est pas partie.

Deux replis existent **uniquement** pour cette raison, et se retireront le jour où l'écran
existera :

- la **confirmation de réservation** se replie sur la clé plateforme (`email_confirmation_repli`) ;
- la **notification de nouvelle réservation** fait de même.

Le geste, ce jour-là : supprimer les blocs de repli, faire dire aux incidents « NON envoyée »,
et **retourner les tests** qui défendent aujourd'hui « elle part toujours » — sans quoi ils
défendront une règle abandonnée.

## Inbound e-mail — la conception, révisée par les faits (18 septembre 2026)

### ⚠️ Ce que l'API Brevo ne fait pas

La conception validée à l'étape 0 était : *« le webhook n'est qu'un déclencheur, on relit tout
chez Brevo avec notre clé »*. Elle reposait sur la documentation, qui décrit bien un payload
riche **côté webhook** — j'ai supposé que l'API de relecture rendait la même chose.

Mesure du 18 septembre : `GET /inbound/events/<uuid>` ne rend que des **métadonnées** —
`receivedAt`, `deliveredAt`, `messageId`, `sender`, `recipient`, `subject`, `attachments`,
`logs`. **Aucun corps.** Ni `?includeBody=true`, ni `/body`, ni `/content`, ni `/raw`. Le
contenu d'un e-mail entrant n'existe que dans le POST.

### La conception retenue

**Le webhook apporte le contenu ; la relecture l'authentifie.** Ce qui *désigne* une ressource
vient de Brevo ; ce qui la *décrit* peut venir du POST, une fois corroboré.

| élément | source | pourquoi |
|---|---|---|
| **rattachement** (`recipient`) | **Brevo, relu** | il porte le jeton, donc la réservation, donc le compte |
| `sender`, `subject`, `messageId` | **confrontés** | une divergence POST/Brevo est un refus |
| en-têtes (anti-boucle) | payload | Brevo ne les expose pas ; les omettre ferait seulement passer un message pour humain |
| **corps** | payload | aucune alternative |
| horodatage | **Brevo** (`receivedAt`) | une date du payload est choisie par l'expéditeur et ferait mentir l'ordre du fil |

Sans `uuid`, **on ne relit rien et on ne traite rien** : la première version retombait sur
« le dernier e-mail reçu », c'est-à-dire qu'un POST sans `uuid` faisait authentifier un
message sans rapport, dont le `recipient` aurait servi au rattachement.

### ⚠️ Risque résiduel — accepté par le product owner le 18 septembre 2026

Qui connaîtrait un `uuid` réel pourrait **substituer le corps de ce message-là**. Ce qu'il ne
peut pas faire : inventer un `uuid` (aléatoire, transitant seulement dans le webhook en
HTTPS), détourner le message vers une autre réservation (le `recipient` vient de Brevo), ni
écrire dans un fil arbitraire.

Le risque suppose donc une fuite préalable de l'`uuid`. Il est nommé ici plutôt que noyé : le
jour où Brevo exposera une signature de webhook, c'est ce paragraphe qu'il faudra venir
supprimer.

### 2. ~~L'ingestion des réponses e-mail~~ — ✅ LIVRÉE le 18 septembre 2026

Hors périmètre dès la spec d'origine, reprise le 17 et **validée en production le 18** :
une réponse envoyée à l'adresse-jeton entre dans le fil de la réservation
(`canal=email`, `inbound`), l'hôte en reçoit une copie, et il peut répondre
depuis la messagerie — vérifié de bout en bout sur une réservation réelle.

Infrastructure : sous-domaine `reply.hotesmart.fr`, MX Brevo, webhook `id=2191668`,
jetons HMAC sans table (`lib/jeton-reponse.js`), endpoint `api/inbound-email.js`.
Conception et risque résiduel : § « Inbound e-mail » ci-dessus. Conséquence assumée : le fil « messages envoyés » vit
dans HôteSmart, les réponses arrivent dans la boîte mail de l'hôte (`reply-to` = son adresse
d'expédition). Le jour où ce chantier s'ouvrira, `lib/cron-classify.js` devra router comme les
autres (voir dette 3).

### 3. ~~`lib/cron-classify.js` hors du routage~~ — ✅ SOLDÉE le 18 septembre 2026

Fermée par l'étape 6 du chantier inbound : la réponse de l'IA passe par `sendGuestMessage`,
son retour est lu, et un échec n'écrit plus ni fil ni `messages`. Détail :
`docs/kb/guestflow.md`.

### 4. Les trois lignes mensongères de `messages`

La purge de l'étape 6 a nettoyé `message_sent_log`, qui **bloquait** les rejeux. Les trois
lignes correspondantes de `messages` (`outbound/auto`, `canal=ota`, Offline des 12 et
14 septembre) sont toujours là : le fil affiche trois messages que le 422 de Channex avait
refusés. Les supprimer fait perdre une trace d'historique ; les marquer demanderait une
colonne. À trancher.

### 5. Les templates de test sur Colomiers

`booking_confirmed` et `arrival` J-1, marqués `[[test-canal-email]]` — **et cette marque part
dans les messages**. Soit on les garde en retirant la marque à la main, soit
`node scripts/templates-test-colomiers.js --supprimer --execute`.

### 6. Beds24 `direct` n'entre pas dans le canal e-mail

Une saisie directe côté Beds24 (`source: 'direct'`) n'a pas plus de fil qu'une Offline, et
son adresse dort dans `raw.email`. Elle reste sans canal en v1 : pour la faire entrer, il
faudrait que son booking vienne du **cœur** et non du payload provider — la règle du cœur de
données, prise par le bon bout. Le badge, lui, la couvre déjà.

### 7. Le sujet des e-mails n'est pas traduit

Le corps d'un template est écrit par l'hôte, dans sa langue, et part tel quel ; le sujet est
dérivé en français. Un sujet traduit devant un corps français serait un faux service. Le jour
où les templates seront multilingues, les deux suivront `customer.language`, qui est déjà
dans le cœur.

### 8. `emailOuRien` porte mal son nom

Elle sert aussi au téléphone depuis `guestPhone`. La renommer toucherait ses appelants pour
un gain de lecture seule : noté, pas fait.

---

## Clôture du chantier inbound — 18 septembre 2026

Le circuit complet fonctionne en production : réponse d'un voyageur → webhook Brevo →
`api/inbound-email.js` → `messages` (`canal=email`, `inbound`) + `conversations` + copie à
l'hôte → réponse possible depuis la messagerie, par le bon canal.

### Ce que ce chantier a appris, et qui vaut au-delà de lui

1. **Un faux client qui n'imite pas la forme du vrai ne prouve rien du vrai.** Mes tests
   servaient la forme du *payload* du webhook là où l'API de relecture rend des métadonnées
   plates. Ils sont restés verts pendant que le rattachement échouait en production.
   Troisième occurrence de cette famille dans le dépôt.
2. **Un test qui lit du code ne voit pas ce que le code fait.** Le « test qui compte » de la
   bascule du `reply-to` était un grep de source : il vérifiait que `bookingId` apparaissait
   chez les appelants — vrai — sans traverser la fonction qui le jetait. La contre-épreuve
   (réintroduire le bug et vérifier que le test rougit) est devenue systématique.
3. **Une décision d'architecture validée peut être démentie par les faits.** « On ne croit
   pas le payload » était juste en principe et impraticable en pratique. Le dire tôt vaut
   mieux que le contourner.

### Dettes restantes — backlog

| # | dette | pourquoi elle attend |
|---|---|---|
| 1 | **L'hôte n'a aucun écran d'incidents** | deux replis plateforme (confirmation, notification de vente) n'existent que pour ça ; le jour de cet écran, on les retire et on **retourne les tests** qui défendent « elle part toujours » |
| 2 | **Aucune sonde sur l'authentification du domaine Brevo** | elle a disparu une fois entre le 16 et le 17 septembre, sans que rien ne le dise. Le jour où elle tombe en production, les e-mails s'arrêtent en silence |
| 3 | **Les 3 lignes mensongères de `messages`** | `outbound/auto`, `canal=ota`, Offline des 12 et 14 septembre — messages que le 422 avait refusés. Supprimer perd une trace, marquer demande une colonne |
| 4 | **Templates de test sur Colomiers** | marqués `[[test-canal-email]]`, et cette marque part dans les messages |
| 5 | **Beds24 `direct` hors canal e-mail** | son booking vient du payload provider, pas du cœur ; le badge le couvre déjà |
| 6 | **Sujets d'e-mail non traduits** | le corps ne l'est pas non plus ; les deux suivront `customer.language` ensemble |
| 7 | **`emailOuRien` porte mal son nom** | elle sert au téléphone depuis `guestPhone` |
| 8 | **Le jeton de réponse ne se révoque pas** | HMAC sans table ; la validité se décide à la lecture de la réservation, ce qui suffit aujourd'hui |
| 9 | **Risque résiduel de substitution de corps** | disparaîtra le jour où Brevo signera ses webhooks (§ « Risque résiduel ») |
| 10 | **`scripts/cloture-annuler-resas-test.js` ne peut pas annuler** | `TEST_EMAIL` est un membre délégué, pas le propriétaire — et c'est la garde qui fonctionne, pas un défaut à corriger |
