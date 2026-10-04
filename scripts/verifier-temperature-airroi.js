#!/usr/bin/env node
// scripts/verifier-temperature-airroi.js — la migration
// 2026-10-04-marche-temperature-airroi.sql est-elle REELLEMENT appliquee sur la
// base visee ? Spec : docs/kb/chantier-nouveau-bien.md §15.
//
//   node --env-file=<.env de la base visee> scripts/verifier-temperature-airroi.js
//
// LECTURE SEULE. ⚠ EMPREINTE en tete (5 biens = production, 3 = staging).
// ⚠ Un verificateur qui n'a rien lu doit echouer : une colonne absente est un
// ECHEC, jamais « 0 ligne ».

const { createClient } = require('@supabase/supabase-js')

const URL = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY absents.'); process.exit(1) }
const sb = createClient(URL, KEY, { auth: { persistSession: false } })
const COLONNES = 'id, pays, region, localite, capture_le, jour, prix_base100, saison, semaine, fete, fete_nom, demande, ecart, niveau, methode, cree_le'

;(async () => {
  const { count: biens, error: eB } = await sb.from('properties').select('*', { count: 'exact', head: true })
  if (eB) { console.error('Empreinte illisible :', eB.message); process.exit(1) }
  const nom = biens === 5 ? 'PRODUCTION' : biens === 3 ? 'STAGING' : 'INCONNUE'
  console.log(`Base : ${String(URL).replace(/^https?:\/\//, '').split('.')[0]} — ${biens} bien(s) — ${nom}\n`)
  if (nom === 'INCONNUE') { console.error('Empreinte inconnue : arret.'); process.exit(1) }

  const { data, error } = await sb.from('marche_temperature_airroi').select(COLONNES)
    .order('capture_le', { ascending: false }).limit(1)
  if (error) { console.error(`  ECHEC marche_temperature_airroi illisible : ${error.message}`); process.exit(1) }
  console.log('  ok    les 16 colonnes sont lisibles')
  const { count, error: eC } = await sb.from('marche_temperature_airroi').select('*', { count: 'exact', head: true })
  if (eC || !Number.isInteger(count)) { console.error(`  ECHEC comptage impossible : ${eC ? eC.message : 'sans reponse'}`); process.exit(1) }
  console.log(`        ${count} jour(s) stocke(s)${data.length ? ` — derniere capture : ${data[0].localite}, du ${data[0].capture_le}` : ''}`)
  console.log('\nNon vu d ici (pg_catalog n est pas expose) : la contrainte d unicite, le controle des niveaux et la RLS.')
  console.log('\nOK')
})()
