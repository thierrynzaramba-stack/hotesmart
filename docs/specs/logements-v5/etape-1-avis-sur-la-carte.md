# Étape 1 — les avis à la place du fait daté

**Demande de Thierry, 20 octobre 2026**, après la recette de la liste V5 sur
staging :

> « au lieu de Fermé jusqu'au mercredi 21 octobre, met les avis total sur le
> logement. »

---

## Ce qui change à l'écran

La carte portait une ligne de **fait daté**. Elle porte désormais **la note du
logement et son nombre total d'avis** : `★ 4,9 · 336 avis`.

**Ce qui disparaît de la carte avec la fermeture**, et c'est à signaler :
« Occupé · départ le … », « Libre jusqu'au … », « Fermé du … au … » et
« Libre · aucune arrivée prévue ». Une seule ligne était prévue à cet endroit
(spec §2) ; les avis la prennent.

**Le fait daté n'est pas supprimé pour autant.** Il reste calculé et descendu
par `GET /api/logement` — fermetures comprises, décision de Thierry du
20 octobre — et la règle d'affichage (`faitDateAffiche`) reste dans
`shared/logements-liste.js` avec ses tests : c'est la **fiche** (étape 2) qui
l'affiche. Son utilitaire de mise en forme (`valeursEnClair`), lui, a été
**supprimé** : plus personne ne l'appelait, et ce lot ne laisse pas de code
dormant.

## « Total » qualifie la PÉRIODE

Tous les avis du logement, **depuis toujours**. C'est ce qui distingue cette
lecture de celle de la fiche, bornée à 30 jours parce qu'elle compte des pouces
de propreté. Aucune borne de date n'est posée, et un test le vérifie.

⚠ **Conséquence à connaître : l'accueil affiche un autre nombre.**
`pages/aujourdhui.html` lit `/api/avis?action=cartes&periode=30j` : sa note est
celle des **30 derniers jours**. Pour La bulle, l'accueil dira donc « 3 avis »
là où les Logements diront « 336 avis ». Les deux sont justes, et ils ne
mesurent pas la même chose. À trancher si l'écart gêne en recette.

## Trois nombres, pas un

`GET /api/logement` rend `avis: { total, notes, moyenne }` par bien.

| champ | ce que c'est |
|---|---|
| `total` | les avis **confirmés et non masqués** du logement |
| `notes` | ceux qui portent une note |
| `moyenne` | la moyenne de ces derniers, **sur l'échelle du cœur (/10)** |

**Mesure de production du 20 octobre 2026**, en lecture seule, sur les 702
lignes d'`ota_reviews` :

| bien | avis visibles | notés | moyenne /10 | affiché |
|---|---|---|---|---|
| La bulle | 336 | 332 | 9,8 | ★ 4,9 · 336 avis |
| Cœur de vie 23 | 245 | 244 | 9,3 | ★ 4,7 · 245 avis |
| Colomiers | 69 | 69 | 9,5 | ★ 4,8 · 69 avis |
| Ofuro Futari | 19 | 19 | 10 | ★ 5,0 · 19 avis |

Les quatre avis de La bulle qui manquent à l'appel sont des **avis directs** :
le cœur stocke `overall_score` brut, et un avis direct n'en porte pas (5 lignes
en production). Une moyenne divisée par 336 serait fausse ; un total de 332
cacherait quatre avis réels. D'où les deux nombres.

**33 avis sont masqués par Airbnb** (`is_hidden`) et ne comptent pas — c'est la
leçon de la recette du 7 octobre, portée par `avisQuiComptent`
(`lib/stats-avis.js`), désormais **partagée** avec la liste plutôt que recopiée.

## L'échelle : /10 dans le cœur, /5 à l'écran

Le cœur ne normalise rien à l'ingestion (migration `2026-09-02-ota-reviews` :
« convertir ici graverait l'erreur dans le cœur »). La mise à l'échelle est une
décision d'affichage, et elle vit à **un seul endroit** — `noteSur5` de
`shared/aujourdhui.js`, « partout », décision de Thierry au lot 1. La liste
l'importe. Mesuré ce jour : Airbnb comme Booking montent à 10, l'échelle est
bien commune.

## Quatre états, et ils ne se confondent pas

| état | à l'écran |
|---|---|
| des avis | `★ 4,9 · 336 avis` |
| `total: 0` — lu, et vide | *Aucun avis* |
| `null` + `indisponibles: ['avis']` — pas pu lire | *Avis non lus* |
| `null` + `refuses: ['avis']` — pas le droit | **rien du tout** |

Le dernier applique la règle de Thierry du 20 octobre : « le bloc n'est pas
rendu du tout à l'écran — on ne montre jamais ce qui mène à un refus. Le JSON
peut le porter, l'écran le cache. »

## La garde

`ota_reviews` est gardée par `can_read(user_id, 'avis', …)`, et l'endpoint
tourne en service key — qui contourne la RLS par conception. La liste reçoit
donc désormais `droits`, ce que le commentaire de `lireListe` annonçait : « le
jour où la liste portera un tel bloc, le paramètre revient AVEC sa garde ».
Sans elle, un co-hôte invité avec `avis: none` recevrait la note de chaque
logement du portefeuille.

`refuses` ne porte **que** `avis` sur la liste : annoncer le refus de ménage,
taxe ou serrures ferait croire à l'écran qu'on lui cache un bloc jamais demandé
(constat M4, intact).

## Deux défauts trouvés en chemin

**`null` passé à `I18n.t`.** Le moteur déclare `t(key, vars = {})` — un défaut
qui ne couvre que `undefined` — et réduit les pluriels en lisant `vars[clé]`
sans garde. Ma première version passait `null` : **toute la liste tombait en
« panne »** sur une seule carte dont les avis n'étaient pas lus. Trouvé par le
test de la page, pas par la lecture. Le double `t()` des tests est maintenant
aussi strict que le moteur.

**Les zones de la grille au téléphone étaient positionnelles.** `:nth-child(4)`
désignait la ligne du fait daté : juste tant que la carte avait toujours ses
cinq enfants. La ligne des avis, elle, **disparaît** sur un refus — le signal
devenait alors le 4e enfant et prenait sa zone. Les zones se désignent
désormais par classe.

## Dette ouverte

**La lecture des avis de la liste est paginée, pas agrégée.** Elle rapatrie
`(property_id, overall_score)` de tous les avis du compte — 702 lignes en
production aujourd'hui, une seule page. Un compte à 28 biens et 10 000 avis en
ferait dix. Le jour où ça pèse, c'est une vue agrégée côté base, pas une borne :
une borne rendrait un total faux **sans erreur** (constat H3).
