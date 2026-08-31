# KB — Chantier unification : état au 31 août 2026

<!-- SOURCES (mapping inverse). ⚠️ DOC en tête de ces fichiers pointe ici. Modif = MÊME COMMIT. -->
> Sources : `docs/kb/bookings-snapshot.md`, `docs/kb/booking-changes.md`,
> `docs/specs/spec-avis-voyageurs.md`, `docs/specs/spec-prestataires-menage.md`,
> `REVIEW.md`, `scripts/verifier-chaine.js`, `scripts/backfill-snapshot-provider.js`.
>
> Mots-clés routage chat : unification, audit, E1 E2 E3 E4 E5 E6, chantier ménage,
> avis voyageurs, où en est-on.

## Pourquoi ce chantier

L'audit préalable de la spec « prestataires de ménage » (§0) a révélé six écarts
d'unification, qui bloquaient les deux chantiers suivants (avis voyageurs, puis
prestataires). Il fallait les traiter avant toute nouvelle table.

## État des six écarts

| # | Écart | État |
|---|---|---|
| **E3** | Snapshot Beds24 à deux schémas, résultat non déterministe | **corrigé, déployé** |
| **E4** | Champs non alignés entre providers (`provider` absent) | **corrigé, déployé** |
| **E5** | Vocabulaire de statut divergent → ménages fantômes | **corrigé, déployé** |
| **E2** | Aucun `menage_event` côté Channex | **corrigé, déployé** |
| **E6** | Clés UUID vs TEXT | **tranché** (voir plus bas) |
| **E1** | Planning ménage hôte mono-provider | **RESTE À FAIRE** |

## Ce qui est déployé en production

**Commit 1 — writer unique** (`lib/bookings-snapshot.js`). Seul writer autorisé de
`bookings_snapshot`. Schéma unique, `provider` toujours renseigné, statut canonique
(`confirmed|cancelled|blocked|request`), merge non destructif. Les cinq writers
d'origine passent par lui. Voir `docs/kb/bookings-snapshot.md`.

**Commit 2 — changements de réservation** (`lib/booking-changes.js`,
`lib/booking-changes-dispatch.js`, `lib/cleaning/sync-menages.js`). La détection a
lieu dans le writer, au seul instant où l'existant et l'entrant coexistent ; les
changements sont journalisés dans `booking_change_events` et distribués à trois
consommateurs (ménages, codes d'accès, templates). Le webhook Channex passant par le
même writer, les biens Channex produisent enfin leurs notifications ménage.
Voir `docs/kb/booking-changes.md`.

**Backfill** exécuté le 31/08 : 71 lignes normalisées, second passage à zéro. Les
178 lignes de `bookings_snapshot` portent toutes un `provider` et un statut
canonique.

**Migration appliquée** : `migrations/2026-08-31-booking-change-events.sql`
(table + index partiel + RLS lecture seule, colonnes `properties.checkin_time` /
`checkout_time`).

## Ce qui reste : E1 — le planning ménage hôte

`apps/menages/index.html` (page « Planning » de la sidebar) appelle `/api/beds24`
directement — un hôte Channex y voit un planning **vide**. À faire :
- lire `bookings_snapshot` via un endpoint serverless (pattern `api/menages-public.js`) ;
- passer par `shared/properties.js` `loadAllProperties()` ;
- vérifier par grep qu'aucune référence Beds24 ne subsiste dans
  `api/menages-public.js`, `apps/menages/*`, `lib/cleaning/*`.

Ensuite seulement : chantier avis voyageurs, puis fondation prestataires.

## E6 — décision de clés

Les **nouvelles tables métier** (prestataires, avis voyageurs) référencent
`properties.id` (UUID) : les biens migreront de Beds24 vers Channex et
`provider_property_id` changera ; l'UUID interne est la seule clé stable. Le pont
vers `bookings_snapshot` / `menage_events` (TEXT) se fait par jointure via
`properties`, dans un helper unique — jamais de jointure ad hoc dispersée.

Les tables techniques existantes gardent la convention TEXT
(= `provider_property_id`), `booking_change_events` compris, pour joindre sans pont.

## Vérifier une réservation

```
node scripts/verifier-chaine.js --recents        # 10 derniers changements
node scripts/verifier-chaine.js <booking_id>     # chaîne complète
```

Affiche snapshot → changement (+ `processed_at`) → `menage_event` → message envoyé
→ code d'accès. Lecture seule ; le PIN est masqué sauf `--avec-code`.

**À faire à la première réservation qui bouge** : vérifier que le changement est
détecté, distribué (`processed_at` non nul, `processing_errors` nul), que le
prestataire est notifié, et qu'aucun message n'est parti sur un séjour passé.

## Points de vigilance

- **`REVIEW.md`** (racine) : la checklist à passer avant tout commit. Les quatre
  revues de ce chantier ont trouvé deux fuites inter-comptes, un envoi de masse et
  une perte définitive d'événements — toutes dans du code qui passait les tests.
- Le **kill switch** ne coupe pas le ménage : voir `docs/kb/alertes.md` §3.
- Le dispatch est la **dernière** étape du cron (budget 60 s) : ne pas le remonter.
