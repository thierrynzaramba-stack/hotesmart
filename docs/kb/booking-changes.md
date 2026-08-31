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

## 3 bis. Garde d'ancienneté : pas d'envoi de masse

Un séjour **terminé depuis plus de 7 jours** ne produit aucun événement, quel que
soit l'état précédent.

Sans cette garde, la première activation d'un bien Channex déclenchait un envoi de
masse : `api/channel-events.js` appelle `getReservations()` **sans fenêtre de
date**, donc tout l'historique OTA remonte ; chaque réservation, inconnue en base,
produisait un `new` — soit un message « bienvenue » à des voyageurs partis depuis
des mois, et une avalanche de `menage_events` sur des dates passées. Le chemin
Beds24 était borné par sa fenêtre de fetch (`-1j/+90j`), pas le chemin Channex.

La marge de 7 jours laisse passer une réservation saisie en retard ou un départ
tout juste passé (la PWA prestataire remonte les départs jusqu'à J-14).

## 3 ter. Isolation multi-comptes

Le dispatcher traite un lot **multi-comptes** et tourne avec la service key, qui
contourne la RLS. Les filtres explicites sont donc la **seule** défense :

- `tokensPourBien(tokens, propertyId, userId)` — un token « tous les biens »
  (`property_ids` vide) d'un hôte B satisferait sinon n'importe quel bien d'un
  hôte A, et la PWA prestataire lit `menage_events` **par token seul**
  (`api/menages-public.js`) : le prestataire de B verrait les voyageurs de A.
- Toutes les maps de contexte sont indexées par `user_id|identifiant`, jamais par
  l'identifiant seul : la clé primaire de `bookings_snapshot` est
  `(user_id, booking_id)`, et `provider_property_id` n'a **aucune** contrainte
  d'unicité globale (deux hôtes d'un même property manager Beds24 peuvent porter
  le même propId). Sans cela, le dispatcher enverrait le voyageur d'un hôte dans
  le message et le code d'accès d'un autre.

## 3 quater. Reconstruction du bien

`propertyDepuisContexte()` reconstruit le bien au format attendu par les
consommateurs historiques, qui recevaient l'objet **brut** de l'API Beds24 :

- `provider` commande le routage d'envoi (`sendGuestMessage`). Sans lui, un hôte
  Channex-only partirait vers `sendViaBeds24` sans clé → échec silencieux ; et
  `message_sent_log` étant écrit **avant** l'envoi, le message ne serait jamais
  rejoué.
- `address`, `phone`, `checkInStart`, `checkOutEnd` alimentent les placeholders
  `{adresse}`, `{telephone_hote}`, `{checkin}`, `{checkout}`. Ils viennent de
  `properties` et de `knowledge` (type `fixed`), la source configurée par l'hôte.

## 3 quinquies. Interaction avec le kill switch

Le flux **ne consulte pas** `automation_paused` : les événements sont produits et
distribués même sur un bien en pause. Ce sont les consommateurs qui filtrent, et
seulement ceux tournés vers le voyageur (`triggerTemplates`, `refreshAccessCode`).
Les `menage_events` continuent donc d'être écrits — décision produit, voir
`docs/kb/alertes.md` §3.

Un consommateur qui s'abstient pour cause de pause n'est pas une erreur :
l'événement est marqué traité, rien n'est rejoué à la réactivation.

## 3 sexies. Import initial : matérialiser sans distribuer

`saveBookingSnapshots({ ..., initialImport: true })` écrit les événements **déjà
marqués traités**. `api/channel-events.js` l'utilise à l'activation d'un canal.

La garde d'ancienneté ne borne que le **passé** : à l'activation d'un bien Channex,
les réservations **à venir** (prises il y a des mois) sont toutes inconnues en base
et produiraient chacune un `new` — donc un message de bienvenue tardif et un
`menage_event`. Le drapeau peuple `bookings_snapshot` correctement pour les
lecteurs (calendrier, planning) sans rien distribuer.

## 3 septies. Ordre d'écriture dans le writer

Le changement est journalisé **avant** l'upsert du snapshot, et le snapshot
n'avance pas si la journalisation échoue.

