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
const L = 680
const H = 220
const MARGE_G = 44
const MARGE_D = 12
const MARGE_HAUT = 12
const MARGE_BAS = 26

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
 * @returns {string} le SVG, prêt à insérer
 */
export function courbeMensuelle ({ series = [], graduation, bulle, resume, initiales } = {}) {
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
  const toutes = series.flatMap(s => (s.valeurs || []).filter(fini))
  // ⚠ UN MAXIMUM NUL FERAIT UNE DIVISION PAR ZÉRO, et le SVG sortirait avec des
  // `NaN` dans ses coordonnées. Un plancher à 1 rend une courbe plate, ce qui
  // est la vérité.
  const max = Math.max(1, ...toutes)

  const x = (k) => MARGE_G + (L - MARGE_G - MARGE_D) * k / 11
  const y = (v) => MARGE_HAUT + (H - MARGE_HAUT - MARGE_BAS) * (1 - v / max)

  const grille = [0, 0.25, 0.5, 0.75, 1].map(f =>
    `<line class="cm-grille" x1="${MARGE_G}" x2="${L - MARGE_D}" `
    + `y1="${y(max * f).toFixed(1)}" y2="${y(max * f).toFixed(1)}"/>`
    + `<text class="cm-grad" x="${MARGE_G - 6}" y="${(y(max * f) + 4).toFixed(1)}" `
    + `text-anchor="end">${ech(graduation ? graduation(max * f) : Math.round(max * f))}</text>`
  ).join('')

  const abscisse = mois.map((n, k) =>
    `<text class="cm-mois" x="${x(k).toFixed(1)}" y="${H - MARGE_BAS + 15}" `
    + `text-anchor="middle">${ech(n)}</text>`
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
    + `${grille}${abscisse}`
    + `<line class="cm-axe" x1="${MARGE_G}" x2="${L - MARGE_D}" `
    + `y1="${H - MARGE_BAS}" y2="${H - MARGE_BAS}"/>`
    + `${courbes}</svg>`
}

// Pour les tests, qui lisent la géométrie plutôt que de la recopier.
export const _interne = { L, H, MARGE_G, MARGE_D, MARGE_HAUT, MARGE_BAS, INITIALES }
