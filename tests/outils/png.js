// tests/outils/png.js
// Lecteur PNG minimal pour les tests : dimensions (IHDR) et pixels RGBA.
// Ne sait lire que ce que produit scripts/pwa-icones.js (rsvg-convert) :
// 8 bits par canal, RGBA (type 6) ou RGB (type 2), non entrelacé. Tout autre
// format LÈVE : un lecteur qui ne sait pas lire ne doit pas rendre un vert.
const fs = require('node:fs')
const zlib = require('node:zlib')

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function morceaux (buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('pas un PNG (signature)')
  const out = []
  let i = 8
  while (i < buf.length) {
    const long = buf.readUInt32BE(i)
    const type = buf.toString('ascii', i + 4, i + 8)
    out.push({ type, data: buf.subarray(i + 8, i + 8 + long) })
    i += 12 + long
  }
  return out
}

function entete (fichier) {
  const ihdr = morceaux(fs.readFileSync(fichier)).find(m => m.type === 'IHDR')
  if (!ihdr) throw new Error('PNG sans IHDR')
  return {
    largeur: ihdr.data.readUInt32BE(0),
    hauteur: ihdr.data.readUInt32BE(4),
    profondeur: ihdr.data[8],
    typeCouleur: ihdr.data[9],
    entrelace: ihdr.data[12]
  }
}

function paeth (a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c)
}

// Rend { largeur, hauteur, px(x, y) → [r, g, b, a] }
function pixels (fichier) {
  const e = entete(fichier)
  if (e.profondeur !== 8 || e.entrelace !== 0 || ![2, 6].includes(e.typeCouleur)) {
    throw new Error(`PNG non pris en charge (profondeur ${e.profondeur}, type ${e.typeCouleur}, entrelacé ${e.entrelace})`)
  }
  const canaux = e.typeCouleur === 6 ? 4 : 3
  const idat = Buffer.concat(morceaux(fs.readFileSync(fichier)).filter(m => m.type === 'IDAT').map(m => m.data))
  const brut = zlib.inflateSync(idat)
  const ligne = e.largeur * canaux
  const img = Buffer.alloc(ligne * e.hauteur)
  for (let y = 0; y < e.hauteur; y++) {
    const filtre = brut[y * (ligne + 1)]
    for (let x = 0; x < ligne; x++) {
      const v = brut[y * (ligne + 1) + 1 + x]
      const a = x >= canaux ? img[y * ligne + x - canaux] : 0
      const b = y > 0 ? img[(y - 1) * ligne + x] : 0
      const c = x >= canaux && y > 0 ? img[(y - 1) * ligne + x - canaux] : 0
      let r
      if (filtre === 0) r = v
      else if (filtre === 1) r = v + a
      else if (filtre === 2) r = v + b
      else if (filtre === 3) r = v + ((a + b) >> 1)
      else if (filtre === 4) r = v + paeth(a, b, c)
      else throw new Error(`filtre PNG inconnu : ${filtre}`)
      img[y * ligne + x] = r & 0xff
    }
  }
  return {
    largeur: e.largeur,
    hauteur: e.hauteur,
    px (x, y) {
      const o = y * ligne + x * canaux
      return canaux === 4 ? [img[o], img[o + 1], img[o + 2], img[o + 3]] : [img[o], img[o + 1], img[o + 2], 255]
    }
  }
}

module.exports = { entete, pixels }
