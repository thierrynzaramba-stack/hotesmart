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
  - ⚠ **La cible de `register` est construite par le serveur, jamais reçue.**
    C'est le point qui a coûté deux constats de sécurité successifs, chacun
    trouvé sur le correctif du précédent.
    1. `callback_url` venait du client et désignait la cible d'un `PUT` : une
       session authentifiée quelconque réécrivait le masque du webhook
       **certifié** — dont l'URL est publique — coupant `booking;message` pour
       tous les hôtes Channex, avec une réponse « succès ».
    2. Le correctif validait alors le **chemin** de cette URL. Insuffisant :
       `https://evil.example.com/api/channel-events` a un chemin parfaitement
       valide, et le `POST` de création y aurait fait livrer, en clair,
       `CHANNEL_WEBHOOK_SECRET` et le bypass Vercel — de quoi ensuite forger
       des events sur le webhook certifié.

    **La leçon** : on ne valide pas une donnée client qui désigne une
    ressource, on ne l'utilise pas. L'URL est bâtie depuis `DOMAINES_APP` ; un
    `callback_url` fourni et divergent est refusé au lieu d'être ignoré en
    silence. Filet redondant conservé : tout webhook dont le masque contient
    `booking` ou `message` est refusé, casse ignorée.

    Le `PUT` renvoie aussi `headers` et `request_params` : les omettre ferait
    perdre le secret partagé si le gestionnaire remplace l'objet au lieu de le
    fusionner — webhook mort, pas seulement masque cassé. Et une entrée trouvée
    sans identifiant arrête le traitement au lieu de tomber sur la création,
    qui produirait un doublon livrant chaque event deux fois.
  - Si la liste des webhooks est illisible, **aucune création à l'aveugle** :
    un doublon livrerait chaque event deux fois.
  - ⚠ **Élargir `CHANNEL_EVENTS` ne suffit pas** sur un webhook déjà enregistré.
    L'action `register` cherche l'existant et le met à jour (`PUT`), et ne crée
    qu'à défaut. Sans cette mise à jour côté Channex, `updated_review` n'arrive
    jamais — dégradé, pas cassé : le poll continue.
- **Beds24** : aucune lecture d'avis identifiée à ce jour. En attente de
  vérification de la doc Swagger authentifiée.
- **Classification IA** de la propreté (`ai_clean_verdict`, `ai_clean_excerpt`).

## 7. Classification de la propreté — deux étages

**Étage 1, une règle déterministe, aucun appel IA.** Airbnb livre déjà des tags
de propreté (`squeaky_clean_bathroom`, `pristine_kitchen`, `spotless_*`,
`free_of_clutter`) et une note de catégorie. Payer un modèle pour redire ce
qu'Airbnb dit en clair serait absurde — et surtout moins auditable : une règle se
relit, un verdict de modèle se croit.

**Étage 2, Haiku, seulement sur ce que la règle ne tranche pas.** 30 des 70
premiers avis n'ont **aucun** tag (Booking n'en fournit jamais), et 13 parlent de
propreté dans leur texte sans qu'aucun tag ne le signale.

**Première passe réelle sur les 70 avis** : 27 tranchés par la règle, 41 par
l'IA, 2 sans texte, **0 erreur**. Verdicts : 40 `positif`, 1 `remarque`,
29 `rien_signale`.

### Ce que l'étage 2 a trouvé et qu'aucun signal structuré ne donnait

La seule `remarque` du jeu porte sur un avis dont le `score_clean` vaut **10/10**
et qui porte **quatre tags positifs**. Le défaut est dans le **retour privé** :
« la bouilloire n'était pas du tout propre ». Ni la note, ni les tags, ni l'avis
public ne l'auraient jamais révélé. C'est exactement ce que l'étage 2 existe pour
attraper.

### ⚠ Asymétrie assumée entre OTA — ne pas « harmoniser »

Le seuil de note (`score_clean ≤ 6` → `remarque`) ne s'applique **qu'à Airbnb**,
dont l'échelle sur 10 est connue et cohérente. Chez Booking, les échelles ne
coïncident pas : `overall_score` de 1 avec toutes les catégories à 2.5, overall
de 10 avec catégories à 7.5. Comme on stocke brut sans normaliser (§3), un seuil
sur ces valeurs serait un pari. **Les avis Booking sans tag passent directement à
l'étage 2 : le texte tranche.**

### Rien d'invérifiable n'entre en base

- un verdict hors des trois classes est **rejeté** (la colonne porte un CHECK) ;
- **l'extrait est vérifié comme citation réelle** : s'il ne se retrouve pas mot
  pour mot dans le texte, il est mis à `null`. Une reformulation affichée au
  prestataire passerait pour une parole du voyageur. Mesuré : **0 extrait non
  retrouvé** sur les 13 posés.
  - Limite connue : la comparaison est stricte. Un avis dont le texte contient
    « tres propre » a perdu son extrait pour un écart de forme. Verdict correct,
    citation absente. Normaliser les espaces et la casse avant comparaison
    récupérerait ces cas — dette mineure, non traitée.
- un **échec** (appel IA en erreur, réponse illisible) **ne pose pas**
  `ai_analyzed_at` : l'avis repasse. Le poser le sortirait de la file pour
  toujours.
- un avis **sans tag et sans texte** est classé `rien_signale` et sort de la
  file : sinon il y reviendrait à chaque passage, indéfiniment (2 avis sur 70).

### Réanalyse quand le texte change

Trigger `ota_reviews_touch` (migration `2026-09-02-ota-reviews-reanalyse.sql`) :
si `content`, `content_public` ou `content_private` change, `ai_analyzed_at`,
`ai_clean_verdict` et `ai_clean_excerpt` repassent à `null`. Un verdict périmé
sur la fiche prestataire serait pire que pas de verdict.

**`reply` en est volontairement exclu** : quand l'hôte répond, l'avis change,
mais ce que le voyageur a dit de la propreté ne change pas. Réanalyser dessus
ferait repasser tout l'historique par le modèle pour un verdict identique.

Le trigger plutôt que du code parce que deux writers alimentent la table et que
le poll écrit **par lot sans relire l'existant** : la comparaison côté JS
coûterait une lecture par avis — le coût qu'on a justement supprimé. Le trigger
voit `OLD` et `NEW`, aucun writer ne peut l'oublier.

### Coût réel, mesuré

Un appel : **418 tokens d'entrée, 45 de sortie**. Sur les 70 avis, seuls 41 ont
appelé le modèle → environ **17 000 tokens d'entrée et 1 800 de sortie** pour
tout l'historique. Aux tarifs Haiku, cela se compte en **centimes, une fois**.

En rythme de croisière, 70 avis couvrent presque deux ans sur un bien, soit ~3
par mois ; à dix biens, ~30 avis/mois dont la moitié tranchée par la règle. **Le
coût n'est pas un critère de décision ici** — l'auditabilité l'est.

### Garde-fous dans le cron (bloc 4sexies)

Cadence quotidienne, **marqueur posé avant le travail**, budget mur de 15 s, lot
borné à 20 avis. Mesuré sur la première passe : ~12 s pour 20 avis, et le budget
a effectivement coupé une passe à 15 avis — le garde-fou fonctionne. Le reliquat
part au passage suivant, la file étant persistante en base.
