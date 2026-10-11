#!/usr/bin/env node
// scripts/verifier-migration-read-at.js — la migration
// migrations/2026-10-11-conversation-read-at.sql est-elle appliquee ?
// Meme methode que verifier-migration-photo-url.js : empreinte en tete,
// colonne lue par son NOM. LECTURE SEULE.
//
//   node --env-file=<.env de la base visee> scripts/verifier-migration-read-at.js

const { createClient } = require('@supabase/supabase-js')

;(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { count, error } = await sb.from('properties').select('id', { count: 'exact', head: true })
  if (error || !Number.isInteger(count)) { console.error('ECHEC : empreinte illisible', error ? error.message : ''); process.exit(1) }
  console.log(`Projet ${String(process.env.SUPABASE_URL).replace(/^https?:\/\//, '').split('.')[0]} · biens = ${count} (5 = production, 3 = staging)`)
  const { error: e } = await sb.from('conversation_flags').select('read_at').limit(0)
  if (e) { console.error(`  ✖ conversation_flags.read_at : ${e.message}`); console.error('ECHEC : migration absente.'); process.exit(2) }
  console.log('  ✔ conversation_flags.read_at lisible par son nom')
  console.log('Migration 2026-10-11-conversation-read-at : conforme sur ce que l API permet de prouver.')
  process.exit(0)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
