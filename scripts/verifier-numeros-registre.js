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
// ⚠ UN VERIFICATEUR QUI N'A RIEN LU DOIT ECHOUER : zero entree lue est un
// echec, pas un succes. Un registre qui aurait change de forme rendrait sinon
// un vert qui ne mesure rien.

const fs = require('node:fs')
const path = require('node:path')

const PAR_DEFAUT = path.join('docs', 'kb', 'dettes-v1.md')

// ⚠ LA PREMIERE CELLULE SEULEMENT. Le corps d'une entree contient des `|`
// (tableaux imbriques, `\|\|` echappes) : on ne decoupe donc pas la ligne
// entiere, on lit ce qui est entre le premier et le second `|`.
// L'en-tete (`| # | Dette | …`) et le separateur (`|---|---|`) ne passent pas :
// leur premiere cellule n'est pas un nombre.
function entreesDuRegistre (texte) {
  const entrees = []
  String(texte).split('\n').forEach((ligne, i) => {
    if (ligne[0] !== '|') return
    const fin = ligne.indexOf('|', 1)
    if (fin === -1) return
    const cellule = ligne.slice(1, fin).trim()
    if (!/^[0-9]+$/.test(cellule)) return
    entrees.push({ numero: Number(cellule), ligne: i + 1 })
  })
  return entrees
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
// ouvre le registre. C'est `max + 1`, et PAS `nombre d'entrees + 1` — un numero
// retire laisserait un trou, et reutiliser un numero mort ferait pointer deux
// decisions vers la meme ligne de journal.
function prochainLibre (texte) {
  const n = entreesDuRegistre(texte).map(e => e.numero)
  return n.length ? Math.max(...n) + 1 : 1
}

module.exports = { entreesDuRegistre, doublons, prochainLibre, PAR_DEFAUT }

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
    const d = doublons(texte)
    if (d.length) {
      for (const { numero, lignes } of d) {
        console.error(`  ECHEC numero ${numero} present ${lignes.length} fois, lignes ${lignes.join(' et ')}`)
      }
      echecs++
    } else {
      console.log('  ok    aucun numero en double')
    }
    console.log(`  prochain numero libre : ${prochainLibre(texte)}`)
  }
  process.exit(echecs ? 1 : 0)
}
