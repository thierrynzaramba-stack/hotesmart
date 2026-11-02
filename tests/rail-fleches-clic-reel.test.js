// tests/rail-fleches-clic-reel.test.js
// LES FLECHES DU RAIL, MESUREES SUR UN VRAI CLIC.
//
// ⚠ LA DEMANDE DE THIERRY, MOT POUR MOT (29 octobre 2026, recette de
// production) : « Test navigateur : un VRAI clic sur la fleche doit charger les
// avis suivants. Ne mesure pas un defilement fait par programme. »
//
// Ce que ce fichier ne fait donc JAMAIS : poser `rail.scrollLeft = 900` pour
// « simuler » le geste, ni appeler `bouton.click()`. Les deux passeraient sur
// une fleche recouverte par une carte, placee hors de l'ecran ou neutralisee
// par `pointer-events: none` — c'est-a-dire sur les trois facons dont ce
// correctif pourrait etre faux tout en ayant l'air juste. Le clic part en
// COORDONNEES (`Input.dispatchMouseEvent`), et c'est le navigateur qui decide
// quel element le recoit ; le pilote rend meme QUI l'a recu, pour que l'echec
// dise « tombe sur article.card » au lieu de « rien ne s'est passe ».
//
// ⚠ ET LE DEFILEMENT N'EST PAS LE SUJET PRINCIPAL. Le defaut constate etait
// qu'a la souris, la suite des avis n'avait AUCUN declencheur : la barre de
// defilement est masquee et la molette ne defile pas lateralement. Ce qui se
// mesure ici est donc d'abord « le clic a-t-il demande la page suivante ».

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { ouvrir, navigateurPresent, CHROME } = require('./outils/navigateur.js')

const racine = path.join(__dirname, '..')
const PAGE = fs.readFileSync(path.join(racine, 'pages', 'aujourdhui.html'), 'utf8')

// ⚠ LE BALISAGE DU RAIL EST EXTRAIT DE LA PAGE, pas recopie : c'est le rendu
// livre qu'on mesure, et un test recopie reste vert quand la page change de
// forme. Les trois formes dont ce test depend sont verifiees, donc un
// changement de classe le fait ECHOUER au lieu de mesurer un decor.
function railDeLaPage () {
  const i = PAGE.indexOf('<div class="rail-wrap">')
  const j = PAGE.indexOf('</div>', PAGE.indexOf('data-rail="suiv"')) + 6
  assert.ok(i > 0 && j > i, 'le rail des avis n a pas ete trouve dans la page')
  for (const forme of ['data-rail="prec"', 'data-rail="suiv"', 'class="grid-avis scroll-x" id="rail-avis"']) {
    assert.ok(PAGE.includes(forme), `la page ne porte plus « ${forme} » : ce test ne mesure plus son rendu`)
  }
  return PAGE.slice(i, j).replace(/<!--[\s\S]*?-->/g, '')
}

