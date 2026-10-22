// tests/outils/colonnes-selectionnees.js
//
// ⚠ LA CLASSE DE DEFAUTS QUE CET OUTIL FERME : « une garde qui juge sur une
// colonne non selectionnee est une garde ouverte ». Une colonne absente du
// `.select(...)` vaut `undefined` sur l'objet rendu — et `undefined` passe
// toutes les comparaisons qu'une garde ecrit naturellement (`!= null`, `<`,
// `>`). La garde ne refuse donc plus rien, pour personne, sans une ligne
// d'erreur nulle part.
//
// TROIS FOIS DANS LE SEUL api/channel-property.js, dont une qui a traverse la
// recette : `base_price`, le cran d'arret, `migration_target_property_id`, puis
// `prix_minimum` le 22 octobre 2026. Le fichier portait la lecon ECRITE deux
// lignes au-dessus du defaut.
//
// ─────────────────────────────────────────────────────────────────────────────
// L'ANCRE EST LA LECTURE, PAS LE SELECT — ET C'EST CE QUI REND L'INVARIANT
// POSSIBLE
// ─────────────────────────────────────────────────────────────────────────────
// Premiere version : on partait du `.select('…')`. Une liste ECRITE AUTREMENT
// — concatenee, en ternaire — ne correspondait a aucun motif, donc elle n'etait
// ni examinee NI COMPTEE : elle disparaissait. Mesure du 22 octobre 2026, sur
// api/channel-bcom-write.js, dont la liste est coupee en deux chaines et dont
// la ligne suivante porte `if (!prop.provider_rate_plan_id)` : retirer cette
// colonne de la liste laissait 282 lectures examinees, 0 constat, angles morts
// inchanges. Silence complet sur la classe meme qu'on garde.
//
// On part donc de `.single()` / `.maybeSingle()` : UNE ancre = UNE lecture
// d'une ligne. Chaque ancre tombe dans exactement un compteur, et le test
// verifie l'EGALITE `examinees + somme des angles morts === ancres`. Une
// lecture qui sort du balayage devient un rouge, non une disparition.
//
// ─────────────────────────────────────────────────────────────────────────────
// CE QU'IL NE VOIT PAS — nomme ici, et chiffre par le test (REVIEW.md regle 20)
// ─────────────────────────────────────────────────────────────────────────────
//   • les lectures de COLLECTIONS (sans `.single()`) : 529 selects litteraux
//     dans api+lib+scripts+shared, hors de portee. Il faudrait suivre l'alias
//     du callback, donc une analyse de portee. C'est la plus grande surface non
//     couverte, et le test la chiffre pour qu'elle ne passe pas pour couverte ;
//   • `select('*')` et les selects imbriques (`table(col)`), qui ne promettent
//     aucune liste fermee ;
//   • une liste de colonnes posee dans une constante d'un AUTRE fichier ;
//   • une ligne passee a une fonction auxiliaire au-dela du premier niveau.

const fs = require('fs')
const path = require('path')

// Proprietes qui ne sont JAMAIS une colonne : les lire ne prouve rien.
const NON_COLONNES = new Set([
  'length', 'map', 'filter', 'forEach', 'find', 'findIndex', 'some', 'every',
  'reduce', 'includes', 'indexOf', 'slice', 'splice', 'push', 'pop', 'shift',
  'sort', 'reverse', 'join', 'concat', 'flat', 'flatMap', 'toString',
  'valueOf', 'hasOwnProperty', 'then', 'catch', 'finally', 'constructor',
  'keys', 'values', 'entries', 'at'
])

