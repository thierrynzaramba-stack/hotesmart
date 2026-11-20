# Supplément par voyageur : le retirer d'un logement vendu « par personne »

Lot confié par le chef de file le 20 novembre 2026, sur décision de Thierry
confirmée dans la fenêtre du fil Calendrier le même jour : **le 23 se vend
85 € pour tous, de 1 à 6 voyageurs, sur Airbnb et sur Booking.** Le
supplément HôteSmart de 2 € par voyageur au-delà de 4 sort du prix poussé.

## 1. Constat (production, 20/11, lecture seule)

- `properties` du 23 (`efe1daf1…`) : `capacity 6`, `included_guests 4`,
  `extra_guest_fee 2`, `base_price` **vide**, `rate_sync_mode managed`,
  `pilote_tarifaire yieldflow`.
- Channex : plan de base `ad0a594e` « Tarif Standard », `per_person`, options
  par défaut 90/90/90/90/92/94 € ; dérivés Airbnb et Booking `per_person` ;
  petits-enfants Airbnb `b56feb44` et Booking `9d739f60` mappés à la seule
  occupation 6.
- Les deux poussées (`lib/channel-fullsync.js`, `lib/calendrier-writer.js`)
  envoient `rates[]` par `buildOccupancyRates` : 85 € jusqu'à 4, 87 € à 5,
  **89 € à 6**. Les canaux ne lisent que l'occupation 6 : **tout voyageur paie
  89 €**, même seul. C'est le 89 € vu au calendrier Airbnb le 19/11.
- La fiche refuse de changer le supplément ou les voyageurs inclus :
  `api/channel-property.js` rend **409 `grille_non_reconstructible`**. Motif
  écrit dans le code : sans prix de base, la grille du plan tarifaire n'a aucun
  montant à porter, et une écriture en base seule ferait diverger HôteSmart et
  Channex.

## 2. Ce que Channex fait réellement (mesuré sur staging, 20/11)

Propriété `test 2`, plan de base `per_person` 6 options + dérivé `per_person`
cloné comme `lib/rate-plans-derives.js` le crée.

