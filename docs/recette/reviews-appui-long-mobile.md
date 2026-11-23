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
