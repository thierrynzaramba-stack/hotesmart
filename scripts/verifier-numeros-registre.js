#!/usr/bin/env node
// scripts/verifier-numeros-registre.js — DEUX DETTES NE PORTENT JAMAIS LE MEME
// NUMERO, et le prochain numero libre se CALCULE au lieu de se chercher a l'oeil.
//
// Usage : node scripts/verifier-numeros-registre.js
//         node scripts/verifier-numeros-registre.js docs/kb/dettes-v1.md
//
// LECTURE SEULE. Il lit un fichier de registre et compte sa premiere colonne.
//
// ⚠ POURQUOI CE VERIFICATEUR EXISTE — VECU LE 23 OCTOBRE 2026. Deux sessions
// ont inscrit la MEME dette (les cles locales qui survivent a la deconnexion)
// dans `docs/kb/dettes-v1.md`, chacune au prochain numero libre qu'elle voyait :
// 84 des deux cotes. Aucune des deux n'avait tort — la regle du registre dit
// bien de prendre le prochain libre, et il l'etait pour chacune separement.
//
// ⚠ ET LE MERGE N'A RIEN DIT. Les deux additions n'etaient pas au meme endroit
// du fichier, donc git a annonce « Auto-merging » et a REUSSI, en laissant deux
// entrees 84 dans le registre. C'est la regle 9 de CLAUDE.md — « quatre fichiers
// n'etaient PAS en conflit, donc git a pris la version de la branche sans un
// mot » — en version DOCUMENT. C'est le controle d'apres-coup du chef de file
// qui l'a vu, pas le merge.
//
// ⚠ POURQUOI C'EST PIRE SUR UN REGISTRE NUMEROTE QUE SUR DU CODE. Un doublon de
// code se voit a l'execution. Ici, le defaut est SILENCIEUX et il se propage :
// la session suivante cherche « le prochain numero libre », lit 84, le trouve
// pris DEUX FOIS, et ne sait plus lequel elle doit incrementer. Chaque dette
// ecrite ensuite herite du doute, et une dette qu'on ne sait pas nommer est une
// dette qu'on ne retrouve pas.
//
// ⚠ TROIS SORTES D'ECHEC, ET LA DEUXIEME EST CELLE QUI A MANQUE A MA PREMIERE
// VERSION (constats GRAVE 1 et MOYEN 1 de la revue du 24 octobre 2026) :
//   1. un numero present deux fois ;
//   2. une RANGEE DU TABLEAU QUE LE COMPTAGE N'A PAS RECONNUE — mesure de la
//      revue : ` | 84 | …` avec UNE espace d'indentation (licite en Markdown),
//      `| **84** | …`, `| ~~84~~ | …`, `| 84 bis | …` passaient tous
//      inapercus, et le script imprimait « ok aucun numero en double » sur un
//      registre qui en portait deux. Huit formes sur douze essayees. La forme
//      barree est la plus credible : la regle du registre dit qu'une dette
//      soldee SE BARRE. Un controle de non-vacuite ne suffit donc pas — il faut
//      un controle de COUVERTURE, qui refuse toute ligne de forme tableau non
//      comptee, en la nommant ;
//   3. une SUITE QUI DESCEND — une entree rangee au mauvais endroit, sans
//      doublon, donc invisible aux deux controles precedents (cas reel du
//      24 octobre, detaille plus bas) ;
//   4. aucune entree lue du tout — un verificateur qui n'a rien lu doit
//      ECHOUER, sinon il rend un vert qui ne mesure rien.
//
// ⚠ ET LE CONTROLE EST BORNE AU TABLEAU DU REGISTRE, pas au fichier entier
// (constat MOYEN 1). Un bloc de code clos par ``` ou une annexe avec son propre
// tableau faisaient crier la garde sur de faux doublons — et un exemple de
// forme recopie en prose sous « Regle du registre » suffisait. Une alarme qui
// se trompe est une alarme qu'on apprend a ignorer, ce que CLAUDE.md repete.

const fs = require('node:fs')
const path = require('node:path')

const PAR_DEFAUT = path.join('docs', 'kb', 'dettes-v1.md')

// Une ligne de FORME tableau : jusqu'a trois espaces d'indentation, puis `|`.
// Trois, parce que c'est la limite de Markdown avant qu'une ligne devienne un
// bloc de code indente.
const FORME_TABLEAU = /^ {0,3}\|/
// Le separateur : `|---|---|`, avec ou sans deux-points d'alignement.
const SEPARATEUR = /^ {0,3}\|[\s:|-]+\|\s*$/

