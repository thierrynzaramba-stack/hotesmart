# Page « Calendrier » V5 (lot 3)

Spec : `docs/specs/spec-refonte-ui-v5-lot-calendrier.md` (dont §12 inventaire
conservé/déplacé/retiré). Fond : `docs/specs/inventaire-calendrier-yieldflow.md`.
Page : `pages/calendrier.html` (route `/calendrier`). Tests :
`tests/calendrier-v5.test.js`.

## Étape 1 (12 octobre 2026) — grille, cinq actions, popup, formulaire, fiches

- **UNE page, deux dispositions** (planning multi-biens ≥ 900 px, mois un
  bien < 900 px), bascule au seuil. Lecture unique `GET /api/calendar`
  (calendar-core), fenêtre du pilote lue de `/api/yield-pilote` par bien
  piloté — jamais d'état inventé, un bien illisible n'a pas de 4e état.
- **Les quatre états en couleur** (§4.1, dette 20 fermée) : vendue /
  ouverte / fermée (hachures ambre) / « pas encore ouverte » (pointillés,
  hors fenêtre du pilote). Règle UNIQUE `etatDeNuit` du contrat partagé ; un
  BLOCAGE de l'hôte prime sur « pas encore ouverte ». La vendabilité se lit
  EXCLUSIVEMENT dans `calendar_inventory` (constat 12).
- **Le contrat de parité** (`shared/calendrier-contrat.js`, §14) : les cinq
  actions, les dix rubriques de la popup (stop vente et orphelines
  comprises) et les champs de fiche (Statut partout) sont UNE constante —
  les deux dispositions la consomment. Devise et dates via `Intl` partout
  (test GBP).
- **Les cinq actions** : Prix (saisie INLINE desktop, popup rubrique prix
  mobile ; verdicts du writer conservés ; toast de succès avec « Annuler »
  10 s = VRAIE ÉCRITURE INVERSE des valeurs relevées avant — l'undo
  d'affichage est mort, §11.1) ; Fermer/Rouvrir (stop_sell seul ; rouvrir si
  tout fermé ; piloté+fermer → Bloquer ; nuit sous blocage → refus + fiche) ;
  Bloquer les dates ; + Réservation ; Plus… (popup).
- **Formulaire** : « Réservation » / « **Bloquer les dates** » (dette 64
  fermée — raison obligatoire, AUCUN montant, aucun voyageur ; le mot
  « Indisponible » a disparu). Réservation : champs A.8, capacité en
  personnes, « Envoyée au canal ✓ » en deux temps (le cœur apprend par le
  feed, relecture 8 s).
- **Fiches** : un composant (feuille latérale / plein écran) — champs du
  contrat, canal au point de couleur, conversation résolue par booking_id,
  évaluation par le bus dès le jour du départ, badge e-mail, modification
  (prix absent si non touché, total 3 cas), annulation confirmée (la barre
  reste), fiche de blocage complète.
- **Nuits orphelines** : détection extraite en module commun
  (`shared/nuits-orphelines.js`, règle de l'ancien mobile VERBATIM), marque
  ⚠ sur LES DEUX grilles ; réglages (autofix sans stop_sell + prix spécial)
  dans la popup (arbitrage (d)), destination volet Prix à l'étape 2.
- **Arbitrages du 12 octobre** : (a) sélecteur de vue mobile CONSERVÉ à
  l'étape 1 (seule consultation des min nuits au téléphone avant le détail
  de nuit) ; (b) marques `~`/`✎` à l'étape 2 (données de yield-prix) — à
  l'étape 1 une nuit vendue affiche son prix d'inventaire, le « prix
  vendu » viendra avec le détail de nuit ; (c) « Journal des prix » hors
  étape 1 ; (d) orphelines dans la popup.
- **Anciennes pages INTACTES** : la redirection de biens-calendrier et
  calendrier-mobile sera un commit séparé après la recette de Thierry.
- Limite connue : `libelleStatut` et les notes de `droitsResa` (module
  partagé avec les anciennes pages) sont en français dans le module — à
  traduire quand le module ne servira plus que la V5.

## 21 octobre 2026 — LA SAISIE DU PRIX NE PARTAIT PAS AU GESTE DE L'HÔTE

**Constat de Thierry, en production, sur « Ofuro Futari »** : « je sélectionne
des jours, je clique dans la case, il est impossible d'écrire dedans ». Rien
n'était écrit — vérifié en base (`calendar_inventory` sans écriture depuis le
19 octobre, `prix_hote` à zéro ligne) et chez Channex (prix identiques au
cœur) — et **l'écran ne disait rien**.

**La cause, et pourquoi deux diagnostics l'ont manquée.** Le `mousedown` de la
cellule fait `preventDefault()`, pour que le glisser ne sélectionne pas du
texte. Trois conséquences enchaînées :

