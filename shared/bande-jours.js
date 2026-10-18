// shared/bande-jours.js — LA bande de dates des plannings (mois + jours),
// factorisée à la demande de Thierry (recette du 13 octobre 2026) : le
// Calendrier est la référence visuelle, la page Ménages en REPREND le
// composant au lieu de l'imiter. Deux copies divergeraient (règle CLAUDE.md).
//
// Classes rendues : cal-bande__mois (--debut au premier jour de chaque mois),
// cal-bande__jour, cal-we / cal-we--debut / cal-we--fin (liserés week-end),
// cal-auj (aujourd'hui). Le conteneur (flex/grid, largeur de colonne) reste
// l'affaire de chaque page ; ici on ne produit que les cellules.

// La règle du marquage week-end, UNE fois (décision du 30 septembre :
// trois copies avaient divergé).
export function classesWE (jourSemaine) {
  return (jourSemaine === 0 || jourSemaine === 6)
    ? ' cal-we' + (jourSemaine === 6 ? ' cal-we--debut' : ' cal-we--fin') : ''
}

export function bandeJoursHtml ({ jours, langue, aujourdhui, esc }) {
  const fmtMois = new Intl.DateTimeFormat(langue, { month: 'long', year: 'numeric' })
  const fmtJour = new Intl.DateTimeFormat(langue, { weekday: 'narrow' })
  let mois = ''
  let bande = ''
  let moisCourant = ''
  for (const iso of jours) {
    const d = new Date(iso + 'T12:00:00')
    const m = iso.slice(0, 7)
    mois += `<span class="cal-bande__mois${m !== moisCourant ? ' cal-bande__mois--debut' : ''}">${m !== moisCourant ? esc(fmtMois.format(d)) : ''}</span>`
    moisCourant = m
    bande += `<span class="cal-bande__jour${classesWE(d.getDay())}${iso === aujourdhui ? ' cal-auj' : ''}">${esc(fmtJour.format(d))}<b>${d.getDate()}</b></span>`
  }
  return { mois, jours: bande }
}
