# Page « Messages » V5 (lot 2)

Spec : `docs/specs/spec-refonte-ui-v5-lot-messages.md`. Page : `pages/messages.html`
(réécriture `/messages`). Composants : section « Messagerie » de `shared/ui.css`.
Tests : `tests/messages-v5.test.js`.

## Étape 1 — LECTURE SEULE (11 octobre 2026)

Liste + fil, desktop et mobile, données réelles. **Aucune écriture** : ni saisie,
ni envoi, ni validation (étapes 2 et 3 de la spec §11).

### Sources

| Donnée | Source | Note |
|---|---|---|
| Conversations et fils | `GET /api/messages` (un appel) | 50 affichées puis « Afficher plus » **côté client** ; archivées masquées (drapeau `archivee` du serveur), « Afficher les anciennes » |
| Noms des biens, lien résa | `properties` sous RLS | jamais `/api/channel-property` (Beds24 en direct) |
| Propositions | `agent_tasks` `pending_validation` sous RLS, **filtrées « séjour à venir ou en cours »** par `tachesOuvertes` (module partagé ; règle resserrée par Thierry le 11 octobre : plus de clause « dernier message < 7 jours ») | affichées en bulle pointillée SANS boutons ; badge nav = leur compte |
| État du code (en-tête du fil) | `arrivee.codeEtat` de la même réponse | présent pour les arrivées du jour et de demain seulement |

### Règles d'écran

- « Non lu » = **dernier message entrant** (l'heuristique de la messagerie actuelle) :
  aucun état de lecture n'existe en base. Point **bleu** (`--info`, nouveau jeton,
  défini en clair et en sombre) — l'ambre reste réservé à « HôteSmart attend ta
  décision » (badge nav, spec §6).
- Tri : à valider, puis arrivées du jour et de demain, puis non lus, puis date. Filtres Tous / ● n / À valider ;
  recherche côté client (voyageur ou bien).
- Canal A / B / D sur l'avatar ; point vert = séjour en cours ou à venir.
- Robot sous une bulle = envoyée par l'IA (`messages.kind = 'auto'`).
- Mobile : liste et fil empilés ; **le fil ouvert masque la barre du bas**
  (`body[data-fil]`).