1. la cellule ne prend **jamais** le focus au clic, donc la saisie au clavier
   (Entrée / F2 / un chiffre) ne pouvait pas partir à la souris ;
2. **aucun clic n'ouvrait la case de saisie** — seul le bouton « Prix » de la
   barre flottante le faisait ;
3. une fois la case ouverte, un clic DEDANS repassait par ce même `mousedown`
   (le champ vit dans la cellule, son événement bule), qui refaisait une
   sélection d'un seul jour et empêchait le focus.

Mes deux premiers bancs passaient par le **bouton**, pas par le clic dans la
case : ils étaient verts. C'est Thierry qui a nommé le geste.

**Ce qui est corrigé** (branche `fix-calendrier-saisie-prix`) :

| | règle posée |
|---|---|
| 1 | Un **clic simple** dans une case **de la sélection** ouvre la saisie pour **toute** la sélection ; un **glisser** refait une sélection. Le geste porte trois informations — d'où il part, s'il a BOUGÉ, s'il part DANS la sélection posée — et c'est la troisième qui les sépare. |
| 2 | La cellule **ignore les événements venus de la case de saisie** (`venuDeLaSaisie`), sur `mousedown` ET sur `keydown`. |
| 1 bis | Après une sélection, la cellule reçoit le focus **à la main** (`td.focus()`), puisque `preventDefault()` l'en prive : taper un chiffre juste après un glisser ouvre la saisie **sans perdre les jours**. |
| 5 | Le téléphone passe du **toucher au POINTEUR**. `touchstart` n'existe pas à la souris : sous 900 px avec une souris, aucune sélection n'était possible et chaque clic rouvrait la popup du jour. `pointerType` décide de l'appui long — nécessaire au doigt (sinon le scroll sélectionnerait), sans objet à la souris. |
| 6 | Après « Enregistrer » (popup **et** saisie dans la case), la sélection et la barre d'actions se vident. `viderSelection()` efface aussi la **peinture**. |
| 7 | Un jour passé porte `aria-disabled="true"` sur les deux écrans, et `cursor: not-allowed` (c'était `cursor: default` : une case d'apparence ordinaire dont le clic ne faisait rien, sans un mot). |

⚠ **Un défaut de plus, trouvé par le banc et pas à la lecture** : valider par
**Entrée** faisait remonter la touche jusqu'à la cellule, dont le `keydown`
**rouvrait aussitôt une nouvelle saisie**. C'est la même classe de défaut que
le point 2, sur un autre événement — d'où un seul énoncé, `venuDeLaSaisie`,
utilisé par les deux écouteurs.

⚠ **PEINDRE, JAMAIS RE-RENDRE PENDANT UN GESTE.** L'ancien appui long appelait
`renderGrilleMobile()`, qui détruit par `innerHTML` la case que le doigt
survole. Les deux écrans ont maintenant leur peintre
(`peindreSelectionDesktop` / `peindreSelectionMobile`), qui ne touche que des
classes — et qui sait **effacer** quand `etat.sel` est nul.

### Le banc DOM : `tests/outils/banc-calendrier.js`

`tests/calendrier-saisie-prix-dom.test.js` (18 tests) rejoue les gestes dans un
vrai DOM. Le banc **exécute le module de la page**, pas une copie : corps du
`<script type="module">` pris tel quel, `import` retirés (leurs symboles
injectés avant, avec les **vrais** modules partagés, dans la **même** fenêtre —
deux realms font des comparaisons fausses), `init()` coupé, et le squelette est
le **vrai corps HTML** de la page plutôt qu'une liste d'ancres recopiée.

Le point d'observation est **`fetch`**, pas `appel()` : le test traverse ainsi
le vrai code d'appel — jeton, en-tête de compte, `!r.ok`, `e.code`.

Deux manques de jsdom 26, à connaître : **ni `PointerEvent` ni `CSS.escape`**.
Le banc fabrique le premier depuis un `MouseEvent` avec `pointerType` posé
dessus, et fournit le second (algorithme CSSOM). Sans `CSS.escape`, la page
levait un `ReferenceError` que **jsdom avale** : le test voyait seulement « la
saisie ne s'ouvre pas », pour une raison qui n'était pas la bonne.

⚠ **Une garde de droits se prouve par le GESTE, et jamais à vide.** Les deux
tests de lecture seule jouent le même geste **avec** puis **sans** le droit, et
exigent qu'il produise quelque chose dans le premier cas. Sans ce couplage, ils
restaient verts contre l'ancien code — où mes événements de pointeur n'étaient
écoutés par personne. `tests/lecture-seule.test.js` est retargé sur
`pointerdown` : la propriété testée ne bouge pas, seul le nom de l'événement
change.

