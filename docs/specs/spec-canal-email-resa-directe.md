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
