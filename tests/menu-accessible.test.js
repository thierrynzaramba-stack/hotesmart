// tests/menu-accessible.test.js
// LE DEFAUT : une page sans menu est un cul-de-sac.
//
// Mesure du 14 septembre 2026. Les trois pages YieldFlow appelaient bien
// `renderSidebar`, mais portaient `id="sidebar-root"` — or le composant fait
// `document.getElementById('sidebar')` puis `if (!sidebar) return`. Le menu
// n'etait JAMAIS rendu, sans la moindre erreur en console : on entrait dans
// YieldFlow et on n'en sortait plus. Thierry : « les nouvelles pages coupent
// l'acces au menu ».
//
// ⚠ LISTE DERIVEE, PAS ECRITE. Toute page qui demandera un menu demain fera
// rougir ce test tant qu'elle n'aura pas son point de montage — on ne
// redecouvre pas le probleme en naviguant.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const RACINE = path.join(__dirname, '..')

// ⚠ UNE CLASSE, PAS UNE SOUS-CHAINE — trouve par ma propre contre-epreuve.
// Mon premier motif etait `/class=["'][^"']*\blayout\b[^"']*["']/`. Le tiret
// fait frontiere de mot en regex : `class="pas-content"` satisfaisait donc
// `\bcontent\b`, et retirer `.content` d'une page laissait le test VERT. On
// decoupe donc l'attribut sur les espaces et on compare des jetons entiers.
// Rend l'index de la premiere occurrence, ou -1 — l'ordre `.layout` avant la
// sidebar en depend.
function indexDeLaClasse (src, nom) {
  const re = /class=["']([^"']*)["']/g
  let m
  while ((m = re.exec(src)) !== null) {
    if (m[1].trim().split(/\s+/).includes(nom)) return m.index
  }
  return -1
}

function pagesHtml (dossier, acc = []) {
  for (const e of fs.readdirSync(path.join(RACINE, dossier), { withFileTypes: true })) {
    const rel = `${dossier}/${e.name}`
    if (e.isDirectory()) pagesHtml(rel, acc)
    else if (e.name.endsWith('.html')) acc.push(rel)
  }
  return acc
}

