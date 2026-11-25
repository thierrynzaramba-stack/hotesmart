# Review du lot « la page Événements reliée au calendrier » — trace

- **Arbre** : `/home/claude/hotesmart-lien-ev`
- **Branche** : `lien-calendrier-evenements`
- **Plage relue** : `0428e0adf98c1af8d63a85e65245bfb649709672..541f03609ddab826e833234cca0c2b2039e14137`
  (un commit, SHA collés depuis `git rev-parse`).
- **Le rapport nomme lui-même l'arbre et le SHA lus** : conformes.
- **Une review**, aucun constat de sécurité : les correctifs partent sans
  nouvelle review.

## Fichiers cités par le rapport

| fichier cité | dans la plage |
|---|---|
| `apps/yield/evenements.html` | oui |
| `tests/yf-evenements-lien.test.js` | oui |
| `tests/prix-hote.test.js` | oui |
| `tests/yf-bouton-calendrier.test.js` | oui (vérifié sans constat) |
| `pages/calendrier.html`, `components/sidebar.js`, `shared/i18n/*.json`, `shared/yield-evenements.css` | oui (vérifiés sans constat) |
| `apps/yield/prix.html`, `api/yield-evenements.js`, `shared/ui.css`, `shared/yield-evenements-rendu.js`, `public/style.css`, `vercel.json` | hors plage — cités comme source d'un risque ou d'une vérification, pas comme constat |

## Suite donnée

| constat | gravité | suite |
|---|---|---|
| 1 — le bouton porte `btn-primary`, absente des feuilles V5 : il s'affichait comme un texte | défaut visuel | **corrigé** : `btn--primary` ; assertion au test 1, rouge contre la classe d'avant |
| 2 — le masquage pendant un changement de logement n'était prouvé par aucun test | mineur (test) | **corrigé** : test 2 réécrit, réponse retenue pendant la lecture ; rouge contre la mutation |
| 3 — rien ne prouvait que la Prédiction de prix ouvre la fenêtre et prend le logement | mineur (test) | **corrigé** : deux assertions au test 5 sur `prix.html` ; rouge contre la mutation |
| 4 — en-tête de la page périmé (« les menus visent la pop-up directement ») | mineur (doc) | **corrigé** |
| 5 — retour arrière : page restaurée depuis le cache de pages, sans l'événement ajouté | mineur, plausible | **corrigé** : relecture sur `pageshow` persistant ; test 6, rouge contre la mutation |

## Rapport tel que rendu

**Arbre lu : /home/claude/hotesmart-lien-ev**, branche `lien-calendrier-evenements`, HEAD = `541f03609ddab826e833234cca0c2b2039e14137`. Plage relue : `0428e0adf98c1af8d63a85e65245bfb649709672..541f03609ddab826e833234cca0c2b2039e14137` (un commit, 11 fichiers). Je n'ai rien modifié dans l'arbre. Les mutations ont été faites dans une copie `git archive` sous /tmp, supprimée ensuite.

Tests lancés :
- Les 4 fichiers demandés : 73/73 verts.
- `yf-evenements-lien` avec l'horloge décalée à J+30 et J+200 : 5/5.
- `masquage-hidden`, `budget-ecran`, `pages-non-delegables`, `palette-niveaux` : 63/63 verts.
- Les cinq tests i18n et `sidebar-toggle-topbar` : 45/45 verts.
- `scripts/i18n-check.js` : 1744 clés en fr, en et es.

Aucun constat de sécurité. Un défaut visible, et trois constats mineurs, plus un point à vérifier en recette.

### Constats

