// shared/courbe-mensuelle.js — une courbe de douze mois, en SVG, sans
// bibliothèque.
//
// ⚠ POURQUOI UN MODULE PARTAGÉ PLUTÔT QU'UNE TROISIÈME COPIE.
// `apps/yield/marche-global.html` superpose déjà N, N-1 et N-2 par mois, et
// `apps/yield/marche-temperature.html` fait de même sur deux ans. Écrire une
// troisième version pour le bloc Revenus ferait trois endroits où corriger le
// même défaut — et la règle du dépôt est nommée : *une règle partagée par deux
// versions vit dans un module commun, jamais recopiée*.
//
// ⚠ CE MODULE N'EST UTILISÉ QUE PAR REVENUS POUR L'INSTANT (décision de
// Thierry du 27 octobre 2026). YieldFlow n'y bascule pas maintenant : il le
// fera quand il sera intégré au Calendrier. Les deux copies restent donc en
// place, et c'est assumé — on ne touche pas à YieldFlow sans prévenir.
//
// CE QU'IL PREND EN CHARGE, ET QUI EST LA PARTIE QUI SE RATE :
//   · un mois SANS valeur coupe le trait, il ne vaut pas zéro ;
//   · un point ISOLÉ se dessine plein, sinon il n'existe pas à l'écran — un
//     point seul ne trace aucun segment ;
//   · une portion À VENIR se distingue du reçu sans changer de couleur.
//
// CE QU'IL NE PREND PAS : les libellés, la mise en forme des montants, le
// choix des couleurs. Ils appartiennent à l'appelant, et c'est ce qui permet
// de le partager.

const INITIALES = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']

// Géométrie, en unités du `viewBox` : le SVG se met à l'échelle en CSS.
//
// ⚠ ET C'EST POUR CA QU'ELLE SE REGLE. Le `viewBox` est mis a l'echelle de son
// cadre, DONC LES TEXTES AUSSI : une courbe de 680 unités de large rendue dans
// 358 px affiche ses libellés à 11 × 358/680 ≈ **5,8 px**. Mesuré au banc le
// 27 octobre 2026 à 390 px — les graduations et les initiales de mois étaient
// illisibles, et rien ne le signalait : le SVG était parfaitement valide.
//
// La réponse n'est pas d'agrandir la police, qui grandirait aussi sur
// l'ordinateur : c'est de RETRECIR LE REPERE quand le cadre est etroit, pour
// que l'echelle revienne pres de 1. C'est ce que fait la maquette telephone,
// qui dessine en 358 × 200 la ou l'ordinateur dessine en 888 × 260.
const L_DEFAUT = 680
const H_DEFAUT = 220
// ⚠ LA MARGE GAUCHE DEPEND DU PLUS LONG LIBELLE, et elle était FIXE — mesure au
// navigateur le 27 octobre 2026 : avec « 8 994 € », le bord gauche du texte
// tombait à **−3 px**, donc hors du cadre, et le premier chiffre était coupé.
// L'écran affichait « 994 € » là où la graduation dit 8 994 €.
//
// ⚠ C'EST UNE ESTIMATION, ET ELLE S'ANNONCE : on ne peut pas mesurer un texte
// en générant une chaîne. 6,5 px par caractère à 11 px est une majoration
// prudente — le « 8 994 € » mesuré faisait 41 px pour 7 caractères, soit
// 5,9 px. Le plancher garde une marge lisible quand les libellés sont courts.
const MARGE_G_MIN = 44
// La largeur utile minimale du trace, en unites : en dessous, les douze mois se
// superposent et l'abscisse perd son sens.
const LARGEUR_UTILE_MIN = 60
const LARGEUR_CARACTERE = 6.5
const ECART_AXE = 6
const MARGE_D = 12
const MARGE_HAUT = 12
const MARGE_BAS = 26