// ⚠ UN RETRAIT DE COMMENTAIRES QUI NE CONNAIT PAS LES CHAINES EFFACE DU CODE.
// Mesure du 22 octobre 2026 : `const _e = 'voir /* la doc'` injecte dans
// api/channel-property.js faisait SORTIR LE FICHIER ENTIER du balayage —
// 125 fichiers couverts devenaient 124, zero constat, test entierement vert.
// Et le fichier en question est celui pour lequel ce lot existe. Meme famille
// que `accept="image/*"`, qui avalait 470 lignes de l'outil `imports-modules`
// le 21 octobre : la garde « un `/*` doit commencer un jeton » ne protege que
// le `/*` COLLE a un guillemet, pas celui precede d'un espace DANS la chaine.
//
// On scanne donc en etats : code, chaine simple, chaine double, gabarit,
// litteral de regex. Les chaines sont CONSERVEES (une colonne peut y etre
// nommee) ; seuls les commentaires disparaissent.
function sansCommentaires (src) {
  let out = ''
  let i = 0
  // Dernier caractere significatif emis : il dit si un `/` ouvre une regex.
  let precedent = ''
  while (i < src.length) {
    const c = src[i]
    const d = src[i + 1]

    if (c === '/' && d === '*') {
      const fin = src.indexOf('*/', i + 2)
      i = fin === -1 ? src.length : fin + 2
      out += ' '
      continue
    }
    if (c === '/' && d === '/') {
      const fin = src.indexOf('\n', i)
      i = fin === -1 ? src.length : fin
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const fin = finDeChaine(src, i, c)
      out += src.slice(i, fin)
      precedent = c
      i = fin
      continue
    }
    // Un `/` ouvre un litteral de regex seulement apres un contexte d'operande.
    if (c === '/' && /[(,=:[!&|?{};+\-*%~^]/.test(precedent)) {
      const fin = finDeRegex(src, i)
      if (fin > i) { out += src.slice(i, fin); i = fin; precedent = '/'; continue }
    }
    out += c
    if (!/\s/.test(c)) precedent = c
    i++
  }
  return out
}

function finDeChaine (src, debut, delim) {
  let i = debut + 1
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue }
    if (src[i] === delim) return i + 1
    // Une chaine simple ou double ne franchit pas la fin de ligne : si elle le
    // fait, c'est qu'on s'est trompe de delimiteur — on s'arrete la plutot que
    // d'avaler le reste du fichier.
    if (delim !== '`' && src[i] === '\n') return i
    i++
  }
  return src.length
}

function finDeRegex (src, debut) {
  let i = debut + 1
  let dansClasse = false
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') { i += 2; continue }
    if (c === '\n') return debut // pas une regex
    if (c === '[') dansClasse = true
    else if (c === ']') dansClasse = false
    else if (c === '/' && !dansClasse) {
      i++
      while (i < src.length && /[a-z]/.test(src[i])) i++
      return i
    }
    i++
  }
  return debut
}

function fichiersJs (racine, dossiers) {
  const trouves = []
  for (const d of dossiers) {
    const base = path.join(racine, d)
    if (!fs.existsSync(base)) continue
    ;(function marche (dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue
        const p = path.join(dir, e.name)
        if (e.isDirectory()) marche(p)
        else if (e.name.endsWith('.js')) trouves.push(p)
      }
    })(base)
  }
  return trouves.sort()
}

// `alias:source` — la cle LUE est l'ALIAS, donc ce qui precede le deux-points.
// Prendre l'apres faisait passer `cache:raw->attributes->is_hidden` pour la
// colonne `raw->…`, et `objetOta.cache` pour un oubli (faux constat mesure).
function clesDuSelect (liste) {
  return new Set(liste.split(',').map(x => {
    const t = x.trim()
    return (t.includes(':') ? t.split(':')[0] : t).trim()
  }).filter(Boolean))
}

