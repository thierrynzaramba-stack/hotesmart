# Événements YieldFlow — vacances scolaires et jours fériés

Spec : `docs/specs/spec-yieldflow-v1.md` §5 (étape 2, lot 2.3).
Modules : `lib/yield/zones-scolaires.js`, `lib/yield/jours-feries.js`.
Import : `scripts/importer-vacances-scolaires.js`.

## 1. Deux sources, deux traitements opposés — et c'est raisonné

| donnée | traitement | pourquoi |
|---|---|---|
| **vacances scolaires** | importées et **cachées** en base | c'est une **décision administrative** : elle ne se calcule pas, il faut la lire quelque part |
| **jours fériés** | **calculés**, aucune table | ils se **déduisent** : huit dates fixes, trois mobiles dérivées de Pâques par une formule inchangée depuis 1582 |

Importer les jours fériés créerait une dépendance réseau, une table à rafraîchir
et une fenêtre d'années limitée — pour une donnée qu'une vingtaine de lignes
rendent exacte à l'infini.

Inversement, interroger `data.education.gouv.fr` à chaque calcul rendrait le
moteur dépendant d'un tiers pour une donnée publiée **des années à l'avance** et
qui ne bouge pratiquement jamais. D'où le cache, conforme à la règle
d'architecture : provider → cœur → apps.

## 2. Les trois zones, pas seulement celle du bien

Un logement toulousain (zone C) accueille des Parisiens (zone C) mais aussi des
Lyonnais (zone A) et des Lillois (zone B). **La demande dépend des vacances de
toutes les zones**, pas de celle du bien. C'est même l'intérêt du signal :
savoir quelle zone remplit quel bien.

`properties.zone_scolaire` situe le bien — elle ne limite pas le moteur.

## 3. Deux pièges de dates, mesurés sur les données réelles

**Le décalage UTC varie avec l'heure d'été.** La source sert des instants :

```
Vacances de la Toussaint 2025 : 2025-10-17T22:00:00+00:00   (UTC+2)
Vacances de Noël 2025         : 2025-12-19T23:00:00+00:00   (UTC+1)
```

Les deux valent **minuit à Paris** — le 18 octobre et le 20 décembre. Un
`slice(0, 10)` aurait rendu le 17 et le 19 : toutes les dates décalées d'un
jour, et **pas toujours du même côté** selon la saison. La conversion passe par
`Intl` en `Europe/Paris`, qui connaît les règles de changement d'heure.

**`end_date` est le jour de la RENTRÉE, pas le dernier jour de vacances.** La
Toussaint 2025 finit à `2025-11-02T23:00Z`, soit le 3 novembre à Paris — or la
rentrée a bien eu lieu le 3. Le dernier jour de vacances est le 2. Stocker le 3
aurait ajouté un jour de vacances à chaque période, **tous les ans**.

Exception : les marqueurs ponctuels (« Début des Vacances d'Été ») ont
`start === end`. Les reculer d'un jour rendrait une période inversée, que la
contrainte `CHECK` refuserait.

## 4. Les doublons de la source, et le filtre `population`

La source rend **une ligne par académie** : les cinq académies de la zone C
partagent leurs dates, d'où 340 lignes brutes pour 59 périodes réelles. La
déduplication porte sur `(nom, date_debut)` — **la même clé que l'index unique
de la table**, pour que le script et la base soient d'accord sur ce qu'est un
doublon.

Elle rend aussi une ligne par `population` : les **enseignants** rentrent un jour
plus tôt. Garder leurs lignes ferait deux périodes concurrentes pour les mêmes
vacances. Seules `Élèves` et `-` sont retenues.

Une divergence de dates entre académies d'une même zone est **signalée**, jamais
résolue en silence par « la première lue ».

## 5. La zone se lit sur le code postal, pas sur la ville

Mesure du 12 septembre 2026 : un bien porte `city = 'comomiers'` (faute de
frappe) avec `zip_code = '31770'`. Chercher par nom de ville aurait rendu
« inconnu » sur un bien parfaitement localisé. Le code postal vient du provider,
pas d'une saisie libre.

La **Corse** (2A/2B) et les **DOM** ont leurs propres calendriers : la table les
exclut volontairement et rend `null` plutôt qu'une zone devinée. Un test
d'intégrité verrouille la couverture 01-95 hors Corse, sans doublon — il a déjà
trouvé une coquille (`'film'` au lieu d'un numéro de département).

## 6. OpenAgenda : écarté de la V1, sur mesure

**Décision de Thierry, 12 septembre 2026.** Le sondage de la source
(OpenDataSoft, `GET`) :

| département | total | à venir |
|---|---|---|
| Haute-Garonne | 57 897 | 1 684 |
| Hautes-Pyrénées | 3 259 | 212 |

Échantillon des huit premiers à venir près des biens : *Atelier Dessiner au
musée*, *P'tits Artistes 6-12 ans*, *Club des lecteurs*, *Un métier à graver*,
*Visite Cité de l'Espace*.

**Aucun ne déplace quelqu'un qui réserve un logement.** OpenAgenda est un agenda
culturel local — réunions d'information, ateliers, permanences — où le signal
utile au yield (festival, congrès, match qui remplit une ville) est noyé. Et le
dataset ne porte **aucun champ de fréquentation attendue** permettant de l'en
distinguer.

Importer ~1 900 lignes dont aucune n'est garantie exploitable remplirait le cœur
sans rien apporter. **On y reviendra quand l'étape 3 aura montré des écarts
inexpliqués que les vacances ne couvrent pas** — quand le besoin sera démontré
par les chiffres, pas supposé.

## 7. Portée assumée des jours fériés

France **métropolitaine**. L'Alsace-Moselle (Vendredi saint, 26 décembre) et les
DOM (abolition de l'esclavage, dates variables) ont des jours supplémentaires :
non couverts, et c'est dit plutôt que deviné.
