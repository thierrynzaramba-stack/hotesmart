// tests/postgrest-ordre-de-chaine.test.js — L'ORDRE DE LA CHAINE SUPABASE
//
// ⚠ POURQUOI CE TEST EXISTE, ET IL VIENT D'UN DEFAUT REEL. Le 27 octobre 2026,
// `lib/cron-revenus-derives.js` portait
// `sb.from('bookings_snapshot').limit(PAGE).select(...)`. C'etait pour
// rapprocher la borne de lecture de son `from()` — ce que le recensement des
// lectures non bornees exige, a juste titre.
//
// Le vrai client PostgREST n'expose `.limit()`, `.eq()`, `.order()` et les
// autres QUE sur le constructeur rendu par `.select()` / `.insert()` /
// `.update()` / `.upsert()` / `.delete()`. Il leve donc
// « sb.from(...).limit is not a function ». Le rattrapage de 04:00 aurait
// plante A CHAQUE PASSAGE en production.
//
// ⚠ ET LA SUITE ETAIT ENTIEREMENT VERTE, parce que le double de test exposait
// TOUT des le `from()`. Un double plus permissif que la chose qu'il double ne
// protege de rien : il VALIDE du code qui ne peut pas tourner. Aucune mutation
// ne pouvait le trouver — une mutation se mesure avec le meme double. Seule
// l'execution reelle sur staging l'a montre.
//
// D'ou ce test, qui lit le CODE et pas un double : il attrape la forme au
// commit, sans attendre qu'une tache de nuit tombe en production.
// (Suggere par la session chef de file, qui a d'abord mesure que ce defaut
// etait le SEUL du depot.)

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { sansCommentaires, fichiersJs } = require('./outils/source')

const racine = path.join(__dirname, '..')

// Ce que `from()` rend, et c'est tout : le constructeur de requete n'existe
// qu'apres l'un de ces six.
const OUVREURS = new Set(['select', 'insert', 'update', 'upsert', 'delete', 'rpc'])

// Les modificateurs PostgREST, qui n'existent QU'APRES un ouvreur.
const MODIFICATEURS = new Set([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
  'containedBy', 'not', 'or', 'and', 'filter', 'match',
  'order', 'limit', 'range', 'single', 'maybeSingle', 'csv', 'abortSignal',
  'returns', 'throwOnError', 'overrideTypes'
])

// ⚠ TOUS LES `.from(` NE SONT PAS DES TABLES. `Array.from(x).map()`,
// `Buffer.from(s).toString()` et `storage.from(bucket).upload()` sont
// legitimes et n'ont rien a voir avec PostgREST. Un recensement qui ne les
// distingue pas rend un chiffre faux — et le faux positif coute plus cher que
// le silence : un garde-fou qui crie a tort se fait desactiver.
const HOMONYMES = /(Array|Buffer|Object|Map|Set|Date|Number|String|storage|Storage)\s*$/

// ⚠ LES LITTERAUX DE CHAINE SONT NEUTRALISES, ET C'EST CE FICHIER QUI L'A
// EXIGE : ses propres temoins portent la forme fautive dans des gabarits, donc
// le recensement se denoncait lui-meme. L'exempter en entier aurait ete le
// mauvais geste — ce depot a deja mesure qu'une exemption par FICHIER rend
// invisible tout ce qu'on y ajoutera ensuite. On neutralise donc la CLASSE :
// du code dans une chaine n'est pas du code execute, et une vraie requete
// PostgREST ne vit jamais dans un gabarit.
function sansLitteraux (src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      const ouvre = c
      let j = i + 1
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === ouvre) break
        j++
      }
      // On garde les sauts de ligne, pour que les positions restent lisibles.
      out += ouvre + src.slice(i + 1, j).replace(/[^\n]/g, ' ') + ouvre
      i = j + 1
      continue
    }
    out += c
    i++
  }
  return out
}

const codeSeul = (src) => sansLitteraux(sansCommentaires(src))

// Du `.from(` jusqu'a la fin de son expression : on suit les appels chaines.
function chaines (src) {
  const out = []
  let i = src.indexOf('.from(')
  while (i !== -1) {
    const avant = src.slice(Math.max(0, i - 24), i)
    if (HOMONYMES.test(avant)) { i = src.indexOf('.from(', i + 1); continue }
    // On avance jusqu'a la parenthese fermante du `from(...)`.
    let p = 0
    let j = i + 5
    for (; j < src.length; j++) {
      if (src[j] === '(') p++
      else if (src[j] === ')') { p--; if (p === 0) break }
    }
    // Puis on lit les maillons suivants, tant que la chaine continue.
    const maillons = []
    let k = j + 1
    while (k < src.length) {
      const reste = src.slice(k)
      const m = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(reste)
      if (!m) break
      maillons.push(m[1])
      let q = 0
      let z = k + m[0].length - 1
      for (; z < src.length; z++) {
        if (src[z] === '(') q++
        else if (src[z] === ')') { q--; if (q === 0) break }
      }
      k = z + 1
      // Un ouvreur rencontre : le reste de la chaine est legitime.
      if (OUVREURS.has(m[1])) break
    }
    out.push({ position: i, maillons })
    i = src.indexOf('.from(', i + 1)
  }
  return out
}

