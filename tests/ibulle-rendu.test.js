// tests/ibulle-rendu.test.js
// LES INFO-BULLES ⓘ, MESUREES SUR CE QUE LE NAVIGATEUR PLACE.
//
// ⚠ POURQUOI CE TEST EXISTE. La demande de Thierry du 29 octobre 2026 est que
// tout passe en ⓘ « survol / toucher ». Le toucher est le geste du TELEPHONE,
// et c'est justement la que la premiere version se cassait : mesure au
// navigateur reel, a 390 x 900, sur le balisage REEL de la vue Annee, la bulle
// du total s'ouvrait de 196 px a 516 px — soit 126 px HORS ECRAN. Le texte
// etait dans le DOM, les tests le lisaient, et l'hote n'en voyait pas la fin.
//
// Le `max-width: min(320px, …)` ne protegeait rien : il borne la LARGEUR, pas
// la position de depart, et la ⓘ du total s'ouvre apres « Janvier → octobre
// 2026 », donc a 196 px du bord.
//
// ⚠ ET UN JSDOM N'AURAIT RIEN VU : il ne fait pas de mise en page, donc tous
// ses rectangles valent zero. Comme pour l'opacite des bandes, la seule mesure
// qui vaut est celle d'un vrai moteur de rendu.
//
// ⚠ LE BALISAGE N'EST PAS RECOPIE, il est EXTRAIT de `pages/aujourdhui.html` :
// une copie mesurerait ma relecture de la page, et resterait verte le jour ou
// la page changerait de forme.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')

const racine = path.join(__dirname, '..')
const CHROME = '/home/thierry/.cache/ms-playwright/chromium_headless_shell-1243'
  + '/chrome-headless-shell-linux64/chrome-headless-shell'
const LIBS = '/home/thierry/.cache/hotesmart-banc/libs/usr/lib/x86_64-linux-gnu'

const PAGE = fs.readFileSync(path.join(racine, 'pages', 'aujourdhui.html'), 'utf8')

// Le bandeau du total et le titre de la courbe, pris dans la page. Les
// commentaires HTML partent : ils portent des `>` qui brouillent la lecture.
function blocsDeLaPage () {
  const sansCommentaires = (s) => s.replace(/<!--[\s\S]*?-->/g, '')
  const i = PAGE.indexOf('<div class="rev-an-tete">')
  const j = PAGE.indexOf('<!-- Les pastilles de filtre', i)
  assert.ok(i > 0 && j > i, 'le bandeau du total n a pas ete trouve dans la page')
  const k = PAGE.indexOf('<!-- ⓘ DU TITRE DE LA COURBE')
  const l = PAGE.indexOf('</div>', PAGE.indexOf('data-bind="revenue-annee-ib-courbe"')) + 6
  assert.ok(k > 0 && l > k, 'la ⓘ du titre de la courbe n a pas ete trouvee dans la page')
  return sansCommentaires(PAGE.slice(i, j)) + sansCommentaires(PAGE.slice(k, l))
}