Le snapshot est la seule mémoire d'état : une fois avancé, le changement n'est plus
détectable. Journaliser après signifierait qu'un insert en échec (migration pas
encore appliquée, coupure réseau) perd le changement **définitivement et en
silence**. Dans cet ordre, un upsert en échec laisse au pire un événement en double
au cycle suivant : du bruit, pas une perte.

## 4. Garde anti-boucle (la règle la plus importante)

Un événement est marqué `processed_at` **même si un consommateur échoue**.
L'échec est tracé dans `processing_errors` et dans `automation_incidents`, mais
l'événement n'est **jamais rejoué automatiquement**.

Un retraitement en boucle sur une erreur permanente (une clé Seam morte, un
template cassé) coûterait bien plus cher qu'une notification manquée. Pour
rejouer un événement, il faut remettre son `processed_at` à `null` à la main,
après avoir corrigé la cause.

Le dispatcher traite au maximum **25 événements par cycle** (les plus anciens
d'abord) et s'arrête au bout de **25 secondes**. `api/cron.js` est plafonné à
`maxDuration: 60` et chaque `new` peut coûter un appel Haiku plus un appel Seam :
un lot trop gros épuisait le budget avant les sondes d'alerting et le heartbeat
`cron_logs`. Être tué entre les consommateurs et le marquage `processed_at`
rejouerait l'événement à chaque cycle — exactement ce que la garde évite. Le
reliquat part au cycle suivant, 5 minutes plus tard.

**Le dispatch est la dernière étape du cron**, après les sondes : ce sont elles qui
détectent les rafales d'écriture qu'il peut produire.

Si le marquage lui-même échoue, un incident est levé (`RISQUE DE REJEU`) : c'est le
seul cas où la garde ne tient pas.

## 5. Ordonnancement dans le cron

Le dispatch tourne **après** la mise à jour de tous les snapshots — biens Beds24,
biens channel, et poll du feed Channex — pour que les révisions arrivées dans le
cycle soient distribuées dans le même passage. Voir `api/cron.js` §3quinquies.

## 5 bis. Erreurs de lecture : reporter, ne pas consommer

Les lectures de contexte (`api_keys`, `bookings_snapshot`, `public_tokens`,
`properties`, `knowledge`) **remontent** leurs erreurs. Une liste vide renvoyée
silencieusement serait indiscernable d'un cas nominal (« cet hôte n'a pas de
prestataire ») : les événements seraient consommés à vide et marqués traités, donc
perdus pour de bon. En cas d'échec, le lot entier est reporté au cycle suivant et
un incident est levé.

## 6. Table `booking_change_events`

`id`, `user_id`, `booking_id`, `property_id` (TEXT = `provider_property_id`),
`provider`, `type` (`new|modified|cancelled`), `changes` jsonb, `created_at`,
`processed_at`, `processing_errors` jsonb.

**RLS en LECTURE SEULE côté client** : une seule policy `select`, aucune policy
d'écriture pour `authenticated`. Une policy `insert` contrôlant `user_id` laisserait
`booking_id` et `property_id` libres — un hôte connecté pourrait faire annuler le
code d'accès du voyageur d'un autre hôte en insérant un événement `cancelled`
nommant sa réservation, que le dispatcher exécuterait en service key. Une policy
`update` permettrait de rejouer des événements à volonté ; `delete`, d'effacer les
traces. Les écritures passent exclusivement par la service key.

La table est purgée explicitement à la suppression d'un bien
(`api/channel-property.js`) et surveillée par la sonde de croissance
(`lib/cron-alerting.js`).

**Fail-safe** : tant que la migration n'est pas appliquée, l'insert et la lecture
échouent proprement (log + no-op). Les snapshots s'écrivent normalement, aucun
événement n'est produit ni distribué — le cron ne casse pas.

## 7. Le type `note`

`menage_events.event_type = 'note'` est une **note manuelle de l'hôte**
(`apps/menages/index.html`). Il n'est ni produit ni modifié par ce flux :
`lib/cleaning/sync-menages.js` n'écrit que `new`, `modified` et `cancelled`.
