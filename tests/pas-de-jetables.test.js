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

// ⚠ POURQUOI CE SECOND TEST. Trois copies de modules SERVEUR — `menages.js`,
// `menages-public.js`, `sync-menages-entite.js` — sont parties dans un commit,
// laissées par un script de vérification qui restaurait ses sauvegardes au
// mauvais endroit. Or `vercel.json` porte `outputDirectory: "."` et il n'existe
// pas de `.vercelignore` : **la racine du dépôt EST le répertoire statique
// servi**. Publiées, ces copies auraient répondu sur
// `https://.../menages-public.js` sans aucune authentification, exposant le
// modèle d'autorisation complet, les noms de tables et de colonnes, et les
// commentaires qui documentent précisément les points faibles.
//
// Aucun secret en dur — tout passe par `process.env` — donc c'était de la
// divulgation, pas une fuite de clé. Une carte du système offerte, tout de même.
//
// `sw.js` est le seul `.js` légitime à la racine : c'est le service worker de la
// PWA, il DOIT être servi depuis là (sa portée est celle de son chemin).
test('aucun module serveur ne traîne à la racine du dépôt', () => {
  let suivis
  try {
    suivis = execFileSync('git', ['ls-files'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' })
  } catch {
    return
  }
  const AUTORISES = new Set(['sw.js'])
  const racine = suivis.split('\n')
    .map(f => f.trim())
    .filter(f => f && !f.includes('/') && /\.(js|mjs|cjs)$/.test(f))
    .filter(f => !AUTORISES.has(f))
  assert.deepStrictEqual(racine, [],
    `modules JS à la racine (donc servis en statique) : ${racine.join(', ')}. ` +
    `Le code serveur vit dans api/ et lib/ ; seul sw.js a sa place ici.`)
})
