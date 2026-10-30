# Charte UI HôteSmart — restitution de l'existant

**Relevé le 30 octobre 2026**, branche `yf-ecran-periodes`. Document de
**lecture** : chaque valeur est citée avec son fichier et sa ligne. Aucune
proposition, aucune correction. Ce qui n'est pas défini est écrit comme tel.

⚠ **LIRE D'ABORD : L'APPLICATION A DEUX SOCLES, PAS UN.**

| socle | fichiers | pages qui le chargent |
|---|---|---|
| **V5** | `shared/theme.css` + `shared/ui.css` | `pages/*` (dont `aujourdhui.html` — la page « Bonjour » —, `calendrier.html`, `messages.html`, `menages.html`) |
| **Legacy** | `public/style.css` | `apps/yield/*` (dont `prix.html`, `marche-global.html`), `pages/connexions.html`, et les écrans antérieurs à V5 |

Les deux jeux de jetons **portent des noms identiques avec des valeurs
différentes** (`--border`, `--amber`). Une page charge l'un **ou** l'autre,
jamais les deux. Détail en §9.

---

## 1. Couleurs — socle V5 (`shared/theme.css`)

| rôle | jeton | valeur | ligne |
|---|---|---|---|
| fond de page | `--surface` | `#FFFFFF` | 31 |
| fond des pastilles d'icône | `--surface-2` | `#F7F7F7` | 32 |
| séparateurs | `--line` | `#EBEBEB` | 29 |
| bordures cartes et boutons secondaires | `--border` | `#DDDDDD` | 30 |
| texte principal | `--ink` | `#222222` | 24 |
| texte secondaire | `--muted` | `#717171` | 25 |
| texte tertiaire | `--muted-2` | `#9B9B9B` | 26 |
| texte sur fond `--ink` | `--on-ink` | `#FFFFFF` | 33 |
| inactifs sur fond `--ink` | `--on-ink-muted` | `#A3A3A3` | 36 |
| logo, avatar | `--brand-night` | `#0E1726` | 35 |
| bleu (liens, information) | `--info` | `#2563EB` | 67 |
| ambre | `--amber` | `#F5A524` | 38 |
| ambre, fond | `--amber-soft` | `#FFF4E0` | 39 |
| ambre, texte lisible sur blanc | `--amber-text` | `#B87500` | 40 |
| vert | `--ok` | `#0F7A4F` | 70 |
| vert, fond | `--ok-soft` | `#E8F5EE` | 71 |
| avertissement | `--warn` | `#9A5B00` | 72 |
| avertissement, fond | `--warn-soft` | `#FFF4E0` | 73 |
| danger | `--danger` | `#B42318` | 74 |
| danger, fond | `--danger-soft` | `#FEF0EE` | 75 |
| vert **en texte** | `--ok-ink` | `#0F7A4F` clair · `#4ADE80` sombre | 95 / 160 |
| danger **en texte** | `--danger-ink` | `#B42318` clair · `#F87171` sombre | 96 / 161 |

⚠ **`--ok-ink` ET `--danger-ink` EXISTENT POUR UN DÉFAUT DE CONTRASTE, et les
omettre était le constat le plus dangereux de la review sur ce document.**
`--ok` et `--danger` rendent **3,44:1** et **2,80:1** sur `--surface` sombre,
donc **sous le 4,5:1** requis pour du texte ; le dépôt a cessé de s'en servir
comme couleur de texte le 28 octobre 2026 et a posé ces deux-là à la place,
avec leur mesure en commentaire. Une maquette alignée sur un relevé qui les
tait reprendrait exactement les deux couleurs écartées.

⚠ **« Le noir des boutons pleins » N'EXISTE PAS EN V5.** Commentaire de
`shared/ui.css` : « Retouche charte du 11 octobre 2026 : le fond noir
(`--ink`) est réservé à la NAVIGATION (`.bottombar`, `.tab[aria-current]`). Un
bouton principal se distingue par son BORD `--ink`, comme l'outline. » Le fond
`--ink` n'apparaît donc que sur un onglet actif, un filtre actif et la barre du
bas. Le bouton plein noir existe dans le socle **legacy** — voir §2.