// Les listes de colonnes posees en constante DANS LE MEME FICHIER — en chaine
// ET EN TABLEAU. ⚠ Le tableau est la forme du lecteur de la fiche logement
// (`lib/logement/lecture.js`, `const COLONNES_BIEN = [...]` passe tel quel a
// `.select(...)`, que Supabase joint par virgules) : ne connaitre que la chaine
// laissait ce fichier — l'un des sentinelles de ce lot — hors du balayage.
function constantesDeColonnes (src) {
  const table = new Map()
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*'([^']+)'/g
  let m
  while ((m = re.exec(src)) !== null) {
    if (/^[a-z_]+(\s*,\s*[a-z_0-9:>-]+)*$/i.test(m[2])) table.set(m[1], m[2])
  }
  const reT = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[/g
  while ((m = reT.exec(src)) !== null) {
    const ouvre = src.indexOf('[', m.index + m[0].length - 1)
    let prof = 0
    let j = ouvre
    for (; j < src.length; j++) {
      if (src[j] === '[') prof++
      else if (src[j] === ']') { prof--; if (prof === 0) break }
    }
    const dedans = src.slice(ouvre + 1, j)
    // Un tableau de colonnes ne contient que des chaines simples.
    if (/[({]/.test(dedans)) continue
    const cols = [...dedans.matchAll(/'([^']+)'/g)].map(x => x[1])
    if (cols.length && cols.every(c => /^[a-z_][\w:>-]*$/i.test(c))) {
      table.set(m[1], cols.join(','))
    }
  }
  return table
}

// ─────────────────────────────────────────────────────────────────────────────
// RESOLUTION DE L'ARGUMENT DE `.select(...)`
// ─────────────────────────────────────────────────────────────────────────────
// Trois formes vivantes dans le depot, et chacune a sa regle :
//   • un litteral                      -> ses colonnes
//   • une CONCATENATION (`'a, ' + 'b'`) -> l'UNION : c'est une seule liste
//     coupee en morceaux (api/channel-bcom-write.js, api/membres.js)
//   • un TERNAIRE (`x ? 'a, b' : 'a'`)  -> l'INTERSECTION, et c'est le point
//     important : une colonne absente d'UNE branche suffit a ouvrir la garde,
//     donc n'est garantie que ce qui est dans TOUTES les branches
//     (api/reservation-directe.js)
// Rend { cols } | { etoile: true } | null (non resolue, et alors COMPTEE).
function resoudreListe (expr, constantes) {
  const t = expr.trim()
  if (!t) return null
  if (t.includes('*')) return { etoile: true }

  const q = coupeHorsChaines(t, '?')
  if (q !== -1) {
    const reste = t.slice(q + 1)
    const colon = coupeHorsChaines(reste, ':')
    if (colon !== -1) {
      const a = resoudreListe(reste.slice(0, colon), constantes)
      const b = resoudreListe(reste.slice(colon + 1), constantes)
      if (!a || !b) return null
      if (a.etoile || b.etoile) return { etoile: true }
      const inter = new Set([...a.cols].filter(x => b.cols.has(x)))
      return { cols: inter }
    }
  }

  const morceaux = []
  let reste = t
  let plus = coupeHorsChaines(reste, '+')
  while (plus !== -1) {
    morceaux.push(reste.slice(0, plus))
    reste = reste.slice(plus + 1)
    plus = coupeHorsChaines(reste, '+')
  }
  morceaux.push(reste)

  const cols = new Set()
  for (const mo of morceaux) {
    const p = mo.trim()
    const lit = p.match(/^'([^']*)'$/) || p.match(/^"([^"]*)"$/)
    if (lit) {
      if (lit[1].includes('(')) return null
      for (const c of clesDuSelect(lit[1])) cols.add(c)
      continue
    }
    if (/^[A-Za-z_$][\w$.]*$/.test(p) && constantes.has(p)) {
      for (const c of clesDuSelect(constantes.get(p))) cols.add(c)
      continue
    }
    return null
  }
  return { cols }
}

// Position d'un operateur de premier niveau, hors chaines et hors parentheses.
function coupeHorsChaines (t, op) {
  let prof = 0
  let i = 0
  while (i < t.length) {
    const c = t[i]
    if (c === "'" || c === '"' || c === '`') { i = finDeChaine(t, i, c); continue }
    if (c === '(' || c === '[') prof++
    else if (c === ')' || c === ']') prof--
    else if (c === op && prof === 0) return i
    i++
  }
  return -1
}

// L'argument entre parentheses appariees, a partir de l'index de la `(`.
function argumentApparie (src, iParen) {
  let prof = 0
  let i = iParen
  while (i < src.length) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') { i = finDeChaine(src, i, c); continue }
    if (c === '(') prof++
    else if (c === ')') { prof--; if (prof === 0) return { texte: src.slice(iParen + 1, i), fin: i } }
    i++
  }
  return null
}

