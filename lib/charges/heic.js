// ═══════════════════════════════════════════════════════════════════════════
// lib/charges/heic.js — UNE PHOTO HEIC CONVERTIE EN JPEG, SUR NOTRE SERVEUR
// Spec : docs/specs/spec-compte-de-charges.md §14.19
//
// ⚠ POURQUOI ICI, ET PAS DANS LE NAVIGATEUR NI CHEZ UN TIERS (décision de
// Thierry, 19 novembre 2026, option 2). Ses factures arrivent par SMS en HEIC,
// et Chrome (Android, PC) ne sait pas lire ce format. Un service en ligne
// aurait reçu ses factures — noms, adresses, montants — et n'est gratuit que
// pour quelques conversions par jour. Un décodeur dans le navigateur pèserait
// 2 à 3 Mo à chaque photo. Ici : rien ne sort de chez nous, et rien ne pèse sur
// le téléphone.
//
// ⚠ L'IA ET LE STOCKAGE NE VOIENT JAMAIS DE HEIC : la photo reçue est
// convertie à la confirmation de l'envoi, et le JPEG la REMPLACE dans le
// bucket (`lib/charges.js`, `confirmerEnvoi`). La relecture par le cron lit
// donc un JPEG, comme pour toute photo.
//
// La chaîne : `heic-decode` (ISC) sur `libheif-js` (LGPL-3.0, exécutée sur le
// serveur, jamais distribuée), puis `jpeg-js` (BSD).
//
// ⚠ LE DÉCODEUR NE TOURNE JAMAIS DANS LE FIL PRINCIPAL (review du lot,
// constat de sécurité 1) : `convertirIsole` le lance dans un PROCESSUS enfant
// À USAGE UNIQUE (lib/charges/fil-isole.js), tué à la fin, borné à 15 s et à
// 1 Go de mémoire résidente. Le tas WebAssembly de
// libheif ne rétrécit jamais, et `heic-decode` le laisse fuir quand un fichier
// ne se lit pas (≈ 12 Mo par échec de 10 Mo, mesuré) : en boucle, une instance
// Vercel finissait gelée ou plantée, et refusait ensuite les vraies photos des
// autres hôtes. Un processus tué après chaque photo rend toute sa mémoire au
// système, quoi que le décodeur ait fait — un fil (`worker_threads`) ne la
// rendait pas (§14.20, seconde review du lot crédit). Le processus principal
// ne charge même pas le décodeur.
// ═══════════════════════════════════════════════════════════════════════════

// La même réduction que les photos préparées par le téléphone
// (shared/photo-bien-client.js) : 2 000 px au plus, puis la qualité baisse
// jusqu'à tenir sous la borne d'une image lue par l'IA.
const COTE_MAX = 2000
const QUALITES = [80, 65, 50]
// ⚠ UNE PHOTO DÉCLARE SES DIMENSIONS AVANT D'ÊTRE DÉCODÉE, et c'est là qu'on la
// borne : 4 octets par pixel, une image annoncée à 20 000 × 20 000 demanderait
// 1,6 Go — la fonction tomberait pour un fichier de quelques Ko. 50 Mpx couvre
// le plus grand capteur de téléphone (48 Mpx, 8 064 × 6 048).
const PIXELS_MAX = 50 * 1000 * 1000

// Le FICHIER ne se convertit pas : la photo est refusée (422) et effacée.
class ConversionImpossible extends Error {
  constructor (motif) { super(motif); this.name = 'ConversionImpossible'; this.motif = motif }
}
// LE CONVERTISSEUR est en panne (délai, fil planté, module absent) : ce
// n'est pas la faute de la photo — rien n'est effacé (503), comme toute panne
// du dépôt (`telecharger`, `lecturesEntites`).
class PanneConversion extends Error {
  constructor (motif, detail = null) {
    super(motif)
    this.name = 'PanneConversion'
    this.motif = motif
    // La cause, pour le journal seulement (seconde review, constat 3) : sans
    // elle, des 503 répétés ne se diagnostiquent pas.
    this.detail = detail ? String(detail).slice(0, 200) : null
  }
}
const DELAI_CONVERSION_MS = 15000

