# Inventaire de « Mes biens » — étape 0 du chantier Biens V5

**19 octobre 2026. LECTURE SEULE : aucun fichier de code n'a été modifié pour
produire ce document.** Les captures viennent du banc d'essai local, qui sert le
dépôt avec des données simulées — aucune base n'a été lue ni écrite.

Relevé fait sur `main` à `04a733c` (avant le correctif de navigation `1eb6d77`,
qui ne touche pas ces écrans).

> ⚠ **LE FAIT QUI CHANGE LE CHANTIER, ET QU'IL FAUT LIRE EN PREMIER.**
> **La fiche d'un bien n'existe pas.** `/biens/:id` (`pages/biens-detail.html`)
> ne fait qu'une chose : `window.location.replace('/biens')`. L'écran qu'elle
> devait porter — l'inventaire du partenaire en marque blanche — est en sommeil
> depuis la bêta (« Option B », commenté dans le fichier, 60 lignes dormantes).
> Tout ce qu'on sait d'un bien vit donc **dans sa carte de la liste et dans
> quatre fenêtres**. Le lot Biens V5 ne refond pas une fiche : il la **crée**.

---

## A. Fichiers, endpoints, tables

### Écrans

| Route | Fichier | Lignes | État |
|---|---|---|---|
| `/biens` | `pages/biens.html` | 910 | la liste, et tout le détail d'un bien |
| `/biens/nouveau` | `pages/biens-nouveau.html` | 238 | création, un seul formulaire |
| `/biens/:id` | `pages/biens-detail.html` | 124 | **redirection vers `/biens`** (+ 60 lignes dormantes) |
| `/biens/:id/calendrier` | `pages/biens-calendrier.html` | 22 | **redirection vers `/calendrier?bien=:id`** |

### Modules de front

| Module | Ce qu'il apporte à l'écran |
|---|---|
| `components/sidebar.js` | la navigation **ancienne** (barre latérale, 15 entrées) |
| `components/auth-guard.js` | `requireAuth()` — sans session, la page s'arrête |
| `components/connexions.js` | l'assistant « Connexions » par bien (marque blanche) |
| `components/airbnb-connect.js` | reprise du parcours Airbnb au retour OAuth |
| `shared/properties.js` | `loadAllProperties`, `provenanceBadge`, `hydrateChannelBadges` |
| `shared/compte-courant.js` | compte consulté, droits, `estTitulaire` |
| `shared/api-client.js` | `api.channel.*`, `api.calendar.fullsync` |
| `shared/error-handler.js`, `shared/logger.js` | journal et bandeau d'erreur |

### Endpoints

| Endpoint | Méthodes | Garde serveur | Appelé depuis |
|---|---|---|---|
| `/api/channel-property` | GET, POST, PATCH, DELETE | GET `reservations:read` ; POST, PATCH, DELETE `reglages:write` (+ bien requis) | liste, création, Modifier, Supprimer, mode des prix |
| `/api/property-photo` | POST | `reglages:write`, bien requis | zone photo de la carte |
| `/api/property-automation` | GET, POST | GET `reglages:read` ; POST `reglages:write` | badge « IA en pause », Couper/Réactiver l'IA |
| `/api/channel-connect` | GET | ownership par id | bouton Connexions |
| `/api/channel-airbnb-connect` | POST | ownership par id | parcours Airbnb |
| `/api/channel-token` | POST | ownership | **dormant** (iframe de `/biens/:id`) |
| `/api/calendar` (`fullsync`) | POST | — | bouton Publier |

### Tables Supabase

Aucune table n'est lue directement par l'écran : **tout passe par les
endpoints**, conformément à la règle du cœur de données.

| Table | Lue | Écrite | Par |
|---|---|---|---|
| `properties` | oui | oui | `channel-property`, `property-photo`, `property-automation`, `channel-connect` |
| `api_keys` | oui | non | `channel-property` (état des connexions) |
| `bookings_snapshot` | oui | non | `channel-property` (garde de suppression) |
| `message_sent_log` | oui | non | `channel-property` (garde de suppression) |
| `airbnb_connect_sessions` | oui | oui | `channel-airbnb-connect` |

---

## B. Les fonctions, visibles et cachées

**22 fonctions**, dont **4 cachées** (non visibles par l'hôte aujourd'hui).
« Qui » = le droit exigé **par le serveur** ; la colonne dit entre crochets ce
que l'**écran** masque réellement, qui est souvent moins.

### Sur la liste `/biens`

