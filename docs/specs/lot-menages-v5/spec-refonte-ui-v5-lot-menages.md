# Spec — Refonte UI V5, lot 4 : « Ménages »

Suite de `spec-refonte-ui-v5.md` (charte, navigation, socle).
Maquette : planches `Menages-v5` et `Menages-mobile-v5` de l'artefact « HôteSmart — Refonte UI ».
Base métier : `docs/specs/inventaire-menages.md` (f352ce7). **Cette spec donne la forme ;
l'inventaire fait foi sur le fond.** Avant tout code, Claude Code produit le tableau de
conformité (§12) : chaque fonction de l'inventaire → conservée / déplacée / retirée.
Aucune fonction ne disparaît par omission.

## 1. Ce que ce lot remplace

- La page **Ménages** actuelle (vue semaine en colonnes, mini-calendrier, compteurs) et la
  page **Planning de garde** (une ligne Garde + une ligne Ménage par bien) → **une seule page**
  `pages/menages.html`, onglet « Ménages » de `nav.js`.
- Conservés tels quels, accessibles depuis la page : l'écran **Prestataires** (icône en haut
  à droite), la **fiche ménage** (ouverte au clic sur une pastille, réassignation dedans),
  l'**édition des gardes** (bouton « Modifier les gardes » et boutons « Assigner »).
- Hors périmètre de cette étape : la PWA prestataire (sauf correctif D2), la refonte de
  l'écran Prestataires.

## 2. Principe

La page répond à trois questions, dans cet ordre :
1. **Qu'est-ce qui m'attend ?** → la bulle « À traiter » (30 jours).
2. **Qui couvre quel bien, quels jours ?** → le calendrier, une ligne par prestataire.
3. **Où en est un ménage ?** → la fiche ménage (étapes), au clic.

Le moins de texte possible : l'état d'un ménage se lit à sa pastille, un trou de
couverture à une barre rouge hachurée.

## 3. Desktop (≥ 900 px)

