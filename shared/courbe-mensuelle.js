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
export function courbeMensuelle ({ series = [], graduation, bulle, resume } = {}) {
  const toutes = series.flatMap(s => (s.valeurs || []).filter(v => typeof v === 'number'))
  // ⚠ UN MAXIMUM NUL FERAIT UNE DIVISION PAR ZÉRO, et le SVG sortirait avec des
  // `NaN` dans ses coordonnées : le navigateur n'affiche alors RIEN, sans rien
  // dire. Un plancher à 1 rend une courbe plate, ce qui est la vérité.
  const max = Math.max(1, ...toutes)

  const x = (k) => MARGE_G + (L - MARGE_G - MARGE_D) * k / 11
  const y = (v) => MARGE_HAUT + (H - MARGE_HAUT - MARGE_BAS) * (1 - v / max)

  const grille = [0, 0.25, 0.5, 0.75, 1].map(f =>
    `<line class="cm-grille" x1="${MARGE_G}" x2="${L - MARGE_D}" `
    + `y1="${y(max * f).toFixed(1)}" y2="${y(max * f).toFixed(1)}"/>`
    + `<text class="cm-grad" x="${MARGE_G - 6}" y="${(y(max * f) + 4).toFixed(1)}" `
    + `text-anchor="end">${ech(graduation ? graduation(max * f) : Math.round(max * f))}</text>`
  ).join('')

  const abscisse = INITIALES.map((n, k) =>
    `<text class="cm-mois" x="${x(k).toFixed(1)}" y="${H - MARGE_BAS + 15}" `
    + `text-anchor="middle">${n}</text>`
  ).join('')

  const courbes = series.map(s => {
    const v = s.valeurs || []
    const mesure = (k) => k >= 0 && k < v.length && typeof v[k] === 'number'
    // ⚠ LE TRAIT SE COUPE SUR UN MOIS SANS VALEUR. C'est toute la raison de ce
    // module : relier janvier à septembre par-dessus huit mois vides
    // dessinerait une croissance qui n'a pas eu lieu, et poser zéro
    // affirmerait que le logement n'a rien vendu alors qu'il n'existait pas.
    let d = ''
    let dedans = false
    v.forEach((val, k) => {
      if (typeof val !== 'number') { dedans = false; return }
      d += `${dedans ? 'L' : 'M'}${x(k).toFixed(1)},${y(val).toFixed(1)} `
      dedans = true
    })
    // ⚠ UN POINT ISOLÉ SE DESSINE PLEIN. Un mois seul entre deux mois vides ne
    // trace AUCUN segment : sans ce point, un logement qui n'a vendu qu'un
    // mois dans l'année n'apparaît pas du tout.
    const points = v.map((val, k) => {
      if (typeof val !== 'number') return ''
      const isole = !mesure(k - 1) && !mesure(k + 1)
      const titre = ech(bulle ? bulle(val, k, s) : val)
      return `<circle cx="${x(k).toFixed(1)}" cy="${y(val).toFixed(1)}" `
        + `r="${isole ? 3.5 : 6}" fill="${isole ? s.couleur : 'transparent'}">`
        + `<title>${titre}</title></circle>`
    }).join('')
    return `<path d="${d.trim()}" fill="none" stroke="${s.couleur}" `
      + `stroke-width="${s.epaisseur || 2}"`
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
