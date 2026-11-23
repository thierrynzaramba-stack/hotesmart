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
// ⚠ UNE HEURE TAPÉE DANS LE NOUVEAU BLOC APRÈS LE DÉPLOIEMENT N'EST JAMAIS
//   REMISE À L'HEURE DE LA BASE (constat 1 de la relecture 2) : le writer de
//   l'heure retire la ligne de base de cette heure avant d'écrire la fiche, et
//   `--go` n'a plus rien à recopier. Seule fenêtre restante : les quelques
//   secondes du `--go` lui-même — personne ne saisit d'heure pendant qu'il
//   tourne.
// ⚠ CODE DE SORTIE : 0, 1 sur un échec, 2 sur un geste SAUTÉ — un saut se
//   relit (à blanc) avant d'être relancé.
// ⚠ À BLANC PAR DÉFAUT : la sortie dit, logement par logement, ce qui sera
//   copié, ce qui diffère (« écart »), ce qui est illisible, ce qui était caché
//   à l'IA — et rien n'est écrit. Jamais dans un merge : sur le go de Thierry.
// ⚠ LA DÉCISION EST CELLE DE `planDeReprise`, L'EXÉCUTION CELLE DE
//   `executerReprise` (lib/heures-logement.js) : le script ne fait que lire,
//   afficher, et appeler.
// ⚠ EMPREINTE EN TÊTE : la référence du projet Supabase (lib/empreinte-base.js).
const { nomDeLaBase, refDuProjet } = require('../lib/empreinte-base')
const { planDeReprise, executerReprise, COLONNE_HEURE } = require('../lib/heures-logement')

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

/**
 * La reprise, séparée de l'environnement pour être éprouvée avec un double
 * (constat 9 de la relecture 2 : « à blanc n'écrit rien » n'était tenu par
 * aucun test). `mode` : 'blanc' | 'copier' | 'go'. Rend le code de sortie :
 * 0, 1 sur un échec, 2 sur un geste SAUTÉ (constat 4 de la relecture 2 : un
 * saut sortait en 0, donc passait pour un succès).
 */
async function lancer ({ sb, mode = 'blanc', log = console.log, err = console.error }) {
  log(mode === 'go' ? 'MODE : COPIE + RETRAIT DES LIGNES DE BASE (--go)'
    : mode === 'copier' ? 'MODE : COPIE SEULE (--copier) — aucune ligne de base retirée'
      : 'MODE : À BLANC (rien n’est écrit ; --copier avant le merge, --go après le déploiement)')

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
    log(`- ${b.nom} : ${morceaux.join(' ; ')}`)
  }
  log(`Logements en service : ${plan.length} ; archivés, non touchés : ${archives} ; lignes de base sans logement : ${orphelines}.`)
  log(`Bilan : ${Object.entries(compte).map(([a, n]) => `${a} ${n}`).join(', ') || 'rien'}.`)
  // ⚠ L'ACTION ET LA MENTION, TOUJOURS ENSEMBLE (constat 5 de la relecture 2) :
  // un écart caché à l'IA ne s'affichait que « caché à l'IA », et une ligne
  // illisible — jamais retirée — disait « la retirer la lui rend ».
  const aMontrer = plan.flatMap(b => Object.entries(b.heures)
    .filter(([, h]) => ['ecart', 'illisible', 'fiche_illisible'].includes(h.action) || h.horsIa)
    .map(([cle, h]) => `${b.nom} (${LIBELLE[cle]}) : ${h.action}${h.ecrire ? ` → ${h.ecrire}` : ''}`
      + (h.horsIa ? (h.supprimerLigne != null ? ', cachée à l’IA — la retirer la lui rend' : ', cachée à l’IA') : '')))
  if (aMontrer.length) log(`À montrer à Thierry avant d’écrire : ${aMontrer.join(' ; ')}.`)

  if (mode !== 'go' && mode !== 'copier') return 0

  const bilan = await executerReprise(sb, plan, { supprimer: mode === 'go' })
  for (const s of bilan.sautees) log(`  SAUTÉ ${s}`)
  for (const e of bilan.echecs) err(`  ÉCHEC ${e}`)
  log(`Écrit : ${bilan.ecrites} heure(s) en fiche, ${bilan.supprimees} ligne(s) de base retirée(s), ${bilan.sautees.length} sautée(s), ${bilan.echecs.length} échec(s).`)
  if (bilan.echecs.length) return 1
  if (bilan.sautees.length) {
    log('Un geste sauté se RELIT avant d’être relancé : relancer à blanc, et montrer l’écart à Thierry.')
    return 2
  }
  return 0
}

if (require.main === module) {
  const URL = process.env.SUPABASE_URL
  const KEY = process.env.SUPABASE_SERVICE_KEY
  if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents.'); process.exit(1) }
  const args = process.argv.slice(2)
  const GO = args.includes('--go')
  const COPIER = args.includes('--copier')
  if (GO && COPIER) { console.error('--go et --copier : l’un ou l’autre.'); process.exit(1) }
  const nom = nomDeLaBase(URL)
  console.log(`Base : ${refDuProjet(URL)} — ${nom}`)
  if (nom === 'INCONNUE') { console.error('Projet inconnu : arrêt.'); process.exit(1) }
  const { createClient } = require('@supabase/supabase-js')
  lancer({ sb: createClient(URL, KEY), mode: GO ? 'go' : COPIER ? 'copier' : 'blanc' })
    .then(code => process.exit(code))
    .catch(e => { console.error('Reprise interrompue :', e.message); process.exit(1) })
}

module.exports = { lancer, toutLire }
