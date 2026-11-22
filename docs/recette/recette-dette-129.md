# Recette — dette 129 (demandes Airbnb dans Messages)

Spec : `docs/specs/spec-demandes-airbnb.md`. Reviews : `docs/recette/reviews-dette-129.md`.

## Lot 1, étape 0 — contrôle de diagnostic `?check=demandes` (lecture seule)

### Staging — 22 novembre 2026, CONFORME

Arbre vérifié : `staging` à `dce47378d8ea917f2c014da70a0ff9c7bb7de56d` (merge de
`dette-129-sans-resa` à `ed568f7084a045e2ce697a5cde37f68f8cd2016b`). Interrogé
depuis le navigateur de Thierry, session fondateur, par `GET` seulement ; jeton
jamais affiché ; onglet refermé.

| cas | attendu | mesuré |
|---|---|---|
| 2 biens reliés au Channex de staging (`8dc0f9f8…`, `b2b81646…`) | 200, lectures complètes | 200 en 0,8 à 1,8 s ; 0 fil, 0 demande, 0 ligne ; trois lectures complètes ; détail ni tronqué ni interrompu ; `fils_d_autres_biens_ecartes` 0 ; `fils_sans_bien_ecartes` 0 |
| 6 biens de recette à identifiant fictif (`STG-…`) | refus nommé, jamais un 500 | 502 « Fils illisibles chez le gestionnaire de canaux », motif `bad_request` |
| bien inconnu | 404 | 404 « Bien introuvable » |
| `property_id` absent | 400 | 400 « Identifiant de bien requis » |
| `property_id` répété | pas d'exception | 200 |
| en-tête de cache, sur toutes les réponses | `private, no-store` | `private, no-store` partout, refus compris |
| texte de message dans une réponse | aucun | aucun champ `body`, aucun texte |
| sans jeton (mesuré par le chef de file) | 401 | 401, `private, no-store` |

**Non testé en réel : le refus d'un non-fondateur (403).** Il faudrait se
connecter avec un autre compte dans le navigateur de Thierry. Ce cas est couvert
par `tests/demandes-mesure.test.js` (membre autorisé sur le bien → 403 sans un
seul appel ; `FOUNDER_EMAIL` absent → 403 avec sa cause) et confirmé à la
lecture par la review 2 (point 1).

Staging n'a aucune demande Airbnb : la mesure utile se lit en production.

### Production — à faire après le go de Thierry

Après le déploiement et un cycle de cron : lecture bien par bien des quatre
biens Channex de production, chiffres rendus au chef de file et notés ici.