// La page de mesure : le balisage REEL, les feuilles REELLES, le module REEL.
// Le seul double est `charger`, qui tient la place de `suivante()` de la page —
// il compte ses appels et ajoute trois cartes, comme le vrai le fait.
function pageDeMesure (nCartes, delaiMs = 0) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-'))
  const f = path.join(dossier, 'p.html')
  const carte = (n) => `<article class="card">Avis ${n} — un texte d avis de longueur ordinaire.</article>`
  fs.writeFileSync(f, `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${path.join(racine, 'shared/theme.css')}">
<link rel="stylesheet" href="${path.join(racine, 'shared/ui.css')}">
</head><body><main class="page"><section class="card">
${railDeLaPage()}
</section></main>
<script type="module">
import { brancherFleches } from '${path.join(racine, 'shared/rail-fleches.js')}'
const rail = document.getElementById('rail-avis')
rail.innerHTML = ${JSON.stringify(Array.from({ length: nCartes }, (_, i) => carte(i + 1)).join(''))}
  + '<div class="avis-suite" id="sentinelle"></div>'
window.__appels = 0
window.__ajoutes = 0
const fleches = brancherFleches({
  rail,
  prec: document.querySelector('[data-rail="prec"]'),
  suiv: document.querySelector('[data-rail="suiv"]'),
  charger: () => {
    window.__appels++
    // ⚠ APRES fin(), CE DOUBLE N'AJOUTE PLUS RIEN — et il a d'abord eu le
    // defaut inverse. Dans la page, finir() coupe l'observateur et rend
    // mien() faux : suivante() sort alors immediatement. Un double qui
    // continuait d'empiler des cartes faisait croitre le rail plus vite qu'on
    // n'y avance, donc son bout etait INATTEIGNABLE et le test accusait le
    // module. Un double doit refuser ce que le vrai refuse.
    // ⚠ ET AUCUN BACKTICK DANS CE COMMENTAIRE : il vit DANS un template
    // literal, qu'un backtick refermerait — la page entiere devenait alors une
    // erreur de syntaxe.
    if (window.__fini) return
    // ⚠ UN CHARGEMENT N'EST PAS INSTANTANE, et c'est ce qui rend le cas « au
    // bout du rail, la suite pas encore arrivee » OBSERVABLE. Avec un double
    // qui ajoutait ses cartes dans le meme tour, le bout reculait exactement
    // aussi vite qu'on avancait : la mutation qui grise la fleche des le bout
    // SURVIVAIT, faute d'un instant ou le rail est au bout sans etre fini.
    const poser = () => {
      const s = document.getElementById('sentinelle')
      for (let k = 0; k < 3; k++) {
        s.insertAdjacentHTML('beforebegin', ${JSON.stringify(carte('suivant'))})
        window.__ajoutes++
      }
      fleches.maj()
    }
    if (${delaiMs} > 0) setTimeout(poser, ${delaiMs})
    else poser()
  }
})
window.__fleches = fleches
// ⚠ CE QUE LA PAGE FAIT DEUX FOIS PAR CHARGEMENT : renderDerniersAvis est
// appele au cache puis apres la lecture serveur, et chacun re-arme la suite.
// Un module non idempotent empilerait alors ses ecouteurs.
// (Aucun backtick ici : ce commentaire vit dans un template literal.)
window.__rebrancher = () => brancherFleches({
  rail,
  prec: document.querySelector('[data-rail="prec"]'),
  suiv: document.querySelector('[data-rail="suiv"]'),
  charger: fleches.charger
})
// Ce que la page fait dans finir() : plus de chargement, et la fleche se grise.
window.__finir = () => { window.__fini = true; fleches.fin() }
// Ce que fait un nouveau rendu : il rebranche. rouvrir() doit alors rendre la
// fleche a son etat ouvert, meme si le rendu d'avant avait appele fin().
// (Aucun backtick ici : ce commentaire vit dans un template literal.)
window.__rendu = () => { window.__fini = false; window.__rebrancher() }
window.__pret = true
</script></body></html>`)
  return { f, dossier }
}

const etat = `(() => {
  const r = document.getElementById('rail-avis')
  return {
    pret: window.__pret === true,
    appels: window.__appels,
    ajoutes: window.__ajoutes,
    cartes: r.querySelectorAll('article.card').length,
    defilement: Math.round(r.scrollLeft),
    visible: Math.round(r.clientWidth),
    total: Math.round(r.scrollWidth),
    precGrise: document.querySelector('[data-rail="prec"]').disabled,
    suivGrise: document.querySelector('[data-rail="suiv"]').disabled,
    precAffichee: getComputedStyle(document.querySelector('[data-rail="prec"]')).display,
    suivAffichee: getComputedStyle(document.querySelector('[data-rail="suiv"]')).display
  }
})()`

