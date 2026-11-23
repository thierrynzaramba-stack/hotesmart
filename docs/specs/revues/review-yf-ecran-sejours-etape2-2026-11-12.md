# Review — 4b étape 2 : la page des séjours (12 novembre 2026)

- **Arbre lu** : `/home/claude/hotesmart-sejours` (worktree), rien hors de cet arbre.
- **Branche** : `yf-ecran-sejours` (HEAD `2c76ce0e94cafc471eb7e3069d0bfa4652a4220b`).
- **Plage** : `c8f37ba62b8f772ec4ed72c502382a81ce45a6dd..2c76ce0e94cafc471eb7e3069d0bfa4652a4220b`
  (un commit : « 4b étape 2 : la page — les séjours sous chaque nuit et les pastilles des années »).
- **Fichiers du diff (9)** :
  `apps/yield/evenements.html`, `docs/specs/spec-yf-ecran-evenements.md`,
  `shared/i18n/en.json`, `shared/i18n/es.json`, `shared/i18n/fr.json`,
  `shared/yield-evenements-rendu.js`, `shared/yield-evenements.css`,
  `tests/outils/banc-evenements.js`, `tests/yf-ecran-evenements-sejours-page.test.js`.

**Mesures.** Contre-épreuves sur une copie `git archive` du SHA dans `/tmp/review-4b`
(supprimée après), `node_modules` en lien. Suite du lot : 13/13. Fichiers voisins
(`yf-ecran-evenements*`, `budget-ecran`, `masquage-hidden`, `i18n-*`, `cache-ecran`,
`avis-cartes-i18n`, `nav-i18n-cles`) : 147/147. Horloge décalée J+30, 60, 200, 400 :
13/13. `scripts/i18n-check.js` : 1331 clés dans les trois langues.

## Sécurité : aucun constat

Vérifié : tout ce qui vient du serveur passe par `esc` (canal brut, années, prix,
délai, notes de pastille, message) ; `title` et `aria-label` échappés. Le PUT des
couches part sur `/api/ecran/evenements`, corps `{ couches: { eteintes } }` seul,
`X-Compte` porté (test du compte délégué) ; la ligne est désignée par le serveur
(session + garde). Le cache : `pourLeCache` retire `sejours` sur les deux chemins
d'écriture (chargement et clic) — le test 7 rougirait sans. Un écran peint depuis
le cache n'a pas de pile (test 10). Clé de cache (personne, compte), rechargement
au changement de compte.

## Constats

### 1. CORRECT — clics rapides : la base peut garder un choix plus ancien que l'écran et le cache
`apps/yield/evenements.html:606-631` (PUT l.617, garde l.620).

Deux clics (éteindre 2025, puis 2024) = deux PUT concurrents, `[n1]` puis
`[n1, n2]`. Rien n'ordonne leur arrivée (deux invocations serverless
indépendantes) : si le premier tombe sur une instance froide, son upsert passe
en dernier. `couchesSeq` ne protège que l'affichage : la page montre 2025 et
2024 éteintes, le cache aussi (écrit au succès du second), la base garde `[n1]`,
et aucun message. Visite suivante : le cache peint 2024 éteinte, le serveur la
rallume sous les yeux de l'hôte — ce que le commentaire l.621 veut éviter — et
le choix est perdu sans un mot.
Contre-épreuve au banc (premier PUT retardé de 30 ms, « dernier arrivé gagne ») :
page `[n1, n2]`, cache `[n1, n2]`, base `[n1]`, message `null`.
Même famille : un clic fait sur l'écran du cache AVANT la réponse du GET → `charger()`
(l.313) met en cache `d.couches`, lu avant le PUT.

**Correction** : un seul PUT en vol ; un clic pendant le vol marque « à renvoyer »,
et au retour on renvoie l'état COURANT s'il diffère de ce qui vient d'être écrit
(coalescence) ; le message d'échec ne vaut que pour le dernier envoi. Dans
`charger`, si `couchesTouchees`, mettre en cache `etat.couches` plutôt que `d.couches`.

### 2. CORRECT (CSS) — la pile n'est pas ancrée : les barres font des marches d'une case à l'autre
`shared/yield-evenements.css:188`, `shared/yield-evenements-rendu.js:702-709`.

La pile est le dernier enfant d'une colonne flex, juste après la tête, le corps et
les marques : sa hauteur de départ dépend du contenu de CHAQUE case. « Hors
période » (une ligne de 11 px) contre pastille + prix (deux lignes) ; ligne de
marques (« vendue », « réglé », ✎) présente ou non. Or la marque « vendue » est
posée exactement sur les nuits de cette année vendues : sous un séjour 2026, les
lignes 2025/2024/2023 descendent d'environ 15 px, et toute barre N-k qui traverse
le bord d'un séjour 2026 se casse en marche (les marges de −11 px rejoignent la
case voisine à une autre hauteur). Idem au bord d'aujourd'hui (cases « Hors
période » avec un séjour en cours). « Toujours présentes, pour que les cases
s'alignent » (§16.2) ne tient que si toutes les cases d'une rangée ont le même
contenu au-dessus. jsdom ne mesure rien : aucun test ne peut le voir.