/**
 * Réduit une image RGBA (`{ width, height, data }`) à `cote` pixels au plus
 * sur son grand côté. Par moitiés exactes (moyenne de 2 × 2) tant qu'on est
 * au-dessus du double, puis une interpolation bilinéaire : le texte d'une
 * facture reste net, sans le crénelage d'un simple échantillonnage.
 */
function reduire (img, cote = COTE_MAX) {
  let { width: l, height: h, data: d } = img
  while (Math.max(l, h) >= 2 * cote) {
    const l2 = Math.floor(l / 2)
    const h2 = Math.floor(h / 2)
    const s = new Uint8ClampedArray(l2 * h2 * 4)
    for (let y = 0; y < h2; y++) {
      for (let x = 0; x < l2; x++) {
        const a = ((2 * y) * l + 2 * x) * 4
        const b = a + l * 4
        const o = (y * l2 + x) * 4
        for (let c = 0; c < 4; c++) s[o + c] = (d[a + c] + d[a + 4 + c] + d[b + c] + d[b + 4 + c] + 2) >> 2
      }
    }
    l = l2; h = h2; d = s
  }
  const ratio = Math.min(1, cote / Math.max(l, h))
  if (ratio === 1) return { width: l, height: h, data: d }
  const L = Math.max(1, Math.round(l * ratio))
  const H = Math.max(1, Math.round(h * ratio))
  const s = new Uint8ClampedArray(L * H * 4)
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, (y + 0.5) / ratio - 0.5)
    const y0 = Math.max(0, Math.floor(sy)); const y1 = Math.min(h - 1, y0 + 1); const fy = sy - y0
    for (let x = 0; x < L; x++) {
      const sx = Math.min(l - 1, (x + 0.5) / ratio - 0.5)
      const x0 = Math.max(0, Math.floor(sx)); const x1 = Math.min(l - 1, x0 + 1); const fx = sx - x0
      const o = (y * L + x) * 4
      for (let c = 0; c < 4; c++) {
        const p00 = d[(y0 * l + x0) * 4 + c]; const p01 = d[(y0 * l + x1) * 4 + c]
        const p10 = d[(y1 * l + x0) * 4 + c]; const p11 = d[(y1 * l + x1) * 4 + c]
        s[o + c] = Math.round(p00 * (1 - fx) * (1 - fy) + p01 * fx * (1 - fy) + p10 * (1 - fx) * fy + p11 * fx * fy)
      }
    }
  }
  return { width: L, height: H, data: s }
}

/**
 * La première image du conteneur, décodée seulement si ses dimensions
 * DÉCLARÉES tiennent sous `PIXELS_MAX`.
 * ⚠ `dispose` ne rend pas TOUT : un fichier illisible fait lever
 * `heic-decode` AVANT qu'il ne rende de quoi libérer, et le tas WebAssembly ne
 * rétrécit jamais. D'où le fil à usage unique de `convertirIsole` : c'est lui
 * qui rend la mémoire, en mourant.
 */
async function decoderPremiere ({ buffer }, toutes = (o) => require('heic-decode').all(o)) {
  const images = await toutes({ buffer })
  try {
    const premiere = images[0]
    if (!premiere || !(premiere.width > 0) || !(premiere.height > 0)) throw new ConversionImpossible('decodage')
    if (premiere.width * premiere.height > PIXELS_MAX) throw new ConversionImpossible('trop_grande')
    return await premiere.decode()
  } finally {
    images.dispose()
  }
}

/**
 * Convertit des octets HEIC en un JPEG d'au plus `max` octets.
 * Lève `ConversionImpossible` (motif `decodage`, `trop_grande` ou
 * `trop_gros`) : l'appelant
 * efface le fichier et le dit, il ne réessaie pas en boucle.
 * `deps.decode`, `deps.encode` : des doubles pour les tests.
 */
