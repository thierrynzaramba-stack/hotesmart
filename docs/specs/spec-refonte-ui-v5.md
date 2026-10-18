# Spec — Refonte UI HôteSmart (V5 « esthétique chaleureuse »)

Décision du 10 octobre 2026 : la V5 de la maquette est la cible. Ce document est la
référence pour Claude Code. La maquette (artefact « HôteSmart — Refonte UI »,
planches `Accueil-v5`, `Mobile-v5`, `Identite`) fait foi pour le rendu ; cette spec
fait foi pour les règles.

## 1. Principes (ne pas discuter, appliquer)

1. **Simplicité et sécurité.** Un écran = une intention. Pas de bandeau, pas de
   panneau latéral d'aide, pas de texte explicatif.
2. **Le moins de texte possible.** Icônes, chiffres, photos d'abord. Un libellé n'est
   écrit que s'il n'existe pas d'icône universelle.
3. **Faits comptés, jamais d'estimation.** On affiche « 14 messages envoyés », jamais
   « 2 h gagnées ». Tout chiffre affiché doit être une requête sur le cœur.
4. **Semi-autonomie visible.** HôteSmart propose, l'hôte valide. Ce qu'il a fait seul
   est montré (« Fait pour vous »), ce qu'il attend est montré (« À valider »).
5. **Léger.** Si un écran se charge, on retire. Pas de carte dans une carte.

## 2. Charte

| Jeton | Valeur | Usage |
|---|---|---|
| `--ink` | `#222222` | texte, boutons principaux, icônes |
| `--muted` | `#717171` | texte secondaire |
| `--line` | `#EBEBEB` | séparateurs |
| `--border` | `#DDDDDD` | bordures de cartes et boutons secondaires |
| `--surface-2` | `#F7F7F7` | fond des pastilles d'icône |
| `--brand-night` | `#0E1726` | logo, avatar |
| `--amber` | `#F5A524` | **un seul moment par écran** : ce qu'HôteSmart a fait ou attend (badge Messages, action à faire, « Tout est automatisé »). Jamais sur un bouton. |
| `--amber-soft` | `#FFF4E0` | fond de l'icône de l'action en attente |
| `--amber-text` | `#B87500` | texte ambre lisible sur blanc |
| fond de page | `#FFFFFF` | toujours blanc |

- **Police** : Plus Jakarta Sans (400, 500, 600, 700, 800). Titres en 800 avec
  `letter-spacing: -0.03em`. Chiffres en `font-variant-numeric: tabular-nums`.
- **Rayons** : boutons et badges `99px` (pilules) ; cartes et photos `16px` ;
  pastilles d'icône `12px`.
- **Boutons** : hauteur 44–48 px. Principal = fond `--ink`, texte blanc.
  Secondaire = bordure `--border`, fond blanc. Lien = souligné, 600.
- **Icônes** : trait 1.75, inline SVG (Lucide-like). **Aucun emoji** dans l'interface.
- **Statuts** : jamais la couleur seule — toujours icône ou texte avec.
- **Logo** : le « ô » (toit ambre + cercle blanc sur carré bleu nuit, rayon 9/32).
  Mot-marque « HôteSmart » en 800.

## 3. Navigation

Barre horizontale blanche, onglets centrés en pilules. **Cinq entrées, définitives** :

