#!/usr/bin/env node
// scripts/reprendre-heures-fiche.js — les heures d'arrivée et de départ passent
// de la base de connaissance à la FICHE du logement, une fois.
// Spec : docs/specs/spec-heures-logement.md §4 et S6 (décisions de Thierry du
// 22 novembre 2026 : la fiche, seule source ; l'heure tapée par l'hôte
// l'emporte sur celle de Beds24).
//
// Usage : node --env-file=<fichier d'env> scripts/reprendre-heures-fiche.js        (à blanc)
//         node --env-file=<fichier d'env> scripts/reprendre-heures-fiche.js --go   (écrit)
//
// ⚠ À BLANC PAR DEFAUT : la sortie dit, logement par logement, ce qui sera
//   copié, ce qui diffère (« écart »), ce qui est illisible — et rien n'est
//   écrit. Lancé pour de vrai seulement sur le go de Thierry, jamais dans un
//   merge.
// ⚠ LA DÉCISION EST CELLE DE `planDeReprise` (lib/heures-logement.js), la même
//   à blanc et pour de vrai : le script ne fait qu'exécuter le plan.
// ⚠ ORDRE DES GESTES : la fiche d'abord, la ligne de base ENSUITE, et seulement
//   si la fiche a été écrite. Une ligne supprimée avant l'écriture perdrait
//   l'heure de l'hôte si l'écriture tombait.
// ⚠ UNE FORME ILLISIBLE N'EST JAMAIS DEVINÉE : ni écrite, ni supprimée.
// ⚠ EMPREINTE EN TETE : la référence du projet Supabase (lib/empreinte-base.js).
const { nomDeLaBase, refDuProjet } = require('../lib/empreinte-base')
const { planDeReprise, COLONNE_HEURE } = require('../lib/heures-logement')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents.'); process.exit(1) }
const ECRIRE = process.argv.slice(2).includes('--go')
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
  console.log(ECRIRE ? 'MODE : ÉCRITURE (--go)' : 'MODE : À BLANC (rien n’est écrit ; --go pour écrire)')

  const { createClient } = require('@supabase/supabase-js')
  const sb = createClient(URL, KEY)

  const biens = await toutLire(sb, 'properties',
    'id, user_id, name, provider_property_id, checkin_time, checkout_time, archive_le')
  const lignes = await toutLire(sb, 'knowledge', 'id, user_id, property_id, type, key, value',
    q => q.eq('type', 'fixed').in('key', Object.keys(COLONNE_HEURE)))

  const { plan, archives } = planDeReprise({ biens, lignes })
  const compte = {}
  for (const b of plan) {
    const morceaux = Object.entries(b.heures).map(([cle, h]) => {
      compte[h.action] = (compte[h.action] || 0) + 1
      const de = h.base != null ? `base « ${h.base} »` : 'pas de ligne de base'
      const fi = h.fiche != null ? `fiche « ${h.fiche} »` : 'fiche vide'
      return `${LIBELLE[cle]} : ${h.action}${h.ecrire ? ` → ${h.ecrire}` : ''} (${de}, ${fi})`
    })
    console.log(`- ${b.nom} : ${morceaux.join(' ; ')}`)
  }
  console.log(`Logements en service : ${plan.length} ; archivés, non touchés : ${archives}.`)
  console.log(`Bilan : ${Object.entries(compte).map(([a, n]) => `${a} ${n}`).join(', ') || 'rien'}.`)
  const aMontrer = plan.flatMap(b => Object.entries(b.heures)
    .filter(([, h]) => ['ecart', 'illisible', 'fiche_illisible'].includes(h.action))
    .map(([cle, h]) => `${b.nom} (${LIBELLE[cle]}) : ${h.action}`))
  if (aMontrer.length) console.log(`À montrer à Thierry avant --go : ${aMontrer.join(' ; ')}.`)

  if (!ECRIRE) return

  let ecrites = 0
  let supprimees = 0
  let echecs = 0
  for (const b of plan) {
    for (const [cle, h] of Object.entries(b.heures)) {
      let ficheOk = true
      if (h.ecrire) {
        const { data, error } = await sb.from('properties')
          .update({ [COLONNE_HEURE[cle]]: h.ecrire })
          .eq('id', b.id).eq('user_id', b.userId).is('archive_le', null)
          .select('id').maybeSingle()
        ficheOk = !error && !!data
        if (ficheOk) ecrites++
        else { echecs++; console.error(`  ÉCHEC fiche ${b.nom} (${LIBELLE[cle]}) : ${error ? error.message : 'logement indisponible'}`) }
      }
      if (ficheOk && h.supprimerLigne != null) {
        const { error } = await sb.from('knowledge').delete()
          .eq('id', h.supprimerLigne).eq('user_id', b.userId).eq('property_id', b.ref)
        if (error) { echecs++; console.error(`  ÉCHEC base ${b.nom} (${LIBELLE[cle]}) : ${error.message}`) }
        else supprimees++
      }
    }
  }
  console.log(`Écrit : ${ecrites} heure(s) en fiche, ${supprimees} ligne(s) de base retirée(s), ${echecs} échec(s).`)
  if (echecs) process.exit(1)
})().catch(e => { console.error('Reprise interrompue :', e.message); process.exit(1) })
