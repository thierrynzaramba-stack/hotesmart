# Le cœur de données HôteSmart

> Règle d'architecture. Elle prime sur la commodité d'un chantier particulier :
> une app qui « aurait juste besoin d'un appel direct » est une app qui prépare
> le prochain écart entre providers.

## La règle

Toute donnée collectée auprès d'un provider — Channex, Beds24, et ceux qui
viendront — est **d'abord répertoriée dans le cœur de données** (les tables
Supabase), écrite **par la couche sync uniquement**, puis rendue accessible aux
apps pour leur traitement particulier.

Deux interdits qui en découlent :

- **Aucune app ne lit un provider directement.**
- **Aucune donnée n'existe seulement dans une app.**

## Pourquoi — ce qui est arrivé sans elle

Le planning ménage appelait `/api/beds24` en direct. Conséquence : un hôte
100 % Channex voyait un planning **vide**, sans erreur, sans explication. C'est
l'écart E1 de l'audit d'unification.

Le correctif n'a pas été d'ajouter un second appel provider dans l'application —
ce qui aurait doublé le problème au provider suivant — mais de la faire lire
`bookings_snapshot`, qui porte déjà les deux providers sous un schéma commun.

Même famille de dégâts sur `analyze.html`, encore mono-provider aujourd'hui : elle
lit `/api/beds24 getProperties`, donc elle ne fonctionne pas pour un hôte channel.
Dette identifiée, à traiter avant la bêta.

## La forme de référence : `bookings_snapshot`

- **Un writer unique** (`lib/bookings-snapshot.js`). Deux writers concurrents
  avaient produit des schémas divergents et une source non déterministe.
- **Un schéma commun aux deux providers**, avec un statut canonique — l'app n'a
  pas à savoir d'où vient la réservation.
- **Toutes les apps lisent la même vérité** : planning ménage, messagerie, codes
  d'accès, calendrier.

## L'ordre de travail, pour une donnée provider nouvelle

1. La table du cœur (schéma commun, clé de rattachement explicite).
2. Le writer dans `lib/`, appelé par la couche sync.
3. La lecture par l'app.

Jamais l'inverse. Une app qui commence par lire le provider « en attendant » ne
revient pas en arrière toute seule : le raccourci devient le chemin.

## Ce qui appartient au cœur, et ce qui n'y appartient pas

**Au cœur** : ce qui décrit une réalité du bien ou de sa commercialisation, et qui
intéresse plus d'une app — réservations, messages, tarifs et disponibilités,
**avis voyageurs**, historique des ventes.

**À l'app** : ce que l'app produit elle-même pour son propre usage — un statut de
ménage terminé, une note interne, une préférence d'affichage.

Le test qui tranche : *est-ce qu'une deuxième app pourrait légitimement vouloir
cette donnée ?* Si oui, elle est du cœur, même si une seule app la lit
aujourd'hui.

## Cas déjà tranché : `ota_reviews`

Les avis voyageurs sont du **cœur**, pas du domaine ménage — voir
`docs/specs/spec-avis-voyageurs.md`. Table de vérité unique liée à la
réservation, lue par la fiche prestataire **et** par le futur module de pricing.
Jamais dupliquée dans une app.

## La fiche du bien : `property_snapshots` (étape 1B)

Même forme que `bookings_snapshot`, et c'est délibéré : un payload provider
intégral, une empreinte pour savoir s'il a bougé sans le rapatrier, **un seul
écrivain** (`lib/property-snapshot.js`). La leçon est acquise, on ne la
réapprend pas.

**Le rapatriement et la structuration sont deux gestes distincts.** Ce writer ne
normalise rien, ne remplit aucune colonne de `properties`, ne décide de rien.
Mélanger les deux, c'est perdre le brut le jour où la structure change d'avis.

**Mesure du 8 septembre 2026**, les quatre biens rapatriés :

| bien | provider | champs |
|---|---|---|
| Cœur de vie « La bulle » | beds24 | 331 |
| coeur de vie 23 | beds24 | 334 |
| Colomiers | channex | 112 |
| colomier (test) | channex | 110 |

