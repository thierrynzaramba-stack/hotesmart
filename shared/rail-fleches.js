// shared/rail-fleches.js — les deux fleches d'un rail horizontal.
//
// ⚠ POURQUOI CE MODULE EXISTE. Constat de Thierry en recette de production, le
// 29 octobre 2026 : « sur ordinateur, on ne peut pas faire defiler les avis. La
// molette fait defiler la page, pas la ligne, et il n'y a ni fleche ni barre
// visible. » Le rail etait donc inatteignable a la souris : la barre de
// defilement est masquee (`scrollbar-width: none`), un trackpad sait defiler
// lateralement mais une molette ordinaire non, et le chargement des avis
// suivants n'avait plus aucun declencheur.
//
// ⚠ LA MOLETTE N'EST PAS DETOURNEE, et c'est une demande explicite : ce module
// ne pose AUCUN ecouteur `wheel`. Transformer un defilement vertical en
// defilement horizontal vole a l'hote le geste qui fait descendre la page.
//
// ⚠ ET LA FLECHE DE DROITE RESTE ACTIVE AU BOUT DU RAIL tant qu'il reste
// quelque chose a charger. C'est ce qui fait du clic un geste complet : il
// avance de trois cartes ET demande la page suivante. Grisee au bout alors que
// la suite existe, elle laisserait l'hote devant un mur.

/**
 * La fenetre a laquelle ce rail appartient. ⚠ CHERCHEE PRUDEMMENT : un noeud
 * peut venir d'un double de test qui ne porte pas `ownerDocument`, et un module
 * d'interface ne doit pas faire tomber la page pour une commodite — ici la
 * gouttiere mesuree et l'observation du redimensionnement. Sans cette garde,
 * `ResizeObserver` levait `Cannot read properties of undefined` et emportait
 * TOUT le rendu des avis : 14 rouges au banc.
 */
function fenetreDu (noeud) {
  const d = noeud && noeud.ownerDocument
  if (d && d.defaultView) return d.defaultView
  return typeof window !== 'undefined' ? window : null
}

/** Le pas : trois cartes, gouttiere comprise, mesure sur le rendu. */
function pasDuRail (rail, cartes) {
  const premiere = rail.firstElementChild
  if (!premiere) return rail.clientWidth
  const largeur = premiere.getBoundingClientRect().width
  // La gouttiere vient de la feuille : la recopier ici la ferait diverger.
  const vue = fenetreDu(rail)
  const style = vue && typeof vue.getComputedStyle === 'function' ? vue.getComputedStyle(rail) : null
  const gap = style ? (parseFloat(style.columnGap || style.gap || '0') || 0) : 0
  const pas = (largeur + gap) * cartes
  // ⚠ UN PAS PLUS LARGE QUE LE RAIL SAUTERAIT DES CARTES. A 1 024 px, trois
  // cartes de 300 px debordent la zone visible : on avance de ce qu'on voit.
  return Math.max(1, Math.min(pas, rail.clientWidth || pas))
}

const auBout = (rail) => rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 1
const auDebut = (rail) => rail.scrollLeft <= 1

/**
 * Branche les deux fleches d'un rail.
 * @param {object} o
 * @param {Element} o.rail      le conteneur qui defile
 * @param {Element} o.prec      le bouton « vers la gauche »
 * @param {Element} o.suiv      le bouton « vers la droite »
 * @param {number} [o.cartes]   combien de cartes par clic (3)
 * @param {Function} [o.charger] appele au clic droit : la page suivante
 * @returns {{maj: Function, fin: Function}} `maj` relit l'etat, `fin` dit qu'il
 *   n'y a plus rien a charger.
 */