test("LE TEST QUI COMPTE : un VRAI clic sur la fleche charge les avis suivants", async () => {
  // ⚠ LE GARDE-FOU NE SE SAUTE PAS TOUT SEUL.
  assert.ok(navigateurPresent(),
    `le navigateur de banc est absent (${CHROME}) : ce test ne peut pas se taire, `
    + 'il est le seul a mesurer un GESTE reel')

  const { f, dossier } = pageDeMesure(6)
  const nav = await ouvrir(f, { largeur: 1280, hauteur: 900 })
  try {
    // ⚠ UN `<script type="module">` EST DIFFERE : mesurer sans attendre tombe
    // sur un rail vide, et l'echec accuse alors le CSS (c'est arrive).
    await nav.attendre('window.__pret === true')
    const avant = await nav.lire(etat)
    assert.strictEqual(avant.appels, 0, 'un chargement est parti SANS clic')
    assert.ok(avant.total > avant.visible,
      `le rail ne defile pas (${avant.total} px de contenu pour ${avant.visible} visibles) : la mesure ne porterait sur rien`)
    assert.strictEqual(avant.precGrise, true, 'la fleche gauche n est pas grisee au DEBUT du rail')
    assert.strictEqual(avant.suivGrise, false, 'la fleche droite est grisee alors qu il reste a voir')

    // ⚠ LE GESTE. Le pilote dit qui a recu le point : si une carte recouvre la
    // fleche, l echec le nomme au lieu de laisser chercher.
    const clic = await nav.cliquer('[data-rail="suiv"]')
    assert.strictEqual(clic.recu, 'CIBLE',
      `le clic en (${clic.x}, ${clic.y}) est tombe sur « ${clic.recu} » : la fleche est recouverte ou mal placee`)

    // ⚠ ON ATTEND QUE LE DEFILEMENT SE POSE AVANT DE JUGER L'ETAT DES FLECHES.
    // `scrollBy` doux est asynchrone : lu tout de suite, `scrollLeft` vaut
    // encore 0 et la fleche gauche est legitimement grisee. Lire trop tot
    // fabrique un echec qui n'existe pas — c'est ce que ce test a fait d'abord.
    await nav.pose('Math.round(document.getElementById("rail-avis").scrollLeft)')
    const apres = await nav.lire(etat)
    assert.strictEqual(apres.appels, 1,
      'le clic n a demande AUCUNE page suivante : c est le defaut constate en production')
    assert.strictEqual(apres.cartes, avant.cartes + 3,
      `${apres.cartes - avant.cartes} carte(s) ajoutee(s) au lieu de 3`)
    assert.strictEqual(apres.precGrise, false,
      'la fleche gauche reste grisee alors que le rail a avance')
  } finally {
    nav.fermer()
    fs.rmSync(dossier, { recursive: true, force: true })
  }
})

test("LE TEST QUI COMPTE : le clic avance de TROIS cartes, pas d une ni de tout le rail", async () => {
  assert.ok(navigateurPresent(), 'navigateur de banc absent')
  const { f, dossier } = pageDeMesure(12)
  const nav = await ouvrir(f, { largeur: 1280, hauteur: 900 })
  try {
    await nav.attendre('window.__pret === true')
    const avant = await nav.lire(etat)
    await nav.cliquer('[data-rail="suiv"]')
    // Le defilement doux prend quelques images : on attend qu'il se pose, sans
    // jamais le POUSSER a la main.
    const pose = await nav.pose('Math.round(document.getElementById("rail-avis").scrollLeft)')
    assert.ok(pose > avant.defilement,
      `le rail n a pas defile (${avant.defilement} -> ${pose}) : la fleche ne bouge rien`)
    // Trois cartes de 300 px plus deux gouttieres, borne par la zone visible.
    const attendu = await nav.lire(`(() => {
      const r = document.getElementById('rail-avis')
      const l = r.firstElementChild.getBoundingClientRect().width
      const g = parseFloat(getComputedStyle(r).columnGap || getComputedStyle(r).gap || '0') || 0
      const unite = l + g
      const pas = Math.min(unite * 3, r.clientWidth)
      return { unite: Math.round(unite), pas: Math.round(pas), recale: Math.round(Math.round(pas / unite) * unite) }
    })()`)
    // ⚠ `scroll-snap-type: x mandatory` RECALE la position sur le debut d'une
    // carte : le rail ne s'arrete pas au pixel demande mais au multiple de
    // (carte + gouttiere) le plus proche. Mesure : 400 px demandes -> 324
    // atteints. On compare donc au multiple, pas a la valeur brute.
    assert.ok(pose > 0 && Math.abs(pose - attendu.recale) <= 2,
      `le rail s est pose a ${pose} px ; attendu ${attendu.recale} `
      + `(${attendu.pas} px demandes, recales par le snap sur un pas de ${attendu.unite})`)
  } finally {
    nav.fermer()
    fs.rmSync(dossier, { recursive: true, force: true })
  }
})

