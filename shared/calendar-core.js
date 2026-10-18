// shared/calendar-core.js
// Coeur partage du calendrier (desktop + mobile). Extraction ISO-COMPORTEMENT.
// Primitives pures + chargement (loadCalendarData). La SAUVEGARDE reste dans chaque
// vue pour l'instant (chemin qui pousse les prix reels) et sera extraite en dernier.
import { api } from '/shared/api-client.js'

// --- Constantes de dates / grille ---
// Largeur d'une colonne-jour du planning DESKTOP, en px.
// ⚠ Elargie de 34 a 46 le 15 septembre 2026 : a 34 px, une bulle de
// reservation d'une nuit n'affichait aucun nom, et deux nuits en montraient
// trois lettres. Le planning ne se lisait qu'au survol.
// ⚠ Utilisee par `pages/biens-calendrier.html` UNIQUEMENT — le mobile n'importe
// que `loadCalendarData` et garde sa grille mensuelle intacte.
export const CELL_W = 46
// Largeur de la colonne des libelles (`.row-label`, border-box). C'est LA
// valeur d'alignement entre la bande des jours et la grille des biens : elle
// vit ici, une fois, et sert a computeDays, au colgroup des deux tables et a la
// selection a la souris.
export const LABEL_W = 120
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
// `decalageJours` : depart de la grille, en jours par rapport a AUJOURD'HUI.
// Negatif = passe. Defaut 0 — le comportement d'origine est inchange, et le
// mobile, qui n'appelle pas cette fonction, ne voit rien.
// ⚠ Le jour 0 de la grille n'est donc plus forcement aujourd'hui : tout ce qui
// en dependait (le reperage du jour courant) doit comparer des DATES.
export function computeDays(months, containerW, decalageJours = 0) {
  const t = new Date(); t.setHours(0, 0, 0, 0)
  const d = Number(decalageJours)
  if (Number.isFinite(d) && d !== 0) t.setDate(t.getDate() + d)
  let n = Math.round(months * 30)
  // ⚠ `CELL_W`, jamais une copie : le 34 en dur ici comptait les colonnes avec
  // une largeur que le CSS n'utilisait plus. Elargir la colonne sans toucher a
  // cette ligne aurait genere trop de jours pour la place disponible, donc une
  // barre de defilement horizontale la ou le remplissage devait tomber juste.
  const COLW = CELL_W, LABEL = LABEL_W, PAD = 48
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
    // ⚠ « PAS DE PRIX » N'EST PAS « PRIX A ZERO » — signale par Thierry le
    // 12 septembre 2026. Sur un bien sans `base_price`, toute nuit non tarifee
    // rendait `null`, que les ecrans affichaient « 0 ». L'hote lisait donc des
    // « nuits a 0 € » sur un calendrier ou AUCUNE nuit n'est a zero : elles
    // sont sans tarif, et de ce fait FERMEES (fermeture calculee de
    // runFullSync). Zero est un prix, et un prix dangereux ; l'absence de prix
    // est un etat. Les confondre a coute une inquietude legitime.
    // ⚠ ET ON FERME LA CLASSE, PAS LES DEUX PRODUCTEURS CONNUS — releve en
    // review du 18 octobre 2026. Le correctif du jour tarissait les deux
    // sources d'alors (`Number(null)` dans `loadCalendarData` et dans la page),
    // mais `rate = 0` venu de la BASE produisait toujours « 0 € ». Zero ligne
    // en production ce jour-la — et `lib/moteur-reservation.js:180` affirme
    // l'inverse pour l'avenir : « `rate` peut valoir 0 en base sur des lignes
    // anciennes ». Pire, sur un bien a 86 €, une telle ligne faisait afficher
    // 0 € une nuit que le moteur de reservation vend 86 € : plus un defaut
    // d'affichage, une divergence ecran/moteur.
    //
    // Un tarif <= 0 est donc une ABSENCE de tarif, d'ou qu'il vienne — meme
    // regle que `prixDeBase` ici, que `prixDeBase(ligne, bien)` du moteur de
    // reservation, et que `tarifAcceptable` (raison `zero`) cote serveur.
    // Un tarif <= 0 se comporte donc comme un tarif ABSENT : il laisse la main
    // au prix de base, exactement comme `rate: null`. Sur un bien a 86 €,
    // l'ecran dit 86 € — le prix que le moteur de reservation vend vraiment.
    const brut = (r && Number(r.rate) > 0) ? Number(r.rate) : base
    const rate = Number(brut) > 0 ? Number(brut) : null
    return {
      rate,
      // `true` quand aucun tarif n'est defini, ni pour la nuit ni en prix de
      // base : la nuit n'est vendable nulle part. A afficher « — », pas « 0 ».
      sansPrix: rate == null,
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

// Le prix de base d'un bien, ou `null` s'il n'en a pas. Accepte aussi bien un
// bien brut (`base_price`) qu'une entree de `propsById` (`base`).
//
// ⚠ C'EST PAR ICI QUE LE ZERO REVENAIT, MALGRE LA GARDE DE buildStateFromInventory.
// Signale par Thierry le 18 octobre 2026, sur Ofuro Futari : 1249 nuits sans
// tarif s'affichaient « 0 € ». La garde plus haut sait depuis le 12 septembre
// qu'une nuit sans tarif n'est pas une nuit a zero — mais elle recevait deja
// `0`, donc elle n'avait rien a refuser : `Number(null)` vaut 0, et
// `Number.isFinite(0)` vaut true. Le defaut etait en AMONT du garde-fou.
//
// Un `base_price` a 0 est traite comme une ABSENCE, pas comme un prix : zero
// est precisement le prix que les plateformes ignorent, en gardant celui de la
// grille (docs/kb/prix-plancher.md). Le laisser passer pour un prix de base
// reconstruirait le meme « 0 € » sous un autre nom.
// ⚠ LES DEUX FORMES SONT ESSAYEES, PAS CLASSEES — releve en review. Donner la
// priorite a `base_price` faisait perdre le `base` d'un objet portant les deux,
// dont `{ base_price: 0, base: 199 }` : la forme choisie decidait du resultat.
export function prixDeBase (p) {
  if (p == null) return null
  for (const brut of [p.base_price, p.base]) {
    if (brut === null || brut === undefined || brut === '') continue
    const n = Number(brut)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

// --- Chargement (api.calendar.load) + normalisation. Logique VERBATIM de reloadInventory.
// Retourne des donnees BRUTES ; l'application a l'etat (invByBien/ppConfig/resa) et le
// rendu restent dans chaque vue. propsById.base = prixDeBase(p) : `null` quand
// le bien n'a pas de prix de base, JAMAIS 0.
export async function loadCalendarData(selectedBiens, start, end) {
  const r = await api.calendar.load(selectedBiens, start, end)
  const inv = {}
  selectedBiens.forEach(id => { inv[id] = (r && r.inventory && r.inventory[id]) || {} })
  const pp = {}, propsById = {}, rawProps = {}
  if (r && r.properties) r.properties.forEach(p => {
    pp[p.id] = { included: p.included_guests || p.capacity || 1, extraFee: Number(p.extra_guest_fee) || 0 }
    propsById[p.id] = { base: prixDeBase(p), included: pp[p.id].included, extraFee: pp[p.id].extraFee }
    rawProps[p.id] = p   // objet propriete brut (capacity, orphan_*, etc.) -> superset pour mobile
  })
  // Les fermetures de l'hote (lot 4.6.2), par bien : l'ecran les affiche avec
  // leur raison et permet de les retirer. Il ne les lit JAMAIS pour decider si
  // une nuit est vendable — ca, c'est `inv` (calendar_inventory).
  return { inv, pp, propsById, bookings: (r && r.bookings) || null, rawProps, fermetures: (r && r.fermetures) || {} }
}
