// tests/pages-identifiants.test.js
// Les identifiants libres utilises par un script de page existent-ils ?
//
// ⚠ POURQUOI CE TEST EXISTE. J'ai ajoute `import { compteCourant } from …` dans
// le bloc `<script type="module">` de messagerie.html, alors que TOUS les usages
// sont dans le `<script>` CLASSIQUE juste en dessous — qui ne peut pas importer.
// Resultat : `ReferenceError: compteCourant is not defined` a la premiere
// lecture, et la messagerie ne s'affichait plus DU TOUT.
//
// Les 440 tests etaient verts : aucun ne charge le HTML. `pages-ids.test.js` ne
// verifie que les `id` du DOM, pas les identifiants JS. Ce test comble ce trou.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

// Pages dont le script principal est un script CLASSIQUE : il ne peut rien
// importer, donc tout ce qu'il utilise doit lui etre expose sur `window`.
// ⚠ pages/avis.html a la MEME structure : un <script type="module"> qui importe,
// et un <script> classique qui fait tout le travail. C'est exactement la
// configuration qui a tue la messagerie.
const PAGES = ['apps/agent-ai/messagerie.html', 'pages/avis.html']

// Helpers venus de shared/compte-courant.js, systematiquement en cause.
const HELPERS = ['compteCourant', 'peutEcrire', 'peutLire', 'enteteCompte', 'estTitulaire', 'apiCall']

function scripts (html) {
  const out = []
  for (const m of html.matchAll(/<script(\s+type="module")?>([\s\S]*?)<\/script>/g)) {
    out.push({ module: !!m[1], corps: m[2] })
  }
  return out
}

for (const page of PAGES) {
  test(`${page} : les helpers de compte sont exposes au script classique`, () => {
    const html = fs.readFileSync(path.join(__dirname, '..', page), 'utf8')
    const blocs = scripts(html)
    const modules = blocs.filter(b => b.module).map(b => b.corps).join('\n')
    const classiques = blocs.filter(b => !b.module).map(b => b.corps).join('\n')

    for (const h of HELPERS) {
      const utilise = new RegExp(`(^|[^.\\w])${h}\\s*\\(`).test(classiques)
      if (!utilise) continue
      // Utilise dans un script classique -> il doit etre pose sur window par un
      // module, sinon c'est un ReferenceError a l'execution.
      const expose = new RegExp(`window\\.${h}\\s*=`).test(modules)
      assert.ok(expose,
        `${h}() est appele dans le script classique de ${page} mais n'est jamais expose ` +
        `(un import dans le module ne suffit PAS : les deux scripts ne partagent pas leur portee)`)
    }
  })

  test(`${page} : ce qui est expose est bien importe`, () => {
    const html = fs.readFileSync(path.join(__dirname, '..', page), 'utf8')
    const modules = scripts(html).filter(b => b.module).map(b => b.corps).join('\n')
    for (const m of modules.matchAll(/window\.(\w+)\s*=\s*(\w+)\s*$/gm)) {
      const source = m[2]
      if (!HELPERS.includes(source)) continue
      assert.ok(new RegExp(`import\\s*\\{[^}]*\\b${source}\\b`).test(modules),
        `window.${m[1]} = ${source} mais ${source} n'est pas importe`)
    }
  })
}

test('les pages qui appellent l\'API en fetch brut posent X-Compte', () => {
  // ⚠ `shared/api-client.js` pose l'en-tete tout seul ; un `fetch` direct, non.
  // Sans lui, le serveur travaille sur le compte de l'appelant pendant que le
  // reste de la page lit le compte courant : l'ecran melange deux comptes.
  const cibles = [
    ['apps/menages/index.html', '/api/menages'],
    ['apps/agent-ai/messagerie.html', '/api/messages']
  ]
  for (const [page, endpoint] of cibles) {
    const html = fs.readFileSync(path.join(__dirname, '..', page), 'utf8')
    const i = html.indexOf(`fetch(\`${endpoint}`) >= 0
      ? html.indexOf(`fetch(\`${endpoint}`) : html.indexOf(`fetch('${endpoint}'`)
    assert.ok(i > 0, `appel a ${endpoint} introuvable dans ${page}`)
    const appel = html.slice(i, i + 400)
    assert.ok(appel.includes('enteteCompte()'),
      `${page} appelle ${endpoint} sans X-Compte : la delegation ne fonctionnera pas`)
  }
})

