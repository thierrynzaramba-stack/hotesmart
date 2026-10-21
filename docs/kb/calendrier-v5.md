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

## Reste du lot (étapes 2-4)

Volet Prix (pilote, fenêtre, radar, grille 5 niveaux + fixée, ✎ dans la
grille, orphelines), détail d'une nuit ; volets Événements et Bilan ; volet
Marché 4 onglets ; redirections YieldFlow + retrait du menu, test
d'inventaire §12 vert.
