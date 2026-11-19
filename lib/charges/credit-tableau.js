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
// ⚠ LES FLUX COMPRESSÉS SE BORNENT AVANT pdf.js (review du lot, constat S1) :
// pdf.js décompresse sans plafond, et ses tampons ne comptent pas dans le tas
// JavaScript que borne le fil. Un PDF de 1,2 Mo décompressait 400 Mo (5,3 Go
// au pic). Le vrai tableau de la Banque Populaire : 36 flux, 2,4 Mo
// décompressés en tout, 0,7 Mo pour le plus gros.
// Bornes larges (×5 sur le plus gros flux réel) et serrées à la fois : un même
// flux peut servir à 80 pages, que pdf.js décompresse à chaque fois.
const FLUX_MAX = 4 * 1024 * 1024
const FLUX_TOTAL_MAX = 16 * 1024 * 1024
const DELAI_LECTURE_MS = 20000
// Le tas JavaScript du fil : le vrai tableau (16 pages) se lit avec bien moins.
const LIMITES_FIL = { maxOldGenerationSizeMb: 256 }
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
    // Une ligne du tableau porte une date ET au moins trois montants : une
    // date seule au-dessus du tableau (« Date d'effet : 15/01/2025 ») n'en est
    // pas une, et ne doit pas cacher l'en-tête (review, mineur 4).
    const datees = ls.filter(l => l.cs.some(c => dateIso(c.s)) && l.cs.filter(c => centimes(c.s) !== null).length >= 3)
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
      // Un déblocage ou une ligne d'information : rien à payer, rien d'amorti
      // — même quand ses cellules d'échéance ou de capital sont vides (review,
      // mineur 3). Elle s'écarte avant toute preuve.
      if (!ligne.echeance && !ligne.capital && !ligne.interets && !ligne.assurance && !ligne.accessoires) continue
      if (ligne.echeance === null || ligne.capital === null) {
        return { ok: false, code: 'ligne_incoherente', detail: date }
      }
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

// ASCII85 (`/ASCII85Decode`, `/A85`) : le texte d'un flux que certains
// générateurs (ReportLab, par exemple) placent AVANT la compression.
function ascii85 (b) {
  const s = b.toString('latin1').replace(/\s+/g, '').replace(/^<~/, '')
  const fin = s.indexOf('~>')
  const c = fin >= 0 ? s.slice(0, fin) : s
  const out = []
  let groupe = []
  const vider = (n) => {
    let v = 0
    for (let i = 0; i < 5; i++) v = v * 85 + (i < groupe.length ? groupe[i] : 84)
    for (let i = 0; i < n; i++) out.push((v >>> (24 - 8 * i)) & 0xFF)
  }
  for (const ch of c) {
    if (ch === 'z' && !groupe.length) { out.push(0, 0, 0, 0); continue }
    const x = ch.charCodeAt(0) - 33
    if (x < 0 || x > 84) throw new Error('ascii85')
    groupe.push(x)
    if (groupe.length === 5) { vider(4); groupe = [] }
  }
  if (groupe.length) vider(groupe.length - 1)
  return Buffer.from(out)
}
const asciiHex = (b) => Buffer.from(b.toString('latin1').replace(/[^0-9A-Fa-f]/g, '').replace(/^(.(..)*)$/, '$10'), 'hex')

/** `texte` sans ses chaînes littérales `( … )` ; `null` si elles ne s'équilibrent pas. */
function sansChaines (texte) {
  let out = ''
  let prof = 0
  for (let i = 0; i < texte.length; i++) {
    const c = texte[i]
    if (prof === 0) {
      if (c === ')') return null
      if (c === '(') prof = 1
      else out += c
    } else if (c === '\\') i++
    else if (c === '(') prof++
    else if (c === ')') { prof--; if (prof === 0) out += ' ' }
  }
  return prof === 0 ? out : null
}