- Une date illisible ne fait jamais tomber le fil (repli sur le dernier instant).
- **Arrivées du jour et de demain** (inventaire §12 de la spec, fonctions conservées de
  l'ancienne page, réintégrées le 11 octobre après constat de Thierry) : badge
  « Arrive aujourd'hui / demain », fils remontés juste après « à valider », pastilles
  positives ménage fait / code transmis dans la liste, et dans l'en-tête du fil le
  ménage + le **téléphone en lien d'appel** (borné à ces arrivées).

## Étape 2 — envoi, proposition, pagination, état lu (11 octobre 2026)

- **Envoi manuel** : zone de saisie (Ctrl/⌘+Entrée envoie) ; la page choisit
  `/api/channel-message` (référence UUID) ou `/api/beds24` (numérique), comme
  l'ancienne page — le serveur route par la SOURCE (fil OTA, e-mail Offline).
  **Échec** : la bulle reste, liseré `--danger`, « Non envoyé · Réessayer »
  rejoue le même envoi ; le texte n'est jamais perdu.
- **« Proposer une réponse »** : `api/guestflow-proposer.js` — génération du
  cron (`preparerLot` + `classifierLot`), garde de coût du cron
  (`peutAppeler`/`noterAppel`), clés sur la RÉFÉRENCE provider. Refus parlants :
  rien en attente, déjà proposé, bien en pause, garde IA. Une classification
  « intervention » ne dépose RIEN (sinon la garde du cron tairait l'alerte SMS).
- **Pagination serveur** : `GET /api/messages?limit&before` (tronque après
  assemblage et tri ; `has_more`/`next_before`) ; sans `limit`, réponse
  complète (l'ancienne page ne change pas). Les arrivées j/j+1 sont toujours
  dans la première page. La recherche ne fouille que le chargé.
- **État lu** : `conversation_flags.read_at` (migration
  `2026-10-11-conversation-read-at`, writer unique : `POST /api/messages
  action=lu`, posé à l'ouverture d'un fil, ligne créée avec `pinned=false`).
  Non lu = dernier ENTRANT postérieur à max(read_at, dernier sortant) —
  répondre vaut lecture. Un profil en lecture seule ne marque pas (silencieux).
- Saisie, bouton IA et Réessayer RETIRÉS sans `peutEcrire('messages')`.

## Étape 3 — Envoyer / Modifier / Rejeter dans le fil (11 octobre 2026)

- **Envoyer** suit LE CHEMIN DE L'ANCIENNE PAGE, jamais un second :
  `posterMessage` (routage par source, partagé avec l'envoi manuel), PUIS la
  clôture par `POST /api/messages action=proposition` — statut + journal
  `conversations` (mêmes colonnes que messagerie.html), côté serveur parce
  qu'un profil délégué n'écrit pas ces tables sous RLS. L'UPDATE est
  conditionné par `status=pending_validation` (course entre deux clics fermée) ;
  une tâche déjà close répond 409 `deja_close` et l'écran retire la bulle.
- **Statuts** : `done` (envoyée) / `ignored` (rejetée) — CEUX de l'ancienne
  page. Le `rejected` de la spec §3.3 n'est PAS utilisé : une seule famille de
  statuts (le fond l'emporte, signalé à Thierry le 11 octobre).
- **Une seule source de vérité** : les deux pages ne montrent que
  `pending_validation` — valider ou rejeter d'un côté fait disparaître des deux.
- **Modifier** : le texte descend dans la saisie, la bulle se masque
  (`etat.enEdition`) ; la tâche n'est close (`done`) qu'à l'ENVOI réussi —
  l'envoi est un envoi manuel, `kind=message`, donc avatar hôte, pas robot.
  Changer de fil pendant l'édition : la proposition revient, le texte reste.
- **Après « Envoyer » direct aussi, la bulle envoyée n'a PAS de robot** : le
  writer (`api/channel-message`) écrit `kind='message'` pour tout envoi validé
  — l'ancienne page a le même comportement. La spec demandait un robot ; le
  cœur fait foi. **Décision de Thierry du 11 octobre : dette 66** — le writer
  d'envoi posera l'origine (`ia_validee` / `ia_modifiee` / `hote`) au moment de
  l'envoi, jamais recalculée ; prérequis du lot « Fait pour vous » enrichi,
  juste après l'étape 4, avant le lot Calendrier. D'ici là, pas de robot.
- **Constats de la revue de 06e6d50** (tous corrigés, aucun de sécurité) : la
  validation après « Modifier » est portée par l'ENTRÉE née du geste de la
  saisie (`entree.valideTache`), plus par tout envoi du fil — le « Réessayer »
  d'un vieux message manuel ne clôt plus la proposition ; sans
  `suggested_reply`, ni Envoyer ni Modifier (un clic postait un message vide,
  api/beds24 n'a aucune garde) ; un rejet que le serveur n'a pas enregistré ne
  disparaît plus de l'écran (note « Rejet non enregistré, réessayez ») ;
  relecture du statut juste avant l'envoi (deux onglets = pas de double
  message, le verrou serveur ne fermait que la double clôture) ; « Modifier »
  n'écrase plus un brouillon sans confirmation, et le texte descendu NON
  retouché repart avec sa proposition au changement de fil ; `texte` borné à
  10 000 caractères côté API.
- **Rejeter** vit dans le menu ⋯ (`details.bulle-menu`), sans confirmation.
- Échec d'envoi : la proposition reste (liseré `--danger`), « Non envoyé ·
  Réessayer » ; si la CLÔTURE échoue après un envoi réussi, la bulle part de
  l'écran (le message EST parti) et la proposition réapparaîtra au
  rechargement — « Rejeter » la ferme, on ne renvoie jamais deux fois seul.
- Boutons retirés sans `messages = write` ; badge nav décrémenté sans
  rechargement (`majBadge`). Mobile : boutons pleine largeur, Envoyer premier.

## Étape 4 — Test/Auto, tiroir réglages, redirections (11 octobre 2026)

- **Test/Auto** : le mode vit dans `agent_alert_config.config[<ref>].mode`
  (`test` par défaut), writer EXISTANT `/api/agent-config` (domaine
  `reglages`) — GET du blob, modification du seul mode du bien, POST, puis
  **GET de relecture : l'interrupteur montre l'état réel en base, jamais
  l'état supposé** (demande de Thierry). Passer en **Auto = confirmation
  explicite** (« les réponses connues partiront sans votre validation ») ;
  retour en Test sans confirmation. Sélecteur dans l'en-tête de la liste,
  agissant sur le bien du fil ouvert (grisé sinon, infobulle) ; masqué sur
  téléphone (le tiroir y donne accès).
- **Tiroir réglages** : par bien — Test/Auto (même mécanique), kill switch
  (`/api/property-automation`, relu pareil), lien « Connaissances »
  (`/apps/agent-ai/knowledge`, seule page de l'ancienne app qui survit). Sans
  droit `reglages` : pas de tiroir ni d'interrupteur.
- **Épingle et archivage manuel PORTÉS dans le menu ⋯ du fil** (rattrapage du
  11 octobre : l'inventaire §12 les annonçait à l'étape 2, les tests DOM de
  l'ancienne page ont révélé l'oubli). Actions serveur `epingler`/`desepingler`
  (nouvelles, mêmes gardes qu'archiver ; désépingler = UPDATE, jamais DELETE)
  et `archiver`/`desarchiver` (writer existant). L'état affiché vient de la
  RÉPONSE du writer. Épinglée = remontée derrière les arrivées, jamais
  archivée (l'entrée du menu disparaît, le serveur refuse de toute façon).
  Le bandeau « Évaluer ce voyageur » (lot 5 avis) n'est PAS porté : dette 67
  (à reconcevoir en proposition dans le fil au départ, avec la dette 66).
- **Redirections** : `apps/agent-ai/messagerie.html` et `config.html` ne sont
  plus que des redirections vers `/messages` (`?conv=` survit ; `?filtre=`
  accepté : `nonlus` / `avalider`). **Dette 43 SOLDÉE** : le filet legacy
  Beds24 et les écritures RLS directes de l'ancienne page disparaissent avec
  elle. L'accueil et `urlConversation` (module partagé des deux calendriers)
  pointent `/messages`.

### Reste (pas des dettes de ce lot)

- Lignes système « réservation modifiée / annulée » (spec §3.3) : à exposer par
  l'endpoint (booking_change_events).
- Dette 66 : l'origine des envois (`ia_validee`/`ia_modifiee`/`hote`) posée par
  le writer — prérequis « Fait pour vous », avant le lot Calendrier.

## Changement de périmètre — tout GuestFlow vit dans Messages (12 octobre 2026)

Décision de Thierry, en DEUX recettes ; inventaire champ par champ : spec
§12 bis. `config.html` RESTE EN SERVICE (URL seule) jusqu'à couverture 100 %.

**Recette 1 (volets « Réponses de l'IA » + « Alertes » du tiroir)** :
- Panneau par bien (sélecteur en tête, `properties` sous RLS), deux onglets.
- Volet IA : Test/Auto + pause (mécanique des étapes précédentes), consignes
  de l'IA (globales + par bien, writer de l'ancienne page À L'IDENTIQUE :
  delete+insert RLS sur `agent_prompting`), « ce qu'il valide seul » (texte),
  garde des appels IA en ÉTAT descriptif (rien à régler), lien Connaissances.
- Volet Alertes : 2 types × 2 canaux, destinataires « Nom : contact », porte
  SMS sans clé Brevo (lien /connexions, et les champs ABSENTS de l'écran
  PRÉSERVENT la base), boutons Tester (`/api/alert-test`, destinataire lu de
  la base ENREGISTRÉE — piège documenté par l'ancienne page).
- Écriture des alertes : POST CIBLÉ `alertes_ref`/`alertes` de
  `/api/agent-config` (merge serveur, champs bornés à 2000) + RELECTURE.
- Le test d'inventaire NOMME chaque champ manquant
  (tests/messages-v5.test.js, demande de Thierry).
- Tout le tiroir reste réservé au TITULAIRE (dette 68).

**Recette 2 (12 octobre 2026) — volet « Messages programmés »** :
- Constantes PARTAGÉES (`shared/messages-programmes.js`) : événements, délais,
  jours, heures, défauts du « Nouveau », mapping `reference` — repris à
  l'IDENTIQUE de l'ancienne app (test de parité littéral, écarts nommés).
- Cartes de l'inventaire B au complet : actif/inactif, suppression (avec
  CONFIRMATION), événement, délai ou jour+heure, « envoyer quand même »,
  serrure (`property_locks`→`locks`) + « pas avant », texte + 7 variables,
  Aperçu AI (bouton EXPLICITE seulement, `/api/grok` comme l'ancienne page).
- Writers : les MÊMES écritures RLS que l'ancienne app (update mêmes
  colonnes, insert défauts, delete) ; la ligne RELUE (`select().single()`)
  remplace l'état local ; lecture échouée = volet fermé ; chargé à
  l'OUVERTURE du volet, jamais au boot ; titulaire seulement (dette 68).
- **Parité sur données réelles** : `scripts/verifier-parite-templates.js`
  (lecture seule, non-vacuité exigée) — le 12 octobre : 11 messages comparés
  (Colomiers 2, Cœur de vie 23 4, La bulle 5, serrures comprises), 0 écart.
- **Redirection FAITE (12 octobre 2026, go de Thierry après recette 2 en
  prod)** : config.html et l'app templates (« Envoi programmé ») redirigent
  vers /messages, comme la messagerie depuis l'étape 4 — plus aucune des
  pages ABSORBÉES (messagerie, config, templates) n'écrit en direct : la
  « dette écriture directe de l'ancienne page » est close pour elles (les
  writers RLS survivent, appelés par le panneau, titulaire seulement —
  dette 68). ⚠ `knowledge.html` (delete+insert sur `knowledge`) et
  `analyze.html` (insert `knowledge`, lecture /api/beds24 DIRECTE — famille
  E1) restent des pages ACTIVES qui écrivent en direct : à traiter au lot
  Logements, ne pas les croire closes. La sidebar des anciennes pages
  ne liste plus que la Base de connaissance. Le témoin de parité vit
  désormais FIGÉ dans tests/messages-v5.test.js (l'original : git 89cd48e).
  **LE LOT 2 « MESSAGES » EST CLOS.**

## Dettes 66 + 67 soldées (12 octobre 2026)

- **66 — l'origine des envois** : colonne `messages.origine`
  (`ia_validee` / `ia_modifiee` / `hote` / `ia_auto`), POSÉE PAR LE WRITER À
  L'ENVOI, jamais recalculée. Liste fermée trois fois : contrainte CHECK en
  base, `ORIGINES` de `lib/record-message.js` (valeur inconnue = null loggé,
  colonne absente = repli sans casser l'envoi), et les endpoints de page qui
  refusent `ia_auto` (réservé à `lib/cron-classify` — les templates
  programmés de cron-messages/cron-arrival-code ne sont PAS l'IA : sans
  origine). Le robot s'affiche sur `kind='auto'` OU `origine ia_*` (consigne
  de Thierry : ia_modifiee aussi — remplace la spec §3.3). Tuile accueil
  « messages écrits par l'IA » : compte SERVEUR (`/api/messages?stats=ia`,
  périmètre appliqué) depuis la colonne SEULE — aucun historique
  reconstitué, tuile masquée si la migration manque.
- **67 — évaluer au départ** : à l'ouverture d'un fil au séjour TERMINÉ, la
  page demande `avis.statut` au BUS (import à la demande, cache par
  réservation) ; évaluable + droit → proposition pointillée « Évaluer
  {prénom} ? » dont le bouton ouvre la fenêtre standard du cœur
  (`avis.evaluer`, les boutons à niveaux du chantier avis) — MÊME WRITER que
  la fiche résa ; au retour, le statut se relit (« publiée ✓ » sans
  rechargement) ; jamais avant le départ, silencieux sans bus ou sans droit.
- Migration `2026-10-12-messages-origine` : staging puis prod (collage
  Thierry), prouvée par `scripts/verifier-migration-messages-origine.js`
  (colonne par son nom + liste fermée par un INSERT refusé).

## Le fil en direct (10 novembre 2026)

Spec : `docs/specs/spec-messages-fil-en-direct.md`. Demande de Thierry du
9 novembre 2026 : échanger avec le voyageur sans recharger la page. Rythme
décidé par Thierry le 10 novembre 2026 à 01:06.

- **Fil ouvert, onglet affiché : une relecture toutes les 5 secondes**, par
  `GET /api/messages?direct=1&fil=<bookId>&depuis=<curseur>`. Elle rend les
  messages du fil **insérés** après le curseur (`created_at`, l'ordre
  d'insertion — PAS `sent_at`, que le webhook, l'import et Beds24 écrivent
  dans le passé), le `curseur` suivant, les propositions en attente, et
  `dernier` : le `created_at` du message le plus récent du compte **hors du
  fil ouvert**. Premier cycle d'un fil : le `lu_le` (horloge serveur) de la
  lecture qui a produit les messages de CE fil, moins deux minutes. Le
  curseur est renvoyé TEL QUEL à la base : il est à la microseconde, et le
  tronquer faisait revenir la dernière ligne à chaque cycle.
- **La liste** se relit (`/api/messages?limit=50`, l'appel d'ouverture) au plus
  une fois par minute, et seulement quand `dernier` dépasse le dernier
  `dernier` déjà vu (une seule horloge : un message = une relecture).
  Sans fil ouvert : une relecture par minute (`direct=1` seul).
- **Onglet caché : aucun appel.** 15 minutes sans geste : une par minute.
  Échecs : 20 s, 40 s, 80 s, puis 2 min ; trois de suite affichent « Mise à
  jour interrompue · Réessayer » ; un 401 arrête la relecture.
- **Ce que l'hôte tient n'est pas redessiné** : la saisie est hors du fil ; un
  élément qui a le focus dans le fil, son en-tête ou le bandeau d'échéance, ou
  le menu ⋯ ouvert, fait attendre le rendu (pastille « Nouveau message »).
  Hôte remonté lire : le fil ne saute pas. Le défilement n'est pas un geste.
- **Pas de doublon** : une bulle posée par la page après un envoi porte
  `_local`, et sa ligne du cœur la remplace (même texte sortant, moins de
  cinq minutes d'écart), dans les deux ordres d'arrivée.
- **Les propositions se fondent EN PLACE**, jamais remplacées : celle que
  l'hôte envoie reste tenue jusqu'à sa clôture (constat bloquant de la review 1 :
  sinon la clôture ne partait pas et un second clic envoyait en double).
  « Modifier puis Envoyer » RÉSERVE la proposition (`sending`) avant l'appel
  au canal, avec ou sans échéance — comme le bouton de la bulle : sans
  réservation, tout ce qui la remettait à l'écran (cycle pendant la clôture,
  clôture ratée, changement de fil, « Modifier » une autre, « Proposer »)
  rendait un « Envoyer » que le serveur acceptait (reviews 2 et 3). Elle est
  « en cours » dès le geste et ne se dessine pas dans le fil : c'est le texte
  de la saisie qui part, la bulle d'envoi le montre. Un échec d'envoi la
  relâche et la rend au fil. Une proposition retirée par la
  page (numéro d'une horloge LOGIQUE de la page, pas `Date.now()` que le
  réglage du poste fait reculer) ne revient pas sur une réponse DEMANDÉE avant
  le retrait — mais elle
  revient si le serveur la rend ensuite : le cron rend à l'hôte une réponse
  différée qu'il n'a pas pu délivrer, et la cacher pour toujours laissait
  l'hôte croire le voyageur servi (review 2, constat 2).
- **Lu tant que c'est à l'écran** : un message du voyageur arrivé dans le fil
  ouvert est marqué lu une fois (`POST action=lu`) — pas sur une page oubliée ;
  le premier geste lit alors le fil.
- Règles pures dans `shared/messages-direct.js` ; gardes serveur (compte
  cible, périmètre sur les trois lectures, archivage, `private, no-store` dès
  le 405, `Server-Timing` avec le nombre de requêtes) dans `api/messages.js`.

## Information manquante : Oui / Non / Autre, l'IA rédige (étape 1, 10 novembre 2026)

Spec : `docs/specs/spec-info-manquante-choix.md`. Demande de Thierry du
10 novembre 2026. Étape 1 = la carte et le bouton « IA » ; l'étape 2 (la base
apprend : réponse prête à créer ou à modifier) vient après sa recette.

- **Serveur.** `POST /api/guestflow-rediger`, actions `choix` (la carte) et
  `texte` (le bouton « IA » de la saisie). Il rend `{ texte }` et **n'écrit
  rien** : le texte va dans la saisie, l'hôte relit et envoie par le chemin
  d'envoi existant. Gardes de « Proposer » (messages en écriture,
  réservation requise, clé sur la référence provider, kill switch), appel
  étiqueté `guestflow_rediger` au journal `ia_appels`.
- **⚠ Le modèle ne reçoit PAS la base de connaissance** (recette du
  12 novembre 2026, décision de Thierry : « les choix, plus la
  conversation »). Mesuré sur staging : avec la base, il a répondu à une autre
  question du voyageur restée ouverte et y a mis le code de la porte. Le
  message ne dit que les décisions (ou le brouillon) de l'hôte ; la
  conversation sert à la demande, la langue, le prénom et le ton.
- **⚠ Le plafond de l'hôte est le sien** (décision de Thierry : « 3 est trop
  petit de toute façon ») : 10 rédactions par conversation sur 24 h, comptées
  dans `ia_appels`. Jamais dans `guestflow_appels_ia` : trois clics y
  arrêteraient l'agent sur le fil et réveilleraient le fondateur. Relever les
  3 appels de l'agent : dette 146.
- **⚠ Une tâche `pending` ne sort JAMAIS dans `taches`.** La page affiche
  `taches` en proposition, et « Envoyer » y ferait partir `suggested_reply` —
  une note INTERNE — au voyageur. Le fil en direct lit les deux statuts en une
  lecture et rend un champ neuf, `infos` (les questions seules). Ni
  intervention (décision 1), ni tâche système (pause, arrêt de l'agent).
- **⚠ La question revient du client, au caractère.** Le cron complète la
  tâche quand le voyageur écrit encore : des choix pris sur l'ancienne carte,
  appliqués par position, répondraient à des questions jamais lues.
  Écart : `409 questions_changees`.
- **La carte ne se montre que si l'hôte n'a pas répondu depuis la tâche** : le
  cron ne clôt jamais une tâche `pending` quand l'hôte répond à la main. Après
  un envoi depuis la carte, `POST /api/messages { action: 'info_traitee' }`
  la clôt (`pending` → `done`, sous condition de statut).
- **L'alerte n'est pas retirée par la clôture** : elle part dans le tour de
  classification (le réglage `alerte_info` est enregistré mais aucun code de
  `lib/` ne le lit encore).
- **La page** (`pages/messages.html`, ajouts seuls) : la carte arrive par le
  fil en direct (au plus 5 s après l'ouverture du fil, aucun appel de plus),
  en fin de fil ; « Rédiger la réponse » MET le texte À LA SUITE de la saisie,
  marqué pour ce voyageur comme un texte posé par « Utiliser » ; une
  rédaction revenue après un changement de fil est jetée. Le bouton « IA »
  n'apparaît que si du texte est tapé, fige le champ pendant la rédaction,
  REMPLACE le texte, et « Annuler » le rend tant que la version rédigée n'a pas
  été retouchée. La tâche se clôt après l'envoi RÉUSSI de l'entrée née de la
  carte (« Réessayer » compris), jamais pour un autre message — et seulement si
  la tâche n'a pas été complétée depuis (`maj`, sinon 409 `questions_changees`
  et la tâche reste dans « À valider »).
- **⚠ La marque de la saisie se revérifie AU RETOUR de l'IA** (review 1,
  constat 1, bloquant, reproduit) : pendant la rédaction, l'hôte peut aller
  « Utiliser » le wifi d'un autre voyageur et revenir ; ajouter la réponse et
  reprendre la marque faisait partir ce texte chez le mauvais voyageur.
  **Et un texte TAPÉ ailleurs, sans marque, aussi** (review 2, constat 1) : la
  page compte ses changements de conversation (`etat.changementsDeFil`) ; si
  l'hôte est passé par un autre fil ET que la saisie a changé, la rédaction
  est jetée, avec la note « vérifiez-la ou videz-la, puis relancez ». Un coup
  d'œil, saisie intacte, ne coûte rien. **Et la relance est REFUSÉE tant que
  l'hôte n'a pas touché la saisie** (review 3, constat 1) : sinon le clic que
  la note demande ajoutait la réponse au texte de l'autre voyageur.
- **L'engagement de clôture tombe** quand on quitte le fil de la réponse
  rédigée, quand la saisie est vidée, ou quand une rédaction suivante est
  jetée (review 3, constat 2) : un « je reviens vers vous » ne clôt jamais la
  question. Laisser une question ouverte ne coûte rien ; la clore à tort la
  fait disparaître d'« À valider ».
- Une clôture refusée parce que le voyageur a posé une nouvelle question
  entre-temps se DIT dans le fil (« elle reste dans À valider »).
- **Une rédaction ne tient pas la page** : délai de 30 s
  (`DELAI_REDACTION_MS`), et changer de conversation libère le champ figé par
  le bouton « IA ».
- **Pas de carte pour les tâches de secours du cron** (sortie illisible, garde
  emoji) : leur question est le message entier du voyageur.
- Règles pures : `lib/guestflow/rediger.js` (serveur) et
  `shared/info-manquante.js` (page), copies tenues par
  `tests/info-manquante-regles.test.js` ; la page par
  `tests/info-manquante-dom.test.js` (banc `tests/outils/banc-messages.js`).
