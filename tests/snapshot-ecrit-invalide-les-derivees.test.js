// tests/snapshot-ecrit-invalide-les-derivees.test.js
//
// ⚠ POURQUOI CE TEST EXISTE. Les colonnes de revenus de `bookings_snapshot`
// sont calculees A L'ECRITURE, et `aDeriver` les juge a jour tant que
// `derive_le` est pose, que `derive_version` est la bonne et que
// `derive_raw_hash` correspond au payload. Or TROIS outils reecrivent
// `snapshot` directement, hors du writer unique — et aucun des trois ne
// touchait a ces trois champs.
//
// Consequence mesuree le 27 octobre 2026 : apres une neutralisation par
// `scripts/dedoublonner-sejours-remappes.js`, `aDeriver` repondait FALSE. Le
// statut passait a `demapped` dans le snapshot, l'argent restait calcule sur
// l'ancien, et le rattrapage de 04:00 ne reprenait JAMAIS la ligne. Le
// correctif de la regle v3 n'a fonctionne qu'une fois, grace au bump de
// `VERSION` — au passage suivant, il aurait ete sans effet.
//
// C'est la dette 114 generalisee : elle nommait `lib/migration-purge-futur.js`,
// le defaut vaut pour tout ecrivain direct.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { sansCommentaires, fichiersJs } = require('./outils/source')

const racine = path.join(__dirname, '..')

// Un `update({ snapshot ... })` sur `bookings_snapshot`, et ce qu'il contient.
function ecrituresDeSnapshot (src) {
  const out = []
  let i = src.indexOf('.update(')
  while (i !== -1) {
    let p = 0
    let j = src.indexOf('(', i)
    const debut = j
    for (; j < src.length; j++) {
      if (src[j] === '(') p++
      else if (src[j] === ')') { p--; if (p === 0) break }
    }
    const appel = src.slice(debut, j + 1)
    if (/\bsnapshot\s*:/.test(appel)) out.push(appel)
    i = src.indexOf('.update(', i + 1)
  }
  return out
}

test("LE TEST QUI COMPTE : qui reecrit `snapshot` invalide les colonnes derivees", () => {
  const fichiers = []
  for (const d of ['api', 'lib', 'scripts']) {
    const abs = path.join(racine, d)
    if (fs.existsSync(abs)) fichiers.push(...fichiersJs(abs, d))
  }
  assert.ok(fichiers.length > 50, `${fichiers.length} fichier(s) : le recensement n a rien lu`)

  const sansGarde = []
  let vus = 0
  for (const f of fichiers) {
    const src = sansCommentaires(fs.readFileSync(path.join(racine, f), 'utf8'))
    if (!src.includes("from('bookings_snapshot')")) continue
    for (const appel of ecrituresDeSnapshot(src)) {
      vus++
      // ⚠ `derive_le: null` SUFFIT, et c'est voulu : le premier cas d'`aDeriver`
      // est « jamais derivee ». Exiger les trois champs obligerait chaque
      // appelant a connaitre la regle de peremption, qui n'appartient qu'au
      // module.
      if (!/derive_le\s*:\s*null/.test(appel)) sansGarde.push(f)
    }
  }
  // La garde du vide : zero ecriture reperee rendrait zero constat, donc un vert.
  assert.ok(vus >= 3, `${vus} ecriture(s) de snapshot reperee(s) : le decoupage ne les voit plus`)
  assert.deepEqual(sansGarde, [],
    'ces fichiers reecrivent `snapshot` sans invalider les colonnes derivees.\n'
    + 'Le statut changera dans le snapshot, l argent restera calcule sur l ancien,\n'
    + 'et le rattrapage de 04:00 ne reprendra jamais la ligne : `aDeriver` la juge\n'
    + 'a jour. Ajouter `derive_le: null` a l `update`.\n' + sansGarde.join('\n'))
})

test('LE TEMOIN : le recensement attrape un `update` sans la garde', () => {
  // Sans lui, un decoupage casse rendrait zero constat et passerait pour un vert.
  const fautif = "await sb.from('bookings_snapshot').update({ snapshot: s, updated_at: t }).eq('id', x)"
  const trouve = ecrituresDeSnapshot(fautif)
  assert.strictEqual(trouve.length, 1, 'le decoupage ne voit pas une ecriture de snapshot')
  assert.ok(!/derive_le\s*:\s*null/.test(trouve[0]), 'le temoin porte deja la garde : il ne prouve rien')

  const juste = "await sb.from('bookings_snapshot').update({ snapshot: s, derive_le: null }).eq('id', x)"
  assert.ok(/derive_le\s*:\s*null/.test(ecrituresDeSnapshot(juste)[0]),
    'la forme correcte est signalee : le recensement crie a tort')

  // Une ecriture qui ne touche PAS `snapshot` n'est pas concernee.
  assert.deepEqual(ecrituresDeSnapshot("sb.from('bookings_snapshot').update({ derive_le: null })"), [],
    'une ecriture sans `snapshot` est comptee : le recensement deborde')
})
