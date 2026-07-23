# KB — App ménage prestataire

<!-- SOURCES (mapping inverse). ⚠️ DOC en tête de ces fichiers pointe ici. Modif = MÊME COMMIT. -->
> Sources : `apps/menages/prestataires.html` (création prestataire + lien, côté hôte),
> `apps/menages/public.html` (app prestataire + PWA), `api/menages-public.js` (endpoint public :
> tâches, markDone, markUndone), `lib/cron-arrival-code.js` (conditionnement ménage → code)

## Où viennent les données (limite réelle à connaître)
L'app ménage lit les réservations depuis **Beds24**. L'endpoint exige une **clé Beds24** :
sans clé, il répond **« Beds24 non configuré »**. → Aujourd'hui, un hôte **connecté en direct
(Airbnb/Booking) sans Beds24 ne peut pas utiliser la liste de ménages** de l'app. (Comportement
actuel du code, pas une intention.)

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
  est-elle remontée de Beds24**. Et rappel : **sans Beds24, l'app ménage n'a pas de tâches**
  (« Beds24 non configuré »).

## Lien avec les codes d'accès
La validation du ménage est la **condition d'envoi du code** voyageur (sauf 1er voyageur). Détail
dans `codes-acces.md`.