// ⚠ LA FORME DE L'OCCURRENCE `migration_target_property_id` : la garde n'est
// pas ecrite sur place, elle lit depuis le PARAMETRE de `canauxActifsDuBien(prop)`.
// Les fleches SANS parentheses (`const garde = p => {`) comptent : 31
// occurrences dans api+lib+shared, et les manquer rendait le suivi aveugle.
function fonctionsDuFichier (src) {
  const table = new Map()
  const re = new RegExp(
    '(?:async\\s+)?function\\s+([A-Za-z_$][\\w$]*)\\s*\\(([^)]*)\\)\\s*\\{' +
    '|(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:async\\s*)?\\(([^)]*)\\)\\s*=>\\s*\\{' +
    '|(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:async\\s+)?([A-Za-z_$][\\w$]*)\\s*=>\\s*\\{', 'g')
  let m
  while ((m = re.exec(src)) !== null) {
    const nom = m[1] || m[3] || m[5]
    const brut = m[2] !== undefined ? m[2] : (m[4] !== undefined ? m[4] : m[6])
    const params = String(brut).split(',').map(x => x.trim().split('=')[0].trim())
    const i = src.indexOf('{', m.index + m[0].length - 1)
    if (i === -1) continue
    let n = 0
    let j = i
    for (; j < src.length; j++) {
      if (src[j] === '{') n++
      else if (src[j] === '}') { n--; if (n === 0) break }
    }
    table.set(nom, { params, corps: src.slice(i, j + 1) })
  }
  return table
}

// Les colonnes lues sur `v` A TRAVERS une fonction appelee avec `v`.
// ⚠ RESSERRE SUR CE QUI EST REELLEMENT INTERDIT (REVIEW.md regle 20,
// condition 1) : la classe est « une GARDE qui juge », pas « une lecture ». On
// ne retient donc, dans le corps de l'auxiliaire, que les lectures qui
// alimentent une COMPARAISON ou un REFUS. Sans ce resserrage, un utilitaire de
// normalisation qui lit `p.photo_url` en repli rendait un constat sur du code
// juste — et un garde-fou qui rougit sur du code correct pousse a deformer ce
// code pour le faire taire.
function colonnesViaAuxiliaires (zone, v, fonctions) {
  const trouvees = new Set()
  for (const [nom, f] of fonctions) {
    const iAppel = zone.indexOf(nom + '(')
    if (iAppel === -1) continue
    const arg = argumentApparie(zone, zone.indexOf('(', iAppel))
    if (!arg) continue
    const args = decoupeArguments(arg.texte)
    const rang = args.findIndex(x => x.trim() === v)
    if (rang === -1) continue
    const p = f.params[rang]
    if (!p || !/^[A-Za-z_$][\w$]*$/.test(p)) continue
    for (const x of f.corps.matchAll(new RegExp('\\b' + p + '\\??\\.([A-Za-z_][\\w]*)', 'g'))) {
      if (jugeDessus(f.corps, x.index, p, x[1])) trouvees.add(x[1])
    }
  }
  return trouvees
}