test("LE TEST QUI COMPTE : au BOUT du rail la fleche droite reste cliquable, et c est `fin()` qui la grise", async () => {
  // ⚠ SANS CELA L'HOTE EST DEVANT UN MUR : arrive au bout, il reste des avis a
  // charger, et une fleche grisee ne les demanderait jamais. C'est la raison
  // pour laquelle l'etat « grise » ne se deduit PAS de la seule position.
  assert.ok(navigateurPresent(), 'navigateur de banc absent')
  const { f, dossier } = pageDeMesure(4)
  const nav = await ouvrir(f, { largeur: 1280, hauteur: 900 })
  try {
    await nav.attendre('window.__pret === true')
    // On va au bout en CLIQUANT, jamais en posant `scrollLeft`.
    for (let k = 0; k < 6; k++) {
      const e = await nav.lire(etat)
      if (e.suivGrise) break
      await nav.cliquer('[data-rail="suiv"]')
      await nav.pose('Math.round(document.getElementById("rail-avis").scrollLeft)')
    }
    const auBout = await nav.lire(etat)
    assert.ok(auBout.appels > 0, 'aucun chargement apres plusieurs clics')
    assert.strictEqual(auBout.suivGrise, false,
      'la fleche droite s est grisee alors que la suite n a pas ete declaree finie : l hote serait bloque')

    // La page appelle `fin()` quand le serveur dit qu il n y a plus rien.
    // ⚠ ET `fin()` SEUL NE GRISE PAS : il reste des cartes DEJA CHARGEES a
    // faire defiler, et les cacher derriere une fleche morte serait un defaut.
    // La fleche ne se grise qu'au bout du rail ET la suite declaree finie.
    // Ce test a d'abord exige le contraire — il aurait fige un defaut.
    await nav.lire('window.__finir(), true')
    for (let k = 0; k < 12; k++) {
      const e = await nav.lire(etat)
      if (e.suivGrise) break
      await nav.cliquer('[data-rail="suiv"]')
      await nav.pose('Math.round(document.getElementById("rail-avis").scrollLeft)')
    }
    const fini = await nav.lire(etat)
    assert.strictEqual(fini.suivGrise, true,
      `au bout du rail et la suite finie, la fleche droite reste cliquable : ${JSON.stringify(fini)}`)

    // Et un clic sur une fleche grisee ne charge RIEN.
    const avant = fini.appels
    await nav.cliquer('[data-rail="suiv"]')
    const apres = await nav.lire(etat)
    assert.strictEqual(apres.appels, avant,
      'un clic sur la fleche GRISEE a quand meme demande une page')
  } finally {
    nav.fermer()
    fs.rmSync(dossier, { recursive: true, force: true })
  }
})

test("LE TEST QUI COMPTE : rebrancher ne DOUBLE pas le geste", async () => {
  // ⚠ LA PAGE REBRANCHE A CHAQUE RENDU, et il y en a DEUX par chargement (le
  // cache, puis la reponse du serveur). Deux jeux d'ecouteurs feraient avancer
  // de six cartes et demander deux pages par clic — un defilement qui saute, et
  // le double des appels reseau. Mesure par le GESTE, pas par la lecture du
  // code : un clic, un appel, trois cartes.
  assert.ok(navigateurPresent(), 'navigateur de banc absent')
  const { f, dossier } = pageDeMesure(8)
  const nav = await ouvrir(f, { largeur: 1280, hauteur: 900 })
  try {
    await nav.attendre('window.__pret === true')
    await nav.lire('window.__rebrancher(), true')
    await nav.lire('window.__rebrancher(), true')
    const avant = await nav.lire(etat)
    await nav.cliquer('[data-rail="suiv"]')
    await nav.pose('Math.round(document.getElementById("rail-avis").scrollLeft)')
    const apres = await nav.lire(etat)
    assert.strictEqual(apres.appels, 1,
      `${apres.appels} chargement(s) pour UN clic : les ecouteurs se sont empiles`)
    assert.strictEqual(apres.cartes - avant.cartes, 3,
      `${apres.cartes - avant.cartes} cartes ajoutees pour un clic au lieu de 3`)
  } finally {
    nav.fermer()
    fs.rmSync(dossier, { recursive: true, force: true })
  }
})

