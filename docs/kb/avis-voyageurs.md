# KB — avis voyageurs : `ota_reviews`

<!-- SOURCES (mapping inverse). ⚠️ DOC en tête de ces fichiers pointe ici. Modif = MÊME COMMIT. -->
> Sources : `lib/cron-channel-reviews.js` (**seul writer** à ce jour),
> `migrations/2026-09-02-ota-reviews.sql` (schéma de référence),
> `docs/specs/spec-avis-voyageurs.md` (spec et écarts).
>
> Mots-clés routage chat : avis, review, note, score, propreté, Airbnb, Booking,
> réponse hôte, ota_reviews.

## 1. Place dans l'architecture

`ota_reviews` appartient au **cœur de données** : écrite par la couche sync
seule, lue par la fiche prestataire et par le futur module de pricing. Aucune app
n'interroge un provider directement (`docs/kb/coeur-de-donnees.md`).

Le rattachement à la réservation se fait par `booking_uid`
(= `bookings_snapshot.booking_id`), résolu en matchant `ota_reservation_id`
contre `snapshot->>'otaReservationCode'`, **toujours filtré par `user_id`**.

## 2. Channex n'a pas une clé par hôte

C'est la différence majeure avec Beds24, et la source du seul vrai risque de ce
module. HôteSmart tourne sous **une clé plateforme** : `GET /reviews` renvoie les
avis de **tous les comptes mélangés**. Le rattachement au bon `user_id` passe
entièrement par `properties.provider_property_id` — comme le fait déjà
`lib/cron-channel-feed.js` pour les réservations.

Le poll distingue trois issues et **n'écrit dans aucune des trois** :

| issue | pourquoi on n'écrit pas |
|---|---|
| bien absent | l'avis n'appartient à aucun compte HôteSmart |
| bien **ambigu** (2 lignes) | `provider_property_id` n'a aucune unicité globale ; deviner = écrire l'avis d'un hôte chez un autre |
| panne SQL | une panne n'est pas une absence |

## 3. Ce que les données réelles ont démenti

Relevé sur les 70 avis du premier poll (68 Airbnb, 2 Booking.com) :

- **`reply` est un objet, pas une chaîne**, et il est **vide** dans 68 cas sur 70.
  Écrit tel quel dans une colonne `text`, il produisait la chaîne `"{}"` : une
  réponse fantôme sur 68 lignes. La forme réelle est `{ reply: "<texte>" }`. Le
  signal fiable du « déjà répondu » est `is_replied`, pas la présence de `reply`.
- **Les échelles de notes ne coïncident pas entre OTA.** Chez Booking, un
  `overall_score` de 1 coexiste avec des catégories toutes à 2.5. D'où le choix
  de **stocker brut** : la mise à l'échelle est un calcul d'app, corrigeable ; une
  conversion à l'ingestion serait gravée dans le cœur.
- **`raw_content` n'a pas les mêmes clés selon l'OTA** :
  `{public_review, private_feedback}` chez Airbnb, `{headline, positive, negative}`
  chez Booking, où tout est public.

## 4. Dette — la résolution des avis anciens

**11 avis sur 70 seulement sont rattachés à une réservation.** Ce n'est pas un
défaut du poll : les avis couvrent **octobre 2024 → août 2026**, quand
`bookings_snapshot` ne garde que **17 réservations** de ce bien, sur une fenêtre
de six semaines. 11 sur 17, c'est le maximum atteignable aujourd'hui.

**Arbitrage rendu (2 septembre 2026) : on accepte 11/70.** Ni élargissement de la
fenêtre de fetch des réservations, ni dates approximées depuis `received_at` —
**jamais de donnée inventée dans le cœur**.

**Ce qui lèvera la dette** : le chantier **historique des réservations** (fil
YieldFlow). Quand cet historique existera, les avis non résolus seront re-matchés
contre lui. **Aucun code à écrire pour cela** : le poll relit tous les avis à
chaque passage quotidien et retente la résolution de chacun tant que
`booking_uid` est null. L'historique importé sera donc absorbé au passage suivant,
sans reprise manuelle.

Conséquence à connaître d'ici là : les 59 avis non résolus n'ont ni `stay_start`
ni `stay_end`, donc **aucun ancrage temporel pour le pricing**. Les 11 résolus
gardent leurs dates même si leur snapshot disparaît, puisqu'elles sont
dénormalisées à l'ingestion.

## 5. Garde-fous du poll dans le cron

