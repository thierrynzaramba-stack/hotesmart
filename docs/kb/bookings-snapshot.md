# KB — bookings_snapshot : table unifiée des réservations

<!-- SOURCES (mapping inverse). ⚠️ DOC en tête de ces fichiers pointe ici. Modif = MÊME COMMIT. -->
> Sources : `lib/bookings-snapshot.js` (**seul writer**), `lib/cron-bookings.js`,
> `lib/channels/beds24.js` (syncBookings), `api/channel-events.js` (import initial),
> `api/channel-webhook.js` (temps réel Channex), `lib/cron-channel-feed.js` (filet */5).
> Lecteurs normalisés : `api/menages-public.js`, `lib/cron-arrival-code.js`,
> `lib/cron-messages.js`, `api/calendar.js`.
>
> Mots-clés routage chat : réservation, statut, annulé, blocage, ménage fantôme,
> snapshot, provider, unification.

## 1. Pourquoi ce module (audit d'unification, écarts E3/E4/E5)

Cinq writers écrivaient la même ligne de `bookings_snapshot` avec des schémas
différents (7 champs côté `lib/cron-bookings.js`, 12 ou 13 ailleurs) et deux
vocabulaires de statut. Conséquences constatées :

- **E3** — le writer pauvre écrasait les métadonnées OTA (`otaReservationCode`,
  `source`, `amount`, `currency`) écrites par le writer riche. Le contenu final
  dépendait de l'ordre d'exécution du cron.
- **E4** — la colonne `provider` n'existait que dans un writer sur cinq : impossible
  de savoir de façon fiable d'où venait une ligne.
- **E5** — `black` (blocage propriétaire Beds24) et `inquiry` (demande) n'étaient pas
  reconnus par tous les lecteurs. Un blocage propriétaire apparaissait comme une
  réservation active et créait un **ménage fantôme** au planning du prestataire.

## 2. Règle absolue

**`lib/bookings-snapshot.js` est le seul writer autorisé de `bookings_snapshot`.**
Aucun `upsert` / `insert` direct sur cette table ailleurs dans le repo.
Seule exception : la purge à la suppression d'un bien (`api/channel-property.js`),
qui supprime des lignes mais n'en écrit aucune.

Toute nouvelle source de réservations (nouveau provider, import manuel) passe par
`saveBookingSnapshot()` et fournit son mapper.

## 3. Statuts canoniques

Quatre valeurs, identiques quel que soit le provider :

| Canonique   | Sens                                    | Occupe le calendrier | Génère un ménage |
|-------------|-----------------------------------------|----------------------|------------------|
| `confirmed` | réservation réelle                      | oui                  | **oui**          |
| `cancelled` | annulée                                 | non                  | non              |
| `blocked`   | blocage propriétaire / maintenance      | oui                  | non              |
| `request`   | demande non confirmée                   | non                  | non              |

Correspondances appliquées **à l'écriture** :

Listes officielles, vérifiées sur la documentation des deux providers :
- **Beds24 v2** : `new` | `confirmed` | `request` | `cancelled` | `black`
  (wiki.beds24.com, Category:Bookings). `new` = réservation reçue non encore ouverte ;
  elle passe à `confirmed` dès qu'elle est ouverte et enregistrée — les deux sont donc
  des réservations réelles.
- **Channex v1** : `new` | `modified` | `cancelled`
  (docs.channex.io, Bookings Collection : « can be one of three values »).

| Brut provider          | Beds24      | Channex     |
|------------------------|-------------|-------------|
| `new`                  | confirmed   | confirmed   |
| `confirmed`            | confirmed   | —           |
| `modified`             | —           | confirmed   |
| `request`              | request     | —           |
| `inquiry`              | request*    | —           |
| `black`                | **blocked** | —           |
| `cancelled`            | cancelled   | cancelled   |
| vide / absent          | confirmed   | confirmed   |
| inconnu                | confirmed + warn en log | confirmed + warn en log |

\* `inquiry` n'est **pas** documenté par Beds24 (qui utilise `request`) : mapping
défensif, pour qu'un tel statut ne soit jamais traité comme réservation active.

Aucun statut réellement émis par les deux providers ne passe par le fallback : c'est
verrouillé par test (`zero warn`), sinon chaque nouvelle réservation polluerait les
logs Vercel à chaque cycle cron.

Le statut brut est conservé dans `snapshot.statusRaw` pour le debug.

**Valeur inconnue → `confirmed`** : choix délibéré. C'est le comportement historique
(tout ce qui n'était pas `cancelled` était traité comme actif) ; on ne le régresse pas
sur un cas non spécifié, mais on le rend visible dans les logs Vercel.

### Lecture
Ne jamais tester `snapshot.status === 'cancelled'` en dur. Utiliser :
- `readStatus(snapshot)` → statut canonique, **tolère les lignes écrites avant
  l'unification** (vocabulaire brut) : aucun backfill SQL n'est nécessaire ;
- `isActiveStatus(snapshot)` → `true` seulement si `confirmed`.

## 4. Schéma du champ `snapshot` (jsonb)

`provider`, `status`, `statusRaw`, `arrival`, `departure`, `arrivalHour`, `firstName`,
`lastName`, `numAdult`, `numChild`, `source`, `otaReservationCode`, `amount`, `currency`.

`otaReservationCode` est la clé de rattachement des avis voyageurs
(Beds24 : `apiReference` ; Channex : `ota_reservation_code`).
Non fournis par l'API Beds24 v2 bookings : `arrivalHour`, `amount`, `currency`.

## 5. Merge non destructif

Un champ **non fourni** (`undefined`) par un mapper ne remet jamais à `null` la valeur
déjà en base : `saveBookingSnapshot` relit la ligne existante et fusionne. Un champ
fourni **à `null`** écrase, lui — c'est une information (« ce provider sait qu'il n'y a
pas de valeur »). Les mappers laissent donc `undefined` ce que leur provider ne sait
pas fournir, jamais `null`.

L'appelant qui a déjà lu la ligne passe `existing` pour éviter une seconde lecture.

## 6. Clés

`bookings_snapshot.property_id` est du **TEXT** = `properties.provider_property_id`
(propId Beds24 numérique ou UUID Channex). Ce n'est **pas** `properties.id` (UUID).
Aucune FK, donc aucune cascade : la purge est explicite à la suppression d'un bien.

Les nouvelles tables métier (prestataires, avis voyageurs) référencent en revanche
`properties.id` (UUID), seule clé stable quand un bien migre de Beds24 vers Channex.
Le pont UUID → provider_property_id passe par un helper dédié, jamais par une jointure
ad hoc.

## 7. Tests

`npm test` (`node --test`, aucune dépendance). `tests/bookings-snapshot.test.js` couvre
le mapping de statuts des deux providers, les cas limites (vide, inconnu, casse,
idempotence), la lecture des lignes antérieures à l'unification et le merge non
destructif.