test("LE TEST QUI COMPTE : au bout du rail pendant que la suite CHARGE, la fleche ne se grise pas", async () => {
  // ⚠ L'INSTANT QUI MANQUAIT. Un clic avance le rail tout de suite et demande
  // la page suivante, qui arrive un peu plus tard. Entre les deux, l'hote est
  // au bout du rail et la suite n'est pas encore la : griser la fleche a cet
  // instant la ferait clignoter, et un second clic — celui qui demande la page
  // d'apres — serait refuse. L'etat « grise » ne peut donc PAS se deduire de la
  // seule position ; il demande les deux conditions.
  assert.ok(navigateurPresent(), 'navigateur de banc absent')
  // ⚠ 2 500 ms, PAS 700 (constat 6 de la revue). `pose()` rend la main des
  // 400 ms plus 150 de stabilite, auxquels s'ajoutent deux allers-retours CDP :
  // avec 700 ms, le chargement pouvait arriver PENDANT la mesure et le test
  // rougissait sur son propre message, sans qu'une ligne de production ait
  // bouge. Un rouge intermittent dans une suite dont le compte sert de
  // barriere est une barriere qu'on apprend a ignorer.
  const { f, dossier } = pageDeMesure(4, 2500)
  const nav = await ouvrir(f, { largeur: 1280, hauteur: 900 })
  try {
    await nav.attendre('window.__pret === true')
    await nav.cliquer('[data-rail="suiv"]')
    await nav.pose('Math.round(document.getElementById("rail-avis").scrollLeft)')
    const enVol = await nav.lire(etat)
    assert.strictEqual(enVol.appels, 1, 'le clic n a pas demande la page suivante')
    assert.strictEqual(enVol.ajoutes, 0,
      `les cartes sont deja arrivees (${enVol.ajoutes}) : le delai du double est trop court pour observer l instant`)
    assert.ok(enVol.defilement + enVol.visible >= enVol.total - 1,
      `le rail n est pas au bout (${enVol.defilement} + ${enVol.visible} contre ${enVol.total}) : le cas n est pas celui qu on veut`)
    assert.strictEqual(enVol.suivGrise, false,
      'au bout du rail et la suite EN VOL, la fleche droite est grisee : le prochain clic serait refuse')
    // Et quand les cartes arrivent, elle est toujours cliquable.
    await nav.attendre('window.__ajoutes >= 3')
    const arrive = await nav.lire(etat)
    assert.strictEqual(arrive.suivGrise, false, 'la fleche est grisee alors que trois cartes viennent d arriver')
  } finally {
    nav.fermer()
    fs.rmSync(dossier, { recursive: true, force: true })
  }
})

test("LE TEST QUI COMPTE : un nouveau rendu ROUVRE la suite apres un incident", async () => {
  // ⚠ LE CONSTAT MAJEUR DE LA REVUE DE fbb6baee, rejoue comme l hote le vit.
  // La page appelle finir() aussi dans le `catch` de suivante() : UNE lecture
  // ratee suffisait a poser « fini » pour de bon. Le rendu suivant apportait
  // des cartes fraiches et un nouveau curseur, mais l'etat restait ferme — au
  // bout du rail la fleche se grisait et ne demandait plus rien. A
  // l'ordinateur elle est le SEUL declencheur : c'etait le defaut de
  // production, reproduit apres un seul incident reseau.
  assert.ok(navigateurPresent(), 'navigateur de banc absent')
  const { f, dossier } = pageDeMesure(4)
  const nav = await ouvrir(f, { largeur: 1280, hauteur: 900 })
  try {
    await nav.attendre('window.__pret === true')
    // L'incident : la page declare la suite finie.
    await nav.lire('window.__finir(), true')
    for (let k = 0; k < 10; k++) {
      const e = await nav.lire(etat)
      if (e.suivGrise) break
      await nav.cliquer('[data-rail="suiv"]')
      await nav.pose('Math.round(document.getElementById("rail-avis").scrollLeft)')
    }
    assert.strictEqual((await nav.lire(etat)).suivGrise, true,
      'la fleche n est pas grisee apres fin() au bout : le cas de depart n est pas celui qu on veut')

    // Le rendu suivant arrive — et la suite redevient ouverte.
    await nav.lire('window.__rendu(), true')
    const apres = await nav.lire(etat)
    assert.strictEqual(apres.suivGrise, false,
      'apres un nouveau rendu la fleche reste grisee : un seul incident reseau la tue pour la session')
    // Et elle demande vraiment la page suivante.
    const avant = apres.appels
    await nav.cliquer('[data-rail="suiv"]')
    await nav.pose('Math.round(document.getElementById("rail-avis").scrollLeft)')
    assert.strictEqual((await nav.lire(etat)).appels, avant + 1,
      'la fleche rouverte ne demande plus rien')
  } finally {
    nav.fermer()
    fs.rmSync(dossier, { recursive: true, force: true })
  }
})

