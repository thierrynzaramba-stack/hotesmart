# Étape 2 — la fiche d'un logement, en lecture

**Décisions de Thierry, 21 octobre 2026**, en réponse aux quatre questions
d'ouverture de l'étape :

> « 1. Fiche sur `/logements/:id`. `/biens/:id` redirigera à l'étape 4 ;
> l'ancien écran reste intact pendant la recette. 2. Sur la fiche, la même note
> sur 5 avec l'étoile que sur la liste : les deux écrans doivent dire la même
> chose. Les pouces servent uniquement à la propreté, en couleur neutre, jamais
> en rouge (la charte réserve le rouge aux erreurs et à la suppression). Juste
> le compteur, sans légende. 3. Supprimer : on s'aligne sur le serveur, c'est
> lui la vraie protection, et c'est la même règle que pour la suppression de
> compte. Bouton désactivé tant que le bien est relié à une annonce, avec la
> raison « Déconnectez d'abord ses canaux ». Quand il est actif, la
> confirmation dit ce qui sera effacé, avec les nombres (réservations,
> messages…). Corrige la spec dans le même commit. »

La spec §3 porte les trois corrections, dans ce même commit.

---

## Ce qui est livré

`pages/logement.html`, servie sur `/logements/:id` par une réécriture de
`vercel.json` (destination **sans** `.html`, `cleanUrls: true`). Le rendu vit
dans `shared/logement-fiche.js` — un module, pas une balise `<script>` — pour
qu'il se teste sans monter la page.

Sept blocs, tous en **lecture seule** : en-tête, « Où il est en vente », Prix,
Le logement, Supprimer, Ménage, Avis des voyageurs, Réglages.

**Aucune action n'agit** : ni photo, ni interrupteur d'assistant, ni sélecteur
de mode des prix, ni édition sur place, ni suppression. C'est l'étape 3. Le
bouton Supprimer est **rendu** parce que son état est une information — la
raison du refus se lit avant le clic —, mais il ne déclenche rien.

## Les quatre états, portés jusqu'à l'écran

C'est la règle du lot, et elle vaut bloc par bloc :

| ce que l'endpoint rend | ce que la fiche affiche |
|---|---|
| `null` + le bloc dans `indisponibles` | « … n'est pas lisible pour l'instant. », en muet — **le bloc existe** |
| `null` + le bloc dans `refuses` | **rien du tout** : le bloc n'est pas rendu |
| `[]`, `{connue:false}`, `0` | une **réponse** : « Aucune prestataire sur ce logement » |
| des données | le contenu |

Taire un bloc qu'on n'a pas pu lire le ferait passer pour vide, et
« aucune prestataire » sur un bien qui en a deux est le mensonge que tout ce
lot interdit. À l'inverse, on ne montre jamais ce qui mène à un refus.

## La note : les deux écrans disent la même chose

La fiche appelle `avisHtml` — **le rendu de la liste**, pas une copie. Même
étoile du sprite (`i-review`), même `4,9 / 5 · 336 avis`, même infobulle qui
dit l'échelle. `lireFiche` réutilise `lireAvisParBien`, le lecteur de la liste.

Les **pouces** sont à part : ils ne disent que la **propreté sur 30 jours**, en
couleur neutre, jamais en rouge, et **sans légende** — juste le compteur. Le
libellé existe pour le lecteur d'écran (`.sr-only`), pas à l'écran. Un troisième
compteur, en pointillés, dit « pas encore analysé » : ce n'est pas « rien
signalé », et les confondre inventerait une propreté qu'on n'a pas mesurée.

