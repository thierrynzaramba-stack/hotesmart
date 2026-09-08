# Protocole — staging Channex : quand les tarifs partent-ils vraiment ?

> Écrit le 8 septembre 2026, **avant** toute exécution, à la demande de Thierry.
> Sert le chantier `docs/specs/spec-migration-channex.md`.
> Environnement : `CHANNEX_STAGING_URL` / `CHANNEX_STAGING_API_KEY`.

## Pourquoi ce test

La règle gravée par Thierry : **aucun rate plan, aucun prix, aucune grille
d'occupation ne part vers Channex ou les OTA à la connexion sans sa validation
explicite.** La sync tarifaire est un acte séparé de la connexion.

Trois questions commandent où placer le cran d'arrêt. Y répondre par supposition
reviendrait à modifier un chemin certifié sans savoir s'il fallait le toucher.

## Règles d'exécution (non négociables)

1. **Staging uniquement.** Aucune requête vers `app.channex.io` pendant ce test.
   Le script refuse de démarrer si l'URL de base n'est pas celle du staging.
   ⚠ Piège connu (mémoire projet) : une URL de staging **sans** `/api/v1` rend
   `200` + du HTML, et se lit comme « 0 bien » — silencieusement.
2. **Propriété jetable**, créée pour ce test, nommée `ZZ-TEST-TARIFS-<horodatage>`
   pour être reconnaissable entre toutes.
3. **Aucun canal OTA réel n'est connecté.** La question (2) porte sur le flux de
   mapping, qui s'observe sur la structure du canal — pas sur une vraie annonce.
4. **Nettoyage complet en fin de test**, et vérification que la propriété a bien
   disparu. En cas d'interruption, l'identifiant créé est journalisé pour être
   supprimé à la main.
5. **Rien de ce qui est appris ici ne modifie un chemin certifié** sans un
   arbitrage explicite de Thierry.

## Question 1 — la grille est-elle active dès la création du rate plan ?

**Ce qu'on veut savoir** : une grille de prix créée avec le rate plan est-elle
déjà « vendable » côté Channex, ou n'a-t-elle d'effet qu'une fois un canal mappé
et activé ?

**Enjeu direct** : si la grille ne devient visible qu'au mapping, le cran d'arrêt
se place **avant le mapping**, et `api/channel-property.js` (le provisioning,
chemin certifié) **n'a pas à être touché du tout**.

**Mesure**
1. Créer propriété, room_type, rate_plan avec une grille d'occupation reconnaissable
   (des prix improbables : 111, 222, 333 — jamais un prix plausible qui pourrait
   être pris pour un vrai tarif si quelque chose fuyait).
2. Relire `GET /rate_plans/{id}` : la grille est-elle stockée ? Avec quel état ?
3. Relire `GET /channels` : existe-t-il un canal ? (attendu : aucun)
4. Chercher tout indicateur d'état de publication sur le rate plan
   (`is_active`, `published`, `sync_category`, ou équivalent) et le relever
   **littéralement**, sans l'interpréter.

**Verdict attendu** : « la grille est stockée mais inerte tant qu'aucun canal
n'est mappé » **ou** « la grille est active dès la création ». Toute autre
réponse est un troisième cas, à rapporter tel quel.

## Question 2 — un rate plan neutre traverse-t-il le flux de mapping ?

Ne se pose **que si** la réponse à (1) est « active dès la création ».

**Ce qu'on veut savoir** : peut-on créer un rate plan sans grille dérivée des
prix réels — mono-option, valeur neutre — et le mapper comme le fait le flux
validé en certification, sans que Channex le refuse ?

**Mesure**
1. Créer un second rate plan « neutre » (une seule option, `per_room`).
2. Tenter le mapping tel que le code le fait aujourd'hui (structure de
   `POST /channels` et `POST /channels/{id}/mappings`), **sans activer**.
3. Relever : le mapping est-il accepté ? Une erreur de validation apparaît-elle ?
   Le canal reste-t-il en `is_active: false` ?

**Verdict attendu** : « oui, un rate plan neutre est mappable » ou « non, Channex
exige une grille complète », avec le message d'erreur exact.

## Question 3 — une date poussée SANS champ `rate`

**Ce qu'on veut savoir** : `POST /restrictions` avec toutes les restrictions
d'une date mais **sans** le champ `rate` est-il accepté ? Et que devient cette
date : fermée à la vente, ignorée, en erreur ?

**Enjeu direct** : c'est l'issue que Thierry vise. Avec son modèle « prix par
date uniquement », les nuits non tarifées ne doivent **jamais** partir à 0 €.
Si l'omission est acceptée, `lib/channel-fullsync.js` peut pousser l'état complet
de chaque date en omettant seulement `rate` — sans rien retirer de ce que la
certification #1 exige (« tous les champs déclarés présents sur chaque date »).

**Mesure**
1. Sur le rate plan de test, pousser trois dates :
   - date A : restrictions complètes **avec** `rate`
   - date B : restrictions complètes **sans** `rate`
   - date C : restrictions complètes avec `rate: 0` (le comportement actuel)
2. Relever le code HTTP et le corps de réponse pour chacune.
3. Relire l'ARI par `GET` : que porte chaque date ?
4. Relever ce que Channex expose comme disponibilité/prix pour B et C.

**Sur « qu'affiche l'OTA »** — à dire franchement : **ce protocole ne peut pas y
répondre.** Aucune annonce OTA réelle n'est connectée sur le staging, et en
connecter une pour l'observer reviendrait à exposer un bien de test sur une
place de marché. Ce que le test peut établir, c'est ce que **Channex** accepte et
restitue ; ce que Booking ou Airbnb en affichent ensuite ne s'observera qu'à la
migration réelle, sur une date lointaine et sous surveillance. La question reste
donc **ouverte** après ce protocole, et c'est une limite à assumer, pas à masquer.

## Nettoyage

1. `DELETE /properties/{id}` (la cascade emporte room_types et rate_plans).
2. Relire `GET /properties` : la propriété de test ne doit plus apparaître.
3. Journaliser la suppression. Si elle échoue, **le dire** et donner
   l'identifiant à supprimer à la main — jamais un nettoyage supposé.

## Restitution

Un verdict **par question**, factuel, avec les codes HTTP et les corps de
réponse observés. Une question sans réponse claire est rapportée comme telle,
jamais comblée par une déduction.
