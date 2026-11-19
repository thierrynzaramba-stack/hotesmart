// ═══════════════════════════════════════════════════════════════════════════
// lib/charges/credit-tableau.js — LIRE LE TABLEAU D'AMORTISSEMENT D'UN CRÉDIT
// Spec : docs/specs/spec-compte-de-charges.md §14.20
//
// ⚠ SANS IA, ET CHAQUE LIGNE SE PROUVE (décision du 19 novembre 2026, à
// l'import du prêt de Thierry) : un tableau d'amortissement porte 300 lignes
// de montants, et une seule mal lue fausse vingt-cinq ans de charges. On lit
// donc les CELLULES du PDF (texte et position, `unpdf`), on retrouve les
// colonnes par leur en-tête, et on n'accepte une échéance que si
//     intérêts + assurance + accessoires + capital amorti = échéance
// au centime. Une seule ligne fausse : le tableau est refusé, et le refus dit
// laquelle. Un tableau dont on ne reconnaît pas les colonnes est refusé aussi
// — jamais deviné.
//
// ⚠ L'ORIENTATION NE SE SUPPOSE PAS : le tableau de la Banque Populaire est
// imprimé en paysage sur une page portrait (texte tourné d'un quart de tour).
// Chaque cellule est ramenée à son repère de lecture : `u` le long du texte,
// `v` en travers, les lignes du haut d'abord.
// ═══════════════════════════════════════════════════════════════════════════

const PAGES_MAX = 80
const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/
// « 0,00 », « 1 235,43 », « 235 000,00 », « 1.235,43 » ; espaces fines et
// insécables comprises.
const MONTANT_RE = /^-?\d{1,3}(?:[   .]?\d{3})*,\d{2}$/
const RANG_RE = /^\d{1,4}$/

const sansAccents = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()

/** « 1 235,43 » → 123543 (centimes), ou `null`. */
function centimes (s) {
  const t = String(s).trim()
  if (!MONTANT_RE.test(t)) return null
  const n = Number(t.replace(/[   .]/g, '').replace(',', ''))
  return Number.isSafeInteger(n) ? n : null
}

/** « 22/03/2022 » → « 2022-03-22 », si la date existe. */
function dateIso (s) {
  const m = DATE_RE.exec(String(s).trim())
  if (!m) return null
  const iso = `${m[3]}-${m[2]}-${m[1]}`
  const d = new Date(iso + 'T00:00:00Z')
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso
}

// La classe d'une colonne, d'après son en-tête (une ou deux lignes). L'ordre
// compte : « CAPITAL RESTANT DU » avant « CAPITAL AMORTI », et un en-tête qui
// parle de RESTANT n'est jamais l'échéance.
function classeDe (entete) {
  const e = sansAccents(entete)
  if (/CAPITALISE/.test(e)) return null
  if (/RESTANT/.test(e)) return /CAPITAL/.test(e) ? 'capital_restant' : null
  if (/INTERET/.test(e)) return 'interets'
  if (/ASSURANCE/.test(e)) return 'assurance'
  if (/ACCESSOIRE|FRAIS|COMMISSION/.test(e)) return 'accessoires'
  if (/AMORTI|AMORTISSEMENT|CAPITAL REMBOURSE/.test(e)) return 'capital'
  if (/ECHEANCE|MENSUALITE/.test(e) && !/DATE/.test(e)) return 'echeance'
  return null
}

/**
 * Les cellules d'une page, dans le repère de lecture :
 * `{ s, u0, u1, v }` — `u0` début du texte, `u1` sa fin (là où s'alignent les
 * montants, cadrés à droite), `v` la ligne (grand = haut).
 */
function cellules (items) {
  const out = []
  for (const it of items) {
    const s = String(it.str || '').trim()
    if (!s || !it.transform) continue
    const [a, b, , , e, f] = it.transform
    const n = Math.hypot(a, b) || 1
    const dx = a / n; const dy = b / n
    const u0 = e * dx + f * dy
    out.push({ s, u0, u1: u0 + (Number(it.width) || 0), v: -e * dy + f * dx, dir: `${Math.round(dx)},${Math.round(dy)}` })
  }
  return out
}

/** Les cellules regroupées en lignes (même `v` à 2 unités près), du haut vers le bas. */
function lignes (cs) {
  const tri = [...cs].sort((p, q) => q.v - p.v || p.u0 - q.u0)
  const out = []
  for (const c of tri) {
    const l = out[out.length - 1]
    if (l && Math.abs(l.v - c.v) <= 2) l.cs.push(c)
    else out.push({ v: c.v, cs: [c] })
  }
  for (const l of out) l.cs.sort((p, q) => p.u0 - q.u0)
  return out
}

// Les colonnes de montants d'une page : les fins de cellule (`u1`) des lignes
// datées, regroupées à 3 unités près.
function colonnesDe (lignesDatees) {
  const fins = []
  for (const l of lignesDatees) for (const c of l.cs) if (centimes(c.s) !== null) fins.push(c)
  fins.sort((p, q) => p.u1 - q.u1)
  const cols = []
  for (const c of fins) {
    const k = cols[cols.length - 1]
    if (k && c.u1 - k.u1max <= 3) { k.u1max = c.u1; k.u0min = Math.min(k.u0min, c.u0); k.u0max = Math.max(k.u0max, c.u1) } else cols.push({ u1min: c.u1, u1max: c.u1, u0min: c.u0, u0max: c.u1 })
  }
  return cols
}

/**
 * Lit les cellules de toutes les pages et rend les échéances prouvées.
 * `pages` : pour chaque page, la liste des `items` de pdf.js
 * (`getTextContent().items`). Séparé de la lecture du PDF pour les tests.
 */
