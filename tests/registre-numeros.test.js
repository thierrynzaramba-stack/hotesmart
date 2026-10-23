// tests/registre-numeros.test.js — DEUX DETTES NE PORTENT JAMAIS LE MEME NUMERO.
//
// ⚠ CE QUE CE TEST EXISTE POUR EMPECHER, et il est arrive (23 octobre 2026).
// Deux sessions ont inscrit la MEME dette dans `docs/kb/dettes-v1.md`, chacune
// au prochain numero libre qu'elle voyait : 84 des deux cotes. Le merge n'a
// RIEN dit — les deux additions n'etaient pas au meme endroit du fichier, donc
// git a annonce « Auto-merging » et a reussi, en laissant deux entrees 84.
// C'est la regle 9 de CLAUDE.md en version document, et c'est un controle
// d'apres-coup qui l'a vu, pas le merge.
//
// ⚠ IL APPELLE, IL NE LIT PAS UN MOTIF (regle 20 de REVIEW.md). La decision
// vit dans `scripts/verifier-numeros-registre.js`, que le chef de file peut
// lancer a la main avant un merge ; ce test appelle la MEME fonction. Une garde
// qui reimplementerait le comptage ici mesurerait son propre double.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const V = require('../scripts/verifier-numeros-registre.js')

const CHEMIN = path.join(__dirname, '..', 'docs', 'kb', 'dettes-v1.md')
const REGISTRE = fs.readFileSync(CHEMIN, 'utf8')

test('LE TEST QUI COMPTE : aucun numero en double dans le registre des dettes', () => {
  const d = V.doublons(REGISTRE)
  assert.deepEqual(d, [],
    'numero(s) en double : ' + d.map(x => `${x.numero} (lignes ${x.lignes.join(', ')})`).join(' ; ') +
    ' — une seule entree par numero, et la plus complete des deux gagne')
})

test('un verificateur qui n a rien lu doit ECHOUER, pas rendre vert', () => {
  // ⚠ LA MOITIE QU'ON OUBLIE. Si le registre change de forme — tableau
  // reecrit, colonne deplacee —, un comptage qui lit zero entree rendrait
  // « aucun doublon » : un vert qui ne mesure rien. Le seuil est volontairement
  // bas (il y avait 84 entrees le 23 octobre 2026) : il ne surveille pas la
  // croissance du registre, il refuse une lecture vide ou amputee.
  assert.ok(V.entreesDuRegistre(REGISTRE).length >= 80,
    `${V.entreesDuRegistre(REGISTRE).length} entree(s) lue(s) : la forme du registre a change, la garde ne mesure plus rien`)
  assert.deepEqual(V.doublons(''), [], 'un texte vide n a pas de doublon…')
  assert.equal(V.entreesDuRegistre('').length, 0, '…mais il n a aucune entree, et c est CA que le script refuse')
})

test('LE TEST QUI COMPTE : le cas reel du 23 octobre 2026 — deux entrees 84 — est REFUSE', () => {
  // La contre-epreuve, gardee dans la suite et pas seulement faite une fois :
  // on rejoue l'etat exact que le merge avait laisse passer. La ligne ajoutee
  // est celle de l'autre session, posee AILLEURS dans le fichier — c'est
  // precisement pour ca que git n'y a vu aucun conflit.
  const lignes = REGISTRE.split('\n')
  const i = lignes.findIndex(l => l.startsWith('| 83 '))
  assert.ok(i > 0, 'le registre doit porter une entree 83 : sinon ce test ne rejoue rien')
  const avecDoublon = [
    ...lignes.slice(0, i),
    '| 84 | **La meme dette, inscrite par l autre session** | cout | echeance |',
    ...lignes.slice(i),
    '| 84 | **La meme dette, inscrite par moi** | cout | echeance |'
  ].join('\n')

  const d = V.doublons(avecDoublon)
  assert.equal(d.length, 1, 'un seul numero fautif')
  assert.equal(d[0].numero, 84)
  assert.equal(d[0].lignes.length, 2, 'et les DEUX lignes sont nommees : sinon il faut les rechercher a la main')
  assert.notEqual(d[0].lignes[0], d[0].lignes[1])
})

test('le prochain numero libre se CALCULE, et c est max + 1', () => {
  // ⚠ PAS « nombre d entrees + 1 ». Une dette retiree laisse un trou, et
  // reutiliser un numero mort ferait pointer deux decisions vers la meme ligne
  // de journal — l historique est la seule chose qu on ne corrige pas.
  const n = V.entreesDuRegistre(REGISTRE).map(e => e.numero)
  assert.equal(V.prochainLibre(REGISTRE), Math.max(...n) + 1)
  assert.equal(V.prochainLibre('| 1 | a | b | c |\n| 7 | a | b | c |'), 8)
  assert.equal(V.prochainLibre(''), 1, 'un registre vide commence a 1')
})

test('l en-tete et le separateur ne sont pas des entrees', () => {
  // Le jour ou la premiere colonne cesse d etre un nombre, c est cette
  // assertion qui le dira — pas un doublon fantome.
  const faux = '| # | Dette | Cout si oubliee | Echeance |\n|---|---|---|---|\n| 12 | vraie | x | y |'
  assert.deepEqual(V.entreesDuRegistre(faux).map(e => e.numero), [12])
})
