// tests/pas-de-jetables.test.js
// Aucun script de diagnostic jetable ne doit être suivi par git.
//
// ⚠ POURQUOI CE TEST EXISTE. Un `_det.tmp.js` — sonde écrite pour lire les
// détections pendant un rattrapage — est parti dans un commit. Il ouvrait un
// client Supabase en service key et lisait `ota_reviews` en clair. Inoffensif en
// l'état (hors `/api`, jamais exécuté), mais c'est exactement le fichier qu'on
// ne veut pas voir traîner dans un dépôt.

const test = require('node:test')
const assert = require('node:assert')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

test('aucun script jetable n\'est suivi par git', () => {
  let suivis
  try {
    suivis = execFileSync('git', ['ls-files'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' })
  } catch {
    return  // hors dépôt git : rien à vérifier
  }
  const jetables = suivis.split('\n')
    .map(f => f.trim())
    .filter(f => /(^|\/)_[^/]*\.tmp\.(js|mjs|json)$/.test(f))
  assert.deepStrictEqual(jetables, [],
    `scripts jetables suivis par git : ${jetables.join(', ')}. ` +
    `Ils ouvrent souvent un client service key — les supprimer avant de committer.`)
})
