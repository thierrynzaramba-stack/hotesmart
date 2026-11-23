// shared/pdf-simple.js — UN ÉCRIVAIN DE PDF MINIMAL (compte de charges, lot 8d, §14.23).
//
// Il écrit la liste des factures d'un exercice : du texte et des traits, sur
// des pages A4. ⚠ AUCUNE BIBLIOTHÈQUE : le PDF se fabrique dans le navigateur
// (une réponse de fonction est bornée à 4,5 Mo), et ce module ne sait faire
// que ce dont la liste a besoin.
//
// ⚠ LES POLICES STANDARD DU PDF (Helvetica et Helvetica-Bold) AVEC LE CODAGE
// WinAnsi : aucun fichier de police à embarquer, et tout lecteur de PDF les
// connaît. Le prix : un caractère hors de WinAnsi (un idéogramme, un emoji)
// s'écrit « ? ». Les espaces insécables que `Intl` met dans les montants
// français (U+202F) deviennent l'insécable de WinAnsi.
// ⚠ LES CHAÎNES S'ÉCRIVENT EN HEXADÉCIMAL (`<48656C6C6F> Tj`) : aucune
// parenthèse ni barre oblique à échapper, et le fichier entier reste en
// ASCII, donc la position de chaque objet se compte en caractères.
// Les largeurs sont celles des fichiers de métriques Adobe (AFM) des deux
// polices, codes 32 à 255 de WinAnsi (0 pour un code qui n'existe pas) ;
// « Ÿ » (0x9F) vaut 667, comme « Ý » (review du lot 8d).

const LARGEURS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 0,
  556, 0, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0,
  0, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 0, 500, 667,
  278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333,
  400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500
]
const LARGEURS_GRAS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 0,
  556, 0, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0,
  0, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 0, 500, 667,
  278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333,
  400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278,
  611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556
]
// Les caractères de WinAnsi entre 0x80 et 0x9F, par leur code Unicode.
const SPECIAUX = new Map([[0x20AC, 0x80], [0x201A, 0x82], [0x0192, 0x83], [0x201E, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02C6, 0x88], [0x2030, 0x89], [0x0160, 0x8A], [0x2039, 0x8B], [0x0152, 0x8C], [0x017D, 0x8E], [0x2018, 0x91], [0x2019, 0x92], [0x201C, 0x93], [0x201D, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x02DC, 0x98], [0x2122, 0x99], [0x0161, 0x9A], [0x203A, 0x9B], [0x0153, 0x9C], [0x017E, 0x9E], [0x0178, 0x9F]])

/** Les octets WinAnsi d'un texte ; un caractère hors du codage devient « ? ». */
export function octetsWinAnsi (texte) {
  const out = []
  for (const ch of String(texte == null ? '' : texte).normalize('NFC')) {
    const c = ch.codePointAt(0)
    if (c === 0x202F || c === 0x2007) out.push(0xA0)
    else if (c === 0x09 || c === 0x0A || c === 0x0D) out.push(0x20)
    else if ((c >= 0x20 && c < 0x7F) || (c >= 0xA0 && c <= 0xFF)) out.push(c)
    else if (SPECIAUX.has(c)) out.push(SPECIAUX.get(c))
    else out.push(0x3F)
  }
  return out
}

/** La largeur d'un texte, en points, à la taille donnée. */
export function largeur (texte, taille, gras = false) {
  const t = gras ? LARGEURS_GRAS : LARGEURS
  let s = 0
  for (const o of octetsWinAnsi(texte)) s += t[o - 32] || 0
  return s * taille / 1000
}

/** Le texte coupé pour tenir dans `max` points, terminé par « … » s'il l'est. */
export function couper (texte, max, taille, gras = false) {
  const brut = String(texte == null ? '' : texte)
  if (largeur(brut, taille, gras) <= max) return brut
  const car = [...brut]
  while (car.length && largeur(car.join('') + '…', taille, gras) > max) car.pop()
  return car.length ? car.join('').trimEnd() + '…' : ''
}

const hex = (octets) => octets.map(o => o.toString(16).padStart(2, '0')).join('').toUpperCase()
const n2 = (v) => String(Math.round(v * 100) / 100)

/**
 * Un document : `page()` ouvre une page, `texte` et `trait` y dessinent (le
 * point (0, 0) est en BAS à gauche, comme dans le PDF), `octets()` rend le
 * fichier. `largeur` et `hauteur` en points (A4 paysage par défaut).
 */
export function creerPdf ({ largeur: L = 842, hauteur: H = 595 } = {}) {
  const pages = []
  let courante = null
  return {
    largeur: L,
    hauteur: H,
    page () { courante = []; pages.push(courante); return pages.length },
    get nombrePages () { return pages.length },
    /** Écrit sur la page `numero` (la courante par défaut). */
    texte (x, y, t, { taille = 9, gras = false, gris = 0, aDroite = false, page = null } = {}) {
      const cible = page ? pages[page - 1] : courante
      const px = aDroite ? x - largeur(t, taille, gras) : x
      cible.push(`BT ${n2(gris)} g /${gras ? 'F2' : 'F1'} ${n2(taille)} Tf ${n2(px)} ${n2(y)} Td <${hex(octetsWinAnsi(t))}> Tj ET`)
    },
    trait (x1, y1, x2, y2, { epaisseur = 0.5, gris = 0 } = {}) {
      courante.push(`${n2(gris)} G ${n2(epaisseur)} w ${n2(x1)} ${n2(y1)} m ${n2(x2)} ${n2(y2)} l S`)
    },
    /** Le fichier PDF, en octets (ASCII). */
    octets () {
      if (!pages.length) this.page()
      const objets = []
      const ajouter = (corps) => { objets.push(corps); return objets.length }
      ajouter('<< /Type /Catalog /Pages 2 0 R >>')
      ajouter('')
      const f1 = ajouter('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
      const f2 = ajouter('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')
      const enfants = []
      for (const p of pages) {
        const flux = p.join('\n')
        const contenu = ajouter(`<< /Length ${flux.length} >>\nstream\n${flux}\nendstream`)
        enfants.push(ajouter(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${L} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${contenu} 0 R >>`))
      }
      objets[1] = `<< /Type /Pages /Kids [${enfants.map(k => `${k} 0 R`).join(' ')}] /Count ${enfants.length} >>`
      let s = '%PDF-1.4\n'
      const positions = []
      objets.forEach((corps, i) => { positions.push(s.length); s += `${i + 1} 0 obj\n${corps}\nendobj\n` })
      const xref = s.length
      s += `xref\n0 ${objets.length + 1}\n0000000000 65535 f \n`
      for (const p of positions) s += `${String(p).padStart(10, '0')} 00000 n \n`
      s += `trailer\n<< /Size ${objets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
      const o = new Uint8Array(s.length)
      for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i)
      return o
    }
  }
}