**Contre-épreuve (REVIEW.md règle 19)** : les 18 tests lancés hors de l'arbre
contre `origin/main` (`git archive`, jamais `git show > fichier`) donnent
**16 rouges** ; les 2 verts sont les tests de non-régression (un glisser ne
saisit pas ; un jour passé ne se sélectionne pas). Suite complète : **5537/5537**.

### La review du même jour — 18 constats, et la racine était une ligne

La première version de ce correctif a été **reprise en entier après review**.
Elle avait introduit un défaut plus grave que celui qu'elle fermait, et sa
racine tenait en une ligne.

⚠ **LA RACINE : le `e.preventDefault()` du `mousedown` n'achetait RIEN.**
Il était là « pour que le glisser ne sélectionne pas de texte » — rôle que
`shared/ui.css` tenait déjà par `.cal-nuit { user-select: none }`, et le
glisser de réordonnancement est fermé de son côté par
`shared/reordonner-biens.js`, qui annule tout `dragstart` non armé par la
poignée. Cette ligne inutile coûtait **trois mécanismes compensatoires et
quatre défauts** :

| | ce que le `preventDefault()` a coûté |
|---|---|
| ⚠ **grave** | Il fallait rendre le focus à la main (`td.focus()`). Ce focus **volait celui de la case de saisie ouverte**, et le `blur` de cette case **enregistrait** : un simple **double-clic poussait quatre nuits au canal** au prix pré-rempli, que personne n'avait tapé. Sur une fenêtre de 90 jours, un clic de travers en repoussait 90. |
| | Le même enchaînement nullifiait `etat.sel`, puis `actionPrix` levait un `TypeError` **avalé par le navigateur** : le clic ne faisait rien, en silence — le symptôme même que ce lot existait pour fermer. |
| | `td.focus()` sans `preventScroll` fait défiler la grille horizontale sous un curseur immobile : le clic est alors **re-noté comme un glisser**, et la saisie ne s'ouvre pas — le symptôme de Thierry, réintroduit sur les bords de l'écran. |
| | L'exclusion `venuDeLaSaisie` devenait obligatoire sur **chaque** écouteur de la cellule — et la preuve qu'on l'oublie, c'est que le rebond d'Entrée a été trouvé sur le second écouteur, après le premier. |

**Correctif : la ligne est supprimée**, `td.focus()` avec elle,
`user-select: none` est ajouté à `.cal-case` (la vue étroite à la souris en a
besoin, elle ne l'avait pas), et le navigateur reprend le focus, le clic dans
le champ et la propagation.

⚠ **ET LE TEST QUI PROUVAIT LE CONTOURNEMENT A ÉTÉ RETOURNÉ.** Il affirmait
`activeElement === cellule`, donc **l'APPEL** à `td.focus()` — il verrouillait
le contournement, et aurait rougi contre le correctif juste. La propriété juste
est l'inverse : **le `mousedown` ne doit RIEN annuler**, et c'est le navigateur
qui donne le focus. Le test l'affirme (`defaultPrevented === false`) et vérifie
le `user-select` des deux sélecteurs dans la feuille. *Un test qui décrit le
remède au lieu de la propriété transforme un contournement en contrat.*

Les quatorze autres constats, par famille :

- **Le geste n'était pas borné.** Pas de filtre `e.button` (un clic droit
  ouvrait la saisie **derrière** le menu contextuel, et refermer ce menu
  enregistrait) ; pas de test `e.buttons === 0` sur le survol (un relâchement
  hors de la page faisait suivre la sélection à un **curseur nu**) ; un
  `mouseup` égaré clôturait un geste périmé — d'où un appui de capture au
  niveau du document qui **jette le geste armé** au début de chaque nouvel
  appui ; et `bouge` était posé **après** les refus, si bien qu'un glisser
  ne traversant que des jours passés était compté comme un clic.
- **L'ancre « appuyer et relâcher sur le MÊME élément »**, que `click`
  offrait gratuitement, avait été perdue en passant au pointeur : un appui
  **abandonné** ouvrait ce que l'hôte venait d'abandonner. Les deux
  gestionnaires de document exigent maintenant que le relâchement atterrisse
  sur une case du même bien.
- **Le téléphone.** `pointerenter` n'atteint **jamais** les cases voisines au
  doigt (capture implicite du pointeur) : le « appui long puis glisser » que
  le commentaire promettait n'a **jamais** pu marcher, ni avant ni après — la
  promesse est retirée, l'extension au doigt se fait par **tap**, et
  l'étendre au glisser demanderait de la géométrie que jsdom ne rend pas (on
  ne livre pas un geste qu'aucun test ne peut prouver). La garde « un
  déplacement annule l'appui long », posée par une review antérieure sur
  `touchmove`, est **rétablie** sur `pointermove`. Un **second doigt** volait
  le geste du premier : le geste porte son `pointerId`. Un **stylet** (`pen`)
  et un pointeur **indéterminé** (`''`) étaient rangés du côté de la souris,
  donc sélectionnaient sans appui long — la question n'est pas « est-ce un
  doigt » mais « est-ce une manipulation **directe** » (`!== 'mouse'`).
