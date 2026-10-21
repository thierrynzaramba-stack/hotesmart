const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const RACINE = path.join(__dirname, '..')
const lire = (p) => fs.readFileSync(path.join(RACINE, p), 'utf8')
const NAV = lire('shared/nav.js')
const LANGUES = ['fr', 'en', 'es']
const TRADS = Object.fromEntries(LANGUES.map(c => [c, JSON.parse(lire(`shared/i18n/${c}.json`))]))

// ⚠ LA LISTE EST DERIVEE DE `shared/nav.js`, PAS RECOPIEE. Une liste recopiee
// ne dit rien d'une cle ajoutee demain : elle se contente de garder celles
// qu'on avait en tete le jour ou on l'a ecrite.
const toutes = (re, s = NAV) => [...s.matchAll(re)].map(m => m[1])

const STATIQUES = [
  ...toutes(/data-i18n="([^"$]+)"/g),                            // le texte d'un element
  ...toutes(/data-i18n-attr['"]?\s*[=,]\s*['"]([^'"]+)['"]/g)    // « attribut:cle »
    .map(v => v.split(':').pop()),
  ...toutes(/\bkey:\s*'([^']+)'/g)                               // le tableau des entrees
]
const DYNAMIQUES = toutes(/data-i18n="(\$\{[^}]*\})"/g)
const CLES = [...new Set(STATIQUES)].sort()

// ⚠ LE COMPTE EST L'ASSERTION. Sans lui, un motif d'extraction casse par une
// reecriture de nav.js rendrait une liste VIDE, et un test vert sur rien.
test('LE TEST QUI COMPTE : shared/nav.js porte 15 cles, et les voici', () => {
  assert.equal(CLES.length, 15, `cles lues : ${CLES.join(', ')}`)
  assert.deepEqual(CLES, [
    'nav.account', 'nav.account_menu', 'nav.account_mine', 'nav.account_shared',
    'nav.calendar', 'nav.cleaning', 'nav.help', 'nav.language', 'nav.logout',
    'nav.messages', 'nav.properties', 'nav.reviews', 'nav.settings', 'nav.today',
    'nav.tools'
  ])
})

test('LE TEST QUI COMPTE : les 15 cles existent dans les TROIS langues', () => {
  for (const code of LANGUES) {
    const manquantes = CLES.filter(k => !(k in TRADS[code]))
    assert.deepEqual(manquantes, [], `${code}.json`)
  }
})

test('aucune des 15 n est traduite par une chaine vide', () => {
  for (const code of LANGUES) {
    for (const k of CLES) {
      assert.ok(String(TRADS[code][k]).trim().length > 0, `${code}.json : ${k} est vide`)
    }
  }
})

// ⚠ UNE EXEMPTION SE COMPTE, ELLE NE SE DECRIT PAS. Deux expressions seulement
// sont interpolees dans un `data-i18n`, et chacune est couverte plus bas.
test('LE TEST QUI COMPTE : exactement deux cles interpolees, et ce sont celles-la', () => {
  assert.deepEqual([...new Set(DYNAMIQUES)].sort(), ['${esc(o.key)}', '${n.key}'])
  assert.equal(DYNAMIQUES.length, 3)   // `${n.key}` sort deux fois : ordinateur et telephone
})

