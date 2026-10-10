# Kit UI HôteSmart — socle V5

Base de départ pour le lot 1 de la refonte (voir `docs/specs/spec-refonte-ui-v5.md`).

```
shared/
  theme.css        ← LA charte : couleurs, police, rayons. Seul fichier avec des hexas.
  ui.css           ← composants (boutons, cartes, onglets, tuiles, barre mobile). Que des var(--…).
  icons.svg        ← sprite d'icônes, nommées par sens (i-arrival, i-key…).
  logo.svg         ← le « ô ».
  nav.js           ← construit la navigation (5 entrées) + le sélecteur de langue.
  i18n/
    langues.json   ← liste des langues → sélecteur construit automatiquement
    fr.json        ← référence
    en.json, es.json
    i18n.js        ← t(), pluriels, dates/montants via Intl
pages/
  aujourdhui.html  ← page « Aujourd'hui », exemple complet qui utilise tout le socle
scripts/
  i18n-check.js    ← clés manquantes par langue (à lancer avant commit)
  i18n-new.js      ← crée une langue : node scripts/i18n-new.js it "Italiano"
```

## Trois règles vérifiables

1. **Aucun hexa hors `theme.css`** : `grep -rE '#[0-9A-Fa-f]{6}' pages/ shared/ui.css shared/nav.js` → vide.
2. **Aucun texte en dur** : tout passe par `data-i18n` ou `I18n.t()`.
3. **Aucun SVG dessiné dans une page** : `<use href="/shared/icons.svg#…">` uniquement.

## Tester en local

```
npx serve .    # ou vercel dev
open http://localhost:3000/pages/aujourdhui.html
```

Changer de langue : `I18n.set('en')` dans la console, ou ajouter le sélecteur
`HSNav.renderLangSelector(container)` dans le menu ≡.

## Ce qui reste à brancher

- Les données : les listes `data-list="events|pending|done|properties"` sont des
  modèles statiques à générer depuis le cœur (`bookings_snapshot`, `menage_events`,
  `message_sent_log`, `ota_reviews`).
- La préférence de langue sur le profil (`I18n.set` → appel serveur).
- Les photos des logements (`<img src>` vide pour l'instant).
- La formule de la barre d'autonomie, ou la retirer (spec §4).
