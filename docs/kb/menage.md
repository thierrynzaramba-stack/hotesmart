# KB — App ménage prestataire

<!-- SOURCES (mapping inverse). ⚠️ DOC en tête de ces fichiers pointe ici. Modif = MÊME COMMIT. -->
> Sources : `apps/menages/index.html` (planning côté hôte), `api/menages.js` (endpoint hôte :
> biens + réservations), `apps/menages/prestataires.html` (création prestataire + lien, côté hôte),
> `apps/menages/public.html` (app prestataire + PWA), `api/menages-public.js` (endpoint public :
> tâches, markDone, markUndone), `lib/cron-arrival-code.js` (conditionnement ménage → code),
> `lib/cleaning/sync-menages.js` (notifications prestataire, cf. `booking-changes.md`)

## Où viennent les données
L'app ménage lit les biens dans la table **properties** et les réservations dans
**bookings_snapshot** (alimentés par la couche de synchronisation, tous providers). Elle
fonctionne donc pour **tous les hôtes** — équipés Beds24 **comme** connectés en direct
(Airbnb/Booking via le channel manager interne). Plus aucun appel Beds24 en direct, plus de
message « Beds24 non configuré ». Clé d'identification des biens = `provider_property_id`
(commune aux tokens, à `menage_done` et à `property_status`).

**Deux endpoints, une même source** :
- `api/menages.js` — planning **de l'hôte** (`/apps/menages`), session vérifiée serveur ;
- `api/menages-public.js` — planning **du prestataire**, accès par token.

Seuls les séjours au statut canonique `confirmed` donnent lieu à un ménage : une
annulation, un **blocage propriétaire** Beds24 (`black`) ou une **demande non
confirmée** (`request`) n'apparaissent pas au planning. Voir
`docs/kb/bookings-snapshot.md`.

⚠️ **Aucun appel provider dans ce domaine.** Ni `/api/beds24`, ni `lib/channels/`, ni
`shared/properties.js` (qui interroge Beds24) dans `apps/menages/*`,
`api/menages*.js` ou `lib/cleaning/*`. C'est le critère de clôture de
l'unification — un appel provider ici rendrait à nouveau les biens Channex
invisibles. Vérifiable par grep.

Un bien Beds24 tout juste ajouté n'apparaît qu'après son passage par le cron, qui le
matérialise dans `properties` (délai maximum 5 minutes).

**Chargement.** Les trois lectures d'initialisation (sidebar, planning, notes)
partent en parallèle ; la grille s'affiche dès que le planning est là, sans attendre
les notes, qui n'alimentent qu'un badge. En série, leurs latences s'additionnaient
avant le premier pixel.

`api/menages.js` logue une ligne de chrono par requête
(`[menages] auth=… properties=… snapshots=… mapping=… total=…`), pour identifier une
étape lente sans instrumenter à l'aveugle.

⚠️ **Reste à traiter, chantier séparé** : la barre latérale (`components/sidebar.js`,
`getApiStatus`) enchaîne `api_keys`, `properties` et `subscriptions` **en série**, et
la capture réseau montre des appels **dupliqués** à l'initialisation (`user` ×2,
`subscriptions` ×2, `onboarding_state` ×2 — ce dernier depuis `components/auth-guard.js`).
Ces requêtes concernent **toutes** les pages de l'app, pas seulement le planning :
à corriger avec leurs propres tests, pas en marge d'un chantier ménage.

**Le planning n'est jamais vide par accident.** Sur erreur de chargement (session
expirée, réseau, 500), les deux pages affichent un message explicite au lieu d'un
planning vide — celui-ci serait indiscernable de « aucune réservation », exactement
le symptôme que ce module vient de corriger pour les biens Channex.

La lecture est bornée et triée côté SQL (`snapshot->>departure`), et le front demande
une fenêtre de ±12 mois : sans cela, le cap de pagination PostgREST (1000 lignes par
défaut) tronquerait le planning dans un ordre non déterministe, et des ménages de la
semaine en cours pourraient disparaître sans aucune erreur. Le champ `tronque` de la
réponse signale le cas.

## 1. Parcours d'installation