// ⚠ CONSTAT DE LA REVUE, ET IL ETAIT JUSTE. Mes deux filets laissaient passer
// la forme MIXTE — `data-i18n="nav.help_${variante}"` : le filet statique
// refuse tout ce qui porte un `$`, le filet dynamique exige que la valeur soit
// ENTIEREMENT une interpolation. Une telle cle n'entrait dans aucun compte, et
// les deux assertions ci-dessus ne bougeaient pas. Mesure : la cle
// `nav.inexistante_${suffixe}` inseree dans nav.js laissait ce fichier A 6/6,
// et tests/aujourdhui.test.js a 28/28. Ce n'est pas une forme theorique :
// pages/menages.html en livre deja cinq.
//
// La somme est le filet qui ne peut pas avoir de trou : tout `data-i18n="` du
// fichier doit tomber dans l'un des deux comptes, et rien d'autre.
test('LE TEST QUI COMPTE : tout `data-i18n` tombe dans un des deux comptes', () => {
  const poses = (NAV.match(/data-i18n="/g) || []).length
  const statiques = toutes(/data-i18n="([^"$]+)"/g).length
  assert.equal(poses, statiques + DYNAMIQUES.length,
    `${poses} data-i18n poses, ${statiques} statiques + ${DYNAMIQUES.length} interpoles comptes : une forme MIXTE echappe aux deux`)
  assert.equal(poses, 12)
  assert.equal((NAV.match(/data-i18n-attr/g) || []).length, 2)
})

// et aucune des 15 ne doit porter la trace d'une interpolation
test('les 15 cles ont la forme d une cle, pas d un gabarit', () => {
  for (const k of CLES) assert.match(k, /^[\w.]+$/, `cle suspecte : ${k}`)
})

// `${n.key}` ne peut valoir que les cles du tableau des entrees, qui sont dans
// les 15 ci-dessus. Reste `${esc(o.key)}` : la section « Outils », dont les
// cles viennent de l'APPELANT. On va les chercher chez lui.
// ⚠ CONSTAT DE LA REVUE : cette liste etait RECOPIEE, exactement le defaut que
// le commentaire en tete de ce fichier denonce. Une cinquieme page qui passerait
// `outils:` a HSNav avec une cle neuve n'etait couverte dans aucune langue, et
// le test restait vert. Elle se derive du depot.
const PAGES_OUTILS = (function () {
  const trouves = []
  const parcourir = (rel) => {
    for (const e of fs.readdirSync(path.join(RACINE, rel), { withFileTypes: true })) {
      const sous = `${rel}/${e.name}`
      if (e.isDirectory()) { parcourir(sous); continue }
      if (!/\.html$/.test(e.name)) continue
      if (/\boutils:\s*\[/.test(lire(sous))) trouves.push(sous)
    }
  }
  parcourir('pages'); parcourir('apps')
  return trouves.sort()
})()
const outilsDe = (p) => {
  const bloc = lire(p).match(/outils:\s*\[([\s\S]*?)\n\s*\]/)
  assert.ok(bloc, `${p} : pas de section outils`)
  return [...new Set(toutes(/\bkey:\s*'([^']+)'/g, bloc[1]))].sort()
}

// ⚠ ON N'EXIGE PAS UN NOMBRE D'APPELANTS, ON LES PREND TOUS. Un compte figé
// ici devrait etre releve a chaque ecran neuf du chantier V5 — et un compte
// qu'on releve par reflexe est une barriere qui ne fait plus arreter personne.
// Le seuil ne sert qu'a prouver que la decouverte a marche ; c'est la boucle
// qui protege, et elle couvre le cinquieme appelant comme le premier.
test('LE TEST QUI COMPTE : la cle interpolee de la section Outils est tracee jusqu a TOUS ses appelants', () => {
  assert.ok(PAGES_OUTILS.length >= 4, `decouverte vide ou trop courte : ${PAGES_OUTILS.join(', ')}`)
  const reference = outilsDe(PAGES_OUTILS[0])
  assert.equal(reference.length, 6, `cles Outils : ${reference.join(', ')}`)
  for (const p of PAGES_OUTILS) assert.deepEqual(outilsDe(p), reference, p)
  for (const code of LANGUES) {
    const manquantes = reference.filter(k => !(k in TRADS[code]))
    assert.deepEqual(manquantes, [], `${code}.json`)
  }
})

// `nav.account` est passee de DEUX facons : en texte et en aria-label. Si la
// seconde disparaissait, le selecteur de compte perdrait son nom accessible
// sans que la premiere s'en apercoive.
test('le selecteur de compte garde son aria-label', () => {
  assert.match(NAV, /data-i18n-attr="aria-label:nav\.account"/)
  assert.match(NAV, /data-i18n-attr['"]?\s*[=,]\s*'aria-label:nav\.language'/)
})
