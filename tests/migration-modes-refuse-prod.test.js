// tests/migration-modes-refuse-prod.test.js
//
// ⚠ CE SCRIPT ECRIT LE REGLAGE QUI GOUVERNE LES ENVOIS AU VOYAGEUR, et la main
// de Thierry ne doit pas en etre la seule surete (sa condition du 28 octobre
// 2026). Un `--go` tape dans le mauvais terminal changerait le comportement de
// tous les biens d'un compte reel.
//
// ⚠ ET LA MENACE EST LA FAUTE DE FRAPPE, PAS L'ATTAQUANT : ce qui est teste
// ici, c'est le `.env` mal colle, la variable a « 1 », la reference tronquee
// d'un caractere, l'autre projet. C'est la lecon du depot sur les gardes
// d'identification.

const test = require('node:test')
const assert = require('node:assert')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { REF_PRODUCTION, REF_STAGING } = require('../lib/empreinte-base')

const SCRIPT = path.join(__dirname, '..', 'scripts', 'migrer-modes-vers-delais.js')

// ⚠ AUCUN ACCES REEL : l'URL est celle de la production, la CLE est bidon. Le
// refus ne depend que de l'URL, et il passe AVANT toute connexion — c'est
// precisement ce qui rend ce test possible sans toucher la base.
function lancer (args, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-prod-'))
  const envFile = path.join(dir, '.env')
  fs.writeFileSync(envFile,
    `SUPABASE_URL=https://${env.REF || REF_PRODUCTION}.supabase.co\n`
    + 'SUPABASE_SERVICE_KEY=cle-bidon-aucun-acces\n')
  try {
    const out = execFileSync(process.execPath,
      ['--env-file=' + envFile, SCRIPT, ...args],
      { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('LE TEST QUI COMPTE : --go sur la PRODUCTION est refuse, code 3', () => {
  const r = lancer(['--go'])
  assert.equal(r.code, 3, `code 3 attendu, recu ${r.code}`)
  assert.match(r.out, /REFUS/)
  assert.match(r.out, new RegExp(REF_PRODUCTION), 'le refus NOMME la base')
  assert.match(r.out, /CONFIRMER_PROD/, 'et il dit comment passer')
  // ⚠ IL REFUSE AVANT DE SE CONNECTER : avec une cle bidon, un script qui
  // lirait d'abord echouerait en « lecture impossible » (code 1).
  assert.ok(!/lecture impossible/.test(r.out),
    'le refus doit preceder toute connexion')
})

test('un DRAPEAU n ouvre rien — seule la reference du projet compte', () => {
  // Thierry avait demande `--confirmer-prod`. Le motif du depot est plus fort :
  // un drapeau s'ajoute par reflexe au bout d'une ligne de commande.
  for (const faux of ['--confirmer-prod', '--confirmer', '--force', '--prod']) {
    const r = lancer(['--go', faux])
    assert.equal(r.code, 3, `${faux} ne doit rien ouvrir`)
  }
})

test('⚠ LA FAUTE DE FRAPPE REFERME : valeur approchante, tronquee, autre projet', () => {
  const cas = [
    ['1', 'un drapeau deguise'],
    ['true', 'un booleen'],
    ['oui', 'un oui'],
    [REF_PRODUCTION.toUpperCase(), 'la casse change'],
    [REF_PRODUCTION.slice(0, -1), 'un caractere en moins'],
    [REF_PRODUCTION + 'x', 'un caractere en trop'],
    [REF_STAGING, 'la reference de STAGING'],
    ['', 'vide']
  ]
  for (const [valeur, pourquoi] of cas) {
    const r = lancer(['--go'], { CONFIRMER_PROD: valeur })
    assert.equal(r.code, 3, `« ${valeur} » (${pourquoi}) ne doit rien ouvrir`)
  }
})

test('la reference EXACTE passe le refus (et seule la cle bidon l arrete ensuite)', () => {
  const r = lancer(['--go'], { CONFIRMER_PROD: REF_PRODUCTION })
  assert.notEqual(r.code, 3, 'le refus est leve')
  assert.match(r.out, /lecture impossible|Invalid API key/,
    'et c est la cle bidon qui arrete, donc rien n a ete ecrit')
})

test('⚠ UN ESPACE AUTOUR DE LA VALEUR PASSE, ET C EST ASSUME', () => {
  // Mesure faite en eprouvant la garde : `.trim()` absorbe les espaces, comme
  // dans le motif existant du depot (verifier-migration-canaux-echec.js).
  // C'est voulu : un copier-coller avec un espace a une intention CLAIRE — la
  // personne a tape la reference complete —, alors qu'une troncature ou une
  // autre reference signalent une erreur reelle. On le NOMME plutot que de le
  // decouvrir un jour comme une surprise.
  for (const valeur of [REF_PRODUCTION + ' ', ' ' + REF_PRODUCTION, ` ${REF_PRODUCTION}\t`]) {
    const r = lancer(['--go'], { CONFIRMER_PROD: valeur })
    assert.notEqual(r.code, 3, 'un espace autour ne referme pas la porte')
  }
})

test('A BLANC, la production ne declenche aucun refus : elle se LIT', () => {
  // Sans `--go`, rien ne s ecrit — donc rien a proteger. Un refus ici
  // empecherait de verifier ce qu'une migration ferait, ce qui est exactement
  // le geste prudent.
  const r = lancer([])
  assert.notEqual(r.code, 3, 'pas de refus a blanc')
})

test('STAGING avec --go ne demande aucune confirmation', () => {
  const r = lancer(['--go'], { REF: REF_STAGING })
  assert.notEqual(r.code, 3, 'staging est la cible par defaut de ce script')
})