/**
 * Les flux compressés d'un PDF, décompressés UNE fois sous une borne, avant
 * que pdf.js ne les touche, en suivant la chaîne de leurs filtres. Rend `null`
 * si tout tient, sinon le motif du refus :
 *   · `flux_trop_gros` — un flux, ou leur total, dépasse sa borne ;
 *   · `flux_illisible` — un flux compressé que zlib refuse (pdf.js, plus
 *     tolérant, le décompresserait quand même, sans borne), ou un flux sans
 *     fin ;
 *   · `filtre_non_pris` — un filtre qui n'est pas décompressé ici (LZW,
 *     RunLength, Brotli, tout filtre inconnu), ou un filtre d'image hors
 *     d'une image (une image, elle, est sautée : pdf.js ne la lit pas) ;
 *   · `flux_suspect` — une forme que pdf.js lit mais que ce contrôle ne sait
 *     pas suivre : clé `/F`, `/Filter` indirect ou répété, nom échappé (`#`),
 *     commentaire ou chaîne déséquilibrée dans le dictionnaire, mot `stream`
 *     sans sa fin de ligne réglementaire.
 *
 * ⚠ CE N'EST PAS UN ANALYSEUR DE PDF, ET IL NE SUFFIT PAS (seconde review,
 * S1) : il refuse ce qu'il reconnaît, et il refuse ce qu'il ne sait pas
 * suivre — « fermé par défaut ». Mais un flux légal répété 600 fois dans
 * `/Contents` passe tous ses contrôles. La borne qui tient, c'est la garde de
 * mémoire du fil (lib/charges/fil-isole.js) ; ce contrôle-ci refuse vite, et
 * pour pas cher, ce qui se voit.
 */
// Le blanc du lexeur de pdf.js : NUL, tabulation, LF, FF, CR, espace. PAS le
// `\s` de JavaScript (troisième review du crédit, mineur 1) : pdf.js tient
// NUL pour un blanc et JavaScript non ; JavaScript tient 0xA0 et `\v` pour des
// blancs et pdf.js non — un NUL avant `stream` cachait une bombe au contrôle,
// un faux `stream` après 0xA0 lui faisait sauter la vraie.
const BL = '[\\0\\t\\n\\f\\r ]'

