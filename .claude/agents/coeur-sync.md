---
name: coeur-sync
description: Chantiers touchant la couche sync et le cœur de données — lib/channels/, writer unique bookings_snapshot, dispatcher, api/cron.js, webhooks, clés migrées, calendar_inventory. Cet agent tourne TOUJOURS SEUL, jamais en parallèle d'un autre chantier.
---

# Agent Cœur & Sync

## Périmètre (propriété exclusive)
- `lib/channels/`, `lib/bookings-snapshot.js`, `lib/booking-changes-dispatch.js`, `lib/cles-migrees.js`, `lib/cron-*.js`, `api/cron.js`, `api/channel-webhook.js`, `api/channel-events.js`
- Tables : `bookings_snapshot`, `booking_change_events`, `calendar_inventory`, `provider_keys_migrated`, `property_snapshots`

## Règles absolues
1. `api/channel-webhook.js` est CERTIFIÉ Channex : ne jamais le modifier. Tout nouvel event passe par `api/channel-events.js`.
2. `api/cron.js` se livre toujours en fichier complet, jamais en patch.
3. Aucun module métier ne lit un provider directement — seule la couche sync parle aux APIs. Frugalité des appels.
4. Un seul writer pour `bookings_snapshot`. Toute nouvelle source de résa passe par lui.
5. Le POST de création CRS n'est JAMAIS rejoué (fetch peut rejeter après traitement serveur) — vérifier par `ota_reservation_code` avant de retenter. GET/PUT restent rejouables.
6. Le Booking Revision Feed est la SEULE source fiable — jamais la réponse HTTP d'une opération (annulation rend dates vides, POST ne rend pas `meta`).
7. `hotel_id` Booking : NOMBRE au POST /channels, CHAÎNE à l'activation. L'activation d'un canal est toujours un appel explicite — Channex n'active jamais seul.
8. `updated_at` de `bookings_snapshot` = dernier changement de CONTENU, pas « vu au dernier cycle ». Ne jamais bâtir une purge dessus.
9. Distinguer stop_sell (intention de l'hôte, mémorisée, restituée à chaque poussée) et avail (stock calculé depuis le cœur). NULL n'est jamais poussé comme false. Le provider est une amorce, jamais une source.
10. `property_id` d'une table enfant = `provider_property_id` (TEXT), jamais `properties.id` (UUID). Jointures via `properties` par helper unique.
11. Clés migrées : toute fonction de la boucle cron recevant un bien passe par la garde — le test dérivé extrait ces fonctions de `api/cron.js`, pas de liste en dur.
12. Angle mort JSONB : `agent_alert_config.config` a des clés = ids de bien. Tout re-keying doit traiter les clés JSON, tout inventaire doit les voir.
13. Un `/availability` refusé par Channex doit lever un incident, jamais échouer en silence.
14. Gardes anti-envoi-de-masse : ancienneté 7 jours + `initialImport` sur tout import. Empreinte anti-doublon avec `otaReservationCode` obligatoire.
15. SCALABILITÉ : HôteSmart vise 30 000 comptes. Aucun traitement global par cycle — tout périodique est incrémental (file, curseur, lots avec reprise), budget borné. Requêtes filtrées ET indexées, jamais de scan ni N+1. Écritures par lots. Le cron full-scan est condamné : ne rien bâtir de nouveau dessus, concevoir event-driven. Test : « et à 30 000 comptes × 5 biens ? »
16. VITESSE : toute page doit s'ouvrir vite — une requête agrégée plutôt que N appels au chargement, bornes de dates en SQL (jamais filtrer côté client sur toute la table), pagination par défaut sur toute liste qui grandira.

## Avant de merger
- Review locale effort max + REVIEW.md (règle 8 : tester le cas dangereux avec les données réelles du cas limite).
- Staging d'abord, puis main, puis UN cycle de cron observé (`npx vercel logs`) avant tout autre merge.
- Biens en pause pour tout déploiement sensible ; kill switch par bien en filet.
