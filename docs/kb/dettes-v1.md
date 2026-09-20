# KB — Dettes datées avant la clôture de la V1

<!-- REGISTRE. Une dette se COMPTE et se DATE : on écrit ce qui manque, ce que
     ça coûte si on l'oublie, et le moment où elle doit être soldée. Une dette
     soldée se barre avec la date, elle ne s'efface pas. Créé le 21 septembre
     2026 (programme de nuit, point 5). -->

| # | Dette | Coût si oubliée | Échéance |
|---|---|---|---|
| 1 | **25 tests rouges à dates figées** (8 `booking-changes`, 3 `avis-endpoint`, 10 `messages-classify`, 4 `menages-public-filtre-presta`). Règle : dates relatives si le test lit l'horloge, dates figées s'il injecte `maintenant`. CLAUDE.md « DETTE DATÉE » porte le compte. | Le 26e rouge se noie dans « les 25 habituels ». C'est déjà arrivé une fois (lecture tronquée à 1000 lignes). | **Session dédiée avant la clôture V1 YieldFlow.** Pas à la volée dans un lot. |
| 2 | **Migration `2026-09-20-pilote-fenetre.sql` appliquée sur staging seulement.** La prod ne connaît ni `pilote_fenetre_type` ni `pilote_fenetre_valeur`. | Le 4.6.3 (moteur d'ouverture) lit la fenêtre : en prod il tomberait sur `undefined` et n'ouvrirait rien, sans erreur. | **En prod AVANT le merge du 4.6.3.** À rappeler dans sa checklist. |
| 3 | **Migration `2026-09-21-fermetures.sql`** : staging pour la recette du 4.6.2, prod avant son merge. | `api/calendar.js` GET rend `fermetures: {}` en journalisant « illisibles » ; `fermer` répond 400 ; `joursExclus` **lève** → les écrans yield qui l'appellent échouent. | **Staging avant la recette ; prod avant le merge du 4.6.2.** |
| 4 | **Motif « en attente d'ouverture ».** Le radar et `prix.html` disent déjà « pas encore ouverte · s'ouvrira le … » (4.6.0). Le moteur de suggestion, lui, ne connaît pas encore la fenêtre : une nuit au-delà reçoit un motif générique. | L'hôte lit « non calculable » là où la vraie réponse est « pas encore ouverte, ouverture le … ». | **4.6.3**, quand le moteur d'ouverture consommera la fenêtre. |
| 5 | **`active_at` jamais remis à `null`** au retrait d'un bien : la quantité facturée ne décroît pas. | Un hôte qui retire un bien continue d'être compté pour lui. | Avant la fin de la beta (wiring Stripe). |
| 6 | **Purge du bien de test « colomier »** (jamais provisionné) : la suppression est bloquée par la cascade FK des tables enfant TEXT. | Un bien fantôme dans les listes de prod, un ménage ou un avis qui s'y rattache par erreur. | Chantier « identité du bien vs clé provider ». |
| 7 | **Vacances scolaires : la table s'arrête au 3 juillet 2027.** `lib/yield/vacances.js` vérifie la couverture et le DIT (jamais « hors vacances » par défaut). | À partir de l'été 2027, la référence yield tombe en « non calculable : zone non couverte » pour toutes les périodes de vacances. | **Importer 2027-2028 avant mars 2027** (publication ministérielle). |
| 8 | **`apps/menages/garde.html` : la bande de mois affiche encore les jours en redondance** sous chaque mois. Le correctif (jours seulement sous le mois, `renderMonthBand` en `<table class="month-band">` avec `<colgroup>` dans la table) n'est fait que dans `pages/biens-calendrier.html`, branche `ui-calendrier-jours`, en attente de verdict visuel. | Deux calendriers qui se veulent « même langage visuel » divergent. | Après le verdict sur `ui-calendrier-jours` : reporter la même bande, un seul commit. |
| 9 | **`apps/menages/public.html` : la case du calendrier ouvre la PREMIÈRE offre du jour** quand deux ménages sont libres le même jour (`cleOffre(libres[0])`). La liste, elle, distingue chaque offre par sa clé (bien, réservation) depuis 65a0ec4. | Une prestataire qui clique la case pour prendre le second ménage ouvre le premier. | Lot 3.4 (écran planning de garde), quand la case saura porter plusieurs offres. |
| 10 | **Le calendrier mobile ignore les fermetures** (4.6.2) : « Disponibilité → Fermé » écrit `avail = 0` + `stop_sell = true` sans objet. Sur un bien piloté, cette nuit est « fermée calculée » aux yeux du moteur. | Le 4.6.3 pourrait considérer rouvrable une nuit que l'hôte a fermée depuis son téléphone. Le canal, lui, ne rouvre jamais une nuit déjà fermée — filet tenu jusqu'à ce que le 4.6.3 tranche. | Refonte mobile (garde-fou produit : avant d'annoncer la messagerie). |
| 11 | **La raison d'une fermeture est demandée par `window.prompt`** (biens-calendrier). | Aucun coût fonctionnel ; l'écran est moins soigné que le reste. | Si la recette du 4.6.2 le demande : formulaire en ligne. |
| 12 | **`fermer` avec refus du writer** : l'objet est retiré, mais ce chemin n'a pas de test — aucun refus du writer n'est déclenchable sans tarif, et `fermer` n'en porte pas. | Faible : le seul refus possible est un échec d'écriture, déjà rendu en 4xx/5xx. | Quand le writer aura un refus sans tarif à tester. |

## Règle du registre

Une dette se **note** au moment où on décide de ne pas la solder, pas au moment
où on s'en souvient. Elle porte une **échéance liée à un lot** (« avant le
4.6.3 ») plutôt qu'une date : c'est la checklist de ce lot qui la rappellera.
