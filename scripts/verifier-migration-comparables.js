#!/usr/bin/env node
// scripts/verifier-migration-comparables.js — les migrations 2026-10-05-bien-profil.sql
// et 2026-10-05-comparables-recherches.sql sont-elles REELLEMENT appliquees ?
// Spec : docs/kb/chantier-nouveau-bien.md §20.
//
//   node --env-file=<.env de la base visee> scripts/verifier-migration-comparables.js
//
// LECTURE SEULE. ⚠ EMPREINTE en tete (5 biens = production, 3 = staging).
// ⚠ La fonction de quota n'est PAS appelee : l'appeler reserverait une
// recherche (une ecriture). Elle se verifie a la recette.

const { createClient } = require('@supabase/supabase-js')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents.'); process.exit(1) }
const sb = createClient(URL, KEY, { auth: { persistSession: false } })
const FORMES = {
  bien_profil: 'id, user_id, property_id, adresse, adresse_trouvee, latitude, longitude, geocode_score, voyageurs, chambres, pieces, salles_de_bain, equipements, maj_le',
  comparables_recherches: 'id, user_id, property_id, cree_le',
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
  console.log('\nNon vu d ici : les contraintes, la RLS, et la fonction reserver_recherche_comparables (non appelee : ce serait une ecriture).')
  if (echecs) { console.error(`\n${echecs} ECHEC(S)`); process.exit(1) }
  console.log('\nOK')
})()
