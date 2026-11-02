// tests/i18n-parametres.test.js — CHAQUE `{parametre}` D'UN TEXTE EST PASSE
// PAR SON APPELANT.
//
// ⚠ CE FICHIER EXISTE A CAUSE D'UN DEFAUT TROUVE EN PRODUCTION PAR THIERRY LE
// 28 OCTOBRE 2026. `revenue.annee_rad_legende` vaut « {annee} réservé au
// {date} » ; l'ecran ne passait que `date`. `I18n.t` laisse alors l'accolade
// TELLE QUELLE — c'est son repli explicite quand une variable manque
// (`shared/i18n/i18n.js`, fonction `t` : `vars[k] ?? '{' + k + '}'`). La
// legende de la courbe et son info-bulle affichaient donc, chez l'hote,
// « {annee} réservé au 28 oct. ».
//
// ⚠ ET AUCUN TEST NE POUVAIT LE VOIR, pour une raison qui vaut d'etre ecrite :
// le double d'`I18n.t` du banc rend la CLEF (`t: (k) => k`), il ne substitue
// rien. Un ecran teste avec un traducteur qui ne traduit pas ne peut pas
// montrer un parametre manquant. La seule facon de l'attraper est de lire les
// APPELS et les TEXTES ensemble — ce que fait ce fichier — ou de rendre avec le
// VRAI `t`, ce que fait le dernier test.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const racine = path.join(__dirname, '..')

// ⚠ LE PLANCHER DE NON-VACUITE, ET C'EST UN NOMBRE MESURE. Si la lecture des
// appels casse, ce test n'aurait plus rien a verifier et resterait VERT — le
// faux vert que ce depot a deja paye plusieurs fois. Mon premier plancher etait
// a 30, un nombre rond : releve par la session chef de file le 28 octobre 2026,
// `fr.json` porte 100 clefs avec au moins un `{parametre}` et le front 160
// appels `t('…',` avec arguments. Un parseur qui aurait perdu LES TROIS QUARTS
// de sa portee restait donc vert.
// ⚠ IL SE RELEVE QUAND LE FRONT GRANDIT, et jamais l'inverse : si ce test
// rougit en annoncant moins d'appels verifies, c'est le PARSEUR qu'on corrige.
// Mesure du 28 octobre 2026 sur cette branche : **82** appels parametres
// verifies, hors objets construits ailleurs. Plancher pose a 75 — le compte du
// jour moins une petite marge, pour qu'un lot qui retire un appel ne rougisse
// pas, mais qu'une perte de portee du parseur, elle, rougisse.
const PLANCHER = 75
const fr = JSON.parse(fs.readFileSync(path.join(racine, 'shared/i18n/fr.json'), 'utf8'))

