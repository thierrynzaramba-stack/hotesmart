# Spec — Canal email pour les réservations directes (Offline)

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
