# Le « à date » (pickup) — lot 3.3 de YieldFlow

Module : `lib/yield/pickup.js` — fonctions **pures**, ni base, ni réseau, ni
horloge. Tests : `tests/pickup-yield.test.js`.
Spec : `docs/specs/spec-yieldflow-v1.md` §6.

## 1. Pourquoi le réalisé ne suffit pas

Le réalisé d'octobre ne se connaît qu'en novembre : trop tard pour agir sur le
prix. Le « à date » dit **aujourd'hui** où en est octobre par rapport à l'an
dernier au même moment. C'est le seul indicateur qui laisse encore le temps de
corriger.

## 2. Le pivot N-1 : deux alignements, parce qu'il y a deux questions

Le mode retenu est porté **dans la donnée** (`alignement`), jamais deviné.

### Période à venir → on recule en JOURS (`delai_avant_le_debut`)

La question est « à combien de jours de l'ouverture en suis-je ? ». Le sujet
**est** le délai : octobre 2026 vu à 19 jours de son premier jour se compare à
octobre 2025 vu à 19 jours du sien.

Reculer d'un an date à date donnerait le même résultat neuf fois sur dix —
**mais pas quand un 29 février s'intercale**. Le délai glisserait alors d'un
jour sans que rien ne le signale, précisément sur les périodes vues le plus
longtemps à l'avance.

`pivotN1('2024-01-15', '2024-03')` → `2023-01-14`, 46 jours dans les deux cas.

### Période déjà commencée → même jour calendaire (`meme_jour_calendaire`)

La question n'est plus un délai mais un **point d'avancement**, et c'est le
calendrier qui fait foi. **Relevé en review** : appliquer le décalage en jours
ici amputait le N-1 d'une journée dès qu'une année bissextile s'intercalait —
`pivotN1('2025-09-12', '2025')` rendait `2024-09-11`, donc un cumul annuel
comparé à un cumul arrêté **la veille**. Le biais allait toujours dans le même
sens : progression flattée.

## 3. Une date de vente non fiable est écartée, jamais supposée

Sur un bien migré, la date de vente d'une ligne recréée côté Channex vaut la
date de la **migration**. La garder ferait apparaître tout le portefeuille au
même jour : le pickup bondirait de zéro à tout, et l'hôte lirait une explosion
des ventes le jour de sa bascule.

Le pont demapped en récupère ce qu'il peut ; le reste est écarté **et compté**
(`sans_date_de_vente`, `date_de_vente_non_fiable`), avec le drapeau
`dates_de_vente_incompletes`.

## 4. Les quatre drapeaux, dans la donnée et pas dans l'interface

Exigence reconduite du lot 3.2 : l'étape 4 ne doit pas **pouvoir** afficher un
portefeuille reconstruit comme un portefeuille observé.

| drapeau | ce qu'il empêche de conclure | disqualifie le N-1 |
|---|---|---|
| `periode_fermee_a_la_vente` | zéro vendu n'est pas un échec commercial : le calendrier est fermé (0 jour ouvert) | non |
| `periode_n1_fermee_a_la_vente` | l'an dernier le bien ne **pouvait pas** vendre : on ne le félicite pas d'avoir fait mieux | **oui** |
| `capacite_de_la_periode_non_amorcee` | le calendrier n'a jamais été poussé : ni TO ni RevPAR, et le zéro ne se compare à rien | non |
| `capacite_n1_non_amorcee` | la capacité N-1 est absente ou non calculable | **oui** |
| `portefeuille_n1_reconstruit` | le N-1 n'est pas observé, il est reconstruit depuis l'état d'aujourd'hui | non |
| `aveugle_avant_bascule` | rien de **lisible** avant le pivot N-1 : le zéro veut dire « on ne sait pas » | **oui** |
| `dates_de_vente_incompletes` | des dates de vente de l'année en cours sont inexploitables | non |
| `dates_de_vente_incompletes_n1` | idem côté N-1 — **deux drapeaux, pas un** : l'interface doit savoir lequel des deux chiffres taire | non |

### Un écart est un chiffre, donc il se tait aussi

Quand un drapeau de la colonne « disqualifie » est levé, **`ecart` ET
`variation` passent à `null`**, avec le drapeau pour motif. Relevé en review :
`variation` était protégé du N-1 à zéro, pas `ecart` — l'interface recevait
« +500 € » et « +6,45 points de TO » contre un N-1 nul **par ignorance**.

### Écarter à bon droit n'est pas être aveugle

`aveugle_avant_bascule` se mesure sur ce qu'on **n'a pas pu lire**, jamais sur
ce qu'on a écarté à bon droit. Première version : la condition portait sur le
nombre de **candidats**, donc elle criait « aveugle » sur le cas le plus sain —
un N-1 dont les ventes sont simplement postérieures au pivot, ce qui est
l'information la plus actionnable du pickup — et elle se taisait sur le cas
qu'elle nomme, un bien migré sans historique repris, où il n'y a **aucun**
candidat. Les deux erreurs étaient exactement inversées. **Un drapeau qui crie
tout le temps ne dit plus rien.**

