// tests/outils/source.js
//
// LIRE DU CODE SOURCE DANS UN TEST, SANS SE FAIRE PIEGER.
//
// ⚠ POURQUOI CE FICHIER EXISTE — TROIS PIEGES PAYES, DONT DEUX LE MEME JOUR.
//
// 1. DEPOUILLER LES COMMENTAIRES PAR REGEX NE MARCHE PAS SUR CE DEPOT.
//    Les deux passes habituelles — `/\*…\*/` puis `//…` — detruisent presque
//    tout `pages/aujourdhui.html` : mesure du 23 octobre 2026, il reste
//    1 endpoint sur 6 apres la premiere passe, ZERO apres la seconde. Un `/*`
//    de CSS, une apostrophe dans une regex, un `*/` dans une chaine, et le
//    depouilleur avale le fichier. Trois tests ont compte « zero » et sont
//    restes verts pour de bon.
//    Les commentaires de ce depot sont ENTIERS sur leur ligne : les ecarter
//    ligne par ligne suffit, et ne peut rien avaler.
//
// 2. COMPTER DES OCCURRENCES SANS LES ECARTER DONNE DE FAUX VERTS.
//    `assert.ok((html.match(/renderAlarmes\(\)/g) || []).length >= 2)` etait
//    satisfait par les DEUX mentions de `renderAlarmes()` dans le commentaire
//    qui expliquait le defaut. Le garde-fou du constat le plus grave d'une
//    review survivait a la suppression de l'appel reel.
//
// 3. UN PARCOURS DE REPERTOIRE A PLAT VIEILLIT MAL.
//    `api/ecran/` est le premier sous-repertoire de `api/`, et quatre
//    recensements balayaient a plat : 58 fichiers contre 59. Cinq parcours
//    recursifs ont alors ete recopies dans cinq fichiers le meme jour — une
//    sixieme copie aurait le meme angle mort que les cinq autres.

const fs = require('node:fs')
const path = require('node:path')

// Le code, sans les lignes ENTIEREMENT commentees. Voir le piege 1 : on ne
// touche PAS aux commentaires de fin de ligne ni aux blocs, parce qu'on ne
// peut pas les reconnaitre sans analyseur — et qu'essayer detruit le fichier.
function sansCommentaires (src) {
  return String(src).split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
}

// Le code, sans le CONTENU des litteraux de chaine : les guillemets restent,
// ce qu'ils entourent devient des espaces, et les sauts de ligne sont gardes
// pour que les numeros de ligne tiennent.
//
// ⚠ POURQUOI C'EST NECESSAIRE, ET MESURE DEUX FOIS LE 27 OCTOBRE 2026. Deux
// recensements ecrits ce jour-la se sont denonces eux-memes : leurs TEMOINS
// portent la forme fautive dans une chaine, et le balayage la comptait. Et
// `tests/price-log.test.js` a ete signale a tort, parce qu'il asserte qu'un
// AUTRE fichier contient un `require('./price-log')` — la chaine est la preuve,
// pas le defaut.
//
// Du code dans une chaine n'est pas du code execute. Exempter le FICHIER aurait
// ete le mauvais geste : ce depot a deja mesure qu'une exemption par fichier
// rend invisible tout ce qu'on y ajoutera ensuite.
function sansLitteraux (src) {
  let out = ''
  let i = 0
  const s = String(src)
  while (i < s.length) {
    const c = s[i]
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue }
        if (s[j] === c) break
        j++
      }
      out += c + s.slice(i + 1, j).replace(/[^\n]/g, ' ') + c
      i = j + 1
      continue
    }
    out += c
    i++
  }
  return out
}

// Le code NU : ni commentaires de ligne, ni contenu de chaine.
const codeNu = (src) => sansLitteraux(sansCommentaires(src))

// ⚠ IL Y A EU ICI UN `plagesDeChaines`, ET IL ETAIT FAUX. Il rendait les
// bornes des litteraux de chaine pour decider si une occurrence y etait
// imbriquee. Mesure du 27 octobre 2026 : un LITTERAL D'EXPRESSION REGULIERE
// contenant des guillemets — `/require\(['"]…/` — lui faisait ouvrir une
// chaine fantome, et TOUT ce qui suivait dans le fichier etait mal juge.
// Distinguer une expression reguliere d'une division demande un analyseur ;
// sans lui, l'outil repond avec aplomb sur un decoupage faux.
// `tests/require-se-resout.test.js` juge donc LIGNE PAR LIGNE, ou une
// desynchronisation ne peut pas se propager.

// Les occurrences d'un motif dans le CODE, jamais dans les commentaires.
function compterDansLeCode (src, motif) {
  const re = motif instanceof RegExp
    ? new RegExp(motif.source, motif.flags.includes('g') ? motif.flags : motif.flags + 'g')
    : new RegExp(String(motif).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
  return (sansCommentaires(src).match(re) || []).length
}

// Tous les `.js` d'un dossier, SOUS-REPERTOIRES COMPRIS, en chemins relatifs
// a `prefixe` et toujours separes par `/` (y compris sous Windows).
function fichiersJs (dossier, prefixe = null) {
  const out = []
  for (const e of fs.readdirSync(dossier, { withFileTypes: true })) {
    const abs = path.join(dossier, e.name)
    const rel = prefixe === null ? abs : `${prefixe}/${e.name}`
    if (e.isDirectory()) out.push(...fichiersJs(abs, prefixe === null ? null : rel))
    else if (e.name.endsWith('.js')) out.push(rel)
  }
  return out
}

module.exports = { sansCommentaires, sansLitteraux, codeNu, compterDansLeCode, fichiersJs }
