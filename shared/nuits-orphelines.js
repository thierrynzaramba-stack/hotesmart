// shared/nuits-orphelines.js — LA DÉTECTION DES NUITS ORPHELINES, UNE RÈGLE.
//
// Extraite TELLE QUELLE de pages/calendrier-mobile.html (computeOrphans) au
// lot Calendrier V5 (constat 8 de l'inventaire : la fonction n'existait que
// sur téléphone — « le mobile suit l'ordinateur » inversé). Une nuit LIBRE
// est orpheline si AUCUN séjour valide ne peut la couvrir : un séjour [A, D[
// est valide si tous les jours A..D-1 sont libres, A sans CTA, D sans CTD,
// et sa durée ≥ au min-stay applicable (max des min_stay_arrival de A et des
// min_stay_through traversés, défaut 1).
//
// Entrées PURES : pas de DOM, pas d'horloge — testable.
//   jours        : liste ISO contiguë À ANALYSER (celles qu'on colore)
//   contexte     : { estLibre(iso), inventaire(iso) -> ligne ou undefined }
//   margeJours   : extension d'analyse de part et d'autre (séjours à cheval),
//                  10 par défaut comme l'écran d'origine.
// Sortie : Set des ISO orphelines parmi `jours`.

function ajouterJoursISO (iso, n) {
  const [a, m, j] = String(iso).slice(0, 10).split('-').map(Number)
  const d = new Date(Date.UTC(a, m - 1, j + n, 12))
  return d.toISOString().slice(0, 10)
}

export function detecterOrphelines (jours, contexte, margeJours = 10) {
  const orphelines = new Set()
  if (!jours || !jours.length) return orphelines
  const estLibre = (iso) => contexte.estLibre(iso)
  const ligne = (iso) => contexte.inventaire(iso)
  const cta = (iso) => { const r = ligne(iso); return !!(r && r.cta) }
  const ctd = (iso) => { const r = ligne(iso); return !!(r && r.ctd) }
  const minArr = (iso) => { const r = ligne(iso); return (r && r.min_stay_arrival) ? r.min_stay_arrival : 1 }
  const minThrough = (iso) => { const r = ligne(iso); return (r && r.min_stay_through) ? r.min_stay_through : 0 }

  // Fenetre d'analyse etendue : margeJours avant et apres.
  const tous = []
  for (let i = -margeJours; i <= 0; i++) tous.push(ajouterJoursISO(jours[0], i))
  for (let i = 1; i < jours.length; i++) tous.push(jours[i])
  for (let i = 1; i <= margeJours; i++) tous.push(ajouterJoursISO(jours[jours.length - 1], i))
  const idxDe = {}
  tous.forEach((iso, i) => { idxDe[iso] = i })

  for (const J of jours) {
    if (!estLibre(J)) continue
    const jIdx = idxDe[J]
    if (jIdx == null) continue
    let vendable = false
    for (let ai = jIdx; ai >= 0 && estLibre(tous[ai]); ai--) {
      const A = tous[ai]
      if (cta(A)) continue
      for (let di = jIdx + 1; di < tous.length; di++) {
        if (!estLibre(tous[di - 1])) break
        const D = tous[di]
        if (ctd(D)) continue
        const nuits = di - ai
        if (nuits < 1) continue
        let requis = minArr(A)
        for (let k = ai; k < di; k++) { const mt = minThrough(tous[k]); if (mt > requis) requis = mt }
        if (nuits >= requis) { vendable = true; break }
      }
      if (vendable) break
    }
    if (!vendable) orphelines.add(J)
  }
  return orphelines
}
