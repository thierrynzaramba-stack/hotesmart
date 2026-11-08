# Spec de lot — l'écran des périodes : QUAND vos prix montent ou baissent

**28 octobre 2026.** Branche `yf-ecran-periodes`, partie de `main` (`3399dfba`).

**Demande de Thierry, mot pour mot** : « la page evenement est inbuvable refait
son ui, sont titre, car elle est imcomprehencible », puis, à la question du
rôle de l'écran :

> L'écran montre d'abord QUAND les prix montent ou baissent sur 12 mois. Le
> réglage se fait ligne par ligne, avec « plus fort / moins fort » plutôt que
> le menu −4 à +4. « Ajouter un événement » devient un bouton, pas un
> formulaire déplié. Un seul code couleur à l'écran, et aucun mot du moteur.

⚠ **ET LE FICHIER N'EST PAS CELUI QU'ON CROIT.** `apps/yield/evenements.html`
est une **redirection** de 21 lignes vers `prix?evenements=1` depuis le
22 septembre 2026. L'écran réel est la **pop-up de `apps/yield/prix.html`**
(`rendrePopup`, ~110 lignes). C'est elle que ce lot refait.

---

## 0 bis. ⚠ AMENDEMENT DU 29 OCTOBRE 2026 — RECETTE DE THIERRY

**Bilan de sa recette** : 10 OK, 1 non testé (mobile), **1 KO structurel**,
2 anomalies. OK : 1-6 (menu du calendrier), 9 (dates), 11-12 (sélecteur
`/apps/yield`). « La mécanique du 10 est OK. »

⚠ **CE QUI EST KO, ET C'EST LE CŒUR DE L'ÉCRAN. Consigne gravée, mot pour
mot :**

> Les seuls niveaux de prix de YieldFlow sont Base / Moyen / Haut / Très haut /
> Exceptionnel. « un peu plus chers / nettement / moins chers / prix normaux »
> ne correspondent à rien dans le moteur : on les retire partout.

**Ce que ça dit de la première passe, et il faut l'écrire.** §3 et §4 avaient
inventé un vocabulaire — neuf états en mots, puis deux degrés — pour traduire
les crans « sans mot du moteur ». Le résultat n'était pas une traduction mais
une **seconde échelle**, qui n'existe nulle part : ni dans le moteur, ni dans
Prédiction de prix, ni dans la tête de l'hôte. **§3 et §4 sont donc PÉRIMÉS**
et remplacés par le présent §0 bis.

⚠ **ET LA BONNE NOUVELLE EST MESURÉE : le moteur dit déjà exactement ce que
Thierry demande.** `lib/yield/suggestion.js`, en commentaire au-dessus du calcul
des crans :

```
crans(contexte) = niveau(contexte) − niveau(hors vacances)
niveau de la nuit = niveau(hors vacances | son jour) + crans
```

et, trois lignes au-dessus : « le contexte POUSSE la structure ordinaire du bien
en gardant ses reliefs. Les vacances montent la semaine de Base à Moyen ET le
week-end de Haut à Très haut — le même cran, l'écart conservé. »

**La consigne de Thierry n'est donc pas un changement de modèle : c'est le
modèle du moteur, enfin montré à l'écran.** Le lot 1 l'avait caché derrière des
mots inventés.

### 0 bis.1 La pastille : le niveau sur la grille du bien

| | |
|---|---|
| **ce qui s'affiche** | le **niveau de la période sur la grille du bien** : Base, Moyen, Haut, Très haut, Exceptionnel |
| **si semaine et week-end diffèrent** | **les deux** : « Haut · week-ends Très haut » |
| **le calcul** | `niveau = NIVEAUX[ indice(hors vacances \| jour) + crans ]`, la formule du moteur **telle quelle** |
| **jamais** | « un peu plus chers », « nettement », « moins chers », « prix normaux » — retirés de l'écran, des classes CSS et des tests |

⚠ **ET LE MOT « WEEK-END » NE S'ÉCRIT QUE S'IL EST VRAI.** La structure du bien
porte un niveau par **jour de semaine** (`positions_jour`, clé
`segment|jour`) : les jours qui se détachent ne sont pas forcément samedi et
dimanche. Règle :

1. les 7 jours au même niveau → **une** pastille (« Haut ») ;
2. les jours qui diffèrent sont **exactement** le week-end du moteur
   (`estWeekEnd` = samedi ou dimanche, `lib/yield/reference.js:122`) →
   « Haut · **week-ends** Très haut » ;
3. sinon → **on nomme les jours** : « Haut · **vendredis et samedis** Très
   haut ». Inventer « week-end » pour des vendredis serait une affirmation
   fausse, et elle ne rougirait jamais ;
4. plus de deux groupes → la pastille montre le groupe **le plus nombreux** et
   le groupe **le plus haut** ; l'infobulle donne **les sept jours**. Rien n'est
   caché, la pastille reste lisible.

### 0 bis.2 ▲ / ▼ : un cran sur la grille

- ▲ / ▼ déplacent la période **d'un cran**, semaine et week-end **ensemble**,
  **reliefs gardés** — c'est la définition du cran, pas un choix d'interface.
- **L'étiquette annonce le résultat AVANT le clic** : « Toussaint : Haut → Très
  haut » (en `title` et en `aria-label`, donc lisible au téléphone — l'ancien
  menu −4…+4 ne l'était pas).
- **Bornes, et elles sont trois** : `Base` en bas, `Exceptionnel` en haut, et
  l'**amplitude du moteur** (`AMPLITUDE_MAX = 2`, `lib/yield/suggestion.js:53`,
  repris en `CRANS_MAX`). À la borne, le bouton est **désactivé AVEC sa
  raison** — « le week-end est déjà à Exceptionnel » — et non silencieusement
  inopérant. ⚠ Un bouton qui ne fait rien sans le dire est le défaut que ce lot
  corrige ailleurs (le sélecteur de logement) : on ne le réintroduit pas ici.
- ⚠ **La borne se vérifie sur TOUS les groupes de jours**, pas sur la semaine
  seule : si le week-end est à Exceptionnel et la semaine à Haut, ▲ est refusé
  — sinon le cran écraserait le relief qu'il doit conserver.

### 0 bis.3 Une période sans effet affiche son niveau

`crans = 0` n'est **pas** un état à part : la période affiche **son niveau**
comme les autres (« Moyen »). « prix normaux » disparaît.