```
┌ topbar V5 (badge ambre sur Ménages = total À traiter) ─────────────────────────┐
│ Ménages                                                        [Prestataires] │
│ ┌ À TRAITER (ambre) ············································· 6 · 30 j ┐ │
│ │ [icône][photo] Colomiers      29 j            [Assigner]  │ [..] ligne …    │ │
│ │ [icône][photo] La bulle       dim. 25         [Assigner]  │ [..] ligne …    │ │
│ └───────────────────────────────────────────────────────────────────────────┘ │
│ [‹] 13 → 26 oct. [›] [Aujourd'hui]                       [Modifier les gardes] │
│            ma13 me14 je15 ve16 sa17 di18 …                                     │
│ [photo] Cœur de vie 23                                                         │
│   (RÉ) Régina   ███████████(●)███████(●)████████████████                       │
│ [photo] Colomiers                                                              │
│   (LO) Lola     ░░░░░░░░░░ Personne (+) ░░░░░░░░░░░░░░░░                       │
│ [photo] Ofuro Futari                                                           │
│   (LE) Lena     █(◐)█      █(!)█       ████████      █(●)█                     │
│   (TI) Tiphaine     ████(●)     ██(●)(●)       ███          ████(●)            │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Bulle « À traiter »

Le **seul moment ambre** de l'écran. Fenêtre : aujourd'hui → J+30 (sauf « Non terminé » et
« Mauvais retour », qui regardent en arrière : J-30 → hier).

Une seule liste, deux colonnes sur desktop. Une ligne = **icône du type** (nom du type en
infobulle) · **photo de couverture du bien** · nom du bien · date (· prestataire) · **un bouton**.

| Type | Icône | Règle (faits comptés) | Bouton → action |
|---|---|---|---|
| Sans personnel | bouclier barré rouge | bien × jour sans aucune prestataire de garde/disponible. **Une ligne par bien**, avec le nombre de jours | Assigner → édition des gardes du bien, positionnée sur le 1er jour sans garde |
| Non assigné | cercle pointillé gris | ménage sans prestataire | Assigner → fiche ménage, sélecteur prestataire |
| Non pris | cercle pointillé rouge | ménage assigné, pas encore accepté par la prestataire (statut PWA — **à confirmer, Q2**) | Réassigner → fiche ménage |
| Non terminé | horloge rouge | date passée, pas marqué fait | Fait → écriture serveur (D1) + toast « Annuler » |
| Mauvais retour | pouce bas rouge | commentaire classé « mauvais retour ménage » par le classement existant (**Q3**) | Voir → le commentaire et le ménage concerné |

- Tri : Sans personnel, Non assigné, Non pris, Non terminé, Mauvais retour ; puis par date.
- Badge ambre de l'onglet Ménages = nombre de lignes de la bulle.
- Plus de 8 lignes : 8 affichées + « Tout voir (n) ».
- Rien à traiter : la bulle se réduit à une ligne blanche avec coche verte, sans ambre.

### 3.2 Calendrier

- **Période** : 14 jours, flèches ‹ ›, bouton « Aujourd'hui ». Clic sur la période → sélecteur
  de mois (remplace le mini-calendrier de l'ancienne page).
- En-tête des jours : jour abrégé + numéro ; aujourd'hui en pastille noire ; week-ends teintés.
- **Un bloc par bien** : photo de couverture (52 px, rayon 10) + nom. Biens filtrables
  avec les mêmes bulles que le Calendrier (biens masqués en bulles en bas).
- **Une ligne par prestataire assignée au bien** (avatar initiales + prénom) :
  - **barre** de la couleur de la prestataire sur les jours où elle est de garde/disponible
    pour ce bien ; jours consécutifs = une barre continue ;
  - **pastille balai** sur la barre les jours où un ménage lui est assigné.
- Ligne « Sans prestataire » (avatar « ? » pointillé) **uniquement si** un ménage du bien
  n'a personne.
- Jours où **personne** n'est de garde : barre **rouge hachurée « Personne »** + bouton « + »
  (→ édition des gardes).
- États de la pastille :

| État | Rendu |
|---|---|
| Pris (à faire) | pastille blanche, ombre légère, balai noir |
| En cours | pastille noire, balai blanc |
| Fait | pastille verte, coche blanche |
| Non pris | fond rouge pâle, bord rouge pointillé, « ! » |
| Non assigné | bord gris pointillé, balai gris |

- **États hérités du Planning de garde, à conserver** : « jours à régler » et
  « prestataire désactivée ». Rendu proposé : désactivée = barre grise hachurée ;
  jours à régler = petit « € » gris en haut de la case, jamais ambre (**Q4**, sens exact
  à confirmer par l'inventaire).
- Clic pastille → **fiche ménage** (existante) qui affiche en tête les **étapes** du ménage :
  Pris → Arrivée (heure) → Ménage → Photos → Terminé (**Q1** : aligner sur les vraies actions
  de la PWA). Clic sur une barre ou « + » → édition des gardes.
- Légende en icônes sous le calendrier.

## 4. Mobile (< 900 px)

1. Titre + icônes Gardes / Prestataires.
2. Bulle « À traiter » en **5 compteurs** (icône + chiffre) ; un appui ouvre la liste du type.
3. Calendrier 7 jours, défilement horizontal pour la suite ; bloc par bien (photo 34 px),
   une ligne par prestataire (barres + pastilles), barre « Personne » rouge.
4. Barre du bas sur fond noir (onglet Ménages actif).

Touch targets ≥ 44 px (la pastille de 20 px a une zone de clic de 44 px).

## 5. Données et endpoints

| Besoin | Source | Remarque |
|---|---|---|
| Ménages de la période | `api/menages.js` (existant) | ajouter le filtre `from`/`to` si absent |
| Gardes / affectations par bien | `api/garde.js` (existant) | une ligne par prestataire assignée au bien |
| Disponibilités | `api/disponibilites.js` (existant) | « Sans personnel » = ni garde ni dispo |
| Statut pris / en cours / fait / étapes | statuts écrits par la PWA (existant) | **une seule source** partagée hôte + PWA (D1) |
| Mauvais retours | classement existant (Q3) | lecture seule |
| Photo du bien | photo de couverture (lot photos, en prod) | repli : initiales du bien |

Règles : `X-Compte` sur chaque appel ; périmètre revalidé serveur ; aucun appel provider
depuis la page ; un seul writer par domaine ; profil `menages = read` → boutons absents du DOM.

## 6. Arbitrages des points D de l'inventaire

- **D1 « Marquer fait » en localStorage** → remplacé par une **écriture serveur unique**,
  la même que la PWA. Le statut est vu par tous les appareils et par la prestataire.
  Migration : ignorer l'ancien localStorage (pas de reprise).
- **D2 XSS dans la PWA** (nom du voyageur, consigne non échappés) → corrigé **en premier**,
  dans ce lot, avec test (règle 19 : le test échoue sur l'ancien code).
- **D3 CLAUDE.md 3.4/3.5** → CLAUDE.md corrigé pour décrire l'existant (écran de garde présent).
- **D4 i18n absente** → toutes les chaînes de la nouvelle page en `menages.*` ; PWA dans un
  lot suivant.
- **D5 ancienne charte** → la nouvelle page est 100 % V5 (`theme.css`, `ui.css`, sprite).
- **D6 création / suppression d'une prestataire réservées au titulaire** → conservé.

## 7. Couleurs

Ambre : uniquement la bulle « À traiter » et le badge de navigation. Rouge : non pris,
non terminé, sans personnel, mauvais retour. Vert : fait. Noir : en cours et navigation.
Couleurs des prestataires : pastels définis dans `theme.css` (jamais d'hexa dans la page).

## 8. i18n

Préfixe `menages.*` : types de la bulle, boutons (Assigner, Réassigner, Fait, Voir, Tout voir),
états des pastilles, « Personne », « Sans prestataire », « Modifier les gardes », étapes,
libellés de la légende, infobulles. Dates et jours via `Intl`.

## 9. Tests attendus

- Règles V5 (aucun hexa, aucun emoji, aucune icône dessinée hors sprite, clés i18n présentes).
- « Sans personnel » : un bien sans garde sur J+3 apparaît ; avec garde, disparaît.
- « Fait » côté hôte → visible dans la PWA (même source) ; « Annuler » = écriture inverse.
- Une ligne par prestataire assignée ; ligne « Sans prestataire » absente si inutile.
- Profil `menages = read` : aucun bouton d'action dans le DOM.
- PWA : nom de voyageur `<img onerror=…>` affiché comme texte (D2).
- Mobile 390 px : pas de défilement horizontal de la page (seul le calendrier défile).

## 10. Ordre de livraison

0. Correctif D2 (XSS PWA) — seul, poussé à part.
1. Page en lecture seule : calendrier (blocs, lignes prestataires, barres, pastilles, « Personne »).
2. Bulle « À traiter » + badge de navigation.
3. Actions : Fait (écriture serveur D1), Assigner, Réassigner, Voir ; fiche ménage avec étapes.
4. Redirection des anciennes pages Ménages et Planning de garde ; CLAUDE.md (D3).

Chaque étape : desktop + mobile, i18n-check vert, `/code-review high`, preview avec mes
données, recette de Thierry, puis prod.

## 11. Questions ouvertes (réponse de Claude Code avant l'étape concernée)

- **Q1** Étapes réelles d'un ménage dans la PWA (les 11 actions) → lesquelles s'affichent.
- **Q2** Définition exacte de « non pris » (statut, délai).
- **Q3** Classement des retours ménage : source, méthode, stockage, rattachement au ménage.
- **Q4** Sens de « jours à régler » dans le Planning de garde.

## 12. Tableau de conformité (à produire par Claude Code)

| Fonction de l'inventaire | Où aujourd'hui | Où demain | Statut |
|---|---|---|---|
| … | … | … | conservée / déplacée / retirée (motif) |

Retraits proposés par cette spec, à valider par Thierry : compteurs « ménages cette semaine /
effectués / restants » (remplacés par la bulle et les pastilles) ; vue en colonnes par jour
(remplacée par le calendrier par bien) ; nom du voyageur sur la carte (déplacé dans la fiche).

## 13. Décisions du design sur les parties E et F de l'inventaire (13 octobre 2026)

Ces décisions FONT FOI sur les sections précédentes en cas de divergence.

- **Q1 / étapes** : la fiche ménage affiche les trois étapes réellement
  enregistrées — **Proposé → Pris → Fait** — avec date et heure
  (`offered_at`, `accepted_at`, `menage_done.done_at`). La frise
  Arrivée / Ménage / Photos et la pastille « En cours » (§3.2) sont
  RETIRÉES ; elles deviennent un futur chantier PWA (backlog).
- **Q2 / non pris** : définition de l'inventaire retenue ; un ménage porté
  pendant qu'une proposition court est « pris » ; un différé n'entre jamais
  dans la bulle. **Pastille rouge dès que le ménage n'est pas pris** ; la
  bulle, elle, ne l'affiche que s'il n'y a **plus de preneur possible**
  (tous les rangs ont refusé ou laissé expirer) OU si le départ est à
  **moins de 48 h**. Une offre qui court normalement n'est pas une alerte.
- **Q3 / retours** : « Mauvais retour » = verdict « remarque » confirmé par
  un humain. Le **👍 positif est conservé** : un ménage fait porte un badge
  vert si le retour est bon, rouge s'il est mauvais. Seuls les mauvais
  retours entrent dans la bulle.
- **Q4 / jours à régler** : engrenage gris sur la ligne de la prestataire,
  jamais « € » ; clic → sa fiche, section des jours ; n'entre pas dans la
  bulle.
- **Note pour la prestataire** : la fiche ménage V5 la reconstruit à
  l'identique (mêmes writers, même envoi, même message « non transmise »).
  **Bloquant de l'étape 3.**
- **Édition des gardes** : aucun nouvel écran dans ce lot ; les gardes se
  règlent dans la fiche de chaque prestataire. Clic sur le prénom ou
  l'avatar d'une ligne → fiche de la prestataire. « Assigner » sur
  « Sans personnel » → liste des prestataires du compte, puis la fiche
  choisie. Le bouton « Modifier les gardes » est RETIRÉ.
- **Sans personnel** : exclut les biens sans aucune prestataire (décision du
  3 septembre) — pas de rouge, le bloc du bien n'affiche aucune ligne.
- **Sans `prestataires:read`** : avatars neutres numérotés (P1, P2), sans
  prénom ; recherche par nom désactivée.
- **Remplaçante** : le ménage apparaît sur la ligne de la remplaçante ; si
  elle n'est pas assignée au bien, une **ligne temporaire** est ajoutée pour
  la période.
- **Deux ménages, même jour, même ligne** : une seule pastille avec « 2 » ;
  clic → la liste.
- **Noms longs** : nom du bien sur une ligne avec « … », complet au survol ;
  prénom seul sur la ligne d'une prestataire.
- **Boutons** : chaque bouton suit SON droit (« Fait » = `menages:write` ;
  « Assigner / Réassigner » = `prestataires:write` ; « Voir » = `avis:read`) ;
  non autorisé = absent du DOM, pas grisé.
- **Recommandations de l'inventaire appliquées pour le reste** (E.4) :
  liste incomplète (`tronque`) = bandeau visible comme l'ancien Planning ;
  badge de navigation alimenté comme `pendingMessages` (précisé à
  l'étape 2) ; détail du jour agrégé remplacé par la fiche ménage.
