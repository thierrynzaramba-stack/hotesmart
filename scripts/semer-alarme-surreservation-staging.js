#!/usr/bin/env node
// scripts/semer-alarme-surreservation-staging.js
// SEME UNE FAUSSE ALARME DE SURRESERVATION, POUR LA RECETTE DE LA BANNIERE.
//
// Demande de Thierry (23 octobre 2026) : eprouver a l'ecran la banniere
// « surreservation » et son bouton « Acquitter » — le SEUL moyen d'arreter la
// reemission des SMS au fondateur (spec-reservation-manuelle.md §4). La review
// du lot (b) a trouve que cette banniere ne pouvait plus s'afficher du tout :
// l'appel a `renderAlarmes()` avait disparu.
//
//   node scripts/semer-alarme-surreservation-staging.js            # seme
//   node scripts/semer-alarme-surreservation-staging.js --nettoyer # retire
//
// Il lit `.env.staging` par defaut, ou `ENV_FILE`.
//
// ⚠ IL REFUSE LA PRODUCTION, PAR LE REF DU PROJET, AVANT TOUTE ECRITURE.
// C'est une ECRITURE de donnee de recette : elle n'a rien a faire dans la base
// des vrais hotes, et une variable d'environnement mal pointee est l'erreur la
// plus facile de ce depot. La garde ne demande pas de confirmation, elle
// REFUSE — un garde-fou qui se contourne par « oui » ne garde rien.
//
// ⚠ ET ELLE NE CREE AUCUN CONFLIT REEL : la ligne decrit une surreservation,
// elle ne la provoque pas. Aucun stock ne bouge, aucune nuit n'est fermee,
// rien ne part chez un canal. Staging n'a de toute facon aucun cron
// (docs/STAGING.md §1), donc aucun SMS ne sera emis.

require('dotenv').config({ path: process.env.ENV_FILE || '/home/thierry/hotesmart/.env.staging' })
const { createClient } = require('@supabase/supabase-js')

const PROD = 'cjmrizpdyhrcurmgyrhs'
const STAGING = 'ortyofzzdsthlhqmzsnq'
const MARQUEUR = 'RECETTE-LOT-B'

const ref = (process.env.SUPABASE_URL || '').match(/\/\/([a-z0-9]+)\./)
const projet = ref && ref[1]
if (projet === PROD) {
  console.error('REFUSE : ce script ecrit une donnee de RECETTE, et SUPABASE_URL pointe la PRODUCTION.')
  process.exit(1)
}
if (projet !== STAGING) {
  console.error(`REFUSE : projet inattendu « ${projet} ». Attendu ${STAGING} (staging).`)
  process.exit(1)
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const nettoyer = process.argv.includes('--nettoyer')

;(async () => {
  console.log(`projet ${projet} (staging)\n`)

  if (nettoyer) {
    // On ne supprime QUE ce que ce script a seme : le marqueur est dans le
    // detail, pas dans un champ libre qu'un vrai incident pourrait porter.
    const { data, error } = await sb.from('automation_incidents')
      .select('id, detail').eq('type', 'overbooking')
    if (error) { console.error('ECHEC lecture : ' + error.message); process.exit(1) }
    const miens = (data || []).filter(r => (r.detail || {}).marqueur === MARQUEUR)
    if (!miens.length) { console.log('rien a nettoyer'); return }
    const { error: eDel } = await sb.from('automation_incidents')
      .delete().in('id', miens.map(r => r.id))
    if (eDel) { console.error('ECHEC suppression : ' + eDel.message); process.exit(1) }
    console.log(`${miens.length} alarme(s) de recette supprimee(s)`)
    return
  }

  const { data: biens, error: eB } = await sb.from('properties')
    .select('id, name, user_id, provider_property_id').order('name')
  if (eB) { console.error('ECHEC lecture biens : ' + eB.message); process.exit(1) }
  const bien = (biens || []).find(b => b.provider_property_id)
  if (!bien) { console.error('REFUSE : aucun bien avec une cle provider sur staging'); process.exit(1) }

  // Deja seme ? On ne double pas : la banniere afficherait deux fois la meme
  // chose, et la recette ne saurait pas lequel elle acquitte.
  const { data: dejaLa, error: eD } = await sb.from('automation_incidents')
    .select('id, detail, acquitted_at').eq('type', 'overbooking').is('acquitted_at', null)
  if (eD) { console.error('ECHEC lecture incidents : ' + eD.message); process.exit(1) }
  const mien = (dejaLa || []).find(r => (r.detail || {}).marqueur === MARQUEUR)
  if (mien) {
    console.log(`deja seme : incident ${mien.id} (non acquitte). Rien a faire.`)
    console.log('   pour recommencer : --nettoyer puis relancer')
    return
  }

  // Les nuits : apres-demain et le jour suivant, pour que la recette lise des
  // dates a venir — une alarme sur des nuits passees n'a pas de sens.
  const jour = (n) => {
    const [a, m, j] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' })
      .format(new Date()).split('-').map(Number)
    return new Date(Date.UTC(a, m - 1, j + n)).toISOString().slice(0, 10)
  }
  const nuits = [jour(2), jour(3)]
  const bookings = ['STG-RESA-A1', 'STG-RESA-B2']
  const detail = {
    message: `SURRESERVATION sur « ${bien.name} » : ${nuits.length} nuit(s) au-dela de 1 unite(s)`
      + ` — ${nuits.join(', ')}. Reservations en cause : ${bookings.join(', ')}.`,
    nuits, bookings, unites: 1,
    signature: `${bien.provider_property_id}|${nuits.join(',')}|${bookings.join(',')}`,
    marqueur: MARQUEUR
  }

  const maintenant = new Date().toISOString()
  const { data: cree, error } = await sb.from('automation_incidents').insert({
    type: 'overbooking',
    user_id: bien.user_id,
    // ⚠ `property_id` d'une table enfant est la CLE PROVIDER, pas l'UUID
    // (regle dure de CLAUDE.md). La banniere resout le nom par cette cle.
    property_id: String(bien.provider_property_id),
    detail,
    // `alerted` + `last_alerted_at` a MAINTENANT : si un cron tournait un jour
    // sur staging, il ne relancerait pas tout de suite.
    alerted: true,
    last_alerted_at: maintenant
  }).select('id, created_at').single()
  if (error) { console.error('ECHEC insertion : ' + error.message); process.exit(1) }

  console.log('ALARME SEMEE')
  console.log(`   incident   ${cree.id}`)
  console.log(`   bien       ${bien.name}  (cle ${bien.provider_property_id})`)
  console.log(`   nuits      ${nuits.join(', ')}`)
  console.log(`   cree le    ${cree.created_at}`)
  console.log(`\n   message affiche : ${detail.message}`)
  console.log('\n   nettoyage : node scripts/semer-alarme-surreservation-staging.js --nettoyer')
})().catch(e => { console.error('ECHEC :', e.message); process.exit(1) })