**Fonds de prestataire** (planning ménages), `shared/theme.css` :
`--presta-1` `#DDE4E6`, `-2` `#E3EADF`, `-3` `#E4E2F0`, `-4` `#F1E6DA`,
`-5` `#DCE8EF`, `-6` `#DFEAE5`, `-7` `#E8E7E2`, `-8` `#E2E6EE`.

**Ombres et voile**, `shared/theme.css` :
`--shadow-hover: 0 6px 20px rgba(0, 0, 0, .12)` ·
`--shadow-dot: 0 1px 3px rgba(0, 0, 0, .18)` ·
`--shadow-sheet: 0 -8px 32px rgba(0, 0, 0, .18)` ·
`--scrim: rgba(0, 0, 0, .45)`.

## 2. Couleurs — socle legacy (`public/style.css`)

| rôle | jeton | valeur | ligne |
|---|---|---|---|
| fond de page | `--bg` | `#FFFFFF` | 18 |
| fond secondaire | `--bg2` | `#F5F5F3` | 19 |
| fond tertiaire | `--bg3` | `#EFEFED` | 20 |
| texte principal | `--text` | `#1A1A1A` | 21 |
| texte secondaire | `--text2` | `#6B6B6B` | 22 |
| texte atténué | `--text3` | `#9B9B9B` | 23 |
| bordure | `--border` | `rgba(0,0,0,0.1)` | 24 |
| bordure appuyée | `--border2` | `rgba(0,0,0,0.2)` | 25 |
| vert | `--green` | `#1D9E75` | 26 |
| vert, fond | `--green-bg` | `#E1F5EE` | 27 |
| ambre | `--amber` | `#BA7517` | 28 |
| ambre, fond | `--amber-bg` | `#FAEEDA` | 29 |

