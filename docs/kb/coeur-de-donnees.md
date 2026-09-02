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

## Rattachement TEXT / UUID

Rappel qui vaut pour toute table du cœur : `properties.id` est un **UUID**, et le
`property_id` des tables enfants est le **`provider_property_id` en TEXT**
(`REVIEW.md` §10). Aucune FK ne relie les deux : la purge est explicite, et une
jointure naïve UUID/TEXT ne renvoie rien — silencieusement.
