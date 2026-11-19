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
// serveur, jamais distribuée), puis `jpeg-js` (BSD). Chargée à la demande :
// un envoi PDF ou JPEG ne la paie pas.
// ═══════════════════════════════════════════════════════════════════════════

// La même réduction que les photos préparées par le téléphone
// (shared/photo-bien-client.js) : 2 000 px au plus, puis la qualité baisse
// jusqu'à tenir sous la borne d'une image lue par l'IA.
const COTE_MAX = 2000
const QUALITES = [80, 65, 50]

class ConversionImpossible extends Error {
  constructor (motif) { super(motif); this.name = 'ConversionImpossible'; this.motif = motif }
}

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
 * Convertit des octets HEIC en un JPEG d'au plus `max` octets.
 * Lève `ConversionImpossible` (motif `decodage` ou `trop_gros`) : l'appelant
 * efface le fichier et le dit, il ne réessaie pas en boucle.
 * `deps.decode`, `deps.encode` : des doubles pour les tests.
 */
async function heicEnJpeg (octets, { max }, deps = {}) {
  const decode = deps.decode || require('heic-decode')
  const encode = deps.encode || require('jpeg-js').encode
  let image
  try {
    image = await decode({ buffer: octets })
  } catch (e) {
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

module.exports = { heicEnJpeg, reduire, ConversionImpossible, COTE_MAX, QUALITES }
