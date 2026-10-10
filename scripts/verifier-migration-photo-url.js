#!/usr/bin/env node
// scripts/verifier-migration-photo-url.js — la migration
// migrations/2026-10-10-photo-url.sql est-elle appliquee ? Meme methode que
// verifier-migration-taxes-sejour.js : empreinte de la base en tete (5 biens =
// production, 3 = staging), colonne lue par son NOM — un `create ... if not
// exists` qui reussit en silence ne prouve rien (regle du depot).
//
//   node --env-file=<.env de la base visee> scripts/verifier-migration-photo-url.js
//
// ⚠ LECTURE SEULE.

const { createClient } = require('@supabase/supabase-js')

;(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  const { count, error } = await sb.from('properties').select('id', { count: 'exact', head: true })
  if (error || !Number.isInteger(count)) { console.error('ECHEC : empreinte illisible', error ? error.message : ''); process.exit(1) }
  console.log(`Projet ${String(process.env.SUPABASE_URL).replace(/^https?:\/\//, '').split('.')[0]} · biens = ${count} (5 = production, 3 = staging)`)
  const { error: e } = await sb.from('properties').select('photo_url').limit(0)
  if (e) { console.error(`  ✖ properties.photo_url : ${e.message}`); console.error('ECHEC : migration absente.'); process.exit(2) }
  console.log('  ✔ properties.photo_url lisible par son nom')
  // Le bucket fait partie du lot (scripts/creer-bucket-photos.js) : absent ou
  // prive, l'endpoint rend 500 ou des URL publiques qui repondent 400 — c'est
  // un ECHEC, pas une remarque (releve en review).
  const { data: b } = await sb.storage.getBucket('property-photos').catch(() => ({ data: null }))
  if (!b) { console.error('  ✖ bucket property-photos ABSENT — lancer scripts/creer-bucket-photos.js'); process.exit(2) }
  if (b.public !== true) { console.error('  ✖ bucket property-photos PRIVE — lancer scripts/creer-bucket-photos.js'); process.exit(2) }
  console.log('  ✔ bucket property-photos present et public')
  console.log('Migration 2026-10-10-photo-url : conforme sur ce que l API permet de prouver.')
  process.exit(0)
})().catch(e => { console.error(`ECHEC : ${e.message}`); process.exit(1) })
