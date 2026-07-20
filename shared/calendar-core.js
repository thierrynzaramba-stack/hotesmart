// shared/calendar-core.js
// Coeur partage du calendrier (desktop + mobile). Extraction ISO-COMPORTEMENT :
// primitives PURES uniquement (aucun DOM, aucun etat module, aucun effet de bord).
// Le chargement / la sauvegarde ARI seront ajoutes en etapes ulterieures, verifies un
// par un — le chemin de sauvegarde Base (qui pousse les prix reels) ne doit pas changer.

// --- Constantes de dates / grille ---
export const CELL_W = 34
export const dayNames = ['DIM', 'LUN', 'MAR', 'MER', 'JEU', 'VEN', 'SAM']
export const dowOrder = [1, 2, 3, 4, 5, 6, 0]
export const dowLabels = { 1: 'Lun', 2: 'Mar', 3: 'Mer', 4: 'Jeu', 5: 'Ven', 6: 'Sam', 0: 'Dim' }
export const monthShort = ['jan', 'fev', 'mar', 'avr', 'mai', 'juin', 'juil', 'aout', 'sep', 'oct', 'nov', 'dec']
export const monthFull = ['Janvier', 'Fevrier', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Aout', 'Septembre', 'Octobre', 'Novembre', 'Decembre']

// --- Formatters purs ---
export const toISO = (d) => { const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), j = String(d.getDate()).padStart(2, '0'); return y + '-' + m + '-' + j }
export const fmtShort = (d) => d.getDate() + ' ' + monthShort[d.getMonth()]
export function curSym(c) { const m = { EUR: String.fromCharCode(38) + "euro;", USD: "$", GBP: "&pound;", CHF: "CHF ", CAD: "C$" }; return m[(c || "EUR").toUpperCase()] || ((c || "EUR") + " ") }

// --- Config des parametres editables (ordre et libelles) ---
export const PARAMS = [
  { key: 'rate', label: 'Prix de base', type: 'price', desc: 'Tarif par nuit pour le nombre de voyageurs inclus.' },
  { key: 'perPerson', label: 'Prix par personne', type: 'perperson', desc: 'Configuration globale du bien. Le prix de base couvre un nombre de voyageurs inclus ; au-dela, un supplement par personne s\u0027applique.' },
  { key: 'avail', label: 'Disponibilite', type: 'openclosed', optOpen: 'Ouvert', optClosed: 'Ferme', desc: 'Ouvre ou ferme la date a la reservation.' },
  { key: 'minStayArr', label: 'Min nuits (arrivee)', type: 'num', desc: 'Nombre minimum de nuits si le voyageur arrive ce jour-la.' },
  { key: 'minStayThrough', label: 'Min nuits (sejour)', type: 'num', desc: 'Nombre minimum de nuits pour tout sejour couvrant cette date.' },
  { key: 'maxStay', label: 'Max nuits', type: 'num', desc: 'Nombre maximum de nuits pour un sejour incluant cette date.' },
  { key: 'cta', label: 'Arrivee', type: 'openclosed', optOpen: 'Autorisee', optClosed: 'Bloquee', desc: 'Autorise ou bloque les arrivees ce jour-la.' },
  { key: 'ctd', label: 'Depart', type: 'openclosed', optOpen: 'Autorise', optClosed: 'Bloque', desc: 'Autorise ou bloque les departs ce jour-la.' },
  { key: 'stopSell', label: 'Stop vente', type: 'openclosed', optOpen: 'En vente', optClosed: 'Stoppe', desc: 'Arrete la vente sur tous les canaux sans modifier la disponibilite reelle.' }
]
export const ROW_DEFAULTS = { avail: 'open', minStayArr: 0, minStayThrough: 0, maxStay: 0, cta: 'open', ctd: 'open', stopSell: 'open' }

// --- Logique de dates / etat (PURE : dependances passees en parametres) ---

// Genere les jours consecutifs de la grille. months = periode ; containerW = largeur
// dispo en px (remplissage). Logique VERBATIM de l'ancien buildDays (partie calcul).
export function computeDays(months, containerW) {
  const t = new Date(); t.setHours(0, 0, 0, 0)
  let n = Math.round(months * 30)
  const COLW = 34, LABEL = 120, PAD = 48
  const avail = Math.max(0, (containerW || 0) - LABEL - PAD)
  const fit = Math.floor(avail / COLW)
  if (fit > n) n = fit
  const out = []
  for (let i = 0; i < n; i++) { const d = new Date(t); d.setDate(t.getDate() + i); out.push(d) }
  return out
}

// Construit l'etat editable d'un bien depuis son inventaire. VERBATIM de l'ancien initState.
export function buildStateFromInventory(days, inv, base) {
  const src = inv || {}
  return days.map(d => {
    const iso = toISO(d)
    const r = src[iso]
    const rate = (r && r.rate != null) ? Number(r.rate) : base
    return {
      rate,
      avail: (r && r.avail === 0) ? 'closed' : 'open',
      minStayArr: (r && r.min_stay_arrival) || 0,
      minStayThrough: (r && r.min_stay_through) || 0,
      maxStay: (r && r.max_stay) || 0,
      cta: (r && r.cta) ? 'closed' : 'open',
      ctd: (r && r.ctd) ? 'closed' : 'open',
      stopSell: (r && r.stop_sell) ? 'closed' : 'open',
      modified: false
    }
  })
}

// Params effectivement configures (non-defaut) sur les biens selectionnes. VERBATIM.
export function configuredRowParams(selectedBiens, states) {
  const setp = new Set()
  selectedBiens.forEach(bid => { const st = states[bid]; if (!st) return; st.forEach(s => { for (const k in ROW_DEFAULTS) { if (s[k] !== ROW_DEFAULTS[k]) setp.add(k) } }) })
  return setp
}
