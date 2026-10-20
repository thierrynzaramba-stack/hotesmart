#!/usr/bin/env node
// scripts/verifier-parite-notes.js — lot 2 du chantier chargement
// (20 octobre 2026). REVIEW.md regle 8 : une optimisation ne vaut que si elle
// rend EXACTEMENT les memes chiffres.
//
// ⚠ LA REFERENCE VIENT DE `git archive`, PAS DE L'ARBRE. Premiere version de
// ce script : elle comparait `noteMoyenne` a `notesDuPerimetre`. Or le lot a
// fait de la premiere une VUE de la seconde — les deux cotes etaient devenus
// le meme code, et la comparaison etait tautologique. Si l'extraction avait
// perdu `.eq('is_hidden', false)` — le filtre de la recette du 7 octobre — les
// deux cotes auraient sur-compte a l'identique et le script aurait imprime
// « PARITE COMPLETE » sur des chiffres faux.
//
// ⚠ ET LA REFERENCE EST LE LOT AVIS (`fix-note-globale-sur-5`), PAS L'ETAT
// D'AVANT CE LOT-CI. C'est lui qui a pose le contrat : `note_sur_5` cote
// serveur, micro-unites entieres, un seul arrondi, notes <= 0 ecartees. Ce
// qu'on prouve ici n'est donc pas « rien n'a bouge depuis main » — les
// chiffres ONT bouge, et c'est voulu — mais « lire une fois et grouper rend
// exactement ce que rend la lecture de reference, bien par bien ».
// Le script VERIFIE ce qu'il a extrait : un `noteMoyenne`, qui rend
// `note_sur_5`, et qui ne connait pas `notesDuPerimetre`.
//
// Usage : node --env-file=.env.local   scripts/verifier-parite-notes.js
//         node --env-file=.env.staging scripts/verifier-parite-notes.js [ref-git]
//         (ref-git par defaut : origin/fix-note-globale-sur-5)
//
// ⚠ EMPREINTE DE LA BASE EN TETE. Un resultat qui ne dit pas OU il a ete
// obtenu ne prouve rien, et « c'est conforme » sur la mauvaise base est pire
// que rien. 5 biens en production, 3 en staging (regle du depot).
//
// ⚠ UN VERIFICATEUR QUI N'A RIEN LU DOIT ECHOUER. Une parite entre deux zeros
// n'est pas une parite : le script la refuse, et il compte les notes vues DES
// DEUX COTES, global ET biens.
//
// LECTURE SEULE : aucune ecriture, aucun DDL.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createClient } = require('@supabase/supabase-js')
const { notesDuPerimetre, PERIODES } = require('../lib/stats-avis')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents. Passer --env-file.')
  process.exit(1)
}
const sb = createClient(URL, KEY)
const projet = String(URL).replace(/^https?:\/\//, '').split('.')[0]
const racine = path.join(__dirname, '..')
const git = (...a) => execFileSync('git', a, { cwd: racine, encoding: 'utf8', maxBuffer: 64 << 20 })

// ─── L'ancien comptage, extrait hors de l'arbre ─────────────────────────────
// `git archive`, jamais `git show > fichier` (regle 19 du depot).
// ⚠ UN SHA, PAS UN NOM DE BRANCHE. `fix-note-globale-sur-5` a ete mergee :
// elle sera elaguee au prochain menage, et `git archive` sortirait alors en
// exception brute (`fatal: not a valid object name`), sans passer par aucun
// des « ECHEC … » ecrits plus bas — donc sans dire que la preuve de parite
// est devenue inexecutable. Elle manque deja sur un clone neuf, en CI, et sur
// le second poste. Ce SHA est le DEUXIEME PARENT du merge f56e207 : il reste
// joignable depuis l'historique de main pour toujours.
// 3225479 = « Avis : les constats de la revue de 6a5475e », tete du lot Avis.
const REF_PAR_DEFAUT = '3225479'
function noteMoyenneDeReference (refDemandee) {
  const ref = refDemandee || REF_PAR_DEFAUT
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'parite-notes-'))
  execFileSync('bash', ['-c', `git archive ${JSON.stringify(ref)} lib/ | tar -x -C ${JSON.stringify(dossier)}`],
    { cwd: racine })
  const fichier = path.join(dossier, 'lib', 'stats-avis.js')
  const source = fs.readFileSync(fichier, 'utf8')

  // ⚠ ON VERIFIE CE QU'ON A EXTRAIT. Une ref qui pointerait sur l'arbre
  // d'aujourd'hui rendrait la comparaison tautologique en silence — le defaut
  // meme que cette extraction corrige.
  if (source.includes('notesDuPerimetre')) {
    console.error(`ECHEC : le code extrait de ${ref} contient deja \`notesDuPerimetre\`.`)
    console.error('Ce n\'est pas une reference independante : la comparaison serait tautologique.')
    process.exit(1)
  }
  if (!/async function noteMoyenne/.test(source)) {
    console.error(`ECHEC : pas de \`noteMoyenne\` dans le code extrait de ${ref}.`)
    process.exit(1)
  }
  // ⚠ ET QU'ELLE PORTE LE BON CONTRAT. Un `noteMoyenne` d'avant le lot Avis
  // rend `moyenne` sur 10 : compare a `note_sur_5`, tout serait « divergent »
  // et on chercherait un defaut la ou il n'y a qu'une mauvaise reference.
  if (!source.includes('note_sur_5')) {
    console.error(`ECHEC : le \`noteMoyenne\` extrait de ${ref} ne rend pas \`note_sur_5\`.`)
    console.error('Ce n\'est pas la reference du contrat en vigueur (lot Avis du 20 octobre 2026).')
    process.exit(1)
  }
  const mod = require(fichier)
  if (typeof mod.noteMoyenne !== 'function') {
    console.error(`ECHEC : \`noteMoyenne\` n'est pas exportee par ${ref}.`)
    process.exit(1)
  }
  return { ref, fn: mod.noteMoyenne, dossier }
}

