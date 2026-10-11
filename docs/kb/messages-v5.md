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
| Propositions | `agent_tasks` `pending_validation` sous RLS, **filtrées « conversation ouverte »** par `tachesOuvertes` (règle du lot 1, module partagé) | affichées en bulle pointillée SANS boutons ; badge nav = leur compte |
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

### Prévu aux étapes suivantes (décisions de Thierry du 11 octobre 2026, pas des dettes)

- **Étape 2** : envoi manuel + « Proposer une réponse » ; **pagination serveur**
  (`limit`/`before` sur `/api/messages`) ; **état lu réel** (colonne `read_at`,
  posée à l'ouverture d'un fil).
- **Étape 3** : Envoyer / Modifier / Rejeter sur les propositions, dans le fil.
- **Étape 4** : Test/Auto + tiroir réglages, redirection de l'ancienne page,
  retrait du lien « Outils ». D'ici là : l'ancienne messagerie n'apparaît **dans
  aucun menu** (nav et barre latérale pointent la nouvelle page), URL seule ; les
  boutons « Voir » de l'accueil y mènent encore, car on y VALIDE (étape 3).
- Lignes système « réservation modifiée / annulée » (spec §3.3) : à exposer par
  l'endpoint (booking_change_events) à l'étape 2+.
