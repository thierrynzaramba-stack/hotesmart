// tests/courbe-bande-rendu.test.js
// LA BANDE DES COMPARABLES, MESUREE SUR CE QUE LE NAVIGATEUR CALCULE.
//
// ⚠ POURQUOI CE TEST EXISTE — constat de Thierry en recette sur staging, le
// 28 octobre 2026. Deux lots de suite avaient « corrige » l'opacite des bandes,
// et aucun des deux n'avait d'effet : `shared/courbe-mensuelle.js` posait
// `opacity="0.15"` en ATTRIBUT DE PRESENTATION, alors que `shared/ui.css` porte
// `.cm-bande { opacity: .85 }`. Un attribut de presentation a la priorite la
// PLUS BASSE de la cascade : toute regle d'auteur l'emporte. Mesure de Thierry
// dans la page, puis reproduite ici :
//     attribut demande : 0.15 et 0.07
//     opacite CALCULEE : 0.85 et 0.85   -> les deux bandes IDENTIQUES
//
// ⚠ ET MES DEUX TESTS D'ALORS LISAIENT L'ATTRIBUT — donc mon intention, jamais
// le rendu. Ils etaient verts sur un ecran faux, deux fois de suite, et ils
// avaient meme servi a declarer corrige le constat « bandes trop proches » du
// 28 octobre : les deux densites ne s'appliquaient pas davantage. Un test qui
// lit ce que le code ECRIT ne dit rien de ce que l'hote VOIT.
//
// ⚠ CE TEST LANCE DONC UN VRAI NAVIGATEUR et lit `getComputedStyle`. C'est le
// seul endroit du depot qui mesure la CASCADE ; un `jsdom` ne l'aurait pas vue
// non plus. Si le navigateur de banc est absent, le test ECHOUE au lieu de se
// taire : un garde-fou qui se saute tout seul protege de rien.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const racine = path.join(__dirname, '..')
const CHROME = '/home/thierry/.cache/ms-playwright/chromium_headless_shell-1243'
  + '/chrome-headless-shell-linux64/chrome-headless-shell'
const LIBS = '/home/thierry/.cache/hotesmart-banc/libs/usr/lib/x86_64-linux-gnu'