**Correction** : `.yfe-pile { margin-top: auto; }` — les cases d'une rangée de grille
sont étirées à la même hauteur et les piles ont le même nombre de lignes de 22 px :
ancrées en bas, elles s'alignent. À regarder à la recette, ordinateur et téléphone.

### 3. CORRECT — l'année de « cette année » saute autour du 1er janvier
`shared/yield-evenements-rendu.js:587` (étiquette l.618, phrases l.600-611).

Ligne 0 = année CIVILE de la nuit affichée ; lignes N-k = année de l'OCCURRENCE
(serveur, constat 3 de l'étape 1). Vacances de Noël 2026-2027, lundi 4 janvier
2027 : étiquettes « 27 / 25 / 24 », nom accessible « 2027 · pas encore réservée ·
2025 · … » pour une nuit d'en face qui est le 5 janvier 2026 (vérifié :
`pileDeLaNuit('2027-01-04', …)` rend `[2027, 2025, 2024]`). Le lundi d'avant dit
« 26 / 25 / 24 », la pastille dit « 2025 ». C'est le saut que le constat 3 de
l'étape 1 a fermé côté serveur, rouvert côté page. Même chose autour du réveillon
(date fixe), dont le calendrier montre les 1er-3 janvier.

**Correction** : l'année de la ligne 0 = celle de l'occurrence ouverte, servie par
le serveur (p. ex. `evenements[].annee`, même règle qu'`alignerAnnee` : nuit
principale pour une date fixe, première nuit sinon) — la page ne la calcule pas.

### 4. CORRECT — une nuit bloquée dit « vendue » ET « pas encore réservée »
`shared/yield-evenements-rendu.js:584` et `:698`.

