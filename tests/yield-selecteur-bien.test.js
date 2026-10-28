// tests/yield-selecteur-bien.test.js
// LE SELECTEUR DE LOGEMENT DES SIX ECRANS YIELDFLOW.
//
// ⚠ LE DEFAUT QU'IL EMPECHE, CONSTATE EN RECETTE SUR STAGING LE 28 OCTOBRE
// 2026 : sur `/apps/yield`, changer de logement ne changeait PAS la requete.
// `GET /api/yield` partait toujours avec le meme `property_id` — celui du
// premier bien par ordre alphabetique.
//
// ⚠ ET CE N'ETAIT PAS « GENANT », C'ETAIT TOTAL. Le selecteur n'avait aucun
// ecouteur `change`, ET le bouton « Charger » est MASQUE hors de la vue
// Exploration (`appliquerVue`), alors que la vue par defaut est Pilotage. Sur
// l'ecran tel qu'il s'ouvre, il n'existait donc AUCUN moyen de demander un
// autre logement. Un hote a plusieurs biens lisait les chiffres d'un seul,
// en croyant lire ceux qu'il avait choisis.
//
// ⚠ POURQUOI CE TEST PORTE SUR LES SIX ECRANS ET PAS SUR UN SEUL. Mesure du
// jour : cinq des six posaient bien leur ecouteur, `index.html` etait le seul
// a l'oublier. Garder le seul ecran fautif laisserait les cinq autres libres
// de le perdre a leur tour — et le defaut est invisible a la lecture d'un
// diff : il se voit en changeant de logement, sur un compte qui en a
// plusieurs.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const racine = path.join(__dirname, '..')
const lire = (f) => fs.readFileSync(path.join(racine, f), 'utf8')

// ⚠ L'ATTENDU EST NOMME, PAS DEDUIT D'UN BALAYAGE. Un ecran YieldFlow qui
// naitrait sans selecteur passerait inapercu d'une liste calculee ; ici, il
// faudra l'ajouter a la main, donc y penser.
const ECRANS = {
  'apps/yield/index.html': 'yf-bien',
  'apps/yield/prix.html': 'yp-bien',
  'apps/yield/comparables.html': 'cp-bien',
  'apps/yield/marche.html': 'mc-bien',
  'apps/yield/marche-global.html': 'mg-bien',
  'apps/yield/marche-temperature.html': 'mt-bien'
}

test('LE TEST QUI COMPTE : les six ecrans YieldFlow reagissent au changement de logement', () => {
  const sans = []
  for (const [page, id] of Object.entries(ECRANS)) {
    const src = lire(page)
    // Le selecteur existe-t-il bien sous ce nom ? Sinon ce test garde un
    // fantome, et son vert ne veut plus rien dire.
    assert.ok(src.includes(`id="${id}"`), `${page} : le selecteur ${id} est introuvable`)
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
    if (!new RegExp(`el\\('${id}'\\)\\.addEventListener\\('change'`).test(code)) sans.push(page)
  }
  assert.deepEqual(sans, [],
    'ces ecrans ne reagissent pas au changement de logement :\n' + sans.join('\n')
    + '\nUn hote y lirait les chiffres d un AUTRE bien que celui qu il a choisi.')
})

test("LE TEST QUI COMPTE : sur la synthese, le bouton « Charger » ne peut pas remplacer l ecouteur", () => {
  // ⚠ C'EST CE QUI RENDAIT LE DEFAUT TOTAL, et c'est ce qu'il faut garder :
  // si quelqu'un retirait l'ecouteur en se disant « il reste le bouton », il
  // rouvrirait exactement le defaut — le bouton n'existe pas dans la vue par
  // defaut.
  const src = lire('apps/yield/index.html')
  assert.match(src, /el\('yf-charger'\)\.hidden = vue !== 'exploration'/,
    'le bouton « Charger » est masque hors de la vue Exploration')
  // Et la vue par defaut n'est pas Exploration.
  assert.match(src, /let vue = 'pilotage'/,
    'la vue par defaut est Pilotage (decision de Thierry) : le bouton y est absent')
  assert.match(src.replace(/^[ \t]*\/\/.*$/gm, ' '), /el\('yf-bien'\)\.addEventListener\('change', charger\)/,
    'donc le changement de logement doit declencher la lecture lui-meme')
})
