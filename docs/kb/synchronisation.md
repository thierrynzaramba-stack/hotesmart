# KB — Synchronisation (réservations, calendrier, prix)

<!-- SOURCES (mapping inverse). ⚠️ DOC en tête de ces fichiers pointe ici. Modif = MÊME COMMIT. -->
> Sources : `api/channel-webhook.js` (résas temps réel + dispo), `lib/cron-channel-feed.js`
> (filet de secours */5), `lib/channel-availability.js` (poussée dispo anti-doublon),
> `lib/channel-fullsync.js` + `lib/cron-channel-sync.js` (full sync ARI 500 j),
> `api/calendar.js` (édition prix/min stay + push), `lib/channel-pricing.js` (tarif par occupation),
> `api/channel-events.js` (import initial à l'activation), `api/channel-rateplan.js` (réglages par canal)
>
> Mots-clés routage chat : synchronisation, synchro, double réservation, calendrier, prix, tarif,
> min stay, séjour minimum, fermé, dates bloquées, pas à jour, disponibilités.

Ne jamais citer la marque interne de connexion OTA.

## 1. Principe : tout est synchronisé en continu
Une fois les annonces connectées, HôteSmart **synchronise en continu** — dans les deux sens —
**réservations, calendriers, disponibilités, prix, séjour minimum** entre HôteSmart et les
plateformes (Airbnb, Booking). L'hôte **gère tout depuis un seul endroit**, sans se reconnecter à
chaque extranet.

## 2. Anti-double-réservation
Une réservation sur un canal **bloque les mêmes dates sur l'autre canal**, et réciproquement.
- **Comment** : à chaque réservation/annulation, HôteSmart met à jour la disponibilité des dates
  concernées et la propage aux autres plateformes connectées.
- **Délai** : **quasi immédiat** (notification temps réel des plateformes). En cas de notification
  manquée, un **filet de secours repasse automatiquement toutes les ~5 minutes** — donc au pire
  quelques minutes, pas instantané à 100 %.
- Honnêteté : le risque de double réservation existe théoriquement uniquement sur ce **très court
  délai** ; en pratique le blocage est quasi instantané.

## 3. Prix, calendrier & séjour minimum
- **Hôte connecté en direct** : il modifie **prix, disponibilités et séjour minimum** dans **le
  calendrier HôteSmart** (`/biens/:id/calendrier`, version mobile `/m/calendrier`) ; HôteSmart
  **pousse** ces changements vers les plateformes.
- **Hôte équipé Beds24** : le calendrier HôteSmart **affiche** ses réservations, mais les
  **prix et séjours minimum se gèrent dans Beds24** — une modification faite dans le calendrier
  HôteSmart est **enregistrée localement et N'EST PAS envoyée** aux plateformes (message explicite
  à la sauvegarde). Voir §5.
- **Réglages par canal possibles** : depuis **Mes biens → Connexions**, on peut appliquer un
  **coefficient de prix** et un **séjour minimum différents par plateforme** (ex. Booking +18 %,
  séjour min 3 nuits sur Booking et 2 sur Airbnb).
- **Tarification par nombre de voyageurs** : le prix peut varier selon le nombre d'occupants
  (prix de base pour X voyageurs inclus + supplément par personne au-delà).
- **Délai de propagation** vers les plateformes : de quelques secondes à quelques minutes après
  l'enregistrement (traitement asynchrone). ⚠️ À VÉRIFIER : ordre de grandeur exact à confirmer.
- **Une date sans prix est FERMÉE sur les plateformes** (comportement du 8 septembre 2026).
  Si une date n'a ni prix saisi ni prix de base, HôteSmart la pousse **fermée à la vente**
  (`stop_sell`) plutôt que de la laisser partir sans tarif.

  **Pourquoi** : mesuré sur le staging Channex — omettre le prix ne ferme rien, la date reste
  vendable **au prix par défaut du plan tarifaire**, un prix que l'hôte n'a jamais choisi pour
  cette date. Un `rate` à 0 n'est pas appliqué non plus. La seule façon de ne pas vendre une
  date sans prix est de la fermer.

  **Ce n'est PAS une fermeture de l'hôte.** Rien n'est écrit dans sa mémoire d'intention : dès
  qu'il saisit un prix, la date **rouvre d'elle-même** à la poussée suivante, sans qu'il ait
  rien à défaire. Voir `docs/kb/problemes.md`.

  **Réponse type support** : « Cette date part fermée parce qu'elle n'a pas de prix. Saisissez
  un prix pour cette date (ou un prix de base pour le logement) et elle rouvrira toute seule à
  la prochaine synchronisation — vous n'avez rien à rouvrir manuellement. »