function echeancesDesPages (pages) {
  const echeances = []
  let mapping = null
  for (const items of pages) {
    const cs = cellules(items)
    // L'orientation du tableau : celle des cellules datées.
    const dates = cs.filter(c => dateIso(c.s))
    if (!dates.length) continue
    const dir = dates[0].dir
    const ls = lignes(cs.filter(c => c.dir === dir))
    const datees = ls.filter(l => l.cs.some(c => dateIso(c.s)))
    if (!datees.length) continue
    const cols = colonnesDe(datees)
    // L'en-tête : le texte sans chiffre juste au-dessus de la première ligne
    // datée (sur deux lignes au plus, 45 unités). Une page sans en-tête
    // reprend celui de la page précédente.
    const haut = datees[0].v
    const entetes = ls.filter(l => l.v > haut + 4 && l.v <= haut + 45)
      .flatMap(l => l.cs).filter(c => /[A-Z]/i.test(c.s) && !/\d{3}/.test(c.s))
    // Chaque mot d'en-tête va à LA colonne qu'il recouvre le plus ; un texte
    // qui en recouvre trois ou plus est un titre, pas un en-tête. Un en-tête
    // qui ne donne pas les trois colonnes nécessaires, ou en donne une deux
    // fois, n'en est pas un : la page garde celui de la précédente.
    if (entetes.length) {
      const textes = cols.map(() => [])
      for (const h of entetes) {
        const recouvre = cols.map(k => Math.min(h.u1, k.u0max + 2) - Math.max(h.u0, k.u0min - 2))
        const touchees = recouvre.filter(x => x > 0).length
        if (!touchees || touchees >= 3) continue
        textes[recouvre.indexOf(Math.max(...recouvre))].push(h)
      }
      const m = {}
      let double = false
      for (const [i, hs] of textes.entries()) {
        const classe = classeDe(hs.sort((p, q) => q.v - p.v || p.u0 - q.u0).map(h => h.s).join(' '))
        if (!classe) continue
        if (m[classe] !== undefined) double = true
        m[classe] = i
      }
      if (!double && m.interets !== undefined && m.capital !== undefined && m.echeance !== undefined) mapping = { m, cols }
    }
    if (!mapping) return { ok: false, code: 'tableau_illisible', detail: 'colonnes non reconnues' }
    // Les colonnes de cette page, rapprochées de celles de l'en-tête retenu
    // par leur fin de cellule.
    const colonneDe = (c) => {
      let best = null
      for (const [classe, i] of Object.entries(mapping.m)) {
        const k = mapping.cols[i]
        if (c.u1 >= k.u1min - 3 && c.u1 <= k.u1max + 3) best = classe
      }
      return best
    }
    for (const l of datees) {
      const date = l.cs.map(c => dateIso(c.s)).find(Boolean)
      const ligne = { interets: 0, assurance: 0, accessoires: 0, capital: null, echeance: null, capital_restant: null }
      for (const c of l.cs) {
        const v = centimes(c.s)
        if (v === null) continue
        const classe = colonneDe(c)
        if (classe) ligne[classe] = v
      }
      if (ligne.echeance === null || ligne.capital === null) {
        return { ok: false, code: 'ligne_incoherente', detail: date }
      }
      if (ligne.echeance === 0) continue // un déblocage ou une ligne d'information
      if ([ligne.interets, ligne.assurance, ligne.accessoires, ligne.capital, ligne.echeance].some(x => x < 0)) {
        return { ok: false, code: 'ligne_incoherente', detail: date }
      }
      if (ligne.interets + ligne.assurance + ligne.accessoires + ligne.capital !== ligne.echeance) {
        return { ok: false, code: 'ligne_incoherente', detail: date }
      }
      const rang = l.cs.find(c => RANG_RE.test(c.s) && c.u1 < Math.min(...l.cs.filter(x => dateIso(x.s)).map(x => x.u0)))
      echeances.push({
        indice: echeances.length + 1,
        rang: rang ? Number(rang.s) : null,
        date,
        interets_cents: ligne.interets,
        assurance_cents: ligne.assurance,
        accessoires_cents: ligne.accessoires,
        capital_cents: ligne.capital,
        echeance_cents: ligne.echeance,
        capital_restant_cents: ligne.capital_restant
      })
    }
  }
  if (!echeances.length) return { ok: false, code: 'tableau_illisible', detail: 'aucune échéance' }
  for (let i = 1; i < echeances.length; i++) {
    if (echeances[i].date < echeances[i - 1].date) return { ok: false, code: 'ligne_incoherente', detail: echeances[i].date }
  }
  return { ok: true, echeances }
}

/**
 * Le tableau d'un PDF. `{ ok: true, echeances }` ou
 * `{ ok: false, code, detail }` — `pdf_illisible`, `tableau_illisible`,
 * `ligne_incoherente` (le détail dit la date de la ligne).
 */
async function lireTableau (octets, deps = {}) {
  let pages
  try {
    const { getDocumentProxy } = deps.unpdf || await import('unpdf')
    const pdf = await getDocumentProxy(new Uint8Array(octets))
    if (pdf.numPages > PAGES_MAX) return { ok: false, code: 'tableau_illisible', detail: 'trop de pages' }
    pages = []
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n)
      pages.push((await page.getTextContent()).items)
    }
  } catch (e) {
    return { ok: false, code: 'pdf_illisible', detail: null }
  }
  return echeancesDesPages(pages)
}

module.exports = { lireTableau, echeancesDesPages, centimes, dateIso, classeDe, PAGES_MAX }
