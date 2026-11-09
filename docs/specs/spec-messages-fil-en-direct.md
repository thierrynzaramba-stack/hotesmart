# Spec — Messages : le fil se met à jour tout seul

Statut : **SPEC**. Le code attend le créneau du chef de file.
Fil : messagerie. Branche : `messages-fil-en-direct`, partie de main `88aebdc7`.
Demande de Thierry, 9 novembre 2026 : « quand je suis sur un fil de discussion,
j'aimerais que la discussion soit très régulièrement mise à jour sans que je
doive recharger la page, comme ça un échange est possible avec le voyageur en
direct ».

## 1. Le constat, mesuré

- **La page ne relit rien après son ouverture.** `pages/messages.html` charge
  tout une fois (`charger()`), puis plus aucun `setInterval`, aucune relecture au
  retour sur l'onglet (lu sur main `9385a9e1`). Un message du voyageur n'apparaît
  qu'après un rechargement, et le rechargement ramène à la liste.
- **La donnée, elle, est déjà là en quelques secondes.** Un message Airbnb ou
  Booking.com arrive par le webhook Channex (`api/channel-webhook.js`, événement
  `message`) et s'écrit tout de suite dans la table `messages` du cœur
  (`recordMessage`). Les quatre logements en service sont sur Channex.
- **Relire toute la page coûterait trop cher.** `/api/messages?limit=50` pèse
  31 094 octets, et lit côté serveur jusqu'à 2000 messages plus toutes les
  réservations du compte. Toutes les 10 secondes, ce serait 11 Mo par heure et
  par écran ouvert, pour presque toujours rien de neuf.

## 2. Ce que le lot fait

**Fil ouvert, onglet affiché : toutes les 10 secondes**, la page demande
seulement ce qui est arrivé dans CE fil depuis le dernier message connu. Un
nouveau message s'ajoute en bas, sans recharger la page.

