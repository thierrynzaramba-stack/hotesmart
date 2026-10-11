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
  cœur fait foi (signalé à Thierry).
- **Rejeter** vit dans le menu ⋯ (`details.bulle-menu`), sans confirmation.
- Échec d'envoi : la proposition reste (liseré `--danger`), « Non envoyé ·
  Réessayer » ; si la CLÔTURE échoue après un envoi réussi, la bulle part de
  l'écran (le message EST parti) et la proposition réapparaîtra au
  rechargement — « Rejeter » la ferme, on ne renvoie jamais deux fois seul.
- Boutons retirés sans `messages = write` ; badge nav décrémenté sans
  rechargement (`majBadge`). Mobile : boutons pleine largeur, Envoyer premier.

### Prévu à l'étape suivante (décisions de Thierry du 11 octobre 2026, pas des dettes)

- **Étape 4** : Test/Auto + tiroir réglages, redirection de l'ancienne page,
  retrait du lien « Outils ». D'ici là : l'ancienne messagerie n'apparaît **dans
  aucun menu** (nav et barre latérale pointent la nouvelle page), URL seule.
- Lignes système « réservation modifiée / annulée » (spec §3.3) : à exposer par
  l'endpoint (booking_change_events) à l'étape 2+.
