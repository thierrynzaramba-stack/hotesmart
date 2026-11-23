# Lot « appui long au téléphone » — appui court = sélection, appui long = fiche du jour

Branche `fix-appui-long-mobile`, partie de `main` à
`5e220196b70adfb2f1ab0b6c270eb87da5414812`. Écran seul : `pages/calendrier.html`,
rien dans `api/` ni `lib/`.

## 1. Le défaut

Constaté par Thierry le 23 novembre 2026, sur son téléphone Android, page
`/calendrier`.

- Un **appui court** sur une date ouvrait la fiche du jour (« Configurer les
  dates »). C'était voulu (point 5 du 21 octobre).
- Un **appui long** devait poser la sélection et faire paraître la barre
  d'actions — Prix, Fermer à la vente, **Bloquer les dates**, Réservation,
  Plus… Il ouvrait **lui aussi** la fiche du jour.

La barre, donc le blocage de dates, était **inatteignable au téléphone**.

**Cause.** Un doigt posé « immobile » bouge d'un ou deux pixels, et le
téléphone l'envoie en `pointermove`. Le gestionnaire du document annulait
l'appui long au **premier** `pointermove`, sans seuil :

```js
document.addEventListener('pointermove', () => {
  if (glisseMobile && !glisseMobile.long) clearTimeout(presseLongue)
})
```

L'appui long ne partait jamais ; le relâchement valait un appui court, qui
ouvrait la fiche. Aucun test ne le voyait : le banc n'envoyait jamais de
`pointermove` pendant un appui long, et ses gestes n'avaient pas de position.

## 2. Le correctif — deux décisions de Thierry, le même jour

**a. Les deux gestes s'inversent** (choix de Thierry : « Oui, inverser »).

| geste au téléphone | avant | après |
|---|---|---|
| appui court sur une date, sans sélection | fiche du jour | **sélection + barre**, comme le clic de l'ordinateur |
| appui court sur une autre date du même bien | étend la sélection | inchangé |
| appui court **dans** la sélection | saisie de prix | inchangé |
| appui long | sélection + barre | **fiche du jour** de la date tenue |
| clic de souris en vue étroite, Entrée au clavier | fiche du jour | **sélection** (même énoncé que le tap) |

La fiche du jour reste atteignable par « Plus… » dans la barre.

**b. L'appui long tient malgré le tremblement.**

- Il ne s'annule qu'au-delà de **10 px sur l'un des deux axes**
  (`TOLERANCE_APPUI_LONG_PX`), et **seulement pour le doigt qui a commencé le
  geste** : le mouvement d'un second doigt n'annule plus rien. C'est la règle
  déjà retenue par l'app ménage (`apps/menages/public.html`, `TOLERANCE_PX`).
- Au-delà, le navigateur fait défiler et envoie `pointercancel`, qui clôt le
  geste comme avant.

**Détails du geste long.**

- La fiche s'ouvre **au relâchement**, comme toute action du tap.
- Le relâchement doit atterrir sur la **même case** (même ancre que l'appui
  court) ; ailleurs, l'appui est abandonné et rien ne s'ouvre. Au doigt, le
  `pointerup` est toujours adressé à la case de départ (capture implicite du
  pointeur) : la case du relâchement est donc celle **sous le doigt**, donnée
  par `document.elementFromPoint` (constat 4 de la review).
- Une sélection en cours se vide avant d'ouvrir la fiche, sinon la barre
  resterait derrière elle avec un contexte qui n'est plus celui de l'écran.
- Le doigt sent que l'appui long est pris : `navigator.vibrate(15)`, quand le
  téléphone le permet. Sans effet sur iPhone ; et Chrome l'ignore tant que la
  page n'a reçu aucune interaction, donc un appui long qui serait le tout
  premier geste après le chargement ne vibre pas (constat 6, sans conséquence).
- Le menu contextuel de l'appui long (Chrome Android) est retenu pendant le
  geste, comme dans l'app ménage. Sur iPhone, Safari n'envoie pas ce
  `contextmenu` : ce sont `-webkit-user-select: none` et
  `-webkit-touch-callout: none` sur `.cal-case` (`shared/ui.css`) qui empêchent
  la sélection du numéro du jour et sa loupe (constat 5).

