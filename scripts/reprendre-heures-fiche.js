#!/usr/bin/env node
// scripts/reprendre-heures-fiche.js — les heures d'arrivée et de départ passent
// de la base de connaissance à la FICHE du logement.
// Spec : docs/specs/spec-heures-logement.md §4 bis (ordre des gestes) et S6
// (décisions de Thierry du 22 novembre 2026 : la fiche, seule source ; l'heure
// tapée par l'hôte l'emporte sur celle de Beds24).
//
// Usage : node --env-file=<fichier d'env> scripts/reprendre-heures-fiche.js           (à blanc)
//         node --env-file=<fichier d'env> scripts/reprendre-heures-fiche.js --copier  (copie seule)
//         node --env-file=<fichier d'env> scripts/reprendre-heures-fiche.js --go      (copie + retrait)
//
// ⚠ L'ORDRE DES GESTES EST TOUTE LA SÛRETÉ DE LA REPRISE (constat 1 de la
//   relecture 1) :
//     1. à blanc, puis `--copier` AVANT le merge : l'ancien code lit encore la
//        base en premier, donc rien ne change pour le voyageur, et aucune ligne
//        n'est retirée ;
//     2. merge, déploiement vérifié au SHA ;
//     3. à blanc, puis `--go` DANS LE QUART D'HEURE : il recopie ce qui a bougé
//        (un logement Beds24 que l'ancienne synchro a réaligné, une heure saisie
//        dans l'ancien bloc entre-temps) et retire les lignes de base.
//   Dans l'autre ordre — `--go` avant le déploiement — un logement Beds24
//   perdrait son heure pour de bon : l'ancienne synchro réécrit la fiche, et la
//   ligne de base serait déjà partie.
// ⚠ À BLANC PAR DÉFAUT : la sortie dit, logement par logement, ce qui sera
//   copié, ce qui diffère (« écart »), ce qui est illisible, ce qui était caché
//   à l'IA — et rien n'est écrit. Jamais dans un merge : sur le go de Thierry.
// ⚠ LA DÉCISION EST CELLE DE `planDeReprise`, L'EXÉCUTION CELLE DE
//   `executerReprise` (lib/heures-logement.js) : le script ne fait que lire,
//   afficher, et appeler.
// ⚠ EMPREINTE EN TÊTE : la référence du projet Supabase (lib/empreinte-base.js).
const { nomDeLaBase, refDuProjet } = require('../lib/empreinte-base')
const { planDeReprise, executerReprise, COLONNE_HEURE } = require('../lib/heures-logement')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents.'); process.exit(1) }
const args = process.argv.slice(2)
const GO = args.includes('--go')
const COPIER = args.includes('--copier')
if (GO && COPIER) { console.error('--go et --copier : l’un ou l’autre.'); process.exit(1) }
const PAGE = 1000

// ⚠ LECTURE PAGINÉE PAR CURSEUR (règle 6 de la case performance) : PostgREST
// rend 1000 lignes SANS erreur, une reprise tronquée oublierait des logements.
async function toutLire (sb, table, colonnes, filtrer) {
  const lignes = []
  let apres = null
  for (;;) {
    let q = sb.from(table).select(colonnes).order('id').limit(PAGE)
    if (filtrer) q = filtrer(q)
    if (apres != null) q = q.gt('id', apres)
    const { data, error } = await q
    if (error) throw new Error(`${table} : ${error.message}`)
    lignes.push(...(data || []))
    if (!data || data.length < PAGE) return lignes
    apres = data[data.length - 1].id
  }
}

const LIBELLE = { checkin: 'arrivée', checkout: 'départ' }

;(async () => {
  const nom = nomDeLaBase(URL)
  console.log(`Base : ${refDuProjet(URL)} — ${nom}`)
  if (nom === 'INCONNUE') { console.error('Projet inconnu : arrêt.'); process.exit(1) }
  console.log(GO ? 'MODE : COPIE + RETRAIT DES LIGNES DE BASE (--go)'
    : COPIER ? 'MODE : COPIE SEULE (--copier) — aucune ligne de base retirée'
      : 'MODE : À BLANC (rien n’est écrit ; --copier avant le merge, --go après le déploiement)')

  const { createClient } = require('@supabase/supabase-js')
  const sb = createClient(URL, KEY)

  const biens = await toutLire(sb, 'properties',
    'id, user_id, name, provider_property_id, checkin_time, checkout_time, archive_le')
  const lignes = await toutLire(sb, 'knowledge', 'id, user_id, property_id, type, key, value, lisible_par_ia',
    q => q.eq('type', 'fixed').in('key', Object.keys(COLONNE_HEURE)))

  const { plan, archives, orphelines } = planDeReprise({ biens, lignes })
  const compte = {}
  for (const b of plan) {
    const morceaux = Object.entries(b.heures).map(([cle, h]) => {
      compte[h.action] = (compte[h.action] || 0) + 1
      const de = h.base != null ? `base « ${h.base} »${h.horsIa ? ' (cachée à l’IA)' : ''}` : 'pas de ligne de base'
      const fi = h.fiche != null ? `fiche « ${h.fiche} »` : 'fiche vide'
      return `${LIBELLE[cle]} : ${h.action}${h.ecrire ? ` → ${h.ecrire}` : ''} (${de}, ${fi})`
    })
    console.log(`- ${b.nom} : ${morceaux.join(' ; ')}`)
  }
  console.log(`Logements en service : ${plan.length} ; archivés, non touchés : ${archives} ; lignes de base sans logement : ${orphelines}.`)
  console.log(`Bilan : ${Object.entries(compte).map(([a, n]) => `${a} ${n}`).join(', ') || 'rien'}.`)
  const aMontrer = plan.flatMap(b => Object.entries(b.heures)
    .filter(([, h]) => ['ecart', 'illisible', 'fiche_illisible'].includes(h.action) || h.horsIa)
    .map(([cle, h]) => `${b.nom} (${LIBELLE[cle]}) : ${h.horsIa ? 'cachée à l’IA, la retirer la lui rend' : h.action}`))
  if (aMontrer.length) console.log(`À montrer à Thierry avant d’écrire : ${aMontrer.join(' ; ')}.`)

  if (!GO && !COPIER) return

  const bilan = await executerReprise(sb, plan, { supprimer: GO })
  for (const s of bilan.sautees) console.log(`  SAUTÉ ${s}`)
  for (const e of bilan.echecs) console.error(`  ÉCHEC ${e}`)
  console.log(`Écrit : ${bilan.ecrites} heure(s) en fiche, ${bilan.supprimees} ligne(s) de base retirée(s), ${bilan.sautees.length} sautée(s), ${bilan.echecs.length} échec(s).`)
  if (bilan.echecs.length) process.exit(1)
})().catch(e => { console.error('Reprise interrompue :', e.message); process.exit(1) })
