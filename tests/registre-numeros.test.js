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
// vit dans `scripts/verifier-numeros-registre.js`, que le chef de file lance a
// la main avant un merge ; ce test appelle la MEME fonction, et il lance AUSSI
// le script pour lire son CODE DE SORTIE — c'est ce code que `&& git merge`
// enchaine, et il n'etait couvert par rien (constat GRAVE 2 de la revue du
// 24 octobre 2026 : trois mutations du CLI laissaient la suite entierement
// verte, dont une qui imprimait « ECHEC » en sortant 0).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const V = require('../scripts/verifier-numeros-registre.js')

const SCRIPT = path.join(__dirname, '..', 'scripts', 'verifier-numeros-registre.js')
const CHEMIN = path.join(__dirname, '..', 'docs', 'kb', 'dettes-v1.md')
const REGISTRE = fs.readFileSync(CHEMIN, 'utf8')

// Un registre minimal et AUTONOME. Les contre-epreuves du detecteur ne
// s'epissurent pas dans le registre vivant : un registre sale ferait alors
// rougir la contre-epreuve EN PLUS du test qui garde le registre, et le lecteur
// conclurait que le detecteur est casse alors que c'est la donnee (constat
// MOYEN 2 de la revue du 24 octobre 2026 — mesure : `4 !== 2`, un message qui
// accuse l'outil).
const faux = (...rangees) => [
  '# Registre d essai',
  '',
  '| # | Dette | Cout si oubliee | Echeance |',
  '|---|---|---|---|',
  ...rangees,
  '',
  '## Regle du registre',
  ''
].join('\n')

const RANGEE = (n, titre = 'une dette') => `| ${n} | **${titre}** | cout | echeance |`

// Lance le script comme le chef de file le lance, et rend son code de sortie.
const lancer = (fichier) => {
  try {
    execFileSync(process.execPath, [SCRIPT, fichier], { encoding: 'utf8', stdio: 'pipe' })
    return 0
  } catch (e) { return e.status }
}

const dansUnFichier = (contenu, nom = 'registre.md') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-registre-'))
  const f = path.join(d, nom)
  fs.writeFileSync(f, contenu)
  return f
}

test('LE TEST QUI COMPTE : aucun numero en double dans le registre des dettes', () => {
  const d = V.doublons(REGISTRE)
  assert.deepEqual(d, [],
    'numero(s) en double : ' + d.map(x => `${x.numero} (lignes ${x.lignes.join(', ')})`).join(' ; ') +
    ' — une seule entree par numero, et la plus complete des deux gagne')
})

test('LE TEST QUI COMPTE : aucune rangee du registre n echappe au comptage', () => {
  // ⚠ LE CONTROLE QUI MANQUAIT, ET IL VAUT LE DETECTEUR LUI-MEME (constat
  // GRAVE 1). Un numero gras, barre, indente ou suivi de « bis » n'etait pas
  // reconnu, donc pas compte, donc jamais en double : le script imprimait
  // « ok » sur un registre qui portait deux entrees 84. Huit formes sur douze
  // essayees passaient.
  const perdues = V.lignesNonComptees(REGISTRE)
  assert.deepEqual(perdues, [],
    'rangee(s) non comptee(s) : ' + perdues.map(p => `ligne ${p.ligne} (${p.apercu})`).join(' ; '))
})

test('un verificateur qui n a rien lu doit ECHOUER, pas rendre vert', () => {
  // ⚠ LA MOITIE QU'ON OUBLIE. Si le registre change de forme — tableau
  // reecrit, colonne deplacee —, un comptage qui lit zero entree rendrait
  // « aucun doublon » : un vert qui ne mesure rien.
  // ⚠ ET LE SEUIL N'EST PAS UNE COUVERTURE. Ma premiere version disait qu'il
  // « refuse une lecture amputee » : c'etait faux, et la revue l'a mesure — a
  // 82 entrees, en perdre une laisse 81, donc au-dessus du seuil. C'est
  // `lignesNonComptees` qui refuse l'amputation, pas ce nombre. Le seuil ne
  // refuse qu'une lecture VIDE ou effondree.
  const n = V.entreesDuRegistre(REGISTRE).length
  assert.ok(n >= 80, `${n} entree(s) lue(s) : la forme du registre a change, la garde ne mesure plus rien`)
  assert.deepEqual(V.doublons(''), [], 'un texte vide n a pas de doublon…')
  assert.equal(V.entreesDuRegistre('').length, 0, '…mais il n a aucune entree, et c est CA que le script refuse')
})