**Le clic fantôme** (constat 1 de la review). Au doigt, le navigateur envoie un
`click` après le relâchement, et il en recalcule la cible à la position du
doigt — dans une page que le geste vient de changer (la barre paraît en bas, la
case est ramenée au centre, la fiche s'ouvre). Ce `click` tomberait sur
« Fermer à la vente », une barre de réservation ou un bouton de la fiche. Il
est donc avalé, une seule fois, s'il arrive dans les 700 ms et à moins de
10 px du relâchement. Le clic du clavier (`detail === 0`) n'est jamais
touché.

**Ce que le lot ne touche pas.** L'ordinateur (grille large) : ses gestes
passent par `mousedown` sur les nuits, pas par ce code. Le glisser à la souris
en vue étroite : inchangé. Seule exception : la règle `.cal-case` de
`shared/ui.css` (cases du téléphone uniquement) gagne ses deux propriétés
`-webkit-`.

**Correctif de recette (23 novembre 2026, Android de Thierry sur `staging`).**
Appui court et appui long conformes, blocage conforme ; mais **une seconde date
ne s'ajoutait pas** à la sélection. Mesuré sur un écran de 387 × 797 :

- la barre faisait **238 px** (ses cinq boutons sur trois lignes), plus les
  86 px de la navigation : 40 % de l'écran ;
- la page **recentrait** la date à chaque appui ;
- les semaines suivantes étaient donc **derrière la barre** : sur 31 dates du
  mois, celles du 14 au 31 décembre renvoyaient la barre sous le doigt
  (`elementFromPoint`), pas la case.

Correction, au téléphone seulement :

- la barre tient sur **une ligne de boutons** qu'on fait défiler du doigt, le
  compte et « Annuler » en tête, la note dessous : **238 → 92 px**, mesuré
  dans le même écran ;
- la page **ne défile plus** si la date choisie est déjà visible entre
  l'en-tête collant du mois et la barre ; elle ne défile que si la date est
  cachée.

L'ordinateur ne change pas : la ligne de boutons y garde `gap: 8px` et
`flex-wrap: wrap`, passés du style en ligne à la classe `cal-flottante__actions`,
et son défilement reste celui d'avant.

## 3. Case performance

1. Endpoint d'écran : sans objet, aucun appel ajouté ni retiré.
2. Donnée non urgente : sans objet.
3. Cache navigateur : sans objet, rien n'est mis en cache.
4. `private, no-store` : sans objet, aucun endpoint touché.
5. Fichiers statiques : sans objet, aucun fichier statique ajouté
   (`shared/ui.css` gagne deux propriétés sur une règle existante).
6. Lecture tronquée : sans objet, aucune lecture.
7. Budget : inchangé, un geste ne fait aucun appel réseau.
8. Mesure avant / après : 0 appel, 0 requête par geste, avant comme après.
   Octets de la page : 150 968 → 155 608 (+4 640), code et commentaires ;
   `shared/ui.css` : +2 propriétés et 4 lignes de commentaire.

## 4. Preuves

**Tests.**

- `tests/calendrier-appui-long-mobile.test.js` : 21 tests neufs (18 du lot,
  3 du correctif de recette).
- `tests/calendrier-saisie-prix-dom.test.js` : 7 tests réécrits à l'énoncé
  nouveau, chacun gardant ce qu'il protégeait. Ce sont POINT 4, POINT 5,
  CONSTAT 5, CONSTAT 5 bis, CONSTAT 10, ADDENDUM B et ADDENDUM C.
- `tests/calendrier-v5.test.js` : la ligne d'inventaire « appui long = sélection »
  devient « appui long = fiche du jour » et « appui court = sélection ».
- `tests/outils/banc-calendrier.js` : un geste porte désormais sa position
  (`x`, `y` → `clientX`, `clientY`).
- Le test « un jour passé ne se sélectionne toujours pas » gagne une assertion
  au clavier (constat 2 de la review) : depuis l'inversion, « pas de fiche » ne
  gardait plus rien seul.

**Contre-épreuve (REVIEW.md règle 19).** Les tests neufs ont été lancés hors
de l'arbre contre le code d'avant (`git archive` de `main`) et contre sept
versions fautives du correctif :

| version | rouges | ce qu'ils gardent |
|---|---|---|
| `main` (code d'avant) | 17 sur 18 : tous sauf le 5 | l'inversion, la tolérance, le second doigt, l'ancre, le menu contextuel, le clic fantôme, les deux biens |
| 1 : l'inversion sans la tolérance | 3 et 7 | la tolérance au tremblement, le second doigt |
| 2 : aucune annulation au déplacement | 4 et 6 | la garde du défilement, la tolérance par axe |
| 3 : sans `pointercancel` | 5 | le défilement pris par le navigateur sous les 10 px |
| 4 : sans avaler le clic fantôme | 11, 13 et 14 | le clic fantôme, après l'appui court comme après l'appui long |
| 5 : la case du relâchement lue sur `e.target` | 8 | l'ancre au doigt, sous capture implicite |
| 6 : une sélection sur un autre bien étendue | 15 | la barre n'agit que sur le bien tapé |
| 7 : le clic du clavier sans la garde du jour passé | « un jour passé… » (fichier saisie-prix) | le jour passé au clavier |
| tête d'avant le correctif de recette (`693b6337`) | 17 et 19 | la page immobile sous le doigt, la barre sur une ligne |
| 8 : ne jamais défiler au téléphone | 18 | une date cachée est ramenée à l'écran |

Le test 5 est un test de **non-régression** : il était déjà juste sur `main`.
Il rougit contre la version 3, et c'est cette régression qu'il garde.

**Suite.** 9341 tests, 9341 verts. Les trois fichiers du lot à J+30, J+60 et
J+200 : 85 verts, 0 rouge.

**Review.** Une review, sans constat de sécurité ; ses sept constats et la
suite donnée sont dans docs/recette/reviews-appui-long-mobile.md.

## 5. Recette (Thierry, sur son téléphone Android)

Sur `staging`, une fois la branche mergée par le chef de file :

1. Un appui court sur une date libre : la date se sélectionne et la barre paraît
   en bas.
2. Un appui court sur une autre date : la sélection s'étend.
3. Un appui long (doigt posé une demi-seconde, puis relâché) sur une date : la
   fiche « Configurer les dates » s'ouvre sur cette date. Le téléphone vibre
   peut-être, et aucun menu du téléphone ne s'ouvre.
4. Faire défiler le mois du doigt : rien ne se sélectionne, rien ne s'ouvre.
5. Un appui court sur une date de la **dernière ligne** du mois, là où la barre
   apparaît : la barre paraît, et aucun de ses boutons n'agit tout seul.
6. Un appui court **en haut** d'un mois chargé de réservations : la date se
   sélectionne, et aucune fiche de réservation ne s'ouvre toute seule.
7. Si un iPhone est sous la main : un appui long n'affiche ni loupe ni
   sélection du numéro, et ouvre la fiche du jour.
8. (Correctif de recette) Un appui court sur une date, puis un appui court sur
   une date **deux semaines plus loin** : la sélection s'étend, la barre ne
   cache pas les semaines suivantes, et la page ne saute pas.
