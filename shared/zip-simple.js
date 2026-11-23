// shared/zip-simple.js — UN ÉCRIVAIN DE ZIP « STOCKÉ » (compte de charges, lot 8d, §14.23).
//
// L'export d'un exercice se fabrique dans le navigateur : une réponse de
// fonction est bornée à 4,5 Mo, et deux cents factures en font bien plus.
// ⚠ SANS COMPRESSION (méthode 0, « stored ») : les PDF et les photos le sont
// déjà, et un écrivain sans compression tient en quelques lignes, sans
// bibliothèque. Tout lecteur de ZIP l'ouvre (Windows, macOS, Android, iOS).
// ⚠ PAS DE ZIP64 : 65 535 fichiers et 4 Go au plus. L'export est borné bien
// en dessous (5 000 factures) ; au-delà, on refuse plutôt que d'écrire un
// fichier que personne ne saurait ouvrir.

const TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** Le CRC-32 d'octets (celui du ZIP). */
export function crc32 (octets) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < octets.length; i++) c = TABLE[(c ^ octets[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

// L'heure et la date au format MS-DOS, à l'heure locale (c'est ce que les
// explorateurs de fichiers affichent).
function dos (d) {
  const heure = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  const jour = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { heure, jour }
}

const MAX_ENTREES = 65535
const MAX_OCTETS = 0xFFFFFFFF

/**
 * Les morceaux d'un ZIP (à passer tels quels à `new Blob(morceaux)`) pour
 * `entrees` : `[{ nom, octets }]`, `nom` avec `/` pour un dossier, `octets`
 * un `Uint8Array`. Les noms sont écrits en UTF-8 (drapeau 11).
 */
export function zipStocke (entrees, date = new Date()) {
  if (entrees.length > MAX_ENTREES) throw new Error('zip_trop_de_fichiers')
  const { heure, jour } = dos(date)
  const enc = new TextEncoder()
  const morceaux = []
  const central = []
  let position = 0
  for (const e of entrees) {
    const nom = enc.encode(e.nom)
    const donnees = e.octets
    const crc = crc32(donnees)
    const local = new Uint8Array(30 + nom.length)
    const v = new DataView(local.buffer)
    v.setUint32(0, 0x04034b50, true)
    v.setUint16(4, 20, true)
    v.setUint16(6, 0x0800, true)
    v.setUint16(8, 0, true)
    v.setUint16(10, heure, true)
    v.setUint16(12, jour, true)
    v.setUint32(14, crc, true)
    v.setUint32(18, donnees.length, true)
    v.setUint32(22, donnees.length, true)
    v.setUint16(26, nom.length, true)
    v.setUint16(28, 0, true)
    local.set(nom, 30)
    const c = new Uint8Array(46 + nom.length)
    const w = new DataView(c.buffer)
    w.setUint32(0, 0x02014b50, true)
    w.setUint16(4, 20, true)
    w.setUint16(6, 20, true)
    w.setUint16(8, 0x0800, true)
    w.setUint16(10, 0, true)
    w.setUint16(12, heure, true)
    w.setUint16(14, jour, true)
    w.setUint32(16, crc, true)
    w.setUint32(20, donnees.length, true)
    w.setUint32(24, donnees.length, true)
    w.setUint16(28, nom.length, true)
    w.setUint32(42, position, true)
    c.set(nom, 46)
    central.push(c)
    morceaux.push(local, donnees)
    position += local.length + donnees.length
    if (position > MAX_OCTETS) throw new Error('zip_trop_gros')
  }
  const tailleCentral = central.reduce((s, c) => s + c.length, 0)
  const fin = new Uint8Array(22)
  const f = new DataView(fin.buffer)
  f.setUint32(0, 0x06054b50, true)
  f.setUint16(8, entrees.length, true)
  f.setUint16(10, entrees.length, true)
  f.setUint32(12, tailleCentral, true)
  f.setUint32(16, position, true)
  return [...morceaux, ...central, fin]
}