// Mesure les rectangles des bulles OUVERTES a une largeur de fenetre donnee.
function mesurer (largeur) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'ibulle-'))
  const page = path.join(dossier, 'p.html')
  // ⚠ LES TEXTES SONT LES VRAIS, pris dans le dictionnaire : la hauteur et le
  // retour a la ligne dependent de leur longueur, et c'est elle qu'on mesure.
  const fr = JSON.parse(fs.readFileSync(path.join(racine, 'shared', 'i18n', 'fr.json'), 'utf8'))
  const txtTotal = [fr['revenue.annee_ib_total_sans_montant'], fr['revenue.annee_ib_total_estime']].join('\n')
  const txtCourbe = fr['revenue.annee_ib_courbe']
  assert.ok(txtTotal.length > 40 && txtCourbe.length > 40, 'les textes des ⓘ sont introuvables ou vides')
  fs.writeFileSync(page, `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${path.join(racine, 'shared/theme.css')}">
<link rel="stylesheet" href="${path.join(racine, 'shared/ui.css')}">
</head><body><main class="page"><section class="card">
${blocsDeLaPage()}
</section></main>
<script>
try {
  document.querySelector('[data-bind="revenue-annee-periode"]').textContent = 'Janvier → octobre 2026'
  document.querySelector('[data-bind="revenue-annee-n"]').textContent = '7 950 €'
  document.querySelector('[data-bind="revenue-annee-ib-total"]').hidden = false
  document.querySelector('[data-bind="revenue-annee-ib-total-txt"]').textContent = ${JSON.stringify(txtTotal)}
  document.querySelector('[data-bind="revenue-annee-ib-courbe"]').textContent = ${JSON.stringify(txtCourbe)}
  // Le GESTE : on ouvre, comme le doigt le fait.
  for (const b of document.querySelectorAll('[data-ibulle]')) b.setAttribute('aria-expanded', 'true')
  const bulles = [...document.querySelectorAll('.ibulle__txt')]
  document.title = JSON.stringify({
    fenetre: window.innerWidth,
    bulles: bulles.map((b) => {
      const r = b.getBoundingClientRect()
      return {
        bind: b.getAttribute('data-bind') || '(construite)',
        display: getComputedStyle(b).display,
        gauche: Math.round(r.left), droite: Math.round(r.right),
        largeur: Math.round(r.width), hauteur: Math.round(r.height)
      }
    })
  })
} catch (e) { document.title = 'ERREUR ' + e.message }
</script></body></html>`)
  const dom = execFileSync(CHROME, ['--headless', '--no-sandbox', '--disable-gpu',
    '--allow-file-access-from-files', `--window-size=${largeur},900`,
    '--virtual-time-budget=1500', '--dump-dom', `file://${page}`],
  { env: { ...process.env, LD_LIBRARY_PATH: LIBS }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const titre = (dom.match(/<title>([\s\S]*?)<\/title>/) || [])[1]
  assert.ok(titre, 'la sonde n a rien rendu : la page de mesure ne s est pas executee')
  fs.rmSync(dossier, { recursive: true, force: true })
  const brut = titre.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'")
  assert.ok(!brut.startsWith('ERREUR'), `la sonde a leve : ${brut}`)
  const r = JSON.parse(brut)
  assert.strictEqual(r.fenetre, largeur,
    `la fenetre mesure ${r.fenetre} px alors qu on a demande ${largeur} : la mesure ne porte pas sur la largeur voulue`)
  return r
}

const LARGEURS = [360, 390, 430, 719, 720, 721, 1024, 1280, 1600]

test("LE TEST QUI COMPTE : aucune bulle ne sort de l ecran, a aucune largeur", () => {
  // ⚠ LE GARDE-FOU NE SE SAUTE PAS TOUT SEUL. Sans navigateur, on echoue.
  assert.ok(fs.existsSync(CHROME),
    `le navigateur de banc est absent (${CHROME}) : ce test ne peut pas se taire, `
    + 'il est le seul a mesurer la POSITION rendue des info-bulles')

  for (const L of LARGEURS) {
    const r = mesurer(L)
    assert.ok(r.bulles.length >= 2, `${L} px : ${r.bulles.length} bulle(s) mesuree(s), le balisage a change de forme`)
    for (const b of r.bulles) {
      // ⚠ ET ELLE EST BIEN OUVERTE : une bulle a `display: none` aurait tous
      // ses rectangles a zero, donc ne « deborderait » jamais. Le test serait
      // vert sur une bulle qui ne s ouvre pas — le faux vert exact que ce
      // depot a paye deux fois.
      assert.strictEqual(b.display, 'block',
        `${L} px : la bulle ${b.bind} est calculee « ${b.display} » : le toucher ne l ouvre pas`)
      assert.ok(b.largeur > 0 && b.hauteur > 0,
        `${L} px : la bulle ${b.bind} est ouverte mais vide (${b.largeur}x${b.hauteur})`)
      assert.ok(b.gauche >= 0,
        `${L} px : la bulle ${b.bind} commence a ${b.gauche} px, donc hors de l ecran a gauche`)
      assert.ok(b.droite <= L,
        `${L} px : la bulle ${b.bind} finit a ${b.droite} px pour une fenetre de ${L} — `
        + `${b.droite - L} px de texte coupes. C est le defaut mesure le 29 octobre 2026.`)
    }
  }
})

test("LE TEST QUI COMPTE : au telephone la bulle prend la largeur de la fenetre", () => {
  // La raison du choix : au telephone, la seule largeur qu'on connaisse sans
  // JavaScript est celle de la FENETRE. Une bulle bornee par elle ne peut pas
  // etre coupee, quelle que soit la position de la ⓘ qui l'ouvre.
  const r = mesurer(390)
  for (const b of r.bulles) {
    assert.ok(b.largeur >= 390 - 2 * 24 - 1 && b.largeur <= 390 - 2 * 24 + 1,
      `la bulle ${b.bind} mesure ${b.largeur} px au lieu de la largeur de page (390 - 2 x 24)`)
  }
  // Et les deux sont au MEME endroit : c'est une feuille, pas deux bulles qui
  // se promenent.
  assert.strictEqual(new Set(r.bulles.map(b => b.gauche)).size, 1,
    `les bulles ne partent pas du meme bord : ${r.bulles.map(b => b.gauche).join(', ')}`)
})

test("a l ordinateur, la bulle reste une bulle ancree, pas une feuille", () => {
  // Le pendant du test precedent : si la regle du telephone fuyait vers
  // l'ordinateur, une barre de 1 200 px s'ouvrirait en bas de l'ecran sur un
  // simple survol. La mesure dit que non.
  const r = mesurer(1280)
  for (const b of r.bulles) {
    assert.ok(b.largeur <= 320, `la bulle ${b.bind} mesure ${b.largeur} px a l ordinateur : la feuille du telephone a fui`)
    assert.ok(b.gauche > 24, `la bulle ${b.bind} est collee au bord de la page a l ordinateur`)
  }
})