- **Cadence quotidienne** par marqueur `cron_logs.id = 'channel_reviews_poll'`.
- **Le marqueur est posé AVANT le travail.** Posé après, une invocation tuée par
  le plafond de 60 s ne l'aurait jamais écrit : le poll serait reparti à chaque
  tick de 5 min, en boucle, mangeant le budget du reste du cycle. Le prix de ce
  choix est de perdre au pire une journée d'avis, que le passage suivant rattrape
  puisqu'il relit tout et que l'upsert est idempotent.
- **Budget mur de 20 s**, reliquat au lendemain.
- **Index des codes OTA chargé une fois par compte.** Une requête
  `bookings_snapshot` par avis coûtait 26 s pour un budget de 20 s. La clé de cet
  index est le code OTA seul — licite **uniquement** parce que l'index est
  construit par `.eq('user_id', …)` et rangé sous ce `user_id` : le cloisonnement
  est porté par la structure. Fusionner ces index entre comptes réintroduirait la
  collision que `REVIEW.md` règle 1 décrit.
- **Écriture par lot, une requête par page.** L'upsert unitaire coûtait ~140 ms
  pièce, ce qui plafonnait le passage à environ **140 avis** une fois le budget
  atteint. Comme le poll repart toujours de la page 1 et qu'il n'y a pas de
  curseur, les avis au-delà n'auraient jamais été ingérés — ni ce jour-là, ni
  les suivants. Le lot ramène 70 avis de 9,8 s à **2,3 s** et repousse le plafond
  à plusieurs milliers. L'ordre est explicite (`order[received_at]=desc`) pour
  que, si troncature il y a, ce soient les avis les plus anciens qui attendent.
- **Une troncature sur budget n'est jamais silencieuse** : elle remonte dans
  `results.errors` du cycle. Une troncature muette ressemble à un passage réussi.
- **Dette connue** : il n'y a pas de curseur de reprise. À très grande échelle,
  la parade reste le lot + le signalement. Un curseur (page atteinte ou
  `received_at` du dernier avis) serait la vraie réponse le jour venu.

## 6. Reste à faire

- ~~Webhook `updated_review`~~ **fait**. Routé par `api/channel-events.js`, le
  **2e** webhook — celui qui existe parce que `api/channel-webhook.js` porte la
  mention « code certifié Channex, NON modifié » et que la certification PMS est
  en revue. Le propos de ce fichier est donc élargi aux avis, ce que son en-tête
  assume. Un 3e webhook dédié aurait été plus propre sémantiquement, mais le
  gestionnaire de canaux peut refuser un webhook de plus (le fichier prévoit
  déjà ce refus pour le 2e), et le poll reste la source de vérité de toute façon.
  - **Le webhook écrit par le MÊME writer que le poll** (`preparerAvis` +
    `upsertAvis`) : mêmes gardes de cloisonnement, même contrainte
    d'idempotence. Rejouer un event est sans effet.
  - Le payload n'étant pas documenté, les deux formes sont acceptées : avis
    complet, ou identifiant seul suivi d'une relecture `GET /reviews/:id`.
  - Le webhook répond **200 même en échec**, exception réseau comprise : le
    routage a son propre `try/catch`, qui ne rejoint pas le `catch` global du
    handler (celui-ci répond 500, donc « retente »). Sans lui, une coupure vers
    le gestionnaire suffisait à lancer une boucle de rejeu et à réveiller le
    canal fondateur pour une panne que le poll rattrape seul.
  - ⚠ **`register` ne peut cibler que le webhook de ce fichier.** `callback_url`
    vient du client : sans garde, une session authentifiée quelconque pouvait
    faire réécrire le masque du webhook **certifié** — dont l'URL est publique —
    et couper `booking;message` pour tous les hôtes Channex, avec une réponse
    « succès ». Deux gardes, volontairement redondantes : l'URL doit finir par
    `/api/channel-events`, et tout webhook dont le masque contient `booking` ou
    `message` est refusé. Le PUT renvoie aussi `headers` et `request_params` :
    les omettre ferait perdre le secret partagé si le gestionnaire remplace
    l'objet au lieu de le fusionner — webhook mort, pas seulement masque cassé.
  - Si la liste des webhooks est illisible, **aucune création à l'aveugle** :
    un doublon livrerait chaque event deux fois.
  - ⚠ **Élargir `CHANNEL_EVENTS` ne suffit pas** sur un webhook déjà enregistré.
    L'action `register` cherche l'existant et le met à jour (`PUT`), et ne crée
    qu'à défaut. Sans cette mise à jour côté Channex, `updated_review` n'arrive
    jamais — dégradé, pas cassé : le poll continue.
- **Beds24** : aucune lecture d'avis identifiée à ce jour. En attente de
  vérification de la doc Swagger authentifiée.
- **Classification IA** de la propreté (`ai_clean_verdict`, `ai_clean_excerpt`).