function constats (src) {
  const mauvais = []
  for (const c of chaines(src)) {
    for (const m of c.maillons) {
      if (OUVREURS.has(m)) break
      if (MODIFICATEURS.has(m)) { mauvais.push({ ...c, fautif: m }); break }
    }
  }
  return mauvais
}

function balayer () {
  const fichiers = []
  for (const d of ['api', 'lib', 'scripts', 'pages', 'apps', 'shared', 'tests']) {
    const abs = path.join(racine, d)
    if (fs.existsSync(abs)) fichiers.push(...fichiersJs(abs, d))
  }
  const trouves = []
  for (const f of fichiers) {
    const src = codeSeul(fs.readFileSync(path.join(racine, f), 'utf8'))
    for (const c of constats(src)) trouves.push(`${f} : .from(…).${c.fautif}(…) avant .select()`)
  }
  return { fichiers, trouves }
}

test("LE TEST QUI COMPTE : aucun modificateur PostgREST avant `.select()`", () => {
  const { fichiers, trouves } = balayer()
  // ⚠ UN RECENSEMENT QUI N'A RIEN LU DOIT ECHOUER. Zero fichier rend zero
  // constat, donc un vert — le faux vert le plus facile a fabriquer.
  assert.ok(fichiers.length > 50, `${fichiers.length} fichier(s) balaye(s) : le recensement n a rien lu`)
  assert.deepEqual(trouves, [],
    'un modificateur PostgREST est appele avant `.select()`. Le vrai client ne\n'
    + 'l expose QUE sur le constructeur rendu par select/insert/update/upsert/delete :\n'
    + 'ce code levera « .<methode> is not a function » a l execution, et un double\n'
    + 'de test permissif ne le dira jamais.\n' + trouves.join('\n'))
})

test("LE TEMOIN : le recensement attrape la forme fautive", () => {
  // ⚠ SANS CE TEMOIN, LE TEST CI-DESSUS EST UN VERT QUI NE MESURE RIEN. C'est
  // la demande explicite de la session chef de file, et elle a raison : un
  // recensement qui ne detecte jamais rien se confond avec un recensement
  // casse. On lui donne donc la forme EXACTE qui a plante sur staging.
  const fautif = `
    const q = sb.from('bookings_snapshot').limit(PAGE)
      .select('id, user_id')
  `
  assert.strictEqual(constats(codeSeul(fautif)).length, 1,
    'le recensement ne voit pas la forme qui a plante en vrai le 27 octobre 2026')

  // Et la forme JUSTE ne doit pas l'alarmer : un garde-fou qui crie a tort se
  // fait desactiver, ce qui est pire que son absence.
  const juste = `
    const q = sb.from('bookings_snapshot')
      .select('id, user_id')
      .limit(PAGE)
      .eq('user_id', u).order('id')
  `
  assert.deepEqual(constats(codeSeul(juste)), [],
    'la forme correcte est signalee : le recensement crie a tort')

  // ⚠ LES HOMONYMES NE SONT PAS DES TABLES, et les confondre fausse le compte
  // dans les deux sens. `storage.from(bucket).upload()` et `Array.from(x).map()`
  // existent pour de vrai dans ce depot.
  const autres = `
    await supabase.storage.from('property-photos').upload(chemin, f)
    const l = Array.from(xs).filter(Boolean)
    const b = Buffer.from(s, 'base64').toString('utf8')
  `
  assert.deepEqual(constats(codeSeul(autres)), [],
    'un `from` qui n est pas une table est compte comme une faute')

  // ⚠ ET UN COMMENTAIRE QUI CITE LA MAUVAISE FORME N'EST PAS UNE FAUTE. Le
  // fichier du correctif en porte un, mot pour mot — sans neutralisation, le
  // recensement se declencherait sur l explication du defaut qu il surveille.
  const commente = `
    // ma premiere version faisait sb.from('t').limit(10).select('id')
    const q = sb.from('t').select('id').limit(10)
  `
  assert.deepEqual(constats(codeSeul(commente)), [],
    'un commentaire citant la forme fautive est compte comme une faute')
})
