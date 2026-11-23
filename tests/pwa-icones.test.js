// tests/pwa-icones.test.js
//
// Les icônes de l'application installée (PWA lot 1). Elles sont GÉNÉRÉES
// depuis shared/logo.svg par scripts/pwa-icones.js et versionnées : ce test
// tient les trois choses qu'un œil ne voit pas.
//
//   1. Les TAILLES annoncées sont les vraies (Chrome refuse d'installer une
//      application dont l'icône 192 ou 512 n'a pas la taille déclarée).
//   2. Une icône MASKABLE ou iPhone n'a AUCUN pixel transparent, et rien
//      d'autre que le fond hors du cercle de sécurité (40 % de la taille
//      depuis le centre) : Android y découpe sa forme, iOS remplit de noir.
//   3. Les icônes correspondent au logo ACTUEL : changer shared/logo.svg sans
//      relancer le script laisserait l'ancien logo sur les téléphones.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { entete, pixels } = require('./outils/png')
const { logoPlein } = require('../scripts/pwa-icones')

const RACINE = path.join(__dirname, '..')
const ICONES = [
  { f: 'shared/pwa/icone-192.png', taille: 192, plein: false },
  { f: 'shared/pwa/icone-512.png', taille: 512, plein: false },
  { f: 'shared/pwa/icone-maskable-192.png', taille: 192, plein: true },
  { f: 'shared/pwa/icone-maskable-512.png', taille: 512, plein: true },
  { f: 'apple-touch-icon.png', taille: 180, plein: true }
]

// Les écarts d'une icône « pleine » : pixel transparent n'importe où, ou pixel
// différent du fond hors du cercle de sécurité. Rend la liste, vide si saine.
function ecartsPlein (fichier) {
  const img = pixels(path.join(RACINE, fichier))
  const fond = img.px(0, 0)
  const centre = (img.largeur - 1) / 2
  const rayon = 0.4 * img.largeur
  const ecarts = []
  let examines = 0
  for (let y = 0; y < img.hauteur; y++) {
    for (let x = 0; x < img.largeur; x++) {
      const p = img.px(x, y)
      examines++
      if (p[3] !== 255) { ecarts.push(`transparent en ${x},${y}`); continue }
      if (Math.hypot(x - centre, y - centre) > rayon && p.some((v, i) => v !== fond[i])) {
        ecarts.push(`hors du cercle de sécurité en ${x},${y}`)
      }
    }
  }
  // Règle 20.3 : un contrôle qui n'a rien examiné ne conclut pas.
  assert.equal(examines, img.largeur * img.hauteur, 'tous les pixels doivent avoir été lus')
  return ecarts
}

test('chaque icône existe, est un PNG, et a la taille annoncée', () => {
  for (const { f, taille } of ICONES) {
    const e = entete(path.join(RACINE, f))
    assert.deepEqual([e.largeur, e.hauteur], [taille, taille], `${f} : taille`)
  }
})

test('LE TEST QUI COMPTE : maskable et iPhone sont pleins, symbole dans le cercle de sécurité', () => {
  for (const { f, plein } of ICONES.filter(i => i.plein)) {
    assert.ok(plein)
    const ecarts = ecartsPlein(f)
    assert.deepEqual(ecarts.slice(0, 5), [], `${f} : ${ecarts.length} écart(s)`)
  }
})

test('contre-épreuve : le contrôle « plein » REFUSE le logo arrondi', () => {
  // L'icône « any » a des coins transparents : si le contrôle la laissait
  // passer, il ne reconnaîtrait pas l'icône à coins noirs qu'il doit empêcher.
  for (const { f } of ICONES.filter(i => !i.plein)) {
    assert.ok(ecartsPlein(f).length > 0, `${f} devrait être refusée par le contrôle « plein »`)
    assert.equal(pixels(path.join(RACINE, f)).px(0, 0)[3], 0, `${f} : le logo « any » garde ses coins arrondis`)
  }
})

test('les icônes ont été générées depuis le logo ACTUEL', () => {
  const source = JSON.parse(fs.readFileSync(path.join(RACINE, 'shared/pwa/icones-source.json'), 'utf8'))
  const actuel = crypto.createHash('sha256').update(fs.readFileSync(path.join(RACINE, 'shared/logo.svg'))).digest('hex')
  assert.equal(source.logo_svg_sha256, actuel,
    'shared/logo.svg a changé depuis la génération des icônes : relancer node scripts/pwa-icones.js')
})

test('le dessin « plein » se dérive du logo, et le script refuse un logo sans arrondi', () => {
  const logo = fs.readFileSync(path.join(RACINE, 'shared/logo.svg'), 'utf8')
  const plein = logoPlein(logo)
  assert.notEqual(plein, logo)
  assert.doesNotMatch(plein.match(/<rect\b[^>]*>/)[0], /\brx=/)
  // Le reste du dessin est intact : seul l'arrondi du fond a disparu.
  assert.equal(plein.replace(/\s+/g, ''), logo.replace(/\s(rx|ry)="[^"]*"/, '').replace(/\s+/g, ''))
  assert.throws(() => logoPlein('<svg><rect width="32" height="32"/></svg>'), /aucun arrondi/)
})