**1. Défaut (visuel) — le bouton n'a pas le style d'un bouton.** `apps/yield/evenements.html:78`
- **Cause :** le lien porte la classe `btn btn-primary`. Or `.btn-primary` n'existe que dans `public/style.css`, que cette page ne charge pas. Les feuilles V5 qu'elle charge (`theme.css`, `ui.css`, `yield-evenements.css`) définissent `.btn--primary`, avec deux tirets (`ui.css:127`). La même page l'emploie déjà : `shared/yield-evenements-rendu.js:788` et `:943`.
- **Scénario :** à l'étape 2 de la recette, « + Ajouter un événement » ne reçoit que le style `.btn`, qui laisse le bord transparent. Le lien `<a>` reste aussi sans fond, et sa couleur est héritée. Thierry voit donc un simple texte gras avec un « + » à droite des filtres. Ce n'est ni le bouton plein de la maquette, ni le bouton principal V5 (bord `--ink`).
- **Correction :** `class="btn btn--primary yfe-ajouter"`. On peut ajouter une assertion sur la classe dans `tests/yf-evenements-lien.test.js`.

**2. Mineur (test) — le masquage pendant un changement de logement n'est prouvé par aucun test.** Code : `apps/yield/evenements.html:261`. Test : `tests/yf-evenements-lien.test.js:38`.
- **Mesure :** j'ai retiré `'ajouter'` de la liste masquée dans la branche `changementEnCours()`. `yf-evenements-lien` et `yf-ecran-evenements-page` restent tous deux verts (29/29). Pourtant, la spec §17 annonce ce masquage, et ses preuves par mutation ne couvrent que le droit, l'écran non calculé, le refus et le logement.
- **Scénario en cas de régression :** pendant la lecture du nouveau logement, `peindre()` sort avant de remettre `href` à jour. Le bouton resterait donc visible avec l'adresse de l'ANCIEN logement, sous un sélecteur qui affiche le nouveau. Un clic ouvrirait la pop-up de La bulle alors que l'hôte croit être sur Cœur de vie 23, et il y ajouterait un événement au mauvais logement.
- **Correction :** dans le test 2, faire attendre la réponse pour `AUTRE` (le banc passe `w` à `ecran`). Pendant l'attente, vérifier `hidden === true` ; après la réponse, vérifier qu'il est visible et que `bien === AUTRE`.

**3. Mineur (test) — les tests prouvent l'adresse du bouton, pas ce qui se passe à l'arrivée.** `tests/yf-evenements-lien.test.js:33` et `:69-75`, `tests/prix-hote.test.js:153-161`. Le risque vient de `apps/yield/prix.html`, hors plage.
- **Ce qui manque :** le message « il ouvre la fenêtre des événements » ne vérifie que `evenements=1` dans l'URL. Aucun test de la suite ne vérifie que `prix.html` : ouvre la pop-up sur `?evenements=1` (`prix.html:830`) ; sélectionne le logement de `?bien=` (`prix.html:856-857`).
- **Scénario :** en préparant 4d, quelqu'un retire la lecture de `evenements=1` dans `prix.html`. Le bouton mène alors sur la Prédiction de prix sans pop-up, et toute la suite reste verte. Les deux garde-fous réécrits gardent bien que la pop-up reste atteignable, par le bouton `yp-ouvrir-ev` et par le lien de la page, mais pas son ouverture automatique. C'est désormais tout l'intérêt du bouton.
- **Correction :** dans le test 5, ajouter deux assertions sur `prix.html` : `get('evenements') === '1'` suivi de `ouvrirPopup` ; la sélection par `data.some(b => b.id === voulu)`.

**4. Mineur (documentation périmée dans un fichier de la plage).** `apps/yield/evenements.html:18-23`
- **Constat :** l'en-tête dit encore : « La pop-up reste en service, par le menu […] : les menus (components/sidebar.js, pages/calendrier.html) la visent directement, ils ne passent pas par cette adresse. » C'est faux depuis ce commit, et le lecteur le prendra pour un fait.
- **Correction :** dire que les deux menus ouvrent cette page, et que la pop-up n'est plus atteinte que par « + Ajouter un événement » et par le bouton de la Prédiction de prix, jusqu'à 4d.

