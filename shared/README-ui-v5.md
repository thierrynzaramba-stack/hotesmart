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
    i18n.modele.js ← t(), pluriels, dates/montants via Intl — MODELE : servi à
                     /shared/i18n/i18n.js par api/i18n.js, version posée au déploiement
pages/
  aujourdhui.html  ← page « Aujourd'hui », exemple complet qui utilise tout le socle
scripts/
  i18n-check.js    ← clés manquantes, EN TROP, ou EN DOUBLE (à lancer avant commit)
  i18n-new.js      ← crée une langue : node scripts/i18n-new.js it "Italiano"
```

## Trois règles vérifiables

1. **Aucun hexa hors `theme.css`** : `grep -rE '#[0-9A-Fa-f]{6}' pages/ shared/ui.css shared/nav.js` → vide.
2. **Aucun texte en dur** : tout passe par `data-i18n` ou `I18n.t()`.
3. **Aucun SVG dessiné dans une page** : `<use href="/shared/icons.svg#…">` uniquement.

## ⚠ UNE CLÉ DÉCLARÉE DEUX FOIS NE SE VOIT PAS À LA LECTURE

`JSON.parse` ne lève pas devant `{"a":1,"a":2}` : il garde la **dernière** et
rend `{a:2}`. Un contrôle qui parse est donc aveugle au doublon — et
`i18n-check.js` parsait. Mesuré le 21 octobre 2026 : un `nav.today` redit en fin
de `es.json` faisait rendre « ✓ es : 592 clés », **code de sortie 0**, avec le
compte INCHANGÉ, puisque le doublon avait déjà été écrasé avant d'être compté.

Les deux moitiés d'un doublon vivent en général dans deux sections différentes,
posées par deux lots. La traduction qui gagne est celle du bas, et ce n'est pas
forcément celle que son auteur relit à l'écran.

Le contrôle lit donc maintenant le **texte**, pas l'objet : `lireLesCles` suit
les chaînes, les échappements et les étages, et une clé n'est une clé que si un
`:` la suit **directement dans un objet** — ce qui écarte les valeurs qui
contiennent elles-mêmes des guillemets ou des deux-points. Il confronte ensuite
son compte à celui de `JSON.parse` : si les deux ne tombent pas d'accord, il
**refuse** au lieu de rendre « aucun doublon ». Un lecteur qui n'a rien vu doit
échouer, pas donner un vert.

Et le français est contrôlé lui aussi : l'ancien script faisait
`if (code === 'fr') continue` avant toute lecture, donc la langue de référence
était la seule qu'il ne regardait jamais.

`tests/i18n-doublons.test.js` tient tout ça, et
`tests/nav-i18n-cles.test.js` garde les **15 clés de `shared/nav.js`** — liste
DÉRIVÉE du fichier, jamais recopiée — dans les trois langues, plus les 6 clés
`nav.tool_*` de la section « Outils », qui sont la seule clé interpolée du
module et viennent de ses quatre appelants, eux aussi découverts et non listés.

⚠ **CE N'ÉTAIT PAS UN TERRITOIRE VIERGE, ET LA PREMIÈRE RÉDACTION DE CETTE
SECTION L'A DIT FAUX.** `tests/aujourdhui.test.js` boucle déjà sur
`shared/nav.js` et couvrait **14 des 15 clés — contre le français seul**. La
seule qu'il ne voit pas est `nav.language`, posée par
`setAttribute('data-i18n-attr', 'aria-label:nav.language')` : son motif est
ancré sur la forme attribut `data-i18n-attr="…"`. Ce que le lot ajoute
vraiment : cette 15e clé, **en et es** pour les 15, le refus d'une traduction
vide, et les clés interpolées comptées.

⚠ **ET LE PIÈGE QUE LA REVUE A TROUVÉ : LA CLÉ MIXTE.**
`data-i18n="nav.help_${variante}"` n'est ni statique (elle porte un `$`) ni
entièrement interpolée. Elle échappait aux deux filets, et aux deux comptes :
mesuré, une telle clé insérée dans `nav.js` laissait `nav-i18n-cles` à 6/6 et
`aujourdhui` à 28/28. Ce n'est pas une forme théorique — `pages/menages.html`
en livre déjà cinq. Le filet qui ne peut pas avoir de trou est la **somme** :
tout `data-i18n="` du fichier doit tomber dans l'un des deux comptes, et rien
d'autre. C'est la règle à reprendre pour le balayage de la dette 81.

## Tester en local

```
vercel dev
open http://localhost:3000/pages/aujourdhui.html
```

⚠ **Plus `npx serve .` seul** (5 novembre 2026) : `/shared/i18n/i18n.js` n'est
plus un fichier, c'est `api/i18n.js` qui le sert, et un serveur statique rend
404 — la page s'affiche sans aucun texte. `vercel dev` exécute la fonction. Un
banc local qui sert le dépôt en statique doit répondre à cette adresse avec
`require('./lib/i18n-version').moteurI18n()`.

## ⚠ LA VERSION DES DICTIONNAIRES SE CALCULE AU DÉPLOIEMENT

Les dictionnaires sont cachés un an, et leur URL porte une empreinte
(`fr.json?v=<empreinte>`) qui les invalide. Cette empreinte était écrite à la
main dans `i18n.js` : chaque lot qui touchait une traduction la changeait, et
deux lots parallèles entraient **toujours** en conflit sur cette ligne, pour une
valeur qu'aucun des deux n'avait juste. Depuis le 5 novembre 2026 (décision de
Thierry du 28 octobre), `api/i18n.js` sert le moteur avec l'empreinte des
dictionnaires déployés (`lib/i18n-version.js`, même algorithme qu'avant :
sha256 de tous les `.json` du dossier triés — aujourd'hui en, es, fr,
langues —, douze caractères ; une langue ajoutée y entre d'elle-même). **On ne touche plus à aucune
version** : on modifie un dictionnaire, et c'est tout.
`tests/i18n-version.test.js` appelle la fonction et mesure ce que le navigateur
reçoit.

**Case performance.** Aucune requête ajoutée : la page charge toujours
`/shared/i18n/i18n.js`, puis les dictionnaires en parallèle. Le moteur passe
par le CDN (`s-maxage=3600` et `stale-while-revalidate`, clé de cache par
déploiement) ; seule la première demande d'un déploiement, par région, attend
la fonction, les rafraîchissements suivants se font en arrière-plan. Le navigateur le
revalide comme il revalidait le fichier statique (`max-age=0`), et les
dictionnaires restent cachés un an. Empreinte inchangée pour des dictionnaires
inchangés : le déploiement de ce changement ne fait retélécharger aucun
dictionnaire.

Changer de langue : `I18n.set('en')` dans la console, ou ajouter le sélecteur
`HSNav.renderLangSelector(container)` dans le menu ≡.

## Ce qui reste à brancher

- Les données : les listes `data-list="events|pending|done|properties"` sont des
  modèles statiques à générer depuis le cœur (`bookings_snapshot`, `menage_events`,
  `message_sent_log`, `ota_reviews`).
- La préférence de langue sur le profil (`I18n.set` → appel serveur).
- Les photos des logements (`<img src>` vide pour l'instant).
- La formule de la barre d'autonomie, ou la retirer (spec §4).