function fluxSousBorne (octets) {
  const zlib = require('node:zlib')
  const s = octets.toString('latin1')
  // ⚠ UN PDF CHIFFRÉ ne se lit pas ici : ses flux ne se décompressent
  // qu'après déchiffrement. Les banques en livrent souvent, protégés par un
  // simple mot de passe de propriétaire, que pdf.js ouvre sans mot de passe
  // (troisième review du crédit, mineur 7 : 12 sur 12 étaient refusés). Le
  // contrôle s'efface donc, et c'est la garde de mémoire qui borne.
  if (new RegExp(`/Encrypt${BL}*(\\d+${BL}+\\d+${BL}+R|<<)`).test(s)) return null
  const entetes = []
  for (const x of s.matchAll(/(?<![0-9])\d+[\0\t\n\f\r ]+\d+[\0\t\n\f\r ]+obj(?![A-Za-z0-9])/g)) entetes.push(x.index)
  const dernierEnteteAvant = (i) => {
    let bas = 0
    let haut = entetes.length - 1
    let trouve = -1
    while (bas <= haut) {
      const milieu = (bas + haut) >> 1
      if (entetes[milieu] < i) { trouve = entetes[milieu]; bas = milieu + 1 } else haut = milieu - 1
    }
    return trouve
  }
  // Le mot `stream` tel que le lexeur de pdf.js le lit : borné par un blanc
  // ou un délimiteur des deux côtés (« Livestream » ou « stream-x » dans un
  // titre n'en sont pas).
  const re = /(?<=^|[\0\t\n\f\r ()<>[\]{}/%])stream(?=[\0\t\n\f\r ()<>[\]{}/%])/g
  let total = 0
  let m
  while ((m = re.exec(s))) {
    const apres = m.index + 'stream'.length
    // Après le mot `stream`, LF ou CRLF, et rien d'autre (PDF 32000 §7.3.8.1).
    const fdl = s.startsWith('\r\n', apres) ? 2 : s[apres] === '\n' ? 1 : 0
    if (!fdl) return 'flux_suspect'
    const debut = apres + fdl
    const h = dernierEnteteAvant(m.index)
    if (h < 0) return 'flux_suspect'
    // Les chaînes du dictionnaire sont retirées avant de le lire : un
    // `(/Filter /DCTDecode)` est un leurre, pas un filtre. Une chaîne
    // déséquilibrée (un faux en-tête d'objet logé dans une chaîne) est
    // suspecte.
    const dico = sansChaines(s.slice(h, m.index))
    if (dico === null || /[%#]/.test(dico)) return 'flux_suspect'
    if (/\/F(?![A-Za-z0-9])/.test(dico)) return 'flux_suspect'
    const cles = dico.match(/\/Filter(?![A-Za-z0-9])/g) || []
    if (cles.length > 1) return 'flux_suspect'
    let filtres = []
    if (cles.length) {
      const f = /\/Filter[\0\t\n\f\r ]*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(dico)
      if (!f || (f[1][0] === '[' && !/^\[[\0\t\n\f\r ]*(\/[A-Za-z0-9]+[\0\t\n\f\r ]*)*\]$/.test(f[1]))) return 'flux_suspect'
      filtres = (f[1].match(/\/[A-Za-z0-9]+/g) || []).map(x => x.slice(1))
    }
    // L'étendue du flux, comme pdf.js la prend : `/Length` s'il tombe sur
    // `endstream`, sinon le premier `endstream`.
    let longueur = null
    const lDirecte = /\/Length[\0\t\n\f\r ]+(\d+)(?![\0\t\n\f\r ]+\d+[\0\t\n\f\r ]+R)/.exec(dico)
    const lIndirecte = /\/Length[\0\t\n\f\r ]+(\d+)[\0\t\n\f\r ]+(\d+)[\0\t\n\f\r ]+R/.exec(dico)
    if (lIndirecte) {
      const o = new RegExp(`(?<![0-9])${lIndirecte[1]}${BL}+${lIndirecte[2]}${BL}+obj${BL}*(\\d+)${BL}*endobj`).exec(s)
      if (o) longueur = Number(o[1])
    } else if (lDirecte) longueur = Number(lDirecte[1])
    let fin = -1
    if (longueur !== null && /^[\0\t\n\f\r ]*endstream/.test(s.slice(debut + longueur, debut + longueur + 64))) fin = debut + longueur
    else fin = s.indexOf('endstream', debut)
    if (fin < 0) return 'flux_illisible'
    re.lastIndex = fin + 'endstream'.length
    // Une IMAGE n'est jamais décodée par pdf.js pour lire le texte : elle ne
    // se décompresse pas ici non plus (troisième review du crédit, mineur 7 :
    // un logo Flate de plus de 4 Mo une fois décompressé faisait refuser un
    // tableau honnête). Une bombe déguisée en image, appelée comme contenu,
    // passe ce contrôle — c'est la garde de mémoire qui la tient.
    if (/\/Subtype[\0\t\n\f\r ]*\/Image(?![A-Za-z0-9])/.test(dico)) continue
    let donnees = octets.subarray(debut, fin)
    for (const filtre of filtres) {
      if (filtre === 'ASCII85Decode' || filtre === 'A85') {
        try { donnees = ascii85(donnees) } catch (e) { return 'flux_illisible' }
      } else if (filtre === 'ASCIIHexDecode' || filtre === 'AHx') {
        donnees = asciiHex(donnees)
      } else if (filtre === 'FlateDecode' || filtre === 'Fl') {
        // Comme pdf.js : l'en-tête zlib est vérifié (méthode 8, somme de
        // l'en-tête, pas de dictionnaire), la somme de contrôle de fin ne
        // l'est pas — un flux honnête mais négligé passe, comme chez lui.
        if (donnees.length < 2 || (donnees[0] & 0x0f) !== 8 || ((donnees[0] << 8) | donnees[1]) % 31 !== 0 || (donnees[1] & 0x20)) return 'flux_illisible'
        try {
          // `Z_SYNC_FLUSH` : un flux tronqué se décompresse aussi loin que
          // pdf.js irait — et se compte.
          donnees = zlib.inflateRawSync(donnees.subarray(2), { maxOutputLength: FLUX_MAX, finishFlush: zlib.constants.Z_SYNC_FLUSH })
        } catch (e) {
          if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError)) return 'flux_trop_gros'
          return 'flux_illisible'
        }
        total += donnees.length
        if (total > FLUX_TOTAL_MAX) return 'flux_trop_gros'
      } else {
        return 'filtre_non_pris' // LZW, RunLength, JBIG2, Brotli, inconnu, ou un filtre d'image hors d'une image
      }
    }
  }
  return null
}

