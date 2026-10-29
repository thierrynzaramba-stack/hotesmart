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
  // ⚠ LE BANDEAU DU MOIS EN FAIT PARTIE depuis le 29 octobre : sa ⓘ est la
  // troisieme de ce lot a avoir deborde, et la seule que ce test ne voyait pas.
  const m0 = PAGE.indexOf('<!-- Le bandeau : total du mois, recu, a venir. -->')
  const m1 = PAGE.indexOf('<!-- ⚠ UN TABLEAU, PAS UNE LISTE', m0)
  assert.ok(m0 > 0 && m1 > m0, 'le bandeau du mois n a pas ete trouve dans la page')
  const i = PAGE.indexOf('<div class="rev-an-tete">')
  const j = PAGE.indexOf('<!-- Les pastilles de filtre', i)
  assert.ok(i > 0 && j > i, 'le bandeau du total n a pas ete trouve dans la page')
  assert.ok(PAGE.includes('<div class="rev-an-legende" data-bind="revenue-annee-legende"></div>'),
    'la legende a change de forme dans la page : la mesure de sa ⓘ ne porte plus sur elle')
  const k = PAGE.indexOf('<!-- ⓘ DU TITRE DE LA COURBE')
  const l = PAGE.indexOf('</div>', PAGE.indexOf('data-bind="revenue-annee-ib-courbe"')) + 6
  assert.ok(k > 0 && l > k, 'la ⓘ du titre de la courbe n a pas ete trouvee dans la page')
  return sansCommentaires(PAGE.slice(m0, m1))
    + sansCommentaires(PAGE.slice(i, j)) + sansCommentaires(PAGE.slice(k, l))
}

// ⚠ LA ⓘ DES COMPARABLES EST CONSTRUITE EN JAVASCRIPT, donc son balisage ne
// s'extrait pas de la page comme les deux autres. Il est RECOMPOSE ici — et une
// recopie peut deriver en silence, alors chaque forme qu'elle emploie est
// VERIFIEE dans le script de la page. Si le rendu change de classe, le test
// echoue au lieu de mesurer un balisage qui n'existe plus.
//
// C'est la ⓘ que le constat 1 de la revue de 6d82af4d a prise : la legende est
// un flex qui RETOURNE A LA LIGNE, et une bulle collee au bord droit de son ⓘ
// s'ouvrait a -231 px quand la ⓘ se retrouvait a gauche.
function legendeDeMesure () {
  const script = PAGE.slice(PAGE.indexOf('<script type="module">'))
  for (const forme of ['class="rev-an-marque rev-an-marque--', 'class="ibulle ibulle--fin"',
    'class="ibulle__btn" aria-expanded="false" data-ibulle', 'class="ibulle__txt" role="note"']) {
    assert.ok(script.includes(forme),
      `la page ne construit plus « ${forme} » : le balisage recompose de ce test ne mesure plus son rendu`)
  }
  const fr = JSON.parse(fs.readFileSync(path.join(racine, 'shared', 'i18n', 'fr.json'), 'utf8'))
  const txt = fr['revenue.annee_ib_comparables']
  assert.ok(txt && txt.length > 100, 'le texte des comparables est introuvable ou trop court pour mesurer')
  // ⚠ SIX MARQUES, le cas le plus large : c'est precisement quand la bande
  // existe (donc deux marques de plus) que la ⓘ datee est emise, et c'est donc
  // le cas ou la legende retourne a la ligne.
  const marque = (c, t) => `<span><i class="rev-an-marque rev-an-marque--${c}"></i>${t}</span>`
  return '<div class="rev-an-legende" data-bind="revenue-annee-legende">'
    + marque('plein', '2026') + marque('pointille', 'reserve a date') + marque('n1', '2025')
    + marque('bande', 'comparables, mois passes') + marque('bande-futur', 'comparables, mois a venir')
    + '<span class="ibulle ibulle--fin"><button type="button" class="ibulle__btn"'
    + ' aria-expanded="false" data-ibulle aria-label="Qu est-ce que c est ?">?</button>'
    + `<span class="ibulle__txt" role="note" data-bind="legende-comparables">${txt}</span></span>`
    + '</div>'
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
  // ⚠ LE VRAI TEXTE DU MOIS, ET PAS UN CARACTERE DE REMPLISSAGE. Une premiere
  // version de ce test posait « X » dans la bulle du mois : large de trente
  // pixels, elle ne pouvait pas deborder, et la mutation qui retirait son
  // ancrage a droite SURVIVAIT. La bulle se mesure avec ce qu'elle contient.
  const txtMois = fr['revenue.note']
  assert.ok(txtTotal.length > 40 && txtCourbe.length > 40 && txtMois.length > 60,
    'les textes des ⓘ sont introuvables ou trop courts pour mesurer un debordement')
  fs.writeFileSync(page, `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${path.join(racine, 'shared/theme.css')}">
<link rel="stylesheet" href="${path.join(racine, 'shared/ui.css')}">
</head><body><main class="page"><section class="card">
${blocsDeLaPage()}
${legendeDeMesure()}
</section></main>
<script>
try {
  document.querySelector('[data-bind="revenue-annee-periode"]').textContent = 'Janvier → octobre 2026'
  document.querySelector('[data-bind="revenue-annee-n"]').textContent = '7 950 €'
  document.querySelector('[data-bind="revenue-annee-ib-total"]').hidden = false
  document.querySelector('[data-bind="revenue-annee-ib-total-txt"]').textContent = ${JSON.stringify(txtTotal)}
  document.querySelector('[data-bind="revenue-annee-ib-courbe"]').textContent = ${JSON.stringify(txtCourbe)}
  document.querySelector('[data-bind="revenue-total"]').textContent = '7 950 €'
  document.getElementById('ib-mois-txt').textContent = ${JSON.stringify(txtMois)}
  // Le GESTE : on ouvre, comme le doigt le fait.
  for (const b of document.querySelectorAll('[data-ibulle]')) b.setAttribute('aria-expanded', 'true')
  const bulles = [...document.querySelectorAll('.ibulle__txt')]
  document.title = JSON.stringify({
    fenetre: window.innerWidth,
    bulles: bulles.map((b) => {
      const r = b.getBoundingClientRect()
      return {
        bind: b.getAttribute('data-bind') || b.id || '(construite)',
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
    assert.strictEqual(r.bulles.length, 4,
      `${L} px : ${r.bulles.length} bulle(s) mesuree(s) au lieu de 4 `
      + '(total du mois, total de l annee, courbe, comparables)')
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
