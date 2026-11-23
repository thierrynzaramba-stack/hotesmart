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

### Production — 23 novembre 2026, 11:08, CONFORME

Étape 0 en production depuis le 23 novembre à 00:39 (`main` 97827682). Lecture
faite bien par bien, sur les quatre biens Channex, dans la session du
fondateur. Toutes les réponses sont en 200 et `private, no-store`, et les
trois lectures du cœur sont complètes. Les chiffres ont été rendus au chef de
file, qui les a retenus le 23 novembre à 22:25. Le tableau et ce qu'il
tranche sont dans `docs/specs/spec-demandes-airbnb.md` §3, « Mesure de
l'étape 0 en production ».

En résumé :
- 0 fil écarté partout ;
- 85 copies webhook sur 85 ont leur jumelle à la milliseconde ;
- 26 demandes, toutes Airbnb, toutes avec un titre ;
- Ofuro Futari et La bulle ne sont mesurés qu'en partie (10 s, 60 fils) : le
  script de l'étape 3 lira tout ;
- Colomiers, archivé, n'a plus aucun fil chez le partenaire.

## Lot 1, étapes 1 et 2 — migration et writers

### Staging — 23 novembre 2026

- Migration `2026-11-23-demandes-fils.sql` collée par Thierry : contrôle à
  8 lignes sur 8 `true`. Le chef de file a mergé dans `staging` (0c7575a4).
- Recette des deux entrées (webhook et import) sur un vrai message : elle n'est
  pas faisable sur staging, qui n'a ni cron ni demande Airbnb. Le chef de file
  a accepté qu'elle se fasse en production, par
  `docs/recette/preuve-dette-129-lot1.sql`.

### Production — en cours

- 23 novembre 2026, 22h : Thierry a collé la migration dans l'éditeur SQL de
  production, qui a rendu « Success. No rows returned ». Le contrôle
  (8 lignes) est à relever.