/**
 * Le tableau d'un PDF. `{ ok: true, echeances }` ou
 * `{ ok: false, code, detail }` — `pdf_illisible`, `tableau_illisible`,
 * `ligne_incoherente` (le détail dit la date de la ligne).
 */
async function lireTableau (octets, deps = {}) {
  const borne = fluxSousBorne(octets)
  if (borne) return { ok: false, code: 'tableau_illisible', detail: borne }
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

const { executer, PanneFil, FILE_LOURDE, MEMOIRE_MAX_DEFAUT } = require('./fil-isole')
// Le fichier du fil, nommé par `require.resolve` : le traçage des fonctions
// Vercel l'embarque avec ses dépendances.
const FICHIER_DU_FIL = require.resolve('./credit-tableau-fil.js')

/**
 * `lireTableau`, dans un processus à usage unique (lib/charges/fil-isole.js) :
 * 20 s au plus, attente comprise, un tas de 256 Mo, et 512 Mo de mémoire
 * résidente pour tout l'enfant. Un tableau qui dépasse l'une de ces bornes
 * en ayant eu son délai entier est REFUSÉ (`tableau_illisible`, rien n'est
 * écrit) ; une instance occupée — file pleine, ou délai mangé par l'attente —
 * rend une panne (`{ panne: 'occupe' }`, 503 : l'hôte réessaie).
 */
async function lireTableauIsole (octets, { delaiMs = DELAI_LECTURE_MS, memoireMax = MEMOIRE_MAX_DEFAUT, cle = null } = {}, deps = {}) {
  const copie = Uint8Array.from(octets)
  try {
    const r = await executer(FILE_LOURDE, { fichier: FICHIER_DU_FIL, entree: copie, transfert: [copie.buffer], delaiMs, limites: LIMITES_FIL, memoireMax, cle }, deps)
    return r && typeof r === 'object' ? r : { ok: false, code: 'pdf_illisible', detail: null }
  } catch (e) {
    if (e instanceof PanneFil && e.motif === 'occupe') return { panne: 'occupe' }
    if (e instanceof PanneFil && (e.motif === 'delai' || e.motif === 'memoire')) return { ok: false, code: 'tableau_illisible', detail: e.motif === 'delai' ? 'trop_long' : 'trop_lourd' }
    console.error('[charges] lecture du tableau', e && e.motif, e && e.detail)
    return { panne: (e && e.motif) || 'fil' }
  }
}

module.exports = {
  lireTableau, lireTableauIsole, echeancesDesPages, fluxSousBorne, centimes, dateIso, classeDe,
  PAGES_MAX, FLUX_MAX, FLUX_TOTAL_MAX, DELAI_LECTURE_MS
}