`vendue` (4a) vient de `nuitsOccupees` : confirmées ET blocages
(`lib/nuits-occupees.js:39`). La pile ne connaît que les confirmées (§16.2, voulu :
un blocage n'a pas de barre). Une nuit bloquée par l'hôte (dettes 63-64) rend
« mercredi 23 décembre · 2 · Moyen · 125 € · vendue · 2026 · pas encore réservée »
(vérifié au banc, `vendues: { '2026-12-23': ['blocage-1'] }`), et « — » sous la
marque « vendue ». Deux affirmations contraires dans la même case.

**Correction** : ligne 0 sans séjour mais `n.vendue` → un état propre (`occupee`),
sans « — », phrase neutre (« occupée, sans séjour vendu ») ou aucune ; « pas de
barre » tient.

### 5. CORRECT (mineur) — « Votre choix n'a pas pu être lu » reste affiché après un choix enregistré
`apps/yield/evenements.html:609` ; `shared/yield-evenements-rendu.js:660`.

Arrivée en `lisibles: false` ; l'hôte éteint 2025, le PUT réussit :
`etat.couches = { ...etat.couches, eteintes }` garde `lisibles: false`, et la carte
dit « toutes les années sont affichées » sous une pastille 2025 éteinte (vérifié
au banc). Après un échec, les deux phrases s'affichent ensemble.

**Correction** : `lisibles: true` dès le clic (le message d'échec dit le reste).

### 6. MINEUR (CSS) — les barres N-1 à N-3 sont transparentes : le bord de la case les raye, leur teinte change d'une case à l'autre
`shared/yield-evenements.css:195-197`, `:204`, `:226-228`.

`color-mix(…, transparent)` : par-dessus le bord de 2 px (`--ink` sur une nuit de
l'événement, tirets `--muted` au rayonnement), le trait reste visible à travers la
barre (40 % d'encre sur un bord d'encre = un trait plein) ; dans l'espace entre
cases on voit `--surface`, dans une case « hors » `--surface-2`. Le `z-index: 1`
ne règle le « raye la barre » que pour la barre opaque de cette année, et le
4,3:1 de §16.11 dépend du fond.

**Correction** : `color-mix(in srgb, var(--sejour) 60%, var(--surface))` (40 et 25
de même, pastilles comprises) : même rendu sur blanc, opaque, contraste fixe. En
sombre, sur `--surface` #141414 : 6,6:1 / 4,7:1 / 7,9:1.

### 7. MINEUR — délai 0 → « −0 j »
`shared/i18n/{fr,en,es}.json:1235` ; `shared/yield-evenements-rendu.js:629`.
Vérifié. **Correction** : branche `=0` (« J0 » / « same day » / « mismo día »), comme
la phrase longue `yfe.sejour_delai_long`.

### 8. MINEUR (i18n) — « Direct » traduit ou non selon la source
`shared/yield-evenements-rendu.js:596`.
Source `Offline` → `t('yfe.canal_direct')` (« Directo » en es) ; source `direct` →
`LIBELLE_CANAL.direct`, en dur « Direct ». Vérifié en es : deux réservations
directes, deux libellés. **Correction** : famille `direct` → `t('yfe.canal_direct')`
dans tous les cas ; `LIBELLE_CANAL` seulement pour les marques (Airbnb, Booking.com).

### 9. MINEUR (i18n) — trois libellés
`en.json:1225` « not played yet » (calque de « pas encore jouée » : « hasn't
happened yet ») ; `fr.json:1229` « séjour d’1 nuit » (branche `=1 {séjour d’une
nuit}`) ; `en.json:1229` « 3 night stay » (« 3-night stay »).

### 10. MINEUR — pastilles de 36 px, sous la cible tactile du projet
`shared/yield-evenements.css:219`. `--control: 44px` (« hauteur min d'un élément
cliquable », theme.css) ; les filtres de la même page la tiennent.
**Correction** : `min-height: var(--control)`.

### 11. MINEUR (a11y) — le message d'échec `role="status"` est réinséré à chaque repeint, toute la visite
`shared/yield-evenements-rendu.js:661`.
`couchesMessage` ne se vide qu'au clic suivant sur une pastille ; chaque toucher
de nuit, filtre ou ouverture repeint la liste en `innerHTML` et réinsère une région
vivante déjà remplie — selon le lecteur d'écran, elle est réannoncée.
**Correction** : annoncer une fois (région vivante persistante hors de la liste),
puis rendre un `<p>` sans rôle.

### 12. MINEUR (défense) — `recul` entre brut dans un attribut `class`
`shared/yield-evenements-rendu.js:650` et `:616`.
Seule valeur reçue de ce diff interpolée sans `esc` ni `Number`. Serveur (1 à 3) ou
cache local : rien d'exploitable aujourd'hui. Un recul inconnu rendrait aussi
`data-couche=""` et un PUT refusé en 400. **Correction** : ne garder que
`[1, 2, 3].includes(Number(a.recul))`.

### 13. MINEUR — la garde d'écriture du cache au clic n'est pas celle de `charger()`
`apps/yield/evenements.html:623` contre `:313`.
`charger` refuse (et EFFACE) une réponse sans `bien`, `indisponible` ou sans
`evenements` — constat de sécurité de l'étape 2 de 4a. Le clic réécrit `etat.data`
sans ce test. Aujourd'hui ils coïncident (pas de pastille sans événements), rien
ne le tient. **Correction** : une fonction `cachable(d)` commune aux deux chemins.

### 14. À regarder à la recette (non mesurable ici)
L'anneau de la nuit choisie (`[aria-pressed="true"]`, outline 3 px décalé de 2)
et l'anneau de focus passent SOUS les barres voisines (`z-index: 1`) qui traversent
l'espace entre cases (`css:165`, `:204`). Et le débordement de −11 px hors d'un
`<button>` sur Safari et Firefox.

## Tests

### 15. CORRECT (tests) — le cœur « date − décalage du serveur » passe aussi avec un recul codé en dur
`tests/yf-ecran-evenements-sejours-page.test.js:96-114`, `:208-224`.
Toutes les fixtures ont `decalage = 364 × recul` (le banc n'a pas les vacances
2025 : repli à 52 semaines ; le test unitaire tape 364 et 728). Contre-épreuve :
`ligne(a.recul, a.annee, 364 * a.recul)` à la place de `a.decalage` → **13/13 verts**.
Le test « ni plus, ni moins » ne distingue pas la page d'une page qui ignore le
serveur. **Correction** : un cas avec un décalage qui n'est pas 364·k — 357
(alignement `evenement`) et 365 (date fixe : la coupure au lundi suit la date
AFFICHÉE) —, par exemple en réécrivant `annees[0].decalage` dans la réponse du banc.

### 16. MINEUR (tests) — trois gardes de `basculerCouche` se retirent sans un rouge
Contre-épreuve, 13/13 à chaque fois : `ok &&` (l.623 — un échec écrirait le cache),
`if (n !== etat.couchesSeq) return` (l.620), `!etat.depuisCache` (l.623 — l'horodatage
du cache serait remis à neuf sur un écran ancien). Seule `couchesTouchees` est
tenue (retirée : le test 8 rougit).

### 17. MINEUR (tests) — cas non couverts
Couches illisibles puis clic (5), nuit bloquée (4), lundi d'après le 1er janvier
(3), délai 0 (7), clics rapides (1), source `direct` en espagnol (8).

## Vérifié, et qui tient

- Barres : coupure au lundi et au dimanche, séjour d'une nuit (début + fin, sans
  débord), séjour commencé avant la première semaine (lundi carré, pas de débord).
- `a_venir` / `avant` : même borne que `bilanDeLAnnee` / `anneesPassees`
  (`p >= aujourdhui`, `premiere_nuit`) ; `aujourdhui` vient du serveur, pas de l'horloge.
- Libellé singulier : seul appelant de `yfe.effet_envoi`, appelé avec `c.nuits > 0` ;
  pluriel ICU à un niveau d'accolades, lu par le socle.
- Sombre : `--sejour` se résout sur `:root` après la redéfinition de `--ink`.
- z-index : barres (1) sous l'éditeur collé (2), la barre du bas (10), le menu (20).
- Budget : aucun appel ajouté au chargement (`budget-ecran` vert).
- Piste hors diff (pas un constat) : `pourLeCache` est la seule barrière contre les
  séjours en cache ; `sejours` n'est pas dans `JAMAIS_GARDES` de `shared/cache-ecran.js`.