| Onglet | Contenu | Ce qui y est fusionné |
|---|---|---|
| Aujourd'hui | accueil orienté action | — |
| Calendrier | planning + prix sur chaque jour | YieldFlow (interrupteur « tarification auto » dans l'en-tête, grille modifiable accessible depuis là) |
| Messages | messagerie | GuestFlow AI (interrupteur Test / Auto + réglages dans l'en-tête ; propositions à valider dans le fil) |
| Ménages | planning ménages + prestataires | — |
| Logements | fiches des biens | Connexions **par bien** : Airbnb, Booking.com, **Réservation directe** au même rang (ce n'est plus une app ni une entrée de menu) |

- Badge ambre sur « Messages » = nombre de propositions à valider.
- Menu ≡ + avatar à droite : Réglages (compte, équipe, facturation), Avis, Aide,
  Déconnexion. Les avis restent aussi visibles sur chaque fiche logement.
- Mobile : barre du bas, 5 icônes + libellés 10 px, même ordre.
- **Plus jamais de section « Mes apps »** ni de page « Cliquez pour configurer ».

## 4. Page « Aujourd'hui »

Dans l'ordre, de haut en bas (desktop `max-width: 1200px`, padding 48) :

1. **Titre** : « Bonjour {prénom} » + sous-titre compté : « {date} · {n} arrivées,
   {n} départs, {n} chose(s) à faire ». Bouton secondaire « Ajouter un logement ».
2. **Aujourd'hui** (2/3 de largeur) : liste chronologique des arrivées et départs du
   jour. Ligne = heure · pastille icône (arrivée / départ) · « Arrivée · {bien} » ·
   sous-ligne compte (voyageur, nuits, état du code, état du ménage). Si une action
   est attendue, la pastille passe en `--amber-soft` et un bouton principal apparaît
   dans la ligne (« Envoyer le code »).
3. **À valider** (1/3) : cartes des propositions en attente (réponse IA, prix YieldFlow),
   chacune avec deux boutons (Envoyer / Modifier, Appliquer / Ignorer). Lien
   « Régler ce qu'il valide seul » → réglages d'autonomie.
4. **Fait pour vous · 7 derniers jours** : 5 tuiles, icône + chiffre + libellé compté :
   messages envoyés (et nombre de langues), codes d'accès envoyés et effacés, ménages
   planifiés et confirmés, prix ajustés validés (somme en €), surréservations (0,
   « calendriers vérifiés »).
5. **30 jours** : trois chiffres sur une ligne — Revenus 30 j (+ variation vs 30 j
   précédents), Note 30 j (+ nombre d'avis), Occupation 30 j (+ variation).
6. **Vos logements** : grille de cartes photo 4:3 (`minmax(240px, 1fr)`), badge blanc
   sur la photo (« Occupé ce soir » / « Libre ce soir »), puis : nom + note ★, ville +
   prochaine arrivée, **CA 30 j + variation**, barre d'autonomie. Un bien sans canal
   affiche une carte en pointillés « Relier Airbnb ou Booking.com ».

Mobile : même ordre, mais **À valider** devient une seule carte sombre en tête
(« {action} » + bien + heure), « Fait pour vous » et « Vos logements » défilent
horizontalement.

### Données par bien (règle gravée)

CA 30 j, note 30 j, et min / max du CA mensuel sur 12 mois s'affichent **par bien**,
jamais en global. (Le bloc « 30 jours » global de la V5 reste pour Revenus / Note /
Occupation, qui sont des totaux.)

### Points à trancher avant de coder

- **Variation « ▲ 12 % »** : définir la base (30 j précédents ? même période N-1 ?).
  Tant que l'historique des réservations n'est pas importé, N-1 est impossible →
  partir sur « 30 j précédents » et le dire dans l'infobulle.
- **Barre d'autonomie** : définir la formule (part des événements traités sans
  intervention de l'hôte sur 30 j ?). Si pas de définition simple, **ne pas l'afficher**
  (principe 3).
- **Revenus** : brut hors charges, par nuit passée dans la période (un séjour à
  cheval est réparti). Les commissions ne sont pas déduites.

## 5. Page « Messages »

Deux colonnes : liste des conversations (avatar + pastille canal A / B / D, bien,
dates, dernier message ; filtres Tous / Non lus / À valider) et fil ouvert
(bulles voyageur blanches, bulles hôte `--ink`, icône robot sur les réponses
automatiques). En mode Test, la proposition de l'IA apparaît dans le fil en carte
pointillée avec Modifier / Rejeter / Envoyer. En-tête de conversation : bien, dates,
icône verte « code envoyé », lien vers la réservation.

La planche `Messages.dc.html` de la maquette montre la structure mais avec
l'ancien style (rail d'icônes, Geist) : **reprendre la structure, appliquer la charte V5**.

## 6. Charte modifiable et icônes

Objectif : changer une couleur, une police ou un rayon **en un seul endroit**, sans
toucher aux pages. Idem pour les icônes.

### 6.1 Un seul fichier de jetons

- `shared/theme.css` déclare **toutes** les variables CSS de la section 2 sur `:root`
  (`--ink`, `--muted`, `--amber`, `--radius-pill`, `--radius-card`, `--font`,
  `--font-size-h1`, etc.). C'est le seul fichier où un hexa, une police ou un `px`
  de rayon a le droit d'exister.
- `shared/ui.css` (composants) et toutes les pages n'utilisent **que** `var(--…)`.
  Règle de revue : `grep -E '#[0-9A-Fa-f]{3,6}' pages/ apps/ shared/ui.css` doit
  rendre zéro résultat.
- Les variantes vivent au même endroit : `:root[data-theme="dark"] { … }` redéfinit
  les jetons. Un thème = un bloc de variables, jamais un second fichier CSS.
- Les chartes « marque blanche » (sites vitrines, moteur de réservation) suivent le
  même mécanisme : les couleurs de l'hôte écrasent les jetons sur `:root` de la page
  publique, rien d'autre ne change.

### 6.2 Icônes : une bibliothèque, un nom, un endroit

- Source unique : **Lucide** (trait 1.75, 24×24, licence ISC). Pas de mélange de
  bibliothèques, pas de SVG dessiné à la main dans une page, aucun emoji.
- Un sprite `shared/icons.svg` contient les icônes utilisées, chacune sous un
  `<symbol id="i-…">`. Une page écrit `<svg class="icon"><use href="/shared/icons.svg#i-calendar"/></svg>`.
  Changer une icône = remplacer un `<symbol>`.
- Les icônes héritent de `currentColor` et de `--icon-size` : jamais de couleur ni
  de taille en dur sur le `<svg>`.
- Nommage par **sens**, pas par dessin : `i-arrival`, `i-departure`, `i-cleaning`,
  `i-key`, `i-price`, `i-message`, `i-review`, `i-home`, `i-shield`, `i-ai`.
  Si demain « arrivée » change de dessin, le nom reste.
- Le logo « ô » est le seul SVG inline autorisé (fichier `shared/logo.svg`, importé).

### 6.3 Traduction (i18n) prévue dès le lot 1

- **Aucune chaîne en dur dans le HTML ou le JS.** Chaque texte visible passe par
  `t('cle')`. Le HTML statique porte `data-i18n="cle"` et un petit script remplit
  au chargement.
- Fichiers `shared/i18n/fr.json`, `en.json`, `es.json` (plat, clés par domaine :
  `nav.today`, `today.arrival`, `done.messages_sent`). Le français est la langue de
  référence ; une clé absente dans une autre langue retombe sur le français.
- **Ajouter une langue = ajouter un fichier, rien d'autre.** Règle de conception :
  - un fichier `shared/i18n/langues.json` liste les langues disponibles
    (`[{"code":"fr","nom":"Français"},{"code":"en","nom":"English"}, …]`) ; le
    sélecteur de langue du menu se construit depuis cette liste, jamais codé en dur ;
  - aucune condition `if (lang === 'fr')` nulle part dans le code ;
  - le script `scripts/i18n-check.js` compare chaque fichier de langue au français et
    liste les clés manquantes — à lancer avant chaque commit qui touche un texte ;
  - le script `scripts/i18n-new.js <code>` crée un nouveau fichier pré-rempli avec les
    clés françaises à traduire (traduction par Haiku en première passe, relecture
    humaine ensuite) ;
  - les langues de droite à gauche (arabe, hébreu) sont prévues par `dir="auto"` sur
    `<html>` et des marges logiques en CSS (`margin-inline-start`, pas `margin-left`).
  Test d'acceptation : créer `it.json` et voir « Italiano » apparaître dans le menu
  sans toucher une ligne de code.
- Langue choisie : `navigator.language` au premier chargement, puis préférence en
  base sur le profil (pas seulement en localStorage), car l'hôte change d'appareil.
- Les textes générés par le serveur (SMS, emails voyageurs, propositions IA) ont
  déjà leur langue par voyageur ; **ne pas confondre** la langue de l'interface hôte
  et la langue des messages voyageur.
- Dates, heures, montants : `Intl.DateTimeFormat` / `Intl.NumberFormat` avec la
  locale de l'hôte, devise du bien. Jamais de formatage à la main.
- Prévoir la place : les libellés anglais et espagnols sont jusqu'à 30 % plus longs.
  Les pilules de navigation et les tuiles doivent tenir avec `Calendario` et
  `Mensajes`. Les icônes seules (mobile) rendent ce point moins critique.
- Pluriels et accords (« 1 arrivée » / « 2 arrivées ») via `Intl.PluralRules`,
  pas par concaténation.

## 7. Lots de livraison

1. **Socle** : `shared/theme.css` (jetons), `shared/ui.css` (composants : pilule,
   carte, pastille icône, tuile chiffre, barre d'onglets, barre mobile),
   `shared/icons.svg` (sprite Lucide), `shared/i18n/` (fr/en/es + `t()`).
   Aucune page ne définit ses propres couleurs, icônes ni textes.
2. **Navigation + Aujourd'hui** (`pages/` → accueil). Remplace le dashboard actuel.
3. **Logements** : fiches + connexions par bien (Airbnb, Booking.com, Réservation
   directe).
4. **Messages** avec GuestFlow fusionné.
5. **Calendrier** avec YieldFlow fusionné.
6. **Ménages**, puis Réglages / Avis dans le menu.

Chaque lot : desktop et mobile ensemble (règle du 30 sept.), KB mise à jour dans le
même commit, revue avant push.

## 8. Hors périmètre

- Pas de nouvelle fonctionnalité métier : la refonte réutilise les endpoints existants.
- Pas de double authentification ni de recherche globale dans ce chantier (notés
  pour plus tard). Le sélecteur de langue est dans le menu ≡ dès que `en.json` existe.
