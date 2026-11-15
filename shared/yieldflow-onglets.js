// shared/yieldflow-onglets.js — les écrans de YieldFlow, d'un écran à l'autre.
//
// ⚠ C'EST LE SOUS-MENU QUE L'ANCIENNE BARRE LATÉRALE PORTAIT, DÉPLACÉ, PAS
// RETIRÉ (intégration V5, docs/specs/spec-integration-v5-lot-2.md §2). Sur les
// écrans de l'ancien socle, `components/sidebar.js` dépliait sous l'entrée
// « Tarification dynamique » quatre liens : Prédiction de prix, Vos événements,
// Le marché global, Choisir vos comparables. Le menu ≡ du socle V5 n'a qu'une
// entrée « YieldFlow » ; sans cette rangée, un hôte arrivé sur un écran ne
// pouvait plus atteindre les autres que par leur adresse.
//
// ⚠ LES ADRESSES SONT CELLES DE LA BARRE LATÉRALE, AU CARACTÈRE — y compris
// `?evenements=1`, qui ouvre la fenêtre des événements sur la Prédiction de
// prix. « La température du marché » et « Le marché » n'y figuraient pas (on
// les atteint par leur adresse ou depuis un autre écran) : elles n'y entrent
// pas non plus. Une SEULE liste, ici, pour les écrans qui la montrent.
export const ECRANS_YIELDFLOW = [
  { id: 'synthese', href: '/apps/yield', cle: 'yfnav.synthese' },
  { id: 'prix', href: '/apps/yield/prix', cle: 'yfnav.prediction' },
  { id: 'evenements', href: '/apps/yield/prix?evenements=1', cle: 'yfnav.evenements' },
  { id: 'marche-global', href: '/apps/yield/marche-global', cle: 'yfnav.marche_global' },
  { id: 'comparables', href: '/apps/yield/comparables', cle: 'yfnav.comparables' }
]

// La rangée de liens, dans le conteneur donné. `actif` désigne l'écran
// courant (aucun pour un écran qui n'est pas dans la liste) : il porte
// `aria-current="page"`, comme l'onglet du socle.
export function monterOngletsYieldFlow (conteneur, actif, t) {
  if (!conteneur) return
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  conteneur.innerHTML = ECRANS_YIELDFLOW.map(e => {
    const on = e.id === actif
    return `<a class="seg__btn${on ? ' is-on' : ''}" href="${esc(e.href)}"${on ? ' aria-current="page"' : ''}>${esc(t(e.cle))}</a>`
  }).join('')
}
