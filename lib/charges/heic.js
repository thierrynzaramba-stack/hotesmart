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
// constat de sécurité 1) : `convertirIsole` le lance dans un `worker_threads`
// À USAGE UNIQUE, terminé à la fin, borné à 15 s. Le tas WebAssembly de
// libheif ne rétrécit jamais, et `heic-decode` le laisse fuir quand un fichier
// ne se lit pas (≈ 12 Mo par échec de 10 Mo, mesuré) : en boucle, une instance
// Vercel finissait gelée ou plantée, et refusait ensuite les vraies photos des
// autres hôtes. Un fil jeté après chaque photo rend toute sa mémoire, quoi que
// le décodeur ait fait. Le fil principal ne charge même pas le décodeur.
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
// même instance. Les conversions passent donc l'une après l'autre ; au-delà
// de `FILE_MAX` en attente, la photo est refusée « occupé » (503, rien
// d'effacé : l'hôte réessaie). Le délai de 15 s court DEPUIS L'APPEL, attente
// comprise : la fonction reste sous ses 60 s.
const FILE_MAX = 2
const attente = []
let filEnCours = false
// ⚠ UN COMPTE, UNE PLACE (troisième review, constat de sécurité 1) : la file
// est commune à tous les hôtes de l'instance. Sans clé, un seul compte qui
// garde trois confirmations en vol — le même envoi confirmé trois fois
// suffit — tient la file, et tous les autres reçoivent « occupé » (mesuré :
// 0 photo convertie sur 9 pour l'autre compte ; 9 sur 9 avec la clé). Une
// conversion par compte à la fois ; la seconde est refusée « occupé ».
let cleEnCours = null
// Une photo qui a ATTENDU et à qui il reste moins que ça ne lance pas de fil :
// il serait tué avant d'avoir décodé quoi que ce soit (troisième review,
// mineur 6).
const RESTE_MIN_MS = 500
// Un fil qui ne meurt pas dans ce délai ne bloque pas la file pour toujours.
const DELAI_MORT_MS = 1000

/**
 * Convertit dans un fil À USAGE UNIQUE, terminé à la fin quoi qu'il arrive,
 * un seul à la fois par instance, une seule par compte (`cle`). Rend le JPEG ;
 * lève `ConversionImpossible` (le fichier) ou `PanneConversion` : `occupe`
 * (file pleine, autre photo du compte en cours, ou délai mangé par
 * l'attente — l'hôte réessaie), `delai` (la photo a eu ses 15 s entières),
 * fil planté ou sorti sans répondre, module absent — avec sa cause dans
 * `detail`. `deps.Worker` : un double pour les tests.
 */
function convertirIsole (octets, { max, delaiMs = DELAI_CONVERSION_MS, cle = null } = {}, deps = {}) {
  if (filEnCours && attente.length >= FILE_MAX) return Promise.reject(new PanneConversion('occupe'))
  if (cle !== null && (cleEnCours === cle || attente.some((t) => t.cle === cle))) return Promise.reject(new PanneConversion('occupe'))
  return new Promise((resolve, reject) => {
    const tache = { cle, octets, max, delaiMs, echeance: Date.now() + delaiMs, resolve, reject, deps, minuteur: null }
    // Une photo qui attend son tour plus que son délai part en panne
    // « occupé » SANS avoir lancé de fil : elle n'a pas eu son tour.
    tache.minuteur = setTimeout(() => {
      const i = attente.indexOf(tache)
      if (i >= 0) { attente.splice(i, 1); reject(new PanneConversion('occupe')) }
    }, delaiMs)
    attente.push(tache)
    suivante()
  })
}

function suivante () {
  if (filEnCours || !attente.length) return
  const tache = attente.shift()
  clearTimeout(tache.minuteur)
  const reste = tache.echeance - Date.now()
  // A-t-elle attendu ? Alors un délai dépassé n'est pas SON délai : « occupé ».
  // « délai » ne se dit que d'une photo qui a eu ses 15 s entières.
  const aAttendu = reste < tache.delaiMs - 50
  if (reste <= 0 || (aAttendu && reste < RESTE_MIN_MS)) { tache.reject(new PanneConversion('occupe')); suivante(); return }
  filEnCours = true
  cleEnCours = tache.cle
  // La place et la clé sont rendues AVANT la réponse : l'appelant qui
  // enchaîne aussitôt une autre photo trouve la file libre.
  const liberer = () => { filEnCours = false; cleEnCours = null; suivante() }
  lancerFil(tache.octets, tache.max, reste, tache.deps).then(
    (jpeg) => { liberer(); tache.resolve(jpeg) },
    (e) => { liberer(); tache.reject(aAttendu && e instanceof PanneConversion && e.motif === 'delai' ? new PanneConversion('occupe') : e) })
}

function lancerFil (octets, max, delaiMs, deps) {
  const Worker = deps.Worker || require('node:worker_threads').Worker
  return new Promise((resolve, reject) => {
    let fini = false
    let minuteur = null
    let fil
    try {
      // Les messages de libheif (« Could not parse HEIF file… ») ne vont pas
      // aux journaux de la fonction : le motif suffit, et il est rendu.
      fil = new Worker(FICHIER_DU_FIL, { workerData: { max }, stdout: true, stderr: true })
    } catch (e) {
      reject(new PanneConversion('fil_impossible', e && e.message))
      return
    }
    if (fil.stdout) fil.stdout.resume()
    if (fil.stderr) fil.stderr.resume()
    // ⚠ La réponse — donc la place dans la file — ne part qu'une fois le fil
    // MORT (troisième review, mineur 2 : mesuré, deux fils vivaient ensemble
    // 8 à 35 ms, et trois photos de 48 Mpx montaient à 893 Mo au lieu de
    // 821). Un fil qui ne meurt pas en `DELAI_MORT_MS` ne bloque pas la file.
    const finir = (geste) => {
      if (fini) return
      fini = true
      clearTimeout(minuteur)
      const mort = Promise.resolve().then(() => fil.terminate()).catch(() => {})
      const sursis = new Promise((r) => { const m = setTimeout(r, DELAI_MORT_MS); if (m.unref) m.unref() })
      Promise.race([mort, sursis]).then(geste)
    }
    minuteur = setTimeout(() => finir(() => reject(new PanneConversion('delai'))), delaiMs)
    fil.once('message', (m) => finir(() => {
      if (m && m.ok && m.jpeg) resolve(Buffer.from(m.jpeg))
      else if (m && m.motif) reject(new ConversionImpossible(m.motif))
      else reject(new PanneConversion((m && m.panne) || 'reponse_vide', m && m.cause))
    }))
    fil.once('error', (e) => finir(() => reject(new PanneConversion('fil_en_erreur', e && e.message))))
    fil.once('exit', (code) => finir(() => reject(new PanneConversion(`fil_sorti_${code}`))))
    // Une COPIE transférée : le fil la possède, le tampon de l'appelant reste intact.
    const copie = Uint8Array.from(octets)
    fil.postMessage(copie, [copie.buffer])
  })
}

module.exports = {
  heicEnJpeg, convertirIsole, decoderPremiere, reduire, ConversionImpossible, PanneConversion,
  COTE_MAX, QUALITES, PIXELS_MAX, DELAI_CONVERSION_MS, FILE_MAX, RESTE_MIN_MS
}
