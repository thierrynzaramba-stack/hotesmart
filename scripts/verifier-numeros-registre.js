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
//   3. aucune entree lue du tout — un verificateur qui n'a rien lu doit
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
function prochainLibre (texte) {
  const n = entreesDuRegistre(texte).map(e => e.numero)
  return n.length ? Math.max(...n) + 1 : 1
}

module.exports = { entreesDuRegistre, lignesNonComptees, doublons, prochainLibre, PAR_DEFAUT }

if (require.main === module) {
  const cibles = process.argv.slice(2)
  const fichiers = cibles.length ? cibles : [PAR_DEFAUT]
  let echecs = 0
  for (const f of fichiers) {
    let texte
    try { texte = fs.readFileSync(f, 'utf8') } catch (e) {
      console.error(`ECHEC ${f} : illisible (${e.code})`); echecs++; continue
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
    if (propre) console.log('  ok    aucun numero en double, et toutes les rangees sont comptees')
    else echecs++
    console.log(`  prochain numero libre : ${prochainLibre(texte)}`)
  }
  process.exit(echecs ? 1 : 0)
}
