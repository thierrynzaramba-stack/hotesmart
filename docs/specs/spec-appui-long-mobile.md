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

- La fiche s'ouvre **au relâchement**, jamais sous le doigt encore posé :
  ouverte par le minuteur, elle recevrait le relâchement.
- Le relâchement doit atterrir sur la **même case** (même ancre que l'appui
  court) ; ailleurs, l'appui est abandonné et rien ne s'ouvre.
- Une sélection en cours se vide avant d'ouvrir la fiche, sinon la barre
  resterait derrière elle avec un contexte qui n'est plus celui de l'écran.
- Le doigt sent que l'appui long est pris : `navigator.vibrate(15)`, quand le
  téléphone le permet (sans effet sur iPhone).
- Le menu contextuel de l'appui long (Chrome Android) est retenu pendant le
  geste, comme dans l'app ménage.

**Ce que le lot ne touche pas.** L'ordinateur (grille large) : ses gestes
passent par `mousedown` sur les nuits, pas par ce code. Le glisser à la souris
en vue étroite : inchangé.

## 3. Case performance

1. Endpoint d'écran : sans objet, aucun appel ajouté ni retiré.
2. Donnée non urgente : sans objet.
3. Cache navigateur : sans objet, rien n'est mis en cache.
4. `private, no-store` : sans objet, aucun endpoint touché.
5. Fichiers statiques : sans objet, aucun fichier statique ajouté.
6. Lecture tronquée : sans objet, aucune lecture.
7. Budget : inchangé, un geste ne fait aucun appel réseau.
8. Mesure avant / après : 0 appel, 0 requête par geste, avant comme après.
   Octets de la page : 150 968 → 153 653 (+2 685), code et commentaires.

## 4. Preuves

**Tests.**

- `tests/calendrier-appui-long-mobile.test.js` : 10 tests neufs.
- `tests/calendrier-saisie-prix-dom.test.js` : 7 tests réécrits à l'énoncé
  nouveau, chacun gardant ce qu'il protégeait. Ce sont POINT 4, POINT 5,
  CONSTAT 5, CONSTAT 5 bis, CONSTAT 10, ADDENDUM B et ADDENDUM C.
- `tests/calendrier-v5.test.js` : la ligne d'inventaire « appui long = sélection »
  devient « appui long = fiche du jour » et « appui court = sélection ».
- `tests/outils/banc-calendrier.js` : un geste porte désormais sa position
  (`x`, `y` → `clientX`, `clientY`).

**Contre-épreuve (REVIEW.md règle 19).** Les tests neufs ont été lancés hors
de l'arbre (`git archive`) contre le code d'avant et contre trois versions
naïves du correctif :

| version | rouges | ce qu'ils gardent |
|---|---|---|
| `main` (code d'avant) | 9 sur 10 : tous sauf le 5 | l'inversion, la tolérance, le second doigt, l'ancre, le menu contextuel |
| naïve 1 : l'inversion sans la tolérance | 3 et 7 | la tolérance au tremblement, le second doigt |
| naïve 2 : aucune annulation au déplacement | 4 et 6 | la garde du défilement, la tolérance par axe |
| naïve 3 : sans `pointercancel` | 5 | le défilement pris par le navigateur sous les 10 px |

Le test 5 est un test de **non-régression** : il était déjà juste sur `main`.
Il rougit contre la version naïve 3, et c'est cette régression qu'il garde.

**Suite.** 9333 tests, 9333 verts. Les tests du lot à J+30, J+60 et J+200 :
68 verts, 0 rouge.

## 5. Recette (Thierry, sur son téléphone Android)

Sur `staging`, une fois la branche mergée par le chef de file :

1. Un appui court sur une date libre : la date se sélectionne et la barre paraît
   en bas.
2. Un appui court sur une autre date : la sélection s'étend.
3. Un appui long (doigt posé une demi-seconde, puis relâché) sur une date : la
   fiche « Configurer les dates » s'ouvre sur cette date. Le téléphone vibre
   peut-être, et aucun menu du téléphone ne s'ouvre.
4. Faire défiler le mois du doigt : rien ne se sélectionne, rien ne s'ouvre.
