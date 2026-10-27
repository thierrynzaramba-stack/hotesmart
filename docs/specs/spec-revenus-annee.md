# Bloc Revenus — vue ANNÉE

**Décision de Thierry, 27 octobre 2026.** Suite du bloc Revenus, dont la vue
Mois est en production. Maquettes : `Accueil-revenus-annee-v5`,
`Accueil-revenus-annee-mobile-v5`, `Accueil-revenus-comparables-v5`.

---

## 1. Architecture — décidée, et elle écarte la table de résumé

**Pas de table de résumé.** Les colonnes dérivées de `bookings_snapshot`
(`montant_net_cents`, `date_versement`, `statut_canonique`, `est_blocage`,
`property_uuid`) **sont déjà** la donnée préparée : le travail coûteux a été
déplacé à l'écriture lors du lot Mois. L'agrégat annuel est un `group by` sur
une table indexée, pas un calcul.

**Une fonction SQL unique**, rendant les 12 mois × logements de l'année demandée
**et de N-1**, en **un seul appel**. Chargée **au clic sur « Année »**, jamais à
l'ouverture : la règle du budget de l'écran (spec-aujourdhui-v5 §5 bis) compte
2 appels au chargement, et ce lot ne doit pas en ajouter un troisième par défaut.

**Mêmes gardes que les trois autres fonctions** : `security invoker`,
`revoke all … from public, anon, authenticated`, `grant execute … to
service_role`. `p_user_id` et `p_refs` viennent de `contexteDEcran`, **jamais**
de `req.query` — c'est la seule ligne de défense, la clé de service contournant
la RLS (spec-aujourdhui-v5 §11).

---

## 2. Ce que l'écran montre

| élément | contenu |
|---|---|
| courbe mensuelle | 12 points, année N, superposée à N-1 |
| granularité | total du compte **et** par logement |
| cumul à date | somme du 1er janvier à aujourd'hui, et l'écart en % face à N-1 |
| bande comparables | **second temps**, et seulement pour les logements YieldFlow ayant des comparables choisis |

---

## 3. Inventaire des données — ce qui existe, ce qui manque

| donnée | source | état |
|---|---|---|
| montant net par séjour | `bookings_snapshot.montant_net_cents` | **existe** (lot Mois) |
| mois d'imputation | `bookings_snapshot.date_versement` | **existe** |
| identité du logement | `bookings_snapshot.property_uuid` | **existe** |
| séjour vendable | `statut_canonique = 'confirmed'` et `est_blocage is not true` | **existe** |
| montants non calculables | `montant_net_cents is null` + `motif_non_calculable` | **existe**, à compter par mois |
| montants bruts | `montant_est_brut` | **existe**, à compter par mois |
| séjours hors logements | `property_uuid` nul **ou** absent de `properties` | **existe** (logique de `revenus_hors_mois`) |
| nom et photo du logement | `properties` | **existe**, déjà chargé par l'écran |
| comparables YieldFlow | domaine marché | **hors de ce lot** |

⚠ **Rien n'est à ajouter au cœur.** C'est le bénéfice direct du lot Mois : la
vue Année ne demande aucune colonne neuve, aucune migration de données, aucun
backfill. Seule une fonction SQL s'ajoute.

---

## 4. Ce que la donnée réelle impose — mesuré en production le 27 octobre 2026

```
2022 :  32 séjours ·  4 833,91 € ·  4 mois · 1 bien
2023 : 135 séjours · 26 182,54 €    · 12 mois · 2 biens
2024 : 360 séjours · 54 607,85 €    · 12 mois · 2 biens
2025 : 394 séjours · 57 809,95 €    · 12 mois · 2 biens
2026 : 360 séjours · 55 114,90 €    · 12 mois · 4 biens
2027 :   3 séjours ·  1 507,19 €    ·  2 mois · 2 biens
```

Premier mois vendu, par logement :

| logement | premier mois |
|---|---|
| Cœur de vie 23 | 2022-09 |
| La bulle | 2023-10 |
| **Ofuro Futari** | **2026-09** |
| **Colomiers** | **2026-07** |

⚠ **DEUX LOGEMENTS SUR QUATRE N'ONT AUCUN N-1.** Et la conséquence est plus
large que leurs deux lignes : **le total 2026 porte 4 logements, le total 2025
en porte 2.** Un « +X % » calculé entre ces deux totaux ne compare pas deux
années, il compare deux périmètres — et il afficherait une croissance qui n'est
que l'arrivée de nouveaux biens.

C'est la même famille que la règle gravée du dépôt : *« non calculable » n'est
jamais zéro*. Ici, *« pas comparable » n'est jamais « +0 % »*.

⚠ **ET 2027 EXISTE DÉJÀ** : 3 séjours y sont versés. L'année en cours porte donc
des mois à venir, et la question de les tracer ou non se pose dès ce lot.

---

## 5. Le tracé — le dépôt sait déjà le faire

`apps/yield/marche-global.html` superpose **N, N-1 et N-2** par mois, en SVG
**en ligne**, sans bibliothèque, avec `role="img"` et un `aria-label` qui décrit
la courbe. `apps/yield/marche-temperature.html` fait de même sur deux ans.

**Deux copies existent donc déjà.** La règle du dépôt — *une règle partagée par
deux versions vit dans un module commun* — demande d'en extraire un module
`shared/` plutôt que d'en écrire une troisième. À trancher (question 7).

