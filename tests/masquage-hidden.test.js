// tests/masquage-hidden.test.js
// `hidden` DOIT MASQUER, SUR TOUTES LES PAGES.
//
// ⚠ TROIS FOIS LE MEME DEFAUT, TROIS CORRECTIFS PAGE PAR PAGE. `hidden` est un
// attribut, et le navigateur le traduit par une regle de SA feuille :
// `[hidden] { display: none }`. Toute declaration d'AUTEUR — `.btn
// { display: inline-flex }` — l'emporte sur elle, parce que la specificite ne
// se compare pas entre origines. Un element masque reste donc VISIBLE des
// qu'une de nos classes lui pose un `display`.
//   · apps/yield/index.html — releve en review ;
//   · pages/avis.html — le bouton de saisie restait visible pour un membre
//     `avis: read` ;
//   · pages/biens.html, 19 octobre 2026 — « + Ajouter un bien », masque par
//     DROIT, etait visible et cliquable pour un membre delegue, et le serveur
//     ne refusait pas non plus.
// Et `shared/ui.css` annoncait l'avoir « ferme ICI pour toute la classe de
// defauts » — dans une feuille que 4 pages sur 45 chargeaient.
//
// ⚠ LA LIGNE EST RECOPIEE DANS LES TROIS FEUILLES DU SITE (decision de Thierry,
// 19 octobre 2026 : pas d'`@import`, qui ajoute une requete bloquante par
// feuille). Et sur les pages qui n'en chargent aucune, elle est EN LIGNE —
// `pages/book.html` doit rester autonome (marque blanche, embarquable, et un
// test le garde), et deux pages de l'app prestataire doivent tenir HORS LIGNE :
// une ligne en ligne n'a aucun cache a peupler.
//
// ⚠ C'EST DONC CE TEST, ET LUI SEUL, QUI TIENT LA COHERENCE DES COPIES. Il ne
// cherche pas une chaine : pour chaque page il RESOUT les feuilles chargees,
// suit leurs `@import` s'il en revenait, ajoute ses blocs `<style>`, et verifie
// que la regle lui parvient — et qu'elle est EFFECTIVE.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const RACINE = path.join(__dirname, '..')
const FEUILLES = ['public/style.css', 'shared/theme.css', 'shared/ui.css']