function decoupeArguments (texte) {
  const out = []
  let prof = 0
  let courant = ''
  let i = 0
  while (i < texte.length) {
    const c = texte[i]
    if (c === "'" || c === '"' || c === '`') {
      const fin = finDeChaine(texte, i, c)
      courant += texte.slice(i, fin)
      i = fin
      continue
    }
    if (c === '(' || c === '[' || c === '{') prof++
    if (c === ')' || c === ']' || c === '}') prof--
    if (c === ',' && prof === 0) { out.push(courant); courant = ''; i++; continue }
    courant += c
    i++
  }
  out.push(courant)
  return out
}

// La lecture sert-elle a juger ? On lit la ligne qui la porte.
function jugeDessus (corps, index, v, col) {
  const debut = corps.lastIndexOf('\n', index) + 1
  let fin = corps.indexOf('\n', index)
  if (fin === -1) fin = corps.length
  const ligne = corps.slice(debut, fin)
  // \u26a0 LE `\\b` NE S'APPLIQUE QU'AUX MOTS. Mis devant `&&` ou `===`, il ne
  // matche jamais : une limite de mot se tient entre un caractere de mot et un
  // autre, et il n'y en a pas avant `&`. Mesure du 22 octobre 2026 : la ligne
  // `const cle = prop && (prop.migration_target_property_id)` n'etait pas
  // reconnue comme un jugement, et la mutation de cette colonne survivait.
  const mots = /\b(if|return|throw|assert|res\.status)\b/.test(ligne)
  const operateurs = /(&&|\|\||\?|===|!==|==|!=|<|>|!)/.test(ligne)
  return mots || operateurs
}