// ⚠ LES MARQUEURS D'UN MERGE NON RESOLU. Mesure du 26 octobre 2026 : cette
// garde rendait « ok », code 0, sur un registre qui portait trois marqueurs de
// conflit — parce que les deux cotes y avaient mis des numeros DIFFERENTS et
// CROISSANTS (101 d'un cote, 102 de l'autre). Ni doublon, ni descente : rien a
// signaler pour elle, et le fichier serait parti en production avec
// `<<<<<<< HEAD` dedans. Les deux premieres tentatives de mesure ont ete
// rattrapees par HASARD — un doublon fortuit — ce qui est precisement la facon
// dont on croit une garde solide.
// `=======` seul est ambigu (un soulignement de titre Markdown a la meme
// forme) : on ne le compte QUE s'il est encadre par les deux autres.
const CONFLIT_DEBUT = /^<{7}(\s|$)/
const CONFLIT_FIN = /^>{7}(\s|$)/
const CONFLIT_MILIEU = /^={7}\s*$/

// ⚠ LE COMPTE DE COLONNES, ET MARKDOWN NE COMPTE PAS COMME UN `split('|')`.
// Un `|` precede d'une barre inverse est du TEXTE, pas un separateur, et le
// pipe FINAL est optionnel. J'ai signale l'entree 36 comme mal formee avant
// d'ecrire ceci : faux, son texte porte `\|\|` — deux pipes echappes dans
// `liste.json?.data \|\| []` — et c'est mon `awk -F'|'` qui les comptait.
// Une garde qui se trompe dans ce sens-la fait reparer ce qui va bien.
function cellulesDe (ligneTexte) {
  const l = String(ligneTexte).trim()
  if (!l.startsWith('|')) return 0
  // Les positions des `|` NON echappes.
  const pos = []
  for (let i = 0; i < l.length; i++) {
    if (l[i] === '|' && (i === 0 || l[i - 1] !== '\\')) pos.push(i)
  }
  if (!pos.length) return 0
  // Le premier ouvre la ligne ; le dernier la ferme SI la ligne finit par lui.
  const ferme = pos[pos.length - 1] === l.length - 1 && pos.length > 1
  return pos.length - (ferme ? 1 : 0)
}

