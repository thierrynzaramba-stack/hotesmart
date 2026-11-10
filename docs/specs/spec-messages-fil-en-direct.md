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
  réservations du compte. Toutes les 5 secondes, ce serait 22 Mo par heure et
  par écran ouvert, pour presque toujours rien de neuf.

## 2. Ce que le lot fait

**Fil ouvert, onglet affiché : toutes les 5 secondes**, la page demande
seulement ce qui est arrivé dans CE fil depuis le dernier message connu. Un
nouveau message s'ajoute en bas, sans recharger la page.

**La liste des conversations : au plus une fois par minute**, et seulement si
quelque chose a changé. Chaque relecture du fil rend aussi l'heure du message
le plus récent du compte HORS du fil ouvert (le fil, lui, est déjà à jour).
Si elle a bougé, la première page de la liste se relit (`/api/messages?limit=50`, l'appel d'aujourd'hui), au plus une fois par
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
   locale au lieu de s'ajouter (même sens, même texte, envoyé à moins de cinq
   minutes d'écart — deux horloges), et dans les DEUX ordres : si la ligne
   est arrivée avant que la page pose sa bulle, la bulle n'est pas posée, ou
   est retirée au cycle suivant (review 1, constats 2 et 9).
4. **Lu tant que c'est à l'écran.** Un message du voyageur qui arrive dans le
   fil ouvert, onglet affiché, est lu : la page le marque comme d'habitude
   (`POST /api/messages action=lu`, writer unique), une fois par arrivée et pas
   à chaque relecture. ⚠ Pas sur une page oubliée (15 minutes sans geste) :
   personne n'est devant l'écran, le « non lu » reste ; le premier geste lit le
   fil ouvert (review 1, constat 11 — choix fait par défaut, réversible).
5. **Une panne ne casse rien.** Une relecture ratée se retente plus tard (20 s,
   puis 40 s, jusqu'à 2 min), sans message d'erreur. Après trois échecs de
   suite, une mention discrète « Mise à jour interrompue · Réessayer » apparaît
   sous l'en-tête du fil. Session expirée (401) : la relecture s'arrête.
6. **Changer de fil remet le compteur à zéro.** Une réponse qui arrive pour
   l'ancien fil après qu'on en a ouvert un autre est jetée.

## 3. La lecture côté serveur

Une forme neuve du **même endpoint**, pas une fonction de plus (le projet
Vercel a un plafond de 100 fonctions) :

`GET /api/messages?direct=1&fil=<bookId>&depuis=<curseur>`, et
`direct=1` seul pour la liste seule (code : le paramètre `direct` distingue
cette lecture de la collection, qui se lit sans paramètre).

Elle rend :
- `messages` : les messages du fil **insérés en base** après le curseur
  (`created_at > depuis`), dans l'ordre d'insertion, mêmes champs que la
  collection (`sender`, `direction`, `body`, `sent_at`, `kind`, `origine`).
  ⚠ **Le curseur est l'ordre d'INSERTION, pas `sent_at`** (review 1,
  constat 3) : le webhook Channex, son import de rattrapage, Beds24 et
  l'e-mail entrant écrivent des lignes dont `sent_at` précède l'insertion ; un
  curseur sur `sent_at` sautait pour toujours le message du voyageur arrivé
  après la réponse de l'hôte.
- `curseur` : le `created_at` de la dernière ligne rendue (inchangé si rien),
  que la page renvoie tel quel au cycle suivant — et que le serveur passe
  TEL QUEL à la base : `created_at` est à la microseconde, et le reparser
  par `new Date` le tronquait à la milliseconde, donc la dernière ligne
  revenait à chaque cycle (review 2, constat 4). Au premier cycle d'un fil, la
  page part du `lu_le` de la lecture qui a produit LES MESSAGES DE CE FIL
  (première page, « Afficher plus » ou relecture de la liste — review 2,
  constat 5) — l'instant, horloge serveur, que la collection rend avec sa
  lecture — moins deux minutes de recouvrement (deux horloges : Vercel et la
  base), que la fusion dédoublonne.
- `taches` : les propositions en attente du fil (`agent_tasks`,
  `pending_validation`, mêmes colonnes que la page lit aujourd'hui).
- `dernier` : le `created_at` du message le plus récent du compte, **hors du
  fil ouvert** (`neq booking_id`) : un message du voyageur avec qui l'hôte
  échange ne fait pas relire la liste entière. La page le compare au
  `dernier` qu'elle a déjà vu — une seule horloge, celle de la base : un même
  message ne fait relire la liste qu'une fois (review 2, constat 3). Le
  `lu_le` de la collection ne sert qu'à initialiser.

**Gardes, toutes celles de la collection** : compte cible et filtre de
périmètre (un membre limité au bien A n'apprend rien du bien B, pas même
l'existence d'un fil) ; règle d'archivage de la collection (`clesArchivees`) ;
`private, no-store` posé avant le premier refus. Bornes : `depuis` hors de la
forme ISO complète (date, heure, jusqu'à six décimales, `Z` ou décalage) ou
à une date qui n'existe pas (le 31 d'un mois de 30 jours, 24 h — V8 les
reporte, Postgres les refuse) → 400 ;
`depuis` plus vieux que 7 jours → ramené à 7 jours ; au plus 200 messages, et
au-delà `complet: false` — le cycle suivant reprend au 201e par le curseur.

## 4. Décisions de Thierry

- **D1 — Le rythme. TRANCHÉ par Thierry le 10 novembre 2026 à 01:06** :
  « 5 secondes le fil, le reste ok si c'est pas trop lourd ». Fil : **5
  secondes**. Liste : une fois par minute au plus.
- **D2 — La page restée ouverte sans personne devant. ACCEPTÉE le même jour**
  (« le reste ok »). Au bout de 15 minutes sans aucun geste dans la page
  (frappe, clic, défilement), onglet pourtant affiché, le fil passe à une
  relecture par minute ; le premier geste rétablit 5 secondes, avec une
  relecture immédiate. Effet chiffré au §6 : 720 relectures par heure
  deviennent 60 sur un écran oublié.
- **« Si c'est pas trop lourd »** : la réponse chiffrée est au §6, point 8.
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
5. **Fichiers statiques versionnés** : un module neuf, `shared/messages-direct.js`,
   servi comme les autres modules partagés de la page (aucun en-tête de cache
   long, pas dans le cache du service worker) ; les trois dictionnaires gagnent
   2 clés, leur empreinte se calcule au déploiement.
6. **Lecture tronquée à 1000 lignes** : bornée par construction (`limit(200)`,
   `complet: false` au-delà), jamais silencieuse.
7. **Budget** : le premier affichage ne change pas. La relecture vise
   **moins de 300 ms** et **moins d'1 Ko** quand rien n'est neuf. Un test
   compte les appels : un seul par cycle, aucun onglet caché.
8. **Coût par onglet ouvert, le chiffre qui compte** (demande du chef de file :
   un compte peut garder la page ouverte toute la journée). Une relecture =
   **1 appel HTTP** ; côté serveur, la garde de droits fait **3 requêtes**
   (`auth.getUser`, le compte demandé, le profil — `lib/require-permission.js`)
   et la relecture **4 lectures** en parallèle (messages du fil, propositions,
   `dernier`, biens archivés), soit **environ 7 requêtes Supabase** fil ouvert,
   et **environ 4** pour la liste seule (garde + `dernier`). Compté au code, à
   confirmer en recette par `Server-Timing`.

   | situation de l'onglet | appels HTTP / minute | requêtes Supabase / minute | octets / minute |
   |---|---|---|---|
   | **caché** (autre onglet, fenêtre réduite, téléphone verrouillé) | **0** | **0** | **0** |
   | affiché, fil ouvert, rien de neuf | 12 | ~84 | < 12 Ko sans proposition en attente (< 1 Ko par relecture : plus aucune ligne déjà connue ne revient) ; + le texte des propositions en attente du fil, à chaque relecture |
   | affiché, fil ouvert, un message arrive ailleurs dans le compte | 12, + 2 pour la relecture de la liste (la collection, puis les propositions lues sous RLS) | ~84, + celles de `/api/messages?limit=50` et 1 | + 31 Ko, au plus une fois par minute |
   | affiché, fil ouvert, un message du voyageur arrive dans le fil | 12, + 1 (`POST action=lu`) | ~84, + celles de la garde et de l'écriture | < 1 Ko de plus |
   | affiché, liste seule (téléphone, aucun fil ouvert) | 1 | ~4 | < 1 Ko |
   | affiché, fil ouvert, 15 min sans geste (D2) | 1 | ~7 | < 1 Ko |

   **Une journée de 10 heures, page affichée en continu, fil ouvert** :
   - quelqu'un s'en sert toute la journée : 7 200 appels, ~50 400 requêtes ;
   - personne ne la touche après le premier quart d'heure (D2) : ~765 appels
     (180 le premier quart d'heure, puis une par minute), ~5 400 requêtes ;
   - **onglet caché toute la journée : rien.** La règle « onglet caché = aucun
     appel » est tenue par un test (§8), pas par l'intention.

   **« Est-ce trop lourd ? »** (question de Thierry). Pour un hôte, non : une
   relecture vide lit trois index (`messages_booking_sent_idx`,
   `messages_user_sent_idx`, `agent_tasks` du fil) et rend moins d'1 Ko. Le
   coût croît avec le NOMBRE D'ÉCRANS AFFICHÉS EN MÊME TEMPS, pas avec le
   nombre de comptes : 100 hôtes qui gardent chacun la page au premier plan
   en s'en servant, c'est 1 200 appels par minute. Les deux garde-fous qui le
   tiennent : onglet caché = 0, et 15 minutes sans geste = 1 par minute. À
   remesurer en recette (`Server-Timing`) ; si la relecture dépasse 300 ms,
   le rythme se rediscute avec Thierry.

9. **Mesures** :

   | | appels | octets | requêtes Supabase |
   |---|---|---|---|
   | AVANT, ouverture (prod, 9 novembre 2026) | 5 | 31 094 pour `/api/messages`, 255 613 pour la page | non mesuré |
   | AVANT, toutes les 5 s | 0 (rien ne se relit) | 0 | 0 |
   | APRÈS, ouverture | 5 attendus, inchangé | à mesurer en recette | |
   | APRÈS, toutes les 5 s, rien de neuf | 1 attendu | à mesurer en recette, cible < 1 Ko | ~7 attendues (3 de garde + 4 lectures), à mesurer par `Server-Timing` |
   | APRÈS, onglet caché | 0 | 0 | 0 |

## 7. Mobile

Même page, même code : le téléphone en profite sans report à prévoir. Au
téléphone, la liste seule est relue toutes les 60 secondes (§2).

## 8. Tests

- Endpoint : messages insérés après le curseur seulement, triés ; `taches` du fil ;
  `dernier` ; périmètre (membre limité au bien A : rien du bien B, ni messages,
  ni propositions, ni `dernier` venu de B) ; archivage ; `depuis` invalide → 400 ;
  borne 7 jours ; `complet: false` au-delà de 200 ; `no-store` sur 405 et 401.
- Page (DOM, banc existant de Messages, horloge factice) : un nouveau message
  apparaît sans recharger ; saisie et éditeur de proposition intacts ;
  défilement respecté et pastille ; aucun doublon après un envoi ; onglet caché
  = aucun appel, retour = une relecture immédiate ; changement de fil = réponse
  de l'ancien jetée ; trois échecs = mention, 401 = arrêt ; liste relue une fois
  par minute au plus, et seulement quand `dernier` bouge ; si D2 est retenu,
  15 minutes sans geste = une relecture par minute, et le premier geste
  rétablit 5 secondes.
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
  relecture toutes les 5 secondes suffit à cette échelle, sans migration.
- **Biens Beds24** : leurs messages entrent par le relevé du cron. Le curseur
  suivant l'ordre d'insertion, la page les montre au cycle qui suit leur
  entrée dans le cœur — au rythme du relevé, pas en direct.