**La liste des conversations : au plus une fois par minute**, et seulement si
quelque chose a changé. Chaque relecture du fil rend aussi l'heure du message
le plus récent du compte. Si elle a bougé, la première page de la liste se
relit (`/api/messages?limit=50`, l'appel d'aujourd'hui), au plus une fois par
minute. Sans fil ouvert (liste seule, au téléphone par exemple), la page pose
la même question toutes les 60 secondes.

**Les propositions de l'IA du fil arrivent aussi en direct**, avec leur délai
d'envoi. Si l'IA en mode Auto prépare une réponse pendant que l'hôte échange,
il la voit apparaître et peut l'annuler avant qu'elle parte.

**Onglet caché : la relecture s'arrête.** Elle reprend tout de suite au retour
sur l'onglet (`visibilitychange`), avec une relecture immédiate.

### Règles d'écran, toutes obligatoires

1. **Ce que l'hôte tape ne se perd jamais.** Ni la zone de saisie, ni une
   proposition en cours de modification ne sont redessinées. Si l'insertion
   d'un message ne peut pas se faire sans toucher à un éditeur ouvert, elle
   attend que l'éditeur se ferme, et une pastille « Nouveau message » le dit.
2. **Le défilement est respecté.** Si l'hôte est en bas du fil, le nouveau
   message défile en vue. S'il est remonté lire l'historique, rien ne bouge, et
   une pastille « Nouveau message ↓ » le ramène en bas.
3. **Aucun doublon.** Un message que l'hôte vient d'envoyer depuis la page est
   déjà affiché. Quand sa ligne revient du serveur, elle remplace la bulle
   locale au lieu de s'ajouter (même sens, même texte, envoyé à moins de deux
   minutes d'écart).
4. **Lu tant que c'est à l'écran.** Un message du voyageur qui arrive dans le
   fil ouvert, onglet affiché, est lu : la page le marque comme d'habitude
   (`POST /api/messages action=lu`, writer unique), une fois par arrivée et pas
   à chaque relecture.
5. **Une panne ne casse rien.** Une relecture ratée se retente plus tard (20 s,
   puis 40 s, jusqu'à 2 min), sans message d'erreur. Après trois échecs de
   suite, une mention discrète « Mise à jour interrompue · Réessayer » apparaît
   sous l'en-tête du fil. Session expirée (401) : la relecture s'arrête.
6. **Changer de fil remet le compteur à zéro.** Une réponse qui arrive pour
   l'ancien fil après qu'on en a ouvert un autre est jetée.

## 3. La lecture côté serveur

Une forme neuve du **même endpoint**, pas une fonction de plus (le projet
Vercel a un plafond de 100 fonctions) :

`GET /api/messages?fil=<bookId>&apres=<instant ISO>`, et sans `fil` pour la
liste seule.

Elle rend :
- `messages` : les messages du fil postérieurs à `apres`, triés du plus ancien
  au plus récent, mêmes champs que la collection (`sender`, `direction`,
  `body`, `sent_at`, `kind`, `origine`). Index `messages_booking_sent_idx`
  (`booking_id, sent_at`).
- `taches` : les propositions en attente du fil (`agent_tasks`,
  `pending_validation`, mêmes colonnes que la page lit aujourd'hui).
- `dernier` : l'instant du message le plus récent du compte. Index
  `messages_user_sent_idx` (`user_id, sent_at DESC`), `limit(1)`.

**Gardes, toutes celles de la collection** : compte cible et filtre de
périmètre (un membre limité au bien A n'apprend rien du bien B, pas même
l'existence d'un fil) ; règle d'archivage de la collection (`clesArchivees`) ;
`private, no-store` posé avant le premier refus. Bornes : `apres` invalide → 400 ;
`apres` plus vieux que 7 jours → ramené à 7 jours ; au plus 200 messages, et au-delà
`complet: false`, qui fait relire le fil entier par la page.

## 4. Décisions de Thierry

- **D1 — Le rythme.** Fil : 10 secondes. Liste : une fois par minute au plus.
  Lu dans le « ok » du 9 novembre 2026 (« Je prends ton « ok » comme : le fil
  ouvert se met à jour toutes les 10 secondes, et la liste toutes les
  minutes »). **À confirmer.**
- Le reste découle de la demande, sans décision produit nouvelle.

## 5. Inventaire (la forme ne supprime jamais le fond)

| fonction existante | sort |
|---|---|
| Chargement initial (liste, pauses, modes IA, consignes, Brevo, biens, propositions) | **conservé**, inchangé |
| Envoi manuel, « Non envoyé · Réessayer », texte jamais perdu | **conservé** ; la règle 3 évite le doublon au retour serveur |
| Propositions : Envoyer, Modifier, Rejeter, reprise d'échéance | **conservées** ; la règle 1 protège l'éditeur ouvert |
| Arrivées du jour et du lendemain en tête, téléphone, pastilles | **conservées** ; elles suivent la relecture de la liste |
| État lu (`conversation_flags.read_at`) | **conservé**, même writer (règle 4) |
| Pagination de la liste (« voir plus ») | **conservée** ; la relecture ne touche qu'à la première page, les pages suivantes restent chargées |
| Épingle, archivage manuel, tiroir IA et messages programmés | **conservés**, non touchés |

## 6. Case performance (obligatoire)

Catégorie de la donnée : **temps réel** (messages, propositions). Jamais de
résumé, jamais de cache.

1. **Un écran = un endpoint d'écran** : la page garde son chargement actuel ;
   la relecture est **un seul appel** par cycle, qui rend messages, propositions
   et `dernier` ensemble, lus en parallèle côté serveur.
2. **Donnée non urgente = résumé** : sans objet, tout est temps réel.
3. **Cache navigateur** : aucun. Messages et propositions se relisent.
4. **`private, no-store`** : oui, posé avant le premier refus, 405 compris.
5. **Fichiers statiques versionnés** : sans objet, aucun fichier neuf.
6. **Lecture tronquée à 1000 lignes** : bornée par construction (`limit(200)`,
   `complet: false` au-delà), jamais silencieuse.
7. **Budget** : le premier affichage ne change pas. La relecture vise
   **moins de 300 ms** et **moins d'1 Ko** quand rien n'est neuf. Un test
   compte les appels : un seul par cycle, aucun onglet caché.
8. **Mesures** :

   | | appels | octets | requêtes Supabase |
   |---|---|---|---|
   | AVANT, ouverture (prod, 9 novembre 2026) | 5 | 31 094 pour `/api/messages`, 255 613 pour la page | non mesuré |
   | AVANT, toutes les 10 s | 0 (rien ne se relit) | 0 | 0 |
   | APRÈS, ouverture | 5 attendus, inchangé | à mesurer en recette | |
   | APRÈS, toutes les 10 s, rien de neuf | 1 attendu | à mesurer en recette, cible < 1 Ko | 3 lectures attendues, à mesurer par `Server-Timing` |

## 7. Mobile

Même page, même code : le téléphone en profite sans report à prévoir. Au
téléphone, la liste seule est relue toutes les 60 secondes (§2).

## 8. Tests

- Endpoint : messages après `apres` seulement, triés ; `taches` du fil ;
  `dernier` ; périmètre (membre limité au bien A : rien du bien B, ni messages,
  ni propositions, ni `dernier` venu de B) ; archivage ; `apres` invalide → 400 ;
  borne 7 jours ; `complet: false` au-delà de 200 ; `no-store` sur 405 et 401.
- Page (DOM, banc existant de Messages, horloge factice) : un nouveau message
  apparaît sans recharger ; saisie et éditeur de proposition intacts ;
  défilement respecté et pastille ; aucun doublon après un envoi ; onglet caché
  = aucun appel, retour = une relecture immédiate ; changement de fil = réponse
  de l'ancien jetée ; trois échecs = mention, 401 = arrêt ; liste relue une fois
  par minute au plus, et seulement quand `dernier` bouge.
- Contre-épreuve : chaque test neuf rougit contre main ; horloge décalée à J+60
  et J+200.

## 9. Recette

- **Staging** : un message de test écrit dans `messages` du compte de recette
  doit apparaître dans le fil ouvert en moins de 15 secondes, sans recharger,
  sur ordinateur et sur téléphone. Les règles 1 à 3 sont rejouées à la main.
- **Production, après le merge** : au premier vrai message d'un voyageur, avec
  Thierry. On mesure le délai entre l'envoi du voyageur et l'affichage.

## 10. Hors périmètre

- **Notifications sur le téléphone** quand la page est fermée : c'est le lot 2
  de la PWA (notifications push), un autre fil.
- **Supabase Realtime** (la base pousse au lieu que la page demande) : écarté
  pour ce lot. Il faut ajouter `messages` et `agent_tasks` à la publication, et
  prouver que la RLS filtre bien le flux par compte et par périmètre. Une
  relecture toutes les 10 secondes suffit à cette échelle, sans migration.
- **Biens Beds24** : leurs messages entrent par un autre chemin, non mesuré
  ici. La page les montrera dès qu'ils sont dans le cœur, à leur rythme.