Règle actuelle : aveugle si des dates sont illisibles et que rien n'a été
retenu, **ou** s'il n'y a aucun candidat *et* aucune trace du bien avant la
période N-1. Un bien qui a de l'historique antérieur et n'a rien vendu ce
mois-là a un **vrai** zéro, qui reste un signal.

### `periode_fermee_a_la_vente` est le drapeau qui a justifié le lot

Le 12 septembre 2026, les deux biens de Bagnères affichaient **le même −100 %**
de CA sur octobre :

- **Cœur de vie 23** : 0 jour ouvert — la bascule n'est pas finie, le calendrier
  est fermé. Le zéro est une décision, pas un résultat.
- **La bulle** : 31 jours ouverts depuis la réouverture du 11 septembre — le
  zéro est un vrai signal commercial.

Deux situations opposées, un seul chiffre. Sans ce drapeau, le moteur
suggérerait de brader un logement qu'on ne peut pas vendre. **La fermeture se
lit dans la capacité (mémoire d'intention de l'hôte), jamais dans l'absence de
vente.**

## 5. Le biais structurel : le N-1 est reconstruit, donc sous-estimé

Une réservation vendue avant le pivot N-1 **puis annulée depuis** a disparu du
snapshot : elle comptait ce jour-là, elle ne compte plus.

Le biais va **toujours dans le même sens** — le N-1 est sous-estimé, donc la
progression affichée est flattée. Mesuré au 12/09/2026 sur La bulle / octobre
2025 : 2 annulations sur le mois, dont 1 vendue avant le pivot, soit
**1 nuitée invisible**. Faible ici, structurel partout.

Il n'existe aucun moyen de le corriger depuis le snapshot — seul le journal des
prix affichés (étape 1), qui démarre le 12 septembre 2026, permettra un jour
d'observer un portefeuille au lieu de le reconstruire.

## 5 bis. Le numérateur suit le dénominateur sur les exceptions

Corrigé dans `indicateurs.js` à l'occasion de ce lot. `joursOuverts` retire du
dénominateur tout jour couvert par une **exception déclarée** par l'hôte, mais
les nuits vendues ces jours-là restaient au numérateur : 3 nuits dont 2 en
exception sur 1 jour ouvert donnaient un **taux d'occupation de 300 %**,
`calculable: true`, sans le moindre motif.

Le réalisé (`ca`, `nuitees`) garde tout — exigence de Thierry — mais ce qui
**divise** (TO, RevPAR, occupation en personnes) se calcule des deux côtés sur
le même périmètre : la référence. Le retrait est dit (`nuitees_exclues_du_taux`,
`ca_exclu_du_revpar`).

## 6. Les compteurs d'écart se restreignent à la période observée

Première version : le filtre tournait sur tout le portefeuille du bien, et
comptait « vendue après le pivot » chaque réservation de chaque autre mois —
**215 écartées** sur La bulle / octobre 2025, c'est-à-dire quatre ans de
réservations. Un chiffre de ce genre ne se lit pas, il s'ignore. Après
correction : 20, qui est le vrai nombre de ventes d'octobre postérieures au
pivot.

Et ils sont servis avec leur **dénominateur** (`candidats`, `candidats_n1`) :
« 6 vendues après le pivot » ne se lit pas tant qu'on ignore si c'est 6 sur 9
ou 6 sur 200.

## 7. Les réservations sont comptées au mois de leur PREMIÈRE nuit

Convention héritée du lot 3.2 : une réservation n'a qu'une date de vente, donc
un seul délai. Ses **nuits** se ventilent dans chaque mois, son **compte** et
son **délai** vont au mois de sa première nuit.

Conséquence à la lecture : Cœur de vie 23 a 9 réservations touchant octobre
2025, dont 3 vendues avant le pivot, mais n'en affiche que **2** — la troisième
commence en septembre. Ses 11 nuits d'octobre sont bien comptées.

## 8. Pièces de référence — les deux biens de Bagnères, 12 septembre 2026

Pickup d'octobre 2026 vu au 12/09/2026 (19 jours) contre octobre 2025 vu au
12/09/2025 (même délai) :

| | Cœur de vie 23 | La bulle |
|---|---|---|
| CA à date | 0 € | 0 € |
| CA N-1 à date | 674,16 € | 264,00 € |
| nuitées N-1 | 16 *dont 11 sans prix* | 2 |
| TO N-1 à date | 51,6 % | 6,5 % |
| RevPAR N-1 | 21,75 € *(CA partiel)* | 8,52 € |
| prix moyen N-1 | 134,83 € | 132,00 € |
| délai médian N-1 | 145 j | 75 j |
| jours ouverts oct. 2026 | **0** | 31 |
| drapeaux | reconstruit + **fermé** | reconstruit |

Lecture : les deux biens sont à zéro, mais pour des raisons opposées. Cœur de
vie 23 ne peut pas vendre ; La bulle peut et ne vend pas encore — à 19 jours,
son N-1 n'était lui-même qu'à 2 nuitées, donc le retard est réel mais mince.

Le RevPAR N-1 de Cœur de vie (21,75 €) est très sous-estimé : 11 de ses 16
nuitées sont sans prix (`revpar_sur_ca_partiel`, §Quand le numérateur est
amputé du KB indicateurs).