⚠ `lireAvis` rend désormais `total_proprete` et non `total` : la note porte son
propre `total` (le nombre d'avis), et la collision aurait fait afficher le
nombre d'avis de propreté à la place du nombre d'avis.

## Supprimer : la règle du serveur, pas celle de la spec d'origine

La spec disait « bouton désactivé si le bien a des réservations ou des
messages ». **Le serveur, lui, les purge** et refuse un bien encore relié à une
annonce. On s'aligne sur lui : `suppression.possible` vient de l'endpoint, et
la raison affichée est la sienne.

⚠ **`possible: null` DÉSACTIVE AUSSI.** Si on n'a pas pu lire les canaux, on ne
sait pas si le bien est en vente — ouvrir l'action la plus destructrice du
produit sur une lecture ratée est le seul cas qu'on ne peut pas se permettre.
Le test l'exerce sur `null`, `{}` et `{possible: null}`.

⚠ **Et le masquage par droit se double de la garde serveur.** Sans
`reglages: write`, le bloc n'est pas rendu — mais c'est le `DELETE` qui protège,
et lui seul. Un test vérifie que la garde n'est pas **inversée** : chercher la
chaîne `peutEcrire('reglages')` dans le source laisserait passer un `!`.

---

## Inventaire — ce que la recette au banc a trouvé, et qui n'était dans aucune spec

Cinq constats, tous **mesurés** sur capture à 1440 et 390 px, tous corrigés
dans ce commit. Aucun n'était visible à la lecture du code.

### 1. La forme des rendus partagés ne suivait pas le rendu

`canauxHtml` et `avisHtml` sont appelés par la liste **et** par la fiche. Leurs
règles CSS vivaient dans `pages/logements.html` seule : la fiche rendait
**« AirbnbBooking.comReservation directe »** — trois noms collés, sans
pastille, sans point d'état, sans gouttière.

Le rendu était bon ; c'est la feuille qui manquait. Les huit règles partagées
ont migré dans `shared/ui.css`, et un test refuse qu'une page les redéfinisse —
« une règle partagée par deux écrans vit dans un module commun, sinon les deux
copies divergent » (CLAUDE.md).

### 2. La barre du bas couvrait la fin de la page au téléphone

Mesuré à 390 px : la dernière ligne du bloc « Réglages » passait **sous** la
barre, de 23 px, et rien ne le signalait — on croit la page finie. `.bottombar`
est `position: fixed`, donc le défaut revient sur toute page qui défile.

`.page` et `.cal-page` dégageaient déjà la barre, chacune de son côté. Le
conteneur des **deux** écrans du lot est désormais déclaré une seule fois dans
`shared/ui.css`, avec sa marge basse.

⚠ **Et la règle doit être dans la feuille, pas dans la page** : le `padding`
raccourci déclaré par la page écrasait le `padding-bottom` de la feuille
commune. Le premier correctif n'a donc rien changé, et la mesure l'a dit.

### 3. `canaux_echec` et `canaux_vu_le` étaient muets

L'endpoint les descend depuis l'étape 0, et la fiche n'en disait rien. Des
pastilles « en vente » sans leur date laissent croire à un état d'aujourd'hui
alors qu'il peut dater de trois jours — et un relevé **en échec** se lisait
comme un succès.

La ligne vit sous les pastilles, et **réutilise** `fraicheurDuCompte` et
`releveDuCompteEnEchec` du module commun — dont la règle des 24 heures.
L'échec passe devant la date : « vérifié il y a deux minutes » sur un relevé
qui a échoué serait faux.

⚠ `releveDuCompteEnEchec` **était du code dormant** : exportée, testée, appelée
par aucun écran. La spec §1 interdit le code dormant ; la fiche est son
appelant.

### 4. L'assistant en pause était muet

`assistant_en_pause` descend depuis l'étape 0, et la **liste** le signale sur
chaque carte. La fiche n'en disait rien : un hôte qui ouvre la fiche d'un bien
en pause y lisait un bien ordinaire — alors qu'aucun message ne part pour ce
logement.

C'est un **état**, pas l'interrupteur : l'interrupteur agit, donc il reste à
l'étape 3. Dire l'état est de la lecture, et c'est ce qui manquait. Le rendu
réutilise `signalDuBien`.

### 5. Le lien « Voir le calendrier » manquait

La spec §3 le met dans l'en-tête. C'est un **lien**, donc de la lecture : il a
sa place à l'étape 2. Il vise la route déclarative `/calendrier?bien=:id`,
honorée par la V5 (le bien demandé s'affiche en tête), avec l'identifiant
encodé.

### Mineur, corrigé aussi

Le bouton disait « Supprimer ce logement », juste sous le titre de bloc
« Supprimer ce logement ». Il dit « Supprimer ».

---

## Ce qui reste, et que Thierry tranche

**Les pastilles de canaux apparaissent deux fois** : dans l'en-tête et dans le
bloc « Où il est en vente », à cent pixels d'écart. La spec §3 demande les
deux — l'en-tête comme résumé, le bloc comme détail avec son état et sa date —
donc elles sont gardées. Si la redondance gêne en recette, c'est l'en-tête qui
les perd : le bloc porte l'information complète.

---

## Mesures

- **Suite complète : 5643 tests, 5643 verts, zéro rouge.**
- **Contre-épreuve calendaire** (`tests/outils/horloge-decalee.js`, préchargé) :
  J+15, 30, 60, 90 et 200 → 53/53 à chaque fois sur les deux fichiers neufs.
- **Contre-épreuve par mutation**, six gardes neuves, **six tuées** :
  l'échec de relevé qui ne passe plus devant la date ; `possible !== true`
  devenu `=== false` ; les pastilles qui repartent dans la page ; la marge
  basse à zéro ; l'état de l'assistant qui se tait ; la garde de droit du
  bouton Supprimer inversée.
- **Sonde au banc**, trois cas (plein, creux, blocs refusés) × deux largeurs :
  aucun débordement horizontal, aucune cible sous 44 px, aucune clé i18n non
  traduite, aucun `undefined`/`NaN`/`null` à l'écran.
- `node scripts/i18n-check.js` : 671 clés dans les trois langues.

## Fichiers

| fichier | ce qu'il porte |
|---|---|
| `pages/logement.html` | la page : lecture de l'identifiant dans le chemin, états, verrou, garde de droit |
| `shared/logement-fiche.js` | le rendu des sept blocs — importe la liste, ne la recopie pas |
| `lib/logement/lecture.js` | `lireFiche` porte la même note que la liste (`lireAvisParBien`) |
| `shared/ui.css` | le conteneur des deux écrans, sa marge basse, les huit règles partagées |
| `pages/logements.html` | perd le CSS partagé et son conteneur (ils ont migré) |
| `vercel.json` | la réécriture `/logements/:id` |
| `tests/logement-fiche-dom.test.js` | 33 tests du module |
| `tests/logement-page-dom.test.js` | 20 tests de la page |
| `tests/pages-non-delegables.test.js` | la fiche classée **déléguable**, avec sa raison |
