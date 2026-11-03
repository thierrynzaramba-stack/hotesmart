// tests/rapport-base-connaissance.test.js
//
// LE RAPPORT DU LOT 2 EST EN LECTURE SEULE, ET DEUX CHOSES LE GARANTISSENT.
//
// ⚠ UN SCRIPT QUI PEUT ECRIRE FINIT PAR ECRIRE. Thierry a dit « a blanc
// uniquement, aucune ecriture en prod » : la garantie n'est donc pas un drapeau
// qu'on peut oublier de passer, c'est l'ABSENCE de tout chemin d'ecriture dans
// le fichier. Ce test la tient.
//
// ⚠ ET UN SECRET NE PASSE JAMAIS PAR LE TERMINAL (regle absolue du depot) : la
// sortie d'un script part dans l'historique du shell et dans les transcriptions
// de session. Le mot de passe wifi s'imprime donc par son nom et sa LONGUEUR.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const chemin = path.join(__dirname, '..', 'scripts', 'rapport-base-connaissance.js')
const brut = fs.readFileSync(chemin, 'utf8')
// Commentaires retires : le fichier PARLE de ce qu'il ne fait pas, et un test
// qui lit la source brute confondrait la promesse avec le manquement.
const code = brut
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^[ \t]*\/\/.*$/gm, ' ')

test('LE TEST QUI COMPTE : le rapport ne porte AUCUN chemin d ecriture', () => {
  for (const motif of [/\.update\(/, /\.upsert\(/, /\.insert\(/, /\.delete\(/, /--go/, /CONFIRMER_PROD/]) {
    assert.ok(!motif.test(code),
      `le rapport est en lecture seule : ${motif} n a rien a y faire`)
  }
  // Et la contre-epreuve du test lui-meme : il DOIT voir une ecriture quand il
  // y en a une. Sans ca, « aucun chemin » resterait vrai d un motif casse.
  assert.ok(/\.update\(/.test(code + ' sb.update('), 'le detecteur voit une ecriture quand il y en a une')
})

test('LE TEST QUI COMPTE : le mot de passe wifi ne s imprime JAMAIS', () => {
  // On EXECUTE la fonction de masquage du script plutot que de lire sa source :
  // une constante bien ecrite ne prouve pas qu elle est appliquee.
  const m = /const SECRETES = new Set\(\[([^\]]*)\]\)/.exec(code)
  assert.ok(m, 'le script declare les cles secretes')
  assert.match(m[1], /'wifi_mdp'/, 'le mot de passe wifi en fait partie')

  // ⚠ ON APPELLE LA FONCTION, on ne l'extrait pas du texte : ma premiere
  // version la reconstruisait par expression reguliere, et elle mesurait alors
  // sa propre regex. Le script n'execute son rapport que lance en direct
  // (`require.main`), donc le requerir ici ne touche aucune base.
  const { masque } = require('../scripts/rapport-base-connaissance')
  const rendu = masque('wifi_mdp', 'MOT-DE-PASSE-DE-TEST')
  assert.ok(!rendu.includes('MOT-DE-PASSE-DE-TEST'), 'la valeur ne sort pas')
  assert.match(rendu, /masqué, 20 caractères/, 'le nom et la longueur suffisent')
  // Une cle ordinaire, elle, s imprime : sinon le rapport ne servirait a rien.
  assert.equal(masque('wifi_nom', 'Livebox-A1B2'), 'Livebox-A1B2')
})

test('le rapport pagine ses lectures : PostgREST tronque a 1000 SANS erreur', () => {
  // C est la famille de defauts la plus silencieuse du depot.
  assert.match(code, /\.range\(de, de \+ 499\)/, 'les lectures se paginent par plage')
  assert.ok(!/\.select\([^)]*\)\s*\n?\s*$/m.test(code) || /range\(/.test(code),
    'aucune lecture ne part sans borne')
})