test("LE TEST QUI COMPTE : reduire la fenetre REVEILLE la fleche", async () => {
  // ⚠ CONSTAT 4 DE LA REVUE. Deux avis a 1 280 px tiennent dans la zone
  // visible : la fleche droite est grisee a juste titre. L hote reduit sa
  // fenetre, le contenu deborde — mais `scrollLeft` n a pas bouge, donc aucun
  // `scroll` n est emis. Sans observation de la TAILLE, la fleche restait
  // grisee sur du contenu hors de l ecran.
  assert.ok(navigateurPresent(), 'navigateur de banc absent')
  const { f, dossier } = pageDeMesure(2)
  const nav = await ouvrir(f, { largeur: 1280, hauteur: 900 })
  try {
    await nav.attendre('window.__pret === true')
    await nav.lire('window.__finir(), true')
    const large = await nav.lire(etat)
    assert.ok(large.total <= large.visible + 1,
      `le rail deborde deja a 1280 px (${large.total} contre ${large.visible}) : le cas n est pas celui qu on veut`)
    assert.strictEqual(large.suivGrise, true, 'la fleche n est pas grisee alors que tout tient dans la largeur')

    // ⚠ ON REDUIT LA FENETRE POUR DE VRAI (CDP), on ne pose pas une largeur en
    // JavaScript : c est le navigateur qui doit refaire sa mise en page.
    await nav.envoyer('Emulation.setDeviceMetricsOverride', {
      width: 760, height: 900, deviceScaleFactor: 1, mobile: false
    })
    // La mise en page se refait d'abord…
    await nav.attendre('document.getElementById("rail-avis").scrollWidth > document.getElementById("rail-avis").clientWidth + 1')
    // … puis `ResizeObserver` rejoue `maj()` DANS UN TOUR ULTERIEUR. Lire
    // l'etat tout de suite le trouve inchange : mesure du 29 octobre 2026,
    // quatre echecs sur cinq passes, et c'etait mon test qui lisait trop tot —
    // pas le module. On attend donc la CONSEQUENCE, et son absence reste un
    // echec (l'attente leve au bout de son delai).
    let reveillee = true
    try {
      await nav.attendre('document.querySelector(\'[data-rail="suiv"]\').disabled === false', { maxMs: 3000 })
    } catch { reveillee = false }
    const etroit = await nav.lire(etat)
    assert.ok(reveillee && etroit.suivGrise === false,
      `la fleche reste grisee alors que le contenu deborde (${etroit.total} contre ${etroit.visible}) : `
      + 'la taille du rail n est pas observee')
  } finally {
    nav.fermer()
    fs.rmSync(dossier, { recursive: true, force: true })
  }
})

test("LE TEST QUI COMPTE : les fleches n existent PAS au telephone, et la molette n est pas detournee", async () => {
  assert.ok(navigateurPresent(), 'navigateur de banc absent')
  const { f, dossier } = pageDeMesure(8)
  const nav = await ouvrir(f, { largeur: 390, hauteur: 844 })
  try {
    await nav.attendre('window.__pret === true')
    const e = await nav.lire(etat)
    assert.strictEqual(e.precAffichee, 'none', `la fleche gauche s affiche au telephone : ${JSON.stringify(e)}`)
    assert.strictEqual(e.suivAffichee, 'none', 'la fleche droite s affiche au telephone')
    // ⚠ ET LE RAIL DEFILE QUAND MEME AU DOIGT : retirer les fleches ne doit pas
    // retirer le geste tactile.
    assert.ok(e.total > e.visible, `le rail ne defile plus au telephone : ${JSON.stringify(e)}`)
    // ⚠ LA MOLETTE N'EST PAS DETOURNEE. Un `wheel` non passif qui appellerait
    // `preventDefault` volerait a l hote le geste qui fait descendre la page.
    // On le mesure par le GESTE : une molette verticale sur le rail ne doit pas
    // le faire defiler lateralement.
    const avant = await nav.lire('Math.round(document.getElementById("rail-avis").scrollLeft)')
    const r = await nav.lire(`(() => { const b = document.getElementById('rail-avis').getBoundingClientRect()
      return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } })()`)
    await nav.envoyer('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: r.x, y: r.y, deltaX: 0, deltaY: 240
    })
    await nav.lire('new Promise(r => setTimeout(r, 250))')
    const apres = await nav.lire('Math.round(document.getElementById("rail-avis").scrollLeft)')
    assert.strictEqual(apres, avant,
      `une molette VERTICALE a fait defiler le rail lateralement (${avant} -> ${apres}) : elle est detournee`)
  } finally {
    nav.fermer()
    fs.rmSync(dossier, { recursive: true, force: true })
  }
})
