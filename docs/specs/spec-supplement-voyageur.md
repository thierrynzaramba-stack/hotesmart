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
   d'avant (la partie sans supplément). Aucun montant inventé, aucune
   divergence. La capacité, elle, reste refusée sans prix de base (409
   inchangé) : elle touche le type de chambre, hors de ce lot.
4. **Renvoyer les prix par date** quand les voyageurs inclus ou le supplément
   changent, et seulement en `managed` : un seul `POST /restrictions`, **prix
   seuls** (ni `stop_sell`, ni disponibilité), sur la fenêtre de
   `runFullSync` (500 jours), avec sa règle de prix (le tarif du jour, sinon le
   prix de base, sinon rien ; un tarif sous le plancher n'est pas renvoyé).
   Sans ce renvoi, chaque nuit garderait ses 89 € jusqu'à ce que son prix
   change — `docs/CALENDRIER_TECH.md` le notait comme manque.
5. **Échec du renvoi** : la grille est remise à l'identique, 502, et **rien
   n'est écrit en base**. Ni demi-état, ni base qui dirait 6 pendant que les
   canaux vendent à 89 €.
6. Le `SELECT` du bien ajoute `rate_sync_mode` (une garde qui juge sur une
   colonne non sélectionnée est une garde ouverte).

Le journal des prix affichés (`price_display_log`) ne bouge pas : il porte le
prix de base de la nuit, qui ne change pas.

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
main : un enregistrement de la fiche qui change l'occupation coûte une lecture
Channex, une lecture de `calendar_inventory` (500 lignes au plus, sous la
borne de 1000), une écriture de grille et un `POST /restrictions`.
