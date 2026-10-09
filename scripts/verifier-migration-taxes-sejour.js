#!/usr/bin/env node
// scripts/verifier-migration-taxes-sejour.js — la migration de la taxe de
// sejour (migrations/2026-10-09-taxes-sejour.sql) est-elle appliquee, et sous la
// bonne forme ? Meme methode que verifier-migration-grille-hote.js : empreinte en
// tete (5 biens = production, 3 = staging), colonnes lues par leur NOM.
//
//   node --env-file=<.env de la base visee> scripts/verifier-migration-taxes-sejour.js
//
// ⚠ LECTURE SEULE. Limite connue (dette 32) : ni policies, ni CHECK, ni UNIQUE
// prouves ici — la relecture du fichier (tests/taxe-sejour-migration.test.js)
// les couvre.

const { createClient } = require('@supabase/supabase-js')

const COLONNES = ['id', 'user_id', 'booking_id', 'property_id', 'property_uuid', 'montant_cents',
  'communale_cents', 'departementale_cents', 'regionale_cents', 'commune', 'collecteur', 'origine',
  'inclus_dans_prix', 'adultes', 'nuits', 'source', 'updated_at']

;(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { count, error } = await sb.from('properties').select('id', { count: 'exact', head: true })
  if (error || !Number.isInteger(count)) { console.error('ECHEC : empreinte illisible', error ? error.message : ''); process.exit(1) }
  console.log(`Projet ${String(process.env.SUPABASE_URL).replace(/^https?:\/\//, '').split('.')[0]} · biens = ${count} (5 = production, 3 = staging)`)
  let echecs = 0
  for (const c of COLONNES) {
    const { error: e } = await sb.from('taxes_sejour').select(c).limit(0)
    if (e) { echecs++; console.log(`  ✖ taxes_sejour.${c} : ${e.message}`) }
  }
  if (!echecs) console.log(`  ✔ taxes_sejour : ${COLONNES.length} colonnes attendues lues par leur nom`)
  const { count: n, error: eN } = await sb.from('taxes_sejour').select('id', { count: 'exact', head: true })
  if (!eN) console.log(`  lignes : ${n}`)
  if (process.env.SUPABASE_ANON_KEY) {
    const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    const { data, error: e } = await anon.from('taxes_sejour').select('id').limit(1)
    if (e && /schema cache|does not exist/i.test(e.message || '')) { echecs++; console.log('  ✖ sonde navigateur : table absente') }
    else {
      const ferme = !!e || !(data || []).length
      if (!ferme) echecs++
      console.log(`  ${ferme ? '✔' : '✖'} sonde navigateur : ${ferme ? 'aucune ligne lisible sans session' : 'DES LIGNES SONT LISIBLES SANS SESSION'}`)
    }
  } else console.log('  (sonde navigateur non faite : SUPABASE_ANON_KEY absente de ce fichier d environnement)')
  if (echecs) { console.error(`ECHEC : ${echecs} ecart(s) — migration absente ou incomplete.`); process.exit(2) }
  console.log('Migration 2026-10-09-taxes-sejour : conforme sur ce que l API permet de prouver.')
  process.exit(0)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
