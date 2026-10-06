// shared/prix-depart-jours.js — LE PRIX DE DEPART JOUR PAR JOUR, a cote du prix
// existant, sur l'ecran « Prediction de prix » (apps/yield/prix.html). Spec
// §22.13 de docs/kb/chantier-nouveau-bien.md (decisions de Thierry du 6 octobre
// 2026).
//
// ⚠ AFFICHAGE SEUL : ce module ne lit ni n'ecrit rien. Il compose des donnees
// deja servies — le niveau de chaque jour et les 8 cases (/api/marche-comparables
// ?jours=1), les evenements de l'hote (/api/yield-evenements) et le prix
// existant (/api/yield-prix). Aucune ecriture au calendrier, aucune poussee de
// prix (tests/v2-marche-aucune-ecriture-calendrier.test.js).
// ⚠ Fonctions PURES ; tout texte qui sort en HTML passe par ech().

// ⚠ UN SEUL VOCABULAIRE A L'ECRAN (recette de Thierry, 6 octobre 2026) : les 5
// tranches de YieldFlow. Le calcul garde ses noms (creux…pic) ; l'ecran ne
// montre que ceux-ci. « Exceptionnel » est reserve aux jours touches par un
// evenement DECLARE par l'hote — au prix de la case « Tres haut » (le calcul ne
// mesure que 4 niveaux).
export const TRANCHE = { creux: 'Base', modere: 'Moyen', favorable: 'Haut', pic: 'Très haut' }
export const EXCEPTIONNEL = 'Exceptionnel'
export const NOM_SOURCE = { mesure: 'mesuré', estime: 'estimé', marche: 'marché' }
const ORDRE = ['creux', 'modere', 'favorable', 'pic']

// ⚠ LA REGLE DES EVENEMENTS (decision de Thierry) — un evenement RELEVE le
// niveau du jour, il ne l'abaisse JAMAIS ; plusieurs regles le meme jour : la
// plus haute, sans cumul.
//   - evenement DECLARE par l'hote (festival, saison thermale…) : au moins pic ;
//   - jour ferie, pont, week-end prolonge, date commerciale : un niveau de plus,
//     sans depasser pic ;
//   - vacances scolaires : aucun relevement (les prix des comparables les
//     integrent deja — relever compterait deux fois), affichees comme raison.
const PLUS_UN = new Set(['ferie', 'pont', 'week_end_prolonge'])
export function effetEvenement (e) {
  if (!e) return null
  if (e.origine === 'declare') return { plancher: 'pic', texte: 'événement déclaré', exceptionnel: true }
  if (e.origine === 'calendrier' || PLUS_UN.has(e.segment)) return { plus: 1, texte: '+1 tranche' }
  return { texte: null }
}

export function niveauAvecEvenements (niveau, evenements) {
  if (!ORDRE.includes(niveau)) return niveau
  let i = ORDRE.indexOf(niveau)
  let haut = i
  for (const e of evenements || []) {
    const f = effetEvenement(e)
    if (!f) continue
    if (f.plancher) haut = Math.max(haut, ORDRE.indexOf(f.plancher))
    if (f.plus) haut = Math.max(haut, Math.min(3, i + f.plus))
  }
  return ORDRE[haut]
}

// Les evenements qui touchent un jour (entrees du calendrier : { debut, fin, nom,
// origine, segment }). ⚠ Une date que l'hote a DESACTIVEE (`actif: false`,
// remise dans la liste par /api/yield-evenements pour pouvoir la reactiver) ne
// releve rien (review de 789549c).
const evenementsDu = (calendrier, j) => (calendrier || []).filter(e => e && e.actif !== false && e.debut <= j && e.fin >= j)

/**
 * @param prix       la sortie de prixDeDepart (cases, strategie, jours, statut, motif)
 * @param calendrier les evenements de /api/yield-evenements (`calendrier`)
 * @param existants  Map date -> prix existant en euros (prix au calendrier), ou null
 * @returns Map date -> { date, type, niveau_base, niveau, source, prix, raisons,
 *                        ecart_eur, ecart_pct, statut, motif }
 */
