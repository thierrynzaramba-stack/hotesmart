# Recette staging — supplément par voyageur (21 novembre 2026)

Branche `fix-supplement-voyageur` (`a400bc674629bacec2b1c0429d16c62637a890fa`),
mergée dans `staging` par le chef de file (`12e9700cb206201a2f057396cb5a680287a81611`),
déployée sur `hotesmart-staging`. Spec : `docs/specs/spec-supplement-voyageur.md`.

## Le banc : le 23 reproduit sur staging

Aucun bien staging n'était relié à la propriété Channex staging `test 2`
(`fda37933-b993-499e-980d-717be487f578`). Banc posé pour cette recette :

- **Channex staging, propriété `test 2`** : type de chambre `dcf75b22…` (6
  voyageurs) ; plan de base `TEST supplement base` (`09c671ef…`), `per_person`,
  grille 90/90/90/90/92/94 ; dérivé `TEST supplement derive` (`4f25b6c4…`),
  `per_person`, cloné comme `lib/rate-plans-derives.js` le crée. Du 23 au
  26/11 : prix par occupation 85/85/85/85/87/89 (comme le 23 en production),
  disponibilité 1 ; le 26/11 fermé (`stop_sell`) sur la base.
- **Base staging** : bien `Recette — Supplément voyageur`
  (`8dc0f9f8-c203-4442-8705-f0467bf8f852`), cloné de `Recette — Studio Centre`
  et relié aux trois objets ci-dessus : capacité 6, 4 inclus, supplément 2 €,
  pas de prix de base, `managed`. `calendar_inventory` : 23, 24, 25/11 à 85 €
  ouverts ; 26/11 à 85 € fermé.

## Les gestes, faits par l'écran de la fiche (`/logements/8dc0f9f8…`)

| heure (Paris) | geste | attendu | mesuré |
|---|---|---|---|
| 16:00 | « Par voyageur en plus » à 0, Enregistrer | refus, rien d'écrit | PATCH **409** ; la fiche affiche « Ce logement est vendu au prix par voyageur chez la plateforme, et ce mode ne peut pas etre change. Pour retirer le supplement, mettez « Voyageurs inclus » a 6 : tous les voyageurs paieront le meme prix. » |
| 16:01:26 | supplément remis à 2, « Voyageurs inclus » à 6, Enregistrer | 200, prix renvoyés | PATCH **200** |

## Ce qui est arrivé, relu après le geste

- **Channex, grille du plan de base** : `per_person` (inchangé), options 1 à 6
  à **90 €** — le montant lu sur l'option à 4 voyageurs, aucun prix de base
  inventé. Type de chambre : 6, inchangé.
- **Channex, prix par date** (grille d'inventaire, occupations 1 à 6) : du 23
  au 26/11, **85 € à toutes les occupations** sur la base, 85 € sur le dérivé.
  Avant : 89 € à l'occupation 6.
- **Fermetures inchangées** : le 26/11 reste fermé sur la base ; le dérivé
  garde son état d'avant (ouvert) ; le 22 et le 27/11, hors calendrier du bien,
  gardent leur prix (94 €) et leur fermeture. **0 nuit rouverte.**
- **Base staging** : `included_guests 6`, `extra_guest_fee 2`, `base_price`
  vide (aucun montant inventé), capacité 6.
- **Journal des prix** (`price_display_log`) : 23, 24, 25/11 à 8500, source
  `host`, `user_id` posé. Le 26/11 (fermé) n'y est pas.

## Verdict

Conforme au critère du chef de file, transposé au banc : le prix poussé à
l'occupation 6 vaut le prix du calendrier (85 €) sur les nuits ouvertes, et
aucune nuit fermée n'est rouverte. Le refus du supplément à 0 parle et
n'écrit rien.

Le banc reste en place sur staging (bien `8dc0f9f8…`, plans `TEST supplement`
sur `test 2`, dont la suppression est programmée par Channex le 5/12).