// Le haut de l'axe, relevé au palier rond immédiatement supérieur.
// ⚠ IL REND LE MAXIMUM, PAS LE PAS : c'est `max` qui pilote `y()`, et les
// paliers s'en déduisent par division. Rendre le pas obligerait chaque appelant
// à refaire la multiplication, donc à pouvoir se tromper.
const PAS_RONDS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8]
function hautRond (brut, nbPaliers) {
  // ⚠ LES DEUX ENTREES SE PLANCHERISENT, et le commentaire ci-dessus disait
  // « total » sans l'etre : mesure de la review du 28 octobre 2026 —
  // `hautRond(5, 1)` rendait `NaN` (division par zero), `hautRond(5, 0)` un
  // NEGATIF, et `hautRond(-10, 3)` un positif minuscule pour une entree
  // absurde. Le test neuf ne balayait que `nbPaliers` dans [2, 6], donc il ne
  // pouvait pas le voir. Une fonction exportee tient ses bornes elle-meme.
  const n = Math.max(2, Math.round(Number(nbPaliers) || 2))
  const cible = Math.max(0, Number(brut) || 0) / (n - 1)
  // ⚠ `Math.log10(0)` VAUT `-Infinity`, ET J'AI D'ABORD ÉCRIT ICI QUE CELA
  // DONNAIT `NaN`. C'est faux, et la mutation l'a montré : `Math.pow(10,
  // -Infinity)` vaut **0**, pas `NaN`. Ce qui arrive vraiment est plus discret
  // — la fonction rendrait un haut d'axe de 0, et `y()` diviserait par zéro.
  // ⚠ ET CE CAS NE PEUT PAS VENIR D'ICI : `brut` est déjà plancherisé à 1 plus
  // bas, donc `cible` vaut au moins 1/(n−1). Le plancher est là parce que
  // `hautRond` est EXPORTÉ : il doit rester total pour qui l'appellera.
  const ordre = Math.pow(10, Math.floor(Math.log10(Math.max(1e-9, cible))))
  for (const f of PAS_RONDS) {
    if (f * ordre >= cible) return f * ordre * (n - 1)
  }
  return 10 * ordre * (n - 1)
}

const ech = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/**
 * @param {object} o
 * @param {Array}  o.series  [{ nom, couleur, epaisseur, pointille, valeurs }]
 *   `valeurs` : 12 entrées, `null` pour un mois SANS donnée (jamais 0).
 * @param {Function} o.graduation  (v) -> texte de l'axe vertical
 * @param {Function} o.bulle       (v, mois, serie) -> texte du `<title>`
 * @param {string}   o.resume      l'`aria-label` : ce que la courbe MONTRE
 * @param {number}   o.graduations  combien de paliers sur l'axe vertical (2 à 6)
 * @param {number}   o.moisFort     l'index du mois à mettre en avant (0 = janvier)
 * @param {boolean}  o.arrondir     relève le haut de l'axe à un palier rond
 * @param {number}   o.largeur      largeur du `viewBox`, en unités (défaut 680)
 * @param {number}   o.hauteur      hauteur du `viewBox`, en unités (défaut 220)
 * @param {Array}    o.bandes       [{ min: [12], max: [12], couleur }] — une
 *   enveloppe dessinée DERRIÈRE les courbes (min–max des comparables).
 * @returns {string} le SVG, prêt à insérer
 */