⚠ **L'invariant « `null` n'est jamais 0 » TIENT, et il devient plus visible.**
`crans = 0` est un réglage posé (« cette période ne pousse rien ») et s'affiche
comme un niveau ; `crans = null` est **l'absence de mesure** et s'affiche
« **Automatique · niveau estimé** », le détail en infobulle (demande de
Thierry : « Automatique — trop peu de nuits ordinaires pour comparer » est trop
technique).

⚠ **ET ON N'INVENTE PAS UN NIVEAU QU'ON N'A PAS.** « niveau estimé » suppose
une estimation : elle existe quand le moteur a **emprunté au segment parent**
(`reference_empruntee`). Sans estimation du tout, la ligne porte **le motif
seul**, jamais un niveau par défaut. Un niveau affiché sans mesure serait un
chiffre faux présenté avec l'aplomb des vrais.

### 0 bis.4 La frise se colore par NIVEAU — et la palette devient une STRUCTURE

- une bande par période, colorée par **le niveau de grille** ;
- **le prune et le gris « effet » disparaissent** : plus de `.e-monte`,
  `.e-baisse`, `.e-normal`, `.e-inconnu` sur la frise ni sur la pastille.

⚠⚠ **CONSIGNE DE THIERRY DU 29 OCTOBRE 2026, ET ELLE DÉPASSE CE LOT. Mot pour
mot :**

> Même palette de niveaux que Prédiction de prix, à l'identique, prise depuis la
> même source (pas recopiée). La consigne « ni bleu ni ambre » est retirée pour
> cette échelle. Cette palette est réutilisée pour toutes les prévisions.
> Enregistre-la comme **élément de structure à ne jamais modifier ou substituer
> sans double validation de ma part**.

⚠ **CETTE EXEMPTION EST SANS OBJET DEPUIS LE 3 NOVEMBRE 2026**, et le dire vaut
mieux que de la laisser lire comme une règle vivante. Elle avait été accordée à
une échelle COLORÉE — Base bleuté, Haut ambré. L'échelle d'encre n'a **aucune
teinte** : elle n'entre en concurrence avec rien, donc elle n'a besoin d'aucune
exemption. Les trois couleurs réservées — noir à la navigation, ambre à « ce
qu'HôteSmart a fait pour vous », bleu au cliquable — valent de nouveau partout,
y compris ici.

#### La palette canonique — LA SOURCE

| jeton | valeur | niveau | texte | classe |
|---|---|---|---|---|
| `--niveau-1` | `#F7F7F7` | 1 · Base | `--text` | `n-base` |
| `--niveau-2` | `#EBEBEB` | 2 · Moyen | `--text` | `n-moyen` |
| `--niveau-3` | `#D6D6D6` | 3 · Haut | `--text` | `n-haut` |
| `--niveau-4` | `#8C8C8C` | 4 · Très haut | `--text` | `n-tres-haut` |
| `--niveau-5` | `#222222` | 5 · Exceptionnel | `--bg` | `n-exceptionnel` |

⚠ **CINQ VALEURS, PAS DIX** : l'échelle d'encre n'a pas d'accent par niveau.
L'encre du texte est `--text` ou `--bg`, le liseré est `--niveau-4` ou
`--niveau-5` — tout en jetons déjà là. Source unique : `public/style.css`.

⚠ **LE CHIFFRE EST TOUJOURS ÉCRIT** (règle 2 de Thierry) : « 1 · Base » …
« 5 · Exceptionnel ». Au bas de l'échelle, le fond ne porte plus
l'information — `--niveau-1` est à ΔE 1,0 du fond « nuit passée ».

**Les cinq règles, les deux corrections mesurées, et les vingt-cinq valeurs
des cinq rampes comparées : `docs/kb/charte-ui.md` §3.** Elles ne sont pas
recopiées ici — c'est tout l'objet d'une source unique.

⚠ **TOUT CE QUI SUIVAIT ICI DÉCRIVAIT LA PALETTE PRUNE, ET A ÉTÉ RETIRÉ LE
3 NOVEMBRE 2026.** On y lisait « une seule teinte prune », « les dix valeurs
tiennent 269-272° », « dix valeurs, pas cinq », « la consigne *ni bleu ni
ambre* ne s'applique pas à cette échelle », et trois tableaux de mesures. Rien
de tout cela n'est vrai : l'échelle d'encre n'a **aucune teinte**, elle a
**cinq** valeurs, et les trois couleurs réservées valent de nouveau partout.

**Ces paragraphes ont vécu moins de vingt-quatre heures, et c'est précisément
pourquoi ils sont retirés plutôt que corrigés.** Une description périmée se lit
comme une mesure et ne rougit jamais — aucun test ne lit les `.md`. La seule
protection est de ne pas en laisser traîner.

**L'état courant, ses cinq règles, ses deux corrections mesurées et les
vingt-cinq valeurs des cinq rampes comparées : `docs/kb/charte-ui.md` §3.**

#### ⚠ CE QUE CE LOT DISAIT FAIRE N'EST PLUS L'ÉTAT DU DÉPÔT

La table qui vivait ici — « la frise et la pastille lisent la palette là où
elle est déjà », « les dix valeurs sont déclarées une fois », « `marche-global`
NON TOUCHÉ », « le mode sombre hors de ce lot » — décrivait le dépôt du
30 octobre 2026. Trois des quatre lignes sont fausses depuis :

- il n'y a plus **dix** valeurs mais **cinq**, et plus de `--yf-*` du tout ;
- `marche-global.html` **a été touché** : sa redéclaration locale est partie le
  30 octobre, et le 3 novembre son niveau a quitté la **ligne** pour une
  pastille (règle 1 de Thierry) ;
- les sélecteurs `.yp-niv.n-*` et `.yp-niv-badge.n-*` qu'elle citait **n'existent
  plus** : les cinq classes `.n-*` sont dans `public/style.css`, parce que deux
  écrans les emploient.
- le **mode sombre** a été retiré de YieldFlow le 2 novembre, sur double
  validation.

#### ⚠ LE GARDE-FOU QUI REND LA RÈGLE EFFECTIVE

Une règle écrite dans une spec ne rougit jamais. `tests/palette-niveaux.test.js`
tient **les cinq règles de Thierry**, une par test, chacune prouvée par une
mutation : les cinq valeurs dans la source, aucune teinte, contraste ≥ 4,5:1,
jamais la ligne, pas de dégradé, le chiffre écrit — plus la garde des
déclarations, qui refuse une copie comme une source amputée.