export function brancherFleches ({ rail, prec, suiv, cartes = 3, charger }) {
  if (!rail || !prec || !suiv) return { maj: () => {}, fin: () => {} }
  // Idempotent : un rendu qui rebranche ne doit pas doubler les ecouteurs, qui
  // feraient avancer de six cartes par clic.
  // ⚠ MAIS LE REBRANCHEMENT REPART D'UNE SUITE OUVERTE, et c'est le constat
  // MAJEUR de la revue de fbb6baee. `fin()` est appele par le `finir()` de la
  // page, qui tourne AUSSI dans son `catch` — donc sur un simple incident
  // reseau. Sans cette remise a zero, le rendu suivant apportait trois cartes
  // fraiches et un nouveau curseur, mais `fini` restait vrai : au bout du rail
  // la fleche se grisait et ne demandait plus rien. A l'ordinateur elle est le
  // SEUL declencheur, donc c'etait le defaut de production reproduit apres une
  // seule lecture ratee.
  // ⚠ ET LES BOUTONS SONT COMPARES. Le cache vit sur le RAIL, les ecouteurs
  // sur les boutons : si un rendu recreait les boutons, on garderait des noeuds
  // DETACHES — `maj()` ecrirait `disabled` dans le vide et aucun clic ne serait
  // plus entendu, sans une erreur. Aujourd'hui les boutons vivent hors du rail
  // et survivent ; cette garde est la pour le jour ou ce ne sera plus vrai.
  const dejaBranche = rail.__railFleches
  if (dejaBranche && dejaBranche.prec === prec && dejaBranche.suiv === suiv) {
    dejaBranche.charger = charger
    dejaBranche.rouvrir()
    return dejaBranche
  }

  const etat = { fini: false, charger }

  const maj = () => {
    // ⚠ VISIBLES SEULEMENT QUAND ELLES SERVENT. Elles naissent `hidden` dans le
    // balisage : un bloc « Pas encore d'avis » ou « lecture impossible » reste
    // AFFICHE (ces etats ne sont pas dans `MUETS`), et `armerLaSuiteDesAvis`
    // sort avant de brancher — l'hote voyait alors deux boutons ronds d'allure
    // cliquable, sans ecouteur et sans `disabled`. Constat 2 de la revue.
    prec.hidden = false
    suiv.hidden = false
    prec.disabled = auDebut(rail)
    // Au bout, mais la suite existe : on reste cliquable.
    suiv.disabled = auBout(rail) && etat.fini
  }

  const aller = (sens) => {
    const pas = pasDuRail(rail, cartes)
    // `scrollBy` avec un objet pour le defilement doux ; la valeur de retour
    // n'existe pas, donc rien a attendre ici.
    if (typeof rail.scrollBy === 'function') rail.scrollBy({ left: sens * pas, behavior: 'smooth' })
    else rail.scrollLeft += sens * pas
    maj()
  }

  prec.addEventListener('click', () => { if (!prec.disabled) aller(-1) })
  suiv.addEventListener('click', () => {
    if (suiv.disabled) return
    aller(1)
    // ⚠ LE CHARGEMENT PART AU CLIC, pas seulement quand la sentinelle entre
    // dans la fenetre : c'est la demande (« un clic avance de 3 cartes ET
    // declenche le chargement suivant »), et c'est ce qui rend le geste utile
    // des le premier clic. Le declencheur en aval se protege lui-meme des
    // appels simultanes.
    if (typeof etat.charger === 'function') etat.charger()
  })
  // Passif : on LIT la position, on ne la detourne pas.
  rail.addEventListener('scroll', maj, { passive: true })

  // ⚠ ET LA TAILLE DU RAIL CHANGE SANS QU'IL DEFILE (constat 4 de la revue).
  // Deux avis a 1 280 px tiennent dans la zone visible : la fleche droite est
  // grisee a juste titre. L'hote reduit sa fenetre a 800 px, le contenu
  // deborde — mais `scrollLeft` n'a pas bouge, donc aucun `scroll` n'est emis
  // et la fleche reste grisee sur du contenu hors de l'ecran.
  const vueDuRail = fenetreDu(rail)
  const Obs = vueDuRail && vueDuRail.ResizeObserver
  if (typeof Obs === 'function') new Obs(() => maj()).observe(rail)

  const r = {
    maj,
    prec,
    suiv,
    fin: () => { etat.fini = true; maj() },
    // Ce que fait un rebranchement : la suite redevient ouverte, et on relit.
    rouvrir: () => { etat.fini = false; maj() },
    set charger (f) { etat.charger = f },
    get charger () { return etat.charger }
  }
  rail.__railFleches = r
  maj()
  return r
}
