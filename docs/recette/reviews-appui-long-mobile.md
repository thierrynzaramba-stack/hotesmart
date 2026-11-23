# Review du lot « appui long au téléphone » — trace

- **Arbre** : `/home/claude/hotesmart-appui`
- **Branche** : `fix-appui-long-mobile`
- **Plage relue** : `5e220196b70adfb2f1ab0b6c270eb87da5414812..84c916a38083e09a94be4496c2efe4ab3e13347c`
  (un commit). SHA collés depuis `git rev-parse`.
- **Le rapport nomme lui-même l'arbre et le SHA lus** : `/home/claude/hotesmart-appui`,
  `HEAD` = `84c916a38083e09a94be4496c2efe4ab3e13347c`, conformes au brief.
- **Une review**, aucun constat de sécurité : les correctifs partent sans
  nouvelle review (CLAUDE.md, « une review par commit »). Le lot ne touche pas
  l'envoi au voyageur.

## Fichiers cités par le rapport

| fichier cité | dans `git diff --name-only` de la plage |
|---|---|
| `pages/calendrier.html` | oui |
| `tests/calendrier-appui-long-mobile.test.js` | oui |
| `tests/calendrier-saisie-prix-dom.test.js` | oui |
| `tests/calendrier-v5.test.js` | oui |
| `tests/outils/banc-calendrier.js` | oui |
| `docs/specs/spec-appui-long-mobile.md` | oui |
| `docs/kb/calendrier-v5.md` | oui (listé, pas cité en constat) |
| `apps/menages/public.html` | hors plage — cité comme modèle (`clicIgnore`, cases de l'app ménage), pas comme constat |

## Suite donnée

| constat | gravité | suite |
|---|---|---|
| 1 — clic fantôme après le relâchement (barre, fiche, barres de réservation) | défaut potentiel, écriture au canal | **corrigé** : `click` avalé en capture au document, une fois, sous 700 ms et à moins de 10 px du relâchement d'un pointeur direct ; clavier jamais touché. Commentaire faux (« elle recevrait le relâchement ») corrigé dans la page, la spec et la KB. Tests 11 à 14 ; recette §5 points 5 et 6 |
| 2 — un jour passé au clavier : l'assertion ne gardait plus rien | mineur | **corrigé** : assertion `etat.sel === null` ajoutée ; rougit contre la garde retirée (version 7 de la contre-épreuve) |
| 3 — remplacement d'une sélection sur un autre bien sans test | mineur | **corrigé** : tests 15 et 16 à deux biens ; 15 rougit contre la version 6 |
| 4 — au doigt, `e.target` ne bouge jamais (capture implicite) | mineur | **corrigé** : case du relâchement lue par `elementFromPoint` pour un pointeur direct, `e.target` sinon ; test 8 réécrit sous capture implicite, rougit contre la version 5 |
| 5 — iPhone : pas de `contextmenu`, `user-select` sans préfixe | risque, à recetter | **corrigé** : `-webkit-user-select: none` et `-webkit-touch-callout: none` sur `.cal-case` (`shared/ui.css`) ; recette §5 point 7 |
| 6 — `navigator.vibrate` ignoré avant toute interaction | mineur | **noté** dans la spec, sans changement de code |
| 7 — renvoi faux dans l'en-tête du test | mineur | **corrigé** |

## Rapport tel que rendu

**Arbre et SHA lus**
- Arbre : `/home/claude/hotesmart-appui`, branche `fix-appui-long-mobile`, `git rev-parse HEAD` = `84c916a38083e09a94be4496c2efe4ab3e13347c`.
- Plage relue : `5e220196b70adfb2f1ab0b6c270eb87da5414812..84c916a38083e09a94be4496c2efe4ab3e13347c`, un seul commit (`84c916a3`). Sept fichiers : `pages/calendrier.html`, `docs/specs/spec-appui-long-mobile.md`, `docs/kb/calendrier-v5.md`, `tests/calendrier-appui-long-mobile.test.js`, `tests/calendrier-saisie-prix-dom.test.js`, `tests/calendrier-v5.test.js`, `tests/outils/banc-calendrier.js`.
- Je n'ai rien modifié dans l'arbre (`git status` vide). Pour les mutations, j'ai fait des copies jetables par `git archive` des deux SHA dans `/tmp`, supprimées ensuite.

**Mesures**
- Les trois fichiers de test du lot passent à 77/77.
- La contre-épreuve de la spec est confirmée : les 10 tests neufs, lancés contre la page de `5e220196`, donnent 9 rouges. Seul le test 5 passe.
- Les octets de la page sont exacts : 150 968 avant, 153 653 après.
- Aucun constat de sécurité.

**Ce qui tient**
- Le minuteur `presseLongue` est unique. Il est annulé à chaque sortie : relâchement, `pointercancel`, geste de souris périmé remplacé.
- Un second doigt est filtré au départ, au déplacement et à la fin du geste.
- Le `click` qui suit un geste sur la case elle-même est neutralisé par `detail > 0`.
- La lecture seule, l'absence de droit d'écriture et les jours passés sont bloqués dès le `pointerdown` : ni sélection, ni fiche.
- Sur un bien piloté par YieldFlow, un appui court dans la sélection mène à `actionPrix`, qui refuse avec son message.

1. **pages/calendrier.html:1240 et 1288-1289 (et 1239) — défaut potentiel, avec écriture au canal. Risque sur appareil réel, que jsdom ne peut pas montrer.**
   - **Ce qui change.** L'appui court agit désormais au `pointerup`. `agirSurLaCaseTapee` → `renderFlottante()` fait deux choses : elle affiche la barre fixe en bas d'écran ; elle appelle `degagerLaSelection()`, qui fait `scrollIntoView({block:'center'})` sur la case tapée. Ce défilement a lieu à chaque nouvelle sélection, donc presque à chaque premier appui.
   - **Le risque.** Sur mobile, le moteur envoie ensuite un `click` dont la cible est recalculée à la position du doigt, dans la page déjà modifiée (« ghost click » classique, très connu sur iPhone ; à vérifier sur Chrome Android). Seul le `click` qui retombe sur une case est neutralisé. Un `click` qui tombe ailleurs agit.
   - **Scénarios concrets :** appui sur une date de la bande basse, là où la barre apparaît : le `click` tombe sur un bouton de la barre ; si c'est « Fermer à la vente », `fermer()` pousse immédiatement un stop_sell au canal (rattrapable seulement par le toast « Annuler »). Appui en haut de l'écran, sur un mois chargé : après le défilement, le `click` tombe sur une barre de réservation (la fiche résa s'ouvre) ou sur un bouton `data-reduire` / `data-mois-nav` / `data-yf` ; `data-mois-nav` vide la sélection qui vient d'être posée.
   - **Le même risque existe pour l'appui long** chaque fois que le moteur considère encore le geste comme un tap : Android réglé sur « délai de pression » moyen ou long ; Android ancien, à environ 500 ms contre 450 ms ici ; iPhone. Dans ces cas, le `click` arrive dans la fiche qui vient de s'ouvrir.
   - **Le commentaire 1234-1238 (et la KB) se trompe de protection.** Il dit : « ouverte par le minuteur, elle recevrait le relâchement ». Avec la capture implicite du doigt, le `pointerup` va de toute façon à la case. Ce qui atteint l'élément nouvellement affiché, c'est le `click`, et l'ouvrir au relâchement n'y change rien.
   - **Correction.** Avaler le `click` issu du pointeur qui suit un geste traité, comme le fait l'app ménage avec `clicIgnore` : au `pointerup` d'un geste direct traité, mémoriser `{x, y, jusqua: Date.now() + 700}` ; un écouteur `click` sur `document`, en phase de capture, fait `preventDefault()` + `stopPropagation()` si `e.detail > 0`, si le délai court encore et si le clic tombe à ±10 px de cette position (une seule fois, puis on efface) ; ou bien un `touchend` non passif sur la case qui appelle `preventDefault()` quand le geste a été traité. Ajouter à la recette (§5 de la spec) : un appui court sur une date de la bande basse, et un appui court en haut d'un mois chargé.

2. **tests/calendrier-saisie-prix-dom.test.js:561-563 — mineur : un test a perdu sa protection.** Le test « un jour passe ne se selectionne toujours pas, aux deux ecrans » vérifie, pour le clavier, seulement que la fiche reste fermée. Depuis l'inversion, le clavier ne sélectionne plus en ouvrant la fiche : il sélectionne directement. Cette assertion ne garde donc plus rien. **Mesuré** : retirer `iso < AUJOURDHUI ||` du gestionnaire `click` (pages/calendrier.html:1518) dans la copie jetable laisse le test vert ; ajouter `assert.equal(m.b.cal.etat.sel, null)` le fait rougir. **Effet si la garde régressait** : un jour passé entre dans `etat.sel`, et le tap suivant sur une date future du même bien étend la sélection depuis ce jour passé ; comme le passé est filtré, la plage commence à aujourd'hui, alors que l'hôte ne l'a pas choisie. **Correction** : ajouter cette assertion après `B.clicClavier`.

3. **pages/calendrier.html:1278 et 1286-1289 — mineur : un chemin d'écriture sans test.** Le nouveau cas « une sélection sur un AUTRE bien est remplacée » n'est couvert par aucun test ; aucun test du dépôt n'empile deux biens au téléphone. **Mesuré** : remplacer `s && s.bien === bienId && s.duIso` par `s && s.duIso` (un appui sur le bien B étend la sélection du bien A) laisse les trois fichiers à 77/77. **Conséquence si ça régressait** : la barre agirait sur le bien A avec des dates tapées sur le bien B, donc écriture sur le mauvais bien. **Correction** : un test à deux biens — appui sur A puis sur B : `etat.sel.bien === 'B2'` et la sélection vaut `[isoB]` ; appui long sur B pendant une sélection sur A : la fiche de B s'ouvre et la sélection est vidée.

4. **pages/calendrier.html:1232-1233, tests/calendrier-appui-long-mobile.test.js:166, spec ligne 61 — mineur : le test prouve un geste que le téléphone ne produit pas.** La règle « relâché hors de sa case, rien ne s'ouvre » s'appuie sur `e.target`. Or un doigt ou un stylet est capturé implicitement par la case où il a commencé (le commentaire de la ligne 1490 le dit lui-même) : le vrai `pointerup` a donc toujours pour cible la case d'origine. **Scénario** : appui long sur le 12, le doigt glisse hors de la grille (Chrome ne fait généralement plus défiler une fois l'appui long reconnu ; c'est un risque, pas une mesure), relâchement : la fiche du 12 s'ouvre quand même. Le test 8 fait partir le `pointerup` d'un autre élément, ce que le navigateur ne fait pas au doigt. Conséquence limitée : une fiche s'ouvre, rien n'est écrit. **Correction** : pour un pointeur direct, trouver la case sous le doigt avec `document.elementFromPoint(e.clientX, e.clientY)`, en gardant `e.target` quand ce n'est pas disponible (jsdom) ; sinon, dire dans la spec que cette règle ne vaut qu'à la souris.

5. **pages/calendrier.html:1479-1488 — risque iPhone, à recetter.** iOS Safari n'envoie pas de `contextmenu` : sur iPhone, seule la feuille de style protège l'appui long. La règle partagée de `.cal-case` ne porte que `user-select: none` sans préfixe ; Safari a longtemps exigé `-webkit-user-select`, et il n'y a pas de `-webkit-touch-callout: none`. Les cases de l'app ménage, invoquée comme modèle par le commentaire, portent ces deux propriétés. **Scénario** : sur iPhone, l'appui long sélectionne le chiffre du jour (loupe) ; WebKit annule alors le contact (`pointercancel`) et la fiche ne s'ouvre jamais ; elle reste atteignable par « Plus… ». **Correction** : ajouter `-webkit-user-select: none; -webkit-touch-callout: none;` à la règle `.cal-case`, et une ligne iPhone à la recette du §5.

6. **pages/calendrier.html:1482 — mineur.** Chrome bloque `navigator.vibrate` tant que la page n'a reçu aucune interaction de l'utilisateur, et un `pointerdown` au doigt ne compte pas comme interaction (seuls `pointerup` / `touchend` comptent). Un appui long qui serait le tout premier geste après le chargement ne vibre donc pas, avec un avertissement en console. Sans conséquence fonctionnelle ; la spec dit « quand le téléphone le permet » ; à savoir pour la recette.

7. **tests/calendrier-appui-long-mobile.test.js:22-23 — mineur (document).** L'en-tête annonce « les deux versions naïves », au §5. La spec en compte trois, et la contre-épreuve est au §4 (le §5 est la recette). À corriger pour que le renvoi ne mène pas au mauvais endroit.

---

# Seconde review — le correctif de recette (barre sur une ligne, défilement)

- **Arbre** : `/home/claude/hotesmart-appui`
- **Branche** : `fix-appui-long-mobile`
- **Plage relue** : `693b6337da345a67f07cdf54ec029615b15e8a9c..46450a01744317945e160f7404c48c4a64fbaae2`
  (un commit, collé depuis `git rev-parse`).
- **Le rapport nomme lui-même l'arbre et le SHA lus** : `/home/claude/hotesmart-appui`,
  `HEAD` = `46450a01744317945e160f7404c48c4a64fbaae2`, conformes.
- **Seconde et dernière review du lot** (deux au plus hors envoi au voyageur),
  aucun constat de sécurité : les suites partent sans nouvelle review.

## Fichiers cités par le rapport

| fichier cité | dans `git diff --name-only` de la plage |
|---|---|
| `pages/calendrier.html` | oui |
| `shared/ui.css` | oui |
| `tests/calendrier-appui-long-mobile.test.js` | oui |
| `docs/specs/spec-appui-long-mobile.md` | oui |
| `docs/kb/calendrier-v5.md` | oui (listé, pas cité en constat) |

## Suite donnée

| constat | gravité | suite |
|---|---|---|
| 1 — à l'extension, on teste `jours[0]`, pas la date tapée : après un défilement, la page saute encore | défaut | **corrigé** : au téléphone, la cible est la date tapée (`dateTapee`, posée par `agirSurLaCaseTapee` là où la barre se redessine) ; test 20, rouge contre `46450a01` et contre la version « premier jour » |
| 2 — à la souris en fenêtre étroite, « Plus… » et « Réservation » hors d'atteinte | défaut | **corrigé** : ligne unique réservée à `@media (max-width: 899px) and (pointer: coarse)`, la souris garde le retour à la ligne ; `scrollbar-width: none` retiré ; test 19 réécrit (garde aussi l'ordinateur) |
| 3 — contour de focus rogné par `overflow-x: auto` | mineur | **corrigé** : `padding-block` et `padding-inline` de 3 px sur la ligne au doigt. L'ordre visuel (« Annuler » avant les boutons) diffère de l'ordre de tabulation : noté, sans effet au doigt |
| 4 — la note YieldFlow : 92 px ne vaut que pour un bien non piloté | mineur | **corrigé dans la spec et le commentaire CSS** (~140-150 px pour un bien piloté) ; recette §5 point 9 sur le Loft Pilotable |
| 5 — une case à peine rognée compte comme cachée | mineur | **corrigé** : visible si au moins la moitié de la case l'est ; test 21, rouge contre la visibilité stricte |
| 6 — tests 17-19 : le 17 ne couvre pas le constat 1, le 19 ne garde pas l'ordinateur | mineur | **corrigé** : tests 19 (réécrit) et 20 |

## Rapport tel que rendu

**Arbre et SHA lus**
- Arbre : `/home/claude/hotesmart-appui`, branche `fix-appui-long-mobile`, HEAD `46450a01744317945e160f7404c48c4a64fbaae2`
- Plage : `693b6337da345a67f07cdf54ec029615b15e8a9c..46450a01744317945e160f7404c48c4a64fbaae2`. Fichiers : `docs/kb/calendrier-v5.md`, `docs/specs/spec-appui-long-mobile.md`, `pages/calendrier.html`, `shared/ui.css`, `tests/calendrier-appui-long-mobile.test.js`
- Je n'ai rien modifié dans l'arbre (`git status` vide). Les essais ont été faits hors de l'arbre dans `/tmp`, puis supprimés.
- Suite demandée : **79/79 verts**.
- Contre-épreuve, avec les tests neufs posés sur `693b6337` (par `git archive`, hors de l'arbre) : 17 et 19 rougissent, 18 reste vert. C'est conforme au tableau de la spec.

**Réponse au point 1, l'ordinateur (≥ 900 px) : il n'a pas changé.** Les deux règles ont la même spécificité : `.row` (ui.css:77) et `.cal-flottante__actions` (ui.css:861). La seconde vient après, donc elle gagne : `gap: 8px` et `flex-wrap: wrap`, comme le style en ligne d'avant. Aucune autre règle ne vise ce span hors du bloc `@media (max-width: 899px)`. La page n'a pas de bloc `<style>`. Côté code, le chemin de l'ordinateur est intact : la garde `!estLarge()` l'écarte. Ce qui a changé, c'est la vue étroite **à la souris**, une fenêtre d'ordinateur sous 900 px (constat 2).

**1. DÉFAUT — `pages/calendrier.html:1152-1161` : à l'extension, on teste la visibilité du premier jour de la sélection (`jours[0]`), pas de la date tapée. La page saute encore.** Quand on étend vers le bas, `auIso` change mais `jours[0]` reste la première date (`agirSurLaCaseTapee`, l.1331-1332). Si l'hôte a fait défiler entre ses deux appuis, cette première date est passée sous l'en-tête collant ou hors de l'écran. `dateVisible` répond alors faux, et `scrollIntoView({block:'center'})` ramène la première date au centre, alors que la date tapée était visible. **Mesuré**, par un banc hors de l'arbre : appui sur le 3, alors visible ; le 3 passe sous l'en-tête (en-tête : bas à 120 px ; case du 3 : haut à 60 px) ; appui sur le 24, visible à 480 px ; résultat : sélection de 22 jours, et `scrollIntoView` appelé sur le **3**. **Conséquence**, avec des semaines de 70 px et le haut de la barre à 619 px (797 − 86 − 92) : le 3 est recentré vers 363-433 px ; le 24 descend à 573-643 px, sa moitié basse derrière la barre ; à quatre semaines d'écart, il est entièrement caché. C'est le défaut de la recette, dans un cas plus étroit. L'étape 8 de la recette (« deux semaines plus loin ») le déclenche dès que l'hôte fait défiler entre ses deux appuis. Le clavier (Entrée sur une case) suit le même chemin. **Aucun test ne le couvre** : le test 17 place les deux dates à 300 px. **Correction proposée** : au téléphone, viser la date qui vient d'être tapée, par exemple mémoriser `iso` dans `agirSurLaCaseTapee` et s'en servir comme cible quand `!estLarge()` ; ou ne jamais défiler à l'extension. **Test à ajouter** : première date à 40 px (sous l'en-tête), seconde à 300 px, zéro défilement attendu ; il doit rougir contre `46450a0`.

**2. DÉFAUT — `shared/ui.css:878-879` : en vue étroite à la souris, « Plus… » et « Réservation » deviennent inatteignables.** Les cinq boutons font environ 790 px. Au téléphone (387 px), la zone utile fait environ 341 px : on voit « Prix », « Fermer à la vente » et 27 px de « Bloquer les dates » ; « Réservation » et « Plus… » sont entièrement hors champ. À la souris (fenêtre de moins de ~835 px) : `scrollbar-width: none` retire la seule poignée ; la molette verticale ne fait pas défiler à l'horizontale ; à la souris il n'y a pas d'appui long (`if (!glisseMobile.direct) return`, l.1526), donc la fiche du jour ne s'atteint **que** par « Plus… ». Avant le correctif, les boutons passaient à la ligne et tout restait atteignable. **Correction proposée** : retirer `scrollbar-width: none` ; ou réserver la ligne unique à `@media (max-width: 899px) and (pointer: coarse)` et garder le retour à la ligne pour une souris. Au téléphone, un dégradé au bord droit rendrait le défilement découvrable. Ajouter à la recette : faire défiler jusqu'à « Plus… ».

**3. MINEUR — `shared/ui.css:878` : accessibilité de la ligne défilante.** `overflow-x: auto` force `overflow-y: auto`, et la ligne fait exactement la hauteur d'un bouton (44 px) : le contour de focus est rogné en haut et en bas, et à gauche du premier bouton. Correction : `padding-block: 3px` sur la ligne au téléphone, ou un `outline-offset` négatif. L'ordre visuel (« Annuler » avant les boutons) ne suit pas l'ordre de tabulation, qui reste celui du DOM : sans effet au doigt, visible au clavier en vue étroite ; acceptable si on le note.

**4. MINEUR — `shared/ui.css:881`, chiffres de la spec : la note YieldFlow.** La règle est correcte : la note est sur sa propre ligne, et `[hidden]` reste respecté. Mais sur un bien piloté par YieldFlow, la note d'environ 110 caractères prend 2 à 3 lignes : la barre fait alors environ 140-150 px, pas 92. La logique tient, puisque `dateVisible` lit la vraie géométrie, mais le « 238 → 92 px » ne vaut que pour un bien non piloté. Proposition : refaire l'étape 8 de la recette sur un bien piloté.

**5. MINEUR — `pages/calendrier.html:1169` : une date à peine rognée compte comme cachée.** La condition est un contenu strict (`r.top >= haut && r.bottom <= bas`). Une date de la rangée du haut, couverte de quelques pixels par l'en-tête collant, déclenche un recentrage au premier appui. Correction : une tolérance, par exemple visible si plus de la moitié de la case est visible ; ou `block: 'nearest'` avec un `scroll-padding`.

**6. MINEUR — tests 17 à 19 : ce qu'ils prouvent.** Test 18 : solide. Test 17 prouve « pas de défilement quand la première date est visible », et ne dit rien du cas où la date tapée est visible mais pas la première (constat 1). Test 19 est statique et ne garde pas l'ordinateur : supprimer `ui.css:861` laisse tout vert. Ajouter une assertion sur `flex-wrap: wrap` hors du bloc mobile.

**Points vérifiés et sans défaut** : plusieurs biens empilés (un seul en-tête `.cal-mois__tete`, global) ; barre masquée (cas inatteignable) ; extension vers une date avant la première (correcte) ; réserve de place (la dernière semaine reste atteignable) ; boutons désactivés ; compte et « Annuler » sur la première ligne ; compte de 21 tests exact.