test('LE TEST QUI COMPTE : le cas reel du 23 octobre 2026 — deux entrees 84 — est REFUSE', () => {
  // Les deux lignes sont posees LOIN l'une de l'autre, comme ce jour-la : c'est
  // precisement parce qu'elles n'etaient pas au meme endroit du fichier que git
  // n'y a vu aucun conflit.
  const d = V.doublons(faux(
    RANGEE(83), RANGEE(84, 'inscrite par l autre session'),
    RANGEE(1), RANGEE(2), RANGEE(84, 'inscrite par moi')
  ))
  assert.equal(d.length, 1, 'un seul numero fautif')
  assert.equal(d[0].numero, 84)
  assert.deepEqual(d[0].lignes, [6, 9],
    'les DEUX lignes sont nommees : sinon il faut rechercher a la main ce que le verificateur vient de trouver')
})

test('LE TEST QUI COMPTE : les formes qui passaient inapercues sont NOMMEES', () => {
  // Les quatre formes mesurees par la revue, dont la plus credible : la regle
  // du registre dit qu'une dette soldee SE BARRE.
  for (const rangee of [
    '| **84** | gras | cout | echeance |',
    '| ~~84~~ | barre | cout | echeance |',
    '| 84 bis | bis | cout | echeance |',
    '| #84 | diese | cout | echeance |'
  ]) {
    const texte = faux(RANGEE(83), rangee)
    assert.equal(V.doublons(texte).length, 0, 'ces formes ne sont pas des doublons…')
    const perdues = V.lignesNonComptees(texte)
    assert.equal(perdues.length, 1, `…mais ${rangee} doit etre SIGNALEE, pas ignoree`)
    assert.equal(perdues[0].ligne, 6)
    assert.equal(lancer(dansUnFichier(texte)), 1, `${rangee} : le script doit sortir en erreur`)
  }
  // Et l indentation d UNE espace, licite en Markdown, redevient une entree
  // ordinaire : elle est comptee, donc elle peut etre en double.
  const indentee = faux(RANGEE(83), ' | 84 | indentee | cout | echeance |', RANGEE(84))
  assert.deepEqual(V.lignesNonComptees(indentee), [])
  assert.equal(V.doublons(indentee).length, 1, 'une rangee indentee compte, et son doublon se voit')
})

test('la garde ne CRIE PAS sur un bloc de code, une annexe ou un exemple en prose', () => {
  // ⚠ UNE ALARME QUI SE TROMPE EST UNE ALARME QU'ON APPREND A IGNORER, et
  // CLAUDE.md ne parle que de ca. Ma premiere version balayait le fichier
  // entier : un exemple de forme recopie sous « Regle du registre » suffisait a
  // la faire rougir (constat MOYEN 1).
  const avecBruit = [
    '# Registre d essai',
    '',
    '| # | Dette | Cout | Echeance |',
    '|---|---|---|---|',
    RANGEE(83),
    RANGEE(84),
    '',
    '```',
    '| 83 | exemple dans un bloc de code | x | y |',
    '| 84 | exemple dans un bloc de code | x | y |',
    '```',
    '',
    '## Regle du registre',
    '',
    'Forme d une entree : `| 84 | **titre** | cout | echeance |`',
    '',
    '## Annexe — ordre des lots',
    '',
    '| 1 | premier | x | y |',
    '| 1 | doublon HORS du registre | x | y |',
    ''
  ].join('\n')
  assert.deepEqual(V.doublons(avecBruit), [], 'aucun de ces trois n est un doublon du registre')
  assert.deepEqual(V.lignesNonComptees(avecBruit), [])
  assert.deepEqual(V.entreesDuRegistre(avecBruit).map(e => e.numero), [83, 84],
    'seules les rangees du tableau du registre sont comptees')
})

test('LE TEST QUI COMPTE : le CODE DE SORTIE du script, sur trois fixtures', () => {
  // ⚠ C'EST CE CODE QUE `node scripts/… && git merge` ENCHAINE, et il n etait
  // couvert par rien. Trois mutations du CLI laissaient la suite verte, dont
  // une qui imprimait « ECHEC numero 84 present 2 fois » et sortait 0.
  assert.equal(lancer(dansUnFichier(faux(RANGEE(83), RANGEE(84)))), 0,
    'registre propre : sortie 0, sinon la garde bloque tous les merges')
  assert.equal(lancer(dansUnFichier(faux(RANGEE(84), RANGEE(1), RANGEE(84)))), 1,
    'registre a doublon : sortie 1, sinon `&& git merge` passe quand meme')
  assert.equal(lancer(dansUnFichier('# Rien\n\nPas de tableau ici.\n')), 1,
    'aucune entree lue : sortie 1 — un verificateur qui n a rien lu doit echouer')
  assert.equal(lancer(path.join(os.tmpdir(), 'hs-registre-absent-' + Date.now() + '.md')), 1,
    'fichier illisible : sortie 1')
  // Et le vrai registre, par le meme chemin que le chef de file.
  assert.equal(lancer(CHEMIN), 0)
})