- ⚠ **Les cases du mois sont des `<button>` focalisables, donc elles doivent
  répondre au CLAVIER.** Remplacer `click` par le pointeur les avait rendues
  **muettes** à Entrée et Espace — le défaut est déjà gravé dans
  `apps/menages/prestataires.html`. Un `click` est rétabli, et `detail === 0`
  distingue le clic du clavier de celui qui suit un geste de pointeur.
- **Le mobile ne suivait pas l'ordinateur** : un tap au MILIEU d'une sélection
  la **rétrécissait en silence** au lieu d'ouvrir la saisie pour toute la
  sélection. Un seul énoncé, `agirSurLaCaseTapee`, sert maintenant le doigt et
  le clavier : dans la plage → on agit ; hors de la plage → on étend ; pas de
  plage → la fiche du jour.
- **Deux points 6 manquaient.** Le bouton « + » d'un bien faisait
  `etat.sel = null` à la main, laissant la barre d'actions **affichée** avec
  tous ses boutons inertes. Et à l'inverse, le vidage ajouté dans
  `enregistrerPopup` était **inconditionnel** : le tiroir n'a pas de voile, la
  grille reste vivante à côté, donc une sélection prise pendant que le tiroir
  est ouvert **disparaissait** sous un toast « Enregistré » qui n'avait écrit
  que la nuit du tiroir. Le vidage exige désormais deux choses : que la popup
  vienne **de** la sélection, et que la plage écrite soit **encore** la sienne.

### Ce que la review a trouvé dans le banc lui-même

Le banc rendait des verts qui ne prouvaient rien, et c'est le plus instructif :

- son double d'`api` n'avait **pas** `api.calendar.load` : `charger()` levait à
  **chaque** écriture, donc la relecture d'après écriture, `construireEtats`,
  `renderTout()` et la garde de course du jeton **n'étaient jamais exercés** —
  et les assertions du point 6 étaient lues pendant que la page affichait son
  erreur de chargement, incapables de distinguer « vidé par `viderSelection` »
  de « vidé parce que la relecture est morte » ;
- il **jetait les en-têtes** du `fetch` : supprimer `enteteCompte()` laissait
  les 18 tests verts — et un compte délégué aurait écrit ses prix sur le
  **mauvais compte** ;
- son `peutEcrire` était **aveugle à son argument** : une faute de frappe sur
  le domaine passait au vert. Il enregistre maintenant les domaines demandés,
  et les tests affirment qu'il n'y en a qu'un, `reservations`. C'est d'autant
  plus nécessaire que ce lot a retiré l'assertion textuelle de
  `lecture-seule.test.js` au motif que « la garde est prouvée par le geste » :
  le geste prouvait qu'**un** booléen garde, pas **lequel**.
- ⚠ `window.__journal` existait pour attraper ce que jsdom avale, et
  **aucun test ne l'affirmait vide**. Il l'est maintenant.

### ⚠ ET LA CONTRE-ÉPREUVE CALENDAIRE MANQUAIT

Les 18 tests de la première version **pourrissaient avec le calendrier** :
mesuré à l'horloge décalée, **6 rouges le 31 de chaque mois et 2 le 1er**. Deux
causes, toutes deux invisibles à la lecture : les fixtures du téléphone
indexaient une liste **positionnelle** de jours à venir dans le mois rendu
(`futures[4]` n'existe pas le 28), et les moitiés « jour passé » demandaient le
mois **courant**, dont la liste de jours passés est **vide** le 1er.

Ancrage : un mois **entièrement à venir** (ou entièrement passé) et des dates
**calculées** (`jourDuMois(MOIS_A_VENIR, 5)`), avec une fenêtre de 3 mois pour
que le mois affiché tienne dans `etat.joursISO`. Éprouvé sur **42 dates, de
J+0 à J+500 : zéro rouge.**

C'est la règle du dépôt, et je ne l'avais pas appliquée : *dates relatives si
le test lit l'horloge, dates figées s'il injecte le temps* — et **ancrer le
test dans sa fenêtre est le premier recours, documenter un rouge calendaire le
dernier.**

## Reste du lot (étapes 2-4)

Volet Prix (pilote, fenêtre, radar, grille 5 niveaux + fixée, ✎ dans la
grille, orphelines), détail d'une nuit ; volets Événements et Bilan ; volet
Marché 4 onglets ; redirections YieldFlow + retrait du menu, test
d'inventaire §12 vert.