// La page de mesure : la courbe REELLE, les feuilles REELLES, et une sonde qui
// rend le style CALCULE de chaque bande.
function mesurer (opacites) {
  const dossier = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'bande-'))
  const page = path.join(dossier, 'p.html')
  const sonde = path.join(dossier, 's.mjs')
  // ⚠ LA COURBE EST PRODUITE PAR LE MODULE, pas recopiee : c'est son rendu
  // qu'on mesure. Recopier le balisage mesurerait ma relecture du module.
  fs.writeFileSync(sonde, `
import { courbeMensuelle } from '${path.join(racine, 'shared/courbe-mensuelle.js')}'
import fs from 'fs'
const douze = (f) => Array.from({ length: 12 }, (_, i) => f(i))
const svg = courbeMensuelle({
  series: [{ nom: 'N', couleur: 'var(--ink)', epaisseur: 2, valeurs: douze(i => 100 + i) }],
  bandes: ${JSON.stringify(opacites)}.map((op, n) => ({
    nature: n === 0 ? 'clos' : 'futur',
    min: douze(i => (n === 0 ? (i < 6 ? 50 : null) : (i >= 6 ? 40 : null))),
    max: douze(i => (n === 0 ? (i < 6 ? 90 : null) : (i >= 6 ? 80 : null))),
    couleur: 'var(--muted)', opacite: op
  }))
})
fs.writeFileSync(${JSON.stringify(page)}, \`<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(racine, 'shared/theme.css')}">
<link rel="stylesheet" href="${path.join(racine, 'shared/ui.css')}">
</head><body>\${svg}
<script>
const p = [...document.querySelectorAll('polygon.cm-bande')]
const st = (n) => getComputedStyle(n)
document.title = JSON.stringify({
  polygones: p.length,
  opacites: p.map(n => Number(st(n).opacity)),
  remplissages: [...new Set(p.map(n => st(n).fill))]
})
</script></body></html>\`)
`)
  execFileSync(process.execPath, [sonde], { cwd: racine, stdio: 'pipe' })
  const dom = execFileSync(CHROME, ['--headless', '--no-sandbox', '--disable-gpu',
    '--allow-file-access-from-files', '--window-size=900,600',
    '--virtual-time-budget=1500', '--dump-dom', `file://${page}`],
  { env: { ...process.env, LD_LIBRARY_PATH: LIBS }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const titre = (dom.match(/<title>([\s\S]*?)<\/title>/) || [])[1]
  assert.ok(titre, 'la sonde n a rien rendu : la page ne s est pas executee')
  fs.rmSync(dossier, { recursive: true, force: true })
  return JSON.parse(titre.replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
}

test("LE TEST QUI COMPTE : l opacite demandee est celle que le NAVIGATEUR CALCULE", () => {
  // ⚠ LE GARDE-FOU NE SE SAUTE PAS TOUT SEUL. Sans navigateur, on echoue.
  assert.ok(fs.existsSync(CHROME),
    `le navigateur de banc est absent (${CHROME}) : ce test ne peut pas se taire, `
    + 'il est le seul du depot a mesurer la cascade CSS')

  const r = mesurer([0.15, 0.07])
  assert.strictEqual(r.polygones, 2, `${r.polygones} polygone(s) de bande rendus au lieu de 2`)
  // ⚠ C'EST CETTE ASSERTION QUI AURAIT ATTRAPE LE DEFAUT : avant le correctif,
  // les deux valeurs calculees valaient 0.85 — celle de `.cm-bande` dans
  // `shared/ui.css` —, quelle que soit l'opacite demandee.
  assert.deepStrictEqual(r.opacites, [0.15, 0.07],
    `le navigateur calcule ${JSON.stringify(r.opacites)} : une regle CSS ecrase l opacite demandee`)
  // Et le gris reste UN seul gris : c'est la densite qui distingue, pas la teinte.
  assert.strictEqual(r.remplissages.length, 1,
    `deux teintes rendues (${r.remplissages.join(', ')}) : les bandes doivent etre le MEME gris a deux densites`)
})

test("LE TEST QUI COMPTE : les deux bandes se distinguent, et restent DISCRETES", () => {
  // Les deux bornes de la recette, mesurees sur le rendu et plus sur l attribut :
  // discretes (constat du 29) ET distinguables (constat du 28). Elles se
  // serrent, donc elles s assertent ensemble.
  const { opacites } = mesurer([0.15, 0.07])
  const [fonce, clair] = [...opacites].sort((a, b) => b - a)
  assert.ok(fonce / clair >= 2,
    `${fonce} et ${clair} : moins du double, les deux bandes ne se distinguent pas`)
  assert.ok(fonce <= 0.2,
    `la bande la plus foncee est calculee a ${fonce} : ce n est plus un fond discret`)
  assert.ok(clair >= 0.05,
    `la bande la plus claire est calculee a ${clair} : elle n est plus visible`)
})

test("LE TEST QUI COMPTE : sans opacite demandee, le defaut de la feuille s applique", () => {
  // ⚠ ET C'EST POURQUOI LA REGLE CSS RESTE. `apps/yield/marche-temperature.html`
  // et `apps/yield/prix.html` passent des bandes SANS opacite et comptent sur le
  // 0,85 de `.cm-bande`. Retirer la regle pour « laisser passer l attribut »
  // aurait eclairci ces deux ecrans sans que personne le demande.
  const r = mesurer([null, null])
  assert.deepStrictEqual(r.opacites, [0.85, 0.85],
    `sans opacite demandee, le navigateur calcule ${JSON.stringify(r.opacites)} au lieu du 0,85 de la feuille`)
})
