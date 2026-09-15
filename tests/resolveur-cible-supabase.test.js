// tests/resolveur-cible-supabase.test.js
//
// `shared/config.js` choisit la base Supabase que le NAVIGATEUR attaque, a
// partir du seul signal disponible dans un site statique : le hostname.
// Quand il se trompe dans un sens, un deploiement de recette ecrit dans la
// base de PRODUCTION. Quand il se trompe dans l'autre, la production lit une
// base vide. Les deux sont muets.
//
// Ce fichier existe parce que ce code n'etait couvert par RIEN : les deux
// tests qui touchaient shared/config.js verifiaient le nom grave d'une app et
// la resolution des imports. Un caractere change dans un motif et la suite
// entiere restait verte.
//
// ⚠ IL PILOTE L'UNITE. On n'inspecte pas le source : on importe le module avec
// un `location` injecte et on regarde la cible qui en sort.

const test = require('node:test')
const assert = require('node:assert')
const { pathToFileURL } = require('node:url')
const path = require('node:path')

const CONFIG = pathToFileURL(path.join(__dirname, '..', 'shared', 'config.js')).href

// Chaque import doit reevaluer le module : une query unique casse le cache ESM.
let n = 0
async function cibleDe (hostname) {
  globalThis.location = { hostname }
  const info = console.info, err = console.error
  const erreurs = []
  console.info = () => {}
  console.error = (...a) => erreurs.push(a.join(' '))
  try {
    const m = await import(`${CONFIG}?n=${n++}`)
    return { cible: m.CIBLE_SUPABASE, env: m.ENV, erreurs }
  } finally {
    console.info = info
    console.error = err
    delete globalThis.location
  }
}

// ─── Les 17 hostnames de la contre-epreuve ──────────────────────────────────
const CAS = [
  // La production, sous toutes ses formes servies
  ['hotesmart.vercel.app', 'prod'],
  ['hotesmart.fr', 'prod'],
  ['www.hotesmart.fr', 'prod'],
  ['hotesmart-git-main-thierrynzaramba-3696s-projects.vercel.app', 'prod'],
  ['hotesmart-6tunq48sr-thierrynzaramba-3696s-projects.vercel.app', 'prod'],

  // ⚠ LE CAS QUI A FAIT RESSERRER LES MOTIFS. Une preview du projet de
  // PRODUCTION porte le nom de branche dans son hostname. Avec un test par
  // sous-chaine (`includes('staging')`), une branche nommee staging-quelque-
  // chose faisait basculer le FRONT sur la base de recette pendant que les
  // fonctions /api restaient sur la prod : etat mixte, silencieux.
  ['hotesmart-git-staging-setup-thierrynzaramba-3696s-projects.vercel.app', 'prod'],
  ['hotesmart-git-env-recette-setup-thierrynzaramba-3696s-projects.vercel.app', 'prod'],

  // Le poste de developpement
  ['localhost', 'prod'],
  ['127.0.0.1', 'prod'],

  // La recette, sous toutes ses formes servies
  ['hotesmart-staging.vercel.app', 'staging'],
  ['hotesmart-staging-git-staging-thierrynzaramba-3696s-projects.vercel.app', 'staging'],
  ['hotesmart-staging-a1b2c3d4-thierrynzaramba-3696s-projects.vercel.app', 'staging'],
  ['staging.hotesmart.fr', 'staging'],
  ['STAGING.HOTESMART.FR', 'staging'],

  // Ce qui PARLE de staging sans en etre : le repli sur la prod est le
  // comportement sur.
  ['notstaging.hotesmart.fr', 'prod'],
  ['hotesmart-staging2.vercel.app', 'prod'],
  ['recette.hotesmart.fr', 'prod']
]

for (const [hostname, attendu] of CAS) {
  test(`${hostname} -> ${attendu}`, async () => {
    const { cible } = await cibleDe(hostname)
    assert.strictEqual(cible, attendu)
  })
}

// ─── Les deux cibles ne se confondent pas ───────────────────────────────────
test('chaque cible porte sa propre base, et elles different', async () => {
  const p = await cibleDe('hotesmart.vercel.app')
  const s = await cibleDe('hotesmart-staging.vercel.app')
  assert.notStrictEqual(p.env.supabaseUrl, s.env.supabaseUrl,
    'prod et staging ne doivent JAMAIS pointer la meme base')
  assert.notStrictEqual(p.env.supabaseKey, s.env.supabaseKey)
  for (const e of [p.env, s.env]) {
    assert.match(e.supabaseUrl, /^https:\/\/[a-z]+\.supabase\.co$/)
    assert.ok(e.supabaseKey && e.supabaseKey.startsWith('sb_publishable_'),
      'la cle du front est publiable — jamais une service_role')
  }
})

// ─── L'avertissement bruyant ────────────────────────────────────────────────
test('un hostname qui parle de staging sans etre reconnu crie', async () => {
  const { cible, erreurs } = await cibleDe('hotesmart-staging2.vercel.app')
  assert.strictEqual(cible, 'prod', 'le repli sur la prod reste le comportement sur')
  assert.ok(erreurs.some(e => e.includes('hostname staging non reconnu')),
    'le repli ne doit pas etre muet')
})

test('un hostname de recette reconnu ne crie pas', async () => {
  const { erreurs } = await cibleDe('hotesmart-staging.vercel.app')
  assert.deepStrictEqual(erreurs, [], 'aucune alarme sur le cas nominal')
})

test('une preview de la prod ne crie pas non plus', async () => {
  const { erreurs } = await cibleDe('hotesmart-git-main-x.vercel.app')
  assert.deepStrictEqual(erreurs, [])
})
