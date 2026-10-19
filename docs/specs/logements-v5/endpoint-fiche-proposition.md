# §4 — L'endpoint de lecture : la liste et la fiche

**Tranché par Thierry le 19 octobre 2026** (voir la dernière section). Ce
document était une proposition ; il est devenu la spec de l'étape 0.

## En une phrase

**Un endpoint neuf, `GET /api/logement`** : **sans `id`** il rend la **liste
V5**, **avec `id=<uuid>`** il rend la **fiche** d'un bien. `api/channel-property`
GET **reste inchangé** pour ses autres appelants.

**Pourquoi pas `channel-property`.** Ce fichier porte déjà GET (la liste), POST
(création **et** relevé des canaux), PATCH, DELETE, et il fait 1 100 lignes. Y
ajouter un sixième chemin, c'est multiplier les gardes dans un fichier qui en
porte déjà quatre, différentes — et c'est exactement le fichier où un patch
mécanique a cassé l'iframe de connexion ce matin. Un endpoint de lecture, seul,
avec une garde, se relit.

**Et la liste passe par le même fichier** (décision de Thierry, point 2) : le
« fait daté » de la liste est une lecture de `bookings_snapshot`, et la poser
dans `api/channel-property` GET aurait fait porter à **tous ses appelants** —
dont les écrans qui ne montrent pas de fait daté — une lecture dont ils n'ont
pas besoin, dans le fichier le plus chargé du dépôt. L'ancien GET garde donc
exactement sa réponse d'aujourd'hui, et la liste V5 lit `/api/logement`.

### La liste (`GET /api/logement`, sans `id`)

Par bien : nom, ville, capacité, photo, `automation_paused`, les pastilles de
canaux (`canaux_du_bien`), et **le fait daté**. Les mêmes **trois états** que la
fiche s'appliquent bien par bien : un `bookings_snapshot` illisible donne un
fait daté `null` — « Information indisponible » — **jamais « Libre »**, qui
serait un mensonge commercial. **Borné et ordonné** : les biens du compte triés
par nom, `.limit()` explicite, et la lecture des réservations bornée à la
fenêtre utile (départ ≥ aujourd'hui) — PostgREST tronque à 1000 lignes sans
lever. Le droit est celui du compte, pas d'un bien : `reservations:read` sans
`bienRequis`, et la liste ne contient que les biens visibles par le profil.

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

## Tranché par Thierry, le 19 octobre 2026

1. **`GET /api/logement` neuf** — accordé.
2. **Le fait daté ne passe PAS par `channel-property`.** `GET /api/logement`
   sans `id` **est** la liste V5 (bornée, ordonnée, mêmes trois états) ;
   `channel-property` GET reste inchangé pour ses autres appelants. C'est mieux
   que ce que je proposais : aucun appelant existant ne change, donc le lot
   n'emporte aucun risque de régression sur les écrans d'aujourd'hui.
3. **Ménage, Serrure et Taxe se lisent par leurs modules existants**, confirmé.
   Je n'écris aucune règle métier dans cet endpoint : s'il faut décider ce qu'est
   « une prestataire assignée » ou « la serrure est posée », c'est le module du
   domaine qui le dit, pas moi.
