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
  assert.match(code, /if \(!lignes\.length\)/,
    'la garde de vacuite des lignes a disparu')
  assert.match(code, /if \(!moisAvecSejours\)/,
    'la garde « aucun mois non vide » a disparu : un balayage de mois vides rendrait vert')
  assert.match(code, /if \(!comptes\.length\)/,
    'la garde « aucun compte » a disparu')
  // Chaque garde sort en ECHEC, et il faut le verifier : un `console.error`
  // suivi d'un `process.exit(0)` imprimerait ECHEC en rendant vert a l'appelant.
  const sorties = code.match(/process\.exit\((\d)\)/g) || []
  assert.ok(sorties.length >= 6, `seulement ${sorties.length} sortie(s) : les gardes ne sortent plus`)
  assert.ok(!sorties.includes('process.exit(0)'),
    'une garde sort en 0 : elle imprime un echec et rend un succes')
})

test('LE TEST QUI COMPTE : la base se nomme par sa reference de projet', () => {
  // Le depot a corrige six scripts qui reconnaissaient la base au NOMBRE DE
  // BIENS. Un verificateur qui mesure une autre base que celle annoncee rend
  // un vert qui ne veut rien dire.
  assert.match(code, /refDuProjet/, 'la reference du projet n\'est plus lue')
  assert.ok(!/properties.*length.*===\s*4|=== 4.*bien/i.test(code),
    'la base est reconnue au nombre de biens')
  assert.match(code, /annoncee !== base/,
    'la base annoncee n\'est plus confrontee a celle de l\'URL')
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
  assert.ok(COLONNES.length >= 10, `COLONNES n'a que ${COLONNES.length} entree(s)`)
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
