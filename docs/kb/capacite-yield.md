# Capacité YieldFlow — le dénominateur du taux d'occupation

Spec : `docs/specs/spec-yieldflow-v1.md` §5 (étape 2, lot 2.1).
Module : `lib/yield/capacite.js` — **lecture seule, aucun appel provider**.

## 1. La convention, en une phrase

**Un jour « ouvert à la vente » est un jour où l'hôte acceptait de vendre.**
C'est une **intention mémorisée**, pas un stock calculé — et c'est le
dénominateur de tout taux d'occupation et de tout RevPAR.

Rapporter les nuitées à *tous* les jours du calendrier ferait plonger le TO d'un
hôte qui ferme deux mois pour travaux, et YieldFlow lui suggérerait de baisser
ses prix pour « remplir » des nuits qu'il ne veut pas vendre. C'est le pire
conseil possible, donné avec assurance.

## 2. Aucune table nouvelle

La mémoire d'intention **existe déjà** : `calendar_inventory.stop_sell`, écrite
par le seul `api/calendar.js` (chantier audit stop_sell). En créer une seconde
ferait deux vérités divergentes — exactement le défaut que le chantier « un
writer unique » a fermé.

## 3. La règle de lecture, identique à `runFullSync`

| état de la nuit | verdict |
|---|---|
| `stop_sell = true` | **fermé** — intention explicite de l'hôte |
| `avail = 0` | **fermé** — `api/calendar.js` pose `stop_sell` avec |
| **aucune ligne** | **fermé** — `runFullSync` calcule `availability = r ? … : 0` : l'absence de ligne vaut zéro. La nuit n'est vendable nulle part |
| **aucun prix** (`rate` nul ou ≤ 0 **et** `base_price` ≤ 0) | **fermé** — c'est la « fermeture calculée » : `runFullSync` force `stop_sell = true` et empile la date dans `fermeesSansPrix`. Le moteur direct refuse la nuit (`raison: 'sans_prix'`) |
| tout le reste | **ouvert** |

**Les deux avant-dernières lignes sont celles qu'on oublie**, et chacune a déjà
coûté un défaut sur ce chantier :

- « aucune ligne » : un `l && l.stop_sell === true` laisse passer les nuits sans
  ligne comme si elles étaient ouvertes (amorçage du journal, réouverture après
  annulation) ;
- « aucun prix » : la première version de ce module l'omettait, tout en
  annonçant suivre `runFullSync` **mot pour mot**. Sur un bien dont l'amorçage
  des prix a raté — le cas exact que l'alerte `poussee_dates_sans_prix` existe
  pour signaler — le dénominateur se serait gonflé de centaines de nuits jamais
  mises en vente. TO effondré, et YieldFlow recommandant de baisser les prix sur
  des nuits qu'aucun voyageur n'a pu voir.

⚠ **`base_price` fait partie du contrat d'appel.** Sans elle, la fonction rend
`base_price_non_selectionne` plutôt que de lire `undefined` comme « pas de
prix » — ce qui fermerait tout le calendrier d'un bien qui vend, sans la moindre
erreur. Même garde que `runFullSync`, et ce dépôt a payé quatre fois ce piège.

## 4. Une nuit VENDUE reste une nuit OUVERTE

Elle était à la vente, et elle s'est vendue : c'est le **numérateur** du taux
d'occupation, pas une soustraction du dénominateur.

La vente réduit le **stock** — calculé au moment de pousser, `unites − vendues`
— mais ne touche jamais l'**intention**, qui est mémorisée. Exclure les nuits
vendues donnerait un taux d'occupation de 100 % à tout bien qui vend,
indéfiniment.

## 5. « Non calculable » n'est pas « zéro »

C'est le point qui porte tout le module. `joursOuverts` rend
`calculable: false` plutôt qu'un zéro, dans deux cas :

| cas | raison | pourquoi |
|---|---|---|
| bien non piloté par nous (Beds24) | `provider_sans_memoire_intention` | sa mémoire d'intention n'est amorcée qu'à la migration vers Channex. Lire son calendrier rendrait quelques lignes éparses — celles que l'hôte a touchées depuis HôteSmart — et ferait passer 360 jours pour fermés. Un TO calculé là-dessus serait faux **et crédible** |
| aucune ligne sur la période | `memoire_non_amorcee` | indiscernable de « tout fermé », mais bien plus probablement « jamais configuré » |

**Zéro et « je ne sais pas » sont deux réponses opposées pour le moteur.** La
première donne un TO de 0/0 — `NaN` ou `Infinity` selon l'ordre des opérations
— et YieldFlow suggérerait des prix sur un bien dont il ne sait rien. La
seconde dit à l'étape 3 d'écarter le bien **et de le signaler**.

Une erreur de lecture **lève** pour la même raison, et une période plus longue
que `JOURS_MAX` est **refusée** plutôt que tronquée : la première version
rendait 2001 jours pour une fenêtre de 5 ans pendant que la requête couvrait la
période entière — `calculable: true` sur une fenêtre silencieusement amputée.
La règle du module s'applique à lui-même.

**Toutes** les raisons passent par la constante `NON_CALCULABLE`, y compris
`parametres_invalides` : un appelant qui fait `switch (r.raison)` sur les
membres exportés ne doit jamais tomber en `default`.

## 5 bis. La lecture est paginée

PostgREST plafonne à 1000 lignes. Sans pagination, une fenêtre de 3 ans ramenait
1000 lignes sur 1096 : les 96 manquantes tombaient en « sans ligne » donc
« fermées », et la fonction rendait `calculable: true`. Dénominateur faux,
silencieux — et non reproductible faute d'`order`. La lecture pagine par 1000
avec un `order('date')`, et le faux client des tests **refuse** une lecture non
ordonnée pour que le test ne valide jamais un code que la vraie base casse.

## 6. Mesure du 12 septembre 2026

| bien | verdict |
|---|---|
| Colomiers | 0 ouverts / 365 — **calculable**, le bien est délibérément fermé |
| La bulle | 50 ouverts / 365 |
| Ofuro Futari | 33 ouverts / 365, dont 17 jours sans ligne |
| Cœur de vie l 23 | 19 ouverts / 365 |
| colomier (bien de test) | **NON CALCULABLE** — mémoire jamais amorcée |

⚠ **Colomiers illustre un troisième cas, distinct des deux autres** :
`calculable: true` avec `jours_ouverts: 0`. C'est une réponse **vraie** — le
bien est fermé partout, volontairement. Mais l'étape 3 doit quand même se garder
de diviser par ce zéro : « calculable » ne veut pas dire « divisible ». Le TO
d'un bien entièrement fermé n'existe pas, il ne vaut pas 0 %.

## 7. `jours_sans_ligne` : un compteur qui ne change pas le verdict

Une nuit sans ligne **est** fermée (convention §3), et elle est comptée comme
telle. Mais elle est *aussi* comptée à part, parce qu'une proportion élevée ne
dit pas la même chose qu'un `stop_sell` explicite : elle signale un bien dont la
mémoire d'intention n'a jamais été complétée. L'étape 3 doit pouvoir le dire à
l'hôte plutôt que de lui montrer un TO flatteur calculé sur trois jours ouverts.

Ofuro Futari en porte 17 aujourd'hui. `jours_sans_prix` joue le même rôle pour
la fermeture calculée — une valeur élevée est le signe d'un amorçage de prix
raté, ce que l'alerte `poussee_dates_sans_prix` du full sync signale déjà côté
poussée.
