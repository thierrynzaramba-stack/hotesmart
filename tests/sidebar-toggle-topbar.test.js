// tests/sidebar-toggle-topbar.test.js — recette de Thierry du 7 octobre 2026,
// point D : sur telephone, le bouton ☰ (pose en fixe en haut a gauche)
// recouvrait le titre de la page Avis. La regle COMMUNE du menu laisse sa place
// au bouton dans toute barre de titre.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('point D : sous 768 px, la barre de titre laisse au ☰ sa largeur (14 px + bouton)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'components', 'sidebar.js'), 'utf8')
  const media = src.slice(src.indexOf('@media (max-width: 768px)'), src.indexOf('document.head.appendChild(style)'))
  const m = media.match(/\.topbar\s*\{\s*padding-left:\s*(\d+)px\s*!important;?\s*\}/)
  assert.ok(m, 'la regle .topbar est dans le media du menu mobile')
  const gauche = Number((src.match(/left:\s*(\d+)px;/) || [])[1])
  assert.ok(Number(m[1]) >= gauche + 44, `${m[1]} px : le titre commence apres le bouton`)
})