⚠ **Il n'y a PAS de test « ces hexas n'apparaissent que dans les fichiers
nommés »**, qui existait pour les palettes colorées : trois des cinq densités
sont déjà des jetons du socle V5 (`--ink`, `--line`, `--surface-2`). Un gris
n'est pas distinctif ; un **nom** l'est.

Son message d'échec dit la règle en toutes lettres : **cette échelle est un
élément de structure ; elle ne se modifie et ne se substitue qu'avec la
validation de Thierry.** Un test dont l'échec n'explique pas la règle se
contourne en changeant le test.

⚠ **Le test épingle les VALEURS, pas le goût.** Il n'empêche pas Thierry de
changer la palette : il empêche qu'elle change **sans lui**.

### 0 bis.5 Anomalie 1 — un réglage vaut pour **chaque année**, et ça doit se voir

**Voulu, et mesuré** : un réglage est posé sur le **segment**
(`reglagePlusFin(reglages, e.cle, e.segment)`), **sans date** — il s'applique
donc à toutes les occurrences, chaque année. Thierry : « c'est voulu (réglage
par période, chaque année), mais il faut que ça se voie. »

**Correctif** : toute ligne portant un réglage de l'hôte (`crans_ajustes` non
`null`) affiche **« chaque année »**. Pas les lignes en « Automatique » : elles
ne portent aucun réglage, et l'écrire là serait faux.

### 0 bis.6 Anomalie 2 — le 13e mois, et c'est un défaut de ce lot

**Constat de Thierry** : l'occurrence du **23 → 29 octobre 2027** est rangée
sous « **Septembre 2027** » et colore « sept. » sur la frise.

**Cause, trouvée dans le code de ce lot** (`apps/yield/prix.html`) :

```js
for (let m = moisDe(debutF); m <= moisDe(finF) && moisListe.length < 12; …)
…
const moisDeLaLigne = (e) => { const m = moisDe(e.debut)
  if (m < premierMois) return premierMois
  if (m > dernierMois) return dernierMois   // ← le repli fautif
  return m }
```

La fenêtre du serveur va d'aujourd'hui à aujourd'hui + 1 an : elle **touche 13
mois** dès que le jour n'est pas un 1er. La frise a été plafonnée à 12 colonnes
— avec sa raison, écrite dans le code : la 13e passait à la ligne et on lisait
« oct. » deux fois. Mais le **serrage symétrique** qui en découlait replie dans
le dernier mois **tout ce qui commence après**, et une période d'octobre 2027
se retrouve sous septembre.

⚠ **Le repli était une solution d'affichage appliquée à une question de
RATTACHEMENT.** Masquer une colonne est un choix de mise en page ; ranger une
période sous un mois où elle n'a pas un seul jour est un **fait faux**.

**Correctif, dans les termes de Thierry** — « Une période se range sous son vrai
mois ; la frise montre ce 13e mois partiel plutôt que de le replier » :