test('LE TEST QUI COMPTE : toute page qui demande un menu a son point de montage', () => {
  const manquantes = []
  for (const f of [...pagesHtml('pages'), ...pagesHtml('apps')]) {
    const src = fs.readFileSync(path.join(RACINE, f), 'utf8')
    if (!src.includes('renderSidebar(')) continue
    // Le composant cible CET identifiant, et rien d'autre.
    if (!/id=["']sidebar["']/.test(src)) manquantes.push(f)
  }
  assert.deepEqual(manquantes, [],
    'ces pages appellent renderSidebar sans exposer `id="sidebar"` : le menu ne sera pas rendu, '
    + 'et la page sera un cul-de-sac SANS aucune erreur')
})

test('LE TEST QUI COMPTE : le contrat de mise en page est respecte', () => {
  // `.layout` est en `display:flex; height:100vh` (public/style.css) et porte
  // `.sidebar` + `.main`. Sans le conteneur, la sidebar se pose hors du flux et
  // le `flex: 1` de `.main` ne s'applique a rien.
  const casses = []
  for (const f of [...pagesHtml('pages'), ...pagesHtml('apps')]) {
    const src = fs.readFileSync(path.join(RACINE, f), 'utf8')
    if (!/id=["']sidebar["']/.test(src)) continue
    // ⚠ ON TOLERE UNE CLASSE COMPOSEE. Chercher `class="layout"` a l'identique
    // ferait rougir a tort une future page en `class="layout compact"` — releve
    // en review. On cherche la classe, pas la chaine.
    const iLayout = indexDeLaClasse(src, 'layout')
    const iSidebar = src.search(/id=["']sidebar["']/)
    if (iLayout < 0 || iLayout > iSidebar) casses.push(f)
  }
  assert.deepEqual(casses, [],
    'ces pages posent une sidebar hors du conteneur `.layout` : la mise en page ne tient pas')
})

test('LE TEST QUI COMPTE : qui entre dans `.layout` doit porter `.content`', () => {
  // ⚠ LA REGRESSION QUE LA REVIEW A ARRETEE AVANT LIVRAISON, le 14 septembre 2026.
  // `.layout` et `.main` sont en `overflow:hidden` sur `height:100vh`
  // (public/style.css) : `.content` est le SEUL a porter `flex:1; overflow-y:auto`.
  // Ramener une page dans le conteneur pour lui rendre son menu, sans `.content`,
  // TRONQUE tout ce qui depasse la fenetre — sans barre de defilement, donc sans
  // rien pour prevenir. Le menu revenait, le contenu partait.
  // ⚠ LES EXEMPTIONS SE COMPTENT, ELLES NE SE DECRIVENT PAS — idiome du depot
  // (cf. le `ATTENDU` de tests/bookings-snapshot-troncature.test.js). Une de
  // plus, ou une de moins, et ce test parle.
  //
  // ⚠ DETTE DATEE DU 14 SEPTEMBRE 2026, ET UNE RESERVE SUR LA REGLE ELLE-MEME.
  // Ce test a decouvert en passant que les DEUX pages « calendrier » sont dans
  // `.layout` sans `.content`, et elles sont ANTERIEURES au correctif du menu.
  // Or `pages/biens-calendrier.html` est utilisee tous les jours sans plainte :
  // soit elles defilent par un chemin que je n'ai pas identifie (leurs controles
  // sont en `position: sticky`, ce qui suppose un conteneur qui defile), soit
  // elles tronquent depuis toujours.
  //
  // Je ne tranche pas sans rendu sous les yeux, et je ne les « corrige » pas au
  // passage d'un correctif qui ne les concerne pas : ce serait modifier deux
  // pages que Thierry n'a pas signalees, sur une hypothese. Elles sont donc
  // COMPTEES — une de plus ou une de moins fera parler ce test — et la regle ne
  // s'applique qu'aux pages dont on a verifie qu'elle vaut.
  const EXEMPTEES = {
    'apps/menages/garde.html':      'anterieure au 14/09/2026, a verifier a l ecran',
    'pages/biens-calendrier.html':  'anterieure au 14/09/2026, a verifier a l ecran'
  }

  const sansDefilement = []
  for (const f of [...pagesHtml('pages'), ...pagesHtml('apps')]) {
    if (EXEMPTEES[f]) continue
    const src = fs.readFileSync(path.join(RACINE, f), 'utf8')
    if (indexDeLaClasse(src, 'layout') < 0) continue
    if (indexDeLaClasse(src, 'content') < 0) sansDefilement.push(f)
  }
  assert.deepEqual(sansDefilement, [],
    'ces pages sont dans `.layout` sans `.content` : leur contenu sera tronque a la hauteur '
    + 'de la fenetre, sans barre de defilement')

  // ⚠ ET L'EXEMPTION EST VERIFIEE : le jour ou `garde.html` sera corrigee, ce
  // test rougira pour qu'on RETIRE la ligne, et la page redeviendra protegee.
  for (const [f, raison] of Object.entries(EXEMPTEES)) {
    const src = fs.readFileSync(path.join(RACINE, f), 'utf8')
    assert.ok(indexDeLaClasse(src, 'content') < 0,
      `${f} porte desormais .content — retirer son exemption (${raison})`)
  }
})

test('LE TEST QUI COMPTE : un point de montage absent se VOIT', () => {
  // ⚠ C'est le silence qui a laisse le defaut passer, pas l'erreur d'identifiant.
  // Une page qui APPELLE cette fonction veut un menu : ne pas pouvoir le poser
  // doit se dire.
  const src = fs.readFileSync(path.join(RACINE, 'components/sidebar.js'), 'utf8')
  const i = src.indexOf("getElementById('sidebar')")
  assert.ok(i > 0, 'le point de montage est bien cet identifiant')
  const bloc = src.slice(i, i + 700)
  assert.ok(/console\.error/.test(bloc), 'son absence est CRIEE, pas ravalee')
  assert.ok(!/if \(!sidebar\) return\s*$/m.test(bloc), 'plus de sortie muette')
})