| # | Fonction | Où | Donnée | Endpoint | Qui |
|---|---|---|---|---|---|
| 1 | Voir ses biens | la liste | nom, ville, pays, capacité, devise | `channel-property` GET | `reservations:read` |
| 2 | Ajouter une photo / la remplacer | zone photo de la carte | JPEG ≤ 2000 px et ≤ 2 Mo, fabriqué dans le navigateur | `property-photo` POST | `reglages:write` [masqué correctement] |
| 3 | Lire la provenance du bien | pastille sous le nom | `provider` | — | tous |
| 4 | Lire les canaux reliés | 2ᵉ ligne de la carte | **chez le partenaire, en direct** | `channel-property` GET | `reservations:read` |
| 5 | Voir « IA en pause » | pastille rouge | `automation_paused` | `property-automation` GET | titulaire [écran] |
| 6 | Couper l'IA / Réactiver | bouton de la carte | `automation_paused` | `property-automation` POST | `reglages:write` [titulaire seulement, écran] |
| 7 | Lire le mode des prix | ligne « Prix sur les plateformes » | `rate_sync_mode` | `channel-property` GET | `reservations:read` |
| 8 | Changer le mode des prix | bouton « Changer » → fenêtre | `rate_sync_mode` : `keep` / `managed` | `channel-property` PATCH | `reglages:write` [**non masqué**] |
| 9 | Ouvrir le calendrier du bien | bouton « 📅 Calendrier » | — | — | tous |
| 10 | Ouvrir l'assistant de connexion | bouton « 🔗 Connexions » | canaux, OAuth Airbnb | `channel-connect`, `channel-airbnb-connect` | ownership [**non masqué**] |
| 11 | Publier ses prix | bouton « 📤 Publier » → fenêtre | tout le calendrier du bien | `calendar` fullsync | — [visible seulement si `managed`] |
| 12 | Modifier le bien | bouton → fenêtre, **11 champs** | nom, adresse, ville, code postal, pays, capacité, prix de base, prix plancher, voyageurs inclus, supplément, devise | `channel-property` PATCH | `reglages:write` [**non masqué**] |
| 13 | Supprimer le bien | bouton → fenêtre, frappe de confirmation | le bien et ses dépendances | `channel-property` DELETE | `reglages:write` [**non masqué**] |
| 14 | Ajouter un bien | bouton d'en-tête | — | — | titulaire [masqué correctement] |
| 15 | Connecter son premier logement | état vide | — | — | tous |
| 16 | Ouvrir Beds24 | carte d'un bien Beds24 | — | lien externe | tous |

### Sur la création `/biens/nouveau`

| # | Fonction | Donnée | Endpoint | Qui |
|---|---|---|---|---|
| 17 | Créer un bien | 11 champs, les mêmes que Modifier | `channel-property` POST | `reglages:write` |

### Cachées

| # | Fonction | Pourquoi on ne la voit pas |
|---|---|---|
| 18 | **L'inventaire du partenaire en iframe** (`/biens/:id`) | en sommeil depuis la bêta (« Option B ») ; 60 lignes commentées, `api/channel-token` reste vivant |
| 19 | **Masquage sur compte partagé** | `ajusterInterfaceSelonCompte()` ne masque que « Ajouter un bien » et le kill switch |
| 20 | **Garde de suppression** | le serveur refuse si le bien a des réservations ou des messages (`bookings_snapshot`, `message_sent_log`) — l'écran ne le dit qu'après coup |
| 21 | **Reprise du parcours Airbnb** | `bootstrapAirbnbReturn()` rouvre l'assistant au retour OAuth, sans que rien ne l'annonce |
| 22 | **Redirection `/biens/:id/calendrier`** | route héritée, toujours vivante, qui aboutit à `/calendrier?bien=:id` |

---

## C. Les liens vers les autres écrans

| Depuis | Vers | Comment |
|---|---|---|
| carte | **Calendrier** (`/calendrier?bien=:id`) | bouton, via la redirection héritée |
| carte | **Connexions / canaux** | fenêtre en marque blanche (`components/connexions.js`) |
| carte | **YieldFlow** | indirect : le mode des prix `managed` décide si le pilote tarifaire s'applique |
| carte | **Photo du bien** | zone photo — la même image sert l'accueil et les écrans ménages |
| carte | **Serrures** | aucun lien, alors que la serrure est un réglage du bien |
| carte | **Ménages** | aucun lien, alors que les prestataires sont liés aux biens |
| carte | **Taxe de séjour** | aucun lien ; le barème ne se règle nulle part dans cet écran |
| en-tête | **Onboarding** (`/pages/onboarding.html`) | état vide |
| barre latérale | 15 entrées (Accueil, Messages, Calendrier, Avis, les 4 apps, Connexions, Réglages, abonnement, Guide) | `components/sidebar.js` |

**Ce que la carte ne relie pas** est le vrai enseignement : serrures, ménages et
taxe de séjour sont des réglages **par bien**, et aucun ne s'atteint depuis le
bien. C'est ce que la fiche V5 a à gagner.

---

## D. Défauts constatés

**Aucun constat de sécurité.** Les cinq endpoints passent par
`requirePermission`, méthode par méthode, avec le bien exigé là où il faut. Ce
qui suit est de l'interface et de la donnée.