export function composerJours ({ prix, calendrier = [], existants = new Map() }) {
  const out = new Map()
  if (!prix || prix.statut !== 'calcule' || !Array.isArray(prix.jours)) return out
  const caseDe = (n, t) => (prix.cases || []).find(c => c.niveau === n && c.type === t)
  for (const j of prix.jours) {
    const evs = evenementsDu(calendrier, j.date)
    const base = { date: j.date, type: j.type, niveau_base: j.niveau, source: j.source }
    if (!j.niveau) { out.set(j.date, { ...base, statut: 'non_calcule', motif: 'moins de 3 hôtes ont un prix ce jour-là' }); continue }
    const niveau = niveauAvecEvenements(j.niveau, evs)
    const c = caseDe(niveau, j.type)
    if (!c || c.statut !== 'calcule') { out.set(j.date, { ...base, niveau, statut: 'non_calcule', motif: c && c.motif ? c.motif : 'case non calculée' }); continue }
    const p = c.strategies[prix.strategie]
    const exceptionnel = evs.some(e => { const f = effetEvenement(e); return f && f.exceptionnel })
    const tranche = exceptionnel ? EXCEPTIONNEL : TRANCHE[niveau]
    const raisons = [`saison (${NOM_SOURCE[j.source] || j.source})`]
    if (j.type === 'weekend') raisons.push('week-end')
    for (const e of evs) {
      const f = effetEvenement(e)
      raisons.push(f && f.texte ? `${e.nom} (${f.texte})` : e.nom)
    }
    const ex = existants.get(j.date)
    const ecart = Number.isFinite(ex) && ex > 0 ? { ecart_eur: Math.round(p - ex), ecart_pct: Math.round((p / ex - 1) * 100) } : { ecart_eur: null, ecart_pct: null }
    out.set(j.date, { ...base, niveau, tranche, prix: p, raisons, ...ecart, statut: 'calcule' })
  }
  return out
}

const ech = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const signe = v => (v > 0 ? `+${v}` : `${v}`)

// Le DETAIL d'un jour, en une phrase : tranche, source, raisons, ecart. Il vit
// dans l'info-bulle (survol) et dans le panneau de la ligne (toucher).
export function detailDepart (jour) {
  if (!jour) return ''
  if (jour.statut !== 'calcule') return `Prix de départ non calculé : ${jour.motif}`
  const ecart = jour.ecart_eur == null ? null : `écart avec votre prix : ${signe(jour.ecart_eur)} € (${signe(jour.ecart_pct)} %)`
  return [`Prix de départ ${jour.prix} € · ${jour.tranche} (${NOM_SOURCE[jour.source] || jour.source})`, ...jour.raisons.slice(jour.raisons[0].startsWith('saison') ? 1 : 0), ecart].filter(Boolean).join(' · ')
}

// La cellule de la colonne « Prix de départ », ALLEGEE (recette de Thierry) : le
// prix et la tranche, c'est tout ; le detail en info-bulle. `classes` : la
// table des teintes de l'ecran (tranche -> classe), une seule pour tout l'ecran.
export function celluleDepart (jour, classes = {}) {
  if (!jour) return '<td class="yp-depart non-calc">—</td>'
  if (jour.statut !== 'calcule') return `<td class="yp-depart non-calc" title="${ech(detailDepart(jour))}">non calculé</td>`
  return `<td class="yp-depart" title="${ech(detailDepart(jour))}"><span class="yp-depart-p">${ech(jour.prix)}&nbsp;€</span> `
    + `<span class="yp-niv-badge ${ech(classes[jour.tranche] || '')}">${ech(jour.tranche)}</span></td>`
}

// Toute la colonne non calculee (bien sans comparables, sans strategie…) : la
// raison, sans erreur.
export function motifNonCalcule (pd) {
  if (!pd) return 'prix de départ non calculé : les prix de vos comparables ne sont pas disponibles'
  if (pd.etat && pd.etat !== 'calcule') return `prix de départ non calculé : ${pd.message || 'comparables ou stratégie à choisir'}`
  if (pd.prix && pd.prix.statut !== 'calcule') return `prix de départ non calculé : ${pd.prix.motif || 'données insuffisantes'}`
  return null
}