### Côté hôte (créer un prestataire + son lien)
Dans **App ménage → Prestataires** (`/apps/menages/prestataires`) :
- Renseigner un **nom**, **cocher les biens** que ce prestataire verra, régler la **fenêtre de
  visibilité** (jours à venir, défaut 30).
- **Créer et générer le lien** → un **lien personnel** est généré :
  `…/apps/menages/public?token=<token>`. Bouton **📋 Copier**.
- **Éditer** un prestataire met à jour nom / biens / jours **sans changer le lien** (le token reste
  le même). Il n'y a **pas de bouton « régénérer le lien »** : pour obtenir un nouveau lien, il faut
  **supprimer puis recréer** le prestataire.
- **Supprimer** un prestataire → **le lien ne fonctionne plus**.

### Côté prestataire (ce qu'il voit)
En ouvrant le lien (**aucun compte à créer**), il arrive sur **« HôteSmart Clean »** :
- un **mini-calendrier** (jours avec ménage à faire / faits) et des **cartes de ménage par bien** ;
- il **coche « fait » en un clic** ; les ménages faits passent barrés/estompés ;
- certains ménages peuvent apparaître **grisés « obsolètes » (⏭)** (réservation modifiée/annulée) ;
- **fenêtre** affichée : **14 derniers jours** (pour rattraper un ménage en retard) + la visibilité
  future du token.
- Il **ne voit que les biens qui lui sont affectés**.
- **Nouveautés (🔔)** : réservations nouvelles/modifiées/annulées + notes de l'employeur.
  Le prestataire les **acquitte** en cliquant une notif ou via **« ✓ Tout marquer lu »**.
  L'acquittement est **persisté même hors-ligne** (miroir local + file de sync rejouée à la
  reconnexion) : une notif acquittée **ne réapparaît plus** au rechargement.

### Onglet « Avis » (ce que le prestataire voit de son propre travail)
Un second onglet apparaît à côté de « Planning » **quand l'hôte le permet**.

- **Qui le voit** : le droit `self_view_reviews` du profil (défaut **oui**). Coupé par l'hôte,
  l'onglet **n'apparaît pas du tout** — pas d'écran « accès refusé ».
- **En tête** : le nombre d'avis pris en compte, puis 👍 propreté saluée / 👎 remarques.
  Ces chiffres sortent de la **même fonction** que la page hôte `/avis` (`lib/stats-avis.js`) :
  deux compteurs calculés séparément finiraient par se contredire.
- **En dessous** : la liste des avis qui **parlent de propreté** (date, bien, extrait). Les avis
  qui n'évoquent pas le ménage ne sont pas listés — ils restent comptés dans le total.
- **Étiquette « retour privé »** : l'extrait vient d'un message que le voyageur **n'avait pas
  rendu public**. À ne pas citer ailleurs.
- **Jamais** : le nom du voyageur, le texte complet de l'avis, la note. Le serveur ne les envoie
  pas (`api/menages-public.js`, `action=avis`).
- **Quels avis** : ceux des ménages qui lui sont attribués — soit par `menage_events`, soit par
  une **période déclarée** (`prestataire_periodes`). Un avis non attribuable reste **non attribué**.
- **États distincts** : « chargement », « service indisponible, réessayez » (**panne** : 503 ou
  `ratio.erreur`), et « aucun avis pour l'instant » (**vrai** zéro). ⚠️ Une panne ne doit
  **jamais** s'afficher comme « 0 avis » : la prestataire en tirerait une conclusion fausse
  sur son travail.

### Installation PWA (facultative)
L'app est installable sur l'écran d'accueil :
- **Android (Chrome)** : menu ⋮ → **Installer l'application / Ajouter à l'écran d'accueil**.
- **iOS (Safari)** : **Partager** → **Sur l'écran d'accueil**.
L'icône « Clean » apparaît alors comme une app ; elle **fonctionne hors-ligne** et se synchronise au
retour du réseau.