async function heicEnJpeg (octets, { max }, deps = {}) {
  const decode = deps.decode || decoderPremiere
  const encode = deps.encode || require('jpeg-js').encode
  let image
  try {
    image = await decode({ buffer: octets })
  } catch (e) {
    if (e instanceof ConversionImpossible) throw e
    // Un module absent n'est pas une photo illisible (review, constat 2).
    if (e && e.code === 'MODULE_NOT_FOUND') throw new PanneConversion('module_absent')
    throw new ConversionImpossible('decodage')
  }
  if (!image || !image.width || !image.height || !image.data) throw new ConversionImpossible('decodage')
  const petite = reduire(image)
  for (const qualite of QUALITES) {
    const sortie = encode({ data: petite.data, width: petite.width, height: petite.height }, qualite)
    const jpeg = Buffer.from(sortie && sortie.data ? sortie.data : [])
    if (jpeg.length && jpeg.length <= max) return jpeg
  }
  throw new ConversionImpossible('trop_gros')
}

// Le fichier du fil, nommé par `require.resolve` : le traçage des fonctions
// Vercel l'embarque avec ses dépendances.
const FICHIER_DU_FIL = require.resolve('./heic-fil.js')

// ⚠ UN SEUL FIL À LA FOIS PAR INSTANCE, ET UNE FILE COURTE (seconde review,
// constat de sécurité 1) : chaque fil a son propre tas WebAssembly. Trois
// photos de 48 Mpx converties en même temps montaient à 2,1 Go — au-dessus
// des 2 Go d'une fonction, avec les requêtes des autres hôtes servies par la
// même instance. Les conversions passent donc l'une après l'autre, dans la
// file COMMUNE aux travaux lourds (`FILE_LOURDE`, lib/charges/fil-isole.js,
// partagée avec la lecture des tableaux d'amortissement depuis la seconde
// review du lot crédit) ; au-delà de `FILE_MAX` en attente, la photo est
// refusée « occupé » (503, rien d'effacé : l'hôte réessaie). Le délai de 15 s
// court DEPUIS L'APPEL, attente comprise : la fonction reste sous ses 60 s.
const { executer, PanneFil, FILE_LOURDE } = require('./fil-isole')
const FILE_MAX = FILE_LOURDE.max
// La borne de mémoire du fil. Mesuré le 19 novembre 2026 sous la garde : une
// photo réelle de 48 Mpx (7 Mo) monte le processus à 790 Mo, soit ~740 Mo
// au-dessus de sa base — d'où 1 Go, et non les 512 Mo d'un tableau. Avec la
// file commune, un seul fil lourd vit à la fois : base + 1 Go reste sous les
// 2 Go d'une fonction.
const MEMOIRE_CONVERSION = 1024 * 1024 * 1024

/**
 * Convertit dans un processus À USAGE UNIQUE, tué à la fin quoi qu'il arrive,
 * un seul travail lourd à la fois par instance. Rend le JPEG ; lève
 * `ConversionImpossible` (le fichier) ou `PanneConversion` (`occupe`,
 * `delai`, `memoire`, fil planté ou sorti sans répondre, module absent — avec
 * sa cause dans `detail`). `deps.Worker` : un double pour les tests.
 */
async function convertirIsole (octets, { max, delaiMs = DELAI_CONVERSION_MS } = {}, deps = {}) {
  // Une COPIE transférée : le fil la possède, le tampon de l'appelant reste intact.
  const copie = Uint8Array.from(octets)
  let m
  try {
    m = await executer(FILE_LOURDE, {
      fichier: FICHIER_DU_FIL,
      entree: copie,
      transfert: [copie.buffer],
      delaiMs,
      workerData: { max },
      memoireMax: MEMOIRE_CONVERSION
    }, deps)
  } catch (e) {
    if (e instanceof PanneFil) throw new PanneConversion(e.motif, e.detail)
    throw new PanneConversion('fil', e && e.message)
  }
  if (m && m.ok && m.jpeg) return Buffer.from(m.jpeg)
  if (m && m.motif) throw new ConversionImpossible(m.motif)
  throw new PanneConversion((m && m.panne) || 'reponse_vide', m && m.cause)
}

module.exports = {
  heicEnJpeg, convertirIsole, decoderPremiere, reduire, ConversionImpossible, PanneConversion,
  COTE_MAX, QUALITES, PIXELS_MAX, DELAI_CONVERSION_MS, FILE_MAX
}