| geste | résultat |
|---|---|
| `rates[]` 85/85/85/85/87/89 | base : 85…89 par occupation ; **dérivé : 89 partout** (il prend l'occupation PRINCIPALE du parent pour toutes les siennes) |
| `rate` seul (85) sur un plan `per_person` | **seule l'occupation principale passe à 85** ; 1 à 5 gardent la valeur d'avant |
| `rates[]` plats (85 ×6) | tout à 85, base et dérivé |
| `PUT rate_plan` `per_person` → `per_room` | **422 `sell_mode: can't be changed`** |
| `POST /restrictions` avec `rates` seuls sur des dates `stop_sell` | **`stop_sell` reste vrai** : poser un prix ne rouvre rien |
| `PUT rate_plan` grille plate en restant `per_person` | 200, dérivé intact |

## 3. Ce que ça change

- **Le mode de vente d'un plan est figé à sa création.** La fiche le recalcule
  à chaque enregistrement (`buildRatePlanOptions` : supplément > 0 →
  `per_person`, sinon `per_room`). Passer le supplément de 2 à 0 sur un plan
  `per_person` part donc en 422 chez Channex, et la fiche rend 502 « Mise à jour
  du tarif échouée » — **même avec un prix de base**. Défaut latent, fermé par
  ce lot.
- Les poussées supposent le même invariant : supplément > 0 ⇔ `rates[]`. Un
  supplément à 0 sur un plan `per_person` partirait en `rate` seul, et
  laisserait les occupations 1 à 5 du plan de base à leur ancienne valeur.
- **« Pas de supplément » sur un logement vendu par personne, c'est « tous les
  voyageurs inclus »** : `included_guests = capacité`. `buildOccupancyRates`
  rend alors des `rates[]` plats — le format accepté, sans toucher au mode de
  vente ni à la chaîne des dérivés.

## 4. Le correctif

Module neuf `lib/tarifs-occupation.js`, branché dans le `PUT` de
`api/channel-property.js` :

1. **Lire le plan** chez Channex avant toute écriture (`GET /rate_plans/:id`).
   Échec de lecture : 502, rien n'est écrit.
2. **Refuser un changement de mode de vente** : 409
   `mode_de_vente_immuable`, avec la phrase qui dit quoi faire (sur un plan
   par personne : inclure tous les voyageurs). Plus de 502 opaque.
3. **Sans prix de base, reconstruire la grille depuis Channex** : le montant
   de base est lu sur l'option du plan à l'occupation des voyageurs inclus
   d'avant (la partie sans supplément). Sur un plan par personne, l'option
   EXACTE ou rien : l'option principale inclut déjà les suppléments. Aucun
   montant inventé, aucune divergence. La capacité, elle, reste refusée sans
   prix de base (409 inchangé) : elle touche le type de chambre, hors de ce lot.
4. **Renvoyer les prix par date** quand la FORME des prix par occupation change
   (le 23 : 85/87/89 → 85 partout ; sur un plan par logement, changer les
   voyageurs inclus ne change aucun prix et ne renvoie rien), et seulement si
   HôteSmart pousse les tarifs (`canPushRates`) : un seul `POST /restrictions`,
   **prix seuls** (ni `stop_sell`, ni disponibilité), regroupés en plages comme
   `runFullSync`, sur sa fenêtre (500 jours) et avec sa règle de prix (le tarif
   du jour, sinon le prix de base, sinon rien ; un tarif sous le plancher n'est
   pas renvoyé). Le prix de base et le plancher sont ceux de la requête, pas
   ceux d'avant. Sans ce renvoi, chaque nuit garderait ses 89 € jusqu'à ce que
   son prix change — `docs/CALENDRIER_TECH.md` le notait comme manque.
5. **Le calendrier est lu AVANT la première écriture** : une lecture ratée rend
   502 et rien n'a bougé.
6. **Échec d'une écriture chez le canal** : ce qui a déjà été écrit est remis —
   type de chambre et grille, dans l'ordre qui garde les options sous la
   capacité —, 502, et **rien n'est écrit en base**. Le message ne dit « rien
   n'a été changé » que si toutes les remises ont réussi.
7. Le `SELECT` du bien ajoute `rate_sync_mode` et `inventory_units` (une garde
   qui juge sur une colonne non sélectionnée est une garde ouverte).
8. **Le journal des prix affichés** (`price_display_log`) est alimenté après un
   renvoi réussi, sur les nuits affichées (une ligne en mémoire, ni fermée, ni à
   stock nul) et non vendues, au compte de la garde. En général le prix de base
   d'une nuit ne change pas, et `enregistrerPrixPousses` n'écrit rien ; il écrit
   quand une date servie par le prix de base change de montant. Le recensement
   de `tests/price-log.test.js` inscrit ce chemin comme tarifaire.

**Limites connues, notées et non corrigées** (constats mineurs de la review) :

- **Course avec une poussée en cours** : un `runFullSync` ou le pilote qui a lu
  le bien AVANT l'enregistrement et poste APRÈS le renvoi repousse l'ancienne
  répartition sur les dates qu'il touche. Fenêtre de quelques secondes ; le
  prochain prix poussé sur ces dates la corrige.
- **Échec de l'écriture en base après un renvoi réussi** : le canal porte la
  nouvelle occupation, la base l'ancienne, l'hôte voit une erreur 500. Il
  ré-enregistre : le renvoi repart et la base suit. Mettre le bien dans la file
  des synchronisations complètes réglerait les deux cas, mais une
  synchronisation complète pousse aussi les fermetures — hors de la portée de
  ce lot tant que le lot fermetures n'est pas fait.
- **Deux copies de la règle de prix** (`runFullSync` et `valeursTarifs`) : pas
  de test de parité. Elles diffèrent déjà, à dessein, sur le journal (dette 27 :
  `runFullSync` journalise des dates sans ligne).

**Domaine.** Ce lot POUSSE des prix au canal, depuis l'endpoint de la fiche.
Il ne touche ni `lib/channels/`, ni `lib/calendrier-writer.js`, ni le cron,
ni `lib/channel-pricing.js`. Il passe seul, sans autre lot de cœur et sync en
parallèle.

## 5. Recette (production, Thierry présent, après le merge)

1. Thierry met « Voyageurs inclus » à **6** sur la fiche du 23.
2. Channex : le prix à l'occupation 6 du plan de base, du petit-enfant Airbnb
   et du petit-enfant Booking vaut le prix du calendrier HôteSmart sur les nuits
   ouvertes (85 € sur les nuits de semaine creuses).
3. Airbnb : le calendrier affiche 85 € ; côté voyageur, même total à 2 et à
   6 voyageurs (hors taxe de séjour). Booking : le prix relu dans l'extranet.
4. Aucune nuit fermée rouverte : même contrôle que
   `docs/specs/spec-yf-promotions-duree.md` §2 ter (base contre petit-enfant,
   469 jours).

## 6. Case performance

Le lot ne touche aucun écran : la fiche affiche déjà le message du serveur.
Points 1 à 8 : **sans objet**, sauf le coût du geste lui-même, rare et à la
main. Tout enregistrement de la fiche qui touche un prix ou l'occupation coûte
désormais une lecture du plan chez Channex (avant : aucune). Quand la forme des
prix change, s'y ajoutent une lecture de `calendar_inventory` (500 lignes au
plus, sous la borne de 1000), une écriture de grille, un `POST /restrictions`
et l'écriture du journal.