export function courbeMensuelle ({ series = [], graduation, bulle, resume, initiales, graduations, moisFort, arrondir, largeur, hauteur, bandes = [] } = {}) {
  // ⚠ DES BORNES, PARCE QUE CES DEUX NOMBRES DIVISENT. Une hauteur nulle
  // collerait toutes les series sur une ligne.
  // ⚠ ET LA BORNE DE LARGEUR NE SUFFIT PAS A ELLE SEULE — ce commentaire
  // affirmait le contraire. `MARGE_G` n'est plus une constante : elle suit la
  // longueur du plus long libelle, sans plafond. Mesure de la review du
  // 28 octobre 2026 : `largeur: 200` avec un libelle de 40 caracteres donnait
  // des abscisses DECROISSANTES (266, 258, … 188) — la courbe se tracait de
  // droite a gauche. C'est la largeur UTILE qu'il faut garantir, pas la
  // largeur brute : voir le plafond pose sur `MARGE_G` plus bas.
  const L = Math.min(4000, Math.max(200, Number(largeur) || L_DEFAUT))
  const H = Math.min(2000, Math.max(120, Number(hauteur) || H_DEFAUT))
  // ⚠ LES INITIALES DES MOIS SE PASSENT, ET LE DEPOT INTERDIT LE TEXTE EN DUR.
  // Le défaut est le français, que l'anglais partage — mais pas l'espagnol :
  // janvier y est « E » (Enero), pas « J ». `scripts/i18n-check.js` ne lit que
  // les fichiers de locale, donc il ne l'aurait jamais vu.
  const mois = Array.isArray(initiales) && initiales.length === 12 ? initiales : INITIALES
  // ⚠ `Number.isFinite`, ET PAS `typeof v === 'number'` — relevé en review,
  // mesuré. `typeof NaN` vaut `'number'` : un seul `NaN` dans une série passait
  // le filtre, `Math.max(1, NaN)` rendait `NaN`, et TOUTES les coordonnées de
  // TOUTES les séries devenaient `NaN` — pas seulement le mois fautif. Le
  // navigateur n'affiche alors rien, sans rien dire : exactement la panne que
  // le commentaire ci-dessous disait prévenir, et que le plancher ne couvrait
  // que pour `max === 0`. `Infinity` donnait le même genre de ruine, en pire :
  // la série s'aplatissait sur l'axe et les graduations s'écrivaient `NaN`.
  //
  // Une valeur non finie est donc traitée comme une ABSENCE : le trait se
  // coupe, comme pour un mois sans donnée. C'est la seule réponse qui ne
  // fabrique pas de chiffre.
  const fini = (v) => Number.isFinite(v)
  // ⚠ LA BANDE ENTRE DANS LE MAXIMUM, sinon elle sort du cadre par le haut
  // sans un mot : un comparable qui gagne deux fois plus que l'hôte aurait son
  // plafond tracé au-dessus de la zone dessinée, donc invisible — et l'écran
  // montrerait une bande tronquée en affirmant qu'elle est complète.
  const toutes = series.flatMap(s => (s.valeurs || []).filter(fini))
    .concat((Array.isArray(bandes) ? bandes : []).flatMap(b =>
      [...(b.min || []), ...(b.max || [])].filter(fini)))
  // ⚠ UN MAXIMUM NUL FERAIT UNE DIVISION PAR ZÉRO, et le SVG sortirait avec des
  // `NaN` dans ses coordonnées. Un plancher à 1 rend une courbe plate, ce qui
  // est la vérité.
  // ⚠ LE NOMBRE DE PALIERS SE REGLE, et il était figé à cinq. La maquette de la
  // vue Année n'en veut que TROIS (0, la moitié, le haut) : avec cinq libellés
  // en euros pleins, l'axe devient une colonne de chiffres qui se lit plus que
  // la courbe. Borné à [2, 6] : un seul palier ne gradue rien, et au-delà de
  // six les libellés se touchent à 220 unités de haut.
  const nbPaliers = Math.min(6, Math.max(2, Math.round(Number(graduations) || 5)))
  const brut = Math.max(1, ...toutes)
  // ⚠ UN AXE NON ARRONDI DONNE DES PALIERS QU'ON NE LIT PAS. Mesuré au banc le
  // 27 octobre 2026 : sur des revenus culminant à 12 600 €, trois paliers
  // calculés sur le maximum réel écrivaient « 0 € / 6,3 k € / 12,6 k € ». Un
  // axe sert à SITUER une courbe d'un coup d'œil, et 6,3 k ne se situe pas —
  // la maquette, elle, montrait 0 / 5 k / 10 k.
  //
  // On relève donc le haut de l'axe au multiple rond immédiatement supérieur.
  // ⚠ LE PAS SE CHOISIT DANS UNE LISTE DENSE, et c'est ce qui borne la place
  // perdue. BALAYAGE de 1 à 60 000 pour 2 à 6 paliers, 27 octobre 2026 : la
  // courbe occupe au PIRE **75 %** de la hauteur (cas mesuré : maximum 45 001
  // sur 4 paliers, axe relevé à 60 000). Une liste plus courte (1, 2, 5)
  // descendrait à 50 %. ⚠ Et ce chiffre est mesuré, pas déduit de l'écart
  // entre deux pas de la liste — j'avais écrit 83 % en lisant 1 → 1,2. Les pires
  // sauts sont TROIS, pas deux : 1,5 → 2, 3 → 4 et 6 → 8.
  const max = arrondir ? hautRond(brut, nbPaliers) : brut

  // Les libellés d'abord : c'est leur longueur qui dicte la marge.
  const paliers = Array.from({ length: nbPaliers }, (_, i) => i / (nbPaliers - 1)).map(f => ({
    f, texte: String(graduation ? graduation(max * f) : Math.round(max * f))
  }))
  const plusLong = Math.max(0, ...paliers.map(p => p.texte.length))
  // ⚠ ET ELLE SE PLAFONNE : sans cela, des libelles longs dans un cadre etroit
  // mangent toute la largeur utile et les abscisses reculent. On garde au moins
  // `LARGEUR_UTILE_MIN` unites pour les douze mois.
  const MARGE_G = Math.min(
    Math.max(MARGE_G_MIN, Math.ceil(plusLong * LARGEUR_CARACTERE) + ECART_AXE),
    Math.max(0, L - MARGE_D - LARGEUR_UTILE_MIN))

  const x = (k) => MARGE_G + (L - MARGE_G - MARGE_D) * k / 11
  const y = (v) => MARGE_HAUT + (H - MARGE_HAUT - MARGE_BAS) * (1 - v / max)

  // ⚠ LES BANDES SE DESSINENT EN PREMIER, donc DERRIÈRE tout le reste. Une
  // enveloppe posée par-dessus les courbes les masquerait — et c'est la courbe
  // de l'hôte qui porte le sens, la bande n'est qu'un décor de comparaison.
  // ⚠ UNE BANDE SE COUPE SUR UN TROU, exactement comme un trait : relier deux
  // segments par-dessus quatre mois sans comparable dessinerait une enveloppe
  // qui n'a jamais été mesurée.
  const polygones = (Array.isArray(bandes) ? bandes : []).map(b => {
    const mn = b.min || []
    const mx = b.max || []
    const ok = (k) => fini(mn[k]) && fini(mx[k])
    const morceaux = []
    let courant = []
    for (let k = 0; k < 12; k++) {
      if (ok(k)) { courant.push(k); continue }
      if (courant.length) morceaux.push(courant)
      courant = []
    }
    if (courant.length) morceaux.push(courant)
    const couleur = /^#[0-9a-fA-F]{3,8}$|^var\(--[\w-]+\)$|^[a-z]{3,20}$/.test(String(b.couleur || ''))
      ? String(b.couleur)
      : 'var(--line)'
    // ⚠ UNE OPACITE PAR BANDE, BORNEE. Deux enveloppes de GRIS VOISINS ne se
    // distinguent pas (recette du 28 octobre : « trop proches »), et le remede
    // n'est pas une couleur vive — c'est le MEME gris a deux densites. Bornee
    // comme `epaisseur`, et non echappee mais NUMERIQUE.
    //
    // ⚠⚠ ELLE PART EN STYLE **EN LIGNE**, PAS EN ATTRIBUT, ET C'EST TOUT CE QUI
    // COMPTE ICI. Un attribut de presentation (`opacity="0.15"`) a la priorite
    // la PLUS BASSE de la cascade : toute regle d'auteur l'emporte sur lui. Or
    // `shared/ui.css` pose `.cm-bande { opacity: .85 }` et
    // `.cm-bande-trait { opacity: .85 }` — donc l'attribut n'a JAMAIS rien
    // applique. Mesure de Thierry en recette sur staging, puis reproduite au
    // banc chrome le 28 octobre 2026 :
    //   attribut demande  : 0.15 et 0.07
    //   opacite CALCULEE  : 0.85 et 0.85
    //   les deux bandes se distinguent : NON
    // Deux consequences, et la seconde est la pire : l'adoucissement demande
    // n'avait aucun effet, ET le constat « bandes trop proches » du 28 octobre
    // n'avait jamais ete reellement corrige — les deux densites ne s'appliquaient
    // pas. Un style en ligne, lui, bat une regle de classe.
    //
    // ⚠ ET ON NE RETIRE PAS LA REGLE CSS, MAIS PAS POUR LA RAISON QUE J'AVAIS
    // ECRITE. Je justifiais de la garder par « `marche-temperature.html` et
    // `prix.html` passent des bandes SANS opacite » : les deux etaient FAUX,
    // releve par la session chef de file et remesure ici —
    // `class="cm-bande"` n'est emis que par les deux lignes de CE module,
    // `pages/aujourdhui.html` en est le SEUL importateur,
    // `marche-temperature.html` dessine ses propres `<rect>` sans cette classe
    // (son attribut `opacity` marche, justement parce qu'aucune regle de classe
    // ne le combat), et les « bandes » de `prix.html` sont des `div` en flex.
    // Mon avertissement sur le rayon d'explosion etait donc large de trois
    // ecrans.
    // La VRAIE raison de garder la regle : elle est le DEFAUT quand aucune
    // opacite n'est demandee, et `tests/courbe-bande-rendu.test.js` le mesure
    // (0,85 calcule). La retirer rendrait les bandes opaques a 1 pour tout
    // appelant futur qui ne precise rien.
    // ⚠ Et dans ce depot un commentaire se lit comme une mesure : une decision
    // juste adossee a un fait faux se propage, parce que personne ne reverifie
    // ce qui est deja ecrit.
    //
    // ⚠ MES DEUX TESTS LISAIENT L'ATTRIBUT, donc mon intention, jamais le rendu.
    // C'est pourquoi le test de ce lot lit le style CALCULE dans un vrai
    // navigateur (`tests/courbe-bande-rendu.test.js`).
    const opacite = Number.isFinite(Number(b.opacite)) && Number(b.opacite) > 0
      ? Math.min(1, Number(b.opacite))
      : null
    const styleOpacite = opacite === null ? '' : ` style="opacity:${opacite}"`
    return morceaux.map(ks => {
      // ⚠ UN MOIS SEUL NE FAIT PAS UN POLYGONE : trois points confondus en
      // dessinent un de surface nulle, donc invisible. On lui donne un TRAIT
      // vertical, qui est exactement ce que la donnée dit — un intervalle.
      if (ks.length === 1) {
        const k = ks[0]
        return `<line class="cm-bande-trait" x1="${x(k).toFixed(1)}" x2="${x(k).toFixed(1)}" `
          + `y1="${y(mx[k]).toFixed(1)}" y2="${y(mn[k]).toFixed(1)}" stroke="${couleur}"`
          + `${styleOpacite}/>`
      }
      const haut = ks.map(k => `${x(k).toFixed(1)},${y(mx[k]).toFixed(1)}`)
      const bas = [...ks].reverse().map(k => `${x(k).toFixed(1)},${y(mn[k]).toFixed(1)}`)
      return `<polygon class="cm-bande" points="${haut.concat(bas).join(' ')}" fill="${couleur}"`
        + `${styleOpacite}/>`
    }).join('')
  }).join('')

  const grille = paliers.map(({ f, texte }) =>
    `<line class="cm-grille" x1="${MARGE_G}" x2="${L - MARGE_D}" `
    + `y1="${y(max * f).toFixed(1)}" y2="${y(max * f).toFixed(1)}"/>`
    + `<text class="cm-grad" x="${MARGE_G - ECART_AXE}" y="${(y(max * f) + 4).toFixed(1)}" `
    + `text-anchor="end">${ech(texte)}</text>`
  ).join('')

  // ⚠ UN MOIS PEUT ETRE MIS EN AVANT, et c'est le mois COURANT que la vue Année
  // désigne : sans lui, rien sur l'axe ne dit où s'arrête le réalisé et où
  // commence le déjà réservé. ⚠ ET CE N'EST PAS LE SEUL PORTEUR DE CETTE
  // FRONTIERE — le trait passe en pointillé au même endroit, et c'est la NOTE DE
  // BAS DE BLOC qui la nomme en mots. ⚠ Pas la légende : l'appelant la pose en
  // `aria-hidden="true"` (elle ne fait que redire les marques), donc elle
  // n'existe pas pour un lecteur d'écran. Une graisse seule non plus.
  const fort = Number.isInteger(moisFort) && moisFort >= 0 && moisFort < mois.length ? moisFort : -1
  const abscisse = mois.map((n, k) =>
    `<text class="cm-mois${k === fort ? ' cm-mois--fort' : ''}" x="${x(k).toFixed(1)}" `
    + `y="${H - MARGE_BAS + 15}" text-anchor="middle">${ech(n)}</text>`
  ).join('')

  // ⚠ DOUZE VALEURS, ET ON NE DÉBORDE PAS DU CADRE. Avec vingt-quatre entrées,
  // l'abscisse montait à 1 348 pour un `viewBox` large de 680 : la moitié du
  // tracé sortait du cadre, sans message. On tronque et on le dit dans la
  // console — un graphique amputé qui se tait est pire qu'une erreur.
  for (const s of series) {
    if ((s.valeurs || []).length > 12) {
      console.warn(`[courbe-mensuelle] série « ${s.nom} » : ${s.valeurs.length} valeurs pour 12 mois, tronquée`)
      s.valeurs = s.valeurs.slice(0, 12)
    }
  }

  const courbes = series.map(s => {
    // ⚠ LA COULEUR ET L'ÉPAISSEUR ENTRENT DANS DES ATTRIBUTS, DONC ELLES SONT
    // TAMISÉES — relevé en review. `bulle`, `resume` et `graduation` passaient
    // par `ech()` ; ces deux-là, non. Démontré :
    //   couleur: 'red" onclick="alert(1)'  ->  <path … stroke="red"
    //   onclick="alert(1)" …>
    // Un gestionnaire d'événement arbitraire sortait du module. Aucun appelant
    // ne passe aujourd'hui autre chose qu'un jeton de thème, mais ce module est
    // dans `shared/` POUR être réutilisé, et le prochain appelant ne lira pas
    // ce commentaire avant de lui donner une couleur venue d'ailleurs.
    //
    // ⚠ LISTE BLANCHE, PAS ÉCHAPPEMENT : une couleur n'est pas du texte libre.
    // `ech()` laisserait passer `red" onclick=...` en le rendant inoffensif
    // dans l'attribut, mais produirait une couleur invalide sans le dire. Une
    // forme refusée retombe sur le jeton de texte du thème : on dessine.
    const couleur = /^#[0-9a-fA-F]{3,8}$|^var\(--[\w-]+\)$|^[a-z]{3,20}$/.test(String(s.couleur || ''))
      ? String(s.couleur)
      : 'var(--ink)'
    const epaisseur = Number.isFinite(Number(s.epaisseur)) && Number(s.epaisseur) > 0
      ? Math.min(8, Number(s.epaisseur))
      : 2
    const v = s.valeurs || []
    const mesure = (k) => k >= 0 && k < v.length && fini(v[k])
    // ⚠ LE TRAIT SE COUPE SUR UN MOIS SANS VALEUR. C'est toute la raison de ce
    // module : relier janvier à septembre par-dessus huit mois vides
    // dessinerait une croissance qui n'a pas eu lieu, et poser zéro
    // affirmerait que le logement n'a rien vendu alors qu'il n'existait pas.
    let d = ''
    let dedans = false
    v.forEach((val, k) => {
      if (!fini(val)) { dedans = false; return }
      d += `${dedans ? 'L' : 'M'}${x(k).toFixed(1)},${y(val).toFixed(1)} `
      dedans = true
    })
    // ⚠ UN POINT ISOLÉ SE DESSINE PLEIN. Un mois seul entre deux mois vides ne
    // trace AUCUN segment : sans ce point, un logement qui n'a vendu qu'un
    // mois dans l'année n'apparaît pas du tout.
    const points = v.map((val, k) => {
      if (!fini(val)) return ''
      const isole = !mesure(k - 1) && !mesure(k + 1)
      const titre = ech(bulle ? bulle(val, k, s) : val)
      return `<circle cx="${x(k).toFixed(1)}" cy="${y(val).toFixed(1)}" `
        + `r="${isole ? 3.5 : 6}" fill="${isole ? couleur : 'transparent'}">`
        + `<title>${titre}</title></circle>`
    }).join('')
    return `<path d="${d.trim()}" fill="none" stroke="${couleur}" `
      + `stroke-width="${epaisseur}"`
      + `${s.pointille ? ' stroke-dasharray="6 4"' : ''}/>${points}`
  }).join('')

  // ⚠ `role="img"` ET UN RÉSUMÉ : la courbe n'est jamais le seul porteur de
  // sens. Les chiffres sont écrits à côté, et ce libellé dit ce qu'elle montre
  // — même règle que la barre du bloc Mois.
  return `<svg class="cm" viewBox="0 0 ${L} ${H}" role="img" aria-label="${ech(resume)}">`
    + `${polygones}${grille}${abscisse}`
    + `<line class="cm-axe" x1="${MARGE_G}" x2="${L - MARGE_D}" `
    + `y1="${H - MARGE_BAS}" y2="${H - MARGE_BAS}"/>`
    + `${courbes}</svg>`
}

// Pour les tests, qui lisent la géométrie plutôt que de la recopier.
// ⚠ `MARGE_G` N'EST PLUS UNE CONSTANTE : elle se calcule par appel, puisqu'elle
// depend des libelles. Les tests lisent donc la regle, pas une valeur figee.
export const _interne = {
  L_DEFAUT, H_DEFAUT,
  // `hautRond` sort POUR LES TESTS, qui éprouvent sa règle directement — le
  // plancher d'occupation et la garde du logarithme ne se lisent pas dans un
  // SVG. ⚠ Aucun appelant ne l'utilise, et c'est voulu : le seul qui en avait
  // besoin voulait choisir la forme de ses libellés, et ce choix s'est révélé
  // inutile une fois l'axe arrondi (voir `pages/aujourdhui.html`).
  hautRond,
  MARGE_G_MIN, LARGEUR_CARACTERE, ECART_AXE, MARGE_D, MARGE_HAUT, MARGE_BAS, INITIALES,
  margeGauche: (textes) =>
    Math.max(MARGE_G_MIN, Math.ceil(Math.max(0, ...textes.map(t => String(t).length)) * LARGEUR_CARACTERE) + ECART_AXE)
}