⚠ **La courbe n'est jamais le seul porteur de sens** : les chiffres du cumul et
l'écart en % sont écrits, et la courbe porte `aria-hidden` ou un `aria-label`
qui dit ce qu'elle montre — même règle que la barre du bloc Mois.

---

## 6. Catégorie de performance — déclarée avant le code

**Donnée NON URGENTE** au sens de la règle d'architecture : des revenus
mensuels agrégés ne changent pas d'une minute à l'autre.

Elle est servie **prête** sans table de résumé parce que la préparation a eu
lieu à l'écriture. Ce qui doit rester vrai, et qu'un test gardera :

- **un seul appel** ajouté, au clic, jamais à l'ouverture ;
- **le compte d'appels ne croît pas avec le nombre de logements** (le test du
  budget existe déjà, à étendre à la vue Année) ;
- l'endpoint **ne calcule rien** à la lecture : il lit l'agrégat et le rend.

---

## 7. Décisions de Thierry, 27 octobre 2026

| # | question | décision |
|---|---|---|
| 1 | l'écart N-1 compare deux périmètres | **pas de % au niveau du compte** : seulement par logement. Les totaux N et N-1 du compte restent affichés, **sans pourcentage**. Raisons données : les indicateurs sont par bien, pas en global ; et « à périmètre constant » n'est pas compréhensible pour un hôte grand public |
| 2 | « cumul à date » sur une année passée | une année passée se compare **en entier** à l'année N-1 entière. Le cumul à date ne vaut que pour l'année **en cours** |
| 3 | les mois à venir | **tracés** : reçu en trait plein, à venir distingué (pointillé ou estompé), comme la barre du bloc Mois. Idem pour 2027 |
| 4 | un mois avant l'ouverture d'un bien | **pas de zéro** : la courbe d'un logement commence à son premier mois d'activité |
| 5 | le bouton Année | un sélecteur **Mois \| Année** à côté des flèches, qui avancent alors d'un mois ou d'une année |
| 6 | les maquettes | le **fond** se code maintenant (fonction SQL + endpoint) ; Thierry colle les maquettes pour la forme |
| 7 | le module de courbe partagé | **extrait**, et utilisé par Revenus **uniquement**. YieldFlow n'y bascule pas maintenant : il le fera quand il sera intégré au Calendrier |

⚠ **La décision 1 porte plus loin qu'elle n'en a l'air.** Elle évite d'afficher
un pourcentage qui comparerait 4 logements à 2 — et elle le fait sans ajouter
de phrase à l'écran. C'est la réponse la moins bavarde au problème le plus
coûteux de ce lot.

⚠ **Et la décision 4 impose la forme de la fonction SQL** : elle ne doit pas
combler les trous. Un mois sans ligne n'est pas un mois à zéro, et seule
l'absence de ligne permet à l'écran de distinguer « rien vendu » de « le bien
n'existait pas ».

---

## 8. Le coût, mesuré avant d'être décidé

Thierry a rappelé la règle : une donnée non urgente se pré-calcule. **Elle l'est
déjà** — à l'écriture, par le lot Mois. Restait à savoir si l'agrégat annuel
justifiait en plus une table de résumé. Mesure en production, 1 565 lignes,
médiane de 12 appels :

| | |
|---|---|
| plancher réseau (1 ligne de `properties`) | **74 ms** |
| `revenus_du_mois` (agrégat d'un mois) | **65 ms** |
| `revenus_calcul_incomplet` (balaie les 1 565 lignes) | **66 ms** |
| lecture **brute** des 1 565 lignes | **487 ms** |

**L'agrégat ne coûte rien de mesurable au-dessus du réseau.** Une table de
résumé économiserait zéro milliseconde, contre un cron, un crochet
d'invalidation à chaque réservation, et une classe de péremptions. Et le
contraste valide le lot Mois : la lecture brute coûte **sept fois** l'agrégat.

⚠ **Ce que cette mesure ne dit pas** : elle porte sur **4 logements et
1 565 lignes**. Le jour où un compte en portera trente, elle est à refaire — et
si la fonction s'écarte du plancher réseau, la table de résumé redevient la
bonne réponse. Le `Server-Timing` de l'endpoint porte déjà le compte de
requêtes pour le voir venir.

---

## 9. La fonction SQL — contrat

`migrations/2026-10-27-revenus-annee.sql`, **neuvième du domaine Revenus**.

```
revenus_annee(p_user_id uuid, p_annee integer,
              p_aujourdhui date, p_refs uuid[] default null)
  -> (property_uuid, annee, mois, sejours,
      recu_cents, a_venir_cents, total_cents,
      bruts, sans_montant)
```

- **les deux années en un appel** — c'est le réseau qu'on économise, pas le SQL ;
- **aucun trou comblé** (décision 4) ;
- **les séjours sans logement connu sont rendus aussi**, comme dans la vue
  Mois : ils entrent dans le total et sur aucune ligne, et c'est la réserve qui
  les nomme. Les taire ferait un total qu'aucune ligne n'explique ;
- bornée par des **dates** et non par `extract(year …)`, qui interdirait
  l'index ;
- `security invoker`, `revoke … from public, anon, authenticated`,
  `grant … to service_role`, et une preuve qui interroge **les trois rôles**.

---

## 10. Reste à faire

1. l'endpoint (chargé au clic, pas à l'ouverture) ;
2. le module de courbe partagé, extrait de `apps/yield/marche-global.html` ;
3. l'écran, **à la réception des maquettes** ;
4. l'extension du test de budget : le clic ajoute **un** appel, et ce compte ne
   croît pas avec le nombre de logements.
