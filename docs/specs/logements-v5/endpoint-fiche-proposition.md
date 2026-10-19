# §4 — Proposition : l'endpoint de lecture de la fiche

**À valider avant tout code** (étape 0 de §8). Rien n'est écrit dans ce
document : c'est une proposition.

## Ce que je propose, en une phrase

**Un endpoint neuf, `GET /api/logement?id=<uuid>`**, et non un paramètre de plus
sur `api/channel-property`.

**Pourquoi pas `channel-property`.** Ce fichier porte déjà GET (la liste), POST
(création **et** relevé des canaux), PATCH, DELETE, et il fait 1 100 lignes. Y
ajouter un sixième chemin, c'est multiplier les gardes dans un fichier qui en
porte déjà quatre, différentes — et c'est exactement le fichier où un patch
mécanique a cassé l'iframe de connexion ce matin. Un endpoint de lecture, seul,
avec une garde, se relit.

## Ce qu'il assemble, bloc par bloc

| bloc de la fiche | source | clé | si la source échoue |
|---|---|---|---|
| en-tête (nom, ville, capacité, photo) | `properties` | **UUID** | **la fiche ne s'affiche pas** — sans le bien, il n'y a pas de fiche. Seul cas bloquant |
| « Où il est en vente » | `canaux_du_bien` + `canaux_releve` | **UUID** | bloc en « on n'a pas pu lire » — **jamais « aucun canal »** (leçon de la dette 59 : `null` ≠ `[]`) |
| Prix | `properties` (mode, base, plancher, devise, voyageurs) | **UUID** | vient de l'en-tête, donc jamais seul en échec |
| Le logement | `properties` | **UUID** | idem |
| Avis | `ota_reviews` | **UUID** | bloc absent, avec sa raison |
| Ménage | `prestataire_periodes` / profils | **TEXT** | bloc absent, avec sa raison |
| Réglages — serrure | `access_codes` / config serrure | **TEXT** | bloc absent, avec sa raison |
| Réglages — taxe de séjour | barème | **TEXT** | bloc absent, avec sa raison |
| un fait daté (liste **et** fiche) | `bookings_snapshot` | **TEXT** | pas de fait daté, et **aucune estimation** |
| « suppression possible » | `bookings_snapshot` + `message_sent_log` | **TEXT** | **`null`, pas `true`** — voir ci-dessous |

## La jointure TEXT / UUID, faite dans l'endpoint

Le dépôt a **deux façons de joindre un bien** : 25 tables sur
`property_id` **TEXT** (la clé du partenaire) et 25 sur **UUID**
(`properties.id`). La spec interdit de faire ce raccord dans la page, et elle a
raison : c'est la cause racine notée en mémoire (« tables enfant clées sur le
numéro provider, pas sur l'UUID »).

**La clé TEXT ne se déduit pas d'un seul champ.** `lib/bien-du-provider.js` le
dit : un bien **en migration** porte sa clé utile dans
`migration_target_property_id`, pas dans `provider_property_id`. Et
`lib/cles-migrees.js` ajoute la règle la plus dure du dépôt : **une clé
abandonnée par une migration ne se rouvre jamais**, et si on ne peut pas lire la
table des clés migrées, **on ne traite pas** — le 14 septembre, rouvrir une clé
a fait quitter 82 séjours de la fiche et annuler seize ménages.

Je propose donc, dans l'endpoint :

1. lire `properties` par UUID (la garde a déjà résolu le bien) ;
2. en tirer les clés candidates : `provider_property_id` **et**
   `migration_target_property_id` ;
3. **écarter les clés migrées** via `lib/cles-migrees.js`. Si cette lecture
   échoue : **aucun bloc TEXT n'est lu**, et chacun rend « on n'a pas pu lire ».
   On ne devine pas ;
4. lire les blocs TEXT avec la clé retenue, **bornés** (`.limit()` explicite) :
   PostgREST tronque à 1000 lignes **sans lever**.

## Si une source échoue : la fiche s'affiche quand même

C'est la demande de la spec, et c'est la leçon de la dette 59. Chaque bloc rend
**trois états distincts**, jamais deux :

- **`null`** — on n'a pas pu lire. Le bloc le dit : « Information
  indisponible ». Jamais un zéro, jamais un vide.
- **`[]` ou `0`** — on a lu, il n'y a rien. « Aucun avis sur 30 jours » est une
  **réponse**.
- **des données** — on affiche.

**Le drapeau « suppression possible » suit la même règle, et c'est le point le
plus sensible de l'endpoint.** Il vaut `true`, `false` ou **`null`**. À `null`,
le bouton Supprimer est **désactivé** avec « Impossible de vérifier pour
l'instant » : une lecture ratée ne doit jamais ouvrir une suppression. Il est
calculé par **la même règle que la garde DELETE actuelle** — le serveur garde le
dernier mot, l'affichage n'est qu'un confort (§5).

## Trois choses que l'endpoint ne fait pas

- **aucun appel au partenaire** (§4). Les canaux viennent du cœur, et la
  fraîcheur vient de `canaux_releve` ;
- **aucune écriture** : les actions passent par les endpoints existants ;
- **aucun identifiant du partenaire dans la réponse** : ni `provider`, ni
  `provider_property_id`, ni `provider_channel_id`. Les privilèges par colonne
  de `canaux_du_bien` les refusent déjà à un client ; l'endpoint ne les demande
  pas non plus.

## La garde

`requirePermission(req, res, { domaine: 'reservations', niveau: 'read', bien: id,
bienRequis: true })`. Le bien **désigne** le compte : c'est la règle du dépôt,
et elle empêche un membre de lire la fiche d'un bien d'un autre compte en
passant un en-tête. `X-Compte` est envoyé par la page, et il est **ignoré** ici
puisque la ressource fait foi.

## Le coût, mesuré en requêtes

**Huit lectures**, toutes parallélisables sauf la première : `properties`, clés
migrées, `canaux_du_bien` + `canaux_releve`, `ota_reviews`, ménage,
`bookings_snapshot` (fait daté **et** drapeau de suppression, une seule
lecture), `message_sent_log`, serrure + taxe. Soit **un aller-retour réseau pour
la page**, là où la fiche d'aujourd'hui en ferait sept depuis le navigateur —
et un appel partenaire en direct, qu'on supprime.

## Ce que je demande à Thierry de trancher

1. **`GET /api/logement` plutôt qu'un paramètre de plus sur
   `channel-property`** — c'est ma recommandation, dis-moi si tu préfères
   l'inverse.
2. **Le fait daté de la liste** : la liste affiche « prochaine arrivée / Occupé /
   Libre jusqu'au ». Si je le calcule pour les N biens dans le GET de la liste,
   c'est une lecture de `bookings_snapshot` pour tout le compte. Je propose de
   le faire **dans le GET de la liste**, borné et ordonné — mais ça touche
   `api/channel-property` GET, donc un commit à part, avec sa review.
3. **Les blocs Ménage, Serrure et Taxe** sont en lecture seule dans ce lot
   (§3.7). Confirme que je lis bien les mêmes tables que leurs écrans, sans en
   réinventer la règle : je lirai leurs modules existants plutôt que la base.