function analyser ({ racine, dossiers = ['api', 'lib'] }) {
  const constats = []
  const ignorees = {
    collection: 0, forme_non_resolue: 0, etoile_ou_imbrique: 0,
    sans_select: 0, sans_variable: 0
  }
  let examines = 0
  let ancres = 0
  const fichiersVus = new Set()

  for (const f of fichiersJs(racine, dossiers)) {
    const src = sansCommentaires(fs.readFileSync(f, 'utf8'))
    const constantes = constantesDeColonnes(src)
    const fonctions = fonctionsDuFichier(src)
    const rel = path.relative(racine, f)
    const lectures = []

    // ⚠ L'ANCRE : une lecture d'UNE ligne. Chaque ancre tombe dans exactement
    // un compteur, et le test verifie l'egalite.
    for (const a of src.matchAll(/\.(?:maybeSingle|single)\(\)/g)) {
      ancres++
      const amont = src.slice(Math.max(0, a.index - 900), a.index)
      const iSel = amont.lastIndexOf('.select(')
      if (iSel === -1) { ignorees.sans_select++; continue }
      const absolu = Math.max(0, a.index - 900) + iSel
      const arg = argumentApparie(src, absolu + '.select'.length)
      if (!arg) { ignorees.forme_non_resolue++; continue }

      const liste = resoudreListe(arg.texte, constantes)
      if (!liste) { ignorees.forme_non_resolue++; continue }
      if (liste.etoile) { ignorees.etoile_ou_imbrique++; continue }

      const avant = src.slice(Math.max(0, absolu - 1500), absolu)
      const noms = [
        ...[...avant.matchAll(/data\s*:\s*([A-Za-z_$][\w$]*)/g)].map(x => ({ index: x.index, nom: x[1] })),
        ...[...avant.matchAll(/\{\s*data\s*[,}]/g)].map(x => ({ index: x.index, nom: 'data' }))
      ].sort((x, y) => x.index - y.index)
      if (!noms.length) { ignorees.sans_variable++; continue }
      const dernier = noms[noms.length - 1]
      if (avant.slice(dernier.index).includes('.select(')) { ignorees.sans_variable++; continue }

      examines++
      fichiersVus.add(rel)
      lectures.push({ v: dernier.nom, cols: liste.cols, index: absolu })
    }

    for (const courante of lectures) {
      const v = courante.v
      const connues = colonnesConnues(lectures, courante)
      const apres = src.slice(courante.index)
      const bornes = []
      for (const motif of [
        new RegExp('data\\s*:\\s*' + v + '\\b'),
        new RegExp('(?:const|let|var)\\s*\\{[^}]*\\b' + v + '\\b[^}]*\\}\\s*='),
        // ⚠ UNE DECLARATION DE PARAMETRE, PAS UN APPEL : `\(\s*v\s*[,)]`
        // matchait aussi `canauxActifsDuBien(prop)` et coupait la fenetre juste
        // AVANT la garde qu'on veut voir.
        new RegExp('(' + v + '\\s*=>|\\(\\s*' + v + '\\s*\\)\\s*=>|' +
          '(?:const|let|var)\\s+' + v + '\\s*=[^=]|function[^(]*\\(\\s*' + v + '\\s*[,)])'),
        /\n(?:async )?function |\nmodule\.exports/
      ]) {
        const k = apres.slice(1).search(motif)
        if (k !== -1) bornes.push(k + 1)
      }
      const zone = apres.slice(0, bornes.length ? Math.min(...bornes) : apres.length)

      const lues = new Set([...zone.matchAll(new RegExp('\\b' + v + '\\??\\.([A-Za-z_][\\w]*)', 'g'))]
        .map(x => x[1]))
      // La destructuration est une lecture : `const { prix_minimum } = prop`.
      for (const d of zone.matchAll(new RegExp('\\{([^}]*)\\}\\s*=\\s*' + v + '\\b', 'g'))) {
        for (const c of d[1].split(',')) {
          const n = c.trim().split(':')[0].trim()
          if (/^[A-Za-z_][\w]*$/.test(n)) lues.add(n)
        }
      }
      // Et un ALIAS en est une aussi : `const bien = prop` puis `bien.x`.
      for (const al of zone.matchAll(new RegExp('(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*' + v + '\\s*$', 'gm'))) {
        for (const x of zone.matchAll(new RegExp('\\b' + al[1] + '\\??\\.([A-Za-z_][\\w]*)', 'g'))) lues.add(x[1])
      }
      for (const c of colonnesViaAuxiliaires(zone, v, fonctions)) lues.add(c)

      for (const col of lues) {
        if (NON_COLONNES.has(col) || connues.has(col)) continue
        constats.push({ fichier: rel, variable: v, colonne: col, selectionnees: [...connues] })
      }
    }

    // Les lectures de COLLECTION : hors de portee, mais CHIFFREES. C'est la
    // plus grande surface non couverte, et un chiffre empeche « 282 lectures »
    // de se lire comme « le depot est couvert ».
    for (const s of src.matchAll(/\.select\(/g)) {
      const arg = argumentApparie(src, s.index + '.select'.length)
      if (!arg || !arg.texte.trim()) continue
      const suite = src.slice(arg.fin, arg.fin + 400)
      if (!/\.(?:maybeSingle|single)\(\)/.test(suite)) ignorees.collection++
    }
  }
  return { examines, ancres, constats, ignorees, fichiers: [...fichiersVus].sort() }
}

// ⚠ L'UNION EST DE PROXIMITE, PAS DE FICHIER. Un repli est COLLE a sa lecture
// principale (api/sms.js : six lignes, quatre colonnes puis deux si la
// migration du 17 septembre 2026 n'est pas passee — lectures en `?.` avec
// `|| null`, vide etant un defaut propre). Deux requetes qui remplissent `prop`
// a mille caracteres d'ecart sont deux lectures distinctes : les unir faisait
// SURVIVRE deux mutations.
const PROXIMITE = 600

function colonnesConnues (lectures, courante) {
  const connues = new Set(courante.cols)
  for (const autre of lectures) {
    if (autre === courante || autre.v !== courante.v) continue
    if (Math.abs(autre.index - courante.index) <= PROXIMITE) {
      for (const c of autre.cols) connues.add(c)
    }
  }
  return connues
}

module.exports = {
  analyser, sansCommentaires, clesDuSelect, fonctionsDuFichier, resoudreListe,
  colonnesViaAuxiliaires
}
