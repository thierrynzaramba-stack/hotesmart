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

## Reste du lot (étapes 2-4)

Volet Prix (pilote, fenêtre, radar, grille 5 niveaux + fixée, ✎ dans la
grille, orphelines), détail d'une nuit ; volets Événements et Bilan ; volet
Marché 4 onglets ; redirections YieldFlow + retrait du menu, test
d'inventaire §12 vert.