function pagesDuDepot () {
  const out = []
  const parcourir = (rel) => {
    for (const e of fs.readdirSync(path.join(RACINE, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name)
      if (e.isDirectory()) parcourir(r)
      else if (e.name.endsWith('.html')) out.push(r)
    }
  }
  for (const d of ['pages', 'apps']) parcourir(d)
  return out.sort()
}

// Le texte d'une feuille du depot, `@import` suivis, ou `null` si introuvable.
function feuilleResolue (href, vus = new Set()) {
  if (!href.startsWith('/')) return null          // une feuille distante ne nous regarde pas
  const rel = href.replace(/^\//, '').split('?')[0]
  if (vus.has(rel)) return ''
  vus.add(rel)
  const abs = path.join(RACINE, rel)
  if (!fs.existsSync(abs)) return null
  let texte = fs.readFileSync(abs, 'utf8')
  for (const m of texte.matchAll(/@import\s+url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
    const imp = feuilleResolue(m[1], vus)
    if (imp !== null) texte += '\n' + imp
  }
  return texte
}

// La regle est-elle EFFECTIVE ? Il faut `display: none` sur `[hidden]`, et soit
// `!important`, soit un selecteur compose — une regle nue perd contre une
// classe de meme specificite declaree apres.
function regleEffective (css) {
  for (const m of (css || '').matchAll(/([^{}]*\[hidden\][^{]*)\{([^}]*)\}/g)) {
    const sel = m[1].trim(), corps = m[2]
    if (!/display\s*:\s*none/.test(corps)) continue
    if (/!important/.test(corps)) return true
    if (/^[.#][\w-]+\[hidden\]|\[hidden\][.#][\w-]+/.test(sel)) return true
  }
  return false
}

const PAGES = pagesDuDepot()

test('LE TEST QUI COMPTE : les trois feuilles du site portent la regle', () => {
  for (const f of FEUILLES) {
    const css = fs.readFileSync(path.join(RACINE, f), 'utf8')
    assert.ok(regleEffective(css), `${f} ne porte pas de regle [hidden] effective`)
  }
})

test('les trois copies sont IDENTIQUES, au caractere', () => {
  // ⚠ C'EST LE PRIX DE LA LIGNE RECOPIEE : trois copies peuvent diverger. On
  // les compare, pour que la divergence soit un rouge et non une decouverte
  // dans six mois.
  const extraire = (css) => {
    const m = css.match(/\[hidden\][^{}]*\{[^}]*\}/)
    return m ? m[0].replace(/\s+/g, ' ').trim() : null
  }
  const vues = FEUILLES.map(f => [f, extraire(fs.readFileSync(path.join(RACINE, f), 'utf8'))])
  for (const [f, v] of vues) assert.ok(v, `${f} : aucune regle [hidden] trouvee`)
  const uniques = [...new Set(vues.map(([, v]) => v))]
  assert.equal(uniques.length, 1,
    'les copies ont diverge : ' + vues.map(([f, v]) => `${f} -> ${v}`).join(' | '))
})

test('LE TEST QUI COMPTE : la regle atteint CHAQUE page du depot', () => {
  assert.ok(PAGES.length > 30, `${PAGES.length} pages trouvees : le parcours ne marche pas`)
  const hors = []
  for (const p of PAGES) {
    const html = fs.readFileSync(path.join(RACINE, p), 'utf8')
    let css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n')
    for (const m of html.matchAll(/<link[^>]*href="([^"]*\.css)"/g)) {
      const f = feuilleResolue(m[1])
      if (f !== null) css += '\n' + f
    }
    if (!regleEffective(css)) hors.push(p)
  }
  assert.deepEqual(hors, [],
    `${hors.length} page(s) hors de portee de la regle de masquage : ` + hors.join(', ')
    + '\n  -> ajouter `<style>[hidden] { display: none !important; }</style>` a la page, '
    + 'ou lui faire charger une des trois feuilles du site.')
})

test('LE TEST QUI COMPTE : une page neuve qui oublie la regle est REFUSEE', () => {
  // ⚠ LA CONTRE-EPREUVE DU TEST LUI-MEME. Sans elle, il resterait vert si
  // `regleEffective` rendait toujours `true` — et il ne garderait plus rien.
  assert.equal(regleEffective(''), false, 'une page sans aucune regle serait acceptee')
  assert.equal(regleEffective('[hidden] { display: none }'), false,
    'une regle NUE est acceptee : elle perd contre une classe de meme specificite')
  assert.equal(regleEffective('.btn[hidden] { display: none }'), true)
  assert.equal(regleEffective('[hidden] { display: none !important }'), true)
  assert.equal(regleEffective('[hidden] { color: red }'), false,
    'une regle [hidden] sans display est acceptee')
})

test('si un `@import` revenait, il devrait preceder toute regle', () => {
  // Un `@import` place apres une regle est ignore EN SILENCE par le
  // navigateur : la page se chargerait sans ce qu'il apporte, et personne ne le
  // verrait. Et un `@import` vers un fichier absent est silencieux aussi.
  for (const f of FEUILLES) {
    const brut = fs.readFileSync(path.join(RACINE, f), 'utf8')
    // ⚠ ON RETIRE LES COMMENTAIRES D'ABORD : l'en-tete de ces feuilles parle
    // d'`@import`, et chercher dans le texte brut le trouvait DANS le
    // commentaire — faux rouge sur un fichier correct.
    const css = brut.replace(/\/\*[\s\S]*?\*\//g, '')
    const i = css.indexOf('@import')
    if (i === -1) continue
    assert.equal(css.slice(0, i).trim(), '',
      `${f} : du CSS precede le @import, le navigateur l ignorera`)
    assert.ok(regleEffective(feuilleResolue('/' + f)),
      `${f} importe une feuille mais la regle ne lui parvient pas`)
  }
})

test('pages/book.html reste AUTONOME : sa regle est en ligne', () => {
  // Marque blanche, embarquable : aucune feuille externe. C'est une promesse
  // produit, gardee par tests/book-page-selection.test.js — et c'est pourquoi
  // les quatorze pages orphelines portent la regle EN LIGNE et non par un
  // fichier partage.
  const html = fs.readFileSync(path.join(RACINE, 'pages/book.html'), 'utf8')
  assert.ok(!/<link[^>]+stylesheet/i.test(html), 'une feuille externe est apparue sur book.html')
  const style = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n')
  assert.ok(regleEffective(style), 'book.html n a plus la regle en ligne')
})

test('les pages HORS LIGNE de l app prestataire portent la regle en ligne', () => {
  // ⚠ ELLES DOIVENT TENIR SANS RESEAU. Une regle servie par un fichier devrait
  // etre dans le cache du service worker ; une ligne en ligne n'a aucun cache a
  // peupler, et c'est la raison du choix.
  for (const p of ['apps/menages/index.html', 'apps/menages/garde.html',
                   'apps/menages/public.html']) {
    const html = fs.readFileSync(path.join(RACINE, p), 'utf8')
    let css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n')
    for (const m of html.matchAll(/<link[^>]*href="([^"]*\.css)"/g)) {
      const f = feuilleResolue(m[1])
      if (f !== null) css += '\n' + f
    }
    assert.ok(regleEffective(css), `${p} : la regle ne lui parvient pas`)
  }
})

// ─── LE PIEGE DU `display` SUR UNE CELLULE DE TABLEAU ────────────────────────
//
// ⚠ POURQUOI CE TEST VIT DANS CE FICHIER. C'est celui qui tient la coherence
// entre les feuilles et ce que les pages promettent — la meme famille que
// `[hidden]`, mais pour une semantique qu'un `display` defait en silence.
//
// Vecu le 27 octobre 2026 : le bloc Revenus de l'accueil a recu un vrai
// `<table>` avec `<th scope="row">`, et le message de commit justifiait cette
// forme par l'accessibilite — « un lecteur d'ecran doit pouvoir dire "A venir,
// 480 €" sur la bonne cellule ». La feuille posait pourtant
// `display: flex` SUR le `<th>`, ce qui retire la semantique de cellule de
// l'arbre d'accessibilite : le `<th>` cesse d'etre un `rowheader`, `scope="row"`
// devient inerte, et l'annonce ne se produit pas. La forme etait justifiee par
// exactement ce qu'elle detruisait.
//
// ⚠ ET AUCUN TEST NE POUVAIT LE VOIR : c'etait le premier `scope="row"` du
// depot. La suggestion de ce garde-fou vient de la session chef de file, parce
// que le piege vaut pour tout le depot et pas seulement pour ce bloc.
test('LE TEST QUI COMPTE : aucune classe de cellule de tableau ne change son `display`', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const racine = path.join(__dirname, '..')

  // Les classes portees par un `<th>` ou un `<td>`, dans toutes les pages.
  const portees = new Set()
  const pages = []
  for (const dossier of ['pages', 'apps']) {
    const d = path.join(racine, dossier)
    if (!fs.existsSync(d)) continue
    for (const f of fs.readdirSync(d, { recursive: true })) {
      if (String(f).endsWith('.html')) pages.push(path.join(d, String(f)))
    }
  }
  assert.ok(pages.length > 10, `seulement ${pages.length} page(s) lue(s) : ce test ne mesure rien`)
  for (const f of pages) {
    const src = fs.readFileSync(f, 'utf8')
    for (const m of src.matchAll(/<(?:th|td)\b[^>]*class="([^"]+)"/g)) {
      // ⚠ ON NE GARDE QUE DES NOMS DE CLASSE VALIDES, et ma premiere version
      // n'en tenait pas compte : `class="${x ? 'a' : 'b'}"` donne des morceaux
      // comme `?` ou `:`, et `.?` comme expression reguliere correspond a
      // N'IMPORTE QUOI — le test rendait donc trois faux positifs sur des
      // classes qui n'existent pas. Un garde-fou qui crie a tort se fait
      // desactiver, ce qui est pire que son absence.
      for (const c of m[1].split(/\s+/)) {
        if (/^[A-Za-z_-][\w-]*$/.test(c)) portees.add(c)
      }
    }
  }
  assert.ok(portees.size > 0, 'aucune cellule de tableau trouvee : ce test ne mesure rien')

  // ⚠ ET ON CHERCHE LE `display` DANS LES TROIS FEUILLES, parce qu'une classe
  // declaree deux fois ne se lit pas a un seul endroit — c'est la lecon de
  // `[hidden]`.
  const feuilles = ['shared/ui.css', 'shared/theme.css', 'public/style.css']
    .filter(f => fs.existsSync(path.join(racine, f)))
  const fautifs = []
  for (const f of feuilles) {
    const css = fs.readFileSync(path.join(racine, f), 'utf8')
    for (const classe of portees) {
      // ⚠ TOUTES LES DECLARATIONS DE LA CLASSE, PAS LA PREMIERE. Ma premiere
      // version faisait `css.match(...)` : la mutation « remettre le flex sur
      // le <th> » ne la faisait pas rougir, parce que la classe est declaree
      // DEUX fois dans la feuille — une pour le `font-weight`, une pour le
      // `display` — et `match` ne rend que la premiere. Un test qui ne regarde
      // qu'une occurrence passe a cote du defaut des qu'une feuille repete un
      // selecteur, ce que toutes font.
      const motif = new RegExp('\\.' + classe.replace(/-/g, '\\-') + '\\s*\\{([^}]*)\\}', 'g')
      for (const bloc of css.matchAll(motif)) {
        const d = bloc[1].match(/display\s*:\s*([a-z-]+)/)
        if (d && !['table-cell', 'table-row', 'none', 'revert', 'inherit'].includes(d[1])) {
          fautifs.push(f + ' : .' + classe + ' { display: ' + d[1] + ' } — porte par un <th> ou <td>')
        }
      }
    }
  }
  assert.deepEqual(fautifs, [],
    'une classe de cellule de tableau change son `display` : la cellule quitte l arbre '
    + 'd accessibilite, `scope` devient inerte, et le lecteur d ecran n annonce plus la '
    + 'colonne. Le `display` doit vivre sur un ENFANT de la cellule.')
})