test('LE TEST QUI COMPTE : une entree rangee au mauvais endroit est REFUSEE, un TROU non', () => {
  // ⚠ LA TROISIEME FORME DU MEME PHENOMENE, cas reel du 24 octobre 2026 : le
  // merge de `dette-90-refus-avant-garde` a range l'entree 90 ENTRE la 83 et la
  // 84, sans conflit et sans un mot, parce que sa branche partait d'un `main`
  // dont le registre s'arretait a 83. Aucun doublon : 1 a 90, chacun une fois.
  // La detection de doublons sort 0 a juste titre — et le registre est faux.
  const deplacee = faux(RANGEE(83), RANGEE(90, 'rangee au mauvais endroit'), RANGEE(84))
  assert.deepEqual(V.doublons(deplacee), [], 'ce cas ne produit AUCUN doublon : c est tout le probleme')
  assert.deepEqual(V.lignesNonComptees(deplacee), [], 'et aucune rangee perdue non plus')
  const r = V.ruptures(deplacee)
  assert.equal(r.length, 1)
  assert.deepEqual([r[0].precedent.numero, r[0].suivant.numero], [90, 84],
    'la rupture nomme les DEUX numeros : sans eux, il faut relire la table entiere')
  assert.deepEqual([r[0].precedent.ligne, r[0].suivant.ligne], [6, 7])
  assert.equal(lancer(dansUnFichier(deplacee)), 1, 'et le script sort en erreur')

  // ⚠ UN TROU N'EST PAS UNE RUPTURE, et le registre en a un vrai : il saute de
  // 38 a 40, la dette 39 ne vivant que sur une branche non mergee. Une garde
  // qui refuserait les trous pousserait a reutiliser un numero mort, donc a
  // faire pointer deux decisions vers la meme ligne de journal.
  assert.deepEqual(V.ruptures(faux(RANGEE(38), RANGEE(40), RANGEE(41))), [],
    'un trou est legitime')
  assert.deepEqual(V.ruptures(REGISTRE), [],
    'le registre lui-meme : suite croissante — l inversion « 13 puis 12 », qui precedait ce lot, est corrigee dans ce commit')
})

test('le prochain numero libre se CALCULE, et c est max + 1', () => {
  // ⚠ PAS « nombre d entrees + 1 ». Le registre a un vrai trou — la dette 39 ne
  // vit que sur une branche non mergee —, donc il compte 82 entrees pour un
  // maximum de 83. Reutiliser un numero mort ferait pointer deux decisions vers
  // la meme ligne de journal.
  const n = V.entreesDuRegistre(REGISTRE).map(e => e.numero)
  assert.equal(V.prochainLibre(REGISTRE), Math.max(...n) + 1)
  assert.ok(V.prochainLibre(REGISTRE) > n.length, 'le trou se voit : plus de numeros que d entrees')
  assert.equal(V.prochainLibre(faux(RANGEE(1), RANGEE(7))), 8)
  assert.equal(V.prochainLibre(''), 1, 'un registre vide commence a 1')
})

test('l en-tete et le separateur ne sont pas des entrees', () => {
  const t = faux(RANGEE(12))
  assert.deepEqual(V.entreesDuRegistre(t).map(e => e.numero), [12])
  assert.deepEqual(V.lignesNonComptees(t), [],
    'l en-tete et le separateur ne doivent pas etre signales comme des rangees perdues')
})

// ═══════════════════════════════════════════════════════════════════════════
// LES DEUX TROUS MESURES LE 26 OCTOBRE 2026
// ═══════════════════════════════════════════════════════════════════════════