⚠ **ET TROIS JETONS QUE CE DOCUMENT A D'ABORD ANNONCÉS ICI N'Y SONT PAS —
relevé en review, et la cause vaut d'être écrite.** `--blue` (#2563EB),
`--prune` (#5B2A86) et `--prune-bg` (#F0E9F6) ont été posés par le lot
`yf-ecran-periodes`, qui est dans **`staging`** et **pas dans `main`**. La
première version de ce document a été **relevée sur cette branche-là puis
écrite dans un lot parti de `main`** : trois jetons annoncés avec leur numéro
de ligne, introuvables partout. Un designer qui aurait aligné une maquette sur
`--prune` l'aurait découvert au branchement.

**La leçon, et elle est générale : un relevé appartient à l'arbre où il a été
fait.** Le présent document est mesuré sur un arbre parti de `main`
(`07ee3870`). Ce qui vit dans `staging` et pas encore dans `main` n'y figure
pas — et le dire est la seule façon de ne pas refaire la même erreur.

**Bouton plein noir, legacy** : `.btn-primary` (`public/style.css`) —
`background: var(--text)` soit `#1A1A1A`, `color: var(--bg)` soit `#FFFFFF`,
`border-color: var(--text)`. Survol : `opacity: 0.85` .

⚠ **Aucune couleur de danger ni de rouge n'est définie en jeton dans ce
socle.** Les rouges y sont des hexas en dur dans les pages
(`#B02A37`, `#842029`, `#FDECEA` dans `apps/yield/prix.html`, non jetonnés).

## 3. La palette des cinq niveaux YieldFlow

⚠ **ÉLÉMENT DE STRUCTURE** — décision de Thierry du 29 octobre 2026 : échelle
commune à toute restitution de prévision, **jamais modifiée ni substituée sans
sa double validation**. Raisons et portée : `docs/kb/charte-ui.md` §3.

| niveau | fond | accent | classe |
|---|---|---|---|
| Base | `#E7F0F7` | `#4A7FA8` | `n-base` |
| Moyen | `#EDF4EE` | `#5F8F6E` | `n-moyen` |
| Haut | `#FBF4E2` | `#C89A2E` | `n-haut` |
| Très haut | `#FAEADA` | `#D2762E` | `n-tres-haut` |
| Exceptionnel | `#F8E2DA` | `#BF4F32` | `n-exceptionnel` |

⚠ **CES DIX VALEURS SONT DÉSORMAIS DES JETONS, ET DANS UN SEUL FICHIER** :
`public/style.css`, jetons `--yf-base` … `--yf-exceptionnel-l`. C'est le lot du
30 octobre 2026 qui l'a fait. Avant lui elles étaient des **hexas en dur,
recopiés quatre fois** :

| endroit | ce qu'il porte |
|---|---|
| `apps/yield/prix.html` | fond **et** accent (`box-shadow: inset 3px 0 0`) |
| `apps/yield/prix.html` | fond seul (`.yp-niv-badge.n-*`) |
| `apps/yield/prix.html` | fond seul (`.yp-niv.n-*`) |
| `apps/yield/marche-global.html` | jetons `--yf-base`, `--yf-base-l`, … |

Les quatre copies **concordaient**, ce qui est la situation dangereuse : rien
ne rougissait, et la cinquième aurait divergé. Elles sont maintenant des
renvois (`var(--yf-*)`), et `tests/palette-niveaux.test.js` épingle les dix
valeurs ET refuse toute déclaration non nommée, dans n'importe quel fichier.

⚠ **ET LE TEST A ÉTÉ RÉÉCRIT APRÈS UNE REVIEW QUI L'A DEFAIT.** Sa première
version écartait un fichier **en bloc** : dix redéclarations divergentes
insérées dans `apps/yield/marche-global.html` laissaient les quatre tests au
vert. Une exception accordée à un FICHIER ouvre la porte à tout ce que ce
fichier contient — la table nomme donc maintenant chaque couple
(jeton, valeur).

**Texte sur ces fonds** : `.yp-niv-badge` (`apps/yield/prix.html`) ne
déclare **aucune couleur de texte** — le texte hérite de `--text` (`#1A1A1A`).
Seules deux classes la surchargent : `.yp-niveau.hausse` → `#0F7B3E` et
`.yp-niveau.baisse` → `#B02A37` , hexas en dur.

**Forme du badge** : `font-size: 10px`, `padding: 2px 8px`,
`border-radius: 4px`, `border: 0.5px solid rgba(0,0,0,.08)` .
Variante `.yp-niveau.yp-niv-badge` : `padding: 1px 7px`, `border-radius: 10px`
.

## 3 bis. L'échelle « température du marché » (4 niveaux, distincte)

`shared/temperature-calendrier.js`, injectée par le module. **Seule
échelle du dépôt qui déclare aussi sa couleur de texte.**

| niveau | fond | texte |
|---|---|---|
| creux | `#E8EEF7` | `#1C2B44` |
| modéré | `#B9CCE9` | `#1C2B44` |
| favorable | `#6F97D3` | `#1C2B44` |
| pic | `#1E3F73` | `#FFFFFF` |

Variante sombre déclarée  : `#1D2735`, `#2C4466`, `#446EAE`,
`#A9C4EF`, avec textes `#C9D6EA`, `#E3ECF8`, `#FFFFFF`, `#0F1D33`.

## 4. Couleurs de canal

**Les jetons** (`shared/theme.css`) :

| canal | jeton | valeur |
|---|---|---|
| Airbnb | `--canal-airbnb` | `#FF5A5F` |
| Booking | `--canal-booking` | `#003580` |
| Direct | `--canal-direct` | `#0E1726` |
| texte sur canal | `--on-canal` | `#FFFFFF` |

**Ce que le calendrier utilise réellement** (`shared/ui.css`) :

| classe | `--coul` | valeur effective |
|---|---|---|
| `.cal-barre--airbnb` | `var(--canal-airbnb)` | `#FF5A5F` |
| `.cal-barre--booking` | `var(--info)` | `#2563EB` |
| `.cal-barre--direct` | `var(--ok)` | `#0F7A4F` |
| `.cal-barre--blocage` | — | fond `var(--surface-2)` `#F7F7F7`, texte `var(--ink)`, italique, bordure `1px solid var(--border)` |

⚠ **`--canal-booking` et `--canal-direct` ne servent QUE dans la messagerie**
(`.conv__canal--*`, `shared/ui.css`). Le calendrier peint les mêmes
canaux avec `--info` et `--ok`. Voir §9.

⚠ **La couleur est assombrie au rendu** :
`background: color-mix(in srgb, var(--coul) 82%, black)` (`shared/ui.css`).
La valeur peinte n'est donc pas la valeur du jeton. La légende, elle, utilise
`--coul` **pur** (`.cal-legende__pt`,  ; `.cal-ligne-resa__point`,
.

## 5. Mode sombre — ce qui existe, et où il manque

| socle / module | mécanisme | couverture |
|---|---|---|
| `shared/theme.css` | `:root[data-theme="dark"]` **seulement** | 16 jetons redéfinis |
| `shared/temperature-calendrier.js` | `prefers-color-scheme` **ET** `[data-theme="dark"]` | les 4 niveaux + leurs textes |
| `apps/yield/marche-global.html` | `prefers-color-scheme` **ET** `[data-theme="dark"]` | 4 fonds sur 5 |
| `public/style.css` | **aucun** | néant |
| `apps/yield/prix.html` | **aucun** | néant |

⚠ **`data-theme` N'EST POSÉ PAR AUCUN CODE DU DÉPÔT.** Balayage complet des
`.js` et `.html` : la seule occurrence hors feuilles de style est une assertion
de test (`tests/marche-temperature-page.test.js`). La variante sombre de
`shared/theme.css` est donc **déclarée et jamais activée**.

⚠ **ET L'ASYMÉTRIE REND UN ÉCRAN ILLISIBLE, pas seulement incohérent — relevé
en review.** Sur `apps/yield/marche-global.html`, en préférence système sombre,
les quatre fonds de niveaux passent à `#1D2A36`…`#3A2717` tandis que
`.mg-niv-l` garde `color: var(--text)` = `#1A1A1A`, parce que
`public/style.css` n'a **aucun** bloc sombre. Contraste ≈ **1,1:1** : les
quatre lignes de « En résumé » y sont illisibles. C'est préexistant ; le lot du
30 octobre 2026 ne l'aggrave pas, mais la première règle qui utilisera
`--yf-exceptionnel` sur cet écran ajoutera un cinquième cas, en pâle et sans
surcharge sombre.

⚠ **`shared/theme.css` n'écoute PAS `prefers-color-scheme`.** Un seul fichier du
dépôt contient cette règle : `apps/yield/marche-global.html`. Donc chez un hôte
en préférence sombre, les quatre fonds de niveaux de cet écran passent au
sombre tandis que le reste de la page reste clair.

## 6. Typographie

⚠ **« Outfit » n'existe nulle part dans le dépôt** (balayage `.css` et `.html` :
zéro occurrence).

| socle | famille | source |
|---|---|---|
| V5 | `'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif` | `shared/theme.css`, appliquée par `shared/ui.css` |
| legacy | `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif` | `public/style.css` |

**Chargement** : `fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800`
dans `pages/aujourdhui.html` et `pages/calendrier.html`. **`apps/yield/prix.html`
ne charge aucune police** (vérifié : 0 occurrence de `fonts.googleapis`).

**Tailles** (`shared/theme.css`) :

| rôle | jeton | desktop | ≤ 720 px |
|---|---|---|---|
| titre de page | `--fs-h1` | `32px` | `26px` |
| titre de section | `--fs-h2` | `22px` | `20px` |
| chiffre clé | `--fs-kpi` | `28px` | `24px` |
| corps | `--fs-body` | `15px` | inchangé |
| libellé secondaire | `--fs-small` | `14px` | inchangé |
| petit texte | `--fs-caption` | `13px` | inchangé |
| navigation mobile | `--fs-nav-mobile` | `10px` | inchangé |

Surcharges mobiles : `shared/ui.css`.

**Graisses** (`shared/theme.css`) : `--fw-regular: 400`,
`--fw-medium: 500`, `--fw-semibold: 600`, `--fw-bold: 700`, `--fw-black: 800`.
**Interlettrage** : `--tracking-tight: -0.03em` .

⚠ **Aucune hauteur de ligne n'est jetonnée.** Les `line-height` sont posés au
cas par cas dans les règles (`.bulle` : `1.45`, `shared/ui.css`). Il n'y a
pas de `--lh-*`.

⚠ **Le socle legacy n'a aucun jeton de taille ni de graisse** : les tailles y
sont écrites en dur (`.btn` : `font-size: 13px`, `font-weight: 500`,
`public/style.css`).

## 7. Formes et espaces

| rôle | jeton | valeur | source |
|---|---|---|---|
| boutons, badges, onglets | `--radius-pill` | `99px` | `theme.css` |
| cartes, photos | `--radius-card` | `16px` | `theme.css` |
| pastilles d'icône | `--radius-tile` | `12px` | `theme.css` |
| legacy, général | `--radius` | `8px` | `style.css` |
| legacy, grand | `--radius-lg` | `12px` | `style.css` |
| hauteur min cliquable | `--control` | `44px` | `theme.css` |
| hauteur grande | `--control-lg` | `48px` | `theme.css` |
| icône | `--icon-size` | `20px` | `theme.css` |
| icône grande | `--icon-size-lg` | `22px` | `theme.css` |
| trait d'icône | `--icon-stroke` | `1.75` | `theme.css` |
| espaces | `--gap-xs/-s/-m/-l/-xl` | `4 / 8 / 16 / 24 / 40px` | `theme.css` |
| marge de page | `--page-pad` | `48px` (→ `24px` ≤ 720 px) | `theme.css`, `ui.css` |
| largeur max du contenu | `--page-max` | `1200px` | `theme.css` |
| largeur sidebar legacy | `--sidebar-width` | `210px` | `style.css` |
| sidebar legacy repliée | `--sidebar-collapsed` | `48px` | `style.css` |

**Espacement entre cartes** : il n'y a pas de jeton dédié. `.card` porte
`gap: 12px` **en interne** (`ui.css`) ; l'écart entre cartes vient du
conteneur de chaque page (`.cal-page { gap: 12px }`, `ui.css`).

### Grille du calendrier principal (desktop)

| mesure | valeur | source |
|---|---|---|
| colonne de libellé (collante) | `--cal-col: 110px` | `ui.css` |
| largeur d'une colonne de jour | `46px` | `ui.css`, `531`, `532`, `545` |
| hauteur d'une case nuit | `--cal-nuit-h: 40px` | `ui.css`, `549` |
| hauteur de la piste réservations | `--cal-resas-h: 48px` | `ui.css` |
| gap entre colonnes | **aucun** — `border: 1px solid var(--line)` sur chaque case | `ui.css` |
| survol d'une case | `color-mix(in srgb, var(--info) 10%, var(--surface))` | `ui.css` |

⚠ **Il n'y a pas d'état « sélectionné » de case déclaré.** La seule règle d'état
est le survol ci-dessus, et elle exclut le passé
(`.cal-nuit:not(.cal-nuit--passe):hover`).

## 8. Composants — tels qu'ils sont faits aujourd'hui

### Bouton plein / bouton contour (V5, `shared/ui.css`)

| | |
|---|---|
| `.btn` | `height: var(--control)` 44px · `padding: 0 18px` · `border-radius: var(--radius-pill)` 99px · `font-size: var(--fs-small)` 14px · `font-weight: var(--fw-semibold)` 600 · `border: 1px solid transparent` |
| `.btn--primary` | fond `var(--surface)`, texte `var(--ink)`, bord `var(--ink)` |
| `.btn--secondary` | fond `var(--surface)`, texte `var(--ink)`, bord `var(--border)` |
| `.btn--outline` | fond `var(--surface)`, texte `var(--ink)`, bord `var(--ink)` |
| `.btn--icon` | `width: 44px`, `padding: 0` |
| `.btn--lg` | `height: 48px`, `padding: 0 20px`, `font-size: var(--fs-body)` |
| survol | `box-shadow: var(--shadow-hover)` |
| désactivé | `opacity: .5`, `cursor: not-allowed` (règles **après** `:hover`, ordre commenté comme déterminant) |

⚠ **`.btn--primary` et `.btn--outline` sont déclarés à l'identique** — mêmes
trois propriétés, mêmes valeurs. Voir §9.

**Lien** : `.link` — `font-weight: var(--fw-semibold)`,
`text-decoration: underline`. **Aucune couleur** : le lien hérite. Le bleu
`--info` n'est pas appliqué par `.link`.

### Pastille pill de filtre (« Tous / À valider »)

Ce sont des `.tab`, pas un composant propre. `pages/messages.html` :
`<button class="tab" data-filtre="tous" aria-pressed="true">`.

| | |
|---|---|
| `.msg-filtres` | `display: flex` · `gap: 6px` · `overflow-x: auto` · barre de défilement masquée (`ui.css`) |
| `.msg-filtres .tab` | `height: 36px` · `padding: 0 14px` · `font-size: var(--fs-small)` · `border: 1px solid var(--border)` · `flex: none`  |
| actif | `.tab[aria-pressed="true"]` → fond `var(--ink)`, texte `var(--on-ink)`, bord `var(--ink)`  |

**`.tab` générique** (`ui.css`) : `height: var(--control)` 44px ·
`padding: 0 18px` · `border-radius: var(--radius-pill)` ·
`font-size: var(--fs-body)` · `font-weight: var(--fw-medium)` · survol
`background: var(--surface-2)` · actif de navigation
`.tab[aria-current="page"]` → fond `var(--ink)`.

⚠ **Deux attributs d'état coexistent** : `aria-current="page"` (navigation) et
`aria-pressed="true"` (filtres, mode, période), chacun avec sa propre règle —
`ui.css`, `282`, `453`.

### Chip de niveau

Voir §3 : `.yp-niv-badge`, `font-size: 10px`, `padding: 2px 8px`,
`border-radius: 4px`, `border: 0.5px solid rgba(0,0,0,.08)`, fond par classe
`n-*`, **texte hérité**.

### Sélecteur de logement

⚠ **Il n'y a pas de composant partagé.** Trois formes distinctes :

| endroit | forme |
|---|---|
| `shared/ui.css` | seule règle globale : `button, input, textarea, select { font: inherit; color: inherit; }` — **aucune** forme, aucune bordure |
| `shared/ui.css` (volet IA) | `height: 38px` · `border: 1px solid var(--border)` · `border-radius: var(--radius-card)` · fond `var(--surface)` · `padding: 0 10px` · `font-size: var(--fs-body)` |
| `shared/ui.css` (bloc du volet) | `height: 36px` · même bordure et rayon · `padding: 0 8px` · `font-size: var(--fs-small)` |
| `public/style.css` (legacy, `.nav-compte-select`) | `width: 100%` · `padding: 6px 8px` · `font-size: 12px` · `border: 0.5px solid var(--border)` · `border-radius: var(--radius)` 8px |

Le sélecteur de `apps/yield/*` (`#yf-bien`, `#yp-bien`, …) est un `<select>` nu
sous le socle legacy : il n'a que la règle `.yf-champ select { min-width: 130px }`
(`apps/yield/index.html`) et aucune forme jetonnée.

### Barre de réservation du calendrier (`shared/ui.css`)

| mesure | valeur |
|---|---|
| hauteur | `38px`, `top: 5px` dans une piste de `48px` |
| rayon | `13px` ; `7px` pour `.cal-barre--blocage` |
| texte | `font-size: var(--fs-small)` 14px · `font-weight: var(--fw-semibold)` · `padding: 0 10px` |
| troncature | `overflow: hidden` · `white-space: nowrap` · `text-overflow: ellipsis` · `text-align: start` |
| couleur | `color-mix(in srgb, var(--coul) 82%, black)`, texte `var(--on-canal)` |
| bords coupés | `.cal-barre--coupe-g` / `--coupe-d` retirent le rayon du côté tronqué |
| position | `left: calc((var(--d) + .5) / var(--n) * 100%)` — décalée d'une demi-case (la nuit, pas le jour) |

Variante mobile `.cal-mbar`  : `height: 22px`, `border-radius: 11px`,
`font-size: var(--fs-caption)`, `padding: 0 7px`.

### Volet latéral (« Réponses de l'IA ») — `shared/ui.css`

| | |
|---|---|
| `.msg-tiroir` | `position: fixed` · `inset-block: 0` · collé au bord de fin · `width: min(360px, 100vw)` · fond `var(--surface)` · `border-inline-start: 1px solid var(--line)` · `box-shadow: var(--shadow-hover)` · `z-index: 40` · `overflow-y: auto` |
| en-tête | `padding: 16px 18px` · `border-bottom: 1px solid var(--line)` |
| sections | `margin: 16px 18px 4px` · `font-size: var(--fs-small)` · `font-weight: var(--fw-bold)` · `letter-spacing: var(--tracking-tight)` |
| blocs | `padding: 14px 18px` · `gap: 10px` · `border-bottom: 1px solid var(--line)` |

### Volet du bas sur mobile

⚠ **Il n'y a pas de composant « feuille du bas » générique.** Ce qui existe :

| | |
|---|---|
| le jeton | `--shadow-sheet: 0 -8px 32px rgba(0, 0, 0, .18)` (`theme.css`), commenté « feuilles du bas (PWA) » |
| le voile | `--scrim: rgba(0, 0, 0, .45)` (`theme.css`) |
| le volet ménages ≤ 899 px | `.men-volet { width: 100vw; border-inline-start: 0 }` et `.men-voile { display: none }` (`ui.css`) — il prend tout l'écran, ce n'est pas une feuille basse |

### Le menu YieldFlow du calendrier (`shared/ui.css`, lot du 28 octobre)

| | |
|---|---|
| bouton `.cal-yf` | `28×28px`, `border-radius: var(--radius-pill)` |
| actif `.cal-yf--on` | fond `var(--info)`, texte `var(--on-ink)`, `box-shadow: var(--shadow-dot)`, sans bordure |
| inactif `.cal-yf--off` | `border: 1px solid var(--border)`, fond `var(--surface)`, texte `var(--muted)` |
| ouvert | `outline: 2px solid var(--info)`, `outline-offset: 2px` |
| menu `.cal-yf-menu` | `position: fixed` · `z-index: 55` · `width: min(320px, calc(100vw - 2 * var(--page-pad)))` · `border-radius: var(--radius-card)` · `max-height: min(520px, 80vh)` |
| pastille d'état | `--on` : fond `var(--surface-2)`, point `7px` en `var(--ok)` · `--off` : fond `var(--surface-2)`, texte `var(--muted)` |
| ligne ambre | fond `var(--warn-soft)`, texte `var(--warn)`, `border-radius: 10px` |

## 9. Mobile

**Points de rupture utilisés** (`shared/ui.css`) : `899px`, `720px` / `721px`,
`560px` / `561px`, plus `@media (hover: hover)` et
`@media (prefers-reduced-motion: reduce)`.

| rupture | ce qu'elle fait |
|---|---|
| `max-width: 899px` | volets en pleine largeur, planning ménages recomposé (`--cal-col: 0px`), identités collantes au-dessus de la piste |
| `max-width: 720px` | `--page-pad: 24px`, `--fs-h1: 26px`, `--fs-h2: 20px`, `--fs-kpi: 24px` ; bulles à `86%` ; actions en pleine largeur |
| `min-width: 721px` | `.only-mobile { display: none !important }` — **c'est le point de bascule des deux calendriers** |
| `max-width: 560px` | ajustements de la fiche logement |

### Le calendrier principal sous 700 px

⚠ **Ce n'est pas le calendrier desktop rétréci : c'est un autre composant.** La
bascule se fait par `.only-mobile` / `.only-desktop` à **721 px**.

| | desktop (≥ 721 px) | mobile (≤ 720 px) |
|---|---|---|
| structure | bande horizontale continue, `grid-auto-columns: 46px`, largeur `calc(var(--n) * 46px)` | grille de mois, `grid-template-columns: repeat(7, 1fr)`, `gap: 4px` (`ui.css`) |
| semaines | une seule piste | empilées, `gap: 4px` (`ui.css`) |
| largeur de colonne | **fixe, 46px** | **fluide, `1fr`** (≈ `(100vw − 48px − 6×4px) / 7`) |
| défilement horizontal | **oui** — la largeur totale dépasse la fenêtre dès ~20 jours | **non** |
| barre de réservation | `.cal-barre`, 38px / rayon 13px | `.cal-mbar`, 22px / rayon 11px |
| en-tête | — | `.cal-mois__tete` collant (`position: sticky; top: 0`), nav centrée, nom du mois `17px` capitalisé (`ui.css`) |

## 10. Écarts — définis à deux endroits avec des valeurs différentes

**Listés, non corrigés.**

| # | écart | valeurs | sources |
|---|---|---|---|
| 1 | **Deux socles complets** aux noms qui collisionnent | `--border` : `#DDDDDD` **vs** `rgba(0,0,0,0.1)` | `theme.css` / `style.css` |
| 2 | idem | `--amber` : `#F5A524` **vs** `#BA7517` | `theme.css` / `style.css` |
| 3 | idem | texte principal : `#222222` **vs** `#1A1A1A` | `theme.css` / `style.css` |
| 4 | idem | vert : `#0F7A4F` **vs** `#1D9E75` | `theme.css` / `style.css` |
| 5 | idem | rayon général : `16px` / `99px` / `12px` **vs** `8px` / `12px` | `theme.css` / `style.css` |
| 6 | **Deux typographies** | `Plus Jakarta Sans` **vs** police système | `theme.css` / `style.css` |
| 7 | **Canal Booking peint de deux couleurs** | `#003580` (messagerie) **vs** `#2563EB` (calendrier) | `ui.css` / `ui.css` |
| 8 | **Canal Direct peint de deux couleurs** | `#0E1726` (messagerie) **vs** `#0F7A4F` (calendrier) | `ui.css` / `ui.css` |
| ~~9~~ | ~~La palette des 5 niveaux recopiée 4 fois~~ — **FERMÉ le 30 octobre 2026** : source unique dans `public/style.css`, les 4 copies sont des renvois, un test épingle les 10 valeurs | — |
| ~~10~~ | ~~Le 5e niveau est incomplet côté marché~~ — **FERMÉ le 30 octobre 2026** : `--yf-exceptionnel` (le fond) existe désormais. ⚠ Il n'est encore utilisé par aucune règle de `marche-global.html`, dont la légende continue d'apparier « Très haut ou Exceptionnel » comme avant | — |
| 11 | **Mode sombre : deux mécanismes, et un seul fichier écoute l'OS** | `[data-theme]` seul **vs** `prefers-color-scheme` + `[data-theme]` | `theme.css` / `marche-global.html`, `temperature-calendrier.js` |
| 12 | **`data-theme` n'est posé par aucun code** | variante sombre déclarée, jamais activée | balayage `.js`/`.html` : seule occurrence hors CSS = `tests/marche-temperature-page.test.js` |
| 13 | **`.btn--primary` et `.btn--outline` identiques** | mêmes trois propriétés, mêmes valeurs | `ui.css` et `104` |
| 14 | **Deux attributs d'état pour `.tab`** | `aria-current="page"` **et** `aria-pressed="true"`, trois règles séparées | `ui.css`, `214`, `282`, `453` |
| 15 | **La couleur de canal peinte n'est pas la valeur du jeton** | barre : `color-mix(… 82%, black)` ; légende : `--coul` pur | `ui.css` vs `590`, `640` |
| 16 | **Pas de jeton de hauteur de ligne** | `line-height` en dur au cas par cas | `ui.css` (`1.45`) |
| 17 | **Pas de jeton de rouge dans le socle legacy** | `#B02A37`, `#842029`, `#FDECEA` en dur | `apps/yield/prix.html` |
| 18 | **`.link` ne porte aucune couleur** | le bleu `--info` n'est pas appliqué par la classe du lien | `ui.css` |
| 19 | **Pas d'état « sélectionné » de case** | seul le survol est déclaré | `ui.css` |
| ~~20~~ | ~~`apps/yield/prix.html` ne charge aucune police~~ — **FERMÉ le 30 octobre 2026** : six écrans YieldFlow chargent Plus Jakarta Sans (lien + `preconnect` + classe `police-v5`), et leurs contrôles de formulaire en héritent. `evenements.html` reste sans police : c'est une redirection | — |

## 11. Ce qui n'a PAS été mesuré

Dit plutôt que deviné :

- les hauteurs de ligne réelles au rendu (seules les déclarations ont été lues) ;
- les rapports de contraste (aucun calcul fait ; la seule échelle qui déclare
  son texte est celle de §3 bis) ;
- `pages/onboarding.html`, `apps/sms/*`, `apps/menages/prestataires.html` et
  les écrans antérieurs non cités ;
- la barre du bas mobile (`.bottombar`) au-delà de `display: none` au-dessus de
  899 px et du jeton `--fs-nav-mobile`.