## 4. Réponses type support
- « Mes prix ne sont pas à jour sur Booking » → **délai de propagation** normal (quelques minutes) ;
  vérifier qu'on a bien **enregistré/publié** le changement dans le calendrier ; si un **coefficient
  par canal** est réglé (Connexions), le prix Booking = prix de base × coefficient.
- « Des dates apparaissent fermées » → soit une **réservation sur l'autre canal** a bloqué ces dates
  (normal, anti-doublon), soit une **fermeture manuelle** dans le calendrier. Vérifier les deux.
- « Une double réservation est-elle possible ? » → le blocage est **quasi immédiat** ; il ne reste
  qu'une fenêtre de quelques minutes au pire (filet de secours */5). En pratique, non.

## 5. Portée selon le type de compte
- **Hôte connecté en direct (Airbnb + Booking)** : la synchro décrite ici est assurée par HôteSmart.
  Les **prix se gèrent dans HôteSmart** et sont **poussés aux plateformes**.
- **Hôte équipé Beds24** : la synchronisation est **gérée par Beds24**, pas par le full sync
  HôteSmart. Les **prix et séjours minimum se gèrent dans Beds24** ; HôteSmart **affiche** le
  calendrier mais **ne pousse rien vers Beds24 ni les plateformes**. **Ne pas promettre** le
  mécanisme HôteSmart ci-dessus à un hôte Beds24. Voir `connexion.md`.

## 6. Réponse type — hôte Beds24 qui édite ses prix dans HôteSmart
« J'ai changé mon prix dans le calendrier HôteSmart mais rien ne bouge sur Airbnb/Booking. »
→ Normal pour un bien **Beds24** : HôteSmart affiche le calendrier mais **ne pousse pas** vers
Beds24. **Modifiez le prix / séjour minimum directement dans Beds24** — c'est lui qui synchronise
vers les plateformes. (Un message le rappelle à la sauvegarde.)

## 7. « Des identifiants de canal ne disent pas où vit le bien »

**Régression du 9 septembre 2026, trouvée en review, déjà active en production.**

Le provisionnement de la migration (phase 0) pose sur un bien **Beds24** les
identifiants de la propriété **Channex** qui l'accueillera : `provider_room_type_id`
et `provider_rate_plan_id` pointent la cible, pendant que `provider_property_id`
reste la clé Beds24 — seul le re-keying les bascule ensemble.

Or les chemins de poussée ARI ne jugeaient que sur la **présence** des identifiants
(`if (propId && ratePlanId)`). Les deux biens de Bagnères passaient donc le
contrôle : une simple édition de prix partait en `POST /availability` +
`/restrictions` vers Channex avec `property_id: "209413"`, la clé du provider
*source*. Effet visible pour l'hôte : le message « ce bien est géré par Beds24 »
disparaissait, remplacé par des `HTTP 4xx`.

**Règle** : sur tout chemin qui écrit chez un provider, **le provider se teste
avant les identifiants**. `estRelieAuCanal(bien)` — `lib/rate-sync.js`, à côté de
`canPushRates` — est le point unique : deux questions différentes du même chemin
(« l'hôte veut-il pousser ses prix ? » et « ce bien est-il seulement chez ce
provider ? »), gardées au même endroit. Elle est appliquée aux trois portes :
l'édition du calendrier, la mise en file du full sync, et le worker cron qui
exécute réellement la poussée — ce dernier la **relit à l'exécution**, il ne
suppose pas que l'appelant a gardé.

**Ce qu'on en retient au-delà du cas** : une donnée présente ne prouve pas le
contexte dans lequel elle a été posée. Pendant une migration, un même bien porte
des identifiants de deux mondes ; toute garde qui déduit l'appartenance de la
présence se trompe pendant toute la durée du chantier.

## 8. Le stock est CALCULÉ, il n'est pas lu

**Défaut trouvé le 9 septembre 2026, en préparant la migration — il valait aussi
pour la production.**