| # | Défaut | Où | Ce que ça coûte |
|---|---|---|---|
| D1 | **La page n'est pas traduite.** 6 clés en tout, toutes dans la zone photo ; tout le reste est du français écrit en dur, titres, boutons, fenêtres et messages d'erreur compris. | `pages/biens.html`, `pages/biens-nouveau.html` | la V5 sert fr/en/es (590 clés) : un hôte anglophone tombe sur une page française au milieu d'une application traduite |
| D2 | **Quatre actions ne sont masquées par aucun droit** : Modifier, Supprimer, Changer le mode des prix, Connexions. | cartes | un membre délégué voit « Supprimer définitivement » et reçoit un refus serveur — la règle des profils dit qu'on ne montre jamais une entrée qui mène à un refus |
| D3 | **« Capacité :  personne(s) »** quand `capacity` est vide — aucun repli. | carte | une donnée manquante s'affiche comme une phrase cassée |
| D4 | **Emoji en guise d'icônes** : 🏠 📅 🔗 💶 📤 ⏸ ▶ ⚠ ❌ | en-tête, boutons, fenêtres | la V5 a un sprite (`shared/icons.svg`) ; les emoji changent de dessin selon le téléphone |
| D5 | **Couleurs écrites en dur** : `#E24B4A` (×4), `#ff3b30`, `#fdecea`, `#8a1f1e`, `#8A8A8E`, `#fff` | `<style>` de la page | hors des jetons de `theme.css` : le mode sombre et toute reprise de charte les oublient |
| D6 | **Ancienne charte** : `/public/style.css` et le gabarit `layout / sidebar / main`, pas `shared/ui.css` ni `shared/theme.css` | les deux écrans | l'écran ne suit aucune règle du socle V5 |
| D7 | **À 390 px, « + Ajouter un bien » chevauche le sous-titre** de l'en-tête. | liste, téléphone | voir `captures/liste-390.png` |
| D8 | **Pas de fiche par bien** : `/biens/:id` redirige, et 60 lignes dormantes attendent dans le fichier. | `pages/biens-detail.html` | du code mort qui donne l'illusion d'un écran existant |
| D9 | **Le nom du partenaire reste masqué — c'est conforme.** « Channex » n'apparaît que dans 6 commentaires, jamais à l'écran. En revanche **« Beds24 » est visible** (« Réservations, tarifs et calendrier gérés via Beds24 », bouton « Ouvrir Beds24 »). | cartes | à trancher : Beds24 est un compte que l'hôte possède, pas un sous-traitant masqué |
| D10 | **« ancien channel manager » est montré à l'hôte** dans la ligne des prix. | carte, fenêtre du mode des prix | vocabulaire de métier, jamais expliqué nulle part |

---

## E. Captures

Dans `docs/specs/biens-v5/captures/`, chacune en **1440 px** et **390 px**.

| Écran / état | Fichiers |
|---|---|
| la liste, trois biens | `liste-1440.png`, `liste-390.png` |
| aucun bien | `liste-vide-1440.png`, `liste-vide-390.png` |
| pas le droit de lire les biens | `liste-refus-1440.png`, `liste-refus-390.png` |
| la lecture a échoué | `liste-erreur-1440.png`, `liste-erreur-390.png` |
| fenêtre « Modifier le bien » | `fenetre-edit-1440.png`, `fenetre-edit-390.png` |
| fenêtre « Supprimer » | `fenetre-delete-1440.png`, `fenetre-delete-390.png` |
| fenêtre « Publier mes prix » | `fenetre-publish-1440.png`, `fenetre-publish-390.png` |
| fenêtre « Mode des prix » | `fenetre-ratemode-1440.png`, `fenetre-ratemode-390.png` |
| création d'un bien | `creation-1440.png`, `creation-390.png` |
| `/biens/:id` — la redirection | `fiche-redirection-1440.png` |

---

## F. Le bug du menu Calendrier, vu depuis cette page

**Reproduit, puis corrigé — hors de ce chantier, sur sa propre branche.**

Le menu V5 (`shared/nav.js`) faisait pointer l'entrée « Calendrier » sur
`/biens` : sur Ménages, Messages et Calendrier, **« Calendrier » et « Mes biens »
menaient au même écran**, et aucun au calendrier. Le menu se dessinait
parfaitement — seule la destination était fausse.

- **Fichier** : `shared/nav.js`, l'entrée `{ id: 'calendar', href: '/biens' }`.
- **Commit qui la pose** : `257b59d` (10 octobre 2026, lot 1 V5) — **justifié**
  alors, l'écran V5 n'existait pas.
- **Commit qui la rend fausse** : `c8e7dff` (12 octobre, lot 3) livre
  `/calendrier` sans revenir changer le repli.
- **En production** du 12 au 19 octobre.
- **Corrigé** par `5de081b` et `1eb6d77` sur `fix-nav-calendrier`, en production
  le 19 octobre. `tests/nav-v5-destinations.test.js` (10 tests) le tient.

**Cette page n'est pas concernée** : elle porte l'ancienne barre latérale, dont
l'entrée Calendrier pointe sur `/biens/<premier bien>/calendrier` et a toujours
été juste.

---

## Partie 2 — ce que la base sait d'un bien

À venir : colonnes de `properties`, tables rattachées, et pour chaque donnée son
origine (partenaire ou nous), qui l'écrit, qui la lit. C'est le relevé qui sert
la dette 59.
