// tests/protocole-recensement.test.js
// LE RECENSEMENT (spec-evaluation-voyageur §2 bis) : aucune app n'importe un
// fichier du coeur (`/core/`, `/lib/`), ni d'une autre app, ni n'appelle
// `api/avis` directement. Les apps ne connaissent que `/shared/` et
// `/components/` ; le coeur s'atteint par `/shared/hs-bus.js`.
//
// EXEMPTION A LA REGLE 19 (REVIEW.md), POSEE EXPLICITEMENT : ce balayage est
// VERT sur le code d'aujourd'hui, par construction — aucune app ne touche encore
// au coeur des avis. Sa contre-epreuve n'est donc pas « rougir contre le commit
// d'avant » mais un DOSSIER D'APP FAUTIF, cree pour l'occasion, que le meme
// balayage doit signaler ligne par ligne. Sa valeur est dans les lots suivants.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const RACINE = path.join(__dirname, '..')
const APPS = path.join(RACINE, 'apps')

// Les tables du coeur des avis : une app ne les lit jamais en direct.
const TABLES_DU_COEUR = ['ota_reviews', 'guest_evaluations', 'avis_config', 'core_events']

// Ce qu'une app n'a pas le droit d'atteindre, et pourquoi. Constat de review :
// la premiere version ne voyait que les chaines entre guillemets simples ou
// doubles ; la forme dominante du depot est le gabarit `fetch(`/api/…`)`, et
// un import relatif (`../../core/`) ou dynamique passait aussi.
const INTERDITS = [
  { motif: /(?:from\s*|import\s*\(\s*)['"`](?:\.{1,2}\/)*(?:\.\.\/)*\/?core\//, raison: 'import d’un module du coeur' },
  { motif: /(?:from\s*|import\s*\(\s*)['"`](?:\.{1,2}\/)*(?:\.\.\/)*\/?lib\//, raison: 'import d’un module serveur' },
  { motif: /\/api\/avis\b/, raison: 'appel direct de api/avis' },
  { motif: new RegExp(`\\.from\\(\\s*['"\`](?:${TABLES_DU_COEUR.join('|')})['"\`]`), raison: 'lecture directe d’une table du coeur des avis' },
]

function ecartsDansTexte (texte, app) {
  const e = []
  texte.split('\n').forEach((ligne, i) => {
    if (/^\s*(\/\/|\*|<!--)/.test(ligne)) return           // un commentaire n'importe rien
    for (const { motif, raison } of INTERDITS) if (motif.test(ligne)) e.push({ ligne: i + 1, raison, texte: ligne.trim().slice(0, 90) })
    // une app qui importe une AUTRE app (absolu ou relatif)
    const m = ligne.match(/(?:from\s*|import\s*\(\s*)['"`](?:\.{1,2}\/)*\/?apps\/([^/'"`]+)\//)
    if (m && m[1] !== app) e.push({ ligne: i + 1, raison: `import de l’app « ${m[1]} »`, texte: ligne.trim().slice(0, 90) })
  })
  return e
}

function ecartsDansDossier (racineApps) {
  const ecarts = []
  for (const f of fichiers(racineApps)) {
    const app = path.relative(racineApps, f).split(path.sep)[0]
    for (const e of ecartsDansTexte(fs.readFileSync(f, 'utf8'), app)) ecarts.push(`${path.relative(racineApps, f)}:${e.ligne} — ${e.raison} : ${e.texte}`)
  }
  return ecarts
}

function fichiers (dir) {
  const out = []
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name)
    if (f.isDirectory()) out.push(...fichiers(p))
    else if (/\.(html|js)$/.test(f.name)) out.push(p)
  }
  return out
}

test('le recensement mord : toutes les formes d’appel, ligne et raison', () => {
  const extrait = [
    "import { x } from '/shared/hs-bus.js'",                       // 1 autorise
    "import { y } from '/components/sidebar.js'",                  // 2 autorise
    "// import { z } from '/core/avis/fenetre.js'",                // 3 commentaire : ignore
    "import { z } from '/core/avis/fenetre.js'",                   // 4 fautif
    "const r = await fetch('/api/avis?action=list')",              // 5 fautif
    "import { w } from '/apps/yield/prix.js'",                     // 6 fautif depuis « menages »
    "const s = await fetch(`${API}/api/avis?booking_uid=${uid}`)", // 7 gabarit
    "const m = await import('../../core/avis/statut.js')",         // 8 relatif, dynamique
    "import { l } from '../lib/avis/notes.js'",                    // 9 serveur, relatif
    "const { data } = await supabase.from('guest_evaluations').select('*')", // 10 table du coeur
    "const { data: c } = await supabase.from('conversations').select('*')",  // 11 table de l'app : autorise
  ].join('\n')
  const e = ecartsDansTexte(extrait, 'menages')
  assert.deepStrictEqual(e.map(x => [x.ligne, x.raison]), [
    [4, 'import d’un module du coeur'],
    [5, 'appel direct de api/avis'],
    [6, 'import de l’app « yield »'],
    [7, 'appel direct de api/avis'],
    [8, 'import d’un module du coeur'],
    [9, 'import d’un module serveur'],
    [10, 'lecture directe d’une table du coeur des avis'],
  ])
})

test('contre-epreuve : un dossier d’app fautif, balaye comme le vrai, est signale', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-recensement-'))
  try {
    fs.mkdirSync(path.join(tmp, 'menages'))
    fs.writeFileSync(path.join(tmp, 'menages', 'public.html'), "<script type=\"module\">\nimport { hsBus } from '/shared/hs-bus.js'\nimport { f } from '/core/avis/fenetre-evaluation.js'\n</script>")
    fs.writeFileSync(path.join(tmp, 'menages', 'aide.js'), "export const url = `/api/avis?x=1`\n")
    const e = ecartsDansDossier(tmp)
    assert.strictEqual(e.length, 2, e.join('\n'))
    assert.match(e[0], /menages\/aide\.js:1 — appel direct de api\/avis/)
    assert.match(e[1], /menages\/public\.html:3 — import d’un module du coeur/)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('aucune app n’atteint le coeur ni une autre app autrement que par le bus', () => {
  const ecarts = ecartsDansDossier(APPS)
  assert.deepStrictEqual(ecarts, [], 'apps qui contournent le protocole :\n' + ecarts.join('\n'))
})