`lib/channel-fullsync.js` poussait `availability = 1` dès qu'une ligne
`calendar_inventory` existait avec `avail` à `NULL`. Or `avail` vaut `NULL` sur
tout bien amorcé : **11 nuits déjà vendues** sur les deux biens de Bagnères
repartaient donc annoncées disponibles à chaque poussée. Et chez Channex, qui
décrémente pourtant son stock à la confirmation
(`allow_availability_autoupdate_on_confirmation`), la poussée **écrasait sa
décrémentation** : le canal se serait retrouvé à revendre une nuit occupée.

**Règle** (`docs/specs/spec-audit-stop-sell.md`) : `avail` est un **stock**,
calculé au moment de pousser — jamais une source. `stop_sell` reste l'intention
de l'hôte, et n'est pas touché par ce calcul.

```
availability = min( ce que la mémoire annonce , inventory_units − nuits vendues )
```

**Le calcul plafonne, il n'ouvre rien** — c'est ce qui le rend sûr à poser sur un
writer déjà en production :

| cas | avant | après |
|---|---|---|
| ligne `avail = NULL`, nuit vendue | 1 ⚠ | **0** |
| ligne `avail = NULL`, nuit libre | 1 | 1 |
| ligne `avail = 0` (l'hôte a fermé) | 0 | 0 |
| aucune ligne | 0 | 0 |
| 3 unités, 1 vendue | 1 | **2** |

La nuit du **départ** se revend : un séjour 12 → 15 occupe le 12, le 13 et le 14
(`lib/nuits-occupees.js`). Le nombre de nuits fermées pour cause de vente est dit
dans les `warnings` et le journal — un chiffre inattendu doit se voir.

La ligne « 3 unités, 1 vendue » mérite d'être lue pour ce qu'elle est : sur un
bien **multi-unités**, le calcul annonce le stock réel là où l'ancienne règle
annonçait 1. C'est le but, mais ce n'est plus « il ne peut que fermer ». Sur un
bien mono-unité — `inventory_type: 'whole'`, le seul codé, et le cas des quatre
biens actuels — il ne peut effectivement que fermer.

**Ce qui occupe une nuit** : `confirmed` **et** `blocked`. Un blocage
propriétaire (Beds24 `black`) ne génère pas de ménage mais retient la nuit : la
revendre serait une surréservation. Une demande (`request`) ne retient rien. Le
statut se lit par `readStatus` (`lib/bookings-snapshot-status.js`), **jamais en
comparant à la chaîne `'confirmed'`** — un snapshot Beds24 `new` est une
réservation confirmée, et serait passé pour libre.

**La même règle vaut à l'édition du calendrier** (`api/calendar.js`), pas
seulement au full sync : un hôte qui rouvre une nuit déjà vendue voit son stock
plafonné, avec un avertissement nommant la date. Et si les séjours ne sont pas
lisibles, la disponibilité **n'est pas poussée du tout** — ne pas savoir ce qui
est vendu n'autorise pas à ouvrir.

**Un seul writer de `avail`, et c'est l'hôte.** La colonne porte son intention
(le calendrier l'expose « Ouvert / Fermé »). `scripts/reconcilier-stop-sell.js` y
écrivait un stock calculé : la nuit vendue serait passée à 0, puis, l'annulation
venue, le stock serait remonté sans que `avail` ne bouge — et le plafond l'aurait
gardée fermée **pour toujours**, le canal ne la rouvrant pas non plus
(`allow_availability_autoupdate_on_cancellation: false`). Le script ne touche
plus `avail` : le stock n'a pas besoin d'être mémorisé, il est calculé à chaque
poussée.

**Conséquence de discipline** : tout appelant de `runFullSync` doit sélectionner
`inventory_units` **et** `provider_property_id`. Le writer **refuse** de tourner
sans, plutôt que de deviner un stock ou d'interroger `property_id = 'undefined'`
— ce qui rendrait « zéro nuit vendue » sans la moindre erreur.

**Dette connue** : la disponibilité OTA dépend maintenant de la fraîcheur de
`bookings_snapshot`, et rien ne purge les snapshots disparus des fetchs Beds24
(« fantômes actifs »). Un fantôme `confirmed` ferme une nuit réellement libre,
indéfiniment, avec pour seule trace un avertissement « stock réduit car vendue ».
À traiter avec la purge des snapshots.
