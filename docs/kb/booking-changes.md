# KB — Changements de réservation : détection et distribution

<!-- SOURCES (mapping inverse). ⚠️ DOC en tête de ces fichiers pointe ici. Modif = MÊME COMMIT. -->
> Sources : `lib/booking-changes.js` (détection neutre), `lib/bookings-snapshot.js`
> (journalise), `lib/booking-changes-dispatch.js` (distribue),
> `lib/cleaning/sync-menages.js` (ménages), `lib/cron-access.js` (codes d'accès),
> `lib/cron-messages.js` (templates), `api/cron.js` (ordonnancement),
> `migrations/2026-08-31-booking-change-events.sql`.
>
> Mots-clés routage chat : ménage non reçu, notification prestataire, réservation
> modifiée, annulation, code d'accès non régénéré, message de confirmation.

## 1. Pourquoi (écart E2 de l'audit d'unification)

La création des `menage_events` était câblée dans le chemin **Beds24**
(`lib/cron-bookings.js`). Aucun writer Channex n'en produisait : sur un bien
Channex, le prestataire ne recevait **aucune** notification de nouvelle
réservation, de modification ni d'annulation. Le planning lui-même restait
correct (il vient de `bookings_snapshot`, unifié), mais les notifications étaient
absentes.

## 2. Le flux

```
provider (Beds24 cron / Channex webhook / Channex feed / import initial)
        │
        ▼
lib/bookings-snapshot.js          ← SEUL writer de bookings_snapshot
        │  detectChange(previous, merged)  ← AVANT l'upsert : seul instant où
        │                                     l'existant et l'entrant coexistent
        ▼
booking_change_events (processed_at null)
        │
        ▼
lib/booking-changes-dispatch.js   ← appelé par api/cron.js APRÈS tous les snapshots
        ├─ 1. lib/cleaning/sync-menages.js  → menage_events
        ├─ 2. lib/cron-access.js            → cancelAccessCode / refreshAccessCode
        └─ 3. lib/cron-messages.js          → triggerTemplates('booking_confirmed')
```

**Le snapshot reste l'unique mémoire d'état.** Pas de table miroir, pas de colonne
jsonb supplémentaire : la détection a lieu au moment exact où les deux états sont
disponibles. Le webhook Channex passant par le même writer, il produit les mêmes
événements que le cron Beds24 — c'est ce qui ferme E2.

## 3. Règles de typage

Sur les **statuts canoniques** (voir `docs/kb/bookings-snapshot.md`), un seul
événement par booking et par écriture :

| Avant | Après | Événement |
|---|---|---|
| (aucun) | `confirmed` | **new** |
| (aucun) | `request` / `blocked` / `cancelled` | *aucun* |
| non-`confirmed` | `confirmed` | **new** |
| `confirmed` | `cancelled` / `blocked` / `request` | **cancelled** |
| `confirmed` | `confirmed`, un des 4 champs a bougé | **modified** |
| `request` / `blocked` | idem, sans passage à `confirmed` | *aucun* |

Sortir de `confirmed` produit toujours **cancelled**, quelle qu'en soit la raison :
le ménage n'a plus lieu d'être. Un blocage propriétaire (`black` Beds24) ne crée
donc plus de ménage fantôme (correctif E5).

### Les quatre champs de diff
`arrival`, `departure`, `numAdult`, `numChild`. Le nom du voyageur, la source OTA
et le montant ne déclenchent rien.

### `null` vs `0` — la règle qui a coûté 79 350 faux événements
`numEq(a, b)` compare `Number(a || 0)` : `null`, `undefined` et `0` sont **égaux**.
Un writer écrivait `0 || null` → `null`, l'autre `0` ; chaque cycle rejugeait le
booking « modifié » en boucle. Même chose pour `strEq` (`''` = `null`).
Conséquence assumée : un passage réel de « 0 enfant » à « information absente » ne
produit aucun événement — un faux positif coûterait un déplacement inutile à la
femme de ménage.

## 4. Garde anti-boucle (la règle la plus importante)

Un événement est marqué `processed_at` **même si un consommateur échoue**.
L'échec est tracé dans `processing_errors` et dans `automation_incidents`, mais
l'événement n'est **jamais rejoué automatiquement**.

Un retraitement en boucle sur une erreur permanente (une clé Seam morte, un
template cassé) coûterait bien plus cher qu'une notification manquée. Pour
rejouer un événement, il faut remettre son `processed_at` à `null` à la main,
après avoir corrigé la cause.

Le dispatcher traite au maximum **200 événements par cycle**, les plus anciens
d'abord.

## 5. Ordonnancement dans le cron

Le dispatch tourne **après** la mise à jour de tous les snapshots — biens Beds24,
biens channel, et poll du feed Channex — pour que les révisions arrivées dans le
cycle soient distribuées dans le même passage. Voir `api/cron.js` §3quinquies.

## 6. Table `booking_change_events`

`id`, `user_id`, `booking_id`, `property_id` (TEXT = `provider_property_id`),
`provider`, `type` (`new|modified|cancelled`), `changes` jsonb, `created_at`,
`processed_at`, `processing_errors` jsonb. RLS `user_id = auth.uid()` ; écritures
serveur via service key.

**Fail-safe** : tant que la migration n'est pas appliquée, l'insert et la lecture
échouent proprement (log + no-op). Les snapshots s'écrivent normalement, aucun
événement n'est produit ni distribué — le cron ne casse pas.

## 7. Le type `note`

`menage_events.event_type = 'note'` est une **note manuelle de l'hôte**
(`apps/menages/index.html`). Il n'est ni produit ni modifié par ce flux :
`lib/cleaning/sync-menages.js` n'écrit que `new`, `modified` et `cancelled`.