Le fetch passe par `getProvider(...).getPropertyRaw()` — jamais un provider en
dur. Côté Beds24 la fiche complète demande sept `include` (157 → 330 champs) ;
côté Channex elle agrège la propriété, ses `room_types` et ses `rate_plans` —
un bien sans ses plans tarifaires n'est pas une fiche, c'est un nom.

**Ce que Beds24 ne sert pas, même en le demandant** : ni descriptions ni photos.
`includeTexts` et `includePictures` sont acceptés (HTTP 200) mais aucune clé ne
revient, et les 8 `templates` sont vides sur les deux biens. L'éditorial vient
d'ailleurs — des annonces OTA, ou de la saisie.

**Deux défauts trouvés en review, et ils valent d'être retenus :**

1. **Une fiche partielle ne devient jamais la vérité du cœur.** `getPropertyRaw`
   rendait l'objet amputé quand `/room_types` ou `/rate_plans` échouait. L'objet
   n'était pas vide, il passait donc la garde `payload_vide` du writer et
   **écrasait en base une fiche complète** — brut perdu, `updated_at` qui ment,
   `raw_hash` qui oscille d'un passage à l'autre. Un rapatriement incomplet doit
   ressembler à un échec : `getPropertyRaw` rend `null`.
2. **Channex plafonne à 10 par défaut et ne le dit pas.** Les appels
   `room_types`/`rate_plans` n'avaient aucune pagination. Colomiers en porte 5
   aujourd'hui — la moitié du plafond, et une migration OTA multiplie les plans
   par canal. La troncature aurait été **stable** : empreinte inchangée, compte
   de champs plausible, fiche fausse pour toujours. C'est pire qu'une troncature
   bruyante, et c'est la famille du bug de Régina.

**RLS fermée, service uniquement.** Ce brut porte des emails, des téléphones,
des réglages de passerelle de paiement et des identifiants de webhook. Aucune
app ne le lit en direct : la fiche unifiée lira `properties`. Le brut est un
filet de sécurité et une source de remplissage, pas une surface d'API — et rien
dans le writer ni dans le script ne le journalise.

## Le corollaire de la migration : rapatrier n'oblige pas à migrer

**Une fois la donnée d'un bien rapatriée dans le cœur, ce bien peut RESTER sur
son provider et être pleinement exploité par toutes les apps.** Le rapatriement
et la migration sont deux gestes distincts : le premier est un prérequis
non négociable, le second est un **choix par bien**.

Ce qui motive légitimement une migration, ce n'est donc jamais « pour que la
donnée arrive chez nous » — elle y est déjà. C'est uniquement le besoin d'une
**capacité que seul le nouveau provider offre** : chez Channex, la vente directe
avec écriture CRS, le remapping libre des canaux, l'inventaire piloté au jour.

Conséquence pratique : un hôte équipé de son propre channel manager n'a **aucune
raison d'en changer** pour utiliser HôteSmart. Le dual-provider permanent
(`CLAUDE.md`, section STACK) n'est pas une étape transitoire vers Channex, c'est
la forme définitive.

**Décidé le 8 septembre 2026** : les deux biens de Bagnères (`169567`, `209413`)
migrent — non parce que Beds24 les retiendrait, mais parce que la réservation
directe sur `coeurdevie65.com` demande l'écriture CRS. Le rapatriement précède
la migration, et lui survit : si la migration échouait, la donnée resterait.

## Rattachement TEXT / UUID

Rappel qui vaut pour toute table du cœur : `properties.id` est un **UUID**, et le
`property_id` des tables enfants est le **`provider_property_id` en TEXT**
(`REVIEW.md` §10). Aucune FK ne relie les deux : la purge est explicite, et une
jointure naïve UUID/TEXT ne renvoie rien — silencieusement.


---

# Où vit un réglage : dans l'app, ou dans /settings ?

Règle jumelle de celle du cœur de données. La première dit *où vit une donnée
provider*, celle-ci *où se règle une configuration*.

## La règle

