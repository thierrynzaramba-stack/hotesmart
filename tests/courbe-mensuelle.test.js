// tests/courbe-mensuelle.test.js — le module de courbe partage.
//
// ⚠ CE QU'IL GARDE EST CE QUI SE RATE : un mois sans valeur coupe le trait, un
// point isole se dessine plein, et un maximum nul ne fabrique pas de `NaN`.
// Le reste — couleurs, libelles, mise en forme — appartient a l'appelant.

const test = require('node:test')
const assert = require('node:assert/strict')
const { courbeMensuelle, _interne } = require('../shared/courbe-mensuelle.js')

const douze = (f) => Array.from({ length: 12 }, (_, k) => f(k))
const chemins = (svg) => (svg.match(/ d="([^"]*)"/g) || []).map(s => s.slice(4, -1))
const segments = (d) => (d.match(/[ML]/g) || []).join('')

test("LE TEST QUI COMPTE : un mois SANS valeur coupe le trait, il ne vaut pas zero", () => {
  // ⚠ DECISION DE THIERRY DU 27 OCTOBRE 2026 : « la courbe d'un logement
  // commence a son premier mois d'activite ». Relier janvier a septembre
  // par-dessus huit mois vides dessinerait une croissance qui n'a pas eu lieu ;
  // poser zero affirmerait qu'il n'a rien vendu alors qu'il n'existait pas.
  const svg = courbeMensuelle({
    series: [{ nom: 'A', couleur: '#000', valeurs: douze(k => (k >= 8 ? 100 : null)) }],
    resume: 'essai'
  })
  const d = chemins(svg)[0]
  // Un seul `M` : le trait DEMARRE en septembre et ne revient pas en arriere.
  assert.strictEqual(segments(d), 'MLLL', `le trait est decoupe autrement : ${segments(d)}`)
  assert.ok(!/,NaN|NaN,/.test(svg), 'des coordonnees NaN se sont glissees dans le trace')
})

test("LE TEST QUI COMPTE : un trou AU MILIEU coupe aussi, et le trait reprend", () => {
  const svg = courbeMensuelle({
    series: [{ nom: 'A', couleur: '#000', valeurs: douze(k => (k === 5 || k === 6 ? null : 50)) }],
    resume: 'essai'
  })
  // Deux morceaux : janvier->mai, puis aout->decembre. Donc DEUX `M`.
  const d = chemins(svg)[0]
  assert.strictEqual((d.match(/M/g) || []).length, 2,
    `le trait traverse le trou : ${segments(d)}`)
})

test("LE TEST QUI COMPTE : un point ISOLE se dessine plein, sinon il n'existe pas", () => {
  // Un mois seul entre deux mois vides ne trace AUCUN segment : sans ce point,
  // un logement qui n'a vendu qu'un mois dans l'annee n'apparait pas du tout.
  const svg = courbeMensuelle({
    series: [{ nom: 'A', couleur: '#123456', valeurs: douze(k => (k === 4 ? 70 : null)) }],
    resume: 'essai'
  })
  assert.match(svg, /<circle[^>]*r="3\.5"[^>]*fill="#123456"/,
    'le point isole n est pas plein : il sera invisible')
  // Et le chemin ne porte qu'un `M`, sans aucun `L` : rien a relier.
  assert.strictEqual(segments(chemins(svg)[0]), 'M')
})

test("LE TEST QUI COMPTE : un maximum NUL ne fabrique pas de NaN", () => {
  // ⚠ Une division par zero sort des `NaN` dans les coordonnees, et le
  // navigateur n'affiche alors RIEN, sans rien dire. Un plancher rend une
  // courbe plate, ce qui est la verite.
  for (const valeurs of [douze(() => 0), douze(() => null)]) {
    const svg = courbeMensuelle({ series: [{ nom: 'A', couleur: '#000', valeurs }], resume: 'e' })
    assert.ok(!/NaN/.test(svg), `NaN dans le trace pour ${JSON.stringify(valeurs.slice(0, 2))}…`)
  }
})

test("LE TEST QUI COMPTE : l'a-venir se distingue SANS changer de couleur", () => {
  // Decision 3 de Thierry : recu en trait plein, a venir distingue. La couleur
  // n'est jamais le seul porteur de sens — regle du depot.
  const svg = courbeMensuelle({
    series: [
      { nom: 'recu', couleur: '#000', valeurs: douze(() => 10) },
      { nom: 'a venir', couleur: '#000', pointille: true, valeurs: douze(() => 20) }
    ],
    resume: 'essai'
  })
  assert.strictEqual((svg.match(/stroke-dasharray/g) || []).length, 1,
    'le pointille ne distingue pas exactement une serie sur deux')
})

test("LE TEST QUI COMPTE : la courbe DIT ce qu'elle montre, et le texte est echappe", () => {
  const svg = courbeMensuelle({
    series: [{ nom: 'A', couleur: '#000', valeurs: douze(() => 1) }],
    resume: 'Revenus 2026 & 2025',
    bulle: () => '<script>alert(1)</script>'
  })
  assert.match(svg, /role="img"/, 'la courbe n est pas annoncee comme une image')
  assert.match(svg, /aria-label="Revenus 2026 &amp; 2025"/, 'le resume n est pas echappe')
  assert.ok(!svg.includes('<script>'), 'une bulle non echappee injecte du balisage')
})

test('RECENSEMENT : la geometrie reste coherente', () => {
  // Le module expose sa geometrie plutot que de la faire recopier par les tests.
  const { L, H, MARGE_G, MARGE_D, INITIALES } = _interne
  assert.strictEqual(INITIALES.length, 12, 'douze mois, pas un de plus')
  assert.ok(L > MARGE_G + MARGE_D, 'la largeur utile est negative')
  const svg = courbeMensuelle({ series: [], resume: 'vide' })
  assert.match(svg, new RegExp(`viewBox="0 0 ${L} ${H}"`))
  // ⚠ UNE SERIE VIDE REND QUAND MEME LA GRILLE ET L'AXE : un cadre vide se lit
  // « rien a montrer », un SVG absent se lit « la page est cassee ».
  assert.match(svg, /cm-axe/, 'une courbe sans serie ne rend pas son cadre')
})
