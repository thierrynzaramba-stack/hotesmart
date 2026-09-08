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

---

# VERDICT — exécution du 8 septembre 2026

Deux passages. Le premier portait deux défauts de méthode, corrigés avant de
conclure : il manquait le `group_id` (le `POST /channels` rendait 422 « You not
have access to requested group » — une erreur de **groupe**, muette sur le rate
plan), et aucune disponibilité n'était poussée, si bien que les trois dates
ressortaient `availability: 0` — **une date indisponible n'est pas vendable quel
que soit son prix, le test ne mesurait rien.**

Chiffres du second passage. 15 appels, tous vers `staging.channex.io/api/v1`.
Propriété de test supprimée et **disparition vérifiée**.

## Question 1 — la grille est-elle active dès la création ?

**Réponse : rien ne peut partir sans canal, et il n'y en a aucun.**

Le rate plan porte sa grille dès sa création (options à 111/222/333 relues
telles quelles). Aucun attribut `is_active`, `published` ou `sync_category`
n'apparaît sur un rate plan — cette notion n'existe pas à ce niveau. En
revanche `GET /channels` rend **0 canal** : la grille n'a aucun destinataire.

**Conséquence pour le chantier : le cran d'arrêt se place AVANT LE MAPPING, et
`api/channel-property.js` — le provisioning, chemin certifié — n'a pas à être
touché.** C'est la réponse que Thierry espérait.

⚠ À dire comme tel : c'est une déduction structurelle (pas de canal, pas de
destinataire), pas l'observation d'un drapeau « inactif ». Elle est solide, elle
n'est pas une mesure directe.

## Question 2 — un rate plan neutre traverse-t-il le mapping ?

**NON TRANCHÉE.** Le rate plan neutre est créé sans difficulté (`per_room`, une
option, HTTP 201). Mais le `POST /channels` rend **HTTP 500 Internal Server
Error** — pas une erreur de validation. Cause probable : le `hotel_id` fictif
(`0000000`) fait échouer Channex quand il tente de joindre Booking.com.

Trancher cette question demanderait un vrai `hotel_id` Booking sur le staging,
ce qu'on ne fera pas. **Elle reste ouverte — et elle n'a plus besoin d'être
tranchée si la question 1 tient** : sans mapping, rien ne part, donc le rate
plan neutre ne sert plus à rien.

## Question 3 — une date poussée SANS champ `rate`

**Réponse : acceptée, mais elle NE FERME RIEN. C'est le verdict important, et il
contredit l'orientation.**

| date | poussée | `rate` relu | `availability` |
|---|---|---|---|
| A | avec `rate: 11100` | **111.00** | 1 |
| B | **sans champ `rate`** | **333.00** | 1 |
| C | avec `rate: 0` | **333.00** | 1 |

Les trois formes sont acceptées (HTTP 200). Mais :

- **Omettre `rate` ne produit pas une date sans prix.** La date reste vendable,
  **au prix par défaut de l'option du rate plan** (333 €) — un prix que l'hôte
  n'a pas choisi pour cette date.
- **`rate: 0` n'est pas appliqué** : la valeur reste 333. Le risque « un 0 €
  part chez l'OTA » par ce chemin est donc **nul** — Channex l'ignore.

**L'issue visée par Thierry ne produit pas l'effet attendu.** Omettre le champ ne
protège pas : ça vend au tarif du rate plan.

**Ce qui ferme réellement une date sans prix, c'est de la FERMER** —
`stop_sell: true` ou `availability: 0`. C'est un arbitrage à lui rendre, parce
qu'il touche une règle gravée : le `stop_sell` est une **intention mémorisée de
l'hôte**, et une fermeture automatique « parce qu'il n'y a pas de prix » n'est
pas son intention. Le compromis probable : pousser la fermeture au provider sans
l'écrire dans la mémoire d'intention — mais c'est sa décision, pas la nôtre.

## Ce que ce protocole n'a pas établi

Ce que **l'OTA affiche** pour chacune de ces dates. Aucune annonce réelle n'était
connectée, et le canal n'a pas pu être créé. La question reste ouverte et ne
s'observera qu'à la migration, sur une date lointaine et sous surveillance.