## 2. Pas de prestataire / l'hôte fait le ménage lui-même
- **Le conditionnement ménage → code ne s'applique que si un suivi ménage existe** sur le bien.
  « Suivi existe » = **un prestataire est affecté au bien** OU **au moins un ménage déjà validé**.
  **Sans suivi ménage** (bien géré en direct, pas d'app ménage, aucun prestataire), le code d'accès
  **part normalement** — il n'est **jamais bloqué** en attente d'une validation impossible. Un
  prestataire **fraîchement affecté** (aucun ménage encore validé) **active** déjà le conditionnement.
- Quand un suivi existe : pour un **2ᵉ voyageur et suivants**, le code n'est envoyé qu'après
  **validation du ménage** du séjour précédent. Le **premier voyageur** est toujours exempté.
- **L'hôte peut être son propre prestataire** : il se crée un lien prestataire sur ses propres biens
  et valide lui-même les ménages (active alors le conditionnement).

## 3. Dévalidation d'un ménage
- Un ménage validé **peut être décoché** (`markUndone`) : la validation est supprimée et
  `last_menage_at` est **recalculé** sur les ménages restants (s'il n'en reste aucun, la valeur est
  **laissée telle quelle**, pas remise à zéro).
- **Effet sur le code voyageur** :
  - si le code était **déjà envoyé**, **dévalider ne l'annule pas** (le code reste valable) ;
  - si le code **n'était pas encore parti** (en attente du ménage), dévalider **re-bloque** l'envoi
    jusqu'à une nouvelle validation.

## 4. Réponses type support
- « J'ai perdu le lien » → l'hôte le retrouve et le **recopie** dans **App ménage → Prestataires**
  (bouton 📋). Le lien est **stable** ; pour en changer, **supprimer + recréer** le prestataire.
- « J'ai validé par erreur » → **décocher** le ménage. Si le code voyageur est **déjà parti**, il
  reste valable ; sinon l'envoi est re-bloqué jusqu'à re-validation.
- « Le prestataire ne voit pas un ménage » → vérifier : le **bien est-il coché** pour ce prestataire ;
  la **date tombe-t-elle dans la fenêtre** (14 j passés + visibilité future) ; la **réservation
  est-elle bien synchronisée** (présente dans le planning du bien) ; la réservation n'est-elle pas
  **annulée** (les annulations ne créent pas de ménage).

## Lien avec les codes d'accès
La validation du ménage est la **condition d'envoi du code** voyageur (sauf 1er voyageur). Détail
dans `codes-acces.md`.


## ⚠️ « Marquer fait » côté hôte ne vit que dans le navigateur

Trouvé au test humain de l'étape 5 : basculé sur un compte partagé avec
`menages: read`, le bouton « ✓ Marquer fait » restait actif.

**Diagnostic** : ni faille de périmètre, ni refus serveur — une troisième
possibilité. `markDone()` dans `apps/menages/index.html` n'écrit **rien en
base** : il ne touche que `localStorage['menages-done']`.

**Conséquences, indépendantes de la délégation :**

- Un ménage marqué fait par le prestataire dans sa PWA écrit `menage_done`
  (117 lignes en production via `api/menages-public`) — l'hôte **ne le voit
  pas**.
- L'hôte ne retrouve pas ses propres marquages sur un autre appareil.
- Rien n'est partagé dans l'équipe.

Le bouton est désormais retiré en lecture seule — il donnait l'illusion d'une
action partagée. Mais **le défaut de fond reste** : la page hôte doit être
branchée sur `menage_done`, comme la PWA l'est déjà. Chantier à part.

## Limite produit : les biens Beds24 ne se pilotent pas dans le calendrier

Les prix et disponibilités d'un bien Beds24 se modifient **dans Beds24**.
HôteSmart n'y pousse pas d'ARI — c'est assumé, pas un défaut.

Jusqu'ici la mention vivait dans le sélecteur multiple du calendrier : il fallait
l'**ouvrir** pour la voir. Un hôte 100 % Beds24 arrivait donc sur un calendrier
vide sans explication, et un membre dont le périmètre ne contient que du Beds24
encore plus — lui ne peut même pas changer de bien.

Rendu explicite :

- **Bureau** : bandeau permanent nommant les biens concernés, avec un message
  distinct quand **aucun** bien n'est pilotable.
- **Mobile** : la page les *proposait* dans son sélecteur, et l'hôte découvrait
  le refus seulement à l'enregistrement (`local_only`). Ils en sont désormais
  exclus, et leur absence est expliquée.