// Les `{parametre}` d'un texte. ⚠ `{n, plural, …}` EN FAIT PARTIE : sa variable
// est `n`, et elle doit etre passee comme les autres — un pluriel sans son
// nombre rend la categorie `other` avec un `#` non remplace.
const parametresDu = (texte) => {
  const out = new Set()
  for (const m of String(texte).matchAll(/\{(\w+)\s*,\s*plural\s*,/g)) out.add(m[1])
  // Les accolades simples, en excluant celles qui ouvrent un pluriel ou un cas.
  const sansPluriels = String(texte).replace(/\{(\w+)\s*,\s*plural\s*,((?:[^{}]|\{[^{}]*\})*)\}/g, '')
  for (const m of sansPluriels.matchAll(/\{(\w+)\}/g)) out.add(m[1])
  return out
}

// Les fichiers de front qui appellent `t(` ou `I18n.t(`.
const sources = () => {
  const out = []
  const voir = (dir) => {
    for (const e of fs.readdirSync(path.join(racine, dir), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) voir(rel)
      else if (/\.(html|js)$/.test(e.name)) out.push(rel)
    }
  }
  for (const d of ['pages', 'apps', 'shared']) voir(d)
  return out
}

// Un appel `t('cle', { a: …, b: … })` : la clef, et les NOMS des proprietes de
// premier niveau de l'objet. ⚠ ON NE LIT QUE LE PREMIER NIVEAU, et c'est
// pourquoi on compte les accolades : `{ date: f({ day: 'numeric' }) }` porte un
// objet imbrique, et une regex naive s'arreterait a sa premiere `}`.
const appelsDe = (src) => {
  const out = []
  const re = /\bt\(\s*'([a-z0-9_]+\.[a-z0-9_]+)'/gi
  for (const m of src.matchAll(re)) {
    const apres = src.slice(m.index + m[0].length)
    if (!/^\s*,/.test(apres)) { out.push({ cle: m[1], params: null }); continue }
    // On avance jusqu'a l'accolade ouvrante de l'objet, puis on l'equilibre.
    const debut = apres.indexOf('{')
    const virgule = apres.indexOf(',')
    if (debut === -1 || (debut > 0 && !/^[\s,]*$/.test(apres.slice(virgule, debut)))) {
      out.push({ cle: m[1], params: 'INDIRECT' }); continue
    }
    let p = 0, fin = -1
    for (let i = debut; i < apres.length; i++) {
      if (apres[i] === '{') p++
      else if (apres[i] === '}') { p--; if (p === 0) { fin = i; break } }
    }
    if (fin === -1) { out.push({ cle: m[1], params: 'INDIRECT' }); continue }
    const corps = apres.slice(debut + 1, fin)
    // Les clefs de premier niveau. ⚠ LES PROPRIETES ABREGEES COMPTENT :
    // `t('revenue.stays', { n })` passe bien `n`, et ma premiere version ne
    // lisait que `nom:` — elle signalait donc SIX appels justes comme fautifs.
    // Un test qui crie sur du code correct se fait desarmer, pas corriger.
    const noms = new Set()
    let prof = 0, mot = ''
    const poser = () => {
      const n = mot.trim().match(/^([A-Za-z_$][\w$]*)$/)
      if (n) noms.add(n[1])
      mot = ''
    }
    for (let i = 0; i < corps.length; i++) {
      const c = corps[i]
      if (c === '{' || c === '(' || c === '[') { prof++; mot += c }
      else if (c === '}' || c === ')' || c === ']') { prof--; mot += c }
      else if (prof === 0 && c === ':') {
        // `nom: valeur` — le nom est ce qui precede les deux-points.
        const n = mot.trim().match(/([A-Za-z_$][\w$]*)$/)
        if (n) noms.add(n[1])
        // On saute la valeur jusqu'a la virgule de meme niveau.
        let q = 0
        for (i++; i < corps.length; i++) {
          const d = corps[i]
          if (d === '{' || d === '(' || d === '[') q++
          else if (d === '}' || d === ')' || d === ']') q--
          else if (q === 0 && d === ',') break
        }
        mot = ''
      } else if (prof === 0 && c === ',') poser()
      else mot += c
    }
    poser()
    // Un `...quelquechose` dans l'objet : on ne sait pas ce qu'il apporte.
    out.push({ cle: m[1], params: /\.\.\./.test(corps) ? 'INDIRECT' : noms })
  }
  return out
}

// ⚠ LES CLEFS DONT LES ACCOLADES SONT **VOULUES**, nommees une par une avec
// leur raison. Ce ne sont pas des parametres : ce sont les variables que l'hote
// peut TAPER dans un modele de message, et le texte les lui montre. Les
// substituer les ferait disparaitre de l'aide.
// ⚠ ET CETTE LISTE NE PEUT PAS POURRIR EN SILENCE : un test plus bas exige que
// chaque entree existe encore ET porte encore une accolade. Une exemption se
// COMPTE, elle ne se decrit pas — c'est la discipline du `ATTENDU` de
// `tests/bookings-snapshot-troncature.test.js`.
const ACCOLADES_LITTERALES = {
  'messages.prog_placeholder': 'l exemple de modele montre a l hote : {prenom}, {logement}, {arrivee} sont ce qu il tape',
  'messages.prog_vars': 'la LISTE des variables disponibles — les substituer effacerait l aide'
}

test("LE TEST QUI COMPTE : la liste des accolades litterales ne pourrit pas", () => {
  // Une exemption qui ne designe plus rien est pire qu'absente : elle fait
  // croire que le cas est couvert.
  for (const [cle, raison] of Object.entries(ACCOLADES_LITTERALES)) {
    assert.ok(typeof fr[cle] === 'string', `« ${cle} » n existe plus dans fr.json — retirez son exemption`)
    assert.match(fr[cle], /\{\w+\}/,
      `« ${cle} » n a plus d accolade : son exemption ne sert plus (${raison})`)
  }
})

test("LE TEST QUI COMPTE : chaque `{parametre}` d'un texte est passe par son appelant", () => {
  const manques = []
  let verifies = 0
  for (const f of sources()) {
    const src = fs.readFileSync(path.join(racine, f), 'utf8')
    for (const { cle, params } of appelsDe(src)) {
      if (ACCOLADES_LITTERALES[cle]) continue
      const texte = fr[cle]
      if (texte == null || typeof texte !== 'string') continue  // clef d'un autre fichier
      const attendus = parametresDu(texte)
      if (!attendus.size) continue
      if (params === 'INDIRECT') continue  // objet construit ailleurs : non lisible ici
      verifies++
      const donnes = params === null ? new Set() : params
      for (const a of attendus) {
        if (!donnes.has(a)) manques.push(`${f} : t('${cle}') ne passe pas « ${a} » — « ${texte} »`)
      }
    }
  }
  // ⚠ LA NON-VACUITE D'ABORD : si la lecture des appels casse, ce test
  // n'aurait plus rien a verifier et resterait VERT. C'est le faux vert que ce
  // depot a paye plusieurs fois.
  // ⚠ LE PLANCHER EST UN NOMBRE MESURE, PAS UN NOMBRE ROND. Releve par la
  // session chef de file sur l'arbre fusionne le 28 octobre 2026 : `fr.json`
  // porte 100 clefs avec au moins un `{parametre}`, et le front contient
  // 160 appels `t('…',` avec arguments. Mon premier plancher etait a 30 : un
  // parseur qui aurait perdu LES TROIS QUARTS de sa portee serait reste vert.
  // Pose au compte du jour moins une marge, et il MONTE quand le front grandit
  // — un plancher qu'on ne releve jamais finit par ne plus rien tenir.
  if (process.env.COMPTER) console.log(`appels parametres verifies : ${verifies}`)
  assert.ok(verifies >= PLANCHER,
    `${verifies} appels parametres verifies, plancher ${PLANCHER} : la lecture des`
    + ' appels a perdu de sa portee — corrigez le parseur, ne baissez pas le plancher')
  assert.deepStrictEqual(manques, [],
    `${manques.length} appel(s) laisseraient une accolade dans le texte rendu :\n  ${manques.join('\n  ')}`)
})

test("LE TEST QUI COMPTE : la DEMONSTRATION du piege — un parametre manquant laisse son accolade", () => {
  // Sans cette demonstration, on pourrait croire qu'un parametre oublie rend
  // une chaine vide, ou leve. Il rend l'accolade, visible par l'hote.
  const t = traducteurReel()
  assert.match(t('revenue.annee_rad_legende', { date: '28 oct.' }), /\{annee\}/,
    'le repli d I18n.t a change : ce test garde la raison d etre du precedent')
})

test("LE TEST QUI COMPTE : la legende « reserve a date » ne garde AUCUNE accolade", () => {
  // La demande de Thierry, mot pour mot : « un test qui echoue si une accolade
  // reste dans le texte rendu ». Rendu par le VRAI `t`, dans les trois langues.
  for (const lang of ['fr', 'en', 'es']) {
    const rendu = traducteurReel(lang)('revenue.annee_rad_legende', { annee: '2025', date: '28 oct.' })
    assert.doesNotMatch(rendu, /[{}]/, `[${lang}] « ${rendu} » garde une accolade`)
    assert.match(rendu, /2025/, `[${lang}] « ${rendu} » ne porte pas l annee`)
    assert.match(rendu, /28 oct\./, `[${lang}] « ${rendu} » ne porte pas la date`)
  }
  assert.doesNotMatch(traducteurReel()('revenue.annee_rad_col_n1', { date: '28 oct.' }), /[{}]/,
    'l en-tete de colonne garde une accolade')
})

// ⚠ LE VRAI `t`, EXTRAIT DU MODULE — PAS REECRIT, ET PAS CHARGE NON PLUS.
// Reecrire la substitution testerait ma lecture du module au lieu du module :
// le repli `vars[k] ?? '{' + k + '}'` est precisement ce qu'on veut eprouver.
// Et charger le module entier ne marche pas : il installe `window.I18n` et
// remplit son dictionnaire par un `fetch` ASYNCHRONE, donc un test synchrone
// lirait un dictionnaire vide et `t` rendrait la clef — ma premiere version
// faisait ca, et ses deux assertions echouaient sans rien dire du code.
// On extrait donc le TEXTE des deux fonctions et on les evalue avec notre
// dictionnaire. Si l'une est renommee, l'extraction echoue et le test le DIT :
// c'est le seul couplage acceptable, parce qu'il se voit.
function traducteurReel (lang = 'fr') {
  const src = fs.readFileSync(path.join(racine, 'shared/i18n/i18n.js'), 'utf8')
  const dico = JSON.parse(fs.readFileSync(path.join(racine, `shared/i18n/${lang}.json`), 'utf8'))
  const tranche = (depart) => {
    const i = src.indexOf(depart)
    assert.notStrictEqual(i, -1,
      `« ${depart} » n existe plus dans shared/i18n/i18n.js : l extraction du vrai traducteur est a refaire`)
    // ⚠ ON NE COMPTE LES ACCOLADES QU'APRES LA LISTE DE PARAMETRES.
    // `function t(key, vars = {})` en porte une paire dans sa valeur par
    // defaut : un compteur naif referme la fonction DES CETTE PAIRE, et rend
    // une tranche qui ne compile pas. Mesure : `SyntaxError: Unexpected token
    // ';'` — un echec bruyant, heureusement, et non un `t` silencieusement faux.
    let par = 0, j = i
    for (; j < src.length; j++) {
      if (src[j] === '(') par++
      else if (src[j] === ')') { par--; if (par === 0) { j++; break } }
    }
    let p = 0, vu = false
    for (; j < src.length; j++) {
      if (src[j] === '{') { p++; vu = true }
      else if (src[j] === '}') { p--; if (vu && p === 0) return src.slice(i, j + 1) }
    }
    throw new Error(`accolades desequilibrees apres « ${depart} »`)
  }
  const fabrique = new Function('dict', 'fallbackDict', 'current',
    `${tranche('function plural(')}
${tranche('function t(')}
;return t`)
  return fabrique(dico, dico, lang)
}
