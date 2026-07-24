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