// ─── apiCall lève, il ne renvoie pas { error } ──────────────────────────────
// Renvoie les intervalles [debut, fin) de chaque bloc `try { ... }`, en suivant
// les accolades. Compter les `try` et les comparer au nombre d'appels ne prouve
// rien : trois `try` places n'importe ou laisseraient le test vert.
// Neutralise les commentaires SANS deplacer les offsets : un commentaire qui
// mentionne `apiCall (voir plus haut)` faisait un faux positif.
function sansCommentaires (src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

function blocsTry (src) {
  const zones = []
  const re = /try\s*\{/g
  let m
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length, prof = 1
    while (i < src.length && prof > 0) {
      if (src[i] === '{') prof++
      else if (src[i] === '}') prof--
      i++
    }
    zones.push([m.index, i])
  }
  return zones
}

test('pages/avis.html : chaque appel apiCall est DANS un try', () => {
  // ⚠ `apiCall` LÈVE sur réponse non-ok (l'erreur porte `.status`). Traiter son
  // retour comme `{ error }` laissait l'exception remonter : page blanche au
  // premier 403 — c'est-à-dire le cas NORMAL d'un membre au périmètre restreint,
  // pas un cas limite.
  const html = sansCommentaires(fs.readFileSync(path.join(__dirname, '..', 'pages/avis.html'), 'utf8'))
  const zones = blocsTry(html)
  const appels = [...html.matchAll(/apiCall\s*\(/g)]
    // L'affectation `window.apiCall = apiCall` n'est pas un appel.
    .filter(m => html.slice(m.index - 30, m.index).indexOf('window.apiCall =') === -1)
  assert.ok(appels.length >= 3, 'la page doit appeler apiCall')
  for (const a of appels) {
    const couvert = zones.some(([d, f]) => a.index > d && a.index < f)
    assert.ok(couvert,
      `appel apiCall non protégé à l'offset ${a.index} : une réponse 403 casserait la page`)
  }
})

// ─── L'ORDRE D'EXÉCUTION, pas seulement la présence ────────────────────────
//
// ⚠ POURQUOI CE TEST EXISTE. `pages/avis.html` exposait bien ses helpers sur
// `window` (le test plus haut le vérifiait) et lançait pourtant, en production :
// « window.apiCall is not a function », page vide.
//
// La présence ne suffit pas, l'ORDRE décide. Un `<script type="module">` est
// DIFFÉRÉ et ses `import` sont résolus EN RÉSEAU avant que son corps s'exécute ;
// un `<script>` classique s'exécute dès le parsing. Une initialisation accrochée
// à `DOMContentLoaded` part donc AVANT que le module ait posé quoi que ce soit —
// une course, gagnée en local où tout est en cache, perdue en production.
//
// Le motif correct est celui de la messagerie : le script classique EXPOSE une
// fonction d'init, et c'est le MODULE qui l'appelle, une fois ses helpers posés.

function partieModule (html) {
  const m = html.match(/<script type="module">([\s\S]*?)<\/script>/)
  return m ? m[1] : ''
}
function partiesClassiques (html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n')
}

// Globals fournis par un module et consommés par un script classique.
const FOURNIS_PAR_MODULE = ['apiCall', 'peutEcrire', 'peutLire', 'compteCourant',
                            'enteteCompte', 'estTitulaire', 'initAvis', 'loadConversations']

// ⚠ DECOUVERTE AUTOMATIQUE, pas une liste figee. Une liste ne protege que les
// pages qu'on a pense a y mettre — or ce bug est arrive sur une page NEUVE. Tout
// fichier melangeant un <script type="module"> et un <script> classique est
// examine, y compris ceux qui n'existent pas encore.
function pagesMixtes () {
  const racine = path.join(__dirname, '..')
  const trouvees = []
  const explorer = (rel) => {
    for (const e of fs.readdirSync(path.join(racine, rel), { withFileTypes: true })) {
      const chemin = rel + '/' + e.name
      if (e.isDirectory()) explorer(chemin)
      else if (e.name.endsWith('.html')) {
        const html = fs.readFileSync(path.join(racine, chemin), 'utf8')
        if (html.includes('<script type="module">') && /<script>/.test(html)) {
          trouvees.push(chemin.replace(/^\//, ''))
        }
      }
    }
  }
  explorer('pages'); explorer('apps')
  return trouvees
}

const MIXTES = pagesMixtes()

test('au moins une page mixte est examinée (sinon la découverte est cassée)', () => {
  assert.ok(MIXTES.length >= 2, `pages mixtes trouvées : ${MIXTES.join(', ') || 'aucune'}`)
})

for (const page of MIXTES) {
  test(`${page} : l'init n'est pas accrochée à DOMContentLoaded si elle consomme le module`, () => {
    const html = sansCommentaires(fs.readFileSync(path.join(__dirname, '..', page), 'utf8'))
    const module = partieModule(html)
    const classique = partiesClassiques(html)
    if (!module.trim() || !classique.trim()) return

    // Ce que le script classique consomme et que seul le module peut fournir.
    const consommes = FOURNIS_PAR_MODULE.filter(n =>
      new RegExp('window\\.' + n + '\\s*\\(').test(classique) &&
      new RegExp('window\\.' + n + '\\s*=').test(module))
    if (!consommes.length) return

    assert.ok(!/addEventListener\(\s*['"]DOMContentLoaded['"]/.test(classique),
      `${page} consomme ${consommes.join(', ')} depuis le module, mais s'initialise sur ` +
      `DOMContentLoaded : la course est perdue dès que le réseau est lent. ` +
      `Exposer une fonction d'init et la faire appeler PAR le module.`)
  })

  test(`${page} : le module déclenche bien l'initialisation`, () => {
    const html = sansCommentaires(fs.readFileSync(path.join(__dirname, '..', page), 'utf8'))
    const module = partieModule(html)
    const classique = partiesClassiques(html)
    if (!module.trim() || !classique.trim()) return

    // Toute fonction d'init exposée par le script classique doit être appelée
    // quelque part par le module — sinon rien ne démarre.
    const exposees = [...classique.matchAll(/window\.(\w*[Ii]nit\w*|loadConversations)\s*=/g)]
      .map(m => m[1])
    for (const nom of exposees) {
      assert.ok(new RegExp('window\\.' + nom + '\\s*\\(').test(module),
        `${page} expose window.${nom} mais le module ne l'appelle jamais : la page ne démarrera pas`)
    }
  })
}