let echecs = 0
let avertissements = 0
let comparaisons = 0
let notesAncien = 0
let notesNouveau = 0
const ko = (m) => { console.error(`  ECHEC ${m}`); echecs++ }
const attention = (m) => { console.warn(`  note  ${m}`); avertissements++ }

const dire = (x) => (x.note_sur_5 == null ? 'aucune note' : `${x.note_sur_5}/5 sur ${x.notes} avis`)

// ⚠ `erreur` FAIT PARTIE DE LA COMPARAISON. Une lecture en ECHEC rend
// `{ moyenne: null, notes: 0, erreur: true }`, qui est egal a « aucune note »
// sur les deux seuls champs qu'on comparait : le script imprimait alors `ok`
// pour un cote qui n'avait rien lu. C'est le faux vert que le depot combat.
const egal = (a, b) => a.note_sur_5 === b.note_sur_5 && a.notes === b.notes && !a.erreur && !b.erreur
const pourquoi = (a, b) => (a.erreur || b.erreur ? ' (une des deux lectures a ECHOUE)' : '')

// Les biens, PAGINES. Une lecture non bornee est tronquee a 1000 lignes sans
// erreur (db-max-rows), et le depot a deja paye ce defaut dans un script neuf.
async function tousLesBiens () {
  const PAGE = 1000
  const out = []
  for (let debut = 0; ; debut += PAGE) {
    const { data, error } = await sb.from('properties')
      .select('id, name, user_id, provider_property_id')
      .not('provider_property_id', 'is', null)
      .order('id', { ascending: true }).range(debut, debut + PAGE - 1)
    if (error) { console.error('Lecture des biens impossible :', error.message); process.exit(1) }
    out.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return out
}

async function main () {
  const ancien = noteMoyenneDeReference(process.argv[2])
  console.log(`\nBase       : ${projet}`)
  console.log(`Reference  : noteMoyenne extrait de ${ancien.ref} (hors de l'arbre, contrat note_sur_5)`)

  const biens = await tousLesBiens()
  if (!biens.length) { console.error('ECHEC : aucun bien lu. Rien a comparer.'); process.exit(1) }

  const { count: totalAvis, error: eA } = await sb.from('ota_reviews')
    .select('id', { count: 'exact', head: true })
  if (eA) { console.error('Lecture des avis impossible :', eA.message); process.exit(1) }
  console.log(`Empreinte  : ${biens.length} bien(s) avec cle provider, ${totalAvis} avis dans ota_reviews.`)

  const comptes = [...new Set(biens.map(b => b.user_id))]
  console.log(`${comptes.length} compte(s) proprietaire(s).\n`)

  // ⚠ UNE SEULE HORLOGE POUR TOUTE LA COMPARAISON. Trois periodes sur quatre
  // sont bornees, et l'ancien chemin est le LENT : des secondes passent entre
  // les deux cotes. Un avis dont `received_at` tombe dans cette fenetre
  // glissante serait compte d'un cote et pas de l'autre, et le script
  // annoncerait une divergence sur du code exact.
  const maintenant = Date.now()

  for (const periode of Object.keys(PERIODES)) {
    console.log(`── periode « ${periode} » ─────────────────────────────────────`)
    for (const userId of comptes) {
      const lesSiens = biens.filter(b => b.user_id === userId)
      const court = userId.slice(0, 8)

      const neuf = await notesDuPerimetre(sb, { userId, periode, maintenant })
      if (neuf.erreur) { ko(`compte ${court} : lecture groupee en echec`); continue }
      if (neuf.tronque) ko(`compte ${court} : lecture groupee INCOMPLETE (voir le journal)`)

      const refGlobal = await ancien.fn(sb, { userId, periode, maintenant })
      comparaisons++
      notesAncien += refGlobal.notes || 0
      notesNouveau += neuf.global.notes || 0
      if (!egal(neuf.global, refGlobal)) {
        ko(`compte ${court} global : ancien ${dire(refGlobal)} / nouveau ${dire(neuf.global)}${pourquoi(refGlobal, neuf.global)}`)
      } else {
        console.log(`  ok    compte ${court} global : ${dire(refGlobal)}`)
      }

      for (const b of lesSiens) {
        const ref = String(b.provider_property_id)
        const refBien = await ancien.fn(sb, { userId, periode, refs: [ref], maintenant })
        // Un bien sans avis n'a PAS de cle dans la reponse groupee : c'est
        // zero, et c'est ce que rendait son appel.
        const nouveau = Object.prototype.hasOwnProperty.call(neuf.par_bien, ref)
          ? neuf.par_bien[ref] : { note_sur_5: null, notes: 0 }
        comparaisons++
        notesAncien += refBien.notes || 0
        notesNouveau += nouveau.notes || 0
        if (!egal(nouveau, refBien)) {
          ko(`${b.name} (${ref}) : ancien ${dire(refBien)} / nouveau ${dire(nouveau)}${pourquoi(refBien, nouveau)}`)
        } else {
          console.log(`  ok    ${b.name.padEnd(22)} ${dire(refBien)}`)
        }
      }

      // ⚠ UNE REFERENCE ORPHELINE N'EST PAS UNE FUITE, c'est une donnee reelle.
      // `ota_reviews.property_id_ref` est un TEXT sans cle etrangere : un
      // re-keying Beds24 -> Channex, un bien dont `provider_property_id` est
      // repasse a NULL pendant une bascule, ou un bien supprime laissent des
      // avis dont la reference ne designe plus aucun bien du compte. Le groupe
      // les porte, le global les compte, et c'est correct. En faire un ECHEC
      // bloquait le lot et envoyait chercher une fuite qui n'existe pas.
      const refsDuCompte = new Set(lesSiens.map(b => String(b.provider_property_id)))
      for (const ref of Object.keys(neuf.par_bien)) {
        if (!refsDuCompte.has(ref)) {
          attention(`reference ${ref} : des avis du compte ${court} ne designent aucun bien actuel`
            + ' (re-keying, bascule ou bien supprime) — comptes au global, affiches nulle part')
        }
      }
    }
    console.log('')
  }

  if (ancien.dossier) fs.rmSync(ancien.dossier, { recursive: true, force: true })

  console.log(`${comparaisons} comparaison(s). ${notesAncien} note(s) comptee(s) cote ancien,`
    + ` ${notesNouveau} cote nouveau.`)
  if (avertissements) console.log(`${avertissements} remarque(s) non bloquante(s).`)
  if (notesAncien === 0 && notesNouveau === 0) {
    console.error('\nECHEC : zero note comptee, des deux cotes, sur toutes les periodes.')
    console.error('Une parite entre deux zeros ne prouve rien. Verifier la base visee.')
    process.exit(1)
  }
  if (echecs) {
    console.error(`\n${echecs} DIVERGENCE(S). Le lot ne doit pas partir.`)
    process.exit(1)
  }
  console.log('\nPARITE COMPLETE : la lecture groupee rend exactement ce que rendait l\'ancien chemin.')
}

main().catch(e => { console.error('Erreur :', e.message); process.exit(1) })