test('LE TEST QUI COMPTE : un registre qui porte des MARQUEURS DE CONFLIT est REFUSE', () => {
  // ⚠ LA GARDE RENDAIT « ok », CODE 0, SUR UN FICHIER NON RESOLU. Mesure du
  // 26 octobre 2026 : trois marqueurs dans le registre, et « 95 entrees, aucun
  // doublon, suite croissante ». Le fichier serait parti en production avec
  // `<<<<<<< HEAD` dedans.
  //
  // ⚠ ET LE CAS QUI PASSE N'EST PAS N'IMPORTE LEQUEL — mes DEUX premieres
  // mesures ont ete rattrapees PAR HASARD. Un conflit dont les deux cotes
  // portent le MEME numero fait un doublon ; un conflit dont un cote reprend un
  // numero deja pris aussi. Le cas qui echappe a tout est celui ou les deux
  // cotes ont des numeros LIBRES et CROISSANTS — exactement ce qu'un merge de
  // deux branches qui ouvrent chacune leur dette produit.
  const conflit = faux(
    RANGEE(1),
    '<<<<<<< HEAD',
    RANGEE(101, 'mon entree'),
    '=======',
    RANGEE(102, 'son entree'),
    '>>>>>>> autre-branche'
  )
  const vus = V.marqueursDeConflit(conflit)
  assert.equal(vus.length, 3, 'les trois marqueurs doivent etre vus')
  assert.equal(lancer(dansUnFichier(conflit)), 1,
    'un registre non resolu doit faire ECHOUER le script, pas rendre vert')
  // Et le vrai registre, lui, n'en porte aucun.
  assert.deepEqual(V.marqueursDeConflit(REGISTRE), [],
    'le registre vivant porte un marqueur de merge non resolu')
})

test('`=======` SEUL n est pas un conflit : un soulignement de titre a la meme forme', () => {
  // ⚠ SANS CETTE DISTINCTION, LA GARDE CRIE FAUX. Markdown souligne un titre
  // par une ligne de `=`, et une garde qui refuserait toute ligne de sept `=`
  // refuserait un document parfaitement sain — un faux rouge se fait ignorer,
  // et c'est ainsi qu'une garde meurt.
  assert.deepEqual(V.marqueursDeConflit('Un titre\n=======\n\ndu texte'), [],
    'sept « = » hors d un conflit ne sont pas un marqueur')
  assert.equal(V.marqueursDeConflit('<<<<<<< a\nx\n=======\ny\n>>>>>>> b').length, 3,
    'encadre par les deux autres, il en est un')
})

test('LE TEST QUI COMPTE : une entree dont le COMPTE DE COLONNES differe est REFUSEE', () => {
  // ⚠ LES TROIS AUTRES CONTROLES COMPTENT LES ENTREES, PAS LES COLONNES, et ils
  // sont restes verts cinq jours sur l'entree 80 du registre — trois cellules
  // sur quatre, sans pipe final, donc la note de renumerotation rangee sous
  // « Cout si oubliee » et l'echeance vide. Le contenu n'est pas perdu, il est
  // DEPLACE : invisible a l'oeil sur une ligne de 1 500 caracteres.
  const attendu = V.colonnesAttendues(REGISTRE)
  assert.equal(attendu, 4, 'le compte vient de l EN-TETE, il n est pas ecrit dans le script')
  const enTrop = faux(RANGEE(1), '| 2 | **une dette | de plus** | cout | echeance |')
  assert.equal(V.colonnesHorsNorme(enTrop).length, 1, 'une cellule en trop est vue')
  assert.equal(lancer(dansUnFichier(enTrop)), 1, 'et elle fait echouer le script')
  const manquante = faux(RANGEE(1), '| 2 | **une dette** | cout')
  assert.equal(V.colonnesHorsNorme(manquante).length, 1, 'une cellule manquante aussi')
  // Le registre vivant, apres la reparation de l'entree 80.
  assert.deepEqual(V.colonnesHorsNorme(REGISTRE), [],
    'une entree du registre n a pas le bon nombre de colonnes')
})

test('LE TEST QUI COMPTE : un `|` ECHAPPE est du texte, et le pipe final est optionnel', () => {
  // ⚠ C'EST MA PROPRE ERREUR DE MESURE, GARDEE ICI. J'ai signale l'entree 36 du
  // registre comme mal formee — « six champs » — avant d'ecrire ce controle.
  // Faux : son texte porte `liste.json?.data \|\| []`, deux pipes ECHAPPES, et
  // c'est mon `awk -F'|'` qui les comptait comme des separateurs. Une garde qui
  // se trompe dans ce sens-la fait reparer ce qui va bien.
  assert.equal(V.cellulesDe('| 36 | `a \\|\\| b` | cout | echeance |'), 4,
    'deux pipes echappes dans une cellule ne la coupent pas')
  assert.equal(V.cellulesDe('| 1 | a | b | c |'), 4, 'avec pipe final')
  assert.equal(V.cellulesDe('| 1 | a | b | c'), 4, 'sans pipe final : meme compte')
  assert.equal(V.cellulesDe('| 1 | a | b |'), 3, 'une cellule de moins se compte')
  // Et l'entree 36 du registre vivant, nommement.
  const l36 = REGISTRE.split('\n').find(l => l.startsWith('| 36 |'))
  assert.ok(l36, 'l entree 36 a disparu du registre')
  assert.equal(V.cellulesDe(l36), 4, 'l entree 36 est SAINE : ses pipes sont echappes')
})