// Le tableau du registre va de son EN-TETE a la premiere section suivante. Les
// lignes vides ne l'interrompent pas : le registre en contient huit, son tableau
// est en morceaux, et s'arreter a la premiere ligne vide perdrait la moitie des
// entrees. Hors de ces bornes, on ne compte ni ne juge rien.
// Si l'en-tete n'est pas trouve (autre fichier, autre forme), on prend le
// fichier entier : mieux vaut un controle large qu'un controle muet.
function bornesDuRegistre (lignes) {
  const debut = lignes.findIndex(l => FORME_TABLEAU.test(l) && /^\s*\|\s*#\s*\|/.test(l))
  if (debut === -1) return { debut: 0, fin: lignes.length }
  let fin = lignes.length
  for (let i = debut + 1; i < lignes.length; i++) {
    if (/^##\s/.test(lignes[i])) { fin = i; break }
  }
  return { debut, fin }
}

// Les lignes du tableau du registre, les blocs de code retires. Rendue brute
// (numero de ligne 1-indexe + texte) : c'est sur elle que travaillent le
// comptage ET le controle de couverture, donc ils ne peuvent pas diverger.
function lignesDuTableau (texte) {
  const lignes = String(texte).split('\n')
  const { debut, fin } = bornesDuRegistre(lignes)
  const retenues = []
  let dansUnBloc = false
  for (let i = debut; i < fin; i++) {
    if (/^\s*(```|~~~)/.test(lignes[i])) { dansUnBloc = !dansUnBloc; continue }
    if (dansUnBloc) continue
    if (FORME_TABLEAU.test(lignes[i])) retenues.push({ ligne: i + 1, texte: lignes[i] })
  }
  return retenues
}

// La premiere cellule, et elle seule. Un numero nu — ni gras, ni barre, ni
// « 84 bis » : le registre se tient a une forme, et toute autre est signalee
// par le controle de couverture plutot qu'ignoree.
function numeroDe (ligneTexte) {
  const sansIndentation = ligneTexte.replace(/^\s+/, '')
  const fin = sansIndentation.indexOf('|', 1)
  if (fin === -1) return null
  const cellule = sansIndentation.slice(1, fin).trim()
  return /^[0-9]+$/.test(cellule) ? Number(cellule) : null
}

function entreesDuRegistre (texte) {
  return lignesDuTableau(texte)
    .map(l => ({ numero: numeroDe(l.texte), ligne: l.ligne }))
    .filter(e => e.numero !== null)
}

// Le controle de COUVERTURE : toute ligne de forme tableau est soit l'en-tete,
// soit le separateur, soit une entree numerotee. Le reste est nomme.
function lignesNonComptees (texte) {
  return lignesDuTableau(texte)
    .filter(l => numeroDe(l.texte) === null)
    .filter(l => !SEPARATEUR.test(l.texte))
    .filter(l => !/^\s*\|\s*#\s*\|/.test(l.texte))
    .map(l => ({ ligne: l.ligne, apercu: l.texte.trim().slice(0, 60) }))
}

// ⚠ L'ORDRE, ET LA TROISIEME FORME DU MEME PHENOMENE (cas reel du 24 octobre
// 2026, merge de `dette-90-refus-avant-garde`). Git se tait quand les deux
// cotes touchent des regions DISJOINTES, et parle quand elles se chevauchent.
// Trois occurrences dans la meme journee : la dette 84 ecrite deux fois a des
// endroits differents (DUPLICATION, muette), la dette 78 ou les deux cotes
// ajoutaient en fin de table (CONFLIT FRANC, donc signale), et la dette 90
// RANGEE ENTRE LA 83 ET LA 84 — parce que sa branche partait d'un `main` dont
// le registre s'arretait a 83, et que `staging` portait deja 84 a 89 au meme
// endroit. Muette aussi.
//
// ⚠ ET CE TROISIEME CAS NE PRODUIT AUCUN DOUBLON : 1 a 90, chacun une fois.
// La detection de doublons sort 0 a juste titre sur un registre dont une entree
// est au mauvais endroit. Or l'ordre est ce qui fait qu'un registre se lit, et
// « le prochain numero libre » se deduit de la fin de table.
//
// ⚠ UN TROU N'EST PAS UNE RUPTURE. Le registre saute de 38 a 40 — la dette 39
// ne vit que sur une branche non mergee — et c'est legitime : on ne reutilise
// jamais un numero mort. Ce qui est refuse, c'est une suite qui DESCEND.
function ruptures (texte) {
  const e = entreesDuRegistre(texte)
  const r = []
  for (let i = 1; i < e.length; i++) {
    if (e[i].numero <= e[i - 1].numero) r.push({ precedent: e[i - 1], suivant: e[i] })
  }
  return r
}

// Rend un tableau — vide quand tout va bien. Chaque element porte le numero
// fautif ET les lignes ou il apparait : sans les lignes, le message oblige a
// rechercher a la main ce que le verificateur vient de trouver.
function doublons (texte) {
  const par = new Map()
  for (const e of entreesDuRegistre(texte)) {
    if (!par.has(e.numero)) par.set(e.numero, [])
    par.get(e.numero).push(e.ligne)
  }
  return [...par.entries()]
    .filter(([, lignes]) => lignes.length > 1)
    .map(([numero, lignes]) => ({ numero, lignes }))
    .sort((a, b) => a.numero - b.numero)
}

// Le prochain numero libre : la question que se pose reellement une session qui
// ouvre le registre. C'est `max + 1`, et PAS `nombre d'entrees + 1` — le
// registre a un vrai trou (la dette 39 ne vit que sur une branche non mergee),
// et reutiliser un numero mort ferait pointer deux decisions vers la meme ligne
// de journal.
// Les marqueurs d'un merge non resolu, n'importe ou dans le fichier — pas
// seulement dans les bornes du tableau : un marqueur dans la prose est tout
// aussi faux, et il n'y a aucune raison de ne le refuser qu'a un endroit.
function marqueursDeConflit (texte) {
  const lignes = String(texte).split('\n')
  const trouves = []
  let ouvert = false
  for (let i = 0; i < lignes.length; i++) {
    const l = lignes[i]
    if (CONFLIT_DEBUT.test(l)) { ouvert = true; trouves.push({ ligne: i + 1, texte: l.slice(0, 40) }); continue }
    if (CONFLIT_FIN.test(l)) { ouvert = false; trouves.push({ ligne: i + 1, texte: l.slice(0, 40) }); continue }
    if (ouvert && CONFLIT_MILIEU.test(l)) trouves.push({ ligne: i + 1, texte: l.slice(0, 40) })
  }
  return trouves
}

// ⚠ LE NOMBRE DE COLONNES EST DERIVE DE L'EN-TETE, PAS ECRIT ICI. Une valeur
// recopiee serait une seconde source de verite sur la forme du tableau, et
// c'est la classe de defaut que ce fichier existe pour attraper.
function colonnesAttendues (texte) {
  for (const l of String(texte).split('\n')) {
    if (/^\s*\|\s*#\s*\|/.test(l)) return cellulesDe(l)
  }
  return null
}

// Une entree dont le compte de cellules differe de l'en-tete : Markdown rend
// alors les cellules en trop HORS du tableau, ou laisse les manquantes vides.
// Le contenu n'est pas perdu, il est DEPLACE — invisible a l'oeil sur une ligne
// de 1 500 caracteres, et invisible aux trois autres controles, qui comptent
// les entrees et pas les colonnes.
function colonnesHorsNorme (texte) {
  const attendu = colonnesAttendues(texte)
  if (!attendu) return []
  return lignesDuTableau(texte)
    .filter(l => numeroDe(l.texte) !== null)
    .map(l => ({ ligne: l.ligne, numero: numeroDe(l.texte), cellules: cellulesDe(l.texte) }))
    .filter(e => e.cellules !== attendu)
}

function prochainLibre (texte) {
  const n = entreesDuRegistre(texte).map(e => e.numero)
  return n.length ? Math.max(...n) + 1 : 1
}

module.exports = { entreesDuRegistre, lignesNonComptees, ruptures, doublons, prochainLibre,
  marqueursDeConflit, colonnesHorsNorme, colonnesAttendues, cellulesDe, PAR_DEFAUT }

if (require.main === module) {
  const cibles = process.argv.slice(2)
  const fichiers = cibles.length ? cibles : [PAR_DEFAUT]
  let echecs = 0
  for (const f of fichiers) {
    let texte
    try { texte = fs.readFileSync(f, 'utf8') } catch (e) {
      console.error(`ECHEC ${f} : illisible (${e.code})`); echecs++; continue
    }
    // ⚠ LE CONFLIT PASSE AVANT TOUT LE RESTE, et il ARRETE. Sur un fichier non
    // resolu, les trois autres controles mesurent un texte qui n'existe pas :
    // ils comptent les entrees des DEUX cotes, et leur verdict — « 95 entrees,
    // suite croissante » — est une phrase vraie sur un fichier faux.
    const conflits = marqueursDeConflit(texte)
    if (conflits.length) {
      console.log(`${f}`)
      for (const { ligne, texte: t } of conflits) {
        console.error(`  ECHEC ligne ${ligne} : marqueur de merge non resolu — ${t}`)
      }
      console.error('  (ce fichier porte les DEUX cotes d un merge : les autres controles ne sont')
      console.error('   pas lances, ils mesureraient un texte qui n existe pas)')
      echecs++
      continue
    }
    const entrees = entreesDuRegistre(texte)
    console.log(`${f} — ${entrees.length} entree(s)`)
    if (!entrees.length) {
      console.error('  ECHEC aucune entree lue : le registre a change de forme, ou ce fichier n en est pas un')
      echecs++
      continue
    }
    let propre = true
    const d = doublons(texte)
    if (d.length) {
      propre = false
      for (const { numero, lignes } of d) {
        console.error(`  ECHEC numero ${numero} present ${lignes.length} fois, lignes ${lignes.join(' et ')}`)
      }
    }
    const perdues = lignesNonComptees(texte)
    if (perdues.length) {
      propre = false
      for (const { ligne, apercu } of perdues) {
        console.error(`  ECHEC ligne ${ligne} a la forme d une entree mais son numero n est pas lisible : ${apercu}`)
      }
      console.error('  (un numero gras, barre, indente ou suivi de « bis » n est PAS compte : il passerait en double sans un mot)')
    }
    const colonnes = colonnesHorsNorme(texte)
    if (colonnes.length) {
      propre = false
      const attendu = colonnesAttendues(texte)
      for (const { ligne, numero, cellules } of colonnes) {
        console.error(`  ECHEC entree ${numero} (ligne ${ligne}) : ${cellules} cellule(s) au lieu de ${attendu}`)
      }
      console.error('  (le contenu n est pas perdu, il est DEPLACE : une cellule en trop sort du')
      console.error('   tableau, une cellule manquante en laisse une vide. Un `|` de texte s echappe')
      console.error('   en `\\|` ; le pipe final est optionnel, mais le COMPTE, non)')
    }
    const desordre = ruptures(texte)
    if (desordre.length) {
      propre = false
      for (const { precedent, suivant } of desordre) {
        console.error(`  ECHEC la suite descend : ${precedent.numero} (ligne ${precedent.ligne})`
          + ` puis ${suivant.numero} (ligne ${suivant.ligne})`)
      }
      console.error('  (un TROU est normal — on ne reutilise jamais un numero mort ; une entree rangee au mauvais endroit, non)')
    }
    if (propre) console.log(`  ok    aucun doublon, aucune rangee perdue, suite croissante, ${colonnesAttendues(texte)} colonnes partout, aucun marqueur de conflit`)
    else echecs++
    console.log(`  prochain numero libre : ${prochainLibre(texte)}`)
  }
  process.exit(echecs ? 1 : 0)
}