1. `moisListe` = **tous les mois que la fenêtre touche**, soit **12 ou 13**
   (13 dès que `debutF` n'est pas un 1er) ;
2. la frise tient **13 colonnes sans passer à la ligne**, la dernière
   **visiblement partielle** (elle ne couvre que le début du mois) ;
3. `moisDeLaLigne` **ne replie plus par le haut**. Le serrage par le **bas**
   reste, avec sa raison : une période peut **commencer avant** la fenêtre et la
   chevaucher ;
4. le contrôle de compte déjà présent (« aucune entrée perdue en route ») est
   **conservé** — c'est lui qui aurait dû crier, et il ne pouvait pas : une
   entrée repliée n'est pas une entrée perdue.

### 0 bis.7 Ce que l'amendement change à la CASE PERFORMANCE (§6)

**Toujours un seul appel, et ZÉRO requête de plus.** `api/yield-evenements.js`
appelle déjà `grilleDuBien(...)` et lui prend `g.grille.positions`. La même
réponse porte **déjà** `g.grille.positions_jour` (`lib/yield/suggestion.js:482`,
Map `segment|jour`), **calculée dans le même appel et jetée**. Précédent :
`api/yield-prix.js:748` la sert déjà.

⚠ **ET ON NE SERT PAS LA MAP ENTIÈRE.** La formule du moteur ne demande que la
**structure ordinaire par jour de semaine** : `niveau(hors vacances | jour)`.
L'endpoint ajoute donc **un champ de 7 entrées** —
`structure_jour: { lundi: {indice, niveau}, … dimanche: … }` — et rien d'autre.
Les crans par période sont déjà servis.

| point | avant l'amendement | après |
|---|---|---|
| appels de l'écran | 1 | **1** |
| requêtes Supabase | inchangées | **inchangées** (`positions_jour` était déjà calculée) |
| octets | — | **+7 entrées**, mesurées à l'implémentation |

Les points 1 à 8 de §6 restent valables sans autre changement.

### 0 bis.8 Tests de l'amendement (§9 complété)

| ce qui est gardé | pourquoi ce test existe |
|---|---|
| le vocabulaire inventé est **absent du rendu** : « un peu plus chers », « nettement », « moins chers », « prix normaux » | c'est le KO de la recette ; un test sur la **classe** CSS ne l'aurait pas vu |
| la pastille rend **le niveau de grille**, et **les deux** quand semaine et week-end diffèrent | le cas « Haut · week-ends Très haut » |
| le mot « week-ends » n'apparaît **que** si les jours qui diffèrent sont samedi/dimanche ; sinon les jours sont **nommés** | une affirmation fausse dans un libellé ne rougit jamais toute seule |
| ▲ à `Exceptionnel` et ▼ à `Base` sont **désactivés AVEC leur raison** ; `\|crans\| ≤ 2` | un bouton inopérant et muet est le défaut que ce lot corrige ailleurs |
| la borne se vérifie sur **tous** les groupes de jours | sinon le cran écrase le relief |
| `crans = 0` affiche **un niveau**, jamais « prix normaux » | |
| `crans = null` affiche « Automatique · niveau estimé » ; **sans estimation, le motif seul** et **aucun niveau** | « `null` n'est jamais 0 », et un niveau inventé est pire qu'une absence |
| une ligne avec réglage de l'hôte porte **« chaque année »** ; une ligne « Automatique » **non** | anomalie 1 |
| une période du **13e mois** (2027-10-23) est rangée sous **octobre 2027** et colore la **13e** colonne | anomalie 2 — le test nomme la date exacte du constat de recette |
| la frise n'utilise **aucune** classe d'effet et **aucun hexa neuf** | la palette reste celle de Prédiction de prix |
| `tests/palette-niveaux.test.js` : les **dix** valeurs canoniques, la **liste blanche** des fichiers où elles peuvent apparaître, et **la valeur juste pour chaque niveau** | la palette est un élément de structure (Thierry, 29 octobre 2026) : elle ne se modifie ni ne se substitue sans sa **double validation**. Une spec ne rougit jamais ; ce test, si |

⚠ **Règle 19 : chacun de ces tests rougit contre `6e5052cf`** (la tête du lot
avant l'amendement), et la contre-épreuve se fait par `git archive` hors de
l'arbre — jamais `git show > fichier`.

### 0 bis.9 Ce que l'amendement NE change pas

- **Le moteur n'est pas touché.** Aucun fichier de `lib/yield/` modifié : la
  formule, les 5 niveaux, `AMPLITUDE_MAX` et le modèle en crans sont lus, pas
  réécrits.
- **Le serveur reçoit toujours des crans** et les borne (`crans_max`).
- **Aucune écriture nouvelle** : les quatre verbes de `yield-evenements` ne
  changent pas.
- **§10.2 est périmé** (« deux degrés : un peu / nettement ») — remplacé par les
  niveaux. **§10.4 est périmé** pour sa dernière phrase (`--prune` pour
  « moins chers ») : l'état disparaît. Les trois couleurs réservées — noir à la
  navigation, ambre à « ce qu'HôteSmart a fait pour vous », bleu au cliquable —
  **restent en vigueur**.
- ⚠ **`--prune` et `--prune-bg` deviennent-ils orphelins ?** À **vérifier à
  l'implémentation** : s'ils ne servent plus nulle part, ils partent de
  `public/style.css` avec leur raison. Un jeton sans usage est une dette qui se
  recopie.

### 0 bis.10 Reste au point 7 : le mobile

Thierry l'a noté **non testé**. L'aperçu de ce lot est donc **desktop ET
mobile**, comme le premier — règle du dépôt : le mobile suit l'ordinateur, et la
question se pose avant la clôture, pas après.

---

---

## 0 ter. ⚠ LE LOT EST REPRIS — 3 NOVEMBRE 2026, branche `yf-periodes-niveaux`

**Décision de Thierry, mot pour mot** : « `yf-periodes-niveaux` part de
`268bcd59`, pas de staging. Contenu = le KO structurel de ma recette du
29 octobre. »

⚠ **ET ÇA REVIENT SUR UNE DÉCISION ÉCRITE, QU'IL FAUT DIRE PLUTÔT QUE DE LA
LAISSER SE CONTREDIRE EN SILENCE.** Le registre du chantier
`docs/specs/spec-ce-qui-fait-bouger-vos-prix.md` §5 porte, depuis le 30 octobre :
« Le lot `yf-ecran-periodes` est ARRÊTÉ. Son amendement de recette ne sera pas
codé : le présent chantier le remplace. » Le §0 bis ci-dessus était donc une
spec **sans lot**. Thierry le rouvre le 3 novembre : l'amendement **est** codé,
sur l'écran existant, et le chantier « Ce qui fait bouger vos prix » reste
devant pour la refonte complète. Les deux anomalies que le registre avait
promues « exigences du lot 4 » — le 13e mois et « chaque année » — reviennent
donc ici, où elles sont nées.

⚠ **ET C'EST CE LOT QUI DÉBLOQUE LA PRODUCTION DE TOUTE LA CHAÎNE YIELDFLOW.**
Mesuré le 3 novembre : `yf-ecran-periodes` (1b98c812) est ancêtre de
`lot-palette-prune` (0377f0b8), qui est ancêtre de `lot-echelle-encre`
(268bcd59). Les trois attendent ce lot avant `main`. D'où la base :
**`268bcd59`, la tête de la chaîne — pas `staging`.** Une branche partie de
`staging` emporterait dans `main` **tout ce que `staging` porte en plus**, dont
la recette n'est pas faite ; la règle 3 l'interdit, et elle fermerait la chaîne
entière à la production.

⚠ **L'ÉCART SE MESURE, IL NE SE CITE PAS.** Une version de ce paragraphe
annonçait « 103 commits et 129 fichiers » : le nombre n'était reproductible par
aucune commande, et il BOUGE à chaque merge dans `staging`. Relevé en review.
La mesure se refait en deux commandes, et c'est elle qui fait foi :

```bash
git log --oneline --no-merges 268bcd59..origin/staging | wc -l
git diff --name-only 268bcd59 origin/staging | wc -l
```

Au 4 novembre 2026 : **110 commits et 155 fichiers** — contre 60 commits et
82 fichiers pour `origin/main..origin/staging`. Les deux chiffres grossissent
tant que la chaîne YieldFlow attend son go. Correction de Thierry lui-même, après signalement.

### 0 ter.1 Ce que le §0 bis ne pouvait pas savoir

Le §0 bis date du 29 octobre. Trois choses ont changé depuis, et elles entrent
dans ce lot :

| | ce que le §0 bis dit | ce qui vaut |
|---|---|---|
| **la palette** | « même palette que Prédiction de prix », cinq teintes puis prune | **l'échelle d'encre** : cinq densités, saturation 0 %. Choix définitif de Thierry du 3 novembre |
| **« ni bleu ni ambre »** | « retirée pour cette échelle » | **sans objet** : une échelle sans teinte n'entre en concurrence avec aucune couleur réservée. Le paragraphe est corrigé en place |
| **le libellé** | « Haut », « Très haut » | **« 3 · Haut », « 4 · Très haut »** — le chiffre est toujours écrit (règle 2). Au bas de l'échelle le fond ne porte plus l'information |

Et une quatrième, acquise entre-temps : **les libellés de fériés passent par la
table** `shared/yield-libelles-feries.js` — « 11 novembre », « de l'Ascension »,
« Pont du 8 mai ». À l'affichage seulement ; aucune clé de segment ne bouge.

### 0 ter.2 Les sept points du lot, et où chacun est spécifié

| # | point | spec |
|---|---|---|
| 1 | la pastille affiche le **niveau de la grille du bien**, et les deux si semaine et week-end diffèrent | §0 bis.1 |
| 2 | **▲ / ▼ = un cran** sur la grille, semaine et week-end ensemble, reliefs gardés | §0 bis.2 |
| 3 | **frise et pastilles sur l'échelle d'encre** ; `--prune` « moins chers » et tout le vocabulaire d'effet disparaissent | §0 bis.4, amendé ci-dessus |
| 4 | **« Automatique · niveau estimé »**, le détail en infobulle | §0 bis.3 |
| 5 | **« chaque année »** sur une ligne réglée | §0 bis.5 |
| 6 | le **13e mois** rangé sous son vrai mois | §0 bis.6 |
| 7 | **libellés des fériés via la table** | §0 ter.1 |

### 0 ter.3 Le vocabulaire qui disparaît — l'inventaire, mesuré

Relevé dans `apps/yield/prix.html` le 3 novembre 2026. Rien de cette liste ne
doit survivre au lot, ni dans le code, ni dans les classes, ni dans les tests :

| ce qui part | où |
|---|---|
| `EFFET_MOT`, `effetMot()`, `effetClasse()` | la table de mots inventés et ses deux fonctions |
| `.e-monte`, `.e-baisse`, `.e-normal`, `.e-inconnu` | 11 règles CSS, dont `.qpb-bande.*` et `.qpb-effet.*` |
| `--prune`, `--prune-bg` | leur **seul** usage produit. Ils redeviennent des jetons sans emploi |
| `.qpb-effet` | la pastille d'effet |

⚠ **`.qpb-pt` EST CONSERVÉE, pas retirée** — une version de ce tableau disait le contraire du code. Le point de la ligne reste, et il prend désormais le fond et le liseré de son **niveau** : il change de source, pas d'existence.

⚠ **`--prune` SORT DU PRODUIT AVEC CE LOT**, et c'est ce que Thierry annonçait
le 2 novembre : « le prune "moins chers" disparaît avec le lot 4 (les périodes
passent en niveaux de grille) ». L'exception nommée dans
`tests/palette-niveaux.test.js` et dans `docs/kb/charte-ui.md` §3 **doit partir
dans le même lot** — une entrée de liste blanche qui ne garde plus rien se
réveille en silence le jour où son motif revient. Ce fichier porte la leçon
trois fois.

### 0 ter.4 Ce qui change au SERVEUR, et pourquoi c'est une ligne

`api/yield-evenements.js` appelle déjà `grilleDuBien(...)` et prend
`g.grille.positions`. La **même réponse** porte `g.grille.positions_jour`
(Map `segment|jour`, `lib/yield/suggestion.js:482`), **calculée dans le même
appel et jetée**. Précédent établi : `api/yield-prix.js:748` la sert déjà.

**Zéro requête de plus, zéro appel de plus** — la case PERFORMANCE du lot est
inchangée (§0 bis.7). Sans elle, la règle « le mot week-end ne s'écrit que s'il
est vrai » (§0 bis.1) ne serait pas tenable : on ne saurait pas quels jours se
détachent.

### 0 ter.5 Case PERFORMANCE

| point | réponse |
|---|---|
| **1. un écran = un endpoint** | inchangé : la pop-up lit `/api/yield-evenements`, un seul appel |
| **2. donnée non urgente = résumé** | sans objet : ce sont des réglages de l'hôte et une grille déjà calculée dans l'appel |
| **3. cache navigateur** | sans objet : aucun cache sur cet écran, et il porte des réglages qui s'écrivent |
| **4. `private, no-store`** | inchangé — l'endpoint le pose déjà avant son premier refus |
| **5. statiques versionnés** | sans objet : aucun fichier statique ajouté |
| **6. lecture tronquée à 1000** | sans objet : la fenêtre est d'un an, bornée par date |
| **7. budget < 1 s / < 2 s** | inchangé : aucun appel ajouté. `positions_jour` voyage dans une réponse déjà émise |
| **8. mesure avant/après** | appels : 1 → 1. Requêtes : inchangé. Octets : ⚠ ce n'est **pas** `positions_jour` qui voyage — elle reste au serveur. Ce qui part en plus, ce sont **`niveaux_jour` et `structure_jour`**, 7 clés chacune **par période** (≈ 300 octets par période). Relevé en review : la version précédente de cette ligne décrivait un transfert qui n'a pas lieu |

### 0 ter.6 Les deux aperçus

**Desktop ET mobile avant commit** (demande de Thierry, et règle
« LE MOBILE SUIT L'ORDINATEUR »). Ce qu'ils doivent montrer :

1. la frise, avec son **13e mois partiel** ;
2. une pastille à **un** groupe de jours, une à **deux** (« 3 · Haut ·
   week-ends 4 · Très haut »), et une à **jours nommés** (« vendredis et
   samedis ») — les trois cas de §0 bis.1 ;
3. une ligne **« Automatique · niveau estimé »** et une ligne **« chaque
   année »** ;
4. ▲ / ▼ avec leur étiquette de résultat, et **un bouton désactivé avec sa
   raison** ;
5. un **férié**, un **pont** et un **week-end prolongé**, pour montrer les
   libellés de la table.

## 0 quater. RECETTE DU 7-8 NOVEMBRE 2026 sur staging — et la décision A

Staging, compte de recette, **Recette — Loft Pilotable**, pop-up « Quand vos
prix bougent » ouverte depuis Prédiction de prix (`?evenements=1`).

⚠ **CE QUE THIERRY A DIT EN OUVRANT L'ÉCRAN : « ça ne ressemble pas à la
maquette ».** C'est exact, et c'est voulu : cet écran est l'intermédiaire
qu'attend la production ; la maquette Événements est le lot 4 du chantier
« Ce qui fait bouger vos prix », qui le remplacera. Question posée, réponse de
Thierry : **cette version peut partir en production en attendant** (« oui »).

| point | vérifié par | résultat |
|---|---|---|
| frise de **13 mois**, nov. 2026 → nov. 2027 | Thierry | ✓ |
| un **niveau avec son chiffre** sur chaque ligne, aucun vocabulaire d'effet | Thierry | ✓ |
| libellés de la table : « Week-end du 11 novembre », « Pont du 11 novembre », « 11 novembre » | Thierry | ✓ |
| niveaux sur l'**échelle d'encre**, aucune teinte | Thierry | ✓ |
| étiquette des flèches **avant** le clic | navigateur de Thierry | ✓ « Monter d'un cran : … passe à 3 · Haut » |
| « **chaque année** » sur une ligne réglée, pas sur une automatique | navigateur de Thierry | ✓ |
| ▲ puis ▼ | navigateur de Thierry | ⚠ **écart, ci-dessous** |
| téléphone (cadre de 387 px) | navigateur de Thierry | ✓ ligne dans l'écran, flèches de 44 × 44 px, la frise défile dans son propre cadre (`.qpb-frise`, `overflow-x: auto`) |

### ⚠ L'écart des flèches — mesuré, et c'est la règle du MOTEUR

Ligne « Vacances de Noël — autre zone », Loft, 8 novembre 2026 :

| état | lundi | mardi | mercredi | jeudi | vendredi | samedi | dimanche |
|---|---|---|---|---|---|---|---|
| automatique (« 0 cran ») | Haut | Haut | Moyen | Base | Moyen | Très haut | Moyen |
| ▲ (cran +1 posé) | Haut | **Moyen** | Haut | Haut | Très haut | **Très haut** | Haut |
| puis ▼ (cran 0 posé) | Moyen | Base | Moyen | Moyen | Haut | Haut | Moyen |

Prédiction de prix, même état automatique : samedi 19 décembre Exceptionnel
140 €, mardi 22 Haut 115 € — **l'automatique affiche bien ce que le moteur
fait.**

**La cause** : en automatique, le moteur prend la **mesure propre du couple
segment|jour** ; dès qu'un cran est **posé** — même 0 — il part de la
**structure ordinaire du bien** et lui ajoute le cran. Monter d'un cran peut
donc faire **baisser** un jour (le mardi) et laisser le samedi en place, et ▼
ne ramène pas à l'automatique : seul « remettre en automatique » le fait
(vérifié, état de départ rétabli). **L'écran dit vrai** — l'étiquette annonce
le groupe principal, et la pastille suit le moteur ; c'est le geste « un cran »
qui n'a pas le sens qu'il annonce pour un hôte.

⚠ **CETTE RÈGLE EST DÉJÀ EN PRODUCTION** : la pop-up servie aujourd'hui pose
les mêmes crans sur le même moteur ; elle le montre seulement moins.

**Décision de Thierry, 8 novembre 2026 : A — l'écran part en production
quand même**, l'écart noté ici. On ne touche pas au moteur (décision du
28 octobre). **Le lot 4 du chantier le ferme par construction** : l'hôte y
pose le NIVEAU de chaque nuit (lot 2, `yield_reglages_position`, en production
depuis le 8 novembre), plus aucun cran.

## 1. Pourquoi c'est illisible — mesuré dans le code, pas supposé

| constat | mesure |
|---|---|
| **Une case de 54 px porte CINQ informations** | le numéro du jour, le prix (`~` si projeté, `✎` si de la main de l'hôte), l'étiquette du niveau **en 9 px majuscules**, le nom de l'événement **en 9 px positionné par-dessus**, et une barre par événement au bas de la case |
| **DEUX codes couleur se superposent dans la même case** | le **fond** dit le niveau de prix (`CLASSES` : Base → Exceptionnel) ; le **contour et les barres** disent l'origine (`EV_COULEUR` : `#2A5E86` officiel, `#7A3E9A` date commerciale, `#1F6F45` déclaré). Rien ne dit à l'écran qu'il y a deux codes |
| **Le vocabulaire est celui du moteur** | « crans », « laisser mesurer », « sans effet », « se comporte comme », « éclairé par », « à déterminer », « reconduire » |
| **Le réglage principal est un menu de 9 valeurs** | `−4 … +4 crans`, dont le sens n'est écrit que dans un `title` de survol — **invisible au téléphone** |
| **Trois listes s'empilent sans hiérarchie** | horizon scolaire, reconductions, événements : même classe `yp-ev-l`, distinguées par une seule couleur de bordure |
| **Le formulaire d'ajout est toujours déplié** | en bas, après les listes |
| **Le titre ne dit ni ce qu'on voit, ni ce qu'on y fait** | « Événements — novembre 2026 », pour un écran qui montre vacances scolaires, jours fériés, ponts, dates commerciales **et** événements de l'hôte, et qui sert à régler combien chacun pousse les prix |

⚠ **Et un hexa en dur dans le JavaScript** (`EV_COULEUR`), ce que la règle V5
interdit hors de `shared/theme.css`. La page est antérieure à V5 ; ce lot ne la
convertit pas en entier, mais il ne pose aucun hexa de plus.

## 2. Inventaire — conservé, déplacé, retiré AVEC RAISON

Règle du dépôt : **une spec UI ne supprime jamais une fonction métier par
omission.** Source : `inventaire-calendrier-yieldflow.md` §B.2 (ligne « Pop-up
Événements »), `docs/kb/evenements-yield.md`, `spec-yieldflow-v1.md` §6 ter.

| fonction actuelle | décision | raison |
|---|---|---|
| Calendrier du mois teinté par niveau, `~` projeté, `✎` prix de l'hôte | **RETIRÉ de cet écran** | ⚠ La page qui l'ouvre — Prédiction de prix — porte **déjà** le tableau du mois, nuit par nuit, avec les prix, les niveaux, `~`, `✎`, les suggestions et leur preuve. Cette grille de 54 px en était une **seconde vérité, plus pauvre**. On ne perd rien : on cesse de dire deux fois la même chose, moins bien la seconde |
| Plusieurs événements par jour (barres empilées) | **REMPLACÉ, pas perdu** | c'était un correctif de review (un Salon dans les vacances écrasait la Toussaint). En liste sur 12 mois, deux périodes qui se chevauchent sont **deux lignes** — le problème qu'il fallait résoudre disparaît avec la forme qui le causait |
| Navigation ‹ mois › | **RETIRÉE** | l'écran montre les 12 mois d'un coup (demande de Thierry). Le mois reste le repère de regroupement |
| Bannière « calendrier scolaire publié jusqu'au … » | **CONSERVÉE** | c'est du **fond** : au-delà de la couverture, les nuits sont comptées ordinaires. Ne pas le dire présenterait « hors vacances » comme une mesure (`evenements-yield.md`) |
| Reconductions proposées | **CONSERVÉES**, et **jamais enregistrées sans confirmation**, dates corrigeables | règle gravée §6 ter |
| « couper / réactiver » une période | **CONSERVÉ**, gardé par `droits.desactivable` | |
| « supprimer » un événement de l'hôte | **CONSERVÉ**, gardé par `droits.supprimable` + confirmation | |
| « éclairé par <férié> » (`ferie_voisin`) | **CONSERVÉ, REFORMULÉ** | dit pourquoi un week-end ordinaire pèse plus. L'information reste, le mot part (§3) |
| Réglage en crans (−4…+4) | **CONSERVÉ EN FOND, CHANGÉ EN FORME** | ⚠ Le modèle en crans est une décision gravée : « Toussaint +1 cran » pousse la structure du bien **en gardant ses reliefs** ; un niveau à plat aplatissait la semaine sur le week-end. Le SERVEUR continue de recevoir des crans et de les borner (`crans_max`). Seule la **manière de les saisir** change : deux boutons et un état en mots |
| « laisser mesurer (N) » | **CONSERVÉ**, reformulé | c'est le `null` qui rend la main au moteur, et il est distinct d'un 0 |
| Formulaire d'ajout (nom, dates, récurrence ×3, « se comporte comme ») | **DÉPLACÉ derrière un bouton** | demande de Thierry. Aucun champ retiré |
| Lecture seule (`droits_ecriture === false`) | **CONSERVÉE** | tous les gestes disparaissent, les faits restent |
| Chaque geste → rechargement | **CONSERVÉ** | le rechargement **est la preuve** que l'écriture a abouti |

**Rien n'est retiré sans une ligne ci-dessus.**

## 3. ~~Aucun mot du moteur — la table de traduction~~ ⚠ PÉRIMÉ LE 29 OCTOBRE 2026

> ⚠ **CETTE SECTION NE S'APPLIQUE PLUS.** Elle a inventé une seconde échelle
> (« un peu plus chers », « nettement », « prix normaux ») qui n'existe dans
> aucun moteur. Remplacée par **§0 bis** : les niveaux de la grille. Gardée ici
> pour la leçon, pas pour être codée.

| aujourd'hui | demain | pourquoi |
|---|---|---|
| « crans » | **« effet sur vos prix »** | un cran est une unité interne ; l'hôte veut savoir ce que ça fait |
| « +2 crans » | **un état en mots** : « un peu plus chers », « plus chers », « beaucoup plus chers », « au maximum » (et le symétrique en baisse) | neuf états nommés, pas neuf nombres |
| « sans effet » | **« prix normaux »** | |
| « laisser mesurer (+2) » | **« HôteSmart décide (+2 aujourd'hui) »** | garde la valeur mesurée, visible, sans la présenter comme un réglage |
| « se comporte comme » | **« ressemble à »** | |
| « éclairé par le 11 novembre » | **« collé au 11 novembre »** | |
| « à reconduire » | **« revient l'an prochain ? »** | une question, puisqu'on attend une confirmation |
| « officiel » | **« vacances et jours fériés »** | |
| « date commerciale » | **« fêtes du calendrier »** | |
| « déclaré » | **« ajouté par vous »** | |
| « à déterminer » (parent) | **« — au choix de HôteSmart — »** | |

## 4. ~~Un seul code couleur : l'EFFET~~ ⚠ PÉRIMÉ LE 29 OCTOBRE 2026

> ⚠ **CETTE SECTION NE S'APPLIQUE PLUS.** La couleur dit le **niveau de
> grille**, pas l'effet. Voir **§0 bis.4**. Gardée pour la leçon.

L'écran parle de **quand les prix bougent**. La couleur dit donc **ça**, et rien
d'autre :

- **monte** (crans > 0) ;
- **baisse** (crans < 0) ;
- **prix normaux** (crans = 0) ;
- **pas encore mesuré** (`null`) — neutre, et **jamais confondu avec 0**.

⚠ **L'ORIGINE N'EST PLUS UNE COULEUR, C'EST UN MOT.** Les trois hexas de
`EV_COULEUR` disparaissent de la lecture ; l'origine se lit « vacances et jours
fériés », « fêtes du calendrier », « ajouté par vous ». Un lecteur daltonien
n'avait aucun moyen de distinguer `#2A5E86` de `#1F6F45` ; un mot, si.

Les quatre teintes viennent de `shared/theme.css` (`--ok`, `--warn`, `--info`,
`--muted`) — **aucun hexa posé par ce lot**.

## 5. L'écran cible

**Titre : « Quand vos prix bougent »** — dans le menu du calendrier et en tête
de la fenêtre. ⚠ **PROPOSÉ, PAS TRANCHÉ** : Thierry a donné le rôle de l'écran
sans choisir le titre. Il dit l'effet (ce que l'écran montre) et ne contient
aucun mot du moteur.

Une liste de **12 mois**, du mois courant au douzième, chaque mois portant ses
périodes. Par ligne :

- **le nom** (« Vacances de la Toussaint », « Salon du livre ») ;
- **les dates**, et le nombre de nuits ;
- **l'origine, en mots** ;
- **l'effet**, en mots et en couleur ;
- **deux boutons « moins fort » / « plus fort »**, et « HôteSmart décide » ;
- les gestes de la ligne (couper, supprimer) **derrière un menu ⋯**, pour que la
  ligne reste lisible.

En tête : la bannière d'horizon scolaire si elle a lieu d'être, puis les
**reconductions à confirmer**. En pied : **un bouton « Ajouter une période »**
qui ouvre le formulaire.

## 6. ⚠ CASE PERFORMANCE (obligatoire — CLAUDE.md)

### Catégorie de chaque donnée

| donnée | catégorie | traitement |
|---|---|---|
| les périodes des 12 mois, leur origine, leurs dates | **réglage et fait déjà écrits** | lus tels quels |
| l'effet (`crans`, `crans_mesures`, `crans_ajustes`) | **réglage** | lu tel quel, jamais recalculé à l'écran |
| `niveau_calcule`, `mediane`, `echantillon` | **non urgent**, mais **calculés par le moteur**, pas par l'écran | lus tels quels |

### Les huit points

1. **Un écran = un endpoint.** La fenêtre fait **un** appel :
   `GET /api/yield-evenements?property_id=…`, **sans `debut` ni `fin`** — sa
   fenêtre par défaut est **prospective sur 12 mois** (`f1 = aujourd'hui`,
   `f2 = +1 an`), mesuré dans le code. Aujourd'hui elle en fait un **par mois
   consulté**, plus un rechargement des prix du mois **à chaque geste**.
2. **Donnée non urgente = résumé pré-calculé.** Rien n'est agrégé à la lecture :
   l'écran lit des périodes et des réglages. Les mesures (`crans_mesures`,
   `mediane`) viennent du moteur, qui tourne par le cron.
3. **Cache navigateur.** **Sans objet, et volontairement** : ce sont des
   réglages tarifaires, qui se relisent après chaque geste — le rechargement
   **est** la preuve de l'écriture.
4. **`private, no-store` avant le PREMIER refus.** L'endpoint existe déjà ; **à
   vérifier et à corriger s'il ne le fait pas** (dette 90).
5. **Fichiers statiques versionnés.** Sans objet : aucun fichier neuf.
6. ⚠ **Jamais de lecture tronquée en silence. MESURÉ le 28 octobre 2026 sur
   staging, fenêtre 2026-10-28 → 2027-10-28 :**

   | source | entrées |
   |---|---|
   | vacances scolaires, **les trois zones** (7 par zone) | **21** |
   | jours fériés, calculés | **11** |
   | dates commerciales | **3** |
   | **total, hors ponts et hors événements de l'hôte** | **35** |

   Soit **~3 par mois**. Conséquences, et elles sont bonnes : la liste tient
   **sans pagination** et reste très loin des 1000 lignes où PostgREST
   tronque en silence ; et le groupement par mois n'est pas une nécessité
   technique mais un **choix de lisibilité** — ~3 lignes par mois se lisent,
   35 d'affilée non.

   ⚠ **Et ce nombre est un PLANCHER** : il ne compte ni les ponts, ni les
   événements de l'hôte (zéro sur staging, pas zéro chez un hôte réel). Une
   fenêtre à 50-60 lignes est à prévoir, ce qui ne change aucune de ces
   conclusions.
7. **Budget.** Un appel pour la fenêtre, et un test qui compte les appels de
   `apps/yield/prix.html`.
8. **Mesure AVANT / APRÈS** : appels, requêtes, octets. §8.

## 7. Invariants intacts

- **Le modèle en crans ne change pas** : le serveur reçoit et borne des crans.
- **`null` n'est jamais 0** : « pas encore mesuré » et « prix normaux » sont
  deux états distincts, à l'écran comme en base.
- **Les droits** : `droits_ecriture`, `droits.desactivable`, `droits.supprimable`
  commandent les gestes — et la garde réelle reste le serveur.
- **Aucune écriture nouvelle** : les quatre verbes existants
  (`POST`/`PATCH`/`DELETE` de `yield-evenements`) ne changent pas.
- **Aucune lecture provider**, aucun appel AirROI, aucun appel au moteur.

## 8. Mesure AVANT / APRÈS

**Mesurée le 28 octobre 2026**, `origin/main` contre l'arbre du lot.

| | AVANT | APRÈS |
|---|---|---|
| **sites d'appel** de `apps/yield/prix.html` | 12, sur 6 endpoints | **12, sur les 6 mêmes** |
| **appels réels pour parcourir 12 mois** | 1 à l'ouverture, **puis 2 par mois consulté** (`yield-evenements` + `yield-prix`, la flèche appelant `charger()`) — soit **23** pour les douze | **1**, et la navigation par mois n'existe plus |
| entrées rendues sur 12 mois | — | **35 mesurées** sur staging : 21 vacances (3 zones), 11 fériés, 3 dates commerciales. Plancher : hors ponts et hors événements de l'hôte |

⚠ **LE GAIN N'EST PAS DANS L'INVENTAIRE, ET C'EST LE POINT.** Les sites
d'appel sont **identiques** : aucun endpoint n'est ajouté ni retiré, donc un
test qui ne compterait que l'inventaire ne verrait **rien**. Ce qui change est
le nombre d'appels à l'**exécution** — et il tombe de 23 à 1 parce que la
fenêtre n'est plus bridée au mois.

⚠ **Et la réponse est plus grosse** : ~35 entrées au lieu de ~3. C'est assumé
— une fois, au lieu de douze. On est très loin des 1000 lignes où PostgREST
tronque en silence.

**Aucun de ces nombres n'est écrit sans avoir été mesuré.**

## 9. Tests

| fichier | ce qu'il garde |
|---|---|
| `tests/yf-ecran-periodes.test.js` | la fenêtre demande **12 mois** (aucun `debut`/`fin` au `GET`) ; un seul appel ; les 12 mois sont groupés |
| idem | **aucun mot du moteur** à l'écran : la liste de §3 est absente du rendu |
| idem | **un seul code couleur** : aucune classe d'origine ne porte de couleur |
| idem | `null` ≠ 0 : « pas encore mesuré » et « prix normaux » rendent deux états distincts |
| idem | « plus fort » / « moins fort » envoient des **crans bornés**, et « HôteSmart décide » envoie `null` |
| idem | lecture seule : aucun bouton, tous les faits |
| idem | le formulaire est **derrière un bouton**, fermé au premier rendu |

## 10. Décisions de Thierry, et ce qui reste ouvert

**Tranché le 28 octobre 2026** :
1. **Titre : « Quand vos prix bougent »** — validé, dans le menu du calendrier
   et en tête de la fenêtre.
2. **Deux degrés seulement** : « un peu » (±1) et « nettement » (±2). Pas de
   troisième — l'amplitude du moteur s'arrête à 2 (`AMPLITUDE_MAX`), et **on ne
   touche pas au moteur**.
3. **« prix normaux » est la porte de sortie, pas un plancher** : les vacances
   et jours fériés gardent toute l'amplitude (jusqu'à « moins chers » si la
   mesure le dit) ; ils ne sont simplement pas supprimables. **Aucune règle de
   moteur n'est ajoutée** — la table de droits du serveur dit déjà tout.
4. **Trois couleurs réservées** : le **noir** à la navigation, l'**ambre** à
   « ce qu'HôteSmart a fait pour vous », le **bleu** à ce qui est cliquable.
   D'où `--prune` (#5B2A86) pour l'état « moins chers ».

   ⚠ **PÉRIMÉ DEPUIS LE 3 NOVEMBRE 2026, et c'est ce lot qui le périme.**
   L'état « moins chers » n'existe plus : la période affiche **son niveau**
   sur l'échelle d'encre. `--prune` et `--prune-bg` sont sortis de
   `public/style.css` dans le même commit que leur dernier usage — c'était
   leur seul usage produit, et Thierry l'avait annoncé le 2 novembre.
5. **Champs date natifs conservés** — on garde le sélecteur du téléphone.
   ⚠ Conséquence assumée : leur format suit le **navigateur**, pas notre
   interface. Un hôte au navigateur anglais verra `mm/dd/yyyy` dans une page
   française.
6. **Le ☰ de la barre latérale passait au-dessus de la fenêtre** : corrigé dans
   ce lot (la fenêtre monte à 1001, le ☰ est à 1000 — on ne baisse pas un
   bouton partagé par vingt pages).

**Reste ouvert** :
- **Le sort du calendrier du mois** : retiré, parce que la page le porte déjà.
  S'il doit revenir **dans** l'écran, ce sera en second volet, et la case
  devra porter **une** information, pas cinq.
- **`apps/yield/prix.html` n'est pas internationalisée** (zéro `data-i18n`).
  Ce lot suit la convention du fichier — français en clair — plutôt que d'y
  faire une demi-migration. Le titre, lui, est traduit dans les trois langues
  côté menu du calendrier (`cal.yf_events`).
