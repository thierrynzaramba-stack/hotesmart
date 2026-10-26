// tests/parite-revenus-script.test.js — LES GARDES DU VERIFICATEUR DE PARITE.
//
// ⚠ POURQUOI UN TEST SUR UN SCRIPT. `scripts/verifier-parite-revenus.js` porte
// deux AFFIRMATIONS dans ses commentaires : « lecture seule, sans option pour
// en sortir » et « un verificateur qui n'a rien lu doit echouer ». Le depot a
// paye six fois la meme lecon les 23-24 octobre 2026 : une phrase ecrite a la
// main est lue comme une mesure, et elle ne rougit JAMAIS. Si quelqu'un ajoute
// un `--go` a ce script ou retire sa garde de vacuite, rien ne le dirait — et
// le prochain qui le lance sur la production croirait le commentaire.
//
// Ces tests ne mesurent pas la parite : ils mesurent que l'INSTRUMENT refuse
// de rendre un vert gratuit.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const CHEMIN = path.join(__dirname, '..', 'scripts', 'verifier-parite-revenus.js')
const src = fs.readFileSync(CHEMIN, 'utf8')
// Le code sans ses commentaires : une assertion qui tombe sur le commentaire
// qui DECRIT le defaut passerait pour une mesure du code. C'est l'erreur que
// j'ai faite plusieurs fois dans mes propres scripts de verification.
const code = src.split('\n')
  .filter(l => !l.trim().startsWith('//'))
  .join('\n')