**5. Mineur, plausible, à vérifier en recette — le retour arrière après un ajout peut montrer un écran périmé.** `apps/yield/evenements.html`, fonction `init` ; aucun écouteur `pageshow`, ni ici ni ailleurs dans le dépôt.
- **Scénario :** depuis la page, « + Ajouter un événement », ajout dans la pop-up, puis retour arrière du navigateur. Si le navigateur restaure la page depuis son cache de pages (bfcache, très fréquent sur Safari iOS), elle ne se recharge pas : la liste n'a pas le nouvel événement, et rien ne l'indique. Thierry conclurait que l'ajout n'a pas marché.
- **Pourquoi ce lot :** ce parcours aller-retour est nouveau avec lui.
- **Correction :** `addEventListener('pageshow', e => { if (e.persisted) charger() })`.

### Vérifié sans constat

**Lien du calendrier** (`pages/calendrier.html`, `ENTREES_YF`) : il produit `/apps/yield/evenements?bien=<uuid>` ; la réécriture de `vercel.json` conserve la requête. `tests/yf-bouton-calendrier.test.js` contrôle sur le DOM le chemin, l'absence de `evenements=1` et `bien=` sur les quatre entrées. Le garde-fou réécrit garde ce qu'il protégeait. La page lit `?bien=` à l'arrivée : contrôle UUID, mise en minuscules, cache écarté s'il porte un autre logement. Logement absent de la liste (archivé ou hors périmètre) : le serveur répond 404, la page retire `?bien=` de l'adresse et relit sans. Elle bascule alors en silence sur un autre logement. C'est le comportement d'avant, déjà testé (`yf-ecran-evenements-page:333`).

**Membre délégué** : `X-Compte` est posé par `enteteCompte()`. `prix.html` relit le même compte depuis `localStorage` (`hs_compte_courant`), dans `chargerBiens` (`.eq('user_id', compte)`) et dans `apiEv`. La pop-up s'ouvre donc sur le bon compte. Seul cas limite, hors plage : si le compte a été changé dans un autre onglet entre-temps, `prix.html:857` retombe en silence sur le premier logement de l'autre compte.

**Garde serveur de la pop-up** : tous ses gestes passent par `/api/yield-evenements` : POST pour ajouter, DELETE pour supprimer, PATCH pour « ne plus tenir compte ». Ils sont gardés par `requirePermission({ domaine: 'reglages', niveau: 'write', bien, bienRequis: true })` (`api/yield-evenements.js:96-101`). Le masquage n'est donc pas la seule protection. La condition `droits_ecriture` de la page est le même `peutEcrire(reglages, bien)`.

**État du bouton à chaque chemin de peinture** : depuis le cache, visible si le droit en cache est vrai (`pourLeCache` garde `droits_ecriture` ; sans effet sur la sécurité, puisque le serveur de la pop-up rejuge le droit) ; réponse du serveur, il suit `calcule && d.bien && d.droits_ecriture` ; changement de logement, masqué (non testé, voir constat 2) ; refus 403 ou 404, `viderEcran` le masque (mutation faite : sans ce masquage, le test 3 rougit) ; panne après un écran du même logement, il reste, avec un `href` cohérent avec l'écran affiché ; panne après un changement de logement, masqué ; écran non calculé, ou `bien: null`, masqué. L'URL est construite par `URLSearchParams` à partir de `d.bien`, la valeur du serveur. Quand `d.bien` manque, l'ancien `href` reste, mais le bouton est alors masqué.

**Barre latérale** : « Vos événements » mène à la page sans `?bien=` ; la page prend alors le logement du cache ou le premier raccordé, comme le faisait l'ancienne pop-up. L'état « connecté » (`activePage === 'yield-evenements'`) n'est passé par aucune page, ni avant ni après ce commit. Ce n'est pas une régression.

**CSS** : `[hidden]{display:none !important}` est en tête de `ui.css`, que la page charge ; `masquage-hidden` est vert. La rangée `.yfe-barre-liste` (flex, retour à la ligne) se comporte bien au téléphone : les filtres se replient, et le bouton passe à la ligne suivante, calé à droite.

**i18n** : `yfe.ajouter` et `yfe.ajouter_titre` existent en fr, en et es, sans doublon. L'icône `i-plus` existe. La pop-up d'arrivée reste en français seul, comme avant ce lot.

**Case performance** : aucun appel ajouté ; `budget-ecran` est vert.
