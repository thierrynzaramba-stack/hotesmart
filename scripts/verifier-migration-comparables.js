#!/usr/bin/env node
// scripts/verifier-migration-comparables.js — les migrations 2026-10-05-bien-profil.sql
// (+ -strategie), 2026-10-05-comparables-recherches.sql (+ -cout, -nature) et
// 2026-10-05-comparables-position.sql et 2026-10-05-annonces-retirees.sql sont-elles
// REELLEMENT appliquees ?
// Spec : docs/kb/chantier-nouveau-bien.md §20 a §22.
//
//   node --env-file=<.env de la base visee> scripts/verifier-migration-comparables.js
//
// LECTURE SEULE. ⚠ EMPREINTE en tete (5 biens = production, 3 = staging).
// ⚠ Les fonctions de quota ne sont appelees qu'avec un parametre NUL : elles
// refusent avant le verrou et n'ecrivent rien. Cela prouve leur SIGNATURE
// (celle de -nature.sql) ; l'ancienne, sans p_nature, doit avoir disparu.

const { createClient } = require('@supabase/supabase-js')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents.'); process.exit(1) }
const sb = createClient(URL, KEY, { auth: { persistSession: false } })
const FORMES = {
  bien_profil: 'id, user_id, property_id, adresse, adresse_trouvee, latitude, longitude, geocode_score, voyageurs, chambres, pieces, salles_de_bain, equipements, maj_le, strategie, sejour_min',
  comparables_recherches: 'id, user_id, property_id, cree_le, cout_usd, nature',
  comparables_retenus: 'property_id, listing_id, actif, retenu_par, position',
  airroi_annonces_retirees: 'listing_id, constatee_le, http',
}

;(async () => {
  const { count: biens, error: eB } = await sb.from('properties').select('*', { count: 'exact', head: true })
  if (eB) { console.error('Empreinte illisible :', eB.message); process.exit(1) }
  const nom = biens === 5 ? 'PRODUCTION' : biens === 3 ? 'STAGING' : 'INCONNUE'
  console.log(`Base : ${biens} bien(s) — ${nom}\n`)
  if (nom === 'INCONNUE') { console.error('Empreinte inconnue : arret.'); process.exit(1) }
  let echecs = 0
  for (const [table, colonnes] of Object.entries(FORMES)) {
    const { error } = await sb.from(table).select(colonnes).limit(1)
    if (error) { echecs++; console.error(`  ECHEC ${table} : ${error.message}`); continue }
    const { count, error: eC } = await sb.from(table).select('*', { count: 'exact', head: true })
    if (eC || !Number.isInteger(count)) { echecs++; console.error(`  ECHEC ${table} : comptage impossible`); continue }
    console.log(`  ok    ${table} : ${colonnes.split(',').length} colonnes lisibles, ${count} ligne(s)`)
  }
  // Les signatures, sans ecriture (un parametre nul refuse d'entree).
  const Q = { p_bien_jour: 3, p_compte_jour: 5, p_compte_30j: 10, p_budget_mois: 5 }
  const appels = [
    ['reserver (nouvelle)', 'reserver_recherche_comparables', { p_user: null, p_property: null, p_cout: 0.10, p_nature: 'recherche', p_calendriers_90j: 30, ...Q }, 'mois'],
    ['rendre (nouvelle)', 'rendre_recherche_comparables', { p_property: null, p_cout: 0.10, p_nature: 'recherche' }, false],
  ]
  for (const [nomF, fn, params, attendu] of appels) {
    const { data, error } = await sb.rpc(fn, params)
    if (error || data !== attendu) { echecs++; console.error(`  ECHEC ${nomF} : ${error ? error.message : `rend ${JSON.stringify(data)}`}`); continue }
    console.log(`  ok    ${nomF} : signature presente, refus sans ecriture`)
  }
  const anciennes = [
    ['reserver (ancienne)', 'reserver_recherche_comparables', { p_user: null, p_property: null, p_cout: 0.10, ...Q }],
    ['rendre (ancienne)', 'rendre_recherche_comparables', { p_property: null, p_cout: 0.10 }],
  ]
  for (const [nomF, fn, params] of anciennes) {
    const { error } = await sb.rpc(fn, params)
    if (!error) { echecs++; console.error(`  ECHEC ${nomF} : encore appelable`); continue }
    console.log(`  ok    ${nomF} : disparue`)
  }
  console.log('\nNon vu d ici : les contraintes et la RLS.')
  if (echecs) { console.error(`\n${echecs} ECHEC(S)`); process.exit(1) }
  console.log('\nOK')
})()