test('LE TEST QUI COMPTE : le verificateur de parite n\'a aucun chemin d\'ecriture', () => {
  // Il tourne en PRODUCTION sans autorisation particuliere, et c'est ce qui le
  // rend utile. La contrepartie est qu'il ne doit pas pouvoir ecrire, meme par
  // une option — pas de `--go`, et aucune des quatre ecritures de supabase-js.
  for (const ecriture of ['.update(', '.insert(', '.upsert(', '.delete(', '.rpc(\'set']) {
    assert.ok(!code.includes(ecriture),
      `le verificateur peut ECRIRE (${ecriture}) : il ne peut plus tourner en production sans go`)
  }
  assert.ok(!/['"]--go['"]/.test(code),
    'un `--go` est apparu dans le verificateur : son commentaire dit le contraire')
})

test('LE TEST QUI COMPTE : zero ligne lue fait ECHOUER, pas passer', () => {
  // ⚠ LE FAUX VERT LE PLUS FACILE A FABRIQUER. Zero ligne rend zero ecart,
  // donc « PARITE ETABLIE » — l'exact contraire de ce qu'il faut annoncer.
  // Vecu dans le depot : un script qui n'avait rien lu rendait vert.
  // ⚠ CHAQUE GARDE EST SUIVIE DE SA SORTIE, ET C'EST CE QU'ON MESURE — pas sa
  // presence. La version d'avant faisait `assert.match(code, /if \(!lignes\.length\)/)`
  // et comptait les `process.exit` : la review du lot a montre qu'on pouvait
  // VIDER le corps de la garde — `if (!lignes.length) { console.log('vide') }` —
  // sans faire rougir un seul test. Le script rendait alors « PARITE ETABLIE »
  // sur zero ligne. Et le seuil « au moins 6 sorties » portait sur un fichier
  // qui en contient dix-huit : il n'empechait rien.
  //
  // On lit donc le BLOC de chaque garde, et on exige qu'il sorte en 1.
  const blocApres = (motif) => {
    const i = code.indexOf(motif)
    assert.ok(i > -1, `la garde ${motif} a disparu`)
    // Du motif jusqu'a la fermeture de son bloc, accolades comptees.
    let profondeur = 0
    let j = code.indexOf('{', i)
    assert.ok(j > -1, `la garde ${motif} n'ouvre pas de bloc`)
    for (let k = j; k < code.length; k++) {
      if (code[k] === '{') profondeur++
      else if (code[k] === '}') { profondeur--; if (profondeur === 0) return code.slice(j, k + 1) }
    }
    assert.fail(`bloc non ferme pour ${motif}`)
  }
  for (const [motif, raison] of [
    ['if (!lignes.length)', 'zero ligne lue'],
    ['if (!moisAvecSejours)', 'aucun mois non vide'],
    ['if (!comptes.length)', 'aucun compte'],
    ['if (comparees === 0)', 'zero ligne comparee a l etage 1']
  ]) {
    const bloc = blocApres(motif)
    assert.match(bloc, /process\.exit\(1\)/,
      `la garde « ${raison} » n'ECHOUE plus : son bloc ne sort pas en 1, `
      + `donc le script conclurait « PARITE ETABLIE » sur une mesure absente`)
  }
  const sorties = code.match(/process\.exit\((\d)\)/g) || []
  assert.ok(!sorties.includes('process.exit(0)'),
    'une garde sort en 0 : elle imprime un echec et rend un succes')
})

test('LE TEST QUI COMPTE : la base se nomme par sa reference de projet', () => {
  // Le depot a corrige six scripts qui reconnaissaient la base au NOMBRE DE
  // BIENS. Un verificateur qui mesure une autre base que celle annoncee rend
  // un vert qui ne veut rien dire.
  assert.match(code, /refDuProjet/, 'la reference du projet n\'est plus lue')
  assert.match(code, /annoncee !== base/,
    'la base annoncee n\'est plus confrontee a celle de l\'URL')
  // ⚠ L'ASSERTION QUI CHERCHAIT « === 4 » ETAIT DECORATIVE, et la review du lot
  // l'a mesure : les deux mutations REALISTES de ce defaut —
  // `if (uuidParCle.size === 4)` et `biens.length === 4 ? 'STAGING' : 'PROD'` —
  // passaient toutes les deux, parce que son expression exigeait deux jalons
  // sur la MEME ligne dans cet ordre exact.
  //
  // Ce qui mord vraiment : aucun nombre litteral ne doit servir a decider de la
  // base. On cherche donc toute comparaison d'un compte a un entier dans le
  // voisinage du choix de base, et on exige qu'il n'y en ait aucune.
  const lignesDeBase = code.split('\n')
    .filter(l => /base|projet|STAGING|PRODUCTION/i.test(l))
  const parLeNombre = lignesDeBase.filter(l => /\b(length|size|count)\b\s*[=!<>]=*\s*\d/.test(l))
  assert.deepEqual(parLeNombre, [],
    'la base est reconnue a un NOMBRE (de biens, de lignes) et non a sa reference de projet')
})

test('l\'oracle est compare sur ses propres colonnes, sauf l\'horodatage', () => {
  // `derive_le` DOIT differer : c'est l'instant de l'ecriture. Tout le reste
  // doit concorder, et la liste ne se recopie pas a la main — elle derive de
  // `COLONNES`, pour qu'une onzieme colonne entre dans la comparaison toute
  // seule.
  assert.match(code, /COLONNES\.filter\(c => c !== 'derive_le'\)/,
    'la liste des colonnes comparees est recopiee a la main ou derive_le est compare')
  const { COLONNES } = require('../lib/revenus/derive')
  assert.ok(COLONNES.includes('derive_le'), 'derive_le a quitte COLONNES : le filtre ne filtre plus rien')
  // ⚠ ONZE, PAS DIX, et le nombre se LIT au lieu d'etre ecrit. `est_blocage`
  // est entree dans `COLONNES` le 27 octobre ; l'en-tete du module, le message
  // de commit et ce test disaient encore « dix ». Sans consequence
  // fonctionnelle — `COMPAREES` en garde bien dix apres le retrait de
  // `derive_le` — mais c'est un nombre ecrit a la main, donc un nombre qui ne
  // rougira jamais. On exige la coherence entre les deux listes, pas un total.
  assert.strictEqual(COLONNES.filter(c => c !== 'derive_le').length, COLONNES.length - 1,
    'derive_le n est plus exactement une entree de COLONNES')
  assert.ok(COLONNES.length >= 11,
    `COLONNES n'a que ${COLONNES.length} entree(s) : une colonne derivee a disparu`)
})

test('les blocages sont exclus par le MODULE, jamais en lisant la colonne', () => {
  // ⚠ SINON L'ETAGE 2 COMPARE LA COLONNE A ELLE-MEME. Si le script filtrait
  // l'oracle sur `l.est_blocage` (la valeur en base) au lieu de la recalculer,
  // un `est_blocage` faux disparaitrait des deux cotes a la fois — et la
  // parite serait etablie sur une erreur partagee.
  assert.match(code, /estUnBlocage\(s, r,/,
    'les blocages ne sont plus recalcules par le module')
  assert.ok(!/l\.est_blocage/.test(code),
    'le script lit la colonne est_blocage pour filtrer l oracle : il compare la base a elle-meme')
})
