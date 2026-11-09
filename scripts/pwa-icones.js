#!/usr/bin/env node
/* ============================================================
   HôteSmart — scripts/pwa-icones.js
   Génère les icônes de l'application installée DEPUIS shared/logo.svg.
   Usage : node scripts/pwa-icones.js
   Outil : rsvg-convert (paquet librsvg2-bin : sudo apt install librsvg2-bin)

   Produit :
     shared/pwa/icone-192.png, icone-512.png            → purpose « any »
     shared/pwa/icone-maskable-192.png, -512.png        → purpose « maskable »
     apple-touch-icon.png (racine, 180 px)              → iPhone / iPad
     shared/pwa/icones-source.json                      → empreinte du logo

   ⚠ DEUX DESSINS, UN SEUL LOGO. « any » est le logo tel quel : carré
   arrondi, coins transparents — Android le pose tel quel. « maskable » et
   l'icône iPhone sont le MÊME logo avec le fond porté jusqu'aux bords
   (rayon retiré) : Android découpe lui-même un cercle ou une goutte dans une
   icône maskable, et iOS remplit de NOIR tout pixel transparent. Un logo
   arrondi y laisserait quatre coins noirs. Le symbole, lui, ne bouge pas :
   il tient dans le cercle de sécurité (40 % de la taille depuis le centre),
   et tests/pwa-icones.test.js le MESURE pixel par pixel.

   ⚠ L'EMPREINTE. icones-source.json garde le SHA-256 du logo qui a servi.
   Si quelqu'un change shared/logo.svg sans relancer ce script, l'application
   installée garderait l'ancien logo sans que rien ne le dise :
   tests/pwa-icones.test.js recalcule l'empreinte et rougit.

   ⚠ RIEN NE TRANSITE PAR LA RACINE SERVIE (REVIEW.md règle 15) : le SVG
   intermédiaire s'écrit dans le dossier temporaire du système.
   ============================================================ */
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const RACINE = path.join(__dirname, '..')
const LOGO = path.join(RACINE, 'shared', 'logo.svg')
const DOSSIER = path.join(RACINE, 'shared', 'pwa')

// Le fond du logo est son premier <rect> : on retire son arrondi, rien d'autre.
function logoPlein (svg) {
  let fait = false
  const sortie = svg.replace(/<rect\b[^>]*>/, (rect) => {
    const sans = rect.replace(/\s(rx|ry)="[^"]*"/g, '')
    fait = sans !== rect
    return sans
  })
  if (!fait) throw new Error('logo.svg : aucun arrondi trouvé sur le premier <rect> — le dessin « plein » ne peut pas être dérivé')
  return sortie
}

function rendre (svgChemin, taille, sortie) {
  execFileSync('rsvg-convert', ['-w', String(taille), '-h', String(taille), '-f', 'png', '-o', sortie, svgChemin])
}

function main () {
  try {
    execFileSync('rsvg-convert', ['--version'], { stdio: 'ignore' })
  } catch {
    console.error('rsvg-convert introuvable. Installer : sudo apt install librsvg2-bin')
    process.exit(1)
  }
  const brut = fs.readFileSync(LOGO)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-icones-'))
  const plein = path.join(tmp, 'logo-plein.svg')
  fs.writeFileSync(plein, logoPlein(brut.toString('utf8')))
  fs.mkdirSync(DOSSIER, { recursive: true })

  const sorties = [
    [LOGO, 192, path.join(DOSSIER, 'icone-192.png')],
    [LOGO, 512, path.join(DOSSIER, 'icone-512.png')],
    [plein, 192, path.join(DOSSIER, 'icone-maskable-192.png')],
    [plein, 512, path.join(DOSSIER, 'icone-maskable-512.png')],
    [plein, 180, path.join(RACINE, 'apple-touch-icon.png')]
  ]
  for (const [src, taille, out] of sorties) {
    rendre(src, taille, out)
    console.log(`${path.relative(RACINE, out)} (${taille} px, ${fs.statSync(out).size} octets)`)
  }
  fs.rmSync(tmp, { recursive: true, force: true })

  const empreinte = crypto.createHash('sha256').update(brut).digest('hex')
  fs.writeFileSync(path.join(DOSSIER, 'icones-source.json'),
    JSON.stringify({ logo_svg_sha256: empreinte, script: 'scripts/pwa-icones.js' }, null, 2) + '\n')
  console.log(`empreinte du logo : ${empreinte.slice(0, 12)}`)
}

if (require.main === module) main()
module.exports = { logoPlein }