- **La configuration d'une APP vit DANS l'app.**
- **`/settings` ne porte que la configuration HôteSmart générale** : identités,
  accès, droits par domaine, facturation, connexions.

## Le test qui tranche

> **Ce réglage a-t-il un sens si l'app n'existait pas ?**

Oui → `/settings`. Non → dans l'app.

| Réglage | Sens sans l'app ? | Où |
|---|---|---|
| Droits d'un employé par domaine | oui | `/settings` |
| Facturation, abonnement | oui | `/settings` |
| Connexions PMS, serrures | oui | `/settings` |
| Biens d'un prestataire de ménage | non | app ménage |
| Jours de visibilité de la PWA ménage | non | app ménage |
| Modèles de messages voyageur | non | app messagerie |

## Cas tranché : les prestataires de ménage

Un prestataire **n'a pas accès à HôteSmart**, seulement à l'app ménage. Toute sa
gestion — création, identité, biens, lien PWA, désactivation — vit dans
`apps/menages/prestataires.html`, titre « Prestataires ».

`/settings` ne gère que les profils `access_mode = 'compte'` : employés,
propriétaires. Les profils `lien` n'y apparaissent plus du tout.

**Le modèle de données ne change pas.** Un prestataire reste un profil `lien`
dans `profiles` — nécessaire pour rattacher avis et qualité au chantier
prestataires. Seul l'écran change de place.

**Pourquoi cette séparation, concrètement.** Gérer les prestataires depuis
`/settings` y avait fait naître un **second writer** de
`public_tokens.property_ids` : l'hôte cochait deux biens sur huit dans l'app
ménage, corrigeait une faute de frappe sur le nom depuis `/settings`, et le
prestataire récupérait les huit. Deux écrans qui gèrent la même chose finissent
toujours par se contredire — c'est la même leçon que le writer unique du cœur.

## Reste à converger (chantier prestataires)

`apps/menages/prestataires.html` écrit aujourd'hui `public_tokens` **sans créer
de profil**. Les deux populations doivent fusionner : la création d'un
prestataire devra passer par `profiles`, `public_tokens` n'en étant que la
projection PWA. Non traité tant que la fiche prestataire n'existe pas.


## Migration : un bien porte DEUX identifiants, et ils n'ont pas le même rôle

**Écrit le 9 septembre 2026, après trois reviews sur le même chantier.**

Pendant une bascule de provider, un bien porte sa clé **source** (`provider_property_id`,
l'ancien provider) et sa propriété **cible** (`migration_target_property_id`, le
nouveau, qui porte déjà les canaux). Le re-keying (phase 2.8) les réunit ; jusque-là,
tout code qui les confond casse — et il casse dans les deux sens.

**Cœur → provider : on résout la destination.** `proprieteChezLeProvider`
(`lib/rate-sync.js`) dit où parler : la cible tant que la bascule n'a pas eu lieu,
la clé promue après. Mesuré : adresser Channex avec la clé Beds24 rend **HTTP 422**.

**Provider → cœur : on cherche sur les deux colonnes.** `trouverBienParIdProvider`
(`lib/bien-du-provider.js`) — le provider désigne le bien par la propriété qui
porte ses canaux, donc par la cible. La garde d'autorisation le fait aussi :
sinon elle refusait l'accès au propriétaire légitime pendant toute la bascule.

**Et l'écriture dans le cœur se fait TOUJOURS sous la clé du cœur.** C'est le
piège le plus coûteux, parce qu'il ne produit aucune erreur : le webhook arrive
avec la cible, mais tous les lecteurs — calendrier, planning ménage,
`nuitsOccupees` qui alimente le verrou anti-surréservation — interrogent
`bookings_snapshot.property_id` avec `provider_property_id`. Écrire sous
l'identifiant reçu enregistre la réservation sous une clé que **personne ne lit** :
elle existe, et la nuit vendue passe pour libre.

**Règle qui en sort** : à chaque frontière avec un provider, se demander lequel
des deux identifiants on manipule — *où je parle* (le provider) ou *sous quoi je
range* (le cœur). Un même nom de variable pour les deux est le début du défaut.
